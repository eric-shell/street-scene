/**
 * Plaza dressing: what turns an infill plaza or corner pocket, and the monument plaza, from a
 * paved patch with clutter into a place people use at night. A centrepiece (the infill's own
 * fountain, or a statue on its plinth, a clock column or a kiosk: small convex solids with wall
 * look 'plaza', drawn by render/districts/plazaDressing.ts), a ring of lanterns round it, a row of
 * solid trees along the back and sides (the street trees' trunk, wall look 'tree'), benches facing
 * the middle, planter pots between them, bollards a car's width apart along the open frontage, a
 * food cart and news boxes in the corners; and hints for the renderer (festoon strands between the
 * lanterns, a spot where people stand round the centrepiece). Everything is placed in that order
 * from a stream of its own (`deriveSeed(seed, 'plazas')` per area), each piece skipped where it
 * would crowd one placed before it (`Taken`), and every roll is drawn before its test so a rejected
 * piece never shifts the stream. The infill's own clutter and lanterns are placed after and give way
 * to these (infill.ts passes `taken` on).
 *
 * Sizes decide what a pocket gets (PLAZA in config.ts): a tiny corner one tree, a small pocket the
 * rows, a roomy one a centrepiece, a large one the lantern ring, strings, bollards and a cart. A
 * corner pocket at an alley's mouth (Area.params.mouth: a racer cuts across it into the alley) gets
 * nothing: no solid, no post. The monument plaza (`dressMonument`) gets a row of trees midway
 * between its edge lanterns, kept a car's width off every race pass, strands of festoon lights and
 * bunting between the lanterns, and spots where people gather round the landmark. Pure: Rng only.
 */
import { CITY, PLAZA, STREET_TREES } from '../config';
import { Rng, deriveSeed } from '../../sim/prng';
import { Vec2, atan2, clamp, cos, sin, sqrt } from '../../sim/math';
import type { PropKind } from '../props';
import { PROP_DEFS } from '../props';
import type { Area, AreaBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polygonArea, polygonCentroid, solidWalls } from './geom';

/** The centrepiece kinds a plaza can stand on (AreaProp kinds): the infill's fountain and the three new pieces. */
export const CENTRE_KINDS = ['fountain', 'statue', 'clock', 'kiosk'] as const;
export type CentreKind = (typeof CENTRE_KINDS)[number];

/** A lantern post the plaza's lamps() placed (or will place): its spot and facing. */
export interface PlazaLamp {
  x: number;
  z: number;
  yaw: number;
}

/** Round footprints already standing in a plaza: what each new piece keeps clear of. */
export class Taken {
  private readonly c: { x: number; z: number; r: number }[] = [];

  add(x: number, z: number, r: number): void {
    this.c.push({ x, z, r });
  }

  /** Is a circle of radius r at (x, z) at least `gap` m from every one? */
  free(x: number, z: number, r: number, gap = 0.3): boolean {
    for (const q of this.c) if ((q.x - x) ** 2 + (q.z - z) ** 2 < (q.r + r + gap) ** 2) return false;
    return true;
  }
}

/** A station along a side of the pocket, pulled in from it: where a piece stands and the inward normal there. */
interface Spot {
  x: number;
  z: number;
  nx: number;
  nz: number;
  side: number;
  /** Side length (m). */
  len: number;
}

/**
 * Stations along some sides of a polygon, `inset` m in from each, about `spacing` apart and `endClear` from its
 * ends. 'cells' puts one at the middle of each of n equal cells, 'between' at the n cell boundaries
 * (so a second row falls between the first's).
 */
