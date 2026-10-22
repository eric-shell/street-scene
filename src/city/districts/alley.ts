/**
 * Alleys, two variants (two modules, one file):
 *
 * 'alley': a narrow raceway street. A chain of 2-3 straight grid street
 * edges away from the center becomes kind 'alley' (CITY.width.alley, thin
 * sidewalks). Routes may use it like any street; the racing line and AI
 * follow the narrower route.segWidth automatically.
 *
 * 'backAlley': a skinny shortcut through a block. Two opposite sides of a
 * four sided block are split at their middles (new T junction nodes) and
 * joined by a 'backAlley' edge flagged `shortcut: true`. Routes never drive
 * shortcut edges. One that joins two points of a route and saves distance
 * (shortcutSpan) stays open as that route's shortcut and race progress
 * credits the stretch it skips (race.ts); any other is closed off at the
 * route's junctions like a side street (buildRoute).
 *
 * Route shortcuts (carveRouteShortcuts): the random back alleys above only
 * meet a route by luck, so once both routes are picked every circuit and
 * sprint gets its own: a 'backAlley' area (variant 'routeShortcut') whose
 * path joins two points of the route and skips a real stretch of it. Corner
 * cuts run across the inside block of a sharp turn; U cuts cross a block the
 * route wraps on three sides. Both are wider than a plain back alley, kept
 * clear of other streets and of the corner rails, and built like any back
 * alley (clutter, often a kicker). A route shortcut is never a straight shot:
 * where the block has room its path is a dogleg or a gentle arc (one or two
 * free bend nodes, gi -1 and degree 2, every edge of the chain 'backAlley'
 * flagged shortcut), bent away from the corner it cuts. The chain is walked
 * by shortcutChain; route.ts lists it as one RouteShortcut (entry first) and
 * race progress credits the whole chain.
 *
 * Jump exits (about half the cuts, cfg.route.jump): the last leg meets the
 * exit street at a shallow angle and climbs a parabolic ramp to a lip just
 * inside the alley's walls; a construction fence stands across the lip and
 * the car flies over the mouth onto the route's street, landing on it heading
 * down it. The drop under the lip is a wall facing the street (look
 * 'alleyLip', Wall.top: street cars cannot drive into the exit, the launching
 * car passes over). The landing zone is planned like the car park's: a run-up
 * speed bound gives the furthest landing (alleyFlightReach), the street past
 * the mouth must be free of junctions for the flight plus a roll-out, corner
 * rails crossing the flight are cut (shortcutJumpRails) and reserved circles
 * keep street furniture off it; soft clutter lies below the lip and around
 * the landing side. The entry end stays a normal flared mouth.
 *
 * Every alley is cobbled curb to curb between its mouths (surface 'cobble':
 * a little less grip and more rolling drag than asphalt, see
 * drivingParams.json; the junction fans stay asphalt). Raceway alleys are
 * lined, block after block, with restaurant fronts (cafe tables between
 * planter pots), storage clutter (crates, barrels, pallets, trash bags) and
 * street works (hoarding panels along the wall, sandbags, a water barrier,
 * sawhorses and cones spilling off the curb); back alleys with dumpsters,
 * trash bags and crates against the walls, and most get a kicker hump (a
 * terrain height modifier, exact gradient) that throws a fast car into the
 * air in either direction. All of it is destructible except the hump; a
 * dumpster only goes flying when hit hard. Nothing that can stop a car ever
 * stands in the line down the middle: a car's width plus a margin (LANE).
 *
 * Content to add (render/districts/alley.ts): fire escapes, graffiti, steam
 * vents, puddles and grime on back alleys.
 */
import { CITY, ROUTE } from '../config';
import { addEdge, addNode, edgeBetween, otherNode, splitEdge } from '../roadGraph';
import type { RoadGraph } from '../roadGraph';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import { Vec2, atan2, distToSegment, lineIntersectT } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { pointInPolygon } from './geom';
import type { PropKind } from '../props';
import { PROP_DEFS } from '../props';
import type { Area, AreaBuild, BuildContext, DistrictModule, HeightSample, PlanContext, SurfacePatch } from './types';
import { COBBLE_PRIORITY, emptyBuild } from './types';
import { smooth01 } from './geom';
import { CAR_HALF, railsClearOf } from './carPark';

/** Hump height and its slope along the alley at distance s from the start (0 outside the hump). */
export function jumpProfile(s: number, center: number, ramp: number, top: number, height: number): { h: number; dh: number } {
  const s0 = center - top / 2 - ramp;
  const s1 = center - top / 2;
  const s2 = center + top / 2;
  const s3 = center + top / 2 + ramp;
  if (s <= s0 || s >= s3) return { h: 0, dh: 0 };
  if (s < s1) return { h: ((s - s0) / ramp) * height, dh: height / ramp };
  if (s <= s2) return { h: height, dh: 0 };
  return { h: ((s3 - s) / ramp) * height, dh: -height / ramp };
}

/** Clutter along one side of a straight edge: s from the start (m), lateral offset from the centerline (+ = left of travel). */
function sideSpot(a: Vec2, b: Vec2, s: number, lateral: number): { x: number; z: number; yaw: number } {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  // Left of travel is (-uz, ux); props face the alley center (local +Z toward it).
  const nx = -uz;
  const nz = ux;
  return { x: a.x + ux * s + nx * lateral, z: a.z + uz * s + nz * lateral, yaw: Math.atan2(-nx * Math.sign(lateral), -nz * Math.sign(lateral)) };
}

/**
 * A jump exit's ramp: height and slope `s` m past its toe, a parabola `length`
 * m long rising `rise` m, flat at the toe (no kink to unsettle the car) and
 * steepest at the lip (2 rise / length); 0 past the lip, where the alley
 * drops back to street level under the face.
 */
export function jumpRampProfile(s: number, length: number, rise: number): { h: number; dh: number } {
  if (s <= 0 || s > length) return { h: 0, dh: 0 };
  const t = s / length;
  return { h: rise * t * t, dh: (2 * rise * t) / length };
}

/** Ballistic reach (m from the lip, landing at street level `rise` m below it) of a launch at v m/s off a jump exit's lip. */
export function alleyFlightReach(v: number): number {
  const J = CITY.districts.backAlley.route.jump;
  const a = Math.atan((2 * J.rise) / J.length);
  const vy = v * Math.sin(a);
  const vx = v * Math.cos(a);
  const g = 9.81;
  return (vx * (vy + Math.sqrt(vy * vy + 2 * g * J.rise))) / g;
}

/** Cumulative length (m) at each point of a polyline. */
function pathCum(path: readonly Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  return cum;
}

/** Leg index holding position s along a polyline (the last leg at and past its end). */
function legAt(cum: readonly number[], s: number): number {
  let i = 0;
  while (i + 2 < cum.length && s >= cum[i + 1]) i++;
  return i;
}

/** sideSpot along a polyline: s from its start (m), lateral off the centerline (+ = left of travel). */
function pathSpot(path: readonly Vec2[], cum: readonly number[], s: number, lateral: number): { x: number; z: number; yaw: number } {
  const i = legAt(cum, s);
  return sideSpot(path[i], path[i + 1], s - cum[i], lateral);
}

/** Distance from a point to a polyline (m). */
function distToPath(path: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) best = Math.min(best, distToSegment(x, z, path[i].x, path[i].z, path[i + 1].x, path[i + 1].z));
  return best;
}

/** A chain of shortcut edges between two junctions: its edges and nodes in walking order, its points and length (m). */
export interface ShortcutChain {
  edges: number[];
  nodes: number[];
  points: Vec2[];
  length: number;
  /** The node at the chain's jump exit lip, if it has one: only a shortcut driven toward it (a wall faces the street under the lip). */
  jumpEnd: number | null;
}

/**
 * Follow shortcut edges from node `from` along edge `eid` through free bend
 * nodes (gi -1, two shortcut edges) to the junction at the far end. A plain
 * back alley is a chain of one edge.
 */
export function shortcutChain(g: RoadGraph, eid: number, from: number): ShortcutChain {
  const edges = [eid];
  const nodes = [from];
  let e = g.edges[eid];
  let n = from;
  let length = e.length;
  let jumpEnd: number | null = e.jumpExit ? e.b : null;
  for (let guard = 0; guard < 8; guard++) {
    n = otherNode(e, n);
    nodes.push(n);
    const node = g.nodes[n];
    if (node.gi >= 0 || node.edges.length !== 2) break;
    const next = g.edges[node.edges[0] === e.id ? node.edges[1] : node.edges[0]];
    if (!next.shortcut) break;
    edges.push(next.id);
    length += next.length;
    if (next.jumpExit) jumpEnd = next.b;
    e = next;
  }
  return { edges, nodes, points: nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z })), length, jumpEnd };
}

/** Whether a chain driven from its first node to its last would arrive at a jump exit backwards (over the face under its lip). */
export function chainBackwards(c: ShortcutChain, aFirst: boolean): boolean {
  return c.jumpEnd !== null && (aFirst ? c.nodes[c.nodes.length - 1] : c.nodes[0]) !== c.jumpEnd;
}

/** Every shortcut chain leaving one of the given nodes, each listed once, walked from the first of its ends in the list. */
export function routeChains(g: RoadGraph, nodes: readonly number[]): ShortcutChain[] {
  const seen = new Set<number>();
  const out: ShortcutChain[] = [];
  for (const nid of nodes) {
    for (const eid of g.nodes[nid].edges) {
      if (!g.edges[eid].shortcut || seen.has(eid)) continue;
      const c = shortcutChain(g, eid, nid);
      for (const id of c.edges) seen.add(id);
      out.push(c);
    }
  }
  return out;
}

/** The nodes of an area's shortcut chain in the order of its edges (edge i runs from node i to node i + 1). */
function chainNodes(g: RoadGraph, edges: readonly number[]): number[] {
  const first = g.edges[edges[0]];
  if (edges.length === 1) return [first.a, first.b];
  const second = g.edges[edges[1]];
  let n = first.a === second.a || first.a === second.b ? first.b : first.a;
  const out = [n];
  for (const eid of edges) {
    n = otherNode(g.edges[eid], n);
    out.push(n);
  }
  return out;
}

/** Corridor polygon around a polyline (half width hw). */
export function corridor(path: Vec2[], hw: number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  path.forEach((p, j) => {
    const a = path[Math.max(0, j - 1)];
    const b = path[Math.min(path.length - 1, j + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    left.push({ x: p.x + nx * hw, z: p.z + nz * hw });
    right.push({ x: p.x - nx * hw, z: p.z - nz * hw });
  });
  return left.concat(right.reverse());
}

function gridIndex(g: RoadGraph): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of g.nodes) if (n.gi >= 0) m.set(n.gj * 1000 + n.gi, n.id);
  return m;
}

