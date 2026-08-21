import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { ModelBuilder, ModelDecoder, RecordReader, encodeModel } from "./jsonl.js";
import type { ModelRecord } from "./wire.js";
import type { Model } from "./model.js";

/**
 * File I/O for the JSONL interchange — the only module in `core` that touches
 * Node. Kept separate so the codec itself stays pure and portable.
 *
 * Both directions stream a line at a time. That is the entire point of M6: the
 * whole-document forms (`readFileSync` + `JSON.parse`, `JSON.stringify` + write)
 * cannot represent a 559MB model at all, because a JS string tops out at ~512MB.
 */

/** Reads a `.jsonl` model. Never holds more than one line as a string. */
export async function readModelFile(path: string): Promise<Model> {
  const decoder = new ModelDecoder();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) decoder.push(line);
  } finally {
    lines.close();
    stream.close();
  }
  return decoder.finish();
}

/** Writes a `.jsonl` model, one line at a time, LF-terminated, UTF-8. */
export async function writeModelFile(model: Model, path: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    const stream = handle.createWriteStream({ encoding: "utf8" });
    for (const line of encodeModel(model)) {
      if (!stream.write(`${line}\n`)) {
        await new Promise<void>((resolve) => stream.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.once("error", reject);
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 1MB — big enough that syscalls disappear, small enough to stay off the heap. */
const CHUNK = 1 << 20;

/**
 * The same read, synchronously. Chunked on purpose: `readFileSync` would build
 * one string for the whole file, which is the ceiling M6 exists to escape —
 * fineract's model is far past it. Sync matters because the CLI is sync all the
 * way down, and making it async would change every command's signature to buy
 * nothing the chunking does not already give.
 */
export function readModelFileSync(path: string): Model {
  const builder = new ModelBuilder();
  for (const record of readModelRecordsSync(path)) builder.add(record);
  return builder.finish();
}

/**
 * The same file, as a stream of VALIDATED RECORDS rather than a model.
 *
 * This is what the analysis-store importer consumes: it writes rows as the
 * records go by and never holds the corpus, but it enforces the identical
 * contract because the enforcement is {@link RecordReader}'s, not its own. An
 * importer that hand-rolled `JSON.parse` would accept a truncated file this
 * refuses — and core would stop being the only owner of the vocabulary.
 *
 * Chunked, like {@link readModelFileSync}, and for the same reason: a model of
 * a real corpus does not fit in one JavaScript string. The file descriptor is
 * closed even if the consumer abandons the loop.
 */
export function* readModelRecordsSync(path: string): Generator<ModelRecord> {
  const reader = new RecordReader();
  const utf8 = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(CHUNK);
  const fd = openSync(path, "r");
  let carry = "";
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      // The decoder holds back a split multi-byte sequence until its rest arrives.
      carry += utf8.write(buffer.subarray(0, read));
      let newline = carry.indexOf("\n");
      while (newline >= 0) {
        const record = reader.accept(carry.slice(0, newline));
        if (record !== undefined) yield record;
        carry = carry.slice(newline + 1);
        newline = carry.indexOf("\n");
      }
    }
    carry += utf8.end();
    if (carry !== "") {
      const record = reader.accept(carry);
      if (record !== undefined) yield record;
    }
    // Only reached when the consumer drained the stream: a caller that breaks
    // out early has not read a whole file and is not owed the trailer's verdict.
    reader.finish();
  } finally {
    closeSync(fd);
  }
}
