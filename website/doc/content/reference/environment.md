---
title: Environment variables
linkTitle: Environment
weight: 8
---

Every environment variable the workspace reads. There are five at runtime, read by two subsystems: the `explain` command's provider resolution, and the two Vite dev servers. One more is read only by a test.

`process.env` is read in exactly four places — `packages/cli/src/commands/explain.ts`, `packages/viz/vite.config.ts`, `packages/navigator-ui/vite.config.ts`, and the opt-in corpus test `packages/insights/test/cycles.test.ts`.

## Model provider

Read by [`explain`](/reference/cli/explain/), which passes `process.env` into the provider resolution in `packages/llm/src/providers.ts`. Nothing else in the workspace opens a socket. A variable that is set but blank counts as absent.

| Variable | Provider | Required | What it does |
|---|---|---|---|
| `OPENROUTER_API_KEY` | `openrouter` | yes | the API key the OpenRouter client authenticates with |
| `CLOUDFLARE_API_TOKEN` | `cloudflare` | yes | the API token for Cloudflare AI Gateway's REST API |
| `CLOUDFLARE_ACCOUNT_ID` | `cloudflare` | yes | the Cloudflare account the gateway belongs to |
| `CLOUDFLARE_AI_GATEWAY_ID` | `cloudflare` | no | the named gateway to route through |

### How `--provider auto` decides

`auto` is the default. A provider is *configured* when all of its required variables are present and non-blank.

| Situation | Chosen | Reason reported |
|---|---|---|
| exactly one configured | that one | `<its required variables> set` |
| both configured | `openrouter` | `both OpenRouter and Cloudflare are configured; using OpenRouter (pass --provider cloudflare to route through AI Gateway)` |
| neither configured | `openrouter`, reported as missing its variables | `no provider configured` |

An explicit `--provider openrouter` or `--provider cloudflare` skips the decision and reports exactly which variables that provider still lacks. `--dry-run` and `--estimate` make no call and need no variable at all.

## Dev servers

Read only by the Vite configs, so only by `pnpm dev` in those packages. The `--serve` flags on [`city`](/reference/cli/city/) and [`navigator`](/reference/cli/navigator/) do not use them: they serve the built app with the artifact already loaded.

| Variable | Read by | What it does |
|---|---|---|
| `CITY_JSON` | `packages/viz/vite.config.ts` | absolute path to a `city.json`; the dev server serves it at `/city.json` |
| `NAVIGATOR_JSON` | `packages/navigator-ui/vite.config.ts` | absolute path to a `navigator.json`; the dev server serves it at `/navigator.json` |

```bash
CITY_JSON=$PWD/city.json pnpm --filter @codegraph/viz dev
NAVIGATOR_JSON=$PWD/navigator.json pnpm --filter @codegraph/navigator-ui dev
```

Without the variable the app falls back to `?src=URL`, drag and drop, or a file picker — the dev server never becomes a required part of the pipeline. An unreadable path answers `404` with the reason.

## Tests only

| Variable | Read by | What it does |
|---|---|---|
| `CODEGRAPH_CORPUS_MODEL` | `packages/insights/test/cycles.test.ts` | path to a real `model.jsonl`; when set, the cycle suite additionally checks the insights walk's unit condensation against the analyzer's cycle report on that corpus. Unset, the test is skipped. |

## Not environment variables

`JAVA_HOME` and `PATH` matter only to the [Java extractor](/reference/java-extractor/), which is an ordinary JVM program: non-interactive shells do not source sdkman, so a JDK has to be on `PATH` explicitly.
