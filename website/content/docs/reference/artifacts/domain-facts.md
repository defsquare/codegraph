---
title: domain-facts.json
weight: 4
---

One dossier per corpus type, with every fact the model holds about it pre-joined: annotations with their written arguments, fields joined to their declared types, operations with their invocations, accesses and throw sites. Written by [`domain-facts`](/docs/reference/cli/domain-facts/).

No dossier is emitted for a stub type. Field names are those of `DomainFacts` in `packages/analyzer/src/domain-facts.ts`.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | always `codegraph.domainFacts/1` |
| `generatedBy` | string | always `@codegraph/analyzer` |
| `view` | `ViewDescriptor` | `{name, filters}` |
| `langs` | string[] | distinct `lang` values in the union, sorted |
| `framework` | string | the framework profile applied, when one was |
| `modules` | `ModuleFact[]` | sorted by id |
| `types` | `TypeDossier[]` | sorted by id |
| `diagnostics` | object | `types`, `operations`, `invocations`, `accesses`, `throwSites`, and `wiring` when a framework was applied |

## `modules[]` — `ModuleFact`

| Field | Type | Meaning |
|---|---|---|
| `id` | EntityId | |
| `name` | string | |
| `types` | EntityId[] | the dossier types this module contains, sorted |
| `imports` | `ModuleImportFact[]` | `{to, name?, count, external}` — `count` is the base import edges folded into this one |

## `types[]` — `TypeDossier`

| Field | Type | Meaning |
|---|---|---|
| `id` | EntityId | |
| `kind` | string | |
| `name` | string | |
| `module` | EntityId | the containing module |
| `anchor` | `{file, span}` | |
| `loc` | number | gross span length, derived from the anchor |
| `stereotype` | string | the framework's own word for what the type is FOR, when a profile said so |
| `annotations` | `AnnotationFact[]` | |
| `supertypes` | `SupertypeFact[]` | |
| `metrics` | `Record<string, number>` | the extractor's measures, unmodified; absent means "not measured" |
| `fields` | `FieldFact[]` | |
| `operations` | `OperationFact[]` | |
| `injectionPoints` | `InjectionPoint[]` | where the container hands dependencies in, with the corpus candidates |

### `AnnotationFact`

| Field | Meaning |
|---|---|
| `annotation` | the annotation type — normally a stub, its jar being absent |
| `name` | its simple name, when the model carries one |
| `module` | the declaring module's name — what a framework table matches on |
| `arguments` | `NamedArgument[]`, the written values |
| `anchor` | |

### `SupertypeFact`

`{to, name?, relation, external, provenance}` — `relation` is `"inheritance"` or `"interfaceImplementation"`.

### `FieldFact`

| Field | Meaning |
|---|---|
| `id`, `kind`, `name` | |
| `declaredType`, `declaredTypeName` | |
| `declaredTypeKind` | the declared type's profile kind (`enum`, `class`, …) — carried, not interpreted |
| `declaredTypeExternal` | |
| `annotations` | |
| `value` | the declaration-site constant (`Literal`), when the model carries one |
| `anchor` | |

### `OperationFact`

| Field | Meaning |
|---|---|
| `id`, `kind`, `name`, `signature`, `anchor` | |
| `loc` | gross span length |
| `entryPoint` | a framework entry-point annotation sits on it (nothing in the corpus calls it) |
| `annotations` | |
| `metrics` | the extractor's measures; absent means "not measured" |
| `invocations` | `InvocationFact[]` — includes facts from nested lambdas and blocks, anchored where they occurred |
| `accesses` | `AccessFact[]` |
| `throws` | `ThrowFact[]` |

`InvocationFact`: `{to, targetType?, targetTypeName?, targetStereotype?, external, provenance, anchor}`.
`AccessFact`: `{to, field?, ownerType?, ownerTypeName?, isRead, isWrite, external, provenance, anchor}`.
`ThrowFact`: `{to, name?, external, provenance, anchor}`.

### `InjectionPoint`

Present only with `--framework`. An inference, labelled as one.

