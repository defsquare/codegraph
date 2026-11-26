---
name: discover-5-meaning
description: Step 5 of codegraph's discovery walk — meaning. What each unit does, in domain words, and which part is business, application or infrastructure. Plans and prices `codegraph explain` for free, proposes a scope from the hotspots and the chains of steps 3 and 4, shows what a run would cost from this run's own estimate and asks; only after a yes for a stated scope, provider and ceiling does it send source to that provider, in the background. Then it reads the records — module purposes, the concept of each type, the reading list for a human, the ubiquitous language, the glossary and the polysemous words — and sets the concepts against step 2's roles and step 4's chain positions. On a no, it reads the top hotspot types itself and says so. Use for "what does this code do", "explain this codebase", "which part is the domain", "build a glossary", "what would it cost to explain this code", or when the discover guide routes here. The plan, the estimate and every reading are free; the run is the one paid step of the walk.
argument-hint: "<path-to-repository>"
---

# Step 5 · Meaning

**The question.** What does each unit do, in domain words? Is it business
logic, application logic or infrastructure? Which concepts belong to each?

**The method** is the page https://codegraph.biz/docs/discover/meaning/ — its
commands, its reading rules. You execute it; you add none.

**Cost.** The plan, the estimate and the readings are free. The run sends
each unit's source to a second model provider and costs money: it starts
only after a yes, for a stated scope, provider and ceiling
(`${CLAUDE_PLUGIN_ROOT}/references/consent.md`). Reading a store already
paid for is free.

**Needs.** `codegraph`, step 1's model per main root, the source tree, and
for the run only the provider allowed at intake. The scope comes from step 3's
shortlist and step 4's chains; without them, say the proposal has no ranking.
**Builds**, in the workspace: the plan and the estimates, then
`$ROOT.insights.db` and its export `$ROOT.insights.jsonl`, the readings.

**The person holds, at the end:** each module's purpose, the three readings
per hotspot type, the glossary and its polysemous words — or your own reading
of the top hotspot types, marked as yours.

**Repository:** `$ARGUMENTS`

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph`, `$ROOT` a source root's short name (`main`), `$SRC` its
directory relative to `$REPO`, `$MODEL` is `$WS/$ROOT.jsonl`. `$PROVIDER` is
the provider (`openrouter`, `cloudflare`, `claude-code`); `$LEAF`, `$ROLLUP`
and `$DEPTH` the models and depth (the store's, else the provider's default
model — `openai/gpt-5.6-luna`, or `sonnet` on Claude Code — for both, and 1);
`$SCOPE` comma-separated type or module ids; `$CALLS` the calls the person
agreed to; `$IN`, `$OUT` two prices in dollars per million tokens; `$STDLIB`
the language's row of the page's standard-library table, `["java.*"]` for Java.

## Enter

Read `$WS/discovery.json`.

- **It exists:** take the main roots from `corpus.roots` and the answer of
  `intake.provider`. If `steps.meaning.status` is `done` at the current
  `HEAD`, say what was found and when, and ask whether to run it again or go
  to the gate.
- **It does not:** you were entered directly. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover/SKILL.md` and do its section 1
  (preflight) and the workspace creation of its section 3, without the three
  intake questions.
- **A main root has no model:** read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover-1-structure/SKILL.md` and run its
  **Extract** commands for that root, nothing more.
- **No `intake.provider`:** the provider question has not been asked. Ask it
  with the consent, never before the plan is shown.

Then read `${CLAUDE_PLUGIN_ROOT}/references/rhythm.md`,
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` and
`${CLAUDE_PLUGIN_ROOT}/references/consent.md`.

## Frame

Three sentences: steps 1 to 4 said what the code is and what it touches; this
one says what it is for, by having a model read each unit bottom-up. It is
the one step that sends source to another provider and costs money, so the
plan and the price come first and nothing is sent without a yes. Stopping here
with a glossary is a success.

## Run

Once per main root. Begin each command with the line that puts the tools on
the path:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

**What is already paid for.** A store beside the model names its models,
depth and provider; plan with those, or every unit is planned again. Exit 2
with "no insights store" means nothing was explained yet.

```bash
codegraph insights "$MODEL" > "$WS/reports/$ROOT.insights.txt"
```

**The plan and the estimate**, free, with the provider the run would use: the
one allowed at intake, else the first preflight found, as "would have been".

