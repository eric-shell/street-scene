/**
 * Bluff renderer (city/districts/bluff.ts):
 *  - the rock face between the streets: a stone retaining wall at the foot of
 *    the step, its top carrying the high ground out to the edge (so the steep
 *    terrain behind it never shows), a railing along the top, buttresses,
 *    ivy and shrubs at the foot; under the El a concrete abutment instead;
 *  - the 'bluff' walls: the retaining walls along every ramp up the face and
 *    every dip under the El, deep enough to cover the blend behind them, a
 *    parapet over whichever side is higher;
 *  - ground draped over the terrace edge and beside the ramps, where the
 *    city's coarse ground mesh (sampled at its lowest) would sink;
 *  - the 'railFence' walls: the El's fence across its right of way where it
 *    meets the crest street;
 *  - the level crossing (city/levelCrossings.ts): four masts with crossbucks
 *    and twin red signals, striped gate arms with lamps, a rubber panel over
 *    the rails and stop lines, posed every frame from the sim's gate cycle
 *    (sim/gates.ts gatePhase) at the session's interpolated tick
 *    (kit.simTick), so the arms come down for the train the trains renderer
 *    shows at that tick; an arm a car has snapped off (RaceState.brokenArms,
 *    sim/levelCrossing.ts) is a stub at its pivot from then on; and the bell
 *    (audio/warningBell.ts) while the signals warn and the arms move.
 * Static parts go into the kit's merged builders; the arms and lamps are two
 * instanced meshes for every crossing together. Per frame: one gate phase per
 * crossing, four arm and twelve lamp matrices only while the arms move or one
 * breaks, lamp colors only when the flash flips. Low drops the arm lamps and the ivy.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Wall } from '../../city/blocks';
import { bluffShape } from '../../city/districts/bluff';
import type { LevelCrossing } from '../../city/levelCrossings';
import { gatePhase } from '../../sim/gates';
import type { GatePhase } from '../../sim/gates';
import { TICK_HZ } from '../../sim/constants';
import { hash01 } from '../../city/railTimetable';
import { WarningBell } from '../../audio/warningBell';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine } from './kit';

const CFG = CITY.districts.bluff;

/** Dressing dimensions (m), timing (Hz, rad) and tints. */
const BL = {
  /** Rock face: stone courses, the top's lip over the high ground, buttress spacing, railing height. */
  piece: 3,
  lip: 0.2,
  buttressEvery: 15,
  railing: 1.05,
  /** Ground draped over the terrace edge (behind the face) and beside the ramps (m). */
  terrace: 22,
  rampGround: 18,
  /** Retaining walls: parapet over the higher side, foot below the lower one. */
  parapet: 0.95,
  foot: 0.4,
  /** El fence across the right of way. */
  fence: 1.9,
  /** Crossing masts: behind the frontage line, pole height, signal and crossbuck heights. */
  mastBack: 0.6,
  pole: 4.1,
  signal: 2.9,
  crossbuck: 3.65,
  /** Gate arms: pivot height and inset from the mast, raised angle, section, stripe length, the gap left at the middle. */
  pivot: 1.05,
  pivotIn: 0.35,
  raised: 84 * (Math.PI / 180),
  armHalf: 0.065,
  stripe: 0.9,
  /** What is left of a snapped arm: this share of its length. */
  stub: 0.18,
  armGap: 0.3,
  flashHz: 1.1,
  /** Bell: heard out to this far, half as loud at bellHalf (m). */
  bellRange: 240,
  bellHalf: 40,
} as const;

const TINT = {
  stone: col(0x6d665d),
  stoneDark: col(0x4f4a44),
  cap: col(0x85807a),
  concrete: col(0x75777e),
  earth: col(0x1d2418),
  ivy: col(0x1b3a1f, 0.9),
  steel: col(0x55585e),
  dark: col(0x26282c),
  white: col(0xe8e8e8, 1.1),
  red: col(0xd11a1a),
  rubber: col(0x1c1d21),
  paint: col(0xd8dce6, 0.8),
  housing: col(0x111214),
} as const;

