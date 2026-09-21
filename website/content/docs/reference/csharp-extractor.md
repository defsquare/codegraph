---
title: C# extractor
linkTitle: C# extractor
weight: 10
---

`codegraph-csharp` 0.1.0 — the Roslyn-based C# extractor. A .NET 10 project in `extractors/csharp/`, published as one self-contained binary per OS. It never opens a `.sln` or `.csproj`: **every `*.cs` under the roots is parsed into one compilation** and bound against a copy of the .NET base class library that travels inside the extractor. No MSBuild, no restore, no build; a missing NuGet package is a stub, not a failure. It emits [`model.jsonl`](/docs/reference/model-jsonl/) and nothing else: all trait, profile and validation logic lives in `@codegraph/core`.

```bash
./build.sh --csharp                                   # publish the host's binary → extractors/csharp/dist/<rid>/codegraph-csharp
./build.sh --csharp --publish-all                     # linux-x64, linux-arm64, osx-x64, osx-arm64, win-x64 — all from one host
extractors/csharp/dist/osx-arm64/codegraph-csharp --src <dir> --out model.jsonl
```

Building needs the .NET 10 SDK (see `extractors/csharp/README.md`); the binary it produces needs nothing installed.

## Three ways to run it

They produce the same bytes for the same corpus; pick by what the machine has.

| You have | Run it as | What you need to install |
|---|---|---|
| nothing | the **self-contained binary** for your OS (about 64 MB, runtime and compiler inside; no `libicu` needed on Linux) | nothing |
| the .NET **runtime** (no SDK) | `dotnet codegraph-csharp.dll` from a framework-dependent publish (`dotnet publish src/Codegraph.CSharp -c Release -o DIR`, about 15 MB; copy the directory whole) | .NET 10 runtime; the extractor rolls forward to any newer major |
| the .NET **SDK** | `dotnet run --project extractors/csharp/src/Codegraph.CSharp -c Release -- --src DIR --out model.jsonl` | .NET 10 SDK |

A downloaded binary is unsigned: on macOS run `xattr -d com.apple.quarantine codegraph-csharp` once; on Windows SmartScreen warns once. Non-interactive shells do not see a login shell's `PATH`, so a script that calls `dotnet` should `export DOTNET_ROOT=~/.dotnet; export PATH=$DOTNET_ROOT:$PATH` first, or call the self-contained binary.

## Synopsis

```
codegraph-csharp [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                 [--implicit-usings sdk|web|none]
                 [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
                 [--version] [--help]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src <dir>` | source root; repeatable. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's `root`. `bin/` and `obj/` are skipped: build output, never sources | the current directory |
| `--out <file>` | where to write the model | `<current-dir>-codegraph.jsonl` |
| `--progress <m>` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` | `auto` |
| `--no-progress` | same as `--progress none` | — |
| `--implicit-usings <m>` | the global usings a project with `ImplicitUsings` enabled gets from a generated file in `obj/` (skipped). `sdk`: `System`, `System.Collections.Generic`, `System.IO`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks`. `web`: adds `Microsoft.AspNetCore.*` and `Microsoft.Extensions.*`, for a corpus that is all Web-SDK projects. `none`. They write no import edge | `sdk` |
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

## Streams

stdout carries nothing but `--help` and `--version`. Progress and the **resolution summary** go to stderr:

```text
✓ walk       20 files  0.0s
✓ parse      20 files  0.0s
✓ bind       166 reference assemblies  0.0s
✓ whitelist  26 types  0.1s
✓ entities   208 entities  0.2s
✓ edges      285 edges  0.0s
✓ stubs      36 stubs  0.0s
✓ write      551 records  0.0s
RESOLUTION SUMMARY
  type references : 285
  resolved        : 267
  unresolved      : 18
  resolution rate : 93.7%
  imports         : 15 (unresolved: 5, without a module: 0)
  entities        : 244 (stubs: 36)
  edges           : 285 (self-edges dropped: 1, dynamic call sites dropped: 1)
wrote model.jsonl
```

