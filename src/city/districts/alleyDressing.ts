/**
 * What stands in and around an alley (alley.ts): the junction mouths and the
 * cobbled surface patches, construction sites, the clutter funnelling into a
 * route shortcut, kicker humps and the jump exits (ramp, lip wall, landing
 * zone, the corner rails cut for the flight). Nothing solid ever stands in
 * the line down the middle (LANE).
 */
import { CITY } from '../config';
import { otherNode, type RoadGraph } from '../roadGraph';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import { type Vec2, distToSegment } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { pointInPolygon, smooth01, type Smooth, segmentAt } from './geom';
import { type PropKind, PROP_DEFS } from '../props';
import { type Area, type AreaBuild, type BuildContext, type HeightSample, type SurfacePatch, COBBLE_PRIORITY } from './types';
import { CAR_HALF, railsClearOf } from './carPark';
import { jumpProfile, jumpRampProfile, pathSpot, RAD, unit } from './alleyPath';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

/** Half width (m) of the line down the middle of every alley that nothing solid may stand in: a car plus a margin. */
export const LANE = 1.3;

/**
 * How far (m) into an alley the streets at node nid reach (road, sidewalk,
 * furniture and a corner rail's line), at the angle the alley (direction t,
 * half width hw) leaves them: a diagonal mouth runs much deeper than a square
 * one, and deepest on its acute side (side = +1 left of t, -1 right).
 */
export function mouthReach(g: RoadGraph, nid: number, own: readonly number[], tx: number, tz: number, hw: number, side: number): number {
  let depth = 12;
  const n = g.nodes[nid];
  for (const eid of n.edges) {
    if (own.includes(eid)) continue;
    const e = g.edges[eid];
    const d = unit(n, g.nodes[e.a === nid ? e.b : e.a]);
    const sinA = Math.max(0.35, Math.abs(d.x * tz - d.z * tx));
    // Left of travel (tx, tz) is (-tz, tx): a side toward the street's direction sits closer to it.
    const toward = side * (-tz * d.x + tx * d.z) > 0 ? 1 : -1;
    const cosA = Math.abs(d.x * tx + d.z * tz);
    depth = Math.max(depth, (e.width / 2 + e.sidewalk + 2.5 + toward * hw * cosA) / sinA + 1);
  }
  return depth;
}

/** Surface patch priorities of a flared shortcut mouth: its junction fan over the street classification, its corners' sidewalks over offroad. */
const MOUTH_ROAD = 5.5;
const MOUTH_WALK = 3.5;

/**
 * A shortcut mouth's surfaces at node nid (blocks.ts flares its corners): the
 * whole junction fan out to the curved curbs is asphalt, and each flared
 * corner's curved sidewalk is sidewalk.
 */
export function mouthPatches(ctx: BuildContext, nid: number, area: number): SurfacePatch[] {
  const secs = ctx.sectors[nid];
  if (!secs.some((s) => s.flared)) return [];
  const fan: Vec2[] = [];
  for (const s of secs) for (const p of s.curb) fan.push(p);
  const out: SurfacePatch[] = [{ surface: 'road', polygon: fan, priority: MOUTH_ROAD, area }];
  for (const s of secs) if (s.flared) out.push({ surface: 'sidewalk', polygon: [...s.curb, ...s.outer.slice().reverse()], priority: MOUTH_WALK, area });
  return out;
}

/** An edge's road strip, curb to curb between its two mouths, as a cobble surface patch (the junction fans stay asphalt). */
export function cobblePatch(ctx: BuildContext, eid: number, area: number): SurfacePatch {
  const m = ctx.mouths[eid];
  return { surface: 'cobble', polygon: [m.aP.curb, m.bP.curb, m.bN.curb, m.aN.curb], priority: COBBLE_PRIORITY, area };
}

/** The fan at a bend node between two legs of a chain (its sectors' curb points), cobbled like the legs: the outside of the bend is rounded past both strips. */
export function bendPatch(ctx: BuildContext, nid: number, area: number): SurfacePatch {
  const fan: Vec2[] = [];
  for (const s of ctx.sectors[nid]) for (const p of s.curb) fan.push(p);
  return { surface: 'cobble', polygon: fan, priority: COBBLE_PRIORITY, area };
}

