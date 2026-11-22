//! The extractor as a program, on the reference corpus: the committed
//! snapshot byte for byte, the same bytes whatever the checkout looks like,
//! and the command-line contract of schemas/README.md §8.
//!
//! `CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test` rewrites the snapshot — review
//! the diff before committing it.

use codegraph_python::cli::{self, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, Io};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FIXTURE: &str = "fixtures/python/src";

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
        let path = root.join("fixtures/python/expected/model.jsonl");
        if std::env::var_os("CODEGRAPH_UPDATE_SNAPSHOTS").is_some() {
            let model = extract(&root, &scratch("update").join("model.jsonl"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, model).unwrap();
        }
        fs::read(&path).expect("fixtures/python/expected/model.jsonl (CODEGRAPH_UPDATE_SNAPSHOTS=1 writes it)")
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
        "the model differs from fixtures/python/expected/model.jsonl — \
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
    // Every `\n` becomes `\r\n`; a lone `\r` stays one, and is one line ending as before.
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
    // The recovered files are named, and so are the ones decoded from another encoding.
    assert!(
        silent.stderr.contains("syntax errors (recovered, "),
        "{}",
        silent.stderr
    );
    assert!(
        silent.stderr.contains("): src/acme_order/legacy/broken.py\n"),
        "{}",
        silent.stderr
    );
    assert!(
        silent.stderr.contains("): src/acme_order/legacy/report.py\n"),
        "{}",
        silent.stderr
    );
    assert!(
        silent
            .stderr
            .contains("decoded (not UTF-8, 2): src/acme_order/legacy/latin.py (iso-8859-1)\n"),
        "{}",
        silent.stderr
    );
    // A BOM is UTF-8: not named.
    assert!(!silent.stderr.contains("bom.py"), "{}", silent.stderr);
    // Not a terminal: `auto` prints no phase line; `plain` does.
    assert!(!silent.stderr.contains("✓ walk"));
    let plain = run(
        &["--src", FIXTURE, "--out", out.to_str().unwrap(), "--progress", "plain"],
        &root,
    );
    assert!(plain.stderr.contains("✓ walk"));
    assert!(plain.stderr.contains("✓ parse"));
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
    assert!(help.stdout.contains("--import-root"));
    // What the walk takes, and the exit codes it can return: every pass is written.
    assert!(help.stdout.contains("every *.py, *.pyw and *.pyi"));
    assert!(help.stdout.contains("Exit codes: 0 ok, 1 failure, 2 usage.\n"));
    assert!(help.stdout.contains("--licenses"));
    assert_eq!(help.stderr, "");
}

/// The notice must name every crate the lockfile resolves and the data the binary embeds: a
/// dependency added without regenerating it (scripts/licenses.mjs) fails here, not in a release.
#[test]
fn the_licenses_notice_covers_every_locked_crate_and_the_typeshed_data() {
    let printed = run(&["--licenses"], &repository());
    assert_eq!((printed.code, printed.stderr.as_str()), (EXIT_OK, ""));
    let notice = printed.stdout;
    assert!(notice.contains("typeshed's stdlib/ stubs at commit 2e4d4dcf657f82305709bbe3e86bca4d27d4dd46"));
    assert!(notice.contains("The \"typeshed\" project is licensed under the terms of the Apache license"));
    assert!(notice.contains("The MIT License\n\nCopyright (c) 2015 Jukka Lehtosalo and contributors"));
    assert!(notice.contains("ruff_python_parser 0.0.23 (the repository's LICENSE)"));
    let lock = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock")).expect("Cargo.lock");
    let mut missing = Vec::new();
    for block in lock.split("[[package]]").skip(1) {
        let field = |key: &str| {
            block
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{key} = \"")))
                .and_then(|rest| rest.strip_suffix('"'))
                .unwrap_or_default()
                .to_owned()
        };
        let (name, version) = (field("name"), field("version"));
        // This crate and the shared writer are the project's own (path dependencies, no source).
        if !block.contains("source = ") {
            continue;
        }
        if !notice.contains(&format!("  {name} {version} — ")) {
            missing.push(format!("{name} {version}"));
        }
    }
    assert!(
        missing.is_empty(),
        "not in THIRD-PARTY-LICENSES.txt — regenerate it with scripts/licenses.mjs: {missing:?}"
    );
}

