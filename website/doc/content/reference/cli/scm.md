---
title: "scm"
weight: 9
---

Mine a repository's history into a deterministic history.jsonl.

## Synopsis

```
codegraph scm [repo] [--since DATE] [--out FILE] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<repo>` | Path to the repository to mine. | `.` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--since DATE` | Mine only commits newer than this date (passed to git log --since). | — |
| `--out FILE` | Write the history here instead of <repo>-history.jsonl. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` is not returned: a mined repository is either read or it is a usage error.

## Example

```console
$ codegraph scm . --out /tmp/codegraph-history.jsonl
.: mined in 0.20 s
mined . -> /tmp/codegraph-history.jsonl
  162 commits by 5 authors, 461 file lineages, 1347 changes, 2026-08-18 .. 2026-09-07
```

## See also

[history.jsonl](/reference/artifacts/history-jsonl/) · [CLI conventions](/reference/cli/)