export const alleyModule: DistrictModule = {
  kind: 'alley',
  phase: 'graph',
  plan(ctx) {
    const cfg = CITY.districts.alley;
    if (!cfg.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    const at = gridIndex(g);
    const cx = (g.bounds.minX + g.bounds.maxX) / 2;
    const cz = (g.bounds.minZ + g.bounds.maxZ) / 2;
    const chains: { nodes: number[]; edges: number[] }[] = [];
    for (const n of g.nodes) {
      if (n.gi < 0) continue;
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
      ]) {
        const L = rng.int(cfg.chain[0], cfg.chain[1]);
        const nodes = [n.id];
        const edges: number[] = [];
        let ok = true;
        for (let k = 1; k <= L && ok; k++) {
          const next = at.get((n.gj + dj * k) * 1000 + n.gi + di * k);
          if (next === undefined) {
            ok = false;
            break;
          }
          const e = edgeBetween(g, nodes[nodes.length - 1], next);
          if (e < 0 || g.edges[e].kind !== 'street' || g.edges[e].bridge || ctx.claims.edge.has(e)) ok = false;
          nodes.push(next);
          edges.push(e);
        }
        if (!ok) continue;
        if (nodes.some((id) => ctx.claims.node.has(id) || g.nodes[id].ring)) continue;
        const mid = g.nodes[nodes[nodes.length >> 1]];
        if (Math.hypot(mid.x - cx, mid.z - cz) < 280) continue;
        chains.push({ nodes, edges });
      }
    }
    rng.shuffle(chains);
    const used = new Set<number>();
    let made = 0;
    for (const c of chains) {
      if (made >= count) break;
      if (c.nodes.some((id) => used.has(id))) continue;
      let length = 0;
      for (const e of c.edges) length += g.edges[e].length;
      const footprint = length * (CITY.width.alley + 2 * CITY.sidewalkWidth.alley);
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      for (const e of c.edges) {
        const edge = g.edges[e];
        edge.kind = 'alley';
        edge.width = CITY.width.alley;
        edge.sidewalk = CITY.sidewalkWidth.alley;
        edge.lanes = CITY.lanes.alley;
      }
      c.nodes.forEach((id) => used.add(id));
      const path = c.nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
      ctx.addArea(
        { kind: 'alley', variant: 'raceway', polygon: corridor(path, CITY.width.alley / 2 + CITY.sidewalkWidth.alley), path, nodes: c.nodes.slice(1, -1), edges: c.edges, faces: [], params: { length, seed: rng.int(1, 0x7ffffffe) } },
        footprint,
      );
      made++;
    }
    if (made) ctx.graphChanged();
  },
  build(ctx, area) {
    const b = emptyBuild();
    const cfg = CITY.districts.alley;
    const g = ctx.graph;
    const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
    const push = (kind: PropKind, p: { x: number; z: number; yaw: number }, jitter = 0.2, lift: number = CITY.curbHeight, yaw?: number) =>
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: (yaw ?? p.yaw) + rng.range(-jitter, jitter), lift, area: area.id });
    for (const eid of area.edges) {
      const e = g.edges[eid];
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      const walk = e.sidewalk;
      const half = e.width / 2;
      const mid = half + walk / 2;
      const ux = (B.x - A.x) / len;
      const uz = (B.z - A.z) / len;
      // Hoarding panels lie along the alley (local +X), their banners facing the road.
      const along = Math.atan2(-uz, ux);
      b.surfaces.push(cobblePatch(ctx, eid, area.id));
      for (const side of [1, -1]) {
        // Clear of the crossing streets at both ends (their road, sidewalk and a corner rail's line).
        const from = Math.max(cfg.endClear, mouthReach(g, e.a, area.edges, ux, uz, half + walk, side));
        const to = len - Math.max(cfg.endClear, mouthReach(g, e.b, area.edges, -ux, -uz, half + walk, -side));
        let s = from + rng.range(0, 2);
        while (s < to - 3) {
          const block = rng.range(7, 13);
          const end = Math.min(to, s + block);
          const r = rng.next();
          if (r < 0.4) {
            // Restaurant front: pots at both ends, tables between.
            push('planterPot', sideSpot(A, B, s + 0.6, side * mid));
            for (let t = s + 2.2; t < end - 1.6; t += cfg.tableSpacing) if (rng.chance(0.9)) push('cafeTable', sideSpot(A, B, t, side * mid), 0.5);
            push('planterPot', sideSpot(A, B, end - 0.6, side * mid));
          } else if (r < 0.72) {
            // Deliveries and trash out back of the kitchens.
            for (let t = s + 0.8; t < end - 0.6; t += rng.range(1.1, 1.8)) {
              const k = rng.next();
              const kind: PropKind = k < 0.3 ? 'crate' : k < 0.5 ? 'barrel' : k < 0.72 ? 'trashBags' : k < 0.86 ? 'pallets' : 'newsBox';
              push(kind, sideSpot(A, B, t, side * (mid + rng.range(-0.2, 0.2))), 3);
            }
          } else {
            // Street works: hoarding along the wall (clear of the road), heavy pieces on the sidewalk and
            // soft ones spilling off the curb onto the cobbles, where they break at a touch.
            for (let t = s + 1.3; t < end - 1.2; t += 2.4) push('fencePanel', sideSpot(A, B, t, side * (half + walk - 0.45)), 0.08, CITY.curbHeight, along);
            push(rng.chance(0.5) ? 'sandbags' : 'waterBarrier', sideSpot(A, B, s + rng.range(1, 3), side * mid), 0.1, CITY.curbHeight, along);
            push('sawhorse', sideSpot(A, B, s + rng.range(3, block - 2), side * (half - 0.5)), 0.2, 0, along + Math.PI / 2);
            for (let k = 0; k < 3; k++) push('trafficCone', sideSpot(A, B, s + rng.range(0.5, block - 0.5), side * (half - rng.range(0.3, 1.1))), 3, 0);
            if (rng.chance(0.5)) push('pallets', sideSpot(A, B, end - 1, side * mid), 3);
          }
          s = end + rng.range(1, 3);
        }
      }
    }
    return b;
  },
};

export const backAlleyModule: DistrictModule = {
  kind: 'backAlley',
  phase: 'graph',
  plan(ctx) {
    const cfg = CITY.districts.backAlley;
    if (!cfg.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    const faces = ctx.faces().filter((f) => {
      if (f.outer || f.corners.length !== 4 || f.edges.length !== 4 || f.area < 9000 || f.area > 26000) return false;
      if (f.corners.some((c) => g.nodes[c.node].ring)) return false;
      return f.edges.every((e) => {
        const k = g.edges[e].kind;
        return (k === 'street' || k === 'avenue' || k === 'boulevard') && !g.edges[e].bridge && !ctx.claims.edge.has(e);
      });
    });
    rng.shuffle(faces);
    const touched = new Set<number>();
    let made = 0;
    for (const f of faces) {
      if (made >= count) break;
      if (f.edges.some((e) => touched.has(e))) continue;
      const pairs = [
        [f.edges[0], f.edges[2]],
        [f.edges[1], f.edges[3]],
      ].filter(([a, b]) => g.edges[a].length >= cfg.minSide && g.edges[b].length >= cfg.minSide);
      if (!pairs.length) continue;
      const [ea, eb] = pairs[rng.int(0, pairs.length - 1)];
      const ta = 0.5 + rng.range(-0.1, 0.1);
      const tb = 0.5 + rng.range(-0.1, 0.1);
      const pa = g.edges[ea];
      const pb = g.edges[eb];
      const A = { x: g.nodes[pa.a].x + (g.nodes[pa.b].x - g.nodes[pa.a].x) * ta, z: g.nodes[pa.a].z + (g.nodes[pa.b].z - g.nodes[pa.a].z) * ta };
      const B = { x: g.nodes[pb.a].x + (g.nodes[pb.b].x - g.nodes[pb.a].x) * tb, z: g.nodes[pb.a].z + (g.nodes[pb.b].z - g.nodes[pb.a].z) * tb };
      const length = Math.hypot(B.x - A.x, B.z - A.z);
      if (length < 50) continue;
      const footprint = length * (CITY.width.backAlley + 2 * CITY.sidewalkWidth.backAlley);
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      const na = splitEdge(g, ea, ta);
      const nb = splitEdge(g, eb, tb);
      const id = addEdge(g, na, nb, 'backAlley');
      g.edges[id].shortcut = true;
      f.edges.forEach((e) => touched.add(e));
      touched.add(g.edges.length - 2).add(g.edges.length - 3);
      const path = [A, B];
      // A kicker hump in the middle or two thirds of the way along, clear of both (flared) mouths.
      const half = cfg.jumpRamp + cfg.jumpTop / 2;
      const end = half + 15 + cfg.mouth.alley;
      const jump = rng.chance(cfg.jumpChance) && length > 2 * end ? 1 : 0;
      const jumpS = Math.max(end, Math.min(length - end, length * rng.pick([0.5, 0.35, 0.65])));
      ctx.addArea(
        { kind: 'backAlley', variant: 'shortcut', polygon: corridor(path, CITY.width.backAlley / 2 + CITY.sidewalkWidth.backAlley), path, nodes: [na, nb], edges: [id], faces: [], params: { length, jump, jumpS, seed: rng.int(1, 0x7ffffffe) } },
        footprint,
      );
      made++;
    }
    if (made) ctx.graphChanged();
  },
  build(ctx, area) {
    const b = emptyBuild();
    const cfg = CITY.districts.backAlley;
    const P = area.params;
    const path = area.path;
    const cum = pathCum(path);
    const hw = (P.width ?? CITY.width.backAlley) / 2 + CITY.sidewalkWidth.backAlley;
    // The kicker sits on one leg (jumpS is a position along the whole chain).
    if (P.jump) {
      const i = legAt(cum, P.jumpS);
      const u = unit(path[i], path[i + 1]);
      addJump(b, path[i], u.x, u.z, u.len, hw, P.jumpS - cum[i]);
    }
    for (const eid of area.edges) b.surfaces.push(cobblePatch(ctx, eid, area.id));
    for (const nid of area.nodes) b.surfaces.push(...mouthPatches(ctx, nid, area.id));
    // A bend between two legs: the wedge outside both legs' strips is cobbled too.
    for (let i = 1; i + 1 < area.nodes.length; i++) b.surfaces.push(bendPatch(ctx, area.nodes[i], area.id));
    const rng = new Rng(((P.seed ?? 0) >>> 0) || 1);
    if (area.variant === 'routeShortcut') {
      const jumpClear = (s: number, r: number) => !P.jump || Math.abs(s - P.jumpS) > cfg.jumpRamp + cfg.jumpTop / 2 + 2 + r;
      if (P.jumpExit) addJumpExit(ctx, area, b, path, hw, rng);
      constructionSite(ctx, area, b, rng, path, cum, hw, jumpClear);
      return b;
    }
    // Plain back alleys are one straight edge.
    const [A, B] = path;
    const len = cum[1] || 1;
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const g = ctx.graph;
    // A shortcut's corners flare (blocks.ts computeSectors): its mouths reach further in.
    const flare = cfg.mouth.alley;
    const lo = [1, -1].map((sd) => mouthReach(g, area.nodes[0], area.edges, ux, uz, hw, sd) + flare);
    // Seen from B the alley runs backwards, so its left is our right.
    const hi = [1, -1].map((sd) => len - mouthReach(g, area.nodes[1], area.edges, -ux, -uz, hw, -sd) - flare);
    const sLo = Math.min(lo[0], lo[1]);
    const sHi = Math.max(hi[0], hi[1]);
    // Dumpsters against the walls, alternating sides, with bags and crates around them.
    const clear = (s: number, lateral = 0) => {
      const k = lateral < 0 ? 1 : 0;
      const a = lateral === 0 ? Math.max(lo[0], lo[1]) : lo[k];
      const z = lateral === 0 ? Math.min(hi[0], hi[1]) : hi[k];
      return s >= a && s <= z && (!P.jump || Math.abs(s - P.jumpS) > cfg.jumpRamp + cfg.jumpTop / 2 + 4);
    };
    const push = (kind: PropKind, s: number, lateral: number, jitter: number, yaw?: number) => {
      if (!clear(s, lateral)) return;
      const p = sideSpot(A, B, s, lateral);
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: (yaw ?? p.yaw) + rng.range(-jitter, jitter), lift: 0, area: area.id });
    };
    funnelClutter(ctx, area, b, () => rng.pick(FUNNEL_MIX), rng);
    let side = rng.chance(0.5) ? 1 : -1;
    let dumpsters = 0;
    for (let s = sLo + rng.range(0, 6); s < sHi; s += cfg.dumpsterSpacing * rng.range(0.7, 1.3)) {
      if (clear(s, side)) dumpsters++;
      push('dumpster', s, side * (hw - 0.62), 0.05);
      push('trashBags', s + rng.pick([-1.9, 1.9]), side * (hw - 0.55), 3);
      if (rng.chance(0.7)) push(rng.chance(0.5) ? 'crate' : 'barrel', s + rng.range(3.2, 4.5), side * (hw - 0.6), 3);
      if (rng.chance(0.5)) push('trashBags', s + rng.range(5, 8), -side * (hw - 0.55), 3);
      // The other wall: pallets, a crate, the odd sawhorse and some cones left behind by the works.
      const other = rng.next();
      if (other < 0.4) push('pallets', s + rng.range(1, 6), -side * (hw - 0.75), 3);
      else if (other < 0.65) push('crate', s + rng.range(1, 6), -side * (hw - 0.75), 3);
      else if (other < 0.8) push('sawhorse', s + rng.range(2, 6), -side * (hw - 0.95), 0.3);
      if (rng.chance(0.35)) for (let k = 0; k < 2; k++) push('trafficCone', s + rng.range(-2, 7), -side * (hw - rng.range(0.5, 1.4)), 3);
      side = -side;
    }
    // Short alleys whose kicker took every slot still get one, clear of the ramps.
    if (!dumpsters) {
      found: for (const sd of [side, -side]) {
        for (const t of [lo[sd < 0 ? 1 : 0] + 1.5, hi[sd < 0 ? 1 : 0] - 1.5]) {
          if (clear(t, sd) && clear(t + 1.5, sd) && clear(t - 1.5, sd)) {
            push('dumpster', t, sd * (hw - 0.62), 0.05);
            break found;
          }
        }
      }
    }
    return b;
  },
};

