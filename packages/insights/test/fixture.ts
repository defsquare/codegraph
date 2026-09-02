import { fileURLToPath } from "node:url";
import { readModelFileSync, type Edge, type Entity, type Model } from "@codegraph/core";
import {
  buildDomainFacts,
  buildGraph,
  loadModels,
  type CodeGraph,
  type DomainFacts,
} from "@codegraph/analyzer";
import { collectUnits, type UnitSet } from "../src/units.js";

/** The committed Java snapshot — real Spoon output, with Javadoc and metrics. */
export const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
export const FIXTURE_SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));

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

/** Graph + dossiers + units in one go, for the walk tests. */
export function prepared(graph: CodeGraph): { graph: CodeGraph; facts: DomainFacts; units: UnitSet } {
  const facts = buildDomainFacts(graph);
  return { graph, facts, units: collectUnits(graph, facts) };
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

export function type(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TChildOf", "TWithChildren", "TType", "TSourceAnchor", ...("comments" in extra ? ["TComment"] : [])],
    name: id.slice(id.lastIndexOf("/") + 1),
    isStub: false,
    parent,
    anchor: { file: `${id.replace(/[^A-Za-z0-9]/gu, "_")}.java`, span: [1, 10] as [number, number] },
    ...extra,
  } as Entity;
}

export function stubType(id: string, parent: string): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TChildOf", "TType"],
    name: id.slice(id.lastIndexOf("/") + 1),
    isStub: true,
    parent,
  } as Entity;
}

export function method(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
  const name = id.slice(id.lastIndexOf(".") + 1).replace(/\(.*$/u, "");
  return {
    id,
    kind: "method",
    traits: [
      "TNamed",
      "TChildOf",
      "TInvocable",
      "TWithInvocations",
      "TWithParameters",
      "TWithLocalVariables",
      "TTypedEntity",
      "TSourceAnchor",
    ],
    name,
    signature: `${name}()`,
    parent,
    parameters: [],
    localVariables: [],
    anchor: { file: "T.java", span: [1, 3] as [number, number] },
    ...extra,
  } as Entity;
}

export function lambda(id: string, parent: string): Entity {
  return {
    id,
    kind: "lambda",
    traits: ["TChildOf", "TInvocable", "TWithInvocations", "TWithParameters", "TWithLocalVariables", "TSourceAnchor"],
    signature: "lambda$0()",
    parent,
    parameters: [],
    localVariables: [],
    anchor: { file: "T.java", span: [2, 2] as [number, number] },
  } as Entity;
}

export function field(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
  return {
    id,
    kind: "attribute",
    traits: ["TNamed", "TChildOf", "TStructural", "TTypedEntity", "TSourceAnchor"],
    name: id.slice(id.lastIndexOf(".") + 1),
    parent,
    anchor: { file: "T.java", span: [1, 1] as [number, number] },
    ...extra,
  } as Entity;
}

const ANCHOR = { file: "T.java", span: [1, 1] as [number, number] };

export function edge(
  kind: Edge["edge"],
  from: string,
  to: string,
  provenance: Edge["provenance"] = "declared",
  extra: Record<string, unknown> = {},
): Edge {
  return { edge: kind, from, to, provenance, anchor: ANCHOR, ...extra } as Edge;
}

/**
 * A corpus of `n` packages `java:p0..p{n-1}`, each with one class `C` and one
 * method `f`, plus module→module imports and the class-level references that
 * make them real: package i imports package j iff `imports` says so.
 */
export function packageCorpus(n: number, imports: readonly (readonly [number, number])[]): CodeGraph {
  const entities: Entity[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < n; i += 1) {
    entities.push(pkg(`java:p${i}`), type(`java:p${i}/C`, `java:p${i}`), method(`java:p${i}/C.f()`, `java:p${i}/C`));
  }
  for (const [from, to] of imports) {
    if (from === to) continue;
    edges.push(edge("import", `java:p${from}`, `java:p${to}`));
    edges.push(edge("reference", `java:p${from}/C`, `java:p${to}/C`));
  }
  return graphOf(entities, edges);
}
