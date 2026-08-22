import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CityLayout } from "@codegraph/city";
import { CityLoadError, parseCityLayout } from "./guard.js";
import { legendModel } from "./scene/legend.js";
import type { BuildingBox } from "./scene/buildings.js";
import type { Plate } from "./scene/districts.js";
import { createCityScene, type CityScene } from "./three/cityScene.js";
import { BuildingPicker } from "./three/picking.js";
import { COLORS } from "./theme.js";

/**
 * The viewer shell: load a city artifact (dev-server `/city.json`, `?src=URL`,
 * drag & drop, or file picker), upload it once via `createCityScene`, then
 * orbit it (rotate / zoom / pan are all live). Interaction is honest and
 * minimal: hovering a building shows its RAW metrics and focuses its type
 * arrows; CLICKING A DISTRICT shows its module-level fan-in/fan-out arcs, each
 * direction toggleable; the Buildings toggle turns the city into the pure
 * module landscape. `?landscape=1` starts in that state.
 */

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`index.html is missing ${selector}`);
  return element;
}
const canvas = must<HTMLCanvasElement>("#city");
const legendPanel = must<HTMLElement>("#legend");
const tooltip = must<HTMLElement>("#tooltip");
const loader = must<HTMLElement>("#loader");
const loaderMessage = must<HTMLElement>("#loader-message");
const loaderFile = must<HTMLInputElement>("#loader-file");
const controlsPanel = must<HTMLElement>("#controls");
const toggleBuildings = must<HTMLInputElement>("#toggle-buildings");
const toggleTypeArrows = must<HTMLInputElement>("#toggle-type-arrows");
const toggleFanIn = must<HTMLInputElement>("#toggle-fan-in");
const toggleFanOut = must<HTMLInputElement>("#toggle-fan-out");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.background);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02; // never dive below the ground

scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd6df, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
scene.add(sun);

let cityScene: CityScene | null = null;
const picker = new BuildingPicker();
let hovered: number | null = null;
let locked: number | null = null;
let selectedDistrict: string | null = null;

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
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
  toggleTypeArrows.checked = false;
}

function applyToggles(): void {
  if (!cityScene) return;
  cityScene.setBuildingsVisible(toggleBuildings.checked);
  cityScene.setTypeArrowsVisible(toggleTypeArrows.checked && toggleBuildings.checked);
  cityScene.setDistrictFocus(selectedDistrict, {
    fanIn: toggleFanIn.checked,
    fanOut: toggleFanOut.checked,
  });
}
for (const toggle of [toggleBuildings, toggleTypeArrows, toggleFanIn, toggleFanOut]) {
  toggle.addEventListener("change", applyToggles);
}

function showCity(city: CityLayout): void {
  if (cityScene) {
    scene.remove(cityScene.root);
    cityScene.dispose();
    hovered = locked = null;
    selectedDistrict = null;
    tooltip.hidden = true;
  }
  cityScene = createCityScene(city);
  scene.add(cityScene.root);
  frameCity(city);
  renderLegend(city);
  applyToggles();
  loader.hidden = true;
  controlsPanel.hidden = false;
}

/** Aim the camera like the reference shot: elevated three-quarter view. */
function frameCity(city: CityLayout): void {
  const { x, y, width, depth } = city.bounds;
  const span = Math.max(width, depth, 1);
  const cx = x + width / 2;
  const cz = y + depth / 2;
  controls.target.set(cx, 0, cz);
  camera.position.set(cx - span * 0.35, span * 0.65, cz + span * 0.95);
  camera.near = span / 1000;
  camera.far = span * 20;
  camera.updateProjectionMatrix();
  sun.position.set(cx - span, span * 1.5, cz + span * 0.6);
}

// --- legend and tooltips ----------------------------------------------------

const SWATCH_COLORS: Record<string, number> = {
  building: COLORS.building,
  stub: COLORS.buildingStub,
  declared: COLORS.arrowDeclared,
  inferred: COLORS.arrowInferred,
  fanIn: COLORS.arrowFanIn,
  fanOut: COLORS.arrowFanOut,
};

function swatchOf(kind: string): HTMLElement {
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = `#${SWATCH_COLORS[kind]?.toString(16).padStart(6, "0")}`;
  return swatch;
}

function renderLegend(city: CityLayout): void {
  const entries = [
    ...legendModel(city).map((entry) => ({ ...entry, swatch: entry.swatch as string | null })),
    {
      swatch: "fanIn",
      label: "fan-in",
      detail: "modules that depend on the selected district",
    },
    {
      swatch: "fanOut",
      label: "fan-out",
      detail: "modules the selected district depends on (inferred = desaturated)",
    },
  ];
  legendPanel.replaceChildren(
    ...entries.map((entry) => {
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
    }),
  );
  legendPanel.hidden = false;
}

