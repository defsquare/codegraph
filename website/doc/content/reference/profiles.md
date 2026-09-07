---
title: Language profiles
linkTitle: Language profiles
weight: 4
---

The profiles `@codegraph/core` ships: per entity kind, the traits an extractor must emit and the traits it may emit, plus the edge kinds the language can produce and the profile's documented blind spots.

{{< callout type="info" >}}
Generated content. Every table on this page is a rendering of `codegraph profiles --json`; run it for the machine-readable form.

```bash
codegraph profiles --json          # all nine profiles
codegraph profiles --lang java     # one profile, as text
```
{{< /callout >}}

A profile licenses an entity by the rule `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`. What a profile *is* — and why it is data rather than code — is on [Profiles](/reference/metamodel/profiles/).

## Summary

| `lang` | Language | Kinds | Edge kinds | Notes |
|---|---|---|---|---|
| `clj` | Clojure | 10 | 5 | 13 |
| `csharp` | C# | 14 | 6 | 7 |
| `go` | Go | 10 | 6 | 9 |
| `java` | Java | 12 | 8 | 15 |
| `js` | JavaScript | 8 | 5 | 13 |
| `php` | PHP | 12 | 8 | 10 |
| `python` | Python | 9 | 6 | 10 |
| `rust` | Rust | 13 | 5 | 12 |
| `ts` | TypeScript | 13 | 6 | 14 |

A profile that is specified but has no shipped extractor is complete, not deficient: the profile is the contract an extractor is written against. Today only `java` has one.

## Clojure — `clj`

**Edge kinds:** `import` · `interfaceImplementation` · `invocation` · `access` · `reference`

| Kind | Required traits | Optional traits |
|---|---|---|
| `defmethod` | `TInvocable`, `TAttachedTo`, `TChildOf`, `TSourceAnchor` | `TComment`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `function` | `TNamed`, `TStructural`, `TInvocable` | `TSourceAnchor`, `TComment`, `TChildOf`, `TWithChildren`, `TAttachedTo`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `implBlock` | `TWithChildren`, `TAttachedTo`, `TSourceAnchor` | `TChildOf`, `TComment` |
| `localBinding` | `TNamed`, `TStructural`, `TChildOf` | `TTypedEntity`, `TSourceAnchor` |
| `multimethod` | `TNamed`, `TStructural`, `TInvocable`, `TChildOf` | `TSourceAnchor`, `TComment`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `namespace` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TChildOf` | `TTypedEntity`, `TSourceAnchor` |
| `protocol` | `TNamed`, `TType`, `TChildOf` | `TWithChildren`, `TSourceAnchor`, `TComment` |
| `record` | `TNamed`, `TType`, `TChildOf` | `TWithImplements`, `TWithChildren`, `TSourceAnchor`, `TComment` |
| `var` | `TNamed`, `TStructural` | `TSourceAnchor`, `TComment`, `TChildOf`, `TWithChildren`, `TAttachedTo`, `TTypedEntity`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |

**Notes**

- Planned extractor: clj-kondo analysis output (`--config '{:output {:analysis true}}'`), which resolves var definitions, usages and namespace requires without loading the code.
- Multimethod dispatch is not statically resolvable: the dispatch fn can compute any value. Invocation edges into a multimethod carry provenance `dynamic-candidate` with every known `defmethod` of that multimethod in `candidates`, and `to` set to the best guess.
- Macro-generated code does not exist before expansion. Definitions a macro emits are invisible to a reader-level extractor; where an extractor does expand (or where the macro is known, e.g. `defrecord` expanding to a class), the resulting entities and edges carry provenance `generated`.
- `extend-type` / `extend-protocol` are reified as anonymous `implBlock` entities (METAMODEL.md §7). The block is `attachedTo` the extended type; the `interfaceImplementation` edge runs type -> protocol and uses the block as its anchor.
- Protocol methods are namespace-level vars: they are emitted as `function` children of the namespace and `attachedTo` the protocol — the canonical containment-vs-attachment split, same shape as `defmethod`.
- Protocols are open: any namespace may extend any type to any protocol at any time, so the implementer set of a protocol is never closed by the file that declares it, and a partial corpus systematically under-reports `interfaceImplementation`.
- No `inheritance` edge kind: Clojure has no class inheritance. `derive` builds ad-hoc keyword hierarchies used for dispatch, which are values, not entities, and are not modeled.
- `declaredType` is populated only from `^TypeHint` metadata, which is optional and rare; for the vast majority of vars, parameters and bindings it is absent — this is precisely why `TTypedEntity.declaredType` is optional.
- `defrecord`/`deftype` positional fields are emitted as `parameter` children of the record: in Clojure they are literally the positional constructor parameters.
- Destructuring forms (`{:keys [a b]}`, `[x & rest]`) are flattened to one `parameter` per bound symbol, in source order; the pattern itself is not reified.
- Higher-order use of vars (`(map inc coll)`, `(partial f x)`) yields `reference` edges to the var, never `invocation` edges — the call happens elsewhere and its site is unknown.
- Runtime resolution (`resolve`, `requiring-resolve`, `eval`, `(var-get (ns-resolve ...))`) and dynamically computed `require` are static blind spots: no `import` or `invocation` edge is emitted for them.
- `:refer :all` and `:refer` bring vars into scope without qualification; the `import` edge is namespace -> namespace, so the module layer stays exact even when a symbol's origin needs var resolution.

## C# — `csharp`

**Edge kinds:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference`

