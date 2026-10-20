import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createWorld } from '../src/city/world';
import type { RailWall } from '../src/city/route';
import { ROUTE } from '../src/city/config';
import { corridorClearance } from '../src/city/blocks';
import { createCar, stepCar } from '../src/sim/car';
import { collideCarWithWorld } from '../src/sim/collision';
import { getBaseTuning } from '../src/sim/tuning';
import { RAIL, createRailState, maxRailGap, pushRailPiece, railLayout } from '../src/sim/rails';
import { createRace, stepRace } from '../src/sim/race';
import { distToSegment, segmentT } from '../src/sim/math';
import { input, raceConfig, replayLog } from './helpers';

const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) => {
  const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
  if (Math.abs(den) < 1e-12) return false;
  const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
  const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
};

const rails = (w: ReturnType<typeof createWorld>) => w.walls.filter((x) => x.kind === 'rail') as RailWall[];
/** Rail groups that are closures (side streets shut by straight cyan pieces) rather than corner rails. */
const closureGroups = (w: ReturnType<typeof createWorld>) => new Set(w.barrierGroups.map((g) => (g.walls[0] as RailWall | undefined)?.group));

describe('corner rails', () => {
  it('are smooth chains of modular pieces at the back of the sidewalk', () => {
    const rng = new Rng(4242);
    let pieces = 0;
    for (let i = 0; i < 16; i++) {
      const w = createWorld(rng.int(0, 0x7fffffff), i % 2 ? 'sprint' : 'circuit');
      const all = rails(w);
      const closures = closureGroups(w);
      const rs = all.filter((r) => !closures.has(r.group));
      const scratch: number[] = [];
      rs.forEach((r, k) => {
        const next = rs[k + 1];
        if (next && next.group === r.group) {
          // Connected, continuous: no gaps and no kinks at the joints.
          expect(Math.hypot(next.ax - r.bx, next.az - r.bz)).toBeLessThan(1e-9);
          let d = Math.abs(Math.atan2(next.bz - next.az, next.bx - next.ax) - Math.atan2(r.bz - r.az, r.bx - r.ax));
          if (d > Math.PI) d = 2 * Math.PI - d;
          expect(d).toBeLessThan(9 * (Math.PI / 180));
          expect(next.piece === r.piece || next.piece === r.piece + 1).toBe(true);
        }
        // Inside the road corridor (on the sidewalk or across a closed street), never past the building
        // line (the corridor is round at bends where the sidewalk is polygonal: a little tolerance).
        expect(corridorClearance(w.graph, w.blocks.edgeGrid, r.ax, r.az, scratch)).toBeLessThan(0.1);
        // Beside a route edge, away from its ends: at the back of the sidewalk, never on it or the road.
        for (const eid of w.route.edges) {
          const e = w.graph.edges[eid];
          const a = w.graph.nodes[e.a];
          const b = w.graph.nodes[e.b];
          const t = segmentT(r.ax, r.az, a.x, a.z, b.x, b.z);
          if (t * e.length < 30 || (1 - t) * e.length < 30) continue;
          const d = distToSegment(r.ax, r.az, a.x, a.z, b.x, b.z) - e.width / 2;
          if (d < (e.sidewalk ?? 4) + 1) expect(d).toBeGreaterThan((e.sidewalk ?? 4) - ROUTE.railInset - 0.05);
        }
      });
      // Pieces about railPieceLength long (closure pieces are straight, and short where a closure is).
      const len = new Map<number, number>();
      for (const r of all) len.set(r.piece, (len.get(r.piece) ?? 0) + Math.hypot(r.bx - r.ax, r.bz - r.az));
      for (const r of rs) {
        const l = len.get(r.piece)!;
        expect(l).toBeGreaterThan(ROUTE.railPieceLength * 0.6);
        expect(l).toBeLessThan(ROUTE.railPieceLength * 1.5);
      }
      for (const r of all) if (closures.has(r.group)) expect(len.get(r.piece)!).toBeLessThan(ROUTE.railPieceLength * 1.5);
      pieces += len.size;
      // Never through a city wall, and corner rails clear of every prop.
      const others = w.walls.filter((x) => x.kind !== 'rail');
      for (const r of all) {
        for (const o of others) {
          if (Math.abs(o.ax - r.ax) > 80 || Math.abs(o.az - r.az) > 80) continue;
          expect(cross(r.ax, r.az, r.bx, r.bz, o.ax, o.az, o.bx, o.bz)).toBe(false);
        }
        for (const p of w.props) {
          if (Math.abs(p.x - r.ax) > 6 || Math.abs(p.z - r.az) > 6) continue;
          // A closure may stand right beside street furniture (and takes away whatever it stands on).
          if (closures.has(r.group)) continue;
          expect(distToSegment(p.x, p.z, r.ax, r.az, r.bx, r.bz)).toBeGreaterThan(p.radius + 0.2);
        }
      }
      // The sim's pieces match the walls.
      expect(railLayout(w).count).toBe(len.size);
    }
    expect(pieces).toBeGreaterThan(1000);
  });

  /** Slide a car along the middle of a long rail, leaning into it. */
  function scrape(seed: number, withRails: boolean) {
    const w = createWorld(seed, 'circuit');
    const rs = rails(w);
    const layout = railLayout(w);
    // A piece on a straight run (it and the four before it in line): start 10 m before it.
    const head = (p: number) => Math.atan2(layout.tz[p], layout.tx[p]);
    let best = -1;
    for (let p = 0; p < layout.count && best < 0; p++) {
      let q = p;
      let ok = layout.next[p] >= 0;
      for (let i = 0; i < 5 && ok; i++) {
        q = layout.prev[q];
        ok = q >= 0 && Math.abs(head(q) - head(p)) < 0.01;
      }
      if (ok) best = p;
    }
    expect(best).toBeGreaterThanOrEqual(0);
    const k = layout.first[best];
    const wall = rs[k];
    const tx = (wall.bx - wall.ax) / Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
    const tz = (wall.bz - wall.az) / Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
    const t = getBaseTuning('protoCompact');
    const state = withRails ? createRailState(w) : undefined;
    // 10 degrees into the rail at 25 m/s, starting just off it.
    const ang = 10 * (Math.PI / 180);
    const vx = (tx * Math.cos(ang) - wall.nx * Math.sin(ang)) * 25;
    const vz = (tz * Math.cos(ang) - wall.nz * Math.sin(ang)) * 25;
    const sx = wall.ax - tx * 10 + wall.nx * (t.geometry.halfWidth + 1.5);
    const sz = wall.az - tz * 10 + wall.nz * (t.geometry.halfWidth + 1.5);
    const c = createCar(sx, sz, Math.atan2(vx, vz), w.heightAt(sx, sz));
    c.vx = vx;
    c.vz = vz;
    for (const wh of c.wheels) wh.spinRate = 25 / t.geometry.wheelRadius;
    let maxGap = 0;
    for (let i = 0; i < 70; i++) {
      stepCar(c, t, input({ throttle: 0.5 }), { world: w });
      collideCarWithWorld(c, t, w, undefined, state, i);
      if (state) maxGap = Math.max(maxGap, maxRailGap(state));
    }
    return { speed: c.speed, state, maxGap, width: t.geometry.halfWidth * 2 };
  }

  it('heavy pieces give a little when a car slides along them, and the joints stay closed', () => {
    const fixed = scrape(20261019, false);
    const moving = scrape(20261019, true);
    const s = moving.state!;
    let moved = 0;
    let maxOff = 0;
    for (let p = 0; p < s.layout.count; p++) {
      const off = Math.hypot(s.dx[p], s.dz[p]);
      if (off > 0.005) moved++;
      maxOff = Math.max(maxOff, off);
      expect(Math.abs(s.rot[p])).toBeLessThanOrEqual(RAIL.maxRot + 1e-12);
    }
    expect(moved).toBeGreaterThan(1);
    expect(maxOff).toBeLessThanOrEqual(RAIL.maxOffset + 1e-9);
    expect(maxOff).toBeLessThan(0.4);
    expect(moving.maxGap).toBeLessThanOrEqual(moving.width / 8);
    // Denting the rail (and scraping over the steps it leaves) costs more than a rigid rail, but it is no wall.
    expect(moving.speed).toBeLessThan(fixed.speed);
    expect(moving.speed).toBeGreaterThan(fixed.speed * 0.5);
    // Displaced pieces push back from the new position: the sim walls moved, the world's did not.
    const l = s.layout;
    const k = l.first[s.dx.findIndex((_, p) => Math.hypot(s.dx[p], s.dz[p]) > 0.005)];
    expect(s.ax[k]).not.toBe(l.ax[k]);
  });

  it('the step where a dented piece meets a straight one catches a car scraping along', () => {
    const w = createWorld(20261019, 'circuit');
    const t = getBaseTuning('protoCompact');
    const run = (dent: boolean) => {
      const s = createRailState(w);
      const l = s.layout;
      // Two pieces in line on a straight run, then the next one.
      let p = -1;
      for (let i = 0; i < l.count && p < 0; i++) {
        const q = l.next[i];
        const o = l.prev[i];
        if (q >= 0 && o >= 0 && l.subs[i] === 1 && l.subs[q] === 1 && l.subs[o] === 1 && Math.abs(l.tx[i] * l.tz[q] - l.tz[i] * l.tx[q]) < 1e-3 && Math.abs(l.tx[i] * l.tz[o] - l.tz[i] * l.tx[o]) < 1e-3) p = i;
      }
      expect(p).toBeGreaterThanOrEqual(0);
      const k = l.first[p];
      const nx = l.nx[k];
      const nz = l.nz[k];
      if (dent) {
        // Knock this piece and the one before it back ~8 cm; the next one stays put.
        for (const d of [l.prev[p], p]) pushRailPiece(s, d, nx, nz, (0.08 * RAIL.pieceMass) / RAIL.yieldTime, l.cx[d], l.cz[d], 0);
        expect(l.next[p]).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(s.dx[l.next[p]], s.dz[l.next[p]])).toBeLessThan(1e-9);
      }
      // Front circle just short of the joint, touching the (dented) face, sliding along at 20 m/s.
      const r = t.geometry.halfWidth * 0.95;
      const span = t.geometry.halfLength - r;
      const jx = s.bx[k];
      const jz = s.bz[k];
      const cx = jx - l.tx[p] * (span + 0.1) + nx * (r - 0.01);
      const cz = jz - l.tz[p] * (span + 0.1) + nz * (r - 0.01);
      const c = createCar(cx, cz, Math.atan2(l.tx[p], l.tz[p]), w.heightAt(cx, cz));
      c.vx = l.tx[p] * 20;
      c.vz = l.tz[p] * 20;
      collideCarWithWorld(c, t, w, undefined, s, 0);
      return Math.hypot(c.vx, c.vz);
    };
    const straight = run(false);
    const stepped = run(true);
    expect(straight).toBeGreaterThan(19.5);
    expect(stepped).toBeLessThan(straight * 0.94);
  });

  it('gaps between pieces stay under 1/8 of a car width however hard they are hit', () => {
    const w = createWorld(7, 'circuit');
    const s = createRailState(w);
    const l = s.layout;
    // Hammer every third piece straight back, far past the offset cap.
    for (let round = 0; round < 6; round++) {
      for (let p = round % 3; p < l.count; p += 3) {
        const k = l.first[p];
        // Lever arm off center so the pieces also turn.
        pushRailPiece(s, p, l.nx[k], l.nz[k], 2e5, l.ax[k], l.az[k], round);
      }
      expect(maxRailGap(s)).toBeLessThanOrEqual(RAIL.maxGap + 1e-9);
    }
    for (let p = 0; p < l.count; p++) expect(Math.hypot(s.dx[p], s.dz[p])).toBeLessThanOrEqual(RAIL.maxOffset + 1e-9);
    expect(RAIL.maxGap).toBeLessThanOrEqual(Math.min(...['protoCompact', 'protoHatch'].map((id) => getBaseTuning(id).geometry.halfWidth * 2)) / 8);
  });

  it('a race that dents the rails replays identically', () => {
    // Full throttle, steering right: the player ploughs into the first corner and scrapes along.
    const cfg = raceConfig(20261019, 'circuit', 2);
    const r = createRace(cfg);
    for (let i = 0; i < 60 * 25; i++) stepRace(r, input({ throttle: 1, steer: i > 200 ? 0.35 * Math.sin(i / 50) : 0 }));
    const replay = replayLog(cfg, r.inputLog);
    expect(Array.from(replay.rails.dx)).toEqual(Array.from(r.rails.dx));
    expect(Array.from(replay.rails.dz)).toEqual(Array.from(r.rails.dz));
    expect(Array.from(replay.rails.rot)).toEqual(Array.from(r.rails.rot));
    expect(replay.rails.version).toBe(r.rails.version);
    expect(JSON.stringify(replay.cars.map((c) => c.state))).toBe(JSON.stringify(r.cars.map((c) => c.state)));
  });
});