/** Lamp colors (instance colors of the unlit lamp mesh). */
const LAMP_ON = new THREE.Color(0xff2a1a).multiplyScalar(2.6);
const LAMP_OFF = new THREE.Color(0x2a0604);

/** Axis-aligned-in-its-own-frame box: center c, unit axes a (along), b (up-ish), n (across) with half sizes. */
function box(gb: GeoBuilder, cx: number, cy: number, cz: number, ax: THREE.Vector3, ha: number, ay: THREE.Vector3, hb: number, an: THREE.Vector3, hn: number, color: THREE.Color): void {
  const P = (sa: number, sb: number, sn: number): [number, number, number] => [
    cx + ax.x * ha * sa + ay.x * hb * sb + an.x * hn * sn,
    cy + ax.y * ha * sa + ay.y * hb * sb + an.y * hn * sn,
    cz + ax.z * ha * sa + ay.z * hb * sb + an.z * hn * sn,
  ];
  const face = (n: THREE.Vector3, sgn: number, corners: [number, number, number][]) => {
    const ids = corners.map((p) => gb.vertex(p[0], p[1], p[2], n.x * sgn, n.y * sgn, n.z * sgn, 0, 0, color));
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], n.x * sgn, n.y * sgn, n.z * sgn);
  };
  for (const s of [-1, 1]) {
    face(ax, s, [P(s, -1, -1), P(s, 1, -1), P(s, 1, 1), P(s, -1, 1)]);
    face(ay, s, [P(-1, s, -1), P(1, s, -1), P(1, s, 1), P(-1, s, 1)]);
    face(an, s, [P(-1, -1, s), P(1, -1, s), P(1, 1, s), P(-1, 1, s)]);
  }
}

/**
 * A wall from a to b with a sloped top and foot: the long face on a-b, `depth`
 * deep along (ox, oz), from y0a / y0b up to y1a / y1b at the two ends.
 */
function slopedWall(gb: GeoBuilder, ax: number, az: number, bx: number, bz: number, ox: number, oz: number, y0a: number, y0b: number, y1a: number, y1b: number, side: THREE.Color, top: THREE.Color): void {
  const len = Math.hypot(bx - ax, bz - az) || 1;
  const nx = -ox / (Math.hypot(ox, oz) || 1);
  const nz = -oz / (Math.hypot(ox, oz) || 1);
  const fa = [gb.vertex(ax, y0a, az, nx, 0, nz, 0, 0, side), gb.vertex(bx, y0b, bz, nx, 0, nz, len / 4, 0, side), gb.vertex(bx, y1b, bz, nx, 0, nz, len / 4, 1, side), gb.vertex(ax, y1a, az, nx, 0, nz, 0, 1, side)];
  gb.quadFacing(fa[0], fa[1], fa[2], fa[3], nx, 0, nz);
  const ba = [gb.vertex(ax + ox, y0a, az + oz, -nx, 0, -nz, 0, 0, side), gb.vertex(bx + ox, y0b, bz + oz, -nx, 0, -nz, len / 4, 0, side), gb.vertex(bx + ox, y1b, bz + oz, -nx, 0, -nz, len / 4, 1, side), gb.vertex(ax + ox, y1a, az + oz, -nx, 0, -nz, 0, 1, side)];
  gb.quadFacing(ba[0], ba[1], ba[2], ba[3], -nx, 0, -nz);
  const t = [gb.vertex(ax, y1a, az, 0, 1, 0, 0, 0, top), gb.vertex(bx, y1b, bz, 0, 1, 0, 1, 0, top), gb.vertex(bx + ox, y1b, bz + oz, 0, 1, 0, 1, 1, top), gb.vertex(ax + ox, y1a, az + oz, 0, 1, 0, 0, 1, top)];
  gb.quadFacing(t[0], t[1], t[2], t[3], 0, 1, 0);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  for (const [px, pz, y0, y1, s] of [
    [ax, az, y0a, y1a, -1],
    [bx, bz, y0b, y1b, 1],
  ] as const) {
    const e = [gb.vertex(px, y0, pz, ux * s, 0, uz * s, 0, 0, side), gb.vertex(px + ox, y0, pz + oz, ux * s, 0, uz * s, 1, 0, side), gb.vertex(px + ox, y1, pz + oz, ux * s, 0, uz * s, 1, 1, side), gb.vertex(px, y1, pz, ux * s, 0, uz * s, 0, 1, side)];
    gb.quadFacing(e[0], e[1], e[2], e[3], ux * s, 0, uz * s);
  }
}

