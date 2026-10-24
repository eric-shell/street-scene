/**
 * The two-post lifts and what hangs over the bays: the lift with its
 * posts, arms and carriages fitted to a car's measurements, the fluorescent
 * battens on their chains, and the roof trusses with their pipe runs. Render
 * only; garage/showroom.ts places them.
 */
import type { Kit, Vec } from './kit';

/** A car's measurements a lift needs (m). */
export interface LiftFit {
  width: number;
  length: number;
  wheelbase: number;
}

/**
 * A two-post lift with the car's ground at height h, the car along local z:
 * base plates, posts with the hazard band and lock ladders, the overhead beam
 * with its safety bar and LED bars,
 * carriages, four swing arms to pads under the sills and the power unit.
 * With `move`, the carriages, arms and pads go into that kit instead, at
 * height 0 in the same frame, so the showroom can raise and lower them.
 * Returns the lift's half extents across (x) and along (z), for the camera.
 */
export function lift(k: Kit, x: number, z: number, yaw: number, h: number, car: LiftFit, move?: Kit): [number, number] {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const mk = move ?? k;
  mk.place(x, 0, z, yaw);
  const mh = move ? 0 : h;
  const px = car.width / 2 + 0.42;
  for (const s of [-1, 1]) {
    const sx = s * px;
    k.box(m.steel, 0.62, 0.025, 0.78, sx, 0.012, 0);
    k.box(m.lift, 0.3, 3.9, 0.34, sx, 1.975, 0);
    k.box(m.steel, 0.1, 3.7, 0.08, sx - s * 0.16, 1.95, 0);
    k.box(m.galv, 0.04, 3.3, 0.05, sx - s * 0.13, 1.95, 0.13);
    k.box(m.yellow, 0.31, 0.3, 0.35, sx, 0.17, 0);
    for (const y of [0.09, 0.21]) k.box(m.black, 0.315, 0.05, 0.355, sx, y, 0);
    // Carriage at the arms' height, arms swung under the sills.
    mk.box(m.lift, 0.2, 0.72, 0.42, sx - s * 0.24, mh + 0.36, 0);
    for (const e of [-1, 1]) {
      const pad: Vec = [s * (car.width / 2 - 0.4), mh, e * (car.wheelbase / 2 - 0.45)];
      mk.bar(m.lift, [sx - s * 0.3, mh, e * 0.16], pad, 0.13, 0.08);
      mk.cyl(m.rubber, 0.085, 0.07, pad[0], mh + 0.055, pad[2], 'y', 12);
      mk.cyl(m.yellow, 0.06, 0.03, pad[0], mh + 0.03, pad[2], 'y', 10);
    }
  }
  k.box(m.lift, 2 * px + 0.3, 0.2, 0.26, 0, 4.0, 0);
  k.box(m.yellow, 0.5, 0.06, 0.27, 0, 3.86, 0);
  // LED bars under the beam either side of the safety bar, lighting down onto the car.
  for (const s of [-1, 1]) k.box(m.tube, px - 0.45, 0.016, 0.05, s * (px / 2 + 0.2), 3.892, 0);
  k.cyl(m.rubber, 0.016, 2 * px, 0, 3.86, -0.15, 'x', 6);
  // The power unit on the right post: motor, reservoir, a red button, its hose up the post.
  k.cyl(m.steel, 0.11, 0.34, px + 0.3, 1.45, 0.05);
  k.box(m.black, 0.18, 0.4, 0.18, px + 0.3, 1.06, 0.05);
  k.box(m.red, 0.05, 0.05, 0.04, px + 0.3, 1.2, 0.16);
  k.hose(m.rubber, [[px + 0.3, 0.86, 0.05], [px + 0.22, 0.5, 0.18], [px + 0.15, 0.6, 0.2], [px + 0.15, 3.4, 0.2], [px - 0.1, 3.86, -0.15]], 0.015, 32);
  return [px + 0.25, Math.max(car.length / 2 + 0.15, 0.5)];
}

/**
 * A twin-tube fluorescent batten hung on chains at height y, along local x:
 * housing, reflector, tubes ('lit', 'off' or the stuttering 'flicker'), two
 * chains up to the roof at `roof`.
 */
export function batten(k: Kit, x: number, y: number, z: number, yaw: number, len: number, state: 'lit' | 'off' | 'flicker', roof: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.galv, len, 0.05, 0.2, 0, y + 0.03, 0);
  k.box(m.steel, len + 0.04, 0.03, 0.06, 0, y + 0.07, 0);
  const mat = state === 'lit' ? m.tube : state === 'flicker' ? m.tubeFlicker : m.tubeOff;
  for (const dz of [-0.05, 0.05]) k.cyl(mat, 0.019, len - 0.06, 0, y - 0.015, dz, 'x', 8);
  for (const dx of [-len * 0.4, len * 0.4]) k.bar(m.steel, [dx, y + 0.08, 0], [dx, roof, 0], 0.012);
}

/**
 * The roof: corrugated deck, steel trusses across the room every few meters
 * (chords, verticals, diagonals), purlins along it, and a conduit and an air
 * line running the length of it.
 */
export function roof(k: Kit, half: number, height: number): void {
  const m = k.m;
  k.place();
  k.plane(m.deck, 2 * half, 2 * half, 0, height, 0, 0, Math.PI / 2);
  const low = height - 0.75;
  for (let z = -half + 3; z < half - 1; z += 4.5) {
    k.box(m.steel, 2 * half, 0.14, 0.12, 0, low, z);
    k.box(m.steel, 2 * half, 0.12, 0.1, 0, height - 0.08, z);
    for (let x = -half + 1.5; x < half; x += 1.5) {
      k.box(m.steel, 0.06, 0.62, 0.06, x, (low + height) / 2, z);
      k.bar(m.steel, [x, low, z], [x + 1.5, height - 0.1, z], 0.05);
    }
  }
  for (let x = -half + 2; x < half; x += 3) k.box(m.rust, 0.1, 0.14, 2 * half, x, height - 0.2, 0);
  k.cyl(m.galv, 0.03, 2 * half, half - 0.6, height - 0.45, 0, 'z', 8);
  k.cyl(m.yellow, 0.025, 2 * half, half - 0.8, height - 0.45, 0, 'z', 8);
  k.cyl(m.galv, 0.035, 2 * half, 0, height - 0.95, -half + 0.5, 'x', 8);
}
