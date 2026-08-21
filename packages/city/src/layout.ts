import type { EntityId } from "@codegraph/core";
import type { Building, CityModel, District } from "./city.js";
import { round } from "./scale.js";

/**
 * THE LAYOUT PASS: the placement `buildCity` deliberately does not do.
 *
 * It consumes a `CityModel` — building footprints and the district grouping —
 * and adds the coordinates a renderer needs: `position` on every building,
 * `bounds` on every district and on the city. Nothing else changes; a laid-out
 * city is the same artefact with placement, and stripping the added keys gives
 * back the input byte for byte.
 *
 * THE PACKER FAVOURS THE READER, NOT THE SQUARE METRE. The same shelf packer
 * runs recursively at both levels — buildings into their district, then the
 * packed districts onto the ground plane — and its choices are all legibility:
 *
 *  - SHELVES, NOT MOSAICS. Rows aligned at the top, filled left to right, give
 *    the straight streets of a city block. An optimal packer (MaxRects,
 *    skyline) would nest rectangles into a denser but visually chaotic mosaic.
 *  - BIG FIRST. Items sort by footprint area descending (id ascending on
 *    ties), so landmarks stand at a district's corner and the tail of small
 *    buildings fills in behind them. The order is also what keeps the layout
 *    STABLE: a small metric change reorders one building among its peers
 *    instead of reshuffling the whole city.
 *  - NEAR-SQUARE. Each shelf strip targets a width of sqrt(total padded
 *    area), so districts and the city settle close to 1:1 aspect — the shape a
 *    camera frames — rather than one long ribbon.
 *  - OPEN GROUND IS A PARAMETER, AND DECLARED. Streets between buildings,
 *    sidewalks inside a district border, avenues between districts. The
 *    artefact's `layout` block names the algorithm and every parameter, the
 *    same honesty `bindings` gives dimensions: a position whose packer is not
 *    stated cannot be reproduced or compared.
 *
 * COORDINATES. `position`/`bounds` are 2D, in city units, on the ground plane:
 * `x` spans the plane's first axis, `y` its second — under the model's
 * conventions (`groundPlane: "xz"`, `heightAxis: "y"`) a renderer maps layout
 * `y` onto world `z`. A building's `position` is the minimum corner of its
 * footprint, absolute in city coordinates; everything is >= 0.
 */

export const LAYOUT_ALGORITHM = "shelf-rows";
export const LAYOUT_ORDER = "area-desc,id-asc";

export interface Position {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned rectangle on the ground plane; `(x, y)` is its minimum corner. */
export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
}

export interface LayoutOptions {
  /** Street kept open between two buildings of one district. */
  readonly buildingGap?: number;
  /** Sidewalk between a district's border and its outermost buildings. */
  readonly districtPadding?: number;
  /** Avenue kept open between two districts. */
  readonly districtGap?: number;
}

/** The layout as it was actually applied — this is what ships in the artefact. */
export interface ResolvedLayout {
  readonly algorithm: typeof LAYOUT_ALGORITHM;
  readonly order: typeof LAYOUT_ORDER;
  readonly buildingGap: number;
  readonly districtPadding: number;
  readonly districtGap: number;
}

export interface PlacedBuilding extends Building {
  /** Minimum corner of the footprint, absolute in city coordinates. */
  readonly position: Position;
}

export interface PlacedDistrict extends District {
  readonly bounds: Bounds;
}

/** The input city, unchanged, plus placement. */
export interface CityLayout extends CityModel {
  readonly buildings: readonly PlacedBuilding[];
  readonly districts: readonly PlacedDistrict[];
  readonly layout: ResolvedLayout;
  /** The whole ground plane; every district lies within. */
  readonly bounds: Bounds;
}

const DEFAULTS: ResolvedLayout = {
  algorithm: LAYOUT_ALGORITHM,
  order: LAYOUT_ORDER,
  // The default footprint range starts at side 2, so a street as wide as the
  // smallest building reads as open ground; avenues are wider than streets so
  // the module structure stays visible before any label is.
  buildingGap: 2,
  districtPadding: 3,
  districtGap: 6,
};

/**
 * Lay the city out. Pure: the input model is read, never mutated, and the same
 * city with the same options lays out byte-identically.
 *
 * NESTING. A district whose `parent` names another district is packed INSIDE
 * it, as one more rectangle among the parent's own buildings (streets between
 * siblings, the child's own sidewalk marking its border). Sizing runs
 * bottom-up over the district tree, placement top-down; a flat city (no
 * `parent` anywhere) lays out exactly as it always has. A `parent` that is
 * missing from the city or cyclic demotes the district to a root rather than
 * failing — a malformed artifact still gets an honest, drawable answer.
 */
