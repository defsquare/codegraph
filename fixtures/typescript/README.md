# `fixtures/typescript` — the reference corpus for the TypeScript extractor

A small, plausible order-management corpus (23 files, ~330 lines) that
exercises every extraction hazard PLAN.md §14 names — `acme-order` as an ES
module package tree, plus a **legacy script half** in the `namespace` +
`/// <reference path>` style. It is the acceptance corpus for
`extractors/typescript`: the snapshot `expected/model.jsonl` is produced from
**this** tree, and every row of the table below is a behaviour a reviewer can
check by eye.

```bash
pnpm -r build
./bin/codegraph-typescript --src fixtures/typescript/src --out model.jsonl
```

Run it from the repository root with that relative `--src`: the typed path is
the header's `root`, so an absolute one differs from the snapshot at byte 138.
`--src fixtures/typescript/src` is the analysis root, so a module's key is
`packages%2Forder%2Fsrc%2Forder.ts` — the root-relative path, escaped — and
its `name` the path as written.

## This corpus does not type-check, on purpose

`tsc` reports errors, every one of them about something the corpus
deliberately never provides:

| Missing | Where | Why it is missing |
|---|---|---|
| the package `@megacorp/ledger` | imported by `ledger-adapter.ts`, extended by `LedgerAdapter` | a dependency that is not installed — the ordinary legacy case. The import is a stub MODULE keyed by the specifier; the type it should have provided is a stub in `<unresolved>`, named as written; every call through the `any` it leaves behind is dropped and counted |
| a JSX runtime | `ui/order-table.tsx` | no `@types/react`: intrinsic elements have no types, and the component call still resolves |
| `node_modules` | everywhere | `packages/pricing` is imported by NAME (`@acme/pricing`) with nothing installed and nothing built: the workspace resolver reads `package.json` and falls back to `src/index.ts` when `main` points at an absent `dist/` |

**Do not "fix" these.** Codegraph exists to extract from what no longer
builds; a corpus that type-checks cleanly cannot test the stub discipline at
all. `tsconfig.json` sets `"types": []` so the repository's own `@types/node`
never leaks into the snapshot — the committed bytes are reproducible from a
bare checkout on any machine.

## What each file pins

