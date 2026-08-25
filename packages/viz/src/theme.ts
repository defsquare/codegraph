/**
 * The renderer's visual constants — every one maps to a documented meaning
 * (CLAUDE.md: "meaning controls appearance", no decorative effects).
 *
 * Colors are semantic, never aesthetic:
 *  - arrowFanIn / arrowFanOut   dependency direction relative to the selected
 *                    element; provenance rides the saturation channel — an
 *                    `inferred` arc (the artifact's flag, never recomputed
 *                    here) desaturates toward INFERRED_GRAY
 *
 * Building, stub and district-plate colors are the USER-CONFIGURABLE palette
 * and live in scene/palette.ts (defaults included) — their meanings hold
 * regardless of the hues chosen.
 *
 * Dimensions of plates and arcs are presentation geometry only; they encode no
 * metric and therefore live here, not in the city model.
 */
export const COLORS = {
  background: 0xeef1f5,
  ground: 0xdde2e9,
  /** Fan-in: arrows INTO the selected district — who depends on it. */
  arrowFanIn: 0xd97a12,
  /** Fan-out: arrows OUT of the selected district — what it depends on. */
  arrowFanOut: 0x1273c2,
} as const;

/**
 * Where plate tinting heads: deeper and selected plates lerp toward this dark
 * slate, so nesting and selection DARKEN against the light ground — contrast
 * would die lerping toward white here. One target, both uses.
 */
export const PLATE_LEVEL_TARGET = 0x39404d;

/**
 * Nesting depth is encoded twice, redundantly on purpose: a child plate sits
 * ON its parent (one PLATE_THICKNESS higher) and is tinted this much further
 * toward PLATE_LEVEL_TARGET per level, so the module tree reads from straight
 * above too.
 */
export const PLATE_TINT_PER_LEVEL = 0.07;

/**
 * The selection (origin) color — a hue no other channel uses, so "the clicked
 * element" can never be confused with direction (orange/blue) or with any
 * user-configured building/plate color. Buildings wear it outright; plates
 * lerp toward it by HIGHLIGHT_TINT to keep their nesting readable.
 */
export const SELECT_COLOR = 0x8e44ad;

/** How far a highlighted PLATE lerps toward its highlight hue (selection or
 * arrow direction). Buildings take the hue outright — they are small and the
 * palette underneath is user-configurable, so a relative tint can vanish. */
export const HIGHLIGHT_TINT = 0.65;

/**
 * An INFERRED district arrow keeps its direction hue but collapses most of the
 * way toward gray — the saturation channel carries provenance, the hue carries
 * direction, and the legend states both.
 */
export const INFERRED_DESATURATION = 0.65;

/** The gray provenance desaturation collapses toward — themed once, here. */
export const INFERRED_GRAY = 0x8a93a0;

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
export const ARROW_ALPHA_MIN = 0.3;
export const ARROW_ALPHA_MAX = 0.85;
export const ARROW_ALPHA_DIMMED = 0.08;
export const ARROW_ALPHA_FOCUS = 1.0;
