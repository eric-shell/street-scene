import * as THREE from 'three';
import { pointInPolygon } from '../src/city/districts/geom';
import type { Contact, World } from '../src/city/world';
import { createRace, RaceConfig, RaceState, stepRace } from '../src/sim/race';
import { createAi, autopilotInput } from '../src/sim/ai';
import { stockPerformance, PerformanceBuild } from '../src/sim/build';
import { InputFrame, unpackInput } from '../src/sim/input';
import { counterSteerLock, type CarState } from '../src/sim/car';
import { geometryFromManifest, type CarTuning } from '../src/sim/tuning';
import params from '../src/sim/drivingParams.json';

/**
 * The car whose geometry baseTuning() wears and the race configs' player drives: the Coupe, the shipped car closest
 * to the retired Proto RS the scenario tests were written on (4.31 by 1.88 m against 4.36 by 1.82, rear wheel drive
 * like base). The Hatch is 2.04 m wide and clips the level crossing arms and kerbs those tests thread.
 */
export const TEST_CAR = 'kazamaRotor';

/**
 * drivingParams.json's `base` exactly, with no car's overrides, on TEST_CAR's geometry: the tuning the physics
 * tests mean by "a car", so a change to one shipped car's overrides never moves them. Naturally aspirated, as
 * base is (forced induction is a manifest flag, set by getBaseTuning for the real cars).
 */
export function baseTuning(): CarTuning {
  const base = structuredClone(params.base) as unknown as CarTuning;
  return { ...base, carId: TEST_CAR, geometry: geometryFromManifest(TEST_CAR), engine: { ...base.engine, turbo: false } };
}

/** Endless flat parking lot: no walls, road surface everywhere. */
export function flatWorld(): World {
  return {
    heightAt: () => 0,
    driveHeightAt: () => 0,
    slopeAt: () => ({ gx: 0, gz: 0 }),
    surfaceAt: () => 'road',
    collideCircle: (_x: number, _z: number, _r: number, out: unknown[]) => ((out.length = 0), 0),
    collideBox: (_a: number, _b: number, _c: number, _d: number, _e: number, out: unknown[]) => ((out.length = 0), 0),
    wallClearance: (_x: number, _z: number, m: number) => m,
  } as unknown as World;
}

export function raceConfig(seed: number, mode: RaceConfig['mode'], opponents = 3, perf: PerformanceBuild = stockPerformance(), laps = 1): RaceConfig {
  return {
    seed,
    mode,
    laps,
    player: { name: 'Player', carId: TEST_CAR, performance: perf },
    opponents: Array.from({ length: opponents }, (_, i) => ({ name: `AI ${i + 1}`, carId: ['wendtStrom', 'albrechtKombi'][i % 2], performance: stockPerformance() })),
    difficulty: 'medium',
    manualGearbox: false,
  };
}

/** Run a race with the player on autopilot. */
export function runAutopilot(cfg: RaceConfig, maxSeconds: number, untilAllFinished = false): RaceState {
  const r = createRace(cfg);
  const pilot = createAi(0.97);
  const maxTicks = maxSeconds * 60;
  while (r.tick < maxTicks) {
    if (untilAllFinished ? r.cars.every((c) => c.finished) : r.phase === 'finished') break;
    stepRace(r, autopilotInput(r, r.cars[0], pilot));
  }
  return r;
}

export function replayLog(cfg: RaceConfig, log: number[]): RaceState {
  const r = createRace(cfg);
  for (const packed of log) stepRace(r, unpackInput(packed));
  return r;
}

export function carSnapshot(r: RaceState): string {
  return JSON.stringify(r.cars.map((c) => ({ s: c.state, d: c.dist, lap: c.lap, f: c.finished, ft: c.finishTick, lt: c.lapTimes })));
}

/**
 * The stick input that counter steers a slide of `angle` (rad) by wheel angle, as a driver who knows the car
 * does: the front wheels along the direction of travel, plus `extra` rad of lock (less with a negative one),
 * through whatever counter steer mapping the tuning has (counterSteerLock).
 */
