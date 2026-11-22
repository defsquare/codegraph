import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileSelector, identityView, parseSelector } from "@codegraph/analyzer";
import {
  DEFAULT_TASKS,
  DEFAULT_WALK_DEFINITION,
  EXPLAIN_WALK_DEFINITION,
  GENERIC_RULES,
  MEMBER_INSTRUCTIONS,
  WALK_COMPLETION_TOKENS_PER_BLOCK,
  WALK_DEFINITION_KIND,
  WalkDefinitionError,
  compileDefinition,
  definitionDigest,
  definitionToJson,
  parseWalkDefinition,
  type DefinitionIssue,
  type WalkDefinitionJson,
} from "../src/definition.js";
import { FENCE } from "../src/prompt.js";
import { planRun } from "../src/plan.js";
import { memoryBook } from "../src/records.js";
import { executeRun } from "../src/run.js";
import { INSIGHTS_METAMODEL, LEVELS, PROMPT_VERSION, strictJsonSchema, type InsightRecord, type Level } from "../src/schema.js";
import { UNFILTERED_SELECTION, resolveSelection } from "../src/selection.js";
import { trivialKindOf } from "../src/plan.js";
import { RUN_OPTIONS, WALK_OPTIONS, javaWalk, ruleOne, schemaCompleter, unitIdOf } from "./definition-fixture.js";

/**
 * WALK DEFINITIONS (PLAN.md §22.2, §22.6 step 5): `codegraph.walk/1` parsed,
 * checked with the path of every fault, resolved with its defaults, digested,
 * printed, and compiled into a spec and a selection that run the Java fixture
 * end to end. Properties over generated definitions: definition-properties.test.ts;
 * explain, customized: explain-custom.test.ts.
 */

const K = { kind: WALK_DEFINITION_KIND } as const;

/** §22.2's example, verbatim. */
const EXAMPLE = {
  kind: "codegraph.walk/1",
  name: "tx-boundaries",
  version: "1",
  levels: ["operation", "type"],
  select: { any: [{ edge: { kind: "annotationUse", to: { name: "Transactional" } } }] },
  closure: "none",
  trivial: "skip",
  context: { depth: 1, maxLines: 200, source: true },
  prompt: {
    task: { operation: "Say where the transaction starts and ends…", type: "…" },
    instructions: "Answer in English. Name the isolation level when the code states it.",
    entities: [{ select: { module: "com.acme.billing**" }, instructions: "Billing uses two datasources; say which one." }],
  },
  answer: {
    label: "boundary",
    fields: { operation: { boundary: { enum: ["starts", "joins", "none"] }, risks: "string[]" } },
  },
} as const;

function issuesOf(json: unknown): readonly DefinitionIssue[] {
  try {
    parseWalkDefinition(json);
  } catch (error) {
    expect(error).toBeInstanceOf(WalkDefinitionError);
    return (error as WalkDefinitionError).issues;
  }
  throw new Error(`accepted: ${JSON.stringify(json)}`);
}

const fieldsAt = (fields: unknown) => ({ ...K, answer: { fields: { operation: fields } } });
const entity = (select: unknown, instructions = "Say which datasource.") => ({ ...K, prompt: { entities: [{ select, instructions }] } });

