# Codegraph — website and documentation roadmap

Status: **in progress, 2026-09-07.** The site skeleton, landing page and
section indexes exist under `website/`; the four quadrants are being written
from the content plan in §4. This document plans
the project's public face: a landing page that answers "should I try this?"
in under a minute, and a documentation site organized on the
[Diátaxis](https://diataxis.fr) model — **tutorials** (learning),
**how-to guides** (doing), **reference** (looking up), **explanation**
(understanding). The four are kept apart because a page that tries to teach,
instruct, list and justify at once does none of them well.

The design docs already in `docs/` are strong explanation material and weak
everything else. The website work is mostly writing the three missing
quadrants, not rewriting the fourth.

---

## 1. Why a website, and why now

The [README](README.md) is the entry point for someone who has already found
the repository. A website is for someone who has not: it is what search
engines index, what a conference slide links to, and what gives the project a
name people can remember. The reasons are the usual ones from the "top ten
reasons I won't use your open-source project" list, restated as gaps that
exist today:

| Gap today | What closes it |
|---|---|
| No project home page; only a GitLab repository | the landing page (§3) |
| No domain name | `codegraph.dev` or similar (§6) |
| No license file | choose one before the site goes public; a site advertising unlicensed code is worse than no site |
| No screenshots or demo anywhere | a hosted live city and navigator over a public corpus (§3.3) |
| No `examples/` a reader can run without a JDK | published sample artifacts (`gson.jsonl`, `gson-city.json`) (§4, tutorials) |
| No release channel | npm package for the CLI, a GitLab release for the extractor jar (a prerequisite for a tutorial that starts with "install") |
| No way to reach the project except a merge request | an issue template, a contact address, and one social account (§6) |

---

## 2. Stack and hosting

**One site, one build, one deployment**, at `website/` — Hugo (extended,
≥ 0.146). Two halves that look nothing alike, sharing one config, one content
tree and one `public/`:

- **`/` — the landing page.** **Themeless**: the copy is
  `content/_index.md` plus `content/sections/*.md` (one Markdown file per
  essay row), the templates are `layouts/landing/`, and Hugo Pipes
  concatenates, minifies and fingerprints the two stylesheets into one
  request. Built on the Defsquare Design System (EB Garamond display, IBM Plex
  Sans Condensed body, navy footer, the heat gradient on one display word).
  Every documentation link resolves through one `docsBase` param.
- **`/docs/` — the documentation.** The **Hextra theme**, vendored as a git
  submodule at `website/themes/hextra`, over `content/docs/` in the four
  Diátaxis quadrants. The PlantUML diagrams are rendered to SVG by
  `render-plantuml.sh` and committed under `website/static/`.

The two shells coexist by **scoping, not by separate sites** — a project
`layouts/baseof.html` would otherwise shadow the theme's on every
documentation page:

1. the landing shell is scoped by page type (`type: landing` →
   `layouts/landing/*.html`);
2. its partials are namespaced (`layouts/_partials/landing/*.html`);
3. it carries its own Markdown render hooks (`layouts/landing/_markup/`),
   because Hextra's emit Tailwind `hx:` classes, a copy button and heading
   anchors that the landing stylesheet cannot style.

Syntax highlighting follows the same principle rather than a global switch:
`noClasses: false` makes colour a stylesheet concern, the documentation loads
Hextra's Chroma sheet, and the landing — which does not — gets code in one
colour, as the design system asks.

`website/package.json` is a shim so `pnpm -r build` covers the site on a
machine with Hugo; CI builds it in its own job with the Hugo version pinned.
It lives in this repository so a CLI change and its documentation ship in one
merge request; deployed to Cloudflare Pages (GitLab Pages as fallback).

```bash
cd website && hugo server -D --port 1314   # http://localhost:1314/  and  /docs/
cd website && hugo --minify --gc           # → website/public/
```

---

## 3. The landing page

One page, one scroll, no navigation required to get the point. Sections in
order, each with its job:

### 3.1 Hero
- **Headline:** "See the structure of code you did not write." with
  "structure" carrying the design system's heat gradient.
- **Sub-line:** one sentence on what it does (extract without building, then
  city, navigator, history, explanations).
- **Two buttons:** *Try the live demo* (the hosted gson city) and *Get
  started* (the first tutorial).
- **Beside the text:** today, the gson city drawn as an SVG from the real
  `city.json` (`website/scripts/city-svg.mjs`); later, a looping
  10-second recording of orbiting the same city, with the SVG as its poster
  frame so nothing critical depends on the video playing.

### 3.2 The four questions
The README's table as four cards, each with a real screenshot, a one-line
answer, and the command that produced it:
1. What does it look like — city screenshot.
2. What exactly depends on what — navigator screenshot with a fan-in list
   and its anchors.
3. How did it get this way — replay screenshot mid-timeline, owner colour
   mode.
4. What does it mean — an insight record rendered as prose beside its
   source.

### 3.3 Live demo
An embedded, full-width iframe of the hosted city over google/gson, with a
link to open it in its own tab, and the navigator beside it. These are the
existing Vite bundles served statically with a pre-built `city.json` and
`navigator.json`. The demo is the strongest argument the project has and it
costs nothing to host.

### 3.4 Sixty-second quick start
The README's quick start, verbatim, with a copy button per block. Ends with
"On gson this takes about a minute end to end."

### 3.5 Why it is trustworthy
Three short blocks, each one design bet from the README's "Why codegraph"
with a visual: *facts and inferences never mix* (a DOT excerpt with a solid
and a dashed edge), *every claim points at a line* (a navigator row with its
anchor), *no build required* (a stub building in the city, visibly darker).

### 3.6 Honest limitations
The README's limitations list, unchanged. A landing page that hides "Java
only" costs more trust than it gains visitors.

### 3.7 Footer
License, repository, changelog, contact, the prior-art credits.

Design notes: light ground like the city itself (`#eef1f5`); one accent colour
taken from the city palette's corpus-building teal; no stock illustrations;
inference is always desaturated, as in the renderer; every image is
a real render of a real corpus. Read the *Code city visualization rules* in
[`CLAUDE.md`](CLAUDE.md) as the style guide: meaning controls appearance
there and it should here too.

---

## 4. The documentation content, by quadrant

This is the content plan the site is built from. Each page has a path under
`website/content/`, a one-line purpose, an outline, and the source material
it is written from. Status: **exists** = move and edit an existing doc;
**partial** = exists but needs restructuring; **write** = does not exist.

Rules that apply to every page:
- The rationale on the site is codegraph's: why a fact is kept apart from an
  inference, why a model needs no build, why every claim carries an anchor.
  The site never argues for its own tooling.
- Every command line is checked against `codegraph <cmd> --help` before it is
  published; a flag that `--help` does not list does not appear.
- Every example runs on one of two corpora: the reference fixture
  (`fixtures/java/src`, committed, no network) or google/gson at a pinned tag.
  Outputs shown are real outputs, trimmed, never typed by hand.
- Cross-links use site-absolute paths (`/reference/cli/analyze/`), and only
  paths listed here.

### 4.1 Tutorials — `content/tutorials/`
A tutorial takes a beginner from nothing to a result on screen and never
explains more than the next step needs. Each states its prerequisites and
how long it takes.

| Path | Purpose and outline | Sources | Status |
|---|---|---|---|
| `first-city.md` | **Your first code city in ten minutes.** Install from a clone; extract gson (or the fixture) with the jar; `validate`; `city --serve`; orbit, hover a building, click a district; what you are looking at in one paragraph. Ends with the city on screen. | README quick start, docs/cli.md | write |
| `reading-the-city.md` | **Reading a city.** Districts as packages, nesting; height = LOC and footprint = members by default; the legend; arc hue (direction) and saturation (provenance), red for the feedback set; stub buildings; the fan-in/fan-out click; the `buildings` toggle. Uses the gson city from the first tutorial. | docs/city-render.md CR-3, CR-4b | write |
| `navigator.md` | **Finding what depends on a class.** `navigator --serve`; search for `TypeAdapter`; read the fan-in list, the role classification, the member and the anchor; jump to the Graph, Cycles and Coupling tabs. | docs/navigator.md NV-4, NV-5, NV-9 | write |
| `history-replay.md` | **Replaying a project's history.** `scm` on the gson clone; `history --report hotspots`; `snapshots --tags` into a store; `timeline` for one class; `replay --serve` with the history joined; scrub the timeline, switch to owner colours. | README "Mine the history", PLAN §11 | write |
| `explain.md` | **Explaining a package with a language model.** `explain --dry-run` to see the plan; `--estimate` with prices; run with `--scope` on one package and `--max-calls`; read one insight record beside its source; re-run and watch it skip. | docs/insights.md, README | write |
| `sql.md` | **Querying the model with SQL.** `import` to get `model.db`; the orientation queries; fan-in of a type; a facts-only view; a reachability query. | docs/sql-cookbook.md | partial |

### 4.2 How-to guides — `content/how-to/`
A how-to assumes competence and answers one question. Titles are tasks.

| Path | Purpose and outline | Sources | Status |
|---|---|---|---|
| `install.md` | Clone, build, symlink; JDK and sdkman note; verify with `--version` and `profiles`. Points at releases once W4 lands. | README, CLAUDE.md commands | partial |
| `extract-java.md` | Run the extractor on a real repository: choose one source root; multi-module repos; what becomes a stub and how to read the diagnose summary. | docs/cli.md, PLAN M9b gotcha, fixtures/java/README.md | write |
| `ci-gate.md` | Gate a pipeline on `validate` and on `--report cycles` using exit code 3; keep the artifact as a job artifact. | docs/cli.md conventions, .gitlab-ci.yml | write |
| `facts-only-view.md` | Get a facts-only or internal-only answer with `--declared-only` / `--internal-only`, and read the view stamp in the output. | docs/analyzer.md AN-4 | write |
| `export-diagrams.md` | Export DOT, PlantUML, CSV, JSON; render with Graphviz and PlantUML; what solid, dashed and `<<stub>>` mean. | old README PlantUML section, docs/cli.md | partial |
| `complexity-city.md` | Build a complexity city with `--height sum:cyclomatic --footprint loc`; scales; `--carry`. | README, PLAN M10b, docs/city-model.md CM-4 | write |
| `spring-roles.md` | Colour a Spring codebase by role with `city --framework spring`; inspect wiring with `analyze --report wiring`; what is inferred. | PLAN M10d, docs/analyzer.md AN-12b | write |
| `temporal-store.md` | Sample a repository's tags or every N commits into a store with `snapshots`; resume; compose two runs with different `--src`. | README, PLAN §11.2 | write |
| `history-joins.md` | Find hidden coupling and deadweight by joining `history.jsonl` with a model; tune `--min-support` / `--min-confidence`. | README, PLAN §11 | write |
| `explain-cost.md` | Estimate, cap and scope an `explain` run; choose OpenRouter or Cloudflare; pick models per level; force a re-run. | docs/insights.md IN-6, IN-8 | partial |
| `serve-network.md` | Serve the city or navigator to a LAN, or keep it local with `--host 127.0.0.1`; `--port 0`; the two-step artifact route. | README | write |
| `query-model-db.md` | Read `model.db` from your own tool: the four rules, the tables to start from. | docs/sql-cookbook.md "Four rules" | exists |
| `write-an-extractor.md` | Write an extractor for a new language against the schema: record order, surrogates, the profile check, the conformance gate. | schemas/README.md, PLAN §10, docs/model-encoding.md §2 | write |
| `compare-snapshots.md` | Diff two models of one corpus (fixture-style expected files) and two revisions of a store (`timeline`). | fixtures workflow, docs/cli.md | write |

### 4.3 Reference — `content/reference/`
Austere, complete, structured like the thing described. Where a generator
exists (`--help`, `schemas/`, `profiles --json`), the page is its rendering.

| Path | Purpose and outline | Sources | Status |
|---|---|---|---|
| `cli/_index.md` | The shared conventions (union loading, stdout/stderr, the two views, exit codes, `--json`, `model.db` cache) and the command index. | docs/cli.md | partial |
| `cli/<command>.md` × 14 | One page per command: synopsis, arguments, every option with default, exit codes, one example. Generated from `--help` in W3; hand-written from it now. | `codegraph <cmd> --help` | write |
| `model-jsonl.md` | The interchange: record types, section order, surrogates, header dictionaries, the `eof` trailer, the per-record schemas. | schemas/README.md, docs/model-encoding.md §2 | partial |
| `metamodel/_index.md` + `identity.md`, `traits.md`, `edges.md`, `provenance.md`, `profiles.md`, `stubs.md`, `measures-literals.md` | METAMODEL.md split into one page per concept, tables kept verbatim. | METAMODEL.md | exists |
| `profiles.md` | The nine language profiles as tables: per kind, required and optional traits, notes. From `codegraph profiles --json`. | `profiles --json` | write |
| `artifacts/city-json.md`, `navigator-json.md`, `history-jsonl.md`, `domain-facts.md`, `insights-jsonl.md` | Each artifact's shape with one real excerpt from the fixture. | docs/city-model.md CM-3, docs/navigator.md NV-2, package types | partial |
| `model-db.md` | The SQLite store schema, table by table. | docs/model-encoding.md §3.1 | exists |
| `city-metrics.md` | Built-in metric names, the open forms, scales, channel bindings and the legend vocabulary. | docs/city-model.md CM-4, CM-5, `city --help` | partial |
| `environment.md` | Environment variables (`OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CITY_JSON`, `NAVIGATOR_JSON`, and the test-only `CODEGRAPH_CORPUS_MODEL`) and where each is read. | `grep -rn process.env packages` | written |
| `java-extractor.md` | Flags, the Java profile mapping table, what resolves and what becomes a stub, annotations and measures emitted. | extractors/java, PLAN §5.1, fixtures/java/README.md | partial |
| `exit-codes.md` | The four exit codes and the findings contract. | docs/cli.md | exists |

### 4.4 Explanation — `content/explanation/`
Discursive: why things are the way they are, the alternatives, the trade-offs.
Each page links to the tutorial or how-to that applies it.

| Path | Purpose and outline | Sources | Status |
|---|---|---|---|
| `why-traits.md` | Why a trait-based metamodel: the Clojure fn-var that no hierarchy places; what FamixNG got right; profiles as data. | METAMODEL.md §3.7, §5, README | partial |
| `facts-vs-inferences.md` | Provenance as a first-class value: the four values, why they never mix, how every rendering keeps them apart, the Spring wiring example. | METAMODEL.md §1.3, docs/analyzer.md AN-8, AN-12b | partial |
| `extracting-without-compiling.md` | Stubs, the whitelist rule, why a name prefix lies, the resolution rate and what it means. | PLAN §5.2, METAMODEL.md §6 | partial |
| `why-jsonl.md` | The fineract story: 559 MB, the string ceiling, surrogates, closure by encoding. | docs/model-encoding.md §1–2 | exists |
| `identity.md` | Identity as a natural key; why a rendered id is never parsed; injective rendering. | docs/model-metamodel.md MM-1 | exists |
| `analysis-pipeline.md` | Stages as pure functions; views as predicates; folding; cycles, tangle score and feedback sets; determinism. | docs/analyzer.md | exists |
| `city-is-a-model.md` | The city as a second model; meaning controls appearance; honesty rules; per-frame allocation. | docs/city-model.md, docs/city-render.md | exists |
| `navigator.md` | One classified row per base edge; recovering a reference's role; the type-only import rule. | docs/navigator.md | exists |
| `time-as-structure.md` | Hotspots, ownership, co-change, hidden coupling and deadweight; why history is a dependency source cannot show; the replay design. | PLAN §11, Tornhill | write |
| `explaining-bottom-up.md` | Units, cycles as one unit, context packs, fingerprints, the side-car rule. | docs/insights.md | exists |
| `architecture.md` | The packages, the hard boundaries and why each exists. | CLAUDE.md, PLAN §1–2 | partial |
| `decisions.md` | The decision log. | PLAN §16 | exists |
| `prior-art.md` | Moose/FamixNG, CodeCity, Structure101, Gource and Tornhill, Sourcetrail, jQAssistant, ArchUnit: what each does and where codegraph differs. | README credits | write |

### 4.5 Documentation debt found while writing (repository docs, not the site)

Discrepancies the reference pass found between the repository's own docs and
the code. The site follows the code; these are the files to correct:

- `docs/model-encoding.md` §3.1: the DDL block omits `entity.value`,
  `edge.arguments`, `edge.candidate_count`, and the whole temporal block
  (`revision`, `entity_key`, `entity_version`, `edge_version`) with its indexes.
- `PLAN.md` §5.1 (Java mapping table): no `TMetrics` (M10b) or `TWithValue`
  (M10c); `TWithChildren` missing from `method`/`constructor`; edge list omits
  `annotationUse` and `throws`; lambda disambiguator stated as `(file, startLine)`
  where the profile says `file:line:column`; output named `model.json`.
- `METAMODEL.md` §3.2/§4 still describe `children` as present in files; the
  shipped 1.0.0 schema has no such key.
- `docs/city-render.md` CR-4b names a "type dependencies" toggle; the shipped
  header has Show buildings / fan-in / fan-out / externals, Tangles, Colors.
- `README.md` (now fixed) and `docs/city-render.md` describe arcs as green
  (declared) vs red (inferred); the renderer uses hue for direction,
  saturation for provenance, red for the minimum feedback set.
- Version skew: `codegraph --version` reports 0.1.0, the extractor jar 0.2.0.
- Fixed in this pass: `docs/cli.md` (`--no-cache` is not universal; `analyze`
  has no `--framework`), `fixtures/java/README.md` (`model.json` → `.jsonl`),
  the `scm`/`snapshots` `--help` default text, and the temporal-store
  `entity_metric` import bug.

---

## 5. Phases

Each phase has a definition of done, in the style of `PLAN.md`. Order matters:
a public site with no license or no demo is a phase not done, not a phase
shipped early.

### W0 — Prerequisites (before any public URL)
- [ ] Choose and commit a `LICENSE`; update README and `package.json`.
- [ ] Register the domain (§6).
- [ ] Produce the sample artifacts over google/gson at a pinned tag:
      `gson.jsonl`, `gson-city.json`, `gson-navigator.json`,
      `gson-history.jsonl`, and a small `gson.insights.jsonl` excerpt.
      Store them as GitLab release assets, not in git.
- [ ] Capture the screenshot and recording set: city (default, complexity,
      Spring role on petclinic), navigator, replay mid-timeline, an insight
      record. Every image at a user-facing camera angle, reviewed.
- **DoD:** license in place; assets downloadable by URL; images in
  `website/public/`.

### W1 — Site skeleton and landing page
- [x] `website/` Hugo site with Hextra vendored as a submodule; `hugo`
      builds it locally; the `website/package.json` shim keeps `pnpm -r build`
      covering it.
- [x] A pinned-version Hugo job in `.gitlab-ci.yml` (`hugomods/hugo:exts-0.165.0`, submodules fetched).
- [x] Landing page per §3 at `website/` root, a themeless Hugo shell on the
      Defsquare Design System: hero with a generated SVG of the real gson city (the artifact
      drawn, not an illustration), four questions as essay rows, trust,
      sixty-second start, limitations, navy footer. Reviewed as screenshots
      at 1440 and 390 wide.
- [ ] Screenshots of the live UIs, the hero recording and the live demo
      iframe (need W0).
- [ ] Cloudflare Pages project, preview deploys on merge requests, production
      on `main`.
- [x] Sidebar with the four quadrant sections and their index pages.
- [x] Every page of §4 written (74 content files, 162 rendered pages; every
      `codegraph` flag checked against `--help`, every internal link resolved).
- [ ] Redirect notes added to the `docs/` files that moved.
- **DoD:** the landing page loads in under two seconds on a cold cache;
  the demo city orbits; every link resolves; Lighthouse accessibility ≥ 90.

### W2 — Tutorials and the first how-tos
- [ ] The six tutorials of §4.1, each tested by following it verbatim on a
      clean machine (a container with Node and a JDK), timing recorded on
      the page.
- [ ] The how-tos marked *partial* in §4.2 finished; the install guide
      covers the clone route and points at the release route once W4 lands.
- **DoD:** a newcomer with no prior context reaches a city on screen from
  the first tutorial without asking a question; recorded once by someone
  other than the author.

### W3 — Reference, generated
- [ ] CLI reference generated from the command definitions at build time;
      a CI check fails when `docs/cli.md` and the generated page disagree.
- [ ] Schema reference rendered from `schemas/*.schema.json`; profiles
      reference rendered from `codegraph profiles --json`.
- [ ] Artifact-format pages with one real excerpt each, taken from the W0
      assets.
- [ ] Changelog generated from Conventional Commits per release.
- **DoD:** no hand-maintained list of options anywhere on the site; the
  `gen:schemas` drift check extends to the site.

### W4 — Releases and the remaining how-tos
- [ ] `@codegraph/cli` published to npm with the built viz and navigator-ui
      bundles included; the extractor jar attached to a GitLab release.
- [ ] Install how-to rewritten around `npm i -g @codegraph/cli` and a jar
      download; the clone route demoted to a contributor page.
- [ ] Every remaining *write* how-to in §4.2.
- **DoD:** `npx @codegraph/cli city gson.jsonl --serve` works on a machine
  that has never cloned the repository.

### W5 — Explanation and outreach
- [ ] The *write* and *partial* explanation pages of §4.4, including the
      prior-art comparison.
- [ ] A blog section with the first three posts: the fineract 559 MB story
      (why JSONL), the gson time-replay walkthrough, and "explaining a
      codebase bottom-up for six cents".
- [ ] Outreach checklist (§6) executed.
- **DoD:** each explanation page links to the tutorial or how-to that
  applies it, and back; the posts are the landing page's "Read more".

---

## 6. Launch checklist (from the ten reasons)

| # | Reason | Action | Phase |
|---|---|---|---|
| 1 | No README | done: the README now leads with the promise, quick start, limitations, credits | — |
| 2 | No tests, examples | tests exist (property suite, e2e); add `examples/` pointing at the published gson artifacts with one script per tutorial | W2 |
| 3 | No home page | landing page on Cloudflare Pages | W1 |
| 4 | Needs design help | one accent colour, real renders only, the city's own palette; ask a designer to review the landing page once, not to produce it | W1 |
| 5 | No domain | register `codegraph.dev` (fallback `codegraph.tools`, `getcodegraph.com`) | W0 |
| 6 | No social account | one account on the network the audience uses (Mastodon/Bluesky/X, pick one), used for releases and screenshots | W5 |
| 7 | Unclear license | `LICENSE` file; license badge; a "Using codegraph at work" paragraph in the install guide | W0 |
| 8 | Doesn't reach out | issue templates (bug, extractor gap, corpus report); a contact email on the footer; answer every first issue within a week | W1 |
| 9 | No talks | one submission per quarter: a software-architecture or a legacy-modernization track; the gson replay is the demo | W5 |
| 10 | Not submitted to newsletters | submit at W4 (when install is one command): Changelog News, JavaScript Weekly, Java newsletters, Hacker News "Show HN" | W4 |

---

## 7. Open questions

- **Name and domain.** "codegraph" is a common word in this space; check
  collisions on npm and with existing products before the domain purchase.
  A scoped npm name (`@codegraph/cli`) sidesteps the registry but not the
  search results.
- **Versioned docs.** Not before 1.0; one version of the site, tied to
  `main`, with the changelog carrying the history.
- **Demo size.** gson is small enough to load instantly; a second, larger
  demo (commons-lang) shows scale but costs load time. Ship gson first,
  measure, decide.
- **Where `PLAN.md` goes.** It is the project's engineering journal, not
  user documentation. Keep it in the repository, link it from the
  contributor section, and mine it for explanation pages rather than
  publishing it whole.
