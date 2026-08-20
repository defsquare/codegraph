import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { couplingToCsv, foldedGraphToCsv } from "../src/exports/csv.js";
import { toDot } from "../src/exports/dot.js";
import { foldedGraphToJson, toJsonString } from "../src/exports/json.js";
import { foldGraph } from "../src/fold.js";
import { buildGraph } from "../src/graph.js";
import { isClean, loadModels } from "../src/load.js";
import { coupling } from "../src/metrics/coupling.js";
import { cycles } from "../src/metrics/cycles.js";
import { importGraph, typeDependencyGraph } from "../src/queries.js";
import { composeViews, declaredOnly, internalOnly } from "../src/views.js";

/**
 * SCALE BUDGET — opt-in, never part of a normal run.
 *
 * The committed fixture is 166 entities: it proves correctness and nothing
 * about cost. The failures this guards are the ones that only appear on a real
 * corpus — an unmemoized container walk going quadratic, a recursive Tarjan
 * blowing the stack at 15 000 nodes. Both look like a mysterious crash rather
 * than a bug in the function that caused them.
 *
 * No corpus is cloned and no large model is committed. Point the suite at one
 * you already have:
 *
 *   CODEGRAPH_LARGE_MODEL=/path/to/model.json pnpm --filter @codegraph/analyzer test
 *
 * Generate one with the M2 extractor over any cloned repository — see
 * `extractors/java/README.md`. apache/commons-lang yields ~15 300 entities and
 * ~24 600 edges (17 MB); google/gson yields 3 624 entities and 8 834 edges.
 */

const ENV_PATH = process.env["CODEGRAPH_LARGE_MODEL"];
/** A conventional local drop point, gitignored; checked so the env var is optional. */
const FALLBACK = fileURLToPath(new URL("../../../fixtures/large/model.json", import.meta.url));

function largeModelPath(): string | undefined {
  if (ENV_PATH !== undefined && ENV_PATH.length > 0) {
    if (!existsSync(ENV_PATH)) {
      throw new Error(`CODEGRAPH_LARGE_MODEL points at a missing file: ${ENV_PATH}`);
    }
    return ENV_PATH;
  }
  return existsSync(FALLBACK) ? FALLBACK : undefined;
}

const MODEL_PATH = largeModelPath();

/** Whole pipeline must finish well inside this; commons-lang runs in ~2 s. */
const TOTAL_BUDGET_MS = 60_000;
/** Folding is memoized (O(V) per level); a quadratic walk misses this by orders. */
const FOLD_BUDGET_MS = 10_000;

describe("scale", () => {
  if (MODEL_PATH === undefined) {
    it.skip(
      "SKIPPED: no large model available — set CODEGRAPH_LARGE_MODEL=<path to a model.json> " +
        "or drop one at fixtures/large/model.json (nothing is cloned or committed)",
      () => undefined,
    );
    return;
  }

  const path = MODEL_PATH;

  it(
    "runs the whole pipeline on a real corpus inside its time budget",
    { timeout: TOTAL_BUDGET_MS * 2 },
    () => {
      const started = Date.now();
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));

      const loadStart = Date.now();
      const { union, diagnostics } = loadModels(raw, { sources: [path] });
      const loadMs = Date.now() - loadStart;

      const graph = buildGraph(union);
      expect(graph.ids().length).toBeGreaterThan(1000);

      // Diagnostics are reported, not asserted clean: a real corpus may carry
      // extraction gaps, and the point here is cost, not extractor quality.
      const foldStart = Date.now();
      const types = typeDependencyGraph(graph, composeViews(internalOnly, declaredOnly));
      const modules = importGraph(graph, internalOnly);
      const all = foldGraph(graph, { level: "type" });
      const foldMs = Date.now() - foldStart;

      const metricStart = Date.now();
      const table = coupling(types);
      // The stack-depth trap: Tarjan over every type in the corpus.
      const report = cycles(types);
      const metricMs = Date.now() - metricStart;

      const exportStart = Date.now();
      const dot = toDot(types);
      const csv = foldedGraphToCsv(types);
      const couplingCsv = couplingToCsv(table);
      const json = toJsonString(foldedGraphToJson(types));
      const exportMs = Date.now() - exportStart;

      const totalMs = Date.now() - started;

      // Correctness still holds at scale — a fast wrong answer is not a pass.
      expect(table.rows).toHaveLength(types.nodes.length);
      expect(all.diagnostics.foldedEdges + all.diagnostics.droppedEdges).toBe(graph.edges.length);
      for (const component of report.components) expect(component.size).toBeGreaterThan(1);
      expect(dot.length).toBeGreaterThan(0);
      expect(csv.length).toBeGreaterThan(0);
      expect(couplingCsv.length).toBeGreaterThan(0);
      expect(json.length).toBeGreaterThan(0);
      expect(modules.level).toBe("module");

      console.log(
        [
          `scale: ${path} (${String(Math.round(statSync(path).size / 1024))} KiB)`,
          `${String(union.entities.length)} entities, ${String(union.edges.length)} edges`,
          `clean=${String(isClean(diagnostics))}`,
          `load ${String(loadMs)}ms, fold ${String(foldMs)}ms,`,
          `metrics ${String(metricMs)}ms, export ${String(exportMs)}ms,`,
          `total ${String(totalMs)}ms`,
          `-> ${String(types.nodes.length)} type nodes, ${String(types.edges.length)} folded edges,`,
          `${String(report.components.length)} cycles`,
        ].join(" "),
      );

      expect(foldMs).toBeLessThan(FOLD_BUDGET_MS);
      expect(totalMs).toBeLessThan(TOTAL_BUDGET_MS);
    },
  );

  it("folds deterministically at scale", { timeout: TOTAL_BUDGET_MS * 2 }, () => {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const digest = (): string => {
      const graph = buildGraph(loadModels(raw).union);
      return toJsonString(foldedGraphToJson(typeDependencyGraph(graph, declaredOnly)));
    };
    expect(digest()).toBe(digest());
  });
});
