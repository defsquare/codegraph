use super::*;
use crate::corpus;

fn read(source: &str) -> FileDecls {
    declarations(source, &corpus::line_starts(source))
}

fn names(bindings: &[Binding]) -> Vec<&str> {
    bindings.iter().map(|binding| binding.name.as_str()).collect()
}

#[test]
fn records_classes_and_defs_at_every_nesting_with_the_scope_each_is_written_in() {
    let decls = read(
        "import os\n\
             class Order(Base, metaclass=Meta):\n    class Line:\n        pass\n    def total(self):\n        def helper():\n            pass\n        return helper()\n\
             def make():\n    class Local(Order.Line):\n        pass\n    return Local\n",
    );
    assert_eq!(decls.errors, 0);
    let classes: Vec<(&str, usize, Span)> = decls
        .classes
        .iter()
        .map(|c| (c.name.as_str(), c.scope, c.span))
        .collect();
    let functions: Vec<(&str, usize, Span)> = decls
        .functions
        .iter()
        .map(|f| (f.name.as_str(), f.scope, f.span))
        .collect();
    // Scopes follow the source: Order's body 1, Line's 2, total's 3, helper's 4, make's 5, Local's 6.
    assert_eq!(
        classes,
        vec![("Order", 0, (2, 8)), ("Line", 1, (3, 4)), ("Local", 5, (10, 11))]
    );
    assert_eq!(
        functions,
        vec![("total", 1, (5, 8)), ("helper", 3, (6, 7)), ("make", 0, (9, 12))]
    );
    let kinds: Vec<ScopeKind> = decls.scopes.iter().map(|scope| scope.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ScopeKind::Module,
            ScopeKind::Class(0),
            ScopeKind::Class(1),
            ScopeKind::Function(0),
            ScopeKind::Function(1),
            ScopeKind::Function(2),
            ScopeKind::Class(2),
        ]
    );
    assert_eq!(decls.scopes[4].parent, Some(3));
    assert_eq!(names(&decls.scopes[0].bindings), vec!["os", "Order", "make"]);
    assert_eq!(decls.scopes[0].bindings[1].bound, Bound::Class(0));
    assert_eq!(names(&decls.scopes[1].bindings), vec!["Line", "total"]);
    assert_eq!(names(&decls.scopes[5].bindings), vec!["Local"]);
    // A keyword of the header is no base.
    assert_eq!(decls.classes[0].bases.len(), 1);
    assert_eq!(
        decls.classes[0].bases[0].reference,
        Reference::Dotted(vec!["Base".into()])
    );
    assert_eq!(
        decls.classes[2].bases[0],
        BaseDecl {
            reference: Reference::Dotted(vec!["Order".into(), "Line".into()]),
            span: (10, 10),
            text: "Order.Line".into(),
        }
    );
}

#[test]
fn reads_a_base_as_the_header_writes_it() {
    let decls = read(
        "class A(Generic[T]): pass\nclass B(typing.Generic[T], Base[int]): pass\nclass C(make_base()): pass\n\
             class D(*bases): pass\nclass E(\n    six.with_metaclass(\n        Meta, Base)\n): pass\n",
    );
    let bases: Vec<Vec<(Reference, &str)>> = decls
        .classes
        .iter()
        .map(|class| {
            class
                .bases
                .iter()
                .map(|base| (base.reference.clone(), base.text.as_str()))
                .collect()
        })
        .collect();
    let dotted = |parts: &[&str]| Reference::Dotted(parts.iter().map(|part| (*part).to_owned()).collect());
    assert_eq!(bases[0], vec![(dotted(&["Generic"]), "Generic[T]")]);
    assert_eq!(
        bases[1],
        vec![
            (dotted(&["typing", "Generic"]), "typing.Generic[T]"),
            (dotted(&["Base"]), "Base[int]")
        ]
    );
    // A call is no dotted name: its callee and arguments are kept for the resolver to judge.
    assert_eq!(
        bases[2],
        vec![(
            Reference::Call(Chain::Name("make_base".into()), Vec::new()),
            "make_base()"
        )]
    );
    assert_eq!(bases[3], vec![(Reference::Computed, "*bases")]);
    // A base over several lines is anchored on all of them, and explained on one.
    assert!(
        matches!(&bases[4][0], (Reference::Call(_, arguments), "six.with_metaclass( Meta, Base)") if arguments.len() == 2)
    );
    assert_eq!(decls.classes[4].bases[0].span, (6, 7));
}

