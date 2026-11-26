---
name: discover-2-boundaries
description: Step 2 of codegraph's discovery walk — boundaries and style. How is this codebase cut, in which architecture style (by layer, by feature, hexagonal), and do the cuts hold. Draws the module dependency map, names the style from the module names, reads the technology stack from the external modules the code references, takes a census of annotations, and lists what the system depends on and where it can be entered. Use for "what is the architecture of this codebase", "is it layered or modular", "which frameworks and libraries does it use", "what does it depend on", or when the discover guide routes here. Free and deterministic — seconds, no model call, nothing sent anywhere.
argument-hint: "<path-to-repository>"
---

# Step 2 · Boundaries and style

**The question.** How is the codebase cut, in which architecture style, and do
the cuts hold? On which stack? And around it: what does it depend on, and
where can it be entered?

**The method** is the page https://codegraph.biz/docs/discover/boundaries/ —
its commands, its queries, its reading rules. You execute it; you add none.

**Cost.** Free and deterministic. Seconds. No model call, nothing leaves the
machine.

**Needs.** `codegraph`, and the model of step 1 for each main root. **Builds**,
in the workspace: the module map, three saved queries, and for a Spring
codebase the wiring report.

**The person holds, at the end:** a style claim with the checks that held and
the ones that failed, the stack, and the lists of what the system depends on
and of its doors.

**Repository:** `$ARGUMENTS`

In the commands below `$REPO` is the repository's absolute path, `$WS` is
`$REPO/.codegraph`, `$ROOT` is a source root's short name (`main`) and
`$MODEL` is `$WS/$ROOT.jsonl`.

## Enter

Read `$WS/discovery.json`.

- **It exists:** take the main roots from `corpus.roots`. If
  `steps.boundaries.status` is `done` at the current `HEAD`, say what was
  found and when, and ask whether to run it again or go to the gate.
- **It does not:** you were entered directly. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover/SKILL.md` and do its section 1
  (preflight) and the workspace creation of its section 3, without the three
  intake questions.
- **A main root has no model:** read
  `${CLAUDE_PLUGIN_ROOT}/skills/discover-1-structure/SKILL.md` and run its
  **Extract** commands for that root, nothing more. It takes seconds.

Then read `${CLAUDE_PLUGIN_ROOT}/references/rhythm.md` and
`${CLAUDE_PLUGIN_ROOT}/references/evidence.md`. In
`${CLAUDE_PLUGIN_ROOT}/references/capabilities.md`, read this language's
column: what a module is, whether annotations are edges, how external code is
filed, and whether a framework has a profile.

## Frame

Three sentences: this step draws the map of the modules and what they depend
on, names the architecture style the code claims, and checks whether the code
keeps to it. It takes seconds and costs nothing. Part of it is a reading — a
style is an interpretation — and it is marked as one.

## Run

Once per main root. Begin each command with the line that puts the tools on
the path:

```bash
[ -n "${CODEGRAPH_HOME:-}" ] && PATH="$CODEGRAPH_HOME/bin:$PATH"
```

**The module map**, as a table and as a diagram a person can paste:

```bash
codegraph export "$MODEL" --format csv --level module --internal-only > "$WS/reports/$ROOT.modules.csv"
codegraph export "$MODEL" --format plantuml --level module --internal-only > "$WS/reports/$ROOT.modules.puml"
```

**The stack, the reach, the census.** Three queries, the page's own:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/external-modules.sql" "$WS/queries/06-external-modules.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/module-reach.sql"     "$WS/queries/07-module-reach.sql"
cp "${CLAUDE_PLUGIN_ROOT}/queries/annotations.sql"      "$WS/queries/08-annotations.sql"
codegraph query "$MODEL" --file "$WS/queries/06-external-modules.sql" --json > "$WS/queries/06-external-modules.json"
codegraph query "$MODEL" --file "$WS/queries/07-module-reach.sql" --all --json > "$WS/queries/07-module-reach.json"
codegraph query "$MODEL" --file "$WS/queries/08-annotations.sql" --all --json > "$WS/queries/08-annotations.json"
```

**The doors, by annotation.** One statement, asked with a list of names. Run
it only for the lists whose names the census (`08`) shows; the lists are the
page's. HTTP on Spring:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/queries/annotated-with.sql" "$WS/queries/09-annotated-with.sql"
codegraph query "$MODEL" --file "$WS/queries/09-annotated-with.sql" --all --json \
  --param names='["RestController","Controller","RequestMapping","GetMapping","PostMapping","PutMapping","DeleteMapping","PatchMapping"]' \
  > "$WS/queries/09-inbound-http.json"
```

The page's other lists, each saved under its own name
(`09-inbound-messages.json`, `09-inbound-timers.json`, `09-persistence.json`):
`["KafkaListener","JmsListener","RabbitListener"]`, `["Scheduled"]`,
`["Entity","Table","Id"]`, and on ASP.NET Core
`["ApiControllerAttribute","HttpGetAttribute"]` — C# names the attribute's
class, suffix included. A list you compose yourself from the census is a
guess: say so, and write it in the finding's `note`.

**Spring only** — when `06` shows `org.springframework` modules. It is the one
framework with a profile (`capabilities.md`):

```bash
codegraph analyze "$MODEL" --report wiring --json > "$WS/reports/$ROOT.wiring.json"
```

**The cycles** are step 1's: read `$WS/reports/$ROOT.cycles-module.json`. If
it is not there, run step 1's module-level cycles command and save it.

**The picture.** Stop any page being served, start this one in the
background, give the URL `http://127.0.0.1:4177`: the **Graph** tab in module
mode is the map.

```bash
codegraph serve "$MODEL" --internal-only --host 127.0.0.1
```

On a Spring codebase, serve this instead: the City tab can then be coloured
by role.

