//! Passes 2–4: entities, edges, stubs — the model (PLAN.md §23.9, M22a).
//!
//! Every edge M22a writes is `declared`: an import is written, and a base is a
//! name the scoping rules bind. What the corpus does not declare is a stub
//! below `<builtins>`, a `<stdlib>` module or a `<site>` one, made only
//! because an edge points at it.

use crate::classes::{ClassId, Classes, OwnMember};
use crate::corpus::{Corpus, Decoding};
use crate::declarations::{
    Bound, Chain, FileDecls, FunctionDecl, ParameterDecl, ParameterKind, Reference, ScopeKind, SiteKind, Span,
    Synthetic, Target, ValueDecl, declarations,
};
use crate::ids;
use crate::resolve::{How, ImportTarget, Lookup, ModuleRef, Modules, Resolver, Value};
use crate::stats::Stats;
use crate::stdlib_table::{self, Kind};
use crate::{NAME, RUFF_TAG, VERSION};
use codegraph_model::{Anchor, Edge, Entity, Key, Literal, Model, NamedArgument};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{BuildHasher, RandomState};
use std::sync::Arc;

mod annotations;
mod sites;

const MODULE_TRAITS: &[&str] = &["TNamed", "TModule", "TWithChildren", "TSourceAnchor"];
const STUB_MODULE_TRAITS: &[&str] = &["TNamed", "TModule", "TWithChildren"];
const CLASS_TRAITS: &[&str] = &[
    "TNamed",
    "TType",
    "TWithInheritances",
    "TWithChildren",
    "TChildOf",
    "TSourceAnchor",
];
const STUB_TYPE_TRAITS: &[&str] = &["TNamed", "TType", "TChildOf"];
const INVOCABLE_TRAITS: &[&str] = &[
    "TNamed",
    "TInvocable",
    "TWithChildren",
    "TWithParameters",
    "TWithInvocations",
    "TWithAccesses",
    "TTypedEntity",
    "TChildOf",
    "TSourceAnchor",
];
const PARAMETER_TRAITS: &[&str] = &["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"];
/// A variable's and an attribute's: one composition, kept apart by kind.
const BINDING_TRAITS: &[&str] = &["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"];

pub struct Extraction {
    pub model: Model,
    pub stats: Stats,
}

/// What nothing under the roots declares, collected as edges name it. Each key
/// is made once and handed out shared, so every edge to a stub holds no copy.
#[derive(Default)]
struct Stubs {
    /// Module key text → the key, and its name: a dotted name, `<builtins>`, or a missing file's path.
    modules: BTreeMap<Arc<str>, (Key, String)>,
    /// What each module an import names is, made once.
    by_module: HashMap<ModuleRef, Key>,
    /// Module key text → symbol as written → the type's key.
    types: BTreeMap<Arc<str>, BTreeMap<String, Key>>,
}

impl Stubs {
    fn module(&mut self, module: &ModuleRef, file_keys: &[Key]) -> Key {
        if let ModuleRef::File(file) = module {
            return file_keys[*file].clone();
        }
        if let Some(key) = self.by_module.get(module) {
            return key.clone();
        }
        let (key, name) = match module {
            ModuleRef::File(_) => unreachable!("answered above"),
            ModuleRef::Stdlib(dotted) => (ids::stdlib_key(dotted), dotted.clone()),
            ModuleRef::Site(dotted) => (ids::site_key(dotted), dotted.clone()),
            ModuleRef::Missing(path) => (ids::file_key(path), path.clone()),
            ModuleRef::Namespace(dir) => unreachable!("a namespace package is no module entity: {dir}"),
        };
        let key = self.register(key, name);
        self.by_module.insert(module.clone(), key.clone());
        key
    }

    fn builtins(&mut self) -> Key {
        let key = ids::builtins_key();
        self.register(key, ids::BUILTINS.to_owned())
    }

    /// The one key of a stub module, whichever way it was reached.
    fn register(&mut self, key: Key, name: String) -> Key {
        self.modules
            .entry(key.module.clone())
            .or_insert_with(|| (key, name))
            .0
            .clone()
    }

    fn type_below(&mut self, module: Key, symbol: &str) -> Key {
        let below = self.types.entry(module.module.clone()).or_default();
        if let Some(key) = below.get(symbol) {
            return key.clone();
        }
        let key = ids::stub_type_key(&module, symbol);
        below.insert(symbol.to_owned(), key.clone());
        key
    }

    fn entities(self) -> Vec<Entity> {
        let types: usize = self.types.values().map(BTreeMap::len).sum();
        let mut out = Vec::with_capacity(self.modules.len() + types);
        let mut parents: HashMap<Arc<str>, Key> = HashMap::new();
        for (module, (key, name)) in self.modules {
            parents.insert(module, key.clone());
            let mut entity = Entity::new(key, "module", STUB_MODULE_TRAITS);
            entity.name = Some(name);
            entity.is_stub = Some(true);
            entity.defined_in = Some(Vec::new());
            out.push(entity);
        }
        for (module, below) in self.types {
            let parent = parents.get(&module).cloned().unwrap_or_else(|| Key::module(module));
            for (symbol, key) in below {
                let mut entity = Entity::new(key, "class", STUB_TYPE_TRAITS);
                entity.name = Some(symbol);
                entity.is_stub = Some(true);
                entity.parent = Some(parent.clone());
                out.push(entity);
            }
        }
        out
    }
}

/// A docstring, else the `#` block above: one string, `TComment`.
fn comment(entity: &mut Entity, text: Option<&String>) {
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        entity.comments = Some(vec![text.clone()]);
        entity.traits.push("TComment");
    }
}

