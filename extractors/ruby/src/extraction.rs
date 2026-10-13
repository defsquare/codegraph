//! Passes 2–4: entities, edges, stubs — the model (PLAN.md §19.9, M18b).
//!
//! Every edge states how it is known: `declared` for what the source writes
//! and the lexical and ancestor rules bind; `derived` for what is inferred — a
//! receiver typed by what a body assigns, a call attributed to the one library
//! ancestor that could answer it, an import no `require` writes; `generated`
//! for what the language itself defines (`Struct.new` makes a Struct).

use crate::core_table::{self, CoreTable};
use crate::corpus::Corpus;
use crate::declarations::{
    Assigned, ConstPath, FileDecls, Lit, MethodDecl, Owner, Receiver, RequireKind, ScopeKind, Site, Span, Superclass,
    What, declarations, is_operator,
};
use crate::ids;
use crate::model::{Anchor, Edge, Entity, Key, Literal, Model};
use crate::resolve::{Ancestor, Found, Place, Resolution, Step, TypeKind, Whitelist};
use crate::stats::{Stats, TraceStats};
use crate::trace::Trace;
use crate::{NAME, PRISM_VERSION, VERSION};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

const FILE_TRAITS: &[&str] = &["TNamed", "TModule", "TWithChildren", "TSourceAnchor", "TMetrics"];
const STUB_MODULE_TRAITS: &[&str] = &["TNamed", "TModule", "TWithChildren"];
const CLASS_TRAITS: &[&str] = &[
    "TNamed",
    "TType",
    "TWithInheritances",
    "TWithChildren",
    "TChildOf",
    "TSourceAnchor",
];
const MODULE_TRAITS: &[&str] = &["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"];
const STUB_TYPE_TRAITS: &[&str] = &["TNamed", "TType", "TChildOf"];
const MEMBER_TRAITS: &[&str] = &["TNamed", "TStructural", "TChildOf", "TSourceAnchor"];
const METHOD_TRAITS: &[&str] = &[
    "TNamed",
    "TInvocable",
    "TWithChildren",
    "TWithParameters",
    "TWithInvocations",
    "TWithAccesses",
    "TChildOf",
    "TSourceAnchor",
    "TMetrics",
];

/// Directories a `require` is searched from, by the layout's own convention.
const LOAD_ROOTS: &[&str] = &["lib", "spec", "test"];

pub struct Extraction {
    pub model: Model,
    pub stats: Stats,
}

/// What nothing under the roots declares, collected as edges name it.
#[derive(Default)]
struct Stubs {
    /// Constant path → its kind in the VM's table.
    core: BTreeMap<String, TypeKind>,
    /// Constant path → whether some site treats it as a class (inherits from
    /// it, instantiates it, raises it) rather than only naming it.
    gems: BTreeMap<String, bool>,
    /// A feature or a missing path a `require` names: module key → display name.
    modules: BTreeMap<String, String>,
}

impl Stubs {
    fn core(&mut self, fqn: &str, kind: TypeKind) -> Key {
        self.core.insert(fqn.to_owned(), kind);
        ids::type_key(&ids::reserved_key(ids::RUBY), fqn)
    }

    fn gems(&mut self, fqn: &str, class: bool) -> Key {
        *self.gems.entry(fqn.to_owned()).or_insert(false) |= class;
        ids::type_key(&ids::reserved_key(ids::GEMS), fqn)
    }

    fn module(&mut self, key: Key, name: &str) -> Key {
        self.modules.insert(key.module.clone(), name.to_owned());
        key
    }

    fn entities(self) -> Vec<Entity> {
        let mut out = Vec::new();
        let stub_module = |key: Key, name: &str| {
            let mut entity = Entity::new(key, "file", STUB_MODULE_TRAITS);
            entity.name = Some(name.to_owned());
            entity.is_stub = Some(true);
            entity.defined_in = Some(Vec::new());
            entity
        };
        let stub_type = |reserved: &str, fqn: &str, kind: TypeKind| {
            let module = ids::reserved_key(reserved);
            let mut entity = Entity::new(ids::type_key(&module, fqn), kind.kind(), STUB_TYPE_TRAITS);
            entity.name = Some(fqn.to_owned());
            entity.is_stub = Some(true);
            entity.parent = Some(module);
            entity
        };
        // A reserved module exists only because something points below it.
        if !self.core.is_empty() {
            out.push(stub_module(ids::reserved_key(ids::RUBY), ids::RUBY));
        }
        if !self.gems.is_empty() {
            out.push(stub_module(ids::reserved_key(ids::GEMS), ids::GEMS));
        }
        for (fqn, kind) in &self.core {
            out.push(stub_type(ids::RUBY, fqn, *kind));
        }
        for (fqn, class) in &self.gems {
            // Every class is a module: `module` is what can be said of a name
            // nothing instantiates or inherits from.
            out.push(stub_type(
                ids::GEMS,
                fqn,
                if *class { TypeKind::Class } else { TypeKind::Module },
            ));
        }
        for (module, name) in &self.modules {
            out.push(stub_module(Key::module(module.clone()), name));
        }
        out
    }
}

/// `a/b/../c/./d` → `a/c/d`; a path that climbs above the root keeps its `..`.
fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." if matches!(out.last(), Some(&last) if last != "..") => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out.join("/")
}

fn directory(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

fn with_rb(path: String) -> String {
    if path.ends_with(".rb") {
        path
    } else {
        format!("{path}.rb")
    }
}

/// How many leading directories two root-relative paths share.
fn shared_directories(a: &str, b: &str) -> usize {
    directory(a)
        .split('/')
        .zip(directory(b).split('/'))
        .take_while(|(x, y)| x == y && !x.is_empty())
        .count()
}

/// file name → the corpus files a `load` of it could run, by load root.
fn features_of_files(corpus: &Corpus) -> HashMap<String, Vec<usize>> {
    features(corpus, true)
}

/// feature → the corpus files a `require` of it could load, by load root.
fn features(corpus: &Corpus, whole_names: bool) -> HashMap<String, Vec<usize>> {
    let mut features: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, file) in corpus.files.iter().enumerate() {
        // `require` names a feature (`.rb` implied); `load` a file, extension and all.
        let stem = match (whole_names, file.rel.strip_suffix(".rb")) {
            (true, _) => file.rel.as_str(),
            (false, Some(stem)) => stem,
            (false, None) => continue,
        };
        // The root itself is a load root: a script run from it, and `.` in Ruby 1.8's path.
        features.entry(stem.to_owned()).or_default().push(index);
        let segments: Vec<&str> = stem.split('/').collect();
        for (at, segment) in segments.iter().enumerate() {
            if LOAD_ROOTS.contains(segment) && at + 1 < segments.len() {
                features.entry(segments[at + 1..].join("/")).or_default().push(index);
            }
        }
    }
    features
}

/// The field an instance variable is: per type, per side, per name — or per
/// file for a script's top level.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum FieldOwner {
    Type(String),
    File(usize),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct FieldId {
    owner: FieldOwner,
    /// `@x` of the class itself (a class body, a singleton method), not of its instances.
    on_class: bool,
    name: String,
}

