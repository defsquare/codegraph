/**
 * The drawing kit the metamodel diagrams share (traits-diagram.mjs,
 * edges-diagram.mjs): one sheet, one grid, one palette, so the figures read as
 * one family with the Specy metamodel diagrams they restate the style of.
 *
 * Every label is pinned to its width measured from static/fonts/*.ttf with
 * textLength, as the logo's wordmark is: a diagram is also read as an <img>
 * (METAMODEL.md on GitHub), where no webfont loads.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const site = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCS = "/docs/reference/metamodel/";

// ------------------------------------------------------------------- style
// The Specy metamodel diagrams' palette and type, restated: an <img> reads no CSS variable.
const BG = "#ebebeb";
const FRAME = "#dedede";
const BOX = "#fbfbfb";
const INK = "#1b2935";
const RED = "#e46765";
const HOVER = "#e46863";
const SANS = `"IBM Plex Sans Condensed","Arial Narrow","Liberation Sans Narrow",Arial,Helvetica,sans-serif`;
const SERIF = `"EB Garamond",Garamond,"Times New Roman",Times,serif`;
export const SIZE = { hub: 45.1, node: 28.65, sub: 21.5, card: 28.65, group: 22, title: 63.1 };
const TRACKING = 1.6; // letter-spacing of a frame's label

export const W = 1320;
export const MARGIN = 46;
export const COL = 384; // a frame; three of them and two gutters fill the width
export const GUTTER = 38;
export const PAD = 22; // frame to box
export const HEAD = 56; // a frame's label band
export const BOX_W = COL - 2 * PAD;
export const BOX_GAP = 16;
export const ROW_GAP = 84; // room for a connector and its cardinality
export const TOP = 250; // below the title card
export const HUB_W = 320;
const TEXT_PAD = 20;
export const LOGO_H = 49;

export const colX = (c) => MARGIN + c * (COL + GUTTER);

// ----------------------------------------------------------------- metrics
/** Advance widths straight from a TrueType file: `cmap` (format 4) and `hmtx`. */
function loadFont(file) {
  const b = readFileSync(join(site, "static", "fonts", file));
  const table = {};
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) {
    const record = 12 + i * 16;
    table[b.toString("latin1", record, record + 4)] = b.readUInt32BE(record + 8);
  }
  const unitsPerEm = b.readUInt16BE(table.head + 18);
  const longMetrics = b.readUInt16BE(table.hhea + 34);
  let sub = 0;
  for (let i = 0, n = b.readUInt16BE(table.cmap + 2); i < n; i++) {
    const record = table.cmap + 4 + i * 8;
    if (b.readUInt16BE(record) === 3 && b.readUInt16BE(record + 2) === 1) sub = table.cmap + b.readUInt32BE(record + 4);
  }
  if (sub === 0 || b.readUInt16BE(sub) !== 4) throw new Error(`${file}: no format-4 Unicode BMP cmap`);
  const segments = b.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const offsets = deltas + 2 * segments;
  const glyph = (code) => {
    for (let i = 0; i < segments; i++) {
      if (code > b.readUInt16BE(ends + 2 * i)) continue;
      const start = b.readUInt16BE(starts + 2 * i);
      if (code < start) return 0;
      const offset = b.readUInt16BE(offsets + 2 * i);
      if (offset === 0) return (code + b.readUInt16BE(deltas + 2 * i)) & 0xffff;
      const g = b.readUInt16BE(offsets + 2 * i + offset + 2 * (code - start));
      return g === 0 ? 0 : (g + b.readUInt16BE(deltas + 2 * i)) & 0xffff;
    }
    return 0;
  };
  return (text, size) => {
    let units = 0;
    for (const ch of text) {
      const g = glyph(ch.codePointAt(0));
      // A missing glyph would be drawn from another font, at a width nobody measured.
      if (g === 0) throw new Error(`${file} has no glyph for "${ch}" (in "${text}")`);
      units += b.readUInt16BE(table.hmtx + 4 * Math.min(g, longMetrics - 1));
    }
    return (units / unitsPerEm) * size;
  };
}

