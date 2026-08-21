/**
 * Metric numbers → city dimensions.
 *
 * A scale is a claim about how to READ the city: on a linear height scale a
 * building twice as tall holds twice the metric, on `sqrt` it holds four times
 * as much, on `log` an order of magnitude more. Which one was used therefore
 * travels in the artefact next to the metric name — the renderer's legend needs
 * both to be honest, and a reader comparing two cities needs to know they were
 * built the same way.
 *
 * Nothing here decides WHAT is measured (metrics.ts) or WHERE a building stands
 * (layout, not yet written).
 */

export const SCALES = ["linear", "sqrt", "log"] as const;
export type ScaleName = (typeof SCALES)[number];

/** Domain observed across the buildings that had a value at all. */
export interface Domain {
  readonly min: number;
  readonly max: number;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export class UnknownScaleError extends Error {
  constructor(readonly scale: string) {
    super(`unknown scale: ${scale}. Known scales: ${SCALES.join(", ")}.`);
    this.name = "UnknownScaleError";
  }
}

export function resolveScale(scale: string): ScaleName {
  if ((SCALES as readonly string[]).includes(scale)) return scale as ScaleName;
  throw new UnknownScaleError(scale);
}

/**
 * `log1p` rather than `log`: metrics legitimately reach 0 (a type nobody
 * depends on has fan-in 0) and `log(0)` is `-Infinity`, which would silently
 * become the range minimum for a real, measured zero. Negative values are
 * clamped to 0 for the same reason — no built-in source produces one, and an
 * extractor-supplied key that does is outside this transform's competence.
 */
function transform(value: number, scale: ScaleName): number {
  const safe = Math.max(value, 0);
  switch (scale) {
    case "linear":
      return safe;
    case "sqrt":
      return Math.sqrt(safe);
    case "log":
      return Math.log1p(safe);
  }
}

/**
 * Map a value into `range` given the observed `domain`.
 *
 * A DEGENERATE DOMAIN (every building measured the same) maps to the MIDDLE of
 * the range, not to its floor: identical inputs must render identically, and
 * flooring them would read as "all minimal" when the truth is "all equal".
 *
 * Values outside the domain are clamped, which only happens when a caller
 * passes a domain it did not measure.
 */
export function scaleValue(value: number, domain: Domain, range: Range, scale: ScaleName): number {
  const low = transform(domain.min, scale);
  const high = transform(domain.max, scale);
  if (!(high > low)) return (range.min + range.max) / 2;
  const position = (transform(value, scale) - low) / (high - low);
  const clamped = Math.min(1, Math.max(0, position));
  return range.min + clamped * (range.max - range.min);
}

/**
 * Dimensions are rounded to a fixed number of decimals so two runs over the
 * same model serialize byte-identically — floating-point associativity is not a
 * guarantee anyone downstream should have to reason about.
 */
export function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
