import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelBuilder, readModelRecordsSync } from "@codegraph/core";
import { FRAMEWORK_PROFILES, buildDomainFacts, folderFor, loadSqlite } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  InsightsStoreError,
  PROMPT_VERSION,
  buildWalk,
  collectUnits,
  createSourceReader,
  decodeInsights,
  decodeJournal,
  executeRun,
  insightsStorePathFor,
  mergeRecords,
  planRun,
  recordsById,
  retryScope,
  sqliteInsightsStore,
  type Completer,
  type FailureRecord,
  type InsightRecord,
  type InsightsEof,
  type InsightsFile,
  type InsightsHeader,
  type InsightsStore,
  type OpenRun,
  type PlanEnv,
  type RecordKey,
  type RunPlan,
  type RunUsage,
  type Unit,
} from "@codegraph/insights";
import { clientFromEnv, resolveProvider, type LlmClient, type Provider } from "@codegraph/llm";
import type { ExplainOptions } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, errLines, outLine, type IoSink } from "../io.js";
import { openAnalysis } from "../source.js";
import { resolveView } from "../view.js";

/**
 * `codegraph explain [model.jsonl] [--src DIR] [--out FILE] [--model SLUG] …`
 *
 * THE ONE ASYNC COMMAND (main.ts): it awaits a model provider. Everything
 * that is not the network is still the pipeline's usual shape — load, view,
 * dossiers — followed by `@codegraph/insights`: units, walk order, plan, run.
 * This file only resolves flags, moves bytes and narrates.
 *
 * THE STORE IS THE WORKING COPY (PLAN.md §17): `<model>.insights.db` beside
 * the side-car. Every finished unit is one committed transaction and every
 * failure is written when it happens, so an interrupted run is resumed, not
 * repeated — records AND failures. `--retry-failed` takes its scope from the
 * store's failure rows. Unlike `model.db` it is NOT a cache: nothing in it can
 * be recomputed, so it is never rebuilt, never bypassed, and a store this build
 * must not touch is a usage error naming it.
 *
 * THE SIDE-CAR IS THE ARTIFACT, a FILE, not stdout — and it is the store's
 * EXPORT: written once, atomically, when a run ends (`--export` on demand).
 * A side-car found with no store beside it is imported on the first run that
 * writes; one edited outside is noticed and named, and taken only by
 * `--import`. stdout stays empty unless `--dry-run` (the plan) or `--json`
 * (the summary) asks for it.
 *
 * SPENDING IS CONFIRMED: a run that plans model calls prints its token
 * estimate on stderr and asks before the first call; `--yes` skips the
 * question, and with no terminal to ask on the run refuses rather than spends.
 *
 * THE SEAM: environment, filesystem, clock, the client factory and the
 * question come in one object, so the whole command runs in-process against a
 * fake model with no network and no disk (test/explain.test.ts).
 */

export interface ExplainFs {
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
  /** What an outside edit of the side-car is measured by (the M7 staleness test, opposite consequence). */
  stat(path: string): { size: number; mtimeMs: number } | undefined;
  /** Whole-file replace that a crash cannot leave half-written. */
  writeFileAtomic(path: string, text: string): void;
  remove(path: string): void;
}

export interface ExplainStores {
  /** Throws when this runtime has no SQLite — asked BEFORE anything is priced. */
  check(): void;
  exists(path: string): boolean;
  /** Opens the store at `path`, creating it if absent; throws `InsightsStoreError` for one it must not touch. */
  open(path: string): InsightsStore;
}

export interface ExplainSeam {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ExplainFs;
  readonly stores: ExplainStores;
  /** This process, recorded on the run so a later one can tell a live writer from a dead one. */
  readonly pid: number;
  isAlive(pid: number): boolean;
  /** The client for a RESOLVED provider whose variables are all present in `env`. */
  clientFor(provider: Provider, env: Readonly<Record<string, string | undefined>>): LlmClient;
  now(): Date;
  /** Asks a yes/no question; undefined when there is no interactive terminal to ask on. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
}

export function realSeam(): ExplainSeam {
  return {
    env: process.env,
    fs: {
      exists: (path) => existsSync(path),
      readFile: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      },
      stat: (path) => {
        try {
          const { size, mtimeMs } = statSync(path);
          return { size, mtimeMs };
        } catch {
          return undefined;
        }
      },
      writeFileAtomic: (path, text) => {
        const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, path);
      },
      remove: (path) => rmSync(path, { force: true }),
    },
    stores: {
      check: () => void loadSqlite(),
      exists: (path) => existsSync(path),
      open: (path) => {
        const db = loadSqlite().open(path);
        try {
          return sqliteInsightsStore(db);
        } catch (error) {
          db.close();
          throw error;
        }
      },
    },
    pid: process.pid,
    // EPERM means a process we may not signal: alive, and not ours.
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    clientFor: (provider, env) => clientFromEnv(provider, env),
    now: () => new Date(),
    confirm: process.stdin.isTTY && process.stderr.isTTY ? confirmOnTerminal : undefined,
  };
}

/** The prompt goes to stderr: stdout is the artifact stream, even when nothing is on it. */
async function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/iu.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}