| File | Pins | Why it is easy to get wrong |
|---|---|---|
| `tsconfig.json` | **Resolution options only.** `paths` maps `@order/*`; `lib` and `types: []` fix the standard library. | The extractor never reads `files`/`include`: the roots define the corpus. A `tsconfig` found above a root would be applied to every file under it. |
| `packages/pricing/package.json` | **The workspace resolver.** `main` and `types` point at `dist/`, which does not exist. | Standard resolution fails; the fallback resolves the package by NAME to `src/index.ts`, counted separately on stderr (`workspace-resolved: 1`). Reading `node_modules` or following `exports` into `dist/` would be a build, not a corpus. |
| `order.ts` | **Three ways to import, one edge kind.** `@acme/pricing` by name, `@order/channel` by `paths`, `./abstract-order.js` relatively, `import type { Cents }` erased. **`#static`**: `static parse()` beside `parse()`. **Values**: `MAX_LINES = 4 * 25` rides `unevaluated` (TypeScript folds nothing), `CURRENCY = "EUR"` is a string. A default `channel = Channel.Web` is an enum value. | `import type` is an ordinary import edge — erasure shows in the TARGET's `space`, never in the edge kind. A lone static (`Money.zero`) carries no `#static`. |
| `abstract-order.ts` | `abstractClass`; a **parameter property** `readonly reference` declares a field; `protected total`. | `props.order.reference` in `order-table.tsx` must land on `AbstractOrder.reference` — a parameter property is a property, not a parameter (parameters are never edge targets). `this.total -= pct` in `Order.discount` is an access that reads AND writes. |
| `money.ts` | **Accessor pair** `get amount` / `set amount` → `#get` / `#set`; a `#private` → `%23secret`; a string-literal member `"as.text"` → `as%2Etext`; `type Cents = number` (type space only, no `declaredType` — a primitive alias); `implements Priceable`. | A write `this.#secret = …` inside the setter targets the field; a read of `this.amount` targets `#get`. `.` in a name is escaped so it never reads as nesting. |
| `discountable.ts` | **Same-file merging**: `interface Discountable` twice → one entity anchored at the FIRST; `extends Priceable` is `inheritance`. | `interface extends interface` is never `interfaceImplementation`; the `interface` kind has no `TWithImplements` at all, so getting it wrong fails profile validation rather than merely being wrong. |
| `channel.ts` | A plain `enum` (both spaces) whose members carry values the checker computes (`Phone = Store + 1` → 11, plus an `access` to `Store` FROM the member); a **`const enum`** (`space: ["type"]`). | A const enum is inlined at emit: a dependency on it leaves nothing at runtime. |
| `notifications.ts` | **Two arrows starting on one line** (`chain(() => …, () => …)` at 8:16 and 8:57); an arrow bound to a const (`onShipped` → the variable AND its child `onShipped#4:26`); a nameless function expression (`shout#19:22`); a **top-level IIFE** (`#23:2`, empty symbol, parent = the module, the module carries `TWithInvocations`). Calls through the callback parameters `first()`/`second()` are dropped and counted (`indirect calls dropped: 2`). | `(file, line)` alone would merge the two arrows — the M7 lesson, a column is a source fact. A call site resolves THROUGH the variable to the arrow. |
| `reporting.ts` | **Overloads are one entity** (`describe`, anchored at the implementation, line 28). **Throw sites**: a guard, a narrowed rethrow (`if (error instanceof OrderError) throw error`) and a wrap → three `throws` to `OrderError`; `throw "not an error type"` is dropped (`throw sites dropped: 1`). `class OrderError extends Error` → inheritance from `<lib>/Error`. | A rethrow of the raw `unknown` catch binding has no type; only narrowing gives it one. `String(error)` folds to the lib's `StringConstructor` — one target, not one per merged lib declaration. |
| `decorators.ts` | **`annotationUse`** with written arguments named after the factory's parameters: `@Audited("monthly")` → `{tag}`, `@Audited("max", true)` → `{tag, verbose}`. `Report.max`: hand-counted cyclomatic 4 (for-of, if, `??`). | Nothing inside a decorator is a call or an access of its own. |
| `ambient.d.ts` | **A corpus-declared ambient module.** A SCRIPT `.d.ts` (no import/export): `declare module "legacy-lib"` declares the module `ts:legacy-lib`, `isStub: false`, and `Thing`/`load` are its members. | With an `export {}` the file becomes a module and the same block turns into an AUGMENTATION of nothing — the first version of this fixture made exactly that mistake. |
| `augment.ts` | **A module augmentation**: `interface Thing { extra(): void }` merges into the class — ONE entity, `extra` parented by `ts:legacy-lib/Thing`, and `legacy-lib` gains a second `definedIn`. **`declare global`**: `AcmeWindow` is a child of THIS file (containment is where it is written). `Wrapper extends Thing`. | Merging across kinds takes the strongest (class > interface); the augmenting block is no entity of its own. |
| `ui/order-table.tsx` | **JSX**: `<Row order={row}/>` is an `invocation` of `Row` from the arrow at 7:17; `<table>`/`<tr>`/`<td>` yield nothing. A destructured parameter `{ rows }` → `#param:rows`; a type-literal member (`{ order: Order }`) is NOT an entity. | An element is a call by the language definition. |
| `legacy/list.ts` | **Recursion**: `length()` calls `this.tail.length()` — a self-edge, dropped at the source (`self-edges dropped: 1`). | Cyclomatic 2 (one ternary). |
| `basket.ts` | An **object literal used as a namespace**: `Ops` is a `variable` with `TWithChildren`, `create` a `method` below it, `"max.lines"` and `[Symbol.iterator]` properties (the latter holding a nameless generator `function`). `new Basket()` with no written constructor → an invocation of the CLASS. `readonly lines: Line[] = []` → an array value. | `Symbol.iterator` as a computed name is an access to `<lib>/SymbolConstructor` from the property — once, not once per merged lib declaration. |
| `lazy.ts` | A dynamic `import("./reporting.js")` with a literal is an import edge; `` import(`./${name}.js`) `` is dropped and counted. | Only statically literal specifiers produce edges. |
| `handler.ts` | A **nameless default export** → `default`; an import of `./promo#2024.js`. | |
| `promo#2024.ts` | A **`#` in a file name** → `promo%232024.ts` in the key, the written path in `name`. | `#` is a reserved separator of the rendered id. |
| `index.ts` | `export * from`, a renamed re-export, `export type { … }` — three import edges. | |
| `résumé.ts` | Non-ASCII identifiers and text, written unescaped. | |
| `legacy/acme.ts` | **A script file**: `namespace Acme.Order` is global to the checker and a child of THIS file in the model (`ts:legacy%2Facme.ts/Acme.Order`); `A.B` is two namespace entities sharing one JSDoc, attached to `A`. | There is no `<global>` module: containment is where a thing is written. |
| `legacy/acme-report.ts` | `/// <reference path>` → an import edge; **the same namespace merged ACROSS files** → a second entity in this file; `Report extends Registry` resolves INTO `acme.ts` — the declaration that owns the member. | Merging yields one entity per declaring file. |

## What the summary says, and why

```
type references : 33   resolved : 32   unresolved : 1   (LedgerClient)
any-typed receivers (dropped) : 1                        (this.send in LedgerAdapter.post)
imports : 20 (unresolved: 1, workspace-resolved: 1)      (@megacorp/ledger; @acme/pricing)
entities : 193 (stubs: 14 — lib 10, packages 0, <unresolved> 1, modules 3)
edges : 127 (self-edges dropped: 1, indirect calls dropped: 2, computed imports dropped: 1, throw sites dropped: 1)
```

Every dropped thing is counted: the model is a lower bound that says where it
stopped, never a guess.