#[test]
fn exits_2_on_bad_usage_and_1_on_a_root_that_is_not_there() {
    let cwd = repository();
    let usage = run(&["--frobnicate"], &cwd);
    assert_eq!(usage.code, EXIT_USAGE);
    assert!(usage.stderr.starts_with("error: unknown option: --frobnicate"));
    assert_eq!(usage.stdout, "");
    let missing = run(
        &["--src", "fixtures/python/no-such-directory", "--out", "unused.jsonl"],
        &cwd,
    );
    assert_eq!(missing.code, EXIT_FAILURE);
    assert!(missing.stderr.contains("source root is not a directory"));
    assert!(!cwd.join("unused.jsonl").exists());
    let outside = run(
        &["--src", FIXTURE, "--import-root", "extractors", "--out", "unused.jsonl"],
        &cwd,
    );
    assert_eq!(outside.code, EXIT_FAILURE);
    assert!(
        outside
            .stderr
            .contains("--import-root is not a directory under the source root")
    );
}

#[test]
fn merges_the_fixture_trace_adding_edges_and_touching_nothing_the_source_wrote() {
    let root = repository();
    let dir = scratch("trace");
    let plain = String::from_utf8(extract(&root, &dir.join("plain.jsonl"))).unwrap();
    let out = dir.join("traced.jsonl");
    let traced = run(
        &[
            "--src",
            FIXTURE,
            "--out",
            out.to_str().unwrap(),
            "--trace",
            "fixtures/python/trace/codegraph-trace.jsonl",
        ],
        &root,
    );
    assert_eq!(traced.code, EXIT_OK, "{}", traced.stderr);
    for line in [
        "  trace bases     : 6 (3 in the source, 2 added as generated, 1 outside the corpus)\n",
        "  trace functions : 4 (2 written, 1 defined at run time — no entity, 1 outside the corpus)\n",
        "  trace calls     : 5 (1 in the model, 1 bound to 1 dynamic-candidate edges, 1 unmatched, 1 to a run-time definition, 1 outside the corpus)\n",
    ] {
        assert!(traced.stderr.contains(line), "{line}{}", traced.stderr);
    }
    // Keys never come from the trace: the same files and entities, line for line, and three
    // edges more — two bases no line writes, one call no line types.
    let model = fs::read_to_string(&out).unwrap();
    let records = |text: &str, tag: &str| -> Vec<String> {
        text.lines()
            .filter(|line| line.starts_with(&format!("{{\"t\":\"{tag}\"")))
            .map(str::to_owned)
            .collect()
    };
    assert_eq!(records(&model, "f"), records(&plain, "f"));
    assert_eq!(records(&model, "e"), records(&plain, "e"));
    assert_eq!(records(&model, "x").len(), records(&plain, "x").len() + 3);
    assert!(model.contains("\"dynamic-candidate\"") && model.contains("\"candidates\":["));
    assert!(!plain.contains("dynamic-candidate"));

    // A file that is no trace, or is not there, is a failure that says so — and writes nothing.
    for (file, message) in [
        ("fixtures/python/expected/model.jsonl", "not a trace"),
        ("fixtures/python/no-such-trace.jsonl", "cannot read the trace"),
    ] {
        let refused = dir.join("refused.jsonl");
        let failed = run(
            &["--src", FIXTURE, "--out", refused.to_str().unwrap(), "--trace", file],
            &root,
        );
        assert_eq!(failed.code, EXIT_FAILURE, "{}", failed.stderr);
        assert!(failed.stderr.contains(message), "{}", failed.stderr);
        assert!(!refused.exists());
    }
}

