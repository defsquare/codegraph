//! What the run resolved, and what it dropped and why — the summary on stderr.
//! A drop is counted by reason, never silent: the counts ARE the profile's
//! stated ceiling, measured.

use std::collections::BTreeMap;

/// What `--trace` found in a running program's account of the corpus. Every
/// record is counted once: in the model already, added, or set aside and why.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct TraceStats {
    pub mixins: u64,
    /// The source writes it: the same fact.
    pub mixins_known: u64,
    /// Added as a `generated` `traitUsage`.
    pub mixins_generated: u64,
    /// On a type the corpus does not declare, or naming what is no type.
    pub mixins_outside: u64,
    pub methods: u64,
    /// A `def`, an `attr_*` or a `define_method` is written on that line.
    pub methods_known: u64,
    /// Defined where nothing writes it: no entity, and none is made up.
    pub methods_at_run_time: u64,
    pub methods_outside: u64,
    pub calls: u64,
    /// An edge of the baseline already says so.
    pub calls_known: u64,
    /// Bound to a site the baseline left unresolved…
    pub calls_bound: u64,
    /// …as this many `dynamic-candidate` invocations, one per site.
    pub calls_added: u64,
    /// No call of that name is written on that line.
    pub calls_unmatched: u64,
    /// The callee is defined where no `def` is written.
    pub calls_untargeted: u64,
    pub calls_outside: u64,
}

#[derive(Default)]
pub struct Stats {
    pub files: usize,
    /// Files Prism recovered from syntax errors in, with the error count.
    pub with_errors: Vec<(String, usize)>,
    pub lossy_names: u64,
    /// Sites that named something the corpus declares.
    pub resolved_corpus: u64,
    /// Sites that named something the VM defines, as an edge to its stub.
    pub resolved_core: u64,
    /// Sites that named a library's, as an edge to its stub.
    pub resolved_gems: u64,
    /// Sites that use the language itself (`puts`, `private`, `"x".upcase`): resolved, and no edge.
    pub language: u64,
    /// Of `resolved_gems`: calls nothing known answers, attributed to the sole library ancestor.
    pub attributed: u64,
    /// `a + b`, `x[0]`, `!done` on a receiver no parser can type: the language
    /// far more often than not, and kept out of the rate either way.
    pub operators_untyped: u64,
    /// Sites and declarations dropped, by reason.
    pub dropped: BTreeMap<&'static str, u64>,
    pub requires: u64,
    pub requires_relative: u64,
    pub imports_unresolved: u64,
    pub imports_by_load_path: u64,
    pub imports_derived: u64,
    pub self_edges: u64,
    /// `--explain-dropped`: every dropped site, as `reason: file:line what`.
    pub explain: bool,
    pub explained: Vec<String>,
    pub entities: usize,
    pub stubs: usize,
    pub edges: usize,
    /// `--trace`: what the trace added, and what it could not.
    pub trace: Option<TraceStats>,
}

/// Drop reasons that are SITES — something written that named nothing the
/// model can point at. The others are declarations no key can carry.
const UNRESOLVED_SITES: &[&str] = &[
    "ambiguous-ancestor",
    "call-in-unkeyed-body",
    "computed-mixin",
    "computed-superclass",
    "dynamic-dispatch",
    "namespace-only",
    "not-a-type",
    "raise-of-a-value",
    "super-in-module",
    "unbound-dynamic",
    "unbound-method",
    "unbound-self-call",
    "unbound-super",
    "untyped-receiver",
];

impl Stats {
    pub fn drop(&mut self, reason: &'static str) {
        *self.dropped.entry(reason).or_insert(0) += 1;
    }

    pub fn summary(&self) -> String {
        let resolved = self.resolved_corpus + self.resolved_core + self.resolved_gems + self.language;
        let unresolved: u64 = UNRESOLVED_SITES
            .iter()
            .filter_map(|reason| self.dropped.get(reason))
            .sum();
        let sites = resolved + unresolved;
        let rate = if sites == 0 {
            "n/a".to_owned()
        } else {
            format!("{:.1}%", resolved as f64 * 100.0 / sites as f64)
        };
        let mut out = String::from("RESOLUTION SUMMARY\n");
        out.push_str(&format!(
            "  files           : {} (with syntax errors: {})\n",
            self.files,
            self.with_errors.len()
        ));
        out.push_str(&format!("  sites           : {sites}\n"));
        out.push_str(&format!(
            "  resolved        : {resolved} (corpus {}, <ruby> {}, <gems> {}, the language {})\n",
            self.resolved_corpus, self.resolved_core, self.resolved_gems, self.language
        ));
        out.push_str(&format!("  unresolved      : {unresolved}\n"));
        out.push_str(&format!("  resolution rate : {rate}\n"));
        for (reason, count) in &self.dropped {
            out.push_str(&format!("  {:<28}: {count}\n", format!("{reason} (dropped)")));
        }
        if self.attributed > 0 {
            out.push_str(&format!("  ancestor-attributed         : {}\n", self.attributed));
        }
        if self.operators_untyped > 0 {
            out.push_str(&format!(
                "  operators, untyped receiver : {} (not in the rate)\n",
                self.operators_untyped
            ));
        }
        if self.lossy_names > 0 {
            out.push_str(&format!("  names not valid UTF-8       : {}\n", self.lossy_names));
        }
        out.push_str(&format!(
            "  imports         : {} (require {}, require_relative {}; unresolved: {}, by load path: {}, derived: {})\n",
            self.requires + self.requires_relative + self.imports_derived,
            self.requires,
            self.requires_relative,
            self.imports_unresolved,
            self.imports_by_load_path,
            self.imports_derived
        ));
        if let Some(trace) = &self.trace {
            out.push_str(&format!(
                "  trace mixins    : {} ({} in the source, {} added as generated, {} outside the corpus)\n",
                trace.mixins, trace.mixins_known, trace.mixins_generated, trace.mixins_outside
            ));
            out.push_str(&format!(
                "  trace methods   : {} ({} written, {} defined at run time — no entity, {} outside the corpus)\n",
                trace.methods, trace.methods_known, trace.methods_at_run_time, trace.methods_outside
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
    fn states_the_rate_over_the_sites_that_named_something() {
        let mut stats = Stats {
            resolved_corpus: 6,
            resolved_core: 2,
            resolved_gems: 1,
            language: 5,
            ..Stats::default()
        };
        stats.drop("untyped-receiver");
        stats.drop("computed-superclass");
        // Not a site: a declaration no key can carry does not enter the rate.
        stats.drop("def-on-object");
        stats.operators_untyped = 40;
        let summary = stats.summary();
        assert!(summary.contains("sites           : 16\n"), "{summary}");
        assert!(
            summary.contains("resolved        : 14 (corpus 6, <ruby> 2, <gems> 1, the language 5)\n"),
            "{summary}"
        );
        assert!(summary.contains("resolution rate : 87.5%\n"), "{summary}");
        assert!(summary.contains("untyped-receiver (dropped)  : 1\n"), "{summary}");
        assert!(
            summary.contains("operators, untyped receiver : 40 (not in the rate)\n"),
            "{summary}"
        );
        assert!(Stats::default().summary().contains("resolution rate : n/a\n"));
    }
}
