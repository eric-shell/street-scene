/**
 * Infill renderer: parking lots (asphalt, painted bays), plazas, corner
 * pockets and verges (concrete at sidewalk level, verges a warmer paver),
 * alley bays (the alley's cobbles, their tapered walls the yard walls of the
 * frontage), raised planters, fountains, low curbs around lots, and the low
 * 'boundary' walls that close every other gap in the street frontage
 * (boundaryWalls.ts: in the neighbourhood's finish, with piers and lanterns). The clutter in
 * the pockets is destructible and drawn by render/street/props.ts; this only lays a
 * mulch bed under the greenery (it stays when a bush is ploughed through).
 * Lantern posts are props too; their light is render/street/areaLights.ts.
 *
 * A raised planter is a stone box with a coping round its top and shrubs in
 * its soil; a plaza's fountain is the city's one fountain (kit.ts
 * fountainBasin, the roundabout plaza's); a parking lot has its pay kiosk and
 * a lit P behind its back curb, where no car reaches. All of it merges into
 * the kit's builders.
 */
import { CITY } from '../../city/config';
import type { Wall } from '../../city/blocks';
import { insideBuilding } from '../../city/blocks';
import { insetRing, pointInPolygon, polygonCentroid } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, fountainBasin, groundLine, orientedBox, prism, wallBox } from './kit';
import { boundaryWalls } from './boundaryWalls';
import { cityWallClearance } from './hillLookout';

const PLANTER = { height: 0.7, coping: 0.22, side: col(0x67635d), cope: col(0x8e8a82), soil: col(0x2b1e15), shrubStep: 1.15, shrubs: 48 } as const;
const SHRUB = [col(0x2f5a2c), col(0x3b6a33), col(0x29502e), col(0x466f35)];
const KIOSK = { body: col(0x3a3c44), roof: col(0x24252a), glass: col(0xffd9a0, 0.55), sign: col(0x2a6cff, 1.3), white: col(0xf2f4f8, 1.4), pole: col(0x6a6e76) } as const;

/** A position hash in [0, 1) (render only: the same city draws the same shrubs). */
function hash(x: number, z: number, k: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

/** A raised planter: stone sides, a coping round the top, soil, shrubs in a jittered grid. */
function planter(kit: DistrictKit, poly: Vec2[]): void {
  prism(kit, kit.solid, poly, PLANTER.height, PLANTER.side, PLANTER.soil);
  let hi = -Infinity;
  for (const p of poly) hi = Math.max(hi, kit.h(p.x, p.z));
  const top = hi + PLANTER.height;
  const c = polygonCentroid(poly);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) continue;
    let nx = -(b.z - a.z) / len;
    let nz = (b.x - a.x) / len;
    if ((c.x - a.x) * nx + (c.z - a.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    orientedBox(kit.solid, a.x, a.z, b.x, b.z, nx * PLANTER.coping, nz * PLANTER.coping, top - 0.02, top + 0.07, PLANTER.cope);
  }
  const bed = insetRing(poly, PLANTER.coping + 0.35);
  if (!bed || bed.length < 3) return;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of bed) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  let n = 0;
  for (let x = minX; x <= maxX && n < PLANTER.shrubs; x += PLANTER.shrubStep) {
    for (let z = minZ; z <= maxZ && n < PLANTER.shrubs; z += PLANTER.shrubStep) {
      const px = x + (hash(x, z, 1) - 0.5) * 0.6;
      const pz = z + (hash(x, z, 2) - 0.5) * 0.6;
      if (!pointInPolygon(px, pz, bed)) continue;
      const r = 0.38 + hash(px, pz, 3) * 0.3;
      const h = 0.45 + hash(px, pz, 4) * 0.5;
      const green = SHRUB[Math.floor(hash(px, pz, 5) * SHRUB.length)];
      cylinder(kit.foliage, px, pz, r, top - 0.02, top + h * 0.6, 7, green, false, r * 1.1);
      cylinder(kit.foliage, px, pz, r * 1.1, top + h * 0.6, top + h, 7, green, true, r * 0.45);
      n++;
    }
  }
}

