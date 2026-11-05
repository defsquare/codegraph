# The vocabulary — design record

`codegraph vocabulary model.jsonl` reports the words a codebase speaks. The
model already holds every one of them — each `TNamed` entity is an identifier
someone chose — but it holds each name as one token: `OrderManagerRepository`
is a name to the analyzer, not the three words `order`, `manager` and
`repository`. The vocabulary splits every name into its words, tags each word
with a class, weighs it by what carries it, and counts it per scope — the
corpus, each module, each type — so that it can say that `order` is spoken
8 588 times across 61 of BroadleafCommerce's packages while `basket` is spoken
twice, in one.

The city answers *what does this codebase look like*; the navigator *what
depends on what*; the insights *what does it mean*. The vocabulary answers
*what language does it speak* — and, once `explain` has run, *what does each
word mean where it is used*. It is three layers, each a pure function of the
one below it:

| layer | what | who | cost |
|---|---|---|---|
| 1. count | names → words, classes, weights, scopes, the cloud | `@codegraph/vocabulary` | none — a function of the model |
| 2. mean | per explained entity, each word of its name: its sense and its concern, in that entity's context | the model, inside the `explain` call it already makes | a longer completion, no extra call |
| 3. roll up | a glossary per type, module and corpus; polysemy; drift between what the rules say and what the model judged | readers over the insights store | none — a function of the records |

Layer 1 is the package, the `vocabulary.json` artifact, the command, the
Vocabulary tab of `serve` and the `vocabulary:<word>` city channel (VO-1 to
VO-11). Layers 2 and 3 are the `words` and `glossary` fields of an insight
record, the store's `insight_word` projection and the readers over it (VO-12
to VO-14). What was measured is in VO-15; what was deliberately left out in
VO-16. The decisions and their history are PLAN.md §20; this record states
what was built.

---

## VO-1 · Words come from names, never from source

