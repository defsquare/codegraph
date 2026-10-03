//! Change history at the model's commit (PLAN.md §18.2), through
//! big-code-analysis's `vcs` feature: per file from one history walk, per
//! measured entity from one blame per file.
//!
//! Evolution facts never enter `model.jsonl` (PLAN.md §11, principle 1):
//! what this module computes is written to a side-car beside the model.
//!
//! The reference is the commit the model describes — the header's
//! `repository.commit` when the extractor recorded one, else HEAD — and the
//! clock is that commit's committer time, never the wall clock, so a re-run
//! over the same repository writes the same bytes. Blame reads files at the
//! reference; anchors come from the files the extractor read. A file whose
//! bytes differ from the reference gets file-level history only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use big_code_analysis::vcs::git::{LineSpan, PerFunctionBlame};
use big_code_analysis::vcs::{Options, Stats, build_history_index};

use crate::model::Measurable;

/// The commit the history is measured at.
pub struct Reference {
    /// The repository's working tree, canonical.
    pub workdir: PathBuf,
    /// Full hex id.
    pub commit: String,
    /// Committer time, Unix seconds: the "now" every window counts back from.
    pub time: i64,
}

/// Opens the repository around `inside` and resolves `wanted` (a revision
/// spelling; HEAD when absent) to a commit and its time.
pub fn resolve(inside: &Path, wanted: Option<&str>) -> Result<Reference, String> {
    // From an absolute path: discovered from a relative one, gix answers a
    // working tree relative to it (`""` for the current directory).
    let inside = inside
        .canonicalize()
        .map_err(|e| format!("{}: {e}", inside.display()))?;
    let repo =
        gix::discover(&inside).map_err(|e| format!("{}: not inside a git repository ({e})", inside.display()))?;
    let workdir = repo.workdir().ok_or("a bare repository has no working tree to blame")?;
    let workdir = workdir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", workdir.display()))?;
    let spec = wanted.unwrap_or("HEAD");
    let commit = repo
        .rev_parse_single(spec)
        .map_err(|e| format!("{spec}: {e}"))?
        .object()
        .map_err(|e| format!("{spec}: {e}"))?
        .peel_to_commit()
        .map_err(|e| format!("{spec}: {e}"))?;
    let time = commit.time().map_err(|e| format!("{spec}: {e}"))?.seconds;
    Ok(Reference {
        workdir,
        commit: commit.id.to_string(),
        time,
    })
}

/// The options both walks share: the reference commit, its time as "now",
/// and the FULL commit graph. big-code-analysis walks first-parent by
/// default, which hides every commit a merge brought in — 65 % of
/// BroadleafCommerce's (6 657 of 18 776 are first-parent) — from the file
/// level while blame still credits them: the two levels would disagree on
/// the same commit. Merge commits themselves stay out (their diff repeats
/// their parents').
pub fn options(reference: &Reference) -> Options {
    let mut options = Options::default();
    options.reference.clone_from(&reference.commit);
    options.as_of = Some(reference.time);
    options.full_history = true;
    options
}

/// Why an entity has no per-entity history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skipped {
    /// The file on disk is not the file at the reference: the anchors and the
    /// blamed lines would not describe the same text.
    Differs,
    /// Not tracked at the reference.
    Untracked,
    /// Blame failed (big-code-analysis documents a rare `gix` race; real
    /// code does not trigger it).
    Failed,
}

/// One model file's history.
pub struct FileHistory {
    /// The model's path (relative to `--src`).
    pub path: String,
    /// Absent for a file the walk saw no record of (untracked at the reference).
    pub file: Option<Stats>,
    /// One `(entity, stats)` per blamed entity, in the order given.
    pub entities: Vec<(u32, Stats)>,
    pub skipped: Option<Skipped>,
}

