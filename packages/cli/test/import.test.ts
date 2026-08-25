import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";
import { hydrateModel, openStore } from "@codegraph/analyzer";

import type { ImportOptions } from "../src/args.js";
import { importCommand } from "../src/commands/import.js";
import { EXIT, isUsageError } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";

/**
 * `codegraph import` — the first command whose ARTIFACT is a file rather than
 * a report, which is what most of these assertions are about.
 *
 * Two rules do the work:
 *
 *  - **stdout says what is true of the STORE; stderr says what was true of the
 *    RUN.** SQLite promises no byte-determinism (page allocation varies) and a
 *    duration never could, so the size and the timing must not reach the stream
 *    every other command is compared byte for byte on.
 *  - **A file that is not a model is a FINDING, not a crash.** The record
 *    reader refusing it says something about the model, so it exits 3 with the
 *    reader's own message — not exit 1, "a bug in codegraph".
 */

const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-import-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function options(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return { models: [FIXTURE], out: undefined, at: undefined, time: undefined, json: false, ...overrides };
}

function importTo(overrides: Partial<ImportOptions> = {}): { io: CapturedIo; code: number } {
  const io = captureIo();
  const code = importCommand(options(overrides), io);
  return { io, code };
}

/** A copy of the fixture in the scratch directory, optionally edited. */
function fixtureCopy(name: string, edit?: (lines: Record<string, unknown>[]) => void): string {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  edit?.(lines);
  const path = join(scratch, `${name}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

describe("the store it writes", () => {
  it("lands beside the model, named after it", () => {
    const model = fixtureCopy("beside");
    const { code, io } = importTo({ models: [model] });
    expect(code).toBe(EXIT.OK);

    const expected = join(dirname(model), `${basename(model, ".jsonl")}.db`);
    expect(existsSync(expected), "no store beside the model").toBe(true);
    expect(io.stdout()).toContain(expected);
  });

  it("goes where --out says instead", () => {
    const target = join(scratch, "elsewhere.db");
    const { code } = importTo({ out: target });
    expect(code).toBe(EXIT.OK);
    expect(existsSync(target)).toBe(true);
  });

  /**
   * The point of the command, and the only assertion that would catch a store
   * that was written but wrong: what comes back out of it is the model.
   */
  it("holds the model the file holds", () => {
    const target = join(scratch, "faithful.db");
    importTo({ out: target });
    const db = openStore(target);
    try {
      expect(hydrateModel(db)).toEqual(readModelFileSync(FIXTURE));
    } finally {
      db.close();
    }
  });

  it("reports the counts the store actually contains", () => {
    const model = readModelFileSync(FIXTURE);
    const { io } = importTo({ out: join(scratch, "counted.db"), json: true });
    const report = JSON.parse(io.stdout()) as {
      ok: boolean;
      stores: { counts: { entities: number; edges: number }; lang: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.stores[0]?.counts.entities).toBe(model.entities.length);
    expect(report.stores[0]?.counts.edges).toBe(model.edges.length);
    expect(report.stores[0]?.lang).toBe(model.lang);
  });

  it("imports each model to its own store, never a union", () => {
    const a = fixtureCopy("union-a");
    const b = fixtureCopy("union-b");
    const { code, io } = importTo({ models: [a, b], json: true });
    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(io.stdout()) as { stores: { store: string }[] };
    expect(report.stores).toHaveLength(2);
    expect(new Set(report.stores.map((one) => one.store)).size).toBe(2);
  });
});

/**
 * A store's bytes are not reproducible and a duration certainly is not, so
 * neither may appear on stdout — `e2e-determinism` compares that stream across
 * runs. Both belong on stderr, where a note about the run belongs anyway.
 */
describe("the streams stay separable", () => {
  it("keeps timing and file size off stdout", () => {
    const { io } = importTo({ out: join(scratch, "streams.db") });
    expect(io.stdout()).not.toMatch(/\bs\b.*MB|MB.*\bs\b/);
    expect(io.stdout()).not.toContain("MB");
    expect(io.stderr()).toContain("MB");
    expect(io.stderr()).toMatch(/\d+\.\d\d s/);
  });

  it("produces identical stdout on two runs of the same model", () => {
    const first = importTo({ out: join(scratch, "twice.db") });
    const second = importTo({ out: join(scratch, "twice.db") });
    expect(second.io.stdout()).toBe(first.io.stdout());
  });

  it("puts a valid JSON document on stdout under --json", () => {
    const { io } = importTo({ out: join(scratch, "json.db"), json: true });
    expect(() => JSON.parse(io.stdout())).not.toThrow();
  });
});

describe("what it does with a model it cannot use", () => {
  /**
   * The distinction the CLI's contract turns on (M4 decision 2): an unreadable
   * PATH is a usage error, a readable file that is not a model is a finding.
   * Before this was handled the reader's `JsonlError` escaped to `main` and was
   * reported as "an internal error — a bug in codegraph", which blamed the tool
   * for the user's file.
   */
  it("calls a file that is not a model a finding, not a crash", () => {
    const path = join(scratch, "not-a-model.jsonl");
    writeFileSync(path, '{"t":"header"}\n', "utf8");

    const { code, io } = importTo({ models: [path] });
    expect(code, "a malformed model must not be exit 1").toBe(EXIT.FINDINGS);
    expect(io.stdout()).toContain("not a model");
    // The reader's own words, so the user can fix the line it names.
    expect(io.stdout()).toContain("line 1");
    expect(existsSync(join(scratch, "not-a-model.db"))).toBe(false);
  });

  it("reports every bad path in one run, and still imports the good ones", () => {
    const good = fixtureCopy("mixed-good");
    const bad = join(scratch, "mixed-bad.jsonl");
    writeFileSync(bad, "{ nope\n", "utf8");

    const { code, io } = importTo({ models: [bad, good] });
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stdout()).toContain(good);
    expect(io.stdout()).toContain(bad);
    expect(existsSync(join(scratch, "mixed-good.db"))).toBe(true);
  });

  it("treats an unreadable path as a usage error", () => {
    let thrown: unknown;
    try {
      importTo({ models: [join(scratch, "absent.jsonl")] });
    } catch (error) {
      thrown = error;
    }
    expect(isUsageError(thrown)).toBe(true);
  });

  /**
   * A model that reads fine but breaks its profile: the store IS written and
   * usable — refusing to cache a model `validate` exists to describe would be
   * the second gate this project keeps declining to add — and the exit code
   * still says something is wrong.
   */
  it("still writes the store for a model with findings, and exits 3", () => {
    const path = fixtureCopy("with-findings", (lines) => {
      const at = lines.findIndex((line) => line["t"] === "e");
      lines[at + 1]!["tr"] = [(lines[at + 1]!["tr"] as number[])[0]];
    });
    const target = join(scratch, "with-findings.db");

    const { code, io } = importTo({ models: [path], out: target });
    expect(code).toBe(EXIT.FINDINGS);
    expect(existsSync(target), "the store was refused over a conformance finding").toBe(true);
    expect(io.stderr()).toContain("warning:");
    expect(io.stdout()).toContain("codegraph validate");
  });
});

describe("the invocation itself", () => {
  it("refuses --out with more than one model", () => {
    const io = captureIo();
    const code = run(["import", "a.jsonl", "b.jsonl", "--out", "x.db"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("--out takes one model");
  });

  it("is listed as a command, with help of its own", () => {
    const io = captureIo();
    expect(run(["import", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout()).toContain("codegraph import");
    expect(io.stdout()).toContain("--out FILE");
    expect(io.stderr()).toBe("");

    const top = captureIo();
    run(["--help"], top);
    expect(top.stdout()).toContain("import");
  });
});
