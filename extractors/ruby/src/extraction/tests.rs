use super::*;
use crate::corpus::{SourceFile, line_count};

fn extraction(files: &[(&str, &str)]) -> Extraction {
    traced(files, None)
}

/// The same corpus, with what a running program said of it.
fn traced(files: &[(&str, &str)], trace: Option<&str>) -> Extraction {
    let trace = trace.map(|records| {
        let header = r#"{"t":"header","tool":"codegraph-trace","version":"0.1.0","ruby":"3.4.11","root":"/work"}"#;
        crate::trace::parse(&format!("{header}\n{records}")).expect("a trace")
    });
    let mut files: Vec<SourceFile> = files
        .iter()
        .map(|(rel, source)| SourceFile {
            rel: (*rel).to_owned(),
            source: source.as_bytes().to_vec(),
            lines: line_count(source.as_bytes()),
        })
        .collect();
    files.sort_by(|a, b| crate::model::utf16_cmp(&a.rel, &b.rel));
    let corpus = Corpus {
        root_display: "src".to_owned(),
        files,
    };
    extract(&corpus, None, true, trace.as_ref(), &mut |_, _| {})
}

/// One file, `a.rb`.
fn one(source: &str) -> Extraction {
    extraction(&[("a.rb", source)])
}

fn ids_of(extraction: &Extraction) -> Vec<String> {
    let mut ids: Vec<String> = extraction.model.entities.iter().map(|e| e.key.render()).collect();
    ids.sort();
    ids
}

/// Every edge of a kind as `(from, to, provenance, line)`, sorted.
fn edges_of(extraction: &Extraction, kind: &str) -> Vec<(String, String, &'static str, u32)> {
    let mut edges: Vec<_> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == kind)
        .map(|e| (e.from.render(), e.to.render(), e.provenance, e.anchor.start))
        .collect();
    edges.sort();
    edges
}

/// The edges of a kind leaving one entity, as `(to, provenance, line)`, in source order.
fn from(extraction: &Extraction, kind: &str, from: &str) -> Vec<(String, &'static str, u32)> {
    let mut edges: Vec<_> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == kind && e.from.render() == from)
        .map(|e| (e.to.render(), e.provenance, e.anchor.start))
        .collect();
    edges.sort_by(|a, b| (a.2, &a.0).cmp(&(b.2, &b.0)));
    edges
}

fn entity<'a>(extraction: &'a Extraction, id: &str) -> &'a Entity {
    extraction
        .model
        .entities
        .iter()
        .find(|e| e.key.render() == id)
        .unwrap_or_else(|| panic!("no entity {id}"))
}

fn edge<'a>(extraction: &'a Extraction, kind: &str, from: &str, to: &str) -> &'a Edge {
    extraction
        .model
        .edges
        .iter()
        .find(|e| e.kind == kind && e.from.render() == from && e.to.render() == to)
        .unwrap_or_else(|| panic!("no {kind} edge {from} -> {to}"))
}

fn key(id: &str) -> Key {
    let rest = id.strip_prefix("rb:").expect("an rb id");
    let (rest, d) = match rest.split_once('#') {
        Some((rest, d)) => (rest, Some(d.to_owned())),
        None => (rest, None),
    };
    let (module, symbol) = rest.split_once('/').unwrap_or((rest, ""));
    Key {
        module: module.to_owned(),
        symbol: symbol.to_owned(),
        d,
    }
}

fn dropped(extraction: &Extraction, reason: &str) -> u64 {
    extraction.stats.dropped.get(reason).copied().unwrap_or(0)
}

// ---------------------------------------------------------------- skeleton ----

#[test]
fn normalizes_paths_and_measures_nearness() {
    assert_eq!(normalize("lib/acme/../acme/./order"), "lib/acme/order");
    assert_eq!(normalize("/order"), "order");
    assert_eq!(normalize("lib/../../shared/x"), "../shared/x");
    assert_eq!(shared_directories("gems/a/lib/x.rb", "gems/a/lib/util.rb"), 3);
    assert_eq!(shared_directories("gems/a/lib/x.rb", "gems/b/lib/util.rb"), 1);
    assert_eq!(shared_directories("x.rb", "lib/util.rb"), 0);
}

#[test]
fn both_spellings_of_a_nested_class_yield_the_same_key_and_no_namespace_entity() {
    let nested = one("module Acme\n  class Order\n    def total; end\n  end\nend\n");
    let compact = one("class Acme::Order\n  def total; end\nend\n");
    assert_eq!(
        ids_of(&nested),
        vec!["rb:a.rb", "rb:a.rb/Acme::Order", "rb:a.rb/Acme::Order.total"]
    );
    assert_eq!(ids_of(&nested), ids_of(&compact));
    // Written inside a wrapper, the class is a child of the file.
    assert_eq!(
        entity(&nested, "rb:a.rb/Acme::Order").parent,
        Some(ids::file_key("a.rb"))
    );
}

#[test]
fn a_type_written_inside_a_declared_type_is_its_child() {
    let run = one("class Order < Base\n  class Line\n    def qty; end\n  end\nend\n");
    assert_eq!(entity(&run, "rb:a.rb/Order::Line").parent, Some(key("rb:a.rb/Order")));
    assert_eq!(entity(&run, "rb:a.rb/Order::Line.qty").kind, "method");
}

#[test]
fn a_reopening_is_one_entity_per_file_attached_to_the_primary_declaration() {
    let run = extraction(&[
        ("a_patch.rb", "class Order\n  def extra; end\nend\n"),
        (
            "order.rb",
            "class Order < Base\n  def total; end\nend\nclass Order\n  def again; end\nend\n",
        ),
        ("string.rb", "class String\n  def blank?; end\nend\n"),
    ]);
    // `a_patch.rb` sorts first, and the body that writes a superclass is still the primary.
    assert_eq!(
        entity(&run, "rb:a_patch.rb/Order").attached_to,
        Some(key("rb:order.rb/Order"))
    );
    assert!(entity(&run, "rb:a_patch.rb/Order").traits.contains(&"TAttachedTo"));
    assert_eq!(entity(&run, "rb:order.rb/Order").attached_to, None);
    // Two bodies in one file: one entity, anchored at the first, holding both methods.
    assert_eq!(
        entity(&run, "rb:order.rb/Order")
            .anchor
            .as_ref()
            .map(|a| (a.start, a.end)),
        Some((1, 3))
    );
    assert!(ids_of(&run).contains(&"rb:order.rb/Order.again".to_owned()));
    // A corpus body of a core class is attached to the VM's, which is a stub.
    let string = entity(&run, "rb:string.rb/String");
    assert_eq!(string.is_stub, Some(false));
    assert_eq!(string.attached_to, Some(key("rb:<ruby>/String")));
    assert_eq!(entity(&run, "rb:<ruby>/String").is_stub, Some(true));
}

