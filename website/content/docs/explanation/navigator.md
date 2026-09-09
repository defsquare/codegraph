---
title: What exactly depends on what
linkTitle: The navigator
weight: 8
---

The city answers *what does this codebase look like*. It is very good at that and
completely unable to answer the next question, which is the one you actually have
when you are about to change something: **what depends on this class, through
which member, and where is the line that proves it?** A 3D scene cannot hold that
answer; a list can.

The navigator is that list. It is a searchable tree of the model — modules, then
types, then their operations and attributes — and for whatever is selected, every
incoming and outgoing dependency, broken down by what kind of dependency it is,
which member carries it, and the anchor where it was found.

The section numbers (`NV-1`, `NV-4`…) are decision records, cited from the code
and from other pages.

## NV-1 · Two packages, mirroring the city split

```
@codegraph/navigator     pure computation: CodeGraph -> NavigatorModel -> navigator.json
@codegraph/navigator-ui  a Vite + React app that renders navigator.json and nothing else
```

The frontend gets a precomputed artifact rather than talking to a live analyzer,
for the same reasons the [city](/docs/explanation/city-is-a-model/) does. The analyzer
cannot run in a browser — it uses Zod, the filesystem, and the SQLite loader —
and re-deriving graph facts in the renderer is how a picture starts disagreeing
with `codegraph analyze`. Every role, owner, member attribution and coupling
number in the interface was computed once, on the Node side, by the analyzer's
own primitives.

`codegraph serve` serves the artifact beside the frontend's static bundle —
and the laid-out city beside it, built from the same graph under the same view.
The city is the navigator's **City** tab (full-width, no tree), and a building
selected there offers *Open in navigator*: the page resolves the building's
entity id against its own type nodes — the one id the artifact carries, on types
and modules only — and reveals the match on Navigate with its incoming and
outgoing dependencies. The two artifacts share ids and nothing else; nothing is
re-derived in the browser, and the city itself arrives through `@codegraph/viz`'s
mountable view, so Three.js stays confined to that package.

**Which interface it binds is a choice, and the server states the reach it
actually has.** It defaults to every interface, so the page opens from another
machine without ceremony. A wildcard bind hands the whole model to anyone who
can reach the machine, so the line the command prints says so in words rather
than leaving the reader to interpret an address. It never prints
`http://0.0.0.0:4177/`, because that is a bind address and not one a browser
should be handed. A bad host fails with the address and the flag named,
because the bare system error sends the reader looking at the port instead.

## NV-2 · The artifact is index-addressed

Entity ids never reach the browser. A node is its position in the node array, a
file its position in the file array, and every reference — parent, children,
roots, declared type, both ends of a dependency row, the carrying members — is
one of those integers. A reference that cannot be closed onto an index is dropped
and counted in the diagnostics, mirroring [the interchange's own
rule](/docs/explanation/why-jsonl/) that a dangling reference should be unwritable
rather than merely reportable.

Nodes are in preorder, so a parent always precedes its children and both the
"reveal this node" walk and the virtualized flattening hold without a sort.

## NV-3 · The tree comes from traits, not from names

| tree level | selected by | nested under |
|---|---|---|
| module | `TModule` | the nearest ancestor module the MODEL declares |
| type | `TType` | the nearest ancestor type, else its containing module |
| operation | `TInvocable` | its containing type |
| attribute | `TStructural` whose parent is a type or module | that type or module |

Never from `kind` strings — those are per-profile (`class`, `struct`, `var`,
`defmethod`) and a navigator that switches on them stops working the day a tenth
language lands. And never by splitting a dotted name:
`com.acme.order.adapter` sits under `com.acme.order` because the Java extractor
emitted that parent, and `java.lang` sits at the root because nothing said
otherwise.

Parameters and locals are deliberately **not** tree nodes. They are not things
you browse to; they are the *reason* a dependency exists, so they appear as the
detail on the row they explain — `parameter #4 (accountLockService)`. Operations
hang flat under their type, so a lambda written inside a method lands on the
type, because the alternative is a tree whose depth tracks syntactic nesting
nobody navigates by.

## NV-4 · Recovering the role of a reference edge

Here is the problem this page exists to explain, and it is a good illustration of
what a deliberately small edge vocabulary costs and buys.

The metamodel has nine edge kinds and **none of them is "type declaration"**. A
parameter's type, a return type, a local variable's type, a field's type, a
generic argument, a cast and an annotation are all `reference` edges — and they
are stored on the *member* entity, not on the type:

```
{"t":"e","i":3,…,"d":"param:reference","declaredType":152,"parent":2}
{"t":"x","k":5,"f":3,"o":152,"p":0,"anchor":[0,10,10]}    reference: parameter -> String
```

That is the right thing for the model: adding an edge kind per syntactic position
would multiply the vocabulary every extractor has to implement, for distinctions
that are recoverable. But a reader looking at a fan-in list wants to know
*"is this a parameter type or a return type?"*, so the role is classified once,
on the navigator side, from the **source entity**:

```
source has TType                          -> typeReference   (generic, cast, annotation)
source in owner.parameters[]              -> parameterType   (+ its ordinal)
source in owner.localVariables[]          -> localVariableType
source has TInvocable, declaredType == to -> returnType
source has TStructural, declaredType == to-> fieldType
otherwise                                 -> typeReference
```

The order matters and is the part that is easy to get wrong. The parameter and
local checks come **first**, and they read the owner's *ordered* parameter and
local arrays — because a parameter also carries `TStructural` and a declared
type, so trait checks alone would file it as a field.

The other eight edge kinds map one to one, with one exception: a compound
assignment sets both the read and the write flag on an access edge, and yields
**two rows** — a read and a write sharing an anchor — rather than a blended third
role. Two things happen there; the row list says two things happened.

## NV-5 · Owner and member

Both ends of every edge are resolved by walking the parent chain to the nearest
type-or-module node. That node is the row's endpoint, and the first
operation or attribute passed on the way is the row's **member**. So a
parameter's edge attributes to the operation that declares it, and that
operation's type owns the dependency — which is what a reader means by
"`OrderService` depends on `Ledger`".

The walk is the analyzer's containment chain, never the immediate parent alone (a
parameter's parent is its method, not the type) and never an id.

An edge whose two ends resolve to the **same** owner is internal cohesion, not a
dependency: it is excluded and counted. That is the same rule the coupling metric
applies to fold self-loops, and it is applied here for a specific reason — so the
artifact's fan-in and fan-out agree with `codegraph analyze` row for row. Two
surfaces reporting different numbers for the same corpus is worse than either
number being debatable.

## NV-6 · What the frontend may and may not import

The React app imports its model package for **types only**. A value import pulls
navigator → analyzer → core into the browser bundle, and the build fails outright
on a Node built-in that Vite cannot externalize. That happened once, for one
convenience import of a constant.

Constants the interface genuinely needs — the artifact's `kind`, the
dependency-role vocabulary — are restated as literals, and a test asserts each
equals the package's own, order included, and scans the source for any non-type
import of the package. **The rule is stated as a test because remembering it is
what failed.** That sentence is the general principle behind most of the
guard-rails in this project.

## NV-7 · Load ceremony, and the two-second rule

The load order is explicit URL, then the sibling artifact route, then drag and
drop or the file picker. The dropped file is the **artifact**, not a
`model.jsonl`, and the guard refuses anything else while naming the command that
produces one.

A missing artifact and a malformed one are different facts and get opposite
treatment. Probing the sibling route when nothing is served is the ordinary
"opened the page with no model" path and falls through to the empty state; bytes
that arrive and are not an artifact raise a loud error, on the quiet path too.

One pipeline serves both sources — read bytes, parse, build indexes — and a timer
starts with it. The progress overlay appears only if two seconds elapse first, so
a fast load never flashes it. The bar is determinate while bytes stream, which is
why the server sets a content length, and names its phase for parse and index,
which are single blocking calls with no honest sub-progress. Measured on
fineract — 103k nodes, 668k dependency rows, a 100 MB artifact — the load is
**1.3 s over localhost**, so no overlay appears at all; throttled to 12 Mbps the
overlay appears at about 2.5 s and counts up to 99.9 MB.

## NV-8 · Why the tree is virtualized and the search is a linear scan

Only the rows in the viewport mount: after scrolling through 103k nodes, 45 row
elements exist. The visible-row array is derived from the roots, the expanded
set and the externals toggle by a pure function, recomputed per toggle — one
walk over visible nodes, not over the corpus.

Search is a substring test over precomputed lowercase keys, capped at 200
results. No trie, no index: 103k substring tests are milliseconds, and the cap
bounds the DOM long before the scan becomes the cost. The cap is *stated* in the
interface — "First 200 matches — keep typing to narrow" — rather than silently
applied, because a silently truncated result list is a wrong answer.

## NV-9 · What the colours mean

Four meanings carry a hue and nothing else does: **incoming** (cyan),
**outgoing** (amber), **inference** (violet — any row whose provenance is not
`declared`, so [an inference never reads as a
fact](/docs/explanation/facts-vs-inferences/)), and **selection**. A stub is drawn
muted and italic rather than in a colour of its own: it is a degraded fact, not a
fifth category.

Every identifier is set in mono so package prefixes align; the chrome around
them is sans, so labels never compete with the code.

## Where this shows up

- [Tutorial: finding what depends on a class](/docs/tutorials/navigator/) — the fan-in
  list, the role classification, the anchor.
- [Reference: navigator.json](/docs/reference/artifacts/navigator-json/) — the
  artifact's shape.
- [Reference: edges](/docs/reference/metamodel/edges/) — the nine edge kinds the roles
  are recovered from.
- [How to serve to a network](/docs/how-to/serve-network/) — the bind choice, and
  keeping it local.
- [Facts and inferences](/docs/explanation/facts-vs-inferences/) — why one hue is
  reserved for provenance.
