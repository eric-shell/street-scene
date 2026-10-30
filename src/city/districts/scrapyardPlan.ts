/**
 * Where the scrapyard goes and how it sits in its block (districts/scrapyard.ts plans with this).
 *
 * Sites come from routeFrontageSites (weekendSites.ts): one plain block with at least CFG.minFrontage m of
 * route street, best first (frontage on both routes, then the longer frontage), convex blocks ahead of the
 * rest because the fence follows the block's ring and a convex ring is the one the yard's rectangle fits
 * round. For each site the bowls' crest radius is tried largest first (CFG.crestRadii); the first that fits
 * wins, and a site where none does is passed over, so a seed whose blocks are all too small plans nothing.
 *
 * Fit. The yard is a rectangle (scrapyardLayout.ts: L x D, set by the bowl radius and the canyon's length)
 * kept CFG.perimeter m inside the ring all round, on ground mild enough for a flat dirt floor. Its frame is
 * square with a street the route drives (the chord of that street's piece of the ring) or across it; the
 * rectangle is slid as near that street as it goes, so the bowls face the route. Which end the canyon stands at
 * (the layout mirrored in u) comes from the stream, drawn before anything that could reject a site.
 *
 * Cuts. The fence follows the ring and opens in two or three curb cuts on the streets the routes drive (the
 * street's own curb frame, busBays.ts mouthBay: the whole sidewalk deep, flared returns), each in the middle of
 * the longest straight piece of that street's side; a street the route does not drive stands in when fewer than
 * two route streets have a piece long enough. The route streets' edges are claimed (area.edges) so the night
 * market and the lane closures keep off the street the yard opens on.
 */
import { CITY } from '../config';
import type { BlockFace } from '../blocks';
import { computeMouths } from '../blocks';
import { edgeSides } from '../props';
import { type Terrain, createTerrain } from '../terrain';
import { type Vec2, abs, sqrt } from '../../sim/math';
import { distToPolygonEdge, pointInPolygon } from './geom';
import type { PlanContext } from './types';
import { routeFrontageSites } from './weekendSites';
import type { FrontageSite } from './weekendSites';
import { canyonStacks, yardDepth, yardDims } from './scrapyardLayout';

const C = CITY.districts.scrapyard;

/** Grid step (m) the rectangle is slid over the block by. */
const STEP = 4;
/** Spacing (m) of the samples along the rectangle's edges that must keep the perimeter clear. */
const EDGE_STEP = 6;

const dist = (a: Vec2, b: Vec2) => sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

/** A fitted rectangle: origin corner and its two unit axes (u along its length). */
interface Fit {
  o: Vec2;
  u: Vec2;
  w: Vec2;
  /** Slide score (lower is nearer the front street). */
  score: number;
}

/**
 * Slide an L x D rectangle with axes (u, w) over the ring and return the best position that keeps `pad` m inside it
 * all round, or null. `w` points into the block.
 */
function fitRect(ring: Vec2[], u: Vec2, w: Vec2, L: number, D: number, pad: number): Fit | null {
  const O = ring[0];
  const uv = ring.map((p) => ({ x: (p.x - O.x) * u.x + (p.z - O.z) * u.z, z: (p.x - O.x) * w.x + (p.z - O.z) * w.z }));
  const minU = Math.min(...uv.map((p) => p.x));
  const maxU = Math.max(...uv.map((p) => p.x));
  const minW = Math.min(...uv.map((p) => p.z));
  const maxW = Math.max(...uv.map((p) => p.z));
  if (maxU - minU < L + 2 * pad || maxW - minW < D + 2 * pad) return null;
  const at = (pu: number, pw: number): Vec2 => ({ x: O.x + u.x * pu + w.x * pw, z: O.z + u.z * pu + w.z * pw });
  const clear = (p: Vec2): boolean => pointInPolygon(p.x, p.z, ring) && distToPolygonEdge(p.x, p.z, ring) >= pad;
  let best: Fit | null = null;
  const midU = (minU + maxU) / 2;
  for (let w0 = minW + pad; w0 + D <= maxW - pad + 1e-6; w0 += STEP) {
    for (let u0 = minU + pad; u0 + L <= maxU - pad + 1e-6; u0 += STEP) {
      const score = w0 - minW + 0.25 * abs(u0 + L / 2 - midU);
      if (best && score >= best.score) continue;
      let ok = true;
      // The rectangle's edges.
      for (let s = 0; ok && s <= L + 1e-6; s += EDGE_STEP) ok = clear(at(u0 + Math.min(s, L), w0)) && clear(at(u0 + Math.min(s, L), w0 + D));
      for (let s = 0; ok && s <= D + 1e-6; s += EDGE_STEP) ok = clear(at(u0, w0 + Math.min(s, D))) && clear(at(u0 + L, w0 + Math.min(s, D)));
      // A reflex corner of the ring poking into the rectangle.
      for (let i = 0; ok && i < uv.length; i++) ok = !(uv[i].x > u0 - pad && uv[i].x < u0 + L + pad && uv[i].z > w0 - pad && uv[i].z < w0 + D + pad);
      if (ok) best = { o: at(u0, w0), u, w, score };
    }
  }
  return best;
}