export const bluffRenderer: DistrictRenderer = {
  kinds: ['bluff'],
  build(kit, areas) {
    if (!areas.length) return;
    const low = kit.quality === 'low';
    for (const a of areas) {
      const s = bluffShape(a);
      const b = kit.builds[a.id];
      // The El's right of way crosses the face here: an abutment, not the rock wall.
      const rdx = a.params.rowBx - a.params.rowAx;
      const rdz = a.params.rowBz - a.params.rowAz;
      const rowU = (() => {
        // Where the right of way line meets the face line (v = 0), in face u.
        const den = rdx * s.vx + rdz * s.vz;
        const t = Math.abs(den) > 1e-9 ? -((a.params.rowAx - s.ox) * s.vx + (a.params.rowAz - s.oz) * s.vz) / den : 0;
        const x = a.params.rowAx + rdx * t;
        const z = a.params.rowAz + rdz * t;
        return (x - s.ox) * s.ux + (z - s.oz) * s.uz;
      })();
      const rowHalf = CITY.districts.subway.deckWidth / 2 + 1.2;
      const at = (u: number, v: number) => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
      for (const h of b.hints) {
        if (h.kind !== 'face') continue;
        const [u0, u1] = h.values;
        // The pieces of this run either side of the right of way.
        const runs: [number, number][] = [];
        if (rowU - rowHalf > u0 && rowU + rowHalf < u1) runs.push([u0, rowU - rowHalf], [rowU + rowHalf, u1]);
        else if (rowU + rowHalf <= u0 || rowU - rowHalf >= u1) runs.push([u0, u1]);
        else if (rowU - rowHalf <= u0) runs.push([Math.min(u1, rowU + rowHalf), u1]);
        else runs.push([u0, Math.max(u0, rowU - rowHalf)]);
        for (const [r0, r1] of runs) if (r1 - r0 > 0.5) rockFace(kit, s, r0, r1, low, a.id);
      }
      if (rowU > s.uA - s.we && rowU < s.uB + s.we) abutment(kit, s, rowU, rowHalf, a.params.y);
      // Terrace ground over the face's top, beside the ramps (both halves), under the dips' retaining walls.
      for (const h of b.hints) {
        if (h.kind === 'face') {
          const [u0, u1] = h.values;
          for (let u = u0; u < u1 - 0.1; u += 6) {
            const ue = Math.min(u1, u + 6);
            if (ue > rowU - rowHalf && u < rowU + rowHalf) continue;
            const v0 = s.fw / 2 - 0.2;
            drapeConvex(kit, kit.ground, [at(u, v0), at(ue, v0), at(ue, v0 + BL.terrace), at(u, v0 + BL.terrace)], 0.04, TINT.earth, 6);
          }
        } else if (h.kind === 'ramp') {
          const R = h.points[0];
          const D = h.points[1];
          const [hw, reach] = h.values;
          const nx = -D.z;
          const nz = D.x;
          for (const sd of [-1, 1]) {
            for (let t = -reach; t < reach - 0.1; t += 6) {
              const te = Math.min(reach, t + 6);
              const q0 = hw + CFG.blend + 0.4;
              const q1 = hw + BL.rampGround;
              const P = (tt: number, q: number) => ({ x: R.x + D.x * tt + nx * q * sd, z: R.z + D.z * tt + nz * q * sd });
              drapeConvex(kit, kit.ground, [P(t, q0), P(te, q0), P(te, q1), P(t, q1)], 0.04, TINT.earth, 6);
            }
          }
        }
      }
      for (const lc of kit.world.levelCrossings ?? []) if (lc.area === a.id) crossingStatic(kit, lc);
    }
    for (const w of kit.walls.get('bluff') ?? []) retaining(kit, w);
    for (const w of kit.walls.get('railFence') ?? []) railFence(kit, w);
    const crossings = (kit.world.levelCrossings ?? []).filter((lc) => areas.some((a) => a.id === lc.area));
    if (crossings.length) crossingMotion(kit, crossings);
  },
};

