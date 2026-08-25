import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { CityLayout } from "@codegraph/city";
import { arrowArcs, type ArrowArc } from "../scene/arrows.js";
import { buildingBoxes, type BuildingBox } from "../scene/buildings.js";
import { landscapeCenter } from "../scene/center.js";
import { districtArcs, type DistrictArc } from "../scene/districtArrows.js";
import { districtPlates, groundPlate, type Plate } from "../scene/districts.js";
import { arcState, highlightMap, type ArrowToggles } from "../scene/focus.js";
import type { CityPalette } from "../scene/palette.js";
import {
  AGE_FADE_GRAY,
  AGE_FADE_MAX,
  ARC_SEGMENTS,
  ARROW_FAN_IN_WIDTH,
  ARROW_WIDTH,
  COLORS,
  HIGHLIGHT_TINT,
  INFERRED_DESATURATION,
  INFERRED_GRAY,
  PLATE_LEVEL_TARGET,
  PLATE_TINT_PER_LEVEL,
  REPLAY_HEAT_COLOR,
  SELECT_COLOR,
} from "../theme.js";

/**
 * The Three.js upload of the scene model. All geometry is built ONCE here;
 * the render loop touches nothing but the camera. Draw calls stay constant in
 * city size: one instanced mesh for buildings, one for district plates, one
 * ground mesh, one fat-line mesh for type arrows and one for district arrows.
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
  /**
   * Select a building by instance index (null = none): exactly its fan-in/out
   * type arrows show, per the toggles' decision table (scene/focus.ts).
   */
  setFocus(index: number | null, toggles: ArrowToggles): void;
  /** Select a district: its plate darkens and its fan arcs show, per toggles. */
  setDistrictFocus(districtId: string | null, toggles: ArrowToggles): void;
  setBuildingsVisible(visible: boolean): void;
  /** Show or hide stubs — buildings and plates the corpus does not declare. */
  setExternalsVisible(visible: boolean): void;
  /** Repaint buildings, stubs, plates and arrow hues from a new palette, in place. */
  setPalette(palette: CityPalette): void;
  /** Arrow width is in CSS pixels — the fat-line materials must know the
   * viewport size; call on creation and on every resize. */
  setResolution(width: number, height: number): void;
  /**
   * Replay scrub: per-instance heights (city units, artifact keyframes), or
   * null to restore the artifact's own heights. Height 0 collapses the
   * instance — an unborn or deleted building is vacant land, and unpickable.
   * In-place matrix rewrite; the scrub path allocates nothing.
   */
  setHeights(heights: ArrayLike<number> | null): void;
  /**
   * Replay TIME COLORS: per-instance heat (recent change → ember) and age
   * (fraction of the timeline lived → desaturation), or null/null to restore
   * the plain palette. The buffers stay caller-owned and are read again on
   * every repaint (palette change, selection restore); in-place recolor.
   */
  setShading(heats: ArrayLike<number> | null, ages: ArrayLike<number> | null): void;
  dispose(): void;
}

