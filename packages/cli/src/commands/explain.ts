import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ModelBuilder, readModelRecordsSync } from "@codegraph/core";
import { FRAMEWORK_PROFILES, buildDomainFacts, folderFor } from "@codegraph/analyzer";
import {
  INSIGHTS_GENERATOR,
  INSIGHTS_KIND,
  INSIGHTS_METAMODEL,
  PROMPT_VERSION,
  buildWalk,
  collectUnits,
  createSourceReader,
  decodeInsights,
  decodeJournal,
  encodeInsightsToString,
  encodeJournalLine,
  executeRun,
  mergeRecords,
  planRun,
  recordsById,
  type Completer,
  type InsightRecord,
  type InsightsEof,
  type InsightsHeader,
  type PlanEnv,
  type RecordKey,
  type RunPlan,
  type RunUsage,
  type Unit,
} from "@codegraph/insights";
import { openRouterClient, type LlmClient } from "@codegraph/llm";
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
 * THE SIDE-CAR IS THE ARTIFACT, and it is a FILE, not stdout: it is written
 * progressively (a journal line per finished record, the sorted file rewritten
 * at every layer) so an interrupted run is resumed, not repeated. stdout stays
 * empty unless `--dry-run` (the plan) or `--json` (the summary) asks for it.
 *
 * THE SEAM: environment, filesystem, clock and the client factory come in one
 * object, so the whole command runs in-process against a fake model with no
 * network and no disk (test/explain.test.ts).
 */

export interface ExplainFs {
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
  appendFile(path: string, text: string): void;
  /** Whole-file replace that a crash cannot leave half-written. */
  writeFileAtomic(path: string, text: string): void;
  remove(path: string): void;
}

export interface ExplainSeam {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ExplainFs;
  clientFor(apiKey: string): LlmClient;
  now(): Date;
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
      appendFile: (path, text) => appendFileSync(path, text, "utf8"),
      writeFileAtomic: (path, text) => {
        const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, path);
      },
      remove: (path) => rmSync(path, { force: true }),
    },
    clientFor: (apiKey) => openRouterClient({ apiKey }),
    now: () => new Date(),
  };
}

export const API_KEY_VARIABLE = "OPENROUTER_API_KEY";

export async function explainCommand(
  options: ExplainOptions,
  io: IoSink,
  seam: ExplainSeam = realSeam(),
): Promise<ExitCode> {
  const source = openAnalysis(options.models, options, io);
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

    const out = options.out ?? sidecarPathFor(options.models[0] ?? "model.jsonl");
    const journal = `${out}.journal`;
    const existing = loadExisting(out, journal, seam, io);

    const plan = planRun(walk, existing, env, {
      models: { leaf: options.model, rollup: options.rollupModel },
      depth: options.depth,
      maxLines: options.maxLines,
      maxScc: options.maxScc,
      force: options.force,
      maxCalls: options.maxCalls,
      inScope: scopePredicate(options.scope, graph, units),
    });

    if (!source.clean) {
      errLine(io, "warning: the models are not clean; the walk was built anyway.");
      errLine(io, `Run 'codegraph validate ${source.paths.join(" ")}' for the detail.`);
    }

    if (options.dryRun) {
      printPlan(plan, options, io);
      return source.clean ? EXIT.OK : EXIT.FINDINGS;
    }

    const complete = completerFor(plan, options, seam);
    const keyOf = naturalKeys(options.models, io);
    const header = headerFor(options, graph.union.langs, view.descriptor.name, view.descriptor.filters);
    const total = plan.steps.length;
    let done = 0;

    const result = await executeRun(plan, env, existing, complete, { maxScc: options.maxScc, depth: options.depth, maxLines: options.maxLines, ...(keyOf === undefined ? {} : { keyOf }) }, {
      concurrency: options.concurrency,
      onRecord: (record) => seam.fs.appendFile(journal, encodeJournalLine(record)),
      onStep: (event) => {
        done += 1;
        const { unit } = event.step;
        const tag = `[${done}/${total}]`;
        const what = `${unit.level} ${unit.id}${unit.members.length > 1 ? ` (+${unit.members.length - 1} in cycle)` : ""}`;
        if (event.outcome === "failed") errLine(io, `${tag} ${what}: FAILED ${event.error ?? ""}`);
        else if (event.step.status === "llm") errLine(io, `${tag} ${what}: ${event.calls} call${event.calls === 1 ? "" : "s"}, ${event.usage.promptTokens}+${event.usage.completionTokens} tokens`);
        else errLine(io, `${tag} ${what}: ${event.step.status}`);
      },
      onLayer: (_layer, records) => {
        seam.fs.writeFileAtomic(out, encodeInsightsToString(header, records, eofFor(result0(records.length), seam)));
      },
    });

    seam.fs.writeFileAtomic(out, encodeInsightsToString(header, result.records, eofFor(result, seam)));
    seam.fs.remove(journal);

    const misses = reader.misses();
    if (misses.length > 0) {
      errLine(io, `warning: ${misses.length} source file${misses.length === 1 ? "" : "s"} not found under ${srcRoot} (first: ${misses[0]}); those units were explained from facts alone.`);
    }
    errLines(io, summaryLines(out, result));
    if (options.json) {
      outLine(io, JSON.stringify({ kind: "codegraph.explainSummary/1", out, counts: result.counts, usage: result.usage, failures: result.failures }));
    }
    if (result.failures.length > 0) return EXIT.FINDINGS;
    return source.clean ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    source.close();
  }
}

