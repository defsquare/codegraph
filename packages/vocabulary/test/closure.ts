import { hasTrait, type CodeGraph } from "@codegraph/analyzer";
import { expect } from "vitest";
import { TERM_CLASSES } from "../src/classify.js";
import type { VocabularyArtifact } from "../src/artifact.js";

/**
 * The artifact's closure (PLAN.md §20.1): every scope id is an entity the
 * model declares, kept and of the scope's level; every index is in range; and
 * every count is what the tables add up to. A dangling index is unwritable.
 *
 * Checked in plain code and asserted once, listing every breach: an `expect`
 * per row made the check sixteen times slower than the build it checks, and
 * timed a property out on CI.
 */
export function expectClosed(artifact: VocabularyArtifact, graph: CodeGraph): void {
  const { terms, scopes } = artifact;
  const problems: string[] = [];
  const check = (holds: boolean, problem: () => string): void => {
    if (!holds) problems.push(problem());
  };
  const classOrder = (c: string): number => TERM_CLASSES.indexOf(c as (typeof TERM_CLASSES)[number]);

  // Terms: interned once per (text, class), sorted by text, then class.
  for (let i = 1; i < terms.length; i += 1) {
    const [a, b] = [terms[i - 1], terms[i]];
    if (a === undefined || b === undefined) throw new Error("unreachable");
    check(a.text < b.text || (a.text === b.text && classOrder(a.class) < classOrder(b.class)), () => `${a.text} (${a.class}) before ${b.text} (${b.class})`);
  }

  const [root, ...rest] = scopes;
  check(root?.level === "corpus", () => `the first scope is the corpus, not ${root?.level}`);
  check(root?.id === undefined, () => `the root has no id, not ${root?.id}`);
  check(root?.parent === undefined, () => `the root has no parent, not ${root?.parent}`);
  const modules = rest.filter((scope) => scope.level === "module");
  const types = rest.filter((scope) => scope.level === "type");
  // Root, then modules in id order, then types in id order.
  const leveled = [...modules, ...types];
  check(rest.length === leveled.length && rest.every((scope, i) => scope === leveled[i]), () => "modules come before types, and nothing else follows the root");
  for (const level of [modules, types]) {
    const ids = level.map((scope) => scope.id ?? "");
    ids.forEach((id, i) => {
      const previous = ids[i - 1];
      check(previous === undefined || previous < id, () => `${previous} before ${id}, once`);
    });
  }

  const modulesSpeaking = new Map<number, number>();
  const typesSpeaking = new Map<number, number>();
  const speakers = new Map<number, number[]>();
  scopes.forEach((scope, index) => {
    if (scope.level !== "corpus") {
      const entity = graph.entity(scope.id ?? "");
      check(entity !== undefined, () => `${scope.id} is declared`);
      if (entity === undefined) return;
      check(!graph.isStub(entity.id), () => `${scope.id} is no stub`);
      check(hasTrait(entity, scope.level === "module" ? "TModule" : "TType"), () => `${scope.id} is a ${scope.level}`);
      check(scope.kind === entity.kind, () => `${scope.id}: kind ${scope.kind}, declared ${entity.kind}`);
      const { parent } = scope;
      check(parent !== undefined && parent !== index && parent >= 0 && parent < scopes.length, () => `${scope.id}: parent scope ${parent} of ${scopes.length}, itself ${index}`);
    }

    const roles = Object.values(scope.roles).reduce((sum, n) => sum + n, 0);
    const accounted = roles + scope.skipped.unnamed + scope.skipped.conventional;
    check(scope.entities === accounted, () => `${scope.name}: ${scope.entities} entities, ${accounted} unnamed, conventional or carrying a role`);

    let weight = 0;
    let occurrences = 0;
    const seen = new Set<number>();
    scope.terms.forEach(([term, w, n, carriers], row) => {
      const at = `${scope.name} row ${row}`;
      check(term >= 0 && term < terms.length, () => `${at}: term ${term} of ${terms.length}`);
      check(!seen.has(term), () => `${at}: ${terms[term]?.text} once`);
      seen.add(term);
      check(n > 0, () => `${at}: ${n} occurrences`);
      check(carriers > 0 && carriers <= n && carriers <= scope.entities, () => `${at}: ${carriers} carriers, ${n} occurrences, ${scope.entities} entities`);
      check(w >= 0, () => `${at}: weight ${w}`);
      const previous = scope.terms[row - 1];
      if (previous !== undefined) {
        check(previous[1] > w || (previous[1] === w && previous[0] < term), () => `${at}: rows by weight, then term`);
      }
      weight += w;
      occurrences += n;
      if (scope.level === "module") modulesSpeaking.set(term, (modulesSpeaking.get(term) ?? 0) + 1);
      if (scope.level === "type") typesSpeaking.set(term, (typesSpeaking.get(term) ?? 0) + 1);
      if (scope.level === "module") speakers.set(term, [...(speakers.get(term) ?? []), index]);
    });
    check(Object.is(scope.weight, weight), () => `${scope.name}: weight ${scope.weight}, rows ${weight}`);
    check(Object.is(scope.occurrences, occurrences), () => `${scope.name}: ${scope.occurrences} occurrences, rows ${occurrences}`);
    check(scope.distinct === scope.terms.length, () => `${scope.name}: ${scope.distinct} distinct, ${scope.terms.length} rows`);
    const domain = scope.terms.filter(([term]) => terms[term]?.class === "domain").length;
    check(scope.distinctDomain === domain, () => `${scope.name}: ${scope.distinctDomain} distinct domain, ${domain} rows`);
  });

  // The root speaks every term; the spread is what the scope tables say.
  const spoken = new Set(root?.terms.map(([term]) => term));
  check(spoken.size === terms.length && terms.every((_, index) => spoken.has(index)), () => `the root speaks ${spoken.size} of ${terms.length} terms`);
  terms.forEach((term, index) => {
    const only = speakers.get(index);
    const exclusive = only?.length === 1 ? only[0] : undefined;
    check(term.modules === (modulesSpeaking.get(index) ?? 0), () => `${term.text}: ${term.modules} modules, ${modulesSpeaking.get(index) ?? 0} say it`);
    check(term.types === (typesSpeaking.get(index) ?? 0), () => `${term.text}: ${term.types} types, ${typesSpeaking.get(index) ?? 0} say it`);
    check(term.exclusive === exclusive, () => `${term.text}: exclusive to ${term.exclusive}, not ${exclusive}`);
  });

  // Every kept entity folds into one module scope, or is unplaced and said so.
  const sum = (key: "entities" | "weight" | "occurrences"): number =>
    modules.reduce((total, scope) => total + scope[key], 0);
  const { unplaced } = artifact.diagnostics;
  check(root?.entities === sum("entities") + unplaced.length, () => `the root holds ${root?.entities} entities, the modules ${sum("entities")} and ${unplaced.length} unplaced`);
  if (unplaced.length === 0) {
    check(Object.is(root?.weight, sum("weight")), () => `the root weighs ${root?.weight}, the modules ${sum("weight")}`);
    check(Object.is(root?.occurrences, sum("occurrences")), () => `the root has ${root?.occurrences} occurrences, the modules ${sum("occurrences")}`);
  }
  for (const id of unplaced) check(graph.entity(id) !== undefined, () => `${id}, unplaced, is declared`);

  expect(problems).toEqual([]);
}
