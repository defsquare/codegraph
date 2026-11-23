//! The module table and what a name is (PLAN.md §23.4).
//!
//! A dotted name is a path below a root, and Python finds roots in `sys.path`,
//! which no source writes. A relative import needs none: path arithmetic from
//! the importing file. An absolute one is looked up in every root the layout
//! implies; the root nearest the importing file wins and a tie is dropped. The
//! corpus answers before the table, the table before an implicit relative
//! import, and whatever is left is a third party's, named as written.
//!
//! A name is then followed through the bindings that make it — an import of a
//! re-export of a class — to what it is, cycle-guarded.

use crate::corpus::{Corpus, Root, parent_dir};
use crate::declarations::{Bound, Chain, FileDecls, ImportKind, ScopeKind, ValueDecl};
use crate::scopes;
use crate::stdlib_table::{self, Kind, StdlibTable};
use std::collections::{HashMap, HashSet};

/// A module an import can name.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ModuleRef {
    /// A corpus file: `corpus.files[i]`.
    File(usize),
    /// A directory with no `__init__.py` — a namespace package, which no file is.
    Namespace(String),
    /// A module of the table, as the import writes it.
    Stdlib(String),
    /// A module nothing here declares and the table does not name, as written.
    Site(String),
    /// What an import names below a corpus package and no file is: the path it would have.
    Missing(String),
}

/// How an import found its module — a fact about the layout, counted as one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    Relative,
    PackageRoot,
    NamespacePackage,
    ImplicitRelative,
    Stdlib,
    Site,
    Missing,
}

/// Where the first component of an absolute dotted name was found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Base {
    Root(usize),
    Dir(String),
    Stdlib,
    Site,
    /// A relative import: no first component to bind.
    Relative,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lookup {
    Found {
        module: ModuleRef,
        how: How,
        base: Base,
    },
    /// Two roots at the same distance answer, differently: the roots.
    Ambiguous(Vec<String>),
    /// A relative import that climbs above the corpus root.
    BeyondRoot,
}

/// The module table: every corpus file by path, the directories, the roots.
pub struct Modules<'a> {
    pub corpus: &'a Corpus,
    by_path: HashMap<&'a str, usize>,
    directories: HashSet<String>,
    packages: HashSet<String>,
    roots: Vec<Root>,
    table: &'static StdlibTable,
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

fn components(dir: &str) -> Vec<&str> {
    dir.split('/').filter(|part| !part.is_empty()).collect()
}

/// Directory steps from a file's directory to a root: up to their common
/// ancestor, then down; the root above a package corpus root is one step higher.
fn distance(from: &str, root: &Root) -> usize {
    let (a, b) = (components(from), components(&root.dir));
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    (a.len() - common) + (b.len() - common) + usize::from(root.prefix.is_some())
}

impl<'a> Modules<'a> {
    pub fn new(corpus: &'a Corpus) -> Self {
        Modules {
            corpus,
            by_path: corpus
                .files
                .iter()
                .enumerate()
                .map(|(index, file)| (file.rel.as_str(), index))
                .collect(),
            directories: corpus.directories(),
            packages: corpus.packages(),
            roots: corpus.roots(),
            table: stdlib_table::table(),
        }
    }

    /// A package directory's own file: `__init__.py`, else its stub.
    fn init_of(&self, dir: &str) -> Option<usize> {
        ["__init__.py", "__init__.pyi"]
            .iter()
            .find_map(|name| self.by_path.get(join(dir, name).as_str()).copied())
    }

    fn rel(&self, file: usize) -> &str {
        &self.corpus.files[file].rel
    }

    /// The module `names` reads below `dir`, level by level as the import
    /// system finds it: a package, else a module (no further), else a namespace.
    /// `true` when a namespace directory was crossed or reached.
    fn below(&self, dir: &str, names: &[&str]) -> Option<(ModuleRef, bool)> {
        let mut current = dir.to_owned();
        let mut namespace = false;
        for (at, name) in names.iter().enumerate() {
            let path = join(&current, name);
            let last = at + 1 == names.len();
            if self.packages.contains(&path) {
                if last {
                    let init = self.init_of(&path).expect("a package holds its own file");
                    return Some((ModuleRef::File(init), namespace));
                }
                current = path;
                continue;
            }
            let module = ["py", "pyw", "pyi"]
                .iter()
                .find_map(|extension| self.by_path.get(format!("{path}.{extension}").as_str()));
            if let Some(&module) = module {
                return last.then_some((ModuleRef::File(module), namespace));
            }
            if !self.directories.contains(&path) {
                return None;
            }
            if last {
                return Some((ModuleRef::Namespace(path), true));
            }
            namespace = true;
            current = path;
        }
        None
    }

    fn in_root(&self, root: &Root, names: &[&str]) -> Option<(ModuleRef, bool)> {
        match &root.prefix {
            None => self.below(&root.dir, names),
            Some(prefix) => {
                let (first, rest) = names.split_first()?;
                if first != prefix {
                    return None;
                }
                if rest.is_empty() {
                    return self.init_of("").map(|init| (ModuleRef::File(init), false));
                }
                self.below("", rest)
            }
        }
    }

    /// The module `dotted` names for an `import` in `file`.
    pub fn absolute(&self, file: usize, dotted: &str) -> Lookup {
        let names: Vec<&str> = dotted.split('.').collect();
        let from = parent_dir(self.rel(file));

        // 1. The corpus, at the root nearest the importing file. Another file's root does not
        // shadow the standard library: only the importer's own, the corpus root and an
        // `--import-root` are on its path for certain.
        let own = crate::corpus::package_root(self.rel(file), &self.packages, self.corpus.root_name.as_deref());
        let standard = self.table.is_module(names[0]);
        let reachable = |root: &Root| {
            !standard
                || *root == own
                || (root.dir.is_empty() && root.prefix.is_none())
                || self.corpus.import_roots.contains(&root.dir)
        };
        let mut hits: Vec<(usize, usize, ModuleRef, bool)> = self
            .roots
            .iter()
            .enumerate()
            .filter(|(_, root)| reachable(root))
            .filter_map(|(index, root)| {
                self.in_root(root, &names)
                    .map(|(module, namespace)| (distance(from, root), index, module, namespace))
            })
            .collect();
        hits.sort();
        if let Some((nearest, index, module, namespace)) = hits.first().cloned() {
            let tied: Vec<&(usize, usize, ModuleRef, bool)> = hits
                .iter()
                .filter(|(d, _, m, _)| *d == nearest && *m != module)
                .collect();
            if !tied.is_empty() {
                let mut roots: Vec<String> = std::iter::once(index)
                    .chain(tied.iter().map(|(_, other, _, _)| *other))
                    .map(|root| self.roots[root].dir.clone())
                    .collect();
                roots.sort();
                return Lookup::Ambiguous(roots);
            }
            let how = if namespace {
                How::NamespacePackage
            } else {
                How::PackageRoot
            };
            return Lookup::Found {
                module,
                how,
                base: Base::Root(index),
            };
        }

        // 2. A corpus package answers the first name and nothing the rest: a file that is not there.
        if names.len() > 1 {
            let package = self
                .roots
                .iter()
                .enumerate()
                .filter(|(_, root)| root.prefix.is_none() && reachable(root))
                .filter_map(|(index, root)| match self.in_root(root, &names[..1]) {
                    Some((ModuleRef::File(init), _)) if crate::corpus::is_package_init(self.rel(init)) => {
                        Some((distance(from, root), index))
                    }
                    _ => None,
                })
                .min();
            if let Some((_, index)) = package {
                let path = format!("{}.py", join(&self.roots[index].dir, &names.join("/")));
                return Lookup::Found {
                    module: ModuleRef::Missing(path),
                    how: How::Missing,
                    base: Base::Root(index),
                };
            }
        }

        // 3. The standard library.
        if self.table.is_module(dotted) {
            return Lookup::Found {
                module: ModuleRef::Stdlib(dotted.to_owned()),
                how: How::Stdlib,
                base: Base::Stdlib,
            };
        }

        // 4. Python 2 inside a package: a sibling of the importing file.
        if self.packages.contains(from)
            && let Some((module, _)) = self.below(from, &names)
        {
            return Lookup::Found {
                module,
                how: How::ImplicitRelative,
                base: Base::Dir(from.to_owned()),
            };
        }

        // 5. A third party's, as written.
        Lookup::Found {
            module: ModuleRef::Site(dotted.to_owned()),
            how: How::Site,
            base: Base::Site,
        }
    }