/** [what, file, the path of the fault, the gist of its message]. */
const INVALID: readonly (readonly [string, unknown, string, RegExp])[] = [
  ["not an object", [], "", /a walk definition is a JSON object; got an array/],
  ["no kind", {}, "kind", /required: "codegraph\.walk\/1"/],
  ["another kind", { kind: "codegraph.walk/2" }, "kind", /expected "codegraph\.walk\/1".*got the string "codegraph\.walk\/2"/],
  ["unknown key", { ...K, filter: { kind: "method" } }, "filter", /unknown key "filter"; valid keys: kind, name, version, levels, select, exclude, closure, trivial, context, prompt, answer/],
  ["unknown key, nested", { ...K, prompt: { tasks: "x" } }, "prompt.tasks", /unknown key "tasks"; valid keys: task, instructions, entities/],
  ["wrong type", { ...K, version: 1 }, "version", /expected a version string, got the number 1/],
  ["wrong type, nested", { ...K, context: { depth: "1" } }, "context.depth", /expected an integer of at least 1, got the string "1"/],
  ["a depth below 1", { ...K, context: { depth: 0 } }, "context.depth", /^must be at least 1$/],
  ["a maxLines that is no integer", { ...K, context: { maxLines: 1.5 } }, "context.maxLines", /expected an integer of at least 1, got the number 1\.5/],
  ["bad name", { ...K, name: "Tx_Boundaries" }, "name", /\[a-z\]\[a-z0-9-\]\*.*got "Tx_Boundaries"/],
  ["reserved name: explain", { ...K, name: "explain" }, "name", /"explain" is reserved.*built-in/],
  ["reserved name: insights", { ...K, name: "insights" }, "name", /"insights" is reserved.*insights\.db/],
  ["empty version", { ...K, version: " " }, "version", /must not be empty/],
  ["unknown level", { ...K, levels: ["operation", "class"] }, "levels[1]", /unknown level "class"; valid: operation, type, module/],
  ["empty levels", { ...K, levels: [] }, "levels", /at least one level/],
  ["a level twice", { ...K, levels: ["type", "type"] }, "levels[1]", /"type" is listed twice/],
  ["bad closure", { ...K, closure: "deps" }, "closure", /unknown closure "deps"; valid: none, dependencies, containers, all/],
  ["bad trivial", { ...K, trivial: "never" }, "trivial", /unknown trivial policy "never"; valid: skip, ask/],
  ["source left out", { ...K, context: { source: false } }, "context.source", /not supported/],
  ["bad selector", { ...K, select: { kinds: "method" } }, "select", /unknown selector key "kinds"/],
  ["bad exclude", { ...K, exclude: { kind: "klass" } }, "exclude.kind", /unknown kind "klass"/],
  ["bad selector deep inside entities", entity({ any: [{ kind: "method" }, { edge: { kind: "calls" } }] }), "prompt.entities[0].select.any[1].edge.kind", /unknown edge kind "calls"; valid: /],
  ["an entity without a selector", { ...K, prompt: { entities: [{ instructions: "x" }] } }, "prompt.entities[0].select", /required/],
  ["an entity without instructions", entity({ kind: "method" }, "  "), "prompt.entities[0].instructions", /must not be empty/],
  ["an empty task", { ...K, prompt: { task: "" } }, "prompt.task", /must not be empty/],
  ["a task for an unknown level", { ...K, prompt: { task: { operations: "x" } } }, "prompt.task.operations", /unknown key "operations"; valid keys: operation, type, module/],
  ["a task of the wrong type", { ...K, prompt: { task: 3 } }, "prompt.task", /a task is a string .* or an object/],
  ["a fence in the instructions", { ...K, prompt: { instructions: "Quote it as ````java x````." } }, "prompt.instructions", /four backticks/],
  ["a fence in a task", { ...K, prompt: { task: { type: "````" } } }, "prompt.task.type", /four backticks/],
  ["a fence in an entity's instructions", entity({ kind: "method" }, "Show ````sql"), "prompt.entities[0].instructions", /four backticks/],
  ["fields for an unknown level", { ...K, answer: { fields: { operations: {} } } }, "answer.fields.operations", /unknown key "operations"; valid keys: operation, type, module/],
  ["a reserved field", fieldsAt({ confidence: "number" }), "answer.fields.operation.confidence", /"confidence" is reserved/],
  ["a reserved field: words", fieldsAt({ words: "string[]" }), "answer.fields.operation.words", /"words" is reserved/],
  // The store's generated `concept` column reads `$.concept` of ANY block: a field of that name would fill explain's index.
  ["a reserved field: concept", { ...K, answer: { fields: { type: { concept: "string" } } } }, "answer.fields.type.concept", /"concept" is reserved.*concept column/],
  ["a field name that is no identifier", fieldsAt({ "risk level": "string" }), "answer.fields.operation.risk level", /identifier/],
  ["an unknown field type", fieldsAt({ boundary: "int" }), "answer.fields.operation.boundary", /unknown field type "int"/],
  ["a field type of the wrong JSON type", fieldsAt({ boundary: 3 }), "answer.fields.operation.boundary", /a field type is "string", "number", "boolean", "string\[\]"/],
  ["two forms in one field", fieldsAt({ b: { type: "string", enum: ["a"] } }), "answer.fields.operation.b", /exactly one of "type", "enum", "list"/],
  ["nullable not a boolean", fieldsAt({ b: { type: "string", nullable: "yes" } }), "answer.fields.operation.b.nullable", /true or false/],
  ["an unknown key in a field", fieldsAt({ b: { type: "string", optional: true } }), "answer.fields.operation.b.optional", /unknown key "optional"/],
  ["an empty enum", fieldsAt({ b: { enum: [] } }), "answer.fields.operation.b.enum", /at least one value/],
  ["an enum value twice", fieldsAt({ b: { enum: ["a", "a"] } }), "answer.fields.operation.b.enum[1]", /"a" is listed twice/],
  ["an empty list", fieldsAt({ b: { list: {} } }), "answer.fields.operation.b.list", /at least one field/],
  ["a nested list", fieldsAt({ b: { list: { inner: { list: { x: "string" } } } } }), "answer.fields.operation.b.list.inner", /does not nest/],
  ["a string[] in a list", fieldsAt({ b: { list: { tags: "string[]" } } }), "answer.fields.operation.b.list.tags", /scalars and enums only/],
  ["a label naming no field", { ...K, answer: { label: "boundary", fields: { operation: { risks: "string[]" } } } }, "answer.label", /names no declared field.*declared: operation\.risks/],
  ["a label on a list", { ...K, answer: { label: "risks", fields: { operation: { risks: "string[]" } } } }, "answer.label", /scalar/],
  ["a claimed builtin answer", { ...K, answer: { builtin: INSIGHTS_METAMODEL } }, "answer.builtin", /built-in explain.*codegraph explain --walk/],
  ["another builtin", { ...K, answer: { builtin: "x/1" } }, "answer.builtin", /may not claim/],
];

