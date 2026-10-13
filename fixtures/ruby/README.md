# `fixtures/ruby` — the reference corpus for the Ruby extractor

A small, plausible order-management corpus (31 walked files, ~400 lines) shaped
like a gem — `Gemfile`, `Rakefile`, a gemspec, `lib/`, `spec/`, `bin/` — that
exercises the extraction hazards PLAN.md §19 names. It is the acceptance corpus
for `extractors/ruby`: the snapshot `expected/model.jsonl` is produced from
**this** tree, and every row of the table below is a behaviour a reviewer can
check by eye. `expected/model.metrics.jsonl` is the same model after
`codegraph-metrics` (PLAN.md §18).

```bash
./build.sh --ruby
./bin/codegraph-ruby --src fixtures/ruby/src --out model.jsonl
./bin/codegraph-ruby --src fixtures/ruby/src --out model.jsonl --explain-dropped   # + one stderr line per drop
```

Run it from the repository root with that relative `--src`: the typed path is
the header's `root`, so an absolute one differs from the snapshot in its first
line. A file's key is `lib%2Facme_order%2Forder.rb` — the root-relative path,
escaped — and its `name` the path as written.

## This corpus does not load, on purpose

`bundle install` was never run and `require "acme_order"` would fail at the
first `ActiveRecord::Base` — the ordinary legacy case. Nothing here is ever
run: the extractor parses with Prism and resolves names lexically. A constant
the corpus does not declare is a stub below `<ruby>` when the VM defines it
before any file runs (`StandardError`, `Comparable`, `String`), and below
`<gems>` otherwise — the standard library included (`Forwardable`), because it
needs a `require` and is gems that move between Ruby releases.

**Do not "fix" `lib/acme_order/legacy/broken.rb`**: its `def export(format`
never closes, and the extractor must still extract the class and both methods
from the tree Prism recovered, and say so on stderr.

## What the numbers are

31 files, 181 entities (24 of them stubs), 153 edges. Of 177 sites — a
constant read, a call, a `super`, a `raise`, a variable — 135 resolve (76.3 %):
79 to the corpus, 21 to `<ruby>`, 14 to `<gems>`, 21 to the language itself
(`puts`, `private`, `"x".freeze`: resolved, and no edge). The 42 others are
dropped and counted by reason; `--explain-dropped` lists each with its line,
and what decided it where something did. Eight operators on a receiver no
parser can type (`a + b`) are counted apart and stay out of the rate.

The metrics pass joins 106 of the 109 measured entities. The three others are
types the grammar reads as a block: `Point = Struct.new … do`, `Loader =
Class.new(Base) do`, and the `class_methods do` of a concern.

## What each file pins