    /// `from <level dots>[module] import …` in `file`: the module it imports from.
    pub fn relative(&self, file: usize, level: u32, module: Option<&str>) -> Lookup {
        let mut base = parent_dir(self.rel(file)).to_owned();
        for _ in 1..level {
            if base.is_empty() {
                return Lookup::BeyondRoot;
            }
            base = parent_dir(&base).to_owned();
        }
        let module = match module {
            None if self.packages.contains(&base) => {
                ModuleRef::File(self.init_of(&base).expect("a package holds its own file"))
            }
            None => ModuleRef::Namespace(base),
            Some(dotted) => {
                let names: Vec<&str> = dotted.split('.').collect();
                match self.below(&base, &names) {
                    Some((module, _)) => module,
                    None => ModuleRef::Missing(format!("{}.py", join(&base, &names.join("/")))),
                }
            }
        };
        let how = match module {
            ModuleRef::Missing(_) => How::Missing,
            _ => How::Relative,
        };
        Lookup::Found {
            module,
            how,
            base: Base::Relative,
        }
    }

    /// `name` as a submodule of `module`, where one can be.
    pub fn submodule(&self, module: &ModuleRef, name: &str) -> Option<ModuleRef> {
        match module {
            ModuleRef::File(file) => {
                let rel = self.rel(*file);
                let package = crate::corpus::is_package_init(rel);
                package
                    .then(|| self.below(parent_dir(rel), &[name]))
                    .flatten()
                    .map(|(module, _)| module)
            }
            ModuleRef::Namespace(dir) => self.below(dir, &[name]).map(|(module, _)| module),
            ModuleRef::Stdlib(dotted) => {
                let submodule = format!("{dotted}.{name}");
                self.table.is_module(&submodule).then_some(ModuleRef::Stdlib(submodule))
            }
            ModuleRef::Site(_) | ModuleRef::Missing(_) => None,
        }
    }

    /// The module the first name of `dotted` binds, found where `dotted` was.
    fn first(&self, dotted: &str, base: &Base) -> Option<ModuleRef> {
        let first = dotted.split('.').next()?;
        match base {
            Base::Root(index) => self.in_root(&self.roots[*index], &[first]).map(|(module, _)| module),
            Base::Dir(dir) => self.below(dir, &[first]).map(|(module, _)| module),
            Base::Stdlib if self.table.is_module(first) => Some(ModuleRef::Stdlib(first.to_owned())),
            Base::Stdlib | Base::Site => Some(ModuleRef::Site(first.to_owned())),
            Base::Relative => None,
        }
    }
}

/// The edge an import alias writes, or why it writes none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportTarget {
    Edge { to: ModuleRef, how: How },
    Dropped { reason: &'static str, what: String },
}

/// What the name an alias binds is made of.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Binds {
    /// `import a.b.c` binds `a`; `import a.b.c as m`, `a.b.c`.
    Module(ModuleRef),
    /// `from m import n` binds `n` of `m`.
    NameOf(ModuleRef, String),
    /// `from m import *` binds what `m` exports.
    Star(ModuleRef),
    Nothing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AliasResolution {
    pub target: ImportTarget,
    binds: Binds,
}

/// What a name, or a dotted name, is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Class {
        file: usize,
        class: usize,
    },
    Function {
        file: usize,
        function: usize,
    },
    Module(ModuleRef),
    /// A name below a module no file here is (`<stdlib>`, `<site>`, a missing
    /// one), as written at the site; `kind` when the table says what it is.
    External {
        module: ModuleRef,
        symbol: Vec<String>,
        kind: Option<Kind>,
    },
    /// A name of `builtins`.
    Builtin {
        name: String,
        kind: Kind,
    },
    /// Bound by an assignment: `files[file].assignments[assignment]`, which the receiver types.
    Assigned {
        file: usize,
        assignment: usize,
    },
    /// A parameter of `files[file].functions[function]`.
    Parameter {
        file: usize,
        function: usize,
        index: usize,
    },
    /// Bound by what no line types: a loop target, an unpacking.
    Opaque,
    /// Bound by nothing — or by a chain of re-exports that loops.
    Unbound {
        cycle: bool,
    },
    /// Bound only by star imports of several modules nothing here answers: which, no line says.
    AmbiguousStar(Vec<String>),
}