/** Partial totals for the layer-boundary rewrite: only the record count is known cheaply. */
function result0(records: number): { counts: { records: number; llm: number; template: number; reused: number; failed: number }; usage: RunUsage } {
  return { counts: { records, llm: 0, template: 0, reused: 0, failed: 0 }, usage: { promptTokens: 0, completionTokens: 0, cost: undefined } };
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

function loadExisting(out: string, journal: string, seam: ExplainSeam, io: IoSink): Map<string, InsightRecord> {
  let base: InsightRecord[] = [];
  if (seam.fs.exists(out)) {
    const text = seam.fs.readFile(out);
    if (text !== undefined && text.trim() !== "") {
      try {
        const file = decodeInsights(text);
        base = [...file.records];
        if (file.truncated) errLine(io, `note: ${out} was cut short; its ${base.length} records are reused, the rest redone.`);
      } catch (error) {
        throw new UsageError(
          `${out} is not a ${INSIGHTS_KIND} side-car: ${error instanceof Error ? error.message : String(error)}`,
          "Pass --out FILE to write elsewhere, or remove the file to start over.",
          { cause: error },
        );
      }
    }
  }
  let extra: InsightRecord[] = [];
  if (seam.fs.exists(journal)) {
    const { records, dropped } = decodeJournal(seam.fs.readFile(journal) ?? "");
    extra = records;
    errLine(io, `note: resuming from ${journal} (${records.length} record${records.length === 1 ? "" : "s"}${dropped === 0 ? "" : `, ${dropped} unreadable line${dropped === 1 ? "" : "s"} dropped`}).`);
  }
  return recordsById(mergeRecords(base, extra));
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

function completerFor(plan: RunPlan, options: ExplainOptions, seam: ExplainSeam): Completer {
  if (plan.estimates.calls === 0) return () => Promise.reject(new Error("no call was planned"));
  const apiKey = seam.env[API_KEY_VARIABLE];
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new UsageError(
      `${API_KEY_VARIABLE} is not set, and this run needs ${plan.estimates.calls} model call${plan.estimates.calls === 1 ? "" : "s"}`,
      `Export it (https://openrouter.ai/keys), or add --dry-run to see the plan without calling. Models: ${options.model}${options.rollupModel === options.model ? "" : `, ${options.rollupModel}`}.`,
    );
  }
  const client = seam.clientFor(apiKey);
  return async (request) => {
    const response = await client.complete({
      model: request.model,
      system: request.system,
      user: request.user,
      schema: { name: request.schemaName, jsonSchema: request.jsonSchema },
    });
    return { json: response.json, model: response.model, ...(response.usage === undefined ? {} : { usage: response.usage }) };
  };
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

function headerFor(options: ExplainOptions, langs: readonly string[], viewName: string, filters: readonly string[]): InsightsHeader {
  return {
    t: "header",
    kind: INSIGHTS_KIND,
    generatedBy: INSIGHTS_GENERATOR,
    promptVersion: PROMPT_VERSION,
    metamodel: INSIGHTS_METAMODEL,
    models: { leaf: options.model, rollup: options.rollupModel },
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
  lines.push(`  total: ${estimates.calls} calls, ~${estimates.promptTokens} prompt tokens`);
  lines.push("");
  for (const step of plan.steps) {
    const cycle = step.unit.members.length > 1 ? ` cycle(${step.unit.members.length})` : "";
    lines.push(`${step.status.padEnd(11)} L${step.unit.layer} ${step.unit.level.padEnd(9)} ${step.unit.id}${cycle}${step.calls === 0 ? "" : ` calls=${step.calls} ~${step.promptTokens}tok`}`);
  }
  outLine(io, lines.join("\n"));
}

function summaryLines(out: string, result: Awaited<ReturnType<typeof executeRun>>): string[] {
  const { counts, usage } = result;
  const lines = [
    `wrote ${counts.records} record${counts.records === 1 ? "" : "s"} to ${out} (${counts.llm} explained, ${counts.template} templated, ${counts.reused} reused, ${counts.failed} failed, ${counts.skipped} skipped).`,
    `usage: ${counts.calls} call${counts.calls === 1 ? "" : "s"}, ${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens${usage.cost === undefined ? "" : `, $${usage.cost.toFixed(4)}`}.`,
  ];
  for (const failure of result.failures) lines.push(`failed: ${failure.unit}: ${failure.message}`);
  return lines;
}