export function createCityScene(city: CityLayout, initialPalette: CityPalette): CityScene {
  let palette = initialPalette;
  const root = new THREE.Group();
  // The layout's origin is a corner; the world's is the landscape's visual
  // center — the built mass's centroid, not the bounds rectangle's middle — so
  // the camera orbits (and "Reset view" targets) the middle of the actual city.
  const center = landscapeCenter(city);
  root.position.set(-center.x, 0, -center.z);
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
      .setHex(palette.districtPlate)
      .lerp(plateTintTarget, Math.min(plate.level * PLATE_TINT_PER_LEVEL, 0.4));
  plates.forEach((plate, i) => {
    matrix.makeScale(...plate.size).setPosition(...plate.center);
    platesMesh.setMatrixAt(i, matrix);
    platesMesh.setColorAt(i, plateBaseColor(plate));
  });
  root.add(platesMesh);
  disposables.push(plateMaterial, platesMesh);

  // Buildings: one instanced box, per-instance color = declared vs stub,
  // shaded by the replay time colors when a scrub set them.
  let shadingHeats: ArrayLike<number> | null = null;
  let shadingAges: ArrayLike<number> | null = null;
  const heatColor = new THREE.Color(REPLAY_HEAT_COLOR);
  const fadeColor = new THREE.Color(AGE_FADE_GRAY);
  /** The color instance `i` wears when NOT highlighted: palette base, aged
   * toward gray, then heated toward ember — heat wins, and the picture says
   * "changed here, recently" louder than "old". Writes the shared scratch. */
  function baseBoxColor(i: number, box: BuildingBox): THREE.Color {
    color.setHex(box.isStub ? palette.buildingStub : palette.building);
    if (shadingHeats !== null && shadingAges !== null && !box.isStub) {
      color.lerp(fadeColor, Math.min(1, shadingAges[i] ?? 0) * AGE_FADE_MAX);
      color.lerp(heatColor, Math.min(1, shadingHeats[i] ?? 0));
    }
    return color;
  }
  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const buildingMaterial = new THREE.MeshLambertMaterial();
  const buildingsMesh = new THREE.InstancedMesh(buildingGeometry, buildingMaterial, boxes.length);
  boxes.forEach((box, i) => {
    matrix.makeScale(...box.size).setPosition(...box.center);
    buildingsMesh.setMatrixAt(i, matrix);
    buildingsMesh.setColorAt(i, baseBoxColor(i, box));
  });
  root.add(buildingsMesh);
  disposables.push(buildingGeometry, buildingMaterial, buildingsMesh);

  // Type arrows: one fat-line mesh (LineSegments2 — real pixel width, WebGL
  // ignores linewidth on plain lines), per-segment RGB plus a patched-in
  // per-segment alpha and width. RGB is rewritten per selection (direction
  // hue, provenance as saturation), alpha by the table, width by direction.
  const typeArrows = buildArcLines(
    arcs.map((arc) => ({ arc, tint: new THREE.Color(palette.arrowFanOut) })),
  );
  typeArrows.lines.raycast = () => undefined;
  root.add(typeArrows.lines);
  disposables.push(typeArrows.geometry, typeArrows.material);
  // Arcs rest at alpha 0 — the decision table (applyToggles -> setFocus)
  // decides everything that shows; nothing is drawn unasked.
  typeArrows.commit();

  // District arrows: same construction, but RGB is rewritten per selection
  // (fan-in vs fan-out is a property of the SELECTED district, not of the
  // arrow), and everything rests hidden until a district is selected.
  const districtArrows = buildArcLines(
    dArcs.map((arc) => ({ arc, tint: new THREE.Color(palette.arrowFanOut) })),
  );
  districtArrows.lines.raycast = () => undefined;
  root.add(districtArrows.lines);
  disposables.push(districtArrows.geometry, districtArrows.material);
  districtArrows.commit();

  // One painter for both arc families: role from the decision table, hue by
  // direction under a selection (provenance moves to the saturation channel),
  // and WIDTH by direction too — fan-in draws wider, the rarer louder reading.
  const fanInColor = new THREE.Color(palette.arrowFanIn);
  const fanOutColor = new THREE.Color(palette.arrowFanOut);
  const selectColor = new THREE.Color(SELECT_COLOR);
  const inferredGray = new THREE.Color(INFERRED_GRAY);
  function paintArcs(
    layer: ReturnType<typeof buildArcLines>,
    arcList: readonly {
      from: string;
      to: string;
      weight: number;
      inferred: boolean;
      external: boolean;
    }[],
    selected: string | null,
    toggles: ArrowToggles,
  ): void {
    arcList.forEach((arc, i) => {
      const state = arcState(arc, selected, toggles);
      if (state.role !== "hidden") {
        color.copy(state.role === "fanOut" ? fanOutColor : fanInColor);
        if (arc.inferred) color.lerp(inferredGray, INFERRED_DESATURATION);
        layer.setTint(i, color);
        layer.setWidth(i, state.role === "fanIn" ? ARROW_FAN_IN_WIDTH : 1);
      }
      layer.setAlpha(i, state.alpha);
    });
    layer.commit();
  }

  // SELECTION LIGHTS UP THE NEIGHBORHOOD: the origin darkens (selected =
  // darker, the plate rule), and the far end of every VISIBLE arc tints toward
  // that arc's direction hue — highlightMap shares the arcs' decision table,
  // so a tinted element and an on-screen arc can never disagree. In-place
  // instance recolors; the previous highlight set is restored first.
  const boxIndexById = new Map(boxes.map((box, i) => [box.id, i] as const));
  const plateIndexById = new Map(plates.map((plate, i) => [plate.id, i] as const));
  let highlightedBoxes: number[] = [];
  let highlightedPlates: number[] = [];
  // What setPalette re-applies after repainting every base color.
  let lastFocus: { index: number | null; toggles: ArrowToggles } | null = null;
  let lastDistrict: { id: string | null; toggles: ArrowToggles } | null = null;

  function setFocus(index: number | null, toggles: ArrowToggles): void {
    lastFocus = { index, toggles };
    const focusId = index === null ? null : boxes[index]?.id ?? null;
    paintArcs(typeArrows, arcs, focusId, toggles);
    for (const i of highlightedBoxes) {
      const box = boxes[i];
      if (box !== undefined) buildingsMesh.setColorAt(i, baseBoxColor(i, box));
    }
    highlightedBoxes = [];
    for (const [id, role] of highlightMap(arcs, focusId, toggles)) {
      const i = boxIndexById.get(id);
      const box = i === undefined ? undefined : boxes[i];
      if (i === undefined || box === undefined) continue;
      // The highlight hue outright — the base color is user-configurable, so
      // any relative tint could be invisible on the palette the user picked.
      color.copy(role === "origin" ? selectColor : role === "fanIn" ? fanInColor : fanOutColor);
      buildingsMesh.setColorAt(i, color);
      highlightedBoxes.push(i);
    }
    if (buildingsMesh.instanceColor) buildingsMesh.instanceColor.needsUpdate = true;
  }

  function setDistrictFocus(districtId: string | null, toggles: ArrowToggles): void {
    lastDistrict = { id: districtId, toggles };
    for (const i of highlightedPlates) {
      const plate = plates[i];
      if (plate !== undefined) platesMesh.setColorAt(i, plateBaseColor(plate));
    }
    highlightedPlates = [];
    for (const [id, role] of highlightMap(dArcs, districtId, toggles)) {
      const i = plateIndexById.get(id);
      const plate = i === undefined ? undefined : plates[i];
      if (i === undefined || plate === undefined) continue;
      const painted = plateBaseColor(plate).lerp(
        role === "origin" ? selectColor : role === "fanIn" ? fanInColor : fanOutColor,
        HIGHLIGHT_TINT,
      );
      platesMesh.setColorAt(i, painted);
      highlightedPlates.push(i);
    }
    if (platesMesh.instanceColor) platesMesh.instanceColor.needsUpdate = true;

    paintArcs(districtArrows, dArcs, districtId, toggles);
  }

  // Scrub-path recolor: repaint every base, then re-assert the selection's
  // highlights on top (the trackers must not restore stale colors). In-place,
  // shared scratch Color — the scrub path allocates nothing.
  function setShading(heats: ArrayLike<number> | null, ages: ArrayLike<number> | null): void {
    shadingHeats = heats;
    shadingAges = ages;
    boxes.forEach((box, i) => {
      buildingsMesh.setColorAt(i, baseBoxColor(i, box));
    });
    if (buildingsMesh.instanceColor) buildingsMesh.instanceColor.needsUpdate = true;
    highlightedBoxes = [];
    if (lastFocus !== null) setFocus(lastFocus.index, lastFocus.toggles);
  }

  function setHeights(heights: ArrayLike<number> | null): void {
    boxes.forEach((box, i) => {
      const height = heights === null ? box.size[1] : heights[i] ?? 0;
      const base = box.center[1] - box.size[1] / 2;
      if (height <= 0) {
        matrix.makeScale(0, 0, 0).setPosition(box.center[0], base, box.center[2]);
      } else {
        matrix
          .makeScale(box.size[0], height, box.size[2])
          .setPosition(box.center[0], base + height / 2, box.center[2]);
      }
      buildingsMesh.setMatrixAt(i, matrix);
    });
    buildingsMesh.instanceMatrix.needsUpdate = true;
  }

  // Stubs hide by collapsing their instance to zero scale — the one instanced
  // mesh stays one draw call, and a zero-scaled instance cannot be picked.
  function setExternalsVisible(visible: boolean): void {
    boxes.forEach((box, i) => {
      if (!box.isStub) return;
      if (visible) matrix.makeScale(...box.size).setPosition(...box.center);
      else matrix.makeScale(0, 0, 0).setPosition(...box.center);
      buildingsMesh.setMatrixAt(i, matrix);
    });
    buildingsMesh.instanceMatrix.needsUpdate = true;
    plates.forEach((plate, i) => {
      if (!plate.isStub) return;
      if (visible) matrix.makeScale(...plate.size).setPosition(...plate.center);
      else matrix.makeScale(0, 0, 0).setPosition(...plate.center);
      platesMesh.setMatrixAt(i, matrix);
    });
    platesMesh.instanceMatrix.needsUpdate = true;
  }

  // Event-driven repaint (never per-frame): rewrite the instance colors the
  // palette feeds, then re-apply the current selection's highlights on top.
  // Arrow hues live in closure Colors that paintArcs (re-run below through
  // setFocus/setDistrictFocus) and the highlight painters read.
  function setPalette(next: CityPalette): void {
    palette = next;
    fanInColor.setHex(palette.arrowFanIn);
    fanOutColor.setHex(palette.arrowFanOut);
    boxes.forEach((box, i) => {
      buildingsMesh.setColorAt(i, baseBoxColor(i, box));
    });
    if (buildingsMesh.instanceColor) buildingsMesh.instanceColor.needsUpdate = true;
    plates.forEach((plate, i) => {
      platesMesh.setColorAt(i, plateBaseColor(plate));
    });
    if (platesMesh.instanceColor) platesMesh.instanceColor.needsUpdate = true;
    // Every instance now wears its base color; the trackers must not "restore"
    // stale entries over the fresh paint.
    highlightedBoxes = [];
    highlightedPlates = [];
    if (lastFocus !== null) setFocus(lastFocus.index, lastFocus.toggles);
    if (lastDistrict !== null) setDistrictFocus(lastDistrict.id, lastDistrict.toggles);
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
    setPalette,
    setResolution: (width, height) => {
      typeArrows.material.resolution.set(width, height);
      districtArrows.material.resolution.set(width, height);
    },
    setBuildingsVisible: (visible) => {
      buildingsMesh.visible = visible;
    },
    setExternalsVisible,
    setHeights,
    setShading,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

interface ArcSource {
  readonly arc: { readonly points: readonly (readonly [number, number, number])[] };
  readonly tint: THREE.Color;
}

/**
 * Fat-line LineMaterial ships per-mesh uniforms only; the city needs per-ARC
 * alpha (weight, dimming) and width (fan-in louder), so two instanced
 * attributes are patched into its shader. The anchors are exact source lines
 * of three's LineMaterial — a three upgrade that moves them must fail loudly
 * here, never silently drop the channels.
 */
function makeArcMaterial(): LineMaterial {
  const material = new LineMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    linewidth: ARROW_WIDTH,
    alphaToCoverage: false,
  });
  const patch = (source: string, anchor: string, replacement: string): string => {
    if (!source.includes(anchor)) {
      throw new Error(`LineMaterial shader changed: cannot find "${anchor}"`);
    }
    return source.replace(anchor, replacement);
  };
  let vertex = material.vertexShader;
  vertex = patch(
    vertex,
    "attribute vec3 instanceColorEnd;",
    "attribute vec3 instanceColorEnd;\n" +
      "attribute float instanceAlpha;\n" +
      "attribute float instanceWidth;\n" +
      "varying float vArcAlpha;",
  );
  vertex = patch(vertex, "float aspect = ", "vArcAlpha = instanceAlpha;\nfloat aspect = ");
  vertex = patch(vertex, "offset *= linewidth;", "offset *= linewidth * instanceWidth;");
  material.vertexShader = vertex;
  let fragment = material.fragmentShader;
  fragment = patch(
    fragment,
    "uniform float opacity;",
    "uniform float opacity;\nvarying float vArcAlpha;",
  );
  fragment = patch(
    fragment,
    "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
    "gl_FragColor = vec4( diffuseColor.rgb, alpha * vArcAlpha );",
  );
  material.fragmentShader = fragment;
  return material;
}

