import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { compileSelector, folderFor, identityView, type CodeGraph, type Selector } from "@codegraph/analyzer";
import type { EntityEnv, FieldType, WalkDefinitionJson } from "../src/definition.js";
import { RESERVED_FIELD_NAMES, WALK_DEFINITION_KIND } from "../src/definition.js";
import { buildWalk, type Unit, type WalkPlan } from "../src/order.js";
import type { PlanEnv, PlanOptions, RunPlan } from "../src/plan.js";
import type { Completer, CompletionRequest } from "../src/run.js";
import type { JsonSchema } from "../src/schema.js";
import { createSourceReader } from "../src/source.js";
import { FIXTURE_SRC, javaGraph, prepared, toySpeller } from "./fixture.js";

/**
 * What the definition suites share: the Java fixture wired as a walk (graph,
 * units, order, a reader over its sources, the toy speller), a completer that
 * answers any walk from its response schema alone, rule 1 restated
 * independently of selection.ts, and the field grammar as fast-check
 * arbitraries.
 */

export const WALK_OPTIONS: PlanOptions = {
  models: { leaf: "leaf-model", rollup: "rollup-model" },
  depth: 1,
  maxLines: 200,
  maxScc: 12,
  force: false,
  maxCalls: undefined,
  inScope: undefined,
  terms: 60,
};
export const RUN_OPTIONS = { maxScc: WALK_OPTIONS.maxScc, depth: WALK_OPTIONS.depth, maxLines: WALK_OPTIONS.maxLines, terms: WALK_OPTIONS.terms };

export interface JavaWalk {
  readonly graph: CodeGraph;
  readonly walk: WalkPlan;
  readonly base: Omit<PlanEnv, "spec">;
  readonly entityEnv: EntityEnv;
}

let cached: JavaWalk | undefined;

/** The Java fixture as a walk, built once per file: nothing in it depends on the spec. */
export function javaWalk(): JavaWalk {
  if (cached !== undefined) return cached;
  const { graph, facts, units } = prepared(javaGraph());
  const walk = buildWalk(units, graph);
  const reader = createSourceReader((relative) => {
    try {
      return readFileSync(join(FIXTURE_SRC, relative), "utf8");
    } catch {
      return undefined;
    }
  });
  cached = {
    graph,
    walk,
    base: { graph, facts, units, reader, unitOf: walk.unitOf, speller: toySpeller(graph) },
    entityEnv: { graph, view: identityView, units, walk },
  };
  return cached;
}

/** The unit a request is about: its first line, as the engine lays it out (an id may hold spaces). */
export function unitIdOf(request: CompletionRequest): string {
  const rest = (request.user.split("\n")[0] ?? "").replace(/^# Unit: \w+ /u, "");
  const cut = rest.indexOf(" (a cycle of ");
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** A value valid under a strict response schema, from the schema alone; `seed` names the member it is for. */
export function valueFor(schema: JsonSchema, seed: string, key = ""): unknown {
  const anyOf = schema["anyOf"] as JsonSchema[] | undefined;
  if (anyOf !== undefined) return valueFor(anyOf.find((option) => option["type"] !== "null") ?? {}, seed, key);
  const values = schema["enum"] as unknown[] | undefined;
  if (values !== undefined) return values[0];
  switch (schema["type"]) {
    case "object": {
      const properties = schema["properties"] as Record<string, JsonSchema>;
      return Object.fromEntries(Object.entries(properties).map(([name, sub]) => [name, valueFor(sub, seed, name)]));
    }
    case "array":
      return [valueFor(schema["items"] as JsonSchema, seed, key)];
    case "number":
      return key === "confidence" ? 0.5 : 1;
    case "boolean":
      return true;
    case "string":
      return key === "description" ? `Description of ${seed}.` : key === "answer" ? `Answer about ${seed}.` : `${key} of ${seed}`;
    default:
      throw new Error(`no value for schema ${JSON.stringify(schema)}`);
  }
}

/** Answers every request from its response schema; a cycle's members come from the walk, never from parsing ids. */
export function schemaCompleter(walk: WalkPlan): Completer & { readonly requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const complete = (async (request: CompletionRequest) => {
    requests.push(request);
    const id = unitIdOf(request);
    const schema = request.jsonSchema;
    if (!request.schemaName.endsWith("_cycle")) return { json: valueFor(schema, id), model: request.model, usage: { promptTokens: 10, completionTokens: 2 } };
    const members = walk.unitOf.get(id)?.members ?? [id];
    const block = (((schema["properties"] as Record<string, JsonSchema>)["members"] as JsonSchema)["items"] as JsonSchema)["properties"] as Record<string, JsonSchema>;
    // Every member: the suites run with a --max-scc wider than the fixture's cycles, so no prompt is a chunk.
    const json = { members: members.map((member) => ({ id: member, block: valueFor(block["block"] as JsonSchema, member) })) };
    return { json, model: request.model, usage: { promptTokens: 10, completionTokens: 2 } };
  }) as Completer & { requests: CompletionRequest[] };
  complete.requests = requests;
  return complete;
}

/** Rule 1 of §22.3, restated from the analyzer alone: the entity, its nearest type or its nearest module matches. */
export function ruleOne(graph: CodeGraph, selector: Selector): (id: string) => boolean {
  const matcher = compileSelector(selector, graph, identityView);
  const folder = folderFor(graph);
  return (id) => {
    if (matcher.matches(id)) return true;
    const type = folder.containingType(id);
    if (type !== undefined && type !== id && matcher.matches(type)) return true;
    const module = folder.containingModule(id);
    return module !== undefined && module !== id && matcher.matches(module);
  };
}

/** The units that depend on any of `seeds`, transitively, the seeds included. */
export function dependentsClosure(walk: WalkPlan, seeds: ReadonlySet<string>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const unit of walk.units) for (const dep of unit.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), unit.id]);
  const out = new Set(seeds);
  const queue = [...seeds];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const next of dependents.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

