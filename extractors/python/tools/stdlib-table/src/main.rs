//! Generates `extractors/python/data/typeshed-stdlib-<commit>.tsv`: every
//! module of the Python standard library and the names each binds at its top
//! level, read from typeshed's `stdlib/` stubs with the extractor's own parser.
//! A development tool: the extractor embeds its OUTPUT and never links this
//! crate, so neither Python nor typeshed is needed to build or run it.
//!
//! usage: codegraph-python-stdlib-table <typeshed>/stdlib <typeshed commit> > data/typeshed-stdlib-<commit>.tsv
//!
//! One record per line, tab-separated, sorted:
//!
//! ```text
//! module  os.path  3.0-             a module, and the versions `VERSIONS` gives it (removed ones included)
//! name    os.path  join  function   a name the module binds: class, function, value…
//! name    os       sys   module sys …or module, with the module it is
//! ```
//!
//! A name is what the module binds at run time as far as its stub says: a
//! class, a `def`, an assignment, and a re-export in the stub convention
//! (`import x as x`, `from m import n as n`, `from m import *`), in every
//! branch of every `if sys.version_info` / `sys.platform`. A stub-only name —
//! `@type_check_only`, a private TypeVar or `TypeAlias` — is no name.

use ruff_python_ast::{self as ast, Expr, Mod, Stmt};
use ruff_python_parser::{Mode, ParseOptions, parse_unchecked};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// In typeshed's `stdlib/` and not in the standard library: `_typeshed` is the
/// stubs' own helpers ("not present at runtime"), `typing_extensions` a PyPI
/// distribution that type checkers bundle.
const NOT_STDLIB: &[&str] = &["_typeshed", "typing_extensions"];

/// Calls whose result exists only for a type checker when bound to a private name.
const TYPE_ONLY_CALLS: &[&str] = &["TypeVar", "ParamSpec", "TypeVarTuple"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    // Declaration order is precedence: a name bound as a class in one branch is a class.
    Value,
    Function,
    Module,
    Class,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Value => "value",
            Kind::Function => "function",
            Kind::Module => "module",
            Kind::Class => "class",
        }
    }
}

/// What one statement binds a name to, before any other stub is consulted.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Raw {
    Class,
    Function,
    Value,
    /// `X = a.b`: whatever the dotted name reads here.
    Alias(Vec<String>),
    /// `import x as x`.
    Module(String),
    /// `from m import n as n`.
    ReExport {
        from: String,
        name: String,
    },
}

#[derive(Default, Debug)]
struct Stub {
    /// Name → every binding the stub writes, in source order.
    names: BTreeMap<String, Vec<Raw>>,
    /// What a plain import binds: readable by an alias (`path = _path`), exported never.
    imported: BTreeMap<String, Raw>,
    /// `from m import *`, resolved to `m`.
    stars: Vec<String>,
    /// `__all__`, when the stub writes it as literal strings.
    all: Option<BTreeSet<String>>,
}

/// `os/__init__.pyi` → `os`; `os/path.pyi` → `os.path`.
fn module_name(relative: &Path) -> String {
    let mut parts: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    let last = parts.pop().unwrap_or_default();
    let stem = last.strip_suffix(".pyi").unwrap_or(&last).to_owned();
    if stem != "__init__" {
        parts.push(stem);
    }
    parts.join(".")
}

/// The package a relative import of `level` is resolved from.
fn relative_base(module: &str, is_package: bool, level: u32) -> String {
    let mut parts: Vec<&str> = module.split('.').collect();
    if !is_package {
        parts.pop();
    }
    for _ in 1..level {
        parts.pop();
    }
    parts.join(".")
}

fn dotted(expr: &Expr) -> Option<Vec<String>> {
    match expr {
        Expr::Name(name) => Some(vec![name.id.to_string()]),
        Expr::Attribute(attribute) => {
            let mut out = dotted(&attribute.value)?;
            out.push(attribute.attr.to_string());
            Some(out)
        }
        _ => None,
    }
}

