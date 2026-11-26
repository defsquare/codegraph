---
name: discover-6-domain
description: Step 6 of codegraph's discovery walk — domain. Which part of the codebase is the business and which is plumbing, through the hexagonal lens, and what is the domain model behind the code. Writes the per-type fact dossiers (`codegraph domain-facts`), measures each module's purity, places each type in step 4's chains, finds the invariant evidence (guarded writes, throw sites, enum-typed state), and gives a verdict per module — domain, application, infrastructure, or undecided. Then it hands over to the Specy plugin's `domain-extract-from-code`, which writes a `.domain` model and a refactoring report that the walk weighs by step 3's hotspot ranks, and validates the model with `specy validate` when that command is installed. Without the Specy plugin it stops at the verdicts and prints the install line. Use for "which part is the domain", "is this hexagonal", "extract the domain model", "what are the aggregates", "what should we refactor first", or when the discover guide routes here. The facts, the measures and the verdicts are free and deterministic; the extraction is this session reading, with no second provider.
argument-hint: "<path-to-repository>"
---

# Step 6 · Domain

**The question.** Which part of this codebase is the domain, its structure
and its behaviour, separated from application and infrastructure? And what
is the domain model underlying the code?

**The method** is the page https://codegraph.biz/docs/discover/domain/ — its
commands, its reading rules. You execute it; you add none.

**Cost.** The facts, the three measures and the verdicts: free, seconds. The
extraction is the Specy plugin's skill, run in this session by this
session's model: no second provider, no spend in `spend`. It writes `specy/`
at the repository root, which `git status` shows: that directory is the
person's.

**Needs.** `codegraph` and step 1's model per main root. Better with step 4's
chains and step 5's records; it says what is missing without them. For the
model: the Specy plugin; to validate it: the `specy` command.
**Builds**, in the workspace: `$ROOT.domain-facts.json`, two saved queries,
the verdicts; through Specy, `specy/<name>.domain`, its report, its meta file.

**The person holds, at the end:** a verdict per module with its evidence,
and, with Specy, a model of the business and the first refactorings to do.

**Repository:** `$ARGUMENTS`

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph`, `$ROOT` is a source root's short name (`main`), `$MODEL`
is `$WS/$ROOT.jsonl`, and `$STDLIB` is the language's row of step 5's
standard-library table (https://codegraph.biz/docs/discover/meaning/),
`["java.*"]` for Java.

## Enter

Read `$WS/discovery.json`.

- **It exists:** take the main roots from `corpus.roots`. If
  `steps.domain.status` is `done` at the current `HEAD`, say what was found
  and when, and ask whether to run it again or go to the gate.
- **It does not:** you were entered directly. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover/SKILL.md` and do its section 1
  (preflight) and the workspace creation of its section 3, without the three
  intake questions.
- **A main root has no model:** read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover-1-structure/SKILL.md` and run its
  **Extract** commands for that root, nothing more.
- **No records from step 5** (`codegraph insights "$MODEL"` exits 2): say
  what the model will lack — the extraction reads the source alone and sees
  what it samples — and ask whether to go on or to go back to step 5.
- **No `queries/14-chains.json`:** step 4 has not run, and the position in
  the chains is missing: say so; purity and invariant evidence still run.

Then read `${CLAUDE_PLUGIN_ROOT}/references/rhythm.md` and
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md`. Note whether skills named
`specy:…` are available to you, and whether `command -v specy` finds the
command.

## Frame

Three sentences: step 5 explained each unit; this step asks which of them
are the business and which the plumbing, from three measures of the graph
first, and then has the Specy plugin state the business as a model a domain
expert can correct. The measures are free and take seconds. The model is
this session reading, and it is only as good as the evidence it is given.

## Run

Once per main root. Begin each command with the line that puts the tools on
the path:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

**The dossiers.** With `--framework spring` on Spring code (step 2 found
it), without it on any other:

```bash
codegraph domain-facts "$MODEL" --framework spring --out "$WS/$ROOT.domain-facts.json"
codegraph domain-facts "$MODEL" --out "$WS/$ROOT.domain-facts.json"
```

**Purity**, the standard library left out:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/purity.sql" "$WS/queries/21-purity.sql"
codegraph query "$MODEL" --file "$WS/queries/21-purity.sql" --param stdlib="$STDLIB" --all --json > "$WS/queries/21-purity.json"
```

**Position in the chains**: step 5's `queries/20-chain-position.json`. If it
is missing and step 4's chains exist:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/chain-position.sql" "$WS/queries/20-chain-position.sql"
codegraph query "$MODEL" --file "$WS/queries/20-chain-position.sql" --param-file chains="$WS/queries/14-chains.json" --param stdlib="$STDLIB" --all --json > "$WS/queries/20-chain-position.json"
```

**Invariant evidence**:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/invariant-evidence.sql" "$WS/queries/22-invariant-evidence.sql"
codegraph query "$MODEL" --file "$WS/queries/22-invariant-evidence.sql" --all --json > "$WS/queries/22-invariant-evidence.json"
```

For the types of the hotspot chains with records, the preconditions step 5
recorded are the other half: `reports/$ROOT.insights-type-N.txt`, or one more
`codegraph insights "$MODEL" --id '<type id>'` saved the same way.

**The picture.** Stop any page being served, start this one in the
background, give the URL `http://127.0.0.1:4177`: the **Graph** tab in module
mode shows the cut the verdicts are about; a building's panel shows its
explanation.

