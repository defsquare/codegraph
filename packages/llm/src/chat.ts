import { LlmError, type LlmResponse, type LlmUsage } from "./client.js";

/**
 * THE OPENAI CHAT-COMPLETION SHAPE, shared by every provider that speaks it.
 * OpenRouter's SDK returns it camel-cased (`promptTokens`), Cloudflare's REST
 * API returns it as the wire has it (`prompt_tokens`); the content, choices
 * and refusal layout are the same. One parser reads both, so a provider
 * module only has to build its request and move bytes.
 */

/**
 * Some models wrap the document in a Markdown fence even under a JSON response
 * format; the fence is presentation, not content, so it is stripped before
 * parsing. Anything else that is not JSON is a malformed reply — not retryable.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new LlmError(`model returned a non-JSON completion: ${body.slice(0, 200)}`, undefined, false, {
      cause: error,
    });
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

function numberOf(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) if (typeof candidate === "number") return candidate;
  return undefined;
}

/** Usage in either casing; undefined when the provider sent none. */
export function usageOf(raw: unknown): LlmUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const promptTokens = numberOf(u["promptTokens"], u["prompt_tokens"]);
  const completionTokens = numberOf(u["completionTokens"], u["completion_tokens"]);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const cost = numberOf(u["cost"]);
  return { promptTokens, completionTokens, ...(cost === undefined ? {} : { cost }) };
}

/** A chat-completion result → our response. Throws a non-retryable `LlmError` on an empty or non-JSON reply. */
export function parseChatCompletion(result: unknown, requestedModel: string): LlmResponse {
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
      typeof refusal === "string" && refusal !== "" ? `model refused: ${refusal}` : "model returned an empty completion",
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
