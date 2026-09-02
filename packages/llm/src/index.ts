/**
 * `@codegraph/llm` — the one package in the workspace that talks to a model
 * provider. Everything else programs against `LlmClient`:
 *
 *   client.ts      the contract: one structured completion in, parsed JSON out
 *   retry.ts       exponential back-off on transient provider errors
 *   openrouter.ts  the OpenRouter implementation — the ONLY module allowed to
 *                  import the provider SDK (test/boundary.test.ts enforces it)
 *   fake.ts        a deterministic, zero-latency client for tests and dry runs
 *
 * No test in the workspace opens a socket: the fake and an injected transport
 * cover every path the real client has.
 */
export * from "./client.js";
export * from "./retry.js";
export * from "./openrouter.js";
export * from "./fake.js";
