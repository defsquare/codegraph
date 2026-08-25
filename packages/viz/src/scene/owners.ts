import type { BuildingBox } from "./buildings.js";

/**
 * The OWNER color mode (M9c): each distinct owner (the file's dominant
 * author, joined from a mined history by the CLI) gets a deterministic hue —
 * sorted names, golden-angle spacing, so neighbours in the list land far
 * apart on the wheel and two runs of the same artifact color identically.
 * Buildings without an owner carry null: the renderer paints them neutral,
 * never a hue that would claim an author the history does not state.
 */
export interface OwnerColoring {
  /** Per building, same order as `boxes`: a hex color, or null (no owner). */
  readonly colors: readonly (number | null)[];
  /** Distinct owners, sorted — the hue rank order. */
  readonly owners: readonly string[];
}

const GOLDEN_ANGLE = 137.508;

export function ownerColoring(boxes: readonly BuildingBox[]): OwnerColoring {
  const owners = [...new Set(
    boxes.flatMap((box) => (box.owner === undefined ? [] : [box.owner.name])),
  )].sort();
  const hueRank = new Map(owners.map((name, rank) => [name, rank]));
  const colors = boxes.map((box) => {
    const rank = box.owner === undefined ? undefined : hueRank.get(box.owner.name);
    return rank === undefined ? null : hslToHex(((rank * GOLDEN_ANGLE) % 360) / 360, 0.55, 0.5);
  });
  return { colors, owners };
}

/** Plain HSL → 0xRRGGBB, dependency-free (no Three.js under src/scene). */
export function hslToHex(h: number, s: number, l: number): number {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const to255 = (v: number): number => Math.round(v * 255);
  return (to255(channel(h + 1 / 3)) << 16) | (to255(channel(h)) << 8) | to255(channel(h - 1 / 3));
}
