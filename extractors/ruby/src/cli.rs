//! The extractor as a program (schemas/README.md §8): argv in, exit code out,
//! every byte through an injected `Io`. `stdout` carries nothing but
//! `--help`/`--version`; progress and the resolution summary go to `stderr`,
//! so a redirected run is byte-identical to a silent one.

use crate::corpus;
use crate::extraction;
use crate::trace;
use crate::writer;
use crate::{NAME, VERSION};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
/// An extraction pass not implemented yet — part of the contract, unused by this extractor.
pub const EXIT_UNIMPLEMENTED: i32 = 3;

pub struct Io<'a> {
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
    /// Decides whether `--progress auto` prints.
    pub stderr_terminal: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    Auto,
    Plain,
    None,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub sources: Vec<String>,
    pub out: String,
    pub progress: Progress,
    /// `--repo-*`, in the header's key order; absent when none was given.
    pub repository: Option<Vec<(&'static str, String)>>,
    /// List every dropped site on stderr.
    pub explain_dropped: bool,
    /// What `trace/codegraph_trace.rb` wrote inside the running program.
    pub trace: Option<String>,
    pub help: bool,
    pub version: bool,
}

const VALUE_FLAGS: &[&str] = &[
    "--src",
    "--out",
    "--progress",
    "--trace",
    "--repo-remote",
    "--repo-commit",
    "--repo-root",
    "--repo-provider",
];

pub fn parse(argv: &[String], cwd: &Path) -> Result<Options, String> {
    let mut sources = Vec::new();
    let mut out = None;
    let mut progress = Progress::Auto;
    let (mut remote, mut commit, mut root, mut provider) = (None, None, None, None);
    let (mut help, mut version, mut explain_dropped) = (false, false, false);
    let mut trace = None;

    let mut args = argv.iter();
    while let Some(flag) = args.next() {
        if VALUE_FLAGS.contains(&flag.as_str()) {
            let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?.clone();
            match flag.as_str() {
                "--src" => sources.push(value),
                "--out" => out = Some(value),
                "--progress" => {
                    progress = match value.as_str() {
                        "auto" => Progress::Auto,
                        "plain" => Progress::Plain,
                        "none" => Progress::None,
                        other => return Err(format!("--progress must be auto, plain or none, got: {other}")),
                    }
                }
                "--trace" => trace = Some(value),
                "--repo-remote" => remote = Some(value),
                "--repo-commit" => commit = Some(value),
                "--repo-root" => root = Some(value),
                _ => provider = Some(value),
            }
            continue;
        }
        match flag.as_str() {
            "--no-progress" => progress = Progress::None,
            "--explain-dropped" => explain_dropped = true,
            "--help" | "-h" => help = true,
            "--version" => version = true,
            other => return Err(format!("unknown option: {other}")),
        }
    }

    let repository = repository(remote, commit, root, provider)?;
    if sources.is_empty() {
        sources.push(".".to_owned());
    }
    let out = out.unwrap_or_else(|| {
        let name = cwd
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!("{name}-codegraph.jsonl")
    });
    Ok(Options {
        sources,
        out,
        progress,
        repository,
        explain_dropped,
        trace,
        help,
        version,
    })
}

/// `--repo-remote`, `--repo-commit` and `--repo-root` go together; copied
/// verbatim into the header after a shape check — the extractor invents nothing.
fn repository(
    remote: Option<String>,
    commit: Option<String>,
    root: Option<String>,
    provider: Option<String>,
) -> Result<Option<Vec<(&'static str, String)>>, String> {
    if remote.is_none() && commit.is_none() && root.is_none() && provider.is_none() {
        return Ok(None);
    }
    let (Some(remote), Some(commit), Some(root)) = (remote, commit, root) else {
        return Err(
            "--repo-remote, --repo-commit and --repo-root go together (--repo-provider is optional)".to_owned(),
        );
    };
    let clean = |text: &str| !text.chars().any(|c| c.is_whitespace() || c == '?' || c == '#');
    let https = remote
        .strip_prefix("https://")
        .is_some_and(|rest| !rest.is_empty() && clean(&remote) && !remote.ends_with('/') && !remote.ends_with(".git"));
    if !https {
        return Err(format!(
            "--repo-remote must be a normalized https URL (no ssh form, no .git): {remote}"
        ));
    }
    let sha =
        (7..=64).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !sha {
        return Err(format!("--repo-commit must be a lowercase hex sha: {commit}"));
    }
    let relative = root.is_empty()
        || root
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != ".." && !s.chars().any(char::is_whitespace));
    if !relative {
        return Err(format!(
            "--repo-root must be a path relative to the repository root: {root}"
        ));
    }
    let mut repository = vec![("remote", remote), ("commit", commit), ("root", root)];
    if let Some(provider) = provider {
        if provider != "github" && provider != "gitlab" {
            return Err(format!("--repo-provider must be github or gitlab, got: {provider}"));
        }
        repository.push(("provider", provider));
    }
    Ok(Some(repository))
}

