import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createWorld } from '../src/city/world';
import type { RailWall } from '../src/city/routeRails';
import { ROUTE } from '../src/city/config';
import { corridorClearance } from '../src/city/blocks';
import { createCar, stepCar } from '../src/sim/car';
import { collideCarWithWorld } from '../src/sim/collision';
import { getBaseTuning } from '../src/sim/tuning';
import { RAIL, createRailState, maxRailGap, pushRailPiece, railLayout } from '../src/sim/rails';
import { createRace, stepRace } from '../src/sim/race';
import { distToSegment, segmentT } from '../src/sim/math';
import { input, raceConfig, replayLog, baseTuning } from './helpers';

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
      const seed = rng.int(0, 0x7fffffff);
      const w = createWorld(seed, i % 2 ? 'sprint' : 'circuit');
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
        // Street furniture just behind the rail bends it a little further onto the sidewalk, over a
        // span of a couple of pieces either side of the prop (routeRails.ts).
        const furniture = w.props.some((p) => (p.x - r.ax) ** 2 + (p.z - r.az) ** 2 < 81);
        const onto = ROUTE.railInset + 0.05 + (furniture ? ROUTE.railPropClear + 0.6 : 0);
        for (const eid of w.route.edges) {
          const e = w.graph.edges[eid];
          const a = w.graph.nodes[e.a];
          const b = w.graph.nodes[e.b];
          const t = segmentT(r.ax, r.az, a.x, a.z, b.x, b.z);
          if (t * e.length < 30 || (1 - t) * e.length < 30) continue;
          const d = distToSegment(r.ax, r.az, a.x, a.z, b.x, b.z) - e.width / 2;
          if (d < (e.sidewalk ?? 4) + 1) expect(d, `${r.group}/${r.piece} on edge ${eid}`).toBeGreaterThan((e.sidewalk ?? 4) - onto);
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
      // Never through a city wall, and corner rails clear of every prop left standing.
      const others = w.walls.filter((x) => x.kind !== 'rail');
      const covered = new Set(w.coveredProps);
      for (const r of all) {
        for (const o of others) {
          if (Math.abs(o.ax - r.ax) > 80 || Math.abs(o.az - r.az) > 80) continue;
          expect(cross(r.ax, r.az, r.bx, r.bz, o.ax, o.az, o.bx, o.bz), `${seed} ${w.route.kind}: rail ${r.group}/${r.piece} (${r.ax.toFixed(1)},${r.az.toFixed(1)}) crosses ${o.kind}/${o.look} (${o.ax.toFixed(1)},${o.az.toFixed(1)})-(${o.bx.toFixed(1)},${o.bz.toFixed(1)})`).toBe(false);
        }
        for (const p of w.props) {
          if (Math.abs(p.x - r.ax) > 6 || Math.abs(p.z - r.az) > 6) continue;
          // A closure may stand right beside street furniture (and takes away whatever it stands on);
          // clutter a rail would clip starts the race removed.
          if (closures.has(r.group) || covered.has(p.id)) continue;
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
    const { best } = scrapePiece(w);
    const rs = rails(w);
    const layout = railLayout(w);
    expect(best).toBeGreaterThanOrEqual(0);
    const k = layout.first[best];
    return scrapeFrom(w, rs[k], withRails);
  }

  /**
   * The first seed from `from` on whose circuit has a long straight rail run (a dozen pieces) beside a
   * clear sidewalk to slide along: where the routes run changes with everything planned in the city.
   */
  function scrapeSeed(from: number): number {
    for (let seed = from; seed < from + 160; seed++) if (scrapePiece(createWorld(seed, 'circuit')).ahead >= 11) return seed;
    throw new Error('no seed with a long straight rail run');
  }

  /** The rail piece to slide along: the one with the longest straight, level run ahead beside a clear sidewalk. */
  function scrapePiece(w: ReturnType<typeof createWorld>): { best: number; ahead: number } {
    const rs = rails(w);
    const layout = railLayout(w);
    // A piece on a straight, level run (it and the four before it in line, no hill under them so gravity
    // cannot tip the speed comparison): start 10 m before it.
    const head = (p: number) => Math.atan2(layout.tz[p], layout.tx[p]);
    let best = -1;
    let bestAhead = -1;
    for (let p = 0; p < layout.count; p++) {
      let q = p;
      let ok = layout.next[p] >= 0;
      for (let i = 0; i < 5 && ok; i++) {
        q = layout.prev[q];
        ok = q >= 0 && Math.abs(head(q) - head(p)) < 0.01;
      }
      if (!ok) continue;
      // Beside a full width sidewalk (the car starts on it): an alley's rail sits a lane width from the road.
      const wq = rs[layout.first[p]];
      const l = Math.hypot(wq.bx - wq.ax, wq.bz - wq.az);
      if (w.surfaceAt(wq.ax - ((wq.bx - wq.ax) / l) * 10 + wq.nx * 2.4, wq.az - ((wq.bz - wq.az) / l) * 10 + wq.nz * 2.4) !== 'sidewalk') continue;
      // Nothing but the rail on the car's side of it along the run up (a planter strip standing out on the
      // sidewalk would take the hit instead).
      const ux = (wq.bx - wq.ax) / l;
      const uz = (wq.bz - wq.az) / l;
      let clear = true;
      for (let t = -10; t <= 20 && clear; t += 2) {
        const x = wq.ax + ux * t + wq.nx * 1.2;
        const z = wq.az + uz * t + wq.nz * 1.2;
        for (const o of w.walls) {
          if (o.kind !== 'wall' || distToSegment(x, z, o.ax, o.az, o.bx, o.bz) > 2.2) continue;
          const k = segmentT(x, z, o.ax, o.az, o.bx, o.bz);
          const cx = o.ax + (o.bx - o.ax) * k;
          const cz = o.az + (o.bz - o.az) * k;
          if ((cx - (wq.ax + ux * t)) * wq.nx + (cz - (wq.az + uz * t)) * wq.nz > 0.2) clear = false;
        }
      }
      // And the car starts clear of everything (it first touches the rail a few meters on).
      if (w.wallClearance(wq.ax - ux * 10 + wq.nx * 2.4, wq.az - uz * 10 + wq.nz * 2.4, 3) < 1.9) clear = false;
      if (!clear) continue;
      // The car slides on past it: take the piece with the longest straight run ahead, so the two runs
      // never part at a corner, and keep the run level so gravity cannot tip the speed comparison.
      let n = p;
      let ahead = 0;
      while (layout.next[n] >= 0 && Math.abs(head(layout.next[n]) - head(p)) < 0.01 && ahead < 20) {
        n = layout.next[n];
        ahead++;
      }
      if (Math.abs(w.heightAt(layout.cx[n], layout.cz[n]) - w.heightAt(layout.cx[q], layout.cz[q])) > 0.25) continue;
      if (ahead > bestAhead) {
        bestAhead = ahead;
        best = p;
      }
    }
    return { best, ahead: bestAhead };
  }

  function scrapeFrom(w: ReturnType<typeof createWorld>, wall: RailWall, withRails: boolean) {
    const tx = (wall.bx - wall.ax) / Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
    const tz = (wall.bz - wall.az) / Math.hypot(wall.bx - wall.ax, wall.bz - wall.az);
    const t = baseTuning();
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
    for (let i = 0; i < 50; i++) {
      stepCar(c, t, input({ throttle: 0.5 }), { world: w });
      collideCarWithWorld(c, t, w, undefined, state, i);
      if (state) maxGap = Math.max(maxGap, maxRailGap(state));
    }
    return { speed: c.speed, state, maxGap, width: t.geometry.halfWidth * 2 };
  }

  // A long slide against the rails; it passes alone and only times out under the suite's parallel load.
  it('heavy pieces give a little when a car slides along them, and the joints stay closed', { timeout: 300000 }, () => {
    const seed = scrapeSeed(20261019);
    const fixed = scrape(seed, false);
    const moving = scrape(seed, true);
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
    // Denting the rail costs speed of the same order as scraping a rigid one (the piece soaks up the
    // impulse a rigid wall bounces back, the dent and the steps it leaves take their share), and it is no wall.
    // About 15% more here (14% before the grip pass, 17% after: the tires' answer to the hit moved it).
    expect(Math.abs(moving.speed - fixed.speed)).toBeLessThan(fixed.speed * 0.2);
    expect(moving.speed).toBeGreaterThan(fixed.speed * 0.5);
    // Displaced pieces push back from the new position: the sim walls moved, the world's did not.
    const l = s.layout;
    const k = l.first[s.dx.findIndex((_, p) => Math.hypot(s.dx[p], s.dz[p]) > 0.005)];
    expect(s.ax[k]).not.toBe(l.ax[k]);
  });

  it('the step where a dented piece meets a straight one catches a car scraping along', () => {
    const w = createWorld(20261019, 'circuit');
    const t = baseTuning();
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
    expect(RAIL.maxGap).toBeLessThanOrEqual(Math.min(...['wendtFairway', 'kazamaRotor', 'brandtKombi', 'ridgewayFiend', 'hinodeHorizon'].map((id) => getBaseTuning(id).geometry.halfWidth * 2)) / 8);
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

describe('open world free roam', () => {
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
    expect(['road', 'cobble']).toContain(r.world.surfaceAt(rc.state.x, rc.state.z));
  });

  it('a closed-route race keeps its barriers and rails', () => {
    const r = createRace(raceConfig(20261019, 'circuit', 3));
    expect(r.world.openWorld).toBe(false);
    expect(r.cars.length).toBe(4);
    expect(r.world.walls.some((w) => w.kind === 'rail')).toBe(true);
    expect(r.rails.layout.count).toBeGreaterThan(0);
  });
});