/** Construction site layout in a route shortcut (constructionSite). */
const SITE = {
  /** Fences stand this far inside the alley's mouth (past the flared corners) and stop this far inside its walls (m). */
  fenceBack: 0.6,
  fenceInset: 0.35,
  /**
   * Panel spacing never drops below this (m): two fence panel props closer than their radii plus
   * half the prop gap would overlap and one would be dropped (city/props.ts). Panels overlap a
   * little visually instead, like real clamped fencing.
   */
  panelMin: 1.96,
  /** Barricades and cones stand this far inside each fence (m); wall clutter starts this far in. */
  barricade: 3.8,
  inside: 7,
  /** Gap between wall pieces along the alley (m): their radii plus [min, max]. */
  gap: [0.35, 1.7],
  /** Cones of the taper along each flared mouth corner stand this far out from the curb (m), and this far off the street's own road strip. */
  taper: 0.6,
  taperClear: 1.2,
  /** Chance a soft piece stands out from the wall into the alley (it may block the line: it breaks). */
  intrude: 0.3,
} as const;

/** Wall clutter mix: kind and weight. Everything but the dumpster breaks before it can stop a car. */
const SITE_MIX: [PropKind, number][] = [
  ['crate', 17],
  ['barrel', 13],
  ['trashBags', 14],
  ['pallets', 14],
  ['sandbags', 10],
  ['waterBarrier', 10],
  ['trafficCone', 9],
  ['sawhorse', 6],
  ['dumpster', 7],
];
const SOFT = new Set<PropKind>(['crate', 'trashBags', 'pallets', 'trafficCone', 'sawhorse', 'barrel']);

/**
 * A route shortcut as a construction site: temporary fence panels across both
 * mouths (just behind the street's building line, the whole alley width,
 * contractors' banners on them) that a car smashes through on the way in and
 * out, striped sawhorses and cones behind each fence, and both walls lined
 * with site clutter (crates, barrels, bags, pallets, sandbags, water filled
 * barriers, the odd dumpster). Only soft pieces stand out into the alley: the
 * middle LANE each side of the centerline stays clear of anything that could
 * stop a car (PROP_DEFS breakSpeed). Pieces skip the kicker and the inside of
 * every bend (where the walls mitre). At a jump exit the exit fence stands
 * across the lip instead and the clutter stops short of the ramp's toe.
 */
