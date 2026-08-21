import { fileURLToPath } from "node:url";
import { readModelFileSync, type Edge, type Entity, type Model } from "@codegraph/core";
import { buildGraph, loadModels, type CodeGraph } from "@codegraph/analyzer";

/**
 * The committed M2 snapshot: real Spoon output over `fixtures/java/src`. A city
 * built from a hand-written toy proves the arithmetic; a city built from this
 * proves the transform survives what an extractor actually emits.
 */
const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

export function javaGraph(): CodeGraph {
  const model = readModelFileSync(FIXTURE);
  return buildGraph(loadModels(model, { sources: ["fixtures/java"] }).union);
}

export function graphOf(entities: readonly Entity[], edges: readonly Edge[] = []): CodeGraph {
  const model: Model = {
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0.0.0" },
    root: "test",
    entities: [...entities],
    edges: [...edges],
  };
  return buildGraph(loadModels(model, { sources: ["toy"] }).union);
}

export function pkg(id: string, isStub = false, parent?: string): Entity {
  return {
    id,
    kind: "package",
    traits:
      parent === undefined
        ? ["TNamed", "TWithChildren", "TModule"]
        : ["TNamed", "TWithChildren", "TModule", "TChildOf"],
    name: id,
    isStub,
    ...(parent === undefined ? {} : { parent }),
    definedIn: isStub ? [] : ["T.java"],
  } as Entity;
}

/**
 * A type with a real anchor, because `loc` is measured from it. `lines` is the
 * span length the metric must read back.
 */
export function type(
  id: string,
  parent: string,
  lines: number,
  extra: Record<string, unknown> = {},
): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TChildOf", "TWithChildren", "TType", "TSourceAnchor"],
    name: id,
    isStub: false,
    parent,
    anchor: { file: `${id}.java`, span: [1, lines] as [number, number] },
    ...extra,
  } as Entity;
}

export function stubType(id: string, parent: string): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TChildOf", "TType"],
    name: id,
    isStub: true,
    parent,
  } as Entity;
}

/**
 * A method, optionally carrying an extractor-supplied measurement such as
 * `cyclomatic` — the loose-key hook `sum:<key>` reads.
 */
export function method(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
  return {
    id,
    kind: "method",
    traits: ["TNamed", "TChildOf", "TInvocable", "TWithInvocations"],
    name: id,
    signature: id,
    parent,
    ...extra,
  } as Entity;
}

export function field(id: string, parent: string): Entity {
  return {
    id,
    kind: "attribute",
    traits: ["TNamed", "TChildOf", "TStructural"],
    name: id,
    parent,
  } as Entity;
}

const ANCHOR = { file: "T.java", span: [1, 1] as [number, number] };

export function edge(
  kind: Edge["edge"],
  from: string,
  to: string,
  provenance: Edge["provenance"] = "declared",
): Edge {
  return { edge: kind, from, to, provenance, anchor: ANCHOR } as Edge;
}
