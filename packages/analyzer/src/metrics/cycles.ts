import type { EntityId } from "@codegraph/core";
import type { FoldedGraph, FoldLevel } from "../fold.js";
import type { ViewDescriptor } from "../views.js";

/**
 * SEAM — the cycles slice fills this in (decision 5, METAMODEL.md §9).
 *
 * Tarjan strongly connected components, ITERATIVE — an explicit stack, no
 * recursion. 15 000 nodes blow the call stack on a recursive implementation and
 * the failure looks like a mysterious crash on real data, not like a bug in
 * this file.
 *
 * Report components of size > `minSize - 1` (default: size > 1) plus genuine
 * self-loops, separately: a folding-induced self-loop is a method calling its
 * sibling, which is not an architectural cycle. Deterministic order: members
 * sorted by id, components sorted by their first member.
 */

export interface StronglyConnectedComponent {
  /** Members sorted by id. */
  readonly members: readonly EntityId[];
  readonly size: number;
  /** Folded edges whose endpoints are both in this component (self-loops included). */
  readonly internalEdgeCount: number;
  /** Sum of `FoldedEdge.count` over those edges — the base-edge weight of the cycle. */
  readonly weight: number;
}

export interface CycleReport {
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  /** SCCs of size >= minSize, sorted by first member. */
  readonly components: readonly StronglyConnectedComponent[];
  /** Nodes carrying a folding-induced self-loop, sorted. */
  readonly selfLoops: readonly EntityId[];
}

export interface CyclesOptions {
  /** Smallest component size reported. Defaults to 2. */
  readonly minSize?: number;
}

export function cycles(_folded: FoldedGraph, _options?: CyclesOptions): CycleReport {
  throw new Error("M3: cycles slice fills this in");
}
