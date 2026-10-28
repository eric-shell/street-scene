import { describe, expect, it } from 'vitest';
import { createCity, createWorld } from '../src/city/world';
import { distToSegment } from '../src/sim/math';
import { BOATS } from '../src/render/districts/boats';
import { type FerryPose, ferryPose, hornsBetween, planFerry } from '../src/render/districts/waterfrontFerry';
import { renderFerryHorn } from '../src/audio/sceneVoices';

/** A harbor (seed 5, the working kind), a marina (3) and a beach (9), each with its ferry plan. */
const harbors = [5, 3, 9].map((seed) => {
  const world = createWorld(seed, 'circuit', createCity(seed));
  const a = world.areas.find((x) => x.kind === 'waterfront')!;
  const b = world.districts.builds[a.id];
  return { seed, a, b, plan: planFerry(a, b) };
});

describe('the harbor ferry', () => {
  it('berths at a working harbor and sails a lane where the wall is taken', () => {
    expect(harbors[0].a.variant).toBe('harbor');
    expect(harbors[0].plan?.mode).toBe('berth');
    for (const h of harbors.slice(1)) expect(h.plan?.mode, `${h.seed} ${h.a.variant}`).toBe('lane');
  });

  it('is a pure function of the clock: the same plan and time give the same pose, and the plan itself repeats', () => {
    for (const h of harbors) {
      const again = planFerry(h.a, h.b)!;
      expect(again.total).toBe(h.plan!.total);
      const p: FerryPose = { x: 0, z: 0, yaw: 0, speed: 0, arc: 0, turn: 0 };
      const q: FerryPose = { ...p };
      for (const t of [0, 17.3, 90, 333.3, 1234.5]) expect(ferryPose(again, t, q)).toEqual(ferryPose(h.plan!, t, p));
    }
  });

  it('never jumps: the pose moves by at most its speed, and the heading turns smoothly, across two cycles', () => {
    for (const h of harbors) {
      const plan = h.plan!;
      const p: FerryPose = { x: 0, z: 0, yaw: 0, speed: 0, arc: 0, turn: 0 };
      let prev: FerryPose | null = null;
      for (let t = 0; t < 2 * plan.period; t += 0.25) {
        ferryPose(plan, t, p);
        if (prev) {
          expect(Math.hypot(p.x - prev.x, p.z - prev.z), `${h.seed} at ${t}`).toBeLessThan(Math.max(BOATS.ferry.speed, BOATS.ferry.laneSpeed) * 0.25 * 1.1 + 0.05);
          const dy = Math.atan2(Math.sin(p.yaw - prev.yaw), Math.cos(p.yaw - prev.yaw));
          expect(Math.abs(dy), `${h.seed} at ${t}`).toBeLessThan(0.1);
        }
        prev = { ...p };
      }
    }
  });

  it('lies at the quay for the dwell, leaves at its first departure, and blows the horn then and as it comes in', () => {
    const { plan } = harbors[0];
    const p: FerryPose = { x: 0, z: 0, yaw: 0, speed: 0, arc: 0, turn: 0 };
    ferryPose(plan!, 0, p);
    expect(p.speed).toBe(0);
    const at = { x: p.x, z: p.z };
    ferryPose(plan!, plan!.start - 1, p);
    expect(Math.hypot(p.x - at.x, p.z - at.z)).toBeLessThan(0.5);
    ferryPose(plan!, plan!.start + 60, p);
    expect(p.speed).toBeGreaterThan(1);
    const horns = hornsBetween(plan!, 0, plan!.period);
    expect(horns[0]).toBeCloseTo(plan!.start, 6);
    expect(horns.length).toBe(2);
    // The second blast comes while it is still under way, well before it stops.
    expect(horns[1]).toBeLessThan(plan!.start + plan!.period - plan!.dwell);
    expect(hornsBetween(plan!, 0, plan!.period * 3).length).toBe(6);
  });

  it('keeps clear of everything standing in the water', () => {
    for (const { a, b, plan } of harbors) {
      const p: FerryPose = { x: 0, z: 0, yaw: 0, speed: 0, arc: 0, turn: 0 };
      const hull = BOATS.ferry.beam / 2 + 2;
      for (let t = 0; t < plan!.period; t += 2) {
        ferryPose(plan!, t, p);
        for (const pr of b.props) {
          if (pr.kind !== 'ship' && pr.kind !== 'sailboat' && pr.kind !== 'yacht') continue;
          const r = pr.kind === 'ship' ? pr.height / 2 : pr.size / 2;
          const fx = Math.sin(pr.yaw);
          const fz = Math.cos(pr.yaw);
          const reach = pr.kind === 'ship' ? pr.size : 0;
          expect(distToSegment(p.x, p.z, pr.x - fx * reach, pr.z - fz * reach, pr.x + fx * reach, pr.z + fz * reach), `${a.id} ${pr.kind} at ${t}`).toBeGreaterThan(r + hull);
        }
      }
    }
  });

  it('renders a horn that is audible and never clips', () => {
    const buf = renderFerryHorn(8000);
    let peak = 0;
    for (const v of buf) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1);
  });
});
