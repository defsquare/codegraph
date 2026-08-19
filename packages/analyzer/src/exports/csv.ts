import type { FoldedGraph } from "../fold.js";
import type { CouplingTable } from "../metrics/coupling.js";
import type { CycleReport } from "../metrics/cycles.js";

/**
 * SEAM — the CSV export slice fills this in (decision 7).
 *
 * Rules: RFC 4180 quoting (a field containing the delimiter, a quote or a
 * newline is quoted, and inner quotes are doubled); a header row naming every
 * column; provenance and `isStub` carried as columns so a spreadsheet reader
 * can still tell a fact from an inference; rows in the source table's order,
 * which is already deterministic.
 */

export interface CsvOptions {
  /** Field delimiter. Defaults to `,`. */
  readonly delimiter?: string;
  /** Emit the header row. Defaults to true. */
  readonly header?: boolean;
}

/** Columns: from,to,count,kinds,provenances,selfLoop */
export function foldedGraphToCsv(_folded: FoldedGraph, _options?: CsvOptions): string {
  throw new Error("M3: csv export slice fills this in");
}

/** Columns: id,name,isStub,fanIn,fanOut,ca,ce,instability,incomingEdgeCount,outgoingEdgeCount */
export function couplingToCsv(_table: CouplingTable, _options?: CsvOptions): string {
  throw new Error("M3: csv export slice fills this in");
}

/** Columns: component,size,weight,member */
export function cyclesToCsv(_report: CycleReport, _options?: CsvOptions): string {
  throw new Error("M3: csv export slice fills this in");
}
