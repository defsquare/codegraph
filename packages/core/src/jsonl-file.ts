import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ModelDecoder, encodeModel } from "./jsonl.js";
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
