/**
 * The renderer's visual constants — every one maps to a documented meaning
 * (CLAUDE.md: "meaning controls appearance", no decorative effects).
 *
 * Colors are semantic, never aesthetic:
 *  - building        a corpus-declared type; the concrete of the city
 *  - buildingStub    an external type the model degraded to a stub — darker,
 *                    because the model knows less about it
 *  - arrowDeclared   a dependency every base edge of which is a `declared` fact
 *  - arrowInferred   an arrow with at least one non-declared base edge — the
 *                    artifact's `inferred` flag, never recomputed here
 *
 * Dimensions of plates and arcs are presentation geometry only; they encode no
 * metric and therefore live here, not in the city model.
 */
export const COLORS = {
  background: 0x10131a,
  ground: 0x08090c,
  districtPlate: 0x232833,
  building: 0x9aa48f,
  buildingStub: 0x565c51,
  arrowDeclared: 0x3ecf6f,
  arrowInferred: 0xe0483e,
  /** Fan-in: arrows INTO the selected district — who depends on it. */
  arrowFanIn: 0xffa245,
  /** Fan-out: arrows OUT of the selected district — what it depends on. */
  arrowFanOut: 0x3fb6ff,
} as const;

/**
 * Nesting depth is encoded twice, redundantly on purpose: a child plate sits
 * ON its parent (one PLATE_THICKNESS higher) and is tinted this much lighter
 * per level, so the module tree reads from straight above too.
 */
export const PLATE_LIGHTEN_PER_LEVEL = 0.07;

/** A selected district's plate brightens by this factor. */
export const PLATE_SELECT_LIGHTEN = 0.25;

/**
 * An INFERRED district arrow keeps its direction hue but collapses most of the
 * way toward gray — the saturation channel carries provenance, the hue carries
 * direction, and the legend states both.
 */
export const INFERRED_DESATURATION = 0.65;

/** District plates rest on the ground plane; buildings stand on the plates. */
export const PLATE_THICKNESS = 0.35;
export const GROUND_THICKNESS = 0.7;
/** Open ground kept around the outermost districts, in city units. */
export const GROUND_MARGIN = 4;

/** Samples per arrow arc; straight-line segments between them. */
export const ARC_SEGMENTS = 24;
/** Arc apex rises with roof-to-roof distance, so long arrows clear the skyline. */
export const ARC_LIFT_RATIO = 0.3;
export const ARC_MIN_LIFT = 2;

/**
 * Arrow opacity encodes WEIGHT (aggregated edge count, log-scaled): the range
 * an unfocused arrow occupies, the near-invisible level a non-incident arrow
 * drops to while a building has focus, and the level an incident arrow rises to.
 */
export const ARROW_ALPHA_MIN = 0.18;
export const ARROW_ALPHA_MAX = 0.8;
export const ARROW_ALPHA_DIMMED = 0.05;
export const ARROW_ALPHA_FOCUS = 0.95;
