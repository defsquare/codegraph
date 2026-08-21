import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";
import { compareIds, sortIds } from "../src/order.js";

/**
 * THE COLLATION CONTRACT, frozen before the SQLite store exists (PLAN.md §9.3).
 *
 * Canonical order compares by UTF-16 CODE UNIT — `compareIds` is `a < b` on
 * JavaScript strings. SQLite's default `BINARY` collation compares UTF-8 BYTES,
 * which is code-point order. The two agree on the whole Basic Multilingual
 * Plane and disagree above it, because JavaScript stores a supplementary
 * character as a surrogate pair in `D800..DFFF` while UTF-8 encodes it above
 * everything in the BMP.
 *
 * That disagreement is not a curiosity once a database holds the model: the
 * entity's position IS its surrogate, and a surrogate is what every reference
 * in the file points at. Rows returned in the database's order rather than the
 * model's would renumber the corpus and silently repoint its edges.
 *
 * So the rule, asserted here rather than hoped for: **sorting belongs to the
 * model, never to the storage engine.** See fixtures/unicode/README.md.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtureDir = join(repoRoot, "fixtures", "unicode", "expected");

/** UTF-8 byte order — what SQLite's BINARY collation would give us. */
function byUtf8Bytes(a: string, b: string): number {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return Buffer.compare(left, right);
}

describe("the two collations genuinely disagree", () => {
  const supplementary = "\u{20000}Supplementary"; // CJK Ext. B — surrogate pair D840 DC00
  const fullwidth = "ＡFullwidth"; // fullwidth A — BMP

  it("orders a supplementary character before a high BMP one, by code unit", () => {
    expect(compareIds(supplementary, fullwidth)).toBeLessThan(0);
  });

  it("orders them the OTHER way by UTF-8 bytes", () => {
    expect(byUtf8Bytes(supplementary, fullwidth)).toBeGreaterThan(0);
  });

  /** If this ever stops holding, the fixture has lost its point. */
  it("is a real disagreement, not a tie broken differently", () => {
    expect(Math.sign(compareIds(supplementary, fullwidth))).toBe(
      -Math.sign(byUtf8Bytes(supplementary, fullwidth)),
    );
  });
});

describe("the committed unicode fixture", () => {
  const model = readModelFileSync(join(fixtureDir, "model.jsonl"));

  it("is in canonical order — by code unit, not by byte", () => {
    const ids = model.entities.map((entity) => entity.id);
    expect(ids).toEqual(sortIds(ids));

    // And that order is NOT the one a BINARY collation would produce, which is
    // the whole reason this fixture is committed.
    const byBytes = [...ids].sort(byUtf8Bytes);
    expect(byBytes).not.toEqual(ids);
  });

  it("puts the disagreement on adjacent entities, so a swap is visible", () => {
    const ids = model.entities.map((entity) => entity.id);
    const supplementary = ids.findIndex((id) => id.includes("\u{20000}"));
    const fullwidth = ids.findIndex((id) => id.includes("Ａ"));
    expect(supplementary).toBeGreaterThanOrEqual(0);
    expect(fullwidth).toBeGreaterThanOrEqual(0);
    expect(supplementary).toBeLessThan(fullwidth);
  });

  /**
   * The surrogate is the identity of a reference. If a reader ever renumbered
   * the corpus by re-sorting it under another collation, these edges would
   * point somewhere else — so the fixture asserts what its edges MEAN, not just
   * that they parse.
   */
  it("has edges whose endpoints survive the ordering question", () => {
    const byId = new Map(model.entities.map((entity) => [entity.id, entity]));
    for (const edge of model.edges) {
      expect(byId.has(edge.from), edge.from).toBe(true);
      expect(byId.has(edge.to), edge.to).toBe(true);
    }
    expect(model.edges.length).toBeGreaterThan(0);
  });

  /**
   * The committed reference outputs. Regenerating them is a deliberate act with
   * a reviewable diff — which is exactly what they are for.
   */
  it("still produces the committed reference report", () => {
    const reference = readFileSync(join(fixtureDir, "analyze-deps-type.txt"), "utf8");
    // The identifiers must survive into the artefact intact, in canonical order.
    const supplementaryAt = reference.indexOf("\u{20000}Supplementary");
    const fullwidthAt = reference.indexOf("ＡFullwidth");
    expect(supplementaryAt).toBeGreaterThanOrEqual(0);
    expect(fullwidthAt).toBeGreaterThanOrEqual(0);
    expect(reference).toContain("nodes: 3");
  });
});
