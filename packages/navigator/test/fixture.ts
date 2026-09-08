import { fileURLToPath } from "node:url";
import { readModelFileSync, type Edge, type Entity, type Model } from "@codegraph/core";
import { buildGraph, loadModels, type CodeGraph } from "@codegraph/analyzer";

/** The committed M2 snapshot: real Spoon output — the toy proves the rules,
 * this proves they survive what an extractor actually emits. */
const FIXTURE = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

export function javaGraph(): CodeGraph {
  const model = readModelFileSync(FIXTURE);
  return buildGraph(loadModels(model, { sources: ["fixtures/java"] }).union);
}

/** The committed M12 snapshot: real Roslyn output over `fixtures/csharp/src`. */
const CSHARP_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/csharp/expected/model.jsonl", import.meta.url),
);

export function csharpGraph(): CodeGraph {
  const model = readModelFileSync(CSHARP_FIXTURE);
  return buildGraph(loadModels(model, { sources: ["fixtures/csharp"] }).union);
}

/** The committed M13 snapshot: real compiler-API output over `fixtures/typescript/src`. */
const TYPESCRIPT_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/typescript/expected/model.jsonl", import.meta.url),
);

export function typescriptGraph(): CodeGraph {
  const model = readModelFileSync(TYPESCRIPT_FIXTURE);
  return buildGraph(loadModels(model, { sources: ["fixtures/typescript"] }).union);
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

export function type(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
  return {
    id,
    kind: "class",
    traits: ["TNamed", "TChildOf", "TWithChildren", "TType", "TSourceAnchor"],
    name: id,
    isStub: false,
    parent,
    anchor: { file: `${id}.java`, span: [1, 10] as [number, number] },
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

/** A method carrying ordered parameters/locals, like the extractor emits. */
export function method(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
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
    ],
    name: id,
    signature: `${id}()`,
    parent,
    parameters: [],
    localVariables: [],
    ...extra,
  } as Entity;
}

export function field(id: string, parent: string, extra: Record<string, unknown> = {}): Entity {
  return {
    id,
    kind: "attribute",
    traits: ["TNamed", "TChildOf", "TStructural", "TTypedEntity"],
    name: id,
    parent,
    ...extra,
  } as Entity;
}

/** A parameter: TStructural like a field, but its parent is the invocable. */
export function param(id: string, name: string, parent: string, declaredType?: string): Entity {
  return {
    id,
    kind: "parameter",
    traits: ["TNamed", "TChildOf", "TStructural", "TTypedEntity"],
    name,
    parent,
    ...(declaredType === undefined ? {} : { declaredType }),
  } as Entity;
}

export function local(id: string, name: string, parent: string, declaredType?: string): Entity {
  return {
    id,
    kind: "localVariable",
    traits: ["TNamed", "TChildOf", "TStructural", "TTypedEntity"],
    name,
    parent,
    ...(declaredType === undefined ? {} : { declaredType }),
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