| Kind | Required traits | Optional traits |
|---|---|---|
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `constructor` | `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `delegate` | `TNamed`, `TType`, `TInvocable`, `TWithParameters`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `enum` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TComment` |
| `field` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `interface` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `lambda` | `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity` |
| `localVariable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `method` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TAttachedTo`, `TComment` |
| `namespace` | `TNamed`, `TModule`, `TWithChildren` | `TChildOf`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `property` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TWithInvocations`, `TWithAccesses`, `TComment` |
| `record` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `struct` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |

**Notes**

- Partial classes (and partial methods) mean one entity id is declared across several files: the entity carries a single anchor for its primary declaration, while each edge carries sourceFile to say which declaration site produced it. Merging by id is correct here, not a collision.
- `var`, target-typed `new()`, anonymous types and inferred lambda parameters leave TTypedEntity present with declaredType absent — the trait states that the entity has a type, not that the extractor resolved one.
- Extension methods are children of their static host class but carry TAttachedTo pointing at the extended type; a call site written as instance syntax is still an invocation edge to the static method.
- Reflection is invisible: Type.GetType, Activator.CreateInstance, expression trees and source-generated partials leave no edge unless the generated source is part of the analyzed root (then provenance is "generated").
- Dependency-injection wiring is invisible: container registrations (Microsoft.Extensions.DependencyInjection, Autofac, …) bind an interface to an implementation at runtime, so no invocation edge links a consumer to the concrete type it will receive.
- `dynamic` call sites and virtual dispatch through an interface resolve to the declared member; when the target cannot be pinned down the edge is emitted with provenance "dynamic-candidate" plus a candidates list.
- `using` directives, `global using` and using aliases are folded to module-level import edges to the imported namespace, never to individual types.

## Go — `go`

**Edge kinds:** `import` · `interfaceImplementation` · `invocation` · `access` · `reference` · `embedding`

| Kind | Required traits | Optional traits |
|---|---|---|
| `const` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `field` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `func` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `interface` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithImplements`, `TComment` |
| `localVariable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `method` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TAttachedTo`, `TSourceAnchor` | `TComment` |
| `package` | `TNamed`, `TModule`, `TWithChildren` | `TComment` |
| `parameter` | `TStructural`, `TTypedEntity`, `TChildOf` | `TNamed`, `TSourceAnchor` |
| `struct` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithImplements`, `TComment` |
| `typeAlias` | `TNamed`, `TType`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |

**Notes**

- Go has no inheritance: neither the TWithInheritances trait nor the inheritance edge kind belongs to this profile. Their absence is the profile's statement about the language, not a missing feature.
- Interface satisfaction is implicit and structural: nothing in the source says a type implements an interface, so interfaceImplementation edges are always emitted with provenance "derived" and never "declared". An analysis restricted to facts (declared edges) sees no implementation relation in Go at all.
- `struct { Base }` and `interface { io.Reader }` are embedding edges, not inheritance and not fields: the embedded type's methods are promoted onto the outer type, which changes which interfaces the outer type satisfies but creates no subtype relation.
- A method's receiver drives TAttachedTo (the receiver type) while TChildOf stays the package where the method is written; value and pointer receivers attach to the same type entity and are separated by the id's disambiguator.
- Multiple return values do not fit TTypedEntity's single declaredType: the first result is the declaredType and every further result type is emitted as a reference edge.
- Short variable declarations (`:=`), untyped constants and `iota` runs leave TTypedEntity present with declaredType absent.
- Calls through an interface value cannot be resolved statically: they are emitted against the interface method with provenance "dynamic-candidate" and the satisfying implementations as candidates.
- Invisible to static extraction: reflect, the plugin package, cgo, go:generate and go:linkname directives, and side effects of init() functions pulled in by blank imports (`import _ "…"`), which are still emitted as ordinary import edges.
- Build tags and GOOS/GOARCH constrained files mean a single extraction run sees one build configuration; entities excluded by the active tags are absent from the model.

## Java — `java`

**Edge kinds:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference` · `annotationUse` · `throws`

