import { existsSync } from "node:fs";
import { loadSqlite } from "@codegraph/analyzer";
import {
  InsightsStoreError,
  WORD_CONCERNS,
  answerInsight,
  concernsReport,
  polysemyReport,
  sqliteInsightsStore,
  wordReport,
  wordsAbsence,
  type FailureRecord,
  type GlossaryEntry,
  type InsightRecord,
  type InsightRow,
  type InsightsStore,
  type RunRow,
} from "@codegraph/insights";
import type { InsightsOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, outLine, type IoSink } from "../io.js";
import { storePathForModel } from "../insights-paths.js";

/**
 * `codegraph insights [model.jsonl] [--id ID | --level … --concept … | --failures | --runs] [--json]`
 *
 * THE FIRST READER of the insights store (PLAN.md §17.3, M16c). It answers from
 * `<model>.insights.db` alone: the model is never opened (its path only says
 * which store), no side-car is parsed, no provider is resolved — so a question
 * about a 45 MB corpus of explanations costs an index lookup, not a decode.
 *
 * IT WRITES NOTHING. The store is opened as a reader (SQLite's `query_only`),
 * a missing one is a usage error rather than a file that appears, and one this
 * build must not touch is named and left alone — it holds what was paid for.
 *
 * ONE QUESTION PER INVOCATION, each with its own shape: the summary (no flag),
 * a list of ROWS — envelope and description, never blocks — one explanation
 * whole (`--id`), the words (`--word`, `--glossary`, `--polysemy`,
 * `--concerns`: M19c's readers, `glossary.ts`), what is owed (`--failures`),
 * the ledger (`--runs`). stdout is the answer; `--json` makes it one kind-tagged
 * document.
 */
export function insightsCommand(options: InsightsOptions, io: IoSink): ExitCode {
  const path = options.store ?? storePathForModel(options.model);
  const store = openReader(path);
  try {
    switch (options.mode) {
      case "summary":
        return summary(store, path, options, io);
      case "list":
        return list(store, options, io);
      case "one":
        return one(store, options.id ?? "", path, options, io);
      case "word":
        return word(store, options.word ?? "", options, io);
      case "glossary":
        return glossary(store, options.glossary ?? "", path, options, io);
      case "polysemy":
        return polysemy(store, options, io);
      case "concerns":
        return concerns(store, options, io);
      case "failures":
        return failures(store, options, io);
      case "runs":
        return runs(store, options, io);
    }
  } finally {
    store.close();
  }
}

function openReader(path: string): InsightsStore {
  // Checked first: opening a path that does not exist would CREATE it, and asking must not leave a file behind.
  if (!existsSync(path)) {
    throw new UsageError(
      `no insights store at ${path}`,
      "'codegraph explain <model.jsonl>' creates it (and imports a side-car it finds there). Pass --store FILE if it is elsewhere.",
    );
  }
  const db = loadSqlite().open(path);
  try {
    return sqliteInsightsStore(db, { readOnly: true });
  } catch (error) {
    db.close();
    if (!(error instanceof InsightsStoreError)) throw error;
    throw new UsageError(`${path}: ${error.message}`, "Pass --store FILE to read another store.", { cause: error });
  }
}

const plural = (count: number, noun: string, many = `${noun}s`): string => `${count} ${count === 1 ? noun : many}`;
const usd = (cost: number | undefined): string => (cost === undefined ? "" : `, $${cost.toFixed(4)}`);

