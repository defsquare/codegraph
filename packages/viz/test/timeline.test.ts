import { describe, expect, it } from "vitest";
import { REPLAY_HEAT_DECAY as CITY_HEAT_DECAY, type CityReplay } from "@codegraph/city";
import { timelineModel } from "../src/scene/timeline.js";
import { REPLAY_HEAT_DECAY } from "../src/theme.js";

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

describe("shadeAt — the time colors", () => {
  function shade(tick: number, replay: CityReplay = REPLAY, ids: readonly string[] = IDS) {
    const model = timelineModel(replay, [...ids]);
    const heats = new Float32Array(ids.length);
    const ages = new Float32Array(ids.length);
    model.shadeAt(tick, heats, ages);
    return { heats: [...heats], ages: [...ages] };
  }

  it("keyframes without a heat element count as changes (file-replay semantics)", () => {
    const { heats, ages } = shade(0);
    expect(heats[0]).toBeCloseTo(1); // a.txt changed at tick 0
    expect(ages[0]).toBeCloseTo(0); // just born
    expect(heats[2]).toBe(0); // late.txt unborn: nothing to heat
    expect(ages[2]).toBe(0);
  });

  it("heat cools by the decay per tick after the last change", () => {
    const { heats } = shade(1);
    expect(heats[0]).toBeCloseTo(REPLAY_HEAT_DECAY); // a.txt changed at 0, one tick ago
  });

  it("a dead building has neither heat nor age", () => {
    const { heats, ages } = shade(2);
    expect(heats[1]).toBe(0); // b.txt deleted at tick 1
    expect(ages[1]).toBe(0);
    expect(ages[0]).toBeCloseTo(1); // a.txt has lived the whole timeline
    expect(heats[2]).toBeCloseTo(1); // late.txt born right here
  });

  it("a carried heat value keeps decaying from what the artifact states", () => {
    const replay: CityReplay = {
      clock: "revisions",
      ticks: REPLAY.ticks,
      series: { "java:app/Stable": [[0, 8, 1], [1, 8, 0.6]] },
    };
    const { heats } = shade(2, replay, ["java:app/Stable"]);
    expect(heats[0]).toBeCloseTo(0.6 * REPLAY_HEAT_DECAY); // 0.6 at tick 1, one more tick
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

  it("restates the city package's heat decay exactly (bundle stays Node-free)", () => {
    expect(REPLAY_HEAT_DECAY).toBe(CITY_HEAT_DECAY);
  });

  it("calls a tick by its clock: revisions, with no author segment", () => {
    const revisions = timelineModel(
      {
        clock: "revisions",
        ticks: [{ hash: "d".repeat(40), time: 1704103200, author: "" }],
        series: {},
      },
      [],
    );
    expect(revisions.label(0)).toBe("revision 1/1 · 2024-01-01 · ddddddd");
    expect(revisions.label(9)).toBe("no revisions");
  });
});
