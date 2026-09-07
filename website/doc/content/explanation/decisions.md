---
title: The decision log
linkTitle: Decisions
weight: 12
---

Most of this section argues one decision at a time, at length. This page is the
other view: every locked decision in one table, with the reason beside it, in the
order the project made them. It is the project's engineering journal, transcribed
— which means it reads like a changelog of arguments rather than like prose, and
that is deliberate. When you want to know *why* something is the way it is and
the long-form page has not answered it, the answer is probably a row here.

Two things are worth knowing before reading it. First, most of the interesting
rows record a decision made **after** something failed on a real corpus: a
559 MB model that Node could not open, a folded graph that overflowed the call
stack, two overloads that collapsed into one id, an inverse index that cost
twelve megabytes to serialize for no reason. Where a rationale sounds oddly
specific, that is why. Second, a decision that was later reversed is not deleted
— the rows about the JSON interchange and the JSONL interchange both stand,
because knowing that the first shape was tried and where it broke is part of the
argument for the second. Nothing here is a plan; everything is a thing that was
settled, usually the hard way.

| Topic | Decision | Rationale |
|---|---|---|
| Schema lib | Zod v4 (not Malli) | types + runtime validation + JSON Schema export from one source |
| Interchange | JSON (not EDN), `schemaVersion`-ed | TS-native; JSON Schema is the polyglot contract |
| Traits/profile equality  | `required ⊆ traits ⊆ required ∪ optional` | strict equality breaks on TComment; free subset hides extractor bugs |
| Marker traits | `TWithInvocations` etc. contribute no keys | edge lists live in `edges[]`, not on entities — keeps entities flat and avoids duplication |
| Java extractor language | Java (Maven) subproject, JSON out | Spoon is a JVM lib; the TS side stays extractor-agnostic |
| Lang ids (M1 review) | frozen as declared, abbreviations kept (`clj`/`js`/`ts`) | the lang id is the EntityId prefix — renaming one invalidates every id an extractor has emitted |
| Stub containment (M3 review) | a stub type carries `TChildOf` → its stub **module**; never a corpus one, and never for primitives or in-corpus phantoms | the analyzer folds to module level by walking `parent` and may not parse ids; the alternative — a stub being its own container at every level — put classes and primitives into module graphs (88% of gson's module nodes were not modules) |
| Profile `space` (M1 audit) | `space?` declared per kind on the Profile, not only on the Entity | the metamodel's "only meaningful in profiles that declare it" is otherwise unenforceable |
| Trait keys in the published schema (M1 audit) | re-stated as `if/then` conditionals generated from `TRAITS` | Zod refinements do not survive `z.toJSONSchema()`; without them the contract accepted `{traits:["TNamed"]}` with no `name` |
| Identity v2 (fineract audit) | structured key `(lang, module, symbol, disambiguator?)`; rendered id strings are display-only, never stored or compared | 559MB model.json broke Node's 512MB string ceiling; ≈76% of the bytes were repeated id/path strings |
| Interchange v2 | JSONL: surrogate ints for all intra-model refs, header dictionaries for closed vocabularies, file-path table, `eof` count trailer; in-place clean break, `schemaVersion` kept at 1.0.0, no old-format reader | streaming in both directions kills the ceiling; ~6× smaller; extractor bar stays "anything that prints JSON lines"; the format is internal-only — bumping a version nobody consumes buys nothing |
| `children` serialization (v2) | dropped — derived from `parent` like every other inverse index | the outgoing-only rule already forbade serialized inverses; v1 carrying it was an inherited inconsistency (and 12MB on fineract) |
| Closure (M6) | enforced by the ENCODING: a reference is a surrogate, so a dangling one is unwritable and unreadable | the check moves from "report it afterwards" to "it cannot exist"; the extractor drops and counts what it cannot close |
| Executable containment (M6) | `method`/`constructor`/`lambda` declare `TWithChildren` | their parameters and locals already carried `parent`; only one direction was licensed, so the model stated a containment its own profile forbade |
| Sync chunked reader (M6) | `readModelFileSync` reads 1MB at a time rather than making the CLI async | the ceiling is one JavaScript string, not synchronous I/O — going async would change every command signature and fix nothing |
| SQLite (v2) | `model.db` is a derived, disposable analyzer cache built by `codegraph import` — never the contract, never committed | queryable/incremental/random access for CLI + future viz without sacrificing diffable fixtures, byte-determinism, or the any-language extractor bar |
| Key separators (M5) | `/` and `#` reserved in the key's components; `renderId` validates and throws | rendering must be injective, or two distinct keys merge into one entity with no error — the overload collision of the id scheme, one level up |
| Module component (M5) | a module names ITSELF, with an empty symbol — not its parent module | the parent form breaks the frozen `java:com.acme.order` id shape and needs a fabricated `java` module to place the stub package `java:java.util` |
| Trait-set interning (v2) | rejected — traits ride inline as int arrays; MM-4's validate-once-per-set is reader-side memoization | set indirection saved ~4MB on a ~90MB file but cost a record type, a dedup pass in every extractor, and lines unreadable in isolation |
| Evolution facts (Phase 8) | separate `history.jsonl` joined on `anchor.file` paths — never merged into `model.jsonl`, no fifth provenance value | repo-scoped facts with a per-commit lifecycle don't belong in a language-scoped structural contract; the provenance set keeps code facts and history inferences unmixable |
| Lineage over time (Phase 8) | natural-key equality across snapshots; a rename is a death + a birth; anonymous entities untracked | identity as a natural key makes temporal identity free for named entities; rename matching is heuristic machinery, deferred until a corpus proves it necessary |
| Replay layout (Phase 8) | one layout over the union of all keys that ever existed, plots frozen; buildings animate in place | shelf packing is chaotic — one insertion reshuffles the city; a readable replay needs positional stability more than land density |
| Snapshot strategy (Phase 8) | sampled keyframes via `git worktree`; per-commit incremental extraction deferred | full extraction × thousands of commits is prohibitive, 50–200 frames give the replay effect; noClasspath makes non-compiling historic commits extractable |
| Repository provenance (Phase 9) | facts in the header — `remote` (normalized https), `commit` (sha), repo-relative `root`; host URL templates derived by consumers, `provider` only when the hostname lies | a serialized URL freezes one host's scheme into the interchange; a sha is a permalink where a branch moves; anchors are relative to the analyzed root, which sits below the repo root (gson) — without the prefix no anchor projects back |
| Measures (Phase 9) | `TMetrics` open numeric map; canonical key names documented in the metamodel reference, values validated finite, keys deliberately NOT a closed MM-3 vocabulary | measures are the extractor-innovation surface — a closed set gates every new measure on a core release; loose top-level keys stay legal (container contract) but uncontractual, and only a trait makes `sloc`/`cyclomatic` comparable across extractors |
| Measure storage (M10b) | `entity_metric(entity_id, key, value)` rows in `model.db`, not a JSON column; the wire writes the map key-sorted, so reading back `ORDER BY key` restores it | the store exists to be QUERIED and a measure is precisely what one aggregates ("cyclomatic by package"); a blob would make the one thing measures are for a full-table JSON scan |
| DI wiring (Phase 9) | derived by the analyzer from declared facts + a framework data table; `dynamic-candidate` provenance, in-memory only, matched by entity name — never id parsing | the extractor stays framework-blind; the candidate set needs whole-corpus implementor knowledge only the analyzer holds; Spring dispatch is the `dynamic-candidate` definition verbatim |
| Literal values (Phase 9) | tagged-union `Literal`: numbers as canonical decimal text, enum values as type id + simple name, unfoldable constant expressions kept as `unevaluated` source text; ids inside values obey closure | a JSON number loses a Java `long`; a fabricated enum-member stub is the one thing the stub discipline forbids; dropping an unfoldable expression erases a written fact — degraded honesty over silent loss, the stub discipline applied to values |
| Annotation usage (Phase 9) | dedicated `annotationUse` edge kind carrying `arguments`, replacing the plain `reference` — in-place clean break, fixtures regenerated | overloading `reference` would make `arguments` meaningful on one disguised subset of a kind; consumers cannot select annotation usages today without guessing from the target's kind, which a stub target cannot answer |

## Where this shows up

Almost every row is argued at length somewhere in this section:

- Schema library, marker traits, profile equality, `space`, trait keys —
  [why traits](/explanation/why-traits/) and
  [reference: profiles](/reference/metamodel/profiles/).
- Identity, key separators, the module component, lineage over time —
  [identity is a key](/explanation/identity/).
- The interchange, `children`, closure, the chunked reader, trait-set interning,
  SQLite — [why the interchange is a line-based file](/explanation/why-jsonl/)
  and [reference: model.jsonl](/reference/model-jsonl/).
- Stub containment and the Java extractor —
  [extracting without compiling](/explanation/extracting-without-compiling/) and
  [reference: the Java extractor](/reference/java-extractor/).
- Evolution facts, replay layout, snapshot strategy —
  [time as structure](/explanation/time-as-structure/).
- Measures, literal values, annotation usage, DI wiring —
  [facts and inferences](/explanation/facts-vs-inferences/) and
  [reference: measures and literals](/reference/metamodel/measures-literals/).
