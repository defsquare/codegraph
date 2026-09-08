# Reading a Codebase You Did Not Write

## A forensic, structural and semantic method for inspecting a large unknown codebase

*Draft 0.1. Working paper for codegraph and Specy. Discussion, critique and
the implementation backlog it implies live in the session notes; the text
below is the paper.*

---

## Abstract

A large codebase nobody on the team wrote is a common situation: an
acquisition, a migration, a legacy system whose authors left, an open-source
dependency that must be forked. The question is never "what is in it" but
"where do I start, what matters, and what does it mean". This paper describes
a method in seven viewpoints that moves from **terrain** (what the code is,
statically) through **activity** (what happened to it, from version control)
to **meaning** (what it does for the business, in a domain vocabulary). Each
viewpoint answers one question, consumes named evidence, and produces one
artifact that the next viewpoint reads. The method borrows its prioritisation
model from Adam Tornhill's behavioural code analysis (hotspots as the overlap
of complexity and effort, change coupling as the modus operandi of a code
change, code age, knowledge maps) and its target vocabulary from
Domain-Driven Design as formalised in the Specy domain metamodel. Its
distinctive move is the **join**: holding the static dependency graph and the
change history in one tool makes the questions neither can answer alone
(hidden coupling, dead weight, reachable slices ranked by effort) cheap to
ask. Every claim the method makes is anchored to a file and a span and
labelled with how it was obtained: a declared fact, a derivation, a
dynamic candidate, or a history inference. That discipline is what lets a
language model be used at the end, for meaning, without letting it invent
structure.

---

## 1. The problem

### 1.1 What "understanding" means

A person arriving on a codebase of a few hundred thousand lines cannot read
it. Tornhill's opening observation is the right frame: we spend most of our
time modifying and understanding existing code, so the tooling should
"optimize for understanding" (*Your Code as a Crime Scene*, p. 2). Reading
is not optional, but it must be **directed**: the method exists to decide
what to read first, what to read at all, and what to trust.

Three questions structure the work, and they are the three questions the
codegraph front-ends already answer:

| Question | Artifact | Front-end |
|---|---|---|
| What does this codebase **look like**? | the city | `codegraph city` |
| What **depends on what**? | the navigator | `codegraph navigator` |
| What does it **mean**? | the insights side-car, then a `.domain` | `codegraph explain`, `specy:domain-extract-from-code` |

The paper adds the questions in between: *where is the effort going*, *where
are the surprises*, *what reacts to the outside world*, and *which parts are
the business and which parts are plumbing*.

### 1.2 Five commitments

1. **Questions first, tools second.** Tornhill closes his first book with
   "let your questions guide your analysis" (p. 175). Each viewpoint below is
   a question with a definite artifact as its answer, not a tool run.
2. **Evidence on everything.** An entity or a claim without a file and a span
   is not admissible. This is codegraph's invariant 3 (`anchor {file, span}`
   on every entity and edge) turned into a method rule.
3. **Provenance never mixes.** A declared fact, a derived edge, a
   dynamic-candidate dispatch and a history inference are four different
   kinds of knowledge. A report states which kind it rests on. The city
   draws inferences as a different kind of line; the paper does the same in
   prose.
4. **Prioritise by interest rate, not by ugliness.** "Just because some code
   is bad doesn't mean it's technical debt. It's not technical debt unless we
   have to pay interest on it, and interest rate is a function of time"
   (*Software Design X-Rays*, p. 5). Static complexity alone reported "4,000
   years of technical debt" on one system (p. 6) and told nobody what to do.
   Effort, mined from history, is the weight.
5. **Inference is labelled, never silent.** A stub whose framework is absent
   is unclassified rather than guessed; a naming heuristic is a hint column,
   not an identity; a model's explanation carries a confidence and a
   fingerprint of what it was computed from.

### 1.3 Sources

The prioritisation model, the visual vocabulary (enclosure diagrams, the code
city), the social analyses and most of the caveats come from Adam Tornhill,
*Your Code as a Crime Scene* (2015) and *Software Design X-Rays* (2018). The
structural metamodel is FamixNG-style traits (Moose lineage), as implemented
in codegraph. The target vocabulary for meaning is the Specy domain
metamodel (`DOMAIN-METAMODEL.md`, v3): bounded context, module, interface as
API or SPI port, operation, command, query, reaction, entity, aggregate,
value type, the four event kinds, the three service kinds, invariants,
pre- and postconditions, agreements. Where this paper departs from Tornhill
it says so; the main departure is that Tornhill's tooling holds only the
history, and this method holds the static graph beside it.

---

## 2. The method at a glance

Seven viewpoints. Each row is one question, the evidence that answers it, the
artifact that carries the answer, and the viewpoint that consumes it next.