#[test]
fn stubs_what_the_corpus_does_not_declare_by_who_defines_it() {
    let run = one(
        "class NotFound < StandardError; end\nclass Record < ActiveRecord::Base\n  include Comparable\n  include ActiveModel::Validations\n  extend Forwardable\nend\n",
    );
    assert_eq!(
        edges_of(&run, "inheritance"),
        vec![
            (
                "rb:a.rb/NotFound".to_owned(),
                "rb:<ruby>/StandardError".to_owned(),
                "declared",
                1
            ),
            (
                "rb:a.rb/Record".to_owned(),
                "rb:<gems>/ActiveRecord::Base".to_owned(),
                "declared",
                2
            ),
        ]
    );
    assert_eq!(
        edges_of(&run, "traitUsage"),
        vec![
            (
                "rb:a.rb/Record".to_owned(),
                "rb:<gems>/ActiveModel::Validations".to_owned(),
                "declared",
                4
            ),
            (
                "rb:a.rb/Record".to_owned(),
                "rb:<gems>/Forwardable".to_owned(),
                "declared",
                5
            ),
            (
                "rb:a.rb/Record".to_owned(),
                "rb:<ruby>/Comparable".to_owned(),
                "declared",
                3
            ),
        ]
    );
    // The VM's kind comes from the table; a library's from how the site uses it.
    assert_eq!(entity(&run, "rb:<ruby>/StandardError").kind, "class");
    assert_eq!(entity(&run, "rb:<ruby>/Comparable").kind, "module");
    assert_eq!(entity(&run, "rb:<gems>/ActiveRecord::Base").kind, "class");
    assert_eq!(entity(&run, "rb:<gems>/ActiveModel::Validations").kind, "module");
    let stub = entity(&run, "rb:<gems>/ActiveRecord::Base");
    assert_eq!(stub.parent, Some(ids::reserved_key(ids::GEMS)));
    assert_eq!(stub.anchor, None);
    assert_eq!(entity(&run, "rb:<gems>").defined_in, Some(vec![]));
}

#[test]
fn a_reserved_module_exists_only_when_something_points_below_it() {
    let run = one("class Order\n  def total; end\nend\n");
    assert!(!ids_of(&run).iter().any(|id| id.starts_with("rb:<")));
}

#[test]
fn resolves_requires_by_path_by_load_root_and_else_stubs_the_feature() {
    let run = extraction(&[
        (
            "lib/acme.rb",
            "require \"bigdecimal\"\nrequire \"net/http.rb\"\nrequire_relative \"acme/order\"\nrequire \"acme/money\"\nrequire_relative \"acme/missing\"\nrequire \"./config/boot\"\n",
        ),
        (
            "lib/acme/order.rb",
            "require_relative '../acme'\nrequire File.expand_path('../money', __FILE__)\n",
        ),
        (
            "lib/acme/money.rb",
            "require 'acme/money'\nrequire File.join(File.dirname(__FILE__), 'order')\n",
        ),
        ("config/boot.rb", ""),
    ]);
    assert_eq!(
        edges_of(&run, "import"),
        vec![
            (
                "rb:lib%2Facme%2Fmoney.rb".to_owned(),
                "rb:lib%2Facme%2Forder.rb".to_owned(),
                "declared",
                2
            ),
            (
                "rb:lib%2Facme%2Forder.rb".to_owned(),
                "rb:lib%2Facme%2Fmoney.rb".to_owned(),
                "declared",
                2
            ),
            (
                "rb:lib%2Facme%2Forder.rb".to_owned(),
                "rb:lib%2Facme.rb".to_owned(),
                "declared",
                1
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:<gems>%2Fbigdecimal".to_owned(),
                "declared",
                1
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:<gems>%2Fnet%2Fhttp".to_owned(),
                "declared",
                2
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:config%2Fboot.rb".to_owned(),
                "declared",
                6
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:lib%2Facme%2Fmissing.rb".to_owned(),
                "declared",
                5
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:lib%2Facme%2Fmoney.rb".to_owned(),
                "declared",
                4
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:lib%2Facme%2Forder.rb".to_owned(),
                "declared",
                3
            ),
        ]
    );
    // A feature and a missing path are stub modules named as written.
    let feature = entity(&run, "rb:<gems>%2Fnet%2Fhttp");
    assert_eq!(
        (feature.kind, feature.name.as_deref(), feature.is_stub),
        ("file", Some("net/http"), Some(true))
    );
    let missing = entity(&run, "rb:lib%2Facme%2Fmissing.rb");
    assert_eq!(
        (missing.name.as_deref(), missing.is_stub),
        (Some("lib/acme/missing.rb"), Some(true))
    );
    assert_eq!(missing.defined_in, Some(vec![]));
    // A file requiring itself is no edge.
    assert_eq!(run.stats.self_edges, 1);
    assert_eq!(run.stats.imports_by_load_path, 2);
    assert_eq!(run.stats.imports_unresolved, 3);
}

#[test]
fn a_standard_library_name_never_resolves_to_a_corpus_file_off_a_load_root() {
    // `lib/acme/logger.rb` answers `require "acme/logger"`, not `require "logger"`.
    let run = extraction(&[
        ("lib/acme/logger.rb", ""),
        ("lib/acme.rb", "require 'logger'\nrequire 'acme/logger'\n"),
    ]);
    assert_eq!(
        edges_of(&run, "import"),
        vec![
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:<gems>%2Flogger".to_owned(),
                "declared",
                1
            ),
            (
                "rb:lib%2Facme.rb".to_owned(),
                "rb:lib%2Facme%2Flogger.rb".to_owned(),
                "declared",
                2
            ),
        ]
    );
}

#[test]
fn takes_the_nearest_load_root_and_drops_a_tie() {
    let run = extraction(&[
        ("gems/a/lib/a.rb", "require 'util'\n"),
        ("gems/a/lib/util.rb", ""),
        ("gems/b/lib/util.rb", ""),
        ("script.rb", "require 'util'\n"),
    ]);
    assert_eq!(
        edges_of(&run, "import"),
        vec![(
            "rb:gems%2Fa%2Flib%2Fa.rb".to_owned(),
            "rb:gems%2Fa%2Flib%2Futil.rb".to_owned(),
            "declared",
            1
        )]
    );
    assert_eq!(dropped(&run, "ambiguous-require"), 1);
}

