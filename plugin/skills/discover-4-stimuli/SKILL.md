---
name: discover-4-stimuli
description: Step 4 of codegraph's discovery walk — stimuli and flows. What reacts to the outside world or to time, and what does each reaction reach. Builds the inventory of entry points (REST endpoints, controllers, message listeners, scheduled jobs, CLI verbs, framework callbacks) from a table of framework names, says which layer found each one — an annotation, a supertype, a name, or no caller — walks the call chain behind each on facts and with candidates, groups the chains into candidate use cases, ranks them by the hotspots they cross, and lists what nothing reaches. Use for "what are the entry points", "what are the use cases", "what happens when this endpoint is called", "what is the call chain", "what is dead code", "where do I start reading", or when the discover guide routes here. Free and deterministic — seconds to a minute, no model call, nothing sent anywhere.
argument-hint: "<path-to-repository>"
---

# Step 4 · Stimuli and flows

**The question.** What reacts to the outside world or to time, and what does
each reaction reach? Which chain is a use case, and which one to read first?

**The method** is the page https://codegraph.biz/docs/discover/stimuli/ —
its queries, its reading rules. You execute it; you add none.

**Cost.** Free and deterministic. Seconds; a minute on a hundred thousand
entities. No model call, nothing leaves the machine.

**Needs.** `codegraph`, and the model of step 1 for each main root. Better with
step 2's census and step 3's hotspots; it says what it lacks without them.
**Builds**, in the workspace: the stack table as applied, nine saved queries,
one activity report.

**The person holds, at the end:** the entry points by kind, a reading order
per use case, the chain to read first, and what nothing reaches.

**Repository:** `$ARGUMENTS`

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph`, `$ROOT` is a source root's short name (`main`), `$MODEL`
is `$WS/$ROOT.jsonl` and `$HISTORY` is `$WS/history.jsonl`.

## Enter

Read `$WS/discovery.json`.

- **It exists:** take the main roots from `corpus.roots`. If
  `steps.stimuli.status` is `done` at the current `HEAD`, say what was found
  and when, and ask whether to run it again or go to the gate.
- **It does not:** you were entered directly. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover/SKILL.md` and do its section 1
  (preflight) and the workspace creation of its section 3, without the three
  intake questions.
- **A main root has no model:** read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover-1-structure/SKILL.md` and run its
  **Extract** commands for that root, nothing more.

Then read `${CLAUDE_PLUGIN_ROOT}/references/rhythm.md`,
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` and
`${CLAUDE_PLUGIN_ROOT}/references/stacks.md`: the tables, what each was
checked on, what each does not find.

## Frame

Three sentences: the first three steps looked at the code from inside; this
one starts from outside, the way the business sees the system — what it
reacts to, and what runs behind each reaction. It is free and takes seconds.
It rests on a table of framework names, so it finds what the table knows, and
shows the rest as unclassified.

## Run

Once per main root. Begin each command with the line that puts the tools on
the path:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

**The supertype census.** The annotation census is step 2's
(`queries/08-annotations.json`); run that query now if the file is missing.

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/supertypes.sql" "$WS/queries/10-supertypes.sql"
codegraph query "$MODEL" --file "$WS/queries/10-supertypes.sql" --json > "$WS/queries/10-supertypes.json"
```

**The stack table.** Pick the one `stacks.md` gives for this framework, and
copy it into the workspace. For Spring:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/references/stacks/spring.json" "$WS/queries/11-stack.json"
```

The others are `aspnet.json`, `nestjs.json`, `phoenix.json` and `rails.json`.
No table for this framework: say so, and build one as `stacks.md` describes.
`$WS/queries/11-stack.json` is yours to edit with your file tool; every name
you add on your own reading is a guess.

