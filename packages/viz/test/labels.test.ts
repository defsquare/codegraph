import { describe, expect, it } from "vitest";
import { buildingBoxes } from "../src/scene/buildings.js";
import { districtPlates } from "../src/scene/districts.js";
import { buildingLabel, districtLabel } from "../src/scene/labels.js";
import { makeCity, makeOldCity } from "./fixture.js";

/**
 * The hover tooltip's one line. Labels are CONCATENATION of artifact-provided
 * identity components — the renderer never parses an id (CLAUDE.md invariant
 * 7); when the artifact carries no components it falls back to the name, and
 * as a last resort shows the id opaquely.
 */
describe("buildingLabel", () => {
  const boxes = buildingBoxes(makeCity());

  it("composes module/symbol from the artifact's identity components", () => {
    const service = boxes.find((box) => box.id === "java:com.acme.order/OrderService");
    expect(service && buildingLabel(service)).toBe("com.acme.order/OrderService");
  });

  it("appends the disambiguator when the identity has one", () => {
    const box = boxes[0];
    expect(box).toBeDefined();
    if (box === undefined) return;
    const anonymous = {
      ...box,
      identity: { lang: "java", module: "com.acme", symbol: "Order$1", disambiguator: "A.java:12" },
    };
    expect(buildingLabel(anonymous)).toBe("com.acme/Order$1#A.java:12");
  });

  it("falls back to the name, then the id, when identity is absent", () => {
    const old = buildingBoxes(makeOldCity());
    const named = old.find((box) => box.id === "java:com.acme.order/Order");
    expect(named && buildingLabel(named)).toBe("Order");
    const nameless = named === undefined ? undefined : { ...named, name: undefined };
    expect(nameless && buildingLabel(nameless)).toBe("java:com.acme.order/Order");
  });
});

describe("districtLabel", () => {
  it("shows the module component when the artifact gives one", () => {
    const plates = districtPlates(makeCity());
    const order = plates.find((plate) => plate.id === "java:com.acme.order");
    expect(order && districtLabel(order)).toBe("com.acme.order");
  });

  it("falls back to the name, then the id", () => {
    const plates = districtPlates(makeOldCity());
    const order = plates.find((plate) => plate.id === "java:com.acme.order");
    expect(order && districtLabel(order)).toBe("com.acme.order");
    const nameless = order === undefined ? undefined : { ...order, name: undefined };
    expect(nameless && districtLabel(nameless)).toBe("java:com.acme.order");
  });
});
