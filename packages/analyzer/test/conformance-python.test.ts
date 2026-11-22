import type { Entity } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import { checkConformance } from "../src/conformance.js";
import type { CodeGraph } from "../src/graph.js";
import { loadModels } from "../src/load.js";
import { importGraph, typeDependencyGraph } from "../src/queries.js";
import { declaredOnly, internalOnly } from "../src/views.js";
import { pythonFixture, pythonGraph } from "./fixture.js";

const PKG = "python:src%2Facme_order%2F";
const ORDER = `${PKG}orders%2Forder.py/Order`;
const SERVICE = `${PKG}services.py/Service`;

/** The module an entity is written in: its root, following `parent`. */
function rootOf(graph: CodeGraph, entity: Entity): Entity {
  let at = entity;
  for (let parent = graph.parentOf(at.id); parent !== undefined; parent = graph.parentOf(at.id)) {
    at = graph.entity(parent) as Entity;
  }
  return at;
}

const field = (entity: Entity, key: string): unknown => (entity as Record<string, unknown>)[key];

/** The folded edges leaving one node, as `to → provenances`. */
function foldedFrom(folded: ReturnType<typeof typeDependencyGraph>, from: string): Map<string, string[]> {
  return new Map(folded.edges.filter((edge) => edge.from === from).map((edge) => [edge.to, [...edge.provenances].sort()]));
}

/**
 * The acceptance gate over the SIXTH real extractor's output (PLAN §23.6), the
 * first whose parser is not the language's own: every invariant the five other
 * snapshots pass, the Ruff-parser snapshot passes too — closure, no
 * self-reference, provenance, profile, anchors, ids — and the analyzer's
 * queries read it without knowing which language wrote it: module = file, a
 * package its `__init__.py`, a class the type, an annotation's inference
 * `derived` and a standard form's base `generated`.
 */
describe("checkConformance on the committed Python snapshot", () => {
  const report = checkConformance(loadModels(pythonFixture(), { sources: ["fixtures/python"] }).union);

  it("passes every invariant", () => {
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
  });
});

describe("the analyzer over the Python snapshot", () => {
  it("roots every entity in a module that IS a file, named by its path, packages unlinked", () => {
    const graph = pythonGraph();
    const entities = [...graph.entities.values()];
    expect(entities.length).toBeGreaterThan(300);
    // Only modules stand without a parent: no package holds its submodules (a
    // namespace package has no `__init__` to be one), so every module is a root.
    for (const entity of entities) {
      const isRoot = graph.parentOf(entity.id) === undefined;
      expect(isRoot, entity.id).toBe(entity.kind === "module");
    }
    for (const module of entities.filter((e) => e.kind === "module" && !graph.isStub(e.id))) {
      expect(field(module, "definedIn"), module.id).toEqual([field(module, "name")]);
    }
    expect(graph.entity(`${PKG}__init__.py`)?.kind).toBe("module");
    // Whatever is written in a file is anchored in that file.
    for (const entity of entities) {
      const anchor = field(entity, "anchor") as { file: string } | undefined;
      if (anchor === undefined) continue;
      expect(anchor.file, entity.id).toBe((field(rootOf(graph, entity), "definedIn") as string[])[0]);
    }
  });

  it("keeps stubs below the reserved roots or a path no file answers, never anchored", () => {
    const graph = pythonGraph();
    const corpusFiles = new Set(
      [...graph.entities.values()].filter((e) => e.kind === "module" && !graph.isStub(e.id)).map((e) => field(e, "name")),
    );
    const stubs = [...graph.entities.values()].filter((e) => graph.isStub(e.id));
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) {
      expect(field(stub, "anchor"), stub.id).toBeUndefined();
      const module = rootOf(graph, stub);
      expect(graph.isStub(module.id), stub.id).toBe(true);
      const name = field(module, "name") as string;
      // `<builtins>`, `<stdlib>%2F…`, `<site>%2F…`, or a relative import's missing file.
      if (!/^<(builtins|stdlib|site)>/.test(module.id.slice("python:".length))) {
        expect(corpusFiles.has(name), name).toBe(false);
      }
    }
    expect(graph.isStub("python:<builtins>/Exception")).toBe(true);
    expect(graph.isStub("python:<stdlib>%2Fenum/Enum")).toBe(true);
    expect(graph.isStub("python:<site>%2Fdjango.db.models/Model")).toBe(true);
    expect(graph.isStub(`${PKG}pricing%2Fmissing.py`)).toBe(true);
  });

  it("reads the import layer module to module, every endpoint a file or a stub module", () => {
    const imports = importGraph(pythonGraph());
    expect(imports.importDiagnostics.nonModuleEndpoints).toEqual([]);
    const fromServices = imports.edges.filter((edge) => edge.from === `${PKG}services.py`).map((edge) => edge.to);
    // A relative import names the file; a package import its `__init__.py`; a library import its stub.
    expect(fromServices).toContain(`${PKG}errors.py`);
    expect(fromServices).toContain(`${PKG}pricing%2F__init__.py`);
    expect(fromServices).toContain("python:<stdlib>%2Fjson");
    expect(fromServices).toContain("python:<site>%2Fhooks");
  });

  it("folds every edge kind to the type level, inferences marked as such", () => {
    const folded = typeDependencyGraph(pythonGraph());
    const fromOrder = foldedFrom(folded, ORDER);
    // Two written bases, and a `raise` in a property's setter, folded to the class.
    expect(fromOrder.get(`${PKG}orders%2Fbase.py/Base`)).toEqual(["declared"]);
    expect(fromOrder.get(`${PKG}orders%2Fbase.py/Auditable`)).toEqual(["declared"]);
    expect(fromOrder.get("python:<builtins>/AttributeError")).toEqual(["declared"]);
    const fromService = foldedFrom(folded, SERVICE);
    // `raise OrderError(…)` and `except OrderError` are facts; `self.repository.save()`
    // reads through an attribute only ever assigned `Repository()`: a fact and an inference.
    expect(fromService.get(`${PKG}errors.py/OrderError`)).toEqual(["declared"]);
    expect(fromService.get(`${PKG}repository.py/Repository`)).toEqual(["declared", "derived"]);
    // A base read through an alias is derived; the base a `namedtuple(…)` call gives is generated.
    expect(foldedFrom(folded, `${PKG}aliases.py/Ledger`).get(`${PKG}orders%2Fbase.py/Auditable`)).toEqual(["derived"]);
    expect(foldedFrom(folded, `${PKG}money.py/Amount`).get("python:<builtins>/tuple")).toEqual(["generated"]);
  });

  it("keeps facts alone under --declared-only and corpus types alone under --internal-only", () => {
    const graph = pythonGraph();
    const declared = typeDependencyGraph(graph, declaredOnly);
    for (const edge of declared.edges) expect([...edge.provenances], `${edge.from} → ${edge.to}`).toEqual(["declared"]);
    expect(foldedFrom(declared, `${PKG}aliases.py/Ledger`).has(`${PKG}orders%2Fbase.py/Auditable`)).toBe(false);
    expect(foldedFrom(declared, `${PKG}money.py/Amount`).has("python:<builtins>/tuple")).toBe(false);
    expect(foldedFrom(declared, ORDER).has(`${PKG}orders%2Fbase.py/Base`)).toBe(true);

    const internal = typeDependencyGraph(graph, internalOnly);
    for (const node of internal.nodes) expect(node.isStub, node.id).toBe(false);
    expect(internal.nodes.some((node) => node.id === ORDER)).toBe(true);
  });
});
