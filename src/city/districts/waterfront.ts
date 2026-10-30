/**
 * Waterfront: one side of the map becomes a harbor, on about a third of
 * seeds. Past the outermost street on that side, where a row of buildings
 * stood with their backs to nothing, the frontage opens onto a quay: drivable
 * paving at sidewalk level out to a sea wall, a railing ('quayRail') along
 * its edge, lanterns and dock clutter along the rail, and beyond it the
 * ground drops under open water out to the horizon. Jetties with gantry
 * cranes, container stacks and the odd moored ship stand out on the water as
 * the harbor's skyline, render only behind the railing's closed gates.
 *
 * Planned after the routes and every other feature that reaches the city's
 * edge (the El and its run-off to its portal, the channel ends, the
 * expressway's deck, the bluff): each side's free stretch is what is left of
 * it once those keep CFG.clearance m away along it, and the side with the
 * longest stretch (open ends, an even quay height and the routes running
 * along it count for it) wins. The graph is untouched and no face is
 * claimed: the quay is outer face ground.
 *
 * Geometry, in the side's frame (waterfrontShape.ts: u along the side, v out
 * to sea): the city outline's furthest reach past each u (ringProfile, the
 * outer face's ring) dilated, smoothed and pushed CFG.quayWidth out is the
 * coast line, the sea wall's edge. The quay runs from the outline to the
 * coast between its ends pa and pb: a city corner (the end is open, the water
 * and a render only quay run on past it) or, where something else stands
 * beyond the frontage, a breakwater. Its ends are fences ('quayFence') from
 * the outline to the railing. A recess of the outline deeper than
 * CFG.maxDepth (an outer street missing, so the outline dips a block in) is a
 * warehouse: its frontage gets the 'warehouse' look and its back wall stands
 * on the quay, so the quay stays one even strip. The quay is open in every
 * mode: a dock yard to drive (waterfrontYard.ts: mouths onto the streets,
 * the lane along the water, loading ramps, a skid pad, the container lane,
 * soft clutter to smash), paved 'quay' (dock concrete with a grip of its
 * own). It used to be closed off along its frontage in a race by a line of
 * race barriers drawn into the district's meshes; the menu's scene, built
 * from the race world, lent that drawing to free roam, whose world had no
 * such walls, so the harbor showed a wall a car drove straight through.
 *
 * The water is a plane tilted gently along the coast (a least squares fit of
 * the quay's height, tilt capped at CFG.maxTilt), CFG.freeboard below the
 * quay's lowest point; the ground past the sea wall drops to CFG.depth below
 * it (waterfrontShape.ts harborLowering). The quay is the base terrain:
 * nothing inland changes height.
 *
 * A harbor is working docks (Area.variant 'harbor'), leisure moorings ('marina', its own stream) or, in a Miami home
 * mostly and elsewhere now and then, a beach ('beach', waterfrontBeach.ts; beachRolled, a stream of its own, so a seed
 * that does not roll or finds no flat enough stretch plans the harbor it always did). A beach pushes the coast
 * BEACH.quayWidth out from the frontage, takes the longest stretch of the free side whose ground stays near the water's
 * plane at the dune edge (its ends closed by breakwaters), and swaps the dock yard for sand, a boardwalk, a surf wall in
 * place of the sea wall's railing, and the beachfront's dressing. Everything else (the coast, the water, moles, buoys,
 * the frontage's openings) is the harbor's.
 */
import { CITY } from '../config';
import { createTerrain, type Terrain } from '../terrain';
import { RAIL } from '../railCurve';
import { type Vec2, atan2, sqrt } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { AreaBuild, DistrictModule, PlanContext } from './types';
import { emptyBuild } from './types';
import { polygonArea, polyWalls } from './geom';
import { buildYard } from './waterfrontYard';
import { beachGround, buildBeach } from './waterfrontBeach';
import { homeOf } from '../regions';
import { HARBOR_SIDES, type HarborFrame, coastNormal, coastSlope, coastV, framePoint, frameU, frameV, harborLowering, harborWater } from './waterfrontShape';

const CFG = CITY.districts.waterfront;
const BEACH = CFG.beach;

/** The deepest the quay reaches back from the coast before a recess is a warehouse (m): a beach's coast carries its own in `md`. */
const maxDepthOf = (p: Record<string, number>): number => p.md ?? CFG.maxDepth;

/** Columns of the quay's outline every this many m along the coast (and at every vertex of the city's outline). */
const COLUMN = 2;
/** The 'water' surface reaches this far past the coast (m): beyond anything a car could reach, inside the areas' raster. */
const SURFACE_REACH = 180;
/** Kinds whose terrain modifiers reach well past their outline (a hill's slopes): they keep this much further from the harbor (m). */
const SLOPED: ReadonlySet<string> = new Set(['hills', 'bluff', 'tunnel']);
const SLOPE_REACH = 40;

/**
 * The city's outline seen from a side: for each u, the furthest v the outer face's ring reaches (its
 * outermost crossing of the line u = const), -Infinity past its ends. The ring runs along the outer
 * sidewalk lines, so this is the frontage line wherever the outline faces the side.
 */
export interface RingProfile {
  at(u: number): number;
  /** u of every ring vertex. */
  us: number[];
  min: number;
  max: number;
}

export function ringProfile(ring: readonly Vec2[], f: HarborFrame): RingProfile {
  const n = ring.length;
  const au = new Float64Array(n);
  const av = new Float64Array(n);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    au[i] = frameU(f, ring[i].x, ring[i].z);
    av[i] = frameV(f, ring[i].x, ring[i].z);
    min = Math.min(min, au[i]);
    max = Math.max(max, au[i]);
  }
  // Segments by 8 m bins of u, so a query visits a handful.
  const BIN = 8;
  const bins: number[][] = Array.from({ length: Math.ceil((max - min) / BIN) + 1 }, () => []);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = Math.floor((Math.min(au[i], au[j]) - min) / BIN);
    const b = Math.floor((Math.max(au[i], au[j]) - min) / BIN);
    for (let k = a; k <= b; k++) bins[k].push(i);
  }
  return {
    us: Array.from(au),
    min,
    max,
    at(u: number): number {
      if (u < min || u > max) return -Infinity;
      let best = -Infinity;
      for (const i of bins[Math.min(bins.length - 1, Math.floor((u - min) / BIN))]) {
        const j = (i + 1) % n;
        const a = au[i];
        const b = au[j];
        if ((a - u) * (b - u) > 0) continue;
        const v = a === b ? Math.max(av[i], av[j]) : av[i] + ((av[j] - av[i]) * (u - a)) / (b - a);
        if (v > best) best = v;
      }
      return best;
    },
  };
}

