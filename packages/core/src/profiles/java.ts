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
    // To the JLS a package is a flat namespace, but the source tree nests them,
    // and Spoon models that structure. TChildOf is optional and, when present,
    // points at the nearest ANCESTOR package that itself holds corpus types —
    // walked structurally, never derived from the dotted name, so a pure
    // namespace prefix (`com`, `org.apache`) is never invented as a container.
    // Stub packages stay flat: their ancestry is not in the corpus.
    package: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TComment", "TChildOf"],
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
      optional: ["TComment", "TMetrics"],
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
      optional: ["TComment", "TMetrics"],
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
      optional: ["TComment", "TMetrics"],
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
      optional: ["TComment", "TMetrics"],
    },

    annotation: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TMetrics"],
    },

    // TWithChildren: a method lexically contains its parameters and locals, and
    // they declare it as their parent. Both directions of §3.2 must be licensed
    // by the same profile or the model states a containment its own contract
    // does not allow.
    method: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TTypedEntity",
        "TChildOf",
        "TSourceAnchor",
      ],
      // TWithValue on a METHOD is the annotation-element `default` — the one
      // place Java writes a value on something invocable.
      optional: ["TComment", "TMetrics", "TWithValue"],
    },

    // No TNamed (a constructor has no own name) and no TTypedEntity (it has no
    // return type); the id's disambiguator is the signature.
    // `constructor` is the one kind name TypeScript will not contextually type
    // from an index signature (Object.prototype shadows it), hence `satisfies`.
    constructor: {
      required: [
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ] satisfies readonly TraitName[],
      optional: ["TComment", "TMetrics"] satisfies readonly TraitName[],
    },

    // Lambdas and anonymous classes: invocable but nameless; the id's
    // disambiguator is `(file, line, column)`.
    lambda: {
      required: [
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TTypedEntity", "TMetrics"],
    },

    // TWithValue: a `static final` compile-time constant's initializer (§1.6).
    // Optional and often absent — an initializer that is not constant carries
    // no value at all, which is not the same claim as an empty one.
    attribute: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TWithValue"],
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
    "annotationUse",
  ],

  notes: [
    "Measures (TMetrics, METAMODEL.md §3.8): `sloc` on every type and invocable — lines of its own span that are neither blank nor comment-only, counted by a scanner that knows string and text-block literals, so a `\"/*\"` in the source does not swallow the rest of the file. `cyclomatic` on invocables only: 1 + if / for / foreach / while / do / non-default case label / catch / ternary / short-circuit && and || / switch pattern guard. Purely syntactic, hence immune to the noClasspath resolution ceiling. A nested lambda or anonymous class does NOT contribute to its enclosing method: it is its own invocable and carries its own count. A type's complexity is therefore not stored — it is the sum over its members, which the consumer computes.",
    "A corpus is not a compilation unit. Spoon compiles every source root as a single JDT batch, so two Maven/Gradle modules that each declare the same fully-qualified name — legal, since neither module sees the other — collide as IProblem.DuplicateTypes. The extractor tolerates the collision rather than aborting (measured: one collision in a test helper aborted the extraction of a 4,972-file repository), but JDT keeps only the FIRST declaration it reached: the later file contributes no entity and no edge. Every dropped declaration is named on stderr, so a model of a multi-module corpus can legitimately be missing a type its sources contain.",
    "Spoon in noClasspath mode invents plausible fully-qualified names for unresolved types. Corpus membership is therefore decided by a whitelist of ids actually declared by the corpus (built in a first pass); anything else is emitted as an isStub entity. Never decide membership by package or name prefix — invented FQNs look exactly like real ones and a prefix filter would launder them into facts.",
    "Reflection is invisible: Class.forName, Method.invoke, proxies, Spring XML/annotation wiring, ServiceLoader/META-INF/services, and JNDI lookups produce no edge. The import/invocation graph of a reflection-heavy corpus is a lower bound.",
    "Lombok-generated members (getters, setters, @Builder, @Data constructors) are emitted with provenance \"generated\" when the expansion is visible to Spoon, and are missing entirely when it is not.",
    "An interface's `extends` list is emitted as inheritance edges between types; interfaceImplementation is reserved for a class/enum/record `implements` clause, always with provenance \"declared\".",
    "Static and on-demand (`import x.y.*`) imports are folded to module-level import edges; the wildcard case names the package, not the individual types it brings in.",
    "Overloads are distinguished by the id's signature disambiguator, so an unresolved parameter type changes the id — a resolution failure shows up as a stub target, never as a merged entity.",
    "Java generics are erased in the model: type arguments are emitted as reference edges from the declaring entity, and declaredType carries the raw type.",
    "noClasspath resolution rate, measured (M2 audit): 100.0% on apache/commons-lang (263 files, 133478 type references, 0 unresolved) and 77.8% on spring-petclinic (30 files, 2189 references, 487 unresolved, all of them Spring and Jakarta types whose jars are absent). The rate is a property of the corpus's DEPENDENCY SURFACE, not of the extractor: commons-lang is self-contained and depends on nothing but the JDK, which resolves against the runner's own classpath. A jar that is not on the classpath cannot be resolved by any extractor, so a corpus with third-party dependencies has a structural ceiling well below 100% and a single cross-corpus target number is not meaningful. The stub discipline, not the resolution rate, is the property worth asserting.",
    "The resolution rate counts neither type variables nor `<nulltype>`: neither names anything that could have a declaration, so counting them measures the corpus's writing style. This is not cosmetic — `<nulltype>`, Spoon's static type for the `null` literal, was ALL 1466 of commons-lang's originally-reported unresolved references, making the headline number a function of how many `return null;` statements the corpus contains.",
    "In noClasspath Spoon promotes an unresolvable RECEIVER to a type in the enclosing package: `typeHint -> typeHint.with(...)` and `cm.setStatisticsEnabled(...)` produced stub classes named `typeHint` and `cm` inside the corpus's own package on spring-petclinic. They are correctly stubbed (membership is the declared-id whitelist), and they are why the whitelist exists — but the stub set of a real corpus therefore contains a tail of entities named after local variables, and a stub count is not a count of external types.",
    "An array type is not an entity, and neither is its component where a member is concerned. `xs.length` and `int[]::new` declare their member on `int[]` / `Money[]`; folding that up names the component and states a fact the source never wrote. Such facts are dropped, not degraded — the dependency on the component is already carried by the written type reference that mentions it.",
    "An anonymous class has exactly one id, the `#file:line:column` form pass 1 declared. Spoon names it `Outer$N`, which renders as a plausible nested-type id in the corpus's own package; a reference resolved through that name gives one declared class two ids and launders the second into a stub. Type references must be resolved to their declaration before being named.",
    "Spoon materializes the implicit constructor of an anonymous class with synthetic parameters named `$anonymousN`. They are emitted (implicit members are, deliberately, so that `new Foo()` does not dangle), so the model contains a handful of parameter entities nobody wrote, carrying no anchor of their own — 5 of 15338 entities on commons-lang.",
  ],
};
