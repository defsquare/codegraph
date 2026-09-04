import { parseChatCompletion, retryAfterOf } from "./chat.js";
import { LlmError, isLlmError, isRetryableStatus, type LlmClient, type LlmRequest, type LlmResponse } from "./client.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * Cloudflare AI Gateway as an `LlmClient`, through the AI REST API:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions
 *   Authorization: Bearer <Cloudflare API token>     (cf-aig-gateway-id: <gateway>)
 *
 * WHAT DIFFERS FROM THE OPENROUTER CLIENT, and why there are two files:
 *
 *  - No SDK. The endpoint is OpenAI's chat-completion contract over plain
 *    HTTPS, so the request is built by hand and sent with `fetch`; the
 *    provider-SDK boundary (test/boundary.test.ts) stays exactly one file.
 *  - Wire casing. The body and the reply use the wire's snake_case
 *    (`response_format`, `max_tokens`, `prompt_tokens`); OpenRouter's SDK
 *    camel-cases both sides. The shared parser in chat.ts reads either.
 *  - Credentials. One Cloudflare API token authenticates AND bills
 *    (Unified Billing or a stored provider key — BYOK); no provider key ever
 *    travels with a request. OpenRouter needs its own key per request.
 *  - Model naming is the same `author/model` form (`openai/gpt-5.6-luna`), so
 *    a fingerprint does not change when the route changes — the model does not.
 *  - Errors arrive as HTTP statuses on the response, not as SDK error classes;
 *    the same retryable/final rule and `Retry-After` reading apply.
 */

export interface CloudflareGatewayOptions {
  /** `CLOUDFLARE_ACCOUNT_ID`. */
  readonly accountId: string;
  /** `CLOUDFLARE_API_TOKEN` with AI Gateway Run permission. Never read from the environment here. */
  readonly apiToken: string;
  /** `CLOUDFLARE_AI_GATEWAY_ID`; the account's default gateway when absent. */
  readonly gatewayId?: string;
  /** Defaults to the global `fetch`; tests inject a fake. */
  readonly fetch?: typeof fetch;
  readonly retry?: RetryOptions;
  /** Override the API origin (tests, private deployments). */
  readonly baseUrl?: string;
}

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export function cloudflareEndpoint(accountId: string, baseUrl = CLOUDFLARE_API_BASE): string {
  return `${baseUrl.replace(/\/+$/u, "")}/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
}

/** The OpenAI-shaped wire body: strict JSON Schema, temperature 0 by default. */
export function buildCloudflareBody(request: LlmRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: request.schema.name, strict: true, schema: { ...request.schema.jsonSchema } },
    },
    temperature: request.temperature ?? 0,
    stream: false,
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),
  };
}

export function buildCloudflareHeaders(options: Pick<CloudflareGatewayOptions, "apiToken" | "gatewayId">): Record<string, string> {
  return {
    authorization: `Bearer ${options.apiToken}`,
    "content-type": "application/json",
    ...(options.gatewayId === undefined ? {} : { "cf-aig-gateway-id": options.gatewayId }),
  };
}

/** A non-2xx reply → one `LlmError` classified by status, carrying the provider's message and `Retry-After`. */
export async function cloudflareResponseError(response: Response): Promise<LlmError> {
  let detail = "";
  try {
    const text = await response.text();
    const json = JSON.parse(text) as { errors?: { message?: unknown }[]; error?: { message?: unknown } | string } | null;
    const fromList = json?.errors?.map((e) => e.message).filter((m): m is string => typeof m === "string") ?? [];
    const fromObject = typeof json?.error === "string" ? json.error : json?.error?.message;
    detail = fromList.length > 0 ? fromList.join("; ") : typeof fromObject === "string" ? fromObject : text.slice(0, 200);
  } catch {
    // The body was not JSON or not readable; the status is the message.
  }
  const retryAfterMs = retryAfterOf(response.headers);
  return new LlmError(
    `cloudflare ai gateway: HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`,
    response.status,
    isRetryableStatus(response.status),
    retryAfterMs === undefined ? undefined : { retryAfterMs },
  );
}

export function cloudflareGatewayClient(options: CloudflareGatewayOptions): LlmClient {
  const send = options.fetch ?? fetch;
  const url = cloudflareEndpoint(options.accountId, options.baseUrl);
  const headers = buildCloudflareHeaders(options);
  return {
    name: options.gatewayId === undefined ? "cloudflare" : `cloudflare/${options.gatewayId}`,
    complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const body = JSON.stringify(buildCloudflareBody(request));
      return withRetry(async () => {
        let response: Response;
        try {
          response = await send(url, { method: "POST", headers, body, ...(signal === undefined ? {} : { signal }) });
        } catch (error) {
          if (isLlmError(error)) throw error;
          // fetch rejects only on transport failure (DNS, reset, abort): transient.
          const message = error instanceof Error ? error.message : String(error);
          throw new LlmError(`cloudflare ai gateway: ${message}`, undefined, true, { cause: error });
        }
        if (!response.ok) throw await cloudflareResponseError(response);
        let json: unknown;
        try {
          json = await response.json();
        } catch (error) {
          throw new LlmError("cloudflare ai gateway: reply is not JSON", undefined, false, { cause: error });
        }
        return parseChatCompletion(json, request.model);
      }, options.retry);
    },
  };
}
