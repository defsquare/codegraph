//! The extractor as a program, on the reference corpus: the committed
//! snapshot byte for byte, the same bytes whatever the checkout looks like,
//! and the command-line contract of schemas/README.md §8.
//!
//! `CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test` rewrites the snapshot — review
//! the diff before committing it.

use codegraph_ruby::cli::{self, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, Io};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FIXTURE: &str = "fixtures/ruby/src";

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

/// A fresh directory under Cargo's own temp dir, one per test.
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(args: &[&str], cwd: &Path) -> Run {
    let argv: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let code = {
        let mut io = Io {
            stdout: &mut stdout,
            stderr: &mut stderr,
            stderr_terminal: false,
        };
        cli::run(&argv, &mut io, cwd)
    };
    Run {
        code,
        stdout: String::from_utf8(stdout).unwrap(),
        stderr: String::from_utf8(stderr).unwrap(),
    }
}

fn extract(cwd: &Path, out: &Path) -> Vec<u8> {
    let run = run(&["--src", FIXTURE, "--out", out.to_str().unwrap()], cwd);
    assert_eq!(run.code, EXIT_OK, "{}", run.stderr);
    fs::read(out).expect("the model")
}

/// Copies the corpus, rewriting each file's bytes, in REVERSE name order.
fn copy_corpus(from: &Path, to: &Path, rewrite: &dyn Fn(Vec<u8>) -> Vec<u8>) {
    fs::create_dir_all(to).unwrap();
    let mut entries: Vec<PathBuf> = fs::read_dir(from).unwrap().map(|entry| entry.unwrap().path()).collect();
    entries.sort();
    entries.reverse();
    for path in entries {
        let target = to.join(path.file_name().unwrap());
        if path.is_dir() {
            copy_corpus(&path, &target, rewrite);
        } else {
            fs::write(&target, rewrite(fs::read(&path).unwrap())).unwrap();
        }
    }
}

/// The committed snapshot — rewritten first under CODEGRAPH_UPDATE_SNAPSHOTS, and
/// read through here by every test, so none races the one that writes it.
fn snapshot() -> &'static [u8] {
    static SNAPSHOT: OnceLock<Vec<u8>> = OnceLock::new();
    SNAPSHOT.get_or_init(|| {
        let root = repository();
        let path = root.join("fixtures/ruby/expected/model.jsonl");
        if std::env::var_os("CODEGRAPH_UPDATE_SNAPSHOTS").is_some() {
            let model = extract(&root, &scratch("update").join("model.jsonl"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, model).unwrap();
        }
        fs::read(&path).expect("fixtures/ruby/expected/model.jsonl (CODEGRAPH_UPDATE_SNAPSHOTS=1 writes it)")
    })
}

fn snapshot_text() -> &'static str {
    std::str::from_utf8(snapshot()).expect("the snapshot is UTF-8")
}

#[test]
fn the_fixture_corpus_reproduces_its_snapshot_byte_for_byte() {
    let expected = snapshot();
    let actual = extract(&repository(), &scratch("snapshot").join("model.jsonl"));
    assert!(
        actual == expected,
        "the model differs from fixtures/ruby/expected/model.jsonl — \
         CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test rewrites it once the diff is understood"
    );
}

#[test]
fn two_runs_write_the_same_bytes() {
    let root = repository();
    let dir = scratch("twice");
    assert!(extract(&root, &dir.join("a.jsonl")) == extract(&root, &dir.join("b.jsonl")));
}

#[test]
fn a_crlf_checkout_created_in_another_order_gives_the_same_model() {
    let root = repository();
    let dir = scratch("crlf");
    let crlf = |bytes: Vec<u8>| {
        let mut out = Vec::with_capacity(bytes.len() + 64);
        for byte in bytes {
            if byte == b'\n' {
                out.push(b'\r');
            }
            out.push(byte);
        }
        out
    };
    copy_corpus(&root.join(FIXTURE), &dir.join(FIXTURE), &crlf);
    let lf = extract(&root, &dir.join("lf.jsonl"));
    let windows = extract(&dir, &dir.join("crlf.jsonl"));
    assert!(lf == windows, "line endings or creation order changed the model");
}

