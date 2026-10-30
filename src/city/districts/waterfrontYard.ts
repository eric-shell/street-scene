/**
 * The quay as a dock yard to drive (waterfront.ts builds it after the railing, the jetties and the
 * lanterns): open ground the length of the harbor, in every mode, a place a racer leaves the street for.
 * The quay used to be closed off along its frontage in a race (a line of race barriers drawn into the
 * district's merged meshes), and the menu's scene, built from the race world, lent that drawing to free
 * roam, whose world had no such walls: a wall you drove straight through. Now nothing on the quay is
 * race only, and a race leaves it open like a park: a car on it beside the route is a car on the route's
 * corridor (progress projects onto the street it runs along, within the lost check's reach), and a cut
 * the route system does not know is held to the distance driven (race.ts LOST.maxJump).
 *
 * Measured in from the sea wall's edge (d, m) and along the coast (u), it lays out:
 *  - mouths onto every street that meets the quay (a junction across the outer street, or a street's end
 *    at the frontage): cobbles, two steel gate posts (solids, 'quayPost') with a string of bulbs between
 *    them and a lantern inside each, the sidewalk in front kept clear of furniture and trees (reserved
 *    circles). No sign and no arrow: the fences stop there and the paving changes;
 *  - chain-link fence runs (destructible fence panels) along the frontage between the mouths, broken by gaps;
 *  - the lane along the water (CFG.yard.lane), the quay's through way end to end: nothing in it can stop a
 *    car, only soft clutter in the fast line (pallet stacks, crate piles, a row of oil drums, cable spools)
 *    that costs a few percent of speed per hit;
 *  - one or two loading ramps across the quay, a smooth tabletop at 6% (terrain: a crest launches a car at
 *    its speed times the slope, so the hop is free and the landing is the risk);
 *  - the skid pad on the deepest stretch, a drift zone (sim/driftZones.ts reads its 'skidPad' hint);
 *  - working docks only: the container lane, two staggered rows of shipping containers (solids) with a
 *    corridor between them threaded through the first row's gaps, a cable spool or two in the corridor and
 *    a fuel drum row along it, and a forklift or two parked off the lane (solids);
 *  - mooring bollards along the edge, benches facing the water in some lamp gaps (people sit and lean there).
 * Its own random stream (deriveSeed(seed, 'yard')), so the jetties and lanterns lie where they always did.
 * Pure and deterministic.
 *
 * Hints for render/districts/waterfrontYard.ts: 'quayMouth' (points: the two posts; values: u, width),
 * 'skidPad' (points: the zone outline; values: centre x, z, radius), 'container' (points: centre; values:
 * yaw, tiers, livery), 'forklift' (points: centre; values: yaw, tint), 'ramp' (values: u0, span, back
 * depth, height, run, top), 'quayLane' (points: the lane's middle end to end, for the maps).
 */
import { CITY } from '../config';
import { isBendNode, isChannelEdge } from '../roadGraph';
import { PROP_DEFS, type PropKind } from '../props';
import { type Vec2, atan2, cos, distToSegment, sin, sqrt } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Area, AreaBuild, BuildContext, HeightMod, HeightSample } from './types';
import { circlePolygon, smooth01, solidWalls, type Smooth } from './geom';
import { type HarborFrame, coastSlope, coastV, framePoint, frameU, frameV } from './waterfrontShape';

const CFG = CITY.districts.waterfront;
const Y = CFG.yard;

/** How far back from the quay's edge a mouth opens the blocks' frontage (m): over the frontage sampler's probe (half a metre into the block) with room to spare. */
const MOUTH_STRIP = 6;

/** The room a fence panel keeps beyond its radius from a street's carriageway edge (m). */
const FENCE_STREET_MARGIN = 0.1;

