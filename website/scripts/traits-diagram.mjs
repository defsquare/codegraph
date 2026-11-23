#!/usr/bin/env node
/**
 * Draws the trait vocabulary of the metamodel (METAMODEL.md §3) as one SVG:
 * the entity in the middle, the seven trait families around it, every trait a
 * box that says what it contributes, every box a link to its section of the
 * traits page.
 *
 *   node scripts/traits-diagram.mjs > assets/diagrams/traits-metamodel.svg
 *
 * The file is committed, and `pnpm --filter @codegraph/website test` fails
 * when it is not this script's output. It is read three ways, so it carries
 * everything it needs: inlined in a page (the metamodel-diagram shortcode;
 * links and hover live), opened on its own, and as an <img> in METAMODEL.md
 * on GitHub — where no webfont loads, which is why every label is pinned to
 * its measured width with textLength, as the logo's wordmark is.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");

// ----------------------------------------------------------------- content
const DOCS = "/docs/reference/metamodel/";
const PAGE = `${DOCS}traits/`;

/**
 * The closed vocabulary, by family. A family's `id` is its section anchor on
 * the traits page; `keys` are the attributes the trait contributes, and a
 * trait with none is a marker. `example` tags the motivating composition.
 */
export const FAMILIES = [
  {
    id: "base",
    label: "Base",
    cell: [0, 0],
    traits: [
      { name: "TNamed", sub: "name: string", keys: ["name"], example: true },
      { name: "TSourceAnchor", sub: "anchor: SourceAnchor", keys: ["anchor"] },
      { name: "TComment", sub: "comments: string[]", keys: ["comments"] },
    ],
  },
  {
    id: "containment-and-attachment",
    label: "Containment & attachment",
    cell: [1, 0],
    traits: [
      { name: "TWithChildren", sub: "children: derived from parent", keys: [] },
      { name: "TChildOf", sub: "parent: EntityId", keys: ["parent"] },
      { name: "TAttachedTo", sub: "attachedTo: EntityId", keys: ["attachedTo"] },
    ],
  },
  {
    id: "structure",
    label: "Structure",
    cell: [2, 0],
    traits: [
      { name: "TStructural", sub: "value holder, target of accesses", keys: [], example: true },
      { name: "TWithAccesses", sub: "→ access edges", keys: [] },
      { name: "TWithValue", sub: "value: Literal", keys: ["value"] },
    ],
  },
  {
    id: "modularity",
    label: "Modularity",
    cell: [0, 1],
    traits: [{ name: "TModule", sub: ["definedIn: string[]", "isStub: boolean"], keys: ["definedIn", "isStub"] }],
  },
  {
    id: "measures",
    label: "Measures",
    cell: [2, 1],
    traits: [{ name: "TMetrics", sub: ["metrics: Record<string, number>", "measured, never defaulted"], keys: ["metrics"] }],
  },
  {
    id: "types",
    label: "Types",
    cell: [0, 2],
    traits: [
      { name: "TType", sub: "isStub: boolean", keys: ["isStub"] },
      { name: "TWithInheritances", sub: "→ inheritance edges", keys: [] },
      { name: "TWithImplements", sub: "→ interfaceImplementation edges", keys: [] },
      { name: "TTypedEntity", sub: "declaredType?: EntityId", keys: ["declaredType"] },
    ],
  },
  {
    id: "behavior",
    label: "Behavior",
    cell: [2, 2],
    traits: [
      { name: "TInvocable", sub: "signature: string", keys: ["signature"], example: true },
      { name: "TWithParameters", sub: "parameters: EntityId[]", keys: ["parameters"] },
      { name: "TWithLocalVariables", sub: "localVariables: EntityId[]", keys: ["localVariables"] },
      { name: "TWithInvocations", sub: "→ invocation edges", keys: [] },
    ],
  },
];

