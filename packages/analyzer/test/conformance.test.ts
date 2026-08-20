import type { Edge, Entity, Model } from "@codegraph/core";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_RULES,
  checkConformance,
  sameEntityDeclaration,
  type ConformanceFinding,
  type ConformanceReport,
} from "../src/conformance.js";
import { loadModels, type ModelUnion } from "../src/load.js";
import { javaFixture } from "./fixture.js";

/**
 * The acceptance gate's own tests. Two kinds of subject on purpose:
 *  - the committed Spoon snapshot, which must come back CLEAN — a gate that
 *    fails real extractor output is worse than no gate;
 *  - copies of it corrupted one invariant at a time, so each rule is proven to
 *    fire on exactly the defect it owns and to name the offending id.
 */

function corrupt(mutate: (model: Model) => void): ModelUnion {
  const model = structuredClone(javaFixture());
  mutate(model);
  return loadModels(model, { sources: ["corrupt.json"], onSchemaError: "collect" }).union;
}

/** A union built without `parseModel`, for defects the schema itself rejects. */
function handBuilt(models: readonly Model[], labels: readonly string[]): ModelUnion {
  return {
    models: [...models],
    sources: models.map((model, index) => ({
      index,
      label: labels[index] ?? `model[${index}]`,
      lang: model.lang,
    })),
    entities: models.flatMap((model) => model.entities),
    edges: models.flatMap((model) => model.edges),
    langs: [...new Set(models.map((model) => model.lang))].sort(),
  };
}

function codes(report: ConformanceReport): string[] {
  return report.findings.map((finding) => finding.code);
}

function only(report: ConformanceReport, code: string): ConformanceFinding {
  const matching = report.findings.filter((finding) => finding.code === code);
  expect(matching, `expected exactly one ${code} in ${codes(report).join(", ")}`).toHaveLength(1);
  return matching[0] as ConformanceFinding;
}

function firstClass(model: Model): Entity {
  const entity = model.entities.find(
    (candidate) => candidate.kind === "class" && (candidate as { isStub?: boolean }).isStub !== true,
  );
  if (entity === undefined) throw new Error("the fixture has no corpus-declared class");
  return entity;
}

function firstEdge(model: Model): Edge {
  const edge = model.edges[0];
  if (edge === undefined) throw new Error("the fixture has no edges");
  return edge;
}

describe("checkConformance on the committed Spoon snapshot", () => {
  const report = checkConformance(loadModels(javaFixture(), { sources: ["fixtures/java"] }).union);

  it("passes every invariant", () => {
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
    expect(report.counts.suppressed).toBe(0);
  });

  it("states what the verdict is a verdict about", () => {
    expect(report.subject).toEqual({
      models: 1,
      entities: 166,
      stubs: 26,
      edges: 173,
      langs: ["java"],
      sources: ["fixtures/java"],
      unknownProfiles: [],
    });
  });

  it("counts every rule at zero rather than omitting the rule", () => {
    for (const rule of CONFORMANCE_RULES) expect(report.counts.byRule[rule], rule).toBe(0);
  });

  it("is deterministic — the same union twice gives byte-identical reports", () => {
    const again = checkConformance(loadModels(javaFixture(), { sources: ["fixtures/java"] }).union);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });
});

describe("closure (CLAUDE.md invariant 10)", () => {
  it("names the id no entity declares, and where it is written", () => {
    const union = corrupt((model) => {
      firstEdge(model).to = "java:nowhere/Ghost";
    });
    const report = checkConformance(union);

    expect(report.ok).toBe(false);
    const finding = only(report, "dangling-reference");
    expect(finding.severity).toBe("error");
    expect(finding.rule).toBe("closure");
    expect(finding.id).toBe("java:nowhere/Ghost");
    expect(finding.path).toBe("edges[0].to");
    expect(finding.label).toBe("corrupt.json");
    expect(finding.message).toContain("java:nowhere/Ghost");
  });

  it("counts a stub as declared — a stub IS an entity (METAMODEL.md §6)", () => {
    const union = loadModels(javaFixture()).union;
    const stub = union.entities.find((entity) => (entity as { isStub?: boolean }).isStub === true);
    expect(stub).toBeDefined();
    const report = checkConformance(
      corrupt((model) => {
        firstEdge(model).to = stub?.id ?? "";
      }),
    );
    expect(codes(report)).not.toContain("dangling-reference");
  });

  it("accepts an id a sibling model declares, and `known` for one outside the union", () => {
    const split = corrupt((model) => {
      firstEdge(model).to = "java:elsewhere/Declared";
    });
    expect(codes(checkConformance(split))).toContain("dangling-reference");
    expect(codes(checkConformance(split, { known: ["java:elsewhere/Declared"] }))).not.toContain(
      "dangling-reference",
    );
  });
});

describe("no self-reference (METAMODEL.md §4)", () => {
  it("names the id that points at itself", () => {
    const union = corrupt((model) => {
      const edge = firstEdge(model);
      edge.to = edge.from;
    });
    const report = checkConformance(union);

    const finding = only(report, "self-edge");
    expect(report.ok).toBe(false);
    expect(finding.rule).toBe("self-reference");
    expect(finding.path).toBe("edges[0]");
    expect(finding.message).toContain(finding.id ?? "<none>");
    expect(finding.message).toContain("from !== to");
  });
});

