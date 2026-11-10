import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extractJson } from "./chat.js";
import { LlmError, isLlmError, isRetryableStatus, type LlmClient, type LlmRequest, type LlmResponse, type LlmUsage } from "./client.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * Claude Code's headless mode (`claude -p`) as an `LlmClient`: the adapter for
 * a developer whose model is the Claude Code installation on the machine, not
 * an API key (PLAN.md §21).
 *
 * WHAT DIFFERS FROM THE TWO HTTP ADAPTERS, and why there is a third file:
 *
 *  - One call = one process. Nothing here opens a socket: the CLI is spawned
 *    with its argv as an array (never a shell), reads one prompt, prints one
 *    `type: "result"` JSON object and exits. `--concurrency N` above the port
 *    is N processes.
 *  - The user prompt travels on stdin, never as an argument: a context pack
 *    with source can exceed Linux's 128 KB per-argument limit. The system
 *    prompt and the JSON Schema ride as arguments.
 *  - `--safe-mode`, not `--bare`. `--bare` restricts authentication to
 *    `ANTHROPIC_API_KEY`, the one case this adapter is not for; `--safe-mode`
 *    keeps the login and the model and disables every customization
 *    (CLAUDE.md, hooks, plugins, MCP, output styles). The working directory is
 *    the OS temp directory, so no CLAUDE.md of the caller's tree is near.
 *  - `temperature` and `maxTokens` have no headless flag: ignored.
 *  - Errors are read from the process (spawn failure, exit code, timeout) and
 *    the result's `api_error_status`, then from the message text; the CLI
 *    retries its own API errors first, so `withRetry` covers what leaks.
 *
 * The subprocess is held behind `ClaudeCodeProcess.run` — one function, like
 * OpenRouter's transport and Cloudflare's fetch — so every test drives the
 * adapter with a fake process, and the default runner itself is tested with a
 * fake `spawn`: nothing in the workspace spawns.
 *
 * The fourth adapter, the Anthropic API with an API key, is a named empty slot
 * (PLAN.md §21.6): `anthropic.ts`, one more entry in providers.ts.
 */

/** Claude Code's alias for the latest Sonnet; a full id (`claude-sonnet-5-5`) pins the fingerprint. */
export const CLAUDE_CODE_DEFAULT_MODEL = "sonnet";
export const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Prompt tokens `claude -p` bills per call beyond the system and user text, the
 * response schema aside (it rides in the prompt as a tool, counted per prompt).
 * Fitted on the Java fixture (2.1.322, 2026-11-10): 48 operation calls billed
 * +2 292…+2 617 over the estimate, median +2 342, with a ~498-token schema.
 */
export const CLAUDE_CODE_SCAFFOLD_TOKENS = 1850;
/** After SIGTERM at the timeout or on abort, how long the runner waits before SIGKILL. */
export const CLAUDE_CODE_KILL_GRACE_MS = 5_000;
/** After the child's exit, how long the runner waits for its pipes to close before destroying them (a descendant may hold them). */
export const CLAUDE_CODE_DRAIN_GRACE_MS = 1_000;

export interface ClaudeCodeRun {
  readonly command: string;
  readonly argv: readonly string[];
  /** The user prompt, written to the child's stdin then closed. */
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ClaudeCodeOutcome {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code; null when killed by a signal (or never started). */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The spawn failure (ENOENT, EACCES…) when the process never ran. */
  readonly error?: NodeJS.ErrnoException | undefined;
  /** True when the runner killed the child at `timeoutMs`. */
  readonly timedOut?: boolean | undefined;
}

/** The subprocess seam — one function — so tests drive the whole path with recorded outcomes and spawn nothing. */
export interface ClaudeCodeProcess {
  run(run: ClaudeCodeRun): Promise<ClaudeCodeOutcome>;
}

export interface ClaudeCodeOptions {
  /** The resolved binary (claude-code-discovery.ts); never looked up here. */
  readonly command: string;
  /** Defaults to `node:child_process`; tests inject a fake. */
  readonly process?: ClaudeCodeProcess;
  /** The child's base environment; defaults to this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the OS temp directory: no CLAUDE.md of the caller's tree. */
  readonly cwd?: string;
  /** Per call; defaults to 600 000 (10 min). */
  readonly timeoutMs?: number;
  readonly retry?: RetryOptions;
}

// ---------------------------------------------------------------------------
// The invocation (PLAN.md §21.1, the argument table)

/** The `claude -p` argv: one JSON result, the strict schema, no tools, safe mode, nothing persisted. The prompt is NOT here. */
export function buildClaudeCodeArgv(request: LlmRequest): string[] {
  // `temperature` and `maxTokens` have no headless flag: the port's knobs are ignored here, by design.
  const effort = request.reasoningEffort === undefined ? [] : ["--effort", request.reasoningEffort === "none" ? "low" : request.reasoningEffort];
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    request.model,
    "--json-schema",
    JSON.stringify(request.schema.jsonSchema),
    "--system-prompt",
    request.system,
    "--tools",
    "",
    "--safe-mode",
    "--no-session-persistence",
    ...effort,
  ];
}

