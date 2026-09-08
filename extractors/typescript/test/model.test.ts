import { describe, expect, it } from "vitest";
import { renderKey } from "../src/model/keys.js";
import type { Edge, Entity } from "../src/model/model.js";
import { extractFixture } from "./harness.js";

/**
 * The M13b model over the fixture corpus, claim by claim: members and their
 * keys, the edge kinds and their evidence, measures hand-counted from the
 * source, and the written values. Every id below reads straight from
 * `fixtures/typescript/src` (its README names the hazard each file pins).
 */
const { model, stats } = extractFixture();
const byId = new Map<string, Entity>(model.entities.map((entity) => [renderKey(entity.key), entity]));
const edges: (Edge & { fromId: string; toId: string })[] = model.edges.map((edge) => ({
  ...edge,
  fromId: renderKey(edge.from),
  toId: renderKey(edge.to),
}));

const ORDER = "ts:packages%2Forder%2Fsrc%2Forder.ts";
const MONEY = "ts:packages%2Forder%2Fsrc%2Fmoney.ts";
const NOTIFICATIONS = "ts:packages%2Forder%2Fsrc%2Fnotifications.ts";
const REPORTING = "ts:packages%2Forder%2Fsrc%2Freporting.ts";
const BASKET = "ts:packages%2Forder%2Fsrc%2Fbasket.ts";
const DECORATORS = "ts:packages%2Forder%2Fsrc%2Fdecorators.ts";
const CHANNEL = "ts:packages%2Forder%2Fsrc%2Fchannel.ts";
const ABSTRACT = "ts:packages%2Forder%2Fsrc%2Fabstract-order.ts";

function entity(id: string): Entity {
  const found = byId.get(id);
  expect(found, id).toBeDefined();
  return found as Entity;
}

function edgesFrom(fromId: string, kind?: Edge["kind"]): (Edge & { fromId: string; toId: string })[] {
  return edges.filter((edge) => edge.fromId === fromId && (kind === undefined || edge.kind === kind));
}

