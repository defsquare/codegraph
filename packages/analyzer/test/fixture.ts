import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Edge, Entity, Model } from "@codegraph/core";
import { buildGraph, type CodeGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";

/**
 * The committed M2 snapshot: real Spoon output over `fixtures/java/src`.
 * Tests assert against it rather than only hand-built toys — it is the cheapest
 * way to catch a wrong assumption about the shape of extractor output.
 */
const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.json", import.meta.url),
);

export function javaFixture(): Model {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Model;
}

export function javaGraph(): CodeGraph {
  return buildGraph(loadModels(javaFixture(), { sources: ["fixtures/java"] }).union);
}

/** A minimal hand-built model, for shapes the fixture does not contain. */
export function toyModel(
  entities: readonly Entity[],
  edges: readonly Edge[] = [],
  lang = "java",
): Model {
  return {
    schemaVersion: "1.0.0",
    lang,
    extractor: { name: "test", version: "0.0.0" },
    root: "test",
    entities: [...entities],
    edges: [...edges],
  };
}

export const ANCHOR = { file: "T.java", span: [1, 1] as [number, number] };

export function pkg(id: string, children: readonly string[], isStub = false): Entity {
  return {
    id,
    kind: "package",
    traits: ["TNamed", "TWithChildren", "TModule"],
    name: id,
    isStub,
    children: [...children],
    definedIn: isStub ? [] : ["T.java"],
  } as Entity;
}

export function type(id: string, parent?: string, children: readonly string[] = []): Entity {
  const base: Record<string, unknown> = {
    id,
    kind: "class",
    traits: parent === undefined ? ["TNamed", "TType"] : ["TNamed", "TChildOf", "TWithChildren", "TType"],
    name: id,
    isStub: parent === undefined,
  };
  if (parent !== undefined) {
    base["parent"] = parent;
    base["children"] = [...children];
  }
  return base as Entity;
}

export function method(id: string, parent: string): Entity {
  return {
    id,
    kind: "method",
    traits: ["TNamed", "TChildOf", "TInvocable", "TWithInvocations"],
    name: id,
    signature: id,
    parent,
  } as Entity;
}

export function edge(
  kind: Edge["edge"],
  from: string,
  to: string,
  provenance: Edge["provenance"] = "declared",
): Edge {
  if (kind === "access") {
    return { edge: "access", from, to, provenance, anchor: ANCHOR, isRead: true, isWrite: false };
  }
  return { edge: kind, from, to, provenance, anchor: ANCHOR } as Edge;
}
