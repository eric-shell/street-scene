/**
 * Weekend special: The Underground (src/city/weekend.ts, docs/weekend.md).
 *
 * A half-built cut-and-cover expressway down a long, thin weekend region (weekendRegion.ts: two cells across, four
 * to six along, the spine dead straight from the entry to the exit), at night: the spine is the trench floor five
 * metres under grade, a third of it roofed and the roof a works plaza at grade, service roads either side, two Bailey
 * bridges over the open trench, a utility gallery under the plaza, and kickers that throw a car from the floor up onto
 * the levels above. Planned only on the seeds whose weekend pick is `underground`; every other seed returns at once
 * (before drawing anything), so weekday cities stay bit-identical.
 *
 * Planning (districts/index.ts, weekendRegion.ts): carve with the module's shapes and the floor's width as the
 * spine's; plan (right after the topology hook) claims the blocks, records the routes and fixes the frame (the spine's
 * chord), the ramp tops (just past the flares, so the approach street drops into the trench straight ahead) and the
 * roof. undergroundShape.ts lays everything else out from those params, in the race's travel frame.
 *
 * Six lines from the entry to the exit (undergroundLines, the spine first):
 *  1. The trench floor (the spine): concrete under sodium lamps, the side kicker, the burst main's wet stretch, the
 *     tunnel under the plaza with the plaza kicker in it, the other side kicker, the stalled bus.
 *  2. The left service road: at grade the whole way, plant parked on its verge, the mud at the spoil heap, the left
 *     kicker's landing.
 *  3. The right service road: the demolished windows (the plinth gone, rubble down into the trench, fence panels along
 *     the lip with a gap), the right kicker's landing, over the gallery's roof under the plaza.
 *  4. The plaza: off the left road onto the roof, round the kicker's opening and the drop opening, off onto the right
 *     road. The plaza kicker throws a car from the tunnel up through the first opening onto it.
 *  5. The gallery: off the floor through the first cross passage, down into the utility gallery under the right side of
 *     the plaza (pipes and cable trays along its walls, a wet patch, work lights), back up and out the second passage.
 *  6. The crossing bridges: the left road over the first bridge onto the right road, back over the second onto the left.
 *
 * Collision: every wall is a solid drawn by render/districts/underground.ts (look trenchWall). Where levels stack the
 * solids carry heights (settleUnderground, once the terrain exists): the plinth's top is the kerb over grade in the open
 * (a car flying above it passes over), a metre under grade beneath a deck; the plaza's and the bridges' walls have a
 * `bottom` so a car in the trench passes under them and a `top` so a thrown car clears them; the gallery's walls stand
 * below the roof. The roof and the bridges are DeckSpans with `upper` (the terrain beneath is the trench: the spine's
 * asphalt drapes on it and every car below drives it); a car nearer the deck than the floor drives the deck.
 */
import { CITY } from '../config';
import type { DistrictPropSpec } from '../props';
import type { Terrain } from '../terrain';
import type { Wall } from '../blocks';
import type { LaneClosure } from './roadworks';
import { Rng, deriveSeed } from '../../sim/prng';
import { type Vec2, cos, sin, sqrt } from '../../sim/math';
import type { Area, AreaBuild, BuildContext, DeckSpan, DistrictModule, FeatureLine, HeightSample, PlanContext, Surface } from './types';
import { emptyBuild } from './types';
import { distToPolygonEdge, intersectConvex, pointInPolygon, solidWalls } from './geom';
import { carveRegion, planRegion, raceDirection, regionFenceWalls, regionGround, regionOf } from './weekendRegion';
import type { Region, WeekendShape } from './weekendRegion';
import {
  DECK_RIGHT,
  F,
  P_OUT,
  ROAD_MID,
  ROAD_OUT,
  VERGE_OUT,
  type Rect,
  type UgSite,
  bridgeDeck,
  bridgeLineS,
  bridgePoint,
  bridgeReach,
  gradeAt,
  kickerFlight,
  profileAt,
  rectWorld,
  toTravel,
  toWorld,
  undergroundBox,
  undergroundHeight,
  undergroundSite,
  worldDir,
} from './undergroundShape';

const CFG = CITY.districts.underground;
const FLARE = CITY.districts.weekend.flare;

/** Region shapes (weekendRegion.ts): two cells across, four to six along a straight spine. */
export const UNDERGROUND_SHAPES: readonly WeekendShape[] = [
  { along: 4, across: 2 },
  { along: 5, across: 2 },
  { along: 6, across: 2 },
];

/** Hint kinds the renderer reads (AreaHint.kind); every position in the travel frame (undergroundShape.ts). */
export const UNDERGROUND_HINT = {
  /** A plinth piece: values [kind (0 kerb, 1 under a deck), side, s0 at the floor face, s0 at the back, s1 at the floor face, s1 at the back, width]. */
  plinth: 'ugPlinth',
  /** A box solid the renderer draws as plant: values [type, s, w, yaw (rad, from +s toward +w), length, width, height]. */
  solid: 'ugSolid',
} as const;

/** What a box solid is (UNDERGROUND_HINT.solid's type). */
export const UG_SOLID = { bus: 0, truck: 1, digger: 2, lightTower: 3, cabin: 4, crane: 5, stack: 6, mat: 7, heap: 8, abutment: 9, pipes: 10, trays: 11, mast: 12 } as const;

/** How a group of walls takes its heights once the terrain exists (settleUnderground). */
type SettleKind = 'kerb' | 'low' | 'slab' | 'hoard' | 'headwall' | 'parapet' | 'below' | 'flank';
interface Pending {
  walls: Wall[];
  kind: SettleKind;
  /** World points whose grade the heights follow. */
  pts: Vec2[];
}
const pending = new WeakMap<AreaBuild, Pending[]>();
/** The terrain the decks read their grade from, filled by settleUnderground. */
const terrains = new WeakMap<AreaBuild, { terrain: Terrain | null }>();

// ---------------------------------------------------------------------------
// Module

