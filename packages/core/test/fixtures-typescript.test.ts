import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStubEntity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { SourceAnchor } from "../src/primitives.js";
import { validateModel } from "../src/profile.js";
import { typescriptProfile } from "../src/profiles/typescript.js";
import { selfReferences, unknownReferences } from "../src/integrity.js";

/**
 * THE M13 ACCEPTANCE GATE — the Java and C# gates, replayed for the third
 * real extractor, and the first written in core's own language. The
 * extractor's own suite validates every line against the per-record schemas
 * and the sequence rules; what only this side can say is that the
 * composition is one the TypeScript PROFILE licenses — data the extractor
 * never imports (CLAUDE.md: "extractors contain no metamodel intelligence",
 * and `typescript` is its only runtime dependency). And the strongest
 * statement: two independent encoders, one in the extractor and one here,
 * write the same bytes for the same model.
 */

const SNAPSHOT = fileURLToPath(
  new URL("../../../fixtures/typescript/expected/model.jsonl", import.meta.url),
);

function loadSnapshot(): Model {
  return parseModel(readModelFileSync(SNAPSHOT));
}

function entity(model: Model, id: string): Record<string, unknown> {
  const found = model.entities.find((candidate) => candidate.id === id);
  expect(found, id).toBeDefined();
  return found as unknown as Record<string, unknown>;
}

