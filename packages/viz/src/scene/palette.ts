/**
 * The user-configurable colors of the city — buildings, stubs, district
 * plates, and the two arrow direction hues — as a MODEL: pure values plus the
 * (de)serialization the shell feeds from localStorage. Storage itself stays in
 * the shell (it can throw); this module never touches the DOM, so the
 * round-trip is unit-tested.
 *
 * The defaults are an architect's-model scheme, built to keep the semantic
 * accents loud: verdigris teal for corpus-declared buildings — a material
 * hue off every accent (fan-in orange, fan-out blue, selection violet); a
 * washed pale of the same family for stubs (the model knows less about
 * them); cool paper for district plates, sitting between the ground and the
 * background so the nesting darkening stays readable.
 */
export interface CityPalette {
  readonly building: number;
  readonly buildingStub: number;
  readonly districtPlate: number;
  /** Fan-in: arrows INTO the selected element — who depends on it. */
  readonly arrowFanIn: number;
  /** Fan-out: arrows OUT of the selected element — what it depends on. */
  readonly arrowFanOut: number;
}

export const DEFAULT_PALETTE: CityPalette = {
  building: 0x4e8c86,
  buildingStub: 0xa3b5b0,
  districtPlate: 0xc9d0da,
  arrowFanIn: 0xd97a12,
  arrowFanOut: 0x1273c2,
};

const PALETTE_KEYS = Object.keys(DEFAULT_PALETTE) as readonly (keyof CityPalette)[];

/** Where the shell persists the palette. */
export const PALETTE_KEY = "codegraph.city.palette";

export function hexToCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Exactly #rrggbb (what <input type="color"> emits); anything else is null. */
export function cssToHex(css: string): number | null {
  return /^#[0-9a-fA-F]{6}$/.test(css) ? Number.parseInt(css.slice(1), 16) : null;
}

/** Valid stored keys override the defaults; garbage in any form falls back. */
export function parsePalette(text: string | null): CityPalette {
  let stored: unknown;
  try {
    stored = text === null ? null : JSON.parse(text);
  } catch {
    stored = null;
  }
  const record =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const read = (key: keyof CityPalette): number => {
    const value = record[key];
    const hex = typeof value === "string" ? cssToHex(value) : null;
    return hex ?? DEFAULT_PALETTE[key];
  };
  return {
    building: read("building"),
    buildingStub: read("buildingStub"),
    districtPlate: read("districtPlate"),
    arrowFanIn: read("arrowFanIn"),
    arrowFanOut: read("arrowFanOut"),
  };
}

export function serializePalette(palette: CityPalette): string {
  return JSON.stringify(
    Object.fromEntries(PALETTE_KEYS.map((key) => [key, hexToCss(palette[key])])),
  );
}