The issue that motivated the feature (#6) pitched a word cloud built by
stripping a file of its keywords and collecting every identifier. The words it
listed — class, method, variable and argument names — are exactly what the
model carries, each with its kind, its containment and its anchor. So the
vocabulary reads the model's names and nothing else:

- **No lexer.** A tokenizer per language would be a third source reader
  beside the two the architecture licenses (the extractor and the metrics
  pass), and keyword filtering would become a necessity instead of a tag.
- **No words in `model.jsonl`.** The words are derived from names, hence
  recomputable from the model alone — the opposite of a measure. They live
  in an artifact of their own, `vocabulary.json`, beside `city.json` and
  `navigator.json`; the interchange does not move.
- **Not in the analyzer, not in the metrics pass.** The analyzer answers
  graph questions; this is a view model with its own artifact and its own
  layout, like the city. The metrics pass measures numbers (METAMODEL §3.8),
  and these are derived strings.
- **No language model for layer 1.** The count is deterministic and free; a
  model is asked only what a rule cannot know — what a word *means* in one
  entity (VO-12).

The cost of the choice is coverage, and it is stated rather than hidden: an
extractor that emits no local variables (Ruby, Elixir — their profiles have no
`localVariable` kind) yields a cloud with fewer incidental words. VO-15 counts
what each extractor contributes.

Seven principles, locked up front and held by the tests:

1. **Words come from the model's names.** Every kept `TNamed` entity
   contributes the words of its name; a nameless one (a constructor, a
   lambda) contributes none and is counted.
2. **The idiom is the profile's; the algorithm is one.** Keywords,
   conventional names, technical words and file kinds are data on the
   profile, specifiable without being implemented (CLAUDE.md invariant 8);
   word boundaries are universal and need none. The splitter reads the data
   and knows no language.
3. **Classification, not filtering.** Every token is kept and tagged
   `domain | technical | keyword | short`; a consumer filters. Drift needs
   the technical words too, and "not shown" stays distinguishable from "not
   there".
4. **Weights are data and travel in the artifact.** A count without the
   scheme it was weighted under is not a fact — the city's `bindings` rule.
5. **Scope membership is the fold's.** A type's words are the words of
   everything that folds into its building, a module's likewise — the same
   membership the city uses, so a `vocabulary:order` channel raises the
   building whose words were counted.
6. **Deterministic bytes.** Terms interned and sorted, scopes in id order,
   tables by weight then term; `fixtures/<lang>/expected/vocabulary.json`
   is byte-identical on every run and every OS.
7. **A word's meaning is an inference about one entity, stored and shown as
   one.** It lives inside that entity's insight record, never in the
   artifact, and wears the page's inference colour.

## VO-2 · The lexicon is the profile's; the algorithm is one

What is language-specific about a name is data on the language profile,
`Profile.lexicon` (`packages/core/src/profile.ts`), optional — a profile
without one is complete, and the splitter falls back to the universal rules —
and present on the eleven shipped profiles:

```ts
lexicon?: {
  keywords: string[];       // the specification's RESERVED words, as the language spells them;
                            // a contextual keyword (record, var, TS's type) is an identifier
  conventional: string[];   // whole identifiers the language or its runtime dictates, skipped
                            // whole: toString (Java), initialize (Ruby), constructor (TS),
                            // __using__ (Elixir), GetHashCode (C#)
  technical?: string[];     // the language's own plumbing beyond the shared list (VO-4), as the
                            // splitter yields it: bean, jdbc (Java); concern (Ruby); live, web (Elixir)
  fileKinds?: string[];     // kinds whose name is a file path: the extension is not a word
  qualified?: Record<string, string>;
                            // kinds the language names by a qualified path, with the separator
                            // that ends the qualifier: the qualifier's words weigh as incidental
  interfacePrefix?: true;   // C#: IOrderService → order, service (I + Upper + lower)
};
```

What each shipped profile declares (`codegraph profiles --lang X` prints the
lexicon in full, between the kinds and the notes):

| profile | keywords | conventional | technical | file kinds | qualified kinds | interface prefix |
|---|---:|---|---|---|---|---|
| `java` | 53 | 16 — `toString equals hashCode clone finalize main compareTo iterator hasNext valueOf serialVersionUID readObject writeObject…` | `annotation bean beans ejb jaxb jdbc jndi jpa pojo servlet` | — | `package` by `.` | — |
| `csharp` | 77 | 42 — `ToString Equals GetHashCode Finalize Main CompareTo Dispose GetEnumerator MoveNext Deconstruct this[]`, the `op_*` operators | `attribute enumerable enumerator linq` | — | `namespace` by `.` | yes |
| `ts`, `js` | 46 (ECMAScript's, one shared `ECMASCRIPT_LEXICON`) | 12 — `constructor toString toLocaleString valueOf toJSON`, the `[Symbol.*]` methods | `cb fn promise prototype` | `module` | `module` by `/` | — |
| `ex` | 15 | 49 — `__using__ __struct__ start_link child_spec init handle_call handle_cast handle_info terminate code_change to_string inspect`, the `@moduledoc @spec @impl…` attributes | `attrs behaviour changeset conn ecto ets gen live mix otp phoenix pid plug schema server socket sup supervisor web` | `file` | `file` by `/`, `module` and `protocol` by `.` | — |
| `rb` | 41 | 50 — `initialize to_s to_h to_proc inspect hash eql? == === <=> [] []= each coerce method_missing respond_to? included extended inherited…` | `accessor attr concern concerns ext gem gemspec klass lambda proc rake rakefile` | `file` | `file` by `/`, `class`, `module` and `constant` by `::` | — |
| `go` | 25 | 16 — `init main String GoString Error Unwrap Is As Len Less Swap MarshalJSON UnmarshalJSON MarshalText UnmarshalText ServeHTTP` | `cfg cmd errs internal mu pkg srv svc wg` | — | — (`package order` is one identifier) | — |
| `rust` | 52 | 21 — `main fmt drop clone eq ne partial_cmp cmp deref into_iter from_str try_from as_ref borrow_mut index_mut default poll…` | `arc buf cell ffi iter ok opt rc refcell rs rx sys tx vec` | — | — (`mod line` is one identifier) | — |
| `python` | 35 | 78 — `self cls`, every `__dunder__` | `dict kwargs metaclass py tuple` | — | `module` by `.` | — |
| `php` | 82 | 17 — `__construct __destruct __call __get __set __toString __invoke __clone…` | `arr closure facade middleware php` | `codeFile` | `codeFile` by `/`, `namespace` by `\` | — |
| `clj` | 20 | 6 — `-main -init -post-init -toString -equals -hashCode` | `coll kw ns seq sym xf xform` | — | `namespace` by `.` | — |

Keywords come from each language's specification (reserved words only: a
contextual keyword such as Java's `record` or TypeScript's `type` is an
identifier a name may legitimately say); conventional names from its runtime.
A kind is `qualified` when the *language* names it by a path — Java's
`package`, Ruby's `class` by `::`, every file kind by `/` — and not when one
identifier names it. File-ness is per kind, not per profile: Elixir's `file`
is a path but its `module` is the dotted `AcmeOrder.Registry`, whose
`.Registry` a profile-wide flag would have dropped as an extension.

`validateProfile` rejects an entry that could never do what its list claims,
with five codes: `lexicon-duplicate`, `lexicon-not-a-word` (a keyword with no
letter, a name holding whitespace, a technical entry the splitter cannot
yield), `lexicon-keyword-overlap` (a conventional name or a technical word a
keyword claims first), `lexicon-unknown-kind` (a file or qualified kind the
profile does not declare) and `lexicon-not-a-separator` (empty, or holding a
letter, a mark or a digit). Tests pin, per shipped profile, a non-empty
keyword list, no contextual keyword, `interfacePrefix` on C# alone and
exactly the five file kinds above; a test keeps every profile's `technical`
disjoint from the shared list. `ProfileSchema` mirrors the type and parses
every shipped profile unchanged; `schemas/` does not change, since a profile
is not on the wire.

The first draft carried separators, prefixes and suffixes per idiom; built,
they could change no output. The splitter must break on *every* character
that is not a letter, a mark or a digit anyway — or `<=>`,
`[Symbol.iterator]` and `this[]` become tokens — and once it does, `@total`,
`valid?`, `Order::Line` and `` Repository`1 `` need no data.

## VO-3 · The split

One function, `splitIdentifier(name, kind, lexicon)` in
`packages/vocabulary/src/split.ts`, returns `{tokens, qualifier, numeric,
conventional}` in six steps, each pinned by a table of hand cases per idiom:

0. A `conventional` identifier is skipped whole, before anything else, and
   counted: `toString` must not contribute `string`, `handle_call` must not
   contribute `call`.
1. For a kind in `fileKinds`, the extension of the last path segment is
   dropped (`legacy/acme-report.ts` → `legacy/acme-report`; a leading dot,
   `.eslintrc`, is not an extension). For a kind in `qualified`, the name is
   cut at the *last* occurrence of its separator: the words before it are
   the qualifier, their number returned in `qualifier`
   (`AcmeOrder::Order::Line` → 3 of `acme`, `order`, `order`, `line`). With
   `interfacePrefix`, a leading `I` + Upper + lower on the own name is a
   marker, not a word (`IOrderService` → `order`, `service`; `IO` and
   `IOError` keep their `I`; `Acme.IOrder` → `order`).
2. Split on every character that is not a Unicode letter, mark or digit —
   universal, no data: `@total` → `total`, `valid?` → `valid`, `save!`,
   `name=`, `max_lines`, `acme-report`, `` Repository`1 `` → `repository`
   and a numeric piece.
3. Camel-case boundaries with the acronym rule — lower→Upper, digit→Upper,
   and an Upper run followed by Upper + lower splits before its last letter:
   `HTTPServer` → `http`, `server`; `getURLString` → `get`, `url`,
   `string`; `XMLHttpRequest` → `xml`, `http`, `request`. On Unicode letter
   categories, not ASCII: a caseless letter (`𠀀`, `注`) counts as lower, a
   mark takes the case of the letter it sits on, so a decomposed `é` never
   splits. `fixtures/unicode` is the test: `ＡFullwidth` and `𠀀Supplementary`
   split and lowercase without a replacement character.
4. A digit run stays with the letters around it — only an Upper after it
   breaks: `utf8`, `md5`, `v2`, `i18n`, `http2`; `Utf8Encoder` → `utf8`,
   `encoder`. A piece that is only digits is dropped and counted
   (`numeric`: `2024` of `promo#2024`, the timestamps of Rails migration
   file names).
5. Lowercase with `toLowerCase`, which is locale-independent: a machine in
   a Turkish locale writes the same bytes.

Properties, checked with fast-check over identifiers the grammar admits:
every token is a non-empty run of letters, marks and digits, lowercase, never
digits only, and a slice of the lowered name; the same input gives the same
tokens; `split(a + sep + b) = split(a) ++ split(b)` for any character that is
not a letter, a mark or a digit; qualification moves no word (the tokens are
the same with the qualified kinds removed, and for a qualified kind
`qualifier` is the number of words of `a` in `a + separator + b`). A Σ is
left out of the generator: its lower case depends on what follows it, so a
token's lower case and its slice of the lowered name may differ (`ΟΔΟΣ` →
`οδος`, pinned by hand).