- **resolution rate** measures the corpus's *dependency surface*, not the extractor: a package that is not under the source roots cannot be resolved by any tool. Above, the 18 unresolved references are the fixture's deliberately absent `MegaCorp.Ledger` and `Newtonsoft.Json`.
- **stubs** are types and namespaces referenced but declared outside the roots. The base class library resolves (it is embedded) and still counts as external: `string` is a stub in namespace `System`. A name that binds to nothing is a stub in the reserved module `<unresolved>`, named as written.
- **dropped and counted**: a `dynamic` call site (no symbol to bind), a `using` in a file that declares no corpus type, a self-edge (`using Acme;` inside `namespace Acme`).
- **duplicates**: a corpus is not one compilation unit. Two projects that never see each other may both declare `static class Extensions` with the same member, and every service has its own top-level `Program.cs`; all are kept, the first in file order under the plain key and each later one re-keyed by its file (`…#in:Catalog.API/Program.cs`), and every re-keying is named on stderr.

## What resolves without a build

The base class library and the ASP.NET Core shared framework both resolve: both reference packs travel inside the binary. What stays unresolved, measured on real corpora: third-party packages — on dotnet/eShop, EF Core and Npgsql (`DbContext`, `DeleteBehavior`), .NET MAUI (`BindableProperty`, `Preferences`) and CommunityToolkit.Mvvm (`RelayCommand`); on OrchardCore, Fluid (`FluidValue`, `TemplateContext`), GraphQL (`FieldType`, `StringValue`) and OpenIddict — plus generated code whose output is not under the roots (on Humanizer, the source generators' `*RegistryRegistrations`), and one honest limit of a single compilation: two corpus types with one simple name whose projects each `global using` their own namespace (eShop's two `CatalogItem`) are ambiguous once those usings merge, and an ambiguous name is unresolved.

## The C# profile

The mapping the extractor must respect, rendered from `codegraph profiles --lang csharp`. `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`.

| Kind | Required traits | Optional traits |
|---|---|---|
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `constructor` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `delegate` | `TNamed`, `TType`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `enum` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TComment`, `TMetrics` |
| `event` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `field` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TWithValue` |
| `interface` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `lambda` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TMetrics` |
| `localVariable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `method` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TAttachedTo`, `TComment`, `TMetrics` |
| `namespace` | `TNamed`, `TModule`, `TWithChildren` | `TChildOf`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor`, `TWithValue` |
| `property` | `TNamed`, `TStructural`, `TTypedEntity`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithInvocations`, `TWithAccesses`, `TAttachedTo`, `TComment`, `TMetrics` |
| `record` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `struct` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |

**Edge kinds emitted:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference` · `annotationUse` · `throws`

| C# construct | Kind |
|---|---|
| namespace (file-scoped or block) | `namespace` — the module |
| class | `class` |
| struct, record struct | `struct` |
| record | `record` |
| interface | `interface` |
| enum | `enum`; its members are `field` entities carrying their integral constant |
| delegate | `delegate` — a type that is also an invocable |
| method, local function (`#fn:Name(params)` below its invocable), extension method (`TAttachedTo` → the extended type) | `method` |
| constructor; the implicit parameterless one, anchored at the type's header line | `constructor` |
| lambda, anonymous method | `lambda` — `TInvocable` without `TNamed` |
| field, const, enum member | `field` |
| property, indexer; accessor bodies charge to the property | `property` |
| event | `event` |
| parameter | `parameter` |
| local variable | `localVariable` |

Ids carry **generic arity** in the type's symbol (`Repository\`1`, Roslyn's metadata name), because `Foo`, `Foo<T>` and `Foo<T,U>` legally coexist in one namespace. Signatures use fully-qualified metadata names **with** type arguments (`System.Func\`2<!!0,System.String>`), because C# can overload on type arguments alone; type parameters are ECMA-335 ordinals; nullable annotations and `ref`/`out`/`in` are dropped. Nameless invocables are disambiguated by `#file:line:column`, locals by `#local:name:line:column`, a second same-named parameter by its ordinal (`#param:_:1`), and a same-keyed declaration from another project by its file (`#in:path`).

**Partial classes** are one entity declared across several files: the entity carries one anchor, its primary declaration, and each edge carries `sourceFile` to say which declaration site produced it.

## Stub discipline

Corpus membership is a **whitelist of the type symbols declared in the analyzed sources**, built in a first pass; never a namespace-prefix test.