```bash
codegraph explain "$MODEL" --src "$REPO/$SRC" --provider "$PROVIDER" --model "$LEAF" --rollup-model "$ROLLUP" --depth "$DEPTH" --dry-run --json > "$WS/reports/$ROOT.explain-plan.json"
codegraph explain "$MODEL" --src "$REPO/$SRC" --provider "$PROVIDER" --model "$LEAF" --rollup-model "$ROLLUP" --depth "$DEPTH" --estimate > "$WS/reports/$ROOT.explain-estimate.txt"
```

**The scope.** The module that holds the chain to read first
(`queries/15-chain-ranking.json`, then its rows in `queries/14-chains.json`,
`external` 0) and most of step 3's shortlist; the cheaper option, those types
alone, gives no module record — no purpose, no glossary. Estimate both, with
two prices when you have them (`consent.md`):

```bash
codegraph explain "$MODEL" --src "$REPO/$SRC" --provider "$PROVIDER" --model "$LEAF" --rollup-model "$ROLLUP" --depth "$DEPTH" --scope "$SCOPE" --estimate --price-in "$IN" --price-out "$OUT" --json > "$WS/reports/$ROOT.explain-estimate-scope.json"
```

Propose the scope, not the whole root: the page does not explain everything
on a first visit. The whole root is the block's first figure, the scope its
"Cheaper" line. Never run `explain` here without `--dry-run` or `--estimate`.

**The readings**, when the store holds records — paid before, or by the run
of **Ask**:

```bash
codegraph insights "$MODEL" --level module > "$WS/reports/$ROOT.insights-modules.txt"
codegraph insights "$MODEL" --level type > "$WS/reports/$ROOT.insights-types.txt"
codegraph insights "$MODEL" --max-confidence 0.6 > "$WS/reports/$ROOT.insights-review.txt"
codegraph insights "$MODEL" --concept unknown > "$WS/reports/$ROOT.insights-unknown.txt"
codegraph insights "$MODEL" --polysemy > "$WS/reports/$ROOT.insights-polysemy.txt"
codegraph insights "$MODEL" --concerns > "$WS/reports/$ROOT.insights-concerns.txt"
codegraph insights "$MODEL" --glossary 'java:com.acme.order' > "$WS/reports/$ROOT.insights-glossary-1.txt"
codegraph insights "$MODEL" --id 'java:com.acme.order/Order' > "$WS/reports/$ROOT.insights-type-1.txt"
```

`--glossary` takes a module id from `--level module`, `--id` a type id; one
file per id you read. A module's `ubiquitousLanguage` is in its `--id`. The
words of the names, free, with a store or without:

```bash
codegraph vocabulary "$MODEL" --level module --top 10 > "$WS/reports/$ROOT.vocabulary.txt"
```

**The three readings.** Concepts from `insights-types.txt`; roles from step
2's `reports/$ROOT.wiring.json` (Spring) or its annotation census; positions
from this query, over step 4's saved chains:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/chain-position.sql" "$WS/queries/20-chain-position.sql"
codegraph query "$MODEL" --file "$WS/queries/20-chain-position.sql" --param-file chains="$WS/queries/14-chains.json" --param stdlib="$STDLIB" --all --json > "$WS/queries/20-chain-position.json"
```

**The picture.** Stop any page being served; start this one in the
background with a word `--polysemy` flags (`pet` here), give the URL
`http://127.0.0.1:4177`: the buildings that spell it rise; a building's panel
shows its explanation.

```bash
codegraph serve "$MODEL" --internal-only --host 127.0.0.1 --height vocabulary:pet
```

## Show

From the saved files, never from memory. Per main root:

1. **What is paid for**, in one line: records, models, what they cost.
2. **The consent block** of `consent.md`, filled from the estimates. After a
   no at intake, the block once, as what a run would have cost.

With records:

3. **The modules**: each one's hint and purpose, one line each.
4. **The three readings** for the types of the hotspot chains: concept, role,
   position; a disagreement in bold.
5. **The reading list**: `unknown` and the lowest confidence.
6. **The words**: the top of the glossary, and three polysemous words.
7. **The URL** of the picture.

Repeat `corpus.excluded` first. Without records: your own reading (**Ask**).

## Read

The page's rules, and only those. Define each term once (`words.md`).

- **The plan.** `llm` is sent, `template` described from facts, `reuse`
  already matches. A unit planned `llm` that has a record: its inputs moved
  since, and its record explains the code as it was.
- **Reuse** needs the same models, depth and measures, and a codegraph that
  asks the same words: otherwise the units concerned are planned again. A
  plan that reuses little of a store at the same commit has one of those
  causes, not changed code; say which you can tell (the store's summary names
  its models and depth), and that the others cannot be told apart from here.