| Kind | Required traits | Optional traits |
|---|---|---|
| `annotation` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `attribute` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TWithValue` |
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `constructor` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `enum` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `interface` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `lambda` | `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TMetrics` |
| `localVariable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `method` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics`, `TWithValue` |
| `package` | `TNamed`, `TModule`, `TWithChildren` | `TComment`, `TChildOf` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `record` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |

**Notes**

- Measures (TMetrics, METAMODEL.md §3.8): `sloc` on every type and invocable — lines of its own span that are neither blank nor comment-only, counted by a scanner that knows string and text-block literals, so a `"/*"` in the source does not swallow the rest of the file. `cyclomatic` on invocables only: 1 + if / for / foreach / while / do / non-default case label / catch / ternary / short-circuit && and || / switch pattern guard. Purely syntactic, hence immune to the noClasspath resolution ceiling. A nested lambda or anonymous class does NOT contribute to its enclosing method: it is its own invocable and carries its own count. A type's complexity is therefore not stored — it is the sum over its members, which the consumer computes.
- Spoon in noClasspath mode invents plausible fully-qualified names for unresolved types. Corpus membership is therefore decided by a whitelist of ids actually declared by the corpus (built in a first pass); anything else is emitted as an isStub entity. Never decide membership by package or name prefix — invented FQNs look exactly like real ones and a prefix filter would launder them into facts.
- Reflection is invisible: Class.forName, Method.invoke, proxies, Spring XML/annotation wiring, ServiceLoader/META-INF/services, and JNDI lookups produce no edge. The import/invocation graph of a reflection-heavy corpus is a lower bound.
- Lombok-generated members (getters, setters, @Builder, @Data constructors) are emitted with provenance "generated" when the expansion is visible to Spoon, and are missing entirely when it is not.
- An interface's `extends` list is emitted as inheritance edges between types; interfaceImplementation is reserved for a class/enum/record `implements` clause, always with provenance "declared".
- A `throws` edge is emitted per written `throw` statement whose static exception type resolves, anchored at the throw site — the evidence a guard clause (`if (x) throw new E(...)`) leaves in the model. A method's `throws` CLAUSE stays a plain reference edge: it declares propagation, not a failure exit of this body. A rethrow (`throw e;`) targets the caught variable's static type; a throw whose type Spoon cannot name is dropped and counted, like any unidentifiable target.
- Static and on-demand (`import x.y.*`) imports are folded to module-level import edges; the wildcard case names the package, not the individual types it brings in.
- Overloads are distinguished by the id's signature disambiguator, so an unresolved parameter type changes the id — a resolution failure shows up as a stub target, never as a merged entity.
- Java generics are erased in the model: type arguments are emitted as reference edges from the declaring entity, and declaredType carries the raw type.
- noClasspath resolution rate, measured (M2 audit): 100.0% on apache/commons-lang (263 files, 133478 type references, 0 unresolved) and 77.8% on spring-petclinic (30 files, 2189 references, 487 unresolved, all of them Spring and Jakarta types whose jars are absent). The rate is a property of the corpus's DEPENDENCY SURFACE, not of the extractor: commons-lang is self-contained and depends on nothing but the JDK, which resolves against the runner's own classpath. A jar that is not on the classpath cannot be resolved by any extractor, so a corpus with third-party dependencies has a structural ceiling well below 100% and a single cross-corpus target number is not meaningful. The stub discipline, not the resolution rate, is the property worth asserting.
- The resolution rate counts neither type variables nor `<nulltype>`: neither names anything that could have a declaration, so counting them measures the corpus's writing style. This is not cosmetic — `<nulltype>`, Spoon's static type for the `null` literal, was ALL 1466 of commons-lang's originally-reported unresolved references, making the headline number a function of how many `return null;` statements the corpus contains.
- In noClasspath Spoon promotes an unresolvable RECEIVER to a type in the enclosing package: `typeHint -> typeHint.with(...)` and `cm.setStatisticsEnabled(...)` produced stub classes named `typeHint` and `cm` inside the corpus's own package on spring-petclinic. They are correctly stubbed (membership is the declared-id whitelist), and they are why the whitelist exists — but the stub set of a real corpus therefore contains a tail of entities named after local variables, and a stub count is not a count of external types.
- An array type is not an entity, and neither is its component where a member is concerned. `xs.length` and `int[]::new` declare their member on `int[]` / `Money[]`; folding that up names the component and states a fact the source never wrote. Such facts are dropped, not degraded — the dependency on the component is already carried by the written type reference that mentions it.
- An anonymous class has exactly one id, the `#file:line:column` form pass 1 declared. Spoon names it `Outer$N`, which renders as a plausible nested-type id in the corpus's own package; a reference resolved through that name gives one declared class two ids and launders the second into a stub. Type references must be resolved to their declaration before being named.
- Spoon materializes the implicit constructor of an anonymous class with synthetic parameters named `$anonymousN`. They are emitted (implicit members are, deliberately, so that `new Foo()` does not dangle), so the model contains a handful of parameter entities nobody wrote, carrying no anchor of their own — 5 of 15338 entities on commons-lang.