/** The yard's ground is mild: grade and the spread of height over its rectangle. */
function mildGround(terrain: Terrain, fit: Fit, L: number, D: number): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (let a = 0; a <= L + 1e-6; a += 8) {
    for (let b = 0; b <= D + 1e-6; b += 8) {
      const x = fit.o.x + fit.u.x * Math.min(a, L) + fit.w.x * Math.min(b, D);
      const z = fit.o.z + fit.u.z * Math.min(a, L) + fit.w.z * Math.min(b, D);
      const h = terrain.heightAt(x, z);
      const sl = terrain.slopeAt(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      if (sqrt(sl.gx * sl.gx + sl.gz * sl.gz) > C.maxGrade) return false;
    }
  }
  return hi - lo <= C.maxRise;
}

/** The curb cut of half width `hw` in the middle of ring piece `i` (street side frame of busBays.ts), or null when the piece is no usable stretch of a street side. */
function cutAt(ctx: PlanContext, f: BlockFace, mouths: ReturnType<typeof computeMouths>, i: number, hw: number): Record<string, number> | null {
  const g = ctx.graph;
  const ring = f.ring;
  const n = ring.length;
  const road = f.segEdge[i];
  if (road < 0) return null;
  const p = ring[i];
  const q = ring[(i + 1) % n];
  const len = dist(p, q);
  if (len < 2 * (C.cut.endClear + hw + C.cut.flare)) return null;
  const dd = { x: (q.x - p.x) / len, z: (q.z - p.z) / len };
  const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
  const sd = edgeSides(g, mouths, road);
  const off = sd.map((s) => {
    const l = dist(s.from, s.to) || 1;
    return abs((mid.x - s.from.x) * (-(s.to.z - s.from.z) / l) + (mid.z - s.from.z) * ((s.to.x - s.from.x) / l));
  });
  const side = off[0] <= off[1] ? 0 : 1;
  const S = sd[side];
  const sl = dist(S.from, S.to) || 1;
  const su = { x: (S.to.x - S.from.x) / sl, z: (S.to.z - S.from.z) / sl };
  const dirSign = dd.x * su.x + dd.z * su.z > 0 ? 1 : -1;
  const sc = (p.x - S.from.x) * su.x + (p.z - S.from.z) * su.z + dirSign * (len / 2);
  const s0 = sc - hw - C.cut.flare;
  const s1 = sc + hw + C.cut.flare;
  if (s0 < 3 || s1 > sl - 3) return null;
  return { e: i, t: len / 2, h: hw, r: road, d: side === 0 ? 1 : -1, a: s0, b: s1, f: C.cut.flare };
}

