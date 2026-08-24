import { describe, expect, it } from "vitest";
import { buildingBoxes } from "../src/scene/buildings.js";
import {
  buildingDetails,
  districtDetails,
  operationDisplay,
  operationList,
} from "../src/scene/details.js";
import { districtArcs } from "../src/scene/districtArrows.js";
import { districtPlates } from "../src/scene/districts.js";
import { makeCity, makeOldCity } from "./fixture.js";

/**
 * The click panel's data — pure, DOM-free, so the arithmetic the old tooltip
 * inlined (children counts, fan sums) is asserted here once and the DOM layer
 * only prints it.
 */
describe("districtDetails", () => {
  const city = makeCity();
  const plates = districtPlates(city);
  const boxes = buildingBoxes(city);
  const arcs = districtArcs(city, plates, boxes);
  const order = plates.find((plate) => plate.id === "java:com.acme.order");

  it("counts buildings, nested districts and both fan directions", () => {
    expect(order).toBeDefined();
    if (order === undefined) return;
    const details = districtDetails(plates, boxes, arcs, order);
    expect(details.title).toBe("com.acme.order");
    expect(details.meta).toBe("module");
    expect(details.rows).toEqual([
      { label: "buildings", value: "2" },
      { label: "nested districts", value: "1" },
      { label: "fan-in", value: "1 modules / 2 deps" },
      { label: "fan-out", value: "1 modules / 3 deps" },
    ]);
  });

  it("names the parent and the stub state in the meta line", () => {
    const deep = plates.find((plate) => plate.id === "java:com.acme.order.deep");
    expect(deep).toBeDefined();
    if (deep === undefined) return;
    const details = districtDetails(plates, boxes, arcs, { ...deep, isStub: true });
    expect(details.meta).toBe("module (stub) — in java:com.acme.order");
  });
});

describe("operationDisplay", () => {
  it("splits the operation name from its parameter list", () => {
    expect(operationDisplay("bill(Order)")).toEqual({ name: "bill", params: "(Order)" });
    expect(operationDisplay("run()")).toEqual({ name: "run", params: "()" });
  });

  it("shortens java.lang and java.util parameter types to their symbol name", () => {
    expect(operationDisplay("format(java.lang.String, java.util.List)")).toEqual({
      name: "format",
      params: "(String, List)",
    });
  });

  it("shortens their subpackages too, but leaves other packages whole", () => {
    expect(
      operationDisplay("apply(java.util.function.Function, com.acme.order.Order)"),
    ).toEqual({ name: "apply", params: "(Function, com.acme.order.Order)" });
  });

  it("shortens types nested inside generics", () => {
    expect(operationDisplay("index(java.util.Map<java.lang.String, com.acme.Order>)")).toEqual({
      name: "index",
      params: "(Map<String, com.acme.Order>)",
    });
  });

  it("treats a signature without a parameter list as all name", () => {
    expect(operationDisplay("toString")).toEqual({ name: "toString", params: "" });
  });

  it("prints declared parameters as name: Type pairs, over the signature's types", () => {
    expect(
      operationDisplay("bill(com.acme.Order, int)", [
        { name: "order", type: "Order" },
        { name: "count", type: "int" },
      ]),
    ).toEqual({ name: "bill", params: "(order: Order, count: int)" });
  });

  it("prints a bare name for a declared parameter whose type is unresolved", () => {
    expect(operationDisplay("bill(com.acme.Order)", [{ name: "order" }])).toEqual({
      name: "bill",
      params: "(order)",
    });
  });

  it("prints () for an explicitly empty parameter list", () => {
    expect(operationDisplay("run()", [])).toEqual({ name: "run", params: "()" });
  });
});

describe("operationList", () => {
  it("lists named operations and counts nameless ones (lambdas) apart", () => {
    const { items, anonymous } = operationList([
      { signature: "bill(java.lang.String)" },
      { signature: "()" },
      { signature: "(<unknown>)" },
      { signature: "place(Order)" },
    ]);
    expect(items).toEqual([
      { name: "bill", params: "(String)" },
      { name: "place", params: "(Order)" },
    ]);
    expect(anonymous).toBe(2);
  });

  it("uses declared parameters when the artifact carries them", () => {
    const { items } = operationList([
      { signature: "bill(java.lang.String)", parameters: [{ name: "reference", type: "String" }] },
    ]);
    expect(items).toEqual([{ name: "bill", params: "(reference: String)" }]);
  });

  it("keeps constructors — <init> is a name", () => {
    const { items, anonymous } = operationList([{ signature: "<init>(java.util.List)" }]);
    expect(items).toEqual([{ name: "<init>", params: "(List)" }]);
    expect(anonymous).toBe(0);
  });
});

describe("buildingDetails", () => {
  const boxes = buildingBoxes(makeCity());

  it("carries meta, metric rows, attributes and operations", () => {
    const service = boxes.find((box) => box.id === "java:com.acme.order/OrderService");
    expect(service).toBeDefined();
    if (service === undefined) return;
    const details = buildingDetails(service);
    expect(details.title).toBe("OrderService");
    expect(details.meta).toBe("class — com.acme.order");
    expect(details.rows).toEqual([
      { label: "loc", value: "120" },
      { label: "members", value: "9" },
    ]);
    expect(details.attributes).toEqual([{ name: "orders", type: "OrderRepository" }]);
    expect(details.operations).toEqual([{ signature: "bill(Order)" }, { signature: "place(Order)" }]);
  });

  it("keeps 'unmeasured' distinguishable from a value, and flags stubs", () => {
    const stub = boxes.find((box) => box.id === "java:com.acme.web/OrderController");
    expect(stub).toBeDefined();
    if (stub === undefined) return;
    const details = buildingDetails(stub);
    expect(details.meta).toBe("class (stub) — com.acme.web");
    expect(details.rows).toContainEqual({ label: "loc", value: "unmeasured", className: "unmeasured" });
  });

  it("shows empty member lists for an old artifact rather than failing", () => {
    const old = buildingBoxes(makeOldCity());
    const box = old.find((candidate) => candidate.id === "java:com.acme.order/Order");
    expect(box).toBeDefined();
    if (box === undefined) return;
    const details = buildingDetails(box);
    expect(details.attributes).toEqual([]);
    expect(details.operations).toEqual([]);
    // With no identity, the meta line falls back to the district id.
    expect(details.meta).toBe("class — java:com.acme.order");
  });
});