#[test]
fn stdout_stays_empty_and_the_summary_goes_to_stderr() {
    let root = repository();
    let dir = scratch("streams");
    let out = dir.join("model.jsonl");
    let silent = run(&["--src", FIXTURE, "--out", out.to_str().unwrap()], &root);
    assert_eq!(silent.code, EXIT_OK);
    assert_eq!(silent.stdout, "");
    assert!(silent.stderr.contains("RESOLUTION SUMMARY"));
    assert!(
        silent
            .stderr
            .contains("syntax errors (recovered, 1): lib/acme_order/legacy/broken.rb")
    );
    // Not a terminal: `auto` prints no phase line; `plain` does.
    assert!(!silent.stderr.contains("✓ walk"));
    let plain = run(
        &["--src", FIXTURE, "--out", out.to_str().unwrap(), "--progress", "plain"],
        &root,
    );
    assert!(plain.stderr.contains("✓ walk"));
    assert_eq!(plain.stdout, "");
}

#[test]
fn help_and_version_are_the_only_things_on_stdout() {
    let cwd = repository();
    let version = run(&["--version"], &cwd);
    assert_eq!(
        (version.code, version.stdout.as_str(), version.stderr.as_str()),
        (EXIT_OK, concat!(env!("CARGO_PKG_VERSION"), "\n"), "")
    );
    let help = run(&["--help"], &cwd);
    assert_eq!(help.code, EXIT_OK);
    assert!(help.stdout.contains("--repo-remote"));
    assert_eq!(help.stderr, "");
}

#[test]
fn exits_2_on_bad_usage_and_1_on_a_root_that_is_not_there() {
    let cwd = repository();
    let usage = run(&["--frobnicate"], &cwd);
    assert_eq!(usage.code, EXIT_USAGE);
    assert!(usage.stderr.starts_with("error: unknown option: --frobnicate"));
    assert_eq!(usage.stdout, "");
    let missing = run(
        &["--src", "fixtures/ruby/no-such-directory", "--out", "unused.jsonl"],
        &cwd,
    );
    assert_eq!(missing.code, EXIT_FAILURE);
    assert!(missing.stderr.contains("source root is not a directory"));
    assert!(!cwd.join("unused.jsonl").exists());
}