/** One side, measured for a harbor. */
interface SideFit {
  side: number;
  f: HarborFrame;
  prof: RingProfile;
  /** u of the side's two corner nodes (cA < cB). */
  cA: number;
  cB: number;
  /** The coast samples (params c0..). */
  coast: Record<string, number>;
  pa: number;
  pb: number;
  openA: boolean;
  openB: boolean;
  w0: number;
  wt: number;
  /** The stretch of u the water's tilt was fitted to (it is level beyond). */
  wu0: number;
  wu1: number;
  score: number;
  /** A beach's fit: the most the ground at the dune edge strays from the water-plane's profile (m). */
  resid: number;
}

/** The quay's back edge at u: the outline, or the max depth in from the coast across a warehouse's recess. */
function innerAt(prof: RingProfile, p: Record<string, number>, sheds: readonly [number, number][], u: number): number {
  const r = prof.at(u);
  const c = coastV(p, u) - maxDepthOf(p);
  return r < c && sheds.some(([a, b]) => u > a && u < b) ? c : r;
}

/**
 * The recesses of the outline deeper than CFG.maxDepth between pa and pb that are warehouses: u intervals,
 * their ends where the outline crosses the line maxDepth in from the coast (to a centimetre).
 */
function shedRuns(prof: RingProfile, p: Record<string, number>, pa: number, pb: number): [number, number][] {
  const deep = (u: number) => prof.at(u) < coastV(p, u) - maxDepthOf(p);
  const edge = (lo: number, hi: number): number => {
    // lo is shallow, hi deep (or the other way): bisect to the crossing.
    const dLo = deep(lo);
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2;
      if (deep(m) === dLo) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  const runs: [number, number][] = [];
  let start: number | null = null;
  let prev = pa;
  for (let u = pa; u <= pb + 1e-6; u += 1) {
    const d = deep(u);
    if (d && start === null) start = u === pa ? pa : edge(prev, u);
    if (!d && start !== null) {
      runs.push([start, edge(prev, u)]);
      start = null;
    }
    prev = u;
  }
  if (start !== null) runs.push([start, pb]);
  // Too shallow or too narrow for a shed: those stay quay.
  return runs.filter(([a, b]) => {
    if (b - a < CFG.shedMinWidth) return false;
    let most = 0;
    for (let u = a; u <= b; u += 1) most = Math.max(most, coastV(p, u) - maxDepthOf(p) - prof.at(u));
    return most >= CFG.shedMinDepth;
  });
}

/** Measure one side: its coast, the free stretch for a quay, the water level and how good a harbor it makes. */
function fitSide(ctx: PlanContext, ring: readonly Vec2[], side: number, base: Terrain, beach = false): SideFit | null {
  const g = ctx.graph;
  /** The narrowest the quay gets from the frontage to the water (m): a beach is deeper, for its sand and a boardwalk. */
  const qw = beach ? BEACH.quayWidth : CFG.quayWidth;
  const f = HARBOR_SIDES[side];
  const prof = ringProfile(ring, f);
  const W = g.plan.gridW;
  const H = g.plan.gridH;
  // The side's corner nodes: the grid's corners on its outer row or column.
  const onSide = (gi: number, gj: number) => (side === 0 ? gj === H - 1 : side === 1 ? gj === 0 : side === 2 ? gi === W - 1 : gi === 0);
  const corners = g.nodes.filter((n) => n.gi >= 0 && (n.gi === 0 || n.gi === W - 1) && (n.gj === 0 || n.gj === H - 1) && onSide(n.gi, n.gj));
  if (corners.length !== 2) return null;
  const ends = corners.map((n) => frameU(f, n.x, n.z)).sort((a, b) => a - b);
  const cA = ends[0];
  const cB = ends[1];

  // A wide street ending at the outer column rounds its sidewalk (a disc of half its width plus the sidewalk)
  // past the outline: the coast clears that cap too, or it would show over the quay's concrete.
  const caps: { u: number; v: number; r: number }[] = [];
  for (const e of g.edges) {
    for (const id of [e.a, e.b]) {
      const n = g.nodes[id];
      const u = frameU(f, n.x, n.z);
      const v = frameV(f, n.x, n.z);
      const r = e.width / 2 + e.sidewalk;
      // Only streets ending inside the outline: nodes past it belong to other districts, which the blockers keep clear.
      const ring = prof.at(Math.max(cA, Math.min(cB, u)));
      if (u >= cA - r && u <= cB + r && v <= ring && v + r > ring) caps.push({ u, v, r });
    }
  }
  const reachAt = (u: number): number => {
    let best = prof.at(u);
    if (best === -Infinity) return best;
    for (const c of caps) {
      const du = u - c.u;
      if (Math.abs(du) < c.r) best = Math.max(best, c.v + sqrt(c.r * c.r - du * du));
    }
    return best;
  };

  // The coast: the outline's furthest reach over ±dilate (within the side), box smoothed, quayWidth out.
  const K = Math.ceil((cB - cA) / COLUMN);
  const rv = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) rv[k] = reachAt(cA + k * COLUMN);
  const reach = Math.round(CFG.dilate / COLUMN);
  const env = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) {
    let m = -Infinity;
    for (let j = Math.max(0, k - reach); j <= Math.min(K, k + reach); j++) m = Math.max(m, rv[j]);
    env[k] = m;
  }
  const envAt = (u: number) => env[Math.max(0, Math.min(K, Math.round((u - cA) / COLUMN)))];
  const half = CFG.smoothSpan / 2;
  const smooth = (u: number) => {
    let s = 0;
    let n = 0;
    for (let w = -half; w <= half + 1e-6; w += COLUMN) {
      s += envAt(u + w);
      n++;
    }
    return s / n;
  };
  const step = CFG.step;
  const cx0 = cA - CFG.runOn - CFG.fadeOut - 3 * step;
  const cn = Math.ceil((cB + CFG.runOn + CFG.fadeOut + 3 * step - cx0) / step) + 1;
  const cs = new Float64Array(cn);
  for (let i = 0; i < cn; i++) cs[i] = smooth(Math.max(cA, Math.min(cB, cx0 + i * step))) + qw;
  // A fresh params object per change: the interpolation caches the samples per object.
  const record = (): Record<string, number> => {
    const o: Record<string, number> = { cx0, cdx: step, cn };
    for (let i = 0; i < cn; i++) o[`c${i}`] = cs[i];
    if (beach) o.md = BEACH.maxDepth;
    return o;
  };
  let coast = record();
  // Smoothing wider than the dilation (and the interpolation) leaves the coast short of quayWidth here and
  // there: push the samples near every shortfall out by it until the quay is never narrower than quayWidth
  // less a little.
  for (let pass = 0; pass < 8; pass++) {
    const short = new Float64Array(cn);
    let worst = 0;
    for (let u = cA; u <= cB; u += 1) {
      const d = reachAt(u) + qw - coastV(coast, u);
      if (d <= 0.2) continue;
      worst = Math.max(worst, d);
      const k = Math.round((u - cx0) / step);
      for (let i = Math.max(0, k - 2); i <= Math.min(cn - 1, k + 2); i++) short[i] = Math.max(short[i], d + 0.05);
    }
    if (!worst) break;
    for (let i = 0; i < cn; i++) cs[i] += short[i];
    coast = record();
  }

  // Blockers: whatever other districts put past the frontage keeps `clearance` along the side.
  const blocked: [number, number][] = [];
  const block = (x: number, z: number, extra: number) => {
    const u = frameU(f, x, z);
    const v = frameV(f, x, z);
    if (u < cx0 || u > cx0 + (cn - 1) * step) return;
    const inSide = u >= cA - 12 && u <= cB + 12;
    const limit = inSide ? prof.at(Math.max(cA, Math.min(cB, u))) + 1 - extra : coastV(coast, u) - qw - 40;
    if (v > limit) blocked.push([u - CFG.clearance, u + CFG.clearance]);
  };
  for (const a of ctx.areas) {
    const extra = SLOPED.has(a.kind) ? SLOPE_REACH : 0;
    for (const q of a.polygon) block(q.x, q.z, extra);
    for (const q of a.path) block(q.x, q.z, extra);
    // The El runs on past its path's ends to its portals, far out (railCurve.ts RAIL.runOff).
    if (a.kind === 'subway' && a.path.length > 1) {
      for (const [e, o] of [
        [a.path[0], a.path[1]],
        [a.path[a.path.length - 1], a.path[a.path.length - 2]],
      ]) {
        const l = sqrt((e.x - o.x) ** 2 + (e.z - o.z) ** 2) || 1;
        for (let s = 0; s <= RAIL.runOff + 60; s += 10) block(e.x + ((e.x - o.x) / l) * s, e.z + ((e.z - o.z) / l) * s, 0);
      }
    }
  }
  const free = (u: number) => !blocked.some(([a, b]) => u > a && u < b);
  // The longest free stretch of the side.
  let best: [number, number] | null = null;
  let run: number | null = null;
  for (let u = cA; u <= cB + 1e-6; u += COLUMN) {
    if (free(u)) {
      run ??= u;
      if (!best || u - run > best[1] - best[0]) best = [run, u];
    } else run = null;
  }
  const minLength = beach ? BEACH.minLength : CFG.minLength;
  if (!best || best[1] - best[0] < minLength) return null;
  let [pa, pb] = best;
  // An end at the corner is open when nothing stands past it along the run on either.
  let openA = pa <= cA + COLUMN && [...Array(Math.ceil((CFG.runOn + CFG.fadeOut) / 10))].every((_, k) => free(cA - k * 10));
  let openB = pb >= cB - COLUMN && [...Array(Math.ceil((CFG.runOn + CFG.fadeOut) / 10))].every((_, k) => free(cB + k * 10));
  if (pa <= cA + COLUMN) pa = cA;
  if (pb >= cB - COLUMN) pb = cB;
  // A closed end leaves room for its breakwater inside the stretch.
  if (!openA && pa > cA) pa += CFG.mole;
  if (!openB && pb < cB) pb -= CFG.mole;
  // Never end the quay inside a warehouse's recess: step the end out past its side.
  for (const [a, b] of shedRuns(prof, coast, pa, pb)) {
    if (a <= pa + 1e-6) pa = b + 1;
    if (b >= pb - 1e-6) pb = a - 1;
  }
  if (pb - pa < minLength) return null;

  // A beach takes the longest stretch whose ground stays within BEACH.maxResidual of its own water plane at the
  // dune edge (the hills along a coast run several metres; sand blends only so much): windows from the full length
  // down, the first that fits (the flattest of its length), its ends closed by a breakwater unless it keeps the stretch's.
  if (beach) {
    const stats = (a: number, b: number, oa: boolean, ob: boolean): number => {
      const uu: number[] = [];
      const hh: number[] = [];
      for (let u = a - (oa ? CFG.quayRun : 0); u <= b + (ob ? CFG.quayRun : 0) + 1e-6; u += 8) {
        const q = framePoint(f, u, coastV(coast, u) - BEACH.sand);
        uu.push(u);
        hh.push(base.heightAt(q.x, q.z));
      }
      const m0 = uu.reduce((t, u) => t + u, 0) / uu.length;
      const m1 = hh.reduce((t, h) => t + h, 0) / hh.length;
      let xy = 0;
      let xx = 0;
      for (let i = 0; i < uu.length; i++) {
        xy += (uu[i] - m0) * (hh[i] - m1);
        xx += (uu[i] - m0) ** 2;
      }
      const slope = Math.max(-CFG.maxTilt, Math.min(CFG.maxTilt, xx > 0 ? xy / xx : 0));
      let r = 0;
      for (let i = 0; i < uu.length; i++) if (uu[i] >= a && uu[i] <= b) r = Math.max(r, Math.abs(hh[i] - slope * uu[i] - (m1 - slope * m0)));
      return r;
    };
    let pick: { a: number; b: number; oa: boolean; ob: boolean; r: number } | null = null;
    for (let len = pb - pa; len >= minLength - 1e-6 && !pick; len -= 40) {
      for (let a = pa; a + len <= pb + 1e-6; a += 40) {
        const b = a + len;
        const oa = openA && a <= pa + 1e-6;
        const ob = openB && b >= pb - 1e-6;
        const r = stats(a, b, oa, ob);
        if (r <= BEACH.maxResidual && (!pick || r < pick.r)) pick = { a, b, oa, ob, r };
      }
    }
    if (!pick) return null;
    pa = pick.a;
    pb = pick.b;
    openA = pick.oa;
    openB = pick.ob;
  }

  // The water level: a fit of the quay's height along the coast (and the furnished run on past an open
  // end), its tilt capped, lowered until the quay stands freeboard over it everywhere.
  const fa = pa - (openA ? CFG.quayRun : 0);
  const fb = pb + (openB ? CFG.quayRun : 0);
  const us: number[] = [];
  const hs: number[] = [];
  for (let u = fa; u <= fb + 1e-6; u += 8) {
    // A beach reads the ground at its dune edge, where the sand's slope meets it; a harbor at the wall's edge.
    const q = framePoint(f, u, coastV(coast, u) - (beach ? BEACH.sand : 1));
    us.push(u);
    hs.push(base.heightAt(q.x, q.z));
  }
  const mu = us.reduce((s, u) => s + u, 0) / us.length;
  const mh = hs.reduce((s, h) => s + h, 0) / hs.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < us.length; i++) {
    sxy += (us[i] - mu) * (hs[i] - mh);
    sxx += (us[i] - mu) ** 2;
  }
  const wt = Math.max(-CFG.maxTilt, Math.min(CFG.maxTilt, sxx > 0 ? sxy / sxx : 0));
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < us.length; i++) {
    lo = Math.min(lo, hs[i] - wt * us[i]);
    hi = Math.max(hi, hs[i] - wt * us[i]);
  }
  // A harbor's water stands freeboard under its lowest quay; a beach's so that the sand's slope (rising from the waterline,
  // under the curb's lift) meets the ground at the dune edge on average: the blend takes up what the ground strays from it.
  const w0 = beach ? mh - wt * mu + CITY.curbHeight - BEACH.slope * BEACH.sand : lo - CFG.freeboard;
  let resid = 0;
  for (let i = 0; i < us.length; i++) if (us[i] >= pa && us[i] <= pb) resid = Math.max(resid, Math.abs(hs[i] - wt * us[i] - (mh - wt * mu)));
  // Longer quays, open ends (the water runs on to the horizon) and an even wall height make better harbors,
  // and one the races run along (route nodes on the street behind the quay) best of all.
  let raced = 0;
  for (const r of ctx.event?.routes ?? []) {
    for (const id of r.nodes) {
      const n = g.nodes[id];
      const u = frameU(f, n.x, n.z);
      if (u > pa && u < pb && frameV(f, n.x, n.z) > coastV(coast, u) - qw - CFG.raceReach) raced++;
    }
  }
  const score = pb - pa + (openA ? 160 : 0) + (openB ? 160 : 0) - 30 * (hi - lo) + CFG.raceBonus * Math.min(raced, 12);
  return { side, f, prof, cA, cB, coast, pa, pb, openA, openB, w0, wt, wu0: fa, wu1: fb, score, resid };
}

