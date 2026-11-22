import {
  EDGE_KINDS,
  PROFILES,
  TRAIT_NAMES,
  getProfile,
  type EdgeKind,
  type Entity,
  type EntityId,
  type TraitName,
} from "@codegraph/core";
import { folderFor } from "./fold.js";
import { entityName, type CodeGraph } from "./graph.js";
import { compareIds } from "./order.js";
import { identityView, includesEdge, type View, type ViewDescriptor } from "./views.js";

/**
 * SELECTORS (PLAN §22.3): which entities a filter names. One AST, two surface
 * forms — a TERM of text (`edge:annotationUse>name:Audited`, one flag value)
 * and JSON (`{ "any": [...] }`, what a definition file embeds). The vocabulary
 * is core's: an unknown kind, trait, edge kind or language is an error that
 * lists the valid names, never a silent empty match.
 *
 * A selector matches the ENTITY ITSELF. Nothing is folded: a type does not
 * "have" its methods' invocations, and a module does not contain its types
 * here — what a filter means for a walk (the nearest-container rule) is the
 * caller's business.
 */

/** The text prefixes, closed. A term is `PREFIX:PAYLOAD`. */
export const SELECTOR_TERMS = ["id", "kind", "trait", "lang", "name", "module", "file", "edge", "edge-in"] as const;
export type SelectorTerm = (typeof SELECTOR_TERMS)[number];

/** The keys of a JSON selector node, closed: one per node. */
const JSON_KEYS = ["id", "kind", "trait", "lang", "name", "module", "file", "edge", "edgeIn", "all", "any", "not"] as const;

export interface IdSelector {
  readonly type: "id";
  /** A rendered id, compared as an opaque token — never parsed (CLAUDE.md invariant 7). */
  readonly id: EntityId;
}
export interface KindSelector {
  readonly type: "kind";
  readonly kind: string;
}
export interface TraitSelector {
  readonly type: "trait";
  readonly trait: TraitName;
}
export interface LangSelector {
  readonly type: "lang";
  readonly lang: string;
}
/** `*` matches within one segment, `**` across segments; nothing else is special. */
export interface GlobSelector {
  readonly type: "name" | "module" | "file";
  readonly glob: string;
}
/** The entity WRITES an edge of `kind` (to an entity matching `to`). */
export interface EdgeSelector {
  readonly type: "edge";
  readonly kind: EdgeKind;
  readonly to?: Selector;
}
/** An edge of `kind` points AT the entity (from an entity matching `from`). */
export interface EdgeInSelector {
  readonly type: "edgeIn";
  readonly kind: EdgeKind;
  readonly from?: Selector;
}
export interface AllSelector {
  readonly type: "all";
  readonly of: readonly Selector[];
}
export interface AnySelector {
  readonly type: "any";
  readonly of: readonly Selector[];
}
export interface NotSelector {
  readonly type: "not";
  readonly of: Selector;
}

export type Selector =
  | IdSelector
  | KindSelector
  | TraitSelector
  | LangSelector
  | GlobSelector
  | EdgeSelector
  | EdgeInSelector
  | AllSelector
  | AnySelector
  | NotSelector;

/** The JSON form, as `selectorToJson` writes it and `parseSelector` reads it. */
export type SelectorJson =
  | { readonly id: string }
  | { readonly kind: string }
  | { readonly trait: string }
  | { readonly lang: string }
  | { readonly name: string }
  | { readonly module: string }
  | { readonly file: string }
  | { readonly edge: { readonly kind: string; readonly to?: SelectorJson } }
  | { readonly edgeIn: { readonly kind: string; readonly from?: SelectorJson } }
  | { readonly all: readonly SelectorJson[] }
  | { readonly any: readonly SelectorJson[] }
  | { readonly not: SelectorJson };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The closed set of fault codes. Consumers match on these, not on messages. */
export const SELECTOR_ERROR_CODES = [
  "unknown-term",
  "empty",
  "unknown-kind",
  "unknown-trait",
  "unknown-edge-kind",
  "unknown-lang",
  "not-an-object",
  "one-key",
  "unknown-key",
  "missing-key",
  "wrong-type",
] as const;
export type SelectorErrorCode = (typeof SELECTOR_ERROR_CODES)[number];

