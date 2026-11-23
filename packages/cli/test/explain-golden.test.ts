import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDomainFacts, folderFor, loadSqlite, type CodeGraph } from "@codegraph/analyzer";
import {
  EXPLAIN_WALK,
  buildWalk,
  collectUnits,
  contextPackFor,
  createSourceReader,
  decodeInsights,
  memoryBook,
  planRun,
  renderPrompts,
  sqliteInsightsStore,
  stampedBeforeSplit,
  type ContextEnv,
  type InsightRecord,
  type InsightsStore,
  type Level,
  type PlanEnv,
  type PlanOptions,
  type Prompt,
  type RunPlan,
  type Unit,
  type WalkPlan,
} from "@codegraph/insights";
import { fakeLlmClient, promptOverhead, type LlmRequest } from "@codegraph/llm";
import { buildVocabulary, definitionSpeller, rankedWords, type VocabularyArtifact } from "@codegraph/vocabulary";
import { parseInvocation, type ExplainOptions } from "../src/args.js";
import { explainCommand, sidecarPathFor, type ExplainSeam } from "../src/commands/explain.js";
import { EXIT } from "../src/exit.js";
import { captureIo } from "../src/io.js";
import { openAnalysis } from "../src/source.js";
import { resolveView } from "../src/view.js";
import { expectGolden } from "./golden.js";

/**
 * M21a, step 1 (PLAN.md §22.6): DEFAULT `explain` PINNED, before the walk is
 * generalized behind a seam. Per case, under `golden/explain/<case>/`:
 *
 *   plan.jsonl               `explain --dry-run --json`, exploded one step per line
 *   units.txt                every unit's fingerprint AND chain (`planRun(...).hashes`),
 *                            and its pre-split stamp where that differs
 *   prompts.txt|.sha256      every prompt the run sends (user text; system by digest)
 *   prompts-planned.sha256   every prompt the plan renders against an empty store
 *   model.insights.jsonl|.sha256  the side-car of a full run against the fake model
 *
 * and, shared, `system-prompts.txt` and `response-schemas.jsonl` in full. The
 * run goes through `explainCommand` and its seam: a fixed clock and pid, an
 * in-memory disk and store, a fake client that answers from the prompt alone.
 * The chain is not observable through the CLI, so the units come from the
 * engine API wired as explain.ts wires it — and a test pins that wiring to
 * the CLI's plan and side-car. Rewrite: CODEGRAPH_UPDATE_SNAPSHOTS=1.
 */

type Fixture = "java" | "csharp" | "typescript" | "elixir" | "ruby";
type Pin = "full" | "sha256";

interface GoldenCase {
  readonly name: string;
  readonly fixture: Fixture;
  /** Flags after the model path; the run adds nothing but `--no-cache`, the dry run `--dry-run --json`. */
  readonly flags: readonly string[];
  readonly prompts: Pin;
  readonly sidecar: Pin;
}

const CASES: readonly GoldenCase[] = [
  { name: "java", fixture: "java", flags: [], prompts: "full", sidecar: "full" },
  { name: "csharp", fixture: "csharp", flags: [], prompts: "sha256", sidecar: "sha256" },
  { name: "typescript", fixture: "typescript", flags: [], prompts: "sha256", sidecar: "sha256" },
  { name: "elixir", fixture: "elixir", flags: [], prompts: "sha256", sidecar: "sha256" },
  { name: "ruby", fixture: "ruby", flags: [], prompts: "sha256", sidecar: "sha256" },
  // Out-of-scope dependencies: skip-scope, NOT EXPLAINED, `missingDependencies` in the hashes.
  { name: "java-scope-order", fixture: "java", flags: ["--scope", "java:com.acme.order"], prompts: "sha256", sidecar: "sha256" },
  // A cycle wider than --max-scc: one prompt per chunk, the rest shown by signature.
  { name: "java-max-scc-1", fixture: "java", flags: ["--max-scc", "1"], prompts: "sha256", sidecar: "sha256" },
];

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./golden/explain/", import.meta.url));
// The JSONL path, every time: the cache answers the same graph, but a test must not write beside a fixture.
const COMMON = ["--no-cache"] as const;
const NOW = "2026-11-21T00:00:00.000Z";
// A power of two: the eof's sum of per-call costs is exact whatever order a concurrent layer finishes in.
const CALL_COST = 1 / 4096;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface CliStep {
  readonly id: string;
  readonly level: Level;
  readonly members: readonly string[];
  readonly layer: number;
  readonly status: string;
  readonly model: string;
  readonly calls: number;
  readonly promptTokens: number;
}

