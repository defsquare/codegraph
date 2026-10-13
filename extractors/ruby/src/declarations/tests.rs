use super::*;

fn read(source: &str) -> FileDecls {
    declarations(source.as_bytes())
}

fn dropped(file: &FileDecls, reason: &str) -> usize {
    file.drops.iter().filter(|drop| drop.reason == reason).count()
}

fn path(text: &str) -> ConstPath {
    let absolute = text.starts_with("::");
    ConstPath {
        absolute,
        segments: text.trim_start_matches("::").split("::").map(str::to_owned).collect(),
    }
}

fn named(file: &FileDecls) -> Vec<(String, ScopeKind, bool)> {
    file.scopes
        .iter()
        .filter_map(|s| s.path.as_ref().map(|p| (p.segments.join("::"), s.kind, s.wrapper)))
        .collect()
}

/// The scope a constant path opens.
fn scope<'f>(file: &'f FileDecls, name: &str) -> &'f Scope {
    file.scopes
        .iter()
        .find(|s| s.path.as_ref().is_some_and(|p| p.segments.join("::") == name))
        .unwrap_or_else(|| panic!("no scope {name}"))
}

/// Every call site as `(name, receiver)`, in source order.
fn calls(file: &FileDecls) -> Vec<(&str, &Receiver)> {
    file.sites
        .iter()
        .filter_map(|site| match &site.what {
            What::Call { receiver, name } => Some((name.as_str(), receiver)),
            _ => None,
        })
        .collect()
}

fn call<'f>(file: &'f FileDecls, name: &str) -> &'f Site {
    file.sites
        .iter()
        .find(|site| matches!(&site.what, What::Call { name: called, .. } if called == name))
        .unwrap_or_else(|| panic!("no call to {name}"))
}

fn receiver<'f>(file: &'f FileDecls, name: &str) -> &'f Receiver {
    match &call(file, name).what {
        What::Call { receiver, .. } => receiver,
        _ => unreachable!(),
    }
}

fn constants_read(file: &FileDecls) -> Vec<String> {
    file.sites
        .iter()
        .filter_map(|site| match &site.what {
            What::Constant(path) => Some(path.written()),
            _ => None,
        })
        .collect()
}

// ------------------------------------------------------------ declarations ----

#[test]
fn a_wrapper_body_is_lexical_scope_and_an_empty_body_is_a_declaration() {
    let file = read(
        "module Acme\n  class Order\n    def total; end\n  end\n  class NotFound < StandardError; end\n  module Marker; end\nend\n",
    );
    assert_eq!(
        named(&file),
        vec![
            ("Acme".to_owned(), ScopeKind::Module, true),
            ("Order".to_owned(), ScopeKind::Class, false),
            ("NotFound".to_owned(), ScopeKind::Class, false),
            ("Marker".to_owned(), ScopeKind::Module, false),
        ]
    );
    // Anything of its own makes the body a declaration.
    assert!(!read("module Acme\n  VERSION = '1'\n  class Order; end\nend\n").scopes[1].wrapper);
    assert!(!read("module Acme\n  extend self\n  class Order; end\nend\n").scopes[1].wrapper);
    // A superclass is a statement about the class, whatever its body holds.
    assert!(!read("class Order < Base\n  class Line; end\nend\n").scopes[1].wrapper);
    assert!(read("class Order\n  class Line; end\nend\n").scopes[1].wrapper);
    // `Point = Struct.new(:x)` declares a type as `class Point` does; a value does not.
    assert!(read("module Acme\n  Point = Struct.new(:x)\n  class Order; end\nend\n").scopes[1].wrapper);
    assert!(!read("module Acme\n  LIMIT = 3\n  Point = Struct.new(:x)\nend\n").scopes[1].wrapper);
}

#[test]
fn reads_compact_absolute_and_computed_names() {
    let file = read("class Acme::Order; end\nclass ::Top; end\nclass self::Dynamic; def x; end; end\n");
    assert_eq!(file.scopes[1].path, Some(path("Acme::Order")));
    assert_eq!(file.scopes[2].path, Some(path("::Top")));
    assert_eq!(file.scopes[3].kind, ScopeKind::Opaque);
    assert_eq!(dropped(&file, "computed-type-name"), 1);
    assert_eq!(dropped(&file, "def-in-opaque-body"), 1);
}

