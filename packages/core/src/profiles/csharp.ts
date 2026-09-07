import type { TraitName } from "../names.js";
import type { Profile } from "../profile.js";

/**
 * C# profile (v2, PLAN.md §13.2 — the Roslyn extractor's contract). Trait sets
 * are per-kind: a struct or enum cannot inherit, an interface cannot
 * implement, so those markers are absent where the language cannot produce
 * the corresponding edge (METAMODEL.md §3.4). Every invocable that holds
 * parameters or locals declares TWithChildren (the M6 executable-containment
 * decision), and every type and invocable may carry TMetrics (M10b).
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
      optional: ["TComment", "TMetrics"],
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
      optional: ["TComment", "TMetrics"],
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
      optional: ["TComment", "TMetrics"],
    },

    // TTypedEntity carries the underlying integral type (`enum E : byte`).
    enum: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TTypedEntity", "TComment", "TMetrics"],
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
      optional: ["TComment", "TMetrics"],
    },

    // A delegate is a type that is also invocable: TType + TInvocable, with
    // TTypedEntity as the return type.
    delegate: {
      required: [
        "TNamed",
        "TType",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TTypedEntity",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment", "TMetrics"],
    },

    // TAttachedTo is present exactly on extension methods: written inside a
    // static class, semantically belonging to the extended type.
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
      optional: ["TAttachedTo", "TComment", "TMetrics"],
    },

    // No TNamed and no TTypedEntity; the id's disambiguator is the signature.
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

    // A value holder whose accessors may hold bodies, hence the optional
    // invocation/access markers — and TWithChildren, because an accessor body
    // declares locals and lambdas whose parent is the property.
    // TAttachedTo: an extension property (C# 14 `extension(T t) { … }` block),
    // written in the static host, belonging to the receiver — like extension methods.
    property: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TWithInvocations", "TWithAccesses", "TAttachedTo", "TComment", "TMetrics"],
    },

    // A `const` field and an enum member carry their constant as TWithValue;
    // a field whose initializer is code carries no value (absence is a claim).
    field: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TWithValue"],
    },

    // A value-shaped member with its own declaration site; `+=`/`-=` are
    // access edges. Folding it into `field` would lie about the kind and into
    // `property` about accessors.
    event: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },

    // TWithValue: a written default (`int retries = 3`).
    parameter: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor", "TWithValue"],
    },

    localVariable: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor"],
    },

    // Lambdas and anonymous methods: invocable without a name; the id's
    // disambiguator is `(file, line, column)` — two nameless entities can
    // start on one line (`Chain(() => a, () => b)`), and a column is a source
    // fact where an ordinal would depend on walk order.
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
  },

  edges: [
    "import",
    "inheritance",
    "interfaceImplementation",
    "invocation",
    "access",
    "reference",
    "annotationUse",
    "throws",
  ],

  notes: [
    "Partial classes (and partial methods) mean one entity id is declared across several files: the entity carries a single anchor for its primary declaration, while each edge carries sourceFile to say which declaration site produced it. Merging by id is correct here, not a collision.",
    "`var`, target-typed `new()`, anonymous types and inferred lambda parameters leave TTypedEntity present with declaredType absent — the trait states that the entity has a type, not that the extractor resolved one.",
    "Extension methods are children of their static host class but carry TAttachedTo pointing at the extended type; a call site written as instance syntax is still an invocation edge to the static method.",
    "Reflection is invisible: Type.GetType, Activator.CreateInstance, expression trees and source-generated partials leave no edge unless the generated source is part of the analyzed root (then provenance is \"generated\").",
    "Dependency-injection wiring is invisible: container registrations (Microsoft.Extensions.DependencyInjection, Autofac, …) bind an interface to an implementation at runtime, so no invocation edge links a consumer to the concrete type it will receive.",
    "Virtual dispatch and calls through an interface resolve to the DECLARED member (the one the source names); the implementation actually run is a whole-corpus question the analyzer answers. A `dynamic` receiver binds to no symbol at all, so the call site is dropped and counted in the stderr summary — an extractor guessing targets from the file's `using` directives would be inventing edges.",
    "`using` directives, `global using` and using aliases are folded to module-level import edges to the imported namespace, never to individual types.",
    "Corpus membership is a whitelist of the type symbols DECLARED in the analyzed sources, never a namespace-prefix test. Roslyn resolves what it can against the BCL reference assemblies the extractor carries (so `string` is a stub in module `System`, with its real namespace); a name it cannot bind is an error type, emitted as a stub in the reserved module `<unresolved>` under the name as written — the honest form, since guessing a namespace from the file's `using` directives would invent a fully-qualified name.",
    "Generic arity is part of a type's symbol (`Repository`1`, Roslyn's metadata name): `Foo`, `Foo<T>` and `Foo<T,U>` legally coexist in one namespace, so Java-style erasure to the bare name would merge three declarations into one entity. Signatures use fully-qualified metadata names WITH type arguments (`System.Func`2<!!0,System.String>`), because C# can overload on type arguments alone (`Humanize(Func<T,string>)` beside `Humanize(Func<T,object>)`, found on Humanizer); type parameters are ECMA-335 ordinals, nullable annotations and ref/out/in are dropped.",
    "A corpus is not a compilation unit: two projects that never see each other may both declare a non-partial `static class Extensions` with the same member, and every service has its own top-level `Program.cs` (found on dotnet/eShop). In one compilation they are one type with several same-keyed members. Every one is kept: the first declaration in ordinal file order owns the plain key, each later one is re-keyed by its file (`…#in:Catalog.API/Program.cs`, a source fact like a lambda's position), and every re-keying is named on stderr. Dropping later ones — the JDT rule the Java profile documents — would erase nine services' DI wiring out of ten.",
    "Members of a C# 14 extension block (`extension(Money m) { … }`, found on Humanizer) are members of the enclosing static class carrying TAttachedTo → the receiver type, exactly like classic extension methods; the block itself, a nameless nested type to Roslyn, is no entity.",
    "Microsoft.NET.Sdk's seven implicit global usings (System, System.Collections.Generic, System.IO, System.Linq, System.Net.Http, System.Threading, System.Threading.Tasks — what `<ImplicitUsings>enable` generates into obj/, which is build output and skipped) are added to the compilation by default (`--implicit-usings sdk`); without them `Task`, `List<T>` and `CancellationToken` were the most-referenced unresolved names on OrchardCore. The Web SDK's additions (`Microsoft.AspNetCore.*`, `Microsoft.Extensions.*`) are opt-in (`web`): one compilation cannot apply them per project, and on a mixed corpus they make names ambiguous — OrchardCore's own `StartupBase` collided 345 times with `Microsoft.AspNetCore.Hosting.StartupBase`. Implicit usings write no import edge: no file wrote them. The ASP.NET Core shared framework's reference pack is embedded beside the BCL's when the building SDK has it.",
    "An ambiguous name is unresolved: two corpus types with one simple name whose projects each `global using` their own namespace (dotnet/eShop's two `CatalogItem`) collide once those usings merge into one compilation, and the reference lands in `<unresolved>` rather than on a guess between the two.",
    "Two parameters may share a name (`(_, _) => …` discards, found on OrchardCore): the second and later same-named parameters carry their ordinal (`#param:_:1`).",
    "A nameless invocable (lambda, anonymous method) is identified by `#file:line:column`; a column is a source fact, and two can start on one line. A local's id carries line AND column for the same reason (`#local:name:line:column`); a local function is a `method` below its invocable (`#fn:Name(params)`).",
    "Members Roslyn synthesizes and nobody wrote — a record's Equals/GetHashCode/Deconstruct/copy constructor, backing fields, an enum's `value__` — are not entities, and neither are accessors (their bodies charge to the property). A call to such a member folds to its containing type, the rule that already governs members of stubs. The one implicit member emitted is the parameterless constructor, anchored at the type's header line so `new T()` does not dangle.",
    "An attribute is an `annotationUse` edge carrying its arguments as written values — positional ones named after the bound constructor's parameters — and nothing inside the attribute produces an access or reference edge of its own. A method group used as a value (`new Handler(Zero)`) is a `reference` to the method, not an invocation.",
    "A `reference` edge comes from the narrowest declared owner of the written type — a parameter's type from the parameter, a field's from the field — and locals never own edges: an initializer's call is the invocable's dependency, and the local's own type rides on declaredType.",
    "Primitives resolve: `int` IS `System.Int32`, so unlike Java they become BCL stubs rather than being omitted. `void`, `dynamic`, anonymous types, pointer types and type parameters are not entities and leave declaredType absent.",
    "Neither a `.sln` nor a `.csproj` is read: the extractor parses every `*.cs` under the source roots into ONE compilation (no MSBuild, no restore), so a legacy tree with no restorable project graph still extracts, and a missing package is a stub rather than a build failure. Consequences: one preprocessor configuration is parsed (no `--define` yet); source-generated and XAML/Razor code-behind partials are absent unless their output is under the roots; a name declared twice across projects that never see each other collides as one entity.",
  ],
};
