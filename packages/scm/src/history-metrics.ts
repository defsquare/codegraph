import { z } from "zod";

/**
 * `<model>.history-metrics.jsonl` — change history measured AT THE COMMIT A
 * MODEL DESCRIBES (PLAN §18.2): one record per file, from one walk over the
 * whole commit graph, and one per entity, from one blame per file. Written by
 * `codegraph-metrics --history` (big-code-analysis's `vcs` measures).
 *
 * A side-car because evolution facts never enter `model.jsonl` (PLAN §11,
 * principle 1). An entity is named by its natural key, never a rendered id;
 * the CLI joins the two. Section order `header → f* → e* → eof`, files by
 * path and entities by natural key, both strictly ascending: the order is the
 * uniqueness check and what makes two runs over one repository byte-identical.
 */

export const HISTORY_METRICS_KIND = "codegraph.history-metrics/1";

/** Where a measure is defined: a file (the walk), an entity (blame), or both. */
export type HistoryLevel = "file" | "entity";

export interface HistoryMeasure {
  readonly unit: string;
  readonly describe: string;
  readonly levels: readonly HistoryLevel[];
}

/**
 * The measures the pass writes. Windows count back from the commit's own
 * time (`asOf`), never the wall clock. Blame credits a line to the commit
 * that last touched it, so an entity's `lines_*` are SURVIVING lines — a
 * different quantity from a file's `churn_*` (added + deleted), hence a
 * different name. `risk_score` is ordinal: rank by it, never read it.
 */
export const HISTORY_MEASURES: Readonly<Record<string, HistoryMeasure>> = {
  age_days: { unit: "days", describe: "Days since the first commit in the long window (capped at it).", levels: ["file", "entity"] },
  authors_long: { unit: "authors", describe: "Distinct authors in the long window (mailmap-canonical, bots excluded).", levels: ["file", "entity"] },
  authors_recent: { unit: "authors", describe: "Distinct authors in the recent window.", levels: ["file", "entity"] },
  bug_fix_commits: { unit: "commits", describe: "Long-window commits whose message reads as a bug fix.", levels: ["file", "entity"] },
  burst: { unit: "ratio", describe: "commits_recent / commits_long: how much of the activity is recent.", levels: ["file", "entity"] },
  change_entropy_long: { unit: "bits", describe: "Change entropy (Hassan, 2009): how scattered the commits it took part in were.", levels: ["file"] },
  change_entropy_recent: { unit: "bits", describe: "Change entropy over the recent window.", levels: ["file"] },
  churn_long: { unit: "lines", describe: "Lines added plus deleted in the long window.", levels: ["file"] },
  churn_recent: { unit: "lines", describe: "Lines added plus deleted in the recent window.", levels: ["file"] },
  cochange_entropy_long: { unit: "bits", describe: "Co-change entropy: how widely its changes ripple to other files.", levels: ["file"] },
  cochange_entropy_recent: { unit: "bits", describe: "Co-change entropy over the recent window.", levels: ["file"] },
  commits_long: { unit: "commits", describe: "Distinct commits in the long window (an entity: among its surviving lines).", levels: ["file", "entity"] },
  commits_recent: { unit: "commits", describe: "Distinct commits in the recent window.", levels: ["file", "entity"] },
  last_modified_days: { unit: "days", describe: "Days since the most recent commit in the long window.", levels: ["file", "entity"] },
  lines_long: { unit: "lines", describe: "Its lines surviving at the commit, last changed in the long window (blame).", levels: ["entity"] },
  lines_recent: { unit: "lines", describe: "Its surviving lines last changed in the recent window.", levels: ["entity"] },
  ownership_top_share: { unit: "share", describe: "The top author's share of the long window's edits, 0..1.", levels: ["file", "entity"] },
  revert_commits: { unit: "commits", describe: "Long-window commits that revert or roll back.", levels: ["file", "entity"] },
  risk_score: { unit: "rank", describe: "big-code-analysis's weighted risk score — ordinal: rank by it.", levels: ["file", "entity"] },
  security_fix_commits: { unit: "commits", describe: "Long-window commits whose message reads as a security fix.", levels: ["file", "entity"] },
};

/** Finite numbers by measure name; absence means "not measured", never zero. */
const Measures = z.record(z.string().min(1), z.number());

export const HistoryMetricsHeaderRec = z
  .strictObject({
    t: z.literal("header"),
    kind: z.literal(HISTORY_METRICS_KIND),
    generatedBy: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
      bigCodeAnalysis: z.string().min(1),
    }),
    lang: z.string().min(1),
    root: z.string().optional(),
    /** The commit measured at: the model's `repository.commit`, else HEAD. */
    commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    /** That commit's committer time, Unix seconds: every window's "now". */
    asOf: z.int(),
    windowDays: z.strictObject({ long: z.int().min(1), recent: z.int().min(1) }),
  })
  .describe("First record of a history-metrics side-car.");
export type HistoryMetricsHeaderRec = z.infer<typeof HistoryMetricsHeaderRec>;

export const HistoryMetricsFileRec = z.strictObject({
  t: z.literal("f"),
  /** The model's file path (relative to its root), as its anchors spell it. */
  path: z.string().min(1),
  vcs: Measures,
});
export type HistoryMetricsFileRec = z.infer<typeof HistoryMetricsFileRec>;

/** core's natural key, restated: this package depends on zod alone. */
export const HistoryMetricsKey = z.strictObject({
  lang: z.string().min(1),
  module: z.string(),
  symbol: z.string(),
  disambiguator: z.string().optional(),
});
export type HistoryMetricsKey = z.infer<typeof HistoryMetricsKey>;

export const HistoryMetricsEntityRec = z.strictObject({
  t: z.literal("e"),
  key: HistoryMetricsKey,
  vcs: Measures,
});
export type HistoryMetricsEntityRec = z.infer<typeof HistoryMetricsEntityRec>;

