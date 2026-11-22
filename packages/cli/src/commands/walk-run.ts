import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelBuilder, readModelRecordsSync } from "@codegraph/core";
import { FRAMEWORK_PROFILES, buildDomainFacts, loadSqlite } from "@codegraph/analyzer";
import {
  InsightsStoreError,
  LEVELS,
  WalkMismatchError,
  buildWalk,
  collectUnits,
  createSourceReader,
  decodeJournal,
  decodeRecords,
  executeRun,
  memoryBook,
  mergeRecords,
  planRun,
  priceSelection,
  resolveSelection,
  retryScope,
  sqliteInsightsStore,
  storeBook,
  walkChange,
  type Completer,
  type EntityEnv,
  type FailureRecord,
  type InsightsEof,
  type InsightsFile,
  type InsightsStore,
  type LevelCounts,
  type OpenRun,
  type PlanEnv,
  type RecordFormat,
  type RecordKey,
  type RecordSource,
  type RunPlan,
  type RunUsage,
  type Selection,
  type SelectionPrice,
  type StoreBook,
  type StoreHeader,
  type WalkIdentity,
  type WalkRecord,
  type WalkSpec,
} from "@codegraph/insights";
import {
  clientFromResolution,
  findClaudeCode,
  promptOverhead,
  resolveProvider,
  type LlmClient,
  type PromptOverhead,
  type Provider,
  type ProviderResolution,
} from "@codegraph/llm";
import { buildVocabulary, definitionSpeller, rankedWords, type VocabularyArtifact } from "@codegraph/vocabulary";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_EXPLAIN_MODEL, type RunFlags } from "../args.js";
import { EXIT, UsageError, type ExitCode } from "../exit.js";
import { errLine, errLines, outLine, type IoSink } from "../io.js";
import { openAnalysis } from "../source.js";
import { resolveView } from "../view.js";
import { realInputFs, type InputFs } from "./walk-input.js";

/**
 * THE RUNNER `explain` AND `walk` SHARE (PLAN.md §22.5): one walk, described by
 * a `WalkRun` — its spec and selection, its record format, its store and
 * side-car paths, its header, its JSON kinds and its words — resolved, priced,
 * confirmed, run, exported. `explain.ts` describes the built-in walk, `walk.ts`
 * a definition; neither runs anything itself.
 *
 * THE STORE IS THE WORKING COPY (PLAN.md §17): `<model>.insights.db` for
 * explain, `<model>.N.walk.db` for a walk N, beside the side-car. Every finished
 * unit is one committed transaction and every failure is written when it
 * happens, so an interrupted run is resumed, not repeated — records AND
 * failures. `--retry-failed` takes its scope from the store's failure rows.
 * Unlike `model.db` it is NOT a cache: nothing in it can be recomputed, so it is
 * never rebuilt, never bypassed, and a store this build must not touch — a
 * newer one, another walk's, the same walk's under other answer fields — is a
 * usage error naming it.
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
 * A definition changed since the store was written is said BEFORE the count,
 * and nothing is written before the answer.
 *
 * THE PROVIDER IS RESOLVED BEFORE THE PLAN (PLAN.md §21.4): `--provider`, or
 * on `auto` whichever adapter the environment configures (a key) or discovery
 * found (the Claude Code binary) — a pure function of flags, environment and
 * an `exists` probe, so `--dry-run` prints the model that would run and spawns
 * nothing. `--model` defaults per provider, which is why it waits for this.
 *
 * THE SEAM: environment, filesystem, clock, the client factory and the
 * question come in one object, so the whole command runs in-process against a
 * fake model with no network and no disk (test/explain.test.ts, test/walk.test.ts).
 */

export interface WalkFs extends InputFs {
  exists(path: string): boolean;
  /** What an outside edit of the side-car is measured by (the M7 staleness test, opposite consequence). */
  stat(path: string): { size: number; mtimeMs: number } | undefined;
  /** Whole-file replace that a crash cannot leave half-written — fed line by line, so the file never has to exist in memory. */
  writeLinesAtomic(path: string, lines: Iterable<string>): void;
  remove(path: string): void;
}

export interface WalkStores {
  /** Throws when this runtime has no SQLite — asked BEFORE anything is priced. */
  check(): void;
  exists(path: string): boolean;
  /**
   * Opens the store at `path` as the walk `format` names (explain's when absent), creating it if absent; throws
   * `InsightsStoreError` for one it must not touch — another walk's, or the same walk's under other answer fields.
   */
  open(path: string, format?: RecordFormat<WalkRecord, StoreHeader>): InsightsStore<WalkRecord, StoreHeader>;
}