| # | Viewpoint | Question | Evidence | Artifact | Feeds |
|---|---|---|---|---|---|
| V1 | **Terrain** | What is here, how big, how branchy, how tangled? | `model.jsonl`: entities, edges, `sloc`, `cyclomatic`, SCCs | city, cycles report, coupling report | V3, V4, V5 |
| V2 | **Activity** | Where does the effort go, who does it, what changes together? | `history.jsonl`: commits, churn, authors, co-change | hotspots, coupling, owners, truck factor, code age | V3, V4 |
| V3 | **Hotspots and surprises** | Which complex code is worked on often? Which co-changes have no structural explanation? | V1 ⋈ V2 (path join) | ranked hotspots, hidden coupling, dead weight, tangle-weighted hotspots | V5, V6, the tour |
| V4 | **Boundaries and style** | How is it cut, which style, do the cuts hold? | module topology, layering, framework roles, naming census, cross-boundary co-change | architecture fingerprint, boundary report | V5, V7 |
| V5 | **Stimuli and flows** | What reacts to the outside world or to time, and what does each reaction reach? | framework roles, `main`, interface implementations, zero-caller public operations, forward reachability | entry-point inventory, per-entry slices, exit points | V6, V7 |
| V6 | **Meaning** | What does each unit do, in domain words? | source slices, facts, dependency explanations, stimulus context | `.insights.jsonl` | V7 |
| V7 | **Domain** | Which of it is the business, and what is the model? | V6 blocks + V4/V5 evidence, tests | `.domain`, `.sysreq`, refactoring report | the reader |

The order matters for two reasons. Structure is cheap and deterministic, so
it comes first and frames everything. Meaning is expensive and probabilistic,
so it comes last and is **scoped by what the earlier viewpoints ranked**: the
model is asked about the hotspot slices first, and about the long tail only
if budget remains.

---

## 3. V1: Terrain

**Question.** What is here, how big is each part, how branchy, and where are
the tangles?

**Evidence.** The extracted model: modules, types, operations and attributes
with their traits; edges of every kind with provenance; the measures the
extractor emitted (`sloc`, `cyclomatic`); the analyzer's folds (type level,
module level), its coupling metrics (fan-in, fan-out, instability) and its
cycle report (strongly connected components, minimum feedback set, tangle
metric).

**What to look at.**

- **The city at two heights.** Height by `sum:cyclomatic`, footprint by
  `loc`, districts by module. Tall narrow buildings are branchy code in
  little space; wide flat ones are data carriers or generated code. This is
  Tornhill's "a large file is like a system in itself" (*X-Rays*, p. 27)
  made spatial. Judge it at a user-facing angle: the picture is the
  deliverable, not the numbers behind it.
- **The tangles.** A strongly connected component at module level is the
  single most important structural fact: inside it, no change has a safe
  direction. The cycle report gives each tangle its members, its weight and
  its minimum feedback set (the cheapest edges whose removal makes it
  acyclic). The tangle metric (feedback weight over cyclic weight) says how
  much of the component is "the knot". Fineract had 18 package tangles, the
  largest of 509 packages; that one number tells a newcomer more than any
  architecture diagram.
- **Instability against fan-in.** Types with high fan-in and high
  instability are the dangerous kind: much depends on them, and they depend
  on much. Stable types with high fan-in are the load-bearing walls.
- **The stub boundary.** Everything the corpus references but does not
  declare is a stub. The list of stub modules is the corpus's declared
  dependence on the outside world: which frameworks, which libraries, which
  I/O. This list is reused in V4 and V5.

**Pitfalls.** Size without effort is exactly the "4,000 years" trap; V1
alone ranks nothing. Generated code and test code should be visible as such
before anything is read into their size. Terrain is a snapshot at one
commit; record which one (the model header carries it).

---

## 4. V2: Activity

**Question.** Where does the effort go, who spends it, and what changes
together?

**Evidence.** One pass over `git log --numstat` with renames resolved, into
`history.jsonl`: commits (author, timestamp, fix and revert flags from the
subject line) and per-file changes (added, deleted, rename-from). No code
intelligence in the miner; everything smarter is derived downstream.

**What to compute.** Tornhill's catalogue, with his thresholds where he gives
them:

| Analysis | Definition | Threshold or window | Source |
|---|---|---|---|
| Change frequency | commits per file, a power law in every codebase | window: one or two years for a first look; one month for a very active project | *Crime Scene* pp. 16, 37–38 |
| Churn | added + deleted lines per file, absolute first | "start with absolute churn values" | *Crime Scene* p. 173 |
| Change coupling | files changing in the same commit | ≥ 20 shared commits and ≥ 50 % of either file's commits | *X-Rays* pp. 36–37 |
| Logical change sets | group commits by same author within a day, or by ticket id, so cross-repo or split commits count | `--temporal-period 1` | *Crime Scene* p. 140, *X-Rays* p. 175 |
| Sum of coupling | for each file, count of co-change partners summed over commits: the "witness" to interrogate first | take the first real code module | *Crime Scene* pp. 78–79 |
| Code age | time since last change, per file | none; a visual heuristic for packages of mixed age | *X-Rays* pp. 75–81 |
| Authors per file, diffusion | number of authors, fractal value 1 − Σ(share²) | few weeks of activity suffice | *X-Rays* pp. 120–122 |
| Main developer, ownership | share of added lines by the top contributor | two-year window for knowledge maps | *Crime Scene* pp. 141–157 |
| Knowledge loss | ownership restricted to ex-developers | classify by criticality, cross with hotspots | *X-Rays* pp. 202–205 |
| Complexity trend | a complexity proxy sampled over revisions | "it's the trend that's important, not the absolute values" | *X-Rays* p. 26 |

**What to look at.**

- **The churn shape over time.** Camel humps at fixed intervals mean merges
  at iteration deadlines; a rising line before a date is a death march;
  one spike sixty times the norm is usually a committed data file
  (*Crime Scene* pp. 166–167). The shape is the team's process, read from
  the log.
- **The commit vocabulary.** A word cloud of subjects shows what the team
  spends commits on: fixing, refactoring, features (*Crime Scene* pp.
  129–131). The miner's `isFix` flag is the same idea reduced to one bit.
- **Ownership and its holes.** Who owns what, and which owned areas belong
  to people no longer present.

**Pitfalls.** Tornhill's list, all of which apply: too much history hides
recent trends and flags dead hotspots; renames reset a file's history unless
resolved; squashed merges erase both social and coupling data; author
aliases must be normalised; generated content and committed test data
produce false spikes; pair programming hides the second author. And the
firm rule: the social analyses are **never** used to evaluate people
(*X-Rays* pp. 211–214). When in doubt about the social data, restrict the
scope to technical concepts like hotspots (*X-Rays* p. 206).

---

## 5. V3: Hotspots and surprises

This is the viewpoint the two earlier ones exist for. It is also where the
method departs from Tornhill's tooling, which holds only V2.

### 5.1 Hotspots

**Definition.** "A hotspot is complicated code that you have to work with
often" (*X-Rays*, p. 19): change frequency × a complexity proxy. Tornhill
uses lines of code as the proxy because it is language-neutral and "the
other ones are just as bad" (*Crime Scene*, p. 28). With a model that
carries measured `cyclomatic` per operation and a tangle metric per
component, the proxy can be richer, and the ranking becomes a small family:

| Rank | Effort axis | Complexity axis | What it finds |
|---|---|---|---|
| classic | revisions | `loc` | Tornhill's hotspots, comparable to his numbers |
| branchy | revisions | `sum:cyclomatic` | control-flow-heavy hotspots, invisible to loc when the file is short |
| tangled | revisions | membership in an SCC, weighted by tangle metric | code that is worked on often **and** has no safe change direction |
| fragile | revisions × fix density | `cyclomatic` | where bugs are fixed repeatedly |

Two expectations to check against, from the books: hotspots are roughly
4–6 % of the codebase (*Crime Scene* p. 48) and the top ones take 10–15 %
of all commits (*X-Rays* pp. 111, 126). A codebase where the effort is
spread evenly is either very healthy or has a history problem (squashes,
mass reformatting); look at the churn shape before trusting it.

**Join discipline.** The two artifacts join on paths: the model's anchors
are relative to the analyzed root, the history's paths to the repository
root, so the join is by suffix and an ambiguous suffix joins nothing and is
counted. A hotspot table must say how many files joined. On gson, 170 of
197 store files joined; the 27 that did not are a fact, not noise.

**Triage by name and size.** Before reading anything, Tornhill's name
heuristics (*Crime Scene* ch. 5): a build file with 79 revisions is a false
positive; a 4,000-line `Abstract*` class is a candidate; `*Impl`, `*Manager`,
`*Util` in the top ten are the usual suspects. Then the complexity trend
on the ambiguous ones: deteriorating, refactored, or stable (*Crime Scene*
p. 64).

### 5.2 Surprises

"Surprise is one of the most expensive things you can put into a software
architecture. ... Software bugs thrive on surprises" (*X-Rays* p. 38).
Tornhill's "concept of surprise" is a filter over change coupling: keep the
couplings that have no code-level dependency between seemingly unrelated
modules. He has to apply it by eye. With both graphs in one tool it is a
query:

- **Hidden coupling**: file pairs that co-change above threshold and have
  **no path**, in either direction, in the declared dependency graph. These
  are the message formats, the copy-pasted algorithms, the implicit
  protocols. On gson the query found the JsonSerializer/JsonDeserializer
  twins and the Since/Until annotations: pairs the declared graph does not
  connect and the history cannot separate.