// ---------------------------------------------------------------------------
// The result (PLAN.md §21.1, the field table)

type ResultRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is ResultRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The `type: "result"` object stdout carries (alone, or inside the older message array); undefined when stdout is anything else. */
function readResult(stdout: string): ResultRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  const candidates = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  return candidates.find((item): item is ResultRecord => isRecord(item) && item["type"] === "result");
}

/**
 * `api_error_status` — the API error that terminated the conversation — can ride on a success arm: a number there is a failure too.
 * A result with no `subtype` at all is a failure as well (today's CLI always emits it; a shape we do not know is not a success).
 */
function failedResult(result: ResultRecord): boolean {
  return result["is_error"] === true || result["subtype"] !== "success" || typeof result["api_error_status"] === "number";
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Every input token counts as sent — cached or not — as the chat adapters count `prompt_tokens`. */
function usageOf(raw: unknown, cost: unknown): LlmUsage | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    promptTokens: count(raw["input_tokens"]) + count(raw["cache_creation_input_tokens"]) + count(raw["cache_read_input_tokens"]),
    completionTokens: count(raw["output_tokens"]),
    ...(typeof cost === "number" ? { cost } : {}),
  };
}

/** The model that served — the key of `modelUsage`, its `canonicalModel` when present — not the alias asked for. */
function servedModel(modelUsage: unknown): string | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const [key, entry] = Object.entries(modelUsage)[0] ?? [];
  if (key === undefined) return undefined;
  const canonical = isRecord(entry) ? entry["canonicalModel"] : undefined;
  return typeof canonical === "string" ? canonical : key;
}

