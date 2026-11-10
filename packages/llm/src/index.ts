/**
 * `@codegraph/llm` — the one package in the workspace that talks to a model
 * provider. Everything else programs against `LlmClient`:
 *
 *   client.ts                 the contract: one structured completion in, parsed JSON out
 *   retry.ts                  exponential back-off on transient provider errors, Retry-After obeyed
 *   chat.ts                   the OpenAI chat-completion shape the two HTTP providers return
 *   openrouter.ts             OpenRouter through its SDK — the ONLY module allowed to
 *                             import a provider SDK (test/boundary.test.ts enforces it)
 *   cloudflare.ts             Cloudflare AI Gateway through its REST API, plain fetch
 *   claude-code.ts            Claude Code headless (`claude -p`), one subprocess per call
 *   claude-code-discovery.ts  where the `claude` binary is: option, variable, PATH, known installs
 *   providers.ts              which provider, decided from the environment (and the
 *                             discovery) in one place
 *   fake.ts                   a deterministic, zero-latency client for tests and dry runs
 *
 * No test in the workspace opens a socket or spawns a process: the fake, an
 * injected transport, an injected fetch and an injected process cover every
 * path the real clients have.
 */
export * from "./client.js";
export * from "./retry.js";
export * from "./chat.js";
export * from "./openrouter.js";
export * from "./cloudflare.js";
export * from "./claude-code.js";
export * from "./claude-code-discovery.js";
export * from "./providers.js";
export * from "./fake.js";
