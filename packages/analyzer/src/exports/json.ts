import type { FoldedGraph, FoldLevel } from "../fold.js";
import type { CouplingTable } from "../metrics/coupling.js";
import type { CycleReport } from "../metrics/cycles.js";
import type { ViewDescriptor } from "../views.js";

/**
 * SEAM — the JSON export slice fills this in (decision 7).
 *
 * These shapes are ANALYSIS OUTPUT, not a model: they are never written back
 * into a model.json and never round-tripped through `parseModel`. In
 * particular no inverse index (callers, importers, subtypes, accessors) may
 * appear in anything this file produces — deriving them in memory is the whole
 * point of CLAUDE.md invariant 4.
 *
 * `Set` does not survive `JSON.stringify`: `kinds` and `provenances` become
 * SORTED arrays, so two runs stringify byte-identically.
 */

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

export function foldedGraphToJson(_folded: FoldedGraph): FoldedGraphJson {
  throw new Error("M3: json export slice fills this in");
}

export function couplingToJson(_table: CouplingTable): CouplingTable {
  throw new Error("M3: json export slice fills this in");
}

export function cyclesToJson(_report: CycleReport): CycleReport {
  throw new Error("M3: json export slice fills this in");
}

/** Deterministic stringification of any of the shapes above. */
export function toJsonString(_value: unknown, _options?: JsonExportOptions): string {
  throw new Error("M3: json export slice fills this in");
}