/** The rock face from u0 to u1: wall at the foot of the step, top out to the high ground, railing, buttresses, ivy, shrubs. */
function rockFace(kit: DistrictKit, s: ReturnType<typeof bluffShape>, u0: number, u1: number, low: boolean, seed: number): void {
  const gb = kit.solid;
  const n = Math.max(1, Math.ceil((u1 - u0) / BL.piece));
  const foot = -s.fw / 2;
  const back = s.fw / 2 + 0.8;
  const P = (u: number, v: number) => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
  const tops: number[] = [];
  const bots: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const lo = P(u, foot - 0.8);
    const hi = P(u, back);
    bots.push(kit.h(lo.x, lo.z) - 0.35);
    tops.push(kit.h(hi.x, hi.z) + BL.lip);
  }
  const color = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const ua = u0 + ((u1 - u0) * i) / n;
    const ub = u0 + ((u1 - u0) * (i + 1)) / n;
    if (tops[i] - bots[i] < 0.6 && tops[i + 1] - bots[i + 1] < 0.6) continue;
    const A = P(ua, foot);
    const B = P(ub, foot);
    // Stone courses: a tone per piece.
    color.copy(hash01(seed, i, 7) < 0.5 ? TINT.stone : TINT.stoneDark).multiplyScalar(0.85 + 0.3 * hash01(seed, i, 11));
    slopedWall(gb, A.x, A.z, B.x, B.z, s.vx * (back - foot), s.vz * (back - foot), bots[i], bots[i + 1], tops[i], tops[i + 1], color, TINT.cap);
    // Railing posts and rail along the top edge.
    const ra = P(ua, foot + 0.25);
    const rb = P(ub, foot + 0.25);
    cylinder(gb, ra.x, ra.z, 0.04, tops[i], tops[i] + BL.railing, 4, TINT.steel, false);
    const ids = [
      gb.vertex(ra.x, tops[i] + BL.railing - 0.05, ra.z, -s.vx, 0, -s.vz, 0, 0, TINT.steel),
      gb.vertex(rb.x, tops[i + 1] + BL.railing - 0.05, rb.z, -s.vx, 0, -s.vz, 1, 0, TINT.steel),
      gb.vertex(rb.x, tops[i + 1] + BL.railing + 0.05, rb.z, -s.vx, 0, -s.vz, 1, 1, TINT.steel),
      gb.vertex(ra.x, tops[i] + BL.railing + 0.05, ra.z, -s.vx, 0, -s.vz, 0, 1, TINT.steel),
    ];
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], -s.vx, 0, -s.vz);
    // Buttresses every so often, a shrub at the foot, ivy hanging down the face.
    const um = (ua + ub) / 2;
    if (Math.floor(ua / BL.buttressEvery) !== Math.floor(ub / BL.buttressEvery)) {
      const F = P(um, foot - 0.7);
      const G = P(um + 0.6, foot - 0.7);
      slopedWall(gb, F.x, F.z, G.x, G.z, s.vx * 0.7, s.vz * 0.7, (bots[i] + bots[i + 1]) / 2, (bots[i] + bots[i + 1]) / 2, (tops[i] + tops[i + 1]) / 2 - 0.4, (tops[i] + tops[i + 1]) / 2 - 0.4, TINT.cap, TINT.cap);
    }
    if (hash01(seed, i, 3) < 0.45) {
      const q = P(um, foot - 1.2);
      const y = kit.h(q.x, q.z);
      const r = 0.7 + 0.6 * hash01(seed, i, 5);
      cylinder(kit.foliage, q.x, q.z, r, y - 0.1, y + r * 1.2, 6, TINT.ivy, true, r * 0.4);
    }
    if (!low && hash01(seed, i, 9) < 0.35) {
      // Ivy: a dark green sheet on the face, from the top down a way.
      const C = P(ua + 0.4, foot - 0.03);
      const D = P(ub - 0.4, foot - 0.03);
      const drop = (tops[i] - bots[i]) * (0.35 + 0.5 * hash01(seed, i, 13));
      const v = [
        kit.foliage.vertex(C.x, tops[i] - drop, C.z, -s.vx, 0, -s.vz, 0, 0, TINT.ivy),
        kit.foliage.vertex(D.x, tops[i + 1] - drop * 0.8, D.z, -s.vx, 0, -s.vz, 1, 0, TINT.ivy),
        kit.foliage.vertex(D.x, tops[i + 1] - 0.05, D.z, -s.vx, 0, -s.vz, 1, 1, TINT.ivy),
        kit.foliage.vertex(C.x, tops[i] - 0.05, C.z, -s.vx, 0, -s.vz, 0, 1, TINT.ivy),
      ];
      kit.foliage.quadFacing(v[0], v[1], v[2], v[3], -s.vx, 0, -s.vz);
    }
  }
}

