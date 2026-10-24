/**
 * The elevated highway in the finished world. settleHighway gives the deck
 * its heights once the terrain exists (the ground across it dilated and
 * smoothed along it plus the clearance, with a hump over the El's trains from
 * the El's own track curve), then every barrier, column and ramp wall its
 * level and every ramp its profile; settleHighwayWalls makes every other wall
 * under the deck one only cars below meet. In a race the ramps are shut at
 * their mouths (highwayGates); a reset up on the highway puts the car back on
 * the deck (highwayResetPose). Called by world.ts and sim/race.ts.
 */
import { CITY } from '../../config';
import type { Wall } from '../../blocks';
import type { Terrain } from '../../terrain';
import { cos, sin, yawOf } from '../../../sim/math';
import type { Area, AreaBuild, DeckSpan, HeightSample } from '../types';
import { distToPolygonEdge, pointInPolygon, polygonBounds, solidWalls } from '../geom';
import { elCurve } from '../subway';
import { RAIL, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { axisAt, rampHeightAlong, solveGrade } from './rampAxis';
import { HALF, deckPoint, deckTopAt, deckUnderAt, highwayDeck, highwayRamp, laneCenter, rightOf } from './shape';
import { pending, rampPending } from './build';

const CFG = CITY.districts.highway;

/** A parapet or the median stops cars within this much below the deck top (m); below that they pass under it. */
const BARRIER_REACH = 2.6;

/** A column stops cars up to this far under the deck's underside (m); a car above it is on the deck. */
const COLUMN_REACH = 1.2;

/**
 * Give the deck its heights from the finished terrain (the ground across it, dilated and smoothed
 * along it, plus the clearance; over the El a hump that clears its trains, from the El's own track
 * curve), then every barrier, column and ramp wall its level and every ramp its profile. Called by
 * createCity once the terrain exists (before the blocks: their walls are the builds').
 */
export function settleHighway(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  for (const area of areas) {
    if (area.kind !== 'highway' || area.variant !== 'deck') continue;
    const deck = highwayDeck(area, areas);
    const c = deck.curve;
    const n = c.n;
    const ground = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = rightOf(c.tx[i], c.tz[i]);
      let gm = -Infinity;
      for (const v of [-HALF - 2, 0, HALF + 2]) gm = Math.max(gm, terrain.heightAt(c.x[i] + r.x * v, c.z[i] + r.z * v));
      ground[i] = gm;
    }
    const kd = Math.round(30 / RAIL.step);
    const dil = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = -Infinity;
      for (let j = Math.max(0, i - kd); j <= Math.min(n - 1, i + kd); j++) v = Math.max(v, ground[j]);
      dil[i] = v;
    }
    const ks = Math.round(44 / RAIL.step);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let w = 0;
      for (let j = Math.max(0, i - ks); j <= Math.min(n - 1, i + ks); j++) {
        sum += dil[j];
        w++;
      }
      deck.under[i] = sum / w + CFG.clearance;
    }
    // Over the El: the underside clears its tie top by elClear wherever the two decks overlap.
    const sub = areas.find((a) => a.kind === 'subway');
    if (sub && Number.isFinite(deck.sEl)) {
      const el = elCurve(sub, builds[sub.id], terrain.heightAt);
      const reach = CITY.districts.subway.deckWidth / 2 + 3 + HALF;
      let need = 0;
      let lo = Infinity;
      let hi = -Infinity;
      const Q = curvePoint();
      for (let i = 0; i < n; i++) {
        const s = i * RAIL.step;
        if (Math.abs(s - deck.sEl) > 80) continue;
        const pr = projectOnCurve(el, c.x[i], c.z[i]);
        sampleCurve(el, pr.s, Q);
        if (Math.hypot(Q.x - c.x[i], Q.z - c.z[i]) > reach) continue;
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
        need = Math.max(need, Q.y + CFG.elClear - deck.under[i]);
      }
      if (need > 0) {
        const ease = Math.max(60, (1.6 * need) / CFG.humpGrade);
        for (let i = 0; i < n; i++) {
          const s = i * RAIL.step;
          const out = s < lo ? lo - s : s > hi ? s - hi : 0;
          if (out >= ease) continue;
          const t = 1 - out / ease;
          deck.under[i] += need * t * t * (3 - 2 * t);
        }
      }
    }
    for (let i = 0; i < n; i++) deck.top[i] = deck.under[i] + CFG.depth;
    deck.settled = true;
    for (const p of pending.get(builds[area.id]) ?? []) {
      const h = p.kind === 'bottom' ? deckTopAt(deck, p.s) - BARRIER_REACH : deckUnderAt(deck, p.s) - COLUMN_REACH;
      for (const w of p.walls) {
        if (p.kind === 'bottom') w.bottom = h;
        else w.under = h;
      }
    }
    // The ramps: from the ground at the foot to the deck's top and grade at the gore nose.
    for (const r of deck.ramps) {
      const ax = r.axis;
      const pr = r.profile;
      pr.y0 = terrain.heightAt(ax.fx, ax.fz);
      const sl = terrain.slopeAt(ax.fx, ax.fz);
      pr.g0 = sl.gx * ax.dx + sl.gz * ax.dz;
      pr.y1 = deckTopAt(deck, r.sa);
      pr.g1 = ((deckTopAt(deck, r.sa + 1) - deckTopAt(deck, r.sa - 1)) / 2) * r.side;
      pr.grade = solveGrade(ax.length, pr.y0, pr.g0, pr.y1, pr.g1, pr.e0, pr.e1);
      pr.ready = true;
      r.terrain = terrain;
      for (const p of rampPending.get(builds[r.area.id]) ?? []) {
        let h: number;
        if (p.kind === 'side') {
          const y = rampHeightAlong(ax, pr, p.u).y;
          const q = axisAt(ax, p.u);
          // On the embankment (a solid level) a side wall is a plain wall to everyone; on the bridge stretch
          // at the top, high over the ground, it only stops cars up on the ramp.
          if (p.u < r.uSolid || y - terrain.heightAt(q.x, q.z) < 4) continue;
          h = y - BARRIER_REACH;
          for (const w of p.walls) w.bottom = h;
        } else if (p.kind === 'column') {
          h = rampHeightAlong(ax, pr, p.u).y - BARRIER_REACH;
          for (const w of p.walls) w.under = h;
        } else if (p.kind === 'merge') {
          h = deckTopAt(deck, p.s) - BARRIER_REACH;
          for (const w of p.walls) w.bottom = h;
        } else {
          h = deckUnderAt(deck, p.s) - 4;
          for (const w of p.walls) w.under = h;
        }
      }
    }
  }
}

