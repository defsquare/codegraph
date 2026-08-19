import type { FoldedGraph, FoldLevel } from "../fold.js";
import type { CouplingTable } from "../metrics/coupling.js";
import type { CycleReport } from "../metrics/cycles.js";
import { sortIds } from "../order.js";
import type { ViewDescriptor } from "../views.js";

/**
 * Stage 7: JSON renderings of the analysis output (decision 7).
 *
 * THESE ARE ANALYSIS ARTEFACTS, NOT MODELS. They are never written back into a
 * model.json and never round-tripped through `parseModel`. The folded-graph
 * artefact says so in its own payload — a `kind` and a `generatedBy` field,
 * and deliberately NO `schemaVersion`, which is the interchange format's
 * marker: a file carrying one claims to be extractor output, and this is not.
 * (The coupling and cycle tables cannot be confused with a model at all: they
 * have no `entities`, no `lang`, no `extractor`.)
 *
 * No inverse index appears in anything produced here — callers, importers,
 * subtypes and accessors are derived in memory and stay there (CLAUDE.md
 * invariant 4).
 *
 * `Set` does not survive `JSON.stringify`, so `kinds` and `provenances` become
 * SORTED arrays and two runs stringify byte-identically. Everything else is
 * already in the folded graph's deterministic order.
 */

/** What the artefact is, stated in the artefact. */
export const FOLDED_GRAPH_ARTEFACT_KIND = "codegraph.foldedGraph/1";
export const ARTEFACT_GENERATOR = "@codegraph/analyzer";

export interface FoldedEdgeJson {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  /** Sorted. */
  readonly kinds: readonly string[];
  /** Sorted. */
  readonly provenances: readonly string[];
  readonly selfLoop: boolean;
}

export interface FoldedNodeJson {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  readonly isStub: boolean;
  readonly members: number;
}

export interface FoldedGraphJson {
  /** Always `codegraph.foldedGraph/1` — this is analysis output, not a model. */
  readonly kind: string;
  /** Always `@codegraph/analyzer`. */
  readonly generatedBy: string;
  readonly level: FoldLevel;
  readonly view: ViewDescriptor;
  readonly nodes: readonly FoldedNodeJson[];
  readonly edges: readonly FoldedEdgeJson[];
  readonly diagnostics: {
    readonly unfoldableEntities: readonly string[];
    readonly droppedEdges: number;
    readonly foldedEdges: number;
  };
}

export interface JsonExportOptions {
  /** `JSON.stringify` indent. Defaults to 2. */
  readonly indent?: number;
}

export function foldedGraphToJson(folded: FoldedGraph): FoldedGraphJson {
  return {
    kind: FOLDED_GRAPH_ARTEFACT_KIND,
    generatedBy: ARTEFACT_GENERATOR,
    level: folded.level,
    view: { name: folded.view.name, filters: [...folded.view.filters] },
    nodes: folded.nodes.map((node) => {
      // `name` is optional here, so an unnamed node omits the key rather than
      // carrying an `undefined` that JSON.stringify would silently drop.
      const base = {
        id: node.id,
        kind: node.kind,
        isStub: node.isStub,
        members: node.members,
      };
      return node.name === undefined ? base : { ...base, name: node.name };
    }),
    edges: folded.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      count: edge.count,
      kinds: sortIds(edge.kinds),
      provenances: sortIds(edge.provenances),
      selfLoop: edge.selfLoop,
    })),
    diagnostics: {
      unfoldableEntities: [...folded.diagnostics.unfoldableEntities],
      droppedEdges: folded.diagnostics.droppedEdges,
      foldedEdges: folded.diagnostics.foldedEdges,
    },
  };
}

/**
 * A detached, JSON-safe copy of the coupling table: no shared arrays with the
 * live table. `CouplingRow.name` is a required key that may hold `undefined`,
 * which `JSON.stringify` drops — a node with no name simply has no name.
 */
export function couplingToJson(table: CouplingTable): CouplingTable {
  return {
    level: table.level,
    view: { name: table.view.name, filters: [...table.view.filters] },
    rows: table.rows.map((row) => ({
      id: row.id,
      name: row.name,
      isStub: row.isStub,
      fanOut: row.fanOut,
      fanIn: row.fanIn,
      ce: row.ce,
      ca: row.ca,
      instability: row.instability,
      outgoingEdgeCount: row.outgoingEdgeCount,
      incomingEdgeCount: row.incomingEdgeCount,
    })),
  };
}

/** A detached, JSON-safe copy of the cycle report. */
export function cyclesToJson(report: CycleReport): CycleReport {
  return {
    level: report.level,
    view: { name: report.view.name, filters: [...report.view.filters] },
    components: report.components.map((component) => ({
      members: [...component.members],
      size: component.size,
      internalEdgeCount: component.internalEdgeCount,
      weight: component.weight,
    })),
    selfLoops: [...report.selfLoops],
  };
}

/**
 * Deterministic stringification of any of the shapes above, newline-terminated.
 *
 * A stray `Set` — someone stringifying a raw `FoldedGraph` rather than its
 * artefact — becomes a sorted array instead of `{}`, so the output never
 * silently loses the kinds and provenances that make an edge auditable.
 */
export function toJsonString(value: unknown, options?: JsonExportOptions): string {
  const indent = options?.indent ?? 2;
  const replacer = (_key: string, current: unknown): unknown => {
    if (current instanceof Set) {
      const values: unknown[] = [...current];
      return values.every((item) => typeof item === "string")
        ? sortIds(values as string[])
        : values;
    }
    return current;
  };
  return `${JSON.stringify(value, replacer, indent)}\n`;
}
