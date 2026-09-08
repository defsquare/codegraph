import { describe, expect, it } from "vitest";
import { Ids, packageNameOf } from "../src/ids.js";
import { renderKey } from "../src/model/keys.js";
import { extractFixture } from "./harness.js";

describe("the id scheme's classification", () => {
  it("names an installed package by its npm name, scoped or not, from the LAST node_modules segment", () => {
    expect(packageNameOf("/r/node_modules/zod/v4/index.d.ts")).toBe("zod");
    expect(packageNameOf("/r/node_modules/@types/node/fs.d.ts")).toBe("@types/node");
    expect(packageNameOf("/r/node_modules/a/node_modules/@s/b/index.d.ts")).toBe("@s/b");
    expect(packageNameOf("/r/src/index.ts")).toBeUndefined();
  });

  it("normalises Node built-ins to the node: form and leaves other specifiers alone", () => {
    expect(Ids.normalizeSpecifier("fs")).toBe("node:fs");
    expect(Ids.normalizeSpecifier("node:fs")).toBe("node:fs");
    expect(Ids.normalizeSpecifier("fs/promises")).toBe("node:fs/promises");
    expect(Ids.normalizeSpecifier("node:sqlite")).toBe("node:sqlite");
    expect(Ids.normalizeSpecifier("zod")).toBe("zod");
    expect(Ids.normalizeSpecifier("./local")).toBe("./local");
  });
});

describe("keys of the fixture", () => {
  const { model, stats } = extractFixture();
  const ids = new Set(model.entities.map((entity) => renderKey(entity.key)));

  it("keys every corpus entity below its file, and every type below its owner", () => {
    expect(ids.has("ts:packages%2Forder%2Fsrc%2Forder.ts")).toBe(true);
    expect(ids.has("ts:packages%2Forder%2Fsrc%2Forder.ts/Order")).toBe(true);
    expect(ids.has("ts:legacy%2Facme.ts/Acme")).toBe(true);
    expect(ids.has("ts:legacy%2Facme.ts/Acme.Order")).toBe(true);
    expect(ids.has("ts:legacy%2Facme.ts/Acme.Order.Registry")).toBe(true);
  });

  it("keys an ambient module by its quoted name, and a global-scope declaration by the file that wrote it", () => {
    expect(ids.has("ts:legacy-lib")).toBe(true);
    expect(ids.has("ts:legacy-lib/Thing")).toBe(true);
    expect(ids.has("ts:packages%2Forder%2Fsrc%2Faugment.ts/AcmeWindow")).toBe(true);
  });

  it("counts what it drops, and names every resolution outcome", () => {
    expect(stats.unresolved).toBe(1);
    expect(stats.importsUnresolved).toBe(1);
    expect(stats.importsWorkspaceResolved).toBe(1);
    expect(stats.computedImportsDropped).toBe(1);
    expect(stats.heritageExpressionsDropped).toBe(0);
    expect(stats.duplicateKeys).toEqual([]);
  });
});
