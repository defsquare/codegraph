import type { OperationScope, VocabularyArtifact, VocabularyScope } from "./artifact.js";
import { TERM_CLASSES, type TermClass } from "./classify.js";
import { layoutCloud, monospaceMeasure, type CloudOptions, type CloudWord } from "./cloud.js";
import { WEIGHT_KEYS } from "./weight.js";

/**
 * A scope's cloud as an SVG document (PLAN.md §20.2), for the CLI's `--svg`
 * and the committed demo image.
 *
 * MEANING CONTROLS APPEARANCE. Size is the weight (through the layout) and
 * colour is the class, through one class attribute per word and a stylesheet:
 * `domain` in ink, `technical` muted, `keyword` and `short` faint, in a light
 * palette and a dark one. Nothing else varies. The legend says what was
 * counted — scope, class filter, counts, weights, view, technical list — since
 * a cloud without them is a picture, not a fact.
 *
 * DETERMINISTIC BYTES: the font is monospace, so the monospace measurer is
 * the one the layout runs with, and every coordinate is rounded to 1/100 px.
 */

export interface CloudSvgOptions extends Omit<CloudOptions, "measure"> {
  /** Which words to draw: one class, or `all` coloured by class. */
  readonly termClass?: TermClass | "all";
  /** The N heaviest of that class. */
  readonly top?: number;
}

export const CLOUD_TOP = 40;

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const STYLE =
  ".bg{fill:#ffffff}.domain{fill:#1f2328}.technical{fill:#59636e}.keyword,.short{fill:#9198a1}.legend{fill:#59636e}" +
  ".cloud text{text-anchor:middle;dominant-baseline:central}" +
  "@media (prefers-color-scheme:dark){.bg{fill:#0d1117}.domain{fill:#f0f6fc}.technical{fill:#9198a1}" +
  ".keyword,.short{fill:#59636e}.legend{fill:#9198a1}}";
const MARGIN = 16;
const GAP = 12;
const LEGEND_SIZE = 12;
const LEGEND_LINE = 18;

export function vocabularyCloudSvg(
  artifact: VocabularyArtifact,
  scope: VocabularyScope | OperationScope,
  options: CloudSvgOptions = {},
): string {
  const { termClass = "domain", top = CLOUD_TOP, ...cloud } = options;
  const matching: CloudWord[] = [];
  for (const [term, weight] of scope.terms) {
    const entry = artifact.terms[term];
    if (entry !== undefined && (termClass === "all" || entry.class === termClass)) {
      matching.push({ text: entry.text, weight, class: entry.class });
    }
  }
  const layout = layoutCloud(matching.slice(0, top), cloud);
  const label = scope.level === "corpus" ? `corpus ${scope.name}` : `${scope.level} ${scope.name}`;

  const what = termClass === "all" ? "all classes" : termClass;
  const shown = layout.words.length;
  const counts =
    matching.length === 0
      ? "no term"
      : `${shown === matching.length ? plural(shown, "term") : `${shown} of ${matching.length} terms`} by weight, size on √weight`;
  const classes = TERM_CLASSES.filter((cls) => layout.words.some((word) => word.class === cls));
  const legend: { readonly plain: string; readonly markup: string }[] = [
    `${label} · ${what}: ${counts}`,
    `weights ${WEIGHT_KEYS.map((key) => `${key} ${artifact.weights[key]}`).join(" · ")}`,
    `view ${artifact.view.name} · technical: ${plural(artifact.technical.words, "shared word")} ` +
      `(sha256 ${artifact.technical.sha256.slice(0, 12)}) + each language's own`,
  ].map((line) => ({ plain: line, markup: escape(line) }));
  if (classes.length > 1) {
    legend.push({
      plain: classes.join(" · "),
      markup: classes.map((cls) => `<tspan class="${cls}">${cls}</tspan>`).join(" · "),
    });
  }

  const legendWidth = Math.max(...legend.map((line) => monospaceMeasure(line.plain, LEGEND_SIZE).width));
  const width = Math.max(layout.width, legendWidth) + 2 * MARGIN;
  const left = MARGIN + (width - 2 * MARGIN - layout.width) / 2;
  const legendTop = MARGIN + layout.height + (layout.height > 0 ? GAP : 0);
  const height = legendTop + LEGEND_LINE * legend.length + MARGIN;

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}" font-family="${FONT}" role="img">`,
    `<title>codegraph vocabulary — ${escape(label)}</title>`,
    `<style>${STYLE}</style>`,
    `<rect class="bg" width="${num(width)}" height="${num(height)}"/>`,
    `<g class="cloud">`,
    ...layout.words.map(
      (word) =>
        `<text class="${word.class}" x="${num(left + word.x)}" y="${num(MARGIN + word.y)}" font-size="${num(word.size)}">${escape(word.text)}</text>`,
    ),
    `</g>`,
    `<g class="legend" font-size="${LEGEND_SIZE}">`,
    ...legend.map(
      (line, i) => `<text x="${MARGIN}" y="${num(legendTop + LEGEND_LINE * i + LEGEND_SIZE)}">${line.markup}</text>`,
    ),
    `</g>`,
    `</svg>`,
  ];
  return `${lines.join("\n")}\n`;
}

/** 1/100 px, and never `-0`. */
function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function escape(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
