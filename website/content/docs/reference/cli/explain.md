---
title: "explain"
weight: 9
---

Explain every operation, type and module with an LLM, bottom-up, into a side-car.

## Synopsis

```
codegraph explain [model.jsonl...] [--src DIR] [--out FILE] [--provider <auto|openrouter|cloudflare>] [--model SLUG] [--rollup-model SLUG] [--depth N] [--max-calls N] [--concurrency N] [--max-lines N] [--max-scc N] [--scope IDS] [--framework <spring>] [--internal-only] [--declared-only] [--no-cache] [--dry-run] [--estimate] [--price-in USD] [--price-out USD] [--force] [--json]
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
| `--provider <auto\|openrouter\|cloudflare>` | Where the model calls go: openrouter (OPENROUTER_API_KEY) or cloudflare — Cloudflare AI Gateway's REST API (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, optional CLOUDFLARE_AI_GATEWAY_ID). auto picks whichever is configured, OpenRouter when both are. | `auto` |
| `--model SLUG` | Model slug for operations (the leaves), in author/model form on either provider. | `openai/gpt-5.6-luna` |
| `--rollup-model SLUG` | Model slug for types and modules; defaults to --model. | — |
| `--depth N` | How many levels of dependency explanations a prompt carries. | `1` |
| `--max-calls N` | Stop planning model calls after this many; what runs is a dependency-consistent prefix. | — |
| `--concurrency N` | Model calls in flight at once. | `4` |
| `--max-lines N` | Source lines shown per unit before the middle is elided. | `200` |
| `--max-scc N` | Members of a dependency cycle explained in one call; larger cycles are chunked. | `12` |
| `--scope IDS` | Comma-separated module or type ids: explain only units inside them (dependencies outside are reused when already explained, never called). | — |
| `--framework <spring>` | Add a framework's stereotypes and entry points to the facts shown. | — |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `--dry-run` | Print the plan — units, order, statuses, estimated tokens — and make no call. | — |
| `--estimate` | Print the token volume this run would send and receive (input and output, per level) and make no call. Add --price-in/--price-out for a cost. | — |
| `--price-in USD` | Input price in USD per million tokens, for --estimate's cost line. | — |
| `--price-out USD` | Output price in USD per million tokens, for --estimate's cost line. | — |
| `--force` | Re-explain every unit, ignoring records whose fingerprint still matches. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `-h, --help` | Show this help. | — |

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean, or when any unit failed to be explained.

## Example

```console
$ codegraph explain fixtures/java/expected/model.jsonl --src fixtures/java/src --dry-run
cache: fixtures/java/expected/model.db
explain plan: 77 units in 8 layers
  operation     57 units     48 calls ~70459 prompt tokens
  type          17 units     17 calls ~28078 prompt tokens
  module         3 units      3 calls ~4249 prompt tokens
  statuses: llm 68, template 9, reuse 0, skip-scope 0, skip-budget 0
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 68 calls, ~102786 prompt tokens in, ~36650 completion tokens out
```

Trimmed after the plan summary; one line per unit follows. `--dry-run` needs no API key.

## See also

[insights.jsonl](/docs/reference/artifacts/insights-jsonl/) · [Environment variables](/docs/reference/environment/) · [CLI conventions](/docs/reference/cli/)