#[test]
fn a_constant_declared_in_another_file_is_a_derived_import_unless_required() {
    let run = extraction(&[
        (
            "app/models/order.rb",
            "class Order < ApplicationRecord\n  include Priceable\n  include Priceable\nend\n",
        ),
        (
            "app/models/application_record.rb",
            "class ApplicationRecord\n  def save; end\nend\n",
        ),
        (
            "app/models/concerns/priceable.rb",
            "module Priceable\n  def price; end\nend\n",
        ),
        (
            "lib/report.rb",
            "require_relative '../app/models/order'\nclass Report < Order; end\n",
        ),
        ("lib/limits.rb", "LIMITS = [1]\n"),
        (
            "lib/use.rb",
            "class Use\n  def go\n    Report.new\n    LIMITS\n  end\nend\n",
        ),
    ]);
    assert_eq!(
        edges_of(&run, "import"),
        vec![
            // One per (file, target file), at the first site — and the two `include`s are one.
            (
                "rb:app%2Fmodels%2Forder.rb".to_owned(),
                "rb:app%2Fmodels%2Fapplication_record.rb".to_owned(),
                "derived",
                1
            ),
            (
                "rb:app%2Fmodels%2Forder.rb".to_owned(),
                "rb:app%2Fmodels%2Fconcerns%2Fpriceable.rb".to_owned(),
                "derived",
                2
            ),
            // The file already requires its target: the written fact is the only edge.
            (
                "rb:lib%2Freport.rb".to_owned(),
                "rb:app%2Fmodels%2Forder.rb".to_owned(),
                "declared",
                1
            ),
            // A constant read in a method body is a load too — a type or a value.
            (
                "rb:lib%2Fuse.rb".to_owned(),
                "rb:lib%2Flimits.rb".to_owned(),
                "derived",
                4
            ),
            (
                "rb:lib%2Fuse.rb".to_owned(),
                "rb:lib%2Freport.rb".to_owned(),
                "derived",
                3
            ),
        ]
    );
    assert_eq!(run.stats.imports_derived, 4);
}

#[test]
fn keys_parameters_by_name_and_by_ordinal_when_there_is_none_or_it_repeats() {
    let run = one("class Order\n  def each(first, *, _, _, &blk); end\n  def self.call(*); end\nend\n");
    let each = entity(&run, "rb:a.rb/Order.each");
    let keys: Vec<String> = each.parameters.as_ref().unwrap().iter().map(Key::render).collect();
    assert_eq!(
        keys,
        vec![
            "rb:a.rb/Order.each#param:first",
            "rb:a.rb/Order.each#param:2",
            "rb:a.rb/Order.each#param:_",
            "rb:a.rb/Order.each#param:4",
            "rb:a.rb/Order.each#param:blk",
        ]
    );
    assert_eq!(each.signature.as_deref(), Some("each(first, *, _, _, &blk)"));
    // A repeated name keeps its name; only its key falls back to the ordinal.
    assert_eq!(entity(&run, "rb:a.rb/Order.each#param:4").name.as_deref(), Some("_"));
    let anonymous = entity(&run, "rb:a.rb/Order.call#self#param:1");
    assert_eq!(anonymous.name, None);
    assert_eq!(anonymous.traits, vec!["TStructural", "TChildOf", "TSourceAnchor"]);
    assert_eq!(
        entity(&run, "rb:a.rb/Order.call#self").signature.as_deref(),
        Some("self.call(*)")
    );
}

#[test]
fn a_method_written_twice_is_one_entity_and_a_top_level_def_belongs_to_its_file() {
    let run = extraction(&[("bin/tool.rb", "def main(argv); end\ndef main; end\n")]);
    assert_eq!(
        ids_of(&run),
        vec![
            "rb:bin%2Ftool.rb",
            "rb:bin%2Ftool.rb/main",
            "rb:bin%2Ftool.rb/main#param:argv"
        ]
    );
    assert_eq!(
        entity(&run, "rb:bin%2Ftool.rb/main").parent,
        Some(ids::file_key("bin/tool.rb"))
    );
    assert_eq!(dropped(&run, "redefined-method"), 1);
}

#[test]
fn drops_and_counts_what_names_no_type() {
    let run = one(
        "module Acme\n  class Order; def x; end; end\nend\nclass Money < compute(1); end\nclass Odd < Acme; end\nclass Args\n  include ARGV\nend\nLIMITS = [1]\nclass Capped < LIMITS; end\n",
    );
    assert!(edges_of(&run, "inheritance").is_empty());
    assert!(edges_of(&run, "traitUsage").is_empty());
    assert_eq!(dropped(&run, "computed-superclass"), 1);
    // `Acme` is a namespace no file gives a body to; `ARGV` and `LIMITS` are values.
    assert_eq!(dropped(&run, "not-a-type"), 3);
    // A constant the corpus assigns is KNOWN: never a stub below <gems>.
    assert!(!ids_of(&run).iter().any(|id| id.starts_with("rb:<gems>")));
}

#[test]
fn a_namespace_whose_body_is_elsewhere_is_a_library() {
    // No file gives `Rails`, `Chewy` or `Legacy::Base` a body, and each one's
    // body must exist: `env` and `strategy` are answered by no bare module,
    // and a class cannot inherit from a path nothing opens. `Admin` is only
    // ever a prefix, and `name` is what any module answers.
    let run = extraction(&[
        (
            "lib/boot.rb",
            "class Boot\n  def run\n    Rails.env\n    Rails\n    Admin.name\n    Admin\n    Chewy.strategy\n  end\nend\n",
        ),
        (
            "lib/patches.rb",
            "class Rails::Patch; def x; end; end\nclass Admin::Users; def y; end; end\nclass Legacy::Base::Child < Legacy::Base; def z; end; end\nmodule Chewy\n  class Strategy; def a; end; end\nend\n",
        ),
    ]);
    let run_method = "rb:lib%2Fboot.rb/Boot.run";
    assert_eq!(
        from(&run, "invocation", run_method),
        vec![
            ("rb:<gems>/Rails".to_owned(), "declared", 3),
            ("rb:<gems>/Chewy".to_owned(), "declared", 7),
        ]
    );
    assert_eq!(
        from(&run, "reference", run_method),
        vec![
            ("rb:<gems>/Rails".to_owned(), "declared", 3),
            ("rb:<gems>/Rails".to_owned(), "declared", 4),
            ("rb:<gems>/Chewy".to_owned(), "declared", 7),
        ]
    );
    assert_eq!(
        edges_of(&run, "inheritance"),
        vec![(
            "rb:lib%2Fpatches.rb/Legacy::Base::Child".to_owned(),
            "rb:<gems>/Legacy::Base".to_owned(),
            "declared",
            3
        )]
    );
    assert_eq!(entity(&run, "rb:<gems>/Legacy::Base").kind, "class");
    // What the corpus opens under a library's namespace stays the corpus's.
    let ids = ids_of(&run);
    assert!(ids.contains(&"rb:lib%2Fpatches.rb/Rails::Patch".to_owned()));
    assert!(ids.contains(&"rb:lib%2Fpatches.rb/Chewy::Strategy".to_owned()));
    // Nothing says `Admin` has a body anywhere: still a namespace, never a stub.
    assert!(!ids.contains(&"rb:<gems>/Admin".to_owned()));
    assert_eq!(dropped(&run, "namespace-only"), 2);
}

