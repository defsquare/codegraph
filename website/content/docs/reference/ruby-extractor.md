---
title: Ruby extractor
linkTitle: Ruby extractor
weight: 13
---

`codegraph-ruby` 0.2.0 — the Ruby extractor on Prism, CRuby's own parser. A Cargo package in `extractors/ruby/`, released as one binary with the parser linked in, so it needs **nothing installed, Ruby least of all**, and it runs nothing: no file is loaded, no bundle is read, a `Gemfile.lock` that no longer resolves is no obstacle. **Every `*.rb`, `*.rake`, `*.gemspec` and `*.ru` under the roots is parsed**, with the extensionless files Ruby names (`Rakefile`, `Gemfile`, …) and any file whose first line is a `ruby` shebang; constants resolve lexically against what the corpus declares and an embedded table of what the VM defines; a file with syntax errors is still extracted from the tree Prism recovered. It emits [`model.jsonl`](/docs/reference/model-jsonl/) and nothing else: all trait, profile and validation logic lives in `@codegraph/core`.

```bash
brew install defsquare/tap/codegraph-ruby       # macOS and Linux, arm64 and x64; or the release's codegraph-ruby-<platform>
codegraph-ruby --src <dir> --out model.jsonl

# from a clone — Rust 1.94+ and libclang to build, nothing to run
./build.sh --ruby                                # cargo build --release → extractors/ruby/target/release/codegraph-ruby
./bin/codegraph-ruby --src <dir> --out model.jsonl
```

There is no Windows build. A binary a browser downloaded is quarantined on macOS: `xattr -d com.apple.quarantine codegraph-ruby-osx-arm64` once (Homebrew fetches with `curl`, which sets none). Building needs libclang because bindgen reads Prism's C headers at compile time, and nothing else: a machine with the library alone and without clang's builtin headers fails a bare `cargo build` on `limits.h`, so `build.sh` and `test.sh` lend bindgen GCC's instead (`extractors/ruby/README.md` says how by hand). Installing any extractor from the tap also installs the [metrics pass](/docs/reference/metrics-pass/).

## Synopsis

```
codegraph-ruby [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
               [--explain-dropped] [--trace <file>]
               [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
               [--version] [--help]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src <dir>` | source root; repeatable. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's `root`. `vendor`, `node_modules`, `tmp` and dot-directories are skipped; a root named on the command line is walked whatever it is called | the current directory |
| `--out <file>` | where to write the model | `<current-dir>-codegraph.jsonl` |
| `--progress <m>` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` | `auto` |
| `--no-progress` | same as `--progress none` | — |
| `--explain-dropped` | list every drop on stderr, in source order, as `dropped <reason>: <file>:<line> <what>`; the model is unchanged | — |
| `--trace <file>` | merge what `trace/codegraph_trace.rb` wrote inside the running program: the mixins no line writes become `generated` edges, the calls it saw at sites left untyped `dynamic-candidate` ones. No entity is added and no edge of the source changes | — |
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

## How it resolves without running anything

Ruby binds names when the program runs, so the extractor does the part that is true before it does.

- **The module is the file.** A `class` or a `module` is a type below it, one entity per declaring file; a body that only wraps other declarations (`module Acme; class Order`) declares nothing; a reopening in another file is `attachedTo` the primary declaration — the one that writes a superclass, else the first in canonical file order.
- **Constants resolve lexically**, as `Module.nesting` would, then through the ancestors of the innermost scope, then at the top level. What the corpus does not declare is a stub: below `<ruby>` when the VM defines it before any file runs — a table distilled from RBS `core/` at a pinned version, embedded; the header names it — and below `<gems>` otherwise, the standard library included:

  ```json
  {"name":"codegraph-ruby","version":"0.2.0","prism":"1.9.0","rbs":"4.2.0"}
  ```

- **A `require` is an import; so is a constant.** A Zeitwerk application writes no `require`: the constant reference is the load. A constant that resolves to another file is an `import` with provenance `derived`, one per (file, target file).
- **A call is an edge when its receiver's class is written**: `self`, a constant, `Foo.new`, `super` — `declared`. A local or an instance variable only ever assigned `Foo.new` — `derived`. A parameter, a block argument, the result of a call: dropped and counted, never guessed.
- **What an `included` hook gives is read where it is literal**: `base.extend(ClassMethods)`, and ActiveSupport::Concern's `ClassMethods`, `class_methods do` and `included do`. A method found that way is `derived`; so is a call charged by elimination to the one library that could answer it (`has_many` in a class whose only library ancestor is `ActiveRecord::Base`).
- **The language is never an edge.** What every object answers (`puts`, `freeze`), what every class answers on the class side (`new`, `attr_accessor`, `private`), and a method of a literal (`"x".upcase`) are resolved, counted, and produce nothing: an arrow from every method to `<ruby>/Kernel` would say nothing.

## Streams

stdout carries nothing but `--help` and `--version`. Progress and the **resolution summary** go to stderr. This is the reference corpus:

```text
✓ walk        31 files  0.0s
✓ parse       31 files, 1 with syntax errors  0.0s
✓ whitelist   32 declarations  0.0s
✓ entities    157 entities  0.0s
✓ edges       153 edges  0.0s
✓ stubs       24 stubs  0.0s
✓ write       367 records  0.0s
syntax errors (recovered, 1): lib/acme_order/legacy/broken.rb
RESOLUTION SUMMARY
  files           : 31 (with syntax errors: 1)
  sites           : 177
  resolved        : 135 (corpus 79, <ruby> 21, <gems> 14, the language 21)
  unresolved      : 42
  resolution rate : 76.3%
  ambiguous-ancestor (dropped): 4
  computed-define-method (dropped): 2
  computed-mixin (dropped)    : 1
  computed-require (dropped)  : 1
  def-in-opaque-body (dropped): 1
  def-on-object (dropped)     : 1
  dynamic-dispatch (dropped)  : 1
  not-a-type (dropped)        : 1
  unbound-dynamic (dropped)   : 3
  unbound-self-call (dropped) : 10
  untyped-receiver (dropped)  : 22
  ancestor-attributed         : 2
  operators, untyped receiver : 8 (not in the rate)
  imports         : 41 (require 12, require_relative 11; unresolved: 5, by load path: 7, derived: 18)
  entities        : 181 (stubs: 24)
  edges           : 153 (self-edges dropped: 1)
