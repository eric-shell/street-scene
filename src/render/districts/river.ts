/**
 * River renderer: the concrete flood channel as a race venue end to end.
 * Stained, jointed concrete (riverTextures.ts) over the floor and the sloped
 * banks, draped on the sim's lower level (World.heightAt with a body height
 * below everything: the channel profile, which runs on under every bridge
 * deck) so every ramp trench and pier is exactly where the collision says;
 * the entrance ramps with their trench faces and the raised plinths beside
 * them (the sim's 'trench' walls), chain-link down both plinth edges and a
 * sodium lamp on each plinth corner at the foot, and the funnel at every top
 * (fences and cones are props; the pink and amber string lights across the
 * mouth are drawn here from the planner's hints); the set pieces on the floor
 * (a hump, a water bar, a tabletop, a ledge, a median:
 * city/districts/riverFeatures.ts) on their own fine grid, the raised concrete
 * tinted like the plinths with a painted line along each crest; under each
 * deck its slab, girders,
 * the piers on the floor edges and the abutments on the banks (the sim's
 * 'pier' and 'culvert' solids) with sodium lamps hung from the slab and on
 * the piers; parapets on the decks; storm drain outlets
 * on the banks; a chain-link fence on posts along the bank tops with sodium
 * lamps pooling light down the slope; the low flow trickle and puddles as
 * dark mirrors; lit tunnel portals at both ends; a painted edge line along
 * the floor.
 *
 * Meshes: five merged meshes of its own (concrete, decals, fence, wet, light
 * pools) plus the kit's shared builders. Render only: the walls it draws are
 * the river district's own.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Bridge, Ramp } from '../../city/districts/river';
import { bridgePoint, bridgesOf, footAlongs, mouthAlongs, rampAlong, rampHalf, rampOuter, rampPoint, rampsOf, riverCenter, riverFrame, riverL } from '../../city/districts/river';
import type { Area } from '../../city/districts/types';
import { type Feature, type FeatureSample, featureHeight, featureSpan, featuresOf } from '../../city/districts/riverFeatures';
import type { Wall } from '../../city/blocks';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { RIVER_TEX, UvRect, riverTextures } from '../textures/riverTextures';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, stringLights, wallBox } from './kit';

/** Layout of the dressing (m), lamp and tint choices. */
const DRESS = {
  /** Plinth top above the ground beside a trench, and the fence height. */
  plinth: 0.5,
  fence: 1.8,
  postSpacing: 3,
  /** Sodium lamps along each bank top, staggered between the banks. */
  lampSpacing: 38,
  lampHeight: 5.2,
  /** Drains along the banks: spacing range (m). */
  drainGap: [70, 130],
  /** Puddles on the floor: spacing (m), radius (m). */
  puddleGap: [40, 95],
  puddleRadius: [1.4, 3],
  /** Row spacing of the channel surface (m), and near decks, ramps and the ends. */
  rowStep: 8,
  rowStepFine: 1.5,
  floorEdgeLine: 0.5,
  /** Lamps on the plinths down each ramp (m apart) and the dashed lines along its trench edges. */
  rampLampSpacing: 16,
  rampLineInset: 0.35,
  /** Deck slab under a bridge: depth below the road (m), overhang beyond the parapet line (m), girder depth and width (m), rows across the band (m). */
  slab: 0.7,
  slabOver: 0.4,
  girder: 0.6,
  girderWidth: 0.35,
  deckRow: 3,
  /** String lights over a ramp mouth: post height (m), sag (m), bulb spacing (m). */
  stringPost: 5.4,
  stringSag: 0.7,
  bulbStep: 0.55,
} as const;

/** How far below a deck's road its structure reaches (slab and girders, m): the cameras stay under it (render/camera/ceilings.ts). */
export const DECK_UNDERSIDE = DRESS.slab + DRESS.girder;

/** Vertex tints multiplying the concrete texture (which carries the grey), and the lamp colours. */
const TINT = {
  floor: col(0xffffff, 0.95),
  bank: col(0xffffff, 1.08),
  plinth: col(0xffffff, 1.2),
  trench: col(0xffffff, 1.0),
  wall: col(0xffffff, 1.05),
  culvert: col(0xffffff, 0.9),
  pier: col(0xffffff, 0.84),
  slab: col(0xffffff, 0.62),
  girder: col(0x5c6068),
  portal: col(0xffffff, 0.85),
  waterLine: col(0xffffff, 0.72),
  post: col(0x9aa0a8),
  pole: col(0x6a6e76),
  wire: col(0x101114),
  lamp: col(0xffb24a, 1.4),
  pool: col(0xff9a3a),
  water: col(0x0b1220),
  puddle: col(0x0d1424),
} as const;


export const riverRenderer: DistrictRenderer = {
  kinds: ['river'],
  build(kit, areas) {
    for (const a of areas) buildChannel(kit, a);
  },
};

interface V3 {
  x: number;
  y: number;
  z: number;
}

/** One column of a ramp zone row: where it is, how far above the terrain, its tint, and its LATS index (-1 and 8 for the zone's two ends). */
interface Col {
  x: number;
  z: number;
  lift: number;
  tint: THREE.Color;
  i: number;
}

type Ground = (x: number, z: number) => number;

