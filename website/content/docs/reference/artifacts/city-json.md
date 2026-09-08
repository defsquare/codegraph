---
title: city.json
weight: 1
---

The code city: one flat, sorted, JSON-shaped tree. No classes, no cycles, no `Map`s — it must survive `JSON.stringify` unchanged and arrive intact in a browser. Written by [`city`](/docs/reference/cli/city/); the same shape with an extra `replay` block is written by [`replay`](/docs/reference/cli/replay/) and by [`history --city`](/docs/reference/cli/history/).

Field names are those of `CityModel` in `packages/city/src/city.ts`.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | always `codegraph.city/1` |
| `generatedBy` | string | always `@codegraph/city` |
| `view` | `ViewDescriptor` | `{name, filters}` — the view the city was built under |
| `corpus` | `{name, roots, repository?}` | display name, the model roots verbatim, and the union's repository facts when every model that carries one agrees |
| `conventions` | object | what the renderer may assume; see below |
| `bindings` | `ResolvedBinding[]` | the legend in machine form, one entry per bound channel |
| `districts` | `District[]` | sorted by id |
| `buildings` | `Building[]` | sorted by id |
| `arrows` | `Arrow[]` | type-level dependencies, sorted by (from, to) |
| `districtArrows` | `Arrow[]` | module-level dependencies between districts, from the analyzer's fold at `level: "module"` under the same view |
| `roles` | `{framework, values}` | present only with `--framework`: which framework spoke and the distinct roles it assigned, sorted |
| `diagnostics` | `CityDiagnostics` | what the transform left out |
| `layout` | `ResolvedLayout` | present only after `--layout` |
| `bounds` | `Bounds` | present only after `--layout`: the whole ground plane |
| `replay` | `CityReplay` | present only in a replay city |

### `conventions`

| Field | Value | Meaning |
|---|---|---|
| `arrowAttachment` | `"roof"` | arrows attach at the roof of each building, at both ends |
| `heightAxis` | `"y"` | `height` grows along this axis |
| `groundPlane` | `"xz"` | the plane the districts tile |
| `units` | `"city"` | abstract city units — not metres, not pixels; only ratios mean anything |

### `bindings[]` — `ResolvedBinding`

| Field | Type | Meaning |
|---|---|---|
| `channel` | `"height"` \| `"footprint"` | |
| `metric` | string | the resolved metric name (`loc`, `sum:cyclomatic`, …) |
| `unit` | string | what one unit of the value is, for the legend |
| `describe` | string | the metric source's own one-line description |
| `scale` | `"linear"` \| `"sqrt"` \| `"log"` | |
| `range` | `{min, max}` | the dimension given to the smallest and largest measured value |
| `domain` | `{min, max}` | observed across the buildings that had a value; absent when none did |
| `unmeasured` | integer | buildings the model could not measure on this channel |

See [City metrics](/docs/reference/city-metrics/).

## `districts[]` — `District`

| Field | Type | Meaning |
|---|---|---|
| `id` | EntityId | the module's rendered id |
| `name` | string \| undefined | |
| `kind` | string | the entity kind, verbatim from the model |
| `isStub` | boolean | |
| `identity` | `{lang, module, symbol, disambiguator?}` | `symbol` is empty exactly when the element IS the module |
| `parent` | EntityId | the nearest ancestor module that is itself a district, when the model declares module containment; never derived from the id or the name |
| `buildings` | EntityId[] | sorted; every building whose type folds into this module |
| `footprintDemand` | number | total base area its buildings occupy, in city units² |
| `bounds` | `{x, y, width, depth}` | after `--layout` |

## `buildings[]` — `Building`

| Field | Type | Meaning |
|---|---|---|
| `id` | EntityId | |
| `name` | string \| undefined | |
| `kind` | string | the entity kind, verbatim: `class`, `interface`, `enum`… |
| `isStub` | boolean | |
| `district` | EntityId | |
| `identity` | `{lang, module, symbol, disambiguator?}` | |
| `source` | `{file, span?}` | the anchor, for source links; absent when the model anchors nothing (stubs) |
| `role` | string | the architectural role a framework profile assigns, with `--framework`; absent means the framework says nothing about it, never "plain" |
| `height` | number | along the height axis |
| `footprint` | `{width, depth}` | base rectangle |
| `metrics` | `Record<string, number \| null>` | raw measurements by metric name — the bound channels plus anything `--carry` asked for; `null` means the model does not say |
| `attributes` | `{name, type?, value?}[]` | sorted by name; empty for stubs and memberless types, never absent |
| `operations` | `{signature, parameters?}[]` | sorted by signature; a parameter is `{name, type?}` |
| `owner` | `{name, share}` | dominant author of the element's file, replay cities only and only when a history was joined |
| `position` | `{x, y}` | after `--layout`: minimum corner of the footprint, absolute in city coordinates |

## `arrows[]` and `districtArrows[]` — `Arrow`

| Field | Type | Meaning |
|---|---|---|
| `from`, `to` | EntityId | |
| `count` | integer | base edges aggregated into this arrow |
| `kinds` | EdgeKind[] | sorted |
| `provenances` | Provenance[] | sorted |
| `inferred` | boolean | true when at least one base edge is not `declared` — precomputed so the renderer cannot get the rule wrong |
| `crossDistrict` | boolean | true when the endpoints stand in different districts; trivially true on `districtArrows` |
| `feedback` | boolean | true when this dependency is in the minimum feedback set of its strongly connected component at its own fold level |

Buildings reference their district and districts list their buildings: both directions are stored *in the artifact* even though one is derivable, because a renderer walks both ways per frame. This is not the interchange model, where inverse indexes are never serialized.

## `diagnostics` — `CityDiagnostics`