export class SelectorError extends Error {
  readonly code: SelectorErrorCode;
  /** Where in the JSON the fault is (`any[1].edge.kind`); `""` at the root and for a text term. */
  readonly path: string;
  /** The vocabulary the faulty value was checked against; empty when none applies. */
  readonly valid: readonly string[];

  constructor(code: SelectorErrorCode, message: string, path = "", valid: readonly string[] = []) {
    super(message);
    this.name = "SelectorError";
    this.code = code;
    this.path = path;
    this.valid = valid;
  }
}

// ---------------------------------------------------------------------------
// Vocabulary — core's, never restated
// ---------------------------------------------------------------------------

/** Every kind some profile declares: a selector does not know its model's language when parsed. */
const KINDS: readonly string[] = [
  ...new Set(Object.values(PROFILES).flatMap((profile) => Object.keys(profile.kinds))),
].sort(compareIds);
const LANGS: readonly string[] = Object.keys(PROFILES).sort(compareIds);

const KIND_SET: ReadonlySet<string> = new Set(KINDS);
const LANG_SET: ReadonlySet<string> = new Set(LANGS);
const TRAIT_SET: ReadonlySet<string> = new Set(TRAIT_NAMES);
const EDGE_SET: ReadonlySet<string> = new Set(EDGE_KINDS);
const TERM_SET: ReadonlySet<string> = new Set(SELECTOR_TERMS);

/** `where` names the fault's place: the JSON path, or the text term it sits in. */
function checkName<T extends string>(
  value: string,
  set: ReadonlySet<string>,
  valid: readonly string[],
  code: SelectorErrorCode,
  what: string,
  where: string,
  path: string,
  hint = "",
): T {
  if (set.has(value)) return value as T;
  throw new SelectorError(code, `${where}: unknown ${what} "${value}"${hint}; valid: ${valid.join(", ")}`, path, valid);
}

const checkKind = (v: string, where: string, path = ""): string =>
  checkName(v, KIND_SET, KINDS, "unknown-kind", "kind", where, path);
const checkTrait = (v: string, where: string, path = ""): TraitName =>
  checkName<TraitName>(v, TRAIT_SET, TRAIT_NAMES, "unknown-trait", "trait", where, path);
const checkLang = (v: string, where: string, path = ""): string =>
  checkName(v, LANG_SET, LANGS, "unknown-lang", "lang", where, path);
const checkEdgeKind = (v: string, where: string, path = "", hint = ""): EdgeKind =>
  checkName<EdgeKind>(v, EDGE_SET, EDGE_KINDS, "unknown-edge-kind", "edge kind", where, path, hint);

// ---------------------------------------------------------------------------
// Text form
// ---------------------------------------------------------------------------

/**
 * One term of text: `PREFIX:PAYLOAD`, split at the FIRST `:` (no prefix holds
 * one). `id:` and the glob payloads run verbatim to the end. `edge:KIND>TERM`
 * splits at the first `>` and `edge-in:KIND<TERM` at the first `<` — no edge
 * kind holds either — and the nested TERM is parsed whole, so it may nest again.
 */
export function parseTerm(text: string): Selector {
  return parseTermIn(text, `"${text}"`);
}

