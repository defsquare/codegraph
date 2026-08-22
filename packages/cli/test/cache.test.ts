import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { STORE_OPEN_OPTIONS, cacheStatus, loadSqlite, storePathFor } from "@codegraph/analyzer";

import type { AnalyzeOptions, ExportOptions } from "../src/args.js";
import { analyzeCommand } from "../src/commands/analyze.js";
import { exportCommand } from "../src/commands/export.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";

/**
 * THE AUTOMATIC CACHE, from the outside.
 *
 * The only thing that matters about it is that it changes nothing: the same
 * command, cached or not, must print the same bytes on stdout. Everything else
 * here is about the cases where it must decline to be used, because a cache
 * that answers the wrong question quickly is worse than no cache at all.
 *
 * Speed is measured elsewhere and stated in PLAN.md — it is not asserted here,
 * because a wall-clock threshold in a test suite is a flake waiting for a busy
 * CI box.
 */

const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-cli-cache-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A private copy of the fixture, so a store can be built beside it. */
function corpus(name: string): string {
  const path = join(scratch, `${name}.jsonl`);
  copyFileSync(FIXTURE, path);
  return path;
}

function analyze(models: string[], overrides: Partial<AnalyzeOptions> = {}): {
  io: CapturedIo;
  code: number;
} {
  const io = captureIo();
  const code = analyzeCommand(
    {
      models,
      report: "deps",
      level: "module",
      internalOnly: false,
      declaredOnly: false,
      noCache: false,
      json: false,
      top: undefined,
      ...overrides,
    },
    io,
  );
  return { io, code };
}

function exportGraph(models: string[], overrides: Partial<ExportOptions> = {}): CapturedIo {
  const io = captureIo();
  exportCommand(
    {
      models,
      format: "dot",
      level: "module",
      internalOnly: false,
      declaredOnly: false,
      noCache: false,
      out: undefined,
      ...overrides,
    },
    io,
  );
  return io;
}

describe("the cache changes nothing a user reads", () => {
  /**
   * THE DEFINITION OF DONE. Every report the store answers must be the bytes
   * the model would have produced — for both commands, both levels, and a view
   * SQL translates as well as the identity.
   */
  const CASES: [string, Partial<AnalyzeOptions>][] = [
    ["deps at module level", { report: "deps", level: "module" }],
    ["deps at type level", { report: "deps", level: "type" }],
    ["coupling", { report: "coupling" }],
    ["cycles at type level", { report: "cycles", level: "type" }],
    ["coupling, internal only", { report: "coupling", internalOnly: true }],
    ["deps, declared only", { report: "deps", declaredOnly: true }],
    ["coupling as json", { report: "coupling", json: true }],
  ];

  for (const [why, overrides] of CASES) {
    it(`analyze ${why} is byte-identical either way`, () => {
      const model = corpus(`analyze-${why.replaceAll(/\W+/g, "-")}`);
      const cached = analyze([model], overrides);
      const direct = analyze([model], { ...overrides, noCache: true });

      expect(cached.io.stdout(), why).toBe(direct.io.stdout());
      expect(cached.code, why).toBe(direct.code);
    });
  }

  for (const format of ["dot", "csv", "json", "plantuml"] as const) {
    it(`export --format ${format} is byte-identical either way`, () => {
      const model = corpus(`export-${format}`);
      expect(exportGraph([model], { format }).stdout()).toBe(
        exportGraph([model], { format, noCache: true }).stdout(),
      );
    });
  }

  /**
   * The fold health line names how many edges were dropped and how many
   * entities could not be placed. Those are the numbers a silently smaller
   * graph would change, so they are compared too — the cache line itself is the
   * only stderr difference allowed.
   */
  it("reports the same fold health from either path", () => {
    const model = corpus("fold-health");
    const cached = analyze([model]).io.stderr().split("\n").filter((l) => !l.startsWith("cache:"));
    const direct = analyze([model], { noCache: true })
      .io.stderr()
      .split("\n")
      .filter((l) => !l.startsWith("cache:"));
    expect(cached).toEqual(direct);
  });
});

