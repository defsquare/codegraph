---
title: Elixir extractor
linkTitle: Elixir extractor
weight: 12
---

`codegraph-elixir` 0.2.0 — the Elixir extractor on the compiler's own parser. A Mix project in `extractors/elixir/`, built into an **escript** and released as one binary that carries its runtime. It is the parser as a library: **every `*.ex` and `*.exs` under the roots is parsed with `Code.string_to_quoted/2`**, names resolve through a lexical scope and a table of what the BEAM ships, nothing is compiled, no `deps/` is read, and a file the parser rejects is skipped and counted. It emits [`model.jsonl`](/docs/reference/model-jsonl/) and nothing else: all trait, profile and validation logic lives in `@codegraph/core`.

```bash
brew install defsquare/tap/codegraph-elixir     # Erlang and Elixir inside; Apple silicon, or the release's codegraph-elixir-linux-x64
codegraph-elixir --src <dir> --out model.jsonl

# from a clone — the escript runs wherever Erlang/OTP 27+ is on PATH
./build.sh --elixir                              # mix escript.build → extractors/elixir/dist/codegraph-elixir
./bin/codegraph-elixir --src <dir> --out model.jsonl
```

The escript is one file with Elixir embedded; the machine that runs it needs Erlang/OTP, as a jar needs a JDK. The released binary is the escript plus its own runtime in one file, so it needs nothing. Building needs Elixir 1.18+ on OTP 27+: `build.sh` looks for `elixir` on `PATH`, then under `~/.local/share/beam`, then in asdf and mise shims; `extractors/elixir/.tool-versions` pins what CI builds with. Installing any extractor from the tap also installs the [metrics pass](/docs/reference/metrics-pass/).

## Synopsis

```
codegraph-elixir [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                 [--deps <dir>] [--trace <file>] [--explain-dropped]
                 [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
                 [--version] [--help]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src <dir>` | source root; repeatable. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's `root`. `_build`, `deps`, `.git`, `node_modules` and `.elixir_ls` are skipped: build output and dependencies are never sources | the current directory |
| `--out <file>` | where to write the model | `<current-dir>-codegraph.jsonl` |
| `--progress <m>` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` | `auto` |
| `--no-progress` | same as `--progress none` | — |
| `--deps <dir>` | parse dependency sources under `<dir>` for their **exports** only (names and arities); keys never change, only counts do | none, even when `deps/` exists beside the roots |
| `--trace <file>` | merge the compiler trace `mix codegraph.trace` wrote inside the project: calls the parser cannot see (macro-injected) become `generated` edges; keys never change | — |
| `--explain-dropped` | list every dropped site on stderr (reason, `file:line`, name/arity); the model is unchanged | — |
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

- **A lexical scope, as the compiler keeps it.** `alias`, `import`, `require` and `use` as written, the auto-alias of a nested `defmodule`, `__MODULE__`; a form written inside a function body applies to that body alone. A local call resolves to a definition of the enclosing module with that name and arity, else through an explicit `import` that exports it, else to `Kernel` — and a `Kernel` binding is the language: resolved, counted, never an edge.
- **An OTP table, embedded at build time.** Every module and export of the Elixir and Erlang/OTP the extractor was built with — `Enum` and `:ets` side by side, one VM — the way the Java image carries the API distilled from `ct.sym`. A module in the table is a stub below `<otp>`; a module nothing declares is a stub below `<deps>`; a module declared under the roots is corpus. Membership is never decided by a name prefix. The header names the versions the table was made from:

  ```json
  {"name":"codegraph-elixir","version":"0.2.0","elixir":"1.18.4","otp":"27"}
  ```

- **What it cannot see is code that exists only after macro expansion**: what `use Ecto.Schema` injects, a Phoenix router's routes, the `assert` of `use ExUnit.Case`. A local call in a module that `use`s a foreign module is counted as `local_injected` and never guessed; the [`--trace`](#--trace-file-the-compiler-as-the-second-reader) enrichment recovers those from the compiler itself.

## Streams

stdout carries nothing but `--help` and `--version`. Progress and the **resolution summary** go to stderr. This is the reference corpus:

```text
✓ parse      23 files, 1 unparsed  0.1s
✓ deps       0 modules' exports  0.0s
✓ entities   181 entities  0.0s
✓ whitelist  28 modules  0.0s
✓ edges      174 edges  0.0s
✓ trace      none  0.0s
✓ stubs      29 stubs  0.0s
✓ write      409 records  0.0s
unparsed (skipped): lib/acme_order/legacy/broken.ex: line 4: syntax error before: 'end'
RESOLUTION SUMMARY
  references      : 220
  resolved        : 176 (external: 54) + kernel: 25 (the language, never an edge)
  dropped         : 33 (dynamic_dispatch 5, field_unbound 5, local_injected 14, map_access 8, throw_dynamic 1)
  resolution rate : 91.4%
  imports         : 31 (alias 19, import 4, require 1, use 7; external: 11)
  files           : 23 (.ex 19, .exs 4; unparsed: 1)
  entities        : 210 (stubs: 27 — <otp> 20, <deps> 7)
  edges           : 174 (access 26, import 29, interfaceImplementation 7, invocation 61, reference 47, throws 4); self-edges dropped: 2, dynamic module names dropped: 0
  duplicates      : 0 same-keyed declarations re-keyed, 0 module names declared in more than one file (the first in file order is the import target)
  unclosable      : 0 edges dropped (an endpoint no entity declares)
