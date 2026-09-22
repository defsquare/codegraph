---
title: TypeScript extractor
linkTitle: TypeScript extractor
weight: 11
---

`codegraph-typescript` 0.1.0 — the TypeScript extractor on the compiler API. A pnpm workspace package in `extractors/typescript/`, whose only runtime dependency is `typescript` itself: the same package that ships `tsc`, whose checker binds everything it can and tolerates everything it cannot. **Every `*.ts` under the roots goes into one program**; a `tsconfig.json` is read for resolution options only; nothing is built, no `tsc` is run, and a package that is not installed is a stub, not a failure. It emits [`model.jsonl`](/docs/reference/model-jsonl/) and nothing else: all trait, profile and validation logic lives in `@codegraph/core`.

```bash
npx codegraph-typescript --src <dir> --out model.jsonl          # the npm package; Node 22, nothing else
brew install defsquare/tap/codegraph-typescript                  # the same package on Homebrew's node
codegraph-typescript --src <dir> --out model.jsonl

# from a clone — codegraph on itself: the workspace's packages, by name, with nothing built
pnpm install && pnpm -r build
./bin/codegraph-typescript --src packages --src extractors/typescript --out codegraph.jsonl
```

The package and the launcher both run the bundle at `dist/cli.js`. The bundle leaves `typescript` outside itself on purpose: the compiler locates its `lib.*.d.ts` files beside its own `typescript.js`, so a bundle that inlined it would bind no standard library and every `Array` would become an `<unresolved>` stub. Node 22 is the only other requirement.

## Synopsis

```
codegraph-typescript [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                     [--tsconfig <file>|none] [--allow-js] [--ignore-node-modules]
                     [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
                     [--version] [--help]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src <dir>` | source root; repeatable. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's `root`. `node_modules`, `.git` and `dist` are skipped: dependencies and build output are never sources | the current directory |
| `--out <file>` | where to write the model | `<current-dir>-codegraph.jsonl` |
| `--progress <m>` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` | `auto` |
| `--no-progress` | same as `--progress none` | — |
| `--tsconfig <file>` | the `tsconfig.json` whose **resolution** options apply (`paths`, `baseUrl`, `rootDirs`, `jsx`, `lib`, `target`, `allowJs`, decorators, module suffixes) — never its `files`/`include`, never its project `references`; `none` for the synthesized defaults (`target esnext`, `moduleResolution bundler`, `lib esnext + dom`, `jsx preserve`) | the nearest `tsconfig.json` at or above each root; with several roots the first root's wins and the others are named on stderr |
| `--allow-js` | also walk `*.js`, `*.jsx`, `*.mjs`, `*.cjs`; JSDoc types feed `declaredType`; the model still claims `lang: "ts"` | — |
| `--ignore-node-modules` | never read `node_modules`, even when present: every external package becomes an unresolved stub module and every call into it is dropped and counted | — |
| `--version` | print the extractor version | — |
| `--help` | print the help and exit | — |

### Repository provenance

Copied verbatim into the header; the extractor runs no git — whoever invokes it supplies the facts, as [`snapshots`](/docs/reference/cli/snapshots/) does.

| Option | Meaning |
|---|---|
| `--repo-remote <url>` | normalized https clone URL, no `.git` suffix |
| `--repo-commit <sha>` | the sha this tree is at — a permalink, not a branch |
| `--repo-root <path>` | the analyzed root RELATIVE to the repository root (default: empty — they are the same directory) |
| `--repo-provider <p>` | `github` \| `gitlab`, only when the hostname does not say |

Exit codes: `0` success · `1` failure · `2` bad usage · `3` an extraction pass not implemented yet.

## How it resolves without a build

- **A monorepo's own packages resolve by name with nothing installed.** A bare specifier that names a `package.json` under the roots (`@acme/pricing`) resolves to that package's *source* entry — the `source`/`types`/`main` field when it points at a file under the roots, else `src/index.ts` — and only after standard resolution failed, or landed in the package's own `dist/` through a workspace symlink. Counted separately on stderr as `workspace-resolved`. It never reads `node_modules` to do so.
- **Installed packages are external.** A type declared under `node_modules/<pkg>` is a stub in the module named by the package (`zod/ZodType`), never by the resolved `.d.ts` path, so keys are the same on every machine; an import of `zod/v4` is a stub module keyed by the specifier as written.
- **The standard library resolves and is still external**: `Array`, `Promise`, `Error` are stubs in the reserved module `<lib>`. A name the checker cannot bind is a stub in `<unresolved>`, named as written — never a guess from the file's imports. A module specifier that resolves to nothing becomes a stub module keyed by the specifier, so the import edge survives.

## Streams

stdout carries nothing but `--help` and `--version`. Progress and the **resolution summary** go to stderr. This is codegraph over itself:

```text
✓ program    310 files, tsconfig none  2.4s
✓ entities   24887 entities  1.1s
✓ edges      51255 edges  1.8s
✓ stubs      411 stubs  0.1s
✓ write      76464 records  0.4s
RESOLUTION SUMMARY
  type references : 4500
  resolved        : 4340
  unresolved      : 160
  resolution rate : 96.5%
  any-typed receivers (dropped) : 193
  imports         : 1607 (unresolved: 2, workspace-resolved: 168)
  entities        : 24887 (stubs: 411 — lib 55, packages 300, <unresolved> 0, modules 56)
  edges           : 51255 (self-edges dropped: 89, indirect calls dropped: 143, computed accesses dropped: 607, …)
  duplicates      : 0 same-keyed declarations re-keyed (first in file order keeps the plain key)
  unclosable      : 0 edges dropped (an endpoint no entity declares)
