import * as THREE from "three";

/**
 * Instance picking against the buildings mesh. Runs on pointer events, not per
 * frame; the raycaster and NDC vector are reused across calls.
 */
export class BuildingPicker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  /** Returns the picked building's instance index, or null. */
  pick(
    event: { clientX: number; clientY: number },
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    mesh: THREE.InstancedMesh,
  ): number | null {
    const rect = canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, camera);
    const hit = this.raycaster.intersectObject(mesh, false)[0];
    return hit?.instanceId ?? null;
  }
}
