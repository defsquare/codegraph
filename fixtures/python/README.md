# `fixtures/python` — the reference corpus for the Python extractor

A small order-management corpus in the `src/` layout — `src/acme_order/`, a
`tests/` tree, a repository-level `conftest.py` — that pins the hazards
PLAN.md §23 names for the walking skeleton (M22a): the walk and its decoding,
the import roots, declarations at every nesting, imports and their re-export
chains, bases, and the three stub roots. It is the acceptance corpus for
`extractors/python`: `expected/model.jsonl` is produced from **this** tree.
M22b grows both — what a body says: attributes, calls, accesses, decorators,
annotations.

```bash
./build.sh --python
./bin/codegraph-python --src fixtures/python/src --out model.jsonl
./bin/codegraph-python --src fixtures/python/src --out model.jsonl --explain-dropped   # + one stderr line per drop
```

Run it from the repository root with that relative `--src`: the typed path is
the header's `root`. A module's key is its root-relative path, escaped
(`python:src%2Facme_order%2Forders%2Forder.py`), and its `name` the path as
written.

## Nothing here is run, and nothing is installed

`django`, `sqlalchemy`, `simplejson` and `pytest` are imported and never
installed — the ordinary case. The standard library is answered by the table
embedded in the extractor (typeshed `stdlib/` at a pinned commit); everything
else is a stub below `<site>`, named as the import writes it.

**Do not "fix" `legacy/report.py`, `legacy/broken.py`, `legacy/latin.py`,
`legacy/bom.py` or `legacy/mac.py`**: their syntax errors and their bytes are
the hazard. The last three are `-text` in `.gitattributes`.

## What each file pins

| file (below `src/acme_order/` unless rooted) | hazard |
|---|---|
| `__init__.py`, `orders/__init__.py` | a re-export chain through two `__init__.py`: `tests/test_orders.py`'s `from acme_order import Order` imports the first, and its `SpecialOrder(Order)` inherits the class written in `orders/order.py` |
| `orders/order.py` | a nested class (`Order.Line`); a property and its `@total.setter` / `@total.deleter` (`Order.total#setter`, `#deleter`); every parameter shape (`quote`: positional-only, defaults, `*extra`, keyword-only, `**flags`; `merge`: a bare `*`) |
| `orders/base.py` | two corpus bases of one class, in a sibling module |
| `errors.py` | a built-in exception base (`<builtins>/Exception`) and a corpus base beside a built-in one |
| `pricing/discounts.py` | a diamond: `Combo(Percent, Fixed)`, both of `Discount` |
| `pricing/rules.py` | relative imports one dot and two dots up; `from . import discounts`, a submodule; `from .missing import Seasonal`, a file that is not there — a stub module keyed by the path it would have, and a stub class below it |
| `shipping.py` | `<stdlib>` bases: `enum.Enum`, `abc.ABC`, `from collections import abc` → `<stdlib>%2Fcollections.abc/Mapping` (the submodule: `collections` does not bind `abc`), the subscripted `Generic[T]`; `<site>` bases: `from django.db import models` → `<site>%2Fdjango.db/models.Model` (nothing says `models` is a module), `import sqlalchemy.orm` → `<site>%2Fsqlalchemy.orm/DeclarativeBase` (the import says it is); a computed base and a base nothing binds, both dropped |
| `compat.py` | a `def` written twice under a platform `if` — one entity, anchored at the first; `try: import simplejson as json` / `except ImportError: import json`; an `if TYPE_CHECKING:` import, counted `type-checking-only`; a name bound twice (`JSONDecodeError`), the first that names a declaration kept, counted `rebound-name` |
| `factory.py` | a class in a function (`make.Local`), a function in its method, a nested function (`outer.inner`); a base that is the function's parameter (`wrap(Base)`), never the module's `Base`: dropped `computed-base` |
| `payments.py` + `src/acme_plugins/stripe.py` | a namespace package (no `__init__.py`): `import acme_plugins.stripe` and `from acme_plugins import stripe`, counted on their own; `from ._speedups import checksum`, answered by a stub alone (`_speedups.pyi`, a compiled extension's) |
| `pricing/discounts.pyi` | a stub beside its source: a module of its own, which no import names — the program imports `discounts.py` |
| `cycle_a.py`, `cycle_b.py` | a re-export loop: `Spent(Token)` is dropped `unbound-name (an import cycle)`, and the walk ends |
| `unicode_names.py` | a non-ASCII identifier (`Café`) and an NFKC twin: `def ﬁnd` (U+FB01) and `def find` are one name, one entity |
| `promo#2024.py` | a `#` in a file name: escaped in the key, kept in the name |
| `_vendor/` | vendored code is written in the repository: corpus |
| `legacy/report.py` | a Python 2 file (`print` statement, backticks, `except E, e`, a tuple parameter), read from the recovered tree; `import helpers` answered only by its sibling (`implicit-relative`); `import ConfigParser`, a module Python 3 dropped, still `<stdlib>` by the 2.7 Library Reference's index; `LegacyError(StandardError)`, a Python 2 builtin, `<builtins>/StandardError` |
| `legacy/broken.py` | a Python 3 file with real syntax errors: the class and its methods survive; `def 1():` has no name, dropped `unnamed-declaration` |
| `legacy/latin.py` | Latin-1 with its PEP 263 cookie: the method is `réduire`, decoded |
| `legacy/bom.py` | UTF-8 behind a byte-order mark: the mark is not text |
| `legacy/mac.py` | lone `\r` line endings: lines are the parser's, not a count of `\n` |
| `src/acme.py` + `src/acme/__init__.py` | a module beside a package of its name: `import acme` finds the package |
| `bin/acme-report`, `bin/setup` | a script with no extension, Python by its shebang; the shell script beside it is not walked |
| `conftest.py`, `tests/conftest.py` | two `conftest.py`: `from conftest import make_order` in `tests/` takes the nearer root's |
| `tests/queue.py` + `tests/test_queue.py` | a corpus module named like a standard one, at a root: the corpus answers first |
| `tests/unit/fakes.py`, `tests/integration/fakes.py`, `tests/test_tie.py` | two roots at one distance answer `import fakes`: dropped `ambiguous-root`, never chosen |
| `env/` (holds `pyvenv.cfg`), `.tox/`, `__pycache__/`, `vendor/site-packages/` | never walked: a virtual environment by what it holds, the rest by name |

## What the numbers are

39 files, 200 entities (27 of them stubs), 74 edges: 38 `import`, 36
`inheritance`, all `declared`. Of 41 sites — every base is one — 36 resolve
(87.8 %): 21 to the corpus, 6 to `<builtins>`, 5 to `<stdlib>`, 3 to `<site>`,
1 below a missing module; 5 are dropped (a computed base, a parameter, three
bases nothing binds). Of the 38 imports, 12 are relative, 7 found by a package root, 2
through the namespace package, 1 implicit-relative, 10 in the standard library,
5 third parties', 1 a missing file; one is for a type checker only.