wrote model.jsonl
```

- A **site** is something written that names something: a constant read, a call, a `super`, a `raise`, a variable. **resolved** are the ones that named what the corpus declares, what the VM defines, a library — or the language itself (resolved, and never an edge). Everything else is dropped under its reason, each a stated ceiling:

  | Reason | What it is |
  |---|---|
  | `untyped-receiver` | a call on a parameter, a block argument, the result of a call. Four fifths of what stays unresolved in application code |
  | `unbound-self-call` | a call on `self` that nothing declares and no library in the chain could answer: a test framework's DSL (`describe`, `it`, `expect`), `task` in a Rakefile, `gem` in a Gemfile |
  | `unbound-method` | the same on a named receiver: `5.minutes`, a method some library adds to a core class |
  | `ambiguous-ancestor` | nothing declares it and two libraries could answer — a library superclass and a library mixin; the line names both |
  | `unbound-dynamic` | the type defines methods no `def` writes (`method_missing`, a computed `define_method`) on that side: not declaring one proves nothing; the line names the type |
  | `namespace-only` / `not-a-type` | a constant path no file gives a body to, or a value used as a type |
  | `computed-superclass`, `computed-mixin`, `computed-require`, `computed-define-method`, `dynamic-dispatch` | the name is computed at run time: `< ActiveRecord::Migration[7.0]`, `include helpers_for(x)`, `send(name)` |
  | `raise-of-a-value` | `raise error`: the class is not written |
  | `def-on-object`, `def-in-opaque-body`, `type-in-singleton`, `computed-type-name` | a declaration no key can carry (`def obj.x`); counted, and kept out of the rate |

- **ancestor-attributed** counts, among the resolved, the calls charged to the one library that could answer — an inference by elimination, written `derived`. **operators, untyped receiver** (`a + b`, `x[0]`) are counted apart and stay out of the rate: they are the language far more often than not.
- **imports** by form, with those a load root answered (`require "acme/order"` through a `lib`, `spec` or `test` directory — a fact about the layout, counted on its own) and those `derived` from constant references.
- **syntax errors (recovered)** names every file Prism had to recover: its classes and methods are still extracted from the tree it rebuilt.

`--explain-dropped` adds one line per drop, in source order, with what decided it where something did, and changes no byte of the model:

```text
dropped unbound-self-call: Gemfile:3 gemspec
dropped unbound-self-call: Rakefile:5 task
dropped untyped-receiver: acme_order.gemspec:4 name=
dropped unbound-dynamic: lib/acme_order/ledger.rb:13 update! (AcmeOrder::Ledger defines methods at run time)
dropped ambiguous-ancestor: lib/acme_order/record.rb:6 validates (ActiveModel::Validations or ActiveRecord::Base)
```

### `--trace <file>`: the running program as the second reader

Everything above is read from source. What only exists once the program runs — a mixin applied by a hook the parser cannot follow, the method an untyped receiver actually reached — can be added when the project still boots. That means running the project's code, which the extractor never does: the trace is a separate step, yours, with one Ruby file and no dependency.

```bash
cd ~/src/some-app
# the mixins and the methods the VM holds, once everything is loaded:
ruby -r<codegraph>/extractors/ruby/trace/codegraph_trace -e \
  'require "./config/environment"; Rails.application.eager_load!'
# …and the calls too, by running the tests under it (every call is slowed):
CODEGRAPH_TRACE_CALLS=1 RUBYOPT=-r<codegraph>/extractors/ruby/trace/codegraph_trace bundle exec rake test

codegraph-ruby --src . --trace codegraph-trace.jsonl --out model.jsonl
```

`CODEGRAPH_TRACE_ROOT` is the directory given to `--src` (default: the working directory), `CODEGRAPH_TRACE_OUT` the file to write. The trace is JSONL: a header, then `mixin`, `method` and `call` records naming things as Ruby does — constants, files, lines — and never a key. The extractor merges it **after** its own pass:

- a mixin the source already writes is the same fact; one it does not is a `traitUsage` with provenance **`generated`**, anchored on the declaration of the type that has it;
- a call at a site the baseline left unresolved is ONE `invocation` with provenance **`dynamic-candidate`**, `candidates` listing every method that site was seen to reach — what ran, not what must run;
- a method the VM holds on a line that writes no `def` has no entity and gets none: it is counted.

No entity is added and no edge of the source changes, so a model with and without a trace has the same keys. On rake, under its own tests:

```text
  trace mixins    : 52 (45 in the source, 4 added as generated, 3 outside the corpus)
  trace methods   : 1298 (1099 written, 199 defined at run time — no entity, 0 outside the corpus)
  trace calls     : 2829 (1533 in the model, 879 bound to 860 dynamic-candidate edges, 259 unmatched, 158 to a run-time definition, 0 outside the corpus)
