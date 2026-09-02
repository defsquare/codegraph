import { describe, expect, it } from "vitest";
import { createSourceReader, mapReader } from "../src/source.js";

const FILE = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

function reader(files: Record<string, string> = { "A.java": FILE }) {
  let reads = 0;
  const read = mapReader(new Map(Object.entries(files)));
  const counted = (path: string) => {
    reads += 1;
    return read(path);
  };
  return { reader: createSourceReader(counted), reads: () => reads };
}

describe("createSourceReader", () => {
  it("returns exactly the anchored lines, 1-based inclusive", () => {
    const { reader: r } = reader();
    const slice = r.slice({ file: "A.java", span: [3, 5] }, 200);
    expect(slice).toEqual({ file: "A.java", span: [3, 5], text: "line 3\nline 4\nline 5", truncated: false, missing: false });
  });

  it("elides the middle of a span longer than the cap, keeping head and tail", () => {
    const { reader: r } = reader();
    const slice = r.slice({ file: "A.java", span: [1, 100] }, 40);
    const lines = slice.text.split("\n");
    expect(slice.truncated).toBe(true);
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("line 1");
    expect(lines[lines.length - 1]).toBe("line 100");
    expect(lines.find((l) => l.includes("elided"))).toBe("// … 61 lines elided …");
  });

  it("reports a missing file as a fact, once, and reads each file once", () => {
    const { reader: r, reads } = reader();
    const missing = r.slice({ file: "B.java", span: [1, 2] }, 10);
    expect(missing).toEqual({ file: "B.java", span: [1, 2], text: "", truncated: false, missing: true });
    r.slice({ file: "B.java", span: [3, 4] }, 10);
    r.slice({ file: "A.java", span: [1, 1] }, 10);
    r.slice({ file: "A.java", span: [2, 2] }, 10);
    expect(reads()).toBe(2);
    expect(r.misses()).toEqual(["B.java"]);
  });

  it("clamps a span that overruns the file", () => {
    const { reader: r } = reader({ "S.java": "a\nb" });
    expect(r.slice({ file: "S.java", span: [2, 9] }, 10).text).toBe("b");
  });
});