function summary(store: InsightsStore, path: string, options: InsightsOptions, io: IoSink): ExitCode {
  const stats = store.stats();
  const header = store.header();
  const ledger = store.runs();
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsSummary/1", store: path, header: header ?? null, stats, runs: ledger }));
    return EXIT.OK;
  }
  const lines = [`insights: ${path}`];
  const { byLevel, byOrigin } = stats;
  lines.push(
    `  ${plural(stats.records, "record")}: ${plural(byLevel.operation, "operation")}, ${plural(byLevel.type, "type")}, ${plural(byLevel.module, "module")} ` +
      `(${byOrigin.llm} explained, ${byOrigin.template} templated)`,
  );
  if (header !== undefined) {
    lines.push(`  models: ${header.models.leaf} (operations), ${header.models.rollup} (types, modules); depth ${header.depth}${header.provider === undefined ? "" : `; provider ${header.provider}`}`);
  }
  const concepts = Object.entries(stats.byConcept);
  if (concepts.length > 0) lines.push(`  concepts: ${concepts.map(([name, count]) => `${name} ${count}`).join(", ")}`);
  lines.push(stats.failures === 0 ? "  nothing owed: every unit asked for has a record" : `  ${plural(stats.failures, "failure")} owed — 'codegraph insights --failures' lists them, 'codegraph explain --retry-failed' redoes them`);
  lines.push(`  these records cost ${stats.usage.promptTokens} prompt + ${stats.usage.completionTokens} completion tokens${usd(stats.usage.cost)} (their own usage; failed and replaced calls are in the ledger only)`);
  lines.push(`  ledger: ${ledgerTotal(ledger)}`);
  if (stats.withoutWords > 0) {
    lines.push(`  ${stats.withoutWords} explained under prompt 1, before words were asked: the next 'codegraph explain' re-explains them`);
  }
  const open = ledger.filter((run) => run.finishedAt === undefined);
  if (open.length > 0) lines.push(`  ${plural(open.length, "run")} never finished (still going, or killed): its records are kept`);
  outLine(io, lines.join("\n"));
  return EXIT.OK;
}

/** What the side-car's one trailer could never say: every run's spend, added up. */
function ledgerTotal(ledger: readonly RunRow[]): string {
  if (ledger.length === 0) return "no run recorded (the store was imported from a side-car)";
  let calls = 0;
  let prompt = 0;
  let completion = 0;
  let cost: number | undefined;
  for (const run of ledger) {
    calls += run.counts?.calls ?? 0;
    prompt += run.usage?.promptTokens ?? 0;
    completion += run.usage?.completionTokens ?? 0;
    if (run.usage?.cost !== undefined) cost = (cost ?? 0) + run.usage.cost;
  }
  return `${plural(ledger.length, "run")}, ${plural(calls, "call")}, ${prompt} prompt + ${completion} completion tokens${usd(cost)}`;
}

function list(store: InsightsStore, options: InsightsOptions, io: IoSink): ExitCode {
  const rows = store.query({
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.concept === undefined ? {} : { concept: options.concept }),
    ...(options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence }),
    ...(options.maxConfidence === undefined ? {} : { maxConfidence: options.maxConfidence }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsList/1", rows }));
    return EXIT.OK;
  }
  if (rows.length === 0) {
    errLine(io, "no record matches.");
    return EXIT.OK;
  }
  outLine(io, rows.map(rowLine).join("\n"));
  return EXIT.OK;
}

/** Tab-separated, one record a line: what `cut`, `sort` and a spreadsheet all read. */
function rowLine(row: InsightRow): string {
  const firstLine = row.description.split("\n", 1)[0] ?? "";
  return [row.id, row.concept ?? row.level, row.confidence.toFixed(2), firstLine].join("\t");
}

function one(store: InsightsStore, id: string, path: string, options: InsightsOptions, io: IoSink): ExitCode {
  // The same three answers the page's route gives (`answerInsight`): one rule, whoever asks.
  const answer = answerInsight(store, id);
  switch (answer.status) {
    case "explained":
      outLine(io, options.json ? JSON.stringify(answer.record) : recordText(answer.record));
      return EXIT.OK;
    case "failed":
      // Asked for and left without a record is an answer too — and a finding, not a typo.
      errLine(io, `${id} is not explained: ${failureReason(answer.failure)} (${plural(answer.failure.attempts, "attempt")}, model ${answer.failure.model}).`);
      errLine(io, "Once the cause is dealt with: codegraph explain … --retry-failed");
      return EXIT.FINDINGS;
    case "unknown":
      throw new UsageError(`no explanation for '${id}' in ${path}`, "Ids are the model's rendered entity ids. 'codegraph insights --level type' lists what the store holds.");
  }
}

