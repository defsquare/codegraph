import { describe, expect, it } from "vitest";
import { renderId } from "@codegraph/core";
import { buildEntityCity, layoutReplayCity, type EntityHistory } from "../src/replay.js";

/**
 * The entity-level replay city (PLAN §11.3, M9c). Hand-counted story over
 * three sampled revisions of a temporal store:
 *
 *   rev 0 (t=1000)  Gson 20   Helper 10   Legacy 10
 *   rev 1 (t=2000)  Gson 40   Streams 5       — Helper and Legacy absent —
 *   rev 2 (t=3000)  Gson 30   Streams 8   Helper 4 (REBORN)
 *
 * Heights are FROZEN over the union domain [0, 40] linear into [1, 40]:
 * 20 → 20.5 · 40 → 40 · 30 → 30.25 · 10 → 10.75 · 5 → 5.875 · 8 → 8.8 · 4 → 4.9.
 * Presence gaps must become explicit 0 keyframes — a keyframe holds until the
 * next, so an absence the series does not state would be a lie on screen.
 */

const sha = (n: number): string => String(n).repeat(40);

const entity = (
  module: string,
  symbol: string,
  kind: string,
  series: (readonly [number, number | null])[],
  disambiguator = "",
): EntityHistory["entities"][number] => ({ module, symbol, disambiguator, kind, series });

const HISTORY: EntityHistory = {
  lang: "java",
  revisions: [
    { sha: sha(0), time: 1000 },
    { sha: sha(1), time: 2000 },
    { sha: sha(2), time: 3000 },
  ],
  entities: [
    entity("app", "", "package", [[0, null], [1, null], [2, null]]),
    entity("app", "Gson", "class", [[0, 20], [1, 40], [2, 30]]),
    entity("app.internal", "Helper", "class", [[0, 10], [2, 4]]),
    entity("app", "Legacy", "class", [[0, 10]]),
    entity("app", "Streams", "interface", [[1, 5], [2, 8]]),
    // Present at every revision but never edited: heat must pre-decay.
    entity("app", "Stable", "class", [[0, 8], [1, 8], [2, 8]]),
    // Not buildings: a member, and an anonymous type whose key shifts (PLAN §11 pr. 3).
    entity("app", "Gson.fromJson", "method", [[0, 3], [1, 3], [2, 3]]),
    entity("app", "Gson.1", "class", [[1, 6]], "L10C5"),
  ],
};

const id = (module: string, symbol: string): string => renderId({ lang: "java", module, symbol });

