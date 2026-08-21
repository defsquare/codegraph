import * as THREE from "three";
import type { CityLayout } from "@codegraph/city";
import { arrowArcs, type ArrowArc } from "../scene/arrows.js";
import { buildingBoxes, type BuildingBox } from "../scene/buildings.js";
import { districtPlates, groundPlate } from "../scene/districts.js";
import {
  ARC_SEGMENTS,
  ARROW_ALPHA_DIMMED,
  ARROW_ALPHA_FOCUS,
  ARROW_ALPHA_MAX,
  ARROW_ALPHA_MIN,
  COLORS,
} from "../theme.js";

/**
 * The Three.js upload of the scene model. All geometry is built ONCE here;
 * the render loop touches nothing but the camera. Draw calls stay constant in
 * city size: one instanced mesh for every building, one for every district
 * plate, one mesh for the ground, one LineSegments for every arrow.
 */
export interface CityScene {
  readonly root: THREE.Group;
  readonly buildingsMesh: THREE.InstancedMesh;
  /** Instance index -> building, same order as the artifact. */
  readonly boxes: readonly BuildingBox[];
  readonly arcs: readonly ArrowArc[];
  /**
   * Focus a building by instance index (null = none): its arrows brighten,
   * every other arrow fades. Rewrites the alpha channel in place — the render
   * loop allocates nothing.
   */
  setFocus(index: number | null): void;
  dispose(): void;
}

const VERTICES_PER_ARC = ARC_SEGMENTS * 2; // line-segment pairs between samples

export function createCityScene(city: CityLayout): CityScene {
  const root = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const boxes = buildingBoxes(city);
  const arcs = arrowArcs(city, boxes);

  const matrix = new THREE.Matrix4();

  // Ground + district plates.
  const ground = groundPlate(city);
  const slabGeometry = new THREE.BoxGeometry(1, 1, 1);
  const groundMaterial = new THREE.MeshLambertMaterial({ color: COLORS.ground });
  const groundMesh = new THREE.Mesh(slabGeometry, groundMaterial);
  groundMesh.position.set(...ground.center);
  groundMesh.scale.set(...ground.size);
  root.add(groundMesh);
  disposables.push(slabGeometry, groundMaterial);

  const plates = districtPlates(city);
  const plateMaterial = new THREE.MeshLambertMaterial({ color: COLORS.districtPlate });
  const platesMesh = new THREE.InstancedMesh(slabGeometry, plateMaterial, plates.length);
  plates.forEach((plate, i) => {
    matrix.makeScale(...plate.size).setPosition(...plate.center);
    platesMesh.setMatrixAt(i, matrix);
  });
  root.add(platesMesh);
  disposables.push(plateMaterial, platesMesh);

  // Buildings: one instanced box, per-instance color = declared vs stub.
  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const buildingMaterial = new THREE.MeshLambertMaterial();
  const buildingsMesh = new THREE.InstancedMesh(buildingGeometry, buildingMaterial, boxes.length);
  const color = new THREE.Color();
  boxes.forEach((box, i) => {
    matrix.makeScale(...box.size).setPosition(...box.center);
    buildingsMesh.setMatrixAt(i, matrix);
    buildingsMesh.setColorAt(i, color.setHex(box.isStub ? COLORS.buildingStub : COLORS.building));
  });
  root.add(buildingsMesh);
  disposables.push(buildingGeometry, buildingMaterial, buildingsMesh);

  // Arrows: a single LineSegments with RGBA vertex colors. RGB encodes
  // provenance (declared/inferred), alpha encodes weight and focus state.
  const positions = new Float32Array(arcs.length * VERTICES_PER_ARC * 3);
  const colors = new Float32Array(arcs.length * VERTICES_PER_ARC * 4);
  const declared = new THREE.Color(COLORS.arrowDeclared);
  const inferred = new THREE.Color(COLORS.arrowInferred);
  arcs.forEach((arc, arcIndex) => {
    const tint = arc.inferred ? inferred : declared;
    const alpha = restingAlpha(arc);
    for (let segment = 0; segment < ARC_SEGMENTS; segment += 1) {
      for (let end = 0; end < 2; end += 1) {
        const vertex = arcIndex * VERTICES_PER_ARC + segment * 2 + end;
        const point = arc.points[segment + end] as readonly [number, number, number];
        positions.set(point, vertex * 3);
        colors[vertex * 4] = tint.r;
        colors[vertex * 4 + 1] = tint.g;
        colors[vertex * 4 + 2] = tint.b;
        colors[vertex * 4 + 3] = alpha;
      }
    }
  });
  const arrowGeometry = new THREE.BufferGeometry();
  arrowGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const colorAttribute = new THREE.BufferAttribute(colors, 4);
  arrowGeometry.setAttribute("color", colorAttribute);
  const arrowMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  const arrowLines = new THREE.LineSegments(arrowGeometry, arrowMaterial);
  arrowLines.raycast = () => undefined; // arrows are never pick targets
  root.add(arrowLines);
  disposables.push(arrowGeometry, arrowMaterial);

  function setFocus(index: number | null): void {
    const focusId = index === null ? null : boxes[index]?.id ?? null;
    arcs.forEach((arc, arcIndex) => {
      const alpha =
        focusId === null
          ? restingAlpha(arc)
          : arc.from === focusId || arc.to === focusId
            ? ARROW_ALPHA_FOCUS
            : ARROW_ALPHA_DIMMED;
      const base = arcIndex * VERTICES_PER_ARC;
      for (let vertex = 0; vertex < VERTICES_PER_ARC; vertex += 1) {
        colors[(base + vertex) * 4 + 3] = alpha;
      }
    });
    colorAttribute.needsUpdate = true;
  }

  return {
    root,
    buildingsMesh,
    boxes,
    arcs,
    setFocus,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

function restingAlpha(arc: ArrowArc): number {
  return ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_MAX - ARROW_ALPHA_MIN);
}
