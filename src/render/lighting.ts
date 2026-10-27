/**
 * Night lighting: dark blue ambient, a faint moon, and a small pool of real
 * point lights that follows the focus point (the player's car), snapping to
 * the nearest lamps (streetlights, park and market lamps, the expressway's)
 * on the level the car is on. Everything else is emissive or faked in lightFx.
 *
 * Lights fade with their distance relative to the first lamp that missed the
 * pool, so when the nearest set changes the light that hops from one lamp to
 * another is already dark: no visible pop on the road or the cars.
 */
import * as THREE from 'three';
import type { Quality } from '../ui/settings';

/**
 * Fog of a clear night: the defaults every self-fogging shader starts from.
 * The weather (render/sky/weather.ts) picks a mood per seed and retunes the scene
 * fog and those shaders' fog uniforms to match.
 */
export const FOG_COLOR = 0x0a0b1c;
export const FOG_DENSITY = 0.0042;

/**
 * The player's real lights per graphics tier, fixed when a race (or the menu stage) is built: a light-count change
 * recompiles every lit program, so it never follows auto quality mid-race. Each light is paid by every lit pixel.
 * Low drops to one centred headlight spot and no underglow light; Medium keeps both spots; High adds the underglow.
 * The headlight and underglow glows on the road (beam pool, ground plane) are meshes and stay on every tier.
 */
export const LIGHT_RIG: Record<Quality, { headlightSpots: 0 | 1 | 2; underglowLight: boolean; keyLight: boolean }> = {
  low: { headlightSpots: 1, underglowLight: false, keyLight: true },
  medium: { headlightSpots: 2, underglowLight: false, keyLight: true },
  high: { headlightSpots: 2, underglowLight: true, keyLight: true },
};

/** Mood lighting: hemisphere sky colour and intensity, moon light intensity (weather.ts). */
export interface MoodLighting {
  hemi: number;
  hemiIntensity: number;
  moonLight: number;
}

/** A clear night's mood until the weather sets one, and where the moon light sits outside a lightning flash. */
const DEFAULT_MOOD: MoodLighting = { hemi: 0x3a4a9a, hemiIntensity: 0.4, moonLight: 0.35 };
const MOON_HOME = new THREE.Vector3(-200, 400, 120);
/** The point light of a sodium lamp (the colour every lamp had before neighbourhoods chose their own). */
const SODIUM_LIGHT = new THREE.Color(0xffb36b);
/** How often the pool re-picks its nearest lamps (ms; eight frames at 60 fps). */
const REPICK_MS = (8 * 1000) / 60;

/**
 * A lamp's pick distance from the focus, squared (m²): across the ground, plus a penalty for a lamp
 * between 3 and 25 m below it (the street under the expressway's deck, seen from a car up on it) or more
 * than 10 m above it (the deck's lamps, seen from the street beneath), neither of which lights the road
 * the car is on. A drone high over the city has every lamp more than 25 m below it: no penalty.
 */
function reach2(p: THREE.Vector3, f: THREE.Vector3): number {
  const dy = p.y - f.y;
  const pen = dy < -3 && dy > -25 ? 6 * (-dy - 3) : dy > 10 ? 3 * (dy - 10) : 0;
  return (p.x - f.x) ** 2 + (p.z - f.z) ** 2 + pen * pen;
}

export class NightLighting {
  readonly group = new THREE.Group();
  private pool: THREE.PointLight[] = [];
  private lamps: THREE.Vector3[] = [];
  /** Colour of each lamp's light, parallel to `lamps` (missing: sodium amber). */
  private colors: readonly THREE.Color[] = [];
  /** Lamp index lit by each pool light, -1 for none. */
  private assigned: number[] = [];
  /** Distance to the nearest lamp outside the pool. */
  private cutoff = Infinity;
  /** When the pool next re-picks its lamps (performance.now ms; 0 picks on the next update). */
  private nextPick = 0;
  /** Scratch for the re-pick: the nearest lamps' squared distances and indices, nearest first. */
  private readonly bestD: number[] = [];
  private readonly bestI: number[] = [];
  private readonly want = new Set<number>();
  private readonly free: number[] = [];
  private readonly incoming: number[] = [];
  private static readonly INTENSITY = 140;
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;
  /** The mood a lightning flash adds on top of. */
  private mood: MoodLighting = { ...DEFAULT_MOOD };
  private readonly flashSky = new THREE.Color(0xc4d0ff);
  private flashing = false;