/** What the waterfront build hands the yard: the area, its frame and the quay's outline as functions of u. */
export interface YardSite {
  area: Area;
  f: HarborFrame;
  /** v of the quay's back edge at u (the frontage, or a warehouse's back wall across its recess). */
  back(u: number): number;
  /** Warehouse recesses along u (no mouth or fence in front of one: its wall is the quay's back). */
  sheds: readonly (readonly [number, number])[];
  /** Jetty roots in the railing (u, half the gate's width): the ramps keep clear of them. */
  gates: readonly { u: number; half: number }[];
  /** u of the quay's lanterns along the edge. */
  lamps: readonly number[];
}

/** A stretch of u the yard has given to something. */
export interface Taken {
  u0: number;
  u1: number;
  what: 'mouth' | 'pad' | 'maze' | 'forklift' | 'ramp' | 'pier' | 'tower' | 'dune' | 'zone' | 'court';
}

/** The yard's coordinates and bookkeeping on a site: the frame's helpers every layout below places things with. */
export interface YardGeo {
  p: Record<string, number>;
  id: number;
  f: HarborFrame;
  /** The quay's ends along the coast (u). */
  lo: number;
  hi: number;
  coast(u: number): number;
  /** The quay's depth at u: sea wall edge to back edge (m). */
  depth(u: number): number;
  /** The world point d m in from the sea wall's edge at u. */
  pt(u: number, d: number): Vec2;
  /** The coast's unit tangent (along +u) at u. */
  tangent(u: number): Vec2;
  /** The yaw (atan2(dx, dz)) that faces out to sea at u. */
  seaYaw(u: number): number;
  minDepth(u0: number, u1: number): number;
  inShed(u0: number, u1: number): boolean;
  taken: Taken[];
  free(u0: number, u1: number, of?: readonly Taken['what'][]): boolean;
  prop(kind: PropKind, q: Vec2, yaw: number): void;
  box(u: number, d: number, len: number, wide: number, turn: number): { c: Vec2; yaw: number; poly: Vec2[] };
}

/** The helpers of a site: shared by the dock yard and by a beach's boardwalk (waterfrontBeach.ts), which lays its mouths and fences the same way. */
export function yardGeo(site: YardSite, b: AreaBuild): YardGeo {
  const { area, f } = site;
  const p = area.params;
  const id = area.id;
  const lo = p.pa;
  const hi = p.pb;
  const curb = CITY.curbHeight;
  const coast = (u: number) => coastV(p, u);
  /** The quay's depth at u: sea wall edge to back edge (m). */
  const depth = (u: number) => coast(u) - site.back(u);
  /** The world point d m in from the sea wall's edge at u. */
  const pt = (u: number, d: number): Vec2 => framePoint(f, u, coast(u) - d);
  /** The coast's unit tangent (along +u) at u, and the yaw (atan2(dx, dz)) that faces out to sea. */
  const tangent = (u: number): Vec2 => {
    const s = coastSlope(p, u);
    const l = sqrt(1 + s * s);
    return { x: (f.ux + s * f.vx) / l, z: (f.uz + s * f.vz) / l };
  };
  const seaYaw = (u: number) => {
    const t = tangent(u);
    // Seaward is the tangent turned left (v is u's left).
    return atan2(-t.z, t.x);
  };
  const minDepth = (u0: number, u1: number): number => {
    let m = Infinity;
    for (let u = Math.max(lo, u0); u < Math.min(hi, u1); u += 1) m = Math.min(m, depth(u));
    return Math.min(m, depth(Math.max(lo, Math.min(hi, u1))));
  };
  const inShed = (u0: number, u1: number) => site.sheds.some(([a, c]) => u1 > a - 2 && u0 < c + 2);
  const taken: Taken[] = [];
  const free = (u0: number, u1: number, of?: readonly Taken['what'][]) => !taken.some((t) => (!of || of.includes(t.what)) && u1 > t.u0 && u0 < t.u1);
  const prop = (kind: PropKind, q: Vec2, yaw: number) => b.destructibles.push({ kind, x: q.x, z: q.z, yaw, lift: curb, area: id });
  /** A solid box `len` along the coast's tangent at u (turned by `turn` rad) and `wide` across it, centred d m in. */
  const box = (u: number, d: number, len: number, wide: number, turn: number): { c: Vec2; yaw: number; poly: Vec2[] } => {
    const c = pt(u, d);
    const t0 = tangent(u);
    const cs = cos(turn);
    const sn = sin(turn);
    const t = { x: t0.x * cs - t0.z * sn, z: t0.x * sn + t0.z * cs };
    const n = { x: -t.z, z: t.x };
    const hl = len / 2;
    const hw = wide / 2;
    const poly = [
      { x: c.x - t.x * hl - n.x * hw, z: c.z - t.z * hl - n.z * hw },
      { x: c.x + t.x * hl - n.x * hw, z: c.z + t.z * hl - n.z * hw },
      { x: c.x + t.x * hl + n.x * hw, z: c.z + t.z * hl + n.z * hw },
      { x: c.x - t.x * hl + n.x * hw, z: c.z - t.z * hl + n.z * hw },
    ];
    return { c, yaw: atan2(t.x, t.z), poly };
  };
  return { p, id, f, lo, hi, coast, depth, pt, tangent, seaYaw, minDepth, inShed, taken, free, prop, box };
}