## JavaScript — `js`

**Edge kinds:** `import` · `inheritance` · `invocation` · `access` · `reference`

| Kind | Required traits | Optional traits |
|---|---|---|
| `arrowFunction` | `TInvocable`, `TSourceAnchor` | `TComment`, `TChildOf`, `TWithChildren`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `class` | `TNamed`, `TType`, `TChildOf` | `TWithInheritances`, `TWithChildren`, `TSourceAnchor`, `TComment` |
| `function` | `TInvocable` | `TNamed`, `TSourceAnchor`, `TComment`, `TChildOf`, `TWithChildren`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `method` | `TNamed`, `TInvocable`, `TChildOf` | `TSourceAnchor`, `TComment`, `TWithChildren`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `module` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TChildOf` | `TTypedEntity`, `TSourceAnchor` |
| `property` | `TNamed`, `TStructural`, `TChildOf` | `TTypedEntity`, `TSourceAnchor`, `TComment` |
| `variable` | `TNamed`, `TStructural` | `TSourceAnchor`, `TComment`, `TChildOf`, `TWithChildren`, `TTypedEntity` |

**Notes**

- A module is a file: `TModule.definedIn` always has exactly one entry (1-1 cardinality, unlike a Java package).
- No `interfaceImplementation` edge kind. JS has no `implements` clause and conformance is duck-typed, so it is never observable statically — the absence of the edge kind is the honest statement, not a gap to fill later with guesses.
- `TTypedEntity` is licensed on variables, parameters, properties and function returns, but `declaredType` is essentially always absent: JS annotates nothing. This is exactly why the attribute is optional rather than required by the trait. An extractor may populate it from JSDoc `@type`/`@param`/`@returns` when present; everything else is left absent rather than inferred.
- Arrow functions and anonymous function expressions carry `TInvocable` without `TNamed`; their id disambiguator is `(file, startLine)`, so they require `TSourceAnchor`.
- `const f = () => {}` yields two entities: the `variable` f and its child `arrowFunction`. Call sites resolve through the variable to the arrow, and `invocation` edges target the `arrowFunction`.
- Dynamic `import(expr)` and `require(expr)` with a computed, template-literal or variable path are unresolvable: no `import` edge is emitted. Only statically literal specifiers produce edges.
- CommonJS/ESM interop is a blind spot: `module.exports = X`, `exports.a = ...`, `__esModule` interop shims and conditional `package.json` exports mean the same physical file can be reached under several specifiers. Ids are keyed on the resolved file path, so a resolver failure produces a stub module rather than a wrong merge.
- Monkey patching (`Obj.prototype.m = fn`, `Object.assign(target, mixin)`, `Object.defineProperty`) adds members at runtime. No method or property entity is created for them; the assignment surfaces only as `access` and `reference` edges at the patch site.
- Duck typing means a call `x.m()` on an unannotated receiver has no resolvable target. Such invocations are either omitted or emitted with provenance `dynamic-candidate` and every same-named method in the corpus listed in `candidates`.
- Computed member access `o[k]` and dynamic property names give `access` edges whose target is unknown; they are omitted rather than guessed at a single field.
- `this` rebinding (`call`/`apply`/`bind`, arrow lexical `this`, extracted methods) breaks receiver-based resolution; edges through a rebound `this` are not reconstructed.
- Getters/setters are emitted as `method` entities; reads and writes of the underlying value at call sites are `access` edges, so a property read that runs code is visible as access, not invocation.
- Class fields and object literal members share the `property` kind; object literals used as namespaces therefore appear as a `variable` with `property` children.

## PHP — `php`

**Edge kinds:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference` · `traitUsage` · `fileInclude`

