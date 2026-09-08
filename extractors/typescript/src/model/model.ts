import type { Key } from "./keys.js";

/**
 * The extractor's in-memory model: what `schemas/` describes, with natural
 * keys where the wire has surrogates. No metamodel intelligence lives here —
 * the vocabularies below are restated from `schemas/*.schema.json`, and
 * `core`'s profile decides in its own tests whether the compositions this
 * extractor emits are licensed.
 */

export type Kind =
  | "module"
  | "namespace"
  | "class"
  | "abstractClass"
  | "interface"
  | "typeAlias"
  | "enum"
  | "function"
  | "method"
  | "constructor"
  | "arrowFunction"
  | "variable"
  | "parameter"
  | "property";

export type Trait =
  | "TNamed"
  | "TSourceAnchor"
  | "TComment"
  | "TWithChildren"
  | "TChildOf"
  | "TAttachedTo"
  | "TModule"
  | "TType"
  | "TWithInheritances"
  | "TWithImplements"
  | "TTypedEntity"
  | "TInvocable"
  | "TWithParameters"
  | "TWithLocalVariables"
  | "TWithInvocations"
  | "TStructural"
  | "TWithAccesses"
  | "TMetrics"
  | "TWithValue";

export type EdgeKind =
  | "import"
  | "inheritance"
  | "interfaceImplementation"
  | "invocation"
  | "access"
  | "reference"
  | "annotationUse"
  | "throws";

export type Provenance = "declared" | "derived" | "dynamic-candidate" | "generated";

export type Space = "type" | "value";

/** `[startLine, endLine]`, 1-based, inclusive; `file` root-relative with `/`. */
export interface Anchor {
  readonly file: string;
  readonly span: readonly [number, number];
}

/** A written value (METAMODEL.md §1.6), with keys where the wire has surrogates. */
export type Literal =
  | { readonly k: "string"; readonly v: string }
  | { readonly k: "number"; readonly v: string }
  | { readonly k: "boolean"; readonly v: boolean }
  | { readonly k: "null" }
  | { readonly k: "enum"; readonly type: Key; readonly name: string }
  | { readonly k: "type"; readonly type: Key }
  | { readonly k: "array"; readonly items: readonly Literal[] }
  | { readonly k: "annotation"; readonly type: Key; readonly arguments: readonly NamedArgument[] }
  | { readonly k: "unevaluated"; readonly source: string };

export interface NamedArgument {
  readonly name: string;
  readonly value: Literal;
}

export interface Entity {
  readonly key: Key;
  readonly kind: Kind;
  readonly traits: readonly Trait[];
  name?: string;
  anchor?: Anchor;
  comments?: string[];
  parent?: Key;
  attachedTo?: Key;
  /** TModule: exactly one path for a corpus file; several for a merged ambient module; none for a stub. */
  definedIn?: string[];
  isStub?: boolean;
  declaredType?: Key;
  signature?: string;
  parameters?: Key[];
  localVariables?: Key[];
  metrics?: Record<string, number>;
  value?: Literal;
  space?: Space[];
}

export interface Edge {
  readonly kind: EdgeKind;
  readonly from: Key;
  readonly to: Key;
  readonly provenance: Provenance;
  readonly anchor: Anchor;
  readonly candidates?: readonly Key[];
  readonly arguments?: readonly NamedArgument[];
  readonly isRead?: boolean;
  readonly isWrite?: boolean;
  readonly sourceFile?: string;
}

export interface Repository {
  readonly remote: string;
  readonly commit: string;
  readonly root: string;
  readonly provider?: "github" | "gitlab";
}

export interface ExtractorInfo {
  readonly name: string;
  readonly version: string;
  /** Loose on purpose (the header schema is): the compiler version rides here. */
  readonly [extra: string]: unknown;
}

export interface Model {
  readonly lang: string;
  readonly extractor: ExtractorInfo;
  readonly root: string;
  readonly repository?: Repository;
  readonly entities: readonly Entity[];
  readonly edges: readonly Edge[];
}
