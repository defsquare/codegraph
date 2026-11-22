---
title: Python extractor
linkTitle: Python extractor
weight: 14
---

`codegraph-python` 0.3.0 — the Python extractor on Ruff's parser. A Cargo package in `extractors/python/`, built as one binary with the parser linked in and a table of the standard library distilled from typeshed embedded, so it needs **nothing installed, Python least of all**, and it runs nothing: no module is imported, no virtual environment or `site-packages` is read. **Every `*.py`, `*.pyw` and `*.pyi` under the roots is parsed**, with any extensionless file whose first line is a `python` shebang; imports resolve against the roots the layout implies, then the embedded table; a file with syntax errors — a whole Python 2 file included — is still extracted from the tree Ruff recovered. It emits [`model.jsonl`](/docs/reference/model-jsonl/) and nothing else: all trait, profile and validation logic lives in `@codegraph/core`.

**Built, not released yet**: the formula and the release assets ship from the release after v0.3.0.

```bash
brew install defsquare/tap/codegraph-python       # from the release after v0.3.0; or its codegraph-python-<platform>
codegraph-python --src <dir> --out model.jsonl

# from a clone — Rust 1.98+ and a C compiler to build, nothing to run
./build.sh --python                                # cargo build --release → extractors/python/target/release/codegraph-python
./bin/codegraph-python --src <dir> --out model.jsonl
```

The release assets are `osx-arm64`, `osx-x64`, `linux-arm64` and `linux-x64`; there is no Windows build. A binary a browser downloaded is quarantined on macOS: `xattr -d com.apple.quarantine codegraph-python-osx-arm64` once. Building needs a C compiler because `psm`, the parser's stack growth, compiles a few lines of C; nothing else. Installing any extractor from the tap also installs the [metrics pass](/docs/reference/metrics-pass/).

## Synopsis

```
codegraph-python [--src <dir>]… [--out <file>] [--progress auto|plain|none] [--no-progress]
                 [--import-root <dir>]… [--explain-dropped] [--trace <file>]
                 [--repo-remote <url>] [--repo-commit <sha>] [--repo-root <path>] [--repo-provider <p>]
                 [--version] [--licenses] [--help]
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--src <dir>` | source root; repeatable. With several roots, anchors are relative to their deepest common ancestor, which becomes the model's `root`. A directory holding `pyvenv.cfg`, `site-packages`, `__pycache__`, `node_modules` and dot-directories are skipped | the current directory |
| `--out <file>` | where to write the model | `<current-dir>-codegraph.jsonl` |
| `--progress <m>` | `auto` (one line per phase when stderr is a terminal, nothing when piped), `plain`, `none` | `auto` |
| `--no-progress` | same as `--progress none` | — |
| `--import-root <dir>` | a directory absolute imports are looked up below, as `PYTHONPATH` would name it; repeatable. It changes how imports resolve, never a key | — |
| `--explain-dropped` | list every drop on stderr, in source order, as `dropped <reason>: <file>:<line> <what>`; the model is unchanged | — |
| `--trace <file>` | merge what `trace/codegraph_trace.py` wrote inside the running program: bases no line writes become `generated` edges, the calls it saw `dynamic-candidate` ones. No corpus entity is added and no edge of the source changes | — |
| `--version` | print the extractor version | — |
| `--licenses` | print the third-party notice: every linked crate with its license text, and the typeshed data (Apache-2.0, parts MIT) the standard-library table is distilled from | — |
| `--help` | print the help and exit | — |

### Repository provenance

Copied verbatim into the header; the extractor runs no git — whoever invokes it supplies the facts, as [`snapshots`](/docs/reference/cli/snapshots/) does.

| Option | Meaning |
|---|---|
| `--repo-remote <url>` | normalized https clone URL, no `.git` suffix |
| `--repo-commit <sha>` | the sha this tree is at — a permalink, not a branch |
| `--repo-root <path>` | the analyzed root RELATIVE to the repository root (default: empty — they are the same directory) |
| `--repo-provider <p>` | `github` \| `gitlab`, only when the hostname does not say |