const ENTITY = {
  label: "Entity",
  sub: "{ id, kind, traits[], …trait keys }",
  href: `${DOCS}#entity`,
};
const PROFILE = {
  label: "Language Profile",
  sub: "licenses, per kind, the traits an entity must and may compose",
  href: `${DOCS}profiles/#validation`,
};
const LEGEND = [
  { swatch: "solid", lines: ["contributes attributes to the entity"] },
  { swatch: "marker", lines: ["marker: contributes no attribute"] },
  {
    swatch: "example",
    lines: ["example, a Clojure fn-var:", "TNamed + TStructural + TInvocable"],
    href: `${PAGE}#the-composition-that-motivates-the-design`,
  },
];

// ------------------------------------------------------------------- style
// The Specy metamodel diagrams' palette and type, restated: an <img> reads no
// CSS variable, and the two sites' figures are meant to look like one family.
const BG = "#ebebeb";
const FRAME = "#dedede";
const BOX = "#fbfbfb";
const INK = "#1b2935";
const RED = "#e46765";
const HOVER = "#e46863";
const SANS = `"IBM Plex Sans Condensed","Arial Narrow","Liberation Sans Narrow",Arial,Helvetica,sans-serif`;
const SERIF = `"EB Garamond",Garamond,"Times New Roman",Times,serif`;
const SIZE = { hub: 45.1, node: 28.65, sub: 21.5, card: 28.65, group: 22, title: 63.1 };
const TRACKING = 1.6; // letter-spacing of a family's label

const W = 1320;
const MARGIN = 46;
const COL = 384; // a family frame; three of them and two gutters fill the width
const GUTTER = 38;
const PAD = 22; // frame to box
const HEAD = 56; // a frame's label band
const BOX_W = COL - 2 * PAD;
const BOX_GAP = 16;
const ROW_GAP = 84; // room for a connector and its cardinality
const TOP = 250; // below the title card
const HUB_W = 320;
const TEXT_PAD = 20;

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

const widthOf = {
  b: loadFont("IBMPlexSansCondensed-Bold.ttf"),
  r: loadFont("IBMPlexSansCondensed-Regular.ttf"),
};

// ------------------------------------------------------------------ pieces
const f = (n) => String(Math.round(n * 10) / 10);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/** One line of text, pinned to its measured width; `x` is its left, centre or right edge. */
function text(cls, size, x, y, string, { anchor = "middle", tracking = 0 } = {}) {
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
 */
function box({ label, sub = [], w, hub = false, marker = false, example = false, tabStop = true, href, aria }) {
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
      `<path fill="${BOX}" stroke="${INK}" stroke-width="2"${marker ? ' stroke-dasharray="9 6"' : ""} d="${roundedPath(x, y, w, h)}"/>`,
      text("b", size, cx, y + labelY, label),
      ...subs.map((s, i) => text("r", SIZE.sub, cx, y + subY + 28 * i, s)),
    ];
    if (example) parts.push(`<circle cx="${f(x + w - 20)}" cy="${f(y + 20)}" r="7" fill="${RED}"/>`);
    parts.push("</a>");
    return parts.join("\n");
  };
  return { w, h, draw };
}

const port = (r, side, t = 0.5) =>
  side === "left" ? [r.x, r.y + r.h * t] : side === "right" ? [r.x + r.w, r.y + r.h * t] : side === "top" ? [r.x + r.w * t, r.y] : [r.x + r.w * t, r.y + r.h];