/** Whether a seed rolls a harbor: the first draw of the module's own stream (the plan may still find no side free enough). */
export function waterfrontRolled(seed: number): boolean {
  return CFG.enabled && new Rng(deriveSeed(seed, 'district:waterfront')).chance(CFG.chance);
}

/**
 * Whether a seed's waterfront is a beach, from a stream of its own (so the draws that follow are the harbor's
 * as they always were): BEACH.chance.miami in a Miami home, BEACH.chance.other elsewhere. The home is the
 * renderer's city identity (city/regions.ts homeOf, a pure pick of the seed), which the city may read without the
 * renderer. A rolled beach still needs a side whose ground sits near enough the water's profile (BEACH.maxResidual).
 */
export function beachRolled(seed: number): boolean {
  const chance = homeOf(seed) === 'miami' ? BEACH.chance.miami : BEACH.chance.other;
  return new Rng(deriveSeed(seed, 'waterfront:beach')).chance(chance);
}

/** The sides' fits for a harbor or a beach, best first; each side takes a little of `rng` so that equal sides vary by seed. */
function rankSides(ctx: PlanContext, ring: readonly Vec2[], base: Terrain, rng: Rng, beach: boolean): SideFit[] {
  const fits: SideFit[] = [];
  for (let s = 0; s < HARBOR_SIDES.length; s++) {
    const fit = fitSide(ctx, ring, s, base, beach);
    const jitter = rng.range(0, 120);
    if (fit) fits.push({ ...fit, score: fit.score + jitter });
  }
  fits.sort((a, b) => b.score - a.score || a.side - b.side);
  return fits;
}

