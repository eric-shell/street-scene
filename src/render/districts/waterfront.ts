/**
 * Waterfront renderer (city/districts/waterfront.ts): the harbor along one
 * side of the map, built from the area's params (waterfrontShape.ts: the
 * coast line, the water level) and its build's walls, props and hints, so
 * what is drawn is what the sim collides with:
 *  - the quay: concrete pavers at sidewalk level from the frontage out to the
 *    sea wall, a yellow safety line along the edge, and past an open end of the
 *    side the render only quay of a container terminal running on into the fog;
 *  - the sea wall: its face from the coping down under the water, rubber
 *    fenders on it, mooring bollards on the coping, and the galvanized railing
 *    (the sim's 'quayRail') with a striped gate wherever a jetty meets it;
 *  - the security fences closing the quay's ends ('quayFence'), the race
 *    night barriers closing it off along its frontage in a race ('quayGate'),
 *    and the warehouse sheds in the frontage's recesses ('warehouse': their
 *    frontage and back walls, a flat roof, lit windows and a roller door);
 *  - the water: one opaque dark mirror (the river's water look) from the sea
 *    wall out past the far ridge of the backdrop (render/sky/backdrop.ts sinks
 *    its near ridge on this side, so the water meets a low far shore), and the
 *    reflections of every light standing out on it as camera facing streaks
 *    (lightFx.ts's shader): crane floods, jetty masts, ships, buoys, beacons;
 *  - jetties on piles with their flood masts, gantry cranes astride their rails
 *    (red aircraft warning lights on the apex and boom tip), container stacks,
 *    moored ships (hull, deck cargo, a lit bridge house, running lights), the
 *    breakwater's rubble mole with a flashing beacon, channel buoys.
 * The quay's lanterns and dock clutter are destructible props (render/street/props.ts,
 * their light render/street/areaLights.ts).
 *
 * Meshes: the kit's shared builders plus three of its own: the water, the
 * streaks (additive) and the flashers (a tiny shader blinking every warning
 * light and buoy on the scene clock, each at its own phase). No per frame work
 * but one uniform; the streaks and the cranes' bracing are left out on Low.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Wall } from '../../city/blocks';
import type { World } from '../../city/world';
import type { Area, AreaHint, AreaProp } from '../../city/districts/types';
import { ringProfile } from '../../city/districts/waterfront';
import { type HarborFrame, coastNormal, coastV, framePoint, frameU, frameV, harborFrame, waterLevel } from '../../city/districts/waterfrontShape';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { streakFrag, streakVert } from '../street/lightFx';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundLine, groundVertex, prism, wallBox } from './kit';

/** The wall looks this renderer draws (every wall the waterfront district builds carries one). */
export const WATERFRONT_LOOKS = ['quayRail', 'quayFence', 'warehouse', 'quayGate'] as const;

const CFG = CITY.districts.waterfront;

/** Sizes (m) and tints of the dressing. */
const LOOK = {
  paver: col(0x6a6660),
  paverAlt: col(0x5f5b56),
  safety: col(0xd8b030, 0.85),
  wallTop: col(0x4a4b50),
  wallFoot: col(0x18201c),
  coping: col(0x8d8a84),
  fender: col(0x141416),
  bollard: col(0x1c1d20),
  rail: col(0x9aa0a8),
  gateRed: col(0xb02a22),
  gateWhite: col(0xd8d8d0),
  fence: col(0x2c3036),
  fencePost: col(0x6c7078),
  gatePanel: col(0x6a7078),
  gateBand: col(0x3ad6e8, 0.9),
  shedWall: [col(0x5a3a30), col(0x34465a), col(0x4a4e44)],
  shedRoof: col(0x3e4448),
  door: col(0x8a8c80),
  window: col(0xffd28a, 1.6),
  water: col(0x0b1220),
  waterNear: col(0x0d1626),
  deck: col(0x585a5c),
  pile: col(0x2a2826),
  crane: [col(0xb8402e), col(0x2f6aa8), col(0xc89a2a)],
  craneDark: col(0x2a2c30),
  cab: col(0xd8d8d0),
  rock: col(0x3a3836),
  rockLight: col(0x4c4946),
  beaconTower: col(0xd8d8d0),
  container: [0x8a2a1e, 0x1f4f8a, 0x2a6a3a, 0xb06a1a, 0x7a7c80, 0xc8c8c0, 0x6a1a5a, 0xa88a2a, 0x1e6a70].map((c) => col(c)),
  hullLow: col(0x6a1e1a),
  hullHigh: col(0x16181c),
  shipDeck: col(0x3a3c3e),
  house: col(0xd0d0c8),
  funnel: col(0x8a2420),
  sodium: col(0xffb24a, 1.5),
  flood: col(0xfff0d0, 1.7),
  navRed: col(0xff2a1a, 2),
  navGreen: col(0x2aff6a, 2),
  masthead: col(0xffffff, 1.8),
  /** Railing posts every `postStep` m, its rails at these heights; bollards every `bollardStep` m along the coping; fenders every `fenderStep` m on the face. */
  postStep: 2.2,
  railHeights: [0.55, 1.1],
  bollardStep: 14,
  fenderStep: 11,
  /** The quay's render only run on past an open end reaches this far further than its furnished stretch (m). */
  runOnPave: 120,
  /** The water reaches this far out from the coast and past an open end (m): beyond the backdrop's far ridge. */
  waterOut: 3200,
  /** A crane's portal: half its width along the rails (m), and its clearance as a share of its height. */
  portalHalf: 7,
  portalShare: 0.42,
  /** Containers (m). */
  box: { l: 12.2, w: 2.44, h: 2.59 },
} as const;

/** A light standing over the water, for its reflection streak: where, its colour, the streak's width (m). */
interface Reflect {
  x: number;
  y: number;
  z: number;
  c: THREE.Color;
  w: number;
}

/**
 * The backdrop's sea window (render/sky/backdrop.ts BackdropOptions.sea): the directions from the city's
 * centre in which the harbor's open water lies far out (past the near ridge's radius), and its level;
 * null for a city without one.
 */
export function harborSea(world: World): { from: number; to: number; level: number } | null {
  const a = world.areas.find((x) => x.kind === 'waterfront');
  if (!a) return null;
  const p = a.params;
  const f = harborFrame(a);
  const b = world.graph.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const N = 360;
  const wet: boolean[] = [];
  for (let k = 0; k < N; k++) {
    const t = (k / N) * Math.PI * 2;
    const x = cx + Math.cos(t) * 1800;
    const z = cz + Math.sin(t) * 1800;
    const u = frameU(f, x, z);
    wet.push(frameV(f, x, z) > coastV(p, u) + 50 && (p.openA === 1 || u > p.pa) && (p.openB === 1 || u < p.pb));
  }
  const dry = wet.indexOf(false);
  if (dry < 0 || !wet.includes(true)) return null;
  // The wet run, walking round from a dry direction (it may wrap past angle 0).
  let from = -1;
  let to = -1;
  for (let i = 1; i <= N; i++) {
    const k = (dry + i) % N;
    if (wet[k] && from < 0) from = k;
    if (wet[k]) to = k;
    else if (from >= 0) break;
  }
  return { from: (from / N) * Math.PI * 2, to: (to / N) * Math.PI * 2, level: waterLevel(p, (p.pa + p.pb) / 2) };
}

