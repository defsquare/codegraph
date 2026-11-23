import { describe, expect, it } from "vitest";
import { parseSelector, type Selector } from "@codegraph/analyzer";
import { contextPackFor, type ContextEnv } from "../src/context.js";
import {
  EXPLAIN_WALK_DEFINITION,
  MEMBER_INSTRUCTIONS,
  WALK_DEFINITION_KIND,
  WalkDefinitionError,
  customizeExplain,
  parseExplainFile,
  type DefinitionIssue,
  type ExplainCustomization,
} from "../src/definition.js";
import { EXPLAIN_WALK, systemPrompt } from "../src/explain-spec.js";
import { planRun, stampedBeforeSplit, trivialKindOf, type RunPlan } from "../src/plan.js";
import { renderPrompts, type Prompt } from "../src/prompt.js";
import { memoryBook } from "../src/records.js";
import { INSIGHTS_METAMODEL, LEVELS, PROMPT_VERSION } from "../src/schema.js";
import { UNFILTERED_SELECTION } from "../src/selection.js";
import type { WalkSpec } from "../src/spec.js";
import { WALK_OPTIONS, dependentsClosure, javaWalk, moved, ruleOne, unitsWith } from "./definition-fixture.js";

/**
 * EXPLAIN, CUSTOMIZED (PLAN.md §22.5): a selection, a context and instructions
 * added to explain's prompt — never its task nor its Specy answer. With nothing
 * given it IS explain, every hash and every byte; given something, it moves
 * exactly the fingerprints of what it touches.
 */

const BASKET = "java:com.acme.order/Basket";
const K = { kind: WALK_DEFINITION_KIND } as const;

interface Hashed {
  readonly plan: RunPlan;
  readonly stamped: ReadonlyMap<string, string>;
  readonly prompts: ReadonlyMap<string, readonly Prompt[]>;
}

/** Fingerprint and chain (the plan), the pre-split stamp (as planRun derives it), and every unit's prompts against an empty store. */
function hashed(spec: WalkSpec): Hashed {
  const { walk, base } = javaWalk();
  const env = { ...base, spec };
  const plan = planRun(walk, new Map(), env, WALK_OPTIONS);
  const context: ContextEnv = { ...env, records: memoryBook([], spec), depth: WALK_OPTIONS.depth, maxLines: WALK_OPTIONS.maxLines, terms: WALK_OPTIONS.terms };
  const status = new Map(plan.steps.map((step) => [step.unit.id, step.status]));
  const stamped = new Map<string, string>();
  const prompts = new Map<string, readonly Prompt[]>();
  for (const step of plan.steps) {
    const { unit } = step;
    const pack = contextPackFor(unit, context);
    const missing = unit.deps.filter((dep) => status.get(dep) === "skip-scope" || status.get(dep) === "skip-budget");
    stamped.set(unit.id, unit.deps.length === 0 ? step.fingerprint : stampedBeforeSplit(pack, step.model, WALK_OPTIONS.depth, unit.deps.map((dep) => stamped.get(dep) ?? ""), missing));
    prompts.set(unit.id, renderPrompts(pack, WALK_OPTIONS.maxScc));
  }
  return { plan, stamped, prompts };
}

let explainHashes: Hashed | undefined;
const explain = (): Hashed => (explainHashes ??= hashed(EXPLAIN_WALK));

const customized = (customization: ExplainCustomization): WalkSpec => customizeExplain(EXPLAIN_WALK, customization, javaWalk().entityEnv);
const at = (selector: Selector, instructions: string) => ({ select: selector, instructions });

/** Templated units send no prompt, so nothing a customization adds can reach them: they never carry it. */
function templated(): Set<string> {
  const { walk, base } = javaWalk();
  return new Set(walk.units.filter((unit) => trivialKindOf(unit, base.units) !== undefined).map((unit) => unit.id));
}

