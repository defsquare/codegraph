import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeModelToString, renderId, type Entity, type Model } from "@codegraph/core";

import type { SnapshotsOptions } from "../src/args.js";
import { snapshotsCommand, type Extract } from "../src/commands/snapshots.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph snapshots` — the M9b orchestration: sample revisions of a
 * SCRIPTED git repository, extract each in a throwaway `git worktree`, and
 * feed `import --at`. The extractor is the injected seam (the real one is
 * `java -jar`, exercised against gson, not here); everything else — revision
 * selection, worktree lifecycle, resumability, failure isolation — runs for
 * real against the scripted repo.
 *
 * The script (one first-parent line, dates pinned):
 *   c1 2024-01-01  src/App.java  3 lines
 *   c2 2024-01-02  src/App.java  6 lines            <- tag v1
 *   c3 2024-01-03  + src/Util.java  4 lines
 *   c4 2024-01-04  src/App.java  8 lines            <- tag v2
 *   c5 2024-01-05  - src/Util.java
 *   (c6 2024-01-06  src/App.java 10 lines — added mid-suite by the resume test)
 *
 * `--every 2` over c1..c5 selects c1, c3, c5 — the tip always included.
 */

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-snapshots-"));
const repo = join(scratch, "demo-repo");
const jar = join(scratch, "fake-extractor.jar");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(repoDir: string, args: readonly string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env,
    },
  });
}

function commit(subject: string, date: string): void {
  git(repo, ["commit", "-q", "--no-verify", "-m", subject], {
    GIT_AUTHOR_NAME: "Alice",
    GIT_AUTHOR_EMAIL: "alice@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Alice",
    GIT_COMMITTER_EMAIL: "alice@example.com",
    GIT_COMMITTER_DATE: date,
  });
}

function writeApp(lines: number): void {
  writeFileSync(join(repo, "src/App.java"), Array.from({ length: lines }, (_, i) => `// ${i}`).join("\n") + "\n");
}

beforeAll(() => {
  writeFileSync(jar, "not really a jar — the extractor is injected in these tests");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);

  writeApp(3);
  git(repo, ["add", "."]);
  commit("c1", "2024-01-01T10:00:00+00:00");

  writeApp(6);
  git(repo, ["add", "."]);
  commit("c2", "2024-01-02T10:00:00+00:00");
  git(repo, ["tag", "v1"]);

  writeFileSync(join(repo, "src/Util.java"), "// a\n// b\n// c\n// d\n");
  git(repo, ["add", "."]);
  commit("c3", "2024-01-03T10:00:00+00:00");

  writeApp(8);
  git(repo, ["add", "."]);
  commit("c4", "2024-01-04T10:00:00+00:00");
  git(repo, ["tag", "v2"]);

  git(repo, ["rm", "-q", "src/Util.java"]);
  commit("c5", "2024-01-05T10:00:00+00:00");
});

// ─────────────────────────────────────────────── the injected extractor

const moduleId = renderId({ lang: "java", module: "app", symbol: "" });
const id = (symbol: string): string => renderId({ lang: "java", module: "app", symbol });

/** Profile-clean class shape, same as the temporal suite: findings would turn every exit into 3. */
function type(symbol: string, loc: number, file: string): Entity {
  return {
    id: id(symbol),
    kind: "class",
    traits: [
      "TNamed", "TType", "TWithInheritances", "TWithImplements",
      "TWithChildren", "TChildOf", "TSourceAnchor",
    ],
    name: symbol,
    isStub: false,
    parent: moduleId,
    anchor: { file, span: [1, loc] },
  } as unknown as Entity;
}

function javaFilesUnder(dir: string, prefix = ""): { name: string; loc: number }[] {
  const found: { name: string; loc: number }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...javaFilesUnder(path, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".java")) {
      const loc = readFileSync(path, "utf8").split("\n").filter((line) => line !== "").length;
      found.push({ name: `${prefix}${entry.name}`, loc });
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The seam: models the worktree's .java files the way the real jar would. */
const fakeExtract: Extract = (srcDir, outPath) => {
  const model: Model = {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "fake", version: "0" },
    root: "demo",
    entities: [
      {
        id: moduleId,
        kind: "package",
        traits: ["TNamed", "TModule", "TWithChildren"],
        name: "app",
        definedIn: ["src/package-info.java"],
        isStub: false,
      } as unknown as Entity,
      ...javaFilesUnder(srcDir).map(({ name, loc }) =>
        type(name.slice(name.lastIndexOf("/") + 1, -".java".length), loc, name),
      ),
    ],
    edges: [],
  } as unknown as Model;
  writeFileSync(outPath, encodeModelToString(model), "utf8");
};

function invoke(argv: readonly string[]): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = run(argv, io);
  return { io, code };
}

function snapshots(
  overrides: Partial<SnapshotsOptions>,
  extract: Extract = fakeExtract,
): { io: CapturedIo; code: number } {
  const io = captureIo();
  const options: SnapshotsOptions = {
    repo,
    jar,
    every: undefined,
    tags: false,
    store: undefined,
    src: undefined,
    json: false,
    ...overrides,
  };
  const code = snapshotsCommand(options, io, extract);
  return { io, code };
}

function series(entityId: string, store: string): number[] {
  const { io, code } = invoke(["timeline", entityId, "--store", store, "--json"]);
  expect(code).toBe(EXIT.OK);
  const parsed = JSON.parse(io.stdout()) as { series?: { loc: number }[] };
  return (parsed.series ?? []).map((point) => point.loc);
}