export const waterfrontRenderer: DistrictRenderer = {
  kinds: ['waterfront'],
  build(kit, areas) {
    for (const a of areas) buildHarbor(kit, a);
  },
};

function buildHarbor(kit: DistrictKit, a: Area): void {
  const p = a.params;
  const f = harborFrame(a);
  const b = kit.builds[a.id];
  const rng = new Rng((p.seed ^ 0x5eaf00d) >>> 0 || 1);
  const curb = CITY.curbHeight;
  const at = (u: number, v: number) => framePoint(f, u, v);
  const coast = (u: number) => coastV(p, u);
  /** The quay's top at u (pavers at sidewalk level), from the ground just in from the wall's edge. */
  const quayTop = (u: number) => {
    const q = at(u, coast(u) - 0.3);
    return kit.h(q.x, q.z) + curb;
  };
  const outer = kit.world.blocks.faces.find((x) => x.outer);
  const prof = outer ? ringProfile(outer.ring, f) : null;
  const flash = new GeoBuilder(true);
  const reflects: Reflect[] = [];
  const low = kit.quality === 'low';
  const jetties = b.hints.filter((h) => h.kind === 'jetty');
  /** The deck a prop stands on: a jetty's (over the water), else the quay's paving. */
  const deckY = (x: number, z: number): number => {
    for (const j of jetties) if (onJetty(j, x, z, 0.5)) return jettyTop(kit, a, j);
    return kit.h(x, z) + curb;
  };

  // ----- The quay's pavers, column by column from the frontage to the wall (Area.polygon's back chain is the frontage).
  const back = a.polygon.slice(0, p.nBack);
  pave(kit, f, back.map((q) => frameU(f, q.x, q.z)), (_u, i) => frameV(f, back[i].x, back[i].z), coast);
  // Past an open end the quay runs on, render only: out to the fog, as deep as the warehouse line (never into the corner).
  for (const [open, u0, u1] of [
    [p.openA, p.pa - CFG.quayRun - LOOK.runOnPave, p.pa - 0.3],
    [p.openB, p.pb + 0.3, p.pb + CFG.quayRun + LOOK.runOnPave],
  ] as const) {
    if (!open) continue;
    const us: number[] = [];
    for (let u = u0; u < u1; u += 4) us.push(u);
    us.push(u1);
    pave(kit, f, us, (u) => Math.max(coast(u) - CFG.maxDepth, (prof?.at(u) ?? -Infinity) + 0.5), coast);
  }
  // A yellow safety line along the edge, inside the railing.
  const lineA = p.openA ? p.pa - CFG.quayRun - LOOK.runOnPave : p.pa;
  const lineB = p.openB ? p.pb + CFG.quayRun + LOOK.runOnPave : p.pb;
  for (let u = lineA; u < lineB; u += 4) {
    const u1 = Math.min(lineB, u + 4);
    groundLine(kit, kit.paint, at(u, coast(u) - 1.15), at(u1, coast(u1) - 1.15), 0.14, curb + 0.012, LOOK.safety);
  }

  // ----- The sea wall: its face down under the water, the coping, fenders and bollards.
  const faceA = p.openA ? lineA : p.pa - CFG.mole / 2;
  const faceB = p.openB ? lineB : p.pb + CFG.mole / 2;
  const gateAt = (u: number, pad: number) => jetties.some((j) => Math.abs(frameU(f, j.points[0].x, j.points[0].z) - u) < j.values[0] / 2 + pad);
  {
    let prev: [number, number] | null = null;
    for (let u = faceA; u <= faceB + 1e-6; u += 3) {
      const uu = Math.min(u, faceB);
      const n = coastNormal(p, uu);
      const q = at(uu, coast(uu));
      const top = quayTop(uu);
      const bot = waterLevel(p, uu) - 2.5;
      const v0 = kit.solid.vertex(q.x, top, q.z, n.nx, 0, n.nz, 0, 0, LOOK.wallTop);
      const v1 = kit.solid.vertex(q.x, bot, q.z, n.nx, 0, n.nz, 0, 1, LOOK.wallFoot);
      if (prev) kit.solid.quadFacing(prev[0], v0, v1, prev[1], n.nx, 0, n.nz);
      prev = [v0, v1];
    }
    for (let u = faceA; u < faceB; u += 4) {
      const u1 = Math.min(faceB, u + 4);
      const a0 = at(u, coast(u) + 0.08);
      const a1 = at(u1, coast(u1) + 0.08);
      const n = coastNormal(p, u);
      solidBox(kit.solid, a0, a1, -n.nx * 0.7, -n.nz * 0.7, quayTop(u) - 0.05, quayTop(u) + 0.12, LOOK.coping);
    }
    for (let u = faceA + 5; u < faceB - 3; u += LOOK.fenderStep) {
      if (gateAt(u, 1)) continue;
      const n = coastNormal(p, u);
      const q = at(u, coast(u) + 0.25);
      const top = quayTop(u) - 0.35;
      boxAt(kit.solid, q.x, waterLevel(p, u) + 0.2, q.z, -n.nz, n.nx, 0.45, 0.22, top - waterLevel(p, u) - 0.2, LOOK.fender);
    }
    for (let u = faceA + 7; u < faceB - 3; u += LOOK.bollardStep) {
      if (gateAt(u, 2)) continue;
      const q = at(u, coast(u) - 0.28);
      const y = quayTop(u);
      cylinder(kit.solid, q.x, q.z, 0.2, y - 0.05, y + 0.55, 8, LOOK.bollard);
      cylinder(kit.solid, q.x, q.z, 0.3, y + 0.55, y + 0.68, 8, LOOK.bollard);
    }
  }

  // ----- The railing (the sim's quayRail walls), a striped gate across every jetty's root.
  for (const w of kit.walls.get('quayRail') ?? []) {
    if (w.area !== a.id) continue;
    railing(kit, w, (u) => gateAt(u, 0.5), f);
  }
  // ----- The fences at the quay's ends.
  for (const w of kit.walls.get('quayFence') ?? []) {
    if (w.area !== a.id) continue;
    fence(kit, w);
  }
  // ----- In a race, the barriers closing the quay off along its frontage (one per solid piece).
  const gates = new Set<Wall['solid']>();
  for (const w of kit.walls.get('quayGate') ?? []) {
    if (w.area !== a.id || !w.solid || gates.has(w.solid)) continue;
    gates.add(w.solid);
    gate(kit, w.solid.faces.map((q) => ({ x: q.ax, z: q.az })));
  }
  // ----- Warehouses in the recesses.
  for (const h of b.hints) if (h.kind === 'warehouse') shed(kit, a, h, f, rng);

  // ----- The water, out past the far ridge.
  {
    const water = new GeoBuilder(true);
    const u0 = p.openA ? p.pa - LOOK.waterOut : p.pa - CFG.mole / 2;
    const u1 = p.openB ? p.pb + LOOK.waterOut : p.pb + CFG.mole / 2;
    const us: number[] = [];
    // Fine along the coast's curves where the quay is, coarse along the flat run on.
    for (let u = u0; u < u1; u += u > p.pa - 300 && u < p.pb + 300 ? 6 : 60) us.push(u);
    us.push(u1);
    const rows = [0, 3, 40, 400, LOOK.waterOut];
    const ids = us.map((u) =>
      rows.map((r) => {
        const q = at(u, coast(u) + r);
        return water.vertex(q.x, waterLevel(p, u), q.z, 0, 1, 0, 0, 0, r < 4 ? LOOK.waterNear : LOOK.water);
      }),
    );
    for (let i = 0; i + 1 < us.length; i++) for (let k = 0; k + 1 < rows.length; k++) water.quadFacing(ids[i][k], ids[i + 1][k], ids[i + 1][k + 1], ids[i][k + 1], 0, 1, 0);
    // The river's dark mirror, opaque here: there is nothing to see under it but the seabed.
    const mesh = new THREE.Mesh(kit.track(water.build()), kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.95, envMapIntensity: 2.4 })));
    mesh.name = 'harborWater';
    mesh.frustumCulled = false;
    kit.group.add(mesh);
  }

  // ----- Jetties, cranes, containers, ships, breakwaters, buoys.
  for (const j of jetties) jetty(kit, a, j, reflects);
  for (const pr of b.props) {
    if (pr.kind === 'crane') crane(kit, pr, deckY(pr.x, pr.z), flash, reflects, low);
    else if (pr.kind === 'stack') stack(kit, pr, deckY(pr.x, pr.z));
    else if (pr.kind === 'ship') ship(kit, a, pr, reflects);
    else if (pr.kind === 'buoy') buoy(kit, a, pr, flash, reflects);
  }
  for (const h of b.hints) if (h.kind === 'mole') mole(kit, a, h, flash, reflects);

  // ----- The flashers: every warning light and buoy blinking on the scene clock, each at its own phase.
  if (flash.vertexCount) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      uniforms: { time: { value: 0 }, fogDensity: { value: 0.005 }, fogColor: { value: new THREE.Color(0x000000) } },
      vertexColors: true,
    });
    const mesh = new THREE.Mesh(kit.track(flash.build()), kit.track(mat));
    mesh.name = 'harborFlashers';
    mesh.frustumCulled = false;
    kit.group.add(mesh);
    kit.animate((time) => {
      mat.uniforms.time.value = time;
    });
  }
  // ----- The reflections of everything lit out on the water.
  if (!low && reflects.length) kit.group.add(streaks(kit, a, reflects));
}

