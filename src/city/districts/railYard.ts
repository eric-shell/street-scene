/**
 * Weekend special: the rail yard (src/city/weekend.ts, docs/weekend.md).
 *
 * A freight classification yard two blocks long, laid along a street both routes drive, so every
 * race runs past its open frontage and racers dive in. It is planned only on the seeds whose weekend
 * pick is `railYard`; every other seed's plan returns at once, so no other city changes. Registered
 * right after the back alleys, so it plans after the topology hook (it reads both routes from
 * PlanContext.event) and gets first pick of the blocks along them, before the market, the car park,
 * the lake's block claim and the lots. Its kind is in CORRIDOR_AREAS (districts/types.ts), so a race
 * through it is not reset as lost.
 *
 * Plan: the best site from routeFrontageSites with a neighbour down the same route street (else one
 * block of its own), a rectangle fitted in each block (railYardFrame.ts) growing away from the cross
 * street between them, the three gate mouths on the frontage, then the block faces and the frontage
 * edges are claimed (through ctx.claims.edge only, not Area.edges: the street keeps its crown and its
 * humps, and the night market and the roadworks keep off it). No site, no yard: the special then does
 * not appear. The area's polygon is the hull of both rectangles.
 *
 * Build, per block (layout in railYardLayout.ts, shapes in railYardShapes.ts, banking.ts):
 *  - the footprint is a quay surface patch (dusty concrete grip, like the harbor's quay) with the
 *    buildings excluded and the frontage walls opened; the back and the two ends are solid thin fences
 *    (look yardFence, solid so a car is never shoved through them from either side);
 *  - the frontage is a chain link fence of destructible panels in runs with gaps, three wide gate mouths
 *    between solid steel posts with the sliding gate leaves stood open beside them (solid yardFence),
 *    cobbled across the sidewalk, the sidewalk kept clear of furniture. No sign and no arrow: the light,
 *    the cobbles and the gap in the fence say "in here";
 *  - freight consists, one solid per run (look railcar), cars drawn from per-car hints; the lead track is
 *    left clear for the switcher; soft clutter (crate = tie stacks, pallets, drums, cable spools, sandbags)
 *    strews the back aisles;
 *  - the loading dock along the back (height mod, ramps at both ends, a hard edge) whose face is a solid
 *    yardFence wall with Wall.top set by settleRailYard once the terrain exists, so a ground car is stopped
 *    and a car up on the platform drops off it; the ridge across the tracks (the jump) at one end, the
 *    banked half circle round the end of the tracks at the other.
 * Lines: the fast line is the open apron and lead track beside the street; the risky line is the back aisles
 * behind the consists; the elevated line is the dock.
 *
 * Hints for render/districts/railYard.ts: 'yard' (the rectangle), 'track', 'car', 'gate', 'dock', 'hump', 'bank',
 * 'tower', 'signal', 'apron', and 'lead' (the switcher's track, for the level crossing).
 */
import { CITY } from '../config';
import { routeFrontageSites } from './weekendSites';
import { raceStreets } from './structures';
import type { FrontageSite } from './weekendSites';
import { chainOf } from '../roadGraph';
import type { BlockFace } from '../blocks';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import { atan2 } from '../../sim/math';
import type { Terrain } from '../terrain';
import type { Area, AreaBuild, BuildContext, DistrictModule, PlanContext } from './types';
import { COBBLE_PRIORITY, emptyBuild } from './types';
import { solidWalls } from './geom';
import { bankWallLine, wallRadius } from './banking';
import { convexHull, fitRect, frontSegment, rectPoint, rectPoly } from './railYardFrame';
import type { YardRect } from './railYardFrame';
import { layConsists, layJunk, trackPlan, yardBlocks } from './railYardLayout';
import type { YardBlock } from './railYardLayout';
import { bankArc, blockMods } from './railYardShapes';

const C = CITY.districts.railYard;

/** Surface patch priorities: the yard's quay over the sidewalk (3), its cobbled mouths over the road (5). */
const YARD_PRIORITY = 4;

