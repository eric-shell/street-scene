/**
 * Weekend special: the Rail Yard (src/city/weekend.ts, docs/weekend.md).
 *
 * A diesel classification yard filling its whole weekend region (weekendRegion.ts: two cells across, four to six
 * along, the spine dead straight from the entry to the exit). The spine is the yard throat road; round it six lines
 * run from the entry to the exit (railYardLayout.ts has the plan):
 *  1. the throat road (the spine): concrete along the lead under the signal gantries, wet steel plates where the
 *     crossovers cross it;
 *  2. The Tracks: the aisles between stopped consists on firm ballast, the fuelling pad's oil;
 *  3. The Hump: a 3 m crest at a 12% run-up throwing a car into the classification bowl, retarders and short cuts;
 *  4. The Overbridge: a works road 6 m over the whole yard (railYardBridge.ts), a missing parapet bay over the
 *     departure yard, its first ramp reached from the hump lead's kicker too;
 *  5. The Dock: the loading platform 1.1 m up, a hard edge onto the departure tracks, then the transfer pad under the
 *     gantry crane (the drift zone);
 *  6. The Turnaround: the banked road round the N side along the fence, past the diesel shop and the sand tower.
 * It is planned only on the seeds whose weekend pick is `railYard`; every other seed returns at once.
 *
 * Build: the region's quay underfoot (regionGround), the chain link fence on its ring (destructible panels between
 * solid posts, two mouths onto the turnaround road), every yard solid of look yardFence and every consist of look
 * railcar, their Wall.top set once the terrain exists (settleRailYard: the ground plus each solid's height, so a car
 * flying higher passes over and the overbridge's deck passes over the freight under it; the dock's face at half the
 * dock's height), the bridge's spans and walls, the height modifiers (hump, kicker, dock, banked corners), the surface
 * patches (concrete pads, the road, slick oil, grease, plates and the diesel spill), the clutter. The renderer reads
 * the same layout (yardLayout), not hints; the drift zone is the pad's 'apron' hint (sim/driftZones.ts).
 */
import { CITY } from '../config';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { Area, AreaBuild, DistrictModule } from './types';
import { emptyBuild } from './types';
import { solidWalls } from './geom';
import { carveRegion, planRegion, regionGround, regionOf } from './weekendRegion';
import type { WeekendShape } from './weekendRegion';
import { bankMod, reachOf } from './banking';
import { yardLayout } from './railYardLayout';
import { orientedBox } from './railYardFrame';
import { dockMod, wedgeLength, wedgeMod, wedgePoint } from './railYardShapes';
import { buildBridge, settleBridge } from './railYardBridge';

const C = CITY.districts.railYard;

/** Region shapes (weekendRegion.ts): two cells across, four to six along a straight spine the tracks run beside. */
export const RAIL_YARD_SHAPES: readonly WeekendShape[] = [
  { along: 4, across: 2 },
  { along: 5, across: 2 },
  { along: 6, across: 2 },
];

/** The yard's solids by build, with the height each one's walls take once the terrain exists. */
const pending = new WeakMap<AreaBuild, { walls: Wall[]; height: number; x: number; z: number; face?: { x: number; z: number } }[]>();