/** Plan the seed's scrapyard: one area on the best site that fits, or nothing. */
export function planScrapyard(ctx: PlanContext): void {
  if (!C.enabled || ctx.weekend?.kind !== 'scrapyard') return;
  // Every draw first, whatever the sites turn out to be.
  const mirror = ctx.rng.next() < 0.5;
  const seed = ctx.rng.int(1, 0x7ffffffe);
  const sites = routeFrontageSites(ctx, { blocks: 1, minFrontage: C.minFrontage });
  const ordered: FrontageSite[] = [...sites.filter((s) => s.convex), ...sites.filter((s) => !s.convex)];
  if (!ordered.length) return;
  const terrain = createTerrain(ctx.seed);
  const mouths = computeMouths(ctx.graph, ctx.sectors());
  const hw = C.cut.width / 2;
  for (const site of ordered) {
    const f = site.face;
    const ring = f.ring;
    const n = ring.length;
    const cuts = chooseCuts(ctx, site, mouths, hw);
    if (cuts.length < 2) continue;
    // Frame candidates: square with each of the two longest route streets' pieces, and across them.
    const frames: { u: Vec2; w: Vec2 }[] = [];
    for (const fe of site.edges.slice(0, 2)) {
      let best = -1;
      let bl = 0;
      for (let i = 0; i < n; i++) {
        if (f.segEdge[i] !== fe.edge) continue;
        const l = dist(ring[i], ring[(i + 1) % n]);
        if (l > bl) {
          bl = l;
          best = i;
        }
      }
      if (best < 0) continue;
      const a = ring[best];
      const b = ring[(best + 1) % n];
      const d = { x: (b.x - a.x) / bl, z: (b.z - a.z) / bl };
      let nrm = { x: d.z, z: -d.x };
      if ((site.centroid.x - a.x) * nrm.x + (site.centroid.z - a.z) * nrm.z < 0) nrm = { x: -nrm.x, z: -nrm.z };
      frames.push({ u: d, w: nrm }, { u: nrm, w: { x: -d.x, z: -d.z } });
    }
    for (const R of C.crestRadii) {
      const stacks = canyonStacks(R);
      const L = yardDims(R).L;
      const D = yardDepth(R, stacks);
      for (const fr of frames) {
        const fit = fitRect(ring, fr.u, fr.w, L, D, C.perimeter);
        if (!fit || !mildGround(terrain, fit, L, D)) continue;
        // Mirror the layout along u: the canyon at the other end, same rectangle.
        const o = mirror ? { x: fit.o.x + fit.u.x * L, z: fit.o.z + fit.u.z * L } : fit.o;
        const u = mirror ? { x: -fit.u.x, z: -fit.u.z } : fit.u;
        const params: Record<string, number> = { seed, R, n: stacks, L, D, ox: o.x, oz: o.z, ux: u.x, uz: u.z, wx: fit.w.x, wz: fit.w.z, cuts: cuts.length };
        cuts.forEach((c, i) => {
          for (const key of Object.keys(c)) params[`c${i}${key}`] = c[key];
        });
        // Claims the block (so the hills, parks and downtown keep off it), its corner nodes and every route street along it: the night
        // market planned next narrows route streets (widths only, then graphChanged, which tolerates a weekend special's face claim) and
        // skips claimed edges and nodes, so nothing moves the ring this yard was fitted to.
        const routeEdges = new Set<number>(ctx.event!.routes.flatMap((r) => r.edges));
        const edges = [...new Set([...site.edges.map((e) => e.edge), ...f.edges.filter((e) => routeEdges.has(e))])].sort((a, b) => a - b);
        const nodes = [...new Set(f.corners.map((c) => c.node))].sort((a, b) => a - b);
        ctx.addArea({ kind: 'scrapyard', variant: 'eight', polygon: ring.map((p) => ({ x: p.x, z: p.z })), path: [], nodes, edges, faces: [f.id], params: { ...params, face: f.id } }, 0);
        return;
      }
    }
  }
}

/** Up to CFG.cut.count cuts: one in the longest usable piece of each route street, then the longest of the block's other streets until there are two. */
function chooseCuts(ctx: PlanContext, site: FrontageSite, mouths: ReturnType<typeof computeMouths>, hw: number): Record<string, number>[] {
  const f = site.face;
  const n = f.ring.length;
  const out: Record<string, number>[] = [];
  const pieces = (edge: number): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (f.segEdge[i] === edge) idx.push(i);
    return idx.sort((a, b) => dist(f.ring[b], f.ring[(b + 1) % n]) - dist(f.ring[a], f.ring[(a + 1) % n]) || a - b);
  };
  const tryEdge = (edge: number): void => {
    for (const i of pieces(edge)) {
      const c = cutAt(ctx, f, mouths, i, hw);
      if (c) {
        out.push(c);
        return;
      }
    }
  };
  for (const fe of site.edges) if (out.length < C.cut.count) tryEdge(fe.edge);
  if (out.length < 2) {
    const routeEdges = new Set(site.edges.map((e) => e.edge));
    for (const e of [...new Set(f.edges)].sort((a, b) => a - b)) if (out.length < 2 && !routeEdges.has(e) && !ctx.claims.edge.has(e)) tryEdge(e);
  }
  return out;
}