#[test]
fn records_every_parameter_shape() {
    let decls = read("def every(a, b=1, /, c=2, *args, d, e=3, **kwargs): pass\ndef keywords(*, key): pass\n");
    let shapes: Vec<(&str, ParameterKind, bool)> = decls.functions[0]
        .parameters
        .iter()
        .map(|p| (p.name.as_str(), p.kind, p.has_default))
        .collect();
    assert_eq!(
        shapes,
        vec![
            ("a", ParameterKind::PositionalOnly, false),
            ("b", ParameterKind::PositionalOnly, true),
            ("c", ParameterKind::Positional, true),
            ("args", ParameterKind::VarArgs, false),
            ("d", ParameterKind::KeywordOnly, false),
            ("e", ParameterKind::KeywordOnly, true),
            ("kwargs", ParameterKind::VarKeywords, false),
        ]
    );
    assert_eq!(decls.functions[1].parameters[0].kind, ParameterKind::KeywordOnly);
    assert_eq!(decls.functions[0].parameters[0].span, (1, 1));
}

#[test]
fn tells_a_property_accessor_by_the_word_after_the_dot() {
    let decls = read(
        "class Order:\n    @property\n    def total(self): ...\n    @total.setter\n    def total(self, value): ...\n\
             \x20   @total.deleter\n    def total(self): ...\n    @total.setter\n    def other(self, value): ...\n\
             @total.setter\ndef total(value): ...\n",
    );
    let accessors: Vec<(&str, Option<&str>)> = decls.functions.iter().map(|f| (f.name.as_str(), f.accessor)).collect();
    assert_eq!(
        accessors,
        vec![
            ("total", None),
            ("total", Some("setter")),
            ("total", Some("deleter")),
            // Another name binds another property; outside a class, nothing is an accessor.
            ("other", None),
            ("total", None),
        ]
    );
}

#[test]
fn records_every_import_wherever_written_and_marks_the_type_checking_ones() {
    let decls = read(
        "import a.b.c, d as e\nfrom . import x\nfrom ..pkg.mod import y as z, *\n\
             def f():\n    import inner\n\
             if TYPE_CHECKING:\n    from .order import Order\nelse:\n    import runtime\n\
             if typing.TYPE_CHECKING:\n    import checked\n",
    );
    let alias = |name: &str, asname: Option<&str>| Alias {
        name: name.into(),
        asname: asname.map(str::to_owned),
    };
    let kinds: Vec<(&ImportKind, Span, bool)> = decls
        .imports
        .iter()
        .map(|i| (&i.kind, i.span, i.type_checking))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (
                &ImportKind::Modules(vec![alias("a.b.c", None), alias("d", Some("e"))]),
                (1, 1),
                false
            ),
            (
                &ImportKind::From {
                    level: 1,
                    module: None,
                    names: vec![alias("x", None)]
                },
                (2, 2),
                false
            ),
            (
                &ImportKind::From {
                    level: 2,
                    module: Some("pkg.mod".into()),
                    names: vec![alias("y", Some("z")), alias("*", None)],
                },
                (3, 3),
                false
            ),
            (&ImportKind::Modules(vec![alias("inner", None)]), (5, 5), false),
            (
                &ImportKind::From {
                    level: 1,
                    module: Some("order".into()),
                    names: vec![alias("Order", None)]
                },
                (7, 7),
                true
            ),
            (&ImportKind::Modules(vec![alias("runtime", None)]), (9, 9), false),
            (&ImportKind::Modules(vec![alias("checked", None)]), (11, 11), true),
        ]
    );
    // `import a.b.c` binds `a`; a star binds nothing a line names; an import in a function binds there.
    assert_eq!(
        names(&decls.scopes[0].bindings),
        vec!["a", "e", "x", "z", "f", "Order", "runtime", "checked"]
    );
    assert_eq!(decls.scopes[0].bindings[1].bound, Bound::Import { import: 0, alias: 1 });
    assert_eq!(names(&decls.scopes[1].bindings), vec!["inner"]);
}

