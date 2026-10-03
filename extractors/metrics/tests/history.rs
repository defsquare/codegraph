//! `--history` over a repository built here, commit by commit, with pinned
//! authors and dates — so every number below is countable by hand, and the
//! test needs no history from the repository it runs in (CI clones shallow).
//!
//!   c1  2026-01-10  alice  feat: shop          Shop.java, add + sub
//!   c2  2026-05-01  bob    fix: add overflow   add's body (line 5)
//!   c3  2026-05-20  carol  feat: sub twice     sub's body (line 9), on a branch
//!   c4  2026-05-21  alice  merge of the branch — the reference, HEAD
//!
//! Windows count back from c4's time: long 365 days (all four), recent 90
//! days (from 2026-02-20: c2 and c3, not c1). Merge commits are no change.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

const V1: &str = "\
package com.acme;

public class Shop {
    public int add(int a) {
        return a + 1;
    }

    public int sub(int a) {
        return a - 1;
    }
}
";

/// A model of `Shop.java`, as an extractor anchors it — validate-clean, and
/// shared with the CLI's history tests, which join the side-car back to it.
const MODEL: &str = include_str!("../../../fixtures/history-metrics/model.jsonl");

fn git(repo: &Path, who: &str, date: &str, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(repo)
        .args(args)
        // Isolated from the machine's git configuration: no hooks, no signing.
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", who)
        .env("GIT_AUTHOR_EMAIL", format!("{who}@example.com"))
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_NAME", who)
        .env("GIT_COMMITTER_EMAIL", format!("{who}@example.com"))
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .expect("git is installed");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Builds the repository of the module comment; returns it and the model path.
/// `tag` keeps tests running in parallel out of each other's way.
fn repository(tag: &str) -> (PathBuf, PathBuf) {
    let repo = std::env::temp_dir().join(format!("codegraph-metrics-history-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo);
    let file = repo.join("src/com/acme/Shop.java");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let edit = |from: &str, to: &str| {
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, text.replace(from, to)).unwrap();
    };
    git(&repo, "alice", "2026-01-10T10:00:00Z", &["init", "-q", "-b", "main"]);
    std::fs::write(&file, V1).unwrap();
    git(&repo, "alice", "2026-01-10T10:00:00Z", &["add", "."]);
    git(
        &repo,
        "alice",
        "2026-01-10T10:00:00Z",
        &["commit", "-q", "-m", "feat: shop"],
    );
    edit("a + 1", "a + 2");
    git(
        &repo,
        "bob",
        "2026-05-01T10:00:00Z",
        &["commit", "-q", "-am", "fix: add overflow"],
    );
    git(
        &repo,
        "carol",
        "2026-05-20T10:00:00Z",
        &["checkout", "-q", "-b", "twice"],
    );
    edit("a - 1", "a - 2");
    git(
        &repo,
        "carol",
        "2026-05-20T10:00:00Z",
        &["commit", "-q", "-am", "feat: sub twice"],
    );
    git(&repo, "alice", "2026-05-21T10:00:00Z", &["checkout", "-q", "main"]);
    git(
        &repo,
        "alice",
        "2026-05-21T10:00:00Z",
        &["merge", "-q", "--no-ff", "twice", "-m", "Merge branch twice"],
    );
    let model = repo.join("model.jsonl");
    std::fs::write(&model, MODEL).unwrap();
    (repo, model)
}

fn run(model: &Path, extra: &[&str]) -> std::process::Output {
    let repo = model.parent().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_codegraph-metrics"))
        .arg(model)
        .args(["--src".as_ref(), repo.join("src").as_os_str()])
        .arg("--history")
        .args(extra)
        .output()
        .expect("the binary runs");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    output
}

fn records(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn entity<'r>(records: &'r [Value], symbol: &str) -> Option<&'r Value> {
    records
        .iter()
        .find(|r| r["t"] == "e" && r["key"]["symbol"] == symbol)
        .map(|r| &r["vcs"])
}

#[test]
fn history_per_file_and_per_entity_is_countable_by_hand() {
    let (repo, model) = repository("counts");
    run(&model, &[]);
    let sidecar = repo.join("model.history-metrics.jsonl");
    let lines = records(&sidecar);

    let header = &lines[0];
    assert_eq!(header["kind"], "codegraph.history-metrics/1");
    assert_eq!(
        header["commit"],
        git(&repo, "alice", "2026-05-21T10:00:00Z", &["rev-parse", "HEAD"])
    );
    assert_eq!(
        header["asOf"], 1_779_357_600,
        "c4's committer time, never the wall clock"
    );
    assert_eq!(header["windowDays"]["recent"], 90);

    // The file: c1 adds 11 lines, c2 and c3 each replace one (1 + 1); the
    // merge counts for nothing. Three authors over the year, two recently.
    let file = &lines[1];
    assert_eq!(file["path"], "com/acme/Shop.java");
    assert_eq!(file["vcs"]["commits_long"], 3);
    assert_eq!(file["vcs"]["commits_recent"], 2);
    assert_eq!(file["vcs"]["churn_long"], 15);
    assert_eq!(file["vcs"]["churn_recent"], 4);
    assert_eq!(file["vcs"]["authors_long"], 3);
    assert_eq!(file["vcs"]["bug_fix_commits"], 1);

    // Blame: add's three lines are c1's, c2's, c1's.
    let add = entity(&lines, "Shop.add(int)").expect("add is blamed");
    assert_eq!(add["commits_long"], 2);
    assert_eq!(add["commits_recent"], 1);
    assert_eq!(add["lines_long"], 3);
    assert_eq!(add["lines_recent"], 1);
    assert_eq!(add["authors_long"], 2);
    assert_eq!(add["bug_fix_commits"], 1);
    // sub's middle line is the branch's — reached through the merge.
    let sub = entity(&lines, "Shop.sub(int)").expect("sub is blamed");
    assert_eq!(sub["commits_long"], 2);
    assert_eq!(sub["bug_fix_commits"], 0);
    let shop = entity(&lines, "Shop").expect("the class is blamed");
    assert_eq!(shop["commits_long"], 3);
    assert_eq!(shop["authors_long"], 3);
    assert!(
        entity(&lines, "com.acme").is_none(),
        "a package has no anchor, so no blame"
    );

    // Byte-determinism: the same repository, the same bytes — down to the
    // commit ids, since authors, dates and messages are pinned. The committed
    // copy is what @codegraph/scm's codec is checked against.
    let first = std::fs::read(&sidecar).unwrap();
    run(&model, &[]);
    assert_eq!(std::fs::read(&sidecar).unwrap(), first);
    let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/history-metrics/expected/model.history-metrics.jsonl");
    if std::env::var_os("CODEGRAPH_UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(expected.parent().unwrap()).unwrap();
        std::fs::write(&expected, &first).unwrap();
    }
    let want = std::fs::read(&expected).expect("the snapshot exists: CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test");
    assert!(first == want, "the side-car differs from {}", expected.display());

    // Pinned to c2 by `--ref`: the branch does not exist yet.
    let c2 = git(&repo, "alice", "2026-05-21T10:00:00Z", &["rev-parse", "HEAD~1"]);
    let pinned = repo.join("pinned.jsonl");
    run(&model, &["--ref", &c2, "--history-out", pinned.to_str().unwrap()]);
    let at_c2 = records(&pinned);
    assert_eq!(at_c2[0]["commit"], c2);
    assert_eq!(at_c2[1]["vcs"]["commits_long"], 2);
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn a_file_edited_since_the_commit_keeps_its_file_record_and_loses_its_entities() {
    let (repo, model) = repository("edited");
    let file = repo.join("src/com/acme/Shop.java");
    let text = std::fs::read_to_string(&file).unwrap();
    std::fs::write(&file, format!("// uncommitted\n{text}")).unwrap();
    let output = run(&model, &[]);
    let records = records(&repo.join("model.history-metrics.jsonl"));
    assert_eq!(records.iter().filter(|r| r["t"] == "f").count(), 1);
    assert_eq!(records.iter().filter(|r| r["t"] == "e").count(), 0);
    assert!(String::from_utf8_lossy(&output.stderr).contains("1 files differ"));
    std::fs::remove_dir_all(&repo).ok();
}
