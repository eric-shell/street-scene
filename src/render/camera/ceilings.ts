/**
 * What hangs over the streets, for the cameras: tunnel ceilings and the mass
 * above them (an air rights building, a ridge's rock), viaduct decks, a car
 * park garage's levels over its drivable floor and ramp, the bridge decks
 * over the channel (slab and girders over the floor), the Underground's
 * roof over its tunnel and gallery and its Bailey bridges, and the elevated
 * highway: its deck between the end loops, widened over the interchanges'
 * lanes (a camera under it stays under, one following a car up there stays
 * above), and its ramps and loops (an embankment: out over the top).
 * The chase camera rides 2-4 m over the car, but an orbit drag or a wall
 * pull-in (camera.ts wallLift) can lift it into a deck or a tunnel's roof,
 * and the intro fly-in can pass through one: keepOutOfWalls
 * calls clampCeiling, which moves a camera caught inside one of these solids
 * out through the nearer of its underside or its top.
 *
 * The shapes come from render/districts/structureShapes.ts, the same
 * functions their renderers draw with. Built once per world (cached), a few
 * boxes tested per frame: no allocation, cost negligible.
 */
import type * as THREE from 'three';
import type { World } from '../../city/world';
import { toLocal } from '../../city/districts/structures';
import { HIGHWAY_HALF, deckExtent, deckTopAt, deckUnderAt, highwayDeck } from '../../city/districts/highway/shape';
import { axisPoint, projectAxis, rampHeight } from '../../city/districts/highway/rampAxis';
import { RAIL } from '../../city/railCurve';
import { CITY } from '../../city/config';
import { boreRoad, bridgeTop, ceilingAbove, coverOf, deckLine, ridgeShape, rockAt, tunnelShape, viaductShape } from '../districts/structureShapes';
import { carParkGeo } from '../../city/districts/carPark';
import { garageSpan } from '../districts/carPark';
import { bridgesOf, distToBridge, channelL } from '../../city/districts/channel';
import { deckUndersideAt } from '../districts/channel';
import { pointInPolygon } from '../../city/districts/geom';
import { bridgeDeck, rectWorld, toWorld as ugWorld, undergroundSite } from '../../city/districts/undergroundShape';

/** Room kept between the camera and a ceiling or a deck (m): the near plane and a little air. */
export const CEILING_MARGIN = 0.45;

/** One overhead solid: a bounding box in XZ and its underside and top at a point (NaN outside it). */
interface Overhead {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Writes the underside and top (m) at (x, z) into span; returns false outside the solid's footprint. */
  at(x: number, z: number, span: { bottom: number; top: number }): boolean;
  /** A tunnel bore: what exposureOverhead reports as 'tunnel' rather than 'covered'. */
  tunnel?: true;
  /** Zone only (the El's deck): exposureOverhead reads it, clampCeiling skips it (its underside is not modelled). */
  zoneOnly?: true;
}

/** What is over a point, for the exposure adaptation (render/exposure.ts). */
export type Overhang = 'open' | 'covered' | 'tunnel';

const cache = new WeakMap<World, Overhead[]>();
const span = { bottom: 0, top: 0 };

