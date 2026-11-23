# Running the Python extractor

`codegraph-python` reads Python sources and writes `model.jsonl`. It is one
binary — Ruff's parser linked in, and a table of the standard library
distilled from typeshed embedded — so it needs **nothing installed, Python
least of all**, and it runs nothing: no module is imported, no virtual
environment or `site-packages` is read, a `requirements.txt` that no longer
installs is no obstacle. What the profile licenses is in
`./bin/codegraph profiles --lang python`; the design is PLAN.md §23.

> **Status (M22c):** audited on requests, Django, Zulip and CPython's own
> `Lib/` (3.14.10 and 2.7.18); checked against CPython's `ast`, grimp, pyright
> and a running test suite (§7). Built and tested, not released: the binaries,
> the formula and the app's catalogue row ship from the release after v0.3.0.

## 1. Getting it

```bash
brew install defsquare/tap/codegraph-python   # from the release after v0.3.0 — macOS and Linux, arm64 and x64
```

or the release asset `codegraph-python-<platform>` (`osx-arm64`, `osx-x64`,
`linux-arm64`, `linux-x64`), from the same release; there is no Windows build.
A binary downloaded with a browser on macOS is quarantined:
`xattr -d com.apple.quarantine codegraph-python-osx-arm64`.

From a clone it needs Rust ≥ 1.98 (the pinned Ruff tag's floor) and a C
compiler — to build only: `psm`, the parser's stack growth, compiles a few
lines of C.

```bash
./build.sh --python                                  # → extractors/python/target/release/codegraph-python
./bin/codegraph-python --src <dir> --out model.jsonl
./test.sh --python                                   # cargo test + the release binary reproduces fixtures/python
```

## 2. What it reads, and how it resolves without running anything

Every `*.py`, `*.pyw` and `*.pyi` under the roots, and every extensionless file
whose first line is a `python` shebang. A directory holding `pyvenv.cfg` (a
virtual environment, recognised by what it is), `site-packages`, `__pycache__`,
`node_modules` and dot-directories are skipped; code a repository vendors
(`_vendor/`) is corpus. A source is read as bytes: a BOM and the PEP 263 coding
cookie are honoured (UTF-8, Latin-1, ASCII and cp1252 decoded); any other
encoding is read lossily and counted. Ruff's parser reads every Python 3
grammar and recovers from errors, so a file with syntax errors — a whole
Python 2 file included — is extracted from the recovered tree and named on
stderr.

Python binds names when the program runs, so the extractor does the part that
is true before it does:

- **The module is the file**, keyed and named by its path below the root
  (`python:src%2Facme%2Forder.py`, named `src/acme/order.py`); a package is its
  `__init__.py`. The dotted name is no key: it depends on which directory is
  taken for a root, which is an inference.
- **An import names a file, in the order Python tries.** An absolute import is
  looked up in the roots the layout implies — a regular package names its own
  (climb while the directory holds an `__init__.py`) — plus the corpus root and
  each `--import-root`; the nearest root wins and a tie is dropped
  (`ambiguous-root`). For a name the standard library holds, only the importing
  file's own root, the corpus root and an `--import-root` can shadow it. Then
  the file that is not there below a corpus package (a stub keyed by its
  path), then the standard library's table, then a sibling inside a package
  (Python 2's implicit relative import), then `<site>`. `from a.b import c`
  names `a/b` when it binds `c` at its top level, else the submodule.
  `importlib.import_module` and `__import__` with a literal are imports.
- **A re-export is an import of what the source writes**, while every
  `reference` and `invocation` names what the name is: `from acme import Order`
  imports `acme/__init__.py` and references `acme/order.py`'s class.
  `from x import *` binds `__all__` where it is one literal list, never grown,
  else every public top-level name; a package's submodule answers before a
  star import that binds its name.
- **What the corpus does not declare is a stub** below `<builtins>`,
  `<stdlib>` (the embedded table: every module of typeshed's `VERSIONS`, and
  the Python 2.7 module index) or `<site>`, one stub module per dotted name as
  written. A `<site>` name is a class only on evidence (a base, a `raise`, an
  `except`, an annotation); a library function or value folds to its module.
- **One key per library class.** A standard-library class is keyed where
  typeshed declares it, its re-exports followed — `unittest.TestCase` is
  `<stdlib>%2Funittest.case/TestCase`, `collections.abc.Mapping` is `typing`'s,
  `io.StringIO` is `_io`'s — whatever the import names; that may be a private
  module and differ from the run-time `__module__`. A Python 2 module's names
  (the 2.7 list carries no re-export data) stay as written. A `<site>` class
  reached through an imported name (`from django.db import models` …
  `models.Model`) is keyed at the dotted module, `<site>%2Fdjango.db.models/Model`,
  every segment before the last taken for module path — a guess (`models` may
  be a class or a value of `django.db`), counted `dotted-site-class`. The
  `import` edge always names the module written.
- **Bases resolve to classes; the MRO answers members.** `class A(B, C)` is one
  `inheritance` per base. The extractor computes the C3 order to look members
  up and does not write it.
- **A call is an edge when its receiver's class is written**: a module, a
  class named at the site, `self`/`cls` along written bases, `super()` —
  `declared`. Inferred receivers are `derived` (§4). A bare parameter, a call's
  result, a subscript: dropped and counted, never guessed. A corpus class
  written as a receiver is a `declared` `reference` to the class, at its name,
  whatever its member does: a library ancestor answers it
  (`UserProfile.objects.all()`), a corpus ancestor declares it (`Sub.method()`,
  the member edge naming `Base.method`), or nothing does and the site stays
  dropped, with its reason — evidence about the class, never a resolution of
  the member. Not for the class's own member (its edge names the class), not
  for the language (`Order.__name__`), never through `self` or `cls`.

## 3. Options and exit codes

```
codegraph-python [--src <dir>…] [--out <file>]
  --src <dir>           source root; repeatable (anchors are relative to the common ancestor)
  --out <file>          default: <current-dir>-codegraph.jsonl
  --progress <mode>     auto | plain | none          --no-progress
  --import-root <dir>   a directory absolute imports are looked up below, as PYTHONPATH would
                        name it; repeatable; it changes how imports resolve, never a key
  --explain-dropped     list every drop on stderr: `dropped <reason>: <file>:<line> <what>`
  --trace <file>        merge what trace/codegraph_trace.py wrote inside the running program (§5)
  --repo-remote <url> --repo-commit <sha> --repo-root <path> [--repo-provider github|gitlab]
  --licenses            the third-party notice: every linked crate, and typeshed (Apache-2.0, parts MIT)
  --version  --help
```

`stdout` carries nothing but `--help`, `--version` and `--licenses`; progress
and the summary go to `stderr`. Exit codes: `0` ok, `1` failure, `2` usage.

`--import-root` is for a root the layout does not betray: CPython 2.7's
`Lib/lib-tk` (the interpreter searches it; no `__init__.py` says so) brings 90
imports of `Tkinter`/`ttk` back from the table to the corpus with
`--import-root lib-tk`.

## 4. Reading the summary

The reference corpus, `fixtures/python`:

```
RESOLUTION SUMMARY
  files           : 51 (with syntax errors: 2; not UTF-8: 1; read lossily: 0)
  sites           : 219
  resolved        : 188 (corpus 99, <builtins> 17, <stdlib> 27, <site> 7, missing modules 1, the language 37)
  unresolved      : 31
  resolution rate : 85.8%
  ambiguous-ancestor (dropped)        : 2
  …
  untyped-receiver (dropped)          : 10
  rebound-name                        : 2
  flow-typed                          : 4
  annotation-typed                    : 3
  ancestor-attributed                 : 3
  star-attributed                     : 1
  alias-base                          : 3
  dotted-site-class                   : 1
  imports         : 64 (relative 24; by package root 9, by namespace package 2, implicit-relative 1; <stdlib> 18, <site> 9; missing 1; type-checking-only 1)
  entities        : 376 (stubs: 45)
  edges           : 227 (self-edges dropped: 0)
```

A **site** is something written that names something: a name read, a call, an
attribute, a decorator, a base, an annotation, a `raise`. `resolved` are the
ones that named what the corpus declares, a stub, or the language itself
(`len`, `print`, `"x".upper()`, `int` in an annotation: resolved, never an
edge).

The **provenance tiers**. `declared`: the source writes the receiver's class.
`derived`, each counted on its own line:

| counter | the inference |
|---|---|
| `flow-typed` | a local assigned `Foo(…)` once in its function, an attribute only ever assigned one class, a name bound once to `import_module("a.b")` |
| `annotation-typed` | a parameter, an attribute or a call result ANNOTATED with one class (`Optional`, a union with `None`, `Annotated[T, …]`, `Final[T]`, `ClassVar[T]` unwrapped). `Any`, a `typing` form, a function or a value types nothing |
| `ancestor-attributed` | a member nothing in the corpus declares, where exactly one library class of the MRO could answer (`Order.objects`, `self.assertEqual`) |
| `star-attributed` | a name bound only by a star import of the one module nothing answers |
| `alias-base` | a base read through a name bound exactly once to a class (`Base = models.Model`) |

`generated` is a base the language gives a class a standard form makes
(`namedtuple` → `tuple`), or one the trace saw (§5); `dynamic-candidate` comes
only from a trace. `rebound-name` counts resolved names bound more than once;
`dotted-site-class` the `<site>` classes keyed at a dotted module the site only
implies (`models.Model` through `from django.db import models`), each a guess.
On the `imports` line: `relative`,
`by package root`, `by namespace package` and `implicit-relative` say how a
corpus file was found; `<stdlib>`, `<site>` and `missing` (a file a corpus
package does not have) what the others reached; `type-checking-only` the
imports under `if TYPE_CHECKING:` — emitted like any other import.

Everything unresolved is dropped under its reason, each a stated ceiling:

| reason | what it is |
|---|---|
| `untyped-receiver` | an attribute or a call on a receiver no reader can type: a bare parameter, a call's result (`urlparse(u).scheme` included), a subscript. The largest remainder in every audited corpus |
| `unbound-name` | a name no scope binds and no builtin is; also what Python 2 recovery leaves (`except E, e`, the `L` of `0L`), and a read inside an import cycle, named so |
| `unbound-self-call` / `unbound-attribute` | a member nothing declares and no library class of the MRO could answer, on `self`/`cls` or on another typed receiver |
| `ambiguous-ancestor` | two library classes of the MRO could answer; the line names both |
| `unbound-dynamic` | the class writes `__getattr__`/`__getattribute__`, has a `metaclass=` or a computed base: "nothing declares it" is no evidence there |
| `ambiguous-star` | a name two star imports of unknown modules could bind; the line names both |
| `ambiguous-root` | an absolute import found at two roots equally near |
| `computed-import` | `import_module`/`__import__` of a computed name, or of a literal that names no module |
| `computed-base` / `not-a-class` | a base that is a call or a value (`six.with_metaclass(M, B)`), or that resolves to a function or a module |
| `raise-of-a-value` | `raise error`: the class is not written |
| `rebinding-of-a-declaration` | a binding of a name a `def`, a class or an import holds |
| `redefinition-of-another-kind` | a scope writes one name as a `def` and as a `class`: the first keeps the key |
| `spread-argument` | a `*args`/`**kwargs` in a decorator's arguments |
| `namespace-import`, `relative-beyond-root`, `unnamed-declaration`, `duplicate-parameter` | a star import of a namespace package, a relative import above the root, what recovery leaves without a name |

`--explain-dropped` adds one line per drop, in source order, and changes no
byte of the model:

```bash
codegraph-python --src fixtures/python/src --out model.jsonl --explain-dropped 2>&1 | grep '^dropped'
# dropped computed-base: src/acme_order/aliases.py:26 Factory (bound to a value)
# dropped rebinding-of-a-declaration: src/acme_order/compat.py:23 JSONDecodeError (an import binds it)
# dropped unbound-name: src/acme_order/cycle_a.py:5 Token (an import cycle)
```

## 5. `--trace <file>`: the running program as the second reader

What only exists once the program runs — a base a metaclass or a call gave a
class, the function an untyped receiver actually reached — can be added when
the project still imports. That means running the project's code, which the
extractor never does: the trace is a separate step, yours, with one Python
file of the standard library alone (Python 3.8 or later).

```bash
cd ~/src/some-project
# The bases and functions the interpreter holds when the program exits:
python <codegraph>/extractors/python/trace/codegraph_trace.py -m pytest
# …and the calls too (every call is slowed: run the tests, not production):
CODEGRAPH_TRACE_CALLS=1 python <codegraph>/extractors/python/trace/codegraph_trace.py -m pytest tests/

codegraph-python --src . --trace codegraph-trace.jsonl --out model.jsonl
```

`CODEGRAPH_TRACE_ROOT` is the directory given to `--src` (default: the
working directory), `CODEGRAPH_TRACE_OUT` the file to write. Calls are heard
through `sys.monitoring` from Python 3.12, `sys.setprofile` before. The trace
is JSONL — a header, then `base` (the class's file and `__qualname__`, the
base's index, `__module__` and `__qualname__`), `function` (file, first line,
`__qualname__`) and `call` (the site's file and line, the name, the file and
first line of the function entered) records, then an `eof` line. It names
things as Python does and carries no key.

The extractor merges it **after** its own pass:

- a base the source already writes at that place is the same fact (`object`
  is implied; `models.Model` written for `django.db.models.base.Model` is the
  same); one it does not is an `inheritance` with provenance **`generated`**,
  anchored on the class;
- a call at a site that calls that name on that line, to a function the model
  does not already reach from there, is ONE `invocation` with provenance
  **`dynamic-candidate`**, `candidates` listing every function that site was
  seen to reach — what ran once, not what must run;
- a function the interpreter holds on a line that writes no `def` has no
  entity and gets none.

No corpus entity is added (a library base the trace names may be a stub of
its own) and no edge of the source changes. On requests' own test suite
(615 tests passed), the merge reads:

```
  trace bases     : 85 (82 in the source, 2 added as generated, 1 outside the corpus)
  trace functions : 635 (635 written, 0 defined at run time — no entity, 0 outside the corpus)
  trace calls     : 1517 (911 in the model, 87 bound to 75 dynamic-candidate edges, 519 unmatched, 0 to a run-time definition, 0 outside the corpus)
```

`unmatched` is a call no site on that line makes under that name.

## 6. What the audit measured

Five corpora, each model `validate`-clean with the metrics pass applied,
nothing installed read, nothing run (the release binary, `/usr/bin/time -v`):

| corpus | files | sites | resolved | entities (stubs) | edges | time | peak RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| psf/requests | 37 | 5 768 | 81.6 % | 2 529 (158) | 3 593 | 0.06 s | 20 MB |
| Django | 2 922 | 278 073 | 73.4 % | 111 593 (585) | 229 360 | 2.9 s | 433 MB |
| Zulip | 2 125 | 228 523 | 81.9 % | 54 725 (1 063) | 174 640 | 2.0 s | 307 MB |
| CPython 3.14.10 `Lib/` | 1 876 | 623 485 | 77.0 % | 206 234 (663) | 420 124 | 5.1 s | 822 MB |
| CPython 2.7.18 `Lib/` | 1 613 | 303 632 | 78.7 % | 141 281 (511) | 217 345 | 2.8 s | 478 MB |

The rate is over everything written, tests included. `untyped-receiver` is the
largest remainder everywhere. 590 of 2.7's files are Python 2 syntax the
parser recovers. Memory grows with the corpus: 822 MB peak on CPython 3.14's
`Lib/`, the largest. The metrics pass joins 823 of 825 measured entities on
requests, 45 876 of 46 504 on Django, 18 852 of 19 001 on Zulip, 85 214 of
85 289 on CPython 3.14 and 44 692 of 44 725 on 2.7.

No standard-library class has two keys in any of the five models: the
same-name pairs left are different classes (`threading.Event` and
`asyncio.locks.Event`, `binascii.Error` and `configparser.Error`); the Python 2
names, kept as written, are the exception (`Tkinter.TclError` beside
`_tkinter.TclError` on 2.7). The dotted-module guess keys 66 `<site>` classes
over the five corpora, one with a Capitalized segment before the last —
Zulip's `pika.spec` `Basic.Deliver`, a nested class the guess takes for a
module. The receiver `reference`s add 14 340 edges on Django, 5 780 on Zulip,
1 654 on 2.7, 1 360 on 3.14 and 1 on requests, the sites they name dropped or
resolved exactly as before: no rate and no drop counter moves.

In CPython 3's own `Lib/`, every import of a module that has a file there
reaches that file; the 229 modules reached outside it have none — built into
the interpreter (`sys`, `itertools`), or registered at run time (`os.path`,
`collections.abc`, `xml.parsers.expat.errors`).

## 7. The four oracles

Each ran in a container with no network, the corpus mounted read-only.

**CPython's `ast`** (3.13; 3.14 for 3.14's `Lib/`; `lib2to3` for 2.7). Every
class, function and method, by (file, line, kind, name), after the folds the
profile states — a redefinition is one entity at its first line, `@overload`
signatures fold into their implementation, a module-scope
`N = namedtuple/NamedTuple/TypedDict/Enum(…)` is a class, a property's
accessors are members of their own; the model anchors at the `def`/`class`
line:

| corpus | agree | the rest |
|---|---|---|
| requests | 788 of 788 | — |
| Django | 43 581 of 43 581 | — |
| Zulip | 16 876 of 16 876 | — |
| CPython 3.14 | 83 413 of 83 415 | members of a class dropped `redefinition-of-another-kind` |
| CPython 2.7 | 43 112 of 43 117 | the same (`binhex.openrsrc`, `stdcall_dll`) |

**grimp 3.20 on Django** (the `django/` package, 909 modules): 3 209 of the
model's 3 211 module→module edges are grimp's (it has 3 214). Every difference
is `from pkg import sub` where `pkg` binds its own submodule `sub`
(`django.db.models … signals`): grimp names the submodule, the model the
package — the re-export rule.

**pyright** (scip-python 0.6.8) on requests (`src/` alone, as scip-python
indexes it) and Zulip (no dependency installed). Where pyright resolves a site,
the model agrees with:

| tier | requests | Zulip |
|---|---|---|
| `declared` | 98.6 % of 1 345 | 98.3 % of 112 881 |
| `annotation-typed` | 99.1 % of 108 | 98.9 % of 4 980 |
| `flow-typed` | 100 % of 38 | 96.3 % of 1 567 |
| `ancestor-attributed` | 100 % of 4 | 100 % of 54 |

— up to the stated folds: a class called is its `__init__`, a library function
or value its module, a library member its class, an attribute its root-most
owner, a library name as the site imports it. That last fold is what is left
of the library re-exports: a `<site>` package's (`requests.Response` is
`requests.models`', which no table says), and the differences between the
pinned typeshed and the one pyright bundles (`io` / `_io`, `decimal` /
`_decimal`) — 30 edges on requests and 1 399 on Zulip, against 86 and 1 935
before the standard library was keyed where typeshed declares it. No
`alias-base` or `star-attributed` edge lies in the files it indexed.

On Django (indexed with nothing installed, 2 921 files), the `declared` tier
agrees at 98.8 % of the 152 717 edges pyright resolves. Of the receiver
`reference`s the written-class rule adds there (14 337 beyond the
library-ancestor case), pyright names the same class for 14 326, is silent for
7 (a class reached through the `django.db.models` package, a receiver on the
line after a site's opening parenthesis) and names it otherwise for 4 (a class
nested in a function nested in a method, which scip-python names without the
inner function).

**requests' own tests** (615 passed; the four that need a routable network
fail without one) executed 282 import statements: 262 reach what the model
says, 2 a run-time alias (`os.path` is `posixpath`;
`requests.packages.urllib3` is `urllib3`), and 18 are no statement — imports
the interpreter makes inside a call (`warnings.warn`, `time.strptime`,
`pickle`) and one computed `__import__`, counted.

