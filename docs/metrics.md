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

> **Status (M17b):** code metrics for Java, C#, TypeScript and Elixir models;
> change history per file and per entity into a side-car (`--history`, §5).
> Running it from the app and the tap (M17c) comes next.

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

## 4. Change history: `--history`

```bash
./bin/codegraph-metrics model.jsonl --history            # + model.history-metrics.jsonl beside it
./bin/codegraph serve model.jsonl --height history-file:churn_recent --carry history:risk_score
```

`--history` also measures how the code got there, with big-code-analysis's
git measures: per **file** from one walk over the whole commit graph (commits,
churn, authors over the last 365 and 90 days, ownership, burst, bug-fix /
security / revert counts, age, change and co-change entropy, a risk score),
and per **entity** from one `git blame` per file (the same signals over the
lines that survive at the commit; their count is `lines_*`, not `churn_*`).
The full list, with what each means, is `HISTORY_MEASURES` in
`packages/scm/src/history-metrics.ts`.

These go to a **side-car**, `<model>.history-metrics.jsonl`, never into the
model: history is a third artifact beside the model (PLAN.md §11) — a model
describes the code at one commit, and its bytes must not change because
time passed. `--history-out FILE` puts it elsewhere.

- **Measured at** the commit the model describes: its header's
  `repository.commit` (written when the extractor got `--repo-*` flags), else
  HEAD; `--ref REV` overrides both. Every window counts back from that
  commit's own time, so two runs write the same bytes.
- **A file changed since that commit** keeps its file record and gets no
  entity records — its anchors and the blamed lines would describe different
  text. The run says how many.
- **Cost**: the walk and one blame per file — 34 s and 690 MB over
  BroadleafCommerce's 18 776 commits and 2 983 files, against 0.8 s for the
  code metrics; hence opt-in.

`codegraph city` and `codegraph serve` read the side-car beside each model
(or `--history-metrics FILE`) and offer it on every metric channel and
`--carry`: `history:<measure>` is the building's own type (its blame),
`history-file:<measure>` the file the type is written in. Asking for one
with no side-car, or `history:churn_long` (a file-only measure), is a usage
error that says what to run or type instead.

## 5. Limits

- Only entities whose profile licenses `TMetrics` and that the extractor
  measured are touched: the pass never adds a trait.
- tree-sitter-c-sharp 0.23.5 misparses C# 14 `extension(…)` blocks; the
  members inside one may go unmeasured or, for the enclosing class, measured
  over the misparsed shape.
- A model from a language the pass does not know (header `lang`) is left as
  it is, with one line saying so.
