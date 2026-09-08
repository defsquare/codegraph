import type { TraitName } from "../names.js";
import type { Space } from "../primitives.js";
import type { Profile } from "../profile.js";

/**
 * TypeScript profile (v2, PLAN.md §14.2 — the compiler-API extractor's
 * contract). The JavaScript kinds plus the type-space ones, and the only
 * profile that uses `Entity.space` (METAMODEL.md §1.4): some entities exist
 * solely at type-check time, so a dependency on them is erased at runtime.
 *
 * The module is the file, always: `TModule.definedIn` holds exactly one path,
 * a script file's globals are children of the file (invariant 5), and a
 * merged declaration is one entity per declaring file. Every invocable that
 * holds parameters or locals declares TWithChildren (the M6 executable-
 * containment decision), and every type and invocable may carry TMetrics.
 */
export const typescriptProfile: Profile = {
  lang: "ts",

  kinds: {
    // A module body is executable code: top-level statements invoke, access
    // and declare locals FROM the module, so the markers are licensed here.
    module: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: [
        "TSourceAnchor",
        "TComment",
        "TMetrics",
        "TWithInvocations",
        "TWithAccesses",
        "TWithLocalVariables",
      ],
    },

    // `namespace X { }` — an internal module: N per file, a child of the file
    // or of the enclosing namespace, never a module of its own (§14.3). Its
    // body is executable like a module's.
    namespace: {
      required: ["TNamed", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TMetrics", "TWithInvocations", "TWithAccesses", "TWithLocalVariables"],
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

    abstractClass: {
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

    // `interface A extends B, C` is inheritance, and it is multiple; an
    // interface never implements.
    interface: {
      required: ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TMetrics"],
    },

    // Type aliases never extend; their constituents are `reference` edges.
    // TTypedEntity: the aliased type, when it is one named type.
    typeAlias: {
      required: ["TNamed", "TType", "TChildOf", "TSourceAnchor"],
      optional: ["TTypedEntity", "TComment", "TMetrics"],
    },

    // Members are `property` children carrying their constant as TWithValue.
    enum: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TMetrics"],
    },

    // TNamed optional: a function EXPRESSION is invocable unnamed, and is
    // then identified by `line:column` like an arrow. TTypedEntity: the
    // return type, when it names a declaration.
    function: {
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
      optional: ["TNamed", "TTypedEntity", "TComment", "TMetrics"],
    },

    method: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithLocalVariables",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TTypedEntity", "TComment", "TMetrics"],
    },

    // No TNamed (a constructor has no own name) and no TTypedEntity (no
    // return type); its parameter properties declare `property` entities too.
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

    // Never TNamed; the id's disambiguator is `line:column` of its first
    // token, so two arrows on one line are two entities.
    arrowFunction: {
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
      optional: ["TTypedEntity", "TComment", "TMetrics"],
    },

    // `var`/`let`/`const` at any level. A function-valued initializer is a
    // separate child entity (hence TWithChildren), never a collapse into one
    // invocable node; a literal initializer of a `const` is its TWithValue.
    variable: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TWithChildren", "TWithValue"],
    },

    // TWithValue: a written default (`retries = 3`).
    parameter: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor", "TWithValue"],
    },

    // Class fields, object-literal members and enum members share this kind;
    // an object literal used as a namespace is a `variable` with `property`
    // children, and a property may itself hold methods (TWithChildren).
    property: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TWithChildren", "TWithValue"],
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

  // The declaration spaces each kind MAY occupy (METAMODEL.md §1.4). This is
  // the licensed superset; the entity records which it actually occupies —
  // a `namespace` exporting only types is `["type"]` even though both are licit,
  // and a `const enum` is `["type"]` where a plain `enum` is both.
  // No other profile declares `space`: absence is the statement that the
  // language has no type/value split, and makes `Entity.space` an error there.
  space: {
    module: ["value"],
    namespace: ["type", "value"],
    class: ["type", "value"],
    abstractClass: ["type", "value"],
    interface: ["type"],
    typeAlias: ["type"],
    enum: ["type", "value"],
    function: ["value"],
    method: ["value"],
    // The same Object.prototype shadowing as the kind table above.
    constructor: ["value"] satisfies readonly Space[],
    arrowFunction: ["value"],
    variable: ["value"],
    parameter: ["value"],
    property: ["value"],
  },

  notes: [
    "This is the only profile that populates `Entity.space` (METAMODEL.md §1.4). Type-space only (`space: [\"type\"]`): `interface`, `typeAlias`, a `const enum` (its members are inlined at emit, leaving no runtime entity), and a `namespace` that declares only types. Both spaces (`[\"type\", \"value\"]`): `class`, `abstractClass`, a plain `enum`, and a `namespace` that declares at least one value. Value-space only (`[\"value\"]`): `module`, `function`, `arrowFunction`, `method`, `constructor`, `variable`, `parameter`, `property`.",
    "A dependency whose target is type-space only is ERASED at runtime: it exists for the type checker and leaves nothing in the emitted JavaScript. Runtime, bundling and deployment analyses should therefore filter edges whose `to` resolves to a `space: [\"type\"]` entity; architectural coupling and design analyses should keep them, since the design dependency is real. Because the distinction is per-analysis, the model always stores both and never pre-filters.",
    "`import type { X }` and inline `type` specifiers produce ordinary `import` edges; they are erased at runtime and are recognized by the space of their target, not by a separate edge kind.",
    "The module is the file: `TModule.definedIn` always has exactly one entry, and every entity's module is the file it is written in — a script file's global declarations included (containment is where a thing is written, CLAUDE.md invariant 5; there is no `<global>` module). A `namespace` block is a child entity of its file or enclosing namespace, never a module. An ambient `declare module \"pkg\"` block in a corpus `.d.ts` IS a module entity, keyed by the quoted name, with `isStub: false` — the corpus declares it, and an import of `pkg` resolves to it.",
    "Key components are percent-encoded: the file path that names a module is made of `/`, which `renderId` reserves, so every path segment and every non-identifier name entering a key encodes exactly `/` as `%2F`, `#` as `%23`, `%` as `%25` and — in names only, where `.` separates nesting — `.` as `%2E`. Identifiers contain none of the four and are written as-is, so the encoding is injective and reversible; the module entity's `name` is the unescaped path. A `#private` member is therefore `Foo.%23secret`, and a string-literal member `\"a.b\"` is `Foo.a%2Eb`.",
    "Declaration merging yields one entity PER DECLARING FILE (the module is the file): `interface Order` in two files is two entities, and two declarations in one file are one entity anchored at the first. An edge to a merged symbol targets the declaration that owns the referenced member; an edge to the merged container itself targets its first declaration in canonical file order — a deterministic choice, not a claim that the others do not exist. A module augmentation of an external type (`declare module \"express\" { interface Request { user: User } }`) makes its members declared entities parented by the stub type.",
    "Structural (non-nominal) typing: a class conforms to an interface without any `implements` clause. `interfaceImplementation` therefore carries provenance `declared` only for an explicit `implements`; conformance computed by shape comparison is `derived`, is never computed by the extractor, and must never be merged with the declared edges. Any analysis wanting facts filters on `declared`.",
    "Corpus membership is a whitelist of the symbols DECLARED in the analyzed sources, never a path-prefix test. What the checker resolves outside the roots is still external: a type declared under `node_modules/<pkg>` is a stub in the module named by the package (the nearest `package.json` name, never the resolved `.d.ts` path, so keys do not depend on what is installed); a type from the compiler's own `lib.*.d.ts` is a stub in the reserved module `<lib>` (`Array`, `Promise`); a name that binds to nothing is a stub in the reserved module `<unresolved>`, named as written — never a guess from the file's imports. A module specifier that resolves to nothing becomes a stub module keyed by the specifier as written, so the import edge survives and import fan-out stays honest. Node built-ins are normalised to the `node:` form.",
    "A bare specifier that names a package declared UNDER the roots (a monorepo's own `@acme/pricing`) resolves by `package.json` name to that package's source entry when standard resolution fails — with nothing installed and nothing built — because a workspace's packages are corpus, not dependencies. Every such resolution is counted separately on stderr; a subpath below such a package resolves the same way below its source root, else stubs.",
    "`any` erases resolution completely: a call or member access through an `any`-typed (or `unknown`, or error-typed, or index-signature) receiver has no target. Such edges are dropped and COUNTED in the stderr summary — never emitted with a guessed `candidates` list, since candidate generation is the analyzer's, which alone has whole-corpus implementor knowledge. The proportion of `any`-typed receivers is the honest ceiling on this profile's resolution rate.",
    "A nameless invocable (arrow function, function expression) is identified by `#line:column` of its first token below the nearest NAMED ancestor's symbol, and below that ancestor's own disambiguator when it has one — a column is a source fact, and two can start on one line. At module top level the symbol is empty and the disambiguator alone identifies it (`ts:src%2Fa.ts#3:15`). `const f = () => {}` yields two entities: the `variable` f and its child `arrowFunction`; call sites resolve through the variable to the arrow, and `invocation` edges target the `arrowFunction`. A class expression with no binding is not an entity (dropped and counted).",
    "Overloads are ONE entity: TypeScript has no overloading by parameter type at the declaration level, so a function's overload signatures and its implementation share one key with no parameter-list component; the entity is anchored at the implementation (or the sole ambient signature). Members TypeScript lets coexist under one name carry a disambiguator: `#static` for a static member beside an instance one, `#get`/`#set` for an accessor pair; a member without a twin renders with no suffix.",
    "Ambient declarations (`.d.ts`, `declare module`, `declare global`) under the roots describe entities with no implementation in the corpus. They are emitted as real entities anchored in the `.d.ts`; the implementation they describe, when outside the corpus, is a stub.",
    "`declaredType` is populated from the checker's type where it names ONE declaration — annotated or inferred alike; a union, intersection, literal, primitive, type-parameter or anonymous type leaves it absent rather than guessed, which is why `TTypedEntity.declaredType` is optional even where the trait is required.",
    "Generic type parameters are not reified as entities; a use of `Array<Order>` yields a `reference` edge to `Order` and one to `<lib>/Array`, and none to `Array`'s parameter slot. A type parameter's constraint and default are `reference` edges from the declaring entity.",
    "Decorators are `annotationUse` edges carrying their arguments as written values, under both the legacy (`experimentalDecorators`) and the TC39 syntax; the decorator itself is an ordinary `function` or `variable` entity. `emitDecoratorMetadata` synthesizes nothing the model shows.",
    "A JSX element whose tag names a component (`<OrderTable/>`) is an `invocation` of that component — an element is a call by the language definition, so the edge is `declared`; an intrinsic tag (`<div>`) yields nothing.",
    "A `throws` edge is emitted per written `throw` statement whose static type names a declaration, anchored at the throw site; a rethrow targets the caught binding's static type; a thrown string or `any` is dropped and counted.",
    "Measures (TMetrics, METAMODEL.md §3.8): `sloc` on every type and invocable — lines of its own span that are neither blank nor comment-only, counted with the compiler's own scanner, so template literals, regular expressions and JSX text cannot swallow a comment marker. `cyclomatic` on invocables only: 1 + if / for / for-in / for-of / while / do / non-default case / catch / ternary / `&&` / `||` / `??`. A nested arrow or function does NOT contribute to its enclosing invocable: it is its own invocable and carries its own count.",
    "Path resolution depends on `tsconfig` `paths`, `baseUrl`, `rootDirs` and `package.json` fields; the extractor reads a `tsconfig.json` for those RESOLUTION options only — never for `files`/`include` (the roots define the corpus) and never for project `references` — and creates one program over every source file under the roots. Nothing is built and `node_modules` is never required.",
    "Dynamic `import(expr)` and `require(expr)` with a computed, template-literal or variable path are unresolvable: no `import` edge is emitted, and the site is counted. Only statically literal specifiers produce edges. CommonJS `module.exports` reassignment shapes beyond a literal `require`, monkey patching (`Obj.prototype.m = fn`, `Object.assign`), `this` rebinding through `call`/`apply`/`bind`, and computed member access `o[k]` with a non-literal key follow the JavaScript profile's rules: no entity is invented and the site yields at most `access`/`reference` edges at the patch site, or nothing.",
    "Getters and setters are `method` entities; a property access that runs an accessor is an `access` edge, not an invocation, so a read that runs code is visible as access. Class fields and object-literal members share the `property` kind.",
  ],
};
