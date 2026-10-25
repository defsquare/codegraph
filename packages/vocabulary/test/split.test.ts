import { fileURLToPath } from "node:url";
import { getProfile, readModelFileSync, type Lexicon } from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitIdentifier } from "../src/split.js";

/**
 * The splitter (PLAN.md §20.1) turns ONE name into the words it is made of.
 * It knows no language: the lexicon brings the conventional names, the file
 * kinds and the interface prefix; every word boundary is universal. Each
 * table below is one language's idiom, read through that language's shipped
 * lexicon, so a lexicon edit that changes a split shows up here by name.
 */

function lexiconOf(lang: string): Lexicon {
  const lexicon = getProfile(lang)?.lexicon;
  if (lexicon === undefined) throw new Error(`${lang} ships no lexicon`);
  return lexicon;
}

/**
 * [kind, name, tokens, counts]; `null` tokens = a conventional name. `numeric`
 * counts the digit-only pieces dropped, `qualifier` the leading tokens that
 * spell the name's qualifier.
 */
type Row = readonly [
  kind: string,
  name: string,
  tokens: readonly string[] | null,
  counts?: { readonly numeric?: number; readonly qualifier?: number },
];

function check(lang: string | Lexicon | undefined, rows: readonly Row[]): void {
  const lexicon = typeof lang === "string" ? lexiconOf(lang) : lang;
  for (const [kind, name, tokens, { numeric = 0, qualifier = 0 } = {}] of rows) {
    it(`${kind} ${name}`, () => {
      const split = splitIdentifier(name, kind, lexicon);
      if (tokens === null) {
        expect(split).toEqual({ tokens: [], qualifier: 0, numeric: 0, conventional: true });
      } else {
        expect(split).toEqual({ tokens, qualifier, numeric, conventional: false });
      }
    });
  }
}

describe("camel case and acronyms, with no lexicon", () => {
  check(undefined, [
    ["class", "OrderManagerRepository", ["order", "manager", "repository"]],
    ["class", "HTTPServer", ["http", "server"]],
    ["method", "getURLString", ["get", "url", "string"]],
    ["class", "XMLHttpRequest", ["xml", "http", "request"]],
    ["class", "IO", ["io"]],
    ["class", "IOError", ["io", "error"]],
    ["field", "MAX_LINES", ["max", "lines"]],
    ["field", "x", ["x"]],
    // A digit run stays with the word before it; a digit then an upper case
    // letter is a camel boundary like any other.
    ["class", "Utf8Encoder", ["utf8", "encoder"]],
    ["method", "computeMd5", ["compute", "md5"]],
    ["class", "V2Api", ["v2", "api"]],
    ["class", "HTTP2Server", ["http2", "server"]],
    ["module", "i18n", ["i18n"]],
    ["class", "2FA", ["fa"], { numeric: 1 }],
    ["class", "Promo2024", ["promo2024"]],
    ["field", "line_2", ["line"], { numeric: 1 }],
    // Every character that is not a letter, a mark or a digit breaks a word.
    ["method", "->", []],
    ["method", "a--b", ["a", "b"]],
  ]);
});

describe("Unicode letters, not ASCII", () => {
  check(undefined, [
    ["class", "Résumé", ["résumé"]],
    ["property", "Naïve", ["naïve"]],
    // A decomposed é: the combining mark belongs to its letter, never a boundary.
    ["class", "RésuméLine", ["résumé", "line"]],
    ["class", "ＡFullwidth", ["ａ", "fullwidth"]],
    ["class", "𠀀Supplementary", ["𠀀", "supplementary"]],
    ["class", "注文明細", ["注文明細"]],
    // The token is lowercased as a word: a Greek word ends in ς.
    ["class", "ΟΔΟΣ", ["οδος"]],
    ["class", "TITLE", ["title"]],
  ]);
});

describe("Java", () => {
  check("java", [
    ["package", "com.acme.order", ["com", "acme", "order"], { qualifier: 2 }],
    ["class", "EmptyBasketException", ["empty", "basket", "exception"]],
    ["method", "notifyShipped", ["notify", "shipped"]],
    ["method", "toString", null],
    ["method", "hashCode", null],
    ["method", "main", null],
    ["attribute", "serialVersionUID", null],
    // Conventional is the WHOLE name: a word inside one is still a word.
    ["method", "toStringOrder", ["to", "string", "order"]],
  ]);
});