describe("a definition file is checked on its own: every fault with its path and what to do", () => {
  it.each(INVALID)("%s", (_what, json, path, gist) => {
    const issues = issuesOf(json);
    const found = issues.find((issue) => issue.path === path);
    expect(found, JSON.stringify(issues)).toBeDefined();
    expect(found?.message).toMatch(gist);
  });

  it("two passes: a structural fault is reported first, alone with its kind", () => {
    expect(issuesOf({ ...K, name: "X", extra: 1 }).map((issue) => issue.path)).toEqual(["extra"]);
  });

  it("one error type for the file; its message names every fault's path", () => {
    let caught: unknown;
    try {
      parseWalkDefinition({ ...K, name: "X", levels: [], prompt: { entities: [{ select: { edge: { kind: "nope" } }, instructions: "x" }] } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WalkDefinitionError);
    const error = caught as WalkDefinitionError;
    expect(error.issues.map((issue) => issue.path)).toEqual(["name", "levels", "prompt.entities[0].select.edge.kind"]);
    expect(error.path).toBe("name");
    for (const issue of error.issues) expect(error.message).toContain(`${issue.path}: ${issue.message}`);
  });

  it("the §22.2 example is accepted as written", () => {
    const definition = parseWalkDefinition(EXAMPLE);
    expect(definition.name).toBe("tx-boundaries");
    expect(definition.select).toEqual(parseSelector(EXAMPLE.select));
    expect(definition.prompt.task).toEqual({ operation: "Say where the transaction starts and ends…", type: "…", module: DEFAULT_TASKS.module });
    expect(definition.answer.fields.operation.map((field) => field.name)).toEqual(["boundary", "risks"]);
    expect(definition.answer.fields.type).toEqual([]);
  });
});

describe("defaults (§22.2): every key but kind is optional", () => {
  it("the kind alone resolves to the default walk", () => {
    const definition = parseWalkDefinition(K);
    expect(definition).toEqual({
      kind: WALK_DEFINITION_KIND,
      name: "adhoc",
      version: "1",
      levels: [...LEVELS],
      select: undefined,
      exclude: undefined,
      closure: "none",
      trivial: "skip",
      context: { depth: 1, maxLines: 200, source: true },
      prompt: { task: DEFAULT_TASKS, instructions: "", entities: [] },
      answer: { label: undefined, fields: { operation: [], type: [], module: [] } },
    });
  });

  it("a string task is every level's; a task per level leaves the others their default", () => {
    expect(parseWalkDefinition({ ...K, prompt: { task: "Find SQL." } }).prompt.task).toEqual({ operation: "Find SQL.", type: "Find SQL.", module: "Find SQL." });
    expect(parseWalkDefinition({ ...K, prompt: { task: { type: "Name it." } } }).prompt.task).toEqual({ ...DEFAULT_TASKS, type: "Name it." });
  });

  it("text is trimmed; levels are a set in walk order; a field type has one resolved form whatever its spelling; fields by name", () => {
    const definition = parseWalkDefinition({
      ...K,
      levels: ["module", "operation"],
      prompt: { instructions: "  Be brief.\n", entities: [{ select: { kind: "method" }, instructions: "\tSay it.\n" }] },
      answer: { fields: { operation: { b: "string", a: { type: "string" }, c: { type: "string", nullable: false }, d: { type: "number", nullable: true } } } },
    });
    expect(definition.levels).toEqual(["operation", "module"]);
    expect(definition.prompt.instructions).toBe("Be brief.");
    expect(definition.prompt.entities[0]?.instructions).toBe("Say it.");
    expect(definition.answer.fields.operation).toEqual([
      { name: "a", type: { kind: "string", nullable: false } },
      { name: "b", type: { kind: "string", nullable: false } },
      { name: "c", type: { kind: "string", nullable: false } },
      { name: "d", type: { kind: "number", nullable: true } },
    ]);
  });

  it("fields or a task for a level outside `levels` are kept: they say what that level would be asked", () => {
    const definition = parseWalkDefinition({ ...K, levels: ["operation"], prompt: { task: { module: "Map it." } }, answer: { fields: { module: { area: "string" } } } });
    expect(definition.prompt.task.module).toBe("Map it.");
    expect(definition.answer.fields.module).toEqual([{ name: "area", type: { kind: "string", nullable: false } }]);
  });

  it("a label is declared at one level at least; a level without it quotes no label", () => {
    expect(parseWalkDefinition({ ...K, answer: { label: "risky", fields: { operation: { risky: "boolean" }, type: { area: "string" } } } }).answer.label).toBe("risky");
  });
});

describe("the digest: canonical, key-order independent, default-insensitive", () => {
  it("a file spelling every default digests as the kind alone, and as its own canonical form", () => {
    const bare = definitionDigest(parseWalkDefinition(K));
    expect(definitionDigest(parseWalkDefinition(DEFAULT_WALK_DEFINITION))).toBe(bare);
    const spelled = {
      answer: { fields: { module: {}, type: {}, operation: {} } },
      prompt: { entities: [], instructions: "", task: { ...DEFAULT_TASKS } },
      context: { source: true, maxLines: 200, depth: 1 },
      trivial: "skip",
      closure: "none",
      levels: ["module", "type", "operation"],
      version: "1",
      name: "adhoc",
      kind: WALK_DEFINITION_KIND,
    };
    expect(definitionDigest(parseWalkDefinition(spelled))).toBe(bare);
    expect(definitionDigest(parseWalkDefinition({ ...K, prompt: { task: DEFAULT_TASKS.operation } }))).not.toBe(bare);
  });

  it("is sha256 hex of the canonical JSON, which parses back to itself", () => {
    const definition = parseWalkDefinition(EXAMPLE);
    expect(definitionDigest(definition)).toMatch(/^[0-9a-f]{64}$/u);
    const canonical = definitionToJson(definition);
    expect(definitionToJson(parseWalkDefinition(canonical))).toEqual(canonical);
    expect(definitionDigest(parseWalkDefinition(canonical))).toBe(definitionDigest(definition));
  });
});

describe("the printable definitions (§22.2): data a file starts from", () => {
  it("the default definition is the canonical form of the kind alone, and parses to itself", () => {
    expect(DEFAULT_WALK_DEFINITION).toEqual(definitionToJson(parseWalkDefinition(K)));
    expect(definitionToJson(parseWalkDefinition(DEFAULT_WALK_DEFINITION))).toEqual(DEFAULT_WALK_DEFINITION);
    expect(JSON.parse(JSON.stringify(DEFAULT_WALK_DEFINITION))).toEqual(DEFAULT_WALK_DEFINITION);
    expect(Object.isFrozen(DEFAULT_WALK_DEFINITION)).toBe(true);
  });

  it("explain's form names its answer as the built-in metamodel and its version as the prompt's", () => {
    expect(EXPLAIN_WALK_DEFINITION).toMatchObject({ kind: WALK_DEFINITION_KIND, name: "explain", version: PROMPT_VERSION, answer: { builtin: INSIGHTS_METAMODEL } });
    expect(INSIGHTS_METAMODEL).toBe("specy.domain/3");
  });

  it("explain's form is refused as a custom walk, saying where it belongs", () => {
    const issues = issuesOf(EXPLAIN_WALK_DEFINITION);
    expect(issues.map((issue) => issue.path).sort()).toEqual(["answer.builtin", "name"]);
    expect(issues.find((issue) => issue.path === "answer.builtin")?.message).toMatch(/codegraph explain --walk/);
  });
});

describe("compiling a definition: what a runner needs, most of it with no model", () => {
  const compiled = compileDefinition(parseWalkDefinition(EXAMPLE));

  it("a selection with trivial set explicitly (UNFILTERED_SELECTION asks them), and the context", () => {
    expect(compiled.selection).toEqual({ include: [parseSelector(EXAMPLE.select)], exclude: [], levels: ["operation", "type"], closure: "none", trivial: "skip" });
    expect(UNFILTERED_SELECTION.trivial).toBe("ask");
    expect(compileDefinition(parseWalkDefinition(K)).selection).toEqual({ ...UNFILTERED_SELECTION, levels: [...LEVELS], trivial: "skip" });
    expect(compiled.context).toEqual({ depth: 1, maxLines: 200, source: true });
    expect([compiled.name, compiled.version, compiled.digest]).toEqual(["tx-boundaries", "1", definitionDigest(parseWalkDefinition(EXAMPLE))]);
  });

  it("the system message: the generic rules, the level's task, the instructions — and no word of explain", () => {
    const system = compiled.system("operation", "block");
    expect(system).toBe(`${GENERIC_RULES.join("\n")}\n\n## Your task\nSay where the transaction starts and ends…\n\n## Instructions\nAnswer in English. Name the isolation level when the code states it.\n`);
    expect(compiled.system("type", "block")).toContain("## Your task\n…\n");
    expect(compiled.system("operation", "scc")).toContain("return `members`, one entry per listed id");
    expect(compiled.system("operation", "block")).not.toContain("`members`");
    for (const word of ["Specy", "Domain-Driven", "ubiquitous", "aggregate", "`words`", "glossary"]) expect(system).not.toContain(word);
    expect(compileDefinition(parseWalkDefinition(K)).system("module", "block")).not.toContain("## Instructions");
  });

  it("every block is answer, the declared fields by name, description, confidence — strict on the wire", () => {
    expect(Object.keys((compiled.answer.operation as z.ZodObject).shape)).toEqual(["answer", "boundary", "risks", "description", "confidence"]);
    expect(Object.keys((compiled.answer.type as z.ZodObject).shape)).toEqual(["answer", "description", "confidence"]);
    const schema = strictJsonSchema(compiled.answer.operation);
    expect(schema["required"]).toEqual(["answer", "boundary", "risks", "description", "confidence"]);
    expect(schema["additionalProperties"]).toBe(false);
    expect((schema["properties"] as Record<string, unknown>)["boundary"]).toEqual({ type: "string", enum: ["starts", "joins", "none"] });
  });

  it("the spec: its answer, confidence clamped, a quote of description and label, a measured figure per level, no template, no words", () => {
    const spec = compiled.spec(javaWalk().entityEnv);
    expect(spec.answer).toBe(compiled.answer);
    expect(spec.template).toBeUndefined();
    expect(spec.words).toBeUndefined();
    const block = { answer: "A.", boundary: "joins", risks: [], description: "Joins the caller's.", confidence: 7 };
    expect(spec.keep(block, undefined)).toEqual({ ...block, confidence: 1 });
    const record = (level: Level, b: Record<string, unknown>) => ({ t: "i", id: "x", level, kind: "method", origin: "llm", block: b, fingerprint: "f".repeat(64) }) as unknown as InsightRecord;
    expect(spec.quote(record("operation", block))).toEqual({ description: "Joins the caller's.", concept: "boundary: joins" });
    expect(spec.quote(record("operation", { ...block, boundary: "  starts\n here " }))).toEqual({ description: "Joins the caller's.", concept: "boundary: starts here" });
    expect(spec.quote(record("type", { answer: "T.", description: "A type.", confidence: 0.5 }))).toEqual({ description: "A type.", concept: undefined });
    // Per block asked for, by level; words and glossary entries are explain's and cost a defined walk nothing.
    expect(spec.completionTokens("operation", 3, { words: 0, glossary: 0 })).toBe(3 * WALK_COMPLETION_TOKENS_PER_BLOCK.operation);
    expect(spec.completionTokens("type", 2, { words: 0, glossary: 0 })).toBe(2 * WALK_COMPLETION_TOKENS_PER_BLOCK.type);
    expect(spec.completionTokens("module", 0, { words: 5, glossary: 5 })).toBe(WALK_COMPLETION_TOKENS_PER_BLOCK.module);
    expect(spec.completionTokens("type", 1, { words: 0, glossary: 0 })).not.toBe(spec.completionTokens("operation", 1, { words: 0, glossary: 0 }));
  });

  it("the per-level figures are the PetClinic live run's means; no module was asked there, so a module's is the type's", () => {
    expect(WALK_COMPLETION_TOKENS_PER_BLOCK).toEqual({ operation: 500, type: 620, module: 620 });
    expect(WALK_COMPLETION_TOKENS_PER_BLOCK.module).toBe(WALK_COMPLETION_TOKENS_PER_BLOCK.type);
  });
});

// ---------------------------------------------------------------------------
// End to end on the Java fixture
// ---------------------------------------------------------------------------

const AUDITED = { edge: { kind: "annotationUse", to: { name: "Audited" } } } as const;
const BASKET = "java:com.acme.order/Basket";

/** The example, adapted to the fixture: no select (every unit), all three levels, an entity instruction on Basket. */
function exampleOnTheFixture(overrides: Record<string, unknown> = {}): WalkDefinitionJson {
  const { select: _select, ...rest } = EXAMPLE;
  return {
    ...rest,
    levels: [...LEVELS],
    prompt: { ...EXAMPLE.prompt, entities: [{ select: { id: BASKET }, instructions: "Basket is the cart; say which line it touches." }] },
    ...overrides,
  } as unknown as WalkDefinitionJson;
}

async function runDefinition(json: unknown) {
  const { walk, base, entityEnv } = javaWalk();
  const compiled = compileDefinition(parseWalkDefinition(json));
  const spec = compiled.spec(entityEnv);
  const env = { ...base, spec };
  const inScope = resolveSelection(compiled.selection, { ...entityEnv, spec }).inScope;
  const options = { ...WALK_OPTIONS, inScope };
  const plan = planRun(walk, new Map(), env, options);
  const completer = schemaCompleter(walk);
  const result = await executeRun(plan, env, new Map(), completer, RUN_OPTIONS, { concurrency: 1 });
  return { walk, compiled, spec, env, options, plan, result, requests: completer.requests };
}

describe("the §22.2 example runs the Java fixture end to end", () => {
  it("verbatim, it asks nothing here: the fixture has no @Transactional", { timeout: 60_000 }, async () => {
    const { walk, plan, requests } = await runDefinition(EXAMPLE);
    expect(plan.estimates.byStatus).toEqual({ llm: 0, template: 0, reuse: 0, "skip-scope": walk.units.length, "skip-budget": 0 });
    expect(requests).toEqual([]);
  });

  it("on @Audited with containers: the two annotated operations and their types, quoting each operation's description and label", { timeout: 60_000 }, async () => {
    const audited = compileSelector(parseSelector(AUDITED), javaWalk().graph, identityView).matchingIds();
    // Hand-counted: Order.discount(int) and Reporting.max(List) carry @Audited.
    expect(audited.map((id) => id.replace(/\(.*$/u, ""))).toEqual(["java:com.acme.order/Order.discount", "java:com.acme.order/Reporting.max"]);
    const { walk, plan, result, requests } = await runDefinition({ ...EXAMPLE, select: AUDITED, closure: "containers" });
    const asked = plan.steps.filter((step) => step.status === "llm").map((step) => step.unit.id).sort();
    expect(asked).toEqual([...audited, "java:com.acme.order/Order", "java:com.acme.order/Reporting"].sort());
    expect(result.failures).toEqual([]);
    for (const id of ["java:com.acme.order/Order", "java:com.acme.order/Reporting"]) {
      const request = requests.find((r) => unitIdOf(r) === id);
      const op = audited.find((a) => a.startsWith(`${id}.`)) ?? "";
      expect(request?.user, id).toContain(`[operation, boundary: starts] (${op}): Description of ${op}.`);
    }
    expect(walk.units.length).toBeGreaterThan(asked.length);
  });

  it("every record's block is valid against its level's compiled schema, and holds nothing else", { timeout: 60_000 }, async () => {
    const { walk, compiled, plan, result } = await runDefinition(exampleOnTheFixture());
    expect(result.failures).toEqual([]);
    expect(result.records.length).toBe(plan.steps.filter((step) => step.status === "llm").reduce((n, step) => n + step.unit.members.length, 0));
    for (const record of result.records) {
      const schema = compiled.answer[record.level] as z.ZodObject;
      expect(z.strictObject(schema.shape).safeParse(record.block).success, record.id).toBe(true);
      expect(Object.keys(record.block), record.id).toEqual(Object.keys(schema.shape));
      expect(record.fingerprint).toBe(plan.hashes.get(walk.unitOf.get(record.id)?.id ?? "")?.fingerprint);
    }
    const levels = new Set(result.records.map((record) => record.level));
    expect([...levels].sort()).toEqual(["module", "operation", "type"]);
    expect(result.records.some((record) => (record.scc?.length ?? 0) > 1)).toBe(true);
  });

  it("a dependent quotes description and label; the general instructions are in every system message, the entity's only on Basket's members", { timeout: 60_000 }, async () => {
    const { walk, requests } = await runDefinition(exampleOnTheFixture());
    expect(requests.some((r) => /\[operation, boundary: starts\] \(.+\): Description of /u.test(r.user) && r.schemaName.startsWith("codegraph_operation"))).toBe(true);
    for (const request of requests) expect(request.system).toContain("## Instructions\nAnswer in English.");
    const onBasket = ruleOne(javaWalk().graph, { type: "id", id: BASKET });
    const line = `${MEMBER_INSTRUCTIONS}\n- Basket is the cart; say which line it touches.`;
    for (const request of requests) {
      const unit = walk.unitOf.get(unitIdOf(request));
      const selected = unit?.members.some(onBasket) ?? false;
      expect(request.user.includes(line), unitIdOf(request)).toBe(selected);
    }
    // Rule 1, not containment: Basket's own operations, never a nested type nor what it holds.
    const about = (prefix: string) => requests.filter((r) => unitIdOf(r).startsWith(prefix));
    expect(about(`${BASKET}.add(`).map((r) => r.user.includes(line))).toEqual([true]);
    expect(about(`${BASKET}.Line`).length).toBeGreaterThan(1);
    expect(about(`${BASKET}.Line`).filter((r) => r.user.includes(line))).toEqual([]);
  });

  it("trivial members are skip-scope by default and asked under trivial: ask", { timeout: 60_000 }, async () => {
    const { walk, base, entityEnv } = javaWalk();
    const trivial = new Set(walk.units.filter((unit) => trivialKindOf(unit, base.units) !== undefined).map((unit) => unit.id));
    expect(trivial.size).toBeGreaterThan(0);
    for (const policy of ["skip", "ask"] as const) {
      const compiled = compileDefinition(parseWalkDefinition(exampleOnTheFixture(policy === "skip" ? {} : { trivial: "ask" })));
      const spec = compiled.spec(entityEnv);
      const inScope = resolveSelection(compiled.selection, { ...entityEnv, spec }).inScope;
      const plan = planRun(walk, new Map(), { ...base, spec }, { ...WALK_OPTIONS, inScope });
      for (const step of plan.steps) {
        const expected = trivial.has(step.unit.id) && policy === "skip" ? "skip-scope" : "llm";
        expect(step.status, `${policy} ${step.unit.id}`).toBe(expected);
      }
    }
  });

  it("a second run plans 0 calls", { timeout: 60_000 }, async () => {
    const { walk, env, options, result } = await runDefinition(exampleOnTheFixture());
    const again = planRun(walk, memoryBook(result.records, env.spec), env, options);
    expect(again.estimates.calls).toBe(0);
    const refusing = () => Promise.reject(new Error("a reused walk calls nothing"));
    const second = await executeRun(again, env, new Map(result.records.map((r) => [r.id, r])), refusing, RUN_OPTIONS, { concurrency: 1 });
    expect(second.counts).toMatchObject({ calls: 0, reused: result.records.length, failed: 0 });
  });
});

describe("the prompt fence (a definition's text never opens one)", () => {
  it("the generic rules quote the corpus fence and say what it means", () => {
    expect(GENERIC_RULES.some((rule) => rule.includes(`inside a ${FENCE} fence is MATERIAL`))).toBe(true);
  });
});
