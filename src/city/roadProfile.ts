/**
 * The shape of the road surface itself: a crown on the streets, speed humps on side streets and the lip of an
 * expansion joint on the decks. Pure height contributions with exact gradients, so `heightAt` and `slopeAt`
 * agree and the car's springs and the slope force see the same ground the renderer drapes.
 *
 *  - Crown: a street's middle stands above its kerbs by a parabola, flat at the centreline and twice the
 *    mean cross slope at the kerb (drivingParams.json `road.crown*`: 2% on avenues, diagonals and
 *    boulevards, 1% on plain streets). A car holding the middle of a lane feels about that grade pulling it
 *    toward the kerb, and a turn across the crown leans it. The crown fades out over a junction's reach
 *    (ROAD_PHYSICS.crown), so a fan is flat. Streets a district claims (a bridge, the El's street, a
 *    roundabout's arms, the river's edges) stay as that district built them.
 *  - Humps: on plain side streets the circuit and sprint do not use, a cosine bump (road.hump*) every 60-120 m,
 *    full height across the lanes and eased off toward the kerb. Laid out after the districts are final
 *    (planHumps), because they depend on the routes, the drag strip and where each district stands.
 *  - Joints: `lipAt` is one expansion joint's raised-cosine lip; the highway deck and the river's bridges place
 *    them on their own axes (DeckSpan.joint).
 *
 * The crown and the humps are one HeightMod folded into the terrain (createTerrain), indexed by a grid of the
 * edges and humps near each cell. Rendering reads the same heights; it adds the rows that let a crown and a
 * hump show (render/street/cityMeshes.ts) and the paint on them.
 */
import { ROAD_PHYSICS } from './config';
import type { RoadEdge, RoadGraph } from './roadGraph';
import { isBendNode } from './roadGraph';
import type { HeightMod, HeightSample } from './districts/types';
import { Rng, deriveSeed } from '../sim/prng';
import { PI, cos, sin, sqrt } from '../sim/math';
import { ROAD } from '../sim/tuning';

/** A crowned street piece in its own frame: the edge's start, unit direction, length, half width and the fade ends. */
interface Crowned {
  edge: number;
  ax: number;
  az: number;
  ux: number;
  uz: number;
  len: number;
  half: number;
  /** Centre rise over the kerb (m). */
  rise: number;
  /** Distance from each end where the crown starts to rise (m). */
  clearA: number;
  clearB: number;
}

/** A speed hump: its centre, the street's direction there and half width. */
export interface Hump {
  edge: number;
  x: number;
  z: number;
  /** Unit direction of the street (the hump's length runs along it). */
  ux: number;
  uz: number;
  /** The street's half width, curb to curb (m). */
  half: number;
  /** Distance along the street from its start node (m). */
  s: number;
}

/** One joint lip's height (m) and its slope across the joint (dh/dd). */
export interface Lip {
  h: number;
  dh: number;
}

export interface RoadProfile {
  /** Folded into the terrain: crown and humps, added to the plain height. */
  mod: HeightMod;
  /** Crowned street pieces. */
  crowned: readonly Crowned[];
  /** Every hump placed (empty until planHumps). */
  humps: readonly Hump[];
  /** Whether a street edge carries a crown. */
  hasCrown(edge: number): boolean;
  /** Humps on an edge, by distance along it. */
  humpsOn(edge: number): Hump[];
  /** The hump height (m) at a point, 0 off every hump (it also reports the slope through `out` when given). */
  humpHeightAt(x: number, z: number, out?: HeightSample): number;
  /** Add the crown alone at (x, z) into `out`. */
  crownAt(x: number, z: number, out: HeightSample): void;
  /** Lay the humps out (once, after the districts, routes and drag strip are final). */
  placeHumps(plan: HumpPlan): void;
}

