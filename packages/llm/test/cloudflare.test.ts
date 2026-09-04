import { describe, expect, it } from "vitest";
import { LlmError, type LlmRequest } from "../src/client.js";
import {
  buildCloudflareBody,
  buildCloudflareHeaders,
  cloudflareEndpoint,
  cloudflareGatewayClient,
} from "../src/cloudflare.js";

const TOKEN = "cf-token-secret";
const REQUEST: LlmRequest = {
  model: "openai/gpt-5.6-luna",
  system: "You are a DDD architect.",
  user: "# Unit java:p/A.f()\nexplain",
  schema: {
    name: "operation",
    jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
};

/** An OpenAI-shaped reply as Cloudflare returns it: snake_case usage. */
function reply(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: "chatcmpl-1",
    model: "openai/gpt-5.6-luna-2026",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    ...extra,
  };
}

type Call = { url: string; init: RequestInit };

function scripted(responses: readonly (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let call = 0;
  const fake = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[call];
    call += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? new Response("{}", { status: 500 }));
  }) as typeof fetch;
  return { fetch: fake, calls };
}

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

const noSleep = { sleep: () => Promise.resolve(), baseMs: 1 };

describe("the request", () => {
  it("targets the account's AI REST endpoint, with the token in the header and nowhere in the body", () => {
    expect(cloudflareEndpoint("acc-1")).toBe("https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1/chat/completions");
    expect(cloudflareEndpoint("a/b", "https://example.test/v4/")).toBe("https://example.test/v4/accounts/a%2Fb/ai/v1/chat/completions");
    const headers = buildCloudflareHeaders({ apiToken: TOKEN, gatewayId: "prod" });
    expect(headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "cf-aig-gateway-id": "prod" });
    expect("cf-aig-gateway-id" in buildCloudflareHeaders({ apiToken: TOKEN })).toBe(false);
    const body = buildCloudflareBody(REQUEST);
    expect(body).toEqual({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "system", content: REQUEST.system },
        { role: "user", content: REQUEST.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "operation", strict: true, schema: REQUEST.schema.jsonSchema } },
      temperature: 0,
      stream: false,
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    const knobs = buildCloudflareBody({ ...REQUEST, maxTokens: 500, reasoningEffort: "low" });
    expect(knobs["max_tokens"]).toBe(500);
    expect(knobs["reasoning_effort"]).toBe("low");
  });
});

describe("cloudflareGatewayClient", () => {
  it("sends through fetch and parses the snake_case reply", async () => {
    const { fetch, calls } = scripted([ok(reply('{"name":"bill"}'))]);
    const client = cloudflareGatewayClient({ accountId: "acc-1", apiToken: TOKEN, gatewayId: "prod", fetch, retry: noSleep });
    const response = await client.complete(REQUEST);
    expect(response.json).toEqual({ name: "bill" });
    expect(response.model).toBe("openai/gpt-5.6-luna-2026");
    expect(response.usage).toEqual({ promptTokens: 120, completionTokens: 40 });
    expect(client.name).toBe("cloudflare/prod");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["cf-aig-gateway-id"]).toBe("prod");
    expect(String(calls[0]?.init.body)).not.toContain(TOKEN);
  });

  it("retries a 429 after the provider's Retry-After, then succeeds", async () => {
    const delays: number[] = [];
    const limited = new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), { status: 429, headers: { "retry-after": "2" } });
    const { fetch, calls } = scripted([limited, ok(reply('{"name":"ok"}'))]);
    const client = cloudflareGatewayClient({
      accountId: "acc-1",
      apiToken: TOKEN,
      fetch,
      retry: {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        baseMs: 1,
      },
    });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { name: "ok" } });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });

  it("does not retry a 401 and quotes the provider's message", async () => {
    const denied = new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 401 });
    const { fetch, calls } = scripted([denied, ok(reply('{"name":"never"}'))]);
    const client = cloudflareGatewayClient({ accountId: "acc-1", apiToken: TOKEN, fetch, retry: noSleep });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ status: 401, retryable: false, message: expect.stringContaining("Authentication error") });
    expect(calls).toHaveLength(1);
  });

  it("treats a transport failure as transient and a non-JSON reply as final", async () => {
    const flaky = scripted([new TypeError("fetch failed"), ok(reply('{"name":"ok"}'))]);
    const client = cloudflareGatewayClient({ accountId: "acc-1", apiToken: TOKEN, fetch: flaky.fetch, retry: noSleep });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { name: "ok" } });
    expect(flaky.calls).toHaveLength(2);

    const garbage = scripted([new Response("<html>", { status: 200 }), ok(reply('{"name":"never"}'))]);
    const client2 = cloudflareGatewayClient({ accountId: "acc-1", apiToken: TOKEN, fetch: garbage.fetch, retry: noSleep });
    await expect(client2.complete(REQUEST)).rejects.toBeInstanceOf(LlmError);
    expect(garbage.calls).toHaveLength(1);
  });
});
