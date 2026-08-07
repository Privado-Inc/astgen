import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import {execSync, spawnSync} from "node:child_process"

const repoRoot = path.join(__dirname, "..");
const cli = path.join(repoRoot, "dist", "astgen.js");

function makeRepo(): string {
    const tmpDir: string = fs.mkdtempSync(path.join(os.tmpdir(), "astgen-supervisor-tests"));
    fs.writeFileSync(path.join(tmpDir, "aaa.js"), "const a = 1; module.exports = a;");
    fs.writeFileSync(path.join(tmpDir, "hang.js"), "const h = 2; module.exports = h;");
    fs.writeFileSync(path.join(tmpDir, "zzz.js"), "const z = 3; module.exports = z;");
    return tmpDir;
}

function runCli(srcDir: string, extraArgs: string[], env: NodeJS.ProcessEnv) {
    return spawnSync("node", [cli, "-i", srcDir, "-t", "js", "--tsTypes", "false", ...extraArgs], {
        env: {...process.env, ...env},
        encoding: "utf-8",
        timeout: 60_000
    });
}

describe("per-file timeout", () => {
    beforeAll(() => {
        execSync("yarn build", {cwd: repoRoot, stdio: "ignore"});
    }, 120_000);

    it("skips a hung file, resumes, and reports it", () => {
        const tmpDir = makeRepo();
        const result = runCli(tmpDir, ["--file-timeout", "1"], {ASTGEN_TEST_HANG_FILE: "hang.js"});

        expect(result.status).toEqual(0);
        expect(fs.existsSync(path.join(tmpDir, "ast_out", "aaa.js.json"))).toBeTruthy();
        expect(fs.existsSync(path.join(tmpDir, "ast_out", "zzz.js.json"))).toBeTruthy();
        expect(fs.existsSync(path.join(tmpDir, "ast_out", "hang.js.json"))).toBeFalsy();

        const report = JSON.parse(fs.readFileSync(path.join(tmpDir, "ast_out", "skipped_files.json"), "utf-8"));
        expect(report).toEqual([path.join(tmpDir, "hang.js")]);
        expect(result.stderr).toContain("timeout after 1 s parsing");

        fs.rmSync(tmpDir, {recursive: true});
    }, 60_000);

    it("behaves normally when no file hangs", () => {
        const tmpDir = makeRepo();
        const result = runCli(tmpDir, ["--file-timeout", "30"], {});

        expect(result.status).toEqual(0);
        for (const f of ["aaa.js.json", "hang.js.json", "zzz.js.json"]) {
            expect(fs.existsSync(path.join(tmpDir, "ast_out", f))).toBeTruthy();
        }
        expect(fs.existsSync(path.join(tmpDir, "ast_out", "skipped_files.json"))).toBeFalsy();

        fs.rmSync(tmpDir, {recursive: true});
    }, 60_000);

    it("keeps the unsupervised path when the timeout is disabled", () => {
        const tmpDir = makeRepo();
        const result = runCli(tmpDir, ["--file-timeout", "0"], {});

        expect(result.status).toEqual(0);
        for (const f of ["aaa.js.json", "hang.js.json", "zzz.js.json"]) {
            expect(fs.existsSync(path.join(tmpDir, "ast_out", f))).toBeTruthy();
        }

        fs.rmSync(tmpDir, {recursive: true});
    }, 60_000);
});
