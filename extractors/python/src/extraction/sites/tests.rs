use super::super::tests::extract_sources;
use crate::extraction::Extraction;
use crate::ids;

const REPO: &str = "class Repo:\n    def save(self, item): pass\n    def find(self): pass\n";

const APP: &str = "\
import json
import unittest
from django.db import models
from lib.repo import Repo
from lib import repo as repo_mod

DEBUG = False

def helper(): return 1

class Base:
    def __init__(self):
        self.repo = Repo()
        self.items = []
    def total(self): return 0
    @property
    def size(self): return 1
    @size.setter
    def size(self, value): pass

class Order(Base):
    def __init__(self, x):
        super().__init__()
        self.total()
        self.repo.save(x)
        self.items.append(x)
        helper()
        Repo.find(None)
        repo_mod.Repo()
        json.dumps(x)
        len(x)
        x.anything()
        self.size
        self.size = 2
        self.missing()
    @classmethod
    def make(cls):
        return cls()

def use(repo: Repo, order):
    repo.save(1)
    local = Repo()
    local.find()
    print(DEBUG)
    order.total()

class T(unittest.TestCase):
    def test(self):
        self.assertEqual(1, 1)

class M(models.Model):
    def go(self):
        M.objects.filter()
        self.save()

def fail():
    raise ValueError(\"x\")

def fail2(e):
    try:
        pass
    except KeyError as err:
        raise err
    raise e
";

/// `(kind, from, to, provenance, access)`, keys shortened.
type Row = (&'static str, String, String, &'static str, Option<(bool, bool)>);
/// The same, below one source: `(kind, to, provenance, access)`.
type Below<'a> = (&'static str, &'a str, &'static str, Option<(bool, bool)>);

/// Every edge but the imports and the bases.
fn edges(extraction: &Extraction) -> Vec<Row> {
    let short = |rendered: String| {
        rendered
            .trim_start_matches("python:")
            .replace("lib%2Frepo.py/", "repo:")
            .replace("app.py/", "")
            .replace("m.py/", "")
    };
    let mut out: Vec<_> = extraction
        .model
        .edges
        .iter()
        .filter(|e| !matches!(e.kind, "import" | "inheritance"))
        .map(|e| {
            (
                e.kind,
                short(e.from.render(ids::LANG)),
                short(e.to.render(ids::LANG)),
                e.provenance,
                e.access,
            )
        })
        .collect();
    out.sort();
    out
}

fn of<'a>(all: &'a [Row], from: &str) -> Vec<Below<'a>> {
    all.iter()
        .filter(|edge| edge.1 == from)
        .map(|edge| (edge.0, edge.2.as_str(), edge.3, edge.4))
        .collect()
}

const READ: Option<(bool, bool)> = Some((true, false));
const WRITE: Option<(bool, bool)> = Some((false, true));