1. Roslyn resolves what it can against the embedded reference assemblies: `string` is a stub in module `System`, with its real namespace, and — unlike Java — **primitives resolve**: `int` *is* `System.Int32`, so it becomes a BCL stub rather than being omitted.
2. A name Roslyn cannot bind is an error type, emitted as a stub in the reserved module `<unresolved>` under the name as written — never a namespace guessed from the file's `using` directives, which would invent a fully-qualified name.
3. `void`, `dynamic`, anonymous types, pointer types and type parameters are not entities and leave `declaredType` absent. `var`, target-typed `new()` and inferred lambda parameters leave `TTypedEntity` present with `declaredType` absent: the trait states that the entity has a type, not that the extractor resolved one.
4. A `dynamic` receiver binds to no symbol, so the call site is dropped and counted. Virtual dispatch and calls through an interface resolve to the **declared** member; the implementation actually run is a whole-corpus question the analyzer answers.
5. A call to a member Roslyn synthesizes and nobody wrote (a record's `Equals`, `Deconstruct`, copy constructor; backing fields; an enum's `value__`) folds to its containing type, the rule that already governs members of stubs.

Edges to stubs are kept; the internal-only view is the analyzer-side filter. `using` directives, `global using` and aliases fold to module-level `import` edges to the namespace, never to individual types. See [Stubs](/docs/reference/metamodel/stubs/) and [Extracting without compiling](/docs/explanation/extracting-without-compiling/).

## Measures emitted

Carried in the `TMetrics` map, computed on syntax so they are immune to the resolution ceiling. See [Measures and literals](/docs/reference/metamodel/measures-literals/).

| Key | On | Definition |
|---|---|---|
| `sloc` | every type and invocable, and properties | lines of the node's own span holding at least one token: neither blank nor comment-only. Trivia is not a token, so a comment-only line does not count; a multi-line literal counts every line it spans |
| `cyclomatic` | invocables and properties | 1 + `if` / `for` / `foreach` / `while` / `do` / non-default `case` label / switch-expression arm (the discard arm is the default) / `catch` / ternary / `&&` / `\|\|` / `??` / `??=` / pattern `when` guard |

A nested lambda, anonymous method or local function is its own invocable and does not contribute to its enclosing one. A property's measures are the sum over its accessors (one base count, not one per accessor); the implicit parameterless constructor carries `sloc` 0 and `cyclomatic` 1. A type's complexity is not stored — it is the sum over its members, which the consumer computes with `sum:cyclomatic`.

## Literal and attribute facts emitted

| Fact | Carried by | Notes |
|---|---|---|
| a written attribute with its arguments | an `annotationUse` edge, `arguments: NamedArgument[]` | positional arguments are named after the bound constructor's parameters; nothing inside the attribute produces an access or reference edge of its own |
| a `const` field's value, an enum member's integral constant | `TWithValue` on the `field` | an enum member's value is its underlying-type constant, not itself; a `const` of an enum type elsewhere keeps the member form |
| a parameter's explicit default | `TWithValue` on the `parameter` | |
| a method group used as a value (`new Handler(Zero)`) | a `reference` edge to the method | not an invocation |

A `readonly` field whose initializer is code carries nothing: absence means "not constant".

## Profile notes

The documented blind spots, verbatim from the profile.

