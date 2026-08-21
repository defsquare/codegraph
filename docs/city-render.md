# City renderer — the design (`@codegraph/viz`)

Status: **shipped as the first renderer slice** (`packages/viz`).
Companion doc: [`city-model.md`](city-model.md) describes the city MODEL this
package draws; `CLAUDE.md` holds the visualization rules it must obey.

This doc records the choices. The visual reference is
[`deepencity.png`](deepencity.png) — district plates on dark ground, extruded
buildings, roof-to-roof arcs, a metrics card on hover. The renderer is the END
of the pipeline:

```
model.jsonl  →  codegraph city --layout  →  city.json  →  @codegraph/viz
(interchange,     (city model + placement,    (the ONLY input    (Three.js,
 code details)     no rendering)               viz reads)         browser)
```

---

## CR-1 The artifact is the boundary, and the guard enforces it

The renderer's only input is the serialized city artifact — the JSON that
`codegraph city --layout --out city.json` writes. It never reads a
`model.jsonl`, never imports the analyzer, and its browser bundle contains **no
code from `core`, `analyzer` or `city`**: every import of `@codegraph/city` is
type-only, and the one shared literal (`kind: "codegraph.city/1"`) is restated
in `guard.ts` with a test asserting it equals the package's constant.

That is not an accident of bundling — it is the point. The city model and its
persistence stay separate from the core model with the code details; the
renderer could be handed to someone with no codegraph checkout and a
`city.json`, and it would work.

`parseCityLayout` refuses, with the command that produces the right file:

- non-JSON (a `model.jsonl` is line-based, so it fails here first);
- JSON whose `kind` is not `codegraph.city/1`;
- a city built without `--layout` — positions are the layout pass's job, and
  inventing them in the renderer would be a second, undeclared packer;
- an artifact declaring `conventions` this renderer does not implement
  (it draws y-up over an xz ground plane, arrows attached at roofs) — refusing
  beats silently misdrawing.

## CR-2 A pure scene model under the Three.js adapter

`src/scene/` turns the artifact into plain world-space data — no `three`, no
DOM, unit-tested in Node:

| Function | Produces |
|---|---|
| `buildingBoxes` | center + size per building, standing on its district plate |
| `districtPlates`, `groundPlate` | slabs from district bounds / city bounds |
| `arrowArcs` | sampled quadratic Bezier per arrow, roof to roof, plus weight |
| `legendModel` | the on-screen legend, derived from `bindings` |

`src/three/` is the only place `three` appears (the workspace ESLint rule
forbids it everywhere else): `createCityScene` uploads the scene model once,
`BuildingPicker` raycasts on pointer events. `main.ts` is the shell — loading,
camera, tooltip, legend DOM.

The split mirrors CM-1 one level down: "how tall, where, which color" are
numbers a test asserts on; a screenshot is only needed for "did the GPU draw
what the numbers say".

## CR-3 Meaning controls appearance

Every visual channel maps to a declared source; the renderer adds no mapping of
its own:

| Channel | Source | Where declared |
|---|---|---|
| height, footprint | the artifact's `bindings` (metric, scale, range) | legend, from `bindings` |
| building color | corpus-declared type vs `isStub` | `theme.ts`, legend |
| type-arrow color | `inferred` flag — green declared fact, red inference | `theme.ts`, legend |
| arrow opacity | aggregated edge `count`, log-scaled (`log1p`) to [0, 1] | `theme.ts` |
| plate elevation + tint | district nesting depth (`District.parent` chain) — a child plate stacks one thickness higher and reads slightly lighter | `theme.ts` |
| district-arrow hue | direction relative to the SELECTED district — amber fan-in (who depends on it), blue fan-out (what it depends on) | `theme.ts`, legend |
| district-arrow saturation | provenance: an inferred module arrow desaturates toward gray but keeps its direction hue | `theme.ts`, legend |

Honesty rules inherited and kept mechanical:

- `inferred` and `crossDistrict` are **copied from the artifact, never
  recomputed** — the model precomputed them so a renderer cannot get the rule
  wrong, and a test pins that the flag is used verbatim.
