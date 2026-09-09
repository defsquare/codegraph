---
title: "snapshots"
weight: 11
---

Extract a repo at sampled revisions into a temporal store (model.db).

## Synopsis

```
codegraph snapshots [repo] --jar FILE [--every N] [--tags] [--store FILE] [--src DIR] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<repo>` | Path to the repository to snapshot. | `.` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--jar FILE` | The codegraph-java extractor jar, run with `java -jar` at every revision. | *required* |
| `--every N` | Snapshot every Nth first-parent commit, oldest first; the tip is always included. | — |
| `--tags` | Snapshot the commits the repo's tags point at instead (releases as keyframes). | — |
| `--store FILE` | The temporal store to append to; defaults to <repo>-model.db. | — |
| `--src DIR` | Directory to extract, relative to the repo root (default: the whole repo). | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when any sampled revision failed to extract; the failures are listed and the successful frames stay in the store.

## Example

```console
$ codegraph snapshots . --jar extractors/java/target/codegraph-java.jar --tags --store /tmp/temporal.db
```

The command runs the extractor once per sampled revision, each in a throwaway `git worktree`; a rerun skips the revisions the store already holds.

## See also

[model.db](/docs/reference/model-db/) · [Java extractor](/docs/reference/java-extractor/) · [CLI conventions](/docs/reference/cli/)