export interface WalkSeam {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: WalkFs;
  readonly stores: WalkStores;
  /** This process, recorded on the run so a later one can tell a live writer from a dead one. */
  readonly pid: number;
  isAlive(pid: number): boolean;
  /** The client for a resolution with nothing missing: a key provider's variables are in `env`, Claude Code's binary rides on the resolution. */
  clientFor(resolution: ProviderResolution, env: Readonly<Record<string, string | undefined>>): LlmClient;
  now(): Date;
  /** Asks a yes/no question; undefined when there is no interactive terminal to ask on. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
}

export function realSeam(): WalkSeam {
  return {
    env: process.env,
    fs: {
      exists: (path) => existsSync(path),
      readFile: realInputFs().readFile,
      stat: (path) => {
        try {
          const { size, mtimeMs } = statSync(path);
          return { size, mtimeMs };
        } catch {
          return undefined;
        }
      },
      writeLinesAtomic: (path, lines) => {
        const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
        const fd = openSync(tmp, "w");
        try {
          // About a megabyte per write: a syscall per line would be 28 000 of them on Broadleaf.
          let batch: string[] = [];
          let size = 0;
          for (const line of lines) {
            batch.push(line, "\n");
            if ((size += line.length + 1) >= 1 << 20) {
              writeSync(fd, batch.join(""));
              batch = [];
              size = 0;
            }
          }
          if (batch.length > 0) writeSync(fd, batch.join(""));
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, path);
      },
      remove: (path) => rmSync(path, { force: true }),
    },
    stores: {
      check: () => void loadSqlite(),
      exists: (path) => existsSync(path),
      open: (path, format) => {
        const db = loadSqlite().open(path);
        try {
          return format === undefined ? sqliteInsightsStore(db) : sqliteInsightsStore(db, { format });
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
    clientFor: (resolution, env) => clientFromResolution(resolution, env),
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

// ---------------------------------------------------------------------------
// What a command hands the runner
// ---------------------------------------------------------------------------

/** How one command's run speaks: the words are the command's, the runner only places them. */
export interface RunWords {
  /** As messages name the command: `codegraph ${command}`. */
  readonly command: "explain" | "walk";
  /** The plan's and the estimate's first words. */
  readonly planTitle: string;
  readonly estimateTitle: string;
  /** What the store is called: `insights store`, `store of the walk "N"`. */
  readonly store: string;
  /** A side-car's suffix, for the hint of an unreadable `--import`. */
  readonly sidecar: string;
  /** What a unit given a record by a call was: explained, answered. */
  readonly answered: string;
  /** What keeps a store's records and a changed definition's apart. */
  readonly keepBoth: string;
}

/** What the store's header records of a run, from the runner: the walk adds its kind and identity. */
export interface HeaderInputs {
  readonly models: { readonly leaf: string; readonly rollup: string };
  readonly provider: string | undefined;
  readonly depth: number;
  readonly paths: readonly string[];
  readonly langs: readonly string[];
  readonly view: { readonly name: string; readonly filters: readonly string[] };
}

/** ONE WALK, as a command describes it: everything the runner does not decide. */
export interface WalkRun {
  readonly words: RunWords;
  readonly out: string;
  readonly storePath: string;
  readonly format: RecordFormat<WalkRecord, StoreHeader>;
  readonly kinds: { readonly plan: string; readonly estimate: string; readonly summary: string };
  /** The `walk` key of the JSON documents; undefined: none (explain's documents keep their bytes). */
  readonly identity: Pick<WalkIdentity, "name" | "version" | "digest"> | undefined;
  /** The context the walk resolved, flags over a definition's. */
  readonly context: { readonly depth: number; readonly maxLines: number };
  /** `--terms`: a module's glossary cut (explain's words; a walk without them passes the default). */
  readonly terms: number;
  /** Whether the plan and the estimate price the selection (PLAN.md §22.3 rule 4), in their text. */
  readonly priced: boolean;
  /** Whether the JSON documents carry that price too: a walk's do; explain's keep their shape (`--scope X` ≡ `--include id:X`). */
  readonly priceInJson: boolean;
  /** What the spec's completion tokens per block assume, in words: explain's and a definition's were each measured on a live run. */
  readonly completion: string;
  /** Whether an older build's journal may sit beside the side-car: explain's alone wrote one. */
  readonly journal: boolean;
  /** The spec over the walk's graph. */
  spec(env: EntityEnv): WalkSpec;
  /** The selection, checked against the graph; undefined: no predicate at all, every unit in scope. */
  selection(env: EntityEnv): Selection | undefined;
  header(inputs: HeaderInputs): StoreHeader;
}

/** `RunFlags` once the provider is known: `--model` defaulted per provider, `--rollup-model` to it. */
type ResolvedOptions = Omit<RunFlags, "model" | "rollupModel"> & {
  readonly model: string;
  readonly rollupModel: string;
  /** What the resolved provider's transport adds to every prompt, and who adds it — for the estimate. */
  readonly promptOverhead: PromptOverhead & { readonly by: Provider };
};

/** The provider and, from it, the models. `--claude-path` names a binary on purpose: on `auto` it implies `--provider claude-code`. */
function resolveRun(flags: RunFlags, seam: WalkSeam): { resolution: ProviderResolution; options: ResolvedOptions } {
  const discovery = findClaudeCode({ explicit: flags.claudePath, env: seam.env, exists: seam.fs.exists });
  const choice = flags.provider === "auto" && flags.claudePath !== undefined ? "claude-code" : flags.provider;
  const resolution = resolveProvider(choice, seam.env, { claudeCode: discovery });
  const model = flags.model ?? (resolution.provider === "claude-code" ? DEFAULT_CLAUDE_CODE_MODEL : DEFAULT_EXPLAIN_MODEL);
  const overhead = { ...promptOverhead(resolution.provider), by: resolution.provider };
  return { resolution, options: { ...flags, model, rollupModel: flags.rollupModel ?? model, promptOverhead: overhead } };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runWalk(flags: RunFlags, walk: WalkRun, io: IoSink, seam: WalkSeam): Promise<ExitCode> {
  // Neither reads a model: they move records between the store and its side-car.
  if (flags.exportOnly) return exportOnly(walk, seam, io);
  if (flags.importFrom !== undefined) return importOnly(flags.importFrom, walk, flags, seam, io);

  const { out, storePath, words } = walk;
  const { resolution, options } = resolveRun({ ...flags, depth: walk.context.depth, maxLines: walk.context.maxLines }, seam);
  const source = openAnalysis(options.models, options, io);
  let store: InsightsStore<WalkRecord, StoreHeader> | undefined;
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const profile = options.framework === undefined ? undefined : FRAMEWORK_PROFILES[options.framework];
    const facts = buildDomainFacts(graph, { view, ...(profile === undefined ? {} : { framework: profile }) });
    const units = collectUnits(graph, facts);
    const order = buildWalk(units, graph, view);

    const srcRoot = resolveSourceRoot(options, graph.union.models[0]?.root, units, seam);
    const reader = createSourceReader((relative) => seam.fs.readFile(join(srcRoot, relative)));
    // The words a prompt asks to define are the cloud's (PLAN.md §20.3); the module weights are counted on first ask.
    let vocabulary: VocabularyArtifact | undefined;
    const speller = { words: definitionSpeller(graph), ranked: (id: string) => rankedWords((vocabulary ??= buildVocabulary(graph, { view })), id) };
    const entityEnv: EntityEnv = { graph, view, units, walk: order };
    const spec = walk.spec(entityEnv);
    const env: PlanEnv = { graph, facts, units, reader, unitOf: order.unitOf, speller, spec };

    const journal = `${out}.journal`;
    const loaded = loadExisting(walk, journal, spec, seam, io);
    store = loaded.store;
    const { header: previous, failures: previousFailures } = loaded;
    if (options.retryFailed) {
      if (previous === undefined) {
        throw new UsageError(
          `--retry-failed found no ${words.store} at ${storePath} and no side-car at ${out}`,
          "It redoes the failures a previous run recorded there. Pass --out FILE if the side-car is elsewhere, or drop --retry-failed for a first run.",
        );
      }
      if (previousFailures.length === 0) {
        errLine(io, `nothing to retry: ${out} records no failure.`);
        return source.clean ? EXIT.OK : EXIT.FINDINGS;
      }
      errLines(io, retryLines(previousFailures, previous, options));
    }

    // The selection is the walk's, resolved under ITS view; a retry's is the store's failures (PLAN.md §22.3).
    const selection = options.retryFailed ? undefined : walk.selection(entityEnv);
    const selected = selection === undefined ? undefined : resolveSelection(selection, { ...entityEnv, spec });
    const plan = planRun(order, loaded.book, env, {
      models: { leaf: options.model, rollup: options.rollupModel },
      depth: options.depth,
      maxLines: options.maxLines,
      maxScc: options.maxScc,
      force: options.force,
      maxCalls: options.maxCalls,
      inScope: options.retryFailed ? retryScope(previousFailures, order) : selected?.inScope,
      terms: walk.terms,
      promptOverhead: options.promptOverhead,
    });
    const price = walk.priced && selected !== undefined ? priceSelection(selected) : undefined;
    const notice = changeLines(plan, loaded, walk);

    if (!source.clean) {
      errLine(io, "warning: the models are not clean; the walk was built anyway.");
      errLine(io, `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`);
    }

    if (options.estimate) {
      printEstimate(plan, options, walk, price, notice, io);
      return source.clean ? EXIT.OK : EXIT.FINDINGS;
    }
    if (options.dryRun) {
      printPlan(plan, options, walk, price, notice, io);
      return source.clean ? EXIT.OK : EXIT.FINDINGS;
    }

    // No SQLite, no run — said before anything is priced, asked or called (there is no JSONL fallback).
    try {
      seam.stores.check();
    } catch (error) {
      throw new UsageError(
        `${words.command} needs SQLite for its store (${storePath}), and this runtime has none`,
        `Node's SQLite builtin ships from Node 22.5.0 and is absent from builds configured --without-sqlite (${error instanceof Error ? error.message : String(error)}). --dry-run and --estimate still work on a side-car.`,
        { cause: error },
      );
    }
    const { complete, provider } = completerFor(plan, options, resolution, seam, io);
    if (!(await confirmed(plan, options, walk, price, notice, seam, io))) {
      errLine(io, "aborted: no call was made, nothing was written.");
      return EXIT.OK;
    }
    const keyOf = naturalKeys(options.models, io);
    // A run that makes no call (everything reused) keeps saying who served the records.
    const header = walk.header({
      models: { leaf: options.model, rollup: options.rollupModel },
      provider: provider ?? previous?.provider,
      depth: options.depth,
      paths: options.models,
      langs: graph.union.langs,
      view: { name: view.descriptor.name, filters: view.descriptor.filters },
    });
    const total = plan.steps.length;
    let done = 0;

    // From here the run WRITES: the store comes to exist, takes in what predates it, and closes what died.
    store ??= openStore(walk, seam);
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
    // The run reads and writes THE STORE: a finished unit is committed by the book's put, and a later prompt
    // reads its dependencies back from there. No record is held here (M16b).
    const book: StoreBook<WalkRecord> = loaded.storeBook ?? storeBook(writing, spec);
    book.begin(run);

    const result = await executeRun<WalkRecord>(plan, env, book, complete, { maxScc: options.maxScc, depth: options.depth, maxLines: options.maxLines, terms: walk.terms, previousFailures, ...(keyOf === undefined ? {} : { keyOf }) }, {
      concurrency: options.concurrency,
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
      errLine(io, `warning: ${misses.length} source file${misses.length === 1 ? "" : "s"} not found under ${srcRoot} (first: ${misses[0]}); those units were ${words.answered} from facts alone.`);
    }
    errLines(io, summaryLines(out, result, options, provider, words));
    if (options.json) {
      outLine(io, JSON.stringify({ kind: walk.kinds.summary, ...identityKey(walk), out, counts: result.counts, usage: result.usage, failures: result.failures, ...(result.aborted === undefined ? {} : { aborted: result.aborted }) }));
    }
    if (result.failures.length > 0) return EXIT.FINDINGS;
    return source.clean ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    store?.close();
    source.close();
  }
}

/** The `walk` key a document carries, when the walk has an identity; explain's documents carry none. */
function identityKey(walk: WalkRun): { readonly walk?: WalkRun["identity"] } {
  return walk.identity === undefined ? {} : { walk: walk.identity };
}

/** A store this build must not touch (newer, not ours, another walk's or answer's) is the user's to sort out — named, never replaced. */
function openStore(walk: WalkRun, seam: WalkSeam): InsightsStore<WalkRecord, StoreHeader> {
  try {
    return seam.stores.open(walk.storePath, walk.format);
  } catch (error) {
    if (!(error instanceof InsightsStoreError)) throw error;
    const hint =
      error instanceof WalkMismatchError
        ? error.reason === "answer"
          ? `The answer fields changed since this store was written: every unit would be asked again, and its records could never be exported beside the new ones. ${capitalized(walk.words.keepBoth)} — this store stays as it is — or pass --out FILE to work beside another side-car.`
          : "Each walk keeps its own store (explain's is <model>.insights.db, a walk N's <model>.N.walk.db). Pass --out FILE to work beside another side-car."
        : "The insights store holds explanations that were paid for, so it is never rebuilt. Upgrade codegraph, or pass --out FILE to work beside another side-car.";
    throw new UsageError(`${walk.storePath}: ${error.message}`, hint, { cause: error });
  }
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The side-car, whole and atomic, from the store — and the stamp an outside edit is later measured against. */
function writeExport(store: InsightsStore<WalkRecord, StoreHeader>, out: string, seam: WalkSeam): void {
  seam.fs.writeLinesAtomic(out, store.export());
  const stamp = seam.fs.stat(out);
  if (stamp !== undefined) store.markExported({ path: out, ...stamp });
}

/** Runs with no end. A live writer is a refusal; a dead one is a resume, closed once this run starts writing. */
function interruptedRuns(store: InsightsStore<WalkRecord, StoreHeader>, walk: WalkRun, seam: WalkSeam, io: IoSink): OpenRun[] {
  const open = store.openRuns();
  for (const run of open) {
    if (run.pid !== undefined && run.pid !== seam.pid && seam.isAlive(run.pid)) {
      throw new UsageError(
        `another ${walk.words.command} (pid ${run.pid}, started ${run.startedAt}) is writing to ${walk.storePath}`,
        "Two runs on one store would pay twice for the same units. Wait for it, or stop it and run again: what it committed is kept.",
      );
    }
    errLine(io, `note: the run started ${run.startedAt} was interrupted; its ${run.records} record${run.records === 1 ? "" : "s"} and its failures are kept and reused ('--export' writes the side-car as it stands).`);
  }
  return open;
}

function decodeSidecar(path: string, text: string, walk: WalkRun): InsightsFile<WalkRecord, StoreHeader> {
  try {
    return decodeRecords(walk.format, text);
  } catch (error) {
    throw new UsageError(
      `${path} is not a ${walk.format.kind} side-car: ${error instanceof Error ? error.message : String(error)}`,
      walk.words.command === "explain"
        ? "Pass --out FILE to write elsewhere, or remove the file to start over."
        : `${capitalized(walk.words.keepBoth)}; pass --out FILE to write elsewhere, or remove the file to start over.`,
      { cause: error },
    );
  }
}

/** `--export`: the side-car as the store stands — after an interrupted run, or a deleted file. */
function exportOnly(walk: WalkRun, seam: WalkSeam, io: IoSink): ExitCode {
  const { out, storePath, words } = walk;
  if (!seam.stores.exists(storePath)) {
    throw new UsageError(`--export found no ${words.store} at ${storePath}`, `A run of 'codegraph ${words.command}' creates it. Pass --out FILE if the side-car is elsewhere.`);
  }
  const store = openStore(walk, seam);
  try {
    if (store.isEmpty()) throw new UsageError(`--export: the ${words.store} at ${storePath} is empty`, `Run 'codegraph ${words.command}' first.`);
    interruptedRuns(store, walk, seam, io);
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
async function importOnly(from: string, walk: WalkRun, options: RunFlags, seam: WalkSeam, io: IoSink): Promise<ExitCode> {
  const { out, storePath } = walk;
  const text = seam.fs.readFile(from);
  if (text === undefined) throw new UsageError(`--import cannot read ${from}`, `Pass the path of a side-car (${walk.words.sidecar}).`);
  const file = decodeSidecar(from, text, walk);
  const store = openStore(walk, seam);
  try {
    interruptedRuns(store, walk, seam, io);
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

/**
 * `--src`, or the model's recorded root. Probed against the first anchor so a
 * mismatch is a usage error naming the path, not thousands of "source
 * unavailable" prompts paid for.
 */
function resolveSourceRoot(options: RunFlags, modelRoot: string | undefined, units: ReturnType<typeof collectUnits>, seam: WalkSeam): string {
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
  /** What the plan reads: the store's fingerprints (blocks on demand), or a side-car held in memory. */
  readonly book: RecordSource;
  /** The same book when it IS the store's — the run then writes through it rather than scanning fingerprints twice. */
  readonly storeBook: StoreBook<WalkRecord> | undefined;
  readonly header: StoreHeader | undefined;
  readonly failures: readonly FailureRecord[];
  /** Open when a store already exists; a run that gets to write opens (creates) it otherwise. */
  readonly store: InsightsStore<WalkRecord, StoreHeader> | undefined;
  /** What predates the store — a side-car, an older build's journal — to import once this run writes. */
  readonly legacy: (Omit<InsightsFile<WalkRecord, StoreHeader>, "header"> & { header: StoreHeader | undefined }) | undefined;
  readonly interrupted: readonly OpenRun[];
}

/**
 * What is already answered. The STORE when there is one — a side-car beside
 * it is only checked for an outside edit; otherwise the side-car (and an older
 * build's journal, explain's alone), read WITHOUT creating a store: `--dry-run`
 * and `--estimate` write nothing, and the import waits for a run that does.
 */
function loadExisting(walk: WalkRun, journal: string, spec: WalkSpec, seam: WalkSeam, io: IoSink): Existing {
  const { out, storePath } = walk;
  const store = seam.stores.exists(storePath) ? openStore(walk, seam) : undefined;
  if (store !== undefined && !store.isEmpty()) {
    try {
      const interrupted = interruptedRuns(store, walk, seam, io);
      const stamp = store.exported();
      const found = seam.fs.stat(out);
      if (found !== undefined && (stamp === undefined || stamp.size !== found.size || stamp.mtimeMs !== found.mtimeMs)) {
        errLine(io, `warning: ${out} changed outside codegraph since it was last exported; the store (${storePath}) is the working copy and this run will overwrite the file.`);
        errLine(io, `To take the file instead: codegraph ${walk.words.command} … --import ${out}`);
      }
      const book = storeBook(store, spec);
      return { book, storeBook: book, header: store.header(), failures: store.failures(), store, legacy: undefined, interrupted };
    } catch (error) {
      store.close();
      throw error;
    }
  }

  let base: InsightsFile<WalkRecord, StoreHeader> | undefined;
  const text = seam.fs.exists(out) ? seam.fs.readFile(out) : undefined;
  if (text !== undefined && text.trim() !== "") {
    base = decodeSidecar(out, text, walk);
    if (base.truncated) errLine(io, `note: ${out} was cut short; its ${base.records.length} records are reused, the rest redone.`);
  }
  let extra: WalkRecord[] = [];
  if (walk.journal && seam.fs.exists(journal)) {
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
  return { book: memoryBook(records, spec), storeBook: undefined, header: base?.header, failures: base?.failures ?? [], store, legacy, interrupted: [] };
}

/**
 * The digest notice (PLAN.md §22.4): a definition changed since the store (or
 * its side-car) was written is said in words, before any count — how many of
 * the records it holds this run asks again and REPLACES, and what keeps both.
 */
function changeLines(plan: RunPlan, existing: Pick<Existing, "book" | "header">, walk: WalkRun): string[] {
  if (walkChange(existing.header, walk.format) === undefined) return [];
  const replaced = plan.steps.filter((step) => step.status === "llm" && step.unit.members.some((member) => existing.book.fingerprint(member) !== undefined)).length;
  const what =
    replaced === 0
      ? "no unit it holds is asked again (the change moves no fingerprint)"
      : `these ${replaced} unit${replaced === 1 ? " is" : "s are"} asked again and ${replaced === 1 ? "its record" : "their records"} REPLACED`;
  return [`note: the definition changed since this store was written: ${what}; ${walk.words.keepBoth}.`];
}

/**
 * What a retry is about to redo, and a warning when it would not match the
 * run that failed: model and depth are part of every fingerprint, so a retried
 * unit explained under others is redone again by the next plain run.
 */
function retryLines(failures: readonly FailureRecord[], previous: StoreHeader, options: ResolvedOptions): string[] {
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

/** How to make each adapter buildable, for the usage error of a run that needs calls and cannot make them. */
const SETUP_HINT: Readonly<Record<Provider, string>> = {
  openrouter:
    "Create one at https://openrouter.ai/keys, or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to route through Cloudflare AI Gateway, " +
    "or install Claude Code and pass --provider claude-code to run it locally (no key).",
  cloudflare: "CLOUDFLARE_API_TOKEN needs the AI Gateway Run permission (wrangler auth token); CLOUDFLARE_AI_GATEWAY_ID is optional (the account's default gateway otherwise).",
  "claude-code": "Install Claude Code (https://code.claude.com/docs/en/setup) and log in, or point at the binary with --claude-path FILE or CLAUDE_CODE_PATH.",
};

/**
 * The completer over the resolved provider. What it lacks — a variable, the
 * Claude Code binary — is checked BEFORE any call, so it is a usage error
 * naming it (and what was searched), never a failed first request.
 */
function completerFor(
  plan: RunPlan,
  options: ResolvedOptions,
  resolution: ProviderResolution,
  seam: WalkSeam,
  io: IoSink,
): { complete: Completer; provider: Provider | undefined } {
  if (plan.estimates.calls === 0) return { complete: () => Promise.reject(new Error("no call was planned")), provider: undefined };
  if (resolution.missing.length > 0) {
    const calls = `${plan.estimates.calls} model call${plan.estimates.calls === 1 ? "" : "s"}`;
    // Claude Code leads with what discovery said: a path the user named is the message, not "a variable is not set".
    const lacking =
      resolution.provider === "claude-code"
        ? resolution.reason
        : `${resolution.missing.join(" and ")} ${resolution.missing.length === 1 ? "is" : "are"} not set (${resolution.reason})`;
    throw new UsageError(
      `${lacking}, and this run needs ${calls}`,
      `${SETUP_HINT[resolution.provider]} Add --dry-run to see the plan without calling. Models: ${options.model}${options.rollupModel === options.model ? "" : `, ${options.rollupModel}`}.`,
    );
  }
  const client = seam.clientFor(resolution, seam.env);
  errLine(io, `provider: ${client.name} (${resolution.reason})`);
  // The port carries maxTokens; the CLI has no output cap, so that adapter drops it — said here, once.
  if (resolution.provider === "claude-code" && options.maxTokens !== undefined) {
    errLine(io, "note: --max-tokens does not apply to claude-code (the CLI has no output cap); ignored.");
  }
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

function eofFor(
  result: { counts: { records: number; llm: number; template: number; reused: number; failed: number }; usage: RunUsage },
  seam: WalkSeam,
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

// ---------------------------------------------------------------------------
// What is printed
// ---------------------------------------------------------------------------

const countOf = (counts: LevelCounts): number => counts.operation + counts.type + counts.module;
const perLevel = (counts: LevelCounts): string => LEVELS.map((level) => `${level} ${counts[level]}`).join(", ");

/**
 * The price of a selection (PLAN.md §22.3 rule 4): the dependencies of the
 * asked units it leaves unwalked — each shown NOT EXPLAINED unless the store
 * already holds its record, which is reused and quoted — and, when the
 * closure does not already follow them, what following them would add.
 * Nothing when nothing is left out. Cold-plan figures: on a warm store an added
 * unit may be reused rather than called.
 */
function priceLines(price: SelectionPrice | undefined): string[] {
  if (price === undefined) return [];
  const { notWalked } = price;
  const parts: readonly (readonly [string, LevelCounts])[] = [
    ["unselected", notWalked.unselected],
    ["excluded", notWalked.excluded],
    ["outside --levels", notWalked.outsideLevels],
    ["trivial, skipped", notWalked.trivial],
  ];
  const total = parts.reduce((sum, [, counts]) => sum + countOf(counts), 0);
  if (total === 0) return [];
  const why = parts.filter(([, counts]) => countOf(counts) > 0).map(([what, counts]) => `${countOf(counts)} ${what}`).join(", ");
  const lines = [`  selection: ${total} dependenc${total === 1 ? "y" : "ies"} of the selection ${total === 1 ? "is" : "are"} not walked (${why}); without a record, shown as NOT EXPLAINED`];
  const follows = price.closure === "dependencies" || price.closure === "all";
  if (!follows && countOf(notWalked.unselected) > 0) {
    const mode = price.closure === "none" ? "dependencies" : "all";
    const adds = Object.fromEntries(LEVELS.map((level) => [level, price.added[mode][level] - price.added[price.closure][level]])) as Record<(typeof LEVELS)[number], number>;
    const added = countOf(adds);
    lines.push(`  --closure ${mode} adds ${added} unit${added === 1 ? "" : "s"} (${perLevel(adds)})`);
  }
  return lines;
}

function printPlan(plan: RunPlan, options: ResolvedOptions, walk: WalkRun, price: SelectionPrice | undefined, notice: readonly string[], io: IoSink): void {
  const { estimates } = plan;
  const priced = priceLines(price);
  if (options.json) {
    errLines(io, notice);
    outLine(
      io,
      JSON.stringify({
        kind: walk.kinds.plan,
        ...identityKey(walk),
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
        ...(priced.length === 0 || !walk.priceInJson ? {} : { price }),
      }),
    );
    return;
  }
  const lines: string[] = [...notice];
  lines.push(`${walk.words.planTitle}: ${plan.steps.length} units in ${(plan.steps[plan.steps.length - 1]?.unit.layer ?? -1) + 1} layers`);
  for (const level of ["operation", "type", "module"] as const) {
    const e = estimates.byLevel[level];
    lines.push(`  ${level.padEnd(9)} ${String(e.units).padStart(6)} units ${String(e.calls).padStart(6)} calls ~${e.promptTokens} prompt tokens`);
  }
  lines.push(`  statuses: llm ${estimates.byStatus.llm}, template ${estimates.byStatus.template}, reuse ${estimates.byStatus.reuse}, skip-scope ${estimates.byStatus["skip-scope"]}, skip-budget ${estimates.byStatus["skip-budget"]}`);
  lines.push(...priced);
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
 * is the rendered prompts at ~4 chars/token; output is a measured figure per
 * block (explain's: and per word and glossary entry) asked for. Repair re-asks
 * and rate-limit retries are not included, and a run that reuses records sends
 * less than a cold one.
 */
function printEstimate(plan: RunPlan, options: ResolvedOptions, walk: WalkRun, price: SelectionPrice | undefined, notice: readonly string[], io: IoSink): void {
  const { estimates } = plan;
  const cost = estimatedCost(estimates.promptTokens, estimates.completionTokens, options.priceIn, options.priceOut);
  const layers = (plan.steps[plan.steps.length - 1]?.unit.layer ?? -1) + 1;
  if (options.json) {
    errLines(io, notice);
    outLine(
      io,
      JSON.stringify({
        kind: walk.kinds.estimate,
        ...identityKey(walk),
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
          promptTokens: `characters of the rendered prompts / 4${overheadAssumption(options.promptOverhead)}`,
          completionTokens: `measured on a live run: ${walk.completion}`,
          excluded: "repair re-asks, rate-limit retries",
        },
        ...(priceLines(price).length === 0 || !walk.priceInJson ? {} : { price }),
      }),
    );
    return;
  }
  outLine(io, [...notice, ...estimateLines(plan, options, walk, price)].join("\n"));
}

function estimateLines(plan: RunPlan, options: ResolvedOptions, walk: WalkRun, price: SelectionPrice | undefined): string[] {
  const { estimates } = plan;
  const cost = estimatedCost(estimates.promptTokens, estimates.completionTokens, options.priceIn, options.priceOut);
  const layers = (plan.steps[plan.steps.length - 1]?.unit.layer ?? -1) + 1;
  const lines: string[] = [];
  lines.push(`${walk.words.estimateTitle}: ${options.models.join(" ")}`);
  const b = estimates.byLevel;
  lines.push(`  units: ${plan.steps.length} (operation ${b.operation.units}, type ${b.type.units}, module ${b.module.units}) in ${layers} layers`);
  lines.push(`  calls: ${estimates.calls} (template ${estimates.byStatus.template}, reuse ${estimates.byStatus.reuse}, skipped ${estimates.byStatus["skip-scope"] + estimates.byStatus["skip-budget"]})`);
  lines.push(...priceLines(price));
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
  const { perCall, schema, by } = options.promptOverhead;
  const added = perCall === 0 && !schema ? "" : `, plus ${grouped(perCall)} per call${schema ? " and the response schema" : ""} that ${by} adds to every prompt`;
  lines.push(`  input ≈ rendered prompts at 4 characters per token${added}; output ≈ measured on a live run: ${walk.completion}.`);
  lines.push("  not included: repair re-asks, rate-limit retries. Records already in the side-car are reused, not re-sent.");
  return lines;
}

/** The `--json` estimate's word for what the transport adds to every prompt; nothing when it adds nothing. */
function overheadAssumption({ perCall, schema, by }: ResolvedOptions["promptOverhead"]): string {
  if (perCall === 0 && !schema) return "";
  return `, + ${perCall} per call${schema ? " + the response schema" : ""} (${by})`;
}

/**
 * The gate before spending: the estimate on stderr, then a question. A run
 * that plans no call, or `--yes`, passes silently; no terminal and no `--yes`
 * is a usage error, so a script never spends by accident. A changed
 * definition is told first, whichever way the gate opens.
 */
async function confirmed(plan: RunPlan, options: ResolvedOptions, walk: WalkRun, price: SelectionPrice | undefined, notice: readonly string[], seam: WalkSeam, io: IoSink): Promise<boolean> {
  if (plan.estimates.calls === 0 || options.yes) {
    errLines(io, notice);
    return true;
  }
  const { calls, promptTokens, completionTokens } = plan.estimates;
  if (seam.confirm === undefined) {
    errLines(io, notice);
    throw new UsageError(
      `this run needs ${calls} model call${calls === 1 ? "" : "s"} (~${grouped(promptTokens)} input, ~${grouped(completionTokens)} output tokens) and there is no terminal to confirm on`,
      "Pass --yes to run without asking, or --estimate to see the volume first.",
    );
  }
  errLines(io, [...notice, ...estimateLines(plan, options, walk, price), ""]);
  const cost = estimatedCost(promptTokens, completionTokens, options.priceIn, options.priceOut);
  return seam.confirm(
    `Run ${calls} model call${calls === 1 ? "" : "s"} (~${grouped(promptTokens)} input + ~${grouped(completionTokens)} output tokens${cost === undefined ? "" : `, ~$${cost.toFixed(4)}`})? [y/N] `,
  );
}

function summaryLines(out: string, result: Awaited<ReturnType<typeof executeRun<WalkRecord>>>, options: RunFlags, provider: Provider | undefined, words: RunWords): string[] {
  const { counts, usage } = result;
  const lines = [
    `wrote ${counts.records} record${counts.records === 1 ? "" : "s"} to ${out} (${counts.llm} ${words.answered}, ${counts.template} templated, ${counts.reused} reused, ${counts.failed} failed, ${counts.skipped} skipped).`,
    `usage: ${counts.calls} call${counts.calls === 1 ? "" : "s"}, ${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens${usage.cost === undefined ? "" : `, $${usage.cost.toFixed(4)}`}.`,
  ];
  for (const failure of result.failures) lines.push(`failed: ${failure.id}: ${failure.reason.message}`);
  const { aborted } = result;
  if (aborted !== undefined) {
    // Units never reached have no failure record, so --retry-failed would miss them: a plain re-run resumes both.
    lines.push(`aborted: the provider answered ${aborted.reason.status ?? "?"} for ${aborted.unit} — every later call would get the same answer, so none was made.`);
    lines.push(`${aborted.notAttempted} unit${aborted.notAttempted === 1 ? " was" : "s were"} not attempted. Once the account is sorted out, run the same command again: it redoes the failures and resumes where this run stopped.`);
    // A cap lowers what a prepaid call must afford on a key provider; the Claude Code CLI has none.
    if (aborted.reason.status === 402 && options.maxTokens === undefined && provider !== "claude-code") {
      lines.push("hint: without --max-tokens the provider prices every call at the model's full output window; a cap (e.g. --max-tokens 16384) lowers the balance a call needs.");
    }
  } else if (result.failures.length > 0) {
    lines.push(`${result.failures.length} failure${result.failures.length === 1 ? " is" : "s are"} recorded in ${out} with the reason. Once it is dealt with, run the same command with --retry-failed to redo just those.`);
  }
  return lines;
}
