import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isStubEntity } from "../src/entity.js";
import { encodeModelToString } from "../src/jsonl.js";
import { readModelFileSync } from "../src/jsonl-file.js";
import { parseModel, type Model } from "../src/model.js";
import { SourceAnchor } from "../src/primitives.js";
import { validateModel } from "../src/profile.js";
import { elixirProfile } from "../src/profiles/elixir.js";
import { selfReferences, unknownReferences } from "../src/integrity.js";

/**
 * THE M15 ACCEPTANCE GATE — the Java, C# and TypeScript gates, replayed for
 * the fourth real extractor, the first written for a BEAM language. The
 * extractor's own ExUnit suite pins the snapshot and its evidence; what only
 * this side can say is that the composition is one the Elixir PROFILE
 * licenses — data the extractor never imports — and the strongest statement:
 * two independent encoders, one in Elixir and one here, write the same bytes.
 */

const SNAPSHOT = fileURLToPath(new URL("../../../fixtures/elixir/expected/model.jsonl", import.meta.url));

function loadSnapshot(): Model {
  return parseModel(readModelFileSync(SNAPSHOT));
}

function entity(model: Model, id: string): Record<string, unknown> {
  const found = model.entities.find((candidate) => candidate.id === id);
  expect(found, id).toBeDefined();
  return found as unknown as Record<string, unknown>;
}

