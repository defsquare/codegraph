//! Pass 1 — what one file WRITES, as the extractor's own records: scopes and
//! the names each binds, classes, `def`s and parameters, imports, assignments,
//! and every SITE a body holds (a name read, an attribute and the shape of its
//! receiver, a call, a write, a raise, an `except` type), with decorators,
//! annotations, docstrings, comments and branches. THE ONLY FILE THAT NAMES A
//! TYPE OF THE PARSER: its API is internal and unversioned, so a bump of the
//! pinned tag breaks the build here or nowhere (a boundary test holds the line).

use ruff_python_ast::token::TokenKind;
use ruff_python_ast::visitor::{self, Visitor};
use ruff_python_ast::{self as ast, Expr, ExprContext, Mod, Number, Stmt};
use ruff_python_parser::{Mode, ParseOptions, parse_string_annotation, parse_unchecked};
use ruff_text_size::{Ranged, TextRange};
use std::collections::BTreeMap;

/// `(startLine, endLine)`, 1-based and inclusive.
pub type Span = (u32, u32);

/// Where names are bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeKind {
    Module,
    /// The body of `classes[i]`.
    Class(usize),
    /// The body of `functions[i]`.
    Function(usize),
    /// A lambda's: its parameters. Its code belongs to the invocable that writes it.
    Lambda,
    /// A comprehension's: its targets.
    Comprehension,
}

#[derive(Debug)]
pub struct Scope {
    pub kind: ScopeKind,
    /// The scope the construct owning this one is written in; `None` for the module.
    pub parent: Option<usize>,
    /// The scope whose ENTITY runs this one's code: itself for a module, a class
    /// or a function; the nearest of those for a lambda or a comprehension.
    pub owner: usize,
    /// Every name the scope binds, in source order — a name bound twice is listed twice.
    pub bindings: Vec<Binding>,
    pub globals: Vec<String>,
    pub nonlocals: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub name: String,
    pub bound: Bound,
    pub line: u32,
}

/// What a statement binds a name to, as far as the statement itself says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bound {
    Class(usize),
    Function(usize),
    /// `imports[import]`'s alias `alias`.
    Import {
        import: usize,
        alias: usize,
    },
    /// The owning function's parameter of that index: bound before its body runs.
    Parameter {
        function: usize,
        index: usize,
    },
    /// `assignments[i]`: `x = …`, `x: T = …`, `x += …`, `(x := …)`.
    Assigned(usize),
    /// A loop or `with` target, an unpacking, an `except … as`, a capture, a
    /// lambda's parameter: a value no line types.
    Value,
}

/// An expression as a lookup reads it: a head, then steps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Chain {
    Name(String),
    Attribute(Box<Chain>, String),
    /// The result of calling the inner chain.
    Call(Box<Chain>),
    /// `super()` — or `super(Class, …)`, the class written.
    Super(Option<String>),
    /// A literal: the builtin class it is an instance of.
    Literal(&'static str),
    /// A subscript, an operator, anything no name types.
    Other,
}

impl Chain {
    /// `a.b.c` → `["a", "b", "c"]`; `None` when the chain is not a dotted name.
    pub fn dotted(&self) -> Option<Vec<String>> {
        match self {
            Chain::Name(name) => Some(vec![name.clone()]),
            Chain::Attribute(inner, name) => {
                let mut out = inner.dotted()?;
                out.push(name.clone());
                Some(out)
            }
            _ => None,
        }
    }
}

/// A written value, before any name in it is resolved (METAMODEL §1.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValueDecl {
    Str(String),
    /// Canonical decimal text.
    Number(String),
    Bool(bool),
    None,
    /// A dotted name: a class, an enum member, a constant — the resolver decides.
    Name(Chain, String),
    Array(Vec<ValueDecl>),
    /// A dict display: keys and values, written order; and its source text, which is its literal.
    Pairs(Vec<(ValueDecl, ValueDecl)>, String),
    /// Constant-shaped, not folded (`-x`, `1 << 4`, an f-string): the source text.
    Unevaluated(String),
    /// Code — a call, a lambda, a comprehension: no value; the source text for an argument.
    Code(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArgumentDecl {
    /// The keyword written; `None` for a positional argument.
    pub keyword: Option<String>,
    pub value: ValueDecl,
    /// `*args` or `**kwargs` at the site: no argument a line can name.
    pub spread: bool,
}

/// An annotation, as the resolver needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypeExpr {
    /// `Order`, `models.Model`.
    Named(Chain, Span),
    /// `Optional[Order]`, `list[Order]`, `Repo[int]`: the subscripted name and its arguments.
    Generic(Chain, Span, Vec<TypeExpr>),
    /// `A | B`.
    Union(Vec<TypeExpr>),
    None,
    Other,
}

/// What a site does with the chain it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SiteKind {
    /// Read — and, when the chain ends in a call, called.
    Load,
    /// `chain = …`; `augmented` when it is also read (`+=`).
    Store { augmented: bool },
    /// `raise chain`; `handler` the types of the `except … as name` clause
    /// whose name the chain is, when it is one.
    Raise { handler: Vec<Chain> },
    /// A type an `except` clause names.
    Except,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Site {
    /// Where its names are looked up.
    pub scope: usize,
    pub chain: Chain,
    pub kind: SiteKind,
    /// The arguments of the chain's outermost call, when it ends in one.
    pub arguments: Vec<ArgumentDecl>,
    pub span: Span,
    /// The source text, on one line, for `--explain-dropped`.
    pub text: String,
}

/// A base as the header writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reference {
    /// `Base`, `models.Model`, `Generic[T]` (the subscripted name).
    Dotted(Vec<String>),
    /// A call (`namedtuple("P", "x y")`, `make_base()`): the callee and its arguments.
    Call(Chain, Vec<ArgumentDecl>),
    /// `namedtuple("A", "x y")`, `NamedTuple(…)`: a class a call makes, inherited from.
    Synthetic(Synthetic),
    /// A starred list, any other expression: what it is is known only when it runs.
    Computed,
}