wrote model.jsonl
```

- **references** are the sites the walker read. **resolved** are the ones that became an edge — to a corpus entity, or to a stub (`external`); a call to the language itself (`length/1`, `+/2`, `case`) is `kernel`, resolved and never an edge.
- **dropped** is everything else, under its reason — each a stated ceiling of the baseline:

  | Reason | What it is |
  |---|---|
  | `local_injected` | a local call in a module that `use`s a foreign module — `field :sku, :string` under `use Ecto.Schema`, `assert` under `use ExUnit.Case`: the name was injected by a macro the parser cannot see. `--trace` recovers these |
  | `local_unbound` | a local call that binds to nothing at all |
  | `ambiguous_import` | two foreign imports could each provide the name |
  | `remote_unbound` | `M.f/n` on a corpus module that declares no `f/n` — injected, or a typo |
  | `otp_unknown` / `deps_unknown` | a call the OTP table, or the `--deps` exports, say does not exist |
  | `dynamic_dispatch` | `apply/3`, `mod.f()` through a variable, a `GenServer.call(pid, …)` |
  | `map_access` | `m.field` on a variable — a runtime map access, not a struct field |
  | `field_unbound` / `field_external` | `%M{k: …}` where M declares no field `k` (Ecto-injected), or M is a stub |
  | `prefix_alias` | an `alias` of a namespace prefix no module declares |
  | `handler_unbound` | a `GenServer.call(M, …)` on a corpus M that defines no handler |
  | `throw_dynamic` | a `reraise` or `raise` of a value whose module the source does not name |

- **imports** by the form written; **entities** with the stubs by reserved module; **edges** by kind, then the self-edges and the dynamic module names dropped at the source.
- **unparsed** names every file the parser rejected: its `file` record is still written, with nothing below it. **duplicates** names every same-keyed declaration re-keyed and every module name declared in more than one file. **unclosable** must be zero: a non-zero count names an id-scheme gap, and the edge was dropped rather than written dangling.

`--explain-dropped` adds one line per drop, in source order, and changes no byte of the model:

```text
dropped dynamic_dispatch: lib/acme_order/dynamic.ex:4 apply(mod, fun, args)
dropped dynamic_dispatch: lib/acme_order/dynamic.ex:6 pricing.price(line, :web)
dropped throw_dynamic: lib/acme_order/errors.ex:16 e
dropped map_access: lib/acme_order/money.ex:13 a.amount()
```

### `--deps <dir>`

```bash
codegraph-elixir --src lib --deps deps --out model.jsonl
```

reads every `deps/*/lib/**/*.ex` for its **exports only**: `import Ecto.Query` then binds `from/2` as a fact, a call into a dependency that exports the function counts as resolved, and one it does not export is dropped as `deps_unknown`. No entity is emitted from `deps/` and keys never change — a dependency stays a stub below `<deps>`.

### `--trace <file>`: the compiler as the second reader

Everything above is read from source, before macro expansion. What a `use`d macro injects — a Phoenix router's routes, an Ecto schema's fields, a `__struct__/1` — exists only after the compiler expands it. When the project compiles, the compiler can be the second reader:

```bash
cd ~/src/some-app
mix codegraph.trace --out codegraph-trace.jsonl        # mix compile --force under a tracer
codegraph-elixir --src . --trace codegraph-trace.jsonl --out model.jsonl
```

`mix codegraph.trace` needs the task on the code path: add `{:codegraph_elixir, "~> 0.2", only: :dev, runtime: false}` to the project's deps, or point the VM at a compiled checkout without touching `mix.exs`:

```bash
ERL_FLAGS="-pa <codegraph>/extractors/elixir/_build/dev/lib/codegraph_elixir/ebin" mix codegraph.trace
```

The trace is JSONL: a header naming the Elixir version and the project root, then one event per resolved call or struct expansion — file, line, the caller, the callee (module, name, arity). The extractor merges it **after** its own pass: an event whose site the baseline already wrote is the same fact (`known`); a new one becomes an edge with provenance **`generated`**, resolved through the same rules (a stub for an external callee); a call to a function the module does not declare in source (`__struct__/1`, an injected `greet/1`) has no entity to land on and is counted as `injected`; a call bound to `Kernel` is `kernel`. Keys never come from the trace, so a model with and without it has the same entities, and every `declared` edge stays exactly as it was. On Phoenix:

```text
  trace           : 16797 events — 5896 generated edges added, 4140 already in the model, 6174 kernel, 36 to injected definitions (no entity), 64 outside the corpus or its declarations, 487 unresolvable