describe("members and their keys (PLAN §14.3)", () => {
  it("keys a static beside an instance member with #static, and a lone static plainly", () => {
    expect(entity(`${ORDER}/Order.parse`).kind).toBe("method");
    expect(entity(`${ORDER}/Order.parse#static`).kind).toBe("method");
    expect(byId.has(`${MONEY}/Money.zero`)).toBe(true);
    expect(byId.has(`${MONEY}/Money.zero#static`)).toBe(false);
  });

  it("keys an accessor pair with #get and #set, a lone getter plainly", () => {
    expect(entity(`${MONEY}/Money.amount#get`).signature).toBe("(): number");
    expect(entity(`${MONEY}/Money.amount#set`).signature).toBe("(value: number): void");
    expect(entity(`${BASKET}/Basket.count`).kind).toBe("method");
  });

  it("escapes a #private and a string-literal member name, and a computed one", () => {
    expect(entity(`${MONEY}/Money.%23secret`).name).toBe("#secret");
    expect(entity(`${MONEY}/Money.as%2Etext`).name).toBe("as.text");
    expect(entity(`${BASKET}/Ops.max%2Elines`).name).toBe("max.lines");
    expect(entity(`${BASKET}/Ops.[Symbol%2Eiterator]`).kind).toBe("property");
  });

  it("makes a constructor an unnamed invocable and a parameter property a field too", () => {
    const ctor = entity(`${MONEY}/Money.constructor`);
    expect(ctor.kind).toBe("constructor");
    expect(ctor.name).toBeUndefined();
    expect(ctor.parameters?.map(renderKey)).toEqual([`${MONEY}/Money.constructor#param:cents`]);
    expect(entity(`${MONEY}/Money.cents`).kind).toBe("property");
    expect(entity(`${ABSTRACT}/AbstractOrder.reference`).kind).toBe("property");
  });

  it("identifies nameless invocables by line:column, two on one line included, and chains parameters below", () => {
    expect(entity(`${NOTIFICATIONS}/both#8:16`).kind).toBe("arrowFunction");
    expect(entity(`${NOTIFICATIONS}/both#8:57`).kind).toBe("arrowFunction");
    expect(entity(`${NOTIFICATIONS}/onShipped#4:26`).parent).toEqual({ module: "packages%2Forder%2Fsrc%2Fnotifications.ts", symbol: "onShipped" });
    expect(entity(`${NOTIFICATIONS}/onShipped#4:26#param:order`).kind).toBe("parameter");
    // A function expression is a nameless `function`; a top-level IIFE has an empty symbol.
    expect(entity(`${NOTIFICATIONS}/shout#19:22`).kind).toBe("function");
    expect(entity(`${NOTIFICATIONS}#23:2`).kind).toBe("arrowFunction");
    expect(entity(`${NOTIFICATIONS}#23:2`).parent).toEqual({ module: "packages%2Forder%2Fsrc%2Fnotifications.ts", symbol: "" });
  });

  it("keys locals below their invocable with name and position, and lists them on it", () => {
    const max = entity(`${DECORATORS}/Report.max`);
    expect(max.localVariables?.map(renderKey)).toEqual([
      `${DECORATORS}/Report.max#local:best:13:9`,
      `${DECORATORS}/Report.max#local:value:14:16`,
    ]);
    expect(entity(`${DECORATORS}/Report.max#local:best:13:9`).kind).toBe("variable");
  });

  it("makes overloads one entity anchored at the implementation, and a nameless default export `default`", () => {
    const describeFn = model.entities.filter((e) => renderKey(e.key) === `${REPORTING}/describe`);
    expect(describeFn).toHaveLength(1);
    expect(describeFn[0]?.anchor?.span[0]).toBe(28);
    expect(describeFn[0]?.signature).toBe("(input: Order | Order[]): string | string[]");
    expect(entity("ts:packages%2Forder%2Fsrc%2Fhandler.ts/default").kind).toBe("function");
  });

  it("parents an augmentation's members by the augmented type and a global declaration by its file", () => {
    expect(renderKey(entity("ts:legacy-lib/Thing.extra").parent as never)).toBe("ts:legacy-lib/Thing");
    expect(entity("ts:legacy-lib/load").kind).toBe("function");
    expect(renderKey(entity("ts:packages%2Forder%2Fsrc%2Faugment.ts/AcmeWindow.acme").parent as never)).toBe("ts:packages%2Forder%2Fsrc%2Faugment.ts/AcmeWindow");
  });

  it("makes a bound object literal's members children of the variable", () => {
    expect(renderKey(entity(`${BASKET}/Ops.create`).parent as never)).toBe(`${BASKET}/Ops`);
    expect(entity(`${BASKET}/Ops`).traits).toContain("TWithChildren");
    expect(entity(`${BASKET}/Ops.[Symbol%2Eiterator]#26:22`).kind).toBe("function");
  });

  it("resolves declared types to one named entity, arrays to their element, and leaves unions absent", () => {
    expect(renderKey(entity(`${ORDER}/Order.channel`).declaredType as never)).toBe(`${CHANNEL}/Channel`);
    expect(renderKey(entity(`${REPORTING}/ensure#param:orders`).declaredType as never)).toBe(`${ORDER}/Order`);
    expect(renderKey(entity(`${MONEY}/Money.zero`).declaredType as never)).toBe(`${MONEY}/Money`);
    expect(renderKey(entity("ts:packages%2Forder%2Fsrc%2Flazy.ts/load").declaredType as never)).toBe("ts:<lib>/Promise");
    expect(entity(`${REPORTING}/describe#param:input`).declaredType).toBeUndefined();
  });
});

