# `codegraph-model` — the writer the Rust extractors share

Not an extractor: the language-neutral half of one. A Rust extractor builds a
`Model` — the language tag, the header's `extractor` object, entities and
outgoing edges keyed by natural key `(module, symbol, disambiguator?)` — and
`codegraph_model::write` turns it into `model.jsonl` (`schemas/README.md`):
canonical order by UTF-16 code unit, dense surrogates, the interned file table,
the header's dictionaries, and JSON written byte for byte as core's encoder
writes it.

It holds no language. Vocabulary strings — kinds, traits, edge kinds,
provenance — are the caller's, written verbatim; the id scheme, its escaping
and the header's extractor-specific fields stay in each extractor.

```bash
cargo test --manifest-path extractors/model-rs/Cargo.toml   # the unit tables
./test.sh --ruby                                            # these, then an extractor that uses it
```

Its own unit tests pin the parts (keys, order, escaping, record shapes); each
extractor's snapshot test is what holds the whole to core's bytes —
`fixtures/ruby/expected/model.jsonl` for `extractors/ruby`. A change here is a
change to every Rust extractor's output: run each one's suite.

A standalone package (its own `[workspace]`), depended on by path; it has no
dependency, and the extractor's release profile builds it.
