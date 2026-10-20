/**
 * Monument: one plaza block near the center of the city with a tall
 * floodlit landmark, visible from across town. The block's frontage is
 * opened like a park's (no walls: racers cut straight across the plaza),
 * its surface is concrete at sidewalk level, buildings are kept out, and
 * the landmark stands on a solid base ringed by steps. The outer step edge
 * is the collision (walls with look 'monument', drawn by
 * render/districts/monument.ts); for the triumphal arch the two piers are
 * the collision and the opening between them is wide enough to drive
 * through. Planter pots ring the steps, benches face the landmark and
 * lantern posts line the plaza edge, all destructible. Three kinds, one per
 * seed: an obelisk, a statue column or a
 * triumphal arch opening along the plaza's longest street side.
 */
import { CITY } from '../config';
import { Vec2, atan2, cos, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polyWalls, polygonCentroid } from './geom';
import { convexRing } from './park';
import { riverCenter } from './river';

const CFG = CITY.districts.monument;
const KINDS = ['obelisk', 'column', 'arch'] as const;

/** Rectangle centred on c: `len` along u, `wide` across. */
function centredRect(c: Vec2, u: Vec2, len: number, wide: number): Vec2[] {
  const v = { x: -u.z, z: u.x };
  const hl = len / 2;
  const hw = wide / 2;
  return [
    { x: c.x - u.x * hl - v.x * hw, z: c.z - u.z * hl - v.z * hw },
    { x: c.x + u.x * hl - v.x * hw, z: c.z + u.z * hl - v.z * hw },
    { x: c.x + u.x * hl + v.x * hw, z: c.z + u.z * hl + v.z * hw },
    { x: c.x - u.x * hl + v.x * hw, z: c.z - u.z * hl + v.z * hw },
  ];
}

