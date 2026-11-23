import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import {
  HOTSPOT_FAMILIES,
  buildGraph,
  crossModuleShare,
  deadWeight,
  fileDependencies,
  fileMeasures,
  hiddenCoupling,
  joinOnPaths,
  joinedHotspots,
  type CodeGraph,
  type CrossModuleShare,
  type DeadWeightReport,
  type FileJoin,
  type HiddenCouplingReport,
  type JoinedHotspotReport,
} from "@codegraph/analyzer";
import { buildFileCity, cityToJsonString, layoutFileCity } from "@codegraph/city";
import {
  COUPLING_DEFAULTS,
  HistoryError,
  authorStats,
  decodeHistoryText,
  fileOwners,
  hotspots,
  logicalCoupling,
  summarize,
  type CoChangeReport,
  type History,
} from "@codegraph/scm";
import { defaultModelPath, type HistoryOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLines, type IoSink } from "../io.js";
import { loadModelFiles } from "../load.js";
import { startCityServer, vizAssets, type CityServerOptions } from "../serve.js";

/**
 * `codegraph history [history.jsonl] [--report summary|hotspots|authors]
 * [--top N] [--serve] [--city FILE] [--json]`.
 *
 * The file-level reports (summary, hotspots, authors, coupling) come from
 * `git log` alone. `hidden` and `deadweight` are the CROSS-GRAPH reports
 * (M9b): they additionally load `--model` and join on paths — co-change the
 * declared graph cannot explain, and declared dependencies history never
 * exercised. The join itself lives in the analyzer; this command only feeds
 * both sides in.
 *
 * `hotspots` and `summary` join a model ONLY WHEN `--model` NAMES ONE (M23b):
 * they are the history's own reports otherwise, and a `model.jsonl` that
 * happens to sit in the directory must not change what they print. Joined,
 * `hotspots` is effort times complexity in four families, and `summary` gains
 * the share of commits that cross a top-level directory of the model.
 *
 * `--serve` hosts the FILE-LEVEL REPLAY: the history becomes a laid-out city
 * artifact (buildings = file lineages, districts = directories) with a
 * `replay` block — commits as ticks, heights as keyframe series — and the
 * visualizer scrubs it. `--city FILE` writes that same artifact. With either,
 * the replay is the deliverable and no report reaches stdout.
 *
 * EXIT (decision 2): an unreadable PATH is a usage error; a readable file
 * that is not a history is a FINDING about the file (exit 3), exactly as the
 * model commands treat a broken model.
 */

/** The server seam, injectable so tests need no sockets and no built viz. */
export interface ServeDeps {
  readonly assetsDir: typeof vizAssets;
  readonly startServer: (serverOptions: CityServerOptions) => unknown;
}
const REAL_SERVE: ServeDeps = { assetsDir: vizAssets, startServer: startCityServer };

export function historyCommand(
  options: HistoryOptions,
  io: IoSink,
  deps: ServeDeps = REAL_SERVE,
): ExitCode {
  // Resolve the assets FIRST: an unbuilt visualizer must fail before work is done.
  const assets = options.serve ? deps.assetsDir() : undefined;

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

  if (options.serve || options.city !== undefined) {
    // The history is all there is here, so the time channels come for free:
    // per-lineage owners and the default-threshold co-change arcs.
    const artifact = cityToJsonString(
      layoutFileCity(
        buildFileCity(history, {
          owners: fileOwners(history),
          coChange: logicalCoupling(history).rows,
        }),
      ),
    );
    if (options.city !== undefined) {
      io.writeFile(options.city, artifact);
      errLine(
        io,
        `wrote ${Buffer.byteLength(artifact, "utf8")} bytes to ${options.city} ` +
          `(replay city: ${history.paths.length} files, ${history.commits.length} ticks).`,
      );
    }
    if (assets !== undefined) {
      deps.startServer({ artifact, assets, port: options.port, host: options.host, io });
    }
    return EXIT.OK;
  }

  try {
    return printReport(history, options, io);
  } catch (error) {
    if (error instanceof NotAModel) return EXIT.FINDINGS;
    throw error;
  }
}

