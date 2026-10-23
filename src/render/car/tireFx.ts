/**
 * Tires losing traction, on screen: reads every race car's tire telemetry
 * once per sim tick and feeds the marks (tireMarks.ts) and the smoke
 * (tireSmoke.ts). The sim's `WheelState.skid` is how far past the grip peak
 * a tire's slip vector is, whichever way it slides, so one number covers a
 * drift, a locked wheel under braking and a spinning driven axle (a burnout
 * on the grid, a clutch kick); the axle's spin share then decides how much
 * of that is smoke, since a tire spinning against the road boils off far
 * more than one scrubbing sideways. Marks are laid for every car (a strip per
 * wheel, extended from where it ended last tick), smoke only near the camera.
 * Render only: never writes to the sim.
 */
import * as THREE from 'three';
import type { RaceCar } from '../../sim/race';
import type { World } from '../../city/world';
import { TIRE_MARKS, TireMarks, type TireMarkQuality } from './tireMarks';
import { TIRE_SMOKE, TireSmoke } from './tireSmoke';

export const TIRE_FX = {
  /** WheelState.skid where a tire starts leaving rubber, and where the mark is as dark as it gets. */
  skidMin: 0.2,
  skidFull: 0.9,
  /** A strip grows by one quad once the contact has moved this far (m); a jump over maxStep (a reset, a tow) starts a new strip. */
  minStep: 0.05,
  maxStep: 3,
  /**
   * Spinning in place (a burnout) does not move the contact: a stamp this long (m) is laid along the
   * tire every stampPeriod (s) while the axle spins past stampSpin, so the patch still darkens.
   */
  stampLength: 0.32,
  stampPeriod: 0.12,
  stampSpin: 0.4,
  /** Only cars this close to the camera smoke (m). */
  smokeRange: 140,
  /** Puffs per second per wheel at full strength at Medium (scaled by the pool), and the least slide or spin that smokes. */
  puffsPerSecond: 34,
  smokeSpeed: 1,
  smokeSpin: 0.3,
  /** Smoke strength: the slide's share plus this much per unit of axle spin (a burnout well past a scrub). */
  spinSmoke: 0.9,
  /** Puffs leave with this share of the car's velocity, thrown back along the tire by its spin (m/s per unit spin), plus a scatter (m/s). */
  carry: 0.35,
  throwBack: 2.5,
  spread: 0.8,
} as const;

/** Surfaces rubber shows on, with how light the mark reads there (0 asphalt .. 1 concrete). */
const MARK_TINT: Partial<Record<string, number>> = { road: 0, cobble: 0.15, concrete: 1, sidewalk: 0.9 };

/** One wheel's strip and smoke state between ticks. */
interface WheelTrack {
  /** The strip's last edge, left and right points (m), valid while laying. */
  al: THREE.Vector3;
  ar: THREE.Vector3;
  laying: boolean;
  /** Time (s) spent spinning in place since the last stamp. */
  stamp: number;
  /** Fractional puffs carried to the next tick. */
  puffs: number;
}

const F = new THREE.Vector3();
const L = new THREE.Vector3();
const C = new THREE.Vector3();
const BL = new THREE.Vector3();
const BR = new THREE.Vector3();
const SL = new THREE.Vector3();
const SR = new THREE.Vector3();

export class TireFx {
  readonly marks: TireMarks;
  readonly smoke: TireSmoke;
  readonly meshes: THREE.Mesh[];
  private tracks: WheelTrack[][] = [];
  private readonly puffScale: number;
  private readonly lift: number;

  /** `roadLift` is the asphalt's height over the sim's ground (m; cityMeshes ROAD_Y). */
  constructor(quality: TireMarkQuality, roadLift: number) {
    this.marks = new TireMarks(quality);
    this.smoke = new TireSmoke(quality);
    this.meshes = [this.marks.mesh, this.smoke.mesh];
    this.puffScale = (TIRE_SMOKE.pool[quality] ?? TIRE_SMOKE.pool.medium) / TIRE_SMOKE.pool.medium;
    this.lift = roadLift + TIRE_MARKS.lift;
  }

