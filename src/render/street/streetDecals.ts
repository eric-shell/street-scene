/**
 * Road surface decals: the wear and tear that makes asphalt read as a used
 * street. Manhole covers and storm drains, tar seams, fresh patches, cracks,
 * oil at the junctions, rubber laid into every route corner (braking marks
 * on the approach, a rubbered apex, exit streaks) and burnout marks at the
 * grid, worn crosswalk paint under the wheel tracks, lane arrows at the
 * junctions, bike lanes on some avenues, red and yellow curb zones with their
 * stencils, bus stop markings, gutter grime, and puddles in the gutters and
 * the dips. Everything is a quad from one procedural atlas (textures.ts
 * makeStreetDecalAtlas) with a matching roughness atlas, so tar and oil gloss
 * while paint stays matte: one draw call for the decals, one for the puddles
 * (a mirror material of their own). Seeded from the world, render only.
 *
 * Four street details ride on the same two draw calls: tram tracks down the boulevards (tramTracks.ts: the setts
 * band and the dark groove at each rail here, the steel as its own merged mesh), cobbled crosswalks (a band of setts
 * instead of the worn stripes at a seeded share of the plain downtown junctions), yellow box hatching on the busiest
 * downtown junctions (Medium and up), and a darker iron ring on the manholes and drains. The setts are paint on the
 * sim's unchanged asphalt: real cobbles would grip differently and rewrite every replay, so the grip stays deliberately
 * the asphalt's. Every manhole, drain and rail drawn is also recorded in `spots` (streetSpots.ts) so the player's
 * wheels can clank over them (game/session/audio.ts).
 *
 * A seed's home (cityIdentity.ts signature) dresses its own region: a New York home steams most of its
 * downtown manholes (steam.ts draws the plumes), a Miami home lays terrazzo slabs along the downtown sidewalks.
 *
 * The river's channel and ramp edges get nothing: the river renderer paints
 * its own floor, and a decal draped on the terrain under a bridge deck would
 * hang at deck level 4 m over the floor (the terrain there is the deck,
 * World.heightAt without a body height). The route's rubber samples the
 * lower level at a corner on the channel floor for the same reason.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { CITY } from '../../city/config';
import { Vec2, lerp } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { DECAL_ATLAS_SIZE, DECAL_CELLS, DecalKind, AtlasCell } from '../textures/textures';
import { baysByEdge } from '../../city/busBays';
import { planParking } from '../../city/parking';
import { bayMouth } from './busBays';
import { downtownFactor, isBendNode, isRiverEdge } from '../../city/roadGraph';
import { regionAt } from '../buildings/architecture';
import { signatureAt } from '../cityIdentity';
import { StreetSpots } from './streetSpots';
import { TRAM, buildTramRails, planTram, resample } from './tramTracks';

export interface DecalOptions {
  /** Multiplies every density (graphics tier). */
  density: number;
  /** Puddles on, off. */
  puddles: boolean;
  /** Yellow box hatching on the busiest junctions (Medium and up). */
  hatching: boolean;
}

export interface StreetDecals {
  meshes: THREE.Mesh[];
  /** Manholes that steam (steam.ts): position on the road. */
  vents: THREE.Vector3[];
  /** The covers, grates and rails drawn, for the wheels' clank and the rail tick. */
  spots: StreetSpots;
  dispose(): void;
}

/** Sizes (m), spacings (m) and chances. */
const DECAL = {
  lift: 0.03,
  puddleLift: 0.045,
  manhole: 0.78,
  manholeEvery: 46,
  manholeSteam: 0.12,
  alleySteam: 0.6,
  drainW: 0.95,
  drainH: 0.55,
  tarChance: 0.3,
  crackEvery: 60,
  patchChance: 0.15,
  oilChance: 0.35,
  wearW: 2.4,
  wearL: 3.6,
  arrowW: 1.1,
  arrowL: 2.9,
  arrowBack: 9.5,
  arrow2Lane: 0.3,
  bikeChance: 0.35,
  bikeW: 1.3,
  bikeEvery: 30,
  redZoneChance: 0.25,
  redZoneLen: [10, 18],
  fireChance: 0.06,
  busZone: 7,
  gutterChance: 0.5,
  gutterLen: 8,
  gutterW: 0.75,
  /** Rubber: turn angle (deg) that gets marks, fillet radius bounds (m). */
  rubberTurn: 18,
  filletMin: 9,
  filletMax: 18,
  skidW: 2.3,
  puddleEvery: 9,
  puddleRandom: 0.12,
  puddleMid: 0.25,
  /** Terrazzo slab length along the sidewalk (m) and the downtown factor a street needs for it. */
  terrazzoSlab: 3.2,
  terrazzoDowntown: 0.3,
} as const;

