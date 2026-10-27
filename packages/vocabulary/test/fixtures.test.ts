import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readModelFileSync } from "@codegraph/core";
import { buildGraph, loadModels, type CodeGraph } from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import { vocabularyToJsonString } from "../src/artifact.js";
import { vocabularyCloudSvg } from "../src/svg.js";
import { expectClosed } from "./closure.js";

/**
 * Every fixture's model → `fixtures/<name>/expected/vocabulary.json`, byte for
 * byte (PLAN.md §20 principle 6). The snapshot is the pretty form, one term and
 * one scope per line, so a change to the split, the classes or the weights
 * reads in review as the words it moved. `CODEGRAPH_UPDATE_SNAPSHOTS=1`
 * rewrites them first — review the diff.
 */

const FIXTURES = ["java", "csharp", "typescript", "elixir", "ruby", "unicode"] as const;

const path = (fixture: string, file: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${fixture}/expected/${file}`, import.meta.url));

function graphOf(fixture: string): CodeGraph {
  const model = readModelFileSync(path(fixture, "model.jsonl"));
  return buildGraph(loadModels(model, { sources: [`fixtures/${fixture}`] }).union);
}

describe.each(FIXTURES)("fixtures/%s", (fixture) => {
  const graph = graphOf(fixture);
  const text = vocabularyToJsonString(buildVocabulary(graph), { pretty: true });
  const snapshot = path(fixture, "vocabulary.json");
  if (process.env["CODEGRAPH_UPDATE_SNAPSHOTS"] !== undefined) writeFileSync(snapshot, text);

  it("reproduces expected/vocabulary.json exactly", () => {
    expect(existsSync(snapshot), `${snapshot} is committed`).toBe(true);
    expect(text).toBe(readFileSync(snapshot, "utf8"));
  });

  it("is closed", () => {
    expectClosed(buildVocabulary(graph), graph);
  });

  it("is the same on a second run over a fresh graph", () => {
    expect(vocabularyToJsonString(buildVocabulary(graphOf(fixture)), { pretty: true })).toBe(text);
  });
});

// The corpus cloud of one fixture, byte for byte (PLAN.md §20.2): the layout,
// the sizes, the classes and the legend in one reviewable file.
describe("fixtures/java/expected/vocabulary.svg", () => {
  const artifact = buildVocabulary(graphOf("java"));
  const corpus = artifact.scopes[0];
  const svg = corpus === undefined ? "" : vocabularyCloudSvg(artifact, corpus);
  const snapshot = path("java", "vocabulary.svg");
  if (process.env["CODEGRAPH_UPDATE_SNAPSHOTS"] !== undefined) writeFileSync(snapshot, svg);

  it("reproduces the corpus cloud exactly", () => {
    expect(existsSync(snapshot), `${snapshot} is committed`).toBe(true);
    expect(svg).toBe(readFileSync(snapshot, "utf8"));
  });
});

// The words each fixture's README counts by hand, name by name. A snapshot
// can be rewritten in one command; these cannot, so a change to the split, the
// qualifiers or the weights has to be argued against a count a person made.
describe("the hand counts of the fixtures' READMEs", () => {
  const rows: readonly (readonly [fixture: string, word: string, weight: number, occurrences: number, carriers: number])[] = [
    ["java", "order", 40, 12, 12],
    ["csharp", "order", 42, 14, 14],
    ["csharp", "priceable", 9, 2, 2],
    ["typescript", "legacy", 11, 4, 4],
    ["typescript", "packages", 21, 21, 21],
    ["elixir", "pricing", 28, 9, 9],
    ["ruby", "pricing", 8, 5, 5],
  ];

  it.each(rows)("%s: %s weighs %i over %i occurrences, %i carriers", (fixture, word, weight, occurrences, carriers) => {
    const artifact = buildVocabulary(graphOf(fixture));
    const term = artifact.terms.findIndex((entry) => entry.text === word && entry.class === "domain");
    expect(artifact.scopes[0]?.terms.find(([index]) => index === term)?.slice(1)).toEqual([weight, occurrences, carriers]);
  });

  it("csharp: the interface marker is no word", () => {
    expect(buildVocabulary(graphOf("csharp")).terms.map((entry) => entry.text)).not.toContain("i");
  });
});
