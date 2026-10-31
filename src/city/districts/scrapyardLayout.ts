/**
 * The inside of the Scrapyard: a pure function of the area (its region and the few numbers scrapyardPlan.ts put in `params`),
 * so the sim (heights, walls, decks, the drift zone, the press), the district build, the renderer and the tests all read one
 * yard. docs/weekend.md has the design; CITY.districts.scrapyard every size.
 *
 * The frame (scrapyardShapes.ts): `u` along the spine's chord from the race's entry junction, `d` off the spine, positive
 * toward the region's shallow side. Five lines run from the entry to the exit:
 *  - the haul road (the spine): concrete, the weighbridge hump, under the conveyor gantry, oil patches in its fast line, drums
 *    and pallets on its shoulders, the scale house and a steel gate portal at the entry's widening concrete apron;
 *  - the Eight (d < 0): two bowls side by side along the spine, banked round the outsides of the loops (BankedArc spans), flat
 *    across the neck; the line rides the lower bank round the far side of the first bowl, crosses the neck and the near side of
 *    the second, the stadium round both is the drift zone, two slick mud pools, an island of stacks in each middle;
 *  - the Canyon (d > 0): off the spine near the entry into an aisle between double walls of stacks, two blind doglegs, the press
 *    (a timed gate) on its last straight, then a straight leg that dives under the Bale Deck, crosses the haul road and climbs
 *    the crusher's kicker over the pit into the second bowl's bank;
 *  - the Bale Deck (d > 0, beside the spine): a 10% ramp of bales up onto a deck of bales and flatbeds, a DeckSpan over the
 *    Canyon's leg, parapets with their undersides up (a car beneath passes) and their tops low (a car flying in passes over),
 *    open over the launch's landing and at the drop, then the ramp down; the launch is a kicker on the haul road's shoulder;
 *  - the Perimeter (d > 0, along the fence): the longest and safest, the truck wash's wet patch, the magnet crane over its pile,
 *    the shredder, parked wreckers, floodlights, and two mouths in the fence onto the ring street.
 * Everything else is scrap mountains (scrapyardFill.ts). Every solid and prop keeps off every line's clear width at its level.
 */
import { CITY } from '../config';
import type { Vec2 } from '../../sim/math';
import { DEG, atan2, cos, distToSegment, sin, sqrt } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { DistrictPropSpec } from '../props';
import { type BankedArc, type BankedRing, bankedRing, reachOf } from './banking';
import { distToPolygonEdge, distToPolyline, pointInPolygon } from './geom';
import type { Area, FeatureLine } from './types';
import { regionFence, regionOf, spineLine } from './weekendRegion';
import type { Region } from './weekendRegion';
import { FillRaster, type ScrapHeap } from './scrapyardFill';
import { type YardFrame, framePoint, frameCoords, makeFrame, rampProfile } from './scrapyardShapes';

const C = CITY.districts.scrapyard;

/** A stack of crushed cars: an oriented box, its footprint and how many cars high. */
export interface ScrapStack {
  x: number;
  z: number;
  /** Unit axis along its length. */
  ax: number;
  az: number;
  length: number;
  depth: number;
  /** Cars high. */
  tiers: number;
  /** island: in a bowl's middle; canyon: the canyon's walls; flank: beside the crusher's kicker; support: under the Bale Deck (Wall.under). */
  kind: 'island' | 'canyon' | 'flank' | 'support';
  /** The four corners (world). */
  poly: Vec2[];
}

/** A piece of fence: a segment of the region's ring and its inward unit normal; the solid is `thickness` deep inward. */
export interface YardFencePiece {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
}

/** A solid machine, post or vehicle: an oriented box footprint (world corners), its centre, axis and sizes. */
export interface YardSolid {
  x: number;
  z: number;
  ax: number;
  az: number;
  length: number;
  depth: number;
  poly: Vec2[];
  kind: 'post' | 'crusher' | 'crane' | 'shredder' | 'scale' | 'wrecker' | 'flatbed' | 'washPost' | 'gantryLeg' | 'portalPost' | 'tower' | 'island';
}

/** A parapet piece of the Bale Deck: a solid quad, the stretch of u it stands over, and which side (1 outer, -1 spine side). */
export interface DeckParapet {
  poly: Vec2[];
  u0: number;
  u1: number;
  side: 1 | -1;
  /** On a ramp (its top follows the ramp, no underside) or over the deck (a car beneath passes). */
  ramp: boolean;
}

export interface ScrapLayout {
  frame: YardFrame;
  /** The race's direction along the region's spine (1 entry to exit as the region stores it, -1 back). */
  dir: 1 | -1;
  /** The bowls' crest radius, the reach of their banks and the Eight's ride radius (m). */
  R: number;
  reach: number;
  ride: number;
  /** The two bowls' banks (the first bowl in driving order first), their centres, the neck between, the Eight's local axes (ex first bowl to second, ey away from the spine). */
  bowls: [BankedArc, BankedArc];
  /** Each bowl's dish: the floor dug under grade, back to grade at the crest (a BankedRing whose rise is its dip). */
  dishes: [BankedRing, BankedRing];
  centers: [Vec2, Vec2];
  neck: Vec2;
  ex: Vec2;
  ey: Vec2;
  /** The five lines in driving order (lines() turns them entry to exit). */
  lines: FeatureLine[];
  stacks: ScrapStack[];
  heaps: ScrapHeap[];
  fences: YardFencePiece[];
  solids: YardSolid[];
  /** The crusher's kicker: centre line foot to lip, the travel direction; the pit's start (at the lip) and its range along the jump. */
  kicker: { foot: Vec2; lip: Vec2; dir: Vec2 };
  pit: { o: Vec2; dir: Vec2; s0: number; s1: number };
  /** The launch from the haul road onto the deck, the same way. */
  launch: { foot: Vec2; lip: Vec2; dir: Vec2 };
  /** The weighbridge: its start on the spine's middle line and its axis. */
  hump: { o: Vec2; dir: Vec2; half: number };
  /** The Bale Deck: its u range, centre line offset, edges (d), footprint, parapets, the passage's middle (u) and the parapet's gaps (u ranges, spine side). */
  deck: { u0: number; u1: number; dC: number; inner: number; outer: number; polygon: Vec2[]; parapets: DeckParapet[]; passage: number; gaps: [number, number][] };
  /** The canyon's centre line (world, from its mouth to where its leg meets the deck's spine side) and its leg (the turn to that end). */
  canyon: { centre: Vec2[]; leg: [Vec2, Vec2] };
  press: { a: Vec2; b: Vec2; nx: number; nz: number };
  /** Slick patches (oil, mud, the wash) and the dirt shoulders round the bowls, the haul road's concrete and the entry apron. */
  slicks: Vec2[][];
  dirt: Vec2[][];
  concrete: Vec2[][];
  /** The gantry's two legs (over the spine) and the gate portal's two posts. */
  gantry: [Vec2, Vec2];
  portal: [Vec2, Vec2];
  /** The magnet crane (its base and the boom's tip) and the shredder's hopper (the spark shower). */
  crane: { base: Vec2; tip: Vec2 };
  shredder: Vec2;
  /** The perimeter road's mouths in the fence (middles). */
  mouths: Vec2[];
  /** Floodlight towers (bases; each aims at `aim`). */
  towers: { x: number; z: number; aim: Vec2 }[];
  clutter: DistrictPropSpec[];
}

