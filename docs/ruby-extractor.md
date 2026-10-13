# Running the Ruby extractor

`codegraph-ruby` reads Ruby sources and writes `model.jsonl`. It is one
binary — Prism, CRuby's own parser, linked in — so it needs **nothing
installed, Ruby least of all**, and it runs nothing: no file is loaded, no
bundle is read, a `Gemfile.lock` that no longer resolves is no obstacle. What
the profile licenses is in `./bin/codegraph profiles --lang rb`; the design is
PLAN.md §19.

> **Status (M18c):** audited on rake, rubygems, Mastodon and rails/rails;
> checked against Packwerk and against a booted VM (§6). The binaries, the
> formula and the app's catalogue row ship with v0.2.0.

## 1. Getting it

```bash
brew install defsquare/tap/codegraph-ruby     # macOS and Linux, arm64 and x64
```

or the release asset `codegraph-ruby-<platform>` (`osx-arm64`, `osx-x64`,
`linux-arm64`, `linux-x64`); there is no Windows build. A binary downloaded
with a browser on macOS is quarantined: `xattr -d com.apple.quarantine
codegraph-ruby-osx-arm64`.

From a clone it needs Rust ≥ 1.94 and **libclang** — to build only: bindgen
reads Prism's C headers once, at compile time.

```bash
./build.sh --ruby                                    # → extractors/ruby/target/release/codegraph-ruby
./bin/codegraph-ruby --src <dir> --out model.jsonl
./test.sh --ruby                                     # cargo test + the release binary reproduces fixtures/ruby
```