#[test]
fn a_parameter_binds_in_its_function_before_anything_the_body_writes() {
    let decls = read("def make(Base, *rest, key=1):\n    class Local(Base): pass\n");
    let bound: Vec<(&str, Bound, u32)> = decls.scopes[1]
        .bindings
        .iter()
        .map(|binding| (binding.name.as_str(), binding.bound, binding.line))
        .collect();
    assert_eq!(
        bound,
        vec![
            ("Base", Bound::Parameter { function: 0, index: 0 }, 1),
            ("rest", Bound::Parameter { function: 0, index: 1 }, 1),
            ("key", Bound::Parameter { function: 0, index: 2 }, 1),
            ("Local", Bound::Class(0), 2),
        ]
    );
}

#[test]
fn binds_what_every_statement_binds_and_hears_global_and_nonlocal() {
    let decls = read(
        "x = y = 1\na, (b, *c) = t\nn: int = 0\nfor i, j in pairs: pass\nwith open() as (f, g): pass\n\
             try:\n    pass\nexcept E as err:\n    pass\ndel gone\nobj.attr = 1\nitems[0] = 2\n\
             match v:\n    case {\"k\": captured, **rest}: pass\n    case [first, *others]: pass\n\
             type Alias = int\n\
             def f():\n    global x\n    nonlocal_free = 1\n    def g():\n        nonlocal nonlocal_free\n",
    );
    assert_eq!(
        names(&decls.scopes[0].bindings),
        vec![
            "x", "y", "a", "b", "c", "n", "i", "j", "f", "g", "err", "gone", "captured", "rest", "first", "others",
            "Alias", "f"
        ]
    );
    // An assignment binds what it assigns; a loop, a with, an unpacking, an except, a del, a capture
    // and a type alias bind a value no line types.
    let assigned: Vec<&str> = decls.scopes[0]
        .bindings
        .iter()
        .take(17)
        .filter(|binding| matches!(binding.bound, Bound::Assigned(_)))
        .map(|binding| binding.name.as_str())
        .collect();
    assert_eq!(assigned, vec!["x", "y", "n"]);
    assert!(
        decls.scopes[0]
            .bindings
            .iter()
            .take(17)
            .all(|binding| matches!(binding.bound, Bound::Assigned(_) | Bound::Value))
    );
    assert_eq!(decls.scopes[1].globals, vec!["x"]);
    assert_eq!(names(&decls.scopes[1].bindings), vec!["nonlocal_free", "g"]);
    assert_eq!(decls.scopes[2].nonlocals, vec!["nonlocal_free"]);
}

#[test]
fn reads_a_recovered_tree_and_drops_what_no_key_can_carry() {
    let decls = read(
        "class Report(object):\n    def render(self, order):\n        print \"Order\", `order`\n\
             def 1():\n    pass\n\
             def \u{fb01}nd(order): pass\ndef find(order): pass\n",
    );
    assert!(decls.errors > 0);
    assert_eq!(decls.classes[0].name, "Report");
    assert_eq!(
        decls.drops,
        vec![Dropped {
            reason: "unnamed-declaration",
            line: 4,
            what: "def".into(),
        }]
    );
    // The parser NFKC-normalizes identifiers, as the language does: one name.
    let defs: Vec<&str> = decls.functions.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(defs, vec!["render", "find", "find"]);
}

fn chains(decls: &FileDecls) -> Vec<(Chain, &SiteKind, usize)> {
    decls
        .sites
        .iter()
        .map(|site| (site.chain.clone(), &site.kind, site.scope))
        .collect()
}

fn name(text: &str) -> Chain {
    Chain::Name(text.into())
}

fn attribute(chain: Chain, text: &str) -> Chain {
    Chain::Attribute(Box::new(chain), text.into())
}

fn call(chain: Chain) -> Chain {
    Chain::Call(Box::new(chain))
}

