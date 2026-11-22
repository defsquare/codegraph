//! What the run resolved, and what it dropped and why — the summary on
//! stderr. The drops ARE the list the counts are derived from, so what
//! `--explain-dropped` lists is what the summary counts, by construction.

use std::collections::BTreeMap;

/// Something written that no edge or entity carries, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Drop {
    pub file: usize,
    pub line: u32,
    pub reason: &'static str,
    pub what: String,
}

/// How the import edges were found — one bucket each — and which were for a type checker.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct ImportCounts {
    pub relative: u64,
    pub package_root: u64,
    pub namespace: u64,
    pub implicit_relative: u64,
    pub stdlib: u64,
    pub site: u64,
    pub missing: u64,
    pub type_checking: u64,
}

impl ImportCounts {
    pub fn total(&self) -> u64 {
        self.relative
            + self.package_root
            + self.namespace
            + self.implicit_relative
            + self.stdlib
            + self.site
            + self.missing
    }
}

/// What `--trace` found in a running program's account of the corpus.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct TraceStats {
    pub bases: u64,
    /// …that a written base, or `object`, already gives.
    pub bases_known: u64,
    pub bases_generated: u64,
    /// …of a class, or to a corpus class, the model does not hold.
    pub bases_outside: u64,
    pub functions: u64,
    /// …on a line that writes a `def`.
    pub functions_known: u64,
    /// …on a line that writes none: made at run time, no entity.
    pub functions_at_run_time: u64,
    pub functions_outside: u64,
    pub calls: u64,
    /// …the model already states.
    pub calls_known: u64,
    /// …bound to a site the model does not state them at.
    pub calls_bound: u64,
    /// The `dynamic-candidate` edges those made, one per site.
    pub calls_added: u64,
    /// …at no site of that line that calls that name.
    pub calls_unmatched: u64,
    /// …into a function made at run time.
    pub calls_untargeted: u64,
    pub calls_outside: u64,
}

#[derive(Default)]
pub struct Stats {
    pub files: usize,
    /// Files the parser recovered from syntax errors in, with the error count.
    pub with_errors: Vec<(String, usize)>,
    /// Files decoded exactly from a single-byte encoding: the encoding, the non-ASCII bytes.
    pub decoded: Vec<(String, &'static str, usize)>,
    /// Files read lossily: the encoding, the U+FFFD written.
    pub lossy: Vec<(String, String, usize)>,
    /// Sites that named a corpus declaration.
    pub resolved_corpus: u64,
    /// …a name of `builtins`, as an edge to its stub.
    pub resolved_builtins: u64,
    /// …a name of the standard library, as an edge to its stub.
    pub resolved_stdlib: u64,
    /// …a third party's, as an edge to its stub.
    pub resolved_site: u64,
    /// …a name below a module no file is, as an edge to its stub.
    pub resolved_missing: u64,
    /// …the language itself: resolved, and no edge.
    pub language: u64,
    /// Names bound more than one way, where the first naming a declaration won.
    pub rebound: u64,
    /// Edges `derived` from flow: a local or an attribute assigned one class.
    pub flow_typed: u64,
    /// …from an annotation the interpreter never checks.
    pub annotation_typed: u64,
    /// …from the one library class of an MRO that could answer.
    pub ancestor_attributed: u64,
    /// …from the one star import nothing here answers.
    pub star_attributed: u64,
    /// …from a base that is a name bound once to a class (and what an ancestor it brings answers).
    pub alias_base: u64,
    pub imports: ImportCounts,
    pub drops: Vec<Drop>,
    pub entities: usize,
    pub stubs: usize,
    /// `<site>` stub classes whose symbol is dotted: named through an imported name (`models.Model`).
    pub dotted_site_classes: usize,
    pub edges: usize,
    pub self_edges: u64,
    /// `--trace`: what the trace added, and what it could not.
    pub trace: Option<TraceStats>,
}

/// Drop reasons that are SITES — something written that named nothing the
/// model can point at. The others are declarations and imports no key or edge can carry.
const UNRESOLVED_SITES: &[&str] = &[
    "ambiguous-ancestor",
    "ambiguous-star",
    "computed-base",
    "not-a-class",
    "raise-of-a-value",
    "unbound-attribute",
    "unbound-dynamic",
    "unbound-name",
    "unbound-self-call",
    "untyped-receiver",
];

impl Stats {
    pub fn drop(&mut self, file: usize, line: u32, reason: &'static str, what: impl Into<String>) {
        self.drops.push(Drop {
            file,
            line,
            reason,
            what: what.into(),
        });
    }

    pub fn dropped(&self) -> BTreeMap<&'static str, u64> {
        let mut out = BTreeMap::new();
        for drop in &self.drops {
            *out.entry(drop.reason).or_insert(0) += 1;
        }
        out
    }

    /// Every drop as `reason: file:line what`, in the order of the source.
    pub fn explained(&self, paths: &[&str]) -> Vec<String> {
        let mut drops: Vec<&Drop> = self.drops.iter().collect();
        drops.sort_by_key(|drop| (drop.file, drop.line));
        drops
            .into_iter()
            .map(|drop| format!("{}: {}:{} {}", drop.reason, paths[drop.file], drop.line, drop.what))
            .collect()
    }

