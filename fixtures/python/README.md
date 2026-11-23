# `fixtures/python` — the reference corpus for the Python extractor

A small order-management corpus in the `src/` layout — `src/acme_order/`, a
`tests/` tree, a repository-level `conftest.py` — that pins the hazards
PLAN.md §23 names for the walking skeleton (M22a): the walk and its decoding,
the import roots, declarations at every nesting, imports and their re-export
chains, bases, and the three stub roots — and what a body says (M22b):
variables and attributes with their values, every receiver shape the site
resolution types and each it cannot, decorators, annotations, raises,
classes a call makes, comments and measures. It is the acceptance corpus for
`extractors/python`: `expected/model.jsonl` is produced from **this** tree.

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
| `services.py` (+ `repository.py`, `retry.py`, `settings.py`) | the receiver table. Declared: a name bound by scoping (`build_error`), a module's attribute (`settings.bump()`, `json.dumps` → the stub MODULE), a class named at the site (`Service.create()`, `Order(…)` → `Order.__init__`), `self` / `cls` along written bases, `super().__init__` along the MRO. Derived: an annotated parameter (`order: Order`, `Optional[Repository]` unwrapped) counted `annotation-typed`; an attribute and a local assigned one class (`self.repository`, `local`) counted `flow-typed`. Dropped: a bare parameter and an attribute no class types (`untyped-receiver`), `self.missing()` (`unbound-self-call`), `local.nothing` (`unbound-attribute`), `raise build_error(order)` (`raise-of-a-value`), `import_module(order.reference)` (`computed-import`), a spread in `@register(*settings.HOOKS, …)` (`spread-argument`). `@retry(3, backoff=2.0)` is an `annotationUse` whose positional argument takes the corpus decorator's parameter name; `raise error` in `except KeyError as error` throws `KeyError`; `print`, `len`: the language; `repository.py`'s `Cursor` lists its attributes in a literal `__slots__`: each an attribute at its string, no value, and `self._position` an access of it; `shipping = importlib.import_module("acme_order.shipping")` makes `shipping.Carrier.POST` a `derived` access, the binding typed by flow; `Handler`, appended, is what a run reaches through `self.handler.process()` — the call the trace binds |
| `aliases.py` | a base read through a name bound once to a class: `Ledger(Again)` with `Again = Trail = Auditable` inherits `Auditable`, `derived`, counted `alias-base`, and `self.audit()` through it is `derived` too; `TestCase = unittest.TestCase` the same; a name bound to a call (`Factory = type(…)`) or bound twice (`Twice`) stays `computed-base` |
| `records.py` | a `@dataclass`: its written fields are attributes (`order: "Order"`, a string annotation, sets `declaredType`; `paid = False` a value; `field(…)` none), the `__init__` it makes is no entity, the decorator an `annotationUse` of `<stdlib>%2Fdataclasses`; both spellings of a named tuple — `class Point(NamedTuple)` a written, `declared` base, `Pair = NamedTuple(…)` a class whose base is `generated` — and `Totals = TypedDict(…)` (`generated` `dict`); two `@overload` signatures and the implementation: ONE function anchored at the implementation, its signature and default the implementation's, the signatures' `Order` still referenced |
| `flows.py` | `nonlocal`: `count += 1` in `bump` drops nothing; a lambda is no entity, its call (`Order(…)`) its writer's; a comprehension's targets and a walrus in it, bound where they bind; `match`: a class pattern reads `Order`, captures are bound; `class Box[T]` and `def first[T]`: a PEP 695 type parameter is no attribute and no unbound name; `async def` is a function — nothing in the file is dropped |
| `refunds.py` | `raise OrderError` (a class) and `raise NotFound(…) from error`: `throws` edges, the call an invocation too; with `services.py`, every form of `raise` — a call, a caught name, bare, a value |
| `money.py` | classes a call makes: `Amount = namedtuple(…)`, `Rounding = Enum(…)`, `class Price(namedtuple(…))` — classes with their fields as attributes, inheriting `tuple` / `Enum` as `generated` |
| `settings.py` | module variables with their literal values and the `#` block above one; `global counter` then `counter += 1`: an access that reads and writes |
| `shapes.py` + `packing.py` | bases read through star imports: `Box` is in `shapes.__all__`, a declared edge; `Crate` is not, and only `from pallets.lib import *`, which nothing here answers, could bind it — `<site>%2Fpallets.lib/Crate`, `derived`, counted `star-attributed`; the `#` block above `Crate` is its comment, the `# noqa` under it left out |
| `two_stars.py` | two star imports of unknown modules: which binds `Widget`, no line says — dropped `ambiguous-star`, naming both |
| `shipping.py` | `<stdlib>` bases: `enum.Enum`, `abc.ABC`, `from collections import abc` → `abc.Mapping`, the submodule's (`collections` does not bind `abc`), keyed where typeshed declares the class: `<stdlib>%2Ftyping/Mapping`, the subscripted `Generic[T]`; `<site>` bases: `from django.db import models` → `<site>%2Fdjango.db.models/Model` (nothing says `models` is a module: keyed at the dotted module, a guess, counted `dotted-site-class`), `import sqlalchemy.orm` → `<site>%2Fsqlalchemy.orm/DeclarativeBase` (the import says it is); a computed base and a base nothing binds, both dropped; `Tracked.objects.filter()` — no corpus member, ONE library class of the MRO could answer: `derived`, counted `ancestor-attributed`, and `Tracked`, written there, a `declared` `reference`; in `audit()`, a written class is referenced whatever its member does — `Express.recent()` (a corpus ancestor, `Tracked`, declares it: the invocation names `Tracked.recent`) and `Ledger.flush()` (dropped `ambiguous-ancestor`, as `self.flush()` is); `Ledger(Shipment, Row)`: two could, dropped `ambiguous-ancestor`; `Proxy` writes `__getattr__`: `self.anything()` dropped `unbound-dynamic` |
| `compat.py` | a `def` written twice under a platform `if` — one entity, anchored at the first; `try: import simplejson as json` / `except ImportError: import json`; an `if TYPE_CHECKING:` import, counted `type-checking-only`; a name bound twice (`JSONDecodeError`), the first that names a declaration kept, counted `rebound-name` |
| `factory.py` | a class in a function (`make.Local`), a function in its method, a nested function (`outer.inner`); a base that is the function's parameter (`wrap(Base)`), never the module's `Base`: dropped `computed-base` |
| `payments.py` + `src/acme_plugins/stripe.py` | a namespace package (no `__init__.py`): `import acme_plugins.stripe` and `from acme_plugins import stripe`, counted on their own; `from ._speedups import checksum`, answered by a stub alone (`_speedups.pyi`, a compiled extension's) |
| `pricing/discounts.pyi` | a stub beside its source: a module of its own, which no import names — the program imports `discounts.py` |
| `cycle_a.py`, `cycle_b.py` | a re-export loop: `Spent(Token)` is dropped `unbound-name (an import cycle)`, and the walk ends |
| `unicode_names.py` | a non-ASCII identifier (`Café`) and an NFKC twin: `def ﬁnd` (U+FB01) and `def find` are one name, one entity |
| `promo#2024.py` | a `#` in a file name: escaped in the key, kept in the name |
| `_vendor/` | vendored code is written in the repository: corpus |
| `legacy/report.py` | a Python 2 file (`print` statement, backticks, `except E, e`, a tuple parameter), read from the recovered tree; `import helpers` answered only by its sibling (`implicit-relative`); `import ConfigParser`, a module Python 3 dropped, still `<stdlib>` by the 2.7 Library Reference's index; `LegacyError(StandardError)`, a Python 2 builtin, `<builtins>/StandardError`; `MODE = 0660`, a Python 2 octal the parser replaces with an empty expression: the variable, with no value |
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

## The trace

`trace/codegraph-trace.jsonl` is what `extractors/python/trace/codegraph_trace.py`
would write for a run of this corpus — its format, record by record, is the
header of that file — with one record of each outcome the merge counts. It is
hand-written: the corpus imports `django`, `sqlalchemy` and `simplejson`, which
nothing here installs, and no Python runs in this repository's tests. Merged
with `--trace` (the contract test), it adds `Dynamic → orders/base.py/Base`
(what `make_base()` returned) and `Point → <builtins>/tuple` (what `NamedTuple`
leaves in `__bases__`) as `generated` inheritance, and `Service.run →
Handler.process` as ONE `dynamic-candidate` invocation at `self.handler.process()`;
`Shipment`'s `django.db.models.base.Model` is the base the source writes as
`models.Model`; a function on a line with no `def`, a record outside the corpus,
a call to a name the line does not call and one into no `def` are counted. The
snapshot is the model WITHOUT the trace.

## What the numbers are

51 files; 376 entities (45 of them stubs): 31 attribute, 101 class, 34 function, 35 method, 74 module, 87 parameter, 14 variable.
227 edges: 27 `access` declared, 4 `access` derived, 3 `annotationUse` declared, 64 `import` declared, 44 `inheritance` declared, 3 `inheritance` derived, 5 `inheritance` generated, 36 `invocation` declared, 7 `invocation` derived, 29 `reference` declared, 5 `throws` declared.

Sites: 219; resolved 188 (corpus 99, <builtins> 17, <stdlib> 27, <site> 7, missing modules 1, the language 37); unresolved 31; rate 85.8%.
Imports: 64 (relative 24; by package root 9, by namespace package 2, implicit-relative 1; <stdlib> 18, <site> 9; missing 1; type-checking-only 1).
Counted: ambiguous-ancestor (dropped): 2; ambiguous-root (dropped): 1; ambiguous-star (dropped): 1; computed-base (dropped): 4; computed-import (dropped): 1; raise-of-a-value (dropped): 1; rebinding-of-a-declaration (dropped): 1; spread-argument (dropped): 1; unbound-attribute (dropped): 1; unbound-dynamic (dropped): 1; unbound-name (dropped): 10; unbound-self-call (dropped): 1; unnamed-declaration (dropped): 1; untyped-receiver (dropped): 10; rebound-name: 2; flow-typed: 4; annotation-typed: 3; ancestor-attributed: 3; star-attributed: 1; alias-base: 3; dotted-site-class: 1.
## The vocabulary: `currency`, counted by hand

`expected/vocabulary.json` is the words of this model's names
(`@codegraph/vocabulary`, PLAN.md §20), rebuilt byte for byte by
`pnpm --filter @codegraph/vocabulary test` (`CODEGRAPH_UPDATE_SNAPSHOTS=1`
rewrites it). A word weighs the role of the entity whose name carries it —
module and type 8, attribute 4, operation 3, parameter 1 — except a word of a
module path's directories, before its last `/`, which weighs 1. One word,
counted by hand from the model and pinned by the vocabulary's tests:

| name | kind | role | weight |
|---|---|---|---|
| `Order.currency` (`self.currency = currency` in `orders/order.py`) | attribute | attribute | 4 |
| `Amount.currency` (a field of `namedtuple("Amount", "value currency")`) | attribute | attribute | 4 |
| `DEFAULT_CURRENCY` (`settings.py`) | variable | attribute | 4 |
| `currency`, the keyword-only parameter of `Order.__init__` | parameter | parameter | 1 |

**`currency`: weight 13, 4 occurrences, 4 carriers** — a module variable
weighs as an attribute; the keyword argument `currency="EUR"` and the dict key
`"currency"` are not names. A package is its `__init__.py`, so its file's own
word is `init` (a technical word) and the package's directory a qualifier like
any other: `pricing` is said only as the qualifier of the four modules below
`pricing/` — weight 4 — and the stub `pricing/missing.py` not at all.
