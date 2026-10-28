/**
 * The room's atmosphere and odds and ends: pools of faked light on the floor,
 * the exit sign, the bay numbers, the tuners' banners, number plates, clock,
 * calendar and wall TV, the floor drain, the cleanup corner, traffic cones,
 * space heater, drum fan, beer cooler, and the dyno (the straps that hold its
 * car are separate, so the garage can refit them to the player's car).
 * Render only.
 */
import * as THREE from 'three';
import type { Kit, Vec } from './kit';
import { cellPlane } from './furnishings';
import { BANNERS } from './materials';

/** A pool of faked light on the floor, w along x by d along z (m), turned by yaw. Additive: it only ever brightens. */
export function lightPool(k: Kit, mat: THREE.Material, x: number, z: number, w: number, d: number, yaw = 0): void {
  k.place(x, 0, z, yaw).plane(mat, w, d, 0, 0.012, 0, 0, -Math.PI / 2);
}

/** An exit sign over a door, centered at height y on the wall: the housing, its lit face and the green it throws on the wall. */
export function exitSign(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.enamel, 0.42, 0.18, 0.07, 0, 0, 0.035);
  k.plane(m.exit, 0.36, 0.135, 0, 0, 0.071);
  k.plane(m.poolExit, 1.0, 0.6, 0, 0, 0.003);
}

/** A bay's number painted big on the floor, n 1 to 4, its top toward the lift (yaw 0 reads from +z). */
export function bayNumber(k: Kit, x: number, z: number, yaw: number, n: number): void {
  k.place(x, 0, z, yaw).add(k.m.bayNumbers, cellPlane(0.8, 0.8, n - 1, 4, 0, 1), 0, 0.006, 0, 0, -Math.PI / 2);
}

/** A tuner's cloth banner hung under a truss chord at height `chord`: the rod, its wires, the cloth hanging in a slight wave. */
export function banner(k: Kit, x: number, z: number, yaw: number, chord: number, row: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = 2.2;
  const h = 0.82;
  const top = chord - 0.25;
  // A strip with a wave across it, the cloth sagging between its grommets, showing its row of the atlas.
  const wave = new THREE.PlaneGeometry(w, h, 16, 1);
  const pos = wave.getAttribute('position') as THREE.BufferAttribute;
  const uv = wave.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, Math.sin((pos.getX(i) / w) * Math.PI * 3) * 0.03);
    uv.setY(i, 1 - (row + 1 - uv.getY(i)) / BANNERS.length);
  }
  wave.computeVertexNormals();
  // Printed both sides: a second face turned round so the brand reads the right way from behind too.
  const back = wave.clone();
  k.add(m.banner, wave, 0, top - h / 2, 0);
  k.add(m.banner, back, 0, top - h / 2, -0.002, Math.PI);
  k.cyl(m.galv, 0.012, w + 0.1, 0, top + 0.01, 0, 'x', 6);
  for (const s of [-1, 1]) k.bar(m.steel, [s * (w / 2 - 0.1), top + 0.01, 0], [s * (w / 2 - 0.25), chord, 0], 0.006);
}

/** A row of old number plates nailed to a wall, centered at height y. */
export function plateRow(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.wood, 1.86, 0.24, 0.02, 0, 0, 0.01);
  k.plane(m.plates, 1.8, 0.3, 0, 0, 0.022);
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) k.cyl(m.chrome, 0.006, 0.01, -0.75 + i * 0.3 + s * 0.11, 0.035, 0.025, 'z', 6);
}

/** The shop clock on a wall at height y: the black rim and its face. */
export function wallClock(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.cyl(m.black, 0.17, 0.04, 0, 0, 0.02, 'z', 32);
  k.add(m.clock, new THREE.CircleGeometry(0.15, 32), 0, 0, 0.041);
}

/** The supplier's calendar on its nail at height y. */
export function calendar(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.plane(m.calendar, 0.32, 0.45, 0, 0, 0.004);
  k.cyl(m.chrome, 0.005, 0.02, 0, 0.21, 0.01, 'z', 6);
}

