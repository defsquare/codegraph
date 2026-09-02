import type { EntityId } from "@codegraph/core";
import {
  hasTrait,
  type CodeGraph,
  type DomainFacts,
  type ModuleFact,
  type OperationFact,
  type TypeDossier,
} from "@codegraph/analyzer";
import { sortIds } from "@codegraph/analyzer";
import type { Level } from "./schema.js";

/**
 * WHAT GETS EXPLAINED. A unit is one thing the walk asks the model about:
 *
 *   operation  a method or constructor that is a DIRECT member of a type. A
 *              lambda or local block is never a unit: its calls already roll up
 *              to the enclosing operation in the domain-facts dossier, and its
 *              source sits inside the operation's span.
 *   type       every non-stub corpus type the dossier covers.
 *   module     every non-stub corpus module the dossier covers.
 *
 * All three come from the domain-facts artifact, so "kept by the view" and
 * "internal vs external" are decided once, there, and never re-derived here.
 */

export interface OperationUnit {
  readonly id: EntityId;
  /** The dossier type that declares it. */
  readonly typeId: EntityId;
  readonly fact: OperationFact;
  /** Set when the heuristics below say no model call is needed. */
  readonly template: TemplateKind | undefined;
}

export interface UnitSet {
  /** Sorted by id. */
  readonly operations: ReadonlyMap<EntityId, OperationUnit>;
  readonly types: ReadonlyMap<EntityId, TypeDossier>;
  readonly modules: ReadonlyMap<EntityId, ModuleFact>;
  levelOf(id: EntityId): Level | undefined;
  /**
   * The operation unit an entity's facts belong to: itself, or the nearest
   * ancestor operation below the enclosing type. Undefined for anything that
   * is not inside an operation unit (a type, a field, a stub).
   */
  enclosingOperation(id: EntityId): EntityId | undefined;
}

export const TEMPLATE_KINDS = ["getter", "setter", "objectContract", "trivialConstructor"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

const OBJECT_CONTRACT = new Set(["equals", "hashCode", "toString", "compareTo"]);

/** Statement lines: the extractor's `sloc` when measured, else the gross span. Absent = unknown = large. */
function linesOf(op: OperationFact): number {
  return op.metrics?.["sloc"] ?? op.loc ?? Number.POSITIVE_INFINITY;
}

function complexityOf(op: OperationFact): number {
  return op.metrics?.["cyclomatic"] ?? Number.POSITIVE_INFINITY;
}

/**
 * THE TRIVIAL-MEMBER RULE — every input is a fact the model carries, never a
 * guess about the source text. A member is templated only when it does nothing
 * a domain reader needs explained: no branch, no throw, no call into the
 * corpus, and at most one field touched. Anything with a `throws` fact or a
 * corpus call is never trivial, however short.
 */
export function classifyTemplate(op: OperationFact, type: TypeDossier): TemplateKind | undefined {
  if (op.throws.length > 0) return undefined;
  if (op.invocations.some((call) => !call.external)) return undefined;
  if (complexityOf(op) > 1) return undefined;
  const lines = linesOf(op);
  const reads = op.accesses.filter((a) => a.isRead && !a.isWrite).length;
  const writes = op.accesses.filter((a) => a.isWrite).length;
  const name = op.name ?? "";

  if (op.kind === "constructor") {
    // Field-assigning constructor: only writes, at most one per line of body.
    return reads === 0 && lines <= writes + 2 ? "trivialConstructor" : undefined;
  }
  if (OBJECT_CONTRACT.has(name)) return lines <= 6 ? "objectContract" : undefined;
  if (lines > 3) return undefined;
  const fieldNames = new Set(type.fields.map((f) => f.name));
  if (/^set[A-Z]/u.test(name) && writes <= 1 && reads === 0) return "setter";
  if ((/^(?:get|is|has)[A-Z]/u.test(name) || fieldNames.has(name)) && writes === 0 && reads <= 1) return "getter";
  return undefined;
}

export function collectUnits(graph: CodeGraph, facts: DomainFacts): UnitSet {
  const operations = new Map<EntityId, OperationUnit>();
  const types = new Map<EntityId, TypeDossier>();
  const modules = new Map<EntityId, ModuleFact>();

  for (const dossier of facts.types) {
    types.set(dossier.id, dossier);
    for (const fact of dossier.operations) {
      if (fact.kind === "lambda") continue;
      operations.set(fact.id, {
        id: fact.id,
        typeId: dossier.id,
        fact,
        template: classifyTemplate(fact, dossier),
      });
    }
  }
  for (const module of facts.modules) modules.set(module.id, module);

  const sortedOperations = new Map(sortIds([...operations.keys()]).map((id) => [id, operations.get(id)!]));
  const sortedTypes = new Map(sortIds([...types.keys()]).map((id) => [id, types.get(id)!]));
  const sortedModules = new Map(sortIds([...modules.keys()]).map((id) => [id, modules.get(id)!]));

  const enclosing = new Map<EntityId, EntityId | undefined>();
  const enclosingOperation = (id: EntityId): EntityId | undefined => {
    if (enclosing.has(id)) return enclosing.get(id);
    let current: EntityId | undefined = id;
    let found: EntityId | undefined;
    const path: EntityId[] = [];
    while (current !== undefined) {
      if (sortedOperations.has(current)) {
        found = current;
        break;
      }
      const entity = graph.entity(current);
      if (entity === undefined || hasTrait(entity, "TType") || hasTrait(entity, "TModule")) break;
      path.push(current);
      current = graph.parentOf(current);
    }
    for (const visited of path) enclosing.set(visited, found);
    enclosing.set(id, found);
    return found;
  };

  return {
    operations: sortedOperations,
    types: sortedTypes,
    modules: sortedModules,
    levelOf: (id) =>
      sortedOperations.has(id) ? "operation" : sortedTypes.has(id) ? "type" : sortedModules.has(id) ? "module" : undefined,
    enclosingOperation,
  };
}
