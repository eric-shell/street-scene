/**
 * The beach variant of the waterfront (waterfront.ts picks it, a Miami home most of the time and now and then
 * elsewhere; CFG.beach): the same coast, water and ends as a harbor, with a beachfront where the dock yard
 * would be. Past the street's frontage the ground is, seaward in order:
 *  - the boardwalk ('boardwalk' surface, planks that drive like the alleys' cobbles), at least a dozen metres of it, along the
 *    whole frontage between the streets' mouths (gate posts, bulb strings, setts, as the dock yard's, and low picket
 *    fences between them): palms in a row at its sea edge (solid trunks, look 'tree'), cast iron lanterns, benches,
 *    string lights hung palm to palm (render only), the pier's root;
 *  - the dune edge, CFG.beach.sand m in from the waterline: where the boardwalk's ground meets the sand's profile;
 *  - the sand ('sand' surface: loose, slidey, heavy drag, its own tuning entry), draped on the terrain rising slope
 *    (2.5%) from the water's surface (beachGround: the ground blended from the street's over the last `blend` m, an
 *    exact gradient like every height modifier) and shelving into the sea past the waterline. On it: umbrellas and loungers
 *    (destructible props, soft), volleyball nets (destructible panels, painted courts), lifeguard towers (solids,
 *    look 'lifeguard'), the dune jumps (ridges across the dune edge at the terrain rule's 6%: a car off the sand
 *    over a crest is launched at its speed times the slope), and the drift strip on the hard-packed sand by the water
 *    (a zone of kind 'beach', sim/driftZones.ts);
 *  - the surf, a one-sided wall ('surf') a few decimetres up the sand from the waterline: no car reaches the sea.
 * The pier (hint 'pier') is a solid of look 'pier' from the boardwalk over the sand to the waterline and, drawn only,
 * on out over the water on piles with lamps. Nothing else is walled: the boardwalk and the sand are open ground the length
 * of the city's edge in every mode, a place a racer leaves the street for, with the same standing as the dock yard:
 * a car on it beside the route is on the route's corridor, the minimap and the city map draw the boardwalk as a
 * through way ('quayLane') and meets keep off paving that is not road, sidewalk, concrete or grass.
 *
 * Its own random stream (deriveSeed(seed, 'beach')). Pure and deterministic.
 *
 * Hints for render/districts/waterfrontBeach.ts: 'quayMouth' (points: the two posts; values: u, width; drawn by the
 * yard's code), 'pier' (points: root, tip; values: width, deck height over the boardwalk, solid length), 'lifeguard'
 * (points: centre; values: yaw, livery), 'dune' (points: crest ends; values: u0, span, crest d, height, run, top),
 * 'court' (points: the four corners; values: u, d), 'beachZone' (points: the drift strip; values: u0, u1, d0, d1),
 * 'quayLane' (points: the boardwalk's middle end to end, for the maps). Props: 'palm' (the crown's radius, the height).
 */
import { CITY } from '../config';
import type { Terrain } from '../terrain';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { AreaBuild, BuildContext, HeightMod, HeightSample } from './types';
import { circlePolygon, smooth01, solidWalls, type Smooth } from './geom';
import { type HarborFrame, coastNormal, coastSlope, coastV, framePoint, waterLevel } from './waterfrontShape';
import { type YardSite, layFences, layMouths, yardGeo } from './waterfrontYard';

const CFG = CITY.districts.waterfront;
const B = CFG.beach;

/** Scratch for the sand's smoothsteps: the terrain is queried per wheel per substep, so nothing allocates. */
const S_LAND: Smooth = { v: 0, d: 0 };
const S_SHELF: Smooth = { v: 0, d: 0 };
const S_A: Smooth = { v: 0, d: 0 };
const S_B: Smooth = { v: 0, d: 0 };
const S_FAR: Smooth = { v: 0, d: 0 };