function buildChannel(kit: DistrictKit, a: Area): void {
  const p = a.params;
  const F = p.floor;
  const T = p.top;
  const fenceL = T + 0.5;
  const tex = riverTextures(kit.world.seed);
  const rng = new Rng(((p.seed ?? kit.world.seed) ^ 0x7a9) >>> 0 || 1);
  const ramps = rampsOf(a);
  const features = featuresOf(p);
  const fspan = features.map((f) => featureSpan(f, F) + 1.5);
  const fs: FeatureSample = { h: 0, hx: 0, hl: 0 };
  const build = kit.builds[a.id];
  const world = kit.world;
  const bridges = bridgesOf(world.graph, a);
  const zc = (x: number) => riverCenter(p, x);
  /** The deck level (the terrain) and the channel level beneath it (the same ground away from the decks). */
  const h = kit.h;
  const hLow: Ground = (x, z) => world.heightAt(x, z, -Infinity);

  const concrete = new GeoBuilder(true);
  const decal = new GeoBuilder(true);
  const fence = new GeoBuilder(true);
  const wet = new GeoBuilder(true);
  const pools = new GeoBuilder(true);
  const span = RIVER_TEX.concreteSpan;

  const normalLow = (x: number, z: number): [number, number, number] => {
    const s = world.slopeAt(x, z, -Infinity);
    const l = Math.hypot(s.gx, 1, s.gz);
    return [-s.gx / l, 1 / l, -s.gz / l];
  };
  /** Surface vertex on the channel level plus a lift, world mapped. */
  const gv = (gb: GeoBuilder, x: number, z: number, lift: number, c: THREE.Color): number => {
    const n = normalLow(x, z);
    return gb.vertex(x, hLow(x, z) + lift, z, n[0], n[1], n[2], x / span, z / span, c);
  };
  /** Quad from four points with a flat normal from its geometry (vertical faces, caps, zone rows). */
  const flat = (gb: GeoBuilder, q: V3[], c: THREE.Color, u = (v: V3) => v.x / span, v = (w: V3) => w.z / span): void => {
    const ux = q[1].x - q[0].x;
    const uy = q[1].y - q[0].y;
    const uz = q[1].z - q[0].z;
    const vx = q[3].x - q[0].x;
    const vy = q[3].y - q[0].y;
    const vz = q[3].z - q[0].z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) return;
    nx /= l;
    ny /= l;
    nz /= l;
    const ids = q.map((w) => gb.vertex(w.x, w.y, w.z, nx, ny, nz, u(w), v(w), c));
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
  };
  const vertical = (v: V3) => (v.x + v.z) / span;
  const height = (v: V3) => v.y / span;
  /** Flat strip on the channel level from a to b (paint lines on the floor). */
  const lineLow = (gb: GeoBuilder, a0: Vec2, b0: Vec2, width: number, lift: number, c: THREE.Color): void => {
    const len = Math.hypot(b0.x - a0.x, b0.z - a0.z);
    if (len < 0.05) return;
    const nx = (-(b0.z - a0.z) / len) * (width / 2);
    const nz = ((b0.x - a0.x) / len) * (width / 2);
    const v = [gv(gb, a0.x + nx, a0.z + nz, lift, c), gv(gb, b0.x + nx, b0.z + nz, lift, c), gv(gb, b0.x - nx, b0.z - nz, lift, c), gv(gb, a0.x - nx, a0.z - nz, lift, c)];
    gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
  };

  // ----- The channel surface: rows of constant l across the band, draped on the channel level (so it
  // runs on under every deck). Where a ramp cuts the bank, columns follow its trench and the raised
  // plinths either side, so the drops are true vertical faces and the plinth tops sit DRESS.plinth
  // above the bank.
  const ls: number[] = [];
  for (let i = 0; i <= 8; i++) ls.push(-fenceL + ((fenceL - F) * i) / 8);
  for (const l of [-F + 2, -6, -2, 2, 6, F - 2]) ls.push(l);
  for (let i = 0; i <= 8; i++) ls.push(F + ((fenceL - F) * i) / 8);
  const tintAt = (l: number): THREE.Color => {
    const al = Math.abs(l);
    if (al > F + 0.6) return TINT.bank;
    if (al > F - 0.8) return TINT.waterLine;
    // Darker, wetter concrete around the low flow trickle.
    const d = l - CITY.districts.river.waterOffset;
    return TINT.floor.clone().multiplyScalar(1 - 0.22 * Math.exp(-(d * d) / 12));
  };
  const xs: number[] = [];
  const fine = (x: number) => bridges.some((b) => Math.abs(x - b.cx) < b.dk + 18) || features.some((f, i) => Math.abs(x - f.x) < fspan[i] + 4) || x < p.x0 + 20 || x > p.x1 - 20;
  for (let x = p.x0; x <= p.x1; ) {
    xs.push(x);
    x += fine(x) ? DRESS.rowStepFine : DRESS.rowStep;
  }
  if (xs[xs.length - 1] < p.x1 - 0.05) xs.push(p.x1);
  // Ramp zones: one per ford (two halves at one foot) or side ramp, wide enough for a skewed axis.
  const zones: { lo: number; hi: number; ramps: Ramp[] }[] = [];
  for (const r of ramps) {
    const reach = r.hw + r.body + 1.2 + Math.abs(r.ux) * (fenceL + 1);
    const z = zones.find((zn) => Math.abs(zn.ramps[0].ax - r.ax) < 1);
    if (z) z.ramps.push(r);
    else zones.push({ lo: r.ax - reach, hi: r.ax + reach, ramps: [r] });
  }
  zones.sort((u, v) => u.lo - v.lo);
  // The ramp zones and the feature spans each get their own grid; plain panels run between them (and to the channel ends).
  const cuts = [...zones.map((zn) => [zn.lo, zn.hi]), ...features.map((f, i) => [f.x - fspan[i], f.x + fspan[i]])].sort((u, v) => u[0] - v[0]);
  const inCut = (x: number) => cuts.some((c) => x > c[0] - 0.05 && x < c[1] + 0.05);
  const bounds = [p.x0, ...cuts.flat(), p.x1];
  for (let b = 0; b + 1 < bounds.length; b += 2) {
    const cols = [bounds[b], ...xs.filter((x) => x > bounds[b] + 0.05 && x < bounds[b + 1] - 0.05 && !inCut(x)), bounds[b + 1]];
    let prev: number[] | null = null;
    for (const l of ls) {
      const row = cols.map((x) => gv(concrete, x, zc(x) + l, 0.02, tintAt(l)));
      if (prev) for (let i = 0; i + 1 < row.length; i++) concrete.quadFacing(prev[i], prev[i + 1], row[i + 1], row[i], 0, 1, 0);
      prev = row;
    }
  }
  /**
   * The ten columns of a ramp zone row at `along`: outside, plinth outer face (ground / top), plinth
   * top to the trench face, the trench, and back (wider up a side ramp's bell mouth: rampHalf, rampOuter).
   */
  const LATS = (r: Ramp, along = 0) => {
    const iL = rampHalf(r, along, 1);
    const iR = rampHalf(r, along, -1);
    const oL = rampOuter(r, along, 1);
    const oR = rampOuter(r, along, -1);
    return [-(oR + 0.02), -(oR - 0.02), -(iR + 0.02), -(iR - 0.02), iL - 0.02, iL + 0.02, oL - 0.02, oL + 0.02];
  };
  /** Lift and tint per column (index into LATS) while the plinths stand. */
  const colLift = (i: number, plinth: boolean): number => (plinth && i >= 1 && i <= 2) || (plinth && i >= 5 && i <= 6) ? DRESS.plinth : 0.02;
  const colTint = (i: number, plinth: boolean, l: number): THREE.Color => (!plinth ? tintAt(l) : i === 3 || i === 4 ? TINT.trench : i === 0 || i === 7 ? tintAt(l) : TINT.plinth);
  for (const zn of zones) {
    const rampOn = (s: number) => zn.ramps.find((r) => r.side === s) ?? null;
    const colsAt = (l: number): Col[] => {
      const s = l >= 0 ? 1 : -1;
      const al = Math.abs(l);
      const r = rampOn(s);
      const base = (x: number, i: number): Col => ({ x, z: zc(x) + l, lift: 0.02, tint: tintAt(l), i });
      let mid: Col[];
      if (!r) {
        // The other bank or the floor under a lone side ramp: the same columns straight across.
        const o = zn.ramps[0];
        mid = LATS(o).map((lat, i) => base(o.ax - o.uz * lat, i));
      } else {
        const along = al > F ? rampAlong(p, r, al) : al;
        const plinth = al > F + 1e-6;
        mid = LATS(r, along).map((lat, i) => {
          const w = rampPoint(r, along, lat);
          return { x: w.x, z: w.z, lift: colLift(i, plinth), tint: colTint(i, plinth, l), i };
        });
      }
      // The columns run in descending x whichever bank the ramp climbs (its lats run the other way
      // along x on the south bank, and a ford's two halves run opposite ways): with the rows ascending
      // in l, that is the one order that winds every quad to face up and every plinth face outward
      // (the concrete is single sided; a quad wound the other way is culled and shows the ground
      // beneath as a black hole). The zone's two ends join their nearest column, never across the trench.
      if (mid[0].x < mid[mid.length - 1].x) mid.reverse();
      return [base(zn.hi, 8), ...mid, base(zn.lo, -1)];
    };
    /** A quad between two columns takes the tint of the one nearer the zone's lo end in LATS order (the plinth and trench tints sit between their edge columns). */
    const pairTint = (a: Col, b: Col): THREE.Color => (a.i < b.i ? a : b).tint;
    const rows: number[] = [];
    for (const l of ls) {
      rows.push(l);
      // A second row a hair past the floor edge on a ramp's bank: the plinth's foot is a vertical cap.
      if (Math.abs(Math.abs(l) - F) < 1e-6 && rampOn(l >= 0 ? 1 : -1)) rows.push(l + (l >= 0 ? 1 : -1) * 1e-4);
    }
    let prev: V3[] | null = null;
    for (const l of rows) {
      const cols = colsAt(l);
      const row: V3[] = cols.map((c) => ({ x: c.x, y: hLow(c.x, c.z) + c.lift, z: c.z }));
      if (prev) for (let i = 0; i + 1 < row.length; i++) flat(concrete, [prev[i], prev[i + 1], row[i + 1], row[i]], pairTint(cols[i], cols[i + 1]));
      prev = row;
    }
  }

  // ----- The set pieces on the floor (city/districts/riverFeatures.ts): each on its own fine grid across
  // the whole band (1 m columns, floor rows every 0.75 m) draped on the channel level like the rest,
  // the raised concrete tinted like the plinths, and a painted line along each crest or edge so it
  // reads from a distance at night.
  const featTint = (f: Feature, x: number, l: number): THREE.Color => {
    featureHeight(f, F, x, l, fs);
    const t = Math.min(1, fs.h / 0.2);
    return t <= 0 ? tintAt(l) : tintAt(l).clone().lerp(TINT.plinth, t);
  };
  const featRows = ls.filter((l) => Math.abs(l) > F + 1e-6);
  for (let l = -F; l <= F + 1e-6; l += 0.75) featRows.push(l);
  featRows.sort((u, v) => u - v);
  const R = CITY.districts.river.features;
  const crestPaint = col(0xf0c030, 0.8);
  features.forEach((f, i) => {
    const lo = f.x - fspan[i];
    const hi = f.x + fspan[i];
    const n = Math.ceil(hi - lo);
    const cols: number[] = [];
    for (let k = 0; k <= n; k++) cols.push(lo + ((hi - lo) * k) / n);
    let prev: number[] | null = null;
    for (const l of featRows) {
      const row = cols.map((x) => gv(concrete, x, zc(x) + l, 0.02, featTint(f, x, l)));
      if (prev) for (let k = 0; k + 1 < row.length; k++) concrete.quadFacing(prev[k], prev[k + 1], row[k + 1], row[k], 0, 1, 0);
      prev = row;
    }
    const across = (x0: number, l0: number, x1: number, l1: number) => lineLow(kit.paint, { x: x0, z: zc(x0) + l0 }, { x: x1, z: zc(x1) + l1 }, 0.2, 0.05, crestPaint);
    const inner = F - 1;
    switch (f.kind) {
      case 'hump':
        across(f.x, -inner, f.x, inner);
        break;
      case 'bar': {
        // The crest runs where dx cos + l sin = 0.
        const t = Math.tan(f.skew);
        across(f.x + inner * t, -inner, f.x - inner * t, inner);
        break;
      }
      case 'table':
        for (const s of [-1, 1]) across(f.x + (s * R.table.top) / 2, f.side * (R.table.inner + R.table.edge), f.x + (s * R.table.top) / 2, f.side * inner);
        break;
      case 'ledge': {
        const reach = R.ledge.length / 2 - R.ledge.end;
        const l = f.side * (R.ledge.inner + R.ledge.ease);
        across(f.x - reach, l, f.x + reach, l);
        break;
      }
      case 'median':
        break;
    }
  });

  /**
   * Chain-link on posts along a polyline (the bank tops, the plinth edges down every trench), its
   * panels facing the side `s` of travel and standing on `yAt`; returns the run's length (m).
   */
  const chainlink = (pts: Vec2[], s: number, yAt: Ground): number => {
    let run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a0 = pts[i];
      const b0 = pts[i + 1];
      const len = Math.hypot(b0.x - a0.x, b0.z - a0.z);
      if (len < 0.05) continue;
      const y0 = yAt(a0.x, a0.z);
      const y1 = yAt(b0.x, b0.z);
      const nx = (-(b0.z - a0.z) / len) * s;
      const nz = ((b0.x - a0.x) / len) * s;
      const u0 = run / RIVER_TEX.fenceSpan;
      const u1 = (run + len) / RIVER_TEX.fenceSpan;
      const v = [
        fence.vertex(a0.x, y0 + 0.02, a0.z, nx, 0, nz, u0, 0, TINT.post),
        fence.vertex(b0.x, y1 + 0.02, b0.z, nx, 0, nz, u1, 0, TINT.post),
        fence.vertex(b0.x, y1 + DRESS.fence, b0.z, nx, 0, nz, u1, 1, TINT.post),
        fence.vertex(a0.x, y0 + DRESS.fence, a0.z, nx, 0, nz, u0, 1, TINT.post),
      ];
      fence.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
      for (let d = run === 0 ? 0 : DRESS.postSpacing - (run % DRESS.postSpacing); d <= len; d += DRESS.postSpacing) {
        const t = d / len;
        const px = a0.x + (b0.x - a0.x) * t;
        const pz = a0.z + (b0.z - a0.z) * t;
        cylinder(kit.solid, px, pz, 0.045, yAt(px, pz) - 0.2, yAt(px, pz) + DRESS.fence + 0.1, 5, TINT.post, true);
      }
      run += len;
    }
    return run;
  };

  // ----- Ramp trenches beyond the band: up the bank top to the plinth caps at the top of the run and,
  // for side ramps, the flat mouth on to the street curb.
  for (const r of ramps) {
    const aFence = rampAlong(p, r, fenceL);
    const aTop = rampAlong(p, r, r.topL);
    const aEnd = r.ford ? aTop : rampAlong(p, r, r.curbL);
    const rowAt = (along: number, plinth: boolean): V3[] =>
      LATS(r, along).map((lat, i) => {
        // Past the top the plinths are gone: every column collapses onto the trench edges.
        const q = plinth ? lat : Math.sign(lat) * (rampHalf(r, along, Math.sign(lat)) - 0.02);
        const w = rampPoint(r, along, q);
        return { x: w.x, y: h(w.x, w.z) + colLift(i, plinth), z: w.z };
      });
    // Every 2 m, then the bell mouth at the points its walls bend at, so the faces stand on them.
    const mouth = mouthAlongs(r, aTop);
    const alongs: [number, boolean][] = [];
    for (let s = aFence; s < mouth[0] - 0.05; s += 2) alongs.push([s, true]);
    for (const s of mouth) alongs.push([s, true]);
    alongs.push([aTop + 1e-4, false]);
    if (aEnd > aTop + 0.5) {
      for (let s = aTop + 2; s < aEnd - 0.05; s += 2) alongs.push([s, false]);
      alongs.push([aEnd, false]);
    }
    let prev: V3[] | null = null;
    for (const [s, plinth] of alongs) {
      const row = rowAt(s, plinth);
      if (prev) for (let i = 0; i + 1 < row.length; i++) flat(concrete, [prev[i], prev[i + 1], row[i + 1], row[i]], colTint(i, plinth, r.side * r.topL));
      prev = row;
    }
    // Dashed lines along both trench edges, and lamps on the plinths lighting the run down.
    const aF = rampAlong(p, r, F);
    for (const sd of [1, -1]) {
      const q = sd * (r.hw - DRESS.rampLineInset);
      for (let s = aF; s < aTop - 0.5; s += 4) {
        if (Math.floor(s / 4) % 2) continue;
        lineLow(kit.paint, rampPoint(r, s, q), rampPoint(r, Math.min(aTop - 0.5, s + 2.4), q), 0.14, 0.04, col(0xd8d2a0, 0.55));
      }
    }
    // The entry's own fence and lights: chain-link on posts along both plinths' trench edges, from
    // the floor edge up to the top caps (the bells included, so it reads as a fenced gateway from the
    // floor and from the street), and a sodium lamp on each plinth corner at the foot bell lighting
    // the way in off the channel floor. The run lamps start a spacing further up.
    const plinthTop: Ground = (x, z) => h(x, z) + DRESS.plinth;
    for (const sd of [1, -1]) {
      const alongs = [aF + 0.4, ...footAlongs(r).filter((a) => a > aF + 0.4)];
      for (let s = alongs[alongs.length - 1] + 2; s < aTop - CITY.districts.river.mouthLength - 0.05; s += 2) alongs.push(s);
      alongs.push(...mouthAlongs(r, aTop).filter((a) => a < aTop - 0.4), aTop - 0.4);
      chainlink(
        alongs.map((a) => rampPoint(r, a, sd * (rampHalf(r, a, sd) + 0.3))),
        -sd,
        plinthTop,
      );
      const q = rampPoint(r, aF + 1.2, sd * (rampHalf(r, aF + 1.2, sd) + 0.9));
      const y = plinthTop(q.x, q.z);
      cylinder(kit.solid, q.x, q.z, 0.08, y - 0.1, y + 4.6, 6, TINT.pole, true);
      const head = rampPoint(r, aF + 0.4, sd * (rampHalf(r, aF + 0.4, sd) + 0.9));
      lamp(kit, pools, head.x, y + 4.5, head.z, -r.ux, -r.uz, 0.8, hLow);
    }
    let lampSide = 1;
    for (let s = aF + DRESS.rampLampSpacing; s < aTop - 3; s += DRESS.rampLampSpacing) {
      const q = lampSide * (r.hw + r.body / 2);
      const w = rampPoint(r, s, q);
      const y = h(w.x, w.z) + DRESS.plinth;
      cylinder(kit.solid, w.x, w.z, 0.07, y - 0.1, y + 3.6, 6, TINT.pole, true);
      // Head over the trench edge, facing across it.
      const hx = -lampSide * -r.uz;
      const hz = -lampSide * r.ux;
      const head = rampPoint(r, s, q - lampSide * 0.9);
      lamp(kit, pools, head.x, y + 3.5, head.z, hx, hz, 0.65, hLow);
      lampSide = -lampSide;
    }
  }

  // ----- String lights over every ramp mouth (the planner's hints): two posts, a sagging wire of
  // pink and amber bulbs, a pool of their light on the ground below.
  for (const hint of build.hints) {
    if (hint.kind !== 'stringLights') continue;
    stringLights(kit, hint.points[0], hint.points[1], { post: DRESS.stringPost, sag: DRESS.stringSag, step: DRESS.bulbStep, pools });
  }

  // ----- Under every deck: slab, girders, piers and abutments, lamps; the parapets on top.
  const piers = (kit.walls.get('pier') ?? []).filter((w) => w.area === a.id);
  const abutments = (kit.walls.get('culvert') ?? []).filter((w) => w.area === a.id);
  for (const br of bridges) deckUnderside(concrete, p, br, T, h, flat);
  for (const solid of solidsOf(piers)) {
    const c = solidCenter(solid);
    const floor = hLow(c.x, c.z);
    const top = h(c.x, c.z) - DRESS.slab + 0.05;
    for (const f of solid) flat(concrete, [{ x: f.ax, y: floor - 0.3, z: f.az }, { x: f.bx, y: floor - 0.3, z: f.bz }, { x: f.bx, y: top, z: f.bz }, { x: f.ax, y: top, z: f.az }], TINT.pier, vertical, height);
    // A lamp on the face toward the floor, two thirds of the way up, pooling light on the floor.
    const towardFloor = solid.reduce((best, f) => (lFace(p, f) < lFace(p, best) ? f : best));
    const fx = (towardFloor.ax + towardFloor.bx) / 2 + towardFloor.nx * 0.12;
    const fz = (towardFloor.az + towardFloor.bz) / 2 + towardFloor.nz * 0.12;
    if (Math.round(c.x) % 2 === 0) lamp(kit, pools, fx, floor + 2.6, fz, towardFloor.nx, towardFloor.nz, 0.55, hLow);
  }
  for (const solid of solidsOf(abutments)) {
    for (const f of solid) {
      const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
      const steps = Math.max(1, Math.ceil(len / 3));
      let last: [V3, V3] | null = null;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = f.ax + (f.bx - f.ax) * t;
        const z = f.az + (f.bz - f.az) * t;
        const ground = hLow(x + f.nx * 0.3, z + f.nz * 0.3) - 0.3;
        const top = h(x - f.nx * 6, z - f.nz * 6) - DRESS.slab + 0.05;
        const lo = { x, y: ground, z };
        const hi = { x, y: Math.max(ground + 0.05, top), z };
        if (last) flat(concrete, [last[0], lo, hi, last[1]], TINT.culvert, vertical, height);
        last = [lo, hi];
      }
      // The face toward the floor carries an arched recess and a lamp over it, as a culvert mouth.
      if (lFace(p, f) < F + CITY.districts.river.abutment + 0.5 && len > 10) {
        const dx = (f.bx - f.ax) / len;
        const dz = (f.bz - f.az) / len;
        const n = Math.max(1, Math.floor(len / 12));
        for (let i = 0; i < n; i++) {
          const t = 0.5 + (i - (n - 1) / 2) * (12 / len);
          const cx = f.ax + (f.bx - f.ax) * t;
          const cz = f.az + (f.bz - f.az) * t;
          const floor = hLow(cx + f.nx * 0.5, cz + f.nz * 0.5);
          decalQuad(decal, tex.arch, { x: cx - dx * 5, y: floor + 0.05, z: cz - dz * 5 }, { x: cx + dx * 5, y: floor + 0.05, z: cz + dz * 5 }, 3.4, f.nx, f.nz, 0.06);
          lamp(kit, pools, cx + f.nx * 0.25, floor + 3.3, cz + f.nz * 0.25, f.nx, f.nz, 0.7, hLow);
        }
      }
    }
  }
  // Lamps hung from the slab over the floor, two each side of the axis, facing the centerline.
  for (const br of bridges) {
    for (const s of [-1, 1]) {
      for (const w of [-(br.dk - 2.5), br.dk - 2.5]) {
        const q = bridgePoint(p, br, w, s * (F - 3.5));
        const y = h(q.x, q.z) - DRESS.slab - 0.15;
        const fr = riverFrame(p, q.x);
        lamp(kit, pools, q.x, y, q.z, -s * fr.mx, -s * fr.mz, 0.8, hLow);
      }
    }
  }
  for (const w of kit.walls.get('parapet') ?? []) if (w.area === a.id) wallBox(kit, kit.solid, w, 0.45, 1.0, col(0x6a6c75));

  // ----- Portals at both ends: a headwall, a black arch, a lamp either side.
  for (const w of kit.walls.get('channelEnd') ?? []) {
    if (w.area !== a.id) continue;
    wallBox(kit, concrete, w, 3, 7.5, TINT.portal);
    const cx = (w.ax + w.bx) / 2;
    const cz = (w.az + w.bz) / 2;
    const floor = h(cx + w.nx * 0.5, cz + w.nz * 0.5);
    decalQuad(decal, tex.portal, { x: cx, y: floor + 0.05, z: cz - 6 }, { x: cx, y: floor + 0.05, z: cz + 6 }, 5.5, w.nx, w.nz, 0.06);
    lamp(kit, pools, cx + w.nx * 0.3, floor + 5.2, cz - 7.5, w.nx, w.nz, 0.9, hLow);
    lamp(kit, pools, cx + w.nx * 0.3, floor + 5.2, cz + 7.5, w.nx, w.nz, 0.9, hLow);
  }

  // ----- Fence on the bank tops: chain-link strips on posts (normal toward the channel), with the sodium lamps.
  let lampPhase = 0;
  for (const hint of build.hints) {
    if (hint.kind !== 'fence') continue;
    const s = hint.values[0];
    const pts = hint.points;
    const run = chainlink(pts, s, h);
    // Lamps standing just behind the fence, their arms reaching out over the bank; banks alternate.
    for (let d = DRESS.lampSpacing * (lampPhase++ % 2 ? 1 : 0.5); d < run; d += DRESS.lampSpacing) {
      const q = alongPolyline(pts, d);
      if (!q) continue;
      const px = q.x;
      const pz = q.z + s * 0.6;
      const y = h(px, pz);
      cylinder(kit.solid, px, pz, 0.09, y - 0.2, y + DRESS.lampHeight, 6, TINT.pole, true);
      const az = pz - s * 1.3;
      cylinder(kit.solid, px, az, 0.06, y + DRESS.lampHeight - 0.25, y + DRESS.lampHeight - 0.1, 5, TINT.pole, true);
      lamp(kit, pools, px, y + DRESS.lampHeight - 0.15, az, 0, -s, 1, hLow);
    }
  }

  // ----- Drains on the bank faces, clear of ramps and decks.
  const busy = (x: number, half: number) => ramps.some((r) => Math.abs(x - r.ax) < r.hw + r.body + half + 3) || bridges.some((b) => Math.abs(x - b.cx) < b.dk + CITY.districts.river.bridgeBody + half + 4) || features.some((f, i) => Math.abs(x - f.x) < fspan[i] + half + 2);
  for (let x = p.x0 + 90 + rng.range(0, 60); x < p.x1 - 60; x += rng.range(DRESS.drainGap[0], DRESS.drainGap[1])) {
    if (busy(x, 1.4)) continue;
    bankDecal(kit, p, decal, tex.drain, x - 1.3, x + 1.3, rng.chance(0.5) ? 1 : -1, F + 0.1, T - 1.8, 3);
  }

  // ----- Water: the low flow trickle (a dark mirror, on under the decks) and puddles on the floor.
  const wo = CITY.districts.river.waterOffset;
  const wh = CITY.districts.river.waterHalf;
  {
    let last: [number, number] | null = null;
    for (const x of xs) {
      const z0 = zc(x) + wo - wh;
      const z1 = zc(x) + wo + wh;
      const v0 = wet.vertex(x, hLow(x, z0) + 0.035, z0, 0, 1, 0, x / 8, 0, TINT.water);
      const v1 = wet.vertex(x, hLow(x, z1) + 0.035, z1, 0, 1, 0, x / 8, 1, TINT.water);
      if (last) wet.quadFacing(last[0], last[1], v1, v0, 0, 1, 0);
      last = [v0, v1];
    }
  }
  for (let x = p.x0 + 50 + rng.range(0, 40); x < p.x1 - 50; x += rng.range(DRESS.puddleGap[0], DRESS.puddleGap[1])) {
    if (busy(x, 4)) continue;
    const r0 = rng.range(DRESS.puddleRadius[0], DRESS.puddleRadius[1]);
    const l = rng.chance(0.65) ? -rng.range(3, F - r0 - 1) : rng.range(wo + wh + r0 + 0.5, F - r0 - 1);
    const czp = zc(x) + l;
    const c = wet.vertex(x, hLow(x, czp) + 0.03, czp, 0, 1, 0, 0, 0, TINT.puddle);
    const ring: number[] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const rr = r0 * rng.range(0.7, 1.15);
      const px = x + Math.cos(ang) * rr * 1.6;
      const pz = czp + Math.sin(ang) * rr;
      ring.push(wet.vertex(px, hLow(px, pz) + 0.03, pz, 0, 1, 0, 0, 0, TINT.puddle));
    }
    for (let i = 0; i < n; i++) wet.triFacing(c, ring[i], ring[(i + 1) % n], 0, 1, 0);
  }

  // ----- A faded dashed line along each floor edge (shared paint builder, on the channel level).
  const line = col(0xd8d2a0, 0.55);
  for (const s of [-1, 1]) {
    for (let i = 0; i + 1 < xs.length; i++) {
      if (Math.floor(xs[i] / 4) % 2) continue;
      const l = s * (F - DRESS.floorEdgeLine);
      lineLow(kit.paint, { x: xs[i], z: zc(xs[i]) + l }, { x: xs[i + 1], z: zc(xs[i + 1]) + l }, 0.15, 0.04, line);
    }
  }

  // ----- Meshes: five of the river's own, disposed with the scene; the textures live per seed.
  const add = (gb: GeoBuilder, name: string, mat: THREE.Material, order = 0): THREE.Mesh | null => {
    if (!gb.vertexCount) return null;
    const m = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
    m.name = name;
    m.renderOrder = order;
    kit.group.add(m);
    return m;
  };
  const concreteMat = new THREE.MeshStandardMaterial({ map: tex.concrete, vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.35 });
  add(concrete, 'riverConcrete', concreteMat);
  add(
    decal,
    'riverDecals',
    new THREE.MeshStandardMaterial({ map: tex.decals, emissiveMap: tex.decals, emissive: 0xffffff, emissiveIntensity: 0.28, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.9 }),
    1,
  );
  add(fence, 'riverFence', new THREE.MeshStandardMaterial({ map: tex.chainlink, alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.45, metalness: 0.75, envMapIntensity: 0.7 }));
  add(
    wet,
    'riverWater',
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.95, transparent: true, opacity: 0.86, envMapIntensity: 2.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    1,
  );
  add(pools, 'riverLightPools', new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 2);
}

