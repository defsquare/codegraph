---
name: discover-1-structure
description: Step 1 of codegraph's discovery walk — structure and elements. What is in this codebase, how big is it, how branchy, how tangled. Extracts the model from source alone (no build), counts the elements, measures size and cyclomatic complexity per module and per type, finds the dependency cycles and the most depended-on types, and shows the result as a 3D city. Use for "how big / how complex / how tangled is this codebase", "what are the largest or most complex classes", "are there dependency cycles", or when the discover guide routes here. Free and deterministic — seconds, no model call, nothing sent anywhere.
argument-hint: "<path-to-repository>"
---

# Step 1 · Structure and elements

**The question.** What is here, how big is it, how branchy is it, and how
tangled is it? What proportion does each module and type take, and are there
outliers in size or complexity?

**The method** is the page https://codegraph.biz/docs/discover/structure/ —
its commands, its queries, its reading rules. You execute it; you add none.

**Cost.** Free and deterministic. Seconds. No model call, nothing leaves the
machine.

**Needs.** `codegraph`, and the extractor of the language. **Builds**, in the
workspace: one model per source root, its saved queries and reports.

**The person holds, at the end:** the terrain — sizes, complexity, tangles —
and a short list of outliers to place against activity in step 3.

**Repository:** `$ARGUMENTS`

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph`, `$ROOT` is a source root's short name (`main`), `$SRC`
its directory relative to `$REPO`, and `$MODEL` is `$WS/$ROOT.jsonl`.

## Enter

Read `$WS/discovery.json`.

- **It exists:** take the roots from `corpus.roots`. If
  `steps.structure.status` is `done` at the current `HEAD`, say what was found
  and when, and ask whether to run it again or go to the gate.
- **It does not:** you were entered directly. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover/SKILL.md` and do its section 1
  (preflight) and the workspace creation of its section 3, without the three
  intake questions. Confirm the source roots in one line.

Then read `${CLAUDE_PLUGIN_ROOT}/references/rhythm.md` (the seven beats) and
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md` (kind and anchor of a finding).
In `${CLAUDE_PLUGIN_ROOT}/references/capabilities.md`, read the column of this
language: what a module and a type are called, and which kinds carry measures.

## Frame

Say it in three sentences: this step extracts a model of the code from the
sources alone, measures it from three sides — size, branching, entanglement —
and shows it as a city. It takes seconds and costs nothing. It ranks nothing
by itself: what is large becomes a priority only when step 3 shows it is
also worked on.

## Run

From the repository root, once per source root. Main roots first; a test root
is extracted so it is there for later steps, and is not measured here. Begin
each command with the line that puts the tools on the path, as preflight did:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

**Extract.** The command is the extractor of the language (`capabilities.md`);
Java is shown. The extractor reads sources and runs nothing of the project.

```bash
codegraph-java --src "$SRC" --out "$MODEL" 2> "$WS/$ROOT.extract.log"
codegraph-metrics "$MODEL"
codegraph validate "$MODEL" --json > "$WS/reports/$ROOT.validate.json"
```

- The log ends with the RESOLUTION SUMMARY. Keep the file; read the summary.
- `codegraph-metrics` adds cognitive complexity and others to the same model.
  If it is not installed, say so in one line and go on: size and cyclomatic
  complexity are the extractor's own.
- `validate` exits 3 when it has findings. That is a result, not a failure:
  read the JSON, tell the person what it says, and go on unless the model
  could not be read at all.

**Count and measure.** Five queries, the page's own. Copy each into the
workspace, run it, keep its rows:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/summary.sql"           "$WS/queries/01-summary.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/kinds.sql"             "$WS/queries/02-kinds.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/size-by-module.sql"    "$WS/queries/03-size-by-module.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/largest-types.sql"     "$WS/queries/04-largest-types.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/branching-by-type.sql" "$WS/queries/05-branching-by-type.sql"
codegraph query "$MODEL" --file "$WS/queries/01-summary.sql"           --json > "$WS/queries/01-summary.json"
codegraph query "$MODEL" --file "$WS/queries/02-kinds.sql"             --json > "$WS/queries/02-kinds.json"
codegraph query "$MODEL" --file "$WS/queries/03-size-by-module.sql"    --json > "$WS/queries/03-size-by-module.json"
codegraph query "$MODEL" --file "$WS/queries/04-largest-types.sql"     --json > "$WS/queries/04-largest-types.json"
codegraph query "$MODEL" --file "$WS/queries/05-branching-by-type.sql" --json > "$WS/queries/05-branching-by-type.json"
```

With several roots, put the root's name in the file names
(`03-main-size-by-module.json`). `codegraph query` builds the store beside the
model on its first run; no `sqlite3` is needed.

**Find the tangles, measure coupling.**

```bash
codegraph analyze "$MODEL" --report cycles --level module --internal-only --json > "$WS/reports/$ROOT.cycles-module.json"
codegraph analyze "$MODEL" --report cycles --level type --internal-only --json > "$WS/reports/$ROOT.cycles-type.json"
codegraph analyze "$MODEL" --report coupling --level type --internal-only --top 20 --json > "$WS/reports/$ROOT.coupling-type.json"
```

