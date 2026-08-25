import { describe, expect, it } from "vitest";
import { buildFileCity, layoutFileCity, type FileHistory } from "../src/replay.js";

/**
 * The file-level replay city (PLAN §11.1). Hand-counted from this history:
 *
 *   tick 0  a.txt +10        src/b.txt +20
 *   tick 1  src/b.txt -20 (deleted)   src/deep/c.txt +5
 *   tick 2  a.txt +30 (now 40)
 *
 * Lineage LOC: a: 10→40 (peak 40) · b: 20→0 (peak 20) · c: 5 (peak 5).
 * Height domain is FROZEN over all time: [0, 40] linear into [1, 40].
 */

const hash = (n: number): string => String(n).repeat(40);

const HISTORY: FileHistory = {
  repo: "demo",
  authors: ["alice <a@x>", "bob <b@x>"],
  paths: ["a.txt", "src/b.txt", "src/deep/c.txt"],
  commits: [
    { hash: hash(0), author: 0, time: 1000, isFix: false, isRevert: false },
    { hash: hash(1), author: 1, time: 2000, isFix: true, isRevert: false },
    { hash: hash(2), author: 0, time: 3000, isFix: false, isRevert: false },
  ],
  changes: [
    { commit: 0, path: 0, added: 10, deleted: 0 },
    { commit: 0, path: 1, added: 20, deleted: 0 },
    { commit: 1, path: 1, added: 0, deleted: 20 },
    { commit: 1, path: 2, added: 5, deleted: 0 },
    { commit: 2, path: 0, added: 30, deleted: 0 },
  ],
};

describe("buildFileCity", () => {
  const city = buildFileCity(HISTORY);

  it("is a city artifact: files are buildings, directories are districts", () => {
    expect(city.kind).toBe("codegraph.city/1");
    expect(city.buildings.map((b) => b.id)).toEqual([
      "file:a.txt",
      "file:src/b.txt",
      "file:src/deep/c.txt",
    ]);
    expect(city.districts.map((d) => d.id)).toEqual(["dir:.", "dir:src", "dir:src/deep"]);
    expect(city.arrows).toEqual([]);
    expect(city.districtArrows).toEqual([]);
  });

  it("nests directories by nearest ancestor district", () => {
    const byId = new Map(city.districts.map((d) => [d.id, d]));
    expect(byId.get("dir:.")?.parent).toBeUndefined();
    expect(byId.get("dir:src")?.parent).toBe("dir:.");
    expect(byId.get("dir:src/deep")?.parent).toBe("dir:src");
  });

  it("scales heights against the FROZEN union domain [0, 40]", () => {
    const series = city.replay.series;
    expect(series["file:a.txt"]).toEqual([
      [0, 10.75],
      [2, 40],
    ]);
    expect(series["file:src/b.txt"]).toEqual([
      [0, 20.5],
      [1, 0],
    ]);
    expect(series["file:src/deep/c.txt"]).toEqual([[1, 5.875]]);
  });

  it("zero is absence, never the channel floor: a deleted file sinks to 0", () => {
    const b = city.buildings.find((building) => building.id === "file:src/b.txt");
    expect(b?.height).toBe(0);
    expect(b?.metrics["loc"]).toBe(0);
    expect(b?.metrics["peak-loc"]).toBe(20);
  });

  it("freezes the plot at the lineage's PEAK, not its final size", () => {
    const sides = new Map(city.buildings.map((b) => [b.id, b.footprint.width]));
    expect(sides.get("file:a.txt")).toBe(20); // domain max -> range max
    expect(sides.get("file:src/deep/c.txt")).toBe(2); // domain min -> range min
    const b = sides.get("file:src/b.txt") ?? 0;
    expect(b).toBeGreaterThan(2);
    expect(b).toBeLessThan(20);
  });

  it("carries one tick per commit, chronological, fixes flagged", () => {
    expect(city.replay.clock).toBe("commits");
    expect(city.replay.ticks).toHaveLength(3);
    expect(city.replay.ticks[1]).toEqual({
      hash: hash(1),
      time: 2000,
      author: "bob <b@x>",
      fix: true,
    });
    expect(city.replay.ticks[0]?.fix).toBeUndefined();
  });

  it("documents both channels as bindings with the frozen domains", () => {
    const height = city.bindings.find((b) => b.channel === "height");
    expect(height).toMatchObject({ metric: "loc", scale: "linear", domain: { min: 0, max: 40 } });
    const footprint = city.bindings.find((b) => b.channel === "footprint");
    expect(footprint).toMatchObject({ metric: "peak-loc", scale: "sqrt", domain: { min: 5, max: 40 } });
  });

  it("survives the layout pass with plots for every lineage that EVER existed", () => {
    const laidOut = layoutFileCity(city);
    expect(laidOut.replay).toBe(city.replay);
    expect(laidOut.buildings.every((b) => typeof b.position?.x === "number")).toBe(true);
    // The deleted file keeps its plot: land is vacant after its time.
    expect(laidOut.buildings.find((b) => b.id === "file:src/b.txt")?.position).toBeDefined();
  });

  it("skips directories that hold no files when nesting", () => {
    const sparse = buildFileCity({
      ...HISTORY,
      paths: ["x/y/z.txt", "top.txt"],
      changes: [
        { commit: 0, path: 0, added: 1, deleted: 0 },
        { commit: 0, path: 1, added: 1, deleted: 0 },
      ],
    });
    const byId = new Map(sparse.districts.map((d) => [d.id, d]));
    expect([...byId.keys()].sort()).toEqual(["dir:.", "dir:x/y"]);
    expect(byId.get("dir:x/y")?.parent).toBe("dir:.");
  });

  it("is deterministic: two builds serialize identically", () => {
    expect(JSON.stringify(buildFileCity(HISTORY))).toBe(JSON.stringify(buildFileCity(HISTORY)));
  });

  it("handles an empty history", () => {
    const empty = buildFileCity({ ...HISTORY, paths: [], commits: [], changes: [] });
    expect(empty.buildings).toEqual([]);
    expect(empty.districts).toEqual([]);
    expect(empty.replay.ticks).toEqual([]);
  });
});