describe("buildEntityCity", () => {
  const city = buildEntityCity(HISTORY, { name: "demo" });

  it("is a city artifact: types are buildings, modules are flat districts", () => {
    expect(city.kind).toBe("codegraph.city/1");
    expect(city.buildings.map((building) => building.id).sort()).toEqual(
      [
        id("app", "Gson"), id("app", "Legacy"), id("app", "Stable"),
        id("app", "Streams"), id("app.internal", "Helper"),
      ].sort(),
    );
    expect(city.districts.map((district) => district.id).sort()).toEqual(
      [id("app", ""), id("app.internal", "")].sort(),
    );
    expect(city.districts.every((district) => district.parent === undefined)).toBe(true);
    expect(city.arrows).toEqual([]);
  });

  it("excludes members and anonymous types from the skyline", () => {
    const ids = new Set(city.buildings.map((building) => building.id));
    expect([...ids].some((one) => one.includes("fromJson"))).toBe(false);
    expect([...ids].some((one) => one.includes("#"))).toBe(false);
  });

  it("scales heights against the frozen union domain, gaps as explicit zeros", () => {
    const series = city.replay.series;
    expect(series[id("app", "Gson")]).toEqual([[0, 20.5, 1], [1, 40, 1], [2, 30.25, 1]]);
    // Helper: present, ABSENT (explicit 0), REBORN — the rebirth is a change.
    expect(series[id("app.internal", "Helper")]).toEqual([[0, 10.75, 1], [1, 0, 0], [2, 4.9, 1]]);
    // Legacy dies after rev 0 and never returns.
    expect(series[id("app", "Legacy")]).toEqual([[0, 10.75, 1], [1, 0, 0]]);
    expect(series[id("app", "Streams")]).toEqual([[1, 5.875, 1], [2, 8.8, 1]]);
  });

  it("heat pre-decays on presence WITHOUT change — sampled revisions are not commits", () => {
    // Stable exists at every revision but its LOC never moves: heat cools
    // 1 -> 0.6 -> 0.36 (REPLAY_HEAT_DECAY per revision since the birth change).
    expect(city.replay.series[id("app", "Stable")]).toEqual([
      [0, 8.8, 1],
      [1, 8.8, 0.6],
      [2, 8.8, 0.36],
    ]);
  });

  it("a dead entity's static height is 0 — vacant land at the latest revision", () => {
    const legacy = city.buildings.find((building) => building.id === id("app", "Legacy"));
    expect(legacy?.height).toBe(0);
    const gson = city.buildings.find((building) => building.id === id("app", "Gson"));
    expect(gson?.height).toBe(30.25);
  });

  it("freezes the plot at the entity's PEAK and carries the lifecycle metrics", () => {
    const gson = city.buildings.find((building) => building.id === id("app", "Gson"));
    expect(gson?.footprint.width).toBe(20); // peak 40 = domain max -> range max
    expect(gson?.metrics).toMatchObject({ loc: 30, "peak-loc": 40, revisions: 3, born: 0 });
    const helper = city.buildings.find((building) => building.id === id("app.internal", "Helper"));
    expect(helper?.metrics).toMatchObject({ loc: 4, "peak-loc": 10, revisions: 2, born: 0 });
    const streams = city.buildings.find((building) => building.id === id("app", "Streams"));
    expect(streams?.metrics).toMatchObject({ born: 1 });
  });

  it("ticks are the revisions, chronological, clock says so", () => {
    expect(city.replay.clock).toBe("revisions");
    expect(city.replay.ticks).toHaveLength(3);
    expect(city.replay.ticks[1]).toEqual({ hash: sha(1), time: 2000, author: "" });
  });

  it("documents both channels with the frozen domains", () => {
    const height = city.bindings.find((binding) => binding.channel === "height");
    expect(height).toMatchObject({ metric: "loc", scale: "linear", domain: { min: 0, max: 40 } });
    const footprint = city.bindings.find((binding) => binding.channel === "footprint");
    expect(footprint).toMatchObject({ metric: "peak-loc", scale: "sqrt", domain: { min: 8, max: 40 } });
  });

  it("survives the layout pass with a frozen plot for every type that EVER lived", () => {
    const laidOut = layoutReplayCity(city);
    expect(laidOut.replay).toBe(city.replay);
    expect(laidOut.buildings.every((building) => typeof building.position?.x === "number")).toBe(true);
    expect(laidOut.buildings.find((building) => building.id === id("app", "Legacy"))?.position).toBeDefined();
  });

  it("falls back to the common type kinds when the language has no profile", () => {
    const exotic = buildEntityCity(
      {
        lang: "zig",
        revisions: [{ sha: sha(0), time: 1000 }],
        entities: [entity("m", "T", "struct", [[0, 5]])],
      },
      { name: "x" },
    );
    expect(exotic.buildings).toHaveLength(1);
  });

  it("is deterministic and survives an empty store", () => {
    expect(JSON.stringify(buildEntityCity(HISTORY, { name: "demo" }))).toBe(
      JSON.stringify(buildEntityCity(HISTORY, { name: "demo" })),
    );
    const empty = buildEntityCity({ lang: "java", revisions: [], entities: [] }, { name: "none" });
    expect(empty.buildings).toEqual([]);
    expect(empty.replay.ticks).toEqual([]);
  });
});