export function constructionSite(ctx: BuildContext, area: Area, b: AreaBuild, rng: Rng, path: Vec2[], cum: number[], hw: number, jumpClear: (s: number, r: number) => boolean): void {
  const len = cum[cum.length - 1];
  const legs = path.length - 1;
  const J = CITY.districts.backAlley.route.jump;
  const P = area.params;
  const legDir = (i: number) => unit(path[i], path[i + 1]);
  // Yaws at a chain position: local +X across the alley, or along it (fences, planks and barriers lie along local X).
  const yawsAt = (s: number) => {
    const u = legDir(segmentAt(cum, s));
    return { across: Math.atan2(-u.x, -u.z), along: Math.atan2(-u.z, u.x) };
  };
  const edge = hw - SITE.fenceInset;
  /** A row of fence panels from p0 to p1. */
  const panels = (p0: Vec2, p1: Vec2) => {
    const span = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const dx = (p1.x - p0.x) / span;
    const dz = (p1.z - p0.z) / span;
    const count = Math.max(1, Math.floor(span / SITE.panelMin));
    const yaw = Math.atan2(-dz, dx);
    for (let k = 0; k < count; k++) {
      const u = (span * (k + 0.5)) / count;
      b.destructibles.push({ kind: 'fencePanel', x: p0.x + dx * u, z: p0.z + dz * u, yaw, lift: 0, area: area.id });
    }
  };
  /**
   * Fence across the mouth at the entry (or the exit), wall to wall where the
   * alley's straight walls start past the flared corners, fenceBack inside;
   * returns its chain position (s) at lateral -edge and +edge.
   */
  const fence = (atA: boolean): [number, number] | null => {
    const li = atA ? 0 : legs - 1;
    const O = path[li];
    const u = legDir(li);
    const m = ctx.mouths[area.edges[li]];
    const into = atA ? 1 : -1;
    // P is the left wall seen along the leg (lateral +), N the right.
    const Pw = atA ? m.aP.outer : m.bP.outer;
    const Nw = atA ? m.aN.outer : m.bN.outer;
    const lat = (p: Vec2) => (p.x - O.x) * -u.z + (p.z - O.z) * u.x;
    const lN = lat(Nw);
    const lP = lat(Pw);
    if (lP - lN < 1) return null;
    const at = (l: number): Vec2 => {
      const t = (l - lN) / (lP - lN);
      return { x: Nw.x + (Pw.x - Nw.x) * t + u.x * into * SITE.fenceBack, z: Nw.z + (Pw.z - Nw.z) * t + u.z * into * SITE.fenceBack };
    };
    const p0 = at(-edge);
    const p1 = at(edge);
    panels(p0, p1);
    const sOf = (p: Vec2) => cum[li] + (p.x - O.x) * u.x + (p.z - O.z) * u.z;
    return [sOf(p0), sOf(p1)];
  };
  /** The jump exit's fence: across the lip, on the ramp's top just behind the face. */
  const lipFence = (): [number, number] => {
    const s = len - P.lipS - 0.7;
    const p0 = pathSpot(path, cum, s, -edge);
    const p1 = pathSpot(path, cum, s, edge);
    panels(p0, p1);
    return [s, s];
  };
  const inF = fence(true) ?? [12, 12];
  const outF = P.jumpExit ? lipFence() : (fence(false) ?? [len - 12, len - 12]);
  // The flared mouths: a taper of cones along each curved curb, lining the funnel into the fence.
  funnelClutter(ctx, area, b, () => 'trafficCone', rng);
  // A fence across a diagonal mouth is oblique: where it stands depends on the lateral offset.
  const fenceS = (f: [number, number], lat: number) => f[0] + ((Math.max(-edge, Math.min(edge, lat)) + edge) / (2 * edge)) * (f[1] - f[0]);
  const s0 = Math.max(inF[0], inF[1]);
  // Wall clutter ends at the exit fence, or short of a jump exit's ramp (a clean run-up).
  const s1 = P.jumpExit ? len - P.lipS - J.length - 2 : Math.min(outF[0], outF[1]);
  /** Bends: the inside wall mitres, so nothing stands within the mitre's reach of the node on that side; the outside only skips the node itself. */
  const bendClear = (s: number, lateral: number, r: number) => {
    for (let i = 1; i < legs; i++) {
      const u = legDir(i - 1);
      const v = legDir(i);
      const turn = Math.atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z);
      const inside = Math.sign(turn) === Math.sign(lateral);
      const reach = inside ? hw * Math.tan(Math.abs(turn) / 2) + r + 0.6 : r + 0.3;
      if (Math.abs(s - cum[i]) < reach) return false;
    }
    return true;
  };
  /** Place a piece at chain position s and lateral offset (left +), inside both fences, off the kicker and the bends. */
  const push = (kind: PropKind, s: number, lateral: number, jitter: number, yaw?: number) => {
    const r = PROP_DEFS[kind].radius;
    if (s - r < fenceS(inF, lateral) + 0.9 || s + r > Math.min(s1, fenceS(outF, lateral)) - 0.9 || !jumpClear(s, r) || !bendClear(s, lateral, r)) return;
    const p = pathSpot(path, cum, s, lateral);
    b.destructibles.push({ kind, x: p.x, z: p.z, yaw: (yaw ?? p.yaw) + rng.range(-jitter, jitter), lift: 0, area: area.id });
  };
  // Behind each fence: a sawhorse or two across the alley, cones scattered around them (a jump exit's lip fence has nothing behind it: the ramp).
  const barricades: [number, number][] = [[s0 + SITE.barricade, 1]];
  if (!P.jumpExit) barricades.push([s1 - SITE.barricade, -1]);
  for (const [s, dir] of barricades) {
    const { across, along } = yawsAt(s);
    const lat = rng.range(0.9, 2.1) * (rng.chance(0.5) ? 1 : -1);
    push('sawhorse', s, lat, 0.15, across);
    if (rng.chance(0.6)) push('sawhorse', s + dir * rng.range(1.6, 2.4), -lat * rng.range(0.6, 1.1), 0.15, across);
    for (let k = 0; k < 4; k++) push('trafficCone', s + dir * rng.range(-0.8, 2.8), rng.range(-2.6, 2.6), 3);
    push(rng.chance(0.5) ? 'waterBarrier' : 'sandbags', s + dir * rng.range(0, 1.5), (lat > 0 ? -1 : 1) * (hw - 1.05), 0.05, along);
  }
  // Both walls lined with site clutter from just inside the fences.
  const total = SITE_MIX.reduce((t, [, w]) => t + w, 0);
  const pick = (): PropKind => {
    let x = rng.range(0, total);
    for (const [k, w] of SITE_MIX) if ((x -= w) < 0) return k;
    return 'crate';
  };
  for (const side of [1, -1]) {
    let s = s0 + SITE.inside + rng.range(0, 2);
    while (s < s1 - SITE.inside) {
      let kind = pick();
      let r = PROP_DEFS[kind].radius;
      let lat = hw - r - 0.15;
      if (SOFT.has(kind)) {
        if (rng.chance(SITE.intrude)) lat = Math.max(0.4, lat - rng.range(0.6, 1.9));
      } else {
        // Heavy pieces stand flush to the wall, and out of the line down the middle or not at all.
        lat = hw - r - 0.05;
        if (lat - r < LANE) {
          kind = 'crate';
          r = PROP_DEFS[kind].radius;
          lat = hw - r - 0.15;
        }
      }
      const at = s + r;
      if (at > s1 - SITE.inside) break;
      const yaw = kind === 'waterBarrier' || kind === 'dumpster' ? yawsAt(at).along + (side > 0 ? 0 : Math.PI) : undefined;
      if (kind === 'trafficCone') {
        for (let k = 0; k < 3; k++) push('trafficCone', at + rng.range(-0.6, 0.6), side * (lat - rng.range(0, 1.2)), 3);
      } else push(kind, at, side * lat, kind === 'dumpster' ? 0.05 : 0.6, yaw);
      s = at + r + rng.range(SITE.gap[0], SITE.gap[1]);
    }
  }
}

