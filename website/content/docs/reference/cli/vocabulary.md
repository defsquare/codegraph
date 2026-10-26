---
title: "vocabulary"
weight: 16
---

Report the words the model's names are made of, per corpus, module or type; or drift against a glossary.

Every `TNamed` entity's name is split into words (`OrderLineRepository` → `order`, `line`, `repository`), each word classed `domain`, `technical`, `keyword` or `short` and weighted by the role of what carries it: a type's or a module's name weighs 8, an attribute's 4, an operation's 3, a parameter's or a local's 1. The words of a qualified name before its last separator (`com.acme` of `com.acme.order`) weigh 1 whatever carries them. Only names are read, never source. The splitting rules per language are the lexicons [`profiles`](/docs/reference/cli/profiles/) prints.

## Synopsis

```
codegraph vocabulary [model.jsonl...] [--level <corpus|module|type>] [--scope ID] [--top N]
                     [--class <domain|technical|keyword|short|all>] [--weights KEY=N,…]
                     [--technical FILE] [--drift FILE] [--out FILE] [--svg FILE]
                     [--json] [--internal-only] [--declared-only] [--no-cache]
```

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<model.jsonl...>` | One or more model.jsonl paths, loaded together as ONE union (decision 5). With no path, the model the extractor writes in this directory. | `<current-dir>-codegraph.jsonl` |

## Options

| Option | Meaning | Default |
|---|---|---|
| `--level <corpus\|module\|type>` | The corpus's words, or one block per module or type, ranked by distinct terms (the cognitive-load report). | `corpus` |
| `--scope ID` | Report one scope: a module or type by its entity id, or an operation, counted on demand. | — |
| `--top N` | Show the N heaviest words: 40 by default, 10 per block under `--level module\|type`. | — |
| `--class <domain\|technical\|keyword\|short\|all>` | Which words to show. | `domain` |
| `--weights KEY=N,…` | Override weights, e.g. `type=6,qualifier=0`. Keys: `module`, `type`, `operation`, `attribute`, `parameter`, `local`, `other`, `qualifier`. | — |
| `--technical FILE` | Replace the shared technical words with this file's, one word per line; each language's own still apply. | — |
| `--drift FILE` | Compare with a glossary, one business term per line: the terms no scope of `--level` says (exit 3), and the domain words no term contains. | — |
| `--out FILE` | Also write the [`vocabulary.json`](/docs/reference/artifacts/vocabulary-json/) artifact to this file. | — |
| `--svg FILE` | Also draw one scope's cloud to this SVG file: the corpus, or the `--scope` one; `--class` and `--top` pick its words. | — |
| `--json` | Print the same information as a machine-readable JSON object on stdout. | — |
| `--internal-only` | Drop stub (external) entities and every edge touching one. | — |
| `--declared-only` | Keep only `declared` facts; drop derived and dynamic-candidate edges. | — |
| `--no-cache` | Read the model.jsonl directly; never build or reuse a sibling model.db. | — |
| `-h, --help` | Show this help. | — |

## Scopes

A type's words are those of everything that folds into it, a module's likewise, the corpus's every kept entity's: the membership the city uses. A nested type is a scope of its own, so its members are not its outer type's. A stub never speaks, under any view: its name was chosen by another codebase. An operation's words are not stored; `--scope` counts them on demand, from the operation and everything written inside it short of a nested type.

## Drift

The glossary is a plain text file, one business term per line; blank lines and `#` comments are skipped. Each term is split by the same universal rules, so `Order Line` meets `order` and `line`. A term is *said* by a scope when every one of its words is, whatever class the code gives the word, so `--level module` asks for all of them in one module. Nothing is stemmed: `lines` is not `line`. The report lists the terms no scope says with their missing words, the terms it says and where, and the `domain` words the code says that no term contains.

## Cloud

`--svg FILE` draws the cloud of the one scope the report shows, the corpus or the one `--scope` names, from the words `--class` and `--top` pick. A word's size follows the square root of its weight, so its area reads as the weight, and its colour says its class and nothing else: `domain` in ink, `technical` muted, `keyword` and `short` faint, with a dark palette for a dark page. Words are placed heaviest first, each at the first free point of a spiral out from the centre. The legend states the scope, the counts, the weights, the view and the technical list. The font is monospace, so the bytes are the same on every run and any machine.

[`serve`](/docs/reference/cli/serve/)'s **Vocabulary** tab runs the same layout in the browser, measured in the page's own monospace face, over the scope selected in Navigate, and lists the names that carry a clicked word.

## In the city

One word across the whole city is the city metric `vocabulary:<word>`: `codegraph serve model.jsonl --height vocabulary:order` raises each building by the word's weight in its type scope, the number this command reports under `--level type`. A type that never says the word stands at the floor; [City metrics](/docs/reference/city-metrics/#vocabulary-form) has the rules.

## Exit codes

`0` ok · `1` internal error (a bug) · `2` usage error · `3` findings.

`3` when the load was not clean, or with `--drift` when a business term is said by no scope of the level. An unknown `--scope` id, an unknown `--weights` key or a `--technical` line that is not one word is a usage error, and so is `--svg` with `--level module|type` or `--drift`: a cloud is one scope's.

## Example

```console
$ codegraph vocabulary fixtures/java/expected/model.jsonl --top 5
cache: fixtures/java/expected/model.db
codegraph vocabulary — words
models:    fixtures/java/expected/model.jsonl
level:     corpus
view:      all (nothing filtered — stubs and inferred edges included)
weights:   module 8 · type 8 · operation 3 · attribute 4 · parameter 1 · local 1 · other 1 · qualifier 1
technical: 138 shared words (sha256 4f34e69f52f5) + each language's own

corpus src
  152 entities: 127 speak (module 3 · type 19 · operation 43 · attribute 21 · parameter 35 · local 6), 25 unnamed
  85 distinct terms, 73 domain · weight 503 · 146 occurrences
  domain: 5 of 73 terms (--top 5), by weight descending, ties by term

  TERM      CLASS   WEIGHT  OCC  CARRIERS  MODULES  TYPES
  order     domain      40   12        12        3      4
  price     domain      18    6         6        1      6
  basket    domain      16    2         2        1      2
  channel   domain      16    4         4        1      2
  discount  domain      14    3         3        1      3
```

`OCC` counts the word in names, `CARRIERS` the entities whose name says it, and `MODULES` and `TYPES` how many of those scopes say it in the whole corpus.

```console
$ printf 'Order\nOrder Line\nCustomer\n' > glossary.txt
$ codegraph vocabulary fixtures/java/expected/model.jsonl --drift glossary.txt --level module --top 4
…
glossary:  glossary.txt, 3 business terms

never said: 1 of 3 business terms, no module says all their words
  Customer    missing customer

said: 2 of 3 business terms
  Order       3 modules
  Order Line  1 module: java:com.acme.order

code only: 4 of 71 domain words no business term contains (--top 4), by weight descending, ties by term

  TERM      WEIGHT  OCC  MODULES
  price         18    6        1
  basket        16    2        1
  channel       16    4        1
  discount      14    3        1
1 business term no module says — exiting 3 (findings).
```

## See also

[vocabulary.json](/docs/reference/artifacts/vocabulary-json/) · [`profiles`](/docs/reference/cli/profiles/) · [CLI conventions](/docs/reference/cli/)