#[test]
fn a_compact_declaration_reads_the_namespace_it_is_written_under() {
    // `class Admin::Users` evaluates `Admin` — in a Zeitwerk application that
    // read is what loads app/models/admin.rb. A namespace no file gives a body
    // to (`Api::V1`) is nothing the model can point at, and no drop either.
    let run = extraction(&[
        ("app/models/admin.rb", "module Admin\n  def self.prefix; end\nend\n"),
        (
            "app/controllers/users.rb",
            "class Admin::Users\n  def index; end\nend\nclass Api::V1::Tokens\n  def show; end\nend\nmodule Rails::Hooks\n  def self.go\n    Rails.env\n  end\nend\n",
        ),
    ]);
    let file = "rb:app%2Fcontrollers%2Fusers.rb";
    assert_eq!(
        from(&run, "reference", &format!("{file}/Admin::Users")),
        vec![("rb:app%2Fmodels%2Fadmin.rb/Admin".to_owned(), "declared", 1)]
    );
    assert_eq!(
        from(&run, "reference", &format!("{file}/Rails::Hooks")),
        vec![("rb:<gems>/Rails".to_owned(), "declared", 7)]
    );
    assert!(from(&run, "reference", &format!("{file}/Api::V1::Tokens")).is_empty());
    assert_eq!(dropped(&run, "namespace-only"), 0);
    // Nothing requires admin.rb: the read is the import.
    assert_eq!(
        from(&run, "import", file),
        vec![("rb:app%2Fmodels%2Fadmin.rb".to_owned(), "derived", 1)]
    );
}

#[test]
fn a_constant_qualified_by_a_class_is_the_ancestor_s_that_declares_it() {
    let run = one(
        "class Base\n  LIMIT = 3\nend\nclass Child < Base; def y; end; end\nclass User\n  def go\n    Child::LIMIT.size\n  end\nend\n",
    );
    // Never a library's `Child::LIMIT`: the constant is Base's, read through Child.
    assert!(!ids_of(&run).iter().any(|id| id.starts_with("rb:<gems>")));
    assert_eq!(
        from(&run, "access", "rb:a.rb/User.go"),
        vec![("rb:a.rb/Base::LIMIT".to_owned(), "declared", 7)]
    );
}

// ------------------------------------------------------ constants and fields ----

#[test]
fn a_value_constant_is_an_entity_with_what_the_source_assigns() {
    let run = one(
        "module Acme\n  # The limit.\n  LIMIT = 3\n  ROLES = %w[admin guest].freeze\n  DEFAULT = Money\n  ERROR = StandardError\n  LIB = Nokogiri\n  NOW = Time.now\n  class Money; def x; end; end\n  def self.max\n    LIMIT\n  end\nend\n",
    );
    let limit = entity(&run, "rb:a.rb/Acme::LIMIT");
    assert_eq!((limit.kind, limit.name.as_deref()), ("constant", Some("Acme::LIMIT")));
    assert_eq!(limit.parent, Some(key("rb:a.rb/Acme")));
    assert_eq!(limit.value, Some(Literal::Number("3".into())));
    assert_eq!(limit.comments, Some(vec!["The limit.".to_owned()]));
    assert_eq!(
        limit.traits,
        vec![
            "TNamed",
            "TStructural",
            "TChildOf",
            "TSourceAnchor",
            "TComment",
            "TWithValue"
        ]
    );
    assert_eq!(limit.anchor.as_ref().map(|a| (a.start, a.end)), Some((3, 3)));
    assert_eq!(
        entity(&run, "rb:a.rb/Acme::ROLES").value,
        Some(Literal::Array(vec![
            Literal::String("admin".into()),
            Literal::String("guest".into())
        ]))
    );
    // A constant naming a type is a type literal, closed against the model — the VM's too.
    assert_eq!(
        entity(&run, "rb:a.rb/Acme::DEFAULT").value,
        Some(Literal::Type(key("rb:a.rb/Acme::Money")))
    );
    assert_eq!(
        entity(&run, "rb:a.rb/Acme::ERROR").value,
        Some(Literal::Type(key("rb:<ruby>/StandardError")))
    );
    // A library's constant may be a value as well as a type: its text is all that is known.
    assert_eq!(
        entity(&run, "rb:a.rb/Acme::LIB").value,
        Some(Literal::Unevaluated("Nokogiri".into()))
    );
    // Computed at load time: no value, and the call is the constant's own.
    let now = entity(&run, "rb:a.rb/Acme::NOW");
    assert_eq!(now.value, None);
    assert!(now.traits.contains(&"TWithInvocations"));
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Acme::NOW"),
        vec![("rb:<ruby>/Time".to_owned(), "declared", 8)]
    );
    // Reading a constant is reading a member.
    let read = edge(&run, "access", "rb:a.rb/Acme.max#self", "rb:a.rb/Acme::LIMIT");
    assert_eq!(
        (read.access, read.provenance, read.anchor.start),
        (Some((true, false)), "declared", 11)
    );
}

