import { describe, expect, it } from "vitest";
import { LlmError, type LlmRequest } from "../src/client.js";
import { fakeLlmClient } from "../src/fake.js";

const REQUEST: LlmRequest = {
  model: "test/model",
  system: "You explain code.",
  user: "# Unit java:p/A.f()\nsome body",
  schema: { name: "block", jsonSchema: { type: "object" } },
};

describe("fakeLlmClient", () => {
  it("answers the same bytes for the same request, and records the call", async () => {
    const a = fakeLlmClient();
    const b = fakeLlmClient();
    const [ra, rb] = await Promise.all([a.complete(REQUEST), b.complete(REQUEST)]);
    expect(ra.text).toBe(rb.text);
    expect(ra.json).toEqual({ echo: "# Unit java:p/A.f()", schema: "block" });
    expect(ra.model).toBe("test/model");
    expect(ra.usage?.promptTokens).toBeGreaterThan(0);
    expect(a.calls).toEqual([REQUEST]);
  });

  it("fails the scripted call and answers the others", async () => {
    const client = fakeLlmClient({
      failures: new Map([[2, new LlmError("boom", 500, true)]]),
      respond: (_request, call) => ({ call }),
    });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { call: 1 } });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ status: 500, retryable: true });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { call: 3 } });
    expect(client.calls).toHaveLength(3);
  });
});