/** A gap in the frontage's fence where a street meets the quay: its middle along the coast, its width and the sidewalk's width there (m). */
export interface Mouth {
  u: number;
  w: number;
  walk: number;
}

/**
 * Mouths onto the quay: every street that meets it (a junction across the outer street, or a street ending at the frontage),
 * each between two gate posts with a band of cobbles. Returns the mouths (merged where they would touch), the placed ones
 * marked in `geo.taken`. A street whose end stops short of the frontage by less than its half width counts too, up to
 * `slack` m (a beach's frontage, where the outline cuts close in front of the streets' caps).
 */
export function layMouths(ctx: BuildContext, site: YardSite, geo: YardGeo, b: AreaBuild, slack = 0): Mouth[] {
  const { id, f, lo, hi, depth, pt, seaYaw, inShed, taken, prop, box } = geo;
  // ----- Mouths: every street that meets the quay (a junction across the outer street, or a street ending at the frontage).
  const g = ctx.graph;
  const found: { u: number; w: number; walk: number }[] = [];
  for (const n of g.nodes) {
    if (!n.edges.length || isBendNode(g, n.id)) continue;
    const u = frameU(f, n.x, n.z);
    if (u < lo + 12 || u > hi - 12 || inShed(u, u)) continue;
    let half = 0;
    let walk = 0;
    for (const e of n.edges) {
      half = Math.max(half, g.edges[e].width / 2);
      walk = Math.max(walk, g.edges[e].sidewalk);
    }
    const gap = site.back(u) - frameV(f, n.x, n.z);
    if (gap < half - 1 - slack || gap > half + walk + Y.mouthReach) continue;
    found.push({ u, w: Math.max(Y.mouth, 2 * half + Y.mouthPad), walk });
  }
  found.sort((x, y) => x.u - y.u);
  const mouths: { u: number; w: number; walk: number }[] = [];
  for (const m of found) {
    const last = mouths[mouths.length - 1];
    // Two mouths that would touch are one wide one.
    if (last && m.u - m.w / 2 < last.u + last.w / 2 + 4) {
      const a = last.u - last.w / 2;
      const c = Math.max(last.u + last.w / 2, m.u + m.w / 2);
      last.u = (a + c) / 2;
      last.w = c - a;
      last.walk = Math.max(last.walk, m.walk);
    } else mouths.push({ ...m });
  }
  for (const m of mouths) {
    if (m.u - m.w / 2 < lo + 6 || m.u + m.w / 2 > hi - 6 || inShed(m.u - m.w / 2, m.u + m.w / 2)) continue;
    taken.push({ u0: m.u - m.w / 2 - 3, u1: m.u + m.w / 2 + 3, what: 'mouth' });
    // The gate posts on the fence line either side, a lantern just inside each.
    const posts: Vec2[] = [];
    for (const s of [-1, 1]) {
      const u = m.u + s * (m.w / 2 + Y.post / 2);
      const post = box(u, depth(u) - Y.fenceInset, Y.post, Y.post, 0);
      b.walls.push(...solidWalls(post.poly, 'quayPost', id));
      posts.push(post.c);
      prop('parkLamp', pt(u + s * 0.4, depth(u) - Y.fenceInset - 1.5), seaYaw(u) + Math.PI);
    }
    b.hints.push({ kind: 'quayMouth', points: posts, values: [m.u, m.w] });
    // Cobbles from the frontage onto the quay across the mouth: the paving changes where the way in is.
    const cols = 6;
    const outer: Vec2[] = [];
    const inner: Vec2[] = [];
    for (let k = 0; k <= cols; k++) {
      const u = m.u - m.w / 2 + (m.w * k) / cols;
      outer.push(framePoint(f, u, site.back(u) + 0.02));
      inner.push(pt(u, depth(u) - Y.mouthDepth));
    }
    b.surfaces.push({ surface: 'cobble', polygon: [...outer, ...inner.reverse()], priority: 3, area: id });
    // The frontage open across the mouth: the blocks' frontage walls are sampled half a metre into the block, so a
    // short run of a face's ring that skirts the mouth (a street's end cap, a corner of the quay's stepped edge) probes
    // outside the quay and would stand as a 1 m 'boundary' stub in the way in. The strip covers those probes and
    // nothing else of the frontage: it is only as wide as the mouth and reaches MOUTH_STRIP m back from the quay's
    // edge. Sampled every half metre, since the edge steps where a face's ring does and a coarse strip would cut the corner.
    const strip: Vec2[] = [];
    const steps = Math.ceil(m.w * 2);
    const us = Array.from({ length: steps + 1 }, (_, k) => m.u - m.w / 2 + (m.w * k) / steps);
    for (const u of us) strip.push(framePoint(f, u, Math.max(site.back(u - 0.5), site.back(u), site.back(u + 0.5)) + 0.5));
    for (let k = us.length - 1; k >= 0; k--) strip.push(framePoint(f, us[k], Math.min(site.back(us[k] - 0.5), site.back(us[k]), site.back(us[k] + 0.5)) - MOUTH_STRIP));
    b.openings.push(strip);
    // The sidewalk in front kept clear: no streetlight, hydrant, bin or street tree stands in a mouth.
    for (let u = m.u - m.w / 2; u <= m.u + m.w / 2 + 1e-6; u += 3) {
      const q = framePoint(f, u, site.back(u) - m.walk / 2);
      b.reserved.push({ x: q.x, z: q.z, r: m.walk / 2 + 0.6 });
    }
  }

  return mouths;
}

