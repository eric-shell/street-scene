/**
 * Sparks off the cars and the cyan barriers, from the sim's contact telemetry
 * (render/car/sparks.ts does the drawing): a fan trailing a car that scrapes a
 * wall or rail, a spray from the corner that bottomed out, a burst on a hard
 * wall hit, a crack in a barrier panel that a hard rail hit leaves and the
 * odd spit from a cracked panel. Only cars and cracks near the camera spark.
 * Plain functions that take the session's parts as arguments, so RaceSession
 * keeps the state and this keeps the tuning. Render only.
 */
import type * as THREE from 'three';
import type { RaceState } from '../../sim/race';
import type { Sparks } from '../../render/car/sparks';
import type { NightScene } from '../../render/scene';

/**
 * A hit on a cyan barrier cracks its panel from this impact speed (m/s), full size at `full`;
 * the hit throws `burst` sparks off the panel (at strength 0 and 1), and a cracked panel near
 * the camera shorts out `spit` times a second (at strength 0 and 1), `spitCount` sparks each.
 */
const RAIL_CRACK = { min: 6, full: 20, burst: [14, 40], spit: [0.25, 1.1], spitCount: [3, 8] } as const;

/** Car sparks (render/car/sparks.ts): when, where and how many, from the sim's contact telemetry. */
const SPARK = {
  /** Only cars this close to the camera throw sparks (m). */
  range: 140,
  /**
   * Sparks leave the contact backward at this share of the car's speed and outward from the
   * wall. Real sparks shed forward with the car, but then the body hides them from every
   * camera; a fan trailing behind is what the eye expects from a grinding car.
   */
  carry: 0.45,
  outward: 2.4,
  /** Scraping: sliding speed (m/s) before it sparks, sparks per tick per m/s, cap per tick, height band above the road (m). */
  scrapeMin: 2,
  scrapePerMs: 0.22,
  scrapeMax: 6,
  scrapeHeight: [0.2, 0.6],
  /** Bottoming out: overtravel (m) and speed (m/s) before it sparks, sparks per m of overtravel at 25 m/s, cap per tick. */
  bottomMin: 0.004,
  bottomSpeed: 5,
  bottomPerM: 260,
  bottomMax: 14,
  /** A hard wall hit: sparks per m/s of impact on top of 8, cap. */
  burstPerMs: 2.2,
  burstMax: 46,
} as const;

/**
 * Sparks from this tick's car telemetry, for cars near the camera: a fan
 * trailing from the contact while a car scrapes a wall or rail, and a spray
 * out from under the corner that bottomed out (landings, crests, kickers).
 */