#[test]
fn records_lexical_parents_and_spans() {
    let file = read("module A\n  module B\n    class C\n      def x; end\n    end\n  end\nend\n");
    assert_eq!(file.scopes[0].kind, ScopeKind::File);
    assert_eq!(file.scopes[0].span, (1, 7));
    assert_eq!(file.scopes[3].parent, Some(2));
    assert_eq!(file.scopes[2].parent, Some(1));
    assert_eq!(file.scopes[1].parent, Some(0));
    assert_eq!(file.scopes[3].span, (3, 5));
    assert_eq!(file.scopes[3].methods[0].span, (4, 4));
}

#[test]
fn tells_singleton_methods_from_instance_methods() {
    let file = read(
        "class Order\n  def call; end\n  def self.call(*); end\n  class << self\n    def build(...); end\n  end\n  def other.x; end\nend\ndef main; end\n",
    );
    let methods: Vec<(&str, bool)> = file.scopes[1]
        .methods
        .iter()
        .map(|m| (m.name.as_str(), m.singleton))
        .collect();
    assert_eq!(methods, vec![("call", false), ("call", true), ("build", true)]);
    assert_eq!(dropped(&file, "def-on-object"), 1);
    assert_eq!(file.scopes[0].methods[0].name, "main");
    assert!(!file.scopes[0].methods[0].singleton);
}

#[test]
fn writes_a_signature_as_the_method_is_called() {
    let file = read(
        "class Order\n  def total(currency, precision = 2, *rest, last, tax:, rounding: :half_up, **opts, &blk); end\n  def each(*, **, &); end\n  def split((a, b), c); end\n  def forward(...); end\n  def strict(a, **nil); end\n  def self.build(attrs = {}); end\n  def name=(value); end\n  def empty?; end\nend\n",
    );
    let signatures: Vec<&str> = file.scopes[1].methods.iter().map(|m| m.signature.as_str()).collect();
    assert_eq!(
        signatures,
        vec![
            "total(currency, [precision], *rest, last, tax:, [rounding:], **opts, &blk)",
            "each(*, **, &)",
            "split((a, b), c)",
            "forward(...)",
            "strict(a, **nil)",
            "self.build([attrs])",
            "name=(value)",
            "empty?()",
        ]
    );
    let names = |index: usize| -> Vec<Option<&str>> {
        file.scopes[1].methods[index]
            .parameters
            .iter()
            .map(|p| p.name.as_deref())
            .collect()
    };
    assert_eq!(
        names(0),
        vec![
            Some("currency"),
            Some("precision"),
            Some("rest"),
            Some("last"),
            Some("tax"),
            Some("rounding"),
            Some("opts"),
            Some("blk")
        ]
    );
    assert_eq!(names(1), vec![None, None, None]);
    assert_eq!(names(2), vec![None, Some("c")]);
    assert_eq!(names(3), vec![None]);
    // `**nil` is how the method is called, not a parameter.
    assert_eq!(names(4), vec![Some("a")]);
}

#[test]
fn reads_a_default_as_the_value_the_source_writes() {
    let file = read(
        "def f(a, n = 2, big = 1_000, s = 'EUR', mode: :half_up, list: [1, 'x'], flag: true, none: nil, klass: Acme::Money, frozen: 'x'.freeze, call: compute, opts: { a: 1 }, range: 1..3, hex: 0x1F); end\n",
    );
    let defaults: Vec<Option<Lit>> = file.scopes[0].methods[0]
        .parameters
        .iter()
        .map(|p| p.default.clone())
        .collect();
    assert_eq!(
        defaults,
        vec![
            None,
            Some(Lit::Number("2".into())),
            Some(Lit::Number("1000".into())),
            Some(Lit::String("EUR".into())),
            // A symbol, a hash, a range: constant-shaped, kept as text.
            Some(Lit::Unevaluated(":half_up".into())),
            Some(Lit::Array(vec![Lit::Number("1".into()), Lit::String("x".into())])),
            Some(Lit::Boolean(true)),
            Some(Lit::Null),
            Some(Lit::Constant(path("Acme::Money"))),
            Some(Lit::String("x".into())),
            // A call is not a constant expression: no value at all.
            None,
            Some(Lit::Unevaluated("{ a: 1 }".into())),
            Some(Lit::Unevaluated("1..3".into())),
            Some(Lit::Unevaluated("0x1F".into())),
        ]
    );
}

