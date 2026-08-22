import { z } from "zod";

/**
 * Structured identity (METAMODEL.md §1.1, MM-1). Identity is the tuple
 * `(lang, module, symbol, disambiguator?)`, compared component-wise. A rendered
 * id (`java:com.acme.order/OrderService.bill(com.acme.order.Order)`) is a
 * DISPLAY projection produced by {@link renderId} — never stored as identity,
 * never parsed back, never compared to decide whether two entities are the same.
 *
 * v1 models still carry rendered ids on the wire; this module is the vocabulary
 * M6 encodes structurally (natural key = `m`/`s`/`d`, `lang` from the header).
 */

/**
 * The identity tuple.
 *
 * - `module` — the path of the owning module. A MODULE's own key names itself
 *   here with an empty `symbol`, so `java:com.acme.order` renders unchanged.
 *   (MM-1's draft made a module's key reference its PARENT module; that would
 *   render the package as `java:com.acme/order` and, worse, would need a
 *   fabricated `java` module to place the stub package `java:java.util`, whose
 *   parent no corpus declares — precisely the fabrication METAMODEL.md §6
 *   exists to prevent.)
 * - `symbol` — the path below the module, empty only for a module itself.
 * - `disambiguator` — optional: the erased-FQN parameter list is part of
 *   `symbol` for Java invocables, so this carries `file:line` for anonymous
 *   entities and the `param:`/`local:` markers.
 */
export interface NaturalKey {
  readonly lang: string;
  readonly module: string;
  readonly symbol: string;
  readonly disambiguator?: string | undefined;
}

/** Field separator of {@link naturalKeyIndex} — reserved in every component. */
const NUL = "\u0000";

/**
 * Separators are reserved so {@link renderId} stays injective: two distinct
 * keys can never render as the same string. Without this a key with a `/` in
 * its module would silently merge with a different module/symbol split — the
 * M2 `archive(List)` collision (METAMODEL.md §10) one level up, where it would
 * again cost a whole entity with no error reported.
 */
const RESERVED: Readonly<Record<keyof NaturalKey, readonly string[]>> = {
  lang: [":", NUL],
  module: ["/", "#", NUL],
  symbol: ["#", NUL],
  disambiguator: [NUL],
};

function reservedIn(component: keyof NaturalKey, value: string): string | undefined {
  return RESERVED[component].find((char) => value.includes(char));
}

function describe(char: string): string {
  return char === NUL ? "NUL" : `"${char}"`;
}

/** Zod mirror of {@link NaturalKey}, separator rules included. */
export const NaturalKey = z
  .object({
    lang: z.string().min(1),
    module: z.string().min(1),
    // Empty exactly when the entity IS the module (see the interface doc).
    symbol: z.string(),
    // Present means non-empty: an empty disambiguator would render as a bare
    // trailing "#", a second spelling of "no disambiguator".
    disambiguator: z.string().min(1).optional(),
  })
  .check((ctx) => {
    for (const component of ["lang", "module", "symbol", "disambiguator"] as const) {
      const value = ctx.value[component];
      if (typeof value !== "string") continue;
      const char = reservedIn(component, value);
      if (char !== undefined) {
        ctx.issues.push({
          code: "custom",
          message: `${component} may not contain ${describe(char)} — it is a reserved separator`,
          input: ctx.value,
          path: [component],
        });
      }
    }
  });

/** One reason a key is malformed: which component, and what is wrong with it. */
export interface NaturalKeyIssue {
  readonly component: keyof NaturalKey;
  readonly message: string;
}

/** Never throws — the model-level checks accumulate issues rather than abort. */
export function naturalKeyIssues(key: NaturalKey): NaturalKeyIssue[] {
  const issues: NaturalKeyIssue[] = [];
  if (key.lang.length === 0) issues.push({ component: "lang", message: "lang is empty" });
  if (key.module.length === 0) issues.push({ component: "module", message: "module is empty" });
  if (key.disambiguator !== undefined && key.disambiguator.length === 0) {
    issues.push({ component: "disambiguator", message: "disambiguator is present but empty" });
  }
  for (const component of ["lang", "module", "symbol", "disambiguator"] as const) {
    const value = key[component];
    if (value === undefined) continue;
    const char = reservedIn(component, value);
    if (char !== undefined) {
      issues.push({
        component,
        message: `${component} may not contain ${describe(char)} — it is a reserved separator`,
      });
    }
  }
  return issues;
}

/**
 * The display projection: `<lang>:<module>[/<symbol>][#<disambiguator>]`.
 * Validates, because an unchecked component would break injectivity silently —
 * and a silent identity collision is an entity that vanishes from the model.
 */
export function renderId(key: NaturalKey): string {
  const issues = naturalKeyIssues(key);
  if (issues.length > 0) {
    const detail = issues.map((issue) => issue.message).join("; ");
    throw new Error(`cannot render a malformed natural key: ${detail}`);
  }
  const symbol = key.symbol === "" ? "" : `/${key.symbol}`;
  const disambiguator = key.disambiguator === undefined ? "" : `#${key.disambiguator}`;
  return `${key.lang}:${key.module}${symbol}${disambiguator}`;
}

