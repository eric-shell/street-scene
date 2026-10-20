/**
 * River renderer: the concrete flood channel as a race venue. Stained,
 * jointed concrete (riverTextures.ts) over the floor and the sloped banks,
 * following the sim terrain so every ramp trench and bridge body is exactly
 * where the collision says; the entrance ramps with their trench faces and
 * the raised plinths beside them (the sim's 'trench' walls); graffiti murals
 * and storm drain outlets on the banks; a chain-link fence on posts along
 * the bank tops with sodium lamps pooling light down the slope; arched
 * culvert recesses with lamps on the solid bridge bodies; the low flow
 * trickle and puddles as dark mirrors; lit tunnel portals at both ends; a
 * painted edge line along the floor. Five merged meshes of its own (concrete,
 * decals, fence, wet, light pools) plus the kit's shared builders. Render
 * only: the walls it draws are the river district's own.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Ramp } from '../../city/districts/river';
import { rampAlong, rampPoint, rampsOf, riverCenter } from '../../city/districts/river';
import type { Area } from '../../city/districts/types';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { RIVER_TEX, UvRect, riverTextures } from '../riverTextures';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundLine, wallBox } from './kit';

/** Layout of the dressing (m), lamp and tint choices. */
const DRESS = {
  /** Plinth top above the ground beside a trench, and the fence height. */
  plinth: 0.5,
  fence: 1.8,
  postSpacing: 3,
  /** Sodium lamps along each bank top, staggered between the banks. */
  lampSpacing: 38,
  lampHeight: 5.2,
  /** Murals and drains along the banks: spacing ranges (m) and mural widths (m). */
  muralGap: [55, 120],
  muralWidth: [12, 22],
  drainGap: [70, 130],
  /** Puddles on the floor: spacing (m), radius (m). */
  puddleGap: [40, 95],
  puddleRadius: [1.4, 3],
  /** Row spacing of the channel surface (m), and near bridge bodies, ramps and the ends. */
  rowStep: 8,
  rowStepFine: 1.5,
  floorEdgeLine: 0.5,
  /** Lamps on the plinths down each ramp (m apart) and the dashed lines along its trench edges. */
  rampLampSpacing: 16,
  rampLineInset: 0.35,
} as const;

