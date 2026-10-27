import type { Edge, Entity, Model } from "@codegraph/core";
import { buildGraph, loadModels, type CodeGraph } from "@codegraph/analyzer";

/** Toy corpora for the aggregation: entities written as an extractor would. */

export function graphOf(models: readonly { lang: string; entities: readonly Entity[]; edges?: readonly Edge[] }[]): CodeGraph {
  const payloads: Model[] = models.map(({ lang, entities, edges = [] }) => ({
    schemaVersion: "1.0.0",
    lang,
    extractor: { name: "test", version: "0.0.0" },
    root: `toy/${lang}`,
    entities: [...entities],
    edges: [...edges],
  }));
  return buildGraph(loadModels(payloads, { sources: payloads.map((model) => `toy-${model.lang}`) }).union);
}

const child = (parent: string | undefined): Record<string, unknown> =>
  parent === undefined ? {} : { parent };
const childOf = (parent: string | undefined): readonly string[] => (parent === undefined ? [] : ["TChildOf"]);

export function pkg(id: string, name: string, parent?: string, isStub = false): Entity {
  return {
    id,
    kind: "package",
    traits: ["TNamed", "TWithChildren", "TModule", ...childOf(parent)],
    name,
    isStub,
    definedIn: isStub ? [] : ["T.java"],
    ...child(parent),
  } as Entity;
}

export function cls(id: string, name: string, parent?: string, isStub = false): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TWithChildren", "TType", ...childOf(parent)],
    name,
    isStub,
    ...child(parent),
  } as Entity;
}

export function method(
  id: string,
  name: string | undefined,
  parent: string,
  slots: { parameters?: readonly string[]; localVariables?: readonly string[] } = {},
): Entity {
  return {
    id,
    kind: name === undefined ? "constructor" : "method",
    traits: [
      ...(name === undefined ? [] : ["TNamed"]),
      "TInvocable",
      "TWithParameters",
      "TWithLocalVariables",
      "TChildOf",
    ],
    ...(name === undefined ? {} : { name }),
    signature: `${name ?? "<init>"}()`,
    parameters: [...(slots.parameters ?? [])],
    localVariables: [...(slots.localVariables ?? [])],
    parent,
  } as Entity;
}

export function structural(id: string, kind: string, name: string, parent: string): Entity {
  return { id, kind, traits: ["TNamed", "TStructural", "TChildOf"], name, parent } as Entity;
}

/**
 * The hand-counted corpus of aggregate.test.ts: two packages, three types (one
 * nested), a method with a parameter and a local, a conventional and an
 * unnamed member, and two stubs whose names must never count.
 */
export function orderCorpus(): readonly Entity[] {
  const order = "java:com.acme.order";
  const billing = "java:com.acme.order.billing";
  const Order = `${order}/Order`;
  const getTotal = `${Order}.getTotal(Line)`;
  const Line = `${Order}$Line`;
  return [
    pkg(order, "com.acme.order"),
    pkg(billing, "com.acme.order.billing", order),
    cls(Order, "Order", order),
    method(getTotal, "getTotal", Order, {
      parameters: [`${getTotal}#param:orderLine`],
      localVariables: [`${getTotal}#local:total`],
    }),
    structural(`${getTotal}#param:orderLine`, "parameter", "orderLine", getTotal),
    structural(`${getTotal}#local:total`, "localVariable", "total", getTotal),
    method(`${Order}.toString()`, "toString", Order),
    method(`${Order}.<init>()`, undefined, Order),
    structural(`${Order}#lines`, "attribute", "lines", Order),
    cls(Line, "Line", Order),
    structural(`${Line}#qty`, "attribute", "qty", Line),
    cls(`${billing}/Invoice`, "Invoice", billing),
    pkg("java:java.lang", "java.lang", undefined, true),
    cls("java:java.lang/String", "String", "java:java.lang", true),
  ];
}
