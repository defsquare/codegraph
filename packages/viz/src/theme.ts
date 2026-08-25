/**
 * The renderer's visual constants — every one maps to a documented meaning
 * (CLAUDE.md: "meaning controls appearance", no decorative effects).
 *
 * Colors are semantic, never aesthetic. Building, stub, district-plate and the
 * two arrow direction hues (fan-in / fan-out) are the USER-CONFIGURABLE
 * palette and live in scene/palette.ts (defaults included) — their meanings
 * hold regardless of the hues chosen: direction stays a hue channel, and an
 * `inferred` arc (the artifact's flag, never recomputed here) still
 * desaturates toward INFERRED_GRAY whatever the hue.
 *
 * Dimensions of plates and arcs are presentation geometry only; they encode no
 * metric and therefore live here, not in the city model.
 */
export const COLORS = {
  background: 0xeef1f5,
  ground: 0xdde2e9,
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

/**
 * REPLAY TIME COLORS (M9c). Heat: a building that changed at the scrubbed tick
 * wears this ember hue outright, cooling toward its base color as ticks pass —
 * an ember red no other channel uses at rest (fan-in orange appears only under
 * a selection). Age: an untouched building desaturates toward AGE_FADE_GRAY,
 * at most AGE_FADE_MAX over the full timeline — old code pales, it never
 * disappears.
 */
export const REPLAY_HEAT_COLOR = 0xd0452e;
export const AGE_FADE_GRAY = 0x9aa5ad;
export const AGE_FADE_MAX = 0.55;

/**
 * How fast heat cools per tick. RESTATED from `@codegraph/city`'s
 * REPLAY_HEAT_DECAY as a literal — a runtime import would drag the Node-side
 * pipeline into the bundle (guard.ts's rule); a test pins the two together.
 */
export const REPLAY_HEAT_DECAY = 0.6;

/**
 * CO-CHANGE ARCS (M9c): logical coupling is an INFERENCE from history, never
 * a dependency — dashed (a different KIND of line, not just a hue) in a
 * magenta no dependency channel uses, visible only for the selected building.
 */
export const CO_CHANGE_COLOR = 0xc2379b;
export const CO_CHANGE_DASH = 1.2;
export const CO_CHANGE_GAP = 0.8;
export const CO_CHANGE_ALPHA = 0.9;

/** District plates rest on the ground plane; buildings stand on the plates. */
export const PLATE_THICKNESS = 0.35;
export const GROUND_THICKNESS = 0.7;
/** Open ground kept around the outermost districts, in city units. */
export const GROUND_MARGIN = 4;

/** Samples per arrow arc; straight-line segments between them. */
export const ARC_SEGMENTS = 24;
/** Arrow line width in CSS pixels (fat lines — WebGL ignores linewidth). */
export const ARROW_WIDTH = 3;
/** Fan-in arcs draw this much wider: who-depends-on-it is the rarer, louder
 * reading, and width keeps it findable even against a busy skyline. */
export const ARROW_FAN_IN_WIDTH = 1.6;
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
