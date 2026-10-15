---
title: Metrics catalogue
linkTitle: Metrics catalogue
weight: 15
---

Every measure a model or its side-car can carry — what it counts, who writes it, where it comes from and how to read it. Three readers of source write measures, and nothing else does:

| Writer | Keys | Where |
|---|---|---|
| **the extractor** — its own parser, every language | `sloc`, `cyclomatic` | the entity's `metrics` map in `model.jsonl` |
| **the [metrics pass](/docs/reference/metrics-pass/)** — [big-code-analysis](https://github.com/dekobon/big-code-analysis) 2.2.0 as a library, joined to the model on anchors | `cognitive`, `nexits`, `abc.*`, `lloc`, `cloc`, `halstead.*`, `mi`, `npm`, `npa` | the same map |
| **the pass with `--history`** — big-code-analysis's git measures | twenty `vcs` measures, per file and per entity | the side-car [`history-metrics.jsonl`](/docs/reference/artifacts/history-metrics-jsonl/) |

The definitions of everything the pass writes are big-code-analysis's — its [code metrics](https://dekobon.github.io/big-code-analysis/metrics.html) and [change-history metrics](https://dekobon.github.io/big-code-analysis/metrics-vcs.html) chapters are the primary source, pinned at `=2.2.0` so a bump is a reviewed snapshot diff and never a silent change of meaning. What this page adds is codegraph's side of each number: the key it lands under, which entity it is charged to, what each of the five languages counts, and what big-code-analysis computes that codegraph deliberately leaves out.

Four rules to read every number by:

- **A measurement, not a verdict.** None of these measures correctness or skill. The question is always "compared with what" — this type against its siblings, this module against last quarter's. The thresholds quoted below are the literature's rules of thumb, repeated here so a reader has them, not gates.
- **Absence means "not measured", never zero.** A key missing from an entity's map is a statement that nothing measured it; a `0` is a measurement. No consumer may default one into the other — [Measures and literals](/docs/reference/metamodel/measures-literals/).
- **Charged keys add up; span keys do not.** A *charged* key counts the entity's own code plus every nested function the model does not name, so `sum:cognitive` over a building counts each piece of code once. A *span* key is computed over the entity's whole text, nested functions included, so `sum:mi` is a number with no meaning: read span keys with `attribute:`. The [metrics pass](/docs/reference/metrics-pass/#what-it-writes) page says how the join decides which an entity gets.
- **Composite scores are ordinal.** `mi` and `risk_score` are rulers, not thermometers: rank by them, within one corpus.

## At a glance

| Key | Writer | Family | Unit | What it counts | Origin |
|---|---|---|---|---|---|
| `sloc` | extractor | span | lines | lines in the span that are neither blank nor comment-only | Conte, Dunsmore & Shen, 1986 |
| `cyclomatic` | extractor | charged | branches + 1 | 1 + decision points, per invocable | McCabe, 1976 |
| `cognitive` | pass | charged | increments | breaks in linear flow, each weighted by its nesting | Campbell, SonarSource, 2017 |
| `nexits` | pass | charged | exits | explicit returns and throws | structured-programming literature |
| `abc.assignments` | pass | charged | count | stores into a variable | Fitzpatrick, 1997 |
| `abc.branches` | pass | charged | count | calls and object creations | Fitzpatrick, 1997 |
| `abc.conditions` | pass | charged | count | boolean tests | Fitzpatrick, 1997 |
| `abc.magnitude` | pass | charged | — | √(A² + B² + C²) | Fitzpatrick, 1997 |
| `lloc` | pass | span | statements | statement-bearing lines | Conte, Dunsmore & Shen, 1986 |
| `cloc` | pass | span | lines | lines holding a comment | Conte, Dunsmore & Shen, 1986 |
| `halstead.volume` | pass | span | bits | N · log₂ n over operators and operands | Halstead, 1977 |
| `halstead.difficulty` | pass | span | — | (n₁ / 2) · (N₂ / n₂) | Halstead, 1977 |
| `halstead.effort` | pass | span | — | difficulty · volume | Halstead, 1977 |
| `mi` | pass | span | 0–100 | maintainability index, Visual Studio form | Oman & Hagemeister, 1992; Coleman et al., 1994 |
| `npm` | pass | span, types | methods | public methods declared directly in the type | Lorenz & Kidd, 1994 |
| `npa` | pass | span, types | attributes | public attributes declared directly in the type | Lorenz & Kidd, 1994 |

The twenty change-history measures are indexed [below](#change-history-metrics) and listed with their levels on the [side-car's page](/docs/reference/artifacts/history-metrics-jsonl/#measures).

## Lines of code

big-code-analysis counts five kinds of line, from one pass over the syntax tree — comments and strings are recognised as nodes, not by scanning text, so a multi-line string or a doc comment is counted right:

| big-code-analysis | Counts | In codegraph |
|---|---|---|
| **SLOC** | every line of the span, blank, comment and code alike | not a measure: it is the anchor's length, `end − start + 1`, computable from `TSourceAnchor` alone — the city's `loc` source |
| **PLOC** | lines that are neither blank nor comment-only | the extractor's **`sloc`**, by the same definition. The pass checks the two agree on every exact join — the `sloc = bca ploc` witness in its report |
| **LLOC** | lines carrying a statement — a definition, an assignment, a declaration; what counts as a statement is defined per language | **`lloc`** |
| **CLOC** | lines holding a comment, alone or beside code | **`cloc`** |
| **BLANK** | whitespace-only lines | not carried |

`SLOC = PLOC + BLANK + comment-only lines`, and `CLOC ≥ comment-only lines`. Two names collide across the two tools: codegraph's `sloc` is big-code-analysis's *PLOC* (the model's name predates the pass and keeps METAMODEL's definition), and what big-code-analysis calls *SLOC* is the anchor's gross length. The city's `loc` reads the latter; the two claims — how much is written here, how much of it is code — are never conflated.

**Reading it.** `sloc` is the size proxy; `lloc` the statement count, the right denominator when comparing a dense language with a verbose one; `cloc / sloc` a rough comment density. All are sensitive to style — a tenfold difference in formatting habits is a twofold difference in lines — which is why the rest of this page exists.

## Cyclomatic complexity

McCabe's 1976 measure: the number of linearly independent paths through a function, which is also the smallest number of tests that cover every branch. Computed as **1 + the number of decision points**: `if` and `else if`, `?:`, each non-default `case`/`when` arm, every loop, each `catch`, each short-circuit `&&`/`||` (and their word spellings, `and`/`or`), a pattern guard.

**In codegraph** the key is the **extractor's own `cyclomatic`**, measured by its parser per invocable with METAMODEL's definition; a lambda's branches belong to the lambda, which is its own invocable. The pass never writes or touches it. big-code-analysis's own cyclomatic is used inside the pass — summed over a span, it is the *G* of the maintainability index — but is not emitted beside the extractor's. Two of its variants are not carried at all: the *modified* cyclomatic that collapses every arm of one `switch` into a single decision, and the Rust `?` policy, which has no language here.

**WMC, for free.** Chidamber and Kemerer's *Weighted Methods per Class* is the sum of cyclomatic complexity over a class's methods. big-code-analysis emits it per file; codegraph does not carry it as a key because the city computes exactly it: `--height sum:cyclomatic` is a building's WMC, charged so that a closure nobody names counts once, in its method.

**Reading it.** McCabe's bound, kept by NIST's *Structured Testing* report, is 10 per function. The blind spot is that every decision weighs the same: a 30-arm `switch` and three nested `if`s score alike, which cognitive complexity was designed to fix.

## Cognitive complexity — `cognitive`

Campbell's 2017 SonarSource measure of how hard a function is to *read*, as opposed to how hard it is to test. Three rules, applied walking the tree from zero:

1. **Shorthand control flow is ignored** — a flat `if`, a plain `else`, the head of a `for`, a `?:` each add their baseline +1 and nothing more.
2. **Breaks in linear flow pay** — every `if`, `else if`, `else`, `switch`, `try`/`catch`, loop, jump (`goto`, labelled `break`/`continue`) and recursive call adds at least +1.
3. **Nesting pays again** — control flow inside an already-nested block adds +1 *per level*: an `if` in a `for` in an `if` scores 1 + 2 + 3 = 6 where the same three constructs in a row score 3.

A run of one boolean operator (`a && b && c`) scores +1 for the whole run; switching operators (`a && b || c`) adds another, because that is where the reader's load jumps. A *nested function* — a local function, a method of an inner class — resets the nesting to zero at its boundary; a *lambda* does not, it adds a surcharge on top of the enclosing nesting, so a decision inside a lambda inside an `if` pays for both.

**In codegraph** `cognitive` is **charged**: present whenever the entity joined, over several spaces too (an Elixir function's clauses add up). The pass writes the per-function score; big-code-analysis's file-level `sum`, `min`, `max` and `average` are not carried — the city's `sum:cognitive` over a building, or the analyzer's own folds, replace them. **Elixir** scores no recursion and no jump increments: its control flow is macro calls rather than grammar productions and it has no `break`/`continue`/`goto`, so only the nesting-bearing constructs are scored, and an Elixir number is a little lower than the same shape would score elsewhere.

**Reading it.** `0` is a linear function. SonarSource flags a function above **15**; Campbell's own guidance is that one should rarely exceed about **25**. Because nesting is what it punishes, a high score points at the refactoring that helps — an early return, an extracted method — which is why it is the headline number of `codegraph serve --height sum:cognitive`.

## ABC — `abc.*`

Fitzpatrick's 1997 *size* measure — not a complexity measure: a long, flat function that assigns a lot scores high — as a three-component vector:

| Component | Counts |
|---|---|
| **A**ssignments | `=`, every compound assignment (`+=` … `>>>=`), `++`/`--`, an initialising constructor invocation |
| **B**ranches | function and method calls, `new` (and C++'s `delete`), labelled `break`/`continue`/`goto` — "branch" means control branching out to other code, not a conditional jump |
| **C**onditions | comparison operators, `?:`, `else`, `case`, `try`, `catch`, and each operand of a `&&`/`\|\|` chain that no other rule already counts (Fitzpatrick's *unary conditional*). The `default`/`_` arm is never counted, in any language |

The `&&`/`||` operator itself counts nothing; its non-comparison operands count one each, so `if (x || y)` is two conditions and `(a >= 0 && a <= 15) ? '/' : 'C'` is three. That is the paper's rule, shared with abcmeter and python-abc, and the single largest source of disagreement with RuboCop's `Metrics/AbcSize`, which counts `and`/`or` directly: a Ruby number from the pass is not RuboCop's. A boolean *slot* — an `if`/`while`/`for` predicate, a guard, a ternary's condition — pays one condition unless something inside it already does, so `if flag` and `if a == b` both score one.

**In codegraph** the four keys are **charged**; `abc.magnitude` is √(A² + B² + C²) of the charged components, so for an entity over several spaces it is the magnitude of the summed vector. big-code-analysis's per-component averages and file-level min/max are not carried. What each language counts, beyond the common rules:

| Language | Notes |
|---|---|
| Java | a `switch` pattern guard is a condition slot; the wildcard bound `? extends T` is not a ternary; generics' `<`/`>` are not comparisons; `try` and `catch` both count; labelled `break`/`continue` are branches |
| C# | a `when` guard and a `catch` filter are condition slots; a relational pattern's operator (`x is > 0`) is not counted again, the slot pays; `int?` is not a ternary but `a?.b` shares the token and counts; generics excluded as in Java |
| TypeScript | optional `?` on parameters, properties and tuple elements, and conditional types `T extends U ? X : Y`, are type syntax and count nothing; type-argument brackets are not comparisons |
| Elixir | an `if`/`unless` predicate and each `cond` clause are slots; the clauses of `case`, `with … else`, `receive` (its `after` included), `try`'s `rescue`/`catch`/`else`, and a multi-clause `fn` score one each — a bare `_ ->` catch-all nothing; each `<-` clause of a `with` is a condition; `else` of an `if` is Fitzpatrick's `else`; `in` counts by use; no ternary, no `try` keyword of its own; sigil delimiters are not comparisons |
| Ruby | `rescue` plays `catch`; a bare predicate (`if flag`, `x if flag`, `while running`) is one condition; a subject-less `case` scores each `when` pattern as an `\|\|` operand, a subject-ful `case` scores one per clause; `class Foo < Bar` and `def <(other)` are not comparisons |

**Reading it.** Fitzpatrick's advice is a relative ruler: rank the functions of a file by magnitude and read the top decile. The Ruby community, where ABC is most used (RuboCop, flog), treats a magnitude above about **17** as a refactoring candidate and above **30** as hard to maintain; expect higher norms in Java and C#, which assign more explicitly.

## Exits — `nexits`

The number of explicit exit points of a function: every `return`, every `throw`/`raise`, every `yield` that hands control back. The implicit fall-through return at the end of a body is not counted. From the structured-programming literature's single-entry-single-exit rule, which modern practice has relaxed into "a few guard clauses are good, many exits are a split waiting to happen".

**In codegraph** `nexits` is **charged**. What counts, per language:

| Language | Counted as an exit |
|---|---|
| Java | `return`, `throw`, a switch expression's `yield` |
| C# | `return`, `throw` as a statement or as an expression, `yield` |
| TypeScript | `return`, `throw`, `yield` |
| Elixir | there is no `return`: `throw`, `raise`, `reraise`, `exit` |
| Ruby | `return`; `raise`, `exit` and `exit!` called bare or on `Kernel` — not `fail`, `abort`, `throw` or an argument-less re-raise inside `rescue`, which the grammar cannot tell from a variable read |

**Reading it.** `2–4` is usually a good sign — guard clauses, then a flat body. Above about **8** the function wants splitting. MISRA C and DO-178C still require exactly 1.

## Halstead — `halstead.*`

Halstead's 1977 *software science*: reduce a program to its tokens, split them into **operators** (what does something — keywords, operators, assignment, call syntax, flow punctuation) and **operands** (what is something — identifiers and literals), count four things, derive the rest:

```text
n1  distinct operators        N1  operator occurrences
n2  distinct operands         N2  operand occurrences

vocabulary                n  = n1 + n2
length                    N  = N1 + N2
estimated length          N̂  = n1·log₂(n1) + n2·log₂(n2)
purity ratio                 = N̂ / N
volume                    V  = N · log₂(n)                   bits
difficulty                D  = (n1 / 2) · (N2 / n2)
level                     L  = 1 / D
effort                    E  = D · V                         elementary mental discriminations
time                      T  = E / 18                        seconds (Stroud's number)
bugs                      B  = E^(2/3) / 3000                estimated delivered defects
```

Classification is a choice, not a consequence, and big-code-analysis's choices are worth knowing: a bracket pair is one operator billed at its opener, as is a generic list's `<>`; a literal's own delimiters, a string interpolation's opener (`#{}`, `${}`, `$"…"`) and closing brackets count nothing; `this`/`self`/`super` are operands; type names are operands and type-declaration keywords operators; an alternative spelling (`and` beside `&&`) is an operator of its own; only written tokens count, never one tree-sitter's error recovery inserted. Per language: Java bills `abstract` and `final` but no visibility keyword or `static`, C# every modifier, TypeScript its type-level keywords (`type`, `declare`, `satisfies`, `keyof`, `infer`); Elixir treats a named operator (`&==/2`) as one operand; Ruby's `def [](i)` bills `[]` as its own operator.

**In codegraph** three derived values are carried, as **span** keys: `halstead.volume`, `halstead.difficulty`, `halstead.effort`. Level, time and bugs are arithmetic on those (`1 / difficulty`, `effort / 18`, `effort^(2/3) / 3000`); the four base counts, vocabulary, length, estimated length and purity are not carried and cannot be recovered from the three.

**Reading it.** Volume is the one that has held up — a language-independent size in bits that scales more smoothly than lines — and it is the input of the maintainability index. Difficulty breaks ties between two refactoring candidates of equal cyclomatic complexity. Time and bugs are Halstead's most criticised predictions; treat them as curiosities.

## Maintainability index — `mi`

Oman and Hagemeister's 1992 composite, refined by Coleman, Ash, Lowther and Oman in 1994: regression-fitted on Hewlett-Packard systems against expert ratings, and what survived was Halstead volume, cyclomatic complexity, line count and comment density. big-code-analysis reports the three forms that stuck:

```text
mi.original      = 171 − 5.2·ln(V) − 0.23·G − 16.2·ln(L)
mi.sei           = 171 − 5.2·log₂(V) − 0.23·G − 16.2·log₂(L) + 50·sin(√(2.4·C))
mi.visual_studio = max(0, mi.original · 100 / 171)
```

with *V* the span's Halstead volume, *G* big-code-analysis's cyclomatic complexity summed over the span, *L* the span's line count (every line, blank and comment included — big-code-analysis's *SLOC*) and *C* its comment percentage in `[0, 100]`.

**In codegraph** `mi` is the **Visual Studio form**, a **span** key: `0–100`, clamped. The original (which can go negative) and the SEI form are not carried. big-code-analysis answers `0.0` when a span has no volume or no lines — a body-less declaration — and the pass writes *nothing* there, since "not applicable" is spelled as absence. It is not additive: `attribute:mi`, never `sum:mi`.

**Reading it.** Visual Studio's traffic light: **green at 20 and above, yellow from 10, red below**. Designed as a portfolio-level score — it drifts down before a system turns legacy — and best read as a smoke detector: a sudden drop on a type is the signal, the absolute number is noisy, and van Deursen's *Think Twice Before Using the Maintainability Index* is the standard caution.

## Public methods and attributes — `npm`, `npa`

Lorenz and Kidd's 1994 class-size measures, later folded into the MOOD suite: the number of public methods and the number of public attributes (fields, properties, instance variables) a class or interface declares *directly* — inherited and nested members are not its own. `npm` is the public interface's size; `npa` is a direct measure of broken encapsulation, since every public attribute is state the class can neither validate nor evolve without breaking callers.

**In codegraph** both are **span** keys written on **types only** — the class, interface, record, enum, module or struct the join paired with a container space — as the sum of big-code-analysis's class and interface counts. A method's map never carries them. What each language calls public, and what it calls a method or an attribute:

| Language | `npm` counts | `npa` counts |
|---|---|---|
| Java | methods and constructors with the `public` modifier; every member of an interface or annotation, and of an enum body | fields with the `public` modifier; interface constants. A record's components are not counted |
| C# | methods, constructors, operators and conversions marked `public`; each accessor of a public property or indexer (`get`, `set`, `init`) as one method, minus those narrowed to `private`/`protected`; an expression-bodied property as one; interface members | `public` field declarators; interface fields. A positional record's parameters are not counted |
| TypeScript | class members without `private` or `protected`: methods, constructors, getters and setters each, abstract signatures, arrow-function fields; interface method and construct signatures. Overload signatures are not counted | class fields without `private`/`protected`, constructor parameter properties, interface property signatures |
| Elixir | a `defmodule` is the class: `def` and `defmacro` are public, `defp` and `defmacrop` are not | its `defstruct` fields, every one public |
| Ruby | `def` and `def self.` written directly in a `class` body while the running visibility is public — a bare `private`/`protected` keyword flips it for what follows; `private :foo` and `private def foo` do not | `attr_accessor`/`attr_reader`/`attr_writer` symbols and `@x =`/`@@x =` assignments in the class body, under public visibility |

**Ruby modules carry 0.** big-code-analysis treats a `module` body as a namespace, not a class, so a module's `npm` and `npa` are `0` however many methods it defines — a measurement, by its rule, not an absence. For the methods a Ruby module (or any type) holds, read the city's built-in `methods` source or the navigator's tree, which count the model's own children.

**Reading it.** Lorenz–Kidd: at most **20** methods per class, above **40** a strong refactoring candidate; the same rule bites hardest on interfaces, where the contract is what clients pin against. Keep `npa` at or near **zero** — Meyer's uniform access principle. The pair is an API-surface tracker: a library type whose `npa` grows is accumulating breaking-change liability faster than its method surface.

## What is not carried, and what to read instead

big-code-analysis computes more than the pass writes. Each omission has a reason, and most have a codegraph counterpart that already exists:

| big-code-analysis | In codegraph |
|---|---|
| SLOC (every line), BLANK | the anchor's length is the city's `loc`; blanks are not carried |
| PLOC | the extractor's `sloc` |
| modified cyclomatic, the Rust `?` policy | not carried; one `cyclomatic`, the extractor's |
| **NArgs** — parameters per callable | the model names each parameter as an entity under `TWithParameters`: count an invocable's `parameter` children. Not a key |
| **NOM** — methods and closures per container | the model's own children: the city's `methods` source, the navigator's tree. `npm` is the public subset |
| **WMC** — cyclomatic summed over a class's methods | `sum:cyclomatic` over a building |
| **Tokens** — leaf-token count | not carried |
| Halstead's base counts, vocabulary, length, estimated length, purity; level, time, bugs | the first group is not carried; the second is arithmetic on `halstead.effort` |
| `mi.original`, `mi.sei` | not carried; `mi` is the Visual Studio form |
| NPA's and NPM's density ratios (`cda`, `coa`), the all-members counts | not carried |
| file-level roll-ups: `sum`, `min`, `max`, `average` of every metric | a module anchored on a whole file (an Elixir or Ruby file, a TypeScript module) joins the file space and carries the span and charged keys like any entity; everything else is a fold the city (`sum:`) or the analyzer does over the model's own structure |

The rule behind the table: the pass writes what a *source reader* alone can know and the model cannot restate. A count the model already holds structurally — parameters, members, children — is derived in memory from the model, never duplicated as a number that could drift from it.

## Change-history metrics

`codegraph-metrics --history` runs big-code-analysis's `vcs` family over the repository the sources live in and writes the result to the side-car [`history-metrics.jsonl`](/docs/reference/artifacts/history-metrics-jsonl/) — never into the model, because a model describes the code at one commit and its bytes must not change because time passed ([Time as structure](/docs/explanation/time-as-structure/)). These signals come from the defect-prediction literature, whose consistent finding is that *process* — how a file has been edited — out-predicts *product* measures like size or complexity. None measures correctness; they rank files by where a bug is likely hiding.

How the walk is set up, and where codegraph departs from big-code-analysis's defaults:

- **Two windows**, counted back from the measured commit's own committer time, never the wall clock: **long = 365 days**, **recent = 90 days**. The side-car's header records both.
- **The whole commit graph**, not big-code-analysis's first-parent default: a commit a merge brought in counts — on BroadleafCommerce that is 65 % of them — so the file level and the blame level see the same commits. Merge commits themselves are excluded (their diff repeats their parents'). Renames are followed.
- **Authors** are canonicalised through `.mailmap` and counted by lowercased e-mail; `Co-authored-by:` trailers add participants; bots are excluded (`dependabot[bot]`, `renovate[bot]`, `github-actions[bot]`, `pre-commit-ci[bot]`, `mergify[bot]`, `pyup-bot`).
- **Two levels, two methods.** A **file** is measured from the walk: every in-window commit that touched it. An **entity** is measured from one `git blame` of its file, over the lines of its span that *survive* at the commit, each credited to the commit that last touched it. The two are different quantities and are kept under different names where they would otherwise collide.

| Measure | File (the walk) | Entity (blame) |
|---|---|---|
| `commits_long`, `commits_recent` | distinct commits touching the file in the window | distinct commits that last touched one of its surviving lines, in the window |
| `churn_long`, `churn_recent` | lines added plus deleted, summed over the window's commits — a one-line edit is 2 | — (never defined per entity) |
| `lines_long`, `lines_recent` | — | its surviving lines last changed in the window: a line rewritten ten times counts once, a line added then deleted counts not at all |
| `authors_*`, `ownership_top_share` | per touching commit | per touching commit, so ownership is by commit count, not by surviving-line share |
| `age_days`, `last_modified_days` | from the in-window commits' times | the same, over the surviving lines' commits |
| `change_entropy_*`, `cochange_entropy_*` | from the walk | — (blame cannot see what else a commit touched) |
| `risk_score` | the weighted formula | the same formula over the entity's signals, with `lines_*` in churn's place and both entropies at zero |

A file whose bytes at the commit differ from what the extractor read keeps its file record and gets no entity records — its anchors and the blamed lines would describe different text.

### Commit frequency — `commits_*`

How many distinct commits touched it in each window. Graves, Karr, Marron and Siy, 2000: on a large switching system the count of prior changes predicted faults better than any measure of the code itself — a file nobody touches is a file nobody is breaking. A commit that touches a file in three hunks counts once. **Reading it:** a rate, meaningful against a baseline (siblings, last quarter); pair it with churn to tell heavy edits on few commits from light edits on many.

### Code churn — `churn_*` · surviving lines — `lines_*`

The volume of change. Nagappan and Ball, 2005: absolute churn predicts little, churn *relative* to size and to its spread in time predicts defect density well, which is why the raw windowed count is kept and the composite does the combining. Per file it is added plus deleted lines; per entity, blame can only count what survives, hence the separate `lines_*` keys. **Reading it:** the numerator of a density — churn per commit distinguishes steady editing from a few rewrites, churn against `sloc` recovers the relative measure.

### Burst — `burst`

`commits_recent / commits_long`, in `[0, 1]`: the share of the file's activity that is recent. Near 1, nearly everything happened in the last 90 days; near 0, it was active long ago and has gone quiet. **Reading it:** a tie-breaker. A high burst on a young file is a file being written; a high burst on an old one is a file that woke up, which is the interesting case — read it with `age_days`.

### Authorship and ownership — `authors_*`, `ownership_top_share`

Distinct people who touched it per window, and the top author's share of the window's edits, in `[0, 1]`. Bird et al., 2011, on Windows Vista and 7: diffuse ownership — many minor contributors, a low top share — predicts both pre-release faults and post-release failures. Meneely and Williams, 2009, on RHEL 4: files touched by nine or more developers were about sixteen times likelier to hold a vulnerability. **Reading it:** a rising author count on an old file is knowledge diffusing. The risk score scales the author term by `1 − ownership_top_share` and bumps it at six and nine authors, encoding both findings.

### Fix, security and revert commits — `*_fix_commits`, `revert_commits`

Long-window commits classified by their **message** — the lightweight half of Śliwerski, Zimmermann and Zeller's 2005 SZZ, without the blame-back to the inducing commit. A file that has needed many fixes is likely to need more; a security fix is a sharper signal; a revert marks a change that had to be undone. The classifier is keyword-based, word-bounded and tuned for precision over recall:

| Count | Message matches |
|---|---|
| `bug_fix_commits` | `fix`/`fixes`/`fixed`/`fixing`, `bug`/`bugfix`/`bugs`, `defect`, `hotfix`, `regression`, `fault`, `crash` — anywhere in the message, case-insensitive; "prefix" and "suffix" do not match |
| `security_fix_commits` | `security`, `vulnerability`/`vulnerabilities`/`vuln`, `exploit`, `sanitize`/`sanitization`, `insecure`, `xss`, `csrf`, `rce`, `disclosure`, `malicious`, `hijack`, `spoof`, `sql`/`command`/`code`/`html`/`ldap`/`os`/`xml` `injection`, `buffer`/`heap` `overflow`, `CVE-yyyy-n`, `CWE-n`. Bare "injection" and "integer overflow" are deliberately not matched |
| `revert_commits` | a **subject** starting with `revert` or `rollback` — git's own revert subject; a mention in the body does not count |

**Reading it:** accuracy tracks commit hygiene — terse or templated messages under-count. These are the labelled heuristics the side-car page warns about: inferences about how people worked, kept out of the model for the same reason co-change is.

### Age and last modified — `age_days`, `last_modified_days`

Days from the measured commit back to the file's *first* in-window commit, and to its *most recent* one, both capped at the long window. A file with no commit in the window reads **365** on both: "nothing in the window", not "one year old". New code is where the just-in-time line and Chromium's own defect analysis found elevated risk — a file first seen inside the recent window earns the score's new-file bonus. **Reading it:** `last_modified_days` is staleness — a risky file untouched for months is a different maintenance proposition from one open on someone's screen today.

### Change entropy — `change_entropy_*`

Hassan's 2009 *history complexity metric*, in bits: for each commit, the Shannon entropy of how its churn spread across the files it touched (0 for a one-file commit, approaching log₂ n for n files evenly); each file is credited its share, `pᵢ · H`, and shares are summed per window. A file repeatedly caught up in sprawling, cross-cutting commits accumulates; one that changes in focused commits stays low. Hassan found it predicts faults better than change counts; later work measured a Pearson correlation up to 0.54 with defects on eight Apache projects. **File level only.**

### Co-change entropy — `cochange_entropy_*`

From the 2025 *Co-Change Graph Entropy* study (arXiv 2504.18511): build the graph whose edges join files that changed in the same commit, weighted by how often; a file's co-change entropy is the Shannon entropy of its edge weights — low when it always changes with the same one partner, high when its edits ripple across many. Adding it to change entropy improved AUROC in 82.5 % of cases on the same eight projects. Bulk commits touching more than 1 000 files are left out of the graph. A computed `0.0` is a file with no co-change partner in the window — a measurement. **File level only.** This is the quantitative cousin of the analyzer's own [co-change joins](/docs/how-to/history-joins/), which name the partners rather than count the spread.

### Risk score — `risk_score`

big-code-analysis's composite, formula version 2 — a log-scaled weighted sum with categorical bumps, each term grounded in a paper above:

```text
base = 0.30 · ln(1 + churn_recent)
     + 0.25 · ln(1 + commits_recent)
     + 0.15 · ln(1 + commits_long)
     + 0.15 · ln(1 + authors_long) · (1 + dilution)
     + 0.10 · ln(1 + bug_fix_commits + 2 · security_fix_commits)
     + 0.05 · ln(1 + churn_long)
     + 0.10 · change_entropy_recent + 0.05 · cochange_entropy_recent
     + ln(1 + sloc)² / 100

dilution   = 1 − ownership_top_share
risk_score = base · (1 + dev_bonus + new_file_bonus)
```

`dev_bonus` is 0.35 at nine or more long-window authors and 0.15 at six or more; `new_file_bonus` is 0.15 for a file first seen inside the recent window. The size term is not a tie-breaker: about 0.85 at 10 000 lines and past 1.0 at 50 000, comparable to the churn terms. Per **entity** the same formula runs over the blame's signals — `lines_*` where churn stands, the span's own line count as `sloc`, both entropies zero — so a type's score and a file's are rank-comparable but computed from different evidence.

**Reading it:** **ordinal**. Sort a corpus's files or types by it and read the top of the list; never compare a raw score across repositories or read it as a probability. In the city it is a `--carry`: `--carry history:risk_score` puts a type's rank in its panel while height and footprint show the measures it was built from.

### Not carried

| big-code-analysis | Why, and what instead |
|---|---|
| **hotspot score** — Tornhill's complexity × recent churn | not computed. The city puts both factors on one building — `--height sum:cognitive --footprint history-file:churn_recent` — and the hotspots are the tall, wide ones |
| **bus factor** — Avelino et al.'s truck factor per directory | an aggregate over a set of files, with no entity to attach to; not carried |
| **just-in-time commit score** — Kamei et al.'s per-commit risk | scores a commit, not a file or an entity; the side-car is measured at one commit |
| the **percentile** risk formula, `bca vcs trend` | not carried; the weighted formula only, at the model's commit. A series over commits is [`snapshots`](/docs/reference/cli/snapshots/)' job, and it does not run the pass |
| `risk_score_version` | the header's `generatedBy.bigCodeAnalysis` version pins it |

## See also

[Metrics pass](/docs/reference/metrics-pass/) · [Measures and literals](/docs/reference/metamodel/measures-literals/) · [City metrics](/docs/reference/city-metrics/) · [history-metrics.jsonl](/docs/reference/artifacts/history-metrics-jsonl/) · [How to measure complexity and change history](/docs/how-to/measure-metrics/) · big-code-analysis: [code metrics](https://dekobon.github.io/big-code-analysis/metrics.html), [change-history metrics](https://dekobon.github.io/big-code-analysis/metrics-vcs.html), [supported languages](https://dekobon.github.io/big-code-analysis/languages.html)