#[test]
fn reads_mixins_from_a_type_body_only_and_says_how_each_is_mixed_in() {
    let file = read(
        "class Order\n  include Comparable, Acme::Priceable\n  extend Forwardable\n  prepend ::Audited\n  extend self\n  include Module.new\n  class << self\n    include Buildable\n    extend Ignored\n  end\n  def patch\n    extend Late\n  end\n  included do\n    include Hidden\n  end\nend\ninclude TopLevel\n",
    );
    let mixins: Vec<(String, MixinKind)> = file.scopes[1]
        .mixins
        .iter()
        .map(|m| (m.reference.path.written(), m.kind))
        .collect();
    assert_eq!(
        mixins,
        vec![
            ("Comparable".to_owned(), MixinKind::Include),
            ("Acme::Priceable".to_owned(), MixinKind::Include),
            ("Forwardable".to_owned(), MixinKind::Extend),
            ("::Audited".to_owned(), MixinKind::Prepend),
            // `include` inside `class << self` is what `extend` says.
            ("Buildable".to_owned(), MixinKind::Extend),
        ]
    );
    assert_eq!(file.scopes[1].mixins[0].reference.span, (2, 2));
    assert!(file.scopes[1].extends_self);
    assert_eq!(dropped(&file, "computed-mixin"), 1);
    assert_eq!(dropped(&file, "toplevel-mixin"), 1);
    // A mixin's constant is the mixin, not also a reference; one written elsewhere is.
    let read = constants_read(&file);
    assert!(!read.contains(&"Comparable".to_owned()));
    assert!(
        read.contains(&"Late".to_owned())
            && read.contains(&"Hidden".to_owned())
            && read.contains(&"TopLevel".to_owned())
    );
}

#[test]
fn reads_requires_wherever_they_are_written_and_folds_the_ruby_1_8_spellings() {
    let file = read(
        "require \"json\"\nrequire_relative 'acme/order'\nKernel.require 'set'\nload 'tasks/x.rb'\nautoload :Money, 'acme/money'\nrequire File.expand_path('../boot', __FILE__)\nrequire File.expand_path('lib/a', __dir__)\nrequire File.join(File.dirname(__FILE__), 'b', 'c')\nrequire File.dirname(__FILE__) + '/d'\nrequire \"#{__dir__}/e\"\nrequire File.join(root, 'x')\nrequire \"a#{b}\"\nloader.require 'not_ours'\ndef lazy\n  require 'late'\nend\n",
    );
    let requires: Vec<(RequireKind, &str, u32)> = file
        .requires
        .iter()
        .map(|r| (r.kind, r.argument.as_str(), r.span.0))
        .collect();
    assert_eq!(
        requires,
        vec![
            (RequireKind::Feature, "json", 1),
            (RequireKind::Relative, "acme/order", 2),
            (RequireKind::Feature, "set", 3),
            (RequireKind::Load, "tasks/x.rb", 4),
            (RequireKind::Feature, "acme/money", 5),
            // Relative to the FILE: the `..` cancels its name.
            (RequireKind::Path, "./__file__/../boot", 6),
            (RequireKind::Path, "./lib/a", 7),
            (RequireKind::Path, "./b/c", 8),
            (RequireKind::Path, "./d", 9),
            (RequireKind::Path, "./e", 10),
            (RequireKind::Feature, "late", 15),
        ]
    );
    assert_eq!(dropped(&file, "computed-require"), 2);
}

#[test]
fn reads_a_superclass_as_a_constant_as_the_language_s_or_as_computed() {
    let file = read(
        "class A < Acme::Base; end\nclass B < Struct.new(:x, :y); end\nclass C < Migration[7.0]; end\nclass D; end\nclass E < Data.define(:lat); end\n",
    );
    assert!(
        matches!(&scope(&file, "A").superclass, Superclass::Constant(r) if r.path == path("Acme::Base") && r.span == (1, 1))
    );
    assert_eq!(scope(&file, "B").superclass, Superclass::Core("Struct", (2, 2)));
    assert_eq!(
        scope(&file, "B").members,
        vec![("x".to_owned(), (2, 2)), ("y".to_owned(), (2, 2))]
    );
    assert_eq!(scope(&file, "C").superclass, Superclass::Computed);
    assert_eq!(scope(&file, "D").superclass, Superclass::None);
    assert_eq!(scope(&file, "E").superclass, Superclass::Core("Data", (5, 5)));
    // `Struct` is the inheritance, not a second reference; what a computed
    // superclass names is read, as the class's own doing.
    assert_eq!(constants_read(&file), vec!["Migration"]);
    assert_eq!(file.sites[0].owner, Owner::Type(3));
}