  /** Once per sim tick (dt s), after the step: lay this tick's rubber and smoke for every car; (camX, camZ) is the camera. */
  tick(cars: readonly RaceCar[], world: World, camX: number, camZ: number, time: number, dt: number): void {
    const cam2 = TIRE_FX.smokeRange * TIRE_FX.smokeRange;
    for (let ci = 0; ci < cars.length; ci++) {
      const rc = cars[ci];
      const c = rc.state;
      let tracks = this.tracks[ci];
      if (!tracks) {
        tracks = [0, 1, 2, 3].map(() => ({ al: new THREE.Vector3(), ar: new THREE.Vector3(), laying: false, stamp: 0, puffs: 0 }));
        this.tracks[ci] = tracks;
      }
      const near = (c.x - camX) ** 2 + (c.z - camZ) ** 2 < cam2;
      const tint = MARK_TINT[c.surface];
      F.set(Math.sin(c.yaw), 0, Math.cos(c.yaw));
      L.set(F.z, 0, -F.x);
      const geo = rc.tuning.geometry;
      for (let i = 0; i < 4; i++) {
        const w = c.wheels[i];
        const tr = tracks[i];
        const spin = i < 2 ? c.spinFront : c.spinRear;
        const intensity = w.contact ? Math.min(1, Math.max(0, (w.skid - TIRE_FX.skidMin) / (TIRE_FX.skidFull - TIRE_FX.skidMin))) : 0;
        if (intensity <= 0) {
          tr.laying = false;
          tr.stamp = 0;
          tr.puffs = 0;
          continue;
        }
        const [wv, , wu] = geo.wheels[i];
        C.set(c.x + F.x * wu + L.x * wv, 0, c.z + F.z * wu + L.z * wv);
        C.y = world.heightAt(C.x, C.z) + this.lift;

        // ---- marks ----
        if (tint === undefined) tr.laying = false;
        else {
          const half = TIRE_MARKS.width / 2;
          if (!tr.laying) {
            // Across the motion, or across the car when standing still.
            if (c.speed > 0.5) SL.set(c.vz, 0, -c.vx).multiplyScalar(1 / c.speed);
            else SL.copy(L);
            tr.al.copy(C).addScaledVector(SL, half);
            tr.ar.copy(C).addScaledVector(SL, -half);
            tr.laying = true;
            tr.stamp = 0;
          } else {
            const mx = C.x - (tr.al.x + tr.ar.x) * 0.5;
            const mz = C.z - (tr.al.z + tr.ar.z) * 0.5;
            const step = Math.sqrt(mx * mx + mz * mz);
            if (step > TIRE_FX.maxStep) {
              tr.laying = false;
            } else if (step >= TIRE_FX.minStep) {
              SL.set(mz / step, 0, -mx / step);
              BL.copy(C).addScaledVector(SL, half);
              BR.copy(C).addScaledVector(SL, -half);
              this.marks.lay(time, tr.al, tr.ar, BL, BR, intensity, tint);
              tr.al.copy(BL);
              tr.ar.copy(BR);
              tr.stamp = 0;
            } else if (spin > TIRE_FX.stampSpin) {
              tr.stamp += dt;
              if (tr.stamp >= TIRE_FX.stampPeriod) {
                tr.stamp = 0;
                const h = TIRE_FX.stampLength / 2;
                SL.copy(C).addScaledVector(F, -h).addScaledVector(L, half);
                SR.copy(C).addScaledVector(F, -h).addScaledVector(L, -half);
                BL.copy(C).addScaledVector(F, h).addScaledVector(L, half);
                BR.copy(C).addScaledVector(F, h).addScaledVector(L, -half);
                this.marks.lay(time, SL, SR, BL, BR, intensity, tint);
              }
            }
          }
        }

        // ---- smoke ----
        if (!near || (c.speed < TIRE_FX.smokeSpeed && spin < TIRE_FX.smokeSpin)) {
          tr.puffs = 0;
          continue;
        }
        const strength = Math.min(1.6, intensity * (0.45 + TIRE_FX.spinSmoke * spin));
        tr.puffs += TIRE_FX.puffsPerSecond * this.puffScale * strength * dt;
        const n = Math.floor(tr.puffs);
        if (n > 0) {
          tr.puffs -= n;
          const back = TIRE_FX.throwBack * spin + 0.6;
          this.smoke.emit(time, C.x, C.y + 0.1, C.z, c.vx * TIRE_FX.carry - F.x * back, 0.4, c.vz * TIRE_FX.carry - F.z * back, TIRE_FX.spread + 0.6 * intensity, n, Math.min(1, strength));
        }
      }
    }
  }

  /** Once per frame: advance the clocks and upload what the ticks since the last frame laid. */
  update(time: number): void {
    this.marks.update(time);
    this.smoke.update(time);
  }

  dispose(): void {
    this.marks.dispose();
    this.smoke.dispose();
  }
}
