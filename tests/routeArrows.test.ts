import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/city/world';
import { classifyBarriers, closureWay, railPanelFlips, routeSigns, type BarrierInfo } from '../src/render/race/routeArrows';
import { railLayout, type RailLayout } from '../src/sim/rails';
import type { RailWall } from '../src/city/routeRails';

/**
 * Chevron direction on the cyan barriers. Every panel on a closure or corner
 * rail points the way the overhead sign does: the way the race goes past that
 * spot. A panel's chevrons point toward the world end of the piece its flip
 * picks (the same from either face: u is attached to the vertices), so the
 * world direction of piece p is flips[p] * (a -> b); a sign's is
 * flip * (cos yaw, -sin yaw), the world direction of its plane's +x.
 */
const SEEDS = 12;
const KINDS = ['circuit', 'sprint'] as const;

interface Scene {
  seed: number;
  kind: (typeof KINDS)[number];
  world: World;
  barriers: BarrierInfo[];
  layout: RailLayout;
  flips: Int8Array;
}

let cache: Scene[] | null = null;
function scenes(): Scene[] {
  if (cache) return cache;
  cache = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const kind of KINDS) {
      const world = createWorld(seed, kind);
      const barriers = classifyBarriers(world);
      const layout = railLayout(world);
      cache.push({ seed, kind, world, barriers, layout, flips: railPanelFlips(world, barriers, layout) });
    }
  }
  return cache;
}

/** Unit world direction the chevrons of piece p point. */
function chevronDir(l: RailLayout, flips: Int8Array, p: number): { x: number; z: number } {
  const k0 = l.first[p];
  const k1 = k0 + l.subs[p];
  const ux = l.bx[k1 - 1] - l.ax[k0];
  const uz = l.bz[k1 - 1] - l.az[k0];
  const len = Math.hypot(ux, uz) || 1;
  return { x: (flips[p] * ux) / len, z: (flips[p] * uz) / len };
}

describe('chevrons on the cyan barriers', () => {
  it('every closure panel points the way its overhead sign does, on every piece of the closure', () => {
    let checked = 0;
    let signed = 0;
    for (const { seed, kind, world, barriers, layout, flips } of scenes()) {
      for (const sign of routeSigns(world, barriers)) {
        if (!barriers.some((b) => (b.group.walls[0] as RailWall).group === sign.rail)) continue;
        signed++;
        const dx = sign.flip * Math.cos(sign.yaw);
        const dz = -sign.flip * Math.sin(sign.yaw);
        for (let p = 0; p < layout.count; p++) {
          if (layout.group[p] !== sign.rail) continue;
          const c = chevronDir(layout, flips, p);
          const dot = c.x * dx + c.z * dz;
          checked++;
          if (dot <= 0) expect.fail(`seed ${seed} ${kind}: closure rail ${sign.rail} piece ${p} points against its sign (dot ${dot.toFixed(2)})`);
        }
      }
    }
    // Plenty of closures, V shaped ones and ties to corner rails among them.
    expect(signed).toBeGreaterThan(100);
    expect(checked).toBeGreaterThan(1000);
  });

  it('closures without a sign (a short tie to a corner rail) point the same way along themselves', () => {
    let checked = 0;
    for (const { seed, kind, barriers, layout, flips } of scenes()) {
      const way = new Map<number, { x: number; z: number }>();
      for (const b of barriers) way.set((b.group.walls[0] as RailWall).group, closureWay(b));
      for (let p = 0; p < layout.count; p++) {
        const w = way.get(layout.group[p]);
        if (!w) continue;
        const c = chevronDir(layout, flips, p);
        checked++;
        if (c.x * w.x + c.z * w.z <= 0) expect.fail(`seed ${seed} ${kind}: closure piece ${p} points against its closure's way`);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('corner rail panels run the way the route goes, all toward the end that lies further along it, as does the sign over the apex', () => {
    let chains = 0;
    let apexes = 0;
    for (const { seed, kind, world, barriers, layout, flips } of scenes()) {
      const closures = new Set(barriers.map((b) => (b.group.walls[0] as RailWall).group));
      const route = world.route;
      const total = route.cum[route.cum.length - 1];
      // The pieces of each corner rail, in chain order.
      const chain = new Map<number, number[]>();
      for (let p = 0; p < layout.count; p++) {
        if (closures.has(layout.group[p])) continue;
        const list = chain.get(layout.group[p]) ?? [];
        list.push(p);
        chain.set(layout.group[p], list);
      }
      for (const [rail, pieces] of chain) {
        // Every panel of the rail points the same way along it, toward its b end.
        for (const p of pieces) if (flips[p] !== 1) expect.fail(`seed ${seed} ${kind}: corner rail ${rail} piece ${p} points toward its a end`);
        // And a -> b is the way the race goes: the end of the rail lies further along the route than its start
        // (a rail at the very start or end of a sprint, where both ends clamp to the same point, says nothing).
        const first = layout.first[pieces[0]];
        const last = layout.first[pieces[pieces.length - 1]] + layout.subs[pieces[pieces.length - 1]] - 1;
        const pa = world.routeProgress(layout.ax[first], layout.az[first]);
        const pb = world.routeProgress(layout.bx[last], layout.bz[last]);
        // A corner a park or plaza pass cuts: the racing line runs tens of meters inside the street's rail,
        // where a projection onto it says nothing about the rail's direction.
        if (Math.abs(pa.lateral) > 30 || Math.abs(pb.lateral) > 30) continue;
        let ds = pb.s - pa.s;
        if (route.closed) ds = ((ds % total) + total) % total;
        if (Math.abs(ds) < 1e-6) continue;
        chains++;
        if (route.closed ? ds > total / 2 : ds < 0) expect.fail(`seed ${seed} ${kind}: corner rail ${rail} runs against the route (${ds.toFixed(1)} m of ${total.toFixed(0)})`);
      }
      // The sign over an apex points the way of the panel under it.
      for (const sign of routeSigns(world, barriers)) {
        if (closures.has(sign.rail)) continue;
        const dx = sign.flip * Math.cos(sign.yaw);
        const dz = -sign.flip * Math.sin(sign.yaw);
        let best = -1;
        let bestD = Infinity;
        for (const p of chain.get(sign.rail) ?? []) {
          const d = Math.hypot(layout.cx[p] - sign.x, layout.cz[p] - sign.z);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        expect(best).toBeGreaterThanOrEqual(0);
        const c = chevronDir(layout, flips, best);
        apexes++;
        if (c.x * dx + c.z * dz <= 0) expect.fail(`seed ${seed} ${kind}: corner rail ${sign.rail} sign and the panel under it point opposite ways`);
      }
    }
    // A floor on coverage, not a property: city changes move the count (188 once the expressway landed).
    expect(chains).toBeGreaterThan(150);
    expect(apexes).toBeGreaterThan(20);
  });
});
