import { describe, expect, it } from "vitest";
import type { CityReplay } from "@codegraph/city";
import { timelineModel } from "../src/scene/timeline.js";

const REPLAY: CityReplay = {
  clock: "commits",
  ticks: [
    { hash: "a".repeat(40), time: 1704103200, author: "Alice <alice@example.com>" },
    { hash: "b".repeat(40), time: 1704189600, author: "Bob <bob@example.com>", fix: true },
    { hash: "c".repeat(40), time: 1704276000, author: "Alice <alice@example.com>" },
  ],
  series: {
    "file:a.txt": [
      [0, 10],
      [2, 40],
    ],
    "file:b.txt": [
      [0, 20],
      [1, 0],
    ],
    "file:late.txt": [[2, 5]],
  },
};

const IDS = ["file:a.txt", "file:b.txt", "file:late.txt"] as const;

function heights(tick: number): number[] {
  const model = timelineModel(REPLAY, [...IDS]);
  return [...model.heightsAt(tick, new Float32Array(IDS.length))];
}

describe("heightsAt", () => {
  it("holds a keyframe until the next one", () => {
    expect(heights(0)).toEqual([10, 20, 0]);
    expect(heights(1)).toEqual([10, 0, 0]);
    expect(heights(2)).toEqual([40, 0, 5]);
  });

  it("keeps a building at 0 before its birth and after its death", () => {
    expect(heights(0)[2]).toBe(0); // unborn
    expect(heights(2)[1]).toBe(0); // deleted at tick 1, stays gone
  });

  it("writes into the caller's buffer — scrubbing allocates nothing", () => {
    const model = timelineModel(REPLAY, [...IDS]);
    const buffer = new Float32Array(IDS.length);
    expect(model.heightsAt(1, buffer)).toBe(buffer);
  });

  it("gives 0 to a building the series does not know", () => {
    const model = timelineModel(REPLAY, ["file:unknown.txt"]);
    expect([...model.heightsAt(2, new Float32Array(1))]).toEqual([0]);
  });
});

describe("label", () => {
  const model = timelineModel(REPLAY, [...IDS]);

  it("shows position, date, short hash and author name", () => {
    expect(model.label(0)).toBe("commit 1/3 · 2024-01-01 · aaaaaaa · Alice");
  });

  it("flags fix commits", () => {
    expect(model.label(1)).toContain("· fix");
    expect(model.label(0)).not.toContain("fix");
  });

  it("says so when there is nothing to scrub", () => {
    expect(model.label(99)).toBe("no commits");
    expect(timelineModel({ clock: "commits", ticks: [], series: {} }, []).count).toBe(0);
  });
});