interface CliPlan {
  readonly kind: string;
  readonly models: { readonly leaf: string; readonly rollup: string };
  readonly estimates: unknown;
  readonly steps: readonly CliStep[];
}

interface CaseResult {
  readonly planText: string;
  readonly cliPlan: CliPlan;
  readonly requests: readonly ParsedRequest[];
  readonly sidecarText: string;
  readonly api: ApiPlan;
}

let cwd = "";
beforeAll(() => {
  cwd = process.cwd();
  // Paths as a user types them at the repo root: the side-car header records the model path verbatim.
  process.chdir(REPO);
});
afterAll(() => process.chdir(cwd));

function optionsOf(argv: readonly string[]): ExplainOptions {
  const invocation = parseInvocation(["explain", ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("not an explain invocation");
  return invocation.options;
}

/** The fixture's source tree in memory, keyed as the seam resolves paths. */
function sourceTree(fixture: Fixture): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(resolve(path), readFileSync(path, "utf8"));
    }
  };
  walk(join(REPO, "fixtures", fixture, "src"));
  return out;
}

function seamFor(sources: ReadonlyMap<string, string>, respond: (request: LlmRequest) => unknown) {
  // A constant usage: the side-car pins records, and prompt bytes stay the prompt goldens' to report.
  const client = fakeLlmClient({ respond, usage: () => ({ promptTokens: 1000, completionTokens: 64, cost: CALL_COST }) });
  const disk = new Map<string, string>(sources);
  const stores = new Map<string, InsightsStore>();
  const seam: ExplainSeam = {
    env: { OPENROUTER_API_KEY: "sk-or-v1-golden" },
    fs: {
      exists: (path) => disk.has(resolve(path)),
      readFile: (path) => disk.get(resolve(path)),
      stat: (path) => {
        const text = disk.get(resolve(path));
        return text === undefined ? undefined : { size: text.length, mtimeMs: 0 };
      },
      writeLinesAtomic: (path, lines) => void disk.set(resolve(path), [...lines].map((line) => `${line}\n`).join("")),
      remove: (path) => void disk.delete(resolve(path)),
    },
    stores: {
      check: () => undefined,
      exists: (path) => stores.has(resolve(path)),
      open: (path) => {
        let store = stores.get(resolve(path));
        if (store === undefined) {
          store = sqliteInsightsStore(loadSqlite().open(":memory:"));
          stores.set(resolve(path), store);
        }
        return { ...store, close: () => undefined };
      },
    },
    pid: 1000,
    isAlive: () => false,
    clientFor: () => client,
    now: () => new Date(NOW),
    confirm: () => Promise.resolve(true),
  };
  return { seam, client, disk, close: () => stores.forEach((store) => store.close()) };
}

/** A sent prompt, located: its unit, and the members it asks a block for (a chunk of a wide cycle). */
interface ParsedRequest {
  readonly request: LlmRequest;
  readonly level: Level;
  readonly cycle: boolean;
  readonly unitId: string;
  readonly chunk: readonly string[];
  readonly sections: ReadonlyMap<string, readonly string[]>;
}

const OTHER_MEMBERS = "## Other members of this cycle (signatures only, explained separately)";
const FENCE_LINE = /````[\w-]*$/u;

