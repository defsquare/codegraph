import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeCommand } from "../src/commands/analyze.js";
import { EXIT } from "../src/exit.js";
import { captureIo, type CapturedIo } from "../src/io.js";
import { run } from "../src/main.js";
import type { AnalyzeOptions } from "../src/args.js";

/**
 * The java fixture is real Spoon output, and every number asserted below was
 * read off the analyzer before it was written here (166 entities / 173 edges;
 * module fold 10 nodes / 14 edges with 5 dropped; type fold 36 / 71 with 10
 * dropped; the module IMPORT layer 10 nodes / 6 edges). Asserting "it printed
 * something" would pass against a command that folded the wrong graph.
 */
const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly lines: readonly string[];
}

function analyze(overrides: Partial<AnalyzeOptions> = {}): Invocation {
  const io = captureIo();
  const options: AnalyzeOptions = {
    models: [FIXTURE],
    report: "deps",
    level: "module",
    internalOnly: false,
    declaredOnly: false,
    json: false,
    top: undefined,
    ...overrides,
  };
  const code = analyzeCommand(options, io);
  return { code, stdout: io.stdout(), stderr: io.stderr(), lines: io.stdoutLines() };
}

function parseJsonOut(result: Invocation): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function jsonOf(overrides: Partial<AnalyzeOptions> = {}): Record<string, unknown> {
  return parseJsonOut(analyze({ ...overrides, json: true }));
}

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codegraph-analyze-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/* --------------------------------------------------------------- deps: module */

describe("analyze --report deps at module level is the import graph", () => {
  it("reports the fixture's 10 modules and its 6 aggregated import edges", () => {
    const result = analyze({ report: "deps", level: "module" });
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("nodes: 10");
    expect(result.stdout).toContain("edges: 6 aggregated dependencies");
    // Hand-checked: java.util is imported 4 times, the heaviest import edge.
    expect(result.stdout).toContain("java:java.util ");
    expect(result.stdout).toContain("weight=4  kinds=import  provenance=declared");
  });

  it("names the layer it reported, so 6 import edges is not read as 14 dependencies", () => {
    const result = analyze({ report: "deps", level: "module" });
    expect(result.stdout).toContain("layer:  import edges only, module -> module");
  });

  it("lists every module with its member count and marks the external ones", () => {
    const { lines } = analyze({ report: "deps", level: "module" });
    const nodeLines = lines.filter((line) => line.startsWith("  java:"));
    // com.acme.order holds 125 of the 166 entities; java.lang is a stub package.
    expect(nodeLines.some((line) => line.includes("java:com.acme.order ") && line.includes("members=125"))).toBe(true);
    expect(nodeLines.some((line) => line.includes("java:java.lang ") && line.includes("external (stub)"))).toBe(true);
    // Exactly 7 of the 10 modules are stubs (3 com.acme.* packages are internal).
    expect(nodeLines.filter((line) => line.includes("external (stub)")).length).toBe(7);
  });

  /**
   * CLAUDE.md: "the city renders the model, honestly" applies to text too — a
   * report that draws an inference the way it draws a fact is lying. Both
   * com.megacorp.ledger import edges are `derived`; both must be marked.
   */
  it("draws a derived dependency differently from a declared one", () => {
    const { lines } = analyze({ report: "deps", level: "module" });
    const ledger = lines.filter((line) => line.includes("-> java:com.megacorp.ledger") || line.includes("~> java:com.megacorp.ledger"));
    expect(ledger.length).toBe(2);
    for (const line of ledger) {
      expect(line).toContain("~>");
      expect(line).toContain("provenance=derived");
      expect(line).not.toContain("provenance=declared");
    }
    // The declared imports keep the plain arrow.
    expect(lines.some((line) => line.includes("-> java:java.util ") && line.includes("provenance=declared"))).toBe(true);
    expect(lines.some((line) => line.startsWith("  legend: '->' a declared fact"))).toBe(true);
  });
});

/* ----------------------------------------------------------------- deps: type */