## VO-4 · The classes

`classify.ts`: a closed set, `TERM_CLASSES = ["domain", "technical",
"keyword", "short"]`, decided per token, in this order:

| class | when | examples |
|---|---|---|
| `keyword` | the lowercased token equals a lowercased keyword of the lexicon | `type`, `default`, `case`, `new`, `end` |
| `short` | one code point that is not a mark — length 2 stays a word | `i`, `e`, `x`, `𠀀`; `id`, `db`, `io` are words |
| `technical` | the shared list ∪ the profile's `technical` | `get`, `repository`, `impl`, `dto`; `bean` (Java), `concern` (Ruby) |
| `domain` | everything else | `order`, `basket`, `fulfillment` |

A keyword the splitter never yields whole (`defined?`, `__FILE__`, `set!`)
classifies nothing: the `file` of `upload_file` is not `__FILE__`.

**The shared technical list** (`DEFAULT_TECHNICAL`, 138 words) holds what
every language shares: the CRUD verbs, `get set is has to from of with by and
or not`, the layer nouns (`manager service repository controller handler
factory provider dto dao entity model`), the data vocabulary (`name type
value key map property field index`), the test words (`test mock spec stub
fixture fake`), the web and format words (`http json xml uri url request
response`), `com org net io src lib main app`… It is contestable by
construction, which is why it is data in one place, overridable whole with
`--technical FILE` (one word per line, `#` comments skipped; a line the
splitter does not yield as one word could never match a token and is refused
by its number), and why the artifact records which list it used: its size and
a sha256 over its sorted words, one per line. A word two profiles both listed
(`args`, `opts`, `ctx`, `err`, `callback`, `str`, `mutex`, `mixin`, `async`)
moved into the shared list; a language's own plumbing stays on its profile and
applies on top of any `--technical` file.

The list was corrected once, as data, after the Broadleaf review (VO-15):
thirteen words added, each read off its carriers, never off its spelling.

## VO-5 · Roles and weights

`weight.ts`. The role of the entity carrying a name comes from its traits,
never its kind (the navigator's rule), first match winning: `module`
(`TModule`), `type` (`TType` — a C# delegate, `TType` + `TInvocable`, is a
type), `operation` (`TInvocable` — a Clojure fn-var too), `parameter` or
`local` (a `TStructural` listed in some entity's `parameters[]` or
`localVariables[]`), `attribute` (every other `TStructural`: fields,
constants, properties, module attributes), and `other` — a named entity no
role trait describes (a TypeScript `namespace`, a PHP `codeFile`, a Python
`decorator`), whose words still count. Default weights, recorded in the
artifact and overridable with `--weights role=n,…`:

| role | weight | why |
|---|---|---|
| `type`, `module` | 8 | a concept the corpus names once and refers to everywhere |
| `attribute` | 4 | a thing the type holds — nouns, usually domain |
| `operation` | 3 | something it does; the prefix is usually technical (`get`, `find`, `build`) |
| `parameter`, `local` | 1 | incidental: the "variable buried deep in a method" of the issue |
| `other` | 1 | no trait says what it is |
| `qualifier` | 1 | not a role: the words before the last separator of a qualified name, whatever its role — a container's words, spoken again by every name it qualifies |

An **occurrence** is one token in one name; a name carrying a word twice
counts twice, and is one **carrier**. Both the weighted sum and the raw
occurrence count are kept — one is a judgement, the other a fact; a word
weighing 0 still occurs.

`qualifier` exists because a qualified name speaks its container's words
again, on every entity the container holds. Counted at the role's weight,
`acme` weighed 468 in the Ruby fixture and 392 in the Elixir one against
about 50 for the next domain word, and `packages` 168 in the TypeScript one
(21 modules under `packages/`, now 21). Built on the fixtures, one parameter
is listed nowhere: the C# indexer's, a child of its `property`, which the C#
profile gives no `TWithParameters`; it weighs as an attribute until the model
lists it, pinned by id.

## VO-6 · Scopes: the fold's membership

`aggregate.ts`, `buildVocabulary(graph, {view?, weights?, technical?,
name?})`. **Kept** is the view's verdict (`--internal-only`,
`--declared-only`) on a non-stub entity; a stub never speaks, whatever the
view — its name was chosen by another corpus (`String`). The scopes are the
kept modules and types (by trait, `TModule` first), plus the corpus root. A
scope's table is the union of the readings of every kept entity whose fold
container it is — the analyzer's `containingType` and `containingModule`,
the city's membership — and the **nearest**: a nested type is its own scope,
and its members are not its outer type's. Attachment is not followed, as the
fold does not: a Ruby reopening speaks in the file it is written in. Per
scope, `term → [weight, occurrences, carriers]`, with `carriers` the number
of distinct entities carrying the word, plus:

- `entities`, each one unnamed, conventional, or counted in `roles` by its
  role; `skipped` by reason (`unnamed`, `conventional`, `numeric`);
- `distinct` and `distinctDomain` — the terms in the table and the `domain`
  ones among them: the cognitive-load proxy of the issue (a module with 500
  distinct words against one with 100);
- total `weight` and `occurrences`;
- `parent`: the nearest scope up the containment chain the model writes,
  else the root.

Per term, across scopes: `modules` and `types` (how many scopes of each level
speak it) and `exclusive` (the one module scope whose table has it, when
exactly one does) — the overlap and the drift inputs. A class is decided per
language (Go reserves `type`, Java does not), so a word is interned once per
class it takes; an entity's language is its model's, read from the union,
never from its id. A kept entity no module contains counts at the root alone
and is listed (`diagnostics.unplaced`); a language core has no lexicon for is
split by the universal rules alone and listed (`diagnostics.withoutLexicon`).