function parseRequest(request: LlmRequest, membersOf: ReadonlyMap<string, readonly string[]>): ParsedRequest {
  const schema = /^codegraph_(operation|type|module)(_cycle)?$/u.exec(request.schema.name);
  if (schema === null) throw new Error(`golden fake: unknown schema ${request.schema.name}`);
  const level = schema[1] as Level;
  const lines = request.user.split("\n");
  const prefix = `# Unit: ${level} `;
  const head = lines[0] ?? "";
  if (!head.startsWith(prefix)) throw new Error(`golden fake: no unit line in ${JSON.stringify(head)}`);
  const rest = head.slice(prefix.length);
  const cut = rest.indexOf(" (a cycle of ");
  const unitId = cut < 0 ? rest : rest.slice(0, cut);
  const members = membersOf.get(unitId) ?? [unitId];
  // Member headings outside the corpus fences, before the signatures-only part of a chunked cycle.
  const headings = new Map<string, number>();
  const breaks: number[] = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line === OTHER_MEMBERS) break;
    if (line.startsWith("## ") || line.startsWith("### ")) breaks.push(index);
    if (!line.startsWith("### ")) continue;
    const member = members.find((id) => line.includes(`(${id})`));
    if (member !== undefined && !headings.has(member)) headings.set(member, index);
  }
  const sections = new Map<string, readonly string[]>();
  for (const [member, start] of [...headings].sort((a, b) => a[1] - b[1])) {
    const stop = breaks.find((index) => index > start) ?? lines.length;
    sections.set(member, lines.slice(start + 1, stop));
  }
  return { request, level, cycle: schema[2] !== undefined, unitId, chunk: [...sections.keys()], sections };
}

/** `- \`Ident\`: w1, w2` under "Words to define": word → the identifiers it appears in. */
function wordsAsked(section: readonly string[]): Map<string, string[]> {
  const asked = new Map<string, string[]>();
  const head = section.findIndex((line) => line.startsWith("Words to define in `words`"));
  if (head < 0) return asked;
  for (const line of section.slice(head + 1)) {
    const match = /^- `(.+)`: (.+)$/u.exec(line);
    if (match === null) break;
    for (const word of (match[2] ?? "").split(", ")) asked.set(word, [...(asked.get(word) ?? []), match[1] ?? ""]);
  }
  return asked;
}

/** The top-level `- word` lines under a module's "Words its types define". */
function glossaryAsked(section: readonly string[]): string[] {
  const head = section.findIndex((line) => line.startsWith("Words its types define"));
  if (head < 0) return [];
  const words: string[] = [];
  for (const line of section.slice(head + 1)) {
    const word = /^- (\S+)$/u.exec(line)?.[1];
    if (word !== undefined) words.push(word);
    else if (!line.startsWith("  - ")) break;
  }
  return words;
}

/** A valid block from the prompt alone, so the answers — and the side-car — are a function of the prompts. */
function answer(parsed: ParsedRequest): unknown {
  const blockOf = (id: string, section: readonly string[]): unknown => {
    const short = id.slice(id.lastIndexOf("/") + 1);
    const words = [...wordsAsked(section)].map(([word, identifiers]) => ({ word, in: identifiers, concern: "domain", sense: word, meaning: `${word} in ${short}.`, confidence: 0.5 }));
    switch (parsed.level) {
      case "operation":
        return { name: short, description: `Operation ${short}.`, safe: true, idempotent: null, owner: "entity", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], words, confidence: 0.5 };
      case "type":
        return { name: short, description: `Type ${short}.`, concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: null, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], words, confidence: 0.5 };
      case "module": {
        const glossary = glossaryAsked(section).map((word) => ({ word, concern: "domain", sense: word, meaning: `${word} in ${short}.`, polysemous: false, senses: [] }));
        return { name: short, description: `Module ${short}.`, apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], words, glossary, confidence: 0.5 };
      }
    }
  };
  if (!parsed.cycle) return blockOf(parsed.unitId, parsed.sections.get(parsed.unitId) ?? []);
  return { members: parsed.chunk.map((id) => ({ id, block: blockOf(id, parsed.sections.get(id) ?? []) })) };
}

