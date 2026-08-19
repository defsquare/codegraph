import type { Profile } from "../profile.js";

/**
 * TypeScript — the JavaScript kinds plus the type-space ones. The only profile
 * that uses `Entity.space` (METAMODEL.md §1.4): some entities exist solely at
 * type-check time, so a dependency on them is erased at runtime.
 */
export const typescriptProfile: Profile = {
  lang: "ts",

  kinds: {
    // The module is the file: TModule.definedIn holds exactly one path.
    module: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TSourceAnchor", "TComment"],
    },

    // `namespace X { }`. Not a file: N per file, and mergeable across files.
    namespace: {
      required: ["TNamed", "TWithChildren"],
      optional: ["TModule", "TChildOf", "TSourceAnchor", "TComment"],
    },

    class: {
      required: ["TNamed", "TType", "TChildOf"],
      optional: [
        "TWithInheritances",
        "TWithImplements",
        "TWithChildren",
        "TSourceAnchor",
        "TComment",
      ],
    },

    abstractClass: {
      required: ["TNamed", "TType", "TChildOf"],
      optional: [
        "TWithInheritances",
        "TWithImplements",
        "TWithChildren",
        "TSourceAnchor",
        "TComment",
      ],
    },

    // `interface A extends B, C` is inheritance, and it is multiple.
    interface: {
      required: ["TNamed", "TType"],
      optional: [
        "TWithInheritances",
        "TWithChildren",
        "TChildOf",
        "TSourceAnchor",
        "TComment",
      ],
    },

    // Type aliases never extend; their constituents are `reference` edges.
    typeAlias: {
      required: ["TNamed", "TType"],
      optional: ["TTypedEntity", "TChildOf", "TSourceAnchor", "TComment"],
    },

    enum: {
      required: ["TNamed", "TType", "TWithChildren"],
      optional: ["TChildOf", "TSourceAnchor", "TComment"],
    },

    // TNamed optional: anonymous function expressions are invocable unnamed.
    function: {
      required: ["TInvocable"],
      optional: [
        "TNamed",
        "TSourceAnchor",
        "TComment",
        "TChildOf",
        "TWithChildren",
        "TTypedEntity",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    method: {
      required: ["TNamed", "TInvocable", "TChildOf"],
      optional: [
        "TSourceAnchor",
        "TComment",
        "TWithChildren",
        "TTypedEntity",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    // Never TNamed; id disambiguator is (file, startLine), hence the anchor.
    arrowFunction: {
      required: ["TInvocable", "TSourceAnchor"],
      optional: [
        "TComment",
        "TChildOf",
        "TWithChildren",
        "TTypedEntity",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    variable: {
      required: ["TNamed", "TStructural"],
      optional: [
        "TSourceAnchor",
        "TComment",
        "TChildOf",
        "TWithChildren",
        "TTypedEntity",
      ],
    },

    parameter: {
      required: ["TNamed", "TStructural", "TChildOf"],
      optional: ["TTypedEntity", "TSourceAnchor"],
    },

    property: {
      required: ["TNamed", "TStructural", "TChildOf"],
      optional: ["TTypedEntity", "TSourceAnchor", "TComment"],
    },
  },

  edges: [
    "import",
    "inheritance",
    "interfaceImplementation",
    "invocation",
    "access",
    "reference",
  ],

  // The declaration spaces each kind MAY occupy (METAMODEL.md §1.4). This is
  // the licensed superset; the entity records which it actually occupies —
  // a `namespace` exporting only types is `["type"]` even though both are licit.
  // No other profile declares `space`: absence is the statement that the
  // language has no type/value split, and makes `Entity.space` an error there.
  space: {
    module: ["value"],
    namespace: ["type", "value"],
    class: ["type", "value"],
    abstractClass: ["type", "value"],
    interface: ["type"],
    typeAlias: ["type"],
    enum: ["type", "value"],
    function: ["value"],
    method: ["value"],
    arrowFunction: ["value"],
    variable: ["value"],
    parameter: ["value"],
    property: ["value"],
  },

  notes: [
    "This is the only profile that populates `Entity.space` (METAMODEL.md §1.4). Type-space only (`space: [\"type\"]`): `interface`, `typeAlias`. Both spaces (`[\"type\", \"value\"]`): `class`, `abstractClass`, `enum`, and a `namespace` that declares at least one value. Value-space only (`[\"value\"]`): `module`, `function`, `arrowFunction`, `method`, `variable`, `parameter`, `property`.",
    "A dependency whose target is type-space only is ERASED at runtime: it exists for the type checker and leaves nothing in the emitted JavaScript. Runtime, bundling and deployment analyses should therefore filter edges whose `to` resolves to a `space: [\"type\"]` entity; architectural coupling and design analyses should keep them, since the design dependency is real. Because the distinction is per-analysis, the model always stores both and never pre-filters.",
    "`import type { X }` and inline `type` specifiers produce ordinary `import` edges; they are erased at runtime and are recognized by the space of their target, not by a separate edge kind.",
    "Structural (non-nominal) typing: a class conforms to an interface without any `implements` clause. `interfaceImplementation` therefore carries provenance `declared` only for an explicit `implements`; conformance computed by shape comparison is `derived`, and the two must never be merged. Any analysis wanting facts filters on `declared`.",
    "Declaration merging means one id may be declared in several files: interface+interface, namespace+namespace, namespace+class/function/enum, and ambient module augmentation from a dependency. `TSourceAnchor` records only one declaration site, so edges carry `sourceFile` to say which site produced them.",
    "Ambient declarations (`.d.ts`, `declare module`, `declare global`) describe entities with no implementation in the corpus. They are emitted as real entities anchored in the `.d.ts`; the implementation they describe, when outside the corpus, is a stub.",
    "`any` erases resolution completely: a call or member access through an `any`-typed (or `unknown`-narrowed-by-cast, or index-signature) receiver has no target. Such edges are omitted, or emitted with provenance `dynamic-candidate` and a `candidates` list. The proportion of `any`-typed receivers is the honest ceiling on this profile's resolution rate.",
    "`const enum` members are inlined at emit, leaving no runtime entity; references to them survive only in the type space.",
    "`declaredType` is populated where a type is annotated. Full inference requires the TypeScript checker; an extractor running without a program leaves inferred types absent rather than guessing — the reason `TTypedEntity.declaredType` is optional even here.",
    "Generic type parameters are not reified as entities; a use of `Array<Order>` yields a `reference` edge to `Order` and none to `Array`'s parameter slot.",
    "Decorators and `emitDecoratorMetadata` synthesize members and metadata reads; entities and edges attributable to them carry provenance `generated`.",
    "A module is a file (`TModule.definedIn` has exactly one entry). `namespace` blocks are separate entities: several per file, and one namespace id may span files through merging.",
    "Path resolution depends on `tsconfig` `paths`, `baseUrl` and `package.json` exports; an unresolved specifier becomes a stub module rather than a dropped edge, so import fan-out stays honest.",
    "Enum members are emitted as `property` children of the `enum`.",
  ],
};
