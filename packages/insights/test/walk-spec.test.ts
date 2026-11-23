import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { identityView } from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import { contextPackFor, type ContextEnv, type Speller } from "../src/context.js";
import { chainOf, fingerprintOf, type FingerprintInputs } from "../src/fingerprint.js";
import { buildWalk, type Unit } from "../src/order.js";
import { planRun, stampedBeforeSplit, trivialKindOf, unitHashes, type PlanEnv, type PlanOptions } from "../src/plan.js";
import { memoryBook } from "../src/records.js";
import { executeRun, type Completer, type CompletionRequest } from "../src/run.js";
import type { JsonSchema, Level } from "../src/schema.js";
import { createSourceReader, mapReader } from "../src/source.js";
import { UNFILTERED_SELECTION, resolveSelection, type TrivialPolicy } from "../src/selection.js";
import type { WalkSpec } from "../src/spec.js";
import { EXPLAIN, FIXTURE_SRC, edge, graphOf, javaGraph, method, pkg, prepared, toySpeller, type } from "./fixture.js";

/**
 * A SECOND WALK THROUGH THE SEAM (PLAN.md §22.6, step 2). A toy spec — its own
 * system text, a two-field answer, no template, no words, its own quote rule,
 * a fingerprint extra — runs the Java fixture end to end through the engine
 * explain runs on. Whatever it shows of Specy, the engine reached past the spec.
 */

const ToyBlock = z.object({ gist: z.string(), risk: z.enum(["low", "high"]) });
type ToyBlock = z.infer<typeof ToyBlock>;

const TOY: WalkSpec = {
  system: (level, shape) =>
    `TOY WALK. State the gist of this ${level} in one line and rate its risk, low or high.${shape === "scc" ? " Answer `members`, one entry per listed id." : ""}\n`,
  memberLines: () => [],
  answer: { operation: ToyBlock, type: ToyBlock, module: ToyBlock },
  keep: (block) => block,
  quote: (record) => {
    const block = record.block as unknown as ToyBlock;
    return { description: block.gist, concept: `risk ${block.risk}` };
  },
  completionTokens: (_level, blocks) => 50 * Math.max(1, blocks),
  fingerprint: () => ({ walk: "toy", version: "1" }),
};

/** Text only explain's spec says: none of it may reach a toy prompt. */
const EXPLAIN_ONLY = ["Specy", "Domain-Driven", "ubiquitous", "Words to define", "Words its types define", "`words`", "`glossary`", "owned by"];

const OPTIONS: PlanOptions = {
  models: { leaf: "toy-model", rollup: "toy-model" },
  depth: 1,
  maxLines: 200,
  maxScc: 12,
  force: false,
  maxCalls: undefined,
  inScope: undefined,
  terms: 60,
};
const RUN = { maxScc: OPTIONS.maxScc, depth: OPTIONS.depth, maxLines: OPTIONS.maxLines, terms: OPTIONS.terms };

function javaWalk() {
  const { graph, facts, units } = prepared(javaGraph());
  const walk = buildWalk(units, graph);
  const reader = createSourceReader((relative) => {
    try {
      return readFileSync(join(FIXTURE_SRC, relative), "utf8");
    } catch {
      return undefined;
    }
  });
  const base = { graph, facts, units, reader, unitOf: walk.unitOf, speller: toySpeller(graph) };
  return { units, walk, base };
}

