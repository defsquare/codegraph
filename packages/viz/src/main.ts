import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CityLayout, ReplayCityLayout } from "@codegraph/city";
import { CityLoadError, parseCityLayout } from "./guard.js";
import { progressFraction, progressLabel } from "./progress.js";
import { timelineModel, type TimelineModel } from "./scene/timeline.js";
import {
  buildingDetails,
  districtDetails,
  operationList,
  type BuildingDetails,
  type DetailRow,
} from "./scene/details.js";
import type { ArrowToggles } from "./scene/focus.js";
import { HELP_SEEN_KEY, helpModel } from "./scene/help.js";
import { buildingLabel, districtLabel } from "./scene/labels.js";
import {
  DEFAULT_PALETTE,
  PALETTE_KEY,
  cssToHex,
  hexToCss,
  parsePalette,
  serializePalette,
  type CityPalette,
} from "./scene/palette.js";
import { createCityScene, type CityScene } from "./three/cityScene.js";
import { BuildingPicker } from "./three/picking.js";
import { COLORS } from "./theme.js";

/**
 * The viewer shell: load a city artifact (dev-server `/city.json`, `?src=URL`,
 * drag & drop, or file picker), upload it once via `createCityScene`, then
 * orbit it (rotate / zoom / pan are all live). Interaction is honest and
 * minimal: HOVER names an element (one line, identity components from the
 * artifact); CLICK selects it — a right-side panel shows its details and
 * exactly its fan-in/fan-out arcs appear, per the header toggles. Dependency
 * arrows rest hidden ("Show all dependencies" restores the overview). The
 * header carries the corpus name and a Help dialog (auto-shown once, the
 * legend inside). `?landscape=1` starts with buildings hidden.
 */

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`index.html is missing ${selector}`);
  return element;
}
const canvas = must<HTMLCanvasElement>("#city");
const tooltip = must<HTMLElement>("#tooltip");
const loader = must<HTMLElement>("#loader");
const loaderMessage = must<HTMLElement>("#loader-message");
const loaderFile = must<HTMLInputElement>("#loader-file");
const loaderProgress = must<HTMLElement>("#loader-progress");
const loaderProgressTrack = must<HTMLElement>("#loader-progress-track");
const loaderProgressFill = must<HTMLElement>("#loader-progress-fill");
const loaderProgressText = must<HTMLElement>("#loader-progress-text");
const header = must<HTMLElement>("#app-header");
const corpusName = must<HTMLElement>("#corpus-name");
const helpDialog = must<HTMLDialogElement>("#help");
const helpBody = must<HTMLElement>("#help-body");
const helpLink = must<HTMLButtonElement>("#help-link");
const detailsPanel = must<HTMLElement>("#details");
const detailsBody = must<HTMLElement>("#details-body");
const detailsClose = must<HTMLButtonElement>("#details-close");
const toggleBuildings = must<HTMLInputElement>("#toggle-buildings");
const toggleFanIn = must<HTMLInputElement>("#toggle-fan-in");
const toggleFanOut = must<HTMLInputElement>("#toggle-fan-out");
const toggleExternals = must<HTMLInputElement>("#toggle-externals");
const resetView = must<HTMLButtonElement>("#reset-view");
const colorsMenu = must<HTMLDetailsElement>("#colors-menu");
const colorBuilding = must<HTMLInputElement>("#color-building");
const colorStub = must<HTMLInputElement>("#color-stub");
const colorDistrict = must<HTMLInputElement>("#color-district");
const colorFanIn = must<HTMLInputElement>("#color-fan-in");
const colorFanOut = must<HTMLInputElement>("#color-fan-out");
const resetColors = must<HTMLButtonElement>("#reset-colors");
const timelineBar = must<HTMLElement>("#timeline");
const timelinePlay = must<HTMLButtonElement>("#timeline-play");
const timelineScrub = must<HTMLInputElement>("#timeline-scrub");
const timelineLabel = must<HTMLElement>("#timeline-label");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.background);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const controls = new OrbitControls(camera, canvas);
// No easing: orbit, pan and zoom stop exactly where the hand stops.
controls.enableDamping = false;
controls.maxPolarAngle = Math.PI / 2 - 0.02; // never dive below the ground
// Pan slides along the GROUND, not the screen plane, so the target — the
// orbit pivot — can never be lifted into mid-air by a vertical pan.
controls.screenSpacePanning = false;
// Zoom dollies toward the point under the CURSOR, not the orbit pivot. With
// screenSpacePanning off, OrbitControls re-plants the target on the ground
// plane after each cursor zoom, so the pivot never leaves the ground.
controls.zoomToCursor = true;

