import type { TermClass } from "./classify.js";

/**
 * THE CLOUD'S GEOMETRY (PLAN.md §20.2): pure, no randomness, so a cloud is a
 * function of its words — the CLI's SVG and the tab's page run this one
 * function and differ only by the measurer they hand it.
 *
 *  - WEIGHT ORDER. Words by weight descending, ties by text then class (code
 *    units): the heaviest word takes the centre, and the same words lay out
 *    the same whatever order they arrive in.
 *  - AREA READS AS MAGNITUDE. The font size is interpolated on the square
 *    root of the weight, between `minSize` and `maxSize`, rounded to a pixel.
 *  - FIRST FIT ON A SPIRAL. Each box walks an Archimedean spiral out from the
 *    centre, stretched by `aspect`, and stops at the first point where its
 *    padded box overlaps no box placed before it. There is no fixed canvas:
 *    the spiral leaves every placed box behind eventually, and the canvas is
 *    whatever the words cover.
 *
 * This module imports types only: a page can run it without the Node
 * pipeline behind `aggregate.ts`.
 */

export interface CloudWord {
  readonly text: string;
  readonly weight: number;
  /** Carried for the renderer, which colours by it; the geometry never reads it. */
  readonly class: TermClass;
}

/** The extent of `text` drawn at `size` px: the CLI's monospace default, or a page's `measureText`. */
export type Measure = (text: string, size: number) => { readonly width: number; readonly height: number };

export interface CloudSettings {
  readonly minSize: number;
  readonly maxSize: number;
  /** Kept clear around every word, on each side. */
  readonly padding: number;
  /** The spiral's horizontal stretch: 2 lays a cloud out twice as wide as tall. */
  readonly aspect: number;
}

export interface CloudOptions extends Partial<CloudSettings> {
  readonly measure?: Measure;
}

/** A placed word; `(x, y)` is the CENTRE of its box, `width` × `height` its measured extent. */
export interface PlacedWord extends CloudWord {
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The canvas spans `[0, width] × [0, height]`; every padded box lies within. */
export interface CloudLayout {
  readonly words: readonly PlacedWord[];
  readonly width: number;
  readonly height: number;
  readonly options: CloudSettings;
}

export const CLOUD_DEFAULTS: CloudSettings = Object.freeze({ minSize: 12, maxSize: 56, padding: 4, aspect: 2 });

/** The em fractions `monospaceMeasure` assumes: exact for the monospace faces the SVG declares, to a percent. */
export const MONOSPACE_ADVANCE = 0.6;
export const MONOSPACE_LINE = 1.2;

const MARK = /\p{M}/u;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u{FF01}-\u{FF60}\u{FFE0}-\u{FFE6}]/u;

/** One cell per code point, none for a combining mark, two for a wide character — as a terminal draws them. */
export const monospaceMeasure: Measure = (text, size) => {
  let cells = 0;
  for (const char of text) cells += MARK.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
  return { width: MONOSPACE_ADVANCE * size * cells, height: MONOSPACE_LINE * size };
};

/** Radians between two points tried on the spiral; its radius grows one pixel per radian. */
const SPIRAL_STEP = 0.1;
/** A finite box always finds room this side of it; past it, something is not a box. */
const MAX_STEPS = 10_000_000;

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function layoutCloud(words: readonly CloudWord[], options: CloudOptions = {}): CloudLayout {
  const { measure = monospaceMeasure, ...given } = options;
  const settings: CloudSettings = { ...CLOUD_DEFAULTS, ...given };
  for (const word of words) {
    if (!Number.isFinite(word.weight) || word.weight < 0) {
      throw new RangeError(`a cloud word's weight is a finite number >= 0; ${word.text} has ${word.weight}`);
    }
  }
  const ordered = [...words].sort(
    (a, b) => b.weight - a.weight || compareUnits(a.text, b.text) || compareUnits(a.class, b.class),
  );
  const size = sizer(ordered, settings);

  const boxes: Box[] = [];
  const centred = ordered.map((word) => {
    const px = size(word.weight);
    const { width, height } = measure(word.text, px);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
      throw new RangeError(`the measure gave ${width} × ${height} for ${word.text} at ${px} px; a box is finite and >= 0`);
    }
    const halfW = width / 2 + settings.padding;
    const halfH = height / 2 + settings.padding;
    for (let step = 0; step < MAX_STEPS; step++) {
      const theta = step * SPIRAL_STEP;
      const x = Math.round(settings.aspect * theta * Math.cos(theta));
      const y = Math.round(theta * Math.sin(theta));
      const candidate = { x0: x - halfW, y0: y - halfH, x1: x + halfW, y1: y + halfH };
      if (boxes.some((placed) => intersects(placed, candidate))) continue;
      boxes.push(candidate);
      return { ...word, size: px, x, y, width, height };
    }
    throw new RangeError(`no room found for ${word.text} in ${MAX_STEPS} steps of the spiral`);
  });

  if (boxes.length === 0) return { words: [], width: 0, height: 0, options: settings };
  const x0 = Math.min(...boxes.map((b) => b.x0));
  const y0 = Math.min(...boxes.map((b) => b.y0));
  const x1 = Math.max(...boxes.map((b) => b.x1));
  const y1 = Math.max(...boxes.map((b) => b.y1));
  return {
    words: centred.map((word) => ({ ...word, x: word.x - x0, y: word.y - y0 })),
    width: x1 - x0,
    height: y1 - y0,
    options: settings,
  };
}

/** Weight → font size on the square root, rounded to a pixel; one weight throughout is drawn at the maximum. */
function sizer(ordered: readonly CloudWord[], settings: CloudSettings): (weight: number) => number {
  const high = Math.sqrt(ordered[0]?.weight ?? 0);
  const low = Math.sqrt(ordered[ordered.length - 1]?.weight ?? 0);
  const span = settings.maxSize - settings.minSize;
  if (high === low) return () => settings.maxSize;
  return (weight) => Math.round(settings.minSize + (span * (Math.sqrt(weight) - low)) / (high - low));
}

/** Touching is not overlapping. */
function intersects(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function compareUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