/// What a name finds, owned: the lookup's answer once it no longer borrows the chain.
enum Answer {
    Method(Key),
    Field(Key, bool),
    Core(&'static str),
    Missing {
        foreign: Vec<String>,
        dynamic: Option<String>,
    },
}

struct Extractor<'a> {
    corpus: &'a Corpus,
    files: &'a [FileDecls],
    whitelist: &'a Whitelist<'a>,
    core: &'a CoreTable,
    file_keys: Vec<Key>,
    stubs: Stubs,
    stats: Stats,
    entities: Vec<Entity>,
    edges: Vec<Edge>,
    seen_edges: HashSet<Edge>,
    /// (file, target file) → the first site where a constant of the target is named.
    cross_file: BTreeMap<(usize, usize), Span>,
    /// (file, target file) pairs a `require` already states.
    required: HashSet<(usize, usize)>,
    /// Every `def` written → the entity it is (a redefinition is the first one's).
    method_keys: HashMap<Place, Key>,
    /// Every constant assigned → the entity it is.
    constant_keys: HashMap<Place, Key>,
    /// A mention of a variable → the field it is: the root-most ancestor's.
    bindings: HashMap<FieldId, FieldId>,
    field_keys: HashMap<FieldId, Key>,
    /// A field → the one class every assignment to it instantiates, if there is one.
    field_types: HashMap<FieldId, Option<Ancestor>>,
    chains: HashMap<(String, bool), Rc<Vec<Step>>>,
    /// Entities that are the source of an invocation / of an access.
    invokes: HashSet<Key>,
    accesses: HashSet<Key>,
    /// What is being read — file, line, what it writes — for `--explain-dropped`.
    current: Option<(usize, u32, String)>,
    /// Every drop explained, as (file, line, text): put in source order before it is printed.
    explained: Vec<(usize, u32, String)>,
}

enum HeaderSite {
    Superclass,
    Mixin,
}