/** Half width (m) of the line down the middle of every alley that nothing solid may stand in: a car plus a margin. */
export const LANE = 1.3;

/**
 * How far (m) into an alley the streets at node nid reach (road, sidewalk,
 * furniture and a corner rail's line), at the angle the alley (direction t,
 * half width hw) leaves them: a diagonal mouth runs much deeper than a square
 * one, and deepest on its acute side (side = +1 left of t, -1 right).
 */
function mouthReach(g: RoadGraph, nid: number, own: readonly number[], tx: number, tz: number, hw: number, side: number): number {
  let depth = 12;
  const n = g.nodes[nid];
  for (const eid of n.edges) {
    if (own.includes(eid)) continue;
    const e = g.edges[eid];
    const d = unit(n, g.nodes[e.a === nid ? e.b : e.a]);
    const sinA = Math.max(0.35, Math.abs(d.x * tz - d.z * tx));
    // Left of travel (tx, tz) is (-tz, tx): a side toward the street's direction sits closer to it.
    const toward = side * (-tz * d.x + tx * d.z) > 0 ? 1 : -1;
    const cosA = Math.abs(d.x * tx + d.z * tz);
    depth = Math.max(depth, (e.width / 2 + e.sidewalk + 2.5 + toward * hw * cosA) / sinA + 1);
  }
  return depth;
}

/** Surface patch priorities of a flared shortcut mouth: its junction fan over the street classification, its corners' sidewalks over offroad. */
const MOUTH_ROAD = 5.5;
const MOUTH_WALK = 3.5;

/**
 * A shortcut mouth's surfaces at node nid (blocks.ts flares its corners): the
 * whole junction fan out to the curved curbs is asphalt, and each flared
 * corner's curved sidewalk is sidewalk.
 */
function mouthPatches(ctx: BuildContext, nid: number, area: number): SurfacePatch[] {
  const secs = ctx.sectors[nid];
  if (!secs.some((s) => s.flared)) return [];
  const fan: Vec2[] = [];
  for (const s of secs) for (const p of s.curb) fan.push(p);
  const out: SurfacePatch[] = [{ surface: 'road', polygon: fan, priority: MOUTH_ROAD, area }];
  for (const s of secs) if (s.flared) out.push({ surface: 'sidewalk', polygon: [...s.curb, ...s.outer.slice().reverse()], priority: MOUTH_WALK, area });
  return out;
}

/** An edge's road strip, curb to curb between its two mouths, as a cobble surface patch (the junction fans stay asphalt). */
function cobblePatch(ctx: BuildContext, eid: number, area: number): SurfacePatch {
  const m = ctx.mouths[eid];
  return { surface: 'cobble', polygon: [m.aP.curb, m.bP.curb, m.bN.curb, m.aN.curb], priority: COBBLE_PRIORITY, area };
}

/** The fan at a bend node between two legs of a chain (its sectors' curb points), cobbled like the legs: the outside of the bend is rounded past both strips. */
function bendPatch(ctx: BuildContext, nid: number, area: number): SurfacePatch {
  const fan: Vec2[] = [];
  for (const s of ctx.sectors[nid]) for (const p of s.curb) fan.push(p);
  return { surface: 'cobble', polygon: fan, priority: COBBLE_PRIORITY, area };
}

/** Construction site layout in a route shortcut (constructionSite). */
const SITE = {
  /** Fences stand this far inside the alley's mouth (past the flared corners) and stop this far inside its walls (m). */
  fenceBack: 0.6,
  fenceInset: 0.35,
  /**
   * Panel spacing never drops below this (m): two fence panel props closer than their radii plus
   * half the prop gap would overlap and one would be dropped (city/props.ts). Panels overlap a
   * little visually instead, like real clamped fencing.
   */
  panelMin: 1.96,
  /** Barricades and cones stand this far inside each fence (m); wall clutter starts this far in. */
  barricade: 3.8,
  inside: 7,
  /** Gap between wall pieces along the alley (m): their radii plus [min, max]. */
  gap: [0.35, 1.7],
  /** Cones of the taper along each flared mouth corner stand this far out from the curb (m), and this far off the street's own road strip. */
  taper: 0.6,
  taperClear: 1.2,
  /** Chance a soft piece stands out from the wall into the alley (it may block the line: it breaks). */
  intrude: 0.3,
} as const;

/** Wall clutter mix: kind and weight. Everything but the dumpster breaks before it can stop a car. */
const SITE_MIX: [PropKind, number][] = [
  ['crate', 17],
  ['barrel', 13],
  ['trashBags', 14],
  ['pallets', 14],
  ['sandbags', 10],
  ['waterBarrier', 10],
  ['trafficCone', 9],
  ['sawhorse', 6],
  ['dumpster', 7],
];
const SOFT = new Set<PropKind>(['crate', 'trashBags', 'pallets', 'trafficCone', 'sawhorse', 'barrel']);

/**
 * A route shortcut as a construction site: temporary fence panels across both
 * mouths (just behind the street's building line, the whole alley width,
 * contractors' banners on them) that a car smashes through on the way in and
 * out, striped sawhorses and cones behind each fence, and both walls lined
 * with site clutter (crates, barrels, bags, pallets, sandbags, water filled
 * barriers, the odd dumpster). Only soft pieces stand out into the alley: the
 * middle LANE each side of the centerline stays clear of anything that could
 * stop a car (PROP_DEFS breakSpeed). Pieces skip the kicker and the inside of
 * every bend (where the walls mitre). At a jump exit the exit fence stands
 * across the lip instead and the clutter stops short of the ramp's toe.
 */
function constructionSite(ctx: BuildContext, area: Area, b: AreaBuild, rng: Rng, path: Vec2[], cum: number[], hw: number, jumpClear: (s: number, r: number) => boolean): void {
  const len = cum[cum.length - 1];
  const legs = path.length - 1;
  const J = CITY.districts.backAlley.route.jump;
  const P = area.params;
  const legDir = (i: number) => unit(path[i], path[i + 1]);
  // Yaws at a chain position: local +X across the alley, or along it (fences, planks and barriers lie along local X).
  const yawsAt = (s: number) => {
    const u = legDir(legAt(cum, s));
    return { across: Math.atan2(-u.x, -u.z), along: Math.atan2(-u.z, u.x) };
  };
  const edge = hw - SITE.fenceInset;
  /** A row of fence panels from p0 to p1. */
  const panels = (p0: Vec2, p1: Vec2) => {
    const span = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const dx = (p1.x - p0.x) / span;
    const dz = (p1.z - p0.z) / span;
    const count = Math.max(1, Math.floor(span / SITE.panelMin));
    const yaw = Math.atan2(-dz, dx);
    for (let k = 0; k < count; k++) {
      const u = (span * (k + 0.5)) / count;
      b.destructibles.push({ kind: 'fencePanel', x: p0.x + dx * u, z: p0.z + dz * u, yaw, lift: 0, area: area.id });
    }
  };
  /**
   * Fence across the mouth at the entry (or the exit), wall to wall where the
   * alley's straight walls start past the flared corners, fenceBack inside;
   * returns its chain position (s) at lateral -edge and +edge.
   */
  const fence = (atA: boolean): [number, number] | null => {
    const li = atA ? 0 : legs - 1;
    const O = path[li];
    const u = legDir(li);
    const m = ctx.mouths[area.edges[li]];
    const into = atA ? 1 : -1;
    // P is the left wall seen along the leg (lateral +), N the right.
    const Pw = atA ? m.aP.outer : m.bP.outer;
    const Nw = atA ? m.aN.outer : m.bN.outer;
    const lat = (p: Vec2) => (p.x - O.x) * -u.z + (p.z - O.z) * u.x;
    const lN = lat(Nw);
    const lP = lat(Pw);
    if (lP - lN < 1) return null;
    const at = (l: number): Vec2 => {
      const t = (l - lN) / (lP - lN);
      return { x: Nw.x + (Pw.x - Nw.x) * t + u.x * into * SITE.fenceBack, z: Nw.z + (Pw.z - Nw.z) * t + u.z * into * SITE.fenceBack };
    };
    const p0 = at(-edge);
    const p1 = at(edge);
    panels(p0, p1);
    const sOf = (p: Vec2) => cum[li] + (p.x - O.x) * u.x + (p.z - O.z) * u.z;
    return [sOf(p0), sOf(p1)];
  };
  /** The jump exit's fence: across the lip, on the ramp's top just behind the face. */
  const lipFence = (): [number, number] => {
    const s = len - P.lipS - 0.7;
    const p0 = pathSpot(path, cum, s, -edge);
    const p1 = pathSpot(path, cum, s, edge);
    panels(p0, p1);
    return [s, s];
  };
  const inF = fence(true) ?? [12, 12];
  const outF = P.jumpExit ? lipFence() : (fence(false) ?? [len - 12, len - 12]);
  // The flared mouths: a taper of cones along each curved curb, lining the funnel into the fence.
  funnelClutter(ctx, area, b, () => 'trafficCone', rng);
  // A fence across a diagonal mouth is oblique: where it stands depends on the lateral offset.
  const fenceS = (f: [number, number], lat: number) => f[0] + ((Math.max(-edge, Math.min(edge, lat)) + edge) / (2 * edge)) * (f[1] - f[0]);
  const s0 = Math.max(inF[0], inF[1]);
  // Wall clutter ends at the exit fence, or short of a jump exit's ramp (a clean run-up).
  const s1 = P.jumpExit ? len - P.lipS - J.length - 2 : Math.min(outF[0], outF[1]);
  /** Bends: the inside wall mitres, so nothing stands within the mitre's reach of the node on that side; the outside only skips the node itself. */
  const bendClear = (s: number, lateral: number, r: number) => {
    for (let i = 1; i < legs; i++) {
      const u = legDir(i - 1);
      const v = legDir(i);
      const turn = Math.atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z);
      const inside = Math.sign(turn) === Math.sign(lateral);
      const reach = inside ? hw * Math.tan(Math.abs(turn) / 2) + r + 0.6 : r + 0.3;
      if (Math.abs(s - cum[i]) < reach) return false;
    }
    return true;
  };
  /** Place a piece at chain position s and lateral offset (left +), inside both fences, off the kicker and the bends. */
  const push = (kind: PropKind, s: number, lateral: number, jitter: number, yaw?: number) => {
    const r = PROP_DEFS[kind].radius;
    if (s - r < fenceS(inF, lateral) + 0.9 || s + r > Math.min(s1, fenceS(outF, lateral)) - 0.9 || !jumpClear(s, r) || !bendClear(s, lateral, r)) return;
    const p = pathSpot(path, cum, s, lateral);
    b.destructibles.push({ kind, x: p.x, z: p.z, yaw: (yaw ?? p.yaw) + rng.range(-jitter, jitter), lift: 0, area: area.id });
  };
  // Behind each fence: a sawhorse or two across the alley, cones scattered around them (a jump exit's lip fence has nothing behind it: the ramp).
  const barricades: [number, number][] = [[s0 + SITE.barricade, 1]];
  if (!P.jumpExit) barricades.push([s1 - SITE.barricade, -1]);
  for (const [s, dir] of barricades) {
    const { across, along } = yawsAt(s);
    const lat = rng.range(0.9, 2.1) * (rng.chance(0.5) ? 1 : -1);
    push('sawhorse', s, lat, 0.15, across);
    if (rng.chance(0.6)) push('sawhorse', s + dir * rng.range(1.6, 2.4), -lat * rng.range(0.6, 1.1), 0.15, across);
    for (let k = 0; k < 4; k++) push('trafficCone', s + dir * rng.range(-0.8, 2.8), rng.range(-2.6, 2.6), 3);
    push(rng.chance(0.5) ? 'waterBarrier' : 'sandbags', s + dir * rng.range(0, 1.5), (lat > 0 ? -1 : 1) * (hw - 1.05), 0.05, along);
  }
  // Both walls lined with site clutter from just inside the fences.
  const total = SITE_MIX.reduce((t, [, w]) => t + w, 0);
  const pick = (): PropKind => {
    let x = rng.range(0, total);
    for (const [k, w] of SITE_MIX) if ((x -= w) < 0) return k;
    return 'crate';
  };
  for (const side of [1, -1]) {
    let s = s0 + SITE.inside + rng.range(0, 2);
    while (s < s1 - SITE.inside) {
      let kind = pick();
      let r = PROP_DEFS[kind].radius;
      let lat = hw - r - 0.15;
      if (SOFT.has(kind)) {
        if (rng.chance(SITE.intrude)) lat = Math.max(0.4, lat - rng.range(0.6, 1.9));
      } else {
        // Heavy pieces stand flush to the wall, and out of the line down the middle or not at all.
        lat = hw - r - 0.05;
        if (lat - r < LANE) {
          kind = 'crate';
          r = PROP_DEFS[kind].radius;
          lat = hw - r - 0.15;
        }
      }
      const at = s + r;
      if (at > s1 - SITE.inside) break;
      const yaw = kind === 'waterBarrier' || kind === 'dumpster' ? yawsAt(at).along + (side > 0 ? 0 : Math.PI) : undefined;
      if (kind === 'trafficCone') {
        for (let k = 0; k < 3; k++) push('trafficCone', at + rng.range(-0.6, 0.6), side * (lat - rng.range(0, 1.2)), 3);
      } else push(kind, at, side * lat, kind === 'dumpster' ? 0.05 : 0.6, yaw);
      s = at + r + rng.range(SITE.gap[0], SITE.gap[1]);
    }
  }
}

