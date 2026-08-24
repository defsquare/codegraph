import { describe, expect, it } from "vitest";
import { HISTORY_SCHEMA_VERSION, type History } from "../src/history.js";
import {
  HistoryError,
  decodeHistoryText,
  encodeHistoryToString,
} from "../src/jsonl.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

function fixture(): History {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    scm: "git",
    miner: "codegraph-scm@test",
    repo: "demo",
    authors: ["Alice <a@x>", "Bob <b@x>"],
    paths: ["src/a.ts", "src/b.ts"],
    commits: [
      { hash: HASH_A, author: 0, time: 100, isFix: false, isRevert: false },
      { hash: HASH_B, author: 1, time: 200, isFix: true, isRevert: true },
    ],
    changes: [
      { commit: 0, path: 0, added: 3, deleted: 0 },
      { commit: 1, path: 1, added: 1, deleted: 2, renamedFrom: "src/old.ts" },
    ],
  };
}

describe("round-trip", () => {
  it("decode(encode(h)) is h", () => {
    const history = fixture();
    expect(decodeHistoryText(encodeHistoryToString(history))).toEqual(history);
  });

  it("fix and revert flags survive, and absent flags stay absent", () => {
    const lines = encodeHistoryToString(fixture()).split("\n");
    const commits = lines.filter((line) => line.includes('"t":"c"'));
    expect(commits[0]).not.toContain("fix");
    expect(commits[1]).toContain('"fix":true');
    expect(commits[1]).toContain('"revert":true');
  });
});

describe("determinism (the M9a DoD)", () => {
  it("is byte-identical across runs", () => {
    expect(encodeHistoryToString(fixture())).toBe(encodeHistoryToString(fixture()));
  });

  it("canonicalizes producer ordering: shuffled input, identical bytes", () => {
    const shuffled: History = {
      ...fixture(),
      commits: [...fixture().commits].reverse(),
      changes: [...fixture().changes].reverse(),
    };
    // References index the ORIGINAL arrays, so reversing both keeps meaning
    // while destroying order — the encoder must restore canonical order.
    const remapped: History = {
      ...shuffled,
      commits: shuffled.commits,
      changes: shuffled.changes.map((change) => ({
        ...change,
        commit: 1 - change.commit,
      })),
    };
    expect(encodeHistoryToString(remapped)).toBe(encodeHistoryToString(fixture()));
  });

  it("refuses two commits claiming one hash", () => {
    const twice: History = {
      ...fixture(),
      commits: [
        { hash: HASH_A, author: 0, time: 100, isFix: false, isRevert: false },
        { hash: HASH_A, author: 1, time: 200, isFix: false, isRevert: false },
      ],
      changes: [],
    };
    expect(() => encodeHistoryToString(twice)).toThrow(HistoryError);
  });
});

describe("the wire contract", () => {
  const lines = (): string[] => encodeHistoryToString(fixture()).split("\n").filter((l) => l !== "");

  it("orders sections header → paths → commits → changes → eof", () => {
    const tags = lines().map((line) => (JSON.parse(line) as { t: string }).t);
    expect(tags).toEqual(["header", "f", "f", "c", "c", "x", "x", "eof"]);
  });

  it("refuses a truncated file (no eof)", () => {
    const cut = lines().slice(0, -1).join("\n");
    expect(() => decodeHistoryText(cut)).toThrow(/truncated|no eof/);
  });

  it("refuses an eof that miscounts", () => {
    const all = lines();
    const withoutOneChange = [...all.slice(0, -2), all[all.length - 1] as string].join("\n");
    expect(() => decodeHistoryText(withoutOneChange)).toThrow(/eof declares/);
  });

  it("refuses a model.jsonl header — a history file self-identifies", () => {
    const model =
      '{"t":"header","schemaVersion":1,"lang":"java","extractor":{"name":"x","version":"1"},"root":".","dict":{}}';
    expect(() => decodeHistoryText(model)).toThrow(HistoryError);
  });

  it("refuses an out-of-order surrogate", () => {
    const swapped = lines();
    const c0 = swapped[3] as string;
    swapped[3] = swapped[4] as string;
    swapped[4] = c0;
    expect(() => decodeHistoryText(swapped.join("\n"))).toThrow(/out of order/);
  });

  it("refuses a change pointing past the sections it references", () => {
    const all = lines();
    const bad = all.map((line) =>
      line.includes('"t":"x"') ? line.replace('"p":1', '"p":9') : line,
    );
    expect(() => decodeHistoryText(bad.join("\n"))).toThrow(/closure/);
  });

  it("refuses an author reference outside the dictionary", () => {
    const bad = lines().map((line) =>
      line.includes('"t":"c"') ? line.replace('"a":1', '"a":7') : line,
    );
    expect(() => decodeHistoryText(bad.join("\n"))).toThrow(/author/);
  });

  it("refuses an unknown record type", () => {
    const all = lines();
    expect(() => decodeHistoryText([all[0] as string, '{"t":"zz"}'].join("\n"))).toThrow(
      /unknown record type/,
    );
  });

  it("tolerates blank lines", () => {
    const spaced = lines().join("\n\n");
    expect(decodeHistoryText(spaced)).toEqual(fixture());
  });
});