/** Is (x, z) on jetty `j`'s deck (grown by `pad` m)? */
function onJetty(j: AreaHint, x: number, z: number, pad: number): boolean {
  const [r, t] = j.points;
  const len = Math.hypot(t.x - r.x, t.z - r.z);
  const dx = (t.x - r.x) / len;
  const dz = (t.z - r.z) / len;
  const s = (x - r.x) * dx + (z - r.z) * dz;
  const o = -(x - r.x) * dz + (z - r.z) * dx;
  return s > -pad && s < len + pad && Math.abs(o) < j.values[0] / 2 + pad;
}

/** A jetty's deck top: level with the quay at its root. */
function jettyTop(kit: DistrictKit, a: Area, j: AreaHint): number {
  const r = j.points[0];
  const n = coastNormal(a.params, frameU(harborFrame(a), r.x, r.z));
  return kit.h(r.x - n.nx * 0.6, r.z - n.nz * 0.6) + CITY.curbHeight;
}

/**
 * Pavers over columns at `us` (ascending), each from `inner(u, i)` out to the coast (just short of the wall's
 * edge), rows of at most 5 m, draped on the terrain at sidewalk level in alternating bands.
 */
function pave(kit: DistrictKit, f: HarborFrame, us: readonly number[], inner: (u: number, i: number) => number, coast: (u: number) => number): void {
  const ROWS = Math.ceil((CFG.maxDepth + 20) / 5);
  let prev: number[] | null = null;
  let prevU = 0;
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    const v1 = coast(u) - 0.02;
    const v0 = Math.min(inner(u, i), v1);
    const tint = Math.floor(u / 6) % 2 ? LOOK.paver : LOOK.paverAlt;
    const cur: number[] = [];
    for (let k = 0; k <= ROWS; k++) {
      const v = v0 + ((v1 - v0) * k) / ROWS;
      const q = framePoint(f, u, v);
      cur.push(groundVertex(kit, kit.ground, q.x, q.z, CITY.curbHeight, tint));
    }
    if (prev && u - prevU > 1e-4) for (let k = 0; k < ROWS; k++) kit.ground.quadFacing(prev[k], cur[k], cur[k + 1], prev[k + 1], 0, 1, 0);
    prev = cur;
    prevU = u;
  }
}

/**
 * A box with all six faces: centred on (x, z) from y0 up `h`, `hl` m each way along the unit (fx, fz) and
 * `hw` m across it.
 */
function boxAt(gb: GeoBuilder, x: number, y0: number, z: number, fx: number, fz: number, hl: number, hw: number, h: number, c: THREE.Color): void {
  const rx = fz;
  const rz = -fx;
  const p = (sl: number, sw: number): [number, number] => [x + fx * sl * hl + rx * sw * hw, z + fz * sl * hl + rz * sw * hw];
  const corners = [p(-1, -1), p(1, -1), p(1, 1), p(-1, 1)];
  const y1 = y0 + h;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % 4];
    let nx = bz - az;
    let nz = -(bx - ax);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((ax + bx) / 2 - x) * nx + ((az + bz) / 2 - z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const v0 = gb.vertex(ax, y0, az, nx, 0, nz, 0, 0, c);
    const v1 = gb.vertex(bx, y0, bz, nx, 0, nz, 1, 0, c);
    const v2 = gb.vertex(bx, y1, bz, nx, 0, nz, 1, 1, c);
    const v3 = gb.vertex(ax, y1, az, nx, 0, nz, 0, 1, c);
    gb.quadFacing(v0, v1, v2, v3, nx, 0, nz);
  }
  const top = corners.map(([cx, cz]) => gb.vertex(cx, y1, cz, 0, 1, 0, 0, 0, c));
  gb.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
  const bot = corners.map(([cx, cz]) => gb.vertex(cx, y0, cz, 0, -1, 0, 0, 0, c));
  gb.quadFacing(bot[0], bot[1], bot[2], bot[3], 0, -1, 0);
}

