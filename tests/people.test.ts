import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import type { World } from '../src/city/world';
import { BACK, FWD } from '../src/city/people/placer';
import { peopleOf, personAt } from '../src/city/people/people';
import type { WorldPerson } from '../src/city/people/people';
import { WALK, walkerAt } from '../src/city/people/walkPaths';
import { routeSample } from '../src/city/route';
import { createRace, stepRace } from '../src/sim/race';
import type { RaceState } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { PEOPLE, sidestep } from '../src/sim/people';
import type { DodgeCar } from '../src/sim/people';
import { yawOf } from '../src/sim/math';
import { carSnapshot, input, raceConfig, replayLog, runAutopilot } from './helpers';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 20261019];

describe('the people plan', () => {
  it('is deterministic, off the route, in range of its gate, and carries a unit back vector', () => {
    let gateStands = 0;
    let walkers = 0;
    // Plain comparisons collected into one list: an expect per person (ten thousand walkers a seed) is what makes a sweep slow.
    const bad: string[] = [];
    SEEDS.forEach((seed, i) => {
      const kind = i % 2 ? 'sprint' : 'circuit';
      const w = createWorld(seed, kind);
      const plan = peopleOf(w);
      // A fresh world gives a fresh plan: the same bits (three seeds: building a city twice is the expensive part).
      if (i < 3) expect(JSON.stringify(peopleOf(createWorld(seed, kind)).people)).toBe(JSON.stringify(plan.people));
      expect(peopleOf(w)).toBe(plan);
      const route = w.route;
      const L = route.length;
      for (const p of plan.people) {
        if (p.scale < 0.9 || p.scale > 1.1) bad.push(`${seed} #${p.id} scale ${p.scale}`);
        if (p.groupPhase < 0 || p.groupPhase > 1) bad.push(`${seed} #${p.id} groupPhase ${p.groupPhase}`);
        if (p.backRoom < 0) bad.push(`${seed} #${p.id} backRoom ${p.backRoom}`);
        if (Math.abs(Math.hypot(p.backX, p.backZ) - 1) > 1e-5) bad.push(`${seed} #${p.id} back not unit`);
        if (p.kind === 'walk') {
          walkers++;
          continue;
        }
        const rp = w.routeProgress(p.x, p.z);
        const half = route.segWidth[rp.seg] / 2;
        if (p.kind === 'gate') {
          gateStands++;
          if (Math.abs(rp.lateral) < half) bad.push(`${seed} gate stand #${p.id} on the road`);
          const g = plan.gates[p.gate!.gate];
          if (!g) bad.push(`${seed} gate stand #${p.id} has no gate`);
          const d = rp.s - g.s;
          const ds = route.closed ? ((((d + L / 2) % L) + L) % L) - L / 2 : d;
          // Sprint ends continue the route past its ends: the stand's own ds is what the planner stored.
          if (p.gate!.ds < -BACK || p.gate!.ds > FWD) bad.push(`${seed} gate stand #${p.id} ds ${p.gate!.ds}`);
          if (route.closed && Math.abs(ds - p.gate!.ds) >= 1e-6) bad.push(`${seed} gate stand #${p.id} ds ${p.gate!.ds} vs ${ds}`);
        } else if (Math.abs(rp.lateral) < half + 1) bad.push(`${seed} idler #${p.id} in the route corridor`);
      }
    });
    expect(bad).toEqual([]);
    expect(gateStands).toBeGreaterThan(0);
    expect(walkers).toBeGreaterThan(0);
  });

  it('keeps every walker path off the race line and its alleys', () => {
    const bad: string[] = [];
    // Every point of every path, and a point every 2 m between them (three seeds: ten thousand walkers each).
    for (const [seed, kind] of [[1, 'circuit'], [2, 'sprint'], [20261019, 'circuit']] as const) {
      const w = createWorld(seed, kind);
      const route = w.route;
      const L = route.length;
      const alleys = route.shortcuts.map((sc) => {
        const edge = w.graph.edges[sc.edges[0]];
        return { pts: sc.points, clear: edge.width / 2 + edge.sidewalk };
      });
      for (const p of peopleOf(w).people) {
        if (!p.walk) continue;
        const q = p.walk.pts;
        for (let k = 0; k + 3 < q.length; k += 4) {
          const last = k + 7 >= q.length;
          const n = last ? 1 : Math.max(1, Math.ceil(Math.hypot(q[k + 4] - q[k], q[k + 6] - q[k + 2]) / 2));
          for (let m = 0; m < n; m++) {
            const f = last ? 0 : m / n;
            const x = last ? q[k] : q[k] + (q[k + 4] - q[k]) * f;
            const z = last ? q[k + 2] : q[k + 2] + (q[k + 6] - q[k + 2]) * f;
            const wp = w.routeProgress(x, z);
            const beyondEnds = !route.closed && (wp.s < 0.5 || wp.s > L - 0.5);
            // True distance to the projected route point (`lateral` alone is only the offset across the segment's line).
            const rs = routeSample(route, wp.s);
            if (!beyondEnds && Math.hypot(x - rs.x, z - rs.z) < route.segWidth[wp.seg] / 2 + 0.5) bad.push(`${seed} walker #${p.id} on the route at (${x.toFixed(1)}, ${z.toFixed(1)})`);
            for (const a of alleys) {
              for (let j = 0; j + 1 < a.pts.length; j++) {
                if (segDist(x, z, a.pts[j].x, a.pts[j].z, a.pts[j + 1].x, a.pts[j + 1].z) < a.clear) bad.push(`${seed} walker #${p.id} in a shortcut at (${x.toFixed(1)}, ${z.toFixed(1)})`);
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('has no gate stands in an open world and ids in plan order', () => {
    const w = createWorld(3, 'circuit');
    w.openWorld = true;
    const plan = peopleOf(w);
    expect(plan.gates).toHaveLength(0);
    expect(plan.people.some((p) => p.kind === 'gate')).toBe(false);
    plan.people.forEach((p, i) => expect(p.id).toBe(i));
  });

  it('walkerAt matches a hand-computed straight path', () => {
    // A 10 m path along +x at 2 m/s: leg 5 s, a pause of 0.8 + 2.2 * fract(style * 7.31) s. Style 0 -> 0.8 s, lane 0.2 m.
    const walk = { pts: [100, 0, 50, 0, 110, 0, 50, 10], length: 10, speed: 2, phase: 0, style: 0 };
    const out = { x: 0, z: 0, yaw: 0 };
    // t = 2 s into the first leg: 4 m along, heading +x (yaw pi/2), keeping 0.2 m to its right (+z for a walker facing +x).
    walkerAt(walk, 2, out);
    expect(out.x).toBeCloseTo(104, 5);
    expect(out.z).toBeCloseTo(50 + 0.2, 5);
    expect(out.yaw).toBeCloseTo(Math.PI / 2, 4);
    // The return leg: cycle = 2 * (5 + 0.8) = 11.6; leg back starts at 5.8 s; at 7.8 s the walker is 4 m from the end, turned round.
    walkerAt(walk, 7.8, out);
    expect(out.x).toBeCloseTo(106, 5);
    expect(out.z).toBeCloseTo(50 - 0.2, 5);
    expect(Math.abs(Math.cos(out.yaw - (Math.PI / 2 + 3.14159)))).toBeGreaterThan(0.999);
    // The phase shifts the clock: phase 0.5 at t = 0 is 5.8 s in: the start of the return leg, at the far end.
    walkerAt({ ...walk, phase: 0.5 }, 0, out);
    expect(out.x).toBeCloseTo(110, 4);
  });

  it('walkers stay on their path in time and keep inside the sidewalk', () => {
    const w = createWorld(20261019, 'circuit');
    const out = { x: 0, z: 0, yaw: 0 };
    const walkers = peopleOf(w).people.filter((p) => p.kind === 'walk').slice(0, 200);
    expect(walkers.length).toBeGreaterThan(0);
    for (const p of walkers) {
      for (const t of [0, 7.3, 31.9]) {
        personAt(p, t, out);
        expect(Number.isFinite(out.x) && Number.isFinite(out.z) && Number.isFinite(out.yaw)).toBe(true);
        // Never further than the path's own extent plus the lane from its points.
        const q = p.walk!.pts;
        let best = Infinity;
        for (let i = 0; i + 7 < q.length; i += 4) best = Math.min(best, segDist(out.x, out.z, q[i], q[i + 2], q[i + 4], q[i + 6]));
        expect(best).toBeLessThan(0.45);
      }
    }
    expect(WALK.keepRightMax).toBeCloseTo(0.32, 6);
  });
});

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// ---------------------------------------------------------------------------
// The sim
// ---------------------------------------------------------------------------

const RAM_SEEDS = [20261019, 20261020, 20261021, 20261022, 20261023, 20261024];
const RUN = 15;
/** A speed at which the dodge cannot clear the car's lane: at 25 m/s a person dead in line manages 1.17 m, just short of the half width plus their radius, and the contact grazes; at 32 m/s they manage 0.9 m. */
const FAST = 32;

interface Target {
  r: RaceState;
  person: WorldPerson;
  /** Unit direction of the approach (toward the wall behind the person, i.e. across the sidewalk). */
  dx: number;
  dz: number;
}

/** A front row gate stand a car can reach across the road with a clear run up: nobody else in the lane before it, no walls on the way, near the route. */
function findTarget(seed: number, withPeople: boolean): Target | null {
  const cfg = { ...raceConfig(seed, 'circuit', 0), people: withPeople };
  const r = createRace(cfg);
  const w: World = r.world;
  const plan = peopleOf(w);
  for (const p of plan.people) {
    if (p.kind !== 'gate' || p.gate!.row !== 0) continue;
    const dx = p.backX;
    const dz = p.backZ;
    // Facing the road: the car comes from the road side.
    let ok = true;
    // (The person stands a step off the wall behind them: the run ends there.)
    for (let s = RUN; s >= 1 && ok; s -= 1) {
      const x = p.x - dx * s;
      const z = p.z - dz * s;
      const rp = w.routeProgress(x, z);
      const q = routeSample(w.route, rp.s);
      ok = w.wallClearance(x, z, 2) >= 1.2 && Math.hypot(x - q.x, z - q.z) < w.route.segWidth[rp.seg] / 2 + 6;
    }
    if (!ok || w.surfaceAt(p.x - dx * RUN, p.z - dz * RUN) !== 'road') continue;
    // No one else in the car's lane before the target.
    const inLane = plan.people.some((o) => {
      if (o === p) return false;
      const ox = o.x - p.x;
      const oz = o.z - p.z;
      const ahead = -(ox * dx + oz * dz);
      const side = Math.abs(ox * dz - oz * dx);
      return ahead > 0.3 && ahead < RUN + 3 && side < 1.6;
    });
    if (!inLane) return { r, person: p, dx, dz };
  }
  return null;
}

function ramPerson(speed: number, withPeople: boolean, lateral = 0) {
  let t: Target | null = null;
  for (const seed of RAM_SEEDS) {
    t = findTarget(seed, withPeople);
    if (t) break;
  }
  if (!t) throw new Error('no clear gate stand');
  const { r, person, dx, dz } = t;
  r.tick = r.countdownTicks;
  r.phase = 'racing';
  const rc = r.cars[0];
  const c = rc.state;
  // The lateral offset is along the car's right.
  const rx = dz;
  const rz = -dx;
  placeCar(c, person.x - dx * RUN + rx * lateral, person.z - dz * RUN + rz * lateral, yawOf(dx, dz), r.world);
  rc.seg = -1;
  c.vx = dx * speed;
  c.vz = dz * speed;
  for (const wh of c.wheels) wh.spinRate = speed / rc.tuning.geometry.wheelRadius;
  const nitro0 = c.nitro;
  let hit = -1;
  let before = 0;
  let after = 0;
  let wreck = 0;
  let carV = [0, 0];
  const start = r.tick;
  const speeds: number[] = [];
  for (let i = 0; i < 150; i++) {
    const v = Math.hypot(c.vx, c.vz);
    const n = r.events.length;
    stepRace(r, input({}));
    speeds.push(Math.hypot(c.vx, c.vz));
    if (hit < 0 && r.events.slice(n).some((e) => e.type === 'person' && e.car === 0)) {
      hit = r.tick;
      before = v;
      wreck = c.nitroGain.wreck;
      carV = [c.vx, c.vz];
      // Speed as the hit tick leaves it (the wall behind the stand has not been reached).
      after = Math.hypot(c.vx, c.vz);
    }
  }
  return { r, person, hit, before, after, wreck, nitro0, carV, c, start, speeds };
}

describe('pedestrians in the sim', () => {
  it('a car at 32 m/s knocks a gate stand person down, loses a little speed and gains no nitrous', () => {
    const run = ramPerson(FAST, true);
    expect(run.hit).toBeGreaterThan(0);
    const st = run.r.people;
    expect(st.down[run.person.id]).toBe(1);
    expect(st.hitTick[run.person.id]).toBeGreaterThan(0);
    expect(st.hits).toBeGreaterThan(0);
    expect(run.r.events.filter((e) => e.type === 'person' && e.value === run.person.id)).toHaveLength(1);
    // A real hit at speed, not a late bump after the wall.
    expect(run.before).toBeGreaterThan(25);
    const loss = 1 - run.after / run.before;
    expect(loss).toBeGreaterThan(0.02);
    expect(loss).toBeLessThan(0.15);
    expect(run.wreck).toBe(0);
    expect(run.c.nitro).toBeLessThanOrEqual(run.nitro0);
    // Thrown the way the car was going.
    const along = st.hitVx[run.person.id] * run.carV[0] + st.hitVz[run.person.id] * run.carV[1];
    expect(along).toBeGreaterThan(0);
    // The fall starts where the person was dodged to: within the biggest step of home.
    const away = Math.hypot(st.hitX[run.person.id] - run.person.x, st.hitZ[run.person.id] - run.person.z);
    expect(away).toBeLessThanOrEqual(PEOPLE.sidestep.max * 1.2 + 0.01);
  });

  it('is deterministic, replays bit for bit from its input log, and is off without the flag', () => {
    // The same ram twice: the same car, the same people down.
    const run = ramPerson(FAST, true);
    const again = ramPerson(FAST, true);
    expect(carSnapshot(again.r)).toBe(carSnapshot(run.r));
    expect(JSON.stringify(Array.from(again.r.people.hitTick))).toBe(JSON.stringify(Array.from(run.r.people.hitTick)));
    // A recorded race (a lap of the autopilot through the start's stands) replays to the same state.
    const cfg = { ...raceConfig(20261019, 'circuit', 2), people: true };
    const live = runAutopilot(cfg, 20);
    const replay = replayLog(cfg, live.inputLog);
    expect(carSnapshot(replay)).toBe(carSnapshot(live));
    expect(replay.people.hits).toBe(live.people.hits);
    // Without the flag (every recorded race before it): no state, no events, no slowdown.
    const off = ramPerson(FAST, false);
    expect(off.r.events.some((e) => e.type === 'person')).toBe(false);
    expect(off.r.people.down.length).toBe(0);
    expect(off.hit).toBe(-1);
    // Same step as the hit above: the car without people carries on at its speed.
    expect(off.speeds[run.hit - run.start - 1]).toBeGreaterThan(run.after * 1.02);
  });

  it('a person dead in the line of an 8 m/s car steps aside, at 32 m/s they do not manage', () => {
    const centred = ramPerson(8, true);
    expect(centred.r.people.down[centred.person.id]).toBe(0);
    const fast = ramPerson(FAST, true);
    expect(fast.r.people.down[fast.person.id]).toBe(1);
  });

  it('a person a half metre off the line of an 8 m/s car steps aside', () => {
    const slow = ramPerson(8, true, 0.5);
    // At 8 m/s a person a half metre off the car's line steps aside: no hit.
    expect(slow.r.people.down[slow.person.id]).toBe(0);
  });
});

describe('the dodge', () => {
  const car = (x: number, z: number, yaw: number, speed: number): DodgeCar => ({ x, z, yaw, speed });
  const out = { x: 0, z: 0 };

  it('asks nothing of people far ahead, behind or in the clear, and nothing of a crawling car', () => {
    const S = PEOPLE.sidestep;
    sidestep(0.5, S.carHalfLength + S.lookAhead + 1, [car(0, 0, 0, 10)], 0, -1, 2, 1, out);
    expect(Math.hypot(out.x, out.z)).toBe(0);
    sidestep(0.5, -S.carHalfLength - S.behind - 1, [car(0, 0, 0, 10)], 0, -1, 2, 1, out);
    expect(Math.hypot(out.x, out.z)).toBe(0);
    sidestep(5, 5, [car(0, 0, 0, 10)], 0, -1, 2, 1, out);
    expect(Math.hypot(out.x, out.z)).toBe(0);
    sidestep(0.5, 5, [car(0, 0, 0, 0.5)], 0, -1, 2, 1, out);
    expect(Math.hypot(out.x, out.z)).toBe(0);
  });

  it('moves a person off the car\'s line away from its side, more for a slow car, and respects the wall behind', () => {
    // Car heading +z, its right is +x. A person at lat +0.5, 6 m ahead steps right.
    sidestep(0.5, 6, [car(0, 0, 0, 8)], 0, -1, 2, 1, out);
    expect(out.x).toBeGreaterThan(0.5);
    expect(Math.abs(out.z)).toBeLessThan(1e-9);
    const slow = out.x;
    sidestep(0.5, 6, [car(0, 0, 0, 30)], 0, -1, 2, 1, out);
    expect(out.x).toBeLessThan(slow);
    // A wall to the right with 0.2 m of room caps the step.
    sidestep(0.5, 6, [car(0, 0, 0, 8)], 1, 0, 0.2, 1, out);
    expect(out.x).toBeCloseTo(0.2, 6);
    // Dead in line: steps to the preferred side, the full distance for a car at 8 m/s.
    sidestep(0, 6, [car(0, 0, 0, 8)], 0, -1, 2, 1, out);
    expect(out.x).toBeCloseTo(PEOPLE.sidestep.max, 6);
    sidestep(0, 6, [car(0, 0, 0, 8)], 0, -1, 2, -1, out);
    expect(out.x).toBeCloseTo(-PEOPLE.sidestep.max, 6);
    // Continuous: just either side of the line the step varies smoothly.
    sidestep(0.01, 6, [car(0, 0, 0, 8)], 0, -1, 2, -1, out);
    const a = out.x;
    sidestep(-0.01, 6, [car(0, 0, 0, 8)], 0, -1, 2, -1, out);
    expect(Math.abs(a - out.x)).toBeLessThan(0.2);
  });
});

describe('people off the race line', () => {
  // An AI-only race (the player idles): every pedestrian these seeds hit once came from a walker path crossing ground the route drives
  // (a park pass, a ford). 60 s of racing each.
  for (const seed of [2171733023, 12345, 20261019]) {
    it(`no AI car hits anyone on seed ${seed}`, () => {
      const r = createRace({ ...raceConfig(seed, 'circuit', 3), people: true });
      for (let i = 0; i < 60 * 60 + r.countdownTicks; i++) stepRace(r, input({}));
      expect(r.events.filter((e) => e.type === 'person' && e.car !== 0)).toHaveLength(0);
    });
  }
});

describe('people anchored to a prop', () => {
  /** A bench (or bus stop) with sitters anchored to it, and a clear run up across the sidewalk from the road. */
  function findBench(seed: number) {
    const r = createRace({ ...raceConfig(seed, 'circuit', 0), people: true });
    const w = r.world;
    const plan = peopleOf(w);
    const byProp = new Map<number, WorldPerson[]>();
    for (const p of plan.people) if (p.idle && p.idle.anchorProp >= 0 && p.idle.pose === 'sit') byProp.set(p.idle.anchorProp, [...(byProp.get(p.idle.anchorProp) ?? []), p]);
    for (const [id, sitters] of byProp) {
      const prop = w.props[id];
      if (prop.kind !== 'bench' || w.coveredProps.includes(id)) continue;
      // Local +Z (toward the road) in world: (sin yaw, cos yaw); the car comes from the road side.
      const fx = Math.sin(prop.yaw);
      const fz = Math.cos(prop.yaw);
      let ok = true;
      for (let d = 10; d >= 1 && ok; d--) {
        const x = prop.x + fx * d;
        const z = prop.z + fz * d;
        const rp = w.routeProgress(x, z);
        const q = routeSample(w.route, rp.s);
        ok = w.wallClearance(x, z, 2) >= 1.2 && Math.hypot(x - q.x, z - q.z) < w.route.segWidth[rp.seg] / 2 + 6;
      }
      if (ok) return { r, prop, sitters, fx, fz };
    }
    return null;
  }

  it('a car breaking a bench takes its sitters down with it', () => {
    let found: ReturnType<typeof findBench> = null;
    for (const seed of [...RAM_SEEDS, 1, 2, 3, 4, 5, 6]) {
      found = findBench(seed);
      if (found) break;
    }
    if (!found) throw new Error('no bench with sitters');
    const { r, prop, sitters, fx, fz } = found;
    r.tick = r.countdownTicks;
    r.phase = 'racing';
    const rc = r.cars[0];
    const c = rc.state;
    placeCar(c, prop.x + fx * 10, prop.z + fz * 10, yawOf(-fx, -fz), r.world);
    rc.seg = -1;
    c.vx = -fx * 15;
    c.vz = -fz * 15;
    for (const wh of c.wheels) wh.spinRate = 15 / rc.tuning.geometry.wheelRadius;
    for (let i = 0; i < 120 && !r.brokenProps[prop.id]; i++) stepRace(r, input({}));
    expect(r.brokenProps[prop.id]).toBe(1);
    for (const s of sitters) {
      expect(r.people.down[s.id]).toBe(1);
      expect(r.events.some((e) => e.type === 'person' && e.value === s.id && e.car === 0)).toBe(true);
    }
  });

  it('a sitter falls in the very tick the prop breaks, flung with the car, without a momentum exchange', () => {
    let found: ReturnType<typeof findBench> = null;
    for (const seed of [...RAM_SEEDS, 1, 2, 3, 4, 5, 6]) {
      found = findBench(seed);
      if (found) break;
    }
    if (!found) throw new Error('no bench with sitters');
    const { r, prop, sitters } = found;
    r.tick = r.countdownTicks;
    r.phase = 'racing';
    const rc = r.cars[0];
    const c = rc.state;
    // Parked 4 m from the bench (clear of every person's circle), the bench already broken: the sitters in reach fall.
    placeCar(c, prop.x + Math.sin(prop.yaw) * 4, prop.z + Math.cos(prop.yaw) * 4, yawOf(0, 1), r.world);
    rc.seg = -1;
    r.brokenProps[prop.id] = 1;
    stepRace(r, input({}));
    const fallen = sitters.filter((s) => r.people.down[s.id] === 1);
    expect(fallen.length).toBeGreaterThan(0);
    for (const s of fallen) {
      expect(r.people.hitTick[s.id]).toBe(r.tick - 1);
      // A sitter does not dodge: the fall starts at their seat.
      expect(r.people.hitX[s.id]).toBe(Math.fround(s.x));
      expect(r.people.hitZ[s.id]).toBe(Math.fround(s.z));
    }
  });
});