export const HistoryMetricsEofRec = z.strictObject({
  t: z.literal("eof"),
  counts: z.strictObject({ files: z.int().min(0), entities: z.int().min(0) }),
});

export interface HistoryMetrics {
  readonly header: Omit<HistoryMetricsHeaderRec, "t">;
  readonly files: readonly Omit<HistoryMetricsFileRec, "t">[];
  readonly entities: readonly Omit<HistoryMetricsEntityRec, "t">[];
}

export class HistoryMetricsError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "HistoryMetricsError";
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The model's canonical order (contract §6): module, symbol, then the disambiguator, absent first. */
function compareKeys(a: HistoryMetricsKey, b: HistoryMetricsKey): number {
  return (
    compareText(a.lang, b.lang) ||
    compareText(a.module, b.module) ||
    compareText(a.symbol, b.symbol) ||
    (a.disambiguator === undefined
      ? b.disambiguator === undefined
        ? 0
        : -1
      : b.disambiguator === undefined
        ? 1
        : compareText(a.disambiguator, b.disambiguator))
  );
}

function sortedMeasures(vcs: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(vcs).sort(compareText)) out[key] = vcs[key] as number;
  return out;
}

/** Strict: section order, canonical order inside each section, the trailer's counts. */
export function decodeHistoryMetricsText(text: string): HistoryMetrics {
  let header: HistoryMetricsHeaderRec | undefined;
  const files: Omit<HistoryMetricsFileRec, "t">[] = [];
  const entities: Omit<HistoryMetricsEntityRec, "t">[] = [];
  let section: "header" | "f" | "e" | "eof" = "header";
  let ended = false;
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const number = index + 1;
    if (raw.trim() === "") continue;
    if (ended) throw new HistoryMetricsError("a record after the eof trailer", number);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HistoryMetricsError("not JSON", number);
    }
    const t = (value as { t?: unknown } | null)?.t;
    const parse = <T>(schema: z.ZodType<T>): T => {
      const result = schema.safeParse(value);
      if (!result.success) throw new HistoryMetricsError(z.prettifyError(result.error), number);
      return result.data;
    };
    if (header === undefined) {
      if (t !== "header") throw new HistoryMetricsError("not a history-metrics side-car (no header first)", number);
      header = parse(HistoryMetricsHeaderRec);
      continue;
    }
    if (t === "f") {
      if (section === "e") throw new HistoryMetricsError("a file record after the entity records", number);
      const { path, vcs } = parse(HistoryMetricsFileRec);
      const previous = files.at(-1);
      if (previous !== undefined && compareText(previous.path, path) >= 0) {
        throw new HistoryMetricsError(`files out of order or repeated at ${path}`, number);
      }
      section = "f";
      files.push({ path, vcs });
    } else if (t === "e") {
      const { key, vcs } = parse(HistoryMetricsEntityRec);
      if (key.lang !== header.lang) throw new HistoryMetricsError(`an entity of ${key.lang} in a ${header.lang} side-car`, number);
      const previous = entities.at(-1);
      if (previous !== undefined && compareKeys(previous.key, key) >= 0) {
        throw new HistoryMetricsError(`entities out of order or repeated at ${key.module}/${key.symbol}`, number);
      }
      section = "e";
      entities.push({ key, vcs });
    } else if (t === "eof") {
      const { counts } = parse(HistoryMetricsEofRec);
      if (counts.files !== files.length || counts.entities !== entities.length) {
        throw new HistoryMetricsError(
          `the trailer counts ${counts.files} files and ${counts.entities} entities, the file holds ${files.length} and ${entities.length}`,
          number,
        );
      }
      section = "eof";
      ended = true;
    } else {
      throw new HistoryMetricsError(`unknown record type ${JSON.stringify(t)}`, number);
    }
  }
  if (header === undefined) throw new HistoryMetricsError("empty: not a history-metrics side-car", 0);
  if (!ended) throw new HistoryMetricsError("no eof trailer: the file is truncated", 0);
  const { t: _t, ...rest } = header;
  return { header: rest, files, entities };
}

/**
 * The canonical bytes: what `codegraph-metrics` writes, so `encode(decode(x))`
 * is `x` for every file it produced (the two-encoder test).
 */
export function encodeHistoryMetrics(metrics: HistoryMetrics): string {
  const { header } = metrics;
  const lines = [
    JSON.stringify({
      t: "header",
      kind: header.kind,
      generatedBy: {
        name: header.generatedBy.name,
        version: header.generatedBy.version,
        bigCodeAnalysis: header.generatedBy.bigCodeAnalysis,
      },
      lang: header.lang,
      ...(header.root === undefined ? {} : { root: header.root }),
      commit: header.commit,
      asOf: header.asOf,
      windowDays: { long: header.windowDays.long, recent: header.windowDays.recent },
    }),
  ];
  const files = [...metrics.files].sort((a, b) => compareText(a.path, b.path));
  for (const { path, vcs } of files) lines.push(JSON.stringify({ t: "f", path, vcs: sortedMeasures(vcs) }));
  const entities = [...metrics.entities].sort((a, b) => compareKeys(a.key, b.key));
  for (const { key, vcs } of entities) {
    const canonicalKey = {
      lang: key.lang,
      module: key.module,
      symbol: key.symbol,
      ...(key.disambiguator === undefined ? {} : { disambiguator: key.disambiguator }),
    };
    lines.push(JSON.stringify({ t: "e", key: canonicalKey, vcs: sortedMeasures(vcs) }));
  }
  lines.push(JSON.stringify({ t: "eof", counts: { files: files.length, entities: entities.length } }));
  return `${lines.join("\n")}\n`;
}
