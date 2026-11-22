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
        ]
    );
    // The annotation names the class from the parameter it types.
    assert_eq!(
        of(&all, "use#param:repo"),
        vec![("reference", "repo:Repo", "declared", None)]
    );
    // The one library class that could answer: `self.assertEqual`, `M.objects.filter()`, `self.save()`.
    assert_eq!(
        of(&all, "T.test"),
        vec![("invocation", "<stdlib>%2Funittest.case/TestCase", "derived", None)]
    );
    assert_eq!(
        of(&all, "M.go"),
        vec![
            ("invocation", "<site>%2Fdjango.db.models/Model", "derived", None),
            ("invocation", "<site>%2Fdjango.db.models/Model", "derived", None),
            // `M.objects` writes the class: referenced, as written.
            ("reference", "M", "declared", None),
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
    // From the TYPED entity — an attribute, a parameter — as Java, C# and TypeScript write it;
    // a return annotation from the invocable.
    assert_eq!(references("Service"), Vec::<&str>::new());
    assert_eq!(references("Service.repo"), vec!["Repo"]);
    assert_eq!(references("Service.cache"), vec!["Repo"]);
    assert_eq!(references("Service.session"), vec!["<site>%2Flib/Session"]);
    assert_eq!(
        references("Service.__init__#param:session"),
        vec!["<site>%2Flib/Session"]
    );
    // `list[Repo]` names no type but references the class inside it.
    assert_eq!(references("Service.__init__#param:items"), vec!["Repo"]);
    assert_eq!(references("Service.__init__"), Vec::<&str>::new());
    assert_eq!(references("Service.go"), vec!["Repo"]);
}

#[test]
fn an_annotation_with_no_typed_entity_stays_on_its_body_and_a_base_argument_is_its_class() {
    let extraction = extract_sources(&[(
        "m.py",
        "from typing import Generic, TypeVar, overload\nT = TypeVar(\"T\")\nclass Repo: pass\n\
         class Box(Generic[T]): pass\nclass Shelf(Box[Repo]): pass\n\
         def f():\n    local: Repo = Repo()\n\
         class C:\n    def total(self): pass\n    total: Repo\n\
         @overload\ndef g(spare: Repo) -> None: ...\ndef g(other=None): pass\n",
    )]);
    let all = edges(&extraction);
    let from = |source: &str| -> Vec<(&str, &str)> {
        of(&all, source)
            .into_iter()
            .filter(|edge| matches!(edge.0, "reference" | "access"))
            .map(|edge| (edge.0, edge.1))
            .collect()
    };
    // A base's subscript arguments are the class's dependencies.
    assert_eq!(from("Box"), vec![("access", "T")]);
    assert_eq!(from("Shelf"), vec![("reference", "Repo")]);
    // A local, a name a `def` holds, an overload signature's parameter: no typed entity, the body.
    assert_eq!(from("f"), vec![("reference", "Repo")]);
    assert_eq!(from("C"), vec![("reference", "Repo")]);
    assert_eq!(from("g"), vec![("reference", "Repo")]);
}

#[test]
fn a_literal_holds_values_and_annotated_one_type_with_its_metadata() {
    let extraction = extract_sources(&[(
        "m.py",
        "from typing import Annotated, Literal\nimport typing_extensions as te\nclass Op: pass\nclass Meta: pass\n\
         def f(op: Literal[\"add\", \"Op\"], x: Annotated[Op, \"remove\", Meta], y: te.Literal[\"stop\"]): pass\n",
    )]);
    let all = edges(&extraction);
    let references: Vec<&str> = all
        .iter()
        .filter(|edge| edge.0 == "reference" && matches!(edge.2.as_str(), "Op" | "Meta"))
        .map(|edge| edge.2.as_str())
        .collect();
    assert_eq!(references, vec!["Op"]);
    let drops: Vec<&str> = extraction.stats.drops.iter().map(|drop| drop.what.as_str()).collect();
    for value in ["add", "remove", "stop"] {
        assert!(!drops.contains(&value), "{value}: {drops:?}");
    }
}

#[test]
fn a_function_result_and_an_any_are_untyped_and_a_wrapper_types_what_it_wraps() {
    let extraction = extract_sources(&[(
        "m.py",
        "from typing import Any, Annotated\nfrom urllib.parse import urlparse\nclass Repo:\n    def save(self): pass\n\
         def f(u, x: Any, r: Annotated[Repo, \"meta\"]):\n    parsed = urlparse(u)\n    parsed.geturl()\n    x.anything()\n    r.save()\n",
    )]);
    let calls: Vec<(u32, String, &str)> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "invocation" || (e.kind == "access" && e.provenance == "derived"))
        .map(|e| (e.anchor.start, e.to.render(ids::LANG), e.provenance))
        .collect();
    assert_eq!(
        calls,
        vec![
            (6, "python:<stdlib>%2Furllib.parse".to_owned(), "declared"),
            (9, "python:m.py/Repo.save".to_owned(), "derived"),
        ]
    );
    let untyped: Vec<u32> = extraction
        .stats
        .drops
        .iter()
        .filter(|drop| drop.reason == "untyped-receiver")
        .map(|drop| drop.line)
        .collect();
    assert_eq!(untyped, vec![7, 8]);
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
        ("pkg/0001_initial.py", ""),
        (
            "m.py",
            "import importlib\nmod = importlib.import_module(\"json\")\nplugin = importlib.import_module(name)\n\
             legacy = __import__(\"pkg.sub\")\nbad = __import__(\"zipimport\\x00junk\")\n\
             migration = importlib.import_module(\"pkg.0001_initial\")\n",
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
            // A module file may begin with a digit: no statement imports it, `import_module` does.
            ("python:pkg%2F0001_initial.py".to_owned(), 6),
        ]
    );
    let drops: Vec<(&str, u32, &str)> = extraction
        .stats
        .drops
        .iter()
        .filter(|d| d.reason == "computed-import")
        .map(|d| (d.reason, d.line, d.what.as_str()))
        .collect();
    // A literal that is no dotted name of identifiers names no module: counted, no stub.
    assert_eq!(
        drops,
        vec![
            ("computed-import", 3, "importlib.import_module(name)"),
            ("computed-import", 5, "__import__(\"zipimport\\x00junk\")")
        ]
    );
    assert_eq!(extraction.stats.imports.stdlib, 2);
}