interface ApiPlan {
  readonly plan: RunPlan;
  readonly walk: WalkPlan;
  readonly env: PlanEnv;
  readonly options: PlanOptions;
  /** Per `llm` step, the prompts the plan rendered for its estimate (an empty store: every dependency NOT EXPLAINED). */
  readonly planned: readonly { readonly unit: Unit; readonly prompts: readonly Prompt[] }[];
  /** Per unit, the fingerprint as stamped before the chain split: what a store paid before 2026-11-18 is reused by. */
  readonly stamped: ReadonlyMap<string, string>;
}

/** explain.ts's `--scope`, restated: a member, or its containing type or module, is named. */
function scopeOf(scope: readonly string[], graph: CodeGraph): ((unit: Unit) => boolean) | undefined {
  if (scope.length === 0) return undefined;
  const wanted = new Set(scope);
  const folder = folderFor(graph);
  return (unit) => unit.members.some((m) => wanted.has(m) || wanted.has(folder.containingType(m) ?? "") || wanted.has(folder.containingModule(m) ?? ""));
}

/** The plan as explain.ts builds it (load, view, dossiers, units, walk, speller, planRun) — pinned to the CLI's by a test below. */
function apiPlan(options: ExplainOptions, models: CliPlan["models"]): ApiPlan {
  expect(options.framework).toBeUndefined();
  const source = openAnalysis(options.models, options, captureIo());
  try {
    const graph = source.graph();
    const view = resolveView(options);
    const facts = buildDomainFacts(graph, { view });
    const units = collectUnits(graph, facts);
    const walk = buildWalk(units, graph, view);
    const root = resolve(options.src ?? graph.union.models[0]?.root ?? ".");
    const reader = createSourceReader((relative) => {
      try {
        return readFileSync(join(root, relative), "utf8");
      } catch {
        return undefined;
      }
    });
    let vocabulary: VocabularyArtifact | undefined;
    const speller = { words: definitionSpeller(graph), ranked: (id: string) => rankedWords((vocabulary ??= buildVocabulary(graph, { view })), id) };
    const env: PlanEnv = { graph, facts, units, reader, unitOf: walk.unitOf, speller, spec: EXPLAIN_WALK };
    const planOptions: PlanOptions = {
      models,
      depth: options.depth,
      maxLines: options.maxLines,
      maxScc: options.maxScc,
      force: options.force,
      maxCalls: options.maxCalls,
      inScope: scopeOf(options.scope, graph),
      terms: options.terms,
      promptOverhead: promptOverhead("openrouter"),
    };
    const plan = planRun(walk, new Map(), env, planOptions);
    const contextEnv: ContextEnv = { ...env, records: memoryBook([], EXPLAIN_WALK), depth: options.depth, maxLines: options.maxLines, terms: options.terms };
    const planned = plan.steps
      .filter((step) => step.status === "llm")
      .map((step) => ({ unit: step.unit, prompts: renderPrompts(contextPackFor(step.unit, contextEnv), options.maxScc) }));
    // planRun's own derivation of the pre-split stamp, which it does not expose; the warm-store test proves it is the one planRun accepts.
    const statusOf = new Map(plan.steps.map((step) => [step.unit.id, step.status]));
    const stamped = new Map<string, string>();
    for (const step of plan.steps) {
      const { unit } = step;
      const missing = unit.deps.filter((dep) => statusOf.get(dep) === "skip-scope" || statusOf.get(dep) === "skip-budget");
      const pack = contextPackFor(unit, contextEnv);
      stamped.set(unit.id, unit.deps.length === 0 ? step.fingerprint : stampedBeforeSplit(pack, step.model, options.depth, unit.deps.map((dep) => stamped.get(dep) ?? ""), missing));
    }
    return { plan, walk, env, options: planOptions, planned, stamped };
  } finally {
    source.close();
  }
}

const results = new Map<string, Promise<CaseResult>>();

