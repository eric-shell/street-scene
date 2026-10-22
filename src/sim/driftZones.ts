/**
 * Drift zones: the monument plaza and the bigger parking lots, open paving
 * where a slide has room. Drifting inside one pays a bonus: drift points count
 * DRIFT_ZONES.scoreMul times (drift mode, RaceState.drift) and the nitrous a
 * drift refills comes refillMul times as fast (every mode and every car, AI
 * included, so it is a rule of the city rather than a player perk).
 *
 * The bonus is bounded per visit so a zone is a detour worth taking, not a
 * place to farm: a visit pays for at most `bonusTime` s of drifting and
 * `refillCap` of a nitrous stage, and once a visit that drifted ends the zone rests
 * `cooldown` s before it pays that car again (driving through without a
 * slide, or a cold visit to a resting zone, never starts or extends the
 * rest). A visit survives `exitGrace` s outside, so a slide over the edge or
 * a bounce off the lot clutter does not end it; nothing is paid while out.
 *
 * Zones come from the city's district areas (pure, cached per area list, so
 * the World stays untouched); the per car visit state lives on
 * RaceState.driftZones and is stepped once per tick after the regular
 * nitrous refill. Cost: a bounding box test per zone per car, and one point
 * in polygon test for the box that hits. The renderer
 * (render/districts/driftZones.ts) and the HUD read the same list and state.
 */
import type { World } from '../city/world';
import type { Area } from '../city/districts/types';
import { pointInPolygon, polygonBounds } from '../city/districts/geom';
import type { Vec2 } from './math';
import { driftRefillRate } from './car';
import { DT, TICK_HZ } from './constants';
import { DRIFT_ZONES, NITRO_STAGES } from './tuning';
import type { RaceState } from './race';

export type DriftZoneKind = 'plaza' | 'lot';