/** A TV on a wall bracket at height y showing `screen`, its cable running down the wall. */
export function wallTv(k: Kit, x: number, y: number, z: number, yaw: number, screen: THREE.Material): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.steel, 0.3, 0.2, 0.08, 0, 0, 0.04);
  k.box(m.black, 1.1, 0.65, 0.05, 0, 0, 0.105);
  k.plane(screen, 1.02, 0.574, 0, 0, 0.131);
  k.hose(m.black, [[0.3, -0.3, 0.06], [0.34, -0.6, 0.02], [0.36, -1.2, 0.015], [0.36, -1.8, 0.015]], 0.008, 16);
}

/** A floor drain: the dark sump under a galvanized grate. */
export function floorDrain(k: Kit, x: number, z: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.box(m.carbon, 0.46, 0.004, 0.46, 0, 0.002, 0);
  for (let i = 0; i < 9; i++) k.box(m.galv, 0.44, 0.008, 0.012, 0, 0.006, -0.2 + i * 0.05);
  for (const s of [-1, 1]) k.box(m.galv, 0.012, 0.008, 0.46, s * 0.22, 0.006, 0);
}

/** A push broom and a floor squeegee leant on the wall behind (local -z), a mop bucket with its wringer beside them. */
export function cleanup(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.bar(m.wood, [-0.15, 0.08, 0.45], [-0.1, 1.45, 0.02], 0.025);
  k.box(m.black, 0.6, 0.06, 0.08, -0.15, 0.08, 0.46, 0.1);
  k.box(m.wood, 0.6, 0.04, 0.07, -0.15, 0.12, 0.46, 0.1);
  k.bar(m.galv, [0.15, 0.05, 0.4], [0.2, 1.4, 0.02], 0.022);
  k.box(m.rubber, 0.5, 0.06, 0.03, 0.15, 0.04, 0.42, -0.1);
  k.box(m.yellow, 0.4, 0.34, 0.36, 0.55, 0.2, 0.45);
  k.box(m.carbon, 0.36, 0.01, 0.32, 0.55, 0.36, 0.45);
  k.box(m.galv, 0.16, 0.16, 0.2, 0.62, 0.45, 0.45);
  k.bar(m.wood, [0.45, 0.3, 0.45], [0.35, 1.3, 0.1], 0.022);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(m.rubber, 0.025, 0.02, 0.55 + sx * 0.16, 0.025, 0.45 + sz * 0.15, 'x', 8);
}

/** A stack of n traffic cones, nested. */
export function cones(k: Kit, x: number, z: number, n: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  for (let i = 0; i < n; i++) {
    const y = i * 0.07;
    k.box(m.black, 0.32, 0.03, 0.32, 0, y + 0.015, 0);
    k.cyl(m.orange, 0.025, 0.46, 0, y + 0.26, 0, 'y', 14, 0.13);
  }
  k.cyl(m.enamel, 0.07, 0.06, 0, (n - 1) * 0.07 + 0.32, 0, 'y', 14, 0.085);
}

/** A space heater facing local +z: the grey case, its coils glowing behind the guard, the warmth on the floor in front. */
export function spaceHeater(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.primer, 0.36, 0.5, 0.24, 0, 0.29, 0);
  k.box(m.black, 0.4, 0.04, 0.3, 0, 0.02, 0);
  for (let i = 0; i < 5; i++) k.box(m.heaterCoil, 0.26, 0.016, 0.01, 0, 0.18 + i * 0.05, 0.115);
  for (let i = 0; i < 7; i++) k.box(m.chrome, 0.006, 0.28, 0.006, -0.12 + i * 0.04, 0.28, 0.125);
  k.box(m.black, 0.14, 0.03, 0.04, 0, 0.56, 0);
  k.place(x, 0, z, yaw).plane(m.poolHeater, 1.6, 1.6, 0, 0.012, 0.55, 0, -Math.PI / 2);
}

