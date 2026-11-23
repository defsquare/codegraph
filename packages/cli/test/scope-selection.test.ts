import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readModelFileSync } from "@codegraph/core";
import {
  buildDomainFacts,
  buildGraph,
  composeViews,
  declaredOnly,
  folderFor,
  identityView,
  internalOnly,
  loadModels,
  type CodeGraph,
  type View,
} from "@codegraph/analyzer";
import {
  EXPLAIN_WALK,
  UNFILTERED_SELECTION,
  buildWalk,
  collectUnits,
  createSourceReader,
  planRun,
  resolveSelection,
  type PlanEnv,
  type PlanOptions,
  type Unit,
  type UnitSet,
} from "@codegraph/insights";
import { buildVocabulary, definitionSpeller, rankedWords, type VocabularyArtifact } from "@codegraph/vocabulary";

/**
 * `--scope X` ≡ A SELECTION OF `include id:X` (PLAN.md §22.5, §22.6 step 4),
 * at the engine: for EVERY module, type and operation id of the Java fixture,
 * under each view the CLI can resolve, the plan under the id selection — as
 * explain.ts builds it — has the statuses and fingerprints of the plan under
 * the predicate `--scope` was before it was restated.
 *
 * Written first against that predicate itself (exported from explain.ts for
 * the purpose), green, and only then was it deleted; `scopePredicate` below
 * is its body, verbatim but for the usage error, as the reference.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/java/expected/model.jsonl", import.meta.url));
const SRC = fileURLToPath(new URL("../../../fixtures/java/src", import.meta.url));

const VIEWS: readonly View[] = [identityView, internalOnly, declaredOnly, composeViews(internalOnly, declaredOnly)];

const OPTIONS: PlanOptions = {
  models: { leaf: "openai/gpt-5.6-luna", rollup: "openai/gpt-5.6-luna" },
  depth: 1,
  maxLines: 200,
  maxScc: 12,
  force: false,
  maxCalls: undefined,
  inScope: undefined,
  terms: 60,
};

const graph: CodeGraph = buildGraph(loadModels(readModelFileSync(FIXTURE), { sources: ["fixtures/java"] }).union);

/** The plan env as explain.ts wires it: dossiers, units and walk under the view, the vocabulary's speller. */
function envOf(view: View) {
  const facts = buildDomainFacts(graph, { view });
  const units = collectUnits(graph, facts);
  const walk = buildWalk(units, graph, view);
  const reader = createSourceReader((relative) => {
    try {
      return readFileSync(join(SRC, relative), "utf8");
    } catch {
      return undefined;
    }
  });
  let vocabulary: VocabularyArtifact | undefined;
  const speller = { words: definitionSpeller(graph), ranked: (id: string) => rankedWords((vocabulary ??= buildVocabulary(graph, { view })), id) };
  const env: PlanEnv = { graph, facts, units, reader, unitOf: walk.unitOf, speller, spec: EXPLAIN_WALK };
  return { view, units, walk, env };
}

/** The predicate `--scope` was until M21 step 4: a member, its nearest type or its nearest module is named. */
function scopePredicate(scope: readonly string[], g: CodeGraph, _units: UnitSet): ((unit: Unit) => boolean) | undefined {
  if (scope.length === 0) return undefined;
  const wanted = new Set(scope);
  const folder = folderFor(g);
  return (unit) =>
    unit.members.some((m) => wanted.has(m) || wanted.has(folder.containingType(m) ?? "") || wanted.has(folder.containingModule(m) ?? ""));
}

/** explain.ts's restatement: `id:` includes, everything else unfiltered, matched against the whole model. */
function idSelection(scope: readonly string[], context: ReturnType<typeof envOf>, view: View = identityView): (unit: Unit) => boolean {
  const selection = { ...UNFILTERED_SELECTION, include: scope.map((id) => ({ type: "id" as const, id })) };
  return resolveSelection(selection, { graph, view, units: context.units, walk: context.walk, spec: EXPLAIN_WALK }).inScope;
}

/** Every module, type and operation id: the ids a unit is made of. */
function scopes(units: UnitSet): string[] {
  return [...units.modules.keys(), ...units.types.keys(), ...units.operations.keys()];
}

describe("--scope restated on a selection: the id selection plans what the old predicate planned", () => {
  it.each(VIEWS.map((view) => [view.descriptor.name, view] as const))("under view %s, for every single-id scope of the Java fixture", (_name, view) => {
    const context = envOf(view);
    const ids = scopes(context.units);
    expect(ids).toHaveLength(79); // 77 units, two of them cycles of two
    for (const id of ids) {
      const old = scopePredicate([id], graph, context.units);
      const restated = idSelection([id], context);
      const before = planRun(context.walk, new Map(), context.env, { ...OPTIONS, inScope: old });
      const after = planRun(context.walk, new Map(), context.env, { ...OPTIONS, inScope: restated });
      expect(after.steps.map((step) => `${step.unit.id} ${step.status} ${step.fingerprint}`), id).toEqual(
        before.steps.map((step) => `${step.unit.id} ${step.status} ${step.fingerprint}`),
      );
      expect(after.estimates, id).toEqual(before.estimates);
      // Compiled under the resolved view instead, it agrees too: no unit's member or nearest container is a stub here.
      const underView = idSelection([id], context, view);
      for (const unit of context.walk.units) expect(underView(unit), `${id} @ ${unit.id}`).toBe(old?.(unit));
    }
  });

  it("several ids at once: a union, as before", () => {
    const context = envOf(identityView);
    const ids = scopes(context.units);
    for (let i = 0; i + 2 < ids.length; i += 7) {
      const scope = [ids[i] as string, ids[i + 1] as string, ids[i + 2] as string];
      const old = scopePredicate(scope, graph, context.units);
      const restated = idSelection(scope, context);
      for (const unit of context.walk.units) expect(restated(unit), `${scope.join(",")} @ ${unit.id}`).toBe(old?.(unit));
    }
  });
});
