/**
 * Zone reflection probes: the car reflects the district it is in. At scene
 * build, once everything is added, a few small cubemaps are rendered from the
 * real scene at seeded representative points (downtown street level, the river
 * channel floor, the park or lake, the harbour quay), each 2 m above the
 * ground, and run through PMREM so they light the PBR materials like the
 * static panorama does. Per frame the car's zone (world.areaAt) picks the
 * probe; the swap waits until the car has driven `hysteresisM` into the new
 * zone, so a street crossing a park corner does not flicker.
 *
 * three.js has one `scene.environment`, so the crossfade is a dip: the
 * environment intensity falls to `dip` of itself, the texture swaps at the
 * bottom, and it rises again over `crossfadeS` in all. A two-environment mix
 * would need an onBeforeCompile on every PBR material in the city (every
 * layer reads scene.environment), against ten lines here; at night the
 * reflections are dim and soft, so a 0.75 s dip and recovery reads as the
 * eye adjusting rather than a pop. The weather (wetness) and the lightning own
 * `scene.environmentIntensity`; rather than touching them the scene's property
 * becomes a getter that multiplies whatever they write by the fade, so both
 * keep working unchanged.
 *
 * Low keeps the static panorama (no probes). Render only: nothing here writes
 * the sim, and the bake reads the world once. Nothing allocates per frame.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { Area } from '../city/districts/types';
import type { Quality } from '../ui/settings';
import { Disposer } from './disposer';

/** Probe bake and crossfade numbers. */
export const ENV_PROBES = {
  /** Cube face size per quality tier (px); 0 keeps the static panorama. */
  size: { low: 0, medium: 128, high: 256 } as Record<Quality, number>,
  /** Height of the probe above the ground at its point (m). */
  height: 2,
  /** Whole crossfade, down and back up (s). */
  crossfadeS: 1.5,
  /** Fraction of the environment intensity left at the bottom of the dip. */
  dip: 0.3,
  /** Metres the car must drive into a new zone before the probe swaps (m). */
  hysteresisM: 10,
  /** A car that sits (or was reset) in a new zone swaps after this long even without driving the distance (s). */
  dwellS: 2,
  /** Far plane of the bake cameras (m); the fog and backdrop close the view well before it. */
  far: 1500,
} as const;

/** The zones a probe can stand for. */
type Zone = 0 | 1 | 2 | 3;
const STREET: Zone = 0;
const ZONE_NAMES = ['street', 'river', 'park', 'quay'] as const;

/** Zone of a district area kind (anything not listed is the street). */
function zoneOfKind(kind: Area['kind'] | undefined): Zone {
  switch (kind) {
    case 'river':
      return 1;
    case 'park':
    case 'hills':
    case 'lake':
      return 2;
    case 'waterfront':
      return 3;
    default:
      return STREET;
  }
}

/** Average of an area's polygon (or path) vertices, null when it has none. */
function centroid(a: Area): { x: number; z: number } | null {
  const pts = a.polygon.length > 0 ? a.polygon : a.path;
  if (pts.length === 0) return null;
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  return { x: x / pts.length, z: z / pts.length };
}

/** Where each zone's probe stands (null where the city has no such zone). */
export function probePoints(world: World): ({ x: number; y: number; z: number } | null)[] {
  const out: ({ x: number; y: number; z: number } | null)[] = [null, null, null, null];
  const at = (x: number, z: number, y?: number) => ({ x, y: world.heightAt(x, z, y) + ENV_PROBES.height, z });
  const bounds = world.graph.bounds;
  // Downtown: the route sample nearest the middle of the downtown blocks (the densest part of the city).
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const a of world.areas) {
    if (a.kind !== 'downtown') continue;
    const c = centroid(a);
    if (c) {
      sx += c.x;
      sz += c.z;
      n++;
    }
  }
  const cx = n > 0 ? sx / n : (bounds.minX + bounds.maxX) / 2;
  const cz = n > 0 ? sz / n : (bounds.minZ + bounds.maxZ) / 2;
  let best = Infinity;
  let bi = 0;
  const pts = world.route.points;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - cx) ** 2 + (pts[i].z - cz) ** 2;
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  out[STREET] = pts.length > 0 ? at(pts[bi].x, pts[bi].z) : at(cx, cz);
  // River: the middle of the centerline, down on the channel floor (a very low y asks heightAt for the floor).
  const river = world.areas.find((a) => a.kind === 'river' && a.path.length > 0);
  if (river) {
    const m = river.path[river.path.length >> 1];
    out[1] = at(m.x, m.z, -1000);
  }
  // Park, else the lake.
  const green = world.areas.find((a) => a.kind === 'park' && a.polygon.length > 0) ?? world.areas.find((a) => a.kind === 'lake' && a.polygon.length > 0);
  const gc = green ? centroid(green) : null;
  if (gc) out[2] = at(gc.x, gc.z);
  const quay = world.areas.find((a) => a.kind === 'waterfront' && a.polygon.length > 0);
  const qc = quay ? centroid(quay) : null;
  if (qc) out[3] = at(qc.x, qc.z);
  return out;
}