/**
 * A drum fan on its cart facing local +z, everything but the blades (the
 * showroom spins those on their own): the cage of staves between two rims,
 * the front guard's spokes and rings, the motor, the frame and wheels. `r` is
 * the drum's radius (m): a shop fan at 0.32, the dyno's giant cooling fan at
 * 0.75. Returns the hub's center in the fan's frame.
 */
export function drumFan(k: Kit, x: number, z: number, yaw: number, r = 0.32): Vec {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const sc = r / 0.32;
  const y = r + 0.23 * sc;
  const depth = 0.24 * sc;
  for (const dz of [-depth / 2, depth / 2]) k.add(m.gunmetal, new THREE.TorusGeometry(r, 0.02 * sc, 6, 40), 0, y, dz);
  const n = Math.round(16 * sc);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.box(m.gunmetal, ((Math.PI * 2 * r) / n) * 0.9, 0.012 * sc, depth, Math.cos(a) * r, y + Math.sin(a) * r, 0, 0, 0, a + Math.PI / 2);
  }
  const spokes = sc > 1.5 ? 12 : 8;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    k.bar(m.chrome, [0, y, depth / 2 + 0.01], [Math.cos(a) * r, y + Math.sin(a) * r, depth / 2 + 0.01], 0.006 * Math.sqrt(sc));
  }
  for (const rr of sc > 1.5 ? [0.2, 0.38, 0.56] : [0.12, 0.22]) k.add(m.chrome, new THREE.TorusGeometry(rr * (sc > 1.5 ? 1 : sc), 0.004 * Math.sqrt(sc), 4, 36), 0, y, depth / 2 + 0.01);
  k.cyl(m.black, 0.08 * sc, 0.16 * sc, 0, y, -depth / 2 + 0.02, 'z', 14);
  for (const s of [-1, 1]) {
    k.box(m.steel, 0.03 * sc, y + 0.07 * sc, 0.04 * sc, s * (r + 0.06 * sc), (y + 0.07 * sc) / 2, -0.02);
    k.cyl(m.steel, 0.03 * sc, 0.04, s * (r + 0.04 * sc), y, 0, 'x', 10);
    k.cyl(m.rubber, 0.06 * sc, 0.04 * sc, s * (r + 0.06 * sc), 0.06 * sc, -0.15 * sc, 'x', 12);
  }
  k.box(m.steel, 2 * r + 0.16 * sc, 0.03 * sc, 0.04 * sc, 0, 0.08 * sc, -0.02);
  return [0, y, 0.02];
}

/**
 * A glass door beer cooler against the wall behind it (local -z): the black
 * cabinet, its lit header, the bright interior with shelves of cans and
 * bottles behind the glass, the handle, and the COLD BEER sign on the wall
 * over it, with a little of its light on the floor in front.
 */