**The inventory**, then the same rows grouped by kind:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/entry-points.sql" "$WS/queries/12-entry-points.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/entry-point-kinds.sql" "$WS/queries/13-entry-point-kinds.sql"
codegraph query "$MODEL" --file "$WS/queries/12-entry-points.sql" --param-file stack="$WS/queries/11-stack.json" --all --json > "$WS/queries/12-entry-points.json"
codegraph query "$MODEL" --file "$WS/queries/13-entry-point-kinds.sql" --param-file inventory="$WS/queries/12-entry-points.json" --all --json > "$WS/queries/13-entry-point-kinds.json"
```

Read `13` whole. In `12`, the rows no table names are the last ones, the
busiest first: search the file for `"no caller", null, null`. If the first
ten of them belong to a few types, add a line to `types` in the table and
run the two commands again; say what you added.

On Spring, the wiring report of step 2 (`reports/$ROOT.wiring.json`) lists the
same entry points under `roles`: the annotation rows of `12` must hold every
one of them.

**The chains**, on facts, then with the candidates:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/chains.sql" "$WS/queries/14-chains.sql"
codegraph query "$MODEL" --file "$WS/queries/14-chains.sql" --param-file inventory="$WS/queries/12-entry-points.json" --param candidates=0 --all --json > "$WS/queries/14-chains.json"
codegraph query "$MODEL" --file "$WS/queries/14-chains.sql" --param-file inventory="$WS/queries/12-entry-points.json" --param candidates=1 --all --json > "$WS/queries/14-chains-candidates.json"
```

**The activity of every file**, only when step 3 ran (`$HISTORY` exists):

```bash
codegraph history "$HISTORY" --report hotspots --model "$MODEL" --top 100000 --json > "$WS/reports/$ROOT.activity.json"
```

**The ranking, the groups, the shared types, the residue.** With step 3:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/chain-ranking.sql" "$WS/queries/15-chain-ranking.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/chain-groups.sql"  "$WS/queries/16-chain-groups.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/shared-types.sql"  "$WS/queries/17-shared-types.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/residue.sql"       "$WS/queries/18-residue.sql"
codegraph query "$MODEL" --file "$WS/queries/15-chain-ranking.sql" --param-file chains="$WS/queries/14-chains.json" --param-file hotspots="$WS/reports/$ROOT.hotspots.json" --all --json > "$WS/queries/15-chain-ranking.json"
codegraph query "$MODEL" --file "$WS/queries/16-chain-groups.sql" --param-file chains="$WS/queries/14-chains.json" --param min=50 --all --json > "$WS/queries/16-chain-groups.json"
codegraph query "$MODEL" --file "$WS/queries/17-shared-types.sql" --param-file chains="$WS/queries/14-chains.json" --json > "$WS/queries/17-shared-types.json"
codegraph query "$MODEL" --file "$WS/queries/18-residue.sql" --param-file inventory="$WS/queries/12-entry-points.json" --param-file activity="$WS/reports/$ROOT.activity.json" --all --json > "$WS/queries/18-residue.json"
```

Without step 3, say so and give the two reports as empty: `15` and `18` then
take `--param hotspots='{"rows":[]}'` and `--param activity='{"rows":[]}'` in
place of the two `--param-file`.

**One chain in detail**, for each of the three chains you will show:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/reach.sql" "$WS/queries/19-reach.sql"
codegraph query "$MODEL" --file "$WS/queries/19-reach.sql" --param candidates=0 --param id='java:com.acme.order/Order.discount(int)' --all --json > "$WS/queries/19-reach-1.json"
```

The id is the entry point's, pasted from `15` between single quotes.

**The picture.** Stop any page being served, start this one in the
background, give the URL `http://127.0.0.1:4177`: in the **Navigate** tab an
entry point's fan-out is its chain, one hop per click, with the source line.

```bash
codegraph serve "$MODEL" --internal-only --host 127.0.0.1
```

## Show

From the saved files, never from memory. Per main root:

1. **The table used**, in one line: which one, what you added to it.
2. **The inventory by kind** (`13`): one line per kind with its count and the
   layer that found it. Then the unclassified count, apart.
3. **Three entry points a person will recognise**: a route with its path (it
   is in `arguments`), a listener, a job.
4. **The top of the unclassified** (`12`): five rows, with their `calls`.
5. **The chain to read first**: the first row of `15` that is a command, a
   query, a request or an event — a `lifecycle` entry or a `framework
   callback` of the same rank comes after. Its types in depth order (`14`,
   the rows of that entry point), then its exit points — skip the language's
   own library. Then how much the candidates add to it
   (`14-chains-candidates.json`, same entry point).
6. **The groups** (`16`): how many, the three largest, each with a name YOU
   propose from its entry points, marked as proposed.
7. **The shared types** (`17`): the top three.
8. **The residue** (`18`): how many types, how many active, the three largest
   of each.
9. **The URL** of the picture.

Repeat `corpus.excluded` first: an excluded path is shown as excluded.

## Read

The page's rules, and only those. Define each term once (`words.md`).