describe("edges (PLAN §14.2)", () => {
  it("resolves a call through a variable to its arrow, and a top-level IIFE from the module", () => {
    expect(edgesFrom(`${NOTIFICATIONS}/both`, "invocation").map((e) => e.toId)).toEqual([`${NOTIFICATIONS}/chain`]);
    expect(edgesFrom(`${NOTIFICATIONS}/both#8:16`, "invocation").map((e) => e.toId)).toEqual([`${NOTIFICATIONS}/log`]);
    expect(edgesFrom(NOTIFICATIONS, "invocation").map((e) => e.toId)).toEqual([`${NOTIFICATIONS}#23:2`]);
  });

  it("resolves `new` to the written constructor, or to the class when none is written; `super` to the base constructor", () => {
    expect(edgesFrom(`${MONEY}/Money.zero`, "invocation").map((e) => e.toId)).toEqual([`${MONEY}/Money.constructor`]);
    expect(edgesFrom(`${BASKET}/Ops.create`, "invocation").map((e) => e.toId)).toEqual([`${BASKET}/Basket`]);
    expect(edgesFrom(`${ORDER}/Order.constructor`, "invocation").map((e) => e.toId)).toEqual([`${ABSTRACT}/AbstractOrder.constructor`]);
  });

  it("resolves a workspace package's function by name with nothing installed, and a JSX element to its component", () => {
    expect(edgesFrom(`${ORDER}/Order.bill`, "invocation").map((e) => e.toId)).toEqual(["ts:packages%2Fpricing%2Fsrc%2Findex.ts/applyTax"]);
    const table = "ts:packages%2Forder%2Fsrc%2Fui%2Forder-table.tsx";
    expect(edgesFrom(`${table}/OrderTable#7:17`, "invocation").map((e) => e.toId)).toEqual([`${table}/Row`]);
  });

  it("folds a call on a lib member to the lib type, and drops a call through `any`", () => {
    expect(edgesFrom(`${REPORTING}/ensure`, "invocation").map((e) => e.toId).sort()).toEqual([
      "ts:<lib>/Array", "ts:<lib>/Array", "ts:<lib>/StringConstructor",
      `${REPORTING}/OrderError.constructor`, `${REPORTING}/OrderError.constructor`,
    ]);
    // `this.send(...)` on a base that resolved to nothing: no target, counted.
    const post = "ts:packages%2Forder%2Fsrc%2Fledger-adapter.ts/LedgerAdapter.post";
    expect(edgesFrom(post, "invocation")).toEqual([]);
    expect(stats.anyReceiversDropped).toBe(1);
    // A call through a callback parameter names no declaration: counted, not guessed.
    expect(edgesFrom(`${NOTIFICATIONS}/chain#12:10`, "invocation")).toEqual([]);
    expect(stats.indirectCallsDropped).toBe(2);
  });

  it("says whether an access reads or writes, a compound assignment both; a setter takes the write", () => {
    const discount = edgesFrom(`${ORDER}/Order.discount`, "access");
    expect(discount.map((e) => [e.toId, e.isRead, e.isWrite])).toEqual([
      [`${ABSTRACT}/AbstractOrder.total`, true, true],
      [`${ABSTRACT}/AbstractOrder.total`, true, false],
    ]);
    expect(edgesFrom(`${ORDER}/Order.constructor`, "access").map((e) => [e.toId, e.isWrite])).toEqual([
      [`${CHANNEL}/Channel.Web`, false],
      [`${ORDER}/Order.channel`, true],
    ]);
    expect(edgesFrom(`${MONEY}/Money.amount#set`, "access").map((e) => [e.toId, e.isWrite])).toEqual([[`${MONEY}/Money.%23secret`, true]]);
    expect(edgesFrom(`${MONEY}/Money.as%2Etext`, "access").map((e) => e.toId).sort()).toEqual([`${MONEY}/Money.%23secret`, `${MONEY}/Money.amount#get`]);
  });

  it("lands an access to a parameter property on the field, and a module-level constant on the variable", () => {
    const row = "ts:packages%2Forder%2Fsrc%2Fui%2Forder-table.tsx/Row";
    expect(edgesFrom(row, "access").map((e) => e.toId)).toEqual([`${ABSTRACT}/AbstractOrder.reference`]);
    expect(edgesFrom("ts:packages%2Forder%2Fsrc%2Fhandler.ts/default", "access").map((e) => e.toId).sort()).toEqual([
      `${ABSTRACT}/AbstractOrder.reference`,
      "ts:packages%2Forder%2Fsrc%2Fpromo%232024.ts/PROMO",
    ]);
  });

  it("emits references from the narrowest owner: a parameter's type from the parameter", () => {
    expect(edgesFrom(`${NOTIFICATIONS}/both#param:order`, "reference").map((e) => e.toId)).toEqual([`${ORDER}/Order`]);
    expect(edgesFrom(`${MONEY}/Money.constructor#param:cents`, "reference").map((e) => e.toId)).toEqual([`${MONEY}/Cents`]);
    expect(edgesFrom(`${ORDER}/Order.bill`, "reference").map((e) => e.toId)).toEqual([`${MONEY}/Cents`]);
  });

  it("carries decorators as annotationUse with their written arguments, named after the factory's parameters", () => {
    const uses = edges.filter((e) => e.kind === "annotationUse");
    expect(uses.map((e) => [e.fromId, e.toId, e.arguments])).toEqual([
      [`${DECORATORS}/Report`, `${DECORATORS}/Audited`, [{ name: "tag", value: { k: "string", v: "monthly" } }]],
      [`${DECORATORS}/Report.max`, `${DECORATORS}/Audited`, [
        { name: "tag", value: { k: "string", v: "max" } },
        { name: "verbose", value: { k: "boolean", v: true } },
      ]],
    ]);
    // Nothing inside a decorator is a call of its own.
    expect(edgesFrom(`${DECORATORS}/Report`, "invocation")).toEqual([]);
  });

  it("anchors throw sites, resolves a narrowed rethrow, and drops a thrown string", () => {
    const throws = edgesFrom(`${REPORTING}/ensure`, "throws");
    expect(throws.map((e) => [e.toId, e.anchor.span[0]])).toEqual([
      [`${REPORTING}/OrderError`, 16],
      [`${REPORTING}/OrderError`, 20],
      [`${REPORTING}/OrderError`, 21],
    ]);
    expect(edgesFrom(`${REPORTING}/reject`, "throws")).toEqual([]);
    expect(stats.throwsDropped).toBe(1);
  });

  it("drops a recursive call as a self-edge, at the source", () => {
    const list = "ts:packages%2Forder%2Fsrc%2Flegacy%2Flist.ts/List.length";
    expect(edgesFrom(list, "invocation")).toEqual([]);
    expect(stats.selfEdgesDropped).toBe(1);
  });

  it("marks an owner by what it owns: a module with invocations, an enum member with an access", () => {
    expect(entity(NOTIFICATIONS).traits).toContain("TWithInvocations");
    expect(entity(`${CHANNEL}/Channel.Phone`).traits).toContain("TWithAccesses");
    expect(edgesFrom(`${CHANNEL}/Channel.Phone`, "access").map((e) => e.toId)).toEqual([`${CHANNEL}/Channel.Store`]);
  });
});