describe("analyze --report deps at type level is the type dependency graph", () => {
  it("reports the fixture's 36 types and 71 aggregated dependencies", () => {
    const result = analyze({ report: "deps", level: "type" });
    expect(result.stdout).toContain("nodes: 36");
    expect(result.stdout).toContain("edges: 71 aggregated dependencies");
    expect(result.stdout).toContain("layer:  every edge kind folded to type level");
  });

  it("--top narrows the node list to the shown dependencies, and says how many it omitted", () => {
    const result = analyze({ report: "deps", level: "type", top: 5 });
    expect(result.stdout).toContain("edges: 5 of 71 aggregated dependencies (--top 5)");
    expect(result.stdout).toContain("… 66 lower-weight dependencies not shown.");
    // The header still reports the TRUE total — narrowing the list must not
    // change what is true about the graph, only how much of it is printed.
    expect(result.stdout).toContain("nodes: 36");

    // The heaviest type dependency on the fixture is Batch -> Batch (weight 7).
    const shown = result.lines.filter((line) => line.includes("weight="));
    expect(shown.length).toBe(5);
    expect(shown[0]).toContain("weight=7");

    // Every listed node participates in a shown dependency, and both truncations
    // are disclosed. Asking for the top 5 and being handed the whole inventory
    // buried the answer at line 289 of 301 on a real corpus.
    const listed = result.lines.filter((line) => line.includes("members="));
    const participating = new Set(shown.flatMap((line) => line.split(/\s+/).filter((t) => t.startsWith("java:"))));
    expect(listed.length).toBeLessThan(36);
    for (const line of listed) {
      const id = line.trim().split(/\s+/)[0]!;
      expect(participating).toContain(id);
    }
    expect(result.stdout).toContain(`other nodes not shown (--top)`);
    expect(result.stdout).toContain("the node list narrows to the");
  });

  it("without --top the full node inventory is still printed", () => {
    const result = analyze({ report: "deps", level: "type" });
    expect(result.lines.filter((line) => line.includes("members=")).length).toBe(36);
    expect(result.stdout).not.toContain("other nodes not shown");
  });

  it("ranks dependencies by weight, descending, deterministically", () => {
    const weights = analyze({ report: "deps", level: "type" })
      .lines.filter((line) => line.includes("weight="))
      .map((line) => Number(/weight=(\d+)/.exec(line)?.[1] ?? "0"));
    expect(weights.length).toBe(71);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });
});

/* ----------------------------------------------------------------- the views */

describe("the view is part of the result, and internal-only drops the stubs", () => {
  it("states the view and level in the report itself", () => {
    const plain = analyze({ report: "coupling", level: "module" });
    expect(plain.stdout).toContain("level:  module");
    expect(plain.stdout).toContain("view:   all (nothing filtered");

    const filtered = analyze({ report: "coupling", level: "type", internalOnly: true, declaredOnly: true });
    expect(filtered.stdout).toContain("level:  type");
    expect(filtered.stdout).toContain("view:   internalOnly+declaredOnly (internalOnly, declaredOnly)");
  });

  it("--internal-only drops the 26 stubs: 36 types become 17, 10 modules become 3", () => {
    expect(analyze({ report: "deps", level: "type", internalOnly: true }).stdout).toContain("nodes: 17");
    expect(analyze({ report: "deps", level: "module", internalOnly: true }).stdout).toContain("nodes: 3");
    const { lines } = analyze({ report: "deps", level: "type", internalOnly: true });
    expect(lines.some((line) => line.includes("external (stub)"))).toBe(false);
  });

  /**
   * Every import in the fixture crosses the corpus boundary, so the internal
   * import layer is genuinely empty. "No dependencies" is a RESULT and has to
   * read like one, not like a command that silently did nothing.
   */
  it("says so plainly when a view leaves no dependency at all", () => {
    const result = analyze({ report: "deps", level: "module", internalOnly: true });
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("none — no dependency survives internalOnly at module level.");
  });

  it("--declared-only removes the derived import edges, keeping 4 of 6", () => {
    const result = analyze({ report: "deps", level: "module", declaredOnly: true });
    expect(result.stdout).toContain("edges: 4 aggregated dependencies");
    expect(result.stdout).not.toContain("provenance=derived");
    // The legend still explains '~>'; no dependency LINE may use it.
    const drawn = result.lines.filter((line) => line.includes("weight="));
    expect(drawn.length).toBe(4);
    expect(drawn.every((line) => line.includes(" -> "))).toBe(true);
  });
});

/* ------------------------------------------------------------------ coupling */

