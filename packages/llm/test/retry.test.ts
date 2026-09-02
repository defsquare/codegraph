import { describe, expect, it } from "vitest";
import { LlmError } from "../src/client.js";
import { backoffMs, withRetry } from "../src/retry.js";

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe("withRetry", () => {
  it("retries a 429 once and returns the eventual answer", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new LlmError("rate limited", 429, true);
        return "ok";
      },
      { sleep, baseMs: 100 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toEqual([100]);
  });

  it("backs off exponentially, capped, with no jitter by default", () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffMs(n, { baseMs: 500, maxMs: 3000 }))).toEqual([
      500, 1000, 2000, 3000, 3000,
    ]);
  });

  it("does not retry a 400", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new LlmError("bad request", 400, false);
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("does not retry a foreign exception", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new TypeError("not ours");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  it("throws the LAST error once attempts are exhausted", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new LlmError(`overloaded #${calls}`, 503, true);
        },
        { sleep, attempts: 3, baseMs: 10 },
      ),
    ).rejects.toThrow("overloaded #3");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });
});
