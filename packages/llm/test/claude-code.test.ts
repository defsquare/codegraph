import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_DEFAULT_TIMEOUT_MS,
  buildClaudeCodeArgv,
  claudeCodeClient,
  parseClaudeCodeResult,
  toClaudeCodeError,
  type ClaudeCodeOutcome,
  type ClaudeCodeProcess,
  type ClaudeCodeRun,
} from "../src/claude-code.js";
import { LlmError, type LlmRequest } from "../src/client.js";

/** A real `claude -p --output-format json --json-schema …` result (2.1.318, Sonnet 5.5). */
const SAMPLE = readFileSync(new URL("./fixtures/claude-result-sample.json", import.meta.url), "utf8");

const COMMAND = "/home/me/.local/bin/claude";

const REQUEST: LlmRequest = {
  model: "sonnet",
  system: "You are a DDD architect.",
  user: "# Unit java:p/A.f()\nexplain",
  schema: {
    name: "operation",
    jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
};

/** An outcome of a process that ran to the end; override what the case is about. */
function outcome(partial: Partial<ClaudeCodeOutcome> = {}): ClaudeCodeOutcome {
  return { stdout: "", stderr: "", code: 0, signal: null, ...partial };
}

/** A result JSON as the CLI prints it, with fields overridden. */
function result(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"name":"bill"}', ...fields });
}

function scripted(outcomes: readonly (ClaudeCodeOutcome | Error)[]): ClaudeCodeProcess & { runs: ClaudeCodeRun[] } {
  const runs: ClaudeCodeRun[] = [];
  let call = 0;
  return {
    runs,
    run(run) {
      runs.push(run);
      const next = outcomes[call];
      call += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? outcome({ code: 1, stderr: "script exhausted" }));
    },
  };
}

const noSleep = { sleep: () => Promise.resolve(), baseMs: 1 };

describe("buildClaudeCodeArgv", () => {
  it("builds the headless invocation exactly: one JSON result, the strict schema, no tools, safe mode, nothing persisted", () => {
    expect(buildClaudeCodeArgv(REQUEST)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--json-schema",
      JSON.stringify(REQUEST.schema.jsonSchema),
      "--system-prompt",
      REQUEST.system,
      "--tools",
      "",
      "--safe-mode",
      "--no-session-persistence",
    ]);
  });

  it("never puts the user prompt in the argv (it goes through stdin)", () => {
    expect(buildClaudeCodeArgv(REQUEST)).not.toContain(REQUEST.user);
    expect(buildClaudeCodeArgv(REQUEST).join("\n")).not.toContain("explain");
  });

  it("maps reasoningEffort to --effort, with none lowered to low, and omits it when unset", () => {
    expect(buildClaudeCodeArgv({ ...REQUEST, reasoningEffort: "high" }).slice(-2)).toEqual(["--effort", "high"]);
    expect(buildClaudeCodeArgv({ ...REQUEST, reasoningEffort: "medium" }).slice(-2)).toEqual(["--effort", "medium"]);
    expect(buildClaudeCodeArgv({ ...REQUEST, reasoningEffort: "none" }).slice(-2)).toEqual(["--effort", "low"]);
    expect(buildClaudeCodeArgv(REQUEST)).not.toContain("--effort");
  });

  it("ignores temperature and maxTokens, which the CLI cannot take", () => {
    expect(buildClaudeCodeArgv({ ...REQUEST, temperature: 0.7, maxTokens: 800 })).toEqual(buildClaudeCodeArgv(REQUEST));
  });
});