export function layoutCity(city: CityModel, options: LayoutOptions = {}): CityLayout {
  const layout = resolveLayout(options);
  const byId = new Map(city.buildings.map((building) => [building.id, building] as const));
  const districtById = new Map(city.districts.map((district) => [district.id, district] as const));

  const roots: District[] = [];
  const children = new Map<EntityId, District[]>();
  for (const district of city.districts) {
    const parent = district.parent;
    if (parent === undefined || !districtById.has(parent) || inParentCycle(district, districtById)) {
      roots.push(district);
    } else {
      const bucket = children.get(parent);
      if (bucket === undefined) children.set(parent, [district]);
      else bucket.push(district);
    }
  }

  // Bottom-up: each district's inner packing (its buildings + its packed
  // children, sidewalks included) and the outer size that gives it.
  const inner = new Map<EntityId, PackedPlane>();
  const outer = new Map<EntityId, { width: number; depth: number }>();
  const measure = (district: District): { width: number; depth: number } => {
    const childRects = (children.get(district.id) ?? []).map((child) => ({
      id: child.id,
      ...measure(child),
    }));
    const buildingRects = district.buildings.flatMap((id) => {
      const building = byId.get(id);
      return building === undefined
        ? []
        : [{ id, width: building.footprint.width, depth: building.footprint.depth }];
    });
    const packed = packShelves([...buildingRects, ...childRects], layout.buildingGap);
    inner.set(district.id, packed);
    const size = {
      width: packed.width + 2 * layout.districtPadding,
      depth: packed.depth + 2 * layout.districtPadding,
    };
    outer.set(district.id, size);
    return size;
  };
  const rootRects = roots.map((district) => ({ id: district.id, ...measure(district) }));
  const cityPacked = packShelves(rootRects, layout.districtGap);

  // Top-down: absolute corners for every district and building.
  const boundsById = new Map<EntityId, Bounds>();
  const positionById = new Map<EntityId, Position>();
  const place = (district: District, x: number, y: number): void => {
    const size = outer.get(district.id) ?? { width: 0, depth: 0 };
    boundsById.set(district.id, {
      x: round(x),
      y: round(y),
      width: round(size.width),
      depth: round(size.depth),
    });
    const packed = inner.get(district.id);
    for (const child of children.get(district.id) ?? []) {
      const relative = packed?.placements.get(child.id) ?? { x: 0, y: 0 };
      place(child, x + layout.districtPadding + relative.x, y + layout.districtPadding + relative.y);
    }
    for (const id of district.buildings) {
      const relative = packed?.placements.get(id);
      if (relative === undefined) continue;
      positionById.set(id, {
        x: round(x + layout.districtPadding + relative.x),
        y: round(y + layout.districtPadding + relative.y),
      });
    }
  };
  for (const root of roots) {
    const corner = cityPacked.placements.get(root.id) ?? { x: 0, y: 0 };
    place(root, corner.x, corner.y);
  }

  const districts: PlacedDistrict[] = city.districts.map((district) => ({
    ...district,
    bounds: boundsById.get(district.id) ?? { x: 0, y: 0, width: 0, depth: 0 },
  }));
  const buildings: PlacedBuilding[] = city.buildings.map((building) => ({
    ...building,
    position: positionById.get(building.id) ?? { x: 0, y: 0 },
  }));

  return {
    ...city,
    districts,
    buildings,
    layout,
    bounds: { x: 0, y: 0, width: round(cityPacked.width), depth: round(cityPacked.depth) },
  };
}

/** True when following `parent` from this district never terminates. */
function inParentCycle(district: District, byId: ReadonlyMap<EntityId, District>): boolean {
  const seen = new Set<EntityId>();
  for (
    let cursor: District | undefined = district;
    cursor !== undefined;
    cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent)
  ) {
    if (seen.has(cursor.id)) return true;
    seen.add(cursor.id);
  }
  return false;
}

function resolveLayout(options: LayoutOptions): ResolvedLayout {
  const layout: ResolvedLayout = {
    algorithm: LAYOUT_ALGORITHM,
    order: LAYOUT_ORDER,
    buildingGap: options.buildingGap ?? DEFAULTS.buildingGap,
    districtPadding: options.districtPadding ?? DEFAULTS.districtPadding,
    districtGap: options.districtGap ?? DEFAULTS.districtGap,
  };
  for (const key of ["buildingGap", "districtPadding", "districtGap"] as const) {
    const value = layout[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key} must be a finite number >= 0, got ${value}`);
    }
  }
  return layout;
}

interface PackItem {
  readonly id: string;
  readonly width: number;
  readonly depth: number;
}

interface PackedPlane {
  /** Minimum corner per item, relative to the plane's own (0, 0). */
  readonly placements: ReadonlyMap<string, Position>;
  readonly width: number;
  readonly depth: number;
}

/**
 * Shelf packing: rows aligned at the top, filled left to right, a new row when
 * the strip width would overflow. The strip targets sqrt of the total padded
 * area so the result settles near a square; a single item wider than that
 * target gets a row of its own rather than being clipped.
 */
function packShelves(items: readonly PackItem[], gap: number): PackedPlane {
  const sorted = [...items].sort(
    (a, b) => b.width * b.depth - a.width * a.depth || (a.id < b.id ? -1 : 1),
  );
  const targetWidth = Math.max(
    sorted.reduce((widest, item) => Math.max(widest, item.width), 0),
    Math.sqrt(sorted.reduce((area, item) => area + (item.width + gap) * (item.depth + gap), 0)),
  );

  const placements = new Map<string, Position>();
  let x = 0;
  let y = 0;
  let rowDepth = 0;
  let width = 0;
  for (const item of sorted) {
    if (x > 0 && x + item.width > targetWidth + 1e-9) {
      // The row is full: open a street and start the next one at the left curb.
      y += rowDepth + gap;
      x = 0;
      rowDepth = 0;
    }
    placements.set(item.id, { x, y });
    x += item.width + gap;
    width = Math.max(width, x - gap);
    rowDepth = Math.max(rowDepth, item.depth);
  }
  return { placements, width, depth: sorted.length === 0 ? 0 : y + rowDepth };
}
