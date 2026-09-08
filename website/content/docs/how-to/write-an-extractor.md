---
title: Write an extractor for a new language
linkTitle: Write an extractor
weight: 13
---

An extractor's whole job is to emit a conforming `model.jsonl`. It contains no
metamodel intelligence: no trait logic, no validation, no library from this
repository. If your language can print JSON, it can produce a model.

**Before you start:** read `schemas/README.md` — the container contract — and the
five per-record schemas beside it. Those files are the contract; this page is the
order to do things in.

## 1. Pick the language profile you will satisfy

```bash
codegraph profiles                    # the nine profiles core ships
codegraph profiles --lang java        # one language's full spec
```

A profile says, per entity kind, which traits are **required** and which are
**optional**:

```text
  class
    required  TNamed, TType, TWithInheritances, TWithImplements, TWithChildren, TChildOf, TSourceAnchor
    optional  TComment, TMetrics
```

The rule your output must satisfy is `required ⊆ traits ⊆ required ∪ optional`
for every entity. A profile is data, so a language nobody has implemented can
still be specified — and if the one you need is missing or wrong, that is a
change to core's profile table, not to your extractor.

## 2. Emit the five record types, in order

One JSON object per line, UTF-8, LF-terminated, record type in the leading `t`
key. The section order is contractual so a reader is single-pass and never
rewinds:

```text
header → f* → e* → x* → eof
```

- exactly one `header`, and it is the first line;
- `f` records next, `i` ascending from 0 with no gaps;
- `e` records next, `i` ascending from 0 with no gaps — `i` **is** the entity's
  surrogate;
- `x` records next, in canonical order;
- exactly one `eof`, and it is the last line.

A record of an earlier section appearing after a later one is an error, not
something to tolerate. Blank lines are ignored.

### `header`

Required: `t`, `schemaVersion`, `lang`, `extractor`, `root`, `dict`.
`extractor` requires `name` and `version`. `dict` requires all four
dictionaries: `kinds`, `traits`, `edges`, `provenance`. `repository` is optional
and, when present, requires `remote`, `commit` and `root`.

The dictionaries are how closed vocabularies are interned: `k` indexes
`dict.kinds` on an entity and `dict.edges` on an edge, `tr` indexes
`dict.traits`, `p` indexes `dict.provenance`. **Indices are model-declared** — you
list the members your model uses, in your own order — so extending core's
vocabulary never renumbers an existing file. An index the header does not declare
is an error.

`dict.traits`, `dict.edges` and `dict.provenance` are closed enumerations in the
schema; `dict.kinds` is open, because kinds vary by language.

### `f`

Required: `t`, `i`, `path`. One interned file path per line, so no line grows
with corpus size. Sorted by path.

### `e`

Required: `t`, `i`, `k`, `tr`, `m`, `s`. Optional per trait: `d`, `name`,
`anchor`, `comments`, `parent`, `attachedTo`, `definedIn`, `isStub`,
`declaredType`, `signature`, `parameters`, `localVariables`, `metrics`, `value`,
`space`.

`(m, s, d)` is the natural key, with `lang` from the header: `m` is the surrogate
of the entity's **module**, `s` its own path below that module, `d` an optional
disambiguator. **A module names itself** — its `m` is its own `i`, and its `s`
carries the full module path. No rendered id string appears anywhere in the file.
No two entity records may share `(m, s, d)`.

An entity record carries **exactly** the keys its declared traits contribute:
present when the trait is declared, absent when it is not. This is the one rule
the per-record schemas cannot state, because deciding it means resolving `tr`
through the header — check it yourself against the dictionary you wrote.
`TWithChildren` contributes no key at all: `children` is the exact inverse of
`parent`, and inverse indexes are derived by the consumer, never serialized.

A key no trait contributes is passed through untouched, so you may annotate your
output without breaking conformance.

### `x`

Required: `t`, `k`, `f`, `o`, `p`, `anchor`. Optional: `candidates`,
`sourceFile`, `isRead`, `isWrite`, `arguments`.