#[test]
fn a_constant_assigned_a_new_struct_or_class_is_a_type_and_its_block_the_body() {
    let file = read(
        "module Acme\n  Point = Struct.new(:x, :y) do\n    def dist; x; end\n  end\n  Handler = Class.new(Base)\n  Coord = Data.define(:lat)\n  Mixin = Module.new\n  Plain = Class.new\n  LIMIT = 3\nend\n",
    );
    let point = scope(&file, "Point");
    assert_eq!(
        (point.kind, point.wrapper, point.span),
        (ScopeKind::Class, false, (2, 4))
    );
    assert_eq!(point.superclass, Superclass::Core("Struct", (2, 4)));
    assert_eq!(
        point.members.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
        vec!["x", "y"]
    );
    // The block is the class's body: its `def` is the Struct's method.
    assert_eq!(point.methods[0].name, "dist");
    assert!(matches!(&scope(&file, "Handler").superclass, Superclass::Constant(r) if r.path == path("Base")));
    assert_eq!(scope(&file, "Coord").superclass, Superclass::Core("Data", (6, 6)));
    assert_eq!(scope(&file, "Mixin").kind, ScopeKind::Module);
    assert_eq!(scope(&file, "Plain").superclass, Superclass::None);
    // Only a value stays a constant.
    let constants: Vec<String> = scope(&file, "Acme")
        .constants
        .iter()
        .map(|c| c.path.written())
        .collect();
    assert_eq!(constants, vec!["LIMIT"]);
    // Neither `Struct` nor the superclass given to `Class.new` is a second reference.
    assert!(constants_read(&file).is_empty());
}

#[test]
fn records_assigned_constants_with_the_value_the_source_writes() {
    let file = read(
        "module Acme\n  # The release.\n  VERSION = '1.2'\n  LIMIT ||= 3\n  Acme::Config::DEFAULT = {}\n  ROLES = %w[admin guest].freeze\n  NOW = Time.now\nend\n",
    );
    let constants: Vec<(String, Option<Lit>)> = file.scopes[1]
        .constants
        .iter()
        .map(|c| (c.path.written(), c.value.clone()))
        .collect();
    assert_eq!(
        constants,
        vec![
            ("VERSION".to_owned(), Some(Lit::String("1.2".into()))),
            ("LIMIT".to_owned(), Some(Lit::Number("3".into()))),
            ("Acme::Config::DEFAULT".to_owned(), Some(Lit::Unevaluated("{}".into()))),
            (
                "ROLES".to_owned(),
                Some(Lit::Array(vec![
                    Lit::String("admin".into()),
                    Lit::String("guest".into())
                ]))
            ),
            // Computed at load time: no value, and the call is the constant's own.
            ("NOW".to_owned(), None),
        ]
    );
    assert_eq!(file.scopes[1].constants[0].comment.as_deref(), Some("The release."));
    assert_eq!(file.scopes[1].constants[0].span, (3, 3));
    assert_eq!(call(&file, "now").owner, Owner::Constant(1, 4));
}

#[test]
fn reads_attributes_aliases_and_module_functions() {
    let file = read(
        "class Order\n  attr_reader :total, 'note'\n  attr_writer :memo\n  attr_accessor :state\n  attr_reader name\n  alias_method :cost, :total\n  alias amount total\n  class << self\n    attr_accessor :registry\n  end\nend\nmodule Util\n  def before; end\n  module_function\n  def slug; end\n  def self.direct; end\nend\nmodule Named\n  def a; end\n  def b; end\n  module_function :a\nend\n",
    );
    let order = scope(&file, "Order");
    let attrs: Vec<(&str, bool, bool, bool)> = order
        .attrs
        .iter()
        .map(|a| (a.name.as_str(), a.reader, a.writer, a.on_class))
        .collect();
    assert_eq!(
        attrs,
        vec![
            ("total", true, false, false),
            ("note", true, false, false),
            ("memo", false, true, false),
            ("state", true, true, false),
            ("registry", true, true, true),
        ]
    );
    assert_eq!(order.attrs[0].span, (2, 2));
    assert_eq!(dropped(&file, "computed-attribute"), 1);
    let aliases: Vec<(&str, &str)> = order
        .aliases
        .iter()
        .map(|a| (a.new_name.as_str(), a.old_name.as_str()))
        .collect();
    assert_eq!(aliases, vec![("cost", "total"), ("amount", "total")]);
    let functions = |name: &str| -> Vec<(String, bool)> {
        scope(&file, name)
            .methods
            .iter()
            .map(|m| (m.name.clone(), m.module_function))
            .collect()
    };
    // Bare `module_function` applies to what follows it; with names, to those.
    assert_eq!(
        functions("Util"),
        vec![
            ("before".into(), false),
            ("slug".into(), true),
            ("direct".into(), false)
        ]
    );
    assert_eq!(functions("Named"), vec![("a".into(), true), ("b".into(), false)]);
    // None of these is a call the model has to resolve.
    assert!(
        calls(&file).iter().all(|(name, _)| *name == "name"),
        "{:?}",
        calls(&file)
    );
}