fn is_private(name: &str) -> bool {
    name.starts_with('_') && !(name.starts_with("__") && name.ends_with("__"))
}

fn type_check_only(decorators: &[ast::Decorator]) -> bool {
    decorators.iter().any(|decorator| {
        dotted(&decorator.expression).and_then(|d| d.last().cloned()).as_deref() == Some("type_check_only")
    })
}

fn literal_strings(expr: &Expr) -> Option<Vec<String>> {
    let items = match expr {
        Expr::List(list) => &list.elts,
        Expr::Tuple(tuple) => &tuple.elts,
        _ => return None,
    };
    items
        .iter()
        .map(|item| match item {
            Expr::StringLiteral(text) => Some(text.value.to_str().to_owned()),
            _ => None,
        })
        .collect()
}

struct Reader<'a> {
    module: &'a str,
    is_package: bool,
    stub: Stub,
}

impl Reader<'_> {
    fn bind(&mut self, name: &str, raw: Raw) {
        self.stub.names.entry(name.to_owned()).or_default().push(raw);
    }

    fn add_all(&mut self, names: Vec<String>) {
        self.stub.all.get_or_insert_with(BTreeSet::new).extend(names);
    }

    fn body(&mut self, body: &[Stmt]) {
        for stmt in body {
            self.statement(stmt);
        }
    }

    fn statement(&mut self, stmt: &Stmt) {
        match stmt {
            Stmt::ClassDef(class) if !type_check_only(&class.decorator_list) => {
                self.bind(class.name.as_str(), Raw::Class);
            }
            Stmt::FunctionDef(function) if !type_check_only(&function.decorator_list) => {
                self.bind(function.name.as_str(), Raw::Function);
            }
            Stmt::Assign(assign) => {
                for target in &assign.targets {
                    let Expr::Name(name) = target else { continue };
                    if name.id.as_str() == "__all__"
                        && let Some(names) = literal_strings(&assign.value)
                    {
                        self.add_all(names);
                    }
                    if is_private(name.id.as_str()) && type_only_call(&assign.value) {
                        continue;
                    }
                    let raw = dotted(&assign.value).map_or(Raw::Value, Raw::Alias);
                    self.bind(name.id.as_str(), raw);
                }
            }
            Stmt::AugAssign(augmented) => {
                if let Expr::Name(name) = augmented.target.as_ref()
                    && name.id.as_str() == "__all__"
                    && let Some(names) = literal_strings(&augmented.value)
                {
                    self.add_all(names);
                }
            }
            Stmt::AnnAssign(annotated) => {
                let Expr::Name(name) = annotated.target.as_ref() else {
                    return;
                };
                let type_alias =
                    dotted(&annotated.annotation).and_then(|d| d.last().cloned()).as_deref() == Some("TypeAlias");
                if is_private(name.id.as_str()) && type_alias {
                    return;
                }
                let raw = match annotated.value.as_deref().and_then(dotted) {
                    Some(alias) if !type_alias => Raw::Alias(alias),
                    _ => Raw::Value,
                };
                self.bind(name.id.as_str(), raw);
            }
            Stmt::TypeAlias(alias) => {
                if let Expr::Name(name) = alias.name.as_ref()
                    && !is_private(name.id.as_str())
                {
                    self.bind(name.id.as_str(), Raw::Value);
                }
            }
            Stmt::Import(import) => {
                // Only `import x as x` re-exports (PEP 484): a stub's plain import binds nothing it exports.
                for alias in &import.names {
                    let module = alias.name.to_string();
                    match &alias.asname {
                        Some(asname) if asname.as_str() == module => self.bind(&module, Raw::Module(module.clone())),
                        Some(asname) => {
                            self.stub.imported.insert(asname.to_string(), Raw::Module(module));
                        }
                        // `import a.b` binds `a`.
                        None => {
                            let top = module.split('.').next().unwrap_or_default().to_owned();
                            self.stub.imported.insert(top.clone(), Raw::Module(top));
                        }
                    }
                }
            }
            Stmt::ImportFrom(import) => {
                let from = match (import.level, &import.module) {
                    (0, Some(module)) => module.to_string(),
                    (0, None) => return,
                    (level, module) => {
                        let base = relative_base(self.module, self.is_package, level);
                        match module {
                            Some(module) if base.is_empty() => module.to_string(),
                            Some(module) => format!("{base}.{module}"),
                            None => base,
                        }
                    }
                };
                for alias in &import.names {
                    let name = alias.name.as_str();
                    let raw = Raw::ReExport {
                        from: from.clone(),
                        name: name.to_owned(),
                    };
                    match alias.asname.as_ref().map(|asname| asname.as_str()) {
                        _ if name == "*" => self.stub.stars.push(from.clone()),
                        // `from m import __all__ as __all__` beside `from m import *`: m's list is this one's.
                        Some("__all__") if name == "__all__" => {
                            self.stub.all.get_or_insert_with(BTreeSet::new);
                        }
                        Some(asname) if asname == name => self.bind(name, raw),
                        Some(asname) => {
                            self.stub.imported.insert(asname.to_owned(), raw);
                        }
                        None => {
                            self.stub.imported.insert(name.to_owned(), raw);
                        }
                    }
                }
            }
            Stmt::If(branch) => {
                self.body(&branch.body);
                for clause in &branch.elif_else_clauses {
                    self.body(&clause.body);
                }
            }
            Stmt::Try(attempt) => {
                self.body(&attempt.body);
                for ast::ExceptHandler::ExceptHandler(handler) in &attempt.handlers {
                    self.body(&handler.body);
                }
                self.body(&attempt.orelse);
                self.body(&attempt.finalbody);
            }
            _ => {}
        }
    }
}