wrote codegraph.jsonl
```

- **resolution rate** measures the corpus's *dependency surface*, not the extractor. The 160 unresolved references above are type-space names the checker could not name — every one an external type or a type parameter the model does not reify — and `<unresolved> 0` says no name the corpus *declares* was missed.
- **any-typed receivers** is this profile's stated ceiling: a call or member access through an `any`/`unknown`/error-typed receiver has no target and is dropped, never guessed. The proportion is a fact about the corpus's typing.
- **indirect calls** are calls through a parameter or local of function type (`callback()`): no declaration to name statically. **computed accesses** are `obj[key]` with a non-literal key.
- **stubs** by origin: the compiler's lib, installed packages, unbound names, and stub modules (unresolved or external specifiers).
- **duplicates** are same-keyed declarations in one file the language does not merge — the later one re-keyed by its position and named on stderr.
- **unclosable** edges point at an entity nothing declares; they are dropped, never written dangling. Zero on every audited corpus; a non-zero count is a bug report against the id scheme.

Measured with no `node_modules` (M13c audit): 97.4% on microsoft/TypeScript 4.9.5 `src/compiler` (2 684 any-typed receivers), 88.6% on nestjs/nest `packages` (20 745), 94.4% on excalidraw (24 954), 96.5% on codegraph itself. Those any-receiver counts are what an uninstalled dependency surface costs: install the dependencies to fold the calls into their packages' stubs instead.

## The TypeScript profile

The mapping the extractor must respect, rendered from `codegraph profiles --lang ts`. `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`. This is the only profile that populates `Entity.space`: the last column says whether a kind exists for the type checker, at runtime, or both.

| Kind | Required traits | Optional traits | Space |
|---|---|---|---|
| `abstractClass` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` | type, value |
| `arrowFunction` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TComment`, `TMetrics` | value |
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` | type, value |
| `constructor` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` | value |
| `enum` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` | type, value (`const enum`: type) |
| `function` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TNamed`, `TTypedEntity`, `TComment`, `TMetrics` | value |
| `interface` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` | type |
| `method` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TComment`, `TMetrics` | type in an interface body, value in a class or object literal |
| `module` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses`, `TWithLocalVariables` | value |
| `namespace` | `TNamed`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses`, `TWithLocalVariables` | type, value (type only when it declares only types) |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor`, `TWithValue` | value |
| `property` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TWithChildren`, `TWithValue`, `TWithInvocations`, `TWithAccesses` | type in an interface body, value otherwise |
| `typeAlias` | `TNamed`, `TType`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TComment`, `TMetrics` | type |
| `variable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TWithChildren`, `TWithValue`, `TWithInvocations`, `TWithAccesses` | value |