describe("the run the client hands to the process", () => {
  it("carries the command, the argv, the prompt on stdin, and the defaults: the OS temp dir and a 10 min timeout", async () => {
    const process = scripted([outcome({ stdout: result() })]);
    const client = claudeCodeClient({ command: COMMAND, process, env: { PATH: "/usr/bin" }, retry: noSleep });
    await client.complete(REQUEST);
    expect(process.runs).toHaveLength(1);
    const run = process.runs[0]!;
    expect(run.command).toBe(COMMAND);
    expect(run.argv).toEqual(buildClaudeCodeArgv(REQUEST));
    expect(run.stdin).toBe(REQUEST.user);
    expect(run.cwd).toBe(tmpdir());
    expect(run.timeoutMs).toBe(CLAUDE_CODE_DEFAULT_TIMEOUT_MS);
    expect(CLAUDE_CODE_DEFAULT_TIMEOUT_MS).toBe(600_000);
    expect(run.signal).toBeUndefined();
  });

  it("takes cwd, timeout and the abort signal from the options and the call", async () => {
    const process = scripted([outcome({ stdout: result() })]);
    const client = claudeCodeClient({ command: COMMAND, process, env: {}, cwd: "/work", timeoutMs: 1234, retry: noSleep });
    const controller = new AbortController();
    await client.complete(REQUEST, controller.signal);
    expect(process.runs[0]).toMatchObject({ cwd: "/work", timeoutMs: 1234, signal: controller.signal });
  });

  it("passes the caller's environment with every undefined value dropped", async () => {
    const process = scripted([outcome({ stdout: result() })]);
    const client = claudeCodeClient({ command: COMMAND, process, env: { HOME: "/home/me", UNSET: undefined, PATH: "/bin" }, retry: noSleep });
    await client.complete(REQUEST);
    expect(process.runs[0]!.env).toEqual({ HOME: "/home/me", PATH: "/bin" });
    expect(Object.values(process.runs[0]!.env).every((value) => typeof value === "string")).toBe(true);
  });

  it("is named claude-code", () => {
    expect(claudeCodeClient({ command: COMMAND, process: scripted([]) }).name).toBe("claude-code");
  });
});

describe("parseClaudeCodeResult", () => {
  it("reads the real sample: the structured output, the text, every input token counted, the cost and the served model", () => {
    const response = parseClaudeCodeResult(SAMPLE, "sonnet");
    expect(response.json).toEqual({ answer: "ok", n: 2 });
    expect(response.text).toBe('{"answer":"ok","n":2}');
    expect(response.usage).toEqual({ promptTokens: 1142, completionTokens: 74, cost: 0.005304 });
    expect(response.model).toBe("claude-sonnet-5-5");
  });

  it("falls back to the result text, fenced or plain, when there is no structured output", () => {
    expect(parseClaudeCodeResult(result({ result: '```json\n{"name":"x"}\n```' }), "sonnet").json).toEqual({ name: "x" });
    expect(parseClaudeCodeResult(result({ result: '{"name":"y"}' }), "sonnet").json).toEqual({ name: "y" });
  });

  it("treats an empty or non-JSON result without structured output as a final error", () => {
    expect(() => parseClaudeCodeResult(result({ result: "" }), "sonnet")).toThrow(/empty completion/u);
    expect(() => parseClaudeCodeResult(result({ result: "Sure! Here it is." }), "sonnet")).toThrow(/non-JSON completion/u);
    try {
      parseClaudeCodeResult(result({ result: "   " }), "sonnet");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).retryable).toBe(false);
    }
  });

  it("reports the requested model when modelUsage is absent, and the key when canonicalModel is", () => {
    expect(parseClaudeCodeResult(result(), "sonnet").model).toBe("sonnet");
    expect(parseClaudeCodeResult(result({ modelUsage: { "claude-opus-5-5": { costUSD: 1 } } }), "sonnet").model).toBe("claude-opus-5-5");
    expect(parseClaudeCodeResult(result({ modelUsage: { alias: { canonicalModel: "claude-sonnet-5-5" } } }), "sonnet").model).toBe("claude-sonnet-5-5");
  });

  it("reports no usage when the result has none, counts missing numbers as 0, and takes the cost only when it is a number", () => {
    expect(parseClaudeCodeResult(result(), "sonnet").usage).toBeUndefined();
    expect(parseClaudeCodeResult(result({ usage: { input_tokens: 5, output_tokens: 7 } }), "sonnet").usage).toEqual({ promptTokens: 5, completionTokens: 7 });
    expect(parseClaudeCodeResult(result({ usage: { cache_read_input_tokens: 9 }, total_cost_usd: "0.1" }), "sonnet").usage).toEqual({ promptTokens: 9, completionTokens: 0 });
    expect(parseClaudeCodeResult(result({ usage: {}, total_cost_usd: 0.25 }), "sonnet").usage).toEqual({ promptTokens: 0, completionTokens: 0, cost: 0.25 });
  });

  it("is a failure, not a response, when the result says is_error or a subtype other than success", () => {
    expect(() => parseClaudeCodeResult(result({ is_error: true, result: "something broke" }), "sonnet")).toThrow(LlmError);
    expect(() => parseClaudeCodeResult(result({ subtype: "error_max_turns" }), "sonnet")).toThrow(LlmError);
    expect(() => parseClaudeCodeResult("not json at all", "sonnet")).toThrow(/not the result JSON/u);
    expect(() => parseClaudeCodeResult('{"type":"assistant"}', "sonnet")).toThrow(/not the result JSON/u);
  });
});

