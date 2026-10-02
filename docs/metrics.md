# Running the metrics pass

`codegraph-metrics` adds [big-code-analysis](https://github.com/dekobon/big-code-analysis)
measures — cognitive complexity, Halstead, the maintainability index, ABC,
exits, logical and comment lines, public methods and attributes — to a
`model.jsonl` an extractor already wrote. It is not an extractor: it reads the
model, parses every source file the measured entities are anchored in, joins
big-code-analysis's function and class spaces to those entities on their
anchors, and rewrites their `metrics` maps. Nothing else in the file moves.
One binary serves every extractor (PLAN.md §18); what each key means is in
METAMODEL.md §3.8.

> **Status (M17a):** code metrics for Java, C#, TypeScript and Elixir models.
> Change-history metrics (M17b) and running it from the app and the tap
> (M17c) come next.

## 1. From a clone

A standalone Cargo crate under `extractors/metrics`, linking
`big-code-analysis` 2.2.0 as a library with four tree-sitter grammars. It
needs Rust ≥ 1.94 to build and nothing to run:

```bash
./build.sh --metrics                    # cargo build --release → extractors/metrics/target/release/codegraph-metrics
./test.sh --metrics                     # cargo test: the join's unit tests + the four enriched snapshots, byte for byte
./bin/codegraph-java --src src/main/java --out model.jsonl
./bin/codegraph-metrics model.jsonl     # in place; --out FILE writes elsewhere
```

`--src DIR` is the directory the model's file paths are relative to; it
defaults to the header's `root`, read from the current directory — the
directory the extractor ran in. `--jobs N` bounds the parser threads (default:
the machine's parallelism).

## 2. What it writes

The extractor's keys (`sloc`, `cyclomatic`) are never touched. The pass owns
fourteen keys and on every run replaces exactly those, so running it twice
changes nothing, and running it after the source changed leaves no stale
value behind:

```
"metrics":{"abc.assignments":2,"abc.branches":1,"abc.conditions":2,"abc.magnitude":3,"cloc":0,
           "cognitive":4,"cyclomatic":4,"halstead.difficulty":13.2222,"halstead.effort":2811.1424,
           "halstead.volume":212.6074,"lloc":5,"mi":61.3503,"nexits":1,"sloc":9}
```

Two families (METAMODEL §3.8): **charged** keys (`cognitive`, `nexits`,
`abc.*`) are an entity's own code plus any nested function the model does not
name — so `--height sum:cognitive` counts each piece of code once — and
**span** keys (`lloc`, `cloc`, `halstead.*`, `mi`, `npm`, `npa`) cover the
entity's whole text and are not additive. Numbers keep four decimals and are
spelled as core's encoder spells them: the file stays byte-identical to what
`codegraph` itself would write.

The city's metric channels read any of them: `codegraph serve model.jsonl
--height sum:cognitive` raises a building by the cognitive complexity of all
its code, `--footprint attribute:lloc` sizes it by its type's own statements.

## 3. The join, and reading its report

Every run ends with one line on stderr:

```
codegraph-metrics: 26209 of 28596 measured entities joined (16395 exact, 9814 leading, 0 contained;
0 ambiguous, 2387 unjoined) over 2983 files; sloc = bca ploc on 16395 of 16395 exact joins
```

- **exact** — the entity and a space cover the same lines.
- **leading** — they end together and start apart by annotation, attribute or
  decorator lines only (Spoon starts a method after `@Override`, tree-sitter
  at it).
- **contained** — one entity over several spaces (an Elixir function's
  clauses, a C# property's accessors): charged keys only.
- **unjoined** — big-code-analysis opens no space there. Expected for
  implicit constructors (anchored on their class), Java lambdas
  (big-code-analysis charges them to their method), bodyless declarations
  (interface signatures, annotation elements, type aliases, enums, ambient
  declarations), Elixir protocol and impl bodies, `defguard`, `defdelegate`.
  Those entities carry none of the keys — absent, never zero.
- **sloc = bca ploc** — the witness: on an exact join both count the lines
  holding code, so they must agree; a disagreement points at a parser (a file
  the extractor could not parse) or a definition (JSX text lines in `.tsx`).

`--audit` lists every entity not joined exactly, with its outcome, category
and span, and marks the ones anchored on their parent.

## 4. Limits

- Only entities whose profile licenses `TMetrics` and that the extractor
  measured are touched: the pass never adds a trait.
- tree-sitter-c-sharp 0.23.5 misparses C# 14 `extension(…)` blocks; the
  members inside one may go unmeasured or, for the enclosing class, measured
  over the misparsed shape.
- A model from a language the pass does not know (header `lang`) is left as
  it is, with one line saying so.