- **Three layers, strongest first.** An **annotation** and a **supertype**
  are written in the source. A **type name** is a convention somebody
  stated. **No caller** is the absence of an edge: an entry point the table
  missed, a reflection target (a getter a template reads), a handler passed
  as a value, dead code, or API offered to others. A row found by two layers
  is under the stronger.
- **What "no caller" leaves out**, because the model does not draw the
  caller: constructors, an operation written inside another, an operation
  called through a type above its own, and the names the language itself
  calls.
- **`NULL` in `stimulus` is unclassified**, not "nothing". It is not an entry
  point until someone says so.
- **A row whose `kind` is not an operation is a marker**: a class-level
  mapping is a path prefix, an annotated parameter is a binding.
- **A chain** is what *can* run: calls and accesses, and the operations
  written inside a reached one. **Exit points** are the external types it
  ends in: an entry point and its exits are one end-to-end flow.
- **Facts, then candidates.** `candidates=0` is the lower bound, declared
  edges only. `candidates=1` adds the edges of another provenance, the
  targets a `dynamic-candidate` edge lists, and dispatch: a call may run the
  operation of the same name in any type below. A chain that doubles goes
  through an interface whose implementation is chosen at runtime. Equal
  chains mean the implementation is not in the source. The wiring report's
  candidates are not in the store; dispatch is the upper bound.
- **Groups.** Two chains go together when they share at least half their
  types, the types most chains reach left out. A group is a candidate use
  case; little overlap between groups suggests separate contexts. One group
  swallowing the rest: run `16` again with a higher `min`, and say it.
- **Shared types** are the kernel or the plumbing; step 5 says which.
- **The residue** is measured wider than a chain: what no type reachable
  from an entry point *mentions*, by any edge. **Stable** residue
  (`revisions` 0) is deletion material. **Active** residue is a detection
  gap — reflection, a framework the table does not know: a gap, never "dead
  code". `NULL` is no history, not zero. The residue is only as good as the
  inventory.

Say what this table does not find (`stacks.md`) and what this language does
not give (`capabilities.md`): no annotation, so no row by annotation. "This
table found none", never "there are none".

## Ask

Only a person knows these. Ask them together; each can be skipped.

1. **What is each use case called?** Give your proposed name for the three
   largest groups and for the chain to read first. Their words replace
   yours, as `said`.
2. **Are these entry points?** The five busiest unclassified rows: each yes,
   with its kind, goes into `entries` or `types` of `11-stack.json`; then run
   the inventory and what follows it again.
3. **Is anything called in a way no table shows?** A scheduler outside the
   code, a configuration file, reflection, a message from another system.

## Write

Re-read `$WS/discovery.json`, then set `steps.stimuli`: `status`, `commit`
(`git -C "$REPO" rev-parse HEAD`), `at`, and one finding per main root under
each key:

| Key | Value | Kind | Anchor |
|---|---|---|---|
| `inventory` | the table used and what was added; entry points per kind, each with the layer and the name that found it | `derived`: a kind is the table's reading of a written name | `queries/13-entry-point-kinds.json`; the names you added in `note` |
| `unclassified` | how many rows no table names, the five busiest | `derived` | `queries/12-entry-points.json` |
| `chains` | the three chains read: entry point, types in depth order, exit points, what the candidates add | `declared` on facts; `dynamic-candidate` for what the candidates add, as a second finding | `queries/14-chains.json`, `queries/14-chains-candidates.json` |
| `useCases` | the groups: how many, the largest, the threshold; the name proposed for each | `derived`; a proposed name is said so in `note` | `queries/16-chain-groups.json` |
| `residue` | types nothing mentions: the count, the stable ones, the active ones | `co-change` with a history, else `derived` | `queries/18-residue.json` |

A name a person gave is a second finding under `useCases`, kind `said`. Each
active residue type and each unclassified row nobody ruled on is a question
for the team: add it to `questions`. Append the entry to `$WS/NOTEBOOK.md`.

## Gate

Two lines: the stimuli by kind in one sentence, the chain to read first in
another. Then:

- **Continue** to step 5, meaning: the one step that calls a model provider
  and costs money. Its estimate is free and comes first; nothing is sent
  without a yes.
- **Go deeper** here: another chain (`19`), or one saved query per question
  (`rhythm.md`).
- **Skip** to another step.
- **Stop.** What they hold: the inventory, a reading order per use case, and
  the questions for the team.

If skills named `specy:…` are available, say once that
`/specy:sysreq-extract-from-code` writes requirements from a codebase, and
that it reads the source, not yet this workspace.