fn type_only_call(value: &Expr) -> bool {
    let Expr::Call(call) = value else { return false };
    dotted(&call.func)
        .and_then(|d| d.last().cloned())
        .is_some_and(|callee| TYPE_ONLY_CALLS.contains(&callee.as_str()))
}

fn read(source: &str, module: &str, is_package: bool) -> Result<Stub, String> {
    let parsed = parse_unchecked(source, ParseOptions::from(Mode::Module));
    if let Some(error) = parsed.errors().first() {
        return Err(format!("{}: {}", module, error.error));
    }
    let Mod::Module(body) = parsed.syntax() else {
        return Err(format!("{module}: not a module"));
    };
    let mut reader = Reader {
        module,
        is_package,
        stub: Stub::default(),
    };
    reader.body(&body.body);
    Ok(reader.stub)
}

struct Table {
    stubs: BTreeMap<String, Stub>,
}

/// Keeps the binding of highest precedence among a name's branches.
fn offer(best: &mut Option<(Kind, Option<String>)>, found: Option<(Kind, Option<String>)>) {
    if let Some(found) = found
        && best.as_ref().is_none_or(|(kind, _)| found.0 > *kind)
    {
        *best = Some(found);
    }
}

impl Table {
    /// What `module.name` is, through aliases, re-exports and star imports; cycles end in `None`.
    fn kind(
        &self,
        module: &str,
        name: &str,
        visiting: &mut BTreeSet<(String, String)>,
    ) -> Option<(Kind, Option<String>)> {
        if !visiting.insert((module.to_owned(), name.to_owned())) {
            return None;
        }
        let stub = self.stubs.get(module)?;
        let mut best: Option<(Kind, Option<String>)> = None;
        for raw in stub.names.get(name).into_iter().flatten() {
            let found = self.raw_kind(module, raw, visiting);
            offer(&mut best, found);
        }
        if best.is_none() {
            for star in &stub.stars {
                if self.exports(star).contains(name) {
                    let found = self.member(star, name, visiting);
                    offer(&mut best, found);
                }
            }
        }
        visiting.remove(&(module.to_owned(), name.to_owned()));
        best
    }

