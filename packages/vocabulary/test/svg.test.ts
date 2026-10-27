import { describe, expect, it } from "vitest";
import type { VocabularyArtifact, VocabularyScope, VocabularyTerm } from "../src/artifact.js";
import { layoutCloud } from "../src/cloud.js";
import { vocabularyCloudSvg } from "../src/svg.js";
import { DEFAULT_WEIGHTS } from "../src/weight.js";

/**
 * The cloud as an SVG (PLAN.md §20.2): size by weight, colour by class and
 * nothing else, a legend that says what was counted, deterministic bytes.
 */

const TERMS: readonly VocabularyTerm[] = [
  { text: "get", class: "technical", modules: 2, types: 3 },
  { text: "line", class: "domain", modules: 1, types: 2 },
  { text: "new", class: "keyword", modules: 1, types: 1 },
  { text: "order", class: "domain", modules: 2, types: 4 },
  { text: "x", class: "short", modules: 1, types: 1 },
  { text: "x<&\">", class: "domain", modules: 1, types: 1 },
];

const ROLES = { module: 0, type: 0, operation: 0, attribute: 0, parameter: 0, local: 0, other: 0 };

function scope(rows: VocabularyScope["terms"], extra: Partial<VocabularyScope> = {}): VocabularyScope {
  return {
    level: "corpus",
    name: "shop",
    entities: 9,
    roles: ROLES,
    skipped: { unnamed: 0, conventional: 0, numeric: 0 },
    distinct: rows.length,
    distinctDomain: rows.filter(([term]) => TERMS[term]?.class === "domain").length,
    weight: 0,
    occurrences: 0,
    terms: rows,
    ...extra,
  };
}

const CORPUS = scope([
  [3, 40, 12, 12],
  [0, 21, 9, 9],
  [1, 16, 3, 3],
  [2, 3, 1, 1],
  [4, 1, 1, 1],
]);

const ARTIFACT: VocabularyArtifact = {
  kind: "codegraph.vocabulary/1",
  generatedBy: "@codegraph/vocabulary",
  view: { name: "all", filters: [] },
  corpus: { name: "shop", roots: ["shop/src"] },
  langs: ["java"],
  weights: DEFAULT_WEIGHTS,
  classes: ["domain", "technical", "keyword", "short"],
  technical: { words: 138, sha256: "4f34e69f52f5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  terms: TERMS,
  scopes: [CORPUS],
  diagnostics: { unplaced: [], withoutLexicon: [] },
};

/** Each drawn word, in document order: its class attribute, its size, its text. */
function drawn(svg: string): readonly (readonly [cls: string, size: string, text: string])[] {
  return [...svg.matchAll(/<text class="([a-z]+)" x="[^"]+" y="[^"]+" font-size="([^"]+)">([^<]*)<\/text>/gu)].map(
    (match) => [match[1] ?? "", match[2] ?? "", match[3] ?? ""] as const,
  );
}

describe("vocabularyCloudSvg", () => {
  it("draws the scope's domain words by weight, each at the size the layout gave it", () => {
    const svg = vocabularyCloudSvg(ARTIFACT, CORPUS);
    const layout = layoutCloud([
      { text: "order", weight: 40, class: "domain" },
      { text: "line", weight: 16, class: "domain" },
    ]);
    expect(drawn(svg)).toEqual(layout.words.map((word) => ["domain", String(word.size), word.text]));
  });

  // Meaning controls appearance: the class is the only thing a word's colour
  // says, and it says it through one class attribute — no inline fill.
  it("colours by class and nothing else", () => {
    const svg = vocabularyCloudSvg(ARTIFACT, CORPUS, { termClass: "all" });
    expect(drawn(svg).map(([cls, , text]) => `${text}:${cls}`)).toEqual([
      "order:domain",
      "get:technical",
      "line:domain",
      "new:keyword",
      "x:short",
    ]);
    expect(svg).not.toMatch(/<text[^>]* (fill|style)=/u);
    for (const cls of ["domain", "technical", "keyword", "short"]) expect(svg).toMatch(new RegExp(`\\.${cls}[,{]`, "u"));
  });

  it("names the scope, the class filter, the counts, the weights, the view and the technical list", () => {
    const svg = vocabularyCloudSvg(ARTIFACT, CORPUS, { top: 1 });
    expect(svg).toContain(">corpus shop · domain: 1 of 2 terms by weight, size on √weight</text>");
    expect(svg).toContain(">weights module 8 · type 8 · operation 3 · attribute 4 · parameter 1 · local 1 · other 1 · qualifier 1</text>");
    expect(svg).toContain(">view all · technical: 138 shared words (sha256 4f34e69f52f5) + each language's own</text>");
    expect(svg).toContain("<title>codegraph vocabulary — corpus shop</title>");
  });

  it("keys the colours when it draws more than one class", () => {
    const key = /<text[^>]*><tspan class="domain">domain<\/tspan> · <tspan class="technical">technical<\/tspan> · <tspan class="keyword">keyword<\/tspan> · <tspan class="short">short<\/tspan><\/text>/u;
    expect(vocabularyCloudSvg(ARTIFACT, CORPUS, { termClass: "all" })).toMatch(key);
    expect(vocabularyCloudSvg(ARTIFACT, CORPUS)).not.toContain("<tspan");
  });

  it("titles a module, a type and an operation by level and name", () => {
    const module = scope([[3, 8, 1, 1]], { level: "module", id: "java:com.shop", name: "com.shop", kind: "package", parent: 0 });
    expect(vocabularyCloudSvg(ARTIFACT, module)).toContain(">module com.shop · domain: 1 term by weight, size on √weight</text>");
    const operation = { ...module, level: "operation" as const, id: "java:com.shop/Order#total()", name: "total", kind: "method", parent: 0 };
    expect(vocabularyCloudSvg(ARTIFACT, operation)).toContain("<title>codegraph vocabulary — operation total</title>");
  });

  it("escapes what it writes", () => {
    const odd = scope([[5, 2, 1, 1]], { name: "a&b" });
    const svg = vocabularyCloudSvg(ARTIFACT, odd);
    expect(drawn(svg).map(([, , text]) => text)).toEqual(["x&lt;&amp;&quot;&gt;"]);
    expect(svg).toContain("<title>codegraph vocabulary — corpus a&amp;b</title>");
  });

  it("says so when the scope speaks no word of the class", () => {
    const svg = vocabularyCloudSvg(ARTIFACT, scope([[0, 21, 9, 9]]));
    expect(drawn(svg)).toEqual([]);
    expect(svg).toContain(">corpus shop · domain: no term</text>");
  });

  it("is the same bytes on every run, and a well-formed document", () => {
    const svg = vocabularyCloudSvg(ARTIFACT, CORPUS, { termClass: "all" });
    expect(vocabularyCloudSvg(ARTIFACT, CORPUS, { termClass: "all" })).toBe(svg);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+(\.\d+)?)" height="(\d+(\.\d+)?)" viewBox="0 0 \1 \3"/u);
    expect(svg.endsWith("</svg>\n")).toBe(true);
    expect(svg).not.toMatch(/NaN|undefined|-0[^.\d]/u);
  });
});