/** The face under a jump exit's lip stands this far past the terrain's drop (m): the road mesh's step (one tessellation piece) hides inside its block. */
const LIP_FACE = 1.0;

/** Soft clutter below a jump exit's lip and around its landing side (everything breaks at a touch). */
const LANDING_MIX: PropKind[] = ['crate', 'barrel', 'trashBags', 'pallets', 'trashBags', 'crate'];

/**
 * A route shortcut's jump exit on its last leg (see the header): the ramp as
 * a height modifier (fading out behind the walls like the kicker, dropping to
 * street level past the lip), the face under the lip as an 'alleyLip' wall
 * toward the street (Wall.top settled once the terrain exists, see
 * settleAlleyLips), reserved circles along the flight so street furniture
 * keeps off it, the deck hint for the renderer, and soft clutter: along the
 * obtuse wall below the lip, on the street's sidewalk in the acute pocket
 * beside the mouth and along the curb past the landing.
 */
function addJumpExit(ctx: BuildContext, area: Area, b: AreaBuild, path: Vec2[], hw: number, rng: Rng): void {
  const J = CITY.districts.backAlley.route.jump;
  const F = CITY.districts.backAlley.jumpFade;
  const P = area.params;
  const n = path.length;
  const O = path[n - 2];
  const B = path[n - 1];
  const u = unit(O, B);
  const sLip = u.len - P.lipS;
  const sToe = sLip - J.length;
  const H = J.rise;
  const at = (s: number, l: number): Vec2 => ({ x: O.x + u.x * s - u.z * l, z: O.z + u.z * s + u.x * l });
  const corners = [at(sToe - 0.5, -(hw + F)), at(sToe - 0.5, hw + F), at(sLip + 0.5, -(hw + F)), at(sLip + 0.5, hw + F)];
  b.heightMods.push({
    minX: Math.min(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x: number, z: number, out: HeightSample) {
      const dx = x - O.x;
      const dz = z - O.z;
      const s = dx * u.x + dz * u.z;
      if (s <= sToe || s > sLip) return;
      const l = -dx * u.z + dz * u.x;
      const p = jumpRampProfile(s - sToe, J.length, H);
      const al = Math.abs(l);
      const m = smooth01(hw + F, hw, al);
      if (m.v <= 0) return;
      const sl = l < 0 ? -1 : 1;
      out.h += p.h * m.v;
      out.gx += m.v * p.dh * u.x + p.h * m.d * sl * -u.z;
      out.gz += m.v * p.dh * u.z + p.h * m.d * sl * u.x;
    },
  });
  // The face under the lip, wall to wall, toward the street, LIP_FACE past the drop (the renderer's block
  // covers the step between them); full height until settled.
  const right = at(sLip + LIP_FACE, -hw);
  const left = at(sLip + LIP_FACE, hw);
  b.walls.push({ ax: right.x, az: right.z, bx: left.x, bz: left.z, nx: u.x, nz: u.z, kind: 'wall', look: 'alleyLip', area: area.id, top: Infinity });
  b.hints.push({ kind: 'jumpExit', points: [O, { x: O.x + u.x, z: O.z + u.z }], values: [sToe, J.length, H, hw] });
  // The flight: furniture keeps off the corridor from the lip to the furthest landing.
  const spread = Math.tan(J.spreadDeg * RAD);
  for (let s = 0; s <= P.landMax + 6; s += 3) {
    const c = at(sLip + s, 0);
    b.reserved.push({ x: c.x, z: c.z, r: hw + s * spread + CAR_HALF });
  }
  // The exit street at B: forward is the street edge leaving B the way the leg heads.
  const g = ctx.graph;
  const nodeB = g.nodes[area.nodes[n - 1]];
  let uE = { x: u.x, z: u.z };
  let OB = hw;
  for (const eid of nodeB.edges) {
    const e = g.edges[eid];
    if (e.shortcut) continue;
    const d = unit(nodeB, g.nodes[otherNode(e, nodeB.id)]);
    if (d.x * u.x + d.z * u.z <= 0) continue;
    uE = { x: d.x, z: d.z };
    OB = e.width / 2 + e.sidewalk;
  }
  const cosT = Math.abs(u.x * uE.x + u.z * uE.z);
  const sinT = Math.max(0.2, Math.sqrt(Math.max(0, 1 - cosT * cosT)));
  // The forward street lies on the obtuse side of the mouth; the alley's walls end sObtuse and sAcute before B.
  const sideF = Math.sign(u.x * uE.z - u.z * uE.x) || 1;
  const sObtuse = (OB - hw * cosT) / sinT;
  const sAcute = (OB + hw * cosT) / sinT;
  // Every piece inside the area's outline (its mouth and landing tongue), the rule for district clutter.
  const push = (kind: PropKind, p: Vec2, yaw: number, jitter: number) => {
    const y = yaw + rng.range(-jitter, jitter);
    if (pointInPolygon(p.x, p.z, area.polygon)) b.destructibles.push({ kind, x: p.x, z: p.z, yaw: y, lift: 0, area: area.id });
  };
  // Below the lip: pieces along the obtuse wall between the face and where that wall ends.
  for (let s = sLip + 1.4; s < u.len - sObtuse - 1.2; s += rng.range(1.6, 2.6)) {
    const kind = rng.pick(LANDING_MIX);
    const r = PROP_DEFS[kind].radius;
    if (s + r > u.len - sObtuse - 1) break;
    push(kind, at(s, sideF * (hw - r - 0.2)), rng.range(0, Math.PI * 2), 0);
  }
  // Around the landing side, in street coordinates from B (forward along uE, lateral toward the block):
  // bags and cones on the sidewalk strip of the acute pocket beside the mouth, cones and a sawhorse along
  // the curb past the landing.
  const nB = { x: sideF * -uE.z, z: sideF * uE.x };
  const street = (a: number, l: number): Vec2 => ({ x: B.x + uE.x * a + nB.x * l, z: B.z + uE.z * a + nB.z * l });
  const curb = OB - CITY.sidewalk;
  for (let a = -sAcute * cosT + 3; a < -sObtuse * cosT - 2; a += rng.range(2.6, 4)) {
    const kind = rng.chance(0.6) ? 'trashBags' : rng.chance(0.5) ? 'trafficCone' : 'crate';
    push(kind, street(a, rng.range(curb + 0.8, OB - 0.9)), rng.range(0, Math.PI * 2), 0);
  }
  const alongYaw = Math.atan2(-uE.z, uE.x);
  push('sawhorse', street(rng.range(4, 9), curb + 1.1), alongYaw, 0.2);
  for (let k = 0; k < 3; k++) push('trafficCone', street(rng.range(2, 22), curb + rng.range(0.6, 1.6)), 0, 3);
  push('barrel', street(rng.range(12, 20), curb + 1.2), 0, 3);
}

/**
 * Give the face under each jump exit's lip its height (Wall.top): the street
 * in front of it plus the lip's rise less `drop`, so street cars are stopped
 * and the launching car, riding the ramp's top, passes over. Runs once the
 * terrain exists (createCity); until then the face is full height.
 */
export function settleAlleyLips(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  const J = CITY.districts.backAlley.route.jump;
  areas.forEach((a, i) => {
    if (a.kind !== 'backAlley' || !a.params.jumpExit) return;
    for (const w of builds[i].walls) {
      if (w.look !== 'alleyLip' || w.top === undefined) continue;
      const mx = (w.ax + w.bx) / 2 + w.nx * 1.5;
      const mz = (w.az + w.bz) / 2 + w.nz * 1.5;
      w.top = terrain.heightAt(mx, mz) + J.rise - J.drop;
    }
  });
}

/**
 * The flight corridor past a jump exit (world quad): from just behind the lip
 * `reach` m along the last leg, spreading at spreadDeg, padded `pad` m each side.
 */
export function jumpFlightZone(area: Area, reach: number, pad = 0): Vec2[] {
  const J = CITY.districts.backAlley.route.jump;
  const n = area.path.length;
  const O = area.path[n - 2];
  const u = unit(O, area.path[n - 1]);
  const hw = (area.params.width ?? CITY.width.backAlley) / 2 + CITY.sidewalkWidth.backAlley;
  const sLip = u.len - area.params.lipS;
  const spread = Math.tan(J.spreadDeg * RAD);
  const h0 = hw + pad;
  const h1 = hw + reach * spread + pad;
  const at = (s: number, l: number): Vec2 => ({ x: O.x + u.x * s - u.z * l, z: O.z + u.z * s + u.x * l });
  return [at(sLip - 0.5, -h0), at(sLip + reach, -h1), at(sLip + reach, h1), at(sLip - 0.5, h0)];
}

/** The area of a route shortcut (the back alley whose chain holds its first edge), if any. */
export function shortcutArea(areas: readonly Area[], sc: { edges: readonly number[] }): Area | undefined {
  return areas.find((a) => a.kind === 'backAlley' && a.edges.includes(sc.edges[0]));
}

/** A route's corner rails with every piece the flight off one of its jump exits would cross taken out (see carPark.ts railsClearOf). */
export function shortcutJumpRails<T extends Wall>(route: { shortcuts: { edges: readonly number[] }[] }, areas: readonly Area[], rails: T[]): T[] {
  const zones: Vec2[][] = [];
  for (const sc of route.shortcuts) {
    const a = shortcutArea(areas, sc);
    if (a?.params.jumpExit) zones.push(jumpFlightZone(a, a.params.landMax + 6, CAR_HALF + 1.5));
  }
  return railsClearOf(zones, rails);
}

/**
 * Dress a back alley's flared mouths: a piece from pick() at every inner point
 * of each curved curb, SITE.taper out on the asphalt, none on the street's own
 * road strip. Soft pieces only: they line the funnel, they never close it.
 */