| Kind | Required traits | Optional traits |
|---|---|---|
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `closure` | `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity` |
| `codeFile` | `TNamed` | `TWithChildren`, `TSourceAnchor`, `TComment` |
| `constant` | `TNamed`, `TStructural`, `TChildOf`, `TSourceAnchor` | `TTypedEntity`, `TComment` |
| `enum` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithImplements`, `TTypedEntity`, `TComment` |
| `function` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `interface` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `method` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `namespace` | `TNamed`, `TModule`, `TWithChildren` | `TChildOf`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `property` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `trait` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |

**Notes**

- fileInclude (include/require/_once) is the metamodel's only file-to-file dependency; its endpoints are `codeFile` entities. A file both declares entities and includes other files, so the same file appears as a codeFile node and as the `anchor.file` of the declarations it contains.
- include/require paths built from variables, concatenation, constants or __DIR__ arithmetic are invisible: only literal paths produce a fileInclude edge.
- `use TraitX;` is a traitUsage edge Type -> Trait and the trait's members are NEVER flattened into the using class. Conflict resolution (`insteadof`, `as`, visibility changes) and abstract trait members are not represented; a resolver must read the trait's own children.
- `use Foo\Bar;` statements are per-file aliases, not namespace-level facts: emit them as import edges and set `sourceFile` to the declaring file so several files sharing a namespace stay distinguishable.
- __call/__callStatic/__get/__set/__invoke are dynamic dispatch: invocation and access edges through magic methods carry provenance 'dynamic-candidate' with a candidates list, or are absent when no candidate can be named.
- Variable variables ($$name), variable functions ($fn()), call_user_func, `new $class` and string class names resolve only for literal arguments; everything else is invisible.
- eval(), conditional declarations inside if/function bodies, and class_alias() are not modelled.
- Single inheritance for classes (at most one inheritance edge); interfaces may extend several, so N edges are legal there.
- Gradual typing: parameter, property and return type declarations are optional, so TTypedEntity.declaredType is often absent. Docblock types (@var, @param) are not authoritative and must not be promoted to declaredType.
- Namespaces are 1-N with files: TModule.definedIn lists every file declaring into the namespace. A file with no `namespace` statement declares into the global namespace.

## Python — `python`

**Edge kinds:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference`

