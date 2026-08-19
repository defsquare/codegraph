import type { Profile } from "../profile.js";

/**
 * JavaScript — the untyped baseline. Two absences carry information:
 * no `interfaceImplementation` (nothing declares conformance) and a
 * `TTypedEntity.declaredType` that is almost never populated.
 */
export const javascriptProfile: Profile = {
  lang: "js",

  kinds: {
    // The module is the file: TModule.definedIn holds exactly one path.
    module: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TSourceAnchor", "TComment"],
    },

    // No TWithImplements: JS has no `implements` clause.
    class: {
      required: ["TNamed", "TType", "TChildOf"],
      optional: ["TWithInheritances", "TWithChildren", "TSourceAnchor", "TComment"],
    },

    // TNamed is optional: anonymous function expressions (`export default
    // function () {}`, callbacks) are invocable without a name.
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

    // Never TNamed. TSourceAnchor is required because the id's disambiguator
    // is (file, startLine): without the anchor the entity has no identity.
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

    // `var`/`let`/`const`. Value holder only; a function-valued initializer is
    // a separate child entity, not a collapse into one invocable node.
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

  edges: ["import", "inheritance", "invocation", "access", "reference"],

  notes: [
    "A module is a file: `TModule.definedIn` always has exactly one entry (1-1 cardinality, unlike a Java package).",
    "No `interfaceImplementation` edge kind. JS has no `implements` clause and conformance is duck-typed, so it is never observable statically — the absence of the edge kind is the honest statement, not a gap to fill later with guesses.",
    "`TTypedEntity` is licensed on variables, parameters, properties and function returns, but `declaredType` is essentially always absent: JS annotates nothing. This is exactly why the attribute is optional rather than required by the trait. An extractor may populate it from JSDoc `@type`/`@param`/`@returns` when present; everything else is left absent rather than inferred.",
    "Arrow functions and anonymous function expressions carry `TInvocable` without `TNamed`; their id disambiguator is `(file, startLine)`, so they require `TSourceAnchor`.",
    "`const f = () => {}` yields two entities: the `variable` f and its child `arrowFunction`. Call sites resolve through the variable to the arrow, and `invocation` edges target the `arrowFunction`.",
    "Dynamic `import(expr)` and `require(expr)` with a computed, template-literal or variable path are unresolvable: no `import` edge is emitted. Only statically literal specifiers produce edges.",
    "CommonJS/ESM interop is a blind spot: `module.exports = X`, `exports.a = ...`, `__esModule` interop shims and conditional `package.json` exports mean the same physical file can be reached under several specifiers. Ids are keyed on the resolved file path, so a resolver failure produces a stub module rather than a wrong merge.",
    "Monkey patching (`Obj.prototype.m = fn`, `Object.assign(target, mixin)`, `Object.defineProperty`) adds members at runtime. No method or property entity is created for them; the assignment surfaces only as `access` and `reference` edges at the patch site.",
    "Duck typing means a call `x.m()` on an unannotated receiver has no resolvable target. Such invocations are either omitted or emitted with provenance `dynamic-candidate` and every same-named method in the corpus listed in `candidates`.",
    "Computed member access `o[k]` and dynamic property names give `access` edges whose target is unknown; they are omitted rather than guessed at a single field.",
    "`this` rebinding (`call`/`apply`/`bind`, arrow lexical `this`, extracted methods) breaks receiver-based resolution; edges through a rebound `this` are not reconstructed.",
    "Getters/setters are emitted as `method` entities; reads and writes of the underlying value at call sites are `access` edges, so a property read that runs code is visible as access, not invocation.",
    "Class fields and object literal members share the `property` kind; object literals used as namespaces therefore appear as a `variable` with `property` children.",
  ],
};