function funnelClutter(ctx: BuildContext, area: Area, b: AreaBuild, pick: () => PropKind, rng: Rng): void {
  const g = ctx.graph;
  for (const nid of area.nodes) {
    const n = g.nodes[nid];
    ctx.sectors[nid].forEach((sec, k) => {
      if (!sec.flared) return;
      const eA = g.edges[n.edges[k]];
      const street = eA.shortcut ? g.edges[n.edges[(k + 1) % n.edges.length]] : eA;
      const sa = g.nodes[street.a];
      const sb = g.nodes[street.b];
      for (let i = 1; i + 1 < sec.curb.length; i++) {
        const c = sec.curb[i];
        // The building line lies behind the curb, so away from it is out onto the road.
        const ox = c.x - sec.outer[i].x;
        const oz = c.z - sec.outer[i].z;
        const ol = Math.hypot(ox, oz) || 1;
        const x = c.x + (ox / ol) * SITE.taper;
        const z = c.z + (oz / ol) * SITE.taper;
        if (distToSegment(x, z, sa.x, sa.z, sb.x, sb.z) - street.width / 2 < SITE.taperClear) continue;
        // Inside the alley's outline (district clutter stays in its area): a curb curve's street end can
        // put a cone past the mouth's crossing line.
        if (!pointInPolygon(x, z, area.polygon)) continue;
        b.destructibles.push({ kind: pick(), x, z, yaw: rng.range(0, Math.PI * 2), lift: 0, area: area.id });
      }
    });
  }
}

/** Plain back alley mouths: what spills out of a back alley onto the funnel's asphalt. */
const FUNNEL_MIX: PropKind[] = ['trashBags', 'crate', 'trashBags', 'barrel', 'trafficCone'];

/** The back alley kicker: a height modifier across the alley (fading out behind the walls) plus a render hint. */
function addJump(b: AreaBuild, A: Vec2, ux: number, uz: number, len: number, hw: number, center: number): void {
  const cfg = CITY.districts.backAlley;
  const R = cfg.jumpRamp;
  const T = cfg.jumpTop;
  const H = cfg.jumpHeight;
  const F = cfg.jumpFade;
  const s0 = center - T / 2 - R;
  const s3 = center + T / 2 + R;
  void len;
  // Bounding box of the footprint (along s0..s3, across +-(hw + F)).
  const corners: Vec2[] = [];
  for (const s of [s0, s3]) for (const l of [-(hw + F), hw + F]) corners.push({ x: A.x + ux * s - uz * l, z: A.z + uz * s + ux * l });
  b.heightMods.push({
    minX: Math.min(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x: number, z: number, out: HeightSample) {
      const dx = x - A.x;
      const dz = z - A.z;
      const s = dx * ux + dz * uz;
      const l = -dx * uz + dz * ux;
      const p = jumpProfile(s, center, R, T, H);
      if (p.h === 0 && p.dh === 0) return;
      const al = Math.abs(l);
      const m = smooth01(hw + F, hw, al);
      if (m.v <= 0) return;
      const sl = l < 0 ? -1 : 1;
      out.h += p.h * m.v;
      out.gx += m.v * p.dh * ux + p.h * m.d * sl * -uz;
      out.gz += m.v * p.dh * uz + p.h * m.d * sl * ux;
    },
  });
  b.hints.push({ kind: 'jump', points: [A, { x: A.x + ux, z: A.z + uz }], values: [center, R, T, H, hw] });
}

// ---------------------------------------------------------------------------
// Route shortcuts
// ---------------------------------------------------------------------------

/** Corner rails go on route turns at least this sharp (rad). */
const ROUTE_RAIL_MIN_TURN = (ROUTE.railMinTurnDeg * Math.PI) / 180;
const RAD = Math.PI / 180;
/** Spacing of the entry and exit points the fallback chord search tries along each route edge (m). */
const CHORD_STEP = 6;
/** Room (m) a fallback chord keeps from other streets' sidewalks (cfg.clear for the regular cuts). */
const CHORD_CLEAR = 1.5;
/** Splits on a sprint stay this far past its start (grid rows and the start line) and before its end (finish line and runout), m. */
const START_CLEAR = ROUTE.sprintStartOffset + 25;
const FINISH_CLEAR = ROUTE.sprintFinishOffset + ROUTE.sprintFinishNodeClear + 30;

/** Position (m along the node polyline) of a point lying on one of the route's edges, or null. */
function projectOnRoute(g: RoadGraph, r: CarveRoute, cum: number[], p: Vec2): number | null {
  const n = r.nodes.length;
  const m = r.closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = g.nodes[r.nodes[i]];
    const b = g.nodes[r.nodes[(i + 1) % n]];
    if (distToSegment(p.x, p.z, a.x, a.z, b.x, b.z) < 0.01) return cum[i] + Math.hypot(p.x - a.x, p.z - a.z);
  }
  return null;
}

/** A route as the shortcut carver sees it: its nodes in driving order (edited in place when an edge it uses is split). */
export interface CarveRoute {
  nodes: number[];
  closed: boolean;
}

interface Cut {
  /** Route edges the entry and exit are on, the route node each is measured from and how far from it (m). */
  eA: number;
  fromA: number;
  dA: number;
  eB: number;
  fromB: number;
  dB: number;
  /** The alley's path, entry first: the straight chord, bent by the planner's bend() when carved, or a jump cut's planned chain. */
  path: Vec2[];
  /** Length of the path (m). */
  length: number;
  /** Route distance the cut skips (m). */
  skip: number;
  /** Route position of the entry along the node polyline (m). */
  at: number;
  score: number;
  /** The route streets' directions at the entry and the exit (unit) and the least angle (rad) each mouth may make with its street. */
  uIn: Vec2;
  uOut: Vec2;
  minMouth: number;
  /** Route edges the path may run beside (the ones it splits), and the room it keeps from every other street (m). */
  skipEdges: number[];
  clear: number;
  /** Inside corners the path keeps clear of (the junctions it cuts). */
  corners: Corner[];
  /** Unit normal to the chord on the side the path bends toward (away from the corners). */
  away: Vec2;
  /** A jump exit planned for this cut (jump cuts only). */
  jump?: JumpPlan;
}

/** A route junction the cut goes round: its node and the two route roads leaving it (unit directions, half widths to the building line). */
interface Corner {
  C: Vec2;
  u1: Vec2;
  h1: number;
  u2: Vec2;
  h2: number;
}

interface JumpPlan {
  /** The lip stands this far before the exit node along the last leg (m). */
  lipS: number;
  /** Furthest landing from the lip the run-up allows (m), and how far past the exit node the landing zone ends along the street (m). */
  landMax: number;
  zone: number;
}

/** Length of a polyline (m). */
function pathLength(path: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return l;
}

function unit(from: Vec2, to: Vec2): { x: number; z: number; len: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len, len };
}

/** Route node positions along the node polyline (m) and its length. Roundabout arcs are ignored: cuts never touch them. */
function nodeCum(g: RoadGraph, r: CarveRoute): { cum: number[]; total: number } {
  const n = r.nodes.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(g.nodes[r.nodes[i]].x - g.nodes[r.nodes[i - 1]].x, g.nodes[r.nodes[i]].z - g.nodes[r.nodes[i - 1]].z));
  const close = r.closed ? Math.hypot(g.nodes[r.nodes[0]].x - g.nodes[r.nodes[n - 1]].x, g.nodes[r.nodes[0]].z - g.nodes[r.nodes[n - 1]].z) : 0;
  return { cum, total: cum[n - 1] + close };
}

/**
 * Where a route's shortcuts may start and end (node cum, m). A sprint's finish line stands
 * sprintFinishOffset before the end, moved earlier by route.ts to keep sprintFinishNodeClear from
 * any intersection; the same rule is applied here on the node polyline with the clearance again as
 * slack, so nothing carved ends up past the finish the builder places.
 */
function routeBounds(g: RoadGraph, r: CarveRoute): { cum: number[]; total: number; lo: number; hi: number } {
  const { cum, total } = nodeCum(g, r);
  if (r.closed) return { cum, total, lo: 0, hi: total };
  let finish = total - ROUTE.sprintFinishOffset;
  for (let i = r.nodes.length - 2; i > 0; i--) if (Math.abs(finish - cum[i]) < ROUTE.sprintFinishNodeClear) finish = cum[i] - ROUTE.sprintFinishNodeClear;
  return { cum, total, lo: ROUTE.sprintStartOffset, hi: finish - ROUTE.sprintFinishNodeClear };
}

/** Signed turn (rad) at route index i; 0 at the ends of a sprint. */
function turnAt(g: RoadGraph, r: CarveRoute, i: number): number {
  const n = r.nodes.length;
  if (!r.closed && (i <= 0 || i >= n - 1)) return 0;
  const a = g.nodes[r.nodes[(i - 1 + n) % n]];
  const b = g.nodes[r.nodes[i]];
  const c = g.nodes[r.nodes[(i + 1) % n]];
  const d1x = b.x - a.x;
  const d1z = b.z - a.z;
  const d2x = c.x - b.x;
  const d2z = c.z - b.z;
  return atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
}

/**
 * The circuit's longest edge: buildRoute puts the start line and grid in its
 * middle, and splitting any other edge only shortens that one. (A sprint's
 * start and finish are guarded by position instead, see the carver.)
 */
function protectedEdges(g: RoadGraph, r: CarveRoute): number[] {
  if (!r.closed) return [];
  const n = r.nodes.length;
  const edges: number[] = [];
  for (let i = 0; i < n; i++) edges.push(edgeBetween(g, r.nodes[i], r.nodes[(i + 1) % n]));
  let li = 0;
  edges.forEach((e, i) => {
    if (g.edges[e].length > g.edges[edges[li]].length) li = i;
  });
  return [edges[li]];
}

/** Insert node m between u and v wherever a route drives the edge u-v (either way, wrapping for circuits). */
function insertSplit(routes: CarveRoute[], u: number, v: number, m: number): void {
  for (const r of routes) {
    const n = r.nodes.length;
    const pairs = r.closed ? n : n - 1;
    for (let k = 0; k < pairs; k++) {
      const a = r.nodes[k];
      const b = r.nodes[(k + 1) % n];
      if ((a === u && b === v) || (a === v && b === u)) {
        r.nodes.splice(k + 1, 0, m);
        break;
      }
    }
  }
}

/**
 * How good a cut is: the distance it saves, minus a steep penalty outside the
 * ideal length range (short alleys are over too soon, very long ones skip half
 * the scenery). U cuts get a small handicap at the call site: they swap the
 * route's corners for two square turns in a narrow alley, a corner cut flows.
 */
function cutScore(skip: number, length: number): number {
  const [lo, hi] = CITY.districts.backAlley.route.idealLength;
  return skip - length - 1.5 * Math.max(0, lo - length) - 1.5 * Math.max(0, length - hi);
}

/** Unit vector perpendicular to u, on the side of v. */
function unitPerp(u: Vec2, v: Vec2): Vec2 {
  let px = -u.z;
  let pz = u.x;
  if (px * v.x + pz * v.z < 0) {
    px = -px;
    pz = -pz;
  }
  return { x: px, z: pz };
}

/** No other street leaves node c inside the wedge between the two route roads (the inside of the turn is one block). */
function wedgeFree(g: RoadGraph, c: number, own: number[], u1: Vec2, u2: Vec2): boolean {
  const C = g.nodes[c];
  const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;
  const w = Math.sign(cross(u1, u2));
  for (const eid of C.edges) {
    if (own.includes(eid)) continue;
    const e = g.edges[eid];
    const d = unit(C, g.nodes[e.a === c ? e.b : e.a]);
    if (Math.sign(cross(u1, d)) === w && Math.sign(cross(d, u2)) === w) return false;
  }
  return true;
}

/**
 * Where a shortcut joining route positions sa and sb (m) enters and leaves in
 * driving order, and the route distance it skips; null unless it is a real
 * shortcut: it saves at least minSave of what it skips, skips at most maxSkip
 * of the lap (or of the sprint from lo to hi) and, on a sprint, stays between
 * lo and hi. Shared by the carver and by buildRoute (Route.shortcuts).
 */
export function shortcutSpan(sa: number, sb: number, length: number, total: number, closed: boolean, lo: number, hi: number): { sIn: number; sOut: number; skip: number; aFirst: boolean } | null {
  const cfg = CITY.districts.backAlley.route;
  let aFirst: boolean;
  let skip: number;
  if (closed) {
    const f = (((sb - sa) % total) + total) % total;
    aFirst = f <= total - f;
    skip = aFirst ? f : total - f;
  } else {
    aFirst = sa <= sb;
    skip = Math.abs(sb - sa);
  }
  const sIn = aFirst ? sa : sb;
  const sOut = aFirst ? sb : sa;
  if (length > skip * (1 - cfg.minSave) || skip > cfg.maxSkip * (closed ? total : hi - lo)) return null;
  if (!closed && (sIn < lo || sOut > hi)) return null;
  return { sIn, sOut, skip, aFirst };
}