/** A box with one long face on a-b and depth along (ox, oz), from y0 to y1, all six faces. */
function solidBox(gb: GeoBuilder, a: Vec2, b: Vec2, ox: number, oz: number, y0: number, y1: number, c: THREE.Color): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const d = Math.hypot(ox, oz);
  if (len < 1e-3 || d < 1e-3) return;
  boxAt(gb, (a.x + b.x) / 2 + ox / 2, y0, (a.z + b.z) / 2 + oz / 2, (b.x - a.x) / len, (b.z - a.z) / len, len / 2, d / 2, y1 - y0, c);
}

/** A square beam of half thickness r between two points (struts, stays, bracing). */
function beam(gb: GeoBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, c: THREE.Color): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-3) return;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  // Two axes square to the beam.
  let px = -uz;
  let py = 0;
  let pz = ux;
  let pl = Math.hypot(px, pz);
  if (pl < 1e-3) {
    px = 1;
    pz = 0;
    pl = 1;
  }
  px /= pl;
  pz /= pl;
  const qx = uy * pz - uz * py;
  const qy = uz * px - ux * pz;
  const qz = ux * py - uy * px;
  const offs: [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  const ring = (cx: number, cy: number, cz: number) => offs.map(([s, t]) => [cx + (px * s + qx * t) * r, cy + (py * s + qy * t) * r, cz + (pz * s + qz * t) * r]);
  const A = ring(ax, ay, az);
  const B = ring(bx, by, bz);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const [s0, t0] = offs[i];
    const [s1, t1] = offs[j];
    const nx = px * (s0 + s1) + qx * (t0 + t1);
    const ny = py * (s0 + s1) + qy * (t0 + t1);
    const nz = pz * (s0 + s1) + qz * (t0 + t1);
    const v0 = gb.vertex(A[i][0], A[i][1], A[i][2], nx, ny, nz, 0, 0, c);
    const v1 = gb.vertex(A[j][0], A[j][1], A[j][2], nx, ny, nz, 1, 0, c);
    const v2 = gb.vertex(B[j][0], B[j][1], B[j][2], nx, ny, nz, 1, 1, c);
    const v3 = gb.vertex(B[i][0], B[i][1], B[i][2], nx, ny, nz, 0, 1, c);
    gb.quadFacing(v0, v1, v2, v3, nx, ny, nz);
  }
}

/** A small glowing square (a lamp, a window light) facing (nx, nz), or a cube of glow when no facing is given. */
function lamp(gb: GeoBuilder, x: number, y: number, z: number, s: number, c: THREE.Color, uvx = 0, uvy = 0): void {
  const h = s / 2;
  const faces: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
    [0, -1, 0],
  ];
  for (const [nx, ny, nz] of faces) {
    // Two axes in the face's plane.
    const ax: [number, number, number] = ny ? [1, 0, 0] : [-nz, 0, nx];
    const bx: [number, number, number] = ny ? [0, 0, 1] : [0, 1, 0];
    const cx = x + nx * h;
    const cy = y + ny * h;
    const cz = z + nz * h;
    const v = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([s0, t0]) => gb.vertex(cx + (ax[0] * s0 + bx[0] * t0) * h, cy + (ax[1] * s0 + bx[1] * t0) * h, cz + (ax[2] * s0 + bx[2] * t0) * h, nx, ny, nz, uvx, uvy, c));
    gb.quadFacing(v[0], v[1], v[2], v[3], nx, ny, nz);
  }
}

/** The railing along one quayRail wall: posts and two rails, a striped bar and heavier posts across a jetty's gate. */
function railing(kit: DistrictKit, w: Wall, gate: (u: number) => boolean, f: HarborFrame): void {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (len < 0.05) return;
  const dx = (w.bx - w.ax) / len;
  const dz = (w.bz - w.az) / len;
  const n = Math.max(1, Math.round(len / LOOK.postStep));
  const h = (x: number, z: number) => kit.h(x, z) + CITY.curbHeight;
  for (let i = 0; i <= n; i++) {
    const x = w.ax + dx * (len * i) / n;
    const z = w.az + dz * (len * i) / n;
    const g = gate(frameU(f, x, z));
    const y = h(x, z);
    boxAt(kit.solid, x, y - 0.05, z, dx, dz, g ? 0.09 : 0.04, g ? 0.09 : 0.04, (g ? 1.25 : 1.15) + 0.05, g ? LOOK.gateWhite : LOOK.rail);
  }
  // The rails, a segment per post gap; across a gate a thick bar banded red and white.
  for (let i = 0; i < n; i++) {
    const x0 = w.ax + dx * (len * i) / n;
    const z0 = w.az + dz * (len * i) / n;
    const x1 = w.ax + dx * (len * (i + 1)) / n;
    const z1 = w.az + dz * (len * (i + 1)) / n;
    const g = gate(frameU(f, (x0 + x1) / 2, (z0 + z1) / 2));
    const y0 = h(x0, z0);
    const y1 = h(x1, z1);
    if (g) {
      beam(kit.solid, x0, y0 + 1.0, z0, x1, y1 + 1.0, z1, 0.07, i % 2 ? LOOK.gateRed : LOOK.gateWhite);
      beam(kit.solid, x0, y0 + 0.5, z0, x1, y1 + 0.5, z1, 0.05, i % 2 ? LOOK.gateWhite : LOOK.gateRed);
      continue;
    }
    for (const r of LOOK.railHeights) beam(kit.solid, x0, y0 + r, z0, x1, y1 + r, z1, r > 1 ? 0.035 : 0.025, LOOK.rail);
  }
}

/** A security fence along one quayFence wall: posts, rails, a dark mesh panel and a yellow sign. */
function fence(kit: DistrictKit, w: Wall): void {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (len < 0.05) return;
  const dx = (w.bx - w.ax) / len;
  const dz = (w.bz - w.az) / len;
  const n = Math.max(1, Math.round(len / 2.5));
  const h = (x: number, z: number) => kit.h(x, z) + CITY.curbHeight;
  for (let i = 0; i <= n; i++) {
    const x = w.ax + dx * (len * i) / n;
    const z = w.az + dz * (len * i) / n;
    boxAt(kit.solid, x, h(x, z) - 0.05, z, dx, dz, 0.05, 0.05, 2.5, LOOK.fencePost);
  }
  // The mesh: a thin dark panel just behind the line, from a hand off the ground to the top rail.
  for (let i = 0; i < n; i++) {
    const a0 = { x: w.ax + dx * (len * i) / n, z: w.az + dz * (len * i) / n };
    const a1 = { x: w.ax + dx * (len * (i + 1)) / n, z: w.az + dz * (len * (i + 1)) / n };
    const y = Math.min(h(a0.x, a0.z), h(a1.x, a1.z));
    solidBox(kit.solid, a0, a1, -w.nx * 0.03, -w.nz * 0.03, y + 0.08, y + 2.35, LOOK.fence);
    beam(kit.solid, a0.x, h(a0.x, a0.z) + 2.4, a0.z, a1.x, h(a1.x, a1.z) + 2.4, a1.z, 0.03, LOOK.fencePost);
  }
  const m = { x: (w.ax + w.bx) / 2 + w.nx * 0.06, z: (w.az + w.bz) / 2 + w.nz * 0.06 };
  solidBox(kit.solid, { x: m.x - dx * 0.6, z: m.z - dz * 0.6 }, { x: m.x + dx * 0.6, z: m.z + dz * 0.6 }, w.nx * 0.03, w.nz * 0.03, h(m.x, m.z) + 1.1, h(m.x, m.z) + 1.9, LOOK.safety);
}