- An arrow whose endpoint is not a building of this city is skipped, never
  drawn from nowhere (the model already counted legitimate drops in
  `diagnostics.droppedArrows`).
- The tooltip shows the RAW `metrics` next to the building — `null` renders as
  "unmeasured", in words, because "shortest" and "unknown" must not read the
  same (CM-6).
- The legend is generated from the artifact (`legendModel`), so it cannot
  claim a binding the city was not built with.

## CR-4 Per-frame paths allocate nothing

Draw calls are constant in city size: one `InstancedMesh` for all buildings
(per-instance color for stubs), one for all district plates, one ground mesh,
and one `LineSegments` for all arrows. Everything is built once in
`createCityScene`; the render loop is `controls.update()` + `render()`.

Arrow focus (hover/click a building: its arrows brighten, the rest fade) is an
in-place rewrite of the alpha channel of one shared RGBA vertex-color buffer —
`needsUpdate = true`, no allocation, still one draw call. Picking runs on
pointer events, not per frame, with a reused `Raycaster`.

The arc itself: a quadratic Bezier whose apex clears the taller roof by
`max(2, 0.3 × roof distance)` — short hops stay low, long dependencies fly
over the skyline. The control height is solved from the apex
(`apex = (p0 + 2c + p2) / 4`), so the guarantee holds between unequal roofs.

## CR-4b The landscape, and what a click means

The same page is both the city and the module LANDSCAPE — the `buildings` and
`type dependencies` toggles strip the view down to nested district plates, and
`?landscape=1` starts there. Nested modules are real geometry: a child
district's plate stands ON its parent's (the layout packed it inside), so the
module tree reads in outline and in elevation.

Selection is one thing at a time, on purpose:

- **Hover a building** → its raw metrics, and its type arrows brighten while
  the rest fade (click locks it).
- **Click a district plate** → the plate brightens, a card shows its buildings,
  nested districts and fan-in/fan-out totals, and its module-level arcs draw
  from the artifact's `districtArrows` — amber into it, blue out of it, each
  direction toggleable. Clicking the same plate (or empty ground) clears it.
- district arcs attach at plate-top centers and are lifted over the skyline
  (tallest building + headroom), so a module dependency never slices through
  the towers standing between two plates.
- An orbit drag that happens to end on a plate is NOT a click — selection only
  changes when the pointer pressed and released in place (≤ 5 px).

Fan-in/fan-out counts in the card are sums over `districtArrows` — city data,
not re-derived graph facts.

## CR-5 Loading, in order of ceremony

1. `?src=URL` — explicit, loud on failure;
2. `/city.json` — the dev-server convenience: `CITY_JSON=path pnpm dev` serves
   the file (a tiny Vite middleware), quiet when absent;
3. drag & drop / file picker — always available, works on a static build.

A refused file shows the guard's message, which names the command that
produces a valid one.

## CR-6 Deliberately absent

- **A `codegraph viz` CLI command.** The CLI must stay free of `three` and the
  DOM; the handoff is the artifact file, and the viewer is `pnpm --filter
  @codegraph/viz dev` (or a static `vite build` output with a `city.json`
  dropped next to it).
- **Labels, minimaps, district captions.** Text in WebGL is a rabbit hole;
  the tooltip covers identification for now. Candidate for a later slice.
- **Color as a metric channel.** The city model reserves color for a future
  binding (CM-10.2); until it declares one, the renderer only uses the two
  fixed semantic colorings above.
- **Level of detail / instanced label culling.** 3.5k buildings and 6k arrows
  (fineract) fit comfortably in the constant-draw-call budget; revisit at 10×.

## CR-7 Entry points

```bash
# produce the input
./bin/codegraph city model.jsonl --layout --out city.json

# develop / view
CITY_JSON=$PWD/city.json pnpm --filter @codegraph/viz dev

# tests (pure scene model, runs in Node) and typecheck
pnpm --filter @codegraph/viz test
pnpm --filter @codegraph/viz typecheck

# static build: dist/ + a city.json beside index.html
pnpm --filter @codegraph/viz build
```