| File | Pins | Why it is easy to get wrong |
|---|---|---|
| `Gemfile` | An extensionless Ruby file, walked by name. `source`, `gem`, `gemspec` are calls on `self` that nothing declares: five `unbound-self-call` drops, no edge. | A DSL's verbs belong to an object the file never names. |
| `Rakefile` | Walked by name. `require "rake/testtask"` → the stub module `<gems>%2Frake%2Ftesttask`, named `rake/testtask`. `load "tasks/orders.rake"` → an `import` of `lib/tasks/orders.rake`: `load` names a file WITH its extension, searched on the same load roots. | Every other extractor walks by extension alone; `load` is not `require`. |
| `acme_order.gemspec`, `config.ru`, `lib/tasks/orders.rake` | `.gemspec`, `.ru` and `.rake` are Ruby. `require "acme_order"` resolves to `lib/acme_order.rb` through the `lib` load root. Top-level code is the FILE's: `AcmeOrder::VERSION` is an `access` from the file to the constant, `AcmeOrder.root` an `invocation` from `config.ru`. `spec.name = …` is dropped — `spec` is a block parameter, which types nothing. | A feature is not a path; a script has no method to own its edges. |
| `bin/console` | Walked: no extension, no known name, but its first line is a Ruby shebang. `IRB.start` → a `reference` and an `invocation` to the stub `<gems>/IRB`. | The file says what it is. |
| `bin/setup` | NOT walked: `#!/bin/sh`. | An extensionless file is Ruby only by its own account. |
| `vendor/cache/skipped.rb` | NOT walked: `vendor/` is third-party by convention. | Its class would be corpus. |
| `lib/acme_order.rb` | `module AcmeOrder` with a method of its own IS a declaration; `def self.root` is keyed `AcmeOrder.root#self`. `require "bigdecimal"` → `<gems>%2Fbigdecimal`; `require "acme_order/version"` → the corpus file, by load root; five `require_relative` → their files. `autoload :Reporting, "acme_order/reporting"` → a `declared` import of `reporting.rb`: the feature is written, only its loading is deferred. | The entry point both declares the namespace and requires its parts. |
| `lib/acme_order/version.rb` | `AcmeOrder` again: a SECOND entity, `attachedTo` the one in `lib/acme_order.rb` (first in canonical order: `.` sorts before `/`). `VERSION = "0.1.0"` is a `constant`, keyed by its full path `AcmeOrder::VERSION`, its `value` the string. | One entity per declaring file; a constant is a member, not a type. |
| `lib/acme_order/errors.rb` | `module AcmeOrder` here only wraps three classes: no `AcmeOrder` entity in this file. `class Error < StandardError; end` — an EMPTY body is a declaration. `NotFound < Error` resolves to the sibling. `super(…)` in `TooManyLines#initialize` → an `invocation` of `<ruby>/Exception`: the nearest ancestor that defines `initialize`, found through `Error` and the VM's own chain. | A wrapper is lexical scope; `super` crosses from the corpus into the core table. |
| `lib/acme_order/base.rb` | `class AcmeOrder::Base`, the compact spelling: the same key shape as a class nested in `module AcmeOrder`. Unlike a wrapper it READS `AcmeOrder` — the name must exist for the class to open — so `Base` has a `reference` to the `AcmeOrder` of `lib/acme_order.rb`, and the file a `derived` import of it. `self.class.name` is the language: resolved, no edge. | Two spellings, one key — and one of them is a constant read. |
| `lib/acme_order/order.rb` | The whole model in one class — see below. | — |
| `lib/acme_order/a_order_patch.rb` | Reopens `AcmeOrder::Order` and sorts BEFORE `order.rb` — the body that writes a superclass is still the primary, and this one is `attachedTo` it. Compact, so it references `AcmeOrder` too. | "First in file order" alone would pick the patch. |
| `lib/acme_order/money.rb` | `< Struct.new(:cents, :currency)`: an `inheritance` to `<ruby>/Struct` with provenance **`generated`** — the language says so, the source writes no such class — and two fields, `@cents` and `@currency`, anchored at that line. A bare `cents` is then an `access`, not a call. `other.cents` is dropped: a parameter is untyped. `include Comparable` → `<ruby>/Comparable`. `def /` and `def %` are keyed `Money.%2F` and `Money.%25`, named `/` and `%`. | A Struct's members are state nobody assigns; `/` and `%` are the key's own separator and escape. |
| `lib/acme_order/point.rb` | `Point = Struct.new(:lat, :lng) do … end`: a `class` named `AcmeOrder::Point`, its block the body (`to_s` is ITS method, reading both fields). The enclosing `module AcmeOrder` stays a wrapper. | An assignment that declares a type. |
| `lib/acme_order/priceable.rb` | A module under a wrapper. `raise NotImplementedError` → `throws` (and a `reference`) to `<ruby>/NotImplementedError`. `price.nil?`: `price` is a `declared` call on `self`, `.nil?` on its result is dropped. | The receiver of the second call is a value. |
| `lib/acme_order/pricing/standard.rb` | Two wrappers deep; `< Base` still finds `AcmeOrder::Base` from the innermost scope outward. `order.lines.sum`: two `untyped-receiver` drops. | Lexical lookup walks every enclosing scope; a parameter's class is not written. |
| `lib/acme_order/pricing/premium.rb` | A compact class opens ONE scope, so its superclass and its mixin are written in full (`::AcmeOrder::Priceable` absolute). `super` → an `invocation` of `Standard#price_for`, the method it overrides. | From here a bare `Standard` would NOT resolve — in Ruby either. |
| `lib/acme_order/ledger.rb` | `< ActiveRecord::Base`, and nothing mixed in: `has_many` and `where` run on the class, where one library could answer — two `invocation`s of `<gems>/ActiveRecord::Base`, **`derived`**: an attribution by elimination, not a fact. `define_method("#{state}?")` gives the INSTANCES methods no key can name, so `update!` on an instance is `unbound-dynamic` (the drop names `AcmeOrder::Ledger`) — while what the class itself answers is as known as before. | Where `has_many` lands, why it must not be called a fact, and which side a computed `define_method` clouds. |
| `lib/acme_order/record.rb` | The same class with `include ActiveModel::Validations`: `<gems>/ActiveRecord::Base` is a `class` (inherited from), the mixin a `module`. Now TWO libraries could answer — on the class side too, because a module's `included` hook may extend whatever includes it, and `validates` IS that module's. `has_many`, `validates`, `where` and `update!`: four `ambiguous-ancestor` drops, each naming both. | An honest "either" beats a confident wrong edge: M18b charged `validates` to ActiveRecord::Base. |
| `lib/acme_order/auditable.rb` | What including a module ALSO gives the includer. `Auditable` is an ActiveSupport::Concern: `class_methods do … end` IS the body of `Auditable::ClassMethods`, a `module` entity anchored on the block, and `included do include Comparable end` is read as a hook (the constant is still a `reference` from `Auditable`). `Stamped` says the same in plain Ruby: `def self.included(base); base.extend(ClassMethods)`. | The idiom Rails puts every shared class method behind. |
| `lib/acme_order/invoice.rb` | `include Auditable`, `include Stamped` — two `traitUsage`, and no third: `Invoice` writes no `extend`. `audited :total` and `stamp :issued_at` still land on `Auditable::ClassMethods.audited` and `Stamped::ClassMethods.stamp`, **`derived`**: reached through the hook. `audit!` on an instance is plain `include`: `declared`. `invoices.each { \|invoice\| invoice.settle }` is dropped — a block argument is untyped — and is what `--trace` binds (below). | The receiver is written; the link to the method is not. |
| `lib/acme_order/railtie.rb` | `class Rails::AcmeOrderHook` opens a member of a namespace no file here gives a body to. `Rails.logger` is answered by no bare module, so the body of `Rails` is elsewhere: a stub `<gems>/Rails`, referenced by the class and invoked by `install`. | Without that evidence `Rails` is `namespace-only` and every `Rails.env` in a Rails application is dropped. |
| `lib/acme_order/core_ext/string.rb` | A monkey patch: `String` is a declared `class` in this file, `attachedTo` the stub `<ruby>/String`. Inside it, a bare `strip` is the VM's `String#strip`. | The VM defined `String` first; this body cannot be its definition. |
| `lib/acme_order/label.rb` | `class Label < String` → `inheritance` to `<ruby>/String`, NOT to the patch file; `upcase` and `super` are `invocation`s of that stub. | Otherwise the patch becomes the hub every string points at. |
| `lib/acme_order/reporting.rb` | Reached by `autoload` alone, and `module_function` makes its methods answer on the module. Typed locals: `label = Label.new(…)` then `label.shout` → a **`derived`** invocation; `order = Order.new(…)` then `order.note = "seen"` → a **`derived`** `access` writing `Order.@note`. `"".blank?` → the corpus's own `String#blank?`, `declared`: a literal's class is written, and the VM's `String` has no such method. Three `derived` imports (`label.rb`, `money.rb`, `order.rb`): nothing here requires them. | Flow-typed is not written: the provenance says which is which. |
| `lib/acme_order/dynamic.rb` | Everything the extractor refuses to guess, each counted — see below. | — |
| `lib/acme_order/legacy/broken.rb` | A syntax error Prism recovers from: the class and both methods are extracted. | An unparsed file is a blind spot in every other extractor. |
| `lib/acme_order/legacy/loader.rb` | `require_relative "../order"` normalises to a corpus file; `require_relative "missing"` → a stub module keyed by the path it names; `require "./lib/acme_order/version"` is relative to the root. | A missing file still has a name. |
| `lib/acme_order/promo#2024.rb` | A `#` in a file name: `%23` in the key, kept in the `name`. An empty class with a superclass is a declaration. | `#` is the key's disambiguator mark. |
| `spec/spec_helper.rb`, `spec/acme_order/order_spec.rb` | `require "spec_helper"` resolves through the `spec` load root. A `def` inside the `RSpec.describe` block is a method of the FILE: a block does not change where a `def` is written. `AcmeOrder::Order.new(…)` there → `Order#initialize`. | `spec` is a load root because RSpec makes it one. |