/** A race night barrier piece on its solid's outline: a galvanized panel with a cyan reflective band along the top (the closures' colour). */
function gate(kit: DistrictKit, poly: Vec2[]): void {
  prism(kit, kit.solid, poly, 1.05, LOOK.gatePanel, LOOK.rail, 0.05);
  let y = -Infinity;
  for (const q of poly) y = Math.max(y, kit.h(q.x, q.z));
  // The band: along the street side (the piece's first edge, on the frontage), just under the top.
  const [p0, p1, p2] = poly;
  const len = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
  const ox = ((p2.x - p1.x) / Math.hypot(p2.x - p1.x, p2.z - p1.z)) * -0.02;
  const oz = ((p2.z - p1.z) / Math.hypot(p2.x - p1.x, p2.z - p1.z)) * -0.02;
  if (len > 0.3) solidBox(kit.glow, { x: p0.x + ox, z: p0.z + oz }, { x: p1.x + ox, z: p1.z + oz }, ox, oz, y + CITY.curbHeight + 0.82, y + CITY.curbHeight + 0.94, LOOK.gateBand);
}

/** A warehouse shed: its walls on the sim's warehouse walls up to a flat roof over its outline, lit windows and a door to the quay. */
function shed(kit: DistrictKit, a: Area, h: AreaHint, f: HarborFrame, rng: Rng): void {
  const poly = h.points;
  const [height, nInner] = h.values;
  let base = -Infinity;
  for (const q of poly) base = Math.max(base, kit.h(q.x, q.z));
  const roof = base + height;
  const tint = LOOK.shedWall[rng.int(0, LOOK.shedWall.length - 1)];
  // Its walls: the frontage and back walls that stand on its outline.
  const near = (w: Wall) => {
    const mx = (w.ax + w.bx) / 2 - w.nx * 0.6;
    const mz = (w.az + w.bz) / 2 - w.nz * 0.6;
    return pointIn(mx, mz, poly);
  };
  const backWalls: Wall[] = [];
  for (const w of kit.walls.get('warehouse') ?? []) {
    if (w.area !== a.id || !near(w)) continue;
    wallBox(kit, kit.solid, w, 0.4, height, tint, -0.4, roof);
    if (w.nx * a.params.vx + w.nz * a.params.vz > 0.5) backWalls.push(w);
  }
  // The roof: the outline's two chains zipped at the roof's height.
  const inner = poly.slice(0, nInner);
  const edge = [poly[nInner - 1], ...poly.slice(nInner), poly[0]].reverse();
  const lo = inner.map((q) => kit.solid.vertex(q.x, roof, q.z, 0, 1, 0, 0, 0, LOOK.shedRoof));
  const hi = edge.map((q) => kit.solid.vertex(q.x, roof, q.z, 0, 1, 0, 0, 0, LOOK.shedRoof));
  zip(
    inner.map((q) => frameU(f, q.x, q.z)),
    edge.map((q) => frameU(f, q.x, q.z)),
    (i0, i1, j) => kit.solid.triFacing(lo[i0], lo[i1], hi[j], 0, 1, 0),
    (j0, j1, i) => kit.solid.triFacing(hi[j0], hi[j1], lo[i], 0, 1, 0),
  );
  // Facing the quay: a row of lit clerestory windows, a roller door and a lamp over it.
  for (const w of backWalls) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const dx = (w.bx - w.ax) / len;
    const dz = (w.bz - w.az) / len;
    for (let s = 1.5; s < len - 1; s += 3) {
      if (!rng.chance(0.55)) continue;
      const x = w.ax + dx * s + w.nx * 0.05;
      const z = w.az + dz * s + w.nz * 0.05;
      solidBox(kit.glow, { x: x - dx * 0.7, z: z - dz * 0.7 }, { x: x + dx * 0.7, z: z + dz * 0.7 }, w.nx * 0.02, w.nz * 0.02, roof - 2.4, roof - 1.4, LOOK.window);
    }
  }
  const door = backWalls[Math.floor(backWalls.length / 2)];
  if (door) {
    const len = Math.hypot(door.bx - door.ax, door.bz - door.az);
    const dx = (door.bx - door.ax) / len;
    const dz = (door.bz - door.az) / len;
    const m = { x: (door.ax + door.bx) / 2 + door.nx * 0.04, z: (door.az + door.bz) / 2 + door.nz * 0.04 };
    const y = kit.h(m.x, m.z);
    solidBox(kit.solid, { x: m.x - dx * 2.5, z: m.z - dz * 2.5 }, { x: m.x + dx * 2.5, z: m.z + dz * 2.5 }, door.nx * 0.05, door.nz * 0.05, y, y + 4.6, LOOK.door);
    lamp(kit.glow, m.x + door.nx * 0.3, y + 5.3, m.z + door.nz * 0.3, 0.35, LOOK.sodium);
  }
}

