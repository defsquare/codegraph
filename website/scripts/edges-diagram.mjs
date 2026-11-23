#!/usr/bin/env node
/**
 * Draws the edge of the metamodel (METAMODEL.md §4) as one SVG: the edge in
 * the middle, its eleven kinds in four families by what they connect, its
 * provenance, the entities at its ends, its anchor and the profile that
 * licenses it; every box a link to the section of the edges page that says it.
 *
 *   node scripts/edges-diagram.mjs > assets/diagrams/edges-metamodel.svg
 *
 * Committed and pinned like the traits diagram (edges-diagram.test.mjs); the
 * drawing is diagram-kit.mjs.
 */
import { pathToFileURL } from "node:url";
import {
  BOX_GAP, BOX_W, COL, DOCS, HEAD, HUB_W, LOGO_H, MARGIN, PAD, ROW_GAP, TOP,
  box, cardinality, colX, connector, frame, legend, logo, port, sheet,
} from "./diagram-kit.mjs";

// ----------------------------------------------------------------- content
export const PAGE = `${DOCS}edges/`;

/**
 * The closed vocabulary of edge kinds, by family. A family's `id` is its
 * section anchor on the edges page; `ends` is "from → to"; `keys` are the
 * attributes a kind adds to every edge's, shown on the line after its ends.
 */
export const FAMILIES = [
  {
    id: "modularity",
    label: "Modularity",
    cell: [0, 1],
    kinds: [
      { name: "import", ends: "Module → Module", keys: [], firstClass: true },
      { name: "fileInclude", ends: "CodeFile → CodeFile", keys: [] },
    ],
  },
  {
    id: "types",
    label: "Types",
    cell: [0, 0],
    kinds: [
      { name: "inheritance", ends: "Type → Type", keys: [] },
      { name: "interfaceImplementation", ends: "Type → interface, trait, protocol", keys: [] },
      { name: "embedding", ends: "Type → Type", keys: [] },
      { name: "traitUsage", ends: "Type → trait, mixin module", keys: [] },
    ],
  },
  {
    id: "behavior",
    label: "Behavior",
    cell: [2, 0],
    kinds: [
      { name: "invocation", ends: "Invocable → Invocable", extra: "candidates?: EntityId[]", keys: ["candidates"] },
      { name: "access", ends: "Invocable → Structural", extra: "isRead, isWrite: boolean", keys: ["isRead", "isWrite"] },
      { name: "throws", ends: "Invocable → exception type", keys: [] },
    ],
  },
  {
    id: "references",
    label: "References",
    cell: [2, 1],
    kinds: [
      { name: "reference", ends: "Entity → Type", keys: [] },
      { name: "annotationUse", ends: "Entity → annotation type", extra: "arguments: NamedArgument[]", keys: ["arguments"] },
    ],
  },
];

/** The four values, in the header enum's order; all but a fact is an inference. */
export const PROVENANCE = [
  { name: "declared", sub: "written in the source", fact: true },
  { name: "derived", sub: "computed by analysis" },
  { name: "dynamic-candidate", sub: "unresolved dispatch: a guess" },
  { name: "generated", sub: "macro or annotation expansion" },
];

/** What every edge carries, by its metamodel name and, in `wire`, its `x` record key. */
export const EDGE = {
  label: "Edge",
  sub: ["edge: EdgeKind", "from, to: EntityId", "provenance: Provenance", "anchor: SourceAnchor", "candidates?: EntityId[]", "sourceFile?: string"],
  href: `${PAGE}#attributes`,
  wire: { edge: "k", from: "f", to: "o", provenance: "p", anchor: "anchor", candidates: "candidates", sourceFile: "sourceFile" },
};
const ENTITY = {
  label: "Entity",
  sub: ["from ≠ to, each known or a stub", "stored once: outgoing only"],
  href: `${PAGE}#rules`,
  aria: "Entity: the rules on an edge's ends",
};
const ANCHOR = {
  label: "SourceAnchor",
  sub: "file and span: where it is written",
  href: `${DOCS}identity/#sourceanchor`,
};
const PROFILE = {
  label: "Language Profile",
  sub: "licenses, per language, the edge kinds its extractor emits",
  href: "/docs/reference/profiles/",
};
const LEGEND = [
  { swatch: "dot", lines: ["import: the first-class layer,", "comparable across languages"], href: `${PAGE}#modularity` },
  { swatch: "solid", lines: ["fact: the source says so"] },
  { swatch: "dashed", lines: ["inference: every rendering dashes it"], href: `${DOCS}provenance/#consequences` },
];

