import type { z } from "zod";
import { contextPackFor, type ContextEnv } from "./context.js";
import type { Unit } from "./order.js";
import { unitFingerprint, type PlanEnv, type PlanStep, type RunPlan } from "./plan.js";
import { renderPrompts, type Prompt } from "./prompt.js";
import {
  BLOCKS,
  clampConfidence,
  responseJsonSchema,
  sccResponseSchema,
  type Block,
  type InsightRecord,
  type JsonSchema,
  type Level,
  type RecordKey,
  type RecordUsage,
} from "./schema.js";
import { sortRecords } from "./sidecar.js";
import { templateBlock } from "./template.js";

/**
 * EXECUTING A PLAN. Layer by layer — every unit in a layer has all its
 * dependencies in earlier layers — with up to `concurrency` model calls in
 * flight inside a layer. Prompts are rendered HERE, against the records
 * produced so far, so a dependency explained a moment ago is already in its
 * dependent's prompt.
 *
 * No I/O of its own: the model call is an injected `Completer` (the CLI wraps
 * an `LlmClient`; tests pass a function), and every finished record is handed
 * to `onRecord` — the CLI's progressive journal write.
 *
 * A malformed answer gets ONE repair re-ask with the validation errors quoted.
 * A unit that still fails is reported and left without a record; its
 * dependents run anyway and see it as NOT EXPLAINED — and because a missing
 * dependency is part of their fingerprint, a later run that explains it will
 * redo them. The result set is the same whatever the concurrency: only the
 * order of calls differs.
 */

export interface CompletionRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly jsonSchema: JsonSchema;
}

export interface Completion {
  readonly json: unknown;
  readonly model: string;
  readonly usage?: RecordUsage;
}

export type Completer = (request: CompletionRequest) => Promise<Completion>;

export interface StepEvent {
  readonly step: PlanStep;
  readonly outcome: "done" | "failed" | "skipped";
  readonly calls: number;
  readonly usage: RunUsage;
  readonly error?: string;
}

export interface RunHooks {
  readonly concurrency: number;
  readonly onRecord?: (record: InsightRecord, step: PlanStep) => void | Promise<void>;
  readonly onStep?: (event: StepEvent) => void;
  /** After every layer has settled — where the CLI rewrites the sorted side-car. */
  readonly onLayer?: (layer: number, records: readonly InsightRecord[]) => void | Promise<void>;
}

export interface RunOptions {
  readonly maxScc: number;
  readonly depth: number;
  readonly maxLines: number;
  /** The natural key per entity id, when the caller has it. */
  readonly keyOf?: (id: string) => RecordKey | undefined;
}

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  cost: number | undefined;
}

export interface RunFailure {
  readonly unit: string;
  readonly message: string;
}

export interface RunResult {
  /** Existing records carried over plus everything produced, sorted. */
  readonly records: readonly InsightRecord[];
  readonly counts: {
    readonly records: number;
    readonly llm: number;
    readonly template: number;
    readonly reused: number;
    readonly failed: number;
    readonly skipped: number;
    readonly calls: number;
  };
  readonly usage: RunUsage;
  readonly failures: readonly RunFailure[];
}

export class RunAborted extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunAborted";
  }
}

function addUsage(total: RunUsage, usage: RecordUsage | undefined): void {
  if (usage === undefined) return;
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  if (usage.cost !== undefined) total.cost = (total.cost ?? 0) + usage.cost;
}