export const counterSteer = (t: CarTuning, c: CarState, angle: number, extra = 0): number =>
  Math.max(-1, Math.min(1, (-Math.sign(angle) * Math.max(0, Math.abs(angle) + extra)) / counterSteerLock(t, c.speed, angle || 1e-3)));

export const input = (p: Partial<InputFrame>): InputFrame => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitrous: false, shift: 0, reset: false, antilag: false, ...p });

/** A piece of drawn wall a car can drive through: where, on which merged mesh, and in which district area kind (`street` outside every area). */
export interface Ghost {
  x: number;
  y: number;
  z: number;
  mesh: string;
  kind: string;
}

/**
 * Drawn wall with no sim wall under it: samples every upright triangle of the visible, non-instanced meshes under `group`
 * (the district meshes, hidden subtrees skipped as the renderer skips them) at a car body's height over the ground,
 * and reports the points where a car circle (r 0.7 m) fits at the point and at its four neighbours 0.5 m away in `world`.
 * One entry per 0.5 m cell; water is skipped. Render-only dressing that stands where a car can fit but never goes
 * (the yards) is reported too, so the caller subtracts a baseline: the same scene over the world it is meant for.
 */
export function drawnGhosts(group: THREE.Object3D, world: World): Map<number, Ghost> {
  group.updateMatrixWorld(true);
  const out = new Map<number, Ghost>();
  const contacts: Contact[] = [];
  const free = new Map<number, boolean>();
  const isFree = (i: number, j: number): boolean => {
    const k = i * 100000 + j;
    let v = free.get(k);
    if (v === undefined) {
      v = world.collideCircle(i * 0.5, j * 0.5, 0.7, contacts) === 0;
      free.set(k, v);
    }
    return v;
  };
  const areaKind = (x: number, z: number): string => world.areas.find((a) => pointInPolygon(x, z, a.polygon))?.kind ?? 'street';
  const visit = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) sampleMesh(mesh);
    for (const c of o.children) visit(c);
  };
  const sampleMesh = (mesh: THREE.Mesh): void => {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    if (!pos || !idx) return;
    const m = mesh.matrixWorld;
    const P = new THREE.Vector3();
    const v: number[][] = [[], [], []];
    for (let t = 0; t + 2 < idx.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        P.fromBufferAttribute(pos, idx.getX(t + k)).applyMatrix4(m);
        v[k] = [P.x, P.y, P.z];
      }
      const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
      const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      // Upright faces only: the sides of whatever stands on the ground.
      if (len < 1e-6 || Math.abs(n[1] / len) > 0.4) continue;
      const steps = Math.min(24, Math.max(2, Math.ceil(Math.sqrt(len / 2) / 0.25)));
      for (let s1 = 0; s1 <= steps; s1++) {
        for (let s2 = 0; s2 <= steps - s1; s2++) {
          const w1 = s1 / steps;
          const w2 = s2 / steps;
          const x = v[0][0] + e1[0] * w1 + e2[0] * w2;
          const y = v[0][1] + e1[1] * w1 + e2[1] * w2;
          const z = v[0][2] + e1[2] * w1 + e2[2] * w2;
          const g = world.driveHeightAt(x, z);
          // At a car body's height over the ground.
          if (y < g + 0.25 || y > g + 1.2) continue;
          const i = Math.round(x / 0.5);
          const j = Math.round(z / 0.5);
          const key = i * 100000 + j;
          if (out.has(key) || !isFree(i, j) || !isFree(i + 1, j) || !isFree(i - 1, j) || !isFree(i, j + 1) || !isFree(i, j - 1)) continue;
          if (world.surfaceAt(x, z) === 'water') continue;
          out.set(key, { x, y, z, mesh: mesh.name, kind: areaKind(x, z) });
        }
      }
    }
  };
  visit(group);
  return out;
}