const cache = new WeakMap<Area, ScrapLayout>();

/** The yard's layout (cached per area); null when the area planned none. */
export function scrapLayout(a: Area): ScrapLayout {
  let l = cache.get(a);
  if (!l) cache.set(a, (l = buildLayout(a)));
  return l;
}

/** The deck's height above the terrain (m) at u along the yard's chord: 0 off it, the ramps' eased 10% climb, `deck.height` along it. */
export function deckLift(L: ScrapLayout, u: number, out: { h: number; d: number }): { h: number; d: number } {
  if (u <= L.deck.u0 || u >= L.deck.u1) {
    out.h = 0;
    out.d = 0;
    return out;
  }
  deckRamp(L)(u - L.deck.u0, out);
  return out;
}
const ramps = new WeakMap<ScrapLayout, (s: number, out: { h: number; d: number }) => void>();
function deckRamp(L: ScrapLayout) {
  let f = ramps.get(L);
  if (!f) ramps.set(L, (f = rampProfile(C.deck.height, C.deck.ramp, C.deck.ease, L.deck.u1 - L.deck.u0)));
  return f;
}

/** The drift zone's outline: a stadium round both bowls at their crests, the neck between. */
export function yardZone(a: Area): Vec2[] | null {
  if (!(a.params.R > 0) || !a.params.planned) return null;
  const L = scrapLayout(a);
  const [A, B] = L.centers;
  const r = L.R + 2;
  const out: Vec2[] = [];
  const n = 16;
  // Round A's far end (away from B) from the spine side to the back, then round B's far end back.
  for (let i = 0; i <= n; i++) {
    const t = Math.PI / 2 + (i / n) * Math.PI;
    out.push(local(L, A, cos(t) * r, -sin(t) * r));
  }
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 + (i / n) * Math.PI;
    out.push(local(L, B, cos(t) * r, -sin(t) * r));
  }
  return out;
}

/** A point of a bowl's local frame: `x` along ex (first bowl to second), `y` along ey (away from the spine). */
function local(L: { ex: Vec2; ey: Vec2 }, c: Vec2, x: number, y: number): Vec2 {
  return { x: c.x + L.ex.x * x + L.ey.x * y, z: c.z + L.ex.z * x + L.ey.z * y };
}

function box(cx: number, cz: number, ax: number, az: number, length: number, depth: number): Vec2[] {
  const hx = length / 2;
  const hz = depth / 2;
  const bx = -az;
  const bz = ax;
  return [
    { x: cx - ax * hx - bx * hz, z: cz - az * hx - bz * hz },
    { x: cx + ax * hx - bx * hz, z: cz + az * hx - bz * hz },
    { x: cx + ax * hx + bx * hz, z: cz + az * hx + bz * hz },
    { x: cx - ax * hx + bx * hz, z: cz - az * hx + bz * hz },
  ];
}

const unit = (x: number, z: number): Vec2 => {
  const l = sqrt(x * x + z * z) || 1;
  return { x: x / l, z: z / l };
};
const add = (p: Vec2, d: Vec2, s: number): Vec2 => ({ x: p.x + d.x * s, z: p.z + d.z * s });

/** Distance (m) along the ray from `p` in unit direction `dir` to the polygon's ring (Infinity if it never meets it). */
export function rayToRing(p: Vec2, dir: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const den = dir.x * ez - dir.z * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - p.x) * ez - (a.z - p.z) * ex) / den;
    const s = ((a.x - p.x) * dir.z - (a.z - p.z) * dir.x) / den;
    if (t > 1e-6 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best;
}

/** The region's depth (m) off the spine at u toward `sign` (1 the shallow side). */
export function sideDepth(F: YardFrame, poly: readonly Vec2[], u: number, sign: 1 | -1): number {
  const p = framePoint(F, u, 0);
  return rayToRing(p, { x: F.n.x * sign, z: F.n.z * sign }, poly);
}

/** The geometry every reader needs before the props: the frame and the bowls (planScrapyard tries a crest radius with it). */
export function eightGeometry(F: YardFrame, R: number): { reach: number; cA: Vec2; cB: Vec2; foot: Vec2; footU: number; cBu: number; cBd: number } {
  const B = C.bank;
  const reach = R + B.hold + B.fall;
  const K = C.kicker;
  const al = K.angleDeg * DEG;
  // In the frame: the kicker's foot just past the spine's edge on the Eight's side, the second bowl's centre on its line.
  const footD = -(C.spineWidth / 2 + K.footClear);
  const toCentre = K.run + reach + K.lipOut;
  const cBd = footD - toCentre * cos(al);
  // The neck stands at the chord's middle; the second bowl one reach on.
  const cBu = F.len / 2 + reach;
  const footU = cBu - toCentre * sin(al);
  return { reach, cA: framePoint(F, cBu - 2 * reach, cBd), cB: framePoint(F, cBu, cBd), foot: framePoint(F, footU, footD), footU, cBu, cBd };
}