| Kind | Required traits | Optional traits |
|---|---|---|
| `attribute` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithImplements`, `TWithInvocations`, `TWithAccesses`, `TComment` |
| `decorator` | `TAttachedTo`, `TWithInvocations`, `TSourceAnchor` | `TNamed`, `TChildOf`, `TComment` |
| `function` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `lambda` | `TInvocable`, `TWithParameters`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TTypedEntity` |
| `method` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TAttachedTo`, `TComment` |
| `module` | `TNamed`, `TModule`, `TWithChildren` | `TChildOf`, `TSourceAnchor`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `variable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor`, `TComment` |

**Notes**

- A module is a file: TModule.definedIn holds exactly one path (1-1 cardinality). A package is the module of its __init__.py.
- Multiple inheritance emits N inheritance edges from the class. MRO (C3 linearization) order is NOT represented: the edge set is unordered, so method-resolution questions cannot be answered from the model.
- Protocols (PEP 544) are structural, never declared: conformance yields interfaceImplementation edges with provenance 'derived'. Explicit `class X(Protocol)` subclassing is a plain declared inheritance edge instead.
- Decorators that synthesize members (dataclasses, attrs, ORM/metaclass bases) emit the members and their edges with provenance 'generated'; a pre-expansion extraction sees none of them.
- Duck typing: a call whose receiver type is not statically known resolves to provenance 'dynamic-candidate' with a candidates list, or is absent entirely.
- Monkey patching (assigning functions or attributes onto classes and modules at runtime) is invisible to static extraction; the model shows the original definition site only.
- getattr/setattr/hasattr and importlib.import_module/__import__ resolve only for literal string arguments; computed names produce no edge.
- Type hints are optional and may be deferred strings (PEP 563 / `from __future__ import annotations`), so TTypedEntity.declaredType is frequently absent even where the trait is present.
- `from x import *` yields a module-level import edge only; the individual names it binds cannot be attributed.
- Conditional and `if TYPE_CHECKING:` imports are emitted like any other import — this profile declares no Space, so type-only dependencies are indistinguishable from runtime ones.

## Rust — `rust`

**Edge kinds:** `import` · `interfaceImplementation` · `invocation` · `access` · `reference`

| Kind | Required traits | Optional traits |
|---|---|---|
| `const` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `crate` | `TNamed`, `TModule`, `TWithChildren` | `TComment` |
| `enum` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `field` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `function` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `impl` | `TWithChildren`, `TAttachedTo`, `TSourceAnchor` | `TChildOf`, `TComment` |
| `localVariable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor`, `TComment` |
| `method` | `TNamed`, `TInvocable`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `module` | `TNamed`, `TModule`, `TWithChildren`, `TChildOf` | `TSourceAnchor`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor` |
| `struct` | `TNamed`, `TType`, `TWithImplements`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `trait` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `typeAlias` | `TNamed`, `TType`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment` |

**Notes**

- Rust has no inheritance: TWithInheritances and the `inheritance` edge kind are absent from this profile by design, not by omission. Supertrait bounds (`trait A: B`), generic bounds and where-clauses are `reference` edges.
- The impl block is reified (METAMODEL.md §7): an anonymous entity with [TWithChildren, TAttachedTo, TSourceAnchor] and no TNamed, `attachedTo` the implementing type, its methods as children. The interfaceImplementation edge Type -> Trait takes that block as its anchor. Inherent `impl Type` blocks carry no such edge but still own their methods.
- Imports exist at two levels: `use` paths inside the module tree and crate dependencies declared in Cargo.toml. Both are `import` edges; the level is read from the endpoints' kinds (module vs crate), never from the id string.
- Modules are N-N with files: TModule.definedIn lists every file contributing to a module — inline `mod x { }` blocks put several modules in one file, while mod.rs plus sibling files (and #[path] attributes) spread one module tree over many.
- Blanket impls (`impl<T: Bound> Trait for T`) and derived trait impls yield interfaceImplementation edges with provenance 'derived': the concrete implementing types are computed by the analysis, not written in the source.
- #[derive(...)], macro_rules! and proc-macro expansion produce entities and edges with provenance 'generated'. A pre-expansion extraction sees none of them; a post-expansion one must anchor them at the invocation site.
- `dyn Trait` objects, generic calls and function pointers resolve to provenance 'dynamic-candidate' with the known impls as candidates.
- cfg-gated code (`#[cfg(...)]`, feature flags, target attributes) may be absent from any single extraction: a model reflects exactly one configuration, so two extractions of the same crate can legitimately differ in entity set.
- Trait default method bodies live in the trait, not in the impl blocks that inherit them; their invocation and access edges originate from the trait's method, and an impl that does not override the method has no child for it.
- Enum variants are not reified as a kind of their own: the enum is the type-level unit, variant payload types appear as `reference` edges from it, and named variant fields are `field` children.
- `static` items map to the `const` kind. Tuple-struct fields are named by their position ("0", "1", ...). Shadowed `let` bindings produce several localVariable entities disambiguated by (file, startLine).
- The `self` receiver is not emitted as a parameter; the receiver relation is the impl block's attachment.

## TypeScript — `ts`

Declaration spaces: `abstractClass`, `arrowFunction`, `class`, `enum`, `function`, `interface`, `method`, `module`, `namespace`, `parameter`, `property`, `typeAlias`, `variable`.

**Edge kinds:** `import` · `inheritance` · `interfaceImplementation` · `invocation` · `access` · `reference`

