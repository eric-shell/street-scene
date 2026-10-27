/**
 * Baked ambient occlusion for the ground the city is driven on. The scene has
 * no shadow maps, so the road under the elevated railway, the highway deck or
 * a viaduct, the apron at a tunnel mouth and the strip along every facade
 * base were as bright as open street. This module answers one question, once
 * per world: how much light does (x, z) lose to what stands over it or beside
 * it? The builders (cityMeshes roads, cobbles, sidewalks and markings, the
 * district ground) multiply the answer into their vertex colours at build
 * time, so it costs nothing per frame and no extra triangle beyond a few
 * rows and columns where a shadow edge has to be drawn (cityMeshes
 * tessellates only where `overhead` varies or a wall is close).
 *
 *  - Overhead: the El's deck (its width from the smoothed track curve, so a
 *    station's swing-out is under it), the elevated highway's deck, a
 *    viaduct, and a tunnel's portal apron (a ramp up toward the mouth and a
 *    short plateau inside it; the bore's interior carries its own baked
 *    light, structureFx.ts). Each is a footprint with a signed distance, a
 *    smoothstep edge a few meters wide and an underside height: a surface
 *    above the underside (a deck's own top, a car park roof) is not shaded.
 *  - Contact: within OCCLUSION.wallReach of a facade, a boundary wall, a
 *    column or a monument.
 * `at` is the light lost, 0 in open street up to 1 - OCCLUSION.underDeck
 * where it is darkest; colour = 1 - at. Lamp pools (street/lightFx.ts) and
 * area lights are additive meshes laid on top and are not touched, so a lamp
 * under the El still lights its patch.
 *
 * `bakeOcclusion` writes the answer into a vertex colored GeoBuilder, and
 * `occlusionMaterial` makes a standard material honour the colour in the
 * places a plain `vertexColors` does not: the sodium glow of the road
 * (emissive) and the environment's specular, neither of which the diffuse
 * colour scales.
 */
import * as THREE from 'three';
import type { Area } from '../../city/districts/types';
import type { World } from '../../city/world';
import { RAIL, trackLateral } from '../../city/railCurve';
import { SpatialGrid } from '../../city/spatial';
import { elCurve } from '../../city/districts/subway';
import { HIGHWAY_HALF, deckExtent, deckUnderAt, highwayDeck } from '../../city/districts/highway/shape';
import { toLocal } from '../../city/districts/structures';
import { distToSegment, smoothstep } from '../../sim/math';
import type { GeoBuilder } from '../geoBuilder';
import { boreRoad, coverOf, deckLine, tunnelShape, viaductShape } from '../districts/structureShapes';

export const OCCLUSION = {
  /** Brightness (share of open street) under the middle of a deck: the El's, the highway's, a viaduct's. */
  underDeck: 0.45,
  /** Brightness at the foot of a facade; low walls and columns take their weight of the loss. */
  atWall: 0.75,
  /** Brightness at a tunnel's mouth. */
  atPortal: 0.55,
  /** Half width of a deck shadow's smoothstep edge (m): full that far inside the deck's edge, none that far outside it. */
  deckSoft: 2.5,
  /** A contact shadow reaches this far from the wall (m). */
  wallReach: 1.5,
  /** Portal apron (m): ramps up over `portalOut` outside the mouth, holds `portalPlateau` inside it, fades out over `portalFade`, and edges `portalSoft` beyond the building line. */
  portalOut: 5,
  portalPlateau: 3,
  portalFade: 6,
  portalSoft: 2.5,
  /** A surface within this height (m) of a structure's underside, or above it, is not under it. */
  clearance: 0.3,
  /** Share of a facade's contact loss by wall look; looks not listed cast none. */
  wallWeight: { building: 1, warehouse: 1, marketFront: 1, boundary: 0.55, monument: 0.7, pillar: 0.7 } as Readonly<Record<string, number>>,
  /** Deck underside below the El's tie top (m): the girders' bottom and the bent caps. */
  elUnderside: 1.3,
  /** Tessellation (m): spacing of vertices across and along a strip wherever a deck's shadow edge crosses it. */
  crossStep: 2,
  rowStep: 2.5,
} as const;