Outgoing direction only. `f` and `o` are entity surrogates, `k` and `p` index the
header's edge-kind and provenance dictionaries. Provenance and anchor are
required on every edge: a dependency claim with no evidence, or of unknown
fact/inference status, is not representable.

### `eof`

Required: `t`, `counts`, and `counts` requires `files`, `entities` and `edges`.
That trailer is how a truncated or killed run is caught — a reader whose tallies
disagree must reject the file.

## 3. Use surrogates for every reference

Every reference to an entity is the integer `i` of its record: `parent`,
`attachedTo`, `declaredType`, `parameters`, `localVariables`, `f`, `o`,
`candidates`. Paths are interned the same way — `anchor` is
`[fileRef, startLine, endLine]`, `definedIn` is an array of file references, and
an edge's `sourceFile` is one. Line numbers are 1-based and
`startLine ≤ endLine`; the schema's minimum for both line fields is `1`, so a
span starting at 0 is rejected.

{{< callout type="warning" >}}
Surrogates are **file-scoped and are not identity**. They are assigned by
canonical order, so they change whenever the model changes. Never store one
outside the file that assigned it and never compare one across files — joining
two models is done on natural keys.
{{< /callout >}}

This is also what makes a dangling reference *unwritable* rather than merely
reportable: an external entity is a stub, which is a declared entity like any
other, and a reference to something no record declares has no surrogate to name
it with. If you cannot close a reference, drop it and say so.

## 4. Sort canonically, then assign surrogates

Entities are sorted by natural key — `lang`, then `module`, then `symbol`, then
`disambiguator` with the absent one first — comparing by UTF-16 code unit. **That
order is the surrogate assignment.** Edges follow, sorted by `f`, then `o`, then
edge kind, then anchor (file, start, end), then provenance. File records are
sorted by path; dictionary entries are sorted.

The consequence is why all of it is contractual: two runs of one extractor over
one unchanged corpus produce **byte-identical files**. Snapshot diffs and
extractor cross-validation are meaningful only if that holds.

## 5. Decide membership by a whitelist

Everything the corpus does not declare is a stub: a degraded entity with
`isStub: true` whose edges are kept. Membership is decided by a whitelist of the
ids your corpus declares — **never** by a package or name prefix. A resolver
working without a build invents plausible fully-qualified names, and a prefix
test launders those inventions into facts.

## 6. Self-validate, then pass the gate

The self-check is five steps, and steps 1 and 3–5 need nothing but the
`schemas/` directory:

1. validate every line against the schema for its `t`;
2. check the sequence: section order, dense `i`, one header, one `eof`;
3. resolve `k`, `tr` and `p` against the header dictionaries;
4. check trait keys using the dictionary you just resolved;
5. check integrity — closure (`0 ≤ ref < eof.counts.entities`), no
   self-reference (`f ≠ o`), provenance and anchor on every edge, counts — and
   canonical order.

Then run the gate:

```bash
codegraph validate model.jsonl
```

```text
OK — every model conforms: closure, no self-reference, provenance, candidates, profile, anchors, ids.
```

It exits `3` with findings named by rule — `closure`, `self-reference`,
`provenance`, `candidates`, `profile`, `anchor`, `duplicate-id` — because an
extractor author fixes a *rule*, not a list of unrelated messages. `--json` gives
the same report as an object with `counts.byRule`.

Passing `validate` on your corpus, plus the property suite, is the acceptance
bar. Where two extractors cover one language, the richer one is the oracle and
the other's edge set must be a subset of it; a gap is a missed resolution case,
not noise.

## Related

- [`model.jsonl` reference](/docs/reference/model-jsonl/)
- [Language profiles reference](/docs/reference/profiles/)
- [`codegraph validate`](/docs/reference/cli/validate/)
- [Why JSONL](/docs/explanation/why-jsonl/)
- [Identity is a natural key](/docs/explanation/identity/)
