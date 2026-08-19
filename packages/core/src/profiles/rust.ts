import type { Profile } from "../profile.js";

/**
 * Rust: no inheritance anywhere (TWithInheritances and the `inheritance` edge
 * kind are deliberately absent), and the `impl` block is reified as the
 * anonymous attachment entity of METAMODEL.md §7.
 */
export const rustProfile: Profile = {
  lang: "rust",
  kinds: {
    crate: {
      // The crate is the root module; definedIn is its root file (lib.rs / main.rs).
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TComment"],
    },
    module: {
      // N-N with files, which is why TModule.definedIn is a list.
      required: ["TNamed", "TModule", "TWithChildren", "TChildOf"],
      optional: ["TSourceAnchor", "TComment"],
    },
    struct: {
      required: ["TNamed", "TType", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    enum: {
      required: ["TNamed", "TType", "TWithImplements", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    trait: {
      // Supertrait bounds are not inheritance: they surface as reference edges.
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    impl: {
      // Reified impl block (METAMODEL.md §7): anonymous — no TNamed — attached to
      // the type, owning its methods; it anchors the interfaceImplementation edge.
      required: ["TWithChildren", "TAttachedTo", "TSourceAnchor"],
      optional: ["TChildOf", "TComment"],
    },
    function: {
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
    method: {
      // No TAttachedTo: the parent impl block owns the attachment, so it is read
      // through TChildOf and never duplicated here.
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
      optional: ["TSourceAnchor", "TComment"],
    },
    typeAlias: {
      // TTypedEntity.declaredType is the aliased type.
      required: ["TNamed", "TType", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    const: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
  },
  edges: ["import", "interfaceImplementation", "invocation", "access", "reference"],
  notes: [
    "Rust has no inheritance: TWithInheritances and the `inheritance` edge kind are absent from this profile by design, not by omission. Supertrait bounds (`trait A: B`), generic bounds and where-clauses are `reference` edges.",
    "The impl block is reified (METAMODEL.md §7): an anonymous entity with [TWithChildren, TAttachedTo, TSourceAnchor] and no TNamed, `attachedTo` the implementing type, its methods as children. The interfaceImplementation edge Type -> Trait takes that block as its anchor. Inherent `impl Type` blocks carry no such edge but still own their methods.",
    "Imports exist at two levels: `use` paths inside the module tree and crate dependencies declared in Cargo.toml. Both are `import` edges; the level is read from the endpoints' kinds (module vs crate), never from the id string.",
    "Modules are N-N with files: TModule.definedIn lists every file contributing to a module — inline `mod x { }` blocks put several modules in one file, while mod.rs plus sibling files (and #[path] attributes) spread one module tree over many.",
    "Blanket impls (`impl<T: Bound> Trait for T`) and derived trait impls yield interfaceImplementation edges with provenance 'derived': the concrete implementing types are computed by the analysis, not written in the source.",
    "#[derive(...)], macro_rules! and proc-macro expansion produce entities and edges with provenance 'generated'. A pre-expansion extraction sees none of them; a post-expansion one must anchor them at the invocation site.",
    "`dyn Trait` objects, generic calls and function pointers resolve to provenance 'dynamic-candidate' with the known impls as candidates.",
    "cfg-gated code (`#[cfg(...)]`, feature flags, target attributes) may be absent from any single extraction: a model reflects exactly one configuration, so two extractions of the same crate can legitimately differ in entity set.",
    "Trait default method bodies live in the trait, not in the impl blocks that inherit them; their invocation and access edges originate from the trait's method, and an impl that does not override the method has no child for it.",
    "Enum variants are not reified as a kind of their own: the enum is the type-level unit, variant payload types appear as `reference` edges from it, and named variant fields are `field` children.",
    "`static` items map to the `const` kind. Tuple-struct fields are named by their position (\"0\", \"1\", ...). Shadowed `let` bindings produce several localVariable entities disambiguated by (file, startLine).",
    "The `self` receiver is not emitted as a parameter; the receiver relation is the impl block's attachment.",
  ],
};
