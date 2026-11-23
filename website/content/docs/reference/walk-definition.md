---
title: Walk definitions and selectors
linkTitle: Walk definitions
weight: 8
---

A walk definition is a JSON file of kind `codegraph.walk/1`: the question [`codegraph walk`](/docs/reference/cli/walk/) asks of the code, bottom-up — which units it asks, what it asks them, and the fields each answer must carry. It is data, like a [language profile](/docs/reference/profiles/): `codegraph walk --walk FILE` reads it, checks it, and compiles it before any model is read. The same file format, restricted, customizes [`codegraph explain`](/docs/reference/cli/explain/) (below).

This page is derived from `packages/insights/src/definition.ts` (the file format), `packages/insights/src/selection.ts` (what a selection means for the walk) and `packages/analyzer/src/selectors.ts` (the selector grammar). Every example on it is checked by `packages/cli/test/docs-walk-definitions.test.ts`, which parses each `codegraph.walk/1` block of the documentation through the same schema the command uses.

## A complete example

On the Java fixture: the two operations annotated `@Audited`, and the types above them.

```json
{
  "kind": "codegraph.walk/1",
  "name": "audit",
  "version": "1",
  "levels": ["operation", "type"],
  "select": { "edge": { "kind": "annotationUse", "to": { "name": "Audited" } } },
  "closure": "containers",
  "prompt": {
    "task": {
      "operation": "@Audited marks a method whose calls must reach the audit log. Say what a call of this operation would record, and whether anything in its source or its callees sends it to a log at all.",
      "type": "Say which of this type's operations are audited, and whether its state can change outside them."
    },
    "instructions": "Answer in English. Quote the annotation's value when it matters.",
    "entities": [
      { "select": { "name": "Reporting" }, "instructions": "Reporting runs monthly: say what max returns on an empty list." }
    ]
  },
  "answer": {
    "label": "logged",
    "fields": {
      "operation": { "logged": { "enum": ["yes", "no", "unclear"] }, "recorded": "string[]" },
      "type": { "unaudited": { "list": { "operation": "string", "why": "string" } } }
    }
  }
}
```

```console
$ codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --walk audit.json --dry-run
walk plan (audit): 77 units in 8 layers
  operation     57 units      2 calls ~1250 prompt tokens
  type          17 units      2 calls ~1792 prompt tokens
  module         3 units      0 calls ~0 prompt tokens
  statuses: llm 4, template 0, reuse 0, skip-scope 73, skip-budget 0
  selection: 13 dependencies of the selection are not walked (12 unselected, 1 trivial, skipped); without a record, shown as NOT EXPLAINED
  --closure all adds 24 units (operation 19, type 5, module 0)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 4 calls, ~3042 prompt tokens in, ~2240 completion tokens out
```

(The cache line and the per-unit lines are trimmed. The four `llm` units are `Reporting.max(List)`, `Order.discount(int)`, `Reporting` and `Order`.)

## Every key

Every key but `kind` is optional. Every object is strict: an unknown key, at any depth, is refused with its path and the valid keys.