describe('open world test drive', () => {
  it('has no barriers, rails, rivals or countdown, and never nags about the route', () => {
    const r = createRace({ ...raceConfig(20261019, 'circuit', 3), openWorld: true, laps: 10 });
    expect(r.world.openWorld).toBe(true);
    expect(r.cars.length).toBe(1);
    expect(r.countdownTicks).toBe(0);
    expect(r.world.walls.some((w) => w.kind === 'barrier' || w.kind === 'rail')).toBe(false);
    expect(r.world.barrierGroups.length).toBe(0);
    expect(r.rails.layout.count).toBe(0);
    // Drive backwards along the route (wrong way) for a while: no wrong way, no route reset.
    const rc = r.cars[0];
    for (let i = 0; i < 60 * 6; i++) stepRace(r, input({ brake: 1 }));
    expect(r.events.some((e) => e.type === 'wrongWay' || e.type === 'reset' || e.type === 'lap')).toBe(false);
    expect(rc.wrongWay).toBe(false);
    // A car lost off the road network is put back on the nearest street.
    rc.state.x = r.world.graph.bounds.maxX + 300;
    rc.state.z = r.world.graph.bounds.maxZ + 300;
    for (let i = 0; i < 60 * 3; i++) stepRace(r, input({}));
    expect(r.events.filter((e) => e.type === 'reset').length).toBe(1);
    expect(r.world.surfaceAt(rc.state.x, rc.state.z)).toBe('road');
  });

  it('a closed-route race keeps its barriers and rails', () => {
    const r = createRace(raceConfig(20261019, 'circuit', 3));
    expect(r.world.openWorld).toBe(false);
    expect(r.cars.length).toBe(4);
    expect(r.world.walls.some((w) => w.kind === 'rail')).toBe(true);
    expect(r.rails.layout.count).toBeGreaterThan(0);
  });
});
