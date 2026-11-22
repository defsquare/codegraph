//! Pass 7 — what a running program said (`--trace`, PLAN.md §23.5), merged
//! after the baseline: a base the interpreter holds and no line writes is a
//! `generated` inheritance; a call it saw is a `dynamic-candidate` invocation
//! where the model does not already state it; a function it holds is counted.
//! Keys never come from the trace — it names files, lines and `__qualname__`s —
//! and what has no entity here is counted, never invented.

use super::Extractor;
use crate::declarations::{Chain, Reference};
use crate::ids;
use crate::resolve::ModuleRef;
use crate::stats::TraceStats;
use crate::trace::Trace;
use codegraph_model::{Edge, Key};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Python's `__qualname__` with the `<locals>` steps a nested key does not write.
fn symbol(qualname: &str) -> String {
    qualname.replace(".<locals>", "")
}

/// The names a chain calls: `a.b().c()` calls `b` and `c`.
fn called(chain: &Chain, out: &mut Vec<String>) {
    match chain {
        Chain::Call(callee) => {
            match callee.as_ref() {
                Chain::Name(name) | Chain::Attribute(_, name) => out.push(name.clone()),
                _ => {}
            }
            called(callee, out);
        }
        Chain::Attribute(inner, _) => called(inner, out),
        _ => {}
    }
}

