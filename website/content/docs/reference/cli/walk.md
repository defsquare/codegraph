---
title: "walk"
weight: 9
---

Ask a question of every selected unit, bottom-up, with an LLM: a prompt or a walk definition, into its own store.

`walk` runs the engine [`explain`](/docs/reference/cli/explain/) runs on — the same units (operations, then types, then modules), the same cycle-condensed order, the same context packs, fingerprints, plan, confirmation and retry — with the question as a parameter: `--prompt TEXT` asks one task at every level, and `--walk FILE` reads a [walk definition](/docs/reference/walk-definition/) with a task per level, instructions, instructions for selected entities, and the fields each answer must carry. `--include`/`--exclude`, `--levels` and `--closure` choose which units are asked; the walk is still built over the whole model. Each walk has a name (`adhoc` unless given) and its own store, `<model>.NAME.walk.db`, with its export `<model>.NAME.walk.jsonl`: explain's store is never touched.

## Synopsis

```
codegraph walk [model.jsonl...] [--walk FILE|explain] [--prompt TEXT] [--prompt-file FILE] [--instructions TEXT|@FILE] [--name N] [--print-definition] [--src DIR] [--out FILE] [--provider <auto|openrouter|cloudflare|claude-code>] [--claude-path FILE] [--model SLUG] [--rollup-model SLUG] [--depth N] [--max-calls N] [--max-tokens N] [--concurrency N] [--max-lines N] [--max-scc N] [--include SEL] [--exclude SEL] [--levels LEVELS] [--closure <none|dependencies|containers|all>] [--framework <spring>] [--internal-only] [--declared-only] [--no-cache] [--dry-run] [--estimate] [--price-in USD] [--price-out USD] [--force] [--retry-failed] [--export] [--import FILE] [--yes] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--walk FILE\|explain` | The walk to run: a `codegraph.walk/1` definition file, or `explain`, the built-in (explain's spec, store and defaults). Neither: the default definition (name adhoc), asking --prompt. | — |
| `--prompt TEXT` | The task asked of every unit, at every level (replaces the definition's `prompt.task`). | — |
| `--prompt-file FILE` | The same task, read from a file. | — |
| `--instructions TEXT\|@FILE` | Instructions added to every unit's system message, after the task (a definition's `prompt.instructions`); @FILE reads them from a file. Every unit asked under them is asked again when they change. | — |
| `--name N` | The walk's name (replaces the definition's name): its store is `<model>.N.walk.db`. A store is only ever opened by the walk that wrote it, so --name OTHER keeps two definitions' answers apart. `explain` and `insights` are reserved. | `adhoc` |
| `--print-definition` | Print the default walk definition as JSON — or, followed by `explain`, explain's — and stop: a file to start from. No model is read. | — |
| `--src DIR` | The source root the model's anchors are relative to. Defaults to the model's own `root`, resolved against the current directory. | — |
| `--out FILE` | The side-car to write (and to resume from). Its store is the same path with `.db`. | `<model>.N.walk.jsonl`, N the walk's name |
| `--provider <auto\|openrouter\|cloudflare\|claude-code>` | Where the model calls go: openrouter (OPENROUTER_API_KEY), cloudflare — Cloudflare AI Gateway's REST API (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, optional CLOUDFLARE_AI_GATEWAY_ID) — or claude-code, the local Claude Code CLI in headless mode (`claude -p`, Sonnet by default, no key). auto picks whichever is configured; with several, OpenRouter, then Cloudflare, then Claude Code. | `auto` |
| `--claude-path FILE` | The Claude Code binary. Under --provider auto it implies claude-code; with openrouter or cloudflare it is an error. Otherwise CLAUDE_CODE_PATH, then `claude` on PATH, then the known install locations; a path that does not exist is an error, never a fall-through. | — |
| `--model SLUG` | Model slug for operations (the leaves). Defaults per provider: `openai/gpt-5.6-luna` (author/model form) on openrouter and cloudflare, `sonnet` on claude-code — an alias Claude Code resolves to the latest Sonnet; a full id such as `claude-sonnet-5-5` pins the fingerprint. | per provider |
| `--rollup-model SLUG` | Model slug for types and modules; defaults to --model. | — |
| `--depth N` | How many levels of dependency answers a prompt carries. Replaces the definition's `context.depth`. | the definition's, `1` |
| `--max-calls N` | Stop planning model calls after this many; what runs is a dependency-consistent prefix. | — |
| `--max-tokens N` | Cap on the tokens one answer may use (reasoning included). Omitted, the provider assumes the model's full output window and a prepaid account must afford THAT for every call; a block is ~1k tokens, a full cycle call ~12k. An answer cut at the cap fails its unit. Does not apply to claude-code (the CLI has no output cap): noted on stderr, ignored. | — |
| `--concurrency N` | Model calls in flight at once. | `4` |
| `--max-lines N` | Source lines shown per unit before the middle is elided. Replaces the definition's `context.maxLines`. | the definition's, `200` |
| `--max-scc N` | Members of a dependency cycle asked in one call; larger cycles are chunked. | `12` |
| `--include SEL` | Ask only the units whose member — itself, its nearest type or its nearest module — matches this [selector term](/docs/reference/walk-definition/#selectors): `id:ID`, `kind:K`, `trait:T`, `lang:L`, `name:GLOB`, `module:GLOB`, `file:GLOB`, `edge:KIND[>TERM]`, `edge-in:KIND[<TERM]`. Repeatable: several are any of them. The walk is still built over the whole model. | everything |
| `--exclude SEL` | Never ask a unit whose member (itself, its nearest type or module) matches this term; wins over --include. Repeatable. | nothing |
| `--levels LEVELS` | Comma-separated levels to ask: operation, type, module. | all three |
| `--closure <none\|dependencies\|containers\|all>` | Also ask what the selection leans on: dependencies (every unit it depends on, so each asked prompt sees its callees answered), containers (the type and module above it), all (both). | `none` |
| `--framework <spring>` | Add a framework's stereotypes and entry points to the facts shown. | — |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. A selector's `edge` terms then see declared edges only. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `--dry-run` | Print the plan — units, order, statuses, estimated tokens — and make no call. | — |
| `--estimate` | Print the token volume this run would send and receive (input and output, per level) and make no call. Add --price-in/--price-out for a cost. | — |
| `--price-in USD` | Input price in USD per million tokens, for the estimate's cost line. | — |
| `--price-out USD` | Output price in USD per million tokens, for the estimate's cost line. | — |
| `--force` | Ask every selected unit again, ignoring records whose fingerprint still matches. | — |
| `--retry-failed` | Redo only the units the walk's store records as failed, plus their direct dependents, which were answered without them; the selection is theirs, so no selection flag goes with it. Pass the same --model/--depth. | — |
| `--export` | Write the side-car from the walk's store (`<model>.N.walk.db`) and stop: no model is read, no call is made. | — |
| `--import FILE` | REPLACE the walk's store's records with those of one of its side-cars and stop. Asks first when the store holds records; --yes skips it. | — |
| `-y, --yes` | Run without asking. Otherwise a run that makes model calls prints its token estimate and waits for confirmation — which needs an interactive terminal. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

**A flag replaces the definition's key, and the result is what is checked and recorded.** `--name`, `--prompt`/`--prompt-file`, `--instructions`, `--include` (one term is the selector, several are `{ "any": […] }`), `--exclude`, `--levels`, `--closure`, `--depth` and `--max-lines` are folded into the definition's JSON before it is parsed, so a fault names its flag (`name (from --name): …`) and the store records the effective definition's digest: `--walk FILE --closure all` is the same walk as the file with that key edited.

**`--walk explain`** runs the built-in on explain's store, with this command's JSON kinds and titles (`walk plan (explain)`). It takes `--instructions` and the selection flags, which customize explain as `codegraph explain` would, and refuses `--prompt`, `--prompt-file` and `--name`. `--terms` and `--scope` are `explain`'s own flags.

**`--retry-failed`** takes its selection from the store's failure records: a file's `select` is not read, and a selection flag is refused with it (`--retry-failed and --include both choose what to ask`). The task and the answer still apply, so the retried units hash as the failed run's.

## Files

| File | What it holds |
|---|---|
| `<model>.N.walk.db` | the walk's store, the working copy: every finished unit committed as it arrives. A SQLite file of the same schema as explain's store (version 2); not a cache — never rebuilt |
| `<model>.N.walk.jsonl` | its export, written when a run ends: a header of kind `codegraph.walkRecords/1`, then one record (`t:"i"`) per answered entity, the failures (`t:"f"`) and the trailer (`t:"eof"`), as in [insights.jsonl](/docs/reference/artifacts/insights-jsonl/) |

The header's `walk` is `{ name, version, digest, answerDigest }`: the definition's name and version, the digest of the effective definition, and the digest of the answer schemas as sent. **A store is only opened by the walk that wrote it.** A store of another name — explain's included — is refused with its bytes untouched, and so is a store of this name written under other answer fields: every unit would be asked again anyway, and its records could never be exported beside the new ones. `--name OTHER` keeps both. A changed task, instructions or version is not refused: fingerprints decide what is asked again, and the run says so first, on the first line of a dry run or an estimate and before the confirmation's question:

```text
note: the definition changed since this store was written: these 68 units are asked again and their records REPLACED; --name OTHER keeps both.
```

Declined, nothing is written.

## JSON output

| `kind` | Printed by | Keys, in order |
|---|---|---|
| `codegraph.walkPlan/1` | `--dry-run --json` | `kind, walk, models, depth, estimates, steps[, price]` |
| `codegraph.walkEstimate/1` | `--estimate --json` | `kind, walk, models, depth, units, layers, calls, promptTokens, completionTokens, byLevel, byStatus[, priceIn, priceOut, cost], assumptions[, price]` |
| `codegraph.walkSummary/1` | a run with `--json` | `kind, walk, out, counts, usage, failures[, aborted]` |

`walk` is `{ name, version, digest }`; under `--walk explain` it appears only when explain is customized. `price` appears when the selection leaves a dependency unwalked: `{ closure, selected, added: { none, dependencies, containers, all }, asked, leftOut, notWalked: { unselected, excluded, outsideLevels, trivial }, templated }`, each a count per level. `assumptions` is `{ promptTokens, completionTokens, excluded }`, each in words: `completionTokens` names the measured figures below and what they were measured on. Under `--json`, the changed-definition notice goes to stderr, so stdout stays one document.

## Cost

Input tokens are estimated as explain's are: the rendered prompts at four characters per token, plus, on Claude Code, its scaffolding and the response schema. Output tokens are a figure per block asked for, by level: **operation 500, type 620**, the means of one live run of a defined walk — Spring PetClinic, `--provider claude-code` with `sonnet`, depth 1, a walk that declares no answer field, 83 calls (63 operations, 20 types). No module was asked on that run, so a module takes the type's figure; nothing measured a declared field, so a field adds nothing to the estimate, though it adds to the answer. The estimate's `output ≈` line says all of this. Repair re-asks and rate-limit retries are not counted.

On that run, the estimate made beforehand was 12.4 % above the billed input (operations 21.6 % above, types 7.0 % below) and, with the 500 per block it then used at every level, 5.3 % below the billed output (operations 0.3 % above, types 19.3 % below). The present figures are that run's means, so they match its output by construction; one run, on one corpus, with one model and one question, is their whole basis.

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean, or when any unit failed to be answered: each such unit leaves a failure record in the store and the side-car, and `--retry-failed` redoes it. `2` for every refusal: a definition fault, an unknown selector term, a reserved name, a store of another walk or of other answer fields.

## Example

```console
$ codegraph walk fixtures/java/expected/model.jsonl --src fixtures/java/src --prompt "Which of these is audited, and what does the audit record?" --include 'edge:annotationUse>name:Audited' --dry-run
walk plan (adhoc): 77 units in 8 layers
  operation     57 units      2 calls ~1122 prompt tokens
  type          17 units      0 calls ~0 prompt tokens
  module         3 units      0 calls ~0 prompt tokens
  statuses: llm 2, template 0, reuse 0, skip-scope 75, skip-budget 0
  selection: 1 dependency of the selection is not walked (1 unselected); without a record, shown as NOT EXPLAINED
  --closure dependencies adds 2 units (operation 2, type 0, module 0)
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 2 calls, ~1122 prompt tokens in, ~1000 completion tokens out
```

The cache line and the per-unit lines are trimmed; the two `llm` lines are `Reporting.max(java.util.List)` and `Order.discount(int)`. `--dry-run` and `--estimate` need no key and no binary.

## See also

[Walk definitions and selectors](/docs/reference/walk-definition/) · [Ask your own question of the code](/docs/how-to/walk-your-question/) · [`explain`](/docs/reference/cli/explain/) · [`insights`](/docs/reference/cli/insights/) · [insights.jsonl](/docs/reference/artifacts/insights-jsonl/) · [CLI conventions](/docs/reference/cli/)