/** Each case is computed once, whichever test asks first: a filtered run (-t) still gets everything it needs. */
function resultOf(golden: GoldenCase): Promise<CaseResult> {
  let result = results.get(golden.name);
  if (result === undefined) {
    result = compute(golden);
    results.set(golden.name, result);
  }
  return result;
}

async function compute(golden: GoldenCase): Promise<CaseResult> {
  const model = `fixtures/${golden.fixture}/expected/model.jsonl`;
  const sources = sourceTree(golden.fixture);

  const dry = seamFor(sources, () => {
    throw new Error("a dry run makes no call");
  });
  const planIo = captureIo();
  expect(await explainCommand(optionsOf([model, ...golden.flags, ...COMMON, "--dry-run", "--json"]), planIo, dry.seam)).toBe(EXIT.OK);
  dry.close();
  const planText = planIo.stdout();
  const cliPlan = JSON.parse(planText) as CliPlan;
  const membersOf = new Map(cliPlan.steps.map((step) => [step.id, step.members]));

  const machine = seamFor(sources, (request) => answer(parseRequest(request, membersOf)));
  const runIo = captureIo();
  const code = await explainCommand(optionsOf([model, ...golden.flags, ...COMMON]), runIo, machine.seam);
  expect(code, runIo.stderr()).toBe(EXIT.OK);
  machine.close();
  const sidecarText = machine.disk.get(resolve(sidecarPathFor(model)));
  if (sidecarText === undefined) throw new Error(`no side-car at ${sidecarPathFor(model)}`);

  const order = new Map(cliPlan.steps.map((step, index) => [step.id, index]));
  const requests = machine.client.calls.map((request) => parseRequest(request, membersOf));
  const rank = (parsed: ParsedRequest): readonly [number, number] => [
    order.get(parsed.unitId) ?? Number.POSITIVE_INFINITY,
    (membersOf.get(parsed.unitId) ?? []).indexOf(parsed.chunk[0] ?? ""),
  ];
  // Concurrency 4 interleaves a layer's calls; the set is fixed, the order is not.
  requests.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);

  const api = apiPlan(optionsOf([model, ...golden.flags, ...COMMON]), cliPlan.models);
  return { planText, cliPlan, requests, sidecarText, api };
}

/** One JSON line per step under a head line that keeps every other key in place. */
function explodedPlan(planText: string): string {
  const plan = JSON.parse(planText) as CliPlan;
  const head = JSON.stringify({ ...plan, steps: `${plan.steps.length} steps, one per line below` });
  return `${[head, ...plan.steps.map((step) => JSON.stringify(step))].join("\n")}\n`;
}

function unitsText(api: ApiPlan): string {
  const lines = api.plan.steps.map((step) => {
    const hashes = api.plan.hashes.get(step.unit.id);
    if (hashes === undefined) throw new Error(`no hashes for ${step.unit.id}`);
    const template = step.template === undefined ? "" : ` (${step.template})`;
    const members = step.unit.members.length > 1 ? ` [${step.unit.members.length} members]` : "";
    // The pre-split stamp, shown only where it is not the fingerprint (a leaf's always is).
    const stamp = api.stamped.get(step.unit.id) ?? "?";
    const stamped = stamp === hashes.fingerprint ? "" : ` stamped=${stamp}`;
    return `${step.unit.level} ${step.unit.id}${members} ${step.status}${template} fingerprint=${hashes.fingerprint} chain=${hashes.chain}${stamped}`;
  });
  return `${lines.join("\n")}\n`;
}

const chunkTag = (chunk: readonly string[], members: readonly string[]): string =>
  chunk.length < members.length ? ` chunk(${chunk.join(" ")})` : "";

function promptLine(index: number, level: Level, unitId: string, tag: string, schemaName: string, system: string, user: string): string {
  return `${index + 1} ${level} ${unitId}${tag} ${schemaName} system=${sha256(system).slice(0, 16)} user=${sha256(user)}`;
}