#[test]
fn reads_a_body_as_sites_each_a_chain_from_its_head() {
    let decls = read(
        "def f(self, repo):\n    self.repo.find(key=1)\n    make().total\n    \"x\".upper()\n    super().save()\n    \
         items[0].name\n    print(len(repo))\n",
    );
    let found = chains(&decls);
    let load = &SiteKind::Load;
    assert!(found.contains(&(call(attribute(attribute(name("self"), "repo"), "find")), load, 1)));
    assert!(found.contains(&(attribute(call(name("make")), "total"), load, 1)));
    assert!(found.contains(&(call(attribute(Chain::Literal("str"), "upper")), load, 1)));
    assert!(found.contains(&(call(attribute(Chain::Super(None), "save")), load, 1)));
    // A subscript heads nothing a name types; what it indexes is read on its own.
    assert!(found.contains(&(attribute(Chain::Other, "name"), load, 1)));
    assert!(found.contains(&(name("items"), load, 1)));
    // A call's arguments are sites of their own.
    assert!(found.contains(&(call(name("print")), load, 1)));
    assert!(found.contains(&(call(name("len")), load, 1)));
    assert!(found.contains(&(name("repo"), load, 1)));
    let find = decls
        .sites
        .iter()
        .find(|site| site.text == "self.repo.find(key=1)")
        .unwrap();
    assert_eq!(
        find.arguments,
        vec![ArgumentDecl {
            keyword: Some("key".into()),
            value: ValueDecl::Number("1".into()),
            spread: false
        }]
    );
}

#[test]
fn gives_a_lambda_and_a_comprehension_scopes_their_code_owned_by_what_writes_them() {
    // scopes: 0 module, 1 f's, 2 the lambda's, 3 the comprehension's
    let decls = read("def f(xs):\n    key = lambda x: x.total\n    return [y for y in xs if (n := y)]\n");
    assert_eq!(decls.scopes[2].kind, ScopeKind::Lambda);
    assert_eq!(decls.scopes[3].kind, ScopeKind::Comprehension);
    assert_eq!((decls.scopes[2].owner, decls.scopes[3].owner), (1, 1));
    assert_eq!(names(&decls.scopes[2].bindings), vec!["x"]);
    assert_eq!(names(&decls.scopes[3].bindings), vec!["y"]);
    // A walrus in a comprehension binds in the function around it.
    assert_eq!(names(&decls.scopes[1].bindings), vec!["xs", "key", "n"]);
    assert!(chains(&decls).contains(&(attribute(name("x"), "total"), &SiteKind::Load, 2)));
    // A comprehension's branches are its function's: 1 + for + if.
    assert_eq!(decls.functions[0].cyclomatic, 3);
}

#[test]
fn records_assignments_with_their_value_their_constructor_and_their_annotation() {
    let decls = read(
        "MAX = 100\nNAME: str = \"x\"\nNEG = -2.5\nITEMS = [1, \"a\", None, True]\nAPP = Flask(__name__)\n\
         KIND = Kind.FAST\nMAP = {\"a\": 1}\nclass C:\n    def __init__(self):\n        self.repo: Repo = Repo()\n",
    );
    let value = |index: usize| decls.assignments[index].value.clone();
    assert_eq!(value(0), Some(ValueDecl::Number("100".into())));
    assert_eq!(value(1), Some(ValueDecl::Str("x".into())));
    assert_eq!(
        decls.assignments[1].annotation,
        Some(TypeExpr::Named(name("str"), (2, 2)))
    );
    assert_eq!(value(2), Some(ValueDecl::Number("-2.5".into())));
    assert_eq!(
        value(3),
        Some(ValueDecl::Array(vec![
            ValueDecl::Number("1".into()),
            ValueDecl::Str("a".into()),
            ValueDecl::None,
            ValueDecl::Bool(true)
        ]))
    );
    assert_eq!(value(4), Some(ValueDecl::Code("Flask(__name__)".into())));
    assert_eq!(
        decls.assignments[4]
            .constructed
            .as_ref()
            .map(|(callee, _)| callee.clone()),
        Some(name("Flask"))
    );
    assert_eq!(
        value(5),
        Some(ValueDecl::Name(attribute(name("Kind"), "FAST"), "Kind.FAST".into()))
    );
    assert!(matches!(value(6), Some(ValueDecl::Pairs(pairs, _)) if pairs.len() == 1));
    let repo = &decls.assignments[7];
    assert_eq!(
        repo.target,
        Target::Attribute {
            receiver: "self".into(),
            name: "repo".into()
        }
    );
    assert_eq!(repo.scope, 2);
    assert_eq!(repo.annotation, Some(TypeExpr::Named(name("Repo"), (10, 10))));
}

