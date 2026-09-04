import { OpenRouter } from "@openrouter/sdk";
import type { ChatRequest } from "@openrouter/sdk/models";
import { ConnectionError, OpenRouterError, RequestTimeoutError } from "@openrouter/sdk/models/errors";
import {
  LlmError,
  isLlmError,
  isRetryableStatus,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "./client.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * The OpenRouter implementation of `LlmClient`, and THE ONLY MODULE in the
 * workspace that imports the provider SDK (test/boundary.test.ts). The SDK is
 * held behind `OpenRouterTransport` — one function — so a test drives the whole
 * request/response/error path with a fake transport and never opens a socket,
 * and an SDK breaking change is repaired in exactly one place.
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

/**
 * Some models wrap the document in a Markdown fence even under a JSON response
 * format; the fence is presentation, not content, so it is stripped before
 * parsing. Anything else that is not JSON is a malformed reply — not retryable.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new LlmError(
      `model returned a non-JSON completion: ${body.slice(0, 200)}`,
      undefined,
      false,
      { cause: error },
    );
  }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("");
}

function usageOf(raw: unknown): LlmUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = raw as { promptTokens?: unknown; completionTokens?: unknown; cost?: unknown };
  if (typeof usage.promptTokens !== "number" || typeof usage.completionTokens !== "number") return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
  };
}

/** The SDK result → our response. Throws a non-retryable `LlmError` on an empty or non-JSON reply. */
export function parseChatResult(result: unknown, requestedModel: string): LlmResponse {
  const shaped = result as {
    model?: unknown;
    choices?: readonly { message?: { content?: unknown; refusal?: unknown } }[];
    usage?: unknown;
  } | null;
  const first = shaped?.choices?.[0];
  const text = contentText(first?.message?.content);
  if (text === undefined || text.trim() === "") {
    const refusal = first?.message?.refusal;
    throw new LlmError(
      typeof refusal === "string" && refusal !== ""
        ? `model refused: ${refusal}`
        : "model returned an empty completion",
      undefined,
      false,
    );
  }
  const usage = usageOf(shaped?.usage);
  return {
    json: extractJson(text),
    text,
    model: typeof shaped?.model === "string" ? shaped.model : requestedModel,
    ...(usage === undefined ? {} : { usage }),
  };
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

/** `Retry-After` as seconds or an HTTP date → milliseconds to wait; undefined when absent or unreadable. */
export function retryAfterOf(headers: unknown): number | undefined {
  const get = (headers as { get?: (name: string) => string | null } | null)?.get;
  const raw = typeof get === "function" ? get.call(headers, "retry-after") : undefined;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

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