impl Extractor<'_> {
    /// Counts a drop, and says where when asked to.
    fn drop(&mut self, reason: &'static str) {
        self.stats.drop(reason);
        if let Some((file, line, what)) = &self.current {
            let text = format!("{reason}: {}:{line} {what}", self.corpus.files[*file].rel);
            self.explained.push((*file, *line, text));
        }
    }

    /// A miss in a chain where `owner` defines methods at run time: the drop names it.
    fn drop_dynamic(&mut self, owner: &str) {
        if let Some((_, _, what)) = &mut self.current {
            what.push_str(&format!(" ({owner} defines methods at run time)"));
        }
        self.drop("unbound-dynamic");
    }

    /// A miss several libraries in the chain could answer: the drop names them.
    fn drop_ambiguous(&mut self, foreign: &[String]) {
        if let Some((_, _, what)) = &mut self.current {
            what.push_str(&format!(" ({})", foreign.join(" or ")));
        }
        self.drop("ambiguous-ancestor");
    }

    /// Names what is about to be read, so a drop can say where — built only when asked for.
    fn reading(&mut self, file: usize, line: u32, what: impl FnOnce() -> String) {
        if self.stats.explain {
            self.current = Some((file, line, what()));
        }
    }

    fn anchor(&self, file: usize, span: Span) -> Anchor {
        Anchor {
            file: self.corpus.files[file].rel.clone(),
            start: span.0,
            end: span.1,
        }
    }

    fn type_key(&self, file: usize, fqn: &str) -> Key {
        ids::type_key(&self.file_keys[file], fqn)
    }

    fn edge(
        &mut self,
        kind: &'static str,
        from: &Key,
        to: Key,
        provenance: &'static str,
        anchor: Anchor,
        access: Option<(bool, bool)>,
    ) {
        if *from == to {
            self.stats.self_edges += 1;
            return;
        }
        match kind {
            "invocation" => {
                self.invokes.insert(from.clone());
            }
            "access" => {
                self.accesses.insert(from.clone());
            }
            _ => {}
        }
        let edge = Edge {
            kind,
            from: from.clone(),
            to,
            provenance,
            anchor,
            access,
            candidates: None,
        };
        if self.seen_edges.insert(edge.clone()) {
            self.edges.push(edge);
        }
    }

    // --------------------------------------------------------------- trace ----

    /// Merges what a running program said (`--trace`), after the baseline's
    /// own pass: a fact the source already writes is the same fact, a new one
    /// is an edge that says where it comes from. Keys never come from the
    /// trace — it names constants, files and lines, and what has no entity
    /// here is counted, never invented.
    fn trace(&mut self, trace: &Trace) {
        let mut stats = TraceStats::default();
        let whitelist = self.whitelist;
        let by_path: HashMap<&str, usize> = self
            .corpus
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.rel.as_str(), index))
            .collect();

        // --- mixins: what a hook, or a block nobody can read, gave a type.
        for mixin in &trace.mixins {
            stats.mixins += 1;
            let Resolution::Declared { fqn, file } = whitelist.classify(mixin.type_name.clone()) else {
                stats.mixins_outside += 1;
                continue;
            };
            let ancestor = whitelist.as_ancestor(&mixin.module);
            let written = whitelist.facts(&fqn).is_some_and(|facts| {
                [&facts.includes, &facts.prepends, &facts.extends]
                    .iter()
                    .any(|list| list.contains(&ancestor))
            });
            if written {
                stats.mixins_known += 1;
                continue;
            }
            let to = match whitelist.classify(mixin.module.clone()) {
                Resolution::Declared { fqn, file } => self.type_key(file, &fqn),
                Resolution::Core { fqn, kind } => self.stubs.core(&fqn, kind),
                Resolution::Gems { fqn } => self.stubs.gems(&fqn, false),
                Resolution::Value { .. } | Resolution::CoreValue { .. } | Resolution::Namespace { .. } => {
                    stats.mixins_outside += 1;
                    continue;
                }
            };
            let from = self.type_key(file, &fqn);
            // No line writes it: anchored on the class the VM found it on.
            let line = whitelist
                .primary(&fqn)
                .map(|declaration| declaration.span.0)
                .unwrap_or(1);
            let anchor = self.anchor(file, (line, line));
            let before = self.edges.len();
            self.edge("traitUsage", &from, to, "generated", anchor, None);
            if self.edges.len() > before {
                stats.mixins_generated += 1;
            } else {
                stats.mixins_known += 1;
            }
        }

        // --- methods: the lines that write one, against the lines the VM names.
        let mut written: HashSet<(usize, u32)> = HashSet::new();
        let mut defined: HashMap<(usize, u32), Place> = HashMap::new();
        for (file, decls) in self.files.iter().enumerate() {
            for (scope, body) in decls.scopes.iter().enumerate() {
                for (index, method) in body.methods.iter().enumerate() {
                    written.insert((file, method.span.0));
                    defined
                        .entry((file, method.span.0))
                        .or_insert(Place { file, scope, index });
                }
                written.extend(body.attrs.iter().map(|attr| (file, attr.span.0)));
                written.extend(body.members.iter().map(|(_, span)| (file, span.0)));
            }
        }
        for method in &trace.methods {
            stats.methods += 1;
            match by_path.get(method.file.as_str()) {
                None => stats.methods_outside += 1,
                Some(file) if written.contains(&(*file, method.line)) => stats.methods_known += 1,
                Some(_) => stats.methods_at_run_time += 1,
            }
        }

        // --- calls: what a site the baseline could not type actually reached.
        let stated: HashSet<(Key, Key, u32)> = self
            .edges
            .iter()
            .filter(|edge| edge.kind == "invocation")
            .map(|edge| (edge.from.clone(), edge.to.clone(), edge.anchor.start))
            .collect();
        // A site — file, line, name — to who calls there, where, and what it reached.
        struct Reached {
            from: Key,
            span: Span,
            targets: Vec<Key>,
        }
        let mut reached: BTreeMap<(usize, u32, String), Reached> = BTreeMap::new();
        for call in &trace.calls {
            stats.calls += 1;
            let (Some(&file), Some(&at)) = (by_path.get(call.file.as_str()), by_path.get(call.at.as_str())) else {
                stats.calls_outside += 1;
                continue;
            };
            let Some(to) = defined
                .get(&(at, call.def))
                .and_then(|place| self.method_keys.get(place))
                .cloned()
            else {
                stats.calls_untargeted += 1;
                continue;
            };
            let site = self.files[file].sites.iter().find(|site| {
                site.span.0 == call.line && matches!(&site.what, What::Call { name, .. } if *name == call.name)
            });
            let Some(site) = site else {
                stats.calls_unmatched += 1;
                continue;
            };
            let from = self.owner_key(file, site.owner);
            if stated.contains(&(from.clone(), to.clone(), call.line)) {
                stats.calls_known += 1;
                continue;
            }
            stats.calls_bound += 1;
            reached
                .entry((file, call.line, call.name.clone()))
                .or_insert_with(|| Reached {
                    from,
                    span: site.span,
                    targets: Vec::new(),
                })
                .targets
                .push(to);
        }
        for ((file, _, _), site) in reached {
            let Reached {
                from,
                span,
                targets: mut candidates,
            } = site;
            candidates.sort_by(|a, b| a.canonical_cmp(b));
            candidates.dedup();
            // A method that reaches itself is no dependency.
            candidates.retain(|candidate| *candidate != from);
            let Some(to) = candidates.first().cloned() else {
                self.stats.self_edges += 1;
                continue;
            };
            self.invokes.insert(from.clone());
            let edge = Edge {
                kind: "invocation",
                from,
                to,
                provenance: "dynamic-candidate",
                anchor: self.anchor(file, span),
                access: None,
                candidates: Some(candidates),
            };
            if self.seen_edges.insert(edge.clone()) {
                self.edges.push(edge);
                stats.calls_added += 1;
            }
        }
        self.stats.trace = Some(stats);
    }

    /// A constant of another file was named here: where nothing is required, that is the import.
    fn crosses(&mut self, file: usize, target: usize, span: Span) {
        if file != target {
            let first = self.cross_file.entry((file, target)).or_insert(span);
            *first = (*first).min(span);
        }
    }

    /// The entity a superclass or a mixin names, stubbing what is external.
    fn header_target(&mut self, resolution: Resolution, site: HeaderSite, file: usize, span: Span) -> Option<Key> {
        match resolution {
            Resolution::Declared { fqn, file: declared_in } => {
                self.stats.resolved_corpus += 1;
                self.crosses(file, declared_in, span);
                Some(self.type_key(declared_in, &fqn))
            }
            Resolution::Core { fqn, kind } => {
                self.stats.resolved_core += 1;
                Some(self.stubs.core(&fqn, kind))
            }
            Resolution::Gems { fqn } => {
                self.stats.resolved_gems += 1;
                Some(self.stubs.gems(&fqn, matches!(site, HeaderSite::Superclass)))
            }
            Resolution::Value { .. } | Resolution::CoreValue { .. } | Resolution::Namespace { .. } => {
                self.drop("not-a-type");
                None
            }
        }
    }

    /// The nearest type, from `scope` outward, that is an entity IN THIS FILE — else the file.
    fn enclosing_key(&self, file: usize, mut scope: Option<usize>) -> Key {
        let scopes = &self.files[file].scopes;
        while let Some(index) = scope {
            if let Some(fqn) = self.whitelist.fqn(file, index)
                && self.whitelist.declaration_in(fqn, file).is_some()
            {
                return self.type_key(file, fqn);
            }
            scope = scopes[index].parent;
        }
        self.file_keys[file].clone()
    }

    /// The entity a site's edges come from.
    fn owner_key(&self, file: usize, owner: Owner) -> Key {
        let place = |scope, index| Place { file, scope, index };
        match owner {
            Owner::File => self.file_keys[file].clone(),
            Owner::Type(scope) => self.enclosing_key(file, Some(scope)),
            Owner::Method(scope, index) => match self.method_keys.get(&place(scope, index)) {
                Some(key) => key.clone(),
                None => self.enclosing_key(file, Some(scope)),
            },
            Owner::Constant(scope, index) => match self.constant_keys.get(&place(scope, index)) {
                Some(key) => key.clone(),
                None => self.enclosing_key(file, Some(scope)),
            },
        }
    }

    fn chain(&mut self, fqn: &str, on_class: bool) -> Rc<Vec<Step>> {
        if let Some(chain) = self.chains.get(&(fqn.to_owned(), on_class)) {
            return Rc::clone(chain);
        }
        let chain = Rc::new(if on_class {
            self.whitelist.singleton_chain(fqn)
        } else {
            self.whitelist.receiver_chain(fqn)
        });
        self.chains.insert((fqn.to_owned(), on_class), Rc::clone(&chain));
        chain
    }

    // ------------------------------------------------------------ entities ----

    fn files(&mut self) {
        for (index, file) in self.corpus.files.iter().enumerate() {
            let mut entity = Entity::new(self.file_keys[index].clone(), "file", FILE_TRAITS);
            entity.name = Some(file.rel.clone());
            entity.is_stub = Some(false);
            entity.defined_in = Some(vec![file.rel.clone()]);
            entity.metrics = Some(vec![("sloc", self.files[index].sloc((1, file.lines)))]);
            entity.anchor = Some(Anchor {
                file: file.rel.clone(),
                start: 1,
                end: file.lines,
            });
            self.entities.push(entity);
        }
    }

    fn types(&mut self) {
        for file in 0..self.files.len() {
            for scope in 0..self.files[file].scopes.len() {
                let Some(fqn) = self.whitelist.fqn(file, scope) else {
                    continue;
                };
                // The entity is the first body of this constant in this file that is not a wrapper.
                let Some(declaration) = self.whitelist.declaration_in(fqn, file).filter(|d| d.scope == scope) else {
                    continue;
                };
                let key = self.type_key(file, fqn);
                let traits = match declaration.kind {
                    TypeKind::Class => CLASS_TRAITS,
                    TypeKind::Module => MODULE_TRAITS,
                };
                let mut entity = Entity::new(key.clone(), declaration.kind.kind(), traits);
                entity.name = Some(fqn.to_owned());
                entity.is_stub = Some(false);
                entity.parent = Some(self.enclosing_key(file, self.files[file].scopes[scope].parent));
                entity.anchor = Some(self.anchor(file, declaration.span));
                // A reopening is attached to the declaration a reference would
                // name: the VM's for a core type, the primary body otherwise.
                let primary = match self.whitelist.classify(fqn.to_owned()) {
                    Resolution::Core { fqn, kind } => Some(self.stubs.core(&fqn, kind)),
                    Resolution::Declared { fqn, file: declared_in } => Some(self.type_key(declared_in, &fqn)),
                    _ => None,
                };
                if let Some(primary) = primary.filter(|primary| *primary != key) {
                    entity.attached_to = Some(primary);
                    entity.traits.push("TAttachedTo");
                }
                if let Some(comment) = &self.files[file].scopes[scope].comment {
                    entity.comments = Some(vec![comment.clone()]);
                    entity.traits.push("TComment");
                }
                entity.metrics = Some(vec![("sloc", self.files[file].sloc(declaration.span))]);
                entity.traits.push("TMetrics");
                self.entities.push(entity);
            }
        }
    }

    /// A written value in core's tags; a constant naming a type is a type literal.
    fn literal(&mut self, file: usize, scope: usize, value: &Lit) -> Literal {
        match value {
            Lit::String(text) => Literal::String(text.clone()),
            Lit::Number(text) => Literal::Number(text.clone()),
            Lit::Boolean(flag) => Literal::Boolean(*flag),
            Lit::Null => Literal::Null,
            Lit::Array(items) => Literal::Array(items.iter().map(|item| self.literal(file, scope, item)).collect()),
            Lit::Unevaluated(source) => Literal::Unevaluated(source.clone()),
            Lit::Constant(path) => match self.whitelist.resolve_at(self.files, file, scope, path) {
                Resolution::Declared { fqn, file: declared_in } => Literal::Type(self.type_key(declared_in, &fqn)),
                Resolution::Core { fqn, kind } => Literal::Type(self.stubs.core(&fqn, kind)),
                // A library's constant may be a value as well as a type: its text is all that is known.
                _ => Literal::Unevaluated(path.written()),
            },
        }
    }

    fn constants(&mut self) {
        let files = self.files;
        let mut written: HashSet<Key> = HashSet::new();
        for (file, decls) in files.iter().enumerate() {
            for (scope_index, scope) in decls.scopes.iter().enumerate() {
                let nesting_scope = scope_index;
                for (index, constant) in scope.constants.iter().enumerate() {
                    // Its constant path, as the whitelist named it.
                    let resolution = match (constant.path.absolute, constant.path.segments.as_slice()) {
                        (false, [name]) => {
                            let nesting = self.whitelist.nesting(files, file, Some(nesting_scope));
                            let base = nesting.first().copied().unwrap_or("");
                            let fqn = if base.is_empty() {
                                name.clone()
                            } else {
                                format!("{base}::{name}")
                            };
                            self.whitelist.classify(fqn)
                        }
                        _ => {
                            let nesting = self.whitelist.nesting(files, file, Some(nesting_scope));
                            self.whitelist.resolve(&constant.path, &nesting)
                        }
                    };
                    // A constant some body makes a type, or the VM defines, is not a value of ours.
                    let Resolution::Value { fqn, .. } = resolution else {
                        continue;
                    };
                    let key = self.type_key(file, &fqn);
                    let place = Place {
                        file,
                        scope: scope_index,
                        index,
                    };
                    self.constant_keys.insert(place, key.clone());
                    if !written.insert(key.clone()) {
                        // Assigned twice in one file: one entity, the first.
                        continue;
                    }
                    let mut entity = Entity::new(key, "constant", MEMBER_TRAITS);
                    entity.name = Some(fqn);
                    entity.parent = Some(self.enclosing_key(file, Some(scope_index)));
                    entity.anchor = Some(self.anchor(file, constant.span));
                    if let Some(comment) = &constant.comment {
                        entity.comments = Some(vec![comment.clone()]);
                        entity.traits.push("TComment");
                    }
                    if let Some(value) = &constant.value {
                        entity.value = Some(self.literal(file, scope_index, value));
                        entity.traits.push("TWithValue");
                    }
                    self.entities.push(entity);
                }
            }
        }
    }

    fn methods(&mut self) {
        let mut seen: HashMap<Key, Key> = HashMap::new();
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            for (scope_index, scope) in decls.scopes.iter().enumerate() {
                let owner = match scope.kind {
                    ScopeKind::File => self.file_keys[file].clone(),
                    ScopeKind::Class | ScopeKind::Module => match self.whitelist.fqn(file, scope_index) {
                        Some(fqn) => self.type_key(file, fqn),
                        None => continue,
                    },
                    ScopeKind::Opaque => continue,
                };
                for (index, method) in scope.methods.iter().enumerate() {
                    let key = ids::method_key(&owner, &method.name, method.singleton);
                    let place = Place {
                        file,
                        scope: scope_index,
                        index,
                    };
                    // Ruby keeps the last `def`; the model keeps one entity, anchored at the first.
                    if let Some(first) = seen.get(&key) {
                        self.reading(file, method.span.0, || method.name.clone());
                        self.drop("redefined-method");
                        self.method_keys.insert(place, first.clone());
                        continue;
                    }
                    seen.insert(key.clone(), key.clone());
                    self.method_keys.insert(place, key.clone());
                    self.method(file, scope_index, &owner, key, method);
                }
            }
        }
    }

    fn method(&mut self, file: usize, scope: usize, owner: &Key, key: Key, method: &MethodDecl) {
        let mut parameters = Vec::with_capacity(method.parameters.len());
        let mut used: HashSet<&str> = HashSet::new();
        for (index, parameter) in method.parameters.iter().enumerate() {
            // By name; by 1-based ordinal when there is none or it repeats (`def f(_, _)`).
            let tag = match parameter.name.as_deref() {
                Some(name) if used.insert(name) => name.to_owned(),
                _ => (index + 1).to_string(),
            };
            let parameter_key = ids::parameter_key(&key, &tag);
            let mut traits = vec!["TStructural", "TChildOf"];
            if parameter.name.is_some() {
                traits.push("TNamed");
            }
            traits.push("TSourceAnchor");
            let mut entity = Entity::new(parameter_key.clone(), "parameter", &traits);
            entity.name = parameter.name.clone();
            entity.parent = Some(key.clone());
            entity.anchor = Some(self.anchor(file, parameter.span));
            if let Some(default) = &parameter.default {
                entity.value = Some(self.literal(file, scope, default));
                entity.traits.push("TWithValue");
            }
            self.entities.push(entity);
            parameters.push(parameter_key);
        }
        let mut entity = Entity::new(key, "method", METHOD_TRAITS);
        entity.name = Some(method.name.clone());
        entity.signature = Some(method.signature.clone());
        entity.parent = Some(owner.clone());
        entity.parameters = Some(parameters);
        entity.anchor = Some(self.anchor(file, method.span));
        if let Some(comment) = &method.comment {
            entity.comments = Some(vec![comment.clone()]);
            entity.traits.push("TComment");
        }
        entity.metrics = Some(vec![
            ("cyclomatic", method.cyclomatic),
            ("sloc", self.files[file].sloc(method.span)),
        ]);
        self.entities.push(entity);
    }

    fn field_id(&self, file: usize, site: &Site, name: &str) -> FieldId {
        match self.whitelist.fqn(file, site.scope) {
            // A class variable is the class's whatever `self` is.
            Some(fqn) => FieldId {
                owner: FieldOwner::Type(fqn.to_owned()),
                on_class: site.on_class && !name.starts_with("@@"),
                name: name.to_owned(),
            },
            None => FieldId {
                owner: FieldOwner::File(file),
                on_class: false,
                name: name.to_owned(),
            },
        }
    }

    /// The fields: what an `attr_*` or a Struct member declares, and what a
    /// body mentions — one entity per variable, on the root-most ancestor
    /// that has it.
    fn fields(&mut self) {
        let files = self.files;
        let mut located: BTreeMap<FieldId, (usize, usize, Span)> = BTreeMap::new();
        for (file, decls) in files.iter().enumerate() {
            for (scope_index, scope) in decls.scopes.iter().enumerate() {
                let Some(fqn) = self.whitelist.fqn(file, scope_index) else {
                    continue;
                };
                let owner = FieldOwner::Type(fqn.to_owned());
                for attr in &scope.attrs {
                    let id = FieldId {
                        owner: owner.clone(),
                        on_class: attr.on_class,
                        name: format!("@{}", attr.name),
                    };
                    located.entry(id).or_insert((file, scope_index, attr.span));
                }
                for (member, span) in &scope.members {
                    let id = FieldId {
                        owner: owner.clone(),
                        on_class: false,
                        name: format!("@{member}"),
                    };
                    located.entry(id).or_insert((file, scope_index, *span));
                }
            }
        }
        for (file, decls) in files.iter().enumerate() {
            for site in &decls.sites {
                if let What::Variable { name, .. } = &site.what {
                    located
                        .entry(self.field_id(file, site, name))
                        .or_insert((file, site.scope, site.span));
                }
            }
        }

        // An instance variable belongs to the object: a subclass that reads
        // `@total` reads the field its superclass declares.
        let ids: Vec<FieldId> = located.keys().cloned().collect();
        for id in ids {
            let mut bound = id.clone();
            if let (FieldOwner::Type(fqn), false) = (&id.owner, id.on_class) {
                for step in self.chain(fqn, false).iter() {
                    if let Step::Instance(Ancestor::Corpus(ancestor)) = step {
                        let candidate = FieldId {
                            owner: FieldOwner::Type(ancestor.clone()),
                            on_class: false,
                            name: id.name.clone(),
                        };
                        if located.contains_key(&candidate) {
                            bound = candidate;
                        }
                    }
                }
            }
            self.bindings.insert(id, bound);
        }

        let targets: BTreeSet<FieldId> = self.bindings.values().cloned().collect();
        for target in targets {
            let (file, scope, span) = located[&target];
            let owner = match &target.owner {
                FieldOwner::Type(_) => self.enclosing_key(file, Some(scope)),
                FieldOwner::File(file) => self.file_keys[*file].clone(),
            };
            let key = ids::field_key(&owner, &target.name, target.on_class);
            let mut entity = Entity::new(key.clone(), "field", MEMBER_TRAITS);
            entity.name = Some(target.name.clone());
            entity.parent = Some(owner);
            entity.anchor = Some(self.anchor(file, span));
            self.entities.push(entity);
            self.field_keys.insert(target, key);
        }

        // A field is typed when every assignment to it instantiates one class.
        let mut types: HashMap<FieldId, Option<Ancestor>> = HashMap::new();
        for (file, decls) in files.iter().enumerate() {
            for site in &decls.sites {
                let What::Variable {
                    name,
                    assigned: Some(assigned),
                    ..
                } = &site.what
                else {
                    continue;
                };
                let Some(field) = self.bindings.get(&self.field_id(file, site, name)).cloned() else {
                    continue;
                };
                let class = match assigned {
                    Assigned::New(path) => self
                        .whitelist
                        .ancestor_of(&self.whitelist.resolve_at(files, file, site.scope, path)),
                    Assigned::Other => None,
                };
                match types.get(&field) {
                    None => {
                        types.insert(field, class);
                    }
                    Some(known) if *known == class => {}
                    Some(_) => {
                        types.insert(field, None);
                    }
                }
            }
        }
        self.field_types = types;
    }

    // --------------------------------------------------------------- edges ----

    fn type_edges(&mut self) {
        let files = self.files;
        for file in 0..files.len() {
            for (index, scope) in files[file].scopes.iter().enumerate() {
                let whitelist = self.whitelist;
                let Some(fqn) = whitelist.fqn(file, index) else {
                    continue;
                };
                let from = self.type_key(file, fqn);
                match &scope.superclass {
                    Superclass::None => {}
                    Superclass::Computed => {
                        self.reading(file, scope.span.0, || fqn.to_owned());
                        self.drop("computed-superclass");
                    }
                    Superclass::Core(name, span) => {
                        // `Struct.new(:x)` is a Struct: the language says so, the source does not.
                        self.stats.resolved_core += 1;
                        let to = self.stubs.core(name, TypeKind::Class);
                        let anchor = self.anchor(file, *span);
                        self.edge("inheritance", &from, to, "generated", anchor, None);
                    }
                    Superclass::Constant(reference) => {
                        // The superclass is evaluated where the class is written, not inside it.
                        let nesting = self.whitelist.nesting(files, file, scope.parent);
                        let resolution = self.whitelist.resolve(&reference.path, &nesting);
                        self.reading(file, reference.span.0, || reference.path.written());
                        if let Some(to) = self.header_target(resolution, HeaderSite::Superclass, file, reference.span) {
                            let anchor = self.anchor(file, reference.span);
                            self.edge("inheritance", &from, to, "declared", anchor, None);
                        }
                    }
                }
                for mixin in &scope.mixins {
                    let reference = &mixin.reference;
                    let nesting = self.whitelist.nesting(files, file, Some(index));
                    let resolution = self.whitelist.resolve(&reference.path, &nesting);
                    self.reading(file, reference.span.0, || reference.path.written());
                    if let Some(to) = self.header_target(resolution, HeaderSite::Mixin, file, reference.span) {
                        let anchor = self.anchor(file, reference.span);
                        self.edge("traitUsage", &from, to, "declared", anchor, None);
                    }
                }
            }
        }
    }

    /// The method entity a call lands on: this file's body of it, else the
    /// primary declaration's, else the first written.
    fn method_target(&self, places: &[Place], file: usize, owner: &str) -> Option<Key> {
        let primary = self.whitelist.primary(owner).map(|declaration| declaration.file);
        let place = places
            .iter()
            .find(|place| place.file == file)
            .or_else(|| places.iter().find(|place| Some(place.file) == primary))
            .or_else(|| places.first())?;
        self.method_keys.get(place).cloned()
    }

    /// What `name` finds along `chain`, as keys — and whether only an
    /// `included` hook put what answers in the chain.
    fn answer(&self, chain: &[Step], name: &str, file: usize) -> (Answer, bool) {
        let missing = || Answer::Missing {
            foreign: Vec::new(),
            dynamic: None,
        };
        match self.whitelist.lookup(chain, name) {
            Found::Method { owner, places, hooked } => (
                self.method_target(places, file, owner)
                    .map(Answer::Method)
                    .unwrap_or_else(missing),
                hooked,
            ),
            Found::Accessor {
                owner,
                on_class,
                field,
                write,
                hooked,
            } => {
                let id = FieldId {
                    owner: FieldOwner::Type(owner.to_owned()),
                    on_class,
                    name: field.to_owned(),
                };
                let field = self.bindings.get(&id).and_then(|bound| self.field_keys.get(bound));
                (
                    field
                        .map(|key| Answer::Field(key.clone(), write))
                        .unwrap_or_else(missing),
                    hooked,
                )
            }
            Found::Core { owner } => (Answer::Core(owner), false),
            Found::Missing { foreign, dynamic } => (
                Answer::Missing {
                    foreign: foreign.into_iter().map(str::to_owned).collect(),
                    dynamic: dynamic.map(str::to_owned),
                },
                false,
            ),
        }
    }

    /// A `def` at some file's top level is a private method of every object:
    /// this file's, else the only one the corpus writes under that name.
    fn toplevel_method(&self, name: &str, file: usize) -> Option<Key> {
        let places = self.whitelist.toplevel(name);
        let place = places.iter().find(|place| place.file == file).or(match places {
            [only] => Some(only),
            _ => None,
        })?;
        self.method_keys.get(place).cloned()
    }

    fn sites(&mut self) {
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            for site in &decls.sites {
                let from = self.owner_key(file, site.owner);
                let anchor = self.anchor(file, site.span);
                self.reading(file, site.span.0, || match &site.what {
                    What::Constant(path) | What::Qualifier(path) => path.written(),
                    What::Call { name, .. } | What::MethodRef { name, .. } => name.clone(),
                    What::Super => "super".to_owned(),
                    What::Variable { name, .. } => name.clone(),
                    What::Raise(_) => "raise".to_owned(),
                });
                match &site.what {
                    What::Constant(path) => self.constant_site(file, site, &from, anchor, path),
                    // Where it names a type, a read of it. A namespace no file
                    // gives a body to is nothing to point at — and nothing lost.
                    What::Qualifier(path) => {
                        let resolution = self.whitelist.resolve_at(files, file, site.scope, path);
                        if matches!(
                            resolution,
                            Resolution::Declared { .. } | Resolution::Core { .. } | Resolution::Gems { .. }
                        ) {
                            self.constant_site(file, site, &from, anchor, path);
                        }
                    }
                    What::Call { receiver, name } => self.call_site(file, site, &from, anchor, receiver, name, false),
                    What::MethodRef { receiver, name } => {
                        self.call_site(file, site, &from, anchor, receiver, name, true)
                    }
                    What::Super => self.super_site(file, site, &from, anchor),
                    What::Variable { name, read, write, .. } => {
                        let field = self.bindings.get(&self.field_id(file, site, name)).cloned();
                        if let Some(to) = field.and_then(|field| self.field_keys.get(&field).cloned()) {
                            self.stats.resolved_corpus += 1;
                            self.edge("access", &from, to, "declared", anchor, Some((*read, *write)));
                        }
                    }
                    What::Raise(raised) => self.raise_site(file, site, &from, anchor, raised.as_ref()),
                }
            }
        }
    }

    fn constant_site(&mut self, file: usize, site: &Site, from: &Key, anchor: Anchor, path: &ConstPath) {
        match self.whitelist.resolve_at(self.files, file, site.scope, path) {
            Resolution::Declared { fqn, file: declared_in } => {
                self.stats.resolved_corpus += 1;
                self.crosses(file, declared_in, site.span);
                let to = self.type_key(declared_in, &fqn);
                self.edge("reference", from, to, "declared", anchor, None);
            }
            Resolution::Core { fqn, kind } => {
                self.stats.resolved_core += 1;
                let to = self.stubs.core(&fqn, kind);
                self.edge("reference", from, to, "declared", anchor, None);
            }
            Resolution::Gems { fqn } => {
                self.stats.resolved_gems += 1;
                let to = self.stubs.gems(&fqn, false);
                self.edge("reference", from, to, "declared", anchor, None);
            }
            // Reading a value constant is reading a member: an access.
            Resolution::Value { place, .. } => match self.constant_keys.get(&place).cloned() {
                Some(to) => {
                    self.stats.resolved_corpus += 1;
                    self.crosses(file, place.file, site.span);
                    self.edge("access", from, to, "declared", anchor, Some((true, false)));
                }
                None => self.drop("namespace-only"),
            },
            Resolution::CoreValue { .. } => self.stats.language += 1,
            Resolution::Namespace { .. } => self.drop("namespace-only"),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn call_site(
        &mut self,
        file: usize,
        site: &Site,
        from: &Key,
        anchor: Anchor,
        receiver: &Receiver,
        name: &str,
        as_value: bool,
    ) {
        let lexical = self.whitelist.fqn(file, site.scope).map(str::to_owned);
        // Whose method it is, how the receiver's type is known, and whether
        // the receiver is a type the model only has a stub for.
        let (class, on_class, provenance, literal): (Option<Ancestor>, bool, &'static str, bool) = match receiver {
            Receiver::ImplicitSelf | Receiver::ExplicitSelf => match &lexical {
                Some(fqn) => (Some(Ancestor::Corpus(fqn.clone())), site.on_class, "declared", false),
                None => (None, false, "declared", false),
            },
            Receiver::SelfClass => match &lexical {
                Some(fqn) => (Some(Ancestor::Corpus(fqn.clone())), true, "declared", false),
                None => return self.untyped(name),
            },
            Receiver::Constant(path) => {
                let resolution = self.whitelist.resolve_at(self.files, file, site.scope, path);
                match (self.whitelist.ancestor_of(&resolution), resolution) {
                    (Some(class), _) => (Some(class), true, "declared", false),
                    // `ENV.fetch`, `ARGV.first`: the VM's own objects.
                    (None, Resolution::CoreValue { .. }) => return self.stats.language += 1,
                    // `LIMITS.fetch(x)`: a value, whose class the source does not say.
                    (None, _) => return self.untyped(name),
                }
            }
            // `new(…).call` in a class method: an instance of the class it is written in.
            Receiver::NewSelf => match &lexical {
                Some(fqn) if site.on_class => (Some(Ancestor::Corpus(fqn.clone())), false, "declared", false),
                _ => return self.untyped(name),
            },
            Receiver::New(path) | Receiver::TypedLocal(path) => {
                let resolution = self.whitelist.resolve_at(self.files, file, site.scope, path);
                let provenance = if matches!(receiver, Receiver::New(_)) {
                    "declared"
                } else {
                    "derived"
                };
                match self.whitelist.ancestor_of(&resolution) {
                    Some(class) => (Some(class), false, provenance, false),
                    None => return self.untyped(name),
                }
            }
            Receiver::Variable(variable) => {
                let field = self.bindings.get(&self.field_id(file, site, variable));
                match field.and_then(|field| self.field_types.get(field)).cloned().flatten() {
                    Some(class) => (Some(class), false, "derived", false),
                    None => return self.untyped(name),
                }
            }
            Receiver::Literal(class) => match self.core.name(class) {
                Some(class) => (Some(self.whitelist.as_ancestor(class)), false, "declared", true),
                None => return self.untyped(name),
            },
            Receiver::Untyped | Receiver::Local(_) => return self.untyped(name),
        };
        let implicit = matches!(receiver, Receiver::ImplicitSelf | Receiver::ExplicitSelf);

        // A library's type: nothing of it is known but its name — the call lands on the stub.
        if let Some(Ancestor::Gems(fqn)) = &class {
            if as_value {
                return;
            }
            self.stats.resolved_gems += 1;
            let to = self.stubs.gems(fqn, name == "new" && on_class);
            return self.edge("invocation", from, to, provenance, anchor, None);
        }

        // `Foo.new(…)` — and a bare `new(…)` where `self` is the class — runs `initialize`.
        let instantiates = on_class
            && name == "new"
            && matches!(
                receiver,
                Receiver::Constant(_) | Receiver::ImplicitSelf | Receiver::ExplicitSelf | Receiver::SelfClass
            );
        let (chain, wanted, class_side) = match (&class, instantiates) {
            (Some(Ancestor::Corpus(fqn)), true) => (self.chain(fqn, false), "initialize", false),
            (Some(Ancestor::Corpus(fqn)), false) => (self.chain(fqn, on_class), name, on_class),
            (Some(Ancestor::Core(core)), true) => (self.chain(core, false), "initialize", false),
            (Some(Ancestor::Core(core)), false) => (self.chain(core, on_class), name, on_class),
            (Some(Ancestor::Gems(_)), _) => unreachable!("a library receiver returned above"),
            // A file's top level: `self` is `main`.
            (None, _) => (Rc::new(self.whitelist.main_chain()), name, false),
        };
        // A type the model has only a stub for: the VM's own class, named as the receiver.
        let stub_receiver = match &class {
            Some(Ancestor::Core(core)) if !implicit && !literal => Some(*core),
            _ => None,
        };

        let (answer, hooked) = self.answer(&chain, wanted, file);
        // Through a hook, the receiver's class is written and the link to the method is not.
        let provenance = if hooked { "derived" } else { provenance };
        match answer {
            Answer::Method(to) => {
                self.stats.resolved_corpus += 1;
                self.edge(
                    if as_value { "reference" } else { "invocation" },
                    from,
                    to,
                    provenance,
                    anchor,
                    None,
                );
            }
            _ if as_value => {}
            Answer::Field(to, write) => {
                self.stats.resolved_corpus += 1;
                self.edge("access", from, to, provenance, anchor, Some((!write, write)));
            }
            // What every object answers, and what a literal answers, is the language.
            Answer::Core(owner) if literal || CoreTable::is_language(owner, class_side) => self.stats.language += 1,
            Answer::Core(owner) => {
                // A core class the corpus inherits from or names: a dependency on it.
                self.stats.resolved_core += 1;
                let target = stub_receiver.unwrap_or(owner);
                let kind = if self.core.kind(target) == Some(core_table::CoreKind::Module) {
                    TypeKind::Module
                } else {
                    TypeKind::Class
                };
                let to = self.stubs.core(target, kind);
                self.edge("invocation", from, to, provenance, anchor, None);
            }
            Answer::Missing { foreign, dynamic } => {
                if let Some(core) = stub_receiver {
                    // `Time.zone`: a method some library adds to a core class. The receiver is still that class.
                    self.stats.resolved_core += 1;
                    let to = self.stubs.core(core, TypeKind::Class);
                    return self.edge("invocation", from, to, provenance, anchor, None);
                }
                if implicit && let Some(to) = self.toplevel_method(wanted, file) {
                    self.stats.resolved_corpus += 1;
                    return self.edge("invocation", from, to, "declared", anchor, None);
                }
                if instantiates {
                    // No `initialize` anywhere: the constant read already says the class is used.
                    self.stats.language += 1;
                    return;
                }
                if let Some(owner) = dynamic {
                    return self.drop_dynamic(&owner);
                }
                match foreign.as_slice() {
                    // Nothing the corpus or the VM defines answers, and exactly one
                    // library is in the chain: it must be that one's.
                    [only] => {
                        self.stats.resolved_gems += 1;
                        self.stats.attributed += 1;
                        let to = self.stubs.gems(only, false);
                        self.edge("invocation", from, to, "derived", anchor, None);
                    }
                    [] => self.drop(if implicit {
                        "unbound-self-call"
                    } else {
                        "unbound-method"
                    }),
                    _ => self.drop_ambiguous(&foreign),
                }
            }
        }
    }

    fn untyped(&mut self, name: &str) {
        if is_operator(name) {
            self.stats.operators_untyped += 1;
        } else {
            self.drop("untyped-receiver");
        }
    }

    fn super_site(&mut self, file: usize, site: &Site, from: &Key, anchor: Anchor) {
        let Owner::Method(scope, index) = site.owner else {
            return self.drop("unbound-super");
        };
        let files = self.files;
        let method = &files[file].scopes[scope].methods[index];
        let Some(fqn) = self.whitelist.fqn(file, scope).map(str::to_owned) else {
            return self.drop("unbound-super");
        };
        if self.whitelist.facts(&fqn).is_some_and(|facts| facts.is_module) && !method.singleton {
            // Whoever mixes the module in decides what is above it.
            return self.drop("super-in-module");
        }
        let chain = self.chain(&fqn, method.singleton);
        let own = if method.singleton {
            Step::Singleton(Ancestor::Corpus(fqn.clone()))
        } else {
            Step::Instance(Ancestor::Corpus(fqn.clone()))
        };
        let above = chain
            .iter()
            .position(|step| *step == own)
            .map(|at| &chain[at + 1..])
            .unwrap_or(&[]);
        let (answer, hooked) = self.answer(above, &method.name, file);
        let provenance = if hooked { "derived" } else { "declared" };
        match answer {
            Answer::Method(to) => {
                self.stats.resolved_corpus += 1;
                self.edge("invocation", from, to, provenance, anchor, None);
            }
            Answer::Field(to, write) => {
                self.stats.resolved_corpus += 1;
                self.edge("access", from, to, provenance, anchor, Some((!write, write)));
            }
            Answer::Core(owner) if CoreTable::is_language(owner, method.singleton) => self.stats.language += 1,
            Answer::Core(owner) => {
                self.stats.resolved_core += 1;
                let to = self.stubs.core(owner, TypeKind::Class);
                self.edge("invocation", from, to, "declared", anchor, None);
            }
            Answer::Missing {
                dynamic: Some(owner), ..
            } => self.drop_dynamic(&owner),
            Answer::Missing { foreign, .. } => match foreign.as_slice() {
                [only] => {
                    self.stats.resolved_gems += 1;
                    self.stats.attributed += 1;
                    let to = self.stubs.gems(only, false);
                    self.edge("invocation", from, to, "derived", anchor, None);
                }
                [] => self.drop("unbound-super"),
                _ => self.drop_ambiguous(&foreign),
            },
        }
    }

    fn raise_site(&mut self, file: usize, site: &Site, from: &Key, anchor: Anchor, raised: Option<&ConstPath>) {
        let to = match raised {
            // `raise "text"` raises a RuntimeError: the language says so.
            None => {
                self.stats.resolved_core += 1;
                self.stubs.core("RuntimeError", TypeKind::Class)
            }
            Some(path) => match self.whitelist.resolve_at(self.files, file, site.scope, path) {
                Resolution::Declared { fqn, file: declared_in } => {
                    self.stats.resolved_corpus += 1;
                    self.type_key(declared_in, &fqn)
                }
                Resolution::Core { fqn, kind } => {
                    self.stats.resolved_core += 1;
                    self.stubs.core(&fqn, kind)
                }
                Resolution::Gems { fqn } => {
                    self.stats.resolved_gems += 1;
                    self.stubs.gems(&fqn, true)
                }
                _ => return self.drop("raise-of-a-value"),
            },
        };
        self.edge("throws", from, to, "declared", anchor, None);
    }

    fn imports(&mut self) {
        let by_path: HashMap<&str, usize> = self
            .corpus
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.rel.as_str(), index))
            .collect();
        let features = features(self.corpus, false);
        let loadable = features_of_files(self.corpus);
        let files = self.files;
        for (file, decls) in files.iter().enumerate() {
            let rel = self.corpus.files[file].rel.as_str();
            let from = self.file_keys[file].clone();
            for require in &decls.requires {
                let to = if matches!(require.kind, RequireKind::Relative | RequireKind::Path) {
                    self.stats.requires_relative += 1;
                    // A path, from the directory of the file that writes it.
                    let path = with_rb(normalize(&format!("{}/{}", directory(rel), require.argument)));
                    self.corpus_or_stub(file, by_path.get(path.as_str()).copied(), ids::file_key(&path), &path)
                } else {
                    self.stats.requires += 1;
                    let (index, feature) = match require.kind {
                        RequireKind::Load => (&loadable, require.argument.as_str()),
                        _ => (
                            &features,
                            require.argument.strip_suffix(".rb").unwrap_or(&require.argument),
                        ),
                    };
                    if feature.starts_with("./") || feature.starts_with("../") {
                        // Relative to the working directory: the root, by the only convention there is.
                        let path = normalize(feature);
                        let path = if require.kind == RequireKind::Load {
                            path
                        } else {
                            with_rb(path)
                        };
                        self.corpus_or_stub(file, by_path.get(path.as_str()).copied(), ids::file_key(&path), &path)
                    } else {
                        let candidates = index.get(feature).map(Vec::as_slice).unwrap_or(&[]);
                        let nearest = candidates
                            .iter()
                            .map(|&candidate| shared_directories(rel, &self.corpus.files[candidate].rel))
                            .max();
                        let mut best = candidates.iter().copied().filter(|&candidate| {
                            Some(shared_directories(rel, &self.corpus.files[candidate].rel)) == nearest
                        });
                        match (best.next(), best.next()) {
                            (Some(only), None) => {
                                self.stats.imports_by_load_path += 1;
                                self.corpus_or_stub(file, Some(only), self.file_keys[only].clone(), feature)
                            }
                            (Some(_), Some(_)) => {
                                // Two load roots answer and neither is nearer: no honest target.
                                self.reading(file, require.span.0, || feature.to_owned());
                                self.drop("ambiguous-require");
                                continue;
                            }
                            _ => self.corpus_or_stub(file, None, ids::feature_key(feature), feature),
                        }
                    }
                };
                let anchor = self.anchor(file, require.span);
                self.edge("import", &from, to, "declared", anchor, None);
            }
        }

        // A constant declared in another file IS the import where nothing is
        // required (Zeitwerk): one derived edge per pair, at the first site.
        let derived: Vec<((usize, usize), Span)> = self
            .cross_file
            .iter()
            .filter(|(pair, _)| !self.required.contains(pair))
            .map(|(p, s)| (*p, *s))
            .collect();
        for ((from, to), span) in derived {
            self.stats.imports_derived += 1;
            let anchor = self.anchor(from, span);
            let (from, to) = (self.file_keys[from].clone(), self.file_keys[to].clone());
            self.edge("import", &from, to, "derived", anchor, None);
        }
    }

    /// The corpus file a `require` resolved to, or the stub module of what it names.
    fn corpus_or_stub(&mut self, from: usize, resolved: Option<usize>, key: Key, name: &str) -> Key {
        match resolved {
            Some(target) => {
                self.required.insert((from, target));
                self.file_keys[target].clone()
            }
            None => {
                self.stats.imports_unresolved += 1;
                self.stubs.module(key, name)
            }
        }
    }
}

