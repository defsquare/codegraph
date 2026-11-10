import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_DRAIN_GRACE_MS,
  CLAUDE_CODE_KILL_GRACE_MS,
  childProcessRunner,
  type ClaudeCodeChild,
  type ClaudeCodeRun,
  type ClaudeCodeSpawn,
  type ClaudeCodeSpawnOptions,
} from "../src/claude-code.js";

/**
 * The default `ClaudeCodeProcess` drives a child through the slice of
 * `ChildProcess` it needs; these tests hand it a scripted child, so the
 * runner's own behaviour — argv as an array, stdin, the two streams, the
 * timeout's SIGTERM then SIGKILL, the abort signal, the drain after an exit
 * whose pipes a descendant still holds — is exercised without a single
 * process being spawned.
 */

/** A stdio pipe: emits 'data', records whether the runner destroyed it. */
class FakeStream extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter implements ClaudeCodeChild {
  readonly written: string[] = [];
  ended = false;
  readonly kills: NodeJS.Signals[] = [];
  readonly stdinErrors: ((error: Error) => void)[] = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
    end: (): void => {
      this.ended = true;
    },
    on: (_event: "error", listener: (error: Error) => void): void => {
      this.stdinErrors.push(listener);
    },
  };
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
}

type Spawned = { command: string; argv: readonly string[]; options: ClaudeCodeSpawnOptions };

