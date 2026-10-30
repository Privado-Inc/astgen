import Options from "./Options"
import * as Logger from "./Logger"
import {outputPathFor} from "./FileUtils"

import {spawn} from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"

const WATCHDOG_POLL_MS = 1000
const MAX_RESTARTS = 10

export interface WorkerConfig {
    skipFiles: string[],
    progressDir: string
}

interface RunResult {
    exitCode: number | null,
    timedOutFiles: string[]
}

export function reportProgress(progressDir: string | undefined, slot: string, file: string) {
    if (!progressDir) return
    fs.writeFileSync(path.join(progressDir, slot), file)
    if (file !== "" && process.env.ASTGEN_TEST_HANG_FILE && file.endsWith(process.env.ASTGEN_TEST_HANG_FILE)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) // simulated stuck parse, test-only
    }
}

function readProgress(progressDir: string): Map<string, string> {
    const progress = new Map<string, string>()
    for (const slot of fs.readdirSync(progressDir)) {
        try {
            progress.set(slot, fs.readFileSync(path.join(progressDir, slot), "utf-8"))
        } catch {
        }
    }
    return progress
}

function removeOutputsFor(file: string, options: Options) {
    for (const suffix of [".json", ".typemap"]) {
        fs.rmSync(outputPathFor(options.src, options.output, file, suffix).outputPath, {force: true})
    }
}

function runOnce(rawArgs: string[], configFile: string, progressDir: string, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
        // A compiled binary runs its embedded entrypoint itself; `bun run` needs the script path.
        const entry = Bun.isStandaloneExecutable ? [] : [process.argv[1]]
        const child = spawn(process.execPath, [...entry, ...rawArgs, "--worker-config", configFile], {stdio: "inherit"})

        let timedOutFiles: string[] = []
        const seen = new Map<string, { file: string, since: number }>()

        const watchdog = setInterval(() => {
            const now = Date.now()
            for (const [slot, file] of readProgress(progressDir)) {
                if (seen.get(slot)?.file !== file) seen.set(slot, {file: file, since: now})
            }
            timedOutFiles = [...seen.values()].filter((e) => e.file !== "" && now - e.since > timeoutMs).map((e) => e.file)
            if (timedOutFiles.length > 0) {
                clearInterval(watchdog)
                child.kill("SIGKILL")
            }
        }, WATCHDOG_POLL_MS)

        const stopChild = () => child.kill("SIGKILL")
        process.on("SIGTERM", stopChild)
        process.on("SIGINT", stopChild)
        const cleanup = () => {
            clearInterval(watchdog)
            process.off("SIGTERM", stopChild)
            process.off("SIGINT", stopChild)
        }

        child.on("exit", (code) => {
            cleanup()
            resolve({exitCode: code, timedOutFiles: timedOutFiles})
        })
        child.on("error", (err) => {
            cleanup()
            Logger.error("astgen: failed to spawn worker:", err.message)
            resolve({exitCode: 1, timedOutFiles: []})
        })
    })
}

function writeSkippedFiles(skipFiles: string[], options: Options) {
    fs.mkdirSync(options.output, {recursive: true})
    fs.writeFileSync(path.join(options.output, "skipped_files.json"), JSON.stringify(skipFiles, null, 2))
}

/**
 * Runs the ast generation in a child process and applies the per-file
 * timeout: when a single file takes longer than the configured number of
 * seconds, the child is killed, the file is skipped, and processing resumes
 * without it, keeping the outputs of files that were already finished.
 * Returns the exit code for the overall run.
 */
export async function runWithFileTimeout(rawArgs: string[], options: Options): Promise<number> {
    const timeoutSeconds = options["file-timeout"]!
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "astgen-timeout-"))
    const progressDir = path.join(workDir, "progress")
    const configFile = path.join(workDir, "worker-config.json")
    const skipFiles: string[] = []

    try {
        for (let restarts = 0; ; restarts++) {
            const config: WorkerConfig = {skipFiles: skipFiles, progressDir: progressDir}
            fs.writeFileSync(configFile, JSON.stringify(config))
            fs.rmSync(progressDir, {recursive: true, force: true})
            fs.mkdirSync(progressDir)

            const result = await runOnce(rawArgs, configFile, progressDir, timeoutSeconds * 1000)
            if (result.timedOutFiles.length === 0) {
                if (skipFiles.length > 0 && result.exitCode === 0) writeSkippedFiles(skipFiles, options)
                return result.exitCode ?? 1
            }
            for (const file of readProgress(progressDir).values()) {
                if (file !== "") removeOutputsFor(file, options)
            }
            for (const file of result.timedOutFiles) {
                Logger.error("astgen: timeout after", timeoutSeconds, "s parsing", file, "-- skipped")
                skipFiles.push(file)
            }
            if (restarts === MAX_RESTARTS) {
                Logger.error("astgen: stopping after", MAX_RESTARTS, "restarts; output is partial")
                writeSkippedFiles(skipFiles, options)
                return 0
            }
        }
    } finally {
        fs.rmSync(workDir, {recursive: true, force: true})
    }
}