function placeTooltip(clientX: number, clientY: number): void {
  tooltip.hidden = false;
  const pad = 14;
  tooltip.style.left = `${Math.min(clientX + pad, window.innerWidth - tooltip.offsetWidth - pad)}px`;
  tooltip.style.top = `${Math.min(clientY + pad, window.innerHeight - tooltip.offsetHeight - pad)}px`;
}

function metricsTable(rows: readonly (readonly [string, string, string?])[]): HTMLTableElement {
  const table = document.createElement("table");
  for (const [label, value, className] of rows) {
    const row = table.insertRow();
    row.insertCell().textContent = label;
    const cell = row.insertCell();
    cell.textContent = value;
    if (className !== undefined) cell.className = className;
  }
  return table;
}

function renderBuildingTooltip(box: BuildingBox, clientX: number, clientY: number): void {
  tooltip.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = box.name ?? box.id;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${box.kind}${box.isStub ? " (stub)" : ""} — ${box.district}`;
  tooltip.append(
    title,
    meta,
    metricsTable(
      Object.entries(box.metrics).map(([metric, value]) =>
        value === null ? [metric, "unmeasured", "unmeasured"] : [metric, String(value)],
      ),
    ),
  );
  placeTooltip(clientX, clientY);
}

function renderDistrictTooltip(plate: Plate, clientX: number, clientY: number): void {
  if (!cityScene) return;
  const city = cityScene;
  const buildings = city.boxes.filter((box) => box.district === plate.id).length;
  const nested = city.plates.filter((p) => p.parent === plate.id).length;
  const fanIn = city.districtArcs.filter((arc) => arc.to === plate.id);
  const fanOut = city.districtArcs.filter((arc) => arc.from === plate.id);
  const sum = (arcs: readonly { count: number }[]) =>
    arcs.reduce((total, arc) => total + arc.count, 0);

  tooltip.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = plate.name ?? plate.id;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `module${plate.isStub ? " (stub)" : ""}${
    plate.parent === undefined ? "" : ` — in ${plate.parent}`
  }`;
  tooltip.append(
    title,
    meta,
    metricsTable([
      ["buildings", String(buildings)],
      ["nested districts", String(nested)],
      ["fan-in", `${fanIn.length} modules / ${sum(fanIn)} deps`],
      ["fan-out", `${fanOut.length} modules / ${sum(fanOut)} deps`],
    ]),
  );
  placeTooltip(clientX, clientY);
}

// --- picking ----------------------------------------------------------------

/** Buildings win when visible; otherwise (or on a miss) plates are the target. */
function pickPlate(event: { clientX: number; clientY: number }): number | null {
  if (!cityScene) return null;
  return picker.pick(event, canvas, camera, cityScene.platesMesh);
}

canvas.addEventListener("pointermove", (event) => {
  if (!cityScene) return;
  const hit = toggleBuildings.checked
    ? picker.pick(event, canvas, camera, cityScene.buildingsMesh)
    : null;
  if (hit !== hovered) {
    hovered = hit;
    if (locked === null) cityScene.setFocus(hovered);
  }
  const shownBuilding = locked ?? hovered;
  const box = shownBuilding === null ? undefined : cityScene.boxes[shownBuilding];
  if (box !== undefined) {
    renderBuildingTooltip(box, event.clientX, event.clientY);
    return;
  }
  const plateIndex = pickPlate(event);
  const plate = plateIndex === null ? undefined : cityScene.plates[plateIndex];
  if (plate !== undefined) {
    renderDistrictTooltip(plate, event.clientX, event.clientY);
  } else if (selectedDistrict === null) {
    tooltip.hidden = true;
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
    // A building click locks/unlocks type-arrow focus, and clears any
    // district selection — one selection at a time keeps the picture readable.
    locked = buildingHit === locked ? null : buildingHit;
    cityScene.setFocus(locked ?? hovered);
    selectedDistrict = null;
    applyToggles();
    return;
  }
  const plateIndex = pickPlate(event);
  const plate = plateIndex === null ? undefined : cityScene.plates[plateIndex];
  selectedDistrict = plate === undefined || plate.id === selectedDistrict ? null : plate.id;
  locked = null;
  cityScene.setFocus(hovered);
  applyToggles();
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

async function loadUrl(url: string, quietWhenAbsent: boolean): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      if (!quietWhenAbsent) fail(new Error(`${url}: HTTP ${response.status}`));
      return;
    }
    loadText(await response.text());
  } catch (error) {
    if (!quietWhenAbsent) fail(error);
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