  constructor() {
    this.group.name = 'lighting';
    this.hemi = new THREE.HemisphereLight(DEFAULT_MOOD.hemi, 0x0b0b14, DEFAULT_MOOD.hemiIntensity);
    this.group.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x7f8cff, DEFAULT_MOOD.moonLight);
    this.moon.position.copy(MOON_HOME);
    this.group.add(this.moon);
  }

  /** The weather mood: an overcast sky lights everything a little flatter and the moon fades. */
  setMood(m: MoodLighting): void {
    // In place: the weather retunes this every frame of a turn, so no allocation.
    this.mood.hemi = m.hemi;
    this.mood.hemiIntensity = m.hemiIntensity;
    this.mood.moonLight = m.moonLight;
    this.hemi.color.setHex(m.hemi);
    this.hemi.intensity = m.hemiIntensity;
    this.moon.intensity = m.moonLight;
  }

  /**
   * Lightning (render/sky/lightning.ts): `level` 0..1 lifts the sky light by
   * `hemi` (intensity) toward a cold white and swings the moon light round
   * to come from the strike's direction (unit x, z) at `key` extra
   * intensity. Light intensities only, so no shader recompiles; level 0
   * puts the mood back exactly.
   */
  flash(level: number, dirX: number, dirZ: number, hemi: number, key: number): void {
    if (level <= 0) {
      if (!this.flashing) return;
      this.flashing = false;
      this.setMood(this.mood);
      this.moon.position.copy(MOON_HOME);
      return;
    }
    this.flashing = true;
    this.hemi.color.setHex(this.mood.hemi).lerp(this.flashSky, Math.min(1, level) * 0.6);
    this.hemi.intensity = this.mood.hemiIntensity + hemi * level;
    this.moon.intensity = this.mood.moonLight + key * level;
    this.moon.position.set(dirX * 400, 520, dirZ * 400);
  }

  /** The lamps the pool may pick, and (parallel) the colour each one burns; lamps without one are sodium amber. */
  setLamps(lamps: THREE.Vector3[], colors: readonly THREE.Color[] = []): void {
    this.lamps = lamps;
    this.colors = colors;
    this.nextPick = 0;
    this.assigned = this.pool.map(() => -1);
  }

  get poolSize(): number {
    return this.pool.length;
  }

  /** Changing the light count recompiles shaders, so only do it on quality change. */
  setPoolSize(n: number): void {
    while (this.pool.length > n) {
      const l = this.pool.pop()!;
      this.group.remove(l);
      l.dispose();
    }
    while (this.pool.length < n) {
      const l = new THREE.PointLight(SODIUM_LIGHT, 0, 30, 1.7);
      this.pool.push(l);
      this.group.add(l);
    }
    this.assigned = this.pool.map(() => -1);
    this.nextPick = 0;
  }

  update(focus: THREE.Vector3): void {
    if (this.pool.length === 0) return;
    if (this.lamps.length === 0) {
      for (const l of this.pool) l.intensity = 0;
      return;
    }
    const n = this.pool.length;
    // Re-pick nearest lamps a few times per second (on a clock, so every frame rate picks as often); a cheap
    // linear scan keeping the n + 1 nearest in order (ties in lamp order).
    const now = performance.now();
    if (now >= this.nextPick) {
      this.nextPick = now + REPICK_MS;
      const { bestD, bestI, want, free, incoming } = this;
      bestD.length = 0;
      bestI.length = 0;
      for (let i = 0; i < this.lamps.length; i++) {
        const d = reach2(this.lamps[i], focus);
        if (bestD.length <= n || d < bestD[bestD.length - 1]) {
          let at = bestD.length;
          while (at > 0 && bestD[at - 1] > d) at--;
          bestD.splice(at, 0, d);
          bestI.splice(at, 0, i);
          if (bestD.length > n + 1) {
            bestD.pop();
            bestI.pop();
          }
        }
      }
      this.cutoff = bestD.length > n ? Math.sqrt(bestD[n]) : Infinity;
      // Keep lights on lamps that stay in the set; hand the rest the newcomers.
      want.clear();
      for (let k = 0; k < Math.min(n, bestI.length); k++) want.add(bestI[k]);
      free.length = 0;
      for (let k = 0; k < this.assigned.length; k++) {
        const lamp = this.assigned[k];
        if (want.has(lamp)) want.delete(lamp);
        else free.push(k);
      }
      incoming.length = 0;
      for (const lamp of want) incoming.push(lamp);
      for (const k of free) {
        const lamp = incoming.pop() ?? -1;
        this.assigned[k] = lamp;
        if (lamp >= 0) {
          this.pool[k].position.copy(this.lamps[lamp]);
          this.pool[k].color.copy(this.colors[lamp] ?? SODIUM_LIGHT);
        }
      }
    }
    const band = Number.isFinite(this.cutoff) ? Math.max(4, this.cutoff * 0.3) : 1;
    for (let k = 0; k < n; k++) {
      const lamp = this.assigned[k];
      if (lamp < 0) {
        this.pool[k].intensity = 0;
        continue;
      }
      const d = Math.sqrt(reach2(this.lamps[lamp], focus));
      const w = Number.isFinite(this.cutoff) ? Math.max(0, Math.min(1, (this.cutoff - d) / band)) : 1;
      this.pool[k].intensity = NightLighting.INTENSITY * w * w * (3 - 2 * w);
    }
  }
}
