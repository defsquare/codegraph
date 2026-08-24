import { z } from "zod";
import {
  HISTORY_SCHEMA_VERSION,
  type Change,
  type Commit,
  type History,
} from "./history.js";
import {
  HistoryChangeRec,
  HistoryCommitRec,
  HistoryEofRec,
  HistoryHeaderRec,
  HistoryPathRec,
  type HistoryRecord,
} from "./wire.js";

/**
 * The `history.jsonl` codec — pure: strings in, history out, no I/O. The CLI
 * adds the file handling, exactly as `jsonl-file.ts` does for the model.
 */

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "HistoryError";
  }
}

// ---------------------------------------------------------------- encoding

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * History → JSONL lines, in canonical order. The ENCODER canonicalizes —
 * sorted dictionaries, (time, hash) commit order, (commit, path) change order
 * — so byte-identical output is a property of the artifact, not a discipline
 * asked of every producer.
 */
export function* encodeHistory(history: History): Generator<string> {
  const authors = [...new Set(history.authors)].sort(compareText);
  const authorRef = new Map(authors.map((author, index) => [author, index]));
  const paths = [...new Set(history.paths)].sort(compareText);
  const pathRef = new Map(paths.map((path, index) => [path, index]));

  // Commits re-sort by (time, hash); changes must follow their commit across
  // that renumbering, so the old index is mapped, not assumed.
  const order = history.commits
    .map((commit, index) => ({ commit, index }))
    .sort((a, b) => a.commit.time - b.commit.time || compareText(a.commit.hash, b.commit.hash));
  const commitRef = new Map(order.map(({ index }, at) => [index, at]));

  const seen = new Set<string>();
  for (const { commit } of order) {
    if (seen.has(commit.hash)) throw new HistoryError(`duplicate commit hash: ${commit.hash}`, 0);
    seen.add(commit.hash);
  }

  const refOf = <T>(map: Map<T, number>, key: T, what: string): number => {
    const ref = map.get(key);
    if (ref === undefined) throw new HistoryError(`${what} not in its dictionary: ${String(key)}`, 0);
    return ref;
  };

  yield JSON.stringify({
    t: "header",
    artifact: "history",
    schemaVersion: history.schemaVersion,
    scm: history.scm,
    miner: history.miner,
    repo: history.repo,
    dict: { authors },
  } satisfies HistoryHeaderRec);

  for (const [index, path] of paths.entries()) {
    yield JSON.stringify({ t: "f", i: index, path } satisfies HistoryPathRec);
  }

  for (const [index, { commit }] of order.entries()) {
    const record: HistoryCommitRec = {
      t: "c",
      i: index,
      h: commit.hash,
      a: refOf(authorRef, history.authors[commit.author] as string, "author"),
      ts: commit.time,
      ...(commit.isFix ? { fix: true as const } : {}),
      ...(commit.isRevert ? { revert: true as const } : {}),
    };
    yield JSON.stringify(record);
  }

  const changes = history.changes
    .map((change) => ({
      change,
      c: refOf(commitRef, change.commit, "commit"),
      p: refOf(pathRef, history.paths[change.path] as string, "path"),
    }))
    .sort((a, b) => a.c - b.c || a.p - b.p);
  for (const { change, c, p } of changes) {
    const record: HistoryChangeRec = {
      t: "x",
      c,
      p,
      a: change.added,
      d: change.deleted,
      ...(change.renamedFrom === undefined ? {} : { from: change.renamedFrom }),
    };
    yield JSON.stringify(record);
  }

  yield JSON.stringify({
    t: "eof",
    counts: { paths: paths.length, commits: order.length, changes: changes.length },
  } satisfies HistoryEofRec);
}

/** History → one JSONL document. For tests and reports; mining streams. */
export function encodeHistoryToString(history: History): string {
  let out = "";
  for (const line of encodeHistory(history)) out += `${line}\n`;
  return out;
}

// ---------------------------------------------------------------- decoding

/**
 * The wire validator: everything that makes a sequence of lines a conforming
 * history file. Section order, dense surrogates, reference bounds — commits
 * and changes only ever point BACKWARD (their sections follow what they
 * reference), so every reference is decidable on arrival — and the trailer.
 */
export class HistoryReader {
  #line = 0;
  #section = -1;
  #header?: HistoryHeaderRec;
  #paths = 0;
  #commits = 0;
  #changes = 0;
  #eof?: HistoryEofRec;

  get header(): HistoryHeaderRec | undefined {
    return this.#header;
  }

