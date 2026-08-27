import type { FoldedGraph } from "../fold.js";
import type { CouplingTable } from "../metrics/coupling.js";
import type { CycleReport } from "../metrics/cycles.js";
import { sortIds } from "../order.js";

/**
 * Stage 7: CSV renderings of the folded graph and the metric tables
 * (decision 7).
 *
 * QUOTING is RFC 4180: a field containing the delimiter, a double quote, CR or
 * LF is wrapped in quotes and its own quotes are doubled. Leading or trailing
 * spaces are quoted too, because spreadsheet importers silently trim them.
 * The record separator is LF, not CRLF — every parser accepts it and it keeps
 * the output free of invisible CR churn in tests and in git.
 *
 * EVERY ROW CARRIES ITS `level` AND `view`. A coupling number without its view
 * is not a fact (decision 4), and a comment line would be read as data by a
 * conforming parser while `header: false` would drop it entirely — so the
 * provenance of the numbers lives in columns, which survive sorting, filtering
 * and concatenation in a spreadsheet.
 *
 * Rows are emitted in the source table's order, which is already deterministic.
 */

export interface CsvOptions {
  /** Field delimiter. Defaults to `,`. */
  readonly delimiter?: string;
  /** Emit the header row. Defaults to true. */
  readonly header?: boolean;
}

type Field = string | number | boolean | undefined;

/** RFC 4180 field escaping against the delimiter actually in use. */
function escapeCsv(value: Field, delimiter: string): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text !== text.trim();
  if (!needsQuotes) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function render(
  columns: readonly string[],
  rows: readonly (readonly Field[])[],
  options: CsvOptions | undefined,
): string {
  const delimiter = options?.delimiter ?? ",";
  const withHeader = options?.header ?? true;
  const lines: string[] = [];
  if (withHeader) lines.push(columns.map((column) => escapeCsv(column, delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(row.map((field) => escapeCsv(field, delimiter)).join(delimiter));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Sets are rendered as sorted `;`-joined lists so the output is byte-stable. */
function joinSet(values: Iterable<string>): string {
  return sortIds(values).join(";");
}

/** Columns: from,to,count,kinds,provenances,selfLoop,level,view */
export function foldedGraphToCsv(folded: FoldedGraph, options?: CsvOptions): string {
  const level = folded.level;
  const view = folded.view.name;
  return render(
    ["from", "to", "count", "kinds", "provenances", "selfLoop", "level", "view"],
    folded.edges.map((edge) => [
      edge.from,
      edge.to,
      edge.count,
      joinSet(edge.kinds),
      joinSet(edge.provenances),
      edge.selfLoop,
      level,
      view,
    ]),
    options,
  );
}

/**
 * Columns: id,name,isStub,fanIn,fanOut,ca,ce,instability,incomingEdgeCount,
 * outgoingEdgeCount,level,view
 */
export function couplingToCsv(table: CouplingTable, options?: CsvOptions): string {
  const level = table.level;
  const view = table.view.name;
  return render(
    [
      "id",
      "name",
      "isStub",
      "fanIn",
      "fanOut",
      "ca",
      "ce",
      "instability",
      "incomingEdgeCount",
      "outgoingEdgeCount",
      "level",
      "view",
    ],
    table.rows.map((row) => [
      row.id,
      row.name,
      row.isStub,
      row.fanIn,
      row.fanOut,
      row.ca,
      row.ce,
      row.instability,
      row.incomingEdgeCount,
      row.outgoingEdgeCount,
      level,
      view,
    ]),
    options,
  );
}

/**
 * Columns: component,size,weight,member,internalEdgeCount,level,view — one row
 * per member, so the table is flat enough for a pivot.
 *
 * `component` is `scc:<index into CycleReport.components>` for a strongly
 * connected component and `selfLoop` for a folding-induced self-loop. A
 * self-loop row leaves `weight` and `internalEdgeCount` EMPTY: the report does
 * not carry them, and an empty field is honest where a 0 would be invented.
 */
export function cyclesToCsv(report: CycleReport, options?: CsvOptions): string {
  const level = report.level;
  const view = report.view.name;
  const rows: (readonly Field[])[] = [];
  // The feedback EDGES themselves are not rows here — this table is one row
  // per member, and the cut lives in the JSON/text forms. The two scores are
  // repeated per member like the rest of the component columns.
  report.components.forEach((component, index) => {
    for (const member of component.members) {
      rows.push([
        `scc:${index}`,
        component.size,
        component.weight,
        component.feedbackWeight,
        component.tangleMetric,
        member,
        component.internalEdgeCount,
        level,
        view,
      ]);
    }
  });
  for (const id of report.selfLoops) {
    // Empty, not 0: a self-loop is never in a feedback set or scored.
    rows.push(["selfLoop", 1, undefined, undefined, undefined, id, undefined, level, view]);
  }
  return render(
    [
      "component",
      "size",
      "weight",
      "feedbackWeight",
      "tangleMetric",
      "member",
      "internalEdgeCount",
      "level",
      "view",
    ],
    rows,
    options,
  );
}
