---
title: insights.jsonl
weight: 5
---

The side-car [`explain`](/docs/reference/cli/explain/) writes: one explanation record per operation, type and module, in the vocabulary of the Specy domain metamodel. It lives **beside** the model — `<model>.insights.jsonl` by default — and never inside it, so it can be regenerated, pointed at another model, or deleted without touching `model.jsonl` or `model.db`.

{{< callout type="info" >}}
This page is derived from the Zod schemas in `packages/insights/src/schema.ts` and the vocabularies in `packages/insights/src/ddd.ts`. Unlike the other artifact pages it carries no excerpt from a real run: producing one requires a model provider and an API key.
{{< /callout >}}

## File layout

```
header → i* → eof
```

Records are sorted by `(level, id)`, with `operation` before `type` before `module`, and are re-serialized through their Zod schema, so a record built in memory and one read back from disk are the same bytes. **The body carries no timestamp**; only the trailer does. Two runs with the same records are therefore diffable: what changed is what was re-explained.

During a run, finished records are appended one per line to `<out>.journal` and the sorted side-car is rewritten from base plus journal at each layer boundary, so an interrupted run resumes where it stopped. Reading a journal is lenient (its last line may be cut); reading the side-car proper is strict.

## `header`

| Field | Type | Meaning |
|---|---|---|
| `t` | `"header"` | |
| `kind` | `"codegraph.insights/1"` | |
| `generatedBy` | string | `@codegraph/insights` |
| `promptVersion` | string | bumped whenever the prompt or a block shape changes; every fingerprint includes it |
| `metamodel` | string | the vocabulary the blocks speak — `specy.domain/3` |
| `models` | `{leaf, rollup}` | the model slug used for operations, and for types and modules |
| `provider` | string | which client served the calls (`openrouter`, `cloudflare`); absent on files written before it was recorded |
| `depth` | integer ≥ 0 | how many levels of dependency explanations each prompt carried |
| `source` | `{paths, langs, view}` | the models explained, their languages, and the view |

## `i` — one insight record

| Field | Type | Meaning |
|---|---|---|
| `t` | `"i"` | |
| `id` | non-empty string | the rendered entity id — compared as an opaque token, never parsed |
| `key` | `{lang, module, symbol, disambiguator?}` | the natural key, carried so a re-extraction re-joins without parsing ids |
| `level` | `"operation"` \| `"type"` \| `"module"` | the discriminant; decides which block shape follows |
| `kind` | string | the entity kind |
| `name` | string | |
| `file` | string | the anchor file, root-relative |
| `scc` | string[] | present when the unit sits in a dependency cycle: every member, sorted, this id included |
| `origin` | `"llm"` \| `"template"` | |
| `block` | `OperationBlock` \| `TypeBlock` \| `ModuleBlock` | the explanation itself |
| `fingerprint` | 64-char hex | sha256 of everything the explanation was computed from |
| `model` | string | the model slug that answered |
| `usage` | `{promptTokens, completionTokens, cost?}` | |
| `metadata` | `Record<string, string>` | the metamodel convention's free key/value map |

## `eof`

| Field | Type | Meaning |
|---|---|---|
| `t` | `"eof"` | |
| `counts` | `{records, llm, template, reused, failed}` | all integers ≥ 0 |
| `usage` | `{promptTokens, completionTokens, cost?}` | the run's total |
| `generatedAt` | ISO-8601 string | the ONLY timestamp in the file |

## Blocks

Every block carries a `name` — the ubiquitous-language name the model proposes — a `description`, and a `confidence` number clamped to [0,1] on receipt.

### `OperationBlock`

| Field | Type |
|---|---|
| `name`, `description` | string |
| `safe` | boolean — read-only (no state mutation) or not |
| `idempotent` | boolean \| null |
| `owner` | one of `OPERATION_OWNERS` |
| `handlesCommand` | string \| null — the command this operation handles, when it is a command handler |
| `emits` | `{name, kind}[]` where `kind` is an `EVENT_KINDS` member |
| `preconditions` | `{name, predicate, violationReason}[]` |
| `postconditions` | `{name, predicate}[]` |
| `invariantsEnforced` | string[] |
| `usesSpi` | `{name, capability}[]` — external capabilities the operation needs, as SPIs |
| `domainTerms` | string[] |
| `confidence` | number |

