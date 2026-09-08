---
title: model.jsonl
linkTitle: model.jsonl
weight: 2
---

The interchange format: one model, one JSONL file. Contract version **1.0.0**. The canonical source is [`schemas/`](https://gitlab.com/jgrodziski/codegraph/-/tree/main/schemas) in the repository — one JSON Schema per record type plus the prose container contract; those files are generated from `@codegraph/core` by `pnpm run gen:schemas`.

A model is one **JSONL** file: one JSON object per line, UTF-8, LF-terminated, with the record type in the leading `t` key. Every line validates against the per-record JSON Schema of its type.

| `t` | Schema | Records |
|---|---|---|
| `header` | `header.record.schema.json` | exactly one, first line |
| `f` | `f.record.schema.json` | one interned file path |
| `e` | `e.record.schema.json` | one entity |
| `x` | `x.record.schema.json` | one edge |
| `eof` | `eof.record.schema.json` | exactly one, last line |

## Section order

```
header → f* → e* → x* → eof
```

Contractual, so a reader is single-pass and never rewinds:

- exactly one `header`, and it is the **first** line;
- `f` records next, `i` ascending from 0 with no gaps;
- `e` records next, `i` ascending from 0 with no gaps — `i` **is** the entity's surrogate;
- `x` records next, in canonical order;
- exactly one `eof`, and it is the **last** line.

A record of an earlier section appearing after a later one is an error. Blank lines are ignored.

## Identity: the natural key

An entity is identified by `(lang, module, symbol, disambiguator?)` — `lang` from the header, the rest from the record:

| Record field | Component |
|---|---|
| `m` | surrogate of the **module entity** this entity belongs to |
| `s` | the entity's own path below that module |
| `d` | optional disambiguator; absent when the symbol is already unique |

**A module names itself**: its `m` is its own `i`, and its `s` carries its full module path. That is the only place a module path is written, so a reader recovers any entity's module as `entities[m].s`. Canonical order puts a module before everything inside it, so `m ≤ i` always.

**No rendered id string appears anywhere in the file.** A display form (`lang:module/symbol#disambiguator`) may be produced for humans, but it is never what two consumers compare and never what is stored.

**Uniqueness**: no two entity records may share `(m, s, d)`.

## References are surrogates

Every reference to an entity is its surrogate — the integer `i` of its record.

| Key | Contributed by | Shape |
|---|---|---|
| `parent` | `TChildOf` | surrogate |
| `attachedTo` | `TAttachedTo` | surrogate |
| `declaredType` | `TTypedEntity` | surrogate |
| `parameters` | `TWithParameters` | array of surrogates |
| `localVariables` | `TWithLocalVariables` | array of surrogates |
| `f`, `o` | every edge record | surrogate |
| `candidates` | edge record | array of surrogates |

Surrogates are **file-scoped and not identity**: they are assigned by canonical order, so they change whenever the model changes, and they must never be stored outside the file that assigned them or compared across files. Joining two models is done on natural keys.

Paths are interned the same way: `anchor` is `[fileRef, startLine, endLine]`, `definedIn` is an array of file references, and an edge's `sourceFile` is one. Line numbers are 1-based and `startLine ≤ endLine`.

Closed vocabularies are indices into the header's dictionaries: `k` into `dict.kinds` on an entity and `dict.edges` on an edge, `tr` into `dict.traits`, `p` into `dict.provenance`. **Indices are model-declared** — a model lists the members it uses, in its own order — so extending the vocabulary in `core` never renumbers an existing file. An index the header does not declare is an error.

## Record types

### `header`

> First line of the file. Carries the model's own facts and the dictionaries every other record indexes into. Exactly one per file.

Required: `t`, `schemaVersion`, `lang`, `extractor`, `root`, `dict`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `t` | `"header"` | yes | record type |
| `schemaVersion` | string | yes | version of the interchange contract |
| `lang` | string | yes | profile id of the extractor |
| `extractor` | object `{name, version, …}` | yes | `name` and `version` required; any further key is kept (`noClasspath: true`) |
| `root` | string | yes | the analyzed source root; anchors are relative to it |
| `repository` | object | no | `remote`, `commit`, `root` required, `provider` optional |
| `dict` | object | yes | `kinds`, `traits`, `edges`, `provenance` — all four required |

`repository`:

| Field | Type | Required | Constraint |
|---|---|---|---|
| `remote` | string | yes | https URL, no `.git` suffix |
| `commit` | string | yes | `^[0-9a-f]{7,64}$` |
| `root` | string | yes | the analyzed root relative to the repository root; may be empty |
| `provider` | `"github"` \| `"gitlab"` | no | only when the hostname does not say |

`dict.kinds` is an array of non-empty strings (profile-defined). `dict.traits`, `dict.edges` and `dict.provenance` draw from closed vocabularies — see [Traits](/docs/reference/metamodel/traits/), [Edges](/docs/reference/metamodel/edges/) and [Provenance](/docs/reference/metamodel/provenance/).

### `f`

> One interned file path. `i` is its own index: dense, ascending from 0, gap-free. Anchors and `definedIn` reference these.

Required: `t`, `i`, `path`.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"f"` | record type |
| `i` | integer ≥ 0 | the file's index |
| `path` | non-empty string | path relative to `header.root` |

### `e`

> One entity. `i` is its surrogate and equals its position in the section; `m`/`s`/`d` are the natural key, with `lang` taken from the header — no rendered id appears in the file. A module names ITSELF in `m` and writes its own path in `s`.

Required: `t`, `i`, `k`, `tr`, `m`, `s`.

| Field | Type | Contributed by | Meaning |
|---|---|---|---|
| `t` | `"e"` | — | record type |
| `i` | integer ≥ 0 | — | the entity's surrogate |
| `k` | integer ≥ 0 | — | index into `dict.kinds` |
| `tr` | integer[] | — | indices into `dict.traits` |
| `m` | integer ≥ 0 | — | surrogate of the owning module entity |
| `s` | string | — | the symbol below that module |
| `d` | non-empty string | — | disambiguator |
| `space` | `("type" \| "value")[]` | — | declaration space; TypeScript-family only |
| `name` | non-empty string | `TNamed` | |
| `anchor` | `[file, start, end]` | `TSourceAnchor` | `start ≥ 1`, `end ≥ 1` |
| `comments` | string[] | `TComment` | |
| `parent` | surrogate | `TChildOf` | |
| `attachedTo` | surrogate | `TAttachedTo` | |
| `definedIn` | surrogate[] | `TModule` | file references |
| `isStub` | boolean | `TModule`, `TType` | |
| `declaredType` | surrogate | `TTypedEntity` | optional even when the trait is declared |
| `signature` | string | `TInvocable` | |
| `parameters` | surrogate[] | `TWithParameters` | ordered |
| `localVariables` | surrogate[] | `TWithLocalVariables` | |
| `metrics` | `Record<string, number>` | `TMetrics` | non-empty keys, finite numbers |
| `value` | `Literal` | `TWithValue` | see below |

`TWithChildren`, `TWithInheritances`, `TWithImplements`, `TWithInvocations`, `TStructural` and `TWithAccesses` are markers: they contribute no key.

### `x`

> One edge, outgoing direction only. `f`/`o` are entity surrogates, `k` and `p` index the header's edge-kind and provenance dictionaries.

Required: `t`, `k`, `f`, `o`, `p`, `anchor`.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"x"` | record type |
| `k` | integer ≥ 0 | index into `dict.edges` |
| `f` | surrogate | source entity |
| `o` | surrogate | target entity |
| `p` | integer ≥ 0 | index into `dict.provenance` |
| `anchor` | `[file, start, end]` | where the edge was observed |
| `candidates` | surrogate[] | possible targets when dispatch is uncertain |
| `isRead` | boolean | `access` edges |
| `isWrite` | boolean | `access` edges |
| `arguments` | `NamedArgument[]` | `annotationUse` edges |
| `sourceFile` | surrogate | which declaration site produced the edge |

### `eof`

> Trailer. The counts make truncation detectable: a reader that reaches end-of-input without this record, or whose tallies disagree with it, must reject the file.

Required: `t`, `counts`. `counts` requires `files`, `entities` and `edges`, all integers ≥ 0.

## Literal and NamedArgument

`$defs/Literal` is a tagged union on `k`; ids inside it are surrogates, exactly like an edge endpoint.

| `k` | Other required fields | Notes |
|---|---|---|
| `string` | `v: string` | chars ride as one-character strings |
| `number` | `v: string` | canonical decimal text, or `NaN` / `Infinity` / `-Infinity` |
| `boolean` | `v: boolean` | |
| `null` | — | |
| `enum` | `type: surrogate`, `name: string` | a reference to the type plus the constant's simple name |
| `type` | `type: surrogate` | `Foo.class` and kin |
| `array` | `items: Literal[]` | written order kept |
| `annotation` | `type: surrogate`, `arguments: NamedArgument[]` | a nested annotation value |
| `unevaluated` | `source: string` | a written constant expression the extractor did not fold |

`$defs/NamedArgument` is `{name: string, value: Literal}`; a language-implicit name is normalized explicit.

## Trait keys

An entity record carries **exactly** the keys its declared traits contribute: present when the trait is declared, absent when it is not. Optional-valued keys (`declaredType`) may be absent even when their trait is declared. This is the one rule the per-record schemas cannot state, because deciding it means resolving `tr` through the header. A key no trait contributes is passed through untouched, so an extractor may annotate its output without breaking conformance.

## Integrity

A conforming file satisfies all of:

- **Closure** — every surrogate resolves: `0 ≤ ref < eof.counts.entities`. External entities are stubs, which are declared entities like any other; a reference to something no record declares is an error, not a stub.
- **No self-reference** — `f ≠ o` on every edge.
- **Provenance and anchor on every edge** — a dependency claim with no evidence, or of unknown fact/inference status, is not representable.
- **Counts** — `eof.counts` states how many `f`, `e` and `x` records were written.

## Canonical order and determinism

Entities are sorted by natural key — `lang`, then `module`, then `symbol`, then `disambiguator` with the absent one first — comparing by UTF-16 code unit. That order **is** the surrogate assignment. Edges follow, sorted by `f`, then `o`, then edge kind, then anchor (file, start, end), then provenance. File records are sorted by path; dictionary entries are sorted.

Consequence: two runs of one extractor over one unchanged corpus produce byte-identical files.

## Self-validating an extractor's output

1. Validate every line against the schema for its `t`.
2. Check the sequence: section order, dense `i`, one header, one `eof`.
3. Resolve `k`/`tr`/`p` against the header dictionaries.
4. Check trait keys using the dictionary just resolved.
5. Check integrity and canonical order.

Steps 1 and 3–5 need nothing but the `schemas/` directory.

## Excerpt

From `fixtures/java/expected/model.jsonl`, five lines out of 200:

```json
{"t":"header","schemaVersion":"1.0.0","lang":"java","extractor":{"name":"codegraph-spoon","version":"0.2.0","noClasspath":true},"root":"fixtures/java/src","dict":{"kinds":["annotation","attribute","class","constructor","enum","interface","lambda","localVariable","method","package","parameter","record"],"traits":["TChildOf","TComment","TInvocable","TMetrics","TModule","TNamed","TSourceAnchor","TStructural","TType","TTypedEntity","TWithAccesses","TWithChildren","TWithImplements","TWithInheritances","TWithInvocations","TWithLocalVariables","TWithParameters","TWithValue"],"edges":["access","annotationUse","import","inheritance","interfaceImplementation","invocation","reference","throws"],"provenance":["declared","derived"]}}
{"t":"f","i":0,"path":"com/acme/order/AbstractOrder.java"}
{"t":"e","i":2,"k":3,"tr":[6,11,0,2,16,15,14,10,3],"m":0,"s":"AbstractOrder.<init>(java.lang.String)","signature":"<init>(java.lang.String)","parent":1,"parameters":[3],"localVariables":[],"metrics":{"cyclomatic":1,"sloc":4},"anchor":[0,10,13]}
{"t":"x","k":1,"f":8,"o":168,"p":0,"arguments":[{"name":"value","value":{"k":"enum","type":169,"name":"RUNTIME"}}],"anchor":[1,7,7]}
{"t":"eof","counts":{"files":16,"entities":179,"edges":188}}
```

## Why JSONL

A model of a large corpus does not fit in one JSON document: Apache Fineract produced a 559.5 MB `model.json`, past the ~512 MB ceiling on a JavaScript string, so no reader could open it at any speed. Line-at-a-time means neither writer nor reader ever holds the whole file. The reasoning is in [Why JSONL](/docs/explanation/why-jsonl/).