#[test]
fn a_define_method_with_a_literal_name_is_a_method_and_a_computed_one_marks_the_type() {
    let file = read(
        "class Order\n  define_method(:total) { |tax, rate = 2| helper(tax) }\n  define_method(\"#{kind}_total\") { 1 }\n  class << self\n    define_method(:build) { new }\n  end\n  def method_missing(name); end\nend\nclass Plain\n  def x; end\nend\n",
    );
    let order = scope(&file, "Order");
    let methods: Vec<(&str, bool, &str)> = order
        .methods
        .iter()
        .map(|m| (m.name.as_str(), m.singleton, m.signature.as_str()))
        .collect();
    assert_eq!(
        methods,
        vec![
            ("total", false, "total(tax, [rate])"),
            ("build", true, "self.build()"),
            ("method_missing", false, "method_missing(name)"),
        ]
    );
    // The block is the method's body: what it calls, the method calls.
    assert_eq!(call(&file, "helper").owner, Owner::Method(1, 0));
    assert!(order.dynamic);
    assert_eq!(dropped(&file, "computed-define-method"), 1);
    assert!(!scope(&file, "Plain").dynamic);
}

// ------------------------------------------------------------------- sites ----

#[test]
fn a_constant_read_is_one_site_for_the_whole_path() {
    let file = read(
        "class Order < Base\n  include Priceable\n  def total\n    Acme::Money.new(::Rate::DEFAULT, Tax)\n  end\nend\n",
    );
    // Not the class's own name, its superclass or its mixin: those are declarations.
    assert_eq!(constants_read(&file), vec!["Acme::Money", "::Rate::DEFAULT", "Tax"]);
    let site = &file
        .sites
        .iter()
        .find(|s| matches!(&s.what, What::Constant(p) if p.written() == "Tax"))
        .unwrap();
    assert_eq!((site.owner, site.scope, site.span), (Owner::Method(1, 0), 1, (4, 4)));
}

#[test]
fn says_what_a_call_is_sent_to() {
    let file = read(
        "class Order\n  def run(param)\n    helper\n    self.explicit\n    self.class.registry\n    Money.zero\n    Money.new(1).cents\n    param.unknown\n    @repo.find\n    @@count.succ\n    'text'.upcase\n    [1].each_item\n    { a: 1 }.fetch_it\n    :sym.to_proc\n    1.day\n    nil.to_a\n    helper.chained\n  end\n  def self.build\n    new.call\n    self.new.other\n  end\nend\n",
    );
    let money = path("Money");
    assert_eq!(receiver(&file, "helper"), &Receiver::ImplicitSelf);
    assert_eq!(receiver(&file, "explicit"), &Receiver::ExplicitSelf);
    assert_eq!(receiver(&file, "registry"), &Receiver::SelfClass);
    assert_eq!(receiver(&file, "zero"), &Receiver::Constant(money.clone()));
    assert_eq!(receiver(&file, "cents"), &Receiver::New(money));
    assert_eq!(receiver(&file, "unknown"), &Receiver::Untyped);
    assert_eq!(receiver(&file, "find"), &Receiver::Variable("@repo".into()));
    assert_eq!(receiver(&file, "succ"), &Receiver::Variable("@@count".into()));
    assert_eq!(receiver(&file, "upcase"), &Receiver::Literal("String"));
    assert_eq!(receiver(&file, "each_item"), &Receiver::Literal("Array"));
    assert_eq!(receiver(&file, "fetch_it"), &Receiver::Literal("Hash"));
    assert_eq!(receiver(&file, "to_proc"), &Receiver::Literal("Symbol"));
    assert_eq!(receiver(&file, "day"), &Receiver::Literal("Integer"));
    assert_eq!(receiver(&file, "to_a"), &Receiver::Literal("NilClass"));
    // The result of a call has no type the source states.
    assert_eq!(receiver(&file, "chained"), &Receiver::Untyped);
    // `new` where `self` is the class builds that class.
    assert_eq!(receiver(&file, "call"), &Receiver::NewSelf);
    assert_eq!(receiver(&file, "other"), &Receiver::NewSelf);
    // `self` is an instance in `run`, the class in `self.build`.
    assert!(!call(&file, "helper").on_class);
    assert!(call(&file, "other").on_class);
}

