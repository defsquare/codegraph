import { describe, expect, it } from "vitest";
import { buildingBoxes } from "../src/scene/buildings.js";
import { buildingDetails, districtDetails } from "../src/scene/details.js";
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