/** Write a block's rectangle and ends into the area params as block `i`. */
function writeBlock(p: Record<string, number>, i: number, r: YardRect, edge: number, humpEnd: number, loopEnd: number): void {
  p[`b${i}ox`] = r.ox;
  p[`b${i}oz`] = r.oz;
  p[`b${i}ux`] = r.ux;
  p[`b${i}uz`] = r.uz;
  p[`b${i}vx`] = r.vx;
  p[`b${i}vz`] = r.vz;
  p[`b${i}L`] = r.L;
  p[`b${i}D`] = r.D;
  p[`b${i}e`] = edge;
  p[`b${i}h`] = humpEnd;
  p[`b${i}l`] = loopEnd;
}

/**
 * Where the route street of the chain of `edgeA` carries on straight through a junction at one end of that chain into
 * `face`: the edge of `face` (both a route's street, away from the start and finish streets, running nearly opposite
 * ways out of the shared node), and the chain's own piece at that junction. Null when there is none.
 * (FrontageSite.along only holds for pieces of one chain, which ends at every junction, so the next block down the street
 * is never `along`; the cross street between the two blocks is exactly such a junction.)
 */
function continuingEdge(ctx: PlanContext, face: BlockFace, edgeA: number): { edge: number; pieceA: number } | null {
  const g = ctx.graph;
  const { route, ends } = raceStreets(ctx);
  const chain = chainOf(g, edgeA);
  const junctions = [chain.nodes[0], chain.nodes[chain.nodes.length - 1]];
  let best: { edge: number; pieceA: number } | null = null;
  let len = 0;
  for (const e of [...new Set(face.edges)].sort((p, q) => p - q)) {
    if (!route.has(e) || ends.has(e)) continue;
    const eb = g.edges[e];
    const shared = junctions.find((n) => n === eb.a || n === eb.b);
    if (shared === undefined) continue;
    // The chain's end piece at that junction, and its direction away from the node.
    const pa = chain.nodes[0] === shared ? chain.edges[0] : chain.edges[chain.edges.length - 1];
    if (pa === e) continue;
    const ap = g.edges[pa];
    const oa = g.nodes[ap.a === shared ? ap.b : ap.a];
    const ob = g.nodes[eb.a === shared ? eb.b : eb.a];
    const n = g.nodes[shared];
    const ax = oa.x - n.x;
    const az = oa.z - n.z;
    const bx = ob.x - n.x;
    const bz = ob.z - n.z;
    const cos = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
    if (cos > -0.85) continue;
    const s = frontSegment(face, e);
    if (!s) continue;
    const l = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
    if (l > len) {
      len = l;
      best = { edge: e, pieceA: pa };
    }
  }
  return best;
}

interface Layout {
  blocks: { face: BlockFace; rect: YardRect; edge: number }[];
}

/** Fit the yard on a site: both blocks of a two block site, or the block alone. */
function fitSite(ctx: PlanContext, s: FrontageSite, two: boolean): Layout | null {
  const chainA = chainOf(ctx.graph, s.edges[0].edge).edges.filter((e) => s.face.edges.includes(e));
  const edgeA = s.edges[0].edge;
  if (!two) {
    const r = fitRect(s.face, chainA.length ? chainA : [edgeA], null);
    return r && r.L >= 100 && trackPlan(r.D) ? { blocks: [{ face: s.face, rect: r, edge: edgeA }] } : null;
  }
  for (const nb of s.neighbours) {
    const next = continuingEdge(ctx, nb.face, edgeA);
    if (!next) continue;
    const cb = { x: nb.face.ring.reduce((a, p) => a + p.x, 0) / nb.face.ring.length, z: nb.face.ring.reduce((a, p) => a + p.z, 0) / nb.face.ring.length };
    const chainB = chainOf(ctx.graph, next.edge).edges.filter((e) => nb.face.edges.includes(e));
    const ra = fitRect(s.face, s.face.edges.includes(next.pieceA) ? [next.pieceA] : chainA, cb) ?? fitRect(s.face, chainA, cb);
    const rb = fitRect(nb.face, [next.edge], s.centroid) ?? fitRect(nb.face, chainB, s.centroid);
    if (ra && rb && trackPlan(ra.D) && trackPlan(rb.D)) {
      return {
        blocks: [
          { face: s.face, rect: ra, edge: s.face.edges.includes(next.pieceA) ? next.pieceA : edgeA },
          { face: nb.face, rect: rb, edge: next.edge },
        ],
      };
    }
  }
  return null;
}