export function beerCooler(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = 0.62;
  const d = 0.6;
  const h = 1.9;
  const t = 0.04;
  // The cabinet: sides, top, kick, the back panel lit from inside.
  for (const sx of [-1, 1]) k.box(m.black, t, h, d, sx * (w / 2 - t / 2), h / 2, 0);
  k.box(m.black, w, 0.24, d, 0, h - 0.12, 0);
  k.box(m.black, w, 0.1, d, 0, 0.05, 0);
  k.box(m.black, w - 2 * t, h - 0.34, t, 0, (h - 0.34) / 2 + 0.1, -d / 2 + t / 2);
  k.plane(m.coolerLight, w - 2 * t, h - 0.36, 0, (h - 0.34) / 2 + 0.1, -d / 2 + t + 0.002);
  k.plane(m.coolerLight, w - 0.1, 0.12, 0, h - 0.12, d / 2 + 0.002);
  // Shelves of cans, two deep, and bottles on the top shelf.
  const cans = [m.red, m.blue, m.enamel, m.yellow, m.red, m.black];
  [0.12, 0.48, 0.84, 1.2].forEach((y, si) => {
    k.box(m.galv, w - 2 * t, 0.012, d - 0.1, 0, y, 0);
    for (let row = 0; row < 2; row++)
      for (let i = 0; i < 7; i++) {
        const cx = -w / 2 + t + 0.04 + i * 0.075;
        const cz = 0.08 - row * 0.12;
        if (si === 3) {
          k.cyl(m.orange, 0.028, 0.2, cx, y + 0.106, cz, 'y', 8);
          k.cyl(m.orange, 0.011, 0.07, cx, y + 0.24, cz, 'y', 6);
        } else k.cyl(cans[(i + row * 2 + si * 3) % cans.length], 0.032, 0.12, cx, y + 0.066, cz, 'y', 10);
      }
  });
  // The glass door in its frame, the handle.
  k.plane(m.glass, w - 0.06, h - 0.36, 0, (h - 0.34) / 2 + 0.1, d / 2 + 0.004);
  for (const sx of [-1, 1]) k.box(m.black, 0.03, h - 0.34, 0.02, sx * (w / 2 - 0.015), (h - 0.34) / 2 + 0.1, d / 2 + 0.01);
  k.box(m.black, w, 0.03, 0.02, 0, 0.115, d / 2 + 0.01);
  k.box(m.chrome, 0.025, 0.6, 0.03, w / 2 - 0.06, 1.0, d / 2 + 0.03);
  // The sign over it, its light on the floor.
  k.box(m.black, 0.76, 0.4, 0.03, 0, h + 0.36, -d / 2 + 0.015);
  k.plane(m.beerSign, 0.72, 0.36, 0, h + 0.36, -d / 2 + 0.032);
  k.plane(m.poolTube, 1.4, 1.2, 0, 0.012, d / 2 + 0.45, 0, -Math.PI / 2);
}

/** What the dyno needs of the car strapped to it (m, car space): its length and width, the rear axle's z and the wheels' track. */
export interface DynoFit {
  length: number;
  width: number;
  rearZ: number;
  frontZ: number;
  track: number;
}

/** The dyno deck (m): its height, its width and the length of the roller pit across it. */
export const DYNO_DECK = { height: 0.22, width: 2.6, pit: 0.8 } as const;

/** Half the deck's length (m) for a customer car of this length: the car's own plus a ramp's reach at each end. */
export const dynoHalf = (carLength: number): number => carLength / 2 + 0.55;

/** What the straps need of the car they hold (m, car space): its length and width, and where its origin sits along the dyno's z. */
export interface StrapFit {
  length: number;
  width: number;
  /** The car's origin along the dyno's z (m): 0 for the customer's car, the offset that puts the player's driven axle on the drum otherwise. */
  z: number;
}

/**
 * Four ratchet straps from the deck's corners to the car's tow points, each with
 * its ratchet and an anchor plate, in the dyno frame at (x, z) turned by yaw.
 * Apart from `dyno()` so the showroom builds them as a small group of their
 * own and swaps in straps cut for the player's car while it sits there; the
 * anchors stay on the deck (`half`, its half length), only the car end moves.
 */
export function dynoStraps(k: Kit, x: number, z: number, yaw: number, car: StrapFit, half: number): void {
  const m = k.m;
  const deck = DYNO_DECK.height;
  const w = DYNO_DECK.width;
  k.place(x, 0, z, yaw);
  for (const s of [-1, 1])
    for (const e of [-1, 1]) {
      const a: Vec = [s * (w / 2 - 0.12), deck + 0.02, e * (half - 0.15)];
      const b: Vec = [s * (car.width / 2 - 0.35), deck + 0.22, car.z + e * (car.length / 2 - 0.3)];
      k.bar(m.yellow, a, b, 0.04, 0.006);
      k.box(m.black, 0.05, 0.06, 0.09, (a[0] * 2 + b[0]) / 3, (a[1] * 2 + b[1]) / 3 + 0.02, (a[2] * 2 + b[2]) / 3);
      k.box(m.steel, 0.08, 0.02, 0.08, a[0], deck + 0.005, a[2]);
    }
}