/**
 * MEASURES, hand-counted from `fixtures/typescript/src`:
 *
 *   Report.max      for-of + if + `??`                       1 + 1 + 1 + 1 = 4
 *   ensure          guard if + catch + narrowing if          1 + 1 + 1 + 1 = 4
 *   describe        one if                                   1 + 1         = 2
 *   List.length     one ternary                              1 + 1         = 2
 *   Basket.count    straight line (the arrow is its own)     1             = 1
 *   Money           lines 7–32 of money.ts, one comment-only line inside: 19
 */
describe("measures (METAMODEL §3.8)", () => {
  const measure = (id: string, key: string): number | undefined => entity(id).metrics?.[key];

  it("counts cyclomatic complexity as hand-counted, a nested arrow charged to itself", () => {
    expect(measure(`${DECORATORS}/Report.max`, "cyclomatic")).toBe(4);
    expect(measure(`${REPORTING}/ensure`, "cyclomatic")).toBe(4);
    expect(measure(`${REPORTING}/describe`, "cyclomatic")).toBe(2);
    expect(measure("ts:packages%2Forder%2Fsrc%2Flegacy%2Flist.ts/List.length", "cyclomatic")).toBe(2);
    expect(measure(`${BASKET}/Basket.count`, "cyclomatic")).toBe(1);
    expect(measure(`${BASKET}/Basket.count#12:30`, "cyclomatic")).toBe(1);
  });

  it("counts sloc as lines holding a token, comment-only lines excluded", () => {
    expect(measure(`${MONEY}/Money`, "sloc")).toBe(19);
    expect(measure(`${REPORTING}/ensure`, "sloc")).toBe(9);
    expect(measure(MONEY, "sloc")).toBe(21);
  });

  it("keeps every measure finite and sloc within its span", () => {
    for (const e of model.entities) {
      if (e.metrics === undefined) continue;
      for (const value of Object.values(e.metrics)) expect(Number.isFinite(value)).toBe(true);
      const sloc = e.metrics["sloc"];
      if (sloc !== undefined && e.anchor !== undefined) {
        expect(sloc, renderKey(e.key)).toBeLessThanOrEqual(e.anchor.span[1] - e.anchor.span[0] + 1);
      }
    }
  });
});