export const monumentModule: DistrictModule = {
  kind: 'monument',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const g = ctx.graph;
    const cx0 = (g.bounds.minX + g.bounds.maxX) / 2;
    const cz0 = (g.bounds.minZ + g.bounds.maxZ) / 2;
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const faces = ctx
      .faces()
      .filter((f) => {
        if (f.outer || f.area < CFG.minArea || f.area > CFG.maxArea || ctx.claims.face.has(f.id)) return false;
        if (f.edges.some((e) => g.edges[e].shortcut || g.edges[e].bridge || ctx.claims.edge.has(e))) return false;
        if (f.corners.some((c) => g.nodes[c.node].ring)) return false;
        if (!convexRing(f.ring)) return false;
        const c = polygonCentroid(f.ring);
        if (sqrt((c.x - cx0) ** 2 + (c.z - cz0) ** 2) > CFG.reach) return false;
        for (const r of rivers) if (f.ring.some((p) => Math.abs(p.z - riverCenter(r.params, p.x)) < r.params.top + CITY.districts.river.clearance + 4)) return false;
        return true;
      })
      .map((f) => ({ f, d: (() => {
        const c = polygonCentroid(f.ring);
        return sqrt((c.x - cx0) ** 2 + (c.z - cz0) ** 2);
      })() }))
      .sort((p, q) => p.d - q.d || p.f.id - q.f.id);
    if (!faces.length) return;
    // One of the three blocks nearest the center: the landmark anchors downtown without always taking the same block.
    const f = faces[rng.int(0, Math.min(2, faces.length - 1))].f;
    if (ctx.budget.used + f.area > ctx.budget.total) return;
    const c = polygonCentroid(f.ring);
    // The plaza's axis runs along its longest street side (an arch opens along it).
    let best = 0;
    let u: Vec2 = { x: 1, z: 0 };
    for (let i = 0; i < f.ring.length; i++) {
      if (f.segEdge[i] < 0) continue;
      const p = f.ring[i];
      const q = f.ring[(i + 1) % f.ring.length];
      const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      if (l > best) {
        best = l;
        u = { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
      }
    }
    const kind = KINDS[rng.int(0, KINDS.length - 1)];
    ctx.addArea(
      {
        kind: 'monument',
        variant: kind,
        polygon: f.ring,
        path: [],
        nodes: [],
        edges: [],
        faces: [f.id],
        params: { cx: c.x, cz: c.z, ux: u.x, uz: u.z, yaw: atan2(u.x, u.z), area: f.area, height: CFG[kind], flags: rng.int(4, 8), seed: rng.int(1, 0x7ffffffe) },
      },
      f.area,
    );
  },

  build(_ctx, area) {
    const b = emptyBuild();
    const ring = area.polygon;
    const id = area.id;
    const P = area.params;
    const c = { x: P.cx, z: P.cz };
    const u = { x: P.ux, z: P.uz };
    b.exclusions.push(ring);
    b.openings.push(ring);
    b.surfaces.push({ surface: 'concrete', polygon: ring, priority: 2, area: id });
    const lift = CITY.curbHeight;
    let clearR: number;
    if (area.variant === 'arch') {
      // Two piers either side of the axis; the gap between their inner faces is the drive through.
      const v = { x: -u.z, z: u.x };
      const off = CFG.archGap / 2 + CFG.pierWidth / 2;
      for (const sgn of [-1, 1]) {
        const pc = { x: c.x + v.x * off * sgn, z: c.z + v.z * off * sgn };
        const poly = centredRect(pc, u, CFG.pierDepth, CFG.pierWidth);
        b.walls.push(...polyWalls(poly, false, 'monument', id));
        b.hints.push({ kind: 'pier', points: poly, values: [sgn] });
      }
      clearR = off + CFG.pierWidth / 2;
      b.props.push({ kind: 'arch', x: c.x, z: c.z, yaw: P.yaw, size: clearR, height: P.height, area: id });
    } else {
      const Rs = CFG.base + CFG.steps;
      const steps = circlePolygon(c.x, c.z, Rs, 20, P.yaw);
      b.walls.push(...polyWalls(steps, false, 'monument', id));
      b.props.push({ kind: area.variant, x: c.x, z: c.z, yaw: P.yaw, size: CFG.base, height: P.height, area: id });
      b.hints.push({ kind: 'steps', points: steps, values: [CFG.base, CFG.steps] });
      clearR = Rs;
    }
    b.reserved.push({ x: c.x, z: c.z, r: clearR + 1 });
    // Pavement lights in a ring around the landmark (render only).
    const lamps: Vec2[] = [];
    for (let i = 0; i < 12; i++) {
      const ang = P.yaw + (i / 12) * Math.PI * 2;
      lamps.push({ x: c.x + sin(ang) * (clearR + 3), z: c.z + cos(ang) * (clearR + 3) });
    }
    b.hints.push({ kind: 'lamps', points: lamps, values: [] });
    // Destructibles: planter pots ringing the steps (not across the arch's opening), benches facing the landmark with a bin each, news boxes by the plaza edge.
    const rng = new Rng(P.seed);
    const inside = (p: Vec2, margin: number) => pointInPolygon(p.x, p.z, ring) && distToPolygonEdge(p.x, p.z, ring) > margin;
    const potR = clearR + CFG.potRing;
    const pots = Math.round((2 * Math.PI * potR) / 3.4);
    for (let i = 0; i < pots; i++) {
      const ang = P.yaw + (i / pots) * Math.PI * 2;
      if (area.variant === 'arch' && Math.abs(sin(ang - P.yaw)) < 0.38) continue;
      const p = { x: c.x + sin(ang) * potR, z: c.z + cos(ang) * potR };
      if (inside(p, 2)) b.destructibles.push({ kind: 'planterPot', x: p.x, z: p.z, yaw: ang, lift, area: id });
    }
    const benches = rng.int(4, 6);
    for (let i = 0; i < benches; i++) {
      const ang = P.yaw + ((i + 0.5) / benches) * Math.PI * 2 + rng.range(-0.15, 0.15);
      if (area.variant === 'arch' && Math.abs(sin(ang - P.yaw)) < 0.45) continue;
      const r = clearR + CFG.benchRing;
      const p = { x: c.x + sin(ang) * r, z: c.z + cos(ang) * r };
      if (!inside(p, 3)) continue;
      // Facing the landmark: local +Z toward it.
      const yaw = atan2(c.x - p.x, c.z - p.z);
      b.destructibles.push({ kind: 'bench', x: p.x, z: p.z, yaw, lift, area: id });
      const q = { x: p.x + cos(yaw) * 1.6, z: p.z - sin(yaw) * 1.6 };
      if (inside(q, 3)) b.destructibles.push({ kind: 'garbageCan', x: q.x, z: q.z, yaw, lift, area: id });
    }
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      // A little inside the plaza edge, away from the street.
      const inward = { x: c.x - m.x, z: c.z - m.z };
      const l = sqrt(inward.x * inward.x + inward.z * inward.z) || 1;
      const s = { x: m.x + (inward.x / l) * 3, z: m.z + (inward.z / l) * 3 };
      if (rng.chance(0.6) && inside(s, 2)) b.destructibles.push({ kind: rng.chance(0.5) ? 'newsBox' : 'garbageCan', x: s.x, z: s.z, yaw: atan2(-inward.x, -inward.z), lift, area: id });
    }
    // Lantern posts just inside the plaza edge, an even count per side so none lands on the
    // midpoint where a news box may stand.
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      if (len < CFG.lampSpacing) continue;
      const ux = (q.x - p.x) / len;
      const uz = (q.z - p.z) / len;
      // Inward normal: the side of the edge the landmark is on.
      const sgn = (c.x - p.x) * uz - (c.z - p.z) * ux > 0 ? 1 : -1;
      let n = Math.max(2, Math.round(len / CFG.lampSpacing));
      if (n % 2) n++;
      for (let k = 0; k < n; k++) {
        const s = ((k + 0.5) / n) * len;
        const l = { x: p.x + ux * s + uz * sgn * CFG.lampInset, z: p.z + uz * s - ux * sgn * CFG.lampInset };
        if (inside(l, 1.5)) b.destructibles.push({ kind: 'parkLamp', x: l.x, z: l.z, yaw: atan2(c.x - l.x, c.z - l.z), lift, area: id });
      }
    }
    return b;
  },
};
