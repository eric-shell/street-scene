/**
 * The soft key light that rides above and behind the player's car so it reads
 * clearly at night: the same light in a race (game/session.ts) and behind the
 * menu (game/streetStage.ts). One real point light; every lit pixel near the
 * car pays for it, so there is only ever the one.
 */
import * as THREE from 'three';

/** Its color, intensity, reach (m) and decay, and where it hangs: this far behind the car and above it (m). */
const KEY = { color: 0xdfe6ff, intensity: 9, distance: 9, decay: 1.6, back: 1.5, up: 4.2 } as const;

export class KeyLight extends THREE.PointLight {
  constructor() {
    super(KEY.color, KEY.intensity, KEY.distance, KEY.decay);
  }

  /** Hang it over a car at this pose (m, yaw in rad). */
  follow(p: { x: number; y: number; z: number; yaw: number }): void {
    this.position.set(p.x - Math.sin(p.yaw) * KEY.back, p.y + KEY.up, p.z - Math.cos(p.yaw) * KEY.back);
  }
}