- **The provider** changes the plan: Claude Code's instructions are counted
  in every prompt.
- **Concept** in three groups: domain (`entity`, `aggregate`, `valueType`,
  `enum`, `event`, `domainService`, `invariant`, `stateMachine`), application
  (`applicationService`, `command`, `query`, `reaction`, `interface`),
  infrastructure (`repository`, `infrastructureService`, `notDomain`);
  `unknown` is for a person.
- **`confidence`** is the model's own estimate; **`origin`** `template` is a
  fact, `llm` an opinion. Every record is an inference: kind `explanation`.
- **Position** (`20`): `entry`, the chain starts here — the driving side;
  `edge`, the type itself reaches a library or one is above it — where the
  chain leaves the code; `inside`, the domain candidate.
- **Three readings that agree** are a classification to defend; a
  disagreement is a finding, and usually a smell.
- **A polysemous word** is a boundary to look at.

Say what this language does not give (`capabilities.md`) before the person
finds out.

## Ask

Only a person knows these. Ask them together; each can be skipped.

1. **The yes.** The question of `consent.md`: the scope, the narrower one, or
   no run. Only after an explicit yes for that scope, provider and ceiling,
   start the run in the background with `$CALLS` the calls just shown:

   ```bash
   codegraph explain "$MODEL" --src "$REPO/$SRC" --provider "$PROVIDER" --model "$LEAF" --rollup-model "$ROLLUP" --depth "$DEPTH" --scope "$SCOPE" --max-calls "$CALLS" --yes > "$WS/reports/$ROOT.explain-run.log" 2>&1
   ```

   Say it is running. When it ends, read what it reported, then the
   **Run** readings again:

   ```bash
   codegraph insights "$MODEL" --runs > "$WS/reports/$ROOT.insights-runs.txt"
   codegraph insights "$MODEL" --failures > "$WS/reports/$ROOT.insights-failures.txt"
   ```

2. **The reading list.** Who can read the `unknown` and least confident
   records, and is any of them wrong?
3. **On a no**, here or at intake: no model call. Records the store already
   holds are read as **Run** says. For the types of the scope without a
   record, read three to five yourself — the top of the shortlist and of the
   chain to read first — their source with your file tool; give each its concept from the
   groups above, its purpose in one line and the three readings. Ask whether
   that reading is right.

## Write

Re-read `$WS/discovery.json`, then set `steps.meaning`: `status`, `commit`
(`git -C "$REPO" rev-parse HEAD`), `at`, and one finding per main root under
each key:

| Key | Value | Kind | Anchor |
|---|---|---|---|
| `run` | the scope and why, the plan's units, calls, templates, reuse, the provider and models; what the run reported | `derived`; an answer a person gave here is a second finding, `said` | `reports/$ROOT.explain-estimate-scope.json`, or the plan |
| `purposes` | per module: hint and purpose | `explanation` | `reports/$ROOT.insights-modules.txt` |
| `readings` | per hotspot type: concept, role, position, agree or not | `explanation` | `queries/20-chain-position.json` |
| `review` | `unknown` and lowest confidence, with the bound | `explanation` | `reports/$ROOT.insights-review.txt` |
| `language` | the module records' terms and definitions | `explanation` | the module's `insights-type-N.txt` |
| `glossary` | per module: word, concern, sense; without records, the vocabulary's words | `explanation`, or `derived` | `reports/$ROOT.insights-glossary-N.txt` |
| `polysemous` | the words, their senses, their types | `explanation` | `reports/$ROOT.insights-polysemy.txt` |

Every `explanation` carries `origin`: `explain` for the store's records,
`session` for your own reading, anchored to the file and line you read, and
"my reading, not a record" in `note`. A key the step could not fill stays
absent; `REPORT.md` says why. After a no the step is `done`: a no is a
complete answer, and a later yes is a new question (**Go deeper**). After a run, append to `spend` what
`insights-runs.txt` reports for it: day, step `meaning`, provider, model,
calls, dollars — never a price. Each record a person should check is a
question. Append the entry to `$WS/NOTEBOOK.md`.

## Gate

Two lines: what the code is for, in one sentence, and what was spent, in
another. Then:

- **Continue** to step 6, domain: free with codegraph, then the Specy
  plugin's extraction in this session, with no second provider.
- **Go deeper** here: another scope (a new estimate, a new question), or one
  saved query per question (`rhythm.md`).
- **Skip** to another step.
- **Stop.** What they hold: the purposes, the glossary, and the questions.
