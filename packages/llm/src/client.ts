/**
 * The client contract every consumer programs against. It is deliberately
 * smaller than any provider API: one structured completion in, one parsed JSON
 * document out, with the usage the provider reported. Everything a consumer
 * needs to be deterministic in tests — the fake in `fake.ts` — implements this
 * same interface, so no test in the workspace ever opens a socket.
 */

/** A JSON Schema document, as produced by `z.toJSONSchema` or written by hand. */
export type JsonSchema = { readonly [key: string]: unknown };

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface LlmRequest {
  /** The provider's model slug, e.g. `openai/gpt-5.6-luna`. */
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** The response MUST conform to this schema (strict structured output). */
  readonly schema: { readonly name: string; readonly jsonSchema: JsonSchema };
  /** Defaults to 0: explanations should be as reproducible as the provider allows. */
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Reasoning budget, for models that expose one. Omitted = provider default. */
  readonly reasoningEffort?: ReasoningEffort;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Provider-reported cost in USD, when the provider includes it. */
  readonly cost?: number;
}

export interface LlmResponse {
  /** The parsed JSON document — unvalidated: the consumer owns the schema check. */
  readonly json: unknown;
  /** The raw text the model returned, for diagnostics. */
  readonly text: string;
  /** The model that actually served the request (routers may substitute). */
  readonly model: string;
  readonly usage?: LlmUsage;
}

export interface LlmClient {
  /** A short label for progress lines: `openrouter`, `fake`. */
  readonly name: string;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

/**
 * The one error type a consumer sees. `retryable` is decided HERE, once, from
 * the provider's status: rate limits, overloads and transport failures are
 * transient; a rejected request, an auth failure or a malformed reply are not.
 */
export class LlmError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** The provider's own wait (`Retry-After`), in milliseconds, when it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    status: number | undefined,
    retryable: boolean,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}

/** Transient by HTTP convention: 408, 429 and every 5xx. No status = network failure = transient. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}