- Partial classes (and partial methods) mean one entity id is declared across several files: the entity carries a single anchor for its primary declaration, while each edge carries sourceFile to say which declaration site produced it. Merging by id is correct here, not a collision.
- `var`, target-typed `new()`, anonymous types and inferred lambda parameters leave TTypedEntity present with declaredType absent — the trait states that the entity has a type, not that the extractor resolved one.
- Extension methods are children of their static host class but carry TAttachedTo pointing at the extended type; a call site written as instance syntax is still an invocation edge to the static method.
- Reflection is invisible: Type.GetType, Activator.CreateInstance, expression trees and source-generated partials leave no edge unless the generated source is part of the analyzed root (then provenance is "generated").
- Dependency-injection wiring is invisible: container registrations (Microsoft.Extensions.DependencyInjection, Autofac, …) bind an interface to an implementation at runtime, so no invocation edge links a consumer to the concrete type it will receive.
- Virtual dispatch and calls through an interface resolve to the DECLARED member (the one the source names); the implementation actually run is a whole-corpus question the analyzer answers. A `dynamic` receiver binds to no symbol at all, so the call site is dropped and counted in the stderr summary — an extractor guessing targets from the file's `using` directives would be inventing edges.
- `using` directives, `global using` and using aliases are folded to module-level import edges to the imported namespace, never to individual types.
- Corpus membership is a whitelist of the type symbols DECLARED in the analyzed sources, never a namespace-prefix test. Roslyn resolves what it can against the BCL reference assemblies the extractor carries (so `string` is a stub in module `System`, with its real namespace); a name it cannot bind is an error type, emitted as a stub in the reserved module `<unresolved>` under the name as written — the honest form, since guessing a namespace from the file's `using` directives would invent a fully-qualified name.
- Generic arity is part of a type's symbol (`Repository\`1`, Roslyn's metadata name): `Foo`, `Foo<T>` and `Foo<T,U>` legally coexist in one namespace, so Java-style erasure to the bare name would merge three declarations into one entity. Signatures use fully-qualified metadata names WITH type arguments (`System.Func\`2<!!0,System.String>`), because C# can overload on type arguments alone (`Humanize(Func<T,string>)` beside `Humanize(Func<T,object>)`, found on Humanizer); type parameters are ECMA-335 ordinals, nullable annotations and ref/out/in are dropped.
- A corpus is not a compilation unit: two projects that never see each other may both declare a non-partial `static class Extensions` with the same member, and every service has its own top-level `Program.cs` (found on dotnet/eShop). In one compilation they are one type with several same-keyed members. Every one is kept: the first declaration in ordinal file order owns the plain key, each later one is re-keyed by its file (`…#in:Catalog.API/Program.cs`, a source fact like a lambda's position), and every re-keying is named on stderr. Dropping later ones — the JDT rule the Java profile documents — would erase nine services' DI wiring out of ten.
- Members of a C# 14 extension block (`extension(Money m) { … }`, found on Humanizer) are members of the enclosing static class carrying TAttachedTo → the receiver type, exactly like classic extension methods; the block itself, a nameless nested type to Roslyn, is no entity.
- Microsoft.NET.Sdk's seven implicit global usings (System, System.Collections.Generic, System.IO, System.Linq, System.Net.Http, System.Threading, System.Threading.Tasks — what `<ImplicitUsings>enable` generates into obj/, which is build output and skipped) are added to the compilation by default (`--implicit-usings sdk`); without them `Task`, `List<T>` and `CancellationToken` were the most-referenced unresolved names on OrchardCore. The Web SDK's additions (`Microsoft.AspNetCore.*`, `Microsoft.Extensions.*`) are opt-in (`web`): one compilation cannot apply them per project, and on a mixed corpus they make names ambiguous — OrchardCore's own `StartupBase` collided 345 times with `Microsoft.AspNetCore.Hosting.StartupBase`. Implicit usings write no import edge: no file wrote them. The ASP.NET Core shared framework's reference pack is embedded beside the BCL's when the building SDK has it.
- An ambiguous name is unresolved: two corpus types with one simple name whose projects each `global using` their own namespace (dotnet/eShop's two `CatalogItem`) collide once those usings merge into one compilation, and the reference lands in `<unresolved>` rather than on a guess between the two.
- Two parameters may share a name (`(_, _) => …` discards, found on OrchardCore): the second and later same-named parameters carry their ordinal (`#param:_:1`).
- A nameless invocable (lambda, anonymous method) is identified by `#file:line:column`; a column is a source fact, and two can start on one line. A local's id carries line AND column for the same reason (`#local:name:line:column`); a local function is a `method` below its invocable (`#fn:Name(params)`).
- Members Roslyn synthesizes and nobody wrote — a record's Equals/GetHashCode/Deconstruct/copy constructor, backing fields, an enum's `value__` — are not entities, and neither are accessors (their bodies charge to the property). A call to such a member folds to its containing type, the rule that already governs members of stubs. The one implicit member emitted is the parameterless constructor, anchored at the type's header line so `new T()` does not dangle.
- An attribute is an `annotationUse` edge carrying its arguments as written values — positional ones named after the bound constructor's parameters — and nothing inside the attribute produces an access or reference edge of its own. A method group used as a value (`new Handler(Zero)`) is a `reference` to the method, not an invocation.
- A `reference` edge comes from the narrowest declared owner of the written type — a parameter's type from the parameter, a field's from the field — and locals never own edges: an initializer's call is the invocable's dependency, and the local's own type rides on declaredType.
- Primitives resolve: `int` IS `System.Int32`, so unlike Java they become BCL stubs rather than being omitted. `void`, `dynamic`, anonymous types, pointer types and type parameters are not entities and leave declaredType absent.
- Neither a `.sln` nor a `.csproj` is read: the extractor parses every `*.cs` under the source roots into ONE compilation (no MSBuild, no restore), so a legacy tree with no restorable project graph still extracts, and a missing package is a stub rather than a build failure. Consequences: one preprocessor configuration is parsed (no `--define` yet); source-generated and XAML/Razor code-behind partials are absent unless their output is under the roots; a name declared twice across projects that never see each other collides as one entity.

## The reference corpus

`fixtures/csharp/` is the C# twin of the Java reference corpus: 20 files under `Acme/Order`, the same order-management story, and the acceptance corpus for the extractor. The snapshot in `fixtures/csharp/expected/` is produced from that tree, and `./test.sh --csharp` checks that the published binary reproduces it byte for byte.

```bash
extractors/csharp/dist/<rid>/codegraph-csharp --src fixtures/csharp/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/csharp/expected/model.jsonl && echo same
```

Run it from the repository root with that relative `--src`: the typed path is the header's `root`, so an absolute one differs from the snapshot and says nothing about the binary.

**It does not build, on purpose.** Two dependencies are deliberately absent, and they are the 18 unresolved references of the summary above:

| Missing | Where | Why it is missing |
|---|---|---|
| `MegaCorp.Ledger` | used by `Order`, `Order.Audit`, `OrderService`, extended in `Adapter/LedgerAdapter` | an external package that was never restored — the ordinary legacy case |
| `Newtonsoft.Json` | `Adapter/LedgerAdapter` | a third-party package outside the embedded reference packs |

What the tree exercises, by file:

| File | Exercises |
|---|---|
| `Order.cs`, `Order.Audit.cs` | a **partial class** across two files, one entity with one anchor and per-edge `sourceFile`; an `[Audited]` attribute use |
| `Extensions/MoneyExtensions.cs` | a classic extension method (`this Money`) and a C# 14 `extension(…)` block, both `TAttachedTo` the receiver type |
| `GlobalUsings.cs` | `global using` directives folded to module-level imports |
| `Batch.cs` | a `dynamic` receiver: the call site dropped and counted |
| `Money.cs` | a positional `record struct` implementing a corpus interface: the synthesized members are not entities |
| `Notifications.cs` | `delegate` and `event` kinds, lambdas and anonymous methods |
| `Legacy/List.cs` | the simple-name collision partner (`List` beside `System.Collections.Generic.List`) and recursion |
| `StockGuard.cs` | `throws` edges from written `throw` statements |
| `Reporting.cs` | an attribute with a written argument; expression-bodied members |
| `AuditedAttribute.cs` | the attribute type itself, a corpus-declared annotation |
| `Résumé.cs` | non-ASCII identifiers, file name and doc text, left unescaped by the JSON writer as `JSON.stringify` would |
| `Repository.cs` | `Repository` and `Repository<T>` side by side: arity in the symbol keeps them two entities |

## Gotcha

Point `--src` at the **solution folder**, not at one project: the extractor needs no project graph, so one run covers every project, and the model's namespaces are the corpus's own. A model with far fewer types than expected means `--src` pointed below the sources, or generated code lives outside the roots — add roots with repeated `--src`. On a Web-SDK-only corpus pass `--implicit-usings web`; on a mixed one leave the default, since the Web usings make names ambiguous.

| Symptom | Cause | Fix |
|---|---|---|
| every `System.*` type shows up under `<unresolved>` | a hand-published single-file build that reads the BCL from `Assembly.Location`, empty in a bundle | use `./build.sh --csharp`; the embedded pack is verified at build time |
| `You must install or update .NET to run this application` | runtime older than 10 | install the 10.0 runtime, or use the self-contained binary |
| `No BCL reference assemblies found …` at build time | the SDK's targeting pack is missing | `apt install dotnet-targeting-pack-10.0`, or the official install script |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
