import type { Profile } from "../profile.js";

/**
 * PHP: the only profile with file-level dependencies. `codeFile` reifies the
 * CodeFile of METAMODEL.md §1.5 so `fileInclude` edges have real endpoints, and
 * `traitUsage` keeps `use TraitX;` as a relation instead of flattening it.
 */
export const phpProfile: Profile = {
  lang: "php",
  kinds: {
    codeFile: {
      // Exists so fileInclude has endpoints; declarations hang off the namespace,
      // not off the file, so TWithChildren is optional (script files with no namespace).
      required: ["TNamed"],
      optional: ["TWithChildren", "TSourceAnchor", "TComment"],
    },
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
    interface: {
      // Interfaces extend interfaces (N of them) but implement nothing.
      required: ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    trait: {
      // A PHP trait is a type-like member holder; it neither extends nor implements.
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    enum: {
      // TTypedEntity carries the backing type of a backed enum.
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TWithImplements", "TTypedEntity", "TComment"],
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
      // No TAttachedTo: a trait method stays a child of its trait, and the
      // traitUsage edge — never flattening — carries it into the using class.
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
    property: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    constant: {
      required: ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"],
      optional: ["TTypedEntity", "TComment"],
    },
    parameter: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor"],
    },
    closure: {
      // `function () {}`, `fn () =>` and first-class callable syntax: no TNamed.
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
    "traitUsage",
    "fileInclude",
  ],
  notes: [
    "fileInclude (include/require/_once) is the metamodel's only file-to-file dependency; its endpoints are `codeFile` entities. A file both declares entities and includes other files, so the same file appears as a codeFile node and as the `anchor.file` of the declarations it contains.",
    "include/require paths built from variables, concatenation, constants or __DIR__ arithmetic are invisible: only literal paths produce a fileInclude edge.",
    "`use TraitX;` is a traitUsage edge Type -> Trait and the trait's members are NEVER flattened into the using class. Conflict resolution (`insteadof`, `as`, visibility changes) and abstract trait members are not represented; a resolver must read the trait's own children.",
    "`use Foo\\Bar;` statements are per-file aliases, not namespace-level facts: emit them as import edges and set `sourceFile` to the declaring file so several files sharing a namespace stay distinguishable.",
    "__call/__callStatic/__get/__set/__invoke are dynamic dispatch: invocation and access edges through magic methods carry provenance 'dynamic-candidate' with a candidates list, or are absent when no candidate can be named.",
    "Variable variables ($$name), variable functions ($fn()), call_user_func, `new $class` and string class names resolve only for literal arguments; everything else is invisible.",
    "eval(), conditional declarations inside if/function bodies, and class_alias() are not modelled.",
    "Single inheritance for classes (at most one inheritance edge); interfaces may extend several, so N edges are legal there.",
    "Gradual typing: parameter, property and return type declarations are optional, so TTypedEntity.declaredType is often absent. Docblock types (@var, @param) are not authoritative and must not be promoted to declaredType.",
    "Namespaces are 1-N with files: TModule.definedIn lists every file declaring into the namespace. A file with no `namespace` statement declares into the global namespace.",
  ],
};