**Edge kinds emitted:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference` · `annotationUse` · `throws`

| TypeScript construct | Kind |
|---|---|
| a file; an ambient `declare module "pkg"` block in a corpus `.d.ts` | `module` — the module *is* the file, keyed by its root-relative path |
| `namespace` block | `namespace` — a child of its file, never a module |
| class, class expression bound to a name | `class`; `abstract class` → `abstractClass` |
| interface | `interface` |
| type alias | `typeAlias` |
| enum, `const enum` | `enum`; members are `property` children |
| function declaration, function expression, generator | `function` |
| arrow function | `arrowFunction` — `const f = () => {}` is a `variable` **and** its child arrow; calls resolve through the variable to the arrow |
| method, getter (`#get`), setter (`#set`) | `method` |
| constructor | `constructor` |
| `const`/`let`/`var`, an object literal bound to a name (its members are entities below it) | `variable` |
| parameter, destructured parameter (`#param:rows`); a parameter property is also a `property` | `parameter` |
| class field, object-literal member, enum member, interface member | `property` |

Keys are **percent-encoded**: a module's symbol is its path with `/` as `%2F`, `#` as `%23`, `%` as `%25` (`packages%2Forder%2Fsrc%2Forder.ts`), and in names `.` as `%2E`; the module's `name` is the path as written. Overloads are **one entity**, anchored at the implementation. Members TypeScript lets coexist under one name carry a disambiguator: `#static` for a static beside an instance member, `#get`/`#set` for an accessor pair. Nameless invocables are `#line:column` below the nearest named ancestor (`ts:src%2Fa.ts#3:15` at top level); locals `#local:name:line:column`; a function declared inside an invocable `#fn:name`, a type `#type:name`.

**Declaration merging** yields one entity per declaring file: `interface Order` in two files is two entities, two declarations in one file are one entity anchored at the first, and the strongest kind owns the key (class > enum > function > variable > interface > alias > namespace). Edges carry `sourceFile` to say which declaration site produced them.

## Type space and value space

Interfaces, aliases, const enums and interface members exist only for the checker: a dependency on them is **erased at runtime**. The model keeps them and marks the target's `space`; it never pre-filters. A runtime, bundling or deployment analysis filters edges whose `to` is `space: ["type"]`; an architectural coupling analysis keeps them, because the design dependency is real. `import type { X }` is an ordinary `import` edge whose erasure shows in the target's space, not in the edge kind.

Structural typing means a class conforms to an interface without any `implements` clause. `interfaceImplementation` is therefore `declared` only for an explicit `implements`; conformance by shape is `derived`, never computed by the extractor, and the two must never be merged.

## Stub discipline

Corpus membership is a **whitelist of the symbols declared in the analyzed sources**, never a path-prefix test.

1. What the checker resolves outside the roots is still external: a type under `node_modules/<pkg>` is a stub in the module named by the nearest `package.json` name; a type from the compiler's own `lib.*.d.ts` is a stub in `<lib>`; Node built-ins are normalised to the `node:` form.
2. A name that binds to nothing is a stub in `<unresolved>`, named as written. A module specifier that resolves to nothing is a stub module keyed by the specifier, so import fan-out stays honest.
3. `any` erases resolution completely: a call or access through an `any`, `unknown`, error-typed or index-signature receiver is dropped and **counted**, never emitted with a guessed candidate list — candidate generation is the analyzer's, which alone has whole-corpus implementor knowledge.
4. Dynamic `import(expr)` and `require(expr)` with a computed path produce no edge and are counted; only statically literal specifiers do. Monkey patching, `call`/`apply`/`bind` rebinding and computed member access follow the JavaScript profile's rules: no entity is invented.
5. Generic type parameters are not entities; `Array<Order>` yields a `reference` to `Order` and one to `<lib>/Array`.
6. An edge whose endpoint no entity declares is dropped and counted as `unclosable`, never written dangling.