/** Under the El where its right of way meets the face: a concrete abutment up to the track bed. */
function abutment(kit: DistrictKit, s: ReturnType<typeof bluffShape>, u: number, half: number, trackY: number): void {
  const P = (uu: number, v: number) => ({ x: s.ox + s.ux * uu + s.vx * v, z: s.oz + s.uz * uu + s.vz * v });
  const foot = -s.fw / 2;
  const A = P(u - half, foot);
  const B = P(u + half, foot);
  const lo = P(u, foot - 1);
  const y0 = kit.h(lo.x, lo.z) - 0.35;
  const y1 = trackY - 0.3;
  if (y1 - y0 < 0.5) return;
  slopedWall(kit.solid, A.x, A.z, B.x, B.z, s.vx * (s.fw + 1.5), s.vz * (s.fw + 1.5), y0, y0, y1, y1, TINT.concrete, TINT.concrete);
}

/** A 'bluff' wall: retaining wall on the frontage line, deep enough to cover the blend behind it. */
function retaining(kit: DistrictKit, w: Wall): void {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (len < 0.05) return;
  const depth = CFG.blend + 0.6;
  const steps = Math.max(1, Math.ceil(len / 3));
  const yIn = (x: number, z: number) => kit.h(x + w.nx * 0.6, z + w.nz * 0.6);
  const yOut = (x: number, z: number) => kit.h(x - w.nx * (CFG.blend + 1.2), z - w.nz * (CFG.blend + 1.2));
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const ax = w.ax + (w.bx - w.ax) * t0;
    const az = w.az + (w.bz - w.az) * t0;
    const bx = w.ax + (w.bx - w.ax) * t1;
    const bz = w.az + (w.bz - w.az) * t1;
    const ia = yIn(ax, az);
    const ib = yIn(bx, bz);
    const oa = yOut(ax, az);
    const ob = yOut(bx, bz);
    slopedWall(kit.solid, ax, az, bx, bz, -w.nx * depth, -w.nz * depth, Math.min(ia, oa) - BL.foot, Math.min(ib, ob) - BL.foot, Math.max(ia, oa) + BL.parapet, Math.max(ib, ob) + BL.parapet, TINT.concrete, TINT.cap);
  }
}

/** A 'railFence' wall: the El's fence across its right of way (posts, rails and wires). */
function railFence(kit: DistrictKit, w: Wall): void {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (len < 0.05) return;
  const n = Math.max(1, Math.ceil(len / 2.5));
  const gb = kit.solid;
  for (let i = 0; i <= n; i++) {
    const x = w.ax + ((w.bx - w.ax) * i) / n;
    const z = w.az + ((w.bz - w.az) * i) / n;
    const y = kit.h(x, z);
    cylinder(gb, x - w.nx * 0.1, z - w.nz * 0.1, 0.045, y - 0.1, y + BL.fence, 5, TINT.steel, true);
  }
  for (const f of [0.05, 0.5, 0.95]) {
    const ya = kit.h(w.ax, w.az) + BL.fence * f;
    const yb = kit.h(w.bx, w.bz) + BL.fence * f;
    const ids = [
      gb.vertex(w.ax - w.nx * 0.1, ya - 0.025, w.az - w.nz * 0.1, w.nx, 0, w.nz, 0, 0, TINT.steel),
      gb.vertex(w.bx - w.nx * 0.1, yb - 0.025, w.bz - w.nz * 0.1, w.nx, 0, w.nz, 1, 0, TINT.steel),
      gb.vertex(w.bx - w.nx * 0.1, yb + 0.025, w.bz - w.nz * 0.1, w.nx, 0, w.nz, 1, 1, TINT.steel),
      gb.vertex(w.ax - w.nx * 0.1, ya + 0.025, w.az - w.nz * 0.1, w.nx, 0, w.nz, 0, 1, TINT.steel),
    ];
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], w.nx, 0, w.nz);
  }
}

