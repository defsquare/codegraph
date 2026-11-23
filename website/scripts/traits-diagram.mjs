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
 * on GitHub. The drawing itself is diagram-kit.mjs, shared with the edges.
 */
import { pathToFileURL } from "node:url";
import {
  BOX_GAP, BOX_W, COL, DOCS, HEAD, HUB_W, LOGO_H, MARGIN, PAD, ROW_GAP, TOP,
  box, cardinality, colX, connector, frame, legend, logo, port, sheet,
} from "./diagram-kit.mjs";

// ----------------------------------------------------------------- content
export const PAGE = `${DOCS}traits/`;

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
  { swatch: "dashed", lines: ["marker: contributes no attribute"] },
  {
    swatch: "dot",
    lines: ["example, a Clojure fn-var:", "TNamed + TStructural + TInvocable"],
    href: `${PAGE}#the-composition-that-motivates-the-design`,
  },
];

// ------------------------------------------------------------------- render
export function render() {
  const families = FAMILIES.map((family) => ({
    ...family,
    href: `${PAGE}#${family.id}`,
    boxes: family.traits.map((t) =>
      box({
        label: t.name,
        sub: t.sub,
        w: BOX_W,
        dashed: t.keys.length === 0,
        dot: t.example,
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
  const rect = Object.fromEntries(families.map((family) => [family.id, family.rect]));

  const hub = box({ ...ENTITY, w: HUB_W, hub: true });
  const hubRect = { x: colX(1) + (COL - HUB_W) / 2, y: rowY[1] + (rowH[1] - hub.h) / 2, w: hub.w, h: hub.h };
  const profile = box({ ...PROFILE, w: BOX_W });
  const profileRect = { x: colX(1) + PAD, y: rowY[2], w: profile.w, h: profile.h };

  const groups = families.map((family) =>
    frame(family.rect, family.label, family.href, `${family.label}: ${family.traits.length} trait${family.traits.length > 1 ? "s" : ""}`),
  );

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
  const edges = links.map(([id, side, t, toSide, toT]) => connector(hubRect, side, t, rect[id], toSide, toT));
  const cards = links.map(([id, , , toSide, toT, lean]) => cardinality(upTo(id), port(rect[id], toSide, toT), toSide, lean));
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
  const key = legend(LEGEND, 1, profileRect.y + profileRect.h + 52);
  const logoY = rowY[2] + rowH[2] - LOGO_H;
  if (key.bottom > logoY - 20) throw new Error("the legend runs into the logo");

  const traitCount = FAMILIES.reduce((n, family) => n + family.traits.length, 0);
  return sheet({
    title: "Traits",
    aria: "The traits of the Codegraph metamodel",
    desc: `An entity composes traits. The ${traitCount} traits of the closed vocabulary, in ${FAMILIES.length} families, each with the attributes it contributes; a dashed box is a marker trait, which contributes none.`,
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