function parseTermIn(text: string, where: string): Selector {
  const colon = text.indexOf(":");
  const prefix = colon < 0 ? text : text.slice(0, colon);
  if (colon < 0 || !TERM_SET.has(prefix)) {
    const terms = SELECTOR_TERMS.map((term) => `${term}:`);
    throw new SelectorError(
      "unknown-term",
      `${where}: ${colon < 0 ? "a term is PREFIX:VALUE" : `unknown term "${prefix}:"`}; valid: ${terms.join(", ")}`,
      "",
      terms,
    );
  }
  const payload = text.slice(colon + 1);
  if (payload === "") throw new SelectorError("empty", `${where}: "${prefix}:" needs a value`);
  switch (prefix as SelectorTerm) {
    case "id":
      return { type: "id", id: payload };
    case "kind":
      return { type: "kind", kind: checkKind(payload, where) };
    case "trait":
      return { type: "trait", trait: checkTrait(payload, where) };
    case "lang":
      return { type: "lang", lang: checkLang(payload, where) };
    case "name":
    case "module":
    case "file":
      return { type: prefix as GlobSelector["type"], glob: payload };
    case "edge": {
      const [kindText, nested] = splitAt(payload, ">");
      const hint = kindText.includes("<") ? ' (an incoming edge is "edge-in:KIND<TERM")' : "";
      const kind = checkEdgeKind(kindText, where, "", hint);
      if (nested === undefined) return { type: "edge", kind };
      if (nested === "") throw new SelectorError("empty", `${where}: "edge:${kind}>" needs a term after ">"`);
      return { type: "edge", kind, to: parseTermIn(nested, where) };
    }
    case "edge-in": {
      const [kindText, nested] = splitAt(payload, "<");
      const hint = kindText.includes(">") ? ' (an outgoing edge is "edge:KIND>TERM")' : "";
      const kind = checkEdgeKind(kindText, where, "", hint);
      if (nested === undefined) return { type: "edgeIn", kind };
      if (nested === "") throw new SelectorError("empty", `${where}: "edge-in:${kind}<" needs a term after "<"`);
      return { type: "edgeIn", kind, from: parseTermIn(nested, where) };
    }
  }
}

function splitAt(text: string, separator: string): readonly [string, string | undefined] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

/** The text of a selector, or `undefined` when it has none (all/any/not, at any depth). */
export function formatTerm(selector: Selector): string | undefined {
  switch (selector.type) {
    case "id":
      return `id:${selector.id}`;
    case "kind":
      return `kind:${selector.kind}`;
    case "trait":
      return `trait:${selector.trait}`;
    case "lang":
      return `lang:${selector.lang}`;
    case "name":
    case "module":
    case "file":
      return `${selector.type}:${selector.glob}`;
    case "edge": {
      if (selector.to === undefined) return `edge:${selector.kind}`;
      const to = formatTerm(selector.to);
      return to === undefined ? undefined : `edge:${selector.kind}>${to}`;
    }
    case "edgeIn": {
      if (selector.from === undefined) return `edge-in:${selector.kind}`;
      const from = formatTerm(selector.from);
      return from === undefined ? undefined : `edge-in:${selector.kind}<${from}`;
    }
    case "all":
    case "any":
    case "not":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// JSON form
// ---------------------------------------------------------------------------

export function selectorToJson(selector: Selector): SelectorJson {
  switch (selector.type) {
    case "id":
      return { id: selector.id };
    case "kind":
      return { kind: selector.kind };
    case "trait":
      return { trait: selector.trait };
    case "lang":
      return { lang: selector.lang };
    case "name":
      return { name: selector.glob };
    case "module":
      return { module: selector.glob };
    case "file":
      return { file: selector.glob };
    case "edge":
      return selector.to === undefined
        ? { edge: { kind: selector.kind } }
        : { edge: { kind: selector.kind, to: selectorToJson(selector.to) } };
    case "edgeIn":
      return selector.from === undefined
        ? { edgeIn: { kind: selector.kind } }
        : { edgeIn: { kind: selector.kind, from: selectorToJson(selector.from) } };
    case "all":
      return { all: selector.of.map(selectorToJson) };
    case "any":
      return { any: selector.of.map(selectorToJson) };
    case "not":
      return { not: selectorToJson(selector.of) };
  }
}

export interface ParseSelectorOptions {
  /** The selector's own place in an enclosing document (`select`), prefixed to every fault's path. */
  readonly path?: string;
}

/** Validate a JSON selector by hand (no zod here); a fault names its path. */
export function parseSelector(json: unknown, options: ParseSelectorOptions = {}): Selector {
  return parseNode(json, options.path ?? "");
}

const key = (path: string, name: string): string => (path === "" ? name : `${path}.${name}`);
const at = (path: string): string => (path === "" ? "selector" : path);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? `the string ${JSON.stringify(value)}` : `a ${typeof value}`;
}

function parseNode(json: unknown, path: string): Selector {
  if (!isPlainObject(json)) {
    throw new SelectorError(
      "not-an-object",
      `${at(path)}: a selector is an object with one key (${JSON_KEYS.join(", ")}); got ${describeValue(json)}`,
      path,
      JSON_KEYS,
    );
  }
  const keys = Object.keys(json);
  if (keys.length !== 1) {
    throw new SelectorError(
      "one-key",
      `${at(path)}: a selector has exactly one key (${JSON_KEYS.join(", ")}); got ${keys.length}${keys.length === 0 ? "" : ` (${keys.join(", ")})`}`,
      path,
      JSON_KEYS,
    );
  }
  const name = keys[0] as string;
  const value = json[name];
  const here = key(path, name);
  switch (name) {
    case "id":
      return { type: "id", id: stringAt(value, here) };
    case "kind":
      return { type: "kind", kind: checkKind(stringAt(value, here), here, here) };
    case "trait":
      return { type: "trait", trait: checkTrait(stringAt(value, here), here, here) };
    case "lang":
      return { type: "lang", lang: checkLang(stringAt(value, here), here, here) };
    case "name":
    case "module":
    case "file":
      return { type: name, glob: stringAt(value, here) };
    case "edge": {
      const { kind, nested } = edgeAt(value, here, "to");
      return nested === undefined ? { type: "edge", kind } : { type: "edge", kind, to: nested };
    }
    case "edgeIn": {
      const { kind, nested } = edgeAt(value, here, "from");
      return nested === undefined ? { type: "edgeIn", kind } : { type: "edgeIn", kind, from: nested };
    }
    case "all":
    case "any":
      return { type: name, of: arrayAt(value, here).map((member, i) => parseNode(member, `${here}[${i}]`)) };
    case "not":
      return { type: "not", of: parseNode(value, here) };
    default:
      throw new SelectorError(
        "unknown-key",
        `${at(path)}: unknown selector key "${name}"; valid: ${JSON_KEYS.join(", ")}`,
        path,
        JSON_KEYS,
      );
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new SelectorError("wrong-type", `${path}: expected a string, got ${describeValue(value)}`, path);
  }
  if (value === "") throw new SelectorError("empty", `${path}: must not be empty`, path);
  return value;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new SelectorError("wrong-type", `${path}: expected an array of selectors, got ${describeValue(value)}`, path);
  }
  return value;
}