## 8. Limits, as they are today

Each is current behaviour, measured; none is a promise either way.

- **A star-imported name read from another file.** Inside `signal.py`,
  `from _signal import *` makes `SIGINT` `star-attributed`; `signal.SIGINT`
  read elsewhere is dropped `unbound-name` — 578 `signal.*` and 91 `struct.*`
  reads in CPython 3.14's `Lib/`.
- **`if TYPE_CHECKING:` imports** are counted, not marked on the edge, so an
  import cycle they close is drawn: requests' only cycle (8 files) exists
  through them; on Zulip they bring 6 files into its largest cycle.
- **A receiver reference is anchored at its site's first line**, which is
  where the class name is written but for a receiver after a parenthesis that
  opens the site on the line above (`qs = (` then `Book.objects…`): 2 of the
  23 135 receiver references over the five corpora (Django 1, Zulip 1) are a
  line early.
- **The trace and an aliased base.** A base written under an alias comes back
  from the interpreter under its real name and is added again as `generated`:
  `IOError` is `OSError`; on requests, 2 of 85 bases.
- **What stays dropped, honestly.** Django's 18 816 `unbound-dynamic` (17 971
  of them in `tests/`: models under `ModelBase`, `ConnectionProxy`,
  `LazySettings`); Zulip's 6 508 `ambiguous-ancestor` (test cases under two
  Django test classes it cannot order); `re.*` in CPython (`@enum.global_enum`
  binds the flags at run time); a name a module binds with
  `globals().update(…)`.