const ABSENT_WORDS = {
  "prompt-1": "  words: not defined — explained under prompt 1, before words were asked; the next 'codegraph explain' re-explains it",
  templated: "  words: none — templated, no model judged it",
} as const;

function recordText(record: InsightRecord): string {
  const { description, confidence, ...rest } = record.block;
  const concept = typeConcept(record);
  const usage = record.usage === undefined ? undefined : `${record.usage.promptTokens} + ${record.usage.completionTokens} tokens${usd(record.usage.cost)}`;
  const absence = wordsAbsence(record);
  return [
    record.id,
    `  ${[`${record.level} (${record.kind})`, concept, `confidence ${confidence.toFixed(2)}`].filter((part) => part !== undefined).join(" · ")}`,
    `  ${[record.file, record.origin, record.model, usage].filter((part) => part !== undefined).join(" · ")}`,
    ...(absence === undefined ? [] : [ABSENT_WORDS[absence]]),
    "",
    description,
    "",
    JSON.stringify(rest, null, 2),
  ].join("\n");
}

/** The record's own word for what it is; the prompt-facing label ("owned by …") is for prompts. */
function typeConcept(record: InsightRecord): string | undefined {
  return record.level === "type" ? record.block.concept : undefined;
}

function failureReason(failure: FailureRecord): string {
  return `${failure.reason.kind}${failure.reason.status === undefined ? "" : ` ${failure.reason.status}`}: ${failure.reason.message}`;
}

/** What every word answer is blind to, on stderr, where a pipe does not read it. */
function noteWithoutWords(count: number, io: IoSink): void {
  if (count === 0) return;
  errLine(io, `note: ${plural(count, "record")} a model wrote under prompt 1 define${count === 1 ? "s" : ""} no words; the next 'codegraph explain' re-explains ${count === 1 ? "it" : "them"}.`);
}

/** A cell for a placed-nowhere module: a record without a natural key. */
const moduleCell = (module: string | undefined): string => module ?? "-";

/** The types' senses of a word their module flagged; an empty cell when they agree. */
function polysemyCell(entry: GlossaryEntry): string {
  return entry.polysemous ? `polysemous: ${entry.senses.map((s) => `${s.in} "${s.sense}"`).join(" · ")}` : "";
}

/** One tab-separated line per entry, the module first so the grouping survives `sort`: module, what, id, concern, confidence, sense, and the identifiers (or the flag). */
function word(store: InsightsStore, asked: string, options: InsightsOptions, io: IoSink): ExitCode {
  const report = wordReport(store, asked);
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsWord/1", ...report }));
    return EXIT.OK;
  }
  const lines = report.modules.flatMap((group) => [
    ...group.glossary.map((g) => [moduleCell(group.module), "glossary", g.id, g.entry.concern, "", g.entry.sense, polysemyCell(g.entry)].join("\t")),
    ...group.entries.map((e) => [moduleCell(group.module), e.level, e.id, e.entry.concern, e.entry.confidence.toFixed(2), e.entry.sense, e.entry.in.join(", ")].join("\t")),
  ]);
  if (lines.length === 0) errLine(io, `no explained entity defines '${report.word}'.`);
  else outLine(io, lines.join("\n"));
  noteWithoutWords(report.withoutWords, io);
  return EXIT.OK;
}