#[test]
fn records_a_decorator_with_its_arguments_and_how_a_method_is_bound() {
    let decls = read(
        "class C:\n    @app.route(\"/orders\", methods=[\"GET\"], **extra)\n    def index(self): ...\n    \
         @staticmethod\n    def make(): ...\n    @classmethod\n    def build(cls): ...\n    @property\n    def total(self): ...\n    \
         @overload\n    def get(self, x: int) -> int: ...\n",
    );
    let index = &decls.functions[0];
    assert_eq!(index.decorators[0].chain, attribute(name("app"), "route"));
    assert!(index.decorators[0].called);
    let arguments: Vec<(Option<&str>, bool)> = index.decorators[0]
        .arguments
        .iter()
        .map(|a| (a.keyword.as_deref(), a.spread))
        .collect();
    assert_eq!(arguments, vec![(None, false), (Some("methods"), false), (None, true)]);
    assert_eq!(index.head, 2);
    assert_eq!(index.span, (3, 3));
    let bindings: Vec<(MethodBinding, bool, bool)> = decls
        .functions
        .iter()
        .map(|f| (f.binding, f.property, f.overload))
        .collect();
    assert_eq!(
        bindings,
        vec![
            (MethodBinding::Instance, false, false),
            (MethodBinding::Static, false, false),
            (MethodBinding::Class, false, false),
            (MethodBinding::Instance, true, false),
            (MethodBinding::Instance, false, true),
        ]
    );
    assert_eq!(decls.functions[4].returns, Some(TypeExpr::Named(name("int"), (11, 11))));
}

#[test]
fn reads_an_annotation_as_types_a_string_one_included() {
    let decls = read("def f(a: Optional[Order], b: \"Repo\", c: Order | None, d: list[\"Line\"]) -> None: ...\n");
    let annotation = |index: usize| decls.functions[0].parameters[index].annotation.clone();
    assert_eq!(
        annotation(0),
        Some(TypeExpr::Generic(
            name("Optional"),
            (1, 1),
            vec![TypeExpr::Named(name("Order"), (1, 1))]
        ))
    );
    assert_eq!(annotation(1), Some(TypeExpr::Named(name("Repo"), (1, 1))));
    assert_eq!(
        annotation(2),
        Some(TypeExpr::Union(vec![
            TypeExpr::Named(name("Order"), (1, 1)),
            TypeExpr::None
        ]))
    );
    assert_eq!(
        annotation(3),
        Some(TypeExpr::Generic(
            name("list"),
            (1, 1),
            vec![TypeExpr::Named(name("Line"), (1, 1))]
        ))
    );
    assert_eq!(decls.functions[0].returns, Some(TypeExpr::None));
}

#[test]
fn records_raises_with_the_clause_that_types_them_and_every_except_type() {
    let decls = read(
        "def f():\n    try:\n        g()\n    except (KeyError, OrderError) as error:\n        raise error\n    \
         raise NotFound(\"x\") from None\n",
    );
    let kinds: Vec<(&Chain, &SiteKind)> = decls
        .sites
        .iter()
        .filter(|site| !matches!(site.kind, SiteKind::Load))
        .map(|site| (&site.chain, &site.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (&name("KeyError"), &SiteKind::Except),
            (&name("OrderError"), &SiteKind::Except),
            (
                &name("error"),
                &SiteKind::Raise {
                    handler: vec![name("KeyError"), name("OrderError")]
                }
            ),
            (&call(name("NotFound")), &SiteKind::Raise { handler: Vec::new() }),
        ]
    );
    // 1 + one except clause.
    assert_eq!(decls.functions[0].cyclomatic, 2);
}