function buildLayout(a: Area): ScrapLayout {
  const P = a.params;
  const region = regionOf(a)!;
  const dir: 1 | -1 = P.dir > 0 ? 1 : -1;
  const rp = dir > 0 ? region.path.slice() : region.path.slice().reverse();
  const F = makeFrame(rp, P.side > 0 ? 1 : -1);
  const Lu = F.len;
  const rng = new Rng(deriveSeed(P.seed, 'scrapyard:layout'));
  const W = (u: number, d: number) => framePoint(F, u, d);
  const hw = C.spineWidth / 2;
  const R = P.R;
  const St = C.stack;
  const pitch = St.length + St.gap;
  const tiers = () => (rng.chance(0.2) ? 2 : rng.chance(0.5) ? 3 : 4);

  // ---- The spine in driving order, cut at a frame u.
  const spineU = rp.map((p) => frameCoords(F, p.x, p.z).u);
  const spineAt = (u: number): Vec2 => {
    for (let i = 0; i + 1 < rp.length; i++) {
      if (u <= spineU[i + 1] || i + 2 === rp.length) {
        const t = Math.max(0, Math.min(1, (u - spineU[i]) / (spineU[i + 1] - spineU[i] || 1)));
        return { x: rp[i].x + (rp[i + 1].x - rp[i].x) * t, z: rp[i].z + (rp[i + 1].z - rp[i].z) * t };
      }
    }
    return rp[rp.length - 1];
  };
  const upTo = (u: number): Vec2[] => [...rp.filter((_, i) => spineU[i] < u - 0.5), spineAt(u)];
  const from = (u: number): Vec2[] => [spineAt(u), ...rp.filter((_, i) => spineU[i] > u + 0.5)];

  // ---- The Eight.
  const G = eightGeometry(F, R);
  const reach = G.reach;
  const ride = R - C.eight.inset;
  const cA = G.cA;
  const cB = G.cB;
  const ex = unit(cB.x - cA.x, cB.z - cA.z);
  // Away from the spine: the Eight lies at negative d, so -n.
  let ey = { x: -ex.z, z: ex.x };
  if (ey.x * F.n.x + ey.z * F.n.z > 0) ey = { x: -ey.x, z: -ey.z };
  const Lx = { ex, ey };
  const neck = { x: (cA.x + cB.x) / 2, z: (cA.z + cB.z) / 2 };
  const at = (c: Vec2, deg: number, r = ride): Vec2 => local(Lx, c, cos(deg * DEG) * r, sin(deg * DEG) * r);
  const worldAngle = (deg: number): number => atan2(ex.z * cos(deg * DEG) + ey.z * sin(deg * DEG), ex.x * cos(deg * DEG) + ey.x * sin(deg * DEG));
  const Bk = C.bank;
  // Bowl A banks round its far side (45 to 180 deg of its local frame), bowl B round its near side (225 to 300).
  const arc = (c: Vec2, d0: number, d1: number, taper: number): BankedArc => ({
    cx: c.x,
    cz: c.z,
    rOut: R,
    rise: Bk.rise,
    hold: Bk.hold,
    fall: Bk.fall,
    height: Bk.height,
    mid: worldAngle((d0 + d1) / 2),
    half: ((d1 - d0) / 2) * DEG,
    taper,
  });
  const bowls: [BankedArc, BankedArc] = [arc(cA, 40, 185, Bk.taper), arc(cB, 215, 305, Bk.taper * 0.6)];
  const dish = (c: Vec2): BankedRing => bankedRing(c.x, c.z, R, { dip: Bk.dip, rise: Bk.dip, bankWidth: Bk.rise, rimWidth: 0.01 });
  const dishes: [BankedRing, BankedRing] = [dish(cA), dish(cB)];
  const uIn = G.cBu - 2 * reach - ride - C.eight.leg;
  const uOut = G.cBu + ride + C.eight.leg;
  const arcPts = (c: Vec2, d0: number, d1: number, step = 10): Vec2[] => {
    const n = Math.max(1, Math.ceil(Math.abs(d1 - d0) / step));
    return Array.from({ length: n + 1 }, (_, i) => at(c, d0 + ((d1 - d0) * i) / n));
  };
  const eightPath = [...upTo(uIn), ...arcPts(cA, 180, 45), ...arcPts(cB, 225, 300), ...from(uOut)];

  // ---- The crusher's kicker and pit, aimed from its foot at the second bowl's middle.
  const K = C.kicker;
  const kDir = unit(cB.x - G.foot.x, cB.z - G.foot.z);
  const kFoot = G.foot;
  const kLip = add(kFoot, kDir, K.run);
  const pit = { o: kLip, dir: kDir, s0: C.pit.from, s1: C.pit.from + C.pit.length };
  const landing = add(cB, kDir, -(R - 2));

  // ---- The Bale Deck.
  const D = C.deck;
  const inner = hw + C.shoulder + D.gap;
  const outer = inner + D.width;
  const dC = (inner + outer) / 2;
  const uD0 = D.start;
  const uD1 = Lu - D.endClear;

  // ---- The Canyon: the leg back from the kicker's foot along its line, to the canyon's depth.
  const sideMin = Math.min(...[0.2, 0.35, 0.5, 0.65, 0.8].map((f) => sideDepth(F, region.polygon, Lu * f, 1)));
  const dK = Math.min(C.canyon.depth, sideMin - C.canyon.backRoom);
  let legLen = (dK - frameCoords(F, kFoot.x, kFoot.z).d) / Math.max(0.3, cos(K.angleDeg * DEG));
  for (let i = 0; i < 3; i++) {
    const q = add(kFoot, kDir, -legLen);
    const dd = frameCoords(F, q.x, q.z).d;
    legLen += (dK - dd) / Math.max(0.3, cos(K.angleDeg * DEG));
  }
  const Kt = add(kFoot, kDir, -legLen);
  const ut = frameCoords(F, Kt.x, Kt.z).u;
  const u1 = C.canyon.branch + C.canyon.mouth;
  const run = ut - u1;
  const j0 = u1 + run * 0.32;
  const j1 = u1 + run * 0.66;
  const jog = C.canyon.jog;
  // Centre line in the frame: the mouth, a dogleg out, a dogleg back, the last straight (with the press) to the turn into the leg.
  const centreFD: [number, number][] = [
    [u1, dK],
    [j0, dK],
    [j0 + 11, dK + jog],
    [j1, dK + jog],
    [j1 + 11, dK],
    [ut, dK],
  ];
  const centre = [...centreFD.map(([u, d]) => W(u, d))];
  centre[centre.length - 1] = Kt;
  // The leg: from the turn to where it meets the deck's spine side (its walls stop there; the shoulder and the haul road are open).
  const legEnd = (() => {
    let lo = 0;
    let hi = legLen;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      const q = add(Kt, kDir, m);
      if (frameCoords(F, q.x, q.z).d > inner - 1) lo = m;
      else hi = m;
    }
    return add(Kt, kDir, lo);
  })();
  const passageU = (() => {
    let lo = 0;
    let hi = legLen;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      const q = add(Kt, kDir, m);
      if (frameCoords(F, q.x, q.z).d > dC) lo = m;
      else hi = m;
    }
    const q = add(Kt, kDir, lo);
    return frameCoords(F, q.x, q.z).u;
  })();
  const canyonPath = [...upTo(C.canyon.branch), ...centre, kFoot, kLip, landing, at(cB, 270), at(cB, 285), at(cB, 300), ...from(uOut)];

  // ---- The deck's line and gaps.
  // The drop: the spine side's parapet open past the canyon's passage (or before it, where the deck ends too soon after it). The
  // launch's landing keeps its parapet: a car that reaches the deck clears its low top, one that falls short is turned back by it
  // (an open edge there would leave a car landing astride it with its wheels on two levels).
  const deckTop = uD0 + D.ramp;
  const gaps: [number, number][] = [];
  let drop: [number, number] = [passageU + D.drop[0], passageU + D.drop[1]];
  if (drop[1] > uD1 - D.ramp - 4) drop = [passageU - D.drop[1], passageU - D.drop[0]];
  if (drop[0] > deckTop + 4 && drop[1] < uD1 - D.ramp - 4) gaps.push(drop);
  const deckPath: Vec2[] = [...upTo(uD0 - 40), W(uD0 - 12, dC)];
  for (let u = uD0; u < uD1; u += 10) deckPath.push(W(u, dC));
  deckPath.push(W(uD1, dC), W(uD1 + 12, dC), ...from(uD1 + 38));

  // ---- The launch onto the deck: on the deck side's shoulder, aimed a little out toward the deck.
  const La = C.launch;
  const lipU = uD0 + La.lipFrom;
  const sAx = unit(W(lipU + 1, 0).x - W(lipU - 1, 0).x, W(lipU + 1, 0).z - W(lipU - 1, 0).z);
  const sN = { x: F.n.x, z: F.n.z };
  const lDir = unit(sAx.x * cos(La.angleDeg * DEG) + sN.x * sin(La.angleDeg * DEG), sAx.z * cos(La.angleDeg * DEG) + sN.z * sin(La.angleDeg * DEG));
  const lLip = W(lipU, hw + C.shoulder / 2);
  const launch = { foot: add(lLip, lDir, -La.run), lip: lLip, dir: lDir };

  // ---- The perimeter: along the shallow side's fence, legs off the spine near both ends.
  const Pm = C.perimeter;
  const dP = (u: number) => sideDepth(F, region.polygon, u, 1) - Pm.margin - Pm.width / 2;
  const uP0 = Pm.branch;
  const uP1 = Lu - Pm.branch;
  const corner = (uc: number, dd: number, sgn: 1 | -1): Vec2[] => {
    // A quarter round from the leg's end (heading out along d) into the back stretch's start (heading along u), radius `corner`.
    const out: Vec2[] = [];
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * (Math.PI / 2);
      out.push(W(uc - sgn * Pm.corner * cos(t), dd - Pm.corner + Pm.corner * sin(t)));
    }
    return out;
  };
  // Where the region's end sides are skewed to the chord, a leg square off the spine would cut outside the ring: each end's
  // back stretch starts as far in as its leg and corner need to keep the road's half width and margin inside the fence.
  const roadClear = Pm.margin + Pm.width / 2 - 0.5;
  const legFits = (spineP: Vec2, pts: Vec2[]): boolean => {
    const all = [spineP, ...pts];
    for (let i = 0; i + 1 < all.length; i++) {
      const p = all[i];
      const q = all[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 4));
      for (let k = i === 0 ? 3 : 0; k <= n; k++) {
        const x = p.x + ((q.x - p.x) * k) / n;
        const z = p.z + ((q.z - p.z) * k) / n;
        if (!pointInPolygon(x, z, region.polygon) || distToPolygonEdge(x, z, region.polygon) < roadClear) return false;
      }
    }
    return true;
  };
  let back0 = uP0 + 14 + Pm.corner;
  while (back0 < Lu * 0.3 && !legFits(spineAt(uP0), corner(back0, dP(back0), 1))) back0 += 6;
  let back1 = uP1 - 14 - Pm.corner;
  while (back1 > Lu * 0.7 && !legFits(spineAt(uP1), corner(back1, dP(back1), -1))) back1 -= 6;
  const perimBack: Vec2[] = [];
  for (let u = back0; u < back1; u += 12) perimBack.push(W(u, dP(u)));
  perimBack.push(W(back1, dP(back1)));
  const perimPath = [...upTo(uP0), ...corner(back0, dP(back0), 1), ...perimBack, ...corner(back1, dP(back1), -1).reverse(), ...from(uP1)];

  // ---- Lines (driving order).
  const lines: FeatureLine[] = [
    spineLine(region, 'The haul road', 'concrete', 'ground', 1),
    { id: 'eight', name: 'The Eight', kind: 'alt', path: eightPath, width: C.eight.width, level: 'ground', surface: 'quay', difficulty: 2 },
    { id: 'canyon', name: 'The Canyon', kind: 'alt', path: canyonPath, width: C.canyon.lineWidth, level: 'ground', surface: 'quay', difficulty: 3 },
    { id: 'deck', name: 'The Bale Deck', kind: 'alt', path: deckPath, width: D.lineWidth, level: 'deck', surface: 'road', difficulty: 3 },
    { id: 'perimeter', name: 'The Perimeter', kind: 'alt', path: perimPath, width: Pm.lineWidth, level: 'ground', surface: 'quay', difficulty: 1 },
  ];
  // The spine's line in driving order, for the checks below (spineLine is entry to exit).
  const spinePath = rp;
  const groundLines = [
    { path: spinePath, half: hw },
    { path: eightPath, half: C.eight.width / 2 },
    { path: canyonPath, half: C.canyon.lineWidth / 2 },
    { path: perimPath, half: Pm.lineWidth / 2 },
    // The deck line's ground stretches: its approach to the up ramp's foot and its way back from the down ramp's.
    { path: deckPath.slice(0, deckPath.findIndex((p) => inDeck(p)) + 1), half: D.lineWidth / 2 },
    { path: deckPath.slice(deckPath.length - 1 - [...deckPath].reverse().findIndex((p) => inDeck(p))), half: D.lineWidth / 2 },
  ];
  function inDeck(p: Vec2): boolean {
    const q = frameCoords(F, p.x, p.z);
    return q.u > uD0 - 0.5 && q.u < uD1 + 0.5 && q.d > inner - 0.5 && q.d < outer + 0.5;
  }
  /** Distance from a point to the nearest ground line's edge (negative inside one). */
  const lineGap = (x: number, z: number): number => {
    let best = Infinity;
    for (const l of groundLines) if (l.path.length > 1) best = Math.min(best, distToPolyline(x, z, l.path) - l.half);
    return best;
  };

  // ---- Stacks.
  const stacks: ScrapStack[] = [];
  const stackAt = (c: Vec2, ax: Vec2, kind: ScrapStack['kind'], t = tiers(), length: number = St.length): ScrapStack => ({ x: c.x, z: c.z, ax: ax.x, az: ax.z, length, depth: St.depth, tiers: t, kind, poly: box(c.x, c.z, ax.x, ax.z, length, St.depth) });
  /** Stacks along a segment at lateral offsets, kept off the aisle of `aisle` (a polyline, m of half width) and off every ground line. */
  const wallAlong = (p: Vec2, q: Vec2, offsets: number[], kind: ScrapStack['kind'], aisle: Vec2[], half: number, extra?: (s: ScrapStack) => boolean) => {
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    const ax = unit(q.x - p.x, q.z - p.z);
    const nx = { x: -ax.z, z: ax.x };
    const count = Math.max(1, Math.floor((len + St.gap) / pitch));
    const lead = (len - (count * pitch - St.gap)) / 2;
    for (let k = 0; k < count; k++) {
      const s = lead + St.length / 2 + k * pitch;
      for (const off of offsets) {
        const c = { x: p.x + ax.x * s + nx.x * off, z: p.z + ax.z * s + nx.z * off };
        const st = stackAt(c, ax, kind);
        if (st.poly.some((v) => distToPolyline(v.x, v.z, aisle) < half - 0.05)) continue;
        if (st.poly.some((v) => lineGap(v.x, v.z) < 0.3) && kind !== 'support') continue;
        if (st.poly.some((v) => !pointInPolygon(v.x, v.z, region.polygon) || distToPolygonEdge(v.x, v.z, region.polygon) < 1.5)) continue;
        if (extra && !extra(st)) continue;
        stacks.push(st);
      }
    }
  };
  const aw = C.canyon.aisle / 2;
  const offs = [aw + St.depth / 2, aw + St.depth * 1.5, -(aw + St.depth / 2), -(aw + St.depth * 1.5)];
  // The canyon's walls along its centre line and its leg, down to the deck's spine side.
  const canyonAisle = [...centre, legEnd];
  for (let i = 0; i + 1 < canyonAisle.length; i++) wallAlong(canyonAisle[i], canyonAisle[i + 1], offs, 'canyon', canyonAisle, aw);
  // The bowls' islands: stacks standing tangent round a ring in each middle.
  const E = C.eight;
  for (const c of [cA, cB]) {
    const phase = rng.next() * Math.PI * 2;
    for (let k = 0; k < E.islandCount; k++) {
      const ang = phase + (k / E.islandCount) * Math.PI * 2;
      const p = { x: c.x + cos(ang) * E.islandRadius, z: c.z + sin(ang) * E.islandRadius };
      stacks.push(stackAt(p, { x: -sin(ang), z: cos(ang) }, 'island', 3 + (k % 2)));
    }
  }
  // The kicker's flanks: a stack each side of its run, so the run up is a chute out of the open ground.
  const kN = { x: -kDir.z, z: kDir.x };
  for (const side of [-1, 1]) {
    const c = add(add(kFoot, kDir, K.run / 2 - 0.4), kN, side * (K.width / 2 + St.depth / 2));
    stacks.push(stackAt(c, kDir, 'flank', 2, 5.4));
  }
  // The deck's supports under its edges, flush with them all along (not where the canyon's leg passes beneath): a car below the
  // deck's underside meets them, so nothing enters the deck's footprint low enough to be lifted onto it (World.heightAt picks the
  // deck for a body nearer it than the ground). One dropping off the open edge is only nudged outward by them as it falls.
  const deckFlatU0 = uD0 + D.ramp;
  const deckFlatU1 = uD1 - D.ramp;
  const legAisle = [Kt, legEnd];
  for (const side of [-1, 1] as const) {
    for (let u = deckFlatU0 + 0.2; u + St.length <= deckFlatU1 - 0.2 + 1e-6; u += pitch) {
      const edge = side < 0 ? inner : outer;
      const d = edge - side * (St.depth / 2);
      const p0 = W(u, d);
      const p1 = W(u + St.length, d);
      const ax = unit(p1.x - p0.x, p1.z - p0.z);
      const st = stackAt({ x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 }, ax, 'support', 5);
      if (st.poly.some((v) => distToPolyline(v.x, v.z, legAisle) < aw + 0.4)) continue;
      stacks.push(st);
    }
  }
  // Stacks under the deck (the passage's walls and the supports) carry Wall.under; mark the canyon's under it as supports too.
  const deckPoly: Vec2[] = [];
  for (let u = uD0; u < uD1; u += 8) deckPoly.push(W(u, inner));
  deckPoly.push(W(uD1, inner), W(uD1, outer));
  for (let u = uD1 - 8; u > uD0; u -= 8) deckPoly.push(W(u, outer));
  deckPoly.push(W(uD0, outer));
  // One that only reaches in under the deck's edge is a support all the same: whatever stands under the deck is nothing to a car on it.
  for (const s of stacks) if (s.kind === 'canyon' && s.poly.some((v) => pointInPolygon(v.x, v.z, deckPoly))) s.kind = 'support';
  // The outside of every bend in the canyon: a block of stacks closes the gap the two walls leave there.
  for (let k = 1; k + 1 < canyonAisle.length; k++) {
    const q = canyonAisle[k];
    const t1 = unit(q.x - canyonAisle[k - 1].x, q.z - canyonAisle[k - 1].z);
    const t2 = unit(canyonAisle[k + 1].x - q.x, canyonAisle[k + 1].z - q.z);
    const o = unit(t1.x - t2.x, t1.z - t2.z);
    const st = stackAt(add(q, o, aw + St.depth), { x: -o.z, z: o.x }, 'canyon');
    st.depth = 2 * St.depth;
    st.poly = box(st.x, st.z, st.ax, st.az, st.length, st.depth);
    if (st.poly.every((v) => distToPolyline(v.x, v.z, canyonAisle) >= aw - 0.05 && lineGap(v.x, v.z) >= 0.3)) stacks.push(st);
  }

  // ---- Parapets: both edges, inside the deck, pieces of about a stack's length; the spine side open over the gaps.
  const parapets: DeckParapet[] = [];
  for (const side of [-1, 1] as const) {
    const edge = side < 0 ? inner : outer;
    const n = Math.ceil((uD1 - uD0) / 5);
    for (let k = 0; k < n; k++) {
      const pu0 = uD0 + ((uD1 - uD0) * k) / n;
      const pu1 = uD0 + ((uD1 - uD0) * (k + 1)) / n;
      const mid = (pu0 + pu1) / 2;
      if (side < 0 && gaps.some(([g0, g1]) => mid > g0 && mid < g1)) continue;
      const d0 = edge;
      const d1 = edge - side * D.parapet;
      parapets.push({ poly: [W(pu0, d0), W(pu1, d0), W(pu1, d1), W(pu0, d1)], u0: pu0, u1: pu1, side, ramp: pu1 <= deckFlatU0 + 0.01 || pu0 >= deckFlatU1 - 0.01 });
    }
  }

  // ---- Solids: machines, posts, vehicles, towers. Each keeps off every line, the stacks and the set pieces, or is left out.
  const solids: YardSolid[] = [];
  const keepOut: { c: Vec2; r: number }[] = [
    { c: cA, r: reach + 2 },
    { c: cB, r: reach + 2 },
  ];
  const solidFits = (poly: Vec2[], pad = 0.6): boolean => {
    for (const v of poly) {
      if (!pointInPolygon(v.x, v.z, region.polygon) || distToPolygonEdge(v.x, v.z, region.polygon) < 1.5) return false;
      if (lineGap(v.x, v.z) < pad) return false;
      if (pointInPolygon(v.x, v.z, deckPoly)) return false;
      if (keepOut.some((k) => Math.hypot(v.x - k.c.x, v.z - k.c.z) < k.r)) return false;
    }
    const c = { x: poly.reduce((s, v) => s + v.x, 0) / poly.length, z: poly.reduce((s, v) => s + v.z, 0) / poly.length };
    const rad = Math.max(...poly.map((v) => Math.hypot(v.x - c.x, v.z - c.z)));
    if (stacks.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < rad + 3)) return false;
    if (solids.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < rad + Math.max(s.length, s.depth) / 2 + 0.5)) return false;
    return true;
  };
  const putSolid = (kind: YardSolid['kind'], c: Vec2, ax: Vec2, length: number, depth: number, pad = 0.6): YardSolid | null => {
    const poly = box(c.x, c.z, ax.x, ax.z, length, depth);
    if (!solidFits(poly, pad)) return null;
    const s: YardSolid = { x: c.x, z: c.z, ax: ax.x, az: ax.z, length, depth, poly, kind };
    solids.push(s);
    return s;
  };
  const Cr = C.crusher;
  // The crusher beside its pit (or beside the kicker's run, where a bowl's bank comes too near the pit): the first spot that fits.
  let crusher: YardSolid | null = null;
  const bowlKeep = keepOut.splice(0, 2);
  keepOut.unshift(...bowlKeep.map((k) => ({ c: k.c, r: reach + 0.5 })));
  for (const s of [(pit.s0 + pit.s1) / 2, 0, -5, -10]) {
    for (const side of [1, -1]) crusher ??= putSolid('crusher', add(add(kLip, kDir, s), kN, side * (C.pit.halfWidth + Cr.depth / 2 + 0.8)), kDir, Cr.length, Cr.depth, 0.4);
  }
  keepOut.splice(0, 2, ...bowlKeep);
  // The kicker's own ground (foot to past the pit) keeps everything else off.
  keepOut.push({ c: add(kLip, kDir, 2), r: 9 });
  keepOut.push({ c: kFoot, r: 6 });
  // The launch's run up and flight over the shoulder, and the shoulder under the deck's open parapet (the drop lands there): nothing stands there.
  const flight: Vec2[] = [add(launch.foot, lDir, -30), add(lLip, lDir, 60)];
  const clearRuns: [Vec2, Vec2][] = [[flight[0], flight[1]], ...gaps.map(([g0, g1]): [Vec2, Vec2] => [W(g0 - 6, hw + 3.5), W(g1 + 10, hw + 3.5)])];
  const shoulderClear = (v: Vec2) => clearRuns.every(([p, q]) => distToSegment(v.x, v.z, p.x, p.z, q.x, q.z) > 4.5);
  // The gate portal at the entry's apron: steel posts either side of the flare.
  const portalU = 18;
  const wE = (dir > 0 ? region.widthE : region.widthX) / 2;
  const portal: [Vec2, Vec2] = [W(portalU, -(wE + 2.6)), W(portalU, wE + 2.6)];
  for (const p of portal) putSolid('portalPost', p, F.u, 0.7, 0.7, 0.3);
  // The scale house beside the weighbridge.
  const H = C.hump;
  putSolid('scale', W(H.from + H.ramp + H.top / 2, -(hw + 4.2)), F.u, 5, 3.2, 0.5);
  // The gantry over the haul road: try along the spine for a stretch clear of the drop, the eight's legs and the canyon's crossing.
  let gantry: [Vec2, Vec2] = [W(uD1 - 30, -C.gantry.leg), W(uD1 - 30, C.gantry.leg)];
  for (const gu of [deckFlatU1 + 12, deckFlatU1 + 24, deckFlatU1 - C.gantry.from, uIn - 18, H.from + 30]) {
    const a0 = W(gu, -C.gantry.leg);
    const a1 = W(gu, C.gantry.leg);
    const p0 = box(a0.x, a0.z, F.u.x, F.u.z, 0.9, 0.9);
    const p1 = box(a1.x, a1.z, F.u.x, F.u.z, 0.9, 0.9);
    const okShoulder = [...p0, ...p1].every(shoulderClear) && gaps.every(([g0, g1]) => gu < g0 - 12 || gu > g1 + 12);
    // The deck side's leg stands on the shoulder by the deck: the deck's footprint check is waived for it.
    if (okShoulder && solidFits(p0, 0.4) && [...p1].every((v) => lineGap(v.x, v.z) >= 0.4)) {
      solids.push({ x: a0.x, z: a0.z, ax: F.u.x, az: F.u.z, length: 0.9, depth: 0.9, poly: p0, kind: 'gantryLeg' }, { x: a1.x, z: a1.z, ax: F.u.x, az: F.u.z, length: 0.9, depth: 0.9, poly: p1, kind: 'gantryLeg' });
      gantry = [a0, a1];
      break;
    }
  }

  // ---- Perimeter dressing: the wash, the crane and its pile, the shredder, wreckers and a flatbed, on the road's inner side.
  const perimAt = (f: number): { p: Vec2; t: Vec2; inward: Vec2; u: number } => {
    const u = back0 + (back1 - back0) * f;
    const p = W(u, dP(u));
    const q = W(u + 2, dP(u + 2));
    const t = unit(q.x - p.x, q.z - p.z);
    return { p, t, inward: { x: -F.n.x, z: -F.n.z }, u };
  };
  const wash = perimAt(0.12);
  for (const s of [-1, 1]) putSolid('washPost', add(wash.p, wash.inward, s * (Pm.width / 2 + 0.7)), wash.t, 0.6, 0.6, 0.2);
  const cr = perimAt(0.34);
  const craneBase = add(cr.p, cr.inward, Pm.width / 2 + 4);
  putSolid('crane', craneBase, cr.t, 3.2, 3.2, 0.5);
  const craneTip = add(craneBase, cr.inward, 16);
  // The crane's pile: keep the heaps there low enough to swing over (the fill reads its tip).
  const sh = perimAt(0.62);
  const shredderC = add(sh.p, sh.inward, Pm.width / 2 + 5);
  putSolid('shredder', shredderC, sh.t, 8, 6, 0.5);
  for (const [f, kind, len] of [
    [0.47, 'wrecker', 7.2],
    [0.53, 'flatbed', 8.4],
    [0.8, 'wrecker', 7.2],
  ] as const) {
    const q = perimAt(f);
    putSolid(kind, add(q.p, q.inward, Pm.width / 2 + 2.4), q.t, len, 2.5, 0.5);
  }
  // Mouths in the fence onto the ring street, a third and two thirds along the back stretch.
  const mouths = [perimAt(0.25), perimAt(0.72)].map((q) => {
    const out = rayToRing(q.p, F.n, region.polygon);
    return add(q.p, F.n, Number.isFinite(out) ? out : Pm.width / 2 + Pm.margin);
  });

  // ---- Floodlight towers round the lines.
  const towers: { x: number; z: number; aim: Vec2 }[] = [];
  const towerSpots: { p: Vec2; aim: Vec2 }[] = [
    { p: local(Lx, cA, -reach - 6, reach * 0.5), aim: cA },
    { p: local(Lx, cA, 0, reach + 6), aim: cA },
    { p: local(Lx, cB, 0, reach + 6), aim: cB },
    { p: local(Lx, cB, reach + 6, reach * 0.4), aim: cB },
    { p: local(Lx, neck, 0, -reach * 0.62), aim: neck },
    { p: W(u1 + run * 0.15, dK + aw + 2 * St.depth + 3), aim: W(u1 + run * 0.15, dK) },
    { p: W(j1 - 6, dK + jog + aw + 2 * St.depth + 3), aim: W(j1, dK) },
    { p: add(cr.p, cr.inward, Pm.width / 2 + 2), aim: cr.p },
    { p: add(sh.p, sh.inward, Pm.width / 2 + 2), aim: sh.p },
    { p: add(perimAt(0.02).p, perimAt(0.02).inward, Pm.width / 2 + 2), aim: perimAt(0.02).p },
    { p: add(perimAt(0.95).p, perimAt(0.95).inward, Pm.width / 2 + 2), aim: perimAt(0.95).p },
    { p: W(H.from - 8, -(hw + 3)), aim: W(H.from + 12, 0) },
    { p: W((uIn + uD0) / 2, -(hw + 3.5)), aim: W((uIn + uD0) / 2 + 10, 0) },
    { p: W(uOut + 16, -(hw + 3.5)), aim: W(uOut + 28, 0) },
  ];
  // Sodium on the haul road's shoulders, sides in turn, and along the perimeter's inner edge.
  for (let u = 70, k = 0; u < Lu - 60; u += 85, k++) towerSpots.push({ p: W(u, (k % 2 ? 1 : -1) * (hw + 4.6)), aim: W(u + 22, 0) });
  for (let f = 0.12; f < 0.95; f += 0.16) {
    const q = perimAt(f);
    towerSpots.push({ p: add(q.p, q.inward, Pm.width / 2 + 1.6), aim: add(q.p, q.t, 18) });
  }
  for (const t of towerSpots) {
    const s = putSolid('tower', t.p, F.u, C.tower.base, C.tower.base, 0.8);
    if (s) towers.push({ x: s.x, z: s.z, aim: t.aim });
  }

  // ---- The press across the canyon's last straight.
  const pressU = ut - C.press.from;
  const pc = W(pressU, dK);
  const pt = unit(W(pressU + 1, dK).x - W(pressU - 1, dK).x, W(pressU + 1, dK).z - W(pressU - 1, dK).z);
  const pn = { x: -pt.z, z: pt.x };
  const press = { a: add(pc, pn, -aw), b: add(pc, pn, aw), nx: -pt.x, nz: -pt.z };

  // ---- Surfaces.
  const quad = (c: Vec2, ax: Vec2, length: number, width: number) => box(c.x, c.z, ax.x, ax.z, length, width);
  const slicks: Vec2[][] = [];
  const HS = C.haulSlick;
  for (let i = 0; i < HS.count; i++) {
    const u = Lu * (0.26 + (0.5 * i) / Math.max(1, HS.count - 1)) + rng.range(-8, 8);
    const c = W(u, rng.range(-HS.offset, HS.offset));
    const t = unit(W(u + 1, 0).x - W(u - 1, 0).x, W(u + 1, 0).z - W(u - 1, 0).z);
    const yaw = rng.range(-0.35, 0.35);
    slicks.push(quad(c, unit(t.x * cos(yaw) - t.z * sin(yaw), t.z * cos(yaw) + t.x * sin(yaw)), HS.size[0], HS.size[1]));
  }
  // Mud in the Eight: on the first bowl's far side and the second's way out.
  for (const [c, deg] of [
    [cA, 112],
    [cB, 288],
  ] as const) {
    const p = at(c, deg);
    const tan = { x: -sin(deg * DEG) * ex.x + cos(deg * DEG) * ey.x, z: -sin(deg * DEG) * ex.z + cos(deg * DEG) * ey.z };
    slicks.push(quad(p, unit(tan.x, tan.z), E.mud[0], E.mud[1]));
  }
  // Oil in the canyon's aisle, the truck wash's wet patch on the perimeter.
  const oilU = j1 + 11 + (ut - j1 - 11) * 0.3;
  slicks.push(quad(W(oilU, dK), pt, C.canyon.slick[0], C.canyon.slick[1]));
  slicks.push(quad(wash.p, wash.t, Pm.wash[0], Pm.wash[1]));
  // Dirt on the bowls' outsides, under the falling side of each bank.
  const dirt: Vec2[][] = [];
  for (const b of bowls) {
    const r0 = b.rOut + b.hold * 0.5;
    const r1 = reachOf(b) + E.dirt;
    const span = b.half - b.taper;
    const n = Math.max(2, Math.ceil((2 * span) / (12 * DEG)));
    for (let k = 0; k < n; k++) {
      const t0 = b.mid - span + (2 * span * k) / n;
      const t1 = b.mid - span + (2 * span * (k + 1)) / n;
      const pt0 = (r: number, t: number) => ({ x: b.cx + cos(t) * r, z: b.cz + sin(t) * r });
      dirt.push([pt0(r0, t0), pt0(r1, t0), pt0(r1, t1), pt0(r0, t1)]);
    }
  }
  // Concrete: the haul road's own strip and the widening apron at each end.
  const concrete: Vec2[][] = [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let u = 0; u <= Lu + 1e-6; u += Math.min(10, Lu - u || 10)) {
    left.push(W(u, -hw));
    right.push(W(u, hw));
    if (u >= Lu) break;
  }
  concrete.push([...left, ...right.reverse()]);
  const wX = (dir > 0 ? region.widthX : region.widthE) / 2;
  concrete.push([W(0, -(wE + 4)), W(40, -(hw + 12)), W(40, hw + 12), W(0, wE + 4)]);
  concrete.push([W(Lu - 40, -(hw + 12)), W(Lu, -(wX + 4)), W(Lu, wX + 4), W(Lu - 40, hw + 12)]);

  // ---- The fence: the ring with the spine's mouths and the perimeter's mouths open.
  const fences: YardFencePiece[] = regionFence(region, C.fence.piece).filter((p) => {
    const mx = (p.ax + p.bx) / 2;
    const mz = (p.az + p.bz) / 2;
    return mouths.every((m) => Math.hypot(mx - m.x, mz - m.z) > Pm.mouth / 2);
  });
  // A steel post at each end of a gap in the fence: the spine's mouths and the perimeter's.
  for (const p of fences) {
    for (const [x, z] of [
      [p.ax, p.az],
      [p.bx, p.bz],
    ]) {
      const open = !fences.some((q) => q !== p && (Math.hypot(q.ax - x, q.az - z) < 0.05 || Math.hypot(q.bx - x, q.bz - z) < 0.05));
      if (!open) continue;
      const c = { x: x + p.nx * 0.4, z: z + p.nz * 0.4 };
      if (solids.some((s) => s.kind === 'post' && Math.hypot(s.x - c.x, s.z - c.z) < 1)) continue;
      const ax = unit(p.bx - p.ax, p.bz - p.az);
      solids.push({ x: c.x, z: c.z, ax: ax.x, az: ax.z, length: 0.7, depth: 0.7, poly: box(c.x, c.z, ax.x, ax.z, 0.7, 0.7), kind: 'post' });
    }
  }

  // ---- The fill: scrap mountains over everything left.
  const raster = new FillRaster(F.o, F.u, F.n, region.polygon);
  const fc = C.fill.clear;
  for (const l of groundLines) raster.polyline(l.path, l.half + fc);
  // The haul road's shoulders and the apron at both ends.
  raster.polyline(spinePath, hw + C.shoulder);
  for (const q of concrete.slice(1)) raster.polygonArea(q, 1);
  // Set pieces: the bowls and their dirt, the deck, the kicker and the pit, the launch's flight, the canyon's aisle and its walls.
  for (const c of [cA, cB]) raster.circle(c, reach + E.dirt + 1);
  raster.polygonArea(deckPoly, 1.5);
  raster.polyline([add(kFoot, kDir, -4), add(kLip, kDir, pit.s1 + 2)], C.pit.halfWidth + 1.5);
  for (const [p, q] of clearRuns) raster.polyline([p, q], 5);
  raster.polyline(canyonAisle, aw + 0.3);
  for (const s of stacks) raster.polygonArea(s.poly, 0.3);
  for (const s of solids) raster.polygonArea(s.poly, s.kind === 'tower' || s.kind === 'post' ? 0.6 : 1.6);
  for (const t of towers) raster.circle(t, 2);
  // The crane swings over its pile: a clear circle under the boom for the pile to stand in on its own.
  raster.circle(craneTip, 5);
  const heaps = raster.heaps((x, z) => lineGap(x, z), new Rng(deriveSeed(P.seed, 'scrapyard:heaps')));
  // The crane's pile and each bowl's middle: heaps of their own.
  const pile = (c: Vec2, r: number, height: number): ScrapHeap => {
    const ax = unit(cr.t.x, cr.t.z);
    return { x: c.x, z: c.z, ax: ax.x, az: ax.z, length: r * 2, depth: r * 1.6, height, poly: box(c.x, c.z, ax.x, ax.z, r * 2, r * 1.6) };
  };
  heaps.push(pile(craneTip, 4, 4.5));
  for (const c of [cA, cB]) {
    const r = E.islandRadius - St.depth / 2 - 0.6;
    heaps.push({ x: c.x, z: c.z, ax: ex.x, az: ex.z, length: r * 1.4, depth: r * 1.4, height: 5.5, poly: box(c.x, c.z, ex.x, ex.z, r * 1.4, r * 1.4) });
  }

  // ---- Clutter: destructibles on every alt line and the haul road's shoulders, each clear of every line's width.
  const clutter: DistrictPropSpec[] = [];
  const PR = { tyreStack: 0.5, drum: 0.32, crate: 0.6, pallets: 0.62, cableSpool: 0.8, trashBags: 0.5, sawhorse: 0.7 } as const;
  type Kind = keyof typeof PR;
  const propFits = (x: number, z: number, r: number): boolean => {
    if (!pointInPolygon(x, z, region.polygon) || distToPolygonEdge(x, z, region.polygon) < r + 1) return false;
    if (lineGap(x, z) < r + 0.15) return false;
    if (pointInPolygon(x, z, deckPoly)) return false;
    if (!shoulderClear({ x, z })) return false;
    if (keepOut.slice(2).some((k) => Math.hypot(x - k.c.x, z - k.c.z) < k.r + r)) return false;
    for (const s of [...stacks, ...solids, ...heaps]) {
      if (Math.hypot(x - s.x, z - s.z) > Math.max(s.length, s.depth) / 2 + r + 1) continue;
      if (pointInPolygon(x, z, s.poly) || distToPolygonEdge(x, z, s.poly) < r + 0.3) return false;
    }
    if (clutter.some((c) => Math.hypot(c.x - x, c.z - z) < r + 1.0)) return false;
    return true;
  };
  const put = (kind: Kind, p: Vec2, lift = 0): void => {
    if (lift === 0 && !propFits(p.x, p.z, PR[kind])) return;
    clutter.push({ kind, x: p.x, z: p.z, yaw: rng.next() * 6.28, lift, area: a.id });
  };
  // The haul road's shoulders: drums and pallets in twos and threes.
  for (let u = 50; u < Lu - 40; u += rng.range(16, 30)) {
    const side = rng.chance(0.5) ? 1 : -1;
    const base = W(u, side * (hw + 1.4 + rng.range(0, 2.5)));
    const kinds: Kind[] = rng.chance(0.5) ? ['drum', 'drum', 'pallets'] : ['pallets', 'drum'];
    kinds.forEach((k, i) => put(k, add(base, F.u, i * 1.6)));
  }
  // The canyon: tyre stacks, drums and spools staggered either side of its clear core, none at the press.
  const mix: Kind[] = ['tyreStack', 'drum', 'tyreStack', 'cableSpool', 'drum', 'tyreStack', 'crate'];
  const core = C.canyon.lineWidth / 2;
  {
    let i = 0;
    for (let k = 0; k + 1 < canyonAisle.length; k++) {
      const p = canyonAisle[k];
      const q = canyonAisle[k + 1];
      const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      const t = unit(q.x - p.x, q.z - p.z);
      const n = { x: -t.z, z: t.x };
      for (let x = 4; x < len - 4; x += 5.5, i++) {
        const c = add(p, t, x);
        if (Math.hypot(c.x - pc.x, c.z - pc.z) < 6) continue;
        const kind = mix[i % mix.length];
        const off = (i % 2 ? 1 : -1) * Math.min(aw - PR[kind] - 0.12, core + PR[kind] + 0.2);
        put(kind, add(c, n, off));
      }
    }
  }
  // The Eight: tyre stacks round the inside of the ride (between the islands and the line), drums at the neck.
  for (const c of [cA, cB]) {
    for (let k = 0; k < 10; k++) {
      const ang = (k / 10) * Math.PI * 2 + 0.3;
      put('tyreStack', { x: c.x + cos(ang) * (ride - C.eight.width / 2 - 1.4), z: c.z + sin(ang) * (ride - C.eight.width / 2 - 1.4) });
    }
  }
  for (const s of [-1, 1]) put('drum', local(Lx, neck, s * 2, -reach + 3));
  for (const s of [-1, 1]) put('drum', local(Lx, neck, s * 2.5, reach - 3));
  // The deck: tyre stacks and drums along its parapets (on the deck, lifted), never in the landing or at the drop.
  for (let u = deckFlatU0 + 6; u < deckFlatU1 - 6; u += 13) {
    if (gaps.some(([g0, g1]) => u > g0 - 4 && u < g1 + 4)) continue;
    const side = Math.round(u / 13) % 2 ? 1 : -1;
    const edge = side > 0 ? outer - D.parapet : inner + D.parapet;
    const kind: Kind = rng.chance(0.5) ? 'tyreStack' : 'drum';
    put(kind, W(u, edge - side * (PR[kind] + 0.15)), D.height);
  }
  // The perimeter: pallets, spools, sawhorses and bags along its inner edge.
  for (let f = 0.04; f < 0.97; f += 0.055) {
    const q = perimAt(f);
    const kind: Kind = (['pallets', 'cableSpool', 'sawhorse', 'trashBags', 'drum'] as const)[Math.floor(rng.next() * 5)];
    put(kind, add(q.p, q.inward, Pm.lineWidth / 2 + PR[kind] + 0.3));
  }

  return {
    frame: F,
    dir,
    R,
    reach,
    ride,
    bowls,
    dishes,
    centers: [cA, cB],
    neck,
    ex,
    ey,
    lines,
    stacks,
    heaps,
    fences,
    solids,
    kicker: { foot: kFoot, lip: kLip, dir: kDir },
    pit,
    launch,
    hump: { o: W(H.from, 0), dir: unit(W(H.from + 1, 0).x - W(H.from - 1, 0).x, W(H.from + 1, 0).z - W(H.from - 1, 0).z), half: hw + 2 },
    deck: { u0: uD0, u1: uD1, dC, inner, outer, polygon: deckPoly, parapets, passage: passageU, gaps },
    canyon: { centre: canyonAisle, leg: [Kt, legEnd] },
    press,
    slicks,
    dirt,
    concrete,
    gantry,
    portal,
    crane: { base: craneBase, tip: craneTip },
    shredder: shredderC,
    mouths,
    towers,
    clutter,
  };
}

/** The lines entry to exit as the region stores them (the layout keeps driving order). */
export function scrapLines(a: Area, r: Region): FeatureLine[] {
  const L = scrapLayout(a);
  return L.lines.map((l) => (l.id === 'spine' || L.dir > 0 ? l : { ...l, path: l.path.slice().reverse() })).map((l) => {
    // Pin the ends to the region's junctions exactly (the spine's cut points are interpolated).
    const p = l.path.slice();
    p[0] = { x: r.path[0].x, z: r.path[0].z };
    p[p.length - 1] = { x: r.path[r.path.length - 1].x, z: r.path[r.path.length - 1].z };
    return { ...l, path: p };
  });
}