#[test]
fn a_corpus_class_written_as_the_receiver_of_a_member_a_library_answers_is_referenced() {
    let extraction = extract_sources(&[(
        "m.py",
        "from django.db import models\nclass Profile(models.Model):\n    def ping(self): pass\nclass Sub(Profile): pass\n\
         def f():\n    Profile.objects.all()\n    Sub.ping\n    Profile.missing\n\
         class Q(models.Model):\n    @classmethod\n    def make(cls):\n        return cls.objects.create()\n\
         \x20   def m(self):\n        return self.objects\n",
    )]);
    let rows: Vec<(String, &str, String, &str, u32, u32)> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind != "import" && e.kind != "inheritance")
        .map(|e| {
            (
                e.from.render(ids::LANG),
                e.kind,
                e.to.render(ids::LANG),
                e.provenance,
                e.anchor.start,
                e.anchor.end,
            )
        })
        .collect();
    let mut rows = rows;
    rows.sort();
    let model = "python:<site>%2Fdjango.db.models/Model".to_owned();
    let mut expected = vec![
        // The class is written at the site: a declared reference, at its name, beside the
        // member the one library ancestor answers.
        ("python:m.py/f".to_owned(), "invocation", model.clone(), "derived", 6, 6),
        (
            "python:m.py/f".to_owned(),
            "reference",
            "python:m.py/Profile".to_owned(),
            "declared",
            6,
            6,
        ),
        // A member a corpus ancestor declares is the edge itself.
        (
            "python:m.py/f".to_owned(),
            "reference",
            "python:m.py/Profile.ping".to_owned(),
            "declared",
            7,
            7,
        ),
        // A member nothing declares, which the library ancestor could answer: the same.
        ("python:m.py/f".to_owned(), "reference", model.clone(), "derived", 8, 8),
        (
            "python:m.py/f".to_owned(),
            "reference",
            "python:m.py/Profile".to_owned(),
            "declared",
            8,
            8,
        ),
        // `cls` and `self` write no class.
        (
            "python:m.py/Q.make".to_owned(),
            "invocation",
            model.clone(),
            "derived",
            12,
            12,
        ),
        ("python:m.py/Q.m".to_owned(), "reference", model, "derived", 14, 14),
    ];
    expected.sort();
    assert_eq!(rows, expected);
}