function sideRun(poly: Vec2[], sides: number[], inset: number, spacing: number, endClear: number, mode: 'cells' | 'between'): Spot[] {
  const c = polygonCentroid(poly);
  const out: Spot[] = [];
  for (const i of sides) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    const span = len - 2 * endClear;
    if (span < 0.5) continue;
    const ux = (q.x - p.x) / len;
    const uz = (q.z - p.z) / len;
    let nx = -uz;
    let nz = ux;
    if ((c.x - p.x) * nx + (c.z - p.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const n = Math.max(1, Math.round(span / spacing));
    for (let k = 0; k < n; k++) {
      const s = endClear + (mode === 'cells' ? (span * (k + 0.5)) / n : (span * (k + 1)) / (n + 1));
      out.push({ x: p.x + ux * s + nx * inset, z: p.z + uz * s + nz * inset, nx, nz, side: i, len });
    }
  }
  return out;
}

/** A pocket's local frame as infill.ts stores it (origin, axes u along the street and w into the block, lengths). */
interface Frame {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  wx: number;
  wz: number;
  lu: number;
  lw: number;
}

const frameOf = (P: Record<string, number>): Frame => ({ ox: P.ox, oz: P.oz, ux: P.ux, uz: P.uz, wx: P.wx, wz: P.wz, lu: P.lu, lw: P.lw });

/** The kind drawn from the weights table by a roll in [0, 1). */
function pickCentre(roll: number): CentreKind {
  let total = 0;
  for (const k of CENTRE_KINDS) total += PLAZA.centre.kinds[k];
  let r = roll * total;
  for (const k of CENTRE_KINDS) {
    r -= PLAZA.centre.kinds[k];
    if (r <= 0) return k;
  }
  return 'fountain';
}

/** The solid radius and height of a centrepiece kind that is not the fountain. */
export function centreSize(kind: Exclude<CentreKind, 'fountain'>): { radius: number; height: number } {
  return PLAZA.centre[kind];
}

/** What dressPlaza leaves for the lamps and clutter that follow it. */
export interface PlazaDressed {
  /** Everything standing, for the infill's own lamps and clutter to keep off. */
  taken: Taken;
}

/** The pieces a tree, a gather spot or a strand hint stand for, as the renderer reads them (AreaBuild.hints). */
export const PLAZA_HINT = { strand: 'strand', gather: 'gather' } as const;

/** A tree of the plaza: a solid trunk (look 'tree') and the prop the renderer grows it from. */
function plantTree(b: AreaBuild, id: number, rng: Rng, x: number, z: number): void {
  const T = STREET_TREES;
  b.walls.push(...solidWalls(circlePolygon(x, z, T.trunkRadius, T.trunkSides), 'tree', id));
  b.props.push({ kind: 'tree', x, z, yaw: rng.range(0, 6.28), size: rng.range(PLAZA.tree.size[0], PLAZA.tree.size[1]), height: rng.range(PLAZA.tree.height[0], PLAZA.tree.height[1]), area: id });
}

/**
 * Dress one infill plaza or corner pocket (infill.ts build, before its own lamps and clutter), pushing
 * into the build `b`. `lamps` are the lantern posts lampSpots found for it, which the dressing keeps
 * clear of and strings between. Returns null for a pocket that takes nothing (too small, an alley's
 * mouth); the lamps and clutter then go ahead as they were.
 */
export function dressPlaza(b: AreaBuild, area: Area, seed: number, lamps: readonly PlazaLamp[]): PlazaDressed | null {
  const P = area.params;
  if (!PLAZA.enabled || P.lu === undefined || P.mouth) return null;
  const minDim = Math.min(P.lu, P.lw);
  const F = frameOf(P);
  const poly = area.polygon;
  const id = area.id;
  const fs = P.frontSides;
  const lift = CITY.curbHeight;
  const rng = new Rng(deriveSeed(deriveSeed(seed, 'plazas'), `a${id}`));
  const taken = new Taken();
  for (const l of lamps) taken.add(l.x, l.z, PROP_DEFS.parkLamp.radius + 0.4);
  const back: number[] = [];
  for (let i = fs; i < poly.length; i++) back.push(i);
  const front: number[] = [];
  for (let i = 0; i < fs; i++) front.push(i);
  const inside = (x: number, z: number, r: number): boolean => pointInPolygon(x, z, poly) && distToPolygonEdge(x, z, poly) > r + PLAZA.edgeClear;
  const put = (kind: PropKind, x: number, z: number, yaw: number): void => {
    b.destructibles.push({ kind, x, z, yaw, lift, area: id });
    taken.add(x, z, PROP_DEFS[kind].radius);
  };
  const theme = P.theme;
  // Theme order is infill.ts INFILL_THEMES: cafe 0, garden 1, market 2.
  const garden = theme === 1;
  const market = theme === 2;
  const roll = { centre: rng.next(), kind: rng.next(), cart: rng.next(), news: rng.next() };

  // ---- Centrepiece: the infill's fountain, or one of ours on a roomy pocket's middle ----
  let cx = P.fx;
  let cz = P.fz;
  let centre: CentreKind | null = null;
  let cr = 0;
  if (P.fountain > 0) {
    centre = 'fountain';
    cr = P.fountain;
  } else if (minDim >= PLAZA.minCentre && roll.centre < PLAZA.centre.chance) {
    const kind = pickCentre(roll.kind);
    const r = kind === 'fountain' ? clamp(minDim * PLAZA.centre.fountain.share, PLAZA.centre.fountain.min, PLAZA.centre.fountain.max) : centreSize(kind).radius;
    // A car passes either side: the middle must stand this far from every side.
    if (distToPolygonEdge(cx, cz, poly) >= r + PLAZA.centre.gap + 1 && pointInPolygon(cx, cz, poly)) {
      centre = kind;
      cr = r;
      if (kind === 'fountain') {
        b.walls.push(...solidWalls(circlePolygon(cx, cz, r, 12), 'fountain', id));
        b.props.push({ kind: 'fountain', x: cx, z: cz, yaw: 0, size: r, height: 0.8, area: id });
      } else {
        // Facing the open frontage, so a racer sees its front.
        b.walls.push(...solidWalls(circlePolygon(cx, cz, r, 8, Math.PI / 8), 'plaza', id));
        b.props.push({ kind, x: cx, z: cz, yaw: atan2(-F.wx, -F.wz), size: r, height: centreSize(kind).height, area: id });
      }
    }
  }
  if (centre) taken.add(cx, cz, cr + PLAZA.centre.gap);

  // ---- Trees along the back and sides ----
  const T = PLAZA.tree;
  const treeR = STREET_TREES.trunkRadius;
  const trees: Vec2[] = [];
  const treeOk = (x: number, z: number): boolean => inside(x, z, treeR + 0.6) && taken.free(x, z, treeR, T.clear) && trees.every((q) => (q.x - x) ** 2 + (q.z - z) ** 2 >= T.gap * T.gap);
  if (minDim >= PLAZA.minRows) {
    for (const s of sideRun(poly, back, T.inset, garden ? T.spacing * 0.8 : T.spacing, T.endClear, 'cells')) {
      const jit = rng.range(-0.5, 0.5);
      const keep = rng.chance(market ? 0.55 : 0.9);
      const x = s.x - s.nz * jit;
      const z = s.z + s.nx * jit;
      if (!keep || !treeOk(x, z)) continue;
      plantTree(b, id, rng, x, z);
      taken.add(x, z, treeR + 0.1);
      trees.push({ x, z });
    }
  } else if (minDim >= PLAZA.minTree) {
    // A tiny pocket: one tree at the middle of its longest back side.
    const run = sideRun(poly, back, T.inset - 0.4, 1e3, 1, 'cells').sort((p, q) => q.len - p.len);
    const keep = rng.chance(0.7);
    const s = run[0];
    if (keep && s && treeOk(s.x, s.z)) {
      plantTree(b, id, rng, s.x, s.z);
      taken.add(s.x, s.z, treeR + 0.1);
      trees.push({ x: s.x, z: s.z });
    }
  }
  // ---- The lantern ring round a large plaza's centrepiece, on its diagonals (after the trees, which it gives way to) ----
  const ring: PlazaLamp[] = [];
  if (centre && minDim >= PLAZA.minLarge) {
    const d = (cr + PLAZA.ring.offset) * 0.7071;
    for (const [su, sw] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
      const x = cx + (F.ux * su + F.wx * sw) * d;
      const z = cz + (F.uz * su + F.wz * sw) * d;
      if (!inside(x, z, PROP_DEFS.parkLamp.radius + 0.8) || !taken.free(x, z, PROP_DEFS.parkLamp.radius, 0.8)) continue;
      const l = { x, z, yaw: atan2(cx - x, cz - z) };
      b.destructibles.push({ kind: 'parkLamp', x, z, yaw: l.yaw, lift, area: id });
      taken.add(x, z, PROP_DEFS.parkLamp.radius + 0.3);
      ring.push(l);
    }
  }

  if (minDim < PLAZA.minRows) return { taken };

  // ---- Benches facing the middle, a bin beside some ----
  const B = PLAZA.bench;
  const benchR = PROP_DEFS.bench.radius;
  let benches = 0;
  for (const s of sideRun(poly, back, B.inset, B.spacing, B.endClear, 'between')) {
    const jit = rng.range(-0.4, 0.4);
    const bin = rng.chance(B.bin);
    const x = s.x - s.nz * jit;
    const z = s.z + s.nx * jit;
    if (benches >= 7 || !inside(x, z, benchR) || !taken.free(x, z, benchR, 0.5)) continue;
    const yaw = atan2(s.nx, s.nz);
    put('bench', x, z, yaw);
    benches++;
    const bx = x + cos(yaw) * 1.6;
    const bz = z - sin(yaw) * 1.6;
    if (bin && inside(bx, bz, PROP_DEFS.garbageCan.radius) && taken.free(bx, bz, PROP_DEFS.garbageCan.radius, 0.2)) put('garbageCan', bx, bz, yaw);
  }

  // ---- Planter pots in a row along the back, between whatever stands there ----
  const L = PLAZA.planter;
  const potR = PROP_DEFS.planterPot.radius;
  let pots = 0;
  for (const s of sideRun(poly, back, L.inset, L.spacing, L.endClear, 'cells')) {
    const keep = rng.chance(garden ? 0.9 : 0.7);
    if (!keep || pots >= 16 || !inside(s.x, s.z, potR) || !taken.free(s.x, s.z, potR, 0.35)) continue;
    put('planterPot', s.x, s.z, atan2(s.nx, s.nz));
    pots++;
  }

  if (minDim < PLAZA.minLarge) {
    cornerBoxes(area, taken, roll.news, put, back, inside);
    return { taken };
  }

  // ---- Bollards along the open frontage: a car's width apart or more ----
  const O = PLAZA.bollard;
  for (const i of front) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) < O.minLen) continue;
    for (const s of sideRun(poly, [i], O.inset, O.spacing, O.endClear, 'cells')) {
      const r = PROP_DEFS.bollard.radius;
      if (inside(s.x, s.z, r) && taken.free(s.x, s.z, r, 0.3)) put('bollard', s.x, s.z, atan2(s.nx, s.nz));
    }
  }

  // ---- A food cart at the back of a cafe or market plaza ----
  if (!garden && roll.cart < PLAZA.cart.chance) {
    const longest = sideRun(poly, back, PLAZA.cart.inset, 1e3, 1, 'cells').sort((p, q) => q.len - p.len)[0];
    const r = PROP_DEFS.foodCart.radius;
    if (longest && inside(longest.x, longest.z, r) && taken.free(longest.x, longest.z, r, 0.8)) put('foodCart', longest.x, longest.z, atan2(longest.nx, longest.nz) + Math.PI / 2);
  }
  cornerBoxes(area, taken, roll.news, put, back, inside);

  // ---- The people at the centrepiece, and the festoon strands between the lanterns ----
  if (centre) {
    const gx = cx + F.wx * -(cr + PLAZA.gather.offset);
    const gz = cz + F.wz * -(cr + PLAZA.gather.offset);
    b.hints.push({ kind: PLAZA_HINT.gather, points: [{ x: gx, z: gz }], values: [rng.int(PLAZA.gather.people[0], PLAZA.gather.people[1]), 0.9] });
  }
  if (Math.abs(polygonArea(poly)) >= PLAZA.stringArea) {
    for (const [p, q] of strandPairs([...lamps], ring)) b.hints.push({ kind: PLAZA_HINT.strand, points: [p, q], values: [0] });
  }
  return { taken };
}

