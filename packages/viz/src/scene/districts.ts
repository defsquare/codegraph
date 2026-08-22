import type { CityLayout, IdentityComponents } from "@codegraph/city";
import { GROUND_MARGIN, GROUND_THICKNESS, PLATE_THICKNESS } from "../theme.js";

/** An axis-aligned slab on the ground: a district plate or the ground itself. */
export interface Plate {
  readonly id: string;
  readonly name: string | undefined;
  readonly isStub: boolean;
  /** Display components from the artifact; absent on pre-identity artifacts. */
  readonly identity: IdentityComponents | undefined;
  /** Nesting depth: 0 for a root district, parent's level + 1 below it. */
  readonly level: number;
  readonly parent: string | undefined;
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

/**
 * Nesting depth per district, from the artifact's `parent` links. A missing or
 * cyclic parent counts as a root — same demotion rule the layout pass applies,
 * so elevation always matches placement.
 */
export function districtLevels(city: CityLayout): ReadonlyMap<string, number> {
  const parentOf = new Map(city.districts.map((d) => [d.id, d.parent] as const));
  const levels = new Map<string, number>();
  const levelOf = (id: string, trail: ReadonlySet<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    const parent = parentOf.get(id);
    const level =
      parent === undefined || !parentOf.has(parent) || trail.has(parent)
        ? 0
        : levelOf(parent, new Set([...trail, id])) + 1;
    levels.set(id, level);
    return level;
  };
  for (const district of city.districts) levelOf(district.id, new Set([district.id]));
  return levels;
}

/**
 * One plate per district, from its layout bounds. A child plate rests ON its
 * parent's plate — one PLATE_THICKNESS per nesting level — so the module tree
 * is legible in elevation as well as in outline.
 */
export function districtPlates(city: CityLayout): readonly Plate[] {
  const levels = districtLevels(city);
  return city.districts.map((district) => {
    const level = levels.get(district.id) ?? 0;
    return {
      id: district.id,
      name: district.name,
      isStub: district.isStub,
      identity: district.identity,
      level,
      parent: district.parent,
      center: [
        district.bounds.x + district.bounds.width / 2,
        level * PLATE_THICKNESS + PLATE_THICKNESS / 2,
        district.bounds.y + district.bounds.depth / 2,
      ],
      size: [district.bounds.width, PLATE_THICKNESS, district.bounds.depth],
    };
  });
}

/** Top face height of a district's plate — where its buildings stand. */
export function plateTop(level: number): number {
  return (level + 1) * PLATE_THICKNESS;
}

/** The ground slab: the layout's whole plane plus a margin, top face at y = 0. */
export function groundPlate(city: CityLayout): Plate {
  const bounds = city.bounds;
  return {
    id: "ground",
    name: undefined,
    isStub: false,
    identity: undefined,
    level: 0,
    parent: undefined,
    center: [
      bounds.x + bounds.width / 2,
      -GROUND_THICKNESS / 2,
      bounds.y + bounds.depth / 2,
    ],
    size: [bounds.width + 2 * GROUND_MARGIN, GROUND_THICKNESS, bounds.depth + 2 * GROUND_MARGIN],
  };
}