`--report cycles` exits 3 when there is a cycle: again a result. To show a
cycle to the person, run the same command without `--json` and without the
redirection, and quote only the lines you need.

**The picture.** Start it in the background and give the URL,
`http://127.0.0.1:4177`, City tab. Stop any page already being served first.

```bash
codegraph serve "$MODEL" --height sum:cyclomatic --footprint loc --internal-only --host 127.0.0.1
```

## Show

From the saved files, never from memory. Per main root, in this order:

1. **The model in one line** (`01-summary`, the log): language, entities,
   stubs, edges, files, and the resolution rate.
2. **The kinds** (`02-kinds`): the whole table when it is short.
3. **Size**: the top three modules with their share (`03`), the top five
   types (`04`).
4. **Branching** (`05`): the top five, with the worst operation of each.
5. **Tangles**: how many components at module level, the size of the largest,
   its feedback edges. Then the same sentence at type level.
6. **Coupling**: the five types with the highest fan-in among the twenty
   most coupled, which is what the report ranks.
7. **The city's URL**, with one sentence on what to look for.

Before any ranking, repeat what is in `corpus.excluded`: a row the person has
already called generated is shown as such, or left out.

## Read

The page's rules, and only those. Define each term once (`words.md`).

- **Resolution rate:** the share of type references the extractor pinned to a
  declaration without a classpath. 90% and above is normal; a sharp drop
  between two runs means a source root moved. **Stubs** are what the code
  references and does not declare; they are kept so the picture is honest
  about what is outside.
- **The kinds table:** read its shape. Far more attributes than methods is
  data carriers; many lambdas is a functional style; a single module is a flat
  codebase.
- **Size:** it follows a power law everywhere; a few types holding much of the
  code is normal. Look for the **break in the curve**: the point where the
  next type is several times smaller than the one before. What is above the
  break is a candidate for step 3. Absent is not zero: a type with no size was
  not measured.
- **Branching:** a type high on size and on complexity is the classic outlier;
  a small but branchy one is what a line count would have hidden. A `worst`
  above 15 is an operation nobody can test exhaustively. An owner whose `kind`
  is the module's is free functions, counted in their file.
- **A cycle:** `members` is how many are locked together (one cycle of 500 is
  a ball of mud; ten of two are ten local mistakes); `weight` is how strongly
  they hold; the edges marked `[feedback]` are the cheapest set whose removal
  makes the group acyclic — the refactoring the graph itself proposes.
- **Coupling:** high fan-in with instability near 0 is a load-bearing wall,
  stable and expensive to change. High fan-in AND high instability is the
  dangerous kind. High fan-out with low fan-in is an orchestrator, fine if
  thin.
- **The city:** districts are modules, buildings are types. Tall and narrow is
  branchy code in little space; wide and flat is data or generated code; one
  huge building in a district is a god class.

Say what this language does not give, from `capabilities.md`: a kind with no
measure, a module that is a file and not a package.

## Ask

Only a person knows these. Ask them together; each can be skipped.

1. **Is any of these outliers generated, vendored, or otherwise not written
   by this team?** Name the three or four candidates. Each yes goes to
   `corpus.excluded`, with the reason, `by: "person"`.
2. **Does anything here surprise you?** A module they expected to be large and
   is not, a tangle they did not know. Record the answer as a `said` finding
   in the notebook.

If you suspect generated code yourself — a `generated` directory, a header
comment, a name — say so as a guess and ask. Unconfirmed, it is written with
`by: "agent"` and still counted in the tables.

## Write

Re-read `$WS/discovery.json`, then set `steps.structure`: `status`, `commit`
(`git -C "$REPO" rev-parse HEAD`), `at`, and one finding per main root under
each key the page's "Write down" list asks for:

| Key | Value | Kind | Anchor |
|---|---|---|---|
| `resolution` | references, resolved, unresolved, rate | `declared` | `$ROOT.extract.log` |
| `stubs` | the count | `declared` | `queries/01-summary.json`, row 0 |
| `sizeBreak` | the types above the break, the first below | `derived` | `queries/04-largest-types.json`; the rule in `note` |
| `complexityBreak` | the same, with each `worst` | `derived` | `queries/05-branching-by-type.json` |
| `cycles` | components, largest, feedback edges (module level) | the weakest `provenance` among the feedback edges | `reports/$ROOT.cycles-module.json` |
| `topFanIn` | the ten highest fan-in among the report's twenty rows | `declared` only if the report was run with `--declared-only`; else `derived` | `reports/$ROOT.coupling-type.json`; say "among the twenty most coupled" in `note` |

No break in a curve is a finding too: say "no break; the sizes fall
regularly". Then append the step's entry to `$WS/NOTEBOOK.md` and add the
person's unanswered questions to `questions`.

## Gate

Two lines: the terrain in one sentence, the outliers in another. Then:

- **Continue** to step 2, boundaries and style: free, seconds.
- **Go deeper** here: a question the tables do not answer becomes one saved
  query (`rhythm.md`).
- **Skip** to another step.
- **Stop.** What they hold: the tables in `.codegraph/queries/`, the notebook,
  and the city for as long as the page is served.