describe("fixtures/elixir/expected/model.jsonl", () => {
  it("parses as a Model — the extractor's output is core's Model, not merely schema-shaped", () => {
    expect(() => loadSnapshot()).not.toThrow();
  });

  it("is byte-identical to what core's own encoder would write", () => {
    expect(encodeModelToString(loadSnapshot())).toBe(readFileSync(SNAPSHOT, "utf8"));
  });

  it("validates against the Elixir profile with ZERO issues", () => {
    const issues = validateModel(loadSnapshot(), elixirProfile);
    expect(issues.map((i) => `${i.code} @ ${i.path}: ${i.message}`)).toEqual([]);
  });

  it("is closed: every referenced id resolves to an entity in the model", () => {
    expect(unknownReferences(loadSnapshot()).map((r) => `${r.path} -> ${r.id}`)).toEqual([]);
  });

  it("has no self-referencing edges", () => {
    expect(selfReferences(loadSnapshot()).map((s) => s.path)).toEqual([]);
  });

  it("names the extractor and the toolchain whose module table decided the stubs", () => {
    const header = JSON.parse(readFileSync(SNAPSHOT, "utf8").split("\n")[0] as string) as {
      lang: string;
      root: string;
      extractor: Record<string, unknown>;
    };
    expect(header.lang).toBe("ex");
    expect(header.root).toBe("fixtures/elixir/src");
    expect(header.extractor["name"]).toBe("codegraph-elixir");
    expect(header.extractor["elixir"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(header.extractor["otp"]).toMatch(/^\d+$/);
  });

  it("makes the FILE the module and the defmodule a type below it, keys escaped (PLAN §16.3)", () => {
    const model = loadSnapshot();
    const file = entity(model, "ex:lib%2Facme_order%2Forder.ex");
    expect(file["kind"]).toBe("file");
    expect(file["name"]).toBe("lib/acme_order/order.ex");
    expect(file["definedIn"]).toEqual(["lib/acme_order/order.ex"]);
    const order = entity(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder");
    expect(order["kind"]).toBe("module");
    expect(order["name"]).toBe("AcmeOrder.Order");
    expect(order["parent"]).toBe("ex:lib%2Facme_order%2Forder.ex");
    expect(order["traits"]).toContain("TType");
    expect(order["traits"]).not.toContain("TModule");
    // A `#` in a file name is escaped, and the name keeps it.
    expect(entity(model, "ex:lib%2Facme_order%2Fpromo%232024.ex")["name"]).toBe("lib/acme_order/promo#2024.ex");
    // An atom-named module with a dot: escaped in the key, written in the name.
    expect(entity(model, "ex:lib%2Facme_order%2Flegacy%2Fatom_module.ex/legacy%2Emod")["name"]).toBe("legacy.mod");
  });

  it("carries arity as identity on every invocable, defaults and clauses folded", () => {
    const model = loadSnapshot();
    const create = entity(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.create#2");
    expect(create["signature"]).toBe("create/2");
    expect(create["parameters"]).toEqual([]);
    expect(create["defaults"]).toBe(1);
    expect(model.entities.some((e) => e.id === "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.create#1")).toBe(false);
    // Two clauses of total/1 are one entity spanning both.
    const total = entity(model, "ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder.total#1");
    expect(SourceAnchor.parse(total["anchor"]).span).toEqual([19, 25]);
    // A defp is the same kind with a pass-through key.
    expect(entity(model, "ex:mix.exs/AcmeOrder%2EMixProject.deps#0")["private"]).toBe(true);
    for (const e of model.entities) {
      if (e.kind === "function" || e.kind === "macro" || e.kind === "callback") {
        expect(e.id, e.id).toMatch(/#\d+$/);
      }
    }
  });

  it("carries the evidence the stub discipline exists to prove (PLAN §16.4)", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    // The reserved modules exist only because something points below them.
    const otp = byId.get("ex:<otp>");
    expect(otp).toBeDefined();
    expect(isStubEntity(otp!)).toBe(true);
    expect((otp as unknown as Record<string, unknown>)["definedIn"]).toEqual([]);
    // An OTP module below <otp>, a dependency below <deps>, each a stub type with its parent.
    const genServer = byId.get("ex:<otp>/GenServer");
    expect(genServer?.kind).toBe("module");
    expect(isStubEntity(genServer!)).toBe(true);
    expect((genServer as unknown as Record<string, unknown>)["parent"]).toBe("ex:<otp>");
    expect(isStubEntity(byId.get("ex:<deps>/Ecto%2ESchema")!)).toBe(true);
    // Resolvability is not membership: a corpus module is never a stub.
    expect(byId.has("ex:<deps>/AcmeOrder%2EPricing")).toBe(false);
    expect(model.edges.some((e) => e.edge === "import" && e.from === "ex:lib%2Facme_order%2Fstock.ex" && e.to === "ex:<otp>/GenServer")).toBe(true);
    expect(model.edges.some((e) => e.edge === "import" && e.from === "ex:lib%2Facme_order%2Fschema%2Fline.ex" && e.to === "ex:<deps>/Ecto%2ESchema")).toBe(true);
  });

  it("folds every import to the file and lands implementation edges on declared modules", () => {
    const model = loadSnapshot();
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    const imports = model.edges.filter((e) => e.edge === "import");
    expect(imports.length).toBeGreaterThan(0);
    for (const edge of imports) {
      expect(byId.get(edge.from)?.kind, edge.from).toBe("file");
      const target = byId.get(edge.to);
      expect(target, edge.to).toBeDefined();
      // A corpus target is a file; an external one the stub module below its reserved module.
      if (!isStubEntity(target!)) expect(target?.kind, edge.to).toBe("file");
    }
    expect(imports.some((e) => e.from === "ex:lib%2Facme_order%2Fpricing%2Fpremium.ex" && e.to === "ex:lib%2Facme_order%2Fpricing%2Fstandard.ex")).toBe(true);
    const impl = model.edges.find(
      (e) => e.edge === "interfaceImplementation" && e.from === "ex:lib%2Facme_order%2Fpricing%2Fstandard.ex/AcmeOrder%2EPricing%2EStandard",
    );
    expect(impl?.to).toBe("ex:lib%2Facme_order%2Fpricing.ex/AcmeOrder%2EPricing");
    expect(impl?.provenance).toBe("declared");
  });

  it("reifies defimpl as a named module attached to its type, the edge anchored at the block", () => {
    const model = loadSnapshot();
    const impl = entity(model, "ex:lib%2Facme_order%2Fmoney.ex/String%2EChars%2EAcmeOrder%2EMoney");
    expect(impl["attachedTo"]).toBe("ex:lib%2Facme_order%2Fmoney.ex/AcmeOrder%2EMoney");
    expect(impl["traits"]).toContain("TAttachedTo");
    const edge = model.edges.find(
      (e) => e.edge === "interfaceImplementation" && e.from === "ex:lib%2Facme_order%2Fmoney.ex/AcmeOrder%2EMoney",
    );
    expect(edge?.to).toBe("ex:<otp>/String%2EChars");
    expect(edge?.anchor.span).toEqual([16, 18]);
    expect(entity(model, "ex:lib%2Facme_order%2Fpriceable.ex/AcmeOrder%2EPriceable.price#1")["kind"]).toBe("callback");
  });

  it("keeps a file the parser rejected as a file record with nothing below it", () => {
    const model = loadSnapshot();
    const broken = "ex:lib%2Facme_order%2Flegacy%2Fbroken.ex";
    expect(entity(model, broken)["kind"]).toBe("file");
    expect(model.entities.some((e) => (e as unknown as Record<string, unknown>)["parent"] === broken)).toBe(false);
  });
});
