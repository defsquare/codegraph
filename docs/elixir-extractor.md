# Running the Elixir extractor

`codegraph-elixir` reads Elixir source and writes a `model.jsonl` — the same
interchange the Java, C# and TypeScript extractors write, validated by the
same contract (`schemas/README.md`). It is the **parser as a library**
(PLAN.md §16): nothing is compiled, no `deps/` is read, and a file the parser
rejects is skipped and counted. This page is about running it; what the
model says is in `packages/core/src/profiles/elixir.ts` (the profile's
`notes`) and the fixture's `fixtures/elixir/README.md`.

> **Status (M15b):** the full model — files, modules, functions with their
> parameters, `defstruct` fields, module attributes, `@callback`s, every edge
> kind of the profile (imports, implementations, invocations through the
> lexical scope, struct-field and attribute accesses, captures and modules as
> values, `raise` sites), dynamic dispatch as candidates, docs as comments,
> `sloc` and `cyclomatic`, `--deps`. The `--trace` enrichment comes with M15c.

## 1. From a clone

The extractor is a Mix project under `extractors/elixir`, built into an
**escript** — one file with Elixir embedded, which needs Erlang/OTP on the
machine that runs it (the jar's JDK):

```bash
./build.sh --elixir                     # mix escript.build → extractors/elixir/dist/codegraph-elixir
./bin/codegraph-elixir --src lib --out model.jsonl
./test.sh --elixir                      # mix test + the escript must reproduce fixtures/elixir/expected/model.jsonl
```

`build.sh` and `test.sh` look for `elixir` on PATH, then in the user-local
install below, then in asdf/mise shims. Requirements: Elixir ≥ 1.18 (its
built-in `JSON` is the only encoder) on Erlang/OTP ≥ 27
(`extractors/elixir/.tool-versions` pins the versions CI builds with).

### Installing a toolchain without sudo

hex.pm publishes precompiled builds of both; unpacking them is enough:

```bash
base=~/.local/share/beam && mkdir -p "$base" && cd "$base"
curl -fsSL -o otp.tar.gz https://builds.hex.pm/builds/otp/ubuntu-24.04/OTP-27.3.4.tar.gz
mkdir otp && tar -xzf otp.tar.gz -C otp --strip-components=1 && (cd otp && ./Install -minimal "$base/otp")
curl -fsSL -o elixir.zip https://builds.hex.pm/builds/elixir/v1.18.4-otp-27.zip
mkdir elixir && (cd elixir && unzip -q ../elixir.zip)
export PATH="$base/otp/bin:$base/elixir/bin:$PATH"
```

(`ubuntu-24.04` is the distro the OTP build was made for; `builds.hex.pm/builds/otp/`
lists the others. On macOS, `brew install elixir`; anywhere, `mise use -g erlang@27 elixir@1.18`.)

## 2. What it reads, and how it resolves without a build

Every `*.ex` and `*.exs` under the `--src` roots (`_build`, `deps`, `.git`,
`node_modules` and `.elixir_ls` skipped), parsed with `Code.string_to_quoted/2`
— the compiler's own parser, positions included. Names resolve through a
**lexical scope** (alias/import/require/use as written, nested-`defmodule`
auto-aliases, `__MODULE__`) and an **OTP module table** the extractor embeds
at build time from the Elixir and Erlang/OTP it was built with (the ct.sym of
the Java image): a module in the table is a stub below `<otp>`, one nothing
declares below `<deps>`, and a module declared under the roots is corpus —
never decided by a name prefix. The header names the versions the table was
made from (`extractor.elixir`, `extractor.otp`).

The one thing it cannot see is code that exists only after macro expansion:
what `use Ecto.Schema` injects, a Phoenix router's routes. Those are counted
on stderr (`local_injected`) and recovered by the `--trace` enrichment
(M15c), never guessed.

## 3. Options and exit codes

Same contract as every extractor (`schemas/README.md §8`):

```
codegraph-elixir [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                 [--repo-remote <url> --repo-commit <sha> --repo-root <path> [--repo-provider <p>]]
                 [--deps <dir>] [--trace <file>] [--version] [--help]
```

- `--src` is repeatable and defaults to the current directory; with several
  roots, anchors are relative to their deepest common ancestor, which becomes
  the header's `root`. `--out` defaults to `<current-dir>-codegraph.jsonl`.
- `--deps <dir>` parses dependency sources for their exports only — counts
  change, keys never do (§4). `--trace <file>` (M15c) merges a compiler trace
  made inside the project; it exits **3** (unimplemented) today.
- `stdout` carries nothing but `--help`/`--version`; progress and the
  summary go to `stderr`. Exit codes: `0` ok, `1` failure, `2` usage, `3`
  unimplemented.

## 4. Reading the summary

```
✓ parse      23 files, 1 unparsed  0.0s
✓ deps       0 modules' exports  0.0s
✓ entities   180 entities  0.0s
✓ whitelist  28 modules  0.0s
✓ edges      174 edges  0.0s
✓ stubs      27 stubs  0.0s
✓ write      386 records  0.0s
unparsed (skipped): lib/acme_order/legacy/broken.ex: line 4: syntax error before: 'end'
RESOLUTION SUMMARY
  references      : 220
  resolved        : 176 (external: 54) + kernel: 25 (the language, never an edge)
  dropped         : 35 (dynamic_dispatch 5, field_unbound 5, local_injected 14, map_access 10, throw_dynamic 1)
  resolution rate : 91.4%
  imports         : 31 (alias 19, import 4, require 1, use 7; external: 11)
  files           : 23 (.ex 19, .exs 4; unparsed: 1)
  entities        : 210 (stubs: 27 — <otp> 20, <deps> 7)
  edges           : 174 (access 26, import 29, interfaceImplementation 7, invocation 61, reference 47, throws 4); self-edges dropped: 2, dynamic module names dropped: 0
  duplicates      : 0 same-keyed declarations re-keyed, 0 module names declared in more than one file
  unclosable      : 0 edges dropped (an endpoint no entity declares)
wrote model.jsonl
```

`references` are the sites the walker read. `resolved` are the ones that
became an edge — to a corpus entity, or to a stub (`external`); a call to
the language itself (`length/1`, `+/2`, `case`) is `kernel`, resolved and
never an edge. Everything else is `dropped` under its reason, each a stated
ceiling of the baseline:

| reason | what it is |
|---|---|
| `local_injected` | a local call in a module that `use`s a foreign module — `field :sku, :string` under `use Ecto.Schema`, `assert` under `use ExUnit.Case`: the name was injected by a macro the parser cannot see. `--trace` (M15c) recovers these |
| `local_unbound` | a local call that binds to nothing at all |
| `ambiguous_import` | two foreign imports could each provide the name |
| `remote_unbound` | `M.f/n` on a corpus module that declares no `f/n` — injected, or a typo |
| `otp_unknown` / `deps_unknown` | a call the OTP table, or the `--deps` exports, say does not exist |
| `dynamic_dispatch` | `apply/3`, `mod.f()` through a variable, a `GenServer.call(pid, …)` |
| `map_access` | `m.field` on a variable — a runtime map access, not a struct field |
| `field_unbound` / `field_external` | `%M{k: …}` where M declares no field `k` (Ecto-injected), or M is a stub |
| `prefix_alias` | an `alias` of a namespace prefix no module declares |
| `handler_unbound` | a `GenServer.call(M, …)` on a corpus M that defines no handler |

`unparsed` names every file the parser rejected; `duplicates` every re-keyed
same-name declaration; `unclosable` must be zero (a non-zero count names an
id-scheme gap, and the edge was dropped rather than written dangling).

### `--deps <dir>`

```bash
./bin/codegraph-elixir --src lib --deps deps --out model.jsonl
```

reads every `deps/*/lib/**/*.ex` for its **exports only**: `import Ecto.Query`
then binds `from/2` as a fact, a call into a dependency that exports the
function counts as resolved, and one it does not export is dropped as
`deps_unknown`. No entity is emitted from `deps/` and keys never change — a
dependency stays a stub below `<deps>`.

## 5. Feeding the result to codegraph

```bash
./bin/codegraph validate model.jsonl
./bin/codegraph analyze model.jsonl --report deps
./bin/codegraph serve model.jsonl
```

The module layer is the **file**; a `defmodule` is a type below it, so the
city draws one building per module in a district per directory, and an
import of an external module folds to `<otp>` or `<deps>`.

## 6. Same bytes everywhere

Two runs over one unchanged corpus write the same bytes — from the escript
and from `mix test`, on Linux, macOS and Windows, with LF or CRLF sources.
`test.sh --elixir` and the `elixir-test` CI job `cmp` the escript's output
against the committed snapshot; run from the repository root with the
relative `--src fixtures/elixir/src`, since the typed path is the header's
`root`.
