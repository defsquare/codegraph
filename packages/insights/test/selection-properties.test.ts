import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EDGE_KINDS, PROFILES, TRAIT_NAMES, readModelFileSync, type EdgeKind } from "@codegraph/core";
import {
  buildDomainFacts,
  buildGraph,
  compileSelector,
  composeViews,
  declaredOnly,
  entityName,
  folderFor,
  identityView,
  internalOnly,
  loadModels,
  type CodeGraph,
  type Selector,
  type SelectorMatcher,
  type View,
} from "@codegraph/analyzer";
import { contextPackFor, type ContextEnv } from "../src/context.js";
import { buildWalk, type Unit, type WalkPlan } from "../src/order.js";
import { planRun, trivialKindOf, type PlanEnv, type PlanOptions, type RunPlan } from "../src/plan.js";
import { renderPrompts } from "../src/prompt.js";
import { memoryBook } from "../src/records.js";
import { executeRun, type Completer, type CompletionRequest } from "../src/run.js";
import { LEVELS, type Level } from "../src/schema.js";
import {
  CLOSURES,
  TRIVIAL_POLICIES,
  UNFILTERED_SELECTION,
  priceSelection,
  resolveSelection,
  type Closure,
  type ResolvedSelection,
  type Selection,
} from "../src/selection.js";
import { createSourceReader } from "../src/source.js";
import type { WalkSpec } from "../src/spec.js";
import { collectUnits, type UnitSet } from "../src/units.js";
import { EXPLAIN, toySpeller } from "./fixture.js";

/**
 * THE FIVE RULES AS PROPERTIES (PLAN.md §22.3, §22.6 step 4), over generated
 * selections on each of the five fixtures, against a cold store unless said.
 * Generated selections lean towards matching something: ids are drawn from
 * the units' members and their nearest containers, globs from real names.
 */

type Lang = "java" | "csharp" | "typescript" | "elixir" | "ruby";
const LANGS: readonly Lang[] = ["java", "csharp", "typescript", "elixir", "ruby"];

/** Explain without its templates: trivial members are ASKED, so `trivial` decides them. */
const { template: _template, ...ASKS_TRIVIAL_FIELDS } = EXPLAIN;
const ASKS_TRIVIAL: WalkSpec = ASKS_TRIVIAL_FIELDS;
const SPECS: readonly WalkSpec[] = [EXPLAIN, ASKS_TRIVIAL];

/** What each fixture holds for the cycle and trivial properties to bite on — TypeScript has no cycle, Ruby no trivial member. */
const SHAPES: Readonly<Record<Lang, { readonly cycles: number; readonly trivial: number }>> = {
  java: { cycles: 2, trivial: 9 },
  csharp: { cycles: 2, trivial: 13 },
  typescript: { cycles: 0, trivial: 3 },
  elixir: { cycles: 1, trivial: 1 },
  ruby: { cycles: 2, trivial: 0 },
};

const VIEWS: readonly View[] = [identityView, declaredOnly, internalOnly, composeViews(internalOnly, declaredOnly)];

// One prompt per cycle (no fixture cycle is near this), so a fake answer's members are the unit's.
const OPTIONS: PlanOptions = {
  models: { leaf: "leaf-model", rollup: "rollup-model" },
  depth: 1,
  maxLines: 200,
  maxScc: 1000,
  force: false,
  maxCalls: undefined,
  inScope: undefined,
  terms: 60,
};
const RUN = { maxScc: OPTIONS.maxScc, depth: OPTIONS.depth, maxLines: OPTIONS.maxLines, terms: OPTIONS.terms };

interface Corpus {
  readonly lang: Lang;
  readonly graph: CodeGraph;
  readonly view: View;
  readonly units: UnitSet;
  readonly walk: WalkPlan;
  readonly base: Omit<PlanEnv, "spec">;
  /** Per spec, the plan with no predicate, cold. */
  readonly unfiltered: Map<WalkSpec, RunPlan>;
}