/** Lay the chosen side out as an area (false when the city's budget has no room for it). */
function placeWaterfront(ctx: PlanContext, s: SideFit, rng: Rng, variant: string): boolean {
  const beach = variant === 'beach';
  const p: Record<string, number> = {
    side: s.side,
    ...s.f,
    ...s.coast,
    pa: s.pa,
    pb: s.pb,
    openA: s.openA ? 1 : 0,
    openB: s.openB ? 1 : 0,
    w0: s.w0,
    wt: s.wt,
    wu0: s.wu0,
    wu1: s.wu1,
    depth: CFG.depth,
    fall: beach ? BEACH.shelf : CFG.wallFall,
    seed: rng.int(1, 0x7ffffffe),
  };
  // A beach's sand: its width, slope and the blend into the street's ground (waterfrontBeach.ts beachGround).
  if (beach) Object.assign(p, { beach: 1, sand: BEACH.sand, slope: BEACH.slope, blend: BEACH.blend });
  // Where the lowering fades: past an open end the run on, at a closed one across the breakwater.
  p.eA0 = s.openA ? s.pa - CFG.runOn - CFG.fadeOut : s.pa - CFG.mole;
  p.eA1 = s.openA ? s.pa - CFG.runOn : s.pa;
  p.eB0 = s.openB ? s.pb + CFG.runOn : s.pb;
  p.eB1 = s.openB ? s.pb + CFG.runOn + CFG.fadeOut : s.pb + CFG.mole;
  let vMax = -Infinity;
  for (let u = p.eA0; u <= p.eB1; u += CFG.step) vMax = Math.max(vMax, coastV(p, u));
  p.vf0 = vMax + CFG.reach - CFG.fadeOut;
  p.vf1 = vMax + CFG.reach;
  const sheds = shedRuns(s.prof, p, s.pa, s.pb);
  const { polygon, nBack } = quayOutline(s.prof, p, sheds);
  p.nBack = nBack;
  const footprint = Math.abs(polygonArea(polygon));
  if (ctx.budget.used + footprint > ctx.budget.total) return false;
  // The path is the sea wall's edge along the quay (architecture.ts reads waterside buildings off it).
  const path: Vec2[] = [];
  for (let u = s.pa; u <= s.pb + 1e-6; u += 16) path.push(framePoint(s.f, u, coastV(p, u)));
  ctx.addArea({ kind: 'waterfront', variant, polygon, path, nodes: [], edges: [], faces: [], params: p }, footprint);
  return true;
}

