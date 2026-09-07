---
title: Find hidden coupling and dead weight
linkTitle: History joins
weight: 9
---

Two of codegraph's reports need both graphs at once — what the code says, and
what the commits did. **Hidden coupling** is files that change together though no
declared dependency links them. **Dead weight** is declared dependencies history
never exercised.

**Before you start:** a git clone of the repository and a `model.jsonl` extracted
from a directory inside it. The outputs below are real, from codegraph's own
repository joined with the reference fixture's model.

## Mine the history

```bash
codegraph scm . --out codegraph-history.jsonl
```

```text
mined . -> codegraph-history.jsonl
  162 commits by 5 authors, 461 file lineages, 1347 changes, 2026-08-18 .. 2026-09-07
```

The miner runs one `git log` pass and resolves rename chains, so one path names
one file lineage. `--since DATE` limits how far back it goes; without `--out` it
writes `<repo>-history.jsonl`.

## Find hidden coupling

```bash
codegraph history codegraph-history.jsonl --report hidden \
  --model fixtures/java/expected/model.jsonl --min-support 2
```

```text
note: 5 sweeping commits skipped for coupling (changesets over 30 files couple nothing meaningfully).
note: 649 co-changed pairs lie outside the model (docs, config…).
hidden coupling of codegraph (top 1 of 1 co-changed pairs with NO path in the declared graph):
  SUPPORT    CONF  PAIR
        2  100.0%  fixtures/java/src/com/acme/order/Audited.java + fixtures/java/src/com/acme/order/Channel.java
```

A pair is *hidden* when there is no path between the two files in the declared
graph — transitive, in either direction. That is the interesting case: something
couples them that the source does not state.

Read the two notes. The first says how many commits were too broad to mean
anything (a sweeping refactor couples everything with everything). The second
says how much of the history has no counterpart in the model — docs, build files,
and anything outside the extracted source root.

## Find dead weight

```bash
codegraph history codegraph-history.jsonl --report deadweight \
  --model fixtures/java/expected/model.jsonl
```

```text
dead weight of codegraph (top 3 of 3 declared file dependencies that never co-change):
  EDGES  REV-FROM  REV-TO  DEPENDENCY
      7         1       1  com/acme/order/Batch.java -> com/acme/order/Money.java
      5         1       1  com/acme/order/StockGuard.java -> com/acme/order/EmptyBasketException.java
      2         1       1  com/acme/order/Batch.java -> com/acme/order/Priceable.java
```

`REV-FROM` and `REV-TO` are how many revisions each file has. A dependency
between two files that barely changed is not evidence of anything — check those
columns before you read a result as dead.

## Tune the thresholds

Both reports rest on the co-change pairs `--report coupling` computes, and both
take its knobs:

| Flag | Default | Meaning |
|---|---|---|
| `--min-support N` | `3` | the pair must co-change in at least N commits |
| `--min-confidence PCT` | `50` | support over the rarer file's revision count, as a percent |
| `--top N` | 20 for hotspots | how many rows to print |

```bash
codegraph history codegraph-history.jsonl --report coupling --top 5 --min-support 8 --min-confidence 70
```

```text
logical coupling of codegraph (top 5 of 11 pairs; support >= 8, confidence >= 70.0%):
  SUPPORT    CONF  REV-A  REV-B  PAIR
       13   86.7%     20     15  packages/viz/src/main.ts + packages/viz/src/three/cityScene.ts
       12  100.0%     12     20  packages/viz/index.html + packages/viz/src/main.ts
```

**If you get too many pairs, then raise `--min-support` first** — it is the
count of real evidence. **If you get none, then lower `--min-confidence`**: a
file that changes constantly drags every partner's confidence down.

## Make the join work

The model's paths are relative to the extracted source root; the history's are
relative to the repository root. They are joined by path **suffix**, which is why
the model must come from a directory inside the repository you mined. An
ambiguous suffix joins nothing and is counted rather than guessed.

`--model FILE` is required for `hidden` and `deadweight`; without it the command
falls back to this directory's default model.

{{< callout type="info" >}}
Co-change is an inference about people, not a fact about code. It never enters
the model, never becomes a fifth provenance value, and in the replay it is drawn
as a dashed arc so it can never pass for a declared dependency.
{{< /callout >}}

## Related

- [Replaying a project's history](/tutorials/history-replay/)
- [Sample a repository into a temporal store](/how-to/temporal-store/)
- [`codegraph history`](/reference/cli/history/)
- [`history.jsonl` reference](/reference/artifacts/history-jsonl/)
- [Time as structure](/explanation/time-as-structure/)