    fn raw_kind(
        &self,
        module: &str,
        raw: &Raw,
        visiting: &mut BTreeSet<(String, String)>,
    ) -> Option<(Kind, Option<String>)> {
        match raw {
            Raw::Class => Some((Kind::Class, None)),
            Raw::Function => Some((Kind::Function, None)),
            Raw::Value => Some((Kind::Value, None)),
            Raw::Module(target) => Some((Kind::Module, Some(target.clone()))),
            Raw::Alias(path) => self.alias(module, path, visiting).or(Some((Kind::Value, None))),
            Raw::ReExport { from, name } => self.member(from, name, visiting).or(Some((Kind::Value, None))),
        }
    }

    /// `module.name` as an attribute: a name it binds, else a submodule.
    fn member(
        &self,
        module: &str,
        name: &str,
        visiting: &mut BTreeSet<(String, String)>,
    ) -> Option<(Kind, Option<String>)> {
        self.kind(module, name, visiting).or_else(|| {
            let submodule = format!("{module}.{name}");
            self.stubs
                .contains_key(&submodule)
                .then_some((Kind::Module, Some(submodule)))
        })
    }

    /// `X = a.b` in `module`: `a` as the module (or `builtins`) binds it, then each attribute.
    fn alias(
        &self,
        module: &str,
        path: &[String],
        visiting: &mut BTreeSet<(String, String)>,
    ) -> Option<(Kind, Option<String>)> {
        let (first, rest) = path.split_first()?;
        let imported = self.stubs.get(module).and_then(|stub| stub.imported.get(first));
        let mut current = self
            .kind(module, first, visiting)
            .or_else(|| imported.and_then(|raw| self.raw_kind(module, raw, visiting)))
            .or_else(|| self.kind("builtins", first, visiting))?;
        for attribute in rest {
            current = match current {
                (Kind::Module, Some(target)) => self.member(&target, attribute, visiting)?,
                _ => (Kind::Value, None),
            };
        }
        Some(current)
    }

    /// What `from module import *` binds: `__all__`, else every public name.
    fn exports(&self, module: &str) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        self.exports_guarded(module, &mut seen)
    }

    fn exports_guarded(&self, module: &str, seen: &mut BTreeSet<String>) -> BTreeSet<String> {
        if !seen.insert(module.to_owned()) {
            return BTreeSet::new();
        }
        let Some(stub) = self.stubs.get(module) else {
            return BTreeSet::new();
        };
        let mut names: BTreeSet<String> = stub.names.keys().cloned().collect();
        for star in &stub.stars {
            names.extend(self.exports_guarded(star, seen));
        }
        match &stub.all {
            Some(all) if !all.is_empty() => all.clone(),
            Some(_) => stub.stars.iter().flat_map(|star| self.exports(star)).collect(),
            None => names.into_iter().filter(|name| !name.starts_with('_')).collect(),
        }
    }

    /// Every name a module binds: its own, then what its star imports bring.
    fn names(&self, module: &str) -> BTreeSet<String> {
        let Some(stub) = self.stubs.get(module) else {
            return BTreeSet::new();
        };
        let mut names: BTreeSet<String> = stub.names.keys().cloned().collect();
        for star in &stub.stars {
            names.extend(self.exports(star));
        }
        names
    }
}

/// `name: 3.0-3.11  # comment` → name → "3.0-3.11".
fn versions(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.split('#').next()?.trim();
            let (name, range) = line.split_once(':')?;
            Some((name.trim().to_owned(), range.trim().to_owned()))
        })
        .collect()
}

/// The range of the longest listed prefix: a submodule not listed has its parent's.
fn range_of<'a>(versions: &'a BTreeMap<String, String>, module: &str) -> Option<&'a str> {
    let mut candidate = module;
    loop {
        if let Some(range) = versions.get(candidate) {
            return Some(range);
        }
        candidate = candidate.rsplit_once('.')?.0;
    }
}

fn collect(directory: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(&path, out)?;
        } else if path.extension().is_some_and(|extension| extension == "pyi") {
            out.push(path);
        }
    }
    Ok(())
}