```

## The Elixir profile

The mapping the extractor must respect, rendered from `codegraph profiles --lang ex`. `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`.

| Kind | Required traits | Optional traits |
|---|---|---|
| `attribute` | `TNamed`, `TStructural`, `TChildOf`, `TSourceAnchor` | `TWithValue`, `TWithAccesses`, `TWithInvocations`, `TComment` |
| `callback` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TChildOf`, `TSourceAnchor` | `TComment` |
| `field` | `TNamed`, `TStructural`, `TChildOf`, `TSourceAnchor` | `TWithValue`, `TComment` |
| `file` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` |
| `function` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TWithLocalVariables`, `TComment`, `TMetrics` |
| `macro` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TWithLocalVariables`, `TComment`, `TMetrics` |
| `module` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithImplements`, `TAttachedTo`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` |
| `parameter` | `TStructural`, `TChildOf` | `TNamed`, `TSourceAnchor`, `TWithValue` |
| `protocol` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |

**Edge kinds emitted:** `import` · `interfaceImplementation` · `invocation` · `access` · `reference` · `throws` — no `inheritance`, no `embedding`: Elixir has neither.

| Elixir construct | Kind |
|---|---|
| a source file, `.ex` or `.exs` | `file` — the module *is* the file, keyed by its root-relative path; `mix.exs` and `config/*.exs` call at top level, so a file may carry `TWithInvocations` and `TWithAccesses` |
| `defmodule` | `module` — a type, child of its file; a nested `defmodule Inner` is a second child of the file, `Outer.Inner`, aliased inside `Outer` |
| `defprotocol` | `protocol`; its `def`s are `callback` children |
| `defimpl P, for: T` | `module` named as the compiler names it (`P.T`), `attachedTo` T; an `interfaceImplementation` edge T → P at the block |
| `def`, `defp`, `defdelegate` | `function` — every clause of one name/arity folded into one entity; `defp` carries `private: true` |
| `defmacro`, `defmacrop`, `defguard` | `macro` |
| `@callback`, `@macrocallback`, a protocol's `def` | `callback` — no body, no invocations |
| a `defstruct` or `defexception` key | `field`, its default as a value |
| `@name value`, a non-reserved attribute | `attribute` — the module constant; `@moduledoc`, `@doc`, `@spec`, `@impl` are metadata, never entities |
| a parameter position of the folded function | `parameter`, named from the first clause that names it |

**Arity is identity.** `f/1` and `f/2` are unrelated functions, so a `function`, `macro` or `callback` always carries its arity as the disambiguator (`total#1`); `def f(a, b \\ 1)` declares `f/1` and `f/2` and is one entity, `f#2`, with `defaults: 1`. Key components are **percent-encoded**: `/`, `#` and `%` in every path segment and name, and `.` inside a module atom (`AcmeOrder%2EOrder`), because `.` separates nesting inside a symbol; the entity's `name` is the atom as written.

```
file              ex:lib%2Facme_order%2Forder.ex                       the path relative to the root, escaped
module            ex:lib%2Facme_order%2Forder.ex/AcmeOrder%2EOrder     the atom as written, its dots escaped
function, macro   …/AcmeOrder%2EOrder.total#1                          name, then arity — always present
defimpl module    ex:lib%2Facme_order%2Fmoney.ex/String%2EChars%2EMoney   the compiler's name for it
field, attribute  …/AcmeOrder%2EOrder.lines     …/AcmeOrder%2EOrder.@max_lines
parameter         …/AcmeOrder%2EOrder.create#2#param:opts             an unnamed position: by ordinal
stubs             ex:<otp>/Enum     ex:<otp>/ets     ex:<deps>/Ecto%2EChangeset
```

## Stub discipline

Corpus membership is a **whitelist of the `defmodule`s under the roots**, built in a first pass; never a name-prefix test.

1. A module in the embedded OTP table is a stub below `<otp>`, the BEAM's own: `Enum`, `:ets`, `GenServer`, `Mix.Project`, and the built-in protocol targets (`Any`, `BitString`, `Tuple`…).
2. A module the roots do not declare and the table does not know is a stub below `<deps>` — a dependency, whichever one: with no `deps/` read, the model cannot say which, and says so rather than guessing.
3. **A stub has no members.** A call to `Enum.map/2` is an invocation of the stub module `<otp>/Enum`; a field of an external struct is never an entity.
4. An `alias` of a namespace prefix no module declares is dropped and counted as `prefix_alias`, never stubbed; a local call that binds to nothing is dropped and counted, never stubbed either.
5. **Dynamic dispatch is reported, never guessed.** A call to a corpus protocol function is an `invocation` with provenance `dynamic-candidate` whose candidates are every corpus `defimpl`; `GenServer.call(__MODULE__, msg)` is a `dynamic-candidate` invocation of the module's own `handle_call/3`. Any other first argument, `apply/3`, `mod.f()`, `Module.concat`, `send/2`: dropped and counted.

Edges to stubs are kept; the internal-only view is the analyzer-side filter. `alias`, `import`, `require` and `use` fold to one `import` edge kind, file → file or stub module, so an external import reads as a dependency on `<otp>` or `<deps>`. See [Stubs](/docs/reference/metamodel/stubs/) and [Extracting without compiling](/docs/explanation/extracting-without-compiling/).

## Measures emitted

Carried in the `TMetrics` map, computed with the compiler's own tokenizer. See [Measures and literals](/docs/reference/metamodel/measures-literals/).

| Key | On | Definition |
|---|---|---|
| `sloc` | the file, every module and every invocable | lines of its own span that are neither blank nor comment-only, a comment being what the compiler's parser reports as one: every non-blank line a heredoc, a sigil or a multi-line string spans is code, a `#` inside one included |
| `cyclomatic` | invocables | 1 + clause heads beyond the first + `case`/`cond`/`with`/`receive`/`try` clauses beyond the first + `if`/`unless` + `and`/`or`/`&&`/`\|\|` + `rescue`/`catch` clauses |

A nested `fn` contributes to its enclosing invocable: an anonymous function is not an entity. A module's complexity is the sum over its functions, which the consumer computes with `sum:cyclomatic`.

The [metrics pass](/docs/reference/metrics-pass/) adds cognitive complexity, Halstead, ABC and the rest on top. big-code-analysis opens one space per `def` clause, so a function of several clauses is joined by containment and carries the *charged* keys only (`cognitive`, `nexits`, `abc.*`) — no `lloc`, Halstead or `mi`, which do not add up over clauses. `defprotocol` and `defimpl` bodies, `defguard` and `defdelegate` have no space and carry none of the pass's keys.

## Values and annotations emitted

| Fact | Carried by | Notes |
|---|---|---|
| a `defstruct` key's default | `TWithValue` on the `field` | |
| a `\\` default | `TWithValue` on the `parameter` | `[]`, `"EUR"` |
| `@name value` | `TWithValue` on the `attribute` | a literal as a value; an atom or an expression as `unevaluated` with its text; an array of either. The value's own calls and reads are edges *from* the attribute |
| `@derive P` | an `interfaceImplementation` edge, provenance **`generated`** | the language itself defines the expansion (`Protocol.derive/3`) |
| `@behaviour B`, `defimpl P, for: T` | an `interfaceImplementation` edge, `declared` | |
| `use X` | an `import` edge **and** a `declared` invocation of `X.__using__#1` | what `__using__` injects is absent until `--trace` |
| `@moduledoc`, `@doc`, the `#` block above a definition | `comments` | |

## Profile notes

The documented blind spots, verbatim from the profile.

- The module is the file (the TypeScript rule): `TModule.definedIn` has exactly one entry, and every entity's module is the file it is written in. A `defmodule` is a `module` entity, child of its file, carrying TType — the module IS the type in Elixir (a struct is `%Mod{}`, a behaviour and a protocol are modules, `@spec f :: Mod.t()`). Nesting (`defmodule Inner` inside `defmodule Outer`) defines `Outer.Inner` as a second child of the file and aliases `Inner` inside `Outer`: it is an alias, not a containment.
- Key components are percent-encoded: `/`, `#` and `%` in every path segment and name, and `.` inside a module atom (`Acme%2EOrder`), because `.` is the nesting separator inside a symbol (`Acme%2EOrder.total`). Relying on the rule that alias segments start uppercase while function names do not would make raw dots injective for `defmodule A.B` and fail for `defmodule :"a.b"`, which is legal; the encoding is injective by construction, and the entity's `name` is the atom as written.
- Arity is identity: `f/1` and `f/2` are unrelated functions, so a `function`, `macro` or `callback` always carries its arity as the disambiguator (`total#1`). `def f(a, b \\ 1)` declares `f/1` and `f/2` and is ONE entity, `f#2`, to which a call `f(x)` resolves; every clause of one `f/2` is folded into that entity, anchored from the first clause's line to the last clause's `end`. `signature` is `name/arity`.
- No `inheritance` edge kind and no `embedding`: Elixir has neither class inheritance nor embedding. `interfaceImplementation` is emitted `declared` for `@behaviour B` and for `defimpl P, for: T` (an edge T -> P anchored at the block), and `generated` for `@derive P`, whose expansion the language itself defines (`Protocol.derive/3`).
- `defimpl P, for: T` is a named module on the BEAM (`P.T`, the compiler's own name): it is a `module` entity keyed by that name in the file where the block is written, `attachedTo` T — the containment-versus-attachment split of the Clojure `implBlock`, with the name Elixir gives it. `defimpl` written inside `defmodule T` with no `for:` implements for T.
- Corpus membership is a whitelist of the `defmodule`s under the roots, never a name-prefix test. Every other module is a stub `module` entity below one of two reserved stub modules: `<otp>` for a module the BEAM ships (Elixir's standard library and Erlang/OTP, decided by a module and export table embedded in the extractor at build time from the building toolchain — `Enum` and `:ets` side by side, one VM; the built-in protocol targets `Any`, `BitString`, `Function`, `PID`, `Port`, `Reference`, `Tuple` included), and `<deps>` for a module the roots do not declare and the table does not know (a dependency, whichever one: with no `deps/` read, the model cannot say which). Keys therefore never depend on what is checked out beside the corpus. A stub has no members (the C# fold): a call to `Enum.map/2` is an `invocation` of the stub module `<otp>/Enum`, and a field of an external struct is never an entity. An `alias` of a namespace PREFIX no module declares (`alias Plausible.Stats.SQL` then `SQL.Expression`) is dropped and counted as `prefix_alias`, never stubbed.
- `alias`, `import`, `require` and `use` are one `import` edge kind, file -> the target: another corpus file when the target is declared under the roots, else the stub `module` below `<otp>` or `<deps>`. Folded to the module layer by the analyzer, an external import reads as a dependency on the reserved module — the honest statement that the model does not know which dependency provides it. The four forms are counted separately on stderr; the edge itself does not say which was written. A form written inside a function body applies to that body alone and is still an edge from the file.
- `use X` is defined by the language as `require X` followed by `X.__using__(opts)` at compile time: it yields the `import` edge AND a `declared` invocation of `X.__using__#1`. What `__using__` injects — a `@behaviour`, imports, definitions — does not exist before expansion: it is absent from the baseline and every local call it would have bound is dropped and counted as `local-unbound` on stderr (a Phoenix router's routes, an Ecto schema's fields, a `plug` pipeline). The `--trace` enrichment recovers those as `generated`.
- A local call `f(a, b)` resolves in this order: a `def`/`defp`/`defmacro` of the enclosing module with that name and arity (defaults folded); an explicit `import M` that exports it (a corpus M, the OTP table, or the `--deps` exports), most recent import first; Kernel / Kernel.SpecialForms unless `import Kernel, except:` removed it — and a Kernel binding is the LANGUAGE, resolved but never an edge (`length/1`, `+/2`, the `to_string/1` of a string interpolation), counted as `kernel` on stderr; the SOLE foreign `import M` whose exports are unknown (a stub below `<deps>`, counted) — unless the module `use`s a foreign module whose `__using__` may have injected the name, when nothing honest can be said and the site is dropped as `local_injected`; two or more candidates: `ambiguous_import`; none: `local_unbound`. A remote call `M.f/n` on a corpus M that declares no `f/n` (an injected definition, a typo) is dropped as `remote_unbound`.
- Dynamic dispatch is reported, never guessed. A call to a corpus protocol function `P.f(x)` is an `invocation` with provenance `dynamic-candidate` whose candidates are every corpus `defimpl` of P's `f`; `GenServer.call(Server, msg)` / `GenServer.cast(Server, msg)` with `Server` a statically named corpus module (`__MODULE__` or an alias) is, beside the invocation of `<otp>/GenServer`, a `dynamic-candidate` invocation of that module's clause-folded `handle_call/3` / `handle_cast/2` — the one message-passing form that is statically honest, because the server is named in the source; a server the module does not define a handler for is dropped as `handler_unbound`. Any other first argument (a pid, a registered name, a variable), `apply/3`, `mod.f()` through a variable, `Module.concat`, `Code.eval_*` and `send/2` are dropped and counted as `dynamic-dispatch`.
- Higher-order use (`&M.f/2`, `&f/2`, `&M.f(&1, x)`) yields a `reference` edge to the function, never an `invocation`: the call happens elsewhere. A module atom in argument position (`children = [MyWorker, {Registry, keys: :unique}]`) is a `reference` to the module — how a supervision tree surfaces. `%M{…}` in an expression or a pattern is a `reference` to M (struct expansion) and each named key an `access` to `M.<key>` (`isRead` in a pattern, `isWrite` in a construction or update) — the only static field access Elixir has; `s.name` is a runtime map access, dropped and counted. `@attr` read in a body is an `access` to the `attribute`.
- `raise M`, `raise M, msg` and `reraise M, …` are `throws` edges to M (`RuntimeError` below `<otp>` for `raise "text"`); `throw` and `exit` are not exceptions and yield nothing. `@spec`, `@type`, `@typep` and `@opaque` yield `reference` edges to every named remote type's module; `@type` is not an entity. `@moduledoc` and `@doc` are the entity's `comments`, as is the `#` comment block written directly above a definition.
- A `defdelegate f(a), to: M, as: :g` is a `function` with one `declared` invocation of `M.g#1`: the delegation is written. `defp` and `def` are one kind — the metamodel has no visibility — and `private: true` rides as a pass-through key the container contract tolerates; `defaults: n` says how many lower arities a default-carrying head also declares.
- A module body is compile-time code: `use X`, `plug :x`, `schema "t" do field … end`, an `if Mix.env() == :test do def … end` — its calls and reads are edges FROM the `module` entity (hence the optional `TWithInvocations`/`TWithAccesses` on the kind), the calls injected macros would bind being counted rather than guessed. A module attribute's value owns the edges it writes (the narrowest declared owner): `@table :ets.new(…)` invokes from the `attribute`, `@names [Acme.A, Acme.B]` references from it, `@limit @max * 2` reads from it. A reserved attribute (`@moduledoc`, `@doc`, `@spec`, `@impl`, `@enforce_keys`, …) is metadata, never an entity; a redefined attribute keeps its first definition (accumulating attributes are written many times) and the rest are counted.
- Locals are deferred: `TWithLocalVariables` is licensed on invocables and not emitted in M15. Every match binds, so a local per `=` would multiply entities by ten for no edge the analyzer reads today; the trait stays licensed so adding them needs no profile change.
- Blind spots, stated: definitions a `use`d macro injects and the locals that call them; callback implementations as edges (`handle_call/3` under `@behaviour GenServer` — the analyzer recovers "implements callback" from `interfaceImplementation` plus name/arity, as it does for Java overrides); message passing beyond the `__MODULE__` form; process topology at runtime (`Registry`, `:via` tuples, dynamic supervisors); `.erl` files in a mixed corpus (an Erlang profile is its own phase). A file `Code.string_to_quoted/2` rejects (a syntax error, invalid UTF-8) is skipped and counted as `unparsed`; its `file` record is still written, with no entities.
- The `--trace` enrichment: `mix codegraph.trace` recompiles a project that COMPILES under a compilation tracer and writes every call the compiler resolved after macro expansion (remote, local, imported, macros, struct expansions) with its site and caller; the extractor merges the file after its own pass. An event the baseline already wrote at the same site is the same fact; a new one is an edge with provenance `generated`, resolved through the same rules (an external callee lands on its stub module); a call to a function the module does not declare in source (`__struct__/1`, an injected `greet/1`) has no entity to land on and is counted as `injected`, never invented; a Kernel binding is `kernel`. Keys never come from the trace — a model with and without it has the same entities, and every `declared` edge stays as it was. Phoenix (205 files): 16 797 events, 5 895 generated edges added to 14 314 declared ones.
- Kernel.SpecialForms are variadic (`for`, `try`, `with`, `case` take any number of arguments) and are matched by name alone; `x :: size(8)` inside a binary is a specifier, not a call. A repeated name in one head (`def f(mode, mode)` pins the second) names one position only; the other is keyed by ordinal.
- Audit (M15c, every model `validate`-clean and byte-identical to core's encoder, no `deps/` read): elixir-lang/elixir `lib` (557 files, 27 061 entities / 78 564 edges, 17 s) resolves 80.8 % of 164 123 sites (52 140 Kernel), the rest counted — 30 629 `local_injected` (its own tests' `assert`/`test` under `use ExUnit.Case`, `use MixTest.Case`), 2 659 map accesses, 736 dynamic dispatches, 460 remote calls to injected definitions; phoenixframework/phoenix (205 files, 5 828 / 14 314, 2.3 s) 76.7 % (6 616 injected, 1 900 map accesses); plausible/analytics (1 256 files, 16 369 / 43 661, 5 s) 58.2 % (46 793 injected — `use PlausibleWeb, :controller`, Ecto schemas, ExUnit; 14 401 map accesses). The injected share IS the macro ceiling the trace exists for: on Phoenix, `mix xref graph` (148 file-level compile and runtime edges) is witnessed 147 times by the baseline alone (the miss is a module reached only through `Code.ensure_loaded?`), and the trace adds 5 895 `generated` edges.
- Measures (TMetrics, METAMODEL.md §3.8): `sloc` on the file, every module and every invocable — lines of its own span that are neither blank nor comment-only, a comment being what the compiler's own parser reports as one: every non-blank line a heredoc, a sigil or a multi-line string spans is code, a `#` inside one included; `cyclomatic` on invocables: 1 + clause heads beyond the first + `case`/`cond`/`with`/`receive`/`try` clauses beyond the first + `if`/`unless` + `and`/`or`/`&&`/`||` + `rescue`/`catch` clauses. A nested `fn` contributes to its enclosing invocable: an anonymous function is not an entity.
- The metrics pass (`codegraph-metrics`, PLAN.md §18): big-code-analysis opens one space per `def` clause, so a function of several clauses is joined by containment and carries the charged keys only (cognitive, exits, ABC) — no `lloc`, Halstead or `mi`, which do not add up over clauses. `defprotocol` and `defimpl` bodies, `defguard` and `defdelegate` have no space and carry none of the pass's keys. The join's witness (`sloc` = big-code-analysis's `ploc`) cannot hold over a heredoc: big-code-analysis leaves a heredoc's text lines out of `ploc`, which METAMODEL's `sloc` counts (Phoenix's `mix_app_path`: `sloc` 19, `ploc` 13).

## The reference corpus

`fixtures/elixir/` is a small order-management corpus (23 files, ~260 lines) shaped like a Mix project — `mix.exs`, `config/`, `lib/`, `test/` — and the acceptance corpus for the extractor: the snapshot in `fixtures/elixir/expected/` is produced from that tree, and `./test.sh --elixir` checks that the escript reproduces it byte for byte.

```bash
./bin/codegraph-elixir --src fixtures/elixir/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/elixir/expected/model.jsonl && echo same
```

Run it from the repository root with that relative `--src`: the typed path is the header's `root`, so an absolute one differs from the snapshot in its first line. A file's key is then `lib%2Facme_order%2Forder.ex`, and its `name` the path as written.

**It does not compile, on purpose.** `mix compile` would fail at the first `use Ecto.Schema`: `ecto_sql` and `jason` are declared in `mix.exs` and never fetched — the ordinary legacy case. Every module those dependencies would provide is a stub below `<deps>`; everything the BEAM ships is a stub below `<otp>`. And `lib/acme_order/legacy/broken.ex` does not parse: the extractor skips it, counts it, and still writes its file record.

| File | Pins |
|---|---|
| `mix.exs` | a `.exs` walked like an `.ex`; `use Mix.Project` → an import of `<otp>/Mix.Project` **and** an invocation of its `__using__/1`; `defp deps` carries `private: true` |
| `config/config.exs` | a file with no `defmodule`: `import Config` and the top-level `config/2,3` calls are edges from the **file** |
| `lib/acme_order/order.ex` | arity as identity: `create/2` with a default is one entity `create#2`; two `total/1` clauses are one entity spanning both; `defdelegate` as a function with one invocation; `@max_lines` read from a guard; `%__MODULE__{…}` writing fields; `&Money.add/2` as a `reference`; `raise TooManyLines` as a `throws`; `pricing.price(…)` dropped as `dynamic_dispatch` |
| `lib/acme_order/money.ex` | `defimpl` inside the module → a named module `String.Chars.AcmeOrder.Money`, `attachedTo` `Money`; `@derive Jason.Encoder` → `generated` |
| `lib/acme_order/pricing.ex`, `pricing/standard.ex`, `premium.ex` | a behaviour's `@callback`s as `callback` entities; `@behaviour` → `interfaceImplementation` to the declared module; a call through a pipe |
| `lib/acme_order/priceable.ex` | `defprotocol` → `protocol`; three `defimpl … for:` blocks, one of them `for: Any` → `<otp>/Any` |
| `lib/acme_order/reporting.ex`, `stock.ex` | dynamic dispatch, honestly: a protocol call with the three corpus impls as `candidates`; `GenServer.call(AcmeOrder.Stock, :peek)` → a `dynamic-candidate` invocation of `handle_call#3`; `GenServer.call(pid, …)` dropped |
| `lib/acme_order/repo.ex`, `schema/line.ex` | `use Ecto.Repo`, `use Ecto.Schema`, `import Ecto.Changeset` → stubs below `<deps>`; `field`, `schema`, `cast` dropped as `local_injected` — the ceiling `--deps` and `--trace` lift |
| `lib/acme_order/macros.ex` | `defmacro` and `defguard` → `macro`; a `quote` block's calls are not edges of this module |
| `lib/acme_order/notifier.ex` | nested `defmodule`s as children of the **file**; `import Kernel, except: [length: 1]` → the module's own `length/1`; a function-scoped `alias … as:` |
| `lib/acme_order/errors.ex` | a nested `defexception` with `field`s; `raise "text"` → `<otp>/RuntimeError`; `reraise e, __STACKTRACE__` dropped |
| `lib/acme_order/dynamic.ex` | `apply/3`, `mod.f()`, `GenServer.cast(pid, …)` dropped and counted; `Module.concat` as an invocation of `<otp>/Module` |
| `lib/acme_order/application.ex` | the supervision tree as references: a module atom in argument position is a value |
| `lib/acme_order/legacy/broken.ex` | a syntax error: skipped, counted, the file record still written |
| `lib/acme_order/legacy/atom_module.ex` | `defmodule :"legacy.mod"`: the dot escaped in the key (`legacy%2Emod`), kept in the name |
| `lib/acme_order/two_modules.ex` | two `defmodule`s in one file; an attribute whose value is an array of unevaluated atoms |
| `lib/acme_order/promo#2024.ex` | a `#` in a file name → `promo%232024.ex` in the key; a cross-module struct update reading and writing fields |
| `test/acme_order/order_test.exs` | `use ExUnit.Case` → `<otp>`; a `test` block's calls are invocations from the test module |

## Gotcha

Point `--src` at the **project root**, not at `lib/` alone, when `mix.exs`, `config/` and `test/` matter: the module is the file, so the city draws one building per module in a district per directory, and an umbrella's `apps/*/lib` trees fall out as districts with no extra setup. `_build`, `deps`, `.git`, `node_modules` and `.elixir_ls` are skipped on their own.

| Symptom | Cause | Fix |
|---|---|---|
| a large `local_injected` count on a Phoenix or Ecto application | the names come from macros the parser cannot expand | `mix codegraph.trace` inside the project, then `--trace`; `--deps deps` resolves the imports' exports |
| calls into dependencies land on `<deps>` with no function | a stub has no members, and no `deps/` was read | expected; `--deps deps` changes the counts, never the keys |
| `erl` or `escript` not found | the escript needs Erlang/OTP 27+ on `PATH` | install OTP, or use the released binary, which carries its own |
| `.erl` files contribute nothing | an Erlang profile is its own phase | — |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