Exit codes: `0` success · `1` failure · `2` bad usage.

## How it resolves without running anything

Python binds names when the program runs, so the extractor does the part that is true before it does.

- **The module is the file**, keyed and named by its path below the root: `python:src%2Facme%2Forder.py`, named `src/acme/order.py`. A package is its `__init__.py`. The dotted name is no key: it depends on which directory is taken for a root, which is an inference.
- **An import names a file, in the order Python tries.** An absolute import is looked up in the roots the layout implies — a regular package names its own, climbing while the directory holds an `__init__.py` — plus the corpus root and each `--import-root`; the nearest root wins, a tie is dropped (`ambiguous-root`), and for a name the standard library holds only the importing file's own root, the corpus root and an `--import-root` can shadow it. Then the file that is not there below a corpus package, then the standard library's table, then a sibling inside a package (Python 2's implicit relative import), then `<site>`. The header names the table's typeshed commit and the Ruff tag:

  ```json
  {"name":"codegraph-python","version":"0.3.0","ruff":"0.17.6","typeshed":"2e4d4dcf657f82305709bbe3e86bca4d27d4dd46"}
  ```

- **A re-export is an import of what the source writes**, while every `reference` and `invocation` names what the name is: `from acme import Order` imports `acme/__init__.py` and references `acme/order.py`'s class. `from x import *` binds `__all__` where it is one literal list never grown, else every public top-level name.
- **One key per library class.** A standard-library class is keyed where typeshed declares it, its re-exports followed — `unittest.TestCase` is `<stdlib>%2Funittest.case/TestCase`, `collections.abc.Mapping` is `typing`'s, `io.StringIO` is `_io`'s — whatever the import names; that may be a private module and differ from the run-time `__module__`, and a Python 2 module's names (its list carries no re-export data) stay as written. A `<site>` class reached through an imported name (`from django.db import models` … `models.Model`) is keyed at the dotted module, `<site>%2Fdjango.db.models/Model`, every segment before the last taken for module path: a guess, counted `dotted-site-class`. The `import` edge always names the module written; a library function or value folds to the module the import names.
- **A call is an edge when its receiver's class is written**: a module, a class named at the site, `self`/`cls` along written bases, `super()` — `declared`. The extractor computes each class's C3 order to look members up, and does not write it. An inferred receiver is `derived`. A bare parameter, a call's result, a subscript: dropped and counted, never guessed. A corpus class written as the receiver of a member only a library ancestor answers (`UserProfile.objects.all()`) is also a `declared` `reference` to the class, at its name — never through `self` or `cls`.
- **The language is never an edge.** `len`, `print`, `str(x)`, a method of a literal, `int` in an annotation, the module dunders (`__name__`) and a method's `__class__` are resolved, counted, and produce nothing.

## Streams

stdout carries nothing but `--help`, `--version` and `--licenses`. Progress and the **resolution summary** go to stderr. This is the reference corpus:

```text
syntax errors (recovered, 5): src/acme_order/legacy/broken.py
syntax errors (recovered, 10): src/acme_order/legacy/report.py
decoded (not UTF-8, 2): src/acme_order/legacy/latin.py (iso-8859-1)
RESOLUTION SUMMARY
  files           : 51 (with syntax errors: 2; not UTF-8: 1; read lossily: 0)
  sites           : 216
  resolved        : 186 (corpus 97, <builtins> 17, <stdlib> 27, <site> 7, missing modules 1, the language 37)
  unresolved      : 30
  resolution rate : 86.1%
  ambiguous-ancestor (dropped)        : 1
  ambiguous-root (dropped)            : 1
  ambiguous-star (dropped)            : 1
  computed-base (dropped)             : 4
  computed-import (dropped)           : 1
  raise-of-a-value (dropped)          : 1
  rebinding-of-a-declaration (dropped): 1
  spread-argument (dropped)           : 1
  unbound-attribute (dropped)         : 1
  unbound-dynamic (dropped)           : 1
  unbound-name (dropped)              : 10
  unbound-self-call (dropped)         : 1
  unnamed-declaration (dropped)       : 1
  untyped-receiver (dropped)          : 10
  rebound-name                        : 2
  flow-typed                          : 4
  annotation-typed                    : 3
  ancestor-attributed                 : 3
  star-attributed                     : 1
  alias-base                          : 3
  dotted-site-class                   : 1
  imports         : 64 (relative 24; by package root 9, by namespace package 2, implicit-relative 1; <stdlib> 18, <site> 9; missing 1; type-checking-only 1)
  entities        : 374 (stubs: 45)
  edges           : 223 (self-edges dropped: 0)
```

- A **site** is something written that names something: a name read, a call, an attribute, a decorator, a base, an annotation, a `raise`. **resolved** are the ones that named what the corpus declares, a stub, or the language itself. Everything else is dropped under its reason, each a stated ceiling:

  | Reason | What it is |
  |---|---|
  | `untyped-receiver` | an attribute or a call on a receiver no reader can type: a bare parameter, a call's result (`urlparse(u).scheme` included), a subscript. The largest remainder in every audited corpus |
  | `unbound-name` | a name no scope binds and no builtin is; what Python 2 recovery leaves (`except E, e`, the `L` of `0L`); a read inside an import cycle, named so |
  | `unbound-self-call` / `unbound-attribute` | a member nothing declares and no library class of the MRO could answer, on `self`/`cls` or on another typed receiver |
  | `ambiguous-ancestor` | two library classes of the MRO could answer; the line names both |
  | `unbound-dynamic` | the class writes `__getattr__`/`__getattribute__`, has a `metaclass=` or a computed base: not declaring a member proves nothing there |
  | `ambiguous-star` / `ambiguous-root` | two star imports of unknown modules could bind the name; an absolute import found at two roots equally near |
  | `computed-import` | `import_module`/`__import__` of a computed name, or of a literal that names no module |
  | `computed-base` / `not-a-class` | a base that is a call or a value (`six.with_metaclass(M, B)`), or one that resolves to a function or a module |
  | `raise-of-a-value` | `raise error`: the class is not written |
  | `rebinding-of-a-declaration` / `redefinition-of-another-kind` | a binding of a name a `def`, a class or an import holds; one name written as a `def` and as a `class` in one scope (the first keeps the key) |
  | `spread-argument` | a `*args`/`**kwargs` in a decorator's arguments |
  | `namespace-import`, `relative-beyond-root`, `unnamed-declaration`, `duplicate-parameter` | a star import of a namespace package; a relative import above the root; what recovery leaves without a name |

- The **derived tiers**, each an inference counted on its own line: **flow-typed** (a local assigned `Foo(…)` once, an attribute only ever assigned one class, a name bound once to `import_module("a.b")`), **annotation-typed** (a parameter, attribute or call result annotated with one class; `Any`, a `typing` form, a function or a value types nothing), **ancestor-attributed** (a member exactly one library class of the MRO could answer: `Order.objects`, `self.assertEqual`), **star-attributed** (a name only a star import of the one unknown module binds), **alias-base** (a base read through a name bound once to a class: `Base = models.Model`). **rebound-name** counts resolved names bound more than once; **dotted-site-class** the `<site>` classes keyed at a dotted module the site only implies — each a guess.
- **imports** by how a corpus file was found — relative, by a package's root, by a namespace package, Python 2's implicit relative — and what the others reached: `<stdlib>`, `<site>`, `missing` (a file a corpus package does not have). **type-checking-only** counts the imports under `if TYPE_CHECKING:`, emitted like any other.
- **syntax errors (recovered)** names every file the parser had to recover, with the number of errors; **decoded** every file read in an encoding other than UTF-8.

`--explain-dropped` adds one line per drop, in source order, with what decided it where something did, and changes no byte of the model:

```text
dropped computed-base: src/acme_order/aliases.py:26 Factory (bound to a value)
dropped rebinding-of-a-declaration: src/acme_order/compat.py:23 JSONDecodeError (an import binds it)
dropped unbound-name: src/acme_order/cycle_a.py:5 Token (an import cycle)
dropped unnamed-declaration: src/acme_order/legacy/broken.py:12 def
dropped untyped-receiver: src/acme_order/legacy/report.py:8 order.reference
```

### `--trace <file>`: the running program as the second reader

Everything above is read from source. What only exists once the program runs — a base a metaclass or a call gave a class, the function an untyped receiver actually reached — can be added when the project still imports. That means running the project's code, which the extractor never does: the trace is a separate step, yours, with one Python file of the standard library alone (Python 3.8 or later).

```bash
cd ~/src/some-project
# the bases and functions the interpreter holds when the program exits:
python <codegraph>/extractors/python/trace/codegraph_trace.py -m pytest
# …and the calls too (every call is slowed: run the tests, not production):
CODEGRAPH_TRACE_CALLS=1 python <codegraph>/extractors/python/trace/codegraph_trace.py -m pytest tests/

codegraph-python --src . --trace codegraph-trace.jsonl --out model.jsonl
```

`CODEGRAPH_TRACE_ROOT` is the directory given to `--src` (default: the working directory), `CODEGRAPH_TRACE_OUT` the file to write; calls are heard through `sys.monitoring` from Python 3.12, `sys.setprofile` before. The trace is JSONL: a header, then `base`, `function` and `call` records naming things as Python does — files, lines, `__qualname__`s — and never a key. The extractor merges it **after** its own pass:

- a base the source already writes at that place is the same fact (`object` is implied; `models.Model` written for `django.db.models.base.Model` is the same); one it does not is an `inheritance` with provenance **`generated`**, anchored on the class;
- a call at a site that calls that name on that line, to a function the model does not already reach from there, is ONE `invocation` with provenance **`dynamic-candidate`**, `candidates` listing every function that site was seen to reach — what ran once, not what must run;
- a function the interpreter holds on a line that writes no `def` has no entity and gets none: it is counted.

No corpus entity is added (a library base the trace names may be a stub of its own) and no edge of the source changes. On requests, under its own tests:

```text
  trace bases     : 85 (82 in the source, 2 added as generated, 1 outside the corpus)
  trace functions : 635 (635 written, 0 defined at run time — no entity, 0 outside the corpus)
  trace calls     : 1517 (911 in the model, 87 bound to 75 dynamic-candidate edges, 519 unmatched, 0 to a run-time definition, 0 outside the corpus)
```

## The Python profile

The mapping the extractor must respect, rendered from `codegraph profiles --lang python`. `required(kind) ⊆ traits ⊆ required(kind) ∪ optional(kind)`.

| Kind | Required traits | Optional traits |
|---|---|---|
| `attribute` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TWithValue`, `TComment` |
| `class` | `TNamed`, `TType`, `TWithInheritances`, `TWithChildren`, `TChildOf`, `TSourceAnchor` | `TWithImplements`, `TWithInvocations`, `TWithAccesses`, `TComment`, `TMetrics` |
| `function` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TComment`, `TMetrics` |
| `method` | `TNamed`, `TInvocable`, `TWithChildren`, `TWithParameters`, `TWithInvocations`, `TWithAccesses`, `TTypedEntity`, `TChildOf`, `TSourceAnchor` | `TAttachedTo`, `TComment`, `TMetrics` |
| `module` | `TNamed`, `TModule`, `TWithChildren` | `TSourceAnchor`, `TComment`, `TMetrics`, `TWithInvocations`, `TWithAccesses` |
| `parameter` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor`, `TWithValue` |
| `variable` | `TNamed`, `TStructural`, `TTypedEntity`, `TChildOf` | `TSourceAnchor`, `TWithValue`, `TComment` |

**Edge kinds:** `import` · `inheritance` · `invocation` · `access` · `reference` · `annotationUse` · `throws` — and `interfaceImplementation`, which the profile keeps for a `derived` enrichment by the analyzer (structural `Protocol` conformance) and the extractor never writes. A decorator application is an `annotationUse` carrying its written arguments.

```
module         python:src%2Facme%2Forder.py          the path relative to the root, escaped
reserved       python:<builtins>   python:<stdlib>%2Fos.path   python:<site>%2Fdjango.db.models
class          python:src%2Facme%2Forder.py/Order     nested: …/Order.Line   in a function: …/make.Local
method         …/Order.total          a property's accessors: …/Order.total#setter  …/Order.total#deleter
parameter      …/Order.total#param:currency
attribute      …/Order.currency       variable: python:src%2Facme%2Fsettings.py/DEBUG
stub class     python:<builtins>/ValueError   python:<stdlib>%2Funittest.case/TestCase (where typeshed declares it)
               python:<site>%2Fdjango.db.models/Model (`models.Model` through `from django.db import models`: a guess)
```

Python has no overloading and a class holds one member per name, so a key carries no arity. The profile's notes — every rule above stated in full, and every blind spot — are on the [profiles page](/docs/reference/profiles/), rendered from `codegraph profiles`.

## Measures emitted

Carried in the `TMetrics` map. See [Measures and literals](/docs/reference/metamodel/measures-literals/).

| Key | On | Definition |
|---|---|---|
| `sloc` | modules, classes and invocables | lines of the entity's span — which starts at the line of its name, decorators outside it — that are neither blank nor comment-only, a docstring being code |
| `cyclomatic` | invocables | 1 + each `if` and `elif` + each ternary + each `for` and `while` (a comprehension's `for` and `if`s included) + each `except` clause + each `case` but an irrefutable one + each case guard + each operand of `and`/`or` after the first |

A lambda contributes to the invocable that writes it: it is not an entity. The [metrics pass](/docs/reference/metrics-pass/) adds cognitive complexity, Halstead, ABC and the rest: a class a call makes (`Amount = namedtuple(…)`) has no space of its own and none of the pass's keys, and on a Python join `sloc` is big-code-analysis's `ploc` plus the docstring lines it counts as comment.

## What the audit measured

Five corpora, each model `validate`-clean with the metrics pass applied, nothing installed read, nothing run:

| Corpus | Files | Sites | Resolved | Entities (stubs) | Edges | Time | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| psf/requests | 37 | 5 768 | 81.6 % | 2 529 (158) | 3 592 | 0.06 s | 20 MB |
| Django | 2 922 | 278 073 | 73.4 % | 111 593 (585) | 215 023 | 2.9 s | 433 MB |
| Zulip | 2 125 | 228 523 | 81.9 % | 54 725 (1 063) | 173 638 | 2.0 s | 307 MB |
| CPython 3.14.10 `Lib/` | 1 876 | 623 485 | 77.0 % | 206 234 (663) | 418 812 | 5.1 s | 822 MB |
| CPython 2.7.18 `Lib/` | 1 613 | 303 632 | 78.7 % | 141 281 (511) | 216 890 | 2.8 s | 478 MB |

The rate is over everything written, tests included; `untyped-receiver` is the largest remainder everywhere. 590 of 2.7's files are Python 2 syntax the parser recovers. No standard-library class has two keys in any of the five models — the same-name pairs left are different classes, the Python 2 names kept as written aside. The dotted-module guess keys 66 `<site>` classes over the five corpora, one with a Capitalized segment before the last (Zulip's `pika.spec` `Basic.Deliver`, a nested class). The receiver `reference`s add 4 778 edges on Zulip, 1 199 on 2.7, 48 on 3.14 and 3 on Django. In CPython 3's own `Lib/`, every import of a module that has a file there reaches that file; the 229 modules reached outside it have none (built into the interpreter, or registered at run time: `os.path`, `collections.abc`).

**Against CPython's `ast`** (`lib2to3` for 2.7), by (file, line, kind, name), once the stated folds are applied — a redefinition is one entity, `@overload` signatures fold into their implementation, a module-scope `namedtuple`/`NamedTuple`/`TypedDict`/`Enum` call is a class: every class, function and method of requests (788), Django (43 581) and Zulip (16 876); 83 413 of 83 415 on CPython 3.14 and 43 112 of 43 117 on 2.7, the rest members of a class dropped `redefinition-of-another-kind`.

**Against grimp 3.20** on Django's `django/` package: 3 209 of the model's 3 211 module→module edges are grimp's (it has 3 214). Every difference is `from pkg import sub` where `pkg` binds its own submodule `sub`: grimp names the submodule, the model the package — the re-export rule.

**Against pyright** (scip-python 0.6.8), on requests and Zulip. Where pyright resolves a site, the model agrees with 98.6 % / 98.2 % of the `declared` edges, 99.1 % / 98.9 % of `annotation-typed`, 100 % / 96.3 % of `flow-typed`, and every `ancestor-attributed` one it resolves — up to the stated folds: a class called is its `__init__`, a library function or value its module, a library member its class, an attribute its root-most owner, a library name as the site imports it — now only a `<site>` package's re-export (`requests.Response`) and the differences between the pinned typeshed and pyright's (`io` / `_io`): 30 edges on requests, 1 399 on Zulip, against 86 and 1 935 before.

**Against a running test suite** (requests, 615 tests passed): of 282 import statements executed, 262 reach what the model says and 2 a run-time alias (`os.path` is `posixpath`; `requests.packages.urllib3` is `urllib3`); the other 18 are no statement — imports the interpreter makes inside a call — and one computed `__import__`, counted.

## Limits, as measured today

Current behaviour, with its number; none is a promise either way.

| Limit | Measured |
|---|---|
| a star-imported name read from another file is dropped, though inside the module it is `star-attributed` | CPython 3.14 `Lib/`: 578 `signal.*`, 91 `struct.*` |
| `if TYPE_CHECKING:` imports are counted, not marked on the edge, so a cycle they close is drawn | requests: its only cycle (8 files); Zulip: 6 files more in its largest |
| a base written under an alias (`IOError`) comes back from the trace under its real name (`OSError`) and is added as `generated` | requests: 2 of 85 bases |
| what stays dropped, honestly | Django: 18 816 `unbound-dynamic` (17 971 in `tests/`); Zulip: 6 508 `ambiguous-ancestor`; CPython: `re.*` bound by `@enum.global_enum` at run time |

**Memory** grows with the corpus: 822 MB peak on CPython 3.14's `Lib/`, the largest audited.

## The reference corpus

`fixtures/python/` is a small order-management corpus in the `src/` layout (51 walked files) and the acceptance corpus for the extractor: the snapshot in `fixtures/python/expected/` is produced from that tree, and `./test.sh --python` checks that the release binary reproduces it byte for byte. `expected/model.metrics.jsonl` beside it is the same model after the metrics pass; `trace/codegraph-trace.jsonl` is a trace the contract test merges.

```bash
./bin/codegraph-python --src fixtures/python/src --out /tmp/m.jsonl --progress none \
  && cmp /tmp/m.jsonl fixtures/python/expected/model.jsonl && echo same
```

Run it from the repository root with that relative `--src`: the typed path is the header's `root`. **Nothing there is run, and nothing is installed**: `django`, `sqlalchemy`, `simplejson` and `pytest` are imported and never installed — the ordinary case — and `src/acme_order/legacy/` holds a Python 2 file, a file with syntax errors and a Latin-1 one, each still extracted. What each file pins is in `fixtures/python/README.md`.

## Gotcha

| Symptom | Cause | Fix |
|---|---|---|
| `untyped-receiver` dominates the drops | the stated ceiling: a parameter or a call's result types nothing | expected; `--trace` from inside a project that imports binds what ran |
| an import of a corpus package lands on `<site>` | its root is not one the layout implies (no `__init__.py` above, not the corpus root) | name it with `--import-root <dir>` |
| `ambiguous-root` on an import | two roots equally near hold that name (`tests/unit/fakes.py` and `tests/integration/fakes.py`) | expected; `--explain-dropped` names both |
| the header's `root` is absolute | `--src` was typed absolute | type it relative to the directory you run from |