export const undergroundModule: DistrictModule = {
  kind: 'underground',
  phase: 'graph',

  carve(ctx) {
    if (!CFG.enabled || ctx.weekend?.kind !== 'underground') return;
    carveRegion(ctx, { kind: 'underground', shapes: UNDERGROUND_SHAPES, spineWidth: CFG.floor, straight: true });
  },

  plan: planArea,

  build: (ctx, area) => buildArea(ctx, area),

  lines(area) {
    const r = regionOf(area);
    if (!r || !area.params.planned) return [];
    return undergroundLines(undergroundSite(area), r);
  },
};

/** Lay the trench out on the region's straight spine (the module's plan, right after the routes are picked). */
function planArea(ctx: PlanContext): void {
  if (!CFG.enabled) return;
  const r = planRegion(ctx, 'underground');
  if (!r || !r.area.params.planned || r.area.params.roof) return;
  const area = r.area;
  const A = r.path[0];
  const B = r.path[r.path.length - 1];
  const length = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
  const half = length / 2;
  const top = half - FLARE - CFG.endClear;
  const roof = top * CFG.roof.share;
  if (top - CFG.rampRun - roof < CFG.minOpen) {
    // Too short a spine for the trench (no shape this module declares is): nothing is built and nothing promised.
    area.params.planned = 0;
    area.params.special = 0;
    return;
  }
  Object.assign(area.params, {
    cx: (A.x + B.x) / 2,
    cz: (A.z + B.z) / 2,
    ux: (B.x - A.x) / length,
    uz: (B.z - A.z) / length,
    half,
    top,
    roof,
    // The travel frame turns with the race (undergroundShape.ts), so the kickers always come in the same order.
    dir: raceDirection(area),
  });
}

// ---------------------------------------------------------------------------
// The ring, read in the travel frame

/** Distance (m) along a travel-frame ray from (s, w) to the region's ring, Infinity if it never meets it. */
export function ringReach(site: UgSite, poly: readonly Vec2[], s: number, w: number, ds: number, dw: number): number {
  const o = toWorld(site, s, w);
  const d = worldDir(site, ds, dw);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const den = d.x * ez - d.z * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a.x - o.x) * ez - (a.z - o.z) * ex) / den;
    const u = ((a.x - o.x) * d.z - (a.z - o.z) * d.x) / den;
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

/** The ring's s at lateral w beyond the end of the trench the race enters (-1) or leaves by (+1). */
export function ringEnd(site: UgSite, poly: readonly Vec2[], end: number, w: number): number {
  return end * (site.top + ringReach(site, poly, end * site.top, w, end, 0));
}

// ---------------------------------------------------------------------------
// Lines

/** A travel-frame polyline to a world path in the region's entry-to-exit order. */
function linePath(site: UgSite, r: Region, pts: [number, number][]): Vec2[] {
  const out = pts.map(([s, w]) => toWorld(site, s, w));
  if (site.dir < 0) out.reverse();
  // The ends are the ring's junctions exactly.
  out[0] = { x: r.path[0].x, z: r.path[0].z };
  out[out.length - 1] = { x: r.path[r.path.length - 1].x, z: r.path[r.path.length - 1].z };
  return out;
}