/** Share one call's usage across the members it explained. */
function splitUsage(usage: RecordUsage | undefined, parts: number): RecordUsage | undefined {
  if (usage === undefined || parts <= 1) return usage;
  return {
    promptTokens: Math.round(usage.promptTokens / parts),
    completionTokens: Math.round(usage.completionTokens / parts),
    ...(usage.cost === undefined ? {} : { cost: usage.cost / parts }),
  };
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Validate one answer; returns the blocks by member id or the validation message. */
function parseAnswer(level: Level, prompt: Prompt, json: unknown): { blocks: Map<string, Block> } | { error: string } {
  if (prompt.shape === "block") {
    const parsed = BLOCKS[level].safeParse(json);
    if (!parsed.success) return { error: issuesOf(parsed.error) };
    return { blocks: new Map([[prompt.memberIds[0] ?? "", clampConfidence(parsed.data as Block)]]) };
  }
  const parsed = sccResponseSchema(level).safeParse(json);
  if (!parsed.success) return { error: issuesOf(parsed.error) };
  const blocks = new Map<string, Block>();
  for (const member of parsed.data.members) blocks.set(member.id, clampConfidence(member.block as Block));
  const missing = prompt.memberIds.filter((id) => !blocks.has(id));
  if (missing.length > 0) return { error: `no entry for member id(s): ${missing.join(", ")}` };
  return { blocks };
}

export async function executeRun(
  plan: RunPlan,
  env: PlanEnv,
  existing: ReadonlyMap<string, InsightRecord>,
  complete: Completer,
  options: RunOptions,
  hooks: RunHooks,
): Promise<RunResult> {
  const live = new Map<string, InsightRecord>(existing);
  const usage: RunUsage = { promptTokens: 0, completionTokens: 0, cost: undefined };
  const failures: RunFailure[] = [];
  const counts = { llm: 0, template: 0, reused: 0, failed: 0, skipped: 0, calls: 0 };
  const contextEnv = (): ContextEnv => ({ ...env, records: live, depth: options.depth, maxLines: options.maxLines });

  const describe = (id: string): { kind: string; name: string | undefined; file: string | undefined } => {
    const op = env.units.operations.get(id);
    if (op !== undefined) return { kind: op.fact.kind, name: op.fact.name, file: op.fact.anchor?.file };
    const type = env.units.types.get(id);
    if (type !== undefined) return { kind: type.kind, name: type.name, file: type.anchor?.file };
    const module = env.units.modules.get(id);
    return { kind: env.graph.entity(id)?.kind ?? "module", name: module?.name, file: undefined };
  };

  const record = (unit: Unit, id: string, block: Block, fingerprint: string, origin: "llm" | "template", model: string | undefined, callUsage: RecordUsage | undefined): InsightRecord => {
    const meta = describe(id);
    const key = options.keyOf?.(id);
    return {
      t: "i",
      id,
      ...(key === undefined ? {} : { key }),
      level: unit.level,
      kind: meta.kind,
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(meta.file === undefined ? {} : { file: meta.file }),
      ...(unit.members.length > 1 ? { scc: unit.members } : {}),
      origin,
      block,
      fingerprint,
      ...(model === undefined ? {} : { model }),
      ...(callUsage === undefined ? {} : { usage: callUsage }),
    } as InsightRecord;
  };

  const emit = async (rec: InsightRecord, step: PlanStep): Promise<void> => {
    live.set(rec.id, rec);
    await hooks.onRecord?.(rec, step);
  };

  const runStep = async (step: PlanStep): Promise<void> => {
    const { unit } = step;
    const stepUsage: RunUsage = { promptTokens: 0, completionTokens: 0, cost: undefined };
    switch (step.status) {
      case "template": {
        const id = unit.members[0] ?? "";
        const op = env.units.operations.get(id)!;
        const block = templateBlock(op, step.template!, env.units.types.get(op.typeId)!);
        await emit(record(unit, id, block, step.fingerprint, "template", undefined, undefined), step);
        counts.template += 1;
        hooks.onStep?.({ step, outcome: "done", calls: 0, usage: stepUsage });
        return;
      }
      case "reuse":
        counts.reused += unit.members.length;
        hooks.onStep?.({ step, outcome: "done", calls: 0, usage: stepUsage });
        return;
      case "skip-scope":
      case "skip-budget":
        counts.skipped += 1;
        hooks.onStep?.({ step, outcome: "skipped", calls: 0, usage: stepUsage });
        return;
      case "llm":
        break;
    }

    const pack = contextPackFor(unit, contextEnv());
    const prompts = renderPrompts(pack, options.maxScc);
    // The run-time fingerprint: a dependency that failed is missing too.
    const missing = unit.deps.filter((d) => {
      const dep = env.unitOf.get(d);
      return dep === undefined || dep.members.some((member) => !live.has(member));
    });
    const fingerprint = unitFingerprint(pack, step.model, options.depth, unit.deps.map((d) => plan.fingerprints.get(d) ?? ""), missing);
    const produced: InsightRecord[] = [];
    let calls = 0;
    try {
      for (const prompt of prompts) {
        const jsonSchema = responseJsonSchema(unit.level, prompt.shape);
        const request: CompletionRequest = { model: step.model, system: prompt.system, user: prompt.user, schemaName: prompt.schemaName, jsonSchema };
        let completion = await complete(request);
        calls += 1;
        addUsage(stepUsage, completion.usage);
        let answer = parseAnswer(unit.level, prompt, completion.json);
        if ("error" in answer) {
          // One repair re-ask: the same prompt plus what was wrong with the answer.
          completion = await complete({
            ...request,
            user: `${prompt.user}\n## Your previous answer was not valid\n${answer.error}\nReturn only the corrected JSON document.\n`,
          });
          calls += 1;
          addUsage(stepUsage, completion.usage);
          answer = parseAnswer(unit.level, prompt, completion.json);
          if ("error" in answer) throw new RunAborted(`invalid answer after repair: ${answer.error}`);
        }
        const share = splitUsage(completion.usage, answer.blocks.size);
        for (const [id, block] of answer.blocks) produced.push(record(unit, id, block, fingerprint, "llm", completion.model, share));
      }
    } catch (error) {
      counts.calls += calls;
      addUsage(usage, { promptTokens: stepUsage.promptTokens, completionTokens: stepUsage.completionTokens, ...(stepUsage.cost === undefined ? {} : { cost: stepUsage.cost }) });
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ unit: unit.id, message });
      hooks.onStep?.({ step, outcome: "failed", calls, usage: stepUsage, error: message });
      return;
    }
    // Only a fully answered unit is recorded: half a cycle would be a lie about the other half.
    for (const rec of produced) await emit(rec, step);
    counts.llm += produced.length;
    counts.calls += calls;
    addUsage(usage, { promptTokens: stepUsage.promptTokens, completionTokens: stepUsage.completionTokens, ...(stepUsage.cost === undefined ? {} : { cost: stepUsage.cost }) });
    hooks.onStep?.({ step, outcome: "done", calls, usage: stepUsage });
  };

  const byLayer = new Map<number, PlanStep[]>();
  for (const step of plan.steps) {
    const bucket = byLayer.get(step.unit.layer);
    if (bucket === undefined) byLayer.set(step.unit.layer, [step]);
    else bucket.push(step);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const width = Math.max(1, hooks.concurrency);
  for (const layer of layers) {
    const steps = byLayer.get(layer) ?? [];
    // A small worker pool: `width` steps in flight, taken in plan order.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < steps.length) {
        const step = steps[next];
        next += 1;
        if (step !== undefined) await runStep(step);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, steps.length) }, worker));
    await hooks.onLayer?.(layer, sortRecords(live.values()));
  }

  const records = sortRecords(live.values());
  return {
    records,
    counts: { records: records.length, ...counts },
    usage,
    failures,
  };
}