/** The face under a jump exit's lip stands this far past the terrain's drop (m): the road mesh's step (one tessellation piece) hides inside its block. */
const LIP_FACE = 1.0;

/** Soft clutter below a jump exit's lip and around its landing side (everything breaks at a touch). */
const LANDING_MIX: PropKind[] = ['crate', 'barrel', 'trashBags', 'pallets', 'trashBags', 'crate'];

/**
 * A route shortcut's jump exit on its last leg (see the header): the ramp as
 * a height modifier (fading out behind the walls like the kicker, dropping to
 * street level past the lip), the face under the lip as an 'alleyLip' wall
 * toward the street (Wall.top settled once the terrain exists, see
 * settleAlleyLips), reserved circles along the flight so street furniture
 * keeps off it, the deck hint for the renderer, and soft clutter: along the
 * obtuse wall below the lip, on the street's sidewalk in the acute pocket
 * beside the mouth and along the curb past the landing.
 */
export function addJumpExit(ctx: BuildContext, area: Area, b: AreaBuild, path: Vec2[], hw: number, rng: Rng): void {
  const J = CITY.districts.backAlley.route.jump;
  const F = CITY.districts.backAlley.jumpFade;
  const P = area.params;
  const n = path.length;
  const O = path[n - 2];
  const B = path[n - 1];
  const u = unit(O, B);
  const sLip = u.len - P.lipS;
  const sToe = sLip - J.length;
  const H = J.rise;
  const at = (s: number, l: number): Vec2 => ({ x: O.x + u.x * s - u.z * l, z: O.z + u.z * s + u.x * l });
  const corners = [at(sToe - 0.5, -(hw + F)), at(sToe - 0.5, hw + F), at(sLip + 0.5, -(hw + F)), at(sLip + 0.5, hw + F)];
  b.heightMods.push({
    minX: Math.min(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x: number, z: number, out: HeightSample) {
      const dx = x - O.x;
      const dz = z - O.z;
      const s = dx * u.x + dz * u.z;
      if (s <= sToe || s > sLip) return;
      const l = -dx * u.z + dz * u.x;
      const p = jumpRampProfile(s - sToe, J.length, H);
      const al = Math.abs(l);
      const m = smooth01(hw + F, hw, al, SMOOTH);
      if (m.v <= 0) return;
      const sl = l < 0 ? -1 : 1;
      out.h += p.h * m.v;
      out.gx += m.v * p.dh * u.x + p.h * m.d * sl * -u.z;
      out.gz += m.v * p.dh * u.z + p.h * m.d * sl * u.x;
    },
  });
  // The face under the lip, wall to wall, toward the street, LIP_FACE past the drop (the renderer's block
  // covers the step between them); full height until settled.
  const right = at(sLip + LIP_FACE, -hw);
  const left = at(sLip + LIP_FACE, hw);
  b.walls.push({ ax: right.x, az: right.z, bx: left.x, bz: left.z, nx: u.x, nz: u.z, kind: 'wall', look: 'alleyLip', area: area.id, top: Infinity });
  b.hints.push({ kind: 'jumpExit', points: [O, { x: O.x + u.x, z: O.z + u.z }], values: [sToe, J.length, H, hw] });
  // The flight: furniture keeps off the corridor from the lip to the furthest landing.
  const spread = Math.tan(J.spreadDeg * RAD);
  for (let s = 0; s <= P.landMax + 6; s += 3) {
    const c = at(sLip + s, 0);
    b.reserved.push({ x: c.x, z: c.z, r: hw + s * spread + CAR_HALF });
  }
  // The exit street at B: forward is the street edge leaving B the way the leg heads.
  const g = ctx.graph;
  const nodeB = g.nodes[area.nodes[n - 1]];
  let uE = { x: u.x, z: u.z };
  let OB = hw;
  for (const eid of nodeB.edges) {
    const e = g.edges[eid];
    if (e.shortcut) continue;
    const d = unit(nodeB, g.nodes[otherNode(e, nodeB.id)]);
    if (d.x * u.x + d.z * u.z <= 0) continue;
    uE = { x: d.x, z: d.z };
    OB = e.width / 2 + e.sidewalk;
  }
  const cosT = Math.abs(u.x * uE.x + u.z * uE.z);
  const sinT = Math.max(0.2, Math.sqrt(Math.max(0, 1 - cosT * cosT)));
  // The forward street lies on the obtuse side of the mouth; the alley's walls end sObtuse and sAcute before B.
  const sideF = Math.sign(u.x * uE.z - u.z * uE.x) || 1;
  const sObtuse = (OB - hw * cosT) / sinT;
  const sAcute = (OB + hw * cosT) / sinT;
  // Every piece inside the area's outline (its mouth and landing tongue), the rule for district clutter.
  const push = (kind: PropKind, p: Vec2, yaw: number, jitter: number) => {
    const y = yaw + rng.range(-jitter, jitter);
    if (pointInPolygon(p.x, p.z, area.polygon)) b.destructibles.push({ kind, x: p.x, z: p.z, yaw: y, lift: 0, area: area.id });
  };
  // Below the lip: pieces along the obtuse wall between the face and where that wall ends.
  for (let s = sLip + 1.4; s < u.len - sObtuse - 1.2; s += rng.range(1.6, 2.6)) {
    const kind = rng.pick(LANDING_MIX);
    const r = PROP_DEFS[kind].radius;
    if (s + r > u.len - sObtuse - 1) break;
    push(kind, at(s, sideF * (hw - r - 0.2)), rng.range(0, Math.PI * 2), 0);
  }
  // Around the landing side, in street coordinates from B (forward along uE, lateral toward the block):
  // bags and cones on the sidewalk strip of the acute pocket beside the mouth, cones and a sawhorse along
  // the curb past the landing.
  const nB = { x: sideF * -uE.z, z: sideF * uE.x };
  const street = (a: number, l: number): Vec2 => ({ x: B.x + uE.x * a + nB.x * l, z: B.z + uE.z * a + nB.z * l });
  const curb = OB - CITY.sidewalk;
  for (let a = -sAcute * cosT + 3; a < -sObtuse * cosT - 2; a += rng.range(2.6, 4)) {
    const kind = rng.chance(0.6) ? 'trashBags' : rng.chance(0.5) ? 'trafficCone' : 'crate';
    push(kind, street(a, rng.range(curb + 0.8, OB - 0.9)), rng.range(0, Math.PI * 2), 0);
  }
  const alongYaw = Math.atan2(-uE.z, uE.x);
  push('sawhorse', street(rng.range(4, 9), curb + 1.1), alongYaw, 0.2);
  for (let k = 0; k < 3; k++) push('trafficCone', street(rng.range(2, 22), curb + rng.range(0.6, 1.6)), 0, 3);
  push('barrel', street(rng.range(12, 20), curb + 1.2), 0, 3);
}