#[test]
fn copies_the_repository_flags_into_the_header_verbatim() {
    let dir = scratch("repository");
    fs::write(dir.join("a.py"), "class A:\n    pass\n").unwrap();
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
    // The model's own file is never walked back in: it is not a Python file.
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
            "fixtures/python/src/src",
            "--src",
            "fixtures/python/src/tests",
            "--out",
            out.to_str().unwrap(),
        ],
        &root,
    );
    assert_eq!(run.code, EXIT_OK, "{}", run.stderr);
    let model = fs::read_to_string(&out).unwrap();
    assert!(
        model
            .lines()
            .next()
            .unwrap()
            .contains(r#""root":"fixtures/python/src""#)
    );
    assert!(model.contains(r#"{"t":"f","i":0,"path":"src/acme.py"}"#));
    // Only what is under a root is walked: the conftest.py beside them is not.
    assert!(!model.contains(r#""path":"conftest.py""#));
}

#[test]
fn the_header_names_the_parser_and_the_table_this_binary_was_built_with() {
    let manifest = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let tag = format!("tag = \"{}\"", codegraph_python::RUFF_TAG);
    for krate in ["ruff_python_ast", "ruff_python_parser", "ruff_text_size"] {
        let line = manifest
            .lines()
            .find(|line| line.starts_with(&format!("{krate} = ")))
            .unwrap_or_else(|| panic!("{krate} in Cargo.toml"));
        assert!(
            line.contains(&tag),
            "RUFF_TAG must restate Cargo.toml's one tag: {line}"
        );
    }
    let header = snapshot_text().lines().next().unwrap();
    assert!(
        header.contains(&format!(
            r#""extractor":{{"name":"codegraph-python","version":"{}","ruff":"{}","typeshed":"2e4d4dcf657f82305709bbe3e86bca4d27d4dd46"}}"#,
            env!("CARGO_PKG_VERSION"),
            codegraph_python::RUFF_TAG
        )),
        "{header}"
    );
}

#[test]
fn names_the_parser_in_one_source_file_only() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut naming = Vec::new();
    for entry in fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|extension| extension == "rs")
            && fs::read_to_string(&path).unwrap().contains("ruff_")
        {
            naming.push(path.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    assert_eq!(naming, vec!["declarations.rs"], "the parser's API is met in ONE file");
}

#[test]
fn walks_python_by_extension_and_nothing_installed_cached_or_hidden() {
    let snapshot = snapshot_text();
    // A directory holding pyvenv.cfg is a virtual environment, whatever it is called.
    assert!(!snapshot.contains("FromTheEnvironment"));
    assert!(!snapshot.contains(r#""path":"env/"#));
    for absent in [
        "FromADotDirectory",
        "FromTheCache",
        "FromSitePackages",
        ".tox",
        "__pycache__",
    ] {
        assert!(!snapshot.contains(absent), "{absent}");
    }
    // Vendored code is written in the repository: corpus.
    assert!(snapshot.contains(r#""path":"src/acme_order/_vendor/tinyjson.py""#));
    // node_modules is never committed here; it is skipped by name.
    let dir = scratch("walk");
    fs::create_dir_all(dir.join("node_modules/tool")).unwrap();
    fs::write(
        dir.join("node_modules/tool/build.py"),
        "class FromNodeModules:\n    pass\n",
    )
    .unwrap();
    fs::write(dir.join("kept.py"), "").unwrap();
    fs::write(dir.join("stub.pyi"), "").unwrap();
    fs::create_dir_all(dir.join("bin")).unwrap();
    fs::write(dir.join("bin/acme-report"), "#!/usr/bin/env python3\nimport kept\n").unwrap();
    fs::write(dir.join("bin/setup"), "#!/bin/sh\necho python\n").unwrap();
    let out = dir.join("model.jsonl");
    let walked = run(&["--src", ".", "--out", out.to_str().unwrap()], &dir);
    assert_eq!(walked.code, EXIT_OK, "{}", walked.stderr);
    let model = fs::read_to_string(&out).unwrap();
    assert!(model.contains(r#""path":"kept.py""#));
    // A stub is walked; a script is, by its own account — a shell script beside it is not.
    assert!(model.contains(r#""path":"stub.pyi""#));
    assert!(model.contains(r#""path":"bin/acme-report""#));
    assert!(!model.contains("node_modules") && !model.contains("bin/setup"));
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
    for line in [
        "dropped computed-base: src/acme_order/shipping.py:38 make_base()\n",
        "dropped unbound-name: src/acme_order/shipping.py:42 NothingBindsThis\n",
        "dropped unbound-name: src/acme_order/cycle_a.py:5 Token (an import cycle)\n",
        "dropped ambiguous-star: src/acme_order/two_stars.py:6 Widget (vendor_a or vendor_b)\n",
        // The parameter `Base`, never the class of that name the module imports.
        "dropped computed-base: src/acme_order/factory.py:24 Base (bound to a value)\n",
        "dropped unnamed-declaration: src/acme_order/legacy/broken.py:12 def\n",
        "dropped ambiguous-root: tests/test_tie.py:2 fakes (tests/integration or tests/unit)\n",
        "dropped unbound-name: tests/test_tie.py:5 fakes.Fake\n",
        // One of every site the receiver table drops (M22b), with what decided it.
        "dropped untyped-receiver: src/acme_order/services.py:53 order.reference\n",
        "dropped untyped-receiver: src/acme_order/services.py:54 self.handler.process()\n",
        "dropped unbound-self-call: src/acme_order/services.py:55 self.missing() (Service)\n",
        "dropped unbound-attribute: src/acme_order/services.py:56 local.nothing (Order)\n",
        "dropped computed-import: src/acme_order/services.py:58 importlib.import_module(order.reference)\n",
        "dropped raise-of-a-value: src/acme_order/services.py:68 build_error(order)\n",
        "dropped spread-argument: src/acme_order/services.py:45 @register(*settings.HOOKS, name=\"run\")\n",
        "dropped ambiguous-ancestor: src/acme_order/shipping.py:57 self.flush() (django.db.models.Model or sqlalchemy.orm.DeclarativeBase)\n",
        "dropped unbound-dynamic: src/acme_order/shipping.py:67 self.anything() (Proxy)\n",
        "dropped computed-base: src/acme_order/aliases.py:30 Twice (bound to a value)\n",
        "dropped rebinding-of-a-declaration: src/acme_order/compat.py:23 JSONDecodeError (an import binds it)\n",
    ] {
        assert!(explained.stderr.contains(line), "{line}{}", explained.stderr);
    }
    // The scopes and the newer syntax bind what they bind: nothing in flows.py is dropped, and of
    // records.py only the implementation's untyped parameter.
    let flows: Vec<&str> = explained
        .stderr
        .lines()
        .filter(|line| line.starts_with("dropped ") && line.contains("src/acme_order/flows.py"))
        .collect();
    assert_eq!(flows, Vec::<&str>::new());
    let records: Vec<&str> = explained
        .stderr
        .lines()
        .filter(|line| line.starts_with("dropped ") && line.contains("src/acme_order/records.py"))
        .collect();
    assert_eq!(
        records,
        vec!["dropped untyped-receiver: src/acme_order/records.py:35 order.total"]
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
    assert_eq!(explained.stdout, "");
    assert!(plain == fs::read(&out).unwrap());
    // Without the flag, nothing is listed.
    let quiet = run(&["--src", FIXTURE, "--out", out.to_str().unwrap()], &root);
    assert!(!quiet.stderr.contains("dropped "), "{}", quiet.stderr);
}

#[test]
fn an_import_root_changes_how_imports_resolve_and_no_key() {
    let dir = scratch("import-root");
    // A regular package names its own root: `lib` needs no flag.
    fs::create_dir_all(dir.join("lib/acme_lib")).unwrap();
    fs::write(dir.join("lib/acme_lib/__init__.py"), "").unwrap();
    fs::write(dir.join("lib/acme_lib/money.py"), "class Money:\n    pass\n").unwrap();
    fs::create_dir_all(dir.join("app")).unwrap();
    fs::write(
        dir.join("app/main.py"),
        "import acme_lib.money\n\nclass Cash(acme_lib.money.Money):\n    pass\n",
    )
    .unwrap();
    let model = |extra: &[&str]| {
        let out = dir.join("model.jsonl");
        let mut args = vec!["--src", ".", "--out", out.to_str().unwrap()];
        args.extend_from_slice(extra);
        let run = run(&args, &dir);
        assert_eq!(run.code, EXIT_OK, "{}", run.stderr);
        fs::read_to_string(&out).unwrap()
    };
    let without = model(&[]);
    assert!(!without.contains("<site>%2Facme_lib.money"), "{without}");
    // A root no file implies: a namespace directory above a package, as PYTHONPATH=src names it.
    fs::create_dir_all(dir.join("src/ns/inner")).unwrap();
    fs::write(dir.join("src/ns/inner/__init__.py"), "").unwrap();
    fs::write(dir.join("src/ns/inner/thing.py"), "class Thing:\n    pass\n").unwrap();
    fs::write(dir.join("app/use.py"), "import ns.inner.thing\n").unwrap();
    let before = model(&[]);
    assert!(before.contains("<site>%2Fns.inner.thing"), "{before}");
    let after = model(&["--import-root", "src"]);
    assert!(!after.contains("<site>%2Fns.inner.thing"), "{after}");
    // The same corpus entities: a root decides edges, never a key (surrogates shift with the stubs).
    let symbols = |text: &str| -> Vec<String> {
        let mut out: Vec<String> = text
            .lines()
            .filter(|line| line.starts_with(r#"{"t":"e""#) && !line.contains(r#""isStub":true"#))
            .filter_map(|line| line.split(r#""s":""#).nth(1)?.split('"').next().map(str::to_owned))
            .collect();
        out.sort();
        out
    };
    assert_eq!(symbols(&before), symbols(&after));
    assert!(symbols(&after).contains(&"Thing".to_owned()));
}

#[test]
fn a_module_of_one_100000_term_expression_extracts() {
    let dir = scratch("deep");
    let mut source = String::from("x = ");
    for _ in 0..100_000 {
        source.push_str("1 + ");
    }
    source.push_str("1\n\n\nclass After:\n    pass\n");
    fs::write(dir.join("generated.py"), source).unwrap();
    let out = dir.join("model.jsonl");
    let run = run(&["--src", ".", "--out", out.to_str().unwrap()], &dir);
    assert_eq!(run.code, EXIT_OK, "{}", run.stderr);
    assert!(fs::read_to_string(&out).unwrap().contains(r#""name":"After""#));
}
