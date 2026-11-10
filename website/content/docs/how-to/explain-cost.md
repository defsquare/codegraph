---
title: Estimate, cap and scope an explain run
linkTitle: Explain cost
weight: 11
---

`explain` is the only command that costs money and needs a network. Everything
here is about knowing what a run will cost before you start it, and bounding it
once you do.

**Before you start:** a `model.jsonl` and the source tree its anchors point into.
No API key is needed for `--dry-run` or `--estimate`.

## See the plan without calling anything

```bash
codegraph explain model.jsonl --src fixtures/java/src --dry-run
```

```text
explain plan: 77 units in 8 layers
  operation     57 units     48 calls ~78146 prompt tokens
  type          17 units     17 calls ~31000 prompt tokens
  module         3 units      3 calls ~4990 prompt tokens
  statuses: llm 68, template 9, reuse 0, skip-scope 0, skip-budget 0
  models: openai/gpt-5.6-luna (operations), openai/gpt-5.6-luna (types, modules); depth 1
  total: 68 calls, ~114136 prompt tokens in, ~52415 completion tokens out

llm         L0 operation java:com.acme.order.adapter/LedgerAdapter.<init>() calls=1 ~1461tok
template    L0 operation java:com.acme.order.legacy/List.head()
```

77 units, 68 calls: nine are `template`. A getter, a setter,
`equals`/`hashCode`/`toString`/`compareTo` or a field-assigning constructor is
described from facts alone and never sent to a model.

## Price it

```bash
codegraph explain model.jsonl --src fixtures/java/src \
  --estimate --price-in 0.10 --price-out 0.60
```

```text
  level        calls   input tokens  output tokens
  operation       48         78 146         30 120
  type            17         31 000         15 470
  module           3          4 990          6 825
  total           68        114 136         52 415

  cost at $0.1/M in, $0.6/M out: $0.0429
  input ≈ rendered prompts at 4 characters per token; output ≈ measured on a live run: operation 470, type 530, module 530 tokens per block asked for, plus 120 per word and 125 per glossary entry asked to define (gpt-5.6-luna, reasoning included).
  not included: repair re-asks, rate-limit retries. Records already in the side-car are reused, not re-sent.
```

Prices are USD per million tokens; without them you still get the volumes.
Take the figure as a floor: repair re-asks and rate-limit retries are not in it.

## Bound the run

```bash
codegraph explain model.jsonl --src src/main/java --max-calls 50
```

`--max-calls N` stops *planning* calls after N, and what runs is always a
dependency-consistent prefix — never a half-explained unit whose dependencies
were skipped.

```bash
codegraph explain model.jsonl --src src/main/java --scope java:com.acme.order.legacy
```

`--scope` takes comma-separated module or type ids and explains only what is
inside them. Dependencies outside the scope are reused when they already have a
record and are never called. The estimate follows the scope:

```text
  calls: 3 (template 9, reuse 0, skipped 65)
  total            3          4 305          2 000
```

**Combine them:** scope to one package, estimate, then run. That is the cheapest
way to see whether the output is worth paying for on the rest of the corpus.

## Choose a provider

| Provider | What it needs |
|---|---|
| OpenRouter | `OPENROUTER_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, optional `CLOUDFLARE_AI_GATEWAY_ID` |
| Claude Code | an installed and logged-in Claude Code; no key; `--claude-path FILE` or `CLAUDE_CODE_PATH` when it is not on `PATH`. On Windows an npm-global `claude.cmd` is found but cannot be run (Node refuses `.cmd` without a shell: `EINVAL`); point `--claude-path` at the native installer's `%USERPROFILE%\.local\bin\claude.exe` |

`--provider auto` (the default) picks the one that is configured; with several
it takes OpenRouter, then Cloudflare, then Claude Code — an exported key is a
deliberate act, an installed CLI is ambient, so the CLI never overrides a key.
`--provider openrouter`, `--provider cloudflare` or `--provider claude-code`
forces one. The Cloudflare token needs the AI Gateway Run permission, and
without `CLOUDFLARE_AI_GATEWAY_ID` the account's default gateway is used. Claude
Code runs in headless mode (`claude -p`), one process per call, Sonnet by
default (`--model sonnet`); it spends the subscription — the cost the run
reports is the CLI's `total_cost_usd` at list price — and `--max-tokens` does
not apply. Every `claude -p` prompt carries Claude Code's own scaffolding and
the response schema, so its estimate adds 1 850 tokens a call plus the schema
and says so (`plus 1 850 per call and the response schema that claude-code
adds to every prompt`): on the Java fixture that is 280 481 input tokens
against 114 136 for a key provider, for the same 68 calls. The fingerprint carries the slug as requested (`sonnet`) and each
record's `model` the id that served (`claude-sonnet-5-5`), so a new Sonnet
behind the alias does not re-explain what was explained; a full id in `--model`
does. `--claude-path` implies `--provider claude-code` under `auto` and is
refused with a key provider.

With nothing configured, the command refuses before it does any work:

```text
codegraph: OPENROUTER_API_KEY is not set (no provider configured), and this run needs 1 model call
```

Model slugs are the same `author/model` form on both key providers, so switching
between them leaves every fingerprint — and every reusable record — intact.
Claude Code names models its own way (`sonnet`, `claude-sonnet-5-5`), so moving
to or from it re-explains what the new slug covers.

## Pick models per level

```bash
codegraph explain model.jsonl --src src/main/java \
  --model a/cheap-model --rollup-model a/stronger-model
```

`--model` explains the leaves (operations), `--rollup-model` the types and
modules; it defaults to `--model`. A cheap model for the many leaf calls and a
stronger one for the few roll-ups is the intended split.

## Control the request rate

`--concurrency N` (default 4) is how many calls are in flight at once. A
rate-limited account is better served by `--concurrency 1` — OpenRouter allows
new accounts 20 requests a minute. On a 429 the client obeys the provider's
`Retry-After` before retrying.

## Re-run only what changed

Explanations go to `<model>.insights.jsonl` beside the model — never into
`model.jsonl` or `model.db`. Records are appended to a `.journal` as they arrive
and the sorted side-car is rewritten at every layer, so an interrupted run
resumes where it stopped.

A re-run reuses every unit whose fingerprint still matches. Because the
fingerprint covers the unit's inputs *and* its dependencies' fingerprints,
changing one method's source re-explains exactly its transitive dependents and
containers. Explanation text is deliberately not hashed, so a differently-worded
answer never cascades.

```bash
codegraph explain model.jsonl --src src/main/java --force
```

`--force` re-explains everything, ignoring matching fingerprints. Use it when the
prompt or the model changed in a way the fingerprint does not see.

{{< callout type="info" >}}
`--dry-run` and `--estimate` make no call and need no key, so they are safe in
CI. `--json` prints the same information as a machine-readable object.
{{< /callout >}}

## Related

- [Explaining a package with a language model](/docs/tutorials/explain/)
- [`codegraph explain`](/docs/reference/cli/explain/)
- [Environment variables](/docs/reference/environment/)
- [Explaining bottom-up](/docs/explanation/explaining-bottom-up/)