#[test]
fn reads_docstrings_comment_blocks_and_code_lines() {
    let decls = read(
        "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\"\"\"The module.\"\"\"\n\n# An order.\n# Two lines.\n\
         class Order:\n    \"\"\"\n    Indented, cleaned.\n\n      Kept relative.\n    \"\"\"\n    # noqa: E501\n    \
         def f(self): ...  # trailing\n",
    );
    assert_eq!(decls.docstring.as_deref(), Some("The module."));
    assert_eq!(
        decls.classes[0].docstring.as_deref(),
        Some("Indented, cleaned.\n\n  Kept relative.")
    );
    // The shebang and the cookie are directives, not prose; a block keys on its last line.
    assert_eq!(
        decls.comments.get(&6).map(String::as_str),
        Some("An order.\nTwo lines.")
    );
    assert_eq!(
        decls.comment_above(decls.classes[0].head).map(String::as_str),
        Some("An order.\nTwo lines.")
    );
    assert!(!decls.comments.contains_key(&2) && !decls.comments.contains_key(&13));
    // Blank and comment-only lines are no code; a trailing comment leaves its line code.
    let code: Vec<usize> = (0..decls.code_lines.len())
        .filter(|line| decls.code_lines[*line])
        .map(|line| line + 1)
        .collect();
    assert_eq!(code, vec![3, 7, 8, 9, 11, 12, 14]);
    assert_eq!(decls.sloc(decls.classes[0].span), 6);
}

#[test]
fn a_comprehension_an_argument_or_a_head_holds_reads_its_own_targets() {
    let decls = read("def f(xs):\n    return sum(line.quantity for line in xs) + [y for y in xs].count(y.z)\n");
    let scope_of = |text: &str| {
        let site = decls.sites.iter().find(|site| site.text == text).expect(text);
        decls.scopes[site.scope].kind
    };
    assert_eq!(scope_of("line.quantity"), ScopeKind::Comprehension);
    // The head `[y for y in xs]` is a comprehension too; the argument `y.z` is read outside it.
    assert_eq!(scope_of("y"), ScopeKind::Comprehension);
    assert_eq!(scope_of("y.z"), ScopeKind::Function(0));
}

#[test]
fn a_named_tuple_a_typed_dict_or_an_enum_a_call_makes_at_module_level_is_a_class_of_the_binding() {
    let decls = read(
        "P = namedtuple(\"P\", \"x, y\")\nQ = NamedTuple(\"Q\", [(\"a\", int), (\"b\", str)])\n\
         T = TypedDict(\"T\", {\"k\": int})\nColor = enum.Enum(\"Color\", \"RED GREEN\")\n\
         class A(namedtuple(\"A\", [\"u\", \"v\"])): pass\n\
         def f():\n    L = namedtuple(\"L\", \"z\")\nN = namedtuple(name, \"z\")\n",
    );
    let forms: Vec<(&str, Option<&str>)> = decls
        .classes
        .iter()
        .map(|class| (class.name.as_str(), class.synthetic.as_ref().map(|s| s.form)))
        .collect();
    assert_eq!(
        forms,
        vec![
            ("P", Some("namedtuple")),
            ("Q", Some("NamedTuple")),
            ("T", Some("TypedDict")),
            ("Color", Some("Enum")),
            ("A", None),
        ]
    );
    let fields = |class: usize| -> Vec<&str> {
        decls.scopes[decls.classes[class].body]
            .bindings
            .iter()
            .map(|binding| binding.name.as_str())
            .collect()
    };
    assert_eq!(fields(0), vec!["x", "y"]);
    assert_eq!(fields(1), vec!["a", "b"]);
    assert_eq!(fields(2), vec!["k"]);
    assert_eq!(fields(3), vec!["RED", "GREEN"]);
    assert_eq!(fields(4), vec!["u", "v"]);
    assert!(matches!(&decls.classes[4].bases[0].reference, Reference::Synthetic(s) if s.form == "namedtuple"));
    let module = |name: &str| {
        decls.scopes[0]
            .bindings
            .iter()
            .find(|b| b.name == name)
            .map(|b| b.bound)
    };
    assert_eq!(module("P"), Some(Bound::Class(0)));
    // Not at module level, or no literal name: an assignment like any other.
    assert!(matches!(module("N"), Some(Bound::Assigned(_))));
    assert_eq!(decls.classes[0].span, (1, 1));
}

#[test]
fn a_literal_recovery_replaced_with_an_empty_expression_is_no_value() {
    // Python 2 octal and long literals: the parser recovers with an empty expression, no text.
    let decls = read("mode = 0660\nflags = 0777L\n");
    let values: Vec<Option<ValueDecl>> = decls.assignments.iter().map(|a| a.value.clone()).collect();
    assert_eq!(values, vec![Some(ValueDecl::Code(String::new())); 2]);
}