/** How many shortcut chains joining two points of the route save distance (carved or adopted): the route's real shortcuts. */
export function qualifiedCount(g: RoadGraph, r: CarveRoute): number {
  const { cum, total, lo, hi } = routeBounds(g, r);
  const pos = new Map<number, number>();
  r.nodes.forEach((id, i) => pos.set(id, cum[i]));
  let count = 0;
  for (const c of routeChains(g, r.nodes)) {
    const sa = pos.get(c.nodes[0]);
    const sb = pos.get(c.nodes[c.nodes.length - 1]);
    if (sa === undefined || sb === undefined) continue;
    const span = shortcutSpan(sa, sb, c.length, total, r.closed, lo, hi);
    if (span && !chainBackwards(c, span.aFirst)) count++;
  }
  return count;
}

/**
 * Guarantee shortcuts on the routes (see the header). Runs once both routes
 * are picked and before blocks exist: it splits route edges, adds the alley
 * edge (flagged shortcut, wider than a plain back alley), registers its area
 * and inserts the split nodes into every route node list that drives a split
 * edge, so the routes stay on the same streets. Deterministic (ctx.rng).
 */
export function carveRouteShortcuts(ctx: PlanContext, routes: CarveRoute[]): void {
  if (!CITY.districts.backAlley.enabled) return;
  const cfg = CITY.districts.backAlley.route;
  const g = ctx.graph;
  const planner = shortcutPlanner(ctx, routes);
  const madeAt: number[][] = routes.map(() => []);
  // The route with the fewest spots cuts first: routes share streets, and one route's cut can take
  // the block another route's only candidate needed.
  const order = routes.map((r, ri) => ({ r, ri, n: planner.candidates(r).length })).sort((a, b) => a.n - b.n);
  for (let pass = 0; pass < cfg.perRoute; pass++) {
    order.forEach(({ r, ri }) => {
      if (qualifiedCount(g, r) > pass) return;
      const { total, lo, hi } = routeBounds(g, r);
      const pick = (jumps: boolean) =>
        planner.candidates(r, jumps).filter(
          (c) =>
            (jumps ? c.jump !== undefined : c.jump === undefined) &&
            c.skip <= cfg.maxSkip * (r.closed ? total : hi - lo) &&
            madeAt[ri].every((at) => {
              const d = Math.abs(c.at - at);
              return (r.closed ? Math.min(d, total - d) : d) >= cfg.spacing;
            }),
        );
      // A jump exit where the roll says so and its landing fits, else a plain cut.
      let list = ctx.rng.chance(cfg.jump.chance) ? pick(true) : [];
      if (!list.length) list = pick(false);
      // A route with no other spot may cut on a circuit's longest edge (the start line then moves to
      // the longest edge left, still far longer than the grid needs), then try any chord.
      if (!list.length && pass === 0) {
        planner.allowProtected(true);
        list = pick(false);
        if (!list.length) list = planner.chordCuts(r);
        planner.allowProtected(false);
      }
      if (!list.length) return;
      // Highest score first; ties keep route order (stable sort), so the pick is deterministic.
      list.sort((a, b) => b.score - a.score);
      const cut = list[0];
      if (!cut.jump) planner.bend(cut, ctx.rng);
      carve(ctx, routes, cut, ctx.rng);
      madeAt[ri].push(cut.at);
    });
  }
  // A random back alley (backAlleyModule) that happens to join two points of a route and save distance
  // is a route shortcut too: it gets the construction site treatment, so every shortcut reads the same.
  for (const r of routes) {
    const { cum, total, lo, hi } = routeBounds(g, r);
    const pos = new Map<number, number>();
    r.nodes.forEach((id, i) => pos.set(id, cum[i]));
    for (const a of ctx.areas) {
      if (a.kind !== 'backAlley' || a.variant === 'routeShortcut') continue;
      const e = g.edges[a.edges[0]];
      const sa = pos.get(e.a);
      const sb = pos.get(e.b);
      if (sa !== undefined && sb !== undefined && shortcutSpan(sa, sb, e.length, total, r.closed, lo, hi)) a.variant = 'routeShortcut';
    }
  }
  // Every back alley's area takes in its flared mouths, now that no more edges will be split.
  for (const a of ctx.areas) if (a.kind === 'backAlley') a.polygon = alleyOutline(ctx, a);
}

/**
 * A back alley's outline with both flared mouths (blocks.ts computeSectors):
 * along its building lines (round the mitred and rounded corners of every
 * bend), round each mouth's curved corners and across its opening on the
 * street's curb line, so the area takes in its funnels and the cones that
 * line them (and the HUD names the funnel the alley's). A jump exit's outline
 * runs on past its mouth along the landing side's sidewalk to the end of the
 * landing zone, for the clutter that marks the landing.
 */
function alleyOutline(ctx: PlanContext, area: Area): Vec2[] {
  const g = ctx.graph;
  const sectors = ctx.sectors();
  const edges = area.edges;
  const nodes = chainNodes(g, edges);
  const last = nodes.length - 1;
  const funnel = (nid: number, eid: number, tongue: Vec2[] = []): Vec2[] => {
    const n = g.nodes[nid];
    const m = n.edges.length;
    const k = n.edges.indexOf(eid);
    // The corner before the alley ends on its clockwise side, the one after starts on its counterclockwise side.
    const cw = sectors[nid][(k - 1 + m) % m];
    const ccw = sectors[nid][k];
    // The landing tongue (two points, curb end first) follows the forward street: the clockwise corner's
    // street or the counterclockwise one's.
    const forward = tongue.length ? n.edges[(k + 1) % m] : -1;
    const cwT = tongue.length && forward !== g.edges[tongueEdge].id ? [tongue[1], tongue[0]] : [];
    const ccwT = tongue.length && forward === g.edges[tongueEdge].id ? tongue : [];
    return [...cw.outer.slice().reverse(), ...cwT, cw.curb[0], ccw.curb[ccw.curb.length - 1], ...ccwT, ...ccw.outer.slice().reverse()];
  };
  let tongueEdge = -1;
  let tongue: Vec2[] = [];
  if (area.params.jumpExit) {
    const O = area.path[area.path.length - 2];
    const Bn = g.nodes[nodes[last]];
    const u = unit(O, Bn);
    for (const eid of Bn.edges) {
      const e = g.edges[eid];
      if (e.shortcut) continue;
      const d = unit(Bn, g.nodes[otherNode(e, Bn.id)]);
      if (d.x * u.x + d.z * u.z <= 0) continue;
      tongueEdge = eid;
      const nb = unitPerp(d, { x: O.x - Bn.x, z: O.z - Bn.z });
      const aEnd = area.params.zone + 4;
      const at = (a: number, l: number): Vec2 => ({ x: Bn.x + d.x * a + nb.x * l, z: Bn.z + d.z * a + nb.z * l });
      tongue = [at(aEnd, e.width / 2 + 0.3), at(aEnd, e.width / 2 + e.sidewalk - 0.05)];
    }
  }
  // At a bend the sector from the outgoing edge round to the incoming one is the left wall (seen along the
  // chain), the other the right wall. Their points are ordered along the chain's direction at the node (a
  // near straight bend's two points sit side by side, so the sector's own order could run either way).
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const wall = (i: number, eid: number, forward: boolean): Vec2[] => {
    const n = g.nodes[nodes[i]];
    const t = unit(g.nodes[nodes[i - 1]], g.nodes[nodes[i + 1]]);
    const along = (p: Vec2) => (p.x - n.x) * t.x + (p.z - n.z) * t.z;
    return sectors[nodes[i]][n.edges.indexOf(eid)].outer.slice().sort((a, b) => (forward ? along(a) - along(b) : along(b) - along(a)));
  };
  for (let i = 1; i < last; i++) left.push(...wall(i, edges[i], true));
  for (let i = last - 1; i >= 1; i--) right.push(...wall(i, edges[i - 1], false));
  return [...funnel(nodes[0], edges[0]), ...left, ...funnel(nodes[last], edges[edges.length - 1], tongue), ...right];
}

/** Whether a route has room for at least one shortcut, the other routes' start, grid and finish kept clear (dry run: nothing is carved). */
export function hasShortcutSpot(ctx: PlanContext, r: CarveRoute, others: CarveRoute[] = []): boolean {
  const planner = shortcutPlanner(ctx, [r, ...others]);
  // The same skip limit the carve applies, or a route can pass here and then carve nothing.
  const b = routeBounds(ctx.graph, r);
  const maxSkip = CITY.districts.backAlley.route.maxSkip * (r.closed ? b.total : b.hi - b.lo);
  const fits = () => planner.candidates(r).some((c) => c.skip <= maxSkip);
  if (fits()) return true;
  planner.allowProtected(true);
  return fits() || planner.chordCuts(r).length > 0;
}

