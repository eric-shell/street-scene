/**
 * Alley renderer: strings of warm bulbs sagging across raceway alleys from
 * wall to wall, a few dim lamps over plain back alleys (they stay dark on
 * purpose), and a steel kicker deck over every back alley hump, following
 * the same height profile the sim drives on (hazard yellow at the toes and
 * the lip). The route's own shortcuts are made to be seen: pink and amber
 * string lights all the way through and glowing chevrons on the floor
 * pointing from the entry to the exit (the sign over the entry is drawn by
 * routeArrows.ts). Tables, crates, dumpsters and trash are destructible props drawn
 * by render/props.ts. Content to add: fire escapes, graffiti, steam vents,
 * puddles.
 */
import { jumpProfile } from '../../city/districts/alley';
import { CITY } from '../../city/config';
import { routeSample } from '../../city/route';
import type { DistrictRenderer, DistrictKit } from './kit';
import { col, cylinder } from './kit';

/** String lights: one string every STRING_STEP m along a raceway alley, a bulb every BULB_STEP m, sagging SAG m. */
const STRING_STEP = 7;
const BULB_STEP = 0.55;
const SAG = 0.75;
const STRING_Y = 5.9;
/** The kicker deck floats this far above the profile so the road mesh never shows through it (m). */
const DECK_LIFT = 0.06;
/** Deck rows every DECK_STEP m along the hump. */
const DECK_STEP = 0.5;

const WARM = [col(0xffb35c, 2.4), col(0xffc98a, 2.2), col(0xff9a5c, 2.3), col(0xff7ab0, 1.8), col(0xfff0c8, 2)];
/** Route shortcut bulbs: hot pink with amber, the shortcut sign's colours. */
const SHORTCUT_BULBS = [col(0xff4fd8, 2.2), col(0xffb35c, 2.3), col(0xff2bd6, 2), col(0xffd08a, 2.1)];
/** Floor chevrons along a route shortcut: spacing (m), size (m) and brightness. */
const CHEVRON = { step: 7, length: 1.6, width: 2.4, bar: 0.45, color: col(0xff3bd8, 0.85) } as const;

function stringLights(kit: DistrictKit, ax: number, az: number, bx: number, bz: number, half: number, warm = WARM, from = 10, to = 10): void {
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const nx = -uz;
  const nz = ux;
  const wire = col(0x101114);
  for (let s = from, k = 0; s < len - to; s += STRING_STEP, k++) {
    // Strings run a little diagonal, alternating, so they read as hand hung.
    const skew = (k % 2 ? 1 : -1) * 1.2;
    const x0 = ax + ux * (s - skew) - nx * half;
    const z0 = az + uz * (s - skew) - nz * half;
    const x1 = ax + ux * (s + skew) + nx * half;
    const z1 = az + uz * (s + skew) + nz * half;
    const y0 = kit.h(x0, z0) + STRING_Y;
    const y1 = kit.h(x1, z1) + STRING_Y;
    const span = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(span / BULB_STEP));
    let px = x0;
    let pz = z0;
    let py = y0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = y0 + (y1 - y0) * t - SAG * 4 * t * (1 - t);
      if (i > 0) cylinder(kit.solid, (x + px) / 2, (z + pz) / 2, 0.012, Math.min(y, py) - 0.012, Math.max(y, py) + 0.012, 3, wire, false);
      if (i > 0 && i < n) cylinder(kit.glow, x, z, 0.07, y - 0.13, y, 5, warm[(i * 7 + k * 3) % warm.length]);
      px = x;
      pz = z;
      py = y;
    }
  }
}

function kickerDeck(kit: DistrictKit, ax: number, az: number, ux: number, uz: number, center: number, ramp: number, top: number, height: number, hw: number): void {
  const steel = col(0x3a3d44);
  const hazard = col(0xf2b81c);
  const dark = col(0x15161a);
  const lx = -uz;
  const lz = ux;
  const s0 = center - top / 2 - ramp;
  const s1 = center - top / 2;
  const s2 = center + top / 2;
  const s3 = center + top / 2 + ramp;
  const stations: number[] = [];
  for (let s = s0; s < s3; s += DECK_STEP) stations.push(s);
  stations.push(s1, s2, s3);
  stations.sort((a, b) => a - b);
  const gb = kit.solid;
  let prev: number[] | null = null;
  let prevS = s0;
  for (const s of stations) {
    if (prev && s - prevS < 1e-3) continue;
    const p = jumpProfile(s, center, ramp, top, height);
    const band = s - s0 < 0.6 || s3 - s < 0.6 || Math.abs(s - s1) < 0.35 || Math.abs(s - s2) < 0.35;
    const c = band ? (Math.floor((s - s0) / 0.3) % 2 ? hazard : dark) : steel;
    // Slope normal along the alley: (-dh * u, 1) normalized.
    const nl = Math.hypot(p.dh, 1);
    const nx = (-p.dh * ux) / nl;
    const ny = 1 / nl;
    const nz = (-p.dh * uz) / nl;
    const row = [-hw, 0, hw].map((l) => {
      const x = ax + ux * s + lx * l;
      const z = az + uz * s + lz * l;
      return gb.vertex(x, kit.h(x, z) + DECK_LIFT, z, nx, ny, nz, 0, 0, c);
    });
    if (prev) for (let k = 0; k < 2; k++) gb.quadFacing(prev[k], prev[k + 1], row[k + 1], row[k], 0, 1, 0);
    // Side skirts from the deck edge down to the unmodified ground.
    if (prev) {
      for (const side of [-1, 1]) {
        const at = (ss: number) => {
          const x = ax + ux * ss + lx * side * hw;
          const z = az + uz * ss + lz * side * hw;
          const y = kit.h(x, z) + DECK_LIFT;
          return { x, z, y, base: y - jumpProfile(ss, center, ramp, top, height).h - 0.2 };
        };
        const a = at(prevS);
        const b = at(s);
        const v0 = gb.vertex(a.x, a.base, a.z, lx * side, 0, lz * side, 0, 0, dark);
        const v1 = gb.vertex(b.x, b.base, b.z, lx * side, 0, lz * side, 0, 0, dark);
        const v2 = gb.vertex(b.x, b.y, b.z, lx * side, 0, lz * side, 0, 0, dark);
        const v3 = gb.vertex(a.x, a.y, a.z, lx * side, 0, lz * side, 0, 0, dark);
        gb.quadFacing(v0, v1, v2, v3, lx * side, 0, lz * side);
      }
    }
    prev = row;
    prevS = s;
  }
}