#[test]
fn a_standard_library_class_is_keyed_where_typeshed_declares_it_whatever_the_import_names() {
    let extraction = extract_sources(&[(
        "m.py",
        "import json\nimport unittest\nfrom unittest import TestCase\nfrom unittest.case import TestCase as Case\n\
         from collections import abc\nimport ConfigParser\n\
         class A(unittest.TestCase): pass\nclass B(TestCase): pass\nclass C(Case): pass\nclass Z(abc.Mapping): pass\n\
         class P(ConfigParser.RawConfigParser): pass\n\
         def f(text):\n    try:\n        return json.loads(text)\n    except json.JSONDecodeError:\n        return None\n",
    )]);
    let stub_classes: Vec<String> = extraction
        .model
        .entities
        .iter()
        .filter(|e| e.is_stub == Some(true) && e.kind == "class")
        .map(|e| e.key.render(ids::LANG))
        .collect();
    // One key per class: the module typeshed declares it in, the re-export followed. A Python 2
    // module the 2.7 list names carries no such data: as written.
    assert_eq!(
        stub_classes,
        vec![
            "python:<stdlib>%2FConfigParser/RawConfigParser",
            "python:<stdlib>%2Fjson.decoder/JSONDecodeError",
            "python:<stdlib>%2Ftyping/Mapping",
            "python:<stdlib>%2Funittest.case/TestCase",
        ]
    );
    // The import still names the module written.
    let imports: Vec<String> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "import")
        .map(|e| e.to.render(ids::LANG))
        .collect();
    assert!(
        imports.contains(&"python:<stdlib>%2Funittest".to_owned()),
        "{imports:?}"
    );
}

