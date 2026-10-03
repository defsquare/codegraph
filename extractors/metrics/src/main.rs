//! `codegraph-metrics`: big-code-analysis measures added to a codegraph
//! model, each joined to its entity on the entity's anchor (PLAN.md §18).
//!
//! A pass over a model, not an extractor: it reads what an extractor wrote,
//! parses every source file the measured entities are anchored in, and
//! rewrites the `metrics` map of those entities — nothing else in the file
//! moves. Its keys are its own (`join::KEYS`); the extractor's are never
//! touched, and a re-run replaces exactly what the previous run wrote.

mod history;
mod join;
mod model;
mod number;

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use join::{Join, KEYS, Measured};
use model::Measurable;

const USAGE: &str = "\
Usage: codegraph-metrics <model.jsonl> [--src <dir>] [--out <file>] [--jobs <n>] [--audit]
                         [--history [--history-out <file>] [--ref <rev>]]
       codegraph-metrics --version | --help | --licenses

Adds big-code-analysis measures (cognitive, nexits, abc.*, lloc, cloc,
halstead.*, mi, npm, npa) to the `metrics` map of every entity the model
measures, joined on the entity's anchor. The extractor's own keys are kept.

  --src <dir>    the directory the model's file paths are relative to
                 (default: the header's `root`, from the current directory)
  --out <file>   where to write (default: the model itself, replaced atomically)
  --jobs <n>     parser threads (default: the machine's parallelism)
  --audit        list, on stderr, every measured entity not joined exactly
  --history      also measure change history — per file from one git walk, per
                 measured entity from one blame per file — at the commit the
                 model describes (its `repository.commit`, else HEAD), clocked
                 at that commit's time. Written to a SIDE-CAR, never the model:
                 <out without .jsonl>.history-metrics.jsonl
  --history-out <file>
                 where the side-car goes instead
  --ref <rev>    the commit the history is measured at, overriding the header

Exit codes: 0 success, 1 failure, 2 bad usage.
";

struct Args {
    model: PathBuf,
    src: Option<PathBuf>,
    out: Option<PathBuf>,
    jobs: Option<usize>,
    audit: bool,
    history: bool,
    history_out: Option<PathBuf>,
    reference: Option<String>,
}

enum Command {
    Run(Args),
    Help,
    Version,
    Licenses,
}

/// Every linked crate, its license and the texts they ship (scripts/licenses.mjs):
/// big-code-analysis is MPL-2.0, which asks a binary to say where its source is.
const LICENSES: &str = include_str!("../THIRD-PARTY-LICENSES.txt");

fn parse(argv: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    let mut argv = argv.into_iter();
    let mut model = None;
    let (mut src, mut out, mut jobs, mut audit) = (None, None, None, false);
    let (mut history, mut history_out, mut reference) = (false, None, None);
    while let Some(arg) = argv.next() {
        let mut value = |flag: &str| argv.next().ok_or_else(|| format!("{flag} needs a value"));
        match arg.to_str() {
            Some("--help" | "-h") => return Ok(Command::Help),
            Some("--version") => return Ok(Command::Version),
            Some("--licenses") => return Ok(Command::Licenses),
            Some("--src") => src = Some(PathBuf::from(value("--src")?)),
            Some("--out") => out = Some(PathBuf::from(value("--out")?)),
            Some("--jobs") => {
                let n = value("--jobs")?;
                let n = n.to_str().and_then(|n| n.parse::<usize>().ok()).filter(|&n| n > 0);
                jobs = Some(n.ok_or("--jobs takes a positive integer")?);
            }
            Some("--audit") => audit = true,
            Some("--history") => history = true,
            Some("--history-out") => history_out = Some(PathBuf::from(value("--history-out")?)),
            Some("--ref") => {
                let rev = value("--ref")?;
                reference = Some(
                    rev.into_string()
                        .map_err(|_| "--ref takes a UTF-8 revision".to_owned())?,
                );
            }
            Some(flag) if flag.starts_with('-') => return Err(format!("unknown flag {flag}")),
            _ if model.is_none() => model = Some(PathBuf::from(arg)),
            _ => return Err("one model at a time".to_owned()),
        }
    }
    let model = model.ok_or("no model given")?;
    if (history_out.is_some() || reference.is_some()) && !history {
        return Err("--history-out and --ref need --history".to_owned());
    }
    Ok(Command::Run(Args {
        model,
        src,
        out,
        jobs,
        audit,
        history,
        history_out,
        reference,
    }))
}

fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1)) {
        Err(message) => {
            eprintln!("codegraph-metrics: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Ok(Command::Help) => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Command::Version) => {
            println!(
                "codegraph-metrics {} (big-code-analysis {})",
                env!("CARGO_PKG_VERSION"),
                big_code_analysis::VERSION
            );
            ExitCode::SUCCESS
        }
        Ok(Command::Licenses) => {
            print!("{LICENSES}");
            ExitCode::SUCCESS
        }
        Ok(Command::Run(args)) => match run(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("codegraph-metrics: {message}");
                ExitCode::from(1)
            }
        },
    }
}