export const widthOf = {
  b: loadFont("IBMPlexSansCondensed-Bold.ttf"),
  r: loadFont("IBMPlexSansCondensed-Regular.ttf"),
};

// ------------------------------------------------------------------ pieces
export const f = (n) => String(Math.round(n * 10) / 10);
export const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/** One line of text, pinned to its measured width; `x` is its left, centre or right edge. */
export function text(cls, size, x, y, string, { anchor = "middle", tracking = 0 } = {}) {
  const width = widthOf[cls](string, size) + tracking * string.length;
  const left = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
  const spaced = tracking ? ` letter-spacing="${tracking}"` : "";
  return `<text class="mm-${cls}" font-size="${size}"${spaced} x="${f(left)}" y="${f(y)}" textLength="${f(width)}" lengthAdjust="spacingAndGlyphs">${esc(string)}</text>`;
}

function wrap(string, size, max) {
  const lines = [];
  let line = "";
  for (const word of string.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && widthOf.r(candidate, size) > max) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  return [...lines, line];
}

const roundedPath = (x, y, w, h, r = 7.5) =>
  `M${f(x + r)},${f(y)} Q${f(x)},${f(y)} ${f(x)},${f(y + r)} L${f(x)},${f(y + h - r)} Q${f(x)},${f(y + h)} ${f(x + r)},${f(y + h)} ` +
  `L${f(x + w - r)},${f(y + h)} Q${f(x + w)},${f(y + h)} ${f(x + w)},${f(y + h - r)} L${f(x + w)},${f(y + r)} Q${f(x + w)},${f(y)} ${f(x + w - r)},${f(y)} Z`;

/**
 * A box: a label over its subtitle lines, on the vertical rhythm of the Specy
 * diagrams (label baseline at +44, +28 a subtitle line; a hub's at +61, +33).
 * `dashed` and `dot` are the two looks a legend explains.
 */
export function box({ label, sub = [], w, hub = false, dashed = false, dot = false, tabStop = true, href, aria }) {
  const subs = (Array.isArray(sub) ? sub : [sub]).flatMap((s) => wrap(s, SIZE.sub, w - 2 * TEXT_PAD));
  const size = hub ? SIZE.hub : SIZE.node;
  if (widthOf.b(label, size) > w - TEXT_PAD) throw new Error(`"${label}" does not fit a box ${w} wide`);
  const labelY = hub ? 61 : 44 - 4 * (subs.length - 1);
  const subY = labelY + (hub ? 33 : 28);
  const h = subY + 28 * (subs.length - 1) + (hub ? 14 : 18);
  const draw = (x, y) => {
    const cx = x + w / 2;
    const parts = [
      `<a href="${esc(href)}" class="mm-node"${tabStop ? "" : ' tabindex="-1"'} aria-label="${esc(aria ?? label)}">`,
      `<path fill="${BOX}" stroke="${INK}" stroke-width="2"${dashed ? ' stroke-dasharray="9 6"' : ""} d="${roundedPath(x, y, w, h)}"/>`,
      text("b", size, cx, y + labelY, label),
      ...subs.map((s, i) => text("r", SIZE.sub, cx, y + subY + 28 * i, s)),
    ];
    if (dot) parts.push(`<circle cx="${f(x + w - 20)}" cy="${f(y + 20)}" r="7" fill="${RED}"/>`);
    parts.push("</a>");
    return parts.join("\n");
  };
  return { w, h, draw };
}

/** A frame around a family of boxes; the frame is the family's one tab stop. */
export function frame({ x, y, w, h }, label, href, aria) {
  const caps = label.toUpperCase();
  if (widthOf.b(caps, SIZE.group) + TRACKING * caps.length > w - 2 * PAD) throw new Error(`"${caps}" does not fit its frame`);
  return [
    `<a href="${esc(href)}" class="mm-group" aria-label="${esc(aria)}">`,
    `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="14" fill="${FRAME}" stroke="${INK}" stroke-width="2"/>`,
    text("b", SIZE.group, x + PAD, y + 37, caps, { anchor: "start", tracking: TRACKING }),
    "</a>",
  ].join("\n");
}

