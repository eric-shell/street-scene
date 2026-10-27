/**
 * Parking lots: open-air lots of a third of a block to the whole block, flat asphalt with painted bays in
 * rows, a ticket booth between the entrance and the exit, lamps, tree islands, dumpsters and cart corrals
 * at the back, a fence round the street and back edges and curb cuts to drive in and out by, and rows
 * of parked cars (sim bodies, city/parking.ts) that are the hazard. One to three blocks per seed; the sites,
 * the shape and the cuts are planned in parkingLot/plan.ts and the inside is laid out by
 * parkingLot/layout.ts, a pure function of the area that the sim, this build, the renderer
 * (render/districts/parkingLot.ts) and the tests all read.
 *
 * Drivable. The lot's frontage opens (the block's frontage wall is removed along it, the fence closes it
 * again but for the cuts), its asphalt is a road surface patch (road grip, no curb), and the cuts are curb
 * cuts in the street's own curb frame (a 'mouth' bay, the park paths' kind: the whole sidewalk deep, flared
 * returns), so a car drives in at road level. It is an open area, not a route shortcut: planned lots touch
 * neither route (plan.ts), so no racing line runs through one and no pass is registered; the way
 * through a block corner is there for anyone who sees it (a free roam driver, a drag or waypoint racer
 * who picks it), and the forecourt behind the entrance is a drift zone (sim/driftZones.ts).
 *
 * Collision. The fence is solid on both sides (Wall.solid, look 'lotFence': a car inside the lot is never
 * shoved out through it), as are the booth island and the cart corrals ('lotKiosk') and the tree trunks
 * ('tree'); the bays are not walled, their cars are bodies. Nothing leaves the lot but through a cut, and
 * the block behind a strip keeps its buildings clear of the back fence (exclusion, backClear).
 */
import { PARKING_LOT as C } from '../config';
import { MOUTH_REACH, bayHi, bayInset, bayLo, bayPoint, mouthBay } from '../busBays';
import { circlePolygon, clipConvex, solidWalls } from './geom';
import type { Vec2 } from '../../sim/math';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';
import { lotCuts, lotFrame, lotLayout, lotPoint } from './parkingLot/layout';
import { planParkingLots } from './parkingLot/plan';

export { lotCuts, lotLayout, lotZone } from './parkingLot/layout';
export type { LotCut, LotLayout } from './parkingLot/layout';

/** Surface patch priorities: the asphalt above the sidewalk (3, so no curb lift) and the planted islands over it. */
const ASPHALT_PRIORITY = 4;
const ISLAND_PRIORITY = 5;

export const parkingLotModule: DistrictModule = {
  kind: 'parkingLot',
  phase: 'graph',
  plan(ctx) {
    planParkingLots(ctx);
  },
  build(ctx, area) {
    const b = emptyBuild();
    const id = area.id;
    const L = lotLayout(area);
    const F = C.fence.thickness;
    const face = ctx.faces.find((f) => f.id === area.params.face);
    // Buildings stay out of the lot and, behind a strip's back fence, backClear further.
    if (face && area.params.strip > 0) {
      const o = { x: area.params.fox, z: area.params.foz };
      const w = { x: area.params.fwx, z: area.params.fwz };
      const e = { x: o.x + w.x * (area.params.depth + C.backClear), z: o.z + w.z * (area.params.depth + C.backClear) };
      b.exclusions.push(clipConvex(face.ring, e, { x: e.x + area.params.fux, z: e.z + area.params.fuz }, 1));
    } else b.exclusions.push(area.polygon);
    b.openings.push(area.polygon);
    b.surfaces.push({ surface: 'road', polygon: area.polygon, priority: ASPHALT_PRIORITY, area: id });

    // The fence: solid thin bodies along the edges, the cuts left open.
    for (const p of L.fences) {
      const quad: Vec2[] = [
        { x: p.ax, z: p.az },
        { x: p.bx, z: p.bz },
        { x: p.bx + p.nx * F, z: p.bz + p.nz * F },
        { x: p.ax + p.nx * F, z: p.az + p.nz * F },
      ];
      b.walls.push(...solidWalls(quad, 'lotFence', id));
    }
    if (L.booth) b.walls.push(...solidWalls(L.booth.island, 'lotKiosk', id));
    for (const c of L.corrals) b.walls.push(...solidWalls(c.poly, 'lotKiosk', id));

    // Tree islands: a planted patch (grass underfoot) with a solid trunk.
    const frame = lotFrame(area);
    for (const isl of L.islands) {
      const r = isl.rect;
      const poly = [lotPoint(frame, r.u0, r.w0), lotPoint(frame, r.u1, r.w0), lotPoint(frame, r.u1, r.w1), lotPoint(frame, r.u0, r.w1)];
      b.surfaces.push({ surface: 'grass', polygon: poly, priority: ISLAND_PRIORITY, area: id });
      b.walls.push(...solidWalls(circlePolygon(isl.x, isl.z, C.trunkRadius, 6), 'tree', id));
      const hash = Math.imul(Math.round(isl.x * 16), 2654435761) ^ Math.imul(Math.round(isl.z * 16), 40503);
      b.props.push({ kind: 'tree', x: isl.x, z: isl.z, yaw: (hash >>> 0) % 628 / 100, size: 2.3 + ((hash >>> 8) % 100) / 100, height: 5.5 + ((hash >>> 16) % 100) / 40, area: id });
    }
    for (const l of L.lamps) b.destructibles.push({ kind: 'parkLamp', x: l.x, z: l.z, yaw: 0, lift: 0, area: id });
    for (const d of L.dumpsters) b.destructibles.push({ kind: 'dumpster', x: d.x, z: d.z, yaw: d.yaw, lift: 0, area: id });
    for (const t of L.bags) b.destructibles.push({ kind: 'trashBags', x: t.x, z: t.z, yaw: t.yaw, lift: 0, area: id });

    // The curb cuts: the street's curb steps back the whole sidewalk (a 'mouth' bay), street furniture and bus bays keep off.
    for (const c of lotCuts(area)) {
      const bay = mouthBay(ctx.graph, ctx.mouths, -1, c.road, c.side, c.s0, c.s1, c.taper);
      const depth = bay.depth - MOUTH_REACH;
      const lo = bayLo(bay);
      const hi = bayHi(bay);
      b.hints.push({ kind: 'mouth', points: bay.polygon, values: [c.road, c.side, c.s0, c.s1, c.taper] });
      for (let s = lo; s <= hi + 1e-6; s += 2) for (const v of [0.6, depth / 2, depth - 0.6]) if (v < bayInset(bay, s) + 0.6) b.reserved.push({ ...bayPoint(bay, s, v), r: 1.2 });
    }
    return b;
  },
};
