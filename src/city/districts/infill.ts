/**
 * Infill: fills the voids of the street frontage (stretches of sidewalk line
 * with no building behind them) with low, mostly drivable space full of
 * destructible clutter, so collision always matches what is visibly there
 * and racers who cut a corner crash through cafe tables, bushes and crates
 * instead of hitting an invisible wall or a solid box.
 *
 * Runs in the 'late' phase, after buildings are placed, on the void runs
 * blocks.ts finds along every block ring. Heuristics, per run:
 *  - Convex block corners (the inside of every turn through that junction)
 *    become corner pockets: drivable concrete reaching along both streets.
 *    Most corners have a building a few meters along one street, so the
 *    pocket may be shallow on that side (CFG.cornerMinSide) as long as it
 *    wraps the corner. The sharper the corner, the likelier.
 *  - Long straight voids (large footprint gaps) become parking lots
 *    (drivable asphalt with painted bays), shorter ones small plazas, and
 *    shallow ones verges (a drivable strip of pots and bushes).
 *  - A share (CFG.solidChance) stays solid on purpose: raised planters and
 *    the odd fountain on a roomy corner of a busy junction, so the clutter
 *    has something hard among it. Voids where nothing drivable fits also
 *    become raised planters.
 *  - Drivable infill stays CITY.districts.infill.gap m from any other
 *    drivable space and out of buildings and exclusions, and is walled on
 *    its back sides with low curbs (look 'lotEdge').
 *  - Every drivable pocket is furnished by theme (cafe, garden, market, lot
 *    clutter) with destructible props (AreaBuild.destructibles).
 * Whatever is left is a low 'boundary' wall drawn by render/districts/infill.ts.
 */
