/**
 * The cable car's line (city/districts/cableCar.ts) on screen: the track down the middle of its street, a
 * turntable set in the road at each terminal, the waiting shelters on the sidewalks (one on each wall of look
 * 'cableCar', the sim's solid), and the car itself (render/traffic/cableCar.ts), posed every frame at the sim
 * tick the session syncs (kit.simTick) with the bell the race rang (kit.cableBell).
 *
 * The track is paint and a thin rail: a band of granite setts the car's width, the dark cable slot down its middle
 * and two steel rail heads standing a couple of centimetres proud, draped on the terrain sample by sample so they
 * climb the hill with the road. The sim's road surface is untouched (a rail head this low is nothing to a tyre).
 * All of it goes into the kit's merged builders (paint, solid, glow): the line costs no draw call of its own
 * beyond the car's two, and nothing per frame but the car's pose and the bell's swing.
 */
import { CITY } from '../../city/config';
import type { Area } from '../../city/districts/types';
import { circlePolygon } from '../../city/districts/geom';
import { shelterFootprint } from '../../city/districts/cableCar';
import { cableLine, trackPoint } from '../../sim/cableCar';
import type { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import { createCableCarView } from '../traffic/cableCar';
import { ROAD_Y } from '../street/cityMeshes';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, orientedBox } from './kit';

const CFG = CITY.districts.cableCar;
/** The track's paint lies over the asphalt (cityMeshes ROAD_Y) and its markings (which it covers: the track takes the centreline). */
const paintY = (): number => ROAD_Y + 0.03;

const SETTS = col(0x77706a);
const SLOT = col(0x0b0b0c);
const RAIL = col(0xc4cad2, 1.2);
const RING = col(0x55585e);
const DECK = col(0x5a4330);
const BOARD = col(0x3e2e20);
const POST = col(0x2c3a33);
const PANEL = col(0x7d1f2c);
const ROOF = col(0x2a2624);
const BENCH = col(0x7a4a28);
const SIGN = col(0xffd890, 2.2);

/** A rail head 7 cm wide standing `top` m over the road along the polyline, `off` m to its left. */
function rail(kit: DistrictKit, gb: GeoBuilder, path: Vec2[], off: number, width: number, top: number): void {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    const at = (p: Vec2, o: number, y: number): [number, number, number] => {
      const x = p.x + nx * o;
      const z = p.z + nz * o;
      return [x, kit.h(x, z) + (y > 0 ? y : ROAD_Y), z];
    };
    const inner = off - width / 2;
    const outer = off + width / 2;
    // Top face, then the two sides down to the road.
    const quad = (p: [number, number, number][], n: [number, number, number]) => {
      const v = p.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], 0, 0, RAIL));
      gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
    };
    quad([at(a, inner, top), at(b, inner, top), at(b, outer, top), at(a, outer, top)], [0, 1, 0]);
    quad([at(a, outer, 0), at(b, outer, 0), at(b, outer, top), at(a, outer, top)], [nx, 0, nz]);
    quad([at(a, inner, 0), at(b, inner, 0), at(b, inner, top), at(a, inner, top)], [-nx, 0, -nz]);
  }
}

/** A terminal's turntable, flush in the road: the deck of boards in its steel ring, the track across it. */
function turntable(kit: DistrictKit, c: Vec2, yaw: number): void {
  const R = CFG.turntable;
  drapeConvex(kit, kit.paint, circlePolygon(c.x, c.z, R, 28), paintY(), DECK, 3);
  // The boards across the track, and the ring round the deck.
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  for (let k = -5; k <= 5; k++) {
    const t = (k / 6) * R;
    const half = Math.sqrt(Math.max(0, R * R - t * t)) - 0.15;
    const p = { x: c.x + fx * t, z: c.z + fz * t };
    groundLine(kit, kit.paint, { x: p.x - fz * half, z: p.z + fx * half }, { x: p.x + fz * half, z: p.z - fx * half }, 0.06, paintY() + 0.005, BOARD);
  }
  const ring = circlePolygon(c.x, c.z, R, 40);
  for (let i = 0; i < ring.length; i++) groundLine(kit, kit.paint, ring[i], ring[(i + 1) % ring.length], 0.22, paintY() + 0.008, RING);
}

