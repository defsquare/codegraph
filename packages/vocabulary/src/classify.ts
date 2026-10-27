import type { Lexicon } from "@codegraph/core";
import { splitIdentifier } from "./split.js";

/**
 * The classes (PLAN.md §20.1): every word is kept and tagged, never filtered —
 * drift needs the technical words too, and "not shown" must stay
 * distinguishable from "not there".
 */

export const TERM_CLASSES = ["domain", "technical", "keyword", "short"] as const;
export type TermClass = (typeof TERM_CLASSES)[number];

/**
 * Plumbing every language shares. Contestable by construction, which is why
 * it is data in one place, overridable whole, and the artifact names the list
 * it used. A language's own plumbing (Java's `bean`, Ruby's `concern`) is its
 * profile's `lexicon.technical`, never repeated here.
 */
export const DEFAULT_TECHNICAL: readonly string[] = Object.freeze([
  "abstract", "adapter", "add", "and", "api", "app", "arg", "args", "as", "async",
  "at", "base", "build", "builder", "by", "callback", "can", "cli", "com", "common",
  "config", "configuration", "context", "controller", "core", "create", "ctx", "dao", "data", "default",
  "delete", "dto", "entity", "env", "err", "error", "errors", "exception", "extension", "extensions",
  "factory", "fake", "fetch", "field", "find", "fixture", "for", "from", "generic", "get",
  "handle", "handler", "has", "helper", "helpers", "http", "id", "impl", "in", "index",
  "info", "init", "into", "io", "is", "json", "key", "lib", "listener", "load",
  "main", "make", "manager", "map", "misc", "mixin", "mock", "model", "mutex", "name",
  "net", "new", "not", "obj", "of", "on", "options", "opts", "or", "org",
  "param", "params", "property", "provider", "proxy", "read", "remove", "repo", "repository", "req",
  "request", "res", "resp", "response", "result", "run", "save", "serializer", "service", "set",
  "settings", "setup", "shared", "should", "spec", "src", "str", "stub", "teardown", "temp",
  "test", "tests", "tmp", "to", "type", "update", "uri", "url", "util", "utils",
  "uuid", "val", "value", "visitor", "with", "worker", "wrapper", "xml",
]);

export type Classify = (token: string) => TermClass;

const WORD = /^[\p{L}\p{M}\p{N}]+$/u;
const MARK = /\p{M}/u;

/**
 * Decides, in this order: `keyword` (the lexicon reserves the word), `short`
 * (one letter or digit), `technical` (the shared list ∪ the profile's), else
 * `domain`. A keyword the splitter never yields whole (`defined?`, `__FILE__`)
 * classifies nothing: the `file` of `upload_file` is not `__FILE__`.
 */
export function createClassifier(
  lexicon: Lexicon | undefined,
  technical: readonly string[] = DEFAULT_TECHNICAL,
): Classify {
  const keywords = new Set(
    (lexicon?.keywords ?? []).map((keyword) => keyword.toLowerCase()).filter((keyword) => WORD.test(keyword)),
  );
  const plumbing = new Set([...technical, ...(lexicon?.technical ?? [])]);
  return (token) => {
    if (keywords.has(token)) return "keyword";
    if (isShort(token)) return "short";
    if (plumbing.has(token)) return "technical";
    return "domain";
  };
}

/** One code point that is not a mark: `x`, `𠀀`, a decomposed `é`. */
function isShort(token: string): boolean {
  let letters = 0;
  for (const char of token) if (!MARK.test(char) && ++letters > 1) return false;
  return true;
}

/**
 * A technical list as a file holds it (`--technical FILE`): one word per line,
 * lowercased as the splitter lowers a token; blank lines and `#` comments
 * skipped. A line that is not one word could never match a token, so it is
 * refused by its line number rather than kept.
 */
export function parseTechnicalWords(text: string): {
  readonly words: readonly string[];
  readonly invalid: readonly { readonly line: number; readonly text: string }[];
} {
  const words: string[] = [];
  const invalid: { line: number; text: string }[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const { tokens } = splitIdentifier(line, "", undefined);
    const [word] = tokens;
    if (tokens.length === 1 && word !== undefined && WORD.test(line)) words.push(word);
    else invalid.push({ line: i + 1, text: line });
  });
  return { words, invalid };
}