import { CITY } from '../config';
import { Vec2, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { Wall } from '../blocks';
import type { DistrictPropKind } from '../props';
import { PROP_DEFS } from '../props';
import type { Area, AreaBuild, DistrictModule } from './types';
import { emptyBuild } from './types';
import { PolygonIndex, circlePolygon, distToPolygonEdge, pointInPolygon, polyWalls, polygonBounds, rectPolygon } from './geom';

const CFG = CITY.districts.infill;

/** Pocket themes: which clutter a drivable pocket gets (Area.params.theme indexes this). */
export const INFILL_THEMES = ['cafe', 'garden', 'market', 'lot'] as const;
export type InfillTheme = (typeof INFILL_THEMES)[number];

/**
 * Clutter per theme: grid spacing (m), share of grid spots that get a prop,
 * and the kinds with their weights. Shallow pockets (one row) are bushes and
 * pots. Lots stay mostly open: they are runoff, not a maze.
 */
const FURNISH: Record<InfillTheme, { spacing: number; fill: number; kinds: [DistrictPropKind, number][] }> = {
  cafe: { spacing: 2.8, fill: 0.75, kinds: [['cafeTable', 6], ['planterPot', 2], ['newsBox', 1]] },
  garden: { spacing: 2.3, fill: 0.7, kinds: [['bush', 6], ['planterPot', 3]] },
  market: { spacing: 2.2, fill: 0.6, kinds: [['crate', 4], ['barrel', 3], ['planterPot', 1], ['newsBox', 1]] },
  lot: { spacing: 4.5, fill: 0.3, kinds: [['barrel', 5], ['crate', 2], ['trashBags', 2]] },
};
/** At most this many props per pocket (big lots stay cheap). */
const MAX_PROPS = 36;
/** Props keep this far from the pocket's sides beyond their radius (m). */
const EDGE_CLEAR = 0.35;
/** Pockets shallower than this (m) get a single row of greenery. */
const SHALLOW = 4.6;

function distToPolyline(x: number, z: number, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-12 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = sqrt((x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2);
    if (d < best) best = d;
  }
  return best;
}

/** Local frame of a pocket for furnishing: origin, along axis u (length lu), depth axis w (length lw). Parallelograms included. */
function frameParams(o: Vec2, u: Vec2, w: Vec2, lu: number, lw: number): Record<string, number> {
  return { ox: o.x, oz: o.z, ux: u.x, uz: u.z, wx: w.x, wz: w.z, lu, lw };
}

export const infillModule: DistrictModule = {
  kind: 'infill',
  phase: 'late',
  plan(ctx) {
    const L = ctx.late;
    if (!CFG.enabled || !L) return;
    const rng = ctx.rng;
    const g = ctx.graph;
    const pad = 220;
    const placed = new PolygonIndex<{ polygon: Vec2[] }>(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad);

    /** Can this polygon be built? Drivable ones also keep clear of other drivable space. */
    const valid = (poly: Vec2[], front: Vec2[], drivable: boolean): boolean => {
      const bb = polygonBounds(poly);
      const step = 1.5;
      const pts: Vec2[] = [];
      for (let x = bb.minX + 0.3; x <= bb.maxX; x += step) for (let z = bb.minZ + 0.3; z <= bb.maxZ; z += step) if (pointInPolygon(x, z, poly)) pts.push({ x, z });
      // Corners, pulled slightly inside.
      const c = { x: (bb.minX + bb.maxX) / 2, z: (bb.minZ + bb.maxZ) / 2 };
      for (const p of poly) pts.push({ x: p.x + (c.x - p.x) * 0.02, z: p.z + (c.z - p.z) * 0.02 });
      for (const p of pts) {
        if (L.insideBuilding(p.x, p.z, 0.4) || L.excluded(p.x, p.z)) return false;
        if (!drivable) continue;
        const dF = distToPolyline(p.x, p.z, front);
        if (L.clearance(p.x, p.z) < Math.min(dF, CFG.gap) - 0.3) return false;
        if (placed.near(p.x, p.z, CFG.gap)) return false;
      }
      return true;
    };

    const add = (variant: string, polygon: Vec2[], frontSides: number, face: number, node: number, extra: Record<string, number>) => {
      // Only drivable pockets need the tunnelling gap; a solid planter may sit right beside one.
      if (variant !== 'planter') placed.add({ polygon });
      const params = { frontSides, seed: rng.int(1, 0x7ffffffe), ...extra };
      ctx.addArea({ kind: 'infill', variant, polygon, path: [], nodes: node >= 0 ? [node] : [], edges: [], faces: [face], params });
    };
    const theme = (weights: [InfillTheme, number][]): number => {
      let total = 0;
      for (const [, w] of weights) total += w;
      let r = rng.next() * total;
      for (const [t, w] of weights) {
        r -= w;
        if (r <= 0) return INFILL_THEMES.indexOf(t);
      }
      return INFILL_THEMES.indexOf(weights[weights.length - 1][0]);
    };

    for (const run of L.voids) {
      if (run.length < CFG.minRun) continue;
      const pts = run.points;
      const pos = [0];
      for (let i = 1; i < pts.length; i++) pos.push(pos[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const used: [number, number][] = [];

      // 1. Corner pockets.
      for (const c of run.corners) {
        if (c.angle > 160 * (Math.PI / 180)) continue;
        const i = c.index;
        if (i < 1 || i + 1 >= pts.length) continue;
        const C = pts[i];
        const len1 = pos[i] - pos[i - 1];
        const len2 = pos[i + 1] - pos[i];
        // Room along both streets, short of the buildings that end the void.
        const room1 = Math.min(CFG.cornerReach, len1 - CFG.cornerMargin);
        const room2 = Math.min(CFG.cornerReach, len2 - CFG.cornerMargin);
        if (Math.min(room1, room2) < CFG.cornerMinSide || Math.max(room1, room2) < CFG.minRun) continue;
        const deg = (c.angle * 180) / Math.PI;
        const chance = deg < 80 ? 0.97 : deg < 110 ? 0.92 : 0.85;
        if (!rng.chance(chance)) continue;
        const u1 = { x: (pts[i - 1].x - C.x) / len1, z: (pts[i - 1].z - C.z) / len1 };
        const u2 = { x: (pts[i + 1].x - C.x) / len2, z: (pts[i + 1].z - C.z) / len2 };
        const solid = rng.chance(CFG.solidChance);
        // Candidate reaches along each street, largest pocket first; a corner keeps wrapping the
        // corner even when one side has to stay shallow to clear a building.
        const reaches = (room: number) => [1, 0.78, 0.6, 0.45, 0.3].map((k) => Math.max(CFG.cornerMinSide, room * k)).filter((v, j, all) => j === 0 || v < all[j - 1] - 0.2);
        const pairs: [number, number][] = [];
        for (const a of reaches(room1)) for (const b of reaches(room2)) if (Math.max(a, b) >= CFG.minRun - 1e-9) pairs.push([a, b]);
        pairs.sort((p, q) => q[0] * q[1] - p[0] * p[1] || q[0] - p[0]);
        for (const [L1, L2] of pairs.slice(0, 12)) {
          const a = { x: C.x + u1.x * L1, z: C.z + u1.z * L1 };
          const b = { x: C.x + u2.x * L2, z: C.z + u2.z * L2 };
          const poly = [a, { x: C.x, z: C.z }, b, { x: a.x + u2.x * L2, z: a.z + u2.z * L2 }];
          if (valid(poly, [a, C, b], !solid)) {
            used.push([pos[i] - L1, pos[i] + L2]);
            if (solid) {
              add('planter', poly, 2, run.face, c.node, { depth: Math.min(L1, L2), length: Math.max(L1, L2) });
              break;
            }
            const busy = c.node >= 0 && g.nodes[c.node].edges.length >= 4;
            const fountain = Math.min(L1, L2) >= 10 && rng.chance(CFG.fountainChance + (busy ? 0.15 : 0));
            const fr = Math.min(3, Math.max(1.6, Math.min(L1, L2) * 0.16));
            const cx = (poly[0].x + poly[1].x + poly[2].x + poly[3].x) / 4;
            const cz = (poly[0].z + poly[1].z + poly[2].z + poly[3].z) / 4;
            // Shallow corners are a strip of greenery; roomy ones a cafe terrace, a garden or a market corner.
            const t = Math.min(L1, L2) < SHALLOW ? theme([['garden', 3], ['market', 1]]) : theme([['cafe', 3], ['garden', 2], ['market', 2]]);
            // Frame: along street 1 (u1) and into the block along street 2 (u2), so a shallow side is the depth.
            const frame = L2 <= L1 ? frameParams(C, u1, u2, L1, L2) : frameParams(C, u2, u1, L2, L1);
            add('cornerPlaza', poly, 2, run.face, c.node, { angle: c.angle, reach1: L1, reach2: L2, fountain: fountain ? fr : 0, fx: cx, fz: cz, theme: t, ...frame });
            break;
          }
        }
      }

      // 2. Straight stretches between used corners.
      for (let k = 0; k + 1 < pts.length; k++) {
        let pieces: [number, number][] = [[pos[k], pos[k + 1]]];
        for (const [u0, u1] of used) {
          const next: [number, number][] = [];
          for (const [a, b] of pieces) {
            if (u1 <= a || u0 >= b) next.push([a, b]);
            else {
              if (u0 > a) next.push([a, u0]);
              if (u1 < b) next.push([u1, b]);
            }
          }
          pieces = next;
        }
        const segLen = pos[k + 1] - pos[k];
        if (segLen < 1e-6) continue;
        const u = { x: (pts[k + 1].x - pts[k].x) / segLen, z: (pts[k + 1].z - pts[k].z) / segLen };
        // Into the block: right of travel.
        const w = { x: u.z, z: -u.x };
        const at = (s: number) => ({ x: pts[k].x + u.x * (s - pos[k]), z: pts[k].z + u.z * (s - pos[k]) });
        for (const [s0, s1] of pieces) {
          if (s1 - s0 < CFG.minRun) continue;
          const r = rng.next();
          const solid = rng.chance(CFG.solidChance);
          const kind = solid ? 'planter' : s1 - s0 >= CFG.lotMinLen && r < CFG.lotChance ? 'lot' : r < CFG.lotChance + CFG.plazaChance ? 'plaza' : 'verge';
          /** Try insets [start, end] (m off each end of the piece) and depths in order; first valid wins. */
          const tryRect = (variant: 'lot' | 'plaza' | 'verge', insets: [number, number][], depths: number[]): boolean => {
            for (const [i0, i1] of insets) {
              const a = s0 + i0;
              const len = s1 - s0 - i0 - i1;
              if (len < CFG.minRun) continue;
              for (const D of depths) {
                const o = at(a);
                const poly = rectPolygon(o, u, w, len, D);
                if (!valid(poly, [poly[0], poly[1]], true)) continue;
                const fountain = variant === 'plaza' && Math.min(len, D) >= 10 && rng.chance(CFG.fountainChance);
                const fr = Math.min(3, Math.max(1.6, Math.min(len, D) * 0.16));
                const t = variant === 'lot' ? INFILL_THEMES.indexOf('lot') : variant === 'verge' ? INFILL_THEMES.indexOf('garden') : theme([['cafe', 2], ['garden', 2], ['market', 1]]);
                add(variant, poly, 1, run.face, -1, { depth: D, length: len, fountain: fountain ? fr : 0, fx: o.x + u.x * len * 0.5 + w.x * D * 0.5, fz: o.z + u.z * len * 0.5 + w.z * D * 0.5, theme: t, ...frameParams(o, u, w, len, D) });
                return true;
              }
            }
            return false;
          };
          let done = false;
          if (kind === 'lot' || kind === 'plaza') {
            const maxD = kind === 'lot' ? CFG.lotDepth : CFG.plazaDepth;
            const depths: number[] = [];
            for (let D = maxD; D >= 5; D -= 3) depths.push(D);
            done = tryRect(kind, [[1, 1], [4, 4], [8, 8]], depths);
          }
          // A shallow drivable strip where nothing deeper fits.
          // Trimming one end clears a junction mouth or an alley entrance next to the piece.
          if (!done && kind !== 'planter') {
            const vd = [CFG.vergeDepth[0], (CFG.vergeDepth[0] + CFG.vergeDepth[1]) / 2, CFG.vergeDepth[1]];
            done = tryRect('verge', [[0.5, 0.5], [0.5, 2.5], [2.5, 0.5], [2.5, 2.5], [0.5, 4.5], [4.5, 0.5], [4.5, 4.5]], vd);
          }
          if (!done) {
            const len = s1 - s0 - 0.4;
            const poly = rectPolygon(at(s0 + 0.2), u, w, len, CFG.planterDepth);
            if (valid(poly, [], false)) add('planter', poly, 1, run.face, -1, { depth: CFG.planterDepth, length: len });
          }
        }
      }
    }
  },

  build(_ctx, area: Area) {
    const b = emptyBuild();
    const poly = area.polygon;
    const id = area.id;
    if (area.variant === 'planter') {
      b.frontLooks.push({ polygon: poly, look: 'planter', area: id });
      return b;
    }
    b.openings.push(poly);
    b.surfaces.push({ surface: area.variant === 'lot' ? 'road' : 'concrete', polygon: poly, priority: 2, area: id });
    // Low curbs on the back sides (the first frontSides sides are the open frontage).
    const fs = area.params.frontSides;
    const sides: Wall[] = [];
    for (let i = fs; i < poly.length; i++) {
      const seg = [poly[i], poly[(i + 1) % poly.length]];
      const w = polyWalls(seg, true, 'lotEdge', id, false)[0];
      if (!w) continue;
      // Normal into the polygon.
      const mx = (w.ax + w.bx) / 2 + w.nx * 0.2;
      const mz = (w.az + w.bz) / 2 + w.nz * 0.2;
      if (!pointInPolygon(mx, mz, poly)) {
        w.nx = -w.nx;
        w.nz = -w.nz;
      }
      sides.push(w);
    }
    b.walls.push(...sides);
    if (area.params.fountain > 0) {
      const ring = circlePolygon(area.params.fx, area.params.fz, area.params.fountain, 12);
      b.walls.push(...polyWalls(ring, false, 'fountain', id));
      b.props.push({ kind: 'fountain', x: area.params.fx, z: area.params.fz, yaw: 0, size: area.params.fountain, height: 0.8, area: id });
    }
    if (area.variant === 'lot') {
      // Painted bays along the back side: one hint per stripe (from, to).
      const [p0, p1, , p3] = poly;
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const depth = Math.hypot(p3.x - p0.x, p3.z - p0.z);
      const ux = (p1.x - p0.x) / len;
      const uz = (p1.z - p0.z) / len;
      const wx = (p3.x - p0.x) / depth;
      const wz = (p3.z - p0.z) / depth;
      const bay = 2.7;
      const bayDepth = Math.min(5.2, depth * 0.45);
      const n = Math.floor((len - 1) / bay);
      const start = (len - n * bay) / 2;
      for (let k = 0; k <= n; k++) {
        const s = start + k * bay;
        const a = { x: p0.x + ux * s + wx * depth, z: p0.z + uz * s + wz * depth };
        b.hints.push({ kind: 'bay', points: [a, { x: a.x - wx * bayDepth, z: a.z - wz * bayDepth }], values: [] });
      }
    }
    furnish(b, area);
    return b;
  },
};

/**
 * Scatter the pocket's clutter on a jittered grid in its local frame (so
 * parallelogram corners work too), clear of the sides and the fountain.
 * Shallow pockets get a single row of bushes and pots down the middle.
 */
function furnish(b: AreaBuild, area: Area): void {
  const P = area.params;
  if (P.theme === undefined || P.lu === undefined) return;
  const t = INFILL_THEMES[P.theme] ?? 'garden';
  const f = FURNISH[t];
  const rng = new Rng(P.seed >>> 0 || 1);
  const lift = area.variant === 'lot' ? 0 : CITY.curbHeight;
  const total = f.kinds.reduce((s, [, w]) => s + w, 0);
  const pick = (): DistrictPropKind => {
    let r = rng.next() * total;
    for (const [k, w] of f.kinds) {
      r -= w;
      if (r <= 0) return k;
    }
    return f.kinds[0][0];
  };
  // Facing: toward the frontage (minus the depth axis), so tables and boxes square up with the street.
  const yaw = Math.atan2(-P.wx, -P.wz);
  const shallow = P.lw < SHALLOW;
  const spacing = shallow ? Math.min(f.spacing, 2.3) : f.spacing;
  const rows = shallow ? [P.lw / 2] : [];
  if (!shallow) for (let v = spacing * 0.6; v < P.lw - 0.5; v += spacing) rows.push(v);
  let count = 0;
  for (const v0 of rows) {
    for (let u0 = spacing * 0.55 + rng.range(0, spacing * 0.3); u0 < P.lu - 0.5 && count < MAX_PROPS; u0 += spacing) {
      if (!rng.chance(shallow ? Math.min(0.9, f.fill + 0.15) : f.fill)) continue;
      const kind: DistrictPropKind = shallow && t !== 'lot' ? (rng.chance(0.65) ? 'bush' : 'planterPot') : pick();
      const r = PROP_DEFS[kind].radius;
      const u = u0 + rng.range(-0.35, 0.35);
      const v = shallow ? v0 + rng.range(-0.15, 0.15) : v0 + rng.range(-0.35, 0.35);
      const x = P.ox + P.ux * u + P.wx * v;
      const z = P.oz + P.uz * u + P.wz * v;
      if (!pointInPolygon(x, z, area.polygon) || distToPolygonEdge(x, z, area.polygon) < r + EDGE_CLEAR) continue;
      if (P.fountain > 0 && Math.hypot(x - P.fx, z - P.fz) < P.fountain + r + 0.8) continue;
      b.destructibles.push({ kind, x, z, yaw: yaw + rng.range(-0.2, 0.2), lift, area: area.id });
      count++;
    }
  }
}
