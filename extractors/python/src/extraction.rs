//! Passes 2–4: entities, edges, stubs — the model (PLAN.md §23.9, M22a).
//!
//! Every edge M22a writes is `declared`: an import is written, and a base is a
//! name the scoping rules bind. What the corpus does not declare is a stub
//! below `<builtins>`, a `<stdlib>` module or a `<site>` one, made only
//! because an edge points at it.

use crate::corpus::{Corpus, Decoding};
use crate::declarations::{
    FileDecls, FunctionDecl, ParameterDecl, ParameterKind, Reference, ScopeKind, Span, declarations,
};
use crate::ids;
use crate::resolve::{How, ImportTarget, ModuleRef, Modules, Resolver, Value};
use crate::stats::Stats;
use crate::stdlib_table::{self, Kind};
use crate::{NAME, RUFF_TAG, VERSION};
use codegraph_model::{Anchor, Edge, Entity, Key, Model};
use std::collections::{BTreeMap, HashMap, HashSet};

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

pub struct Extraction {
    pub model: Model,
    pub stats: Stats,
}

/// What nothing under the roots declares, collected as edges name it.
#[derive(Default)]
struct Stubs {
    /// Module key → its name: a dotted name, `<builtins>`, or a missing file's path.
    modules: BTreeMap<String, String>,
    /// (module key, symbol as written).
    types: BTreeMap<(String, String), ()>,
}

impl Stubs {
    fn module(&mut self, module: &ModuleRef, file_keys: &[Key]) -> Key {
        let (key, name) = match module {
            ModuleRef::File(file) => return file_keys[*file].clone(),
            ModuleRef::Stdlib(dotted) => (ids::stdlib_key(dotted), dotted.clone()),
            ModuleRef::Site(dotted) => (ids::site_key(dotted), dotted.clone()),
            ModuleRef::Missing(path) => (ids::file_key(path), path.clone()),
            ModuleRef::Namespace(dir) => unreachable!("a namespace package is no module entity: {dir}"),
        };
        self.modules.insert(key.module.clone(), name);
        key
    }

    fn builtins(&mut self) -> Key {
        let key = ids::builtins_key();
        self.modules.insert(key.module.clone(), ids::BUILTINS.to_owned());
        key
    }

    fn type_below(&mut self, module: Key, symbol: &str) -> Key {
        self.types.insert((module.module.clone(), symbol.to_owned()), ());
        ids::stub_type_key(&module, symbol)
    }

    fn entities(self) -> Vec<Entity> {
        let mut out = Vec::with_capacity(self.modules.len() + self.types.len());
        for (module, name) in self.modules {
            let mut entity = Entity::new(Key::module(module), "module", STUB_MODULE_TRAITS);
            entity.name = Some(name);
            entity.is_stub = Some(true);
            entity.defined_in = Some(Vec::new());
            out.push(entity);
        }
        for (module, symbol) in self.types.into_keys() {
            let parent = Key::module(module);
            let mut entity = Entity::new(ids::stub_type_key(&parent, &symbol), "class", STUB_TYPE_TRAITS);
            entity.name = Some(symbol);
            entity.is_stub = Some(true);
            entity.parent = Some(parent);
            out.push(entity);
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

struct Extractor<'a> {
    corpus: &'a Corpus,
    files: &'a [FileDecls],
    resolver: &'a Resolver<'a>,
    file_keys: Vec<Key>,
    /// Per file, per scope: the entity whose body it is; `None` where the declaration was dropped.
    scope_keys: Vec<Vec<Option<Key>>>,
    /// Every key an entity holds → its kind, so a second declaration of one key merges or is dropped.
    kinds: HashMap<Key, &'static str>,
    stubs: Stubs,
    stats: Stats,
    entities: Vec<Entity>,
    edges: Vec<Edge>,
    seen_edges: HashSet<Edge>,
}

impl Extractor<'_> {
    fn anchor(&self, file: usize, span: Span) -> Anchor {
        Anchor {
            file: self.corpus.files[file].rel.clone(),
            start: span.0,
            end: span.1,
        }
    }

    /// Writes the edge unless it repeats one or points at its own source; `true` when written.
    fn edge(&mut self, kind: &'static str, from: &Key, to: Key, provenance: &'static str, anchor: Anchor) -> bool {
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
            access: None,
            candidates: None,
            arguments: None,
        };
        if self.seen_edges.insert(edge.clone()) {
            self.edges.push(edge);
            true
        } else {
            false
        }
    }

    // ------------------------------------------------------------ entities ----

    fn modules(&mut self) {
        for (index, file) in self.corpus.files.iter().enumerate() {
            let mut entity = Entity::new(self.file_keys[index].clone(), "module", MODULE_TRAITS);
            entity.name = Some(file.rel.clone());
            entity.is_stub = Some(false);
            entity.defined_in = Some(vec![file.rel.clone()]);
            entity.anchor = Some(Anchor {
                file: file.rel.clone(),
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

    // --------------------------------------------------------------- edges ----

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
                                if import.type_checking {
                                    counts.type_checking += 1;
                                }
                            }
                        }
                    }
                }
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
                for base in &class.bases {
                    let line = base.span.0;
                    let Reference::Dotted(names) = &base.reference else {
                        self.stats.drop(file, line, "computed-base", base.text.clone());
                        continue;
                    };
                    let resolved = resolver.base(file, index, names);
                    if resolved.rebound {
                        self.stats.rebound += 1;
                    }
                    let to = match resolved.value {
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
                    let provenance = if resolved.star_attributed {
                        self.stats.star_attributed += 1;
                        "derived"
                    } else {
                        "declared"
                    };
                    self.edge("inheritance", &from, to, provenance, anchor);
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

    let mut extractor = Extractor {
        corpus,
        files: &files,
        resolver: &resolver,
        file_keys: corpus.files.iter().map(|file| ids::file_key(&file.rel)).collect(),
        scope_keys: Vec::with_capacity(files.len()),
        kinds: HashMap::new(),
        stubs: Stubs::default(),
        stats,
        entities: Vec::new(),
        edges: Vec::new(),
        seen_edges: HashSet::new(),
    };
    extractor.modules();
    extractor.declarations();
    phase("entities", format!("{} entities", extractor.entities.len()));
    extractor.imports();
    extractor.bases();
    phase("edges", format!("{} edges", extractor.edges.len()));

    let Extractor {
        stubs,
        mut stats,
        mut entities,
        edges,
        ..
    } = extractor;
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

    fn extract_sources(files: &[(&str, &str)]) -> Extraction {
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

    fn rendered(extraction: &Extraction) -> Vec<(String, &'static str)> {
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

    fn entity<'a>(extraction: &'a Extraction, rendered: &str) -> &'a Entity {
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