describe("when the cache is used, and when it declines", () => {
  it("builds a store beside the model on first use, and reuses it after", () => {
    const model = corpus("first-use");
    const store = storePathFor(model);
    expect(existsSync(store)).toBe(false);

    analyze([model]);
    expect(existsSync(store), "no store was built").toBe(true);
    expect(cacheStatus(model).state).toBe("fresh");

    // The second run must not rebuild — a cache that rebuilds every time works
    // and is worthless, and only the store's own mtime shows the difference.
    const builtAt = statSync(store).mtimeMs;
    analyze([model]);
    expect(statSync(store).mtimeMs, "the store was rebuilt on a fresh cache").toBe(builtAt);
  });

  it("says on stderr which store answered", () => {
    const model = corpus("says-so");
    expect(analyze([model]).io.stderr()).toContain(`cache: ${storePathFor(model)}`);
  });

  it("declines under --no-cache, and writes no store at all", () => {
    const model = corpus("declines");
    const { io } = analyze([model], { noCache: true });
    expect(io.stderr()).toContain("disabled by --no-cache");
    expect(existsSync(storePathFor(model))).toBe(false);
  });

  /**
   * A store holds ONE model. Surrogates are file-scoped and are not identity
   * (MM-1), so there is no store that could answer for a union — and answering
   * from one of them would be answering a different question.
   */
  it("declines for a union of several models", () => {
    const a = corpus("union-a");
    const b = corpus("union-b");
    const { io } = analyze([a, b]);
    expect(io.stderr()).toContain("load as one union");
    expect(existsSync(storePathFor(a))).toBe(false);
  });

  /** A model the reader refuses is a finding, reported by the reading path. */
  it("declines for a file that is not a model, and still exits 3", () => {
    const path = join(scratch, "not-a-model.jsonl");
    writeFileSync(path, '{"t":"header"}\n', "utf8");
    const { io, code } = analyze([path]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(io.stderr()).toContain("the model could not be read");
    expect(existsSync(storePathFor(path))).toBe(false);
  });
});

describe("a store that must not be reused", () => {
  it("rebuilds when the model has changed", () => {
    const model = corpus("changed");
    analyze([model]);
    expect(cacheStatus(model).state).toBe("fresh");

    // Append a blank line: same records, different bytes and mtime.
    writeFileSync(model, `${readFileSync(model, "utf8")}\n`, "utf8");
    expect(cacheStatus(model).state).toBe("stale");

    analyze([model]);
    expect(cacheStatus(model).state, "the store was not rebuilt for a changed model").toBe("fresh");
  });

  /**
   * Same byte count, later timestamp — the case size alone would miss. Both
   * halves of the staleness test have to work, or the cheap one is doing
   * nothing.
   */
  it("rebuilds when the model is rewritten to the same size", () => {
    const model = corpus("same-size");
    analyze([model]);
    const before = statSync(model);

    const contents = readFileSync(model, "utf8");
    writeFileSync(model, contents, "utf8");
    utimesSync(model, before.atime, new Date(before.mtimeMs + 5000));
    expect(statSync(model).size).toBe(before.size);
    expect(cacheStatus(model).state).toBe("stale");
  });

  /**
   * Migration is REGENERATION: the store holds nothing the model does not
   * already say, so a version that does not match is a file to throw away, not
   * a schema to upgrade.
   */
  it("rebuilds a store built for another schema version", () => {
    const model = corpus("old-version");
    analyze([model]);

    // Reach into the store and age it. Nothing in the product does this — the
    // point is that a future version's file must not be read by this one.
    const db = loadSqlite().open(storePathFor(model), STORE_OPEN_OPTIONS);
    db.exec("UPDATE meta SET value = '999' WHERE key = 'dbVersion'");
    db.close();

    expect(cacheStatus(model).state).toBe("version");
    const { io } = analyze([model]);
    expect(io.stdout()).not.toBe("");
    expect(cacheStatus(model).state, "an old store was not regenerated").toBe("fresh");
  });

  it("rebuilds when the store is not a database at all", () => {
    const model = corpus("corrupt");
    writeFileSync(storePathFor(model), "this is not a database", "utf8");
    expect(cacheStatus(model).state).toBe("unreadable");

    const { io } = analyze([model]);
    expect(io.stdout()).not.toBe("");
    expect(cacheStatus(model).state).toBe("fresh");
  });
});