/**
 * Fence runs along the frontage, from every gate post, broken by gaps; none before a warehouse. `kind` is the panel
 * (the yard's chain link, a beach's pickets). A panel never stands on a street: where a wide street's end cap reaches
 * past the frontage (the street meets the quay but gets no mouth, its end poking in further than a mouth allows) the
 * panels within the street's edge and the panel's radius are left out, the same clearance street dressing keeps.
 * The run's random draws do not depend on which panels are left out, so the rest of the layout stays where it was.
 */
export function layFences(ctx: BuildContext, geo: YardGeo, rng: Rng, mouths: readonly Mouth[], kind: PropKind = 'fencePanel'): void {
  const { lo, hi, depth, pt, seaYaw, inShed, taken, prop } = geo;
  const g = ctx.graph;
  const reach = PROP_DEFS[kind].radius + FENCE_STREET_MARGIN;
  /** Whether a panel at q would overlap a street (its carriageway plus the panel's radius and a margin). */
  const onStreet = (q: Vec2): boolean =>
    g.edges.some((e) => !isChannelEdge(e) && distToSegment(q.x, q.z, g.nodes[e.a].x, g.nodes[e.a].z, g.nodes[e.b].x, g.nodes[e.b].z) - e.width / 2 <= reach);
  const ends: number[] = [lo + 3];
  for (const m of mouths) if (taken.some((t) => t.what === 'mouth' && Math.abs((t.u0 + t.u1) / 2 - m.u) < 1e-6)) ends.push(m.u - m.w / 2 - Y.post, m.u + m.w / 2 + Y.post);
  ends.push(hi - 3);
  for (let i = 0; i + 1 < ends.length; i += 2) {
    const a = ends[i];
    const c = ends[i + 1];
    let u = a + Y.fencePitch / 2;
    while (u < c - Y.fencePitch / 2) {
      const run = rng.int(Y.fenceRun[0], Y.fenceRun[1]);
      for (let k = 0; k < run && u < c - Y.fencePitch / 2; k++, u += Y.fencePitch) {
        if (inShed(u, u)) continue;
        const q = pt(u, depth(u) - Y.fenceInset);
        if (!onStreet(q)) prop(kind, q, seaYaw(u) + Math.PI);
      }
      u += rng.range(Y.fenceGap[0], Y.fenceGap[1]);
    }
  }
}