```bash
codegraph serve "$MODEL" --internal-only --host 127.0.0.1
```

**The hand-over**, only with the Specy plugin and after the verdicts are
written (**Write**). Invoke `specy:domain-extract-from-code` with the
repository's path. Tell it, in these words: the discovery workspace is
`.codegraph/` (`discovery.json`); per main root, the records are
`.codegraph/$ROOT.insights.jsonl` and the dossiers
`.codegraph/$ROOT.domain-facts.json`; the source root is `corpus.roots[].src`;
step 5 already decided what to pay for, so it does not run `codegraph
explain`; the excluded paths, the names a person gave (`said` findings) and
the hotspot shortlist (`steps.activity.findings.hotspots`) are in the state.
Follow it to its end; it asks its own questions. Then, when `specy` exists:

```bash
specy validate "$REPO/specy/petclinic.domain" > "$WS/reports/specy-validate.txt" 2>&1
```

with the `.domain` it wrote in place of `petclinic.domain`.

**Without the Specy plugin**, stop at the verdicts. Print the install line,
which is the person's to run, and say what it gives:

```text
claude plugin marketplace add specy-ai/skills && claude plugin install specy
```

## Show

From the saved files, never from memory. Per main root:

1. **Purity** (`21`): the modules, purest first.
2. **The verdict per module**, one line each, with its three measures: purity,
   how many of its types sit at `entry`, `inside`, `edge` (`20`), its guarded
   writes and enum-typed state (`22`).
3. **The invariant evidence**: the three types with the most `guarded` or a
   `state`, each with one file and line from its dossier.
4. With Specy: the `.domain` by construct (contexts, aggregates, entities,
   value types, events), what `specy validate` said, and the first smells of
   the refactoring report with the hotspot rank of their file.
5. **The context map**: each candidate context with the evidence it rests on.
6. **The URL** of the picture.

Repeat `corpus.excluded` first: an excluded path is shown as excluded.

## Read

The page's rules, and only those. Define each term once (`words.md`).

- **Purity**: a pure module is the domain candidate; a module whose
  references are mostly stubs is plumbing; the mixed ones are where the
  application services sit. Framework annotations count as library
  references, so purity is low on annotated code: compare modules, never a
  number with a threshold.
- **Position**: where chains start is the driving side; at their edge a type
  reaches a library itself; inside and pure is the domain.
- **Invariant evidence**: `guarded` is a write to the type's own fields in an
  operation that throws — a rule enforced where the state changes; `state` an
  enum-typed field the type drives, a state machine waiting to be named. A
  guard written as a library call is a call, not a throw site.
- **The verdict**: where the three measures agree, theirs; where they do
  not, undecided, with which measure points where.
- **The model** is the Specy skill's reading of the records, the dossiers and
  the source: an inference, kind `explanation`, origin `session`, until a
  domain expert confirms it. `specy validate` says the file is well-formed,
  not that it is right.
- **A smell** weighs by the hotspot rank of the file it sits in: in the top
  hotspot it is the first refactoring, untouched for years it is a note.
- **The context map**: modules that cluster by chain, change together and
  share a vocabulary are one context; two joined by a cycle of step 1 are
  not two.

Say what this language does not give (`capabilities.md`): no enum kind, no
`state`; no annotation, no framework role.

## Ask

Only a person knows these. Ask them together; each can be skipped.

1. **Is each undecided module domain, application or infrastructure?**
2. **Are these the aggregates, their invariants, the events?** The elements
   of the `.domain` a domain expert confirms first. A yes or a correction is
   `said`; the model is not edited by the walk.
3. **Which refactoring is worth doing this quarter?** From the weighted list.

## Write

Re-read `$WS/discovery.json`, then set `steps.domain`: `status`, `commit`
(`git -C "$REPO" rev-parse HEAD`), `at`, and one finding per main root under
each key:

| Key | Value | Kind | Anchor |
|---|---|---|---|
| `verdicts` | per module: the verdict or undecided, purity, positions, guarded, state | `derived`; the rule in `note` | `queries/21-purity.json` |
| `model` | the `.domain` path, its counts by construct, what `specy validate` said | `explanation`, origin `session` | `../specy/<name>.domain` |
| `toConfirm` | the aggregates, invariants and events to confirm first | `explanation`, origin `session` | `../specy/<name>.domain` |
| `refactoring` | each smell, its file, its hotspot rank, first ones first | `explanation`, origin `session` | the report, `../specy/…` |
| `contextMap` | candidate contexts and the evidence of each boundary | `explanation`, origin `explain` | `reports/$ROOT.insights-modules.txt` |

Write `verdicts` before the hand-over: the extraction reads them. Without the
Specy plugin, `model`, `toConfirm` and `refactoring` stay absent and
`REPORT.md` says why. What a person confirms is a second finding, `said`;
each element nobody confirmed is a question for a domain expert. Append the
entry to `$WS/NOTEBOOK.md`.

## Gate

Two lines: where the domain is, in one sentence, and what the model holds, in
another. This is the last step of the walk:

- **Go deeper** here: another module, one saved query per question
  (`rhythm.md`), or, with Specy, `/specy:domain-dialogue` to question the
  model, `/specy:domain-refactor` to redesign it.
- **Back** to any step.
- **Stop.** What they hold: the verdicts, the model, the first refactorings
  and the questions for the team. Rewrite `REPORT.md` and say where it is.