A machine with the libclang library and without clang's builtin headers
(Debian's `libclang1-N` alone) fails a bare `cargo build` on `limits.h`;
`build.sh` and `test.sh` lend bindgen GCC's instead. `extractors/ruby/README.md`
says how to do it by hand.

## 2. What it reads, and how it resolves without running anything

Every `*.rb`, `*.rake`, `*.gemspec` and `*.ru` under the roots; the
extensionless files Ruby names (`Rakefile`, `Gemfile`, `Guardfile`, …); and
any other extensionless file whose first line is a `ruby` shebang. `vendor`,
`node_modules`, `tmp` and dot-directories are skipped. A file with syntax
errors is still extracted, from the tree Prism recovered, and named on stderr.

Ruby binds names when the program runs, so the extractor does the part that
is true before it does:

- **The module is the file.** A `class` or a `module` is a type below it, one
  entity per declaring file; a body that only wraps other declarations
  (`module Acme; class Order`) declares nothing; a reopening is `attachedTo`
  the primary declaration.
- **Constants resolve lexically**, as `Module.nesting` would, then through the
  ancestors of the innermost scope. What the corpus does not declare is a
  stub: below `<ruby>` when the VM defines it before any file runs (a table
  distilled from RBS `core/`, embedded), below `<gems>` otherwise — the
  standard library included.
- **A `require` is an import; so is a constant.** A Zeitwerk application
  writes no `require`: the constant reference is the load. A constant that
  resolves to another file is an `import` with provenance `derived`.
- **A call is an edge when its receiver's class is written**: `self`, a
  constant, `Foo.new`, `super` — `declared`. A local or an instance variable
  only ever assigned `Foo.new` — `derived`. A parameter, a block argument, the
  result of a call: dropped and counted, never guessed.
- **What an `included` hook gives is read where it is literal**:
  `base.extend(ClassMethods)`, and ActiveSupport::Concern's `ClassMethods`,
  `class_methods do` and `included do`. A method found that way is `derived`.

## 3. Options and exit codes

```
codegraph-ruby [--src <dir>…] [--out <file>]
  --src <dir>           source root; repeatable (anchors are relative to the common ancestor)
  --out <file>          default: <current-dir>-codegraph.jsonl
  --progress <mode>     auto | plain | none          --no-progress
  --explain-dropped     list every drop on stderr: `dropped <reason>: <file>:<line> <what>`
  --trace <file>        merge what trace/codegraph_trace.rb wrote inside the running program (§5)
  --repo-remote <url> --repo-commit <sha> --repo-root <path> [--repo-provider github|gitlab]
  --version  --help
```

`stdout` carries nothing but `--help`/`--version`; progress and the summary go
to `stderr`. Exit codes: `0` ok, `1` failure, `2` usage, `3` unimplemented.

## 4. Reading the summary

```
syntax errors (recovered, 1): lib/acme_order/legacy/broken.rb
RESOLUTION SUMMARY
  files           : 31 (with syntax errors: 1)
  sites           : 177
  resolved        : 135 (corpus 79, <ruby> 21, <gems> 14, the language 21)
  unresolved      : 42
  resolution rate : 76.3%
  ambiguous-ancestor (dropped): 4
  …
  unbound-dynamic (dropped)   : 3
  unbound-self-call (dropped) : 10
  untyped-receiver (dropped)  : 22
  ancestor-attributed         : 2
  operators, untyped receiver : 8 (not in the rate)
  imports         : 41 (require 12, require_relative 11; unresolved: 5, by load path: 7, derived: 18)
  entities        : 181 (stubs: 24)
  edges           : 153 (self-edges dropped: 1)
```

A **site** is something written that names something: a constant read, a
call, a `super`, a `raise`, a variable. `resolved` are the ones that named
what the corpus declares, what the VM defines, a library — or the language
itself (`puts`, `private`, `"x".upcase`: resolved, and never an edge).
Everything else is dropped under its reason, each a stated ceiling:

| reason | what it is |
|---|---|
| `untyped-receiver` | a call on a parameter, a block argument, the result of a call. Four fifths of what stays unresolved in application code |
| `unbound-self-call` | a call on `self` that nothing declares and no library in the chain could answer: a test framework's DSL (`describe`, `it`, `expect`), `task` in a Rakefile, `gem` in a Gemfile |
| `unbound-method` | the same on a named receiver: `5.minutes`, a method some library adds to a core class |
| `ambiguous-ancestor` | nothing declares it and two libraries could answer — a library superclass and a library mixin; the line names both |
| `unbound-dynamic` | the type defines methods no `def` writes (`method_missing`, a computed `define_method`), on that side: not declaring one proves nothing; the line names the type |
| `namespace-only` / `not-a-type` | a constant path no file gives a body to, or a value used as a type |
| `computed-superclass`, `computed-mixin`, `computed-require`, `computed-define-method`, `dynamic-dispatch` | the name is computed at run time: `< ActiveRecord::Migration[7.0]`, `include helpers_for(x)`, `send(name)` |
| `raise-of-a-value` | `raise error`: the class is not written |
| `def-on-object`, `def-in-opaque-body`, `type-in-singleton`, `computed-type-name` | a declaration no key can carry (`def obj.x`); counted, and kept out of the rate |

`ancestor-attributed` counts, among the resolved, the calls charged to the
one library that could answer (`has_many` in a class whose only library
ancestor is `ActiveRecord::Base`) — an inference by elimination, written
`derived`.

`--explain-dropped` adds one line per drop, in source order, and changes no
byte of the model:

```bash
codegraph-ruby --src . --out model.jsonl --explain-dropped 2>&1 | grep '^dropped'
# dropped untyped-receiver: lib/acme_order/pricing/standard.rb:5 sum
# dropped unbound-dynamic: lib/acme_order/ledger.rb:13 update! (AcmeOrder::Ledger defines methods at run time)
# dropped ambiguous-ancestor: lib/acme_order/record.rb:6 validates (ActiveModel::Validations or ActiveRecord::Base)
```

## 5. `--trace <file>`: the running program as the second reader

Everything above is read from source. What only exists once the program runs
— a mixin applied by a hook the parser cannot follow, the method an untyped
receiver actually reached — can be added when the project still boots. That
means running the project's code, which the extractor never does: the trace is
a separate step, yours, with one Ruby file and no dependency.

```bash
cd ~/src/some-app
# The mixins and the methods the VM holds, once everything is loaded:
ruby -r<codegraph>/extractors/ruby/trace/codegraph_trace -e \
  'require "./config/environment"; Rails.application.eager_load!'
# …and the calls too, by running the tests under it (every call is slowed):
CODEGRAPH_TRACE_CALLS=1 RUBYOPT=-r<codegraph>/extractors/ruby/trace/codegraph_trace bundle exec rake test

codegraph-ruby --src . --trace codegraph-trace.jsonl --out model.jsonl
```

`CODEGRAPH_TRACE_ROOT` is the directory given to `--src` (default: the working
directory), `CODEGRAPH_TRACE_OUT` the file to write. The trace is JSONL: a
header, then `mixin` (type, how, module), `method` (type, name, file, line)
and `call` (the site's file and line, the name, the file and line of the
method entered) records. It names things as Ruby does and carries no key.

The extractor merges it **after** its own pass:

- a mixin the source already writes is the same fact; one it does not is a
  `traitUsage` with provenance **`generated`**, anchored on the declaration of
  the type that has it;
- a call at a site the baseline left unresolved is ONE `invocation` with
  provenance **`dynamic-candidate`**, `candidates` listing every method that
  site was seen to reach — what ran, not what must run;
- a method the VM holds on a line that writes no `def` has no entity and gets
  none.

No entity is added and no edge of the source changes, so a model with and
without a trace has the same keys:

```
  trace mixins    : 52 (45 in the source, 4 added as generated, 3 outside the corpus)
  trace methods   : 1298 (1099 written, 199 defined at run time — no entity, 0 outside the corpus)
  trace calls     : 2829 (1533 in the model, 879 bound to 860 dynamic-candidate edges, 259 unmatched, 158 to a run-time definition, 0 outside the corpus)
```

`unmatched` is a call no line writes under that name (`send`, a DSL);
`to a run-time definition`, a callee defined where no `def` is written.

## 6. What the audit measured

Four corpora, each model `validate`-clean:

| corpus | files | sites | resolved | entities (stubs) | edges | time |
|---|---:|---:|---:|---:|---:|---:|
| rake 13.2.1 | 100 | 9 261 | 77.8 % | 1 865 (94) | 6 696 | 0.1 s |
| rubygems 3.6.2 | 794 | 138 051 | 54.4 % | 15 809 (465) | 71 197 | 1.0 s |
| Mastodon 4.3.0 | 2 541 | 151 603 | 31.2 % | 16 510 (593) | 47 663 | 1.0 s |
| — `app/` and `lib/` alone | 1 108 | 51 548 | 62.1 % | 12 806 (388) | 31 180 | |
| rails 8.0.2 | 3 334 | 383 269 | 57.0 % | 71 681 (1 004) | 212 140 | 4.7 s |
| — every `lib/` and `app/` alone | 1 459 | 84 800 | 59.4 % | 36 275 (667) | 47 918 | |

The rate is over everything written, tests included: 55 000 of Mastodon's
unbound calls are RSpec's DSL, which is why its application code alone reads
at twice the rate of the whole repository.

**Against Packwerk** (3.3.1: its parser, its reference extraction and its
ConstantResolver, over Mastodon's autoload paths). Packwerk resolves 4 335
cross-file constant references in `app/` and `lib/`; the model has the same
constant in the same file for **4 289 of them (98.9 %)**. The 45 others are a
`module Admin` wrapper around a class, which Packwerk counts as a reference
to `Admin` and the wrapper rule does not; one is an inherited constant that
Packwerk places by file name and the model in the superclass that assigns it.
In the other direction the model names 346 references Packwerk cannot — to
declarations under `lib/`, outside the autoload paths — and 147 compact
declarations (`class Admin::Users` reads `Admin`).

**Against a booted VM** (rake, its own tests run in a container under the
trace). Of the 1 012 methods the model declares in the 83 files that were
loaded, the VM holds one on the same line for **1 006**; the six others are
definitions under a platform or capability `if`, a `def` inside a method that
never ran, and methods of anonymous classes. The VM holds 200 methods the
model has none for: 199 written by the metaprogramming loops of three files,
one the `else` branch of a platform test. Of 2 829 calls observed, 1 533 are
edges the baseline wrote — same caller, same callee, same line.

**The stated misreading, measured.** The VM's types come first: a corpus
`class String` is a reopening. A library that itself implements a constant of
the core table is read the same way — rubygems declares 39 bodies of 20 such
types (`Gem` alone 12), and 3 802 of its 71 197 edges land on the VM's stub of
a type that corpus implements. The bodies are `attachedTo` those stubs, so
nothing is lost; the reference names the stub rather than the file.

## 7. Feeding the result to codegraph

```bash
./bin/codegraph validate model.jsonl
./bin/codegraph-metrics model.jsonl --src .        # cognitive complexity, Halstead, ABC … per method
./bin/codegraph analyze model.jsonl --report deps
./bin/codegraph serve model.jsonl
```

The module layer is the **file**: the city draws one building per class or
module in a district per directory, and an import of a library folds to
`<gems>`. A consumer that wants written facts only filters on `declared`;
`derived`, `generated` and `dynamic-candidate` each say what they are.

## 8. Same bytes everywhere

Two runs over one unchanged corpus write the same bytes — with LF or CRLF
sources, whatever order the files were created in, on every platform the
binary is built for. Prism is pinned by exact version and the core table by
RBS release; the header names both. `test.sh --ruby` and the `ruby-native` CI
jobs `cmp` the binary's output against the committed snapshot; run from the
repository root with the relative `--src fixtures/ruby/src`, since the typed
path is the header's `root`.
