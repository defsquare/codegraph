---
title: "3 · Activity"
linkTitle: 3 · Activity
weight: 3
---

**The question.** Where does the effort go, who spends it, and what changes
together? Which complex code is worked on often? Which co-changes have no
structural explanation?

Steps 1 and 2 read the code. This step reads the **commits**, and it is the
step that turns the size and complexity tables into a priority list. The idea,
from Adam Tornhill's behavioural code analysis, is simple: complex code that
nobody touches costs nothing today; complex code that changes every week is
where the bugs, the delays and the onboarding pain are. Those are the
**hotspots**, and they are where the first hours of reading go.

**Before you start:** a git clone with its history (not an exported tree or a
squashed import), and the `app.jsonl` of step 1 extracted from a directory
*inside* that clone. Everything here runs in seconds and calls nothing.

## Mine the history

```bash
codegraph scm ~/src/app --out app-history.jsonl
```

```text
mined ~/src/app -> app-history.jsonl
  2091 commits by 202 authors, 801 file lineages, 14023 changes, 2008-09-01 .. 2026-08-27
```

One pass over `git log`, renames resolved so one path names one file across
its whole life, into a `history.jsonl` with no code intelligence in it.
`--since 2024-01-01` limits how far back it looks; one or two years is the
right first window on an old project, because too much history hides recent
trends and flags hotspots that went cold years ago.

## Read the shape of the effort

```bash
codegraph history app-history.jsonl --report summary
```

```text
history of gson: 2091 commits by 202 authors over 801 files
  span:         2008-09-01 .. 2026-08-27 (6569 days)
  churn:        +406220 / -344006 (750226 lines)
  firefighting: 303 fixes (14.5% of commits), 5 reverts
  momentum:     1.43x (last 90 days vs lifetime rate)
```

**How to read it.** `firefighting` is the share of commits whose subject
looks like a fix; it is a heuristic and is labelled one. Above a quarter, the
team spends its time repairing. `momentum` above 1 means the project is
committing faster now than over its life; below 1 it is winding down or
stable, and the hotspots may be historical.

## Find the hotspots

```bash
codegraph history app-history.jsonl --report hotspots --top 20
```

```text
hotspots of codegraph (top 5 of 461 files by revisions):
  REVISIONS  CHURN  FIXES  DENSITY  AUTHORS  PATH
         42   2166      3     0.07        1  PLAN.md
         30    631      0     0.00        2  README.md
         26   1804      0     0.00        1  packages/cli/src/args.ts
         20   1324      3     0.15        1  packages/viz/src/main.ts
```

**How to read it.** `REVISIONS` is how many commits touched the file, and it
follows a power law: a few files take most of the commits. `CHURN` is lines
added plus deleted. `FIXES` and `DENSITY` (fixes per revision) say where bugs
are repaired repeatedly. `AUTHORS` says how many people share the file.

Two expectations to check against: the hotspots are usually 4 to 6% of the
files, and the top ones take 10 to 15% of all commits. If effort is spread
evenly, either the codebase is unusually healthy or the history is unusable
(squashed merges, a mass reformat, a bot doing most of the commits). Look at
the churn before trusting a flat table.

Then triage by name before reading anything. A build file or a changelog with
80 revisions is a false positive; a `*Manager`, `*Impl`, `*Util` or
`Abstract*` class in the top ten is the usual suspect; a test file in the top
ten is a test that is hard to keep green.

## Join effort with complexity

A hotspot is complexity **times** effort, and the two tables come from two
sources: the history is per file, the model is per type and method. Join them
on the file path. First, complexity per file from the model:

```sql
.mode csv
.headers on
.output app-complexity.csv
SELECT f.path AS file,
       sum(CASE WHEN em.key = 'sloc'
                 AND k.name IN ('class', 'interface', 'enum', 'record', 'annotation')
                THEN em.value END) AS sloc,
       sum(CASE WHEN em.key = 'cyclomatic' THEN em.value END) AS cyclomatic
  FROM entity e
  JOIN file f ON f.id = e.anchor_file_id
  JOIN kind k ON k.id = e.kind_id
  LEFT JOIN entity_metric em ON em.entity_id = e.id
 WHERE e.is_stub IS NOT 1
 GROUP BY f.path ORDER BY cyclomatic DESC;
.output stdout
```

Then the hotspots as data:

```bash
codegraph history app-history.jsonl --report hotspots --top 500 --json > app-hotspots.json
```

Join the two on the path in a spreadsheet, a notebook or ten lines of any
language, and sort by `revisions × cyclomatic`. Two things to know about the
join: the model's paths are relative to the source root you extracted, the
history's to the repository root, so match on the **suffix**; and a file in
the history with no counterpart in the model (docs, build files, anything
outside the extracted root) is expected, not an error.

