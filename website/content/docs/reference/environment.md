---
title: Environment variables
linkTitle: Environment
weight: 8
---

Every environment variable the workspace reads, by subsystem: the `explain` command's provider resolution (and the Claude Code it may run), the desktop daemon, and the two Vite dev servers. One more is read only by a test.

`process.env` is read in six places at runtime — `packages/cli/src/commands/explain.ts` (the real seam hands it to the discovery and the resolution below), `packages/llm/src/claude-code.ts` (the environment a `claude -p` child inherits when the caller hands none), `packages/cli/src/app/store.ts` (the desktop daemon's data directory: `APPDATA` on Windows, `XDG_DATA_HOME` elsewhere), `packages/cli/src/app/jobs.ts` (the parent environment an extractor job is spawned with, plus the registry entry's own), `packages/viz/vite.config.ts` and `packages/navigator-ui/vite.config.ts` — and in one test, the opt-in corpus suite `packages/insights/test/cycles.test.ts`. `packages/llm/src/claude-code-discovery.ts` reads `process.platform`, not the environment, when no platform is passed in.

## Model provider

Read by [`explain`](/docs/reference/cli/explain/), which passes `process.env` into the Claude Code discovery (`packages/llm/src/claude-code-discovery.ts`) and the provider resolution (`packages/llm/src/providers.ts`). Nothing else in the workspace talks to a model provider: `serve` and the desktop daemon open sockets to serve pages, and the daemon's jobs, `scm` and `snapshots` spawn extractors and `git`, but no other code sends a prompt anywhere. A variable that is set but blank counts as absent.

| Variable | Provider | Required | What it does |
|---|---|---|---|
| `OPENROUTER_API_KEY` | `openrouter` | yes | the API key the OpenRouter client authenticates with |
| `CLOUDFLARE_API_TOKEN` | `cloudflare` | yes | the API token for Cloudflare AI Gateway's REST API |
| `CLOUDFLARE_ACCOUNT_ID` | `cloudflare` | yes | the Cloudflare account the gateway belongs to |
| `CLOUDFLARE_AI_GATEWAY_ID` | `cloudflare` | no | the named gateway to route through |
| `CLAUDE_CODE_PATH` | `claude-code` | no | the Claude Code binary, when `--claude-path` is not given; a path that does not exist is an error, never a fall-through. Without it, `claude` is looked for on `PATH` (`HOME`, and on Windows `USERPROFILE` and `APPDATA`, name the known install locations searched next) |

### How `--provider auto` decides

`auto` is the default. A key provider is *configured* when all of its required variables are present and non-blank; `claude-code` when the discovery found a binary.

| Situation | Chosen | Reason reported |
|---|---|---|
| exactly one configured | that one | `<its required variables> set`, or where the binary was found — always the absolute path, e.g. `provider: claude-code (found on PATH: /home/me/.local/bin/claude)`, or `found in a known install location: /home/me/.local/bin/claude`, `CLAUDE_CODE_PATH: /opt/tools/claude` |
| several configured | the first of OpenRouter, Cloudflare, Claude Code | `OpenRouter and Claude Code are configured; using OpenRouter (pass --provider claude-code to run the local Claude Code)` — a key is deliberate, an installed CLI is ambient |
| none configured | `openrouter`, reported as missing its variables | `no provider configured` |

An explicit `--provider openrouter`, `--provider cloudflare` or `--provider claude-code` skips the decision; its reason line is prefixed with the flag, e.g. `provider: claude-code (--provider claude-code, --claude-path: /opt/tools/claude)`. A run that needs calls then reports exactly what that provider lacks: the variables (`OPENROUTER_API_KEY is not set (--provider openrouter), and this run needs 68 model calls`), or for Claude Code what the discovery said (`no claude on PATH or in a known install location, and this run needs 68 model calls`; `--claude-path /nowhere/claude does not exist, …`; `CLAUDE_CODE_PATH=/x/claude does not exist, …`). `--claude-path FILE` implies `--provider claude-code` under `auto` and is refused with `--provider openrouter` or `cloudflare`. `--dry-run` and `--estimate` make no call and need no variable and no binary at all.

## Dev servers

Read only by the Vite configs, so only by `pnpm dev` in those packages. [`codegraph serve`](/docs/reference/cli/serve/) does not use them: it serves the built app with the artifacts already loaded.

| Variable | Read by | What it does |
|---|---|---|
| `CITY_JSON` | `packages/viz/vite.config.ts` | absolute path to a `city.json`; the dev server serves it at `/city.json` |
| `NAVIGATOR_JSON` | `packages/navigator-ui/vite.config.ts` | absolute path to a `navigator.json`; the dev server serves it at `/navigator.json` |
| `VOCABULARY_JSON` | `packages/navigator-ui/vite.config.ts` | absolute path to a `vocabulary.json`; the dev server serves it at `/vocabulary.json`, for the Vocabulary tab |

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

`JAVA_HOME` matters only to the [Java extractor](/docs/reference/java-extractor/), which is an ordinary JVM program: non-interactive shells do not source sdkman, so a JDK has to be on `PATH` explicitly. `PATH` is also where `explain` looks for `claude` (above), and `HOME`, `USERPROFILE` and `APPDATA` only name the install locations it searches next.
