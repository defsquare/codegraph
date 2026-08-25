import { describe, expect, it } from "vitest";
import { buildingBoxes } from "../src/scene/buildings.js";
import { coChangeArcModels } from "../src/scene/coChange.js";
import { makeCity } from "./fixture.js";

/**
 * Co-change arcs (M9c): mined pairs from the replay artifact become dashed
 * roof-to-roof arcs, and nothing more — an id the city never laid out raises
 * no arc (the arrows rule: skipping beats drawing from nowhere).
 */
describe("coChangeArcModels", () => {
  const withPairs = makeCity({
    replay: {
      clock: "revisions",
      ticks: [],
      series: {},
      coChange: [
        {
          a: "java:com.acme.order/Order",
          b: "java:com.acme.order/OrderService",
          support: 7,
          confidence: 0.8,
        },
        { a: "java:com.acme.order/Order", b: "java:ghost/Nowhere", support: 4, confidence: 0.6 },
      ],
    },
  } as never);

  it("arcs every pair whose two ends are buildings, roof to roof", () => {
    const boxes = buildingBoxes(withPairs);
    const arcs = coChangeArcModels(withPairs, boxes);
    expect(arcs).toHaveLength(1);
    const arc = arcs[0];
    expect(arc?.a).toBe("java:com.acme.order/Order");
    expect(arc?.b).toBe("java:com.acme.order/OrderService");
    expect(arc?.support).toBe(7);
    const order = boxes.find((box) => box.id === arc?.a);
    const first = arc?.points[0];
    // Starts at Order's roof center.
    expect(first?.[0]).toBeCloseTo(order?.center[0] ?? NaN);
    expect(first?.[1]).toBeCloseTo((order?.center[1] ?? NaN) + (order?.size[1] ?? 0) / 2);
  });

  it("is empty for a static city and for a replay without co-change", () => {
    expect(coChangeArcModels(makeCity(), buildingBoxes(makeCity()))).toEqual([]);
    const bare = makeCity({ replay: { clock: "commits", ticks: [], series: {} } } as never);
    expect(coChangeArcModels(bare, buildingBoxes(bare))).toEqual([]);
  });
});