/// A class a call makes — `P = namedtuple("P", "x y")`, a base `namedtuple(…)`: its form, by
/// name, and the callee as written, which the resolver checks is the standard library's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Synthetic {
    pub form: &'static str,
    pub callee: Chain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseDecl {
    pub reference: Reference,
    pub span: Span,
    /// The source text, on one line, for `--explain-dropped`.
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecoratorDecl {
    /// What the decorator names: the callee of `@dec(…)`, or `dec` itself.
    pub chain: Chain,
    /// `@dec(…)`: written with a call.
    pub called: bool,
    pub arguments: Vec<ArgumentDecl>,
    pub span: Span,
    pub text: String,
}

#[derive(Debug)]
pub struct ClassDecl {
    pub name: String,
    /// The scope the `class` statement is written in.
    pub scope: usize,
    /// Its own body's scope.
    pub body: usize,
    pub span: Span,
    /// The first line of the declaration, decorators included: a comment is above it.
    pub head: u32,
    pub bases: Vec<BaseDecl>,
    pub decorators: Vec<DecoratorDecl>,
    /// `metaclass=` is written: what the class holds is decided when it runs.
    pub metaclass: bool,
    pub docstring: Option<String>,
    /// Made by a call bound to a module-level name, not by a `class` statement.
    pub synthetic: Option<Synthetic>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParameterKind {
    PositionalOnly,
    Positional,
    VarArgs,
    KeywordOnly,
    VarKeywords,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParameterDecl {
    pub name: String,
    pub kind: ParameterKind,
    pub has_default: bool,
    pub default: Option<ValueDecl>,
    pub annotation: Option<TypeExpr>,
    pub span: Span,
}

/// How a `def` in a class body is bound: what its first parameter is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MethodBinding {
    Instance,
    Class,
    Static,
}

#[derive(Debug)]
pub struct FunctionDecl {
    pub name: String,
    pub scope: usize,
    pub body: usize,
    pub span: Span,
    /// The first line of the declaration, decorators included.
    pub head: u32,
    /// `@<name>.setter` / `.deleter` / `.getter` directly in a class body: the word after the dot.
    pub accessor: Option<&'static str>,
    /// `@property` (or `cached_property`) directly in a class body.
    pub property: bool,
    pub binding: MethodBinding,
    /// `@overload`: a signature, not the implementation.
    pub overload: bool,
    pub parameters: Vec<ParameterDecl>,
    pub returns: Option<TypeExpr>,
    pub decorators: Vec<DecoratorDecl>,
    pub docstring: Option<String>,
    /// 1 + the decision points of its own body (nested `def`s count for themselves).
    pub cyclomatic: u32,
}

/// What an assignment writes into.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Name(String),
    /// `receiver.name = …` with a bare name for receiver (`self.x`, `cls.x`).
    Attribute {
        receiver: String,
        name: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssignDecl {
    pub scope: usize,
    pub target: Target,
    pub value: Option<ValueDecl>,
    /// The value is a call: its callee, and its arguments.
    pub constructed: Option<(Chain, Vec<ArgumentDecl>)>,
    pub annotation: Option<TypeExpr>,
    pub augmented: bool,
    pub span: Span,
}

/// `import a.b.c as m` → name `a.b.c`, asname `m`; `from m import n` → name `n`; a star is `*`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alias {
    pub name: String,
    pub asname: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportKind {
    /// `import a.b.c [as m], …`
    Modules(Vec<Alias>),
    /// `from [.…]m import n [as k], …`; `level` counts the dots.
    From {
        level: u32,
        module: Option<String>,
        names: Vec<Alias>,
    },
}

#[derive(Debug)]
pub struct ImportDecl {
    pub span: Span,
    /// Written under `if TYPE_CHECKING:` — for a type checker, not for the program.
    pub type_checking: bool,
    pub kind: ImportKind,
}

/// A declaration no key can carry, counted where it is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub reason: &'static str,
    pub line: u32,
    pub what: String,
}

#[derive(Debug, Default)]
pub struct FileDecls {
    /// Syntax errors the parser recovered from.
    pub errors: usize,
    /// `scopes[0]` is the module; the others follow the source, a body after its header.
    pub scopes: Vec<Scope>,
    pub classes: Vec<ClassDecl>,
    pub functions: Vec<FunctionDecl>,
    pub imports: Vec<ImportDecl>,
    pub assignments: Vec<AssignDecl>,
    pub sites: Vec<Site>,
    pub drops: Vec<Dropped>,
    pub docstring: Option<String>,
    /// Per line (0-based): neither blank nor comment-only.
    pub code_lines: Vec<bool>,
    /// A block of `#` lines, by its last line; directives left out.
    pub comments: BTreeMap<u32, String>,
}

impl FileDecls {
    /// Source lines of code in a span (METAMODEL §3.8).
    pub fn sloc(&self, span: Span) -> u32 {
        let from = (span.0.max(1) - 1) as usize;
        let to = (span.1 as usize).min(self.code_lines.len());
        self.code_lines
            .get(from..to)
            .map(|lines| lines.iter().filter(|code| **code).count() as u32)
            .unwrap_or(0)
    }

    /// The `#` block directly above `line`.
    pub fn comment_above(&self, line: u32) -> Option<&String> {
        line.checked_sub(1).and_then(|last| self.comments.get(&last))
    }

    /// The scope whose entity runs the code of `scope`.
    pub fn owner(&self, scope: usize) -> usize {
        self.scopes[scope].owner
    }
}

/// Reads one decoded file.
pub fn declarations(text: &str, line_starts: &[u32]) -> FileDecls {
    let parsed = parse_unchecked(text, ParseOptions::from(Mode::Module));
    let mut reader = Reader {
        text,
        line_starts,
        out: FileDecls {
            errors: parsed.errors().len(),
            ..FileDecls::default()
        },
        scope: 0,
        type_checking: false,
        function: None,
        handlers: Vec::new(),
    };
    reader.scope(ScopeKind::Module, None);
    reader.comments(&parsed);
    if let Mod::Module(module) = parsed.syntax() {
        reader.out.docstring = docstring(&module.body);
        reader.visit_body(&module.body);
    }
    reader.out
}

/// When less than this much stack is left, a recursive walk moves to a fresh segment of `GROWTH`.
const RED_ZONE: usize = 128 * 1024;
const GROWTH: usize = 4 * 1024 * 1024;

const ACCESSORS: &[&str] = &["setter", "deleter", "getter"];
/// Calls that make a class: the standard library's forms, by the name a site calls them.
const SYNTHETIC_FORMS: &[&str] = &[
    "namedtuple",
    "NamedTuple",
    "TypedDict",
    "Enum",
    "IntEnum",
    "StrEnum",
    "Flag",
    "IntFlag",
];
const TUPLE_FORMS: &[&str] = &["namedtuple", "NamedTuple"];
const PROPERTIES: &[&str] = &["property", "cached_property", "abstractproperty"];
/// Comment lines that are instructions to a tool, not prose (PLAN §23.2).
const DIRECTIVES: &[&str] = &["type:", "noqa", "pylint:", "pragma:"];

/// `a.b.c` as its names; `None` for anything else, or a name recovery left empty.
fn dotted(expr: &Expr) -> Option<Vec<String>> {
    match expr {
        Expr::Name(name) if !name.id.is_empty() => Some(vec![name.id.to_string()]),
        Expr::Attribute(attribute) if attribute.attr.is_valid() => {
            let mut out = dotted(&attribute.value)?;
            out.push(attribute.attr.to_string());
            Some(out)
        }
        _ => None,
    }
}

/// The synthetic form a call is: a known name, called with a literal class name first.
fn synthetic_form(callee: &Expr, arguments: &[ArgumentDecl]) -> Option<&'static str> {
    let name = match callee {
        Expr::Name(name) => name.id.as_str(),
        Expr::Attribute(attribute) => attribute.attr.as_str(),
        _ => return None,
    };
    let form = SYNTHETIC_FORMS.iter().copied().find(|form| *form == name)?;
    let first = arguments
        .iter()
        .find(|argument| argument.keyword.is_none() && !argument.spread);
    matches!(
        first,
        Some(ArgumentDecl {
            value: ValueDecl::Str(_),
            ..
        })
    )
    .then_some(form)
}

/// The fields a synthetic form's literal arguments name: `"x y"`, `"x, y"`, `["x", "y"]`,
/// `[("x", int)]`, `{"x": int}`, or keywords (`NamedTuple("P", x=int)`).
fn synthetic_fields(form: &str, arguments: &[ArgumentDecl]) -> Vec<String> {
    let positional: Vec<&ValueDecl> = arguments
        .iter()
        .filter(|argument| argument.keyword.is_none() && !argument.spread)
        .map(|argument| &argument.value)
        .collect();
    let keyword = |name: &str| {
        arguments
            .iter()
            .find(|argument| argument.keyword.as_deref() == Some(name))
            .map(|argument| &argument.value)
    };
    let listed = positional.get(1).copied().or_else(|| match form {
        "namedtuple" => keyword("field_names"),
        "NamedTuple" | "TypedDict" => keyword("fields"),
        _ => keyword("names"),
    });
    let mut names: Vec<String> = match listed {
        Some(ValueDecl::Str(text)) => text
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect(),
        Some(ValueDecl::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                ValueDecl::Str(name) => Some(name.clone()),
                ValueDecl::Array(pair) => match pair.first() {
                    Some(ValueDecl::Str(name)) => Some(name.clone()),
                    _ => None,
                },
                _ => None,
            })
            .collect(),
        Some(ValueDecl::Pairs(pairs, _)) => pairs
            .iter()
            .filter_map(|(key, _)| match key {
                ValueDecl::Str(name) => Some(name.clone()),
                _ => None,
            })
            .collect(),
        _ if matches!(form, "NamedTuple" | "TypedDict") => arguments
            .iter()
            .filter_map(|argument| argument.keyword.clone())
            .filter(|name| !matches!(name.as_str(), "total" | "fields"))
            .collect(),
        _ => Vec::new(),
    };
    names.retain(|name| {
        name.chars().all(|c| c.is_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit())
    });
    names
}