export const railYardModule: DistrictModule = {
  kind: 'railYard',
  phase: 'graph',
  carve(ctx) {
    if (!C.enabled || ctx.weekend?.kind !== 'railYard') return;
    carveRegion(ctx, { kind: 'railYard', shapes: RAIL_YARD_SHAPES, spineWidth: C.spineWidth, straight: true });
  },
  plan(ctx) {
    if (!C.enabled || ctx.weekend?.kind !== 'railYard') return;
    const r = planRegion(ctx, 'railYard');
    if (!r || !r.area.params.planned) return;
    // A region the layout cannot fill (the bridge needs its ramps and a diagonal between them): nothing built, nothing promised.
    const lay = yardLayout(r.area);
    if (!lay || lay.bridge.S < 2 * lay.bridge.R + 40) {
      r.area.params.planned = 0;
      r.area.params.special = 0;
    }
  },
  build(_ctx, area) {
    const b = emptyBuild();
    const r = regionOf(area);
    const lay = yardLayout(area);
    if (!r || !lay) return b;
    const id = area.id;
    regionGround(b, r, 'quay');
    const todo: { walls: Wall[]; height: number; x: number; z: number; face?: { x: number; z: number } }[] = [];
    pending.set(b, todo);
    // The fence: solid posts, chain link panels between them (destructible), the sidewalk outside the mouths kept clear.
    const P = C.fence.post / 2;
    for (const p of lay.posts) b.walls.push(...solidWalls([{ x: p.x - P, z: p.z - P }, { x: p.x + P, z: p.z - P }, { x: p.x + P, z: p.z + P }, { x: p.x - P, z: p.z + P }], 'yardFence', id));
    for (const pn of lay.panels) b.destructibles.push({ kind: 'fencePanel', x: pn.x, z: pn.z, yaw: pn.yaw, lift: 0, area: id });
    for (const m of lay.mouths) b.reserved.push({ x: m.x, z: m.z, r: C.fence.mouth / 2 + 2 });
    // The yard's solids and its freight.
    for (const s of lay.solids) {
      const walls = solidWalls(s.poly, 'yardFence', id);
      b.walls.push(...walls);
      const cx = s.poly.reduce((a, p) => a + p.x, 0) / s.poly.length;
      const cz = s.poly.reduce((a, p) => a + p.z, 0) / s.poly.length;
      if (s.kind === 'dockFace') {
        // The ground in front of the face (toward the tracks: +w), 1.5 m out.
        todo.push({ walls, height: C.dock.height * C.dock.topFrac, x: cx, z: cz, face: { x: cx + lay.f.wx * 1.6, z: cz + lay.f.wz * 1.6 } });
      } else if (Number.isFinite(s.height)) {
        todo.push({ walls, height: s.height, x: cx, z: cz });
      }
    }
    // Each car its own solid (a consist on the ground's roll gets each car's own Wall.top; the couplers' gaps are too narrow to drive).
    for (const cs of lay.consists) {
      for (const car of cs.cars) {
        const walls = solidWalls(orientedBox(car.c, car.ux, car.uz, car.len, C.cars.width), 'railcar', id);
        b.walls.push(...walls);
        todo.push({ walls, height: C.cars.height, x: car.c.x, z: car.c.z });
      }
    }
    buildBridge(lay.bridge, b, id);
    // Terrain: the hump, the kicker, the dock, the banked corners.
    b.heightMods.push(wedgeMod(lay.hump));
    if (lay.kicker) b.heightMods.push(wedgeMod(lay.kicker));
    if (lay.dock) b.heightMods.push(dockMod(lay.dock));
    for (const k of lay.banks) b.heightMods.push(bankMod(k));
    for (const p of lay.patches) b.surfaces.push({ surface: p.surface, polygon: p.poly, priority: p.priority, area: id });
    for (const j of lay.junk) b.destructibles.push({ kind: j.kind, x: j.x, z: j.z, yaw: j.yaw, lift: 0, area: id });
    // The drift zone: the transfer pad (sim/driftZones.ts reads the 'apron' hint).
    b.hints.push({ kind: 'apron', points: lay.pad, values: [] });
    return b;
  },
  lines(area) {
    return yardLayout(area)?.lines ?? [];
  },
};

/**
 * Give the yard's walls their heights once the terrain exists (createCity): the bridge's levels and walls
 * (railYardBridge.ts settleBridge), every solid's Wall.top at the ground under it plus its height (a car flying higher
 * passes over; the deck passes over the freight beneath it), the dock's face at the ground in front plus half the
 * dock's height (a car on the ground is stopped, a car up on the platform drops off it, settleAlleyLips' rule).
 */
export function settleRailYard(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  areas.forEach((a, i) => {
    if (a.kind !== 'railYard') return;
    const lay = yardLayout(a);
    if (!lay) return;
    const boxes: { minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
    for (const w of [lay.hump, ...(lay.kicker ? [lay.kicker] : [])]) {
      const L = wedgeLength(w);
      const B = w.half + w.edge;
      const pts = [wedgePoint(w, 0, -B), wedgePoint(w, L, -B), wedgePoint(w, L, B), wedgePoint(w, 0, B)];
      boxes.push({ minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minZ: Math.min(...pts.map((p) => p.z)), maxZ: Math.max(...pts.map((p) => p.z)) });
    }
    if (lay.dock) boxes.push(dockMod(lay.dock));
    for (const k of lay.banks) {
      const R = reachOf(k) + 0.5;
      boxes.push({ minX: k.cx - R, maxX: k.cx + R, minZ: k.cz - R, maxZ: k.cz + R });
    }
    const raised = (x: number, z: number) => boxes.some((q) => x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ);
    settleBridge(lay.bridge, builds[i], terrain, raised);
    for (const t of pending.get(builds[i]) ?? []) {
      const ground = t.face ? terrain.heightAt(t.face.x, t.face.z) : terrain.heightAt(t.x, t.z);
      for (const w of t.walls) w.top = ground + t.height;
    }
  });
}