/** |l| of a wall's midpoint. */
function lFace(p: Record<string, number>, f: Wall): number {
  return Math.abs(riverL(p, (f.ax + f.bx) / 2, (f.az + f.bz) / 2));
}

/** The solids among some walls, each as its faces (the walls sharing one Wall.solid). */
function solidsOf(walls: Wall[]): Wall[][] {
  const out: Wall[][] = [];
  const seen = new Map<object, Wall[]>();
  for (const w of walls) {
    if (!w.solid) continue;
    let list = seen.get(w.solid);
    if (!list) {
      list = [];
      seen.set(w.solid, list);
      out.push(list);
    }
    list.push(w);
  }
  return out;
}

function solidCenter(faces: Wall[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const f of faces) {
    x += f.ax;
    z += f.az;
  }
  return { x: x / faces.length, z: z / faces.length };
}

/**
 * A deck's underside across the band: the slab (its bottom face and the two
 * edge faces up to the road), three girders along it. Seen from the channel
 * floor only; the road, sidewalks and parapets on top are the city's and the
 * kit's.
 */
function deckUnderside(gb: GeoBuilder, p: Record<string, number>, br: Bridge, T: number, h: (x: number, z: number) => number, flat: (gb: GeoBuilder, q: V3[], c: THREE.Color, u?: (v: V3) => number, v?: (w: V3) => number) => void): void {
  const L = T + 2.5;
  const W = br.dk + DRESS.slabOver;
  const vertical = (v: V3) => (v.x + v.z) / RIVER_TEX.concreteSpan;
  const height = (v: V3) => v.y / RIVER_TEX.concreteSpan;
  const rows = Math.max(2, Math.ceil((2 * L) / DRESS.deckRow));
  const deckY = (l: number): number => {
    const q = bridgePoint(p, br, 0, l);
    return h(q.x, q.z);
  };
  /** A strip of quads between two offset lines of the deck, from y below the deck at each row (bottom) to the road (top edge faces). */
  const strip = (wa: number, wb: number, ya: (y: number) => number, yb: (y: number) => number, c: THREE.Color, u?: (v: V3) => number, v?: (w: V3) => number) => {
    let prev: [V3, V3] | null = null;
    for (let i = 0; i <= rows; i++) {
      const l = -L + ((2 * L) * i) / rows;
      const y = deckY(l);
      const qa = bridgePoint(p, br, wa, l);
      const qb = bridgePoint(p, br, wb, l);
      const cur: [V3, V3] = [
        { x: qa.x, y: ya(y), z: qa.z },
        { x: qb.x, y: yb(y), z: qb.z },
      ];
      if (prev) flat(gb, [prev[0], prev[1], cur[1], cur[0]], c, u, v);
      prev = cur;
    }
  };
  const slab = (y: number) => y - DRESS.slab;
  const road = (y: number) => y + 0.08;
  // Bottom face (winding so it faces down), then the two edge faces facing out.
  strip(W, -W, slab, slab, TINT.slab);
  strip(-W, -W, road, slab, TINT.slab, vertical, height);
  strip(W, W, slab, road, TINT.slab, vertical, height);
  // Girders: three box beams under the slab.
  const g = DRESS.girderWidth / 2;
  for (const w of [-(br.dk - 1.6), 0, br.dk - 1.6]) {
    const low = (y: number) => y - DRESS.slab - DRESS.girder;
    strip(w + g, w - g, low, low, TINT.girder);
    strip(w - g, w - g, slab, low, TINT.girder, vertical, height);
    strip(w + g, w + g, low, slab, TINT.girder, vertical, height);
  }
}

