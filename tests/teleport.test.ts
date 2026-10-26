/**
 * Free roam's teleport (sim/race.ts teleportToStreet, asked for from the city
 * map): the player lands on a street near the target, standing, with its
 * nitrous kept, and the drive on from there is as deterministic as any other.
 * A race (not open world) ignores it.
 */
import { describe, expect, it } from 'vitest';
import { createRace, stepRace, teleportToStreet, type RaceConfig } from '../src/sim/race';
import { carSnapshot, input, raceConfig } from './helpers';

const roam = (seed: number): RaceConfig => ({ ...raceConfig(seed, 'circuit', 0), openWorld: true });

/** Teleport to the road node furthest from the start, then drive on: the car's state after. */
function teleportAndDrive(seed: number) {
  const r = createRace(roam(seed));
  for (let i = 0; i < 30; i++) stepRace(r, input({ throttle: 1 }));
  const rc = r.cars[0];
  const nitro = rc.state.nitro;
  const c0 = { x: rc.state.x, z: rc.state.z };
  let far = r.world.graph.nodes[0];
  for (const n of r.world.graph.nodes) if (n.edges.length && (n.x - c0.x) ** 2 + (n.z - c0.z) ** 2 > (far.x - c0.x) ** 2 + (far.z - c0.z) ** 2) far = n;
  expect(teleportToStreet(r, rc, far.x, far.z)).toBe(true);
  const landed = { d: Math.hypot(rc.state.x - far.x, rc.state.z - far.z), speed: Math.hypot(rc.state.vx, rc.state.vz), nitro: rc.state.nitro, surface: r.world.surfaceAt(rc.state.x, rc.state.z) };
  expect(landed.nitro).toBe(nitro);
  for (let i = 0; i < 120; i++) stepRace(r, input({ throttle: 1, steer: i > 60 ? 0.3 : 0 }));
  return { landed, snap: carSnapshot(r) };
}

describe('teleport', () => {
  for (const seed of [7, 20261026]) {
    it(`lands on the street by the target and drives on deterministically (seed ${seed})`, () => {
      const a = teleportAndDrive(seed);
      expect(a.landed.d).toBeLessThan(20);
      expect(a.landed.speed).toBe(0);
      expect(a.landed.surface).not.toBe('offroad');
      expect(teleportAndDrive(seed).snap).toBe(a.snap);
    });
  }

  it('does nothing in a race', () => {
    const r = createRace(raceConfig(7, 'circuit', 0));
    const n = r.world.graph.nodes.find((q) => q.edges.length)!;
    const before = carSnapshot(r);
    expect(teleportToStreet(r, r.cars[0], n.x, n.z)).toBe(false);
    expect(carSnapshot(r)).toBe(before);
  });
});
