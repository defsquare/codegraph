import type { CityReplay } from "@codegraph/city";

/**
 * The replay timeline as a pure model — what the scrubber shows and what each
 * building's height IS at a tick. No DOM, no Three.js: the shell binds an
 * <input type=range> to `label` and feeds `heightsAt` to the scene.
 *
 * Heights come from the artifact's keyframe series VERBATIM (city units,
 * scaled by the builder): a keyframe holds until the next one, a building is
 * height 0 before its first keyframe (unborn) and after a 0 keyframe (dead).
 * `heightsAt` writes into a caller-owned buffer — scrubbing allocates nothing.
 */
export interface TimelineModel {
  /** Number of ticks (commits). 0 = nothing to scrub. */
  readonly count: number;
  readonly label: (tick: number) => string;
  readonly heightsAt: (tick: number, out: Float32Array) => Float32Array;
}

export function timelineModel(replay: CityReplay, buildingIds: readonly string[]): TimelineModel {
  // Per building, the keyframes split into parallel arrays for a search with
  // no per-call allocation.
  const keyTicks: Int32Array[] = [];
  const keyHeights: Float64Array[] = [];
  for (const id of buildingIds) {
    const series = replay.series[id] ?? [];
    const ticks = new Int32Array(series.length);
    const heights = new Float64Array(series.length);
    series.forEach(([tick, height], at) => {
      ticks[at] = tick;
      heights[at] = height;
    });
    keyTicks.push(ticks);
    keyHeights.push(heights);
  }

  /** Height of building `at` on tick `t`: the last keyframe at or before t. */
  const heightOf = (at: number, t: number): number => {
    const ticks = keyTicks[at] as Int32Array;
    const heights = keyHeights[at] as Float64Array;
    let low = 0;
    let high = ticks.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((ticks[middle] as number) <= t) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found === -1 ? 0 : (heights[found] as number);
  };

  return {
    count: replay.ticks.length,
    label(tick: number): string {
      const at = replay.ticks[tick];
      if (at === undefined) return "no commits";
      const date = new Date(at.time * 1000).toISOString().slice(0, 10);
      const author = at.author.split(" <")[0] ?? at.author;
      const fix = at.fix === true ? " · fix" : "";
      return `commit ${tick + 1}/${replay.ticks.length} · ${date} · ${at.hash.slice(0, 7)} · ${author}${fix}`;
    },
    heightsAt(tick: number, out: Float32Array): Float32Array {
      for (let at = 0; at < buildingIds.length; at += 1) out[at] = heightOf(at, tick);
      return out;
    },
  };
}