/** What the humps are laid out against. */
export interface HumpPlan {
  seed: number;
  /** Edges any route drives (the circuit, the sprint and the drag strip): no humps on them. */
  routeEdges: ReadonlySet<number>;
  /** Edges some district claimed: no humps on them either. */
  claimed: ReadonlySet<number>;
  /** Whether the ground at a point is plain street (no district's area on it). */
  plainStreet(x: number, z: number): boolean;
}

/** Street kinds with a crown, by the road tuning that sizes it. */
const CROWN_OF = { street: 'crownStreet', avenue: 'crownAvenue', diagonal: 'crownDiagonal', boulevard: 'crownBoulevard' } as const;

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** d(smooth)/dt, zero outside (0, 1). */
const dsmooth = (t: number): number => (t <= 0 || t >= 1 ? 0 : 6 * t * (1 - t));

/** A junction's reach along its streets (m): the widest road's half width (a roundabout's outer curb), the margin on. */
function junctionReach(g: RoadGraph, node: number): number {
  const n = g.nodes[node];
  let r = n.ring ? n.ring.outer : 0;
  for (const eid of n.edges) r = Math.max(r, g.edges[eid].width / 2);
  return r;
}

/** One raised cosine lip `d` m from the joint line: the height and slope across it (0 outside its half width). */
export function lipAt(d: number, out: Lip): void {
  const w = ROAD.jointWidth;
  if (d <= -w / 2 || d >= w / 2) {
    out.h = 0;
    out.dh = 0;
    return;
  }
  const k = (2 * PI) / w;
  out.h = (ROAD.jointHeight / 2) * (1 + cos(k * d));
  out.dh = (-ROAD.jointHeight / 2) * k * sin(k * d);
}

/**
 * The lip of a deck's joints at `s` m along it, one every road.jointSpacing from `first`: the joint nearest `s`
 * (the lips are far narrower than the spacing, so only one can reach it). Zero before `first`.
 */
export function lipSeries(s: number, first: number, out: Lip): void {
  const sp = ROAD.jointSpacing;
  const k = Math.round((s - first) / sp);
  if (k < 0) {
    out.h = 0;
    out.dh = 0;
    return;
  }
  lipAt(s - first - k * sp, out);
}

/**
 * The lips of joints spread evenly from `from` to `to` (m along a deck, both ends joints, about road.jointSpacing
 * apart): the one nearest `s`. A bridge puts one on each abutment line and the rest between.
 */
export function lipSpread(s: number, from: number, to: number, out: Lip): void {
  const n = Math.max(1, Math.round((to - from) / ROAD.jointSpacing));
  const step = (to - from) / n;
  const k = Math.max(0, Math.min(n, Math.round((s - from) / step)));
  lipAt(s - from - k * step, out);
}

/** Where lipSpread's joints stand (m along the deck): the renderer paints a strip at each. */
export function spreadJoints(from: number, to: number): number[] {
  const n = Math.max(1, Math.round((to - from) / ROAD.jointSpacing));
  return Array.from({ length: n + 1 }, (_, k) => from + ((to - from) * k) / n);
}

const GRID = 24;