/// Measures (METAMODEL §3.8), key-sorted, `TMetrics`.
fn measure(entity: &mut Entity, metrics: Vec<(&'static str, u32)>) {
    entity.metrics = Some(metrics);
    entity.traits.push("TMetrics");
}

/// `name(a, b=…, /, c, *args, d, **kwargs)`: the parameters as Python spells
/// them, a default marked and never written out (its value is the parameter's).
fn signature(function: &FunctionDecl) -> String {
    let parameters: &[ParameterDecl] = &function.parameters;
    let mut parts: Vec<String> = Vec::with_capacity(parameters.len() + 2);
    let mut starred = false;
    for (at, parameter) in parameters.iter().enumerate() {
        let plain = || {
            if parameter.has_default {
                format!("{}=…", parameter.name)
            } else {
                parameter.name.clone()
            }
        };
        match parameter.kind {
            ParameterKind::VarArgs => {
                starred = true;
                parts.push(format!("*{}", parameter.name));
            }
            ParameterKind::KeywordOnly => {
                if !starred {
                    starred = true;
                    parts.push("*".to_owned());
                }
                parts.push(plain());
            }
            ParameterKind::VarKeywords => parts.push(format!("**{}", parameter.name)),
            ParameterKind::PositionalOnly | ParameterKind::Positional => parts.push(plain()),
        }
        let next_positional_only = parameters
            .get(at + 1)
            .is_some_and(|next| next.kind == ParameterKind::PositionalOnly);
        if parameter.kind == ParameterKind::PositionalOnly && !next_positional_only {
            parts.push("/".to_owned());
        }
    }
    format!("{}({})", function.name, parts.join(", "))
}

/// The edges that share a hash: almost always one.
enum Bucket {
    One(u32),
    Many(Vec<u32>),
}

impl Bucket {
    fn indices(&self) -> &[u32] {
        match self {
            Bucket::One(index) => std::slice::from_ref(index),
            Bucket::Many(indices) => indices,
        }
    }

    fn push(&mut self, index: u32) {
        match self {
            Bucket::One(first) => *self = Bucket::Many(vec![*first, index]),
            Bucket::Many(indices) => indices.push(index),
        }
    }
}

/// Where a name is bound: its line, its span, and the assignment when one binds it.
type BindingSite = (u32, Span, Option<usize>);

struct Extractor<'a> {
    corpus: &'a Corpus,
    files: &'a [FileDecls],
    resolver: &'a Resolver<'a>,
    classes: &'a Classes,
    /// (file, class, name) → its attribute's key: the root-most corpus class's that has the name.
    attribute_keys: HashMap<(usize, usize, String), Key>,
    /// (file, name) → a module variable's key.
    variable_keys: HashMap<(usize, String), Key>,
    /// Written onto their entities once every key exists.
    values: HashMap<Key, Literal>,
    declared_types: HashMap<Key, Key>,
    /// Attribute key → every assignment that writes it, `(file, assignment)`, for its type.
    attribute_assignments: HashMap<Key, Vec<(usize, usize)>>,
    /// `(module, symbol)` of the library names a site gives a class's standing.
    evidence: HashSet<(ModuleRef, String)>,
    /// Assignments being typed: a binding that names itself is no type.
    typing: HashSet<(usize, usize)>,
    /// Entities that are the source of an invocation / of an access.
    invokes: HashSet<Key>,
    accesses: HashSet<Key>,
    file_keys: Vec<Key>,
    /// Each file's path, shared by every anchor in it.
    paths: Vec<Arc<str>>,
    /// Per file, per scope: the entity whose body it is; `None` where the declaration was dropped.
    scope_keys: Vec<Vec<Option<Key>>>,
    /// Every key an entity holds → its kind, so a second declaration of one key merges or is dropped.
    kinds: HashMap<Key, &'static str>,
    stubs: Stubs,
    stats: Stats,
    entities: Vec<Entity>,
    edges: Vec<Edge>,
    /// Every edge written, by its hash: indices into `edges`, so a repeat is found without a copy.
    edge_index: HashMap<u64, Bucket>,
    edge_hasher: RandomState,
}