/** Where the racing line must keep off the floor (the kickers' bevels and the bus), in travel order: [s0, s1, side, inner edge |w|]. */
export function floorClosures(site: UgSite): [number, number, number, number][] {
  const K = CFG.kicker;
  const out: [number, number, number, number][] = [];
  for (const k of site.kickers) {
    const inner = Math.min(Math.abs(k.lipW), Math.abs(k.footW)) - K.width / 2 - K.edge;
    out.push([Math.min(k.footS, k.lipS), Math.max(k.footS, k.lipS) + K.drop, k.side, inner]);
  }
  out.push([site.bus.s - CFG.bus.length / 2, site.bus.s + CFG.bus.length / 2, Math.sign(site.bus.w), Math.abs(site.bus.w) - CFG.bus.width / 2]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** The spine's way down the floor, weaving off each closure (travel frame, from s = -half to +half). */
function spinePoints(site: UgSite): [number, number][] {
  const pts: [number, number][] = [
    [-site.half, 0],
    [-site.top, 0],
  ];
  const off = 2.6;
  for (const [s0, s1, side] of floorClosures(site)) {
    pts.push([s0 - 10, 0], [s0, -side * off], [s1, -side * off], [s1 + 10, 0]);
  }
  pts.push([site.top, 0], [site.half, 0]);
  return pts;
}

/** A service road line from the race's entry funnel (on side `inSide`) to its exit funnel (on `outSide`), `inner` points between (travel frame). */
function roadPoints(site: UgSite, poly: readonly Vec2[], inSide: number, outSide: number, inner: [number, number][]): [number, number][] {
  const sE = ringEnd(site, poly, -1, 0);
  const sX = ringEnd(site, poly, 1, 0);
  return [[-site.half, 0], [sE + 6, inSide * 4], [-site.top + 3, inSide * ROAD_MID], ...inner, [site.top - 3, outSide * ROAD_MID], [sX - 6, outSide * 4], [site.half, 0]];
}

/** The right road's weave out round each demolished window's lip panels. */
function windowWeave(site: UgSite, lo = -Infinity, hi = Infinity): [number, number][] {
  const D = CFG.demolished;
  const out: [number, number][] = [];
  const wide = ROAD_MID + 2.6;
  for (const c of site.windows) if (c > lo && c < hi) out.push([c - D.half - 14, ROAD_MID], [c - D.half - 4, wide], [c + D.half + 4, wide], [c + D.half + 14, ROAD_MID]);
  return out;
}

/**
 * A bridge crossing in the line (travel frame): down the road, onto the bridge's axis mid road (so the line runs the
 * hump and the deck square to the parapets' ends), across, off it mid road on the other side and on down that road.
 */
function bridgeCross(br: { s: number; as: number; aw: number; sign: number }): [number, number][] {
  const a = bridgePoint(br, -ROAD_MID / Math.abs(br.aw), 0);
  const b = bridgePoint(br, ROAD_MID / Math.abs(br.aw), 0);
  const from = a.w < 0 ? -1 : 1;
  return [
    [a.s - 16, from * ROAD_MID],
    [a.s, a.w],
    [b.s, b.w],
    [b.s + 16, -from * ROAD_MID],
  ];
}

/** The six lines (FeatureLine contract, weekendRegion.ts): the spine first. Pure on the site and the region. */
export function undergroundLines(site: UgSite, r: Region): FeatureLine[] {
  const poly = r.polygon;
  const R = site.R;
  const [oK, oD] = site.openings;
  const g = site.gallery;
  const [p1, p2] = g.passages;
  const gw = galleryMid();
  const line = (id: string, name: string, kind: FeatureLine['kind'], pts: [number, number][], width: number, level: FeatureLine['level'], surface: Surface, difficulty: FeatureLine['difficulty']): FeatureLine => ({
    id,
    name,
    kind,
    path: linePath(site, r, pts),
    width,
    level,
    surface,
    difficulty,
  });
  const spine = spinePoints(site);
  const before = (s: number) => spine.filter((p) => p[0] < s);
  const after = (s: number) => spine.filter((p) => p[0] > s);
  const plaza: [number, number][] = [
    [-R + 3, -ROAD_MID],
    [-R + 26, 3.6],
    [oK.s1, 3.6],
    [oD.s0 - 2, -3.6],
    [oD.s1 + 2, -3.6],
    [R - 8, ROAD_MID],
  ];
  const a1 = (gw - p1.pw) / p1.dw;
  const a2 = (gw - p2.pw) / p2.dw;
  const gallery: [number, number][] = [
    ...before(p1.ps - 18),
    [p1.ps - 18, 0],
    [p1.ps, p1.pw],
    [p1.ps + a1 * p1.ds, gw],
    [p2.ps + a2 * p2.ds, gw],
    [p2.qs, p2.qw],
    [p2.qs + 18, 0],
    ...after(p2.qs + 18),
  ];
  const [bA, bB] = site.bridges;
  return [
    line('spine', 'The trench floor', 'spine', spine, 4.8, 'below', 'concrete', 1),
    line('left', 'The left service road', 'alt', roadPoints(site, poly, -1, -1, []), 4.8, 'ground', 'road', 1),
    line('right', 'The right service road', 'alt', roadPoints(site, poly, 1, 1, windowWeave(site)), 4.8, 'ground', 'road', 2),
    line('plaza', 'The plaza', 'alt', roadPoints(site, poly, -1, 1, [[-R - 10, -ROAD_MID], ...plaza, ...windowWeave(site, R)]), 4.8, 'deck', 'road', 2),
    line('gallery', 'The gallery', 'alt', gallery, 3.6, 'below', 'concrete', 3),
    line('bridges', 'The crossing bridges', 'alt', roadPoints(site, poly, -1, -1, [...bridgeCross(bA), ...bridgeCross(bB)]), 4.8, 'deck', 'road', 1),
  ];
}

/** The gallery's clear middle between its cable trays and its pipe racks (m from the axis). */
export function galleryMid(): number {
  const G = CFG.gallery;
  return (G.inner + 0.5 + G.outer - 0.8) / 2;
}

// ---------------------------------------------------------------------------
// Build

/** A travel-frame quad (four corners in order) as a world polygon. */
function quad(site: UgSite, pts: [number, number][]): Vec2[] {
  return pts.map(([s, w]) => toWorld(site, s, w));
}

/** A box centred at (s, w), its length turned `yaw` rad from +s toward +w, as a world polygon. */
function boxAt(site: UgSite, s: number, w: number, yaw: number, length: number, width: number): Vec2[] {
  const c = cos(yaw);
  const n = sin(yaw);
  return [
    [-length / 2, -width / 2],
    [length / 2, -width / 2],
    [length / 2, width / 2],
    [-length / 2, width / 2],
  ].map(([a, b]) => toWorld(site, s + a * c - b * n, w + a * n + b * c));
}

/** One edge of a plinth piece: its s at the floor face and at the back. */
interface Cut {
  s0: number;
  s1: number;
}
const square = (s: number): Cut => ({ s0: s, s1: s });

/** The area's walls, decks, surfaces, height modifier, props and the hints its renderer reads. */
function buildArea(_ctx: BuildContext, area: Area): AreaBuild {
  const b = emptyBuild();
  const r = regionOf(area);
  if (!area.params.planned || !r) return b;
  const site = undergroundSite(area);
  const id = area.id;
  const settle: Pending[] = [];
  pending.set(b, settle);
  const holder = { terrain: null as Terrain | null };
  terrains.set(b, holder);
  const rng = new Rng(deriveSeed(area.params.seed, 'underground:build'));
  const { top, R } = site;
  const poly = r.polygon;
  const G = CFG.gallery;
  const D = CFG.demolished;

  b.heightMods.push({ ...undergroundBox(site), add: (x, z, out) => undergroundHeight(site, x, z, out) });

  // ---- Ground. The region's firm base, the service roads' asphalt, the plaza's concrete, the floor's concrete, then the patches.
  regionGround(b, r, 'quay');
  regionFenceWalls(b, r, 'trenchWall', CFG.hoardingThick);
  const clip = (rect: Rect): Vec2[] => intersectConvex(poly, rectWorld(site, rect));
  const patch = (surface: Surface, polygon: Vec2[], priority: number) => {
    if (polygon.length >= 3) b.surfaces.push({ surface, polygon, priority, area: id });
  };
  for (const side of [1, -1]) {
    const w0 = side > 0 ? F : -ROAD_OUT;
    const w1 = side > 0 ? ROAD_OUT : -F;
    patch('road', clip({ s0: -site.half, s1: -R, w0, w1 }), 6);
    patch('road', clip({ s0: R, s1: site.half, w0, w1 }), 6);
  }
  patch('concrete', clip({ s0: -R, s1: R, w0: -2000, w1: 2000 }), 6);
  patch('concrete', rectWorld(site, { s0: -top, s1: top, w0: -F, w1: F }), 7);
  for (const c of site.windows) patch('offroad', rectWorld(site, { s0: c - D.half, s1: c + D.half, w0: F, w1: F + D.run }), 7);
  patch('slick', rectWorld(site, site.burst), 8);
  patch('slick', rectWorld(site, site.mud), 8);
  patch('slick', rectWorld(site, site.wet), 8);

  // Every deck is an `upper` span `rise` over the grade (the terrain less this site's profile, once settleUnderground hands over the terrain).
  const grade: HeightSample = { h: 0, gx: 0, gz: 0 };
  const deckAt = (rise: number) => (x: number, z: number, out: HeightSample) => {
    const t = holder.terrain;
    if (!t) {
      out.h = rise;
      out.gx = 0;
      out.gz = 0;
      return;
    }
    gradeAt(site, t, x, z, grade);
    out.h = grade.h + rise;
    out.gx = grade.gx;
    out.gz = grade.gz;
  };
  // The plinth's top in the open is a deck at the kerb's height: a car flying over the retaining wall reads a flat kerb under it
  // (it lands on it, or on the road beyond) instead of the steep climb from the floor that the terrain makes beneath the solid.
  const kerbDeck = (polygon: Vec2[]) => b.decks.push({ polygon, area: id, depth: CFG.depth, upper: deckAt(CFG.kerb) });

  // ---- Walls.
  const add = (walls: Wall[], kind: SettleKind | null, pts: Vec2[] = []) => {
    b.walls.push(...walls);
    if (kind) settle.push({ walls, kind, pts });
    return walls;
  };
  const solid = (pts: Vec2[], kind: SettleKind | null, gradePts: Vec2[] = []) => add(solidWalls(pts, 'trenchWall', id), kind, gradePts);

  // The plinths: pieces of at most 12 m between cuts, each a convex quad from the floor face back to its width.
  const piece = (side: number, kind: 0 | 1, a: Cut, z: Cut, width: number) => {
    const len = Math.max(z.s0 - a.s0, z.s1 - a.s1);
    if (len < 0.3) return;
    const n = Math.max(1, Math.ceil(len / 12));
    const wi = side * F;
    const wo = side * (F + width);
    for (let k = 0; k < n; k++) {
      const i0 = a.s0 + ((z.s0 - a.s0) * k) / n;
      const i1 = a.s0 + ((z.s0 - a.s0) * (k + 1)) / n;
      const o0 = a.s1 + ((z.s1 - a.s1) * k) / n;
      const o1 = a.s1 + ((z.s1 - a.s1) * (k + 1)) / n;
      const back = side * (F + width + 1);
      const body = quad(site, [[i0, wi], [i1, wi], [o1, wo], [o0, wo]]);
      solid(body, kind ? 'low' : 'kerb', [toWorld(site, o0, back), toWorld(site, (o0 + o1) / 2, back), toWorld(site, o1, back)]);
      if (!kind) kerbDeck(body);
      b.hints.push({ kind: UNDERGROUND_HINT.plinth, points: [], values: [kind, side, i0, o0, i1, o1, width] });
    }
  };
  // A bridge's parapet lines over a plinth (its outer faces): the plinth between them sits under the deck.
  const bridgeCuts = (br: (typeof site.bridges)[number], side: number, width: number): [Cut, Cut] => {
    const q = CFG.bridge.half + 0.3;
    const at = (qq: number): Cut => ({ s0: bridgeLineS(br, qq, side * F), s1: bridgeLineS(br, qq, side * (F + width)) });
    const c1 = at(-q);
    const c2 = at(q);
    return c1.s0 + c1.s1 < c2.s0 + c2.s1 ? [c1, c2] : [c2, c1];
  };
  // A passage's side lines through the right wall under the roof.
  const passageCuts = (ps: (typeof site.gallery.passages)[number], width: number): [Cut, Cut] => {
    const hp = G.passageHalf;
    const at = (q: number, w: number) => {
      const a = (w - ps.pw - q * ps.ds) / ps.dw;
      return ps.ps + a * ps.ds - q * ps.dw;
    };
    const c1 = { s0: at(hp, F), s1: at(hp, F + width) };
    const c2 = { s0: at(-hp, F), s1: at(-hp, F + width) };
    return c1.s0 + c1.s1 < c2.s0 + c2.s1 ? [c1, c2] : [c2, c1];
  };
  const P = CFG.plinth;
  const wallW = G.inner - F;
  const nose = CFG.nose;
  for (const side of [1, -1]) {
    // Noses at both ramp tops: a pointed piece so a car peeling off the flare glances off it.
    for (const end of [-1, 1]) {
      const tip = end * top;
      const base = end * (top - nose);
      const tri = quad(site, [[tip, side * (F + P / 2)], [base, side * F], [base, side * (F + P)]]);
      solid(tri, 'kerb', [toWorld(site, base, side * (F + P + 1))]);
      kerbDeck(tri);
      b.hints.push({ kind: UNDERGROUND_HINT.plinth, points: [], values: [0, side, tip, tip, base, base, P] });
    }
    const [bA, bB] = site.bridges;
    const [a1, a2] = bridgeCuts(bA, side, P);
    const [b1, b2] = bridgeCuts(bB, side, P);
    // Open section before the roof (the window on the right), the roof, the open section after it.
    if (side > 0) {
      const [w1, w2] = site.windows;
      piece(side, 0, square(-top + nose), square(w1 - D.half), P);
      piece(side, 0, square(w1 + D.half), a1, P);
      piece(side, 1, a1, a2, P);
      piece(side, 0, a2, square(-R), P);
      const [p1a, p1b] = passageCuts(site.gallery.passages[0], wallW);
      const [p2a, p2b] = passageCuts(site.gallery.passages[1], wallW);
      piece(side, 1, square(-R), p1a, wallW);
      piece(side, 1, p1b, p2a, wallW);
      piece(side, 1, p2b, square(R), wallW);
      piece(side, 0, square(R), b1, P);
      piece(side, 1, b1, b2, P);
      piece(side, 0, b2, square(w2 - D.half), P);
      piece(side, 0, square(w2 + D.half), square(top - nose), P);
    } else {
      piece(side, 0, square(-top + nose), a1, P);
      piece(side, 1, a1, a2, P);
      piece(side, 0, a2, square(-R), P);
      piece(side, 1, square(-R), square(R), P);
      piece(side, 0, square(R), b1, P);
      piece(side, 1, b1, b2, P);
      piece(side, 0, b2, square(top - nose), P);
    }
  }

  // The kickers' flanks: steel sides over the plates' bevels, in three pieces each rising with the heap, so a car beside a kicker
  // is turned away and a car on the plates stays on them. Each piece's top is the heap's crest at its far end plus a little.
  const K = CFG.kicker;
  for (const k of site.kickers) {
    const L = k.length + K.drop;
    const at = (a: number, bb: number): [number, number] => [k.footS + k.hs * a - k.hw * bb, k.footW + k.hw * a + k.hs * bb];
    const b0 = K.width / 2 - 0.1;
    const b1 = K.width / 2 + K.edge + 0.2;
    for (const sg of [1, -1]) {
      for (let j = 0; j < 3; j++) {
        const a0 = 0.5 + ((L - 0.5) * j) / 3;
        const a1 = 0.5 + ((L - 0.5) * (j + 1)) / 3;
        const crest = Math.min(a1, k.length);
        const [cs, cw] = at(crest, 0);
        solid(quad(site, [at(a0, sg * b0), at(a1, sg * b0), at(a1, sg * b1), at(a0, sg * b1)]), 'flank', [toWorld(site, cs, cw)]);
      }
    }
  }

  // The portals' headwalls across the trench, on the deck's ends.
  for (const end of [-1, 1]) {
    const s0 = end < 0 ? -R : R - 0.4;
    const rect = rectWorld(site, { s0, s1: s0 + 0.4, w0: -P_OUT, w1: P_OUT });
    solid(rect, 'headwall', [toWorld(site, s0, -P_OUT - 1), toWorld(site, s0, 0), toWorld(site, s0, P_OUT + 1)]);
  }
  // The roof openings: hoarding round three sides, the open end a bare slab edge.
  const T = 0.3;
  for (const o of site.openings) {
    const sides: [Rect, boolean][] = [
      [{ s0: o.s0 - T, s1: o.s0, w0: o.w0 - T, w1: o.w1 + T }, o.open === -1],
      [{ s0: o.s1, s1: o.s1 + T, w0: o.w0 - T, w1: o.w1 + T }, o.open === 1],
    ];
    const n = Math.max(1, Math.ceil((o.s1 - o.s0) / 10));
    for (let k = 0; k < n; k++) {
      const s0 = o.s0 + ((o.s1 - o.s0) * k) / n;
      const s1 = o.s0 + ((o.s1 - o.s0) * (k + 1)) / n;
      sides.push([{ s0, s1, w0: o.w0 - T, w1: o.w0 }, false], [{ s0, s1, w0: o.w1, w1: o.w1 + T }, false]);
    }
    for (const [rect, open] of sides) {
      const mid = toWorld(site, (rect.s0 + rect.s1) / 2, rect.w0 < 0 ? -P_OUT - 1 : P_OUT + 1);
      solid(rectWorld(site, rect), open ? 'slab' : 'hoard', [mid]);
    }
  }
  // The bridges' parapets, in three pieces each across the trench.
  for (const br of site.bridges) {
    const h = CFG.bridge.half;
    for (const [q0, q1] of [
      [h, h + 0.3],
      [-h - 0.3, -h],
    ]) {
      const ws = [-P_OUT, -P_OUT / 3, P_OUT / 3, P_OUT];
      for (let k = 0; k < 3; k++) {
        const wa = ws[k];
        const wb = ws[k + 1];
        const pts = quad(site, [[bridgeLineS(br, q0, wa), wa], [bridgeLineS(br, q0, wb), wb], [bridgeLineS(br, q1, wb), wb], [bridgeLineS(br, q1, wa), wa]]);
        const end = Math.abs(wa) > Math.abs(wb) ? wa : wb;
        solid(pts, 'parapet', [toWorld(site, bridgeLineS(br, q0, end + Math.sign(end)), end + Math.sign(end))]);
      }
    }
  }
  // The gallery: its outer wall, end walls, the pipe racks along the outer wall and the cable trays along the inner one.
  const g = site.gallery;
  const gwPts = (s0: number, s1: number) => [toWorld(site, s0, DECK_RIGHT + 1), toWorld(site, s1, DECK_RIGHT + 1)];
  {
    const s0 = g.s0 - G.wall;
    const s1 = g.s1 + G.wall;
    const n = Math.ceil((s1 - s0) / 12);
    for (let k = 0; k < n; k++) {
      const a = s0 + ((s1 - s0) * k) / n;
      const z = s0 + ((s1 - s0) * (k + 1)) / n;
      solid(rectWorld(site, { s0: a, s1: z, w0: G.outer, w1: G.outer + G.wall }), 'below', gwPts(a, z));
    }
    solid(rectWorld(site, { s0, s1: g.s0, w0: G.inner, w1: G.outer }), 'below', gwPts(s0, g.s0));
    solid(rectWorld(site, { s0: g.s1, s1, w0: G.inner, w1: G.outer }), 'below', gwPts(g.s1, s1));
    const f0 = g.down + G.ramp + 2;
    const f1 = g.up - 2;
    const m = Math.max(1, Math.ceil((f1 - f0) / 12));
    for (let k = 0; k < m; k++) {
      const a = f0 + ((f1 - f0) * k) / m;
      const z = f0 + ((f1 - f0) * (k + 1)) / m;
      solid(rectWorld(site, { s0: a, s1: z, w0: G.outer - 0.8, w1: G.outer }), 'below', gwPts(a, z));
      solid(rectWorld(site, { s0: a, s1: z, w0: G.inner, w1: G.inner + 0.5 }), 'below', gwPts(a, z));
      b.hints.push({ kind: UNDERGROUND_HINT.solid, points: [], values: [UG_SOLID.pipes, (a + z) / 2, G.outer - 0.4, 0, z - a, 0.8, 3.2] });
      b.hints.push({ kind: UNDERGROUND_HINT.solid, points: [], values: [UG_SOLID.trays, (a + z) / 2, G.inner + 0.25, 0, z - a, 0.5, 3.6] });
    }
  }

  // ---- Lines first, so the clutter keeps off them.
  const lines = undergroundLines(site, r);
  const lineSegs = lines.map((l) => ({ l, pts: l.path.slice(1, -1).map((p) => toTravel(site, p.x, p.z)) }));
  /** The level a line drives at a travel point: the profile below grade for the floor's lines, grade for the rest. */
  const sample = { h: 0, hs: 0, hw: 0 };
  const levelOf = (below: boolean, s: number, w: number) => (below ? profileAt(site, s, w, sample).h : 0);
  /** Does a circle at (s, w) of radius rad at level y come within a line's half width? */
  const onLine = (s: number, w: number, rad: number, y: number) =>
    lineSegs.some(({ l, pts }) => {
      const below = l.level === 'below';
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const c = pts[i + 1];
        const ls = c.s - a.s;
        const lw = c.w - a.w;
        const len2 = ls * ls + lw * lw || 1;
        const t = Math.max(0, Math.min(1, ((s - a.s) * ls + (w - a.w) * lw) / len2));
        const ps = a.s + ls * t;
        const pw = a.w + lw * t;
        if ((s - ps) ** 2 + (w - pw) ** 2 >= (rad + l.width / 2 + 0.2) ** 2) continue;
        if (Math.abs(levelOf(below, ps, pw) - y) < 3) return true;
      }
      return false;
    });
  const inside = (s: number, w: number, margin: number) => {
    const p = toWorld(site, s, w);
    return pointInPolygon(p.x, p.z, poly) && distToPolygonEdge(p.x, p.z, poly) > margin;
  };

  // ---- Box solids: the bus, the plant on the verges, the plaza's plant, the footbridges' abutments.
  const boxes: { s: number; w: number; yaw: number; length: number; width: number }[] = [];
  const box = (type: number, s: number, w: number, yaw: number, length: number, width: number, height: number) => {
    solid(boxAt(site, s, w, yaw, length, width), null);
    boxes.push({ s, w, yaw, length, width });
    b.hints.push({ kind: UNDERGROUND_HINT.solid, points: [], values: [type, s, w, yaw, length, width, height] });
  };
  const free = (s: number, w: number, rad: number) =>
    !boxes.some((q) => {
      const c = cos(q.yaw);
      const n = sin(q.yaw);
      const a = (s - q.s) * c + (w - q.w) * n;
      const bb = -(s - q.s) * n + (w - q.w) * c;
      return Math.abs(a) < q.length / 2 + rad && Math.abs(bb) < q.width / 2 + rad;
    });
  const B = CFG.bus;
  box(UG_SOLID.bus, site.bus.s, site.bus.w, 0, B.length, B.width, B.height);

  // Landing stretches the plant keeps off: each side kicker's throw from the least speed that clears the kerb to well past the aim.
  const landing = site.kickers
    .filter((k) => k.id !== 'plaza')
    .map((k) => ({ side: k.side, s0: kickerFlight(k, K.clearSpeed).s - 8, s1: kickerFlight(k, K.aimSpeed + 8).s + 8 }));
  // Every landing spot from the least speed that makes it up to well past the aim: no clutter there either.
  const throws: { s: number; w: number }[] = [];
  for (const k of site.kickers) for (let v = k.id === 'plaza' ? K.deckSpeed : K.clearSpeed; v <= K.aimSpeed + 8; v += 0.5) throws.push(kickerFlight(k, v));
  const reach = bridgeReach();
  const W = CFG.works;
  for (const side of [1, -1]) {
    const v = side * (ROAD_OUT + CFG.verge / 2);
    for (const [lo, hi] of [
      [-top + 6, -R - 6],
      [R + 6, top - 6],
    ]) {
      for (let s = lo + rng.range(0, 8); s <= hi - W.length / 2; s += W.length + W.gap + rng.range(-6, 8)) {
        const type = rng.int(0, 2);
        const yaw = rng.range(-0.03, 0.03);
        if (landing.some((l) => l.side === side && s > l.s0 - W.length && s < l.s1 + W.length)) continue;
        if (side > 0 && site.windows.some((c) => Math.abs(s - c) < D.half + W.length + 4)) continue;
        if (site.bridges.some((br) => Math.abs(s - br.s) < reach + W.length)) continue;
        if (side < 0 && s > site.heap.s0 - W.length - 4 && s < site.heap.s1 + W.length + 4) continue;
        if (!inside(s, v, 3) || onLine(s, v, W.width / 2 + 0.6, 0)) continue;
        box([UG_SOLID.truck, UG_SOLID.digger, UG_SOLID.lightTower][type], s, v, yaw, W.length, W.width, W.height);
      }
    }
  }
  // The spoil heap at the mud.
  {
    const h = site.heap;
    box(UG_SOLID.heap, (h.s0 + h.s1) / 2, (h.w0 + h.w1) / 2, 0, h.s1 - h.s0, h.w1 - h.w0, 2.4);
  }
  // The plaza's plant, in loose rows either side of the deck, every piece inside the region and off every line.
  const PL = CFG.plaza;
  const kinds: [number, readonly number[]][] = [
    [UG_SOLID.cabin, PL.cabin],
    [UG_SOLID.stack, PL.stack],
    [UG_SOLID.mat, PL.mat],
    [UG_SOLID.cabin, PL.cabin],
    [UG_SOLID.stack, PL.stack],
  ];
  // Light masts first, in two rows a side: the plaza is lit like a site at night, pools of white between the plant.
  for (const side of [1, -1]) {
    for (const off of [3, 40]) {
      for (let s = -R + 12; s < R - 6; s += PL.mastStep) {
        const w = side * (VERGE_OUT + off);
        if (!inside(s, w, 4) || onLine(s, w, 1, 0)) continue;
        box(UG_SOLID.mast, s, w, 0, PL.mast[0], PL.mast[1], PL.mast[2]);
      }
    }
  }
  let craned = 0;
  for (const side of [1, -1]) {
    for (let row = 0; row < 7; row++) {
      const w0 = side * (VERGE_OUT + 7 + row * 12 + rng.range(-1.5, 1.5));
      for (let s = -R + 8 + rng.range(0, 8); s < R - 8; s += 14 + rng.range(0, 10)) {
        const crane = !craned && side < 0 && row === 1 && s > -R / 3;
        const [type, dims] = crane ? [UG_SOLID.crane, PL.crane] : kinds[rng.int(0, kinds.length - 1)];
        const yaw = rng.chance(0.5) ? 0 : Math.PI / 2;
        const w = w0 + rng.range(-2, 2);
        const rad = Math.max(dims[0], dims[1]) / 2 + 1;
        if (!inside(s, w, rad + 3) || !free(s, w, rad + 2) || onLine(s, w, rad, 0)) continue;
        if (crane) craned = 1;
        box(type, s, w, yaw, dims[0], dims[1], dims[2]);
      }
    }
  }
  // The footbridges' abutments, behind the hoarding of each open section.
  const FB = CFG.footbridge;
  for (const s of footbridges(site)) {
    for (const side of [1, -1]) box(UG_SOLID.abutment, s, side * (VERGE_OUT + 1.5), 0, FB.abut, FB.abut, FB.clear);
  }

  // ---- The hoardings closing the works yards off: along the verges of the open sections and the ramps, diagonally to the ring at
  // each end, and across to the ring at each end of the plaza. Thin solids (both sides drivable or not, nothing is shoved through).
  const HT = CFG.hoardingThick;
  const hoardLine = (a: [number, number], z: [number, number]) => {
    const len = Math.hypot(z[0] - a[0], z[1] - a[1]);
    if (len < 0.5) return;
    const n = Math.max(1, Math.ceil(len / 8));
    const ns = -(z[1] - a[1]) / len;
    const nw = (z[0] - a[0]) / len;
    for (let k = 0; k < n; k++) {
      const p0: [number, number] = [a[0] + ((z[0] - a[0]) * k) / n, a[1] + ((z[1] - a[1]) * k) / n];
      const p1: [number, number] = [a[0] + ((z[0] - a[0]) * (k + 1)) / n, a[1] + ((z[1] - a[1]) * (k + 1)) / n];
      solid(quad(site, [p0, p1, [p1[0] + ns * HT, p1[1] + nw * HT], [p0[0] + ns * HT, p0[1] + nw * HT]]), null);
    }
  };
  for (const run of yardHoardings(site, poly)) for (let i = 0; i + 1 < run.length; i++) hoardLine(run[i], run[i + 1]);

  // ---- Decks: the roof's slab rectangles and the two bridges, `upper` spans over the trench and the gallery.
  for (const rect of site.decks) b.decks.push({ polygon: rectWorld(site, rect), area: id, depth: CFG.depth, upper: deckAt(0) } as DeckSpan);
  for (const br of site.bridges) b.decks.push({ polygon: bridgeDeck(br).map((p) => toWorld(site, p.s, p.w)), area: id, depth: CFG.depth, upper: deckAt(CFG.bridge.rise) });
  b.openings.push(...b.decks.map((d) => d.polygon));

  // ---- Destructibles, every one off the lines.
  const out: DistrictPropSpec[] = [];
  const put = (kind: DistrictPropSpec['kind'], s: number, w: number, yaw: number, y = 0) => {
    const rad = kind === 'fencePanel' ? 0.85 : kind === 'waterBarrier' ? 0.9 : kind === 'sawhorse' ? 0.7 : 0.6;
    if (!free(s, w, rad) || onLine(s, w, rad, y) || !inside(s, w, 1)) return;
    if (y === 0 && throws.some((q) => (q.s - s) ** 2 + (q.w - w) ** 2 < (rad + 3) ** 2)) return;
    const p = toWorld(site, s, w);
    // On the roof the terrain is the trench beneath: lift the piece onto the deck.
    const onDeck = y === 0 && site.decks.some((d) => s > d.s0 && s < d.s1 && w > d.w0 && w < d.w1);
    out.push({ kind, x: p.x, z: p.z, yaw: site.dir < 0 ? yaw + Math.PI : yaw, lift: onDeck ? -profileAt(site, s, w, sample).h : 0, area: id });
  };
  const across = 0;
  const floor = -CFG.depth;
  // The bus: barrels at both ends, cones tapering in ahead of it, sandbags behind.
  const busEnd = B.length / 2;
  for (const end of [-1, 1]) {
    put('barrel', site.bus.s + end * (busEnd + 1.6), site.bus.w - 0.8, rng.range(-3, 3), floor);
    put('barrel', site.bus.s + end * (busEnd + 1.8), site.bus.w + 0.7, rng.range(-3, 3), floor);
  }
  for (let k = 0; k < 6; k++) put('trafficCone', site.bus.s - busEnd - 4 - 3 * (5 - k), site.bus.w - 1.2 + (1.2 * k) / 5, 0, floor);
  put('sandbags', site.bus.s + busEnd + 4, F - 0.6, 0, floor);
  // Sandbags along the walls at the burst main, where the water comes out.
  for (let s = site.burst.s0 + 2; s < site.burst.s1; s += 4.5) for (const side of [1, -1]) put('sandbags', s, side * (F - 0.55), 0, floor);
  // The windows: plywood panels along the lip with a gap, sandbags at the gap's jambs, sawhorses at the ends.
  for (const c of site.windows) {
    const lip = F + D.run + D.panelBack;
    const gapAt = c + rng.range(-6, 6);
    for (let s = c - D.half + 1; s <= c + D.half - 1 + 1e-6; s += D.panelStep) {
      if (Math.abs(s - gapAt) < D.gap / 2) continue;
      put('fencePanel', s, lip, across);
    }
    put('sandbags', gapAt - D.gap / 2 - 0.3, lip + 0.2, 0);
    put('sandbags', gapAt + D.gap / 2 + 0.3, lip + 0.2, 0);
    put('sawhorse', c - D.half - 1.5, lip - 0.4, across);
    put('sawhorse', c + D.half + 1.5, lip - 0.4, across);
  }
  // Clutter along both roads' outer edges (pallets, sandbags, barriers, drums) and cones along their inner edges.
  const clutter = ['pallets', 'sandbags', 'waterBarrier', 'barrel', 'pallets', 'drum'] as const;
  for (const side of [1, -1]) {
    for (let s = -top + 10; s < top - 10; s += rng.range(7, 13)) {
      if (Math.abs(s) < R + 2) continue;
      put(clutter[rng.int(0, clutter.length - 1)], s, side * (ROAD_OUT + 0.4), rng.range(-3, 3));
      if (rng.chance(0.45)) put('trafficCone', s + rng.range(-2, 2), side * (P_OUT + 0.45), 0);
    }
  }
  // Cones round the spoil heap, cones at each bridge's mouths.
  for (let s = site.heap.s0 - 1; s <= site.heap.s1 + 1; s += 2.2) put('trafficCone', s, site.heap.w1 + 0.4, 0);
  const q = CFG.bridge.half + 0.9;
  for (const br of site.bridges) for (const side of [1, -1]) for (const qq of [q, -q]) put('trafficCone', bridgeLineS(br, qq, side * (P_OUT + 0.5)), side * (P_OUT + 0.5), 0);
  // The plaza: pallets, drums and spools round the plant.
  for (const bx of boxes.slice()) {
    if (Math.abs(bx.s) > R || Math.abs(bx.w) < VERGE_OUT) continue;
    for (let k = 0; k < 2; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.max(bx.length, bx.width) / 2 + 1.6;
      put((['pallets', 'drum', 'cableSpool', 'crate', 'barrel'] as const)[rng.int(0, 4)], bx.s + cos(a) * d, bx.w + sin(a) * d, rng.range(-3, 3));
    }
  }
  // Cones across the drop opening's open end, set back so a car threads them, and drums in the gallery's end bays.
  const oD = site.openings[1];
  for (const w of [oD.w0 + 0.6, oD.w1 - 0.6]) put('trafficCone', oD.s0 - 2.5, w, 0);
  for (const s of [g.s0 + 1.5, g.s1 - 1.5]) for (const w of [G.inner + 1, G.outer - 1]) put('drum', s, w, 0, floor);
  b.destructibles.push(...out);

  return b;
}

/** Where the footbridges stand (s): mid-way down each open section between its bridge and the portal. */
export function footbridges(site: UgSite): number[] {
  const reach = bridgeReach();
  const a = site.bridges[0].s + reach;
  const b = site.bridges[1].s + reach;
  return [(a + Math.max(a + 30, site.kickers[0].lipS + 30) + -site.R) / 3, (b + site.fh) / 2 + 6];
}

/** The yards' hoardings as travel-frame polylines: for each side, ring -> verge -> plaza end -> ring, both ends of the trench. */
export function yardHoardings(site: UgSite, poly: readonly Vec2[]): [number, number][][] {
  const out: [number, number][][] = [];
  const mouth = 12.5;
  for (const side of [1, -1]) {
    for (const end of [-1, 1]) {
      const ring = ringEnd(site, poly, end, side * mouth);
      const sR = end * site.R;
      const out1 = ringReach(site, poly, sR, side * VERGE_OUT, 0, side);
      out.push([
        [ring - end * 0.5, side * mouth],
        [end * site.top, side * VERGE_OUT],
        [sR, side * VERGE_OUT],
        [sR, side * (VERGE_OUT + Math.max(0, out1 - 0.5))],
      ]);
    }
  }
  return out;
}

/**
 * Heights of the walls where the levels stack, once the terrain exists (world.ts createCity), and the decks' terrain:
 * the plinth's top the kerb over grade in the open (a car flying above it passes over, a car on either level stops), a
 * metre under grade beneath a deck; the opening hoardings', the headwalls' and the parapets' bottom a band under the deck
 * (a car in the trench passes beneath) and their top over it (a thrown car clears them); an opening's open end only the
 * slab's edge; the gallery's walls a metre under grade. A solid's faces share one top and one bottom.
 */
export function settleUnderground(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  for (const area of areas) {
    if (area.kind !== 'underground' || !area.params.planned) continue;
    const bd = builds[area.id];
    const holder = terrains.get(bd);
    if (holder) holder.terrain = terrain;
    const site = undergroundSite(area);
    const g: HeightSample = { h: 0, gx: 0, gz: 0 };
    const gradeOf = (p: Vec2) => gradeAt(site, terrain, p.x, p.z, g).h;
    const RF = CFG.roof;
    for (const p of pending.get(bd) ?? []) {
      const gs = p.pts.map(gradeOf);
      const lo = Math.min(...gs);
      const hi = Math.max(...gs);
      let top: number | undefined;
      let bottom: number | undefined;
      switch (p.kind) {
        case 'kerb':
          // A shade under the kerb deck, so a car resting on the plinth's top is on it, not in it.
          top = hi + CFG.kerb - 0.05;
          break;
        case 'flank':
          top = Math.max(...p.pts.map((q) => terrain.heightAt(q.x, q.z))) + 0.4;
          break;
        case 'low':
        case 'below':
          top = lo - 1;
          break;
        case 'slab':
          top = lo - 0.05;
          bottom = lo - RF.under;
          break;
        case 'hoard':
          top = hi + RF.hoarding;
          bottom = lo - RF.under;
          break;
        case 'headwall':
          top = hi + RF.parapet;
          bottom = lo - RF.under;
          break;
        case 'parapet':
          top = hi + CFG.bridge.rise + CFG.bridge.parapet;
          bottom = lo + CFG.bridge.rise - RF.under;
          break;
      }
      for (const w of p.walls) {
        if (top !== undefined) w.top = top;
        if (bottom !== undefined) w.bottom = bottom;
      }
    }
  }
}

/**
 * The racing line's closures on the trench floor (sim/ai/racingLine.ts, the roadworks' shape): the kickers' bevels and
 * the bus, each kept clear by the car's half width plus CFG.aiClear over the stretch and CFG.aiLead either side, so the
 * rivals' shared line runs down the free side of the floor. Empty on every seed without a planned Underground.
 */
export function undergroundClosures(areas: readonly Area[]): LaneClosure[] {
  const out: LaneClosure[] = [];
  for (const a of areas) {
    if (a.kind !== 'underground' || !a.params.planned || !a.params.roof) continue;
    const site = undergroundSite(a);
    const o = toWorld(site, 0, 0);
    const d = worldDir(site, 1, 0);
    const n = worldDir(site, 0, 1);
    for (const [s0, s1, side, inner] of floorClosures(site)) {
      out.push({ ax: o.x, az: o.z, dx: d.x, dz: d.z, nx: n.x * side, nz: n.z * side, s0: s0 - CFG.aiLead, s1: s1 + CFG.aiLead, keep: inner - 1.05 - CFG.aiClear, half: F });
    }
  }
  return out;
}

export type { UgSite };