/** A parking lot's pay kiosk and its lit P sign, behind the middle of its longest back curb (facing the lot), where free. */
function lotKiosk(kit: DistrictKit, edges: readonly Wall[]): void {
  const w = edges.reduce<Wall | null>((best, e) => (!best || Math.hypot(e.bx - e.ax, e.bz - e.az) > Math.hypot(best.bx - best.ax, best.bz - best.az) ? e : best), null);
  if (!w || Math.hypot(w.bx - w.ax, w.bz - w.az) < 4) return;
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  const tx = (w.bx - w.ax) / len;
  const tz = (w.bz - w.az) / len;
  // Behind the curb (the wall's back, away from its normal), out of the buildings and clear of every other wall.
  const back = 1.0;
  const x = (w.ax + w.bx) / 2 - w.nx * back;
  const z = (w.az + w.bz) / 2 - w.nz * back;
  const world = kit.world;
  const a = world.areaAt(x, z);
  if (a && a.kind !== 'downtown' && a.kind !== 'hills') return;
  if (world.blocks.buildings.some((b) => Math.abs(b.x - x) < 40 && Math.abs(b.z - z) < 40 && insideBuilding(b, x, z, 0.9))) return;
  if (cityWallClearance(world)(x, z, 3) < back - 0.1) return;
  const y = kit.h(x, z);
  const hw = 0.6;
  const hd = 0.45;
  const ax = x - tx * hw - w.nx * hd;
  const az = z - tz * hw - w.nz * hd;
  const bx = x + tx * hw - w.nx * hd;
  const bz = z + tz * hw - w.nz * hd;
  orientedBox(kit.solid, ax, az, bx, bz, w.nx * 2 * hd, w.nz * 2 * hd, y - 0.2, y + 2.2, KIOSK.body);
  orientedBox(kit.solid, ax - tx * 0.15 - w.nx * 0.1, az - tz * 0.15 - w.nz * 0.1, bx + tx * 0.15 - w.nx * 0.1, bz + tz * 0.15 - w.nz * 0.1, w.nx * (2 * hd + 0.35), w.nz * (2 * hd + 0.35), y + 2.2, y + 2.35, KIOSK.roof);
  // Its window toward the lot, lit.
  const fx = x + w.nx * (hd + 0.02);
  const fz = z + w.nz * (hd + 0.02);
  orientedBox(kit.glow, fx - tx * (hw - 0.12), fz - tz * (hw - 0.12), fx + tx * (hw - 0.12), fz + tz * (hw - 0.12), w.nx * 0.02, w.nz * 0.02, y + 1.05, y + 1.9, KIOSK.glass);
  // The P on a pole at the kiosk's side: a blue panel facing the lot, the letter in white bars.
  const px = x + tx * (hw + 0.7);
  const pz = z + tz * (hw + 0.7);
  cylinder(kit.solid, px, pz, 0.06, y - 0.2, y + 3.4, 6, KIOSK.pole, false);
  const sx = px + w.nx * 0.08;
  const sz = pz + w.nz * 0.08;
  const panel = (u0: number, u1: number, v0: number, v1: number, c: typeof KIOSK.sign, off: number) =>
    orientedBox(kit.glow, sx + tx * u0 + w.nx * off, sz + tz * u0 + w.nz * off, sx + tx * u1 + w.nx * off, sz + tz * u1 + w.nz * off, w.nx * 0.03, w.nz * 0.03, y + v0, y + v1, c);
  panel(-0.35, 0.35, 3.4, 4.1, KIOSK.sign, 0);
  // Read from the lot (facing along the curb's normal), the stem stands on the panel's -t side.
  panel(0.06, 0.16, 3.52, 3.98, KIOSK.white, 0.04);
  panel(-0.14, 0.16, 3.88, 3.98, KIOSK.white, 0.04);
  panel(-0.14, 0.16, 3.7, 3.79, KIOSK.white, 0.04);
  panel(-0.16, -0.06, 3.7, 3.98, KIOSK.white, 0.04);
}

export const infillRenderer: DistrictRenderer = {
  kinds: ['infill'],
  build(kit, areas) {
    const asphalt = col(0x2a2c33);
    const concrete = col(0x6d6f78);
    const pavers = col(0x76706a);
    const cobbles = col(0x4d4a4c);
    const mulch = col(0x24170f);
    const paint = col(0xd8dce6, 0.8);
    for (const a of areas) {
      const b = kit.builds[a.id];
      if (a.variant === 'lot') {
        drapeConvex(kit, kit.ground, a.polygon, 0.03, asphalt);
        for (const h of b.hints) if (h.kind === 'bay') groundLine(kit, kit.paint, h.points[0], h.points[1], 0.12, 0.05, paint);
      } else if (a.variant === 'plaza' || a.variant === 'cornerPlaza' || a.variant === 'verge') {
        drapeConvex(kit, kit.ground, a.polygon, CITY.curbHeight, a.variant === 'verge' ? pavers : concrete);
      } else if (a.variant === 'alleyBay') {
        drapeConvex(kit, kit.ground, a.polygon, CITY.curbHeight, cobbles);
      } else if (a.variant === 'planter') {
        planter(kit, a.polygon);
      }
      if (a.variant === 'lot') lotKiosk(kit, (kit.walls.get('lotEdge') ?? []).filter((w) => w.area === a.id));
      for (const d of b.destructibles) {
        if (d.kind !== 'bush' && d.kind !== 'planterPot') continue;
        const y = kit.h(d.x, d.z) + d.lift;
        cylinder(kit.ground, d.x, d.z, d.kind === 'bush' ? 1 : 0.7, y - 0.02, y + 0.015, 8, mulch);
      }
      for (const p of b.props) if (p.kind === 'fountain') fountainBasin(kit, p.x, p.z, p.size, p.height);
    }
    boundaryWalls(kit, kit.walls.get('boundary') ?? []);
    for (const w of kit.walls.get('lotEdge') ?? []) wallBox(kit, kit.solid, w, 0.4, 0.45, col(0x5a5c66));
  },
};