/// Runs every pass over a loaded corpus. `phase` is told each pass's name and detail.
pub fn extract(
    corpus: &Corpus,
    repository: Option<Vec<(&'static str, String)>>,
    explain: bool,
    trace: Option<&Trace>,
    phase: &mut dyn FnMut(&str, String),
) -> Extraction {
    let core = core_table::table();

    let files: Vec<FileDecls> = corpus.files.iter().map(|file| declarations(&file.source)).collect();
    let mut stats = Stats {
        files: files.len(),
        explain,
        ..Stats::default()
    };
    let mut explained = Vec::new();
    for (index, (file, decls)) in corpus.files.iter().zip(&files).enumerate() {
        if decls.errors > 0 {
            stats.with_errors.push((file.rel.clone(), decls.errors));
        }
        stats.lossy_names += decls.lossy_names;
        for drop in &decls.drops {
            stats.drop(drop.reason);
            if explain {
                let text = format!("{}: {}:{} {}", drop.reason, file.rel, drop.line, drop.what);
                explained.push((index, drop.line, text));
            }
        }
    }
    phase(
        "parse",
        format!("{} files, {} with syntax errors", files.len(), stats.with_errors.len()),
    );

    let whitelist = Whitelist::build(&files, core);
    phase("whitelist", format!("{} declarations", whitelist.type_count()));

    let mut extractor = Extractor {
        corpus,
        files: &files,
        whitelist: &whitelist,
        core,
        file_keys: corpus.files.iter().map(|file| ids::file_key(&file.rel)).collect(),
        stubs: Stubs::default(),
        stats,
        entities: Vec::new(),
        edges: Vec::new(),
        seen_edges: HashSet::new(),
        cross_file: BTreeMap::new(),
        required: HashSet::new(),
        method_keys: HashMap::new(),
        constant_keys: HashMap::new(),
        bindings: HashMap::new(),
        field_keys: HashMap::new(),
        field_types: HashMap::new(),
        chains: HashMap::new(),
        invokes: HashSet::new(),
        accesses: HashSet::new(),
        current: None,
        explained,
    };
    extractor.files();
    extractor.types();
    extractor.constants();
    extractor.methods();
    extractor.fields();
    phase("entities", format!("{} entities", extractor.entities.len()));

    extractor.type_edges();
    extractor.sites();
    extractor.current = None;
    extractor.imports();
    phase("edges", format!("{} edges", extractor.edges.len()));
    if let Some(trace) = trace {
        let before = extractor.edges.len();
        extractor.trace(trace);
        phase("trace", format!("{} edges added", extractor.edges.len() - before));
    }

    let Extractor {
        stubs,
        mut stats,
        mut entities,
        edges,
        invokes,
        accesses,
        mut explained,
        ..
    } = extractor;
    // Source order, whichever pass dropped it.
    explained.sort_by_key(|(file, line, _)| (*file, *line));
    stats.explained = explained.into_iter().map(|(_, _, text)| text).collect();
    // A file, a type or a constant that calls or reads says so (a method always may).
    for entity in &mut entities {
        if matches!(entity.kind, "file" | "class" | "module" | "constant") {
            if invokes.contains(&entity.key) {
                entity.traits.push("TWithInvocations");
            }
            if accesses.contains(&entity.key) {
                entity.traits.push("TWithAccesses");
            }
        }
    }
    let stub_entities = stubs.entities();
    stats.stubs = stub_entities.len();
    phase("stubs", format!("{} stubs", stub_entities.len()));
    entities.extend(stub_entities);
    stats.entities = entities.len();
    stats.edges = edges.len();

    let extractor_header = vec![
        ("name", NAME.to_owned()),
        ("version", VERSION.to_owned()),
        ("prism", PRISM_VERSION.to_owned()),
        ("rbs", core.version().to_owned()),
    ];
    let model = Model {
        extractor: extractor_header,
        root: corpus.root_display.clone(),
        repository,
        entities,
        edges,
    };
    Extraction { model, stats }
}

#[cfg(test)]
mod tests;