describe("analyze --report coupling", () => {
  it("prints one row per folded node with fan-in, fan-out, Ca, Ce and I", () => {
    const result = analyze({ report: "coupling", level: "module" });
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("coupling: 10 nodes");
    expect(result.stdout).toContain("NODE");
    for (const column of ["FAN-IN", "FAN-OUT", "CA", "CE", "I"]) {
      expect(result.stdout).toContain(column);
    }
    // Hand-checked on the 14-edge module fold: com.acme.order depends on 8
    // distinct modules and nothing depends on it, so Ca=0, Ce=8, I=1.
    const row = result.lines.find((line) => line.startsWith("  java:com.acme.order "));
    expect(row).toBeDefined();
    expect(row).toMatch(/\s0\s+8\s+0\s+8\s+1\.000$/);
  });

  it("measures the whole fold at module level, not just the import layer", () => {
    // 14 module-fold edges, not the 6 import edges: java.lang is depended on by
    // 3 modules through references and calls, none of them an import.
    const row = analyze({ report: "coupling", level: "module" }).lines.find((line) =>
      line.startsWith("  java:java.lang (external)"),
    );
    expect(row).toMatch(/\s3\s+0\s+3\s+0\s+0\.000$/);
    expect(analyze({ report: "coupling", level: "module" }).stdout).toContain(
      "layer:  every edge kind folded to module level",
    );
  });

  it("puts the most-coupled node first and keeps a stable order", () => {
    const rows = analyze({ report: "coupling", level: "type" }).lines.filter((line) =>
      /^ {2}java:/.test(line),
    );
    expect(rows.length).toBe(36);
    // Notifications (Ca 0 + Ce 10) outranks Money (7 + 2) and Reporting (0 + 8).
    expect(rows[0]).toContain("java:com.acme.order/Notifications");
    expect(rows[1]).toContain("java:com.acme.order/Money");
    expect(rows[2]).toContain("java:com.acme.order/Reporting");
    expect(analyze({ report: "coupling", level: "type" }).stdout).toBe(
      analyze({ report: "coupling", level: "type" }).stdout,
    );
  });

  /** A silently truncated table reads as a complete one. */
  it("--top says how many rows it kept and how many it hid", () => {
    const result = analyze({ report: "coupling", level: "type", top: 5 });
    const rows = result.lines.filter((line) => /^ {2}java:/.test(line));
    expect(rows.length).toBe(5);
    expect(result.stdout).toContain("coupling: 5 of 36 nodes (--top 5), ranked by total coupling Ca+Ce descending");
    expect(result.stdout).toContain("… 31 less-coupled nodes not shown (--top 5).");
  });

  it("marks external nodes, because a stub inflates Ce for a real reason", () => {
    const result = analyze({ report: "coupling", level: "type" });
    expect(result.stdout).toContain("java:java.lang/Override (external)");
  });
});

/* -------------------------------------------------------------------- cycles */

describe("analyze --report cycles", () => {
  it("finds the fixture's two type-level cycles with members and edges", () => {
    const result = analyze({ report: "cycles", level: "type" });
    expect(result.stdout).toContain("cycles: 2 strongly connected components");
    expect(result.stdout).toContain("cycle 1 — 2 nodes, 3 edges, weight 8");
    expect(result.stdout).toContain("java:com.acme.order/Money");
    expect(result.stdout).toContain("java:com.acme.order/Priceable");
    expect(result.stdout).toContain("cycle 2 — 2 nodes, 4 edges, weight 7");
    expect(result.stdout).toContain("java:com.acme.order/Basket.Cursor");
    // The edge to attack is named with its cost and its provenance.
    expect(result.stdout).toContain(
      "java:com.acme.order/Money     -> java:com.acme.order/Priceable  weight=1  kinds=interfaceImplementation  provenance=declared",
    );
  });

  /** A cycle is a finding of the MODEL (3), never a crash of the tool (1). */
  it("exits 3 when cycles exist and says why on stderr", () => {
    const result = analyze({ report: "cycles", level: "type" });
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.code).not.toBe(EXIT.INTERNAL);
    expect(result.stderr).toContain("2 dependency cycle(s) at type level under view all — exiting 3 (findings).");
  });

  it("reports 'no cycles' as a result, not an empty screen, and exits 0", () => {
    const result = analyze({ report: "cycles", level: "module" });
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("cycles: 0 strongly connected components");
    expect(result.stdout).toContain("no dependency cycle at module level under view all.");
  });

  /** Folding self-loops are cohesion, not architecture cycles: kept apart. */
  it("reports folding self-dependencies separately from cycles", () => {
    const module = analyze({ report: "cycles", level: "module" });
    expect(module.stdout).toContain("self-dependencies after folding: 3");
    expect(module.stdout).toContain("java:com.acme.order.legacy");

    const type = analyze({ report: "cycles", level: "type" });
    expect(type.stdout).toContain("self-dependencies after folding: 11");
  });

  it("--top limits the components shown and says how many were hidden", () => {
    const result = analyze({ report: "cycles", level: "type", top: 1 });
    expect(result.stdout).toContain("cycles: 1 of 2 strongly connected components (--top 1)");
    expect(result.stdout).toContain("… 1 smaller cycles not shown (--top 1).");
    expect(result.stdout).toContain("cycle 1 —");
    expect(result.stdout).not.toContain("cycle 2 —");
    // The TOTAL is still stated, so a limited report cannot read as complete.
    expect(result.stdout).toContain("self-dependencies after folding: 11");
  });

  it("keeps the two cycles under --internal-only: they are corpus-internal", () => {
    const result = analyze({ report: "cycles", level: "type", internalOnly: true });
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stdout).toContain("cycles: 2 strongly connected components");
    expect(result.stdout).toContain("view:   internalOnly (internalOnly)");
  });
});

