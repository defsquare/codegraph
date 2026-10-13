//! codegraph-ruby — the Ruby extractor (PLAN.md §19).
//!
//! Prism, CRuby's own parser, used as a library: nothing is run, no Ruby is
//! needed, and a file that parses — even with errors — is a file that
//! extracts. Names resolve through a lexical scope against a whitelist of what
//! the corpus declares and an embedded table of what the VM defines.
//!
//! The extractor holds no metamodel intelligence: it knows the Ruby id scheme,
//! the kind → traits table and how to write bytes. Trait vocabulary, profile
//! validation and closure live in `@codegraph/core`.

pub mod cli;
pub mod core_table;
pub mod corpus;
pub mod declarations;
pub mod extraction;
pub mod ids;
pub mod json;
pub mod model;
pub mod resolve;
pub mod stats;
pub mod writer;

pub const NAME: &str = "codegraph-ruby";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Prism this binary parses with — Cargo.toml's exact pin, restated for the header.
pub const PRISM_VERSION: &str = "1.9.0";