export async function explainCommand(
  options: ExplainOptions,
  io: IoSink,
  seam: ExplainSeam = realSeam(),
): Promise<ExitCode> {
  const out = options.out ?? sidecarPathFor(options.models[0] ?? "model.jsonl");
  const storePath = insightsStorePathFor(out);
  // Neither reads a model: they move records between the store and its side-car.
  if (options.exportOnly) return exportOnly(out, storePath, seam, io);
  if (options.importFrom !== undefined) return importOnly(options.importFrom, out, storePath, options, seam, io);

  const source = openAnalysis(options.models, options, io);
  let store: InsightsStore | undefined;
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const profile = options.framework === undefined ? undefined : FRAMEWORK_PROFILES[options.framework];
    const facts = buildDomainFacts(graph, { view, ...(profile === undefined ? {} : { framework: profile }) });
    const units = collectUnits(graph, facts);
    const walk = buildWalk(units, graph, view);

    const srcRoot = resolveSourceRoot(options, graph.union.models[0]?.root, units, seam);
    const reader = createSourceReader((relative) => seam.fs.readFile(join(srcRoot, relative)));
    const env: PlanEnv = { graph, facts, units, reader, unitOf: walk.unitOf };

    const journal = `${out}.journal`;
    const loaded = loadExisting(out, storePath, journal, seam, io);
    store = loaded.store;
    const { records: existing, header: previous, failures: previousFailures } = loaded;
    if (options.retryFailed) {
      if (previous === undefined) {
        throw new UsageError(
          `--retry-failed found no insights store at ${storePath} and no side-car at ${out}`,
          "It redoes the failures a previous run recorded there. Pass --out FILE if the side-car is elsewhere, or drop --retry-failed for a first run.",
        );
      }
      if (previousFailures.length === 0) {
        errLine(io, `nothing to retry: ${out} records no failure.`);
        return source.clean ? EXIT.OK : EXIT.FINDINGS;
      }
      errLines(io, retryLines(previousFailures, previous, options));
    }

    const plan = planRun(walk, existing, env, {
      models: { leaf: options.model, rollup: options.rollupModel },
      depth: options.depth,
      maxLines: options.maxLines,
      maxScc: options.maxScc,
      force: options.force,
      maxCalls: options.maxCalls,
      inScope: options.retryFailed ? retryScope(previousFailures, walk) : scopePredicate(options.scope, graph, units),
    });

    if (!source.clean) {
      errLine(io, "warning: the models are not clean; the walk was built anyway.");
      errLine(io, `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`);
    }

    if (options.estimate) {
      printEstimate(plan, options, io);
      return source.clean ? EXIT.OK : EXIT.FINDINGS;
    }
    if (options.dryRun) {
      printPlan(plan, options, io);
      return source.clean ? EXIT.OK : EXIT.FINDINGS;
    }

    // No SQLite, no explain — said before anything is priced, asked or called (there is no JSONL fallback).
    try {
      seam.stores.check();
    } catch (error) {
      throw new UsageError(
        `explain needs SQLite for its store (${storePath}), and this runtime has none`,
        `Node's SQLite builtin ships from Node 22.5.0 and is absent from builds configured --without-sqlite (${error instanceof Error ? error.message : String(error)}). --dry-run and --estimate still work on a side-car.`,
        { cause: error },
      );
    }
    const { complete, provider } = completerFor(plan, options, seam, io);
    if (!(await confirmed(plan, options, seam, io))) {
      errLine(io, "aborted: no call was made, nothing was written.");
      return EXIT.OK;
    }
    const keyOf = naturalKeys(options.models, io);
    // A run that makes no call (everything reused) keeps saying who served the records.
    const header = headerFor(options, provider ?? previous?.provider, graph.union.langs, view.descriptor.name, view.descriptor.filters);
    const total = plan.steps.length;
    let done = 0;

    // From here the run WRITES: the store comes to exist, takes in what predates it, and closes what died.
    store ??= openStore(storePath, seam);
    const writing = store;
    if (loaded.legacy !== undefined) {
      writing.importFile({ ...loaded.legacy, header: loaded.legacy.header ?? header });
      const stamp = seam.fs.stat(out);
      if (stamp !== undefined) writing.markExported({ path: out, ...stamp });
      seam.fs.remove(journal);
      errLine(io, `note: imported ${loaded.legacy.records.length} record${loaded.legacy.records.length === 1 ? "" : "s"} from ${seam.fs.exists(out) ? out : journal} into ${storePath}; the store is the working copy from now on, the side-car its export.`);
    }
    for (const dead of loaded.interrupted) writing.closeRun(dead.id, "interrupted");
    const run = writing.beginRun({ header, startedAt: seam.now().toISOString(), pid: seam.pid });

    const result = await executeRun(plan, env, existing, complete, { maxScc: options.maxScc, depth: options.depth, maxLines: options.maxLines, previousFailures, ...(keyOf === undefined ? {} : { keyOf }) }, {
      concurrency: options.concurrency,
      onUnit: (records, step) => writing.putUnit(run, step.unit.id, records),
      onFailure: (failure) => writing.fail(run, failure),
      onStep: (event) => {
        done += 1;
        const { unit } = event.step;
        const tag = `[${done}/${total}]`;
        const what = `${unit.level} ${unit.id}${unit.members.length > 1 ? ` (+${unit.members.length - 1} in cycle)` : ""}`;
        if (event.outcome === "failed") errLine(io, `${tag} ${what}: FAILED ${event.error ?? ""}`);
        else if (event.aborted === true) errLine(io, `${tag} ${what}: not attempted (run aborted)`);
        else if (event.step.status === "llm") errLine(io, `${tag} ${what}: ${event.calls} call${event.calls === 1 ? "" : "s"}, ${event.usage.promptTokens}+${event.usage.completionTokens} tokens`);
        else errLine(io, `${tag} ${what}: ${event.step.status}`);
      },
    });

    // `failed` in the trailer is the number of failure records in the body, carried-over ones included.
    const written = { counts: { ...result.counts, failed: result.failures.length }, usage: result.usage };
    const { aborted } = result;
    writing.finishRun(run, {
      eof: eofFor(written, seam),
      failures: result.failures,
      calls: result.counts.calls,
      ...(aborted === undefined ? {} : { aborted: `${aborted.reason.status ?? aborted.reason.kind}: ${aborted.reason.message}` }),
    });
    writeExport(writing, out, seam);

    const misses = reader.misses();
    if (misses.length > 0) {
      errLine(io, `warning: ${misses.length} source file${misses.length === 1 ? "" : "s"} not found under ${srcRoot} (first: ${misses[0]}); those units were explained from facts alone.`);
    }
    errLines(io, summaryLines(out, result, options));
    if (options.json) {
      outLine(io, JSON.stringify({ kind: "codegraph.explainSummary/1", out, counts: result.counts, usage: result.usage, failures: result.failures, ...(result.aborted === undefined ? {} : { aborted: result.aborted }) }));
    }
    if (result.failures.length > 0) return EXIT.FINDINGS;
    return source.clean ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    store?.close();
    source.close();
  }
}

