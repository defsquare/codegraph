---
title: Sample a repository's history into a temporal store
linkTitle: Temporal store
weight: 8
---

`codegraph snapshots` extracts a repository at chosen revisions and appends each
frame to one `model.db`. That store is what `timeline` and `replay` read.

**Before you start:** a git clone of the repository, the extractor jar, and a JDK
on `PATH`. The command runs `java -jar` once per revision, so budget accordingly.

## Choose the sampling

```bash
# releases as keyframes — usually what you want
codegraph snapshots ~/src/gson --jar extractors/java/target/codegraph-java.jar \
  --tags --src gson/src/main/java --store gson.db

# or every Nth first-parent commit, oldest first; the tip is always included
codegraph snapshots ~/src/gson --jar extractors/java/target/codegraph-java.jar \
  --every 50 --src gson/src/main/java --store gson.db
```

- `--tags` snapshots the commits the repository's tags point at. Releases are
  meaningful frames and there are usually a manageable number of them.
- `--every N` snapshots every Nth first-parent commit. 50–200 frames is enough
  for a readable replay.
- `--src DIR` is the directory to extract, **relative to the repository root**.
  Omit it and the whole repository is extracted.
- `--store FILE` defaults to `<repo>-model.db`.
- The repository argument defaults to `.`.

Each frame is extracted in a throwaway `git worktree`, so your working copy is
never touched or checked out to another revision.

Progress is one line per frame:

```text
[2/5] f5cb8e0 -> 167 entities, 168 edges in 1.2 s
```

and the run ends with how many were imported, skipped and failed, and how many
revisions the store now holds.

## Resume an interrupted run

Re-run the same command. Revisions the store already holds are skipped, so
nothing is re-extracted:

```bash
codegraph snapshots ~/src/gson --jar codegraph-java.jar --tags --src gson/src/main/java --store gson.db
```

A frame that fails to extract is isolated and reported rather than killing the
run; the command exits `3` and lists the revisions to retry. Re-running retries
exactly those.

## Compose two runs when the source root moved

A repository that reorganised its layout has no single `--src` that works across
its history. Run `snapshots` once per layout, into the **same** store — resume
skipping makes the overlap free:

```bash
codegraph snapshots ~/src/gson --jar codegraph-java.jar --tags \
  --src src/main/java       --store gson.db     # the pre-2.4 layout
codegraph snapshots ~/src/gson --jar codegraph-java.jar --tags \
  --src gson/src/main/java  --store gson.db     # after the module move
```

Each run extracts the revisions where its root exists and reports the others as
failures. This is the recorded route for gson: all 55 release tags from 2008 to
2025 landed in one store that way.

## Append one revision by hand

`snapshots` orchestrates the loop; the append itself is one command, which is
what you want if you already have models:

```bash
codegraph import model.jsonl --out corpus.db --at 4b9d4a5 --time 2026-03-01
```

`--at SHA` appends the model as that revision's snapshot instead of replacing the
store. `--time` (unix seconds or an ISO date) is what queries order by. A
revision already in the store is refused — a snapshot is imported once.

## Read the store

```bash
codegraph timeline java:com.google.gson/Gson --store gson.db
codegraph replay --store gson.db --serve
```

```text
timeline of java:com.acme.order/Basket (1 of 1 revisions in t2.db)
  appeared:  aaaaaaa (2023-11-14)
  present:   still in the latest revision
  REVISION  DATE        LOC  KIND
  aaaaaaa   2023-11-14   51  class
```

Lifespans are derived at query time from the natural key, never stored. A
renamed symbol is therefore a death plus a birth, and anonymous entities
(lambdas, anonymous classes) are not tracked across revisions at all.

## Related

- [Replaying a project's history](/docs/tutorials/history-replay/)
- [Compare two models of one corpus](/docs/how-to/compare-snapshots/)
- [`codegraph snapshots`](/docs/reference/cli/snapshots/)
- [`codegraph timeline`](/docs/reference/cli/timeline/)
- [Time as structure](/docs/explanation/time-as-structure/)
