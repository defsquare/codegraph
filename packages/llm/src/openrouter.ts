import { OpenRouter } from "@openrouter/sdk";
import type { ChatRequest } from "@openrouter/sdk/models";
import { ConnectionError, OpenRouterError, RequestTimeoutError } from "@openrouter/sdk/models/errors";
import { parseChatCompletion, retryAfterOf } from "./chat.js";
import {
  LlmError,
  isLlmError,
  isRetryableStatus,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from "./client.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * The OpenRouter implementation of `LlmClient`, and THE ONLY MODULE in the
 * workspace that imports the provider SDK (test/boundary.test.ts). The SDK is
 * held behind `OpenRouterTransport` — one function — so a test drives the whole
 * request/response/error path with a fake transport and never opens a socket,
 * and an SDK breaking change is repaired in exactly one place.
 *
 * The Cloudflare AI Gateway client (cloudflare.ts) speaks the same
 * chat-completion contract without an SDK; what differs is listed there.
 */

export interface OpenRouterTransport {
  /** Send one non-streaming chat completion; resolves to the SDK's result object. */
  send(request: ChatRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface OpenRouterOptions {
  /** From `OPENROUTER_API_KEY`, resolved by the caller — never read from the environment here. */
  readonly apiKey: string;
  /** Defaults to the real SDK; tests inject a fake. */
  readonly transport?: OpenRouterTransport;
  readonly retry?: RetryOptions;
  /** Shown in OpenRouter's dashboard as the calling app. */
  readonly appTitle?: string;
}

/** The provider request for one structured completion: strict JSON Schema, temperature 0 by default. */
export function buildChatRequest(request: LlmRequest): ChatRequest {
  return {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    responseFormat: {
      type: "json_schema",
      jsonSchema: {
        name: request.schema.name,
        strict: true,
        schema: { ...request.schema.jsonSchema },
      },
    },
    temperature: request.temperature ?? 0,
    stream: false,
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.reasoningEffort === undefined ? {} : { reasoning: { effort: request.reasoningEffort } }),
  };
}

/** The SDK result → our response (the shared chat-completion parser). */
export function parseChatResult(result: unknown, requestedModel: string): LlmResponse {
  return parseChatCompletion(result, requestedModel);
}

/**
 * Every failure becomes one `LlmError` whose `retryable` is decided from the
 * provider's status: rate limits, overloads and transport failures are
 * transient; auth, quota and rejected requests are final.
 */
export function toLlmError(error: unknown): LlmError {
  if (isLlmError(error)) return error;
  if (error instanceof OpenRouterError) {
    const retryAfterMs = retryAfterOf(error.headers);
    return new LlmError(error.message, error.statusCode, isRetryableStatus(error.statusCode), {
      cause: error,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (error instanceof ConnectionError || error instanceof RequestTimeoutError) {
    return new LlmError(error.message, undefined, true, { cause: error });
  }
  // Defensive: anything carrying an HTTP status is classified by it.
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number") {
    const message = error instanceof Error ? error.message : String(error);
    const retryAfterMs = retryAfterOf((error as { headers?: unknown }).headers);
    return new LlmError(message, status, isRetryableStatus(status), {
      cause: error,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(message, undefined, false, { cause: error });
}

export { retryAfterOf };

function sdkTransport(apiKey: string, appTitle: string): OpenRouterTransport {
  const sdk = new OpenRouter({ apiKey });
  return {
    send: (request, signal) =>
      sdk.chat.send({ chatRequest: request, appTitle }, signal === undefined ? undefined : { signal }),
  };
}

export function openRouterClient(options: OpenRouterOptions): LlmClient {
  const transport = options.transport ?? sdkTransport(options.apiKey, options.appTitle ?? "codegraph");
  return {
    name: "openrouter",
    complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const wire = buildChatRequest(request);
      return withRetry(async () => {
        let result: unknown;
        try {
          result = await transport.send(wire, signal);
        } catch (error) {
          throw toLlmError(error);
        }
        return parseChatResult(result, request.model);
      }, options.retry);
    },
  };
}