describe("fixtures/typescript/expected/model.jsonl", () => {
  it("parses as a Model — the extractor's output is core's Model, not merely schema-shaped", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  it("is byte-identical to what core's own encoder would write", () => {
    expect(encodeModelToString(loadSnapshot())).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("validates against the TypeScript profile with ZERO issues", () => {
    const issues = validateModel(loadSnapshot(), typescriptProfile);
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("is closed: every referenced id resolves to an entity in the model", () => {
    const dangling = unknownReferences(loadSnapshot());
    expect(dangling.map((r) => `${r.path} -> ${r.id}`)).toEqual([]);
  });

  it("has no self-referencing edges", () => {
    expect(selfReferences(loadSnapshot()).map((s) => s.path)).toEqual([]);
  });

  it("keys every corpus entity by its FILE, with reserved characters percent-encoded (PLAN §14.3)", () => {
    const model = loadSnapshot();
    // The module's key is the escaped path; its name the path as written.
    const order = entity(model, "ts:packages%2Forder%2Fsrc%2Forder.ts");
    expect(order["kind"]).toBe("module");
    expect(order["name"]).toBe("packages/order/src/order.ts");
    expect(order["definedIn"]).toEqual(["packages/order/src/order.ts"]);
    // A `#` in a file name is escaped too, and its import edge lands on it.
    const promo = entity(model, "ts:packages%2Forder%2Fsrc%2Fpromo%232024.ts");
    expect(promo["name"]).toBe("packages/order/src/promo#2024.ts");
    expect(
      model.edges.some(
        (e) =>
          e.edge === "import" &&
          e.from === "ts:packages%2Forder%2Fsrc%2Fhandler.ts" &&
          e.to === "ts:packages%2Forder%2Fsrc%2Fpromo%232024.ts",
      ),
    ).toBe(true);
    // A type's key is its file plus its name.
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Forder.ts/Order")["parent"]).toBe(
      "ts:packages%2Forder%2Fsrc%2Forder.ts",
    );
  });

  it("carries the evidence the stub discipline exists to prove (PLAN §14.4)", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));

    // An import from a package that is NOT installed is a stub module keyed
    // by the specifier as written — the import edge survives.
    const ledger = byId.get("ts:@megacorp%2Fledger");
    expect(ledger, "the absent package must appear as a stub module").toBeDefined();
    expect(isStubEntity(ledger!)).toBe(true);
    expect((ledger as unknown as Record<string, unknown>)["definedIn"]).toEqual([]);
    expect(
      model.edges.some((e) => e.edge === "import" && e.to === "ts:@megacorp%2Fledger"),
    ).toBe(true);

    // The type it should have provided binds to nothing: a stub in the
    // reserved module, named as written — never in the corpus's own file.
    const client = byId.get("ts:<unresolved>/LedgerClient");
    expect(client).toBeDefined();
    expect(isStubEntity(client!)).toBe(true);
    expect(
      model.edges.some(
        (e) =>
          e.edge === "inheritance" &&
          e.from === "ts:packages%2Forder%2Fsrc%2Fledger-adapter.ts/LedgerAdapter" &&
          e.to === "ts:<unresolved>/LedgerClient",
      ),
    ).toBe(true);

    // Resolvability is not membership: the compiler's lib resolves `Error`
    // and it is still external, in the reserved `<lib>` module.
    expect(isStubEntity(byId.get("ts:<lib>/Error")!)).toBe(true);
    expect(byId.has("ts:<unresolved>/Error")).toBe(false);

    // An ambient module the corpus DECLARES is a real module, not a stub, and
    // its augmentation counts as a second declaration site.
    const legacy = byId.get("ts:legacy-lib");
    expect(legacy).toBeDefined();
    expect(isStubEntity(legacy!)).toBe(false);
    expect((legacy as unknown as Record<string, unknown>)["definedIn"]).toEqual([
      "packages/order/src/ambient.d.ts",
      "packages/order/src/augment.ts",
    ]);
  });

  it("populates declaration spaces, and only the licensed ones (METAMODEL §1.4)", () => {
    const model = loadSnapshot();
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Fpriceable.ts/Priceable")["space"]).toEqual(["type"]);
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Fmoney.ts/Cents")["space"]).toEqual(["type"]);
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Fmoney.ts/Money")["space"]).toEqual(["type", "value"]);
    // A const enum is inlined at emit: type space only; a plain enum is both.
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Fchannel.ts/Priority")["space"]).toEqual(["type"]);
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Fchannel.ts/Channel")["space"]).toEqual(["type", "value"]);
    for (const e of model.entities) {
      if (isStubEntity(e)) continue;
      expect(e.space, e.id).toBeDefined();
    }
  });

  it("makes declaration merging one entity per declaring file, the strongest kind owning the key", () => {
    const model = loadSnapshot();
    // Same-file interface merging: one entity, anchored at the first declaration.
    const discountable = model.entities.filter((e) => e.id === "ts:packages%2Forder%2Fsrc%2Fdiscountable.ts/Discountable");
    expect(discountable).toHaveLength(1);
    expect(SourceAnchor.parse((discountable[0] as unknown as Record<string, unknown>)["anchor"]).span[0]).toBe(4);
    // Cross-file namespace merging: two entities, one per file, in the files that wrote them.
    expect(entity(model, "ts:legacy%2Facme.ts/Acme.Order")["kind"]).toBe("namespace");
    expect(entity(model, "ts:legacy%2Facme-report.ts/Acme.Order")["kind"]).toBe("namespace");
    // And a reference across the merge lands on the declaration that owns the member.
    expect(
      model.edges.some(
        (e) =>
          e.edge === "inheritance" &&
          e.from === "ts:legacy%2Facme-report.ts/Acme.Order.Report" &&
          e.to === "ts:legacy%2Facme.ts/Acme.Order.Registry",
      ),
    ).toBe(true);
    // A class merged with an interface (module augmentation) is ONE class.
    const things = model.entities.filter((e) => e.id.startsWith("ts:legacy-lib/Thing"));
    expect(things.map((e) => `${e.id}:${e.kind}`)).toEqual(["ts:legacy-lib/Thing:class"]);
    expect(
      model.edges.some(
        (e) => e.edge === "inheritance" && e.from === "ts:packages%2Forder%2Fsrc%2Faugment.ts/Wrapper" && e.to === "ts:legacy-lib/Thing",
      ),
    ).toBe(true);
  });

  it("folds every import to module level and resolves a workspace package by name with nothing installed", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    const imports = model.edges.filter((e) => e.edge === "import");
    expect(imports.length).toBeGreaterThan(0);
    for (const edge of imports) {
      expect(byId.get(edge.from)?.kind, edge.from).toBe("module");
      expect(byId.get(edge.to)?.kind, edge.to).toBe("module");
    }
    const fromOrder = new Set(imports.filter((e) => e.from === "ts:packages%2Forder%2Fsrc%2Forder.ts").map((e) => e.to));
    // `@acme/pricing` by package.json name, `@order/channel` by tsconfig paths, `./abstract-order.js` relatively.
    expect(fromOrder.has("ts:packages%2Fpricing%2Fsrc%2Findex.ts")).toBe(true);
    expect(fromOrder.has("ts:packages%2Forder%2Fsrc%2Fchannel.ts")).toBe(true);
    expect(fromOrder.has("ts:packages%2Forder%2Fsrc%2Fabstract-order.ts")).toBe(true);
    // `import type` is an ordinary import edge whose erasure shows in the TARGET.
    expect(fromOrder.has("ts:packages%2Forder%2Fsrc%2Fmoney.ts")).toBe(true);
    // A `/// <reference path>` is a file-to-file dependency; a dynamic import with a literal too.
    expect(imports.some((e) => e.from === "ts:legacy%2Facme-report.ts" && e.to === "ts:legacy%2Facme.ts")).toBe(true);
    expect(imports.some((e) => e.from === "ts:packages%2Forder%2Fsrc%2Flazy.ts" && e.to === "ts:packages%2Forder%2Fsrc%2Freporting.ts")).toBe(true);
  });

  it("separates an interface's extends from a class's implements", () => {
    const model = loadSnapshot();
    const kindOf = (from: string, to: string): string | undefined =>
      model.edges.find((e) => e.from === from && e.to === to)?.edge;
    expect(kindOf("ts:packages%2Forder%2Fsrc%2Fdiscountable.ts/Discountable", "ts:packages%2Forder%2Fsrc%2Fpriceable.ts/Priceable")).toBe("inheritance");
    expect(kindOf("ts:packages%2Forder%2Fsrc%2Fabstract-order.ts/AbstractOrder", "ts:packages%2Forder%2Fsrc%2Fdiscountable.ts/Discountable")).toBe("interfaceImplementation");
    expect(kindOf("ts:packages%2Forder%2Fsrc%2Forder.ts/Order", "ts:packages%2Forder%2Fsrc%2Fabstract-order.ts/AbstractOrder")).toBe("inheritance");
    expect(entity(model, "ts:packages%2Forder%2Fsrc%2Fabstract-order.ts/AbstractOrder")["kind"]).toBe("abstractClass");
  });

  it("separates facts from inferences: every edge carries a known provenance", () => {
    const model = loadSnapshot();
    expect(model.edges.length).toBeGreaterThan(0);
    expect(new Set(model.edges.map((e) => e.provenance))).toEqual(new Set(["declared"]));
  });

  it("anchors every entity that claims TSourceAnchor to a 1-based span in the corpus", () => {
    const model = loadSnapshot();
    for (const e of model.entities) {
      if (!e.traits.includes("TSourceAnchor")) continue;
      const anchor = SourceAnchor.parse((e as unknown as Record<string, unknown>)["anchor"]);
      expect(anchor.file, e.id).not.toMatch(/^\//);
      expect(anchor.file, e.id).not.toContain("\\");
      expect(anchor.span[0], e.id).toBeGreaterThan(0);
      expect(anchor.span[1], e.id).toBeGreaterThanOrEqual(anchor.span[0]);
    }
  });

  it("writes non-ASCII identifiers and text unescaped, as the encoder does", () => {
    const raw = readFileSync(SNAPSHOT, "utf8");
    expect(raw).toContain('"name":"Résumé"');
    expect(raw).not.toContain("\\u00");
  });
});