function corpusOf(lang: Lang, graph: CodeGraph, view: View): Corpus {
  const facts = buildDomainFacts(graph, { view });
  const units = collectUnits(graph, facts);
  const walk = buildWalk(units, graph, view);
  const root = fileURLToPath(new URL(`../../../fixtures/${lang}/src/`, import.meta.url));
  const reader = createSourceReader((relative) => {
    try {
      return readFileSync(`${root}${relative}`, "utf8");
    } catch {
      return undefined;
    }
  });
  const base = { graph, facts, units, reader, unitOf: walk.unitOf, speller: toySpeller(graph) };
  return { lang, graph, view, units, walk, base, unfiltered: new Map() };
}

function graphOf(lang: Lang): CodeGraph {
  const path = fileURLToPath(new URL(`../../../fixtures/${lang}/expected/model.jsonl`, import.meta.url));
  return buildGraph(loadModels(readModelFileSync(path), { sources: [`fixtures/${lang}`] }).union);
}

const CORPORA: ReadonlyMap<Lang, readonly Corpus[]> = new Map(
  LANGS.map((lang) => {
    const graph = graphOf(lang);
    return [lang, VIEWS.map((view) => corpusOf(lang, graph, view))];
  }),
);

const envOf = (corpus: Corpus, spec: WalkSpec): PlanEnv => ({ ...corpus.base, spec });

function plan(corpus: Corpus, spec: WalkSpec, inScope: ((unit: Unit) => boolean) | undefined): RunPlan {
  return planRun(corpus.walk, new Map(), envOf(corpus, spec), { ...OPTIONS, inScope });
}

function unfiltered(corpus: Corpus, spec: WalkSpec): RunPlan {
  let found = corpus.unfiltered.get(spec);
  if (found === undefined) corpus.unfiltered.set(spec, (found = plan(corpus, spec, undefined)));
  return found;
}

const resolve = (corpus: Corpus, spec: WalkSpec, selection: Selection): ResolvedSelection =>
  resolveSelection(selection, { graph: corpus.graph, view: corpus.view, units: corpus.units, walk: corpus.walk, spec });

// ---------------------------------------------------------------------------
// Generators — mirroring the analyzer's selector generators, leaning to hits
// ---------------------------------------------------------------------------

const KINDS = [...new Set(Object.values(PROFILES).flatMap((profile) => Object.keys(profile.kinds)))].sort();
const PROFILE_LANGS = Object.keys(PROFILES).sort();

function poolsOf(corpus: Corpus) {
  const { graph, walk } = corpus;
  const folder = folderFor(graph);
  const near = new Set<string>();
  for (const unit of walk.units) {
    for (const member of unit.members) {
      near.add(member);
      const type = folder.containingType(member);
      const module = folder.containingModule(member);
      if (type !== undefined) near.add(type);
      if (module !== undefined) near.add(module);
    }
  }
  const names = new Set<string>();
  const files = new Set<string>();
  for (const id of near) {
    const entity = graph.entity(id);
    const name = entity === undefined ? undefined : entityName(entity);
    if (name !== undefined) names.add(name);
    const anchor = (entity as Record<string, unknown> | undefined)?.["anchor"] as { file?: unknown } | undefined;
    if (typeof anchor?.file === "string") files.add(anchor.file);
  }
  const cycles = walk.units.filter((unit) => unit.members.length > 1).flatMap((unit) => unit.members);
  const present = [...new Set(graph.edges.map((edge) => edge.edge))].sort();
  const glob = (seeds: Set<string>): fc.Arbitrary<string> =>
    fc
      .tuple(fc.constantFrom(...[...seeds].sort()), fc.nat(), fc.constantFrom("", "", "*", "**"))
      .map(([seed, cut, star]) => (star === "" ? seed : seed.slice(0, Math.max(1, cut % (seed.length + 1))) + star));
  return {
    ids: fc.oneof(
      { weight: 6, arbitrary: fc.constantFrom(...[...near].sort()) },
      { weight: cycles.length === 0 ? 0 : 2, arbitrary: fc.constantFrom(...(cycles.length === 0 ? [...near] : cycles)) },
      { weight: 1, arbitrary: fc.constantFrom(...graph.ids()) },
    ),
    names: glob(names),
    files: files.size === 0 ? glob(names) : glob(files),
    edgeKinds: fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...present) }, { weight: 1, arbitrary: fc.constantFrom(...EDGE_KINDS) }) as fc.Arbitrary<EdgeKind>,
  };
}