function sentPrompts(golden: GoldenCase, result: CaseResult): string {
  const membersOf = new Map(result.cliPlan.steps.map((step) => [step.id, step.members]));
  if (golden.prompts === "sha256") {
    const lines = result.requests.map((parsed, index) =>
      `${promptLine(index, parsed.level, parsed.unitId, chunkTag(parsed.chunk, membersOf.get(parsed.unitId) ?? []), parsed.request.schema.name, parsed.request.system, parsed.request.user)} model=${parsed.request.model}`,
    );
    return `${lines.join("\n")}\n`;
  }
  const blocks = result.requests.map((parsed, index) => {
    const { request } = parsed;
    const tag = chunkTag(parsed.chunk, membersOf.get(parsed.unitId) ?? []);
    return `=== ${index + 1} ${parsed.level} ${parsed.unitId}${tag} ${request.schema.name} model=${request.model} system=${sha256(request.system).slice(0, 16)}\n${request.user}`;
  });
  return `# The user message of every prompt the run sends, in walk order; system messages: ../system-prompts.txt, by digest.\n${blocks.join("")}`;
}

function plannedPrompts(result: CaseResult): string {
  const lines: string[] = [];
  for (const { unit, prompts } of result.api.planned) {
    for (const prompt of prompts) {
      lines.push(promptLine(lines.length, unit.level, unit.id, chunkTag(prompt.memberIds, unit.members), prompt.schemaName, prompt.system, prompt.user));
    }
  }
  return `${lines.join("\n")}\n`;
}

function sidecarDigest(text: string): string {
  const lines = text.split("\n").filter((line) => line !== "");
  return `${lines
    .map((line) => {
      const record = JSON.parse(line) as { t: string; level?: string; id?: string };
      return record.t === "header" || record.t === "eof" ? line : `${record.t} ${record.level ?? ""} ${record.id ?? ""} sha256=${sha256(line)}`;
    })
    .join("\n")}\n`;
}

const goldenPath = (golden: GoldenCase, file: string): string => join(GOLDEN, golden.name, file);

