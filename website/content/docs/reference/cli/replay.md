---
title: "replay"
weight: 14
---

Build the entity-level city replay of a temporal store.

## Synopsis

```
codegraph replay [--store FILE] [--name STR] [--history FILE] [--out FILE] [--serve] [--port N] [--host ADDR]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--store FILE` | The temporal model.db (built by `codegraph snapshots` or `import --at`); defaults to the store beside this directory's default model. | — |
| `--name STR` | Corpus display name; defaults to the store's basename. | — |
| `--history FILE` | A history.jsonl (codegraph scm) to join by path suffix: buildings gain their file's dominant author, and co-change arcs (logical coupling, default thresholds) join the replay. | — |
| `--out FILE` | Write the laid-out replay city artifact here instead of stdout. | — |
| `--serve` | Serve the replay in the visualizer — a timeline scrubs the revisions (stdout stays empty; Ctrl-C stops it). | — |
| `--port N` | Port for --serve; 0 picks a free one. | `4177` |
| `--host ADDR` | Interface for --serve to bind; 127.0.0.1 keeps the replay on this machine only. | `0.0.0.0` |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` is not returned.

## Example

```console
$ codegraph replay --store /tmp/temporal.db --out /tmp/replay.json
replay city of /tmp/temporal.db: 3 districts, 19 buildings, 1 revision on the timeline.
wrote 16806 bytes to /tmp/replay.json.
```

## See also

[city.json](/docs/reference/artifacts/city-json/) · [CLI conventions](/docs/reference/cli/)
