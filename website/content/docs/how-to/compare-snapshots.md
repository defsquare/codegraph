---
title: Compare two models of one corpus
linkTitle: Compare snapshots
weight: 14
---

Every codegraph artifact is byte-identical for identical input, which makes
`diff` a real instrument: a change in the output is a change in what the
extractor claims about known code. This guide covers diffing two model files and
following one entity across two revisions of a store.

**Before you start:** two `model.jsonl` files of the same corpus, or a temporal
`model.db`.

## Diff two model files

1. Extract into a scratch file — never over the one you are comparing against.

   ```bash
   java -jar extractors/java/target/codegraph-java.jar \
     --src fixtures/java/src --out /tmp/candidate.jsonl
   ```

2. Normalise the header. The `root` field carries the absolute path the
   extractor was pointed at, which is correct at runtime — anchors are relative
   to it — and differs on every machine. Everything else is machine-independent,
   so compare the bodies:

   ```bash
   diff <(tail -n +2 /tmp/candidate.jsonl) <(tail -n +2 fixtures/java/expected/model.jsonl)
   ```

   On the reference fixture that diff is empty: a fresh extraction differs from
   the committed snapshot on line 1 only, and only in `root`.

3. Read the diff. One record per line in canonical order means a changed entity
   is one changed line, not a re-indented block, and a new entity is one added
   line at its sorted position.

**If the diff is not empty, the question is never how to make it green.** It is
whether the new output is better. If it is, the diff is the changelog for the
model; if it is not, you found a regression.

## Keep a snapshot in the repository

That is the workflow this repository runs on its own fixture. The committed
`fixtures/java/expected/model.jsonl` is what the extractor claims about a corpus
a reviewer can read in full, and a test compares against it with the `root`
normalised to the repo-relative `fixtures/java/src`:

```bash
cd extractors/java
./mvnw -B test -Dtest=SnapshotTest
```

Regenerate it deliberately, and read the diff before committing:

```bash
./mvnw -B test -Dtest=SnapshotTest -Dcodegraph.updateSnapshot=true
```

## Compare at a higher level

A raw model diff is noisy when the extractor changed how it names things but not
what it found. Compare the analysis instead — every export is sorted and carries
the level and view it was computed under:

```bash
codegraph export a.jsonl --format csv --level module --out a.csv
codegraph export b.jsonl --format csv --level module --out b.csv
diff a.csv b.csv

codegraph analyze a.jsonl --report coupling --level type --json > a.json
codegraph analyze b.jsonl --report coupling --level type --json > b.json
diff a.json b.json
```

Validate both first — a model with findings will move numbers for reasons that
have nothing to do with the change you are studying:

```bash
codegraph validate a.jsonl b.jsonl
```

Note that `validate` loads several paths as one **union**, so two models of the
same corpus will report duplicate ids. To check them separately, run the command
twice.

## Compare two revisions of a store

For the same corpus at two points in time, the store answers per entity:

```bash
codegraph timeline java:com.acme.order/Basket --store corpus.db
```

```text
timeline of java:com.acme.order/Basket (1 of 1 revisions in corpus.db)
  appeared:  aaaaaaa (2023-11-14)
  present:   still in the latest revision
  REVISION  DATE        LOC  KIND
  aaaaaaa   2023-11-14   51  class
```

The id is the rendered form — `java:com.acme.order/Basket`. `--store` defaults to
the store beside this directory's default model. `--json` gives the same series
as an object, which is the form to diff or to plot.

Lifespans are derived at query time from the natural key, so a **renamed** symbol
reads as a death plus a birth, and anonymous entities (lambdas, anonymous
classes) are not tracked across revisions at all. Both restrictions are
deliberate; neither is silent.

## Related

- [Sample a repository into a temporal store](/docs/how-to/temporal-store/)
- [Gate a CI pipeline on model quality](/docs/how-to/ci-gate/)
- [`codegraph timeline`](/docs/reference/cli/timeline/)
- [`model.jsonl` reference](/docs/reference/model-jsonl/)
