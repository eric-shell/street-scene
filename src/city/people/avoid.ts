/**
 * The ground the sidewalk people keep clear of, computed from the city alone. The render side knows these
 * zones from its own plans (the finish line's gates, `planMeets`, `planMarketCrowd`), but the people plan feeds
 * the sim and must not depend on the renderer, so each zone has a pure stand-in here: the gates from
 * `routeGates`; the street meets as a conservative strip, the ground up to MEET_DEPTH behind every closure
 * barrier and corner rail (`planMeets` fills exactly that ground, never further, whatever the quality); the
 * night market's pens from the district's pen hints, as `planMarketCrowd` reads them, split into short chunks so
 * a long pen does not blank a whole street. Reads World.
 */
import type { World } from '../world';
import type { IdleAvoid } from './idleSpots';
import type { PeopleGate } from './gates';
import { MARKET_HINT } from '../districts/market';
import { pointInPolygon } from '../districts/geom';
import { CORRIDOR_AREAS } from '../districts/types';
import { SpatialGrid } from '../spatial';

/** How far behind a barrier or rail the meet's ground reaches (m): MEET.maxDepth with room to spare. */
const MEET_DEPTH = 36;
/** And how far past the ends of the segment (m). */
const MEET_ALONG = 6;
/** Pen chunks are at most this long (m). */
const PEN_CHUNK = 10;

/** The zones people keep out of, in the shape the idle and walk planners take. */
export function peopleAvoid(world: World, gates: readonly PeopleGate[]): IdleAvoid {
  const pens: { x: number; z: number }[][] = [];
  for (const area of world.areas) {
    if (area.kind !== 'market') continue;
    for (const h of world.districts.builds[area.id]?.hints ?? []) {
      if (h.kind !== MARKET_HINT.pen) continue;
      const [r0, r1, o1, o0] = h.points;
      const len = Math.hypot(r1.x - r0.x, r1.z - r0.z);
      const n = Math.max(1, Math.ceil(len / PEN_CHUNK));
      for (let k = 0; k < n; k++) {
        const a = k / n;
        const b = (k + 1) / n;
        const at = (p: { x: number; z: number }, q: { x: number; z: number }, f: number) => ({ x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f });
        pens.push([at(r0, r1, a), at(r0, r1, b), at(o0, o1, a), at(o0, o1, b)]);
      }
    }
  }

  // The meets' ground: behind each closure barrier and corner rail piece.
  const bounds = world.graph.bounds;
  const grid = SpatialGrid.forBounds(bounds.minX - 100, bounds.minZ - 100, bounds.maxX + 100, bounds.maxZ + 100, 48);
  const walls: { ax: number; az: number; ux: number; uz: number; nx: number; nz: number; len: number }[] = [];
  for (const w of world.walls) {
    if (w.kind === 'wall') continue;
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (len < 1e-6) continue;
    const id = walls.length;
    walls.push({ ax: w.ax, az: w.az, ux: (w.bx - w.ax) / len, uz: (w.bz - w.az) / len, nx: w.nx, nz: w.nz, len });
    grid.insertSegment(id, w.ax, w.az, w.bx, w.bz, MEET_DEPTH + MEET_ALONG);
  }
  const near: number[] = [];
  const blocked = (x: number, z: number): boolean => {
    if (!walls.length) return false;
    grid.query(x, z, x, z, near);
    for (const id of near) {
      const w = walls[id];
      const dx = x - w.ax;
      const dz = z - w.az;
      const u = dx * w.ux + dz * w.uz;
      if (u < -MEET_ALONG || u > w.len + MEET_ALONG) continue;
      // Behind: on the side opposite the wall's normal (toward the road).
      const depth = -(dx * w.nx + dz * w.nz);
      if (depth >= 0 && depth <= MEET_DEPTH) return true;
    }
    return false;
  };
  // A weekend special is a race through a works site, a yard or a scrapyard: nobody strolls its region (districts/weekendRegion.ts).
  const trenches = world.areas.filter((a) => CORRIDOR_AREAS.has(a.kind) && a.polygon.length >= 3);
  const shut = trenches.length ? (x: number, z: number): boolean => blocked(x, z) || trenches.some((a) => pointInPolygon(x, z, a.polygon)) : blocked;
  return { gates, markets: pens, blocked: shut };
}
