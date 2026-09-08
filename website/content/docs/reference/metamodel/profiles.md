---
title: Profiles
weight: 5
---

A profile is **data, not code**: the contract stating what a given language's extractor may produce. A profile must be *specifiable without being implemented*.

| Attribute | Type | Meaning |
|---|---|---|
| `lang` | string | language id, matches the EntityId prefix |
| `kinds` | `Record<kind, {required: TraitName[], optional: TraitName[]}>` | the licit trait compositions per entity kind |
| `edges` | EdgeKind[] | edge kinds this language can emit |
| `notes` | string[] | documented static-analysis blind spots (reflection, `Class.forName`, dynamic `require`, macros pre-expansion, …) |

The nine shipped profiles are rendered in full on [Language profiles](/docs/reference/profiles/).

## Validation

Validation of an entity against its profile:

1. `kind` exists in the profile;
2. `required(kind) ⊆ entity.traits ⊆ required(kind) ∪ optional(kind)` — strict equality rejected (too brittle for `TComment`), free subset rejected (hides extractor bugs);
3. each declared trait's attributes are present and well-typed.

**Relations:** licenses entities and edges; cross-language analyses operate on the **intersection** of the profiles involved — in practice the `import` layer plus whatever both profiles share.

## Vocabularies are closed referential sets

Kinds, trait names, edge kinds and provenance values are **finite sets owned by core**. An encoding may represent a member **by reference** — an index into a dictionary, a foreign key — as long as the reference resolves to a canonical name that core validates. An unknown name is a hard error, never a passthrough. This is what licenses the header dictionaries of the [`model.jsonl`](/docs/reference/model-jsonl/) encoding and the lookup tables of the [`model.db`](/docs/reference/model-db/) store.

## Validity is a function of `(kind, trait set)`

The rule above reads only the kind and the *set* of traits — never the entity carrying them. So a consumer may decide each distinct `(kind, trait set)` pair **once** and share the verdict across every entity with that composition. Step 3 — the trait-key check — still runs per entity, because the keys' *values* differ.

Two bounds on that licence: a [stub](/docs/reference/metamodel/stubs/)'s exemption from the lower bound is an entity-level fact, so it is part of what the verdict is keyed on; and the verdict is per profile, since two profiles may name the same kind under different rules. It is a reader-side optimisation and requires no encoding support.

## Framework profiles

The same rule one level up, consumed by the analyzer rather than the extractor. What an annotation *means* — `@Autowired` marks an injection point, `@Service` a stereotype, `@Qualifier` narrows candidates, `@Primary` wins a tie — is a declarative table mapping annotation identity (simple name plus declaring module) to a role. It lives in the analyzer: the extractor stays framework-blind, and the wiring a framework profile licenses is derived in memory, never serialized.

Matching reads the referenced entity's `name` and parent chain — never a parsed id — and tolerates the target being a stub, which is the normal case for a corpus whose framework jars are absent. Injection points and roles are selected on `annotationUse` edges, and qualifier narrowing reads their `arguments`.

A framework RULE that is not an annotation is data too: Spring 4.3+ treats the sole constructor of a bean as an injection point with nothing written on it, so the profile carries that as a flag. A meta-annotated stereotype is deliberately NOT followed: resolving `@MyService` to the `@Service` it carries needs the annotation type's own declaration, which is exactly what a stub does not have — so such a type is unclassified rather than classified by a guess.

`--framework spring` is accepted by [`analyze`](/docs/reference/cli/analyze/), [`city`](/docs/reference/cli/city/), [`domain-facts`](/docs/reference/cli/domain-facts/) and [`explain`](/docs/reference/cli/explain/).