export const port = (r, side, t = 0.5) =>
  side === "left" ? [r.x, r.y + r.h * t] : side === "right" ? [r.x + r.w, r.y + r.h * t] : side === "top" ? [r.x + r.w * t, r.y] : [r.x + r.w * t, r.y + r.h];
const OUT = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** A connector: one cubic, each handle half the gap along its port's axis, so it never overshoots. */
export function connector(from, fromSide, fromT, to, toSide, toT) {
  const p0 = port(from, fromSide, fromT);
  const p3 = port(to, toSide, toT);
  const handle = (p, q, side) => {
    const along = (q[0] - p[0]) * OUT[side][0] + (q[1] - p[1]) * OUT[side][1];
    return along <= 0 ? 30 : Math.max(along / 2, Math.min(30, along));
  };
  const k0 = handle(p0, p3, fromSide);
  const k3 = handle(p3, p0, toSide);
  const p1 = [p0[0] + OUT[fromSide][0] * k0, p0[1] + OUT[fromSide][1] * k0];
  const p2 = [p3[0] + OUT[toSide][0] * k3, p3[1] + OUT[toSide][1] * k3];
  return `<path class="mm-c" stroke-width="2.5" d="M${f(p0[0])},${f(p0[1])} C${f(p1[0])},${f(p1[1])} ${f(p2[0])},${f(p2[1])} ${f(p3[0])},${f(p3[1])}"/>`;
}

/** A cardinality beside the port it qualifies, on the side the connector leaves free. */
export function cardinality(string, [px, py], side, lean) {
  const dx = lean === "left" ? -10 : 10;
  const anchor = lean === "left" ? "end" : "start";
  const y = side === "bottom" ? py + 32 : side === "top" ? py - 11 : py - 9;
  return text("r", SIZE.card, px + dx, y, string, { anchor });
}

/**
 * The legend, centred in column `col` from `y` down: a swatch per entry, one of
 * the looks `box` draws ("solid", "dashed", "dot"). Returns where it ends.
 */
export function legend(entries, col, y) {
  const rows = [];
  const legendW = 58 + Math.max(...entries.flatMap((entry) => entry.lines.map((line) => widthOf.r(line, SIZE.sub))));
  if (legendW > COL) throw new Error("the legend is wider than its column");
  const x = colX(col) + (COL - legendW) / 2;
  for (const entry of entries) {
    const swatch =
      entry.swatch === "dot"
        ? `<circle cx="${f(x + 22)}" cy="${f(y + 14)}" r="7" fill="${RED}"/>`
        : `<path fill="${BOX}" stroke="${INK}" stroke-width="2"${entry.swatch === "dashed" ? ' stroke-dasharray="9 6"' : ""} d="${roundedPath(x, y, 44, 28, 6)}"/>`;
    const lines = entry.lines.map((line, i) => text("r", SIZE.sub, x + 58, y + 21 + 27 * i, line, { anchor: "start" }));
    const row = [swatch, ...lines].join("\n");
    rows.push(entry.href ? `<a href="${esc(entry.href)}" class="mm-link" aria-label="${esc(entry.lines.join(" "))}">\n${row}\n</a>` : row);
    y += 27 * entry.lines.length + 21;
  }
  return { svg: rows.join("\n"), bottom: y };
}

/** The wordmark, centred in column `col`, its top at `y`. */
export function logo(col, y) {
  const source = readFileSync(join(site, "static", "img", "codegraph-logo-long-dark-blue-text-red-brackets.svg"), "utf8");
  // The wordmark's ids would become ids of whatever page inlines the diagram.
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)[1].replace(/<title>[\s\S]*?<\/title>/, "").replace(/\sid="[^"]*"/g, "");
  return `<a href="/" class="mm-logo" aria-label="Codegraph"><g transform="translate(${f(colX(col) + (COL - 242) / 2)},${f(y)})">${inner.replace(/\s*\n\s*/g, "").trim()}</g></a>`;
}