pub fn usage() -> String {
    format!(
        "{NAME} {VERSION} — Ruby extractor on Prism, CRuby's own parser

USAGE
  {NAME} [--src <dir>…] [--out <file>]

OPTIONS
  --src <dir>           source root to analyze; repeatable. Default: the current
                        directory. With several roots, anchors are relative to
                        their deepest common ancestor, which becomes the model's root.
  --out <file>          where to write the model. Default: <current-dir>-codegraph.jsonl
  --progress <mode>     auto (default: one line per phase on a terminal, nothing
                        when piped), plain, or none
  --no-progress         same as --progress none
  --explain-dropped     list every drop on stderr, in source order, as
                        `dropped <reason>: <file>:<line> <what>`; the model is unchanged
  --trace <file>        merge what trace/codegraph_trace.rb wrote inside the running
                        program: the mixins no line writes become `generated` edges,
                        the calls it saw at sites left untyped `dynamic-candidate`
                        ones. No entity is added and no edge of the source changes.
  --repo-remote <url>   normalized https clone URL, no .git suffix
  --repo-commit <sha>   the sha this tree is at — a permalink, not a branch
  --repo-root <path>    repo-relative path of the analyzed root (\"\" at the repo root)
  --repo-provider <p>   github or gitlab, only when the hostname does not say
  --version             print the extractor version
  --help                this text

Nothing is run and no Ruby is needed: every *.rb, *.rake, *.gemspec and *.ru
under the roots, and Rakefile, Gemfile and their kin (vendor, node_modules, tmp
and dot-directories excluded), is parsed with Prism; constants resolve through
a lexical scope against what the corpus declares and an embedded table of what
the VM defines; a type the corpus does not declare is a stub. Exit codes: 0 ok,
1 failure, 2 usage, 3 unimplemented.
"
    )
}

/// Runs the extractor; returns the exit code.
pub fn run(argv: &[String], io: &mut Io<'_>, cwd: &Path) -> i32 {
    let options = match parse(argv, cwd) {
        Ok(options) => options,
        Err(message) => {
            let _ = write!(io.stderr, "error: {message}\n\n{}", usage());
            return EXIT_USAGE;
        }
    };
    if options.help {
        let _ = write!(io.stdout, "{}", usage());
        return EXIT_OK;
    }
    if options.version {
        let _ = writeln!(io.stdout, "{VERSION}");
        return EXIT_OK;
    }
    match extract(&options, io, cwd) {
        Ok(()) => EXIT_OK,
        Err(message) => {
            let _ = writeln!(io.stderr, "error: {message}");
            EXIT_FAILURE
        }
    }
}

fn extract(options: &Options, io: &mut Io<'_>, cwd: &Path) -> Result<(), String> {
    let show = match options.progress {
        Progress::Auto => io.stderr_terminal,
        Progress::Plain => true,
        Progress::None => false,
    };
    let mut clock = Instant::now();
    let mut phase = |stderr: &mut dyn Write, label: &str, detail: String| {
        if show {
            let _ = writeln!(stderr, "✓ {label:<11} {detail}  {:.1}s", clock.elapsed().as_secs_f64());
        }
        clock = Instant::now();
    };

    let corpus = corpus::load(&options.sources, cwd)?;
    phase(&mut *io.stderr, "walk", format!("{} files", corpus.files.len()));

    let trace = match &options.trace {
        Some(path) => {
            let text = std::fs::read_to_string(corpus::absolute(path, cwd))
                .map_err(|e| format!("cannot read the trace {path}: {e}"))?;
            Some(trace::parse(&text).map_err(|message| format!("{path}: {message}"))?)
        }
        None => None,
    };
    let extraction = extraction::extract(
        &corpus,
        options.repository.clone(),
        options.explain_dropped,
        trace.as_ref(),
        &mut |label, detail| phase(&mut *io.stderr, label, detail),
    );

    let path = corpus::absolute(&options.out, cwd);
    let file = File::create(&path).map_err(|e| format!("cannot write {}: {e}", options.out))?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    let counts = writer::write(&extraction.model, &mut out).map_err(|e| e.to_string())?;
    phase(&mut *io.stderr, "write", format!("{} records", counts.records()));

    for line in &extraction.stats.explained {
        let _ = writeln!(io.stderr, "dropped {line}");
    }
    for (path, errors) in &extraction.stats.with_errors {
        let _ = writeln!(io.stderr, "syntax errors (recovered, {errors}): {path}");
    }
    let _ = write!(io.stderr, "{}", extraction.stats.summary());
    let _ = writeln!(io.stderr, "wrote {}", options.out);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &[&str]) -> Vec<String> {
        text.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn defaults_to_the_current_directory_and_names_the_output_after_it() {
        let options = parse(&[], Path::new("/work/acme")).unwrap();
        assert_eq!(options.sources, vec!["."]);
        assert_eq!(options.out, "acme-codegraph.jsonl");
        assert_eq!(options.progress, Progress::Auto);
        assert_eq!(options.repository, None);
    }

    #[test]
    fn reads_every_flag_of_the_contract() {
        let options = parse(
            &args(&[
                "--src",
                "app",
                "--src",
                "lib",
                "--out",
                "m.jsonl",
                "--progress",
                "plain",
                "--repo-remote",
                "https://github.com/acme/order",
                "--repo-commit",
                "0123abc",
                "--repo-root",
                "",
                "--repo-provider",
                "github",
            ]),
            Path::new("/w"),
        )
        .unwrap();
        assert_eq!(options.sources, vec!["app", "lib"]);
        assert_eq!(options.out, "m.jsonl");
        assert_eq!(options.progress, Progress::Plain);
        assert_eq!(
            options.repository,
            Some(vec![
                ("remote", "https://github.com/acme/order".to_owned()),
                ("commit", "0123abc".to_owned()),
                ("root", String::new()),
                ("provider", "github".to_owned()),
            ])
        );
        assert_eq!(
            parse(&args(&["--no-progress"]), Path::new("/w")).unwrap().progress,
            Progress::None
        );
    }

    #[test]
    fn refuses_what_the_contract_refuses() {
        let cwd = Path::new("/w");
        let error = |text: &[&str]| parse(&args(text), cwd).unwrap_err();
        assert_eq!(error(&["--src"]), "--src needs a value");
        assert_eq!(error(&["--wat"]), "unknown option: --wat");
        assert_eq!(
            error(&["--progress", "loud"]),
            "--progress must be auto, plain or none, got: loud"
        );
        assert!(error(&["--repo-remote", "https://github.com/a/b"]).contains("go together"));
        let repo = |remote: &str, commit: &str, root: &str| {
            parse(
                &args(&["--repo-remote", remote, "--repo-commit", commit, "--repo-root", root]),
                cwd,
            )
        };
        assert!(
            repo("git@github.com:a/b", "0123abc", "")
                .unwrap_err()
                .contains("--repo-remote")
        );
        assert!(
            repo("https://github.com/a/b.git", "0123abc", "")
                .unwrap_err()
                .contains("--repo-remote")
        );
        assert!(
            repo("https://github.com/a/b/", "0123abc", "")
                .unwrap_err()
                .contains("--repo-remote")
        );
        assert!(
            repo("https://github.com/a/b", "0123ABC", "")
                .unwrap_err()
                .contains("--repo-commit")
        );
        assert!(
            repo("https://github.com/a/b", "0123ab", "")
                .unwrap_err()
                .contains("--repo-commit")
        );
        assert!(
            repo("https://github.com/a/b", "0123abc", "../x")
                .unwrap_err()
                .contains("--repo-root")
        );
        assert!(
            repo("https://github.com/a/b", "0123abc", "/abs")
                .unwrap_err()
                .contains("--repo-root")
        );
        assert!(repo("https://github.com/a/b", "0123abc", "services/order").is_ok());
    }
}
