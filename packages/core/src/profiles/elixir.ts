import type { Profile } from "../profile.js";

/**
 * Elixir profile (PLAN.md §16.2 — the parser-as-library extractor's
 * contract). The module is the FILE, the TypeScript rule verbatim: Elixir has
 * no namespace, so nothing contains a `defmodule` but the file it is written
 * in, and its dotted name is one atom, not a path. A `defmodule` is a `module`
 * kind carrying TType — the module IS the type (a struct is `%Mod{}`, a
 * behaviour is a module, a protocol is a module) — so a city draws one
 * building per `defmodule`.
 *
 * No `inheritance` and no `embedding`: the language has neither, and the
 * absence is the profile's statement about it (the Go and Clojure rule).
 */
export const elixirProfile: Profile = {
  lang: "ex",

  kinds: {
    // A source file, `.ex` or `.exs`. Scripts (`mix.exs`, `config/*.exs`)
    // call at top level, hence the markers. The reserved stub modules
    // `<otp>` and `<deps>` are this kind too, with `isStub: true`.
    file: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TSourceAnchor", "TComment", "TMetrics", "TWithInvocations", "TWithAccesses"],
    },

    // `defmodule`. TWithImplements when it declares `@behaviour`, is a
    // `defimpl`, or carries `@derive`; TAttachedTo on a `defimpl` block
    // (attached to the type it implements FOR); TComment from `@moduledoc`.
    // A stub module (an external `Enum`, `Ecto.Changeset`) is this kind,
    // `TChildOf` its reserved module, with the lower bound waived as for
    // every stub.
    module: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TWithImplements", "TAttachedTo", "TComment", "TMetrics"],
    },

    // `defprotocol`: a module whose `def`s are `callback` children.
    protocol: {
      required: ["TNamed", "TType", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TComment", "TMetrics"],
    },

    // `def` / `defp`, every clause folded into ONE entity with arity as the
    // disambiguator. TWithChildren: its parameters carry `parent` (the M6
    // executable-containment rule). TWithLocalVariables is licensed but not
    // emitted in M15 (every match binds — deferred, see the notes).
    function: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TWithLocalVariables", "TComment", "TMetrics"],
    },

    // `defmacro` / `defmacrop`: invocable like a function; what its expansion
    // produces is invisible before compilation.
    macro: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithInvocations",
        "TWithAccesses",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TWithLocalVariables", "TComment", "TMetrics"],
    },

    // `@callback`, `@macrocallback`, a protocol's `def`: a signature with no
    // body — the interface-method analog, so no invocations or accesses.
    callback: {
      required: ["TNamed", "TInvocable", "TWithChildren", "TWithParameters", "TChildOf", "TSourceAnchor"],
      optional: ["TComment"],
    },

    // A `defstruct` / `defexception` key; TWithValue its default.
    field: {
      required: ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"],
      optional: ["TWithValue", "TComment"],
    },

    // `@name value` for a non-reserved module attribute — the module
    // constant. Its value may name modules (references) and read other
    // attributes (accesses).
    attribute: {
      required: ["TNamed", "TStructural", "TChildOf", "TSourceAnchor"],
      optional: ["TWithValue", "TWithAccesses", "TComment"],
    },

    // One per position of the folded function. TNamed from the first clause
    // that names the position (`_`-prefixed and bare `_` excluded);
    // TWithValue a `\\` default.
    parameter: {
      required: ["TStructural", "TChildOf"],
      optional: ["TNamed", "TSourceAnchor", "TWithValue"],
    },
  },

  edges: ["import", "interfaceImplementation", "invocation", "access", "reference", "throws"],

  notes: [
    "The module is the file (the TypeScript rule): `TModule.definedIn` has exactly one entry, and every entity's module is the file it is written in. A `defmodule` is a `module` entity, child of its file, carrying TType — the module IS the type in Elixir (a struct is `%Mod{}`, a behaviour and a protocol are modules, `@spec f :: Mod.t()`). Nesting (`defmodule Inner` inside `defmodule Outer`) defines `Outer.Inner` as a second child of the file and aliases `Inner` inside `Outer`: it is an alias, not a containment.",
    "Key components are percent-encoded: `/`, `#` and `%` in every path segment and name, and `.` inside a module atom (`Acme%2EOrder`), because `.` is the nesting separator inside a symbol (`Acme%2EOrder.total`). Relying on the rule that alias segments start uppercase while function names do not would make raw dots injective for `defmodule A.B` and fail for `defmodule :\"a.b\"`, which is legal; the encoding is injective by construction, and the entity's `name` is the atom as written.",
    "Arity is identity: `f/1` and `f/2` are unrelated functions, so a `function`, `macro` or `callback` always carries its arity as the disambiguator (`total#1`). `def f(a, b \\\\ 1)` declares `f/1` and `f/2` and is ONE entity, `f#2`, to which a call `f(x)` resolves; every clause of one `f/2` is folded into that entity, anchored from the first clause's line to the last clause's `end`. `signature` is `name/arity`.",
    "No `inheritance` edge kind and no `embedding`: Elixir has neither class inheritance nor embedding. `interfaceImplementation` is emitted `declared` for `@behaviour B` and for `defimpl P, for: T` (an edge T -> P anchored at the block), and `generated` for `@derive P`, whose expansion the language itself defines (`Protocol.derive/3`).",
    "`defimpl P, for: T` is a named module on the BEAM (`P.T`, the compiler's own name): it is a `module` entity keyed by that name in the file where the block is written, `attachedTo` T — the containment-versus-attachment split of the Clojure `implBlock`, with the name Elixir gives it. `defimpl` written inside `defmodule T` with no `for:` implements for T.",
    "Corpus membership is a whitelist of the `defmodule`s under the roots, never a name-prefix test. Every other module is a stub `module` entity below one of two reserved stub modules: `<otp>` for a module the BEAM ships (Elixir's standard library and Erlang/OTP, decided by a module table embedded in the extractor at build time from the building toolchain — `Enum` and `:ets` side by side, one VM), and `<deps>` for a module the roots do not declare and the table does not know (a dependency, whichever one: with no `deps/` read, the model cannot say which). Keys therefore never depend on what is checked out beside the corpus.",
    "`alias`, `import`, `require` and `use` are one `import` edge kind, file -> the target: another corpus file when the target is declared under the roots, else the stub `module` below `<otp>` or `<deps>`. Folded to the module layer by the analyzer, an external import reads as a dependency on the reserved module — the honest statement that the model does not know which dependency provides it. The four forms are counted separately on stderr; the edge itself does not say which was written. A form written inside a function body applies to that body alone and is still an edge from the file.",
    "`use X` is defined by the language as `require X` followed by `X.__using__(opts)` at compile time: it yields the `import` edge AND a `declared` invocation of `X.__using__#1`. What `__using__` injects — a `@behaviour`, imports, definitions — does not exist before expansion: it is absent from the baseline and every local call it would have bound is dropped and counted as `local-unbound` on stderr (a Phoenix router's routes, an Ecto schema's fields, a `plug` pipeline). The `--trace` enrichment recovers those as `generated`.",
    "A local call `f(a, b)` resolves in this order: a `def`/`defp`/`defmacro` of the enclosing module with that name and arity (defaults folded); an explicit `import M` that exports it (a corpus M, or the OTP table); Kernel / Kernel.SpecialForms unless `import Kernel, except:` removed it; the SOLE non-corpus `import M` that could provide it (a stub below `<deps>`, counted as `import-attributed` — what the compiler itself would conclude); two or more candidates, or none: dropped and counted.",
    "Dynamic dispatch is reported, never guessed. A call to a corpus protocol function `P.f(x)` is an `invocation` with provenance `dynamic-candidate` whose candidates are every corpus `defimpl` of P's `f`; `GenServer.call(__MODULE__, msg)` (and `cast`, `Agent.get(__MODULE__, …)`) is a `dynamic-candidate` invocation of that module's clause-folded `handle_call/3` / `handle_cast/2` / `handle_info/2` — the one message-passing form that is statically honest, because `__MODULE__` names the module. Any other first argument (a pid, a registered name, a variable), `apply/3`, `mod.f()` through a variable, `Module.concat`, `Code.eval_*` and `send/2` are dropped and counted as `dynamic-dispatch`.",
    "Higher-order use (`&M.f/2`, `&f/2`, `&M.f(&1, x)`) yields a `reference` edge to the function, never an `invocation`: the call happens elsewhere. A module atom in argument position (`children = [MyWorker, {Registry, keys: :unique}]`) is a `reference` to the module — how a supervision tree surfaces. `%M{…}` in an expression or a pattern is a `reference` to M (struct expansion) and each named key an `access` to `M.<key>` (`isRead` in a pattern, `isWrite` in a construction or update) — the only static field access Elixir has; `s.name` is a runtime map access, dropped and counted. `@attr` read in a body is an `access` to the `attribute`.",
    "`raise M`, `raise M, msg` and `reraise M, …` are `throws` edges to M (`RuntimeError` below `<otp>` for `raise \"text\"`); `throw` and `exit` are not exceptions and yield nothing. `@spec`, `@type`, `@typep` and `@opaque` yield `reference` edges to every named remote type's module; `@type` is not an entity. `@moduledoc` and `@doc` are the entity's `comments`, as is the `#` comment block written directly above a definition.",
    "A `defdelegate f(a), to: M, as: :g` is a `function` with one `declared` invocation of `M.g#1`: the delegation is written. `defp` and `def` are one kind — the metamodel has no visibility — and `private: true` rides as a pass-through key the container contract tolerates.",
    "Locals are deferred: `TWithLocalVariables` is licensed on invocables and not emitted in M15. Every match binds, so a local per `=` would multiply entities by ten for no edge the analyzer reads today; the trait stays licensed so adding them needs no profile change.",
    "Blind spots, stated: definitions a `use`d macro injects and the locals that call them; callback implementations as edges (`handle_call/3` under `@behaviour GenServer` — the analyzer recovers \"implements callback\" from `interfaceImplementation` plus name/arity, as it does for Java overrides); message passing beyond the `__MODULE__` form; process topology at runtime (`Registry`, `:via` tuples, dynamic supervisors); `.erl` files in a mixed corpus (an Erlang profile is its own phase). A file `Code.string_to_quoted/2` rejects (a syntax error, invalid UTF-8) is skipped and counted as `unparsed`; its `file` record is still written, with no entities.",
    "Measures (TMetrics, METAMODEL.md §3.8): `sloc` on the file, every module and every invocable — lines of its own span carrying at least one token, counted with the compiler's own tokenizer; `cyclomatic` on invocables: 1 + clause heads beyond the first + `case`/`cond`/`with`/`receive`/`try` clauses beyond the first + `if`/`unless` + `and`/`or`/`&&`/`||` + `rescue`/`catch` clauses. A nested `fn` contributes to its enclosing invocable: an anonymous function is not an entity.",
  ],
};
