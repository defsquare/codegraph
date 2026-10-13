//! The whitelist, the lexical resolver and the ancestor chains (PLAN.md §19.4).
//!
//! Membership is the set of constant paths the corpus WRITES — never a name
//! prefix. A constant is resolved as Ruby resolves it: each enclosing scope
//! from the innermost out, then the ancestors of the innermost, then the top
//! level. A method is looked up along the chain Ruby would walk — prepended
//! modules, the type, its mixins, its superclass's — as far as the corpus and
//! the VM's table can say; what a library would answer is never guessed.

use crate::core_table::{CoreKind, CoreTable};
use crate::declarations::{ConstPath, FileDecls, MixinKind, ScopeKind, Span, Superclass};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypeKind {
    Class,
    Module,
}

impl TypeKind {
    pub fn kind(self) -> &'static str {
        match self {
            TypeKind::Class => "class",
            TypeKind::Module => "module",
        }
    }
}

/// One entity: a constant path given a body in one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypeDecl {
    /// Index into the corpus files, which are in canonical order.
    pub file: usize,
    pub kind: TypeKind,
    /// The first body with something of its own: the entity's anchor.
    pub span: Span,
    /// The scope of that body.
    pub scope: usize,
    /// Some body of it in this file writes a superclass: the definition, by convention.
    pub has_superclass: bool,
}

/// Where a method or a constant is written: file, scope, index in that scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Place {
    pub file: usize,
    pub scope: usize,
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// A type the corpus declares: the primary declaration's file.
    Declared { fqn: String, file: usize },
    /// A type the VM defines.
    Core { fqn: String, kind: TypeKind },
    /// A name the roots do not declare and the VM does not define.
    Gems { fqn: String },
    /// A value constant the corpus assigns.
    Value { fqn: String, place: Place },
    /// A value constant of the VM (`ARGV`, `ENV`): the language.
    CoreValue { fqn: String },
    /// A namespace no file gives a body to.
    Namespace { fqn: String },
}

/// Something a type inherits from, as far as the model can name it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Ancestor {
    Corpus(String),
    Core(&'static str),
    Gems(String),
}

/// One stop of a method lookup: an ancestor's instance side or its class side.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Step {
    Instance(Ancestor),
    Singleton(Ancestor),
}

/// What all the bodies of one constant path say together.
#[derive(Default, Debug)]
pub struct TypeFacts {
    pub is_module: bool,
    pub superclass: Option<Ancestor>,
    pub includes: Vec<Ancestor>,
    pub prepends: Vec<Ancestor>,
    pub extends: Vec<Ancestor>,
    pub extends_self: bool,
    /// Some body defines methods no `def` writes.
    pub dynamic: bool,
    pub instance_methods: HashMap<String, Vec<Place>>,
    pub singleton_methods: HashMap<String, Vec<Place>>,
    /// Instance methods that also answer on the module (`module_function`).
    pub module_functions: HashSet<String>,
    pub instance_aliases: HashMap<String, String>,
    pub singleton_aliases: HashMap<String, String>,
    /// An accessor (`total`, `total=`) → the field it reads or writes (`@total`).
    pub instance_accessors: HashMap<String, String>,
    pub singleton_accessors: HashMap<String, String>,
}

/// What a name finds along a chain.
#[derive(Debug, PartialEq, Eq)]
pub enum Found<'w> {
    /// A `def` the corpus writes, in every body that writes it.
    Method { owner: &'w str, places: &'w [Place] },
    /// An `attr_*` or a Struct member: a field, read or written.
    Accessor {
        owner: &'w str,
        on_class: bool,
        field: &'w str,
        write: bool,
    },
    /// The VM's own: the class or module that defines it.
    Core { owner: &'static str },
    /// Nothing known answers. `foreign` lists the libraries in the chain that
    /// might; `dynamic` says a body in the chain defines methods at run time.
    Missing { foreign: Vec<&'w str>, dynamic: bool },
}

pub struct Whitelist<'a> {
    core: &'a CoreTable,
    /// `fqns[file][scope]`: the constant a class/module body opens.
    fqns: Vec<Vec<Option<String>>>,
    /// Every constant path the corpus writes, and every prefix of one.
    known: HashSet<String>,
    /// The entities, per constant path, in canonical file order.
    types: HashMap<String, Vec<TypeDecl>>,
    /// The value constants, per constant path, in canonical file order.
    constants: HashMap<String, Vec<Place>>,
    facts: HashMap<String, TypeFacts>,
    /// `def`s written at a file's top level, by name.
    toplevel: HashMap<String, Vec<Place>>,
}

fn join(base: &str, rest: &[String]) -> String {
    let mut out = base.to_owned();
    for segment in rest {
        if !out.is_empty() {
            out.push_str("::");
        }
        out.push_str(segment);
    }
    out
}

/// A constant path resolved lexically: `nesting` is `Module.nesting`, innermost first.
fn resolve_path(path: &ConstPath, nesting: &[&str], is_known: &dyn Fn(&str) -> bool) -> String {
    if path.absolute {
        return join("", &path.segments);
    }
    let head = &path.segments[0];
    let base = nesting
        .iter()
        .map(|cref| format!("{cref}::{head}"))
        .find(|candidate| is_known(candidate))
        // The top level, whether or not anything is known there: an unknown
        // name is taken as written.
        .unwrap_or_else(|| head.clone());
    join(&base, &path.segments[1..])
}