#[test]
fn an_instance_variable_and_the_attr_that_exposes_it_are_one_field() {
    let run = one(
        "class Base\n  attr_reader :total\n  def initialize\n    @total = 0\n    @seen = 1\n  end\nend\nclass Order < Base\n  attr_accessor :note\n  @registry = {}\n  def add\n    @total += 1\n    @seen\n    self.note = 'x'\n    note\n    total\n  end\n  def self.reg\n    @registry\n  end\nend\n",
    );
    let fields: Vec<String> = ids_of(&run).into_iter().filter(|id| id.contains('@')).collect();
    // `@total` and `@seen` belong to the object: one field, where the root-most class has it.
    assert_eq!(
        fields,
        vec![
            "rb:a.rb/Base.@seen",
            "rb:a.rb/Base.@total",
            "rb:a.rb/Order.@note",
            "rb:a.rb/Order.@registry#self"
        ]
    );
    let total = entity(&run, "rb:a.rb/Base.@total");
    assert_eq!((total.kind, total.name.as_deref()), ("field", Some("@total")));
    assert_eq!(total.parent, Some(key("rb:a.rb/Base")));
    // Declared by the `attr_reader`: anchored there, not at its first assignment.
    assert_eq!(total.anchor.as_ref().map(|a| a.start), Some(2));
    assert_eq!(
        entity(&run, "rb:a.rb/Base.@seen").anchor.as_ref().map(|a| a.start),
        Some(5)
    );

    let accesses: Vec<_> = run
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "access" && e.from.render() == "rb:a.rb/Order.add")
        .map(|e| (e.to.render(), e.access, e.anchor.start))
        .collect();
    assert_eq!(
        accesses,
        vec![
            ("rb:a.rb/Base.@total".to_owned(), Some((true, true)), 12),
            ("rb:a.rb/Base.@seen".to_owned(), Some((true, false)), 13),
            // An accessor call is an access, not an invocation: the accessor is not an entity.
            ("rb:a.rb/Order.@note".to_owned(), Some((false, true)), 14),
            ("rb:a.rb/Order.@note".to_owned(), Some((true, false)), 15),
            ("rb:a.rb/Base.@total".to_owned(), Some((true, false)), 16),
        ]
    );
    // `@registry` in the class body and in a singleton method is the class's own variable.
    assert_eq!(
        edge(&run, "access", "rb:a.rb/Order", "rb:a.rb/Order.@registry#self").access,
        Some((false, true))
    );
    assert_eq!(
        edge(&run, "access", "rb:a.rb/Order.reg#self", "rb:a.rb/Order.@registry#self").access,
        Some((true, false))
    );
    // A class whose body reads or writes says so; one whose body does nothing does not.
    assert!(entity(&run, "rb:a.rb/Order").traits.contains(&"TWithAccesses"));
    assert!(!entity(&run, "rb:a.rb/Base").traits.contains(&"TWithAccesses"));
    assert!(edges_of(&run, "invocation").is_empty());
}

#[test]
fn a_struct_is_a_class_whose_members_are_fields() {
    let run = one(
        "Point = Struct.new(:x, :y) do\n  def dist\n    x + y\n  end\nend\nclass Money < Struct.new(:cents)\n  def double\n    cents * 2\n  end\nend\nCoord = Data.define(:lat)\nHandler = Class.new(Money)\n",
    );
    let point = entity(&run, "rb:a.rb/Point");
    assert_eq!(
        (point.kind, point.anchor.as_ref().map(|a| (a.start, a.end))),
        ("class", Some((1, 5)))
    );
    assert_eq!(
        edges_of(&run, "inheritance"),
        vec![
            ("rb:a.rb/Coord".to_owned(), "rb:<ruby>/Data".to_owned(), "generated", 11),
            // `Class.new(Money)` writes its superclass: a fact, like `< Money`.
            ("rb:a.rb/Handler".to_owned(), "rb:a.rb/Money".to_owned(), "declared", 12),
            // The source writes `Struct.new`, not `< Struct`: the language defines the rest.
            (
                "rb:a.rb/Money".to_owned(),
                "rb:<ruby>/Struct".to_owned(),
                "generated",
                6
            ),
            (
                "rb:a.rb/Point".to_owned(),
                "rb:<ruby>/Struct".to_owned(),
                "generated",
                1
            ),
        ]
    );
    for field in [
        "rb:a.rb/Point.@x",
        "rb:a.rb/Point.@y",
        "rb:a.rb/Money.@cents",
        "rb:a.rb/Coord.@lat",
    ] {
        assert_eq!(entity(&run, field).kind, "field", "{field}");
    }
    // The block is the Struct's body: its `def` is the Struct's method, reading its members.
    assert_eq!(entity(&run, "rb:a.rb/Point.dist").parent, Some(key("rb:a.rb/Point")));
    assert_eq!(
        from(&run, "access", "rb:a.rb/Point.dist"),
        vec![
            ("rb:a.rb/Point.@x".to_owned(), "declared", 3),
            ("rb:a.rb/Point.@y".to_owned(), "declared", 3)
        ]
    );
    assert_eq!(
        from(&run, "access", "rb:a.rb/Money.double"),
        vec![("rb:a.rb/Money.@cents".to_owned(), "declared", 8)]
    );
    // `x + y`, `cents * 2`: an operator on a value whose class the source does not state.
    assert_eq!(run.stats.operators_untyped, 2);
    // `Struct` is the inheritance edge, not a reference beside it.
    assert!(edges_of(&run, "reference").is_empty());
}

// ------------------------------------------------------------------- calls ----

#[test]
fn a_call_on_self_lands_on_the_method_ruby_would_find() {
    let run = one(
        "module Priceable\n  def price\n    rate\n  end\n  def rate; 1; end\nend\nclass Base\n  def save; end\n  def self.find(id); end\nend\nclass Order < Base\n  include Priceable\n  def self.build\n    new.total\n    new(1)\n    find(1)\n  end\n  def initialize(x); end\n  def total\n    price\n    save\n    helper\n  end\n  def helper; end\n  alias_method :cost, :total\n  def run\n    cost\n    self.class.find(2)\n    Order.find(3)\n    Order.new(1)\n  end\nend\ndef toplevel; end\nclass User\n  def go\n    toplevel\n  end\nend\n",
    );
    let declared = |to: &str, line: u32| (to.to_owned(), "declared", line);
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Priceable.price"),
        vec![declared("rb:a.rb/Priceable.rate", 3)]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Order.build#self"),
        vec![
            // `new.total`: an instance of the class the method is written in.
            declared("rb:a.rb/Order.initialize", 14),
            declared("rb:a.rb/Order.total", 14),
            declared("rb:a.rb/Order.initialize", 15),
            declared("rb:a.rb/Base.find#self", 16),
        ]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Order.total"),
        // A mixin's method, an inherited one, the class's own.
        vec![
            declared("rb:a.rb/Priceable.price", 20),
            declared("rb:a.rb/Base.save", 21),
            declared("rb:a.rb/Order.helper", 22)
        ]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Order.run"),
        vec![
            // An alias answers with the method it names.
            declared("rb:a.rb/Order.total", 27),
            declared("rb:a.rb/Base.find#self", 28),
            declared("rb:a.rb/Base.find#self", 29),
            declared("rb:a.rb/Order.initialize", 30),
        ]
    );
    // The constant read is a reference of its own: the call never replaces it.
    assert_eq!(
        from(&run, "reference", "rb:a.rb/Order.run"),
        vec![declared("rb:a.rb/Order", 29), declared("rb:a.rb/Order", 30)]
    );
    // A top-level `def` is a method of every object.
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/User.go"),
        vec![declared("rb:a.rb/toplevel", 36)]
    );
    assert_eq!(run.stats.dropped.len(), 0, "{:?}", run.stats.dropped);
}

