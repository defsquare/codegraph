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
 */
export function layoutCity(city: CityModel, options: LayoutOptions = {}): CityLayout {
  const layout = resolveLayout(options);
  const byId = new Map(city.buildings.map((building) => [building.id, building] as const));

  // Level 1 — each district packs its own buildings, relative to its corner.
  const packedByDistrict = new Map(
    city.districts.map((district) => {
      const items = district.buildings.flatMap((id) => {
        const building = byId.get(id);
        return building === undefined
          ? []
          : [{ id, width: building.footprint.width, depth: building.footprint.depth }];
      });
      return [district.id, packShelves(items, layout.buildingGap)] as const;
    }),
  );

  // Level 2 — the packed districts, sidewalks included, pack the ground plane
  // the same way. Recursion by construction: a district is just a rectangle.
  const cityPacked = packShelves(
    city.districts.map((district) => {
      const packed = packedByDistrict.get(district.id);
      return {
        id: district.id,
        width: (packed?.width ?? 0) + 2 * layout.districtPadding,
        depth: (packed?.depth ?? 0) + 2 * layout.districtPadding,
      };
    }),
    layout.districtGap,
  );

  const districts: PlacedDistrict[] = city.districts.map((district) => {
    const corner = cityPacked.placements.get(district.id) ?? { x: 0, y: 0 };
    const packed = packedByDistrict.get(district.id);
    return {
      ...district,
      bounds: {
        x: round(corner.x),
        y: round(corner.y),
        width: round((packed?.width ?? 0) + 2 * layout.districtPadding),
        depth: round((packed?.depth ?? 0) + 2 * layout.districtPadding),
      },
    };
  });

  const districtCorner = new Map(
    districts.map((district) => [district.id, district.bounds] as const),
  );
  const buildings: PlacedBuilding[] = city.buildings.map((building) => {
    const corner = districtCorner.get(building.district);
    const relative = packedByDistrict.get(building.district)?.placements.get(building.id);
    return {
      ...building,
      position: {
        x: round((corner?.x ?? 0) + layout.districtPadding + (relative?.x ?? 0)),
        y: round((corner?.y ?? 0) + layout.districtPadding + (relative?.y ?? 0)),
      },
    };
  });

  return {
    ...city,
    districts,
    buildings,
    layout,
    bounds: { x: 0, y: 0, width: round(cityPacked.width), depth: round(cityPacked.depth) },
  };
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
