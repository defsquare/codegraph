import * as THREE from "three";
import type { CityLayout } from "@codegraph/city";
import { arrowArcs, type ArrowArc } from "../scene/arrows.js";
import { buildingBoxes, type BuildingBox } from "../scene/buildings.js";
import { districtArcs, type DistrictArc } from "../scene/districtArrows.js";
import { districtPlates, groundPlate, type Plate } from "../scene/districts.js";
import {
  ARC_SEGMENTS,
  ARROW_ALPHA_DIMMED,
  ARROW_ALPHA_FOCUS,
  ARROW_ALPHA_MAX,
  ARROW_ALPHA_MIN,
  COLORS,
  INFERRED_DESATURATION,
  INFERRED_GRAY,
  PLATE_LEVEL_TARGET,
  PLATE_SELECT_TINT,
  PLATE_TINT_PER_LEVEL,
} from "../theme.js";

/** Which of a selected district's dependency directions are drawn. */
export interface FanToggles {
  readonly fanIn: boolean;
  readonly fanOut: boolean;
}

/**
 * The Three.js upload of the scene model. All geometry is built ONCE here;
 * the render loop touches nothing but the camera. Draw calls stay constant in
 * city size: one instanced mesh for buildings, one for district plates, one
 * ground mesh, one LineSegments for type arrows and one for district arrows.
 * Every interactive state change is an in-place attribute rewrite.
 */
export interface CityScene {
  readonly root: THREE.Group;
  readonly buildingsMesh: THREE.InstancedMesh;
  readonly platesMesh: THREE.InstancedMesh;
  /** Instance index -> building / plate, same order as the artifact. */
  readonly boxes: readonly BuildingBox[];
  readonly plates: readonly Plate[];
  readonly arcs: readonly ArrowArc[];
  readonly districtArcs: readonly DistrictArc[];
  /** Focus a building by instance index (null = none): its type arrows brighten. */
  setFocus(index: number | null): void;
  /** Select a district: its plate brightens and its fan arcs show, per toggles. */
  setDistrictFocus(districtId: string | null, toggles: FanToggles): void;
  setBuildingsVisible(visible: boolean): void;
  setTypeArrowsVisible(visible: boolean): void;
  dispose(): void;
}

const VERTICES_PER_ARC = ARC_SEGMENTS * 2; // line-segment pairs between samples