```

## The Ruby profile

The mapping the extractor must respect, rendered from `codegraph profiles --lang rb`. `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`.

| Kind | Required traits | Optional traits |
|---|---|---|
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TAttachedTo`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` |
| `constant` | `TNamed`, `TStructural`, `TChildOf`, `TSourceAnchor` | `TWithValue`, `TComment`, `TWithInvocations`, `TWithAccesses` |
| `field` | `TNamed`, `TStructural`, `TChildOf`, `TSourceAnchor` | `TWithValue`, `TComment` |
| `file` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` |
| `method` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithInvocations`, `TWithAccesses`, `TChildOf`, `TSourceAnchor` | `TWithLocalVariables`, `TComment`, `TMetrics` |
| `module` | `TNamed`, `TType`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TAttachedTo`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` |
| `parameter` | `TStructural`, `TChildOf` | `TNamed`, `TSourceAnchor`, `TWithValue` |

**Edge kinds emitted:** `import` · `inheritance` · `traitUsage` · `invocation` · `access` · `reference` · `throws` — no `interfaceImplementation`: Ruby has no interface to declare conformance to. `include`, `extend` and `prepend` are the `traitUsage` kind PHP introduced; the edge does not say which of the three was written.

| Ruby construct | Kind |
|---|---|
| a source file; a Rakefile, a gemspec, `config.ru` | `file` — the module *is* the file, keyed by its root-relative path; top-level code is the file's, so it may carry `TWithInvocations` and `TWithAccesses`. The reserved stub modules and every external feature are this kind |
| `class Foo [< Bar]`, `Foo = Struct.new(…) do … end`, `Foo = Class.new(Bar)` | `class`, keyed by its full constant path; a reopening in another file carries `TAttachedTo` |
| `module Foo`, `Foo = Module.new`, a concern's `class_methods do … end` | `module` |
| `def`, `def self.x`, a `def` inside `class << self`, `define_method(:x)` with a literal name | `method`; a singleton method carries the `self` disambiguator |
| an instance variable, the `attr_*` that exposes it, a `Struct` or `Data` member | `field` — one entity named `@x`, read and written by `access`; the accessor is not an entity |
| `NAME = value` for a value that is not a type | `constant`, keyed by its full constant path, with its literal value |
| a parameter | `parameter`; `*`, `**`, `&`, `...` and a destructured position have no name |

**No arity, `self` as the singleton mark.** Ruby has no overloading, so a method's key carries no parameter list; `def self.call` and `def call` coexist and the singleton one is `call#self`. Key components are **percent-encoded**: `/`, `#` and `%` in every path segment and name (`def /(other)` is keyed `Money.%2F`), and `<` in a path segment, so no walked path can spell a reserved module. `::` is part of a type's name, never a separator of the key.

```
file              rb:lib%2Facme%2Forder.rb                    the path relative to the root, escaped
reserved          rb:<ruby>   rb:<gems>                        what the VM defines / what nothing here declares
external feature  rb:<gems>%2Fnokogiri   rb:<gems>%2Fnet%2Fhttp     a `require` no corpus file answers, as written
class, module     rb:lib%2Facme%2Forder.rb/Acme::Order         the fully qualified constant path
stub type         rb:<ruby>/StandardError     rb:<gems>/ActiveRecord::Base
method            …/Acme::Order.total         singleton: …/Acme::Order.call#self
operator          …/Acme::Money.%2F     …/Acme::Money.%25     …/Acme::Money.<=>
parameter         …/Acme::Order.total#param:currency           unnamed or repeated: #param:<1-based ordinal>
field             …/Acme::Order.@total       the class's own: …/Acme::Order.@registry#self
constant          rb:lib%2Facme%2Forder.rb/Acme::Order::MAX_LINES
```

## Stub discipline

Corpus membership is a **whitelist of the constant paths the roots declare or assign**, and every prefix of one (`A::B::C` cannot exist without `A::B`), computed to a fixed point so a compact `class A::B` in a later file still counts; never a name-prefix test.

1. A constant the VM defines before any file runs — the core table — is a stub below `<ruby>`, **even when the corpus reopens it**: a corpus `class String` is a declared entity `attachedTo` `<ruby>/String`, a method it adds is found, and every reference to `String` still names the VM's, so the patch file never becomes the hub every string points at.
2. `<ruby>` is deliberately core only. The standard library is `<gems>`: nearly all of it is default or bundled gems, the set moves with every Ruby release, and a model's keys must not.
3. Anything else the corpus does not declare is a stub below `<gems>`: a `class` when a site inherits from it, instantiates it or raises it, a `module` otherwise. That kind is the evidence one corpus holds, so two corpora can disagree on a stub and `validate` on their union says so.
4. A constant path the corpus knows and gives no body — a namespace, an assigned constant — is dropped and counted (`namespace-only`, `not-a-type`), never stubbed: resolvability is not membership, and neither is its absence. The one exception is a namespace the corpus itself proves has a body elsewhere — sent a message no bare module answers (`Rails.env` beside a `class Rails::Patch`), or inherited from while nothing opens it — which is a library's, below `<gems>`.
5. **A stub has no members.** A call on a library's type lands on the stub. A receiver the source does not type is dropped and counted, never guessed: candidate generation is the analyzer's.

The one corpus this misreads is a library that itself implements a constant of the core table — rubygems' own `Gem` — whose references land on the VM's stub; its bodies are `attachedTo` that stub, so nothing is lost. Edges to stubs are kept; the internal-only view is the analyzer-side filter. See [Stubs](/docs/reference/metamodel/stubs/) and [Extracting without compiling](/docs/explanation/extracting-without-compiling/).

## Measures emitted

Carried in the `TMetrics` map. See [Measures and literals](/docs/reference/metamodel/measures-literals/).

| Key | On | Definition |
|---|---|---|
| `sloc` | the file, every type and every method | lines of its own span that are neither blank nor comment-only, a heredoc's text being code and what follows `__END__` data |
| `cyclomatic` | methods | 1 + `if`/`elsif`/`unless`/ternary + `while`/`until`/`for` + each `when`/`in` + each `rescue` clause and modifier + `&&`/`\|\|`/`and`/`or` |