impl<'a> Whitelist<'a> {
    pub fn build(files: &[FileDecls], core: &'a CoreTable) -> Self {
        let mut whitelist = Whitelist {
            core,
            fqns: Vec::new(),
            known: HashSet::new(),
            types: HashMap::new(),
            constants: HashMap::new(),
            facts: HashMap::new(),
            toplevel: HashMap::new(),
        };

        // `class A::B` needs `A` resolved, and `A` may itself be declared
        // compactly further on: iterate to the fixed point (two rounds on any
        // corpus written by people).
        let mut constant_names: Vec<Vec<Vec<String>>> = Vec::new();
        for _ in 0..8 {
            let (fqns, constants, known) = whitelist.name_scopes(files);
            let stable = known == whitelist.known;
            whitelist.fqns = fqns;
            whitelist.known = known;
            constant_names = constants;
            if stable {
                break;
            }
        }

        for (file, decls) in files.iter().enumerate() {
            // One entity per constant path per file: its first body that is not a wrapper.
            let mut seen: HashMap<&str, usize> = HashMap::new();
            for (scope_index, scope) in decls.scopes.iter().enumerate() {
                let kind = match scope.kind {
                    ScopeKind::Class => TypeKind::Class,
                    ScopeKind::Module => TypeKind::Module,
                    ScopeKind::File | ScopeKind::Opaque => continue,
                };
                if scope.wrapper {
                    continue;
                }
                let Some(fqn) = whitelist.fqns[file][scope_index].as_deref() else {
                    continue;
                };
                let has_superclass = scope.superclass != Superclass::None;
                let list = whitelist.types.entry(fqn.to_owned()).or_default();
                match seen.get(fqn) {
                    Some(&at) => list[at].has_superclass |= has_superclass,
                    None => {
                        seen.insert(fqn, list.len());
                        list.push(TypeDecl {
                            file,
                            kind,
                            span: scope.span,
                            scope: scope_index,
                            has_superclass,
                        });
                    }
                }
            }
        }
        // A constant some file assigns a value to — unless a body makes it a type.
        for (file, per_scope) in constant_names.iter().enumerate() {
            for (scope, names) in per_scope.iter().enumerate() {
                for (index, fqn) in names.iter().enumerate() {
                    if !whitelist.types.contains_key(fqn) {
                        whitelist
                            .constants
                            .entry(fqn.clone())
                            .or_default()
                            .push(Place { file, scope, index });
                    }
                }
            }
        }
        whitelist.gather_facts(files);
        whitelist
    }

    /// One round: every scope's constant, and every assigned constant, under
    /// the names known so far.
    #[allow(clippy::type_complexity)]
    fn name_scopes(&self, files: &[FileDecls]) -> (Vec<Vec<Option<String>>>, Vec<Vec<Vec<String>>>, HashSet<String>) {
        let is_known = |name: &str| self.known.contains(name) || self.core.contains(name);
        let mut all = Vec::with_capacity(files.len());
        let mut all_constants = Vec::with_capacity(files.len());
        let mut known = HashSet::new();
        let note = |fqn: &str, known: &mut HashSet<String>| {
            // A constant path implies its prefixes: `A::B::C` cannot exist without `A::B`.
            let mut prefix = String::new();
            for segment in fqn.split("::") {
                if !prefix.is_empty() {
                    prefix.push_str("::");
                }
                prefix.push_str(segment);
                known.insert(prefix.clone());
            }
        };
        let open = |path: &ConstPath, nesting: &[&str]| match (path.absolute, path.segments.as_slice()) {
            // `class Order` opens `Order` in the scope it is written in — never an outer one.
            (false, [name]) => join(nesting.first().copied().unwrap_or(""), std::slice::from_ref(name)),
            _ => resolve_path(path, nesting, &is_known),
        };
        for decls in files {
            let mut fqns: Vec<Option<String>> = vec![None; decls.scopes.len()];
            for (index, scope) in decls.scopes.iter().enumerate() {
                // Scopes are in source order, so a parent is named before its children.
                let nesting = nesting_of(&decls.scopes, &fqns, scope.parent);
                if let (ScopeKind::Class | ScopeKind::Module, Some(path)) = (scope.kind, &scope.path) {
                    let fqn = open(path, &nesting);
                    note(&fqn, &mut known);
                    fqns[index] = Some(fqn);
                }
            }
            let mut constants = Vec::with_capacity(decls.scopes.len());
            for (index, scope) in decls.scopes.iter().enumerate() {
                let nesting = nesting_of(&decls.scopes, &fqns, Some(index));
                let names: Vec<String> = scope
                    .constants
                    .iter()
                    .map(|constant| open(&constant.path, &nesting))
                    .collect();
                for fqn in &names {
                    note(fqn, &mut known);
                }
                constants.push(names);
            }
            all.push(fqns);
            all_constants.push(constants);
        }
        (all, all_constants, known)
    }