```bash
codegraph serve "$MODEL" --framework spring --internal-only --host 127.0.0.1
```

## Show

From the saved files, never from memory. Per main root:

1. **The map** (`modules.csv`): how many modules, how many dependencies
   between different modules (`selfLoop` false), the three heaviest. Name any
   row whose `provenances` is not `declared` alone: it holds an inference.
2. **The shape** you recognise, in one sentence.
3. **The style** the module names claim, with the names that say so.
4. **The stack** (`06`): the top rows that are not the language's own
   library. Rows with `own` = 1 are shown apart, as what they are.
5. **The reach** (`07`): for the modules the style says must stay pure, what
   they reach outside.
6. **The census** (`08`): the top five — or the sentence that this language
   has no annotations.
7. **The doors** found, by kind, with their count; three examples with the
   path or the name written in `arguments`.
8. **The URL** of the picture.

Repeat `corpus.excluded` before any table.

## Read

The page's rules, and only those. Define each term once (`words.md`).

- **The map.** A solid dependency is all declared facts; one that carries
  another provenance contains an inference. Three shapes recur. *Deep and
  narrow* is a pipeline: look for arrows that go up, each a layering violation
  the code admits to. *Shallow and wide around one hub* is a core module: a
  shared kernel or a god package, and step 1's coupling says which. *One big
  knot* is step 1's tangle: nothing inside has a direction.
- **The style, from the names.** Technical roles (`controller`, `service`,
  `repository`, `dto`, `util`) is a cut **by layer**: every feature change
  crosses every module. Business capabilities (`orders`, `billing`) is **by
  feature**: a change should stay in one module, and a dependency between two
  features is worth a look. `domain`, `application`, `infrastructure`, `ports`
  is **hexagonal**: `domain` must depend on nothing outside itself. A mix is
  the usual case. Where a module is a file, read the directories.
- **The stack.** Skip the standard library; the rest is a bill of materials.
  A vendor package is an external system the code depends on. A row with
  `own` = 1 is not the outside world: it is names in one of the code's own
  modules that no extracted file declares — generated code, another source
  root, or a name the extractor could not resolve. A handful is normal; many
  means a source root is missing.
- **The reach.** A module called `domain` that reaches a persistence or a web
  library is a violation the code admits to. Small counts are one annotation
  that leaked; large ones are a layer that never existed.
- **The census** is the fastest honest fingerprint of a style: a module that
  is mostly controllers is the presentation layer whatever its name.
- **Wiring** (Spring): every line of that report is an inference from written
  annotations, and says so itself. Candidates are `dynamic-candidate`.

Say what this language does not give (`capabilities.md`): no annotation, so
no census and no door found here; external code filed under a few roots, so
the stack is the build file's to give — read it, never run it; no framework
profile, so no wiring report. "This query found none", never "there are none".

### The three checks

A claim survives or not on these. Write each as held, failed or pending.

1. **Direction.** For a layered or hexagonal claim: the module pairs whose
   dependency points the wrong way, from `modules.csv`, and the reaches of the
   pure modules, from `07`. No direction is claimed by a cut by feature.
2. **Cycles.** Step 1's report at module level. Two "features" in one
   component are one feature with two names.
3. **Co-change.** Pending here: step 3 measures how often a commit crosses a
   top-level module. Above roughly a third, the cut is by layer in practice
   whatever the folders say; below, the modules are real boundaries.

## Ask

Only a person knows these. Ask them together; each can be skipped.

1. **What is behind each external module you cannot name?** Give the two to
   four vendor or unknown rows of `06`. Each answer is a `said` finding; each
   skipped one is a question for the team.
2. **Who calls this system?** Nothing in the code says who depends on it.
3. **Is this the architecture the team describes?** If their account differs
   from the claim, record both.

## Write

Re-read `$WS/discovery.json`, then set `steps.boundaries`: `status`, `commit`
(`git -C "$REPO" rev-parse HEAD`), `at`, and one finding per main root under
each key:

| Key | Value | Kind | Anchor |
|---|---|---|---|
| `moduleMap` | modules, dependencies between them, the shape | the weakest provenance in the table; the shape is `derived` | `reports/$ROOT.modules.csv` |
| `style` | the claim, the names and census rows it rests on | `derived`; the rule in `note` | `queries/08-annotations.json`, or `reports/$ROOT.modules.csv` where there is no census |
| `checks` | the three checks, each held, failed or pending, with its evidence | `derived` | the file that decides the first failed check, else `reports/$ROOT.modules.csv` |
| `stack` | the top external modules, the standard library apart, the `own` rows apart | `declared` | `queries/06-external-modules.json` |
| `outbound` | vendor and I/O modules, each with the module that reaches it | `declared` | `queries/07-module-reach.json` |
| `inbound` | the doors by kind, with counts; or why none could be found | `declared`; wiring's are `derived` | `queries/09-inbound-http.json` and its siblings; `capabilities.md`'s reason in `note` when empty |

What a person said goes in a second finding of kind `said`, never merged into
the first. Append the entry to `$WS/NOTEBOOK.md`; add the unanswered
questions to `questions`.

## Gate

Two lines: the style and whether it holds so far; the stack in one breath.
Then:

- **Continue** to step 3, activity: free, seconds. It needs the git history,
  and settles the third check.
- **Go deeper** here: one saved query per question (`rhythm.md`).
- **Skip** to another step.
- **Stop.** What they hold: the map (`reports/$ROOT.modules.puml` pastes into
  a wiki), the stack, the two lists, and the questions for the team.

If skills named `specy:…` are available, say once that
`/specy:architecture-extract-from-code` turns a codebase into an architecture
model; a version that knows this walk starts from this step's module map,
stack, doors and exits, which it reads in the workspace.