/**
 * Give the face under each jump exit's lip its height (Wall.top): the street
 * in front of it plus the lip's rise less `drop`, so street cars are stopped
 * and the launching car, riding the ramp's top, passes over. Runs once the
 * terrain exists (createCity); until then the face is full height.
 */
export function settleAlleyLips(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  const J = CITY.districts.backAlley.route.jump;
  areas.forEach((a, i) => {
    if (a.kind !== 'backAlley' || !a.params.jumpExit) return;
    for (const w of builds[i].walls) {
      if (w.look !== 'alleyLip' || w.top === undefined) continue;
      const mx = (w.ax + w.bx) / 2 + w.nx * 1.5;
      const mz = (w.az + w.bz) / 2 + w.nz * 1.5;
      w.top = terrain.heightAt(mx, mz) + J.rise - J.drop;
    }
  });
}

/**
 * The flight corridor past a jump exit (world quad): from just behind the lip
 * `reach` m along the last leg, spreading at spreadDeg, padded `pad` m each side.
 */
export function jumpFlightZone(area: Area, reach: number, pad = 0): Vec2[] {
  const J = CITY.districts.backAlley.route.jump;
  const n = area.path.length;
  const O = area.path[n - 2];
  const u = unit(O, area.path[n - 1]);
  const hw = (area.params.width ?? CITY.width.backAlley) / 2 + CITY.sidewalkWidth.backAlley;
  const sLip = u.len - area.params.lipS;
  const spread = Math.tan(J.spreadDeg * RAD);
  const h0 = hw + pad;
  const h1 = hw + reach * spread + pad;
  const at = (s: number, l: number): Vec2 => ({ x: O.x + u.x * s - u.z * l, z: O.z + u.z * s + u.x * l });
  return [at(sLip - 0.5, -h0), at(sLip + reach, -h1), at(sLip + reach, h1), at(sLip - 0.5, h0)];
}

