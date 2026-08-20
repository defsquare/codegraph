import {
  buildGraph,
  coupling,
  couplingToJson,
  foldGraph,
  foldedGraphToCsv,
  foldedGraphToJson,
  identityView,
  loadModels,
  toDot,
  toJsonString,
} from "@codegraph/analyzer";
import { describe, expect, it } from "vitest";
import {
  ArtifactSyntaxError,
  entityIdsIn,
  parseCsv,
  parseDot,
  parseJsonArtifact,
  parsePureDot,
  valuesUnderKey,
} from "./artifact-grammar.js";
import { readModelFileSync } from "@codegraph/core";
import { javaFixture } from "./cli-process.js";

function folded(level: "module" | "type") {
  const payload: unknown = readModelFileSync(javaFixture());
  const { union } = loadModels([payload], { onSchemaError: "collect" });
  return foldGraph(buildGraph(union), { level, view: identityView });
}

describe("the grammar checkers accept real analyzer output", () => {
  for (const level of ["module", "type"] as const) {
    it(`parses ${level}-level DOT`, () => {
      const dot = toDot(folded(level));
      const parsed = parsePureDot(dot);
      expect(parsed.directed).toBe(true);
      expect(parsed.name).toBe("codegraph");
      expect(parsed.edges.length).toBeGreaterThan(0);
      expect(parsed.nodeIds.length).toBeGreaterThan(0);
      expect(parsed.subgraphs.length).toBe(1);
      expect(parsed.bareWords).toEqual([]);
    });

    it(`parses ${level}-level CSV`, () => {
      const table = parseCsv(foldedGraphToCsv(folded(level)));
      expect(table.header).toEqual([
        "from",
        "to",
        "count",
        "kinds",
        "provenances",
        "selfLoop",
        "level",
        "view",
      ]);
      expect(table.rows.length).toBeGreaterThan(0);
      expect(table.column(table.rows[0] as string[], "level")).toBe(level);
    });

    it(`parses ${level}-level JSON`, () => {
      const json = parseJsonArtifact(toJsonString(foldedGraphToJson(folded(level))), "artifact");
      expect(json["kind"]).toBe("codegraph.foldedGraph/1");
    });
  }
});

describe("the JSON inspectors find facts without pinning key names", () => {
  it("entityIdsIn finds exactly the module ids in a real coupling artifact", () => {
    const table = coupling(folded("module"));
    const ids = entityIdsIn(toJsonString(couplingToJson(table)));
    expect(ids.size, "the java fixture folds to 10 modules").toBe(10);
    expect([...ids].sort()).toEqual(table.rows.map((row) => row.id).sort());
  });

  it("entityIdsIn survives ids embedded in prose, as a text report would print them", () => {
    const ids = entityIdsIn(
      "  java:com.acme.order  fanIn=3, fanOut=1\n  java:com.acme.order.adapter  fanIn=0\n",
    );
    expect([...ids].sort()).toEqual(["java:com.acme.order", "java:com.acme.order.adapter"]);
  });

  it("valuesUnderKey finds a fact by what its key means, not how it is spelt", () => {
    const payload = { summary: { duplicateIds: ["a", "b"] }, other: 1 };
    expect(valuesUnderKey(payload, /duplicate/i)).toEqual([["a", "b"]]);
    expect(valuesUnderKey({ nested: { deep: { DuplicateCount: 166 } } }, /duplicate/i)).toEqual([166]);
    expect(valuesUnderKey({ nothing: 1 }, /duplicate/i)).toEqual([]);
  });
});

describe("the grammar checkers REJECT a corrupted stream", () => {
  const dot = toDot(folded("module"));
  const csv = foldedGraphToCsv(folded("module"));

  it("rejects prose prepended to DOT", () => {
    expect(() => parseDot(`Loaded 1 model, 166 entities.\n${dot}`)).toThrow(ArtifactSyntaxError);
  });

  it("rejects prose appended to DOT", () => {
    expect(() => parseDot(`${dot}\nWarning: 5 edges were dropped.\n`)).toThrow(ArtifactSyntaxError);
  });

  it("rejects a warning injected inside DOT", () => {
    const at = dot.indexOf("\n", dot.indexOf("digraph"));
    const spliced = `${dot.slice(0, at)}\nnote: 5 edges dropped\n${dot.slice(at)}`;
    // Still legal DOT syntax — three bare node statements — which is exactly why
    // `parsePureDot` also insists every id be quoted.
    expect(() => parseDot(spliced)).not.toThrow();
    expect(() => parsePureDot(spliced)).toThrow(ArtifactSyntaxError);
  });

  it("rejects a truncated DOT document", () => {
    expect(() => parseDot(dot.slice(0, dot.length - 3))).toThrow(ArtifactSyntaxError);
  });

  it("rejects prose prepended to CSV", () => {
    expect(() => parseCsv(`loaded 1 model\n${csv}`)).toThrow(ArtifactSyntaxError);
  });

  it("rejects prose appended to CSV", () => {
    expect(() => parseCsv(`${csv}5 edges dropped\n`)).toThrow(ArtifactSyntaxError);
  });

  it("rejects prose prepended to JSON", () => {
    expect(() => parseJsonArtifact('loaded\n{"a":1}', "x")).toThrow(ArtifactSyntaxError);
  });
});
