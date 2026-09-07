---
title: navigator.json
weight: 2
---

The browsable shape of a corpus: a tree of modules, types and members, plus one classified dependency row per base edge. Written by [`navigator`](/reference/cli/navigator/).

**Everything is an array index.** Entity ids are opaque strings that never need to reach the renderer: a node is its position in `nodes`, a file its position in `files`. A reference that cannot be closed onto an index is dropped and counted in diagnostics.

Field names are those of `NavigatorModel` in `packages/navigator/src/model.ts`.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | always `codegraph.navigator/1` |
| `generatedBy` | string | always `@codegraph/navigator` |
| `view` | `ViewDescriptor` | `{name, filters}` |
| `corpus` | `{name, roots}` | |
| `files` | string[] | interned anchor paths |
| `nodes` | `NavNode[]` | preorder over the tree: a parent always precedes its children |
| `roots` | number[] | tree roots, sorted (category, name, id) |
| `deps` | `DepRow[]` | sorted by (from, to, role, member, toMember, anchor) |
| `reports` | `{cycles: NavCycleReport[]}` | precomputed graph facts; absent only in artifacts written before the section existed |
| `diagnostics` | `{selfDeps, droppedDeps}` | |

## `nodes[]` — `NavNode`

| Field | Type | Meaning |
|---|---|---|
| `name` | string | display name; an unnamed invocable (a constructor) shows its signature |
| `kind` | string | the entity kind, verbatim from the model |
| `category` | `"module"` \| `"type"` \| `"operation"` \| `"attribute"` | from traits (`TModule`/`TType`/`TInvocable`/`TStructural`), never from `kind` |
| `isStub` | boolean | |
| `parent` | number | tree parent index; absent for a root |
| `children` | number[] | preorder-consistent, sorted (category, name, id); empty, never absent |
| `signature` | string | |
| `declaredType` | number | the declared type of an attribute or operation, resolved to a node index |
| `anchor` | `[file, start, end]` | `file` is an index into `files`, lines 1-based inclusive |
| `metrics` | `{fanIn, fanOut, instability}` | present on types and modules that have a coupling row under the view; `instability` is `Ce / (Ca + Ce)` in [0,1], 0 by definition when `Ca + Ce = 0` |

## `deps[]` — `DepRow`

One base edge, attributed to the selectable nodes that own its endpoints. `from` and `to` are always type- or module-category nodes; `member` and `toMember` name the operation or attribute that actually carries each endpoint, when one does. A compound assignment (`isRead && isWrite`) emits BOTH a `reads` and a `writes` row — same anchor, both true.

| Field | Type | Meaning |
|---|---|---|
| `role` | `DepRole` | how the row relates its endpoints; see below |
| `from`, `to` | number | node indexes |
| `member` | number | the member carrying the source endpoint |
| `toMember` | number | the member carrying the target endpoint |
| `detail` | string | human refinement of the role: `parameter #2 (channel)`, `local variable total` |
| `provenance` | `Provenance` | |
| `anchor` | `[file, start, end]` | |

### `DepRole`

The metamodel has no `typeDeclaration` edge kind — parameter, return, local-variable and field types are all `reference` edges stored on the member entity — so the role is recovered here from the source entity's traits and its owner's ordered `parameters[]` / `localVariables[]`, never re-derived by a renderer.

`import` · `extends` · `implements` · `embeds` · `usesTrait` · `includesFile` · `invokes` · `reads` · `writes` · `returnType` · `parameterType` · `localVariableType` · `fieldType` · `typeReference`

## `reports.cycles[]` — `NavCycleReport`

The analyzer's cycle report re-addressed to node indexes. The renderer displays which dependency to attack and what cutting it costs; it never runs Tarjan itself.

| Field | Type | Meaning |
|---|---|---|
| `level` | `"module"` \| `"type"` | the analyzer's fold: `module` over imports, `type` over every edge kind |
| `components` | `NavCycleComponent[]` | sorted by first member |
| `tangle` | `NavTangleSummary` | |

`NavCycleComponent`:

| Field | Type | Meaning |
|---|---|---|
| `members` | number[] | node indexes, in the analyzer's member order |
| `edges` | `NavCycleEdge[]` | links BETWEEN members, sorted (from, to); folding self-loops excluded |
| `weight` | number | sum of `edges` counts — the base-edge weight of the cycle |
| `feedbackWeight` | number | sum of the feedback edges' counts — the references the minimal cut severs |
| `tangleMetric` | number | `feedbackWeight / weight`, in [0,1] |

`NavCycleEdge`: `{from, to, count, provenances, allDeclared, feedback}` — `count` is the cost of cutting the link, `allDeclared` is true only when every aggregated base edge is a `declared` fact, `feedback` marks membership of the minimum feedback set.

`NavTangleSummary`: `{feedbackEdgeCount, feedbackWeight, cyclicWeight, metric}` — `metric` is `feedbackWeight / cyclicWeight`, and `0` (not `NaN`) on an acyclic graph.

## `diagnostics`

| Field | Meaning |
|---|---|
| `selfDeps` | edges whose endpoints resolved to the SAME owner — internal cohesion, not a dependency |
| `droppedDeps` | edges dropped because an endpoint had no owning node under the view |

## Excerpt

`codegraph navigator fixtures/java/expected/model.jsonl` — 137 nodes and 131 dependency rows, trimmed to one of each:

```json
{
  "kind": "codegraph.navigator/1",
  "generatedBy": "@codegraph/navigator",
  "view": { "name": "all", "filters": [] },
  "corpus": { "name": "src", "roots": ["fixtures/java/src"] },
  "files": ["com/acme/order/adapter/LedgerAdapter.java", "com/acme/order/legacy/List.java"],
  "nodes": [
    { "name": "com.acme.order", "kind": "package", "category": "module", "isStub": false,
      "children": [1, 6, 13, 19, 21],
      "metrics": { "fanIn": 0, "fanOut": 5, "instability": 1 } },
    { "name": "trail", "kind": "attribute", "category": "attribute", "isStub": false,
      "parent": 2, "children": [], "declaredType": 135, "anchor": [0, 8, 8] }
  ],
  "roots": [0, 110, 112, 114, 123, 126, 128, 132, 135, 136],
  "deps": [
    { "role": "import", "from": 0, "to": 110, "provenance": "derived", "anchor": [11, 3, 3] },
    { "role": "parameterType", "from": 2, "to": 116, "member": 4,
      "detail": "parameter #1 (document)", "provenance": "declared", "anchor": [0, 11, 11] }
  ],
  "reports": {
    "cycles": [
      { "level": "module", "components": [],
        "tangle": { "feedbackEdgeCount": 0, "feedbackWeight": 0, "cyclicWeight": 0, "metric": 0 } }
    ]
  },
  "diagnostics": { "selfDeps": 45, "droppedDeps": 0 }
}
```

A type-level component from the same file:

```json
{ "members": [21, 22],
  "edges": [
    { "from": 21, "to": 22, "count": 2, "provenances": ["declared"], "allDeclared": true, "feedback": false },
    { "from": 22, "to": 21, "count": 1, "provenances": ["declared"], "allDeclared": true, "feedback": true }
  ],
  "weight": 3, "feedbackWeight": 1, "tangleMetric": 0.3333333333333333 }
```

The design behind one classified row per base edge: [The navigator](/explanation/navigator/).