const OUT = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** A connector: one cubic, each handle half the gap along its port's axis, so it never overshoots. */
function connector(from, fromSide, fromT, to, toSide, toT) {
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
function cardinality(string, [px, py], side, lean) {
  const dx = lean === "left" ? -10 : 10;
  const anchor = lean === "left" ? "end" : "start";
  const y = side === "bottom" ? py + 32 : side === "top" ? py - 11 : py - 9;
  return text("r", SIZE.card, px + dx, y, string, { anchor });
}

function logo(x, y) {
  const source = readFileSync(join(site, "static", "img", "codegraph-logo-long-dark-blue-text-red-brackets.svg"), "utf8");
  // The wordmark's ids would become ids of whatever page inlines the diagram.
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(source)[1].replace(/<title>[\s\S]*?<\/title>/, "").replace(/\sid="[^"]*"/g, "");
  return `<a href="/" class="mm-logo" aria-label="Codegraph"><g transform="translate(${f(x)},${f(y)})">${inner.replace(/\s*\n\s*/g, "").trim()}</g></a>`;
}

// ------------------------------------------------------------------- render
export function render() {
  const colX = (c) => MARGIN + c * (COL + GUTTER);

  const families = FAMILIES.map((family) => ({
    ...family,
    href: `${PAGE}#${family.id}`,
    boxes: family.traits.map((t) =>
      box({
        label: t.name,
        sub: t.sub,
        w: BOX_W,
        marker: t.keys.length === 0,
        example: t.example,
        // Its family's frame already leads to the same section: one tab stop a family, not one a trait.
        tabStop: false,
        href: `${PAGE}#${family.id}`,
        aria: `${t.name} (${family.label})`,
      }),
    ),
  }));
  for (const family of families) {
    family.content = family.boxes.reduce((sum, b) => sum + b.h, 0) + BOX_GAP * (family.boxes.length - 1);
  }
  // A row is as tall as its tallest family; every frame of the row takes that height.
  const rowH = [0, 1, 2].map((r) => HEAD + PAD + Math.max(...families.filter((fam) => fam.cell[1] === r).map((fam) => fam.content)));
  const rowY = [TOP, TOP + rowH[0] + ROW_GAP, TOP + rowH[0] + rowH[1] + 2 * ROW_GAP];
  const H = rowY[2] + rowH[2] + MARGIN + 10;
  for (const family of families) {
    family.rect = { x: colX(family.cell[0]), y: rowY[family.cell[1]], w: COL, h: rowH[family.cell[1]] };
  }
  const frame = Object.fromEntries(families.map((family) => [family.id, family.rect]));

  const hub = box({ ...ENTITY, w: HUB_W, hub: true });
  const hubRect = { x: colX(1) + (COL - HUB_W) / 2, y: rowY[1] + (rowH[1] - hub.h) / 2, w: hub.w, h: hub.h };
  const profile = box({ ...PROFILE, w: BOX_W });
  const profileRect = { x: colX(1) + PAD, y: rowY[2], w: profile.w, h: profile.h };

  const groups = families.map((family) => {
    const { x, y, w, h } = family.rect;
    const label = family.label.toUpperCase();
    if (widthOf.b(label, SIZE.group) + TRACKING * label.length > w - 2 * PAD) throw new Error(`"${label}" does not fit its frame`);
    return [
      `<a href="${esc(family.href)}" class="mm-group" aria-label="${esc(`${family.label}: ${family.traits.length} trait${family.traits.length > 1 ? "s" : ""}`)}">`,
      `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="14" fill="${FRAME}" stroke="${INK}" stroke-width="2"/>`,
      text("b", SIZE.group, x + PAD, y + 37, label, { anchor: "start", tracking: TRACKING }),
      "</a>",
    ].join("\n");
  });

  // The entity composes at most one of each trait: zero to all of a family's.
  const upTo = (id) => `0..${families.find((family) => family.id === id).traits.length}`;
  const links = [
    ["containment-and-attachment", "top", 0.5, "bottom", 0.5, "right"],
    ["base", "top", 0.14, "bottom", 0.8, "left"],
    ["structure", "top", 0.86, "bottom", 0.2, "right"],
    ["modularity", "left", 0.5, "right", 0.5, "right"],
    ["measures", "right", 0.5, "left", 0.5, "left"],
    ["types", "bottom", 0.14, "top", 0.8, "left"],
    ["behavior", "bottom", 0.86, "top", 0.2, "right"],
  ];
  const edges = links.map(([id, side, t, toSide, toT]) => connector(hubRect, side, t, frame[id], toSide, toT));
  const cards = links.map(([id, , , toSide, toT, lean]) => cardinality(upTo(id), port(frame[id], toSide, toT), toSide, lean));
  edges.push(connector(hubRect, "bottom", 0.5, profileRect, "top", 0.5));
  cards.push(cardinality("1", port(profileRect, "top"), "top", "right"));

  const nodes = [hub.draw(hubRect.x, hubRect.y), profile.draw(profileRect.x, profileRect.y)];
  for (const family of families) {
    let y = family.rect.y + HEAD;
    for (const b of family.boxes) {
      nodes.push(b.draw(family.rect.x + PAD, y));
      y += b.h + BOX_GAP;
    }
  }

  // The middle column's last cell: what the three looks mean, then the wordmark.
  const legend = [];
  const legendW = 58 + Math.max(...LEGEND.flatMap((entry) => entry.lines.map((line) => widthOf.r(line, SIZE.sub))));
  if (legendW > COL) throw new Error("the legend is wider than its column");
  let y = profileRect.y + profileRect.h + 52;
  for (const entry of LEGEND) {
    const x = colX(1) + (COL - legendW) / 2;
    const swatch =
      entry.swatch === "example"
        ? `<circle cx="${f(x + 22)}" cy="${f(y + 14)}" r="7" fill="${RED}"/>`
        : `<path fill="${BOX}" stroke="${INK}" stroke-width="2"${entry.swatch === "marker" ? ' stroke-dasharray="9 6"' : ""} d="${roundedPath(x, y, 44, 28, 6)}"/>`;
    const lines = entry.lines.map((line, i) => text("r", SIZE.sub, x + 58, y + 21 + 27 * i, line, { anchor: "start" }));
    const row = [swatch, ...lines].join("\n");
    legend.push(entry.href ? `<a href="${esc(entry.href)}" class="mm-link" aria-label="${esc(entry.lines.join(" "))}">\n${row}\n</a>` : row);
    y += 27 * entry.lines.length + 21;
  }
  const mark = logo(colX(1) + (COL - 242) / 2, rowY[2] + rowH[2] - 49);
  if (y > rowY[2] + rowH[2] - 49 - 20) throw new Error("the legend runs into the logo");

  const css = [
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

  const titleW = 800;
  const traitCount = FAMILIES.reduce((n, family) => n + family.traits.length, 0);
  return [
    `<svg class="mm-diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${f(H)}" role="group" aria-label="The traits of the Codegraph metamodel">`,
    `<desc>An entity composes traits. The ${traitCount} traits of the closed vocabulary, in ${FAMILIES.length} families, each with the attributes it contributes; a dashed box is a marker trait, which contributes none.</desc>`,
    // Escaped: the file is XML when it is an <img>, and the font URL holds an ampersand.
    `<defs><style>${esc(css)}</style>`,
    `<filter id="mm-shadow" x="-5%" y="-15%" width="112%" height="132%"><feDropShadow dx="6" dy="6" stdDeviation="3.5" flood-color="#000" flood-opacity="0.4"/></filter></defs>`,
    `<rect width="${W}" height="${f(H)}" fill="${BG}"/>`,
    `<rect x="11.5" y="10.5" width="${f(W - 23)}" height="${f(H - 21)}" fill="none" stroke="#1e2d3b" stroke-width="3" stroke-dasharray="11 8.634"/>`,
    `<rect x="${f((W - titleW) / 2)}" y="35.5" width="${titleW}" height="159" rx="27" fill="#fff" stroke="#1c2631" stroke-width="3" filter="url(#mm-shadow)"/>`,
    `<text class="mm-t" font-size="${SIZE.title}" text-anchor="middle" x="${W / 2}" y="101">Codegraph Metamodel</text>`,
    `<text class="mm-t" font-size="${SIZE.title}" text-anchor="middle" x="${W / 2}" y="170">Traits</text>`,
    `<g class="mm-groups">\n${groups.join("\n")}\n</g>`,
    `<g class="mm-edges">\n${edges.join("\n")}\n</g>`,
    `<g class="mm-cards">\n${cards.join("\n")}\n</g>`,
    `<g class="mm-nodes">\n${nodes.join("\n")}\n</g>`,
    `<g class="mm-legend">\n${legend.join("\n")}\n</g>`,
    mark,
    "</svg>",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(render());
