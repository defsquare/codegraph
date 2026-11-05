import { fileURLToPath } from "node:url";
import { readModelFileSync, type Entity } from "@codegraph/core";
import { buildGraph, hasTrait, loadModels, makeView } from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import { buildVocabulary, operationScope } from "../src/aggregate.js";
import type { VocabularyArtifact } from "../src/artifact.js";
import { ROLES } from "../src/weight.js";
import { cls, graphOf, method, orderCorpus, structural } from "./toy.js";

/**
 * An operation's words, computed on demand (PLAN.md §20.1; §20.5 keeps them
 * out of the artifact): the operation and every kept entity written inside it,
 * short of a type or module, which are scopes of their own.
 */

const NO_ROLES = Object.fromEntries(ROLES.map((role) => [role, 0]));
const Order = "java:com.acme.order/Order";
const getTotal = `${Order}.getTotal(Line)`;

/** A scope's rows as `[text, weight, occurrences, carriers]`. */
const words = (artifact: VocabularyArtifact, rows: readonly (readonly [number, number, number, number])[]) =>
  rows.map(([term, w, n, c]) => [artifact.terms[term]?.text, w, n, c]);

describe("operationScope on the hand-counted corpus", () => {
  const graph = graphOf([{ lang: "java", entities: orderCorpus() }]);
  const artifact = buildVocabulary(graph);

  it("counts the operation, its parameters and its locals, as the artifact counts a scope", () => {
    const scope = operationScope(graph, artifact, getTotal);
    expect(scope).toMatchObject({
      level: "operation",
      id: getTotal,
      name: "getTotal",
      kind: "method",
      // order/Order, the nearest stored scope around it.
      parent: 4,
      entities: 3,
      roles: { ...NO_ROLES, operation: 1, parameter: 1, local: 1 },
      skipped: { unnamed: 0, conventional: 0, numeric: 0 },
      distinct: 4,
      distinctDomain: 3,
      weight: 9,
      occurrences: 5,
    });
    expect(words(artifact, scope?.terms ?? [])).toEqual([
      ["total", 4, 2, 2],
      ["get", 3, 1, 1],
      ["line", 1, 1, 1],
      ["order", 1, 1, 1],
    ]);
  });

  it("indexes the artifact's own terms", () => {
    const scope = operationScope(graph, artifact, getTotal);
    for (const [term] of scope?.terms ?? []) expect(artifact.scopes[0]?.terms.map(([index]) => index)).toContain(term);
  });

  it("says what a conventional or unnamed operation skipped", () => {
    expect(operationScope(graph, artifact, `${Order}.toString()`)).toMatchObject({
      entities: 1,
      skipped: { unnamed: 0, conventional: 1, numeric: 0 },
      terms: [],
    });
    expect(operationScope(graph, artifact, `${Order}.<init>()`)).toMatchObject({
      name: `${Order}.<init>()`,
      entities: 1,
      skipped: { unnamed: 1, conventional: 0, numeric: 0 },
      terms: [],
    });
  });

  it("is no operation scope for a module, a type, a member that is no operation, or an unknown id", () => {
    for (const id of ["java:com.acme.order", Order, `${Order}#lines`, "java:nowhere/Nothing"]) {
      expect(operationScope(graph, artifact, id), id).toBeUndefined();
    }
  });

  it("follows the view: what the view drops is not counted", () => {
    const noParameters = makeView("noParameters", (entity) => entity.kind !== "parameter", () => true);
    const filtered = buildVocabulary(graph, { view: noParameters });
    const scope = operationScope(graph, filtered, getTotal, { view: noParameters });
    expect(scope?.entities).toBe(2);
    expect(words(filtered, scope?.terms ?? [])).toEqual([
      ["total", 4, 2, 2],
      ["get", 3, 1, 1],
    ]);
    expect(operationScope(graph, filtered, `${Order}.<init>()`, { view: makeView("none", () => false, () => true) })).toBeUndefined();
  });

  it("refuses an artifact built under other options than its own", () => {
    expect(() => operationScope(graph, artifact, getTotal, { technical: [] })).toThrow(/other options/);
  });
});