/** Plan the gate mouths: `count` in all, spread over the blocks by length, each clear of the rectangle's ends and the hump and loop zones. */
function planMouths(ctx: PlanContext, p: Record<string, number>, blocks: YardBlock[]): void {
  const counts = blocks.length === 2 ? [2, 1] : [C.mouth.count];
  let k = 0;
  const w = C.mouth.width;
  blocks.forEach((b, bi) => {
    // The gate's posts and leaves (the zone layFrontFence keeps) clear of the ends, and of the turnaround's half circle.
    const zone = w / 2 + C.fence.post + 4.5 + 0.3;
    const lo = zone + 2;
    const hi = b.rect.L - zone - 2 - (b.loop ? b.rect.L - b.loop.cu : 0);
    const n = counts[bi];
    for (let m = 0; m < n; m++) {
      const centre = lo + ((hi - lo) * (m + 0.5)) / n;
      const jitter = (ctx.rng.next() - 0.5) * Math.min(14, (hi - lo) / n - w);
      p[`m${k}u`] = Math.max(lo, Math.min(hi, centre + jitter));
      p[`m${k}b`] = bi;
      k++;
    }
  });
}

function planYard(ctx: PlanContext, s: FrontageSite, two: boolean): boolean {
  const lay = fitSite(ctx, s, two);
  if (!lay) return false;
  const params: Record<string, number> = { seed: ctx.rng.int(1, 0x7ffffffe), blocks: lay.blocks.length };
  lay.blocks.forEach((b, i) => {
    // Two blocks: the hump at the first block's far end, the banked turnaround at the second's. One block: hump at the low end, loop at the high end.
    const humpEnd = lay.blocks.length === 2 ? (i === 0 ? 1 : 0) : -1;
    const loopEnd = lay.blocks.length === 2 ? (i === 1 ? 1 : 0) : 1;
    writeBlock(params, i, b.rect, b.edge, humpEnd, loopEnd);
  });
  const tmp = emptyArea(params);
  planMouths(ctx, params, yardBlocks(tmp));
  const corners: Vec2[] = [];
  let footprint = 0;
  for (const b of lay.blocks) {
    for (const q of rectPoly(b.rect, 0, b.rect.L, 0, b.rect.D)) corners.push(q);
    footprint += b.rect.L * b.rect.D;
  }
  const area = ctx.addArea({ kind: 'railYard', variant: lay.blocks.length === 2 ? 'double' : 'single', polygon: convexHull(corners), path: [], nodes: [], edges: [], faces: lay.blocks.map((b) => b.face.id), params }, footprint);
  // The streets the yard fronts keep the night market and the roadworks off (the area does not own them: the crown and humps stay).
  for (const e of s.edges) ctx.claims.edge.set(e.edge, area.id);
  for (const b of lay.blocks) ctx.claims.edge.set(b.edge, area.id);
  return true;
}

/** A throwaway area for reading params through yardBlocks. */
function emptyArea(params: Record<string, number>): Area {
  return { id: -1, kind: 'railYard', variant: '', polygon: [], path: [], nodes: [], edges: [], faces: [], params };
}

/** A convex rectangle [u0,u1] x [v0,v1] of a block as a solid of `look`. */
function solidBox(b: AreaBuild, r: YardRect, u0: number, u1: number, v0: number, v1: number, look: 'yardFence' | 'railcar', area: number, top?: number): void {
  const walls = solidWalls(rectPoly(r, u0, u1, v0, v1), look, area);
  if (top !== undefined) for (const w of walls) w.top = top;
  b.walls.push(...walls);
}