/**
 * The sand and the sea floor off it, as one height modifier. With d the distance in from the coast line
 * (the waterline, p.pa..p.pb along it), the ground's target height is
 *   T(d) = water - curb + slope * d                         (the sand: at the waterline the *drive* height, which a raised
 *                                                            patch lifts by the curb, is the water's surface)
 *   T(d) -> water - depth over p.fall m past the waterline  (the sea floor, a smoothstep off the sand's slope)
 * and the ground is blended from the base terrain to T by Lb(d) = 1 - smoothstep(sand - blend, sand, d): 0 at the dune
 * edge (the boardwalk keeps the street's ground there), 1 from `blend` m seaward of it on. The ends fade like the
 * harbor's lowering (p.eA0..eB1) and the far water fades back to the landscape (p.vf0..vf1), so the modifier is 0 at its
 * box. Exact gradient: the base terrain's own, the coast's slope, every fade, the water's tilt.
 */
export function beachGround(p: Record<string, number>, base: Terrain): HeightMod {
  const f: HarborFrame = { ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz };
  const curb = CITY.curbHeight;
  let vLo = Infinity;
  for (let u = p.eA0; u <= p.eB1 + p.cdx; u += p.cdx) vLo = Math.min(vLo, coastV(p, Math.min(u, p.eB1)));
  vLo -= p.sand + 1;
  const corners = [framePoint(f, p.eA0, vLo), framePoint(f, p.eB1, vLo), framePoint(f, p.eA0, p.vf1), framePoint(f, p.eB1, p.vf1)];
  const box = {
    minX: Math.min(...corners.map((c) => c.x)) - 1,
    minZ: Math.min(...corners.map((c) => c.z)) - 1,
    maxX: Math.max(...corners.map((c) => c.x)) + 1,
    maxZ: Math.max(...corners.map((c) => c.z)) + 1,
  };
  return {
    ...box,
    add(x: number, z: number, out: HeightSample): void {
      const u = x * f.ux + z * f.uz;
      if (u <= p.eA0 || u >= p.eB1) return;
      const v = x * f.vx + z * f.vz;
      if (v >= p.vf1) return;
      const cs = coastSlope(p, u);
      const d = coastV(p, u) - v;
      if (d >= p.sand) return;
      smooth01(p.sand - p.blend, p.sand, d, S_LAND);
      smooth01(p.eA0, p.eA1, u, S_A);
      smooth01(p.eB0, p.eB1, u, S_B);
      smooth01(p.vf0, p.vf1, v, S_FAR);
      const Lb = 1 - S_LAND.v;
      const e = S_A.v * (1 - S_B.v);
      const de = S_A.d * (1 - S_B.v) - S_A.v * S_B.d;
      const o = 1 - S_FAR.v;
      const L = Lb * e * o;
      if (L <= 0) return;
      const wl = waterLevel(p, u);
      const dwl = u > p.wu0 && u < p.wu1 ? p.wt : 0;
      const T0 = wl - curb + p.slope * d;
      smooth01(0, p.fall, -d, S_SHELF);
      const t = S_SHELF.v;
      const Fs = wl - p.depth;
      const T = T0 + (Fs - T0) * t;
      // dT/dd: the sand's slope fading out as the shelf takes over, and the shelf's own (t falls as d grows).
      const dTdd = p.slope * (1 - t) - (Fs - T0) * S_SHELF.d;
      const h0 = base.heightAt(x, z);
      const g0 = base.slopeAt(x, z);
      const diff = T - h0;
      // d(d)/dx = cs * ux - vx, and likewise for z; du/dx = ux; dv/dx = vx.
      const ddx = cs * f.ux - f.vx;
      const ddz = cs * f.uz - f.vz;
      const dLdx = -S_LAND.d * e * o * ddx + Lb * de * o * f.ux - Lb * e * S_FAR.d * f.vx;
      const dLdz = -S_LAND.d * e * o * ddz + Lb * de * o * f.uz - Lb * e * S_FAR.d * f.vz;
      out.h += L * diff;
      out.gx += dLdx * diff + L * (dTdd * ddx + dwl * f.ux - g0.gx);
      out.gz += dLdz * diff + L * (dTdd * ddz + dwl * f.uz - g0.gz);
    },
  };
}

const D_A: Smooth = { v: 0, d: 0 };
const D_B: Smooth = { v: 0, d: 0 };
const D_C: Smooth = { v: 0, d: 0 };
const D_D: Smooth = { v: 0, d: 0 };