/**
 * Every other wall that stands under the deck (the El's columns where the lines cross, the frontage
 * where the deck runs through a block, district walls) stops only cars below it: Wall.under from the
 * deck over it. Called by createCity once the blocks' walls exist.
 */
export function settleHighwayWalls(areas: readonly Area[], builds: readonly AreaBuild[], walls: readonly Wall[]): void {
  const spans: { d: DeckSpan; minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
  for (const a of areas) {
    if (a.kind !== 'highway') continue;
    for (const d of builds[a.id].decks) if (!d.solid) spans.push({ d, ...polygonBounds(d.polygon) });
  }
  if (!spans.length) return;
  // A coarse grid of the spans, so each wall checks the few near it.
  const CELL = 32;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const s of spans) {
    x0 = Math.min(x0, s.minX);
    z0 = Math.min(z0, s.minZ);
    x1 = Math.max(x1, s.maxX);
    z1 = Math.max(z1, s.maxZ);
  }
  const cols = Math.max(1, Math.ceil((x1 - x0) / CELL));
  const rows = Math.max(1, Math.ceil((z1 - z0) / CELL));
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  spans.forEach((s, id) => {
    for (let j = Math.max(0, Math.floor((s.minZ - 1 - z0) / CELL)); j <= Math.min(rows - 1, Math.floor((s.maxZ + 1 - z0) / CELL)); j++) {
      for (let i = Math.max(0, Math.floor((s.minX - 1 - x0) / CELL)); i <= Math.min(cols - 1, Math.floor((s.maxX + 1 - x0) / CELL)); i++) cells[j * cols + i].push(id);
    }
  });
  const sample: HeightSample = { h: 0, gx: 0, gz: 0 };
  /** The lowest deck over a wall (sampled along it), Infinity when no deck is over it. */
  const lowest = (w: Wall): number => {
    let h = Infinity;
    for (let t = 0; t <= 1; t += 0.25) {
      const x = w.ax + (w.bx - w.ax) * t;
      const z = w.az + (w.bz - w.az) * t;
      if (x < x0 - 1 || x > x1 + 1 || z < z0 - 1 || z > z1 + 1) continue;
      const i = Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / CELL)));
      const j = Math.min(rows - 1, Math.max(0, Math.floor((z - z0) / CELL)));
      for (const id of cells[j * cols + i]) {
        const s = spans[id];
        if (x < s.minX - 1 || x > s.maxX + 1 || z < s.minZ - 1 || z > s.maxZ + 1) continue;
        if (!pointInPolygon(x, z, s.d.polygon) && distToPolygonEdge(x, z, s.d.polygon) > 0.8) continue;
        s.d.upper!(x, z, sample);
        h = Math.min(h, sample.h);
      }
    }
    return h;
  };
  const own = (w: Wall) => w.area !== undefined && areas[w.area]?.kind === 'highway';
  // A solid's faces move together (World.collideCircle handles a solid as one body).
  const solids = new Map<object, Wall[]>();
  for (const w of walls) {
    if (!w.solid) continue;
    let list = solids.get(w.solid);
    if (!list) solids.set(w.solid, (list = []));
    list.push(w);
  }
  const free = (w: Wall) => w.under === undefined && w.bottom === undefined && w.top === undefined && !own(w);
  for (const w of walls) {
    if (w.solid || !free(w)) continue;
    const h = lowest(w);
    if (Number.isFinite(h)) w.under = h - BARRIER_REACH - 1;
  }
  for (const faces of solids.values()) {
    if (!faces.every(free)) continue;
    let h = Infinity;
    for (const f of faces) h = Math.min(h, lowest(f));
    if (!Number.isFinite(h)) continue;
    for (const f of faces) f.under = h - BARRIER_REACH - 1;
  }
}