/** A store this build must not touch (newer, or not ours) is the user's to sort out — named, never replaced. */
function openStore(storePath: string, seam: ExplainSeam): InsightsStore {
  try {
    return seam.stores.open(storePath);
  } catch (error) {
    if (!(error instanceof InsightsStoreError)) throw error;
    throw new UsageError(
      `${storePath}: ${error.message}`,
      "The insights store holds explanations that were paid for, so it is never rebuilt. Upgrade codegraph, or pass --out FILE to work beside another side-car.",
      { cause: error },
    );
  }
}

/** The side-car, whole and atomic, from the store — and the stamp an outside edit is later measured against. */
function writeExport(store: InsightsStore, out: string, seam: ExplainSeam): void {
  seam.fs.writeFileAtomic(out, `${[...store.export()].join("\n")}\n`);
  const stamp = seam.fs.stat(out);
  if (stamp !== undefined) store.markExported({ path: out, ...stamp });
}

/** Runs with no end. A live writer is a refusal; a dead one is a resume, closed once this run starts writing. */
function interruptedRuns(store: InsightsStore, storePath: string, seam: ExplainSeam, io: IoSink): OpenRun[] {
  const open = store.openRuns();
  for (const run of open) {
    if (run.pid !== undefined && run.pid !== seam.pid && seam.isAlive(run.pid)) {
      throw new UsageError(
        `another explain (pid ${run.pid}, started ${run.startedAt}) is writing to ${storePath}`,
        "Two runs on one store would pay twice for the same units. Wait for it, or stop it and run again: what it committed is kept.",
      );
    }
    errLine(io, `note: the run started ${run.startedAt} was interrupted; its ${run.records} record${run.records === 1 ? "" : "s"} and its failures are kept and reused ('--export' writes the side-car as it stands).`);
  }
  return open;
}