#[test]
fn every_receiver_shape_lands_in_the_tier_the_notes_give_it() {
    let extraction = extract_sources(&[("lib/repo.py", REPO), ("app.py", APP)]);
    let all = edges(&extraction);
    assert_eq!(
        of(&all, "Base.__init__"),
        vec![
            ("access", "Base.items", "declared", WRITE),
            ("access", "Base.repo", "declared", WRITE),
            ("invocation", "repo:Repo", "declared", None),
        ]
    );
    assert_eq!(
        of(&all, "Order.__init__"),
        vec![
            // A property is read and written as an attribute: the getter, the setter.
            ("access", "Base.items", "declared", READ),
            ("access", "Base.repo", "declared", READ),
            ("access", "Base.size", "declared", READ),
            ("access", "Base.size#setter", "declared", WRITE),
            // `super()` along the MRO, `self` along written bases, a class named, a module's attribute.
            ("invocation", "<stdlib>%2Fjson", "declared", None),
            ("invocation", "Base.__init__", "declared", None),
            ("invocation", "Base.total", "declared", None),
            ("invocation", "helper", "declared", None),
            ("invocation", "repo:Repo", "declared", None),
            ("invocation", "repo:Repo.find", "declared", None),
            // An attribute only ever assigned one class: flow.
            ("invocation", "repo:Repo.save", "derived", None),
        ]
    );
    assert_eq!(
        of(&all, "Order.make"),
        vec![("invocation", "Order.__init__", "declared", None)]
    );
    assert_eq!(
        of(&all, "use"),
        vec![
            ("access", "DEBUG", "declared", READ),
            ("invocation", "repo:Repo", "declared", None),
            // An annotation, a local assigned once: both inferences.
            ("invocation", "repo:Repo.find", "derived", None),
            ("invocation", "repo:Repo.save", "derived", None),
            // The annotation itself names the class.
            ("reference", "repo:Repo", "declared", None),
        ]
    );
    // The one library class that could answer: `self.assertEqual`, `M.objects.filter()`, `self.save()`.
    assert_eq!(
        of(&all, "T.test"),
        vec![("invocation", "<stdlib>%2Funittest/TestCase", "derived", None)]
    );
    assert_eq!(
        of(&all, "M.go"),
        vec![
            ("invocation", "<site>%2Fdjango.db/models.Model", "derived", None),
            ("invocation", "<site>%2Fdjango.db/models.Model", "derived", None),
        ]
    );
    assert_eq!(
        of(&all, "fail"),
        vec![("throws", "<builtins>/ValueError", "declared", None)]
    );
    assert_eq!(
        of(&all, "fail2"),
        vec![
            ("reference", "<builtins>/KeyError", "declared", None),
            ("throws", "<builtins>/KeyError", "declared", None),
        ]
    );
    let stats = &extraction.stats;
    assert_eq!(
        (stats.flow_typed, stats.annotation_typed, stats.ancestor_attributed),
        (2, 1, 3)
    );
    // `self.items.append`, `len`, `print`, and `@property`, `@size.setter`, `@classmethod`:
    // resolved, counted, no edge.
    assert_eq!(stats.language, 6);
    let drops: Vec<(&str, u32, &str)> = stats
        .drops
        .iter()
        .map(|d| (d.reason, d.line, d.what.as_str()))
        .collect();
    assert_eq!(
        drops,
        vec![
            ("untyped-receiver", 32, "x.anything()"),
            ("unbound-self-call", 35, "self.missing() (Order)"),
            ("untyped-receiver", 45, "order.total()"),
            ("raise-of-a-value", 64, "e"),
        ]
    );
}

#[test]
fn a_class_that_decides_its_members_at_run_time_and_two_library_classes_are_no_answer() {
    let extraction = extract_sources(&[(
        "m.py",
        "from a import Audit\nfrom b import Base\n\
         class Proxy:\n    def __getattr__(self, name): pass\n    def go(self):\n        self.anything()\n\
         class Both(Audit, Base):\n    def go(self):\n        self.anything()\n\
         def f(p: Proxy):\n    p.other\n",
    )]);
    let drops: Vec<(&str, u32, &str)> = extraction
        .stats
        .drops
        .iter()
        .map(|d| (d.reason, d.line, d.what.as_str()))
        .collect();
    assert_eq!(
        drops,
        vec![
            ("unbound-dynamic", 6, "self.anything() (Proxy)"),
            ("ambiguous-ancestor", 9, "self.anything() (a.Audit or b.Base)"),
            ("unbound-dynamic", 11, "p.other (Proxy)"),
        ]
    );
}

const ANNOTATED: &str = "\
import functools
from typing import Optional
from lib import Session, register
from flask import Flask

handlers = []
app = Flask(__name__)

class Repo: pass

def retry(times, delay=0): pass