export function emitSparks(sparks: Sparks, race: RaceState, cam: THREE.Vector3, time: number): void {
  const w = race.world;
  for (const rc of race.cars) {
    const c = rc.state;
    if ((c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 > SPARK.range * SPARK.range) continue;
    if ((c.scrapeNx || c.scrapeNz) && c.scrape > SPARK.scrapeMin) {
      const g = w.heightAt(c.scrapeX, c.scrapeZ);
      const tx = -c.scrapeNz;
      const tz = c.scrapeNx;
      const back = -(c.vx * tx + c.vz * tz) * SPARK.carry;
      const n = Math.min(SPARK.scrapeMax, c.scrape * SPARK.scrapePerMs);
      const y = g + SPARK.scrapeHeight[0] + Math.random() * (SPARK.scrapeHeight[1] - SPARK.scrapeHeight[0]);
      sparks.emit(time, c.scrapeX + c.scrapeNx * 0.06, y, c.scrapeZ + c.scrapeNz * 0.06, tx * back + c.scrapeNx * SPARK.outward, 1.6, tz * back + c.scrapeNz * SPARK.outward, 2, n, g);
    }
    if (c.bottomOut > SPARK.bottomMin && c.speed > SPARK.bottomSpeed) {
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      let wu = 0;
      let wv = 0;
      if (c.bottomWheel >= 0) {
        // Just outboard of that wheel, so the spray clears the body.
        const wh = rc.tuning.geometry.wheels[c.bottomWheel];
        wv = wh[0] * 1.15;
        wu = wh[2] * 0.8;
      }
      const x = c.x + fx * wu + fz * wv;
      const z = c.z + fz * wu - fx * wv;
      const g = w.heightAt(x, z);
      const n = Math.min(SPARK.bottomMax, 3 + c.bottomOut * SPARK.bottomPerM * Math.min(1, c.speed / 25));
      const side = wv < 0 ? -1 : wv > 0 ? 1 : 0;
      sparks.emit(time, x, g + 0.04, z, -c.vx * SPARK.carry * 0.7 + fz * side * SPARK.outward, 1.5, -c.vz * SPARK.carry * 0.7 - fx * side * SPARK.outward, 2.2, n, g);
    }
  }
}

/** A hard hit on a wall or rail: one burst off the contact, bigger the harder the hit (impact m/s). */
export function sparkBurst(sparks: Sparks, race: RaceState, cam: THREE.Vector3, time: number, car: number, impact: number): void {
  const rc = race.cars[car];
  const c = rc?.state;
  if (!c || !(c.scrapeNx || c.scrapeNz)) return;
  if ((c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 > SPARK.range * SPARK.range) return;
  const g = race.world.heightAt(c.scrapeX, c.scrapeZ);
  const out = 1 + impact * 0.25;
  const n = Math.min(SPARK.burstMax, 8 + impact * SPARK.burstPerMs);
  sparks.emit(time, c.scrapeX + c.scrapeNx * 0.08, g + 0.45, c.scrapeZ + c.scrapeNz * 0.08, c.vx * 0.4 + c.scrapeNx * out, 2, c.vz * 0.4 + c.scrapeNz * out, 3.2, n, g);
}

/** A car slamming into a cyan barrier: the piece's panel cracks where it was hit, wider the harder the hit (m/s), and spits sparks. */
export function crackRail(sparks: Sparks, night: NightScene, race: RaceState, cam: THREE.Vector3, time: number, car: number, impact: number): void {
  if (impact < RAIL_CRACK.min) return;
  const c = race.cars[car]?.state;
  if (!c || !(c.scrapeNx || c.scrapeNz)) return;
  const k = Math.min(1, (impact - RAIL_CRACK.min) / (RAIL_CRACK.full - RAIL_CRACK.min));
  const crack = night.arrows.crackRail(race.rails, c.scrapeX, c.scrapeZ, k, time);
  if (!crack) return;
  if ((crack.x - cam.x) ** 2 + (crack.z - cam.z) ** 2 > SPARK.range * SPARK.range) return;
  const out = 1.5 + impact * 0.12;
  const n = RAIL_CRACK.burst[0] + (RAIL_CRACK.burst[1] - RAIL_CRACK.burst[0]) * k;
  sparks.emit(time, crack.x, crack.y, crack.z, crack.nx * out, 2.4, crack.nz * out, 2.6, n, race.world.heightAt(crack.x, crack.z));
}

/** Cracked barrier panels near the camera short out now and then: a few sparks off the crack (dt s, the render frame). */
export function spitRailSparks(sparks: Sparks, night: NightScene, race: RaceState, cam: THREE.Vector3, time: number, dt: number): void {
  const cracks = night.arrows.railCracks;
  if (!cracks.length || dt <= 0) return;
  for (const c of cracks) {
    if ((c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 > SPARK.range * SPARK.range) continue;
    const rate = RAIL_CRACK.spit[0] + (RAIL_CRACK.spit[1] - RAIL_CRACK.spit[0]) * c.strength;
    if (Math.random() >= rate * dt) continue;
    const n = RAIL_CRACK.spitCount[0] + Math.random() * (RAIL_CRACK.spitCount[1] - RAIL_CRACK.spitCount[0]) * (0.5 + c.strength * 0.5);
    sparks.emit(time, c.x, c.y, c.z, c.nx * 1.2, 0.6, c.nz * 1.2, 1.4, n, race.world.heightAt(c.x, c.z));
  }
}
