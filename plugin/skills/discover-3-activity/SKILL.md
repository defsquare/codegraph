---
name: discover-3-activity
description: Step 3 of codegraph's discovery walk — activity. Where does the effort go, who spends it, and what changes together. Mines the git history, finds the hotspots (complex code that is changed often) by joining commits with the model's size and complexity, shows how concentrated the knowledge is without naming anyone, finds files that change together with no dependency between them, and measures how often a commit crosses a module. Use for "where are the hotspots", "what should I read or refactor first", "who knows this code", "what changes together", "is this codebase a bus-factor risk", or when the discover guide routes here. Free and deterministic — seconds, no model call, nothing sent anywhere.
argument-hint: "<path-to-repository>"
---

# Step 3 · Activity

**The question.** Where does the effort go, who spends it, and what changes
together? Which complex code is worked on often? Which co-changes have no
structural explanation?

**The method** is the page https://codegraph.biz/docs/discover/activity/ —
its commands, its reading rules. You execute it; you add none.

**Cost.** Free and deterministic. Seconds. No model call, nothing leaves the
machine.

**Needs.** `codegraph`, a git clone with its history, and the model of step 1
for each main root. **Builds**, in the workspace: the mined history, seven
saved reports, and the history side-car the city reads.

**The person holds, at the end:** a shortlist of five to ten hotspots — where
the first hours of reading go — and what is known of who holds them.

**Repository:** `$ARGUMENTS`

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph`, `$ROOT` is a source root's short name (`main`), `$MODEL`
is `$WS/$ROOT.jsonl` and `$HISTORY` is `$WS/history.jsonl`.

## Enter

Read `$WS/discovery.json`.

- **It exists:** take the main roots from `corpus.roots`. If
  `steps.activity.status` is `done` at the current `HEAD`, say what was found
  and when, and ask whether to run it again or go to the gate.
- **It does not:** you were entered directly. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover/SKILL.md` and do its section 1
  (preflight) and the workspace creation of its section 3, without the three
  intake questions.
- **A main root has no model:** read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover-1-structure/SKILL.md` and run its
  **Extract** commands for that root, nothing more.
- **Not a git repository, or a shallow clone** (`corpus.shallow`): this step
  has nothing to mine. Say so, give `git fetch --unshallow` as theirs to run,
  write the step as `skipped` with the reason, and go to the gate.

Then read `${CLAUDE_PLUGIN_ROOT}/references/rhythm.md` and
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md`.

## Frame

Three sentences: steps 1 and 2 read the code; this one reads the commits, and
turns the size and complexity tables into a priority list. Complex code that
nobody touches costs nothing today; complex code that changes every week is
where the bugs and the onboarding pain are. It takes seconds and costs
nothing.

If `intake.predict` is true, ask now which file or module they expect at the
top, and write the answer down before you run anything.

## Run

Begin each command with the line that puts the tools on the path:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

**Mine the history**, once for the repository:

```bash
codegraph scm "$REPO" --out "$HISTORY" > "$WS/history.log" 2>&1
```

**The reports that need only the history:**

```bash
codegraph history "$HISTORY" --report hotspots --top 30 --json > "$WS/reports/hotspots-files.json"
codegraph history "$HISTORY" --report authors --top 10 --json > "$WS/reports/authors.json"
codegraph history "$HISTORY" --report coupling --top 30 --json > "$WS/reports/coupling.json"
```

**The reports that join the history with a model**, once per main root:

```bash
codegraph history "$HISTORY" --report summary --model "$MODEL" --json > "$WS/reports/$ROOT.summary.json"
codegraph history "$HISTORY" --report hotspots --model "$MODEL" --top 30 --json > "$WS/reports/$ROOT.hotspots.json"
codegraph history "$HISTORY" --report hidden --model "$MODEL" --json > "$WS/reports/$ROOT.hidden.json"
codegraph history "$HISTORY" --report deadweight --model "$MODEL" --json > "$WS/reports/$ROOT.deadweight.json"
```

Each joined report says on stderr how many history files found no counterpart
in the model. Docs, build files and deleted files are expected there; if
almost none joined, the model was not extracted inside this clone: stop and
say so. A model that is not a model exits 3 and prints no report.

**The window.** Read `span` in the summary. The page's rule: on a history
longer than two years, the first window is one or two years, because old
activity hides recent trends. If the span is longer, ask (see Ask), then mine
again with the date chosen and run the reports again:

```bash
codegraph scm "$REPO" --since 2024-01-01 --out "$HISTORY" > "$WS/history.log" 2>&1
```

**The side-car and the picture.** The side-car measures each file's recent
history at the model's commit; the city reads it. Stop any page being served,
start this one in the background, give the URL `http://127.0.0.1:4177`, City
tab: a building's height is the recent churn of its file.

```bash
codegraph-metrics "$MODEL" --history
codegraph serve "$MODEL" --height history-file:churn_recent --carry history:risk_score --internal-only --host 127.0.0.1
```

Without `codegraph-metrics`, say so in one line and serve the replay of the
history instead: buildings are files, a timeline scrubs the commits.

```bash
codegraph history "$HISTORY" --serve --host 127.0.0.1
```

## Show

From the saved files, never from memory.

1. **The shape of the effort** (`summary`): commits, authors, the span, the
   share of fixes, the momentum.
