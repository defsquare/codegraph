import { describe, expect, it } from "vitest";
import { DEP_PAGE_SIZE, depPage } from "../src/model/grouping.js";

/**
 * Selecting `String` in a real corpus offers 25,386 dependency rows. Mounting
 * them all cost 3.3 s of blocked main thread and ~200k DOM nodes, so a section
 * mounts one page at a time. The count it reports is always the WHOLE truth —
 * paging is what the DOM holds, never what the model says.
 */
describe("dependency section paging", () => {
  it("mounts at most one page at first", () => {
    expect(depPage(25_386, 1).shown).toBe(DEP_PAGE_SIZE);
    expect(depPage(25_386, 1).remaining).toBe(25_386 - DEP_PAGE_SIZE);
  });

  it("never claims more rows than the section holds", () => {
    for (const total of [0, 1, 7, DEP_PAGE_SIZE, DEP_PAGE_SIZE + 1, 25_386]) {
      for (const pages of [1, 2, 9, 1000]) {
        const page = depPage(total, pages);
        expect(page.shown).toBeLessThanOrEqual(total);
        expect(page.shown + page.remaining).toBe(total);
        expect(page.remaining).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reveals a further page on demand and ends with nothing remaining", () => {
    expect(depPage(450, 2).shown).toBe(400);
    expect(depPage(450, 3)).toEqual({ shown: 450, remaining: 0 });
  });

  it("a section that fits shows everything and offers no more", () => {
    expect(depPage(12, 1)).toEqual({ shown: 12, remaining: 0 });
  });
});
