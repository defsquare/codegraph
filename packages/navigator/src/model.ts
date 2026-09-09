import type { Provenance } from "@codegraph/core";
import type { ViewDescriptor } from "@codegraph/analyzer";

/**
 * THE NAVIGATOR MODEL: a second model, derived from the first — the browsable
 * shape of a corpus. Where the city answers "what does this code look like",
 * the navigator answers "what is here, and what exactly depends on what":
 *
 *   tree   modules (nested as the MODEL declares, never by splitting names)
 *          -> types (nested types under their outer type)
 *          -> operations and attributes
 *   deps   one row per base edge that crosses a selectable boundary, with the
 *          carrying member, the classified role, provenance and evidence
 *
 * EVERYTHING IS AN ARRAY INDEX. Entity ids are opaque strings that never need
 * to reach the renderer; a node is its position in `nodes`, a file its position
 * in `files`. A reference that cannot be closed onto an index is dropped and
 * counted in diagnostics — a dangling index is unwritable, mirroring the
 * interchange's own closure rule.
 *
 * The renderer builds lookup maps over these arrays and renders; it derives no
 * graph fact the analyzer already computed (CLAUDE.md hard boundary) — the
 * role classification, containment resolution and coupling numbers all happen
 * here, once, on the Node side.
 */

export const NAVIGATOR_ARTEFACT_KIND = "codegraph.navigator/1";
export const NAVIGATOR_GENERATOR = "@codegraph/navigator";

export const NODE_CATEGORIES = ["module", "type", "operation", "attribute"] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

/**
 * How one dependency row relates its endpoints. The metamodel has no
 * `typeDeclaration` edge kind — parameter, return, local-variable and field
 * types are all `reference` edges stored on the member entity — so the role is
 * recovered here from the SOURCE entity's traits and its owner's ordered
 * `parameters[]` / `localVariables[]` (see roles.ts), never re-derived by a
 * renderer.
 */
export const DEP_ROLES = [
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
] as const;
export type DepRole = (typeof DEP_ROLES)[number];

/** `[file, startLine, endLine]` — file is an index into `files`, lines 1-based inclusive. */
export type NavAnchor = readonly [file: number, start: number, end: number];

export interface NavNodeMetrics {
  /** Distinct dependents / dependencies at this node's fold level, from `coupling()`. */
  readonly fanIn: number;
  readonly fanOut: number;
  /** The analyzer's I = Ce / (Ca + Ce) in [0,1]; 0 by definition when Ca + Ce = 0. */
  readonly instability: number;
}

export interface NavNode {
  /** Display name; an unnamed invocable (a constructor) shows its signature. */
  readonly name: string;
  /**
   * The entity's rendered id, on TYPES and MODULES only — the nodes another
   * artifact addresses (the city's buildings and districts carry the same
   * ids). Opaque: compared, never parsed. Members carry none.
   */
  readonly id?: string;
  /** The entity kind, verbatim from the model: `class`, `package`, `method`… */
  readonly kind: string;
  /** From traits (TModule/TType/TInvocable/TStructural), never from `kind`. */
  readonly category: NodeCategory;
  readonly isStub: boolean;
  /** Tree parent index; absent for a root. */
  readonly parent?: number;
  /** Preorder-consistent, sorted (category, name, id); empty, never absent. */
  readonly children: readonly number[];
  readonly signature?: string;
  /** The declared type of an attribute/operation, resolved to a node index. */
  readonly declaredType?: number;
  readonly anchor?: NavAnchor;
  /** Present on types and modules that have a coupling row under the view. */
  readonly metrics?: NavNodeMetrics;
}

/**
 * One base edge, attributed to the selectable nodes that own its endpoints.
 * `from`/`to` are always type- or module-category nodes; `member`/`toMember`
 * name the operation/attribute that actually carries each endpoint, when one
 * does. A compound assignment (isRead && isWrite) emits BOTH a `reads` and a
 * `writes` row — same anchor, both true.
 */
