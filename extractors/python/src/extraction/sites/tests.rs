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
    // `self.items.append`, `len`, `print`: resolved, counted, no edge.
    assert_eq!(stats.language, 3);
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
