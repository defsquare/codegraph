# @codegraph/city

The **city model**: a second model derived from a codegraph model, whose
vocabulary is districts, buildings and arrows rather than entities and edges.

```
module (TModule)   ->  DISTRICT   the landscape a building stands on
type   (TType)     ->  BUILDING   dimensions from configurable metrics
type dependency    ->  ARROW      drawn roof to roof, weighted by count
```

Pure computation, like the analyzer: no DOM, no Three.js, no file I/O. It reads
the analyzer's graph and produces data. `packages/viz` will render this output
and must not re-derive any of it.

## Run it

```bash
codegraph city model.jsonl --internal-only > city.json
codegraph city model.jsonl --height sum:cyclomatic --footprint fanIn --out city.json
```

```json
{
  "kind": "codegraph.city/1",
  "conventions": { "arrowAttachment": "roof", "heightAxis": "y", "groundPlane": "xz" },
  "bindings": [{ "channel": "height", "metric": "loc", "scale": "linear", "range": {...} }],
  "districts": [{ "id": "java:com.acme.order", "buildings": [...], "footprintDemand": 1678.8 }],
  "buildings": [{ "id": "java:com.acme.order/OrderService", "district": "java:com.acme.order",
                  "height": 17.6, "footprint": { "width": 13.3, "depth": 13.3 },
                  "metrics": { "loc": 24, "members": 12 } }],
  "arrows": [{ "from": "…/AbstractOrder", "to": "…/Discountable", "count": 1, "inferred": false }]
}
```

## Placement is a separate pass

`buildCity` emits no coordinates: no building has a position, no district has
bounds. `layoutCity` (CLI: `--layout`) is the 2D bin-packing pass that adds
them — `position` on every building, `bounds` on every district and on the
city — and changes nothing else. Keeping the passes apart is what keeps the
packer replaceable: nothing in the model has to be undone to lay the city out
differently.

```bash
codegraph city model.jsonl --internal-only --layout > city.json
```

```json
{
  "layout": { "algorithm": "shelf-rows", "order": "area-desc,id-asc",
              "buildingGap": 2, "districtPadding": 3, "districtGap": 6 },
  "bounds": { "x": 0, "y": 0, "width": 214.3, "depth": 198.6 },
  "districts": [{ "id": "java:com.acme.order", "bounds": { "x": 0, "y": 0, "width": 48.2, "depth": 41.5 } }],
  "buildings": [{ "id": "java:com.acme.order/OrderService", "position": { "x": 3, "y": 3 } }]
}
```

The packer favours the READER, not the square metre, and runs recursively —
buildings into their district, then the packed districts onto the ground plane,
with the same algorithm at both levels:

- **Shelves, not mosaics.** Rows aligned at the top, filled left to right —
  straight streets, like city blocks. An optimal packer (MaxRects, skyline)
  would be denser and visually chaotic.
- **Big first, stable.** Items sort by footprint area descending (id ascending
  on ties): landmarks stand at a district's corner, and a small metric change
  moves one building among its peers instead of reshuffling the city.
- **Near-square.** Each strip targets `sqrt(total padded area)` wide, so
  districts and the city settle close to 1:1 — the shape a camera frames — not
  a ribbon.
- **Open ground is declared.** Streets between buildings (`buildingGap`),
  sidewalks inside a district border (`districtPadding`), avenues between
  districts (`districtGap`) — all parameters, all shipped in the artefact's
  `layout` block, the same honesty `bindings` gives dimensions.

Coordinates are 2D on the ground plane, `(x, y)`, in city units; under the
model's conventions (`groundPlane: "xz"`, `heightAxis: "y"`) a renderer maps
layout `y` onto world `z`. A building's `position` is the minimum corner of its
footprint, absolute in city coordinates.

## Configurable dimensions

Two channels are bound today, each to a named metric on a named scale:

| Channel | Default metric | Default scale | Meaning |
|---|---|---|---|
| `height` | `loc` | `linear` | a tower twice as tall holds twice the source |
| `footprint` | `members` | `sqrt` | the metric maps onto the SIDE, so base AREA is proportional to it |

Built-in metric sources: `loc`, `members`, `methods`, `fields`, `fanIn`,
`fanOut`, `degree`, `one`. Two open-ended forms read whatever an extractor
measured — entities are loose objects (METAMODEL.md §2), so an extra numeric key
survives loading untouched:

| Form | Reads |
|---|---|
| `attribute:<key>` | the type's own numeric key |
| `sum:<key>` | that key summed over everything that folded into the building |

**Cyclomatic complexity** is exactly this case. No extractor emits it today and
this package will not invent it by re-parsing source it cannot see; the day an
extractor puts `cyclomatic` on a method, `--height sum:cyclomatic` is a working
height with no change here. Until then it reports the honest answer: unmeasured.

## What the model refuses to fake

- **A dimension always names its metric and scale**, in `bindings`, with the
  observed domain. A height with no stated metric is decoration.
- **Unmeasured is not zero.** A building the model cannot measure is floored at
  the channel minimum, marked `null` in `metrics`, and counted in
  `diagnostics.unmeasured` — so "smallest" and "unmeasured" stay distinguishable
  (the CLI warns on stderr too).
- **An unknown metric throws** rather than falling back, which would put a
  documented metric's name on a different metric's numbers.
- **Inferred arrows stay marked.** `inferred: true` when any folded base edge is
  not `declared`; the renderer must keep those visually distinct from facts.
- **Containment comes from the model's `parent` chain**, never from splitting a
  name or an id (CLAUDE.md invariant 7). Districts are therefore FLAT: Java
  packages carry no parent package, so nesting `com.acme.order.legacy` under
  `com.acme.order` would be an inference from a name, not a fact from the model.
- **A type with no module is left out**, listed in
  `diagnostics.unplacedBuildings`. Inventing a "(none)" district would stand
  buildings on ground the model never described.