describe("toClaudeCodeError — the error table", () => {
  const spawnFailure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`spawn ${COMMAND} ${code}`), { code, path: COMMAND, syscall: "spawn" });
  const run = { command: COMMAND, timeoutMs: 600_000 };

  it("a binary that cannot be spawned (ENOENT) is final and names the command and the code", () => {
    const error = toClaudeCodeError(outcome({ code: null, error: spawnFailure("ENOENT") }), undefined, run);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toContain(COMMAND);
    expect(error.message).toContain("ENOENT");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("a binary that cannot be executed (EACCES) is final too", () => {
    const error = toClaudeCodeError(outcome({ code: null, error: spawnFailure("EACCES") }), undefined, run);
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toContain("EACCES");
  });

  it("a call killed at the timeout is final and says how long it had", () => {
    const error = toClaudeCodeError(outcome({ code: null, signal: "SIGKILL", timedOut: true }), undefined, { command: COMMAND, timeoutMs: 1500 });
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toContain("1500");
  });

  it("a result with a numeric api_error_status takes that status and the HTTP retry rule", () => {
    const overloaded = JSON.parse(result({ is_error: true, subtype: "error", api_error_status: 503, result: "upstream" })) as unknown;
    expect(toClaudeCodeError(outcome({ code: 1 }), overloaded, run)).toMatchObject({ status: 503, retryable: true });
    const rejected = JSON.parse(result({ is_error: true, subtype: "error", api_error_status: 400, result: "bad request" })) as unknown;
    expect(toClaudeCodeError(outcome({ code: 1 }), rejected, run)).toMatchObject({ status: 400, retryable: false, message: expect.stringContaining("bad request") });
  });

  it("without a status, 'not logged in', 'invalid api key', 'unauthorized' and 'authentication' are a final 401", () => {
    for (const text of ["Not logged in · Please run /login", "Invalid API key", "unauthorized", "Authentication failed"]) {
      const parsed = JSON.parse(result({ is_error: true, subtype: "error", result: text })) as unknown;
      expect(toClaudeCodeError(outcome({ code: 1 }), parsed, run), text).toMatchObject({ status: 401, retryable: false });
    }
  });

  it("'rate limit', '429' and 'too many requests' are a retryable 429, read from stderr when stdout has nothing", () => {
    for (const text of ["Rate limit reached", "API Error: 429", "too many requests"]) {
      expect(toClaudeCodeError(outcome({ code: 1, stderr: text }), undefined, run), text).toMatchObject({ status: 429, retryable: true });
    }
  });

  it("'overloaded' and '529' are a retryable 529", () => {
    const parsed = JSON.parse(result({ is_error: true, subtype: "error", errors: [{ message: "Overloaded" }] })) as unknown;
    expect(toClaudeCodeError(outcome({ code: 1 }), parsed, run)).toMatchObject({ status: 529, retryable: true });
    expect(toClaudeCodeError(outcome({ code: 1, stderr: "API Error: 529" }), undefined, run)).toMatchObject({ status: 529, retryable: true });
  });

  it("'budget', 'credit', 'billing' and '402' are a final 402", () => {
    for (const text of ["Budget exceeded", "Your credit balance is too low", "billing problem", "API Error: 402"]) {
      const parsed = JSON.parse(result({ is_error: true, subtype: "error", error: text })) as unknown;
      expect(toClaudeCodeError(outcome({ code: 1 }), parsed, run), text).toMatchObject({ status: 402, retryable: false });
    }
  });

  it("anything else is final with no status, and the message carries the exit code and what was said", () => {
    const error = toClaudeCodeError(outcome({ code: 1, stderr: "segfault somewhere" }), undefined, run);
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toContain("exit 1");
    expect(error.message).toContain("segfault somewhere");
    const killed = toClaudeCodeError(outcome({ code: null, signal: "SIGSEGV" }), undefined, run);
    expect(killed.message).toContain("SIGSEGV");
  });

  it("exit 0 with stdout that is not the result JSON is final with no status", () => {
    const error = toClaudeCodeError(outcome({ code: 0, stdout: "Welcome to Claude Code!" }), undefined, run);
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toContain("not the result JSON");
    expect(error.message).toContain("Welcome to Claude Code!");
  });

  /** An error arm as the SDK documents it: `is_error`, the subtype, `errors: string[]`, no `result`. */
  const arm = (subtype: string, errors: readonly string[], extra: Record<string, unknown> = {}): unknown =>
    JSON.parse(result({ is_error: true, subtype, result: undefined, errors, ...extra })) as unknown;

  it("error_max_turns is final with no status; the errors array is the message", () => {
    const error = toClaudeCodeError(outcome({ code: 1 }), arm("error_max_turns", ["Reached max turns (1)"]), run);
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toContain("error_max_turns");
    expect(error.message).toContain("Reached max turns (1)");
  });

  it("error_during_execution is final with no status, unless the errors say what the API answered", () => {
    const plain = toClaudeCodeError(outcome({ code: 1 }), arm("error_during_execution", ["Something went wrong while running"]), run);
    expect(plain).toMatchObject({ status: undefined, retryable: false });
    expect(plain.message).toContain("Something went wrong while running");
    const overloaded = toClaudeCodeError(outcome({ code: 1 }), arm("error_during_execution", ["API Error: 529 Overloaded"]), run);
    expect(overloaded).toMatchObject({ status: 529, retryable: true });
  });

  it("error_max_budget_usd is a final 402 even when the errors never spell 'budget'", () => {
    const error = toClaudeCodeError(outcome({ code: 1 }), arm("error_max_budget_usd", ["Spent $0.0531 of the $0.05 limit"]), run);
    expect(error).toMatchObject({ status: 402, retryable: false });
    expect(error.message).toContain("error_max_budget_usd");
    expect(error.message).toContain("$0.05 limit");
  });

  it("error_max_structured_output_retries is final and says the model never produced schema-valid output", () => {
    const error = toClaudeCodeError(outcome({ code: 1 }), arm("error_max_structured_output_retries", ["Structured output validation failed 3 times"]), run);
    expect(error).toMatchObject({ status: undefined, retryable: false });
    expect(error.message).toMatch(/schema-valid/u);
    expect(error.message).toContain("validation failed 3 times");
  });

  it("a numeric api_error_status wins on any arm — a success arm included — and makes the result a failure", () => {
    const success = JSON.parse(result({ api_error_status: 529 })) as unknown;
    const error = toClaudeCodeError(outcome({ code: 0 }), success, run);
    expect(error).toMatchObject({ status: 529, retryable: true });
    expect(error.message).toContain("529");
    expect(toClaudeCodeError(outcome({ code: 1 }), arm("error_max_budget_usd", ["limit"], { api_error_status: 500 }), run)).toMatchObject({ status: 500, retryable: true });
    expect(toClaudeCodeError(outcome({ code: 1 }), arm("error_during_execution", ["Not logged in"], { api_error_status: 400 }), run)).toMatchObject({ status: 400, retryable: false });
    try {
      parseClaudeCodeResult(result({ api_error_status: 500 }), "sonnet");
      expect.unreachable("a success arm terminated by an API error is not a response");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).status).toBe(500);
    }
  });
});

