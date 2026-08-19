import type { TraitName } from "../names.js";
import type { Profile } from "../profile.js";

/**
 * Java profile (PLAN.md §5.1). Trait sets are per-kind rather than per-family:
 * an interface cannot implement, an enum/record/annotation cannot extend, so
 * those markers are absent from the kinds that cannot carry the corresponding
 * edges — the absence is profile information (METAMODEL.md §3.4).
 */
export const javaProfile: Profile = {
  lang: "java",

  kinds: {
    // A package is a flat namespace, not a lexical container of other packages:
    // no TChildOf, and `com.acme.order` is not a child of `com.acme`.
    package: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TComment"],
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

    // `interface X extends Y, Z` is an inheritance edge between types; an
    // interface never implements.
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

    enum: {
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

    record: {
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

    annotation: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },

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
      optional: ["TComment"],
    },

    // No TNamed (a constructor has no own name) and no TTypedEntity (it has no
    // return type); the id's disambiguator is the signature.
    // `constructor` is the one kind name TypeScript will not contextually type
    // from an index signature (Object.prototype shadows it), hence `satisfies`.
    constructor: {
      required: [
        "TInvocable",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ] satisfies readonly TraitName[],
      optional: ["TComment"] satisfies readonly TraitName[],
    },

    // Lambdas and anonymous classes: invocable but nameless; the id's
    // disambiguator is `(file, startLine)`.
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

    attribute: {
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
    "Spoon in noClasspath mode invents plausible fully-qualified names for unresolved types. Corpus membership is therefore decided by a whitelist of ids actually declared by the corpus (built in a first pass); anything else is emitted as an isStub entity. Never decide membership by package or name prefix — invented FQNs look exactly like real ones and a prefix filter would launder them into facts.",
    "Reflection is invisible: Class.forName, Method.invoke, proxies, Spring XML/annotation wiring, ServiceLoader/META-INF/services, and JNDI lookups produce no edge. The import/invocation graph of a reflection-heavy corpus is a lower bound.",
    "Lombok-generated members (getters, setters, @Builder, @Data constructors) are emitted with provenance \"generated\" when the expansion is visible to Spoon, and are missing entirely when it is not.",
    "An interface's `extends` list is emitted as inheritance edges between types; interfaceImplementation is reserved for a class/enum/record `implements` clause, always with provenance \"declared\".",
    "Static and on-demand (`import x.y.*`) imports are folded to module-level import edges; the wildcard case names the package, not the individual types it brings in.",
    "Overloads are distinguished by the id's signature disambiguator, so an unresolved parameter type changes the id — a resolution failure shows up as a stub target, never as a merged entity.",
    "Java generics are erased in the model: type arguments are emitted as reference edges from the declaring entity, and declaredType carries the raw type.",
  ],
};