/** Fence runs along the frontage, from the mouths' gate leaves, broken by gaps (destructible chain link panels). */
function layFrontFence(b: AreaBuild, blk: YardBlock, rng: Rng, area: number): void {
  const r = blk.rect;
  const F = C.fence;
  const zone = C.mouth.width / 2 + F.post + 4.5 + 0.3;
  const stops: number[] = [1];
  for (const m of [...blk.mouths].sort((x, y) => x - y)) stops.push(m - zone, m + zone);
  stops.push(r.L - 1);
  const yaw = atan2(r.vx, r.vz);
  for (let i = 0; i + 1 < stops.length; i += 2) {
    let u = stops[i] + F.pitch / 2;
    const end = stops[i + 1];
    while (u < end - F.pitch / 2) {
      const run = rng.int(F.run[0], F.run[1]);
      for (let k = 0; k < run && u < end - F.pitch / 2; k++, u += F.pitch) {
        const q = rectPoint(r, u, F.inset);
        b.destructibles.push({ kind: 'fencePanel', x: q.x, z: q.z, yaw, lift: 0, area });
      }
      u += rng.range(F.gap[0], F.gap[1]);
    }
  }
}

/** Build one block into `b`. */
function buildBlock(ctx: BuildContext, area: Area, blk: YardBlock, b: AreaBuild, rng: Rng): void {
  const id = area.id;
  const r = blk.rect;
  const F = C.fence;
  const g = ctx.graph;
  const walk = g.edges[blk.edge]?.sidewalk ?? 3.4;

  // The rectangle for the renderer: its corners, the frame and every zone along and across it (-1: absent).
  const hp = blk.hump;
  const dk = blk.dock;
  b.hints.push({
    kind: 'yard',
    points: rectPoly(r, 0, r.L, 0, r.D),
    values: [r.ux, r.uz, r.vx, r.vz, r.L, r.D, blk.apron, blk.n, blk.pitch, blk.trackV[0], dk ? blk.dockFace : -1, dk ? dk.u0 : -1, dk ? dk.u1 : -1, dk ? dk.ramp : -1, hp ? hp.uc : -1, hp ? hp.run : -1, hp ? hp.v0 : -1, hp ? hp.v1 : -1, blk.loop ? blk.loop.cu : -1, blk.loop ? blk.loop.R : -1, blk.loop ? blk.loop.vmid : -1, blk.trackU1, blk.i],
  });

  // Ground, buildings and frontage.
  b.surfaces.push({ surface: 'quay', polygon: rectPoly(r, 0, r.L, 0, r.D), priority: YARD_PRIORITY, area: id });
  b.exclusions.push(rectPoly(r, -2, r.L + 2, -1.5, r.D + 5));
  b.openings.push(rectPoly(r, -0.5, r.L + 0.5, -2.5, 2.5));

  // The back and the ends: solid thin fences.
  const T = F.thick;
  solidBox(b, r, -T, r.L + T, r.D, r.D + T, 'yardFence', id);
  solidBox(b, r, -T, 0, 0, r.D, 'yardFence', id);
  solidBox(b, r, r.L, r.L + T, 0, r.D, 'yardFence', id);

  // Gate mouths: two steel posts, a sliding leaf stood open beyond each, cobbles across the sidewalk, the sidewalk kept clear.
  const w = C.mouth.width;
  for (const mu of blk.mouths) {
    const posts: Vec2[] = [];
    for (const s of [-1, 1]) {
      const pu = mu + s * (w / 2 + F.post / 2);
      solidBox(b, r, pu - F.post / 2, pu + F.post / 2, F.inset - F.post / 2, F.inset + F.post / 2, 'yardFence', id);
      posts.push(rectPoint(r, pu, F.inset));
      const a = mu + s * (w / 2 + F.post);
      const c = a + s * 4.5;
      solidBox(b, r, Math.min(a, c), Math.max(a, c), F.inset - 0.15, F.inset + 0.15, 'yardFence', id);
    }
    b.hints.push({ kind: 'gate', points: posts, values: [mu, w, r.ux, r.uz, r.vx, r.vz, walk] });
    b.surfaces.push({ surface: 'cobble', polygon: rectPoly(r, mu - w / 2, mu + w / 2, -walk + 0.2, C.mouth.depth), priority: COBBLE_PRIORITY, area: id });
    for (let u = mu - w / 2; u <= mu + w / 2 + 1e-6; u += 3) {
      const q = rectPoint(r, u, -walk / 2);
      b.reserved.push({ x: q.x, z: q.z, r: walk / 2 + 0.6 });
    }
  }
  layFrontFence(b, blk, rng, id);

  // The tracks, freight, clutter.
  const consists = layConsists(blk, rng);
  for (let t = 0; t < blk.n; t++) {
    const a = rectPoint(r, 2, blk.trackV[t]);
    const c = rectPoint(r, blk.trackU1, blk.trackV[t]);
    b.hints.push({ kind: 'track', points: [a, c], values: [t, blk.i] });
  }
  const half = C.cars.width / 2;
  for (const cs of consists) {
    solidBox(b, r, cs.u0, cs.u1, blk.trackV[cs.track] - half, blk.trackV[cs.track] + half, 'railcar', id);
    for (const car of cs.cars) {
      b.hints.push({ kind: 'car', points: [rectPoint(r, car.u, blk.trackV[cs.track])], values: [r.ux, r.uz, car.len, ['boxcar', 'tank', 'hopper', 'flatcar', 'caboose'].indexOf(car.kind), car.tex, cs.track] });
    }
  }
  for (const j of layJunk(blk, rng, consists)) {
    const q = rectPoint(r, j.u, j.v);
    b.destructibles.push({ kind: j.kind, x: q.x, z: q.z, yaw: j.yaw, lift: 0, area: id });
  }

  // Dwarf signals at the ends of tracks: solid posts, red lamps drawn by the renderer.
  for (let t = 0; t < blk.n; t++) {
    const u = blk.loop ? blk.trackU1 - 1.2 : 2.4;
    const v = blk.trackV[t] + (t % 2 === 0 ? 2.1 : -2.1);
    solidBox(b, r, u - 0.17, u + 0.17, v - 0.17, v + 0.17, 'yardFence', id);
    b.hints.push({ kind: 'signal', points: [rectPoint(r, u, v)], values: [t % 3] });
  }

  // The dock: height mod (blockMods), the face as a solid wall (Wall.top settled once the terrain exists).
  if (blk.dock) {
    const d = blk.dock;
    solidBox(b, r, d.u0, d.u1, blk.dockFace, blk.dockFace + 0.4, 'yardFence', id, Infinity);
    b.hints.push({ kind: 'dock', points: rectPoly(r, d.u0, d.u1, blk.dockFace, r.D), values: [d.ramp, C.dock.height, r.ux, r.uz, r.vx, r.vz] });
  }
  // The jump.
  if (blk.hump) {
    const h = blk.hump;
    b.hints.push({ kind: 'hump', points: [rectPoint(r, h.uc, h.v0), rectPoint(r, h.uc, h.v1)], values: [C.hump.top, h.run, C.hump.rise, r.ux, r.uz, r.vx, r.vz, h.v0, h.v1] });
  }
  // The turnaround's bank and its wall.
  const arc = bankArc(blk);
  if (arc) {
    const line = bankWallLine(arc, 0.1);
    const outward = (p: Vec2) => {
      const d = Math.hypot(p.x - arc.cx, p.z - arc.cz) || 1;
      return { x: (p.x - arc.cx) / d, z: (p.z - arc.cz) / d };
    };
    for (let i = 0; i + 1 < line.length; i++) {
      const p = line[i];
      const q = line[i + 1];
      const op = outward(p);
      const oq = outward(q);
      b.walls.push(
        ...solidWalls(
          [
            { x: p.x - op.x * 0.05, z: p.z - op.z * 0.05 },
            { x: q.x - oq.x * 0.05, z: q.z - oq.z * 0.05 },
            { x: q.x + oq.x * T, z: q.z + oq.z * T },
            { x: p.x + op.x * T, z: p.z + op.z * T },
          ],
          'yardFence',
          id,
        ),
      );
    }
    b.hints.push({ kind: 'bank', points: [{ x: arc.cx, z: arc.cz }], values: [arc.rOut, arc.rise, arc.hold, arc.fall, arc.height, arc.mid, arc.half, arc.taper, wallRadius(arc)] });
  }
  b.heightMods.push(...blockMods(blk));

  // Light: towers behind the back fence, the yard tower with its lit cab in the first block.
  const towers = blk.i === 0 ? Math.ceil(C.lights.towers / 2) : Math.floor(C.lights.towers / 2);
  for (let k = 0; k < towers; k++) {
    const u = (r.L * (k + 0.5)) / towers;
    b.hints.push({ kind: 'tower', points: [rectPoint(r, u, r.D + 1.6)], values: [0, C.lights.mast, -r.vx, -r.vz, r.ux, r.uz] });
  }
  if (blk.i === 0) b.hints.push({ kind: 'tower', points: [rectPoint(r, r.L * 0.5 + 12, r.D + 3.2)], values: [1, C.lights.cab, -r.vx, -r.vz, r.ux, r.uz] });
}