describe("C#", () => {
  check("csharp", [
    ["interface", "IOrderService", ["order", "service"]],
    ["interface", "IPriceable", ["priceable"]],
    ["method", "IsFree", ["is", "free"]],
    ["class", "IO", ["io"]],
    ["class", "IOError", ["io", "error"]],
    ["class", "Repository`1", ["repository"], { numeric: 1 }],
    ["namespace", "Acme.Order.Adapter", ["acme", "order", "adapter"], { qualifier: 2 }],
    ["method", "op_Addition", null],
    ["property", "this[]", null],
    ["method", "ToString", null],
  ]);
});

describe("TypeScript", () => {
  check("ts", [
    ["module", "legacy/acme-report.ts", ["legacy", "acme", "report"], { qualifier: 1 }],
    ["module", "packages/order/src/promo#2024.ts", ["packages", "order", "src", "promo"], { numeric: 1, qualifier: 3 }],
    ["module", "packages/order/src/ambient.d.ts", ["packages", "order", "src", "ambient", "d"], { qualifier: 3 }],
    ["module", "packages/order/src/ui/order-table.tsx", ["packages", "order", "src", "ui", "order", "table"], { qualifier: 4 }],
    ["module", "legacy-lib", ["legacy", "lib"]],
    // The extension is dropped for a FILE kind only.
    ["class", "legacy/acme.ts", ["legacy", "acme", "ts"]],
    ["property", "#secret", ["secret"]],
    ["property", "max.lines", ["max", "lines"]],
    ["method", "as.text", ["as", "text"]],
    ["function", "default", ["default"]],
    ["property", "[Symbol.iterator]", null],
    ["method", "constructor", null],
  ]);
});

describe("JavaScript", () => {
  check("js", [
    ["module", "src/app.mjs", ["src", "app"], { qualifier: 1 }],
    ["module", ".eslintrc", ["eslintrc"]],
    ["method", "toJSON", null],
  ]);
});

describe("Ruby", () => {
  check("rb", [
    ["class", "AcmeOrder::Order::Line", ["acme", "order", "order", "line"], { qualifier: 3 }],
    ["constant", "AcmeOrder::Order::MAX_LINES", ["acme", "order", "order", "max", "lines"], { qualifier: 3 }],
    ["method", "valid?", ["valid"]],
    ["method", "save!", ["save"]],
    ["method", "name=", ["name"]],
    ["field", "@total", ["total"]],
    ["file", "lib/acme_order/promo#2024.rb", ["lib", "acme", "order", "promo"], { numeric: 1, qualifier: 3 }],
    ["file", "Gemfile", ["gemfile"]],
    ["file", "acme_order.gemspec", ["acme", "order"]],
    ["method", "<=>", null],
    ["method", "to_s", null],
    ["method", "initialize", null],
    ["method", "respond_to_missing?", null],
  ]);
});

describe("Elixir", () => {
  check("ex", [
    // A module's dots are not an extension: `module` is not a file kind here.
    ["module", "AcmeOrder.Notifier.Sms.Gateway", ["acme", "order", "notifier", "sms", "gateway"], { qualifier: 4 }],
    ["file", "lib/acme_order/notifier.ex", ["lib", "acme", "order", "notifier"], { qualifier: 3 }],
    ["file", "test/acme_order/order_test.exs", ["test", "acme", "order", "order", "test"], { qualifier: 3 }],
    ["function", "available?", ["available"]],
    ["function", "fail!", ["fail"]],
    ["attribute", "@max_lines", ["max", "lines"]],
    ["function", "handle_call", null],
    ["function", "start_link", null],
    ["macro", "__using__", null],
    ["attribute", "@moduledoc", null],
  ]);
});

describe("Python", () => {
  check("python", [
    ["function", "parse_http_response", ["parse", "http", "response"]],
    ["class", "HTTPClient", ["http", "client"]],
    ["method", "__init__", null],
    ["parameter", "self", null],
    ["method", "__private_total", ["private", "total"]],
  ]);
});

describe("Go", () => {
  check("go", [
    ["func", "NewOrderService", ["new", "order", "service"]],
    ["struct", "httpServer", ["http", "server"]],
    ["method", "String", null],
    ["method", "ServeHTTP", null],
  ]);
});

describe("Rust", () => {
  check("rust", [
    ["struct", "HttpServer", ["http", "server"]],
    ["function", "as_str", ["as", "str"]],
    ["method", "fmt", null],
    ["method", "into_iter", null],
  ]);
});