    /// What every body of each type says: its ancestry, its methods, its accessors.
    fn gather_facts(&mut self, files: &[FileDecls]) {
        let mut facts: HashMap<String, TypeFacts> = HashMap::new();
        let mut toplevel: HashMap<String, Vec<Place>> = HashMap::new();
        for (file, decls) in files.iter().enumerate() {
            for (scope_index, scope) in decls.scopes.iter().enumerate() {
                if scope.kind == ScopeKind::File {
                    for (index, method) in scope.methods.iter().enumerate() {
                        toplevel.entry(method.name.clone()).or_default().push(Place {
                            file,
                            scope: scope_index,
                            index,
                        });
                    }
                    continue;
                }
                let Some(fqn) = self.fqns[file][scope_index].as_deref() else {
                    continue;
                };
                // The superclass is evaluated where the class is written; a mixin, inside it.
                let outside = self.nesting(files, file, scope.parent);
                let inside = self.nesting(files, file, Some(scope_index));
                let superclass = match &scope.superclass {
                    Superclass::Constant(reference) => self.ancestor_of(&self.resolve(&reference.path, &outside)),
                    Superclass::Core(name, _) => self.core.name(name).map(Ancestor::Core),
                    Superclass::None | Superclass::Computed => None,
                };
                let mixins: Vec<(MixinKind, Option<Ancestor>)> = scope
                    .mixins
                    .iter()
                    .map(|mixin| {
                        (
                            mixin.kind,
                            self.ancestor_of(&self.resolve(&mixin.reference.path, &inside)),
                        )
                    })
                    .collect();

                let entry = facts.entry(fqn.to_owned()).or_default();
                entry.is_module = scope.kind == ScopeKind::Module;
                if entry.superclass.is_none() {
                    entry.superclass = superclass;
                }
                for (kind, ancestor) in mixins {
                    let Some(ancestor) = ancestor else { continue };
                    let list = match kind {
                        MixinKind::Include => &mut entry.includes,
                        MixinKind::Prepend => &mut entry.prepends,
                        MixinKind::Extend => &mut entry.extends,
                    };
                    if !list.contains(&ancestor) {
                        list.push(ancestor);
                    }
                }
                entry.extends_self |= scope.extends_self;
                entry.dynamic |= scope.dynamic;
                for (index, method) in scope.methods.iter().enumerate() {
                    let place = Place {
                        file,
                        scope: scope_index,
                        index,
                    };
                    let table = if method.singleton {
                        &mut entry.singleton_methods
                    } else {
                        &mut entry.instance_methods
                    };
                    table.entry(method.name.clone()).or_default().push(place);
                    if method.module_function {
                        entry.module_functions.insert(method.name.clone());
                    }
                }
                for alias in &scope.aliases {
                    let table = if alias.on_class {
                        &mut entry.singleton_aliases
                    } else {
                        &mut entry.instance_aliases
                    };
                    table.insert(alias.new_name.clone(), alias.old_name.clone());
                }
                for attr in &scope.attrs {
                    let table = if attr.on_class {
                        &mut entry.singleton_accessors
                    } else {
                        &mut entry.instance_accessors
                    };
                    if attr.reader {
                        table
                            .entry(attr.name.clone())
                            .or_insert_with(|| format!("@{}", attr.name));
                    }
                    if attr.writer {
                        table
                            .entry(format!("{}=", attr.name))
                            .or_insert_with(|| format!("@{}", attr.name));
                    }
                }
                // A Struct or Data member answers `x` and `x=`.
                for (member, _) in &scope.members {
                    entry
                        .instance_accessors
                        .entry(member.clone())
                        .or_insert_with(|| format!("@{member}"));
                    entry
                        .instance_accessors
                        .entry(format!("{member}="))
                        .or_insert_with(|| format!("@{member}"));
                }
            }
        }
        self.facts = facts;
        self.toplevel = toplevel;
    }

    /// A resolved constant as something to inherit from or to send a message to.
    pub fn ancestor_of(&self, resolution: &Resolution) -> Option<Ancestor> {
        match resolution {
            Resolution::Declared { fqn, .. } => Some(Ancestor::Corpus(fqn.clone())),
            Resolution::Core { fqn, .. } => self.core.name(fqn).map(Ancestor::Core),
            Resolution::Gems { fqn } => Some(Ancestor::Gems(fqn.clone())),
            Resolution::Value { .. } | Resolution::CoreValue { .. } | Resolution::Namespace { .. } => None,
        }
    }

    /// The constant a class/module body opens.
    pub fn fqn(&self, file: usize, scope: usize) -> Option<&str> {
        self.fqns[file][scope].as_deref()
    }

