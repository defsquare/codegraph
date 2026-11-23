import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSqlite } from "@codegraph/analyzer";
import { sqliteInsightsStore, type JsonSchema } from "@codegraph/insights";
import { LlmError, fakeLlmClient, type LlmClient, type LlmRequest } from "@codegraph/llm";
import { parseInvocation, type ExplainOptions, type WalkOptions } from "../src/args.js";
import type { WalkSeam } from "../src/commands/walk-run.js";

/**
 * A TEST MACHINE for the walk runner (walk.test.ts, explain-configured.test.ts):
 * the Java fixture's sources and every side-car in memory, every store a REAL
 * SQLite file under a scratch directory — so a refusal happens on open, as on
 * a user's disk, and "nothing was written" is a sha256 — and a fake client that
 * answers ANY walk from the response schema it is sent.
 */

export const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
export const SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));
export const KEY = "sk-or-v1-test";
/** Where the side-car of a run sits unless `--out` says otherwise: beside the fixture, so never on a real disk here. */
export const MODEL_DIR = resolve(FIXTURE, "..");

function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(resolve(path), readFileSync(path, "utf8"));
    }
  };
  walk(SRC);
  return out;
}
const SOURCES = sourceFiles();

/** The unit a request is about: its first line, as the engine lays it out. */
export function unitOf(request: LlmRequest): string {
  const rest = (request.user.split("\n")[0] ?? "").replace(/^# Unit: \w+ /u, "");
  const cut = rest.indexOf(" (a cycle of ");
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** A value valid under a strict response schema, from the schema alone. */
function valueFor(schema: JsonSchema, seed: string, key = ""): unknown {
  const anyOf = schema["anyOf"] as JsonSchema[] | undefined;
  if (anyOf !== undefined) return valueFor(anyOf.find((option) => option["type"] !== "null") ?? {}, seed, key);
  const values = schema["enum"] as unknown[] | undefined;
  if (values !== undefined) return values[0];
  switch (schema["type"]) {
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
      return Object.fromEntries(Object.entries(properties).map(([name, sub]) => [name, valueFor(sub, seed, name)]));
    }
    case "array":
      return key === "words" || key === "glossary" ? [] : [valueFor(schema["items"] as JsonSchema, seed, key)];
    case "number":
    case "integer":
      return key === "confidence" ? 0.5 : 1;
    case "boolean":
      return true;
    case "string":
      return key === "description" ? `Description of ${seed}.` : key === "answer" ? `Answer about ${seed}.` : `${key} of ${seed}`;
    default:
      throw new Error(`no value for schema ${JSON.stringify(schema)}`);
  }
}

/** Answers every request from its response schema; a cycle's members from the prompt's "Return one entry per id" line. */
export function schemaAnswer(request: LlmRequest): unknown {
  const schema = request.schema.jsonSchema as JsonSchema;
  const id = unitOf(request);
  if (!request.schema.name.endsWith("_cycle")) return valueFor(schema, id);
  const members = /Return one entry per id: (.+)\.$/mu.exec(request.user)?.[1]?.split(", ") ?? [id];
  const block = ((((schema["properties"] as Record<string, JsonSchema>)["members"] as JsonSchema)["items"] as JsonSchema)["properties"] as Record<string, JsonSchema>)["block"] as JsonSchema;
  return { members: members.map((member) => ({ id: member, block: valueFor(block, member) })) };
}

/** A refusal about ONE unit (it does not fit): a failure the run records and goes on past. */
export const TOO_LONG = "This endpoint's maximum context length is 163840 tokens. However, you requested about 698701 tokens.";

export interface Machine {
  readonly seam: WalkSeam;
  /** Every request the fake client was sent, refused ones included. */
  readonly calls: readonly LlmRequest[];
  /** Every side-car and file a run reads or writes, by resolved path; the sources are there from the start. */
  readonly disk: Map<string, string>;
  readonly requests: LlmRequest[];
  readonly questions: string[];
  /** The real file behind the store at a (virtual) path; its sha256, undefined while it does not exist. */
  storeFile(path: string): string;
  storeSha(path: string): string | undefined;
  /** Every store file the machine holds, by name: what "nothing was written" compares. */
  storeFiles(): string[];
  cleanup(): void;
}

/** `confirm`: the answer to every question; `null`, a session with no terminal to ask on. */
export function machine(
  options: { env?: Record<string, string | undefined>; confirm?: boolean | null; files?: ReadonlyMap<string, string>; refuse?: (request: LlmRequest) => boolean } = {},
): Machine {
  const dir = mkdtempSync(join(tmpdir(), "walk-machine-"));
  const disk = new Map<string, string>([...SOURCES, ...(options.files ?? [])]);
  const mtimes = new Map<string, number>();
  let clock = 0;
  const requests: LlmRequest[] = [];
  const questions: string[] = [];
  const fake = fakeLlmClient({
    respond: (request) => {
      requests.push(request);
      return schemaAnswer(request);
    },
    usage: () => ({ promptTokens: 100, completionTokens: 20, cost: 0.0001 }),
  });
  const refuse = options.refuse;
  const client: LlmClient =
    refuse === undefined
      ? fake
      : { name: fake.name, complete: (request) => (refuse(request) ? fake.complete(request).then(() => Promise.reject(new LlmError(TOO_LONG, 400, false))) : fake.complete(request)) };
  const storeFile = (path: string): string => join(dir, `${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}.db`);
  const confirm = options.confirm === undefined ? true : options.confirm;
  const seam: WalkSeam = {
    env: options.env ?? { OPENROUTER_API_KEY: KEY },
    fs: {
      exists: (path) => disk.has(resolve(path)),
      readFile: (path) => disk.get(resolve(path)),
      stat: (path) => {
        const text = disk.get(resolve(path));
        return text === undefined ? undefined : { size: text.length, mtimeMs: mtimes.get(resolve(path)) ?? 0 };
      },
      writeLinesAtomic: (path, lines) => {
        disk.set(resolve(path), [...lines].map((line) => `${line}\n`).join(""));
        mtimes.set(resolve(path), (clock += 1));
      },
      remove: (path) => void disk.delete(resolve(path)),
    },
    stores: {
      check: () => undefined,
      exists: (path) => existsSync(storeFile(path)),
      open: (path, format) => {
        const db = loadSqlite().open(storeFile(path));
        try {
          return format === undefined ? sqliteInsightsStore(db) : sqliteInsightsStore(db, { format });
        } catch (error) {
          db.close();
          throw error;
        }
      },
    },
    pid: 1000,
    isAlive: () => false,
    clientFor: () => client,
    now: () => new Date("2026-11-21T10:00:00.000Z"),
    confirm:
      confirm === null
        ? undefined
        : (question) => {
            questions.push(question);
            return Promise.resolve(confirm);
          },
  };
  return {
    seam,
    calls: fake.calls,
    disk,
    requests,
    questions,
    storeFile,
    storeSha: (path) => (existsSync(storeFile(path)) ? createHash("sha256").update(readFileSync(storeFile(path))).digest("hex") : undefined),
    storeFiles: () => readdirSync(dir).sort(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** `codegraph walk <fixture> --src <src> --no-cache …`, parsed: no cache is ever written beside the fixture. */
export function walkOptions(argv: readonly string[]): WalkOptions {
  const invocation = parseInvocation(["walk", FIXTURE, "--src", SRC, "--no-cache", ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "walk") throw new Error("not a walk invocation");
  return invocation.options;
}

/** `codegraph explain <fixture> --src <src> --no-cache …`, parsed. */
export function explainOptions(argv: readonly string[]): ExplainOptions {
  const invocation = parseInvocation(["explain", FIXTURE, "--src", SRC, "--no-cache", ...argv]);
  if (invocation.kind !== "run" || invocation.command !== "explain") throw new Error("not an explain invocation");
  return invocation.options;
}