{{< callout type="info" >}}
A single `hotspots` report that ranks files by revisions × complexity from a
model given with `--model` is planned. Until it lands, the join above is two
files and a spreadsheet, and the rank family it should produce is worth
knowing anyway: **classic** (revisions × lines), **branchy** (revisions ×
cyclomatic), **tangled** (revisions × membership in a cycle from step 1) and
**fragile** (revisions × fix density). Each finds a different kind of trouble.
{{< /callout >}}

## See who works where

```bash
codegraph history app-history.jsonl --report authors --top 10
```

```text
authors of gson (202):
  COMMITS   CHURN  FILES  OWNS  FIXES  AUTHOR
      557  263087    540   356     85  Inderjeet Singh <inder123@gmail.com>
      278  282605    419   208     42  Jesse Wilson <jesse@swank.ca>
      232    1468     18     0      0  dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>
```

`OWNS` is the number of files this author contributed the most lines to.
Two readings matter for discovery: **knowledge concentration** (one author
owns most of the hotspots: a truck-factor risk, and the person to interview
first) and **knowledge loss** (the owner of a hotspot no longer works on the
project: the code nobody can explain). The bot on the third line is why you
filter before you count.

{{< callout type="warning" >}}
Authorship data describes how a team works. It is never a measure of a
person's performance, and using it that way destroys the trust that makes
the rest of the analysis possible. Normalise aliases (the same person appears
twice in the table above), drop bots, and when in doubt keep the report at
the level of files, not names.
{{< /callout >}}

## Find what changes together

Two files that keep appearing in the same commits are **coupled in practice**,
whatever the code says:

```bash
codegraph history app-history.jsonl --report coupling --top 20
```

```text
logical coupling of codegraph (top 5 of 11 pairs; support >= 3, confidence >= 50.0%):
  SUPPORT    CONF  REV-A  REV-B  PAIR
       13   86.7%     20     15  packages/viz/src/main.ts + packages/viz/src/three/cityScene.ts
```

`SUPPORT` is the number of shared commits; `CONF` is support over the rarer
file's revisions. Too many pairs: raise `--min-support`. None: lower
`--min-confidence`. Sweeping commits (over 30 files) are skipped, since a
reformat couples everything with everything.

Now the two reports that need both graphs at once, the code's and the
history's. Both take the model with `--model`:

```bash
codegraph history app-history.jsonl --report hidden    --model app.jsonl
codegraph history app-history.jsonl --report deadweight --model app.jsonl
```

- **Hidden coupling** is pairs that co-change though **no path** links them
  in the declared dependency graph, in either direction. These are the
  message formats agreed by convention, the copy-pasted algorithms, the
  implicit protocols: the surprises, and surprises are where bugs live.
- **Dead weight** is declared dependencies that **never** co-change. Stable
  interfaces show up here, which is fine, and so does the layer nobody has
  touched since a rewrite. Check `REV-FROM` and `REV-TO` before reading a
  pair as dead: two files that barely changed prove nothing.

Each report says how many history files joined the model; a low number means
the model was extracted from somewhere other than inside the mined clone.
[Find hidden coupling and dead weight](/docs/how-to/history-joins/) covers the
thresholds and the join.

Finally, the number step 2 was waiting for: **how often does a commit cross a
top-level module?** Fold the coupling pairs to their first path segment and
count the pairs whose segments differ. Roughly a third of commits crossing
modules is what a stable layered application shows; two thirds is a codebase
growing feature by feature through every layer at once. That share is what
decides whether the folders are boundaries or filing.

## See it move

```bash
codegraph history app-history.jsonl --serve --host 127.0.0.1
```

The file-level replay: buildings are files, a timeline scrubs the commits,
co-change is drawn as dashed arcs so it can never pass for a dependency.
[Replaying a project's history](/docs/tutorials/history-replay/) walks through
it, and `snapshots` + `replay` give the same at entity level over sampled
revisions.

## Write down

- The five to ten hotspots after triage, each with its revisions, its
  complexity from step 1, and its fix density.
- The owners of those hotspots, and whether they are still around.
- The hidden couplings, with their support: each is a question for the team.
- The cross-module co-change share.

Next: [Stimuli and flows](/docs/discover/stimuli/).

## Related

- [`codegraph scm`](/docs/reference/cli/scm/) and [`codegraph history`](/docs/reference/cli/history/)
- [`history.jsonl` reference](/docs/reference/artifacts/history-jsonl/)
- [Find hidden coupling and dead weight](/docs/how-to/history-joins/)
- [Time as structure](/docs/explanation/time-as-structure/)
- [Prior art](/docs/explanation/prior-art/) for what codegraph took from *Your Code as a Crime Scene*
