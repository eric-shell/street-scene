import { describe, expect, it } from 'vitest';
import { createRace, standings, stepRace } from '../src/sim/race';
import { createAi, autopilotInput } from '../src/sim/ai';
import { TICK_HZ } from '../src/sim/constants';
import { createWorld } from '../src/city/world';
import { POLICE, policeChaseCall, policeWaypoints, raceLeader } from '../src/render/traffic/policeChase';
import { input, raceConfig } from './helpers';

describe('police helicopter brief', () => {
  it('follows the leader from the last lap to a few seconds past the finish, then leaves', () => {
    const r = createRace(raceConfig(1234, 'circuit', 3, undefined, 2));
    const pilot = createAi(7, 0.97);
    const seen: string[] = [];
    let firstChase = -1;
    while (r.tick < 60 * 400) {
      const call = policeChaseCall(r);
      expect(policeChaseCall(r)).toEqual(call);
      // The leader is exactly standings() first place.
      expect(raceLeader(r).index).toBe(standings(r)[0].car.index);
      const lead = raceLeader(r);
      if (r.tick < r.countdownTicks) expect(call.phase).toBe('patrol');
      else if (!lead.finished) {
        expect(call.phase).toBe(lead.lap >= r.config.laps ? 'chase' : 'patrol');
        if (call.phase === 'chase') expect(call.car).toBe(lead.index);
      } else expect(call.phase).toBe(r.tick - lead.finishTick <= POLICE.linger * TICK_HZ ? 'chase' : 'leave');
      if (call.phase === 'chase' && firstChase < 0) firstChase = r.tick;
      if (seen[seen.length - 1] !== call.phase) seen.push(call.phase);
      if (lead.finished && r.tick - lead.finishTick > (POLICE.linger + 1) * TICK_HZ) break;
      stepRace(r, autopilotInput(r, r.cars[0], pilot));
    }
    expect(seen).toEqual(['patrol', 'chase', 'leave']);
    // It chases for the final lap only.
    expect(firstChase).toBeGreaterThan(r.countdownTicks + 20 * TICK_HZ);
  });

  it('chases the last stretch of a sprint, and never in free roam', () => {
    const r = createRace(raceConfig(77, 'sprint', 1));
    const stretch = Math.max(POLICE.stretchMin, r.distance * POLICE.stretchShare);
    while (r.tick < r.countdownTicks + 2) stepRace(r, input({}));
    const lead = raceLeader(r);
    expect(policeChaseCall(r).phase).toBe('patrol');
    lead.dist = r.distance - stretch - 1;
    expect(policeChaseCall(r).phase).toBe('patrol');
    lead.dist = r.distance - stretch + 1;
    expect(policeChaseCall(r)).toEqual({ phase: 'chase', car: lead.index });
    const roam = createRace({ ...raceConfig(77, 'circuit', 0), openWorld: true });
    for (let i = 0; i < 30; i++) stepRace(roam, input({ throttle: 1 }));
    roam.cars[0].lap = 99;
    expect(policeChaseCall(roam).phase).toBe('patrol');
  });

  it('patrols a seeded loop high over the course', () => {
    const w = createWorld(43405381, 'circuit');
    const pts = policeWaypoints(w, w.seed);
    expect(policeWaypoints(w, w.seed)).toEqual(pts);
    expect(pts.length).toBe(POLICE.patrolPoints);
    for (const p of pts) expect(p.y - w.heightAt(p.x, p.z)).toBeGreaterThanOrEqual(POLICE.patrolAlt[0] - 1e-6);
  });
});