/**
 * Opaque grouping projection for Maps and Sets — component-wise equality made
 * hashable. Injective because no component may contain NUL, and an absent
 * disambiguator yields three fields where a present one yields four.
 *
 * Deliberately NOT {@link renderId}: a display string must never become the
 * thing consumers compare (MM-1). This value is process-local — never written
 * to a file, never shown to a user, never parsed.
 */
export function naturalKeyIndex(key: NaturalKey): string {
  const head = `${key.lang}${NUL}${key.module}${NUL}${key.symbol}`;
  return key.disambiguator === undefined ? head : `${head}${NUL}${key.disambiguator}`;
}

/** Component-wise equality — the only legitimate identity test (MM-1). */
export function naturalKeysEqual(a: NaturalKey, b: NaturalKey): boolean {
  return (
    a.lang === b.lang &&
    a.module === b.module &&
    a.symbol === b.symbol &&
    a.disambiguator === b.disambiguator
  );
}

/** Total order by UTF-16 code unit — locale-independent, like every other sort. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * CANONICAL MODEL ORDER (MM-5): sort by natural key, component by component,
 * a missing disambiguator before any present one. This is what makes snapshot
 * diffs reviewable and extractor cross-validation meaningful, so it belongs to
 * the model rather than to any one encoding.
 *
 * It is NOT the same order as sorting rendered ids as strings — `m/z` and
 * `m.x/a` compare differently once `/` and `.` are ordinary characters — which
 * is exactly why the order is defined on the key.
 */
export function compareNaturalKeys(a: NaturalKey, b: NaturalKey): number {
  const head =
    compareText(a.lang, b.lang) ||
    compareText(a.module, b.module) ||
    compareText(a.symbol, b.symbol);
  if (head !== 0) return head;
  if (a.disambiguator === b.disambiguator) return 0;
  if (a.disambiguator === undefined) return -1;
  if (b.disambiguator === undefined) return 1;
  return compareText(a.disambiguator, b.disambiguator);
}

/** Sorted copy in canonical order; the input is never mutated. */
export function sortByNaturalKey<T>(items: Iterable<T>, keyOf: (item: T) => NaturalKey): T[] {
  return [...items].sort((a, b) => compareNaturalKeys(keyOf(a), keyOf(b)));
}

/** A natural key claimed by more than one entity, with every claimant's position. */
export interface DuplicateNaturalKey {
  readonly key: NaturalKey;
  readonly positions: readonly number[];
}

/**
 * Natural-key uniqueness (MM-1): no two entities in a model may share
 * `(lang, module, symbol, disambiguator)`. Positions are indices into the input
 * sequence, so a caller can name every claimant rather than just the collision.
 */
export function duplicateNaturalKeys(keys: Iterable<NaturalKey>): DuplicateNaturalKey[] {
  const seen = new Map<string, { key: NaturalKey; positions: number[] }>();
  let index = 0;
  for (const key of keys) {
    const at = naturalKeyIndex(key);
    const entry = seen.get(at);
    if (entry === undefined) seen.set(at, { key, positions: [index] });
    else entry.positions.push(index);
    index += 1;
  }
  return [...seen.values()]
    .filter((entry) => entry.positions.length > 1)
    .sort((a, b) => compareNaturalKeys(a.key, b.key));
}

/**
 * The inverse of {@link renderId}. Well defined because rendering is injective
 * (the reserved separators above), and total on any id rendering produced by
 * core: split at the first `:`, then the first `#`, then the first `/`.
 *
 * WHO MAY CALL THIS: an **encoder** turning a rendered-id model into records,
 * the **city builder** (to emit display-only `identity` components onto the
 * artefact — never to decide membership, containment or equality), and test
 * fixtures. Nothing else. CLAUDE.md invariant 7 forbids consumers
 * parsing ids, and the rule it protects is real — deciding module membership by
 * reading an id is how fabricated FQNs get laundered into facts (METAMODEL §6).
 * Decoding a bijection core itself defined is a different act from inferring
 * meaning from a string, but only just; keep the caller list short.
 */
export function parseRenderedId(id: string): NaturalKey {
  const colon = id.indexOf(":");
  if (colon < 1) throw new Error(`not a rendered id (no lang prefix): ${JSON.stringify(id)}`);
  const lang = id.slice(0, colon);
  const body = id.slice(colon + 1);

  const hash = body.indexOf("#");
  const head = hash < 0 ? body : body.slice(0, hash);
  const disambiguator = hash < 0 ? undefined : body.slice(hash + 1);

  const slash = head.indexOf("/");
  const module = slash < 0 ? head : head.slice(0, slash);
  const symbol = slash < 0 ? "" : head.slice(slash + 1);

  const key: NaturalKey = { lang, module, symbol, disambiguator };
  const issues = naturalKeyIssues(key);
  if (issues.length > 0) {
    throw new Error(
      `not a rendered id (${issues.map((issue) => issue.message).join("; ")}): ${JSON.stringify(id)}`,
    );
  }
  // Decoding is only exact ON renderId's IMAGE. A string like `l:m/#d` is not
  // in it — it decodes to `(l, m, "", "d")`, which renders back as `l:m#d`, a
  // DIFFERENT id. Left unchecked, two such ids could quietly become one entity.
  // Verifying the round trip turns that into a refusal.
  if (renderId(key) !== id) {
    throw new Error(
      `not a rendered id (it is not what renderId would produce for its own components): ${JSON.stringify(id)}`,
    );
  }
  return key;
}
