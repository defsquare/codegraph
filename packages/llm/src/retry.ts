import { isLlmError } from "./client.js";

export interface RetryOptions {
  /** Total attempts including the first. Defaults to 6. */
  readonly attempts?: number;
  /** First back-off in milliseconds; doubles each retry. Defaults to 1000. */
  readonly baseMs?: number;
  /** Upper bound on one back-off. Defaults to 30000 — a per-minute rate limit needs a real pause. */
  readonly maxMs?: number;
  /** In [0, 1): a fraction of the delay added as jitter; 0 makes delays exact. Defaults to 0. */
  readonly jitter?: number;
  /** Injected so tests never wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected source of jitter in [0, 1). */
  readonly random?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The delay before retry number `retry` (1-based): exponential, capped, jittered. */
export function backoffMs(retry: number, options: RetryOptions = {}): number {
  const base = options.baseMs ?? 1000;
  const max = options.maxMs ?? 30_000;
  const exact = Math.min(max, base * 2 ** (retry - 1));
  const jitter = options.jitter ?? 0;
  if (jitter <= 0) return exact;
  return Math.round(exact * (1 + jitter * (options.random ?? Math.random)()));
}

/**
 * Retry `fn` while it fails with a RETRYABLE `LlmError`. Anything else — a
 * non-retryable client error, a foreign exception — propagates at once: a 400
 * will not become a 200 by asking again, and retrying it only spends money.
 * When attempts run out the LAST error is thrown, so the caller sees the
 * provider's final word rather than a generic "gave up". A provider that says
 * how long to wait (`Retry-After`) is obeyed: the pause is never shorter than
 * what it asked for.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const sleep = options.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isLlmError(error) || !error.retryable || attempt === attempts) throw error;
      await sleep(Math.max(backoffMs(attempt, options), error.retryAfterMs ?? 0));
    }
  }
  throw lastError;
}