/** Point `d` meters along a polyline, or null past its end. */
function alongPolyline(pts: Vec2[], d: number): Vec2 | null {
  let run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    if (run + len >= d) {
      const t = (d - run) / (len || 1);
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
    }
    run += len;
  }
  return null;
}

/** A sodium lamp head (shared glow builder) facing (nx, nz), with its light pooled on `ground` in front of it. */
function lamp(kit: DistrictKit, pools: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, strength: number, ground: Ground): void {
  const g = kit.glow;
  const c = TINT.lamp;
  const hw = 0.28;
  const hh = 0.12;
  const hd = 0.2;
  const tx = -nz;
  const tz = nx;
  const corners = [
    [x - tx * hw - nx * hd, z - tz * hw - nz * hd],
    [x + tx * hw - nx * hd, z + tz * hw - nz * hd],
    [x + tx * hw + nx * hd, z + tz * hw + nz * hd],
    [x - tx * hw + nx * hd, z - tz * hw + nz * hd],
  ];
  const lo = corners.map(([cx, cz]) => g.vertex(cx, y - hh, cz, 0, -1, 0, 0, 0, c));
  const hi = corners.map(([cx, cz]) => g.vertex(cx, y + hh, cz, 0, 1, 0, 0, 0, c));
  g.quadFacing(lo[0], lo[1], lo[2], lo[3], 0, -1, 0);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mx = (corners[i][0] + corners[j][0]) / 2 - x;
    const mz = (corners[i][1] + corners[j][1]) / 2 - z;
    g.quadFacing(lo[i], lo[j], hi[j], hi[i], mx, 0, mz);
  }
  // Light pool: an additive fan on the ground, bright at the center, fading to nothing at the rim.
  const R = 8 * strength;
  const px = x + nx * 2.5;
  const pz = z + nz * 2.5;
  const center = pools.vertex(px, ground(px, pz) + 0.05, pz, 0, 1, 0, 0, 0, TINT.pool.clone().multiplyScalar(0.55 * strength));
  const rim: number[] = [];
  const n = 12;
  const black = col(0x000000);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const rx = px + Math.cos(ang) * R;
    const rz = pz + Math.sin(ang) * R * 0.75;
    rim.push(pools.vertex(rx, ground(rx, rz) + 0.05, rz, 0, 1, 0, 0, 0, black));
  }
  for (let i = 0; i < n; i++) pools.triFacing(center, rim[i], rim[(i + 1) % n], 0, 1, 0);
}

