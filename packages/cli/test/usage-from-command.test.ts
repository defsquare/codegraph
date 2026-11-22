import { describe, expect, it, vi } from "vitest";
import { EXIT, UsageError } from "../src/exit.js";
import { captureIo } from "../src/io.js";

/**
 * A usage error raised INSIDE a command — an unreadable model path, an
 * unwritable `--out` — must still exit 2 with a readable message, not 1. While
 * every command is a seam this is the only way to exercise that branch of
 * `run`, and it stays valuable afterwards: it pins the mapping rather than one
 * command's behaviour.
 */
vi.mock("../src/commands/validate.js", () => ({
  validateCommand: () => {
    throw new UsageError("cannot read /nope.json: ENOENT", "Check the path exists.");
  },
}));

// The lazily loaded, asynchronous command: its usage errors settle through the same mapping.
vi.mock("../src/commands/walk.js", () => ({
  walkCommand: () => Promise.reject(new UsageError("--walk cannot read /nope.json", "The path is read relative to the current directory.")),
}));

const { run } = await import("../src/main.js");

describe("a usage error thrown by a command", () => {
  it("exits 2, prints message and hint on stderr, and leaves stdout empty", () => {
    const io = captureIo();
    const code = run(["validate", "/nope.json"], io);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("cannot read /nope.json");
    expect(io.stderr()).toContain("Check the path exists.");
    expect(io.stderr()).not.toContain("bug in codegraph");
  });
});

describe("a usage error rejected by an asynchronous command", () => {
  it("exits 2 too, message and hint on stderr, stdout empty — never an unhandled rejection", async () => {
    const io = captureIo();
    const outcome = run(["walk", "--print-definition"], io);
    expect(outcome).toBeInstanceOf(Promise);
    expect(await outcome).toBe(EXIT.USAGE);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("codegraph: --walk cannot read /nope.json");
    expect(io.stderr()).toContain("The path is read relative to the current directory.");
    expect(io.stderr()).not.toContain("bug in codegraph");
  });
});