function decodeSidecar(path: string, text: string): InsightsFile {
  try {
    return decodeInsights(text);
  } catch (error) {
    throw new UsageError(
      `${path} is not a ${INSIGHTS_KIND} side-car: ${error instanceof Error ? error.message : String(error)}`,
      "Pass --out FILE to write elsewhere, or remove the file to start over.",
      { cause: error },
    );
  }
}

/** `--export`: the side-car as the store stands — after an interrupted run, or a deleted file. */
function exportOnly(out: string, storePath: string, seam: ExplainSeam, io: IoSink): ExitCode {
  if (!seam.stores.exists(storePath)) {
    throw new UsageError(`--export found no insights store at ${storePath}`, "A run of 'codegraph explain' creates it. Pass --out FILE if the side-car is elsewhere.");
  }
  const store = openStore(storePath, seam);
  try {
    if (store.isEmpty()) throw new UsageError(`--export: the insights store at ${storePath} is empty`, "Run 'codegraph explain' first.");
    interruptedRuns(store, storePath, seam, io);
    writeExport(store, out, seam);
    const records = store.fingerprints().size;
    const failed = store.failures().length;
    errLine(io, `wrote ${records} record${records === 1 ? "" : "s"}${failed === 0 ? "" : ` and ${failed} failure${failed === 1 ? "" : "s"}`} to ${out} from ${storePath}.`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

/** `--import FILE`: the one way a side-car overrides the store. It REPLACES paid-for content, so it asks. */
async function importOnly(from: string, out: string, storePath: string, options: ExplainOptions, seam: ExplainSeam, io: IoSink): Promise<ExitCode> {
  const text = seam.fs.readFile(from);
  if (text === undefined) throw new UsageError(`--import cannot read ${from}`, "Pass the path of a side-car (.insights.jsonl).");
  const file = decodeSidecar(from, text);
  const store = openStore(storePath, seam);
  try {
    interruptedRuns(store, storePath, seam, io);
    const held = store.fingerprints().size;
    if (held > 0 && !options.yes) {
      if (seam.confirm === undefined) {
        throw new UsageError(
          `--import would replace the ${held} record${held === 1 ? "" : "s"} in ${storePath}, and there is no terminal to confirm on`,
          "Pass --yes to replace them without asking. '--export --out BACKUP' first keeps a copy.",
        );
      }
      if (!(await seam.confirm(`Replace the ${held} record${held === 1 ? "" : "s"} in ${storePath} with the ${file.records.length} of ${from}? [y/N] `))) {
        errLine(io, "aborted: the store was left as it was.");
        return EXIT.OK;
      }
    }
    store.importFile(file);
    // Imported from its own side-car, the two agree: no "changed outside" warning next time.
    const stamp = resolve(from) === resolve(out) ? seam.fs.stat(out) : undefined;
    if (stamp !== undefined) store.markExported({ path: out, ...stamp });
    errLine(io, `imported ${file.records.length} record${file.records.length === 1 ? "" : "s"}${file.failures.length === 0 ? "" : ` and ${file.failures.length} failure${file.failures.length === 1 ? "" : "s"}`} from ${from} into ${storePath}${file.truncated ? " (the file was cut short)" : ""}.`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

export function sidecarPathFor(modelPath: string): string {
  return modelPath.endsWith(".jsonl") ? `${modelPath.slice(0, -".jsonl".length)}.insights.jsonl` : `${modelPath}.insights.jsonl`;
}

/**
 * `--src`, or the model's recorded root. Probed against the first anchor so a
 * mismatch is a usage error naming the path, not thousands of "source
 * unavailable" prompts paid for.
 */
function resolveSourceRoot(
  options: ExplainOptions,
  modelRoot: string | undefined,
  units: ReturnType<typeof collectUnits>,
  seam: ExplainSeam,
): string {
  const root = resolve(options.src ?? modelRoot ?? ".");
  const firstAnchor = [...units.operations.values()].find((u) => u.fact.anchor !== undefined)?.fact.anchor?.file
    ?? [...units.types.values()].find((t) => t.anchor !== undefined)?.anchor?.file;
  if (firstAnchor !== undefined && !seam.fs.exists(join(root, firstAnchor))) {
    throw new UsageError(
      `source root ${root} does not contain ${firstAnchor}`,
      options.src === undefined
        ? `The model's root is '${modelRoot ?? "."}', resolved against the current directory. Pass --src DIR pointing at the tree the model was extracted from.`
        : "Pass --src DIR pointing at the tree the model was extracted from (the anchors are relative to it).",
    );
  }
  return root;
}

interface Existing {
  readonly records: Map<string, InsightRecord>;
  readonly header: InsightsHeader | undefined;
  readonly failures: readonly FailureRecord[];
  /** Open when a store already exists; a run that gets to write opens (creates) it otherwise. */
  readonly store: InsightsStore | undefined;
  /** What predates the store — a side-car, an older build's journal — to import once this run writes. */
  readonly legacy: (Omit<InsightsFile, "header"> & { header: InsightsHeader | undefined }) | undefined;
  readonly interrupted: readonly OpenRun[];
}

/**
 * What is already explained. The STORE when there is one — a side-car beside
 * it is only checked for an outside edit; otherwise the side-car (and an older
 * build's journal), read WITHOUT creating a store: `--dry-run` and
 * `--estimate` write nothing, and the import waits for a run that does.
 */
function loadExisting(out: string, storePath: string, journal: string, seam: ExplainSeam, io: IoSink): Existing {
  const store = seam.stores.exists(storePath) ? openStore(storePath, seam) : undefined;
  if (store !== undefined && !store.isEmpty()) {
    try {
      const interrupted = interruptedRuns(store, storePath, seam, io);
      const stamp = store.exported();
      const found = seam.fs.stat(out);
      if (found !== undefined && (stamp === undefined || stamp.size !== found.size || stamp.mtimeMs !== found.mtimeMs)) {
        errLine(io, `warning: ${out} changed outside codegraph since it was last exported; the store (${storePath}) is the working copy and this run will overwrite the file.`);
        errLine(io, `To take the file instead: codegraph explain … --import ${out}`);
      }
      return { records: recordsById(store.records()), header: store.header(), failures: store.failures(), store, legacy: undefined, interrupted };
    } catch (error) {
      store.close();
      throw error;
    }
  }

  let base: InsightsFile | undefined;
  const text = seam.fs.exists(out) ? seam.fs.readFile(out) : undefined;
  if (text !== undefined && text.trim() !== "") {
    base = decodeSidecar(out, text);
    if (base.truncated) errLine(io, `note: ${out} was cut short; its ${base.records.length} records are reused, the rest redone.`);
  }
  let extra: InsightRecord[] = [];
  if (seam.fs.exists(journal)) {
    const { records, dropped } = decodeJournal(seam.fs.readFile(journal) ?? "");
    extra = records;
    errLine(io, `note: resuming from ${journal}, left by an older codegraph (${records.length} record${records.length === 1 ? "" : "s"}${dropped === 0 ? "" : `, ${dropped} unreadable line${dropped === 1 ? "" : "s"} dropped`}).`);
  }
  const records = mergeRecords(base?.records ?? [], extra);
  const legacy =
    base === undefined && extra.length === 0
      ? undefined
      : // Journal records make the trailer's counts stale: imported as cut short, which it was.
        { header: base?.header, records, failures: base?.failures ?? [], eof: extra.length === 0 ? base?.eof : undefined, truncated: base?.truncated ?? true };
  return { records: recordsById(records), header: base?.header, failures: base?.failures ?? [], store, legacy, interrupted: [] };
}

/**
 * What a retry is about to redo, and a warning when it would not match the
 * run that failed: model and depth are part of every fingerprint, so a retried
 * unit explained under others is redone again by the next plain run.
 */
function retryLines(failures: readonly FailureRecord[], previous: InsightsHeader, options: ExplainOptions): string[] {
  const lines = [`retrying ${failures.length} failed unit${failures.length === 1 ? " and its" : "s and their"} direct dependents:`];
  const byReason = new Map<string, number>();
  for (const failure of failures) {
    const reason = `${failure.reason.kind}${failure.reason.status === undefined ? "" : ` ${failure.reason.status}`}: ${failure.reason.message}`;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5)) {
    lines.push(`  ${count} × ${reason.length > 160 ? `${reason.slice(0, 157)}...` : reason}`);
  }
  if (byReason.size > 5) lines.push(`  … and ${byReason.size - 5} more reason${byReason.size - 5 === 1 ? "" : "s"}`);
  const was = `${previous.models.leaf}, ${previous.models.rollup}, depth ${previous.depth}`;
  const now = `${options.model}, ${options.rollupModel}, depth ${options.depth}`;
  if (was !== now) lines.push(`note: the side-car was written with ${was}; this retry uses ${now}, so a later run under the old settings redoes these units.`);
  return lines;
}

function scopePredicate(
  scope: readonly string[],
  graph: ReturnType<ReturnType<typeof openAnalysis>["graph"]>,
  units: ReturnType<typeof collectUnits>,
): ((unit: Unit) => boolean) | undefined {
  if (scope.length === 0) return undefined;
  const wanted = new Set(scope);
  const unknown = scope.filter((id) => !graph.has(id));
  if (unknown.length > 0) {
    throw new UsageError(
      `--scope names ${unknown.length === 1 ? "an id" : "ids"} the model does not declare: ${unknown.join(", ")}`,
      "Scope takes module or type ids exactly as the model renders them (see 'codegraph export --format json').",
    );
  }
  const folder = folderFor(graph);
  void units;
  return (unit) =>
    unit.members.some((m) => wanted.has(m) || wanted.has(folder.containingType(m) ?? "") || wanted.has(folder.containingModule(m) ?? ""));
}

/**
 * The provider: `--provider` or, on `auto`, whichever of OpenRouter / Cloudflare
 * AI Gateway the environment configures. Resolved BEFORE any call, so a
 * missing variable is a usage error naming it — never a failed first request.
 */
function completerFor(
  plan: RunPlan,
  options: ExplainOptions,
  seam: ExplainSeam,
  io: IoSink,
): { complete: Completer; provider: Provider | undefined } {
  if (plan.estimates.calls === 0) return { complete: () => Promise.reject(new Error("no call was planned")), provider: undefined };
  const resolution = resolveProvider(options.provider, seam.env);
  if (resolution.missing.length > 0) {
    const calls = `${plan.estimates.calls} model call${plan.estimates.calls === 1 ? "" : "s"}`;
    const setup =
      resolution.provider === "cloudflare"
        ? "CLOUDFLARE_API_TOKEN needs the AI Gateway Run permission (wrangler auth token); CLOUDFLARE_AI_GATEWAY_ID is optional (the account's default gateway otherwise)."
        : "Create one at https://openrouter.ai/keys, or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to route through Cloudflare AI Gateway.";
    throw new UsageError(
      `${resolution.missing.join(" and ")} ${resolution.missing.length === 1 ? "is" : "are"} not set (${resolution.reason}), and this run needs ${calls}`,
      `${setup} Add --dry-run to see the plan without calling. Models: ${options.model}${options.rollupModel === options.model ? "" : `, ${options.rollupModel}`}.`,
    );
  }
  const client = seam.clientFor(resolution.provider, seam.env);
  errLine(io, `provider: ${client.name} (${resolution.reason})`);
  const complete: Completer = async (request) => {
    const response = await client.complete({
      model: request.model,
      system: request.system,
      user: request.user,
      schema: { name: request.schemaName, jsonSchema: request.jsonSchema },
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
    return { json: response.json, model: response.model, ...(response.usage === undefined ? {} : { usage: response.usage }) };
  };
  return { complete, provider: resolution.provider };
}

/**
 * The natural key per rendered id, from the model files themselves (the
 * in-memory graph keeps only rendered ids). Best effort: a model that cannot
 * be re-read simply yields records without `key`.
 */
function naturalKeys(paths: readonly string[], io: IoSink): ((id: string) => RecordKey | undefined) | undefined {
  const keys = new Map<string, RecordKey>();
  for (const path of paths) {
    try {
      const builder = new ModelBuilder();
      for (const record of readModelRecordsSync(path)) builder.add(record);
      const model = builder.finish();
      builder.keys.forEach((key, index) => {
        const id = model.entities[index]?.id;
        if (id === undefined) return;
        keys.set(id, {
          lang: key.lang,
          module: key.module,
          symbol: key.symbol,
          ...(key.disambiguator === undefined ? {} : { disambiguator: key.disambiguator }),
        });
      });
    } catch (error) {
      errLine(io, `note: could not read natural keys from ${path} (${error instanceof Error ? error.message : String(error)}); records carry rendered ids only.`);
    }
  }
  return keys.size === 0 ? undefined : (id) => keys.get(id);
}

function headerFor(
  options: ExplainOptions,
  provider: string | undefined,
  langs: readonly string[],
  viewName: string,
  filters: readonly string[],
): InsightsHeader {
  return {
    t: "header",
    kind: INSIGHTS_KIND,
    generatedBy: INSIGHTS_GENERATOR,
    promptVersion: PROMPT_VERSION,
    metamodel: INSIGHTS_METAMODEL,
    models: { leaf: options.model, rollup: options.rollupModel },
    ...(provider === undefined ? {} : { provider }),
    depth: options.depth,
    source: { paths: [...options.models], langs: [...langs], view: { name: viewName, filters: [...filters] } },
  };
}

function eofFor(
  result: { counts: { records: number; llm: number; template: number; reused: number; failed: number }; usage: RunUsage },
  seam: ExplainSeam,
): InsightsEof {
  return {
    t: "eof",
    counts: {
      records: result.counts.records,
      llm: result.counts.llm,
      template: result.counts.template,
      reused: result.counts.reused,
      failed: result.counts.failed,
    },
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      ...(result.usage.cost === undefined ? {} : { cost: result.usage.cost }),
    },
    generatedAt: seam.now().toISOString(),
  };
}

function printPlan(plan: RunPlan, options: ExplainOptions, io: IoSink): void {
  const { estimates } = plan;
  if (options.json) {
    outLine(
      io,
      JSON.stringify({
        kind: "codegraph.explainPlan/1",
        models: { leaf: options.model, rollup: options.rollupModel },
        depth: options.depth,
        estimates,
        steps: plan.steps.map((s) => ({
          id: s.unit.id,
          level: s.unit.level,
          members: s.unit.members,
          layer: s.unit.layer,
          status: s.status,
          model: s.model,
          calls: s.calls,
          promptTokens: s.promptTokens,
        })),
      }),
    );
    return;
  }
  const lines: string[] = [];
  lines.push(`explain plan: ${plan.steps.length} units in ${(plan.steps[plan.steps.length - 1]?.unit.layer ?? -1) + 1} layers`);
  for (const level of ["operation", "type", "module"] as const) {
    const e = estimates.byLevel[level];
    lines.push(`  ${level.padEnd(9)} ${String(e.units).padStart(6)} units ${String(e.calls).padStart(6)} calls ~${e.promptTokens} prompt tokens`);
  }
  lines.push(`  statuses: llm ${estimates.byStatus.llm}, template ${estimates.byStatus.template}, reuse ${estimates.byStatus.reuse}, skip-scope ${estimates.byStatus["skip-scope"]}, skip-budget ${estimates.byStatus["skip-budget"]}`);
  lines.push(`  models: ${options.model} (operations), ${options.rollupModel} (types, modules); depth ${options.depth}`);
  lines.push(`  total: ${estimates.calls} calls, ~${estimates.promptTokens} prompt tokens in, ~${estimates.completionTokens} completion tokens out`);
  lines.push("");
  for (const step of plan.steps) {
    const cycle = step.unit.members.length > 1 ? ` cycle(${step.unit.members.length})` : "";
    lines.push(`${step.status.padEnd(11)} L${step.unit.layer} ${step.unit.level.padEnd(9)} ${step.unit.id}${cycle}${step.calls === 0 ? "" : ` calls=${step.calls} ~${step.promptTokens}tok`}`);
  }
  outLine(io, lines.join("\n"));
}

/** A thousands-grouped integer, locale-independent. */
function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
}

/** Cost in USD from per-million prices; undefined until both prices are given. */
export function estimatedCost(promptTokens: number, completionTokens: number, priceIn: number | undefined, priceOut: number | undefined): number | undefined {
  if (priceIn === undefined || priceOut === undefined) return undefined;
  return (promptTokens * priceIn + completionTokens * priceOut) / 1_000_000;
}

/**
 * `--estimate`: the volume a run would move, before spending anything. Input
 * is the rendered prompts at ~4 chars/token; output is one measured block
 * average per block asked for. Repair re-asks and rate-limit retries are not
 * included, and a run that reuses records sends less than a cold one.
 */
function printEstimate(plan: RunPlan, options: ExplainOptions, io: IoSink): void {
  const { estimates } = plan;
  const cost = estimatedCost(estimates.promptTokens, estimates.completionTokens, options.priceIn, options.priceOut);
  const layers = (plan.steps[plan.steps.length - 1]?.unit.layer ?? -1) + 1;
  if (options.json) {
    outLine(
      io,
      JSON.stringify({
        kind: "codegraph.explainEstimate/1",
        models: { leaf: options.model, rollup: options.rollupModel },
        depth: options.depth,
        units: plan.steps.length,
        layers,
        calls: estimates.calls,
        promptTokens: estimates.promptTokens,
        completionTokens: estimates.completionTokens,
        byLevel: estimates.byLevel,
        byStatus: estimates.byStatus,
        ...(options.priceIn === undefined ? {} : { priceIn: options.priceIn }),
        ...(options.priceOut === undefined ? {} : { priceOut: options.priceOut }),
        ...(cost === undefined ? {} : { cost }),
        assumptions: {
          promptTokens: "characters of the rendered prompts / 4",
          completionTokens: "measured block averages: operation 450, type 650, module 900 tokens, per block asked for",
          excluded: "repair re-asks, rate-limit retries",
        },
      }),
    );
    return;
  }
  outLine(io, estimateLines(plan, options).join("\n"));
}

function estimateLines(plan: RunPlan, options: ExplainOptions): string[] {
  const { estimates } = plan;
  const cost = estimatedCost(estimates.promptTokens, estimates.completionTokens, options.priceIn, options.priceOut);
  const layers = (plan.steps[plan.steps.length - 1]?.unit.layer ?? -1) + 1;
  const lines: string[] = [];
  lines.push(`explain estimate: ${options.models.join(" ")}`);
  const b = estimates.byLevel;
  lines.push(`  units: ${plan.steps.length} (operation ${b.operation.units}, type ${b.type.units}, module ${b.module.units}) in ${layers} layers`);
  lines.push(`  calls: ${estimates.calls} (template ${estimates.byStatus.template}, reuse ${estimates.byStatus.reuse}, skipped ${estimates.byStatus["skip-scope"] + estimates.byStatus["skip-budget"]})`);
  lines.push(`  models: ${options.model} (operations), ${options.rollupModel} (types, modules); depth ${options.depth}`);
  lines.push("");
  lines.push(`  ${"level".padEnd(10)} ${"calls".padStart(7)} ${"input tokens".padStart(14)} ${"output tokens".padStart(14)}`);
  for (const level of ["operation", "type", "module"] as const) {
    const e = b[level];
    lines.push(`  ${level.padEnd(10)} ${grouped(e.calls).padStart(7)} ${grouped(e.promptTokens).padStart(14)} ${grouped(e.completionTokens).padStart(14)}`);
  }
  lines.push(`  ${"total".padEnd(10)} ${grouped(estimates.calls).padStart(7)} ${grouped(estimates.promptTokens).padStart(14)} ${grouped(estimates.completionTokens).padStart(14)}`);
  lines.push("");
  if (cost !== undefined) {
    lines.push(`  cost at $${options.priceIn}/M in, $${options.priceOut}/M out: $${cost.toFixed(4)}`);
  } else {
    lines.push("  cost: pass --price-in USD --price-out USD (per million tokens) for a figure");
  }
  lines.push("  input ≈ rendered prompts at 4 characters per token; output ≈ measured block averages (operation 450, type 650, module 900) per block asked for.");
  lines.push("  not included: repair re-asks, rate-limit retries. Records already in the side-car are reused, not re-sent.");
  return lines;
}

/**
 * The gate before spending: the estimate on stderr, then a question. A run
 * that plans no call, or `--yes`, passes silently; no terminal and no `--yes`
 * is a usage error, so a script never spends by accident.
 */
async function confirmed(plan: RunPlan, options: ExplainOptions, seam: ExplainSeam, io: IoSink): Promise<boolean> {
  if (plan.estimates.calls === 0 || options.yes) return true;
  const { calls, promptTokens, completionTokens } = plan.estimates;
  if (seam.confirm === undefined) {
    throw new UsageError(
      `this run needs ${calls} model call${calls === 1 ? "" : "s"} (~${grouped(promptTokens)} input, ~${grouped(completionTokens)} output tokens) and there is no terminal to confirm on`,
      "Pass --yes to run without asking, or --estimate to see the volume first.",
    );
  }
  errLines(io, [...estimateLines(plan, options), ""]);
  const cost = estimatedCost(promptTokens, completionTokens, options.priceIn, options.priceOut);
  return seam.confirm(
    `Run ${calls} model call${calls === 1 ? "" : "s"} (~${grouped(promptTokens)} input + ~${grouped(completionTokens)} output tokens${cost === undefined ? "" : `, ~$${cost.toFixed(4)}`})? [y/N] `,
  );
}

function summaryLines(out: string, result: Awaited<ReturnType<typeof executeRun>>, options: ExplainOptions): string[] {
  const { counts, usage } = result;
  const lines = [
    `wrote ${counts.records} record${counts.records === 1 ? "" : "s"} to ${out} (${counts.llm} explained, ${counts.template} templated, ${counts.reused} reused, ${counts.failed} failed, ${counts.skipped} skipped).`,
    `usage: ${counts.calls} call${counts.calls === 1 ? "" : "s"}, ${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens${usage.cost === undefined ? "" : `, $${usage.cost.toFixed(4)}`}.`,
  ];
  for (const failure of result.failures) lines.push(`failed: ${failure.id}: ${failure.reason.message}`);
  const { aborted } = result;
  if (aborted !== undefined) {
    // Units never reached have no failure record, so --retry-failed would miss them: a plain re-run resumes both.
    lines.push(`aborted: the provider answered ${aborted.reason.status ?? "?"} for ${aborted.unit} — every later call would get the same answer, so none was made.`);
    lines.push(`${aborted.notAttempted} unit${aborted.notAttempted === 1 ? " was" : "s were"} not attempted. Once the account is sorted out, run the same command again: it redoes the failures and resumes where this run stopped.`);
    if (aborted.reason.status === 402 && options.maxTokens === undefined) {
      lines.push("hint: without --max-tokens the provider prices every call at the model's full output window; a cap (e.g. --max-tokens 16384) lowers the balance a call needs.");
    }
  } else if (result.failures.length > 0) {
    lines.push(`${result.failures.length} failure${result.failures.length === 1 ? " is" : "s are"} recorded in ${out} with the reason. Once it is dealt with, run the same command with --retry-failed to redo just those.`);
  }
  return lines;
}
