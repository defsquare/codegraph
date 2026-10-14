---
title: Metrics pass
linkTitle: Metrics pass
weight: 14
---

`codegraph-metrics` 0.2.0 (big-code-analysis 2.2.0) — the measuring pass over any extractor's model. A Cargo package in `extractors/metrics/`, linking [big-code-analysis](https://github.com/dekobon/big-code-analysis) as a library with five tree-sitter grammars. It is **not an extractor**: it reads a `model.jsonl`, parses every source file the measured entities are anchored in, joins big-code-analysis's function and class spaces to those entities on their anchors, and rewrites their `metrics` maps — cognitive complexity, Halstead, the maintainability index, ABC, exits, logical and comment lines, public methods and attributes. No other byte of the file moves. One binary serves Java, C#, TypeScript, Elixir and Ruby; what each key means is on [Measures and literals](/docs/reference/metamodel/measures-literals/).

```bash
brew install defsquare/tap/codegraph-metrics    # already there if any extractor came from the tap
codegraph-java --src src/main/java --out model.jsonl
codegraph-metrics model.jsonl                   # in place; --out FILE writes elsewhere

# from a clone — Rust 1.94+ to build, nothing to run
./build.sh --metrics                            # cargo build --release → extractors/metrics/target/release/codegraph-metrics
./bin/codegraph-metrics model.jsonl --src <dir>
```

Every extractor formula on the tap depends on this one, so installing any extractor installs the pass once. The release carries `codegraph-metrics-<platform>` for `linux-x64`, `linux-arm64`, `osx-x64` and `osx-arm64`; there is no Windows build. The desktop app runs it on its own after every extraction — a *pass* in its catalogue, never offered as an extractor, and never run over a model you opened directly. `codegraph-metrics --licenses` prints the third-party notice (big-code-analysis is MPL-2.0, which asks a binary to say where its source is).

## Synopsis

```
codegraph-metrics <model.jsonl> [--src <dir>] [--out <file>] [--jobs <n>] [--audit]
                  [--history [--history-out <file>] [--ref <rev>]]
codegraph-metrics --version | --help | --licenses
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `<model.jsonl>` | the model to measure, from any extractor | — |
| `--src <dir>` | the directory the model's file paths are relative to | the header's `root`, read from the current directory — the directory the extractor ran in |
| `--out <file>` | where to write | the model itself, replaced atomically: written through a sibling temporary file and renamed on success, so a failure leaves the extractor's model intact |
| `--jobs <n>` | parser threads | the machine's parallelism |
| `--audit` | list, on stderr, every measured entity not joined exactly | — |
| `--history` | also measure change history — per file from one git walk, per measured entity from one blame per file — at the commit the model describes, clocked at that commit's time. Written to a **side-car**, never the model: `<out without .jsonl>.history-metrics.jsonl` | — |
| `--history-out <file>` | where the side-car goes instead | beside the model |
| `--ref <rev>` | the commit the history is measured at, overriding the header | the header's `repository.commit`, else `HEAD` |
| `--version` | `codegraph-metrics 0.2.0 (big-code-analysis 2.2.0)` | — |
| `--licenses` | the embedded third-party notice | — |
| `--help` | print the help and exit | — |

Exit codes: `0` success · `1` failure · `2` bad usage.

## Streams

stdout carries nothing but `--help`, `--version` and `--licenses`. Every run ends with one line on stderr — the join's report of itself. Over the Ruby reference corpus:

```text
codegraph-metrics: 106 of 109 measured entities joined (106 exact, 0 leading, 0 contained; 3 ambiguous, 0 unjoined) over 31 files; sloc = bca ploc on 106 of 106 exact joins; 106 entities rewritten
```

and over BroadleafCommerce, 2 983 Java files in 0.8 s:

```text
codegraph-metrics: 26209 of 28596 measured entities joined (16395 exact, 9814 leading, 0 contained; 0 ambiguous, 2387 unjoined) over 2983 files; sloc = bca ploc on 16395 of 16395 exact joins
```

- **exact** — the entity and a space cover the same lines.
- **leading** — they end together and start apart by annotation, attribute or decorator lines only: Spoon starts a method after `@Override`, tree-sitter at it; the TypeScript compiler starts an exported class at its decorator, tree-sitter after it. Most of a Spring corpus.
- **contained** — one entity over several spaces: an Elixir function's clauses, a C# property's accessors. Charged keys only.
- **ambiguous** — entities and spaces share a span and do not pair up. In Ruby, a type declared by assignment (`Point = Struct.new(:x) do … end`): the model names a class there, the grammar sees a block. The entity keeps the extractor's own keys and gets none of the pass's.
- **unjoined** — big-code-analysis opens no space there. Expected for implicit constructors (anchored on their class), Java lambdas (big-code-analysis charges them to their method), bodyless declarations (interface signatures, annotation elements, type aliases, enums, ambient declarations), Elixir protocol and impl bodies, `defguard`, `defdelegate`. Those entities carry none of the keys — absent, never zero.
- **sloc = bca ploc** — the witness. On an exact join both count the lines holding code, so they must agree; a disagreement points at a parser (a file the extractor could not parse) or at a definition (JSX text lines in `.tsx`, a heredoc in Elixir, `#if` blocks in C#).