export const waterfrontModule: DistrictModule = {
  kind: 'waterfront',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const outer = ctx.faces().find((x) => x.outer);
    if (!outer) return;
    const base = createTerrain(ctx.seed);
    // A beach first, from a stream of its own so that a seed that finds none plans the harbor it always did: the
    // best side whose ground is near enough the sand's profile, with no warehouse in its frontage.
    if (beachRolled(ctx.seed)) {
      const brng = new Rng(deriveSeed(ctx.seed, 'waterfront:beach:side'));
      const all = rankSides(ctx, outer.ring, base, brng, true);
      const fit = all.find((x) => x.resid <= BEACH.maxResidual && !shedRuns(x.prof, x.coast, x.pa, x.pb).length);
      if (fit && placeWaterfront(ctx, fit, brng, 'beach')) return;
    }
    const fits = rankSides(ctx, outer.ring, base, rng, false);
    if (!fits.length) return;
    // Working docks or leisure moorings: its own stream, so a harbor seed plans and builds exactly as it did before the marina.
    const variant = new Rng(deriveSeed(ctx.seed, 'waterfront:variant')).chance(CFG.marinaChance) ? 'marina' : 'harbor';
    placeWaterfront(ctx, fits[0], rng, variant);
  },

  build(ctx, area) {
    const b = emptyBuild();
    const p = area.params;
    const id = area.id;
    const f: HarborFrame = { ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz };
    const outer = ctx.faces.find((x) => x.outer);
    if (!outer) return b;
    const prof = ringProfile(outer.ring, f);
    const sheds = shedRuns(prof, p, p.pa, p.pb);
    const at = (u: number, v: number) => framePoint(f, u, v);
    const coast = (u: number) => coastV(p, u);
    const rng = new Rng(p.seed);
    const along = (u0: number, u1: number, step: number): number[] => {
      const n = Math.max(1, Math.ceil((u1 - u0) / step));
      return Array.from({ length: n + 1 }, (_, i) => u0 + ((u1 - u0) * i) / n);
    };

    // The ground past the sea wall, lowered under the water; a beach's sand shelves into it instead (waterfrontBeach.ts).
    const beach = area.variant === 'beach';
    b.heightMods.push(beach ? beachGround(p, createTerrain(ctx.seed)) : harborLowering(p, createTerrain(ctx.seed)));

    // The quay: drivable dock paving at sidewalk level, open to the street all along its back. A beach's is the
    // boardwalk, with the sand laid over its seaward part (buildBeach).
    const quay = area.polygon;
    b.surfaces.push({ surface: beach ? 'boardwalk' : 'quay', polygon: quay, priority: 2, area: id });
    b.exclusions.push(quay);
    b.openings.push(quay);
    // The open water, and no building anywhere past the coast (the breakwaters' ground included).
    const water = harborWater(area, SURFACE_REACH);
    b.surfaces.push({ surface: 'water', polygon: water, priority: 1, area: id });
    b.exclusions.push(harborWater(area, SURFACE_REACH, 8, [p.openA ? p.eA1 : p.pa - CFG.mole, p.openB ? p.eB0 : p.pb + CFG.mole]));

    // The railing along the sea wall's edge (normals in onto the quay), end to end. A beach has no wall: the break
    // at the waterline ('surf') is what stops a car where the sand meets the sea.
    const edgeInset = beach ? BEACH.surfInset : CFG.railInset;
    const rail = along(p.pa, p.pb, 4).map((u) => at(u, coast(u) - edgeInset));
    b.walls.push(...polyWalls(rail, true, beach ? 'surf' : 'quayRail', id, false));
    // A fence at each end, from the frontage (a little onto the sidewalk, over the last frontage sample) to the railing.
    const endA = at(p.pa, innerAt(prof, p, sheds, p.pa) - 0.3);
    const endB = at(p.pb, innerAt(prof, p, sheds, p.pb) - 0.3);
    b.walls.push(...polyWalls([endA, at(p.pa, coast(p.pa) - edgeInset)], true, 'quayFence', id, false));
    b.walls.push(...polyWalls([at(p.pb, coast(p.pb) - edgeInset), endB], true, 'quayFence', id, false));
    b.reserved.push({ x: endA.x, z: endA.z, r: 1.6 }, { x: endB.x, z: endB.z, r: 1.6 });

    // The open frontage, the quay's back where it meets the streets (not a shed's back wall).
    {
      const back = quay.slice(0, p.nBack);
      const inShed = (q: Vec2) => {
        const u = frameU(f, q.x, q.z);
        return sheds.some(([a, c]) => u > a + 0.005 && u < c - 0.005);
      };
      let chain: Vec2[] = [];
      for (let i = 0; i + 1 < back.length; i++) {
        if (inShed(back[i]) && inShed(back[i + 1])) {
          if (chain.length > 1) b.hints.push({ kind: 'frontage', points: chain, values: [] });
          chain = [];
          continue;
        }
        if (!chain.length) chain.push(back[i]);
        chain.push(back[i + 1]);
      }
      if (chain.length > 1) b.hints.push({ kind: 'frontage', points: chain, values: [] });
    }

    // Warehouses in the recesses: their frontage takes the shed's look, their back wall faces the quay.
    for (const [a, c] of sheds) {
      const { polygon: shed, nInner } = shedOutline(prof, p, a, c);
      b.exclusions.push(shed);
      b.frontLooks.push({ polygon: shed, look: 'warehouse', area: id });
      const back = along(a, c, 4).map((u) => at(u, coast(u) - maxDepthOf(p)));
      b.walls.push(...polyWalls(back, false, 'warehouse', id, false));
      b.hints.push({ kind: 'warehouse', points: shed, values: [rng.range(CFG.shedHeight[0], CFG.shedHeight[1]), nInner] });
    }

    // Past an open end the quay runs on, render only (a container terminal, paved as deep as the quay may
    // reach): no buildings on it either, the corner buildings of the next side included.
    for (const [open, u0, u1] of [
      [p.openA, p.pa - CFG.quayRun - 130, p.pa],
      [p.openB, p.pb, p.pb + CFG.quayRun + 130],
    ] as const) {
      if (!open) continue;
      const us = along(u0, u1, 8);
      b.exclusions.push([...us.map((u) => at(u, coast(u) - maxDepthOf(p) - 1)), ...us.reverse().map((u) => at(u, coast(u) + 1))]);
    }

    // Jetties along the coast (the quay's and the run on's), each behind a closed gate in the railing.
    const jetties: { u: number; len: number; w: number }[] = [];
    const prop = (kind: string, q: Vec2, yaw: number, size: number, height: number) => b.props.push({ kind, x: q.x, z: q.z, yaw, size, height, area: id });
    /** Out to sea, square to the wall at u, and its yaw (atan2(dx, dz)). */
    const seaward = (u: number) => {
      const { nx, nz } = coastNormal(p, u);
      return { nx, nz, yaw: atan2(nx, nz) };
    };
    if (area.variant === 'marina') marinaDocks(b, p, id, jetties, new Rng(deriveSeed(p.seed, 'marina')), seaward, at, coast);
    else if (!beach) {
      const lo = p.openA ? p.pa - CFG.quayRun + 40 : p.pa + 50;
      const hi = p.openB ? p.pb + CFG.quayRun - 40 : p.pb - 50;
      const want = rng.int(CFG.jetties[0], CFG.jetties[1]);
      for (let tries = 0; tries < 40 && jetties.length < want; tries++) {
        const u = rng.range(lo, hi);
        const w = rng.range(CFG.jettyWidth[0], CFG.jettyWidth[1]);
        if (jetties.some((j) => Math.abs(j.u - u) < CFG.jettyGap)) continue;
        // A jetty stands square to the coast: keep it where the coast runs nearly straight.
        if (Math.abs(coastSlope(p, u - w) - coastSlope(p, u + w)) > 0.08) continue;
        jetties.push({ u, len: rng.range(CFG.jettyLength[0], CFG.jettyLength[1]), w });
      }
      jetties.sort((x, y) => x.u - y.u);
      for (const j of jetties) {
        const n = seaward(j.u);
        const root = at(j.u, coast(j.u));
        const tip = { x: root.x + n.nx * j.len, z: root.z + n.nz * j.len };
        b.hints.push({ kind: 'jetty', points: [root, tip], values: [j.w] });
        // The berth side (where a ship moors), +1 to the jetty's left looking out to sea.
        const side = rng.chance(0.5) ? 1 : -1;
        // Cranes astride the jetty's rails, booms out over the berth; container stacks between the rails clear of them.
        const cranes = rng.int(CFG.cranesPerJetty[0], CFG.cranesPerJetty[1]);
        const boom = atan2(-n.nz * side, n.nx * side);
        const craneAt: number[] = [];
        for (let k = 0; k < cranes; k++) {
          const s = j.len * (cranes === 1 ? 0.55 : 0.35 + 0.4 * k);
          craneAt.push(s);
          prop('crane', { x: root.x + n.nx * s, z: root.z + n.nz * s }, boom, Math.min(CFG.craneGauge, j.w - 2) / 2, rng.range(CFG.craneHeight[0], CFG.craneHeight[1]));
        }
        for (let s = 9; s < j.len - 8; s += 14) {
          if (craneAt.some((c) => Math.abs(c - s) < 15) || !rng.chance(0.7)) continue;
          prop('stack', { x: root.x + n.nx * s, z: root.z + n.nz * s }, n.yaw, 1, rng.int(1, 4));
        }
        // A ship moored at the berth, its stern clear of the sea wall.
        if (rng.chance(CFG.shipChance)) {
          const len = rng.range(CFG.shipLength[0], CFG.shipLength[1]);
          const beam = len * 0.15;
          const o = side * (j.w / 2 + beam / 2 + 1.5);
          const s = len / 2 + 6;
          prop('ship', { x: root.x + n.nx * s - n.nz * o, z: root.z + n.nz * s + n.nx * o }, n.yaw + (rng.chance(0.5) ? 0 : Math.PI), len / 2, beam);
        }
      }
      // The run on quay past an open end: a row of cranes along its edge and container stacks behind.
      for (const [open, u0, u1] of [
        [p.openA, p.pa - CFG.quayRun, p.pa - 30],
        [p.openB, p.pb + 30, p.pb + CFG.quayRun],
      ] as const) {
        if (!open) continue;
        for (let u = u0 + rng.range(10, 30); u < u1; u += CFG.craneStep * rng.range(0.85, 1.2)) {
          if (jetties.some((j) => Math.abs(j.u - u) < j.w / 2 + 14)) continue;
          const n = seaward(u);
          prop('crane', at(u, coast(u) - CFG.craneGauge / 2 - 1), n.yaw, CFG.craneGauge / 2, rng.range(CFG.craneHeight[0], CFG.craneHeight[1]));
        }
        // A stack is three rows of boxes wide (7.3 m): its near edge a couple of metres behind the cranes' landside rail.
        for (let u = u0; u < u1; u += 15) {
          if (!rng.chance(0.75)) continue;
          const n = seaward(u);
          prop('stack', at(u, coast(u) - CFG.craneGauge - 6.7), n.yaw + Math.PI / 2, 1, rng.int(1, 4));
        }
      }
    }
    // A closed end's breakwater: a rubble mole out from the sea wall with a beacon at its tip.
    for (const [open, u, dir] of [
      [p.openA, p.pa - CFG.mole / 2, 1],
      [p.openB, p.pb + CFG.mole / 2, -1],
    ] as const) {
      if (open) continue;
      const n = seaward(u);
      const root = at(u, coast(u) - 1);
      const len = rng.range(CFG.moleLength[0], CFG.moleLength[1]);
      b.hints.push({ kind: 'mole', points: [root, { x: root.x + n.nx * len, z: root.z + n.nz * len }], values: [CFG.mole, dir] });
    }
    // Channel buoys, red to one side and green to the other.
    const buoys = rng.int(CFG.buoys[0], CFG.buoys[1]);
    const [w0, w1] = [p.openA ? p.pa - 200 : p.pa + 40, p.openB ? p.pb + 200 : p.pb - 40];
    for (let k = 0; k < buoys; k++) {
      const u = rng.range(w0, w1);
      const out = rng.range(CFG.buoyReach[0], CFG.buoyReach[1]);
      // Clear of the jetties and the ships at their berths.
      if (jetties.some((j) => Math.abs(j.u - u) < 70 && out < 200)) continue;
      prop('buoy', at(u, coast(u) + out), 0, k % 2 ? 1 : 0, rng.range(0, 1));
    }

    // A beach is its own dressing: the boardwalk's mouths, fences, palms and lamps, the sand's towers, umbrellas, nets,
    // dunes and drift strip, the pier (waterfrontBeach.ts).
    if (beach) {
      buildBeach(ctx, { area, f, back: (u) => innerAt(prof, p, sheds, u), sheds, gates: [], lamps: [] }, b);
      return b;
    }
    // Along the quay's edge: lanterns (destructible park lamps, lit by render/street/areaLights.ts), clear of
    // the jetties' gates and the end fences.
    const curb = CITY.curbHeight;
    const gate = (u: number) => jetties.some((j) => Math.abs(j.u - u) < j.w / 2 + 3);
    const lamps: number[] = [];
    for (let u = p.pa + 12 + rng.range(0, 8); u < p.pb - 10; u += CFG.lampStep) if (!gate(u)) lamps.push(u);
    for (const u of lamps) {
      const q = at(u, coast(u) - CFG.lampInset);
      const n = seaward(u);
      b.destructibles.push({ kind: 'parkLamp', x: q.x, z: q.z, yaw: atan2(-n.nx, -n.nz), lift: curb, area: id });
    }
    // The dock yard on the quay: mouths, fences, the lane and its clutter, ramps, the skid pad, containers, bollards, benches.
    buildYard(ctx, { area, f, back: (u) => innerAt(prof, p, sheds, u), sheds, gates: jetties.map((j) => ({ u: j.u, half: j.w / 2 })), lamps }, b);
    return b;
  },
};