    pub fn summary(&self) -> String {
        let resolved = self.resolved_corpus
            + self.resolved_builtins
            + self.resolved_stdlib
            + self.resolved_site
            + self.resolved_missing
            + self.language;
        let dropped = self.dropped();
        let unresolved: u64 = UNRESOLVED_SITES.iter().filter_map(|reason| dropped.get(reason)).sum();
        let sites = resolved + unresolved;
        let rate = if sites == 0 {
            "n/a".to_owned()
        } else {
            format!("{:.1}%", resolved as f64 * 100.0 / sites as f64)
        };
        let mut out = String::from("RESOLUTION SUMMARY\n");
        out.push_str(&format!(
            "  files           : {} (with syntax errors: {}; not UTF-8: {}; read lossily: {})\n",
            self.files,
            self.with_errors.len(),
            self.decoded.len() + self.lossy.len(),
            self.lossy.len()
        ));
        out.push_str(&format!("  sites           : {sites}\n"));
        out.push_str(&format!(
            "  resolved        : {resolved} (corpus {}, <builtins> {}, <stdlib> {}, <site> {}, missing modules {}, the language {})\n",
            self.resolved_corpus,
            self.resolved_builtins,
            self.resolved_stdlib,
            self.resolved_site,
            self.resolved_missing,
            self.language
        ));
        out.push_str(&format!("  unresolved      : {unresolved}\n"));
        out.push_str(&format!("  resolution rate : {rate}\n"));
        for (reason, count) in &dropped {
            out.push_str(&format!("  {:<36}: {count}\n", format!("{reason} (dropped)")));
        }
        for (label, count) in [
            ("rebound-name", self.rebound),
            ("flow-typed", self.flow_typed),
            ("annotation-typed", self.annotation_typed),
            ("ancestor-attributed", self.ancestor_attributed),
            ("star-attributed", self.star_attributed),
            ("alias-base", self.alias_base),
            ("dotted-site-class", self.dotted_site_classes as u64),
        ] {
            if count > 0 {
                out.push_str(&format!("  {label:<36}: {count}\n"));
            }
        }
        let imports = &self.imports;
        out.push_str(&format!(
            "  imports         : {} (relative {}; by package root {}, by namespace package {}, implicit-relative {}; \
             <stdlib> {}, <site> {}; missing {}; type-checking-only {})\n",
            imports.total(),
            imports.relative,
            imports.package_root,
            imports.namespace,
            imports.implicit_relative,
            imports.stdlib,
            imports.site,
            imports.missing,
            imports.type_checking
        ));
        if let Some(trace) = &self.trace {
            out.push_str(&format!(
                "  trace bases     : {} ({} in the source, {} added as generated, {} outside the corpus)\n",
                trace.bases, trace.bases_known, trace.bases_generated, trace.bases_outside
            ));
            out.push_str(&format!(
                "  trace functions : {} ({} written, {} defined at run time — no entity, {} outside the corpus)\n",
                trace.functions, trace.functions_known, trace.functions_at_run_time, trace.functions_outside
            ));
            out.push_str(&format!(
                "  trace calls     : {} ({} in the model, {} bound to {} dynamic-candidate edges, {} unmatched, {} to a run-time definition, {} outside the corpus)\n",
                trace.calls,
                trace.calls_known,
                trace.calls_bound,
                trace.calls_added,
                trace.calls_unmatched,
                trace.calls_untargeted,
                trace.calls_outside
            ));
        }
        out.push_str(&format!(
            "  entities        : {} (stubs: {})\n",
            self.entities, self.stubs
        ));
        out.push_str(&format!(
            "  edges           : {} (self-edges dropped: {})\n",
            self.edges, self.self_edges
        ));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_the_rate_over_the_sites_that_named_something_and_lists_what_it_counts() {
        let mut stats = Stats {
            resolved_corpus: 5,
            resolved_builtins: 1,
            resolved_stdlib: 1,
            resolved_site: 1,
            imports: ImportCounts {
                relative: 2,
                package_root: 3,
                stdlib: 4,
                type_checking: 1,
                ..ImportCounts::default()
            },
            ..Stats::default()
        };
        stats.drop(1, 9, "unbound-name", "Thing");
        stats.drop(0, 4, "computed-base", "make_base()");
        // Not a site: an import no edge can carry does not enter the rate.
        stats.drop(0, 2, "ambiguous-root", "utils (tests/a or tests/b)");
        let summary = stats.summary();
        assert!(summary.contains("  sites           : 10\n"), "{summary}");
        assert!(
            summary.contains("  resolved        : 8 (corpus 5, <builtins> 1, <stdlib> 1, <site> 1, missing modules 0, the language 0)\n"),
            "{summary}"
        );
        assert!(summary.contains("  resolution rate : 80.0%\n"), "{summary}");
        assert!(
            summary.contains("  ambiguous-root (dropped)            : 1\n"),
            "{summary}"
        );
        // The widest reason still lines up.
        stats.drop(0, 7, "redefinition-of-another-kind", "f (a class holds the key)");
        stats.rebound = 2;
        let summary = stats.summary();
        assert!(
            summary.contains("  redefinition-of-another-kind (dropped): 1\n"),
            "{summary}"
        );
        assert!(
            summary.contains("  rebound-name                        : 2\n"),
            "{summary}"
        );
        assert!(summary.contains(
            "  imports         : 9 (relative 2; by package root 3, by namespace package 0, implicit-relative 0; \
             <stdlib> 4, <site> 0; missing 0; type-checking-only 1)\n"
        ));
        assert_eq!(
            stats.explained(&["a.py", "b.py"]),
            vec![
                "ambiguous-root: a.py:2 utils (tests/a or tests/b)",
                "computed-base: a.py:4 make_base()",
                "redefinition-of-another-kind: a.py:7 f (a class holds the key)",
                "unbound-name: b.py:9 Thing",
            ]
        );
        assert!(Stats::default().summary().contains("resolution rate : n/a\n"));
    }
}
