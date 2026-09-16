# `fixtures/elixir` — the reference corpus for the Elixir extractor

A small, plausible order-management corpus (23 files, ~260 lines) shaped like
a Mix project — `mix.exs`, `config/`, `lib/`, `test/` — that exercises the
extraction hazards PLAN.md §16 names. It is the acceptance corpus for
`extractors/elixir`: the snapshot `expected/model.jsonl` is produced from
**this** tree, and every row of the table below is a behaviour a reviewer can
check by eye.

```bash
./build.sh --elixir
./bin/codegraph-elixir --src fixtures/elixir/src --out model.jsonl
```

Run it from the repository root with that relative `--src`: the typed path is
the header's `root`, so an absolute one differs from the snapshot in its first
line. `--src fixtures/elixir/src` is the analysis root, so a file's key is
`lib%2Facme_order%2Forder.ex` — the root-relative path, escaped — and its
`name` the path as written.

## This corpus does not compile, on purpose

`mix compile` would fail at the first `use Ecto.Schema`: `ecto_sql` and
`jason` are declared in `mix.exs` and never fetched — the ordinary legacy
case. Codegraph exists to extract from what no longer builds; a corpus with
its `deps/` present could not test the stub discipline at all. Every module
those dependencies would provide is a stub below `<deps>`; everything the
BEAM ships (`GenServer`, `Enum`, `Mix.Project`, `ExUnit.Case`, `Config`) is a
stub below `<otp>`, decided by the module and export table the extractor
embeds at build time — never by a name prefix. A stub has no members: a call
to `Enum.map/2` is an invocation of `<otp>/Enum`.

**Do not "fix" `legacy/broken.ex`**: it does not parse, and the extractor
must skip it, count it, and still write its file record.

## What each file pins

