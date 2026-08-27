import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStubEntity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { SourceAnchor } from "../src/primitives.js";
import { validateModel } from "../src/profile.js";
import { javaProfile } from "../src/profiles/java.js";
import { selfReferences, unknownReferences } from "../src/integrity.js";

/**
 * THE M2 ACCEPTANCE GATE — the first check that runs both halves of the system
 * against each other.
 *
 * The Java side already validates every line of its output against the per-record
 * schemas, but a JSON Schema can only state what is structurally expressible: an
 * entity's
 * declared traits carry their keys, provenance is one of four strings, spans are
 * 1-based. It cannot state that a `record` may implement but never extend, or
 * that `constructor` carries no `TNamed` — those live in the language PROFILE,
 * which is TypeScript data in this package and is invisible to the extractor by
 * design (CLAUDE.md: "extractors contain no metamodel intelligence").
 *
 * So this is the only place the two halves meet. If it fails, exactly one of two
 * things is true: the extractor emitted a composition Java does not license, or
 * the profile describes a Java that does not exist. Both are real bugs; neither
 * is fixed by relaxing this test.
 */

const SNAPSHOT = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

function loadSnapshot(): Model {
  // Decoded, then re-parsed as a Model: the decoder validates records, and this
  // asserts the RESULT is core's Model — not merely record-shaped.
  return parseModel(readModelFileSync(SNAPSHOT));
}