// ──────────────────────────────────────────────────────────── the suite

const strideStore = join(scratch, "stride.db");

describe("codegraph snapshots --every", () => {
  it("imports every 2nd commit plus the tip into a temporal store", () => {
    const { io, code } = snapshots({ every: 2, store: strideStore });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain(strideStore);
    expect(io.stdout()).toContain("3 imported, 0 skipped, 0 failed");
    expect(io.stdout()).toContain("holds 3 revisions");

    // c1, c3, c5 — hand-counted LOC at each: App 3, 6, 8; Util lives only at c3.
    expect(series(id("App"), strideStore)).toEqual([3, 6, 8]);
    expect(series(id("Util"), strideStore)).toEqual([4]);
    const util = invoke(["timeline", id("Util"), "--store", strideStore]);
    expect(util.io.stdout()).toContain("gone since");
  });

  it("is resumable — a second run skips every revision the store holds", () => {
    const { io, code } = snapshots({ every: 2, store: strideStore });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("0 imported, 3 skipped, 0 failed");
    expect(io.stdout()).toContain("holds 3 revisions");
  });

  it("after a new commit, a rerun imports only the new tip", () => {
    writeApp(10);
    git(repo, ["add", "."]);
    commit("c6", "2024-01-06T10:00:00+00:00");

    const { io, code } = snapshots({ every: 2, store: strideStore });
    expect(code).toBe(EXIT.OK);
    // Stride over c1..c6 selects c1, c3, c5 (already held) and the tip c6.
    expect(io.stdout()).toContain("1 imported, 3 skipped, 0 failed");
    expect(io.stdout()).toContain("holds 4 revisions");
    expect(series(id("App"), strideStore)).toEqual([3, 6, 8, 10]);
  });

  it("leaves no worktree behind in the repository", () => {
    const listed = git(repo, ["worktree", "list", "--porcelain"]);
    expect(listed.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  });
});

describe("codegraph snapshots --tags", () => {
  it("imports the tagged commits, in tag order, honouring --src", () => {
    const store = join(scratch, "tags.db");
    const { io, code } = snapshots({ tags: true, store, src: "src" });
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("2 imported, 0 skipped, 0 failed");
    // v1 -> c2 (App 6), v2 -> c4 (App 8, Util 4).
    expect(series(id("App"), store)).toEqual([6, 8]);
    expect(series(id("Util"), store)).toEqual([4]);
    expect(io.stderr()).toContain("v1");
    expect(io.stderr()).toContain("v2");
  });
});

describe("codegraph snapshots failure isolation", () => {
  it("a revision that fails to extract is reported and the rest still import", () => {
    const store = join(scratch, "failing.db");
    const failing: Extract = (srcDir, outPath) => {
      const app = javaFilesUnder(srcDir).find((file) => file.name.endsWith("App.java"));
      if (app?.loc === 3) throw new Error("boom: this revision does not extract");
      fakeExtract(srcDir, outPath);
    };
    const { io, code } = snapshots({ every: 2, store }, failing);
    expect(code).toBe(EXIT.FINDINGS);
    // c1 fails; c3, c5 and the tip c6 import.
    expect(io.stdout()).toContain("3 imported, 0 skipped, 1 failed");
    expect(io.stdout()).toContain("holds 3 revisions");
    expect(io.stderr()).toContain("boom");
    expect(series(id("App"), store)).toEqual([6, 8, 10]);
  });
});

describe("codegraph snapshots usage errors", () => {
  it("refuses --every together with --tags, and neither", () => {
    const both = invoke(["snapshots", repo, "--jar", jar, "--every", "2", "--tags"]);
    expect(both.code).toBe(EXIT.USAGE);
    expect(both.io.stderr()).toContain("--every");
    const neither = invoke(["snapshots", repo, "--jar", jar]);
    expect(neither.code).toBe(EXIT.USAGE);
    expect(neither.io.stderr()).toContain("--tags");
  });

  it("requires --jar, and requires it to be readable", () => {
    expect(invoke(["snapshots", repo, "--every", "2"]).code).toBe(EXIT.USAGE);
    const missing = invoke(["snapshots", repo, "--every", "2", "--jar", join(scratch, "no.jar")]);
    expect(missing.code).toBe(EXIT.USAGE);
    expect(missing.io.stderr()).toContain("no.jar");
  });

  it("refuses a directory that is not a git repository", () => {
    const plain = join(scratch, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const { io, code } = invoke(["snapshots", plain, "--every", "2", "--jar", jar]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("not a git repository");
  });

  it("refuses a repository with no commits, and one with no tags", () => {
    const empty = join(scratch, "empty-repo");
    execFileSync("git", ["init", "-q", "-b", "main", empty]);
    expect(invoke(["snapshots", empty, "--every", "2", "--jar", jar]).code).toBe(EXIT.USAGE);

    const untagged = join(scratch, "untagged-repo");
    execFileSync("git", ["init", "-q", "-b", "main", untagged]);
    writeFileSync(join(untagged, "a.txt"), "x\n");
    git(untagged, ["add", "."]);
    git(untagged, ["commit", "-q", "--no-verify", "-m", "c1"], {
      GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com",
    });
    const { io, code } = invoke(["snapshots", untagged, "--tags", "--jar", jar]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("no tags");
  });
});