/** In a race the ramps are shut at their mouths (two sided slabs across them, drawn as cyan barriers); open in free roam. */
export function highwayGates(areas: readonly Area[]): Wall[] {
  const out: Wall[] = [];
  for (const a of areas) {
    if (a.kind !== 'highway' || a.variant !== 'ramp') continue;
    const ax = highwayRamp(a).axis;
    const q0 = axisAt(ax, 1.4);
    const q1 = axisAt(ax, 2.0);
    const v = CFG.rampHalf + 0.4;
    const slab = [
      { x: q0.x + q0.tz * v, z: q0.z - q0.tx * v },
      { x: q1.x + q1.tz * v, z: q1.z - q1.tx * v },
      { x: q1.x - q1.tz * v, z: q1.z + q1.tx * v },
      { x: q0.x - q0.tz * v, z: q0.z + q0.tx * v },
    ];
    out.push(...solidWalls(slab, 'highway', a.id));
  }
  return out;
}

/**
 * A reset on the highway (free roam): onto the slow (outer) lane of the carriageway the car was heading
 * along, at the nearest point of the deck clear of the closures and the ramps' merges, facing along
 * it, at the deck's height. Null when the world has no highway.
 */
export function highwayResetPose(areas: readonly Area[], x: number, z: number, yaw: number): { x: number; z: number; yaw: number; y: number } | null {
  let best: { x: number; z: number; yaw: number; y: number } | null = null;
  let bestD = Infinity;
  for (const a of areas) {
    if (a.kind !== 'highway' || a.variant !== 'deck') continue;
    const d = highwayDeck(a, areas);
    if (!d.settled) continue;
    const c = d.curve;
    const pr = projectOnCurve(c, x, z);
    let s = Math.max(d.sW + 30, Math.min(d.sE - 30, pr.s));
    const P = curvePoint();
    sampleCurve(c, s, P);
    const dir = sin(yaw) * P.tx + cos(yaw) * P.tz >= 0 ? 1 : -1;
    for (const r of d.ramps) {
      const lo = Math.min(r.sa, r.sb) - 12;
      const hi = Math.max(r.sa, r.sb) + 12;
      if (s >= lo && s <= hi) s = dir > 0 ? Math.min(d.sE - 30, hi + 6) : Math.max(d.sW + 30, lo - 6);
    }
    sampleCurve(c, s, P);
    const lat = laneCenter(CFG.lanes - 1);
    const p = deckPoint(c, s, dir * lat);
    const dist = Math.hypot(p.x - x, p.z - z);
    if (dist < bestD) {
      bestD = dist;
      best = { x: p.x, z: p.z, yaw: yawOf(P.tx * dir, P.tz * dir), y: deckTopAt(d, s) };
    }
  }
  return best;
}
