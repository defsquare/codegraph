import { EDGE_KINDS, PROFILES, TRAIT_NAMES, type EdgeKind, type EntityId } from "@codegraph/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entityName, type CodeGraph } from "../src/graph.js";
import { sortIds } from "../src/order.js";
import {
  compileSelector,
  formatTerm,
  parseSelector,
  parseTerm,
  selectorToJson,
  type Selector,
} from "../src/selectors.js";
import {
  composeViews,
  declaredOnly,
  identityView,
  includesEdge,
  internalOnly,
  type View,
} from "../src/views.js";
import { csharpGraph, elixirGraph, javaGraph, rubyGraph, typescriptGraph } from "./fixture.js";

/**
 * The selector contract as properties (PLAN §22.3, §22.6 step 3), over
 * generated selectors and the five real fixture graphs — each loaded ONCE.
 */

const FIXTURES: readonly (readonly [string, CodeGraph])[] = [
  ["java", javaGraph()],
  ["csharp", csharpGraph()],
  ["typescript", typescriptGraph()],
  ["elixir", elixirGraph()],
  ["ruby", rubyGraph()],
];

const VIEWS: readonly View[] = [identityView, declaredOnly, internalOnly, composeViews(internalOnly, declaredOnly)];

const KINDS = [...new Set(Object.values(PROFILES).flatMap((profile) => Object.keys(profile.kinds)))].sort();
const LANGS = Object.keys(PROFILES).sort();

/** Globs grown from the graph's real names, files and module names: a prefix kept, a star appended. */
function globsOf(graph: CodeGraph): readonly string[] {
  const seeds = new Set<string>(["*", "**", "**/*.java", "*Order*", "com.acme.**", "lib/**", "**/legacy/**", "Acme*::**"]);
  for (const entity of graph.entities.values()) {
    const name = entityName(entity);
    if (name !== undefined) seeds.add(name);
    const anchor = (entity as Record<string, unknown>)["anchor"] as { file?: unknown } | undefined;
    if (typeof anchor?.file === "string") seeds.add(anchor.file);
  }
  return [...seeds].sort();
}

function globArb(graph: CodeGraph): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom(...globsOf(graph)), fc.nat(), fc.constantFrom("", "*", "**"))
    .map(([seed, cut, star]) => seed.slice(0, cut % (seed.length + 1)) + star)
    .filter((glob) => glob.length > 0);
}

interface Pools {
  readonly ids: fc.Arbitrary<string>;
  readonly globs: fc.Arbitrary<string>;
  readonly edgeKinds: fc.Arbitrary<EdgeKind>;
}

/** Edge kinds the graph writes, mostly — a kind it never writes is a legal, empty case too. */
function poolsOf(graph: CodeGraph): Pools {
  const present = [...new Set(graph.edges.map((edge) => edge.edge))].sort();
  return {
    ids: fc.constantFrom(...graph.ids()),
    globs: globArb(graph),
    edgeKinds: fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...present) },
      { weight: 1, arbitrary: fc.constantFrom(...EDGE_KINDS) },
    ),
  };
}

function leafArb(pools: Pools): fc.Arbitrary<Selector> {
  return fc.oneof(
    pools.ids.map((id): Selector => ({ type: "id", id })),
    fc.constantFrom(...KINDS).map((kind): Selector => ({ type: "kind", kind })),
    fc.constantFrom(...TRAIT_NAMES).map((trait): Selector => ({ type: "trait", trait })),
    fc.constantFrom(...LANGS).map((lang): Selector => ({ type: "lang", lang })),
    fc
      .tuple(fc.constantFrom(...(["name", "module", "file"] as const)), pools.globs)
      .map(([type, glob]): Selector => ({ type, glob })),
  );
}

function edgeOf(kind: EdgeKind, to: Selector | null): Selector {
  return to === null ? { type: "edge", kind } : { type: "edge", kind, to };
}

function edgeInOf(kind: EdgeKind, from: Selector | null): Selector {
  return from === null ? { type: "edgeIn", kind } : { type: "edgeIn", kind, from };
}

/** Any selector: leaves, edges (nested), and all/any/not. */
function selectorArb(pools: Pools): fc.Arbitrary<Selector> {
  const leaf = leafArb(pools);
  const { selector } = fc.letrec<{ selector: Selector }>((tie) => ({
    selector: fc.oneof(
      { depthSize: "small", maxDepth: 3, withCrossShrink: true },
      leaf,
      fc.tuple(pools.edgeKinds, fc.option(tie("selector"))).map(([k, to]) => edgeOf(k, to)),
      fc.tuple(pools.edgeKinds, fc.option(tie("selector"))).map(([k, from]) => edgeInOf(k, from)),
      fc.array(tie("selector"), { maxLength: 3 }).map((of): Selector => ({ type: "all", of })),
      fc.array(tie("selector"), { maxLength: 3 }).map((of): Selector => ({ type: "any", of })),
      tie("selector").map((of): Selector => ({ type: "not", of })),
    ),
  }));
  return selector;
}

