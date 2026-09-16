# `fixtures/elixir` — the reference corpus for the Elixir extractor

A small, plausible order-management corpus (23 files, ~250 lines) shaped like
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
stub below `<otp>`, decided by the module table the extractor embeds at build
time — never by a name prefix.

**Do not "fix" `legacy/broken.ex`**: it does not parse, and the extractor
must skip it, count it, and still write its file record.

## What each file pins

The walking skeleton (M15a) extracts files, modules, functions with arity,
the four import forms, `@behaviour` and `defimpl`, and stubs. Rows marked
*M15b* describe what the same file will pin once the model is complete.

| File | Pins | Why it is easy to get wrong |
|---|---|---|
| `mix.exs` | A `.exs` is walked like an `.ex`; `use Mix.Project` → an `import` edge to `<otp>/Mix.Project`; `defp deps` carries `private: true`. | A script file is still a file module; Mix is part of what the BEAM ships. |
| `config/config.exs` | A file with no `defmodule`: `import Config` is an `import` edge FROM the file. *M15b*: the top-level `config/3` calls are invocations from the file. | A file may be a module with no type below it. |
| `lib/acme_order/order.ex` | **Arity is identity**: `create/2` with a default is ONE entity `create#2` (`defaults: 1`), the two `total/1` clauses one entity spanning lines 19–25, `add_line#2` lines 27–31; `defdelegate describe(order)` is a `function`; `alias AcmeOrder.{Line, Money}` and `alias …, as: DefaultPricing` are import edges to corpus files. *M15b*: struct fields, `@max_lines` accesses, the pipe's arity, `pricing.price(…)` dropped. | A default-generated arity and a clause are not declarations of their own. |
| `lib/acme_order/money.ex` | **`defimpl` inside the module**: `String.Chars.AcmeOrder.Money` is a named `module` in this file, `attachedTo` `AcmeOrder.Money`, and the `interfaceImplementation` edge runs Money → `<otp>/String.Chars` anchored at the block (lines 16–18). *M15b*: `@derive Jason.Encoder` → `generated`. | The impl module's name is the compiler's; the relation the name only implies is written as attachment. |
| `lib/acme_order/pricing.ex` | A behaviour module. *M15b*: two `@callback`s → `callback` entities. | |
| `lib/acme_order/pricing/standard.ex`, `premium.ex` | `@behaviour AcmeOrder.Pricing` → `interfaceImplementation` to the DECLARED module in `pricing.ex`, `declared`; `alias AcmeOrder.Pricing.Standard` → an import edge file → file. | Resolvability is not membership: the target is corpus because the whitelist says so. |
| `lib/acme_order/priceable.ex` | `defprotocol` → kind `protocol`, its `def`s → `callback`; three `defimpl … for:` blocks → three named modules, edges Order → Priceable, Money → Priceable and `<otp>/Any` → Priceable. | `Any` is a language pseudo-type, not a module on the code path. |
| `lib/acme_order/stock.ex` | `use GenServer` → `<otp>/GenServer`; `handle_call/3` written as two clauses is one entity. *M15b*: `GenServer.call(__MODULE__, …)` → `dynamic-candidate` with the handler clauses; `:ets.lookup/2` → `<otp>/ets`. | |
| `lib/acme_order/repo.ex`, `schema/line.ex` | `use Ecto.Repo`, `use Ecto.Schema`, `import Ecto.Changeset`, `import Ecto.Query` → stubs below `<deps>`. *M15b*: `field`/`schema`/`belongs_to` are `local-unbound` (macro-injected), `cast/3` is `import-attributed`. | The honest ceiling without `--trace`. |
| `lib/acme_order/macros.ex` | `defmacro` and `defguard` → kind `macro`; a `quote` block's `import` is NOT an edge of this module. | A quoted form belongs to whoever expands it. |
| `lib/acme_order/notifier.ex` | **Nesting**: `defmodule Email` and `defmodule Sms.Gateway` inside `AcmeOrder.Notifier` are `AcmeOrder.Notifier.Email` and `AcmeOrder.Notifier.Sms.Gateway`, children of the FILE; `import Kernel, except:` → an import edge to `<otp>/Kernel`; a function-scoped `alias` inside `notify/1` names this file → a self-edge, dropped and counted; `use AcmeOrder.Macros` → a corpus import. | Nesting is an alias, not a containment. |
| `lib/acme_order/errors.ex` | A nested `defexception` module. *M15b*: `raise`/`reraise` → `throws`. | |
| `lib/acme_order/dynamic.ex` | *M15b*: `apply/3`, `mod.f()`, `Module.concat`, `GenServer.cast(pid, …)` — dropped and counted as `dynamic-dispatch`. | No static reader may guess these. |
| `lib/acme_order/reporting.ex` | *M15b*: `@spec` naming `Order.t()` → a `reference`. | |
| `lib/acme_order/legacy/broken.ex` | **A syntax error**: skipped, counted as `unparsed`, the file record still written with nothing below it. | Never fatal. |
| `lib/acme_order/legacy/atom_module.ex` | `defmodule :"legacy.mod"`: an atom-named module whose dot is escaped in the key (`legacy%2Emod`) and kept in the name. | The reason module-atom dots are escaped at all. |
| `lib/acme_order/two_modules.ex` | Two `defmodule`s in one file, both children of it; `alias AcmeOrder.Channel` inside the second names this file — a self-edge, dropped. | |
| `lib/acme_order/promo#2024.ex` | A `#` in a file name → `promo%232024.ex` in the key, the written path in `name`. | `#` is a reserved separator of the rendered id. |
| `test/acme_order/order_test.exs` | `use ExUnit.Case` → `<otp>/ExUnit.Case`; tests are corpus. | |