/** Lay the yard out on the quay into `b`. */
export function buildYard(ctx: BuildContext, site: YardSite, b: AreaBuild): void {
  const { area } = site;
  const geo = yardGeo(site, b);
  const { p, f, id, lo, hi, pt, tangent, seaYaw, minDepth, taken, free, prop, box } = geo;
  const working = area.variant !== 'marina';
  const rng = new Rng(deriveSeed(p.seed, 'yard'));
  const [lane0, lane1] = Y.lane;

  // ----- Mouths: every street that meets the quay (a junction across the outer street, or a street ending at the frontage).
  const mouths = layMouths(ctx, site, geo, b);

  // ----- The skid pad on the deepest stretch: from the lane's sea edge, padMargin off the frontage.
  let pad: { u: number; r: number } | null = null;
  for (let u = lo + 30; u <= hi - 30; u += 4) {
    let r: number = Y.pad[1];
    for (let it = 0; it < 4; it++) {
      const rr = Math.min(Y.pad[1], (minDepth(u - r - 2, u + r + 2) - Y.padMargin - lane0) / 2);
      if (rr >= r - 1e-9) break;
      r = rr;
    }
    if (r < Y.pad[0] || minDepth(u - r - 2, u + r + 2) < lane0 + 2 * r + Y.padMargin) continue;
    // The roomiest, then the one nearest the quay's middle.
    if (!pad || r > pad.r + 0.25 || (r > pad.r - 0.25 && Math.abs(u - (lo + hi) / 2) < Math.abs(pad.u - (lo + hi) / 2))) pad = { u, r };
  }
  if (pad) {
    const c = pt(pad.u, lane0 + pad.r);
    b.hints.push({ kind: 'skidPad', points: circlePolygon(c.x, c.z, pad.r + Y.padClear, 20), values: [c.x, c.z, pad.r] });
    taken.push({ u0: pad.u - pad.r - Y.padClear, u1: pad.u + pad.r + Y.padClear, what: 'pad' });
  }

  // ----- The container lane (working docks): two staggered rows, the first a metre inside the lane's inner edge.
  const [boxL, boxW] = Y.box;
  const need = lane1 + 1 + 2 * boxW + Y.mazeCorridor + Y.mazeBack;
  let maze: { u0: number; span: number } | null = null;
  if (working) {
    for (let n = rng.int(Y.maze[0], Y.maze[1]); n >= 2 && !maze; n--) {
      const gap = rng.range(Y.mazeGap[0], Y.mazeGap[1]);
      const pitch = boxL + gap;
      const span = n * boxL + (n - 1) * gap + pitch / 2;
      const cands: number[] = [];
      for (let u0 = lo + 14; u0 + span <= hi - 14; u0 += 4) if (minDepth(u0 - 2, u0 + span + 2) >= need && free(u0 - 4, u0 + span + 4)) cands.push(u0);
      if (!cands.length) continue;
      const u0 = cands[rng.int(0, cands.length - 1)];
      maze = { u0, span };
      taken.push({ u0: u0 - 2, u1: u0 + span + 2, what: 'maze' });
      const dA = lane1 + 1 + boxW / 2;
      const dB = dA + boxW + Y.mazeCorridor;
      for (const [row, d, off] of [
        [0, dA, 0],
        [1, dB, pitch / 2],
      ] as const) {
        for (let k = 0; k < n; k++) {
          const u = u0 + off + boxL / 2 + k * pitch;
          const c = box(u, d, boxL, boxW, 0);
          b.walls.push(...solidWalls(c.poly, 'container', id));
          // The back row stands taller: a wall of steel along the frontage, the front row the hurdles.
          b.hints.push({ kind: 'container', points: [c.c], values: [c.yaw, row ? rng.int(2, 3) : rng.int(1, 2), rng.int(0, 63)] });
        }
      }
      // In the corridor: a cable spool or two off its middle, and a fuel drum row along the back row.
      const mid = (dA + dB) / 2;
      for (let k = 0, m = rng.int(1, 2); k < m; k++) {
        const u = u0 + pitch * (k + 0.5) + rng.range(-2, 2);
        prop('cableSpool', pt(u, mid + rng.range(-1, 1)), rng.range(0, Math.PI * 2));
      }
      const du = u0 + pitch * Math.min(n - 1, 1.5) + rng.range(-3, 3);
      for (let k = 0, m = rng.int(6, 10); k < m; k++) prop('drum', pt(du + k * 0.98, dB - boxW / 2 - 0.6), rng.range(0, Math.PI * 2));
    }
  }

  // ----- Forklifts (working docks), parked just off the lane, pallets beside them.
  if (working) {
    const fl = Y.forklift;
    const d = lane1 + 0.9 + fl[1] / 2;
    const spots: number[] = maze ? [maze.u0 - 6, maze.u0 + maze.span + 6] : [];
    for (let k = 0; k < 12; k++) spots.push(rng.range(lo + 20, hi - 20));
    const want = rng.int(Y.forklifts[0], Y.forklifts[1]);
    let placed = 0;
    for (const u of spots) {
      if (placed >= want) break;
      if (u < lo + 10 || u > hi - 10 || !free(u - 4, u + 4) || minDepth(u - 3, u + 3) < d + fl[1] / 2 + Y.fenceInset + 1.1) continue;
      const turn = rng.chance(0.5) ? 0 : Math.PI;
      const c = box(u, d, fl[0], fl[1], turn);
      b.walls.push(...solidWalls(c.poly, 'forklift', id));
      b.hints.push({ kind: 'forklift', points: [c.c], values: [c.yaw, rng.int(0, 3)] });
      taken.push({ u0: u - 3, u1: u + 3, what: 'forklift' });
      placed++;
      for (let j = 0, m = rng.int(1, 3); j < m; j++) prop('pallets', pt(u + (turn ? -1 : 1) * (fl[0] / 2 + 1 + j * 1.5), d + rng.range(-0.2, 0.2)), seaYaw(u));
    }
  }

  // ----- Loading ramps: a 6% tabletop the full quay deep (fading in from the frontage), clear of the rest.
  const S = 2 * Y.rampRun + Y.rampTop;
  const cands: number[] = [];
  for (let u0 = lo + 16; u0 + S <= hi - 16; u0 += 4) {
    if (minDepth(u0, u0 + S) < Y.rampDepth || !free(u0 - 4, u0 + S + 4)) continue;
    if (site.gates.some((j) => j.u + j.half + 4 > u0 && j.u - j.half - 4 < u0 + S)) continue;
    cands.push(u0);
  }
  for (let k = 0, want = rng.int(Y.ramps[0], Y.ramps[1]); k < want && cands.length; k++) {
    const u0 = cands[rng.int(0, cands.length - 1)];
    const dB = minDepth(u0 - 1, u0 + S + 1) - 0.5;
    b.heightMods.push(rampMod(p, f, u0, dB));
    b.hints.push({ kind: 'ramp', points: [pt(u0, 0), pt(u0 + S, 0)], values: [u0, S, dB, Y.rampHeight, Y.rampRun, Y.rampTop] });
    taken.push({ u0, u1: u0 + S, what: 'ramp' });
    for (let i = cands.length - 1; i >= 0; i--) if (Math.abs(cands[i] - u0) < S + Y.rampGap) cands.splice(i, 1);
  }


  // ----- Chain-link fence runs along the frontage, from every gate post, broken by gaps; none before a warehouse.
  layFences(ctx, geo, rng, mouths);

  // ----- Mooring bollards along the edge, clear of the jetties' gates and the lanterns, facing the water.
  const gate = (u: number, pad: number) => site.gates.some((j) => Math.abs(j.u - u) < j.half + pad);
  for (let u = lo + 6; u < hi - 4; u += CFG.bollardStep) {
    if (gate(u, 3) || site.lamps.some((l) => Math.abs(l - u) < 2.5)) continue;
    prop('bollard', pt(u, CFG.bollardInset), seaYaw(u));
  }
  // Benches facing the water in some of the lamp gaps (people sit there), between two bollards.
  for (let i = 0; i + 1 < site.lamps.length; i++) {
    if (!rng.chance(Y.benchChance)) continue;
    const u = (site.lamps[i] + site.lamps[i + 1]) / 2 + CFG.bollardStep / 2;
    if (gate(u, 3) || !free(u - 2, u + 2, ['pad'])) continue;
    prop('bench', pt(u, 2.4), seaYaw(u));
  }

  // ----- Soft clutter in the lane: the price of the quay's fast line. Each cluster stands against one side of
  // the lane (they mostly alternate), so a clean line weaves between them and a car that smashes through pays a
  // few percent of its speed per piece (and wrecking refills nitrous: the choice is the racer's).
  const band = Y.clutterBand;
  /** d of a piece `o` m in from the cluster's side of the lane. */
  const from = (sea: boolean, o: number) => (sea ? lane0 + o : lane1 - o);
  const kinds = working ? (['pallets', 'crates', 'drums', 'spool', 'mixed'] as const) : (['crates', 'barrels'] as const);
  let drumRow = working;
  let sea = rng.chance(0.5);
  for (let u = lo + rng.range(14, 28); u < hi - 12; u += rng.range(Y.clutterStep[0], Y.clutterStep[1])) {
    // Never in front of a mouth: the way in stays clear onto the lane.
    if (!free(u - 6, u + 6, ['pad', 'maze', 'mouth'])) continue;
    sea = rng.chance(0.8) ? !sea : sea;
    const t = tangent(u);
    // A fuel drum row once: a diagonal from the lane's edge, slanted along the coast either way, `band` across.
    if (drumRow && rng.chance(0.35)) {
      drumRow = false;
      const a = rng.range(0.35, 0.6);
      const along = rng.chance(0.5) ? 1 : -1;
      const inward = sea ? 1 : -1;
      const dir = { x: t.x * cos(a) * along + t.z * sin(a) * inward, z: t.z * cos(a) * along - t.x * sin(a) * inward };
      const o = pt(u, from(sea, 0.5));
      const m = Math.max(3, Math.floor(band / sin(a) / 0.98));
      for (let k = 0; k < m; k++) prop('drum', { x: o.x + dir.x * k * 0.98, z: o.z + dir.z * k * 0.98 }, rng.range(0, Math.PI * 2));
      continue;
    }
    const kind = rng.pick(kinds);
    if (kind === 'pallets' || kind === 'mixed') {
      for (let k = 0, m = rng.int(1, 2); k <= m; k++) prop('pallets', pt(u + rng.range(-0.3, 0.3), from(sea, 0.7 + k * 1.55)), seaYaw(u) + rng.range(-0.3, 0.3));
      if (kind === 'mixed') for (let k = 0, m = rng.int(3, 5); k < m; k++) prop('drum', pt(u + 2.2 + k * 0.98, from(sea, 0.5)), rng.range(0, Math.PI * 2));
    } else if (kind === 'crates' || kind === 'barrels') {
      for (let k = 0, m = rng.int(3, 5); k < m; k++) prop(kind === 'crates' ? 'crate' : 'barrel', pt(u + rng.range(-2, 2), from(sea, rng.range(0.6, band - 0.6))), rng.range(0, Math.PI * 2));
    } else if (kind === 'drums') {
      for (let k = 0, m = rng.int(5, 9); k < m; k++) prop('drum', pt(u + k * 0.98, from(sea, 0.5 + rng.range(0, 0.5))), rng.range(0, Math.PI * 2));
    } else {
      prop('cableSpool', pt(u, from(sea, 0.9)), rng.range(0, Math.PI * 2));
      for (let k = 0, m = rng.int(1, 3); k < m; k++) prop('crate', pt(u + rng.range(1.6, 3), from(sea, rng.range(0.6, band - 0.6))), rng.range(0, Math.PI * 2));
    }
  }

  // ----- The lane's middle end to end, for the maps (the quay's through way).
  const lane: Vec2[] = [];
  for (let u = lo + 2; u <= hi - 2 + 1e-6; u += 8) lane.push(pt(u, (lane0 + lane1) / 2));
  b.hints.push({ kind: 'quayLane', points: lane, values: [] });
}