**An operation's scope** is computed on demand, never stored (`--scope ID`,
`operationScope`): the operation and every kept entity written inside it,
lambdas and their parameters included, short of a nested type or module,
which are scopes of their own. It is counted exactly as a stored scope is,
under the same options, and indexed by the artifact's terms; an artifact
built under other options is refused rather than answered with rows that are
not its count's. Operation scopes stay out of the artifact because the
navigator addresses types and modules only — a member node carries no id —
so the page could not ask for one (VO-16).

The one counting rule lives in `reading.ts`, read once per entity: the
artifact folds a reading into every scope the entity belongs to, the carriers
(VO-11) keep it per entity, so a carrier's share is exactly what the row
counted.

## VO-7 · The artifact `vocabulary.json`

`artifact.ts`, kind `codegraph.vocabulary/1`, `generatedBy:
"@codegraph/vocabulary"`: a header (the view descriptor, `corpus {name,
roots}` by the city's and navigator's rule, `langs`, `weights`, `classes`,
`technical: {words, sha256}`), `terms[]` interned and sorted by text in
code-unit order then class, `scopes[]` (the corpus first, then modules, then
types, each level in id order: `level`, `id`, `name`, `kind`, `parent` scope
index, the counts of VO-6, `terms: [termIndex, weight, occurrences,
carriers][]` by weight descending then term) and `diagnostics`. Rows are
array indexes, not ids: a term is its position in `terms`, a parent its
position in `scopes`; a scope carries the entity's rendered id, opaque, so a
city building or a navigator node finds its words without parsing anything.
The field-by-field reference is the website's *vocabulary.json* page.

Properties, tested on the six fixtures and on generated corpora: **closure**
(every scope id is a kept entity of its level, every index is in range, the
counts add up), **conservation** (every kept entity is in exactly one module
scope or in `unplaced`) and **order-independence** (the same bytes whatever
order entities arrive in). The JSON is compact by default; `pretty` writes
one term and one scope per line, the form of the committed snapshots, so a
diff reads word by word. `fixtures/<lang>/expected/vocabulary.json` for the
five language fixtures and `fixtures/unicode` are rebuilt byte for byte by
`pnpm --filter @codegraph/vocabulary test` (`CODEGRAPH_UPDATE_SNAPSHOTS=1`
rewrites them), and one word per fixture is counted by hand in the fixture's
README and pinned by a test:

| fixture | word | weight | occurrences | carriers | what carries it |
|---|---|---:|---:|---:|---|
| `java` | `order` | 40 | 12 | 12 | the package `com.acme.order` (8), three classes (3 × 8), five parameters and a local (6 × 1), two sub-packages as qualifier (2 × 1); the two `orders` parameters are another word — nothing stems |
| `csharp` | `order` | 42 | 14 | 14 | the namespace, three classes, six parameters, a local, three sub-namespaces as qualifier; `IPriceable` makes `priceable` (9) and no word `i` |
| `typescript` | `legacy` | 11 | 4 | 4 | the package `legacy-lib` (8) and three file modules whose directories qualify them (3 × 1): `packages` weighs 21 over 21 modules, not 168 |
| `elixir` | `pricing` | 28 | 9 | 9 | a file module (8), a `defmodule` (8), a struct field (4), a function (3), a parameter (1), two files and two modules as qualifier (4 × 1): a module's dots and a file's slashes both qualify |
| `ruby` | `pricing` | 8 | 5 | 5 | a field `@pricing` (4) and four qualifiers: no entity is named `Pricing` itself |

Size grows with scopes, not entities: on BroadleafCommerce (3 305 types, 502
modules) the compact artifact is 2.9 MB, built in 0.29 s; Mastodon's 5 739
scopes (a file is a module) make 3.2 MB on a quarter of the entities. No cap
is needed.

## VO-8 · The command

`codegraph vocabulary <models…>` is a shell over the package, as `analyze` is
over the analyzer; the flags are in `docs/cli.md` and `--help`. The reports:

- **No flag:** the corpus root's 40 heaviest `domain` terms as a table —
  term, class, weight, occurrences, carriers, modules, types. Every report's
  header states the view, the weights and the technical list (its size, the
  first 12 hex of its digest, and the file it came from), since a count
  without them is not a fact.
- **`--level module|type`:** one block per scope, its top N (10 by default)
  and its `distinct` column, sorted by `distinct` descending, ties by id —
  the cognitive-load report.
- **`--scope ID`:** a stored module or type, else an operation counted on
  demand. An unknown id, a stub, or a member that is no operation is a usage
  error that says what the id is.
- **`--class`**, **`--top`**, **`--weights KEY=N,…`** (laid over the
  defaults; an unknown or repeated key, or a weight below 0, is a usage
  error), **`--technical FILE`**.
- **`--out FILE`** writes the artifact (compact) beside the report;
  **`--svg FILE`** draws the one scope reported (VO-10); **`--json`** is one
  object, `codegraph.vocabularyReport/1`, `report: "words" | "drift" |
  "drift-insights"`.

A flag the report would not read is refused, never dropped: `--class` with
`--drift`, `--level` or `--drift` with `--scope`, `--svg` with `--level
module|type` or `--drift` are usage errors. Exit codes are the CLI's: `0`, `1`
internal, `2` usage, `3` findings — a load that was not clean, or a business
term no scope says (VO-9); a model's judgement never sets it (VO-14).

## VO-9 · Drift against a business glossary

`drift.ts`, `--drift FILE`. The glossary is a plain text file, one business
term per line, `#` comments skipped: it exists in every company, which is why
it ships before a Specy `.domain` file as input (VO-16). Each term is split
with the universal rules and no lexicon, so `Order Line` meets `order` and
`line`; a term whose words repeat an earlier one's is that term; a line naming
no word (`2024`, `—`) is warned about by its number. Nothing is stemmed:
`lines` is not `line`.

A business term is **said** in a scope when every one of its words is,
whatever class the code gives the word. The report lists, over the scopes of
`--level`:

- the terms no scope says, with the words no scope says at all, or "never
  together" when each word is said somewhere but never in one scope;
- the terms said, and where (how many scopes; the one scope, by id, when
  there is one);
- the **code-only** words: the `domain` words the code speaks that no
  business term contains, summed over the level's scopes, by weight — the
  other half of drift, words the code says that the business never does.

