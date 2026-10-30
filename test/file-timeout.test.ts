import * as path from "node:path"
import * as fs from "node:fs"
import {describe, expect, it} from "bun:test"

import {withTmpDir, writeFiles} from "./helpers"

const cli = path.join(import.meta.dir, "..", "src", "astgen.ts")

function makeRepo(dir: string) {
    writeFiles(dir, [
        {name: "aaa.js", code: "const a = 1; module.exports = a;"},
        {name: "hang.js", code: "const h = 2; module.exports = h;"},
        {name: "zzz.js", code: "const z = 3; module.exports = z;"},
    ])
}

function runCli(srcDir: string, extraArgs: string[], env: Record<string, string>) {
    return Bun.spawnSync([process.execPath, cli, "-i", srcDir, "-t", "js", ...extraArgs], {
        env: {...process.env, ...env},
        timeout: 60_000,
    })
}

describe("per-file timeout", () => {
    it("skips a hung file, resumes, and reports it", async () => {
        await withTmpDir(async (tmpDir) => {
            makeRepo(tmpDir)
            const result = runCli(tmpDir, ["--file-timeout", "1"], {ASTGEN_TEST_HANG_FILE: "hang.js"})

            expect(result.exitCode).toEqual(0)
            expect(fs.existsSync(path.join(tmpDir, "ast_out", "aaa.js.json"))).toBeTruthy()
            expect(fs.existsSync(path.join(tmpDir, "ast_out", "zzz.js.json"))).toBeTruthy()
            expect(fs.existsSync(path.join(tmpDir, "ast_out", "aaa.js.typemap"))).toBeTruthy()
            expect(fs.existsSync(path.join(tmpDir, "ast_out", "hang.js.json"))).toBeFalsy()

            const report = JSON.parse(fs.readFileSync(path.join(tmpDir, "ast_out", "skipped_files.json"), "utf-8"))
            expect(report).toEqual([path.join(tmpDir, "hang.js")])
            expect(result.stderr.toString()).toContain("timeout after 1 s parsing")
            expect(result.stdout.toString()).toContain(`Parsing ${path.join(tmpDir, "hang.js")} : File skipped, hit the file timeout previously`)
        })
    }, 60_000)

    it("resumes after timeouts without parsing finished files again", async () => {
        await withTmpDir(async (tmpDir) => {
            const normal = ["aaa.js", "bbb.js", "ccc.js", "ddd.js", "zzz.js"]
            writeFiles(tmpDir, [...normal, "a-hang.js", "b-hang.js"].map((name) => ({name: name, code: "const x = 1;"})))
            const result = runCli(tmpDir, ["--file-timeout", "1"], {ASTGEN_TEST_HANG_FILE: "hang.js"})
            const stdout = result.stdout.toString()

            expect(result.exitCode).toEqual(0)
            for (const f of normal) {
                expect(stdout.split(`Converted AST for ${f} `).length - 1).toEqual(1)
                expect(fs.existsSync(path.join(tmpDir, "ast_out", f + ".json"))).toBeTruthy()
            }
            const report = JSON.parse(fs.readFileSync(path.join(tmpDir, "ast_out", "skipped_files.json"), "utf-8"))
            expect(report.sort()).toEqual([path.join(tmpDir, "a-hang.js"), path.join(tmpDir, "b-hang.js")])
        })
    }, 60_000)

    it("behaves normally when no file hangs", async () => {
        await withTmpDir(async (tmpDir) => {
            makeRepo(tmpDir)
            const result = runCli(tmpDir, ["--file-timeout", "30"], {})

            expect(result.exitCode).toEqual(0)
            for (const f of ["aaa.js.json", "hang.js.json", "zzz.js.json"]) {
                expect(fs.existsSync(path.join(tmpDir, "ast_out", f))).toBeTruthy()
            }
            expect(fs.existsSync(path.join(tmpDir, "ast_out", "skipped_files.json"))).toBeFalsy()
        })
    }, 60_000)

    it("keeps the unsupervised path when the timeout is disabled", async () => {
        await withTmpDir(async (tmpDir) => {
            makeRepo(tmpDir)
            const result = runCli(tmpDir, ["--file-timeout", "0"], {})

            expect(result.exitCode).toEqual(0)
            for (const f of ["aaa.js.json", "hang.js.json", "zzz.js.json"]) {
                expect(fs.existsSync(path.join(tmpDir, "ast_out", f))).toBeTruthy()
            }
        })
    }, 60_000)
})