/** News boxes in the back corners of a roomy pocket (the boxes the theme scatters never reach them). */
function cornerBoxes(area: Area, taken: Taken, roll: number, put: (kind: PropKind, x: number, z: number, yaw: number) => void, back: number[], inside: (x: number, z: number, r: number) => boolean): void {
  if (roll > 0.75) return;
  const poly = area.polygon;
  const c = polygonCentroid(poly);
  for (const i of back) {
    // A vertex between two back sides.
    if (i === back[0]) continue;
    const v = poly[i];
    const dx = c.x - v.x;
    const dz = c.z - v.z;
    const l = sqrt(dx * dx + dz * dz) || 1;
    const x = v.x + (dx / l) * PLAZA.newsBox.inset * 1.5;
    const z = v.z + (dz / l) * PLAZA.newsBox.inset * 1.5;
    const r = PROP_DEFS.newsBox.radius;
    if (inside(x, z, r) && taken.free(x, z, r, 0.3)) put('newsBox', x, z, atan2(dx, dz));
  }
}

/**
 * The strands of a plaza as lantern pairs: the ring's lanterns round (each to the next), each ring lantern to the
 * nearest back lantern within the span, and the back lanterns to each other. At most eight, ring first.
 */
export function strandPairs(back: readonly PlazaLamp[], ring: readonly PlazaLamp[]): [PlazaLamp, PlazaLamp][] {
  const [lo, hi] = PLAZA.strand.span;
  const span = (p: PlazaLamp, q: PlazaLamp): number => sqrt((p.x - q.x) ** 2 + (p.z - q.z) ** 2);
  const ok = (p: PlazaLamp, q: PlazaLamp): boolean => {
    const d = span(p, q);
    return d >= lo && d <= hi;
  };
  const out: [PlazaLamp, PlazaLamp][] = [];
  for (let i = 0; i < ring.length; i++) {
    const q = ring[(i + 1) % ring.length];
    if (ring.length > 2 && ok(ring[i], q)) out.push([ring[i], q]);
  }
  for (const r of ring) {
    let best: PlazaLamp | null = null;
    for (const l of back) if (ok(r, l) && (!best || span(r, l) < span(r, best))) best = l;
    if (best) out.push([r, best]);
  }
  if (back.length === 2 && ok(back[0], back[1])) out.push([back[0], back[1]]);
  return out.slice(0, 8);
}

