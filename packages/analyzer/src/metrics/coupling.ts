import type { EntityId } from "@codegraph/core";
import type { FoldedGraph, FoldLevel } from "../fold.js";
import { compareIds } from "../order.js";
import type { ViewDescriptor } from "../views.js";

/**
 * Stage 6: COUPLING (PLAN.md §6.4, decision 4, METAMODEL.md §9).
 *
 * Definitions the implementation honours, because these two get confused
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
 *
 * WHAT THE VIEW DOES TO THE NUMBERS — the caller must be able to tell which
 * question they asked, so `CouplingTable.view` travels with every row:
 *  - under the full view a stub is a legitimate dependency target, so an
 *    external type INFLATES Ce (fixture: `Notifications` depends on 10 types,
 *    6 of them external);
 *  - under `internalOnly` stubs and every edge touching one are gone, so the
 *    same node scores Ce = 4 — "coupling inside the corpus";
 *  - under `declaredOnly` inferred edges (provenance !== "declared") are gone,
 *    so the number is a fact rather than a fact mixed with an inference.
 * None of the three is the "true" answer; the row's `isStub` flag and the
 * table's descriptor say which one was computed.
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

/**
 * Instability. UNDEFINED when nothing touches the node — an isolated package or
 * a leaf value type is common — and 0 is returned rather than NaN, which would
 * propagate silently through every sort, CSV cell and JSON payload downstream.
 * I = 0 reads as "maximally stable", which is the honest reading of a node
 * nothing depends on and that depends on nothing.
 */
function instabilityOf(ce: number, ca: number): number {
  const total = ca + ce;
  return total === 0 ? 0 : ce / total;
}

/**
 * Coupling over a folded graph. Pure: it reads the folded graph and allocates a
 * table; nothing here is written back into the model or serialized as an
 * inverse index (CLAUDE.md invariant 4) — `folded.incoming` is derived in
 * memory by the fold stage and only ever counted here.
 *
 * SELF-LOOPS ARE EXCLUDED BY DEFAULT (`includeSelfLoops`). A type-level
 * self-loop means a method called a sibling method of its own class: real
 * internal cohesion, but not a DEPENDENCY of the class on anything, and
 * counting it would give every cohesive class Ce ≥ 1 and Ca ≥ 1, so instability
 * would never reach its endpoints and "depends on nothing" would become
 * unexpressible. Callers measuring cohesion rather than coupling opt in, and
 * the flag then applies to all four counters so a row stays internally
 * consistent (a node whose only edge is a self-loop is not reported as having
 * zero fan-out but non-zero outgoing weight).
 */
export function coupling(folded: FoldedGraph, options: CouplingOptions = {}): CouplingTable {
  const includeSelfLoops = options.includeSelfLoops === true;

  const rows: CouplingRow[] = folded.nodes.map((node) => {
    // DISTINCT node counts, not edge counts and not Σ count. Aggregation
    // already yields one FoldedEdge per (from,to) pair, but the sets state the
    // definition instead of leaning on that guarantee.
    const targets = new Set<EntityId>();
    const sources = new Set<EntityId>();
    let outgoingEdgeCount = 0;
    let incomingEdgeCount = 0;

    for (const edge of folded.outgoing(node.id)) {
      if (edge.selfLoop && !includeSelfLoops) continue;
      targets.add(edge.to);
      outgoingEdgeCount += edge.count;
    }
    for (const edge of folded.incoming(node.id)) {
      if (edge.selfLoop && !includeSelfLoops) continue;
      sources.add(edge.from);
      incomingEdgeCount += edge.count;
    }

    const ce = targets.size;
    const ca = sources.size;
    return {
      id: node.id,
      name: node.name,
      isStub: node.isStub,
      fanOut: ce,
      fanIn: ca,
      ce,
      ca,
      instability: instabilityOf(ce, ca),
      outgoingEdgeCount,
      incomingEdgeCount,
    };
  });

  // `folded.nodes` is already sorted, but the table's order is its own contract
  // (decision 6) and must not depend on an upstream promise.
  rows.sort((a, b) => compareIds(a.id, b.id));

  return { level: folded.level, view: folded.view, rows: Object.freeze(rows) };
}

/** The row for one node, or undefined when the fold level has no such node. */
export function couplingRow(table: CouplingTable, id: EntityId): CouplingRow | undefined {
  return table.rows.find((row) => row.id === id);
}

/**
 * The most-depended-upon nodes: highest Ca first, ties broken by id so the list
 * is deterministic. High Ca with low Ce is the architecture's load-bearing core.
 */
export function topByFanIn(table: CouplingTable, limit = 10): readonly CouplingRow[] {
  return rankBy(table, (row) => row.fanIn, limit);
}

/** The most-dependent nodes: highest Ce first, ties broken by id. */
export function topByFanOut(table: CouplingTable, limit = 10): readonly CouplingRow[] {
  return rankBy(table, (row) => row.fanOut, limit);
}

function rankBy(
  table: CouplingTable,
  score: (row: CouplingRow) => number,
  limit: number,
): readonly CouplingRow[] {
  if (limit <= 0) return [];
  return [...table.rows]
    .sort((a, b) => score(b) - score(a) || compareIds(a.id, b.id))
    .slice(0, limit);
}
