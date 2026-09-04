import { describe, expect, it } from "vitest";
import { LlmError, type LlmRequest } from "../src/client.js";
import { buildChatRequest, openRouterClient, parseChatResult, retryAfterOf, toLlmError, type OpenRouterTransport } from "../src/openrouter.js";

const KEY = "sk-or-v1-secret-test-key";

const REQUEST: LlmRequest = {
  model: "openai/gpt-5.6-luna",
  system: "You are a DDD architect.",
  user: "# Unit java:p/A.f()\nexplain",
  schema: {
    name: "operation",
    jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
};

function result(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    id: "gen-1",
    model: "openai/gpt-5.6-luna-2026",
    choices: [{ index: 0, finishReason: "stop", message: { role: "assistant", content } }],
    usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160, cost: 0.00003 },
    ...extra,
  };
}

class StatusError extends Error {
  constructor(readonly statusCode: number) {
    super(`http ${statusCode}`);
  }
}

function scripted(responses: readonly (unknown | Error)[]): OpenRouterTransport & { sent: unknown[] } {
  const sent: unknown[] = [];
  let call = 0;
  return {
    sent,
    send(request) {
      sent.push(request);
      const next = responses[call];
      call += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

describe("buildChatRequest", () => {
  it("asks for a strict JSON-schema completion at temperature 0, with the key nowhere in it", () => {
    const wire = buildChatRequest(REQUEST);
    expect(wire.model).toBe("openai/gpt-5.6-luna");
    expect(wire.messages).toEqual([
      { role: "system", content: REQUEST.system },
      { role: "user", content: REQUEST.user },
    ]);
    expect(wire.responseFormat).toEqual({
      type: "json_schema",
      jsonSchema: { name: "operation", strict: true, schema: REQUEST.schema.jsonSchema },
    });
    expect(wire.temperature).toBe(0);
    expect(wire.stream).toBe(false);
    expect(JSON.stringify(wire)).not.toContain(KEY);
    expect(JSON.stringify(wire)).not.toContain("apiKey");
  });

  it("passes the optional budget knobs through only when set", () => {
    const wire = buildChatRequest({ ...REQUEST, maxTokens: 800, reasoningEffort: "low", temperature: 0.2 });
    expect(wire.maxTokens).toBe(800);
    expect(wire.reasoning).toEqual({ effort: "low" });
    expect(wire.temperature).toBe(0.2);
    expect("maxTokens" in buildChatRequest(REQUEST)).toBe(false);
  });
});

describe("parseChatResult", () => {
  it("parses the JSON document and maps usage and the served model", () => {
    const response = parseChatResult(result('{"name":"bill"}'), REQUEST.model);
    expect(response.json).toEqual({ name: "bill" });
    expect(response.text).toBe('{"name":"bill"}');
    expect(response.model).toBe("openai/gpt-5.6-luna-2026");
    expect(response.usage).toEqual({ promptTokens: 120, completionTokens: 40, cost: 0.00003 });
  });

  it("strips a Markdown fence and joins text content parts", () => {
    expect(parseChatResult(result('```json\n{"name":"x"}\n```'), REQUEST.model).json).toEqual({ name: "x" });
    const parts = [{ type: "text", text: '{"na' }, { type: "text", text: 'me":"y"}' }];
    expect(parseChatResult(result(parts), REQUEST.model).json).toEqual({ name: "y" });
  });

  it("treats a non-JSON or empty completion as a final (non-retryable) error", () => {
    expect(() => parseChatResult(result("Sure! Here is the answer."), REQUEST.model)).toThrow(LlmError);
    try {
      parseChatResult(result(""), REQUEST.model);
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).retryable).toBe(false);
    }
    expect(() => parseChatResult(result(null, { choices: [] }), REQUEST.model)).toThrow(/empty completion/);
  });
});

describe("retryAfterOf", () => {
  it("reads seconds, an HTTP date, or nothing", () => {
    const headers = (value: string | null) => ({ get: (name: string) => (name === "retry-after" ? value : null) });
    expect(retryAfterOf(headers("7"))).toBe(7000);
    expect(retryAfterOf(headers(new Date(Date.now() + 5000).toUTCString()))).toBeGreaterThan(3000);
    expect(retryAfterOf(headers(null))).toBeUndefined();
    expect(retryAfterOf(headers("soon"))).toBeUndefined();
    expect(retryAfterOf(undefined)).toBeUndefined();
  });

  it("rides on the error a status-bearing failure becomes", () => {
    const error = Object.assign(new StatusError(429), { headers: { get: () => "3" } });
    expect(toLlmError(error)).toMatchObject({ status: 429, retryable: true, retryAfterMs: 3000 });
  });
});

describe("toLlmError", () => {
  it("classifies by HTTP status: 429 and 5xx retry, 4xx do not, no status is final for foreign errors", () => {
    expect(toLlmError(new StatusError(429))).toMatchObject({ status: 429, retryable: true });
    expect(toLlmError(new StatusError(503))).toMatchObject({ status: 503, retryable: true });
    expect(toLlmError(new StatusError(401))).toMatchObject({ status: 401, retryable: false });
    expect(toLlmError(new TypeError("bug"))).toMatchObject({ status: undefined, retryable: false });
    const own = new LlmError("mine", 400, false);
    expect(toLlmError(own)).toBe(own);
  });
});

describe("openRouterClient", () => {
  const noSleep = { sleep: () => Promise.resolve(), baseMs: 1 };

  it("sends through the transport and returns the parsed response", async () => {
    const transport = scripted([result('{"name":"bill"}')]);
    const client = openRouterClient({ apiKey: KEY, transport, retry: noSleep });
    const response = await client.complete(REQUEST);
    expect(response.json).toEqual({ name: "bill" });
    expect(transport.sent).toHaveLength(1);
    expect(JSON.stringify(transport.sent[0])).not.toContain(KEY);
    expect(client.name).toBe("openrouter");
  });

  it("retries a 429 and then succeeds", async () => {
    const transport = scripted([new StatusError(429), result('{"name":"ok"}')]);
    const client = openRouterClient({ apiKey: KEY, transport, retry: noSleep });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { name: "ok" } });
    expect(transport.sent).toHaveLength(2);
  });

  it("does not retry a 400 and surfaces it as an LlmError", async () => {
    const transport = scripted([new StatusError(400), result('{"name":"never"}')]);
    const client = openRouterClient({ apiKey: KEY, transport, retry: noSleep });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ status: 400, retryable: false });
    expect(transport.sent).toHaveLength(1);
  });

  it("does not retry a malformed reply", async () => {
    const transport = scripted([result("not json"), result('{"name":"never"}')]);
    const client = openRouterClient({ apiKey: KEY, transport, retry: noSleep });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ retryable: false });
    expect(transport.sent).toHaveLength(1);
  });
});