  accept(text: string): HistoryRecord | undefined {
    this.#line += 1;
    const trimmed = text.trim();
    if (trimmed === "") return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new HistoryError(
        `not JSON: ${error instanceof Error ? error.message : String(error)}`,
        this.#line,
      );
    }
    const tag = (parsed as { t?: unknown }).t;
    if (typeof tag !== "string") throw new HistoryError("record has no `t` tag", this.#line);

    switch (tag) {
      case "header":
        return this.#acceptHeader(parsed);
      case "f":
        return this.#acceptPath(parsed);
      case "c":
        return this.#acceptCommit(parsed);
      case "x":
        return this.#acceptChange(parsed);
      case "eof":
        return this.#acceptEof(parsed);
      default:
        throw new HistoryError(`unknown record type ${JSON.stringify(tag)}`, this.#line);
    }
  }

  finish(): HistoryEofRec {
    if (this.#header === undefined) throw new HistoryError("empty file: no header record", 0);
    if (this.#eof === undefined) {
      throw new HistoryError("no eof record — the file is truncated, or the miner died mid-run", 0);
    }
    const actual = { paths: this.#paths, commits: this.#commits, changes: this.#changes };
    for (const section of ["paths", "commits", "changes"] as const) {
      if (this.#eof.counts[section] !== actual[section]) {
        throw new HistoryError(
          `eof declares ${this.#eof.counts[section]} ${section} but the file carries ${actual[section]}`,
          0,
        );
      }
    }
    return this.#eof;
  }

  #enter(section: number, tag: string): void {
    if (section < this.#section) {
      throw new HistoryError(`"${tag}" record after the section it belongs to closed`, this.#line);
    }
    this.#section = section;
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new HistoryError(`invalid ${what}:\n${z.prettifyError(result.error)}`, this.#line);
    }
    return result.data;
  }

  #acceptHeader(value: unknown): HistoryHeaderRec {
    if (this.#header !== undefined) throw new HistoryError("a second header record", this.#line);
    if (this.#line !== 1) throw new HistoryError("the header must be the first record", this.#line);
    this.#enter(0, "header");
    const header = this.#parse(HistoryHeaderRec, value, "history header");
    const seen = new Set<string>();
    for (const author of header.dict.authors) {
      if (seen.has(author)) {
        throw new HistoryError(
          `header dictionary \`authors\` repeats ${JSON.stringify(author)} — a vocabulary is a set`,
          this.#line,
        );
      }
      seen.add(author);
    }
    this.#header = header;
    return header;
  }

  #need(): HistoryHeaderRec {
    if (this.#header === undefined) throw new HistoryError("record before the header", this.#line);
    return this.#header;
  }

  #acceptPath(value: unknown): HistoryPathRec {
    this.#need();
    this.#enter(1, "f");
    const record = this.#parse(HistoryPathRec, value, "path record");
    if (record.i !== this.#paths) {
      throw new HistoryError(`path index ${record.i} out of order — expected ${this.#paths}`, this.#line);
    }
    this.#paths += 1;
    return record;
  }

  #acceptCommit(value: unknown): HistoryCommitRec {
    const header = this.#need();
    this.#enter(2, "c");
    const record = this.#parse(HistoryCommitRec, value, "commit record");
    if (record.i !== this.#commits) {
      throw new HistoryError(
        `commit surrogate ${record.i} out of order — expected ${this.#commits}`,
        this.#line,
      );
    }
    if (record.a >= header.dict.authors.length) {
      throw new HistoryError(`author ${record.a} is not in the header dictionary`, this.#line);
    }
    this.#commits += 1;
    return record;
  }

  #acceptChange(value: unknown): HistoryChangeRec {
    this.#need();
    this.#enter(3, "x");
    const record = this.#parse(HistoryChangeRec, value, "change record");
    if (record.c >= this.#commits) {
      throw new HistoryError(`change commit ${record.c} resolves to no commit (closure)`, this.#line);
    }
    if (record.p >= this.#paths) {
      throw new HistoryError(`change path ${record.p} resolves to no path (closure)`, this.#line);
    }
    this.#changes += 1;
    return record;
  }

  #acceptEof(value: unknown): HistoryEofRec {
    this.#need();
    if (this.#eof !== undefined) throw new HistoryError("a second eof record", this.#line);
    this.#enter(4, "eof");
    this.#eof = this.#parse(HistoryEofRec, value, "eof record");
    return this.#eof;
  }
}

/** Lines in, validated {@link History} out. */
export function decodeHistory(lines: Iterable<string>): History {
  const reader = new HistoryReader();
  const paths: string[] = [];
  const commits: Commit[] = [];
  const changes: Change[] = [];
  for (const line of lines) {
    const record = reader.accept(line);
    if (record === undefined) continue;
    switch (record.t) {
      case "f":
        paths.push(record.path);
        break;
      case "c":
        commits.push({
          hash: record.h,
          author: record.a,
          time: record.ts,
          isFix: record.fix === true,
          isRevert: record.revert === true,
        });
        break;
      case "x":
        changes.push({
          commit: record.c,
          path: record.p,
          added: record.a,
          deleted: record.d,
          ...(record.from === undefined ? {} : { renamedFrom: record.from }),
        });
        break;
      default:
        break;
    }
  }
  reader.finish();
  const header = reader.header as HistoryHeaderRec;
  if (header.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    throw new HistoryError(
      `history schemaVersion ${header.schemaVersion} is not supported (this codegraph reads ${HISTORY_SCHEMA_VERSION})`,
      0,
    );
  }
  return {
    schemaVersion: header.schemaVersion,
    scm: header.scm,
    miner: header.miner,
    repo: header.repo,
    authors: header.dict.authors,
    paths,
    commits,
    changes,
  };
}

/** Whole-document convenience for the CLI: one string in, history out. */
export function decodeHistoryText(text: string): History {
  return decodeHistory(text.split("\n"));
}
