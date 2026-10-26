import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLOUD_DEFAULTS,
  layoutCloud,
  monospaceMeasure,
  type CloudLayout,
  type CloudWord,
  type Measure,
  type PlacedWord,
} from "../src/cloud.js";
import { TERM_CLASSES } from "../src/classify.js";

/**
 * The cloud's geometry (PLAN.md §20.2): pure, no randomness. Terms by weight,
 * sized on the square root of the weight, each placed at the first point of a
 * spiral from the centre where its box overlaps nothing placed before it.
 */

const word = (text: string, weight: number, cls: CloudWord["class"] = "domain"): CloudWord => ({ text, weight, class: cls });

/** A word's box with its padding: what the layout keeps apart. */
function box(placed: PlacedWord, padding: number): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: placed.x - placed.width / 2 - padding,
    y0: placed.y - placed.height / 2 - padding,
    x1: placed.x + placed.width / 2 + padding,
    y1: placed.y + placed.height / 2 + padding,
  };
}

// Touching is not overlapping; the epsilon absorbs the shift to the origin.
const EPSILON = 1e-9;

function overlaps(a: PlacedWord, b: PlacedWord, padding: number): boolean {
  const p = box(a, padding);
  const q = box(b, padding);
  return p.x0 < q.x1 - EPSILON && q.x0 < p.x1 - EPSILON && p.y0 < q.y1 - EPSILON && q.y0 < p.y1 - EPSILON;
}

describe("the monospace measurer", () => {
  it("advances 0.6 em per code point on a 1.2 em line", () => {
    expect(monospaceMeasure("order", 10)).toEqual({ width: 30, height: 12 });
  });

  // A combining mark takes no cell; a CJK ideograph or a Hangul syllable takes
  // two, as a terminal draws it: the box covers what the font draws.
  it("counts a mark as nothing and a wide character as two", () => {
    expect(monospaceMeasure("été", 10).width).toBe(18);
    expect(monospaceMeasure("注文", 10).width).toBe(24);
    expect(monospaceMeasure("주문", 10).width).toBe(24);
    expect(monospaceMeasure("𠀀", 10).width).toBe(12);
  });
});

describe("layoutCloud", () => {
  it("lays out nothing as an empty canvas", () => {
    expect(layoutCloud([])).toMatchObject({ words: [], width: 0, height: 0 });
  });

  it("puts one word at the maximum size in the middle of a canvas that just holds it", () => {
    const { words, width, height } = layoutCloud([word("order", 7)]);
    const { maxSize, padding } = CLOUD_DEFAULTS;
    const { width: w, height: h } = monospaceMeasure("order", maxSize);
    expect(words).toEqual([{ text: "order", weight: 7, class: "domain", size: maxSize, x: w / 2 + padding, y: h / 2 + padding, width: w, height: h }]);
    expect([width, height]).toEqual([w + 2 * padding, h + 2 * padding]);
  });

  // Area reads as magnitude, so the size follows the square root of the weight:
  // 100, 25 and 1 are √ 10, 5 and 1, four ninths of the way from 10 px to 20 px.
  it("sizes on the square root of the weight, between the minimum and the maximum", () => {
    const { words } = layoutCloud([word("a", 100), word("b", 25), word("c", 1)], { minSize: 10, maxSize: 20 });
    expect(words.map((placed) => placed.size)).toEqual([20, 14, 10]);
  });

  it("gives every word the maximum size when the weights are equal", () => {
    const { words } = layoutCloud([word("a", 3), word("b", 3)], { minSize: 10, maxSize: 20 });
    expect(words.map((placed) => placed.size)).toEqual([20, 20]);
  });

  it("places by weight descending, ties by text then class", () => {
    const { words } = layoutCloud([word("zeta", 1), word("beta", 5), word("alpha", 5, "technical"), word("alpha", 5, "domain")]);
    expect(words.map((placed) => `${placed.text}/${placed.class}`)).toEqual(["alpha/domain", "alpha/technical", "beta/domain", "zeta/domain"]);
  });

  it("measures with the measurer it is handed", () => {
    const measure: Measure = (text, size) => ({ width: text.length * size, height: size });
    const { words } = layoutCloud([word("order", 4), word("line", 1)], { measure, minSize: 10, maxSize: 20 });
    expect(words.map((placed) => [placed.text, placed.width, placed.height])).toEqual([
      ["order", 100, 20],
      ["line", 40, 10],
    ]);
  });

  it("refuses a weight or a measure it could not place", () => {
    expect(() => layoutCloud([word("order", -1)])).toThrow(/weight/u);
    expect(() => layoutCloud([word("order", Number.NaN)])).toThrow(/weight/u);
    const infinite: Measure = () => ({ width: Number.POSITIVE_INFINITY, height: 10 });
    expect(() => layoutCloud([word("order", 1)], { measure: infinite })).toThrow(/measure/u);
    const negative: Measure = () => ({ width: -1, height: 10 });
    expect(() => layoutCloud([word("order", 1)], { measure: negative })).toThrow(/measure/u);
  });

  it("records the options it laid out with", () => {
    expect(layoutCloud([word("order", 1)], { maxSize: 30 }).options).toEqual({ ...CLOUD_DEFAULTS, maxSize: 30 });
  });
});