`--audit` lists every measured entity not joined exactly — its outcome, its category, its surrogate in the file and its span — and marks the ones anchored on their parent. The Java reference corpus:

```text
  Leading Invocable e4 com/acme/order/AbstractOrder.java:20-22
  Leading Type e8 com/acme/order/Audited.java:8-11
  Unjoined Invocable e9 com/acme/order/Audited.java:10-10
  Unjoined Invocable e11 com/acme/order/Basket.java:7-57 (on its parent's anchor)
  Unjoined Invocable e70 com/acme/order/Notifications.java:11-11
  …
codegraph-metrics: 70 of 87 measured entities joined (61 exact, 9 leading, 0 contained; 0 ambiguous, 17 unjoined) over 16 files; sloc = bca ploc on 61 of 61 exact joins; 70 entities rewritten
```

`e11` is `Basket`'s implicit constructor, anchored on the class; `e70` a lambda; `e9` an annotation element with no body.

## What it writes

The extractor's keys (`sloc`, `cyclomatic`) are never touched. The pass owns fourteen keys and on every run replaces exactly those, so running it twice changes nothing, and running it after the source changed leaves no stale value behind. One Java method, after the pass:

```json
"metrics":{"abc.assignments":2,"abc.branches":1,"abc.conditions":2,"abc.magnitude":3,"cloc":0,
           "cognitive":4,"cyclomatic":4,"halstead.difficulty":13.2222,"halstead.effort":2811.1424,
           "halstead.volume":212.6074,"lloc":5,"mi":61.3503,"nexits":1,"sloc":9}
```

The keys come in two families, because a join does not always pair one entity with one space:

- **Charged** — the entity's own code, plus every nested function the model does *not* name, and none that it does: the rule every extractor's `cyclomatic` already follows, so `sum:` over a building counts each piece of code once. Present whenever the entity joined, including over several spaces.
- **Span** — over the entity's whole text, nested functions included, so not additive: `sum:mi` means nothing. Present only when the entity *is* one space.

| Key | Family | Unit | Definition |
|---|---|---|---|
| `cognitive` | charged | increments | cognitive complexity (Campbell, 2018): +1 per `if`, loop, `catch`, `case`, jump; plus the nesting level it sits at; +1 per run of `&&`/`\|\|` |
| `nexits` | charged | exits | `return`s and `throw`s |
| `abc.assignments` | charged | count | ABC (Fitzpatrick, 1997) A: stores into a variable — assignments, compound assignments, `++`/`--`, initialized declarations |
| `abc.branches` | charged | count | ABC B: calls, as big-code-analysis counts them per language |
| `abc.conditions` | charged | count | ABC C: comparisons, `?:`, `else`, `case`, `try`, `catch`, and each non-comparison operand of a `&&`/`\|\|` chain |
| `abc.magnitude` | charged | — | √(A² + B² + C²) of the three above |
| `lloc` | span | statements | logical lines |
| `cloc` | span | lines | lines holding a comment |
| `halstead.volume` | span | bits | N · log₂ n over the span's operators and operands (Halstead, 1977) |
| `halstead.difficulty` | span | — | (n₁ / 2) · (N₂ / n₂) |
| `halstead.effort` | span | — | difficulty · volume |
| `mi` | span | 0–100 | maintainability index, Visual Studio form: max(0, (171 − 5.2 ln V − 0.23 G − 16.2 ln L) · 100 / 171), V the volume, G big-code-analysis's cyclomatic summed over the span, L its line count. Absent when there is no volume |
| `npm` | span, types | methods | methods declared directly in the type that its language makes public |
| `npa` | span, types | attributes | public attributes declared directly in the type |

The definitions are big-code-analysis 2.2's ([metrics](https://dekobon.github.io/big-code-analysis/metrics.html)); the attribution to entities is this model's. Only entities whose profile licenses `TMetrics` and that the extractor measured are touched: the pass never adds a trait.

**Bytes as `codegraph` writes them.** A new value is rounded to four decimals (`ln` and `log₂` may differ in the last bit between platforms) and spelled as JavaScript spells a number; the `metrics` map is re-sorted; an unchanged line is copied, never re-encoded. Two runs over one corpus write the same bytes on every OS, and the file stays byte-identical to what core's own encoder would write — `./test.sh --metrics` and the `metrics-native` CI job, built natively on four runners, hold the five `fixtures/<lang>/expected/model.metrics.jsonl` snapshots to that.