/**
 * VALUES (METAMODEL §1.6), each readable in the fixture: TypeScript folds
 * nothing at the declaration, so `4 * 25` rides unevaluated where Java folds.
 */
describe("values (the value door)", () => {
  const valueOf = (id: string): unknown => entity(id).value;

  it("carries literals, enum constants the checker computes, and defaults", () => {
    expect(valueOf(`${ORDER}/Order.CURRENCY`)).toEqual({ k: "string", v: "EUR" });
    expect(valueOf(`${ORDER}/Order.MAX_LINES`)).toEqual({ k: "unevaluated", source: "4 * 25" });
    expect(valueOf(`${CHANNEL}/Channel.Store`)).toEqual({ k: "number", v: "10" });
    expect(valueOf(`${CHANNEL}/Channel.Phone`)).toEqual({ k: "number", v: "11" });
    expect(valueOf(`${CHANNEL}/Priority.High`)).toEqual({ k: "number", v: "1" });
    expect(valueOf("ts:packages%2Fpricing%2Fsrc%2Findex.ts/TAX_RATE")).toEqual({ k: "number", v: "0.2" });
    expect(valueOf(`${DECORATORS}/Audited#param:verbose`)).toEqual({ k: "boolean", v: false });
    expect(valueOf(`${ORDER}/Order.constructor#param:channel`)).toEqual({
      k: "enum",
      type: { module: "packages%2Forder%2Fsrc%2Fchannel.ts", symbol: "Channel" },
      name: "Web",
    });
  });

  it("carries no value for an initializer that is code, or a member that is not readonly", () => {
    expect(entity(`${NOTIFICATIONS}/onShipped`).traits).not.toContain("TWithValue");
    expect(entity(`${BASKET}/Ops`).traits).not.toContain("TWithValue");
    expect(entity(`${MONEY}/Money.%23secret`).traits).not.toContain("TWithValue");
    expect(entity("ts:packages%2Forder%2Fsrc%2Faugment.ts/Wrapper.open#local:thing:19:11").traits).not.toContain("TWithValue");
  });
});

describe("spaces per entity (METAMODEL §1.4)", () => {
  it("marks a const enum type-only and a namespace by what its block declares", () => {
    expect(entity(`${CHANNEL}/Priority`).space).toEqual(["type"]);
    expect(entity(`${CHANNEL}/Channel`).space).toEqual(["type", "value"]);
    expect(entity("ts:legacy%2Facme.ts/Acme.Order").space).toEqual(["type", "value"]);
    expect(entity(`${MONEY}/Cents`).space).toEqual(["type"]);
  });
});
