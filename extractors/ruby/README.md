# `codegraph-ruby` — the Ruby extractor

Ruby sources in, `model.jsonl` out (PLAN.md §19). Prism — CRuby's own parser —
is linked in through its Rust bindings, so the binary needs **nothing
installed, Ruby least of all**, and nothing is ever run: no file is loaded, no
bundle is read.

```bash
./build.sh --ruby                                    # → target/release/codegraph-ruby
./bin/codegraph-ruby --src <dir> --out model.jsonl
./test.sh --ruby                                     # cargo test + the release binary reproduces fixtures/ruby
```

## Reading the summary

Every run ends with a `RESOLUTION SUMMARY` on stderr. A **site** is something
written that names something — a constant read, a call, a `super`, a `raise`,
a variable — and the rate is the share that resolved: to the corpus, to
`<ruby>`, to `<gems>`, or to the language itself (`puts`, `private`: resolved,
and no edge). Everything else is dropped and counted by reason, never guessed:

```
  untyped-receiver (dropped)  : 19     a parameter, a block argument, the result of a call
  unbound-self-call (dropped) : 10     a call on self that nothing declares (a DSL's verbs)
  ancestor-attributed         : 3      of the resolved: has_many, charged to the sole library ancestor
  operators, untyped receiver : 8 (not in the rate)
```

`--explain-dropped` adds one line per drop, in source order, and changes no
byte of the model — the tool for auditing a corpus:

```bash
./bin/codegraph-ruby --src <dir> --out model.jsonl --explain-dropped 2>&1 | grep '^dropped'
# dropped computed-require: lib/acme_order/dynamic.rb:5 require
# dropped untyped-receiver: lib/acme_order/pricing/standard.rb:5 sum
```

What each reason means, and what the model says instead, is in the Ruby
profile's notes (`./bin/codegraph profiles --lang rb`) and PLAN.md §19.4.

## Building

Rust ≥ 1.94 and **libclang**: `ruby-prism-sys` generates its bindings with
bindgen at build time, reading Prism's C headers (the C sources themselves are
vendored in the crate). On a machine with `clang` there is nothing to do.

On a machine with the library alone — Debian's `libclang1-N` without
`libclang-common-N-dev` — a bare `cargo build` fails with
`'limits.h' file not found`: clang's builtin headers are missing. `build.sh`
and `test.sh` detect it and lend bindgen GCC's (`scripts/lib.sh`,
`ensure_libclang`). To do the same by hand, note that the variable must be the
**target-specific** one — the crate sets it itself, shadowing the plain
`BINDGEN_EXTRA_CLANG_ARGS` — and that a name with dashes is one only `env` can
set:

```bash
env "BINDGEN_EXTRA_CLANG_ARGS_$(rustc -vV | sed -n 's/^host: //p')=-isystem $(gcc -print-file-name=include)" \
  cargo test --manifest-path extractors/ruby/Cargo.toml
```

## The snapshot

`tests/contract.rs` holds the extractor to `fixtures/ruby/expected/model.jsonl`
byte for byte. After a change that moves it, review the diff, then:

```bash
CODEGRAPH_UPDATE_SNAPSHOTS=1 cargo test --manifest-path extractors/ruby/Cargo.toml --test contract
```

`packages/core/test/fixtures-ruby.test.ts` is the other half of the gate — the
Ruby profile, which this crate never sees, must license every record, and
core's own encoder must write the same bytes.

## The core table

`data/core-rbs-<version>.tsv` lists the constants the Ruby VM defines before
any file runs — what makes `StandardError` a stub below `<ruby>` and
`ActiveRecord::Base` one below `<gems>`. It is generated from RBS's `core/`
signatures with RBS's own parser and committed, so neither Ruby nor RBS is
needed to build the extractor:

```bash
curl -sL https://github.com/ruby/rbs/archive/refs/tags/v4.2.0.tar.gz | tar -xz -C /tmp
cargo run --manifest-path extractors/ruby/tools/core-table/Cargo.toml -- /tmp/rbs-4.2.0/core 4.2.0 \
  > extractors/ruby/data/core-rbs-4.2.0.tsv
```

`tools/core-table` is a package of its own on purpose: the extractor embeds
the table and never links RBS. Moving to a newer RBS is a new file name, the
`include_str!` in `src/core_table.rs`, and a reviewed snapshot diff — the
header of every model names the release it resolved against.

The standard library is deliberately absent: it is gems, default or bundled,
and the set moves with every Ruby release. A model's keys must not.

## Bumping Prism

`ruby-prism` is pinned with `=` in `Cargo.toml`, and `PRISM_VERSION` in
`src/lib.rs` restates the pin for the header (a test holds the two together).
A newer Prism reads newer syntax, which can move entities: bump both, rebuild
with `--locked` off once, and review the snapshot diff.