impl Extractor<'_> {
    fn anchor(&self, file: usize, span: Span) -> Anchor {
        Anchor {
            file: self.paths[file].clone(),
            start: span.0,
            end: span.1,
        }
    }

    /// Writes the edge unless it repeats one or points at its own source; `true` when written.
    fn edge(&mut self, kind: &'static str, from: &Key, to: Key, provenance: &'static str, anchor: Anchor) -> bool {
        self.edge_with(kind, from, to, provenance, anchor, None, None)
    }

    /// `edge`, with an access's direction and an annotation use's arguments.
    #[allow(clippy::too_many_arguments)]
    fn edge_with(
        &mut self,
        kind: &'static str,
        from: &Key,
        to: Key,
        provenance: &'static str,
        anchor: Anchor,
        access: Option<(bool, bool)>,
        arguments: Option<Vec<NamedArgument>>,
    ) -> bool {
        if *from == to {
            self.stats.self_edges += 1;
            return false;
        }
        let edge = Edge {
            kind,
            from: from.clone(),
            to,
            provenance,
            anchor,
            access,
            candidates: None,
            arguments: arguments.filter(|arguments| !arguments.is_empty()),
        };
        let hash = self.edge_hasher.hash_one(&edge);
        let index = self.edges.len() as u32;
        let edges = &self.edges;
        match self.edge_index.get_mut(&hash) {
            Some(bucket) if bucket.indices().iter().any(|at| edges[*at as usize] == edge) => return false,
            Some(bucket) => bucket.push(index),
            None => {
                self.edge_index.insert(hash, Bucket::One(index));
            }
        }
        self.edges.push(edge);
        true
    }

    // ------------------------------------------------------------ entities ----

    fn modules(&mut self) {
        for (index, file) in self.corpus.files.iter().enumerate() {
            let mut entity = Entity::new(self.file_keys[index].clone(), "module", MODULE_TRAITS);
            entity.name = Some(file.rel.clone());
            entity.is_stub = Some(false);
            entity.defined_in = Some(vec![file.rel.clone()]);
            entity.anchor = Some(Anchor {
                file: self.paths[index].clone(),
                start: 1,
                end: file.lines,
            });
            let decls = &self.files[index];
            comment(&mut entity, decls.docstring.as_ref());
            measure(&mut entity, vec![("sloc", decls.sloc((1, file.lines)))]);
            self.entities.push(entity);
        }
    }

    /// Classes, functions, methods and parameters, in the order the source
    /// writes them: a body's scope follows its header, so a parent is keyed first.
    fn declarations(&mut self) {
        for file in 0..self.files.len() {
            let files = self.files;
            let decls = &files[file];
            let mut keys: Vec<Option<Key>> = vec![None; decls.scopes.len()];
            keys[0] = Some(self.file_keys[file].clone());
            for scope in 1..decls.scopes.len() {
                let parent_scope = decls.scopes[scope].parent.unwrap_or(0);
                // Below a dropped declaration nothing has a key either.
                let Some(parent) = keys[parent_scope].clone() else {
                    continue;
                };
                let in_class = matches!(decls.scopes[parent_scope].kind, ScopeKind::Class(_));
                let (key, kind, name, span) = match decls.scopes[scope].kind {
                    ScopeKind::Class(class) => {
                        let class = &decls.classes[class];
                        (ids::member_key(&parent, &class.name), "class", &class.name, class.span)
                    }
                    ScopeKind::Function(function) => {
                        let function = &decls.functions[function];
                        let mut key = ids::member_key(&parent, &function.name);
                        if let Some(word) = function.accessor {
                            key = ids::accessor_key(&key, word);
                        }
                        let kind = if in_class { "method" } else { "function" };
                        (key, kind, &function.name, function.span)
                    }
                    ScopeKind::Module | ScopeKind::Lambda | ScopeKind::Comprehension => continue,
                };
                match self.kinds.get(&key) {
                    // Written twice under one name (a platform `if`, a redefinition): the first.
                    Some(existing) if *existing == kind => keys[scope] = Some(key),
                    Some(existing) => {
                        let what = format!("{name} (a {existing} holds the key)");
                        self.stats.drop(file, span.0, "redefinition-of-another-kind", what);
                    }
                    None => {
                        self.kinds.insert(key.clone(), kind);
                        let mut entity = match decls.scopes[scope].kind {
                            ScopeKind::Function(function) => {
                                let function = &decls.functions[function];
                                let mut entity = self.invocable(file, function, &key, kind);
                                comment(
                                    &mut entity,
                                    function.docstring.as_ref().or(decls.comment_above(function.head)),
                                );
                                let sloc = decls.sloc(function.span);
                                measure(&mut entity, vec![("cyclomatic", function.cyclomatic), ("sloc", sloc)]);
                                entity
                            }
                            ScopeKind::Class(class) => {
                                let class = &decls.classes[class];
                                let mut entity = Entity::new(key.clone(), kind, CLASS_TRAITS);
                                entity.is_stub = Some(false);
                                comment(
                                    &mut entity,
                                    class.docstring.as_ref().or(decls.comment_above(class.head)),
                                );
                                measure(&mut entity, vec![("sloc", decls.sloc(class.span))]);
                                entity
                            }
                            _ => unreachable!("only a class or a function scope is keyed"),
                        };
                        entity.name = Some(name.clone());
                        entity.parent = Some(parent);
                        entity.anchor = Some(self.anchor(file, span));
                        self.entities.push(entity);
                        keys[scope] = Some(key);
                    }
                }
            }
            self.scope_keys.push(keys);
        }
    }

    /// A function or method, and its parameters as entities of their own.
    fn invocable(&mut self, file: usize, function: &FunctionDecl, key: &Key, kind: &'static str) -> Entity {
        let mut entity = Entity::new(key.clone(), kind, INVOCABLE_TRAITS);
        entity.signature = Some(signature(function));
        let mut parameters = Vec::with_capacity(function.parameters.len());
        for parameter in &function.parameters {
            let parameter_key = ids::parameter_key(key, &parameter.name);
            let mut child = Entity::new(parameter_key.clone(), "parameter", PARAMETER_TRAITS);
            child.name = Some(parameter.name.clone());
            child.parent = Some(key.clone());
            child.anchor = Some(self.anchor(file, parameter.span));
            self.entities.push(child);
            parameters.push(parameter_key);
        }
        entity.parameters = Some(parameters);
        entity
    }

    /// Module variables, class attributes and parameter values — once every declaration has its key.
    fn bindings(&mut self) {
        for file in 0..self.files.len() {
            self.variables(file);
            for class in 0..self.files[file].classes.len() {
                self.attributes(file, class);
            }
            self.parameter_values(file);
        }
    }

    /// Every module-level binding but a `def`, a `class` and an import — which hold the name —
    /// and every `global` write from a function: one variable per name, at the first.
    fn variables(&mut self, file: usize) {
        let files = self.files;
        let decls = &files[file];
        // Each binding by name, in first-seen order.
        let mut order: Vec<&str> = Vec::new();
        let mut written: HashMap<&str, Vec<BindingSite>> = HashMap::new();
        let mut held: HashMap<&str, &'static str> = HashMap::new();
        for binding in &decls.scopes[0].bindings {
            let name = binding.name.as_str();
            let site = match binding.bound {
                Bound::Function(_) => {
                    held.entry(name).or_insert("a function holds the key");
                    continue;
                }
                Bound::Class(_) => {
                    held.entry(name).or_insert("a class holds the key");
                    continue;
                }
                Bound::Import { .. } => {
                    held.entry(name).or_insert("an import binds it");
                    continue;
                }
                Bound::Assigned(index) => (binding.line, decls.assignments[index].span, Some(index)),
                Bound::Value | Bound::Parameter { .. } => (binding.line, (binding.line, binding.line), None),
            };
            if !written.contains_key(name) {
                order.push(name);
            }
            written.entry(name).or_default().push(site);
        }
        for (index, assignment) in decls.assignments.iter().enumerate() {
            if let Target::Name(name) = &assignment.target
                && assignment.scope != 0
                && decls.scopes[assignment.scope]
                    .globals
                    .iter()
                    .any(|global| global == name)
            {
                if !written.contains_key(name.as_str()) {
                    order.push(name);
                }
                written
                    .entry(name)
                    .or_default()
                    .push((assignment.span.0, assignment.span, Some(index)));
            }
        }
        for name in order {
            let mut sites = written.remove(name).unwrap_or_default();
            sites.sort_by_key(|site| site.0);
            let Some(&(line, span, assignment)) = sites.first() else {
                continue;
            };
            if let Some(why) = held.get(name) {
                self.stats
                    .drop(file, line, "rebinding-of-a-declaration", format!("{name} ({why})"));
                continue;
            }
            let parent = self.file_keys[file].clone();
            let key = ids::member_key(&parent, name);
            if self.kinds.contains_key(&key) {
                continue;
            }
            self.kinds.insert(key.clone(), "variable");
            self.variable_keys.insert((file, name.to_owned()), key.clone());
            let entity = self.binding_entity(file, key, "variable", name, parent, line, span, assignment);
            self.entities.push(entity);
        }
    }

    /// One attribute per class and name, owned by the root-most corpus class of the order that has
    /// the name; where a `def` or a nested `class` holds the name, the binding is counted.
    fn attributes(&mut self, file: usize, class: usize) {
        let classes = self.classes;
        let files = self.files;
        let Some(class_key) = self.scope_keys[file][files[file].classes[class].body].clone() else {
            return;
        };
        for (name, sites) in classes.attributes(file, class) {
            let held = |file: usize, class: usize| match classes.member(file, class, name) {
                Some(OwnMember::Function(_)) => Some("a method holds the key"),
                Some(OwnMember::Class(_)) => Some("a class holds the key"),
                _ => None,
            };
            // `self.size = …` through a property of the order is a write through its setter, no binding.
            if let crate::classes::Found::Corpus {
                file: owner,
                member: OwnMember::Function(function),
                ..
            } = classes.find(classes.mro(file, class), false, name, false)
                && files[owner].functions[function].property
            {
                continue;
            }
            let owner = classes
                .mro(file, class)
                .iter()
                .rev()
                .find_map(|id| match id {
                    ClassId::Corpus { file, class } if classes.member(*file, *class, name).is_some() => {
                        Some((*file, *class))
                    }
                    _ => None,
                })
                .unwrap_or((file, class));
            if let Some(why) = held(file, class).or_else(|| held(owner.0, owner.1)) {
                let what = format!("{}.{name} ({why})", class_key.symbol);
                self.stats.drop(file, sites.line, "rebinding-of-a-declaration", what);
                continue;
            }
            let Some(owner_key) = self.scope_keys[owner.0][files[owner.0].classes[owner.1].body].clone() else {
                continue;
            };
            let key = ids::member_key(&owner_key, name);
            self.attribute_keys.insert((file, class, name.clone()), key.clone());
            self.attribute_assignments
                .entry(key.clone())
                .or_default()
                .extend(sites.assignments.iter().map(|assignment| (file, *assignment)));
            if self.kinds.contains_key(&key) {
                continue;
            }
            self.kinds.insert(key.clone(), "attribute");
            let first = &classes.attributes(owner.0, owner.1)[name];
            let assignment = first
                .assignments
                .first()
                .copied()
                .filter(|index| files[owner.0].assignments[*index].span.0 == first.line);
            let span = assignment.map_or((first.line, first.line), |index| files[owner.0].assignments[index].span);
            let entity = self.binding_entity(owner.0, key, "attribute", name, owner_key, first.line, span, assignment);
            self.entities.push(entity);
        }
    }

    /// A variable or an attribute: anchored at its first binding, with the `#` block above it and that binding's value.
    #[allow(clippy::too_many_arguments)]
    fn binding_entity(
        &mut self,
        file: usize,
        key: Key,
        kind: &'static str,
        name: &str,
        parent: Key,
        line: u32,
        span: Span,
        assignment: Option<usize>,
    ) -> Entity {
        let decls = &self.files[file];
        let mut entity = Entity::new(key.clone(), kind, BINDING_TRAITS);
        entity.name = Some(name.to_owned());
        entity.parent = Some(parent);
        entity.anchor = Some(self.anchor(file, span));
        comment(&mut entity, decls.comment_above(line));
        if let Some(index) = assignment {
            let assignment = &decls.assignments[index];
            if let Some(value) = &assignment.value
                && let Some(literal) = self.literal(file, assignment.scope, value)
            {
                self.values.insert(key, literal);
            }
        }
        entity
    }

    /// A parameter's literal default, read where its `def` is written.
    fn parameter_values(&mut self, file: usize) {
        let files = self.files;
        for function in &files[file].functions {
            let Some(invocable) = self.scope_keys[file][function.body].clone() else {
                continue;
            };
            for parameter in &function.parameters {
                if let Some(default) = &parameter.default
                    && let Some(literal) = self.literal(file, function.scope, default)
                {
                    self.values
                        .insert(ids::parameter_key(&invocable, &parameter.name), literal);
                }
            }
        }
    }

    /// A written value in core's tags (METAMODEL §1.6); code has none.
    fn literal(&mut self, file: usize, scope: usize, value: &ValueDecl) -> Option<Literal> {
        // A literal's source is never empty (core refuses it).
        if let ValueDecl::Pairs(_, text) | ValueDecl::Unevaluated(text) | ValueDecl::Name(_, text) = value
            && text.is_empty()
        {
            return None;
        }
        Some(match value {
            ValueDecl::Str(text) => Literal::String(text.clone()),
            ValueDecl::Number(text) => Literal::Number(text.clone()),
            ValueDecl::Bool(flag) => Literal::Boolean(*flag),
            ValueDecl::None => Literal::Null,
            ValueDecl::Array(items) => Literal::Array(
                items
                    .iter()
                    .map(|item| self.literal(file, scope, item))
                    .collect::<Option<Vec<_>>>()?,
            ),
            ValueDecl::Pairs(_, text) | ValueDecl::Unevaluated(text) => Literal::Unevaluated(text.clone()),
            ValueDecl::Code(_) => return None,
            ValueDecl::Name(chain, text) => {
                let unevaluated = Literal::Unevaluated(text.clone());
                let Some(names) = chain.dotted() else {
                    return Some(unevaluated);
                };
                let value = self.resolver.reference(file, scope, &names).value;
                if let Some(key) = self.class_literal(&value) {
                    return Some(Literal::Type(key));
                }
                // `Kind.FAST`: a member of a corpus class with an enumeration among its ancestors.
                if let Some((member, owner)) = names.split_last()
                    && !owner.is_empty()
                    && let Value::Class { file, class } = self.resolver.reference(file, scope, owner).value
                    && self.classes.is_enum(file, class)
                    && self.classes.member(file, class, member) == Some(OwnMember::Attribute)
                    && let Some(ty) = self.scope_keys[file][self.files[file].classes[class].body].clone()
                {
                    return Some(Literal::Enum {
                        ty,
                        name: member.clone(),
                    });
                }
                // A constant: a module's or a class body's binding, a library's value. A parameter,
                // a local, a function is code.
                let constant = match value {
                    Value::Assigned { file, assignment } => {
                        let scope = self.files[file].assignments[assignment].scope;
                        matches!(
                            self.files[file].scopes[scope].kind,
                            ScopeKind::Module | ScopeKind::Class(_)
                        )
                    }
                    Value::External { kind, .. } => !matches!(kind, Some(Kind::Function | Kind::Module(_))),
                    Value::Builtin { .. } => true,
                    _ => false,
                };
                return constant.then_some(unevaluated);
            }
        })
    }

    /// The key a value naming a class is a type literal of: a corpus class, or a standard one the table declares.
    fn class_literal(&mut self, value: &Value) -> Option<Key> {
        match value {
            Value::Class { file, class } => self.scope_keys[*file][self.files[*file].classes[*class].body].clone(),
            Value::External {
                module: module @ ModuleRef::Stdlib(_),
                symbol,
                kind: Some(Kind::Class),
            } => {
                let module = self.stubs.module(module, &self.file_keys);
                Some(self.stubs.type_below(module, &symbol.join(".")))
            }
            _ => None,
        }
    }

    // --------------------------------------------------------------- edges ----

    fn count_import(&mut self, how: How, type_checking: bool) {
        let counts = &mut self.stats.imports;
        match how {
            How::Relative => counts.relative += 1,
            How::PackageRoot => counts.package_root += 1,
            How::NamespacePackage => counts.namespace += 1,
            How::ImplicitRelative => counts.implicit_relative += 1,
            How::Stdlib => counts.stdlib += 1,
            How::Site => counts.site += 1,
            How::Missing => counts.missing += 1,
        }
        if type_checking {
            counts.type_checking += 1;
        }
    }

    /// `importlib.import_module("a.b")` and `__import__("a.b")` with a literal: an `import`, as
    /// the statement would be; a computed name is counted `computed-import`.
    fn dynamic_imports(&mut self) {
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            for site in &decls.sites {
                let (SiteKind::Load, Chain::Call(callee)) = (&site.kind, &site.chain) else {
                    continue;
                };
                let Some(names) = callee.dotted() else {
                    continue;
                };
                let importer = match self.resolver.reference(file, site.scope, &names).value {
                    Value::External {
                        module: ModuleRef::Stdlib(module),
                        symbol,
                        ..
                    } => module == "importlib" && symbol == ["import_module"],
                    Value::Builtin { name, .. } => name == "__import__",
                    _ => false,
                };
                if !importer {
                    continue;
                }
                let dotted = match &site.literal {
                    Some(dotted) if !dotted.starts_with('.') && !dotted.is_empty() => dotted.clone(),
                    _ => {
                        self.stats.drop(file, site.span.0, "computed-import", site.text.clone());
                        continue;
                    }
                };
                match self.resolver.modules.absolute(file, &dotted) {
                    Lookup::Found {
                        module: ModuleRef::Namespace(_),
                        ..
                    } => self.stats.drop(file, site.span.0, "namespace-import", dotted),
                    Lookup::Found { module, how, .. } => {
                        let to = self.stubs.module(&module, &self.file_keys);
                        let from = self.file_keys[file].clone();
                        let anchor = self.anchor(file, site.span);
                        if self.edge("import", &from, to, "declared", anchor) {
                            self.count_import(how, false);
                        }
                    }
                    Lookup::Ambiguous(roots) => {
                        let what = format!("{dotted} ({})", roots.join(" or "));
                        self.stats.drop(file, site.span.0, "ambiguous-root", what);
                    }
                    Lookup::BeyondRoot => self.stats.drop(file, site.span.0, "relative-beyond-root", dotted),
                }
            }
        }
    }

    /// One `import` edge per module an alias names, from the file wherever it is written.
    fn imports(&mut self) {
        let resolver = self.resolver;
        for file in 0..self.files.len() {
            let files = self.files;
            for (index, import) in files[file].imports.iter().enumerate() {
                let aliases = match &import.kind {
                    crate::declarations::ImportKind::Modules(list) => list.len(),
                    crate::declarations::ImportKind::From { names, .. } => names.len(),
                };
                for alias in 0..aliases {
                    match &resolver.alias(file, index, alias).target {
                        ImportTarget::Dropped { reason, what } => {
                            self.stats.drop(file, import.span.0, reason, what.clone())
                        }
                        ImportTarget::Edge { to, how } => {
                            let to = self.stubs.module(to, &self.file_keys);
                            let from = self.file_keys[file].clone();
                            let anchor = self.anchor(file, import.span);
                            if self.edge("import", &from, to, "declared", anchor) {
                                self.count_import(*how, import.type_checking);
                            }
                        }
                    }
                }
            }
        }
    }

    /// A class a standard form makes inherits what the interpreter gives it: `generated`,
    /// since no line writes that base.
    fn synthetic_base(&mut self, file: usize, scope: usize, synthetic: &Synthetic, from: &Key, span: Span, what: &str) {
        match crate::classes::synthetic_base(file, scope, synthetic, self.resolver) {
            Some(id) => {
                let (to, landed) = self.fold_key(&sites::Fold::Class(id));
                let anchor = self.anchor(file, span);
                self.edge("inheritance", from, to, "generated", anchor);
                self.landed(landed);
            }
            None => {
                let callee = synthetic
                    .callee
                    .dotted()
                    .map(|names| names.join("."))
                    .unwrap_or_default();
                let what = format!("{what} ({callee} is not the standard library's)");
                self.stats.drop(file, span.0, "computed-base", what);
            }
        }
    }

    /// One `inheritance` edge per base, anchored at the base.
    fn bases(&mut self) {
        let resolver = self.resolver;
        for file in 0..self.files.len() {
            let files = self.files;
            for (index, class) in files[file].classes.iter().enumerate() {
                let Some(from) = self.scope_keys[file][class.body].clone() else {
                    continue;
                };
                if let Some(synthetic) = &class.synthetic {
                    self.synthetic_base(file, class.scope, synthetic, &from, class.span, &class.name);
                }
                for base in &class.bases {
                    let line = base.span.0;
                    if let Reference::Synthetic(synthetic) = &base.reference {
                        self.synthetic_base(file, class.scope, synthetic, &from, base.span, &base.text);
                        continue;
                    }
                    let Reference::Dotted(names) = &base.reference else {
                        self.stats.drop(file, line, "computed-base", base.text.clone());
                        continue;
                    };
                    let resolved = resolver.base(file, index, names);
                    if resolved.rebound {
                        self.stats.rebound += 1;
                    }
                    // A name bound once to a class: that class, by flow.
                    let mut value = resolved.value;
                    let mut alias = false;
                    if let Value::Assigned { .. } = value
                        && let Some(target) = crate::classes::through_aliases(files, resolver, value.clone())
                        && crate::classes::class_of(&target).is_some()
                    {
                        value = target;
                        alias = true;
                    }
                    let to = match value {
                        Value::Class { file: declared, class } => {
                            let body = self.files[declared].classes[class].body;
                            match self.scope_keys[declared][body].clone() {
                                Some(key) => {
                                    self.stats.resolved_corpus += 1;
                                    key
                                }
                                None => {
                                    self.stats.drop(file, line, "unbound-name", base.text.clone());
                                    continue;
                                }
                            }
                        }
                        Value::Builtin {
                            name,
                            kind: Kind::Class,
                        } => {
                            self.stats.resolved_builtins += 1;
                            let module = self.stubs.builtins();
                            self.stubs.type_below(module, &name)
                        }
                        Value::External {
                            kind: Some(Kind::Function),
                            ..
                        }
                        | Value::Module(_)
                        | Value::Function { .. }
                        | Value::Builtin { .. } => {
                            self.stats.drop(file, line, "not-a-class", base.text.clone());
                            continue;
                        }
                        // A name inherited from is a class: the site is the evidence.
                        Value::External { module, symbol, .. } => {
                            match module {
                                ModuleRef::Stdlib(_) => self.stats.resolved_stdlib += 1,
                                ModuleRef::Site(_) => self.stats.resolved_site += 1,
                                _ => self.stats.resolved_missing += 1,
                            }
                            let module = self.stubs.module(&module, &self.file_keys);
                            self.stubs.type_below(module, &symbol.join("."))
                        }
                        Value::AmbiguousStar(modules) => {
                            let what = format!("{} ({})", base.text, modules.join(" or "));
                            self.stats.drop(file, line, "ambiguous-star", what);
                            continue;
                        }
                        Value::Opaque | Value::Assigned { .. } | Value::Parameter { .. } => {
                            let what = format!("{} (bound to a value)", base.text);
                            self.stats.drop(file, line, "computed-base", what);
                            continue;
                        }
                        Value::Unbound { cycle } => {
                            let what = if cycle {
                                format!("{} (an import cycle)", base.text)
                            } else {
                                base.text.clone()
                            };
                            self.stats.drop(file, line, "unbound-name", what);
                            continue;
                        }
                    };
                    let anchor = self.anchor(file, base.span);
                    // A name only a star import of an unknown module binds is attributed to it.
                    let inferred = if alias {
                        Some("alias-base")
                    } else {
                        resolved.star_attributed.then_some("star-attributed")
                    };
                    let provenance = if inferred.is_some() { "derived" } else { "declared" };
                    if self.edge("inheritance", &from, to, provenance, anchor) {
                        self.count_inference(inferred);
                    }
                }
            }
        }
    }
}