/** `{ kind, to? }` for `edge`, `{ kind, from? }` for `edgeIn` — no other key. */
function edgeAt(
  value: unknown,
  path: string,
  nestedKey: "to" | "from",
): { readonly kind: EdgeKind; readonly nested: Selector | undefined } {
  const allowed = ["kind", nestedKey];
  if (!isPlainObject(value)) {
    throw new SelectorError(
      "wrong-type",
      `${path}: expected an object { ${allowed.join(", ")} }, got ${describeValue(value)}`,
      path,
      allowed,
    );
  }
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) {
      const here = key(path, name);
      throw new SelectorError("unknown-key", `${here}: unknown key "${name}"; valid: ${allowed.join(", ")}`, here, allowed);
    }
  }
  const kindPath = key(path, "kind");
  if (!Object.hasOwn(value, "kind")) {
    throw new SelectorError("missing-key", `${kindPath}: required; valid: ${EDGE_KINDS.join(", ")}`, kindPath, EDGE_KINDS);
  }
  const kind = checkEdgeKind(stringAt(value["kind"], kindPath), kindPath, kindPath);
  const nested = Object.hasOwn(value, nestedKey) ? parseNode(value[nestedKey], key(path, nestedKey)) : undefined;
  return { kind, nested };
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\/]/g;
const escapeRegex = (text: string): string => text.replace(REGEX_SYNTAX, "\\$&");

type GlobToken = { readonly star: 1 | 2 } | { readonly text: string };

function tokenize(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (const run of glob.match(/\*+|[^*]+/g) ?? []) {
    tokens.push(run.startsWith("*") ? { star: run.length === 1 ? 1 : 2 } : { text: run });
  }
  return tokens;
}

/**
 * The whole text must match. With no separator the text is one segment, so
 * `*` and `**` coincide. A `**` that fills whole segments (between two
 * separators, or before one at the start) also stands for NO segment, as a
 * shell globstar does: `a/STARSTAR/b` matches `a/b`.
 */