/** The cobbled crosswalk and the junction hatching: shares, depths and sizes (m). */
const DETAIL = {
  /** A plain street's junction cobbles its crosswalks when its node is at least this far downtown, at this seeded share. */
  cobbleDowntown: 0.5,
  cobbleShare: 0.5,
  /** The band runs from the mouth over the painted stripes' span (cityMeshes: 1.2 to 4.2 m in), this wide of a margin to each curb. */
  cobbleFrom: 1.15,
  cobbleTo: 4.25,
  cobbleMargin: 0.45,
  /** Pale paving bars along the band's two long edges. */
  cobbleBar: 0.2,
  /** Hatching: a node needs this many roads and downtown factor; this many are painted; the box is this share of the narrowest road, clamped (m); bar width and spacing (m). */
  hatchRoads: 4,
  hatchDowntown: 0.55,
  hatchCount: 3,
  hatchShare: 0.8,
  hatchSize: [8, 15],
  hatchBar: 0.22,
  hatchEvery: 1.7,
  /** A cover or grate the wheels clank over: the radius a tyre must pass within (m). */
  clankManhole: 0.4,
  clankDrain: 0.42,
} as const;

const SETTS_PALE = new THREE.Color(0xb9b2a6);
const GROOVE = new THREE.Color(0x070708);
const HATCH_YELLOW = new THREE.Color(0xe8b81c);
const ASPHALT = new THREE.Color(0x23242a);
const WHITE = new THREE.Color(1, 1, 1);
const PAINT_RED = new THREE.Color(0xc8302a);
const PAINT_YELLOW = new THREE.Color(0xe0b020);
const BIKE_GREEN = new THREE.Color(0x3ab05c);
const PUDDLE = new THREE.Color(0x9aa4b4);

function cellUv(cell: AtlasCell): { u0: number; u1: number; v0: number; v1: number } {
  const S = DECAL_ATLAS_SIZE;
  return { u0: cell.x / S, u1: (cell.x + cell.w) / S, v1: 1 - cell.y / S, v0: 1 - (cell.y + cell.h) / S };
}

