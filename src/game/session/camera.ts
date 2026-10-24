/**
 * Camera views the session adds to the chase camera: the view modes the number
 * keys and C pick between (a replay's seven, a live session's chase family
 * plus the trackside TV and the orbit), the mouse drag that orbits the follow
 * camera around the car, and the trackside TV camera, which stands by the
 * route ahead of the car and tracks it as it passes (or a point ahead along
 * the heading in the open world). Render only.
 */
import * as THREE from 'three';
import { routeSample } from '../../city/route';
import type { RaceState } from '../../sim/race';
import type { CameraMode, ChaseCamera } from '../../render/camera/camera';
import type { Snap } from './snap';

export type ReplayCamMode = 'chase' | 'close' | 'bumper' | 'hood' | 'tv' | 'orbit' | 'free';
export const REPLAY_CAMS: ReplayCamMode[] = ['chase', 'tv', 'orbit', 'close', 'hood', 'free'];
/** Number key views: 1 chase, 2 close, 3 bumper, 4 hood, 5 trackside TV, 6 orbit, 7 free fly (replays); 0 is the drone. */
export const VIEW_KEYS: ReplayCamMode[] = ['chase', 'close', 'bumper', 'hood', 'tv', 'orbit', 'free'];
export const isFollowCam = (v: ReplayCamMode): v is CameraMode => v === 'chase' || v === 'close' || v === 'bumper' || v === 'hood';

/**
 * A mouse drag orbits the follow camera around the car at any time (touch keeps its steering). `blocked`
 * says when the drag does nothing (the drone flies, a replay's free camera). Returns the unbinder.
 */
export function bindOrbitDrag(canvas: HTMLCanvasElement, cam: ChaseCamera, blocked: () => boolean): () => void {
  let drag: { id: number; x: number; y: number } | null = null;
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.button !== 0 || blocked()) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    cam.setOrbiting(true);
    canvas.style.cursor = 'grabbing';
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    cam.orbitBy(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    cam.setOrbiting(false);
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    canvas.style.cursor = '';
  };
}

/** The trackside TV camera: a fixed roadside point that is replaced by the next one ahead once the car has passed. */
export class TvCamera {
  private point = new THREE.Vector3();
  private valid = false;
  private side = 1;

  /** The next frame picks a new roadside point (a view was just selected). */
  invalidate(): void {
    this.valid = false;
  }

  /** Aim `cam` from the roadside point at the car's pose `p`, choosing a new point when needed; zooms to keep the car framed. */
  place(cam: THREE.PerspectiveCamera, chase: ChaseCamera, race: RaceState, p: Snap): THREE.PerspectiveCamera {
    const d = this.point.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    if (!this.valid || d > 70) {
      const side = (this.side = -this.side);
      if (race.world.openWorld) {
        // Open world: off the route, so a point ahead along the car's heading, pulled in front of any wall.
        const fx = Math.sin(p.yaw);
        const fz = Math.cos(p.yaw);
        const pt = new THREE.Vector3(p.x + fx * 40 + fz * 5 * side, 0, p.z + fz * 40 - fx * 5 * side);
        chase.keepOutOfWalls(p.x, p.z, pt, 3.2, 0);
        pt.y = Math.max(pt.y, race.world.heightAt(pt.x, pt.z) + 3.2);
        this.point.copy(pt);
      } else {
        // Next roadside camera: on the route ahead, near the curb, so it is never inside a building.
        const route = race.world.route;
        const rc = race.cars[0];
        const ahead = routeSample(route, rc.rawS + 45);
        const half = route.segWidth[ahead.seg] / 2 - 1;
        const x = ahead.x + ahead.tz * half * side;
        const z = ahead.z - ahead.tx * half * side;
        this.point.set(x, race.world.heightAt(x, z) + 3.2, z);
      }
      this.valid = true;
    }
    cam.position.copy(this.point);
    cam.lookAt(p.x, p.y + 0.7, p.z);
    const fov = Math.max(18, Math.min(60, 1400 / Math.max(10, d)));
    if (Math.abs(cam.fov - fov) > 0.1) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    return cam;
  }
}
