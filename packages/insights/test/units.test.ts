import { describe, expect, it } from "vitest";
import type { OperationFact, TypeDossier } from "@codegraph/analyzer";
import { classifyTemplate } from "../src/units.js";
import { edge, field, graphOf, javaGraph, lambda, method, pkg, prepared, type } from "./fixture.js";

const P = "java:p";
const T = "java:p/T";
const N = "java:p/T.N";

describe("collectUnits", () => {
  it("makes every direct member operation a unit, attributes a lambda to its operation, and stops at a nested type", () => {
    const graph = graphOf([
      pkg(P),
      type(T, P),
      method(`${T}.f()`, T),
      lambda(`${T}.f().lambda$0`, `${T}.f()`),
      type(N, T),
      method(`${N}.g()`, N),
      field(`${T}.x`, T),
    ]);
    const { units } = prepared(graph);
    expect([...units.operations.keys()]).toEqual([`${N}.g()`, `${T}.f()`]);
    expect([...units.types.keys()]).toEqual([T, N]);
    expect([...units.modules.keys()]).toEqual([P]);
    expect(units.enclosingOperation(`${T}.f().lambda$0`)).toBe(`${T}.f()`);
    expect(units.enclosingOperation(`${N}.g()`)).toBe(`${N}.g()`);
    expect(units.enclosingOperation(`${T}.x`)).toBeUndefined();
    expect(units.enclosingOperation(T)).toBeUndefined();
    expect(units.levelOf(`${T}.f()`)).toBe("operation");
    expect(units.levelOf(N)).toBe("type");
    expect(units.levelOf(P)).toBe("module");
    expect(units.levelOf(`${T}.x`)).toBeUndefined();
  });

  it("covers the Java fixture: every dossier operation is a unit, none is a lambda, stubs are absent", () => {
    const { graph, facts, units } = prepared(javaGraph());
    const expected = facts.types.flatMap((t) => t.operations.filter((o) => o.kind !== "lambda").map((o) => o.id));
    expect([...units.operations.keys()]).toEqual([...expected].sort());
    for (const id of units.types.keys()) expect(graph.isStub(id)).toBe(false);
    expect(units.types.size).toBe(facts.types.length);
    expect(units.modules.size).toBe(facts.modules.length);
  });
});

/** An operation fact with overrides; a key set to `undefined` is REMOVED (exact optional types). */
function op(over: { [K in keyof OperationFact]?: OperationFact[K] | undefined }): OperationFact {
  const base: Record<string, unknown> = {
    id: "java:p/T.m()",
    kind: "method",
    name: "m",
    entryPoint: false,
    annotations: [],
    invocations: [],
    accesses: [],
    throws: [],
    metrics: { sloc: 1, cyclomatic: 1 },
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base as unknown as OperationFact;
}

const TYPE: TypeDossier = {
  id: T,
  kind: "class",
  name: "T",
  annotations: [],
  supertypes: [],
  fields: [{ id: `${T}.total`, kind: "attribute", name: "total", annotations: [] }],
  operations: [],
  injectionPoints: [],
};

const ANCHOR = { file: "T.java", span: [1, 1] as [number, number] };
const read = { to: `${T}.total`, isRead: true, isWrite: false, external: false, provenance: "declared" as const, anchor: ANCHOR };
const write = { ...read, isRead: false, isWrite: true };
const corpusCall = { to: "java:p/U.g()", external: false, provenance: "declared" as const, anchor: ANCHOR };
const externalCall = { ...corpusCall, to: "java:java.util/Objects.hash(java.lang.Object[])", external: true };
const throwSite = { to: "java:java.lang/IllegalStateException", external: true, provenance: "declared" as const, anchor: ANCHOR };

describe("classifyTemplate", () => {
  it.each([
    ["getTotal reading one field", op({ name: "getTotal", accesses: [read] }), "getter"],
    ["record-style accessor named like the field", op({ name: "total", accesses: [read] }), "getter"],
    ["isEmpty with no access", op({ name: "isEmpty" }), "getter"],
    ["setTotal writing one field", op({ name: "setTotal", accesses: [write] }), "setter"],
    ["equals of 5 statement lines with an external call", op({ name: "equals", metrics: { sloc: 5, cyclomatic: 1 }, invocations: [externalCall] }), "objectContract"],
    ["hashCode", op({ name: "hashCode", invocations: [externalCall] }), "objectContract"],
    ["field-assigning constructor", op({ kind: "constructor", name: undefined, accesses: [write, { ...write, to: `${T}.other` }], metrics: { sloc: 3, cyclomatic: 1 } }), "trivialConstructor"],
  ] as const)("%s → %s", (_label, fact, kind) => {
    expect(classifyTemplate(fact, TYPE)).toBe(kind);
  });

  it.each([
    ["a getter that throws", op({ name: "getTotal", accesses: [read], throws: [throwSite] })],
    ["a getter that calls into the corpus", op({ name: "getTotal", invocations: [corpusCall] })],
    ["a getter with a branch", op({ name: "getTotal", metrics: { sloc: 3, cyclomatic: 2 } })],
    ["a long getter", op({ name: "getTotal", metrics: { sloc: 4, cyclomatic: 1 } })],
    ["a getter that writes", op({ name: "getTotal", accesses: [write] })],
    ["a setter reading a field", op({ name: "setTotal", accesses: [write, read] })],
    ["a long equals", op({ name: "equals", metrics: { sloc: 7, cyclomatic: 1 } })],
    ["a constructor that reads", op({ kind: "constructor", accesses: [write, read] })],
    ["a constructor that calls this(...)", op({ kind: "constructor", invocations: [corpusCall] })],
    ["an unmeasured method", op({ name: "getTotal", metrics: undefined, loc: undefined })],
    ["a verb-named method", op({ name: "bill" })],
  ] as const)("%s is never templated", (_label, fact) => {
    expect(classifyTemplate(fact, TYPE)).toBeUndefined();
  });

  it("templates the fixture's plain accessors only", () => {
    const { units } = prepared(javaGraph());
    const templated = [...units.operations.values()].filter((u) => u.template !== undefined);
    expect(templated.length).toBeGreaterThan(0);
    for (const unit of templated) {
      expect(unit.fact.throws).toEqual([]);
      expect(unit.fact.invocations.every((c) => c.external)).toBe(true);
    }
  });
});

// Silence the unused-import rule for helpers other tests in this file may grow into.
void edge;