export function buildStreetDecals(world: World, atlas: { map: THREE.Texture; roughness: THREE.Texture }, opts: DecalOptions): StreetDecals {
  const rng = new Rng(world.seed ^ 0x5ca1e);
  const g = world.graph;
  const mouths = world.blocks.mouths;
  const h = world.heightAt;
  /** The channel floor under a bridge deck (the same ground as `h` everywhere else). */
  const hLow = (x: number, z: number) => world.heightAt(x, z, -Infinity);
  const gb = new GeoBuilder(true);
  const pb = new GeoBuilder(true);
  const vents: THREE.Vector3[] = [];
  const spots = new StreetSpots();
  const tram = planTram(world);
  const regionOf = regionAt(world);
  const terrazzoRng = new Rng(deriveSeed(world.seed, 'terrazzo'));
  const normalAt = (x: number, z: number): [number, number, number] => {
    const s = world.slopeAt(x, z);
    const l = Math.hypot(s.gx, 1, s.gz);
    return [-s.gx / l, 1 / l, -s.gz / l];
  };
  /**
   * A decal quad centred at (cx, cz), `w` across and `len` along its heading
   * (sin yaw, cos yaw). The cell's top is the heading: text reads for a driver
   * facing that way, the cell's right is the driver's right.
   */
  const quad = (out: GeoBuilder, kind: DecalKind, cx: number, cz: number, yaw: number, w: number, len: number, color: THREE.Color, lift: number = DECAL.lift, ground = h) => {
    const uv = cellUv(DECAL_CELLS[kind]);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    const corners = [
      [cx - fx * (len / 2) - rx * (w / 2), cz - fz * (len / 2) - rz * (w / 2), uv.u0, uv.v0],
      [cx - fx * (len / 2) + rx * (w / 2), cz - fz * (len / 2) + rz * (w / 2), uv.u1, uv.v0],
      [cx + fx * (len / 2) + rx * (w / 2), cz + fz * (len / 2) + rz * (w / 2), uv.u1, uv.v1],
      [cx + fx * (len / 2) - rx * (w / 2), cz + fz * (len / 2) - rz * (w / 2), uv.u0, uv.v1],
    ];
    const ids = corners.map(([x, z, u, v]) => {
      const [nx, ny, nz] = normalAt(x, z);
      return out.vertex(x, ground(x, z) + lift, z, nx, ny, nz, u, v, color);
    });
    out.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
  };
  /** A long strip from a to b, `w` wide, subdivided every 6 m so it follows the hills; the cell repeats along it. */
  const strip = (out: GeoBuilder, kind: DecalKind, a: Vec2, b: Vec2, w: number, color: THREE.Color, lift: number = DECAL.lift) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) return;
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / 6));
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const cx = a.x + (b.x - a.x) * ((t0 + t1) / 2);
      const cz = a.z + (b.z - a.z) * ((t0 + t1) / 2);
      quad(out, kind, cx, cz, yaw, w, len * (t1 - t0), color, lift);
    }
  };
  /** Painted curb: the vertical face (seen from the road) plus a strip on the sidewalk's edge. */
  const curbPaint = (a: Vec2, b: Vec2, inward: Vec2, color: THREE.Color) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const uv = cellUv(DECAL_CELLS.paint);
    const n = Math.max(1, Math.ceil(len / 4));
    const ch = CITY.curbHeight;
    for (let i = 0; i < n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
      const q = { x: a.x + ((b.x - a.x) * (i + 1)) / n, z: a.z + ((b.z - a.z) * (i + 1)) / n };
      const ox = inward.x * 0.015;
      const oz = inward.z * 0.015;
      const yp = h(p.x, p.z);
      const yq = h(q.x, q.z);
      const v0 = gb.vertex(p.x + ox, yp + 0.025, p.z + oz, inward.x, 0, inward.z, uv.u0, uv.v0, color);
      const v1 = gb.vertex(q.x + ox, yq + 0.025, q.z + oz, inward.x, 0, inward.z, uv.u1, uv.v0, color);
      const v2 = gb.vertex(q.x + ox, yq + ch + 0.01, q.z + oz, inward.x, 0, inward.z, uv.u1, uv.v1, color);
      const v3 = gb.vertex(p.x + ox, yp + ch + 0.01, p.z + oz, inward.x, 0, inward.z, uv.u0, uv.v1, color);
      gb.quadFacing(v0, v1, v2, v3, inward.x, 0, inward.z);
      // Top strip 22 cm onto the sidewalk.
      const bx = -inward.x * 0.22;
      const bz = -inward.z * 0.22;
      const t0 = gb.vertex(p.x, yp + ch + 0.012, p.z, 0, 1, 0, uv.u0, uv.v0, color);
      const t1 = gb.vertex(q.x, yq + ch + 0.012, q.z, 0, 1, 0, uv.u1, uv.v0, color);
      const t2 = gb.vertex(q.x + bx, yq + ch + 0.012, q.z + bz, 0, 1, 0, uv.u1, uv.v1, color);
      const t3 = gb.vertex(p.x + bx, yp + ch + 0.012, p.z + bz, 0, 1, 0, uv.u0, uv.v1, color);
      gb.quadFacing(t0, t1, t2, t3, 0, 1, 0);
    }
  };
  const dark = (k: number) => new THREE.Color(k, k, k);
  const D = opts.density;

  // Bus stops: yellow curbs and a stencil in the curb lane next to each (a bus bay paints its own, render/street/busBays.ts).
  const busStops = world.props.filter((p) => p.kind === 'busStop' && p.bay === undefined);
  const bayOf = baysByEdge(world.blocks.bays ?? [], g.edges.length);
  /** The sides of each edge that carry a kerb parking row (1 / -1 as the plan's side, the same geometric side as here): their curb is the parking lane's, so no red or loading zone and no bike strip there. */
  const parkedSides = new Map<number, Set<number>>();
  for (const row of planParking(world).rows) {
    const sides = parkedSides.get(row.edge);
    if (sides) sides.add(row.side);
    else parkedSides.set(row.edge, new Set([row.side]));
  }

  /** Whether a plain street's crosswalks at this junction are cobbled: downtown, outside any district (a river bank, a market), every road a plain street or an alley, a seeded share (a hash of the node, so every street of the junction agrees). */
  const cobbleMemo = new Map<number, boolean>();
  const cobbleAt = (node: number): boolean => {
    let hit = cobbleMemo.get(node);
    if (hit === undefined) {
      const n = g.nodes[node];
      const plain = n.edges.every((id) => ['street', 'alley', 'backAlley'].includes(g.edges[id].kind));
      hit = !n.ring && n.edges.length >= 3 && plain && !world.areaAt(n.x, n.z) && downtownFactor(g.plan, n.x, n.z) >= DETAIL.cobbleDowntown && new Rng(deriveSeed(world.seed, `cobblewalk:${node}`)).chance(DETAIL.cobbleShare);
      cobbleMemo.set(node, hit);
    }
    return hit;
  };

  // ---------- per edge ----------
  g.edges.forEach((e, ei) => {
    if (isRiverEdge(e)) return;
    const m = mouths[ei];
    const alley = e.kind === 'backAlley' || e.kind === 'alley';
    const a = { x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 };
    const b = { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 10) return;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    // Left of travel a -> b, like the lane markings.
    const nx = -dz;
    const nz = dx;
    const half = e.width / 2;
    const yawAB = Math.atan2(dx, dz);
    const yawBA = yawAB + Math.PI;
    const at = (s: number, lat: number): Vec2 => ({ x: a.x + dx * s + nx * lat, z: a.z + dz * s + nz * lat });
    // A bay's stretch of curb (a bus bay or a path's mouth; m along a -> b, a little margin), on its side (1 = left): no gutter decals there.
    const bays = bayOf[ei].map((b) => ({ side: b.side, at: bayMouth(b, a, dx, dz) }));
    const parked = parkedSides.get(ei);
    const inBay = (side: number, s0: number, s1: number) => bays.some((b) => b.side === side && s1 > b.at[0] - 1 && s0 < b.at[1] + 1);
    // Lanes: offset (left +), heading of the traffic in it (right hand traffic: negative offsets run a -> b).
    const lanes: { lat: number; yaw: number; outer: boolean }[] = [];
    if (e.lanes === 2) {
      lanes.push({ lat: -half / 2, yaw: yawAB, outer: true }, { lat: half / 2, yaw: yawBA, outer: true });
    } else {
      lanes.push(
        { lat: -half / 4, yaw: yawAB, outer: false },
        { lat: (-3 * half) / 4, yaw: yawAB, outer: true },
        { lat: half / 4, yaw: yawBA, outer: false },
        { lat: (3 * half) / 4, yaw: yawBA, outer: true },
      );
    }

    // Manholes in the lanes (some steam), a rust ring under a few.
    const manholes = alley ? (len > 30 ? 1 : 0) : Math.round((len / DECAL.manholeEvery) * D);
    for (let i = 0; i < manholes; i++) {
      const s = rng.range(12, len - 12);
      const lane = lanes[rng.int(0, lanes.length - 1)];
      const p = at(s, alley ? rng.range(-half * 0.4, half * 0.4) : lane.lat + rng.range(-0.4, 0.4));
      const yaw = rng.range(0, Math.PI * 2);
      if (rng.chance(0.3)) quad(gb, 'rust', p.x, p.z, yaw, DECAL.manhole * 1.9, DECAL.manhole * 1.9, WHITE, DECAL.lift - 0.004);
      quad(gb, rng.chance(0.5) ? 'manholeA' : 'manholeB', p.x, p.z, yaw, DECAL.manhole, DECAL.manhole, WHITE);
      spots.addDisc(p.x, p.z, DETAIL.clankManhole, 'manhole');
      // The draw is always taken (the stream never shifts); a New York home steams most of its downtown covers (cityIdentity.ts steam).
      const steam = alley ? undefined : signatureAt(world.seed, regionOf(p.x, p.z)).steam;
      const steamChance = alley ? DECAL.alleySteam : steam ? lerp(steam.chance, steam.downtown, downtownFactor(g.plan, p.x, p.z)) : DECAL.manholeSteam;
      if (rng.chance(steamChance)) vents.push(new THREE.Vector3(p.x, h(p.x, p.z) + 0.05, p.z));
    }
    if (alley) {
      // Alleys: cracks and tar, no paint, no drains.
      for (let i = 0; i < Math.round((len / 40) * D); i++) {
        const p = at(rng.range(8, len - 8), rng.range(-half * 0.5, half * 0.5));
        quad(gb, rng.chance(0.5) ? 'cracksA' : 'cracksB', p.x, p.z, rng.range(0, Math.PI * 2), 3.2, 3.2, dark(0.12));
      }
      if (rng.chance(0.5)) {
        const p = at(rng.range(12, len - 12), rng.range(-half * 0.3, half * 0.3));
        quad(gb, 'tarA', p.x, p.z, yawAB + rng.range(-0.4, 0.4), 2.4, 1.3, WHITE);
      }
      return;
    }
    // Storm drains at both ends of each curb (junction ends: a bend node is no corner, roadGraph.ts).
    const bendA = isBendNode(g, e.a);
    const bendB = isBendNode(g, e.b);
    for (const [s, dir] of [
      [6, 1],
      [len - 6, -1],
    ] as const) {
      if (dir > 0 ? bendA : bendB) continue;
      for (const side of [1, -1]) {
        const p = at(s, side * (half - 0.5));
        quad(gb, 'drain', p.x, p.z, yawAB + (dir < 0 ? Math.PI : 0), DECAL.drainW, DECAL.drainH, WHITE);
        spots.addDisc(p.x, p.z, DETAIL.clankDrain, 'drain');
      }
    }
    // Miami terrazzo: pale slabs laid along the downtown sidewalks (its own stream, only a Miami home draws from it).
    const mid = at(len / 2, 0);
    const terrazzo = signatureAt(world.seed, regionOf(mid.x, mid.z)).hotels?.terrazzo;
    if (terrazzo && downtownFactor(g.plan, mid.x, mid.z) >= DECAL.terrazzoDowntown) {
      const slab = Math.min(DECAL.terrazzoSlab, e.sidewalk - 0.6);
      for (const side of [1, -1]) {
        for (let s = 9 + DECAL.terrazzoSlab / 2; s < len - 9; s += DECAL.terrazzoSlab) {
          if (!terrazzoRng.chance(terrazzo)) continue;
          const p = at(s, side * (half + e.sidewalk / 2));
          quad(gb, 'terrazzo', p.x, p.z, yawAB, slab, DECAL.terrazzoSlab, WHITE, CITY.curbHeight + DECAL.lift - 0.01);
        }
      }
    }
    // Cracks, tar seams, fresh patches, gutter grime.
    for (let i = 0; i < Math.round((len / DECAL.crackEvery) * D); i++) {
      const p = at(rng.range(8, len - 8), rng.range(-half * 0.85, half * 0.85));
      quad(gb, rng.chance(0.5) ? 'cracksA' : 'cracksB', p.x, p.z, rng.range(0, Math.PI * 2), rng.range(3, 4.5), rng.range(3, 4.5), dark(0.1));
    }
    for (let i = 0; i < 2; i++) {
      if (!rng.chance(DECAL.tarChance * D)) continue;
      const p = at(rng.range(10, len - 10), rng.range(-half * 0.7, half * 0.7));
      quad(gb, rng.chance(0.5) ? 'tarA' : 'tarB', p.x, p.z, yawAB + rng.range(-0.5, 0.5), rng.range(2.2, 3.4), rng.range(1, 1.7), WHITE);
    }
    if (rng.chance(DECAL.patchChance * D)) {
      const p = at(rng.range(14, len - 14), rng.range(-half * 0.6, half * 0.6));
      quad(gb, 'patch', p.x, p.z, yawAB + rng.range(-0.08, 0.08), rng.range(2, 3), rng.range(4, 8), WHITE);
    }
    for (const side of [1, -1]) {
      if (!rng.chance(DECAL.gutterChance * D)) continue;
      const s = rng.range(10, len - 10 - DECAL.gutterLen);
      if (inBay(side, s, s + DECAL.gutterLen)) continue;
      // The cell fades across its height: lay it with the dark edge on the curb.
      const p = at(s + DECAL.gutterLen / 2, side * (half - DECAL.gutterW / 2 + 0.05));
      quad(gb, 'gutter', p.x, p.z, yawAB + (side > 0 ? Math.PI / 2 : -Math.PI / 2), DECAL.gutterLen, DECAL.gutterW, WHITE);
    }
    // Worn crosswalk paint under the wheel tracks of every lane, at both junction ends.
    for (const [from, dir] of [
      [0, 1],
      [len, -1],
    ] as const) {
      if (dir > 0 ? bendA : bendB) continue;
      if (e.kind === 'street' && cobbleAt(dir > 0 ? e.a : e.b)) {
        // A cobbled crosswalk: setts over the painted stripes, between two pale bars.
        const x0 = from + dir * DETAIL.cobbleFrom;
        const x1 = from + dir * DETAIL.cobbleTo;
        const across = half - DETAIL.cobbleMargin;
        const cols = Math.max(2, Math.round((2 * across) / TRAM.bandPiece));
        for (let k = 0; k < cols; k++) {
          const p = at((x0 + x1) / 2, -across + ((k + 0.5) * 2 * across) / cols);
          quad(gb, 'setts', p.x, p.z, yawAB, (2 * across) / cols, Math.abs(x1 - x0), WHITE, DECAL.lift + 0.002);
        }
        for (const edge of [x0, x1]) strip(gb, 'paint', at(edge, -across), at(edge, across), DETAIL.cobbleBar, SETTS_PALE, DECAL.lift + 0.004);
        continue;
      }
      for (const lane of lanes) {
        // The tram owns the inner lanes' wheel tracks.
        if (tram.edges.has(ei) && !lane.outer) continue;
        const p = at(from + dir * 2.7, lane.lat);
        quad(gb, 'wear', p.x, p.z, yawAB, DECAL.wearW, DECAL.wearL, ASPHALT);
      }
    }
    // Lane arrows before each junction (every 4 lane approach, some 2 lane ones).
    for (const lane of lanes) {
      const toB = Math.abs(lane.yaw - yawAB) < 1e-6;
      if (tram.edges.has(ei) && !lane.outer) continue;
      if (e.lanes === 2 && !rng.chance(DECAL.arrow2Lane * D)) continue;
      if (toB ? bendB : bendA) continue;
      const s = toB ? len - DECAL.arrowBack : DECAL.arrowBack;
      const p = at(s, lane.lat);
      let kind: DecalKind = 'arrowStraight';
      if (e.lanes === 4) kind = lane.outer ? (rng.chance(0.5) ? 'arrowRight' : 'arrowStraightRight') : rng.chance(0.4) ? 'arrowStraightLeft' : 'arrowStraight';
      else kind = rng.pick(['arrowStraight', 'arrowStraightRight', 'arrowStraightLeft', 'arrowRight']);
      quad(gb, kind, p.x, p.z, lane.yaw, DECAL.arrowW, DECAL.arrowL, WHITE);
    }
    // Bike lanes along the curb lanes of some avenues: a green strip with stencils.
    if (e.lanes === 4 && rng.chance(DECAL.bikeChance)) {
      for (const side of [1, -1]) {
        if (parked?.has(side)) continue;
        const lat = side * (half - 0.45 - 0.12 - DECAL.bikeW / 2);
        strip(gb, 'paint', at(6, lat), at(len - 6, lat), DECAL.bikeW, BIKE_GREEN, DECAL.lift - 0.006);
        const yaw = side > 0 ? yawBA : yawAB;
        for (let s = 14; s < len - 10; s += DECAL.bikeEvery) {
          const p = at(s, lat);
          quad(gb, 'bike', p.x, p.z, yaw, 1.05, 1.05, WHITE);
        }
      }
    }
    // Curb zones: red (no stopping, some tow away), fire lanes, yellow at bus stops with a stencil.
    for (const side of [1, -1]) {
      const inward = { x: -nx * side, z: -nz * side };
      const curbA = side > 0 ? m.aP.curb : m.aN.curb;
      const curbB = side > 0 ? m.bP.curb : m.bN.curb;
      const clen = Math.hypot(curbB.x - curbA.x, curbB.z - curbA.z);
      const cAt = (s: number): Vec2 => ({ x: curbA.x + ((curbB.x - curbA.x) * s) / clen, z: curbA.z + ((curbB.z - curbA.z) * s) / clen });
      const laneYaw = side > 0 ? yawBA : yawAB;
      const stops = busStops.filter((p) => {
        const t = (p.x - curbA.x) * dx + (p.z - curbA.z) * dz;
        if (t < 4 || t > clen - 4) return false;
        const lat = (p.x - curbA.x) * nx + (p.z - curbA.z) * nz;
        return Math.abs(lat) < 3.5 && Math.sign(lat || 1) === side;
      });
      for (const stop of stops) {
        const t = (stop.x - curbA.x) * dx + (stop.z - curbA.z) * dz;
        curbPaint(cAt(Math.max(1, t - DECAL.busZone)), cAt(Math.min(clen - 1, t + DECAL.busZone)), inward, PAINT_YELLOW);
        const p = at(t, side * (half - 1.3));
        quad(gb, 'busStop', p.x, p.z, laneYaw, 1.1, 3.2, WHITE);
      }
      if (bays.some((b) => b.side === side) || parked?.has(side)) continue;
      if (stops.length === 0 && clen > 40 && rng.chance(DECAL.redZoneChance * D)) {
        const zl = rng.range(DECAL.redZoneLen[0], DECAL.redZoneLen[1]);
        const s0 = rng.range(8, clen - 8 - zl);
        const fire = rng.chance(DECAL.fireChance / DECAL.redZoneChance);
        curbPaint(cAt(s0), cAt(s0 + zl), inward, PAINT_RED);
        const p = at(s0 + zl / 2, side * (half - 1.25));
        quad(gb, fire ? 'fireLane' : rng.chance(0.4) ? 'towAway' : 'noParking', p.x, p.z, laneYaw, 1.0, 3.0, WHITE);
      } else if (stops.length === 0 && clen > 50 && rng.chance(0.1 * D)) {
        const s0 = rng.range(10, clen - 22);
        curbPaint(cAt(s0), cAt(s0 + 12), inward, PAINT_YELLOW);
        const p = at(s0 + 6, side * (half - 1.25));
        quad(gb, 'loading', p.x, p.z, laneYaw, 1.0, 3.0, WHITE);
      }
    }
    // Puddles: gutters where the curb dips, a few at random, and the odd one mid lane.
    if (opts.puddles) {
      for (const side of [1, -1]) {
        for (let s = 12; s < len - 12; s += DECAL.puddleEvery) {
          const p0 = at(s - DECAL.puddleEvery, side * (half - 0.6));
          const p1 = at(s, side * (half - 0.6));
          const p2 = at(s + DECAL.puddleEvery, side * (half - 0.6));
          const dip = h(p1.x, p1.z) < h(p0.x, p0.z) && h(p1.x, p1.z) < h(p2.x, p2.z);
          if (!dip && !rng.chance(DECAL.puddleRandom * D)) continue;
          const w = rng.range(0.9, 1.6);
          const ps = s + rng.range(-3, 3);
          if (inBay(side, ps - 3, ps + 3)) continue;
          const p = at(ps, side * (half - w / 2 - 0.05));
          quad(pb, 'puddle', p.x, p.z, yawAB + rng.range(-0.1, 0.1), w, rng.range(2.5, 6), PUDDLE, DECAL.puddleLift);
        }
      }
      for (let s = 20; s < len - 20; s += 15) {
        const p = at(s, rng.range(-half * 0.5, half * 0.5));
        const q = at(s - 15, 0);
        const r = at(s + 15, 0);
        if (h(p.x, p.z) < h(q.x, q.z) && h(p.x, p.z) < h(r.x, r.z) && rng.chance(DECAL.puddleMid)) {
          quad(pb, 'puddle', p.x, p.z, rng.range(0, Math.PI), rng.range(1.8, 3.2), rng.range(2.2, 3.6), PUDDLE, DECAL.puddleLift);
        }
      }
    }
  });

  // ---------- tram tracks: the setts band under each lane's pair of rails, a dark groove round each head ----------
  const settsColor = new THREE.Color(0.92, 0.9, 0.88);
  for (const band of tram.bands) {
    const pts = resample(band, TRAM.bandPiece);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      quad(gb, 'setts', (a.x + b.x) / 2, (a.z + b.z) / 2, Math.atan2(b.x - a.x, b.z - a.z), TRAM.gauge + TRAM.bandMargin, l, settsColor, DECAL.lift - 0.008);
    }
  }
  for (const rail of tram.rails) {
    const pts = resample(rail, TRAM.step);
    for (let i = 0; i + 1 < pts.length; i++) {
      strip(gb, 'paint', pts[i], pts[i + 1], TRAM.groove, GROOVE, DECAL.lift - 0.004);
      spots.addRail(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z);
    }
  }

  // ---------- junction hatching: yellow box lines on the busiest downtown junctions ----------
  if (opts.hatching) {
    const roads = (id: number) => g.nodes[id].edges.filter((eid) => !['alley', 'backAlley'].includes(g.edges[eid].kind));
    const busy = g.nodes
      .filter((n) => !n.ring && !world.areaAt(n.x, n.z) && !tram.nodes.has(n.id) && roads(n.id).length >= DETAIL.hatchRoads && roads(n.id).every((eid) => ['street', 'avenue', 'boulevard', 'diagonal'].includes(g.edges[eid].kind)) && downtownFactor(g.plan, n.x, n.z) >= DETAIL.hatchDowntown)
      .sort((p, q) => roads(q.id).length - roads(p.id).length || downtownFactor(g.plan, q.x, q.z) - downtownFactor(g.plan, p.x, p.z) || p.id - q.id);
    // A seeded few of the best candidates, so two seeds with the same busiest junction do not always paint the same one.
    const hatchRng = new Rng(deriveSeed(world.seed, 'hatch'));
    const pool = busy.slice(0, DETAIL.hatchCount * 3);
    for (let k = 0; k < DETAIL.hatchCount && pool.length; k++) {
      const n = pool.splice(hatchRng.int(0, pool.length - 1), 1)[0];
      const widths = roads(n.id).map((eid) => g.edges[eid].width);
      const side = Math.min(DETAIL.hatchSize[1], Math.max(DETAIL.hatchSize[0], Math.min(...widths) * DETAIL.hatchShare));
      const first = g.edges[n.edges[0]];
      const o = g.nodes[first.a === n.id ? first.b : first.a];
      const yaw = Math.atan2(o.x - n.x, o.z - n.z);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      /** A point of the box in its own frame: u across (right), v along the first road. */
      const P = (u: number, v: number): Vec2 => ({ x: n.x - fz * u + fx * v, z: n.z + fx * u + fz * v });
      const r = side / 2;
      const line = (a: Vec2, b: Vec2) => strip(gb, 'paint', a, b, DETAIL.hatchBar, HATCH_YELLOW, DECAL.lift + 0.001);
      line(P(-r, -r), P(r, -r));
      line(P(r, -r), P(r, r));
      line(P(r, r), P(-r, r));
      line(P(-r, r), P(-r, -r));
      // Diagonals u + v = c across the box, clipped to it.
      for (let c = -side + DETAIL.hatchEvery; c < side - 0.01; c += DETAIL.hatchEvery) {
        const u0 = Math.max(-r, c - r);
        const u1 = Math.min(r, c + r);
        if (u1 - u0 > 0.5) line(P(u0, c - u0), P(u1, c - u1));
      }
    }
  }

  // ---------- junctions: oil where cars stop ----------
  g.nodes.forEach((n) => {
    if (n.edges.length < 3 || n.ring || !rng.chance(DECAL.oilChance * D)) return;
    const k = rng.int(1, 3);
    for (let i = 0; i < k; i++) {
      const e = g.edges[n.edges[rng.int(0, n.edges.length - 1)]];
      const o = g.nodes[e.a === n.id ? e.b : e.a];
      const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
      const ux = (o.x - n.x) / l;
      const uz = (o.z - n.z) / l;
      const s = rng.range(e.width / 2 + 7, e.width / 2 + 16);
      const lat = rng.range(0.15, 0.4) * e.width * (rng.chance(0.5) ? 1 : -1);
      const x = n.x + ux * s - uz * lat;
      const z = n.z + uz * s + ux * lat;
      quad(gb, 'oil', x, z, rng.range(0, Math.PI * 2), rng.range(1.2, 2), rng.range(1.2, 2), WHITE);
    }
  });

  // ---------- rubber on the route ----------
  const quadLow: Quad = (out, kind, cx, cz, yaw, w, len, color, lift) => quad(out, kind, cx, cz, yaw, w, len, color, lift, hLow);
  rubberOnRoute(world, rng, gb, quad, quadLow, D);

  const decalMat = new THREE.MeshStandardMaterial({
    map: atlas.map,
    roughnessMap: atlas.roughness,
    roughness: 1,
    metalness: 0.05,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    envMapIntensity: 1.4,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
  });
  const decals = new THREE.Mesh(gb.build(), decalMat);
  decals.name = 'roadDecals';
  decals.renderOrder = 0;
  const meshes: THREE.Mesh[] = [decals];
  const rails = buildTramRails(world, tram);
  if (rails) meshes.push(rails);
  if (pb.vertexCount) {
    const puddleMat = new THREE.MeshStandardMaterial({
      map: atlas.map,
      roughnessMap: atlas.roughness,
      roughness: 1,
      metalness: 1,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      envMapIntensity: 4,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    const puddles = new THREE.Mesh(pb.build(), puddleMat);
    puddles.name = 'puddles';
    puddles.renderOrder = 1;
    meshes.push(puddles);
  }
  return {
    meshes,
    vents,
    spots,
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}

type Quad = (out: GeoBuilder, kind: DecalKind, cx: number, cz: number, yaw: number, w: number, len: number, color: THREE.Color, lift?: number) => void;

/**
 * Rubber where the racing happens: braking marks on the approach to every
 * real corner (outside of the turn, where the line starts), a rubbered
 * fillet through the apex, exit streaks where the car runs wide, and burnout
 * marks off the grid slots. The fillet is a circular arc tangent to both
 * legs, which is close enough to the AI's smoothed line. A corner at a node
 * of the river's own (a channel bend, an entrance foot) is on the channel
 * floor, so its rubber uses `quadLow`: a braking mark there can reach under a
 * bridge deck, where the terrain is the deck.
 */
function rubberOnRoute(world: World, rng: Rng, gb: GeoBuilder, quadHigh: Quad, quadLow: Quad, D: number): void {
  const route = world.route;
  const P = route.points;
  const n = P.length;
  const dark = (k: number) => new THREE.Color(k, k, k);
  const g = world.graph;
  const floorNodes = new Set(g.nodes.filter((nd) => nd.edges.length > 0 && nd.edges.every((eid) => isRiverEdge(g.edges[eid]))).map((nd) => `${nd.x},${nd.z}`));
  const from = route.closed ? 0 : 1;
  const to = route.closed ? n - 1 : n - 1;
  for (let i = from; i < to; i++) {
    const a = P[(i - 1 + (n - 1)) % (n - 1)];
    const b = P[i];
    const c = P[(i + 1) % (n - 1)];
    if (!route.closed && (i === 0 || i === n - 1)) continue;
    const l1 = Math.hypot(b.x - a.x, b.z - a.z);
    const l2 = Math.hypot(c.x - b.x, c.z - b.z);
    if (l1 < 12 || l2 < 12) continue;
    const d1x = (b.x - a.x) / l1;
    const d1z = (b.z - a.z) / l1;
    const d2x = (c.x - b.x) / l2;
    const d2z = (c.z - b.z) / l2;
    const turn = Math.atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
    const deg = (Math.abs(turn) * 180) / Math.PI;
    if (deg < DECAL.rubberTurn) continue;
    const quad = floorNodes.has(`${b.x},${b.z}`) ? quadLow : quadHigh;
    const sgn = turn > 0 ? 1 : -1;
    const half = route.segWidth[i === 0 ? route.segWidth.length - 1 : i - 1] / 2;
    const halfOut = route.segWidth[Math.min(route.segWidth.length - 1, i)] / 2;
    // Left normal of each leg; the inside of the turn is +sgn along it.
    const n1x = -d1z;
    const n1z = d1x;
    const n2x = -d2z;
    const n2z = d2x;
    const strength = Math.min(1, deg / 90);
    const yaw1 = Math.atan2(d1x, d1z);
    const yaw2 = Math.atan2(d2x, d2z);
    // Braking marks: the car sits toward the outside before turning in.
    const marks = Math.round((2 + strength * 3) * D);
    for (let k = 0; k < marks; k++) {
      const len = rng.range(5, 11);
      const s = rng.range(10 + len / 2, Math.min(l1 - 4, 34));
      const lat = -sgn * rng.range(-0.1, 0.65) * half;
      const x = b.x - d1x * s + n1x * lat;
      const z = b.z - d1z * s + n1z * lat;
      quad(gb, 'skid', x, z, yaw1 + rng.range(-0.04, 0.04), DECAL.skidW, len, dark(rng.range(0.03, 0.12)));
    }
    // The apex: a fillet of rubber on the inside, darkest at the apex.
    const R = Math.max(DECAL.filletMin, Math.min(DECAL.filletMax, half + halfOut));
    const T = R * Math.tan(Math.abs(turn) / 2);
    if (T < l1 * 0.6 && T < l2 * 0.6) {
      const px = b.x - d1x * T;
      const pz = b.z - d1z * T;
      const cx = px + sgn * n1x * R;
      const cz = pz + sgn * n1z * R;
      const a0 = Math.atan2(pz - cz, px - cx);
      const steps = Math.max(3, Math.round((R * Math.abs(turn)) / 2.5));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const ang = a0 + turn * t;
        // The fillet itself, jittered a little so the band is not a perfect arc.
        const rr = R + rng.range(-0.3, 0.3);
        const x = cx + Math.cos(ang) * rr;
        const z = cz + Math.sin(ang) * rr;
        const tx = -Math.sin(ang) * sgn;
        const tz = Math.cos(ang) * sgn;
        const yaw = Math.atan2(tx, tz);
        const k2 = 0.06 + 0.1 * Math.abs(t - 0.5) * 2;
        quad(gb, 'rubber', x, z, yaw, 2.6 + strength, 3.2, dark(k2 + (1 - strength) * 0.06));
        if (rng.chance(0.35 * D)) quad(gb, 'skid', x + rng.range(-0.8, 0.8), z + rng.range(-0.8, 0.8), yaw + rng.range(-0.15, 0.15), DECAL.skidW, 3.2, dark(rng.range(0.05, 0.14)));
      }
    }
    // Exit: a streak or two running wide after the corner.
    const exits = Math.round((1 + strength) * D);
    for (let k = 0; k < exits; k++) {
      const len = rng.range(5, 9);
      const s = rng.range(6 + len / 2, Math.min(l2 - 4, 22));
      const lat = -sgn * rng.range(0.1, 0.6) * halfOut;
      const x = b.x + d2x * s + n2x * lat;
      const z = b.z + d2z * s + n2z * lat;
      quad(gb, 'skid', x, z, yaw2 + rng.range(-0.06, 0.06), DECAL.skidW, len, dark(rng.range(0.04, 0.12)));
    }
  }
  // Burnouts off the grid: dark pairs stretching forward from every slot.
  for (const slot of route.grid) {
    const fx = Math.sin(slot.yaw);
    const fz = Math.cos(slot.yaw);
    const len = rng.range(5, 9);
    quadHigh(gb, 'skid', slot.x + fx * (len / 2 + 1), slot.z + fz * (len / 2 + 1), slot.yaw, 2.0, len, dark(rng.range(0.02, 0.06)));
  }
}
