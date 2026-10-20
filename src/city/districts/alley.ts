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
 * joined by a 'backAlley' edge flagged `shortcut: true`. Routes never use
 * shortcut edges and never barrier them off, so racers can take them; the
 * race progress logic keeps big shortcuts from paying off (see race.ts).
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
import { CITY } from '../config';
import { addEdge, edgeBetween, splitEdge } from '../roadGraph';
import type { RoadGraph } from '../roadGraph';
import { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { PropKind } from '../props';
import type { AreaBuild, DistrictModule, HeightSample } from './types';
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
  build(_ctx, area) {
    const b = emptyBuild();
    const cfg = CITY.districts.backAlley;
    const [A, B] = area.path;
    const len = Math.hypot(B.x - A.x, B.z - A.z) || 1;
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const hw = CITY.width.backAlley / 2 + CITY.sidewalkWidth.backAlley;
    const P = area.params;
    if (P.jump) addJump(b, A, ux, uz, len, hw, P.jumpS);
    // Dumpsters against the walls, alternating sides, with bags and crates around them.
    const rng = new Rng(((P.seed ?? 0) >>> 0) || 1);
    const clear = (s: number) => !P.jump || Math.abs(s - P.jumpS) > cfg.jumpRamp + cfg.jumpTop / 2 + 4;
    const push = (kind: PropKind, s: number, lateral: number, jitter: number) => {
      if (!clear(s)) return;
      const p = sideSpot(A, B, s, lateral);
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: p.yaw + rng.range(-jitter, jitter), lift: 0, area: area.id });
    };
    let side = rng.chance(0.5) ? 1 : -1;
    for (let s = 12 + rng.range(0, 6); s < len - 12; s += cfg.dumpsterSpacing * rng.range(0.7, 1.3)) {
      push('dumpster', s, side * (hw - 0.62), 0.05);
      push('trashBags', s + rng.pick([-1.9, 1.9]), side * (hw - 0.55), 3);
      if (rng.chance(0.6)) push(rng.chance(0.5) ? 'crate' : 'barrel', s + rng.range(3.2, 4.5), side * (hw - 0.6), 3);
      if (rng.chance(0.4)) push('trashBags', s + rng.range(5, 8), -side * (hw - 0.55), 3);
      side = -side;
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