class Service:
    repo: Repo
    cache: \"Optional[Repo]\" = None
    def __init__(self, session: Session, items: list[Repo], count: int = 0) -> None:
        self.session: Session = session
    @property
    def size(self) -> int: return 0
    @retry(3, delay=1)
    def go(self, *args) -> Repo: pass
    @functools.lru_cache(maxsize=None)
    def cached(self): pass
    @register(*handlers, name=\"x\")
    def spread(self): pass

@retry
def plain(): pass

@app.route(\"/orders\", methods=[\"GET\"])
def orders():
    app.run()
";

#[test]
fn an_annotation_sets_the_declared_type_it_names_and_references_each_class_in_it() {
    let extraction = extract_sources(&[("m.py", ANNOTATED)]);
    let declared = |rendered: &str| {
        super::super::tests::entity(&extraction, rendered)
            .declared_type
            .as_ref()
            .map(|key| key.render(ids::LANG))
    };
    let repo = Some("python:m.py/Repo".to_owned());
    let session = Some("python:<site>%2Flib/Session".to_owned());
    assert_eq!(declared("python:m.py/Service.repo"), repo);
    // A string annotation is parsed; `Optional` is unwrapped.
    assert_eq!(declared("python:m.py/Service.cache"), repo);
    assert_eq!(declared("python:m.py/Service.session"), session);
    assert_eq!(declared("python:m.py/Service.__init__#param:session"), session);
    // A built-in container, `int`, `None`: the language names nothing.
    assert_eq!(declared("python:m.py/Service.__init__#param:items"), None);
    assert_eq!(declared("python:m.py/Service.__init__#param:count"), None);
    assert_eq!(declared("python:m.py/Service.__init__"), None);
    assert_eq!(declared("python:m.py/Service.go"), repo);
    let all = edges(&extraction);
    let references = |from: &str| -> Vec<&str> {
        of(&all, from)
            .into_iter()
            .filter(|edge| edge.0 == "reference")
            .map(|edge| edge.1)
            .collect()
    };
    assert_eq!(references("Service"), vec!["Repo", "Repo"]);
    // `list[Repo]` names no type but references the class inside it.
    assert_eq!(
        references("Service.__init__"),
        vec!["<site>%2Flib/Session", "<site>%2Flib/Session", "Repo"]
    );
    assert_eq!(references("Service.go"), vec!["Repo"]);
}

/// `(from, to, provenance, [(argument, value)])` of an annotation use.
type Use<'a> = (String, String, &'a str, Vec<(String, String)>);

#[test]
fn a_decorator_is_an_annotation_use_with_its_written_arguments_named() {
    let extraction = extract_sources(&[("m.py", ANNOTATED)]);
    let uses: Vec<Use> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "annotationUse")
        .map(|e| {
            let arguments = e
                .arguments
                .iter()
                .flatten()
                .map(|argument| (argument.name.clone(), format!("{:?}", argument.value)))
                .collect();
            (
                e.from.render(ids::LANG).replace("python:m.py/", ""),
                e.to.render(ids::LANG).replace("python:", ""),
                e.provenance,
                arguments,
            )
        })
        .collect();
    let named = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
        pairs.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
    };
    assert_eq!(
        uses,
        vec![
            // Positional arguments take the parameter names of a corpus decorator.
            (
                "Service.go".to_owned(),
                "m.py/retry".to_owned(),
                "declared",
                named(&[("times", "Number(\"3\")"), ("delay", "Number(\"1\")")])
            ),
            (
                "Service.cached".to_owned(),
                "<stdlib>%2Ffunctools".to_owned(),
                "declared",
                named(&[("maxsize", "Null")])
            ),
            // A spread is no argument a line can name: counted, not written.
            (
                "Service.spread".to_owned(),
                "<site>%2Flib".to_owned(),
                "declared",
                named(&[("name", "String(\"x\")")])
            ),
            ("plain".to_owned(), "m.py/retry".to_owned(), "declared", Vec::new()),
            // A library's otherwise: `arg<i>`; `app` is typed by its one assignment.
            (
                "orders".to_owned(),
                "<site>%2Fflask".to_owned(),
                "derived",
                named(&[("arg0", "String(\"/orders\")"), ("methods", "Array([String(\"GET\")])")])
            ),
        ]
    );
    let all = edges(&extraction);
    // Reading the module's `app` is a fact; what its one assignment made it, an inference.
    assert_eq!(
        of(&all, "orders"),
        vec![
            ("access", "app", "declared", READ),
            ("annotationUse", "<site>%2Fflask", "derived", None),
            ("invocation", "<site>%2Fflask", "derived", None),
        ]
    );
    let spreads: Vec<(&str, u32)> = extraction
        .stats
        .drops
        .iter()
        .filter(|d| d.reason == "spread-argument")
        .map(|d| (d.what.as_str(), d.line))
        .collect();
    assert_eq!(spreads, vec![("@register(*handlers, name=\"x\")", 24)]);
}

