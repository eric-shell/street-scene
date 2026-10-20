/**
 * Night lighting: dark blue ambient, a faint moon, and a small pool of real
 * point lights that follows the focus point (the player's car), snapping to
 * the nearest streetlights. Everything else is emissive or faked in lightFx.
 *
 * Lights fade with their distance relative to the first lamp that missed the
 * pool, so when the nearest set changes the light that hops from one lamp to
 * another is already dark: no visible pop on the road or the cars.
 */
import * as THREE from 'three';

/**
 * Fog of a clear night: the defaults every self-fogging shader starts from.
 * The weather (render/weather.ts) picks a mood per seed and retunes the scene
 * fog and those shaders' fog uniforms to match.
 */
export const FOG_COLOR = 0x0a0b1c;
export const FOG_DENSITY = 0.0042;

/** Mood lighting: hemisphere sky colour and intensity, moon light intensity (weather.ts). */
export interface MoodLighting {
  hemi: number;
  hemiIntensity: number;
  moonLight: number;
}

export class NightLighting {
  readonly group = new THREE.Group();
  private pool: THREE.PointLight[] = [];
  private lamps: THREE.Vector3[] = [];
  /** Lamp index lit by each pool light, -1 for none. */
  private assigned: number[] = [];
  /** Distance to the nearest lamp outside the pool. */
  private cutoff = Infinity;
  private frame = 0;
  private static readonly INTENSITY = 140;
  private readonly hemi: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;

  constructor() {
    this.group.name = 'lighting';
    this.hemi = new THREE.HemisphereLight(0x3a4a9a, 0x0b0b14, 0.4);
    this.group.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x7f8cff, 0.35);
    this.moon.position.set(-200, 400, 120);
    this.group.add(this.moon);
  }

  /** The weather mood: an overcast sky lights everything a little flatter and the moon fades. */
  setMood(m: MoodLighting): void {
    this.hemi.color.setHex(m.hemi);
    this.hemi.intensity = m.hemiIntensity;
    this.moon.intensity = m.moonLight;
  }

  setLamps(lamps: THREE.Vector3[]): void {
    this.lamps = lamps;
    this.frame = 0;
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
      const l = new THREE.PointLight(0xffb36b, 0, 30, 1.7);
      this.pool.push(l);
      this.group.add(l);
    }
    this.assigned = this.pool.map(() => -1);
    this.frame = 0;
  }

  update(focus: THREE.Vector3): void {
    if (this.pool.length === 0) return;
    if (this.lamps.length === 0) {
      for (const l of this.pool) l.intensity = 0;
      return;
    }
    const n = this.pool.length;
    // Re-pick nearest lamps a few times per second; cheap linear scan.
    if (this.frame++ % 8 === 0) {
      const best: { d: number; i: number }[] = [];
      for (let i = 0; i < this.lamps.length; i++) {
        const p = this.lamps[i];
        const d = (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2;
        if (best.length <= n || d < best[best.length - 1].d) {
          best.push({ d, i });
          best.sort((a, b) => a.d - b.d);
          if (best.length > n + 1) best.pop();
        }
      }
      this.cutoff = best.length > n ? Math.sqrt(best[n].d) : Infinity;
      // Keep lights on lamps that stay in the set; hand the rest the newcomers.
      const want = new Set(best.slice(0, n).map((b) => b.i));
      const free: number[] = [];
      this.assigned.forEach((lamp, k) => {
        if (want.has(lamp)) want.delete(lamp);
        else free.push(k);
      });
      const incoming = [...want];
      for (const k of free) {
        const lamp = incoming.pop() ?? -1;
        this.assigned[k] = lamp;
        if (lamp >= 0) this.pool[k].position.copy(this.lamps[lamp]);
      }
    }
    const band = Number.isFinite(this.cutoff) ? Math.max(4, this.cutoff * 0.3) : 1;
    for (let k = 0; k < n; k++) {
      const lamp = this.assigned[k];
      if (lamp < 0) {
        this.pool[k].intensity = 0;
        continue;
      }
      const p = this.lamps[lamp];
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      const w = Number.isFinite(this.cutoff) ? Math.max(0, Math.min(1, (this.cutoff - d) / band)) : 1;
      this.pool[k].intensity = NightLighting.INTENSITY * w * w * (3 - 2 * w);
    }
  }
}
