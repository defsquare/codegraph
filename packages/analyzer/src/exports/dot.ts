import type { FoldedGraph } from "../fold.js";

/**
 * SEAM — the DOT export slice fills this in (decision 7).
 *
 * A rendering is a claim about the model, so CLAUDE.md's honesty rule applies:
 *  - `derived` / `dynamic-candidate` / `generated` edges MUST be visually
 *    distinguishable from `declared` facts (dashed vs solid, say). A folded
 *    edge aggregating several provenances is not `declared`.
 *  - Stub nodes MUST be distinguishable from corpus entities.
 *  - The aggregated `count` belongs on the edge (label and/or penwidth) — it is
 *    the weight the fold computed, and hiding it makes the picture a lie.
 *  - Never draw a relationship the model does not contain.
 *  - ESCAPE labels: an id containing `"` or `\` must not produce invalid DOT.
 *    Graphviz is not installed on this machine, so verify the output
 *    structurally, in tests, not by shelling out to `dot`.
 *  - Output is deterministic: emit nodes and edges in the folded graph's order.
 */

export interface DotOptions {
  /** Graph name in `digraph <name> {`. Defaults to `codegraph`. */
  readonly name?: string;
  /** Node label source. Defaults to `name` with a fallback to the id. */
  readonly labels?: "name" | "id";
  /** Emit the view/level/diagnostics as a leading DOT comment. Defaults to true. */
  readonly header?: boolean;
}

export function toDot(_folded: FoldedGraph, _options?: DotOptions): string {
  throw new Error("M3: dot export slice fills this in");
}

/** Quote and escape an arbitrary string as a DOT id/label. */
export function escapeDot(_value: string): string {
  throw new Error("M3: dot export slice fills this in");
}
