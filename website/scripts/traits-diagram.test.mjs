// The traits diagram is a committed, generated file that restates the metamodel
// and points into the documentation. Each test pins one way it could go stale:
// the vocabulary (against schemas/, the committed contract core generates), the
// file (against its generator), and its links (against the pages' headings).
//   node --test scripts/traits-diagram.test.mjs     (pnpm --filter @codegraph/website test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { site } from "./diagram-kit.mjs";
import { assertLinksResolve } from "./doc-pages.mjs";
import { FAMILIES, render } from "./traits-diagram.mjs";

const schema = (name) => JSON.parse(readFileSync(join(site, "..", "schemas", `${name}.record.schema.json`), "utf8"));
const traits = FAMILIES.flatMap((family) => family.traits);

test("the diagram names every trait of the closed vocabulary, once", () => {
  const vocabulary = schema("header").properties.dict.properties.traits.items.enum;
  const drawn = traits.map((t) => t.name);
  assert.deepEqual([...drawn].sort(), [...vocabulary].sort());
});

test("the attributes it shows are the entity record's trait keys, all of them", () => {
  // What an `e` record carries of its own: tag, surrogate, kind, traits, the key (m, s, d), space.
  const own = new Set(["t", "i", "k", "tr", "m", "s", "d", "space"]);
  const onTheWire = Object.keys(schema("e").properties).filter((key) => !own.has(key));
  const drawn = new Set(traits.flatMap((t) => t.keys));
  assert.deepEqual([...drawn].sort(), onTheWire.sort());
  for (const t of traits) {
    for (const key of t.keys) assert.ok([t.sub].flat().join(" ").includes(key), `${t.name} claims ${key} and does not show it`);
  }
});

test("the committed SVG is the generator's output", () => {
  const committed = readFileSync(join(site, "assets", "diagrams", "traits-metamodel.svg"), "utf8");
  assert.equal(committed, render(), "stale: node scripts/traits-diagram.mjs > assets/diagrams/traits-metamodel.svg");
});

test("the SVG survives being an <img>: no bare ampersand, no label left unpinned", () => {
  const svg = render();
  assert.doesNotMatch(svg, /&(?!amp;|lt;|gt;|quot;)/);
  // The title alone is unpinned: it is centred in a card far wider than it. (The logo's
  // wordmark holds no text of its own: its tspan carries the pin.)
  const unpinned = [...svg.matchAll(/<text\b(?![^>]*\btextLength=)[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(unpinned, ["Codegraph Metamodel", "Traits"]);
});

test("every box links to a heading that exists", () => {
  const hrefs = assertLinksResolve(render(), assert);
  assert.equal(hrefs.length, 1 + 1 + 1 + FAMILIES.length + traits.length + 1, "entity, profile, example, families, traits, logo");
});