export function createCityScene(city: CityLayout): CityScene {
  const root = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const boxes = buildingBoxes(city);
  const arcs = arrowArcs(city, boxes);
  const plates = districtPlates(city);
  const dArcs = districtArcs(city, plates, boxes);

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  // Ground.
  const ground = groundPlate(city);
  const slabGeometry = new THREE.BoxGeometry(1, 1, 1);
  const groundMaterial = new THREE.MeshLambertMaterial({ color: COLORS.ground });
  const groundMesh = new THREE.Mesh(slabGeometry, groundMaterial);
  groundMesh.position.set(...ground.center);
  groundMesh.scale.set(...ground.size);
  root.add(groundMesh);
  disposables.push(slabGeometry, groundMaterial);

  // District plates: per-instance color encodes nesting depth (further toward
  // the tint target = deeper).
  const plateMaterial = new THREE.MeshLambertMaterial();
  const platesMesh = new THREE.InstancedMesh(slabGeometry, plateMaterial, plates.length);
  const plateTintTarget = new THREE.Color(PLATE_LEVEL_TARGET);
  const plateBaseColor = (plate: Plate): THREE.Color =>
    color
      .setHex(COLORS.districtPlate)
      .lerp(plateTintTarget, Math.min(plate.level * PLATE_TINT_PER_LEVEL, 0.4));
  plates.forEach((plate, i) => {
    matrix.makeScale(...plate.size).setPosition(...plate.center);
    platesMesh.setMatrixAt(i, matrix);
    platesMesh.setColorAt(i, plateBaseColor(plate));
  });
  root.add(platesMesh);
  disposables.push(plateMaterial, platesMesh);

  // Buildings: one instanced box, per-instance color = declared vs stub.
  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const buildingMaterial = new THREE.MeshLambertMaterial();
  const buildingsMesh = new THREE.InstancedMesh(buildingGeometry, buildingMaterial, boxes.length);
  boxes.forEach((box, i) => {
    matrix.makeScale(...box.size).setPosition(...box.center);
    buildingsMesh.setMatrixAt(i, matrix);
    buildingsMesh.setColorAt(i, color.setHex(box.isStub ? COLORS.buildingStub : COLORS.building));
  });
  root.add(buildingsMesh);
  disposables.push(buildingGeometry, buildingMaterial, buildingsMesh);

  // Type arrows: one LineSegments, RGBA vertex colors. RGB = provenance
  // (declared/inferred), alpha = weight and focus state.
  const typeArrows = buildArcLines(arcs.map((arc) => ({ arc, tint: typeTint(arc.inferred) })));
  typeArrows.lines.raycast = () => undefined;
  root.add(typeArrows.lines);
  disposables.push(typeArrows.geometry, typeArrows.material);
  arcs.forEach((arc, i) => typeArrows.setAlpha(i, restingAlpha(arc.weight)));
  typeArrows.commit();

  // District arrows: same construction, but RGB is rewritten per selection
  // (fan-in vs fan-out is a property of the SELECTED district, not of the
  // arrow), and everything rests hidden until a district is selected.
  const districtArrows = buildArcLines(
    dArcs.map((arc) => ({ arc, tint: new THREE.Color(COLORS.arrowFanOut) })),
  );
  districtArrows.lines.raycast = () => undefined;
  root.add(districtArrows.lines);
  disposables.push(districtArrows.geometry, districtArrows.material);
  districtArrows.commit();

  function setFocus(index: number | null): void {
    const focusId = index === null ? null : boxes[index]?.id ?? null;
    arcs.forEach((arc, i) => {
      typeArrows.setAlpha(
        i,
        focusId === null
          ? restingAlpha(arc.weight)
          : arc.from === focusId || arc.to === focusId
            ? ARROW_ALPHA_FOCUS
            : ARROW_ALPHA_DIMMED,
      );
    });
    typeArrows.commit();
  }

  let selectedPlate: number | null = null;
  function setDistrictFocus(districtId: string | null, toggles: FanToggles): void {
    // Plate highlight, in place.
    if (selectedPlate !== null) {
      const plate = plates[selectedPlate];
      if (plate !== undefined) platesMesh.setColorAt(selectedPlate, plateBaseColor(plate));
    }
    selectedPlate = districtId === null ? null : plates.findIndex((p) => p.id === districtId);
    if (selectedPlate === -1) selectedPlate = null;
    if (selectedPlate !== null) {
      const plate = plates[selectedPlate];
      if (plate !== undefined) {
        platesMesh.setColorAt(
          selectedPlate,
          plateBaseColor(plate).lerp(plateTintTarget, PLATE_SELECT_TINT),
        );
      }
    }
    if (platesMesh.instanceColor) platesMesh.instanceColor.needsUpdate = true;

    // Fan arcs: hue = direction relative to the selection, alpha = weight;
    // inferred arcs desaturate but keep their direction hue.
    const fanIn = new THREE.Color(COLORS.arrowFanIn);
    const fanOut = new THREE.Color(COLORS.arrowFanOut);
    const gray = new THREE.Color(INFERRED_GRAY);
    dArcs.forEach((arc, i) => {
      const isOut = districtId !== null && arc.from === districtId;
      const isIn = districtId !== null && arc.to === districtId;
      const shown = (isOut && toggles.fanOut) || (isIn && toggles.fanIn);
      if (!shown) {
        districtArrows.setAlpha(i, 0);
        return;
      }
      color.copy(isOut ? fanOut : fanIn);
      if (arc.inferred) color.lerp(gray, INFERRED_DESATURATION);
      districtArrows.setTint(i, color);
      districtArrows.setAlpha(i, ARROW_ALPHA_MIN + arc.weight * (ARROW_ALPHA_FOCUS - ARROW_ALPHA_MIN));
    });
    districtArrows.commit();
  }

  return {
    root,
    buildingsMesh,
    platesMesh,
    boxes,
    plates,
    arcs,
    districtArcs: dArcs,
    setFocus,
    setDistrictFocus,
    setBuildingsVisible: (visible) => {
      buildingsMesh.visible = visible;
    },
    setTypeArrowsVisible: (visible) => {
      typeArrows.lines.visible = visible;
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

function typeTint(inferred: boolean): THREE.Color {
  return new THREE.Color(inferred ? COLORS.arrowInferred : COLORS.arrowDeclared);
}

function restingAlpha(weight: number): number {
  return ARROW_ALPHA_MIN + weight * (ARROW_ALPHA_MAX - ARROW_ALPHA_MIN);
}

interface ArcSource {
  readonly arc: { readonly points: readonly (readonly [number, number, number])[] };
  readonly tint: THREE.Color;
}

/** Shared LineSegments builder: one geometry, RGBA vertex colors, per-arc ranges. */
function buildArcLines(sources: readonly ArcSource[]) {
  const positions = new Float32Array(sources.length * VERTICES_PER_ARC * 3);
  const colors = new Float32Array(sources.length * VERTICES_PER_ARC * 4);
  sources.forEach(({ arc, tint }, arcIndex) => {
    for (let segment = 0; segment < ARC_SEGMENTS; segment += 1) {
      for (let end = 0; end < 2; end += 1) {
        const vertex = arcIndex * VERTICES_PER_ARC + segment * 2 + end;
        const point = arc.points[segment + end] as readonly [number, number, number];
        positions.set(point, vertex * 3);
        colors[vertex * 4] = tint.r;
        colors[vertex * 4 + 1] = tint.g;
        colors[vertex * 4 + 2] = tint.b;
        colors[vertex * 4 + 3] = 0;
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const colorAttribute = new THREE.BufferAttribute(colors, 4);
  geometry.setAttribute("color", colorAttribute);
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  return {
    lines,
    geometry,
    material,
    setAlpha(arcIndex: number, alpha: number): void {
      const base = arcIndex * VERTICES_PER_ARC;
      for (let vertex = 0; vertex < VERTICES_PER_ARC; vertex += 1) {
        colors[(base + vertex) * 4 + 3] = alpha;
      }
    },
    setTint(arcIndex: number, tint: THREE.Color): void {
      const base = arcIndex * VERTICES_PER_ARC;
      for (let vertex = 0; vertex < VERTICES_PER_ARC; vertex += 1) {
        colors[(base + vertex) * 4] = tint.r;
        colors[(base + vertex) * 4 + 1] = tint.g;
        colors[(base + vertex) * 4 + 2] = tint.b;
      }
    },
    commit(): void {
      colorAttribute.needsUpdate = true;
    },
  };
}
