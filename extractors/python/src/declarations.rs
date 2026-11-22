//! Pass 1 — what one file WRITES, as the extractor's own records: scopes and
//! the names each binds, classes and their bases, `def`s and their
//! parameters, imports wherever written. THE ONLY FILE THAT NAMES A TYPE OF
//! THE PARSER: its API is internal and unversioned, so a bump of the pinned tag
//! breaks the build here or nowhere (a boundary test holds the line).

use ruff_python_ast::{self as ast, Expr, Mod, Stmt};
use ruff_python_parser::{Mode, ParseOptions, parse_unchecked};
use ruff_text_size::{Ranged, TextRange};

/// `(startLine, endLine)`, 1-based and inclusive.
pub type Span = (u32, u32);

/// Where names are bound: the module, a class body, a function body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeKind {
    Module,
    /// The body of `classes[i]`.
    Class(usize),
    /// The body of `functions[i]`.
    Function(usize),
}

#[derive(Debug)]
pub struct Scope {
    pub kind: ScopeKind,
    /// The scope the declaration owning this one is written in; `None` for the module.
    pub parent: Option<usize>,
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
    Parameter(usize),
    /// An assignment, a loop or `with` target, an `except … as`, a capture: a value no line types.
    Value,
}

/// A base as the header writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reference {
    /// `Base`, `models.Model`, `Generic[T]` (the subscripted name).
    Dotted(Vec<String>),
    /// A call, a starred list, any other expression: what it is is known only when it runs.
    Computed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseDecl {
    pub reference: Reference,
    pub span: Span,
    /// The source text, on one line, for `--explain-dropped`.
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
    pub bases: Vec<BaseDecl>,
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
    pub span: Span,
}

#[derive(Debug)]
pub struct FunctionDecl {
    pub name: String,
    pub scope: usize,
    pub body: usize,
    pub span: Span,
    /// `@<name>.setter` / `.deleter` / `.getter` directly in a class body: the word after the dot.
    pub accessor: Option<&'static str>,
    pub parameters: Vec<ParameterDecl>,
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
    pub drops: Vec<Dropped>,
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
    };
    reader.scope(ScopeKind::Module, None);
    if let Mod::Module(module) = parsed.syntax() {
        reader.body(0, &module.body, false);
    }
    reader.out
}

const ACCESSORS: &[&str] = &["setter", "deleter", "getter"];

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

/// What a base names: the subscripted name of `Generic[T]`, else the dotted name itself.
fn reference(expr: &Expr) -> Reference {
    match expr {
        Expr::Subscript(subscript) => reference(&subscript.value),
        other => dotted(other).map_or(Reference::Computed, Reference::Dotted),
    }
}

/// `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:`.
fn is_type_checking(test: &Expr) -> bool {
    dotted(test).is_some_and(|names| names.last().is_some_and(|last| last == "TYPE_CHECKING"))
}

