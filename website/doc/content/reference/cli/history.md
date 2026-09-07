---
title: "history"
weight: 11
---

Report churn, hotspots and authorship over a mined history.jsonl.

## Synopsis

```
codegraph history [history.jsonl] [--report <summary|hotspots|authors|coupling|hidden|deadweight>] [--top N] [--model FILE] [--min-support N] [--min-confidence PCT] [--serve] [--port N] [--host ADDR] [--city FILE] [--json]
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
| `--model FILE` | Model for the cross-graph reports (hidden, deadweight); defaults to this directory's default model. | — |
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

`3` when the input file is not a `history.jsonl`.

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

## See also

[history.jsonl](/reference/artifacts/history-jsonl/) · [CLI conventions](/reference/cli/)
