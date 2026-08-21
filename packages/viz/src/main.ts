import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CityLayout } from "@codegraph/city";
import { CityLoadError, parseCityLayout } from "./guard.js";
import { legendModel } from "./scene/legend.js";
import type { BuildingBox } from "./scene/buildings.js";
import { createCityScene, type CityScene } from "./three/cityScene.js";
import { BuildingPicker } from "./three/picking.js";
import { COLORS } from "./theme.js";

/**
 * The viewer shell: load a city artifact (dev-server `/city.json`, `?src=URL`,
 * drag & drop, or file picker), upload it once via `createCityScene`, then
 * orbit it. Interaction is honest and minimal: hovering a building shows its
 * RAW metrics (the numbers the dimensions came from) and focuses its arrows;
 * clicking locks that focus.
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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.background);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02; // never dive below the ground

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x14161c, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);

let cityScene: CityScene | null = null;
const picker = new BuildingPicker();
let hovered: number | null = null;
let locked: number | null = null;

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

function showCity(city: CityLayout): void {
  if (cityScene) {
    scene.remove(cityScene.root);
    cityScene.dispose();
    hovered = locked = null;
    tooltip.hidden = true;
  }
  cityScene = createCityScene(city);
  scene.add(cityScene.root);
  frameCity(city);
  renderLegend(city);
  loader.hidden = true;
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

function renderLegend(city: CityLayout): void {
  const swatchColor: Record<string, number> = {
    building: COLORS.building,
    stub: COLORS.buildingStub,
    declared: COLORS.arrowDeclared,
    inferred: COLORS.arrowInferred,
  };
  legendPanel.replaceChildren(
    ...legendModel(city).map((entry) => {
      const line = document.createElement("div");
      line.className = "entry";
      if (entry.swatch !== null) {
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = `#${swatchColor[entry.swatch]?.toString(16).padStart(6, "0")}`;
        line.append(swatch);
      }
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

function renderTooltip(box: BuildingBox, clientX: number, clientY: number): void {
  tooltip.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = box.name ?? box.id;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${box.kind}${box.isStub ? " (stub)" : ""} — ${box.district}`;
  const table = document.createElement("table");
  for (const [metric, value] of Object.entries(box.metrics)) {
    const row = table.insertRow();
    row.insertCell().textContent = metric;
    const cell = row.insertCell();
    if (value === null) {
      cell.textContent = "unmeasured";
      cell.className = "unmeasured";
    } else {
      cell.textContent = String(value);
    }
  }
  tooltip.append(title, meta, table);
  tooltip.hidden = false;
  const pad = 14;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.min(clientX + pad, window.innerWidth - width - pad)}px`;
  tooltip.style.top = `${Math.min(clientY + pad, window.innerHeight - height - pad)}px`;
}

canvas.addEventListener("pointermove", (event) => {
  if (!cityScene) return;
  const hit = picker.pick(event, canvas, camera, cityScene.buildingsMesh);
  if (hit !== hovered) {
    hovered = hit;
    if (locked === null) cityScene.setFocus(hovered);
  }
  const shown = locked ?? hovered;
  const box = shown === null ? undefined : cityScene.boxes[shown];
  if (box === undefined) {
    tooltip.hidden = true;
  } else {
    renderTooltip(box, event.clientX, event.clientY);
  }
});

canvas.addEventListener("click", (event) => {
  if (!cityScene) return;
  const hit = picker.pick(event, canvas, camera, cityScene.buildingsMesh);
  locked = hit === locked ? null : hit;
  cityScene.setFocus(locked ?? hovered);
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