struct Reader<'a> {
    text: &'a str,
    line_starts: &'a [u32],
    out: FileDecls,
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
        self.out.scopes.push(Scope {
            kind,
            parent,
            bindings: Vec::new(),
            globals: Vec::new(),
            nonlocals: Vec::new(),
        });
        self.out.scopes.len() - 1
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

    fn body(&mut self, scope: usize, body: &[Stmt], type_checking: bool) {
        for stmt in body {
            self.statement(scope, stmt, type_checking);
        }
    }

    fn statement(&mut self, scope: usize, stmt: &Stmt, type_checking: bool) {
        match stmt {
            Stmt::ClassDef(class) => self.class(scope, class),
            Stmt::FunctionDef(function) => self.function(scope, function),
            Stmt::Import(import) => self.import(scope, import, type_checking),
            Stmt::ImportFrom(import) => self.import_from(scope, import, type_checking),
            Stmt::Assign(assign) => {
                for target in &assign.targets {
                    self.targets(scope, target);
                }
            }
            Stmt::AugAssign(assign) => self.targets(scope, &assign.target),
            Stmt::AnnAssign(assign) => self.targets(scope, &assign.target),
            Stmt::Delete(delete) => {
                for target in &delete.targets {
                    self.targets(scope, target);
                }
            }
            Stmt::TypeAlias(alias) => self.targets(scope, &alias.name),
            Stmt::Global(global) => {
                let names = global.names.iter().map(|name| name.to_string());
                self.out.scopes[scope].globals.extend(names);
            }
            Stmt::Nonlocal(nonlocal) => {
                let names = nonlocal.names.iter().map(|name| name.to_string());
                self.out.scopes[scope].nonlocals.extend(names);
            }
            Stmt::For(each) => {
                self.targets(scope, &each.target);
                self.body(scope, &each.body, type_checking);
                self.body(scope, &each.orelse, type_checking);
            }
            Stmt::While(each) => {
                self.body(scope, &each.body, type_checking);
                self.body(scope, &each.orelse, type_checking);
            }
            Stmt::If(branch) => {
                self.body(scope, &branch.body, type_checking || is_type_checking(&branch.test));
                for clause in &branch.elif_else_clauses {
                    self.body(scope, &clause.body, type_checking);
                }
            }
            Stmt::With(with) => {
                for item in &with.items {
                    if let Some(target) = &item.optional_vars {
                        self.targets(scope, target);
                    }
                }
                self.body(scope, &with.body, type_checking);
            }
            Stmt::Try(attempt) => {
                self.body(scope, &attempt.body, type_checking);
                for ast::ExceptHandler::ExceptHandler(handler) in &attempt.handlers {
                    if let Some(name) = &handler.name {
                        self.bind(scope, name.as_str(), Bound::Value, name.start().to_u32());
                    }
                    self.body(scope, &handler.body, type_checking);
                }
                self.body(scope, &attempt.orelse, type_checking);
                self.body(scope, &attempt.finalbody, type_checking);
            }
            Stmt::Match(matching) => {
                for case in &matching.cases {
                    self.pattern(scope, &case.pattern);
                    self.body(scope, &case.body, type_checking);
                }
            }
            _ => {}
        }
    }

    /// The names an assignment target binds: a name, and the names of an unpacking.
    fn targets(&mut self, scope: usize, target: &Expr) {
        match target {
            Expr::Name(name) => self.bind(scope, name.id.as_str(), Bound::Value, name.start().to_u32()),
            Expr::Tuple(tuple) => {
                for item in &tuple.elts {
                    self.targets(scope, item);
                }
            }
            Expr::List(list) => {
                for item in &list.elts {
                    self.targets(scope, item);
                }
            }
            Expr::Starred(starred) => self.targets(scope, &starred.value),
            // An attribute or a subscript binds no name of this scope.
            _ => {}
        }
    }

    fn pattern(&mut self, scope: usize, pattern: &ast::Pattern) {
        let capture = |reader: &mut Self, name: &Option<ast::Identifier>| {
            if let Some(name) = name {
                reader.bind(scope, name.as_str(), Bound::Value, name.start().to_u32());
            }
        };
        match pattern {
            ast::Pattern::MatchAs(matched) => {
                if let Some(inner) = &matched.pattern {
                    self.pattern(scope, inner);
                }
                capture(self, &matched.name);
            }
            ast::Pattern::MatchStar(star) => capture(self, &star.name),
            ast::Pattern::MatchMapping(mapping) => {
                for inner in &mapping.patterns {
                    self.pattern(scope, inner);
                }
                capture(self, &mapping.rest);
            }
            ast::Pattern::MatchSequence(sequence) => {
                for inner in &sequence.patterns {
                    self.pattern(scope, inner);
                }
            }
            ast::Pattern::MatchOr(alternatives) => {
                for inner in &alternatives.patterns {
                    self.pattern(scope, inner);
                }
            }
            ast::Pattern::MatchClass(class) => {
                for inner in &class.arguments.patterns {
                    self.pattern(scope, inner);
                }
                for keyword in &class.arguments.keywords {
                    self.pattern(scope, &keyword.pattern);
                }
            }
            ast::Pattern::MatchValue(_) | ast::Pattern::MatchSingleton(_) => {}
        }
    }

    fn class(&mut self, scope: usize, class: &ast::StmtClassDef) {
        if !class.name.is_valid() {
            self.drop("unnamed-declaration", class.start().to_u32(), "class");
            return;
        }
        let bases = class
            .arguments
            .iter()
            .flat_map(|arguments| arguments.args.iter())
            .map(|base| BaseDecl {
                reference: reference(base),
                span: self.span(base.range()),
                text: self.one_line(base.range()),
            })
            .collect();
        let index = self.out.classes.len();
        let body = self.out.scopes.len();
        self.out.classes.push(ClassDecl {
            name: class.name.to_string(),
            scope,
            body,
            span: self.span_from(class.name.start().to_u32(), class.range()),
            bases,
        });
        self.bind(
            scope,
            class.name.as_str(),
            Bound::Class(index),
            class.name.start().to_u32(),
        );
        self.scope(ScopeKind::Class(index), Some(scope));
        self.body(body, &class.body, false);
    }

    fn function(&mut self, scope: usize, function: &ast::StmtFunctionDef) {
        if !function.name.is_valid() {
            self.drop("unnamed-declaration", function.start().to_u32(), "def");
            return;
        }
        let name = function.name.as_str();
        let in_class = matches!(self.out.scopes[scope].kind, ScopeKind::Class(_));
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
        let parameters = self.parameters(&function.parameters);
        let index = self.out.functions.len();
        let body = self.out.scopes.len();
        self.out.functions.push(FunctionDecl {
            name: name.to_owned(),
            scope,
            body,
            span: self.span_from(function.name.start().to_u32(), function.range()),
            accessor,
            parameters,
        });
        self.bind(scope, name, Bound::Function(index), function.name.start().to_u32());
        self.scope(ScopeKind::Function(index), Some(scope));
        let parameters: Vec<Binding> = self.out.functions[index]
            .parameters
            .iter()
            .enumerate()
            .map(|(at, parameter)| Binding {
                name: parameter.name.clone(),
                bound: Bound::Parameter(at),
                line: parameter.span.0,
            })
            .collect();
        self.out.scopes[body].bindings.extend(parameters);
        self.body(body, &function.body, false);
    }

    fn parameters(&mut self, parameters: &ast::Parameters) -> Vec<ParameterDecl> {
        let mut written: Vec<(&ast::Parameter, TextRange, ParameterKind, bool)> = Vec::new();
        for parameter in &parameters.posonlyargs {
            let default = parameter.default.is_some();
            written.push((
                &parameter.parameter,
                parameter.range(),
                ParameterKind::PositionalOnly,
                default,
            ));
        }
        for parameter in &parameters.args {
            let default = parameter.default.is_some();
            written.push((
                &parameter.parameter,
                parameter.range(),
                ParameterKind::Positional,
                default,
            ));
        }
        if let Some(parameter) = &parameters.vararg {
            written.push((parameter, parameter.range(), ParameterKind::VarArgs, false));
        }
        for parameter in &parameters.kwonlyargs {
            let default = parameter.default.is_some();
            written.push((
                &parameter.parameter,
                parameter.range(),
                ParameterKind::KeywordOnly,
                default,
            ));
        }
        if let Some(parameter) = &parameters.kwarg {
            written.push((parameter, parameter.range(), ParameterKind::VarKeywords, false));
        }
        let mut out: Vec<ParameterDecl> = Vec::with_capacity(written.len());
        for (parameter, range, kind, has_default) in written {
            let name = parameter.name.as_str();
            if !parameter.name.is_valid() {
                self.drop("unnamed-declaration", range.start().to_u32(), "parameter");
            } else if out.iter().any(|seen| seen.name == name) {
                self.drop("duplicate-parameter", range.start().to_u32(), name);
            } else {
                out.push(ParameterDecl {
                    name: name.to_owned(),
                    kind,
                    has_default,
                    span: self.span(range),
                });
            }
        }
        out
    }

    fn import(&mut self, scope: usize, import: &ast::StmtImport, type_checking: bool) {
        let index = self.out.imports.len();
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
            type_checking,
            kind: ImportKind::Modules(aliases),
        });
    }

    fn import_from(&mut self, scope: usize, import: &ast::StmtImportFrom, type_checking: bool) {
        let index = self.out.imports.len();
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
            type_checking,
            kind: ImportKind::From {
                level: import.level,
                module,
                names,
            },
        });
    }
}

#[cfg(test)]
mod tests {
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
        assert_eq!(bases[2], vec![(Reference::Computed, "make_base()")]);
        assert_eq!(bases[3], vec![(Reference::Computed, "*bases")]);
        // A base over several lines is anchored on all of them, and explained on one.
        assert_eq!(bases[4], vec![(Reference::Computed, "six.with_metaclass( Meta, Base)")]);
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
        let accessors: Vec<(&str, Option<&str>)> =
            decls.functions.iter().map(|f| (f.name.as_str(), f.accessor)).collect();
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
                ("Base", Bound::Parameter(0), 1),
                ("rest", Bound::Parameter(1), 1),
                ("key", Bound::Parameter(2), 1),
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
        assert!(
            decls.scopes[0]
                .bindings
                .iter()
                .take(17)
                .all(|binding| binding.bound == Bound::Value)
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
}
