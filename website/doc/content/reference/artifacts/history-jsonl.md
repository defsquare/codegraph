---
title: history.jsonl
weight: 3
---

A repository's evolution, mined by [`scm`](/reference/cli/scm/): repo-scoped, language-agnostic, one `git log` pass. Evolution facts are a **third artifact**: they never merge into `model.jsonl` and never grow a provenance value; the join with the code model happens in the analyzer, on paths.

One JSON object per line, discriminated on `t`. Section order is contractual and enforced by the reader:

```
header → f* → c* → x* → eof
```

The `model.jsonl` conventions are reused verbatim: the one closed vocabulary (authors) rides once in the header; the unbounded string set (paths) is interned one record per line; every intra-file reference is a dense surrogate int, file-scoped and never identity; the trailer counts what the file carries so truncation is detectable.

Field names are those of the Zod record schemas in `packages/scm/src/wire.ts`.

## `header`

> First record of a history.jsonl file.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"header"` | |
| `artifact` | `"history"` | self-identification: a model file must be refusable as "not a history" |
| `schemaVersion` | integer ≥ 1 | `1` today |
| `scm` | string | the SCM mined — `git` today |
| `miner` | string | miner name and version, e.g. `codegraph-scm@0.1.0` |
| `repo` | string | the repository's BASENAME, never its absolute path, so the file is byte-identical wherever the same repo is mined |
| `dict.authors` | string[] | sorted, distinct `Name <email>` strings; `.mailmap` applies when the repo has one |

## `f` — one file lineage

> One file lineage: the file's most recent path.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"f"` | |
| `i` | integer ≥ 0 | the lineage surrogate |
| `path` | non-empty string | the file's most recent name |

A path surrogate names a file's **lineage**, not its literal path at a given commit: rename chains are resolved at mine time, so one surrogate names one file across its renames.

## `c` — one commit

> One commit: metadata only, in (time, hash) order.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"c"` | |
| `i` | integer ≥ 0 | the commit surrogate |
| `h` | string | full hash, lowercase hex, `^[0-9a-f]{40,64}$` — never abbreviated |
| `a` | integer ≥ 0 | index into `dict.authors` |
| `ts` | integer ≥ 0 | committer timestamp, unix seconds — the replay's clock |
| `fix` | `true` | present only when the subject matched the fix heuristic |
| `revert` | `true` | present only when the subject matched the revert heuristic |

`fix` and `revert` are **labelled heuristics**, not facts. The patterns are exported so they are inspectable: `/\b(fix(es|ed)?|bug|defect|hotfix|patch)\b/i` for a fix, `/^revert\b/i` for a revert — `revert` only as the leading word.

## `x` — one change

> One file touched by one commit, path resolved to its lineage.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"x"` | |
| `c` | integer ≥ 0 | index into the commit section |
| `p` | integer ≥ 0 | index into the path table |
| `a` | integer ≥ 0 | lines added; 0 for binary files (numstat reports `-`) |
| `d` | integer ≥ 0 | lines deleted; 0 for binary files |
| `from` | non-empty string | the literal pre-rename path, when this change renamed the file |

## `eof`

> Trailer: the file is complete, and this is what it carries.

`{"t":"eof","counts":{"paths":N,"commits":N,"changes":N}}` — all three integers ≥ 0.

## Ordering

`commits` are sorted by (time, hash) ascending — replay order. `changes` are sorted by (commit, path) ascending. `authors` and `paths` are sorted and distinct.

## Excerpt

`codegraph scm .` over this repository — 162 commits, 461 file lineages, 1347 changes — one line of each type:

```json
{"t":"header","artifact":"history","schemaVersion":1,"scm":"git","miner":"codegraph-scm@0.1.0","repo":"codegraph","dict":{"authors":["Jeremie Grodziski <jeremie@defsquare.com>","Jeremie Grodziski <jeremie@grodziski.com>","Jérémie Grodziski <jeremie@defsquare.com>","Jérémie Grodziski <jeremie@grodziski.com>","davidpanza <david.panza@gmail.com>"]}}
{"t":"f","i":0,"path":".gitignore"}
{"t":"c","i":0,"h":"9e59da55d70144844934acb1e1d4f053eedca593","a":3,"ts":1787073082}
{"t":"x","c":0,"p":5,"a":93,"d":0}
{"t":"eof","counts":{"paths":461,"commits":162,"changes":1347}}
```

## Reading it

[`history`](/reference/cli/history/) reports over this file: `summary`, `hotspots`, `authors`, `coupling`, and — joined with a model through `--model` — `hidden` and `deadweight`. [`replay --history`](/reference/cli/replay/) joins it into a temporal city by path suffix, giving buildings their file's dominant author and adding co-change arcs.

Why history is a dependency source cannot show: [Time as structure](/explanation/time-as-structure/).
