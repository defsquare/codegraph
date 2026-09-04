/**
 * `@codegraph/llm` — the one package in the workspace that talks to a model
 * provider. Everything else programs against `LlmClient`:
 *
 *   client.ts      the contract: one structured completion in, parsed JSON out
 *   retry.ts       exponential back-off on transient provider errors, Retry-After obeyed
 *   chat.ts        the OpenAI chat-completion shape both providers return
 *   openrouter.ts  OpenRouter through its SDK — the ONLY module allowed to
 *                  import a provider SDK (test/boundary.test.ts enforces it)
 *   cloudflare.ts  Cloudflare AI Gateway through its REST API, plain fetch
 *   providers.ts   which provider, decided from the environment in one place
 *   fake.ts        a deterministic, zero-latency client for tests and dry runs
 *
 * No test in the workspace opens a socket: the fake, an injected transport
 * and an injected fetch cover every path the real clients have.
 */
export * from "./client.js";
export * from "./retry.js";
export * from "./chat.js";
export * from "./openrouter.js";
export * from "./cloudflare.js";
export * from "./providers.js";
export * from "./fake.js";