/// One file's outcome.
enum Outcome {
    Measured(Vec<Measured>),
    /// Not readable at `--src`, or bca refused it.
    Failed(String),
}

fn run(args: &Args) -> Result<(), String> {
    let open = || {
        File::open(&args.model)
            .map(BufReader::new)
            .map_err(|e| format!("{}: {e}", args.model.display()))
    };
    let inventory = model::inventory(open()?)?;
    let src = args
        .src
        .clone()
        .or_else(|| inventory.root.as_ref().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));

    let mut by_file: BTreeMap<String, Vec<Measurable>> = BTreeMap::new();
    for m in &inventory.measurable {
        let path = inventory
            .files
            .get(m.file as usize)
            .ok_or_else(|| format!("anchor names file {}, which the model does not declare", m.file))?;
        by_file.entry(path.clone()).or_default().push(m.clone());
    }
    code_metrics(args, &inventory, &src, &by_file, &open)?;
    if args.history {
        history_metrics(args, &inventory, &src, &by_file)?;
    }
    Ok(())
}

type Opener<'a> = &'a dyn Fn() -> Result<BufReader<File>, String>;

/// The model rewritten with this pass's code measures.
fn code_metrics(
    args: &Args,
    inventory: &model::Inventory,
    src: &Path,
    by_file: &BTreeMap<String, Vec<Measurable>>,
    open: Opener<'_>,
) -> Result<(), String> {
    let mut work = Vec::new();
    let mut unmeasured_language = 0usize;
    for (path, targets) in by_file {
        match join::language(&inventory.lang, path) {
            Some(lang) => work.push((path.clone(), lang, targets.clone())),
            None => unmeasured_language += targets.len(),
        }
    }
    if work.is_empty() && unmeasured_language > 0 {
        eprintln!(
            "codegraph-metrics: `{}` is not a language this pass measures; the model is left as it is",
            inventory.lang
        );
        return Ok(());
    }

    let outcomes = measure_all(src, &work, args.jobs);

    let mut values: HashMap<u32, Vec<(&'static str, String)>> = HashMap::new();
    let mut tally = Tally::default();
    for ((path, _, targets), outcome) in work.iter().zip(&outcomes) {
        match outcome {
            Outcome::Failed(reason) => {
                tally.failed_files += 1;
                tally.failed_entities += targets.len();
                if tally.failed_files <= 5 {
                    eprintln!("codegraph-metrics: {path}: {reason}");
                }
            }
            Outcome::Measured(measured) => {
                tally.files += 1;
                for (m, target) in measured.iter().zip(targets) {
                    tally.count(m, target);
                    let disagrees = m.ploc.zip(target.sloc).filter(|(ploc, sloc)| ploc != sloc);
                    if args.audit && (m.join != Join::Exact || disagrees.is_some()) {
                        let mut note = disagrees
                            .map(|(ploc, sloc)| format!(" (sloc {sloc}, bca ploc {ploc})"))
                            .unwrap_or_default();
                        if target.implicit {
                            note.push_str(" (on its parent's anchor)");
                        }
                        eprintln!(
                            "  {:?} {:?} e{} {path}:{}-{}{note}",
                            m.join, target.category, m.entity, target.start, target.end
                        );
                    }
                    if !m.values.is_empty() {
                        values.insert(m.entity, m.values.clone());
                    }
                }
            }
        }
    }
    if tally.files == 0 && tally.failed_files > 0 {
        return Err(format!(
            "no source file could be read under {} — is --src the directory the model's paths are relative to?",
            src.display()
        ));
    }

    let out = args.out.clone().unwrap_or_else(|| args.model.clone());
    let changed = write_atomically(&out, |sink| {
        model::rewrite(open()?, sink, |entity, old| {
            merged(old, values.get(&entity).map(Vec::as_slice))
        })
    })?;
    eprintln!(
        "codegraph-metrics: {}; {changed} entities rewritten",
        tally.summary(inventory.declaring)
    );
    Ok(())
}

/// The side-car beside the written model: `X.jsonl` → `X.history-metrics.jsonl`.
fn sidecar_path(model: &Path) -> PathBuf {
    let name = model
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name.strip_suffix(".jsonl").unwrap_or(&name);
    model.with_file_name(format!("{stem}.history-metrics.jsonl"))
}

/// Change history at the model's commit, into the side-car (PLAN.md §18.2).
fn history_metrics(
    args: &Args,
    inventory: &model::Inventory,
    src: &Path,
    by_file: &BTreeMap<String, Vec<Measurable>>,
) -> Result<(), String> {
    let wanted = args.reference.as_deref().or(inventory.commit.as_deref());
    let reference = history::resolve(src, wanted)?;
    // An entity on its parent's anchor would only repeat its parent's blame.
    let work: Vec<(String, Vec<Measurable>)> = by_file
        .iter()
        .map(|(path, targets)| (path.clone(), targets.iter().filter(|t| !t.implicit).cloned().collect()))
        .collect();
    let histories = history::measure(&reference, src, &work, jobs(args.jobs, work.len()))?;
    let mut keys = HashMap::new();
    for m in &inventory.measurable {
        let module = inventory.modules.get(&m.module).ok_or_else(|| {
            format!(
                "entity {} names module {}, which is not a module record",
                m.entity, m.module
            )
        })?;
        let key = history::Key {
            module: module.clone(),
            symbol: m.symbol.clone(),
            disambiguator: m.disambiguator.clone(),
        };
        keys.insert(m.entity, key);
    }
    let provenance = history::Provenance {
        lang: &inventory.lang,
        root: inventory.root.as_deref(),
        reference: &reference,
    };
    let out = args
        .history_out
        .clone()
        .unwrap_or_else(|| sidecar_path(args.out.as_ref().unwrap_or(&args.model)));
    let (files, entities) = write_atomically(&out, |sink| {
        history::write(sink, &provenance, &histories, &keys).map_err(|e| e.to_string())
    })?;

    let skipped = |why: history::Skipped| histories.iter().filter(|h| h.skipped == Some(why)).count();
    let mut text = format!(
        "codegraph-metrics: history at {} (@{}): {files} files, {entities} entities blamed → {}",
        &reference.commit[..12.min(reference.commit.len())],
        reference.time,
        out.display()
    );
    for (why, label) in [
        (history::Skipped::Differs, "differ from that commit (file-level only)"),
        (history::Skipped::Untracked, "untracked"),
        (history::Skipped::Failed, "failed to blame"),
    ] {
        let n = skipped(why);
        if n > 0 {
            text.push_str(&format!("; {n} files {label}"));
        }
    }
    eprintln!("{text}");
    Ok(())
}

fn jobs(wanted: Option<usize>, work: usize) -> usize {
    wanted
        .or_else(|| std::thread::available_parallelism().ok().map(usize::from))
        .unwrap_or(1)
        .min(work.max(1))
}

/// Every file parsed once, on `jobs` threads; results in `work` order.
fn measure_all(
    src: &Path,
    work: &[(String, big_code_analysis::LANG, Vec<Measurable>)],
    wanted: Option<usize>,
) -> Vec<Outcome> {
    let jobs = jobs(wanted, work.len());
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Outcome>>> = Mutex::new((0..work.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..jobs {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some((path, lang, targets)) = work.get(i) else {
                        break;
                    };
                    let outcome = match std::fs::read(src.join(path)) {
                        Err(e) => Outcome::Failed(e.to_string()),
                        Ok(code) => match join::measure_file(*lang, &code, targets) {
                            Ok(measured) => Outcome::Measured(measured),
                            Err(e) => Outcome::Failed(e),
                        },
                    };
                    results.lock().expect("a worker panicked")[i] = Some(outcome);
                }
            });
        }
    });
    results
        .into_inner()
        .expect("a worker panicked")
        .into_iter()
        .map(|o| o.expect("every file visited"))
        .collect()
}