/** Point in polygon (even-odd), for the shed's walls. */
function pointIn(x: number, z: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Triangles between two chains ascending in u (their first points and their last points level): `lower` emits a
 * triangle advancing the first chain from i0 to i1 against point j of the second, `upper` the other way.
 */
function zip(a: readonly number[], b: readonly number[], lower: (i0: number, i1: number, j: number) => void, upper: (j0: number, j1: number, i: number) => void): void {
  let i = 0;
  let j = 0;
  while (i < a.length - 1 || j < b.length - 1) {
    const ua = i < a.length - 1 ? a[i + 1] : Infinity;
    const ub = j < b.length - 1 ? b[j + 1] : Infinity;
    if (ua <= ub) {
      lower(i, i + 1, j);
      i++;
    } else {
      upper(j, j + 1, i);
      j++;
    }
  }
}

/** A jetty on piles out from the sea wall, level with the quay, with crane rails, fenders and flood masts at its corners. */
function jetty(kit: DistrictKit, a: Area, j: AreaHint, reflects: Reflect[]): void {
  const [r, t] = j.points;
  const w = j.values[0];
  const len = Math.hypot(t.x - r.x, t.z - r.z);
  const fx = (t.x - r.x) / len;
  const fz = (t.z - r.z) / len;
  const top = jettyTop(kit, a, j);
  const water = waterLevel(a.params, frameU(harborFrame(a), r.x, r.z));
  const c = { x: (r.x + t.x) / 2, z: (r.z + t.z) / 2 };
  boxAt(kit.solid, c.x, top - 1.3, c.z, fx, fz, len / 2, w / 2, 1.3, LOOK.deck);
  // Piles in rows across, every 9 m out.
  for (let s = 4; s < len; s += 9) {
    for (const o of [-w / 2 + 1, 0, w / 2 - 1]) {
      const x = r.x + fx * s + fz * o;
      const z = r.z + fz * s - fx * o;
      cylinder(kit.solid, x, z, 0.4, water - 3, top - 1.3, 6, LOOK.pile, false);
    }
  }
  // Crane rails down its length, and a dark band of fenders along both edges.
  for (const o of [-CFG.craneGauge / 2, CFG.craneGauge / 2]) {
    if (Math.abs(o) > w / 2 - 0.5) continue;
    const a0 = { x: r.x + fz * o, z: r.z - fx * o };
    groundLineAt(kit.paint, a0, { x: a0.x + fx * len, z: a0.z + fz * len }, 0.25, top + 0.02, LOOK.craneDark);
  }
  for (const o of [-1, 1]) {
    const a0 = { x: r.x + fz * o * (w / 2), z: r.z - fx * o * (w / 2) };
    solidBox(kit.solid, a0, { x: a0.x + fx * len, z: a0.z + fz * len }, fz * o * 0.35, -fx * o * 0.35, water + 0.3, top - 0.4, LOOK.fender);
  }
  // Flood masts at the tip's corners and halfway back.
  for (const [s, o] of [
    [len - 3, w / 2 - 1.2],
    [len - 3, -w / 2 + 1.2],
    [len * 0.45, w / 2 - 1.2],
  ]) {
    const x = r.x + fx * s + fz * o;
    const z = r.z + fz * s - fx * o;
    cylinder(kit.solid, x, z, 0.18, top, top + 18, 6, LOOK.fencePost);
    lamp(kit.glow, x, top + 18.2, z, 0.9, LOOK.flood);
    reflects.push({ x, y: top + 18.2, z, c: LOOK.flood.clone().multiplyScalar(0.45), w: 2.2 });
  }
}

/** groundLine at an absolute height (on a jetty's deck, not the terrain). */
function groundLineAt(gb: GeoBuilder, a: Vec2, b: Vec2, width: number, y: number, c: THREE.Color): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 0.05) return;
  const nx = (-(b.z - a.z) / len) * (width / 2);
  const nz = ((b.x - a.x) / len) * (width / 2);
  const v = [gb.vertex(a.x + nx, y, a.z + nz, 0, 1, 0, 0, 0, c), gb.vertex(b.x + nx, y, b.z + nz, 0, 1, 0, 0, 0, c), gb.vertex(b.x - nx, y, b.z - nz, 0, 1, 0, 0, 0, c), gb.vertex(a.x - nx, y, a.z - nz, 0, 1, 0, 0, 0, c)];
  gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
}

/**
 * A flasher light into the flashers' builder: a glowing cube whose uv carries its blink (uv.x: phase in
 * the fraction, the share of the period it is lit in tenths in the whole part; uv.y: the period, s).
 */
function flasher(gb: GeoBuilder, x: number, y: number, z: number, s: number, c: THREE.Color, period: number, duty: number, phase: number): void {
  lamp(gb, x, y, z, s, c, Math.round(duty * 10) + (phase % 1), period);
}

/**
 * A ship to shore gantry crane (prop: its portal's centre, the boom's heading as yaw, half its rail gauge
 * as size, the apex's height as height): four legs on the rails, the portal frame and bracing, the boom
 * out over the water with its backreach and machinery house, the A frame and stays, the cab, floods under
 * the portal and red warning lights on the apex and the boom's tip.
 */
function crane(kit: DistrictKit, pr: AreaProp, y0: number, flash: GeoBuilder, reflects: Reflect[], low: boolean): void {
  const fx = Math.sin(pr.yaw);
  const fz = Math.cos(pr.yaw);
  const rx = fz;
  const rz = -fx;
  const g = pr.size;
  const H = pr.height;
  const P = LOOK.portalHalf;
  const portal = y0 + H * LOOK.portalShare;
  const boomY = portal + 5;
  const tint = LOOK.crane[Math.abs(Math.round(pr.x * 7 + pr.z * 13)) % LOOK.crane.length];
  const pt = (s: number, o: number): Vec2 => ({ x: pr.x + fx * s + rx * o, z: pr.z + fz * s + rz * o });
  // Legs, the sill beams on each rail and the portal beams across.
  for (const s of [-g, g]) {
    for (const o of [-P, P]) {
      const q = pt(s, o);
      boxAt(kit.solid, q.x, y0, q.z, fx, fz, 0.6, 0.6, portal - y0, tint);
      boxAt(kit.solid, q.x, y0, q.z, rx, rz, 1.1, 0.8, 1.2, LOOK.craneDark);
    }
    const a0 = pt(s, -P);
    const a1 = pt(s, P);
    beam(kit.solid, a0.x, portal - 0.8, a0.z, a1.x, portal - 0.8, a1.z, 0.7, tint);
  }
  for (const o of [-P, P]) {
    const a0 = pt(-g, o);
    const a1 = pt(g, o);
    beam(kit.solid, a0.x, portal - 0.8, a0.z, a1.x, portal - 0.8, a1.z, 0.6, tint);
    if (!low) {
      beam(kit.solid, a0.x, y0 + 4, a0.z, a1.x, portal - 2, a1.z, 0.25, tint);
      beam(kit.solid, a1.x, y0 + 4, a1.z, a0.x, portal - 2, a0.z, 0.25, tint);
    }
  }
  // The boom: out past the waterside rail over the water, back past the landside one.
  const reachOut = g + 46;
  const reachBack = g + 22;
  const b0 = pt(-reachBack, 0);
  const b1 = pt(reachOut, 0);
  beam(kit.solid, b0.x, boomY, b0.z, b1.x, boomY, b1.z, 1.3, tint);
  // Machinery house on the backreach, the cab hung under the boom by the waterside legs.
  const mh = pt(-reachBack + 7, 0);
  boxAt(kit.solid, mh.x, boomY + 1.3, mh.z, fx, fz, 6, 3, 4, LOOK.cab);
  const cab = pt(g + 2, 0);
  boxAt(kit.solid, cab.x, boomY - 4.4, cab.z, fx, fz, 1.5, 1.4, 3, LOOK.cab);
  lamp(kit.glow, cab.x + fx * 1.55, boomY - 2.9, cab.z + fz * 1.55, 0.9, LOOK.window);
  // The A frame over the landside rail and the stays to the boom's ends.
  const apex = pt(-g * 0.6, 0);
  for (const o of [-P + 1, P - 1]) {
    const q = pt(-g, o);
    beam(kit.solid, q.x, portal, q.z, apex.x, y0 + H, apex.z, 0.45, tint);
  }
  beam(kit.solid, apex.x, y0 + H, apex.z, b1.x, boomY + 1.3, b1.z, 0.14, LOOK.craneDark);
  beam(kit.solid, apex.x, y0 + H, apex.z, pt(g * 0.6, 0).x, boomY + 1.3, pt(g * 0.6, 0).z, 0.14, LOOK.craneDark);
  beam(kit.solid, apex.x, y0 + H, apex.z, b0.x, boomY + 1.3, b0.z, 0.14, LOOK.craneDark);
  // Floods under the portal (lighting the berth) and the warning lights.
  for (const o of [-P + 1, P - 1]) {
    const q = pt(g, o);
    lamp(kit.glow, q.x, portal - 2, q.z, 0.8, LOOK.flood);
    reflects.push({ x: q.x, y: portal - 2, z: q.z, c: LOOK.flood.clone().multiplyScalar(0.55), w: 2.6 });
  }
  const phase = (pr.x * 0.013 + pr.z * 0.007) % 1;
  flasher(flash, apex.x, y0 + H + 0.6, apex.z, 0.8, LOOK.navRed, 1.6, 0.55, Math.abs(phase));
  flasher(flash, b1.x, boomY + 1.8, b1.z, 0.7, LOOK.navRed, 1.6, 0.55, Math.abs(phase));
  reflects.push({ x: b1.x, y: boomY + 1.8, z: b1.z, c: LOOK.navRed.clone().multiplyScalar(0.25), w: 1.6 });
}

