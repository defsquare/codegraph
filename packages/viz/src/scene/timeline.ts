import type { CityReplay } from "@codegraph/city";
import { REPLAY_HEAT_DECAY } from "../theme.js";

/**
 * The replay timeline as a pure model — what the scrubber shows and what each
 * building's height IS at a tick. No DOM, no Three.js: the shell binds an
 * <input type=range> to `label` and feeds `heightsAt` / `shadeAt` to the scene.
 *
 * Heights come from the artifact's keyframe series VERBATIM (city units,
 * scaled by the builder): a keyframe holds until the next one, a building is
 * height 0 before its first keyframe (unborn) and after a 0 keyframe (dead).
 *
 * Heat and age are the TIME COLORS (M9c): a keyframe's heat (1 = changed at
 * that tick, already decayed by the builder when presence ≠ change) keeps
 * cooling by REPLAY_HEAT_DECAY per tick until the next keyframe; age is the
 * fraction of the timeline lived since birth. A dead building has neither.
 * Keyframes without a heat element (older artifacts) count every visible
 * keyframe as a change — exactly true of the file-level replay.
 *
 * `heightsAt` and `shadeAt` write into caller-owned buffers — scrubbing
 * allocates nothing.
 */
export interface TimelineModel {
  /** Number of ticks (commits or revisions). 0 = nothing to scrub. */
  readonly count: number;
  readonly label: (tick: number) => string;
  readonly heightsAt: (tick: number, out: Float32Array) => Float32Array;
  /** Heat ∈ [0,1] and age ∈ [0,1] per building at `tick`, into the buffers. */
  readonly shadeAt: (tick: number, heats: Float32Array, ages: Float32Array) => void;
}

export function timelineModel(replay: CityReplay, buildingIds: readonly string[]): TimelineModel {
  // Per building, the keyframes split into parallel arrays for a search with
  // no per-call allocation.
  const keyTicks: Int32Array[] = [];
  const keyHeights: Float64Array[] = [];
  const keyHeats: Float64Array[] = [];
  for (const id of buildingIds) {
    const series = replay.series[id] ?? [];
    const ticks = new Int32Array(series.length);
    const heights = new Float64Array(series.length);
    const heats = new Float64Array(series.length);
    series.forEach(([tick, height, heat], at) => {
      ticks[at] = tick;
      heights[at] = height;
      heats[at] = heat ?? (height > 0 ? 1 : 0);
    });
    keyTicks.push(ticks);
    keyHeights.push(heights);
    keyHeats.push(heats);
  }

  /** Index of building `at`'s last keyframe at or before tick `t`; -1 = unborn. */
  const frameOf = (at: number, t: number): number => {
    const ticks = keyTicks[at] as Int32Array;
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
    return found;
  };

  const heightOf = (at: number, t: number): number => {
    const found = frameOf(at, t);
    return found === -1 ? 0 : ((keyHeights[at] as Float64Array)[found] as number);
  };

  // The clock names what a tick IS — commits (file replay) or sampled
  // revisions (entity replay); the label must not claim one for the other.
  const noun = replay.clock === "revisions" ? "revision" : "commit";
  const span = Math.max(1, replay.ticks.length - 1);

  return {
    count: replay.ticks.length,
    label(tick: number): string {
      const at = replay.ticks[tick];
      if (at === undefined) return `no ${noun}s`;
      const date = new Date(at.time * 1000).toISOString().slice(0, 10);
      const author = at.author.split(" <")[0] ?? at.author;
      const fix = at.fix === true ? " · fix" : "";
      const who = author === "" ? "" : ` · ${author}`;
      return `${noun} ${tick + 1}/${replay.ticks.length} · ${date} · ${at.hash.slice(0, 7)}${who}${fix}`;
    },
    heightsAt(tick: number, out: Float32Array): Float32Array {
      for (let at = 0; at < buildingIds.length; at += 1) out[at] = heightOf(at, tick);
      return out;
    },
    shadeAt(tick: number, heats: Float32Array, ages: Float32Array): void {
      for (let at = 0; at < buildingIds.length; at += 1) {
        const found = frameOf(at, tick);
        const height = found === -1 ? 0 : ((keyHeights[at] as Float64Array)[found] as number);
        if (found === -1 || height <= 0) {
          // Unborn or dead: no building, so nothing to heat or to age.
          heats[at] = 0;
          ages[at] = 0;
          continue;
        }
        const frameTick = (keyTicks[at] as Int32Array)[found] as number;
        const frameHeat = (keyHeats[at] as Float64Array)[found] as number;
        heats[at] = frameHeat * REPLAY_HEAT_DECAY ** (tick - frameTick);
        const born = (keyTicks[at] as Int32Array)[0] as number;
        ages[at] = (tick - born) / span;
      }
    },
  };
}
