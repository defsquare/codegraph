import { describe, expect, it } from "vitest";
import { buildVocabulary } from "../src/aggregate.js";
import { vocabularyToJsonString } from "../src/artifact.js";
import { graphOf, orderCorpus } from "./toy.js";

/**
 * The artifact as text. Compact by default, like the navigator's: a real
 * corpus has thousands of scopes. Pretty is the committed snapshots' form —
 * one term and one scope per line, so a review reads a diff of words.
 */
describe("vocabularyToJsonString", () => {
  const artifact = buildVocabulary(graphOf([{ lang: "java", entities: orderCorpus() }]));

  it("writes one line by default, and the artifact parses back whole", () => {
    const compact = vocabularyToJsonString(artifact);
    expect(compact).not.toContain("\n");
    expect(JSON.parse(compact)).toEqual(JSON.parse(JSON.stringify(artifact)));
  });

  it("writes one term and one scope per line when pretty, saying the same thing", () => {
    const pretty = vocabularyToJsonString(artifact, { pretty: true });
    expect(JSON.parse(pretty)).toEqual(JSON.parse(vocabularyToJsonString(artifact)));
    expect(pretty.endsWith("}\n")).toBe(true);
    const lines = new Set(pretty.split("\n").map((line) => line.trim().replace(/,$/, "")));
    for (const term of artifact.terms) expect(lines.has(JSON.stringify(term)), term.text).toBe(true);
    for (const scope of artifact.scopes) expect(lines.has(JSON.stringify(scope)), scope.name).toBe(true);
    expect(pretty.split("\n").length).toBeLessThan(artifact.terms.length + artifact.scopes.length + 30);
    expect(pretty.startsWith(`{\n  "kind": "codegraph.vocabulary/1",\n`)).toBe(true);
  });
});