Edges to stubs are kept; the internal-only view is the analyzer-side filter. See [Stubs](/docs/reference/metamodel/stubs/) and [Extracting without compiling](/docs/explanation/extracting-without-compiling/).

## Measures emitted

Carried in the `TMetrics` map, computed with the compiler's own scanner. See [Measures and literals](/docs/reference/metamodel/measures-literals/).

| Key | On | Definition |
|---|---|---|
| `sloc` | every type and invocable | lines of its own span that are neither blank nor comment-only; template literals, regular expressions and JSX text cannot swallow a comment marker |
| `cyclomatic` | invocables only | 1 + `if` / `for` / `for-in` / `for-of` / `while` / `do` / non-default `case` / `catch` / ternary / `&&` / `\|\|` / `??` |

A nested arrow or function does not contribute to its enclosing invocable: it is its own invocable and carries its own count. A type's complexity is the sum over its members, which the consumer computes with `sum:cyclomatic`.

## Literal and decorator facts emitted

| Fact | Carried by | Notes |
|---|---|---|
| a decorator with its arguments, legacy or TC39 syntax | an `annotationUse` edge, `arguments: NamedArgument[]` named after the factory's parameters | nothing inside a decorator is a call or an access of its own; the decorator is an ordinary `function` or `variable` entity |
| a constant-shaped initializer of a `const`, a `readonly` property, an enum member, a parameter default | `TWithValue` | a literal, `-N`, an enum member, a type used as a value, arrays and operator expressions over those. TypeScript folds nothing at the declaration, so `4 * 25` rides `unevaluated` with its source text; an enum member's value is the checker's computed constant |
| a JSX element naming a component (`<OrderTable/>`) | an `invocation` of the component | an element is a call by the language definition; an intrinsic tag (`<div>`) yields nothing |
| a written `throw` whose static type names a declaration | a `throws` edge anchored at the throw site | a rethrow targets the caught binding's narrowed type; a thrown string or `any` is dropped and counted |

An initializer that is code — a call, a `new`, a function, an object literal — carries no value at all: absence is a claim. Its calls and accesses are edges *from* the variable or property, the narrowest declared owner.

## Profile notes

The documented blind spots, verbatim from the profile.