A block contributes to its enclosing method: it is not an entity. A type's complexity is the sum over its methods, which the consumer computes with `sum:cyclomatic`.

The [metrics pass](/docs/reference/metrics-pass/) adds cognitive complexity, Halstead, ABC and the rest. big-code-analysis's Ruby grammar opens a space per `class`, `module` and `def`, so every file, type and method joins exactly and the join's witness holds — `sloc` equals its `ploc` on each, 106 of 106 on the reference corpus. A type declared by assignment (`Point = Struct.new(…) do … end`, `Handler = Class.new(Base) do … end`) and a concern's `class_methods do … end` are blocks to the grammar: no class space of their own, and none of the pass's keys.

## Values and comments emitted

| Fact | Carried by | Notes |
|---|---|---|
| `NAME = value` | `TWithValue` on the `constant` | a string, a number, `true`/`false`/`nil`, an array of those, a frozen literal (`"EUR".freeze` is seen through); a symbol, a hash, a range, a regexp or an expression as `unevaluated` with its text; a constant naming a type as a `type` literal |
| a parameter default | `TWithValue` on the `parameter` | the same forms; a default that calls carries nothing |
| `class A < Struct.new(:x)`, `Data.define` | an `inheritance` edge to `<ruby>/Struct` or `<ruby>/Data`, provenance **`generated`** | the source writes no `< Struct`; the language defines it. The superclass given to `Class.new(Base)` is written, hence `declared` |
| a call charged to the one library that could answer, a method reached through an `included` hook, a call on a receiver typed by its assignment | the edge, provenance **`derived`** | a consumer that wants written facts only filters on `declared` |
| the `#` block directly above a class, module, method or constant | `comments` | magic comments and `# rubocop:` directives looked through |

## Profile notes

The documented blind spots, verbatim from the profile.