describe("PHP", () => {
  check("php", [
    ["codeFile", "src/Order/OrderRepository.php", ["src", "order", "order", "repository"], { qualifier: 2 }],
    ["namespace", "App\\Order", ["app", "order"], { qualifier: 1 }],
    ["property", "$orderTotal", ["order", "total"]],
    ["method", "__construct", null],
    ["method", "__toString", null],
  ]);
});

describe("Clojure", () => {
  check("clj", [
    ["function", "->Order", ["order"]],
    ["function", "order-total", ["order", "total"]],
    ["function", "valid?", ["valid"]],
    ["var", "*out*", ["out"]],
    ["namespace", "acme.order.core", ["acme", "order", "core"], { qualifier: 2 }],
    ["function", "-main", null],
  ]);
});

// The words before a qualified kind's LAST separator name its container: they
// are still words, and the split says how many lead the list.
describe("qualified names", () => {
  describe("in the shipped lexicons", () => {
    check("rb", [
      ["module", "AcmeOrder", ["acme", "order"]],
      // `::` is the separator: one colon is a break between words, nothing more.
      ["class", "Order:Line", ["order", "line"]],
      ["class", "AcmeOrder::", ["acme", "order"], { qualifier: 2 }],
      ["file", "lib/2024/order.rb", ["lib", "order"], { numeric: 1, qualifier: 1 }],
      ["method", "AcmeOrder::Order.create", ["acme", "order", "order", "create"]],
    ]);
    check("ex", [
      ["protocol", "AcmeOrder.Priceable", ["acme", "order", "priceable"], { qualifier: 2 }],
      ["module", "AcmeOrder.Priceable.AcmeOrder.Money", ["acme", "order", "priceable", "acme", "order", "money"], { qualifier: 5 }],
      ["module", "legacy.mod", ["legacy", "mod"], { qualifier: 1 }],
      ["attribute", "@max_lines", ["max", "lines"]],
    ]);
  });

  describe("by own kind only", () => {
    // `constructor` is a Java kind and a key every object inherits: read as an
    // inherited key, `Object` itself would be the separator, spelled as its source.
    check({ keywords: [], conventional: [], qualified: { package: "." } }, [
      ["constructor", "function Object() { [native code] }", ["function", "object", "native", "code"]],
    ]);
  });

  describe("with an interface prefix", () => {
    // The marker leads the entity's OWN name, after its qualifier.
    check({ keywords: [], conventional: [], qualified: { interface: "." }, interfacePrefix: true }, [
      ["interface", "Acme.IOrder", ["acme", "order"], { qualifier: 1 }],
      ["interface", "IOrder", ["order"]],
    ]);
  });
});

describe("the unicode fixture through the splitter", () => {
  // fixtures/unicode exists to break code-unit assumptions: a fullwidth letter
  // and a supplementary-plane letter (a surrogate pair in UTF-16).
  const model = readModelFileSync(
    fileURLToPath(new URL("../../../fixtures/unicode/expected/model.jsonl", import.meta.url)),
  );
  const lexicon = lexiconOf(model.lang);
  const split = (name: string, kind: string): readonly string[] =>
    splitIdentifier(name, kind, lexicon).tokens;

  it("splits and lowercases every name without a replacement character", () => {
    const names = model.entities.map((entity) => {
      const name = (entity as Record<string, unknown>)["name"];
      if (typeof name !== "string") throw new Error(`${entity.id} has no name`);
      return [name, split(name, entity.kind)] as const;
    });
    expect(Object.fromEntries(names)).toEqual({
      sorting: ["sorting"],
      Ascii: ["ascii"],
      "𠀀Supplementary": ["𠀀", "supplementary"],
      ＡFullwidth: ["ａ", "fullwidth"],
    });
    for (const [, tokens] of names) {
      for (const token of tokens) {
        expect(token).not.toContain("�");
        // With the u flag, \p{Cs} matches only a surrogate left without its pair.
        expect(token).not.toMatch(/\p{Cs}/u);
      }
    }
  });
});

