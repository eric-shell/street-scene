/**
 * `nearestCars`: picks the few cars a people shader reacts to (the planning half of the placer is city/people/placer.ts,
 * which the sim reads). Pure apart from the structural vector type, no three.js. Render only.
 */

/** Anything with a vec4 setter (a THREE.Vector4) so this file stays free of three.js. */
export interface Vec4Like {
  set(x: number, y: number, z: number, w: number): unknown;
}

/**
 * The n cars nearest (lx, lz) by repeated selection (ten cars at most, no allocation), written into out[0..n) as
 * (x, z, yaw, speed), the layout of the people shaders' `uCars`; missing ones as a far-away car.
 */
export function nearestCars(cars: readonly { x: number; z: number; yaw: number; speed: number }[], lx: number, lz: number, n: number, out: readonly Vec4Like[]): void {
  let taken = 0;
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < cars.length && k < 31; k++) {
      if (taken & (1 << k)) continue;
      const d = (cars[k].x - lx) ** 2 + (cars[k].z - lz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      taken |= 1 << best;
      const c = cars[best];
      out[i].set(c.x, c.z, c.yaw, c.speed);
    } else out[i].set(1e6, 1e6, 0, 0);
  }
}