// THE ORBIT CENTER IS THE CENTER OF THE SCREEN. Before every interaction the
// pivot snaps to the ground point under the viewport center: rotation spins
// the city about what the user is looking at, never about a point an earlier
// pan or zoom left elsewhere. The point lies on the view axis, so re-anchoring
// never visibly jumps the camera. (Reused objects — no per-gesture allocation.)
// Zoom is the exception by design: zoomToCursor dollies toward the pointer and
// then moves the pivot itself, and the next gesture re-snaps it to center.
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const centerRay = new THREE.Raycaster();
const centerNdc = new THREE.Vector2(0, 0);
const centerPoint = new THREE.Vector3();
controls.addEventListener("start", () => {
  centerRay.setFromCamera(centerNdc, camera);
  // Null when the view axis misses the ground (grazing the horizon): the
  // previous pivot simply stays.
  if (centerRay.ray.intersectPlane(groundPlane, centerPoint) !== null) {
    controls.target.copy(centerPoint);
  }
});

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6df, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
scene.add(sun);

let cityScene: CityScene | null = null;
let currentCity: CityLayout | null = null;
const picker = new BuildingPicker();
let hovered: number | null = null;
let locked: number | null = null;
let selectedDistrict: string | null = null;

function resize(): void {
  // updateStyle must stay true: the buffer is dpr times the window, and with
  // no CSS rule sizing #city the canvas would DISPLAY at buffer size — on a
  // dpr-2 screen only its top-left quarter fits the window, parking the city
  // (the buffer's center) at the bottom-right corner.
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  // Fat-line arrow widths are in CSS pixels; the materials need the viewport.
  cityScene?.setResolution(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// --- toggles ----------------------------------------------------------------

if (new URLSearchParams(window.location.search).get("landscape") === "1") {
  toggleBuildings.checked = false;
}

function fanToggles(): ArrowToggles {
  return {
    fanIn: toggleFanIn.checked,
    fanOut: toggleFanOut.checked,
    externals: toggleExternals.checked,
  };
}

function applyToggles(): void {
  if (!cityScene) return;
  const buildings = toggleBuildings.checked;
  // Hiding externals with a stub selected would leave a panel describing an
  // invisible element — drop such a selection first.
  if (!toggleExternals.checked) {
    const box = locked === null ? undefined : cityScene.boxes[locked];
    if (box?.isStub) locked = null;
    const plate = cityScene.plates.find((candidate) => candidate.id === selectedDistrict);
    if (plate?.isStub) selectedDistrict = null;
    renderDetails();
  }
  cityScene.setBuildingsVisible(buildings);
  cityScene.setExternalsVisible(toggleExternals.checked);
  cityScene.setFocus(buildings ? locked : null, fanToggles());
  cityScene.setDistrictFocus(selectedDistrict, fanToggles());
}
for (const toggle of [toggleBuildings, toggleFanIn, toggleFanOut, toggleExternals]) {
  toggle.addEventListener("change", applyToggles);
}

resetView.addEventListener("click", () => {
  if (currentCity) frameCity(currentCity);
});

// --- palette ----------------------------------------------------------------

// The palette survives reloads via localStorage; storage may throw (file://,
// blocked storage) — then the session just runs on what it last set.
let palette: CityPalette = (() => {
  try {
    return parsePalette(localStorage.getItem(PALETTE_KEY));
  } catch {
    return DEFAULT_PALETTE;
  }
})();

const paletteInputs: readonly (readonly [HTMLInputElement, keyof CityPalette])[] = [
  [colorBuilding, "building"],
  [colorStub, "buildingStub"],
  [colorDistrict, "districtPlate"],
  [colorFanIn, "arrowFanIn"],
  [colorFanOut, "arrowFanOut"],
];

/** One sink for every palette change: repaint, legend refresh, persistence. */
function applyPalette(next: CityPalette): void {
  palette = next;
  for (const [input, key] of paletteInputs) input.value = hexToCss(palette[key]);
  cityScene?.setPalette(palette);
  renderHelp(currentCity); // the legend swatches must show the live colors
  try {
    localStorage.setItem(PALETTE_KEY, serializePalette(palette));
  } catch {
    /* storage unavailable */
  }
}

for (const [input, key] of paletteInputs) {
  input.value = hexToCss(palette[key]);
  input.addEventListener("input", () => {
    const hex = cssToHex(input.value);
    if (hex !== null) applyPalette({ ...palette, [key]: hex });
  });
}
resetColors.addEventListener("click", () => applyPalette(DEFAULT_PALETTE));

// The colors menu is a dropdown — a click anywhere else closes it, so it
// never lingers over the city. (Color pickers live inside; their native
// popups are not DOM children, but the wells themselves are.)
document.addEventListener("pointerdown", (event) => {
  if (colorsMenu.open && event.target instanceof Node && !colorsMenu.contains(event.target)) {
    colorsMenu.open = false;
  }
});

function showCity(city: CityLayout): void {
  if (cityScene) {
    scene.remove(cityScene.root);
    cityScene.dispose();
    hovered = locked = null;
    selectedDistrict = null;
    tooltip.hidden = true;
    detailsPanel.hidden = true;
  }
  cityScene = createCityScene(city, palette);
  cityScene.setResolution(window.innerWidth, window.innerHeight);
  currentCity = city;
  scene.add(cityScene.root);
  frameCity(city);
  setupReplay(city);
  // `corpus` arrived with this feature; older artifacts fall back to the view.
  const corpus = (city as { corpus?: { name?: string } }).corpus;
  corpusName.textContent = corpus?.name ?? city.view.name ?? "city.json";
  renderHelp(city);
  applyToggles();
  loader.hidden = true;
  header.hidden = false;
  showHelpOnce();
}

/**
 * Aim the camera like the reference shot: elevated three-quarter view. The
 * scene group puts the landscape's visual center (the built mass's centroid,
 * per landscapeCenter) at the world origin, so the orbit target — and what
 * "Reset view" returns to — is (0, 0, 0).
 */
function frameCity(city: CityLayout): void {
  const span = Math.max(city.bounds.width, city.bounds.depth, 1);
  controls.target.set(0, 0, 0);
  camera.position.set(-span * 0.35, span * 0.65, span * 0.95);
  camera.near = span / 1000;
  camera.far = span * 20;
  camera.updateProjectionMatrix();
  sun.position.set(-span, span * 1.5, span * 0.6);
}

// --- replay timeline --------------------------------------------------------

/**
 * Present only when the artifact carries a `replay` block (`codegraph history
 * --serve`): one tick per commit, buildings rise and sink along their
 * keyframe series. The scrub path is allocation-free — one Float32Array is
 * reused for every tick, and the scene rewrites instance matrices in place.
 */
let timeline: TimelineModel | null = null;
let heightsBuffer: Float32Array | null = null;
let replayTimer: number | null = null;
const PLAY_TICK_MS = 140;

function stopPlayback(): void {
  if (replayTimer !== null) {
    window.clearInterval(replayTimer);
    replayTimer = null;
  }
  timelinePlay.textContent = "▶";
}

function setTick(tick: number): void {
  if (!cityScene || timeline === null || heightsBuffer === null) return;
  cityScene.setHeights(timeline.heightsAt(tick, heightsBuffer));
  timelineLabel.textContent = timeline.label(tick);
  timelineScrub.value = String(tick);
}

function setupReplay(city: CityLayout): void {
  stopPlayback();
  const replay = (city as Partial<ReplayCityLayout>).replay;
  if (!cityScene || replay === undefined || replay.ticks.length === 0) {
    timeline = null;
    heightsBuffer = null;
    timelineBar.hidden = true;
    return;
  }
  timeline = timelineModel(replay, cityScene.boxes.map((box) => box.id));
  heightsBuffer = new Float32Array(cityScene.boxes.length);
  timelineScrub.max = String(timeline.count - 1);
  timelineBar.hidden = false;
  setTick(timeline.count - 1); // start at "now": the full city
}

timelineScrub.addEventListener("input", () => {
  stopPlayback();
  setTick(Number(timelineScrub.value));
});

timelinePlay.addEventListener("click", () => {
  if (timeline === null) return;
  if (replayTimer !== null) {
    stopPlayback();
    return;
  }
  // Playing from the end means replaying from the beginning.
  let tick = Number(timelineScrub.value);
  if (tick >= timeline.count - 1) tick = -1;
  timelinePlay.textContent = "❚❚";
  replayTimer = window.setInterval(() => {
    if (timeline === null) {
      stopPlayback();
      return;
    }
    tick += 1;
    setTick(Math.min(tick, timeline.count - 1));
    if (tick >= timeline.count - 1) stopPlayback();
  }, PLAY_TICK_MS);
});

// --- header, help dialog, tooltip and details panel -------------------------

// Building and stub swatches read the LIVE palette — the legend must show the
// colors the city actually renders with, not the defaults.
function swatchColor(kind: string): number | undefined {
  if (kind === "building") return palette.building;
  if (kind === "stub") return palette.buildingStub;
  if (kind === "fanIn") return palette.arrowFanIn;
  if (kind === "fanOut") return palette.arrowFanOut;
  return undefined;
}

function swatchOf(kind: string): HTMLElement {
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  const color = swatchColor(kind);
  if (color !== undefined) swatch.style.background = hexToCss(color);
  return swatch;
}

function legendLine(entry: {
  swatch: string | null;
  label: string;
  detail: string | undefined;
}): HTMLElement {
  const line = document.createElement("div");
  line.className = "entry";
  if (entry.swatch !== null) line.append(swatchOf(entry.swatch));
  const text = document.createElement("span");
  const label = document.createElement("strong");
  label.textContent = entry.label;
  text.append(label);
  if (entry.detail !== undefined) {
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = ` — ${entry.detail}`;
    text.append(detail);
  }
  line.append(text);
  return line;
}

/** The dialog renders `helpModel` verbatim — concept text AND the legend are
 * the unit-tested model; nothing here is free-hand prose. */
function renderHelp(city: CityLayout | null): void {
  const model = helpModel(city);
  const nodes: HTMLElement[] = [];
  const title = document.createElement("h2");
  title.textContent = "codegraph — code city";
  nodes.push(title);
  for (const section of model.sections) {
    const heading = document.createElement("h3");
    heading.textContent = section.heading;
    nodes.push(heading);
    for (const paragraph of section.paragraphs) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      nodes.push(p);
    }
  }
  if (model.legend.length > 0) {
    const heading = document.createElement("h3");
    heading.textContent = "Legend";
    nodes.push(heading);
    nodes.push(...model.legend.map(legendLine));
  }
  helpBody.replaceChildren(...nodes);
}

/** Auto-open once per browser; the Help button always reopens. localStorage
 * may throw (file://, blocked storage) — then never auto-open, only on ask. */
function showHelpOnce(): void {
  let seen = true;
  try {
    seen = localStorage.getItem(HELP_SEEN_KEY) !== null;
  } catch {
    /* storage unavailable: treat as seen */
  }
  if (seen || helpDialog.open) return;
  helpDialog.showModal();
  try {
    localStorage.setItem(HELP_SEEN_KEY, "1");
  } catch {
    /* storage unavailable */
  }
}
helpLink.addEventListener("click", () => {
  if (!helpDialog.open) helpDialog.showModal();
});

function placeTooltip(clientX: number, clientY: number): void {
  tooltip.hidden = false;
  const pad = 14;
  tooltip.style.left = `${Math.min(clientX + pad, window.innerWidth - tooltip.offsetWidth - pad)}px`;
  tooltip.style.top = `${Math.min(clientY + pad, window.innerHeight - tooltip.offsetHeight - pad)}px`;
}

/** Hover shows ONE line — the element's identity; details live in the panel. */
function renderTooltip(label: string, clientX: number, clientY: number): void {
  tooltip.textContent = label;
  placeTooltip(clientX, clientY);
}

function rowsTable(rows: readonly DetailRow[]): HTMLTableElement {
  const table = document.createElement("table");
  for (const { label, value, className } of rows) {
    const row = table.insertRow();
    row.insertCell().textContent = label;
    const cell = row.insertCell();
    cell.textContent = value;
    if (className !== undefined) cell.className = className;
  }
  return table;
}

function memberList(
  summaryText: string,
  items: readonly { lead?: string; text: string; type?: string }[],
  open: boolean,
): HTMLDetailsElement {
  const fold = document.createElement("details");
  fold.open = open;
  const summary = document.createElement("summary");
  summary.textContent = `${summaryText} (${items.length})`;
  fold.append(summary);
  const list = document.createElement("ul");
  for (const item of items) {
    const line = document.createElement("li");
    if (item.lead !== undefined) {
      const lead = document.createElement("strong");
      lead.textContent = item.lead;
      line.append(lead);
    }
    line.append(item.text);
    if (item.type !== undefined) {
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = `: ${item.type}`;
      line.append(type);
    }
    list.append(line);
  }
  fold.append(list);
  return fold;
}

function detailsHeader(title: string, meta: string): readonly HTMLElement[] {
  const heading = document.createElement("h2");
  heading.textContent = title;
  const metaLine = document.createElement("div");
  metaLine.className = "meta";
  metaLine.textContent = meta;
  return [heading, metaLine];
}

function renderBuildingPanel(details: BuildingDetails): void {
  const operations = operationList(details.operations);
  const operationsFold = memberList(
    "Operations",
    operations.items.map((operation) => ({ lead: operation.name, text: operation.params })),
    false,
  );
  if (operations.anonymous > 0) {
    const note = document.createElement("div");
    note.className = "footnote";
    note.textContent = `+ ${operations.anonymous} anonymous (lambdas), not listed`;
    operationsFold.append(note);
  }
  detailsBody.replaceChildren(
    ...detailsHeader(details.title, details.meta),
    rowsTable(details.rows),
    memberList(
      "Attributes",
      details.attributes.map((attribute) => ({
        text: attribute.name,
        ...(attribute.type === undefined ? {} : { type: attribute.type }),
      })),
      true,
    ),
    operationsFold,
  );
  detailsPanel.hidden = false;
}

/** The right-side panel mirrors the selection; deselecting closes it. */
function renderDetails(): void {
  if (!cityScene) return;
  const box = locked === null ? undefined : cityScene.boxes[locked];
  if (box !== undefined) {
    renderBuildingPanel(buildingDetails(box));
    return;
  }
  const plate =
    selectedDistrict === null
      ? undefined
      : cityScene.plates.find((candidate) => candidate.id === selectedDistrict);
  if (plate !== undefined) {
    const details = districtDetails(
      cityScene.plates,
      cityScene.boxes,
      cityScene.districtArcs,
      plate,
    );
    detailsBody.replaceChildren(
      ...detailsHeader(details.title, details.meta),
      rowsTable(details.rows),
    );
    detailsPanel.hidden = false;
    return;
  }
  detailsPanel.hidden = true;
}

detailsClose.addEventListener("click", () => {
  locked = null;
  selectedDistrict = null;
  applyToggles();
  renderDetails();
});

// --- picking ----------------------------------------------------------------

/** Buildings win when visible; otherwise (or on a miss) plates are the target. */
function pickPlate(event: { clientX: number; clientY: number }): number | null {
  if (!cityScene) return null;
  return picker.pick(event, canvas, camera, cityScene.platesMesh);
}

// Hover only NAMES things; it never changes what arrows show — selection does.
canvas.addEventListener("pointermove", (event) => {
  if (!cityScene) return;
  hovered = toggleBuildings.checked
    ? picker.pick(event, canvas, camera, cityScene.buildingsMesh)
    : null;
  const box = hovered === null ? undefined : cityScene.boxes[hovered];
  if (box !== undefined) {
    renderTooltip(buildingLabel(box), event.clientX, event.clientY);
    return;
  }
  const plateIndex = pickPlate(event);
  const plate = plateIndex === null ? undefined : cityScene.plates[plateIndex];
  if (plate !== undefined) {
    renderTooltip(districtLabel(plate), event.clientX, event.clientY);
  } else {
    tooltip.hidden = true;
  }
});

// An orbit drag ends in a click too; only a stationary press may select.
let pressedAt: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (event) => {
  pressedAt = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener("click", (event) => {
  if (!cityScene) return;
  const moved =
    pressedAt !== null &&
    Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 5;
  if (moved) return;
  const buildingHit = toggleBuildings.checked
    ? picker.pick(event, canvas, camera, cityScene.buildingsMesh)
    : null;
  if (buildingHit !== null) {
    // A building click selects/deselects it, and clears any district
    // selection — one selection at a time keeps the picture readable.
    locked = buildingHit === locked ? null : buildingHit;
    selectedDistrict = null;
    applyToggles();
    renderDetails();
    return;
  }
  const plateIndex = pickPlate(event);
  const plate = plateIndex === null ? undefined : cityScene.plates[plateIndex];
  selectedDistrict = plate === undefined || plate.id === selectedDistrict ? null : plate.id;
  locked = null;
  applyToggles();
  renderDetails();
});

// --- artifact loading -------------------------------------------------------

function fail(error: unknown): void {
  loader.hidden = false;
  loader.classList.add("error");
  loaderMessage.textContent =
    error instanceof CityLoadError ? error.message : `Could not load the city: ${String(error)}`;
}

function loadText(text: string): void {
  try {
    loader.classList.remove("error");
    showCity(parseCityLayout(text));
  } catch (error) {
    fail(error);
  }
}

/** The download bar, over the welcome page: fraction when the server stated a
 * total, received count alone when it did not. The picker stays usable. */
function showProgress(received: number, total: number | null): void {
  loaderProgress.hidden = false;
  const fraction = progressFraction(received, total);
  loaderProgressTrack.hidden = fraction === null;
  if (fraction !== null) loaderProgressFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  loaderProgressText.textContent = progressLabel(received, total);
}

/** Read the body streaming, reporting progress chunk by chunk. */
async function readBody(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return response.text();
  const header = response.headers.get("content-length");
  const total = header === null ? null : Number(header) || null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    showProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function loadUrl(url: string, quietWhenAbsent: boolean): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (!quietWhenAbsent) fail(new Error(`${url}: HTTP ${response.status}`));
      return;
    }
    loadText(await readBody(response));
  } catch (error) {
    if (!quietWhenAbsent) fail(error);
  } finally {
    loaderProgress.hidden = true;
  }
}

loaderFile.addEventListener("change", () => {
  const file = loaderFile.files?.[0];
  if (file) void file.text().then(loadText, fail);
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
window.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const file = event.dataTransfer?.files[0];
  if (file) void file.text().then(loadText, fail);
});

const src = new URLSearchParams(window.location.search).get("src");
// `?src=` is explicit (loud on failure); `/city.json` is the dev-server
// convenience and stays quiet when nothing serves it.
void loadUrl(src ?? "city.json", src === null);