/// Walks history once and blames every file once; results in `work` order.
pub fn measure(
    reference: &Reference,
    src: &Path,
    work: &[(String, Vec<Measurable>)],
    jobs: usize,
) -> Result<Vec<FileHistory>, String> {
    let src = src.canonicalize().map_err(|e| format!("{}: {e}", src.display()))?;
    let prefix = src
        .strip_prefix(&reference.workdir)
        .map_err(|_| {
            format!(
                "{} is outside the repository at {}",
                src.display(),
                reference.workdir.display()
            )
        })?
        .to_path_buf();
    let options = options(reference);
    let index = build_history_index(&reference.workdir, &options).map_err(|e| format!("the history walk: {e}"))?;
    let blame = PerFunctionBlame::open(&reference.workdir, options).map_err(|e| format!("blame: {e}"))?;
    let blame = Arc::new(blame);
    let repo = gix::open(&reference.workdir)
        .map_err(|e| format!("{}: {e}", reference.workdir.display()))?
        .into_sync();
    let commit = gix::ObjectId::from_hex(reference.commit.as_bytes()).map_err(|e| e.to_string())?;

    let next = AtomicUsize::new(0);
    let results: Mutex<BTreeMap<usize, FileHistory>> = Mutex::new(BTreeMap::new());
    std::thread::scope(|scope| {
        for _ in 0..jobs.clamp(1, work.len().max(1)) {
            scope.spawn(|| {
                let mut session = blame.session();
                let repo = repo.to_thread_local();
                let tree = repo.find_commit(commit).ok().and_then(|c| c.tree().ok());
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some((path, targets)) = work.get(i) else { break };
                    let relative = prefix.join(path);
                    let absolute = reference.workdir.join(&relative);
                    let mut history = FileHistory {
                        path: path.clone(),
                        file: index.get(&relative).cloned(),
                        entities: Vec::new(),
                        skipped: None,
                    };
                    let at_reference = tree.as_ref().and_then(|tree| blob(tree, &relative));
                    history.skipped = match at_reference {
                        None => Some(Skipped::Untracked),
                        Some(bytes) if std::fs::read(&absolute).ok().as_deref() != Some(bytes.as_slice()) => {
                            Some(Skipped::Differs)
                        }
                        Some(_) => {
                            let spans: Vec<LineSpan> = targets.iter().map(|t| LineSpan::new(t.start, t.end)).collect();
                            match session.per_function(&absolute, &spans) {
                                Ok(stats) => {
                                    history.entities = targets.iter().map(|t| t.entity).zip(stats).collect();
                                    None
                                }
                                Err(_) => Some(Skipped::Failed),
                            }
                        }
                    };
                    results.lock().expect("a worker panicked").insert(i, history);
                }
            });
        }
    });
    Ok(results.into_inner().expect("a worker panicked").into_values().collect())
}

/// An entity's natural key (contract §2), the side-car's identity for it.
pub struct Key {
    pub module: String,
    pub symbol: String,
    pub disambiguator: Option<String>,
}

/// What the side-car's header says about where and when it measured.
pub struct Provenance<'a> {
    pub lang: &'a str,
    pub root: Option<&'a str>,
    pub reference: &'a Reference,
}

/// The history walk's per-file measures, by side-car key.
fn file_values(s: &Stats) -> Vec<(&'static str, f64)> {
    vec![
        ("age_days", f64::from(s.age_days)),
        ("authors_long", f64::from(s.authors_long)),
        ("authors_recent", f64::from(s.authors_recent)),
        ("bug_fix_commits", f64::from(s.bug_fix_commits)),
        ("burst", s.burst),
        ("change_entropy_long", s.change_entropy_long),
        ("change_entropy_recent", s.change_entropy_recent),
        ("churn_long", s.churn_long as f64),
        ("churn_recent", s.churn_recent as f64),
        ("cochange_entropy_long", s.cochange_entropy_long),
        ("cochange_entropy_recent", s.cochange_entropy_recent),
        ("commits_long", f64::from(s.commits_long)),
        ("commits_recent", f64::from(s.commits_recent)),
        ("last_modified_days", f64::from(s.last_modified_days)),
        ("ownership_top_share", s.ownership_top_share),
        ("revert_commits", f64::from(s.revert_commits)),
        ("risk_score", s.risk_score),
        ("security_fix_commits", f64::from(s.security_fix_commits)),
    ]
}

/// Blame's per-entity measures. Blame counts SURVIVING lines, not added +
/// deleted, so its churn is named `lines_*` here: the two are never one key.
fn entity_values(s: &Stats) -> Vec<(&'static str, f64)> {
    vec![
        ("age_days", f64::from(s.age_days)),
        ("authors_long", f64::from(s.authors_long)),
        ("authors_recent", f64::from(s.authors_recent)),
        ("bug_fix_commits", f64::from(s.bug_fix_commits)),
        ("burst", s.burst),
        ("commits_long", f64::from(s.commits_long)),
        ("commits_recent", f64::from(s.commits_recent)),
        ("last_modified_days", f64::from(s.last_modified_days)),
        ("lines_long", s.churn_long as f64),
        ("lines_recent", s.churn_recent as f64),
        ("ownership_top_share", s.ownership_top_share),
        ("revert_commits", f64::from(s.revert_commits)),
        ("risk_score", s.risk_score),
        ("security_fix_commits", f64::from(s.security_fix_commits)),
    ]
}