function selectorArb(corpus: Corpus): fc.Arbitrary<Selector> {
  const pools = poolsOf(corpus);
  const leaf: fc.Arbitrary<Selector> = fc.oneof(
    { weight: 6, arbitrary: pools.ids.map((id): Selector => ({ type: "id", id })) },
    { weight: 2, arbitrary: pools.names.map((glob): Selector => ({ type: "module", glob })) },
    { weight: 2, arbitrary: pools.names.map((glob): Selector => ({ type: "name", glob })) },
    { weight: 1, arbitrary: pools.files.map((glob): Selector => ({ type: "file", glob })) },
    { weight: 1, arbitrary: fc.constantFrom(...KINDS).map((kind): Selector => ({ type: "kind", kind })) },
    { weight: 1, arbitrary: fc.constantFrom(...TRAIT_NAMES).map((trait): Selector => ({ type: "trait", trait })) },
    { weight: 1, arbitrary: fc.constantFrom(...PROFILE_LANGS).map((lang): Selector => ({ type: "lang", lang })) },
  );
  return fc.oneof(
    { weight: 8, arbitrary: leaf },
    { weight: 2, arbitrary: fc.tuple(pools.edgeKinds, fc.option(leaf)).map(([kind, to]): Selector => (to === null ? { type: "edge", kind } : { type: "edge", kind, to })) },
    { weight: 1, arbitrary: fc.tuple(pools.edgeKinds, fc.option(leaf)).map(([kind, from]): Selector => (from === null ? { type: "edgeIn", kind } : { type: "edgeIn", kind, from })) },
    { weight: 1, arbitrary: fc.array(leaf, { minLength: 1, maxLength: 2 }).map((of): Selector => ({ type: "all", of })) },
    { weight: 1, arbitrary: leaf.map((of): Selector => ({ type: "not", of })) },
  );
}

function selectionArb(corpus: Corpus, closure?: Closure): fc.Arbitrary<Selection> {
  const selector = selectorArb(corpus);
  return fc.record({
    include: fc.oneof({ weight: 1, arbitrary: fc.constant([]) }, { weight: 5, arbitrary: fc.array(selector, { minLength: 1, maxLength: 3 }) }),
    exclude: fc.oneof({ weight: 2, arbitrary: fc.constant([]) }, { weight: 3, arbitrary: fc.array(selector, { minLength: 1, maxLength: 2 }) }),
    levels: fc.oneof({ weight: 2, arbitrary: fc.constant([...LEVELS]) }, { weight: 3, arbitrary: fc.subarray([...LEVELS], { minLength: 1 }) }),
    closure: closure === undefined ? fc.constantFrom(...CLOSURES) : fc.constant(closure),
    trivial: fc.constantFrom(...TRIVIAL_POLICIES),
  });
}

/** A fixture under one of the four views, a spec, a selection: the input of every property. */
function caseArb(lang: Lang, closure?: Closure) {
  const corpora = CORPORA.get(lang) ?? [];
  return fc
    .constantFrom(...corpora)
    .chain((corpus) => fc.tuple(fc.constant(corpus), fc.constantFrom(...SPECS), selectionArb(corpus, closure)));
}

// ---------------------------------------------------------------------------
// References, written from the rules' text
// ---------------------------------------------------------------------------

/** Rule 1 as PLAN.md states it: the entity, its nearest type, its nearest module. */
function ruleOne(corpus: Corpus, selectors: readonly Selector[]): (id: string) => boolean {
  const matcher: SelectorMatcher | undefined =
    selectors.length === 0 ? undefined : compileSelector({ type: "any", of: selectors }, corpus.graph, corpus.view);
  const folder = folderFor(corpus.graph);
  return (id) => {
    if (matcher === undefined) return false;
    const three = [id, folder.containingType(id), folder.containingModule(id)];
    return three.some((candidate) => candidate !== undefined && matcher.matches(candidate));
  };
}

