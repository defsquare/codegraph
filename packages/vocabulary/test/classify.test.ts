import { PROFILES, getProfile, type Lexicon } from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_TECHNICAL, TERM_CLASSES, createClassifier, type TermClass } from "../src/classify.js";

/**
 * Classification, not filtering (PLAN.md §20 principle 3): every word is kept
 * and tagged; a consumer decides what to show. The order is fixed — keyword,
 * short, technical, domain — so a word the language reserves is a keyword
 * even where the shared list calls it plumbing.
 */

function lexiconOf(lang: string): Lexicon {
  const lexicon = getProfile(lang)?.lexicon;
  if (lexicon === undefined) throw new Error(`${lang} ships no lexicon`);
  return lexicon;
}

const WORD = /^[\p{L}\p{M}\p{N}]+$/u;

describe("the classes", () => {
  it("are a closed set of four", () => {
    expect(TERM_CLASSES).toEqual(["domain", "technical", "keyword", "short"]);
  });
});

describe("one word, per language", () => {
  const rows: readonly (readonly [lang: string, token: string, expected: TermClass])[] = [
    ["java", "order", "domain"],
    ["java", "new", "keyword"],
    ["java", "default", "keyword"],
    // A contextual keyword is an identifier: Java's `record`, TypeScript's `type`.
    ["java", "type", "domain"],
    ["java", "record", "domain"],
    ["java", "get", "technical"],
    ["java", "bean", "technical"],
    ["java", "args", "technical"],
    ["java", "i", "short"],
    // Two letters are a word: `id`, `io` and `db` are never short.
    ["java", "id", "technical"],
    ["java", "io", "technical"],
    ["java", "db", "domain"],
    ["go", "type", "keyword"],
    ["go", "ctx", "technical"],
    ["go", "wg", "technical"],
    ["rust", "self", "keyword"],
    ["rust", "async", "keyword"],
    ["rust", "new", "technical"],
    ["rust", "vec", "technical"],
    ["rb", "end", "keyword"],
    ["rb", "begin", "keyword"],
    ["rb", "concern", "technical"],
    ["rb", "bean", "domain"],
    // A keyword the splitter can never yield whole classifies nothing:
    // the `file` of `upload_file` is not `__FILE__`.
    ["rb", "file", "domain"],
    ["rb", "defined", "domain"],
    ["php", "once", "domain"],
    ["clj", "monitor", "domain"],
    ["clj", "recur", "keyword"],
    ["ts", "type", "domain"],
    ["ts", "default", "keyword"],
    ["ts", "promise", "technical"],
    ["ts", "json", "technical"],
    ["csharp", "event", "keyword"],
    ["csharp", "string", "keyword"],
    ["csharp", "async", "technical"],
    ["csharp", "linq", "technical"],
    ["php", "list", "keyword"],
    ["python", "new", "technical"],
    ["ex", "changeset", "technical"],
    ["ex", "repo", "technical"],
  ];

  it.each(rows)("%s: %s is %s", (lang, token, expected) => {
    expect(createClassifier(lexiconOf(lang))(token)).toBe(expected);
  });
});

describe("short", () => {
  const classify = createClassifier(undefined);

  it("is one letter or digit, counted in code points, marks excluded", () => {
    for (const token of ["x", "𠀀", "ａ", "é", "注"]) expect(classify(token), token).toBe("short");
    for (const token of ["id", "io", "db", "注文"]) expect(classify(token), token).not.toBe("short");
  });
});

describe("the technical list", () => {
  it("is overridable whole; the profile's own words still apply", () => {
    const classify = createClassifier(lexiconOf("java"), ["order"]);
    expect(classify("order")).toBe("technical");
    expect(classify("get")).toBe("domain");
    expect(classify("bean")).toBe("technical");
    expect(classify("new")).toBe("keyword");
  });

  it("applies alone when there is no lexicon", () => {
    const classify = createClassifier(undefined);
    expect(classify("new")).toBe("technical");
    expect(classify("order")).toBe("domain");
  });
});

describe("DEFAULT_TECHNICAL", () => {
  it("is sorted, unique, and holds only words the splitter can yield", () => {
    expect([...DEFAULT_TECHNICAL]).toEqual([...new Set(DEFAULT_TECHNICAL)].sort());
    for (const word of DEFAULT_TECHNICAL) {
      expect(word, word).toMatch(WORD);
      expect(word, word).toBe(word.toLowerCase());
      // A one-letter word is short before it could be technical.
      expect([...word].length, word).toBeGreaterThan(1);
    }
  });

  it("holds the plan's seed list", () => {
    const seed = `get set is has to from of with by and or not new create build make init impl
      abstract base default util utils helper manager service repository controller handler
      factory provider dto dao entity model data info config exception error test mock spec
      com org net io src lib main app`.split(/\s+/);
    expect(DEFAULT_TECHNICAL).toEqual(expect.arrayContaining(seed));
  });

  // A profile's `technical` is the plumbing of THAT language, beyond the shared
  // list (METAMODEL §5.3): a word in both is one fact kept in two places.
  it.each(Object.keys(PROFILES).sort())("shares no word with %s's own list", (lang) => {
    const own = lexiconOf(lang).technical ?? [];
    expect(own.filter((word) => DEFAULT_TECHNICAL.includes(word))).toEqual([]);
  });
});

describe("properties", () => {
  const lexicons = fc.constantFrom(...Object.keys(PROFILES).sort()).map(lexiconOf);
  const token = fc.stringMatching(/^[a-z0-9é]{1,8}$/);

  it("calls a word a keyword only when the lexicon reserves that word", () => {
    fc.assert(
      fc.property(lexicons, token, (lexicon, word) => {
        const reserved = lexicon.keywords.map((keyword) => keyword.toLowerCase()).includes(word);
        expect(createClassifier(lexicon)(word) === "keyword").toBe(reserved);
      }),
    );
  });

  it("gives every shipped keyword that is a word the keyword class", () => {
    for (const lang of Object.keys(PROFILES)) {
      const lexicon = lexiconOf(lang);
      const classify = createClassifier(lexicon);
      for (const keyword of lexicon.keywords.filter((k) => WORD.test(k))) {
        expect(classify(keyword.toLowerCase()), `${lang} ${keyword}`).toBe("keyword");
      }
    }
  });
});