/** Candidate cuts for the given routes (their start, grid and finish kept clear), scored by the distance they save. */
function shortcutPlanner(ctx: PlanContext, routes: CarveRoute[]) {
  const cfg = CITY.districts.backAlley.route;
  const BEND = cfg.bend;
  const JUMP = cfg.jump;
  const g = ctx.graph;
  const hwAll = cfg.width / 2 + CITY.sidewalkWidth.backAlley;
  const protect = new Set<number>();
  for (const r of routes) for (const e of protectedEdges(g, r)) protect.add(e);
  // Sprints: splits keep clear of the grid and start line, and of the finish line and its runout.
  // Positions are checked on every sprint whose edges a cut splits (routes share streets).
  const sprintGuard = (A: Vec2, B: Vec2): boolean => {
    for (const r of routes) {
      if (r.closed) continue;
      const { cum, total, hi } = routeBounds(g, r);
      for (const p of [A, B]) {
        const s = projectOnRoute(g, r, cum, p);
        if (s === null) continue;
        if (s < START_CLEAR || s > Math.min(total - FINISH_CLEAR, hi - 30)) return false;
      }
    }
    return true;
  };
  /** A jump exit's landing zone (zone m of street past the exit B) stays before every sprint's finish. */
  const landingGuard = (B: Vec2, zone: number): boolean => {
    for (const r of routes) {
      if (r.closed) continue;
      const { cum, total, hi } = routeBounds(g, r);
      const s = projectOnRoute(g, r, cum, B);
      if (s !== null && s + zone > Math.min(total - FINISH_CLEAR, hi - 30)) return false;
    }
    return true;
  };
  const [turnMin, turnMax] = cfg.turnDeg;
  // Areas a cut may not pass through. Hills are terrain, not an obstacle: a back alley climbing a
  // hill block is fine (and the hills claim two to four blocks each, which would starve routes
  // through them of cuts).
  const blocked = ctx.areas.filter((a) => a.kind !== 'subway' && a.kind !== 'downtown' && a.kind !== 'hills' && a.polygon.length >= 3);

  let allowProtected = false;
  const edgeOk = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    return (allowProtected || !protect.has(eid)) && !e.shortcut && !e.bridge && !ctx.claims.edge.has(eid) && (e.kind === 'street' || e.kind === 'avenue' || e.kind === 'boulevard' || e.kind === 'diagonal');
  };
  // The corner itself must be a plain junction (subway column nodes are fine: pillars keep off every
  // road and junction); the far ends of the cut's edges may be anything, roundabouts kept at a distance.
  const cornerOk = (id: number) => !g.nodes[id].ring && (!ctx.claims.node.has(id) || ['subway', 'hills', 'bluff'].includes(ctx.areas[ctx.claims.node.get(id)!].kind));
  /** Other streets' corridors, rivers, roundabouts and other alleys stay clear of the cut's sidewalks. */
  const chordClear = (A: Vec2, B: Vec2, skip: number[], clear: number = cfg.clear): boolean => {
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const minX = Math.min(A.x, B.x) - 45;
    const maxX = Math.max(A.x, B.x) + 45;
    const minZ = Math.min(A.z, B.z) - 45;
    const maxZ = Math.max(A.z, B.z) + 45;
    const steps = Math.max(2, Math.ceil(len / 2));
    for (const f of g.edges) {
      if (skip.includes(f.id)) continue;
      const p = g.nodes[f.a];
      const q = g.nodes[f.b];
      if (Math.max(p.x, q.x) < minX || Math.min(p.x, q.x) > maxX || Math.max(p.z, q.z) < minZ || Math.min(p.z, q.z) > maxZ) continue;
      const need = f.width / 2 + f.sidewalk + hwAll + clear;
      for (let k = 0; k <= steps; k++) {
        const x = A.x + ((B.x - A.x) * k) / steps;
        const z = A.z + ((B.z - A.z) * k) / steps;
        if (distToSegment(x, z, p.x, p.z, q.x, q.z) < need) return false;
      }
    }
    for (const a of blocked) {
      for (let k = 0; k <= steps; k++) if (pointInPolygon(A.x + ((B.x - A.x) * k) / steps, A.z + ((B.z - A.z) * k) / steps, a.polygon)) return false;
    }
    // Sites held for a car park (its block, frontage, driveway and flight).
    for (const poly of ctx.keepOut ?? []) {
      for (let k = 0; k <= steps; k++) if (pointInPolygon(A.x + ((B.x - A.x) * k) / steps, A.z + ((B.z - A.z) * k) / steps, poly)) return false;
    }
    return true;
  };
  /** chordClear along every leg of a path. */
  const pathClear = (path: Vec2[], skip: number[], clear: number = cfg.clear): boolean => {
    for (let i = 0; i + 1 < path.length; i++) if (!chordClear(path[i], path[i + 1], skip, clear)) return false;
    return true;
  };
  /** The inside sidewalk corner at C between the roads leaving along u1 and u2 stays clear of the path, on C's side of its chord. */
  const cornerClear = (c: Corner, path: Vec2[]): boolean => {
    const n1 = unitPerp(c.u1, c.u2);
    const n2 = unitPerp(c.u2, c.u1);
    const p1 = { x: c.C.x + n1.x * c.h1, z: c.C.z + n1.z * c.h1 };
    const p2 = { x: c.C.x + n2.x * c.h2, z: c.C.z + n2.z * c.h2 };
    const t = lineIntersectT(p1, c.u1, p2, c.u2);
    if (t === null) return false;
    const K = { x: p1.x + c.u1.x * t, z: p1.z + c.u1.z * t };
    const A = path[0];
    const ab = unit(A, path[path.length - 1]);
    const side = (P: Vec2) => (P.x - A.x) * ab.z - (P.z - A.z) * ab.x;
    return side(K) * side(c.C) > 0 && distToPath(path, K.x, K.z) >= hwAll + cfg.clear;
  };
  /** Legs long enough to settle on and bends no sharper than a car can take; the first and last legs meet their streets at least minIn / minOut. */
  const pathOk = (path: Vec2[], uIn: Vec2, minIn: number, uOut: Vec2, minOut: number): boolean => {
    for (let i = 0; i + 1 < path.length; i++) if (unit(path[i], path[i + 1]).len < BEND.minLeg) return false;
    for (let i = 1; i + 1 < path.length; i++) {
      const u = unit(path[i - 1], path[i]);
      const v = unit(path[i], path[i + 1]);
      if (Math.abs(Math.atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z)) > BEND.maxDeg * RAD) return false;
    }
    const n = path.length;
    return mouthAngle(unit(path[0], path[1]), uIn) >= minIn && mouthAngle(unit(path[n - 2], path[n - 1]), uOut) >= minOut;
  };
  /** Clearance an entry keeps from the route junction at the far end of its edge. */
  const endClear = (r: CarveRoute, j: number, cutTurn: number): number => {
    const ring = g.nodes[r.nodes[j]].ring;
    if (ring) return ring.outer + cfg.railClear * 0.6;
    const t = turnAt(g, r, j);
    // A junction turning the other way has its corner rail on the cut's side of the shared edge.
    return Math.abs(t) >= ROUTE_RAIL_MIN_TURN && Math.sign(t) !== Math.sign(cutTurn) ? cfg.railClear : cfg.nodeClear;
  };
  /**
   * Street past route node j (reached `base` m before it from the exit) that a landing car may roll
   * on: through free bend nodes the route barely turns at, up to the first real junction.
   */
  const runPast = (r: CarveRoute, j: number, base: number): number => {
    const n = r.nodes.length;
    let run = base;
    for (let guard = 0; guard < 4; guard++) {
      const node = g.nodes[r.nodes[j]];
      if (node.gi >= 0 || node.edges.length !== 2 || Math.abs(turnAt(g, r, j)) > 8 * RAD) break;
      const next = (j + 1) % n;
      if (!r.closed && next === 0) break;
      run += unit(node, g.nodes[r.nodes[next]]).len;
      j = next;
    }
    return run;
  };
  const mouthAngle = (ab: Vec2, u: Vec2) => Math.acos(Math.min(1, Math.abs(ab.x * u.x + ab.z * u.z)));
  /** Unit normal to the chord A-B on the far side from P. */
  const awayFrom = (A: Vec2, B: Vec2, P: Vec2): Vec2 => {
    const n = unitPerp(unit(A, B), { x: P.x - A.x, z: P.z - A.z });
    return { x: -n.x, z: -n.z };
  };

  /**
   * A jump exit's path from A to B: the last leg meets the exit street
   * (forward direction uE, half width hE to its building line) at exitDeg
   * heading down it, long enough for the lip (just inside where both alley
   * walls still stand), the ramp and a lead-in straight; one bend joins it to
   * A. Null when a leg is too short, the bend too sharp, the entry mouth too
   * oblique or the landing zone does not fit in `run` m of street past B.
   */
  const jumpPath = (A: Vec2, B: Vec2, uIn: Vec2, uE: Vec2, hE: number, run: number, minMouth: number): { path: Vec2[]; jump: JumpPlan } | null => {
    const th = JUMP.exitDeg * RAD;
    const nb = unitPerp(uE, { x: A.x - B.x, z: A.z - B.z });
    const d = { x: uE.x * Math.cos(th) - nb.x * Math.sin(th), z: uE.z * Math.cos(th) - nb.z * Math.sin(th) };
    const lipS = (hE + hwAll * Math.cos(th)) / Math.sin(th) + JUMP.lipBack;
    const L = lipS + JUMP.length + JUMP.lead;
    const P = { x: B.x - d.x * L, z: B.z - d.z * L };
    const path = [A, P, B];
    // The exit mouth is shallow by design: only the entry keeps the plain cut's minimum.
    if (!pathOk(path, uIn, minMouth, uE, th - 1 * RAD)) return null;
    const vMax = Math.sqrt(JUMP.bendSpeed * JUMP.bendSpeed + 2 * JUMP.launchAccel * (JUMP.length + JUMP.lead));
    const landMax = alleyFlightReach(vMax);
    const zone = (landMax - lipS) * Math.cos(th) + JUMP.rollout;
    if (zone + JUMP.landingClear > run || !landingGuard(B, zone)) return null;
    return { path, jump: { lipS, landMax, zone } };
  };

  const candidates = (r: CarveRoute, jumps = false): Cut[] => {
    const R = r.nodes;
    const n = R.length;
    const { cum } = nodeCum(g, r);
    const out: Cut[] = [];
    const idx = (i: number) => (i + n) % n;
    // Sprint corners need a road on both sides; U cuts need two more.
    const inner = (i: number) => r.closed || (i >= 1 && i <= n - 2);
    for (let i = 0; i < n; i++) {
      if (!inner(i)) continue;
      const turn = turnAt(g, r, i);
      const deg = Math.abs(turn) / RAD;
      if (deg < turnMin || deg > turnMax) continue;
      const P = R[idx(i - 1)];
      const C = R[i];
      const Q = R[idx(i + 1)];
      if (!cornerOk(C)) continue;
      const e1 = edgeBetween(g, P, C);
      const e2 = edgeBetween(g, C, Q);
      if (!edgeOk(e1) || !edgeOk(e2)) continue;
      const Cn = g.nodes[C];
      const uBack = unit(Cn, g.nodes[P]);
      const uOut = unit(Cn, g.nodes[Q]);
      if (!wedgeFree(g, C, [e1, e2], uBack, uOut)) continue;
      const E1 = g.edges[e1];
      const E2 = g.edges[e2];
      const clrP = endClear(r, idx(i - 1), turn);
      const clrQ = endClear(r, idx(i + 1), turn);
      const h1 = E1.width / 2 + E1.sidewalk;
      const h2 = E2.width / 2 + E2.sidewalk;
      const cornerC: Corner = { C: Cn, u1: uBack, h1, u2: uOut, h2 };

      // Corner cut across the inside block: the longest that fits.
      corner: for (const dA of cfg.cornerReach) {
        if (uBack.len - dA < clrP) continue;
        for (const dB of cfg.cornerReach) {
          if (Math.abs(dA - dB) > 10 || uOut.len - dB < clrQ) continue;
          const A = { x: Cn.x + uBack.x * dA, z: Cn.z + uBack.z * dA };
          const B = { x: Cn.x + uOut.x * dB, z: Cn.z + uOut.z * dB };
          const length = Math.hypot(B.x - A.x, B.z - A.z);
          const skip = dA + dB;
          if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
          const ab = unit(A, B);
          if (Math.min(mouthAngle(ab, uBack), mouthAngle(ab, uOut)) < 34 * RAD) continue;
          if (!sprintGuard(A, B) || !cornerClear(cornerC, [A, B]) || !chordClear(A, B, [e1, e2])) continue;
          out.push({ eA: e1, fromA: C, dA, eB: e2, fromB: C, dB, path: [A, B], length, skip, at: cum[i] - dA, score: cutScore(skip, length), uIn: uBack, uOut, minMouth: 34 * RAD, skipEdges: [e1, e2], clear: cfg.clear, corners: [cornerC], away: awayFrom(A, B, Cn) });
          break corner;
        }
      }
      // A jump exit off the outgoing street: the exit nearer the corner than a plain cut's (the landing
      // needs the street past it), the longest skip that fits first.
      if (jumps) {
        jump: for (const dB of cfg.cornerReach) {
          if (uOut.len - dB < clrQ) continue;
          const B = { x: Cn.x + uOut.x * dB, z: Cn.z + uOut.z * dB };
          const run = runPast(r, idx(i + 1), uOut.len - dB);
          for (const dA of cfg.cornerReach) {
            if (uBack.len - dA < clrP) continue;
            const A = { x: Cn.x + uBack.x * dA, z: Cn.z + uBack.z * dA };
            const skip = dA + dB;
            const jp = jumpPath(A, B, uBack, uOut, h2, run, 34 * RAD);
            if (!jp) continue;
            const length = pathLength(jp.path);
            if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
            if (!sprintGuard(A, B) || !cornerClear(cornerC, jp.path) || !pathClear(jp.path, [e1, e2])) continue;
            out.push({ eA: e1, fromA: C, dA, eB: e2, fromB: C, dB, path: jp.path, length, skip, at: cum[i] - dA, score: cutScore(skip, length), uIn: uBack, uOut, minMouth: 34 * RAD, skipEdges: [e1, e2], clear: cfg.clear, corners: [cornerC], away: awayFrom(A, B, Cn), jump: jp.jump });
            break jump;
          }
        }
      }

      // U cut: this corner and the next turn the same way around one block.
      if (!inner(idx(i + 1)) || (!r.closed && i + 2 > n - 1)) continue;
      const turn2 = turnAt(g, r, idx(i + 1));
      const deg2 = Math.abs(turn2) / RAD;
      if (deg2 < turnMin || deg2 > turnMax || Math.sign(turn2) !== Math.sign(turn)) continue;
      const Q2 = R[idx(i + 2)];
      if (!cornerOk(Q)) continue;
      const e3 = edgeBetween(g, Q, Q2);
      if (!edgeOk(e3)) continue;
      const Qn = g.nodes[Q];
      const uBack2 = unit(Qn, Cn);
      const uOut2 = unit(Qn, g.nodes[Q2]);
      if (!wedgeFree(g, Q, [e2, e3], uBack2, uOut2)) continue;
      const E3 = g.edges[e3];
      const L1 = uOut.len;
      if (L1 < 50 || L1 > 180) continue;
      const clrQ2 = endClear(r, idx(i + 2), turn);
      const h3 = E3.width / 2 + E3.sidewalk;
      const cornerQ: Corner = { C: Qn, u1: uBack2, h1: h2, u2: uOut2, h2: h3 };
      for (const d of cfg.uReach) {
        if (uBack.len - d < clrP || uOut2.len - d < clrQ2) continue;
        const A = { x: Cn.x + uBack.x * d, z: Cn.z + uBack.z * d };
        const B = { x: Qn.x + uOut2.x * d, z: Qn.z + uOut2.z * d };
        const length = Math.hypot(B.x - A.x, B.z - A.z);
        const skip = d + L1 + d;
        if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
        const ab = unit(A, B);
        if (Math.min(mouthAngle(ab, uBack), mouthAngle(ab, uOut2)) < 55 * RAD) continue;
        if (!cornerClear(cornerC, [A, B]) || !cornerClear(cornerQ, [A, B])) continue;
        if (!sprintGuard(A, B) || !chordClear(A, B, [e1, e3])) continue;
        out.push({ eA: e1, fromA: C, dA: d, eB: e3, fromB: Q, dB: d, path: [A, B], length, skip, at: cum[i] - d, score: cutScore(skip, length) - 4, uIn: uBack, uOut: uOut2, minMouth: 55 * RAD, skipEdges: [e1, e3], clear: cfg.clear, corners: [cornerC, cornerQ], away: awayFrom(A, B, Cn) });
        break;
      }
      if (jumps) {
        jumpU: for (const dB of cfg.uReach) {
          if (uOut2.len - dB < clrQ2) continue;
          const B = { x: Qn.x + uOut2.x * dB, z: Qn.z + uOut2.z * dB };
          const run = runPast(r, idx(i + 2), uOut2.len - dB);
          for (const dA of cfg.uReach) {
            if (uBack.len - dA < clrP) continue;
            const A = { x: Cn.x + uBack.x * dA, z: Cn.z + uBack.z * dA };
            const skip = dA + L1 + dB;
            const jp = jumpPath(A, B, uBack, uOut2, h3, run, 55 * RAD);
            if (!jp) continue;
            const length = pathLength(jp.path);
            if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
            if (!cornerClear(cornerC, jp.path) || !cornerClear(cornerQ, jp.path)) continue;
            if (!sprintGuard(A, B) || !pathClear(jp.path, [e1, e3])) continue;
            out.push({ eA: e1, fromA: C, dA, eB: e3, fromB: Q, dB, path: jp.path, length, skip, at: cum[i] - dA, score: cutScore(skip, length) - 4, uIn: uBack, uOut: uOut2, minMouth: 55 * RAD, skipEdges: [e1, e3], clear: cfg.clear, corners: [cornerC, cornerQ], away: awayFrom(A, B, Cn), jump: jp.jump });
            break jumpU;
          }
        }
      }
    }
    return out;
  };

  /**
   * Fallback for routes with no corner or U cut (corners on bridges or on the
   * subway's streets): a straight chord between any two splittable route
   * edges up to four apart, sampled every CHORD_STEP m, through one block.
   */
  const chordCuts = (r: CarveRoute): Cut[] => {
    const R = r.nodes;
    const n = R.length;
    const { cum, total } = nodeCum(g, r);
    const m = r.closed ? n : n - 1;
    const spots: { k: number; d: number; p: Vec2; u: { x: number; z: number; len: number }; e: number }[] = [];
    for (let k = 0; k < m; k++) {
      const e = edgeBetween(g, R[k], R[(k + 1) % n]);
      if (!edgeOk(e)) continue;
      const a = g.nodes[R[k]];
      const u = unit(a, g.nodes[R[(k + 1) % n]]);
      for (let d = cfg.nodeClear; d <= u.len - cfg.nodeClear; d += CHORD_STEP) spots.push({ k, d, p: { x: a.x + u.x * d, z: a.z + u.z * d }, u, e });
    }
    const out: Cut[] = [];
    // A mouth on the outside of a turning junction's corner rail keeps railClear from it.
    const clearOk = (k: number, d: number, len: number, side: number) => {
      const t0 = turnAt(g, r, k);
      const t1 = turnAt(g, r, (k + 1) % n);
      const need0 = g.nodes[R[k]].ring ? g.nodes[R[k]].ring!.outer + cfg.railClear * 0.6 : Math.abs(t0) >= ROUTE_RAIL_MIN_TURN && Math.sign(t0) === -side ? cfg.railClear : cfg.nodeClear;
      const need1 = g.nodes[R[(k + 1) % n]].ring ? g.nodes[R[(k + 1) % n]].ring!.outer + cfg.railClear * 0.6 : Math.abs(t1) >= ROUTE_RAIL_MIN_TURN && Math.sign(t1) === -side ? cfg.railClear : cfg.nodeClear;
      return d >= need0 && len - d >= need1;
    };
    for (const a of spots) {
      for (const b of spots) {
        let gap = b.k - a.k;
        if (r.closed) gap = (gap + n) % n;
        if (gap < 1 || gap > 4) continue;
        let skip = cum[b.k] + b.d - (cum[a.k] + a.d);
        if (r.closed && skip < 0) skip += total;
        if (skip <= 0 || skip > cfg.maxSkip * total) continue;
        const ab = unit(a.p, b.p);
        if (ab.len < cfg.minLength || ab.len > skip * (1 - cfg.minSave)) continue;
        if (Math.min(mouthAngle(ab, a.u), mouthAngle(ab, b.u)) < 34 * RAD) continue;
        // Side of each mouth seen along the route (+1 left).
        const sideA = Math.sign(a.u.x * ab.z - a.u.z * ab.x);
        const sideB = Math.sign(b.u.x * -ab.z - b.u.z * -ab.x);
        if (!clearOk(a.k, a.d, a.u.len, sideA) || !clearOk(b.k, b.d, b.u.len, sideB)) continue;
        if (!sprintGuard(a.p, b.p)) continue;
        const corners: Corner[] = [];
        if (gap === 1) {
          const C = g.nodes[R[(a.k + 1) % n]];
          const E1 = g.edges[a.e];
          const E2 = g.edges[b.e];
          corners.push({ C, u1: { x: -a.u.x, z: -a.u.z }, h1: E1.width / 2 + E1.sidewalk, u2: b.u, h2: E2.width / 2 + E2.sidewalk });
          if (!cornerClear(corners[0], [a.p, b.p])) continue;
        }
        // Tight cities (diagonals, the river) leave narrow blocks: a fallback chord may pass closer.
        if (!chordClear(a.p, b.p, [a.e, b.e], CHORD_CLEAR)) continue;
        // Bends away from the corner it cuts, or from the route node ahead of its entry.
        const far = corners.length ? corners[0].C : g.nodes[R[(a.k + 1) % n]];
        out.push({ eA: a.e, fromA: R[a.k], dA: a.d, eB: b.e, fromB: R[b.k], dB: b.d, path: [a.p, b.p], length: ab.len, skip, at: cum[a.k] + a.d, score: cutScore(skip, ab.len), uIn: a.u, uOut: b.u, minMouth: 34 * RAD, skipEdges: [a.e, b.e], clear: CHORD_CLEAR, corners, away: awayFrom(a.p, b.p, far) });
      }
    }
    return out;
  };

  /**
   * Bend a plain cut's path through its block (in place): a dogleg (one bend)
   * on short cuts, an arc (two) where three legs fit, bent away from the
   * corners it cuts, the first bend that fits in a seeded order and the
   * straight chord where none does. The bent path is checked like the chord (streets, areas,
   * corners, mouths) and must still save minSave of what it skips.
   */
  const bend = (cut: Cut, rng: Rng): void => {
    const [A, B] = cut.path;
    const ab = unit(A, B);
    // Which bend and shape to try first is the seed's call, so cuts do not all bend alike.
    const shapes: (1 | 2)[] = ab.len >= 3 * BEND.minLeg + 12 ? rng.shuffle([2, 1]) : [1];
    const degs = rng.shuffle(BEND.tryDeg.slice());
    const sides = cut.corners.length ? [cut.away] : [cut.away, { x: -cut.away.x, z: -cut.away.z }];
    for (const deg of degs) {
      for (const nodes of shapes) {
        for (const away of sides) {
          // Dogleg: the node at the chord's middle, each leg turning half the bend; arc: nodes at the thirds, the middle leg parallel.
          const t = Math.tan((deg * RAD) / (nodes === 1 ? 2 : 1));
          const o = (ab.len / (nodes === 1 ? 2 : 3)) * t;
          const at = (f: number): Vec2 => ({ x: A.x + ab.x * ab.len * f + away.x * o, z: A.z + ab.z * ab.len * f + away.z * o });
          const path = nodes === 1 ? [A, at(0.5), B] : [A, at(1 / 3), at(2 / 3), B];
          const length = pathLength(path);
          if (length > cut.skip * (1 - cfg.minSave)) continue;
          if (!pathOk(path, cut.uIn, cut.minMouth, cut.uOut, cut.minMouth)) continue;
          if (!cut.corners.every((c) => cornerClear(c, path)) || !pathClear(path, cut.skipEdges, cut.clear)) continue;
          cut.path = path;
          cut.length = length;
          return;
        }
      }
    }
  };

  return {
    candidates,
    chordCuts,
    bend,
    allowProtected(v: boolean) {
      allowProtected = v;
    },
  };
}