/**
 * A dune: a ridge CFG.beach.duneHeight high from u0 for `span` m along the coast (rising over duneRun, a flat top
 * duneLength, falling over duneRun), its crest line `crest` m in from the waterline (rising over duneRun from
 * the sand side, a flat top duneTop across, falling over duneRun onto the boardwalk). Smoothstep slopes, steepest
 * 1.5 x height / run = 6%; exact gradient (d = coast(u) - v, so the coast's slope enters through the fades across).
 */
export function duneMod(p: Record<string, number>, f: HarborFrame, u0: number, crest: number): HeightMod {
  const H = B.duneHeight;
  const run = B.duneRun;
  const u1 = u0 + 2 * run + B.duneLength;
  const d0 = crest - B.duneTop / 2 - run;
  const d1 = crest + B.duneTop / 2 + run;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let u = u0; u <= u1 + 1e-6; u += 2) {
    for (const d of [d0, d1]) {
      const q = framePoint(f, u, coastV(p, u) - d);
      minX = Math.min(minX, q.x);
      minZ = Math.min(minZ, q.z);
      maxX = Math.max(maxX, q.x);
      maxZ = Math.max(maxZ, q.z);
    }
  }
  return {
    minX: minX - 1,
    minZ: minZ - 1,
    maxX: maxX + 1,
    maxZ: maxZ + 1,
    add(x: number, z: number, out: HeightSample): void {
      const u = x * f.ux + z * f.uz;
      if (u <= u0 || u >= u1) return;
      const d = coastV(p, u) - (x * f.vx + z * f.vz);
      if (d <= d0 || d >= d1) return;
      smooth01(u0, u0 + run, u, D_A);
      smooth01(u1 - run, u1, u, D_B);
      smooth01(d0, d0 + run, d, D_C);
      smooth01(d1 - run, d1, d, D_D);
      const R = D_A.v * (1 - D_B.v);
      const dR = D_A.d * (1 - D_B.v) - D_A.v * D_B.d;
      const Q = D_C.v * (1 - D_D.v);
      const dQ = D_C.d * (1 - D_D.v) - D_C.v * D_D.d;
      if (R <= 0 || Q <= 0) return;
      const cs = coastSlope(p, u);
      out.h += H * R * Q;
      out.gx += H * (dR * f.ux * Q + R * dQ * (cs * f.ux - f.vx));
      out.gz += H * (dR * f.uz * Q + R * dQ * (cs * f.uz - f.vz));
    },
  };
}