- The module is the file (the TypeScript and Elixir rule): `TModule.definedIn` has exactly one entry, and every entity's module is the file it is written in. `class` and `module` are types below it, named and keyed by their fully qualified constant path (`Acme::Order`) — `::` is part of the name, never a separator of the key. A type written inside the body of a type that is an entity in the same file is its child; otherwise it is a child of the file. A value constant is keyed the same way (`Acme::Order::MAX_LINES`), a child of the type whose body assigns it.
- Ruby classes are open, so a class or a module is ONE ENTITY PER DECLARING FILE (the TypeScript declaration-merging rule): every body of `Acme::Order` in one file folds into one entity anchored at the first, and a second file reopening it declares a second entity with the same name. A reference to the constant targets the PRIMARY declaration, chosen deterministically — the one that writes a superclass, else the first in canonical file order — and every other declaration is `attachedTo` it: containment says where a body is written, attachment which type it belongs to. A method is looked up across every body, and lands on the one in the calling file when there is one.
- A monkey patch is a reopening by construction: the VM defined `String` before any file ran, so a corpus `class String` cannot be its definition. It is a declared entity in its file, `attachedTo` the stub `<ruby>/String`, and a reference to `String` anywhere still names the VM's — the patch file does not become the hub every string in the corpus points at. A method the patch adds IS found, before the VM's own (`"".blank?` lands on the corpus `String.blank?`). The one corpus this misreads is a library that itself implements a constant of the core table (rubygems' own `Gem`): its references land on the stub. A library's class the corpus reopens (`class ActiveRecord::Base`) has no such table to consult and IS the declaration the corpus knows.
- A wrapper body is not a declaration: `module Acme; class Order; end; end` and `class Acme::Order; end` are two spellings of one thing, and both yield `Acme::Order` alone. A `module` or `class` body with no superclass whose statements are all class or module declarations — `Point = Struct.new(…)` being one — declares nothing of its own in that file: it is lexical scope, Ruby's spelling of a package statement, so a namespace reopened in fifty files is not fifty entities. An empty body (`class NotFound < StandardError; end`, `module Marker; end`) IS a declaration. A constant path no file gives a body to has no entity, and a reference to it is dropped and counted (`namespace-only`) — UNLESS the corpus itself proves the body exists elsewhere: a message is sent to it that no bare module answers (`Rails.env`, where the corpus only writes `class Rails::Patch`), or a class inherits from a path nothing in the corpus opens. That namespace is a library's, a stub below `<gems>`; what the corpus declares under it stays the corpus's.
- `Point = Struct.new(:x, :y) do … end`, `Coord = Data.define(:lat)`, `Handler = Class.new(Base)` and `Mixin = Module.new` are types named by the constant, the block their body: its `def`s are their methods. `Struct.new` and `Data.define` — as a superclass too, `class Money < Struct.new(:cents)` — yield an `inheritance` edge to `<ruby>/Struct` / `<ruby>/Data` with provenance `generated`: the source writes no `< Struct`, the language defines it. The superclass given to `Class.new` is written, hence `declared`. Each member is a `field`.
- Key components are percent-encoded: `/`, `#` and `%` in every path segment and name (`def /(other)` is a method named `/`, keyed `Money.%2F`), and `<` in a path segment, so that no walked path can spell a reserved module. Ruby has no overloading — a name is one method per type — so a method carries no arity; `def self.call` and `def call` coexist in one class, and the singleton method alone carries the disambiguator `self`, the keyword the source writes. A method written twice in one file is one entity, anchored at the first. A parameter is keyed `#param:<name>` below its method, by 1-based ordinal when it has no name or repeats one.
- `signature` is the method as it would be called: `total(currency, [precision], *rest, tax:, [rounding:], **opts, &blk)` — brackets mark a parameter with a default, whose value is not part of the signature; a singleton method is prefixed `self.`. The default itself rides as the parameter's `value` when it is a constant expression: a string, a number, `true`/`false`/`nil`, an array of those, a frozen literal (`"EUR".freeze`); a symbol, a hash, a range and a regexp as `unevaluated` with the text written; a constant naming a type as a `type` literal. A default or an initializer that calls carries no value at all.
- A `field` is an instance variable, and the `attr_reader` / `attr_writer` / `attr_accessor` that exposes it is the SAME entity, named `@total` and anchored at the `attr_*` when there is one, else where the variable is first written. `@total` in a body and a call of the accessor (`total`, `self.total = x`, `order.total` on a typed receiver) are `access` edges — the C# property rule: the accessor is not an entity. An instance variable belongs to the object, so a subclass reading `@total` reads the field of the root-most corpus ancestor that has it. `@x` in a class body or a singleton method is the class's own variable and carries the `self` disambiguator; `@@x` is a field of the type. A Struct member is a field named like the variable it stands for (`@cents`).
- Corpus membership is a whitelist of the constant paths the roots declare or assign, never a name-prefix test. Every other type is a stub below one of two reserved modules: `<ruby>` for a constant the VM defines before any file runs (the core classes and modules, from a table distilled from RBS `core/` at a pinned version and embedded in the extractor — the header names that version), and `<gems>` for a constant the roots do not declare and the VM does not define: a library, whichever one. The standard library is in `<gems>` on purpose — nearly all of it is default or bundled gems, the set moves with every Ruby release, and a model's keys must not. A `<gems>` stub is a `class` when a site inherits from it, instantiates it or raises it, and a `module` otherwise — every class is one; it may also be a value constant of that library, which nothing here can tell. That kind is the evidence ONE corpus holds, so two corpora can disagree on a stub (`Logger` instantiated here, only named there): validating their union reports it as a duplicate-id conflict. A stub has no members: a call on a library's type lands on the stub.
- `require`, `require_relative`, `load` and `autoload` with a literal argument are `import` edges from the file, wherever they are written. `require_relative` names a path: the file it resolves to, or a stub module keyed by that path when nothing is there; the Ruby 1.8 spellings fold to it (`File.expand_path("../x", __FILE__)`, `File.join(File.dirname(__FILE__), "x")`, `"#{__dir__}/x"`). `require "acme/order"` is searched on the load roots the layout implies — every directory named `lib`, `spec` or `test`, then the root — nearest to the requiring file first, and that resolution is a fact about the repository rather than the language, counted on its own. A feature no corpus file answers is a stub module keyed by the feature as written below `<gems>` (`<gems>%2Fnokogiri`, `<gems>%2Fnet%2Fhttp`). Any other computed argument is dropped and counted.
- A Zeitwerk application writes no `require`: the constant reference IS the import, turned into a load at run time. So a constant that resolves to a declaration in another file — a type or a value, in a header or in a body — yields ONE `import` edge per (file, target file), provenance `derived`, anchored at the first such reference, and none when the file already imports that file explicitly. Without it the import layer, the one layer comparable across languages, is empty for every Rails application; with it, a consumer that needs written facts only filters on `declared`.
- A constant is resolved as Ruby resolves it: each enclosing scope from the innermost out (`Module.nesting` — a compact `class A::B` opens ONE scope, `A::B`, and does not see `A`), then the ancestors of the innermost scope (a constant of the superclass or of an included module), then the top level; `::X` is absolute; `A::B` resolves `A` that way, then `B` in `A` and in what `A` inherits from (`Child::LIMIT` is `Base::LIMIT` when Base assigns it) — never at the top level. A compact declaration READS what it is written under: `class Admin::Users` is a `reference` from `Admin::Users` to `Admin` where `Admin` is a type, since the name must exist for the class to open; a wrapper (`module Admin; class Users`) creates what it opens and reads nothing. The header of a declaration (`< Base`, `include M`) is read by the lexical scopes alone. A constant read is a `reference` to the type it names, or an `access` to the value constant it names; `A::B::C` is one read, not three. A read of a VM value (`ARGV`, `ENV`) is the language: resolved, counted, no edge.
- `class A < B` is an `inheritance` edge when `B` is a constant; `< Class.new(Base)`, `< ActiveRecord::Migration[7.0]` and every other computed superclass is dropped and counted — the constants it names are still referenced, from the class. `include M`, `extend M` and `prepend M` written in a type's body (or `include M` inside its `class << self`) are `traitUsage` edges from the type, one per argument, and the edge does not say which of the three was written; `extend self` is not a relation. What an `included` hook gives whatever includes the module is read where the idiom is literal: `base.extend(M)`, `base.include(M)` and their `send` spellings in `def self.included(base)`; and, in a module that writes `extend ActiveSupport::Concern`, its `ClassMethods` module, `class_methods do … end` — the BODY of that module, an entity anchored on the block — and the mixins written directly in `included do … end`. No `traitUsage` is written for it, since the includer writes none: the lookup goes through the hook, and what it finds there is an inference (below). A mixin applied any other way — a computed argument, a hook that calls a helper — is invisible to the parser; `--trace` adds it.
- A call is an `invocation` when what it is sent to has a type the source states, looked up as Ruby would: prepended modules, the type, its mixins last-included first, its superclass's — and on the class side its singleton methods, what it extends, its superclass's. `declared`: an implicit or explicit `self`, `self.class.x`, `Foo.x` on a constant, `Foo.new(…).x`, `super`, and `new(…).x` where `self` is the class. `Foo.new` — and a bare `new` in a class method — is an invocation of `initialize`. `module_function` and `extend self` make an instance method answer on the module; an `alias_method` or `alias` answers with the method it names; `send(:x)` with a literal name is a call like any other, and `method(:x)` a `reference` to the method. A top-level `def` is a method of every object. A block is assumed to keep `self`, as `each` and `map` do: an `instance_eval`-style DSL block is not detected.
- `derived` says the receiver's type was inferred: a local every assignment of which in its body is `Foo.new(…)` (flow-insensitively — one other assignment anywhere untypes it, and a parameter types nothing), and an instance variable every assignment of which in the type is `Foo.new(…)`, the `@repo ||= Repo.new` idiom included. An accessor on such a receiver is a `derived` `access`. `derived` also says the METHOD was reached through an `included` hook: `audited :total` in a class that includes a concern whose `class_methods` define `audited` — the receiver is written, the link from the class to that module is not.
- What every object answers (`puts`, `raise`, `freeze` — Object, Kernel, BasicObject), what every class answers in a class-side call (`new`, `attr_accessor`, `private`, `include` — Class, Module), and any method of a literal (`"x".upcase`, `[1].map`) are the LANGUAGE: resolved, counted, and never an edge. A method the corpus inherits from a core class it names is a dependency on it — `upcase` in a subclass of String is an `invocation` of `<ruby>/String`, `between?` of `<ruby>/Comparable` — and a call on a core class is an invocation of that class as written (`File.read` lands on `<ruby>/File`, though `read` is IO's; so does `Time.zone`, which some library added).
- A call nothing the corpus or the VM defines answers, in a type with exactly ONE library that could answer, is an `invocation` of that library's stub with provenance `derived` — an inference by elimination, where `has_many` and `where` land in an ActiveRecord model. A library that could answer is a library superclass, a library module mixed in — and, on the class side, a library module merely INCLUDED, whose hook may have extended the class: `validates` in a model that includes ActiveModel::Validations is that module's, not ActiveRecord::Base's. Two of them is dropped and counted as `ambiguous-ancestor`; none, as `unbound-self-call` (`unbound-method` on a named receiver). A type that defines methods no `def` writes proves nothing by not declaring one — on the side they are defined for: `def method_missing` and a `define_method` with a computed name in a class body cloud its INSTANCES, `def self.method_missing` and `define_singleton_method` the class itself; a miss on that side is `unbound-dynamic`.
- A receiver no parser can type — a parameter, a block argument, the result of a call — is the stated ceiling: dropped and counted as `untyped-receiver`, never guessed, candidate generation being the analyzer's. An operator on such a receiver (`a + b`, `x[0]`, `!done`) is counted apart and kept out of the resolution rate: it is the language far more often than not. `--explain-dropped` lists every dropped site with its reason, file and line, and what decided it where something did: the type that defines methods at run time for an `unbound-dynamic`, the libraries that could answer for an `ambiguous-ancestor`.
- `raise Foo`, `raise Foo, "msg"` and `raise Foo.new(…)` are `throws` edges to Foo, beside the `reference` the constant read also is; `raise "text"` throws `<ruby>/RuntimeError`. `raise error` re-raises a value whose class the source does not say: dropped and counted.
- A `def` belongs to the type whose body it is written in — a `def` inside a block (`included do … end`) too, since a block does not change where a constant or a method is written, a concern's `class_methods do … end` alone excepted (it is the body of `ClassMethods`); at a file's top level it is a child of the file. `def self.x` and a `def` inside `class << self` are singleton methods of the enclosing type. `define_method(:x) { … }` with a literal name is a method like a `def`, its block the body. `def obj.x`, a `def` inside `class << obj`, and a type whose name is computed (`class self::Foo`) or written inside a singleton class have no key to carry them: dropped and counted, their constants still read, their calls not.
- An edge comes from the narrowest entity that encloses its site: a method, else the constant whose initializer it is in, else the class or module body, else the file. A class body is code (`has_many :lines`, `attr_reader`), a file's top level too (a Rakefile, a gemspec) — hence the optional `TWithInvocations` / `TWithAccesses` on those kinds, declared when the entity is the source of such an edge. A call is anchored at the line its name is written on, not across the block it is given.
- Blind spots, stated: methods no `def` writes (`define_method` with a computed name, `method_missing`, a `class_eval` of a string in a loop, the accessors `delegate`, `def_delegators` and ActiveRecord generate); mixins applied at run time other than through a literal `included` hook; a test framework's DSL (`describe`, `it`, `expect`, `let` — a spec directory is the bulk of what a Rails application leaves unbound); `send`, `public_send`, `const_get`, `constantize` with a computed name; `class_eval` and `instance_eval`; ERB, Haml and Slim templates, which are not Ruby files; a file's top-level DSL (`gem` in a Gemfile, `task` in a Rakefile, `run` in a `config.ru`) — evaluated by a library against its own object, so unbound here. Visibility (`private`, `protected`) is not modelled.
- Walked: `*.rb`, `*.rake`, `*.gemspec`, `*.ru`, the extensionless `Rakefile`, `Gemfile`, `Guardfile`, `Capfile`, `Vagrantfile`, `Brewfile`, `Dangerfile`, `Thorfile`, and any other extensionless file whose first line is a `ruby` shebang — under the roots and outside `vendor`, `node_modules`, `tmp` and dot-directories (a root named on the command line is walked whatever it is called). Prism recovers from syntax errors and honours encoding magic comments, so a file with errors is still extracted from the tree the parser recovered, and named on stderr; a name that is not valid UTF-8 is written with U+FFFD and counted.
- Comments (`TComment`): the `#` block written directly above a class, a module, a method or a constant, one string, magic comments (`frozen_string_literal`) and tool directives (`rubocop:`) looked through. Measures (`TMetrics`, METAMODEL.md §3.8): `sloc` on the file, every type and every method — lines of its own span that are neither blank nor comment-only, a heredoc's text being code and what follows `__END__` data; `cyclomatic` on methods: 1 + `if`/`elsif`/`unless`/ternary + `while`/`until`/`for` + each `when`/`in` + each `rescue` clause and modifier + `&&`/`||`/`and`/`or`. A block contributes to its enclosing method: it is not an entity.
- The metrics pass (`codegraph-metrics`, PLAN.md §18): big-code-analysis's Ruby grammar opens a space per `class`, `module` and `def`, so every file, type and method joins exactly and the join's witness holds — `sloc` equals its `ploc` on each (106 of 106 on the fixture). `Point = Struct.new(…) do … end`, `Handler = Class.new(Base) do … end` and a concern's `class_methods do … end` are blocks to the grammar: no class space of their own, and none of the pass's keys.
- `--trace <file>` merges what `extractors/ruby/trace/codegraph_trace.rb` wrote from INSIDE the running program — the one thing the extractor never does is run corpus code, so the trace is a separate step, the user's, in a project that still boots. It names constants, files and lines, never a key: no entity is added and no edge of the source changes. A mixin the VM holds and no line writes is a `traitUsage` with provenance `generated`, anchored on the declaration of the type that has it. A call the program made at a site the baseline left unresolved is ONE `invocation` with provenance `dynamic-candidate`, `candidates` listing every method that site was seen to reach and `to` the first of them — what ran once, not what must run. A method the VM holds on a line that writes no `def` has no entity and gets none: it is counted.
- Audited (M18c) on rake 13.2.1, rubygems 3.6.2, Mastodon 4.3.0 and rails 8.0.2 — 100, 794, 2 541 and 3 334 files, every model `validate`-clean, rails in 4.7 s. Resolution rate 77.8 %, 54.4 %, 31.2 % and 57.0 % of the sites; Mastodon without `spec/` is 62.1 % (55 000 of its unbound calls are RSpec's DSL), rails' own `lib` and `app` 59.4 %. Four fifths of what stays unresolved in application code is `untyped-receiver` — the ceiling of any reader that does not run the code. ORACLES: Packwerk 3.3.1's reference extraction and ConstantResolver over Mastodon's autoload paths resolve 4 335 cross-file constant references in `app/` and `lib/`; the model has the same constant in the same file for 4 289 of them (98.9 %) — the 45 others are a `module Admin` WRAPPER, which Packwerk counts as a reference and the wrapper rule does not, and one an inherited constant Packwerk places by file name. The model names 346 more that Packwerk cannot: declarations outside the autoload paths. Run under its own tests in a container, rake's VM holds a method on the same line for 1 006 of the 1 012 methods the model declares in the 83 files it loaded (the six others: definitions under a platform or capability `if`, a `def` inside a method that never ran, methods of anonymous classes), and 200 methods the model has none for — 199 written by the metaprogramming loops of three files (`class_eval` of a string, `define_method` over a list), one the `else` branch of a platform test. Of the 2 829 calls observed during that run, 1 533 are edges the baseline wrote and 879 land on sites it had left untyped. The core-table misreading, measured on rubygems: 39 corpus bodies of 20 VM types (`Gem` alone 12), and 3 802 of 71 197 edges landing on the VM's stub of a type that corpus itself implements.

## What the audit measured

Four corpora, each model `validate`-clean:

| Corpus | Files | Sites | Resolved | Entities (stubs) | Edges | Time |
|---|---:|---:|---:|---:|---:|---:|
| rake 13.2.1 | 100 | 9 261 | 77.8 % | 1 865 (94) | 6 696 | 0.1 s |
| rubygems 3.6.2 | 794 | 138 051 | 54.4 % | 15 809 (465) | 71 197 | 1.0 s |
| Mastodon 4.3.0 | 2 541 | 151 603 | 31.2 % | 16 510 (593) | 47 663 | 1.0 s |
| — `app/` and `lib/` alone | 1 108 | 51 548 | 62.1 % | 12 806 (388) | 31 180 | |
| rails 8.0.2 | 3 334 | 383 269 | 57.0 % | 71 681 (1 004) | 212 140 | 4.7 s |
| — every `lib/` and `app/` alone | 1 459 | 84 800 | 59.4 % | 36 275 (667) | 47 918 | |

The rate is over everything written, tests included: 55 000 of Mastodon's unbound calls are RSpec's DSL, which is why its application code alone reads at twice the rate of the whole repository. Four fifths of what stays unresolved in application code is `untyped-receiver` — the ceiling of any reader that does not run the code.

**Against Packwerk** (3.3.1: its parser, its reference extraction and its ConstantResolver, over Mastodon's autoload paths). Packwerk resolves 4 335 cross-file constant references in `app/` and `lib/`; the model has the same constant in the same file for **4 289 of them (98.9 %)**. The 45 others are a `module Admin` wrapper around a class, which Packwerk counts as a reference to `Admin` and the wrapper rule does not; one is an inherited constant that Packwerk places by file name and the model in the superclass that assigns it. In the other direction the model names 346 references Packwerk cannot — declarations under `lib/`, outside the autoload paths.

**Against a booted VM** (rake, its own tests run in a container under the trace). Of the 1 012 methods the model declares in the 83 files that were loaded, the VM holds one on the same line for **1 006**; the six others are definitions under a platform or capability `if`, a `def` inside a method that never ran, and methods of anonymous classes. The VM holds 200 methods the model has none for: 199 written by the metaprogramming loops of three files, one the `else` branch of a platform test. Of 2 829 calls observed, 1 533 are edges the baseline wrote — same caller, same callee, same line.

## The reference corpus

`fixtures/ruby/` is a small order-management corpus (31 walked files, ~400 lines) shaped like a gem — `Gemfile`, `Rakefile`, a gemspec, `lib/`, `spec/`, `bin/` — and the acceptance corpus for the extractor: the snapshot in `fixtures/ruby/expected/` is produced from that tree, and `./test.sh --ruby` checks that the release binary reproduces it byte for byte. `expected/model.metrics.jsonl` beside it is the same model after the metrics pass.

```bash
./bin/codegraph-ruby --src fixtures/ruby/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/ruby/expected/model.jsonl && echo same
```

Run it from the repository root with that relative `--src`: the typed path is the header's `root`, so an absolute one differs from the snapshot in its first line. A file's key is then `lib%2Facme_order%2Forder.rb`, and its `name` the path as written.

**It does not load, on purpose.** `bundle install` was never run and `require "acme_order"` would fail at the first `ActiveRecord::Base` — the ordinary legacy case. `StandardError`, `Comparable` and `String` are stubs below `<ruby>`; `ActiveRecord::Base`, `Forwardable` and `IRB` below `<gems>`. And `lib/acme_order/legacy/broken.rb` never closes its `def export(format`: the extractor still extracts the class and both methods from the tree Prism recovered, and says so.

| File | Pins |
|---|---|
| `Gemfile`, `Rakefile`, `acme_order.gemspec`, `config.ru`, `lib/tasks/orders.rake` | extensionless and non-`.rb` Ruby files walked by name and extension; a DSL's verbs (`gem`, `task`) as `unbound-self-call`; `load "tasks/orders.rake"` as an `import` of a file named with its extension; top-level code as the **file's** edges |
| `bin/console`, `bin/setup` | a `ruby` shebang is walked, a `#!/bin/sh` one is not |
| `vendor/cache/skipped.rb` | `vendor/` is third-party by convention |
| `lib/acme_order.rb`, `version.rb` | the entry point declares the namespace and requires its parts; `autoload` as a `declared` import; a second `module AcmeOrder` body `attachedTo` the first; `VERSION` as a `constant` |
| `lib/acme_order/errors.rb`, `base.rb` | a wrapper body declaring nothing; an empty body declaring a class; `super` crossing from the corpus into the core table; the compact `class AcmeOrder::Base` reading `AcmeOrder` — a `reference` and a `derived` import |
| `lib/acme_order/order.rb`, `a_order_patch.rb` | the whole model in one class: inheritance through the enclosing scope, `include`/`extend` as `traitUsage`, constants with values, `attr_*` as fields, a nested class, `self.` and `class << self` methods, every parameter shape, a `derived` invocation through `@pricing`; a reopening that sorts *before* the primary and is still attached to it |
| `lib/acme_order/money.rb`, `point.rb` | `< Struct.new(…)` as a `generated` inheritance with fields; `def /` and `def %` keyed `%2F` and `%25`; a type declared by assignment |
| `lib/acme_order/ledger.rb`, `record.rb` | `has_many` charged to the one library that could answer (`derived`); the same class with a second library mixed in, every such call dropped as `ambiguous-ancestor`; a computed `define_method` making instance calls `unbound-dynamic` |
| `lib/acme_order/auditable.rb`, `invoice.rb` | ActiveSupport::Concern's `class_methods do` as the body of `ClassMethods`; `audited :total` reached through the hook, `derived`; a block argument's call dropped — what `--trace` binds |
| `lib/acme_order/railtie.rb` | a namespace no file gives a body to, proven a library's by `Rails.logger`: a stub below `<gems>` |
| `lib/acme_order/core_ext/string.rb`, `label.rb` | a monkey patch `attachedTo` `<ruby>/String`; `class Label < String` inheriting from the VM's, not the patch |
| `lib/acme_order/reporting.rb` | `module_function`; locals typed by their assignment → `derived` edges; a literal's class is written, so `"".blank?` lands on the corpus's own `String#blank?`, `declared` |
| `lib/acme_order/dynamic.rb` | everything the extractor refuses to guess, each counted: a computed `require`, `Class.new(Base) do`, `class << Loader`, `def Dynamic.helper`, `include Module.new`, `send(:ping)` resolved against `public_send(name)` dropped |
| `lib/acme_order/legacy/broken.rb`, `loader.rb` | a syntax error Prism recovers from; `require_relative "missing"` as a stub module keyed by the path it names |
| `lib/acme_order/promo#2024.rb` | a `#` in a file name → `%23` in the key |
| `spec/spec_helper.rb`, `spec/acme_order/order_spec.rb` | `spec` as a load root; a `def` inside a `describe` block is a method of the **file** |

## Gotcha

Point `--src` at the **application root** — `app/`, `lib/`, `config/`, `spec/` together — not at `lib/` alone: a Zeitwerk application's imports are its constant references, and a constant resolves only when its declaring file is under the roots. The module is the file, so the city draws one building per class or module in a district per directory, which under Zeitwerk coincides with the namespaces. Expect the resolution rate of a repository with a large `spec/` to read low: a test framework's DSL is unbound by design, and the application code alone reads at about twice the rate.

| Symptom | Cause | Fix |
|---|---|---|
| `untyped-receiver` dominates the drops | the stated ceiling: a parameter or a call result types nothing | expected; `--trace` from inside a project that boots binds what ran |
| every call into a library lands on `<gems>/Foo` with no method | a stub has no members | expected |
| `Rails.env`, `ENV`-style constants dropped as `namespace-only` | the corpus never proves the namespace has a body elsewhere | expected unless a site inherits from it or sends it a message no bare module answers |
| `'limits.h' file not found` when building | libclang without clang's builtin headers | use `./build.sh --ruby`; by hand, `extractors/ruby/README.md` |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