/** Mast positions of a crossing: for each gate side s and street side t, the foot behind the frontage line. */
function masts(lc: LevelCrossing): { x: number; z: number; s: number; t: number }[] {
  const out: { x: number; z: number; s: number; t: number }[] = [];
  const nx = -lc.rz;
  const nz = lc.rx;
  for (const s of [-1, 1]) for (const t of [-1, 1]) out.push({ x: lc.x + lc.rx * s * lc.gate + nx * t * (lc.half + BL.mastBack), z: lc.z + lc.rz * s * lc.gate + nz * t * (lc.half + BL.mastBack), s, t });
  return out;
}

/** The fixed parts: masts, crossbucks, signal heads, gate machinery, the rubber panel over the rails and stop lines. */
function crossingStatic(kit: DistrictKit, lc: LevelCrossing): void {
  const gb = kit.solid;
  const r = new THREE.Vector3(lc.rx, 0, lc.rz);
  const n = new THREE.Vector3(-lc.rz, 0, lc.rx);
  const up = new THREE.Vector3(0, 1, 0);
  for (const m of masts(lc)) {
    const y = kit.h(m.x, m.z);
    cylinder(gb, m.x, m.z, 0.11, y - 0.2, y + BL.pole, 8, TINT.steel, true);
    // Crossbuck facing the approach (traffic comes from the +s side).
    for (const k of [-1, 1]) {
      const a = new THREE.Vector3().copy(n).multiplyScalar(Math.SQRT1_2).addScaledVector(up, k * Math.SQRT1_2);
      const b = new THREE.Vector3().crossVectors(r, a).normalize();
      box(gb, m.x + lc.rx * m.s * 0.14, y + BL.crossbuck, m.z + lc.rz * m.s * 0.14, a, 0.62, b, 0.11, r, 0.015, TINT.white);
    }
    // Signal crossarm with two housings and their visors, and the gate mechanism toward the road.
    box(gb, m.x + lc.rx * m.s * 0.12, y + BL.signal, m.z + lc.rz * m.s * 0.12, n, 0.5, up, 0.05, r, 0.05, TINT.dark);
    for (const k of [-1, 1]) box(gb, m.x + n.x * k * 0.38 + lc.rx * m.s * 0.2, y + BL.signal, m.z + n.z * k * 0.38 + lc.rz * m.s * 0.2, n, 0.17, up, 0.17, r, 0.08, TINT.housing);
    box(gb, m.x - n.x * m.t * 0.15, y + BL.pivot - 0.15, m.z - n.z * m.t * 0.15, n, 0.25, up, 0.35, r, 0.22, TINT.dark);
  }
  // The rubber panel over the rails (the road between the gates' track side) and a stop line before each gate.
  const lo = Math.min(lc.tracks[0], lc.tracks[1]) - 1.6;
  const hi = Math.max(lc.tracks[0], lc.tracks[1]) + 1.6;
  const road = lc.half - CITY.sidewalk;
  const nx = -lc.rz;
  const nz = lc.rx;
  const P = (a: number, q: number) => ({ x: lc.x + lc.rx * a + nx * q, z: lc.z + lc.rz * a + nz * q });
  drapeConvex(kit, kit.paint, [P(lo, -road), P(hi, -road), P(hi, road), P(lo, road)], 0.06, TINT.rubber, 3);
  for (const s of [-1, 1]) groundLine(kit, kit.paint, P(s * (lc.gate + 2.2), -road), P(s * (lc.gate + 2.2), road), 0.45, 0.06, TINT.paint);
}