// ------------------------------------------------------------------- render
export function render() {
  const families = FAMILIES.map((family) => ({
    ...family,
    href: `${PAGE}#${family.id}`,
    aria: `${family.label}: ${family.kinds.length} edge kind${family.kinds.length > 1 ? "s" : ""}`,
    boxes: family.kinds.map((kind) =>
      box({
        label: kind.name,
        sub: kind.extra ? [kind.ends, kind.extra] : kind.ends,
        w: BOX_W,
        dot: kind.firstClass,
        // Its family's frame already leads to the same section: one tab stop a family, not one a kind.
        tabStop: false,
        href: `${PAGE}#${family.id}`,
        aria: `${kind.name} (${family.label})`,
      }),
    ),
  }));
  const provenancePage = `${DOCS}provenance/`;
  families.push({
    id: "provenance",
    label: "Provenance",
    cell: [1, 0],
    href: provenancePage,
    aria: `Provenance: ${PROVENANCE.length} values`,
    boxes: PROVENANCE.map((value) =>
      box({ label: value.name, sub: value.sub, w: BOX_W, dashed: !value.fact, tabStop: false, href: provenancePage, aria: `${value.name} (Provenance)` }),
    ),
  });
  for (const family of families) {
    family.content = family.boxes.reduce((sum, b) => sum + b.h, 0) + BOX_GAP * (family.boxes.length - 1);
  }
  // Rows 0 and 1 are as tall as their tallest frame; row 2 holds boxes, the legend and the wordmark.
  const rowH = [0, 1].map((r) => HEAD + PAD + Math.max(...families.filter((fam) => fam.cell[1] === r).map((fam) => fam.content)));
  const rowY = [TOP, TOP + rowH[0] + ROW_GAP, TOP + rowH[0] + rowH[1] + 2 * ROW_GAP];
  for (const family of families) {
    family.rect = { x: colX(family.cell[0]), y: rowY[family.cell[1]], w: COL, h: rowH[family.cell[1]] };
  }
  const rect = Object.fromEntries(families.map((family) => [family.id, family.rect]));

  const hub = box({ ...EDGE, w: HUB_W, hub: true });
  const hubRect = { x: colX(1) + (COL - HUB_W) / 2, y: rowY[1] + (rowH[1] - hub.h) / 2, w: hub.w, h: hub.h };
  const below = [ENTITY, PROFILE, ANCHOR].map((spec, col) => {
    const b = box({ ...spec, w: BOX_W });
    return { b, rect: { x: colX(col) + PAD, y: rowY[2], w: b.w, h: b.h } };
  });
  const [entity, profile, anchor] = below.map((item) => item.rect);

  const groups = families.map((family) => frame(family.rect, family.label, family.href, family.aria));

  // An edge has exactly one kind, so at most one of a family's; exactly one provenance.
  const links = [
    ["types", "top", 0.14, "bottom", 0.8, "left", "0..1"],
    ["provenance", "top", 0.5, "bottom", 0.5, "right", "1"],
    ["behavior", "top", 0.86, "bottom", 0.2, "right", "0..1"],
    ["modularity", "left", 0.5, "right", 0.5, "right", "0..1"],
    ["references", "right", 0.5, "left", 0.5, "left", "0..1"],
  ];
  const edges = links.map(([id, side, t, toSide, toT]) => connector(hubRect, side, t, rect[id], toSide, toT));
  const cards = links.map(([id, , , toSide, toT, lean, card]) => cardinality(card, port(rect[id], toSide, toT), toSide, lean));
  // Two associations reach an entity, so they carry their role names: the edge's two ends.
  const ends = [
    // Both curves arrive from the right, so both labels lean left; the ports sit far
    // apart, so the `from` curve crosses well above the `to` label.
    [entity, 0.06, 0.25, "left", "from 1"],
    [entity, 0.2, 0.9, "left", "to 1"],
    [profile, 0.5, 0.5, "right", "1"],
    [anchor, 0.86, 0.2, "right", "1"],
  ];
  for (const [target, t, toT, lean, card] of ends) {
    edges.push(connector(hubRect, "bottom", t, target, "top", toT));
    cards.push(cardinality(card, port(target, "top", toT), "top", lean));
  }

  const nodes = [hub.draw(hubRect.x, hubRect.y), ...below.map(({ b, rect: r }) => b.draw(r.x, r.y))];
  for (const family of families) {
    let y = family.rect.y + HEAD;
    for (const b of family.boxes) {
      nodes.push(b.draw(family.rect.x + PAD, y));
      y += b.h + BOX_GAP;
    }
  }

  // The middle column's last cell: what the three looks mean, then the wordmark.
  const key = legend(LEGEND, 1, profile.y + profile.h + 52);
  const logoY = key.bottom + 34;
  const H = logoY + LOGO_H + MARGIN + 10;

  const kindCount = FAMILIES.reduce((n, family) => n + family.kinds.length, 0);
  return sheet({
    title: "Edges",
    aria: "The edges of the Codegraph metamodel",
    desc: `An edge connects two entities and is stored once, outgoing. Its ${kindCount} kinds, in ${FAMILIES.length} families by what they connect, each with its ends and the attributes it adds; its ${PROVENANCE.length} provenance values, a dashed one an inference.`,
    height: H,
    groups,
    edges,
    cards,
    nodes,
    legend: key.svg,
    logo: logo(1, logoY),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(render());