## The join

The model and big-code-analysis disagree on granularity in both directions — a C# property with accessors is one entity over two spaces, an Elixir function one entity over one space per clause, a callback nobody names a space with no entity — and on where a declaration starts. Three matches are tried in order, then the fold:

1. **Exact** — the same line span. Natural pairs first, per category (an invocable and a function space, a type and a class space, a `TModule` and the file), then what is left by depth alone. More entities than spaces leaves the innermost unjoined — a Java class and the implicit constructor Spoon anchors on it.
2. **Leading** — the same last line, first lines apart by nothing but annotations, attributes, decorators, comments and blanks, brackets balanced.
3. **Contained** — an entity no space spans takes the outermost unjoined compatible spaces inside its span; never an entity anchored exactly on its parent, which has no extent of its own.
4. **The fold** — a space the model does not name is charged to the entity around it: a closure nobody names belongs to its enclosing method, as its `cyclomatic` already does.

What each language leaves unmeasured, by big-code-analysis's own choice or its grammar's:

| Language | Not measured, and why |
|---|---|
| Java | lambdas (no space: charged to their method), implicit constructors (anchored on the class), annotation elements (no body). On BroadleafCommerce 98.9 % of what has text of its own joins |
| C# | implicit constructors, a record's positional members, members of a C# 14 `extension(…)` block (tree-sitter-c-sharp 0.23.5 misparses it); a property with accessors is *contained* and carries charged keys only. In a file with `#if` blocks the witness disagrees: tree-sitter measures every branch, Roslyn's `sloc` the active one |
| TypeScript | interface signatures, type aliases, enums, namespaces, ambient declarations — no space. The witness is off by the lines of JSX text in `.tsx` |
| Elixir | `defprotocol` and `defimpl` bodies, `defguard`, `defdelegate`; a multi-clause function is *contained* and carries charged keys only. big-code-analysis leaves a heredoc's text out of `ploc`, so the witness disagrees there |
| Ruby | a type declared by assignment (`Struct.new … do`, `Class.new … do`) and a concern's `class_methods do` — blocks to the grammar, *ambiguous* to the join. Everything else joins exactly |

A model from a language the pass does not know is left as it is, with one line saying so.

## `--history`: change history, as a side-car

```bash
codegraph-metrics model.jsonl --history            # + model.history-metrics.jsonl beside it
codegraph serve model.jsonl --height history-file:churn_recent --carry history:risk_score
```

`--history` also measures how the code got there, with big-code-analysis's git measures: per **file** from one walk over the whole commit graph (commits, churn, authors over the last 365 and 90 days, ownership, burst, bug-fix, security and revert counts, age, change and co-change entropy, a risk score), and per **entity** from one `git blame` per file (the same signals over the lines that survive at the commit). They go to [`<model>.history-metrics.jsonl`](/docs/reference/artifacts/history-metrics-jsonl/), never into the model: a model describes the code at one commit, and its bytes must not change because time passed.

- **Measured at** the commit the model describes — its header's `repository.commit`, written when the extractor got `--repo-*` flags — else `HEAD`; `--ref REV` overrides both. Every window counts back from that commit's own time, so two runs write the same bytes.
- **The whole commit graph**, not the first-parent chain: a commit a merge brought in counts.
- **A file changed since that commit** keeps its file record and gets no entity records — its anchors and the blamed lines would describe different text. The run says how many.
- **Cost**: the walk and one blame per file — 35 s and 670 MB over BroadleafCommerce's 18 776 commits, against 0.8 s for the code metrics; hence opt-in, and not something the desktop app runs.

[`city`](/docs/reference/cli/city/) and [`serve`](/docs/reference/cli/serve/) read the side-car beside each model (or `--history-metrics FILE`) and offer it on every channel and `--carry`: see [City metrics](/docs/reference/city-metrics/#history-forms).

## Limits

- Only entities whose profile licenses `TMetrics` and that the extractor measured are touched; the pass never adds a trait.
- The temporal store keeps no per-revision measures, so [`snapshots`](/docs/reference/cli/snapshots/) does not run the pass.
- A Windows binary waits for something that ships or tests it.
- big-code-analysis is pinned exactly (`=2.2.0`): every key's value is that version's definition, and a bump is a reviewed snapshot diff, never a silent update.

## See also

[How to measure complexity and change history](/docs/how-to/measure-metrics/) · [Measures and literals](/docs/reference/metamodel/measures-literals/) · [City metrics](/docs/reference/city-metrics/) · [history-metrics.jsonl](/docs/reference/artifacts/history-metrics-jsonl/)