A term said nowhere exits 3, as `analyze --report cycles` does for a cycle: a
CI job can gate on the glossary.

## VO-10 · The cloud and the SVG

`cloud.ts`, `layoutCloud(words, {measure?, minSize?, maxSize?, padding?,
aspect?})`: pure geometry, no randomness, so a cloud is a function of its
words. Terms by weight descending, ties by text then class, so any order of
the same words lays out the same; font size interpolated between 12 and 56 px
on the square root of the weight, rounded to the pixel (area reads as
magnitude); each box walks an Archimedean spiral out from the centre,
stretched 2:1 for a landscape image, and stops at the first whole-pixel point
where its padded box (4 px clear on each side) overlaps no box placed before
it. There is no fixed canvas: the canvas is whatever the words cover.
Properties: no two placed boxes intersect, every box lies inside the reported
extent, the same input gives the same positions, placement order is weight
order.

The text measurer is **injected** — `measure(text, size) → {width, height}`.
The default is monospace, 0.6 em advance per cell and a 1.2 em line, counting
a combining mark as no cell and a Han, kana, Hangul or fullwidth character as
two, as a terminal draws them; it is exact for the font stack the SVG
declares. The browser passes `canvas.measureText` for its own face (VO-11).
`cloud.ts` imports types only and is a tsup entry of its own
(`@codegraph/vocabulary/cloud`), so a page runs it without the Node pipeline
behind `aggregate.ts`.

`svg.ts`, `vocabularyCloudSvg(artifact, scope, {termClass?, top?})`: size
is the weight, through the layout; colour is the class and nothing else —
`domain` in ink, `technical` muted, `keyword` and `short` faint, through one
class attribute per word and a stylesheet with a light and a dark
(`prefers-color-scheme`) palette; a key line appears when more than one
class is drawn. The legend states the scope and its counts, the weights, and
the view with the technical list's size and digest, since a cloud without
them is a picture, not a fact. Every coordinate is rounded to 1/100 px and
the font is monospace, so `fixtures/java/expected/vocabulary.svg` is a
byte-identical snapshot and `docs/vocabulary-broadleaf.svg` — BroadleafCommerce's
corpus at `--top 80`, 6.7 KB — is this command's output, committed.

## VO-11 · The page: the tab, the carriers, the city channel

`codegraph serve` builds `vocabulary.json` from the same graph and view as
`navigator.json` and `city.json` and serves it at `/vocabulary.json`. The
**Vocabulary tab** of `navigator-ui` (the sixth) shows the cloud of the
current scope — the corpus until a module or a type is selected in Navigate,
then that scope, the way the explanation panel follows the selection — with
class chips (`domain` by default), a `--top` slider and, beside it, the
table (term, weight, occurrences, carriers, spread). The scope chain
(corpus › module › … › type) steps up by selecting the scope's node, the
corpus by clearing the selection. The layout is the same function the CLI
ran, measured in the page's monospace face (the page sets identifiers in
mono; so does the SVG); the colours are the page's paper, dimmed and faint —
no hue, since the page's four hues already mean direction, inference and
selection. The tab restates the artifact kind and `TERM_CLASSES` as literals
pinned equal to the package's by a test, and imports `@codegraph/vocabulary`
for types only, plus the one value import of the `cloud` entry the guard test
allows (CLAUDE.md, the frontend rule).

**Evidence is a lookup, not a bigger file.** The artifact counts the names
behind a row and never lists them; `/carriers.json?term=order[&scope=ID]
[&class=CLASS][&limit=N]` answers one row on demand from the model `serve`
holds (`carriers.ts`, `codegraph.carriers/1`): the entities of that scope
whose names carry the word — name, kind, role, what each added to the row,
anchor, and the hand-off key: a type or module carries its rendered id, a
member none and an `owner` (its type, else its module), the navigator's rule.
**A row is the sum of its carriers** — weights, occurrences and count — a
property over every term of every scope of the six fixtures, held because
both read the same `reading.ts`; an artifact counted under other weights,
another list or another view is refused. No `scope` is the corpus; `class`
disambiguates a text two languages class apart (`ambiguous`, 400, lists the
classes); an unknown scope or term is 404, like `/insight.json`; `limit`
defaults to 200 and `total` always counts them all. The index is built at the
first answerable request, reading every kept entity once, and the graph is
released then. Clicking a word on the tab asks it and lists the carriers; a
type or module among them reveals in Navigate, a member reveals its owner.
The app daemon builds `vocabulary.json` with the other two but holds no model
between jobs, so it has no `/carriers.json`: the tab shows the counts and
says why there are no names. A static host degrades the same way.

**The city channel.** `vocabulary:<word>` is a metric source for `--height`,
`--footprint` and `--carry`, wired through the CLI's `metric(name)` hook
exactly as `history:` is; `@codegraph/city` is unchanged. It is the word's
weight in the building's type scope under the default weights — the number
the Vocabulary tab shows for that type — so `codegraph serve model.jsonl
--height vocabulary:order` is "where does `order` live", the issue's city
link. A height, not a colour: the city's one colour channel is the
framework's categorical `role`, and a weight is a magnitude. A type whose
names never say the word weighs **0**, not `undefined`: its names were read,
and zero is what they say. `undefined` stays for a building with no type
scope — a stub, whose names the vocabulary never reads — drawn at the channel
minimum and labelled unmeasured. The word goes through the splitter (`Order`
is `order`; `OrderLine`, two words, is a usage error); the classes two
languages give one text add up, the metric being about the text; a word no
name in the view says is a usage error rather than a flat city that looks
like an answer. `docs/vocabulary-city-broadleaf.png` is the City tab on
Broadleaf at `--height vocabulary:order --height-scale sqrt`: 627 of 3 305
types say the word, the tallest `OrderServiceImpl` at 203, the towers in
`core.order.service` and `core.offer`; the root lifts a type that says the
word once off the floor (589 of the 627 rise above 5 of 40 units, against 92
on a linear scale).

## VO-12 · Layer 2: the words a model is asked to define