/** A footprint that shades what lies under it. */
interface Zone {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Light lost at (x, z) for a surface at height y (0 outside the footprint, or when y is above the underside). */
  loss(x: number, z: number, y: number): number;
}

/** The occlusion field of one world. */
export interface Occlusion {
  /** Light lost to everything (0 open .. 1 - OCCLUSION.underDeck at most); y (m) limits the overhead structures to those above it. */
  at(x: number, z: number, y?: number): number;
  /** Light lost to what stands overhead alone. */
  overhead(x: number, z: number, y?: number): number;
  /** Light lost to the walls beside the point alone. */
  wall(x: number, z: number): number;
  /** Whether any overhead footprint (with its soft edge) may overlap the box: a cheap test before sampling `overhead`. */
  overheadNear(minX: number, minZ: number, maxX: number, maxZ: number): boolean;
}

const cache = new WeakMap<World, Occlusion>();

/** The world's occlusion field, built once. */
export function occlusionFor(world: World): Occlusion {
  let o = cache.get(world);
  if (!o) cache.set(world, (o = build(world)));
  return o;
}

/** The query alone: light lost at (x, z) (and height y, m), 0 open .. 1 covered. */
export function occlusionAt(world: World): (x: number, z: number, y?: number) => number {
  return occlusionFor(world).at;
}

const O = OCCLUSION;

