import type { BuildingBox } from "./buildings.js";
import { hslToHex } from "./owners.js";

/**
 * The ROLE color mode (M10d): a building painted by the ARCHITECTURAL ROLE a
 * framework profile assigned it — service, repository, controller… (METAMODEL
 * §9.1). The artifact declares both halves: `Building.role` per building and
 * `roles.values` as the legend's domain, so this module invents nothing.
 *
 * SEMANTIC, NOT DECORATIVE (CLAUDE.md). Each role gets a fixed hue chosen so
 * that the layers of an application read at a glance — entry (controller),
 * logic (service), data (repository), wiring (configuration) — rather than a
 * hash of the name, which would recolor the same corpus differently the day a
 * profile adds a row. A role the table below does not name falls back to
 * golden-angle spacing over its RANK in the artifact's sorted domain, which is
 * deterministic for the same reason `ownerColoring` is.
 *
 * A building with NO role carries null: the renderer paints it neutral rather
 * than claiming a role the framework never assigned.
 */
export interface RoleColoring {
  /** Per building, same order as `boxes`: a hex color, or null (no role). */
  readonly colors: readonly (number | null)[];
  /** Distinct roles present, sorted — the legend's order. */
  readonly roles: readonly string[];
  /** The color each role is drawn in, parallel to `roles`. */
  readonly swatches: readonly number[];
}

/** Hue per canonical role: the layers of an application, left to right. */
const ROLE_HUES: Readonly<Record<string, number>> = {
  controller: 205, // entry — cool blue, the outside world arriving
  service: 145, // logic — green, the corpus's own work
  repository: 35, // data — amber, the edge where state lives
  configuration: 280, // wiring — violet, what assembles the rest
  component: 0, // unclassified bean — neutral red-grey
};

const GOLDEN_ANGLE = 137.508;
const SATURATION: Readonly<Record<string, number>> = { component: 0.18 };

export function roleColoring(
  boxes: readonly BuildingBox[],
  domain: readonly string[] = [],
): RoleColoring {
  const present = [...new Set(boxes.flatMap((box) => (box.role === undefined ? [] : [box.role])))];
  // The artifact's declared domain wins when it has one: the legend must list
  // every role the classification produced, not only the ones that survived a
  // view filter.
  const roles = [...new Set([...domain, ...present])].sort();
  const colorOf = new Map<string, number>();
  roles.forEach((role, rank) => {
    const hue = ROLE_HUES[role] ?? (rank * GOLDEN_ANGLE) % 360;
    colorOf.set(role, hslToHex(hue / 360, SATURATION[role] ?? 0.5, 0.5));
  });
  return {
    colors: boxes.map((box) => (box.role === undefined ? null : colorOf.get(box.role) ?? null)),
    roles,
    swatches: roles.map((role) => colorOf.get(role) as number),
  };
}
