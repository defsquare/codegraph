# The navigator — design record

`codegraph navigator model.jsonl --serve` opens a browsable view of a model: a
searchable tree on the left, and for whatever is selected there, the incoming
and outgoing dependencies broken down by what kind of dependency each one is,
which member carries it, and where in the source it was found.

The city answers *what does this codebase look like*. The navigator answers
*what is here, and what exactly depends on what* — the question you cannot ask
a 3D scene.

---

## NV-1 · Two packages, mirroring the city split

```
@codegraph/navigator     pure computation: CodeGraph -> NavigatorModel -> navigator.json
@codegraph/navigator-ui  a Vite + React app that renders navigator.json and nothing else
```

The frontend gets a precomputed artifact rather than talking to a live
analyzer, for the same reason `viz` does: the analyzer cannot run in a browser
(zod, `node:fs`, the SQLite loader), and re-deriving graph facts in the
renderer is how a picture starts disagreeing with `codegraph analyze`. Every
role, owner, member attribution and coupling number in the UI was computed
once, on the Node side, by the analyzer's own primitives.

The CLI serves the artifact at `/navigator.json` beside the frontend's static
bundle (`packages/cli/src/serve.ts`, `startArtifactServer`), localhost only.

## NV-2 · The artifact is index-addressed

`kind: "codegraph.navigator/1"`, no `schemaVersion` — that key marks extractor
output, and this is derived from such a file.

Entity ids never reach the browser. A node is its position in `nodes`, a file
its position in `files`, and every reference — parent, children, roots,
`declaredType`, both ends of a dependency row, the carrying members — is one
of those integers. A reference that cannot be closed onto an index is dropped
and counted in `diagnostics`, mirroring the interchange's own rule that a
dangling reference is unwritable rather than merely reportable.

`nodes` is in preorder: a parent always precedes its children, so the UI's
"reveal this node" walk and its virtualized flattening both hold without a
sort. Children are ordered by (category, name, id).

## NV-3 · The tree comes from traits and the model's own parent chain