The deterministic part knows that `OrderManagerRepository` is made of
`order`, `manager` and `repository`, that `order` is spoken in 61 modules and
that `repository` is on the technical list; it cannot know what `order` means
in *this* class, nor that `service` in `CustomerServiceTicket` is a domain
word and not a layer. That is a judgement about one entity, in the context of
that entity — its source, its doc comment, its fields, what its operations
were just explained to do, what it depends on — and `explain` already
assembles exactly that context, for exactly that entity, in the context pack
it builds before asking the model (`docs/insights.md`, IN-3). **So the
glossary is not a second thing beside the explanations; it is in them.** Two
earlier drafts — a standalone command over a scope's term table, then a
second request per type and module — asked about words at the wrong
altitude: a scope has a vocabulary, but a *meaning* belongs to the entity
that uses the word, and only there is the context complete.

**The question.** A unit's prompt gains one section, *Words to define*: the
words of the unit's own name and of the names of its members that are not
units themselves — an operation's parameters, a type's fields, constants and
properties — split by the rules of VO-3 and listed with the identifier each
comes from (`order (OrderManagerRepository)`, `total, amount (totalAmount)`).
The words are **given, not chosen**, and the deterministic class is withheld
so the judgement is the model's; the gap between the two is layer 3's first
report. What is asked, by `definitionSpeller` in `define.ts`:

- the own name's words only — a qualifier's words are its container's, asked
  where they are the own name (`com.acme.order` is asked for `order`,
  `AcmeOrder::OrderLine` for `order, line`);
- `domain` and `technical` words both — a technical word in a domain
  position is the whole point (`service`, `manager`, `handler`); the speller
  takes no `--technical` list, since that list only moves a word between two
  classes that are both asked;
- not `short` and `keyword` words (`i`, `x`, `type`);
- not **function words** — `FUNCTION_WORDS`, 60 English closed-class words
  (articles and determiners, pronouns, conjunctions, prepositions,
  auxiliaries and modals, `not`), left out whatever their class: `or` is on
  the technical list, `all` is domain. A list, not a fifth class: the cloud,
  the classes and drift are unchanged, every word still counted and tagged.
  Not on it: a word that names a thing as often as it joins two — `no`,
  `may`, `will`, the particles of phrasal verbs (`out` of `checkOut`), the
  prepositions of time and order (`before`, `after`, `between`) — and only
  English: `du` of `getNomDuClient` is still asked;
- not locals and lambda parameters: counted at weight 1 in the cloud, never
  defined (VO-16).

**The port.** `@codegraph/insights` imports nothing from the vocabulary, not
even types: the context env takes a `Speller` (`words(id)`,
`ranked(moduleId)`) and the CLI hands in `definitionSpeller` and
`rankedWords` over the run's own `buildVocabulary`, built on first ask.

**The answer.** The block of every level gains `words`, one entry per word
per unit — one entity means one thing by a word; an entity that does not is
`ambiguous`, with the two senses in `meaning`:

```ts
words: [{
  word,                                    // as the splitter spelled it, lowercase
  in: string[],                            // the identifiers of this unit it appears in
  concern: "domain" | "technical" | "ambiguous",
  sense,                                   // a short label: the signified
  meaning,                                 // one sentence, in THIS entity's context
  confidence
}]
```

The module block, which already quotes its types' summaries, is also shown
its types' `words` entries — read from the store through a `words(id)`
projection, as summaries are, and only when its prompt renders — for the
words its types spell, ordered by the module's vocabulary row (heaviest
first), cut at `--terms N` (default 60), and **only those at least one type
defined** (`glossaryAsked`): a word every type left undefined is not asked,
since a module paid for "ambiguous: undefined term" on PetClinic's `birth`
before that rule. It answers:

```ts
glossary: [{ word, concern, sense, meaning,
             polysemous: boolean,          // its types disagree on the word
             senses: [{ in: string, sense }] }]   // the disagreeing types, when they do
```

Its existing `ubiquitousLanguage` keeps its role (terms the model proposes, in
its words); `glossary` is over the words the *code* spells. The corpus level
has no call: a reader lays the modules' senses side by side (VO-14).

**Kept on receipt.** An entry for a word the prompt did not list is dropped,
a word given twice keeps its first entry, and `in` is restated from the
split, a fact the prompt stated; a module's glossary is filtered the same
way. An answer without `words` (or a module's without `glossary`) gets the
repair re-ask, then a failure. Templated records (trivial members no model
sees, IN-7) carry no `words`: no model judged them.

**The version.** `PROMPT_VERSION` is `"2"`; M11 put it into every
fingerprint precisely so a better prompt re-explains what it improves. A
store explained under `"1"` keeps every record until a run replaces it (the
store is not a cache), and a reader meeting a record without `words` says
"not defined under this prompt", as `answerInsight` distinguishes failed from
unknown. `words` and `glossary` are optional in the record schema so a
version-1 record decodes and re-encodes to its own bytes — the round-trip
identity holds for every existing side-car — while the response schema sent
to the provider requires them. The side-car format does not change: the
words ride inside `block`, where `concept` and `confidence` already do.

**Fingerprints.** The words asked (per member: identifiers and words) and a
module's glossary *candidates* — never what a type said of them, and not
which candidates a type defined — join the fingerprint inputs. So a lexicon
correction re-explains exactly the units whose words it changed, and the same
`--terms` reuses every module while another redoes exactly the modules whose
cut moved. Because a dependent hashes its dependencies' fingerprints (IN-5),
a words-only change cascades: adding the function words made 9 of
PetClinic's units stale directly and 53 of its 106 calls in all (about
$0.08). Whether a words-only change *should* cascade is an open design
question (PLAN.md §20.3); nothing is lost before a run, since the old records
stay and the readers show them until they are replaced.

**Cost, measured.** No new call; a completion grows by what it defines. The
estimate's figures were fitted on a live prompt-2 run over Spring PetClinic
(gpt-5.6-luna, 106 calls, 228 177 prompt and 96 356 completion tokens,
$0.1343, no failure), reasoning tokens included since they are billed: 470,
530 and 530 completion tokens per operation, type and module block, **120 per
word and 125 per glossary entry** (r² 0.81 per call; a word entry's own JSON
is about 50 tokens, the rest the reasoning that goes with it). `--estimate`
prices a re-explanation before anyone pays; the glossary figure rests on five
module calls, and a corpus with more modules should refit it.

## VO-13 · The store at version 2