/**
 * A marina's moorings, in place of the working jetties (render only, each behind a closed gate in the railing, so
 * `jetties` takes their roots for the lanterns, bollards and buoys to keep clear of): the yacht club on its deck
 * over the water (hint 'clubhouse': root, values gate width, width, depth; dinghies pulled up on its deck and
 * floating beside it are 'dinghy' props), the fuel dock ('fuel': root, tip, values gate width), and floating
 * pontoons ('pontoon': root, tip, values gate width, spine width, slip length, slip pitch) with finger berths either
 * side and the boats moored in them ('sailboat' / 'yacht' props: centre, yaw, size its length, height its beam).
 * All of it stands where the coast runs nearly straight, at least clubClear m from one another.
 */
function marinaDocks(
  b: AreaBuild,
  p: Record<string, number>,
  id: number,
  jetties: { u: number; len: number; w: number }[],
  rng: Rng,
  seaward: (u: number) => { nx: number; nz: number; yaw: number },
  at: (u: number, v: number) => Vec2,
  coast: (u: number) => number,
): void {
  const lo = p.pa + 50;
  const hi = p.pb - 50;
  const straight = (u: number, w: number) => Math.abs(coastSlope(p, u - w) - coastSlope(p, u + w)) <= 0.08;
  const free = (u: number, gap: number) => !jetties.some((j) => Math.abs(j.u - u) < gap);
  const pick = (gap: number, half: number): number | null => {
    for (let tries = 0; tries < 60; tries++) {
      const u = rng.range(lo, hi);
      if (free(u, gap) && straight(u, half)) return u;
    }
    return null;
  };
  const spineW = 2.4;

  // The yacht club: a deck on piles over the water with the building at the quay's side and the terrace out to sea.
  const [clubW, clubD] = CFG.club;
  const uc = pick(CFG.clubClear, clubW / 2);
  if (uc !== null) {
    const n = seaward(uc);
    const root = at(uc, coast(uc));
    jetties.push({ u: uc, len: clubD, w: 5 });
    b.hints.push({ kind: 'clubhouse', points: [root], values: [5, clubW, clubD] });
    const d = { x: -n.nz, z: n.nx };
    const dinghy = (s: number, o: number, afloat: number) =>
      b.props.push({ kind: 'dinghy', x: root.x + n.nx * s + d.x * o, z: root.z + n.nz * s + d.z * o, yaw: n.yaw + (afloat ? rng.range(-0.6, 0.6) : (rng.chance(0.5) ? 0 : Math.PI) + rng.range(-0.15, 0.15)), size: rng.range(2.5, 3.3), height: afloat, area: id });
    // Pulled up on the deck's ends, bottoms up on their racks, and tied off alongside it afloat.
    for (const side of [-1, 1]) for (let k = 0, m = rng.int(1, 2); k < m; k++) dinghy(clubD - 3 - k * 3.2, side * (clubW / 2 - 2.2), 0);
    for (let k = 0, m = rng.int(1, 3); k < m; k++) dinghy(clubD + 2 + rng.range(0, 1.5), rng.range(-clubW / 2 + 2, clubW / 2 - 2), 1);
  }

  // The fuel dock: a short float out from the wall with its pumps and canopy.
  const uf = pick(CFG.clubClear, 8);
  if (uf !== null) {
    const n = seaward(uf);
    const root = at(uf, coast(uf));
    jetties.push({ u: uf, len: CFG.fuelLength, w: 3 });
    b.hints.push({ kind: 'fuel', points: [root, { x: root.x + n.nx * CFG.fuelLength, z: root.z + n.nz * CFG.fuelLength }], values: [3] });
  }

  // Pontoons: a spine straight out, fingers every pitch, a boat in most of the slips either side.
  const want = rng.int(CFG.pontoons[0], CFG.pontoons[1]);
  const pitch = CFG.slipPitch;
  let made = 0;
  for (let tries = 0; tries < 80 && made < want; tries++) {
    const u = rng.range(lo, hi);
    const slipLen = rng.range(CFG.slipLength[0], CFG.slipLength[1]);
    if (!free(u, Math.max(CFG.pontoonGap, CFG.clubClear)) || !straight(u, slipLen + 4)) continue;
    const len = rng.range(CFG.pontoonLength[0], CFG.pontoonLength[1]);
    jetties.push({ u, len, w: CFG.gangway });
    made++;
    const n = seaward(u);
    const root = at(u, coast(u));
    b.hints.push({ kind: 'pontoon', points: [root, { x: root.x + n.nx * len, z: root.z + n.nz * len }], values: [CFG.gangway, spineW, slipLen, pitch] });
    const slips = Math.floor((len - 7) / pitch);
    for (const side of [-1, 1]) {
      const d = { x: -n.nz * side, z: n.nx * side };
      const heading = atan2(d.x, d.z);
      for (let k = 0; k < slips; k++) {
        if (!rng.chance(CFG.slipFill)) continue;
        const sail = rng.chance(0.6);
        const length = sail ? rng.range(slipLen - 3.5, slipLen - 0.5) : rng.range(slipLen - 2.5, slipLen);
        const beam = Math.min(pitch - 1.4, length * (sail ? 0.31 : 0.33));
        const s = 7 + (k + 0.5) * pitch;
        const o = spineW / 2 + length / 2 + 0.2;
        b.props.push({
          kind: sail ? 'sailboat' : 'yacht',
          x: root.x + n.nx * s + d.x * o,
          z: root.z + n.nz * s + d.z * o,
          yaw: heading + (rng.chance(0.5) ? 0 : Math.PI),
          size: length,
          height: beam,
          area: id,
        });
      }
    }
  }
  jetties.sort((x, y) => x.u - y.u);
}