function glossary(store: InsightsStore, id: string, path: string, options: InsightsOptions, io: IoSink): ExitCode {
  const answer = answerInsight(store, id);
  if (answer.status !== "explained") return one(store, id, path, options, io);
  const record = answer.record;
  if (record.level !== "module") {
    throw new UsageError(`${id} is a ${record.level}: a glossary is a module's`, `'codegraph insights --id ${id}' shows the words its names spell.`);
  }
  const entries = record.block.glossary;
  if (entries === undefined) {
    // A module is never templated; one without a glossary was explained before glossaries were asked.
    const absence = wordsAbsence(record) ?? "prompt-1";
    if (options.json) outLine(io, JSON.stringify({ kind: "codegraph.insightsGlossary/1", id, glossary: null, absence }));
    else errLine(io, `${id} was explained under prompt 1, which asked for no glossary: the next 'codegraph explain' re-explains it.`);
    return EXIT.OK;
  }
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsGlossary/1", id, name: record.name, model: record.model, glossary: entries }));
    return EXIT.OK;
  }
  if (entries.length === 0) errLine(io, `${id}'s glossary is empty: its types spell no word to reconcile.`);
  else outLine(io, entries.map((e) => [e.word, e.concern, e.sense, e.meaning, polysemyCell(e)].join("\t")).join("\n"));
  return EXIT.OK;
}

/** One line per module's entry, grouped by word: word, module, concern, sense, the flag. */
function polysemy(store: InsightsStore, options: InsightsOptions, io: IoSink): ExitCode {
  const report = polysemyReport(store);
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsPolysemy/1", ...report }));
    return EXIT.OK;
  }
  if (report.words.length === 0) errLine(io, "no word has two senses: no module flagged one, and no two modules' glossaries define one differently.");
  else outLine(io, report.words.flatMap((w) => w.entries.map((g) => [w.word, g.id, g.entry.concern, g.entry.sense, polysemyCell(g.entry)].join("\t"))).join("\n"));
  noteWithoutWords(report.withoutWords, io);
  return EXIT.OK;
}

function concerns(store: InsightsStore, options: InsightsOptions, io: IoSink): ExitCode {
  const report = concernsReport(store);
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsConcerns/1", ...report }));
    return EXIT.OK;
  }
  if (report.modules.length === 0) errLine(io, "no explained entity defines a word.");
  else outLine(io, report.modules.map((m) => [moduleCell(m.module), plural(m.words, "word"), ...WORD_CONCERNS.map((c) => `${m.concerns[c]} ${c}`)].join("\t")).join("\n"));
  noteWithoutWords(report.withoutWords, io);
  return EXIT.OK;
}

function failures(store: InsightsStore, options: InsightsOptions, io: IoSink): ExitCode {
  const owed = store.failures();
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsFailures/1", failures: owed }));
    return EXIT.OK;
  }
  if (owed.length === 0) {
    errLine(io, "nothing owed: every unit asked for has a record.");
    return EXIT.OK;
  }
  outLine(
    io,
    owed
      .map((f) => [f.id, f.level, `${f.reason.kind}${f.reason.status === undefined ? "" : ` ${f.reason.status}`}`, plural(f.attempts, "attempt"), f.reason.message.split("\n", 1)[0] ?? ""].join("\t"))
      .join("\n"),
  );
  return EXIT.OK;
}

function runs(store: InsightsStore, options: InsightsOptions, io: IoSink): ExitCode {
  const ledger = store.runs();
  if (options.json) {
    outLine(io, JSON.stringify({ kind: "codegraph.insightsRuns/1", runs: ledger }));
    return EXIT.OK;
  }
  if (ledger.length === 0) {
    errLine(io, "no run recorded (the store was imported from a side-car).");
    return EXIT.OK;
  }
  outLine(io, ledger.map(runLine).join("\n"));
  return EXIT.OK;
}

function runLine(run: RunRow): string {
  const models = run.models.leaf === run.models.rollup ? run.models.leaf : `${run.models.leaf}, ${run.models.rollup}`;
  const did = run.counts === undefined ? "never finished" : `${run.counts.llm} explained, ${run.counts.template} templated, ${run.counts.reused} reused, ${run.counts.failed} failed`;
  const spent = run.usage === undefined ? "" : `${plural(run.counts?.calls ?? 0, "call")}, ${run.usage.promptTokens} + ${run.usage.completionTokens} tokens${usd(run.usage.cost)}`;
  return [`#${run.id}`, `${run.startedAt} → ${run.finishedAt ?? "…"}`, models, `${did}${run.aborted === undefined ? "" : ` (${run.aborted})`}`, spent].join("\t");
}