### `TypeBlock`

| Field | Type |
|---|---|
| `name`, `description` | string |
| `concept` | one of `DOMAIN_CONCEPTS` |
| `eventKind` | `EVENT_KINDS` member \| null |
| `interfaceRole` | `INTERFACE_ROLES` member \| null |
| `aggregateRoot` | boolean \| null |
| `containedIn` | string \| null |
| `syncPattern` | `SYNC_PATTERNS` member \| null |
| `identity` | string \| null — the identity field, for entities |
| `fields` | `{name, type, kind}[]` where `kind` is a `FIELD_KINDS` member |
| `invariants` | `{name, predicate, enforcement}[]` where `enforcement` is an `ENFORCEMENTS` member |
| `stateMachine` | `{states, transitions: {from, to, operation}[]}` \| null |
| `relatesTo` | `{name, concept}[]` |
| `exposes` | string[] — operations that form this type's public surface |
| `dependsOn` | `{name, role}[]` — ports this type needs from others |
| `domainTerms` | string[] |
| `confidence` | number |

### `ModuleBlock`

| Field | Type |
|---|---|
| `name`, `description` | string |
| `apis` | `{name, operations: string[]}[]` |
| `spis` | `{name, capability}[]` |
| `dependsOn` | string[] |
| `concepts` | `{name, concept}[]` |
| `boundedContextHint` | `{name, rationale}` \| null |
| `sharedKernelHint` | string \| null — for a module in a dependency cycle: why the group is inseparable, or how to split it |
| `ubiquitousLanguage` | `{term, definition}[]` |
| `confidence` | number |

## Vocabularies

Closed enums, restated as literals in `ddd.ts` with the source cited.

| Vocabulary | Members |
|---|---|
| `DOMAIN_CONCEPTS` | `boundedContext`, `module`, `interface`, `operation`, `command`, `query`, `reaction`, `entity`, `readOnlyEntity`, `aggregate`, `stateMachine`, `repository`, `event`, `valueType`, `enum`, `domainService`, `applicationService`, `infrastructureService`, `invariant`, `precondition`, `postcondition`, `agreement`, `reconciliation`, `notDomain`, `unknown` |
| `EVENT_KINDS` | `internal`, `external`, `error`, `temporal` |
| `INTERFACE_ROLES` | `API`, `SPI` |
| `OPERATION_OWNERS` | `entity`, `aggregate`, `domainService`, `applicationService`, `infrastructureService`, `repository`, `valueType`, `unknown` |
| `ENFORCEMENTS` | `rejection`, `compensation`, `alert` |
| `SYNC_PATTERNS` | `synchronous-query`, `asynchronous-projection` |
| `FIELD_KINDS` | `primitive`, `valueType`, `entityReference`, `enum`, `collection`, `unknown` |

## Strict structured output

Providers' strict structured-output mode requires every property to be required and no additional properties, so "optional" is expressed as `.nullable()`, never `.optional()`, and no numeric or string constraints are emitted. `confidence` is clamped on receipt rather than constrained in the schema.

## Fingerprints

Every record carries a sha256 over what it was computed from: the prompt version, the model slug, the level, the source slices, the comments, the signatures, a digest of the facts shown, the **fingerprints of the units it depended on**, and the ids of dependencies that had no record. Merkle-style: change one leaf's source and exactly its transitive dependents and containers change.

The explanation text is deliberately **not** hashed — a non-deterministic answer must never cascade re-runs. A re-run plans `reuse` for every unit whose members' records match; `--force` overrides. Because a missing dependency is part of the fingerprint, a dependent explained while its callee had failed or was out of scope is redone once the callee exists.

## Templated records

A getter, setter, `equals`/`hashCode`/`toString`/`compareTo`, or a field-assigning constructor is described by a template with `origin: "template"`, `confidence` 1 and no model call — decided from facts only: no throw site, no corpus call, `cyclomatic ≤ 1`, and at most one field touched. Anything with a `throws` fact or a corpus call is never trivial, however short.