| Kind | Required traits | Optional traits |
|---|---|---|
| `abstractClass` | `TNamed`, `TType`, `TChildOf` | `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TSourceAnchor`, `TComment` |
| `arrowFunction` | `TInvocable`, `TSourceAnchor` | `TComment`, `TChildOf`, `TWithChildren`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `class` | `TNamed`, `TType`, `TChildOf` | `TWithInheritances`, `TWithImplements`, `TWithChildren`, `TSourceAnchor`, `TComment` |
| `enum` | `TNamed`, `TType`, `TWithChildren` | `TChildOf`, `TSourceAnchor`, `TComment` |
| `function` | `TInvocable` | `TNamed`, `TSourceAnchor`, `TComment`, `TChildOf`, `TWithChildren`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `interface` | `TNamed`, `TType` | `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor`, `TComment` |
| `method` | `TNamed`, `TInvocable`, `TChildOf` | `TSourceAnchor`, `TComment`, `TWithChildren`, `TTypedEntity`, `TWithParameters`, `TWithLocalVariables`, `TWithInvocations`, `TWithAccesses` |
| `module` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment` |
| `namespace` | `TNamed`, `TWithChildren` | `TModule`, `TChildOf`, `TSourceAnchor`, `TComment` |
| `parameter` | `TNamed`, `TStructural`, `TChildOf` | `TTypedEntity`, `TSourceAnchor` |
| `property` | `TNamed`, `TStructural`, `TChildOf` | `TTypedEntity`, `TSourceAnchor`, `TComment` |
| `typeAlias` | `TNamed`, `TType` | `TTypedEntity`, `TChildOf`, `TSourceAnchor`, `TComment` |
| `variable` | `TNamed`, `TStructural` | `TSourceAnchor`, `TComment`, `TChildOf`, `TWithChildren`, `TTypedEntity` |

**Notes**

- This is the only profile that populates `Entity.space` (METAMODEL.md §1.4). Type-space only (`space: ["type"]`): `interface`, `typeAlias`. Both spaces (`["type", "value"]`): `class`, `abstractClass`, `enum`, and a `namespace` that declares at least one value. Value-space only (`["value"]`): `module`, `function`, `arrowFunction`, `method`, `variable`, `parameter`, `property`.
- A dependency whose target is type-space only is ERASED at runtime: it exists for the type checker and leaves nothing in the emitted JavaScript. Runtime, bundling and deployment analyses should therefore filter edges whose `to` resolves to a `space: ["type"]` entity; architectural coupling and design analyses should keep them, since the design dependency is real. Because the distinction is per-analysis, the model always stores both and never pre-filters.
- `import type { X }` and inline `type` specifiers produce ordinary `import` edges; they are erased at runtime and are recognized by the space of their target, not by a separate edge kind.
- Structural (non-nominal) typing: a class conforms to an interface without any `implements` clause. `interfaceImplementation` therefore carries provenance `declared` only for an explicit `implements`; conformance computed by shape comparison is `derived`, and the two must never be merged. Any analysis wanting facts filters on `declared`.
- Declaration merging means one id may be declared in several files: interface+interface, namespace+namespace, namespace+class/function/enum, and ambient module augmentation from a dependency. `TSourceAnchor` records only one declaration site, so edges carry `sourceFile` to say which site produced them.
- Ambient declarations (`.d.ts`, `declare module`, `declare global`) describe entities with no implementation in the corpus. They are emitted as real entities anchored in the `.d.ts`; the implementation they describe, when outside the corpus, is a stub.
- `any` erases resolution completely: a call or member access through an `any`-typed (or `unknown`-narrowed-by-cast, or index-signature) receiver has no target. Such edges are omitted, or emitted with provenance `dynamic-candidate` and a `candidates` list. The proportion of `any`-typed receivers is the honest ceiling on this profile's resolution rate.
- `const enum` members are inlined at emit, leaving no runtime entity; references to them survive only in the type space.
- `declaredType` is populated where a type is annotated. Full inference requires the TypeScript checker; an extractor running without a program leaves inferred types absent rather than guessing — the reason `TTypedEntity.declaredType` is optional even here.
- Generic type parameters are not reified as entities; a use of `Array<Order>` yields a `reference` edge to `Order` and none to `Array`'s parameter slot.
- Decorators and `emitDecoratorMetadata` synthesize members and metadata reads; entities and edges attributable to them carry provenance `generated`.
- A module is a file (`TModule.definedIn` has exactly one entry). `namespace` blocks are separate entities: several per file, and one namespace id may span files through merging.
- Path resolution depends on `tsconfig` `paths`, `baseUrl` and `package.json` exports; an unresolved specifier becomes a stub module rather than a dropped edge, so import fan-out stays honest.
- Enum members are emitted as `property` children of the `enum`.
