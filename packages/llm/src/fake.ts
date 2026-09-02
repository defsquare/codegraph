import type { LlmClient, LlmError, LlmRequest, LlmResponse } from "./client.js";

export interface FakeLlmOptions {
  /**
   * What to answer. Defaults to a document derived from the request alone, so
   * the same request always yields the same bytes: `{ "echo": <first line of
   * the user message>, "schema": <schema name> }`.
   */
  readonly respond?: (request: LlmRequest, call: number) => unknown;
  /** Calls (1-based) that fail instead of answering; the error is thrown as-is. */
  readonly failures?: ReadonlyMap<number, LlmError>;
  /** Reported usage per call; defaults to a fixed estimate from the prompt length. */
  readonly usage?: (request: LlmRequest) => { promptTokens: number; completionTokens: number; cost?: number };
}

export interface FakeLlmClient extends LlmClient {
  /** Every request received, in order. */
  readonly calls: readonly LlmRequest[];
}

/**
 * A deterministic, zero-latency client for tests and dry runs. It records
 * every request and answers from the request alone — no clock, no randomness —
 * so a suite asserting on a side-car's bytes gets the same bytes every run.
 */
export function fakeLlmClient(options: FakeLlmOptions = {}): FakeLlmClient {
  const calls: LlmRequest[] = [];
  const respond =
    options.respond ??
    ((request: LlmRequest): unknown => ({
      echo: request.user.split("\n")[0] ?? "",
      schema: request.schema.name,
    }));
  const usage =
    options.usage ??
    ((request: LlmRequest) => ({
      promptTokens: Math.ceil((request.system.length + request.user.length) / 4),
      completionTokens: 64,
    }));

  return {
    name: "fake",
    calls,
    complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      const failure = options.failures?.get(calls.length);
      if (failure !== undefined) return Promise.reject(failure);
      const json = respond(request, calls.length);
      return Promise.resolve({
        json,
        text: JSON.stringify(json),
        model: request.model,
        usage: usage(request),
      });
    },
  };
}
