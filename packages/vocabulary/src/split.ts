import type { Lexicon } from "@codegraph/core";

/**
 * The split (PLAN.md §20.1): one name → the words it is made of. The lexicon
 * says which names are conventional, which kinds are named by a file path or a
 * qualified path and whether an interface marker leads the name; every word
 * boundary is universal, so the algorithm knows no language.
 */

export interface SplitName {
  /** The name's words, lowercased, in the order the name spells them. */
  readonly tokens: readonly string[];
  /** How many of `tokens`, from the first, spell the qualifier (`AcmeOrder::` of `AcmeOrder::Order`). */
  readonly qualifier: number;
  /** Pieces made of digits only, dropped (`2024` of `promo#2024`). */
  readonly numeric: number;
  /** The whole name is one the language dictates (`toString`): it has no word. */
  readonly conventional: boolean;
}

const CONVENTIONAL: SplitName = Object.freeze({
  tokens: Object.freeze([]),
  qualifier: 0,
  numeric: 0,
  conventional: true,
});

/** Maximal runs of letters, marks and digits: every other character breaks a word. */
const PIECE = /[\p{L}\p{M}\p{N}]+/gu;
const UPPER = /^[\p{Lu}\p{Lt}]$/u;
const DIGIT = /^\p{N}$/u;
const MARK = /^\p{M}$/u;
const DIGITS_ONLY = /^\p{N}+$/u;
/** `I` + Upper + lower: `IOrderService`, never `IO` or `IOError`. */
const INTERFACE_PREFIX = /^I(?=[\p{Lu}\p{Lt}]\p{Ll})/u;

export function splitIdentifier(name: string, kind: string, lexicon: Lexicon | undefined): SplitName {
  if (lexicon?.conventional.includes(name) === true) return CONVENTIONAL;

  let text = name;
  if (lexicon?.fileKinds?.includes(kind) === true) text = dropExtension(text);
  let qualifier = "";
  let own = text;
  const separator = separatorOf(lexicon, kind);
  const cut = separator === undefined ? -1 : text.lastIndexOf(separator);
  if (separator !== undefined && cut >= 0) {
    qualifier = text.slice(0, cut);
    own = text.slice(cut + separator.length);
  }
  // Own-name rules read what follows the qualifier: `Acme.IOrder` names `Order`.
  if (lexicon?.interfacePrefix === true) own = own.replace(INTERFACE_PREFIX, "");

  const tokens: string[] = [];
  let numeric = 0;
  const push = (part: string): void => {
    for (const [piece] of part.matchAll(PIECE)) {
      for (const word of camelWords(piece)) {
        if (DIGITS_ONLY.test(word)) numeric += 1;
        // `toLowerCase` is locale-independent: a Turkish machine writes the same bytes.
        else tokens.push(word.toLowerCase());
      }
    }
  };
  push(qualifier);
  const qualifierTokens = tokens.length;
  push(own);
  return { tokens, qualifier: qualifierTokens, numeric, conventional: false };
}

/** An own key only: Java has a `constructor` kind, and every object inherits one. */
function separatorOf(lexicon: Lexicon | undefined, kind: string): string | undefined {
  const qualified = lexicon?.qualified;
  return qualified !== undefined && Object.hasOwn(qualified, kind) ? qualified[kind] : undefined;
}

/** The extension of the last path segment; a leading dot (`.eslintrc`) is not one. */
function dropExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 ? path.slice(0, dot) : path;
}

type Case = "upper" | "lower" | "digit";

/**
 * Camel-case boundaries on Unicode categories: lower → Upper, digit → Upper,
 * and an Upper run followed by Upper + lower splits before its last letter
 * (`HTTPServer` → HTTP, Server). A caseless letter (`𠀀`, `注`) counts as
 * lower; a mark takes the case of the letter it sits on, so it never splits.
 */
function camelWords(piece: string): string[] {
  const units: { text: string; kind: Case }[] = [];
  for (const char of piece) {
    const last = units.at(-1);
    if (MARK.test(char) && last !== undefined) last.text += char;
    else units.push({ text: char, kind: UPPER.test(char) ? "upper" : DIGIT.test(char) ? "digit" : "lower" });
  }

  const words: string[] = [];
  let word = "";
  units.forEach((unit, i) => {
    const prev = units[i - 1]?.kind;
    const next = units[i + 1]?.kind;
    const boundary =
      unit.kind === "upper" &&
      (prev === "lower" || prev === "digit" || (prev === "upper" && next === "lower"));
    if (boundary && word !== "") {
      words.push(word);
      word = "";
    }
    word += unit.text;
  });
  if (word !== "") words.push(word);
  return words;
}
