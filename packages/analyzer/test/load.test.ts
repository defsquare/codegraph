import { describe, expect, it } from "vitest";
import { isClean, loadModels, ModelLoadError } from "../src/load.js";
import { edge, javaFixture, method, pkg, toyModel, type } from "./fixture.js";

describe("loadModels", () => {
  it("loads the committed Java snapshot with a clean bill of health", () => {
    const { union, diagnostics } = loadModels(javaFixture(), { sources: ["fixtures/java"] });

    expect(union.models).toHaveLength(1);
    expect(union.langs).toEqual(["java"]);
    expect(union.entities).toHaveLength(164);
    expect(union.edges).toHaveLength(173);
    expect(union.sources[0]).toEqual({ index: 0, label: "fixtures/java", lang: "java" });

    expect(diagnostics.schemaErrors).toEqual([]);
    expect(diagnostics.profileIssues).toEqual([]);
    expect(diagnostics.danglingReferences).toEqual([]);
    expect(diagnostics.selfEdges).toEqual([]);
    expect(diagnostics.duplicateIds).toEqual([]);
    expect(diagnostics.unknownProfiles).toEqual([]);
    expect(isClean(diagnostics)).toBe(true);
  });

  it("accepts a single model or an array of them", () => {
    const one = loadModels(javaFixture());
    const many = loadModels([javaFixture()]);
    expect(one.union.entities).toHaveLength(many.union.entities.length);
  });

  it("does not mutate its inputs", () => {
    const model = javaFixture();
    const before = JSON.stringify(model);
    loadModels(model);
    expect(JSON.stringify(model)).toBe(before);
  });

  it("hard-fails on a schema error, naming the source", () => {
    expect(() => loadModels({ nope: true }, { sources: ["broken.json"] })).toThrow(ModelLoadError);
    try {
      loadModels({ nope: true }, { sources: ["broken.json"] });
    } catch (error) {
      expect(error).toBeInstanceOf(ModelLoadError);
      expect((error as ModelLoadError).label).toBe("broken.json");
      expect((error as ModelLoadError).modelIndex).toBe(0);
      expect((error as ModelLoadError).message).toContain("invalid model.json");
    }
  });

  it("collects schema errors instead when asked, and keeps the good models", () => {
    const { union, diagnostics } = loadModels([{ nope: true }, javaFixture()], {
      sources: ["broken.json", "good.json"],
      onSchemaError: "collect",
    });
    expect(diagnostics.schemaErrors).toHaveLength(1);
    expect(diagnostics.schemaErrors[0]?.label).toBe("broken.json");
    expect(union.models).toHaveLength(1);
    // The surviving model keeps its own index in `sources`.
    expect(union.sources[0]?.index).toBe(1);
  });

  it("collects profile violations rather than throwing — a bad model is still analyzable", () => {
    const model = toyModel(
      [pkg("java:p", ["java:p/C"]), type("java:p/C", "java:p", [])],
      [edge("fileInclude", "java:p", "java:p/C")],
    );
    const { union, diagnostics } = loadModels(model);

    expect(union.entities).toHaveLength(2);
    expect(diagnostics.profileIssues.length).toBeGreaterThan(0);
    expect(diagnostics.profileIssueCounts["edge-kind-not-allowed"]).toBe(1);
  });

  it("reports an unknown lang instead of validating against nothing", () => {
    const model = toyModel([pkg("x:p", [])], [], "not-a-language");
    const { diagnostics } = loadModels(model);
    expect(diagnostics.unknownProfiles).toEqual(["not-a-language"]);
    expect(diagnostics.profileIssues).toEqual([]);
  });

  it("checks closure over the UNION, not per model — a cross-model reference resolves", () => {
    const a = toyModel([method("java:p/C.m()", "java:p/C")], [], "java");
    const b = toyModel([pkg("java:p", ["java:p/C"]), type("java:p/C", "java:p", ["java:p/C.m()"])]);

    expect(loadModels(a).diagnostics.danglingReferences).toHaveLength(1);
    expect(loadModels([a, b]).diagnostics.danglingReferences).toEqual([]);
  });

  it("reports a dangling reference with its path and owning model", () => {
    const model = toyModel(
      [pkg("java:p", ["java:p/C"]), type("java:p/C", "java:p", [])],
      [edge("reference", "java:p/C", "java:p/Missing")],
    );
    const { diagnostics } = loadModels(model, { sources: ["m.json"] });
    expect(diagnostics.danglingReferences).toEqual([
      { modelIndex: 0, label: "m.json", path: "edges[0].to", id: "java:p/Missing" },
    ]);
    expect(isClean(diagnostics)).toBe(false);
  });

  it("reports self-edges", () => {
    const model = toyModel(
      [pkg("java:p", ["java:p/C"]), type("java:p/C", "java:p", [])],
      [edge("reference", "java:p/C", "java:p/C")],
    );
    const { diagnostics } = loadModels(model);
    expect(diagnostics.selfEdges).toHaveLength(1);
    expect(diagnostics.selfEdges[0]?.path).toBe("edges[0]");
  });

  it("distinguishes a benign redeclaration from a conflicting one", () => {
    const same = type("java:p/C", "java:p", []);
    const benign = loadModels([
      toyModel([pkg("java:p", ["java:p/C"]), same], []),
      toyModel([same], []),
    ]);
    expect(benign.diagnostics.duplicateIds).toEqual([
      { id: "java:p/C", occurrences: 2, modelIndexes: [0, 1], conflicting: false },
    ]);

    const conflicting = loadModels([
      toyModel([pkg("java:p", ["java:p/C"]), same], []),
      toyModel([method("java:p/C", "java:p")], []),
    ]);
    expect(conflicting.diagnostics.duplicateIds[0]?.conflicting).toBe(true);
  });

  it("unions models of different languages without renaming ids", () => {
    const java = toyModel([pkg("java:p", [])], []);
    const clojure = toyModel([pkg("clj:p", [])], [], "clj");
    const { union } = loadModels([java, clojure]);
    expect(union.langs).toEqual(["clj", "java"]);
    expect(union.entities.map((e) => e.id)).toEqual(["java:p", "clj:p"]);
  });
});