/** The area of a route shortcut (the back alley whose chain holds its first edge), if any. */
export function shortcutArea(areas: readonly Area[], sc: { edges: readonly number[] }): Area | undefined {
  return areas.find((a) => a.kind === 'backAlley' && a.edges.includes(sc.edges[0]));
}

/** A route's corner rails with every piece the flight off one of its jump exits would cross taken out (see carPark.ts railsClearOf). */
export function shortcutJumpRails<T extends Wall>(route: { shortcuts: { edges: readonly number[] }[] }, areas: readonly Area[], rails: T[]): T[] {
  const zones: Vec2[][] = [];
  for (const sc of route.shortcuts) {
    const a = shortcutArea(areas, sc);
    if (a?.params.jumpExit) zones.push(jumpFlightZone(a, a.params.landMax + 6, CAR_HALF + 1.5));
  }
  return railsClearOf(zones, rails);
}

/**
 * Dress a back alley's flared mouths: a piece from pick() at every inner point
 * of each curved curb, SITE.taper out on the asphalt, none on the street's own
 * road strip. Soft pieces only: they line the funnel, they never close it.
 */
export function funnelClutter(ctx: BuildContext, area: Area, b: AreaBuild, pick: () => PropKind, rng: Rng): void {
  const g = ctx.graph;
  for (const nid of area.nodes) {
    const n = g.nodes[nid];
    ctx.sectors[nid].forEach((sec, k) => {
      if (!sec.flared) return;
      const eA = g.edges[n.edges[k]];
      const street = eA.shortcut ? g.edges[n.edges[(k + 1) % n.edges.length]] : eA;
      const sa = g.nodes[street.a];
      const sb = g.nodes[street.b];
      for (let i = 1; i + 1 < sec.curb.length; i++) {
        const c = sec.curb[i];
        // The building line lies behind the curb, so away from it is out onto the road.
        const ox = c.x - sec.outer[i].x;
        const oz = c.z - sec.outer[i].z;
        const ol = Math.hypot(ox, oz) || 1;
        const x = c.x + (ox / ol) * SITE.taper;
        const z = c.z + (oz / ol) * SITE.taper;
        if (distToSegment(x, z, sa.x, sa.z, sb.x, sb.z) - street.width / 2 < SITE.taperClear) continue;
        // Inside the alley's outline (district clutter stays in its area): a curb curve's street end can
        // put a cone past the mouth's crossing line.
        if (!pointInPolygon(x, z, area.polygon)) continue;
        b.destructibles.push({ kind: pick(), x, z, yaw: rng.range(0, Math.PI * 2), lift: 0, area: area.id });
      }
    });
  }
}

