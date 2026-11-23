# Words used in the walk

These are the definitions of the documentation, word for word
(https://codegraph.biz/docs/discover/#words-used-in-this-section). Use them as
written the first time a term comes up, one sentence at a time, and add the
term to `taught` in the state: a term is defined to a person once.

- **Module.** The unit of code organisation the language has: a Java package,
  a C# namespace, a file in TypeScript, Elixir and Ruby. Codegraph folds
  dependencies up to it.
- **Type.** A class, interface, enum, record or annotation; also a C# struct,
  a TypeScript type alias, an Elixir module or protocol, a Ruby class or
  module. Whatever its kind is called, it carries the trait `TType`.
- **SLOC.** Source lines of code, blank lines and comments excluded. Every
  extractor measures it per type and per method.
- **Cyclomatic complexity.** The number of independent paths through a
  method: roughly one plus its `if`, loop, `case`, `catch` and boolean
  operators. A method at 1 is straight-line code; above 10 it is hard to test
  exhaustively. Measured per method; summed per type by the tools.
- **Cognitive complexity.** How hard a method is to read rather than to test:
  every branch counts, and counts more the deeper it is nested. Added per
  method by the [metrics pass](https://codegraph.biz/docs/reference/metrics-pass/), with Halstead's
  measures, ABC and the maintainability index.
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
  the explanations `explain` produces or the change-history measures the
  metrics pass writes.