describe("fixtures/java/expected/model.jsonl", () => {
  it("parses as a Model — the extractor's output is core's Model, not merely schema-shaped", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  /**
   * The strongest statement M6 can make: canonical order and the encoding live
   * in the MODEL, not in whoever writes it. Two independent encoders — Jackson
   * in Java, this one in TypeScript — must produce the same bytes for the same
   * model, or "canonical" means nothing and a fixture diff would depend on which
   * half of the system last touched it.
   */
  it("is byte-identical to what core's own encoder would write", () => {
    expect(encodeModelToString(loadSnapshot())).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("validates against the Java profile with ZERO issues", () => {
    const issues = validateModel(loadSnapshot(), javaProfile);
    // Printed in full: a count tells you nothing about which rule broke.
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("is closed: every referenced id resolves to an entity in the model", () => {
    // CLAUDE.md invariant 10. Java is a single-model corpus here, so nothing is
    // legitimately declared elsewhere — the known-id set is the model itself.
    const dangling = unknownReferences(loadSnapshot());
    expect(dangling.map((r) => `${r.path} -> ${r.id}`)).toEqual([]);
  });

  it("has no self-referencing edges", () => {
    expect(selfReferences(loadSnapshot()).map((s) => s.path)).toEqual([]);
  });

  it("carries the evidence M2 exists to prove", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));

    // PLAN.md §5.2's central hazard: Spoon invents `com.acme.order.Invoice` from
    // the enclosing package. It shares that package with declared corpus types,
    // so any prefix-based membership test launders the fabrication into a fact.
    const invented = byId.get("java:com.acme.order/Invoice");
    expect(invented, "the fabricated FQN must appear in the model").toBeDefined();
    expect(isStubEntity(invented!), "a Spoon fabrication must never be internal").toBe(true);

    // Resolvability is not membership: java.util.List resolves against the JDK.
    expect(isStubEntity(byId.get("java:java.util/List")!)).toBe(true);

    // ...and the corpus's own List, whose SIMPLE name is identical, is internal.
    // If ids ever fell back to simple names these two would be one entity.
    expect(isStubEntity(byId.get("java:com.acme.order.legacy/List")!)).toBe(false);

    // Nested types are absent from getAllTypes(); an extractor that trusts the
    // name drops them and then stubs every reference to them.
    expect(isStubEntity(byId.get("java:com.acme.order/Basket.Line.Discount")!)).toBe(false);
  });

  it("marks external packages as stubs, so filtering stubs yields the internal view", () => {
    const model = loadSnapshot();
    const internal = model.entities.filter((e) => !isStubEntity(e));
    const externalPackages = internal.filter(
      (e) => e.kind === "package" && !e.id.startsWith("java:com.acme"),
    );
    // The import graph is module-level (METAMODEL.md §9), so `import java.util.List`
    // puts `java:java.util` in the model. It must not survive the internal view.
    expect(externalPackages.map((e) => e.id)).toEqual([]);
  });

  it("separates facts from inferences: every edge carries a known provenance", () => {
    const model = loadSnapshot();
    // CLAUDE.md invariant 2. An analysis wanting facts only filters `declared`,
    // so `declared` must be non-empty and must not silently absorb guesses.
    const declared = model.edges.filter((e) => e.provenance === "declared");
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(model.edges.map((e) => e.provenance))).toEqual(
      new Set(["declared", "derived"]),
    );
  });

  /**
   * MEASURES (M10b, METAMODEL §3.8). The numbers below are HAND-COUNTED from
   * `fixtures/java/src`, which is the point: a measure nobody can check by
   * reading the source is a number, not a fact.
   *
   *   Reporting.max   for-each + `if (best == null || …)`   1 + 1 + 1 + 1 = 4
   *   Reporting.join  one for-each                          1 + 1         = 2
   *   Reporting.first one ternary                           1 + 1         = 2
   *   Reporting.today straight line                         1             = 1
   *
   * (Switch labels, catch clauses, pattern guards and lambda attribution are
   * hand-counted too, over sources written for it, in the extractor's own
   * `MeasuresTest` — this corpus contains none of those constructs.)
   */
  it("carries hand-counted measures on the invocables of Reporting", () => {
    const model = loadSnapshot();
    const measure = (symbol: string, key: string): unknown => {
      const entity = model.entities.find((candidate) => candidate.id === `java:com.acme.order/${symbol}`);
      expect(entity, symbol).toBeDefined();
      expect(entity?.traits, symbol).toContain("TMetrics");
      return ((entity as Record<string, unknown>)["metrics"] as Record<string, number>)[key];
    };
    expect(measure("Reporting.max(java.util.List)", "cyclomatic")).toBe(4);
    expect(measure("Reporting.join(java.lang.String[])", "cyclomatic")).toBe(2);
    expect(measure("Reporting.first(java.util.List)", "cyclomatic")).toBe(2);
    expect(measure("Reporting.today()", "cyclomatic")).toBe(1);
    // `max` spans 9 lines of which every one is code (no blank, no comment).
    expect(measure("Reporting.max(java.util.List)", "sloc")).toBe(9);
  });

  /**
   * The durable properties, over every measure in the corpus rather than over
   * the four above: a measure is a finite non-negative number, and `sloc` never
   * exceeds the gross span it was measured in — the derived proxy (the city's
   * `loc`) is an upper bound on the measured claim, and the two are never
   * conflated.
   */
  it("keeps every measure finite, non-negative, and sloc within its span", () => {
    const model = loadSnapshot();
    let measured = 0;
    for (const entity of model.entities) {
      const metrics = (entity as Record<string, unknown>)["metrics"] as
        | Record<string, number>
        | undefined;
      if (metrics === undefined) {
        expect(entity.traits, entity.id).not.toContain("TMetrics");
        continue;
      }
      expect(entity.traits, entity.id).toContain("TMetrics");
      expect(Object.keys(metrics).length, entity.id).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isFinite(value), `${entity.id}.${key}`).toBe(true);
        expect(value, `${entity.id}.${key}`).toBeGreaterThanOrEqual(0);
      }
      const sloc = metrics["sloc"];
      if (sloc !== undefined) {
        const anchor = SourceAnchor.parse((entity as Record<string, unknown>)["anchor"]);
        expect(sloc, entity.id).toBeLessThanOrEqual(anchor.span[1] - anchor.span[0] + 1);
      }
      // A stub was never read, so it can carry no measurement (METAMODEL §6).
      expect(isStubEntity(entity), entity.id).toBe(false);
      measured += 1;
    }
    expect(measured).toBeGreaterThan(50);
  });

  it("anchors every entity that claims TSourceAnchor to a 1-based span in the corpus", () => {
    const model = loadSnapshot();
    for (const entity of model.entities) {
      if (!entity.traits.includes("TSourceAnchor")) continue;
      // The trait-key rule guarantees `anchor` is present and well-typed here;
      // assert it rather than assume it, so a regression reads as a failure.
      const anchor = SourceAnchor.parse((entity as Record<string, unknown>)["anchor"]);
      expect(anchor.file, entity.id).not.toMatch(/^\//); // root-relative, never absolute
      expect(anchor.span[0], entity.id).toBeGreaterThan(0);
    }
  });
});