impl Extractor<'_> {
    pub(super) fn trace(&mut self, trace: &Trace) {
        let mut stats = TraceStats::default();
        let files = self.files;
        let by_path: HashMap<&str, usize> = self
            .corpus
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.rel.as_str(), index))
            .collect();
        // A corpus class by its file and its symbol, as the trace's `__qualname__` names it.
        let mut classes: HashMap<(usize, String), (usize, Key)> = HashMap::new();
        for (file, decls) in files.iter().enumerate() {
            for (index, class) in decls.classes.iter().enumerate() {
                if let Some(key) = self.scope_keys[file][class.body].clone() {
                    classes.insert((file, key.symbol.to_string()), (index, key));
                }
            }
        }
        let inherits: HashSet<(Key, Key)> = self
            .edges
            .iter()
            .filter(|edge| edge.kind == "inheritance")
            .map(|edge| (edge.from.clone(), edge.to.clone()))
            .collect();
        let based_at: HashSet<(Key, u32)> = self
            .edges
            .iter()
            .filter(|edge| edge.kind == "inheritance")
            .map(|edge| (edge.from.clone(), edge.anchor.start))
            .collect();

        // --- bases: what a call, a metaclass or a decorator gave a class.
        for base in &trace.bases {
            stats.bases += 1;
            let Some((class, from)) = by_path
                .get(base.file.as_str())
                .and_then(|file| classes.get(&(*file, symbol(&base.class))).map(|found| (*file, found)))
                .map(|(file, (index, key))| ((file, *index), key.clone()))
            else {
                stats.bases_outside += 1;
                continue;
            };
            // Every class ends with `object`: implied, never added.
            if base.module == "builtins" && base.name == "object" {
                stats.bases_known += 1;
                continue;
            }
            // A library's base is a stub, made only if its edge is written.
            let library = match &base.at {
                Some(_) => None,
                None if base.module == "builtins" => Some(None),
                None if crate::stdlib_table::table().is_module(&base.module) => {
                    Some(Some(ModuleRef::Stdlib(base.module.clone())))
                }
                None => Some(Some(ModuleRef::Site(base.module.clone()))),
            };
            let to = match (&base.at, &library) {
                (Some(at), _) => match by_path
                    .get(at.as_str())
                    .and_then(|file| classes.get(&(*file, symbol(&base.name))))
                {
                    Some((_, key)) => key.clone(),
                    // A class of a corpus file the model does not hold.
                    None => {
                        stats.bases_outside += 1;
                        continue;
                    }
                },
                (None, Some(None)) => ids::stub_type_key(&ids::builtins_key(), &base.name),
                // Where the table declares it, as every site keys it.
                (None, Some(Some(ModuleRef::Stdlib(dotted)))) => {
                    match crate::stdlib_table::table().class(dotted, &base.name) {
                        Some(("builtins", name)) => ids::stub_type_key(&ids::builtins_key(), name),
                        Some((declared, name)) => ids::stub_type_key(&ids::stdlib_key(declared), name),
                        None => ids::stub_type_key(&ids::stdlib_key(dotted), &base.name),
                    }
                }
                (None, Some(Some(module))) => {
                    let dotted = match module {
                        ModuleRef::Site(dotted) => dotted,
                        _ => unreachable!("a library base is the table's or a third party's"),
                    };
                    ids::stub_type_key(&ids::site_key(dotted), &base.name)
                }
                (None, None) => unreachable!("no file is a library's"),
            };
            // Known: the same edge, or the written base at that place names the same class,
            // spelled as the source writes it (`models.Model` for `django.db.models.base.Model`).
            let decl = &files[class.0].classes[class.1];
            let written = decl.bases.get(base.index as usize).is_some_and(|written| {
                let last = base.name.rsplit('.').next().unwrap_or(&base.name);
                matches!(&written.reference, Reference::Dotted(names) if names.last().map(String::as_str) == Some(last))
                    && based_at.contains(&(from.clone(), written.span.0))
            });
            if written || inherits.contains(&(from.clone(), to.clone())) {
                stats.bases_known += 1;
                continue;
            }
            // No line writes it: anchored on the class the interpreter found it on.
            let to = match library {
                Some(None) => {
                    let module = self.stubs.builtins();
                    self.stubs.type_below(module, &base.name)
                }
                Some(Some(module @ ModuleRef::Stdlib(_))) => self.stub_class(&module, &base.name),
                Some(Some(module)) => {
                    let module = self.stubs.module(&module, &self.file_keys);
                    self.stubs.type_below(module, &base.name)
                }
                None => to,
            };
            let anchor = self.anchor(class.0, (decl.span.0, decl.span.0));
            if self.edge("inheritance", &from, to, "generated", anchor) {
                stats.bases_generated += 1;
            } else {
                stats.bases_known += 1;
            }
        }

        // --- functions: the lines that write one, against the lines the interpreter names.
        let mut defined: HashMap<(usize, u32), usize> = HashMap::new();
        for (file, decls) in files.iter().enumerate() {
            for (index, function) in decls.functions.iter().enumerate() {
                defined.entry((file, function.head)).or_insert(index);
                defined.entry((file, function.span.0)).or_insert(index);
            }
        }
        for function in &trace.functions {
            stats.functions += 1;
            match by_path.get(function.file.as_str()) {
                None => stats.functions_outside += 1,
                Some(file) if defined.contains_key(&(*file, function.line)) => stats.functions_known += 1,
                Some(_) => stats.functions_at_run_time += 1,
            }
        }

        // --- calls: what a site reached, where the model does not already say so.
        let stated: HashSet<(Key, Key, u32)> = self
            .edges
            .iter()
            .filter(|edge| edge.kind == "invocation")
            .map(|edge| (edge.from.clone(), edge.to.clone(), edge.anchor.start))
            .collect();
        struct Reached {
            from: Key,
            span: (u32, u32),
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
                .and_then(|function| self.scope_keys[at][files[at].functions[*function].body].clone())
            else {
                stats.calls_untargeted += 1;
                continue;
            };
            let decls = &files[file];
            // A constructor or `__call__` is entered from a call that names the class or the value.
            let any = matches!(call.name.as_str(), "__init__" | "__new__" | "__call__");
            let site = decls.sites.iter().find(|site| {
                if site.span.0 != call.line {
                    return false;
                }
                let mut names = Vec::new();
                called(&site.chain, &mut names);
                names.contains(&call.name) || (any && !names.is_empty())
            });
            let Some(site) = site else {
                stats.calls_unmatched += 1;
                continue;
            };
            let from = match site.class {
                Some(class) => self.scope_keys[file][decls.classes[class].body].clone(),
                None => self.scope_keys[file][decls.owner(site.scope)].clone(),
            };
            let Some(from) = from else {
                stats.calls_unmatched += 1;
                continue;
            };
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
            // A function that reaches itself is no dependency.
            candidates.retain(|candidate| *candidate != from);
            let Some(to) = candidates.first().cloned() else {
                self.stats.self_edges += 1;
                continue;
            };
            let edge = Edge {
                kind: "invocation",
                from: from.clone(),
                to,
                provenance: "dynamic-candidate",
                anchor: self.anchor(file, span),
                access: None,
                candidates: Some(candidates),
                arguments: None,
            };
            if self.push_edge(edge) {
                self.invokes.insert(from);
                stats.calls_added += 1;
            }
        }
        self.stats.trace = Some(stats);
    }
}