describe("provenance is always set and always one of the four values", () => {
  it("rejects a provenance outside the vocabulary", () => {
    const model = structuredClone(javaFixture());
    (firstEdge(model) as { provenance: string }).provenance = "guessed";
    const report = checkConformance(handBuilt([model], ["hand.json"]));

    const finding = only(report, "invalid-provenance");
    expect(finding.rule).toBe("provenance");
    expect(finding.message).toContain("dynamic-candidate");
    expect(report.ok).toBe(false);
  });

  it("is checked even when the lang has no profile at all", () => {
    const model = structuredClone(javaFixture());
    model.lang = "cobol";
    (firstEdge(model) as { provenance: unknown }).provenance = undefined;
    const report = checkConformance(handBuilt([model], ["cobol.json"]));

    expect(codes(report)).toContain("invalid-provenance");
    expect(codes(report)).toContain("unknown-profile");
    expect(report.subject.unknownProfiles).toEqual(["cobol"]);
  });
});

/** The invariant M4 adds: nothing checked `candidates` before this module. */
describe("candidates are non-empty iff resolution was ambiguous (PLAN.md §8)", () => {
  it("rejects a present-but-empty candidates array", () => {
    const report = checkConformance(
      corrupt((model) => {
        firstEdge(model).candidates = [];
      }),
    );

    const finding = only(report, "candidates-empty");
    expect(report.ok).toBe(false);
    expect(finding.rule).toBe("candidates");
    expect(finding.path).toBe("edges[0].candidates");
    expect(finding.message).toContain("omit the key");
  });

  it("rejects candidates on an edge that claims to be a declared fact", () => {
    const report = checkConformance(
      corrupt((model) => {
        const edge = firstEdge(model);
        edge.provenance = "declared";
        edge.candidates = [edge.to];
      }),
    );

    const finding = only(report, "candidates-without-uncertainty");
    expect(report.ok).toBe(false);
    expect(finding.message).toContain("dynamic-candidate");
  });

  it("accepts candidates that include the target on a dynamic-candidate edge", () => {
    const report = checkConformance(
      corrupt((model) => {
        const edge = firstEdge(model);
        edge.provenance = "dynamic-candidate";
        edge.candidates = [edge.to];
      }),
    );

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("accepts a candidates list that excludes its own target", () => {
    // §4 calls `to` the "best candidate", but a list EXCLUDING it is the more
    // precise shape, not a defect: when dispatch resolves to an interface or
    // abstract method, that declaration cannot itself run and the candidates
    // are the concrete overriders. Measured on commons-lang, 119 of 361
    // dynamic-candidate edges are of exactly this shape and all are correct.
    // The model records no abstractness, so nothing here can tell a correct
    // exclusion from a wrong one — asserting it would flag 119 good edges.
    const report = checkConformance(
      corrupt((model) => {
        const edge = firstEdge(model);
        edge.provenance = "dynamic-candidate";
        edge.candidates = [edge.from];
      }),
    );

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("warns when uncertain dispatch lists no alternatives at all", () => {
    const report = checkConformance(
      corrupt((model) => {
        firstEdge(model).provenance = "dynamic-candidate";
      }),
    );

    expect(only(report, "candidates-missing").severity).toBe("warning");
    expect(report.ok).toBe(true);
  });
});

describe("profile validity", () => {
  it("names the entity and the trait its kind requires", () => {
    let victim = "";
    const report = checkConformance(
      corrupt((model) => {
        const entity = firstClass(model);
        victim = entity.id;
        entity.traits = entity.traits.filter((trait) => trait !== "TWithInheritances");
      }),
    );

    const finding = only(report, "missing-required-trait");
    expect(report.ok).toBe(false);
    expect(finding.rule).toBe("profile");
    expect(finding.id).toBe(victim);
    expect(finding.message).toContain(victim);
    expect(finding.message).toContain("TWithInheritances");
  });

  it("reports an edge kind the profile does not license", () => {
    const report = checkConformance(
      corrupt((model) => {
        firstEdge(model).edge = "traitUsage";
      }),
    );
    expect(codes(report)).toContain("edge-kind-not-allowed");
  });

  it("groups issues by code with true counts", () => {
    const report = checkConformance(
      corrupt((model) => {
        for (const entity of model.entities.filter((e) => e.kind === "parameter")) {
          entity.traits = entity.traits.filter((trait) => trait !== "TNamed");
        }
      }),
    );

    const missing = report.counts.byCode["missing-required-trait"] ?? 0;
    expect(missing).toBeGreaterThan(1);
    expect(report.counts.byRule.profile).toBeGreaterThanOrEqual(missing);
  });
});

describe("anchors are evidence (CLAUDE.md invariant 3)", () => {
  it("rejects an edge with no anchor", () => {
    const model = structuredClone(javaFixture());
    delete (firstEdge(model) as { anchor?: unknown }).anchor;
    const report = checkConformance(handBuilt([model], ["hand.json"]));

    const finding = only(report, "missing-anchor");
    expect(finding.rule).toBe("anchor");
    expect(finding.path).toBe("edges[0].anchor");
    expect(report.ok).toBe(false);
  });

  it("rejects a span that is not 1-based", () => {
    const model = structuredClone(javaFixture());
    (firstEdge(model).anchor as { span: number[] }).span = [0, 4];
    const report = checkConformance(handBuilt([model], ["hand.json"]));
    expect(only(report, "anchor-span-not-1-based").message).toContain("1-based");
  });

  it("rejects a span that ends before it starts", () => {
    const report = checkConformance(
      corrupt((model) => {
        firstEdge(model).anchor.span = [40, 12];
      }),
    );
    expect(only(report, "anchor-span-reversed").message).toContain("[40, 12]");
  });

  it("checks an entity's anchor too, when it declares one", () => {
    const report = checkConformance(
      corrupt((model) => {
        const entity = model.entities.find((candidate) => candidate.traits.includes("TSourceAnchor"));
        if (entity === undefined) throw new Error("the fixture has no anchored entity");
        (entity as unknown as { anchor: { span: number[] } }).anchor.span = [9, 2];
      }),
    );
    expect(only(report, "anchor-span-reversed").path).toMatch(/^entities\[\d+\]\.anchor\.span$/);
  });
});

describe("duplicate ids (METAMODEL.md §1.1)", () => {
  const declaration = (kind: string, traits: readonly string[]): Model => ({
    schemaVersion: "1.0.0",
    lang: "java",
    extractor: { name: "test", version: "0.0.0" },
    root: "test",
    entities: [{ id: "java:p/C", kind, traits: [...traits], name: "C", isStub: true } as Entity],
    edges: [],
  });

  it("accepts an identical redeclaration in two models", () => {
    const union = handBuilt(
      [declaration("class", ["TNamed", "TType"]), declaration("class", ["TNamed", "TType"])],
      ["a.json", "b.json"],
    );
    expect(codes(checkConformance(union))).not.toContain("duplicate-id-conflict");
  });

  it("rejects a redeclaration that disagrees, naming the id and both sites", () => {
    const union = handBuilt(
      [declaration("class", ["TNamed", "TType"]), declaration("interface", ["TNamed", "TType"])],
      ["a.json", "b.json"],
    );
    const finding = only(checkConformance(union), "duplicate-id-conflict");

    expect(finding.id).toBe("java:p/C");
    expect(finding.message).toContain("java:p/C");
    expect(finding.message).toContain("a.json");
    expect(finding.message).toContain("b.json");
    expect(finding.rule).toBe("duplicate-id");
  });

  it("exports the rule it applies", () => {
    const a = { id: "x", kind: "class", traits: ["TNamed", "TType"] } as Entity;
    const b = { id: "x", kind: "class", traits: ["TType", "TNamed"] } as Entity;
    const c = { id: "x", kind: "interface", traits: ["TNamed", "TType"] } as Entity;
    expect(sameEntityDeclaration(a, b)).toBe(true);
    expect(sameEntityDeclaration(a, c)).toBe(false);
  });
});

describe("the report is the product", () => {
  it("never throws on a finding, however broken the union is", () => {
    const wrecked = handBuilt(
      [
        {
          schemaVersion: "1.0.0",
          lang: "brainfuck",
          extractor: { name: "test", version: "0.0.0" },
          root: "",
          entities: [{ id: "x", kind: "widget", traits: [] } as unknown as Entity],
          edges: [{ edge: "import", from: "x", to: "x" } as unknown as Edge],
        },
      ],
      ["wrecked.json"],
    );
    expect(() => checkConformance(wrecked)).not.toThrow();
    const report = checkConformance(wrecked);
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(expect.arrayContaining(["self-edge", "invalid-provenance", "missing-anchor"]));
  });

  it("sorts errors before warnings and groups by rule", () => {
    const report = checkConformance(
      corrupt((model) => {
        firstEdge(model).provenance = "dynamic-candidate"; // warning
        const second = model.edges[1];
        if (second !== undefined) second.to = "java:nowhere/Ghost"; // error
      }),
    );

    const severities = report.findings.map((finding) => finding.severity);
    expect(severities).toEqual(["error", "warning"]);
  });

  it("caps findings per rule while keeping the counts exact", () => {
    const union = corrupt((model) => {
      for (const edge of model.edges) edge.candidates = [];
    });
    const full = checkConformance(union);
    const capped = checkConformance(union, { maxPerRule: 3 });

    expect(full.counts.byCode["candidates-empty"]).toBe(173);
    expect(capped.counts.byCode["candidates-empty"]).toBe(173);
    expect(capped.findings).toHaveLength(3);
    expect(capped.counts.suppressed).toBe(full.findings.length - 3);
  });

  it("does not mutate the union it was handed", () => {
    const union = loadModels(javaFixture(), { sources: ["fixtures/java"] }).union;
    const before = JSON.stringify(union);
    checkConformance(union);
    expect(JSON.stringify(union)).toBe(before);
  });
});
