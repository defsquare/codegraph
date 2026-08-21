import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { JsonlError, ModelBuilder, RecordReader, decodeRecords } from "../src/jsonl.js";
import { readModelFileSync, readModelRecordsSync } from "../src/jsonl-file.js";
import type { ModelRecord } from "../src/wire.js";

/**
 * `readModelRecordsSync` exists so the analysis-store importer can write rows
 * as records go by, never holding the corpus — and so it does NOT re-implement
 * the wire while doing it. Two readers of one format drift; the drift is
 * invisible until a file one accepts and the other refuses reaches a user.
 *
 * So the property is not "the record stream works" but "the record stream and
 * the model reader are the SAME reader": every file either both accept, or both
 * reject with the same message on the same line.
 */

const fixture = fileURLToPath(
  new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url),
);

const scratch = mkdtempSync(join(tmpdir(), "codegraph-records-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const lines = (): string[] => readFileSync(fixture, "utf8").split("\n").filter((l) => l !== "");

function write(name: string, text: string): string {
  const path = join(scratch, name);
  writeFileSync(path, text, "utf8");
  return path;
}

/** Every way a file can be wrong that the container contract is meant to catch. */
function brokenFiles(): { why: string; path: string }[] {
  const all = lines();
  const lastEdge = all.findLastIndex((line) => line.startsWith('{"t":"x"'));
  const danglingEdge = JSON.parse(all[lastEdge]!) as Record<string, unknown>;
  danglingEdge["o"] = 999_999;

  const firstEntity = all.findIndex((line) => line.startsWith('{"t":"e"'));
  const badTraitKey = JSON.parse(all[firstEntity]!) as Record<string, unknown>;
  delete badTraitKey["name"];

  const forwardModule = JSON.parse(all[firstEntity]!) as Record<string, unknown>;
  forwardModule["m"] = 9_999;

  return [
    { why: "a line that is not JSON", path: write("malformed.jsonl", `${all[0]!}\n{ nope\n`) },
    { why: "JSON that is not a record", path: write("not-a-record.jsonl", '{"hello":"world"}\n') },
    { why: "no eof — a killed writer", path: write("truncated.jsonl", `${all.slice(0, -1).join("\n")}\n`) },
    {
      why: "an eof that disagrees with the content",
      path: write("miscounted.jsonl", `${[...all.slice(0, -2), all.at(-1)!].join("\n")}\n`),
    },
    {
      why: "an edge surrogate resolving to nothing",
      path: write(
        "dangling.jsonl",
        `${[...all.slice(0, lastEdge), JSON.stringify(danglingEdge), ...all.slice(lastEdge + 1)].join("\n")}\n`,
      ),
    },
    {
      why: "an entity missing a key its trait contributes",
      path: write(
        "trait-key.jsonl",
        `${[...all.slice(0, firstEntity), JSON.stringify(badTraitKey), ...all.slice(firstEntity + 1)].join("\n")}\n`,
      ),
    },
    {
      why: "an entity whose module is declared later",
      path: write(
        "forward-module.jsonl",
        `${[...all.slice(0, firstEntity), JSON.stringify(forwardModule), ...all.slice(firstEntity + 1)].join("\n")}\n`,
      ),
    },
    { why: "an empty file", path: write("empty.jsonl", "") },
    {
      why: "a record before the header",
      path: write("headerless.jsonl", '{"t":"f","i":0,"path":"A.java"}\n'),
    },
  ];
}

function failure(run: () => unknown): { name: string; message: string } {
  try {
    run();
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : "not-an-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { name: "no-error", message: "" };
}

describe("the record stream is the same reader as the model reader", () => {
  it("accepts the committed fixture and reports the same counts", () => {
    const model = readModelFileSync(fixture);
    const records = [...readModelRecordsSync(fixture)];
    const of = (tag: string): number => records.filter((record) => record.t === tag).length;

    expect(of("header")).toBe(1);
    expect(of("eof")).toBe(1);
    expect(of("e")).toBe(model.entities.length);
    expect(of("x")).toBe(model.edges.length);
  });

  for (const { why, path } of brokenFiles()) {
    it(`refuses ${why} identically through both routes`, () => {
      const viaModel = failure(() => readModelFileSync(path));
      const viaRecords = failure(() => [...readModelRecordsSync(path)]);

      expect(viaModel.name, `${why}: the model reader accepted it`).toBe("JsonlError");
      expect(viaRecords.name, `${why}: the record stream accepted it`).toBe("JsonlError");
      // The SAME message, including the line number — one reader, two callers.
      expect(viaRecords.message, why).toBe(viaModel.message);
    });
  }
});

describe("the record stream yields the wire, not the model", () => {
  const records = [...readModelRecordsSync(fixture)];

  it("hands over records with surrogates intact, never rendered ids", () => {
    const entity = records.find((record) => record.t === "e");
    expect(entity).toBeDefined();
    expect(entity).toHaveProperty("i");
    expect(entity).not.toHaveProperty("id");

    const edge = records.find((record) => record.t === "x");
    expect(edge).toBeDefined();
    expect(typeof (edge as { f: unknown }).f).toBe("number");
    expect(edge).not.toHaveProperty("from");
  });

  it("puts the header first and the trailer last", () => {
    expect(records[0]?.t).toBe("header");
    expect(records.at(-1)?.t).toBe("eof");
  });

  /**
   * The reason the stream exists: a consumer can build whatever it likes from
   * it, and building a `Model` is just one such consumer — which is exactly how
   * `readModelFileSync` is implemented.
   */
  it("rebuilds the identical model when fed to ModelBuilder", () => {
    const builder = new ModelBuilder();
    for (const record of records) builder.add(record);
    expect(builder.finish()).toEqual(readModelFileSync(fixture));
  });
});

describe("RecordReader, driven directly", () => {
  it("decodeRecords validates a line sequence without touching a file", () => {
    const text = readFileSync(fixture, "utf8");
    const streamed = [...decodeRecords(text.split("\n"))];
    expect(streamed.length).toBe([...readModelRecordsSync(fixture)].length);
  });

  it("reports what it has accepted so far", () => {
    const reader = new RecordReader();
    const all = lines();
    expect(reader.counts).toEqual({ files: 0, entities: 0, edges: 0 });
    for (const line of all) reader.accept(line);
    const eof = reader.finish();
    expect(reader.counts).toEqual(eof.counts);
    expect(reader.header?.lang).toBe("java");
  });

  it("refuses a truncated sequence when asked for the verdict", () => {
    const reader = new RecordReader();
    for (const line of lines().slice(0, -1)) reader.accept(line);
    expect(() => reader.finish()).toThrow(JsonlError);
    expect(() => reader.finish()).toThrow(/truncated/);
  });

  /**
   * A consumer that stops early has not read a whole file, so it is not owed a
   * verdict on one — and must not be handed a false clean bill of health.
   */
  it("gives no verdict to a consumer that abandons the stream", () => {
    let seen = 0;
    for (const record of readModelRecordsSync(fixture)) {
      void record;
      seen += 1;
      if (seen === 3) break;
    }
    expect(seen).toBe(3);
  });
});

describe("what a hand-rolled importer would have got wrong", () => {
  /**
   * The concrete case for owning the wire in one place: a truncated file is
   * still a sequence of perfectly good JSON lines. Anything that reads it with
   * `JSON.parse` per line and no container rules accepts it happily, and the
   * store would then hold a corpus silently missing its tail.
   */
  it("refuses a truncated file that line-by-line JSON.parse accepts", () => {
    const truncated = lines().slice(0, -1);
    const path = write("naive.jsonl", `${truncated.join("\n")}\n`);

    // The naive reader: every line parses, so it sees nothing wrong.
    const naive = truncated.map((line) => JSON.parse(line) as ModelRecord);
    expect(naive.length).toBe(truncated.length);
    expect(naive.every((record) => typeof record.t === "string")).toBe(true);

    expect(() => [...readModelRecordsSync(path)]).toThrow(/truncated/);
  });
});