- **Dead weight**: declared dependencies that **never** co-change in the
  window. Stable interfaces (gson's JsonToken, TypeAdapter) show up here,
  and so does the layer nobody has touched since the rewrite.
- **Cross-boundary co-change**: change coupling folded to modules, then
  filtered to pairs in different top-level modules or different declared
  layers. Tornhill measures 30 % of commits crossing layers in a stable
  layered app and up to 70 % in a feature-growing one (*X-Rays* p. 147).
  This is the number that decides whether the cut is by layer or by
  feature, and it feeds V4.

Each of these is an inference over two kinds of evidence, and is labelled
so. The city draws co-change as dashed arcs of a different colour from
dependency arrows, and the paper's tables carry a provenance column.

### 5.3 What to do with the ranking

Tornhill's prioritisation model, adopted whole:

- Refactor what is a hotspot, large, and with a rising complexity trend
  (*X-Rays* p. 102). Leave old, stable code alone even if ugly; "your best
  bug fix is time" (p. 78), a module a year older has about a third fewer
  faults.
- Kill clones that co-change; leave clones that evolve apart (p. 46).
- "Dead code is stable code" (p. 86): stability plus zero fan-in plus no
  entry-point role (V5) is the deletion list.
- Inside a hotspot, the *splinter* pattern: group its methods by
  responsibility, extract the busiest behaviour first, keep the old API as
  a facade, deliver in hours, never on a branch (pp. 57–64).

The output of V3 is a **ranked suspect list**, each entry carrying its
rank family, its anchors, its join status and the reason it ranked. It is
the input to the tour (section 10) and the scope of V6.

---

## 6. V4: Boundaries and style

**Question.** How is the codebase cut, in which architectural style, and do
the cuts hold up under change?

Tornhill's answer to "where are the boundaries" is pragmatic: use the
documentation if it is right, otherwise the folder structure, then refine
from what the change patterns suggest (*X-Rays* p. 96, *Crime Scene* p.
117). The method keeps that order and adds three evidence layers a static
model provides, ranked from strongest to weakest.

### 6.1 Topology: the import graph and its layering

The module import graph is the one relation reliable across all languages
(codegraph invariant 9). Its acyclic condensation has a natural layering
(Kahn layers over the SCC condensation, the same ordering the explain walk
uses). Read from it:

- **Depth and width.** A deep narrow layering is a pipeline; a shallow wide
  one with one hub is a star around a core; a large SCC at the top is a
  ball of mud with a thin shell.
- **Direction discipline.** In a hexagonal or clean architecture the domain
  modules have no outgoing imports to modules that reference infrastructure
  stubs (persistence, HTTP, messaging). This is checkable: for each module,
  the set of stub modules reachable through its imports. A "domain" module
  that reaches a JDBC stub is a violation the code admits to.
- **Package by layer or by feature.** If the top-level modules are named by
  technical role (controllers, services, repositories, dto) and V3's
  cross-boundary co-change is high, the cut is by layer and every feature
  change ripples through all of them: Tornhill's nopCommerce and MusicStore
  cases (*Crime Scene* pp. 111–116, *X-Rays* pp. 145–147). If the top-level
  modules are named by capability and co-change stays inside them, the cut
  is by feature. The mixed case, most common, is where the boundary report
  earns its keep.

### 6.2 Framework roles: what the annotations say

Stereotypes are written in the code as annotations, and codegraph carries
each as an `annotationUse` edge with its arguments. A framework profile (a
data table, not code) maps annotation identity to a role: stereotype
(`@Service`, `@RestController`, `@Repository`, `@Configuration`,
`@Component`), injection point, entry point, qualifier, primary. The role
census per module is the first honest **architecture fingerprint**: a
module that is 80 % controllers is a presentation layer whatever its name.

The profile is Spring today. The method requires the same table for the
other habitats the corpora live in: Jakarta EE and CDI, Micronaut and
Quarkus, ASP.NET Core attributes (`[ApiController]`, `[HttpGet]`,
`[FromServices]`), NestJS decorators, Axon and Spring Modulith for the
CQRS and DDD vocabulary (`@Aggregate`, `@CommandHandler`,
`@EventHandler`), Quartz and JobRunr for time. A table row is cheap; a
guess is not. A meta-annotated stereotype whose declaration is a stub is
left unclassified rather than guessed, which the paper counts as a feature.

### 6.3 Structural role signatures: what the graph shape says

Between annotations and names sits evidence that needs neither: the shape
of a type's edges. A handful of signatures cover most of what a reader
wants to know before opening a file.

| Signature | Reading |
|---|---|
| only fields, only trivial members (getters, setters, equals, hashCode), no throw sites, no corpus calls | data carrier: DTO, record, value holder |
| interface with exactly one corpus implementation, that implementation injected somewhere | a port with its adapter |
| implementation whose outgoing edges go mostly to stubs of one I/O library | an adapter (persistence, HTTP client, messaging) |
| no outgoing corpus calls, high fan-in from many modules | a leaf utility or a shared kernel candidate |
| operations with throw sites guarding writes to own fields | an entity or aggregate enforcing invariants |
| a type whose fields include an enum-typed status read and written by its own operations | a state machine candidate |
| every public operation has zero corpus callers and carries an entry-point role | a driving adapter (controller, listener, job) |

These are derived from declared facts and the framework table, so they are
labelled `derived`. They are the pre-computation of the Specy skill's
Decision Test 4 ("is it the right construct?") and of half of Test 2 ("is
it domain?"), and V7 consumes them as hints.

### 6.4 Names: the vocabulary census, used as corroboration

Names are the weakest evidence and the most tempting. Tornhill uses them
for triage only (*Crime Scene* ch. 5), and codegraph's invariants forbid
using a name for identity or membership (invariant 7: an id is never
parsed; the stub rule: membership is a whitelist, never a prefix). Within
that fence names are still valuable in two ways:

- **The suffix and prefix census.** Count types per suffix per module:
  `Controller`, `Service`, `Repository`, `Dao`, `Mapper`, `Dto`, `Request`,
  `Response`, `Handler`, `Command`, `Query`, `Event`, `Aggregate`, `Saga`,
  `Policy`, `Specification`, `Factory`, `Builder`, `Impl`, `Manager`,
  `Util`, `Helper`. The distribution is a dialect: a corpus heavy in
  `Controller`/`Service`/`Repository`/`Dto` speaks layered Spring; one in
  `Command`/`Handler`/`Event`/`Aggregate` speaks CQRS and DDD; one in
  `Actor`/`Message` speaks actors; `Filter`/`Interceptor`/`Middleware` is
  the request pipeline. The census names the style in the codebase's own
  words and, more usefully, names the **vocabulary the extraction skill
  should expect** (its naming table already lists these suffixes as hints).
- **Corroboration and contradiction.** A name agreeing with the structural
  signature and the framework role is strong; a name disagreeing with them
  is a finding. A `*Service` whose signature is a data carrier, a
  `*Repository` that reaches an HTTP stub, an `*Impl` with no interface:
  each is one line in the boundary report and one candidate for the
  refactoring report.

What the census must not do: feed identity, decide module membership, or
be reported as a fact. It is a `derived` column with a stated rule.

### 6.5 The boundary report

V4's artifact states, for the corpus: the layering with its depth and its
SCCs; the direction violations (which modules reach which infrastructure
stubs); the framework role census per module; the structural signature
census per module; the naming census per module; the cross-boundary
co-change share from V3; and one sentence per top-level module stating
its inferred role and the evidence that supports it. The C4-style
`.arch` extraction skill reads this to place containers and components
with confidence it cannot get from folders alone.

---

## 7. V5: Stimuli and flows

**Question.** What in this codebase reacts to something outside it, or to
time, and what does each reaction reach?

This viewpoint is the one the books do not have, because it needs the
static graph. It is also the bridge to meaning: the Specy metamodel says a
system is driven by commands, queries and external events, and by time
(temporal events), and drives others through events, commands and queries
(`DOMAIN-METAMODEL.md`, "Software System's Interface"). An inventory of
stimuli is an inventory of the system's interface in exactly those terms.

### 7.1 A taxonomy of stimuli

| Kind | Domain reading | Detection evidence |
|---|---|---|
| inbound command | a command | HTTP write mappings (`@PostMapping`, `[HttpPost]`), RPC handlers, command handlers (`@CommandHandler`), CLI verbs |
| inbound query | a query | HTTP read mappings, GraphQL resolvers, query handlers |
| external event | an external event | message consumers (`@KafkaListener`, `@JmsListener`, `@RabbitListener`), webhooks, `@EventListener` on a type declared outside the module |
| internal event | an internal event with its reaction | `@EventListener`, `@TransactionalEventListener`, `@EventHandler` on a type declared inside the corpus |
| temporal | a temporal event, recurring or relative | `@Scheduled`, Quartz `Job`, JobRunr, `TimerTask`, `ScheduledExecutorService` submissions with a literal delay |
| lifecycle | not domain: technical boot and teardown | `main`, `ApplicationRunner`, `@PostConstruct`, `@PreDestroy`, servlet `init` |
| framework callback | usually not domain | `Filter`, `Interceptor`, `Converter`, `HealthIndicator`, serialization hooks |

Three detection layers, strongest first, each labelled with its provenance:

1. **Annotation roles** from the framework table (the `entry-point` role
   that exists today, refined into the kinds above by a second column).
2. **Interface implementations of framework stubs**: a type implementing
   `Job`, `Runnable` submitted to an executor, `HttpRequestHandler`,
   `MessageListener`, `CommandLineRunner`. The `interfaceImplementation`
   edge to a stub in a known framework module is the evidence; the
   framework table lists the interfaces as it lists the annotations.
3. **The structural fallback**: a public operation in a non-test module
   with zero corpus callers. It is either an entry point the tables do not
   know, a reflection target, dead code, or library API. History separates
   two of these cases (dead code is stable; an entry point is worked on),
   and the stub list separates a third (a reflection-driven corpus shows a
   `Class.forName` or `Activator.CreateInstance` stub). What remains is
   reported as **unclassified zero-caller surface**, ranked by fan-out, and
   read by a human.

### 7.2 Slices: forward reachability from each stimulus

From each entry point, walk the invocation and access edges forward. The
reachable set is the **slice** of that stimulus: everything that can run
when it fires. Two walks, and both are reported:

- **facts only**: declared edges. The lower bound.
- **with candidates**: declared plus dynamic-candidate edges (the DI wiring
  the analyzer derives from injection points and implementations, and
  uncertain dispatch). The plausible upper bound.

The difference between the two walks is itself a finding: a slice that
doubles when candidates are added runs through an interface whose
implementation is chosen at runtime, and a reader must know which one.

Each slice ends in **exit points**: calls to stubs of I/O libraries
(persistence, HTTP clients, message producers, file system, clock, random).
An entry point and its exit points are one end-to-end flow. In domain
words: a command, the operations it triggers, the SPIs it needs.

### 7.3 What the slices give

- **A use-case decomposition for free.** Each slice is a candidate use
  case. Cluster entry points by the overlap of their slices (Jaccard over
  reachable types): entry points that share most of their slice belong
  together; groups with little overlap are candidate bounded contexts.
  Types present in most slices are the shared kernel or the cross-cutting
  plumbing; V6 tells which.
- **The residue.** The corpus minus the union of all slices is code no
  stimulus reaches. Cross with V2: stable residue is deletion material
  ("deleted code is the best code", *X-Rays* p. 86); actively changed
  residue is a detection gap (reflection, a framework the tables do not
  know) and is reported as such.
- **Hotspot slices.** Rank the slices by the V3 hotspot mass they contain.
  The slice through the biggest, most-changed, most-tangled code is the
  one to read first and the one to explain first.
- **Coverage for the explain budget.** Fineract has 53,207 units. Nobody
  explains them all on a first visit. The top-k hotspot slices bound the
  first explain run to what the effort says matters.

---

## 8. V6: Meaning

**Question.** What does each unit do, said in domain words a reader trusts?

The explain walk is the mechanism: units are operations, then types, then
modules; a strongly connected group is one unit; everything is explained
after what it depends on, so each prompt carries the explanations already
written for its dependencies rather than the model's guess about them. The
prompt hands the model the Specy vocabulary with one-line definitions and
asks for a structured block per level: for an operation, safety,
idempotency, owner kind, the command it handles, the events it emits,
preconditions with violation reasons, postconditions, invariants enforced,
SPIs used; for a type, the concept it realises, identity, fields
classified, invariants with enforcement, a state machine if a status enum
drives one, relations, exposed operations, ports; for a module, APIs, SPIs,
dependencies, concepts, a bounded-context hint, the ubiquitous language,
and for a package cycle a shared-kernel verdict. Every record carries a
Merkle fingerprint of its inputs, so re-runs redo only what changed, and a
confidence the model is told to lower when the code does not let it decide.

What the earlier viewpoints add to the walk, and this paper asks for:

- **Scope from V5, order from V3.** Explain the top hotspot slices first,
  bottom-up within each slice. The walk order stays dependency-consistent
  inside a scope; the scope is what changes.
- **The stimulus in the context pack.** An operation that is an inbound
  command handler, an external-event consumer or a temporal trigger should
  be told so, with the kind. The model then decides command versus query
  versus reaction from evidence, not from a method name.
- **The structural signature in the context pack.** "This type has the
  data-carrier signature" or "this type is an adapter over a JDBC stub" is
  a fact the model should see, so that `notDomain` is assigned on evidence.
- **Trivial members stay templated.** Getters, setters, equality, a
  field-assigning constructor: decided from facts, no call, confidence 1.
  The saving is real at corpus scale and the answer is not worse.
- **Two models, one for leaves and one for roll-ups.** Operations are
  many and local; types and modules are few and need synthesis. The split
  already exists as a flag; the paper makes it the default budget shape.

What the model is not allowed to do, and the design already enforces:
invent a dependency marked NOT EXPLAINED, follow an instruction found in a
comment (everything from the corpus is fenced and declared material), or
have its prose hashed into a fingerprint so a non-deterministic answer
cascades re-runs.

---

## 9. V7: Domain

**Question.** Which parts of this codebase are the business, and what is
the model?

The Specy extraction skill already has the discipline: four sequential
decision tests before any element is emitted. Is it real (a line of
production or test code evidences it)? Is it domain (would it survive a
stack swap)? Is it faithful (does the expression match the condition in the
code)? Is it the right construct? Then a `.domain` file, a `.sysreq` in
EARS form derived from it, a refactoring report over ten design smells, and
a gaps report of what the grammar could not express. This paper does not
change the tests. It changes what the tests are run on.

### 9.1 The side-car as evidence, not as prose

Today the skill reads source. The method has it read the insights side-car
first and the source second, under these rules:

- An insight record is admissible under Test 1 because it carries the
  anchors of the unit it describes; the skill cites the anchor, not the
  record.
- The record's `concept`, `owner`, `eventKind` and `interfaceRole` are the
  model's proposal for Test 4; the structural signature and the framework
  role from V4 are the corroboration; disagreement is an `UNCLEAR` marker
  with both sides stated.
- `notDomain` records are the first-pass answer to Test 2. The skill still
  applies its grey-zone rule (affects an entity field or is a precondition:
  domain; otherwise infrastructure) to the ones the model marked
  `unknown`.
- The module records' `boundedContextHint` and `sharedKernelHint`, joined
  with the V5 slice clusters and the V3 cross-boundary co-change, are the
  evidence for the context map. A group of modules that cluster by slice,
  co-change together, and share a vocabulary is one context. A pair of
  contexts joined by an SCC is not two contexts.

### 9.2 Separating technical from domain concerns, structurally

Test 2 is the hard one, and it is mostly answerable before the model is
asked. Three structural measures, all `derived`:

- **Purity of a type or module**: the share of its outgoing references
  that target corpus types rather than framework or infrastructure stubs.
  A pure module is the domain candidate; a module whose references are
  mostly to stubs is plumbing; the mixed ones are where an application
  service lives.
- **Position in the slices**: the last corpus type before an exit point is
  an adapter; the first corpus type after an entry point is a driving
  adapter or an application service; what sits between and is pure is the
  domain.
- **Invariant evidence**: throw sites guarding writes, preconditions with a
  reason, an enum-typed status driven by own operations. This is where
  business rules live in code that has no DDD vocabulary at all.

The output is a per-type **domain candidacy** with the three measures
stated, which V7 uses as a prior and V6 already saw in its context pack.

### 9.3 The stimuli become the interface

V5's inventory maps one-to-one onto the Specy system interface: inbound
commands and queries, external events with their reactions, temporal
events with their guards, and on the driving side the SPIs the slices
exit through. A `.domain` produced this way starts from the outside in,
which is how a domain expert reads it, while its operations were explained
from the inside out, which is how the evidence is consistent.

### 9.4 The refactoring report gains a weight

The skill's smells (anemic entity, god entity, missing aggregate, missing
state machine, transaction script, missing error events, missing temporal
concerns, orphan events, missing invariants, weak aggregate boundaries)
are static. Each gets the V3 rank of the code it sits in. An anemic entity
nobody has touched in three years is a note; the same smell in the top
hotspot is the first refactoring. This is Tornhill's interest rate applied
to design smells, and it is what makes the report short enough to act on.

---

## 10. The tour: a reading order for one person

The method's last artifact is not a report but an itinerary. Someone new
to the codebase reads, in this order, with the evidence for each stop
beside it:

1. **The city**, height by cyclomatic sum, coloured by framework role, at
   the angle where the tangles are visible. Five minutes. The reader now
   knows the shape, the big districts and the knots.
2. **The boundary report**'s one-sentence-per-module summary and the
   architecture fingerprint. The reader knows the style and where the
   cuts fail.
3. **The stimulus inventory**, grouped by kind, each with its slice size
   and hotspot mass. The reader knows what the system reacts to.
4. **The top three hotspot slices**, each read from its entry point
   inward, with the explanations beside the source. The reader now knows
   the three flows that matter and the code that carries them.
5. **The surprises**: hidden couplings with no structural path, and the
   biggest tangle's feedback set. The reader knows where the model in the
   code disagrees with the model in the team's heads.
6. **The knowledge map** over the same hotspots: who owns them, and which
   owners are gone.
7. **The `.domain`** and its refactoring report, weighted. The reader knows
   what the business is, in its own words, and where the code fails it.

Everything on the itinerary links back to a file and a span at a commit.
The reader can disagree with every conclusion and still has the evidence.

---

## 11. What the method does not do

- **It needs history to rank.** Without a usable log (a copied tree, a
  squashed import, a repository younger than about 150–200 commits) V2 and
  V3 degrade to V1's terrain, which ranks nothing. Say so in the report
  rather than ranking by size.
- **It is bounded by resolution.** Reflection, DI containers configured in
  XML or code, dynamic dispatch, code generation at build time and
  languages the extractors do not cover are lower bounds on the graph, and
  therefore on the slices and the residue. Each extractor's profile
  documents its blind spots; the report repeats them next to the numbers
  they affect.
- **A commit is the smallest unit of co-change.** Work split across
  commits or repositories needs logical change sets (same author within a
  day, or ticket ids), which trade precision for recall.
- **Names lie, and the method knows it.** The naming census is
  corroboration. It never decides.
- **The model can be wrong.** Confidence is recorded, dependencies not yet
  explained are named as such, and every block is a proposal the skill
  must corroborate. The side-car is a side-car: it never enters the model.
- **No score for the whole.** Tornhill's warning holds: "Hotspot data
  cannot give you a simple quality score, and it's doubtful if any
  automated metric could" (*X-Rays* p. 173). The method produces a ranked
  list and a map, not a grade.

---

## 12. Validation plan

The corpora already used by codegraph give the method a graded test:

| Corpus | Size | What it should show |
|---|---|---|
| spring-petclinic | small, Spring | every stimulus kind but temporal detected from the table; slices match the use cases by hand; the `.domain` is Owner/Pet/Visit/Vet with the vet-specialty read-only entity |
| google/gson | 3.6 k entities, 2,088 commits, 55 release tags | hotspots on the stream package; hidden coupling of the serializer/deserializer twins; a residue of near-zero; the domain is a library, and the method should say so rather than invent one |
| apache/commons-lang | 15 k entities | a utility library with no stimuli: V5 returns library API as zero-caller surface and the method reports "no domain, a toolkit" |
| spring-petclinic at the `@Autowired` era vs HEAD | two revisions | the slices with candidates are identical before and after implicit constructor injection, which tests the DI derivation |
| Apache Fineract | 103 k nodes, 18 package tangles | the tangled-hotspot rank finds the 509-package knot; slice clustering proposes contexts that a Fineract maintainer recognises; explain scoped to the top three slices stays under a stated budget |
| dotnet/eShop, OrchardCore | C#, 7 k and 88 k entities | the ASP.NET Core attribute table classifies the stimuli; eShop's ten services cluster as ten slice groups |

Each row is a claim the method makes about a corpus; each becomes a test
that pins a report, so that the method cannot drift without a fixture
saying so.

---

## Appendix A. The viewpoints as codegraph commands

What exists, what the paper adds. "Gap" marks work the paper asks for.

| Viewpoint | Exists | Gap |
|---|---|---|
| V1 | `analyze --report deps\|cycles\|coupling`, `city --height sum:cyclomatic --footprint loc`, `navigator` | abstractness and modifiers are not in the model, so the main-sequence distance is not computable |
| V2 | `scm`, `history --report summary\|hotspots\|authors\|coupling`, owners and truck factor, `snapshots`, `timeline` (loc series) | code age; complexity trend per entity over keyframes (the store holds the keyframes); commit-subject vocabulary; logical change sets by author-day or ticket |
| V3 | `history --report hidden\|deadweight --model`, `replay --history` (co-change arcs, owner colour) | the hotspot rank family (branchy, tangled, fragile) as one report; name-and-size triage as a column; cross-boundary co-change share |
| V4 | framework roles and `--report wiring` (Spring); import graph; SCC layering inside the walk order | layering report with direction violations; structural signatures; naming census; the boundary report; framework tables beyond Spring |
| V5 | the `entry-point` role (Spring web, event, scheduled, bean) | the stimulus taxonomy as a role column; interface-implementation detection; zero-caller surface; forward slices (facts-only and with candidates); exit points; slice clustering; residue |
| V6 | `explain` with scope, depth, budgets, fingerprints, two models | stimulus kind and structural signature in the context pack; scope from slices; hotspot order |
| V7 | `specy:domain-extract-from-code` with its four tests and reports | the codegraph heuristic in the skill (PLAN.md names it; the skill does not contain it); side-car as evidence; purity, slice position and invariant evidence as the Test 2 prior; smell weighting by hotspot rank; context map from slice clusters and co-change |

## Appendix B. Provenance of every claim kind

| Claim | Kind | Where it comes from |
|---|---|---|
| an entity, an edge, a measure | `declared` fact | the extractor, from source |
| a fold, a cycle, a layering, a coupling metric, a structural signature, a naming census entry | `derived` | the analyzer, from declared facts by a stated rule |
| a DI wiring edge, a slice computed with candidates | `dynamic-candidate` | the analyzer, from injection points and implementations |
| a hotspot, a co-change, an owner, a hidden coupling | history inference | the miner and the join, from the log |
| an explanation, a concept, a confidence | model proposal | the explain walk, from source slices and facts, fingerprinted |
| a `.domain` element | corroborated proposal | the skill, from a model proposal plus an anchor plus a test |