#[test]
fn a_module_function_and_an_extend_self_are_called_on_the_module() {
    let run = one(
        "module Util\n  module_function\n  def slug(text); end\nend\nmodule Tools\n  extend self\n  def run; end\nend\nclass User\n  def go\n    Util.slug(1)\n    Tools.run\n  end\nend\n",
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/User.go"),
        vec![
            ("rb:a.rb/Util.slug".to_owned(), "declared", 11),
            ("rb:a.rb/Tools.run".to_owned(), "declared", 12)
        ]
    );
}

#[test]
fn the_language_is_no_edge_and_a_core_type_one_depends_on_is() {
    let run = one(
        "class Label < String\n  def shout\n    upcase\n    between?('a', 'b')\n    puts self\n    frobnicate\n  end\nend\nclass Clock\n  def now\n    Time.now\n    Time.zone\n    File.read('x')\n    ENV.fetch('A')\n    Object.new\n  end\nend\n",
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Label.shout"),
        vec![
            // Inherited from the superclass the source names, and from what THAT mixes in.
            ("rb:<ruby>/String".to_owned(), "declared", 3),
            ("rb:<ruby>/Comparable".to_owned(), "declared", 4),
        ]
    );
    assert_eq!(dropped(&run, "unbound-self-call"), 1);
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Clock.now"),
        vec![
            ("rb:<ruby>/Time".to_owned(), "declared", 11),
            // A method some library adds to a core class: the receiver is still that class.
            ("rb:<ruby>/Time".to_owned(), "declared", 12),
            // `read` is IO's; the source says `File`.
            ("rb:<ruby>/File".to_owned(), "declared", 13),
        ]
    );
    // `puts`, `ENV` and `.fetch` on it, `Object.new`: the language. Resolved, counted, and no edge.
    assert_eq!(run.stats.language, 4);
    assert!(!ids_of(&run).contains(&"rb:<ruby>/Kernel".to_owned()));
}

#[test]
fn a_library_type_is_a_stub_the_call_lands_on() {
    let run = one(
        "class Client\n  def go\n    JSON.parse('{}')\n    Nokogiri::HTML.parse(1)\n    Logger.new($stdout)\n    Logger.new($stderr).info('x')\n  end\nend\n",
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Client.go"),
        vec![
            ("rb:<gems>/JSON".to_owned(), "declared", 3),
            ("rb:<gems>/Nokogiri::HTML".to_owned(), "declared", 4),
            ("rb:<gems>/Logger".to_owned(), "declared", 5),
            ("rb:<gems>/Logger".to_owned(), "declared", 6),
        ]
    );
    assert_eq!(from(&run, "reference", "rb:a.rb/Client.go").len(), 4);
    // Instantiated: a class. Only named: a module, which every class is.
    assert_eq!(entity(&run, "rb:<gems>/Logger").kind, "class");
    assert_eq!(entity(&run, "rb:<gems>/JSON").kind, "module");
}

#[test]
fn a_call_nothing_known_answers_is_attributed_to_the_sole_library_ancestor() {
    let run = one(
        "class ApplicationRecord < ActiveRecord::Base; end\nclass Order < ApplicationRecord\n  has_many :lines\n  def touch_it\n    save!\n  end\n  def self.recent\n    where(x: 1)\n  end\nend\nclass Job < ActiveJob::Base\n  include Sidekiq::Worker\n  def perform\n    enqueue\n  end\nend\nclass Ghost < ActiveRecord::Base\n  def method_missing(name); end\n  def run\n    anything\n  end\nend\nclass Plain\n  def run\n    nothing_here\n  end\nend\n",
    );
    let base = "rb:<gems>/ActiveRecord::Base";
    // An inference by elimination: `derived`, never `declared`.
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Order"),
        vec![(base.to_owned(), "derived", 3)]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Order.touch_it"),
        vec![(base.to_owned(), "derived", 5)]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Order.recent#self"),
        vec![(base.to_owned(), "derived", 8)]
    );
    assert_eq!(run.stats.attributed, 3);
    // A class body that calls says so.
    assert!(entity(&run, "rb:a.rb/Order").traits.contains(&"TWithInvocations"));
    // Two libraries could answer: no honest target.
    assert!(from(&run, "invocation", "rb:a.rb/Job.perform").is_empty());
    assert_eq!(dropped(&run, "ambiguous-ancestor"), 1);
    // A type that defines methods at run time proves nothing by not declaring one.
    assert!(from(&run, "invocation", "rb:a.rb/Ghost.run").is_empty());
    assert_eq!(dropped(&run, "unbound-dynamic"), 1);
    // No library in the chain: simply unbound.
    assert_eq!(dropped(&run, "unbound-self-call"), 1);
}

#[test]
fn methods_defined_at_run_time_cloud_one_side_of_a_type_not_both() {
    // `define_method` in a class body defines for the INSTANCES: what the class
    // itself answers is as known as before. `def self.method_missing` is the reverse.
    let run = one(
        "class ApplicationRecord < ActiveRecord::Base; end\nclass Account < ApplicationRecord\n  [1].each { |key| define_method(\"k#{key}\") { 1 } }\n  scope :local\n  def self.recent\n    where(x: 1)\n  end\n  def run\n    save!\n  end\nend\nclass Setting < ApplicationRecord\n  def self.method_missing(name); end\n  def self.lookup\n    where(x: 1)\n  end\n  def run\n    save!\n  end\nend\n",
    );
    let base = "rb:<gems>/ActiveRecord::Base";
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Account"),
        vec![(base.to_owned(), "derived", 4)]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Account.recent#self"),
        vec![(base.to_owned(), "derived", 6)]
    );
    assert!(from(&run, "invocation", "rb:a.rb/Account.run").is_empty());
    assert!(from(&run, "invocation", "rb:a.rb/Setting.lookup#self").is_empty());
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Setting.run"),
        vec![(base.to_owned(), "derived", 18)]
    );
    assert_eq!(
        run.stats.explained,
        vec![
            "computed-define-method: a.rb:3 define_method".to_owned(),
            "unbound-dynamic: a.rb:9 save! (Account defines methods at run time)".to_owned(),
            "unbound-dynamic: a.rb:15 where (Setting defines methods at run time)".to_owned(),
        ]
    );
}