/** Shared fat-line builder: one instanced geometry, per-segment color plus the
 * patched per-segment alpha and width channels, addressed in per-arc ranges. */
function buildArcLines(sources: readonly ArcSource[]) {
  // Fat lines are one instance per SEGMENT: start xyz + end xyz.
  const positions = new Float32Array(sources.length * ARC_SEGMENTS * 6);
  const colors = new Float32Array(sources.length * ARC_SEGMENTS * 6);
  const alphas = new Float32Array(sources.length * ARC_SEGMENTS);
  const widths = new Float32Array(sources.length * ARC_SEGMENTS).fill(1);
  sources.forEach(({ arc, tint }, arcIndex) => {
    for (let segment = 0; segment < ARC_SEGMENTS; segment += 1) {
      const base = (arcIndex * ARC_SEGMENTS + segment) * 6;
      for (let end = 0; end < 2; end += 1) {
        const point = arc.points[segment + end] as readonly [number, number, number];
        positions.set(point, base + end * 3);
        colors[base + end * 3] = tint.r;
        colors[base + end * 3 + 1] = tint.g;
        colors[base + end * 3 + 2] = tint.b;
      }
    }
  });
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  geometry.setColors(colors);
  // setColors wrapped `colors` in the interleaved buffer the shader reads;
  // keep the buffer at hand — setTint writes into `colors` THROUGH it.
  const colorBuffer = (geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute)
    .data;
  const alphaAttribute = new THREE.InstancedBufferAttribute(alphas, 1);
  const widthAttribute = new THREE.InstancedBufferAttribute(widths, 1);
  geometry.setAttribute("instanceAlpha", alphaAttribute);
  geometry.setAttribute("instanceWidth", widthAttribute);
  const material = makeArcMaterial();
  const lines = new LineSegments2(geometry, material);
  return {
    lines,
    geometry,
    material,
    setAlpha(arcIndex: number, alpha: number): void {
      alphas.fill(alpha, arcIndex * ARC_SEGMENTS, (arcIndex + 1) * ARC_SEGMENTS);
    },
    setTint(arcIndex: number, tint: THREE.Color): void {
      const base = arcIndex * ARC_SEGMENTS * 6;
      for (let offset = 0; offset < ARC_SEGMENTS * 6; offset += 3) {
        colors[base + offset] = tint.r;
        colors[base + offset + 1] = tint.g;
        colors[base + offset + 2] = tint.b;
      }
    },
    setWidth(arcIndex: number, width: number): void {
      widths.fill(width, arcIndex * ARC_SEGMENTS, (arcIndex + 1) * ARC_SEGMENTS);
    },
    commit(): void {
      colorBuffer.needsUpdate = true;
      alphaAttribute.needsUpdate = true;
      widthAttribute.needsUpdate = true;
    },
  };
}