// -------------------------------------------------------------------- sheet
const CSS = [
  // First, as @import must be: the title's face. The page's own webfonts stay out of reach of an <img>.
  `@import url("https://fonts.googleapis.com/css2?family=EB+Garamond:wght@700&display=swap");`,
  `@font-face{font-family:"IBM Plex Sans Condensed";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/IBMPlexSansCondensed-Regular.ttf") format("truetype")}`,
  `@font-face{font-family:"IBM Plex Sans Condensed";font-style:normal;font-weight:700;font-display:swap;src:url("/fonts/IBMPlexSansCondensed-Bold.ttf") format("truetype")}`,
  `.mm-b{font-family:${SANS};font-weight:700;fill:${INK}}`,
  `.mm-r{font-family:${SANS};font-weight:400;fill:${INK}}`,
  `.mm-t{font-family:${SERIF};font-weight:700;fill:#1c2631}`,
  `.mm-c{fill:none;stroke:${RED};stroke-linecap:round;stroke-linejoin:round}`,
  `.mm-diagram a{text-decoration:none;cursor:pointer;outline:none}`,
  `.mm-node path,.mm-group rect,.mm-diagram a text{transition:stroke .15s,fill .15s}`,
  `.mm-node:hover path,.mm-node:focus-visible path{stroke:${HOVER};stroke-width:3;fill:#fff}`,
  `.mm-group:hover rect,.mm-group:focus-visible rect{stroke:${HOVER};stroke-width:3}`,
  `.mm-node:hover text,.mm-node:focus-visible text,.mm-group:hover text,.mm-group:focus-visible text,.mm-link:hover text,.mm-link:focus-visible text{fill:${HOVER}}`,
  `.mm-logo:focus-visible{outline:2px solid ${HOVER};outline-offset:4px}`,
].join("");

/**
 * The sheet every diagram is drawn on: background, dashed border, the title
 * card ("Codegraph Metamodel" over `title`), then the layers in paint order.
 */
export function sheet({ title, aria, desc, height, groups, edges, cards, nodes, legend, logo }) {
  const titleW = 800;
  return [
    `<svg class="mm-diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${f(height)}" role="group" aria-label="${esc(aria)}">`,
    `<desc>${esc(desc)}</desc>`,
    // Escaped: the file is XML when it is an <img>, and the font URL holds an ampersand.
    `<defs><style>${esc(CSS)}</style>`,
    `<filter id="mm-shadow" x="-5%" y="-15%" width="112%" height="132%"><feDropShadow dx="6" dy="6" stdDeviation="3.5" flood-color="#000" flood-opacity="0.4"/></filter></defs>`,
    `<rect width="${W}" height="${f(height)}" fill="${BG}"/>`,
    `<rect x="11.5" y="10.5" width="${f(W - 23)}" height="${f(height - 21)}" fill="none" stroke="#1e2d3b" stroke-width="3" stroke-dasharray="11 8.634"/>`,
    `<rect x="${f((W - titleW) / 2)}" y="35.5" width="${titleW}" height="159" rx="27" fill="#fff" stroke="#1c2631" stroke-width="3" filter="url(#mm-shadow)"/>`,
    `<text class="mm-t" font-size="${SIZE.title}" text-anchor="middle" x="${W / 2}" y="101">Codegraph Metamodel</text>`,
    `<text class="mm-t" font-size="${SIZE.title}" text-anchor="middle" x="${W / 2}" y="170">${esc(title)}</text>`,
    `<g class="mm-groups">\n${groups.join("\n")}\n</g>`,
    `<g class="mm-edges">\n${edges.join("\n")}\n</g>`,
    `<g class="mm-cards">\n${cards.join("\n")}\n</g>`,
    `<g class="mm-nodes">\n${nodes.join("\n")}\n</g>`,
    `<g class="mm-legend">\n${legend}\n</g>`,
    logo,
    "</svg>",
    "",
  ].join("\n");
}
