# Codegraph landing page

A Hugo site with no theme: one page, built from `content/` by the templates in
`layouts/`, on the Defsquare Design System. The documentation site is a
separate Hugo site next door in `../doc`, deployed under `/doc/`.

```bash
hugo server --port 1315    # http://localhost:1315
hugo --minify --gc         # → public/
```

| Path | What lives here |
|---|---|
| `content/_index.md` | the intro: headline, lead, the two calls to action, the city figure and its caption, the corpora strip |
| `content/sections/*.md` | one file per essay row: `title`, `lead`, an optional `cmd`, an optional `more` link, and the row's prose as Markdown. `weight` orders them; they are never published on their own URL |
| `layouts/` | `baseof.html`, `home.html` and four partials. No theme, no JavaScript |
| `assets/css/colors_and_type.css` | the design system's token layer, copied from the Defsquare Design System project |
| `assets/css/landing.css` | layout only — every colour, size and space is a token |
| `static/fonts/` | IBM Plex Sans Condensed, self-hosted. EB Garamond and Fira Code come from Google Fonts, as the design system specifies |
| `static/img/` | the generated city, the Defsquare logo, the favicon |

Hugo concatenates the two stylesheets (tokens first, so the design system's
`@import` rules stay at the top of the sheet), then minifies and fingerprints
them into one request.

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

## Links to the documentation

Every documentation link is built from `params.docsBase` in `hugo.yaml`
(`/doc/` today). Section front matter carries `doc: "tutorials/navigator/"`,
never a full path, so moving the documentation site is a one-line change.