/** What dressMonument reads of the plaza the monument module has just laid out. */
export interface MonumentSite {
  /** Landmark middle, the steps' (or piers') clear radius and the plaza outline. */
  c: Vec2;
  clearR: number;
  ring: Vec2[];
  yaw: number;
  /** Within `r` m of a race pass's line (monument.ts inLane). */
  inLane(p: Vec2, r: number): boolean;
  /** Inside the plaza by more than `margin` m. */
  inside(p: Vec2, margin: number): boolean;
  /** The lantern posts of each side in order along it (monument.ts), for the strands. */
  sides: PlazaLamp[][];
  /** Arch only: the landmark's opening is along this yaw (rad) so gather spots stay off it. */
  arch: boolean;
}

/**
 * The monument plaza's share: a tree midway between each side's lanterns (the posts stand 2.4 m in, the trees
 * further, so the canopy leans over the posts), strands of festoon lights and bunting between neighbouring
 * posts, and a few spots round the landmark where people stand. Trees keep a car's width off every race pass
 * and clear of whatever is already standing (benches, pots, beds' bushes, the cafe).
 */
export function dressMonument(b: AreaBuild, area: Area, seed: number, site: MonumentSite): void {
  if (!PLAZA.enabled) return;
  const id = area.id;
  const M = PLAZA.monument;
  const rng = new Rng(deriveSeed(deriveSeed(seed, 'plazas'), `a${id}`));
  const taken = new Taken();
  for (const d of b.destructibles) taken.add(d.x, d.z, PROP_DEFS[d.kind].radius);
  const treeR = STREET_TREES.trunkRadius;
  const trees: Vec2[] = [];
  const ring = site.ring;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (len < CITY.districts.monument.lampSpacing) continue;
    const ux = (q.x - p.x) / len;
    const uz = (q.z - p.z) / len;
    const sgn = (site.c.x - p.x) * uz - (site.c.z - p.z) * ux > 0 ? 1 : -1;
    const n = Math.max(2, Math.round(len / CITY.districts.monument.lampSpacing)) + (Math.max(2, Math.round(len / CITY.districts.monument.lampSpacing)) % 2);
    // Midway between lantern k and k + 1: the stations (k + 1) / n of the side.
    for (let k = 0; k + 1 < n; k++) {
      const jit = rng.range(-1, 1);
      const keep = rng.chance(0.9);
      const s = ((k + 1) / n) * len + jit;
      const t = { x: p.x + ux * s + uz * sgn * M.inset, z: p.z + uz * s - ux * sgn * M.inset };
      if (!keep || !site.inside(t, 3.2) || site.inLane(t, M.lane) || !taken.free(t.x, t.z, treeR, M.clear)) continue;
      if (trees.some((q2) => (q2.x - t.x) ** 2 + (q2.z - t.z) ** 2 < PLAZA.tree.gap ** 2)) continue;
      plantTree(b, id, rng, t.x, t.z);
      taken.add(t.x, t.z, treeR + 0.1);
      trees.push(t);
    }
  }
  // Strands along each side between neighbouring posts: festoon lights, every other one bunting.
  const [lo, hi] = PLAZA.strand.span;
  for (const side of site.sides) {
    for (let k = 0; k + 1 < side.length; k++) {
      const a = side[k];
      const c = side[k + 1];
      const bunting = rng.chance(PLAZA.strand.bunting);
      const d = sqrt((a.x - c.x) ** 2 + (a.z - c.z) ** 2);
      if (d < lo || d > hi) continue;
      b.hints.push({ kind: PLAZA_HINT.strand, points: [a, c], values: [bunting ? 1 : 0] });
    }
  }
  // Loose groups round the landmark, between the steps and the pots; none across the arch's opening or a pass.
  const groups = rng.int(M.groups[0], M.groups[1]);
  const base = rng.range(0, Math.PI * 2);
  for (let g = 0; g < groups; g++) {
    const ang = base + ((g + 0.5) / groups) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const count = rng.int(PLAZA.gather.people[0], PLAZA.gather.people[1]);
    const r = site.clearR + M.groupRing;
    const p = { x: site.c.x + sin(ang) * r, z: site.c.z + cos(ang) * r };
    if (site.arch && Math.abs(sin(ang - site.yaw)) < 0.5) continue;
    if (!site.inside(p, 2) || site.inLane(p, 1.5) || !taken.free(p.x, p.z, 0.9, 0.5)) continue;
    b.hints.push({ kind: PLAZA_HINT.gather, points: [p], values: [count, 0.9] });
  }
}