function printReport(history: History, options: HistoryOptions, io: IoSink): ExitCode {
  switch (options.report) {
    case "summary": {
      const crossing = options.model === undefined ? undefined : crossModule(history, options, io);
      outLines(
        io,
        options.json
          ? [jsonOf("summary", { ...summarize(history), ...(crossing === undefined ? {} : { crossModule: crossing }) })]
          : [...summaryText(history), ...(crossing === undefined ? [] : [crossModuleLine(crossing)])],
      );
      return EXIT.OK;
    }
    case "hotspots": {
      const top = options.top ?? 20;
      const rows = hotspots(history);
      if (options.model !== undefined) {
        const { graph, deps, join } = crossGraph(history, options, io);
        const report = joinedHotspots(withOwners(history, rows), fileMeasures(graph, deps), join, { rank: options.rank });
        reportUnjoined(report, rows.length, io);
        outLines(
          io,
          options.json
            ? [
                jsonOf("hotspots", {
                  rank: report.rank,
                  total: report.rows.length,
                  outsideModel: report.outsideModel,
                  outsideHistory: report.outsideHistory,
                  rows: report.rows.slice(0, top),
                }),
              ]
            : joinedHotspotsText(history, report, top),
        );
        return EXIT.OK;
      }
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
    case "coupling": {
      const report = logicalCoupling(history, {
        minSupport: options.minSupport,
        minConfidence: options.minConfidence,
      });
      reportSkipped(report, io);
      const top = options.top ?? 20;
      outLines(
        io,
        options.json
          ? [jsonOf("coupling", { total: report.rows.length, rows: report.rows.slice(0, top) })]
          : couplingText(history, report, top, options),
      );
      return EXIT.OK;
    }
    case "hidden": {
      const { deps, join } = crossGraph(history, options, io);
      const coupled = logicalCoupling(history, {
        minSupport: options.minSupport,
        minConfidence: options.minConfidence,
      });
      reportSkipped(coupled, io);
      const report = hiddenCoupling(coupled.rows, deps, join);
      if (report.outsideModel > 0) {
        errLine(io, `note: ${report.outsideModel} co-changed pairs lie outside the model (docs, config…).`);
      }
      const top = options.top ?? 20;
      outLines(
        io,
        options.json
          ? [jsonOf("hidden", { total: report.rows.length, rows: report.rows.slice(0, top) })]
          : hiddenText(history, report, top),
      );
      return EXIT.OK;
    }
    case "deadweight": {
      const { deps, join } = crossGraph(history, options, io);
      // Unthresholded on purpose: ONE co-change already refutes "dead".
      const coupled = logicalCoupling(history, { minSupport: 1, minConfidence: 0 });
      const revisions = new Map(hotspots(history).map((row) => [row.path, row.revisions]));
      const report = deadWeight(deps, join, coupled.rows, revisions);
      if (report.outsideHistory > 0) {
        errLine(io, `note: ${report.outsideHistory} declared file pairs have no history to judge them.`);
      }
      const top = options.top ?? 20;
      outLines(
        io,
        options.json
          ? [jsonOf("deadweight", { total: report.rows.length, rows: report.rows.slice(0, top) })]
          : deadWeightText(history, report, top),
      );
      return EXIT.OK;
    }
  }
}

/**
 * The `--model` was readable and is not a model. Thrown, not returned, so no
 * report can be computed over the empty union such a file loads as: "none —
 * every co-changed pair is explained" would then be said of nothing at all.
 */
class NotAModel extends Error {}

/** Load the model side and join it, once, for any report that reads both graphs. */
function crossGraph(
  history: History,
  options: HistoryOptions,
  io: IoSink,
): { graph: CodeGraph; deps: ReturnType<typeof fileDependencies>; join: FileJoin } {
  const modelPath = options.model ?? defaultModelPath();
  let loaded: ReturnType<typeof loadModelFiles>;
  try {
    loaded = loadModelFiles([modelPath]);
  } catch (error) {
    throw new UsageError(
      `the ${options.report} report joins history with a model, and ${modelPath} cannot be loaded`,
      "Extract one first (java -jar codegraph-java.jar, or codegraph-csharp) or name it with --model FILE.",
      { cause: error },
    );
  }
  const unreadable = loaded.diagnostics.schemaErrors[0];
  if (unreadable !== undefined) {
    errLine(io, `${modelPath} is not a model: ${unreadable.message}`);
    errLine(io, `Run 'codegraph validate ${modelPath}' for every finding.`);
    throw new NotAModel(modelPath);
  }
  if (!loaded.clean) {
    errLine(io, `warning: ${modelPath} has findings; the join was computed anyway.`);
  }
  const graph = buildGraph(loaded.union);
  const deps = fileDependencies(graph);
  const join = joinOnPaths(deps.files, history.paths);
  if (join.ambiguous.length > 0) {
    errLine(
      io,
      `note: ${join.ambiguous.length} paths joined ambiguously and were left out of the join.`,
    );
  }
  return { graph, deps, join };
}

/**
 * The share of commits crossing a top-level directory of the model. Sweeping
 * commits are left out by the limit `coupling` uses, and for its reason: a
 * reformat touches every directory and says nothing about the cut.
 */
function crossModule(history: History, options: HistoryOptions, io: IoSink): CrossModuleShare {
  const { join } = crossGraph(history, options, io);
  const changesets: string[][] = history.commits.map(() => []);
  for (const change of history.changes) {
    const path = history.paths[change.path];
    if (path !== undefined) changesets[change.commit]?.push(path);
  }
  const share = crossModuleShare(changesets, join, { maxChangesetSize: COUPLING_DEFAULTS.maxChangesetSize });
  if (share.skipped > 0) {
    errLine(
      io,
      `note: ${share.skipped} sweeping commits left out of the cross-module share ` +
        `(changesets over ${COUPLING_DEFAULTS.maxChangesetSize} files cross everything).`,
    );
  }
  return share;
}

function crossModuleLine(share: CrossModuleShare): string {
  const where = `${share.modules.length} ${share.root === "" ? "at its root" : `under ${share.root}`}`;
  return (
    `  cross-module: ${share.crossing} of ${share.commits} commits touching the model ` +
    `cross its top-level directories (${percent(share.share)}; ${where})`
  );
}

type OwnedHotspot = ReturnType<typeof hotspots>[number] & {
  /** The owner's share of the lines added to the file; `null` when nobody added any. */
  readonly ownerShare: number | null;
  /** The day of that owner's last commit ANYWHERE in the history. */
  readonly ownerLastSeen: string | null;
  /** That owner's row in `--report authors`, from 1: two files with one rank have one owner. */
  readonly ownerRank: number | null;
};

/**
 * Ownership WITHOUT A NAME. The walk asks "is whoever wrote most of this still
 * around?" and "do the hotspots have one owner?", and its report may be handed
 * to someone else: a share, a date and a ROW NUMBER answer both without
 * putting a person in it. The row is the owner's in `--report authors`, which
 * is where the name is. Same owner rule as that report and the bus factor.
 */
function withOwners(history: History, rows: ReturnType<typeof hotspots>): OwnedHotspot[] {
  const owners = fileOwners(history);
  const lastSeen = new Map<string, number>();
  for (const commit of history.commits) {
    const author = history.authors[commit.author];
    if (author !== undefined) lastSeen.set(author, Math.max(lastSeen.get(author) ?? 0, commit.time));
  }
  const rank = new Map(authorStats(history).rows.map((author, index) => [author.author, index + 1]));
  return rows.map((row) => {
    const owner = owners.get(row.path);
    const seen = owner === undefined ? undefined : lastSeen.get(owner.name);
    return {
      ...row,
      ownerShare: owner?.share ?? null,
      ownerLastSeen: seen === undefined ? null : day(seen),
      ownerRank: owner === undefined ? null : (rank.get(owner.name) ?? null),
    };
  });
}

/** What the join left out, on stderr: a low joined count means the model came from elsewhere. */
function reportUnjoined(report: JoinedHotspotReport<OwnedHotspot>, historyFiles: number, io: IoSink): void {
  const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
  if (report.outsideModel > 0) {
    errLine(
      io,
      `note: ${report.outsideModel} of ${historyFiles} history files ` +
        `${plural(report.outsideModel, "has", "have")} no counterpart in the model ` +
        `(docs, build files, deleted files, anything outside the extracted root).`,
    );
  }
  if (report.outsideHistory > 0) {
    errLine(
      io,
      `note: ${report.outsideHistory} model ${plural(report.outsideHistory, "file was", "files were")} ` +
        `touched by no mined commit.`,
    );
  }
}

function reportSkipped(report: CoChangeReport, io: IoSink): void {
  if (report.skippedChangesets > 0) {
    errLine(
      io,
      `note: ${report.skippedChangesets} sweeping commits skipped for coupling ` +
        `(changesets over 30 files couple nothing meaningfully).`,
    );
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

/** `-` for what was not measured or not ranked: absent is not zero. */
const cell = (value: number | null): string => (value === null ? "-" : String(value));

function joinedHotspotsText(
  history: History,
  report: JoinedHotspotReport<OwnedHotspot>,
  top: number,
): readonly string[] {
  const shown = report.rows.slice(0, top);
  const lines = [
    `hotspots of ${history.repo}, joined with the model ` +
      `(top ${shown.length} of ${report.rows.length} files, by ${report.rank} rank):`,
  ];
  if (report.rows.length === 0) {
    lines.push("  none — no history file matches a file of the model. Was it extracted inside this clone?");
    return lines;
  }
  lines.push(
    ...table(
      [
        "REVISIONS", "SLOC", "CYCLOMATIC", "CYCLE", "FIXES", "DENSITY", "AUTHORS", "OWNER",
        ...HOTSPOT_FAMILIES.map((family) => family.toUpperCase()),
        "PATH",
      ],
      shown.map((row) => [
        String(row.revisions),
        cell(row.sloc),
        cell(row.cyclomatic),
        String(row.cycle),
        String(row.fixes),
        row.bugDensity.toFixed(2),
        String(row.authors),
        row.ownerShare === null ? "-" : `${Math.round(row.ownerShare * 100)}% #${row.ownerRank ?? "?"}`,
        ...HOTSPOT_FAMILIES.map((family) => cell(row.ranks[family])),
        row.path,
      ]),
    ),
  );
  lines.push(
    "ranks: classic = revisions x sloc, branchy = revisions x cyclomatic, " +
      "tangled = revisions of a file in a dependency cycle (CYCLE = its files), " +
      "fragile = revisions x density = fixes; - = not ranked. " +
      "OWNER = the share of the file's added lines its main author wrote, and that author's row in --report authors.",
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

function couplingText(
  history: History,
  report: CoChangeReport,
  top: number,
  options: HistoryOptions,
): readonly string[] {
  const shown = report.rows.slice(0, top);
  const lines = [
    `logical coupling of ${history.repo} ` +
      `(top ${shown.length} of ${report.rows.length} pairs; ` +
      `support >= ${options.minSupport}, confidence >= ${percent(options.minConfidence)}):`,
  ];
  lines.push(
    ...table(
      ["SUPPORT", "CONF", "REV-A", "REV-B", "PAIR"],
      shown.map((row) => [
        String(row.support),
        percent(row.confidence),
        String(row.revisionsA),
        String(row.revisionsB),
        `${row.a} + ${row.b}`,
      ]),
    ),
  );
  return lines;
}

function hiddenText(
  history: History,
  report: HiddenCouplingReport,
  top: number,
): readonly string[] {
  const shown = report.rows.slice(0, top);
  const lines = [
    `hidden coupling of ${history.repo} ` +
      `(top ${shown.length} of ${report.rows.length} co-changed pairs with NO path in the declared graph):`,
  ];
  if (report.rows.length === 0) {
    lines.push("  none — every co-changed pair is explained by a declared dependency path.");
    return lines;
  }
  lines.push(
    ...table(
      ["SUPPORT", "CONF", "PAIR"],
      shown.map((row) => [String(row.support), percent(row.confidence), `${row.a} + ${row.b}`]),
    ),
  );
  return lines;
}

function deadWeightText(
  history: History,
  report: DeadWeightReport,
  top: number,
): readonly string[] {
  const shown = report.rows.slice(0, top);
  const lines = [
    `dead weight of ${history.repo} ` +
      `(top ${shown.length} of ${report.rows.length} declared file dependencies that never co-change):`,
  ];
  if (report.rows.length === 0) {
    lines.push("  none — every declared file dependency has co-changed at least once.");
    return lines;
  }
  lines.push(
    ...table(
      ["EDGES", "REV-FROM", "REV-TO", "DEPENDENCY"],
      shown.map((row) => [
        String(row.edges),
        String(row.revisionsFrom),
        String(row.revisionsTo),
        `${row.from} -> ${row.to}`,
      ]),
    ),
  );
  return lines;
}
