/**
 * Roundabouts: some intersections become large circular junctions. The node
 * gets a RoundaboutRing (outer curb radius, island radius), which
 * computeSectors turns into round corners, and the route generator drives
 * around the island (counterclockwise seen from above with the island on the
 * driver's left, right hand traffic: right turns take a quarter, left turns
 * three quarters of the ring).
 *
 * The island is always drivable: the ring is the long way round and the
 * island the shortcut most racers take, priced by what stands on it. Five
 * variants (CITY.districts.roundabout.island), dealt shuffled per seed so a
 * city's roundabouts differ: 'mound' (a grassy dome with a few trees in it),
 * 'knoll' (a flat topped hill that launches a fast car, planter pots and a
 * sculpture plinth on top), 'bowl' (a sunken lawn with a ring of trees on its
 * floor), 'plaza' (a sunken paved square around a dry fountain basin, cafe
 * tables, a fence of planter pots at the foot of its lip) and 'garden' (a low
 * raised bed cut by two cobbled paths between hedges, an urn at the crossing).
 * The profile is a terrain height modifier (rise over the ring road, a
 * smoothstep bevel from the rim) kept gentle enough that a fast car only
 * hops; the time the shortcut costs comes from the clutter: a fence of planter
 * pots and bollards rings the middle at a radius a straight line cannot miss
 * twice, and the few solid pieces (tree trunks, the basin, the plinth) are
 * walls of look 'tree' and 'island' with room to pass either side at a crawl.
 * Lantern posts ('parkLamp' props, pooled by render/areaLights) light every
 * island.
 */