/**
 * A roller dyno with the car's ground at its deck, the car along local +z:
 * the steel deck in two halves either side of the roller pit, the drum under
 * the rear wheels, the absorber housing beside it, ramps at the back, chocks
 * at the front wheels, ratchet straps from the deck to the car, the
 * operator's pendant on its stand and the exhaust hose from the tailpipe
 * along the floor to `vent` (the dyno's frame: under the door, so the fumes
 * go outside). Returns the deck's height.
 */
export function dyno(k: Kit, x: number, z: number, yaw: number, car: DynoFit, vent: Vec): number {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const deck = DYNO_DECK.height;
  const half = dynoHalf(car.length);
  const w = DYNO_DECK.width;
  const pit = DYNO_DECK.pit;
  const rz = car.rearZ;
  // The deck either side of the pit, its plate skin and yellow edges.
  for (const [z0, z1] of [
    [-half, rz - pit / 2],
    [rz + pit / 2, half],
  ] as const) {
    const len = z1 - z0;
    const cz = (z0 + z1) / 2;
    k.box(m.gunmetal, w, deck - 0.01, len, 0, (deck - 0.01) / 2, cz);
    k.box(m.galv, w - 0.04, 0.01, len - 0.02, 0, deck - 0.005, cz);
    for (const s of [-1, 1]) k.box(m.yellow, 0.07, 0.012, len, s * (w / 2 - 0.035), deck + 0.001, cz);
  }
  k.box(m.black, w - 0.2, deck - 0.02, pit, 0, (deck - 0.02) / 2, rz);
  for (const s of [-1, 1]) k.box(m.gunmetal, 0.1, deck, pit, s * (w / 2 - 0.05), deck / 2, rz);
  // The drum, its top at deck height, knurled where the tires sit; the absorber on the right.
  k.cyl(m.chrome, 0.3, w - 0.24, 0, deck - 0.3 + 0.01, rz, 'x', 32);
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) k.cyl(m.cast, 0.302, 0.012, s * (car.track / 2) + (i - 2) * 0.045, deck - 0.29, rz, 'x', 32);
  k.box(m.blue, 0.5, 0.5, 0.75, w / 2 + 0.3, 0.25, rz);
  k.box(m.black, 0.42, 0.18, 0.006, w / 2 + 0.3, 0.32, rz + 0.378);
  k.box(m.yellow, 0.2, 0.06, 0.006, w / 2 + 0.3, 0.12, rz + 0.378);
  // Ramps up onto it at the back.
  for (const s of [-1, 1]) k.box(m.gunmetal, 0.7, 0.03, 1.0, s * (car.track / 2), deck / 2, -half - 0.48, 0, -Math.atan2(deck, 1.0));
  // Chocks at the front wheels (the straps are dynoStraps).
  for (const s of [-1, 1]) k.box(m.yellow, 0.28, 0.12, 0.18, s * (car.track / 2), deck + 0.06, car.frontZ + 0.45);
  // The pendant on its stand at the back right, its cable to the absorber.
  k.box(m.steel, 0.3, 0.02, 0.3, w / 2 + 0.35, 0.01, -half + 0.4);
  k.cyl(m.galv, 0.02, 1.1, w / 2 + 0.35, 0.56, -half + 0.4, 'y', 8);
  k.box(m.yellow, 0.12, 0.2, 0.06, w / 2 + 0.35, 1.18, -half + 0.43);
  k.hose(m.black, [[w / 2 + 0.35, 1.08, -half + 0.4], [w / 2 + 0.4, 0.2, -half + 0.8], [w / 2 + 0.35, 0.015, rz - 0.6], [w / 2 + 0.3, 0.2, rz - 0.3]], 0.008, 24);
  // Exhaust: a funnel over the tailpipe, the hose down to the floor and out to the vent.
  const tz = -car.length / 2 - 0.25;
  k.cyl(m.galv, 0.11, 0.25, 0.35, deck + 0.28, tz, 'z', 14, 0.07);
  k.hose(m.galv, [[0.35, deck + 0.28, tz - 0.12], [0.35, 0.09, tz - 0.9], [vent[0], 0.08, (tz + vent[2]) / 2], vent], 0.07, 40);
  return deck;
}