### `lib/acme_order/order.rb`, line by line

| Written | The model says |
|---|---|
| `class Order < Base` | `inheritance` to `AcmeOrder::Base`, found through the enclosing scope — in another file, so a `derived` import (nothing here requires `base.rb`) |
| `include Priceable`, `extend Forwardable` | two `traitUsage`; `Forwardable` is `<gems>/Forwardable`, a `module` because it is mixed in |
| `MAX_LINES = 100`, `DEFAULT_CURRENCY = "EUR".freeze`, `ROUNDINGS = %i[…].freeze` | three `constant`s, children of `Order`, with `value` a number, a string (`.freeze` is seen through), an array; the comment above `MAX_LINES` is its `comments` |
| `attr_reader :reference, :lines`, `attr_accessor :note` | three `field`s — `@reference`, `@lines`, `@note` — anchored at the `attr_*`: the accessor is not an entity, the state it exposes is |
| `@currency = …`, `@pricing = …` in `initialize` | two more `field`s, anchored at their first assignment |
| `class Line` | a CHILD of `Order`, keyed `AcmeOrder::Order::Line`, with fields of its own |
| `def self.call(*)` beside `def call` | two entities: `Order.call#self` and `Order.call` |
| `new(*).call` | `invocation` of `Order#initialize` and of `Order#call`, both `declared`: `new` on `self` in a class method names this class |
| `class << self; def build` | `Order.build#self` |
| `initialize(reference, lines = [], *rest, currency: DEFAULT_CURRENCY, …)` | every parameter shape; a default that reads a constant is an `access` from the method |
| `Pricing::Standard.new` | a `reference`, resolved from the enclosing `AcmeOrder` — and one of this file's five `derived` imports |
| `raise TooManyLines, MAX_LINES` | `throws` and `reference` to `AcmeOrder::TooManyLines`, `access` reading `MAX_LINES` |
| `lines.size` | `lines` is the reader: an `access` reading `@lines`; `.size` is dropped |
| `self.note = "changed"` | an `access` WRITING `@note` |
| `Money.zero(@currency)` | `reference` to `Money`, `invocation` of `Money.zero#self`, `access` reading `@currency` |
| `@pricing.price_for(self)` | `invocation` of `Pricing::Standard#price_for`, **`derived`**: `@pricing` is only ever assigned `Pricing::Standard.new` |
| `def price; total; end` | a `declared` self-call; `Order#price` and `Priceable#price` are two methods, and the class's wins |

