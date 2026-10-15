---
title: history-metrics.jsonl
weight: 4
---

Change history measured **at the commit a model describes**, written by [`codegraph-metrics --history`](/docs/reference/metrics-pass/#--history-change-history-as-a-side-car): one record per file, from one walk over the whole commit graph, and one per measured entity, from one `git blame` per file. It is a **side-car** beside the model, `<model>.history-metrics.jsonl`, and never a key inside it: a model describes the code at one commit, and its bytes must not change because time passed. [`city`](/docs/reference/cli/city/) and [`serve`](/docs/reference/cli/serve/) join the two in memory.

One JSON object per line, discriminated on `t`. Section order is contractual and enforced by the reader:

```
header → f* → e* → eof
```

Files are ordered by path and entities by natural key, both strictly ascending: the order is the uniqueness check, and what makes two runs over one repository byte-identical. An entity is named by its **natural key** `{lang, module, symbol, disambiguator?}`, never by a rendered id; the CLI renders it with core's own `renderId` to join (ids are rendered, never parsed). Field names are those of the Zod record schemas in `packages/scm/src/history-metrics.ts`.

## `header`

> First record of a history-metrics side-car.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"header"` | |
| `kind` | `"codegraph.history-metrics/1"` | self-identification: a model file must be refusable as "not a side-car" |
| `generatedBy.name`, `.version`, `.bigCodeAnalysis` | strings | `codegraph-metrics`, its version, and the big-code-analysis version whose definitions the numbers follow |
| `lang` | string | the model's language; an entity of another language is refused |
| `root` | string, optional | the model's `root`, as its header spells it |
| `commit` | hex string | the commit measured at: the model's `repository.commit`, else `HEAD` at the time of the run, or `--ref` |
| `asOf` | integer | that commit's committer time, Unix seconds — every window's "now"; never the wall clock |
| `windowDays.long`, `.recent` | integers | the two windows every `*_long` and `*_recent` measure counts back over: 365 and 90 |

## `f` — one file

> One file of the model, measured from the commit walk.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"f"` | |
| `path` | non-empty string | the model's file path, relative to its root, as its anchors spell it |
| `vcs` | `Record<string, number>` | the file-level measures below; absence means "not measured", never zero |

## `e` — one entity

> One measured entity, from the blame of its file.

| Field | Type | Meaning |
|---|---|---|
| `t` | `"e"` | |
| `key.lang`, `.module`, `.symbol`, `.disambiguator?` | strings | the entity's natural key, restated |
| `vcs` | `Record<string, number>` | the entity-level measures below, over the lines that survive at the commit |

A file whose bytes at the commit differ from what the extractor read keeps its `f` record and has no `e` records: its anchors and the blamed lines would describe different text. The run says how many.

## `eof`

> Trailer: the file is complete, and this is what it carries.

`{"t":"eof","counts":{"files":N,"entities":N}}` — both integers ≥ 0, and both must match what was read.

## Measures

Windows count back from `asOf`. Blame credits a line to the commit that last touched it, so an entity's `lines_*` are **surviving** lines — a different quantity from a file's `churn_*` (added plus deleted), hence a different name; the two never share a key. `risk_score` is ordinal: rank by it, never read it.

| Measure | Unit | Level | Meaning |
|---|---|---|---|
| `age_days` | days | file, entity | days since the first commit in the long window (capped at it) |
| `authors_long` | authors | file, entity | distinct authors in the long window (mailmap-canonical, bots excluded) |
| `authors_recent` | authors | file, entity | distinct authors in the recent window |
| `bug_fix_commits` | commits | file, entity | long-window commits whose message reads as a bug fix |
| `burst` | ratio | file, entity | `commits_recent / commits_long`: how much of the activity is recent |
| `change_entropy_long` | bits | file | change entropy (Hassan, 2009): how scattered the commits it took part in were |
| `change_entropy_recent` | bits | file | change entropy over the recent window |
| `churn_long` | lines | file | lines added plus deleted in the long window |
| `churn_recent` | lines | file | lines added plus deleted in the recent window |
| `cochange_entropy_long` | bits | file | co-change entropy: how widely its changes ripple to other files |
| `cochange_entropy_recent` | bits | file | co-change entropy over the recent window |
| `commits_long` | commits | file, entity | distinct commits in the long window (an entity: among its surviving lines) |
| `commits_recent` | commits | file, entity | distinct commits in the recent window |
| `last_modified_days` | days | file, entity | days since the most recent commit in the long window |
| `lines_long` | lines | entity | its lines surviving at the commit, last changed in the long window (blame) |
| `lines_recent` | lines | entity | its surviving lines last changed in the recent window |
| `ownership_top_share` | share | file, entity | the top author's share of the long window's edits, 0..1 |
| `revert_commits` | commits | file, entity | long-window commits that revert or roll back |
| `risk_score` | rank | file, entity | big-code-analysis's weighted risk score — ordinal: rank by it |
| `security_fix_commits` | commits | file, entity | long-window commits whose message reads as a security fix |

The list is `HISTORY_MEASURES` in `@codegraph/scm`, pinned equal to the Rust lists by a test. Bug-fix, security and revert counts are **labelled heuristics** over commit messages, as the `fix` and `revert` flags of [`history.jsonl`](/docs/reference/artifacts/history-jsonl/) are. Each measure's paper, how the walk and the blame differ, the classifier's keywords and the risk formula: [Metrics catalogue](/docs/reference/metrics-catalogue/#change-history-metrics).

## Excerpt

The committed fixture, `fixtures/history-metrics/expected/`: a repository the Rust test builds commit by commit with pinned authors and dates, so every number is hand-countable. One record of each type:

```json
{"t":"header","kind":"codegraph.history-metrics/1","generatedBy":{"name":"codegraph-metrics","version":"0.2.0","bigCodeAnalysis":"2.2.0"},"lang":"java","root":"src","commit":"dfa563f5ce9e4a8f1d8e898eb7ae89d5168c8229","asOf":1779357600,"windowDays":{"long":365,"recent":90}}
{"t":"f","path":"com/acme/Shop.java","vcs":{"age_days":131,"authors_long":3,"authors_recent":2,"bug_fix_commits":1,"burst":0.6667,"change_entropy_long":0,"change_entropy_recent":0,"churn_long":15,"churn_recent":4,"cochange_entropy_long":0,"cochange_entropy_recent":0,"commits_long":3,"commits_recent":2,"last_modified_days":1,"ownership_top_share":0.3333,"revert_commits":0,"risk_score":1.5817,"security_fix_commits":0}}
{"t":"e","key":{"lang":"java","module":"com.acme","symbol":"Shop.add(int)"},"vcs":{"age_days":131,"authors_long":2,"authors_recent":1,"bug_fix_commits":1,"burst":0.5,"commits_long":2,"commits_recent":1,"last_modified_days":20,"lines_long":3,"lines_recent":1,"ownership_top_share":0.5,"revert_commits":0,"risk_score":0.9511,"security_fix_commits":0}}
{"t":"eof","counts":{"files":1,"entities":3}}
```

## Reading it

[`city`](/docs/reference/cli/city/) and [`serve`](/docs/reference/cli/serve/) read `<model>.history-metrics.jsonl` beside each model — or the file `--history-metrics FILE` names — and offer two metric forms on every channel and on `--carry`:

| Form | Reads |
|---|---|
| `history:<measure>` | the building's own type: its blame |
| `history-file:<measure>` | the file the type is written in |

Asking for one with no side-car, or at a level the measure lacks, is a usage error that says what to run or type instead:

```text
codegraph: churn_long is measured per file only: use history-file:churn_long
```

The decoder is strict: a missing header, a record after the trailer, a file after the entity records, disorder or repetition inside a section, a non-number, trailer counts that do not match, or an entity of another language than the header's are refused with the line number; `encode(decode(x))` is `x` for every file the pass wrote. Why history stays a side-car: [Time as structure](/docs/explanation/time-as-structure/).