/** Half the length of a back alley kicker (ramp + half the top), m. */
const CITY_JUMP_HALF = CITY.districts.backAlley.jumpRamp + CITY.districts.backAlley.jumpTop / 2;

/**
 * Glowing chevrons on the floor of a route shortcut, every CHEVRON.step m from
 * the entry (a) to the exit (b), skipping the mouths and the kicker (skip =
 * [center, half length] of the hump along the alley).
 */
function floorChevrons(kit: DistrictKit, ax: number, az: number, bx: number, bz: number, mouth: number, skip: [number, number] | null): void {
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const lx = -uz;
  const lz = ux;
  const gb = kit.glow;
  const at = (s: number, l: number) => {
    const x = ax + ux * s + lx * l;
    const z = az + uz * s + lz * l;
    return gb.vertex(x, kit.h(x, z) + 0.06, z, 0, 1, 0, 0, 0, CHEVRON.color);
  };
  for (let s = mouth; s < len - mouth; s += CHEVRON.step) {
    if (skip && Math.abs(s - skip[0]) < skip[1] + CHEVRON.length) continue;
    // Two bars meeting at the tip, pointing toward b.
    for (const side of [1, -1]) {
      const tip0 = at(s + CHEVRON.length, 0);
      const tip1 = at(s + CHEVRON.length - CHEVRON.bar, 0);
      const out0 = at(s, side * CHEVRON.width / 2);
      const out1 = at(s - CHEVRON.bar, side * CHEVRON.width / 2);
      gb.quadFacing(tip1, tip0, out0, out1, 0, 1, 0);
    }
  }
}

export const alleyRenderer: DistrictRenderer = {
  kinds: ['alley', 'backAlley'],
  build(kit, areas) {
    const g = kit.world.graph;
    for (const a of areas) {
      if (a.kind === 'alley') {
        for (const eid of a.edges) {
          const e = g.edges[eid];
          const p = g.nodes[e.a];
          const q = g.nodes[e.b];
          stringLights(kit, p.x, p.z, q.x, q.z, e.width / 2 + e.sidewalk - 0.1);
        }
        continue;
      }
      // Route shortcuts: lit up to be seen from the route, chevrons pointing the way through.
      const sc = kit.world.route.shortcuts.find((x) => a.edges.includes(x.edge));
      if (sc) {
        const e = g.edges[sc.edge];
        const half = e.width / 2 + e.sidewalk - 0.1;
        // Keep the strings and chevrons inside the alley, clear of the streets at both ends: a diagonal
        // mouth reaches further along the alley (the acute corner side).
        const len = Math.hypot(sc.bx - sc.ax, sc.bz - sc.az);
        const route = kit.world.route;
        const mouthAt = (s: number) => {
          const t = routeSample(route, s);
          const ux = (sc.bx - sc.ax) / len;
          const uz = (sc.bz - sc.az) / len;
          const sinA = Math.max(0.35, Math.abs(t.tx * uz - t.tz * ux));
          const cosA = Math.abs(t.tx * ux + t.tz * uz);
          return Math.min(len * 0.4, (route.segWidth[t.seg] / 2 + CITY.sidewalk + half * cosA) / sinA + 1);
        };
        const m0 = mouthAt(sc.sIn);
        const m1 = mouthAt(sc.sOut);
        stringLights(kit, sc.ax, sc.az, sc.bx, sc.bz, half, SHORTCUT_BULBS, m0, m1);
        floorChevrons(kit, sc.ax, sc.az, sc.bx, sc.bz, Math.min(m0, m1) - 2, a.params.jump ? [a.params.jumpS, CITY_JUMP_HALF + 1.5] : null);
      }
      // Back alleys: a few dim lamps (low light on purpose) and the kicker.
      const dim = col(0xffb35c, 1.1);
      for (const eid of sc ? [] : a.edges) {
        const e = g.edges[eid];
        const p = g.nodes[e.a];
        const q = g.nodes[e.b];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        const nx = -(q.z - p.z) / len;
        const nz = (q.x - p.x) / len;
        const half = e.width / 2 + e.sidewalk * 0.5;
        for (let s = 16, k = 0; s < len - 16; s += 22, k++) {
          const side = k % 2 ? 1 : -1;
          const x = p.x + ((q.x - p.x) * s) / len + nx * half * side;
          const z = p.z + ((q.z - p.z) * s) / len + nz * half * side;
          const y = kit.h(x, z) + 4.2;
          cylinder(kit.glow, x, z, 0.12, y, y + 0.2, 4, dim);
        }
      }
      for (const h of kit.builds[a.id].hints) {
        if (h.kind !== 'jump') continue;
        const [o, d] = h.points;
        const [center, ramp, top, height, hw] = h.values;
        kickerDeck(kit, o.x, o.z, d.x - o.x, d.z - o.z, center, ramp, top, height, hw);
      }
    }
  },
};