import { CITY } from '../config';
import { edgeAngleFrom, otherNode, sectorAngle } from '../roadGraph';
import { DEG, Vec2, atan2, cos, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { PROP_DEFS, PropKind } from '../props';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';
import { circlePolygon, polyWalls, smooth01, solidWalls } from './geom';

const CFG = CITY.districts.roundabout;

export type IslandVariant = (typeof CFG.variants)[number];

/** Cobble path strips of a garden island are read by the renderer from this hint kind. */
export const ISLAND_HINT = { path: 'islandPath' } as const;

export const roundaboutModule: DistrictModule = {
  kind: 'roundabout',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(CFG.count[0], CFG.count[1]);
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const candidates = g.nodes
      .filter((n) => {
        const m = n.edges.length;
        if (m < 3 || m > 4 || n.gi < 0 || ctx.claims.node.has(n.id)) return false;
        for (let k = 0; k < m; k++) {
          const e = g.edges[n.edges[k]];
          if (e.length < CFG.minEdge || e.bridge || e.kind === 'alley' || e.kind === 'backAlley' || ctx.claims.edge.has(e.id)) return false;
          if (g.nodes[otherNode(e, n.id)].ring) return false;
          if (sectorAngle(g, n, k) < CFG.minSectorDeg * DEG) return false;
        }
        // Keep clear of the river channel.
        for (const r of rivers) {
          const zc = r.params.zMid + r.params.amp * Math.sin(r.params.k * n.x + r.params.phase);
          if (Math.abs(n.z - zc) < r.params.top + CFG.outerRadius[1] + CITY.sidewalk + 12) return false;
        }
        return true;
      })
      .map((n) => n.id);
    rng.shuffle(candidates);
    // One variant each, in a shuffled order: a city never shows the same island twice.
    const deck = rng.shuffle(CFG.variants.slice()) as IslandVariant[];
    const picked: number[] = [];
    for (const id of candidates) {
      if (picked.length >= count) break;
      const n = g.nodes[id];
      if (picked.some((p) => (g.nodes[p].x - n.x) ** 2 + (g.nodes[p].z - n.z) ** 2 < 320 * 320)) continue;
      const outer = rng.range(CFG.outerRadius[0], CFG.outerRadius[1]);
      const footprint = Math.PI * (outer + CITY.sidewalk) ** 2;
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      const seed = rng.int(1, 0x7ffffffe);
      n.ring = { outer, island: outer - CFG.ringWidth };
      ctx.graphChanged();
      // Every corner must come out round (no road too wide for the ring at that angle).
      if (ctx.sectors()[id].some((s) => s.curb.length < 2)) {
        n.ring = undefined;
        ctx.graphChanged();
        continue;
      }
      const variant = deck[picked.length % deck.length];
      picked.push(id);
      ctx.addArea(
        {
          kind: 'roundabout',
          variant,
          polygon: circlePolygon(n.x, n.z, outer + CITY.sidewalk, 24),
          path: [],
          nodes: [id],
          edges: [],
          faces: [],
          params: {
            x: n.x,
            z: n.z,
            outer,
            island: n.ring.island,
            rise: CFG.island[variant].rise,
            paved: variant === 'plaza' ? 1 : 0,
            heading: edgeAngleFrom(g, g.edges[n.edges[0]], id),
            seed,
          },
        },
        footprint,
      );
    }
  },
  build(_ctx, area) {
    const b = emptyBuild();
    const { x, z, outer, island, heading } = area.params;
    const variant = area.variant as IslandVariant;
    const P = CFG.island[variant];
    const id = area.id;
    const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
    b.exclusions.push(circlePolygon(x, z, outer + CITY.sidewalk + 1.5, 20));
    b.surfaces.push({ surface: 'sidewalk', polygon: circlePolygon(x, z, outer + CITY.sidewalk, 32), priority: 3.5, area: id });
    b.surfaces.push({ surface: 'road', polygon: circlePolygon(x, z, outer, 32), priority: 5.5, area: id });
    b.surfaces.push({ surface: variant === 'plaza' ? 'concrete' : 'grass', polygon: circlePolygon(x, z, island, 32), priority: 10, area: id });

    // ---- profile: rise at the middle, a smoothstep bevel in from the rim, flat inside r0 ----
    const H = P.rise;
    const r0 = Math.max(0, island - P.bevel);
    b.heightMods.push({
      minX: x - island,
      minZ: z - island,
      maxX: x + island,
      maxZ: z + island,
      add(px, pz, out) {
        const dx = px - x;
        const dz = pz - z;
        const r = sqrt(dx * dx + dz * dz);
        if (r >= island) return;
        const s = smooth01(r0, island, r);
        out.h += H * (1 - s.v);
        if (r > 1e-6 && s.d) {
          out.gx -= (H * s.d * dx) / r;
          out.gz -= (H * s.d * dz) / r;
        }
      },
    });

    // ---- placement helpers ----
    const solids: { x: number; z: number; r: number }[] = [];
    const at = (r: number, ang: number): Vec2 => ({ x: x + cos(ang) * r, z: z + sin(ang) * r });
    /** Clear of the solid pieces by `gap` and inside the island by `margin`. */
    const open = (p: Vec2, gap: number, margin: number): boolean =>
      sqrt((p.x - x) ** 2 + (p.z - z) ** 2) < island - margin && solids.every((s) => (s.x - p.x) ** 2 + (s.z - p.z) ** 2 > (s.r + gap) ** 2);
    // Clutter is placed in list order and a spec overlapping an earlier prop is dropped (props.ts), so
    // what matters most (lanterns, the fence) is pushed first and the bushes fill in around it.
    const clutter = (kind: PropKind, p: Vec2, yaw: number, gap = 1): boolean => {
      if (!open(p, gap, 1)) return false;
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw, lift: 0, area: id });
      return true;
    };
    /** Facing the middle (a bench's seat, a lantern's door). */
    const inward = (p: Vec2) => atan2(x - p.x, z - p.z);
    const tree = (p: Vec2) => {
      solids.push({ x: p.x, z: p.z, r: CFG.treeRadius });
      b.walls.push(...solidWalls(circlePolygon(p.x, p.z, CFG.treeRadius, 6), 'tree', id));
      b.props.push({ kind: 'tree', x: p.x, z: p.z, yaw: rng.range(0, 6.28), size: rng.range(2.2, 3.4), height: rng.range(5.5, 8.5), area: id });
    };
    /** A sculpture plinth (or an urn's base) at the middle: a small solid the car passes either side of. */
    const plinth = (kind: string, height: number) => {
      const R = CFG.plinth;
      solids.push({ x, z, r: R });
      b.walls.push(...solidWalls(circlePolygon(x, z, R, 8, Math.PI / 8), 'island', id));
      b.props.push({ kind, x, z, yaw: heading, size: R, height, area: id });
    };
    /** Lantern posts in a ring, facing in. */
    const lamps = (n: number, r: number, phase: number) => {
      for (let i = 0; i < n; i++) {
        const p = at(r, phase + (i / n) * Math.PI * 2);
        clutter('parkLamp', p, inward(p), 0.6);
      }
    };
    /**
     * The fence: planter pots and bollards alternating round a ring, their edges CFG.fenceGap apart. A
     * post within 1.2 m of a trunk or the basin is left out (the solid is the fence there).
     */
    const fenceStep = CFG.fenceGap + PROP_DEFS.planterPot.radius + PROP_DEFS.bollard.radius;
    const fence = (r: number, phase: number) => {
      const n = Math.max(6, Math.round((2 * Math.PI * r) / fenceStep));
      for (let i = 0; i < n; i++) {
        const ang = phase + (i / n) * Math.PI * 2;
        clutter(i % 2 ? 'bollard' : 'planterPot', at(r, ang), ang, 1.2);
      }
    };
    const benches = (n: number, r: number, phase: number) => {
      for (let i = 0; i < n; i++) {
        const p = at(r, phase + ((i + 0.5) / n) * Math.PI * 2 + rng.range(-0.2, 0.2));
        if (!clutter('bench', p, inward(p), 1.4)) continue;
        const yaw = inward(p);
        if (rng.chance(0.7)) clutter('garbageCan', { x: p.x + cos(yaw) * 1.6, z: p.z - sin(yaw) * 1.6 }, yaw);
      }
    };
    const bushes = (n: number, rMin: number, rMax: number) => {
      for (let i = 0; i < n; i++) clutter('bush', at(rng.range(rMin, rMax), rng.range(0, Math.PI * 2)), rng.range(0, 6.28), 0.8);
    };

    // ---- lanterns just inside the rim first (the garden lights its path ends instead) ----
    const phase = rng.range(0, Math.PI * 2);
    if (variant !== 'garden') lamps(CFG.lamps, island - CFG.lampInset, heading + Math.PI / CFG.lamps);

    // ---- solid pieces, the fence and the clutter per variant ----
    if (variant === 'mound') {
      const V = CFG.island.mound;
      // Trees scattered over the inner half, a car's width and more between any two trunks.
      const n = rng.int(V.trees[0], V.trees[1]);
      for (let k = 0, tries = 0; k < n && tries < 40; tries++) {
        const p = at(rng.range(2.5, island * 0.5), rng.range(0, Math.PI * 2));
        if (!open(p, CFG.treeGap, 3)) continue;
        tree(p);
        k++;
      }
      fence(CFG.fenceRadius, phase);
      benches(V.benches, island - 3.5, phase);
      bushes(rng.int(V.bushes[0], V.bushes[1]), 2, island - 2);
    } else if (variant === 'knoll') {
      const V = CFG.island.knoll;
      plinth('sculpture', 1.2);
      fence(Math.min(CFG.fenceRadius, r0 - 1), phase);
      benches(V.benches, island - 3.5, phase);
      bushes(rng.int(V.bushes[0], V.bushes[1]), r0 + 1, island - 2);
    } else if (variant === 'bowl') {
      const V = CFG.island.bowl;
      // A ring of trees with the fence between them, evenly spaced so every gap takes a car.
      const treeR = Math.min(V.treeRing, island * 0.45);
      const n = Math.min(rng.int(V.trees[0], V.trees[1]), Math.floor((2 * Math.PI * treeR) / CFG.treeGap));
      for (let i = 0; i < n; i++) tree(at(treeR, phase + (i / n) * Math.PI * 2 + rng.range(-0.12, 0.12)));
      fence(treeR, phase + Math.PI / n);
      benches(V.benches, island - 3.5, phase + Math.PI / n);
      bushes(rng.int(V.bushes[0], V.bushes[1]), 2, island - 2.5);
    } else if (variant === 'plaza') {
      const V = CFG.island.plaza;
      // A dry fountain basin in the middle, cafe tables between bollards around it, a fence of pots and
      // bollards where the lip's slope meets the floor.
      const R = Math.min(V.basin[1], Math.max(V.basin[0], island * 0.2));
      solids.push({ x, z, r: R });
      b.walls.push(...polyWalls(circlePolygon(x, z, R, 14), false, 'island', id));
      b.props.push({ kind: 'basin', x, z, yaw: 0, size: R, height: 0.85, area: id });
      const tables = rng.int(V.tables[0], V.tables[1]);
      for (let i = 0; i < tables; i++) {
        const ang = phase + (i / tables) * Math.PI * 2;
        clutter('cafeTable', at(R + 3.6, ang + rng.range(-0.1, 0.1)), ang + rng.range(-0.5, 0.5));
        clutter('bollard', at(R + 3.6, ang + Math.PI / tables), ang, 0.5);
      }
      fence(r0 - 0.9, phase);
      benches(V.benches, R + 7.5, phase + Math.PI / tables);
      const carts = rng.int(V.carts[0], V.carts[1]);
      for (let i = 0; i < carts; i++) {
        const ang = phase + ((i + 0.5) / carts) * Math.PI * 2;
        clutter('foodCart', at(r0 - 3.5, ang), ang + Math.PI / 2, 1.2);
        clutter('newsBox', at(r0 - 3.1, ang + 0.35), ang);
      }
    } else {
      const V = CFG.island.garden;
      // Garden: an urn at the crossing of two cobbled paths, lantern pairs at the path ends, bollard
      // gateposts where the paths pass the middle, hedges along them (every third piece a pot), a pot
      // at each inner corner.
      plinth('urn', 0.9);
      const half = V.pathWidth / 2;
      const L = island - 0.6;
      const rows = [heading, heading + Math.PI / 2];
      for (const a of rows) {
        const u = { x: cos(a), z: sin(a) };
        const w = { x: -u.z, z: u.x };
        const along = (s: number, t: number): Vec2 => ({ x: x + u.x * s + w.x * t, z: z + u.z * s + w.z * t });
        const strip = [along(-L, -half), along(L, -half), along(L, half), along(-L, half)];
        b.surfaces.push({ surface: 'cobble', polygon: strip, priority: 11, area: id });
        b.hints.push({ kind: ISLAND_HINT.path, points: strip, values: [V.pathWidth] });
        for (const end of [-1, 1]) {
          for (const side of [-1, 1]) {
            const l = along(end * (island - CFG.lampInset), side * (half + 1.3));
            clutter('parkLamp', l, inward(l), 0.6);
            clutter('bollard', along(end * V.gatepost, side * (half + 0.9)), a, 0.5);
          }
          clutter('planterPot', along(end * (half + 2.4), end * (half + 2.4)), 0);
        }
      }
      for (const a of rows) {
        const u = { x: cos(a), z: sin(a) };
        const w = { x: -u.z, z: u.x };
        for (const side of [-1, 1]) {
          let k = 0;
          for (let s = -(island - 4.5); s <= island - 4.5; s += V.hedgeSpacing, k++) {
            if (Math.abs(s) < half + 1.4) continue;
            const p = { x: x + u.x * s + w.x * (half + 0.9) * side, z: z + u.z * s + w.z * (half + 0.9) * side };
            if (k % 3 === 2) clutter('planterPot', p, a, 0.5);
            else clutter('bush', p, rng.range(0, 6.28), 0.8);
          }
        }
      }
      benches(V.benches, island * 0.62, heading + Math.PI / 4);
    }
    return b;
  },
};

/** The island's flat middle radius (m): where its bevel starts. */
export function islandFlatRadius(variant: string, island: number): number {
  const P = CFG.island[variant as IslandVariant];
  return P ? Math.max(0, island - P.bevel) : island;
}
