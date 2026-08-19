import type { EntityId } from "@codegraph/core";
import type { FoldedGraph, FoldLevel } from "../fold.js";
import type { ViewDescriptor } from "../views.js";

/**
 * SEAM — the coupling slice fills this in (decision 4, METAMODEL.md §9).
 *
 * Definitions the implementation must honour, because these two get confused
 * constantly:
 *  - fanOut(n) = number of DISTINCT nodes n depends on. NOT the edge count,
 *    and not the sum of `FoldedEdge.count`.
 *  - fanIn(n)  = number of DISTINCT nodes depending on n.
 *  - Ce = fanOut, Ca = fanIn, at the folded level being measured.
 *  - I = Ce / (Ca + Ce). When Ca + Ce === 0 the ratio is UNDEFINED: return 0,
 *    never NaN — NaN silently poisons every downstream sort and CSV.
 *  - Self-loops are excluded by default: a node does not depend on itself.
 *
 * Every row states the view and fold level it was computed under. A coupling
 * number without its view is not a fact.
 */

export interface CouplingRow {
  readonly id: EntityId;
  readonly name: string | undefined;
  readonly isStub: boolean;
  /** Distinct nodes this one depends on (= Ce). */
  readonly fanOut: number;
  /** Distinct nodes depending on this one (= Ca). */
  readonly fanIn: number;
  readonly ce: number;
  readonly ca: number;
  /** Ce / (Ca + Ce), in [0,1]; 0 by definition when Ca + Ce === 0. */
  readonly instability: number;
  /** Sum of `FoldedEdge.count` outgoing — the aggregated weight, not the fan-out. */
  readonly outgoingEdgeCount: number;
  /** Sum of `FoldedEdge.count` incoming. */
  readonly incomingEdgeCount: number;
}

export interface CouplingTable {
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  /** One row per folded node, sorted by id. */
  readonly rows: readonly CouplingRow[];
}

export interface CouplingOptions {
  /** Count folding-induced self-loops as a dependency. Defaults to false. */
  readonly includeSelfLoops?: boolean;
}

export function coupling(_folded: FoldedGraph, _options?: CouplingOptions): CouplingTable {
  throw new Error("M3: coupling slice fills this in");
}