fn excluded(module: &str) -> bool {
    NOT_STDLIB
        .iter()
        .any(|root| module == *root || module.starts_with(&format!("{root}.")))
}

fn generate(stdlib: &Path, commit: &str) -> Result<String, String> {
    let versions = versions(
        &fs::read_to_string(stdlib.join("VERSIONS"))
            .map_err(|e| format!("cannot read {}/VERSIONS: {e}", stdlib.display()))?,
    );
    let mut files = Vec::new();
    collect(stdlib, &mut files).map_err(|e| format!("cannot read {}: {e}", stdlib.display()))?;
    files.sort();

    let mut table = Table { stubs: BTreeMap::new() };
    for file in &files {
        let relative = file.strip_prefix(stdlib).map_err(|e| e.to_string())?;
        let module = module_name(relative);
        if excluded(&module) {
            continue;
        }
        let is_package = file.file_name().is_some_and(|name| name == "__init__.pyi");
        let source = fs::read_to_string(file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        let stub = read(&source, &module, is_package)?;
        table.stubs.insert(module, stub);
    }

    let mut lines: Vec<String> = Vec::new();
    for module in table.stubs.keys() {
        let range = range_of(&versions, module).ok_or_else(|| format!("{module} is in no VERSIONS entry"))?;
        lines.push(format!("module\t{module}\t{range}"));
        for name in table.names(module) {
            if module == "builtins" && is_private(&name) {
                continue;
            }
            let Some((kind, target)) = table.kind(module, &name, &mut BTreeSet::new()) else {
                continue;
            };
            match target.filter(|_| kind == Kind::Module) {
                Some(target) => lines.push(format!("name\t{module}\t{name}\tmodule\t{target}")),
                None => lines.push(format!("name\t{module}\t{name}\t{}", kind.word())),
            }
        }
    }
    let mut out =
        format!("# typeshed {commit} stdlib/ — generated by extractors/python/tools/stdlib-table, never edited\n");
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [stdlib, commit] = args.as_slice() else {
        eprintln!("usage: codegraph-python-stdlib-table <typeshed>/stdlib <typeshed commit>");
        return ExitCode::from(2);
    };
    if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        eprintln!("the commit must be typeshed's full lowercase sha, got: {commit}");
        return ExitCode::from(2);
    }
    match generate(Path::new(stdlib), commit) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(stubs: &[(&str, bool, &str)]) -> Table {
        let mut table = Table { stubs: BTreeMap::new() };
        for (module, is_package, source) in stubs {
            table
                .stubs
                .insert((*module).to_owned(), read(source, module, *is_package).expect("parses"));
        }
        table
    }

    fn kind(table: &Table, module: &str, name: &str) -> Option<(Kind, Option<String>)> {
        table.kind(module, name, &mut BTreeSet::new())
    }

    #[test]
    fn names_a_module_after_its_path() {
        assert_eq!(module_name(Path::new("os/__init__.pyi")), "os");
        assert_eq!(module_name(Path::new("os/path.pyi")), "os.path");
        assert_eq!(module_name(Path::new("builtins.pyi")), "builtins");
        assert_eq!(relative_base("os", true, 1), "os");
        assert_eq!(relative_base("os.path", false, 1), "os");
        assert_eq!(relative_base("email.mime.text", false, 2), "email");
    }

    #[test]
    fn binds_what_a_stub_writes_in_every_branch_and_nothing_a_type_checker_alone_sees() {
        let stubs = table(&[(
            "m",
            false,
            "import sys\nfrom typing import Any, TypeVar\nfrom typing_extensions import TypeAlias\n\
             _T = TypeVar(\"_T\")\n_Alias: TypeAlias = int\nPublic: TypeAlias = int\n\
             @type_check_only\nclass _Hidden: ...\n\
             class Shown: ...\ndef run() -> None: ...\nDEBUG: bool\n\
             if sys.version_info >= (3, 12):\n    class New: ...\nelse:\n    def New() -> None: ...\n",
        )]);
        let names = stubs.names("m");
        // A plain import is no re-export, and a stub-only construct is no name.
        for absent in ["sys", "Any", "TypeVar", "_T", "_Alias", "_Hidden"] {
            assert!(!names.contains(absent), "{absent}");
        }
        assert_eq!(kind(&stubs, "m", "Shown"), Some((Kind::Class, None)));
        assert_eq!(kind(&stubs, "m", "run"), Some((Kind::Function, None)));
        assert_eq!(kind(&stubs, "m", "DEBUG"), Some((Kind::Value, None)));
        assert_eq!(kind(&stubs, "m", "Public"), Some((Kind::Value, None)));
        // Bound as a class in one branch and a function in the other: a class.
        assert_eq!(kind(&stubs, "m", "New"), Some((Kind::Class, None)));
    }

    #[test]
    fn follows_re_exports_aliases_and_star_imports_to_what_a_name_is() {
        let stubs = table(&[
            ("typing", false, "class Mapping: ...\nText = str\n"),
            ("builtins", false, "class str: ...\n"),
            (
                "_collections_abc",
                false,
                "from typing import Mapping as Mapping\n__all__ = [\"Mapping\"]\n",
            ),
            (
                "collections.abc",
                false,
                "from _collections_abc import *\nfrom _collections_abc import __all__ as __all__\n",
            ),
            (
                "collections",
                true,
                "from _collections_abc import Mapping\nclass deque: ...\n",
            ),
            (
                "os",
                true,
                "import sys as sys\nimport abc\nfrom . import path as _path\nfrom .path import join as join\npath = _path\n",
            ),
            ("os.path", false, "def join(a: str) -> str: ...\n"),
            ("sys", false, "argv: list[str]\n"),
        ]);
        assert_eq!(kind(&stubs, "collections.abc", "Mapping"), Some((Kind::Class, None)));
        assert!(stubs.names("collections.abc").contains("Mapping"));
        // A plain `from … import` in a stub binds nothing: `collections` does not bind `abc` either.
        assert_eq!(kind(&stubs, "collections", "Mapping"), None);
        assert_eq!(kind(&stubs, "collections", "abc"), None);
        assert_eq!(kind(&stubs, "typing", "Text"), Some((Kind::Class, None)));
        assert_eq!(kind(&stubs, "os", "sys"), Some((Kind::Module, Some("sys".to_owned()))));
        assert_eq!(kind(&stubs, "os", "join"), Some((Kind::Function, None)));
        // `path = _path` reads a plain import's binding, which is itself exported never.
        assert_eq!(
            kind(&stubs, "os", "path"),
            Some((Kind::Module, Some("os.path".to_owned())))
        );
        assert!(!stubs.names("os").contains("_path") && !stubs.names("os").contains("abc"));
        // Unbound in `collections`, `abc` is its submodule.
        assert_eq!(
            stubs.member("collections", "abc", &mut BTreeSet::new()),
            Some((Kind::Module, Some("collections.abc".to_owned())))
        );
        assert_eq!(
            stubs.member("os", "path", &mut BTreeSet::new()),
            Some((Kind::Module, Some("os.path".to_owned())))
        );
    }

    #[test]
    fn a_re_export_cycle_ends() {
        let stubs = table(&[
            ("a", false, "from b import x as x\n"),
            ("b", false, "from a import x as x\n"),
        ]);
        assert_eq!(kind(&stubs, "a", "x"), Some((Kind::Value, None)));
    }

    #[test]
    fn reads_versions_and_gives_a_submodule_its_parents_range() {
        let versions = versions("# c\n\n__future__: 3.0-\nasynchat: 3.0-3.11\n_typeshed: 3.0-  # not at runtime\n");
        assert_eq!(range_of(&versions, "asynchat"), Some("3.0-3.11"));
        assert_eq!(range_of(&versions, "_typeshed.wsgi"), Some("3.0-"));
        assert_eq!(range_of(&versions, "nope"), None);
        assert!(excluded("_typeshed.wsgi") && excluded("typing_extensions") && !excluded("typing"));
    }
}