/** Lay the beach out into `b` (waterfront.ts has drawn the coast, the surf wall, the ends' fences and the water). */
export function buildBeach(ctx: BuildContext, site: YardSite, b: AreaBuild): void {
  const { f } = site;
  const geo = yardGeo(site, b);
  const { p, id, lo, hi, coast, depth, pt, seaYaw, inShed, taken, free, prop, box } = geo;
  const S = p.sand;
  const rng = new Rng(deriveSeed(p.seed, 'beach'));
  const along = (u0: number, u1: number, step: number): number[] => {
    const n = Math.max(1, Math.ceil((u1 - u0) / step));
    return Array.from({ length: n + 1 }, (_, i) => u0 + ((u1 - u0) * i) / n);
  };
  /** Does the coast run nearly straight over [u0, u1]: within `tol` m of its chord (for a zone drawn as one quad)? */
  const straight = (u0: number, u1: number, tol: number): boolean => {
    const c0 = coast(u0);
    const c1 = coast(u1);
    for (let u = u0; u <= u1; u += 4) if (Math.abs(coast(u) - (c0 + ((c1 - c0) * (u - u0)) / (u1 - u0))) > tol) return false;
    return true;
  };

  // ----- The sand: the strip from the dune edge to the waterline (the boardwalk patch under the rest of the quay).
  {
    const us = along(lo, hi, 4);
    b.surfaces.push({ surface: 'sand', polygon: [...us.map((u) => pt(u, S)), ...us.slice().reverse().map((u) => pt(u, 0))], priority: 3, area: id });
  }

  // ----- Mouths onto the boardwalk from every street that meets it, the picket fences between them.
  const mouths = layMouths(ctx, site, geo, b, B.mouthSlack);
  layFences(ctx, geo, rng, mouths, 'picketFence');

  // ----- The pier: out from the boardwalk over the sand, a solid to the waterline, drawn on over the water.
  let pierU: number | null = null;
  {
    const target = lo + (hi - lo) * rng.range(0.3, 0.7);
    let best = Infinity;
    for (let u = lo + 60; u <= hi - 60; u += 5) {
      if (!free(u - 14, u + 14) || Math.abs(u - target) >= best) continue;
      best = Math.abs(u - target);
      pierU = u;
    }
    if (pierU !== null) {
      const u = pierU;
      const len = S + B.pierRoot + 1.5;
      const c = box(u, (S + B.pierRoot - 1.5) / 2, len, B.pier, Math.PI / 2);
      b.walls.push(...solidWalls(c.poly, 'pier', id));
      const n = coastNormal(p, u);
      const root = { x: c.c.x - n.nx * (len / 2), z: c.c.z - n.nz * (len / 2) };
      const tip = { x: root.x + n.nx * (len + B.pierOver), z: root.z + n.nz * (len + B.pierOver) };
      b.hints.push({ kind: 'pier', points: [root, tip], values: [B.pier, B.pierHeight, len] });
      taken.push({ u0: u - 12, u1: u + 12, what: 'pier' });
    }
  }

  // ----- Dune jumps: ridges across the dune edge, off the pier and the mouths, well apart.
  {
    const span = 2 * B.duneRun + B.duneLength;
    const crest = S - B.duneCrest;
    const cands: number[] = [];
    for (let u0 = lo + 40; u0 + span <= hi - 40; u0 += 4) if (free(u0 - 6, u0 + span + 6) && !inShed(u0, u0 + span)) cands.push(u0);
    for (let k = 0, want = rng.int(B.dunes[0], B.dunes[1]); k < want && cands.length; k++) {
      const u0 = cands[rng.int(0, cands.length - 1)];
      b.heightMods.push(duneMod(p, f, u0, crest));
      b.hints.push({ kind: 'dune', points: [pt(u0, crest), pt(u0 + span, crest)], values: [u0, span, crest, B.duneHeight, B.duneRun, B.duneTop] });
      taken.push({ u0, u1: u0 + span, what: 'dune' });
      for (let i = cands.length - 1; i >= 0; i--) if (Math.abs(cands[i] - u0) < span + B.duneGap) cands.splice(i, 1);
    }
  }

  // ----- The drift strip on the hard-packed sand by the water: a straight stretch with nothing in it.
  {
    const len = rng.range(B.zoneLength[0], B.zoneLength[1]);
    const [d0, d1] = B.zoneIn;
    const cands: number[] = [];
    for (let u0 = lo + 24; u0 + len <= hi - 24; u0 += 6) if (free(u0 - 5, u0 + len + 5) && straight(u0, u0 + len, 1.2)) cands.push(u0);
    if (cands.length) {
      const u0 = cands[rng.int(0, cands.length - 1)];
      const u1 = u0 + len;
      b.hints.push({ kind: 'beachZone', points: [pt(u0, d1), pt(u1, d1), pt(u1, d0), pt(u0, d0)], values: [u0, u1, d0, d1] });
      taken.push({ u0: u0 - 4, u1: u1 + 4, what: 'zone' });
    }
  }

  // ----- Lifeguard towers on the sand, apart, off the strip and the pier.
  {
    const placed: number[] = [];
    const t = B.tower;
    for (let tries = 0, want = rng.int(B.towers[0], B.towers[1]); tries < 60 && placed.length < want; tries++) {
      const u = rng.range(lo + 30, hi - 30);
      if (!free(u - 8, u + 8) || placed.some((q) => Math.abs(q - u) < B.towerGap)) continue;
      const c = box(u, B.towerIn, t, t, 0);
      b.walls.push(...solidWalls(c.poly, 'lifeguard', id));
      b.hints.push({ kind: 'lifeguard', points: [c.c], values: [seaYaw(u), rng.int(0, 3)] });
      taken.push({ u0: u - 7, u1: u + 7, what: 'tower' });
      placed.push(u);
    }
  }

  // ----- Volleyball courts: a net of destructible panels across a painted court, off the strip and the towers.
  {
    const placed: number[] = [];
    const wide = B.net;
    for (let tries = 0, want = rng.int(B.courts[0], B.courts[1]); tries < 60 && placed.length < want; tries++) {
      const u = rng.range(lo + 24, hi - 24);
      if (!free(u - 11, u + 11) || placed.some((q) => Math.abs(q - u) < B.courtGap)) continue;
      const dc = S - 3 - B.court / 2;
      for (let k = -2; k <= 2; k++) prop('volleyNet', pt(u + (k * wide) / 5, dc), seaYaw(u));
      const hw = (wide - 1) / 2;
      b.hints.push({ kind: 'court', points: [pt(u - hw, dc + B.court / 2), pt(u + hw, dc + B.court / 2), pt(u + hw, dc - B.court / 2), pt(u - hw, dc - B.court / 2)], values: [u, dc] });
      taken.push({ u0: u - 10, u1: u + 10, what: 'court' });
      placed.push(u);
    }
  }

  // ----- The boardwalk's sea edge: palms in a row (solid trunks), lanterns and benches in the gaps.
  const palms: number[] = [];
  for (let u = lo + 8 + rng.range(0, 6); u < hi - 8; u += rng.range(B.palmStep[0], B.palmStep[1])) {
    if (!free(u - 2.5, u + 2.5, ['mouth', 'pier']) || inShed(u, u)) continue;
    const q = pt(u, S + B.palmInset);
    b.walls.push(...solidWalls(circlePolygon(q.x, q.z, B.palmTrunk, 6), 'tree', id));
    b.props.push({ kind: 'palm', x: q.x, z: q.z, yaw: rng.range(0, Math.PI * 2), size: rng.range(B.palmCrown[0], B.palmCrown[1]), height: rng.range(B.palmHeight[0], B.palmHeight[1]), area: id });
    palms.push(u);
  }
  for (let u = lo + 14 + rng.range(0, 10); u < hi - 10; u += B.lampStep) {
    if (!free(u - 2, u + 2, ['mouth', 'pier']) || palms.some((q) => Math.abs(q - u) < 3.2)) continue;
    prop('parkLamp', pt(u, S + B.lampInset), seaYaw(u) + Math.PI);
  }
  for (let i = 0; i + 1 < palms.length; i++) {
    const gap = palms[i + 1] - palms[i];
    if (gap < 9 || !rng.chance(B.benchChance)) continue;
    const u = (palms[i] + palms[i + 1]) / 2;
    if (!free(u - 2, u + 2, ['mouth', 'pier']) || depth(u) < S + B.benchInset + 4) continue;
    prop('bench', pt(u, S + B.benchInset), seaYaw(u));
    if (rng.chance(0.6)) prop('garbageCan', pt(u + 2, S + B.benchInset), seaYaw(u));
  }

  // ----- Umbrellas with their loungers along the sand, in clusters; clear of the strip, the courts, the towers and the dunes.
  for (let u = lo + 14 + rng.range(0, 10); u < hi - 12; u += rng.range(B.umbrellaStep[0], B.umbrellaStep[1])) {
    if (!free(u - 3.5, u + 3.5)) continue;
    const d = rng.range(B.umbrellaBand[0], B.umbrellaBand[1]);
    const yaw = seaYaw(u);
    prop('umbrella', pt(u, d), rng.range(0, Math.PI * 2));
    for (let k = 0, m = rng.int(B.loungers[0], B.loungers[1]); k < m; k++) {
      const side = k % 2 ? 1 : -1;
      prop('lounger', pt(u + side * rng.range(1.6, 2.1), d + rng.range(-0.6, 0.6)), yaw + rng.range(-0.25, 0.25));
    }
  }

  // ----- The boardwalk's middle end to end, for the maps (the through way).
  const lane: Vec2[] = [];
  for (const u of along(lo + 2, hi - 2, 8)) lane.push(pt(u, (S + 5 + depth(u) - 2) / 2));
  b.hints.push({ kind: 'quayLane', points: lane, values: [] });
}