function bbox(pts: { x: number; z: number }[], pad: number): Pick<Overhead, 'minX' | 'minZ' | 'maxX' | 'maxZ'> {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

function build(world: World): Overhead[] {
  const out: Overhead[] = [];
  const T = CITY.districts.tunnel;
  for (const a of world.areas) {
    if (a.kind === 'tunnel') {
      const t = tunnelShape(a);
      const ridge = a.variant === 'ridge';
      const cover = coverOf(t, ridge);
      const r = ridge ? ridgeShape(a) : null;
      const roof = ridge ? 0 : bridgeTop(a);
      const corners = [-1, 1].flatMap((su) => [-1, 1].map((sv) => ({ x: t.cx + t.ux * su * cover - t.uz * sv * t.front, z: t.cz + t.uz * su * cover + t.ux * sv * t.front })));
      out.push({
        ...bbox(corners, 1),
        tunnel: true,
        at(x, z, s) {
          const l = toLocal(t, x, z);
          if (Math.abs(l.u) > cover || Math.abs(l.v) > t.front) return false;
          const road = boreRoad(world, t, l.u);
          s.bottom = road + ceilingAbove(t, ridge, l.v);
          s.top = r ? Math.max(rockAt(world, r, x, z), road + T.clearance + T.slab) : road + roof;
          return true;
        },
      });
    } else if (a.kind === 'overpass' && a.variant === 'viaduct') {
      const v = viaductShape(a);
      const line = deckLine(world, v);
      out.push({
        ...bbox(a.polygon, 1),
        at(x, z, s) {
          const dx = x - v.x0;
          const dz = z - v.z0;
          const along = dx * v.ux + dz * v.uz;
          const lat = -dx * v.uz + dz * v.ux;
          if (along < 0 || along > v.length || Math.abs(lat) > v.half + 0.3) return false;
          s.bottom = line.a + line.b * along;
          s.top = s.bottom + v.depth + 1.1;
          return true;
        },
      });
    } else if (a.kind === 'subway' && a.variant === 'elevated') {
      // The El's deck outline: the street under it is covered (exposure only; the cameras clear it by height).
      const poly = a.polygon;
      out.push({
        ...bbox(poly, 1),
        zoneOnly: true,
        at(x, z, s) {
          if (!pointInPolygon(x, z, poly)) return false;
          s.bottom = Infinity;
          s.top = Infinity;
          return true;
        },
      });
    } else if (a.kind === 'carPark') {
      // The garage's levels over its drivable floor and the covered ramp's roof (render/districts/carPark.ts).
      const g = carParkGeo(a);
      out.push({ ...bbox([...g.deck, ...g.ramp], 1), at: (x, z, s) => garageSpan(g, world.heightAt, x, z, s) });
    } else if (a.kind === 'underground' && a.params.planned && a.params.roof) {
      // The Underground's roof over the tunnel and the gallery (a bore, for the exposure), and its two bridges: each deck's
      // underside its slab below the deck's height (World.heightAt with a body high above picks the deck).
      const site = undergroundSite(a);
      const slabOver = (polygon: { x: number; z: number }[], slab: number, tunnel: boolean) =>
        out.push({
          ...bbox(polygon, 1),
          ...(tunnel ? { tunnel: true as const } : {}),
          at(x, z, s) {
            if (!pointInPolygon(x, z, polygon)) return false;
            const deck = world.heightAt(x, z, 1e4);
            s.bottom = deck - slab;
            s.top = deck + 0.3;
            return true;
          },
        });
      for (const d of site.decks) slabOver(rectWorld(site, d), CITY.districts.underground.roof.slab, true);
      for (const br of site.bridges) slabOver(bridgeDeck(br).map((p) => ugWorld(site, p.s, p.w)), 0.75, false);
    } else if (a.kind === 'channel') {
      // Each bridge deck over the channel: the footprint of its slab (the deck's half width, the band
      // plus the parapets' reach across it); the deck is the terrain's height there (World.heightAt
      // without a body height), the floor beneath is the lower level. The structure hangs deeper
      // over the pier bents (their cap beams), so the depth is asked per point.
      const reach = a.params.top + 3;
      for (const br of bridgesOf(world.graph, a)) {
        const half = br.dk + 1;
        out.push({
          ...bbox(br.pts, half + 1),
          at(x, z, s) {
            if (distToBridge(br, x, z) > half || Math.abs(channelL(a.params, x, z)) > reach) return false;
            const deck = world.heightAt(x, z);
            // Only a real two level spot: over the banks beyond the floor the deck is the ground itself.
            if (deck - world.heightAt(x, z, -Infinity) < 1) return false;
            s.bottom = deck - deckUndersideAt(a.params, x, z);
            s.top = deck + 1.1;
            return true;
          },
        });
      }
    } else if (a.kind === 'highway' && a.variant === 'deck') {
      const d = highwayDeck(a, world.areas);
      if (!d.settled) continue;
      const c = d.curve;
      // In stretches of a few samples over the drivable stretch (sW to sE: nothing runs on past the loops):
      // the nearest sample's normal says how far across the deck a point is, out to its widening over a lane.
      const CH = 10;
      const reach = HIGHWAY_HALF + 1.5 + Math.max(0, ...d.ramps.filter((r) => !r.loop).map((r) => 2 * r.half));
      const kA = Math.max(1, Math.floor(d.sW / RAIL.step));
      const kB = Math.min(c.n - 1, Math.ceil(d.sE / RAIL.step));
      for (let k0 = kA; k0 < kB; k0 += CH) {
        const k1 = Math.min(kB, k0 + CH);
        const pts: { x: number; z: number }[] = [];
        for (let k = k0; k <= k1; k++) pts.push({ x: c.x[k], z: c.z[k] });
        out.push({
          ...bbox(pts, reach),
          at(x, z, s) {
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
            // Right of travel toward +s (shape.ts deckPoint's sign).
            const lat = -(x - c.x[best]) * c.tz[best] + (z - c.z[best]) * c.tx[best];
            if (Math.abs(along) > RAIL.step) return false;
            const sv = best * RAIL.step + along;
            if (sv < d.sW || sv > d.sE || Math.abs(lat) > deckExtent(d, sv, lat >= 0 ? 1 : -1) + 0.3) return false;
            s.bottom = deckUnderAt(d, sv);
            s.top = deckTopAt(d, sv) + 1.1;
            return true;
          },
        });
      }
      // Its ramps and end loops: an embankment up to the bridge stretch at the top (out over the top), then
      // a bridge. A loop's box holds its turn's center, so its whole circle is in it; a slip ramp's holds
      // its polyline axis (it has no turn: its center reads 0).
      for (const r of d.ramps) {
        const ax = r.axis;
        const ap = axisPoint();
        const sample = { h: 0, gx: 0, gz: 0 };
        const hw = r.half + 0.5;
        const poly = ax.poly;
        const pts: { x: number; z: number }[] = poly ? poly.x.map((x, i) => ({ x, z: poly.z[i] })) : [{ x: ax.fx, z: ax.fz }, { x: ax.ex, z: ax.ez }, { x: ax.cx, z: ax.cz }];
        out.push({
          ...bbox(pts, ax.r + hw + 2),
          at(x, z, s) {
            projectAxis(ax, x, z, ap);
            if (ap.u < 0 || ap.u > ax.length || Math.abs(ap.v) > hw) return false;
            rampHeight(ax, r.profile, r.terrain, x, z, ap, sample);
            s.bottom = ap.u >= r.uSolid ? sample.h - 1.4 : -Infinity;
            s.top = sample.h + 1.1;
            return true;
          },
        });
      }
    }
  }
  return out;
}

function overheadsOf(world: World): Overhead[] {
  let list = cache.get(world);
  if (!list) cache.set(world, (list = build(world)));
  return list;
}

/**
 * What is over the point (x, y, z): a tunnel bore, another cover (viaduct, highway deck, bridge, garage
 * level, the El) or open sky. Bounding boxes first, so a typical frame runs a handful of box tests and,
 * only inside one, the solid's own test. No allocation.
 */
export function overheadAt(world: World, x: number, y: number, z: number): Overhang {
  let zone: Overhang = 'open';
  for (const o of overheadsOf(world)) {
    if (x < o.minX || x > o.maxX || z < o.minZ || z > o.maxZ) continue;
    if (!o.at(x, z, span) || y >= span.bottom) continue;
    if (o.tunnel) return 'tunnel';
    zone = 'covered';
  }
  return zone;
}

/**
 * Move `pos` out of any overhead solid it is inside (with CEILING_MARGIN of
 * air): down under it when that is the nearer way out, else up over it.
 */
export function clampCeiling(world: World, pos: THREE.Vector3, margin = CEILING_MARGIN): void {
  for (const o of overheadsOf(world)) {
    if (o.zoneOnly) continue;
    if (pos.x < o.minX || pos.x > o.maxX || pos.z < o.minZ || pos.z > o.maxZ) continue;
    if (!o.at(pos.x, pos.z, span)) continue;
    const lo = span.bottom - margin;
    const hi = span.top + margin;
    if (pos.y <= lo || pos.y >= hi) continue;
    pos.y = pos.y - lo < hi - pos.y ? lo : hi;
  }
}