Every method carries `sloc` and `cyclomatic` (`Order#total`: 4 and 2), every
type and file `sloc`.

### `lib/acme_order/dynamic.rb`, line by line

| Written | The model says |
|---|---|
| `require File.join(__dir__, "version")` | the Ruby 1.8 spelling of `require_relative`: a `declared` import of `version.rb` |
| `require File.join(root, "computed")` | dropped, `computed-require`; `root` itself is an `unbound-self-call` |
| `HANDLERS = {}` | a `constant` whose `value` is `unevaluated`, the source kept |
| `Loader = Class.new(Base) do … end` | a `class` `Dynamic::Loader` with a `declared` inheritance to `Base` — the superclass is written — and `def load` its own method |
| `class << Loader` | an opaque body: `def instance` is dropped, `def-in-opaque-body` |
| `def Dynamic.helper` | dropped, `def-on-object`: a singleton method of a value |
| `include Module.new` | dropped, `computed-mixin` |
| `class Wrapped < Loader` | `inheritance` to the synthetic class |
| `class Odd < HANDLERS` | `Odd` is declared; its superclass is dropped as `not-a-type`, never stubbed below `<gems>`: a corpus constant is not external |
| `define_method(:ping) { pong }` | a `method` `Ghost.ping` that invokes `pong` |
| `define_method("#{name}_later")` | dropped, `computed-define-method` — and `Ghost` is now a type with methods no key can name |
| `send(:ping)` | a literal name is a call like any other: `invocation` of `Ghost.ping` |
| `public_send(name)` | dropped, `dynamic-dispatch` |
| `name`, `vanish` | dropped, `unbound-dynamic`: in a type that defines methods at run time, "nothing declares it" is not evidence — and the drop names the type, `AcmeOrder::Dynamic::Ghost` |
