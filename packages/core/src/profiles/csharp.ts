import type { Profile } from "../profile.js";

/**
 * C# profile. Trait sets are per-kind: a struct or enum cannot inherit, an
 * interface cannot implement, so those markers are absent where the language
 * cannot produce the corresponding edge (METAMODEL.md §3.4).
 */
export const csharpProfile: Profile = {
  lang: "csharp",

  kinds: {
    // Nested namespace declarations give a lexical parent; file-scoped ones do not.
    namespace: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TChildOf", "TComment"],
    },

    class: {
      required: [
        "TNamed",
        "TType",
        "TWithInheritances",
        "TWithImplements",
        "TWithChildren",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    // `interface X : Y` is an inheritance edge between types; an interface
    // never implements.
    interface: {
      required: [
        "TNamed",
        "TType",
        "TWithInheritances",
        "TWithChildren",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    struct: {
      required: [
        "TNamed",
        "TType",
        "TWithImplements",
        "TWithChildren",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    // TTypedEntity carries the underlying integral type (`enum E : byte`).
    enum: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TTypedEntity", "TComment"],
    },

    record: {
      required: [
        "TNamed",
        "TType",
        "TWithInheritances",
        "TWithImplements",
        "TWithChildren",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    // A delegate is a type that is also invocable: TType + TInvocable, with
    // TTypedEntity as the return type.
    delegate: {
      required: [
        "TNamed",
        "TType",
        "TInvocable",
        "TWithParameters",
        "TTypedEntity",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    // TAttachedTo is present exactly on extension methods: written inside a
    // static class, semantically belonging to the extended type.
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
        "TSourceAnchor",
      ],
      optional: ["TAttachedTo", "TComment"],
    },

    // No TNamed and no TTypedEntity; the id's disambiguator is the signature.
    constructor: {
      required: [
        "TInvocable",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment"],
    },

    // A value holder whose accessors may hold bodies, hence the optional
    // invocation/access markers.
    property: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TWithInvocations", "TWithAccesses", "TComment"],
    },

    field: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },

    parameter: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor"],
    },

    localVariable: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor"],
    },

    // Lambdas, anonymous methods and local functions used as values: invocable
    // without a name; the id's disambiguator is `(file, startLine)`.
    lambda: {
      required: [
        "TInvocable",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TTypedEntity"],
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

  notes: [
    "Partial classes (and partial methods) mean one entity id is declared across several files: the entity carries a single anchor for its primary declaration, while each edge carries sourceFile to say which declaration site produced it. Merging by id is correct here, not a collision.",
    "`var`, target-typed `new()`, anonymous types and inferred lambda parameters leave TTypedEntity present with declaredType absent — the trait states that the entity has a type, not that the extractor resolved one.",
    "Extension methods are children of their static host class but carry TAttachedTo pointing at the extended type; a call site written as instance syntax is still an invocation edge to the static method.",
    "Reflection is invisible: Type.GetType, Activator.CreateInstance, expression trees and source-generated partials leave no edge unless the generated source is part of the analyzed root (then provenance is \"generated\").",
    "Dependency-injection wiring is invisible: container registrations (Microsoft.Extensions.DependencyInjection, Autofac, …) bind an interface to an implementation at runtime, so no invocation edge links a consumer to the concrete type it will receive.",
    "`dynamic` call sites and virtual dispatch through an interface resolve to the declared member; when the target cannot be pinned down the edge is emitted with provenance \"dynamic-candidate\" plus a candidates list.",
    "`using` directives, `global using` and using aliases are folded to module-level import edges to the imported namespace, never to individual types.",
  ],
};