    /// `Module.nesting` inside `scope`, innermost first.
    pub fn nesting<'s>(&'s self, files: &[FileDecls], file: usize, scope: Option<usize>) -> Vec<&'s str> {
        nesting_of(&files[file].scopes, &self.fqns[file], scope)
    }

    /// The entities of a constant path, in canonical file order.
    pub fn declarations(&self, fqn: &str) -> &[TypeDecl] {
        self.types.get(fqn).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn declaration_in(&self, fqn: &str, file: usize) -> Option<&TypeDecl> {
        self.declarations(fqn).iter().find(|decl| decl.file == file)
    }

    pub fn type_count(&self) -> usize {
        self.types.values().map(Vec::len).sum()
    }

    /// The declaration a reference to the constant targets: the one that
    /// writes a superclass, else the first in canonical file order.
    pub fn primary(&self, fqn: &str) -> Option<&TypeDecl> {
        let declarations = self.declarations(fqn);
        declarations
            .iter()
            .find(|decl| decl.has_superclass)
            .or_else(|| declarations.first())
    }

    /// The constant path a value constant is assigned under, and where.
    pub fn constant_places(&self, fqn: &str) -> &[Place] {
        self.constants.get(fqn).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn facts(&self, fqn: &str) -> Option<&TypeFacts> {
        self.facts.get(fqn)
    }

    /// `def`s written at a file's top level under this name.
    pub fn toplevel(&self, name: &str) -> &[Place] {
        self.toplevel.get(name).map(Vec::as_slice).unwrap_or(&[])
    }

    /// What a constant path names, by the lexical scopes alone — how the
    /// header of a declaration (`< Base`, `include M`) is read.
    pub fn resolve(&self, path: &ConstPath, nesting: &[&str]) -> Resolution {
        let is_known = |name: &str| self.known.contains(name) || self.core.contains(name);
        self.classify(resolve_path(path, nesting, &is_known))
    }

    /// What a constant path written inside a body names: the lexical scopes,
    /// then the ancestors of the innermost one, then the top level.
    pub fn resolve_at(&self, files: &[FileDecls], file: usize, scope: usize, path: &ConstPath) -> Resolution {
        let nesting = self.nesting(files, file, Some(scope));
        let is_known = |name: &str| self.known.contains(name) || self.core.contains(name);
        if path.absolute {
            return self.classify(join("", &path.segments));
        }
        let head = &path.segments[0];
        let lexical = nesting
            .iter()
            .map(|cref| format!("{cref}::{head}"))
            .find(|candidate| is_known(candidate));
        let inherited = || {
            let cref = nesting.first()?;
            self.instance_chain(cref).into_iter().skip(1).find_map(|step| {
                match step {
                    Step::Instance(Ancestor::Corpus(ancestor)) => Some(format!("{ancestor}::{head}")),
                    Step::Instance(Ancestor::Core(ancestor)) => Some(format!("{ancestor}::{head}")),
                    _ => None,
                }
                .filter(|candidate| is_known(candidate))
            })
        };
        let base = lexical.or_else(inherited).unwrap_or_else(|| head.clone());
        self.classify(join(&base, &path.segments[1..]))
    }

    /// What a fully qualified constant is. The VM's types come first: it
    /// defined them before any file ran, so a corpus body of `String` can only
    /// be a reopening, and a reference to `String` is a reference to the VM's.
    pub fn classify(&self, fqn: String) -> Resolution {
        match self.core.kind(&fqn) {
            Some(CoreKind::Class) => {
                return Resolution::Core {
                    fqn,
                    kind: TypeKind::Class,
                };
            }
            Some(CoreKind::Module) => {
                return Resolution::Core {
                    fqn,
                    kind: TypeKind::Module,
                };
            }
            Some(CoreKind::Constant) => return Resolution::CoreValue { fqn },
            None => {}
        }
        if let Some(primary) = self.primary(&fqn) {
            return Resolution::Declared {
                file: primary.file,
                fqn,
            };
        }
        if let Some(place) = self.constant_places(&fqn).first() {
            return Resolution::Value { place: *place, fqn };
        }
        if self.known.contains(&fqn) {
            Resolution::Namespace { fqn }
        } else {
            Resolution::Gems { fqn }
        }
    }

    fn push(&self, step: Step, out: &mut Vec<Step>) {
        if !out.contains(&step) {
            out.push(step);
        }
    }

    fn push_instance(&self, ancestor: &Ancestor, out: &mut Vec<Step>, visiting: &mut Vec<String>) {
        match ancestor {
            Ancestor::Corpus(fqn) => {
                if visiting.contains(fqn) {
                    return;
                }
                visiting.push(fqn.clone());
                let facts = self.facts.get(fqn);
                for prepended in facts.iter().flat_map(|facts| facts.prepends.iter().rev()) {
                    self.push_instance(prepended, out, visiting);
                }
                self.push(Step::Instance(ancestor.clone()), out);
                for included in facts.iter().flat_map(|facts| facts.includes.iter().rev()) {
                    self.push_instance(included, out, visiting);
                }
                if self.core.name(fqn).is_some() {
                    // A corpus body of a core class: the rest is the VM's.
                    for core in self.core.ancestors(fqn) {
                        self.push(Step::Instance(Ancestor::Core(core)), out);
                    }
                } else if let Some(superclass) = facts.and_then(|facts| facts.superclass.as_ref()) {
                    self.push_instance(superclass, out, visiting);
                }
                visiting.pop();
            }
            Ancestor::Core(name) => {
                for core in self.core.ancestors(name) {
                    self.push(Step::Instance(Ancestor::Core(core)), out);
                }
            }
            Ancestor::Gems(_) => self.push(Step::Instance(ancestor.clone()), out),
        }
    }

    fn is_module(&self, fqn: &str) -> bool {
        match self.facts.get(fqn) {
            Some(facts) => facts.is_module,
            None => self.core.kind(fqn) == Some(CoreKind::Module),
        }
    }

    /// The chain an instance of `fqn` answers along: prepended modules, the
    /// type, its mixins, its superclass's — and what every object answers.
    pub fn instance_chain(&self, fqn: &str) -> Vec<Step> {
        let mut out = Vec::new();
        let ancestor = self.as_ancestor(fqn);
        self.push_instance(&ancestor, &mut out, &mut Vec::new());
        if !self.is_module(fqn) {
            for core in ["Object", "Kernel", "BasicObject"] {
                self.push(Step::Instance(Ancestor::Core(core)), &mut out);
            }
        }
        out
    }

    /// The chain `self` answers along INSIDE an instance method of `fqn`. A
    /// module has no Object of its own, but whatever mixes it in is one: its
    /// methods may call `raise` and `puts` like anyone's.
    pub fn receiver_chain(&self, fqn: &str) -> Vec<Step> {
        let mut out = self.instance_chain(fqn);
        for core in ["Object", "Kernel", "BasicObject"] {
            self.push(Step::Instance(Ancestor::Core(core)), &mut out);
        }
        out
    }

    fn push_singleton(&self, ancestor: &Ancestor, out: &mut Vec<Step>, visiting: &mut Vec<String>) {
        match ancestor {
            Ancestor::Corpus(fqn) => {
                if visiting.contains(fqn) {
                    return;
                }
                visiting.push(fqn.clone());
                self.push(Step::Singleton(ancestor.clone()), out);
                let facts = self.facts.get(fqn);
                for extended in facts.iter().flat_map(|facts| facts.extends.iter().rev()) {
                    self.push_instance(extended, out, &mut Vec::new());
                }
                if self.core.name(fqn).is_some() {
                    for core in self.core.superclasses(fqn) {
                        self.push(Step::Singleton(Ancestor::Core(core)), out);
                    }
                } else if let Some(superclass) = facts.and_then(|facts| facts.superclass.as_ref()) {
                    self.push_singleton(superclass, out, visiting);
                }
                visiting.pop();
            }
            Ancestor::Core(name) => {
                for core in self.core.superclasses(name) {
                    self.push(Step::Singleton(Ancestor::Core(core)), out);
                }
            }
            Ancestor::Gems(_) => self.push(Step::Singleton(ancestor.clone()), out),
        }
    }

    /// The chain the type ITSELF answers along (`Foo.bar`, a class body, a
    /// singleton method): its own singleton methods, what it extends, its
    /// superclass's — and what every class or module answers.
    pub fn singleton_chain(&self, fqn: &str) -> Vec<Step> {
        let mut out = Vec::new();
        let ancestor = self.as_ancestor(fqn);
        self.push_singleton(&ancestor, &mut out, &mut Vec::new());
        let metaclass: &[&'static str] = if self.is_module(fqn) {
            &["Module", "Object", "Kernel", "BasicObject"]
        } else {
            &["Class", "Module", "Object", "Kernel", "BasicObject"]
        };
        for core in metaclass {
            self.push(Step::Instance(Ancestor::Core(core)), &mut out);
        }
        out
    }

    /// The chain a file's top level answers along: `self` is `main`, an Object.
    pub fn main_chain(&self) -> Vec<Step> {
        ["Object", "Kernel", "BasicObject"]
            .into_iter()
            .map(|core| Step::Instance(Ancestor::Core(core)))
            .collect()
    }

    /// A constant path as an ancestor: the corpus's if it writes a body for
    /// it, else the VM's, else a library's.
    pub fn as_ancestor(&self, fqn: &str) -> Ancestor {
        if self.facts.contains_key(fqn) {
            Ancestor::Corpus(fqn.to_owned())
        } else if let Some(core) = self
            .core
            .name(fqn)
            .filter(|_| self.core.kind(fqn) != Some(CoreKind::Constant))
        {
            Ancestor::Core(core)
        } else {
            Ancestor::Gems(fqn.to_owned())
        }
    }

    /// The first thing along `chain` that answers `name`.
    pub fn lookup<'w>(&'w self, chain: &'w [Step], name: &str) -> Found<'w> {
        let mut foreign: Vec<&'w str> = Vec::new();
        let mut dynamic = false;
        // An alias found at one stop renames what is looked for from there on.
        let mut name = name;
        for step in chain {
            match step {
                Step::Instance(Ancestor::Corpus(fqn)) => {
                    let Some(facts) = self.facts.get(fqn) else { continue };
                    dynamic |= facts.dynamic;
                    let method = facts.instance_aliases.get(name).map(String::as_str).unwrap_or(name);
                    name = method;
                    if let Some(places) = facts.instance_methods.get(method) {
                        return Found::Method { owner: fqn, places };
                    }
                    if let Some(field) = facts.instance_accessors.get(name) {
                        return Found::Accessor {
                            owner: fqn,
                            on_class: false,
                            field,
                            write: name.ends_with('='),
                        };
                    }
                }
                Step::Singleton(Ancestor::Corpus(fqn)) => {
                    let Some(facts) = self.facts.get(fqn) else { continue };
                    dynamic |= facts.dynamic;
                    let method = facts.singleton_aliases.get(name).map(String::as_str).unwrap_or(name);
                    name = method;
                    if let Some(places) = facts.singleton_methods.get(method) {
                        return Found::Method { owner: fqn, places };
                    }
                    // `module_function`, `extend self`: an instance method answers on the module.
                    if (facts.extends_self || facts.module_functions.contains(method))
                        && let Some(places) = facts.instance_methods.get(method)
                    {
                        return Found::Method { owner: fqn, places };
                    }
                    if let Some(field) = facts.singleton_accessors.get(name) {
                        return Found::Accessor {
                            owner: fqn,
                            on_class: true,
                            field,
                            write: name.ends_with('='),
                        };
                    }
                }
                Step::Instance(Ancestor::Core(owner)) => {
                    if self.core.defines_instance(owner, name) {
                        return Found::Core { owner };
                    }
                }
                Step::Singleton(Ancestor::Core(owner)) => {
                    if self.core.defines_singleton(owner, name) {
                        return Found::Core { owner };
                    }
                }
                Step::Instance(Ancestor::Gems(fqn)) | Step::Singleton(Ancestor::Gems(fqn)) => {
                    if !foreign.contains(&fqn.as_str()) {
                        foreign.push(fqn);
                    }
                }
            }
        }
        Found::Missing { foreign, dynamic }
    }
}

fn nesting_of<'s>(
    scopes: &[crate::declarations::Scope],
    fqns: &'s [Option<String>],
    mut scope: Option<usize>,
) -> Vec<&'s str> {
    let mut nesting = Vec::new();
    while let Some(index) = scope {
        if let Some(fqn) = fqns[index].as_deref() {
            nesting.push(fqn);
        }
        scope = scopes[index].parent;
    }
    nesting
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_table;
    use crate::declarations::declarations;

    fn corpus(sources: &[&str]) -> Vec<FileDecls> {
        sources.iter().map(|source| declarations(source.as_bytes())).collect()
    }

    fn fqns<'w>(whitelist: &'w Whitelist<'_>, file: usize) -> Vec<&'w str> {
        whitelist.fqns[file].iter().filter_map(|f| f.as_deref()).collect()
    }

    fn path(text: &str) -> ConstPath {
        let absolute = text.starts_with("::");
        ConstPath {
            absolute,
            segments: text.trim_start_matches("::").split("::").map(str::to_owned).collect(),
        }
    }

    fn steps(chain: &[Step]) -> Vec<String> {
        chain
            .iter()
            .map(|step| match step {
                Step::Instance(Ancestor::Corpus(name)) => name.clone(),
                Step::Instance(Ancestor::Core(name)) => format!("<ruby>/{name}"),
                Step::Instance(Ancestor::Gems(name)) => format!("<gems>/{name}"),
                Step::Singleton(Ancestor::Corpus(name)) => format!("{name}.self"),
                Step::Singleton(Ancestor::Core(name)) => format!("<ruby>/{name}.self"),
                Step::Singleton(Ancestor::Gems(name)) => format!("<gems>/{name}.self"),
            })
            .collect()
    }

    #[test]
    fn names_nested_and_compact_declarations_alike() {
        let files = corpus(&[
            "module Acme\n  class Order\n    class Line; end\n  end\nend\n",
            "class Acme::Order::Line; end\nclass ::Top; end\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        assert_eq!(fqns(&whitelist, 0), vec!["Acme", "Acme::Order", "Acme::Order::Line"]);
        assert_eq!(fqns(&whitelist, 1), vec!["Acme::Order::Line", "Top"]);
    }

    #[test]
    fn a_simple_name_opens_a_constant_in_its_own_scope_never_an_outer_one() {
        // `class Base` inside `Acme::Pricing` is `Acme::Pricing::Base`, even with `Acme::Base` declared.
        let files = corpus(&[
            "module Acme\n  class Base; end\n  module Pricing\n    class Base; def x; end; end\n  end\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        assert_eq!(
            fqns(&whitelist, 0),
            vec!["Acme", "Acme::Base", "Acme::Pricing", "Acme::Pricing::Base"]
        );
    }

    #[test]
    fn resolves_a_compact_head_lexically_whatever_the_file_order() {
        // `Pricing::Standard` inside `module Acme` is `Acme::Pricing::Standard`
        // because `Acme::Pricing` is declared — in a file read later.
        let files = corpus(&[
            "module Acme\n  class Pricing::Standard; end\nend\n",
            "module Acme\n  module Pricing\n    X = 1\n  end\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        assert_eq!(fqns(&whitelist, 0), vec!["Acme", "Acme::Pricing::Standard"]);
    }

    #[test]
    fn one_entity_per_declaring_file_and_none_for_a_wrapper() {
        let files = corpus(&[
            "module Acme\n  class Order; def a; end; end\nend\nmodule Acme\n  class Order; def b; end; end\nend\n",
            "class Acme::Order < Base\n  def c; end\nend\n",
            "module Acme\n  VERSION = '1'\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        // Two bodies in file 0 are one entity, anchored at the first.
        let order: Vec<(usize, Span)> = whitelist
            .declarations("Acme::Order")
            .iter()
            .map(|d| (d.file, d.span))
            .collect();
        assert_eq!(order, vec![(0, (2, 2)), (1, (1, 3))]);
        // `Acme` is a wrapper in files 0 and 1 and a declaration in file 2 only.
        let acme: Vec<usize> = whitelist.declarations("Acme").iter().map(|d| d.file).collect();
        assert_eq!(acme, vec![2]);
        // The primary is the body that writes a superclass, not the first file.
        assert_eq!(whitelist.primary("Acme::Order").map(|d| d.file), Some(1));
        assert_eq!(whitelist.primary("Acme").map(|d| d.file), Some(2));
    }

    #[test]
    fn resolves_innermost_first_then_the_top_level() {
        let files = corpus(&[
            "class Base; end\nmodule Acme\n  class Base; end\n  module Pricing\n    class Standard < Base; end\n  end\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        let inside = whitelist.nesting(&files, 0, Some(4));
        assert_eq!(inside, vec!["Acme::Pricing", "Acme"]);
        assert_eq!(
            whitelist.resolve(&path("Base"), &inside),
            Resolution::Declared {
                fqn: "Acme::Base".into(),
                file: 0
            }
        );
        assert_eq!(
            whitelist.resolve(&path("::Base"), &inside),
            Resolution::Declared {
                fqn: "Base".into(),
                file: 0
            }
        );
        assert_eq!(
            whitelist.resolve(&path("Base"), &[]),
            Resolution::Declared {
                fqn: "Base".into(),
                file: 0
            }
        );
    }

    #[test]
    fn a_compact_class_does_not_see_its_namespace() {
        // The Ruby gotcha, kept: `class Acme::Order` opens ONE scope, so a
        // bare `Priceable` inside it is not `Acme::Priceable`.
        let files = corpus(&[
            "module Acme\n  module Priceable; def price; end; end\nend\n",
            "class Acme::Order\n  include Priceable\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        let compact = whitelist.nesting(&files, 1, Some(1));
        assert_eq!(compact, vec!["Acme::Order"]);
        assert_eq!(
            whitelist.resolve(&path("Priceable"), &compact),
            Resolution::Gems {
                fqn: "Priceable".into()
            }
        );
        assert_eq!(
            whitelist.resolve(&path("Acme::Priceable"), &compact),
            Resolution::Declared {
                fqn: "Acme::Priceable".into(),
                file: 0
            }
        );
    }

    #[test]
    fn membership_is_the_whitelist_never_a_name() {
        let files = corpus(&[
            "module Acme\n  class Order; def x; end; end\nend\nclass String\n  def blank?; end\nend\nmodule Enumerable::Extra; def y; end; end\nLIMIT = 3\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        // The VM defines these, whatever the corpus says about them.
        assert_eq!(
            whitelist.resolve(&path("StandardError"), &[]),
            Resolution::Core {
                fqn: "StandardError".into(),
                kind: TypeKind::Class
            }
        );
        assert_eq!(
            whitelist.resolve(&path("Comparable"), &[]),
            Resolution::Core {
                fqn: "Comparable".into(),
                kind: TypeKind::Module
            }
        );
        // A corpus body of `String` is a reopening: a reference still names the VM's.
        assert_eq!(
            whitelist.resolve(&path("String"), &[]),
            Resolution::Core {
                fqn: "String".into(),
                kind: TypeKind::Class
            }
        );
        assert_eq!(whitelist.declarations("String").len(), 1);
        // A corpus type whose name starts like a core one is corpus.
        assert_eq!(
            whitelist.resolve(&path("Enumerable::Extra"), &[]),
            Resolution::Declared {
                fqn: "Enumerable::Extra".into(),
                file: 0
            }
        );
        // Undeclared and not the VM's: a library, even under a corpus namespace.
        assert_eq!(
            whitelist.resolve(&path("ActiveRecord::Base"), &[]),
            Resolution::Gems {
                fqn: "ActiveRecord::Base".into()
            }
        );
        assert_eq!(
            whitelist.resolve(&path("Acme::Missing"), &[]),
            Resolution::Gems {
                fqn: "Acme::Missing".into()
            }
        );
        // The standard library is not the VM's.
        assert_eq!(
            whitelist.resolve(&path("Forwardable"), &[]),
            Resolution::Gems {
                fqn: "Forwardable".into()
            }
        );
        // Known, and no type: a namespace no file gives a body to, a value the
        // corpus assigns, a value of the VM.
        assert_eq!(
            whitelist.resolve(&path("Acme"), &[]),
            Resolution::Namespace { fqn: "Acme".into() }
        );
        assert_eq!(
            whitelist.resolve(&path("LIMIT"), &[]),
            Resolution::Value {
                fqn: "LIMIT".into(),
                place: Place {
                    file: 0,
                    scope: 0,
                    index: 0
                }
            }
        );
        assert_eq!(
            whitelist.resolve(&path("ARGV"), &[]),
            Resolution::CoreValue { fqn: "ARGV".into() }
        );
    }

    #[test]
    fn a_core_constant_resolves_below_its_core_namespace() {
        let files = corpus(&["class File\n  def patched; end\nend\n"]);
        let whitelist = Whitelist::build(&files, core_table::table());
        let inside = whitelist.nesting(&files, 0, Some(1));
        assert_eq!(
            whitelist.resolve(&path("Stat"), &inside),
            Resolution::Core {
                fqn: "File::Stat".into(),
                kind: TypeKind::Class
            }
        );
    }

    #[test]
    fn a_constant_is_found_through_the_ancestors_of_the_innermost_scope() {
        let files = corpus(&[
            "class Base\n  LIMIT = 3\n  class Line; def x; end; end\nend\nmodule Limits\n  MAX = 9\nend\nclass Order < Base\n  include Limits\n  def check; end\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        let order = files[0]
            .scopes
            .iter()
            .position(|s| s.path.as_ref().is_some_and(|p| p.segments == ["Order"]))
            .unwrap();
        // Lexically `Order::LIMIT` is nothing; through the superclass it is `Base::LIMIT`.
        assert!(
            matches!(whitelist.resolve_at(&files, 0, order, &path("LIMIT")), Resolution::Value { fqn, .. } if fqn == "Base::LIMIT")
        );
        assert!(
            matches!(whitelist.resolve_at(&files, 0, order, &path("MAX")), Resolution::Value { fqn, .. } if fqn == "Limits::MAX")
        );
        assert_eq!(
            whitelist.resolve_at(&files, 0, order, &path("Line")),
            Resolution::Declared {
                fqn: "Base::Line".into(),
                file: 0
            }
        );
        // The header of a declaration is read lexically only.
        assert_eq!(
            whitelist.resolve(&path("LIMIT"), &["Order"]),
            Resolution::Gems { fqn: "LIMIT".into() }
        );
    }

    #[test]
    fn linearizes_a_type_as_ruby_does() {
        let files = corpus(&[
            "module Audited; end\nmodule Priceable; include Comparable; end\nmodule Finders; end\nclass Base; end\nclass Order < Base\n  prepend Audited\n  include Priceable\n  extend Finders\nend\nclass Record < ActiveRecord::Base; end\nclass Label < String; end\nmodule Util; end\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        assert_eq!(
            steps(&whitelist.instance_chain("Order")),
            vec![
                "Audited",
                "Order",
                "Priceable",
                "<ruby>/Comparable",
                "Base",
                "<ruby>/Object",
                "<ruby>/Kernel",
                "<ruby>/BasicObject"
            ]
        );
        assert_eq!(
            steps(&whitelist.singleton_chain("Order")),
            vec![
                "Order.self",
                "Finders",
                "Base.self",
                "<ruby>/Class",
                "<ruby>/Module",
                "<ruby>/Object",
                "<ruby>/Kernel",
                "<ruby>/BasicObject"
            ]
        );
        // A library superclass is a stop the model cannot see into.
        assert_eq!(
            steps(&whitelist.instance_chain("Record")),
            vec![
                "Record",
                "<gems>/ActiveRecord::Base",
                "<ruby>/Object",
                "<ruby>/Kernel",
                "<ruby>/BasicObject"
            ]
        );
        // A core superclass brings the VM's own ancestry.
        assert_eq!(
            steps(&whitelist.instance_chain("Label")),
            vec![
                "Label",
                "<ruby>/String",
                "<ruby>/Comparable",
                "<ruby>/Object",
                "<ruby>/Kernel",
                "<ruby>/BasicObject"
            ]
        );
        // A module has no Object of its own; on the class side it is a Module.
        assert_eq!(steps(&whitelist.instance_chain("Util")), vec!["Util"]);
        assert_eq!(
            steps(&whitelist.singleton_chain("Util")),
            vec![
                "Util.self",
                "<ruby>/Module",
                "<ruby>/Object",
                "<ruby>/Kernel",
                "<ruby>/BasicObject"
            ]
        );
    }

    #[test]
    fn looks_a_method_up_along_the_chain() {
        let files = corpus(&[
            "module Priceable\n  def price; end\nend\nclass Base\n  def save; end\n  def self.find(id); end\nend\nclass Order < Base\n  include Priceable\n  attr_reader :total\n  attr_writer :note\n  alias_method :cost, :price\n  def total_with_tax; end\n  class << self\n    attr_accessor :registry\n  end\nend\nclass Record < ActiveRecord::Base\n  include Sidekiq::Worker\nend\nclass Ghost\n  def method_missing(name); end\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        let instance = whitelist.instance_chain("Order");
        assert!(matches!(
            whitelist.lookup(&instance, "total_with_tax"),
            Found::Method { owner: "Order", .. }
        ));
        assert!(matches!(
            whitelist.lookup(&instance, "price"),
            Found::Method { owner: "Priceable", .. }
        ));
        assert!(matches!(
            whitelist.lookup(&instance, "save"),
            Found::Method { owner: "Base", .. }
        ));
        // An alias answers with the method it names.
        assert!(matches!(
            whitelist.lookup(&instance, "cost"),
            Found::Method { owner: "Priceable", .. }
        ));
        assert_eq!(
            whitelist.lookup(&instance, "total"),
            Found::Accessor {
                owner: "Order",
                on_class: false,
                field: "@total",
                write: false
            }
        );
        assert_eq!(
            whitelist.lookup(&instance, "note="),
            Found::Accessor {
                owner: "Order",
                on_class: false,
                field: "@note",
                write: true
            }
        );
        assert_eq!(whitelist.lookup(&instance, "puts"), Found::Core { owner: "Kernel" });
        assert_eq!(
            whitelist.lookup(&instance, "nope"),
            Found::Missing {
                foreign: vec![],
                dynamic: false
            }
        );
        let on_class = whitelist.singleton_chain("Order");
        assert!(matches!(
            whitelist.lookup(&on_class, "find"),
            Found::Method { owner: "Base", .. }
        ));
        assert_eq!(
            whitelist.lookup(&on_class, "registry="),
            Found::Accessor {
                owner: "Order",
                on_class: true,
                field: "@registry",
                write: true
            }
        );
        assert_eq!(
            whitelist.lookup(&on_class, "attr_accessor"),
            Found::Core { owner: "Module" }
        );
        assert_eq!(whitelist.lookup(&on_class, "new"), Found::Core { owner: "Class" });
        // An instance method does not answer on the class.
        assert_eq!(
            whitelist.lookup(&on_class, "save"),
            Found::Missing {
                foreign: vec![],
                dynamic: false
            }
        );
        // What nothing known answers names the libraries that might.
        let record = whitelist.instance_chain("Record");
        assert_eq!(
            whitelist.lookup(&record, "perform_async"),
            Found::Missing {
                foreign: vec!["Sidekiq::Worker", "ActiveRecord::Base"],
                dynamic: false
            }
        );
        let ghost = whitelist.instance_chain("Ghost");
        assert_eq!(
            whitelist.lookup(&ghost, "anything"),
            Found::Missing {
                foreign: vec![],
                dynamic: true
            }
        );
    }

    #[test]
    fn a_module_function_and_an_extend_self_answer_on_the_module() {
        let files = corpus(&[
            "module Util\n  module_function\n  def slug(text); end\nend\nmodule Tools\n  extend self\n  def run; end\nend\nmodule Plain\n  def hidden; end\nend\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        assert!(matches!(
            whitelist.lookup(&whitelist.singleton_chain("Util"), "slug"),
            Found::Method { owner: "Util", .. }
        ));
        assert!(matches!(
            whitelist.lookup(&whitelist.singleton_chain("Tools"), "run"),
            Found::Method { owner: "Tools", .. }
        ));
        assert!(matches!(
            whitelist.lookup(&whitelist.singleton_chain("Plain"), "hidden"),
            Found::Missing { .. }
        ));
    }

    #[test]
    fn a_corpus_body_of_a_core_class_comes_before_the_vm_in_its_chain() {
        let files = corpus(&["class String\n  def blank?; end\nend\n"]);
        let whitelist = Whitelist::build(&files, core_table::table());
        let chain = whitelist.instance_chain("String");
        assert_eq!(
            steps(&chain),
            vec![
                "String",
                "<ruby>/String",
                "<ruby>/Comparable",
                "<ruby>/Object",
                "<ruby>/Kernel",
                "<ruby>/BasicObject"
            ]
        );
        assert!(matches!(
            whitelist.lookup(&chain, "blank?"),
            Found::Method { owner: "String", .. }
        ));
        assert_eq!(whitelist.lookup(&chain, "upcase"), Found::Core { owner: "String" });
    }

    #[test]
    fn a_struct_and_a_class_new_are_types_with_members_and_ancestry() {
        let files = corpus(&[
            "Point = Struct.new(:x, :y) do\n  def dist; end\nend\nclass Base; end\nHandler = Class.new(Base)\nCoord = Data.define(:lat)\n",
        ]);
        let whitelist = Whitelist::build(&files, core_table::table());
        assert_eq!(
            whitelist.declarations("Point").first().map(|d| d.kind),
            Some(TypeKind::Class)
        );
        let point = whitelist.instance_chain("Point");
        assert_eq!(steps(&point)[..3], ["Point", "<ruby>/Struct", "<ruby>/Enumerable"]);
        assert!(matches!(
            whitelist.lookup(&point, "dist"),
            Found::Method { owner: "Point", .. }
        ));
        assert_eq!(
            whitelist.lookup(&point, "x"),
            Found::Accessor {
                owner: "Point",
                on_class: false,
                field: "@x",
                write: false
            }
        );
        assert_eq!(steps(&whitelist.instance_chain("Handler"))[..2], ["Handler", "Base"]);
        assert_eq!(steps(&whitelist.instance_chain("Coord"))[..2], ["Coord", "<ruby>/Data"]);
        // A type is not also a value constant.
        assert!(whitelist.constant_places("Point").is_empty());
    }
}