#[test]
fn a_site_class_reached_through_an_imported_name_is_keyed_at_the_dotted_module_and_counted() {
    let extraction = extract_sources(&[
        (
            "m.py",
            "from django.db import models\nfrom rest import Base\nfrom flask import request\n\
             class O(models.Model): pass\nclass P(Base): pass\ndef view():\n    return request.get_json()\n",
        ),
        // The other two spellings, where no guess is needed.
        ("n.py", "from django.db.models import Model\nclass Q(Model): pass\n"),
        (
            "o.py",
            "import django.db.models\nclass R(django.db.models.Model): pass\n",
        ),
    ]);
    let stub_classes: Vec<String> = extraction
        .model
        .entities
        .iter()
        .filter(|e| e.is_stub == Some(true) && e.kind == "class")
        .map(|e| e.key.render(ids::LANG))
        .collect();
    // Three spellings of one class, one key: every segment before the last is module path.
    assert_eq!(
        stub_classes,
        vec!["python:<site>%2Fdjango.db.models/Model", "python:<site>%2Frest/Base"]
    );
    // A guess, counted: `models` could be a class or a value of `django.db`, not a submodule.
    assert_eq!(extraction.stats.dotted_site_classes, 1);
    assert!(extraction.stats.summary().contains("dotted-site-class"));
    // A library function or value still folds to the module the import names; the import as written.
    let calls: Vec<String> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "invocation")
        .map(|e| e.to.render(ids::LANG))
        .collect();
    assert_eq!(calls, vec!["python:<site>%2Fflask"]);
    let imports: Vec<String> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "import")
        .map(|e| e.to.render(ids::LANG))
        .collect();
    assert!(imports.contains(&"python:<site>%2Fdjango.db".to_owned()), "{imports:?}");
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
            row("T", "<stdlib>%2Funittest.case/TestCase"),
            row("M", "<site>%2Fdjango.db.models/Model"),
        ]
    );
    // What an ancestor reached only through an alias answers rests on the same inference.
    let all = edges(&extraction);
    assert_eq!(of(&all, "A.go"), vec![("invocation", "Real.ping", "derived", None)]);
    assert_eq!(
        of(&all, "T.test"),
        vec![("invocation", "<stdlib>%2Funittest.case/TestCase", "derived", None)]
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

#[test]
fn overloads_and_their_implementation_are_one_function_anchored_at_the_implementation() {
    let extraction = extract_sources(&[(
        "m.py",
        "from typing import overload\nfrom lib import Order\n\
         @overload\ndef total(order: Order) -> int: ...\n@overload\ndef total(order: None) -> None: ...\n\
         def total(order=None):\n    \"\"\"The implementation.\"\"\"\n    return 0\n\
         @overload\ndef only(x: Order) -> Order: ...\n@overload\ndef only(x: int) -> int: ...\n",
    )]);
    let entity = |rendered: &str| super::super::tests::entity(&extraction, rendered);
    let total = entity("python:m.py/total");
    assert_eq!(total.anchor.as_ref().map(|a| (a.start, a.end)), Some((7, 9)));
    assert_eq!(total.signature.as_deref(), Some("total(order=…)"));
    assert_eq!(total.comments, Some(vec!["The implementation.".to_owned()]));
    // The implementation's types: it writes none; the signatures' names are still read.
    let order = entity("python:m.py/total#param:order");
    assert_eq!(
        (order.declared_type.is_none(), order.value.as_deref().cloned()),
        (true, Some(codegraph_model::Literal::Null))
    );
    let all = edges(&extraction);
    assert_eq!(
        of(&all, "total"),
        vec![("reference", "<site>%2Flib/Order", "declared", None)]
    );
    // Signatures alone (a stub's): the first.
    let only = entity("python:m.py/only");
    assert_eq!(only.anchor.as_ref().map(|a| (a.start, a.end)), Some((11, 11)));
    assert_eq!(
        entity("python:m.py/only#param:x")
            .declared_type
            .as_ref()
            .map(|key| key.render(ids::LANG)),
        Some("python:<site>%2Flib/Order".to_owned())
    );
}

#[test]
fn a_type_parameter_is_bound_where_its_class_or_def_is_read_and_is_no_attribute() {
    let extraction = extract_sources(&[(
        "m.py",
        "class Box[T]:\n    def put(self, item: T) -> T:\n        return item\n\
         class Crate[U](Box[U]):\n    def pick[V](self, item: V) -> U: ...\n\
         def first[W](items: list[W]) -> W:\n    return items[0]\n",
    )]);
    // No name unbound, no attribute: a type parameter belongs to no class.
    let drops: Vec<(&str, &str)> = extraction
        .stats
        .drops
        .iter()
        .map(|d| (d.reason, d.what.as_str()))
        .collect();
    assert_eq!(drops, vec![]);
    let kinds: Vec<(String, &str)> = super::super::tests::rendered(&extraction)
        .into_iter()
        .filter(|(_, kind)| !matches!(*kind, "parameter" | "module"))
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
            ("Box", "class"),
            ("Box.put", "method"),
            ("Crate", "class"),
            ("Crate.pick", "method"),
            ("first", "function"),
        ])
    );
    let bases: Vec<String> = extraction
        .model
        .edges
        .iter()
        .filter(|e| e.kind == "inheritance")
        .map(|e| e.to.render(ids::LANG))
        .collect();
    assert_eq!(bases, vec!["python:m.py/Box".to_owned()]);
}

const SHAPES: &str = "from .base import Base\n\n\ndef make_base():\n    return Base\n\n\n\
    class Dynamic(make_base()):\n    pass\n\n\ndef decorate(function):\n    return function\n\n\n\
    class Handler:\n    @decorate\n    def process(self):\n        return 1\n\n\n\
    def factory():\n    class Local(Base):\n        pass\n    return Local\n";

const MAIN: &str = "from app.shapes import Handler, factory\n\n\ndef go(handler):\n    return handler.process()\n\n\n\
    go(Handler())\nfactory()\n";

