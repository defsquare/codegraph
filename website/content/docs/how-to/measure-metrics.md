---
title: Measure complexity and change history
linkTitle: Metrics pass
weight: 7
---

Every extractor measures two things, `sloc` and `cyclomatic`. The metrics pass
adds the rest — cognitive complexity, Halstead, ABC, the maintainability index,
logical and comment lines — to a model an extractor already wrote, and, on
request, how each file and entity has been changing, into a side-car beside it.
This guide covers running the pass, reading what it reports, seeing the numbers
in the city, and measuring history.

**Before you start:** the `codegraph-metrics` command on `PATH` — it comes with
any extractor installed from the tap (see [Install](/docs/how-to/install/)); a
`model.jsonl` from any extractor; and the sources it was extracted from,
unchanged since.

## Run the pass

1. Measure the model in place. `--src` is the directory the model's paths are
   relative to; it defaults to the header's `root`, read from the directory you
   run in, so from the directory the extractor ran in nothing more is needed.

   ```bash
   codegraph-metrics model.jsonl --src fixtures/ruby/src
   ```

   ```text
   codegraph-metrics: 106 of 109 measured entities joined (106 exact, 0 leading, 0 contained; 3 ambiguous, 0 unjoined) over 31 files; sloc = bca ploc on 106 of 106 exact joins; 106 entities rewritten
   ```

   The model is rewritten through a temporary file and renamed on success, so
   a failure leaves the extractor's model as it was. `--out FILE` writes
   elsewhere instead.

2. Check the model is still conformant. The pass never adds a trait and never
   touches the extractor's own keys, so this must stay green:

   ```bash
   codegraph validate model.jsonl
   ```

Running the pass twice changes nothing: it owns a closed list of keys and
replaces exactly those on every run. Running it again after the sources changed
leaves no stale value behind.

## Read the report

The one line on stderr is the join's account of itself. **If `exact` plus
`leading` plus `contained` is most of the measured entities, then the model is
measured.** What is left is what big-code-analysis opens no space for, and it is
expected, not a failure:

| Count | Meaning |
|---|---|
| `exact` | the entity and a space cover the same lines |
| `leading` | they end together and start apart by annotation or decorator lines only — most of a Spring corpus |
| `contained` | one entity over several spaces: an Elixir function's clauses, a C# property's accessors. Only the additive keys are written |
| `ambiguous` | the model and the grammar disagree on what sits there: a Ruby type declared by assignment. Nothing is written |
| `unjoined` | no space at all: implicit constructors, Java lambdas, interface signatures, type aliases. Nothing is written |

**If `sloc = bca ploc` is not `N of N`, then look at the files.** On an exact
join the extractor and big-code-analysis both count the lines holding code and
must agree; the known exceptions are a file with syntax errors, JSX text lines in
`.tsx`, a heredoc in Elixir and `#if` blocks in C#. Anything else is worth a
look.

Absence is the answer for every entity the pass could not measure: no key, never
a zero. [City metrics](/docs/reference/city-metrics/) explains how a consumer
reads that.

## Audit what was not measured

```bash
codegraph-metrics model.jsonl --src fixtures/java/src --audit
```

```text
  Leading Invocable e4 com/acme/order/AbstractOrder.java:20-22
  Leading Type e8 com/acme/order/Audited.java:8-11
  Unjoined Invocable e9 com/acme/order/Audited.java:10-10
  Unjoined Invocable e11 com/acme/order/Basket.java:7-57 (on its parent's anchor)
  Unjoined Invocable e70 com/acme/order/Notifications.java:11-11
```

One line per entity not joined exactly: the outcome, the category, the entity's
surrogate in the file (`e11` is the twelfth entity record), its span, and
whether it sits on its parent's anchor — an implicit constructor has no extent
of its own. The list is the one to read when a corpus type you expected to see
measured is not: find its line, and the outcome says why.

## See it in the city

```bash
codegraph serve model.jsonl --height sum:cognitive --footprint attribute:lloc --carry attribute:mi
```