export const railYardModule: DistrictModule = {
  kind: 'railYard',
  phase: 'graph',
  plan(ctx) {
    if (!C.enabled || ctx.weekend?.kind !== 'railYard') return;
    for (const s of routeFrontageSites(ctx, { blocks: 2, minFrontage: C.site.minFrontage })) {
      if (planYard(ctx, s, true)) return;
    }
    for (const s of routeFrontageSites(ctx, { blocks: 1, minFrontage: C.site.minFrontageSingle })) {
      if (planYard(ctx, s, false)) return;
    }
  },
  build(ctx, area) {
    const b = emptyBuild();
    const rng = new Rng(deriveSeed(area.params.seed, 'railYard:build'));
    const blocks = yardBlocks(area);
    for (const blk of blocks) buildBlock(ctx, area, blk, b, rng);
    // The drift zone: the apron of the longest block, the open ground behind the gates (clear of the posts and fences).
    const longest = [...blocks].sort((p, q) => q.rect.L - p.rect.L)[0];
    if (longest) {
      const r = longest.rect;
      b.hints.push({ kind: 'apron', points: rectPoly(r, 3, longest.loop ? longest.loop.cu : r.L - 3, 3.5, longest.apron - 0.5), values: [longest.apron] });
    }
    return b;
  },
};

/**
 * Give the dock faces their Wall.top: the ground in front of the face plus the share of the dock's height under which a car is
 * stopped, so a car on the ground cannot drive into the face while a car up on the platform drops off it (the alleys' lip face
 * does the same, settleAlleyLips). Runs once the terrain exists (createCity); until then the face is full height.
 */
export function settleRailYard(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  areas.forEach((a, i) => {
    if (a.kind !== 'railYard') return;
    const tops = new Map<object, number>();
    for (const w of builds[i].walls) {
      if (w.look !== 'yardFence' || w.top === undefined || !w.solid) continue;
      // One top for the whole solid (its first face is the front, toward the ground): a solid stands for a car if any of its faces does.
      let t = tops.get(w.solid);
      if (t === undefined) {
        const mx = (w.ax + w.bx) / 2 + w.nx * 1.5;
        const mz = (w.az + w.bz) / 2 + w.nz * 1.5;
        t = terrain.heightAt(mx, mz) + C.dock.height * C.dock.topFrac;
        tops.set(w.solid, t);
      }
      w.top = t;
    }
  });
}