/** Vertex tints multiplying the concrete texture (which carries the grey), and the lamp colours. */
const TINT = {
  floor: col(0xffffff, 0.95),
  bank: col(0xffffff, 1.08),
  plinth: col(0xffffff, 1.2),
  trench: col(0xffffff, 1.0),
  wall: col(0xffffff, 1.05),
  culvert: col(0xffffff, 0.9),
  portal: col(0xffffff, 0.85),
  waterLine: col(0xffffff, 0.72),
  post: col(0x9aa0a8),
  pole: col(0x6a6e76),
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

/** One column of a ramp zone row: where it is, how far above the terrain, and its tint. */
interface Col {
  x: number;
  z: number;
  lift: number;
  tint: THREE.Color;
}

function buildChannel(kit: DistrictKit, a: Area): void {
  const p = a.params;
  const F = p.floor;
  const T = p.top;
  const fenceL = T + 0.5;
  const tex = riverTextures(kit.world.seed);
  const rng = new Rng(((p.seed ?? kit.world.seed) ^ 0x7a9) >>> 0 || 1);
  const ramps = rampsOf(a);
  const build = kit.builds[a.id];
  const bridges = build.hints.filter((hint) => hint.kind === 'bridge').map((hint) => ({ x: (hint.points[0].x + hint.points[2].x) / 2, half: Math.abs(hint.points[2].x - hint.points[0].x) / 2 + 2 }));
  const zc = (x: number) => riverCenter(p, x);
  const h = kit.h;

  const concrete = new GeoBuilder(true);
  const decal = new GeoBuilder(true);
  const fence = new GeoBuilder(true);
  const wet = new GeoBuilder(true);
  const pools = new GeoBuilder(true);
  const span = RIVER_TEX.concreteSpan;

  const normal = (x: number, z: number): [number, number, number] => {
    const s = kit.world.slopeAt(x, z);
    const l = Math.hypot(s.gx, 1, s.gz);
    return [-s.gx / l, 1 / l, -s.gz / l];
  };
  /** Surface vertex on the terrain plus a lift, world mapped. */
  const gv = (gb: GeoBuilder, x: number, z: number, lift: number, c: THREE.Color): number => {
    const n = normal(x, z);
    return gb.vertex(x, h(x, z) + lift, z, n[0], n[1], n[2], x / span, z / span, c);
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

  // ----- The channel surface: rows of constant l across the band, draped on the terrain. Where a
  // ramp cuts the bank, columns follow its trench and the raised plinths either side, so the drops
  // are true vertical faces and the plinth tops sit DRESS.plinth above the bank.
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
  const fine = (x: number) => bridges.some((b) => Math.abs(x - b.x) < b.half + 14) || x < p.x0 + 20 || x > p.x1 - 20;
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
  const inZone = (x: number) => zones.some((zn) => x > zn.lo - 0.05 && x < zn.hi + 0.05);
  // Plain panels between the zones (and the channel ends).
  const bounds = [p.x0, ...zones.flatMap((zn) => [zn.lo, zn.hi]), p.x1];
  for (let b = 0; b + 1 < bounds.length; b += 2) {
    const cols = [bounds[b], ...xs.filter((x) => x > bounds[b] + 0.05 && x < bounds[b + 1] - 0.05 && !inZone(x)), bounds[b + 1]];
    let prev: number[] | null = null;
    for (const l of ls) {
      const row = cols.map((x) => gv(concrete, x, zc(x) + l, 0.02, tintAt(l)));
      if (prev) for (let i = 0; i + 1 < row.length; i++) concrete.quadFacing(prev[i], prev[i + 1], row[i + 1], row[i], 0, 1, 0);
      prev = row;
    }
  }
  /** The ten columns of a ramp zone row: outside, plinth outer face (ground / top), plinth top to the trench face, the trench, and back. */
  const LATS = (r: Ramp) => [-(r.hw + r.body + 0.02), -(r.hw + r.body - 0.02), -(r.hw + 0.02), -(r.hw - 0.02), r.hw - 0.02, r.hw + 0.02, r.hw + r.body - 0.02, r.hw + r.body + 0.02];
  /** Lift and tint per column (index into LATS) while the plinths stand. */
  const colLift = (i: number, plinth: boolean): number => (plinth && i >= 1 && i <= 2) || (plinth && i >= 5 && i <= 6) ? DRESS.plinth : 0.02;
  const colTint = (i: number, plinth: boolean, l: number): THREE.Color => (!plinth ? tintAt(l) : i === 3 || i === 4 ? TINT.trench : i === 0 || i === 7 ? tintAt(l) : TINT.plinth);
  for (const zn of zones) {
    const rampOn = (s: number) => zn.ramps.find((r) => r.side === s) ?? null;
    const colsAt = (l: number): Col[] => {
      const s = l >= 0 ? 1 : -1;
      const al = Math.abs(l);
      const r = rampOn(s);
      const base = (x: number): Col => ({ x, z: zc(x) + l, lift: 0.02, tint: tintAt(l) });
      if (!r) {
        // The other bank or the floor under a lone side ramp: the same columns straight across.
        const o = zn.ramps[0];
        return [base(zn.lo), ...LATS(o).map((lat) => base(o.ax - o.uz * lat)), base(zn.hi)];
      }
      const along = al > F ? rampAlong(p, r, al) : al;
      const plinth = al > F + 1e-6;
      const mid: Col[] = LATS(r).map((lat, i) => {
        const w = rampPoint(r, along, lat);
        return { x: w.x, z: w.z, lift: colLift(i, plinth), tint: colTint(i, plinth, l) };
      });
      return [base(zn.lo), ...mid, base(zn.hi)];
    };
    const rows: number[] = [];
    for (const l of ls) {
      rows.push(l);
      // A second row a hair past the floor edge on a ramp's bank: the plinth's foot is a vertical cap.
      if (Math.abs(Math.abs(l) - F) < 1e-6 && rampOn(l >= 0 ? 1 : -1)) rows.push(l + (l >= 0 ? 1 : -1) * 1e-4);
    }
    let prev: V3[] | null = null;
    for (const l of rows) {
      const cols = colsAt(l);
      const row: V3[] = cols.map((c) => ({ x: c.x, y: h(c.x, c.z) + c.lift, z: c.z }));
      if (prev) for (let i = 0; i + 1 < row.length; i++) flat(concrete, [prev[i], prev[i + 1], row[i + 1], row[i]], cols[i].tint);
      prev = row;
    }
  }

  // ----- Ramp trenches beyond the band: up the bank top to the plinth caps at the top of the run and,
  // for side ramps, the flat mouth on to the street curb.
  for (const r of ramps) {
    const aFence = rampAlong(p, r, fenceL);
    const aTop = rampAlong(p, r, r.topL);
    const aEnd = r.ford ? aTop : rampAlong(p, r, r.curbL);
    const lats = LATS(r);
    const rowAt = (along: number, plinth: boolean): V3[] =>
      lats.map((lat, i) => {
        // Past the top the plinths are gone: every column collapses onto the trench edges.
        const q = plinth ? lat : Math.sign(lat) * (r.hw - 0.02);
        const w = rampPoint(r, along, q);
        return { x: w.x, y: h(w.x, w.z) + colLift(i, plinth), z: w.z };
      });
    const alongs: [number, boolean][] = [];
    for (let s = aFence; s < aTop - 0.05; s += 2) alongs.push([s, true]);
    alongs.push([aTop, true], [aTop + 1e-4, false]);
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
        groundLine(kit, kit.paint, rampPoint(r, s, q), rampPoint(r, Math.min(aTop - 0.5, s + 2.4), q), 0.14, 0.04, col(0xd8d2a0, 0.55));
      }
    }
    let lampSide = 1;
    for (let s = aF + 7; s < aTop - 3; s += DRESS.rampLampSpacing) {
      const q = lampSide * (r.hw + r.body / 2);
      const w = rampPoint(r, s, q);
      const y = h(w.x, w.z) + DRESS.plinth;
      cylinder(kit.solid, w.x, w.z, 0.07, y - 0.1, y + 3.6, 6, TINT.pole, true);
      // Head over the trench edge, facing across it.
      const hx = -lampSide * -r.uz;
      const hz = -lampSide * r.ux;
      const head = rampPoint(r, s, q - lampSide * 0.9);
      lamp(kit, pools, head.x, y + 3.5, head.z, hx, hz, 0.65);
      lampSide = -lampSide;
    }
  }

  // ----- Bridges: culvert faces from the floor to the deck, arched recesses and lamps.
  for (const w of kit.walls.get('culvert') ?? []) {
    if (w.area !== a.id) continue;
    const top = Math.max(h(w.ax - w.nx * 4.5, w.az - w.nz * 4.5), h(w.bx - w.nx * 4.5, w.bz - w.nz * 4.5)) + 0.05;
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const steps = Math.max(2, Math.ceil(len / 4));
    let last: [V3, V3] | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = w.ax + (w.bx - w.ax) * t;
      const z = w.az + (w.bz - w.az) * t;
      const lo = { x, y: h(x + w.nx * 0.3, z + w.nz * 0.3) - 0.3, z };
      const hi = { x, y: top, z };
      if (last) flat(concrete, [last[0], lo, hi, last[1]], TINT.culvert, vertical, height);
      last = [lo, hi];
    }
    const dx = (w.bx - w.ax) / len;
    const dz = (w.bz - w.az) / len;
    const n = Math.max(1, Math.floor((2 * F) / 12));
    for (let i = 0; i < n; i++) {
      const t = 0.5 + (i - (n - 1) / 2) * (12 / len);
      const cx = w.ax + (w.bx - w.ax) * t;
      const cz = w.az + (w.bz - w.az) * t;
      const floor = h(cx + w.nx * 0.5, cz + w.nz * 0.5);
      decalQuad(decal, tex.arch, { x: cx - dx * 5, y: floor + 0.05, z: cz - dz * 5 }, { x: cx + dx * 5, y: floor + 0.05, z: cz + dz * 5 }, 4.2, w.nx, w.nz, 0.06);
      lamp(kit, pools, cx + w.nx * 0.25, floor + 4.0, cz + w.nz * 0.25, w.nx, w.nz, 0.7);
    }
  }

  // ----- Portals at both ends: a headwall, a black arch, a lamp either side.
  for (const w of kit.walls.get('channelEnd') ?? []) {
    if (w.area !== a.id) continue;
    wallBox(kit, concrete, w, 3, 7.5, TINT.portal);
    const cx = (w.ax + w.bx) / 2;
    const cz = (w.az + w.bz) / 2;
    const floor = h(cx + w.nx * 0.5, cz + w.nz * 0.5);
    decalQuad(decal, tex.portal, { x: cx, y: floor + 0.05, z: cz - 6 }, { x: cx, y: floor + 0.05, z: cz + 6 }, 5.5, w.nx, w.nz, 0.06);
    lamp(kit, pools, cx + w.nx * 0.3, floor + 5.2, cz - 7.5, w.nx, w.nz, 0.9);
    lamp(kit, pools, cx + w.nx * 0.3, floor + 5.2, cz + 7.5, w.nx, w.nz, 0.9);
  }

  // ----- Parapets on the bridge decks (shared solid builder).
  for (const w of kit.walls.get('parapet') ?? []) if (w.area === a.id) wallBox(kit, kit.solid, w, 0.45, 1.0, col(0x6a6c75));

  // ----- Fence on the bank tops: chain-link strips on posts, with the sodium lamps.
  let lampPhase = 0;
  for (const hint of build.hints) {
    if (hint.kind !== 'fence') continue;
    const s = hint.values[0];
    const pts = hint.points;
    let run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a0 = pts[i];
      const b0 = pts[i + 1];
      const len = Math.hypot(b0.x - a0.x, b0.z - a0.z);
      if (len < 0.05) continue;
      const y0 = h(a0.x, a0.z);
      const y1 = h(b0.x, b0.z);
      // Normal toward the channel.
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
        cylinder(kit.solid, px, pz, 0.045, h(px, pz) - 0.2, h(px, pz) + DRESS.fence + 0.1, 5, TINT.post, true);
      }
      run += len;
    }
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
      lamp(kit, pools, px, y + DRESS.lampHeight - 0.15, az, 0, -s, 1);
    }
  }

  // ----- Murals and drains on the bank faces, clear of ramps and bridge bodies.
  const busy = (x: number, half: number) => ramps.some((r) => Math.abs(x - r.ax) < r.hw + r.body + half + 3) || bridges.some((b) => Math.abs(x - b.x) < b.half + half + 2);
  let side = rng.chance(0.5) ? 1 : -1;
  const murals: { x: number; side: number; w: number }[] = [];
  for (let x = p.x0 + 60 + rng.range(0, 40); x < p.x1 - 60; x += rng.range(DRESS.muralGap[0], DRESS.muralGap[1])) {
    const w = rng.range(DRESS.muralWidth[0], DRESS.muralWidth[1]);
    if (busy(x, w / 2)) continue;
    bankDecal(kit, p, decal, tex.mural(rng.int(0, RIVER_TEX.murals - 1)), x - w / 2, x + w / 2, side, F + 0.5, T - 0.4, 6);
    murals.push({ x, side, w });
    side = -side;
  }
  for (let x = p.x0 + 90 + rng.range(0, 60); x < p.x1 - 60; x += rng.range(DRESS.drainGap[0], DRESS.drainGap[1])) {
    if (busy(x, 1.4)) continue;
    bankDecal(kit, p, decal, tex.drain, x - 1.3, x + 1.3, rng.chance(0.5) ? 1 : -1, F + 0.1, T - 1.8, 3);
  }

  // ----- Water: the low flow trickle (a dark mirror) and puddles on the floor.
  const wo = CITY.districts.river.waterOffset;
  const wh = CITY.districts.river.waterHalf;
  {
    let last: [number, number] | null = null;
    for (const x of xs) {
      const z0 = zc(x) + wo - wh;
      const z1 = zc(x) + wo + wh;
      const v0 = wet.vertex(x, h(x, z0) + 0.035, z0, 0, 1, 0, x / 8, 0, TINT.water);
      const v1 = wet.vertex(x, h(x, z1) + 0.035, z1, 0, 1, 0, x / 8, 1, TINT.water);
      if (last) wet.quadFacing(last[0], last[1], v1, v0, 0, 1, 0);
      last = [v0, v1];
    }
  }
  for (let x = p.x0 + 50 + rng.range(0, 40); x < p.x1 - 50; x += rng.range(DRESS.puddleGap[0], DRESS.puddleGap[1])) {
    if (busy(x, 4)) continue;
    const r0 = rng.range(DRESS.puddleRadius[0], DRESS.puddleRadius[1]);
    const l = rng.chance(0.65) ? -rng.range(3, F - r0 - 1) : rng.range(wo + wh + r0 + 0.5, F - r0 - 1);
    const czp = zc(x) + l;
    const c = wet.vertex(x, h(x, czp) + 0.03, czp, 0, 1, 0, 0, 0, TINT.puddle);
    const ring: number[] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const rr = r0 * rng.range(0.7, 1.15);
      const px = x + Math.cos(ang) * rr * 1.6;
      const pz = czp + Math.sin(ang) * rr;
      ring.push(wet.vertex(px, h(px, pz) + 0.03, pz, 0, 1, 0, 0, 0, TINT.puddle));
    }
    for (let i = 0; i < n; i++) wet.triFacing(c, ring[i], ring[(i + 1) % n], 0, 1, 0);
  }

  // ----- A faded dashed line along each floor edge (shared paint builder).
  const line = col(0xd8d2a0, 0.55);
  for (const s of [-1, 1]) {
    for (let i = 0; i + 1 < xs.length; i++) {
      if (Math.floor(xs[i] / 4) % 2) continue;
      const l = s * (F - DRESS.floorEdgeLine);
      groundLine(kit, kit.paint, { x: xs[i], z: zc(xs[i]) + l }, { x: xs[i + 1], z: zc(xs[i + 1]) + l }, 0.15, 0.04, line);
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
  add(concrete, 'riverConcrete', new THREE.MeshStandardMaterial({ map: tex.concrete, vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.35 }));
  const decalMesh = add(
    decal,
    'riverDecals',
    new THREE.MeshStandardMaterial({ map: tex.decals, emissiveMap: tex.decals, emissive: 0xffffff, emissiveIntensity: 0.28, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.9 }),
    1,
  );
  // Where the murals are (for tools and tests looking at the banks).
  if (decalMesh) decalMesh.userData.murals = murals;
  add(fence, 'riverFence', new THREE.MeshStandardMaterial({ map: tex.chainlink, alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true, roughness: 0.45, metalness: 0.75, envMapIntensity: 0.7 }));
  add(
    wet,
    'riverWater',
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.95, transparent: true, opacity: 0.86, envMapIntensity: 2.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    1,
  );
  add(pools, 'riverLightPools', new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 2);
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

/** A sodium lamp head (shared glow builder) facing (nx, nz), with its light pooled on the ground in front. */
function lamp(kit: DistrictKit, pools: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, strength: number): void {
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
  const center = pools.vertex(px, kit.h(px, pz) + 0.05, pz, 0, 1, 0, 0, 0, TINT.pool.clone().multiplyScalar(0.55 * strength));
  const rim: number[] = [];
  const n = 12;
  const black = col(0x000000);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const rx = px + Math.cos(ang) * R;
    const rz = pz + Math.sin(ang) * R * 0.75;
    rim.push(pools.vertex(rx, kit.h(rx, rz) + 0.05, rz, 0, 1, 0, 0, 0, black));
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