describe("properties", () => {
  // Identifiers the grammars admit, plus the characters that break them. Σ is
  // left out: its lower case depends on what follows it, so a token's lower
  // case and its slice of the lowered name may differ (pinned by hand above).
  const CHARS = [
    ..."abcdefghijklmnopqrstuvwxyz",
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ..."0123456789",
    ..."_-.:/?!@$#`*[]=<> ",
    "é",
    "É",
    "́",
    "ß",
    "Ａ",
    "𠀀",
    "注",
    "ǅ",
    "İ",
  ];
  const identifier = fc.array(fc.constantFrom(...CHARS), { maxLength: 24 }).map((cs) => cs.join(""));
  const separator = fc.constantFrom(..."_-.:/?!@$#`*[]=<> ");
  const lexicons = fc.constantFrom<Lexicon | undefined>(
    undefined,
    lexiconOf("java"),
    lexiconOf("csharp"),
    lexiconOf("ts"),
    lexiconOf("rb"),
    lexiconOf("ex"),
  );
  const kinds = fc.constantFrom("class", "module", "file", "method");
  const WORD = /^[\p{L}\p{M}\p{N}]+$/u;

  it("yields non-empty lowercase words, each a slice of the lowered name", () => {
    fc.assert(
      fc.property(identifier, kinds, lexicons, (name, kind, lexicon) => {
        for (const token of splitIdentifier(name, kind, lexicon).tokens) {
          expect(token).toMatch(WORD);
          expect(token).toBe(token.toLowerCase());
          expect(name.toLowerCase()).toContain(token);
          expect(token).not.toMatch(/^\p{N}+$/u);
        }
      }),
    );
  });

  it("is a function of its inputs", () => {
    fc.assert(
      fc.property(identifier, kinds, lexicons, (name, kind, lexicon) => {
        expect(splitIdentifier(name, kind, lexicon)).toEqual(splitIdentifier(name, kind, lexicon));
      }),
    );
  });

  it("splits a + separator + b into the words of a, then the words of b", () => {
    // Without a lexicon: a file kind's extension, the interface prefix and a
    // conventional name all look at the WHOLE name, not at its parts.
    fc.assert(
      fc.property(identifier, separator, identifier, (a, sep, b) => {
        const left = splitIdentifier(a, "class", undefined);
        const right = splitIdentifier(b, "class", undefined);
        expect(splitIdentifier(a + sep + b, "class", undefined)).toEqual({
          tokens: [...left.tokens, ...right.tokens],
          qualifier: 0,
          numeric: left.numeric + right.numeric,
          conventional: false,
        });
      }),
    );
  });

  // Qualification decides which words weigh as a container's, never which
  // words there are. C# is left out: its interface prefix reads the own name.
  it("moves no word: the same split with the qualified kinds removed", () => {
    const plain = fc.constantFrom(lexiconOf("java"), lexiconOf("ts"), lexiconOf("rb"), lexiconOf("ex"), lexiconOf("php"));
    const anyKind = fc.constantFrom("class", "module", "file", "package", "constant", "protocol", "method");
    fc.assert(
      fc.property(identifier, anyKind, plain, (name, kind, lexicon) => {
        const { qualifier, ...split } = splitIdentifier(name, kind, lexicon);
        const { qualifier: none, ...unqualified } = splitIdentifier(name, kind, { ...lexicon, qualified: undefined });
        expect(split).toEqual(unqualified);
        expect(none).toBe(0);
        expect(qualifier).toBeLessThanOrEqual(split.tokens.length);
        if (lexicon.qualified?.[kind] === undefined) expect(qualifier).toBe(0);
      }),
    );
  });

  it("counts as the qualifier the words before the last separator", () => {
    const cases = fc.constantFrom(["rb", "class", "::"], ["ex", "module", "."], ["java", "package", "."]) ;
    fc.assert(
      fc.property(cases, identifier, identifier, ([lang, kind, sep], a, b) => {
        fc.pre(!b.includes(sep));
        const split = splitIdentifier(a + sep + b, kind, lexiconOf(lang));
        fc.pre(!split.conventional);
        const left = splitIdentifier(a, kind, undefined);
        const right = splitIdentifier(b, kind, undefined);
        expect(split.tokens).toEqual([...left.tokens, ...right.tokens]);
        expect(split.qualifier).toBe(left.tokens.length);
      }),
    );
  });

  it("gives a conventional name no word at all", () => {
    const java = lexiconOf("java");
    fc.assert(
      fc.property(fc.constantFrom(...java.conventional), kinds, (name, kind) => {
        expect(splitIdentifier(name, kind, java)).toEqual({ tokens: [], qualifier: 0, numeric: 0, conventional: true });
      }),
    );
  });
});
