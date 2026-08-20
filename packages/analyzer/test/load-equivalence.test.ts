import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseModel, readModelFileSync, type Model } from "@codegraph/core";
import { loadDecodedModels, loadModels } from "../src/load.js";
import { javaFixture, toyModel, pkg, type, method, edge } from "./fixture.js";

/**
 * `loadDecodedModels` exists to skip ONE thing — the schema pass — for models
 * that something already validated. Everything else it must answer identically,
 * and "identically" has to mean deep equality, not "close enough": the CLI
 * derives its exit code from these diagnostics, and a difference of one issue
 * flips 0 into 3.
 *
 * So this file is the gate. If the two entry points ever disagree, the skip is
 * not a skip any more — it is a second, quieter implementation of loading.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Models that exercise the paths a real corpus takes through the loader. */
function corpus(): { label: string; model: Model }[] {
  const cases: { label: string; model: Model }[] = [
    { label: "java fixture", model: javaFixture() },
  ];

  // A union: two models sharing ids, which is where duplicate detection lives.
  cases.push({
    label: "toy union member",
    model: toyModel(
      [pkg("java:p"), type("java:p/C", "java:p"), method("java:p/C.m()", "java:p/C")],
      [edge("invocation", "java:p/C.m()", "java:p/C")],
    ),
  });

  // A model that BREAKS its profile: the diagnostics are the interesting part.
  cases.push({
    label: "profile violation",
    model: toyModel([pkg("java:x"), { id: "java:x/Y", kind: "class", traits: ["TNamed"], name: "Y" } as never]),
  });

  // A self-edge: a finding that survives encoding, so both paths must report it.
  const selfy = javaFixture();
  const first = selfy.edges[0];
  if (first === undefined) throw new Error("the java fixture has no edges");
  cases.push({
    label: "self-edge",
    model: { ...selfy, edges: [{ ...first, to: first.from }, ...selfy.edges.slice(1)] },
  });

  // An unknown lang: not validated against any profile, still analyzed.
  cases.push({
    label: "unknown lang",
    model: toyModel([pkg("zz:p"), type("zz:p/C", "zz:p")], [], "zz"),
  });

  return cases;
}

function expectSameResult(model: Model, label: string): void {
  const viaSchema = loadModels([model], { sources: [label] });
  const viaDecoded = loadDecodedModels([model], { sources: [label] });

  expect(viaDecoded.union.entities, label).toEqual(viaSchema.union.entities);
  expect(viaDecoded.union.edges, label).toEqual(viaSchema.union.edges);
  expect(viaDecoded.union.sources, label).toEqual(viaSchema.union.sources);
  expect(viaDecoded.union.langs, label).toEqual(viaSchema.union.langs);
  // Field by field rather than as one object: a failure has to name the bucket.
  for (const key of [
    "schemaErrors",
    "profileIssues",
    "profileIssueCounts",
    "unknownProfiles",
    "danglingReferences",
    "selfEdges",
    "duplicateIds",
  ] as const) {
    expect(viaDecoded.diagnostics[key], `${label}.${key}`).toEqual(viaSchema.diagnostics[key]);
  }
}

describe("loadDecodedModels answers exactly what loadModels answers", () => {
  for (const { label, model } of corpus()) {
    it(`agrees on ${label}`, () => {
      expectSameResult(model, label);
    });
  }

  it("agrees on a union of several models, ids shared across them", () => {
    const a = toyModel([pkg("java:p"), type("java:p/C", "java:p")]);
    const b = toyModel([pkg("java:p"), type("java:p/C", "java:p"), type("java:p/D", "java:p")]);
    const viaSchema = loadModels([a, b], { sources: ["a", "b"] });
    const viaDecoded = loadDecodedModels([a, b], { sources: ["a", "b"] });
    expect(viaDecoded.diagnostics.duplicateIds).toEqual(viaSchema.diagnostics.duplicateIds);
    expect(viaDecoded.diagnostics.duplicateIds.length).toBeGreaterThan(0);
    expect(viaDecoded.union.sources).toEqual(viaSchema.union.sources);
  });

  /**
   * The argument position is what every diagnostic reports, and it is NOT the
   * array position once a payload is skipped or a label repeats.
   */
  it("reports the argument position, not the surviving-model position", () => {
    const good = toyModel([pkg("java:p"), type("java:p/C", "java:p")]);
    const viaSchema = loadModels(["not a model", good], {
      sources: ["broken", "good"],
      onSchemaError: "collect",
    });
    expect(viaSchema.union.sources).toEqual([{ index: 1, label: "good", lang: "java" }]);

    // Two inputs may legitimately share a label: the same path passed twice.
    const twice = loadDecodedModels([good, good], { sources: ["same", "same"] });
    expect(twice.union.sources.map((s) => s.index)).toEqual([0, 1]);
  });

  /**
   * The real caller: a model that came off disk through core's decoder. This is
   * the case the skip exists for, so it is checked against the file, not
   * against an object built in memory.
   */
  it("agrees on every committed fixture, read the way the CLI reads it", () => {
    const fixtures = readdirSync(join(repoRoot, "fixtures"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, "fixtures", entry.name, "expected", "model.jsonl"))
      .filter((path) => {
        try {
          readModelFileSync(path);
          return true;
        } catch {
          return false;
        }
      });
    expect(fixtures.length).toBeGreaterThan(0);
    for (const path of fixtures) expectSameResult(readModelFileSync(path), path);
  });

  /**
   * The one behaviour that CAN move: a file the JSONL decoder accepts but
   * core's `Model` schema would reject would now go undiagnosed. Such a file
   * must not exist — the decoder validates against the same vocabulary — so
   * every fixture is checked BOTH ways.
   */
  it("never hands on a model core's schema would have rejected", () => {
    const paths = readdirSync(join(repoRoot, "fixtures"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, "fixtures", entry.name, "expected", "model.jsonl"));
    let checked = 0;
    for (const path of paths) {
      let decoded: Model;
      try {
        decoded = readModelFileSync(path);
      } catch {
        continue;
      }
      expect(() => parseModel(decoded), path).not.toThrow();
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
