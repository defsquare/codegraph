---
title: "explain"
weight: 9
---

Explain every operation, type and module with an LLM, bottom-up, into a side-car.

## Synopsis

```
codegraph explain [model.jsonl...] [--src DIR] [--out FILE] [--provider <auto|openrouter|cloudflare|claude-code>] [--claude-path FILE] [--model SLUG] [--rollup-model SLUG] [--depth N] [--max-calls N] [--max-tokens N] [--concurrency N] [--max-lines N] [--max-scc N] [--terms N] [--scope IDS] [--include SEL] [--exclude SEL] [--levels LEVELS] [--closure <none|dependencies|containers|all>] [--instructions TEXT|@FILE] [--walk FILE] [--framework <spring>] [--internal-only] [--declared-only] [--no-cache] [--dry-run] [--estimate] [--price-in USD] [--price-out USD] [--force] [--retry-failed] [--export] [--import FILE] [--yes] [--json]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src DIR` | The source root the model's anchors are relative to. Defaults to the model's own `root`, resolved against the current directory. | — |
| `--out FILE` | The side-car to write (and to resume from). Defaults to <model>.insights.jsonl. | — |
| `--provider <auto\|openrouter\|cloudflare\|claude-code>` | Where the model calls go: openrouter (OPENROUTER_API_KEY), cloudflare — Cloudflare AI Gateway's REST API (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, optional CLOUDFLARE_AI_GATEWAY_ID) — or claude-code, the local Claude Code CLI in headless mode (`claude -p`, Sonnet by default, no key). auto picks whichever is configured; with several, OpenRouter, then Cloudflare, then Claude Code. | `auto` |
| `--claude-path FILE` | The Claude Code binary. Under `--provider auto` it implies claude-code; with openrouter or cloudflare it is an error. Otherwise CLAUDE_CODE_PATH, then `claude` on PATH, then the known install locations; a path that does not exist is an error, never a fall-through. | — |
| `--model SLUG` | Model slug for operations (the leaves). Defaults per provider: `openai/gpt-5.6-luna` (author/model form) on openrouter and cloudflare, `sonnet` on claude-code — an alias Claude Code resolves to the latest Sonnet, so a full id such as `claude-sonnet-5-5` pins the fingerprint. | per provider |
| `--rollup-model SLUG` | Model slug for types and modules; defaults to --model. | — |
| `--depth N` | How many levels of dependency explanations a prompt carries. | `1` |
| `--max-calls N` | Stop planning model calls after this many; what runs is a dependency-consistent prefix. | — |
| `--concurrency N` | Model calls in flight at once. | `4` |
| `--max-lines N` | Source lines shown per unit before the middle is elided. | `200` |
| `--max-scc N` | Members of a dependency cycle explained in one call; larger cycles are chunked. | `12` |
| `--terms N` | Words a module's glossary reconciles: the heaviest N its types define. | `60` |
| `--scope IDS` | Comma-separated module or type ids: explain only units inside them (dependencies outside are reused when already explained, never called). | — |
| `--include SEL` | Ask only the units whose member — itself, its nearest type or its nearest module — matches this [selector term](/docs/reference/walk-definition/#selectors): id:ID, kind:K, trait:T, lang:L, name:GLOB, module:GLOB, file:GLOB, edge:KIND[>TERM], edge-in:KIND[<TERM]. Repeatable: several are any of them. The walk is still built over the whole model. | — |
| `--exclude SEL` | Never ask a unit whose member (itself, its nearest type or module) matches this term; wins over --include. Repeatable. | — |
| `--levels LEVELS` | Comma-separated levels to ask: operation, type, module (all three unless given). | — |
| `--closure <none\|dependencies\|containers\|all>` | Also ask what the selection leans on: dependencies (every unit it depends on, so each asked prompt sees its callees answered), containers (the type and module above it), all (both). none unless given. | — |
| `--instructions TEXT\|@FILE` | Instructions added to every unit's system message, after the task (a definition's prompt.instructions); @FILE reads them from a file. Every unit asked under them is asked again when they change. | — |
| `--walk FILE` | A codegraph.walk/1 file customizing explain: select, exclude, levels, closure, context, prompt.instructions and prompt.entities (never prompt.task, answer, trivial, another name or version: explain's answer is the Specy blocks). A flag replaces the file's key. `codegraph walk --print-definition explain` prints one. | — |
| `--framework <spring>` | Add a framework's stereotypes and entry points to the facts shown. | — |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `--dry-run` | Print the plan — units, order, statuses, estimated tokens — and make no call. | — |
| `--estimate` | Print the token volume this run would send and receive (input and output, per level) and make no call. Add --price-in/--price-out for a cost. | — |
| `--price-in USD` | Input price in USD per million tokens, for --estimate's cost line. | — |
| `--price-out USD` | Output price in USD per million tokens, for --estimate's cost line. | — |
| `--max-tokens N` | Cap on the tokens one answer may use (reasoning included). Omitted, the provider assumes the model's full output window and a prepaid account must afford THAT for every call; a block is ~1k tokens, a full cycle call ~12k. An answer cut at the cap fails its unit. Does not apply to claude-code (the CLI has no output cap): noted on stderr, ignored. | — |
| `--force` | Re-explain every unit, ignoring records whose fingerprint still matches. | — |
| `--retry-failed` | Redo only the units the side-car records as failed (its `t:"f"` lines, each with the reason), plus their direct dependents, which were explained without them. Everything else is reused or left alone. Pass the same --model/--depth as the run that failed. | — |
| `--export` | Write the side-car from the insights store (<model>.insights.db) and stop: no model is read, no call is made. Every run ends with this export; use it after an interrupted one. | — |
| `--import FILE` | REPLACE the insights store's records with those of a side-car (one edited by hand, or one from another machine) and stop. Asks first when the store holds records; --yes skips it. | — |
| `-y, --yes` | Run without asking. Otherwise a run that makes model calls prints its token estimate and waits for confirmation — which needs an interactive terminal. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Customizing explain

`explain` runs on the engine [`walk`](/docs/reference/cli/walk/) runs on, with its own question — the Specy domain blocks — its own store and its own JSON kinds. Four kinds of flag narrow or extend it without changing that question:

- **What is asked.** `--include`, `--exclude`, `--levels` and `--closure` select units as a walk does ([what a selection means for the walk](/docs/reference/walk-definition/#what-a-selection-means-for-the-walk)). `--scope a,b` is `--include id:a --include id:b`: a unit is explained when its member, its nearest type or its nearest module is one of the ids — a sub-package is not reached through its parent, so a sub-tree is `--include 'module:com.acme.order**'`. `--scope` keeps its own check that every id exists. Trivial members stay templated whatever the selection.
- **What every prompt adds.** `--instructions TEXT` (or `@FILE`) is appended to every system message under `## Instructions`.
- **A file.** `--walk FILE` reads a [walk definition](/docs/reference/walk-definition/#customizing-explain-with-a-file) restricted to the selection, the context, `prompt.instructions` and `prompt.entities`; a task or answer fields are refused. A flag replaces the file's key.
- **Neither retries.** `--retry-failed` takes its scope from the failure records, so it is refused with `--scope` or any selection flag.

A customized explain keeps `codegraph.insights/1` and `<model>.insights.db`; the header records `walk: { name: "explain", version: "2", digest }`, and a unit no instruction reaches keeps its fingerprint, so its record is reused. When the instructions change, the plan's first line says how many records the run replaces, before anything is spent. With none of these flags, `explain` plans, prompts and records exactly the bytes it did before they existed.

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean, or when any unit failed to be explained. Each such unit leaves a [failure record](../../artifacts/insights-jsonl/#f--one-failure-record) in the side-car — entity, reason, HTTP status — and once the cause is dealt with (credits, rate limit, a larger model), the same command with `--retry-failed` redoes just those. With no failure on record it makes no call and exits `0`.

A `401`, `402` or `403` is about the account, not the unit: the run **aborts** — no further call is made, the side-car is still written — and the units it never reached are reported as *not attempted*, without a failure record. Run the same command again (without `--retry-failed`) to redo the failures and resume the rest.

## Example

```console
$ codegraph explain fixtures/java/expected/model.jsonl --src fixtures/java/src --dry-run
cache: fixtures/java/expected/model.db
explain plan: 77 units in 8 layers
  operation     57 units     48 calls ~78146 prompt tokens
  type          17 units     17 calls ~31000 prompt tokens
  module         3 units      3 calls ~4990 prompt tokens
  statuses: llm 68, template 9, reuse 0, skip-scope 0, skip-budget 0
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 68 calls, ~114136 prompt tokens in, ~52415 completion tokens out
```

Trimmed after the plan summary; one line per unit follows. `--dry-run` needs no API key and no binary; its `models:` line shows the default the resolved provider would run (`sonnet` when `auto` lands on an installed Claude Code).

## See also

[insights.jsonl](/docs/reference/artifacts/insights-jsonl/) · [`walk`](/docs/reference/cli/walk/) · [Walk definitions and selectors](/docs/reference/walk-definition/) · [`insights`](/docs/reference/cli/insights/) · [Environment variables](/docs/reference/environment/) · [CLI conventions](/docs/reference/cli/)
