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
use crate::declarations::{Bound, FileDecls, ImportKind};
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
                    let init = self.by_path[join(&path, "__init__.py").as_str()];
                    return Some((ModuleRef::File(init), namespace));
                }
                current = path;
                continue;
            }
            let module = ["py", "pyw"]
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
                    return self
                        .by_path
                        .get("__init__.py")
                        .map(|&init| (ModuleRef::File(init), false));
                }
                self.below("", rest)
            }
        }
    }

    /// The module `dotted` names for an `import` in `file`.
    pub fn absolute(&self, file: usize, dotted: &str) -> Lookup {
        let names: Vec<&str> = dotted.split('.').collect();
        let from = parent_dir(self.rel(file));

        // 1. The corpus, at the root nearest the importing file.
        let mut hits: Vec<(usize, usize, ModuleRef, bool)> = self
            .roots
            .iter()
            .enumerate()
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
                .filter(|(_, root)| root.prefix.is_none())
                .filter_map(|(index, root)| match self.in_root(root, &names[..1]) {
                    Some((ModuleRef::File(init), _)) if self.rel(init).ends_with("__init__.py") => {
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
            None if self.packages.contains(&base) => ModuleRef::File(self.by_path[join(&base, "__init__.py").as_str()]),
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
                let package = rel == "__init__.py" || rel.ends_with("/__init__.py");
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
    /// Bound by what no line types: an assignment, a loop target.
    Opaque,
    /// Bound by nothing — or by a chain of re-exports that loops.
    Unbound {
        cycle: bool,
    },
}

impl Value {
    /// A binding that names a declaration, stub or not — the one a rebound name keeps.
    fn names_a_declaration(&self) -> bool {
        !matches!(self, Value::Opaque | Value::Unbound { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub value: Value,
    /// The name is bound more than one way where it was found: the first that names a declaration won.
    pub rebound: bool,
}

pub struct Resolver<'a> {
    pub modules: &'a Modules<'a>,
    files: &'a [FileDecls],
    /// Per file, per import, per alias.
    aliases: Vec<Vec<Vec<AliasResolution>>>,
    /// Per file: every dotted name an `import` statement writes, and each prefix — modules all.
    imported: Vec<HashSet<String>>,
}

fn dropped(reason: &'static str, what: String) -> AliasResolution {
    AliasResolution {
        target: ImportTarget::Dropped { reason, what },
        binds: Binds::Nothing,
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
/// module the name is bound in, else the submodule it is — the order Python tries.
fn from_target(
    modules: &Modules<'_>,
    files: &[FileDecls],
    (importing, import): (usize, usize),
    from: &ModuleRef,
    how: How,
    name: &str,
    written: &str,
) -> ImportTarget {
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
                        let lookup = match (level, module) {
                            (0, Some(module)) => modules.absolute(file, module),
                            // `from import x`: what recovery leaves of a statement that names no module.
                            (0, None) => Lookup::BeyondRoot,
                            (level, module) => modules.relative(file, *level, module.as_deref()),
                        };
                        list.iter()
                            .map(|alias| match &lookup {
                                Lookup::Found { module: from, how, .. } => {
                                    let target =
                                        from_target(modules, files, (file, index), from, *how, &alias.name, &written);
                                    let binds = match &target {
                                        _ if alias.name == "*" => Binds::Nothing,
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
        }
    }

    pub fn alias(&self, file: usize, import: usize, alias: usize) -> &AliasResolution {
        &self.aliases[file][import][alias]
    }

    /// What `names[0].names[1]…` read in `scope` of `file` is.
    pub fn reference(&self, file: usize, scope: usize, names: &[String]) -> Resolved {
        self.read(file, scope, names, None)
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
            };
        };
        let (mut value, rebound) = self.name(file, scope, first, unbound, &mut visiting);
        for attribute in rest {
            value = self.attribute(file, value, attribute, &mut visiting);
        }
        Resolved { value, rebound }
    }

    fn name(
        &self,
        file: usize,
        scope: usize,
        name: &str,
        unbound: Option<Bound>,
        visiting: &mut HashSet<(usize, String)>,
    ) -> (Value, bool) {
        let mut found = scopes::lookup(&self.files[file], scope, name);
        found.retain(|binding| Some(binding.bound) != unbound);
        if found.is_empty() {
            let value = match self.modules.table.builtin(name) {
                Some(kind) => Value::Builtin {
                    name: name.to_owned(),
                    kind,
                },
                None => Value::Unbound { cycle: false },
            };
            return (value, false);
        }
        self.choose(file, &found, visiting)
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
            // What a caller passes: no line here types it (M22b reads annotations and `self`).
            Bound::Value | Bound::Parameter(_) => Value::Opaque,
            Bound::Import { import, alias } => match &self.aliases[file][import][alias].binds {
                Binds::Module(module) => Value::Module(module.clone()),
                Binds::NameOf(module, name) => self.module_attribute(file, module, name, visiting),
                Binds::Nothing => Value::Unbound { cycle: false },
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
                let value = if bound.is_empty() {
                    match self.modules.submodule(module, name) {
                        Some(submodule) => Value::Module(submodule),
                        None => Value::Unbound { cycle: false },
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
            Value::Function { .. } | Value::Opaque => Value::Opaque,
            unbound @ Value::Unbound { .. } => unbound,
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
