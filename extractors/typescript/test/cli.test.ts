import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { invoke, repoRoot, SNAPSHOT, FIXTURE_SRC } from "./harness.js";
import { VERSION } from "../src/main.js";

const scratch = mkdtempSync(join(tmpdir(), "codegraph-ts-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The extractor command-line contract (schemas/README.md §8). */
describe("codegraph-typescript command line", () => {
  it("prints its version on stdout and nothing else", () => {
    const { code, stdout, stderr } = invoke(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${VERSION}\n`);
    expect(stderr).toBe("");
  });

  it("prints usage on --help", () => {
    const { code, stdout } = invoke(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--src <dir>");
    expect(stdout).toContain("--ignore-node-modules");
  });

  it("exits 2 on a bad option, naming it", () => {
    const { code, stderr, stdout } = invoke(["--bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown option: --bogus");
    expect(stdout).toBe("");
  });

  it("exits 2 when the repository flags are incomplete", () => {
    const { code, stderr } = invoke(["--src", FIXTURE_SRC, "--repo-commit", "abc1234"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--repo-remote, --repo-commit and --repo-root go together");
  });

  it("exits 1 when a source root does not exist", () => {
    const { code, stderr } = invoke(["--src", join(scratch, "nowhere"), "--out", join(scratch, "x.jsonl")]);
    expect(code).toBe(1);
    expect(stderr).toContain("not a directory");
  });

  it("writes the snapshot, keeps stdout empty, and summarises on stderr", () => {
    const out = join(scratch, "model.jsonl");
    const { code, stdout, stderr } = invoke(["--src", FIXTURE_SRC, "--out", out, "--progress", "none"]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("RESOLUTION SUMMARY");
    expect(stderr).toContain(`wrote ${out}`);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("copies the repository facts verbatim into the header", () => {
    const out = join(scratch, "repo.jsonl");
    const { code } = invoke([
      "--src", FIXTURE_SRC, "--out", out, "--progress", "none",
      "--repo-remote", "https://github.com/acme/order",
      "--repo-commit", "0123456789abcdef",
      "--repo-root", "fixtures/typescript/src",
    ]);
    expect(code).toBe(0);
    const header = JSON.parse(readFileSync(out, "utf8").split("\n")[0] as string) as { repository: unknown };
    expect(header.repository).toEqual({
      remote: "https://github.com/acme/order",
      commit: "0123456789abcdef",
      root: "fixtures/typescript/src",
    });
  });
});

/**
 * The BUILT bin — the one thing vitest's source aliasing cannot see. The
 * bundle leaves `typescript` external so the compiler finds its `lib.*.d.ts`
 * beside itself; a bundle that inlined it would bind no standard library and
 * every `Error` would land in `<unresolved>` while every test above passed.
 */
describe("the built bin (extractors/typescript/dist/cli.js)", () => {
  const bin = join(repoRoot(), "extractors/typescript/dist/cli.js");

  it.skipIf(!existsSync(bin))("reproduces the snapshot and resolves the lib", () => {
    const out = join(scratch, "built.jsonl");
    const stderr = execFileSync(process.execPath, [bin, "--src", FIXTURE_SRC, "--out", out, "--progress", "none"], {
      cwd: repoRoot(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stderr).toBe("");
    const text = readFileSync(out, "utf8");
    expect(text).toBe(readFileSync(SNAPSHOT, "utf8"));
    expect(text).toContain('"s":"<lib>"');
    expect(text).not.toContain('"s":"Error","name":"Error","isStub":true,"parent":0,"space":["type","value"],"m":');
  });
});
