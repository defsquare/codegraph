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

## Placement is NOT here

No building has a position, no district has bounds. The layout and 2D
bin-packing pass is separate and not yet written; each district carries the base
area its buildings demand (`footprintDemand`), which is that pass's input.
Publishing a model with no coordinates is what keeps the layout replaceable —
nothing here has to be undone to lay the city out differently.

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
