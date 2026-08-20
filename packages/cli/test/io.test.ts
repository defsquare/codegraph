import { describe, expect, it } from "vitest";
import { captureIo, errLine, errLines, outLine, outLines, type IoSink } from "../src/io.js";

describe("the io sink", () => {
  it("keeps the artifact and the human stream apart", () => {
    const io = captureIo();
    io.out("digraph {}");
    io.err("loaded 1 model");
    expect(io.stdout()).toBe("digraph {}");
    expect(io.stderr()).toBe("loaded 1 model");
  });

  it("writes text verbatim — the caller owns the newlines", () => {
    const io = captureIo();
    io.out("a");
    io.out("b");
    expect(io.stdout()).toBe("ab");
  });

  it("adds exactly one newline per line helper", () => {
    const io = captureIo();
    outLine(io, "one");
    outLine(io);
    errLine(io, "two");
    expect(io.stdout()).toBe("one\n\n");
    expect(io.stderr()).toBe("two\n");
  });

  it("writes whole blocks in one call and splits them back", () => {
    const io = captureIo();
    outLines(io, ["a", "b", "c"]);
    errLines(io, ["x"]);
    expect(io.stdout()).toBe("a\nb\nc\n");
    expect(io.stdoutLines()).toEqual(["a", "b", "c"]);
    expect(io.stderrLines()).toEqual(["x"]);
  });

  it("writes nothing for an empty block", () => {
    const io = captureIo();
    outLines(io, []);
    errLines(io, []);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe("");
    expect(io.stdoutLines()).toEqual([]);
  });

  it("records --out files instead of touching a disk", () => {
    const io = captureIo();
    io.writeFile("graph.dot", "digraph {}\n");
    expect(io.files().get("graph.dot")).toBe("digraph {}\n");
    expect(io.stdout()).toBe("");
  });

  it("is an IoSink, so a command takes it with no adapter", () => {
    const io = captureIo();
    const sink: IoSink = io;
    sink.out("x");
    expect(io.stdout()).toBe("x");
  });
});

describe("no ANSI colour, ever (decision 4)", () => {
  it("offers no colour helper and emits no escape code", () => {
    const io = captureIo();
    outLine(io, "plain report line");
    errLine(io, "plain warning line");
    // The escape byte is written as an escape SEQUENCE here, never pasted in
    // as a literal control character: a raw control byte makes a source file
    // unreviewable in a diff.
    // eslint-disable-next-line no-control-regex
    const ansi = new RegExp("\\u001b\\[");
    expect(ansi.test(io.stdout())).toBe(false);
    expect(ansi.test(io.stderr())).toBe(false);
  });
});
