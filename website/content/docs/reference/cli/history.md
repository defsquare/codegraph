---
title: "history"
weight: 12
---

Report churn, hotspots and authorship over a mined history.jsonl.

## Synopsis

```
codegraph history [history.jsonl] [--report <summary|hotspots|authors|coupling|hidden|deadweight>] [--top N] [--model FILE] [--rank <classic|branchy|tangled|fragile>] [--min-support N] [--min-confidence PCT] [--serve] [--port N] [--host ADDR] [--city FILE] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<history.jsonl>` | A history.jsonl mined by `codegraph scm`. | `<current-dir>-history.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--report <summary\|hotspots\|authors\|coupling\|hidden\|deadweight>` | Which report to print. | `summary` |
| `--top N` | Show only the N highest-ranked rows (hotspots defaults to 20). | — |
| `--model FILE` | A model to join on file paths. hidden and deadweight need one (default: this directory's default model). Given to hotspots, each file gains its lines, its cyclomatic complexity, its dependency cycle and its rank in four families; given to summary, the share of commits that cross a top-level directory of the model. | — |
| `--rank <classic\|branchy\|tangled\|fragile>` | hotspots with --model: the family the rows are ordered by — classic (revisions x lines), branchy (revisions x cyclomatic; the default), tangled (revisions of a file in a dependency cycle), fragile (revisions x fix density). | — |
| `--min-support N` | Coupling: pairs must co-change in at least N commits. | `3` |
| `--min-confidence PCT` | Coupling: support over the rarer file's revisions, as a percent. | `50` |
| `--serve` | Serve the file-level city REPLAY of this history — buildings are files, a timeline scrubs the commits (stdout stays empty; Ctrl-C stops it). | — |
| `--port N` | Port for --serve; 0 picks a free one. | `4177` |
| `--host ADDR` | Interface for --serve to bind; 127.0.0.1 keeps the replay on this machine only. | `0.0.0.0` |
| `--city FILE` | Write the laid-out replay city artifact (city.json with a replay block) to FILE. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the input file is not a `history.jsonl`, or when the `--model` of a
report that reads one is not a model.

## Example

```console
$ codegraph history /tmp/codegraph-history.jsonl --report hotspots --top 5
hotspots of codegraph (top 5 of 461 files by revisions):
  REVISIONS  CHURN  FIXES  DENSITY  AUTHORS  PATH
         42   2166      3     0.07        1  PLAN.md
         30    631      0     0.00        2  README.md
         26   1804      0     0.00        1  packages/cli/src/args.ts
         20   1324      3     0.15        1  packages/viz/src/main.ts
         17    106      0     0.00        1  packages/analyzer/src/index.ts
```

Joined with a model, the same report ranks effort times complexity, and the
summary says how often a commit crosses a top-level directory:

```console
$ codegraph history codegraph-history.jsonl --report hotspots --model codegraph.jsonl --top 3
note: 654 of 1082 history files have no counterpart in the model (docs, build files, deleted files, anything outside the extracted root).
note: 16 model files were touched by no mined commit.
hotspots of codegraph, joined with the model (top 3 of 428 files, by branchy rank):
  REVISIONS  SLOC  CYCLOMATIC  CYCLE  FIXES  DENSITY  AUTHORS   OWNER  CLASSIC  BRANCHY  TANGLED  FRAGILE  PATH
         45  2158         276      0      1     0.02        2  91% #1        1        1        -       20  packages/cli/src/args.ts
         15   919         241      0      3     0.20        2  89% #1        2        2        -        3  packages/cli/test/explain.test.ts
         13   750         244      0      2     0.15        2  98% #1        3        3        -        8  packages/cli/src/commands/explain.ts
ranks: classic = revisions x sloc, branchy = revisions x cyclomatic, tangled = revisions of a file in a dependency cycle (CYCLE = its files), fragile = revisions x density = fixes; - = not ranked. OWNER = the share of the file's added lines its main author wrote, and that author's row in --report authors.

$ codegraph history codegraph-history.jsonl --report summary --model codegraph.jsonl | tail -1
  cross-module: 54 of 206 commits touching the model cross its top-level directories (26.2%; 11 at its root)
```

The two `note:` lines are on stderr. With `--json` each row carries `scores`
and `ranks` for the four families, `sloc` or `cyclomatic` is `null` where
nothing in the file was measured, and `ownerShare` comes with `ownerRank` (the
main author's row in `--report authors`, the `#` of the table) and
`ownerLastSeen`, the day that author last committed anywhere in the history.
The joined report never prints a name; `--report authors` does.

## See also

[history.jsonl](/docs/reference/artifacts/history-jsonl/) · [Find hidden coupling and dead weight](/docs/how-to/history-joins/) · [Activity](/docs/discover/activity/) · [CLI conventions](/docs/reference/cli/)