/** A container stack (prop: its centre, the boxes' long axis as yaw, tiers as height): three rows side by side, their own heights. */
function stack(kit: DistrictKit, pr: AreaProp, y0: number): void {
  const fx = Math.sin(pr.yaw);
  const fz = Math.cos(pr.yaw);
  const B = LOOK.box;
  const seed = Math.abs(Math.round(pr.x * 31 + pr.z * 17));
  for (let row = -1; row <= 1; row++) {
    const tiers = Math.max(1, Math.min(4, pr.height - ((seed + row * 5) % 2)));
    const x = pr.x + fz * row * (B.w + 0.12);
    const z = pr.z - fx * row * (B.w + 0.12);
    for (let k = 0; k < tiers; k++) {
      const c = LOOK.container[(seed + row * 7 + k * 3) % LOOK.container.length];
      boxAt(kit.solid, x, y0 + k * B.h, z, fx, fz, B.l / 2, B.w / 2, B.h - 0.04, c);
    }
  }
}

/**
 * A moored ship (prop: its centre, the bow's heading as yaw, half its length as size, its beam as height):
 * the hull in two bands from under the waterline, the deck, rows of containers, the bridge house aft with
 * lit windows, the funnel, masthead and running lights, floods along the deck.
 */
function ship(kit: DistrictKit, a: Area, pr: AreaProp, reflects: Reflect[]): void {
  const L = pr.size;
  const B = pr.height / 2;
  const fx = Math.sin(pr.yaw);
  const fz = Math.cos(pr.yaw);
  const rx = fz;
  const rz = -fx;
  const W = waterLevel(a.params, frameU(harborFrame(a), pr.x, pr.z));
  const deck = W + 6;
  const pt = (s: number, o: number): Vec2 => ({ x: pr.x + fx * s + rx * o, z: pr.z + fz * s + rz * o });
  // The hull's outline: square stern, straight sides, a pointed bow over the last fifth.
  const outline: Vec2[] = [pt(-L, -B), pt(L * 0.62, -B), pt(L * 0.9, -B * 0.55), pt(L, 0), pt(L * 0.9, B * 0.55), pt(L * 0.62, B), pt(-L, B)];
  const band = (y0: number, y1: number, c: THREE.Color) => {
    for (let i = 0; i < outline.length; i++) {
      const p0 = outline[i];
      const p1 = outline[(i + 1) % outline.length];
      let nx = p1.z - p0.z;
      let nz = -(p1.x - p0.x);
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      if (((p0.x + p1.x) / 2 - pr.x) * nx + ((p0.z + p1.z) / 2 - pr.z) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const v = [kit.solid.vertex(p0.x, y0, p0.z, nx, 0, nz, 0, 0, c), kit.solid.vertex(p1.x, y0, p1.z, nx, 0, nz, 1, 0, c), kit.solid.vertex(p1.x, y1, p1.z, nx, 0, nz, 1, 1, c), kit.solid.vertex(p0.x, y1, p0.z, nx, 0, nz, 0, 1, c)];
      kit.solid.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
    }
  };
  band(W - 3, W + 1.4, LOOK.hullLow);
  band(W + 1.4, deck, LOOK.hullHigh);
  const centre = kit.solid.vertex(pr.x, deck, pr.z, 0, 1, 0, 0, 0, LOOK.shipDeck);
  const ring = outline.map((q) => kit.solid.vertex(q.x, deck, q.z, 0, 1, 0, 0, 0, LOOK.shipDeck));
  for (let i = 0; i < ring.length; i++) kit.solid.triFacing(centre, ring[i], ring[(i + 1) % ring.length], 0, 1, 0);
  // Cargo: bays of containers from the house forward to the bow's taper.
  const box = LOOK.box;
  const cols = Math.max(2, Math.floor((2 * B - 2) / (box.w + 0.1)));
  let k = Math.abs(Math.round(pr.x * 3 + pr.z * 5));
  for (let s = -L + 26; s < L * 0.6 - box.l / 2; s += box.l + 1) {
    for (let c = 0; c < cols; c++) {
      const o = -((cols - 1) * (box.w + 0.1)) / 2 + c * (box.w + 0.1);
      const q = pt(s + box.l / 2, o);
      const tiers = 2 + ((k += 7) % 3);
      for (let t = 0; t < tiers; t++) boxAt(kit.solid, q.x, deck + t * box.h, q.z, fx, fz, box.l / 2, box.w / 2, box.h - 0.04, LOOK.container[(k + t * 5) % LOOK.container.length]);
    }
  }
  // The bridge house aft, its windows lit, the funnel behind it, a mast on top.
  const house = pt(-L + 10, 0);
  boxAt(kit.solid, house.x, deck, house.z, fx, fz, 7, B * 0.85, 16, LOOK.house);
  for (let fl = 0; fl < 5; fl++) {
    for (let o = -B * 0.7; o <= B * 0.7; o += 2.4) {
      if ((fl * 7 + Math.round(o * 3)) % 3 === 0) continue;
      const q = pt(-L + 17.05, o);
      lamp(kit.glow, q.x, deck + 3 + fl * 2.6, q.z, 0.55, LOOK.window);
    }
  }
  const funnel = pt(-L + 3.5, 0);
  boxAt(kit.solid, funnel.x, deck + 16, funnel.z, fx, fz, 2, 1.6, 6, LOOK.funnel);
  const mast = pt(-L + 12, 0);
  cylinder(kit.solid, mast.x, mast.z, 0.15, deck + 16, deck + 22, 6, LOOK.craneDark);
  lamp(kit.glow, mast.x, deck + 22.3, mast.z, 0.45, LOOK.masthead);
  const fore = pt(L * 0.85, 0);
  lamp(kit.glow, fore.x, deck + 8, fore.z, 0.4, LOOK.masthead);
  // Port red, starboard green on the bridge wings.
  const port = pt(-L + 14, -B * 0.95);
  const stbd = pt(-L + 14, B * 0.95);
  lamp(kit.glow, port.x, deck + 14, port.z, 0.5, LOOK.navRed);
  lamp(kit.glow, stbd.x, deck + 14, stbd.z, 0.5, LOOK.navGreen);
  reflects.push({ x: house.x, y: deck + 10, z: house.z, c: LOOK.window.clone().multiplyScalar(0.35), w: 5 });
  reflects.push({ x: port.x, y: deck + 14, z: port.z, c: LOOK.navRed.clone().multiplyScalar(0.25), w: 1.2 });
  reflects.push({ x: stbd.x, y: deck + 14, z: stbd.z, c: LOOK.navGreen.clone().multiplyScalar(0.25), w: 1.2 });
  // Deck floods along both sides.
  for (let s = -L + 30; s < L * 0.6; s += 26) {
    for (const o of [-B, B]) {
      const q = pt(s, o);
      lamp(kit.glow, q.x, deck + 1.2, q.z, 0.4, LOOK.sodium);
      reflects.push({ x: q.x, y: deck + 1.2, z: q.z, c: LOOK.sodium.clone().multiplyScalar(0.3), w: 1.4 });
    }
  }
}

/** A channel buoy (prop size 0 red, 1 green; height its blink's phase): a can on the water with a light on top. */
function buoy(kit: DistrictKit, a: Area, pr: AreaProp, flash: GeoBuilder, reflects: Reflect[]): void {
  const W = waterLevel(a.params, frameU(harborFrame(a), pr.x, pr.z));
  const green = pr.size === 1;
  const body = green ? col(0x1a6a2a) : col(0xa02018);
  cylinder(kit.solid, pr.x, pr.z, 0.9, W - 0.6, W + 1.2, 10, body, true, 0.7);
  cylinder(kit.solid, pr.x, pr.z, 0.12, W + 1.2, W + 2.4, 5, LOOK.craneDark);
  const c = green ? LOOK.navGreen : LOOK.navRed;
  flasher(flash, pr.x, W + 2.6, pr.z, 0.45, c, 4, 0.2, pr.height);
  reflects.push({ x: pr.x, y: W + 2.6, z: pr.z, c: c.clone().multiplyScalar(0.18), w: 1 });
}

/** A rubble mole out from the sea wall (hint: root and tip, its width), ragged on top, a beacon tower at its tip. */
function mole(kit: DistrictKit, a: Area, h: AreaHint, flash: GeoBuilder, reflects: Reflect[]): void {
  const [r, t] = h.points;
  const width = h.values[0];
  const len = Math.hypot(t.x - r.x, t.z - r.z);
  const fx = (t.x - r.x) / len;
  const fz = (t.z - r.z) / len;
  const rx = fz;
  const rz = -fx;
  const W = waterLevel(a.params, frameU(harborFrame(a), r.x, r.z));
  const rng = new Rng((Math.round(r.x * 13 + r.z * 7) >>> 0) || 1);
  const topY = W + 2.4;
  const bed = W - a.params.depth - 0.5;
  const prof = [
    [-width / 2, bed],
    [-width * 0.18, topY],
    [width * 0.18, topY],
    [width / 2, bed],
  ];
  let prev: number[] | null = null;
  for (let s = 0; s <= len + 1e-6; s += 5) {
    const ss = Math.min(s, len);
    const cur = prof.map(([o, y], i) => {
      const j = i === 1 || i === 2 ? rng.range(-0.5, 0.4) : 0;
      const x = r.x + fx * ss + rx * o;
      const z = r.z + fz * ss + rz * o;
      return kit.solid.vertex(x, y + j, z, rx * Math.sign(o), 0.6, rz * Math.sign(o), 0, 0, (Math.floor(ss / 5) + i) % 3 ? LOOK.rock : LOOK.rockLight);
    });
    if (prev) for (let i = 0; i < 3; i++) kit.solid.quadFacing(prev[i], cur[i], cur[i + 1], prev[i + 1], i === 0 ? -rx : i === 2 ? rx : 0, 1, i === 0 ? -rz : i === 2 ? rz : 0);
    prev = cur;
  }
  // The tip's round end, and the beacon: green where the harbor is to its left going out, red to its right.
  const tip = { x: r.x + fx * len, z: r.z + fz * len };
  cylinder(kit.solid, tip.x + fx * 2, tip.z + fz * 2, width * 0.42, bed, topY, 10, LOOK.rock, true, width * 0.22);
  cylinder(kit.solid, tip.x, tip.z, 1.3, topY, topY + 7, 10, LOOK.beaconTower, true, 1.0);
  const c = h.values[1] > 0 ? LOOK.navGreen : LOOK.navRed;
  flasher(flash, tip.x, topY + 7.6, tip.z, 0.7, c, 3, 0.3, 0.37);
  reflects.push({ x: tip.x, y: topY + 7.6, z: tip.z, c: c.clone().multiplyScalar(0.3), w: 1.6 });
}

/** The reflections of the lights out on the water: lightFx's camera facing streaks, laid on the water. */
function streaks(kit: DistrictKit, a: Area, lights: readonly Reflect[]): THREE.Mesh {
  const base = new THREE.PlaneGeometry(1, 1.2);
  base.translate(0, 0.4, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  const iPos = new Float32Array(lights.length * 3);
  const iColor = new Float32Array(lights.length * 3);
  const iSize = new Float32Array(lights.length * 2);
  const f = harborFrame(a);
  lights.forEach((l, i) => {
    const W = waterLevel(a.params, frameU(f, l.x, l.z));
    iPos.set([l.x, W + 0.03, l.z], i * 3);
    iColor.set([l.c.r, l.c.g, l.c.b], i * 3);
    iSize.set([l.w, Math.max(2, l.y - W)], i * 2);
  });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 2));
  geo.instanceCount = lights.length;
  kit.track(base);
  const mat = new THREE.ShaderMaterial({
    vertexShader: streakVert,
    fragmentShader: streakFrag,
    uniforms: { strength: { value: 1 }, fogDensity: { value: 0.005 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(kit.track(geo), kit.track(mat));
  mesh.name = 'harborStreaks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

/** The flashers: lit when the fraction of time / period + phase is under the duty share, a faint glow between. */
const FLASH_VERT = /* glsl */ `
  uniform float time;
  uniform float fogDensity;
  varying vec3 vColor;
  varying float vFog;
  void main() {
    float duty = floor(uv.x) / 10.0;
    float ph = fract(time / max(uv.y, 0.1) + fract(uv.x));
    float on = ph < duty ? 1.0 : 0.06;
    vColor = color * on;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d);
    gl_Position = projectionMatrix * mv;
  }
`;

const FLASH_FRAG = /* glsl */ `
  uniform vec3 fogColor;
  varying vec3 vColor;
  varying float vFog;
  void main() {
    gl_FragColor = vec4(mix(fogColor, vColor, vFog), 1.0);
  }
`;