| tree level | selected by | nested under |
|---|---|---|
| module | `TModule` | nearest ancestor module the MODEL declares |
| type | `TType` | nearest ancestor type, else its containing module |
| operation | `TInvocable` | its containing type (the analyzer's folder walk) |
| attribute | `TStructural` whose parent is a type or module | that type or module |

Never from `kind` strings — those are per-profile (`class`, `struct`, `var`,
`defmethod`) and a navigator that switches on them stops working the day a
tenth language lands. Never by splitting a dotted name either (invariant 7):
`com.acme.order.adapter` sits under `com.acme.order` because the Java
extractor emitted that `parent`, and `java.lang` sits at the root because
nothing said otherwise.

Parameters and locals are deliberately NOT tree nodes. They are not things you
browse to; they are the reason a dependency exists, so they appear as the
`detail` on the row they explain (`parameter #4 (accountLockService)`).

Operations hang FLAT under their type — a lambda written inside a method lands
on the type, exactly as the city's member list does — because the alternative
is a tree whose depth tracks syntactic nesting nobody navigates by.

## NV-4 · Recovering the role of a `reference` edge

The metamodel has nine edge kinds and **none of them is "type declaration"**.
A parameter's type, a return type, a local variable's type, a field's type, a
generic argument, a cast and an annotation are ALL `reference` edges, and they
are stored on the *member* entity, not on the type:

```
{"t":"e","i":3,"k":10,...,"d":"param:reference","declaredType":152,"parent":2}
{"t":"x","k":5,"f":3,"o":152,"p":0,"anchor":[0,10,10]}    reference: parameter -> String
```

So the role is classified once, in `roles.ts`, from the SOURCE entity:

```
source has TType                          -> typeReference   (generic, cast, annotation)
source in owner.parameters[]              -> parameterType   (+ its ordinal)
source in owner.localVariables[]          -> localVariableType
source has TInvocable, declaredType == to -> returnType
source has TStructural, declaredType == to-> fieldType
otherwise                                 -> typeReference
```

The parameter and local checks come FIRST and read the owner's *ordered*
`parameters[]` / `localVariables[]` arrays. A parameter also carries
`TStructural` and a `declaredType`, so trait checks alone would file it as a
field. The other eight edge kinds map one-to-one, except `access`: a compound
assignment sets `isRead` AND `isWrite`, and yields two rows — a read and a
write, sharing an anchor — rather than a blended third role.

## NV-5 · Owner and member

Both ends of every edge are resolved by walking `parent` to the nearest
type-or-module node. That node is the row's `from`/`to`; the first
operation/attribute passed on the way is its `member`. A parameter's edge
therefore attributes to the operation that declares it, and that operation's
type owns the dependency.

The walk is the analyzer's containment chain, never `parentOf` alone — a
parameter's parent is its method, not the type — and never an id.

An edge whose two ends resolve to the SAME owner is internal cohesion, not a
dependency: it is excluded and counted in `diagnostics.selfDeps`, the same
rule `coupling()` applies to fold self-loops, so the artifact's fan-in and
fan-out agree with `codegraph analyze` row for row.

## NV-6 · What the frontend may and may not import

`navigator-ui` imports `@codegraph/navigator` for **types only**. A value
import pulls navigator → analyzer → core into the browser bundle and the build
fails outright on `createReadStream is not exported by
__vite-browser-external`. That happened once, for one convenience import of
`DEP_ROLES`.

Constants the UI genuinely needs are restated as literals — the artifact
`kind` in `guard.ts`, the role vocabulary in `model/grouping.ts` — and
`guard.test.ts` asserts each equals the package's own, order included, plus
scans `src/` for any non-type import of the package. The rule is stated as a
test because remembering it is what failed.

## NV-7 · Load ceremony, and the two-second rule

Same order as the city viewer: `?src=URL` (loud) → `/navigator.json` (quiet
when absent) → drag & drop or the file picker. The dropped file is the
ARTIFACT, not a `model.jsonl`; the guard refuses anything else naming the
command that produces one.

A missing artifact and a malformed one are different facts and get opposite
treatment. Probing the sibling route when nothing is served raises
`ArtifactUnavailableError` and falls through to the empty state — that is the
ordinary "opened the page with no model" path and must not look like a
failure. Bytes that arrive and are not an artifact raise
`NavigatorLoadError`, which is always shown, on the quiet path too.

One pipeline serves both sources: **read bytes → parse JSON → build indexes**.
A timer starts with it; the progress overlay appears only if two seconds
elapse first, so a fast load never flashes it. The bar is determinate while
bytes stream (the server sends `Content-Length`; that is why
`startArtifactServer` sets it) and names its phase for parse and index, which
are single blocking calls with no honest sub-progress.

Measured on fineract — 103k nodes, 668k dependency rows, a 100 MB artifact:
1.3 s over localhost, so no overlay; throttled to 12 Mbps the overlay appears
at ~2.5 s and counts up to 99.9 MB.

## NV-8 · Why the tree is virtualized and the search is a linear scan

Only the rows in the viewport mount (`react-window`): after scrolling through
103k nodes, 45 row elements exist. The visible-row array is derived from
(roots, expanded, hideExternals) by a pure function in `model/flatten.ts` and
recomputed per toggle — one DFS over visible nodes, not the corpus.

Search is `String.includes` over precomputed lowercase keys, capped at 200
results. No trie, no index: 103k substring tests are milliseconds, and the cap
bounds the DOM long before the scan becomes the cost. The cap is stated in the
UI ("First 200 matches — keep typing to narrow") rather than silently applied.

## NV-9 · What the colours mean

Four meanings carry a hue, and nothing else does: **incoming** (cyan),
**outgoing** (amber), **inference** (violet — any row whose provenance is not
`declared`, so an inference never reads as a fact, CLAUDE.md invariant 2), and
**selection**. A stub is drawn muted and italic rather than in a colour of its
own: it is a degraded fact, not a fifth category.

Every identifier is set in mono so package prefixes align; the chrome around
them is sans, so labels never compete with the code.