fn last_name(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Name(name) => Some(name.id.to_string()),
        Expr::Attribute(attribute) => Some(attribute.attr.to_string()),
        Expr::Call(call) => last_name(&call.func),
        _ => None,
    }
}

/// `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:`.
fn is_type_checking(test: &Expr) -> bool {
    dotted(test).is_some_and(|names| names.last().is_some_and(|last| last == "TYPE_CHECKING"))
}

/// The builtin class a literal is an instance of.
fn literal_class(expr: &Expr) -> Option<&'static str> {
    Some(match expr {
        Expr::StringLiteral(_) | Expr::FString(_) => "str",
        Expr::BytesLiteral(_) => "bytes",
        Expr::NumberLiteral(number) => match number.value {
            Number::Int(_) => "int",
            Number::Float(_) => "float",
            Number::Complex { .. } => "complex",
        },
        Expr::BooleanLiteral(_) => "bool",
        Expr::NoneLiteral(_) => "NoneType",
        Expr::List(_) | Expr::ListComp(_) => "list",
        Expr::Dict(_) | Expr::DictComp(_) => "dict",
        Expr::Set(_) | Expr::SetComp(_) => "set",
        Expr::Tuple(_) => "tuple",
        _ => return None,
    })
}

/// A float as canonical decimal text; the specials as core spells them.
fn float_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        format!("{value}")
    }
}

/// `inspect.cleandoc`: the first line trimmed, the common indent of the rest removed, blank ends dropped.
fn cleandoc(text: &str) -> String {
    let lines: Vec<String> = text.replace('\t', "        ").lines().map(str::to_owned).collect();
    let indent = lines
        .iter()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for (at, line) in lines.iter().enumerate() {
        let line = if at == 0 {
            line.trim_start().to_owned()
        } else {
            line.get(indent..).unwrap_or("").to_owned()
        };
        out.push(line.trim_end().to_owned());
    }
    while out.first().is_some_and(String::is_empty) {
        out.remove(0);
    }
    while out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    out.join("\n")
}

/// A body's docstring: its first statement, when that is a string.
fn docstring(body: &[Stmt]) -> Option<String> {
    match body.first()? {
        Stmt::Expr(statement) => match statement.value.as_ref() {
            Expr::StringLiteral(text) => Some(cleandoc(text.value.to_str())).filter(|text| !text.is_empty()),
            _ => None,
        },
        _ => None,
    }
}

/// Whether the expression is a value a declaration can carry (the TypeScript
/// rule): literals, names, and operators over them — never code.
fn constant_shaped(expr: &Expr) -> bool {
    stacker::maybe_grow(RED_ZONE, GROWTH, || constant_shaped_here(expr))
}

fn constant_shaped_here(expr: &Expr) -> bool {
    match expr {
        Expr::StringLiteral(_)
        | Expr::BytesLiteral(_)
        | Expr::NumberLiteral(_)
        | Expr::BooleanLiteral(_)
        | Expr::NoneLiteral(_)
        | Expr::EllipsisLiteral(_)
        | Expr::Name(_)
        | Expr::Attribute(_) => true,
        Expr::UnaryOp(unary) => constant_shaped(&unary.operand),
        Expr::BinOp(binary) => constant_shaped(&binary.left) && constant_shaped(&binary.right),
        Expr::BoolOp(boolean) => boolean.values.iter().all(constant_shaped),
        Expr::Compare(compare) => compare.operands.iter().all(constant_shaped),
        Expr::If(branch) => {
            constant_shaped(&branch.test) && constant_shaped(&branch.body) && constant_shaped(&branch.orelse)
        }
        Expr::List(ast::ExprList { elts, .. })
        | Expr::Tuple(ast::ExprTuple { elts, .. })
        | Expr::Set(ast::ExprSet { elts, .. }) => {
            elts.iter().all(|item| !item.is_starred_expr() && constant_shaped(item))
        }
        _ => false,
    }
}

struct Reader<'a> {
    text: &'a str,
    line_starts: &'a [u32],
    out: FileDecls,
    /// The scope statements and expressions are being read in.
    scope: usize,
    type_checking: bool,
    /// The innermost `def` being read, whose branches the walk counts.
    function: Option<usize>,
    /// The `except … as name` clauses around the walk: name, types.
    handlers: Vec<(String, Vec<Chain>)>,
}