/** What the bake cost, for the dev log and the build report. */
export interface ProbeStats {
  /** Probes baked. */
  count: number;
  /** Wall time of the whole bake (ms). */
  ms: number;
  /** GPU memory the kept PMREM textures hold (bytes, half float RGBA). */
  bytes: number;
  /** Probe names in bake order. */
  zones: string[];
}

export interface EnvProbes {
  readonly stats: ProbeStats;
  /** Pick the probe for a car (or camera) at (x, z) and advance the crossfade by dt (s); once per frame. */
  update(x: number, z: number, dt: number): void;
  dispose(): void;
}

/** The no-probe form (Low, or a world with nothing to bake): the static panorama stays. */
const NONE: EnvProbes = { stats: { count: 0, ms: 0, bytes: 0, zones: [] }, update() {}, dispose() {} };

/**
 * Bake the probes from the finished scene (call after everything is added, before the first frame).
 * `hide` lists the groups that would bake wrongly (rain streaks that ride the camera, the point
 * lights parked at the origin); they are shown again before it returns.
 */
export function bakeEnvProbes(renderer: THREE.WebGLRenderer, scene: THREE.Scene, world: World, quality: Quality, hide: THREE.Object3D[]): EnvProbes {
  const size = ENV_PROBES.size[quality];
  if (size <= 0) return NONE;
  const points = probePoints(world);
  const disposer = new Disposer();
  const t0 = performance.now();
  const envs: (THREE.Texture | null)[] = [null, null, null, null];
  const was = hide.map((o) => o.visible);
  for (const o of hide) o.visible = false;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(0.3, ENV_PROBES.far, target);
  let bytes = 0;
  const zones: string[] = [];
  try {
    for (let z = 0; z < points.length; z++) {
      const p = points[z];
      if (!p) continue;
      cam.position.set(p.x, p.y, p.z);
      cam.update(renderer, scene);
      const rt = disposer.track(pmrem.fromCubemap(target.texture));
      envs[z] = rt.texture;
      const img = rt.texture.image as { width: number; height: number };
      bytes += img.width * img.height * 8;
      zones.push(ZONE_NAMES[z]);
    }
  } finally {
    target.dispose();
    pmrem.dispose();
    hide.forEach((o, i) => (o.visible = was[i]));
  }
  const stats: ProbeStats = { count: zones.length, ms: performance.now() - t0, bytes, zones };
  if (import.meta.env.DEV) console.info(`[envProbes] ${stats.count} probes (${stats.zones.join(', ')}) at ${size}px: ${stats.ms.toFixed(0)} ms, ${(bytes / 1048576).toFixed(2)} MiB`);

  // The fade: scene.environmentIntensity reads as whatever the weather and lightning wrote, times `gate`.
  let base = scene.environmentIntensity;
  let gate = 1;
  Object.defineProperty(scene, 'environmentIntensity', {
    configurable: true,
    get: () => base * gate,
    set: (v: number) => {
      base = v;
    },
  });
  const panorama = scene.environment;
  let cur: Zone = STREET;
  let primed = false;
  /** Zone the car has entered but not yet driven `hysteresisM` into. */
  let cand: Zone = STREET;
  let candX = 0;
  let candZ = 0;
  /** How long the candidate has held (s). */
  let candT = 0;
  /** Crossfade progress 0..1 (1 = idle) and the zone it fades to. */
  let fade = 1;
  let to: Zone = STREET;
  const fall = (k: Zone): Zone => (envs[k] ? k : STREET);

  return {
    stats,
    update(x, zz, dt) {
      const zone = fall(zoneOfKind(world.areaAt(x, zz)?.kind));
      if (!primed) {
        // First frame: start in the car's zone with no fade.
        primed = true;
        cur = to = cand = zone;
        scene.environment = envs[cur] ?? panorama;
        return;
      }
      if (zone === cur) cand = cur;
      else if (zone !== cand) {
        cand = zone;
        candX = x;
        candZ = zz;
        candT = 0;
      } else if (fade >= 1 && ((candT += dt) >= ENV_PROBES.dwellS || (x - candX) ** 2 + (zz - candZ) ** 2 >= ENV_PROBES.hysteresisM ** 2)) {
        to = zone;
        fade = 0;
      }
      if (fade < 1) {
        const before = fade;
        fade = Math.min(1, fade + dt / ENV_PROBES.crossfadeS);
        // Swap at the bottom of the dip.
        if (before < 0.5 && fade >= 0.5) {
          cur = to;
          scene.environment = envs[cur] ?? panorama;
        }
        const d = Math.abs(fade * 2 - 1);
        gate = ENV_PROBES.dip + (1 - ENV_PROBES.dip) * d * d * (3 - 2 * d);
        if (fade >= 1) gate = 1;
      }
    },
    dispose() {
      Object.defineProperty(scene, 'environmentIntensity', { configurable: true, writable: true, value: base });
      scene.environment = panorama;
      disposer.dispose();
    },
  };
}

