import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TRAITS, WIRE_TRAITS, readModelFileSync, type TraitName } from "@codegraph/core";

import { loadDecodedModels } from "../src/load.js";
import { importModel, openStore } from "../src/store/import.js";
import { diagnoseStore } from "../src/store/diagnose.js";

/**
 * THE DIAGNOSTIC PARITY CONTRACT.
 *
 * `diagnoseStore` answers in SQL what `loadDecodedModels` answers by walking
 * 241 101 entities with Zod, and the acceptable relationship is again EQUALITY
 * — including the ORDER of `profileIssues`, because that array is the report a
 * user reads and its order is the model's.
 *
 * **Both real corpora are clean**, so parity on them proves almost nothing: an
 * implementation that returned "no issues" unconditionally would pass. So every
 * category is exercised on a model broken ON PURPOSE — a composition its
 * profile forbids, an unlicensed edge kind, an id redeclared with a different
 * kind, a lang with no profile — and each case asserts the issue is actually
 * there before asserting that the two paths agree about it.
 */

const fixture = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-diagnose-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The two diagnoses of one model file, ready to compare. */
function bothWays(name: string, jsonlPath: string) {
  const db = openStore(importModel(jsonlPath, join(scratch, `${name}.db`)).path);
  const fromStore = diagnoseStore(db, { label: jsonlPath, modelIndex: 0 });
  db.close();
  const { diagnostics } = loadDecodedModels([readModelFileSync(jsonlPath)], {
    sources: [jsonlPath],
  });
  return { fromStore, inMemory: diagnostics };
}

function expectSameDiagnosis(name: string, jsonlPath: string) {
  const { fromStore, inMemory } = bothWays(name, jsonlPath);
  expect(fromStore.profileIssues, `${name}: profileIssues`).toEqual(inMemory.profileIssues);
  expect(fromStore.profileIssueCounts, `${name}: counts`).toEqual(inMemory.profileIssueCounts);
  expect(fromStore.unknownProfiles, `${name}: unknownProfiles`).toEqual(inMemory.unknownProfiles);
  expect(fromStore.duplicateIds, `${name}: duplicateIds`).toEqual(inMemory.duplicateIds);
  expect(fromStore.selfEdges, `${name}: selfEdges`).toEqual(inMemory.selfEdges);
  expect(fromStore.danglingReferences, `${name}: danglingReferences`).toEqual(
    inMemory.danglingReferences,
  );
  return { fromStore, inMemory };
}

