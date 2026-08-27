import type { Edge, Entity, EntityId } from "@codegraph/core";
import { hasTrait, type CodeGraph } from "@codegraph/analyzer";
import type { DepRole } from "./model.js";

/**
 * ROLE RECOVERY. The metamodel stores every type usage as a `reference` edge
 * from the USING entity — a parameter, a local variable, a field, the method
 * itself (its return type), or the type (generics, casts, annotations). The
 * edge kind alone cannot say which, so the role is classified from the source
 * entity, exactly once, here:
 *
 *   source is a TType                          -> typeReference
 *   source sits in owner.parameters[]          -> parameterType (+ ordinal)
 *   source sits in owner.localVariables[]      -> localVariableType
 *   source is TInvocable, declaredType === to  -> returnType
 *   source is TStructural, declaredType === to -> fieldType
 *   anything else                              -> typeReference
 *
 * The parameter/local checks come FIRST and use the owner's ORDERED arrays
 * (TWithParameters/TWithLocalVariables) — a parameter also carries TStructural
 * and a declaredType, so trait checks alone would misfile it as a field.
 */

export interface ClassifiedRole {
  readonly role: DepRole;
  readonly detail?: string;
}

const KIND_ROLES: Readonly<Partial<Record<Edge["edge"], DepRole>>> = {
  import: "import",
  inheritance: "extends",
  interfaceImplementation: "implements",
  invocation: "invokes",
  embedding: "embeds",
  traitUsage: "usesTrait",
  fileInclude: "includesFile",
};

function idList(entity: Entity | undefined, key: string): readonly EntityId[] | undefined {
  const value = (entity as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(value) ? (value as EntityId[]) : undefined;
}

function declaredTypeOf(entity: Entity): EntityId | undefined {
  const value = (entity as { declaredType?: unknown }).declaredType;
  return typeof value === "string" ? value : undefined;
}

function nameOf(entity: Entity): string | undefined {
  const value = (entity as { name?: unknown }).name;
  return typeof value === "string" ? value : undefined;
}

function classifyReference(graph: CodeGraph, edge: Edge): ClassifiedRole {
  const source = graph.entity(edge.from);
  if (source === undefined) return { role: "typeReference" };
  if (hasTrait(source, "TType")) return { role: "typeReference" };

  const owner = graph.parentOf(edge.from);
  const ownerEntity = owner === undefined ? undefined : graph.entity(owner);
  if (ownerEntity !== undefined && hasTrait(ownerEntity, "TInvocable")) {
    const parameters = idList(ownerEntity, "parameters");
    const ordinal = parameters?.indexOf(edge.from) ?? -1;
    if (ordinal >= 0) {
      const name = nameOf(source);
      return {
        role: "parameterType",
        detail: `parameter #${ordinal + 1}${name === undefined ? "" : ` (${name})`}`,
      };
    }
    if (idList(ownerEntity, "localVariables")?.includes(edge.from) === true) {
      const name = nameOf(source);
      return {
        role: "localVariableType",
        detail: `local variable${name === undefined ? "" : ` ${name}`}`,
      };
    }
  }

  if (hasTrait(source, "TInvocable") && declaredTypeOf(source) === edge.to) {
    return { role: "returnType" };
  }
  if (hasTrait(source, "TStructural") && declaredTypeOf(source) === edge.to) {
    return { role: "fieldType" };
  }
  return { role: "typeReference" };
}

/**
 * The roles one base edge contributes — one for every kind except `access`,
 * where a compound assignment (isRead && isWrite) is BOTH a read and a write
 * and yields both rows rather than a blended third role.
 */
export function classifyEdge(graph: CodeGraph, edge: Edge): readonly ClassifiedRole[] {
  if (edge.edge === "reference") return [classifyReference(graph, edge)];
  if (edge.edge === "access") {
    const roles: ClassifiedRole[] = [];
    if (edge.isRead) roles.push({ role: "reads" });
    if (edge.isWrite) roles.push({ role: "writes" });
    return roles.length > 0 ? roles : [{ role: "reads" }];
  }
  const role = KIND_ROLES[edge.edge];
  return role === undefined ? [] : [{ role }];
}
