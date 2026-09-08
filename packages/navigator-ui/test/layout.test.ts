import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_CAP,
  graphDisplay,
} from "../src/model/graph.js";
import {
  GRAPH_SIZES,
  GRAPH_SIZE_SLOW,
  PROOF_MAX_NODES,
  graphLayoutBudget,
} from "../src/model/layout.js";

/**
 * The Graph tab froze for 144 SECONDS on this corpus's modules drawing (1,200
 * nodes, 12,395 links). What fixes that is NOT an iteration limit — fcose runs
 * past its own `numIter` — it is drawing less. These are the properties that
 * keep the default affordable, not a memory of which numbers were fast.
 */
describe("graph layout budget", () => {
  it("defaults to a drawing size that measured near a second, not two minutes", () => {
    expect(DEFAULT_GRAPH_CAP).toBeLessThanOrEqual(GRAPH_SIZE_SLOW);
    expect(GRAPH_SIZES).toContain(DEFAULT_GRAPH_CAP);
  });

  it("offers the reader the larger sizes it no longer takes by default", () => {
    expect(Math.max(...GRAPH_SIZES)).toBeGreaterThan(DEFAULT_GRAPH_CAP);
    expect([...GRAPH_SIZES]).toEqual([...GRAPH_SIZES].sort((a, b) => a - b));
  });

  it("spends proof quality only on a drawing small enough to afford it", () => {
    expect(graphLayoutBudget("modules", PROOF_MAX_NODES).quality).toBe("proof");
    expect(graphLayoutBudget("modules", PROOF_MAX_NODES + 1).quality).not.toBe("proof");
  });

  it("never asks proof quality of the default drawing or anything larger", () => {
    for (const size of GRAPH_SIZES) {
      if (size <= PROOF_MAX_NODES) continue;
      expect(graphLayoutBudget("modules", size).quality).toBe("default");
    }
  });

  it("lays types out as compounds and modules flat — the shapes differ", () => {
    expect(graphLayoutBudget("types", 20).nestingFactor).toBeDefined();
    expect(graphLayoutBudget("types", 20).packComponents).toBe(true);
    expect(graphLayoutBudget("modules", 20).nestingFactor).toBeUndefined();
  });

  it("never animates — the layout runs to completion before the first paint", () => {
    expect(graphLayoutBudget("modules", 1200).animate).toBe(false);
  });
});

/**
 * The cap is what bounds the cost, so it has to bound the DRAWING — a cap that
 * silently let more through would put the freeze straight back.
 */
describe("the cap is the bound", () => {
  it("never draws more nodes than the chosen size", () => {
    const model = bigModel();
    for (const cap of GRAPH_SIZES) {
      const display = graphDisplay(model, { mode: "modules", hideExternals: false, minFanIn: 0, cap });
      expect(display.nodes.length).toBeLessThanOrEqual(cap);
    }
  });

  it("says so when it truncates, so a smaller default never reads as a smaller corpus", () => {
    const model = bigModel();
    const display = graphDisplay(model, { mode: "modules", hideExternals: false, minFanIn: 0, cap: 10 });
    expect(display.truncated).toBe(true);
    expect(display.totalNodes).toBeGreaterThan(display.nodes.length);
  });
});

/** A ring of 60 modules, each importing the next — 60 nodes, 60 links. */
function bigModel() {
  const count = 60;
  const nodes = Array.from({ length: count }, (_, i) => ({
    name: `m${i}`,
    kind: "package",
    category: "module" as const,
    isStub: false,
    children: [],
    metrics: { fanIn: 1, fanOut: 1, instability: 0.5 },
  }));
  const deps = Array.from({ length: count }, (_, i) => ({
    role: "import" as const,
    from: i,
    to: (i + 1) % count,
    provenance: "declared" as const,
    anchor: [0, 1, 1] as [number, number, number],
  }));
  return {
    kind: "codegraph.navigator/1" as const,
    generatedBy: "@codegraph/navigator",
    view: { name: "all", filters: [] },
    corpus: { name: "ring", roots: ["ring"] },
    files: ["m.java"],
    nodes,
    roots: nodes.map((_, i) => i),
    deps,
    diagnostics: { selfDeps: 0, droppedDeps: 0 },
  };
}

/**
 * The stock fcose repulsion is tuned for point-sized nodes; these are 26-80px
 * discs, and at the default the drawing was one solid blob at every size.
 */
describe("separation", () => {
  it("gives both modes far more room than fcose's own defaults", () => {
    for (const mode of ["modules", "types"] as const) {
      const budget = graphLayoutBudget(mode, 300);
      expect(budget.nodeRepulsion).toBeGreaterThan(4500); // fcose's default
      expect(budget.idealEdgeLength).toBeGreaterThan(50); // fcose's default
    }
  });

  it("gives modules more room than types — the discs are twice the size", () => {
    expect(graphLayoutBudget("modules", 300).nodeRepulsion).toBeGreaterThan(
      graphLayoutBudget("types", 300).nodeRepulsion,
    );
    expect(graphLayoutBudget("modules", 300).idealEdgeLength).toBeGreaterThan(
      graphLayoutBudget("types", 300).idealEdgeLength,
    );
  });
});
