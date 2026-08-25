import { describe, expect, it } from "vitest";
import { HISTORY_SCHEMA_VERSION, type History } from "../src/history.js";
import { authorStats, fileOwners, hotspots, logicalCoupling, summarize } from "../src/reports.js";

/**
 * Every expectation below is HAND-COUNTED from the fixture (the M9a DoD).
 * The fixture: two authors, three files, four commits —
 *
 *   c0 t=1000 alice          a.ts +10/-0   b.ts +5/-0
 *   c1 t=2000 bob    fix     a.ts +2/-1
 *   c2 t=3000 alice  revert  b.ts +1/-1    c.ts +7/-0
 *   c3 t=4000 bob    fix     a.ts +0/-3    c.ts +1/-1
 */

const hash = (n: number): string => String(n).repeat(40);

const HISTORY: History = {
  schemaVersion: HISTORY_SCHEMA_VERSION,
  scm: "git",
  miner: "codegraph-scm@test",
  repo: "demo",
  authors: ["alice <a@x>", "bob <b@x>"],
  paths: ["a.ts", "b.ts", "c.ts"],
  commits: [
    { hash: hash(0), author: 0, time: 1000, isFix: false, isRevert: false },
    { hash: hash(1), author: 1, time: 2000, isFix: true, isRevert: false },
    { hash: hash(2), author: 0, time: 3000, isFix: false, isRevert: true },
    { hash: hash(3), author: 1, time: 4000, isFix: true, isRevert: false },
  ],
  changes: [
    { commit: 0, path: 0, added: 10, deleted: 0 },
    { commit: 0, path: 1, added: 5, deleted: 0 },
    { commit: 1, path: 0, added: 2, deleted: 1 },
    { commit: 2, path: 1, added: 1, deleted: 1 },
    { commit: 2, path: 2, added: 7, deleted: 0 },
    { commit: 3, path: 0, added: 0, deleted: 3 },
    { commit: 3, path: 2, added: 1, deleted: 1 },
  ],
};

describe("summary", () => {
  const summary = summarize(HISTORY);

  it("counts what the file carries", () => {
    expect(summary).toMatchObject({
      repo: "demo",
      commits: 4,
      authors: 2,
      paths: 3,
      added: 26,
      deleted: 6,
      churn: 32,
      fixes: 2,
      reverts: 1,
      firefighting: 0.5,
    });
    expect(summary.span).toEqual({ from: 1000, to: 4000 });
  });

  it("reports momentum 1 for a history younger than the window", () => {
    expect(summary.momentum).toBe(1);
  });

  it("measures momentum against the last commit, not the wall clock", () => {
    const day = 86_400;
    // 5 commits over 200 days, 4 of them inside the final 90:
    // (4/90) / (5/200) = 16/9.
    const spread: History = {
      ...HISTORY,
      commits: [0, 150, 160, 170, 200].map((day_, index) => ({
        hash: hash(index),
        author: 0,
        time: day_ * day,
        isFix: false,
        isRevert: false,
      })),
      changes: [],
    };
    expect(summarize(spread).momentum).toBeCloseTo(16 / 9, 10);
  });

  it("handles an empty history without dividing by zero", () => {
    const empty: History = { ...HISTORY, commits: [], changes: [], authors: [], paths: [] };
    const summary_ = summarize(empty);
    expect(summary_.span).toBeUndefined();
    expect(summary_.firefighting).toBe(0);
    expect(summary_.momentum).toBe(1);
  });
});