/** The moving parts of every crossing: arms and lamps (two instanced meshes), posed from the gate cycle; the bell. */
function crossingMotion(kit: DistrictKit, list: LevelCrossing[]): void {
  const low = kit.quality === 'low';
  const set = kit.world.timedGates;
  if (!set) return;
  // Arm geometry along +x from the pivot: red and white stripes, a counterweight stub behind it.
  const armLen = list.map((lc) => lc.half + BL.mastBack - BL.pivotIn - BL.armGap / 2);
  const len = Math.max(...armLen);
  const ag = new GeoBuilder(true);
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const stripes = Math.max(1, Math.round(len / BL.stripe));
  for (let i = 0; i < stripes; i++) box(ag, ((i + 0.5) * len) / stripes, 0, 0, X, len / stripes / 2, Y, BL.armHalf, Z, BL.armHalf * 0.8, i % 2 ? TINT.white : TINT.red);
  box(ag, -0.45, 0, 0, X, 0.4, Y, 0.16, Z, 0.12, TINT.dark);
  const armMat = kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: 0x220808, envMapIntensity: 0.6 }));
  const nArms = list.length * 4;
  const arms = new THREE.InstancedMesh(kit.track(ag.build()), armMat, nArms);
  arms.name = 'crossingArms';
  arms.frustumCulled = false;
  kit.group.add(arms);
  // Lamps: two signals per mast, and (Medium and High) three on every arm.
  const perArm = low ? 0 : 3;
  const nLamps = list.length * 4 * (2 + perArm);
  const lampGeo = kit.track(new THREE.BoxGeometry(0.2, 0.2, 0.06));
  const lampMat = kit.track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, nLamps);
  lamps.name = 'crossingLamps';
  lamps.frustumCulled = false;
  lamps.setColorAt(0, LAMP_OFF);
  kit.group.add(lamps);
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const by = new THREE.Vector3();
  const bz = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const fx = new THREE.Vector3();
  const fz = new THREE.Vector3();
  const phase: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };
  // Fixed signal lamps: on the housings, facing the approach.
  const mastsOf = list.map((lc) => masts(lc));
  list.forEach((lc, ci) => {
    mastsOf[ci].forEach((m, mi) => {
      const y = kit.h(m.x, m.z);
      for (let k = 0; k < 2; k++) {
        const sk = k ? 1 : -1;
        pos.set(m.x + -lc.rz * sk * 0.38 + lc.rx * m.s * 0.29, y + BL.signal, m.z + lc.rx * sk * 0.38 + lc.rz * m.s * 0.29);
        bz.set(lc.rx * m.s, 0, lc.rz * m.s);
        bx.crossVectors(Y, bz).normalize();
        m4.makeBasis(bx, Y, bz).setPosition(pos);
        lamps.setMatrixAt(((ci * 4 + mi) * (2 + perArm)) + k, m4);
      }
    });
  });
  const lastArm = list.map(() => -1);
  const lastFlash = list.map(() => -1);
  // Snapped arms per crossing as a bit per mast (mast mi is arm lc.gates[mi >> 1] * 2 + (mi & 1)).
  const broken = list.map(() => 0);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  /** The arms of crossing ci down by `down` (0 up, 1 down): their matrices and their lamps'. */
  const poseArms = (ci: number, down: number) => {
    const lc = list[ci];
    const e = down * down * (3 - 2 * down);
    const ang = BL.raised * (1 - e);
    mastsOf[ci].forEach((m, mi) => {
      const y = kit.h(m.x, m.z);
      // Inward across the street from this mast, then tipped up by the raise angle.
      const dx = lc.rz * m.t;
      const dz = -lc.rx * m.t;
      bx.set(dx * Math.cos(ang), Math.sin(ang), dz * Math.cos(ang));
      by.set(-dx * Math.sin(ang), Math.cos(ang), -dz * Math.sin(ang));
      bz.crossVectors(bx, by);
      pos.set(m.x + dx * BL.pivotIn, y + BL.pivot, m.z + dz * BL.pivotIn);
      const snapped = (broken[ci] >> mi) & 1;
      // A snapped arm keeps a stub (the counterweight stub behind the pivot shrinks with it, which reads fine).
      if (snapped) tmp.copy(bx).multiplyScalar(BL.stub);
      m4.makeBasis(snapped ? tmp : bx, by, bz).setPosition(pos);
      arms.setMatrixAt(ci * 4 + mi, m4);
      for (let k = 0; k < perArm; k++) {
        if (snapped) {
          lamps.setMatrixAt(((ci * 4 + mi) * (2 + perArm)) + 2 + k, zero);
          continue;
        }
        const f = (k + 1) / perArm;
        tmp.copy(pos).addScaledVector(bx, armLen[ci] * f - 0.15).addScaledVector(by, BL.armHalf + 0.1);
        // Facing the traffic this gate holds back.
        fz.set(lc.rx * m.s, 0, lc.rz * m.s);
        fx.crossVectors(Y, fz).normalize();
        m4.makeBasis(fx, Y, fz).setPosition(tmp);
        lamps.setMatrixAt(((ci * 4 + mi) * (2 + perArm)) + 2 + k, m4);
      }
    });
    arms.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
  };
  for (let ci = 0; ci < list.length; ci++) poseArms(ci, 0);
  let ringing: number[] = list.map(() => 0);
  const update = (time: number) => {
    const tick = kit.simTick(time);
    let colors = false;
    for (let ci = 0; ci < list.length; ci++) {
      const lc = list[ci];
      gatePhase(set.cycles[lc.cycle], tick, phase);
      let snapped = 0;
      for (let mi = 0; mi < 4; mi++) if (kit.armBroken(lc.gates[mi >> 1] * 2 + (mi & 1))) snapped |= 1 << mi;
      if (phase.arm !== lastArm[ci] || snapped !== broken[ci]) {
        lastArm[ci] = phase.arm;
        broken[ci] = snapped;
        poseArms(ci, phase.arm);
      }
      const active = phase.name !== 'open';
      ringing[ci] = phase.name === 'warn' || phase.name === 'lowering' || phase.name === 'raising' ? 1 : 0;
      const flash = active ? 1 + (Math.floor((tick / TICK_HZ) * BL.flashHz * 2) % 2) : 0;
      if (flash === lastFlash[ci]) continue;
      lastFlash[ci] = flash;
      colors = true;
      for (let mi = 0; mi < 4; mi++) {
        const b0 = (ci * 4 + mi) * (2 + perArm);
        lamps.setColorAt(b0, flash === 1 ? LAMP_ON : LAMP_OFF);
        lamps.setColorAt(b0 + 1, flash === 2 ? LAMP_ON : LAMP_OFF);
        // Arm lamps: the tip steady while active, the other two alternating.
        for (let k = 0; k < perArm; k++) lamps.setColorAt(b0 + 2 + k, !active ? LAMP_OFF : k === perArm - 1 || (k % 2 === 0) === (flash === 1) ? LAMP_ON : LAMP_OFF);
      }
    }
    if (colors && lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  };
  update(0);
  kit.animate(update);
  // ---------- Bell, from the camera, for the nearest crossing that rings ----------
  let bell: WarningBell | null = null;
  let bellTried = false;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const bellPos = list.map((lc) => new THREE.Vector3(lc.x, kit.h(lc.x, lc.z) + 3, lc.z));
  kit.view((camera) => {
    camera.getWorldPosition(camPos);
    let best = -1;
    let bestD = Infinity;
    for (let ci = 0; ci < list.length; ci++) {
      if (!ringing[ci]) continue;
      const d = camPos.distanceTo(bellPos[ci]);
      if (d < bestD) {
        bestD = d;
        best = ci;
      }
    }
    const proximity = best >= 0 && kit.audible() && bestD < BL.bellRange ? 1 / (1 + (bestD / BL.bellHalf) ** 2) : 0;
    if (!bell && !bellTried && proximity > 0.03) {
      bell = WarningBell.create();
      bellTried = bell !== null || !WarningBell.blocked();
    }
    if (!bell) return;
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const p = best >= 0 ? bellPos[best] : camPos;
    const dx = p.x - camPos.x;
    const dz = p.z - camPos.z;
    const l = Math.hypot(dx, dz) || 1;
    bell.update(proximity, (dx * camRight.x + dz * camRight.z) / l);
  });
  kit.track({
    dispose() {
      bell?.dispose();
      bell = null;
      ringing = [];
    },
  });
}