describe("operationScope stops at a scope of its own", () => {
  const lambda = `${getTotal}#lambda$0`;
  const local = `${getTotal}/Local`;
  const extra: Entity[] = [
    {
      id: lambda,
      kind: "lambda",
      traits: ["TInvocable", "TWithParameters", "TChildOf"],
      signature: "(discount) -> …",
      parameters: [`${lambda}#param:discount`],
      parent: getTotal,
    } as Entity,
    structural(`${lambda}#param:discount`, "parameter", "discount", lambda),
    cls(local, "Rebate", getTotal),
    structural(`${local}#amount`, "attribute", "amount", local),
    method(`${local}.apply()`, "apply", local),
  ];
  const graph = graphOf([{ lang: "java", entities: [...orderCorpus(), ...extra] }]);
  const artifact = buildVocabulary(graph);

  it("counts a lambda and its parameter, never a local class or its members", () => {
    const scope = operationScope(graph, artifact, getTotal);
    expect(scope?.entities).toBe(5);
    expect(scope?.skipped.unnamed).toBe(1);
    expect(words(artifact, scope?.terms ?? []).map(([text]) => text)).toEqual(["total", "get", "discount", "line", "order"]);
  });
});

describe.each(["java", "csharp", "typescript", "elixir", "ruby"])("operationScope over fixtures/%s", (name) => {
  const path = fileURLToPath(new URL(`../../../fixtures/${name}/expected/model.jsonl`, import.meta.url));
  const graph = buildGraph(loadModels(readModelFileSync(path), { sources: [name] }).union);
  const artifact = buildVocabulary(graph);
  const operations = graph
    .ids()
    .map((id) => graph.entity(id))
    .filter((entity): entity is Entity => entity !== undefined && !graph.isStub(entity.id))
    .filter((entity) => hasTrait(entity, "TInvocable") && !hasTrait(entity, "TType") && !hasTrait(entity, "TModule"));

  it("has operations to check", () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it("adds up, and never says more than the stored scope around it", () => {
    for (const operation of operations) {
      const scope = operationScope(graph, artifact, operation.id);
      expect(scope, operation.id).toBeDefined();
      if (scope === undefined) continue;
      const roles = Object.values(scope.roles).reduce((sum, n) => sum + n, 0);
      expect(scope.entities).toBe(roles + scope.skipped.unnamed + scope.skipped.conventional);
      expect(scope.weight).toBe(scope.terms.reduce((sum, row) => sum + row[1], 0));
      expect(scope.occurrences).toBe(scope.terms.reduce((sum, row) => sum + row[2], 0));
      const around = new Map(artifact.scopes[scope.parent]?.terms.map((row) => [row[0], row] as const));
      for (const [term, weight, occurrences, carriers] of scope.terms) {
        const row = around.get(term);
        expect(row, `${operation.id}: ${artifact.terms[term]?.text} is said around it`).toBeDefined();
        expect(weight).toBeLessThanOrEqual(row?.[1] ?? 0);
        expect(occurrences).toBeLessThanOrEqual(row?.[2] ?? 0);
        expect(carriers).toBeLessThanOrEqual(row?.[3] ?? 0);
      }
    }
  });
});

it("csharp: a delegate is invocable, and a type scope rather than an operation's", () => {
  const path = fileURLToPath(new URL("../../../fixtures/csharp/expected/model.jsonl", import.meta.url));
  const graph = buildGraph(loadModels(readModelFileSync(path), { sources: ["csharp"] }).union);
  const artifact = buildVocabulary(graph);
  const delegate = [...graph.entities.values()].find((entity) => entity.kind === "delegate");
  expect(delegate === undefined ? false : hasTrait(delegate, "TInvocable")).toBe(true);
  expect(artifact.scopes.find((scope) => scope.id === delegate?.id)?.level).toBe("type");
  expect(operationScope(graph, artifact, delegate?.id ?? "")).toBeUndefined();
});