/// `{"k":v,…}`, keys in the order given (already sorted), non-finite omitted.
fn map(values: &[(&'static str, f64)]) -> String {
    let body: Vec<String> = values
        .iter()
        .filter_map(|(key, value)| crate::number::measure(*value).map(|v| format!("\"{key}\":{v}")))
        .collect();
    format!("{{{}}}", body.join(","))
}

fn string(text: &str) -> String {
    serde_json::to_string(text).expect("a string always encodes")
}

/// JavaScript's string order: by UTF-16 code unit.
fn utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The side-car: a header, one `f` record per file the walk measured (by
/// path), one `e` record per blamed entity (in canonical natural-key order:
/// module, symbol, then disambiguator with the absent one first), an `eof`
/// with the counts. Returns `(files, entities)`.
pub fn write(
    sink: &mut impl std::io::Write,
    provenance: &Provenance<'_>,
    histories: &[FileHistory],
    keys: &std::collections::HashMap<u32, Key>,
) -> std::io::Result<(usize, usize)> {
    let options = options(provenance.reference);
    let root = provenance
        .root
        .map(|r| format!(",\"root\":{}", string(r)))
        .unwrap_or_default();
    writeln!(
        sink,
        "{{\"t\":\"header\",\"kind\":\"codegraph.history-metrics/1\",\"generatedBy\":{{\"name\":\"codegraph-metrics\",\"version\":{},\"bigCodeAnalysis\":{}}},\"lang\":{}{root},\"commit\":{},\"asOf\":{},\"windowDays\":{{\"long\":{},\"recent\":{}}}}}",
        string(env!("CARGO_PKG_VERSION")),
        string(big_code_analysis::VERSION),
        string(provenance.lang),
        string(&provenance.reference.commit),
        provenance.reference.time,
        options.long_window_days(),
        options.recent_window_days(),
    )?;

    let mut files: Vec<(&str, &Stats)> = histories
        .iter()
        .filter_map(|h| h.file.as_ref().map(|s| (h.path.as_str(), s)))
        .collect();
    files.sort_by(|a, b| utf16(a.0, b.0));
    for (path, stats) in &files {
        writeln!(
            sink,
            "{{\"t\":\"f\",\"path\":{},\"vcs\":{}}}",
            string(path),
            map(&file_values(stats))
        )?;
    }

    let mut entities: Vec<(&Key, &Stats)> = histories
        .iter()
        .flat_map(|h| h.entities.iter())
        .filter_map(|(entity, stats)| keys.get(entity).map(|key| (key, stats)))
        .collect();
    entities.sort_by(|(a, _), (b, _)| {
        utf16(&a.module, &b.module)
            .then_with(|| utf16(&a.symbol, &b.symbol))
            .then_with(|| match (&a.disambiguator, &b.disambiguator) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Less,
                (Some(_), None) => std::cmp::Ordering::Greater,
                (Some(x), Some(y)) => utf16(x, y),
            })
    });
    for (key, stats) in &entities {
        let disambiguator = key
            .disambiguator
            .as_deref()
            .map(|d| format!(",\"disambiguator\":{}", string(d)))
            .unwrap_or_default();
        writeln!(
            sink,
            "{{\"t\":\"e\",\"key\":{{\"lang\":{},\"module\":{},\"symbol\":{}{disambiguator}}},\"vcs\":{}}}",
            string(provenance.lang),
            string(&key.module),
            string(&key.symbol),
            map(&entity_values(stats)),
        )?;
    }
    writeln!(
        sink,
        "{{\"t\":\"eof\",\"counts\":{{\"files\":{},\"entities\":{}}}}}",
        files.len(),
        entities.len()
    )?;
    Ok((files.len(), entities.len()))
}

/// The bytes of `path` in `tree`, if it names a blob there.
fn blob(tree: &gix::Tree<'_>, path: &Path) -> Option<Vec<u8>> {
    let entry = tree.lookup_entry_by_path(path).ok()??;
    let object = entry.object().ok()?;
    (object.kind == gix::object::Kind::Blob).then(|| object.detach().data)
}