export interface DriftZone {
  /** Index in the zone list (driftZones()). */
  index: number;
  /** The district area it lies on (World.areas id). */
  area: number;
  kind: DriftZoneKind;
  /** Outline (the area's polygon, XZ m). */
  polygon: Vec2[];
  /** Bounding box of the outline (m). */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** One car's current zone visit. */
export interface DriftZoneVisit {
  /** Zone being visited (DriftZone.index), -1 for none. */
  zone: number;
  /** Seconds since the car was last inside that zone (0 while inside). */
  outside: number;
  /** Bonus drifting left this visit (s). */
  timeLeft: number;
  /** Bonus nitrous left this visit (stages). */
  refillLeft: number;
  /** The visit started with the zone rested (it has a bonus to pay); ending it after drifting starts the cooldown. */
  fresh: boolean;
  /** Drift points multiplier this tick: scoreMul while drifting inside with bonus left, else 1. */
  scoreMul: number;
}

export interface DriftZoneState {
  /** One visit per car, by car index. */
  cars: DriftZoneVisit[];
  /** First tick zone z pays car i again, at [i * zoneCount + z]. */
  readyTick: number[];
}

/** What kind of zone an area is, or null: the monument plaza, and lots big enough to hold a slide. */
export function driftZoneKind(a: Area): DriftZoneKind | null {
  if (a.kind === 'monument') return 'plaza';
  if (a.kind !== 'infill' || a.variant !== 'lot') return null;
  const depth = a.params.depth ?? 0;
  const length = a.params.length ?? 0;
  const Z = DRIFT_ZONES;
  return depth >= Z.minLotDepth && length >= Z.minLotLength && depth * length >= Z.minLotArea ? 'lot' : null;
}

const cache = new WeakMap<Area[], DriftZone[]>();
const NONE: DriftZone[] = [];

/** Every drift zone of a world's city, in area order (cached per city; worlds without districts have none). */
export function driftZones(world: Pick<World, 'areas'>): DriftZone[] {
  const areas = world.areas;
  if (!areas) return NONE;
  let zones = cache.get(areas);
  if (zones) return zones;
  zones = [];
  for (const a of areas) {
    const kind = driftZoneKind(a);
    if (!kind || a.polygon.length < 3) continue;
    const bb = polygonBounds(a.polygon);
    zones.push({ index: zones.length, area: a.id, kind, polygon: a.polygon, ...bb });
  }
  cache.set(areas, zones);
  return zones;
}

/** Zone index at a point, -1 outside every zone. */
export function driftZoneAt(zones: DriftZone[], x: number, z: number): number {
  for (const zn of zones) {
    if (x < zn.minX || x > zn.maxX || z < zn.minZ || z > zn.maxZ) continue;
    if (pointInPolygon(x, z, zn.polygon)) return zn.index;
  }
  return -1;
}

export function createDriftZoneState(world: Pick<World, 'areas'>, carCount: number): DriftZoneState {
  const n = driftZones(world).length;
  return {
    cars: Array.from({ length: carCount }, () => ({ zone: -1, outside: 0, timeLeft: 0, refillLeft: 0, fresh: false, scoreMul: 1 })),
    readyTick: new Array<number>(carCount * n).fill(0),
  };
}

/**
 * One tick for every car, after the regular nitrous refill: track zone
 * visits, pay the extra drift refill and set each car's score multiplier for
 * updateDrift. Fixed car and zone order, so it is deterministic.
 */
export function stepDriftZones(r: RaceState): void {
  const zones = driftZones(r.world);
  if (!zones.length) return;
  const st = r.driftZones;
  const n = zones.length;
  const Z = DRIFT_ZONES;
  const rest = Math.round(Z.cooldown * TICK_HZ);
  for (let i = 0; i < r.cars.length; i++) {
    const rc = r.cars[i];
    const c = rc.state;
    const v = st.cars[i];
    v.scoreMul = 1;
    const at = driftZoneAt(zones, c.x, c.z);
    if (v.zone >= 0 && at !== v.zone) {
      // Out of the visited zone (or into another): the visit ends after the grace, or at once for a new zone.
      v.outside += DT;
      if (at >= 0 || v.outside >= Z.exitGrace) {
        // Only a visit that paid out rests the zone: driving through without drifting costs nothing.
        if (v.fresh && v.timeLeft < Z.bonusTime) st.readyTick[i * n + v.zone] = r.tick + rest;
        v.zone = -1;
      }
    }
    if (at >= 0 && at === v.zone) v.outside = 0;
    else if (at >= 0) {
      const fresh = r.tick >= st.readyTick[i * n + at];
      v.zone = at;
      v.outside = 0;
      v.fresh = fresh;
      v.timeLeft = fresh ? Z.bonusTime : 0;
      v.refillLeft = fresh ? Z.refillCap : 0;
    }
    if (v.zone < 0 || v.outside > 0 || v.timeLeft <= 0 || !c.drifting) continue;
    v.scoreMul = Z.scoreMul;
    v.timeLeft = Math.max(0, v.timeLeft - DT);
    // The regular refill already ran this tick; the zone adds (refillMul - 1) of it, up to the visit's cap.
    const extra = Math.min(driftRefillRate(c, rc.tuning) * (Z.refillMul - 1) * DT, v.refillLeft, NITRO_STAGES - c.nitro);
    if (extra > 0) {
      c.nitro += extra;
      c.nitroGain.zone = extra;
      v.refillLeft -= extra;
    }
  }
}

/** What the HUD shows for one car: the zone it is in and how much of the visit's bonus is left (0..1), or null outside. */
export function driftZoneStatus(r: RaceState, car: number): { kind: DriftZoneKind; left: number; resting: boolean } | null {
  const v = r.driftZones?.cars[car];
  if (!v || v.zone < 0 || v.outside > 0) return null;
  const zone = driftZones(r.world)[v.zone];
  if (!zone) return null;
  return { kind: zone.kind, left: DRIFT_ZONES.bonusTime > 0 ? v.timeLeft / DRIFT_ZONES.bonusTime : 0, resting: !v.fresh };
}