/** The waiting shelter on its footprint (the sim's solid): posts, a back panel, a bench, the roof and its lit sign. */
function shelter(kit: DistrictKit, poly: Vec2[]): void {
  const [p0, p1, p2, p3] = poly;
  let y = Infinity;
  for (const p of poly) y = Math.min(y, kit.h(p.x, p.z));
  const base = y + CITY.curbHeight;
  const H = 2.6;
  // Corner posts.
  for (const p of poly) {
    const cx = p.x + ((p0.x + p2.x) / 2 - p.x) * 0.06;
    const cz = p.z + ((p0.z + p2.z) / 2 - p.z) * 0.06;
    cylinder(kit.solid, cx, cz, 0.05, base - 0.2, base + H, 6, POST);
  }
  // The back panel along the far side (p3 -> p2), a bench before it, the roof over all, the sign on the road side's eave.
  const ux = (p1.x - p0.x) / CFG.shelter.length;
  const uz = (p1.z - p0.z) / CFG.shelter.length;
  const wx = (p3.x - p0.x) / CFG.shelter.depth;
  const wz = (p3.z - p0.z) / CFG.shelter.depth;
  orientedBox(kit.solid, p3.x - wx * 0.08, p3.z - wz * 0.08, p2.x - wx * 0.08, p2.z - wz * 0.08, wx * 0.06, wz * 0.06, base + 0.3, base + H - 0.2, PANEL);
  orientedBox(kit.solid, p3.x - wx * 0.6 + ux * 0.5, p3.z - wz * 0.6 + uz * 0.5, p2.x - wx * 0.6 - ux * 0.5, p2.z - wz * 0.6 - uz * 0.5, wx * 0.42, wz * 0.42, base + 0.42, base + 0.5, BENCH);
  orientedBox(kit.solid, p0.x - wx * 0.15 - ux * 0.15, p0.z - wz * 0.15 - uz * 0.15, p1.x - wx * 0.15 + ux * 0.15, p1.z - wz * 0.15 + uz * 0.15, wx * (CFG.shelter.depth + 0.3), wz * (CFG.shelter.depth + 0.3), base + H, base + H + 0.12, ROOF);
  orientedBox(kit.glow, p0.x - wx * 0.17 + ux * 0.8, p0.z - wz * 0.17 + uz * 0.8, p1.x - wx * 0.17 - ux * 0.8, p1.z - wz * 0.17 - uz * 0.8, wx * 0.02, wz * 0.02, base + H - 0.32, base + H - 0.04, SIGN);
}

function build(kit: DistrictKit, areas: Area[]): void {
  const line = cableLine(kit.world);
  for (const a of areas) {
    const path = a.path;
    if (path.length < 2) continue;
    // The setts band, the slot and the rails, end to end.
    for (let i = 0; i + 1 < path.length; i++) {
      groundLine(kit, kit.paint, path[i], path[i + 1], CFG.gauge + 0.5, paintY(), SETTS);
      groundLine(kit, kit.paint, path[i], path[i + 1], CFG.slot, paintY() + 0.005, SLOT);
    }
    for (const side of [-1, 1]) rail(kit, kit.solid, path, (side * CFG.gauge) / 2, 0.07, paintY() + 0.025);
    // The turntables under the stops.
    if (line && line.area === a.id) {
      const at = { x: 0, z: 0, yaw: 0 };
      for (const s of [line.s0, line.s1]) {
        trackPoint(line, s, at);
        turntable(kit, at, at.yaw);
      }
    }
    for (const end of [0, 1] as const) shelter(kit, shelterFootprint(kit.world.graph, a, end));
  }
  if (!line) return;
  const car = createCableCarView(kit.world, line, kit.quality);
  kit.group.add(car.group);
  kit.track(car);
  kit.animate((time) => car.update(kit.simTick(time), kit.cableBell(), kit.audible()));
  kit.view(car.view);
}

export const cableCarRenderer: DistrictRenderer = { kinds: ['cableCar'], build };