/** Units strictly below a unit in the walk: its transitive dependencies. */
function coneOf(walk: WalkPlan): (unit: Unit) => ReadonlySet<string> {
  const cones = new Map<string, Set<string>>();
  // Walk order puts every dependency first, so each cone is built from finished ones.
  for (const unit of walk.units) {
    const cone = new Set<string>();
    for (const dep of unit.deps) {
      cone.add(dep);
      for (const below of cones.get(dep) ?? []) cone.add(below);
    }
    cones.set(unit.id, cone);
  }
  return (unit) => cones.get(unit.id) ?? new Set();
}

const BARRED = new Set(["outside-levels", "excluded", "trivial"]);

/** The least fixed point, by brute iteration: what the BFS in selection.ts must equal. */
function referenceClosure(resolved: ResolvedSelection, closure: Closure): ReadonlySet<string> {
  const { walk } = resolved;
  const set = new Set(walk.units.filter((unit) => resolved.standing(unit) === "selected").map((unit) => unit.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const unit of walk.units) {
      if (!set.has(unit.id)) continue;
      const reached = [
        ...(closure === "dependencies" || closure === "all" ? unit.deps : []),
        ...(closure === "containers" || closure === "all" ? resolved.containersOf(unit) : []),
      ];
      for (const id of reached) {
        const target = walk.unitOf.get(id);
        if (set.has(id) || target === undefined || BARRED.has(resolved.standing(target))) continue;
        set.add(id);
        changed = true;
      }
    }
  }
  return set;
}

const ids = (p: RunPlan, status: string): Set<string> => new Set(p.steps.filter((step) => step.status === status).map((step) => step.unit.id));

function byLevel(p: RunPlan, status: string): Record<Level, number> {
  const counts: Record<Level, number> = { operation: 0, type: 0, module: 0 };
  for (const step of p.steps) if (step.status === status) counts[step.unit.level] += 1;
  return counts;
}

/** Fake answers for explain's blocks: words and glossary empty (kept as such), the shape exact. */
function blockOf(level: Level, id: string): Record<string, unknown> {
  if (level === "operation") {
    return { name: id, description: `Explains ${id}.`, safe: true, idempotent: true, owner: "entity", handlesCommand: null, emits: [], preconditions: [], postconditions: [], invariantsEnforced: [], usesSpi: [], domainTerms: [], words: [], confidence: 0.7 };
  }
  if (level === "type") {
    return { name: id, description: `Type ${id}.`, concept: "entity", eventKind: null, interfaceRole: null, aggregateRoot: null, containedIn: null, syncPattern: null, identity: null, fields: [], invariants: [], stateMachine: null, relatesTo: [], exposes: [], dependsOn: [], domainTerms: [], words: [], confidence: 0.6 };
  }
  return { name: id, description: `Module ${id}.`, apis: [], spis: [], dependsOn: [], concepts: [], boundedContextHint: null, sharedKernelHint: null, ubiquitousLanguage: [], words: [], glossary: [], confidence: 0.5 };
}

