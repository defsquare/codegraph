import type { Profile } from "../profile.js";

/**
 * Ruby profile (PLAN.md §19.2 — the Prism extractor's contract). The module is
 * the FILE, the TypeScript and Elixir rule: Ruby has no namespace construct
 * apart from its types (a `module` is a mixin, a `class` nests constants too),
 * so nothing contains a declaration but the file it is written in. `class`
 * and `module` are types below the file, named by their fully qualified
 * constant path.
 *
 * No `interfaceImplementation`: Ruby has no interface to declare conformance
 * to. A mixin (`include`/`extend`/`prepend`) is `traitUsage`, the relation PHP
 * introduced, and is never flattened into the class that mixes it in.
 */
export const rubyProfile: Profile = {
  lang: "rb",

  kinds: {
    // A source file. Its top level is executable code (a script, a Rakefile,
    // `config/*.rb`), hence the markers. The reserved stub modules `<ruby>`
    // and `<gems>`, and every external feature a `require` names, are this
    // kind too, with `isStub: true`.
    file: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TSourceAnchor", "TComment", "TMetrics", "TWithInvocations", "TWithAccesses"],
    },

    // `class Foo [< Bar]`, `Foo = Struct.new(…)`, `Foo = Class.new(Bar)`. A
    // class body is executable code (`has_many :lines`, `private`): its calls
    // are edges FROM the class. TAttachedTo on a reopening: the body of a
    // class another file declares, or the VM defines, is attached to that
    // primary declaration.
    class: {
      required: ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TAttachedTo", "TComment", "TMetrics", "TWithInvocations", "TWithAccesses"],
    },

    // `module Foo`, `Foo = Module.new`: the mixin and the constant container.
    // No inheritance — a module is mixed in, it has no superclass.
    module: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TAttachedTo", "TComment", "TMetrics", "TWithInvocations", "TWithAccesses"],
    },

    // `def`, instance or singleton (`def self.x`, a `def` inside
    // `class << self`), and `define_method(:x) { … }`, in a type or at a
    // file's top level. TWithChildren: its parameters carry `parent` (the M6
    // executable-containment rule).
    method: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TWithLocalVariables", "TComment", "TMetrics"],
    },

    // An instance variable and the `attr_*` that exposes it: one entity. A
    // Struct or Data member too.
    field: {
      required: ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"],
      optional: ["TWithValue", "TComment"],
    },

    // `NAME = value` for a value that is not a type. Its initializer may call
    // and read.
    constant: {
      required: ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"],
      optional: ["TWithValue", "TComment", "TWithInvocations", "TWithAccesses"],
    },

    // Ruby names every parameter but the anonymous ones (`*`, `**`, `&`,
    // `...`) and a destructured position (`(a, b)`), hence TNamed optional.
    parameter: {
      required: ["TStructural", "TChildOf"],
      optional: ["TNamed", "TSourceAnchor", "TWithValue"],
    },
  },

  edges: ["import", "inheritance", "traitUsage", "invocation", "access", "reference", "throws"],

  notes: [
    "The module is the file (the TypeScript and Elixir rule): `TModule.definedIn` has exactly one entry, and every entity's module is the file it is written in. `class` and `module` are types below it, named and keyed by their fully qualified constant path (`Acme::Order`) — `::` is part of the name, never a separator of the key. A type written inside the body of a type that is an entity in the same file is its child; otherwise it is a child of the file. A value constant is keyed the same way (`Acme::Order::MAX_LINES`), a child of the type whose body assigns it.",
    "Ruby classes are open, so a class or a module is ONE ENTITY PER DECLARING FILE (the TypeScript declaration-merging rule): every body of `Acme::Order` in one file folds into one entity anchored at the first, and a second file reopening it declares a second entity with the same name. A reference to the constant targets the PRIMARY declaration, chosen deterministically — the one that writes a superclass, else the first in canonical file order — and every other declaration is `attachedTo` it: containment says where a body is written, attachment which type it belongs to. A method is looked up across every body, and lands on the one in the calling file when there is one.",
    "A monkey patch is a reopening by construction: the VM defined `String` before any file ran, so a corpus `class String` cannot be its definition. It is a declared entity in its file, `attachedTo` the stub `<ruby>/String`, and a reference to `String` anywhere still names the VM's — the patch file does not become the hub every string in the corpus points at. A method the patch adds IS found, before the VM's own (`\"\".blank?` lands on the corpus `String.blank?`). The one corpus this misreads is a library that itself implements a constant of the core table (rubygems' own `Gem`): its references land on the stub. A library's class the corpus reopens (`class ActiveRecord::Base`) has no such table to consult and IS the declaration the corpus knows.",
    "A wrapper body is not a declaration: `module Acme; class Order; end; end` and `class Acme::Order; end` are two spellings of one thing, and both yield `Acme::Order` alone. A `module` or `class` body with no superclass whose statements are all class or module declarations — `Point = Struct.new(…)` being one — declares nothing of its own in that file: it is lexical scope, Ruby's spelling of a package statement, so a namespace reopened in fifty files is not fifty entities. An empty body (`class NotFound < StandardError; end`, `module Marker; end`) IS a declaration. A constant path no file gives a body to has no entity, and a reference to it is dropped and counted (`namespace-only`) — UNLESS the corpus itself proves the body exists elsewhere: a message is sent to it that no bare module answers (`Rails.env`, where the corpus only writes `class Rails::Patch`), or a class inherits from a path nothing in the corpus opens. That namespace is a library's, a stub below `<gems>`; what the corpus declares under it stays the corpus's.",
    "`Point = Struct.new(:x, :y) do … end`, `Coord = Data.define(:lat)`, `Handler = Class.new(Base)` and `Mixin = Module.new` are types named by the constant, the block their body: its `def`s are their methods. `Struct.new` and `Data.define` — as a superclass too, `class Money < Struct.new(:cents)` — yield an `inheritance` edge to `<ruby>/Struct` / `<ruby>/Data` with provenance `generated`: the source writes no `< Struct`, the language defines it. The superclass given to `Class.new` is written, hence `declared`. Each member is a `field`.",
    "Key components are percent-encoded: `/`, `#` and `%` in every path segment and name (`def /(other)` is a method named `/`, keyed `Money.%2F`), and `<` in a path segment, so that no walked path can spell a reserved module. Ruby has no overloading — a name is one method per type — so a method carries no arity; `def self.call` and `def call` coexist in one class, and the singleton method alone carries the disambiguator `self`, the keyword the source writes. A method written twice in one file is one entity, anchored at the first. A parameter is keyed `#param:<name>` below its method, by 1-based ordinal when it has no name or repeats one.",
    "`signature` is the method as it would be called: `total(currency, [precision], *rest, tax:, [rounding:], **opts, &blk)` — brackets mark a parameter with a default, whose value is not part of the signature; a singleton method is prefixed `self.`. The default itself rides as the parameter's `value` when it is a constant expression: a string, a number, `true`/`false`/`nil`, an array of those, a frozen literal (`\"EUR\".freeze`); a symbol, a hash, a range and a regexp as `unevaluated` with the text written; a constant naming a type as a `type` literal. A default or an initializer that calls carries no value at all.",
    "A `field` is an instance variable, and the `attr_reader` / `attr_writer` / `attr_accessor` that exposes it is the SAME entity, named `@total` and anchored at the `attr_*` when there is one, else where the variable is first written. `@total` in a body and a call of the accessor (`total`, `self.total = x`, `order.total` on a typed receiver) are `access` edges — the C# property rule: the accessor is not an entity. An instance variable belongs to the object, so a subclass reading `@total` reads the field of the root-most corpus ancestor that has it. `@x` in a class body or a singleton method is the class's own variable and carries the `self` disambiguator; `@@x` is a field of the type. A Struct member is a field named like the variable it stands for (`@cents`).",
    "Corpus membership is a whitelist of the constant paths the roots declare or assign, never a name-prefix test. Every other type is a stub below one of two reserved modules: `<ruby>` for a constant the VM defines before any file runs (the core classes and modules, from a table distilled from RBS `core/` at a pinned version and embedded in the extractor — the header names that version), and `<gems>` for a constant the roots do not declare and the VM does not define: a library, whichever one. The standard library is in `<gems>` on purpose — nearly all of it is default or bundled gems, the set moves with every Ruby release, and a model's keys must not. A `<gems>` stub is a `class` when a site inherits from it, instantiates it or raises it, and a `module` otherwise — every class is one; it may also be a value constant of that library, which nothing here can tell. That kind is the evidence ONE corpus holds, so two corpora can disagree on a stub (`Logger` instantiated here, only named there): validating their union reports it as a duplicate-id conflict. A stub has no members: a call on a library's type lands on the stub.",
    "`require`, `require_relative`, `load` and `autoload` with a literal argument are `import` edges from the file, wherever they are written. `require_relative` names a path: the file it resolves to, or a stub module keyed by that path when nothing is there; the Ruby 1.8 spellings fold to it (`File.expand_path(\"../x\", __FILE__)`, `File.join(File.dirname(__FILE__), \"x\")`, `\"#{__dir__}/x\"`). `require \"acme/order\"` is searched on the load roots the layout implies — every directory named `lib`, `spec` or `test`, then the root — nearest to the requiring file first, and that resolution is a fact about the repository rather than the language, counted on its own. A feature no corpus file answers is a stub module keyed by the feature as written below `<gems>` (`<gems>%2Fnokogiri`, `<gems>%2Fnet%2Fhttp`). Any other computed argument is dropped and counted.",
    "A Zeitwerk application writes no `require`: the constant reference IS the import, turned into a load at run time. So a constant that resolves to a declaration in another file — a type or a value, in a header or in a body — yields ONE `import` edge per (file, target file), provenance `derived`, anchored at the first such reference, and none when the file already imports that file explicitly. Without it the import layer, the one layer comparable across languages, is empty for every Rails application; with it, a consumer that needs written facts only filters on `declared`.",
    "A constant is resolved as Ruby resolves it: each enclosing scope from the innermost out (`Module.nesting` — a compact `class A::B` opens ONE scope, `A::B`, and does not see `A`), then the ancestors of the innermost scope (a constant of the superclass or of an included module), then the top level; `::X` is absolute; `A::B` resolves `A` that way, then `B` in `A` and in what `A` inherits from (`Child::LIMIT` is `Base::LIMIT` when Base assigns it) — never at the top level. A compact declaration READS what it is written under: `class Admin::Users` is a `reference` from `Admin::Users` to `Admin` where `Admin` is a type, since the name must exist for the class to open; a wrapper (`module Admin; class Users`) creates what it opens and reads nothing. The header of a declaration (`< Base`, `include M`) is read by the lexical scopes alone. A constant read is a `reference` to the type it names, or an `access` to the value constant it names; `A::B::C` is one read, not three. A read of a VM value (`ARGV`, `ENV`) is the language: resolved, counted, no edge.",
    "`class A < B` is an `inheritance` edge when `B` is a constant; `< Class.new(Base)`, `< ActiveRecord::Migration[7.0]` and every other computed superclass is dropped and counted — the constants it names are still referenced, from the class. `include M`, `extend M` and `prepend M` written in a type's body (or `include M` inside its `class << self`) are `traitUsage` edges from the type, one per argument, and the edge does not say which of the three was written; `extend self` is not a relation. What an `included` hook gives whatever includes the module is read where the idiom is literal: `base.extend(M)`, `base.include(M)` and their `send` spellings in `def self.included(base)`; and, in a module that writes `extend ActiveSupport::Concern`, its `ClassMethods` module, `class_methods do … end` — the BODY of that module, an entity anchored on the block — and the mixins written directly in `included do … end`. No `traitUsage` is written for it, since the includer writes none: the lookup goes through the hook, and what it finds there is an inference (below). A mixin applied any other way — a computed argument, a hook that calls a helper — is invisible to the parser; `--trace` adds it.",
    "A call is an `invocation` when what it is sent to has a type the source states, looked up as Ruby would: prepended modules, the type, its mixins last-included first, its superclass's — and on the class side its singleton methods, what it extends, its superclass's. `declared`: an implicit or explicit `self`, `self.class.x`, `Foo.x` on a constant, `Foo.new(…).x`, `super`, and `new(…).x` where `self` is the class. `Foo.new` — and a bare `new` in a class method — is an invocation of `initialize`. `module_function` and `extend self` make an instance method answer on the module; an `alias_method` or `alias` answers with the method it names; `send(:x)` with a literal name is a call like any other, and `method(:x)` a `reference` to the method. A top-level `def` is a method of every object. A block is assumed to keep `self`, as `each` and `map` do: an `instance_eval`-style DSL block is not detected.",
    "`derived` says the receiver's type was inferred: a local every assignment of which in its body is `Foo.new(…)` (flow-insensitively — one other assignment anywhere untypes it, and a parameter types nothing), and an instance variable every assignment of which in the type is `Foo.new(…)`, the `@repo ||= Repo.new` idiom included. An accessor on such a receiver is a `derived` `access`. `derived` also says the METHOD was reached through an `included` hook: `audited :total` in a class that includes a concern whose `class_methods` define `audited` — the receiver is written, the link from the class to that module is not.",
    "What every object answers (`puts`, `raise`, `freeze` — Object, Kernel, BasicObject), what every class answers in a class-side call (`new`, `attr_accessor`, `private`, `include` — Class, Module), and any method of a literal (`\"x\".upcase`, `[1].map`) are the LANGUAGE: resolved, counted, and never an edge. A method the corpus inherits from a core class it names is a dependency on it — `upcase` in a subclass of String is an `invocation` of `<ruby>/String`, `between?` of `<ruby>/Comparable` — and a call on a core class is an invocation of that class as written (`File.read` lands on `<ruby>/File`, though `read` is IO's; so does `Time.zone`, which some library added).",
    "A call nothing the corpus or the VM defines answers, in a type with exactly ONE library that could answer, is an `invocation` of that library's stub with provenance `derived` — an inference by elimination, where `has_many` and `where` land in an ActiveRecord model. A library that could answer is a library superclass, a library module mixed in — and, on the class side, a library module merely INCLUDED, whose hook may have extended the class: `validates` in a model that includes ActiveModel::Validations is that module's, not ActiveRecord::Base's. Two of them is dropped and counted as `ambiguous-ancestor`; none, as `unbound-self-call` (`unbound-method` on a named receiver). A type that defines methods no `def` writes proves nothing by not declaring one — on the side they are defined for: `def method_missing` and a `define_method` with a computed name in a class body cloud its INSTANCES, `def self.method_missing` and `define_singleton_method` the class itself; a miss on that side is `unbound-dynamic`.",
    "A receiver no parser can type — a parameter, a block argument, the result of a call — is the stated ceiling: dropped and counted as `untyped-receiver`, never guessed, candidate generation being the analyzer's. An operator on such a receiver (`a + b`, `x[0]`, `!done`) is counted apart and kept out of the resolution rate: it is the language far more often than not. `--explain-dropped` lists every dropped site with its reason, file and line, and what decided it where something did: the type that defines methods at run time for an `unbound-dynamic`, the libraries that could answer for an `ambiguous-ancestor`.",
    "`raise Foo`, `raise Foo, \"msg\"` and `raise Foo.new(…)` are `throws` edges to Foo, beside the `reference` the constant read also is; `raise \"text\"` throws `<ruby>/RuntimeError`. `raise error` re-raises a value whose class the source does not say: dropped and counted.",
    "A `def` belongs to the type whose body it is written in — a `def` inside a block (`included do … end`) too, since a block does not change where a constant or a method is written, a concern's `class_methods do … end` alone excepted (it is the body of `ClassMethods`); at a file's top level it is a child of the file. `def self.x` and a `def` inside `class << self` are singleton methods of the enclosing type. `define_method(:x) { … }` with a literal name is a method like a `def`, its block the body. `def obj.x`, a `def` inside `class << obj`, and a type whose name is computed (`class self::Foo`) or written inside a singleton class have no key to carry them: dropped and counted, their constants still read, their calls not.",
    "An edge comes from the narrowest entity that encloses its site: a method, else the constant whose initializer it is in, else the class or module body, else the file. A class body is code (`has_many :lines`, `attr_reader`), a file's top level too (a Rakefile, a gemspec) — hence the optional `TWithInvocations` / `TWithAccesses` on those kinds, declared when the entity is the source of such an edge. A call is anchored at the line its name is written on, not across the block it is given.",
    "Blind spots, stated: methods no `def` writes (`define_method` with a computed name, `method_missing`, a `class_eval` of a string in a loop, the accessors `delegate`, `def_delegators` and ActiveRecord generate); mixins applied at run time other than through a literal `included` hook; a test framework's DSL (`describe`, `it`, `expect`, `let` — a spec directory is the bulk of what a Rails application leaves unbound); `send`, `public_send`, `const_get`, `constantize` with a computed name; `class_eval` and `instance_eval`; ERB, Haml and Slim templates, which are not Ruby files; a file's top-level DSL (`gem` in a Gemfile, `task` in a Rakefile, `run` in a `config.ru`) — evaluated by a library against its own object, so unbound here. Visibility (`private`, `protected`) is not modelled.",
    "Walked: `*.rb`, `*.rake`, `*.gemspec`, `*.ru`, the extensionless `Rakefile`, `Gemfile`, `Guardfile`, `Capfile`, `Vagrantfile`, `Brewfile`, `Dangerfile`, `Thorfile`, and any other extensionless file whose first line is a `ruby` shebang — under the roots and outside `vendor`, `node_modules`, `tmp` and dot-directories (a root named on the command line is walked whatever it is called). Prism recovers from syntax errors and honours encoding magic comments, so a file with errors is still extracted from the tree the parser recovered, and named on stderr; a name that is not valid UTF-8 is written with U+FFFD and counted.",
    "Comments (`TComment`): the `#` block written directly above a class, a module, a method or a constant, one string, magic comments (`frozen_string_literal`) and tool directives (`rubocop:`) looked through. Measures (`TMetrics`, METAMODEL.md §3.8): `sloc` on the file, every type and every method — lines of its own span that are neither blank nor comment-only, a heredoc's text being code and what follows `__END__` data; `cyclomatic` on methods: 1 + `if`/`elsif`/`unless`/ternary + `while`/`until`/`for` + each `when`/`in` + each `rescue` clause and modifier + `&&`/`||`/`and`/`or`. A block contributes to its enclosing method: it is not an entity.",
    "The metrics pass (`codegraph-metrics`, PLAN.md §18): big-code-analysis's Ruby grammar opens a space per `class`, `module` and `def`, so every file, type and method joins exactly and the join's witness holds — `sloc` equals its `ploc` on each (106 of 106 on the fixture). `Point = Struct.new(…) do … end`, `Handler = Class.new(Base) do … end` and a concern's `class_methods do … end` are blocks to the grammar: no class space of their own, and none of the pass's keys.",
    "`--trace <file>` merges what `extractors/ruby/trace/codegraph_trace.rb` wrote from INSIDE the running program — the one thing the extractor never does is run corpus code, so the trace is a separate step, the user's, in a project that still boots. It names constants, files and lines, never a key: no entity is added and no edge of the source changes. A mixin the VM holds and no line writes is a `traitUsage` with provenance `generated`, anchored on the declaration of the type that has it. A call the program made at a site the baseline left unresolved is ONE `invocation` with provenance `dynamic-candidate`, `candidates` listing every method that site was seen to reach and `to` the first of them — what ran once, not what must run. A method the VM holds on a line that writes no `def` has no entity and gets none: it is counted.",
    "Audited (M18c) on rake 13.2.1, rubygems 3.6.2, Mastodon 4.3.0 and rails 8.0.2 — 100, 794, 2 541 and 3 334 files, every model `validate`-clean, rails in 4.7 s. Resolution rate 77.8 %, 54.4 %, 31.2 % and 57.0 % of the sites; Mastodon without `spec/` is 62.1 % (55 000 of its unbound calls are RSpec's DSL), rails' own `lib` and `app` 59.4 %. Four fifths of what stays unresolved in application code is `untyped-receiver` — the ceiling of any reader that does not run the code. ORACLES: Packwerk 3.3.1's reference extraction and ConstantResolver over Mastodon's autoload paths resolve 4 335 cross-file constant references in `app/` and `lib/`; the model has the same constant in the same file for 4 289 of them (98.9 %) — the 45 others are a `module Admin` WRAPPER, which Packwerk counts as a reference and the wrapper rule does not, and one an inherited constant Packwerk places by file name. The model names 346 more that Packwerk cannot: declarations outside the autoload paths. Run under its own tests in a container, rake's VM holds a method on the same line for 1 006 of the 1 012 methods the model declares in the 83 files it loaded (the six others: definitions under a platform or capability `if`, a `def` inside a method that never ran, methods of anonymous classes), and 200 methods the model has none for — 199 written by the metaprogramming loops of three files (`class_eval` of a string, `define_method` over a list), one the `else` branch of a platform test. Of the 2 829 calls observed during that run, 1 533 are edges the baseline wrote and 879 land on sites it had left untyped. The core-table misreading, measured on rubygems: 39 corpus bodies of 20 VM types (`Gem` alone 12), and 3 802 of 71 197 edges landing on the VM's stub of a type that corpus itself implements.",
  ],

  lexicon: {
    // The Ruby documentation, Keywords: the 41 reserved words, as Ruby spells them.
    keywords: [
      "__ENCODING__", "__LINE__", "__FILE__", "BEGIN", "END", "alias", "and", "begin", "break",
      "case", "class", "def", "defined?", "do", "else", "elsif", "end", "ensure", "false", "for",
      "if", "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry", "return",
      "self", "super", "then", "true", "undef", "unless", "until", "when", "while", "yield",
    ],
    // The constructor and copy hooks, the conversion and comparison protocols, the operator
    // methods, `Enumerable`'s `each`, `method_missing`, and the hooks a module or class receives.
    conventional: [
      "initialize", "initialize_copy", "to_s", "to_str", "to_a", "to_ary", "to_h", "to_hash",
      "to_proc", "inspect", "hash", "eql?", "==", "===", "=~", "!~", "!=", "<=>", "<", ">", "<=",
      ">=", "+", "-", "*", "/", "%", "**", "<<", ">>", "&", "|", "^", "~", "!", "+@", "-@", "[]",
      "[]=", "each", "coerce", "method_missing", "respond_to_missing?", "respond_to?", "included",
      "extended", "inherited", "prepended", "method_added", "const_missing",
    ],
    technical: [
      "accessor", "attr", "concern", "concerns", "ext", "gem", "gemspec", "klass", "lambda",
      "mixin", "proc", "rake", "rakefile",
    ],
    fileKinds: ["file"],
  },
};
