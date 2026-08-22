import { describe, expect, it } from "vitest";
import { buildingBoxes, roofOf } from "../src/scene/buildings.js";
import { PLATE_THICKNESS } from "../src/theme.js";
import { makeCity, makeOldCity } from "./fixture.js";

describe("buildingBoxes", () => {
  const boxes = buildingBoxes(makeCity());

  it("keeps artifact order, so instance index maps back to a building", () => {
    expect(boxes.map((box) => box.id)).toEqual([
      "java:com.acme.order.deep/Util",
      "java:com.acme.order/Order",
      "java:com.acme.order/OrderService",
      "java:com.acme.web/OrderController",
    ]);
  });

  it("maps layout (x, y) to world (x, z) and stands the box on its plate", () => {
    const order = boxes[1]!;
    // position (10, 3), footprint 4x4, height 10, root district (level 0).
    expect(order.center).toEqual([12, PLATE_THICKNESS + 5, 5]);
    expect(order.size).toEqual([4, 10, 4]);
  });

  it("stands a building in a NESTED district on the stacked plate", () => {
    const util = boxes[0]!;
    // district level 1 -> plate top at 2 * PLATE_THICKNESS.
    expect(util.center[1]).toBeCloseTo(2 * PLATE_THICKNESS + 5 / 2);
  });

  it("passes stub flag and raw metrics through untouched", () => {
    const controller = boxes[3]!;
    expect(controller.isStub).toBe(true);
    expect(controller.metrics).toEqual({ loc: null, members: 1 });
  });

  it("passes identity, attributes and operations through untouched", () => {
    const service = boxes[2]!;
    expect(service.identity).toEqual({
      lang: "java",
      module: "com.acme.order",
      symbol: "OrderService",
    });
    expect(service.attributes).toEqual([{ name: "orders", type: "OrderRepository" }]);
    expect(service.operations).toEqual([
      { signature: "bill(Order)" },
      { signature: "place(Order)" },
    ]);
  });

  it("defaults the member lists on an artifact from before they existed", () => {
    const old = buildingBoxes(makeOldCity())[2]!;
    expect(old.identity).toBeUndefined();
    expect(old.attributes).toEqual([]);
    expect(old.operations).toEqual([]);
  });

  it("puts the roof at the top face center", () => {
    const service = boxes[2]!;
    expect(roofOf(service)).toEqual([6, PLATE_THICKNESS + 40, 6]);
  });
});