- This is the only profile that populates `Entity.space` (METAMODEL.md §1.4). Type-space only (`space: ["type"]`): `interface`, `typeAlias`, a `const enum` (its members are inlined at emit, leaving no runtime entity), and a `namespace` that declares only types. Both spaces (`["type", "value"]`): `class`, `abstractClass`, a plain `enum`, and a `namespace` that declares at least one value. Value-space only (`["value"]`): `module`, `function`, `arrowFunction`, `constructor`, `variable`, `parameter`. A `method` or `property` is `["type"]` when written in an `interface` body — it exists only for the checker, and an access to it is a dependency on the interface's SHAPE — and `["value"]` when written in a class or an object literal.
- A dependency whose target is type-space only is ERASED at runtime: it exists for the type checker and leaves nothing in the emitted JavaScript. Runtime, bundling and deployment analyses should therefore filter edges whose `to` resolves to a `space: ["type"]` entity; architectural coupling and design analyses should keep them, since the design dependency is real. Because the distinction is per-analysis, the model always stores both and never pre-filters.
- `import type { X }` and inline `type` specifiers produce ordinary `import` edges; they are erased at runtime and are recognized by the space of their target, not by a separate edge kind.
- The module is the file: `TModule.definedIn` always has exactly one entry, and every entity's module is the file it is written in — a script file's global declarations included (containment is where a thing is written, CLAUDE.md invariant 5; there is no `<global>` module). A `namespace` block is a child entity of its file or enclosing namespace, never a module. An ambient `declare module "pkg"` block in a corpus `.d.ts` IS a module entity, keyed by the quoted name, with `isStub: false` — the corpus declares it, and an import of `pkg` resolves to it.
- Key components are percent-encoded: the file path that names a module is made of `/`, which `renderId` reserves, so every path segment and every non-identifier name entering a key encodes exactly `/` as `%2F`, `#` as `%23`, `%` as `%25` and — in names only, where `.` separates nesting — `.` as `%2E`. Identifiers contain none of the four and are written as-is, so the encoding is injective and reversible; the module entity's `name` is the unescaped path. A `#private` member is therefore `Foo.%23secret`, and a string-literal member `"a.b"` is `Foo.a%2Eb`.
- Declaration merging yields one entity PER DECLARING FILE (the module is the file): `interface Order` in two files is two entities, and two declarations in one file are one entity anchored at the first. An edge to a merged symbol targets the declaration that owns the referenced member; an edge to the merged container itself targets its first declaration in canonical file order — a deterministic choice, not a claim that the others do not exist. A module augmentation of an external type (`declare module "express" { interface Request { user: User } }`) makes its members declared entities parented by the stub type.
- Structural (non-nominal) typing: a class conforms to an interface without any `implements` clause. `interfaceImplementation` therefore carries provenance `declared` only for an explicit `implements`; conformance computed by shape comparison is `derived`, is never computed by the extractor, and must never be merged with the declared edges. Any analysis wanting facts filters on `declared`.
- Corpus membership is a whitelist of the symbols DECLARED in the analyzed sources, never a path-prefix test. What the checker resolves outside the roots is still external: a type declared under `node_modules/<pkg>` is a stub in the module named by the package (the nearest `package.json` name, never the resolved `.d.ts` path, so keys do not depend on what is installed); a type from the compiler's own `lib.*.d.ts` is a stub in the reserved module `<lib>` (`Array`, `Promise`); a name that binds to nothing is a stub in the reserved module `<unresolved>`, named as written — never a guess from the file's imports. A module specifier that resolves to nothing becomes a stub module keyed by the specifier as written, so the import edge survives and import fan-out stays honest. Node built-ins are normalised to the `node:` form.
- A bare specifier that names a package declared UNDER the roots (a monorepo's own `@acme/pricing`) resolves by `package.json` name to that package's source entry when standard resolution fails — with nothing installed and nothing built — because a workspace's packages are corpus, not dependencies. Every such resolution is counted separately on stderr; a subpath below such a package resolves the same way below its source root, else stubs.
- `any` erases resolution completely: a call or member access through an `any`-typed (or `unknown`, or error-typed, or index-signature) receiver has no target. Such edges are dropped and COUNTED in the stderr summary — never emitted with a guessed `candidates` list, since candidate generation is the analyzer's, which alone has whole-corpus implementor knowledge. The proportion of `any`-typed receivers is the honest ceiling on this profile's resolution rate.
- A nameless invocable (arrow function, function expression) is identified by `#line:column` of its first token below the nearest NAMED ancestor's symbol, and below that ancestor's own disambiguator when it has one — a column is a source fact, and two can start on one line. At module top level the symbol is empty and the disambiguator alone identifies it (`ts:src%2Fa.ts#3:15`). `const f = () => {}` yields two entities: the `variable` f and its child `arrowFunction`; call sites resolve through the variable to the arrow, and `invocation` edges target the `arrowFunction`. A class expression with no binding is not an entity (dropped and counted).
- Overloads are ONE entity: TypeScript has no overloading by parameter type at the declaration level, so a function's overload signatures and its implementation share one key with no parameter-list component; the entity is anchored at the implementation (or the sole ambient signature). Members TypeScript lets coexist under one name carry a disambiguator: `#static` for a static member beside an instance one, `#get`/`#set` for an accessor pair; a member without a twin renders with no suffix.
- Ambient declarations (`.d.ts`, `declare module`, `declare global`) under the roots describe entities with no implementation in the corpus. They are emitted as real entities anchored in the `.d.ts`; the implementation they describe, when outside the corpus, is a stub.
- `declaredType` is populated from the checker's type where it names ONE declaration — annotated or inferred alike; a union, intersection, literal, primitive, type-parameter or anonymous type leaves it absent rather than guessed, which is why `TTypedEntity.declaredType` is optional even where the trait is required.
- Generic type parameters are not reified as entities; a use of `Array<Order>` yields a `reference` edge to `Order` and one to `<lib>/Array`, and none to `Array`'s parameter slot. A type parameter's constraint and default are `reference` edges from the declaring entity.
- Decorators are `annotationUse` edges carrying their arguments as written values, under both the legacy (`experimentalDecorators`) and the TC39 syntax; the decorator itself is an ordinary `function` or `variable` entity. `emitDecoratorMetadata` synthesizes nothing the model shows.
- A JSX element whose tag names a component (`<OrderTable/>`) is an `invocation` of that component — an element is a call by the language definition, so the edge is `declared`; an intrinsic tag (`<div>`) yields nothing.
- A `throws` edge is emitted per written `throw` statement whose static type names a declaration, anchored at the throw site; a rethrow targets the caught binding's static type; a thrown string or `any` is dropped and counted.
- Measures (TMetrics, METAMODEL.md §3.8): `sloc` on every type and invocable — lines of its own span that are neither blank nor comment-only, counted with the compiler's own scanner, so template literals, regular expressions and JSX text cannot swallow a comment marker. `cyclomatic` on invocables only: 1 + if / for / for-in / for-of / while / do / non-default case / catch / ternary / `&&` / `||` / `??`. A nested arrow or function does NOT contribute to its enclosing invocable: it is its own invocable and carries its own count.
- Path resolution depends on `tsconfig` `paths`, `baseUrl`, `rootDirs` and `package.json` fields; the extractor reads a `tsconfig.json` for those RESOLUTION options only — never for `files`/`include` (the roots define the corpus) and never for project `references` — and creates one program over every source file under the roots. Nothing is built and `node_modules` is never required.
- Dynamic `import(expr)` and `require(expr)` with a computed, template-literal or variable path are unresolvable: no `import` edge is emitted, and the site is counted. Only statically literal specifiers produce edges. CommonJS `module.exports` reassignment shapes beyond a literal `require`, monkey patching (`Obj.prototype.m = fn`, `Object.assign`), `this` rebinding through `call`/`apply`/`bind`, and computed member access `o[k]` with a non-literal key follow the JavaScript profile's rules: no entity is invented and the site yields at most `access`/`reference` edges at the patch site, or nothing.
- Resolution rate and the any-receiver ceiling, measured (M13c audit, every corpus extracted WITHOUT node_modules): 97.4 % on microsoft/TypeScript 4.9.5 `src/compiler` (69 files, 52 341 entities, 2 684 any-typed receivers, 3 unresolved names — node types with no `@types/node`); 88.6 % on nestjs/nest `packages` (902 files, 29 992 entities, 20 745 any-typed receivers, 78 unresolved names, all from uninstalled fastify/express/class-transformer); 94.4 % on excalidraw (628 files, 43 706 entities, 24 954 any-typed receivers, 41 unresolved names from uninstalled react/mermaid/vitest, 303 stub modules mostly font and asset imports); 96.5 % on codegraph itself (24 887 entities, zero unresolved, 168 imports resolved to workspace packages by name). The rate is a property of the corpus's DEPENDENCY SURFACE and of whether its dependencies are installed: with no install, every call into a package is a call through `any` and is dropped and counted — the honest lower bound. Install the dependencies (or point `--src` at them) to fold those calls to their packages' stubs.
- Members of an object literal are entities only when the literal is BOUND to a name (`const Ops = { … }`, `static x = { … }`): array elements, call arguments and return values are unbound, so their parts are not entities and a method written in one is keyed positionally like an arrow. A class expression bound to a variable or a property IS that binding (one entity, the class's); a class expression bound to nothing is no entity (dropped and counted), nor is anything written inside it. Two declarations of one name in sibling blocks of one scope (`if (a) { class X {} } else { class X {} }`) are re-keyed by position and named on stderr.
- An edge whose endpoint no entity declares is dropped and counted as `unclosable` on stderr, never written dangling (schemas/README.md §5): zero on every audited corpus, and a non-zero count names an id-scheme gap.
- Getters and setters are `method` entities; a property access that runs an accessor is an `access` edge, not an invocation, so a read that runs code is visible as access — a write lands on the setter, a read on the getter. Class fields and object-literal members share the `property` kind; a parameter property (`constructor(readonly x: T)`) is both a `parameter` and a `property`, and an access to it lands on the property.
- Locals are entities keyed `#local:name:line:column` below their invocable (two `let x` in sibling blocks are two entities) and listed in its `localVariables`; a function declared inside an invocable is `#fn:name`, a type declared there `#type:name`. Locals and parameters are never edge targets: an access to a local is not a dependency, and a call through a parameter of function type names no declaration (dropped and counted as an indirect call). A member of an anonymous type literal (`{ order: Order }`) is not an entity — the literal is none.
- A written value (TWithValue) is emitted for a `const` variable, a `readonly` property, an enum member and a parameter default whose initializer is CONSTANT-SHAPED — a literal, `-N`, an enum member, a type used as a value, arrays and operator expressions over those. TypeScript folds nothing at the declaration, so `4 * 25` rides `unevaluated` with its source text where Java would fold it; an enum member's value is the checker's computed constant. An initializer that is code — a call, a `new`, a function, an object literal — carries no value at all: absence is a claim. Such an initializer's calls and accesses are edges FROM the variable or property (the narrowest declared owner), which then carries TWithInvocations/TWithAccesses.

## The reference corpus

`fixtures/typescript/` is a small order-management corpus (23 files, ~330 lines): `acme-order` as an ES-module package tree, plus a **legacy script half** in the `namespace` + `/// <reference path>` style. It is the acceptance corpus for the extractor: the snapshot in `fixtures/typescript/expected/` is produced from that tree, and `./test.sh --ts` checks the built bundle reproduces it.

```bash
./bin/codegraph-typescript --src fixtures/typescript/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/typescript/expected/model.jsonl && echo same
```

```text
RESOLUTION SUMMARY
  type references : 33
  resolved        : 32
  unresolved      : 1
  resolution rate : 97.0%
  any-typed receivers (dropped) : 1
  imports         : 20 (unresolved: 1, workspace-resolved: 1)
  entities        : 193 (stubs: 14 — lib 10, packages 0, <unresolved> 1, modules 3)
  edges           : 127 (self-edges dropped: 1, indirect calls dropped: 2, computed imports dropped: 1, throw sites dropped: 1)
```

Run it from the repository root with that relative `--src`: the typed path is the header's `root`, so an absolute one differs from the snapshot at byte 138. A module's key is then `packages%2Forder%2Fsrc%2Forder.ts`, and its `name` the path as written.

**It does not type-check, on purpose.** Every `tsc` error is about something the corpus deliberately never provides:

| Missing | Where | Why it is missing |
|---|---|---|
| the package `@megacorp/ledger` | imported by `ledger-adapter.ts`, extended by `LedgerAdapter` | a dependency that is not installed — the ordinary legacy case. The import is a stub module keyed by the specifier; the type it should have provided is a stub in `<unresolved>`; every call through the `any` it leaves behind is dropped and counted |
| a JSX runtime | `ui/order-table.tsx` | no `@types/react`: intrinsic elements have no types, and the component call still resolves |
| `node_modules` | everywhere | `packages/pricing` is imported by name (`@acme/pricing`) with nothing installed and nothing built: the workspace resolver reads `package.json` and falls back to `src/index.ts` when `main` points at an absent `dist/` |

`tsconfig.json` sets `"types": []` so the repository's own `@types/node` never leaks into the snapshot. What each file pins:

| File | Pins |
|---|---|
| `tsconfig.json` | resolution options only: `paths` maps `@order/*`; `lib` and `types: []` fix the standard library. `files`/`include` are never read |
| `packages/pricing/package.json` | the workspace resolver: `main` and `types` point at an absent `dist/`, so the package resolves by name to `src/index.ts` (`workspace-resolved: 1`) |
| `order.ts` | three ways to import, one edge kind (`@acme/pricing` by name, `@order/channel` by `paths`, `./abstract-order.js` relatively, `import type { Cents }` erased); `#static` beside an instance `parse()`; `MAX_LINES = 4 * 25` as `unevaluated`, `CURRENCY = "EUR"` as a string |
| `abstract-order.ts` | `abstractClass`; a parameter property `readonly reference` declares a field; a compound assignment that reads and writes |
| `money.ts` | an accessor pair → `#get`/`#set`; a `#private` → `%23secret`; a string-literal member `"as.text"` → `as%2Etext`; `type Cents = number` (type space, no `declaredType`); `implements Priceable` |
| `discountable.ts` | same-file merging: `interface Discountable` twice → one entity anchored at the first; `extends Priceable` is `inheritance` |
| `channel.ts` | a plain `enum` whose members carry checker-computed values (`Phone = Store + 1` → 11, plus an `access` to `Store`); a `const enum` (`space: ["type"]`) |
| `notifications.ts` | two arrows starting on one line (8:16 and 8:57); an arrow bound to a const (the variable and its child); a nameless function expression; a top-level IIFE (empty symbol, the module carries `TWithInvocations`); calls through callback parameters dropped (`indirect calls dropped: 2`) |
| `reporting.ts` | overloads as one entity; three `throws` to `OrderError` (a guard, a narrowed rethrow, a wrap) and one dropped `throw "…"`; `class OrderError extends Error` → inheritance from `<lib>/Error` |
| `decorators.ts` | `annotationUse` with arguments named after the factory's parameters (`@Audited("monthly")` → `{tag}`); `Report.max` hand-counted cyclomatic 4 |
| `ambient.d.ts` | a corpus-declared ambient module: `declare module "legacy-lib"` in a script `.d.ts` declares `ts:legacy-lib`, `isStub: false` |
| `augment.ts` | a module augmentation merging into the class (one entity, a second `definedIn`); `declare global` members are children of *this* file |
| `ui/order-table.tsx` | JSX: `<Row order={row}/>` is an `invocation` of `Row`; `<table>` yields nothing; a destructured parameter `{ rows }` → `#param:rows`; a type-literal member is not an entity |
| `legacy/list.ts` | recursion: a self-edge dropped at the source; cyclomatic 2 |
| `basket.ts` | an object literal used as a namespace: `Ops` is a `variable` with `TWithChildren`, `create` a `method` below it; `new Basket()` with no written constructor → an invocation of the class; `readonly lines: Line[] = []` → an array value |
| `lazy.ts` | a dynamic `import("./reporting.js")` with a literal is an import edge; a template-literal one is dropped and counted |
| `handler.ts` | a nameless default export → `default`; an import of `./promo#2024.js` |
| `promo#2024.ts` | a `#` in a file name → `promo%232024.ts` in the key |
| `legacy/acme.ts`, `legacy/acme-report.ts` | the script half: `namespace` blocks and `/// <reference path>` |

## Gotcha

Point `--src` at a source tree, not at one package: one run over a monorepo covers every package in it, and the model's modules are its files. Two roots with their own `tsconfig.json` get the first root's; pass `--tsconfig` for the one whose `paths` matter, or run once per root.

| Symptom | Cause | Fix |
|---|---|---|
| every `Array`, `Promise`, `Error` shows up under `<unresolved>` | the compiler cannot find its `lib.*.d.ts`: a hand-bundled build inlined `typescript` | run the built bundle from a workspace install; never inline the compiler |
| a monorepo package's types land in `<unresolved>` | its `package.json` has no `name`, or its entry is not under the roots | add the package's root to `--src`, or a `source` field pointing at its `.ts` entry |
| far fewer modules than expected | `--src` pointed below the sources, or the sources are `.js` | add roots with repeated `--src`; `--allow-js` |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
| `JavaScript heap out of memory` on a very large corpus | the checker holds every type of a single program | `NODE_OPTIONS=--max-old-space-size=8192`, or one run per package root |