function fakeSpawn(behaviour: { throws?: Error } = {}): { spawn: ClaudeCodeSpawn; calls: Spawned[]; children: FakeChild[] } {
  const calls: Spawned[] = [];
  const children: FakeChild[] = [];
  const spawn: ClaudeCodeSpawn = (command, argv, options) => {
    calls.push({ command, argv, options });
    if (behaviour.throws !== undefined) throw behaviour.throws;
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

const RUN: ClaudeCodeRun = {
  command: "/home/me/.local/bin/claude",
  argv: ["-p", "--output-format", "json", "--system-prompt", "a system prompt with spaces and \"quotes\""],
  stdin: "# Unit\nexplain it",
  env: { PATH: "/usr/bin", HOME: "/home/me" },
  cwd: "/tmp/scratch",
  timeoutMs: 600_000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("childProcessRunner", () => {
  it("spawns the command with the argv as an array (no shell), the run's cwd and env, and pipes every stream", () => {
    const { spawn, calls, children } = fakeSpawn();
    void childProcessRunner({ spawn }).run(RUN);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: RUN.command,
      argv: RUN.argv,
      options: { cwd: RUN.cwd, env: RUN.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    });
    expect(children[0]!.written).toEqual([RUN.stdin]);
    expect(children[0]!.ended).toBe(true);
    expect(children[0]!.stdinErrors).toHaveLength(1);
  });

  it("collects stdout and stderr as UTF-8 across chunks and resolves with the exit code", async () => {
    const { spawn, children } = fakeSpawn();
    const pending = childProcessRunner({ spawn }).run(RUN);
    const child = children[0]!;
    const accented = Buffer.from("é", "utf8");
    child.stdout.emit("data", Buffer.from('{"type":"result","result":"caf'));
    child.stdout.emit("data", accented.subarray(0, 1));
    child.stdout.emit("data", accented.subarray(1));
    child.stdout.emit("data", '"}');
    child.stderr.emit("data", Buffer.from("a warning"));
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ stdout: '{"type":"result","result":"café"}', stderr: "a warning", code: 0, signal: null });
  });

  it("reports a spawn failure as the outcome's error, and ignores the close that may follow", async () => {
    const { spawn, children } = fakeSpawn();
    const pending = childProcessRunner({ spawn }).run(RUN);
    const failure = Object.assign(new Error(`spawn ${RUN.command} ENOENT`), { code: "ENOENT", path: RUN.command, syscall: "spawn" });
    children[0]!.emit("error", failure);
    children[0]!.emit("close", -2, null);
    await expect(pending).resolves.toEqual({ stdout: "", stderr: "", code: null, signal: null, error: failure });
  });

  it("reports a spawn that throws synchronously the same way", async () => {
    const thrown = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    const { spawn } = fakeSpawn({ throws: thrown });
    await expect(childProcessRunner({ spawn }).run(RUN)).resolves.toMatchObject({ code: null, error: thrown });
  });

  it("kills the child at the timeout with SIGTERM, then SIGKILL after the grace period, and says it timed out", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const pending = childProcessRunner({ spawn }).run({ ...RUN, timeoutMs: 1000 });
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(CLAUDE_CODE_KILL_GRACE_MS - 1);
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("close", null, "SIGKILL");
    await expect(pending).resolves.toEqual({ stdout: "", stderr: "", code: null, signal: "SIGKILL", timedOut: true });
  });

  it("does not escalate to SIGKILL when the child leaves on SIGTERM, and a child that finishes in time is never killed", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const runner = childProcessRunner({ spawn, killGraceMs: 50 });
    const slow = runner.run({ ...RUN, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    children[0]!.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
    await expect(slow).resolves.toMatchObject({ signal: "SIGTERM", timedOut: true });

    const quick = runner.run({ ...RUN, timeoutMs: 100 });
    children[1]!.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children[1]!.kills).toEqual([]);
    await expect(quick).resolves.toMatchObject({ code: 0, signal: null });
    expect("timedOut" in (await quick)).toBe(false);
  });

  it("settles within the drain grace once the child has exited while a descendant still holds the pipes — not timed out, nothing killed", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    let resolved = false;
    const pending = childProcessRunner({ spawn }).run({ ...RUN, timeoutMs: 500 });
    void pending.then(() => {
      resolved = true;
    });
    const child = children[0]!;
    child.stdout.emit("data", Buffer.from('{"type":"result"}'));
    child.emit("exit", 0, null); // the child is gone; `sleep 30 &` keeps stdout open, so 'close' never comes on its own
    await vi.advanceTimersByTimeAsync(CLAUDE_CODE_DRAIN_GRACE_MS - 1); // the 500 ms timeout has fired by now
    expect(resolved).toBe(false);
    expect(child.kills).toEqual([]);
    expect(child.stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    await expect(pending).resolves.toEqual({ stdout: '{"type":"result"}', stderr: "", code: 0, signal: null });
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", 0, null); // the late close is ignored
    expect(CLAUDE_CODE_DRAIN_GRACE_MS).toBe(1000);
  });

  it("a timed-out child whose orphan keeps the pipes settles within the drain grace after its exit, timed out, without SIGKILL", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const pending = childProcessRunner({ spawn, drainGraceMs: 200 }).run({ ...RUN, timeoutMs: 1000 });
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kills).toEqual(["SIGTERM"]);
    child.emit("exit", null, "SIGTERM"); // sh is gone, its `sleep 20` holds the pipes
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({ stdout: "", stderr: "", code: null, signal: "SIGTERM", timedOut: true });
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the 'close' fast path still wins when the streams end on their own: no drain, no destroy", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const pending = childProcessRunner({ spawn }).run(RUN);
    const child = children[0]!;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await expect(pending).resolves.toMatchObject({ code: 0, signal: null });
    expect(child.stdout.destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills once: a timeout followed by an abort sends one SIGTERM, one SIGKILL, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const controller = new AbortController();
    const pending = childProcessRunner({ spawn, killGraceMs: 300 }).run({ ...RUN, timeoutMs: 100, signal: controller.signal });
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("stop"));
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({ name: "LlmError", retryable: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours the abort signal: kills the child and rejects with a final LlmError carrying the reason", async () => {
    const { spawn, children } = fakeSpawn();
    const controller = new AbortController();
    const pending = childProcessRunner({ spawn }).run({ ...RUN, signal: controller.signal });
    const reason = new Error("the user stopped the run");
    controller.abort(reason);
    expect(children[0]!.kills).toEqual(["SIGTERM"]);
    children[0]!.emit("close", null, "SIGTERM");
    await expect(pending).rejects.toMatchObject({ name: "LlmError", status: undefined, retryable: false, cause: reason });
  });

  it("rejects without spawning when the signal is already aborted", async () => {
    const { spawn, calls } = fakeSpawn();
    const controller = new AbortController();
    controller.abort();
    await expect(childProcessRunner({ spawn }).run({ ...RUN, signal: controller.signal })).rejects.toMatchObject({ name: "LlmError", retryable: false });
    expect(calls).toHaveLength(0);
  });
});