function responseOf(result: ResultRecord, requestedModel: string): LlmResponse {
  const text = typeof result["result"] === "string" ? result["result"] : "";
  let json: unknown;
  if (result["structured_output"] !== undefined) {
    json = result["structured_output"];
  } else {
    if (text.trim() === "") throw new LlmError("model returned an empty completion", undefined, false);
    json = extractJson(text);
  }
  const usage = usageOf(result["usage"], result["total_cost_usd"]);
  return {
    json,
    text: text === "" ? JSON.stringify(json) : text,
    model: servedModel(result["modelUsage"]) ?? requestedModel,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** One result JSON on stdout → our response; a failure result, or stdout that is not one, is thrown as the classified `LlmError`. */
export function parseClaudeCodeResult(stdout: string, requestedModel: string): LlmResponse {
  const result = readResult(stdout);
  if (result === undefined || failedResult(result)) throw toClaudeCodeError({ stdout, stderr: "", code: 0, signal: null }, result);
  return responseOf(result, requestedModel);
}

// ---------------------------------------------------------------------------
// The errors (PLAN.md §21.1, the error table)

/** What the message says when the result carries no status; the first row that matches wins. */
const MESSAGE_STATUSES: readonly { readonly pattern: RegExp; readonly status: number }[] = [
  { pattern: /not logged in|invalid api key|unauthorized|authentication/iu, status: 401 },
  { pattern: /rate limit|\b429\b|too many requests/iu, status: 429 },
  { pattern: /overloaded|\b529\b/iu, status: 529 },
  { pattern: /budget|credit|billing|\b402\b/iu, status: 402 },
];

function statusOfMessage(text: string): number | undefined {
  return MESSAGE_STATUSES.find((rule) => rule.pattern.test(text))?.status;
}

/** The documented error arms (SDKResultMessage): what each means for the message, and the one that has a status of its own. */
const SUBTYPE_NOTES: Readonly<Record<string, string>> = {
  error_max_turns: "the CLI reached its turn limit",
  error_during_execution: "the CLI failed while running",
  error_max_budget_usd: "the CLI's own budget is exhausted",
  error_max_structured_output_retries: "the model never produced schema-valid output",
};
const SUBTYPE_STATUSES: Readonly<Record<string, number>> = { error_max_budget_usd: 402 };

/** Everything the CLI said about a failure: the result's `result`, `errors` and `error` fields, then stderr. */
function saidOf(result: ResultRecord | undefined, stderr: string): string {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") parts.push(value.trim());
    else if (Array.isArray(value)) value.forEach(push);
    else if (isRecord(value)) push(value["message"]);
  };
  if (result !== undefined) {
    push(result["result"]);
    push(result["errors"]);
    push(result["error"]);
  }
  push(stderr);
  return parts.join("; ");
}

/**
 * One `LlmError` per row of the error table. `run` supplies the command and
 * the timeout for the messages of the two process rows; without it they fall
 * back to what the outcome itself carries.
 */
export function toClaudeCodeError(outcome: ClaudeCodeOutcome, parsed?: unknown, run?: Pick<ClaudeCodeRun, "command" | "timeoutMs">): LlmError {
  if (outcome.error !== undefined) {
    const command = run?.command ?? outcome.error.path ?? "claude";
    const code = outcome.error.code ?? outcome.error.message;
    return new LlmError(`claude-code: cannot run ${command}: ${code}`, undefined, false, { cause: outcome.error });
  }
  if (outcome.timedOut === true) {
    const limit = run === undefined ? "the timeout" : `${run.timeoutMs} ms`;
    return new LlmError(`claude-code: no result within ${limit}; the process was killed`, undefined, false);
  }
  const result = isRecord(parsed) ? parsed : undefined;
  if (result === undefined && outcome.code === 0) {
    const head = outcome.stdout.trim().slice(0, 200);
    return new LlmError(`claude-code: stdout is not the result JSON${head === "" ? "" : `: ${head}`}`, undefined, false);
  }
  const said = saidOf(result, outcome.stderr);
  const exit = outcome.code !== null ? `exit ${outcome.code}` : outcome.signal !== null ? `killed by ${outcome.signal}` : "no exit code";
  const subtype = typeof result?.["subtype"] === "string" ? result["subtype"] : "";
  const apiStatus = result?.["api_error_status"];
  // The status: the API's own on any arm, else the arm's (budget → 402), else what the text says.
  const status = typeof apiStatus === "number" ? apiStatus : (SUBTYPE_STATUSES[subtype] ?? statusOfMessage(said));
  const notes = [
    ...(typeof apiStatus === "number" ? [`API error ${apiStatus}`] : []),
    ...(SUBTYPE_NOTES[subtype] === undefined ? [] : [SUBTYPE_NOTES[subtype]]),
    ...(said === "" ? [] : [said.slice(0, 300)]),
  ];
  return new LlmError(
    `claude-code: ${exit}${subtype === "" || subtype === "success" ? "" : ` (${subtype})`}${notes.length === 0 ? "" : `: ${notes.join("; ")}`}`,
    status,
    status === undefined ? false : isRetryableStatus(status),
  );
}

// ---------------------------------------------------------------------------
// The default process: node:child_process behind the seam

/** The slice of `ChildProcess` the runner touches, so a test hands in a scripted child and spawns nothing. */
export interface ClaudeCodeChild {
  readonly stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: Error) => void): unknown } | null;
  readonly stdout: ClaudeCodeChildPipe | null;
  readonly stderr: ClaudeCodeChildPipe | null;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

/** An output pipe of the child: read, and destroyed when a descendant keeps it open after the child's exit. */
export interface ClaudeCodeChildPipe {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  destroy(): unknown;
}

export interface ClaudeCodeSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

/** `node:child_process`'s `spawn`, narrowed to how the runner calls it: argv as an array, never a shell. */
export type ClaudeCodeSpawn = (command: string, argv: readonly string[], options: ClaudeCodeSpawnOptions) => ClaudeCodeChild;

export interface ChildProcessRunnerOptions {
  /** Defaults to `node:child_process`; tests inject a fake. */
  readonly spawn?: ClaudeCodeSpawn;
  /** Defaults to `CLAUDE_CODE_KILL_GRACE_MS`. */
  readonly killGraceMs?: number;
  /** Defaults to `CLAUDE_CODE_DRAIN_GRACE_MS`. */
  readonly drainGraceMs?: number;
}

function abortError(signal: AbortSignal | undefined): LlmError {
  const reason: unknown = signal?.reason;
  return new LlmError("claude-code: the call was aborted", undefined, false, reason === undefined ? undefined : { cause: reason });
}

function asBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

