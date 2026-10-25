import { hasTrait, type CodeGraph } from "@codegraph/analyzer";
import { expect } from "vitest";
import { TERM_CLASSES } from "../src/classify.js";
import type { VocabularyArtifact } from "../src/artifact.js";

/**
 * The artifact's closure (PLAN.md §20.1): every scope id is an entity the
 * model declares, kept and of the scope's level; every index is in range; and
 * every count is what the tables add up to. A dangling index is unwritable.
 */
export function expectClosed(artifact: VocabularyArtifact, graph: CodeGraph): void {
  const { terms, scopes } = artifact;
  const classOrder = (c: string): number => TERM_CLASSES.indexOf(c as (typeof TERM_CLASSES)[number]);

  // Terms: interned once per (text, class), sorted by text, then class.
  for (let i = 1; i < terms.length; i += 1) {
    const [a, b] = [terms[i - 1], terms[i]];
    if (a === undefined || b === undefined) throw new Error("unreachable");
    expect(a.text < b.text || (a.text === b.text && classOrder(a.class) < classOrder(b.class)), `${a.text} before ${b.text}`).toBe(true);
  }

  const [root, ...rest] = scopes;
  expect(root?.level).toBe("corpus");
  expect(root?.id).toBeUndefined();
  expect(root?.parent).toBeUndefined();
  const modules = rest.filter((scope) => scope.level === "module");
  const types = rest.filter((scope) => scope.level === "type");
  // Root, then modules in id order, then types in id order.
  expect(rest).toEqual([...modules, ...types]);
  for (const level of [modules, types]) {
    const ids = level.map((scope) => scope.id ?? "");
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(ids).size).toBe(ids.length);
  }

  const modulesSpeaking = new Map<number, number>();
  const typesSpeaking = new Map<number, number>();
  const speakers = new Map<number, number[]>();
  scopes.forEach((scope, index) => {
    if (scope.level !== "corpus") {
      const entity = graph.entity(scope.id ?? "");
      expect(entity, `${scope.id} is declared`).toBeDefined();
      if (entity === undefined) return;
      expect(graph.isStub(entity.id), `${scope.id} is no stub`).toBe(false);
      expect(hasTrait(entity, scope.level === "module" ? "TModule" : "TType"), `${scope.id} is a ${scope.level}`).toBe(true);
      expect(scope.kind).toBe(entity.kind);
      expect(scope.parent, `${scope.id} has a parent scope`).toBeDefined();
      expect(scope.parent).not.toBe(index);
      expect(scope.parent).toBeGreaterThanOrEqual(0);
      expect(scope.parent).toBeLessThan(scopes.length);
    }

    const roles = Object.values(scope.roles).reduce((sum, n) => sum + n, 0);
    expect(scope.entities, `${scope.name}: every entity is unnamed, conventional or carries a role`).toBe(
      roles + scope.skipped.unnamed + scope.skipped.conventional,
    );

    let weight = 0;
    let occurrences = 0;
    const seen = new Set<number>();
    scope.terms.forEach(([term, w, n, carriers], row) => {
      expect(term).toBeGreaterThanOrEqual(0);
      expect(term).toBeLessThan(terms.length);
      expect(seen.has(term), `${scope.name}: ${terms[term]?.text} once`).toBe(false);
      seen.add(term);
      expect(n).toBeGreaterThan(0);
      expect(carriers).toBeGreaterThan(0);
      expect(carriers).toBeLessThanOrEqual(n);
      expect(carriers).toBeLessThanOrEqual(scope.entities);
      expect(w).toBeGreaterThanOrEqual(0);
      const previous = scope.terms[row - 1];
      if (previous !== undefined) {
        expect(previous[1] > w || (previous[1] === w && previous[0] < term), `${scope.name}: rows by weight, then term`).toBe(true);
      }
      weight += w;
      occurrences += n;
      if (scope.level === "module") modulesSpeaking.set(term, (modulesSpeaking.get(term) ?? 0) + 1);
      if (scope.level === "type") typesSpeaking.set(term, (typesSpeaking.get(term) ?? 0) + 1);
      if (scope.level === "module") speakers.set(term, [...(speakers.get(term) ?? []), index]);
    });
    expect(scope.weight).toBe(weight);
    expect(scope.occurrences).toBe(occurrences);
    expect(scope.distinct).toBe(scope.terms.length);
    expect(scope.distinctDomain).toBe(scope.terms.filter(([term]) => terms[term]?.class === "domain").length);
  });

  // The root speaks every term; the spread is what the scope tables say.
  expect(new Set(root?.terms.map(([term]) => term))).toEqual(new Set(terms.map((_, index) => index)));
  terms.forEach((term, index) => {
    expect(term.modules, term.text).toBe(modulesSpeaking.get(index) ?? 0);
    expect(term.types, term.text).toBe(typesSpeaking.get(index) ?? 0);
    const only = speakers.get(index);
    expect(term.exclusive, term.text).toBe(only?.length === 1 ? only[0] : undefined);
  });

  // Every kept entity folds into one module scope, or is unplaced and said so.
  const sum = (key: "entities" | "weight" | "occurrences"): number =>
    modules.reduce((total, scope) => total + scope[key], 0);
  expect(root?.entities).toBe(sum("entities") + artifact.diagnostics.unplaced.length);
  if (artifact.diagnostics.unplaced.length === 0) {
    expect(root?.weight).toBe(sum("weight"));
    expect(root?.occurrences).toBe(sum("occurrences"));
  }
  for (const id of artifact.diagnostics.unplaced) expect(graph.entity(id), id).toBeDefined();
}
