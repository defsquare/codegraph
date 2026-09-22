---
title: Discovering a codebase
linkTitle: Discover
weight: 5
cascade:
  type: docs
---

You have been handed a codebase you did not write. It might be an acquisition,
a system whose authors have left, a legacy application to migrate, or a vendor
delivery you have to take over. You cannot read it all. The question is not
"what is in it" but **where do I start, what matters, and what does it mean**.

This section is a walk through that question, in six smaller questions asked
in a fixed order. Each page states the question in plain words, explains the
few concepts it needs, gives the codegraph commands that answer it today, shows
what the output looks like and how to read it, and says honestly where the tool
stops and where you, or a language model, take over.

## The six questions

| # | Question | What you get | How | Today |
|---|---|---|---|---|
| 1 | [**Structure and elements**](/docs/discover/structure/) — what is here, how big, how branchy, how tangled? | counts, sizes, complexity, cycles, a city | extract, `analyze`, SQL, `serve` | ready |
| 2 | [**Boundaries and style**](/docs/discover/boundaries/) — how is it cut, in which style, and do the cuts hold? | the module map, the stack, the framework roles | `export`, SQL, `--framework spring` | ready, with ad-hoc queries |
| 3 | [**Activity**](/docs/discover/activity/) — where does the effort go, who spends it, what changes together? | hotspots, owners, hidden coupling, dead weight | `scm`, `history` | ready |
| 4 | [**Stimuli and flows**](/docs/discover/stimuli/) — what reacts to the outside world or to time, and what does each reaction reach? | an entry-point inventory and the chain each one runs | SQL, the navigator | partly: Spring only, chains by query |
| 5 | [**Meaning**](/docs/discover/meaning/) — what does each unit do, in domain words? | one explanation per method, type and module | `explain` | ready, costs money |
| 6 | [**Domain**](/docs/discover/domain/) — which part is the business, and what is its model? | a `.domain` model and a refactoring report | `domain-facts` + the Specy skill | ready, not yet fed by step 5 |

The **Today** column is the honest state of the tooling. "Ready" means one
command gives the answer. "Ad-hoc queries" means the answer is a SQL query over
the model, and this section gives you the query. "Partly" means part of the
answer is automated and the rest is described so you can do it by hand.

## Why this order

The first three questions are **cheap and deterministic**: extraction runs in
seconds, history mining in seconds, and the same input gives the same output
every time. They frame everything that follows, and their result is a short
ranked list of places worth attention.

The last three are **expensive or probabilistic**: an explanation run calls a
language model and costs money; a domain model is a judgement. They come last
so they can be **scoped by what the earlier steps ranked**. You explain the
hotspots first and the long tail only if budget remains.

You will keep a small notebook as you go. Each page ends with the two or three
numbers or lists worth writing down, because the next page uses them.

## Three habits that make the result trustworthy

**Keep facts and inferences apart.** Codegraph labels every dependency with
how it was obtained: `declared` (written in the source), `derived` (computed
from written facts by a stated rule), or `dynamic-candidate` (a plausible
runtime wiring, such as a Spring injection). Co-change from git history is a
fourth kind of knowledge, and an explanation from a model a fifth. When you
write a conclusion down, say which kind it rests on. A report that needs
certainty filters on `declared`; see
[Facts and inferences never mix](/docs/explanation/facts-vs-inferences/).

**Anchor every claim.** Every entity and every edge in a model carries a file
and a line span. A finding without an anchor is an opinion; with one it can be
checked in a minute. The navigator opens the source line behind every
dependency for exactly this reason.

**Do not rank by size alone.** A large ugly class nobody has touched in three
years costs nothing today. A medium class changed every week by three people is
where the money goes. Structure (step 1) says what is complex; activity (step
3) says what is worked on; only the overlap, the **hotspots**, deserves the
first hours of reading.

## Words used in this section

- **Module.** The unit of code organisation the language has: a Java package,
  a C# namespace. Codegraph folds dependencies up to it.
- **Type.** A class, interface, enum, record or annotation.
- **SLOC.** Source lines of code, blank lines and comments excluded. The Java
  extractor measures it per type and per method.
- **Cyclomatic complexity.** The number of independent paths through a
  method: roughly one plus its `if`, loop, `case`, `catch` and boolean
  operators. A method at 1 is straight-line code; above 10 it is hard to test
  exhaustively. Measured per method; summed per type by the tools.
- **Strongly connected component (SCC), or tangle.** A group of modules or
  types that all depend on each other, directly or through others, so no
  member can be changed, tested or extracted without the rest. The single
  most important structural fact about a codebase.
- **Fan-in and fan-out.** How many things depend on a node, and how many it
  depends on. High fan-in is load-bearing; high fan-out is fragile.
- **Stub.** An entity the corpus references but does not declare: the JDK,
  a framework, a vendor library, or a missing module. Stubs are kept with
  their edges so the picture stays honest about what is outside.
- **Provenance.** The label on every edge saying how it was obtained (see the
  first habit above).
- **Hotspot.** Code that is both complex and frequently changed.
- **Co-change.** Two files that appear in the same commits more often than
  chance: an inference about how people work, not a fact about code.
- **Entry point.** Code that runs because something outside called it: a
  REST endpoint, a message listener, a scheduled job, `main`.
- **Side-car.** A file written beside the model and never into it, such as
  the explanations `explain` produces.

## What you need

- The `codegraph` command and the extractor of your language, both from the
  Homebrew tap: see [Install](/docs/how-to/install/). The
  [Java](/docs/reference/java-extractor/) and
  [C#](/docs/reference/csharp-extractor/) extractors are self-contained
  binaries; the [TypeScript one](/docs/reference/typescript-extractor/) runs
  on Node 22.
- `sqlite3` on your path for the ad-hoc queries. Any SQLite client works;
  DuckDB and Datasette are shown in [Query model.db](/docs/how-to/query-model-db/).
- For step 3, a git clone with its history, not an exported tree.
- For step 5, an API key on OpenRouter or a Cloudflare AI Gateway.

Start with [Structure and elements](/docs/discover/structure/).
