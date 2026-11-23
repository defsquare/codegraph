// The edges diagram is a committed, generated file that restates the metamodel
// and points into the documentation, pinned like the traits diagram: the
// vocabularies and record keys (against schemas/), the file (against its
// generator), its links (against the pages' headings), and the family each
// kind is drawn in (against the section of the edges page that lists it).
//   node --test scripts/edges-diagram.test.mjs     (pnpm --filter @codegraph/website test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { site } from "./diagram-kit.mjs";
import { assertLinksResolve, pageFile, sections } from "./doc-pages.mjs";
import { EDGE, FAMILIES, PAGE, PROVENANCE, render } from "./edges-diagram.mjs";

const schema = (name) => JSON.parse(readFileSync(join(site, "..", "schemas", `${name}.record.schema.json`), "utf8"));
const dict = schema("header").properties.dict.properties;
const kinds = FAMILIES.flatMap((family) => family.kinds);

test("the diagram names every edge kind of the closed vocabulary, once", () => {
  assert.deepEqual(kinds.map((kind) => kind.name).sort(), [...dict.edges.items.enum].sort());
});

test("and every provenance value, in the order the header enum declares", () => {
  assert.deepEqual(
    PROVENANCE.map((value) => value.name),
    dict.provenance.items.enum,
  );
});

test("the attributes it shows are the edge record's keys, all of them", () => {
  const onTheWire = Object.keys(schema("x").properties).filter((key) => key !== "t");
  const drawn = new Set([...Object.values(EDGE.wire), ...kinds.flatMap((kind) => kind.keys)]);
  assert.deepEqual([...drawn].sort(), onTheWire.sort());
  for (const name of Object.keys(EDGE.wire)) assert.ok(EDGE.sub.some((line) => line.startsWith(name) || line.includes(` ${name}`)), `the edge does not show ${name}`);
  for (const kind of kinds) {
    for (const key of kind.keys) assert.ok(kind.extra?.includes(key), `${kind.name} claims ${key} and does not show it`);
  }
});

test("the committed SVG is the generator's output", () => {
  const committed = readFileSync(join(site, "assets", "diagrams", "edges-metamodel.svg"), "utf8");
  assert.equal(committed, render(), "stale: node scripts/edges-diagram.mjs > assets/diagrams/edges-metamodel.svg");
});

test("the SVG survives being an <img>: no bare ampersand, no label left unpinned", () => {
  const svg = render();
  assert.doesNotMatch(svg, /&(?!amp;|lt;|gt;|quot;)/);
  const unpinned = [...svg.matchAll(/<text\b(?![^>]*\btextLength=)[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(unpinned, ["Codegraph Metamodel", "Edges"]);
});

test("every box links to a page, and to a heading of it where it names one", () => {
  const hrefs = assertLinksResolve(render(), assert);
  const boxes = 1 + 3 + 1 + PROVENANCE.length + FAMILIES.length + kinds.length;
  assert.equal(hrefs.length, boxes + 2 + 1, "edge, entity/profile/anchor, provenance and its values, families, kinds, two legend rows, logo");
});

test("each kind is drawn in the family whose section of the edges page lists it", () => {
  const page = sections(pageFile(PAGE));
  for (const family of FAMILIES) {
    const listed = [...page.get(family.id).matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(listed, family.kinds.map((kind) => kind.name), `#${family.id}`);
  }
});