/// What `codegraph_trace.py` wrote running `main.py` under CPython 3.13 (calls on), and three
/// records no run would: a function on a line with no `def`, one outside the corpus, and a call
/// the baseline cannot place.
const TRACE: &str = r#"{"t":"header","tool":"codegraph-trace","version":"0.1.0","python":"3.13.18","root":"/work"}
{"t":"base","file":"app/base.py","class":"Base","index":0,"module":"builtins","name":"object"}
{"t":"base","file":"app/shapes.py","class":"Dynamic","index":0,"module":"app.base","name":"Base","at":"app/base.py"}
{"t":"base","file":"app/shapes.py","class":"Handler","index":0,"module":"builtins","name":"object"}
{"t":"base","file":"app/shapes.py","class":"factory.<locals>.Local","index":0,"module":"app.base","name":"Base","at":"app/base.py"}
{"t":"base","file":"lib/vendor.py","class":"Elsewhere","index":0,"module":"builtins","name":"object"}
{"t":"function","file":"app/shapes.py","line":12,"name":"decorate"}
{"t":"function","file":"app/shapes.py","line":17,"name":"Handler.process"}
{"t":"function","file":"app/shapes.py","line":22,"name":"factory"}
{"t":"function","file":"app/shapes.py","line":4,"name":"make_base"}
{"t":"function","file":"main.py","line":4,"name":"go"}
{"t":"function","file":"app/shapes.py","line":30,"name":"made"}
{"t":"function","file":"lib/vendor.py","line":1,"name":"helper"}
{"t":"call","file":"app/shapes.py","line":17,"name":"decorate","at":"app/shapes.py","def":12}
{"t":"call","file":"app/shapes.py","line":8,"name":"make_base","at":"app/shapes.py","def":4}
{"t":"call","file":"main.py","line":5,"name":"process","at":"app/shapes.py","def":17}
{"t":"call","file":"main.py","line":8,"name":"go","at":"main.py","def":4}
{"t":"call","file":"main.py","line":9,"name":"factory","at":"app/shapes.py","def":22}
{"t":"eof","bases":5,"functions":7,"calls":5}
"#;

/// `(kind, from, to, provenance, candidates)` of an edge a trace added.
type Added<'a> = (&'a str, String, String, &'a str, Option<Vec<String>>);

#[test]
fn a_trace_adds_the_bases_and_the_calls_no_line_writes_and_never_a_key() {
    let sources = [
        ("app/__init__.py", ""),
        ("app/base.py", "class Base:\n    pass\n"),
        ("app/shapes.py", SHAPES),
        ("main.py", MAIN),
    ];
    let plain = extract_sources(&sources);
    let trace = crate::trace::parse(TRACE).unwrap();
    let traced = super::super::tests::extract_traced(&sources, &trace);
    // The same entities: the trace names, it never keys.
    let keys = |extraction: &Extraction| super::super::tests::rendered(extraction);
    assert_eq!(keys(&traced), keys(&plain));
    let added: Vec<Added> = traced
        .model
        .edges
        .iter()
        .filter(|edge| !plain.model.edges.contains(edge))
        .map(|edge| {
            (
                edge.kind,
                edge.from.render(ids::LANG),
                edge.to.render(ids::LANG),
                edge.provenance,
                edge.candidates
                    .as_ref()
                    .map(|keys| keys.iter().map(|key| key.render(ids::LANG)).collect()),
            )
        })
        .collect();
    assert_eq!(
        added,
        vec![
            // `make_base()` returned it: a base the interpreter holds and no line writes.
            (
                "inheritance",
                "python:app%2Fshapes.py/Dynamic".to_owned(),
                "python:app%2Fbase.py/Base".to_owned(),
                "generated",
                None
            ),
            // `handler.process()` on a parameter: the call the run saw.
            (
                "invocation",
                "python:main.py/go".to_owned(),
                "python:app%2Fshapes.py/Handler.process".to_owned(),
                "dynamic-candidate",
                Some(vec!["python:app%2Fshapes.py/Handler.process".to_owned()])
            ),
        ]
    );
    let summary = traced.stats.summary();
    for line in [
        "  trace bases     : 5 (3 in the source, 1 added as generated, 1 outside the corpus)\n",
        "  trace functions : 7 (5 written, 1 defined at run time — no entity, 1 outside the corpus)\n",
        "  trace calls     : 5 (3 in the model, 1 bound to 1 dynamic-candidate edges, 1 unmatched, 0 to a run-time definition, 0 outside the corpus)\n",
    ] {
        assert!(summary.contains(line), "{line}{summary}");
    }
}