/**
 * The real `ClaudeCodeProcess`: spawn, feed stdin, collect both streams, and
 * resolve on close. At `timeoutMs` (or on abort) the child gets SIGTERM, then
 * SIGKILL after the kill grace if it is still there; a timeout is an outcome
 * (`timedOut`, only when the timeout killed a child that had not exited), an
 * abort a rejection — the caller asked for it.
 *
 * 'close' needs the pipes closed, and a descendant of the child may hold them
 * after the child's exit (`sleep 30 &`): the child's result is complete at
 * its exit, so from there the runner waits the drain grace for 'close', then
 * destroys the pipes and settles with what it has — a grandchild's output is
 * noise. Without this a leaked descendant would hold every call for as long
 * as it lives.
 */
export function childProcessRunner(options: ChildProcessRunnerOptions = {}): ClaudeCodeProcess {
  const spawn: ClaudeCodeSpawn = options.spawn ?? nodeSpawn;
  const killGraceMs = options.killGraceMs ?? CLAUDE_CODE_KILL_GRACE_MS;
  const drainGraceMs = options.drainGraceMs ?? CLAUDE_CODE_DRAIN_GRACE_MS;
  return {
    run(run: ClaudeCodeRun): Promise<ClaudeCodeOutcome> {
      return new Promise<ClaudeCodeOutcome>((resolve, reject) => {
        if (run.signal?.aborted === true) {
          reject(abortError(run.signal));
          return;
        }
        let child: ClaudeCodeChild;
        try {
          child = spawn(run.command, run.argv, { cwd: run.cwd, env: run.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        } catch (error) {
          resolve({ stdout: "", stderr: "", code: null, signal: null, error: error as NodeJS.ErrnoException });
          return;
        }
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout?.on("data", (chunk) => out.push(asBuffer(chunk)));
        child.stderr?.on("data", (chunk) => err.push(asBuffer(chunk)));

        let exited: Pick<ClaudeCodeOutcome, "code" | "signal"> | undefined;
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        let drainTimer: NodeJS.Timeout | undefined;
        // Idempotent: a timeout and an abort together signal once and leave one escalation timer.
        const kill = (): void => {
          if (killTimer !== undefined || exited !== undefined) return;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        };
        const timer = setTimeout(() => {
          if (exited !== undefined) return; // out already; the drain bounds the rest
          timedOut = true;
          kill();
        }, run.timeoutMs);
        const onAbort = (): void => {
          aborted = true;
          kill();
        };
        run.signal?.addEventListener("abort", onAbort, { once: true });

        // The first of 'error' (never ran), 'close' and the drain settles; the others are ignored.
        const settle = (ended: Pick<ClaudeCodeOutcome, "code" | "signal" | "error">): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          run.signal?.removeEventListener("abort", onAbort);
          if (aborted) {
            reject(abortError(run.signal));
            return;
          }
          resolve({
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            code: ended.code,
            signal: ended.signal,
            ...(ended.error === undefined ? {} : { error: ended.error }),
            ...(timedOut ? { timedOut: true } : {}),
          });
        };
        child.on("error", (error) => settle({ code: null, signal: null, error }));
        child.on("exit", (code, signal) => {
          exited = { code, signal };
          drainTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle({ code, signal });
          }, drainGraceMs);
        });
        child.on("close", (code, signal) => settle({ code, signal }));

        // A child that exits before reading its prompt closes the pipe: EPIPE here is noise, not the failure.
        // The CLI caps stdin at 10 MB (non-zero exit above); a context pack is far below.
        child.stdin?.on("error", () => undefined);
        child.stdin?.write(run.stdin);
        child.stdin?.end();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The client

/** The child's environment: the caller's, with every unset variable dropped (spawn takes strings only). */
function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  return out;
}

function failed(outcome: ClaudeCodeOutcome, result: ResultRecord): boolean {
  return outcome.error !== undefined || outcome.timedOut === true || outcome.code !== 0 || failedResult(result);
}

export function claudeCodeClient(options: ClaudeCodeOptions): LlmClient {
  const runner = options.process ?? childProcessRunner();
  const env = definedEnv(options.env ?? process.env);
  const cwd = options.cwd ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS;
  return {
    name: "claude-code",
    complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const run: ClaudeCodeRun = {
        command: options.command,
        argv: buildClaudeCodeArgv(request),
        stdin: request.user,
        env,
        cwd,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      };
      return withRetry(async () => {
        let outcome: ClaudeCodeOutcome;
        try {
          outcome = await runner.run(run);
        } catch (error) {
          if (isLlmError(error)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new LlmError(`claude-code: ${message}`, undefined, false, { cause: error });
        }
        const result = readResult(outcome.stdout);
        if (result === undefined || failed(outcome, result)) throw toClaudeCodeError(outcome, result, run);
        return responseOf(result, request.model);
      }, options.retry);
    },
  };
}