`INSIGHTS_DB_VERSION = 2`, migration 1 — the first rung of the migration
ladder to run on a real file. It creates a **projection** table,
`insight_word (id, entry)`, indexed on `word` and on `id`: `entry` is the
word entry as JSON text, without its `meaning`, with `word`, `concern`,
`sense` and `confidence` as generated columns over it. JSON text with
generated columns, as `insight` has, because these strings come from a model
or a side-car and a plain column cannot hold U+0000 (the binding reads it
back cut short); `in` rides in `entry` because it is a reserved word in SQL;
no `meaning` because a sentence per entry was a third of the table at
Broadleaf's scale, and an answer that shows it reads the block. The rows are
written per record, in the unit's transaction — the replaced record's rows
deleted, the record written, its rows written — and an `--import` deletes the
whole table and rebuilds it from the blocks, so the side-car stays the one
source of truth. The migration backfills: a build that asked prompt 2 while
its store was still at version 1 had written words into version-1 blocks.
Tested from a real file (`packages/insights/test/fixtures/store-v1.sql`, the
`.dump` of a store the version-1 build wrote): N records and M failures
migrate intact and export the same bytes; a version-3 file is refused
untouched. A reader still refuses an older store (M16c), and the refusal
names the free way out: any `explain` on it migrates it, `--dry-run`
included. On a synthetic side-car of Broadleaf's size (28 206 records,
131 190 entries) the import takes 1.5 s, the projection is 22 MB of a 91 MB
store, and `WHERE word = 'order'` takes 0.5 ms.

## VO-14 · Layer 3: the readers

All over the store, none calling anything (`glossary.ts` in
`@codegraph/insights`, over four projections of the store port: `wordHits`,
`glossaryEntries`, `concernRows`, `withoutWords`). A record is placed in its
module by its natural key — core renders the module's id from `lang` and
`module`, groups compare through `naturalKeyIndex`, the id is never parsed —
and a record without a key is placed nowhere and still answered.

- **`codegraph insights --word order`** — every explained entity whose names
  spell the word, grouped module → type → operation (by level within each
  module: an operation is not nested under its type, which only the model
  knows), one tab-separated line per entry: the module, `glossary` or the
  entity's level, the id, the concern, the confidence, the sense and the
  identifiers the word is in. The module's own glossary entry heads its
  group. The signifier/signified glossary of the issue, at every scope, from
  one index lookup; no `meaning` (the projection does not hold it: `--id` and
  `--glossary` read it from the block).
- **`--glossary MODULE_ID`** — a module's reconciled glossary whole, with
  the types' senses where they disagree.
- **`--polysemy`** — the words a module flagged, and the words whose
  module-level senses differ across the corpus (in concern or in sense, case
  and spacing aside: the wording varies from call to call), side by side for
  a human to judge; the most senses first. No model call judges them across
  the corpus. **A flag counts when its senses bear it out** —
  `typesDisagree(entry)`: `polysemous` and at least two distinct `senses`.
  PetClinic's `owner` module had flagged `owners` with three types giving one
  sense; the flag is the model's judgement, the senses its evidence, and both
  are needed. The record keeps what the model wrote (the store is not a
  cache); the readers and the page ask the rule, and the page restates it,
  pinned to the package's by a test. Lexical, not semantic: four wordings of
  "animal under care" stay four senses, since judging meaning is a model call.
- **`--concerns`** — per module, how many distinct words its records define
  and how many the model called `domain`, `technical` and `ambiguous` (a word
  two units judged differently counts under both): the cognitive-load proxy
  split by kind.
- **`codegraph vocabulary --drift-insights [--insights FILE] [--drift
  FILE]`** — the one reader that opens the store *beside* the model, since
  only the model says which class the rules give a word in an entity's
  language. `concernDrift` in `concern-drift.ts` takes the judgements in the
  package's own shape (`WordJudgement`; the three concerns restated as
  `JUDGED_CONCERNS`, pinned equal to the block's by a CLI test — neither
  package imports the other) and classes each word as `buildVocabulary` would
  in that entity's language under the list in effect, so a word judged in two
  languages may be two rows. Two lists: the technical words a model called
  domain somewhere (`service` in `CustomerServiceTicket`) and the domain words
  it called technical (a candidate for the list, or a homonym: `order` in
  `sortOrder`), ranked by the judgements against, ties by word, `--top N`
  each; `ambiguous` contradicts neither class, and a `keyword` or `short`
  word (a lexicon corrected since) contradicts nothing. Each word shows its
  concern counts and the five surest judgements against it (confidence,
  sense, the identifiers in which entity; `--json` lists every one). With
  `--drift FILE`, `businessJudged` sets the business terms against both: each
  word's classes in the corpus and the model's concerns, and why the term
  drifts — `list` when the list does not call a word domain, `model` when a
  model judged it technical somewhere. Records the comparison cannot use are
  counted on stderr: an entity the model does not hold (explained against
  another version) or the view does not keep, and prompt-1 records. A
  judgement never sets the exit code; `--drift` keeps its exit 3 for a term
  the corpus never says.
- **`/glossary.json?term=order[&scope=ID][&limit=N]`** on `serve`
  (`answerGlossary(store, query, placement)`, `codegraph.glossary/1`) — the
  entries of the entities under a module or a type, and the modules'
  reconciliations, over the same store reader as `/insight.json`. Which
  entities are under a scope is the model's, so the CLI hands in a
  `Placement` — each kept entity's containing module and type, by the fold
  the vocabulary counts with — and the package still opens no model. The
  Vocabulary tab lists them under the clicked word's carriers, inside the
  explanation panel's border and badge (`LLM glossary`), with the models
  that wrote them, each entry in the inference colour and one click from its
  entity; the Navigate explanation panel renders `words` and `glossary` by
  name (`order (domain) — sense. Meaning. In Order · 0.90`), the one
  exception to its generic block rendering. An inference never looks like a
  fact. The prompt-1 records are counted in a footnote.

## VO-15 · Measured

**Coverage per extractor** (2026-10-26, Apple M1 Max; `build` is
`buildVocabulary` alone over a built graph, the median of five; `artifact`
the compact JSON). Whole repositories as cloned, tests included:
BroadleafCommerce at `26208e01de`, codegraph at `294e5cc` (`--src packages
--src extractors/typescript`), Mastodon at `2bc820fb84`, Plausible at
`9bc90b0063`:

| corpus | kept entities | named | by role (module · type · operation · attribute · parameter · local) | skipped (unnamed · conventional · numeric) | distinct terms (domain) | artifact | build |
|---|---:|---:|---|---|---|---:|---:|
| `fixtures/java` | 152 | 127 | 3 · 19 · 43 · 21 · 35 · 6 | 25 · 0 · 0 | 85 (73) | 17 KB | 1.2 ms |
| `fixtures/csharp` | 210 | 178 | 4 · 26 · 45 · 38 · 54 · 9 | 32 · 2 · 0 | 113 (93) | 23 KB | 1.0 ms |
| `fixtures/typescript` | 179 | 161 | 24 · 22 · 37 · 28 · 39 · 6 (+ 4 other) | 18 · 1 · 1 | 108 (87) | 29 KB | 0.8 ms |
| `fixtures/elixir` | 181 | 167 | 23 · 28 · 50 · 11 · 49 · 0 | 14 · 6 · 1 | 97 (73) | 31 KB | 0.8 ms |
| `fixtures/ruby` | 157 | 156 | 31 · 32 · 35 · 16 · 31 · 0 | 1 · 11 · 1 | 107 (87) | 36 KB | 0.9 ms |
| BroadleafCommerce (Java) | 76 310 | 72 843 | 502 · 3 305 · 21 201 · 8 521 · 22 528 · 15 742 | 3 467 · 1 044 · 6 | 3 381 (3 191) | 2.9 MB | 290 ms |
| codegraph, self-hosted (TypeScript) | 30 873 | 24 696 | 428 · 587 · 1 751 · 5 517 · 6 491 · 9 914 | 6 177 · 8 · 0 | 2 143 (1 994) | 0.8 MB | 71 ms |
| Mastodon (Ruby) — no locals by construction | 20 358 | 20 276 | 3 379 · 2 360 · 8 906 · 2 373 · 3 058 · 0 | 82 · 200 · 652 | 2 447 (2 294) | 3.2 MB | 100 ms |
| Plausible (Elixir) — no locals by construction | 16 435 | 15 520 | 1 300 · 1 355 · 5 052 · 1 273 · 6 416 · 0 | 915 · 124 · 306 | 1 999 (1 845) | 1.8 MB | 68 ms |

The unnamed are Broadleaf's 3 140 constructors and 327 lambdas; codegraph's
6 154 arrow functions — a fifth of its entities, the price of a codebase
written in `const f = () => …` callbacks, whose names are the attributes that
hold them; Mastodon's 82 and Plausible's 915 anonymous parameters (splats,
patterns). Mastodon's 652 numeric tokens are the timestamps of `db/migrate/`
file names. End to end, `codegraph vocabulary` on Broadleaf takes 2.2 s with
`--no-cache` (the load dominates), Mastodon 0.8 s.

**The sanity check.** The Broadleaf top ten by weight under `domain` must
read as a commerce vocabulary, and whatever technical word leaks into it
names a missing entry of the shared list, fixed as data. Under the 125-word
list it read `order name type field item customer offer extension value
product`; thirteen words later (125 → 138: `name type value key map property
field` — the data vocabulary of every language, `getName`, `cacheKey`,
`FieldMetadata`; `extension extensions` — the `…ExtensionManager` pattern;
`read` — the R of CRUD; and, from Mastodon's top ten, `serializer`, `worker`,
`index`) it reads `order 8 588 · item 4 883 · customer 4 020 · offer 3 514 ·
product 2 917 · admin 2 890 · group 2 666 · fulfillment 2 368 · category
2 319 · payment 2 281` — `admin` is the back office, `group` the fulfillment
group, both Broadleaf's own words. Kept as domain because their carriers are
mixed: `policy`, `change`, `query`, `collection`. The others' top ten:
codegraph `edge kind required optional graph file path module edges city` —
its domain *is* code, so the list costs it `type`, `name` and `index`, which
a `--technical` file gives back; Mastodon `account status accounts statuses
domain policy change collection user block`; Plausible `plausible site query
team user change stats email event plan` (`plausible` is every module's
namespace, as `acme` is the fixtures').

**Layers 2 and 3** were measured on Spring PetClinic rather than Broadleaf —
small enough to read every answer — with the live run of VO-12 (the store
lives outside this repository). On it, `insights --word pet` answers in
0.14 s and `vocabulary --drift-insights` in 0.21 s; on a synthetic store of
Broadleaf's size, `--word order` (549 entries, 19 glossary entries) in
0.46 s, `--drift-insights` over 109 208 entries in 4.1 s end to end against
3.2 s for the plain report, and `/glossary.json` for `order` over the corpus
(1 908 entries, 200 sent) in 0.21 s with the placement built, 0.11 s after.
The three PetClinic findings became rules: function words are not asked, a
module reconciles only words a type defined, a polysemy needs two senses
(VO-12, VO-14).

## VO-16 · Deferred, explicitly

- **A source-text channel** — comments, string literals, the names of
  external members a scope calls (what it speaks *to*, against what it
  declares). A second reader with its own classes, waiting for the first
  channel to prove the tags and the weights.
- **Operation scopes in the artifact.** Computable on demand; the navigator
  addresses types and modules only, so the page could not ask for one. The
  day it can, they join the artifact.
- **Locals and lambda parameters defined.** Counted at weight 1, never
  asked: 24 392 operations on Broadleaf would spend completion tokens on `i`
  and `result`.
- **A corpus-level reconciliation call.** The modules' senses of a word are
  laid side by side for a human; one more call could judge them, the way the
  module call judges its types'. It waits for `--polysemy` to show how often
  a human disagrees with the obvious reading.
- **A glossary without explaining** — a request per scope over a term table.
  Cheaper, and context-poor by construction: a word's meaning asked at the
  altitude of a scope instead of the entity that uses it. Waits for a corpus
  nobody can explain but everybody wants to count.
- **Deterministic compounds** (n-grams over adjacent tokens of one name:
  `order line item`). A counting pass would need its own weight rule.
- **A Specy `.domain` file as the drift input** — its ubiquitous language is
  the business glossary a plain list approximates. The skill that reads
  side-cars lives in another repository; the plain list ships first.
- **History joins** (who speaks which words, when a word entered the
  corpus): the `history-metrics` side-car and `snapshots` make it a join, not
  a feature of this phase.
