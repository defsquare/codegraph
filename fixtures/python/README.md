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
| `pricing/__init__.py` | `from . import discounts` in a package's own `__init__.py`: the name is the submodule, so `DefaultDiscount(discounts.Discount)` reads the class through it |
| `pricing/discounts.py` | a diamond: `Combo(Percent, Fixed)`, both of `Discount` |
| `pricing/rules.py` | relative imports one dot and two dots up; `from . import discounts`, a submodule; `from .missing import Seasonal`, a file that is not there — a stub module keyed by the path it would have, and a stub class below it |
| `shapes.py` + `packing.py` | bases read through star imports: `Box` is in `shapes.__all__`, a declared edge; `Crate` is not, and only `from pallets.lib import *`, which nothing here answers, could bind it — `<site>%2Fpallets.lib/Crate`, `derived`, counted `star-attributed` |
| `two_stars.py` | two star imports of unknown modules: which binds `Widget`, no line says — dropped `ambiguous-star`, naming both |
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

42 files; 213 entities (31 of them stubs): 72 class, 17 function, 17 method, 59 module, 48 parameter.
82 edges: 43 `import` declared, 38 `inheritance` declared, 1 `inheritance` derived.

Sites: 45; resolved 39 (corpus 23, <builtins> 6, <stdlib> 5, <site> 4, missing modules 1, the language 0); unresolved 6; rate 86.7%.
Imports: 43 (relative 14; by package root 7, by namespace package 2, implicit-relative 1; <stdlib> 10, <site> 8; missing 1; type-checking-only 1).
Counted: ambiguous-root (dropped): 1; ambiguous-star (dropped): 1; computed-base (dropped): 2; unbound-name (dropped): 3; unnamed-declaration (dropped): 1; rebound-name: 1; star-attributed: 1.