#[test]
fn a_class_method_an_included_hook_gives_is_derived() {
    let run = one(
        "module Finder\n  extend ActiveSupport::Concern\n  class_methods do\n    def find_remote(name); end\n  end\nend\nmodule Legacy\n  def self.included(base)\n    base.extend(ClassMethods)\n  end\n  module ClassMethods\n    def acts_as_x; end\n  end\nend\nclass Account < ActiveRecord::Base\n  include Finder\n  include Legacy\n  acts_as_x\n  has_many :things\nend\nclass Worker\n  include Sidekiq::Worker\nend\nclass Page < ActionController::Base\n  include Pundit::Authorization\n  before_action :check\nend\nclass Caller\n  def go\n    Account.find_remote(1)\n    Worker.perform_async(1)\n  end\nend\n",
    );
    // The includer never writes `extend Legacy::ClassMethods`: found through the hook, an inference.
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Account"),
        vec![
            ("rb:a.rb/Legacy::ClassMethods.acts_as_x".to_owned(), "derived", 18),
            ("rb:<gems>/ActiveRecord::Base".to_owned(), "derived", 19),
        ]
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Caller.go"),
        vec![
            ("rb:a.rb/Finder::ClassMethods.find_remote".to_owned(), "derived", 30),
            // The one library that could have given `Worker` a class method.
            ("rb:<gems>/Sidekiq::Worker".to_owned(), "derived", 31),
        ]
    );
    // `class_methods do` is the body of a module the model names.
    let class_methods = entity(&run, "rb:a.rb/Finder::ClassMethods");
    assert_eq!(class_methods.kind, "module");
    assert_eq!(
        (
            class_methods.anchor.as_ref().unwrap().start,
            class_methods.anchor.as_ref().unwrap().end
        ),
        (3, 5)
    );
    // A superclass and a mixin, both a library's: either could answer `before_action`.
    assert!(from(&run, "invocation", "rb:a.rb/Page").is_empty());
    assert_eq!(dropped(&run, "ambiguous-ancestor"), 1);
    assert!(run.stats.explained.contains(
        &"ambiguous-ancestor: a.rb:26 before_action (Pundit::Authorization or ActionController::Base)".to_owned()
    ));
}

#[test]
fn a_receiver_typed_by_what_a_body_assigns_is_derived() {
    let run = one(
        "class Repo\n  def find; end\nend\nclass Cache\n  def get; end\nend\nclass Service\n  def initialize(repo)\n    @repo = Repo.new\n    @cache = Cache.new\n    @given = repo\n  end\n  def reset\n    @cache = build\n  end\n  def run\n    local = Repo.new\n    local.find\n    @repo.find\n    @cache.get\n    @given.find\n    Repo.new.find\n  end\nend\n",
    );
    let find = "rb:a.rb/Repo.find";
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Service.run"),
        vec![
            (find.to_owned(), "derived", 18),
            (find.to_owned(), "derived", 19),
            // `Repo.new.find` needs no inference: `new` returns a Repo.
            (find.to_owned(), "declared", 22),
        ]
    );
    // `@cache` is assigned two different things; `@given` whatever the caller passed.
    assert_eq!(dropped(&run, "untyped-receiver"), 2);
}

#[test]
fn super_raise_and_a_method_taken_as_a_value() {
    let run = one(
        "class NotFound < StandardError; end\nclass Base\n  def call(x); end\nend\nclass Child < Base\n  def call(x)\n    super\n    raise NotFound, 'x' if x\n    raise 'plain'\n    raise Custom::Error\n    method(:helper)\n  end\n  def helper; end\n  def initialize\n    super\n  end\nend\nmodule Mix\n  def go\n    super\n  end\nend\n",
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Child.call"),
        vec![("rb:a.rb/Base.call".to_owned(), "declared", 7)]
    );
    assert_eq!(
        from(&run, "throws", "rb:a.rb/Child.call"),
        vec![
            ("rb:a.rb/NotFound".to_owned(), "declared", 8),
            // `raise "text"` raises a RuntimeError.
            ("rb:<ruby>/RuntimeError".to_owned(), "declared", 9),
            ("rb:<gems>/Custom::Error".to_owned(), "declared", 10),
        ]
    );
    // What is raised is a class.
    assert_eq!(entity(&run, "rb:<gems>/Custom::Error").kind, "class");
    // A throws edge never replaces the dependency: the constant is referenced too.
    let references = from(&run, "reference", "rb:a.rb/Child.call");
    assert!(references.contains(&("rb:a.rb/NotFound".to_owned(), "declared", 8)));
    // `method(:helper)` takes the method as a value: a reference, not a call.
    assert!(references.contains(&("rb:a.rb/Child.helper".to_owned(), "declared", 11)));
    // `super` into `BasicObject#initialize` is the language.
    assert!(from(&run, "invocation", "rb:a.rb/Child.initialize").is_empty());
    // In a module, whoever mixes it in decides what is above.
    assert_eq!(dropped(&run, "super-in-module"), 1);
}

#[test]
fn a_monkey_patch_is_found_before_the_vm_s_own_method() {
    let run = one(
        "class String\n  def blank?\n    strip.empty?\n  end\nend\nclass Use\n  def go\n    'x'.blank?\n    'x'.upcase\n    1.day\n  end\nend\n",
    );
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/Use.go"),
        vec![("rb:a.rb/String.blank?".to_owned(), "declared", 8)]
    );
    // Inside the patch, `strip` is the VM's String.
    assert_eq!(
        from(&run, "invocation", "rb:a.rb/String.blank?"),
        vec![("rb:<ruby>/String".to_owned(), "declared", 3)]
    );
    // `1.day` is some library's patch of Integer: nothing here or in the VM answers.
    assert_eq!(dropped(&run, "unbound-method"), 1);
}

// --------------------------------------------------- comments and measures ----

#[test]
fn carries_comments_and_measures_and_says_so_in_the_traits() {
    let run = one("# An order.\nclass Order\n  # Sums.\n  def total(x)\n    return 0 if x\n    1\n  end\nend\n");
    let order = entity(&run, "rb:a.rb/Order");
    assert_eq!(order.comments, Some(vec!["An order.".to_owned()]));
    assert_eq!(order.metrics, Some(vec![("sloc", 6)]));
    assert_eq!(
        order.traits,
        vec![
            "TNamed",
            "TType",
            "TWithInheritances",
            "TWithChildren",
            "TChildOf",
            "TSourceAnchor",
            "TComment",
            "TMetrics"
        ]
    );
    let total = entity(&run, "rb:a.rb/Order.total");
    assert_eq!(total.comments, Some(vec!["Sums.".to_owned()]));
    assert_eq!(total.metrics, Some(vec![("cyclomatic", 2), ("sloc", 4)]));
    assert!(total.traits.contains(&"TComment") && total.traits.contains(&"TMetrics"));
    // The file: every line that is code — comments are not.
    assert_eq!(entity(&run, "rb:a.rb").metrics, Some(vec![("sloc", 6)]));
    // A parameter with a default carries it.
    let run = one("def f(mode = :fast, n: 2); end\n");
    assert_eq!(
        entity(&run, "rb:a.rb/f#param:mode").value,
        Some(Literal::Unevaluated(":fast".into()))
    );
    assert_eq!(
        entity(&run, "rb:a.rb/f#param:n").value,
        Some(Literal::Number("2".into()))
    );
    assert!(entity(&run, "rb:a.rb/f#param:n").traits.contains(&"TWithValue"));
}