2. **The hotspots** (`$ROOT.hotspots.json`): the top five by `branchy` rank,
   each with its revisions, lines, cyclomatic complexity, fix density, and
   its rank in the three other families. Then any file that tops another
   family and is not among those five.
3. **What did not join** in one line: the busiest files of
   `hotspots-files.json` that are not code of this root (a build file, a
   changelog) — named, so nobody wonders where they went.
4. **Who holds the hotspots**: for each of the five, how many authors, the
   main author's share, and the day that author was last seen. No name: an
   author is their row in the authors report (`ownerRank`), and two files
   with the same row have the same main author. Say how many authors hold
   the five.
5. **What changes together** (`coupling`): the three strongest pairs. Then
   the hidden couplings, each with its support — or that the report found
   none at its thresholds. Then how many declared dependencies never
   co-change.
6. **The cross-module share**, and what it says of step 2's third check.
7. **The URL** of the picture.

Repeat `corpus.excluded` first: an excluded path is shown as excluded.

## Read

The page's rules, and only those. Define each term once (`words.md`).

- **Firefighting** is the share of commits whose subject reads as a fix: a
  heuristic, and labelled one. Above a quarter, the team spends its time
  repairing. **Momentum** above 1 means the project commits faster now than
  over its life; below 1 it is winding down or stable, and its hotspots may
  be historical.
- **Revisions** follow a power law: a few files take most of the commits.
  Expect the hotspots to be 4 to 6% of the files and the top ones 10 to 15%
  of the commits. If effort is spread evenly, the codebase is unusually
  healthy or the history is unusable — squashed merges, a mass reformat, a
  bot. Look at the churn before trusting a flat table.
- **Triage by name before reading anything.** A build file or a changelog is
  a false positive; a `*Manager`, `*Impl`, `*Util` or `Abstract*` in the top
  ten is the usual suspect; a test file in the top ten is a test that is hard
  to keep green.
- **The four families**, each a different trouble: **classic** is revisions ×
  lines, large code that is worked on; **branchy** is revisions × cyclomatic,
  complicated code that is worked on; **tangled** is revisions among the
  files in a dependency cycle, where a change pulls the cycle with it;
  **fragile** is revisions × fix density, the fixes, where bugs are repaired
  again and again. Not ranked (`null`) is no effort or nothing measured — not
  "simple". A file near the top of two or three families belongs on the
  shortlist.
- **Ownership.** One author holding most of the hotspots is knowledge
  concentration: a risk, and the person to interview first. A hotspot whose
  main author was last seen long ago is knowledge loss: the code nobody can
  explain. A bot or an alias in the authors table distorts both: say when you
  see one. Authorship describes how a team works; it is never a measure of a
  person.
- **Coupling.** `support` is the number of shared commits; `confidence` is
  support over the rarer file's revisions. Commits over 30 files are skipped.
  **Hidden coupling** is co-change with no path in the declared graph, either
  way: conventions, copies, implicit protocols — each a question for the
  team. **Dead weight** is a declared dependency that never co-changes:
  stable interfaces are there, and so is the layer nobody touched; two files
  that barely changed prove nothing.
- **The cross-module share.** A top-level module is a top-level directory of
  the model. Roughly a third of commits crossing is what a stable layered
  application shows; two thirds is a codebase growing feature by feature
  through every layer at once.

## Ask

Only a person knows these. Ask them together; each can be skipped.

1. **The window** — only when the span is over two years: everything, or the
   last one or two years? Give the two dates.
2. **Is any of these hotspots a false positive?** Generated, a registry that
   every feature touches, a file renamed in bulk. Each yes goes to
   `corpus.excluded`, `by: "person"`.
3. **Is whoever wrote most of each hotspot still on the team?** Give the
   share, the row and the last-seen day; the names are in
   `reports/authors.json` for them to open. Record the answers as `said`, by
   role, never by name.

## Write

Names stay in `reports/authors.json`. You write none in `discovery.json`, in
`NOTEBOOK.md` or in `REPORT.md`: a share, a count, a date.

Re-read `$WS/discovery.json`, then set `steps.activity`: `status`, `commit`
(`git -C "$REPO" rev-parse HEAD`), `at`, and under each key:

| Key | Value | Kind | Anchor |
|---|---|---|---|
| `hotspots` | per main root: five to ten files after triage, each with revisions, lines, cyclomatic, fix density, the four ranks | `co-change` | `reports/$ROOT.hotspots.json`; the window mined and the triage in `note` |
| `owners` | per main root: for each of those files, authors, the main author's share, their row in the authors report, last seen | `co-change` | `reports/$ROOT.hotspots.json` |
| `hiddenCouplings` | per main root: the pairs with their support, or "none found" with the thresholds | `co-change` | `reports/$ROOT.hidden.json` |
| `crossModuleShare` | per main root: commits counted, commits crossing, the share, the directories | `co-change` | `reports/$ROOT.summary.json` |

Each hidden coupling is also a question for the team: add it to `questions`.
A prediction made at the frame is a `said` finding in the notebook, with the
gap. Append the step's entry to `$WS/NOTEBOOK.md`.

## Gate

Two lines: the shortlist in one sentence, the knowledge risk in another.
Then:

- **Continue** to step 4, stimuli and flows: free, seconds. It reads this step's hotspots to rank the chains.
- **Go deeper** here: one saved query per question (`rhythm.md`).
- **Skip** to another step.
- **Stop.** What they hold: the shortlist — the place to start reading — and
  the questions for the team.
