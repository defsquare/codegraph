import type { Profile } from "../profile.js";

/**
 * Python: a module *is* a file (TModule.definedIn holds exactly one path), and
 * almost nothing is statically guaranteed — hence the reliance on `derived`,
 * `dynamic-candidate` and `generated` provenance rather than richer traits.
 */
export const pythonProfile: Profile = {
  lang: "python",
  kinds: {
    module: {
      required: ["TNamed", "TModule", "TWithChildren"],
      // TChildOf links a submodule to its package's `__init__` module.
      optional: ["TChildOf", "TSourceAnchor", "TComment"],
    },
    class: {
      required: [
        "TNamed",
        "TType",
        "TWithInheritances",
        "TWithChildren",
        "TChildOf",
        "TSourceAnchor",
      ],
      // A class body is executable code, so it may itself call and read.
      optional: ["TWithImplements", "TWithInvocations", "TWithAccesses", "TComment"],
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
      // TAttachedTo only for functions bound onto a class they are not written in.
      optional: ["TAttachedTo", "TComment"],
    },
    attribute: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },
    variable: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor", "TComment"],
    },
    parameter: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor"],
    },
    lambda: {
      // No TNamed and no TWithLocalVariables: a lambda body is one expression.
      required: [
        "TInvocable",
        "TWithParameters",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TTypedEntity"],
    },
    decorator: {
      // The decorator *application*, not the decorator callable (that is a function):
      // it attaches to the decorated entity and invokes the callable.
      required: ["TAttachedTo", "TWithInvocations", "TSourceAnchor"],
      optional: ["TNamed", "TChildOf", "TComment"],
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
    "A module is a file: TModule.definedIn holds exactly one path (1-1 cardinality). A package is the module of its __init__.py.",
    "Multiple inheritance emits N inheritance edges from the class. MRO (C3 linearization) order is NOT represented: the edge set is unordered, so method-resolution questions cannot be answered from the model.",
    "Protocols (PEP 544) are structural, never declared: conformance yields interfaceImplementation edges with provenance 'derived'. Explicit `class X(Protocol)` subclassing is a plain declared inheritance edge instead.",
    "Decorators that synthesize members (dataclasses, attrs, ORM/metaclass bases) emit the members and their edges with provenance 'generated'; a pre-expansion extraction sees none of them.",
    "Duck typing: a call whose receiver type is not statically known resolves to provenance 'dynamic-candidate' with a candidates list, or is absent entirely.",
    "Monkey patching (assigning functions or attributes onto classes and modules at runtime) is invisible to static extraction; the model shows the original definition site only.",
    "getattr/setattr/hasattr and importlib.import_module/__import__ resolve only for literal string arguments; computed names produce no edge.",
    "Type hints are optional and may be deferred strings (PEP 563 / `from __future__ import annotations`), so TTypedEntity.declaredType is frequently absent even where the trait is present.",
    "`from x import *` yields a module-level import edge only; the individual names it binds cannot be attributed.",
    "Conditional and `if TYPE_CHECKING:` imports are emitted like any other import — this profile declares no Space, so type-only dependencies are indistinguishable from runtime ones.",
  ],
};