/** Only what has a text form: a leaf, or an edge whose nested selector has one. */
function termArb(pools: Pools): fc.Arbitrary<Selector> {
  const leaf = leafArb(pools);
  const { term } = fc.letrec<{ term: Selector }>((tie) => ({
    term: fc.oneof(
      { depthSize: "small", maxDepth: 3, withCrossShrink: true },
      leaf,
      fc.tuple(pools.edgeKinds, fc.option(tie("term"))).map(([k, to]) => edgeOf(k, to)),
      fc.tuple(pools.edgeKinds, fc.option(tie("term"))).map(([k, from]) => edgeInOf(k, from)),
    ),
  }));
  return term;
}

/** Does the selector hold a node of one of these types, at any depth? */
function holds(selector: Selector, types: ReadonlySet<Selector["type"]>): boolean {
  if (types.has(selector.type)) return true;
  switch (selector.type) {
    case "all":
    case "any":
      return selector.of.some((member) => holds(member, types));
    case "not":
      return holds(selector.of, types);
    case "edge":
      return selector.to !== undefined && holds(selector.to, types);
    case "edgeIn":
      return selector.from !== undefined && holds(selector.from, types);
    default:
      return false;
  }
}

/** A selector with no `not` anywhere: monotone in the edges it is shown. */
function monotoneArb(pools: Pools): fc.Arbitrary<Selector> {
  return selectorArb(pools).filter((selector) => !holds(selector, new Set(["not"])));
}

/** Payloads hostile to the grammar: every separator the ids use, and unicode. */
const HOSTILE = fc
  .array(
    fc.oneof(
      fc.constantFrom(":", ">", "<", "#", "/", "(", ")", ",", "%2F", "*", "**", ".", "::", " ", "é", "\u{1F600}", "edge:", "id:"),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 4 }),
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.join(""));

const hostilePools: Pools = { ids: HOSTILE, globs: HOSTILE, edgeKinds: fc.constantFrom(...EDGE_KINDS) };

const JAVA = FIXTURES[0]![1];
const javaPools = poolsOf(JAVA);

function ids(selector: Selector, graph: CodeGraph, view: View = identityView): readonly EntityId[] {
  return compileSelector(selector, graph, view).matchingIds();
}

/** The view's entity domain: what `all([])` must match. */
function domain(graph: CodeGraph, view: View): readonly EntityId[] {
  return graph.ids().filter((id) => {
    const entity = graph.entity(id);
    return entity !== undefined && view.entity(entity, graph);
  });
}

function intersect(sets: readonly (readonly EntityId[])[], universe: readonly EntityId[]): readonly EntityId[] {
  return universe.filter((id) => sets.every((set) => set.includes(id)));
}

function unite(sets: readonly (readonly EntityId[])[]): readonly EntityId[] {
  return sortIds(new Set(sets.flat()));
}

describe("text ⇄ AST ⇄ JSON", () => {
  it("parseTerm(formatTerm(t)) is t for every text-expressible term — real payloads", () => {
    fc.assert(
      fc.property(termArb(javaPools), (term) => {
        const text = formatTerm(term);
        expect(text).toBeDefined();
        expect(parseTerm(text as string)).toEqual(term);
      }),
      { numRuns: 300 },
    );
  });

  it("parseTerm(formatTerm(t)) is t for hostile payloads (`>`, `<`, `:`, `#`, unicode)", () => {
    fc.assert(
      fc.property(termArb(hostilePools), (term) => {
        expect(parseTerm(formatTerm(term) as string)).toEqual(term);
      }),
      { numRuns: 300 },
    );
  });

  it("parseSelector(selectorToJson(s)) is s for every selector, through JSON text too", () => {
    fc.assert(
      fc.property(selectorArb(hostilePools), (selector) => {
        const json = selectorToJson(selector);
        expect(parseSelector(json)).toEqual(selector);
        expect(parseSelector(JSON.parse(JSON.stringify(json)))).toEqual(selector);
      }),
      { numRuns: 300 },
    );
  });

  it("a selector has a text form exactly when it holds no all/any/not", () => {
    fc.assert(
      fc.property(selectorArb(javaPools), (selector) => {
        const composed = holds(selector, new Set(["all", "any", "not"]));
        expect(formatTerm(selector) === undefined).toBe(composed);
      }),
      { numRuns: 200 },
    );
  });
});

describe.each(FIXTURES)("every id of the %s fixture", (_lang, graph) => {
  const all = graph.ids();

  it("survives formatTerm/parseTerm as id: verbatim and selects exactly that entity", () => {
    expect(all.length).toBeGreaterThan(100);
    for (const id of all) {
      const text = formatTerm({ type: "id", id }) as string;
      expect(text).toBe(`id:${id}`);
      const parsed = parseTerm(text);
      expect(parsed).toEqual({ type: "id", id });
      expect(ids(parsed, graph)).toEqual([id]);
    }
  });

  it("survives nested in edge:invocation>id:… and selects exactly that entity's callers", () => {
    for (const id of all) {
      const parsed = parseTerm(`edge:invocation>id:${id}`);
      expect(parsed).toEqual({ type: "edge", kind: "invocation", to: { type: "id", id } });
      const callers = sortIds(new Set(graph.incomingOfKind(id, "invocation").map((edge) => edge.from)));
      expect(ids(parsed, graph)).toEqual(callers);
    }
  });
});