/** Rewrite the fixture's lines, keeping it a readable model. */
function mutated(name: string, edit: (lines: Record<string, unknown>[]) => void): string {
  const lines = readFileSync(fixture, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  edit(lines);
  const path = join(scratch, `${name}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

const firstEntityAt = (lines: Record<string, unknown>[]): number =>
  lines.findIndex((line) => line["t"] === "e");

describe("a clean corpus", () => {
  it("is diagnosed identically from the store", () => {
    const { inMemory } = expectSameDiagnosis("clean", fixture);
    // The guard against this file passing by agreeing that nothing is wrong.
    expect(inMemory.profileIssues).toEqual([]);
  });
});

describe("a model broken on purpose", () => {
  /**
   * A composition the profile forbids. This is the case MM-4 makes cheap: the
   * verdict is decided once for `(kind, trait set, isStub)` and then attached to
   * every entity that shares it — so the test asserts BOTH that the issue
   * appears and that it appears once per affected entity, in model order.
   */
  it("agrees about a kind whose required traits are missing", () => {
    const path = mutated("bad-composition", (lines) => {
      const at = firstEntityAt(lines);
      // Strip a required trait from one entity, and the key it contributed.
      lines[at + 1]!["tr"] = [(lines[at + 1]!["tr"] as number[])[0]];
      delete lines[at + 1]!["parent"];
      delete lines[at + 1]!["anchor"];
      delete lines[at + 1]!["isStub"];
      delete lines[at + 1]!["declaredType"];
      delete lines[at + 1]!["signature"];
      delete lines[at + 1]!["parameters"];
      delete lines[at + 1]!["localVariables"];
      delete lines[at + 1]!["comments"];
      delete lines[at + 1]!["definedIn"];
    });
    const { inMemory } = expectSameDiagnosis("bad-composition", path);
    expect(inMemory.profileIssues.length, "the mutation produced no issue to compare").toBeGreaterThan(0);
  });

  /** A function of the edge kind — six values, not 24 631 edges. */
  it("agrees about an edge kind the profile does not emit", () => {
    const path = mutated("bad-edge-kind", (lines) => {
      const header = lines[0] as { dict: { edges: string[] } };
      // `traitUsage` is a PHP edge kind; the Java profile does not emit it.
      header.dict.edges = [...header.dict.edges, "traitUsage"];
      const at = lines.findIndex((line) => line["t"] === "x");
      lines[at]!["k"] = header.dict.edges.length - 1;
    });
    const { inMemory } = expectSameDiagnosis("bad-edge-kind", path);
    expect(inMemory.profileIssueCounts["edge-kind-not-allowed"]).toBeGreaterThan(0);
  });

  /**
   * Two entities claiming one identity with DIFFERENT kinds. The store compares
   * the canonical trait SET rather than the interned set id, because two
   * entities whose traits differ only in order are the same declaration.
   */
  it("agrees about an id redeclared with a different kind", () => {
    const path = mutated("duplicate-id", (lines) => {
      const at = firstEntityAt(lines);
      // A second entity with the same natural key but another kind, inserted
      // right after its twin so canonical order is preserved.
      const clone = { ...lines[at + 1] } as Record<string, unknown>;
      clone["k"] = ((lines[at + 1]!["k"] as number) + 1) % 3;
      insertAfter(lines, at + 1, clone);
    });
    const { inMemory } = expectSameDiagnosis("duplicate-id", path);
    expect(inMemory.duplicateIds.length).toBeGreaterThan(0);
    expect(inMemory.duplicateIds[0]?.conflicting).toBe(true);
  });

  /**
   * No profile for the lang: not validated, still analyzed.
   *
   * The duplicate is deliberate. A duplicate identity is NOT a profile
   * question — the in-memory path computes it over the union whether or not a
   * profile exists — and an early return that skipped it would still have
   * passed on a fixture with none. So the case that distinguishes them is the
   * one this asserts.
   */
  it("agrees about a language with no profile, duplicates included", () => {
    const path = mutated("unknown-lang", (lines) => {
      (lines[0] as { lang: string }).lang = "esperanto";
      duplicateFirstEntity(lines);
    });
    const { inMemory } = expectSameDiagnosis("unknown-lang", path);
    expect(inMemory.unknownProfiles).toEqual(["esperanto"]);
    expect(inMemory.profileIssues).toEqual([]);
    expect(inMemory.duplicateIds.length, "no duplicate to disagree about").toBeGreaterThan(0);
  });

  /**
   * Two declarations of one identity whose traits differ only in ORDER.
   *
   * `sameDeclaration` compares the trait SET, so this is benign — but the store
   * interns the ORDERED sequence, so the two get different `trait_set_id`s.
   * Comparing those ids would call an agreement a conflict, flipping
   * `conflicting` and with it whether `codegraph validate` reports a finding.
   * The canonical key is what makes them agree.
   */
  it("agrees that traits in a different order are the same declaration", () => {
    const path = mutated("trait-order", (lines) => {
      const at = firstEntityAt(lines);
      const original = lines[at + 1]!;
      const clone = { ...original } as Record<string, unknown>;
      clone["tr"] = [...(original["tr"] as number[])].reverse();
      insertAfter(lines, at + 1, clone);
    });
    const { inMemory } = expectSameDiagnosis("trait-order", path);
    expect(inMemory.duplicateIds.length).toBe(1);
    expect(
      inMemory.duplicateIds[0]?.conflicting,
      "the reordered traits must read as the SAME declaration",
    ).toBe(false);
  });
});

/**
 * THE ORDER OF `profileIssues` IS PART OF THE ANSWER.
 *
 * `validateModel` emits per entity in model order; the store discovers by
 * CATEGORY — every composition first, then duplicates, then edges. Those two
 * orders coincide until issues of different categories land on entities in the
 * opposite order, so that is what this builds: a conflicting duplicate near the
 * front and a broken composition at the back. Found by mutation — deleting the
 * sort passed every other case in this file.
 */
describe("issues come back in the model's order, not the query's", () => {
  it("interleaves categories by entity position", () => {
    const path = mutated("issue-order", (lines) => {
      // A composition issue on the LAST entity.
      const entityIndexes = lines
        .map((line, index) => [line, index] as const)
        .filter(([line]) => line["t"] === "e")
        .map(([, index]) => index);
      const lastAt = entityIndexes[entityIndexes.length - 1]!;
      lines[lastAt]!["tr"] = [(lines[lastAt]!["tr"] as number[])[0]];

      // A conflicting duplicate near the FRONT.
      const at = firstEntityAt(lines);
      const clone = { ...lines[at + 1] } as Record<string, unknown>;
      clone["k"] = ((lines[at + 1]!["k"] as number) + 1) % 3;
      insertAfter(lines, at + 1, clone);
    });

    const { inMemory } = expectSameDiagnosis("issue-order", path);
    const codes = inMemory.profileIssues.map((issue) => issue.code);
    expect(codes, "the mutation produced too few issues to order").not.toHaveLength(0);
    expect(
      codes.includes("duplicate-entity-id") && codes.length > 1,
      "the two categories must both be present, or order cannot be wrong",
    ).toBe(true);
    // The duplicate is early in the model, so it comes first — a query that
    // emitted every composition before every duplicate would invert this.
    expect(codes.indexOf("duplicate-entity-id")).toBeLessThan(codes.length - 1);
  });

  /**
   * `isStubEntity` is "declares TType or TModule AND `isStub` is true". The
   * store has an `is_stub` column, and reading it alone would call an entity a
   * stub that the in-memory path does not — which changes the composition
   * verdict, because the trait lower bound is waived for stubs.
   */
  it("agrees about an isStub flag with no stubbable trait behind it", () => {
    const path = mutated("stub-without-trait", (lines) => {
      const at = firstEntityAt(lines);
      // Strip a non-module entity to too few traits — an error for a non-stub,
      // waived for a stub — and flag it as a stub WITHOUT giving it a stubbable
      // trait. In memory it is not a stub, so the error stands. Reading the
      // column alone would waive it and report nothing.
      const victim = at + 1;
      lines[victim]!["tr"] = [(lines[victim]!["tr"] as number[])[0]];
      lines[victim]!["isStub"] = true;
    });
    const { inMemory } = expectSameDiagnosis("stub-without-trait", path);
    expect(
      inMemory.profileIssues.length,
      "the waiver was never tested — the mutation produced no issue",
    ).toBeGreaterThan(0);
  });
});

/** Clone the first non-module entity, keeping the file a readable model. */
function duplicateFirstEntity(lines: Record<string, unknown>[]): void {
  const at = firstEntityAt(lines);
  insertAfter(lines, at + 1, { ...lines[at + 1] } as Record<string, unknown>);
}

/**
 * Insert an entity record after `at`, renumbering everything that follows.
 * Surrogates are positional, so an insertion shifts every later reference.
 */
function insertAfter(
  lines: Record<string, unknown>[],
  at: number,
  clone: Record<string, unknown>,
): void {
  clone["i"] = (lines[at]!["i"] as number) + 1;
  for (let i = at + 1; i < lines.length; i += 1) shiftSurrogates(lines[i]!);
  lines.splice(at + 1, 0, clone);
  (lines[lines.length - 1] as { counts: { entities: number } }).counts.entities += 1;
}

/**
 * Shift every entity reference by one, for a mutation that inserts an entity.
 * Surrogates are positional, so an insertion renumbers everything after it —
 * exactly the property `fixtures/unicode` exists to protect.
 */
function shiftSurrogates(line: Record<string, unknown>): void {
  const bump = (value: unknown): unknown =>
    typeof value === "number" ? value + 1 : Array.isArray(value) ? value.map(bump) : value;
  for (const key of ["i", "m", "parent", "attachedTo", "declaredType", "parameters", "localVariables"]) {
    if (key in line) line[key] = bump(line[key]);
  }
  for (const key of ["f", "o", "candidates"]) {
    if (key in line) line[key] = bump(line[key]);
  }
}

/**
 * THE LICENCE FOR THE ONE CHECK `diagnoseStore` SKIPS.
 *
 * `validateEntity` parses every declared trait's keys with Zod, per entity —
 * the bulk of the 1.3s. The store skips it on the grounds that the record
 * reader already enforced `WIRE_TRAITS`, which is `TRAITS` with ids replaced by
 * surrogates and paths by file references. That is only true while the two
 * tables carry the same keys for the same traits, so this pins it: if `core`
 * ever gives `TRAITS` a key the wire does not carry, the skip stops being safe
 * and this fails rather than the diagnosis quietly going blind.
 */
describe("what licenses skipping the per-entity trait parse", () => {
  it("gives every trait the same key set in TRAITS and WIRE_TRAITS", () => {
    const drift: string[] = [];
    for (const trait of Object.keys(TRAITS) as TraitName[]) {
      const inModel = Object.keys(TRAITS[trait].shape).sort();
      const onWire = Object.keys(WIRE_TRAITS[trait].shape).sort();
      // `children` is the one deliberate difference: MM-2 removed it from the
      // wire and it is derived by the analyzer, never read off an entity.
      const expected = inModel.filter((key) => key !== "children");
      if (expected.join(",") !== onWire.join(",")) {
        drift.push(`${trait}: model [${inModel}] vs wire [${onWire}]`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("covers every trait, so the comparison above is not over an empty table", () => {
    expect(Object.keys(TRAITS).length).toBeGreaterThan(10);
    expect(Object.keys(WIRE_TRAITS).length).toBe(Object.keys(TRAITS).length);
  });

  /**
   * And the reader really does refuse a violating value, rather than merely
   * declaring the key. A `TNamed` entity whose `name` is empty must not reach a
   * row — if it did, the skipped check would have been the one to catch it.
   */
  it("refuses on the wire a value the model schema would reject", () => {
    const path = mutated("empty-name", (lines) => {
      const at = firstEntityAt(lines);
      lines[at + 1]!["name"] = "";
    });
    expect(() => importModel(path, join(scratch, "empty-name.db"))).toThrow();
  });
});