| File | Pins | Why it is easy to get wrong |
|---|---|---|
| `mix.exs` | A `.exs` is walked like an `.ex`; `use Mix.Project` → an `import` edge to `<otp>/Mix.Project` AND an invocation of `Mix.Project.__using__/1` from the module; `defp deps` carries `private: true`; `project/0` calls `deps/0`. | A script file is still a file module; `use` is a written call. |
| `config/config.exs` | A file with no `defmodule`: `import Config` is an `import` edge FROM the file; the top-level `config/2,3` calls are invocations from the FILE (resolved through the import to `<otp>/Config`), and `AcmeOrder.Repo` named in them is a reference. | A file may be a module with no type below it, and still have edges. |
| `lib/acme_order/order.ex` | **Arity is identity**: `create/2` with a default is ONE entity `create#2` (`defaults: 1`), the two `total/1` clauses one entity spanning lines 19–25 (`cyclomatic: 2`); `defdelegate describe(order)` is a `function` invoking `Reporting.describe_order/1`; `alias AcmeOrder.{Line, Money}` and `alias …, as: DefaultPricing` are import edges to corpus files. **Parameters** `create#2#param:reference`, `#param:opts` (default `[]` as a value); **fields** `reference`, `lines` (`[]`), `channel` (`:web` unevaluated), `pricing` (a `type` literal naming `Pricing.Standard`); **attribute** `@max_lines` = 100, read (`access`, `isRead`) from `create/2` and from `add_line/2`'s guard; `%__MODULE__{…}` constructions write fields (`isWrite`); `\|> Enum.take(@max_lines)` reaches `Enum.take/2`; `&Money.add/2` is a `reference`; `raise TooManyLines` a `throws`; `@type t` names `Line` and `String` — references from the module; `@doc` is `create/2`'s comment; `pricing.price(…)` is dropped (`dynamic_dispatch`), `order.channel` (`map_access`). | A default-generated arity and a clause are not declarations of their own; a struct literal is the only static field access. |
| `lib/acme_order/money.ex` | **`defimpl` inside the module**: `String.Chars.AcmeOrder.Money` is a named `module` in this file, `attachedTo` `AcmeOrder.Money`, and the `interfaceImplementation` edge runs Money → `<otp>/String.Chars` anchored at the block (lines 16–18); `@derive Jason.Encoder` → `interfaceImplementation` to `<deps>/Jason.Encoder`, provenance `generated`; `new/2` has a default `"EUR"` as its parameter's value; the head patterns of `add/2` READ `currency`, the update writes `amount`; the string interpolation's `Kernel.to_string/1` is the language, no edge. | The impl module's name is the compiler's; the relation the name only implies is written as attachment; `@derive` is defined by the language. |
| `lib/acme_order/pricing.ex` | A behaviour module: two `@callback`s → `callback` entities `price#2`, `discount#2`, each referencing `Line`/`Money` from its spec. | A callback has no body: no invocations, no accesses. |
| `lib/acme_order/pricing/standard.ex`, `premium.ex` | `@behaviour AcmeOrder.Pricing` → `interfaceImplementation` to the DECLARED module in `pricing.ex`, `declared`; `alias AcmeOrder.Pricing.Standard` → an import edge file → file; Premium's `Standard.price(line, :phone) \|> Standard.discount(pct: 5)` → `discount#2` through the pipe. | Resolvability is not membership: the target is corpus because the whitelist says so. |
| `lib/acme_order/priceable.ex` | `defprotocol` → kind `protocol`, its `def`s → `callback`; three `defimpl … for:` blocks → three named modules, edges Order → Priceable, Money → Priceable and `<otp>/Any` → Priceable. | `Any` is a language pseudo-type, not a module on the code path. |
| `lib/acme_order/reporting.ex` | **Dynamic dispatch, honestly**: `Priceable.price(item)` is an `invocation` of the callback `Priceable.price#1` with provenance `dynamic-candidate` and the three corpus impls as `candidates`; `GenServer.call(AcmeOrder.Stock, :peek)` is an invocation of `<otp>/GenServer` AND a `dynamic-candidate` invocation of `Stock.handle_call#3`; `@spec` types → references from the function. | A candidate set is never a guess: the corpus holds every impl and every handler. |
| `lib/acme_order/stock.ex` | `use GenServer` → `<otp>/GenServer`; `handle_call/3` written as two clauses is one entity; `GenServer.call(__MODULE__, …)` and `cast` → `dynamic-candidate` invocations of the handlers; `GenServer.call(pid, :peek)` dropped (`dynamic_dispatch`); `:ets.lookup/2` → `<otp>/ets`; `@table` is an attribute read from four functions. | |
| `lib/acme_order/repo.ex`, `schema/line.ex` | `use Ecto.Repo`, `use Ecto.Schema`, `import Ecto.Changeset`, `import Ecto.Query, only: [from: 2]` → stubs below `<deps>`; `field`/`schema`/`belongs_to`/`timestamps` and `cast`/`validate_required` are dropped as `local_injected` — the module `use`s a foreign module, so nothing honest can say who provides them; `from/1` (arity from the call, not `from: 2`) too. | The honest ceiling without `--deps`/`--trace`; `AcmeOrder.Order` in `belongs_to` is still a reference. |
| `lib/acme_order/macros.ex` | `defmacro` and `defguard` → kind `macro`; a `quote` block's `import` and calls are NOT edges of this module; `Keyword.get/3` in `__using__/1` is. | A quoted form belongs to whoever expands it. |
| `lib/acme_order/notifier.ex` | **Nesting**: `defmodule Email` and `defmodule Sms.Gateway` inside `AcmeOrder.Notifier` are `AcmeOrder.Notifier.Email` and `AcmeOrder.Notifier.Sms.Gateway`, children of the FILE; `import Kernel, except: [length: 1]` → an import edge to `<otp>/Kernel` and `length(order.lines)` resolves to the module's OWN `length/1`; a function-scoped `alias …, as: Mail` names this file (a self-edge, dropped) and `Mail.deliver(order)` resolves through it; `use AcmeOrder.Macros` → a corpus import AND an invocation of the corpus `__using__#1`; `Logger.info` → `<otp>/Logger`. | Nesting is an alias, not a containment; a scoped alias applies to what follows it in the body. |
| `lib/acme_order/errors.ex` | A nested `defexception` module with `field`s `max` and `message` (`"too many lines"` as a value); `raise "text"` → `throws` to `<otp>/RuntimeError`; the `rescue` clause's `raise ArgumentError, "wrapped"` → `throws` to `<otp>/ArgumentError`; `reraise e, __STACKTRACE__` dropped (`throw_dynamic`). | Every block of a definition is its body. |
| `lib/acme_order/dynamic.ex` | `apply/3`, `mod.f()`, `GenServer.cast(pid, …)` — dropped and counted as `dynamic_dispatch`; `Module.concat(AcmeOrder.Pricing, name)` is an invocation of `<otp>/Module` and a reference to `Pricing`. | No static reader may guess these. |
| `lib/acme_order/application.ex` | `use Application`; the `children` list references `Repo`, `Stock` and `<otp>/Registry` — the supervision tree as references; `AcmeOrder.Registry`/`AcmeOrder.Supervisor` used as registered NAMES land below `<deps>` (nothing declares them). | A module atom in argument position is a value. |
| `lib/acme_order/legacy/broken.ex` | **A syntax error**: skipped, counted as `unparsed`, the file record still written with nothing below it and `sloc: 0`. | Never fatal. |
| `lib/acme_order/legacy/atom_module.ex` | `defmodule :"legacy.mod"`: an atom-named module whose dot is escaped in the key (`legacy%2Emod`) and kept in the name. | The reason module-atom dots are escaped at all. |
| `lib/acme_order/two_modules.ex` | Two `defmodule`s in one file, both children of it; `@channels` is an attribute whose value is an array of unevaluated atoms; `&Atom.to_string/1` a reference to `<otp>/Atom`; `alias AcmeOrder.Channel` inside the second names this file — a self-edge, dropped. | |
| `lib/acme_order/promo#2024.ex` | A `#` in a file name → `promo%232024.ex` in the key, the written path in `name`; `%Money{money \| amount: …}` from another module: a READ of `Money.amount` in the head and a WRITE in the update. | `#` is a reserved separator of the rendered id; cross-module field accesses are what the navigator lists. |
| `test/acme_order/order_test.exs` | `use ExUnit.Case` → `<otp>/ExUnit.Case`; the `test` blocks are module-level code, so their calls (`Order.create/2`, `Order.total/1`, `Money.zero/0`) are invocations FROM the test module; `%Line{…}` is a reference to `Line` whose fields are unbound (Ecto-injected). | Tests are corpus; a `test` macro's body is compile-time code of the module. |
