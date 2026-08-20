# Model v2 — metamodel changes (format-independent)

Status: **accepted 2026-08-20 — shipped as M5 (PLAN.md §9.1)**. Companion doc:
[`model-encoding.md`](model-encoding.md) — the physical file formats.
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

- `module` is a reference to the containing module entity. **Amended when
  implemented (M5): a module's own key names ITSELF here, with an empty
  `symbol`** — not its parent. The parent form renders `java:com.acme.order`
  as `java:com.acme/order`, breaking the frozen id scheme, and would need a
  fabricated `java` module to place the stub package `java:java.util`, whose
  parent no corpus declares (METAMODEL §6). In M6 a package record's `m`
  surrogate therefore points at its own row.
- `symbol` is the path below the module — dots for nesting, existing lambda
  markers unchanged.
- `disambiguator` is optional; for Java invocables it is the erased-FQN
  parameter list. The M2 collision rule (erased FQNs, not simple names)
  carries over verbatim.
- Uniqueness: no two entities in a model share `(module, symbol, disambiguator)`.
- **Added in M5**: `/` and `#` are reserved in the components (`module` may
  contain neither, `symbol` may not contain `#`, a present `disambiguator` is
  non-empty) so that rendering is *injective*. Without that, two distinct keys
  can render as one id and one entity silently absorbs the other; `renderId`
  validates and throws rather than emitting a lossy id.
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
- **§8b Encodings** — points at `docs/model-encoding.md`. A file conforms
  to the metamodel iff its decoded content satisfies §8a; several encodings
  may conform simultaneously.

Canonical order belongs to the *model* (it is what makes extractor
cross-validation and snapshot diffs meaningful), even though each encoding
decides how order manifests physically.

## Task list (metamodel track)

- [x] METAMODEL.md: restate identity as the natural key (MM-1, §1.1), extend the
      outgoing-only rule to name `parent`/`children` (MM-2, §4), add MM-3/MM-4
      as §5.1/§5.2, split §8 into 8a/8b (MM-5). CLAUDE.md invariants 4 and 7
      restated to match.
- [x] `core`: natural-key type + `renderId` (`packages/core/src/identity.ts`),
      canonical order, uniqueness helper, memoized profile verdicts.
- [x] `core`: uniqueness restated over the structured key
      (`duplicateNaturalKeys`), with rendering injectivity as the bridge that
      makes v1's rendered-id uniqueness a *consequence* of it.
- [x] Property suite: natural-key uniqueness, injectivity, and canonical order
      as a total order, generatively (`packages/core/test/properties.test.ts`).
- [x] PLAN.md §9.1/§11/§12: decisions recorded.

Deferred to M6 with the rest of the breaking change (PLAN.md §9.2), since M5 is
non-breaking preparation: **removing the `children` key from `Entity`** — the
trait declaration stays either way — and reformulating closure / determinism /
self-reference over surrogates, which do not exist until the JSONL encoding does.