describe.each(FIXTURES)("selector algebra on the %s fixture", (_lang, graph) => {
  const pools = poolsOf(graph);
  const viewArb = fc.constantFrom(...VIEWS);

  it("not(not s) ≡ s", () => {
    fc.assert(
      fc.property(selectorArb(pools), viewArb, (s, view) => {
        expect(ids({ type: "not", of: { type: "not", of: s } }, graph, view)).toEqual(ids(s, graph, view));
      }),
      { numRuns: 60 },
    );
  });

  it("all([]) is the view's every entity, any([]) is nothing", () => {
    for (const view of VIEWS) {
      expect(ids({ type: "all", of: [] }, graph, view)).toEqual(domain(graph, view));
      expect(ids({ type: "any", of: [] }, graph, view)).toEqual([]);
    }
  });

  it("all/any are the intersection/union of their members' match sets", () => {
    fc.assert(
      fc.property(fc.array(selectorArb(pools), { maxLength: 4 }), viewArb, (members, view) => {
        const sets = members.map((member) => ids(member, graph, view));
        expect(ids({ type: "all", of: members }, graph, view)).toEqual(intersect(sets, domain(graph, view)));
        expect(ids({ type: "any", of: members }, graph, view)).toEqual(unite(sets));
      }),
      { numRuns: 60 },
    );
  });

  it("De Morgan: not(all(a,b)) ≡ any(not a, not b) and not(any(a,b)) ≡ all(not a, not b)", () => {
    fc.assert(
      fc.property(selectorArb(pools), selectorArb(pools), viewArb, (a, b, view) => {
        const not = (of: Selector): Selector => ({ type: "not", of });
        expect(ids(not({ type: "all", of: [a, b] }), graph, view)).toEqual(
          ids({ type: "any", of: [not(a), not(b)] }, graph, view),
        );
        expect(ids(not({ type: "any", of: [a, b] }), graph, view)).toEqual(
          ids({ type: "all", of: [not(a), not(b)] }, graph, view),
        );
      }),
      { numRuns: 60 },
    );
  });

  it("with no `not`, declaredOnly matches ⊆ identity matches", () => {
    fc.assert(
      fc.property(monotoneArb(pools), (s) => {
        const everything = new Set(ids(s, graph, identityView));
        for (const id of ids(s, graph, declaredOnly)) expect(everything.has(id), id).toBe(true);
      }),
      { numRuns: 80 },
    );
  });

  it("edge:K>T ⊆ edge:K, and both are the sources of the K-edges the view keeps", () => {
    fc.assert(
      fc.property(pools.edgeKinds, selectorArb(pools), viewArb, (kind, to, view) => {
        const target = compileSelector(to, graph, view);
        const kept = graph.edges.filter((edge) => edge.edge === kind && includesEdge(view, graph, edge));
        const anyTarget = ids({ type: "edge", kind }, graph, view);
        const someTarget = ids({ type: "edge", kind, to }, graph, view);
        expect(anyTarget).toEqual(sortIds(new Set(kept.map((edge) => edge.from))));
        expect(someTarget).toEqual(sortIds(new Set(kept.filter((edge) => target.matches(edge.to)).map((edge) => edge.from))));
        const sources = new Set(anyTarget);
        for (const id of someTarget) expect(sources.has(id), id).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it("edge-in:K is the targets of the edges edge:K's matches write (inverse consistency); edge-in:K<T likewise", () => {
    fc.assert(
      fc.property(pools.edgeKinds, selectorArb(pools), viewArb, (kind, from, view) => {
        const writers = new Set(ids({ type: "edge", kind }, graph, view));
        const written = graph.edges.filter(
          (edge) => edge.edge === kind && writers.has(edge.from) && includesEdge(view, graph, edge),
        );
        expect(ids({ type: "edgeIn", kind }, graph, view)).toEqual(sortIds(new Set(written.map((edge) => edge.to))));
        const source = compileSelector(from, graph, view);
        expect(ids({ type: "edgeIn", kind, from }, graph, view)).toEqual(
          sortIds(new Set(written.filter((edge) => source.matches(edge.from)).map((edge) => edge.to))),
        );
      }),
      { numRuns: 60 },
    );
  });

  it("matches nothing the view drops", () => {
    fc.assert(
      fc.property(selectorArb(pools), (s) => {
        for (const id of ids(s, graph, internalOnly)) expect(graph.isStub(id), id).toBe(false);
      }),
      { numRuns: 40 },
    );
  });
});
