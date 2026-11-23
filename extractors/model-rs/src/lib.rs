//! codegraph-model — the `model.jsonl` writer the Rust extractors share
//! (schemas/README.md): natural keys and the in-memory model, canonical order
//! by UTF-16 code unit, and an encoder that writes core's bytes.
//!
//! It holds no language: the model's `lang`, the header's `extractor` object
//! and every vocabulary string (kinds, traits, edge kinds, provenance) are the
//! caller's data, written verbatim and never interpreted here.

mod json;
mod model;
mod writer;

pub use model::{Anchor, Edge, Entity, Key, Literal, Model, NamedArgument, utf16_cmp};
pub use writer::{Counts, WriteError, write};