/** The units whose fingerprint (or chain) differs between two plans of one walk. */
export function moved(a: RunPlan, b: RunPlan, key: "fingerprint" | "chain" = "fingerprint"): Set<string> {
  const out = new Set<string>();
  for (const [id, hashes] of a.hashes) if (b.hashes.get(id)?.[key] !== hashes[key]) out.add(id);
  return out;
}

/** The units a predicate on members reaches: any member matching. */
export function unitsWith(walk: WalkPlan, member: (id: string) => boolean): Set<string> {
  return new Set(walk.units.filter((unit: Unit) => unit.members.some(member)).map((unit) => unit.id));
}

// ---------------------------------------------------------------------------
// The field grammar, generated
// ---------------------------------------------------------------------------

const RESERVED: ReadonlySet<string> = new Set(RESERVED_FIELD_NAMES);

export const fieldNameArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,7}$/u).filter((name) => !RESERVED.has(name));

const enumValuesArb = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 4 });
const scalarJsonArb = fc.constantFrom("string", "number", "boolean");
const nullableKey = fc.option(fc.boolean(), { nil: undefined });
const withNullable = <T extends object>(form: T, nullable: boolean | undefined): T & { nullable?: boolean } =>
  nullable === undefined ? form : { ...form, nullable };

/** A list item's type, in every JSON spelling the grammar accepts. */
export const itemTypeJsonArb: fc.Arbitrary<unknown> = fc.oneof(
  scalarJsonArb,
  fc.tuple(scalarJsonArb, nullableKey).map(([type, nullable]) => withNullable({ type }, nullable)),
  fc.tuple(enumValuesArb, nullableKey).map(([values, nullable]) => withNullable({ enum: values }, nullable)),
);

const fieldDictionary = <T>(value: fc.Arbitrary<T>, minKeys: number, maxKeys: number) =>
  fc.dictionary(fieldNameArb, value, { minKeys, maxKeys, noNullPrototype: true });

/** A block field's type, in every JSON spelling the grammar accepts. */
export const fieldTypeJsonArb: fc.Arbitrary<unknown> = fc.oneof(
  itemTypeJsonArb,
  fc.constant("string[]"),
  nullableKey.map((nullable) => withNullable({ type: "string[]" }, nullable)),
  fc.tuple(fieldDictionary(itemTypeJsonArb, 1, 3), nullableKey).map(([list, nullable]) => withNullable({ list }, nullable)),
);

export const fieldsJsonArb = fieldDictionary(fieldTypeJsonArb, 0, 5);

/** A definition with the given fields at every level, and nothing else. */
export function definitionWithFields(fields: Record<string, unknown>): WalkDefinitionJson {
  return { kind: WALK_DEFINITION_KIND, answer: { fields: { operation: fields, type: fields, module: fields } } } as WalkDefinitionJson;
}

/** A JSON value a field of this type accepts. Numbers are finite and never -0: JSON has neither. */
export function valueArb(type: FieldType): fc.Arbitrary<unknown> {
  const base = ((): fc.Arbitrary<unknown> => {
    switch (type.kind) {
      case "string":
        return fc.string({ maxLength: 8 });
      case "number":
        return fc.double({ noNaN: true, noDefaultInfinity: true }).map((x) => x + 0);
      case "boolean":
        return fc.boolean();
      case "string[]":
        return fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 });
      case "enum":
        return fc.constantFrom(...type.values);
      case "list":
        return fc.array(fc.record(Object.fromEntries(type.fields.map((f) => [f.name, valueArb(f.type)]))), { maxLength: 3 });
    }
  })();
  return type.nullable ? fc.option(base, { nil: null }) : base;
}