#[test]
fn types_a_local_by_what_its_body_assigns_and_only_then() {
    let file = read(
        "def run(given)\n  typed = Repo.new\n  typed.find\n  twice = Repo.new\n  twice = Repo.new(1)\n  twice.both\n  mixed = Repo.new\n  mixed = other\n  mixed.lost\n  given.param\n  early = Repo.new\n  early.first_use\n  early = something\n  [1].each do |item|\n    inner = Job.new(item)\n    inner.run\n    item.block_param\n  end\n  a, b = pair\n  a.multi\n  memo ||= Cache.new\n  memo.fetch\nend\n",
    );
    let repo = Receiver::TypedLocal(path("Repo"));
    assert_eq!(receiver(&file, "find"), &repo);
    assert_eq!(receiver(&file, "both"), &repo);
    // Assigned something else once: nothing is known.
    assert_eq!(receiver(&file, "lost"), &Receiver::Untyped);
    // A parameter is whatever the caller passes.
    assert_eq!(receiver(&file, "param"), &Receiver::Untyped);
    // Every assignment in the body counts, wherever it is written: the model is
    // flow-insensitive, so one reassignment untypes the use above it too.
    assert_eq!(receiver(&file, "first_use"), &Receiver::Untyped);
    // A block shares its body's locals; its own parameters type nothing.
    assert_eq!(receiver(&file, "run"), &Receiver::TypedLocal(path("Job")));
    assert_eq!(receiver(&file, "block_param"), &Receiver::Untyped);
    assert_eq!(receiver(&file, "multi"), &Receiver::Untyped);
    assert_eq!(receiver(&file, "fetch"), &Receiver::TypedLocal(path("Cache")));
}

#[test]
fn a_local_does_not_leak_out_of_the_body_that_assigns_it() {
    let file = read("x = Repo.new\ndef a\n  x.in_def\nend\nclass K\n  x.in_class\nend\nx.at_top\n");
    // `x` inside a `def` or a class body is not the file's `x` (it is not even a local there).
    assert_eq!(receiver(&file, "in_def"), &Receiver::Untyped);
    assert_eq!(receiver(&file, "in_class"), &Receiver::Untyped);
    assert_eq!(receiver(&file, "at_top"), &Receiver::TypedLocal(path("Repo")));
}

#[test]
fn says_who_a_site_belongs_to() {
    let file = read(
        "boot\nclass Order\n  has_many :lines\n  LIMIT = compute\n  def total(rate = default_rate)\n    sum { |l| l.price }\n  end\n  def self.build\n    make\n  end\n  class << self\n    def other; again; end\n  end\nend\n",
    );
    let owner = |name: &str| (call(&file, name).owner, call(&file, name).on_class);
    assert_eq!(owner("boot"), (Owner::File, false));
    // A class body is code: `self` is the class.
    assert_eq!(owner("has_many"), (Owner::Type(1), true));
    assert_eq!(owner("compute"), (Owner::Constant(1, 0), true));
    // A default is evaluated in the method; a block belongs to what encloses it.
    assert_eq!(owner("default_rate"), (Owner::Method(1, 0), false));
    assert_eq!(owner("price"), (Owner::Method(1, 0), false));
    assert_eq!(owner("make"), (Owner::Method(1, 1), true));
    assert_eq!(owner("again"), (Owner::Method(1, 2), true));
}