describe("explain customized with nothing is explain", () => {
  it("returns explain's own spec", () => {
    expect(customized({})).toBe(EXPLAIN_WALK);
    expect(customized({ instructions: " \n", entities: [] })).toBe(EXPLAIN_WALK);
  });

  it("entity instructions that select nothing: a spec of its own, yet every fingerprint, chain, stamp and prompt is explain's", { timeout: 60_000 }, () => {
    const spec = customized({ entities: [at({ type: "id", id: "java:nowhere/Nothing" }, "Never shown.")] });
    expect(spec).not.toBe(EXPLAIN_WALK);
    const mine = hashed(spec);
    const theirs = explain();
    expect([...mine.plan.hashes]).toEqual([...theirs.plan.hashes]);
    expect([...mine.stamped]).toEqual([...theirs.stamped]);
    expect([...mine.stamped].filter(([id, stamp]) => stamp !== mine.plan.hashes.get(id)?.fingerprint).length).toBeGreaterThan(0);
    expect([...mine.prompts]).toEqual([...theirs.prompts]);
  });
});

describe("explain customized with something moves exactly what it touches", () => {
  it("instructions: appended to every system message; every unit asked moves, a templated one cannot", { timeout: 60_000 }, () => {
    const spec = customized({ instructions: "  Name the bounded context.\n" });
    expect(spec.system("type", "scc")).toBe(`${systemPrompt("type", "scc")}\n## Instructions\nName the bounded context.\n`);
    const mine = hashed(spec);
    const theirs = explain();
    const all = new Set(javaWalk().walk.units.map((unit) => unit.id));
    const asked = new Set([...all].filter((id) => !templated().has(id)));
    expect(moved(theirs.plan, mine.plan)).toEqual(asked);
    expect(moved(theirs.plan, mine.plan, "chain")).toEqual(asked);
    // The user messages are untouched: instructions live in the system message.
    for (const [id, prompts] of mine.prompts) expect(prompts.map((p) => p.user), id).toEqual(theirs.prompts.get(id)?.map((p) => p.user));
  });

  it("entity instructions: rule 1's members and their transitive dependents move, nothing else; the lines close the member's section after explain's", { timeout: 60_000 }, () => {
    const select: Selector = { type: "id", id: BASKET };
    const spec = customized({ entities: [at(select, "Basket is the cart.")] });
    const mine = hashed(spec);
    const theirs = explain();
    const { walk, graph } = javaWalk();
    const touched = new Set([...unitsWith(walk, ruleOne(graph, select))].filter((id) => !templated().has(id)));
    expect(touched.size).toBeGreaterThan(1);
    const expected = dependentsClosure(walk, touched);
    expect(expected.size).toBeLessThan(walk.units.length);
    expect(moved(theirs.plan, mine.plan)).toEqual(expected);
    expect(moved(theirs.plan, mine.plan, "chain")).toEqual(expected);
    for (const [id, prompts] of mine.prompts) {
      // A templated unit's prompt is never sent: it is not compared.
      if (templated().has(id)) continue;
      const users = prompts.map((p) => p.user);
      const before = theirs.prompts.get(id)?.map((p) => p.user) ?? [];
      if (!touched.has(id)) {
        expect(users, id).toEqual(before);
        continue;
      }
      for (const user of users) expect(user).toContain(`${MEMBER_INSTRUCTIONS}\n- Basket is the cart.\n`);
    }
    // After explain's own closing lines: the words to define come first.
    const add = mine.prompts.get(walk.units.find((u) => u.id.startsWith(`${BASKET}.add(`))?.id ?? "")?.[0]?.user ?? "";
    expect(add.indexOf("Words to define")).toBeGreaterThan(0);
    expect(add.indexOf(MEMBER_INSTRUCTIONS)).toBeGreaterThan(add.indexOf("Words to define"));
  });

  it("editing an entity instruction's text, or the instructions', moves the same units again: the text is hashed, not only its presence", { timeout: 60_000 }, () => {
    const select: Selector = { type: "id", id: BASKET };
    const one = hashed(customized({ entities: [at(select, "Basket is the cart.")] }));
    const two = hashed(customized({ entities: [at(select, "Basket is the trolley.")] }));
    const { walk, graph } = javaWalk();
    const touched = new Set([...unitsWith(walk, ruleOne(graph, select))].filter((id) => !templated().has(id)));
    expect(moved(one.plan, two.plan)).toEqual(dependentsClosure(walk, touched));
    const asked = new Set(walk.units.map((unit) => unit.id).filter((id) => !templated().has(id)));
    expect(moved(hashed(customized({ instructions: "One." })).plan, hashed(customized({ instructions: "Two." })).plan)).toEqual(asked);
  });

  it("validates what it is handed, with the path a definition file would carry", () => {
    expect(() => customized({ instructions: "````" })).toThrow(WalkDefinitionError);
    expect(() => customized({ entities: [at({ type: "kind", kind: "method" }, " ")] })).toThrow(/prompt\.entities\[0\]\.instructions: must not be empty/u);
  });
});