/**
 * The quay's outline: its back edge (the outline, or maxDepth in from the coast across a shed's recess)
 * column by column from pa to pb, a column either side of every vertex of the outline so its corners are
 * exact, then the coast back from pb to pa. u-monotone, so a renderer zips the two chains into triangles.
 */
function quayOutline(prof: RingProfile, p: Record<string, number>, sheds: readonly [number, number][]): { polygon: Vec2[]; nBack: number } {
  const f: HarborFrame = { ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz };
  const us = columns(prof, p.pa, p.pb, sheds.flat());
  const back = us.map((u) => framePoint(f, u, innerAt(prof, p, sheds, u)));
  const n = Math.max(1, Math.ceil((p.pb - p.pa) / 4));
  const front: Vec2[] = [];
  for (let i = n; i >= 0; i--) {
    const u = p.pa + ((p.pb - p.pa) * i) / n;
    front.push(framePoint(f, u, coastV(p, u)));
  }
  return { polygon: [...back, ...front], nBack: back.length };
}

/**
 * A warehouse's outline: the city's outline across its recess from a to c (its first and last points on the
 * line maxDepth in from the coast), then that line back from c to a; `nInner` is the first chain's length.
 */
function shedOutline(prof: RingProfile, p: Record<string, number>, a: number, c: number): { polygon: Vec2[]; nInner: number } {
  const f: HarborFrame = { ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz };
  const us = columns(prof, a, c, []);
  const edgeV = (u: number) => coastV(p, u) - maxDepthOf(p);
  const inner = us.map((u, i) => framePoint(f, u, i === 0 || i === us.length - 1 ? edgeV(u) : Math.min(prof.at(u), edgeV(u))));
  const n = Math.max(1, Math.ceil((c - a) / 4));
  const edge: Vec2[] = [];
  for (let i = n - 1; i >= 1; i--) {
    const u = a + ((c - a) * i) / n;
    edge.push(framePoint(f, u, edgeV(u)));
  }
  return { polygon: [...inner, ...edge], nInner: inner.length };
}

/** Column positions from u0 to u1: every COLUMN m, a centimetre either side of every outline vertex and every split, ascending. */
function columns(prof: RingProfile, u0: number, u1: number, splits: number[]): number[] {
  const set: number[] = [];
  const n = Math.max(1, Math.ceil((u1 - u0) / COLUMN));
  for (let i = 0; i <= n; i++) set.push(u0 + ((u1 - u0) * i) / n);
  for (const u of [...prof.us, ...splits]) {
    if (u - 0.01 > u0) set.push(u - 0.01);
    if (u + 0.01 < u1) set.push(u + 0.01);
  }
  set.sort((a, b) => a - b);
  const out: number[] = [];
  for (const u of set) if (u >= u0 && u <= u1 && (!out.length || u - out[out.length - 1] > 0.004)) out.push(u);
  return out;
}