- **Not extracted:** members a decorator or a metaclass synthesizes (a
  dataclass's `__init__`, a Django manager), monkey patching, structural
  `Protocol` conformance, what a string names (`ForeignKey("orders.Order")`),
  `isinstance` narrowing, notebooks, Cython, `# type:` comments.

## 9. Feeding the result to codegraph

```bash
./bin/codegraph validate model.jsonl
./bin/codegraph-metrics model.jsonl --src .        # cognitive complexity, Halstead, ABC … per function
./bin/codegraph analyze model.jsonl --report deps
./bin/codegraph serve model.jsonl
```

The module layer is the **file**: the city draws one building per class in a
district per directory. A consumer that wants written facts only filters on
`declared`; `derived`, `generated` and `dynamic-candidate` each say what they
are.

## 10. Same bytes everywhere

Two runs over one unchanged corpus write the same bytes — with LF or CRLF
sources, whatever order the files were created in, on every platform the
binary is built for. Ruff is pinned to one tag (its commit in `Cargo.lock`,
every build `--locked`) and the standard-library table to one typeshed commit;
the header names both. `test.sh --python` and the `python-native` CI jobs `cmp`
the binary's output against the committed snapshot; run from the repository
root with the relative `--src fixtures/python/src`, since the typed path is
the header's `root`. `codegraph-python --licenses` prints the notice of every
crate it links and of the typeshed data it embeds
(`extractors/python/scripts/licenses.mjs` regenerates it).