/* ---------------------------------------------------------------------- json */

describe("--json carries the same information as the text form (decision 8)", () => {
  it("puts one machine-readable object on stdout and nothing else", () => {
    const result = analyze({ report: "deps", level: "module", json: true });
    expect(result.code).toBe(EXIT.OK);
    const payload = parseJsonOut(result);
    expect(payload["kind"]).toBe("codegraph.analyze/1");
    // Analysis output, not a model: it must not claim the interchange version.
    expect(payload["schemaVersion"]).toBeUndefined();
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  it("states the same level, view and layer the text header states", () => {
    const payload = jsonOf({ report: "coupling", level: "type", internalOnly: true, declaredOnly: true });
    expect(payload["level"]).toBe("type");
    expect(payload["view"]).toEqual({ name: "internalOnly+declaredOnly", filters: ["internalOnly", "declaredOnly"] });
    expect(payload["layer"]).toBe("every edge kind folded to type level");
    expect(payload["models"]).toEqual([FIXTURE]);
  });

  it("deps: the same counts, the same limiting, the same provenances", () => {
    const full = jsonOf({ report: "deps", level: "type" });
    expect(full["nodeCount"]).toBe(36);
    expect(full["edgeCount"]).toBe(71);
    expect((full["nodes"] as unknown[]).length).toBe(36);
    expect((full["edges"] as unknown[]).length).toBe(71);

    const limited = jsonOf({ report: "deps", level: "type", top: 5 });
    expect(limited["edgeCount"]).toBe(71);
    expect((limited["edges"] as unknown[]).length).toBe(5);
    expect(limited["ranking"]).toEqual({
      by: "weight descending (base edges aggregated), ties by (from, to)",
      top: 5,
      shown: 5,
      total: 71,
    });
  });

  it("deps at module level carries the import diagnostics", () => {
    const payload = jsonOf({ report: "deps", level: "module" });
    expect(payload["importDiagnostics"]).toEqual({ importEdges: 10, nonModuleEndpoints: [] });
    const derived = (payload["edges"] as { to: string; provenances: string[] }[]).filter(
      (edge) => edge.to === "java:com.megacorp.ledger",
    );
    expect(derived.length).toBe(2);
    expect(derived.every((edge) => edge.provenances.includes("derived"))).toBe(true);
  });

  it("coupling: the same rows in the same order as the table", () => {
    const payload = jsonOf({ report: "coupling", level: "type", top: 3 });
    const rows = payload["rows"] as { id: string; ca: number; ce: number }[];
    expect(rows.map((row) => row.id)).toEqual([
      "java:com.acme.order/Notifications",
      "java:com.acme.order/Money",
      "java:com.acme.order/Reporting",
    ]);
    expect(rows[0]).toMatchObject({ ca: 0, ce: 10, fanIn: 0, fanOut: 10 });
    expect(payload["ranking"]).toMatchObject({ shown: 3, total: 36 });
  });

  it("cycles: the same components, and the count of what was hidden", () => {
    const payload = jsonOf({ report: "cycles", level: "type" });
    expect(payload["componentCount"]).toBe(2);
    expect(payload["selfLoopCount"]).toBe(11);
    const components = payload["components"] as { members: string[]; weight: number }[];
    expect(components.length).toBe(2);
    expect(components[0]?.members).toEqual(["java:com.acme.order/Money", "java:com.acme.order/Priceable"]);
    expect(components[0]?.weight).toBe(8);
  });

  it("reports the fold diagnostics the stderr note states", () => {
    const payload = jsonOf({ report: "coupling", level: "type" });
    expect(payload["foldDiagnostics"]).toMatchObject({ droppedEdges: 10, foldedEdges: 163 });
    expect(jsonOf({ report: "coupling", level: "module" })["foldDiagnostics"]).toMatchObject({
      droppedEdges: 5,
      foldedEdges: 168,
    });
  });

  it("--json does not change what is true, only how it is printed", () => {
    const text = analyze({ report: "cycles", level: "type" });
    const json = analyze({ report: "cycles", level: "type", json: true });
    expect(json.code).toBe(text.code);
    expect(json.code).toBe(EXIT.FINDINGS);
    const payload = parseJsonOut(json);
    expect(text.stdout).toContain(`cycles: ${String(payload["componentCount"])} strongly connected components`);
    expect(text.stdout).toContain(`self-dependencies after folding: ${String(payload["selfLoopCount"])}`);
  });
});

/* ------------------------------------------------------- streams and exits */

describe("stream discipline and exit codes (decisions 2 and 3)", () => {
  it("keeps the fold diagnostics on stderr, never in the artifact", () => {
    const result = analyze({ report: "deps", level: "type" });
    expect(result.stderr).toContain("10 dropped (an endpoint has no type container in this view)");
    expect(result.stderr).toContain("163 base edges aggregated into 71");
    expect(result.stdout).not.toContain("dropped (");
  });

  it("reports the module fold's 5 dropped edges — a smaller graph is never silent", () => {
    expect(analyze({ report: "coupling", level: "module" }).stderr).toContain(
      "fold(module): 168 base edges aggregated into 14; 5 dropped",
    );
  });

  it("reports the import layer's base edge count", () => {
    expect(analyze({ report: "deps", level: "module" }).stderr).toContain(
      "import layer: 10 base import edges kept by this view.",
    );
  });

  it("still analyzes a model with findings, warns on stderr, and exits 3", () => {
    const broken = tempFile("broken.json", "{ not json");
    const result = analyze({ models: [broken, FIXTURE], report: "deps", level: "module" });
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stderr).toContain("the models loaded with findings");
    expect(result.stderr).toContain("Run `codegraph validate`");
    // It did NOT refuse to work: the good file was still analyzed.
    expect(result.stdout).toContain("nodes: 10");
  });

  it("loads several paths as ONE union (decision 5)", () => {
    const result = analyze({ models: [FIXTURE, FIXTURE], report: "deps", level: "module" });
    // Ids are globally unique, so the same model twice re-declares every id
    // without conflicting — benign per `isClean`, and it still folds to the
    // same 10 modules rather than to 20.
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain(`models: ${FIXTURE}, ${FIXTURE}`);
    expect(result.stdout).toContain("nodes: 10");
  });

  it("produces byte-identical stdout for identical inputs (decision 6)", () => {
    for (const report of ["deps", "coupling", "cycles"] as const) {
      const first = analyze({ report, level: "type", top: 7 });
      const second = analyze({ report, level: "type", top: 7 });
      expect(second.stdout).toBe(first.stdout);
      expect(second.stderr).toBe(first.stderr);
    }
  });

  it("never emits an ANSI escape (decision 4)", () => {
    // Built from a char code on purpose: a literal ESC byte in this source
    // would itself fail `package-surface`'s reviewable-text check.
    const ansi = new RegExp(String.fromCharCode(27));
    for (const report of ["deps", "coupling", "cycles"] as const) {
      const result = analyze({ report, level: "type" });
      expect(ansi.test(result.stdout)).toBe(false);
      expect(ansi.test(result.stderr)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------ through `run` */

describe("codegraph analyze end to end", () => {
  function invoke(argv: readonly string[]): { code: number; io: CapturedIo } {
    const io = captureIo();
    return { code: run(argv, io), io };
  }

  it("runs from argv with the documented defaults (level module, no view filter)", () => {
    const { code, io } = invoke(["analyze", FIXTURE, "--report", "deps"]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain("level:  module");
    expect(io.stdout()).toContain("nodes: 10");
  });

  it("accepts every flag combination the help promises", () => {
    const { code, io } = invoke([
      "analyze",
      FIXTURE,
      "--report",
      "coupling",
      "--level",
      "type",
      "--internal-only",
      "--declared-only",
      "--top",
      "4",
      "--json",
    ]);
    expect(code).toBe(EXIT.OK);
    const payload = JSON.parse(io.stdout()) as Record<string, unknown>;
    expect(payload["report"]).toBe("coupling");
    expect(payload["ranking"]).toMatchObject({ shown: 4, total: 17 });
  });

  it("turns an unreadable model path into a usage error, not a finding", () => {
    const { code, io } = invoke(["analyze", join(tmpdir(), "codegraph-nope-4321.json"), "--report", "deps"]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("codegraph: cannot read");
  });

  it("exits 3 — not 1 — on a model whose types cycle", () => {
    const { code } = invoke(["analyze", FIXTURE, "--report", "cycles", "--level", "type"]);
    expect(code).toBe(EXIT.FINDINGS);
  });
});
