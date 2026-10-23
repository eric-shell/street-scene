import { describe, expect, it } from 'vitest';
import { createRace, RaceState, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { cos, sin, yawOf } from '../src/sim/math';
import { Prop, PropKind } from '../src/city/props';
import { routeSample } from '../src/city/route';
import { carSnapshot, input, raceConfig, replayLog, runAutopilot } from './helpers';

/** A prop of `kind` with a clear run up of `run` meters along the sidewalk (parallel to the curb), or null. */
function findTarget(r: RaceState, kind: PropKind, run: number): { prop: Prop; dx: number; dz: number } | null {
  const w = r.world;
  for (const p of w.props) {
    if (p.kind !== kind || w.surfaceAt(p.x, p.z) === 'road') continue;
    // Along the curb: perpendicular to the facing (local +Z toward the road).
    const dx = cos(p.yaw);
    const dz = -sin(p.yaw);
    const clear = w.props.every((q) => {
      if (q === p) return true;
      const ox = q.x - p.x;
      const oz = q.z - p.z;
      const along = -(ox * dx + oz * dz);
      const side = Math.abs(ox * dz - oz * dx);
      return along < -1 || along > run + 3 || side > q.radius + 1.6;
    });
    if (!clear) continue;
    // Run up and run out stay on the sidewalk, away from walls.
    let ok = true;
    // and next to the route (the race resets cars that stray far from it). True distance to the
    // projected point, as the race measures it: a point out on a segment's extension has a small
    // lateral offset but can be hundreds of meters from the route.
    for (let s = -run; s <= 4 && ok; s += 1) {
      const x = p.x + dx * s;
      const z = p.z + dz * s;
      // (The true distance to the projected route point: lateral alone misses points beyond a segment's end.)
      const rp = w.routeProgress(x, z);
      const q = routeSample(w.route, rp.s);
      ok = w.wallClearance(x, z, 2) >= 1.2 && w.surfaceAt(x, z) !== 'road' && Math.hypot(x - q.x, z - q.z) < w.route.segWidth[rp.seg] / 2 + 6;
    }
    if (ok) return { prop: p, dx, dz };
  }
  return null;
}

/** Seeds tried in turn for a race with a clear target of the wanted kind. */
const RAM_SEEDS = [20261019, 20261020, 20261021, 20261022, 20261023];

/** Launch the player at `speed` toward the prop and report its speed just before and after the hit. */
function ram(kind: PropKind, speed: number) {
  let r = createRace(raceConfig(RAM_SEEDS[0], 'circuit', 0));
  let target = findTarget(r, kind, 9);
  for (let i = 1; i < RAM_SEEDS.length && !target; i++) {
    r = createRace(raceConfig(RAM_SEEDS[i], 'circuit', 0));
    target = findTarget(r, kind, 9);
  }
  if (!target) throw new Error(`no clear ${kind}`);
  r.tick = r.countdownTicks;
  r.phase = 'racing';
  const { prop, dx, dz } = target;
  const rc = r.cars[0];
  const c = rc.state;
  placeCar(c, prop.x - dx * 8, prop.z - dz * 8, yawOf(dx, dz), r.world);
  // Anywhere on the map: forget the grid's route position so the lost check measures from here.
  rc.seg = -1;
  c.vx = dx * speed;
  c.vz = dz * speed;
  for (const wh of c.wheels) wh.spinRate = speed / rc.tuning.geometry.wheelRadius;
  let before = 0;
  let after = 0;
  let hitTick = -1;
  let impact = 0;
  let wreckGain = 0;
  for (let i = 0; i < 90; i++) {
    const v = Math.hypot(c.vx, c.vz);
    const n = r.events.length;
    stepRace(r, input({}));
    if (hitTick < 0 && r.events.slice(n).some((e) => e.type === 'prop' && e.value === prop.id)) {
      hitTick = r.tick;
      before = v;
      impact = c.impact;
      wreckGain = c.nitroGain.wreck;
    } else if (hitTick >= 0 && r.tick === hitTick + 2) {
      after = Math.hypot(c.vx, c.vz);
      break;
    }
  }
  return { r, prop, before, after, impact, hitTick, wreckGain };
}

describe('destructible props', () => {
  it('a light pole is a big hit, a garbage can a small bump', () => {
    const pole = ram('streetlight', 20);
    expect(pole.hitTick).toBeGreaterThan(0);
    expect(pole.r.brokenProps[pole.prop.id]).toBe(1);
    expect(pole.r.events.filter((e) => e.type === 'prop' && e.value === pole.prop.id)).toHaveLength(1);
    const poleLoss = 1 - pole.after / pole.before;
    expect(poleLoss).toBeGreaterThan(0.25);
    expect(pole.impact).toBeGreaterThan(4);

    const can = ram('garbageCan', 20);
    expect(can.hitTick).toBeGreaterThan(0);
    const canLoss = 1 - can.after / can.before;
    expect(canLoss).toBeLessThan(0.08);
    expect(canLoss).toBeLessThan(poleLoss / 3);

    const bus = ram('busStop', 20);
    expect(1 - bus.after / bus.before).toBeGreaterThan(poleLoss);
  });

  it('a hydrant is a solid knock between a can and a pole', () => {
    const can = ram('garbageCan', 20);
    const pole = ram('streetlight', 20);
    const hydrant = ram('hydrant', 20);
    expect(hydrant.r.brokenProps[hydrant.prop.id]).toBe(1);
    const loss = (x: { before: number; after: number }) => 1 - x.after / x.before;
    expect(loss(hydrant)).toBeGreaterThan(loss(can) * 1.5);
    expect(loss(hydrant)).toBeLessThan(loss(pole));
  });

  it('a wreck pays nitrous by its weight, a pole the whole bonus and a can a fraction', () => {
    const pole = ram('streetlight', 20);
    const t = pole.r.cars[0].tuning.nitrous;
    expect(pole.wreckGain).toBeCloseTo(t.wreckBonus, 6);
    const can = ram('garbageCan', 20);
    expect(can.wreckGain).toBeGreaterThan(0);
    expect(can.wreckGain).toBeLessThan(t.wreckBonus / 2);
    // Telemetry lasts one tick.
    expect(pole.r.cars[0].state.nitroGain.wreck).toBe(0);
  });

  it('broken props stay down and are tracked per race', () => {
    const { r, prop } = ram('streetlight', 15);
    const fresh = createRace(raceConfig(20261019, 'circuit', 0), r.world);
    expect(fresh.brokenProps.length).toBe(r.world.props.length);
    expect(fresh.brokenProps[prop.id]).toBe(0);
    // Driving back through the spot does not hit it again.
    const c = r.cars[0].state;
    const n = r.events.length;
    placeCar(c, prop.x - cos(prop.yaw) * 4, prop.z + sin(prop.yaw) * 4, yawOf(cos(prop.yaw), -sin(prop.yaw)), r.world);
    c.vx = cos(prop.yaw) * 10;
    c.vz = -sin(prop.yaw) * 10;
    for (let i = 0; i < 40; i++) stepRace(r, input({}));
    expect(r.events.slice(n).some((e) => e.type === 'prop' && e.value === prop.id)).toBe(false);
  });

  it('prop hits replay identically, AI included', () => {
    const cfg = raceConfig(4242, 'sprint', 3);
    const original = runAutopilot(cfg, 200, true);
    const replay = replayLog(cfg, original.inputLog);
    expect(Array.from(replay.brokenProps)).toEqual(Array.from(original.brokenProps));
    const hits = (s: RaceState) => s.events.filter((e) => e.type === 'prop').map((e) => `${e.tick}:${e.car}:${e.value}`);
    expect(hits(replay)).toEqual(hits(original));
    expect(carSnapshot(replay)).toBe(carSnapshot(original));
  });
});
