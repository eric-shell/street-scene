/**
 * Race cameras. Chase cameras follow a smoothed point behind the car, pull
 * back and widen FOV under nitrous, and never go through buildings: the line
 * from the car to the camera is tested against the static wall segments and
 * the camera is pushed in front of any hit. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { CarPose } from './carView';

export const CAMERA_MODES = ['chase', 'close', 'bumper', 'hood'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

const PROFILE: Record<'chase' | 'close', { dist: number; height: number; look: number }> = {
  chase: { dist: 6.4, height: 2.3, look: 1.1 },
  close: { dist: 4.6, height: 1.7, look: 0.95 },
};

export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2200);
  mode: CameraMode = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private dirYaw = 0;
  private fov = 62;
  private initialized = false;
  private shake = 0;
  private scratch: number[] = [];

  constructor(private readonly world: World | null) {}

  cycle(): CameraMode {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.initialized = false;
    return this.mode;
  }

  bump(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  update(p: CarPose, vx: number, vz: number, nitro: boolean, carLength: number, dt: number): void {
    const speed = Math.hypot(vx, vz);
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const cam = this.camera;
    const k = 1 - Math.exp(-dt * 7);

    if (this.mode === 'bumper' || this.mode === 'hood') {
      const forward = this.mode === 'bumper' ? carLength / 2 + 0.05 : 0.5;
      const h = this.mode === 'bumper' ? 0.55 : 1.18;
      cam.position.set(p.x + fx * forward, p.y + h - p.pitch * forward, p.z + fz * forward);
      cam.up.set(0, 1, 0);
      cam.lookAt(p.x + fx * (forward + 20), p.y + h - 0.4, p.z + fz * (forward + 20));
      cam.rotateZ(-p.roll * 0.5);
      this.setFov(70 + Math.min(18, speed * 0.18) + (nitro ? 8 : 0), dt);
      this.initialized = true;
      return;
    }

    const prof = PROFILE[this.mode];
    // Swing toward the direction of travel when drifting, so the slide stays in view.
    let targetYaw = p.yaw;
    if (speed > 4) {
      const velYaw = Math.atan2(vx, vz);
      let d = velYaw - p.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 2) targetYaw = p.yaw + d * 0.45;
    }
    if (!this.initialized) this.dirYaw = targetYaw;
    let dy = targetYaw - this.dirYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.dirYaw += dy * (1 - Math.exp(-dt * 5));

    const dist = prof.dist + (nitro ? 1.3 : 0) + Math.min(1.2, speed * 0.015);
    const bx = Math.sin(this.dirYaw);
    const bz = Math.cos(this.dirYaw);
    const target = new THREE.Vector3(p.x - bx * dist, p.y + prof.height, p.z - bz * dist);
    const lookT = new THREE.Vector3(p.x + fx * 2.5, p.y + prof.look, p.z + fz * 2.5);
    if (!this.initialized) {
      this.pos.copy(target);
      this.look.copy(lookT);
      this.initialized = true;
    } else {
      this.pos.lerp(target, k);
      this.look.lerp(lookT, 1 - Math.exp(-dt * 14));
    }

    // Keep the camera out of buildings.
    const out = this.pos.clone();
    if (this.world) {
      const hit = this.wallHit(p.x, p.z, out.x, out.z);
      if (hit < 1) {
        const t = Math.max(0.15, hit - 0.08);
        out.x = p.x + (out.x - p.x) * t;
        out.z = p.z + (out.z - p.z) * t;
        out.y += (1 - t) * 1.5;
      }
      out.y = Math.max(out.y, this.world.heightAt(out.x, out.z) + 0.6);
    }
    if (this.shake > 0.001) {
      out.x += (Math.random() - 0.5) * this.shake * 0.35;
      out.y += (Math.random() - 0.5) * this.shake * 0.25;
      this.shake *= Math.exp(-dt * 6);
    }
    cam.position.copy(out);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    this.setFov(62 + Math.min(12, speed * 0.14) + (nitro ? 11 : 0), dt);
  }

  private setFov(target: number, dt: number): void {
    this.fov += (target - this.fov) * (1 - Math.exp(-dt * 4));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Fraction along (ax,az)->(bx,bz) of the first wall hit, or 1. */
  private wallHit(ax: number, az: number, bx: number, bz: number): number {
    const w = this.world!;
    w.wallGrid.query(Math.min(ax, bx) - 1, Math.min(az, bz) - 1, Math.max(ax, bx) + 1, Math.max(az, bz) + 1, this.scratch);
    let best = 1;
    const dx = bx - ax;
    const dz = bz - az;
    for (const id of this.scratch) {
      const s = w.walls[id];
      const ex = s.bx - s.ax;
      const ez = s.bz - s.az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s.ax - ax) * ez - (s.az - az) * ex) / den;
      const u = ((s.ax - ax) * dz - (s.az - az) * dx) / den;
      if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
    }
    return best;
  }
}
