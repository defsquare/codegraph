# Codegraph website

**One Hugo site, one build, one server** — the landing page at `/` and the
documentation at `/docs/`.

```bash
hugo server -D --port 1314   # http://localhost:1314/  and  /docs/
hugo --minify --gc           # → public/
```

The two halves look nothing alike and that is deliberate: the landing page is
themeless and runs on the Defsquare Design System, the documentation runs on
[Hextra](https://github.com/imfing/hextra) (vendored at `themes/hextra` as a
git submodule). They share one config, one content tree and one output
directory, so a CLI change and its documentation ship in one merge request and
one deployment.

| Path | What lives here |
|---|---|
| `content/_index.md` | the landing intro: headline, lead, the two calls to action, the city figure and its caption, the corpora strip. `type: landing` is what selects the themeless shell |
| `content/sections/*.md` | one file per landing essay row: `title`, `lead`, an optional `cmd`, an optional `more` link, and the row's prose as Markdown. `weight` orders them; they are never published on their own URL |
| `content/docs/` | the documentation, in the four Diátaxis quadrants: `tutorials/`, `how-to/`, `reference/`, `explanation/` |
| `layouts/landing/` | the landing shell — `baseof.html`, `home.html`, and `_markup/` render hooks. No theme, no JavaScript |
| `layouts/_partials/landing/` | the landing's four partials, namespaced |
| `assets/css/colors_and_type.css` | the design system's token layer, copied from the Defsquare Design System project |
| `assets/css/landing.css` | layout only — every colour, size and space is a token |
| `static/fonts/` | IBM Plex Sans Condensed, self-hosted. EB Garamond and Fira Code come from Google Fonts, as the design system specifies |
| `static/img/` | the codegraph logo (four variants), the generated city, the Defsquare logo, the favicon |
| `themes/hextra/` | the documentation theme, a git submodule |

## How two shells share one site

Hugo resolves templates by lookup order, and a project template always beats a
theme's. A landing `layouts/baseof.html` would therefore silently wrap every
documentation page as well. Three rules keep them apart:

1. **The landing shell is scoped by type.** `content/_index.md` declares
   `type: landing`, so `layouts/landing/baseof.html` and
   `layouts/landing/home.html` are found for it and for nothing else. Every
   documentation page falls through to Hextra's.
2. **The landing partials are namespaced.** `layouts/_partials/landing/*.html`
   — `footer.html` in particular would otherwise shadow Hextra's.
3. **The landing has its own Markdown render hooks**, in
   `layouts/landing/_markup/`. Hextra's emit Tailwind `hx:` utility classes,
   a code-block copy button and heading permalink anchors, all styled by a
   stylesheet the landing shell does not load; scoped hooks emit plain
   `<h2>`, `<pre><code>` and `<a>` instead. `content/sections/` inherits
   `type: landing` through its cascade so the rows get these hooks too.

Syntax highlighting follows the same principle rather than a global switch:
`markup.highlight.noClasses: false` makes colour a stylesheet concern, the
documentation loads Hextra's Chroma sheet and gets colour, and the landing —
which does not load it — gets code in one colour, as the design system asks.

Hugo concatenates the two landing stylesheets (tokens first, so the design
system's `@import` rules stay at the top of the sheet), then minifies and
fingerprints them into one request.

## The logo, and why it carries its own metrics

Both shells use `codegraph-logo-long-dark-blue-text-red-brackets.svg` as their
wordmark — the landing nav via `_partials/landing/nav.html`, the documentation
via `params.navbar.logo`. Hextra emits a light and a dark `<img>` and swaps
them by theme, so the documentation also names
`codegraph-logo-long-white-text-red-brackets.svg`: the dark-blue wordmark
would be invisible on the dark ground.

The logos draw their wordmark as SVG `<text>`, not as outlines. Loaded through
an `<img>`, an SVG cannot reach the page's webfonts and resolves `font-family`
against **system** fonts only — so a machine that does not map Helvetica used
to render the wordmark at the wrong width and run it into the right bracket
(there are 2.6px of clearance). Two attributes remove that failure:

- a metric-compatible fallback stack — Helvetica, Arial, Liberation Sans and
  Nimbus Sans share one set of metrics, covering macOS, Windows and Linux;
- `textLength="204.484" lengthAdjust="spacingAndGlyphs"` on the tspan —
  204.484 is the wordmark's own advance width at Helvetica-Bold 40px, so this
  is a no-op wherever the intended metrics exist and fits the glyphs to the
  same width wherever they do not.

All four variants carry both, so the set cannot drift. Replacing a logo with
one whose wordmark is outlined would make both unnecessary.

## Two deviations from the design system's own CSS

`colors_and_type.css` is otherwise verbatim:

1. **Five font faces, not nine.** The page uses regular, italic, medium,
   semibold and bold; the thin, extra-light and light cuts are not loaded.
2. **Absolute font URLs** (`/fonts/…` rather than `fonts/…`), because Hugo
   publishes the stylesheet under `/css/` and the faces under `/fonts/`.

## The hero image is generated, not drawn

`static/img/gson-city.svg` is the city codegraph extracted from google/gson at
release 2.14.0, drawn from the laid-out artifact by `scripts/city-svg.mjs`:
every plate is a district, every block a building at its own position,
footprint and height, every red line an arrow the artifact marks as part of the
minimum feedback set. To regenerate it against another corpus or tag:

```bash
codegraph city gson.jsonl --layout --out city.json
node scripts/city-svg.mjs city.json > static/img/gson-city.svg   # counts on stderr
```

Then update the caption and the `alt` text in `content/_index.md` with the
counts the script prints.

## Links between the two halves

Landing → documentation goes through `params.docsBase` in `hugo.yaml`
(`/docs/` today): section front matter carries `doc: "tutorials/navigator/"`,
never a full path, so moving the documentation is a one-line change.

Documentation → documentation links are written site-absolute and in full
(`/docs/reference/cli/`). They used to be written `/reference/cli/` and bent
into place by `canonifyURLs` against a `/doc/` baseURL; with one site rooted at
`/` that trick no longer applies, and the links now say what they mean.