#[test]
fn explains_every_dropped_site_when_asked() {
    let run = one("class Order\n  def go(x)\n    x.total\n    missing\n  end\nend\n");
    assert_eq!(
        run.stats.explained,
        vec![
            "untyped-receiver: a.rb:3 total".to_owned(),
            "unbound-self-call: a.rb:4 missing".to_owned()
        ]
    );
}

#[test]
fn an_unbound_dynamic_drop_names_the_type_that_defines_methods_at_run_time() {
    // The ancestor, not the class the call is written in: that is what an audit needs to find.
    let run = one(
        "module Fixtures\n  def method_missing(name); end\nend\nclass Case < Minitest::Test\n  include Fixtures\n  def run\n    assert_equal 1, 1\n    super\n  end\nend\n",
    );
    assert_eq!(
        run.stats.explained,
        vec![
            "unbound-dynamic: a.rb:7 assert_equal (Fixtures defines methods at run time)".to_owned(),
            "unbound-dynamic: a.rb:8 super (Fixtures defines methods at run time)".to_owned(),
        ]
    );
}

// -------------------------------------------------------------------- trace ----

const TRACED: &[(&str, &str)] = &[(
    "lib/a.rb",
    "module Hooked\n  def self.included(base)\n    base.send(HOOK, Extra)\n  end\nend\nmodule Extra\n  def extra; end\nend\nclass Order\n  include Hooked\n  include Comparable\n  def total; 1; end\n  def run(x)\n    x.total\n    total\n  end\nend\n",
)];

#[test]
fn a_trace_adds_the_mixins_the_parser_cannot_see_as_generated() {
    let run = traced(
        TRACED,
        Some(concat!(
            // `base.send(HOOK, Extra)`: what the hook did is only known once it ran.
            r#"{"t":"mixin","type":"Order","how":"extend","module":"Extra"}"#,
            "\n",
            r#"{"t":"mixin","type":"Order","how":"include","module":"Hooked"}"#,
            "\n",
            r#"{"t":"mixin","type":"Order","how":"include","module":"Comparable"}"#,
            "\n",
            r#"{"t":"mixin","type":"Order","how":"include","module":"ActiveModel::Model"}"#,
            "\n",
            // A library's class is not the corpus's to describe.
            r#"{"t":"mixin","type":"Rack::Request","how":"include","module":"Extra"}"#,
        )),
    );
    let order = "rb:lib%2Fa.rb/Order";
    assert_eq!(
        from(&run, "traitUsage", order),
        vec![
            // Anchored on the class the VM found them on: no line writes them.
            ("rb:<gems>/ActiveModel::Model".to_owned(), "generated", 9),
            ("rb:lib%2Fa.rb/Extra".to_owned(), "generated", 9),
            ("rb:lib%2Fa.rb/Hooked".to_owned(), "declared", 10),
            ("rb:<ruby>/Comparable".to_owned(), "declared", 11),
        ]
    );
    let trace = run.stats.trace.as_ref().expect("trace stats");
    assert_eq!(
        (
            trace.mixins,
            trace.mixins_known,
            trace.mixins_generated,
            trace.mixins_outside
        ),
        (5, 2, 2, 1)
    );
}

#[test]
fn a_trace_binds_an_untyped_call_to_what_it_reached_as_a_dynamic_candidate() {
    let run = traced(
        TRACED,
        Some(concat!(
            // `x.total`: no parser types `x`; the program reached Order#total.
            r#"{"t":"call","file":"lib/a.rb","line":14,"name":"total","at":"lib/a.rb","def":12}"#,
            "\n",
            // `total` on self: the baseline already says so.
            r#"{"t":"call","file":"lib/a.rb","line":15,"name":"total","at":"lib/a.rb","def":12}"#,
            "\n",
            // No call of that name is written on that line: `send`, a DSL.
            r#"{"t":"call","file":"lib/a.rb","line":14,"name":"nope","at":"lib/a.rb","def":12}"#,
            "\n",
            // The callee was defined where no `def` is written.
            r#"{"t":"call","file":"lib/a.rb","line":14,"name":"total","at":"lib/a.rb","def":3}"#,
            "\n",
            r#"{"t":"call","file":"lib/elsewhere.rb","line":1,"name":"total","at":"lib/a.rb","def":12}"#,
        )),
    );
    let edges: Vec<_> = run
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "invocation" && e.from.render() == "rb:lib%2Fa.rb/Order.run")
        .map(|e| {
            (
                e.to.render(),
                e.provenance,
                e.anchor.start,
                e.candidates
                    .as_ref()
                    .map(|c| c.iter().map(Key::render).collect::<Vec<_>>()),
            )
        })
        .collect();
    assert_eq!(
        edges,
        vec![
            ("rb:lib%2Fa.rb/Order.total".to_owned(), "declared", 15, None),
            (
                "rb:lib%2Fa.rb/Order.total".to_owned(),
                "dynamic-candidate",
                14,
                Some(vec!["rb:lib%2Fa.rb/Order.total".to_owned()])
            ),
        ]
    );
    let trace = run.stats.trace.as_ref().expect("trace stats");
    assert_eq!(
        (
            trace.calls,
            trace.calls_added,
            trace.calls_known,
            trace.calls_unmatched,
            trace.calls_untargeted,
            trace.calls_outside
        ),
        (5, 1, 1, 1, 1, 1)
    );
}

#[test]
fn a_trace_counts_the_methods_no_def_writes_and_never_adds_an_entity() {
    let records = concat!(
        r#"{"t":"method","type":"Order","name":"total","singleton":false,"file":"lib/a.rb","line":12}"#,
        "\n",
        // Defined at run time, on a line that writes no `def`.
        r#"{"t":"method","type":"Order","name":"hooked?","singleton":false,"file":"lib/a.rb","line":3}"#,
        "\n",
        r#"{"t":"method","type":"Order","name":"gem_method","singleton":false,"file":"lib/gone.rb","line":1}"#,
    );
    let run = traced(TRACED, Some(records));
    let trace = run.stats.trace.as_ref().expect("trace stats");
    assert_eq!(
        (
            trace.methods,
            trace.methods_known,
            trace.methods_at_run_time,
            trace.methods_outside
        ),
        (3, 1, 1, 1)
    );
    // Keys never come from the trace: the same entities, and every edge the source wrote.
    let plain = traced(TRACED, None);
    assert_eq!(ids_of(&run), ids_of(&plain));
    assert!(plain.stats.trace.is_none());
    for edge in &plain.model.edges {
        assert!(run.model.edges.contains(edge), "{edge:?}");
    }
}