function boxOf(pts: ArrayLike<{ x: number; z: number }>, pad: number): Pick<Zone, 'minX' | 'minZ' | 'maxX' | 'maxZ'> {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

/** Loss under a deck at signed distance d (m) outside its edge. */
const deckLoss = (d: number): number => (1 - O.underDeck) * (1 - smoothstep(-O.deckSoft, O.deckSoft, d));

/** The El: the deck's width either side of its track curve, in chunks of a few samples. */
function elZones(world: World, a: Area, out: Zone[]): void {
  const b = world.districts.builds[a.id];
  if (!b) return;
  const c = elCurve(a, b, world.heightAt);
  const kA = Math.max(0, Math.floor((c.cityA - 30) / RAIL.step));
  const kB = Math.min(c.n - 2, Math.ceil((c.cityB + 30) / RAIL.step));
  const edgeOut = RAIL.trackHalf + RAIL.edgeOut;
  const pad = edgeOut + RAIL.stationSpread + O.deckSoft + 1;
  const CH = 10;
  for (let k0 = kA; k0 < kB; k0 += CH) {
    const k1 = Math.min(kB, k0 + CH);
    const pts: { x: number; z: number }[] = [];
    for (let k = k0; k <= k1; k++) pts.push({ x: c.x[k], z: c.z[k] });
    out.push({
      ...boxOf(pts, pad),
      loss(x, z, y) {
        let best = k0;
        let bd = Infinity;
        for (let k = k0; k <= k1; k++) {
          const dd = (c.x[k] - x) ** 2 + (c.z[k] - z) ** 2;
          if (dd < bd) {
            bd = dd;
            best = k;
          }
        }
        const dx = x - c.x[best];
        const dz = z - c.z[best];
        const along = dx * c.tx[best] + dz * c.tz[best];
        if (Math.abs(along) > RAIL.step) return 0;
        if (y > c.deck[best] - O.elUnderside - O.clearance) return 0;
        const lat = dx * c.px[best] + dz * c.pz[best];
        // The street side track swings out around a station's platform (trackLateral).
        const d = Math.max(trackLateral(c, 0, best * RAIL.step + along) - RAIL.edgeOut - lat, lat - edgeOut);
        return d >= O.deckSoft ? 0 : deckLoss(d);
      },
    });
  }
}

/** The elevated highway's deck between its end loops (its ramps are embankments up to the bridge stretch: left out). */
function highwayZones(world: World, a: Area, out: Zone[]): void {
  const d = highwayDeck(a, world.areas);
  if (!d.settled) return;
  const c = d.curve;
  const CH = 10;
  const reach = HIGHWAY_HALF + 1.5 + Math.max(0, ...d.ramps.filter((r) => !r.loop).map((r) => 2 * r.half)) + O.deckSoft;
  const kA = Math.max(1, Math.floor(d.sW / RAIL.step));
  const kB = Math.min(c.n - 2, Math.ceil(d.sE / RAIL.step));
  for (let k0 = kA; k0 < kB; k0 += CH) {
    const k1 = Math.min(kB, k0 + CH);
    const pts: { x: number; z: number }[] = [];
    for (let k = k0; k <= k1; k++) pts.push({ x: c.x[k], z: c.z[k] });
    out.push({
      ...boxOf(pts, reach),
      loss(x, z, y) {
        let best = k0;
        let bd = Infinity;
        for (let k = k0; k <= k1; k++) {
          const dd = (c.x[k] - x) ** 2 + (c.z[k] - z) ** 2;
          if (dd < bd) {
            bd = dd;
            best = k;
          }
        }
        const along = (x - c.x[best]) * c.tx[best] + (z - c.z[best]) * c.tz[best];
        if (Math.abs(along) > RAIL.step) return 0;
        // Right of travel toward +s (shape.ts deckPoint's sign).
        const lat = -(x - c.x[best]) * c.tz[best] + (z - c.z[best]) * c.tx[best];
        const sv = best * RAIL.step + along;
        if (y > deckUnderAt(d, sv) - O.clearance) return 0;
        const dist = Math.max(Math.abs(lat) - deckExtent(d, sv, lat >= 0 ? 1 : -1), d.sW - sv, sv - d.sE);
        return dist >= O.deckSoft ? 0 : deckLoss(dist);
      },
    });
  }
}

/** A viaduct's deck over the streets it crosses. */
function viaductZone(world: World, a: Area, out: Zone[]): void {
  const v = viaductShape(a);
  const line = deckLine(world, v);
  const pts = [
    { x: v.x0, z: v.z0 },
    { x: v.x1, z: v.z1 },
  ];
  out.push({
    ...boxOf(pts, v.half + O.deckSoft + 1),
    loss(x, z, y) {
      const dx = x - v.x0;
      const dz = z - v.z0;
      const along = dx * v.ux + dz * v.uz;
      const lat = -dx * v.uz + dz * v.ux;
      const dist = Math.max(Math.abs(lat) - v.half, -along, along - v.length);
      if (dist >= O.deckSoft) return 0;
      if (y > line.a + line.b * Math.max(0, Math.min(v.length, along)) - O.clearance) return 0;
      return deckLoss(dist);
    },
  });
}

/** A tunnel's two portal aprons: dark at the mouth, ramping up outside it and fading out inside, where the bore's own light takes over. */
function tunnelZone(world: World, a: Area, out: Zone[]): void {
  const t = tunnelShape(a);
  const mouth = coverOf(t, a.variant === 'ridge');
  const reach = mouth + O.portalOut + 1;
  const wide = t.front + O.portalSoft + 1;
  const corners = [-1, 1].flatMap((su) => [-1, 1].map((sv) => ({ x: t.cx + t.ux * su * reach - t.uz * sv * wide, z: t.cz + t.uz * su * reach + t.ux * sv * wide })));
  out.push({
    ...boxOf(corners, 0),
    loss(x, z, y) {
      const l = toLocal(t, x, z);
      const dOut = Math.abs(l.u) - mouth;
      const av = Math.abs(l.v);
      if (dOut >= O.portalOut || dOut <= -(O.portalPlateau + O.portalFade) || av >= t.front + O.portalSoft) return 0;
      if (y > boreRoad(world, t, l.u) + t.clearance + O.clearance) return 0;
      const along = dOut >= 0 ? 1 - smoothstep(0, O.portalOut, dOut) : 1 - smoothstep(O.portalPlateau, O.portalPlateau + O.portalFade, -dOut);
      const across = 1 - smoothstep(t.front - O.portalSoft, t.front + O.portalSoft, av);
      return (1 - O.atPortal) * along * across;
    },
  });
}

function build(world: World): Occlusion {
  const zones: Zone[] = [];
  for (const a of world.areas) {
    if (a.kind === 'subway') elZones(world, a, zones);
    else if (a.kind === 'highway' && a.variant === 'deck') highwayZones(world, a, zones);
    else if (a.kind === 'overpass' && a.variant === 'viaduct') viaductZone(world, a, zones);
    else if (a.kind === 'tunnel') tunnelZone(world, a, zones);
  }
  const b = world.graph.bounds;
  const pad = 60;
  const x0 = b.minX - pad;
  const z0 = b.minZ - pad;
  const x1 = b.maxX + pad;
  const z1 = b.maxZ + pad;
  // Zones wholly past the map's ends (the El's run-off) are never queried: left out of the grid.
  const zoneGrid = SpatialGrid.forBounds(x0, z0, x1, z1, 24);
  zones.forEach((z, i) => {
    if (z.maxX < x0 || z.minX > x1 || z.maxZ < z0 || z.minZ > z1) return;
    zoneGrid.insertBox(i, z.minX, z.minZ, z.maxX, z.maxZ);
  });

  // Walls that cast contact shadow: full height city walls of the looks the table weights (a low lip, a
  // deck parapet or a route barrier does not).
  const walls = world.blocks.walls.filter((w) => w.kind === 'wall' && w.look && O.wallWeight[w.look] && w.top === undefined && w.bottom === undefined && w.under === undefined);
  const wallGrid = SpatialGrid.forBounds(x0, z0, x1, z1, 6);
  walls.forEach((w, i) => wallGrid.insertSegment(i, w.ax, w.az, w.bx, w.bz, O.wallReach));
  const hit: number[] = [];

  const overhead = (x: number, z: number, y = -Infinity): number => {
    zoneGrid.query(x, z, x, z, hit);
    let best = 0;
    for (const id of hit) {
      const zn = zones[id];
      if (x < zn.minX || x > zn.maxX || z < zn.minZ || z > zn.maxZ) continue;
      const l = zn.loss(x, z, y);
      if (l > best) best = l;
    }
    return best;
  };
  const wall = (x: number, z: number): number => {
    wallGrid.query(x, z, x, z, hit);
    let best = 0;
    for (const id of hit) {
      const w = walls[id];
      const d = distToSegment(x, z, w.ax, w.az, w.bx, w.bz);
      if (d >= O.wallReach) continue;
      const l = (1 - O.atWall) * O.wallWeight[w.look!] * (1 - smoothstep(0, O.wallReach, d));
      if (l > best) best = l;
    }
    return best;
  };
  return {
    overhead,
    wall,
    at: (x, z, y) => 1 - (1 - overhead(x, z, y)) * (1 - wall(x, z)),
    overheadNear(minX, minZ, maxX, maxZ) {
      zoneGrid.query(minX, minZ, maxX, maxZ, hit);
      for (const id of hit) {
        const zn = zones[id];
        if (maxX >= zn.minX && minX <= zn.maxX && maxZ >= zn.minZ && minZ <= zn.maxZ) return true;
      }
      return false;
    },
  };
}

/**
 * Multiply the occlusion into a vertex colored builder's colors, vertex by vertex (its positions are
 * world space, y the surface's height). Run it before `build()`.
 */
export function bakeOcclusion(gb: GeoBuilder, occ: Occlusion): void {
  const p = gb.positions;
  const c = gb.colors;
  if (c.length !== p.length) throw new Error('bakeOcclusion needs a builder made with vertex colors');
  for (let i = 0; i < p.length; i += 3) {
    const k = 1 - occ.at(p[i], p[i + 2], p[i + 1]);
    if (k >= 0.9999) continue;
    c[i] *= k;
    c[i + 1] *= k;
    c[i + 2] *= k;
  }
}

/**
 * Make a standard material with `vertexColors` honour the baked occlusion past the diffuse term: the
 * environment's specular, and with `emissive` the emissive too (the road's sodium glow would otherwise
 * leak into a shadow). The vertex colour is 1 in open street, so only shaded vertices change.
 */
export function occlusionMaterial<T extends THREE.MeshStandardMaterial>(material: T, emissive = false): T {
  material.vertexColors = true;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      #ifdef USE_COLOR
        reflectedLight.indirectSpecular *= vColor.rgb;
      #endif`,
    );
    if (emissive) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_COLOR
          totalEmissiveRadiance *= vColor.rgb;
        #endif`,
      );
    }
  };
  material.customProgramCacheKey = () => (emissive ? 'bakedOcclusion:emissive' : 'bakedOcclusion');
  material.needsUpdate = true;
  return material;
}