describe.each(CASES)("explain golden: $name", (golden) => {
  it("--dry-run --json prints the committed plan", { timeout: 120_000 }, async () => {
    const { planText } = await resultOf(golden);
    // One compact line, so the exploded golden below pins every byte of it.
    expect(planText).toBe(`${JSON.stringify(JSON.parse(planText))}\n`);
    expectGolden(goldenPath(golden, "plan.jsonl"), explodedPlan(planText));
  });

  it("every unit keeps its fingerprint and its chain", { timeout: 120_000 }, async () => {
    expectGolden(goldenPath(golden, "units.txt"), unitsText((await resultOf(golden)).api));
  });

  it("every prompt sent is the committed one", { timeout: 120_000 }, async () => {
    const result = await resultOf(golden);
    expect(result.requests.filter((parsed) => parsed.request.user.includes("## Your previous answer was not valid"))).toEqual([]);
    const full = golden.prompts === "full";
    expectGolden(goldenPath(golden, full ? "prompts.txt" : "prompts.sha256"), sentPrompts(golden, result), (line) => line.startsWith("=== "));
  });

  it("every prompt the plan renders is the committed one", { timeout: 120_000 }, async () => {
    expectGolden(goldenPath(golden, "prompts-planned.sha256"), plannedPrompts(await resultOf(golden)));
  });

  it("the side-car of a full run is the committed one", { timeout: 120_000 }, async () => {
    const { sidecarText } = await resultOf(golden);
    const file = decodeInsights(sidecarText);
    expect(file.truncated).toBe(false);
    expect(file.failures).toEqual([]);
    if (golden.sidecar === "full") expectGolden(goldenPath(golden, "model.insights.jsonl"), sidecarText);
    else expectGolden(goldenPath(golden, "model.insights.sha256"), sidecarDigest(sidecarText));
  });

  it("the engine wiring the units come from is explain's: same plan, same fingerprints, same leaf prompts", { timeout: 120_000 }, async () => {
    const { cliPlan, api, sidecarText, requests } = await resultOf(golden);
    expect(
      api.plan.steps.map((s) => ({ id: s.unit.id, level: s.unit.level, members: s.unit.members, layer: s.unit.layer, status: s.status, model: s.model, calls: s.calls, promptTokens: s.promptTokens })),
    ).toEqual(cliPlan.steps);
    expect(JSON.parse(JSON.stringify(api.plan.estimates))).toEqual(cliPlan.estimates);
    // A record carries its unit's run-time fingerprint; on a cold, failure-free run that is the plan's.
    for (const record of decodeInsights(sidecarText).records) {
      const unit = api.walk.unitOf.get(record.id);
      expect(record.fingerprint, record.id).toBe(unit === undefined ? undefined : api.plan.hashes.get(unit.id)?.fingerprint);
    }
    // A unit that quotes nothing sends the very prompt the plan rendered.
    const sent = new Map(requests.map((parsed) => [`${parsed.unitId} ${parsed.chunk.join(" ")}`, parsed.request]));
    let leaves = 0;
    for (const { unit, prompts } of api.planned) {
      if (unit.deps.length > 0) continue;
      for (const prompt of prompts) {
        const request = sent.get(`${unit.id} ${prompt.memberIds.join(" ")}`);
        expect({ system: request?.system, user: request?.user }, unit.id).toEqual({ system: prompt.system, user: prompt.user });
        leaves += 1;
      }
    }
    expect(leaves).toBeGreaterThan(0);
  });

  // A scoped run leaves units without records: "reused whole" needs every unit explained.
  if (!golden.flags.includes("--scope")) {
    it("a store stamped before the chain split is reused whole: no call", { timeout: 120_000 }, async () => {
      const { api, sidecarText } = await resultOf(golden);
      const stampedRecords = decodeInsights(sidecarText).records.map((record): InsightRecord => {
        const unit = api.walk.unitOf.get(record.id);
        return { ...record, fingerprint: (unit === undefined ? undefined : api.stamped.get(unit.id)) ?? "" };
      });
      // Units stamped otherwise than fingerprinted: their reuse below is the stamp's.
      expect(api.plan.steps.filter((step) => api.stamped.get(step.unit.id) !== step.fingerprint).length).toBeGreaterThan(0);
      const warm = planRun(api.walk, new Map(stampedRecords.map((record) => [record.id, record])), api.env, api.options);
      expect(warm.estimates.calls).toBe(0);
      expect(warm.steps.filter((step) => step.status !== "reuse" && step.status !== "template").map((step) => step.unit.id)).toEqual([]);
    });
  }
});

describe("explain golden: what every case shares", () => {
  it("the system messages and response schemas sent are the committed ones", { timeout: 300_000 }, async () => {
    const all = await Promise.all(CASES.map(resultOf));
    const systems = new Map<string, string>();
    const schemas = new Map<string, string>();
    for (const { requests, api } of all) {
      for (const { request } of requests) {
        systems.set(`${request.schema.name} ${sha256(request.system)}`, request.system);
        const schema = JSON.stringify({ name: request.schema.name, schema: request.schema.jsonSchema });
        expect(schemas.get(request.schema.name) ?? schema, request.schema.name).toBe(schema);
        schemas.set(request.schema.name, schema);
      }
      for (const { prompts } of api.planned) for (const prompt of prompts) systems.set(`${prompt.schemaName} ${sha256(prompt.system)}`, prompt.system);
    }
    const sorted = <T>(map: ReadonlyMap<string, T>): [string, T][] => [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // The digest closes its block, so a changed sentence is the first differing line, not the heading.
    expectGolden(
      join(GOLDEN, "system-prompts.txt"),
      sorted(systems).map(([key, text]) => `=== ${key.split(" ")[0]}\n${text}--- sha256=${key.split(" ")[1]}\n`).join(""),
      (line) => line.startsWith("=== "),
    );
    expectGolden(join(GOLDEN, "response-schemas.jsonl"), `${sorted(schemas).map(([, line]) => line).join("\n")}\n`);
  });
});
