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
 * edge joins two points of the route and skips a real stretch of it. Corner
 * cuts run diagonally across the inside block of a sharp turn; U cuts cross a
 * block the route wraps on three sides. Both are wider than a plain back
 * alley, kept clear of other streets and of the corner rails, and built like
 * any back alley (clutter, often a kicker).
 *
 * Raceway alleys are lined with restaurant fronts (cafe tables between
 * planter pots) and storage clutter (crates, barrels, trash bags) on their
 * sidewalks; back alleys with dumpsters, trash bags and crates against the
 * walls, and most get a kicker hump (a terrain height modifier, exact
 * gradient) that throws a fast car into the air in either direction. All
 * of it is destructible except the hump; a dumpster only goes flying when
 * hit hard.
 *
 * Content to add (render/districts/alley.ts): fire escapes, graffiti, steam
 * vents, puddles and grime on back alleys.
 */
import { CITY, ROUTE } from '../config';
import { addEdge, edgeBetween, splitEdge } from '../roadGraph';
import type { RoadGraph } from '../roadGraph';
import { Vec2, atan2, distToSegment, lineIntersectT } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { pointInPolygon } from './geom';
import type { PropKind } from '../props';
import type { AreaBuild, DistrictModule, HeightSample, PlanContext } from './types';
import { emptyBuild } from './types';
import { smooth01 } from './geom';

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
    const push = (kind: PropKind, p: { x: number; z: number; yaw: number }, jitter = 0.2) =>
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: p.yaw + rng.range(-jitter, jitter), lift: CITY.curbHeight, area: area.id });
    for (const eid of area.edges) {
      const e = g.edges[eid];
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      const walk = e.sidewalk;
      const mid = e.width / 2 + walk / 2;
      for (const side of [1, -1]) {
        let s = cfg.endClear + rng.range(0, 3);
        while (s < len - cfg.endClear - 4) {
          const block = rng.range(9, 15);
          const end = Math.min(len - cfg.endClear, s + block);
          const r = rng.next();
          if (r < 0.5) {
            // Restaurant front: pots at both ends, tables between.
            push('planterPot', sideSpot(A, B, s + 0.6, side * mid));
            for (let t = s + 2.2; t < end - 1.6; t += cfg.tableSpacing) if (rng.chance(0.85)) push('cafeTable', sideSpot(A, B, t, side * mid), 0.5);
            push('planterPot', sideSpot(A, B, end - 0.6, side * mid));
          } else if (r < 0.85) {
            // Deliveries and trash out back of the kitchens.
            for (let t = s + 0.8; t < end - 0.6; t += rng.range(1.3, 2.2)) {
              const k = rng.next();
              const kind: PropKind = k < 0.35 ? 'crate' : k < 0.6 ? 'barrel' : k < 0.85 ? 'trashBags' : 'newsBox';
              push(kind, sideSpot(A, B, t, side * (mid + rng.range(-0.2, 0.2))), 3);
            }
          }
          s = end + rng.range(2, 6);
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
      // A kicker hump in the middle or two thirds of the way along, clear of both ends.
      const jump = rng.chance(cfg.jumpChance) ? 1 : 0;
      const half = cfg.jumpRamp + cfg.jumpTop / 2;
      const jumpS = Math.max(half + 15, Math.min(length - half - 15, length * rng.pick([0.5, 0.35, 0.65])));
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
    const [A, B] = area.path;
    const len = Math.hypot(B.x - A.x, B.z - A.z) || 1;
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const P = area.params;
    const hw = (P.width ?? CITY.width.backAlley) / 2 + CITY.sidewalkWidth.backAlley;
    if (P.jump) addJump(b, A, ux, uz, len, hw, P.jumpS);
    // How far into the alley the street at each end reaches (its road, sidewalk and furniture), at the
    // angle the alley leaves it: a diagonal shortcut's mouth runs much deeper than a square one.
    // Per side of the alley (lateral sign), since the acute side of a diagonal mouth runs deepest.
    const g = ctx.graph;
    const mouthDepth = (nid: number, tx: number, tz: number, side: number) => {
      let depth = 12;
      const n = g.nodes[nid];
      for (const eid of n.edges) {
        if (area.edges.includes(eid)) continue;
        const e = g.edges[eid];
        const d = unit(n, g.nodes[e.a === nid ? e.b : e.a]);
        const sinA = Math.max(0.35, Math.abs(d.x * tz - d.z * tx));
        // Left of travel (tx, tz) is (-tz, tx): a side toward the street's direction sits closer to it.
        const toward = side * (-tz * d.x + tx * d.z) > 0 ? 1 : -1;
        const cosA = Math.abs(d.x * tx + d.z * tz);
        depth = Math.max(depth, (e.width / 2 + e.sidewalk + 2.5 + toward * hw * cosA) / sinA + 1);
      }
      return depth;
    };
    const lo = [1, -1].map((sd) => mouthDepth(area.nodes[0], ux, uz, sd));
    // Seen from B the alley runs backwards, so its left is our right.
    const hi = [1, -1].map((sd) => len - mouthDepth(area.nodes[1], -ux, -uz, -sd));
    const sLo = Math.min(lo[0], lo[1]);
    const sHi = Math.max(hi[0], hi[1]);
    // Dumpsters against the walls, alternating sides, with bags and crates around them.
    const rng = new Rng(((P.seed ?? 0) >>> 0) || 1);
    const clear = (s: number, lateral = 0) => {
      const k = lateral < 0 ? 1 : 0;
      const a = lateral === 0 ? Math.max(lo[0], lo[1]) : lo[k];
      const z = lateral === 0 ? Math.min(hi[0], hi[1]) : hi[k];
      return s >= a && s <= z && (!P.jump || Math.abs(s - P.jumpS) > cfg.jumpRamp + cfg.jumpTop / 2 + 4);
    };
    const push = (kind: PropKind, s: number, lateral: number, jitter: number) => {
      if (!clear(s, lateral)) return;
      const p = sideSpot(A, B, s, lateral);
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: p.yaw + rng.range(-jitter, jitter), lift: 0, area: area.id });
    };
    let side = rng.chance(0.5) ? 1 : -1;
    let dumpsters = 0;
    for (let s = sLo + rng.range(0, 6); s < sHi; s += cfg.dumpsterSpacing * rng.range(0.7, 1.3)) {
      if (clear(s, side)) dumpsters++;
      push('dumpster', s, side * (hw - 0.62), 0.05);
      push('trashBags', s + rng.pick([-1.9, 1.9]), side * (hw - 0.55), 3);
      if (rng.chance(0.6)) push(rng.chance(0.5) ? 'crate' : 'barrel', s + rng.range(3.2, 4.5), side * (hw - 0.6), 3);
      if (rng.chance(0.4)) push('trashBags', s + rng.range(5, 8), -side * (hw - 0.55), 3);
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
  length: number;
  /** Route distance the cut skips (m). */
  skip: number;
  /** Route position of the entry along the node polyline (m). */
  at: number;
  score: number;
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

/** How many shortcut edges already give this route a real shortcut. */
function qualifiedCount(g: RoadGraph, r: CarveRoute): number {
  const { cum, total } = nodeCum(g, r);
  const pos = new Map<number, number>();
  r.nodes.forEach((id, i) => pos.set(id, cum[i]));
  const lo = r.closed ? 0 : ROUTE.sprintStartOffset;
  const hi = r.closed ? total : total - ROUTE.sprintFinishOffset;
  let count = 0;
  for (const e of g.edges) {
    if (!e.shortcut) continue;
    const sa = pos.get(e.a);
    const sb = pos.get(e.b);
    if (sa !== undefined && sb !== undefined && shortcutSpan(sa, sb, e.length, total, r.closed, lo, hi)) count++;
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
  for (let pass = 0; pass < cfg.perRoute; pass++) {
    routes.forEach((r, ri) => {
      if (qualifiedCount(g, r) > pass) return;
      const { total } = nodeCum(g, r);
      const pick = () =>
        planner.candidates(r).filter(
          (c) =>
            c.skip <= cfg.maxSkip * total &&
            madeAt[ri].every((at) => {
              const d = Math.abs(c.at - at);
              return (r.closed ? Math.min(d, total - d) : d) >= cfg.spacing;
            }),
        );
      let list = pick();
      // A route with no other spot may cut on a circuit's longest edge (the start line then moves to
      // the longest edge left, still far longer than the grid needs), then try any chord.
      if (!list.length && pass === 0) {
        planner.allowProtected(true);
        list = pick();
        if (!list.length) list = planner.chordCuts(r);
        planner.allowProtected(false);
      }
      if (!list.length) return;
      // Highest score first; ties keep route order (stable sort), so the pick is deterministic.
      list.sort((a, b) => b.score - a.score);
      const cut = list[0];
      carve(ctx, routes, cut, ctx.rng);
      madeAt[ri].push(cut.at);
    });
  }
}

/** Whether a route has room for at least one shortcut, the other routes' start, grid and finish kept clear (dry run: nothing is carved). */
export function hasShortcutSpot(ctx: PlanContext, r: CarveRoute, others: CarveRoute[] = []): boolean {
  const planner = shortcutPlanner(ctx, [r, ...others]);
  if (planner.candidates(r).length) return true;
  planner.allowProtected(true);
  return planner.candidates(r).length > 0 || planner.chordCuts(r).length > 0;
}

/** Candidate cuts for the given routes (their start, grid and finish kept clear), scored by the distance they save. */
function shortcutPlanner(ctx: PlanContext, routes: CarveRoute[]) {
  const cfg = CITY.districts.backAlley.route;
  const g = ctx.graph;
  const hwAll = cfg.width / 2 + CITY.sidewalkWidth.backAlley;
  const protect = new Set<number>();
  for (const r of routes) for (const e of protectedEdges(g, r)) protect.add(e);
  // Sprints: splits keep clear of the grid and start line, and of the finish line and its runout.
  // Positions are checked on every sprint whose edges a cut splits (routes share streets).
  const sprintGuard = (A: Vec2, B: Vec2): boolean => {
    for (const r of routes) {
      if (r.closed) continue;
      const { cum, total } = nodeCum(g, r);
      for (const p of [A, B]) {
        const s = projectOnRoute(g, r, cum, p);
        if (s === null) continue;
        if (s < START_CLEAR || s > total - FINISH_CLEAR) return false;
      }
    }
    return true;
  };
  const [turnMin, turnMax] = cfg.turnDeg;
  const blocked = ctx.areas.filter((a) => a.kind !== 'subway' && a.kind !== 'downtown' && a.polygon.length >= 3);

  let allowProtected = false;
  const edgeOk = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    return (allowProtected || !protect.has(eid)) && !e.shortcut && !e.bridge && !ctx.claims.edge.has(eid) && (e.kind === 'street' || e.kind === 'avenue' || e.kind === 'boulevard' || e.kind === 'diagonal');
  };
  // The corner itself must be a plain junction (subway column nodes are fine: pillars keep off every
  // road and junction); the far ends of the cut's edges may be anything, roundabouts kept at a distance.
  const cornerOk = (id: number) => !g.nodes[id].ring && (!ctx.claims.node.has(id) || ctx.areas[ctx.claims.node.get(id)!].kind === 'subway');
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
    return true;
  };
  /** The inside sidewalk corner at C between the roads leaving along u1 and u2 stays clear of the cut, on C's side of it. */
  const cornerClear = (C: Vec2, u1: Vec2, h1: number, u2: Vec2, h2: number, A: Vec2, B: Vec2): boolean => {
    const n1 = unitPerp(u1, u2);
    const n2 = unitPerp(u2, u1);
    const p1 = { x: C.x + n1.x * h1, z: C.z + n1.z * h1 };
    const p2 = { x: C.x + n2.x * h2, z: C.z + n2.z * h2 };
    const t = lineIntersectT(p1, u1, p2, u2);
    if (t === null) return false;
    const K = { x: p1.x + u1.x * t, z: p1.z + u1.z * t };
    const ab = unit(A, B);
    const side = (P: Vec2) => (P.x - A.x) * ab.z - (P.z - A.z) * ab.x;
    const sK = side(K);
    return sK * side(C) > 0 && Math.abs(sK) >= hwAll + cfg.clear;
  };
  /** Clearance an entry keeps from the route junction at the far end of its edge. */
  const endClear = (r: CarveRoute, j: number, cutTurn: number): number => {
    const ring = g.nodes[r.nodes[j]].ring;
    if (ring) return ring.outer + cfg.railClear * 0.6;
    const t = turnAt(g, r, j);
    // A junction turning the other way has its corner rail on the cut's side of the shared edge.
    return Math.abs(t) >= ROUTE_RAIL_MIN_TURN && Math.sign(t) !== Math.sign(cutTurn) ? cfg.railClear : cfg.nodeClear;
  };
  const mouthAngle = (ab: Vec2, u: Vec2) => Math.acos(Math.min(1, Math.abs(ab.x * u.x + ab.z * u.z)));

  const candidates = (r: CarveRoute): Cut[] => {
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
          if (!sprintGuard(A, B) || !cornerClear(Cn, uBack, h1, uOut, h2, A, B) || !chordClear(A, B, [e1, e2])) continue;
          out.push({ eA: e1, fromA: C, dA, eB: e2, fromB: C, dB, length, skip, at: cum[i] - dA, score: skip - length });
          break corner;
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
      for (const d of cfg.uReach) {
        if (uBack.len - d < clrP || uOut2.len - d < clrQ2) continue;
        const A = { x: Cn.x + uBack.x * d, z: Cn.z + uBack.z * d };
        const B = { x: Qn.x + uOut2.x * d, z: Qn.z + uOut2.z * d };
        const length = Math.hypot(B.x - A.x, B.z - A.z);
        const skip = d + L1 + d;
        if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
        const ab = unit(A, B);
        if (Math.min(mouthAngle(ab, uBack), mouthAngle(ab, uOut2)) < 55 * RAD) continue;
        if (!cornerClear(Cn, uBack, h1, uOut, h2, A, B) || !cornerClear(Qn, uBack2, h2, uOut2, E3.width / 2 + E3.sidewalk, A, B)) continue;
        if (!sprintGuard(A, B) || !chordClear(A, B, [e1, e3])) continue;
        out.push({ eA: e1, fromA: C, dA: d, eB: e3, fromB: Q, dB: d, length, skip, at: cum[i] - d, score: (skip - length) * 0.8 });
        break;
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
        if (gap === 1) {
          const C = g.nodes[R[(a.k + 1) % n]];
          const E1 = g.edges[a.e];
          const E2 = g.edges[b.e];
          if (!cornerClear(C, { x: -a.u.x, z: -a.u.z }, E1.width / 2 + E1.sidewalk, b.u, E2.width / 2 + E2.sidewalk, a.p, b.p)) continue;
        }
        // Tight cities (diagonals, the river) leave narrow blocks: a fallback chord may pass closer.
        if (!chordClear(a.p, b.p, [a.e, b.e], CHORD_CLEAR)) continue;
        out.push({ eA: a.e, fromA: R[a.k], dA: a.d, eB: b.e, fromB: R[b.k], dB: b.d, length: ab.len, skip, at: cum[a.k] + a.d, score: skip - ab.len });
      }
    }
    return out;
  };

  return {
    candidates,
    chordCuts,
    allowProtected(v: boolean) {
      allowProtected = v;
    },
  };
}

/** Split the two route edges, join the split points with the shortcut and register its area. */
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
  const id = addEdge(g, na, nb, 'backAlley');
  const edge = g.edges[id];
  edge.shortcut = true;
  edge.width = cfg.width;
  ctx.graphChanged();
  const A = { x: g.nodes[na].x, z: g.nodes[na].z };
  const B = { x: g.nodes[nb].x, z: g.nodes[nb].z };
  const length = edge.length;
  const half = bcfg.jumpRamp + bcfg.jumpTop / 2;
  const jump = length > 2 * (half + 15) && rng.chance(cfg.jumpChance) ? 1 : 0;
  const jumpS = Math.max(half + 15, Math.min(length - half - 15, length * rng.pick([0.5, 0.42, 0.58])));
  ctx.addArea(
    {
      kind: 'backAlley',
      variant: 'routeShortcut',
      polygon: corridor([A, B], cfg.width / 2 + CITY.sidewalkWidth.backAlley),
      path: [A, B],
      nodes: [na, nb],
      edges: [id],
      faces: [],
      params: { length, jump, jumpS, seed: rng.int(1, 0x7ffffffe), width: cfg.width },
    },
    length * (cfg.width + 2 * CITY.sidewalkWidth.backAlley),
  );
}