function explainIssues(json: unknown): readonly DefinitionIssue[] {
  try {
    parseExplainFile(json);
  } catch (error) {
    expect(error).toBeInstanceOf(WalkDefinitionError);
    return (error as WalkDefinitionError).issues;
  }
  throw new Error(`accepted: ${JSON.stringify(json)}`);
}

describe("a definition file handed to explain (`explain --walk FILE`)", () => {
  it("explain's printable form is accepted, and changes nothing", () => {
    const file = parseExplainFile(EXPLAIN_WALK_DEFINITION);
    expect(file.selection).toEqual({ ...UNFILTERED_SELECTION, levels: [...LEVELS] });
    expect(file.context).toEqual({ depth: 1, maxLines: 200, source: true });
    expect(file.customization).toEqual({ instructions: "", entities: [] });
    expect(customized(file.customization)).toBe(EXPLAIN_WALK);
  });

  it("may set the selection, the context and the instructions — trivial members stay explain's (templated)", () => {
    const file = parseExplainFile({
      ...K,
      levels: ["type", "operation"],
      select: { module: "com.acme.order**" },
      exclude: { file: "**/legacy/**" },
      closure: "dependencies",
      context: { depth: 2, maxLines: 80 },
      prompt: { instructions: "Name the context.", entities: [{ select: { id: BASKET }, instructions: "Basket is the cart." }] },
    });
    expect(file.selection).toEqual({
      include: [parseSelector({ module: "com.acme.order**" })],
      exclude: [parseSelector({ file: "**/legacy/**" })],
      levels: ["operation", "type"],
      closure: "dependencies",
      trivial: "ask",
    });
    expect(file.context).toEqual({ depth: 2, maxLines: 80, source: true });
    expect(file.customization).toEqual({ instructions: "Name the context.", entities: [{ select: parseSelector({ id: BASKET }), instructions: "Basket is the cart." }] });
  });

  const REFUSED: readonly (readonly [string, unknown, string, RegExp])[] = [
    ["a task", { ...K, prompt: { task: "Find SQL." } }, "prompt.task", /explain asks its own task.*codegraph walk --walk/],
    ["fields", { ...K, answer: { fields: { operation: { risky: "boolean" } } } }, "answer.fields", /Specy blocks \(specy\.domain\/3\)/],
    ["a label", { ...K, answer: { label: "risky" } }, "answer.label", /Specy blocks/],
    ["another builtin", { ...K, answer: { builtin: "other/1" } }, "answer.builtin", /explain's answer is "specy\.domain\/3"/],
    ["trivial", { ...K, trivial: "skip" }, "trivial", /templates trivial members/],
    ["another name", { ...K, name: "domain" }, "name", /explain's walk is named "explain".*codegraph walk/],
    ["another version", { ...K, version: "3" }, "version", /prompt version, "2".*--force/],
    ["an unknown key, as any file", { ...K, filter: {} }, "filter", /unknown key "filter"/],
    ["a bad selector, as any file", { ...K, prompt: { entities: [{ select: { edge: { kind: "calls" } }, instructions: "x" }] } }, "prompt.entities[0].select.edge.kind", /unknown edge kind/],
  ];

  it.each(REFUSED)("refuses %s", (_what, json, path, gist) => {
    const issues = explainIssues(json);
    const found = issues.find((issue) => issue.path === path);
    expect(found, JSON.stringify(issues)).toBeDefined();
    expect(found?.message).toMatch(gist);
  });

  it("restating the built-in exactly is no customization", () => {
    expect(PROMPT_VERSION).toBe("2");
    const file = parseExplainFile({ ...K, name: "explain", version: PROMPT_VERSION, answer: { builtin: INSIGHTS_METAMODEL } });
    expect(file.customization).toEqual({ instructions: "", entities: [] });
  });
});