Two things to get right:

- **Complexity wants `sum:`.** `cognitive` is measured per method and a
  building is a type, so `sum:cognitive` adds up its methods — and each piece
  of code is counted once, because a closure nobody names is charged to the
  method around it.
- **Span measures want `attribute:`.** `lloc`, `cloc`, the Halstead keys and
  `mi` are computed over an entity's whole text, nested functions included, so
  they do not add up: `sum:mi` is a number with no meaning. Read the type's own
  value with `attribute:lloc`, `attribute:mi`.

A stub carries no measures, so the unmeasured warning on a full city is mostly
stubs; `--internal-only` removes them. [Build a complexity
city](/docs/how-to/complexity-city/) covers the scales and `--carry`.

## Measure change history

```bash
codegraph-metrics model.jsonl --src fixtures/ruby/src --history
```

```text
codegraph-metrics: 106 of 109 measured entities joined (106 exact, 0 leading, 0 contained; 3 ambiguous, 0 unjoined) over 31 files; sloc = bca ploc on 106 of 106 exact joins; 0 entities rewritten
codegraph-metrics: history at 17b247076c65 (@1791932959): 27 files, 107 entities blamed → model.history-metrics.jsonl
```

`--history` walks the repository the sources live in — the whole commit graph,
merges included — once for every file, and runs one `git blame` per file for
every measured entity. The result is a **side-car**,
[`model.history-metrics.jsonl`](/docs/reference/artifacts/history-metrics-jsonl/)
beside the model; the model itself is unchanged, because a model describes the
code at one commit and its bytes must not move because time passed.

- **It is measured at the commit the model describes**: the header's
  `repository.commit` when the extractor was given `--repo-*` flags, else
  `HEAD`. `--ref REV` overrides both. Every window — 365 days and 90 days —
  counts back from that commit's own time, never from today, so two runs write
  the same bytes.
- **A file changed since that commit** keeps its file record and gets no entity
  records: the anchors and the blamed lines would describe different text. The
  run says how many.
- **It costs what a blame costs.** About 35 s over BroadleafCommerce's 18 776
  commits and 2 983 files, against under a second for the code metrics; which
  is why it is opt-in.

Then bind it to a channel. `history-file:<measure>` reads the file a type is
written in; `history:<measure>` reads the type's own blame:

```bash
codegraph serve model.jsonl --height history-file:churn_recent --carry history:risk_score,sum:cognitive
```

Churn and the entropies exist per file only; `lines_long` and `lines_recent`
per entity only; the rest at both levels. A measure asked at the wrong level is
refused rather than silently answered with the other:

```text
codegraph: churn_long is measured per file only: use history-file:churn_long
```

`--history-metrics FILE` names a side-car that is not beside the model. The
measures and what each means are on the
[side-car's reference page](/docs/reference/artifacts/history-metrics-jsonl/#measures).

{{< callout type="info" >}}
A risk score is ordinal — rank by it, never read it as a quantity — and the
bug-fix, security and revert counts are heuristics over commit messages. They
are inferences about how people worked, kept in their own file for the same
reason co-change never enters the model.
{{< /callout >}}

## In the desktop app

The app runs every installed pass on its own after an extraction, and again over
a reused model when the passes that measured it are not the ones installed now.
It never runs a pass over a `model.jsonl` you opened directly: that file is
yours. A missing pass is one progress line carrying the install command, a
failing one a line with its exit status; the page is built from whatever model
there is either way. `--history` is not run by the app.

## Related

- [Build a complexity city](/docs/how-to/complexity-city/)
- [Find hidden coupling and dead weight](/docs/how-to/history-joins/)
- [Metrics pass reference](/docs/reference/metrics-pass/)
- [Measures and literals](/docs/reference/metamodel/measures-literals/)
- [`history-metrics.jsonl`](/docs/reference/artifacts/history-metrics-jsonl/)
- [Time as structure](/docs/explanation/time-as-structure/)