#[test]
fn a_class_a_call_makes_is_a_class_its_fields_attributes_its_base_generated() {
    let extraction = extract_sources(&[
        (
            "m.py",
            "from collections import namedtuple\nfrom typing import NamedTuple\nimport enum\n\
             P = namedtuple(\"P\", \"x y\")\nclass Q(NamedTuple(\"Q\", [(\"a\", int)])): pass\n\
             Color = enum.Enum(\"Color\", \"RED GREEN\")\n\
             def f():\n    p = P(1, 2)\n    p.x\n    Color.RED\n",
        ),
        ("n.py", "from mylib import namedtuple\nR = namedtuple(\"R\", \"z\")\n"),
    ]);
    let kinds: Vec<(String, &str)> = super::super::tests::rendered(&extraction)
        .into_iter()
        .filter(|(key, kind)| matches!(*kind, "class" | "attribute") && !key.contains('<'))
        .collect();
    let named = |pairs: &[(&str, &'static str)]| -> Vec<(String, &'static str)> {
        pairs
            .iter()
            .map(|(key, kind)| (format!("python:m.py/{key}"), *kind))
            .collect()
    };
    assert_eq!(
        kinds,
        named(&[
            ("Color", "class"),
            ("Color.GREEN", "attribute"),
            ("Color.RED", "attribute"),
            ("P", "class"),
            ("P.x", "attribute"),
            ("P.y", "attribute"),
            ("Q", "class"),
            ("Q.a", "attribute"),
        ])
        .into_iter()
        // `mylib`'s `namedtuple`: a class by its form, with no base the model can name.
        .chain([
            ("python:n.py/R".to_owned(), "class"),
            ("python:n.py/R.z".to_owned(), "attribute"),
        ])
        .collect::<Vec<_>>()
    );
    let bases: Vec<(String, String, &str)> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "inheritance")
        .map(|e| (e.from.render(ids::LANG), e.to.render(ids::LANG), e.provenance))
        .collect();
    assert_eq!(
        bases,
        vec![
            (
                "python:m.py/P".to_owned(),
                "python:<builtins>/tuple".to_owned(),
                "generated"
            ),
            (
                "python:m.py/Q".to_owned(),
                "python:<builtins>/tuple".to_owned(),
                "generated"
            ),
            (
                "python:m.py/Color".to_owned(),
                "python:<stdlib>%2Fenum/Enum".to_owned(),
                "generated"
            ),
        ]
    );
    let drops: Vec<(&str, u32, &str)> = extraction
        .stats
        .drops
        .iter()
        .map(|d| (d.reason, d.line, d.what.as_str()))
        .collect();
    assert_eq!(
        drops,
        vec![("computed-base", 2, "R (namedtuple is not the standard library's)")]
    );
    let all = edges(&extraction);
    assert_eq!(
        of(&all, "f"),
        vec![
            ("access", "Color.RED", "declared", READ),
            ("access", "P.x", "derived", READ),
            ("invocation", "P", "declared", None),
        ]
    );
}

#[test]
fn a_literal_import_module_or_dunder_import_is_an_import_and_a_computed_name_is_counted() {
    let extraction = extract_sources(&[
        ("pkg/__init__.py", ""),
        ("pkg/sub.py", ""),
        (
            "m.py",
            "import importlib\nmod = importlib.import_module(\"json\")\nplugin = importlib.import_module(name)\n\
             legacy = __import__(\"pkg.sub\")\n",
        ),
    ]);
    let imports: Vec<(String, u32)> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "import" && e.from.render(ids::LANG) == "python:m.py")
        .map(|e| (e.to.render(ids::LANG), e.anchor.start))
        .collect();
    assert_eq!(
        imports,
        vec![
            ("python:<stdlib>%2Fimportlib".to_owned(), 1),
            ("python:<stdlib>%2Fjson".to_owned(), 2),
            ("python:pkg%2Fsub.py".to_owned(), 4),
        ]
    );
    let drops: Vec<(&str, u32, &str)> = extraction
        .stats
        .drops
        .iter()
        .filter(|d| d.reason == "computed-import")
        .map(|d| (d.reason, d.line, d.what.as_str()))
        .collect();
    assert_eq!(drops, vec![("computed-import", 3, "importlib.import_module(name)")]);
    assert_eq!(extraction.stats.imports.stdlib, 2);
}

#[test]
fn a_site_class_reached_through_an_imported_name_keeps_its_dotted_symbol_and_is_counted() {
    let extraction = extract_sources(&[(
        "m.py",
        "from django.db import models\nfrom rest import Base\nclass O(models.Model): pass\nclass P(Base): pass\n",
    )]);
    assert_eq!(extraction.stats.dotted_site_classes, 1);
    assert!(extraction.stats.summary().contains("dotted-site-class"));
}

const ALIASES: &str = "\
import unittest
from django.db import models

class Real:
    def ping(self): pass

