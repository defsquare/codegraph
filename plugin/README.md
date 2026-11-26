# codegraph — the discovery walk, as agent skills

A Claude Code plugin. Given the path of a codebase you did not write, an agent
guides you through codegraph's discovery walk
(https://codegraph.biz/docs/discover/): six questions in a fixed order, each
answered from the code itself.

| Skill | What it does |
|---|---|
| `/codegraph:discover <path>` | The guide: checks the tools, asks three questions at most, creates the workspace, routes to the next step, resumes a walk already started. `--tour` runs steps 1 to 3 with no question and leaves a report. |
| `/codegraph:discover-1-structure <path>` | Step 1 — what is here, how big, how branchy, how tangled. Free, seconds. |
| `/codegraph:discover-2-boundaries <path>` | Step 2 — how it is cut, in which style, on which stack, and whether the cuts hold. Free, seconds. |
| `/codegraph:discover-3-activity <path>` | Step 3 — where the effort goes: the hotspots, who holds them, what changes together. Free, seconds; needs the git history. |
| `/codegraph:discover-4-stimuli <path>` | Step 4 — what reacts to the outside or to time: the entry points by kind, the chain behind each, the use cases, what nothing reaches. Free, seconds. |
| `/codegraph:discover-5-meaning <path>` | Step 5 — what each unit does, in domain words: the plan and the price of `codegraph explain` first, a run only after your yes for a stated scope and ceiling, then the purposes, the concepts and the glossary. The one paid step. |
| `/codegraph:discover-6-domain <path>` | Step 6 — which part is the business: purity, position in the chains and invariant evidence give a verdict per module; with the Specy plugin, a `.domain` model and a refactoring report weighed by the hotspots. Free with codegraph. |
| `/codegraph:query <path> <question>` | One question about the code as one saved, read-only SQL query, with its rows. |

## Install

```text
/plugin marketplace add defsquare/codegraph
/plugin install codegraph@codegraph
```

On Claude Code 2.1.275 or later, in one step:
`/plugin install codegraph --marketplace defsquare/codegraph`. From a clone of
codegraph, without installing: `claude --plugin-dir plugin`.

## What it needs

- The `codegraph` command and the extractor of your language, from the
  Homebrew tap: https://codegraph.biz/docs/how-to/install/. The skills install
  nothing; they print the line to run.
- Nothing else for steps 1 to 4. Step 5 is the only one that calls a model
  provider and costs money, and it asks first: an API key on OpenRouter or a
  Cloudflare AI Gateway, or Claude Code itself (`--provider claude-code`).
- Step 6 hands over to the Specy plugin (`specy-ai/skills`), detected, not
  required: without it the step stops at the verdict per module.

## What it does to your repository

It writes one hidden directory, `.codegraph/`, at the root of the repository,
and adds it to the repository's own `.git/info/exclude` — never to
`.gitignore`, so no tracked file changes and `git status` stays what it was.
The directory holds the models, every query that was run with its rows, the
log of the walk (`NOTEBOOK.md`), a report to take away (`REPORT.md`) and the
state of the walk (`discovery.json`). The report holds shares and counts,
never a person's name. Delete the directory and nothing is left.

It runs none of the analyzed project's code: no build, no test, no script.
The one other directory is Specy's, at step 6: `specy/`, with the model it
wrote, yours to keep or delete.

## What is in this plugin

Text and SQL, nothing executable: no binary, no MCP server, no hook.

- `skills/` — one `SKILL.md` per skill.
- `references/` — read by the skills when they need them: the rhythm of a
  step and of a tour, how a finding is written, the state file and its schema,
  the report, the words of the method, what codegraph gives for each
  language (generated from its language profiles), and the stack tables of
  step 4: which names mean "called from outside", per framework (`stacks/`).
- `queries/` — the SQL the steps run with `codegraph query`. The same
  statements the documentation shows, held equal by a test.
- `evals/` — the `claude plugin eval` cases: the guide chosen for the right
  request and not for a bug fix, step 5 waiting for a yes, step 2 saying what
  a language cannot give. Not read by any skill.

The plugin is versioned with the `codegraph` command it drives: a skill
spells flags, so it is released with the binary that parses them.