impl Value {
    /// A binding that names a declaration, stub or not — the one a rebound name keeps.
    fn names_a_declaration(&self) -> bool {
        !matches!(
            self,
            Value::Opaque
                | Value::Unbound { .. }
                | Value::Assigned { .. }
                | Value::Parameter { .. }
                | Value::AmbiguousStar(_)
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub value: Value,
    /// The name is bound more than one way where it was found: the first that names a declaration won.
    pub rebound: bool,
    /// Bound only by the star import of one module nothing here answers: attributed to it.
    pub star_attributed: bool,
}

/// What star imports bind, file by file.
struct Stars<'a> {
    modules: &'a Modules<'a>,
    files: &'a [FileDecls],
    /// Per file: the module each `from m import *` names, in source order.
    of: Vec<Vec<ModuleRef>>,
    /// Per file: its `__all__` where that is the export list (`literal_all`).
    alls: Vec<Option<Vec<String>>>,
}

/// A corpus module's `__all__`, when one literal list of strings is all it is: bound once,
/// and never grown — `token.py` writes four names, then `__all__.extend(…)` every token's.
fn literal_all(decls: &FileDecls) -> Option<Vec<String>> {
    let bindings = scopes::bound_in(decls, 0, "__all__");
    let [binding] = bindings.as_slice() else {
        return None;
    };
    let grown = decls.sites.iter().any(|site| {
        decls.owner(site.scope) == 0
            && matches!(&site.chain, Chain::Call(callee)
                if matches!(callee.as_ref(), Chain::Attribute(inner, _)
                    if matches!(inner.as_ref(), Chain::Name(name) if name == "__all__")))
    });
    let Bound::Assigned(index) = binding.bound else {
        return None;
    };
    match &decls.assignments[index].value {
        Some(ValueDecl::Array(items)) if !grown => items
            .iter()
            .map(|item| match item {
                ValueDecl::Str(name) => Some(name.clone()),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

impl Stars<'_> {
    fn all(&self, file: usize) -> Option<Vec<&str>> {
        self.alls[file]
            .as_ref()
            .map(|all| all.iter().map(String::as_str).collect())
    }

    /// Whether `from <module> import *` binds `name`.
    fn exports(&self, module: &ModuleRef, name: &str, seen: &mut HashSet<usize>) -> bool {
        match module {
            ModuleRef::File(file) => {
                if !seen.insert(*file) {
                    return false;
                }
                match self.all(*file) {
                    Some(all) => all.contains(&name),
                    None => {
                        !name.starts_with('_')
                            && (!scopes::bound_in(&self.files[*file], 0, name).is_empty()
                                || self.of[*file].iter().any(|star| self.exports(star, name, seen)))
                    }
                }
            }
            ModuleRef::Stdlib(dotted) => self.modules.table.exports(dotted).contains(&name),
            _ => false,
        }
    }

    /// Whether a star import written in `file` binds `name` there.
    fn binds(&self, file: usize, name: &str) -> bool {
        self.of[file]
            .iter()
            .any(|star| self.exports(star, name, &mut HashSet::from([file])))
    }

    /// The package's submodule `name`, where only a star import binds that name: importing a
    /// submodule binds it in its package, and a star import that binds the name binds that module.
    fn submodule_over_star(&self, file: usize, name: &str) -> Option<ModuleRef> {
        self.modules
            .submodule(&ModuleRef::File(file), name)
            .filter(|_| self.binds(file, name))
    }
}

fn written_name(module: &ModuleRef) -> String {
    match module {
        ModuleRef::Stdlib(dotted) | ModuleRef::Site(dotted) => dotted.clone(),
        ModuleRef::Missing(path) | ModuleRef::Namespace(path) => path.clone(),
        ModuleRef::File(file) => format!("file {file}"),
    }
}

/// What the interpreter binds in every module before its first line runs (`__path__` in a
/// package's): the language, like `builtins`.
const MODULE_NAMES: &[&str] = &[
    "__annotations__",
    "__builtins__",
    "__cached__",
    "__debug__",
    "__doc__",
    "__file__",
    "__loader__",
    "__name__",
    "__package__",
    "__path__",
    "__spec__",
];

pub struct Resolver<'a> {
    pub modules: &'a Modules<'a>,
    files: &'a [FileDecls],
    /// Per file, per import, per alias.
    aliases: Vec<Vec<Vec<AliasResolution>>>,
    /// Per file: every dotted name an `import` statement writes, and each prefix — modules all.
    imported: Vec<HashSet<String>>,
    stars: Stars<'a>,
}

fn dropped(reason: &'static str, what: String) -> AliasResolution {
    AliasResolution {
        target: ImportTarget::Dropped { reason, what },
        binds: Binds::Nothing,
    }
}

/// The module `from <level dots>[module] import …` in `file` imports from.
fn from_lookup(modules: &Modules<'_>, file: usize, level: u32, module: Option<&str>) -> Lookup {
    match (level, module) {
        (0, Some(module)) => modules.absolute(file, module),
        // `from import x`: what recovery leaves of a statement that names no module.
        (0, None) => Lookup::BeyondRoot,
        (level, module) => modules.relative(file, level, module),
    }
}

/// Whether the module scope of a corpus file binds `name` — explicitly, as a
/// line writes it — other than by the import statement `except`, which cannot
/// have bound it before it runs.
fn binds_at_top(file: &FileDecls, name: &str, except: Option<usize>) -> bool {
    scopes::bound_in(file, 0, name)
        .iter()
        .any(|binding| !matches!(binding.bound, Bound::Import { import, .. } if Some(import) == except))
}

/// `from <from> import <name>` in statement `import` of `importing`: the
/// module a line binds the name in, else the submodule it is (a star import binding it binds
/// that module), else the module.
fn from_target(
    stars: &Stars<'_>,
    (importing, import): (usize, usize),
    from: &ModuleRef,
    how: How,
    name: &str,
    written: &str,
) -> ImportTarget {
    let (modules, files) = (stars.modules, stars.files);
    let edge = |to: ModuleRef| ImportTarget::Edge { to, how };
    let star = name == "*";
    match from {
        ModuleRef::File(file) => {
            let this_statement = (*file == importing).then_some(import);
            if star || binds_at_top(&files[*file], name, this_statement) {
                return edge(from.clone());
            }
            match modules.submodule(from, name) {
                Some(ModuleRef::File(submodule)) => edge(ModuleRef::File(submodule)),
                // Bound where no line says, or nowhere: the module the statement imports.
                _ => edge(from.clone()),
            }
        }
        ModuleRef::Namespace(_) => match modules.submodule(from, name).filter(|_| !star) {
            Some(ModuleRef::File(submodule)) => edge(ModuleRef::File(submodule)),
            _ => ImportTarget::Dropped {
                reason: "namespace-import",
                what: if star {
                    written.to_owned()
                } else {
                    format!("{written}.{name}")
                },
            },
        },
        ModuleRef::Stdlib(module) => {
            let bound = star || modules.table.name(module, name).is_some();
            match modules.submodule(from, name).filter(|_| !bound) {
                Some(submodule) => edge(submodule),
                None => edge(from.clone()),
            }
        }
        ModuleRef::Site(_) | ModuleRef::Missing(_) => edge(from.clone()),
    }
}

impl<'a> Resolver<'a> {
    pub fn new(modules: &'a Modules<'a>, files: &'a [FileDecls]) -> Self {
        // Star imports first: whether a module binds a name may depend on one.
        let of = files
            .iter()
            .enumerate()
            .map(|(file, decls)| {
                decls
                    .imports
                    .iter()
                    .filter_map(|import| match &import.kind {
                        ImportKind::From { level, module, names } if names.iter().any(|alias| alias.name == "*") => {
                            match from_lookup(modules, file, *level, module.as_deref()) {
                                Lookup::Found { module, .. } => Some(module),
                                _ => None,
                            }
                        }
                        _ => None,
                    })
                    .collect()
            })
            .collect();
        let alls = files.iter().map(literal_all).collect();
        let stars = Stars {
            modules,
            files,
            of,
            alls,
        };
        let mut aliases = Vec::with_capacity(files.len());
        let mut imported = Vec::with_capacity(files.len());
        for (file, decls) in files.iter().enumerate() {
            let mut names = HashSet::new();
            let mut per_import = Vec::with_capacity(decls.imports.len());
            for (index, import) in decls.imports.iter().enumerate() {
                let resolved: Vec<AliasResolution> = match &import.kind {
                    ImportKind::Modules(list) => list
                        .iter()
                        .map(|alias| {
                            let parts: Vec<&str> = alias.name.split('.').collect();
                            for end in 1..=parts.len() {
                                names.insert(parts[..end].join("."));
                            }
                            match modules.absolute(file, &alias.name) {
                                Lookup::Found { module, how, base } => {
                                    let binds = match &alias.asname {
                                        Some(_) => Binds::Module(module.clone()),
                                        None => modules.first(&alias.name, &base).map_or(Binds::Nothing, Binds::Module),
                                    };
                                    let target = match module {
                                        ModuleRef::Namespace(_) => ImportTarget::Dropped {
                                            reason: "namespace-import",
                                            what: alias.name.clone(),
                                        },
                                        module => ImportTarget::Edge { to: module, how },
                                    };
                                    AliasResolution { target, binds }
                                }
                                Lookup::Ambiguous(roots) => {
                                    dropped("ambiguous-root", format!("{} ({})", alias.name, roots.join(" or ")))
                                }
                                Lookup::BeyondRoot => dropped("relative-beyond-root", alias.name.clone()),
                            }
                        })
                        .collect(),
                    ImportKind::From {
                        level,
                        module,
                        names: list,
                    } => {
                        let written = format!("{}{}", ".".repeat(*level as usize), module.as_deref().unwrap_or(""));
                        let lookup = from_lookup(modules, file, *level, module.as_deref());
                        list.iter()
                            .map(|alias| match &lookup {
                                Lookup::Found { module: from, how, .. } => {
                                    let target = from_target(&stars, (file, index), from, *how, &alias.name, &written);
                                    let binds = match &target {
                                        _ if alias.name == "*" => Binds::Star(from.clone()),
                                        // A package importing its own submodule binds that module, not itself.
                                        ImportTarget::Edge { to, .. }
                                            if *from == ModuleRef::File(file) && *to != *from =>
                                        {
                                            Binds::Module(to.clone())
                                        }
                                        _ => Binds::NameOf(from.clone(), alias.name.clone()),
                                    };
                                    AliasResolution { target, binds }
                                }
                                Lookup::Ambiguous(roots) => {
                                    dropped("ambiguous-root", format!("{written} ({})", roots.join(" or ")))
                                }
                                Lookup::BeyondRoot => dropped("relative-beyond-root", written.clone()),
                            })
                            .collect()
                    }
                };
                per_import.push(resolved);
            }
            aliases.push(per_import);
            imported.push(names);
        }
        Resolver {
            modules,
            files,
            aliases,
            imported,
            stars,
        }
    }

    pub fn alias(&self, file: usize, import: usize, alias: usize) -> &AliasResolution {
        &self.aliases[file][import][alias]
    }

    /// What `names[0].names[1]…` read in `scope` of `file` is.
    pub fn reference(&self, file: usize, scope: usize, names: &[String]) -> Resolved {
        self.read(file, scope, names, None)
    }

    /// Whether `scope` is a method's, or nested in one: the compiler gives it the implicit
    /// `__class__` cell zero-argument `super()` reads.
    fn in_method(&self, file: usize, scope: usize) -> bool {
        let scopes = &self.files[file].scopes;
        let mut current = Some(scope);
        while let Some(index) = current {
            if let ScopeKind::Function(function) = scopes[index].kind
                && matches!(
                    scopes[self.files[file].functions[function].scope].kind,
                    ScopeKind::Class(_)
                )
            {
                return true;
            }
            current = scopes[index].parent;
        }
        false
    }

    /// `module.name`, read in `file`: what the module binds, else a submodule.
    pub fn module_member(&self, file: usize, module: &ModuleRef, name: &str) -> Value {
        self.module_attribute(file, module, name, &mut HashSet::new())
    }

    /// A base of `classes[class]`: read before the class statement binds its
    /// own name, so that binding is never what the base is.
    pub fn base(&self, file: usize, class: usize, names: &[String]) -> Resolved {
        let scope = self.files[file].classes[class].scope;
        self.read(file, scope, names, Some(Bound::Class(class)))
    }

    fn read(&self, file: usize, scope: usize, names: &[String], unbound: Option<Bound>) -> Resolved {
        let mut visiting = HashSet::new();
        let Some((first, rest)) = names.split_first() else {
            return Resolved {
                value: Value::Unbound { cycle: false },
                rebound: false,
                star_attributed: false,
            };
        };
        let (mut value, rebound, star_attributed) = self.name(file, scope, first, unbound, &mut visiting);
        for attribute in rest {
            value = self.attribute(file, value, attribute, &mut visiting);
        }
        Resolved {
            value,
            rebound,
            star_attributed,
        }
    }

    /// What a star import of `file` binds `name` to: a module that exports it; else,
    /// unless it is a builtin, the one module nothing answers (attributed); else nothing.
    fn star_value(&self, file: usize, name: &str, visiting: &mut HashSet<(usize, String)>) -> Option<(Value, bool)> {
        let mut unknown: Vec<&ModuleRef> = Vec::new();
        for module in &self.stars.of[file] {
            match module {
                ModuleRef::File(_) => {
                    if self.stars.exports(module, name, &mut HashSet::from([file])) {
                        return Some((self.module_attribute(file, module, name, visiting), false));
                    }
                }
                ModuleRef::Stdlib(dotted) if !self.modules.table.exports(dotted).is_empty() => {
                    if self.stars.exports(module, name, &mut HashSet::new()) {
                        return Some((self.module_attribute(file, module, name, visiting), false));
                    }
                }
                ModuleRef::Namespace(_) => {}
                // A module whose names no table lists: it could bind anything.
                other => unknown.push(other),
            }
        }
        if self.modules.table.builtin(name).is_some() {
            return None;
        }
        match unknown.as_slice() {
            [] => None,
            [only] => Some((
                Value::External {
                    module: (*only).clone(),
                    symbol: vec![name.to_owned()],
                    kind: None,
                },
                true,
            )),
            several => Some((
                Value::AmbiguousStar(several.iter().map(|m| written_name(m)).collect()),
                false,
            )),
        }
    }

    fn name(
        &self,
        file: usize,
        scope: usize,
        name: &str,
        unbound: Option<Bound>,
        visiting: &mut HashSet<(usize, String)>,
    ) -> (Value, bool, bool) {
        let mut found = scopes::lookup(&self.files[file], scope, name);
        found.retain(|binding| Some(binding.bound) != unbound);
        if found.is_empty() {
            if let Some(submodule) = self.stars.submodule_over_star(file, name) {
                return (Value::Module(submodule), false, false);
            }
            if let Some((value, attributed)) = self.star_value(file, name, visiting) {
                return (value, false, attributed);
            }
            let kind = self
                .modules
                .table
                .builtin(name)
                .or_else(|| MODULE_NAMES.contains(&name).then_some(Kind::Value))
                .or_else(|| (name == "__class__" && self.in_method(file, scope)).then_some(Kind::Value));
            let value = match kind {
                Some(kind) => Value::Builtin {
                    name: name.to_owned(),
                    kind,
                },
                None => Value::Unbound { cycle: false },
            };
            return (value, false, false);
        }
        let (value, rebound) = self.choose(file, &found, visiting);
        (value, rebound, false)
    }

    /// A name bound more than one way: the first binding, in source order, that names a declaration.
    fn choose(
        &self,
        file: usize,
        bindings: &[&crate::declarations::Binding],
        visiting: &mut HashSet<(usize, String)>,
    ) -> (Value, bool) {
        let rebound = bindings.len() > 1;
        let mut first = None;
        for binding in bindings {
            let value = self.binding_value(file, binding.bound, visiting);
            if value.names_a_declaration() {
                return (value, rebound);
            }
            first.get_or_insert(value);
        }
        (first.unwrap_or(Value::Unbound { cycle: false }), rebound)
    }

    fn binding_value(&self, file: usize, bound: Bound, visiting: &mut HashSet<(usize, String)>) -> Value {
        match bound {
            Bound::Class(class) => Value::Class { file, class },
            Bound::Function(function) => Value::Function { file, function },
            Bound::Value => Value::Opaque,
            Bound::Assigned(assignment) => Value::Assigned { file, assignment },
            Bound::Parameter { function, index } => Value::Parameter { file, function, index },
            Bound::Import { import, alias } => match &self.aliases[file][import][alias].binds {
                Binds::Module(module) => Value::Module(module.clone()),
                Binds::NameOf(module, name) => self.module_attribute(file, module, name, visiting),
                Binds::Star(_) | Binds::Nothing => Value::Unbound { cycle: false },
            },
        }
    }

    /// `module.name`, read in `site`: what the module binds, else a submodule; a
    /// stub module's, as written.
    fn module_attribute(
        &self,
        site: usize,
        module: &ModuleRef,
        name: &str,
        visiting: &mut HashSet<(usize, String)>,
    ) -> Value {
        let external = |kind: Option<Kind>| Value::External {
            module: module.clone(),
            symbol: vec![name.to_owned()],
            kind,
        };
        match module {
            ModuleRef::File(file) => {
                let step = (*file, name.to_owned());
                if !visiting.insert(step.clone()) {
                    return Value::Unbound { cycle: true };
                }
                let bound = scopes::bound_in(&self.files[*file], 0, name);
                let value = if let Some(submodule) = bound
                    .is_empty()
                    .then(|| self.stars.submodule_over_star(*file, name))
                    .flatten()
                {
                    Value::Module(submodule)
                } else if bound.is_empty() {
                    match self
                        .star_value(*file, name, visiting)
                        .filter(|_| self.stars.binds(*file, name))
                    {
                        Some((value, _)) => value,
                        None => match self.modules.submodule(module, name) {
                            Some(submodule) => Value::Module(submodule),
                            None => Value::Unbound { cycle: false },
                        },
                    }
                } else {
                    self.choose(*file, &bound, visiting).0
                };
                visiting.remove(&step);
                value
            }
            ModuleRef::Namespace(_) => match self.modules.submodule(module, name) {
                Some(submodule) => Value::Module(submodule),
                None => Value::Unbound { cycle: false },
            },
            ModuleRef::Stdlib(dotted) => match self.modules.table.name(dotted, name) {
                Some(Kind::Module(target)) => Value::Module(ModuleRef::Stdlib(target.to_owned())),
                Some(kind) => external(Some(kind)),
                None => match self.modules.submodule(module, name) {
                    Some(submodule) => Value::Module(submodule),
                    None => external(None),
                },
            },
            // Only an `import` statement says a third party's name is a module.
            ModuleRef::Site(dotted) => {
                let submodule = format!("{dotted}.{name}");
                if self.imported[site].contains(&submodule) {
                    Value::Module(ModuleRef::Site(submodule))
                } else {
                    external(None)
                }
            }
            ModuleRef::Missing(_) => external(None),
        }
    }

    fn attribute(&self, site: usize, value: Value, name: &str, visiting: &mut HashSet<(usize, String)>) -> Value {
        match value {
            Value::Module(module) => self.module_attribute(site, &module, name, visiting),
            // The class's own body; what an ancestor gives it is the MRO's (M22b).
            Value::Class { file, class } => {
                let body = self.files[file].classes[class].body;
                let bound = scopes::bound_in(&self.files[file], body, name);
                if bound.is_empty() {
                    Value::Unbound { cycle: false }
                } else {
                    self.choose(file, &bound, visiting).0
                }
            }
            Value::External { module, mut symbol, .. } => {
                symbol.push(name.to_owned());
                Value::External {
                    module,
                    symbol,
                    kind: None,
                }
            }
            Value::Builtin { .. } => Value::Unbound { cycle: false },
            // What an assignment or a parameter holds is the receiver's to type.
            Value::Function { .. } | Value::Opaque | Value::Assigned { .. } | Value::Parameter { .. } => Value::Opaque,
            unbound @ (Value::Unbound { .. } | Value::AmbiguousStar(_)) => unbound,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::{self, Decoding, SourceFile};
    use crate::declarations::declarations;

    fn corpus(files: &[(&str, &str)]) -> Corpus {
        let mut files: Vec<SourceFile> = files
            .iter()
            .map(|(rel, text)| {
                let line_starts = corpus::line_starts(text);
                SourceFile {
                    rel: (*rel).to_owned(),
                    text: (*text).to_owned(),
                    decoding: Decoding::Utf8,
                    lines: corpus::line_count(text, &line_starts),
                    line_starts,
                }
            })
            .collect();
        files.sort_by(|a, b| a.rel.cmp(&b.rel));
        Corpus {
            root_display: ".".into(),
            root_name: Some("repo".into()),
            files,
            import_roots: Vec::new(),
        }
    }

    fn index(corpus: &Corpus, rel: &str) -> usize {
        corpus.files.iter().position(|file| file.rel == rel).expect(rel)
    }

    fn decls(corpus: &Corpus) -> Vec<FileDecls> {
        corpus
            .files
            .iter()
            .map(|file| declarations(&file.text, &file.line_starts))
            .collect()
    }

    const LAYOUT: &[(&str, &str)] = &[
        ("src/acme/__init__.py", "from .orders import Order\n"),
        ("src/acme/orders/__init__.py", "from .order import Order\n"),
        ("src/acme/orders/order.py", "class Order:\n    class Line: pass\n"),
        ("src/acme/pricing/__init__.py", ""),
        (
            "src/acme/pricing/rules.py",
            "from ..orders import Order\nfrom . import discounts\nfrom .missing import Nope\nfrom ... import above\nfrom .... import beyond\n",
        ),
        ("src/acme/pricing/discounts.py", ""),
        ("src/acme/legacy/__init__.py", ""),
        ("src/acme/legacy/report.py", "import helpers\nimport json\n"),
        ("src/acme/legacy/helpers.py", ""),
        ("src/acme/legacy/json.py", ""),
        ("src/acme.py", ""),
        ("src/plugins/stripe.py", ""),
        (
            "tests/test_a.py",
            "import acme\nimport acme.orders.order\nimport plugins.stripe\nimport queue\nimport os.path\n\
             import django.db\nimport acme.nope\nimport plugins\n",
        ),
        ("tests/queue.py", ""),
        ("tests/unit/utils.py", ""),
        ("tests/integration/utils.py", ""),
        ("tests/test_b.py", "import utils\n"),
    ];

    #[test]
    fn finds_a_module_below_the_roots_the_layout_implies() {
        let corpus = corpus(LAYOUT);
        let modules = Modules::new(&corpus);
        let test = index(&corpus, "tests/test_a.py");
        let found = |dotted: &str| match modules.absolute(test, dotted) {
            Lookup::Found { module, how, .. } => (module, how),
            other => panic!("{dotted}: {other:?}"),
        };
        let file = |rel: &str| ModuleRef::File(index(&corpus, rel));
        // A regular package names its own root (`src`); the package beats `acme.py` beside it.
        assert_eq!(found("acme"), (file("src/acme/__init__.py"), How::PackageRoot));
        assert_eq!(
            found("acme.orders.order"),
            (file("src/acme/orders/order.py"), How::PackageRoot)
        );
        // Through a directory with no __init__.py: counted on its own.
        assert_eq!(
            found("plugins.stripe"),
            (file("src/plugins/stripe.py"), How::NamespacePackage)
        );
        assert_eq!(
            found("plugins"),
            (ModuleRef::Namespace("src/plugins".into()), How::NamespacePackage)
        );
        // The corpus answers before the table: tests/queue.py shadows the standard library.
        assert_eq!(found("queue"), (file("tests/queue.py"), How::PackageRoot));
        assert_eq!(found("os.path"), (ModuleRef::Stdlib("os.path".into()), How::Stdlib));
        assert_eq!(found("django.db"), (ModuleRef::Site("django.db".into()), How::Site));
        // A corpus package answers `acme`, so `acme.nope` is a file that is not there, not a library.
        assert_eq!(
            found("acme.nope"),
            (ModuleRef::Missing("src/acme/nope.py".into()), How::Missing)
        );
        // Two roots at the same distance answer: dropped, never chosen.
        let tie = modules.absolute(index(&corpus, "tests/test_b.py"), "utils");
        assert_eq!(
            tie,
            Lookup::Ambiguous(vec!["tests/integration".into(), "tests/unit".into()])
        );
    }

    #[test]
    fn another_files_root_does_not_shadow_the_standard_library_its_own_root_does() {
        // CPython's `Lib/`: `test/dtracedata/` holds a `gc.py` the DTrace tests read; no
        // `sys.path` of `test/test_gc.py` holds that directory.
        let corpus = corpus(&[
            ("test/__init__.py", ""),
            ("test/test_gc.py", ""),
            ("test/dtracedata/gc.py", ""),
            ("test/dtracedata/run.py", ""),
            ("tests/queue.py", ""),
            ("tests/test_queue.py", ""),
        ]);
        let modules = Modules::new(&corpus);
        let found = |from: &str, dotted: &str| match modules.absolute(index(&corpus, from), dotted) {
            Lookup::Found { module, .. } => module,
            other => panic!("{dotted}: {other:?}"),
        };
        assert_eq!(found("test/test_gc.py", "gc"), ModuleRef::Stdlib("gc".into()));
        // Its own directory's script runs with that directory first on the path.
        assert_eq!(
            found("test/dtracedata/run.py", "gc"),
            ModuleRef::File(index(&corpus, "test/dtracedata/gc.py"))
        );
        assert_eq!(
            found("tests/test_queue.py", "queue"),
            ModuleRef::File(index(&corpus, "tests/queue.py"))
        );
        // A package below another file's root names no missing file either: the standard library's.
        let corpus = super::tests::corpus(&[
            ("scripts/email/__init__.py", ""),
            ("scripts/email/parser.py", ""),
            ("app/main.py", ""),
        ]);
        let modules = Modules::new(&corpus);
        let main = index(&corpus, "app/main.py");
        assert!(matches!(
            modules.absolute(main, "email.parser"),
            Lookup::Found { module: ModuleRef::Stdlib(ref dotted), .. } if dotted == "email.parser"
        ));
        assert!(matches!(
            modules.absolute(main, "email.nothing"),
            Lookup::Found {
                module: ModuleRef::Stdlib(_) | ModuleRef::Site(_),
                ..
            }
        ));
    }

    #[test]
    fn a_stub_answers_an_import_only_where_its_module_is_not_there() {
        let corpus = corpus(&[
            ("pkg/__init__.py", ""),
            ("pkg/fast.py", ""),
            ("pkg/fast.pyi", ""),
            ("pkg/native.pyi", ""),
            ("typed/__init__.pyi", ""),
            ("app.py", ""),
        ]);
        let modules = Modules::new(&corpus);
        let app = index(&corpus, "app.py");
        let found = |dotted: &str| match modules.absolute(app, dotted) {
            Lookup::Found { module, .. } => module,
            other => panic!("{dotted}: {other:?}"),
        };
        let file = |rel: &str| ModuleRef::File(index(&corpus, rel));
        // The program imports the module; its stub describes it, and answers only alone.
        assert_eq!(found("pkg.fast"), file("pkg/fast.py"));
        assert_eq!(found("pkg.native"), file("pkg/native.pyi"));
        assert_eq!(found("typed"), file("typed/__init__.pyi"));
    }

    #[test]
    fn an_implicit_relative_import_comes_after_the_table_and_before_a_third_party() {
        let corpus = corpus(LAYOUT);
        let modules = Modules::new(&corpus);
        let report = index(&corpus, "src/acme/legacy/report.py");
        // Python 2's rule inside a package: a sibling answers what nothing else does…
        assert!(matches!(
            modules.absolute(report, "helpers"),
            Lookup::Found { module: ModuleRef::File(f), how: How::ImplicitRelative, .. }
                if f == index(&corpus, "src/acme/legacy/helpers.py")
        ));
        // …but not a name the standard library answers: Python 3 reads `json` as the table's.
        assert!(matches!(
            modules.absolute(report, "json"),
            Lookup::Found {
                module: ModuleRef::Stdlib(_),
                how: How::Stdlib,
                ..
            }
        ));
    }

    #[test]
    fn resolves_a_relative_import_by_path_arithmetic() {
        let corpus = corpus(LAYOUT);
        let modules = Modules::new(&corpus);
        let rules = index(&corpus, "src/acme/pricing/rules.py");
        let file = |rel: &str| ModuleRef::File(index(&corpus, rel));
        let found = |level: u32, module: Option<&str>| match modules.relative(rules, level, module) {
            Lookup::Found { module, how, .. } => (module, how),
            other => panic!("{level} {module:?}: {other:?}"),
        };
        assert_eq!(
            found(2, Some("orders")),
            (file("src/acme/orders/__init__.py"), How::Relative)
        );
        assert_eq!(found(1, None), (file("src/acme/pricing/__init__.py"), How::Relative));
        // A file that is not there is counted as one, however it was named.
        assert_eq!(
            found(1, Some("missing")),
            (ModuleRef::Missing("src/acme/pricing/missing.py".into()), How::Missing)
        );
        // `src/` holds no __init__.py: a namespace, still a directory of the corpus.
        assert_eq!(found(3, None), (ModuleRef::Namespace("src".into()), How::Relative));
        assert_eq!(modules.relative(rules, 5, None), Lookup::BeyondRoot);
        assert_eq!(
            modules.submodule(&file("src/acme/pricing/__init__.py"), "discounts"),
            Some(file("src/acme/pricing/discounts.py"))
        );
        assert_eq!(modules.submodule(&file("src/acme/pricing/rules.py"), "discounts"), None);
        assert_eq!(
            modules.submodule(&ModuleRef::Stdlib("collections".into()), "abc"),
            Some(ModuleRef::Stdlib("collections.abc".into()))
        );
    }

    #[test]
    fn writes_the_import_edge_python_would_follow_for_each_name() {
        let corpus = corpus(&[
            ("src/acme/__init__.py", "from .order import Order\n"),
            ("src/acme/order.py", "class Order: pass\n"),
            ("src/plugins/stripe.py", ""),
            (
                "src/app.py",
                "from acme import Order, order\nfrom collections import abc\nfrom os import path\n\
                 from django.db import models\nfrom plugins import stripe, nothing\nfrom acme import *\nimport plugins\n",
            ),
        ]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let app = index(&corpus, "src/app.py");
        let target = |import: usize, alias: usize| resolver.alias(app, import, alias).target.clone();
        let edge = |to: ModuleRef, how: How| ImportTarget::Edge { to, how };
        let file = |rel: &str| ModuleRef::File(index(&corpus, rel));
        // `acme` binds `Order` at its top level: the package. It does not bind `order`: the submodule.
        assert_eq!(target(0, 0), edge(file("src/acme/__init__.py"), How::PackageRoot));
        assert_eq!(target(0, 1), edge(file("src/acme/order.py"), How::PackageRoot));
        assert_eq!(
            target(1, 0),
            edge(ModuleRef::Stdlib("collections.abc".into()), How::Stdlib)
        );
        assert_eq!(target(2, 0), edge(ModuleRef::Stdlib("os".into()), How::Stdlib));
        assert_eq!(target(3, 0), edge(ModuleRef::Site("django.db".into()), How::Site));
        assert_eq!(target(4, 0), edge(file("src/plugins/stripe.py"), How::NamespacePackage));
        assert_eq!(
            target(4, 1),
            ImportTarget::Dropped {
                reason: "namespace-import",
                what: "plugins.nothing".into()
            }
        );
        assert_eq!(target(5, 0), edge(file("src/acme/__init__.py"), How::PackageRoot));
        assert_eq!(
            target(6, 0),
            ImportTarget::Dropped {
                reason: "namespace-import",
                what: "plugins".into()
            }
        );
    }

    #[test]
    fn a_package_importing_its_own_submodules_is_not_answered_by_that_import() {
        // `from . import sub` in pkg/__init__.py binds `sub` there — by this very
        // statement, which therefore cannot be what binds it before it runs.
        let corpus = corpus(&[
            (
                "pkg/__init__.py",
                "from . import sub\nfrom pkg import other\nvalue = 1\nfrom . import value\n",
            ),
            ("pkg/sub.py", "class S: pass\n"),
            ("pkg/other.py", ""),
            ("pkg/value.py", ""),
        ]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let init = index(&corpus, "pkg/__init__.py");
        let file = |rel: &str| ModuleRef::File(index(&corpus, rel));
        assert_eq!(
            resolver.alias(init, 0, 0).target,
            ImportTarget::Edge {
                to: file("pkg/sub.py"),
                how: How::Relative
            }
        );
        assert_eq!(
            resolver.alias(init, 1, 0).target,
            ImportTarget::Edge {
                to: file("pkg/other.py"),
                how: How::PackageRoot
            }
        );
        // Another statement that binds the name first answers it, as the attribute Python finds.
        assert_eq!(
            resolver.alias(init, 2, 0).target,
            ImportTarget::Edge {
                to: file("pkg/__init__.py"),
                how: How::Relative
            }
        );
        let names = |text: &str| text.split('.').map(str::to_owned).collect::<Vec<_>>();
        assert_eq!(
            resolver.reference(init, 0, &names("sub.S")).value,
            Value::Class {
                file: index(&corpus, "pkg/sub.py"),
                class: 0
            }
        );
    }

    #[test]
    fn follows_a_name_through_its_re_exports_to_what_it_is() {
        let mut layout = LAYOUT.to_vec();
        layout.extend_from_slice(&[
            (
                "tests/test_c.py",
                "from acme import Order\nimport acme.orders.order as module\n",
            ),
            ("loop/a.py", "from b import Thing\n"),
            ("loop/b.py", "from a import Thing\n"),
            ("loop/c.py", "from a import Thing\n"),
            (
                "rebound.py",
                "try:\n    from simplejson import JSONDecodeError\nexcept ImportError:\n    JSONDecodeError = None\n",
            ),
        ]);
        let corpus = corpus(&layout);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let test = index(&corpus, "tests/test_c.py");
        let order = index(&corpus, "src/acme/orders/order.py");
        let names = |text: &str| text.split('.').map(str::to_owned).collect::<Vec<_>>();
        // Two __init__.py on the way: the name is the class where it is written.
        assert_eq!(
            resolver.reference(test, 0, &names("Order")).value,
            Value::Class { file: order, class: 0 }
        );
        assert_eq!(
            resolver.reference(test, 0, &names("Order.Line")).value,
            Value::Class { file: order, class: 1 }
        );
        assert_eq!(
            resolver.reference(test, 0, &names("module.Order")).value,
            Value::Class { file: order, class: 0 }
        );
        assert_eq!(
            resolver.reference(test, 0, &names("Unknown")).value,
            Value::Unbound { cycle: false }
        );
        let c = index(&corpus, "loop/c.py");
        assert_eq!(
            resolver.reference(c, 0, &names("Thing")).value,
            Value::Unbound { cycle: true }
        );
        let rebound = resolver.reference(index(&corpus, "rebound.py"), 0, &names("JSONDecodeError"));
        assert!(rebound.rebound);
        assert_eq!(
            rebound.value,
            Value::External {
                module: ModuleRef::Site("simplejson".into()),
                symbol: names("JSONDecodeError"),
                kind: None
            }
        );
    }

    #[test]
    fn a_name_an_assignment_or_a_parameter_binds_is_left_for_the_receiver_to_type() {
        let corpus = corpus(&[(
            "app.py",
            "DEBUG = False\ndef f(repo):\n    local = Repo()\n    for item in repo: pass\n",
        )]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let names = |text: &str| vec![text.to_owned()];
        assert_eq!(
            resolver.reference(0, 0, &names("DEBUG")).value,
            Value::Assigned { file: 0, assignment: 0 }
        );
        assert_eq!(
            resolver.reference(0, 1, &names("repo")).value,
            Value::Parameter {
                file: 0,
                function: 0,
                index: 0
            }
        );
        assert_eq!(
            resolver.reference(0, 1, &names("local")).value,
            Value::Assigned { file: 0, assignment: 1 }
        );
        assert_eq!(resolver.reference(0, 1, &names("item")).value, Value::Opaque);
    }

    #[test]
    fn a_submodule_answers_before_a_star_import_that_binds_its_name() {
        // asyncio's shape: the package star-imports a module whose grown `__all__` exports
        // `events`, itself the package's submodule; `from . import events` is that submodule.
        let corpus = corpus(&[
            ("asyncio/__init__.py", "from .streams import *\nfrom .events import *\n"),
            ("asyncio/events.py", "__all__ = [\"get_loop\"]\ndef get_loop(): pass\n"),
            (
                "asyncio/streams.py",
                "from . import events\n__all__ = [\"open\"]\n__all__ += [\"x\"]\n",
            ),
            ("asyncio/tasks.py", "from . import events\n"),
        ]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let events = ModuleRef::File(index(&corpus, "asyncio/events.py"));
        let tasks = index(&corpus, "asyncio/tasks.py");
        assert_eq!(
            resolver.reference(tasks, 0, &["events".to_owned()]).value,
            Value::Module(events.clone())
        );
        let package = index(&corpus, "asyncio/__init__.py");
        assert_eq!(
            resolver.reference(package, 0, &["events".to_owned()]).value,
            Value::Module(events)
        );
    }

    #[test]
    fn a_method_reads_its_implicit_class_cell_and_a_module_does_not_have_one() {
        let corpus = corpus(&[(
            "m.py",
            "class C:\n    def m(self):\n        def inner():\n            return __class__\n        return __class__\n\
             def f():\n    return __class__\n",
        )]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let class_cell = |scope: usize| resolver.reference(0, scope, &["__class__".to_owned()]).value;
        // scopes: 0 module, 1 C's body, 2 m's, 3 inner's, 4 f's
        let language = Value::Builtin {
            name: "__class__".into(),
            kind: Kind::Value,
        };
        assert_eq!(class_cell(2), language);
        assert_eq!(class_cell(3), language);
        assert_eq!(class_cell(4), Value::Unbound { cycle: false });
    }

    #[test]
    fn the_names_the_interpreter_binds_in_every_module_are_the_language() {
        let corpus = corpus(&[("pkg/__init__.py", ""), ("pkg/m.py", "def f():\n    return __name__\n")]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let file = index(&corpus, "pkg/m.py");
        for name in ["__name__", "__file__", "__doc__", "__package__", "__spec__", "__path__"] {
            assert_eq!(
                resolver.reference(file, 1, &[name.to_owned()]).value,
                Value::Builtin {
                    name: name.into(),
                    kind: Kind::Value
                },
                "{name}"
            );
        }
    }

    #[test]
    fn binds_what_a_star_import_brings_and_attributes_a_name_only_one_unknown_one_could() {
        let corpus = corpus(&[
            ("pkg/__init__.py", ""),
            (
                "pkg/shapes.py",
                "__all__ = [\"Circle\"]\nclass Circle: pass\nclass Square: pass\n",
            ),
            ("pkg/plain.py", "class Public: pass\nclass _Private: pass\n"),
            ("pkg/reexport.py", "from .shapes import *\n"),
            (
                "one.py",
                "from pkg.shapes import *\nfrom pkg.plain import *\nfrom string import *\nfrom unknown.lib import *\n",
            ),
            ("two.py", "from unknown.a import *\nfrom unknown.b import *\n"),
            ("chained.py", "from pkg.reexport import Circle\n"),
            // `token.py`'s shape: a literal `__all__`, then grown — the literal is no export list.
            (
                "pkg/grown.py",
                "__all__ = [\"A\"]\nclass A: pass\nclass NUMBER: pass\n__all__.extend(names)\n",
            ),
            (
                "pkg/added.py",
                "__all__ = [\"A\"]\n__all__ += [\"B\"]\nclass A: pass\nclass B: pass\n",
            ),
            ("growing.py", "from pkg.grown import *\nfrom pkg.added import *\n"),
        ]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let one = index(&corpus, "one.py");
        let names = |text: &str| vec![text.to_owned()];
        let shapes = index(&corpus, "pkg/shapes.py");
        let plain = index(&corpus, "pkg/plain.py");
        // `__all__` where it is literal, else the public names; a table module's exports.
        assert_eq!(
            resolver.reference(one, 0, &names("Circle")).value,
            Value::Class { file: shapes, class: 0 }
        );
        assert_eq!(
            resolver.reference(one, 0, &names("Public")).value,
            Value::Class { file: plain, class: 0 }
        );
        assert!(matches!(
            resolver.reference(one, 0, &names("Template")).value,
            Value::External { module: ModuleRef::Stdlib(ref m), .. } if m == "string"
        ));
        // `Square` is not in `__all__`, `_Private` not public: only the unknown module could bind them.
        let square = resolver.reference(one, 0, &names("Square"));
        assert!(square.star_attributed);
        assert_eq!(
            square.value,
            Value::External {
                module: ModuleRef::Site("unknown.lib".into()),
                symbol: names("Square"),
                kind: None
            }
        );
        // A builtin is the builtin: an unknown module is not presumed to shadow it.
        assert_eq!(
            resolver.reference(one, 0, &names("Exception")).value,
            Value::Builtin {
                name: "Exception".into(),
                kind: Kind::Class
            }
        );
        // Two unknown modules could: no guess.
        let two = index(&corpus, "two.py");
        assert_eq!(
            resolver.reference(two, 0, &names("Anything")).value,
            Value::AmbiguousStar(vec!["unknown.a".into(), "unknown.b".into()])
        );
        // A star re-export is followed like any other.
        assert_eq!(
            resolver
                .reference(index(&corpus, "chained.py"), 0, &names("Circle"))
                .value,
            Value::Class { file: shapes, class: 0 }
        );
        let growing = index(&corpus, "growing.py");
        assert_eq!(
            resolver.reference(growing, 0, &names("NUMBER")).value,
            Value::Class {
                file: index(&corpus, "pkg/grown.py"),
                class: 1
            }
        );
        assert_eq!(
            resolver.reference(growing, 0, &names("B")).value,
            Value::Class {
                file: index(&corpus, "pkg/added.py"),
                class: 1
            }
        );
    }

    #[test]
    fn names_a_stub_as_written_below_the_module_it_was_imported_from() {
        let corpus = corpus(&[(
            "app.py",
            "import enum\nimport sqlalchemy.orm\nfrom django.db import models\nfrom collections import abc\n\
             from os import getcwd\nimport os\n",
        )]);
        let files = decls(&corpus);
        let modules = Modules::new(&corpus);
        let resolver = Resolver::new(&modules, &files);
        let value = |text: &str| {
            let names: Vec<String> = text.split('.').map(str::to_owned).collect();
            resolver.reference(0, 0, &names).value
        };
        let external = |module: ModuleRef, symbol: &str, kind: Option<Kind>| Value::External {
            module,
            symbol: symbol.split('.').map(str::to_owned).collect(),
            kind,
        };
        assert_eq!(
            value("enum.Enum"),
            external(ModuleRef::Stdlib("enum".into()), "Enum", Some(Kind::Class))
        );
        assert_eq!(
            value("abc.Mapping"),
            external(
                ModuleRef::Stdlib("collections.abc".into()),
                "Mapping",
                Some(Kind::Class)
            )
        );
        assert_eq!(
            value("getcwd"),
            external(ModuleRef::Stdlib("os".into()), "getcwd", Some(Kind::Function))
        );
        assert_eq!(value("os.path"), Value::Module(ModuleRef::Stdlib("os.path".into())));
        // `import sqlalchemy.orm` says `sqlalchemy.orm` is a module; `from django.db import models` says nothing of `models`.
        assert_eq!(
            value("sqlalchemy.orm.DeclarativeBase"),
            external(ModuleRef::Site("sqlalchemy.orm".into()), "DeclarativeBase", None)
        );
        assert_eq!(
            value("models.Model"),
            external(ModuleRef::Site("django.db".into()), "models.Model", None)
        );
        assert_eq!(
            value("Exception"),
            Value::Builtin {
                name: "Exception".into(),
                kind: Kind::Class
            }
        );
        // Python 2's builtin, where Python 3 binds nothing; a name neither binds is unbound.
        assert_eq!(
            value("StandardError"),
            Value::Builtin {
                name: "StandardError".into(),
                kind: Kind::Class
            }
        );
        assert_eq!(value("NothingBindsThis"), Value::Unbound { cycle: false });
    }
}