export function createRoadProfile(g: RoadGraph, claimed: ReadonlySet<number>): RoadProfile {
  const cfg = ROAD_PHYSICS.crown;
  const crowned: Crowned[] = [];
  const byEdge = new Map<number, number>();
  g.edges.forEach((e: RoadEdge, id) => {
    if (!(e.kind in CROWN_OF) || e.shortcut || e.bridge || e.crossing !== undefined || claimed.has(id)) return;
    if (e.length < cfg.minLength) return;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const ux = (B.x - A.x) / e.length;
    const uz = (B.z - A.z) / e.length;
    const half = e.width / 2;
    // A bend node is no junction: the street carries on through it (and bends a few degrees), so no fan to keep flat.
    const clear = (node: number) => (isBendNode(g, node) ? 0 : junctionReach(g, node) + cfg.junctionMargin);
    byEdge.set(id, crowned.length);
    crowned.push({ edge: id, ax: A.x, az: A.z, ux, uz, len: e.length, half, rise: ROAD[CROWN_OF[e.kind as keyof typeof CROWN_OF]] * half, clearA: clear(e.a), clearB: clear(e.b) });
  });
  const humps: Hump[] = [];
  const humpIdx = new Map<number, Hump[]>();

  // Grid of crowned pieces and humps by cell, over the graph's bounds.
  const b = g.bounds;
  const x0 = b.minX - 40;
  const z0 = b.minZ - 40;
  const cols = Math.max(1, Math.ceil((b.maxX + 40 - x0) / GRID));
  const rows = Math.max(1, Math.ceil((b.maxZ + 40 - z0) / GRID));
  const crownCells: number[][] = Array.from({ length: cols * rows }, () => []);
  const humpCells: number[][] = Array.from({ length: cols * rows }, () => []);
  const insert = (cells: number[][], id: number, ax: number, az: number, bx: number, bz: number, pad: number) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - pad - x0) / GRID));
    const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + pad - x0) / GRID));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - pad - z0) / GRID));
    const j1 = Math.min(rows - 1, Math.floor((Math.max(az, bz) + pad - z0) / GRID));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * cols + i].push(id);
  };
  crowned.forEach((c, id) => insert(crownCells, id, c.ax, c.az, c.ax + c.ux * c.len, c.az + c.uz * c.len, c.half));
  const cellOf = (x: number, z: number): number => {
    const i = Math.floor((x - x0) / GRID);
    const j = Math.floor((z - z0) / GRID);
    return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
  };

  /** Crown of one piece at (x, z): height and gradient, or false when the point is off its strip. */
  const crown = (c: Crowned, x: number, z: number, out: HeightSample): boolean => {
    const dx = x - c.ax;
    const dz = z - c.az;
    const s = dx * c.ux + dz * c.uz;
    if (s <= c.clearA || s >= c.len - c.clearB) return false;
    const d = -dx * c.uz + dz * c.ux;
    const q = d / c.half;
    if (q <= -1 || q >= 1) return false;
    const ta = (s - c.clearA) / cfg.junctionRamp;
    const tb = (c.len - c.clearB - s) / cfg.junctionRamp;
    const fa = smooth(ta);
    const fb = smooth(tb);
    const f = fa * fb;
    const prof = 1 - q * q;
    const dfds = (dsmooth(ta) * fb - fa * dsmooth(tb)) / cfg.junctionRamp;
    const dhds = c.rise * prof * dfds;
    const dhdd = c.rise * ((-2 * q) / c.half) * f;
    out.h = c.rise * prof * f;
    out.gx = dhds * c.ux - dhdd * c.uz;
    out.gz = dhds * c.uz + dhdd * c.ux;
    return true;
  };
  const piece: HeightSample = { h: 0, gx: 0, gz: 0 };
  const crownAt = (x: number, z: number, out: HeightSample): void => {
    const cell = cellOf(x, z);
    if (cell < 0) return;
    // Where strips overlap (acute junctions) the higher crown wins: continuous, with a crease along the tie.
    let best = 0;
    let gx = 0;
    let gz = 0;
    for (const id of crownCells[cell]) {
      if (crown(crowned[id], x, z, piece) && piece.h > best) {
        best = piece.h;
        gx = piece.gx;
        gz = piece.gz;
      }
    }
    out.h += best;
    out.gx += gx;
    out.gz += gz;
  };

  const L = ROAD.humpLength;
  const taper = ROAD.humpTaper;
  /** One hump at (x, z): height and gradient added into `out`; false when off it. */
  const humpAt = (hp: Hump, x: number, z: number, out: HeightSample): boolean => {
    const dx = x - hp.x;
    const dz = z - hp.z;
    const u = dx * hp.ux + dz * hp.uz;
    if (u <= -L / 2 || u >= L / 2) return false;
    const d = -dx * hp.uz + dz * hp.ux;
    const q = Math.abs(d) / hp.half;
    if (q >= 1) return false;
    const k = (2 * PI) / L;
    const along = 0.5 * (1 + cos(k * u));
    const dAlong = -0.5 * k * sin(k * u);
    const t = (q - (1 - taper)) / taper;
    const w = 1 - smooth(t);
    const dw = -dsmooth(t) / taper;
    const H = ROAD.humpHeight;
    const dhdu = H * dAlong * w;
    const dhdd = H * along * dw * (d < 0 ? -1 : 1) / hp.half;
    out.h += H * along * w;
    out.gx += dhdu * hp.ux - dhdd * hp.uz;
    out.gz += dhdu * hp.uz + dhdd * hp.ux;
    return true;
  };
  const hump: HeightSample = { h: 0, gx: 0, gz: 0 };
  const humpsAt = (x: number, z: number, out: HeightSample): void => {
    const cell = cellOf(x, z);
    if (cell < 0) return;
    for (const id of humpCells[cell]) humpAt(humps[id], x, z, out);
  };

  const mod: HeightMod = {
    minX: x0,
    minZ: z0,
    maxX: x0 + cols * GRID,
    maxZ: z0 + rows * GRID,
    add(x, z, out) {
      crownAt(x, z, out);
      if (humps.length) humpsAt(x, z, out);
    },
  };

  return {
    mod,
    crowned,
    humps,
    hasCrown: (edge) => byEdge.has(edge),
    humpsOn: (edge) => humpIdx.get(edge) ?? [],
    humpHeightAt(x, z, out) {
      hump.h = 0;
      hump.gx = 0;
      hump.gz = 0;
      humpsAt(x, z, hump);
      if (out) {
        out.h = hump.h;
        out.gx = hump.gx;
        out.gz = hump.gz;
      }
      return hump.h;
    },
    crownAt,
    placeHumps(plan) {
      if (humps.length) throw new Error('placeHumps: the humps are laid out once');
      const cfgH = ROAD_PHYSICS.hump;
      const rng = new Rng(deriveSeed(plan.seed, 'roadHumps'));
      g.edges.forEach((e, id) => {
        if (e.kind !== 'street' || e.shortcut || e.bridge || e.crossing !== undefined || e.length < cfgH.minLength) return;
        if (plan.routeEdges.has(id) || plan.claimed.has(id)) return;
        // The seeded draws come for every street that could carry a hump, so one edge's fate never shifts another's.
        const share = rng.next();
        const gap = rng.range(cfgH.gap[0], cfgH.gap[1]);
        if (share >= cfgH.share) return;
        const A = g.nodes[e.a];
        const B = g.nodes[e.b];
        if (A.ring || B.ring) return;
        const lo = (isBendNode(g, e.a) ? 0 : junctionReach(g, e.a)) + L / 2 + cfgH.junctionClear;
        const hi = e.length - (isBendNode(g, e.b) ? 0 : junctionReach(g, e.b)) - L / 2 - cfgH.junctionClear;
        if (hi < lo) return;
        const n = Math.floor((hi - lo) / gap) + 1;
        const ux = (B.x - A.x) / e.length;
        const uz = (B.z - A.z) / e.length;
        for (let i = 0; i < n; i++) {
          const s = n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1);
          const x = A.x + ux * s;
          const z = A.z + uz * s;
          // Plain street all along the bump and a car's length either side.
          let plain = true;
          for (const u of [-L, -L / 2, 0, L / 2, L]) plain = plain && plan.plainStreet(x + ux * u, z + uz * u);
          if (!plain) continue;
          const hp: Hump = { edge: id, x, z, ux, uz, half: e.width / 2, s };
          const idx = humps.length;
          humps.push(hp);
          let list = humpIdx.get(id);
          if (!list) humpIdx.set(id, (list = []));
          list.push(hp);
          const r = sqrt((L / 2) ** 2 + hp.half ** 2);
          insert(humpCells, idx, x, z, x, z, r);
        }
      });
    },
  };
}