Alias = Real
Again = Alias
TestCase = unittest.TestCase
Model = models.Model
Made = type(\"Made\", (), {})
Twice = Real
Twice = Alias

class A(Again):
    def go(self):
        self.ping()

class T(TestCase):
    def test(self):
        self.assertEqual(1, 1)

class M(Model): pass

class C(Made): pass

class D(Twice): pass
";

#[test]
fn a_base_bound_once_to_a_class_is_that_class_by_flow_and_anything_else_stays_computed() {
    let extraction = extract_sources(&[("m.py", ALIASES)]);
    let bases: Vec<(String, String, &str)> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "inheritance")
        .map(|e| (e.from.render(ids::LANG), e.to.render(ids::LANG), e.provenance))
        .collect();
    let row = |from: &str, to: &str| (format!("python:m.py/{from}"), format!("python:{to}"), "derived");
    assert_eq!(
        bases,
        vec![
            row("A", "m.py/Real"),
            row("T", "<stdlib>%2Funittest/TestCase"),
            row("M", "<site>%2Fdjango.db/models.Model"),
        ]
    );
    // What an ancestor reached only through an alias answers rests on the same inference.
    let all = edges(&extraction);
    assert_eq!(of(&all, "A.go"), vec![("invocation", "Real.ping", "derived", None)]);
    assert_eq!(
        of(&all, "T.test"),
        vec![("invocation", "<stdlib>%2Funittest/TestCase", "derived", None)]
    );
    let drops: Vec<(&str, u32, &str)> = extraction
        .stats
        .drops
        .iter()
        .filter(|d| d.reason == "computed-base")
        .map(|d| (d.reason, d.line, d.what.as_str()))
        .collect();
    assert_eq!(
        drops,
        vec![
            ("computed-base", 25, "Made (bound to a value)"),
            ("computed-base", 27, "Twice (bound to a value)"),
        ]
    );
    // Three bases and the member reached through one; the aliases stay variables.
    assert_eq!(extraction.stats.alias_base, 4);
    for alias in ["Alias", "Again", "TestCase", "Model"] {
        assert_eq!(
            super::super::tests::entity(&extraction, &format!("python:m.py/{alias}")).kind,
            "variable"
        );
    }
    assert!(extraction.stats.summary().contains("alias-base"));
}

#[test]
fn a_literal_slot_is_an_attribute_of_its_class_anchored_at_its_string_with_no_value() {
    let extraction = extract_sources(&[(
        "m.py",
        "class P:\n    __slots__ = (\"_x\",\n                 \"_y\")\n\
         \x20   def __init__(self):\n        self._x = 1\n    def get(self):\n        return self._y\n",
    )]);
    let attribute = |name: &str| super::super::tests::entity(&extraction, &format!("python:m.py/P.{name}"));
    for (name, line) in [("_x", 2), ("_y", 3)] {
        let slot = attribute(name);
        assert_eq!(slot.kind, "attribute");
        assert_eq!(
            slot.anchor.as_ref().map(|a| (a.start, a.end)),
            Some((line, line)),
            "{name}"
        );
        assert_eq!(slot.value, None, "{name}");
    }
    let all = edges(&extraction);
    assert_eq!(of(&all, "P.get"), vec![("access", "P._y", "declared", READ)]);
    assert_eq!(of(&all, "P.__init__"), vec![("access", "P._x", "declared", WRITE)]);
    assert!(extraction.stats.drops.iter().all(|d| d.reason != "unbound-self-call"));
}

#[test]
fn a_name_bound_once_to_a_literal_import_module_is_that_module_by_flow() {
    let extraction = extract_sources(&[
        ("pkg/__init__.py", "def helper(): pass\n"),
        ("pkg/sub.py", "class Thing: pass\n"),
        (
            "m.py",
            "import importlib\njson_mod = importlib.import_module(\"json\")\nsub = importlib.import_module(\"pkg.sub\")\n\
             top = __import__(\"pkg.sub\")\nlater = importlib.import_module(name)\n\
             def f():\n    json_mod.dumps(1)\n    sub.Thing()\n    top.helper()\n    later.anything()\n",
        ),
    ]);
    let all = edges(&extraction);
    // `__import__("pkg.sub")` is `pkg`, as the interpreter returns it; a computed name types nothing.
    assert_eq!(
        of(&all, "f"),
        vec![
            ("access", "json_mod", "declared", READ),
            ("access", "later", "declared", READ),
            ("access", "sub", "declared", READ),
            ("access", "top", "declared", READ),
            ("invocation", "<stdlib>%2Fjson", "derived", None),
            ("invocation", "pkg%2F__init__.py/helper", "derived", None),
            ("invocation", "pkg%2Fsub.py/Thing", "derived", None),
        ]
    );
    let untyped: Vec<&str> = extraction
        .stats
        .drops
        .iter()
        .filter(|d| d.reason == "untyped-receiver")
        .map(|d| d.what.as_str())
        .collect();
    assert_eq!(untyped, vec!["later.anything()"]);
}
