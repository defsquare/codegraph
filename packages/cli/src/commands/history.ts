import { readFileSync } from "node:fs";
import {
  HistoryError,
  authorStats,
  decodeHistoryText,
  hotspots,
  summarize,
  type History,
} from "@codegraph/scm";
import type { HistoryOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLines, type IoSink } from "../io.js";

/**
 * `codegraph history [history.jsonl] [--report summary|hotspots|authors]
 * [--top N] [--json]`.
 *
 * File-level only, no model join (PLAN §11.1) — every number here comes from
 * `git log` alone; joining evolution onto the code graph is M9b's work.
 *
 * EXIT (decision 2): an unreadable PATH is a usage error; a readable file
 * that is not a history is a FINDING about the file (exit 3), exactly as the
 * model commands treat a broken model.
 */
export function historyCommand(options: HistoryOptions, io: IoSink): ExitCode {
  let text: string;
  try {
    text = readFileSync(options.history, "utf8");
  } catch (error) {
    throw new UsageError(
      `cannot read ${options.history}: ${error instanceof Error ? error.message : String(error)}`,
      "Mine it first: codegraph scm <repo> --out " + options.history,
      { cause: error },
    );
  }

  let history: History;
  try {
    history = decodeHistoryText(text);
  } catch (error) {
    if (!(error instanceof HistoryError)) throw error;
    errLine(io, `${options.history} is not a history.jsonl: ${error.message}`);
    return EXIT.FINDINGS;
  }

  switch (options.report) {
    case "summary":
      outLines(io, options.json ? [jsonOf("summary", summarize(history))] : summaryText(history));
      return EXIT.OK;
    case "hotspots": {
      const top = options.top ?? 20;
      const rows = hotspots(history);
      outLines(
        io,
        options.json
          ? [jsonOf("hotspots", { total: rows.length, rows: rows.slice(0, top) })]
          : hotspotsText(history, rows, top),
      );
      return EXIT.OK;
    }
    case "authors": {
      const report = authorStats(history);
      const rows = options.top === undefined ? report.rows : report.rows.slice(0, options.top);
      outLines(
        io,
        options.json
          ? [jsonOf("authors", { total: report.rows.length, busFactor: report.busFactor, rows })]
          : authorsText(history, rows, report.rows.length, report.busFactor),
      );
      return EXIT.OK;
    }
  }
}

function jsonOf(report: string, body: object): string {
  return JSON.stringify({ report, ...body }, null, 2);
}

function day(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function summaryText(history: History): readonly string[] {
  const s = summarize(history);
  const lines = [
    `history of ${s.repo}: ${s.commits} commits by ${s.authors} authors over ${s.paths} files`,
  ];
  if (s.span !== undefined) {
    const days = Math.round((s.span.to - s.span.from) / 86_400);
    lines.push(`  span:         ${day(s.span.from)} .. ${day(s.span.to)} (${days} days)`);
  }
  lines.push(`  churn:        +${s.added} / -${s.deleted} (${s.churn} lines)`);
  lines.push(
    `  firefighting: ${s.fixes} fixes (${percent(s.firefighting)} of commits), ${s.reverts} reverts`,
  );
  lines.push(`  momentum:     ${s.momentum.toFixed(2)}x (last 90 days vs lifetime rate)`);
  return lines;
}

/** Right-aligned numeric columns, path last — diffable, greppable, no ANSI. */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const render = (row: readonly string[]): string =>
    "  " +
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padStart(widths[column] ?? 0),
      )
      .join("  ");
  return [render(header), ...rows.map(render)];
}

function hotspotsText(
  history: History,
  rows: ReturnType<typeof hotspots>,
  top: number,
): readonly string[] {
  const shown = rows.slice(0, top);
  const lines = [
    `hotspots of ${history.repo} (top ${shown.length} of ${rows.length} files by revisions):`,
  ];
  lines.push(
    ...table(
      ["REVISIONS", "CHURN", "FIXES", "DENSITY", "AUTHORS", "PATH"],
      shown.map((row) => [
        String(row.revisions),
        String(row.churn),
        String(row.fixes),
        row.bugDensity.toFixed(2),
        String(row.authors),
        row.path,
      ]),
    ),
  );
  return lines;
}

function authorsText(
  history: History,
  rows: ReturnType<typeof authorStats>["rows"],
  total: number,
  busFactor: number,
): readonly string[] {
  const lines = [`authors of ${history.repo} (${total}):`];
  lines.push(
    ...table(
      ["COMMITS", "CHURN", "FILES", "OWNS", "FIXES", "AUTHOR"],
      rows.map((row) => [
        String(row.commits),
        String(row.churn),
        String(row.paths),
        String(row.owns),
        String(row.fixes),
        row.author,
      ]),
    ),
  );
  lines.push(`bus factor: ${busFactor} (fewest owners covering >50% of files)`);
  return lines;
}
