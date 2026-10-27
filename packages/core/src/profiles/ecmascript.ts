import type { Lexicon } from "../profile.js";

/**
 * The words JavaScript and TypeScript share: TypeScript reserves exactly
 * ECMAScript's words — `type`, `namespace`, `declare`, `readonly` and the rest
 * of its own vocabulary are contextual, hence identifiers. One statement, read
 * by both profiles, so the two cannot drift apart.
 */
export const ECMASCRIPT_LEXICON = {
  // ECMA-262, Keywords and Reserved Words (ReservedWord), plus the words strict mode — every
  // module — reserves.
  keywords: [
    "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function",
    "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this",
    "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "implements",
    "interface", "let", "package", "private", "protected", "public", "static",
  ],
  // The constructor, `Object.prototype`'s overrides, `JSON.stringify`'s hook, and
  // the well-known symbols' methods, spelled as the extractor names them.
  conventional: [
    "constructor", "toString", "toLocaleString", "valueOf", "toJSON", "[Symbol.iterator]",
    "[Symbol.asyncIterator]", "[Symbol.hasInstance]", "[Symbol.toPrimitive]",
    "[Symbol.toStringTag]", "[Symbol.dispose]", "[Symbol.asyncDispose]",
  ],
  technical: [
    "args", "async", "callback", "cb", "fn", "json", "opts", "promise", "prototype",
  ],
} as const satisfies Lexicon;