describe("claudeCodeClient", () => {
  it("runs the process once and returns the parsed response", async () => {
    const process = scripted([outcome({ stdout: SAMPLE })]);
    const client = claudeCodeClient({ command: COMMAND, process, env: {}, retry: noSleep });
    const response = await client.complete(REQUEST);
    expect(response.json).toEqual({ answer: "ok", n: 2 });
    expect(response.model).toBe("claude-sonnet-5-5");
    expect(response.usage).toEqual({ promptTokens: 1142, completionTokens: 74, cost: 0.005304 });
    expect(process.runs).toHaveLength(1);
  });

  it("retries a 429 outcome and then succeeds: two runs, one response", async () => {
    const delays: number[] = [];
    const limited = outcome({ code: 1, stdout: result({ is_error: true, subtype: "error", api_error_status: 429, result: "rate limited" }) });
    const process = scripted([limited, outcome({ stdout: result({ result: '{"name":"ok"}' }) })]);
    const client = claudeCodeClient({
      command: COMMAND,
      process,
      env: {},
      retry: {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        baseMs: 1,
      },
    });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { name: "ok" } });
    expect(process.runs).toHaveLength(2);
    expect(delays).toEqual([1]);
  });

  it("retries a success arm that carries a transient api_error_status, as the failure it reports", async () => {
    const terminated = outcome({ code: 0, stdout: result({ api_error_status: 529 }) });
    const process = scripted([terminated, outcome({ stdout: result({ result: '{"name":"ok"}' }) })]);
    const client = claudeCodeClient({ command: COMMAND, process, env: {}, retry: noSleep });
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ json: { name: "ok" } });
    expect(process.runs).toHaveLength(2);
  });

  it("does not retry a final error: one run, the LlmError surfaced", async () => {
    const denied = outcome({ code: 1, stdout: result({ is_error: true, subtype: "error", result: "Not logged in" }) });
    const process = scripted([denied, outcome({ stdout: result() })]);
    const client = claudeCodeClient({ command: COMMAND, process, env: {}, retry: noSleep });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ name: "LlmError", status: 401, retryable: false });
    expect(process.runs).toHaveLength(1);
  });

  it("does not retry a spawn failure, a timeout or a malformed stdout", async () => {
    const enoent = outcome({ code: null, error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });
    for (const first of [enoent, outcome({ code: null, timedOut: true }), outcome({ stdout: "<html>" })]) {
      const process = scripted([first, outcome({ stdout: result() })]);
      const client = claudeCodeClient({ command: COMMAND, process, env: {}, retry: noSleep });
      await expect(client.complete(REQUEST)).rejects.toMatchObject({ name: "LlmError", retryable: false });
      expect(process.runs).toHaveLength(1);
    }
  });

  it("wraps a foreign rejection of the process in a final LlmError and passes an LlmError through", async () => {
    const foreign = scripted([new TypeError("bug in the runner")]);
    await expect(claudeCodeClient({ command: COMMAND, process: foreign, env: {}, retry: noSleep }).complete(REQUEST)).rejects.toMatchObject({
      name: "LlmError",
      retryable: false,
      cause: expect.any(TypeError),
    });
    const own = new LlmError("aborted", undefined, false);
    await expect(claudeCodeClient({ command: COMMAND, process: scripted([own]), env: {}, retry: noSleep }).complete(REQUEST)).rejects.toBe(own);
  });
});