| Field | Meaning |
|---|---|
| `id` | the attribute or parameter the container fills |
| `consumer` | the stereotyped type it belongs to |
| `declaredType` | the declared type asked for; absent when the model does not say |
| `via` | `"annotation"` or `"sole-constructor"` — how the point was recognized |
| `qualifier` | `@Qualifier("x")` / `@Named("x")`, when one narrows this point |
| `candidates` | corpus implementations the container could supply, sorted; possibly empty |
| `note` | why the candidate set is empty or narrowed — stated, never silent |

## Excerpt

`codegraph domain-facts fixtures/java/expected/model.jsonl` — 19 type dossiers, 58 operations — trimmed:

```json
{
  "kind": "codegraph.domainFacts/1",
  "generatedBy": "@codegraph/analyzer",
  "view": { "name": "all", "filters": [] },
  "langs": ["java"],
  "modules": [
    { "id": "java:com.acme.order", "name": "com.acme.order",
      "types": ["java:com.acme.order/AbstractOrder", "java:com.acme.order/Audited"],
      "imports": [
        { "to": "java:com.megacorp.ledger", "name": "com.megacorp.ledger", "count": 2, "external": true },
        { "to": "java:java.lang.annotation", "name": "java.lang.annotation", "count": 2, "external": true }
      ] }
  ],
  "types": [
    { "id": "java:com.acme.order.adapter/LedgerAdapter", "kind": "class", "name": "LedgerAdapter",
      "supertypes": [
        { "to": "java:com.megacorp.ledger/LedgerClient", "name": "LedgerClient",
          "relation": "inheritance", "external": true, "provenance": "declared" }
      ],
      "fields": [
        { "id": "java:com.acme.order/Order.MAX_LINES", "kind": "attribute", "name": "MAX_LINES",
          "annotations": [], "value": { "k": "number", "v": "100" },
          "anchor": { "file": "com/acme/order/Order.java", "span": [9, 9] } }
      ],
      "operations": [
        { "id": "java:com.acme.order.adapter/LedgerAdapter.post(java.lang.Object)",
          "kind": "method", "name": "post", "signature": "post(java.lang.Object)",
          "anchor": { "file": "com/acme/order/adapter/LedgerAdapter.java", "span": [11, 14] },
          "loc": 4, "entryPoint": false,
          "annotations": [
            { "annotation": "java:java.lang/Override", "name": "Override", "module": "java.lang",
              "arguments": [],
              "anchor": { "file": "com/acme/order/adapter/LedgerAdapter.java", "span": [10, 10] } }
          ],
          "metrics": { "cyclomatic": 1, "sloc": 4 },
          "invocations": [
            { "to": "java:com.acme.order.adapter/AuditTrail",
              "targetType": "java:com.acme.order.adapter/AuditTrail", "targetTypeName": "AuditTrail",
              "external": true, "provenance": "declared",
              "anchor": { "file": "com/acme/order/adapter/LedgerAdapter.java", "span": [12, 12] } }
          ],
          "accesses": [
            { "to": "java:com.acme.order.adapter/LedgerAdapter.trail", "field": "trail",
              "ownerType": "java:com.acme.order.adapter/LedgerAdapter", "ownerTypeName": "LedgerAdapter",
              "isRead": true, "isWrite": false, "external": false, "provenance": "declared",
              "anchor": { "file": "com/acme/order/adapter/LedgerAdapter.java", "span": [12, 12] } }
          ],
          "throws": [] }
      ],
      "injectionPoints": [] }
  ],
  "diagnostics": { "types": 19, "operations": 58, "invocations": 48, "accesses": 33, "throwSites": 2 }
}
```

An annotation with a written argument, from the same run:

```json
{ "annotation": "java:java.lang.annotation/Retention", "name": "Retention",
  "module": "java.lang.annotation",
  "arguments": [
    { "name": "value",
      "value": { "k": "enum", "type": "java:java.lang.annotation/RetentionPolicy", "name": "RUNTIME" } }
  ],
  "anchor": { "file": "com/acme/order/Audited.java", "span": [7, 7] } }
```

Deterministic: two runs over one model are byte-identical.