#[test]
fn copies_the_repository_flags_into_the_header_verbatim() {
    let dir = scratch("repository");
    fs::write(dir.join("a.rb"), "class A; end\n").unwrap();
    let out = dir.join("model.jsonl");
    let run = run(
        &[
            "--src",
            ".",
            "--out",
            out.to_str().unwrap(),
            "--repo-remote",
            "https://github.com/acme/order",
            "--repo-commit",
            "0123abcdef",
            "--repo-root",
            "services/order",
        ],
        &dir,
    );
    assert_eq!(run.code, EXIT_OK, "{}", run.stderr);
    let model = fs::read_to_string(&out).unwrap();
    let header = model.lines().next().unwrap();
    assert!(
        header.contains(r#""root":".","repository":{"remote":"https://github.com/acme/order","commit":"0123abcdef","root":"services/order"},"dict":"#),
        "{header}"
    );
    // The model's own file is never walked back in: it is not a Ruby file.
    assert!(model.ends_with("{\"t\":\"eof\",\"counts\":{\"files\":1,\"entities\":2,\"edges\":0}}\n"));
}

#[test]
fn several_roots_are_anchored_at_their_common_ancestor() {
    let root = repository();
    let dir = scratch("roots");
    let out = dir.join("model.jsonl");
    let run = run(
        &[
            "--src",
            "fixtures/ruby/src/lib",
            "--src",
            "fixtures/ruby/src/spec",
            "--out",
            out.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(run.code, EXIT_OK, "{}", run.stderr);
    let model = fs::read_to_string(&out).unwrap();
    assert!(model.lines().next().unwrap().contains(r#""root":"fixtures/ruby/src""#));
    assert!(model.contains(r#"{"t":"f","i":0,"path":"lib/acme_order.rb"}"#));
    // Only what is under a root is walked: the Rakefile beside them is not.
    assert!(!model.contains("Rakefile"));
}

#[test]
fn the_header_names_the_parser_this_binary_was_built_with() {
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let pin = format!("ruby-prism = \"={}\"", codegraph_ruby::PRISM_VERSION);
    assert!(
        manifest.contains(&pin),
        "PRISM_VERSION must restate Cargo.toml's exact pin ({pin})"
    );
    let snapshot = snapshot_text();
    let header = snapshot.lines().next().unwrap();
    assert!(
        header.contains(&format!(r#""prism":"{}""#, codegraph_ruby::PRISM_VERSION)),
        "{header}"
    );
    assert!(header.contains(r#""rbs":"4.2.0""#), "{header}");
}

#[test]
fn walks_what_is_ruby_by_name_or_by_its_own_account_and_nothing_under_vendor() {
    let snapshot = snapshot_text();
    assert!(!snapshot.contains("VendoredAndIgnored"));
    assert!(!snapshot.contains("vendor/"));
    // The extensionless files Ruby itself names are walked…
    assert!(snapshot.contains(r#""path":"Rakefile""#));
    assert!(snapshot.contains(r#""path":"Gemfile""#));
    // …and so is a script whose first line says `ruby` — a shell script beside it is not.
    assert!(snapshot.contains(r#""path":"bin/console""#));
    assert!(!snapshot.contains("bin/setup"));
}

#[test]
fn lists_every_dropped_site_on_stderr_when_asked_and_changes_no_byte_of_the_model() {
    let root = repository();
    let dir = scratch("explain");
    let plain = extract(&root, &dir.join("plain.jsonl"));
    let out = dir.join("explained.jsonl");
    let explained = run(
        &["--src", FIXTURE, "--out", out.to_str().unwrap(), "--explain-dropped"],
        &root,
    );
    assert_eq!(explained.code, EXIT_OK, "{}", explained.stderr);
    assert!(
        explained
            .stderr
            .contains("dropped ambiguous-ancestor: lib/acme_order/record.rb:13 update!\n")
    );
    assert!(
        explained
            .stderr
            .contains("dropped untyped-receiver: lib/acme_order/pricing/standard.rb:5 sum\n")
    );
    assert!(
        explained
            .stderr
            .contains("dropped unbound-dynamic: lib/acme_order/dynamic.rb:32 vanish\n")
    );
    // What the walker and a type's header drop is listed too: a require, a superclass.
    assert!(
        explained
            .stderr
            .contains("dropped computed-require: lib/acme_order/dynamic.rb:5 require\n")
    );
    assert!(
        explained
            .stderr
            .contains("dropped not-a-type: lib/acme_order/dynamic.rb:23 HANDLERS\n")
    );
    // Every drop the summary counts is listed once, in the order of the source.
    let listed: Vec<&str> = explained
        .stderr
        .lines()
        .filter(|line| line.starts_with("dropped "))
        .collect();
    let counted: usize = explained
        .stderr
        .lines()
        .filter(|line| line.contains("(dropped)"))
        .filter_map(|line| line.rsplit(':').next()?.trim().parse::<usize>().ok())
        .sum();
    assert!(counted > 0, "{}", explained.stderr);
    assert_eq!(listed.len(), counted, "{}", explained.stderr);
    let lines_of = |file: &str| -> Vec<u32> {
        listed
            .iter()
            .filter_map(|line| line.split_once(": ")?.1.strip_prefix(file)?.strip_prefix(':'))
            .filter_map(|rest| rest.split(' ').next()?.parse().ok())
            .collect()
    };
    let dynamic = lines_of("lib/acme_order/dynamic.rb");
    assert_eq!(dynamic, [5, 5, 14, 17, 19, 23, 27, 31, 31, 32]);
    assert_eq!(explained.stdout, "");
    assert!(plain == fs::read(&out).unwrap());
}