/** The unit a request is about: its first line, as the engine lays it out (an id may hold spaces). */
function unitOf(request: CompletionRequest): string {
  const rest = (request.user.split("\n")[0] ?? "").replace(/^# Unit: \w+ /u, "");
  const cut = rest.indexOf(" (a cycle of ");
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** Answers from the request alone; a cycle's members come from the walk, never from parsing ids. */
function toyCompleter(membersOf: (unitId: string) => readonly string[]): Completer & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const blockOf = (id: string): ToyBlock => ({ gist: `Gist of ${id}.`, risk: id.length % 2 === 0 ? "low" : "high" });
  const complete = (async (request: CompletionRequest) => {
    requests.push(request);
    const id = unitOf(request);
    const members = membersOf(id);
    const json = request.schemaName.endsWith("_cycle") ? { members: members.map((member) => ({ id: member, block: blockOf(member) })) } : blockOf(id);
    return { json, model: request.model, usage: { promptTokens: 10, completionTokens: 2 } };
  }) as Completer & { requests: CompletionRequest[] };
  complete.requests = requests;
  return complete;
}

const levelOf = (request: CompletionRequest): Level => request.schemaName.replace(/^codegraph_/u, "").replace(/_cycle$/u, "") as Level;

async function runToy() {
  const { units, walk, base } = javaWalk();
  const env: PlanEnv = { ...base, spec: TOY };
  const plan = planRun(walk, new Map(), env, OPTIONS);
  const completer = toyCompleter((id) => walk.unitOf.get(id)?.members ?? [id]);
  const result = await executeRun(plan, env, new Map(), completer, RUN, { concurrency: 1 });
  return { units, walk, base, env, plan, result, requests: completer.requests };
}

/** One toy run, whichever test asks first: a filtered run (-t) still gets it. */
let cached: ReturnType<typeof runToy> | undefined;
const toyRun = (): ReturnType<typeof runToy> => (cached ??= runToy());

describe("a toy spec runs the Java fixture end to end through the engine", () => {
  it("asks every unit, trivial members included: no step is templated", { timeout: 60_000 }, async () => {
    const { units, walk, plan } = await toyRun();
    const trivial = [...units.operations.values()].filter((op) => op.template !== undefined).map((op) => op.id);
    // Not vacuous: explain would have templated these.
    expect(trivial.length).toBeGreaterThan(0);
    const status = new Map(plan.steps.map((step) => [step.unit.id, step.status]));
    for (const id of trivial) expect(status.get(walk.unitOf.get(id)?.id ?? ""), id).toBe("llm");
    expect(plan.steps.filter((step) => step.template !== undefined)).toEqual([]);
    expect(plan.estimates.byStatus).toEqual({ llm: walk.units.length, template: 0, reuse: 0, "skip-scope": 0, "skip-budget": 0 });
  });

  it("sends the toy's system message and answer schema, and not one word of explain's", { timeout: 60_000 }, async () => {
    const { plan, requests } = await toyRun();
    expect(requests).toHaveLength(plan.estimates.calls);
    expect(requests.some((request) => request.schemaName.endsWith("_cycle"))).toBe(true);
    for (const request of requests) {
      const shape = request.schemaName.endsWith("_cycle") ? "scc" : "block";
      expect(request.system).toBe(TOY.system(levelOf(request), shape));
      for (const text of EXPLAIN_ONLY) {
        expect(request.system, `${request.schemaName} system`).not.toContain(text);
        expect(request.user, `${unitOf(request)} user`).not.toContain(text);
      }
      expect(request.user).not.toContain("## Your previous answer was not valid");
      const properties = (schema: JsonSchema): string[] => Object.keys(schema["properties"] as Record<string, unknown>).sort();
      const members = (request.jsonSchema["properties"] as Record<string, { items: { properties: { block: JsonSchema } } }>)["members"];
      expect(properties(shape === "block" ? request.jsonSchema : (members?.items.properties.block ?? {}))).toEqual(["gist", "risk"]);
    }
  });

  it("records a block for every member, valid against the toy schema and holding nothing else", { timeout: 60_000 }, async () => {
    const { walk, plan, result } = await toyRun();
    expect(result.failures).toEqual([]);
    const members = walk.units.flatMap((unit) => unit.members);
    expect(result.counts).toMatchObject({ records: members.length, llm: members.length, template: 0, failed: 0 });
    expect(result.records.map((record) => record.id).sort()).toEqual([...members].sort());
    for (const record of result.records) {
      expect(record.origin, record.id).toBe("llm");
      expect(z.strictObject(ToyBlock.shape).safeParse(record.block).success, record.id).toBe(true);
      // A cold, failure-free run stamps the plan's fingerprint.
      expect(record.fingerprint).toBe(plan.hashes.get(walk.unitOf.get(record.id)?.id ?? "")?.fingerprint);
    }
  });

  it("quotes a dependency by the toy's rule, and estimates by the toy's constant", { timeout: 60_000 }, async () => {
    const { plan, requests } = await toyRun();
    expect(requests.some((request) => /\[operation, risk (?:low|high)\] \(.+\): Gist of /u.test(request.user))).toBe(true);
    const asked = plan.steps.filter((step) => step.status === "llm").reduce((n, step) => n + step.unit.members.length, 0);
    expect(plan.estimates.completionTokens).toBe(50 * asked);
  });

  it("hashes the toy's extra: no unit keeps explain's fingerprint or chain", { timeout: 60_000 }, async () => {
    const { walk, base, plan } = await toyRun();
    const explain = planRun(walk, new Map(), { ...base, spec: EXPLAIN }, OPTIONS);
    for (const unit of walk.units) {
      const toy = plan.hashes.get(unit.id);
      const theirs = explain.hashes.get(unit.id);
      expect(toy?.fingerprint, unit.id).not.toBe(theirs?.fingerprint);
      expect(toy?.chain, unit.id).not.toBe(theirs?.chain);
    }
  });

  it("re-plans its own records as zero calls", { timeout: 60_000 }, async () => {
    const { walk, env, result } = await toyRun();
    const existing = new Map(result.records.map((record) => [record.id, record]));
    const again = planRun(walk, existing, env, OPTIONS);
    expect(again.estimates.calls).toBe(0);
    expect(again.estimates.byStatus.reuse).toBe(walk.units.length);
    const refusing: Completer = () => Promise.reject(new Error("a reused walk calls nothing"));
    const second = await executeRun(again, env, existing, refusing, RUN, { concurrency: 1 });
    expect(second.counts).toMatchObject({ calls: 0, reused: result.records.length, failed: 0 });
  });

  it("collects no word: a walk without words never asks the speller", { timeout: 60_000 }, () => {
    const { walk, base } = javaWalk();
    const refuse = (): never => {
      throw new Error("the speller was asked");
    };
    const silent: Speller = { words: refuse, ranked: refuse };
    const plan = planRun(walk, new Map(), { ...base, speller: silent, spec: TOY }, OPTIONS);
    expect(plan.steps.length).toBe(walk.units.length);
  });
});

describe("a selection's `trivial` on the toy spec (PLAN.md §22.3): it asks trivial members unless told to skip them", () => {
  function planUnder(spec: WalkSpec, trivial: TrivialPolicy | undefined) {
    const { units, walk, base } = javaWalk();
    const inScope = trivial === undefined ? undefined : resolveSelection({ ...UNFILTERED_SELECTION, trivial }, { graph: base.graph, view: identityView, units, walk, spec }).inScope;
    return { units, walk, base, plan: planRun(walk, new Map(), { ...base, spec }, { ...OPTIONS, inScope }) };
  }

  it("skip: every trivial member is skip-scope and nothing else is; ask: the plan with no predicate", { timeout: 60_000 }, () => {
    const { units, walk, plan: skip } = planUnder(TOY, "skip");
    const trivial = new Set(walk.units.filter((unit) => trivialKindOf(unit, units) !== undefined).map((unit) => unit.id));
    expect(trivial.size).toBe(9);
    for (const step of skip.steps) expect(step.status, step.unit.id).toBe(trivial.has(step.unit.id) ? "skip-scope" : "llm");
    expect(JSON.stringify(planUnder(TOY, "ask").plan)).toBe(JSON.stringify(planUnder(TOY, undefined).plan));
  });

  it("skip: no trivial member reaches the completer, and their types are explained without them", { timeout: 60_000 }, async () => {
    const { units, walk, base, plan } = planUnder(TOY, "skip");
    const completer = toyCompleter((id) => walk.unitOf.get(id)?.members ?? [id]);
    const result = await executeRun(plan, { ...base, spec: TOY }, new Map(), completer, RUN, { concurrency: 1 });
    const trivial = new Set(walk.units.filter((unit) => trivialKindOf(unit, units) !== undefined).map((unit) => unit.id));
    expect(completer.requests.map(unitOf).filter((id) => trivial.has(id))).toEqual([]);
    expect(result.records.filter((record) => trivial.has(record.id))).toEqual([]);
    expect(result.counts).toMatchObject({ skipped: trivial.size, failed: 0 });
  });

  it("a spec that templates them is not moved by it: explain plans the same bytes under skip, ask and no selection", { timeout: 60_000 }, () => {
    const none = JSON.stringify(planUnder(EXPLAIN, undefined).plan);
    expect(JSON.stringify(planUnder(EXPLAIN, "skip").plan)).toBe(none);
    expect(JSON.stringify(planUnder(EXPLAIN, "ask").plan)).toBe(none);
  });
});

describe("the fingerprint slot (PLAN.md §22.1, last row)", () => {
  /** Hashed by the code as it stood before the seam (2026-11-21): the absent slot must keep these bytes. */
  const PINNED: FingerprintInputs = {
    level: "operation",
    members: ["java:p/T.f()"],
    model: "m",
    sources: ["int f() { return 1; }"],
    comments: ["Doc."],
    signatures: ["f()"],
    factsDigest: "d".repeat(64),
    dependencyFingerprints: ["a".repeat(64)],
    missingDependencies: ["java:p/T.g()"],
    depth: 1,
    words: [{ names: [{ identifier: "f", words: ["f"] }], glossary: [] }],
  };

  const P = "java:p";
  const T = "java:p/T";
  const m = (name: string): string => `${T}.${name}()`;

  function packs(spec: WalkSpec) {
    const graph = graphOf([pkg(P), type(T, P), method(m("f"), T), method(m("g"), T)], [edge("invocation", m("f"), m("g"))]);
    const { facts, units } = prepared(graph);
    const walk = buildWalk(units, graph);
    const env: ContextEnv = {
      graph,
      facts,
      units,
      reader: createSourceReader(mapReader(new Map())),
      records: memoryBook([], spec),
      unitOf: walk.unitOf,
      depth: 1,
      maxLines: 50,
      speller: toySpeller(graph),
      terms: 60,
      spec,
    };
    const unit = (id: string): Unit => walk.unitOf.get(id)!;
    return { pack: (id: string) => contextPackFor(unit(id), env), unit };
  }

  /** The inputs as written before the slot existed: no `walk` key at all. */
  function inputsBefore(id: string, spec: WalkSpec, dependencyFingerprints: readonly string[]): FingerprintInputs {
    const { pack, unit } = packs(spec);
    const { sources, comments, signatures, factsDigest, words } = pack(id);
    return { level: unit(id).level, members: unit(id).members, model: "m", sources, comments, signatures, factsDigest, dependencyFingerprints, missingDependencies: [], depth: 1, words };
  }

  it("left empty — explain — every hash keeps its bytes", () => {
    const { words: _, ...chained } = PINNED;
    expect(fingerprintOf(PINNED)).toBe("ed6ccf32826dba948a6783de4ab618411bd68a8ac44a260f4772e2c90c074e1e");
    expect(chainOf(chained)).toBe("dd333cb56cd77bffa2dc95eda2ae59568b5851c70d523752eac7d85bb93be421");

    const { pack } = packs(EXPLAIN);
    const leaf = inputsBefore(m("g"), EXPLAIN, []);
    const { words: __, ...leafChained } = leaf;
    expect(unitHashes(pack(m("g")), "m", 1, [], [])).toEqual({ level: "operation", fingerprint: fingerprintOf(leaf), chain: chainOf(leafChained) });
    const deps = ["b".repeat(64)];
    expect(stampedBeforeSplit(pack(m("f")), "m", 1, deps, [])).toBe(fingerprintOf(inputsBefore(m("f"), EXPLAIN, deps)));
  });

  it("filled, it moves the fingerprint, the chain and the pre-split stamp, by what it says", () => {
    const hashes = (extra: { v: number } | undefined) => {
      const spec: WalkSpec = extra === undefined ? EXPLAIN : { ...EXPLAIN, fingerprint: () => extra };
      const { pack } = packs(spec);
      return { ...unitHashes(pack(m("g")), "m", 1, [], []), stamped: stampedBeforeSplit(pack(m("f")), "m", 1, ["b".repeat(64)], []) };
    };
    const empty = hashes(undefined);
    const one = hashes({ v: 1 });
    const two = hashes({ v: 2 });
    for (const key of ["fingerprint", "chain", "stamped"] as const) {
      expect(one[key], key).not.toBe(empty[key]);
      expect(two[key], key).not.toBe(one[key]);
      expect(hashes({ v: 1 })[key], key).toBe(one[key]);
    }
  });
});
