import type { Profile } from "../profile.js";

/**
 * Go profile. TWithInheritances and the `inheritance` edge kind are absent
 * from this profile entirely: Go has no inheritance. Composition is expressed
 * by `embedding` edges, and interface satisfaction is derived, never declared.
 */
export const goProfile: Profile = {
  lang: "go",

  kinds: {
    package: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TComment"],
    },

    // TWithImplements is optional: satisfaction is computed, so it is present
    // only when the extractor derived interfaceImplementation edges.
    struct: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TWithImplements", "TComment"],
    },

    interface: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TWithImplements", "TComment"],
    },

    func: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TTypedEntity",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    // The canonical containment/attachment divergence: a method with receiver
    // `(o *Order)` is a child of its file's package but attached to Order.
    method: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TTypedEntity",
        "TChildOf",
        "TAttachedTo",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    field: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },

    // TNamed is optional: `func f(int, string)` and interface method
    // signatures declare parameters with a type and no name.
    parameter: {
      required: ["TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TNamed", "TSourceAnchor"],
    },

    localVariable: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor"],
    },

    // Covers both `type A = B` (alias) and `type A B` (defined type);
    // TTypedEntity points at the right-hand side.
    typeAlias: {
      required: ["TNamed", "TType", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },

    const: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
  },

  edges: [
    "import",
    "interfaceImplementation",
    "invocation",
    "access",
    "reference",
    "embedding",
  ],

  notes: [
    "Go has no inheritance: neither the TWithInheritances trait nor the inheritance edge kind belongs to this profile. Their absence is the profile's statement about the language, not a missing feature.",
    "Interface satisfaction is implicit and structural: nothing in the source says a type implements an interface, so interfaceImplementation edges are always emitted with provenance \"derived\" and never \"declared\". An analysis restricted to facts (declared edges) sees no implementation relation in Go at all.",
    "`struct { Base }` and `interface { io.Reader }` are embedding edges, not inheritance and not fields: the embedded type's methods are promoted onto the outer type, which changes which interfaces the outer type satisfies but creates no subtype relation.",
    "A method's receiver drives TAttachedTo (the receiver type) while TChildOf stays the package where the method is written; value and pointer receivers attach to the same type entity and are separated by the id's disambiguator.",
    "Multiple return values do not fit TTypedEntity's single declaredType: the first result is the declaredType and every further result type is emitted as a reference edge.",
    "Short variable declarations (`:=`), untyped constants and `iota` runs leave TTypedEntity present with declaredType absent.",
    "Calls through an interface value cannot be resolved statically: they are emitted against the interface method with provenance \"dynamic-candidate\" and the satisfying implementations as candidates.",
    "Invisible to static extraction: reflect, the plugin package, cgo, go:generate and go:linkname directives, and side effects of init() functions pulled in by blank imports (`import _ \"…\"`), which are still emitted as ordinary import edges.",
    "Build tags and GOOS/GOARCH constrained files mean a single extraction run sees one build configuration; entities excluded by the active tags are absent from the model.",
  ],
};
