#!/usr/bin/env node
/**
 * Draw a laid-out city.json (from `codegraph city --layout`) as one static
 * SVG for the landing page. Nothing is illustrated: every plate is a
 * district, every block a building at the artifact's own position, footprint
 * and height, and every red line is an arrow the artifact marks `feedback`
 * (the minimum feedback set of its cycle). Stubs and their arrows are
 * dropped: the picture is the internal view, and the caption says so.
 *
 *   node city-svg.mjs city.json > gson-city.svg
 *
 * The counts the caption needs are printed on stderr as JSON.
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: city-svg.mjs <city.json>");
  process.exit(2);
}
const city = JSON.parse(readFileSync(path, "utf8"));
if (!city.layout) {
  console.error("the city is not laid out — run `codegraph city --layout`");
  process.exit(2);
}

// Defsquare palette (colors_and_type.css). SVG cannot read CSS variables from
// an <img>, so the hex values are restated here on purpose.
const PLATE = ["#f0f5fc", "#d9e3f1", "#c3d2ea", "#adc1e2"]; // by nesting depth
const PLATE_EDGE = "#9BB2D9";
const FACE_TOP = "#2a5a98";
const FACE_LEFT = "#1e416e";
const FACE_RIGHT = "#122843";
const FEEDBACK = "#f65e5e";

const districts = city.districts.filter((d) => !d.isStub && d.bounds);
const districtIds = new Set(districts.map((d) => d.id));
const buildings = city.buildings.filter((b) => !b.isStub && b.position && districtIds.has(b.district));
const buildingIds = new Set(buildings.map((b) => b.id));
const feedback = city.arrows.filter((a) => a.feedback && buildingIds.has(a.from) && buildingIds.has(a.to));

// Isometric projection: ground plane (x, z) at 30°, height straight up.
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const HEIGHT_SCALE = 1.25;
const project = (x, z, h = 0) => [(x - z) * COS, (x + z) * SIN - h * HEIGHT_SCALE];
const fmt = (n) => (Math.round(n * 100) / 100).toString();
const poly = (points, fill, stroke) =>
  `<polygon points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="0.4" stroke-linejoin="round"` : ""}/>`;

const depthOf = (d) => {
  let n = 0;
  for (let p = d.parent; p; n++) p = districts.find((x) => x.id === p)?.parent;
  return n;
};

const parts = [];
// Plates, parents first so children paint on top; a child sits one tint darker.
for (const d of [...districts].sort((a, b) => depthOf(a) - depthOf(b))) {
  const { x, y, width, depth } = d.bounds;
  const pts = [project(x, y), project(x + width, y), project(x + width, y + depth), project(x, y + depth)];
  parts.push(poly(pts, PLATE[Math.min(depthOf(d), PLATE.length - 1)], PLATE_EDGE));
}
// Buildings back to front (painter's order along x + z).
const roof = new Map();
for (const b of [...buildings].sort((a, b) => a.position.x + a.position.y - (b.position.x + b.position.y))) {
  const { x, y: z } = b.position;
  const { width: w, depth: d } = b.footprint;
  const h = b.height;
  const top = [project(x, z, h), project(x + w, z, h), project(x + w, z + d, h), project(x, z + d, h)];
  const left = [project(x, z + d, 0), project(x + w, z + d, 0), project(x + w, z + d, h), project(x, z + d, h)];
  const right = [project(x + w, z, 0), project(x + w, z + d, 0), project(x + w, z + d, h), project(x + w, z, h)];
  parts.push(`<g><title>${escapeXml(b.name ?? b.id)} — ${b.metrics?.loc ?? "?"} lines</title>`);
  parts.push(poly(left, FACE_LEFT), poly(right, FACE_RIGHT), poly(top, FACE_TOP));
  parts.push("</g>");
  roof.set(b.id, project(x + w / 2, z + d / 2, h));
}
// The minimum feedback set, roof to roof, last so it stays visible.
for (const a of feedback) {
  const [x1, y1] = roof.get(a.from);
  const [x2, y2] = roof.get(a.to);
  const lift = Math.hypot(x2 - x1, y2 - y1) * 0.12 + 3;
  const cx = (x1 + x2) / 2;
  const cy = Math.min(y1, y2) - lift;
  parts.push(
    `<path d="M${fmt(x1)},${fmt(y1)} Q${fmt(cx)},${fmt(cy)} ${fmt(x2)},${fmt(y2)}" fill="none" stroke="${FEEDBACK}" stroke-width="0.55" stroke-linecap="round" opacity="0.8"/>`,
  );
}

// Extent from everything drawn.
const all = [];
for (const d of districts) {
  const { x, y, width, depth } = d.bounds;
  all.push(project(x, y), project(x + width, y), project(x + width, y + depth), project(x, y + depth));
}
for (const b of buildings) all.push(project(b.position.x, b.position.y, b.height));
for (const [x, y] of roof.values()) all.push([x, y - 20]);
const xs = all.map((p) => p[0]);
const ys = all.map((p) => p[1]);
const pad = 6;
const minX = Math.min(...xs) - pad;
const minY = Math.min(...ys) - pad;
const width = Math.max(...xs) - minX + pad;
const height = Math.max(...ys) - minY + pad;

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}" role="img" aria-labelledby="t">`,
  `<title id="t">The code city of ${escapeXml(city.corpus.name)}: ${districts.length} packages, ${buildings.length} classes, ${feedback.length} cycle-breaking dependencies in red.</title>`,
  ...parts,
  "</svg>",
].join("\n");

process.stdout.write(svg + "\n");
console.error(
  JSON.stringify({
    corpus: city.corpus.name,
    districts: districts.length,
    buildings: buildings.length,
    feedback: feedback.length,
    height: city.bindings.find((b) => b.channel === "height")?.metric,
    footprint: city.bindings.find((b) => b.channel === "footprint")?.metric,
  }),
);

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
}