describe("hotspots", () => {
  const rows = hotspots(HISTORY);

  it("ranks by revisions, then churn", () => {
    expect(rows.map((row) => row.path)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  it("counts a.ts by hand: 3 revisions, 16 churn, 2 fixes, 2 authors", () => {
    expect(rows[0]).toEqual({
      path: "a.ts",
      revisions: 3,
      added: 12,
      deleted: 4,
      churn: 16,
      fixes: 2,
      bugDensity: 2 / 3,
      authors: 2,
    });
  });

  it("counts b.ts by hand: alice-only, no fixes", () => {
    expect(rows[2]).toEqual({
      path: "b.ts",
      revisions: 2,
      added: 6,
      deleted: 1,
      churn: 7,
      fixes: 0,
      bugDensity: 0,
      authors: 1,
    });
  });

  it("counts c.ts by hand: one fix out of two revisions", () => {
    expect(rows[1]).toMatchObject({ path: "c.ts", revisions: 2, churn: 9, fixes: 1, bugDensity: 0.5 });
  });
});

describe("fileOwners", () => {
  it("names the dominant author per lineage with the hand-counted share", () => {
    const owners = fileOwners(HISTORY);
    // a.ts: alice +10, bob +2 -> alice owns 10/12.
    expect(owners.get("a.ts")).toEqual({ name: "alice <a@x>", share: 10 / 12 });
    // b.ts: alice alone (+5, +1).
    expect(owners.get("b.ts")).toEqual({ name: "alice <a@x>", share: 1 });
    // c.ts: alice +7, bob +1 -> alice owns 7/8.
    expect(owners.get("c.ts")).toEqual({ name: "alice <a@x>", share: 7 / 8 });
  });

  it("gives no owner to a lineage nobody added lines to", () => {
    const deletions: History = {
      ...HISTORY,
      paths: ["gone.ts"],
      changes: [{ commit: 0, path: 0, added: 0, deleted: 5 }],
    };
    expect(fileOwners(deletions).size).toBe(0);
  });
});

describe("authors", () => {
  const report = authorStats(HISTORY);

  it("ranks alice first on churn (commits tie 2–2)", () => {
    expect(report.rows.map((row) => row.author)).toEqual(["alice <a@x>", "bob <b@x>"]);
  });

  it("counts alice by hand: 23 added, 1 deleted, 3 files, owns all 3", () => {
    expect(report.rows[0]).toEqual({
      author: "alice <a@x>",
      commits: 2,
      added: 23,
      deleted: 1,
      churn: 24,
      paths: 3,
      fixes: 0,
      owns: 3,
    });
  });

  it("counts bob by hand: both fixes are his", () => {
    expect(report.rows[1]).toEqual({
      author: "bob <b@x>",
      commits: 2,
      added: 3,
      deleted: 5,
      churn: 8,
      paths: 2,
      fixes: 2,
      owns: 0,
    });
  });

  it("computes bus factor 1: alice owns every file", () => {
    expect(report.busFactor).toBe(1);
  });

  it("computes bus factor 2 when ownership splits evenly across four files", () => {
    const split: History = {
      ...HISTORY,
      paths: ["a.ts", "b.ts", "c.ts", "d.ts"],
      commits: [
        { hash: hash(0), author: 0, time: 1000, isFix: false, isRevert: false },
        { hash: hash(1), author: 1, time: 2000, isFix: false, isRevert: false },
      ],
      changes: [
        { commit: 0, path: 0, added: 5, deleted: 0 },
        { commit: 0, path: 1, added: 5, deleted: 0 },
        { commit: 1, path: 2, added: 5, deleted: 0 },
        { commit: 1, path: 3, added: 5, deleted: 0 },
      ],
    };
    expect(authorStats(split).busFactor).toBe(2);
  });
});

describe("logical coupling", () => {
  /**
   * Hand-counted: a+b co-change in c0, c1, c2; c joins once (c1); c+d once
   * (c3); c4 touches everything and is skipped at maxChangesetSize 3.
   * Revisions count EVERY commit, skipped ones included — they are facts.
   */
  const COUPLED: History = {
    ...HISTORY,
    paths: ["a.ts", "b.ts", "c.ts", "d.ts"],
    commits: [0, 1, 2, 3, 4].map((n) => ({
      hash: hash(n),
      author: 0,
      time: 1000 + n,
      isFix: false,
      isRevert: false,
    })),
    changes: [
      { commit: 0, path: 0, added: 1, deleted: 0 },
      { commit: 0, path: 1, added: 1, deleted: 0 },
      { commit: 1, path: 0, added: 1, deleted: 0 },
      { commit: 1, path: 1, added: 1, deleted: 0 },
      { commit: 1, path: 2, added: 1, deleted: 0 },
      { commit: 2, path: 0, added: 1, deleted: 0 },
      { commit: 2, path: 1, added: 1, deleted: 0 },
      { commit: 3, path: 2, added: 1, deleted: 0 },
      { commit: 3, path: 3, added: 1, deleted: 0 },
      { commit: 4, path: 0, added: 1, deleted: 0 },
      { commit: 4, path: 1, added: 1, deleted: 0 },
      { commit: 4, path: 2, added: 1, deleted: 0 },
      { commit: 4, path: 3, added: 1, deleted: 0 },
    ],
  };

  it("counts support and confidence by hand: a+b in 3 of 4 revisions", () => {
    const report = logicalCoupling(COUPLED, {
      minSupport: 2,
      minConfidence: 0,
      maxChangesetSize: 3,
    });
    expect(report.rows).toEqual([
      { a: "a.ts", b: "b.ts", support: 3, confidence: 3 / 4, revisionsA: 4, revisionsB: 4 },
    ]);
  });

  it("skips sweeping commits, and says how many", () => {
    const capped = logicalCoupling(COUPLED, { minSupport: 1, minConfidence: 0, maxChangesetSize: 3 });
    expect(capped.skippedChangesets).toBe(1);
    const open = logicalCoupling(COUPLED, { minSupport: 1, minConfidence: 0, maxChangesetSize: 30 });
    expect(open.skippedChangesets).toBe(0);
    // The sweeping commit counted: every pair gains one co-change.
    expect(open.rows.find((row) => row.a === "a.ts" && row.b === "b.ts")?.support).toBe(4);
    expect(open.rows.find((row) => row.a === "c.ts" && row.b === "d.ts")?.support).toBe(2);
  });

  it("applies both thresholds", () => {
    expect(
      logicalCoupling(COUPLED, { minSupport: 2, minConfidence: 0.8, maxChangesetSize: 3 }).rows,
    ).toEqual([]); // 0.75 < 0.8
    expect(
      logicalCoupling(COUPLED, { minSupport: 4, minConfidence: 0, maxChangesetSize: 3 }).rows,
    ).toEqual([]); // support 3 < 4
  });

  it("handles an empty history", () => {
    const empty: History = { ...HISTORY, paths: [], commits: [], changes: [] };
    expect(logicalCoupling(empty).rows).toEqual([]);
  });
});
