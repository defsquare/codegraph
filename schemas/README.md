# Codegraph interchange contract (`model.jsonl`, 1.0.0)

**Generated from `@codegraph/core` — edit the source and re-run `pnpm run gen:schemas`, never these files.**

A model is one **JSONL** file: one JSON object per line, UTF-8, LF-terminated,
with the record type in the leading `t` key. Every line validates against the
per-record JSON Schema of its type:

- `"t":"header"` → [`header.record.schema.json`](header.record.schema.json)
- `"t":"f"` → [`f.record.schema.json`](f.record.schema.json)
- `"t":"e"` → [`e.record.schema.json`](e.record.schema.json)
- `"t":"x"` → [`x.record.schema.json`](x.record.schema.json)
- `"t":"eof"` → [`eof.record.schema.json`](eof.record.schema.json)

Those schemas are the whole of what a single line must be. This file states
everything that only the *sequence* can express — and an extractor must satisfy
both to conform.

Why JSONL rather than one JSON document: a model of a large corpus does not fit
in one. Apache Fineract produced a 559.5MB `model.json`, past the ~512MB ceiling
on a JavaScript string, so no reader could open it at any speed. Line-at-a-time
means neither writer nor reader ever holds the whole file.


## 1. Section order

```
header → f* → e* → x* → eof
```

Contractual, so a reader is single-pass and never rewinds:

- exactly one `header`, and it is the **first** line;
- `f` records next, `i` ascending from 0 with no gaps;
- `e` records next, `i` ascending from 0 with no gaps — `i` **is** the entity's
  surrogate;
- `x` records next, in canonical order (§6);
- exactly one `eof`, and it is the **last** line.

A record of an earlier section appearing after a later one is an error, not a
thing to tolerate. Blank lines are ignored.


## 2. Identity: the natural key

An entity is identified by `(lang, module, symbol, disambiguator?)` — `lang`
from the header, the rest from the record:

| record field | component |
|---|---|
| `m` | surrogate of the **module entity** this entity belongs to |
| `s` | the entity's own path below that module |
| `d` | optional disambiguator; absent when the symbol is already unique |

**A module names itself**: its `m` is its own `i`, and its `s` carries its full
module path. That is the only place a module path is written, so a reader
recovers any entity's module as `entities[m].s`. Because canonical order (§6)
puts a module before everything inside it, `m ≤ i` always — a reader never needs
lookahead to resolve it.

**No rendered id string appears anywhere in the file.** A display form
(`lang:module/symbol#disambiguator`) may be produced for humans, but it is never
what two consumers compare, and never what is stored.

**Uniqueness**: no two entity records may share `(m, s, d)`.


## 3. References are surrogates

Every reference to an entity is its surrogate — the integer `i` of its record.

| key | contributed by | shape |
|---|---|---|
| `parent` | TChildOf | surrogate |
| `attachedTo` | TAttachedTo | surrogate |
| `declaredType` | TTypedEntity | surrogate |
| `parameters` | TWithParameters | array of surrogates |
| `localVariables` | TWithLocalVariables | array of surrogates |
| `f`, `o` | every edge record | surrogate |
| `candidates` | edge record | array of surrogates |

Surrogates are **file-scoped and not identity**: they are assigned by canonical
order, so they change whenever the model changes, and they must never be stored
outside the file that assigned them or compared across files. Joining two models
is done on natural keys (§2).

Paths are interned the same way: `anchor` is `[fileRef, startLine, endLine]`,
`definedIn` is an array of file references, and an edge's `sourceFile` is one.
Line numbers are 1-based and `startLine ≤ endLine`.

Closed vocabularies are indices into the header's dictionaries: `k` into
`dict.kinds` on an entity and `dict.edges` on an edge, `tr` into `dict.traits`,
`p` into `dict.provenance`. **Indices are model-declared** — a model lists the
members it uses, in its own order — so extending the vocabulary in `core` never
renumbers an existing file. An index the header does not declare is an error.


## 4. Trait keys

An entity record carries **exactly** the keys its declared traits contribute:
present when the trait is declared, absent when it is not. Optional-valued keys
(`declaredType`) may be absent even when their trait is declared.

| trait | keys on the wire | |
|---|---|---|
| `TNamed` | `name` |
| `TSourceAnchor` | `anchor` |
| `TComment` | `comments` |
| `TWithChildren` | — | *(marker)*
| `TChildOf` | `parent` |
| `TAttachedTo` | `attachedTo` |
| `TModule` | `definedIn`, `isStub` |
| `TType` | `isStub` |
| `TWithInheritances` | — | *(marker)*
| `TWithImplements` | — | *(marker)*
| `TTypedEntity` | `declaredType` |
| `TInvocable` | `signature` |
| `TWithParameters` | `parameters` |
| `TWithLocalVariables` | `localVariables` |
| `TWithInvocations` | — | *(marker)*
| `TStructural` | — | *(marker)*
| `TWithAccesses` | — | *(marker)*
| `TMetrics` | `metrics` |
| `TWithValue` | `value` |

This is the one rule the per-record schemas cannot state, because deciding it
means resolving `tr` through the header — which a line-at-a-time validator
cannot see. An extractor knows its own dictionary and must check it directly;
every reader enforces it on load.

Note `TWithChildren`: it contributes **no key**. `children` is the exact inverse
of `parent`, and inverse indexes are derived by the consumer, never serialized.
The trait remains, because "this entity is a container" is a fact about it.

A key no trait contributes is passed through untouched, so an extractor may
annotate its output without breaking conformance.


## 5. Integrity

A conforming file satisfies all of:

- **Closure** — every surrogate resolves: `0 ≤ ref < eof.counts.entities`.
  External entities are stubs, which are declared entities like any other; a
  reference to something no record declares is an error, not a stub.
- **No self-reference** — `f ≠ o` on every edge.
- **Provenance and anchor on every edge** — a dependency claim with no evidence,
  or of unknown fact/inference status, is not representable.
- **Counts** — `eof.counts` states how many `f`, `e` and `x` records were
  written. A reader that reaches end-of-input without an `eof`, or whose tallies
  disagree with it, must reject the file: that is how a truncated or killed run
  is caught.


## 6. Canonical order and determinism

Entities are sorted by natural key — `lang`, then `module`, then `symbol`, then
`disambiguator` with the absent one first — comparing by UTF-16 code unit. That
order **is** the surrogate assignment.

Edges follow, sorted by `f`, then `o`, then edge kind, then anchor
(file, start, end), then provenance.

File records are sorted by path; dictionary entries are sorted.

Consequence, and the reason all of the above is contractual: **two runs of one
extractor over one unchanged corpus produce byte-identical files.** Snapshot
diffs are reviewable and extractor cross-validation is meaningful only if that
holds.


## 7. Self-validating an extractor's output

1. Validate every line against the schema for its `t`.
2. Check the sequence: section order, dense `i`, one header, one `eof`.
3. Resolve `k`/`tr`/`p` against the header dictionaries.
4. Check trait keys (§4) using the dictionary you just resolved.
5. Check integrity (§5) and canonical order (§6).

Steps 1 and 3–5 need nothing but this directory. That is the bar for an
extractor in any language: emit conforming lines, and nothing else is asked of
you — no metamodel intelligence, no library, just JSON.