#[test]
fn reads_instance_and_class_variables_with_how_they_are_used() {
    let file = read(
        "class Order\n  @registry = {}\n  def initialize(repo)\n    @repo = Repo.new\n    @given = repo\n    @count += 1\n    @cache ||= Cache.new\n    @a, @b = pair\n    @@total = 0\n    @repo\n  end\nend\n",
    );
    let variables: Vec<(&str, bool, bool, Option<Assigned>, bool)> = file
        .sites
        .iter()
        .filter_map(|site| match &site.what {
            What::Variable {
                name,
                read,
                write,
                assigned,
            } => Some((name.as_str(), *read, *write, assigned.clone(), site.on_class)),
            _ => None,
        })
        .collect();
    assert_eq!(
        variables,
        vec![
            // In the class body, `@registry` is the class's own variable.
            ("@registry", false, true, Some(Assigned::Other), true),
            ("@repo", false, true, Some(Assigned::New(path("Repo"))), false),
            ("@given", false, true, Some(Assigned::Other), false),
            ("@count", true, true, Some(Assigned::Other), false),
            // The memoization idiom types the variable as a plain write does.
            ("@cache", true, true, Some(Assigned::New(path("Cache"))), false),
            ("@a", false, true, Some(Assigned::Other), false),
            ("@b", false, true, Some(Assigned::Other), false),
            ("@@total", false, true, Some(Assigned::Other), false),
            ("@repo", true, false, None, false),
        ]
    );
}

#[test]
fn reads_what_is_raised() {
    let file = read(
        "def run(error)\n  raise NotFound\n  raise Acme::TooMany, 'msg'\n  raise Invalid.new(1)\n  raise 'text'\n  fail \"interpolated #{x}\"\n  raise error\n  raise\nend\n",
    );
    let raised: Vec<Option<String>> = file
        .sites
        .iter()
        .filter_map(|site| match &site.what {
            What::Raise(path) => Some(path.as_ref().map(ConstPath::written)),
            _ => None,
        })
        .collect();
    assert_eq!(
        raised,
        vec![
            Some("NotFound".into()),
            Some("Acme::TooMany".into()),
            Some("Invalid".into()),
            None,
            None
        ]
    );
    // `raise error` re-raises a value whose class the source does not say.
    assert_eq!(dropped(&file, "raise-of-a-value"), 1);
}

#[test]
fn reads_super_a_method_taken_as_a_value_and_a_literal_send() {
    let file = read(
        "class Order < Base\n  def total(x)\n    super\n    super(x)\n    method(:helper)\n    send(:hidden, 1)\n    public_send(name)\n    Money.public_send(:zero)\n  end\nend\n",
    );
    assert_eq!(file.sites.iter().filter(|site| site.what == What::Super).count(), 2);
    assert!(file.sites.iter().any(|site| site.what
        == What::MethodRef {
            receiver: Receiver::ImplicitSelf,
            name: "helper".into()
        }));
    // A literal name is a call like any other; a computed one is counted.
    assert_eq!(receiver(&file, "hidden"), &Receiver::ImplicitSelf);
    assert_eq!(receiver(&file, "zero"), &Receiver::Constant(path("Money")));
    assert_eq!(dropped(&file, "dynamic-dispatch"), 1);
}

#[test]
fn anchors_a_call_where_its_name_is_written() {
    let file = read("orders\n  .select { |o|\n    o.open?\n  }\n  .map(&:total)\n@repo =\n  Repo.new\n");
    assert_eq!(call(&file, "orders").span, (1, 1));
    assert_eq!(call(&file, "select").span, (2, 2));
    assert_eq!(call(&file, "map").span, (5, 5));
    // A variable is anchored at its name, not across what is assigned to it.
    let variable = file
        .sites
        .iter()
        .find(|site| matches!(site.what, What::Variable { .. }))
        .unwrap();
    assert_eq!(variable.span, (6, 6));
}

#[test]
fn a_body_whose_self_no_key_names_keeps_its_constants_and_drops_its_calls() {
    let file = read(
        "class Order\n  def other.x\n    helper\n    @state = 1\n    Money.zero\n  end\n  class << registry\n    def y; again; end\n  end\nend\n",
    );
    assert_eq!(constants_read(&file), vec!["Money"]);
    // `other` and `registry` are evaluated in the class body, which is keyed.
    assert_eq!(
        calls(&file).iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        vec!["other", "registry"]
    );
    assert!(!file.sites.iter().any(|site| matches!(site.what, What::Variable { .. })));
    assert_eq!(dropped(&file, "call-in-unkeyed-body"), 3);
}

// -------------------------------------------------- comments and measures ----

