# Model v2 — metamodel changes (format-independent)

Status: **accepted 2026-08-20 — planned as M5 (PLAN.md §9.1)**. Companion doc:
[`model-v2-encoding.md`](model-v2-encoding.md) — the physical file formats.
Everything in THIS doc must hold for *any* encoding (JSONL, SQLite, or a
future one); nothing in it mentions bytes, records, or tables.

## MM-1 Identity is a structured key, not an opaque string

Invariant 7 currently reads "Ids are opaque strings
(`lang:module/symbol#disambiguator`) — the analyzer compares them, never
parses them." Restate as:

> **Identity is the structured key `(lang, module, symbol, disambiguator?)`.**
> Consumers compare it component-wise and never parse a rendered string.
> A rendered id (`java:com.acme.order/OrderService.bill(...)`) is a
> display-only projection produced by `core`'s `renderId`, never stored,
> never compared.

- `module` is a reference to the containing module entity (packages form a
  tree; a module's own key references its parent module).
- `symbol` is the path below the module — dots for nesting, existing lambda
  markers unchanged.
- `disambiguator` is optional; for Java invocables it is the erased-FQN
  parameter list. The M2 collision rule (erased FQNs, not simple names)
  carries over verbatim.
- Uniqueness: no two entities in a model share `(module, symbol, disambiguator)`.
- Cross-model joins (multi-language analyses, stub-whitelist membership,
  snapshot comparison) operate on this tuple. Any encoding-level shorthand
  (integer surrogates, rowids) is **explicitly not identity** and never
  crosses a file boundary.

## MM-2 `children` leaves the interchange model

`children` is the exact inverse of `parent`. Invariant 4 already mandates
"outgoing edges only — inverse indexes are derived in memory, never
serialized"; v1 serializing `children` was an inherited inconsistency.

- `TWithChildren` remains a declared trait — invariant 5 (containment ≠
  attachment) is untouched; only the *serialized key* disappears.
- The analyzer derives the children index on load, exactly as it already
  derives incoming invocations, subtypes, and importers.
- Invariant 4 wording extends to name `parent`/`children` explicitly.

## MM-3 Vocabularies are closed, enumerable referential data

Kinds, trait names, edge kinds, and provenance values are finite sets owned
by `core` (this is already invariant "core owns the vocabulary" + "profiles
are data"). Formalize the consequence:

> Every vocabulary is a **closed referential set**: an encoding may represent
> members by reference (index, foreign key) as long as the reference resolves
> to a canonical name that `core` validates. Unknown names are a hard error.

This is what licenses dictionary/lookup-table encodings without each format
inventing its own vocabulary story.

## MM-4 Profile validity is a function of `(kind, trait set)`

Validation (`required ⊆ traits ⊆ required ∪ optional`) depends only on the
kind and the *set* of traits — not on the entity carrying them. Stated as a
metamodel fact, any consumer may validate each distinct `(kind, traitset)`
pair once and share the verdict across all entities carrying it. (Fineract:
a few dozen distinct pairs across 240,910 entities.) Trait-*key* presence
checks still run per entity — the keys' values differ per entity.

This licenses **reader-side memoization only** — a validator caches verdicts
keyed on `(kind, sorted trait list)`. It requires no encoding support: trait
sets are deliberately NOT a wire-level concept (see the encoding doc's
"considered and dropped" note).

## MM-5 Model vs. encoding separation (METAMODEL.md §8 rewrite)

§8 currently *is* the JSON file description. Split it:

- **§8a The model** — the logical content: header facts (schemaVersion, lang,
  extractor provenance, root), the entity set, the edge set, and the
  integrity properties (closure, `from !== to`, provenance set, profile
  validity, natural-key uniqueness, deterministic canonical order defined as
  sort by natural key).
- **§8b Encodings** — points at `docs/model-v2-encoding.md`. A file conforms
  to the metamodel iff its decoded content satisfies §8a; several encodings
  may conform simultaneously.

Canonical order belongs to the *model* (it is what makes extractor
cross-validation and snapshot diffs meaningful), even though each encoding
decides how order manifests physically.

## Task list (metamodel track)

- [ ] METAMODEL.md: restate invariant 7 (MM-1), extend invariant 4 (MM-2),
      add MM-3/MM-4 statements, split §8 (MM-5).
- [ ] `core`: natural-key type + `renderId`; remove `children` from `Entity`;
      keep `TWithChildren` trait declaration.
- [ ] `core`: uniqueness + closure properties restated over the structured key.
- [ ] Property suite: reformulate closure / determinism / self-reference over
      the new identity; add natural-key-uniqueness property.
- [ ] PLAN.md §11: record the decisions once confirmed.