/// Runs every pass over a loaded corpus. `phase` is told each pass's name and detail.
pub fn extract(
    corpus: &Corpus,
    repository: Option<Vec<(&'static str, String)>>,
    phase: &mut dyn FnMut(&str, String),
) -> Extraction {
    let files: Vec<FileDecls> = corpus
        .files
        .iter()
        .map(|file| declarations(&file.text, &file.line_starts))
        .collect();
    let mut stats = Stats {
        files: files.len(),
        ..Stats::default()
    };
    for (index, (file, decls)) in corpus.files.iter().zip(&files).enumerate() {
        if decls.errors > 0 {
            stats.with_errors.push((file.rel.clone(), decls.errors));
        }
        match &file.decoding {
            Decoding::Declared { encoding, non_ascii } => stats.decoded.push((file.rel.clone(), encoding, *non_ascii)),
            Decoding::Lossy { encoding, replaced } => stats.lossy.push((file.rel.clone(), encoding.clone(), *replaced)),
            Decoding::Utf8 | Decoding::Bom => {}
        }
        for drop in &decls.drops {
            stats.drop(index, drop.line, drop.reason, drop.what.clone());
        }
    }
    phase(
        "parse",
        format!("{} files, {} with syntax errors", files.len(), stats.with_errors.len()),
    );

    let modules = Modules::new(corpus);
    let resolver = Resolver::new(&modules, &files);
    phase("imports", format!("{} files resolved", files.len()));
    let classes = Classes::new(&files, &resolver);

    let mut extractor = Extractor {
        corpus,
        files: &files,
        resolver: &resolver,
        classes: &classes,
        attribute_keys: HashMap::new(),
        variable_keys: HashMap::new(),
        values: HashMap::new(),
        declared_types: HashMap::new(),
        attribute_assignments: HashMap::new(),
        evidence: HashSet::new(),
        typing: HashSet::new(),
        invokes: HashSet::new(),
        accesses: HashSet::new(),
        file_keys: corpus.files.iter().map(|file| ids::file_key(&file.rel)).collect(),
        paths: corpus.files.iter().map(|file| Arc::from(file.rel.as_str())).collect(),
        scope_keys: Vec::with_capacity(files.len()),
        kinds: HashMap::new(),
        stubs: Stubs::default(),
        stats,
        entities: Vec::new(),
        edges: Vec::new(),
        edge_index: HashMap::new(),
        edge_hasher: RandomState::new(),
    };
    extractor.modules();
    extractor.declarations();
    extractor.bindings();
    phase("entities", format!("{} entities", extractor.entities.len()));
    extractor.imports();
    extractor.dynamic_imports();
    extractor.bases();
    extractor.evidence();
    extractor.sites();
    extractor.annotations();
    phase("edges", format!("{} edges", extractor.edges.len()));

    let Extractor {
        stubs,
        mut stats,
        mut entities,
        edges,
        mut values,
        mut declared_types,
        invokes,
        accesses,
        ..
    } = extractor;
    // A module or a class whose own code calls or reads says so (an invocable always may).
    for entity in &mut entities {
        if matches!(entity.kind, "module" | "class") && entity.is_stub != Some(true) {
            if invokes.contains(&entity.key) {
                entity.traits.push("TWithInvocations");
            }
            if accesses.contains(&entity.key) {
                entity.traits.push("TWithAccesses");
            }
        }
    }
    for entity in &mut entities {
        entity.declared_type = declared_types.remove(&entity.key).map(Box::new);
        if let Some(value) = values.remove(&entity.key) {
            entity.value = Some(Box::new(value));
            entity.traits.push("TWithValue");
        }
    }
    stats.dotted_site_classes = stubs
        .types
        .iter()
        .filter(|(module, _)| module.starts_with("<site>"))
        .flat_map(|(_, below)| below.keys())
        .filter(|symbol| symbol.contains('.'))
        .count();
    let stub_entities = stubs.entities();
    stats.stubs = stub_entities.len();
    phase("stubs", format!("{} stubs", stub_entities.len()));
    entities.extend(stub_entities);
    stats.entities = entities.len();
    stats.edges = edges.len();

    let model = Model {
        lang: ids::LANG,
        extractor: vec![
            ("name", NAME.to_owned()),
            ("version", VERSION.to_owned()),
            ("ruff", RUFF_TAG.to_owned()),
            ("typeshed", stdlib_table::table().commit().to_owned()),
        ],
        root: corpus.root_display.clone(),
        repository,
        entities,
        edges,
    };
    Extraction { model, stats }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::{self, SourceFile};

    pub(super) fn extract_sources(files: &[(&str, &str)]) -> Extraction {
        let files = files
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
        let corpus = Corpus {
            root_display: ".".into(),
            root_name: None,
            files,
            import_roots: Vec::new(),
        };
        extract(&corpus, None, &mut |_, _| {})
    }

    pub(super) fn rendered(extraction: &Extraction) -> Vec<(String, &'static str)> {
        let mut out: Vec<(String, &'static str)> = extraction
            .model
            .entities
            .iter()
            .map(|entity| (entity.key.render(ids::LANG), entity.kind))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_name_written_twice_is_one_entity_and_another_kind_cannot_take_its_key() {
        let extraction = extract_sources(&[(
            "m.py",
            "def f(a):\n    pass\ndef f(b, c):\n    def inner(): pass\nclass F: pass\ndef F(): pass\n",
        )]);
        assert_eq!(
            rendered(&extraction),
            vec![
                ("python:m.py".to_owned(), "module"),
                ("python:m.py/F".to_owned(), "class"),
                ("python:m.py/f".to_owned(), "function"),
                ("python:m.py/f#param:a".to_owned(), "parameter"),
                // The second body's own declarations are written: they belong to the one entity.
                ("python:m.py/f.inner".to_owned(), "function"),
            ]
        );
        let f = extraction
            .model
            .entities
            .iter()
            .find(|e| e.key.render(ids::LANG) == "python:m.py/f")
            .unwrap();
        assert_eq!(f.signature.as_deref(), Some("f(a)"));
        assert_eq!(f.anchor.as_ref().map(|a| (a.start, a.end)), Some((1, 2)));
        let drops: Vec<(&str, u32, &str)> = extraction
            .stats
            .drops
            .iter()
            .map(|d| (d.reason, d.line, d.what.as_str()))
            .collect();
        assert_eq!(
            drops,
            vec![("redefinition-of-another-kind", 6, "F (a class holds the key)")]
        );
    }

    pub(super) fn entity<'a>(extraction: &'a Extraction, rendered: &str) -> &'a Entity {
        extraction
            .model
            .entities
            .iter()
            .find(|e| e.key.render(ids::LANG) == rendered)
            .unwrap_or_else(|| panic!("no entity {rendered}"))
    }

    #[test]
    fn a_docstring_else_the_comment_block_above_and_the_measures_each_kind_carries() {
        let extraction = extract_sources(&[(
            "m.py",
            "\"\"\"The module.\"\"\"\n# Helpers.\n# Two lines.\ndef f(x):\n    \"\"\"Doc of f.\"\"\"\n    if x and x > 1:  # trailing\n        return 1\n    return 2\n\n\
             # A class.\n@decorated\nclass C:\n    # The method.\n    def m(self, xs):\n        return [y for y in xs if y] or (lambda: 1 if xs else 2)\n",
        )]);
        let comments = |rendered: &str| entity(&extraction, rendered).comments.clone();
        let metrics = |rendered: &str| entity(&extraction, rendered).metrics.clone();
        assert_eq!(comments("python:m.py"), Some(vec!["The module.".to_owned()]));
        assert_eq!(comments("python:m.py/f"), Some(vec!["Doc of f.".to_owned()]));
        // Above the decorators: the declaration starts with them.
        assert_eq!(comments("python:m.py/C"), Some(vec!["A class.".to_owned()]));
        assert_eq!(comments("python:m.py/C.m"), Some(vec!["The method.".to_owned()]));
        assert_eq!(metrics("python:m.py"), Some(vec![("sloc", 10)]));
        // The span, so the anchor: from the name's line — the decorator is outside it.
        assert_eq!(metrics("python:m.py/C"), Some(vec![("sloc", 3)]));
        // `if` + `and`; then a comprehension's loop and its `if`, `or`, and the lambda's ternary — a
        // lambda is no invocable, so its branches are its writer's.
        assert_eq!(metrics("python:m.py/f"), Some(vec![("cyclomatic", 3), ("sloc", 5)]));
        assert_eq!(metrics("python:m.py/C.m"), Some(vec![("cyclomatic", 5), ("sloc", 2)]));
        for rendered in ["python:m.py", "python:m.py/f", "python:m.py/C", "python:m.py/C.m"] {
            let traits = &entity(&extraction, rendered).traits;
            assert!(
                traits.contains(&"TComment") && traits.contains(&"TMetrics"),
                "{rendered}: {traits:?}"
            );
        }
        assert!(
            !entity(&extraction, "python:m.py/f#param:x")
                .traits
                .contains(&"TMetrics")
        );
    }

    const BINDINGS: &str = "from enum import Enum\nimport json\nDEBUG = False\n# The limit.\nLIMIT = 3\nLIMIT = 4\n\
        try:\n    from fast import speed\nexcept ImportError:\n    speed = None\n\
        def helper(): pass\nhelper = None\ndef setup():\n    global registry\n    registry = {}\n\
        class Kind(Enum):\n    FAST = 1\n    SLOW = 2\n\
        class Base:\n    rate = 0.5\n    def __init__(self, kind=Kind.FAST, label=\"x\", n=-1):\n        self.lines = []\n        self.total = 0\n        self.label = label\n    def total(self): pass\n\
        class Child(Base):\n    def __init__(self):\n        self.lines = [1]\n        self.extra = None\n\
        DEFAULT = Kind.SLOW\nCLASS = Base\nCALLED = helper()\nALIAS = LIMIT\nimport logging\nLEVEL = logging.DEBUG\n";

    #[test]
    fn a_module_binding_is_a_variable_and_a_class_binding_an_attribute_unless_a_declaration_holds_the_key() {
        let extraction = extract_sources(&[("m.py", BINDINGS)]);
        let of_kind = |kind: &str| -> Vec<String> {
            let mut out: Vec<String> = rendered(&extraction)
                .into_iter()
                .filter(|(_, k)| *k == kind)
                .map(|(key, _)| key)
                .collect();
            out.sort();
            out
        };
        assert_eq!(
            of_kind("variable"),
            [
                "ALIAS", "CALLED", "CLASS", "DEBUG", "DEFAULT", "LEVEL", "LIMIT", "registry"
            ]
            .map(|name| format!("python:m.py/{name}"))
        );
        // One attribute per class and name, owned by the root-most corpus class that has it.
        assert_eq!(
            of_kind("attribute"),
            [
                "Base.label",
                "Base.lines",
                "Base.rate",
                "Child.extra",
                "Kind.FAST",
                "Kind.SLOW"
            ]
            .map(|name| format!("python:m.py/{name}"))
        );
        let drops: Vec<(&str, u32, &str)> = extraction
            .stats
            .drops
            .iter()
            .map(|d| (d.reason, d.line, d.what.as_str()))
            .collect();
        assert_eq!(
            drops,
            vec![
                ("rebinding-of-a-declaration", 10, "speed (an import binds it)"),
                ("rebinding-of-a-declaration", 12, "helper (a function holds the key)"),
                ("rebinding-of-a-declaration", 23, "Base.total (a method holds the key)"),
            ]
        );
        let limit = entity(&extraction, "python:m.py/LIMIT");
        assert_eq!(limit.anchor.as_ref().map(|a| (a.start, a.end)), Some((5, 5)));
        assert_eq!(limit.comments, Some(vec!["The limit.".to_owned()]));
        assert_eq!(
            limit.parent.as_ref().map(|p| p.render(ids::LANG)),
            Some("python:m.py".to_owned())
        );
        let lines = entity(&extraction, "python:m.py/Base.lines");
        assert_eq!(lines.anchor.as_ref().map(|a| a.start), Some(22));
        assert_eq!(
            lines.parent.as_ref().map(|p| p.render(ids::LANG)),
            Some("python:m.py/Base".to_owned())
        );
        for (rendered, traits) in [
            (
                "python:m.py/DEBUG",
                vec![
                    "TNamed",
                    "TStructural",
                    "TTypedEntity",
                    "TChildOf",
                    "TSourceAnchor",
                    "TWithValue",
                ],
            ),
            (
                "python:m.py/CALLED",
                vec!["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
            ),
            (
                "python:m.py/Kind.FAST",
                vec![
                    "TNamed",
                    "TStructural",
                    "TTypedEntity",
                    "TChildOf",
                    "TSourceAnchor",
                    "TWithValue",
                ],
            ),
        ] {
            assert_eq!(entity(&extraction, rendered).traits, traits, "{rendered}");
        }
    }

    #[test]
    fn a_written_value_is_a_literal_a_class_a_type_an_enum_member_its_member_and_code_none() {
        let extraction = extract_sources(&[("m.py", BINDINGS)]);
        let value = |rendered: &str| entity(&extraction, rendered).value.as_deref().cloned();
        let kind = entity(&extraction, "python:m.py/Kind").key.clone();
        let enum_member = |name: &str| {
            Some(Literal::Enum {
                ty: kind.clone(),
                name: name.into(),
            })
        };
        assert_eq!(value("python:m.py/DEBUG"), Some(Literal::Boolean(false)));
        assert_eq!(value("python:m.py/LIMIT"), Some(Literal::Number("3".into())));
        assert_eq!(value("python:m.py/registry"), Some(Literal::Unevaluated("{}".into())));
        assert_eq!(value("python:m.py/DEFAULT"), enum_member("SLOW"));
        assert_eq!(
            value("python:m.py/CLASS"),
            Some(Literal::Type(entity(&extraction, "python:m.py/Base").key.clone()))
        );
        assert_eq!(value("python:m.py/CALLED"), None);
        // A name is a value where it names a constant — a module binding, a library's — never a parameter.
        assert_eq!(value("python:m.py/ALIAS"), Some(Literal::Unevaluated("LIMIT".into())));
        assert_eq!(
            value("python:m.py/LEVEL"),
            Some(Literal::Unevaluated("logging.DEBUG".into()))
        );
        assert_eq!(value("python:m.py/Base.label"), None);
        assert_eq!(value("python:m.py/Kind.FAST"), Some(Literal::Number("1".into())));
        assert_eq!(value("python:m.py/Base.rate"), Some(Literal::Number("0.5".into())));
        assert_eq!(value("python:m.py/Base.lines"), Some(Literal::Array(Vec::new())));
        assert_eq!(value("python:m.py/Child.extra"), Some(Literal::Null));
        let parameter = |name: &str| value(&format!("python:m.py/Base.__init__#param:{name}"));
        assert_eq!(parameter("kind"), enum_member("FAST"));
        assert_eq!(parameter("label"), Some(Literal::String("x".into())));
        assert_eq!(parameter("n"), Some(Literal::Number("-1".into())));
        assert_eq!(parameter("self"), None);
        assert!(
            entity(&extraction, "python:m.py/Base.__init__#param:n")
                .traits
                .contains(&"TWithValue")
        );
    }

    #[test]
    fn a_base_reads_what_is_bound_before_its_class_and_never_a_parameter_as_a_class() {
        let extraction = extract_sources(&[(
            "m.py",
            "from somewhere import *\nclass Base: pass\n\
             def make(Base):\n    class Local(Base): pass\n    return Local\n\
             class Events(Events): pass\n",
        )]);
        // The parameter, not the module's class: a value no line types. And `Events` is the star
        // import's, never the class being written — an inference, since no line names its module.
        let inheritance: Vec<(String, &str)> = extraction
            .model
            .edges
            .iter()
            .filter(|e| e.kind == "inheritance")
            .map(|e| (e.to.render(ids::LANG), e.provenance))
            .collect();
        assert_eq!(
            inheritance,
            vec![("python:<site>%2Fsomewhere/Events".to_owned(), "derived")]
        );
        assert_eq!((extraction.stats.self_edges, extraction.stats.star_attributed), (0, 1));
        let drops: Vec<(&str, u32)> = extraction.stats.drops.iter().map(|d| (d.reason, d.line)).collect();
        assert_eq!(drops, vec![("computed-base", 4)]);
    }

    #[test]
    fn a_class_redefined_on_itself_points_at_nothing_new() {
        // `class Foo(Foo)` after `class Foo`: one entity, so the base is a self-edge.
        let extraction = extract_sources(&[("m.py", "class Foo:\n    pass\nclass Foo(Foo):\n    pass\n")]);
        assert_eq!(extraction.stats.self_edges, 1);
        assert!(extraction.model.edges.is_empty());
        assert_eq!(extraction.stats.resolved_corpus, 1);
    }

    #[test]
    fn spells_a_signature_as_python_does_and_writes_no_default() {
        let read = |source: &str| declarations(source, &corpus::line_starts(source));
        let file = read(
            "def every(a, b=1, /, c=2, *args, d, e=3, **kwargs): pass\ndef keywords(*, key): pass\n\
             def only(x, /): pass\ndef plain(self, reference, *lines): pass\ndef none(): pass\n",
        );
        let signatures: Vec<String> = file.functions.iter().map(signature).collect();
        assert_eq!(
            signatures,
            vec![
                "every(a, b=…, /, c=…, *args, d, e=…, **kwargs)",
                "keywords(*, key)",
                "only(x, /)",
                "plain(self, reference, *lines)",
                "none()",
            ]
        );
    }
}