export interface DepRow {
  readonly role: DepRole;
  readonly from: number;
  readonly to: number;
  readonly member?: number;
  readonly toMember?: number;
  /** Human refinement of the role: `parameter #2 (channel)`, `local variable total`. */
  readonly detail?: string;
  readonly provenance: Provenance;
  readonly anchor: NavAnchor;
}

/**
 * One aggregated link inside a cycle, mapped to node indexes. Everything here
 * is the ANALYZER's cycle report re-addressed — the renderer displays which
 * dependency to attack and what cutting it costs; it never runs Tarjan itself.
 */
export interface NavCycleEdge {
  readonly from: number;
  readonly to: number;
  /** Base edges aggregated into this link — the cost of cutting it. */
  readonly count: number;
  /** Sorted; more than one entry when facts and inferences mix on the link. */
  readonly provenances: readonly Provenance[];
  /** True only when every aggregated base edge is a `declared` fact. */
  readonly allDeclared: boolean;
  /** Member of the minimum feedback set — the minimal cut that breaks the cycle. */
  readonly feedback: boolean;
}

export interface NavCycleComponent {
  /** Node indexes, in the analyzer's member order (sorted by entity id). */
  readonly members: readonly number[];
  /** Links BETWEEN members, sorted (from, to); folding self-loops excluded. */
  readonly edges: readonly NavCycleEdge[];
  /** Sum of `edges` counts — the base-edge weight of the cycle. */
  readonly weight: number;
  /** Sum of the feedback edges' counts — the references the minimal cut severs. */
  readonly feedbackWeight: number;
  /** Structure101's tangle metric: feedbackWeight / weight, in [0,1]. */
  readonly tangleMetric: number;
}

export interface NavTangleSummary {
  readonly feedbackEdgeCount: number;
  readonly feedbackWeight: number;
  /** Non-self internal weight summed over the components. */
  readonly cyclicWeight: number;
  /** feedbackWeight / cyclicWeight; 0 — not NaN — on an acyclic graph. */
  readonly metric: number;
}

export interface NavCycleReport {
  /** The analyzer's fold: `module` over imports, `type` over every edge kind. */
  readonly level: "module" | "type";
  /** Sorted by first member, as the analyzer reports them. */
  readonly components: readonly NavCycleComponent[];
  readonly tangle: NavTangleSummary;
}

/**
 * Precomputed report data — graph facts the renderer must never re-derive
 * (CLAUDE.md hard boundary). Optional in the TYPE so artifacts written before
 * this section stay loadable; the builder always emits it.
 */
export interface NavReports {
  /** One report per level, module first. */
  readonly cycles: readonly NavCycleReport[];
}

export interface NavigatorDiagnostics {
  /** Edges whose endpoints resolved to the SAME owner — internal cohesion, not a dependency. */
  readonly selfDeps: number;
  /** Edges dropped because an endpoint had no owning node under the view. */
  readonly droppedDeps: number;
}

export interface NavigatorModel {
  /** Always `codegraph.navigator/1` — derived, never an interchange model.jsonl. */
  readonly kind: string;
  readonly generatedBy: string;
  /** The view the model was built under; a dependency list without its view is not a fact. */
  readonly view: ViewDescriptor;
  readonly corpus: { readonly name: string; readonly roots: readonly string[] };
  /** Interned anchor paths. */
  readonly files: readonly string[];
  /** Preorder over the tree: a parent always precedes its children. */
  readonly nodes: readonly NavNode[];
  /** Tree roots, sorted (category, name, id). */
  readonly roots: readonly number[];
  /** Sorted by (from, to, role, member, toMember, anchor). */
  readonly deps: readonly DepRow[];
  /** Absent only in artifacts written before the reports section existed. */
  readonly reports?: NavReports;
  readonly diagnostics: NavigatorDiagnostics;
}
