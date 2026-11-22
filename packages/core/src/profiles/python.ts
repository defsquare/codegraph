import type { Profile } from "../profile.js";

/**
 * Python profile (v2, PLAN.md §23.2 — the Ruff-parser extractor's contract).
 * The module is the FILE, keyed and named by its path (the TypeScript and
 * Ruby rule): a package is its `__init__.py`, a module like the others, and
 * nothing links a submodule to it — a namespace package has no `__init__` to
 * be a parent, and a file is not written in another file (invariant 5).
 *
 * Python binds names before it runs and nothing else: what a bare name reads
 * is `declared`, what flow or an annotation says of a receiver is `derived`,
 * and an attribute of a receiver nothing types is dropped and counted. A
 * decorator application is an `annotationUse` edge and a lambda part of what
 * writes it, so neither is a kind; a local is flow, so no kind holds locals.
 */
export const pythonProfile: Profile = {
  lang: "python",

  kinds: {
    // A source file, an `__init__.py` included. Its body is executable code
    // (`app = Flask(__name__)`, a script), hence the markers. `<builtins>`,
    // every `<stdlib>` and `<site>` module an import names, and the target of
    // a relative import no file answers are this kind too, with `isStub: true`.
    module: {
      required: ["TNamed", "TModule", "TWithChildren"],
      optional: ["TSourceAnchor", "TComment", "TMetrics", "TWithInvocations", "TWithAccesses"],
    },

    // `class` at any depth, and a `namedtuple(…)` / `NamedTuple(…)` /
    // `TypedDict(…)` / `Enum(…)` call bound to a module name. A class body is
    // executable code. TWithImplements: for the analyzer's Protocol
    // conformance — the extractor writes no `interfaceImplementation`.
    class: {
      required: ["TNamed", "TType", "TWithInheritances", "TWithChildren", "TChildOf", "TSourceAnchor"],
      optional: ["TWithImplements", "TWithInvocations", "TWithAccesses", "TComment", "TMetrics"],
    },

    // `def` / `async def` in a module or a function. TWithChildren: its
    // parameters and the `def`s and `class`es written in it carry `parent`.
    // TTypedEntity: the return annotation, when it names a class.
    function: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithInvocations",
        "TWithAccesses",
        "TTypedEntity",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TComment", "TMetrics"],
    },

    // `def` directly in a class body, `@staticmethod` and `@classmethod`
    // included. TAttachedTo is reserved for a function bound onto a class it
    // is not written in — a literal monkey patch, which M22 does not extract.
    method: {
      required: [
        "TNamed",
        "TInvocable",
        "TWithChildren",
        "TWithParameters",
        "TWithInvocations",
        "TWithAccesses",
        "TTypedEntity",
        "TChildOf",
        "TSourceAnchor",
      ],
      optional: ["TAttachedTo", "TComment", "TMetrics"],
    },

    // A class-level assignment or annotation, and `self.x = …` in a method:
    // ONE entity per class and name. TWithValue: its literal value.
    attribute: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf", "TSourceAnchor"],
      optional: ["TWithValue", "TComment"],
    },

    // A MODULE-level binding only (`DEBUG = False`, `logger = …`): what other
    // files read. A function's local is flow, never an entity.
    variable: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor", "TWithValue", "TComment"],
    },

    // Every parameter: `*args` and `**kwargs` have names. TWithValue: a
    // literal default.
    parameter: {
      required: ["TNamed", "TStructural", "TTypedEntity", "TChildOf"],
      optional: ["TSourceAnchor", "TWithValue"],
    },
  },

  edges: [
    "import",
    "inheritance",
    "interfaceImplementation",
    "invocation",
    "access",
    "reference",
    "annotationUse",
    "throws",
  ],

  notes: [
    "The module is the file, keyed AND named by its path below the root (`python:src%2Facme%2Forder.py`, named `src/acme/order.py` — the TypeScript and Ruby rule): `TModule.definedIn` has exactly one entry, and a package is its `__init__.py`, a module like the others. The dotted name is neither the key nor the name: it is not unique in a repository (`conftest`, `setup`, `tests.test_models` recur), and it depends on which directory is taken for a root, which is an inference — a key must not move when a heuristic does. No parent links a submodule to its package: a namespace package (PEP 420) has no `__init__` to be one, and a file is not written in another file. Directories carry the nesting.",
    "Key components are percent-encoded: `/`, `#` and `%` in every path segment, and `<`, so that no walked path can spell a reserved module (the Ruby rule). A name is an identifier and needs no escaping: `.` cannot occur in one, so it separates nesting unescaped — `Order.Line`, `total_of.helper`, a class in a function `make.Local`. Identifiers are NFKC-normalized, as the language normalizes them. Python has no overloading and a class holds one member per name, so a key carries no arity and no `static` mark; the only names that coexist are a property's accessors, `Order.total#setter` and `Order.total#deleter`, the word the source writes after the dot. A parameter is keyed `#param:<name>` below its invocable. A `def` written twice under one name (a platform `if`, a redefinition) is ONE entity anchored at the first, both bodies' edges its own; a name a scope writes once as a `def` and once as a `class` keeps the first: the other, with what it declares, is dropped `redefinition-of-another-kind` (CPython 2.7's `binhex.openrsrc`, a function on one platform and a class on another); `@overload` signatures and their implementation are one entity, anchored at the implementation, whose parameters, values and declared types it carries; the classes a signature annotates are still `reference`s. Signatures with no implementation (a stub's) are anchored at the first.",
    "Corpus membership is a whitelist of what the roots declare, never a name-prefix test, and nothing installed is read: no `site-packages`, no virtual environment. Everything else is a stub below one of three reserved modules: `<builtins>`, what the interpreter binds before any file runs (`ValueError`, `object`) — Python 3's, then the Python 2 builtins it lacks (`StandardError`, `unicode`, `long`); `<stdlib>`, a module of the standard library as the import writes it (`<stdlib>%2Fos.path`), from a table distilled from typeshed `stdlib/` at a pinned commit and embedded in the extractor — every module of its `VERSIONS`, removed ones included, so keys do not move with the interpreter, and the header names the commit — and every module of the Python 2.7 Library Reference's index, so what Python 3 dropped (`ConfigParser`, `urllib2`) is still the standard library; `<site>`, every module nothing here declares and the table does not name (`<site>%2Fdjango.db.models`). An external module is one stub per dotted name as written — `django.db` and `django.db.models` are two — and which distribution ships it is written nowhere in the source, so it is not guessed. A stub type's symbol is the name as written at the site, below the module it was imported from — except where a table says where the class is. A standard-library class is keyed where TYPESHED declares it, the table's re-exports followed: `unittest.TestCase` is `<stdlib>%2Funittest.case/TestCase`, `json.JSONDecodeError` is `json.decoder`'s, `collections.abc.Mapping` is `typing`'s — one key, whatever the import names; that module may be a private one (`io.StringIO` is `_io`'s) and may differ from the class's run-time `__module__`, and the `import` still names the module written; a Python 2 module's names (the 2.7 list carries no re-export data) stay as written. A `<site>` class reached through an imported name (`from django.db import models` … `class S(models.Model)`) is keyed at the dotted module, every segment before the last taken for module path (`<site>%2Fdjango.db.models/Model` — the key `from django.db.models import Model` and `import django.db.models` give): a GUESS, since `models` may be a class or a value of `django.db` rather than its submodule, counted on the summary (`dotted-site-class`); the `import` still names the module written. A `<site>` name is a stub CLASS on evidence — a site inherits from it, raises or catches it, or annotates with it; a function or a value of a stub module folds to that MODULE.",
    "`import a.b.c` and `from a.b import c` are `import` edges from the file wherever they are written — under `try`/`except ImportError`, under `if`, inside a function. `from a.b import c` names the file of `a.b` when it binds `c` at its top level, else the file of the submodule (`a/b/c.py`, `a/b/c/__init__.py`): the order Python itself tries. A relative import is resolved from the importing file's directory by path arithmetic, and one to a file that is not there is a stub module keyed by that path. An absolute import is looked up in the roots the layout implies — a regular package names its own (climb while the directory holds an `__init__.py`) — plus the corpus root and each `--import-root`: the root nearest the importing file wins, a tie is dropped and counted (`ambiguous-root`), and a hit through a namespace package or answered only by a sibling of the importing file (`implicit-relative`) is counted on its own — facts about the layout, not the language. The order an absolute import is answered in: the corpus at its roots, nearest first — for a name the standard library holds, only the importing file's own root, the corpus root and an `--import-root`: another file's root (a directory of scripts or data, as CPython's `test/dtracedata/gc.py`) is on no `sys.path` of the importer and does not shadow it; then, for a dotted name whose first name is a corpus regular package, the file that is not there (a stub keyed by the path it would have); then the standard library's table, then a sibling of the importing file inside a package directory (Python 2's implicit relative import), then `<site>`. So a corpus `logging/` at a root shadows the standard library, as it does on `sys.path`, while a sibling `queue.py` inside a package does not — Python 3 would never find it. `importlib.import_module` and `__import__` with a literal are imports; a computed name, or a literal that names no module (`__import__(\"zipimport\\x00junk\")`), is dropped and counted (`computed-import`). And a name bound once to such a call is that module by flow — what is read through it `derived`, counted `flow-typed` — `__import__(\"a.b\")` being `a`, as the interpreter returns it; bound to a computed one, it types nothing.",
    "A name reached through a re-export (`acme/__init__.py` writes `from .order import Order`; a file writes `from acme import Order`) yields an `import` of `acme/__init__.py` — what the source writes — while every `reference` and `invocation` of `Order` names the class in `acme/order.py` — what it is (the TypeScript `export … from` rule); chains are followed to the declaration, cycle-guarded. `from x import *` is an `import`, and its names ARE bound: `__all__` where it is a literal list, bound once and never grown (`token.py` extends its own with every token's name), else every public top-level name — of a corpus module and of the table's. A package's submodule answers before a star import that binds its name: importing it binds it in the package, so `asyncio.events` is `asyncio/events.py` though `from .streams import *` exports `events` too. A name bound only by a star import of ONE module nothing answers is attributed to that module, provenance `derived`, counted `star-attributed`; with two such imports it is dropped (`ambiguous-star`, the drop naming both). A builtin name stays the builtin: an unknown module is not presumed to shadow it.",
    "`if TYPE_CHECKING:` imports are written, so they are emitted like any other import, and counted `type-checking-only` on stderr. The idiom exists to break an import cycle the program never has; this profile declares no `space`, so the model does not tell a type-only dependency from a runtime one, and the Cycles tab shows that cycle.",
    "`class A(B, C)` yields one `inheritance` edge per base, each anchored at its base; a subscripted base (`Generic[T]`, `Base[Order]`) is an inheritance to the name, its arguments read like any expression where the class is written, as the class's dependencies: a class a `reference` from the class, a type variable an `access` of its variable, `int` the language. The edge set is unordered: the method resolution order (C3) is NOT represented, so a method-resolution question cannot be answered from the model — the extractor uses the order for its lookup and does not write it. `class A(namedtuple(\"A\", \"x y\"))` inherits `<builtins>/tuple` with provenance `generated`: the language defines it, the source writes no `tuple`. A computed base (`make_base()`, `six.with_metaclass(M, B)`) is dropped and counted. A base that reads a module- or class-level name bound EXACTLY ONCE to a class (`TestCase = unittest.TestCase`, `Base = models.Model`, a chain of such aliases followed) is an `inheritance` to that class with provenance `derived` — the flow tier, applied to a base — counted `alias-base`; the class keeps its own key and the alias stays the `variable` it is. A name bound to a call (`Base = declarative_base()`) or to anything but a class, or bound more than once, stays a computed base. The ancestors such a base brings into the MRO answer the lookup, and what one reached only through it answers is `derived` too, counted the same.",
    "A decorator application is not an entity: `@app.route(\"/orders\", methods=[\"GET\"])` is an `annotationUse` edge from the decorated `def` or class to what the decorator names, carrying its written arguments — the TypeScript rule, so `annotationUse` means in Python what it means in Java: a keyword argument keeps its keyword; a positional one takes the name of the parameter it lands on where the decorator is a corpus function (a corpus class: its `__init__`, `self` aside), else `arg<i>`, zero-based; a value that is code is its source text; a `*args` / `**kwargs` spread names no argument and is counted (`spread-argument`), not written. A decorator is a site of the summary. The entity stays the `def`: what the decorator returns in its place is not in the model. `@staticmethod`, `@classmethod` and `@property` are the language — they shape the entity and the lookup, and are no edge. A `@property` and its `@x.setter` / `@x.deleter` are methods; reading `obj.x` is an `access` to the first, not an invocation (the C# property rule).",
    "A lambda is one expression: it contributes its calls and reads to the invocable that writes it and is no entity (the Ruby block rule); `f = lambda: …` at module level is the variable `f`. Nothing declares a local — its first assignment is its declaration — so a function's locals are flow, not structure, and no kind holds `localVariables`. A `variable` is a MODULE-level binding (`settings.DEBUG`, `app = Flask(__name__)`, `logger`): what other files read, with its literal `value`; read from a body it is an `access`, written under `global` an `access` that writes. An `attribute` is a class-level assignment or annotation, `self.x = …` (`cls.x = …`) in a method, or a name a literal `__slots__` lists (anchored at its string, with no value), ONE per class and name, owned by the root-most corpus ancestor that has the name. A `def` or a nested `class` of the same name — in the class, or in the ancestor that owns the name — and, for a module global, a `def`, a `class` or an import, holds the key: the binding is counted (`rebinding-of-a-declaration`), not an entity. Every other module-level binding (an assignment, a loop or `with` target) and every `global` write from a function is a variable, anchored at its first binding; an attribute is anchored at its owner's first. The `value` is that first binding's when it is written as one: a literal, a list or tuple of literals, a class named (a type literal), a member of an enumeration (an enum literal); a dict display, a constant expression, or a name of a module-level or class-level binding or of a library is its source text; a call, a comprehension, a lambda, a parameter or a local has none.",
    "A bare name is resolved as the compiler binds it — the enclosing function scopes (never a class body), the module, then `builtins`; `global` and `nonlocal` say otherwise, and a comprehension is a scope — so what it reads is `declared`. A PEP 695 type parameter (`class Box[T]`, `def first[T]`) is bound in an annotation scope of its own, between where the class or `def` is written and its body, where its header and its annotations are read: a type parameter is no attribute, and no unbound name. `f(…)`, `Order(…)`, `mod.f(…)`, `Order.create(…)`, `self.total()`, `cls.make()` and `super().save()` are `declared` `invocation`s: the callee is a name the scoping rules bind, or an attribute of a receiver whose class is WRITTEN — a module, a class named at the site, `self` / `cls` (the first parameter of a method, by what decorates it) along written bases, `super()` from the next class of the MRO. `Order(…)` is `Order.__init__` where a corpus class of the MRO writes one, else the class itself. A bare name that reads a corpus class or function without calling it is a `reference` (`isinstance(x, Order)`, `except OrderError`, `Thread(target=run)`). A chain (`self.repo.save(x)`) is ONE site, its outcome its last step; an attribute or a variable read on the way is an `access` of its own, and calling a value read from one is that `access` alone. A property is read and written as an attribute: an `access` of its getter, written of its `@x.setter`. A `def` or a nested class anywhere in the MRO holds its name over an attribute a subclass binds; a write through a property is no binding. A library's class or module takes every step below it: `Order.objects.filter()` is an invocation of the class that answered `objects`.",
    "`len(x)`, `print(…)`, `str(x)`, a method of a literal (`\"x\".upper()`) and an annotation of `int`, `str`, `None` or a built-in container are the LANGUAGE: resolved, counted, never an edge — and so are the names the interpreter binds in every module (`__name__`, `__file__`, `__doc__`…) and the cell it gives `__class__` in a method (what zero-argument `super()` reads). A name of `builtins` is a stub below `<builtins>` only as a base, a `raise` or an `except` target. A call of a module-level function of a stub module (`os.getcwd()`, `json.dumps(…)`) is an `invocation` of the stub MODULE.",
    "`derived` says the receiver's class was inferred, not written at the site: a local assigned `Foo(…)` once in its function, or an attribute only ever assigned one class — flow; a parameter, an attribute or a call result ANNOTATED with a class (`def f(repo: Repo)`, `-> Repo`; an `Optional`, a union with `None`, `Annotated[T, …]`, `Final[T]`, `ClassVar[T]` and the `TypedDict` qualifiers unwrapped, anything wider untyped — `Any`, a `typing` form, a function or a value types nothing), counted `annotation-typed` — the interpreter never checks an annotation, so a `declared`-only analysis must not hold what it says; and a member nothing in the corpus declares, where exactly ONE library class of the MRO could answer — a class the table describes answers only for what it declares, a class it does not could answer anything — counted `ancestor-attributed` — where `Order.objects` and `self.assertEqual` land. With two that could, the site is dropped (`ambiguous-ancestor`, the drop naming both); with none, `unbound-self-call` (`unbound-attribute` on any other receiver); in a class that writes `__getattr__` / `__getattribute__`, has a `metaclass=` or a computed base, `unbound-dynamic` — \"nothing declares it\" is no longer evidence there.",
    "A receiver no reader can type without running the code — a bare parameter, a call's result (what a function of the table returns (`urlparse(u)`) included: not its module), a subscript — is the stated ceiling: `x.y` there is dropped and counted `untyped-receiver`, never guessed. The extractor writes no `dynamic-candidate` edge of its own, candidate generation being the analyzer's; `dynamic-candidate` comes only from a run-time trace merged with `--trace`, which also writes the bases the interpreter holds and no line writes as `generated` inheritance. `--trace <file>` merges what `extractors/python/trace/codegraph_trace.py` wrote from INSIDE the running program (`python codegraph_trace.py -m pytest`, the standard library alone, Python 3.8 or later; `CODEGRAPH_TRACE_CALLS=1` for calls) — the one thing the extractor never does is run corpus code, so the trace is a separate step, the user's, in a project that still imports. It names files, lines and `__qualname__`s, never a key: no corpus entity is added (a library base it names may be a stub of its own) and no edge of the source changes. A base of `__bases__` the source does not already give — `object` is implied, and a library base written another way (`models.Model` for `django.db.models.base.Model`) at the same place is the same — is an `inheritance` with provenance `generated`, anchored on the class. A call the program made, at a site that calls that name on that line, to a function the model does not already reach from there, is ONE `invocation` with provenance `dynamic-candidate`, `candidates` listing every function that site was seen to reach and `to` the first of them — what ran once, not what must run. A function the interpreter holds on a line that writes no `def` has no entity and gets none: it is counted, as is every record that names nothing the model holds. The extractor's own `generated` edges are the bases a standard form gives the class it makes: a `namedtuple` / `NamedTuple` / `TypedDict` / `Enum` call bound to a module-level name — recognised by the form's name and a literal class name — is a `class` named by the binding, its literal fields `attribute`s, and it inherits `<builtins>/tuple`, `<builtins>/dict` or the `Enum` called, `generated`; so does `class A(namedtuple(…))` from `tuple`, its fields the class's. A form the resolver finds is not the standard library's keeps its class and fields and gets no base, counted `computed-base`. `--explain-dropped` lists every dropped site with its reason, file and line.",
    "`raise Foo`, `raise Foo(…)` and `raise Foo(…) from e` are `throws` edges to Foo; `raise e` inside `except Foo as e` throws Foo, which the clause guarantees; a bare `raise` throws nothing new; any other value is dropped and counted (`raise-of-a-value`).",
    "An annotation (`x: Order`, `-> Order`, `Optional[Order]`, `list[Order]`, a string annotation `\"Order\"`) sets `declaredType` as written when it names one class — `Optional`, `ClassVar`, `Final`, `Annotated` and a union with `None` unwrapped, so `Optional[Order]` is `Order` while `list[Order]` and `Union[A, B]` are no one class — and is a `reference` to each class it names, `Order` in `list[Order]` included, from the entity it types — a parameter's annotation from the parameter, an attribute's or a module variable's from it, a return annotation from the invocable (the Java, C# and TypeScript rule, so a navigator reads them as parameter, field and return types); where no such entity exists (a local, a name a `def` holds the key of, an overload signature's parameter) from the enclosing body; `int`, `str`, `None` and the built-in containers name nothing (the Java primitive rule), and a variable an annotation reads — a `TypeVar` or a type alias (`VerifyType: TypeAlias = …`) — names no class: no edge, the site counted as the language. `Literal[…]` holds values and `Annotated[T, …]` one type and its metadata: a string there is no forward reference, and no name there is a type; `typing_extensions` (a third party, no table holds it) has `typing`'s forms. Each name an annotation writes is a site of the summary. Annotations are optional and may be deferred strings (PEP 563), so `declaredType` is frequently absent where `TTypedEntity` is present; `# type:` comments are not read.",
    "Python 2 is read from the recovered tree: Ruff's parser reads every Python 3 grammar in one build and recovers from errors, so a Python 2 file (a `print` statement, `except E, e`, backticks) — like any file with syntax errors — is extracted from the tree the parser recovered, and named on stderr. Its declarations survive recovery (measured on CPython 2.7.18's `Lib/` against `lib2to3`: every class, function and import statement), and so do its bodies: in the 586 files of that `Lib/` the parser recovered from, the reader keeps as many calls as `lib2to3` counts (106 148 against 106 072, 555 files exact), as it does in the 1 015 clean ones. A `print` statement becomes a read of the builtin `print` — the language — and its operands are read as expressions, the calls inside them kept. What recovery loses is local and counted `unbound-name`: `except E, e` binds no `e`, a tuple parameter ends its `def`, a `0L` literal leaves a name `L`. A source is read as bytes: a BOM and the PEP 263 coding cookie of the first two lines are honoured, UTF-8, Latin-1, ASCII and cp1252 decoded; any other encoding is read lossily (U+FFFD) and counted. The file is never rejected, however deep its nesting: the parser grows its own stack, and the extraction runs on a worker thread with a 64 MiB stack whose recursive walks grow theirs.",
    "Walked: `*.py`, `*.pyw`, `*.pyi` and extensionless files whose first line is a `python` shebang, under the roots. A stub is a module of its own: beside its source no import names it — the program imports the source — and alone it answers the import (a compiled extension's). A virtual environment below a root is not corpus: it is recognised by what it IS — a directory holding `pyvenv.cfg` — not by a name; `site-packages`, `__pycache__`, `node_modules` and dot-directories are skipped by name. Code a repository vendors (`_vendor/`) is written there and is corpus.",
    "Comments (`TComment`): a docstring, else the `#` block directly above a declaration — the coding cookie, the shebang and the `# type:` / `# noqa` / `# pylint:` / `# pragma:` directives left out. Measures (`TMetrics`, METAMODEL.md §3.8): `sloc` on modules, classes and invocables — lines of the entity's span, which starts at the line of its name (decorators are outside it), that are neither blank nor comment-only, a docstring being code; `cyclomatic` on invocables: 1 + each `if` and `elif` + each ternary + each `for` and `while` (a comprehension's `for` and each of its `if`s included) + each `except` clause + each `case` but an irrefutable one + each case guard + each operand of `and` / `or` after the first. A lambda contributes to the invocable that writes it: it is not an entity (the Ruby block rule).",
    "Explicitly NOT extracted: members a decorator or a metaclass synthesizes — a dataclass's `__init__`, a Django model's manager; the class's own written fields ARE attributes. Monkey patching (`Order.total = total`): the model shows the original definition site only. Protocol (PEP 544) conformance: structural, so `interfaceImplementation` stays in the profile for a `derived` enrichment of the analyzer, never mixed in, and the extractor writes none — `class X(Protocol)` is a plain inheritance. What a string names (`ForeignKey(\"orders.Order\")`, `INSTALLED_APPS`, an entry point in `pyproject.toml`): framework semantics. `isinstance` narrowing, notebooks and Cython.",
    "Audit (M22c, every model `validate`-clean with the metrics pass applied, nothing installed read, nothing run): psf/requests (37 files, 2 529 entities / 3 592 edges, 0.06 s, 20 MB) resolves 81.6 % of 5 768 sites; Django (2 922 files, 111 583 / 215 020, 2.9 s, 433 MB) 73.4 % of 278 073, 18 816 of them `unbound-dynamic` (its test models, `ConnectionProxy`, `LazySettings`); Zulip (2 125 files, 54 715 / 168 860, 1.9 s, 306 MB) 81.9 % of 228 523, 6 508 `ambiguous-ancestor` (test cases under two Django test classes the extractor cannot order); CPython 3.14.10 `Lib/` (1 876 files, 206 240 / 418 767, 5.1 s, 822 MB) 77.0 % of 623 485; CPython 2.7.18 `Lib/` (1 613 files, 590 of them Python 2 syntax the parser recovers, 141 273 / 215 693, 2.8 s, 478 MB) 78.7 % of 303 632. `untyped-receiver` is the largest remainder everywhere. In CPython 3's own `Lib/`, every import of a module that has a file there reaches that file; the 229 modules reached outside it have none (built into the interpreter, or registered at run time: `os.path`, `collections.abc`). Oracles, each in a container with no network: CPython's `ast` (lib2to3 for 2.7) and the model agree on every class, function and method by (file, line, kind, name) once the stated folds are applied (a redefinition, `@overload`, a form-made class) — all of requests, Django and Zulip, 83 413 of 83 415 on 3.14, 43 112 of 43 117 on 2.7, the rest `redefinition-of-another-kind`; grimp 3.20 on Django finds 3 209 of the model's 3 211 module edges (it has 3 214), every difference `from pkg import sub` where `pkg` binds its own submodule: grimp names the submodule, the model the package (the re-export rule); pyright (scip-python 0.6.8), where it resolves a site, agrees with 98.6 % (requests) and 98.2 % (Zulip) of the `declared` edges, 99.1 % / 98.9 % of `annotation-typed`, 100 % / 96.3 % of `flow-typed`, every `ancestor-attributed` one it resolves — up to the stated folds (a class called is its `__init__`, a library function its module, a library member its class, an attribute its root-most owner, a library name as the site imports it); requests' own tests (615 passed) execute 282 import statements, 262 reaching what the model says and 2 a run-time alias (`os.path` is `posixpath`; `requests.packages.urllib3` is `urllib3`); the other 18 are no statement — imports the interpreter makes inside a call (`warnings.warn`, `time.strptime`, `pickle`) — and one computed `__import__`, counted.",
  ],

  lexicon: {
    // The Python 3.12 Language Reference §2.3.1: the 35 keywords. Soft keywords (`match`, `case`,
    // `type`, `_`) are identifiers.
    keywords: [
      "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
      "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
      "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
      "while", "with", "yield",
    ],
    // The receiver conventions and the data model's special names (Reference §3.3).
    conventional: [
      "self", "cls", "__init__", "__new__", "__del__", "__repr__", "__str__", "__bytes__",
      "__format__", "__hash__", "__bool__", "__eq__", "__ne__", "__lt__", "__le__", "__gt__",
      "__ge__", "__len__", "__iter__", "__next__", "__aiter__", "__anext__", "__reversed__",
      "__contains__", "__getitem__", "__setitem__", "__delitem__", "__missing__", "__getattr__",
      "__getattribute__", "__setattr__", "__delattr__", "__dir__", "__get__", "__set__",
      "__delete__", "__set_name__", "__call__", "__enter__", "__exit__", "__aenter__", "__aexit__",
      "__await__", "__init_subclass__", "__class_getitem__", "__post_init__", "__add__", "__sub__",
      "__mul__", "__matmul__", "__truediv__", "__floordiv__", "__mod__", "__pow__", "__neg__",
      "__pos__", "__abs__", "__invert__", "__and__", "__or__", "__xor__", "__lshift__",
      "__rshift__", "__int__", "__float__", "__index__", "__round__", "__copy__", "__deepcopy__",
      "__reduce__", "__getstate__", "__setstate__", "__slots__", "__all__", "__name__", "__main__",
      "__doc__", "__dict__",
    ],
    // `conftest`: pytest's fixture file, the Ruby lexicon's `rakefile` of this language.
    technical: [
      "conftest", "dict", "kwargs", "metaclass", "py", "tuple",
    ],
    // The module is the file: its name is a path whose extension is not a word.
    fileKinds: ["module"],
    qualified: { module: "/" },
  },
};