| Key | Type | Default | Rules |
|---|---|---|---|
| `kind` | `"codegraph.walk/1"` | **required** | the only kind this build reads |
| `name` | string | `"adhoc"` | matches `[a-z][a-z0-9-]*`; `explain` and `insights` are reserved. The walk's store is `<model>.NAME.walk.db` |
| `version` | string | `"1"` | trimmed, not empty. Hashed into every unit's fingerprint: bump it to ask every unit again |
| `levels` | array of `operation`, `type`, `module` | all three | not empty, no level twice; a set (its order is not read) |
| `select` | a [selector](#selectors) | everything | which units are asked ([rule 1](#what-a-selection-means-for-the-walk)) |
| `exclude` | a [selector](#selectors) | nothing | which units are never asked; wins over `select` |
| `closure` | `none`, `dependencies`, `containers`, `all` | `none` | what the selection adds of what it leans on ([rule 4](#what-a-selection-means-for-the-walk)) |
| `trivial` | `skip`, `ask` | `skip` | whether a trivial member (a getter, a setter, `equals`/`hashCode`/`toString`/`compareTo`, a field-assigning constructor) is asked; skipped, it is shown to its dependents as NOT EXPLAINED |
| `context.depth` | integer ≥ 1 | `1` | how many levels of dependency answers a prompt carries (`--depth`) |
| `context.maxLines` | integer ≥ 1 | `200` | source lines shown per member before the middle is elided (`--max-lines`) |
| `context.source` | `true` | `true` | `false` is refused, "not supported yet": the engine always shows source |
| `prompt.task` | string, or `{ operation?, type?, module? }` of strings | a neutral task per level | a string is every level's task; a level the object leaves out keeps its default. Trimmed, not empty |
| `prompt.instructions` | string | `""` (none) | appended to every unit's system message, under `## Instructions` |
| `prompt.entities` | array of `{ select, instructions }` | `[]` | `select` is required, `instructions` not empty; kept in file order. Each closes the section of every member its selector selects by [rule 1](#what-a-selection-means-for-the-walk), under `Instructions for this member:` |
| `answer.label` | string | none | names a scalar or enum field declared at one level at least; a dependent is shown `label: value` beside the description |
| `answer.fields.operation`, `.type`, `.module` | `{ name: field type }` | `{}` | the [field grammar](#the-field-grammar); a level with no fields answers `answer`, `description`, `confidence` only |
| `answer.builtin` | string | none | refused in a walk file: the one built-in answer is explain's (`specy.domain/3`), which the grammar does not spell |

No task or instruction text may hold four backticks (the prompt's corpus fence), so an instruction can never open or close the fence that marks source as material. Three backticks are allowed.

A task or fields given for a level outside `levels` are kept, not refused: they say what that level would be asked, and `--levels` can then narrow a file without making it invalid or moving a fingerprint.

The smallest useful file names the walk and its task:

```json
{
  "kind": "codegraph.walk/1",
  "name": "state-changes",
  "prompt": { "task": "Say which state this code changes, and who can observe the change." }
}
```

`codegraph walk --print-definition` prints the default definition with every key spelled — a file to start from. On this build:

```json
{
  "kind": "codegraph.walk/1",
  "name": "adhoc",
  "version": "1",
  "levels": [
    "operation",
    "type",
    "module"
  ],
  "closure": "none",
  "trivial": "skip",
  "context": {
    "depth": 1,
    "maxLines": 200,
    "source": true
  },
  "prompt": {
    "task": {
      "operation": "Answer this walk's instructions about this operation, the general ones and any given for it in the prompt, from its source, its facts and what its callees are said to do. Where none applies, say what it does.",
      "type": "Answer this walk's instructions about this type, the general ones and any given for it in the prompt, from its source, its fields and what its members and the types it uses are said to do. Where none applies, say what it is for.",
      "module": "Answer this walk's instructions about this module, the general ones and any given for it in the prompt, from what its types are said to do and what it imports. Where none applies, say what it is about."
    },
    "instructions": "",
    "entities": []
  },
  "answer": {
    "fields": {
      "operation": {},
      "type": {},
      "module": {}
    }
  }
}
```

## The field grammar

Every block a walk writes is `answer`, then the declared fields **by name**, then `description` and `confidence`:

- `answer` is the response to the task, in full;
- `description` summarizes it in at most 60 words for a reader who sees only that line. **It is what flows upward**: the units that depend on this one are shown its `description` (and the label, if any), never the rest;
- `confidence` is the model's own claim, 0 to 1, clamped on receipt.

A field type is one of:

| Form | JSON |
|---|---|
| a string, a number, a boolean | `"string"`, `"number"`, `"boolean"` |
| a list of strings | `"string[]"` |
| one of fixed values, in this order | `{ "enum": ["low", "medium", "high"] }` |
| a list of objects | `{ "list": { "field": ITEM, … } }`, where ITEM is a scalar or an enum |
| any object form, nullable | add `"nullable": true` — so a nullable scalar is `{ "type": "string", "nullable": true }` |

The grammar is closed: a list does not nest and holds no `string[]`, an enum needs at least one value and no value twice, a list item needs one field at least. Field names match `[A-Za-z][A-Za-z0-9_]*`. `description`, `answer`, `confidence`, `words`, `glossary` and `concept` are refused as a block's field names (the first three are every block's own; `words`, `glossary` and `concept` are explain's, and the store indexes `concept` from every block); a list item may use them.

Every field is required in the answer — strict structured output allows nothing else — so "this may not apply" is spelled `nullable`, and the model answers `null`. Fields are ordered by name, so reordering them in the file moves nothing.

```json
{
  "kind": "codegraph.walk/1",
  "name": "error-handling",
  "levels": ["operation"],
  "prompt": { "task": "Say how this operation reports a failure to its caller." },
  "answer": {
    "label": "reports",
    "fields": {
      "operation": {
        "reports": { "enum": ["throws", "returns-null", "returns-flag", "logs", "silent"] },
        "exceptions": "string[]",
        "retried": "boolean",
        "branches": "number",
        "owner": { "type": "string", "nullable": true },
        "paths": { "list": { "condition": "string", "outcome": { "enum": ["caller", "swallowed"] }, "line": { "type": "number", "nullable": true } } }
      }
    }
  }
}
```

With `answer.label` set to `reports`, the prompt of a caller lists this operation as `- NAME [operation, reports: throws] (ID): DESCRIPTION`. A level that does not declare the label, or an answer whose label is `null` or empty, shows `[operation]` and the description alone.

## Selectors

A selector names entities. It has two spellings of one grammar: a **term** of text, which is what `--include` and `--exclude` take (one term per flag), and **JSON**, which is what a file's `select`, `exclude` and `prompt.entities[].select` hold, and which alone can compose.

| Term | JSON | Matches an entity when |
|---|---|---|
| `id:ID` | `{ "id": "ID" }` | it is that entity — the id verbatim, as the model renders it, compared as an opaque token |
| `kind:K` | `{ "kind": "K" }` | its kind is K (`class`, `method`, `package`, `module`…) |
| `trait:T` | `{ "trait": "T" }` | it declares the trait T (`TComment`, `TWithValue`…) |
| `lang:L` | `{ "lang": "L" }` | the model that declares it is of language L: a profile code, `java`, `csharp`, `ts`, `ex`, `rb` |
| `name:GLOB` | `{ "name": "GLOB" }` | its own name matches |
| `module:GLOB` | `{ "module": "GLOB" }` | the name of its containing module (a module is its own) matches |
| `file:GLOB` | `{ "file": "GLOB" }` | its anchor's file, relative to the model's root, matches |
| `edge:KIND` | `{ "edge": { "kind": "KIND" } }` | it writes an edge of that kind |
| `edge:KIND>TERM` | `{ "edge": { "kind": "KIND", "to": SELECTOR } }` | it writes an edge of that kind to an entity the nested selector matches |
| `edge-in:KIND` | `{ "edgeIn": { "kind": "KIND" } }` | an edge of that kind points at it (the analyzer's derived inverse, in memory) |
| `edge-in:KIND<TERM` | `{ "edgeIn": { "kind": "KIND", "from": SELECTOR } }` | an edge of that kind points at it from an entity the nested selector matches |
| — | `{ "all": [SELECTOR, …] }` | every one matches (`all: []` matches everything) |
| — | `{ "any": [SELECTOR, …] }` | one at least matches (`any: []` matches nothing) |
| — | `{ "not": SELECTOR }` | the selector does not match |

The vocabulary is core's. An unknown kind, trait, language or edge kind is an error that lists the valid names, never a silent empty match:

```text
$ codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --prompt "What does this do?" --include edge:calls --dry-run
codegraph: --include "edge:calls": unknown edge kind "calls"; valid: import, inheritance, interfaceImplementation, invocation, access, reference, embedding, traitUsage, fileInclude, annotationUse, throws
One selector term per flag, PREFIX:VALUE: id:ID, kind:K, trait:T, lang:L, name:GLOB, module:GLOB, file:GLOB, edge:KIND or edge:KIND>TERM, edge-in:KIND or edge-in:KIND<TERM. Repeat the flag for several (any of them).
```

`kind:` takes every kind some profile declares, since a term does not know its model's language when it is parsed.

**Text form.** A term is split at its first `:`. An `id:` or a glob runs verbatim to the end, so an id holding `:`, `/`, `#` or `<` needs no escape. `edge:` splits its value at the first `>`, `edge-in:` at the first `<`, and the rest is parsed as a whole term, so terms nest: `edge:invocation>edge:throws` is "calls something that throws". In a shell, quote a term that holds `>` or `<`.

**Globs.** `*` matches within one segment, `**` across segments (and, between separators, no segment at all, as a shell globstar does). A glob must match the whole string, case-sensitively, with no escape: `*` is always a wildcard, and an exact name is an `id:`. The segment separator of `file:` is `/`. That of `name:` and `module:` is the one the language profile states for the entity's kind — `.` for a Java package or a C# namespace, `/` for a TypeScript, Elixir or Ruby file module, `::` for a Ruby constant. So on Java, `module:com.acme.order*` does not reach a sub-package and `module:com.acme.order**` does. An unnamed entity (a constructor, a lambda) matches no `name:`; a stub with no parent matches no `module:`; a package has no anchor and matches no `file:`.

**Views.** A selector matches inside the view's projection: under `--internal-only` a stub matches nothing, under `--declared-only` an `edge` term sees declared edges only (there is no provenance syntax of its own), and `not` complements within the view.

**Nothing is folded.** A term matches the entity itself: a type does not "have" its methods' invocations. Containment enters through the walk's rule 1, below.

On the Java fixture, counted with the analyzer: `edge:annotationUse>name:Audited` matches 2 entities (`Order.discount(int)` and `Reporting.max(List)`), `module:com.acme.order` 137, `module:com.acme.order**` 152, `file:**/legacy/**` 8, `edge:invocation>module:java.io**` 1 (`Notifications.log(String)`), `edge-in:inheritance` 4.

## What a selection means for the walk

The walk is built over the **whole** model, whatever the selection: units, cycles, order and fingerprints never depend on it. A selection only decides which units are **asked**. So an answer bought under one filter is reused by any later run whose inputs match.

1. **The member, its nearest type, its nearest module.** A unit's member is selected when it, its NEAREST containing type, or its nearest containing module matches `select` (no `select`: everything), and none of the three matches `exclude`. Exclude always wins. Containment is not transitive: a sub-package's units are not reached through its parent package, nor a nested type's through the type around it — a sub-tree is a glob (`module:com.acme.order**`).
2. **Levels.** A unit is asked only if its level is in `levels`.
3. **A cycle is one unit.** A cycle is asked when one member is selected, and not asked when one member is excluded: asking it would ask the excluded member too.
4. **Closure.** `dependencies` adds every unit the selection transitively depends on, so each asked prompt sees its callees answered; `containers` adds the type and the module above a selected unit; `all` both. Closure never adds a unit that is barred — outside `levels`, reached by `exclude`, or a trivial member under `trivial: "skip"` — and `dependencies` does not walk on through one. `containers` reaches the module above an operation even when the type between them is barred; a parent package is not a container.
5. **Not selected is `skip-scope`.** Such a unit is never called. When the store holds a record with its fingerprint, the record is reused; otherwise it is shown to its dependents as NOT EXPLAINED, and that absence is part of their fingerprints — so they are asked again once it is answered.

The plan prices what a selection leaves out. On the Java fixture, the two `@Audited` operations:

```console
$ codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --prompt "Which of these is audited, and what does the audit record?" --include 'edge:annotationUse>name:Audited' --dry-run
walk plan (adhoc): 77 units in 8 layers
  operation     57 units      2 calls ~1122 prompt tokens
  type          17 units      0 calls ~0 prompt tokens
  module         3 units      0 calls ~0 prompt tokens
  statuses: llm 2, template 0, reuse 0, skip-scope 75, skip-budget 0
  selection: 1 dependency of the selection is not walked (1 unselected); without a record, shown as NOT EXPLAINED
  --closure dependencies adds 2 units (operation 2, type 0, module 0)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 2 calls, ~1122 prompt tokens in, ~1000 completion tokens out
```

The `selection:` line counts the direct dependencies of asked units that are not asked, by why; the `--closure` line what the next closure would add, transitively. Both are a cold plan's figures: a dependency the store already answered is reused and quoted rather than shown as NOT EXPLAINED.

**Rule 1 tries the whole selector on each of the three.** A `not` inside `select` is therefore rarely what is meant: `{ "all": [{ "module": "com.acme.order**" }, { "not": { "file": "**/legacy/**" } }] }` still asks everything in `com.acme.order.legacy`, because that package — the members' nearest module — matches both halves (a package has no file). Say it with `exclude`:

```json
{
  "kind": "codegraph.walk/1",
  "name": "order-api",
  "levels": ["operation", "type"],
  "select": { "module": "com.acme.order**" },
  "exclude": { "any": [{ "file": "**/legacy/**" }, { "edgeIn": { "kind": "inheritance" } }] },
  "prompt": { "task": "Say whether code outside this package could depend on this, and what would break if it changed." }
}
```

That plans 58 calls on the Java fixture: none in `legacy/`, none for the types something extends (`AbstractOrder`, `Priceable`) nor for their members — and none for `Money`, which shares a type cycle with `Priceable`: one excluded member leaves the whole cycle unasked (rule 3).

**What moves a fingerprint.** A unit hashes what explain's units hash — the prompt version, the model slug, the level, its members' source slices as shown (so `context.maxLines` counts), comments, signatures and facts, `context.depth`, its dependencies' hashes and the ids of those that had no record — plus, for a defined walk, the definition's `version`, its level's system message (the task and `prompt.instructions`), its level's answer schema, the label, and the entity instructions that reach its members. `name`, `select`, `exclude`, `levels`, `closure` and `trivial` are not hashed: a selection moves a fingerprint only through a dependency it leaves without a record. Editing `prompt.instructions`, `version`, a string task or the label asks every unit again; editing the operation task or an operation field asks the operations again and every unit that depends on them; an entity instruction, the units of the members it selects and their dependents. The answer text is never hashed.

## Customizing explain with a file

`codegraph explain --walk FILE` reads the same format, restricted to what leaves explain's answer alone: `select`, `exclude`, `levels`, `closure`, `context`, `prompt.instructions` and `prompt.entities`. It may restate the built-in exactly — `"name": "explain"`, `"version": "2"`, `"answer": { "builtin": "specy.domain/3" }` — and is refused for `prompt.task`, `answer.fields`, `answer.label`, `trivial` (explain templates trivial members: they are never asked nor skipped), another name, another version or another built-in. Explain's blocks are what its readers, the glossary and the Specy skill depend on.

```json
{
  "kind": "codegraph.walk/1",
  "name": "explain",
  "exclude": { "module": "com.acme.order.legacy" },
  "prompt": {
    "instructions": "The team calls a Basket a cart: use both words.",
    "entities": [
      { "select": { "module": "com.acme.order.adapter" }, "instructions": "This package wraps a vendor's ledger client: name what it adapts, and to what." }
    ]
  }
}
```

A customized explain keeps its kind (`codegraph.insights/1`) and its store (`<model>.insights.db`); its header gains `walk: { name: "explain", version: "2", digest }`, the digest over the instructions alone. A unit no instruction reaches — and every templated unit, which sends no prompt — keeps explain's fingerprint, so the records already bought for it are reused.

`codegraph walk --print-definition explain` prints explain as a definition: the one form the grammar cannot spell, its answer, named.

```json
{
  "kind": "codegraph.walk/1",
  "name": "explain",
  "version": "2",
  "levels": [
    "operation",
    "type",
    "module"
  ],
  "closure": "none",
  "context": {
    "depth": 1,
    "maxLines": 200,
    "source": true
  },
  "prompt": {
    "instructions": "",
    "entities": []
  },
  "answer": {
    "builtin": "specy.domain/3"
  }
}
```

Handed to `explain --walk`, it changes nothing; handed to `walk --walk`, it is refused on `name` and `answer.builtin`. In this documentation a `codegraph.walk/1` block whose `name` is `explain` is an explain file, and every other one a walk definition: that is how the documentation test tells them apart.

## Faults

Every fault carries its path. The file is checked in two passes — its structure first (keys and JSON types), then what the values say (names, selectors, levels, tasks, the grammar, the label) — and every fault of a pass is reported at once:

```console
$ codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --walk bad.json --dry-run
codegraph: bad.json is not a valid walk definition (4 faults):
  name: must match [a-z][a-z0-9-]* (a lowercase letter, then lowercase letters, digits or "-"), got "Audit"
  context.source: false is not supported yet: the engine shows every member's source (leaving it out is deferred with context.sections, PLAN.md §22.7)
  answer.fields.operation.description: "description" is reserved: every block carries description, answer and confidence, and words and glossary are explain's
  answer.fields.operation.steps.list.inner: a list item holds scalars and enums only: a list does not nest
codegraph walk --print-definition prints one to start from; codegraph walk --print-definition explain, explain's.
```

A flag folded over a key is named with it — `name (from --name): "explain" is reserved for the built-in walk; …`. The exit code is `2`.

## Not supported

- `context.source: false` (a walk over facts alone) is read and refused until the engine can leave source out of a prompt and of its hash; `context.sections` (which facts a prompt shows) does not exist.
- A different task per entity subset inside one walk: per-entity text is instructions; a different task is a second walk with its own selection.
- An answer schema beyond the grammar, and prompt templates: the user message's layout is the engine's.
- Selectors over measures or roles (`metric:`, `stereotype:`) or over another walk's answers, and a walk that quotes another walk's descriptions.
- Selectors on `analyze`, `city` and `navigator`.

## See also

[`codegraph walk`](/docs/reference/cli/walk/) · [`codegraph explain`](/docs/reference/cli/explain/) · [Ask your own question of the code](/docs/how-to/walk-your-question/) · [Explaining bottom-up](/docs/explanation/explaining-bottom-up/)