/**
 * Split the two route edges, join the split points with the shortcut's chain
 * (free bend nodes at the path's interior points, every edge 'backAlley'
 * flagged shortcut) and register its area.
 */
function carve(ctx: PlanContext, routes: CarveRoute[], cut: Cut, rng: Rng): void {
  const cfg = CITY.districts.backAlley.route;
  const bcfg = CITY.districts.backAlley;
  const g = ctx.graph;
  const split = (eid: number, from: number, d: number): number => {
    const e = g.edges[eid];
    const u = e.a;
    const v = e.b;
    const m = splitEdge(g, eid, u === from ? d / e.length : 1 - d / e.length);
    insertSplit(routes, u, v, m);
    return m;
  };
  const na = split(cut.eA, cut.fromA, cut.dA);
  const nb = split(cut.eB, cut.fromB, cut.dB);
  const ids = [na];
  for (let i = 1; i + 1 < cut.path.length; i++) ids.push(addNode(g, cut.path[i].x, cut.path[i].z));
  ids.push(nb);
  const edges: number[] = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const id = addEdge(g, ids[i], ids[i + 1], 'backAlley');
    g.edges[id].shortcut = true;
    g.edges[id].width = cfg.width;
    if (cut.jump && i + 2 === ids.length) g.edges[id].jumpExit = true;
    edges.push(id);
  }
  ctx.graphChanged();
  const path = ids.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
  const cum = pathCum(path);
  const length = cum[cum.length - 1];
  // A kicker hump on the longest leg with room for it, clear of both (flared) mouths and of the bends;
  // never on a jump exit's run-up.
  const half = bcfg.jumpRamp + bcfg.jumpTop / 2;
  const end = half + 15 + bcfg.mouth.alley;
  const legs = path.length - 1;
  let legI = -1;
  let room = 0;
  for (let i = 0; i < legs; i++) {
    if (cut.jump && i === legs - 1) continue;
    const r = cum[i + 1] - cum[i] - (i === 0 ? end : half + 6) - (i === legs - 1 ? end : half + 6);
    if (r > room) {
      room = r;
      legI = i;
    }
  }
  const jump = legI >= 0 && rng.chance(cfg.jumpChance) ? 1 : 0;
  const jumpS = legI >= 0 ? cum[legI] + (legI === 0 ? end : half + 6) + room * rng.pick([0.5, 0.42, 0.58]) : 0;
  const params: Record<string, number> = { length, jump, jumpS, seed: rng.int(1, 0x7ffffffe), width: cfg.width };
  if (cut.jump) {
    params.jumpExit = 1;
    params.lipS = cut.jump.lipS;
    params.landMax = cut.jump.landMax;
    params.zone = cut.jump.zone;
  }
  ctx.addArea(
    {
      kind: 'backAlley',
      variant: 'routeShortcut',
      polygon: corridor(path, cfg.width / 2 + CITY.sidewalkWidth.backAlley),
      path,
      nodes: ids,
      edges,
      faces: [],
      params,
    },
    length * (cfg.width + 2 * CITY.sidewalkWidth.backAlley),
  );
}