/** Scratch for a ramp's smoothsteps: the terrain is queried per wheel per substep, so nothing allocates. */
const R_UP: Smooth = { v: 0, d: 0 };
const R_DOWN: Smooth = { v: 0, d: 0 };
const R_SEA: Smooth = { v: 0, d: 0 };
const R_BACK: Smooth = { v: 0, d: 0 };

/**
 * A loading ramp starting at u0: CFG.yard.rampHeight high, rising over rampRun and falling over rampRun
 * either side of a rampTop flat top (smoothsteps along u), across the quay from just past the sea wall's
 * edge (so the railing and the coping ride it) to dB in from it, fading over rampBack before that, so it
 * is 0 on the sidewalk and past its box. Exact gradient: d = coast(u) - v, so the coast's slope enters
 * through the fades across.
 */
export function rampMod(p: Record<string, number>, f: HarborFrame, u0: number, dB: number): HeightMod {
  const H = Y.rampHeight;
  const run = Y.rampRun;
  const top = Y.rampTop;
  const u1 = u0 + 2 * run + top;
  const SEA0 = -0.6;
  const SEA1 = 0.3;
  const back0 = dB - Y.rampBack;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let u = u0; u <= u1 + 1e-6; u += 2) {
    for (const d of [SEA0, dB]) {
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
      if (d <= SEA0 || d >= dB) return;
      smooth01(u0, u0 + run, u, R_UP);
      smooth01(u1 - run, u1, u, R_DOWN);
      const P = R_UP.v * (1 - R_DOWN.v);
      const dP = R_UP.d * (1 - R_DOWN.v) - R_UP.v * R_DOWN.d;
      smooth01(SEA0, SEA1, d, R_SEA);
      smooth01(back0, dB, d, R_BACK);
      const Q = R_SEA.v * (1 - R_BACK.v);
      const dQ = R_SEA.d * (1 - R_BACK.v) - R_SEA.v * R_BACK.d;
      if (P <= 0 || Q <= 0) return;
      const cs = coastSlope(p, u);
      // dd/dx = cs * ux - vx, dd/dz = cs * uz - vz; du/dx = ux, du/dz = uz.
      out.h += H * P * Q;
      out.gx += H * (dP * f.ux * Q + P * dQ * (cs * f.ux - f.vx));
      out.gz += H * (dP * f.uz * Q + P * dQ * (cs * f.uz - f.vz));
    },
  };
}
