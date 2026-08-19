import type { Profile } from "../profile.js";

/**
 * Clojure — the profile that motivates the trait design (METAMODEL.md §3.7):
 * a fn-holding var is simultaneously named, a value holder and invocable,
 * a composition no entity hierarchy can express.
 */
export const clojureProfile: Profile = {
  lang: "clj",

  kinds: {
    namespace: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TSourceAnchor", "TComment"],
    },

    // `def`. TChildOf stays optional so the canonical [TNamed, TStructural,
    // TInvocable] composition validates on its own.
    var: {
      required: ["TNamed", "TStructural"],
      optional: [
        "TSourceAnchor",
        "TComment",
        "TChildOf",
        "TWithChildren",
        "TAttachedTo",
        "TTypedEntity",
        "TInvocable",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    // `defn` / `def` of a fn value: the canonical composition is exactly the
    // required set, so an entity carrying nothing else is still valid.
    function: {
      required: ["TNamed", "TStructural", "TInvocable"],
      optional: [
        "TSourceAnchor",
        "TComment",
        "TChildOf",
        "TWithChildren",
        "TAttachedTo",
        "TTypedEntity",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    protocol: {
      required: ["TNamed", "TType", "TChildOf"],
      optional: ["TWithChildren", "TSourceAnchor", "TComment"],
    },

    // `defrecord` / `deftype`. No TWithInheritances: Clojure has no class
    // inheritance — that absence is profile information, not a gap.
    record: {
      required: ["TNamed", "TType", "TChildOf"],
      optional: ["TWithImplements", "TWithChildren", "TSourceAnchor", "TComment"],
    },

    // `defmulti`: a var holding a MultiFn, hence invocable like any fn-var.
    multimethod: {
      required: ["TNamed", "TStructural", "TInvocable", "TChildOf"],
      optional: [
        "TSourceAnchor",
        "TComment",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    // `defmethod`: no own name — identity is the multimethod plus the dispatch
    // value. Attached to the multimethod, child of the namespace.
    defmethod: {
      required: ["TInvocable", "TAttachedTo", "TChildOf", "TSourceAnchor"],
      optional: [
        "TComment",
        "TWithChildren",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
      ],
    },

    // Reified `extend-type` / `extend-protocol` block (METAMODEL.md §7):
    // anonymous, so no TNamed; it owns the impl fns and anchors the
    // interfaceImplementation edge emitted by the extended type.
    implBlock: {
      required: ["TWithChildren", "TAttachedTo", "TSourceAnchor"],
      optional: ["TChildOf", "TComment"],
    },

    parameter: {
      required: ["TNamed", "TStructural", "TChildOf"],
      optional: ["TTypedEntity", "TSourceAnchor"],
    },

    localBinding: {
      required: ["TNamed", "TStructural", "TChildOf"],
      optional: ["TTypedEntity", "TSourceAnchor"],
    },
  },

  edges: ["import", "interfaceImplementation", "invocation", "access", "reference"],

  notes: [
    "Planned extractor: clj-kondo analysis output (`--config '{:output {:analysis true}}'`), which resolves var definitions, usages and namespace requires without loading the code.",
    "Multimethod dispatch is not statically resolvable: the dispatch fn can compute any value. Invocation edges into a multimethod carry provenance `dynamic-candidate` with every known `defmethod` of that multimethod in `candidates`, and `to` set to the best guess.",
    "Macro-generated code does not exist before expansion. Definitions a macro emits are invisible to a reader-level extractor; where an extractor does expand (or where the macro is known, e.g. `defrecord` expanding to a class), the resulting entities and edges carry provenance `generated`.",
    "`extend-type` / `extend-protocol` are reified as anonymous `implBlock` entities (METAMODEL.md §7). The block is `attachedTo` the extended type; the `interfaceImplementation` edge runs type -> protocol and uses the block as its anchor.",
    "Protocol methods are namespace-level vars: they are emitted as `function` children of the namespace and `attachedTo` the protocol — the canonical containment-vs-attachment split, same shape as `defmethod`.",
    "Protocols are open: any namespace may extend any type to any protocol at any time, so the implementer set of a protocol is never closed by the file that declares it, and a partial corpus systematically under-reports `interfaceImplementation`.",
    "No `inheritance` edge kind: Clojure has no class inheritance. `derive` builds ad-hoc keyword hierarchies used for dispatch, which are values, not entities, and are not modeled.",
    "`declaredType` is populated only from `^TypeHint` metadata, which is optional and rare; for the vast majority of vars, parameters and bindings it is absent — this is precisely why `TTypedEntity.declaredType` is optional.",
    "`defrecord`/`deftype` positional fields are emitted as `parameter` children of the record: in Clojure they are literally the positional constructor parameters.",
    "Destructuring forms (`{:keys [a b]}`, `[x & rest]`) are flattened to one `parameter` per bound symbol, in source order; the pattern itself is not reified.",
    "Higher-order use of vars (`(map inc coll)`, `(partial f x)`) yields `reference` edges to the var, never `invocation` edges — the call happens elsewhere and its site is unknown.",
    "Runtime resolution (`resolve`, `requiring-resolve`, `eval`, `(var-get (ns-resolve ...))`) and dynamically computed `require` are static blind spots: no `import` or `invocation` edge is emitted for them.",
    "`:refer :all` and `:refer` bring vars into scope without qualification; the `import` edge is namespace -> namespace, so the module layer stays exact even when a symbol's origin needs var resolution.",
  ],
};
