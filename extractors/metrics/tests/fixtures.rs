//! The four fixture models, enriched: the binary must reproduce each committed
//! `fixtures/<lang>/expected/model.metrics.jsonl` byte for byte — the gate
//! `test.sh` holds every extractor to, replayed for this pass — and a second
//! run over its own output must change nothing.
//!
//! `CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test` rewrites the snapshots (after an
//! extractor's fixture moved, or a deliberate change to this pass).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn run(args: &[&std::ffi::OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_codegraph-metrics"))
        .args(args)
        .output()
        .expect("the binary runs")
}

fn enrich(lang: &str) {
    let fixture = repo().join("fixtures").join(lang);
    let expected = fixture.join("expected/model.metrics.jsonl");
    let out = std::env::temp_dir().join(format!("codegraph-metrics-{lang}-{}.jsonl", std::process::id()));
    let model = fixture.join("expected/model.jsonl");
    let src = fixture.join("src");
    let first = run(&[model.as_os_str(), "--src".as_ref(), src.as_os_str(), "--out".as_ref(), out.as_os_str()]);
    assert!(first.status.success(), "{lang}: {}", String::from_utf8_lossy(&first.stderr));
    let got = std::fs::read(&out).expect("the output was written");

    let again = run(&[out.as_os_str(), "--src".as_ref(), src.as_os_str()]);
    assert!(again.status.success(), "{lang}: {}", String::from_utf8_lossy(&again.stderr));
    let twice = std::fs::read(&out).expect("the output was rewritten in place");
    std::fs::remove_file(&out).ok();
    assert!(got == twice, "{lang}: a second run over its own output changed it");

    if std::env::var_os("CODEGRAPH_UPDATE_SNAPSHOTS").is_some() {
        std::fs::write(&expected, &got).expect("the snapshot is writable");
        return;
    }
    let want = std::fs::read(&expected)
        .unwrap_or_else(|_| panic!("{} is missing: CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test", expected.display()));
    assert!(
        got == want,
        "{lang}: the enriched fixture differs from {} — if intended, CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test and review the diff",
        expected.display()
    );
}

#[test]
fn java() {
    enrich("java");
}

#[test]
fn csharp() {
    enrich("csharp");
}

#[test]
fn typescript() {
    enrich("typescript");
}

#[test]
fn elixir() {
    enrich("elixir");
}

#[test]
fn exit_codes_follow_the_extractor_contract() {
    let usage = run(&["--no-such-flag".as_ref()]);
    assert_eq!(usage.status.code(), Some(2));
    let missing = run(&["/nonexistent/model.jsonl".as_ref()]);
    assert_eq!(missing.status.code(), Some(1));
    let version = run(&["--version".as_ref()]);
    assert!(version.status.success());
    let text = String::from_utf8_lossy(&version.stdout);
    assert!(text.starts_with("codegraph-metrics ") && text.contains("big-code-analysis 2.2.0"), "{text}");
}