/** Plain back alley mouths: what spills out of a back alley onto the funnel's asphalt. */
export const FUNNEL_MIX: PropKind[] = ['trashBags', 'crate', 'trashBags', 'barrel', 'trafficCone'];

/** The back alley kicker: a height modifier across the alley (fading out behind the walls) plus a render hint. */
export function addJump(b: AreaBuild, A: Vec2, ux: number, uz: number, hw: number, center: number): void {
  const cfg = CITY.districts.backAlley;
  const R = cfg.jumpRamp;
  const T = cfg.jumpTop;
  const H = cfg.jumpHeight;
  const F = cfg.jumpFade;
  const s0 = center - T / 2 - R;
  const s3 = center + T / 2 + R;
  // Bounding box of the footprint (along s0..s3, across +-(hw + F)).
  const corners: Vec2[] = [];
  for (const s of [s0, s3]) for (const l of [-(hw + F), hw + F]) corners.push({ x: A.x + ux * s - uz * l, z: A.z + uz * s + ux * l });
  b.heightMods.push({
    minX: Math.min(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x: number, z: number, out: HeightSample) {
      const dx = x - A.x;
      const dz = z - A.z;
      const s = dx * ux + dz * uz;
      const l = -dx * uz + dz * ux;
      const p = jumpProfile(s, center, R, T, H);
      if (p.h === 0 && p.dh === 0) return;
      const al = Math.abs(l);
      const m = smooth01(hw + F, hw, al, SMOOTH);
      if (m.v <= 0) return;
      const sl = l < 0 ? -1 : 1;
      out.h += p.h * m.v;
      out.gx += m.v * p.dh * ux + p.h * m.d * sl * -uz;
      out.gz += m.v * p.dh * uz + p.h * m.d * sl * ux;
    },
  });
  b.hints.push({ kind: 'jump', points: [A, { x: A.x + ux, z: A.z + uz }], values: [center, R, T, H, hw] });
}
