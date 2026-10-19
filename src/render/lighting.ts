/**
 * Night lighting: dark blue ambient, a faint moon, and a small pool of real
 * point lights that follows the focus point (the player's car), snapping to
 * the nearest streetlights. Everything else is emissive or faked in lightFx.
 */
import * as THREE from 'three';

export const FOG_COLOR = 0x0a0b1c;
export const FOG_DENSITY = 0.0042;

export class NightLighting {
  readonly group = new THREE.Group();
  private pool: THREE.PointLight[] = [];
  private lamps: THREE.Vector3[] = [];
  private frame = 0;

  constructor() {
    this.group.name = 'lighting';
    const hemi = new THREE.HemisphereLight(0x3a4a9a, 0x0b0b14, 0.4);
    this.group.add(hemi);
    const moon = new THREE.DirectionalLight(0x7f8cff, 0.35);
    moon.position.set(-200, 400, 120);
    this.group.add(moon);
  }

  setLamps(lamps: THREE.Vector3[]): void {
    this.lamps = lamps;
    this.frame = 0;
  }

  /** Changing the light count recompiles shaders, so only do it on quality change. */
  setPoolSize(n: number): void {
    while (this.pool.length > n) {
      const l = this.pool.pop()!;
      this.group.remove(l);
      l.dispose();
    }
    while (this.pool.length < n) {
      const l = new THREE.PointLight(0xffb36b, 140, 30, 1.7);
      this.pool.push(l);
      this.group.add(l);
    }
  }

  update(focus: THREE.Vector3): void {
    if (this.pool.length === 0 || this.lamps.length === 0) return;
    // Re-pick nearest lamps a few times per second; cheap linear scan.
    if (this.frame++ % 8 !== 0) return;
    const n = this.pool.length;
    const best: { d: number; i: number }[] = [];
    for (let i = 0; i < this.lamps.length; i++) {
      const p = this.lamps[i];
      const d = (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2;
      if (best.length < n || d < best[best.length - 1].d) {
        best.push({ d, i });
        best.sort((a, b) => a.d - b.d);
        if (best.length > n) best.pop();
      }
    }
    best.forEach((b, k) => this.pool[k].position.copy(this.lamps[b.i]));
  }
}