function globRegex(glob: string, separator: string): RegExp {
  const sep = escapeRegex(separator);
  const inSegment = separator === "" ? "[\\s\\S]*" : `(?:(?!${sep})[\\s\\S])*`;
  const tokens = tokenize(glob);
  let source = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as GlobToken;
    if ("text" in token) {
      source += escapeRegex(token.text);
      continue;
    }
    if (token.star === 1) {
      source += inSegment;
      continue;
    }
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    const startsSegment = previous === undefined || ("text" in previous && previous.text.endsWith(separator));
    if (separator !== "" && startsSegment && next !== undefined && "text" in next && next.text.startsWith(separator)) {
      source += `(?:[\\s\\S]*${sep})?`;
      tokens[i + 1] = { text: next.text.slice(separator.length) };
    } else {
      source += "[\\s\\S]*";
    }
  }
  return new RegExp(`^${source}$`);
}

/** One glob, compiled once per separator it meets. */
class Glob {
  private readonly compiled = new Map<string, RegExp>();
  constructor(private readonly glob: string) {}

  test(text: string, separator: string): boolean {
    let regex = this.compiled.get(separator);
    if (regex === undefined) {
      regex = globRegex(this.glob, separator);
      this.compiled.set(separator, regex);
    }
    return regex.test(text);
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** A compiled selector over one graph and one view. */
export interface SelectorMatcher {
  readonly selector: Selector;
  /** The view edges were read through: a match set without its view is not a fact. */
  readonly view: ViewDescriptor;
  /** False for an id the graph does not declare or the view drops. */
  matches(id: EntityId): boolean;
  /** Every match, in `compareIds` order. */
  matchingIds(): readonly EntityId[];
}

/** Every node is evaluated on an entity the graph declares and the view keeps. */
type Matcher = (id: EntityId, entity: Entity) => boolean;

/** The language of the model that declares each id — first declaration wins, as in `buildGraph`. */
const LANGS_BY_GRAPH = new WeakMap<CodeGraph, ReadonlyMap<EntityId, string>>();

function langsOf(graph: CodeGraph): ReadonlyMap<EntityId, string> {
  const cached = LANGS_BY_GRAPH.get(graph);
  if (cached !== undefined) return cached;
  const langs = new Map<EntityId, string>();
  for (const model of graph.union.models) {
    for (const entity of model.entities) if (!langs.has(entity.id)) langs.set(entity.id, model.lang);
  }
  LANGS_BY_GRAPH.set(graph, langs);
  return langs;
}

function anchorFile(entity: Entity): string | undefined {
  const anchor = (entity as Record<string, unknown>)["anchor"];
  if (typeof anchor !== "object" || anchor === null) return undefined;
  const file = (anchor as Record<string, unknown>)["file"];
  return typeof file === "string" ? file : undefined;
}

/**
 * Compile once, evaluate per entity. A selector matches within the view's
 * projection (`projectView`): an entity the view drops matches nothing, and an
 * edge term sees only what `includesEdge` keeps, read from `outgoing` or the
 * derived `incoming`. Edge nodes memoize per id, so nesting stays linear.
 */
export function compileSelector(selector: Selector, graph: CodeGraph, view: View = identityView): SelectorMatcher {
  validate(selector);
  const folder = folderFor(graph);

  /** The qualifier separator core's profile states for this entity's kind; none = one segment. */
  const separatorOf = (id: EntityId, entity: Entity): string => {
    const lang = langsOf(graph).get(id);
    const qualified = lang === undefined ? undefined : getProfile(lang)?.lexicon?.qualified;
    return qualified !== undefined && Object.hasOwn(qualified, entity.kind) ? (qualified[entity.kind] ?? "") : "";
  };

  const keeps = (entity: Entity): boolean => view.entity(entity, graph);

  const compile = (node: Selector): Matcher => {
    switch (node.type) {
      case "id": {
        const wanted = node.id;
        return (id) => id === wanted;
      }
      case "kind": {
        const kind = node.kind;
        return (_id, entity) => entity.kind === kind;
      }
      case "trait": {
        const trait = node.trait;
        return (_id, entity) => entity.traits.includes(trait);
      }
      case "lang": {
        const lang = node.lang;
        return (id) => langsOf(graph).get(id) === lang;
      }
      case "name": {
        const glob = new Glob(node.glob);
        return (id, entity) => {
          const name = entityName(entity);
          return name !== undefined && glob.test(name, separatorOf(id, entity));
        };
      }
      case "module": {
        const glob = new Glob(node.glob);
        const byModule = new Map<EntityId, boolean>();
        return (id) => {
          const module = folder.containingModule(id);
          if (module === undefined) return false;
          let hit = byModule.get(module);
          if (hit === undefined) {
            const entity = graph.entity(module);
            const name = entity === undefined ? undefined : entityName(entity);
            hit = entity !== undefined && name !== undefined && glob.test(name, separatorOf(module, entity));
            byModule.set(module, hit);
          }
          return hit;
        };
      }
      case "file": {
        const glob = new Glob(node.glob);
        return (_id, entity) => {
          const file = anchorFile(entity);
          return file !== undefined && glob.test(file, "/");
        };
      }
      case "edge": {
        const kind = node.kind;
        const to = node.to === undefined ? undefined : compile(node.to);
        return memoize((id) => {
          for (const edge of graph.outgoing(id)) {
            if (edge.edge !== kind || !includesEdge(view, graph, edge)) continue;
            if (to === undefined) return true;
            const target = graph.entity(edge.to);
            if (target !== undefined && to(edge.to, target)) return true;
          }
          return false;
        });
      }
      case "edgeIn": {
        const kind = node.kind;
        const from = node.from === undefined ? undefined : compile(node.from);
        return memoize((id) => {
          for (const edge of graph.incoming(id)) {
            if (edge.edge !== kind || !includesEdge(view, graph, edge)) continue;
            if (from === undefined) return true;
            const source = graph.entity(edge.from);
            if (source !== undefined && from(edge.from, source)) return true;
          }
          return false;
        });
      }
      case "all": {
        const members = node.of.map(compile);
        return (id, entity) => members.every((member) => member(id, entity));
      }
      case "any": {
        const members = node.of.map(compile);
        return (id, entity) => members.some((member) => member(id, entity));
      }
      case "not": {
        const inner = compile(node.of);
        return (id, entity) => !inner(id, entity);
      }
    }
  };

  const root = compile(selector);
  let all: readonly EntityId[] | undefined;
  const matches = (id: EntityId): boolean => {
    const entity = graph.entity(id);
    return entity !== undefined && keeps(entity) && root(id, entity);
  };
  return {
    selector,
    view: view.descriptor,
    matches,
    matchingIds: () => (all ??= Object.freeze(graph.ids().filter(matches))),
  };
}

function memoize(evaluate: (id: EntityId) => boolean): Matcher {
  const memo = new Map<EntityId, boolean>();
  return (id) => {
    let hit = memo.get(id);
    if (hit === undefined) {
      hit = evaluate(id);
      memo.set(id, hit);
    }
    return hit;
  };
}

/** A hand-built AST gets the parser's vocabulary check, so it cannot match nothing silently. */
function validate(selector: Selector): void {
  const where = "selector";
  switch (selector.type) {
    case "kind":
      checkKind(selector.kind, where);
      return;
    case "trait":
      checkTrait(selector.trait, where);
      return;
    case "lang":
      checkLang(selector.lang, where);
      return;
    case "id":
      if (selector.id === "") throw new SelectorError("empty", `${where}: an id must not be empty`);
      return;
    case "name":
    case "module":
    case "file":
      if (selector.glob === "") throw new SelectorError("empty", `${where}: a ${selector.type} glob must not be empty`);
      return;
    case "edge":
      checkEdgeKind(selector.kind, where);
      if (selector.to !== undefined) validate(selector.to);
      return;
    case "edgeIn":
      checkEdgeKind(selector.kind, where);
      if (selector.from !== undefined) validate(selector.from);
      return;
    case "all":
    case "any":
      selector.of.forEach(validate);
      return;
    case "not":
      validate(selector.of);
      return;
    default: {
      // Reachable only from untyped callers: a tag the AST does not have.
      const unknown: never = selector;
      const tag = (unknown as { readonly type?: unknown }).type;
      throw new SelectorError("unknown-key", `${where}: unknown selector type ${JSON.stringify(tag)}`);
    }
  }
}
