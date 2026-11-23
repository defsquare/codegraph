---
title: "insights"
weight: 9
---

Query what `explain` — or a walk, --walk N — has written: a summary, a list, one explanation, the words and their glossary, the run ledger.

`insights` opens one store and nothing else: not the model (its path only says *which* store), not the side-car, no provider. It writes nothing — the store is opened as a reader, a missing one is a usage error rather than a file that appears, and one a newer codegraph wrote, or a SQLite file that is not a store, is named and left alone. One question per invocation.

## Synopsis

```
codegraph insights [model.jsonl] [--store FILE] [--walk N] [--id ID] [--level <operation|type|module>] [--concept NAME] [--min-confidence X] [--max-confidence X] [--limit N] [--word WORD] [--glossary MODULE_ID] [--polysemy] [--concerns] [--failures] [--runs] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl>` | The model whose insights store (`<model>.insights.db`, beside it) to read. The model itself is not opened. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--store FILE` | Read this store instead of the one beside the model (explain --out FILE puts it at FILE with .db for .jsonl) — explain's or a walk's, as its header says, unless --walk names whose it must be. | — |
| `--walk N` | Read the store of the walk N (`<model>.N.walk.db`, beside the model) instead of explain's: its answers and fields, listed and shown as they are; a concept or words, which only explain asks for, are none. `explain` is the default. | `explain` |
| `--id ID` | Print ONE explanation in full — envelope, description, block — for this entity id, exactly as the model renders it. An id that failed is answered with the reason (exit 3). | — |
| `--level <operation\|type\|module>` | List the records of one level. | — |
| `--concept NAME` | List the TYPES the model classified as this domain concept (aggregate, entity, valueType, repository…). | — |
| `--min-confidence X` | List records whose confidence is at least this (0 to 1). | — |
| `--max-confidence X` | List records whose confidence is at most this — what deserves a second look. | — |
| `--limit N` | Stop a list after N rows (side-car order: operations, types, modules, by id). | — |
| `--word WORD` | List every explained entity whose names spell this word (split as 'codegraph vocabulary' splits names: lowercase), by module: the module's glossary entry, then the module, its types, its operations — each with the concern, confidence and sense the model gave the word there, and the identifiers it is in. One index lookup. | — |
| `--glossary MODULE_ID` | Print a module's glossary whole: each word its types spell, with the concern, sense and meaning the module reconciled from them, and the types' own senses where they disagree. | — |
| `--polysemy` | List the words a module flagged as meaning different things to its types, and the words two modules' glossaries define differently: every module's entry, side by side, the most senses first. | — |
| `--concerns` | Per module: how many distinct words its records define, and how many the model judged domain, technical, ambiguous. | — |
| `--failures` | List the units still owed an explanation, with the reason each one failed. | — |
| `--runs` | Print the run ledger, oldest first: when, which models, what each run explained and spent. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Which store

| Flags | Store read | Read as |
|---|---|---|
| none, or `--walk explain` | `<model>.insights.db` | explain's |
| `--walk N` | `<model>.N.walk.db` | the walk N's; another walk's store at that path is refused |
| `--store FILE` | FILE | whichever walk its header names (explain's for an explain store) |
| `--store FILE --walk N` | FILE | the walk N's; refused if FILE is another walk's, explain's included |

A refused store is named, with both walks, and left untouched; the exit code is `2`.

## On a walk's store

A walk's records are read as they are stored, whatever answer fields its definition declares today — the reader holds no definition. The summary names the walk, its version and the first twelve characters of its definition digest; a list prints `id`, level, confidence and the description's first line (there is no concept column); `--id` prints the block field by field, in stored order — `answer:` first, `description:` last, a list one `- item` per line, and `—` for `null`, `""`, `[]` and `{}`; `--failures` and `--runs` read as on explain's store, in the walk's words.

`--concept`, `--word`, `--glossary`, `--polysemy` and `--concerns` ask for what only explain writes. On a walk's store they answer **none**: exit `0`, nothing on stdout, the reason on stderr — and under `--json` one document of kind `codegraph.insightsNone/1` — rather than an empty list a reader could take for "no such concept".

```console
$ codegraph insights model.jsonl --walk risk-review --concept aggregate
none: a walk's blocks carry no concept — the walk "risk-review" answers its own fields; explain's concepts are read by 'codegraph insights --concept …' without --walk.
$ codegraph insights model.jsonl --walk risk-review --word order --json
{"kind":"codegraph.insightsNone/1","walk":"risk-review","asked":"--word","none":"a walk's blocks carry no words"}
```

A walk that has not run yet has no store:

```console
$ codegraph insights fixtures/java/expected/model.jsonl --walk audit
codegraph: no store of the walk "audit" at fixtures/java/expected/model.audit.walk.db
'codegraph walk <model.jsonl> --name audit' (or a --walk FILE naming it) creates it. Pass --store FILE if it is elsewhere.
```

## JSON output

`--json` makes each answer one kind-tagged document: `codegraph.insightsSummary/1` (on a walk's store with `walk` right after `kind`), `…List/1`, `…Word/1`, `…Glossary/1`, `…Polysemy/1`, `…Concerns/1`, `…Failures/1`, `…Runs/1`, and `codegraph.insightsNone/1` for a question a walk's store cannot answer. `--id --json` is the record exactly as the side-car carries it.

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when `--id` names a unit that was asked for and failed: the answer is its reason. An id the store has never heard of, a missing store and a refused store are usage errors (`2`).

## See also

[`explain`](/docs/reference/cli/explain/) · [`walk`](/docs/reference/cli/walk/) · [insights.jsonl](/docs/reference/artifacts/insights-jsonl/) · [CLI conventions](/docs/reference/cli/)