/** Answers from the request alone; a cycle's members come from the walk, never from parsing ids. */
function fakeCompleter(walk: WalkPlan): Completer {
  return async (request: CompletionRequest) => {
    const rest = (request.user.split("\n")[0] ?? "").replace(/^# Unit: \w+ /u, "");
    const cut = rest.indexOf(" (a cycle of ");
    const unitId = cut < 0 ? rest : rest.slice(0, cut);
    const level = request.schemaName.replace(/^codegraph_/u, "").replace(/_cycle$/u, "") as Level;
    const members = walk.unitOf.get(unitId)?.members ?? [unitId];
    const json = request.schemaName.endsWith("_cycle") ? { members: members.map((id) => ({ id, block: blockOf(level, id) })) } : blockOf(level, unitId);
    return { json, model: request.model };
  };
}

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe.each(LANGS)("the selection on the %s fixture", (lang) => {
  const corpora = CORPORA.get(lang) ?? [];

  it("is not vacuous: the fixture has the cycles and trivial members the properties filter (as counted)", () => {
    const corpus = corpora[0] as Corpus;
    expect(corpus.walk.units.length).toBeGreaterThan(50);
    expect(corpus.walk.units.filter((unit) => unit.members.length > 1).length).toBe(SHAPES[lang].cycles);
    expect([...corpus.units.operations.values()].filter((op) => op.template !== undefined).length).toBe(SHAPES[lang].trivial);
  });

  it("the unfiltered selection reproduces the plan with no predicate, under every view and spec", () => {
    for (const corpus of corpora) {
      for (const spec of SPECS) {
        expect(JSON.stringify(plan(corpus, spec, resolve(corpus, spec, UNFILTERED_SELECTION).inScope))).toBe(JSON.stringify(unfiltered(corpus, spec)));
      }
    }
  });

  it("leaves the walk alone: buildWalk is identical with and without it, and so is a fingerprint exactly when nothing below it was skipped", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const before = JSON.stringify(corpus.walk);
        const filtered = plan(corpus, spec, resolve(corpus, spec, selection).inScope);
        expect(JSON.stringify(corpus.walk)).toBe(before);
        expect(JSON.stringify(buildWalk(corpus.units, corpus.graph, corpus.view))).toBe(before);
        const base = unfiltered(corpus, spec);
        const skipped = ids(filtered, "skip-scope");
        const cone = coneOf(corpus.walk);
        filtered.steps.forEach((step, i) => {
          const clean = [...cone(step.unit)].every((below) => !skipped.has(below));
          expect(step.fingerprint === base.steps[i]?.fingerprint, step.unit.id).toBe(clean);
        });
      }),
      { numRuns: 50 },
    );
  });

  it("asks a subset of what the unfiltered plan asks", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const asked = ids(plan(corpus, spec, resolve(corpus, spec, selection).inScope), "llm");
        const everything = ids(unfiltered(corpus, spec), "llm");
        for (const id of asked) expect(everything.has(id), id).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("rule 1 exactly: an entity is selected iff it or a NEAREST container matches an include and none matches an exclude", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const included = ruleOne(corpus, selection.include);
        const excluded = ruleOne(corpus, selection.exclude);
        for (const unit of corpus.walk.units) {
          for (const member of unit.members) {
            const expected = (selection.include.length === 0 || included(member)) && !excluded(member);
            expect(resolved.selects(member), member).toBe(expected);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("exclude wins: nothing an exclude reaches through rule 1 is asked, under every closure mode", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const excluded = ruleOne(corpus, selection.exclude);
        for (const closure of CLOSURES) {
          for (const id of resolved.walked(closure)) {
            const unit = corpus.walk.unitOf.get(id) as Unit;
            for (const member of unit.members) expect(excluded(member), `${closure} ${member}`).toBe(false);
          }
        }
        const asked = plan(corpus, spec, resolved.inScope).steps.filter((step) => step.status === "llm");
        for (const step of asked) for (const member of step.unit.members) expect(excluded(member), member).toBe(false);
      }),
      { numRuns: 60 },
    );
  });

  it("levels: no unit outside them is walked, under every closure mode", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const levels = new Set(selection.levels);
        for (const closure of CLOSURES) {
          for (const id of resolved.walked(closure)) expect(levels.has((corpus.walk.unitOf.get(id) as Unit).level), id).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("trivial: `skip` leaves every trivial member unasked under every mode; a templating spec templates them whatever the policy", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const trivial = corpus.walk.units.filter((unit) => trivialKindOf(unit, corpus.units) !== undefined);
        expect(trivial.length).toBe(SHAPES[lang].trivial);
        if (selection.trivial === "skip") {
          for (const closure of CLOSURES) for (const unit of trivial) expect(resolved.walked(closure).has(unit.id), `${closure} ${unit.id}`).toBe(false);
        }
        const statuses = new Map(plan(corpus, spec, resolved.inScope).steps.map((step) => [step.unit.id, step.status]));
        for (const unit of trivial) {
          if (spec.template !== undefined) expect(statuses.get(unit.id), unit.id).toBe("template");
          else if (selection.trivial === "skip") expect(statuses.get(unit.id), unit.id).toBe("skip-scope");
        }
      }),
      { numRuns: 50 },
    );
  });

  it("a cycle is one unit: selected when one member is and none is excluded, and then every member is asked", () => {
    fc.assert(
      fc.property(caseArb(lang, "none"), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const walked = resolved.walked("none");
        const included = ruleOne(corpus, selection.include);
        const excluded = ruleOne(corpus, selection.exclude);
        const includes = (member: string): boolean => selection.include.length === 0 || included(member);
        const contextEnv: ContextEnv = { ...envOf(corpus, spec), records: memoryBook([], spec), depth: 1, maxLines: 200, terms: 60 };
        for (const unit of corpus.walk.units) {
          if (unit.members.length < 2) continue;
          const some = unit.members.some(includes);
          const barred = unit.members.some(excluded);
          expect(walked.has(unit.id), unit.id).toBe(selection.levels.includes(unit.level) && some && !barred);
          if (walked.has(unit.id)) {
            const asked = renderPrompts(contextPackFor(unit, contextEnv), OPTIONS.maxScc).flatMap((prompt) => prompt.memberIds);
            expect([...asked].sort()).toEqual([...unit.members].sort());
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("every cycle, member by member: including one member asks the cycle, excluding one member bars it", () => {
    for (const corpus of corpora) {
      for (const unit of corpus.walk.units.filter((u) => u.members.length > 1)) {
        for (const member of unit.members) {
          const one = (partial: Partial<Selection>) => resolve(corpus, EXPLAIN, { ...UNFILTERED_SELECTION, ...partial });
          expect(one({ include: [{ type: "id", id: member }] }).inScope(unit), `include ${member}`).toBe(true);
          const barred = one({ exclude: [{ type: "id", id: member }] });
          expect(barred.inScope(unit), `exclude ${member}`).toBe(false);
          expect(barred.standing(unit)).toBe("excluded");
          // The rest of the walk is untouched by an exclude that reaches one member and nothing else.
          const others = corpus.walk.units.filter((u) => u.id !== unit.id && !u.members.some(barred.excludes));
          for (const other of others) expect(barred.inScope(other), other.id).toBe(true);
        }
      }
    }
  });

  it("closure is the least set with its property, monotonic in the mode, and never overrides levels, excludes or trivial", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const walked = Object.fromEntries(CLOSURES.map((closure) => [closure, resolved.walked(closure)])) as Record<Closure, ReadonlySet<string>>;
        const unit = (id: string): Unit => corpus.walk.unitOf.get(id) as Unit;
        const mayAsk = (id: string): boolean => !BARRED.has(resolved.standing(unit(id)));
        for (const closure of CLOSURES) {
          expect([...walked[closure]].sort(), closure).toEqual([...referenceClosure(resolved, closure)].sort());
          for (const id of walked[closure]) {
            if (closure === "dependencies" || closure === "all") {
              for (const dep of unit(id).deps) if (mayAsk(dep)) expect(walked[closure].has(dep), `${closure}: ${id} → ${dep}`).toBe(true);
            }
            if (closure === "containers" || closure === "all") {
              for (const above of resolved.containersOf(unit(id))) if (mayAsk(above)) expect(walked[closure].has(above), `${closure}: ${id} ↑ ${above}`).toBe(true);
            }
            if (!walked.none.has(id)) expect(mayAsk(id), `${closure} added ${id}`).toBe(true);
          }
        }
        const subset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].every((id) => b.has(id));
        expect(subset(walked.none, walked.dependencies) && subset(walked.dependencies, walked.all)).toBe(true);
        expect(subset(walked.none, walked.containers) && subset(walked.containers, walked.all)).toBe(true);
      }),
      { numRuns: 80 },
    );
  });

  it("containers are what the walk rolls up into: a type or module unit that depends on the unit, through containment", () => {
    for (const corpus of corpora) {
      const resolved = resolve(corpus, EXPLAIN, UNFILTERED_SELECTION);
      const cone = coneOf(corpus.walk);
      const rank: Record<Level, number> = { operation: 0, type: 1, module: 2 };
      for (const unit of corpus.walk.units) {
        for (const id of resolved.containersOf(unit)) {
          const above = corpus.walk.unitOf.get(id) as Unit;
          expect(cone(above).has(unit.id), `${id} above ${unit.id}`).toBe(true);
          expect(rank[above.level] >= rank[unit.level] && above.level !== "operation", `${id} above ${unit.id}`).toBe(true);
        }
        if (unit.level === "module") expect(resolved.containersOf(unit)).toEqual([]);
      }
    }
  });

  it("dependencies: no asked unit has a skip-scope dependency within levels that is not excluded (or trivial skipped)", () => {
    fc.assert(
      fc.property(caseArb(lang, "dependencies"), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const filtered = plan(corpus, spec, resolved.inScope);
        const skipped = ids(filtered, "skip-scope");
        for (const step of filtered.steps) {
          if (step.status !== "llm") continue;
          for (const dep of step.unit.deps) {
            if (!skipped.has(dep)) continue;
            expect(BARRED.has(resolved.standing(corpus.walk.unitOf.get(dep) as Unit)), `${step.unit.id} → ${dep}`).toBe(true);
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it("the price equals what the plans show: per mode, the skip-scope count falls by `added`; asked, left out, templated and not walked are counted off the plan", () => {
    fc.assert(
      fc.property(caseArb(lang), ([corpus, spec, selection]) => {
        const resolved = resolve(corpus, spec, selection);
        const price = priceSelection(resolved);
        const plans = Object.fromEntries(CLOSURES.map((closure) => [closure, plan(corpus, spec, resolveSelection({ ...selection, closure }, { graph: corpus.graph, view: corpus.view, units: corpus.units, walk: corpus.walk, spec }).inScope)])) as Record<Closure, RunPlan>;
        for (const closure of CLOSURES) {
          const none = byLevel(plans.none, "skip-scope");
          const other = byLevel(plans[closure], "skip-scope");
          for (const level of LEVELS) expect(none[level] - other[level], `${closure} ${level}`).toBe(price.added[closure][level]);
        }
        const own = plans[selection.closure];
        expect(price.asked).toEqual(byLevel(own, "llm"));
        expect(price.leftOut).toEqual(byLevel(own, "skip-scope"));
        expect(price.templated).toEqual(byLevel(own, "template"));
        const skipped = ids(own, "skip-scope");
        const shown = new Set(own.steps.filter((step) => step.status === "llm").flatMap((step) => step.unit.deps.filter((dep) => skipped.has(dep))));
        const counted: Record<Level, number> = { operation: 0, type: 0, module: 0 };
        for (const id of shown) counted[(corpus.walk.unitOf.get(id) as Unit).level] += 1;
        const { notWalked } = price;
        for (const level of LEVELS) {
          expect(notWalked.unselected[level] + notWalked.excluded[level] + notWalked.outsideLevels[level] + notWalked.trivial[level], level).toBe(counted[level]);
          expect(price.selected[level] + price.added[selection.closure][level], level).toBe(price.asked[level]);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("reuse across filters: after a filtered run, the unfiltered plan reuses a record exactly when nothing below its unit was missing", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb(lang), async ([corpus, spec, selection]) => {
        const env = envOf(corpus, spec);
        const filtered = plan(corpus, spec, resolve(corpus, spec, selection).inScope);
        const records = new Map();
        const result = await executeRun(filtered, env, records, fakeCompleter(corpus.walk), RUN, { concurrency: 1 });
        expect(result.failures).toEqual([]);
        const after = planRun(corpus.walk, new Map(result.records.map((record) => [record.id, record])), env, OPTIONS);
        const skipped = ids(filtered, "skip-scope");
        const cone = coneOf(corpus.walk);
        filtered.steps.forEach((step, i) => {
          const status = after.steps[i]?.status;
          if (step.status === "llm") {
            const clean = [...cone(step.unit)].every((below) => !skipped.has(below));
            expect(status === "reuse", step.unit.id).toBe(clean);
          } else if (step.status === "skip-scope") {
            expect(status, step.unit.id).toBe("llm");
          } else {
            expect(status, step.unit.id).toBe("template");
          }
        });
      }),
      { numRuns: 15 },
    );
  });
});