| Field | Type | Meaning |
|---|---|---|
| `unplacedBuildings` | EntityId[] | types whose module the model does not give; excluded, sorted |
| `droppedArrows` | integer | arrows dropped because an endpoint was not placed |
| `selfArrows` | integer | type-level self-dependencies, excluded |
| `droppedDistrictArrows` | integer | district arrows dropped because an endpoint module is not a district here |
| `selfDistrictArrows` | integer | module-level self-dependencies, excluded — internal cohesion, not an arrow |
| `unmeasured` | `Record<string, number>` | per metric name, how many buildings the model could not measure |
| `fold` | `{unfoldableEntities, droppedEdges, foldedEdges}` | passed through from the fold that produced the buildings |

## `layout` — `ResolvedLayout`

| Field | Value on the default run | Meaning |
|---|---|---|
| `algorithm` | `"shelf-rows"` | |
| `order` | `"area-desc,id-asc"` | |
| `buildingGap` | `2` | street kept open between two buildings of one district |
| `districtPadding` | `3` | sidewalk between a district's border and its outermost buildings |
| `districtGap` | `6` | avenue kept open between two districts |

## `replay` — `CityReplay`

Present in a replay city only.

| Field | Type | Meaning |
|---|---|---|
| `clock` | `"commits"` \| `"revisions"` | what a tick IS: every commit of a mined history, or the sampled revisions of a temporal store |
| `ticks` | `{hash, time, author, fix?}[]` | chronological; `time` is unix seconds |
| `series` | `Record<string, [tick, height, heat?][]>` | building id → sparse keyframes. A keyframe holds until the next one; before the first the building does not exist (height 0), and height 0 later means the element is deleted |
| `coChange` | `{a, b, support, confidence}[]` | logical-coupling arcs between buildings, mined from history — an INFERENCE, never a dependency. Absent when no history was joined |

## Excerpt

`codegraph city fixtures/java/expected/model.jsonl --layout`, trimmed to one district, one building and one arrow of each kind:

```json
{
  "kind": "codegraph.city/1",
  "generatedBy": "@codegraph/city",
  "view": { "name": "all", "filters": [] },
  "corpus": { "name": "src", "roots": ["fixtures/java/src"] },
  "conventions": { "arrowAttachment": "roof", "heightAxis": "y", "groundPlane": "xz", "units": "city" },
  "bindings": [
    { "channel": "height", "metric": "loc", "unit": "source lines",
      "describe": "Lines the type's own source anchor spans (end - start + 1).",
      "scale": "linear", "range": { "min": 1, "max": 40 }, "domain": { "min": 4, "max": 51 },
      "unmeasured": 18 },
    { "channel": "footprint", "metric": "members", "unit": "entities",
      "describe": "Base entities that folded into the building, the type included.",
      "scale": "sqrt", "range": { "min": 2, "max": 20 }, "domain": { "min": 1, "max": 22 },
      "unmeasured": 0 }
  ],
  "districts": [
    { "id": "java:com.megacorp.ledger", "name": "com.megacorp.ledger", "kind": "package",
      "isStub": true,
      "identity": { "lang": "java", "module": "com.megacorp.ledger", "symbol": "" },
      "buildings": ["java:com.megacorp.ledger/LedgerClient"],
      "footprintDemand": 4,
      "bounds": { "x": 46, "y": 84.673, "width": 8, "depth": 8 } }
  ],
  "buildings": [
    { "id": "java:com.acme.order.adapter/LedgerAdapter", "name": "LedgerAdapter", "kind": "class",
      "isStub": false, "district": "java:com.acme.order.adapter",
      "identity": { "lang": "java", "module": "com.acme.order.adapter", "symbol": "LedgerAdapter" },
      "source": { "file": "com/acme/order/adapter/LedgerAdapter.java", "span": [6, 15] },
      "height": 5.979, "footprint": { "width": 8.029, "depth": 8.029 },
      "metrics": { "loc": 10, "members": 5 },
      "attributes": [{ "name": "trail", "type": "AuditTrail" }],
      "operations": [
        { "signature": "<init>()", "parameters": [] },
        { "signature": "post(java.lang.Object)",
          "parameters": [{ "name": "document", "type": "Object" }] }
      ],
      "position": { "x": 24.013, "y": 28 } }
  ],
  "arrows": [
    { "from": "java:com.acme.order.adapter/LedgerAdapter",
      "to": "java:com.megacorp.ledger/LedgerClient",
      "count": 1, "kinds": ["inheritance"], "provenances": ["declared"],
      "inferred": false, "crossDistrict": true, "feedback": false }
  ],
  "districtArrows": [
    { "from": "java:com.acme.order", "to": "java:com.acme.order.legacy",
      "count": 2, "kinds": ["invocation", "reference"], "provenances": ["declared"],
      "inferred": false, "crossDistrict": true, "feedback": false }
  ],
  "diagnostics": {
    "unplacedBuildings": ["java:com.acme.order.adapter/AuditTrail", "java:com.acme.order/Invoice"],
    "droppedArrows": 2, "selfArrows": 12,
    "droppedDistrictArrows": 0, "selfDistrictArrows": 3,
    "unmeasured": { "loc": 18, "members": 0 },
    "fold": { "unfoldableEntities": 10, "droppedEdges": 11, "foldedEdges": 177 }
  },
  "layout": { "algorithm": "shelf-rows", "order": "area-desc,id-asc",
              "buildingGap": 2, "districtPadding": 3, "districtGap": 6 },
  "bounds": { "x": 0, "y": 0, "width": 85.55, "depth": 96.673 }
}
```

Why the city is a model rather than a picture: [The city is a model](/docs/explanation/city-is-a-model/).