impl Reader<'_> {
    fn line(&self, offset: u32) -> u32 {
        self.line_starts.partition_point(|&start| start <= offset) as u32
    }

    /// The lines from `start` to the last character of `range`.
    fn span_from(&self, start: u32, range: TextRange) -> Span {
        let end = range.end().to_u32().saturating_sub(1).max(start);
        (self.line(start), self.line(end))
    }

    fn span(&self, range: TextRange) -> Span {
        self.span_from(range.start().to_u32(), range)
    }

    fn one_line(&self, range: TextRange) -> String {
        self.text[range].split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn scope(&mut self, kind: ScopeKind, parent: Option<usize>) -> usize {
        let index = self.out.scopes.len();
        let owner = match kind {
            ScopeKind::Lambda | ScopeKind::Comprehension => parent.map_or(0, |parent| self.out.scopes[parent].owner),
            _ => index,
        };
        self.out.scopes.push(Scope {
            kind,
            parent,
            owner,
            bindings: Vec::new(),
            globals: Vec::new(),
            nonlocals: Vec::new(),
        });
        index
    }

    fn bind(&mut self, scope: usize, name: &str, bound: Bound, offset: u32) {
        if name.is_empty() {
            return;
        }
        let line = self.line(offset);
        self.out.scopes[scope].bindings.push(Binding {
            name: name.to_owned(),
            bound,
            line,
        });
    }

    fn drop(&mut self, reason: &'static str, offset: u32, what: impl Into<String>) {
        let line = self.line(offset);
        self.out.drops.push(Dropped {
            reason,
            line,
            what: what.into(),
        });
    }

    fn branch(&mut self, count: u32) {
        if let Some(function) = self.function {
            self.out.functions[function].cyclomatic += count;
        }
    }

    /// The scope a walrus binds in: the nearest that is not a comprehension's.
    fn named_scope(&self) -> usize {
        let mut scope = self.scope;
        while self.out.scopes[scope].kind == ScopeKind::Comprehension {
            scope = self.out.scopes[scope].parent.unwrap_or(0);
        }
        scope
    }

    /// Code lines and `#` blocks from the tokens: a comment-only line is no code.
    fn comments(&mut self, parsed: &ruff_python_parser::Parsed<Mod>) {
        let text = self.text;
        let starts = self.line_starts;
        let mut code: Vec<bool> = (0..starts.len())
            .map(|line| {
                let from = starts[line] as usize;
                let to = starts.get(line + 1).map_or(text.len(), |&next| next as usize);
                !text[from..to].trim().is_empty()
            })
            .collect();
        let mut only: BTreeMap<u32, String> = BTreeMap::new();
        for token in parsed.tokens().iter() {
            if token.kind() != TokenKind::Comment {
                continue;
            }
            let start = token.range().start().to_u32();
            let line = self.line(start);
            let line_start = starts[(line - 1) as usize] as usize;
            if text[line_start..start as usize].trim().is_empty() {
                code[(line - 1) as usize] = false;
                only.insert(line, text[token.range()].trim_end().to_owned());
            }
        }
        let directive = |line: u32, comment: &str| {
            let body = comment.trim_start_matches('#').trim_start();
            (line == 1 && comment.starts_with("#!"))
                || (line <= 2 && (comment.contains("coding:") || comment.contains("coding=")))
                || DIRECTIVES.iter().any(|directive| body.starts_with(directive))
        };
        let mut blocks: BTreeMap<u32, String> = BTreeMap::new();
        let mut current: Vec<String> = Vec::new();
        let mut previous = 0u32;
        let flush = |current: &mut Vec<String>, last: u32, blocks: &mut BTreeMap<u32, String>| {
            while current.first().is_some_and(String::is_empty) {
                current.remove(0);
            }
            while current.last().is_some_and(String::is_empty) {
                current.pop();
            }
            if !current.is_empty() {
                blocks.insert(last, current.join("\n"));
            }
            current.clear();
        };
        for (line, comment) in &only {
            if previous != 0 && *line != previous + 1 {
                flush(&mut current, previous, &mut blocks);
            }
            if !directive(*line, comment) {
                let body = comment.trim_start_matches('#');
                current.push(body.strip_prefix(' ').unwrap_or(body).to_owned());
            }
            previous = *line;
        }
        if previous != 0 {
            flush(&mut current, previous, &mut blocks);
        }
        self.out.code_lines = code;
        self.out.comments = blocks;
    }

    // ----------------------------------------------------------- values ----

    /// What an expression writes as a value: a literal, a name, or its source.
    fn value(&self, expr: &Expr) -> ValueDecl {
        stacker::maybe_grow(RED_ZONE, GROWTH, || self.value_here(expr))
    }

    fn value_here(&self, expr: &Expr) -> ValueDecl {
        let source = || self.one_line(expr.range());
        match expr {
            Expr::StringLiteral(text) => ValueDecl::Str(text.value.to_str().to_owned()),
            Expr::NumberLiteral(number) => match &number.value {
                Number::Int(int) => {
                    let text = int.to_string();
                    if text.bytes().all(|b| b.is_ascii_digit()) {
                        ValueDecl::Number(text)
                    } else {
                        ValueDecl::Unevaluated(source())
                    }
                }
                Number::Float(value) => ValueDecl::Number(float_text(*value)),
                Number::Complex { .. } => ValueDecl::Unevaluated(source()),
            },
            Expr::UnaryOp(unary) if unary.op == ast::UnaryOp::USub => match self.value(&unary.operand) {
                ValueDecl::Number(text) if text == "0" => ValueDecl::Number(text),
                ValueDecl::Number(text) => ValueDecl::Number(format!("-{text}")),
                _ => ValueDecl::Unevaluated(source()),
            },
            Expr::BooleanLiteral(boolean) => ValueDecl::Bool(boolean.value),
            Expr::NoneLiteral(_) => ValueDecl::None,
            Expr::Name(_) | Expr::Attribute(_) => match dotted(expr) {
                Some(_) => ValueDecl::Name(self.chain(expr, &mut Vec::new()), source()),
                None => ValueDecl::Unevaluated(source()),
            },
            Expr::List(ast::ExprList { elts, .. })
            | Expr::Tuple(ast::ExprTuple { elts, .. })
            | Expr::Set(ast::ExprSet { elts, .. }) => {
                if elts.iter().all(|item| !item.is_starred_expr()) {
                    ValueDecl::Array(elts.iter().map(|item| self.value(item)).collect())
                } else {
                    ValueDecl::Code(source())
                }
            }
            Expr::Dict(dict) => {
                let pairs: Option<Vec<(ValueDecl, ValueDecl)>> = dict
                    .items
                    .iter()
                    .map(|item| item.key.as_ref().map(|key| (self.value(key), self.value(&item.value))))
                    .collect();
                pairs.map_or_else(|| ValueDecl::Code(source()), |pairs| ValueDecl::Pairs(pairs, source()))
            }
            other if constant_shaped(other) => ValueDecl::Unevaluated(source()),
            _ => ValueDecl::Code(source()),
        }
    }

    fn arguments(&self, arguments: &ast::Arguments) -> Vec<ArgumentDecl> {
        let mut out = Vec::with_capacity(arguments.args.len() + arguments.keywords.len());
        for argument in &arguments.args {
            out.push(ArgumentDecl {
                keyword: None,
                value: self.value(argument),
                spread: argument.is_starred_expr(),
            });
        }
        for keyword in &arguments.keywords {
            out.push(ArgumentDecl {
                keyword: keyword.arg.as_ref().map(|arg| arg.to_string()),
                value: self.value(&keyword.value),
                spread: keyword.arg.is_none(),
            });
        }
        out
    }

    // ------------------------------------------------------- annotations ----

    fn type_expr(&self, expr: &Expr) -> TypeExpr {
        stacker::maybe_grow(RED_ZONE, GROWTH, || self.type_expr_here(expr))
    }

    fn type_expr_here(&self, expr: &Expr) -> TypeExpr {
        match expr {
            Expr::NoneLiteral(_) => TypeExpr::None,
            Expr::Name(_) | Expr::Attribute(_) if dotted(expr).is_some() => {
                TypeExpr::Named(self.chain(expr, &mut Vec::new()), self.span(expr.range()))
            }
            Expr::Subscript(subscript) if dotted(&subscript.value).is_some() => {
                let arguments = match subscript.slice.as_ref() {
                    Expr::Tuple(tuple) => tuple.elts.iter().map(|item| self.type_expr(item)).collect(),
                    other => vec![self.type_expr(other)],
                };
                TypeExpr::Generic(
                    self.chain(&subscript.value, &mut Vec::new()),
                    self.span(subscript.value.range()),
                    arguments,
                )
            }
            Expr::BinOp(binary) if binary.op == ast::Operator::BitOr => {
                let mut members = Vec::new();
                for side in [binary.left.as_ref(), binary.right.as_ref()] {
                    match self.type_expr(side) {
                        TypeExpr::Union(inner) => members.extend(inner),
                        other => members.push(other),
                    }
                }
                TypeExpr::Union(members)
            }
            // A string annotation is an expression written in a string (PEP 563).
            Expr::StringLiteral(text) => match text.value.as_slice() {
                [single] => match parse_string_annotation(self.text, single) {
                    Ok(parsed) => self.type_expr(parsed.expr()),
                    Err(_) => TypeExpr::Other,
                },
                _ => TypeExpr::Other,
            },
            Expr::List(list) => TypeExpr::Union(list.elts.iter().map(|item| self.type_expr(item)).collect()),
            _ => TypeExpr::Other,
        }
    }

    // ------------------------------------------------------------ chains ----

    /// The chain an expression is; what lies beside it (call arguments, the
    /// operands of a head no name types) is left in `beside` for the walk.
    fn chain<'e>(&self, expr: &'e Expr, beside: &mut Vec<&'e Expr>) -> Chain {
        match expr {
            Expr::Name(name) if !name.id.is_empty() => Chain::Name(name.id.to_string()),
            Expr::Attribute(attribute) if attribute.attr.is_valid() => Chain::Attribute(
                Box::new(self.chain(&attribute.value, beside)),
                attribute.attr.to_string(),
            ),
            Expr::Call(call) => {
                beside.extend(call.arguments.args.iter());
                beside.extend(call.arguments.keywords.iter().map(|keyword| &keyword.value));
                if let Expr::Name(name) = call.func.as_ref()
                    && name.id.as_str() == "super"
                {
                    let class = call
                        .arguments
                        .args
                        .first()
                        .and_then(dotted)
                        .and_then(|names| names.last().cloned());
                    return Chain::Super(class);
                }
                Chain::Call(Box::new(self.chain(&call.func, beside)))
            }
            other => {
                beside.push(other);
                literal_class(other).map_or(Chain::Other, Chain::Literal)
            }
        }
    }

    fn site(&mut self, expr: &Expr, kind: SiteKind) {
        let mut beside = Vec::new();
        let chain = self.chain(expr, &mut beside);
        let arguments = match expr {
            Expr::Call(call) => self.arguments(&call.arguments),
            _ => Vec::new(),
        };
        self.out.sites.push(Site {
            scope: self.scope,
            chain,
            kind,
            arguments,
            span: self.span(expr.range()),
            text: self.one_line(expr.range()),
        });
        // An argument, or a head no name types: read where it is written — a comprehension or a
        // lambda among them opens its own scope.
        for inner in beside {
            self.visit_expr(inner);
        }
    }

    // --------------------------------------------------------- statements ----

    fn targets(&mut self, target: &Expr, assignment: Option<AssignDecl>) {
        let augmented = assignment.as_ref().is_some_and(|assignment| assignment.augmented);
        match target {
            Expr::Name(name) => {
                let scope = self.scope;
                let bound = match assignment {
                    Some(assignment) => {
                        self.out.assignments.push(AssignDecl {
                            target: Target::Name(name.id.to_string()),
                            ..assignment
                        });
                        Bound::Assigned(self.out.assignments.len() - 1)
                    }
                    None => Bound::Value,
                };
                self.bind(scope, name.id.as_str(), bound, name.start().to_u32());
                // A module global written from a function is an access to it.
                let global = self.out.scopes[scope]
                    .globals
                    .iter()
                    .any(|global| global == name.id.as_str());
                if global && self.out.scopes[scope].kind != ScopeKind::Module {
                    self.site(target, SiteKind::Store { augmented });
                }
            }
            Expr::Tuple(tuple) => {
                for item in &tuple.elts {
                    self.targets(item, None);
                }
            }
            Expr::List(list) => {
                for item in &list.elts {
                    self.targets(item, None);
                }
            }
            Expr::Starred(starred) => self.targets(&starred.value, None),
            Expr::Attribute(attribute) => {
                if let (Some(assignment), Expr::Name(receiver)) = (assignment, attribute.value.as_ref()) {
                    self.out.assignments.push(AssignDecl {
                        target: Target::Attribute {
                            receiver: receiver.id.to_string(),
                            name: attribute.attr.to_string(),
                        },
                        ..assignment
                    });
                }
                self.site(target, SiteKind::Store { augmented: false });
            }
            // `a[0] = …` reads `a`.
            other => self.visit_expr(other),
        }
    }

    fn assignment(&self, value: Option<&Expr>, annotation: Option<&Expr>, augmented: bool, span: Span) -> AssignDecl {
        let constructed = match value {
            Some(Expr::Call(call)) => Some((self.chain(&call.func, &mut Vec::new()), self.arguments(&call.arguments))),
            _ => None,
        };
        AssignDecl {
            scope: self.scope,
            target: Target::Name(String::new()),
            value: value.filter(|_| !augmented).map(|value| self.value(value)),
            constructed,
            annotation: annotation.map(|annotation| self.type_expr(annotation)),
            augmented,
            span,
        }
    }

    fn decorators(&mut self, decorators: &[ast::Decorator]) -> Vec<DecoratorDecl> {
        let mut out = Vec::with_capacity(decorators.len());
        for decorator in decorators {
            let expression = &decorator.expression;
            let (chain, called, arguments) = match expression {
                Expr::Call(call) => {
                    let chain = self.chain(&call.func, &mut Vec::new());
                    for argument in call
                        .arguments
                        .args
                        .iter()
                        .chain(call.arguments.keywords.iter().map(|k| &k.value))
                    {
                        self.visit_expr(argument);
                    }
                    (chain, true, self.arguments(&call.arguments))
                }
                other => (self.chain(other, &mut Vec::new()), false, Vec::new()),
            };
            out.push(DecoratorDecl {
                chain,
                called,
                arguments,
                span: self.span(decorator.range()),
                text: self.one_line(expression.range()),
            });
        }
        out
    }

    fn class(&mut self, class: &ast::StmtClassDef) {
        if !class.name.is_valid() {
            self.drop("unnamed-declaration", class.start().to_u32(), "class");
            return;
        }
        let decorators = self.decorators(&class.decorator_list);
        let mut bases = Vec::new();
        let mut metaclass = false;
        let mut fields: Vec<(String, u32)> = Vec::new();
        if let Some(arguments) = &class.arguments {
            for base in &arguments.args {
                let reference = match base {
                    Expr::Subscript(subscript) => {
                        // The arguments of `Generic[T]` are read where the class is written.
                        self.visit_expr(&subscript.slice);
                        dotted(&subscript.value).map_or(Reference::Computed, Reference::Dotted)
                    }
                    Expr::Call(call) => {
                        let callee = self.chain(&call.func, &mut Vec::new());
                        self.visit_expr(base);
                        let arguments = self.arguments(&call.arguments);
                        match synthetic_form(&call.func, &arguments).filter(|form| TUPLE_FORMS.contains(form)) {
                            Some(form) => {
                                let line = self.line(base.start().to_u32());
                                fields.extend(
                                    synthetic_fields(form, &arguments)
                                        .into_iter()
                                        .map(|field| (field, line)),
                                );
                                Reference::Synthetic(Synthetic { form, callee })
                            }
                            None => Reference::Call(callee, arguments),
                        }
                    }
                    other => match dotted(other) {
                        Some(names) => Reference::Dotted(names),
                        None => {
                            self.visit_expr(other);
                            Reference::Computed
                        }
                    },
                };
                bases.push(BaseDecl {
                    reference,
                    span: self.span(base.range()),
                    text: self.one_line(base.range()),
                });
            }
            for keyword in &arguments.keywords {
                metaclass |= keyword.arg.as_ref().is_some_and(|arg| arg.as_str() == "metaclass");
                self.visit_expr(&keyword.value);
            }
        }
        let index = self.out.classes.len();
        let body = self.out.scopes.len();
        let head = class
            .decorator_list
            .first()
            .map_or(class.name.start().to_u32(), |decorator| decorator.start().to_u32());
        self.out.classes.push(ClassDecl {
            name: class.name.to_string(),
            scope: self.scope,
            body,
            span: self.span_from(class.name.start().to_u32(), class.range()),
            head: self.line(head),
            bases,
            decorators,
            metaclass,
            docstring: docstring(&class.body),
            synthetic: None,
        });
        let scope = self.scope;
        self.bind(
            scope,
            class.name.as_str(),
            Bound::Class(index),
            class.name.start().to_u32(),
        );
        self.scope(ScopeKind::Class(index), Some(scope));
        // The fields a `namedtuple(…)` base makes are the class's.
        for (field, line) in fields {
            self.out.scopes[body].bindings.push(Binding {
                name: field,
                bound: Bound::Value,
                line,
            });
        }
        if let Some(parameters) = &class.type_params {
            for parameter in &parameters.type_params {
                self.bind(
                    body,
                    parameter.name().as_str(),
                    Bound::Value,
                    parameter.start().to_u32(),
                );
            }
        }
        let saved = std::mem::replace(&mut self.scope, body);
        let checking = std::mem::replace(&mut self.type_checking, false);
        self.visit_body(&class.body);
        self.scope = saved;
        self.type_checking = checking;
    }

    /// `P = namedtuple("P", "x y")` at module level: a class named by the binding, its literal
    /// fields bound in its body. `false` when the call is no such form.
    fn synthetic_class(&mut self, name: &ast::ExprName, call: &ast::ExprCall, span: Span) -> bool {
        let arguments = self.arguments(&call.arguments);
        let Some(form) = synthetic_form(&call.func, &arguments) else {
            return false;
        };
        let index = self.out.classes.len();
        let body = self.out.scopes.len();
        let fields = synthetic_fields(form, &arguments);
        self.out.classes.push(ClassDecl {
            name: name.id.to_string(),
            scope: self.scope,
            body,
            span,
            head: span.0,
            bases: Vec::new(),
            decorators: Vec::new(),
            metaclass: false,
            docstring: None,
            synthetic: Some(Synthetic {
                form,
                callee: self.chain(&call.func, &mut Vec::new()),
            }),
        });
        let scope = self.scope;
        self.bind(scope, name.id.as_str(), Bound::Class(index), name.start().to_u32());
        self.scope(ScopeKind::Class(index), Some(scope));
        for field in fields {
            self.out.scopes[body].bindings.push(Binding {
                name: field,
                bound: Bound::Value,
                line: span.0,
            });
        }
        true
    }

    fn function(&mut self, function: &ast::StmtFunctionDef) {
        if !function.name.is_valid() {
            self.drop("unnamed-declaration", function.start().to_u32(), "def");
            return;
        }
        let name = function.name.as_str();
        let in_class = matches!(self.out.scopes[self.scope].kind, ScopeKind::Class(_));
        let names: Vec<String> = function
            .decorator_list
            .iter()
            .filter_map(|decorator| last_name(&decorator.expression))
            .collect();
        let accessor = function
            .decorator_list
            .iter()
            .filter(|_| in_class)
            .find_map(|decorator| match &decorator.expression {
                Expr::Attribute(attribute) => match attribute.value.as_ref() {
                    Expr::Name(owner) if owner.id.as_str() == name => {
                        ACCESSORS.iter().copied().find(|word| attribute.attr.as_str() == *word)
                    }
                    _ => None,
                },
                _ => None,
            });
        let binding = if names.iter().any(|n| n == "staticmethod") {
            MethodBinding::Static
        } else if names.iter().any(|n| n == "classmethod") {
            MethodBinding::Class
        } else {
            MethodBinding::Instance
        };
        let decorators = self.decorators(&function.decorator_list);
        // Defaults are evaluated where the `def` is written.
        for parameter in function.parameters.iter_non_variadic_params() {
            if let Some(default) = &parameter.default {
                self.visit_expr(default);
            }
        }
        let parameters = self.parameters(&function.parameters);
        let index = self.out.functions.len();
        let body = self.out.scopes.len();
        let head = function
            .decorator_list
            .first()
            .map_or(function.name.start().to_u32(), |decorator| decorator.start().to_u32());
        self.out.functions.push(FunctionDecl {
            name: name.to_owned(),
            scope: self.scope,
            body,
            span: self.span_from(function.name.start().to_u32(), function.range()),
            head: self.line(head),
            accessor,
            property: in_class && names.iter().any(|n| PROPERTIES.contains(&n.as_str())),
            binding,
            overload: names.iter().any(|n| n == "overload"),
            parameters,
            returns: function.returns.as_deref().map(|returns| self.type_expr(returns)),
            decorators,
            docstring: docstring(&function.body),
            cyclomatic: 1,
        });
        let scope = self.scope;
        self.bind(scope, name, Bound::Function(index), function.name.start().to_u32());
        self.scope(ScopeKind::Function(index), Some(scope));
        let parameters: Vec<Binding> = self.out.functions[index]
            .parameters
            .iter()
            .enumerate()
            .map(|(at, parameter)| Binding {
                name: parameter.name.clone(),
                bound: Bound::Parameter {
                    function: index,
                    index: at,
                },
                line: parameter.span.0,
            })
            .collect();
        self.out.scopes[body].bindings.extend(parameters);
        if let Some(type_params) = &function.type_params {
            for parameter in &type_params.type_params {
                self.bind(
                    body,
                    parameter.name().as_str(),
                    Bound::Value,
                    parameter.start().to_u32(),
                );
            }
        }
        let saved = std::mem::replace(&mut self.scope, body);
        let checking = std::mem::replace(&mut self.type_checking, false);
        let outer = self.function.replace(index);
        let handlers = std::mem::take(&mut self.handlers);
        self.visit_body(&function.body);
        self.scope = saved;
        self.type_checking = checking;
        self.function = outer;
        self.handlers = handlers;
    }

    fn parameters(&mut self, parameters: &ast::Parameters) -> Vec<ParameterDecl> {
        let mut written: Vec<(&ast::Parameter, TextRange, ParameterKind, Option<&Expr>)> = Vec::new();
        for parameter in &parameters.posonlyargs {
            let default = parameter.default.as_deref();
            written.push((
                &parameter.parameter,
                parameter.range(),
                ParameterKind::PositionalOnly,
                default,
            ));
        }
        for parameter in &parameters.args {
            let default = parameter.default.as_deref();
            written.push((
                &parameter.parameter,
                parameter.range(),
                ParameterKind::Positional,
                default,
            ));
        }
        if let Some(parameter) = &parameters.vararg {
            written.push((parameter, parameter.range(), ParameterKind::VarArgs, None));
        }
        for parameter in &parameters.kwonlyargs {
            let default = parameter.default.as_deref();
            written.push((
                &parameter.parameter,
                parameter.range(),
                ParameterKind::KeywordOnly,
                default,
            ));
        }
        if let Some(parameter) = &parameters.kwarg {
            written.push((parameter, parameter.range(), ParameterKind::VarKeywords, None));
        }
        let mut out: Vec<ParameterDecl> = Vec::with_capacity(written.len());
        for (parameter, range, kind, default) in written {
            let name = parameter.name.as_str();
            if !parameter.name.is_valid() {
                self.drop("unnamed-declaration", range.start().to_u32(), "parameter");
            } else if out.iter().any(|seen| seen.name == name) {
                self.drop("duplicate-parameter", range.start().to_u32(), name);
            } else {
                out.push(ParameterDecl {
                    name: name.to_owned(),
                    kind,
                    has_default: default.is_some(),
                    default: default.map(|default| self.value(default)),
                    annotation: parameter
                        .annotation
                        .as_deref()
                        .map(|annotation| self.type_expr(annotation)),
                    span: self.span(range),
                });
            }
        }
        out
    }

    fn import(&mut self, import: &ast::StmtImport) {
        let index = self.out.imports.len();
        let scope = self.scope;
        let mut aliases = Vec::with_capacity(import.names.len());
        for alias in &import.names {
            if !alias.name.is_valid() {
                self.drop("unnamed-declaration", alias.start().to_u32(), "import");
                continue;
            }
            let dotted = alias.name.to_string();
            // `import a.b.c` binds `a`; `import a.b.c as m` binds `m`.
            let bound = match &alias.asname {
                Some(asname) => asname.to_string(),
                None => dotted.split('.').next().unwrap_or_default().to_owned(),
            };
            let at = Bound::Import {
                import: index,
                alias: aliases.len(),
            };
            self.bind(scope, &bound, at, alias.start().to_u32());
            aliases.push(Alias {
                name: dotted,
                asname: alias.asname.as_ref().map(|asname| asname.to_string()),
            });
        }
        self.out.imports.push(ImportDecl {
            span: self.span(import.range()),
            type_checking: self.type_checking,
            kind: ImportKind::Modules(aliases),
        });
    }

    fn import_from(&mut self, import: &ast::StmtImportFrom) {
        let index = self.out.imports.len();
        let scope = self.scope;
        let mut names = Vec::with_capacity(import.names.len());
        for alias in &import.names {
            if !alias.name.is_valid() {
                self.drop("unnamed-declaration", alias.start().to_u32(), "import");
                continue;
            }
            let name = alias.name.to_string();
            // A star binds what the target exports: no name this line writes.
            if name != "*" {
                let bound = alias.asname.as_ref().map_or(name.clone(), |asname| asname.to_string());
                let at = Bound::Import {
                    import: index,
                    alias: names.len(),
                };
                self.bind(scope, &bound, at, alias.start().to_u32());
            }
            names.push(Alias {
                name,
                asname: alias.asname.as_ref().map(|asname| asname.to_string()),
            });
        }
        let module = import
            .module
            .as_ref()
            .filter(|module| module.is_valid())
            .map(|module| module.to_string());
        self.out.imports.push(ImportDecl {
            span: self.span(import.range()),
            type_checking: self.type_checking,
            kind: ImportKind::From {
                level: import.level,
                module,
                names,
            },
        });
    }

    fn pattern_bindings(&mut self, pattern: &ast::Pattern) {
        let scope = self.scope;
        let capture = |reader: &mut Self, name: &Option<ast::Identifier>| {
            if let Some(name) = name {
                reader.bind(scope, name.as_str(), Bound::Value, name.start().to_u32());
            }
        };
        match pattern {
            ast::Pattern::MatchAs(matched) => {
                if let Some(inner) = &matched.pattern {
                    self.pattern_bindings(inner);
                }
                capture(self, &matched.name);
            }
            ast::Pattern::MatchStar(star) => capture(self, &star.name),
            ast::Pattern::MatchMapping(mapping) => {
                for inner in &mapping.patterns {
                    self.pattern_bindings(inner);
                }
                capture(self, &mapping.rest);
            }
            ast::Pattern::MatchSequence(sequence) => {
                for inner in &sequence.patterns {
                    self.pattern_bindings(inner);
                }
            }
            ast::Pattern::MatchOr(alternatives) => {
                for inner in &alternatives.patterns {
                    self.pattern_bindings(inner);
                }
            }
            ast::Pattern::MatchClass(class) => {
                for inner in &class.arguments.patterns {
                    self.pattern_bindings(inner);
                }
                for keyword in &class.arguments.keywords {
                    self.pattern_bindings(&keyword.pattern);
                }
            }
            ast::Pattern::MatchValue(_) | ast::Pattern::MatchSingleton(_) => {}
        }
    }

    fn comprehension(&mut self, generators: &[ast::Comprehension], inside: &mut dyn FnMut(&mut Self)) {
        // The first iterable is evaluated where the comprehension is written.
        if let Some(first) = generators.first() {
            self.visit_expr(&first.iter);
        }
        let parent = self.scope;
        let scope = self.scope(ScopeKind::Comprehension, Some(parent));
        let saved = std::mem::replace(&mut self.scope, scope);
        for (at, generator) in generators.iter().enumerate() {
            if at > 0 {
                self.visit_expr(&generator.iter);
            }
            self.targets(&generator.target, None);
            self.branch(1 + generator.ifs.len() as u32);
            for condition in &generator.ifs {
                self.visit_expr(condition);
            }
        }
        inside(self);
        self.scope = saved;
    }
}

