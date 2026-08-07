import Options from "./Options"

import {spawn} from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"

const WATCHDOG_POLL_MS = 1000;

export interface WorkerConfig {
    skipFiles: string[],
    progressFile: string
}

interface RunResult {
    exitCode: number | null,
    timedOutFile: string
}

function readProgress(progressFile: string): string {
    try {
        return fs.readFileSync(progressFile, "utf-8").trim();
    } catch {
        return "";
    }
}

function removeOutputsFor(file: string, options: Options) {
    const base = path.join(options.output, path.relative(options.src, file));
    fs.rmSync(base + ".json", {force: true});
    fs.rmSync(base + ".typemap", {force: true});
}

function runOnce(rawArgs: string[], configFile: string, progressFile: string, timeoutMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
        // process.argv[1] is the entry script both outside pkg (dist/astgen.js)
        // and inside a pkg binary (the snapshotted entrypoint).
        const args = [process.argv[1], ...rawArgs, "--worker-config", configFile];
        const child = spawn(process.execPath, args, {stdio: "inherit"});

        let timedOutFile = "";
        let lastFile = "";
        let lastChangeAt = Date.now();

        const watchdog = setInterval(() => {
            const current = readProgress(progressFile);
            if (current !== lastFile) {
                lastFile = current;
                lastChangeAt = Date.now();
            } else if (lastFile !== "" && Date.now() - lastChangeAt > timeoutMs) {
                timedOutFile = lastFile;
                child.kill("SIGKILL");
            }
        }, WATCHDOG_POLL_MS);

        child.on("exit", (code) => {
            clearInterval(watchdog);
            resolve({exitCode: code, timedOutFile: timedOutFile});
        });
        child.on("error", (err) => {
            clearInterval(watchdog);
            console.error("astgen: failed to spawn worker:", err.message);
            resolve({exitCode: 1, timedOutFile: ""});
        });
    });
}

/**
 * Runs the ast generation in a child process and applies the per-file
 * timeout: when a single file takes longer than the configured number of
 * seconds, the child is killed, the file is skipped, and processing restarts
 * without it. Returns the exit code for the overall run.
 */
export async function runWithFileTimeout(rawArgs: string[], options: Options): Promise<number> {
    const timeoutSeconds = options["file-timeout"]!;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "astgen-timeout-"));
    const progressFile = path.join(workDir, "progress");
    const configFile = path.join(workDir, "worker-config.json");
    const skipFiles: string[] = [];

    try {
        for (;;) {
            const config: WorkerConfig = {skipFiles: skipFiles, progressFile: progressFile};
            fs.writeFileSync(configFile, JSON.stringify(config));
            fs.rmSync(progressFile, {force: true});

            const result = await runOnce(rawArgs, configFile, progressFile, timeoutSeconds * 1000);
            if (result.timedOutFile === "") {
                if (skipFiles.length > 0 && result.exitCode === 0) {
                    fs.mkdirSync(options.output, {recursive: true});
                    fs.writeFileSync(path.join(options.output, "skipped_files.json"),
                        JSON.stringify(skipFiles, null, 2));
                }
                return result.exitCode ?? 1;
            }
            console.error("astgen: timeout after", timeoutSeconds, "s parsing", result.timedOutFile, "-- skipped");
            skipFiles.push(result.timedOutFile);
            removeOutputsFor(result.timedOutFile, options);
        }
    } finally {
        fs.rmSync(workDir, {recursive: true, force: true});
    }
}
