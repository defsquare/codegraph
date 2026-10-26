---
title: vocabulary.json
weight: 7
---

The words a corpus's names are made of, counted per scope: the corpus, each module, each type. Written by [`vocabulary --out`](/docs/reference/cli/vocabulary/). The committed `fixtures/<lang>/expected/vocabulary.json` are its pretty form, one term and one scope per line, rebuilt byte for byte by the tests.

**Words come from names, never from source.** A name is split by the universal word boundaries and its language's lexicon (the conventional names, file kinds, qualified kinds and interface marker [`profiles`](/docs/reference/cli/profiles/) prints). Each word is classed, never filtered, and weighted by the role of what carries it.

**Rows are array indexes.** A term is its position in `terms`, a scope's parent its position in `scopes`. A scope carries its entity's id, opaque, so a city building or a navigator node finds its words.

Field names are those of `VocabularyArtifact` in `packages/vocabulary/src/artifact.ts`.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | always `codegraph.vocabulary/1` |
| `generatedBy` | string | always `@codegraph/vocabulary` |
| `view` | `ViewDescriptor` | `{name, filters}` |
| `corpus` | `{name, roots}` | |
| `langs` | string[] | the languages of the union |
| `weights` | object | the weight of each role and of `qualifier`, as counted: `module`, `type`, `operation`, `attribute`, `parameter`, `local`, `other`, `qualifier` |
| `classes` | string[] | `domain`, `technical`, `keyword`, `short`, in that order |
| `technical` | `{words, sha256}` | the shared technical list's size and a sha256 over its sorted words joined by `\n`; each language's own words apply on top |
| `terms` | `Term[]` | sorted by text in UTF-16 code-unit order, then class |
| `scopes` | `Scope[]` | the corpus first, then modules, then types, each level in id order |
| `diagnostics` | `{unplaced, withoutLexicon}` | kept entities no module contains (counted in the corpus alone), and languages core has no lexicon for (split by the universal rules alone); both sorted |

## `terms[]` — `Term`

One word in one class. A word two languages class differently (Go reserves `type`, Java does not) is two terms.

| Field | Type | Meaning |
|---|---|---|
| `text` | string | lowercased |
| `class` | `"domain"` \| `"technical"` \| `"keyword"` \| `"short"` | `keyword`: the language reserves it; `short`: one letter or digit; `technical`: the shared list or the language's own; else `domain` |
| `modules`, `types` | number | how many module scopes, and how many type scopes, say it |
| `exclusive` | number | the one module scope that says it, when exactly one does |

## `scopes[]` — `Scope`

A type's words are those of everything that folds into it (`containingType`), a module's likewise, the corpus's every kept entity's. A nested type is its own scope. A stub never speaks.

| Field | Type | Meaning |
|---|---|---|
| `level` | `"corpus"` \| `"module"` \| `"type"` | |
| `id` | string | the entity id; absent on the corpus |
| `name`, `kind` | string | the entity's name and kind; the corpus has its display name and no kind |
| `parent` | number | the nearest scope up the containment chain, else the corpus; absent on the corpus |
| `entities` | number | kept entities here; each is unnamed, conventional or counted in `roles` |
| `roles` | object | the entities that said words, by role |
| `skipped` | `{unnamed, conventional, numeric}` | names with no word: an unnamed entity, a name the language dictates (`toString`), and pieces of digits only, dropped |
| `distinct`, `distinctDomain` | number | terms in the table, and the `domain` ones among them: the cognitive-load proxy |
| `weight`, `occurrences` | number | sums over the table |
| `terms` | `[term, weight, occurrences, carriers][]` | by weight descending, then term; `carriers` counts distinct entities, so a name saying a word twice is two occurrences and one carrier |

## Weights

| Role | Weight | Carried by |
|---|---|---|
| `module`, `type` | 8 | an entity with `TModule` or `TType` |
| `attribute` | 4 | a `TStructural` no entity lists as a parameter or local |
| `operation` | 3 | `TInvocable` |
| `parameter`, `local` | 1 | a `TStructural` listed in some entity's `parameters` or `localVariables` |
| `other` | 1 | a named entity no role trait describes |
| `qualifier` | 1 | not a role: the words before the last separator of a qualified name (`com.acme` of `com.acme.order`), whatever carries it |

Roles come from traits, never from the kind. `--weights` overrides them, and the artifact records the weights it was counted with.