impl<'a> Visitor<'a> for Reader<'_> {
    fn visit_stmt(&mut self, stmt: &'a Stmt) {
        match stmt {
            Stmt::ClassDef(class) => self.class(class),
            Stmt::FunctionDef(function) => self.function(function),
            Stmt::Import(import) => self.import(import),
            Stmt::ImportFrom(import) => self.import_from(import),
            Stmt::Assign(assign) => {
                self.visit_expr(&assign.value);
                let span = self.span(stmt.range());
                if let ([Expr::Name(name)], Expr::Call(call)) = (assign.targets.as_slice(), assign.value.as_ref())
                    && self.out.scopes[self.scope].kind == ScopeKind::Module
                    && self.synthetic_class(name, call, span)
                {
                    return;
                }
                for target in &assign.targets {
                    let assignment = self.assignment(Some(&assign.value), None, false, span);
                    self.targets(target, Some(assignment));
                }
            }
            Stmt::AugAssign(assign) => {
                self.visit_expr(&assign.value);
                let span = self.span(stmt.range());
                match assign.target.as_ref() {
                    Expr::Attribute(_) => self.site(&assign.target, SiteKind::Store { augmented: true }),
                    Expr::Name(_) => {
                        let assignment = self.assignment(Some(&assign.value), None, true, span);
                        self.targets(&assign.target, Some(assignment));
                    }
                    other => self.visit_expr(other),
                }
            }
            Stmt::AnnAssign(assign) => {
                if let Some(value) = &assign.value {
                    self.visit_expr(value);
                }
                let span = self.span(stmt.range());
                let assignment = self.assignment(assign.value.as_deref(), Some(&assign.annotation), false, span);
                self.targets(&assign.target, Some(assignment));
            }
            Stmt::Delete(delete) => {
                for target in &delete.targets {
                    match target {
                        Expr::Attribute(_) => self.site(target, SiteKind::Store { augmented: false }),
                        other => self.targets(other, None),
                    }
                }
            }
            Stmt::TypeAlias(alias) => {
                if let Expr::Name(name) = alias.name.as_ref() {
                    let scope = self.scope;
                    self.bind(scope, name.id.as_str(), Bound::Value, name.start().to_u32());
                }
            }
            Stmt::Global(global) => {
                let names = global.names.iter().map(|name| name.to_string());
                self.out.scopes[self.scope].globals.extend(names);
            }
            Stmt::Nonlocal(nonlocal) => {
                let names = nonlocal.names.iter().map(|name| name.to_string());
                self.out.scopes[self.scope].nonlocals.extend(names);
            }
            Stmt::For(each) => {
                self.branch(1);
                self.visit_expr(&each.iter);
                self.targets(&each.target, None);
                self.visit_body(&each.body);
                self.visit_body(&each.orelse);
            }
            Stmt::While(each) => {
                self.branch(1);
                self.visit_expr(&each.test);
                self.visit_body(&each.body);
                self.visit_body(&each.orelse);
            }
            Stmt::If(branch) => {
                self.branch(1);
                self.visit_expr(&branch.test);
                let checking = self.type_checking;
                self.type_checking = checking || is_type_checking(&branch.test);
                self.visit_body(&branch.body);
                self.type_checking = checking;
                for clause in &branch.elif_else_clauses {
                    if let Some(test) = &clause.test {
                        self.branch(1);
                        self.visit_expr(test);
                    }
                    self.visit_body(&clause.body);
                }
            }
            Stmt::With(with) => {
                for item in &with.items {
                    self.visit_expr(&item.context_expr);
                    if let Some(target) = &item.optional_vars {
                        self.targets(target, None);
                    }
                }
                self.visit_body(&with.body);
            }
            Stmt::Try(attempt) => {
                self.visit_body(&attempt.body);
                for ast::ExceptHandler::ExceptHandler(handler) in &attempt.handlers {
                    self.branch(1);
                    let types: Vec<&Expr> = match handler.type_.as_deref() {
                        None => Vec::new(),
                        Some(Expr::Tuple(tuple)) => tuple.elts.iter().collect(),
                        Some(other) => vec![other],
                    };
                    let mut chains = Vec::with_capacity(types.len());
                    for type_ in types {
                        chains.push(self.chain(type_, &mut Vec::new()));
                        self.site(type_, SiteKind::Except);
                    }
                    let scope = self.scope;
                    match &handler.name {
                        Some(name) => {
                            self.bind(scope, name.as_str(), Bound::Value, name.start().to_u32());
                            self.handlers.push((name.to_string(), chains));
                            self.visit_body(&handler.body);
                            self.handlers.pop();
                        }
                        None => self.visit_body(&handler.body),
                    }
                }
                self.visit_body(&attempt.orelse);
                self.visit_body(&attempt.finalbody);
            }
            Stmt::Raise(raise) => {
                if let Some(exception) = &raise.exc {
                    let handler = match exception.as_ref() {
                        Expr::Name(name) => self
                            .handlers
                            .iter()
                            .rev()
                            .find(|(bound, _)| bound == name.id.as_str())
                            .map(|(_, types)| types.clone())
                            .unwrap_or_default(),
                        _ => Vec::new(),
                    };
                    self.site(exception, SiteKind::Raise { handler });
                }
                if let Some(cause) = &raise.cause {
                    self.visit_expr(cause);
                }
            }
            Stmt::Match(matching) => {
                self.visit_expr(&matching.subject);
                for case in &matching.cases {
                    let irrefutable = matches!(&case.pattern, ast::Pattern::MatchAs(matched) if matched.pattern.is_none())
                        && case.guard.is_none();
                    if !irrefutable {
                        self.branch(1);
                    }
                    self.pattern_bindings(&case.pattern);
                    visitor::walk_pattern(self, &case.pattern);
                    if let Some(guard) = &case.guard {
                        self.branch(1);
                        self.visit_expr(guard);
                    }
                    self.visit_body(&case.body);
                }
            }
            other => visitor::walk_stmt(self, other),
        }
    }

    fn visit_expr(&mut self, expr: &'a Expr) {
        stacker::maybe_grow(RED_ZONE, GROWTH, || self.expression(expr));
    }
}