#[test]
fn attaches_the_comment_block_written_directly_above() {
    let file = read(
        "# frozen_string_literal: true\n\n# An order.\n#\n# Lines and a total.\nclass Order\n  # Sums the lines.\n  # rubocop:disable Metrics/AbcSize\n  def total; end\n\n  # Not attached: a blank line follows.\n\n  def other; end\n  def bare; end # trailing\nend\n",
    );
    let order = scope(&file, "Order");
    assert_eq!(order.comment.as_deref(), Some("An order.\n\nLines and a total."));
    // A directive between the comment and the `def` is looked through.
    assert_eq!(order.methods[0].comment.as_deref(), Some("Sums the lines."));
    assert_eq!(order.methods[1].comment, None);
    assert_eq!(order.methods[2].comment, None);
    // A magic comment alone is not documentation.
    assert_eq!(
        read("# frozen_string_literal: true\nclass A; end\n").scopes[1].comment,
        None
    );
}

#[test]
fn counts_the_branches_a_method_writes() {
    let file = read(
        "class Order\n  def plain; 1; end\n  def branchy(x)\n    return 0 if x.nil?\n    y = x > 1 ? 2 : 3\n    while y > 0 && x\n      y -= 1\n    end\n    case x\n    when 1 then 1\n    when 2 then 2\n    else 3\n    end\n    [x].each { |i| puts i unless i }\n    begin\n      risky\n    rescue A\n      1\n    rescue B, C\n      2\n    end\n    a || b\n  end\n  def modifier; risky rescue nil; end\nend\n",
    );
    let cyclomatic: Vec<(&str, u32)> = file.scopes[1]
        .methods
        .iter()
        .map(|m| (m.name.as_str(), m.cyclomatic))
        .collect();
    // branchy: 1 + if + ternary + while + && + when + when + unless (in the block) + rescue + rescue + ||
    assert_eq!(cyclomatic, vec![("plain", 1), ("branchy", 11), ("modifier", 2)]);
}

#[test]
fn counts_the_lines_that_are_code() {
    let source = "# frozen_string_literal: true\n\nclass Order\n  # A comment.\n  TEXT = <<~EOS\n    # not a comment: heredoc text\n\n    line\n  EOS\n  def total # trailing\n    1\n  end\n=begin\nblock comment\n=end\nend\n__END__\ndata here\n";
    let file = read(source);
    // Whole file: class, TEXT, two heredoc lines, EOS, def, 1, end, end = 9.
    assert_eq!(file.sloc((1, 18)), 9);
    assert_eq!(file.sloc(file.scopes[1].methods[0].span), 3);
    // A blank line inside a heredoc is blank; `__END__` and after is data.
    assert_eq!(file.sloc((5, 9)), 4);
    assert_eq!(file.sloc((17, 18)), 0);
}

#[test]
fn extracts_from_the_tree_prism_recovered() {
    // A missing `end`: Prism reports it and still hands back the class.
    let file = read("class Order\n  def total\n    1\n  end\n\nclass Line; end\n");
    assert!(file.errors > 0);
    assert!(named(&file).iter().any(|(name, _, _)| name == "Order"));
}

#[test]
fn keeps_line_numbers_and_values_under_crlf() {
    let lf = read("class A\n  X = { a: 1,\n        b: 2 }\n  def x; end\nend\n");
    let crlf = read("class A\r\n  X = { a: 1,\r\n        b: 2 }\r\n  def x; end\r\nend\r\n");
    assert_eq!(lf.scopes[1].span, crlf.scopes[1].span);
    assert_eq!(lf.scopes[1].methods[0].span, crlf.scopes[1].methods[0].span);
    // A value's text is the same bytes whatever the line endings.
    assert_eq!(
        lf.scopes[1].constants[0].value,
        Some(Lit::Unevaluated("{ a: 1, b: 2 }".into()))
    );
    assert_eq!(lf.scopes[1].constants[0].value, crlf.scopes[1].constants[0].value);
    assert_eq!(lf.code_lines, crlf.code_lines);
}

#[test]
fn tells_an_operator_from_a_named_method() {
    for operator in ["+", "==", "[]", "[]=", "!", "<=>", "=~", "<<", "-@"] {
        assert!(is_operator(operator), "{operator}");
    }
    for named in ["total", "empty?", "save!", "name=", "_private", "été"] {
        assert!(!is_operator(named), "{named}");
    }
}