/// The entity's new `metrics` object: its old members minus this pass's
/// keys, plus `fresh`, key-sorted by UTF-16 code unit as core's encoder does.
fn merged(old: &str, fresh: Option<&[(&'static str, String)]>) -> Option<String> {
    let mut members: Vec<(String, String)> = model::members(old)?
        .into_iter()
        .filter(|(key, _)| !KEYS.contains(&key.as_str()))
        .map(|(key, raw)| (key, raw.to_owned()))
        .collect();
    for (key, value) in fresh.unwrap_or_default() {
        members.push(((*key).to_owned(), value.clone()));
    }
    members.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let body: Vec<String> = members
        .iter()
        .map(|(key, value)| {
            format!(
                "{}:{value}",
                serde_json::to_string(key).expect("a string always encodes")
            )
        })
        .collect();
    Some(format!("{{{}}}", body.join(",")))
}

/// Writes through a temporary sibling, renamed over `out` only on success.
fn write_atomically<T>(out: &Path, body: impl FnOnce(&mut BufWriter<File>) -> Result<T, String>) -> Result<T, String> {
    let name = out
        .file_name()
        .ok_or_else(|| format!("{}: not a file path", out.display()))?;
    let mut temp_name = name.to_os_string();
    temp_name.push(format!(".{}.tmp", std::process::id()));
    let temp = out.with_file_name(temp_name);
    let result = (|| {
        let mut sink = BufWriter::new(File::create(&temp).map_err(|e| format!("{}: {e}", temp.display()))?);
        let changed = body(&mut sink)?;
        sink.flush().map_err(|e| format!("{}: {e}", temp.display()))?;
        std::fs::rename(&temp, out).map_err(|e| format!("{}: {e}", out.display()))?;
        Ok(changed)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[derive(Default)]
struct Tally {
    files: usize,
    failed_files: usize,
    failed_entities: usize,
    exact: usize,
    leading: usize,
    contained: usize,
    ambiguous: usize,
    unjoined: usize,
    /// Exact joins whose bca `ploc` equals the extractor's `sloc`.
    sloc_agrees: usize,
    sloc_compared: usize,
}

impl Tally {
    fn count(&mut self, m: &Measured, target: &Measurable) {
        match m.join {
            Join::Exact => self.exact += 1,
            Join::Leading => self.leading += 1,
            Join::Contained => self.contained += 1,
            Join::Ambiguous => self.ambiguous += 1,
            Join::Unjoined => self.unjoined += 1,
        }
        if let (Some(ploc), Some(sloc)) = (m.ploc, target.sloc) {
            self.sloc_compared += 1;
            self.sloc_agrees += usize::from(ploc == sloc);
        }
    }

    fn summary(&self, declaring: usize) -> String {
        let joined = self.exact + self.leading + self.contained;
        let mut text = format!(
            "{joined} of {declaring} measured entities joined ({} exact, {} leading, {} contained; {} ambiguous, {} unjoined) over {} files",
            self.exact, self.leading, self.contained, self.ambiguous, self.unjoined, self.files
        );
        if self.sloc_compared > 0 {
            text.push_str(&format!(
                "; sloc = bca ploc on {} of {} exact joins",
                self.sloc_agrees, self.sloc_compared
            ));
        }
        if self.failed_files > 0 {
            text.push_str(&format!(
                "; {} files unread ({} entities)",
                self.failed_files, self.failed_entities
            ));
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::merged;

    #[test]
    fn keeps_the_extractor_keys_and_replaces_its_own() {
        let old = r#"{"cognitive":9,"cyclomatic":2,"lloc":1,"sloc":4}"#;
        let fresh = [("cognitive", "3".to_owned()), ("abc.branches", "1".to_owned())];
        assert_eq!(
            merged(old, Some(&fresh)).unwrap(),
            r#"{"abc.branches":1,"cognitive":3,"cyclomatic":2,"sloc":4}"#
        );
        // Nothing fresh: this pass's stale keys go, the extractor's stay byte for byte.
        assert_eq!(
            merged(r#"{"cognitive":9,"sloc":4.50}"#, None).unwrap(),
            r#"{"sloc":4.50}"#
        );
        assert_eq!(merged("{}", None).unwrap(), "{}");
    }
}
