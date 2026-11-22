//! codegraph-python — the Python extractor (PLAN.md §23).
//!
//! Ruff's parser used as a library: nothing is run, no Python is needed, and
//! a file that parses — with errors, in Python 2 — is a file that extracts.
//! Imports resolve through the roots the layout implies against a whitelist
//! of what the corpus declares and an embedded table of typeshed's `stdlib/`.
//!
//! The extractor holds no metamodel intelligence: it knows the Python id
//! scheme and the kind → traits table; the bytes are `codegraph-model`'s
//! writer (`extractors/model-rs`). Trait vocabulary, profile validation and
//! closure live in `@codegraph/core`. The parser's API is internal and
//! unversioned, so exactly one file names its types: `declarations.rs`.

pub mod cli;
pub mod corpus;
pub mod declarations;
pub mod extraction;
pub mod ids;
pub mod resolve;
pub mod scopes;
pub mod stats;
pub mod stdlib_table;

pub const NAME: &str = "codegraph-python";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Ruff tag this binary parses with — Cargo.toml's pin, restated for the header.
pub const RUFF_TAG: &str = "0.17.6";
