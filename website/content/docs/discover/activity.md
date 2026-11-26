---
title: "3 · Activity"
linkTitle: 3 · Activity
weight: 3
---

> **In Claude Code**, `/codegraph:discover-3-activity <path>` runs this step with you: the commands below, a few rows at a time, written to a workspace that resumes. See [Walk a codebase with Claude Code](/docs/how-to/discover-with-claude-code/).

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
sources: the history is per file, the model is per type and method. Give the
model to the same report and it joins them on the file path:

```bash
codegraph history app-history.jsonl --report hotspots --model app.jsonl --top 20
```

```text
note: 654 of 1082 history files have no counterpart in the model (docs, build files, deleted files, anything outside the extracted root).
hotspots of codegraph, joined with the model (top 5 of 428 files, by branchy rank):
  REVISIONS  SLOC  CYCLOMATIC  CYCLE  FIXES  DENSITY  AUTHORS    OWNER  CLASSIC  BRANCHY  TANGLED  FRAGILE  PATH
         45  2158         276      0      1     0.02        2   91% #1        1        1        -       20  packages/cli/src/args.ts
         15   919         241      0      3     0.20        2   89% #1        2        2        -        3  packages/cli/test/explain.test.ts
         13   750         244      0      2     0.15        2   98% #1        3        3        -        8  packages/cli/src/commands/explain.ts
         13   609         208      0      3     0.23        2   84% #1        4        4        -        4  packages/insights/test/run.test.ts
         15   482         122      0      2     0.13        1  100% #1        5        5        -        7  packages/viz/src/three/cityScene.ts
ranks: classic = revisions x sloc, branchy = revisions x cyclomatic, tangled = revisions of a file in a dependency cycle (CYCLE = its files), fragile = revisions x density = fixes; - = not ranked. OWNER = the share of the file's added lines its main author wrote, and that author's row in --report authors.
```

**How to read it.** `SLOC` is the file's source lines and `CYCLOMATIC` the sum
over its operations, both from step 1's model. `CYCLE` is the number of files
locked in a dependency cycle with this one, itself included; 0 when it is in
none. `AUTHORS` is how many people touched the file. `OWNER` is the share of
its added lines that its main author wrote, then that author's row in the
`authors` report below: two files with the same `#` have the same owner. With
`--json` each row also has `ownerLastSeen`, the day that author last committed
anywhere in the history. None of this names anyone. The four right-hand columns are the file's **rank** in
four families, and each family finds a different kind of trouble:

- **classic**: revisions × lines. Large code that is worked on.
- **branchy**: revisions × cyclomatic. Complicated code that is worked on. It
  is the order of the table; `--rank classic`, `tangled` or `fragile` chooses
  another.
- **tangled**: revisions, among the files that are in a dependency cycle. A
  change there pulls the other files of the cycle with it.
- **fragile**: revisions × fix density, which is the number of fix commits.
  Where bugs are repaired again and again.

A `-` is "not ranked": no effort, or nothing measured in that family. A file of
constants has no cyclomatic complexity, and that is not the same as being
simple. A file near the top of two or three families belongs on the shortlist;
a file that tops only one tells you which kind of trouble it is. The test file
in second place above is the triage rule at work: a test that is hard to keep
green.

Two things to know about the join. The model's paths are relative to the
source root you extracted, the history's to the repository root, so they are
matched on the path **suffix**: the model must come from a directory inside
the mined clone. And the first line counts the history files that found no
counterpart: docs, build files, files deleted since, anything outside the
extracted root. That is expected; a count close to the total means the model
was extracted from somewhere else.

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
project: the code nobody can explain). The joined table above already says
both per hotspot, as `OWNER` and `ownerLastSeen`; this report is where the
names are, and `#3` there is its third row. The bot on the third line is why you filter before you count.

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
top-level module?** The summary answers when it is given the model:

```bash
codegraph history app-history.jsonl --report summary --model app.jsonl
```

```text
history of codegraph: 378 commits by 5 authors over 1082 files
  span:         2026-08-18 .. 2026-11-18 (92 days)
  churn:        +826970 / -214341 (1041311 lines)
  firefighting: 50 fixes (13.2% of commits), 0 reverts
  momentum:     0.85x (last 90 days vs lifetime rate)
  cross-module: 54 of 206 commits touching the model cross its top-level directories (26.2%; 11 at its root)
```

A top-level module is here a top-level **directory** of the model: the first
path segment below the directory all its files share. In Java that is the
first package below the common root. Only commits that touch the model are
counted, and those over 30 files are left out, as for coupling. Roughly a
third of commits crossing modules is what a stable layered application shows;
two thirds is a codebase growing feature by feature through every layer at
once. That share is what decides whether the folders are boundaries or filing.

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