impl Reader<'_> {
    fn expression(&mut self, expr: &Expr) {
        match expr {
            Expr::Name(name) if name.ctx == ExprContext::Load => self.site(expr, SiteKind::Load),
            Expr::Attribute(attribute) if attribute.ctx == ExprContext::Load => self.site(expr, SiteKind::Load),
            Expr::Call(_) => self.site(expr, SiteKind::Load),
            Expr::Named(named) => {
                self.visit_expr(&named.value);
                let scope = self.named_scope();
                let saved = std::mem::replace(&mut self.scope, scope);
                let span = self.span(expr.range());
                let assignment = self.assignment(Some(&named.value), None, false, span);
                self.targets(&named.target, Some(assignment));
                self.scope = saved;
            }
            Expr::Lambda(lambda) => {
                if let Some(parameters) = &lambda.parameters {
                    for parameter in parameters.iter_non_variadic_params() {
                        if let Some(default) = &parameter.default {
                            self.visit_expr(default);
                        }
                    }
                }
                let parent = self.scope;
                let scope = self.scope(ScopeKind::Lambda, Some(parent));
                if let Some(parameters) = &lambda.parameters {
                    for parameter in parameters.iter() {
                        let name = parameter.name();
                        self.bind(scope, name.as_str(), Bound::Value, name.start().to_u32());
                    }
                }
                let saved = std::mem::replace(&mut self.scope, scope);
                self.visit_expr(&lambda.body);
                self.scope = saved;
            }
            Expr::ListComp(comprehension) => {
                self.comprehension(&comprehension.generators, &mut |reader| {
                    reader.visit_expr(&comprehension.elt)
                });
            }
            Expr::SetComp(comprehension) => {
                self.comprehension(&comprehension.generators, &mut |reader| {
                    reader.visit_expr(&comprehension.elt)
                });
            }
            Expr::Generator(comprehension) => {
                self.comprehension(&comprehension.generators, &mut |reader| {
                    reader.visit_expr(&comprehension.elt)
                });
            }
            Expr::DictComp(comprehension) => {
                self.comprehension(&comprehension.generators, &mut |reader| {
                    if let Some(key) = &comprehension.key {
                        reader.visit_expr(key);
                    }
                    reader.visit_expr(&comprehension.value);
                });
            }
            Expr::BoolOp(boolean) => {
                self.branch(boolean.values.len().saturating_sub(1) as u32);
                visitor::walk_expr(self, expr);
            }
            Expr::If(_) => {
                self.branch(1);
                visitor::walk_expr(self, expr);
            }
            _ => visitor::walk_expr(self, expr),
        }
    }
}

#[cfg(test)]
mod tests;