/** A vertical decal quad on a wall face: from a to b along the wall, `height` m tall, `off` in front of it. */
function decalQuad(gb: GeoBuilder, uv: UvRect, a: V3, b: V3, height: number, nx: number, nz: number, off: number): void {
  const white = col(0xffffff);
  const v = [
    gb.vertex(a.x + nx * off, a.y, a.z + nz * off, nx, 0, nz, uv.u0, uv.v0, white),
    gb.vertex(b.x + nx * off, b.y, b.z + nz * off, nx, 0, nz, uv.u1, uv.v0, white),
    gb.vertex(b.x + nx * off, b.y + height, b.z + nz * off, nx, 0, nz, uv.u1, uv.v1, white),
    gb.vertex(a.x + nx * off, a.y + height, a.z + nz * off, nx, 0, nz, uv.u0, uv.v1, white),
  ];
  gb.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
}

/**
 * A decal draped on a bank face between x0..x1 and |l| from lo (near the
 * floor) to hi (near the top), on bank `s`, reading left to right for a
 * viewer standing on the floor.
 */
function bankDecal(kit: DistrictKit, p: Record<string, number>, gb: GeoBuilder, uv: UvRect, x0: number, x1: number, s: number, lo: number, hi: number, segs: number): void {
  const rows = 4;
  const white = col(0xffffff);
  let prev: number[] | null = null;
  for (let j = 0; j <= rows; j++) {
    const al = lo + ((hi - lo) * j) / rows;
    const v = uv.v0 + (uv.v1 - uv.v0) * (j / rows);
    const row: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const x = x0 + ((x1 - x0) * i) / segs;
      const z = riverCenter(p, x) + s * al;
      const t = i / segs;
      // Seen from the floor, the bank at +l has the viewer's right toward -x, the other toward +x.
      const u = s > 0 ? uv.u1 - (uv.u1 - uv.u0) * t : uv.u0 + (uv.u1 - uv.u0) * t;
      const sl = kit.world.slopeAt(x, z);
      const l = Math.hypot(sl.gx, 1, sl.gz);
      row.push(gb.vertex(x, kit.h(x, z) + 0.05, z, -sl.gx / l, 1 / l, -sl.gz / l, u, v, white));
    }
    if (prev) for (let i = 0; i < segs; i++) gb.quadFacing(prev[i], prev[i + 1], row[i + 1], row[i], 0, 1, 0);
    prev = row;
  }
}