describe("properties", () => {
  const text = fc.stringMatching(/^[a-zé注𠀀]{1,10}$/u);
  const cloudWord = fc.record({ text, weight: fc.integer({ min: 0, max: 5000 }), class: fc.constantFrom(...TERM_CLASSES) });
  // One entry per (text, class), as a scope's rows are.
  const words = fc.uniqueArray(cloudWord, { maxLength: 40, selector: (w) => `${w.text}/${w.class}` });
  const options = fc.record({
    minSize: fc.integer({ min: 4, max: 20 }),
    span: fc.integer({ min: 0, max: 60 }),
    padding: fc.integer({ min: 0, max: 4 }),
    aspect: fc.double({ min: 0.5, max: 3, noNaN: true }),
  });
  const cloud = (ws: readonly CloudWord[], o: { minSize: number; span: number; padding: number; aspect: number }): CloudLayout =>
    layoutCloud(ws, { minSize: o.minSize, maxSize: o.minSize + o.span, padding: o.padding, aspect: o.aspect });

  it("never lets two boxes overlap", () => {
    fc.assert(
      fc.property(words, options, (ws, o) => {
        const placed = cloud(ws, o).words;
        for (let i = 0; i < placed.length; i++) {
          for (let j = i + 1; j < placed.length; j++) {
            expect(overlaps(placed[i]!, placed[j]!, o.padding), `${placed[i]?.text} × ${placed[j]?.text}`).toBe(false);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("keeps every box, padding included, inside the canvas it reports", () => {
    fc.assert(
      fc.property(words, options, (ws, o) => {
        const layout = cloud(ws, o);
        for (const placed of layout.words) {
          const b = box(placed, o.padding);
          expect(b.x0).toBeGreaterThanOrEqual(-EPSILON);
          expect(b.y0).toBeGreaterThanOrEqual(-EPSILON);
          expect(b.x1).toBeLessThanOrEqual(layout.width + EPSILON);
          expect(b.y1).toBeLessThanOrEqual(layout.height + EPSILON);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("lays out the same words the same way, whatever order they arrive in", () => {
    fc.assert(
      fc.property(
        words.chain((ws) => fc.tuple(fc.constant(ws), fc.shuffledSubarray(ws, { minLength: ws.length }))),
        options,
        ([ws, shuffled], o) => {
          expect(cloud(shuffled, o)).toEqual(cloud(ws, o));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("places by weight, and a heavier word is never the smaller", () => {
    fc.assert(
      fc.property(words, options, (ws, o) => {
        const placed = cloud(ws, o).words;
        expect(placed.map((w) => w.text).sort()).toEqual(ws.map((w) => w.text).sort());
        for (let i = 1; i < placed.length; i++) {
          expect(placed[i]!.weight).toBeLessThanOrEqual(placed[i - 1]!.weight);
          expect(placed[i]!.size).toBeLessThanOrEqual(placed[i - 1]!.size);
        }
        for (const w of placed) {
          expect(w.size).toBeGreaterThanOrEqual(o.minSize);
          expect(w.size).toBeLessThanOrEqual(o.minSize + o.span);
        }
      }),
      { numRuns: 60 },
    );
  });
});
