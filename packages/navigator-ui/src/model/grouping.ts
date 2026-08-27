import type { DepRole } from "@codegraph/navigator";
import type { ModelIndexes } from "./indexes.js";

/**
 * The role vocabulary, RESTATED as literals — the same rule as the artifact
 * kind in guard.ts, and for the same reason: importing the value from
 * `@codegraph/navigator` pulls navigator → analyzer → core (zod, `node:fs`,
 * the SQLite loader) into the browser bundle, which fails the build outright.
 * `guard.test.ts` asserts this array equals the package's own `DEP_ROLES`,
 * order included — that equality is what keeps the section order here the
 * vocabulary's order rather than a second opinion about it.
 */
export const DEP_ROLE_ORDER = [
  "import",
  "extends",
  "implements",
  "embeds",
  "usesTrait",
  "includesFile",
  "invokes",
  "reads",
  "writes",
  "returnType",
  "parameterType",
  "localVariableType",
  "fieldType",
  "typeReference",
] as const satisfies readonly DepRole[];

/**
 * What the dependency view shows for one selected node: the precomputed rows
 * that touch it, grouped by role (and, for a type's outgoing pane, by carrying
 * operation). Grouping an index is presentation; the facts in the rows were
 * classified by `@codegraph/navigator` and are only bucketed here.
 */
export interface DepGroup {
  readonly role: DepRole;
  readonly rows: readonly number[];
}

export interface MemberGroup {
  /** The carrying member node, or undefined for rows the type itself carries. */
  readonly member: number | undefined;
  readonly rows: readonly number[];
}

export interface SelectionDeps {
  readonly incoming: readonly DepGroup[];
  readonly outgoing: readonly DepGroup[];
  /** Outgoing rows of a type, bucketed by carrying operation/attribute. */
  readonly outgoingByMember: readonly MemberGroup[];
}

const ROLE_RANK = new Map<DepRole, number>(DEP_ROLE_ORDER.map((role, index) => [role, index]));

function groupByRole(ix: ModelIndexes, rows: readonly number[]): readonly DepGroup[] {
  const buckets = new Map<DepRole, number[]>();
  for (const row of rows) {
    const role = ix.model.deps[row]?.role;
    if (role === undefined) continue;
    const bucket = buckets.get(role);
    if (bucket === undefined) buckets.set(role, [row]);
    else bucket.push(row);
  }
  return [...buckets.entries()]
    .sort((a, b) => (ROLE_RANK.get(a[0]) ?? 99) - (ROLE_RANK.get(b[0]) ?? 99))
    .map(([role, bucketed]) => ({ role, rows: bucketed }));
}

function groupByMember(ix: ModelIndexes, rows: readonly number[]): readonly MemberGroup[] {
  const buckets = new Map<number, number[]>();
  const NONE = -1;
  for (const row of rows) {
    const member = ix.model.deps[row]?.member ?? NONE;
    const bucket = buckets.get(member);
    if (bucket === undefined) buckets.set(member, [row]);
    else bucket.push(row);
  }
  // Members in tree order (their node index IS preorder); the type's own rows last.
  return [...buckets.entries()]
    .sort((a, b) => (a[0] === NONE ? 1 : b[0] === NONE ? -1 : a[0] - b[0]))
    .map(([member, bucketed]) => ({
      member: member === NONE ? undefined : member,
      rows: bucketed,
    }));
}

/**
 * The rows for one selection:
 *  - type/module: rows owned by the node (`from`/`to`);
 *  - operation/attribute: rows CARRIED by it (`member`/`toMember`) — its own
 *    slice of the owning type's dependencies.
 */
export function depsForSelection(ix: ModelIndexes, node: number): SelectionDeps {
  const category = ix.model.nodes[node]?.category;
  const owner = category === "type" || category === "module";
  const outgoingRows = (owner ? ix.depsByFrom.get(node) : ix.depsByMember.get(node)) ?? [];
  const incomingRows = (owner ? ix.depsByTo.get(node) : ix.depsByToMember.get(node)) ?? [];
  return {
    incoming: groupByRole(ix, incomingRows),
    outgoing: groupByRole(ix, outgoingRows),
    outgoingByMember: owner ? groupByMember(ix, outgoingRows) : [],
  };
}
