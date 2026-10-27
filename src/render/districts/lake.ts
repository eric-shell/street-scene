/**
 * Lake renderer (city/districts/lake.ts): the promenade's paving at curb
 * height from the sidewalk to the railing, the stone coping, the railing on
 * it (the sim's 'lakeRail' walls: posts, a top and a middle rail, taller gate
 * posts with lanterns where the jetty leaves), the bank falling from the
 * coping to the bed on the sim's own ground, reeds along the waterline, and
 * the water: one flat polygon at the lake's level in the river's dark mirror
 * material (render/districts/river.ts waterMaterial), stiller and a shade
 * darker. On it, the lights: every lantern post and the jetty's lamp throws
 * a shimmering streak across the water toward the viewer (laid out per
 * vertex toward the camera, so it always reads as a reflection), and the
 * fountain jet (when the lake has room for one) rises from a ring of
 * underwater lights, swaying a little. The jetty is a plank deck on posts
 * off the middle of the longest straight shore with two rowboats moored at
 * it, all behind the railing (nothing a car can reach). Trees on the
 * promenade are the shared trees (trees.ts) on the sim's trunks; lantern
 * posts and benches are destructible props (render/street/props.ts) lit by
 * render/street/areaLights.ts.
 *
 * Meshes: the kit's merged builders (ground, solid, glow, foliage, trees),
 * plus three of its own: the water, the streaks and the fountain jet (one
 * draw call each). Per frame: two uniform writes and the jet's sway, no
 * allocation. Quality: at Low no streaks and a still jet, railing posts
 * twice as far apart and fewer reeds.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { lakeLevels, lakeRings, offsetRing } from '../../city/districts/lake';
import { triangulate } from '../../city/districts/geom';
import type { Area } from '../../city/districts/types';
import type { Wall } from '../../city/blocks';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundVertex } from './kit';
import { waterMaterial } from './river';
import { tree } from './trees';

const CFG = CITY.districts.lake;

/** Sizes (m) and tints of the dressing. */
const LOOK = {
  /** Pieces the long strips are cut into along the shore so they follow the ground (m). */
  piece: 4,
  paving: col(0x6f6b64),
  copingTop: col(0x9c968b),
  copingFace: col(0x5e5a53),
  /** The coping stands this far over the promenade's paving (m). */
  copingRise: 0.16,
  bankTop: col(0x4b473f),
  bankLow: col(0x23231f),
  /** Bank rows from the coping to the bed. */
  bankRows: 6,
  rail: col(0x1b231f),
  railHeight: 1.05,
  postStep: { low: 4.8, medium: 2.4, high: 2.4 },
  postHalf: 0.035,
  railHalf: 0.03,
  gatePost: 1.55,
  gateLamp: new THREE.Color(1, 0.8, 0.52).multiplyScalar(2.2),
  water: col(0x060b14),
  waterRoughness: 0.05,
  wood: col(0x5d4632),
  woodDark: col(0x3b2c1f),
  /** Jetty: deck over the water (m), plank pitch (m), post spacing (m), its lamp's pole (m). */
  deckRise: 0.55,
  plank: 1.15,
  jettyPost: 3,
  jettyLamp: 3.2,
  boats: [col(0xd8d4c8), col(0x9a3328), col(0x2f5a46)],
  reeds: [col(0x3c4a29), col(0x56603a), col(0x4b412b)],
  /** Reed clumps: spacing along the waterline (m), share of the shore that has them, blades per clump. */
  reedStep: 5.5,
  reedShare: { low: 0.25, medium: 0.5, high: 0.6 },
  reedBlades: 7,
  /** Lamp reflections: streak length (m) at most and its half width at the shore (m), bands along it. */
  glint: new THREE.Color(1, 0.7, 0.4).multiplyScalar(0.55),
  glintLen: 22,
  glintHalf: 0.9,
  glintBands: 7,
  /** Fountain: jet height (m), the spray's reach (m), the lights round its foot (count, radius m). */
  jetHeight: 7.5,
  sprayReach: 3.4,
  jet: new THREE.Color(0.7, 0.88, 1).multiplyScalar(0.55),
  fountainLights: 8,
  fountainRing: 2.3,
  fountainLight: new THREE.Color(0.6, 0.85, 1).multiplyScalar(2),
} as const;

export const lakeRenderer: DistrictRenderer = {
  kinds: ['lake'],
  build(kit, areas) {
    for (const a of areas) buildLake(kit, a);
  },
};

function buildLake(kit: DistrictKit, a: Area): void {
  const b = kit.builds[a.id];
  const rings = lakeRings(a);
  const { water: W } = lakeLevels(a);
  const rng = new Rng(deriveSeed(a.params.seed, 'lake:render'));
  const curb = CITY.curbHeight;
  const copingY = (x: number, z: number) => kit.h(x, z) + curb + LOOK.copingRise;

  // ----- Promenade paving from the sidewalk's outer line to the railing, at curb height.
  strips(kit.ground, rings.shore, rings.rail, (p, q) => [groundVertex(kit, kit.ground, p.x, p.z, curb + 0.012, LOOK.paving, 3), groundVertex(kit, kit.ground, q.x, q.z, curb + 0.012, LOOK.paving, 3)]);

  // ----- Coping: a stone kerb from the railing to the water's edge, a face down into the bank.
  strips(kit.solid, rings.rail, rings.water, (p, q) => [kit.solid.vertex(p.x, copingY(p.x, p.z), p.z, 0, 1, 0, 0, 0, LOOK.copingTop), kit.solid.vertex(q.x, copingY(q.x, q.z), q.z, 0, 1, 0, 0, 0, LOOK.copingTop)]);
  edgeFace(kit, rings.rail, (p) => kit.h(p.x, p.z) + curb - 0.02, copingY, LOOK.copingFace, -1);
  edgeFace(kit, rings.water, (p) => kit.h(p.x, p.z) - 0.4, copingY, LOOK.copingFace, 1);

  // ----- The bank, on the sim's ground, from under the coping to the bed (below the water from about half way).
  const rows: Vec2[][] = [rings.water];
  for (let k = 1; k < LOOK.bankRows; k++) {
    const r = offsetRing(rings.shore, CFG.promenade + CFG.coping + (CFG.bank * k) / LOOK.bankRows);
    if (r) rows.push(r);
  }
  rows.push(rings.bed);
  const tint = new THREE.Color();
  for (let k = 0; k + 1 < rows.length; k++) {
    const t0 = k / (rows.length - 1);
    const t1 = (k + 1) / (rows.length - 1);
    strips(kit.ground, rows[k], rows[k + 1], (p, q) => [
      groundVertex(kit, kit.ground, p.x, p.z, 0.02, tint.copy(LOOK.bankTop).lerp(LOOK.bankLow, t0)),
      groundVertex(kit, kit.ground, q.x, q.z, 0.02, tint.copy(LOOK.bankTop).lerp(LOOK.bankLow, t1)),
    ]);
  }

  // ----- Railing on the coping along the sim's walls; gate posts with lanterns where the jetty leaves.
  const jetty = b.hints.find((h) => h.kind === 'jetty');
  const rails = (kit.walls.get('lakeRail') ?? []).filter((w) => w.area === a.id);
  railing(kit, rails, copingY, jetty ? jetty.points[0] : null, jetty ? jetty.values[0] : 0);

  // ----- Trees on the promenade (the sim's trunks).
  for (const p of b.props) if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height, { conifer: 0.1 });

  // ----- Reeds in clumps along the waterline, clear of the jetty.
  reeds(kit, rings.water, rings.bed, W, rng, jetty ? jetty.points[0] : null);

  // ----- The water: one flat polygon at the lake's level.
  const wet = new GeoBuilder(true);
  for (const [p, q, r] of triangulate(rings.water)) {
    const ids = [p, q, r].map((v) => wet.vertex(v.x, W, v.z, 0, 1, 0, v.x / 8, v.z / 8, LOOK.water));
    wet.triFacing(ids[0], ids[1], ids[2], 0, 1, 0);
  }
  const waterMat = kit.track(waterMaterial());
  waterMat.roughness = LOOK.waterRoughness;
  addMesh(kit, wet, waterMat, `lakeWater${a.id}`, 1);

  // ----- Jetty, boats, its lamp.
  /** Where each light's reflection starts on the water (just off the shore below it) and how bright it is. */
  const lights: { x: number; z: number; k: number }[] = [];
  if (jetty) jettyAt(kit, jetty.points[0], jetty.points[1], jetty.values[0], W, copingY, lights);

  // ----- Reflections of the lantern posts (destructible props by the railing) and the jetty's lamp.
  for (const d of b.destructibles) {
    if (d.kind !== 'parkLamp') continue;
    // A lamp faces the promenade (yaw away from the water): the water is behind it.
    const nx = -Math.sin(d.yaw);
    const nz = -Math.cos(d.yaw);
    lights.push({ x: d.x + nx * 3.2, z: d.z + nz * 3.2, k: 1 });
  }
  if (kit.quality !== 'low' && lights.length) streaks(kit, lights, W);

  // ----- Fountain.
  const fountain = b.hints.find((h) => h.kind === 'fountain');
  if (fountain) fountainAt(kit, fountain.points[0], W);
}

/**
 * Quads (facing up) between two rings of equal point count, each side cut into LOOK.piece m pieces:
 * `make` adds the vertices for a point p on ring a and its partner q on ring b and returns their ids.
 */
function strips(gb: GeoBuilder, a: readonly Vec2[], b: readonly Vec2[], make: (p: Vec2, q: Vec2) => [number, number]): void {
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % n];
    const b0 = b[i];
    const b1 = b[(i + 1) % n];
    const len = Math.max(Math.hypot(a1.x - a0.x, a1.z - a0.z), Math.hypot(b1.x - b0.x, b1.z - b0.z));
    const m = Math.max(1, Math.ceil(len / LOOK.piece));
    let prev: [number, number] | null = null;
    for (let k = 0; k <= m; k++) {
      const t = k / m;
      const cur = make({ x: a0.x + (a1.x - a0.x) * t, z: a0.z + (a1.z - a0.z) * t }, { x: b0.x + (b1.x - b0.x) * t, z: b0.z + (b1.z - b0.z) * t });
      if (prev) gb.quadFacing(prev[0], cur[0], cur[1], prev[1], 0, 1, 0);
      prev = cur;
    }
  }
}

/** A vertical face along a ring from y0(p) up to y1(p), facing into the ring (side 1) or out of it (-1). */
function edgeFace(kit: DistrictKit, ring: readonly Vec2[], y0: (p: Vec2) => number, y1: (x: number, z: number) => number, color: THREE.Color, side: 1 | -1): void {
  const n = ring.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) area2 += ring[i].x * ring[(i + 1) % n].z - ring[(i + 1) % n].x * ring[i].z;
  const inward = area2 < 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.05) continue;
    const nx = ((q.z - p.z) / len) * inward * side;
    const nz = (-(q.x - p.x) / len) * inward * side;
    const m = Math.max(1, Math.ceil(len / LOOK.piece));
    for (let k = 0; k < m; k++) {
      const s = { x: p.x + ((q.x - p.x) * k) / m, z: p.z + ((q.z - p.z) * k) / m };
      const e = { x: p.x + ((q.x - p.x) * (k + 1)) / m, z: p.z + ((q.z - p.z) * (k + 1)) / m };
      const v = [
        kit.solid.vertex(s.x, y0(s), s.z, nx, 0, nz, 0, 0, color),
        kit.solid.vertex(e.x, y0(e), e.z, nx, 0, nz, 0, 0, color),
        kit.solid.vertex(e.x, y1(e.x, e.z), e.z, nx, 0, nz, 0, 0, color),
        kit.solid.vertex(s.x, y1(s.x, s.z), s.z, nx, 0, nz, 0, 0, color),
      ];
      kit.solid.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
    }
  }
}

/** A square bar of half width `hw` between two 3D points (its four long faces). */
function bar(gb: GeoBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, hw: number, color: THREE.Color): void {
  const l = Math.hypot(bx - ax, bz - az) || 1;
  // Across the bar (horizontal) and up: the section's corners are (across, up) = (+-1, +-1) times hw.
  const sx = -(bz - az) / l;
  const sz = (bx - ax) / l;
  const corners: [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  for (let k = 0; k < 4; k++) {
    const [s0, u0] = corners[k];
    const [s1, u1] = corners[(k + 1) % 4];
    // The face's normal: across or up, whichever its two corners share.
    const ns = (s0 + s1) / 2;
    const nu = (u0 + u1) / 2;
    const nx = sx * ns;
    const nz = sz * ns;
    const v = [
      gb.vertex(ax + sx * s0 * hw, ay + u0 * hw, az + sz * s0 * hw, nx, nu, nz, 0, 0, color),
      gb.vertex(bx + sx * s0 * hw, by + u0 * hw, bz + sz * s0 * hw, nx, nu, nz, 0, 0, color),
      gb.vertex(bx + sx * s1 * hw, by + u1 * hw, bz + sz * s1 * hw, nx, nu, nz, 0, 0, color),
      gb.vertex(ax + sx * s1 * hw, ay + u1 * hw, az + sz * s1 * hw, nx, nu, nz, 0, 0, color),
    ];
    gb.quadFacing(v[0], v[1], v[2], v[3], nx, nu, nz);
  }
}

/** The railing along its walls: posts every postStep, a top rail and a middle rail following the coping. */
function railing(kit: DistrictKit, walls: readonly Wall[], y: (x: number, z: number) => number, gate: Vec2 | null, gateWidth: number): void {
  const step = LOOK.postStep[kit.quality];
  const H = LOOK.railHeight;
  let carry = 0;
  for (const w of walls) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (len < 0.05) continue;
    const ux = (w.bx - w.ax) / len;
    const uz = (w.bz - w.az) / len;
    // Rails in pieces so they follow the coping's rise and fall.
    const m = Math.max(1, Math.ceil(len / 6));
    for (let k = 0; k < m; k++) {
      const x0 = w.ax + ux * ((len * k) / m);
      const z0 = w.az + uz * ((len * k) / m);
      const x1 = w.ax + ux * ((len * (k + 1)) / m);
      const z1 = w.az + uz * ((len * (k + 1)) / m);
      const y0 = y(x0, z0);
      const y1 = y(x1, z1);
      bar(kit.solid, x0, y0 + H, z0, x1, y1 + H, z1, LOOK.railHalf, LOOK.rail);
      bar(kit.solid, x0, y0 + H * 0.5, z0, x1, y1 + H * 0.5, z1, LOOK.railHalf * 0.8, LOOK.rail);
    }
    let s = carry;
    for (; s < len; s += step) {
      const x = w.ax + ux * s;
      const z = w.az + uz * s;
      const y0 = y(x, z);
      cylinder(kit.solid, x, z, LOOK.postHalf, y0 - 0.05, y0 + H + 0.04, 4, LOOK.rail, true);
    }
    carry = s - len;
  }
  if (!gate || !walls.length) return;
  // The gate onto the jetty: two taller posts, a lantern on each.
  const w = walls.reduce((best, x) => (distToWall(x, gate) < distToWall(best, gate) ? x : best), walls[0]);
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
  const ux = (w.bx - w.ax) / len;
  const uz = (w.bz - w.az) / len;
  for (const sd of [-1, 1]) {
    const x = gate.x + ux * sd * (gateWidth / 2 + 0.15);
    const z = gate.z + uz * sd * (gateWidth / 2 + 0.15);
    const y0 = y(x, z);
    cylinder(kit.solid, x, z, 0.09, y0 - 0.05, y0 + LOOK.gatePost, 4, LOOK.rail, true);
    cylinder(kit.glow, x, z, 0.12, y0 + LOOK.gatePost, y0 + LOOK.gatePost + 0.26, 4, LOOK.gateLamp, true, 0.08);
  }
}

function distToWall(w: Wall, p: Vec2): number {
  const dx = w.bx - w.ax;
  const dz = w.bz - w.az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - w.ax) * dx + (p.z - w.az) * dz) / l2));
  return Math.hypot(w.ax + dx * t - p.x, w.az + dz * t - p.z);
}

/**
 * Reed clumps along the waterline: where the ground crosses the water's level between the coping (ring
 * `top`) and the bed (ring `low`), found per piece of the shore; clumps come in stretches with gaps
 * between, none in front of the jetty.
 */
function reeds(kit: DistrictKit, top: readonly Vec2[], low: readonly Vec2[], W: number, rng: Rng, jetty: Vec2 | null): void {
  const share = LOOK.reedShare[kit.quality];
  const n = top.length;
  let on = rng.chance(share);
  let run = rng.range(10, 40);
  for (let i = 0; i < n; i++) {
    const a0 = top[i];
    const a1 = top[(i + 1) % n];
    const b0 = low[i];
    const b1 = low[(i + 1) % n];
    const len = Math.hypot(a1.x - a0.x, a1.z - a0.z);
    for (let s = rng.range(0, LOOK.reedStep); s < len; s += LOOK.reedStep * rng.range(0.7, 1.3)) {
      run -= LOOK.reedStep;
      if (run < 0) {
        on = rng.chance(share);
        run = rng.range(10, 40);
      }
      if (!on) continue;
      const t = s / len;
      const p = { x: a0.x + (a1.x - a0.x) * t, z: a0.z + (a1.z - a0.z) * t };
      const q = { x: b0.x + (b1.x - b0.x) * t, z: b0.z + (b1.z - b0.z) * t };
      if (jetty && Math.hypot(p.x - jetty.x, p.z - jetty.z) < 9) continue;
      // The waterline on this ray: bisect where the ground meets the water's level.
      let lo = 0;
      let hi = 1;
      if (kit.h(p.x, p.z) < W) continue;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        if (kit.h(p.x + (q.x - p.x) * mid, p.z + (q.z - p.z) * mid) > W) lo = mid;
        else hi = mid;
      }
      const x = p.x + (q.x - p.x) * lo;
      const z = p.z + (q.z - p.z) * lo;
      clump(kit.foliage, x, W - 0.25, z, rng);
    }
  }
}

/** A clump of reed blades (thin upright triangles) rising from (x, y, z). */
function clump(gb: GeoBuilder, x: number, y: number, z: number, rng: Rng): void {
  const color = LOOK.reeds[rng.int(0, LOOK.reeds.length - 1)];
  for (let k = 0; k < LOOK.reedBlades; k++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.7);
    const bx = x + Math.cos(a) * r;
    const bz = z + Math.sin(a) * r;
    const h = rng.range(1.1, 2.1);
    const lean = rng.range(0, 0.35);
    const la = rng.range(0, Math.PI * 2);
    const w = rng.range(0.04, 0.08);
    const nx = Math.cos(a + 1.3);
    const nz = Math.sin(a + 1.3);
    const v = [
      gb.vertex(bx - nz * w, y, bz + nx * w, nx, 0.2, nz, 0, 0, color),
      gb.vertex(bx + nz * w, y, bz - nx * w, nx, 0.2, nz, 0, 0, color),
      gb.vertex(bx + Math.cos(la) * lean, y + h, bz + Math.sin(la) * lean, nx, 0.2, nz, 0, 0, color),
    ];
    gb.tri(v[0], v[1], v[2]);
    gb.tri(v[0], v[2], v[1]);
  }
}

/**
 * The jetty from `root` (on the railing) out to `tip`: a gangway stepping down from the coping, a plank
 * deck on posts just over the water, a lamp on a pole at the end (its reflection pushed to `lights`)
 * and two rowboats moored along it.
 */
function jettyAt(kit: DistrictKit, root: Vec2, tip: Vec2, width: number, W: number, coping: (x: number, z: number) => number, lights: { x: number; z: number; k: number }[]): void {
  const len = Math.hypot(tip.x - root.x, tip.z - root.z);
  const ux = (tip.x - root.x) / len;
  const uz = (tip.z - root.z) / len;
  const vx = -uz;
  const vz = ux;
  const half = width / 2;
  const deck = W + LOOK.deckRise;
  const top = coping(root.x, root.z);
  const gang = Math.min(4, len * 0.3);
  const at = (s: number, v: number): Vec2 => ({ x: root.x + ux * s + vx * v, z: root.z + uz * s + vz * v });
  const yAt = (s: number) => (s < gang ? top + (deck - top) * (s / gang) : deck);
  // Planks across the deck, each level at its middle's height (the gangway steps down in them).
  for (let s = 0.1; s < len; s += LOOK.plank) {
    const s1 = Math.min(len, s + LOOK.plank - 0.06);
    const y = yAt((s + s1) / 2);
    const a = at(s, -half);
    const c = at(s1, -half);
    plankBox(kit.solid, a, c, vx * width, vz * width, y - 0.1, y, LOOK.wood);
  }
  // Stringers under the planks and posts down to the bed, bollards up through the deck.
  for (const sd of [-1, 1]) bar(kit.solid, at(gang, sd * (half - 0.2)).x, deck - 0.2, at(gang, sd * (half - 0.2)).z, at(len, sd * (half - 0.2)).x, deck - 0.2, at(len, sd * (half - 0.2)).z, 0.1, LOOK.woodDark);
  for (let s = gang; s <= len + 0.01; s += LOOK.jettyPost) {
    for (const sd of [-1, 1]) {
      const p = at(Math.min(s, len - 0.2), sd * (half + 0.05));
      cylinder(kit.solid, p.x, p.z, 0.12, W - CFG.depth, deck + 0.35, 6, LOOK.woodDark, true);
    }
  }
  // The lamp at the end.
  const lamp = at(len - 0.5, half - 0.3);
  cylinder(kit.solid, lamp.x, lamp.z, 0.06, deck, deck + LOOK.jettyLamp, 6, LOOK.rail, true);
  cylinder(kit.glow, lamp.x, lamp.z, 0.17, deck + LOOK.jettyLamp, deck + LOOK.jettyLamp + 0.34, 6, LOOK.gateLamp, true, 0.1);
  lights.push({ x: lamp.x + ux * 1.5, z: lamp.z + uz * 1.5, k: 1.2 });
  // Two rowboats along the deck, either side.
  for (const [s, sd, k] of [
    [len * 0.45, 1, 0],
    [len * 0.75, -1, 1],
  ] as const) {
    const c = at(s, sd * (half + 1.1));
    boat(kit.solid, c.x, W, c.z, ux, uz, LOOK.boats[(k + Math.round(len)) % LOOK.boats.length]);
  }
}

/** A flat box: one long face on a-c, `ox, oz` deep, from y0 to y1 (absolute). */
function plankBox(gb: GeoBuilder, a: Vec2, c: Vec2, ox: number, oz: number, y0: number, y1: number, color: THREE.Color): void {
  const pts = [a, c, { x: c.x + ox, z: c.z + oz }, { x: a.x + ox, z: a.z + oz }];
  const top = pts.map((p) => gb.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, color));
  gb.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = (q.z - p.z) / l;
    const nz = -(q.x - p.x) / l;
    const v = [gb.vertex(p.x, y0, p.z, nx, 0, nz, 0, 0, color), gb.vertex(q.x, y0, q.z, nx, 0, nz, 0, 0, color), top[(i + 1) % 4], top[i]];
    gb.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
  }
}

/** A rowboat at (x, z) floating on `W`, its bow along (ux, uz): a pointed hull, a darker floor inside. */
function boat(gb: GeoBuilder, x: number, W: number, z: number, ux: number, uz: number, color: THREE.Color): void {
  const L = 1.6;
  const B = 0.62;
  const vx = -uz;
  const vz = ux;
  const outline: [number, number][] = [
    [-L, -B * 0.8],
    [L * 0.35, -B],
    [L, 0],
    [L * 0.35, B],
    [-L, B * 0.8],
  ];
  const pts = outline.map(([a, b]) => ({ x: x + ux * a + vx * b, z: z + uz * a + vz * b }));
  const y0 = W - 0.18;
  const y1 = W + 0.32;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    let nx = (q.z - p.z) / l;
    let nz = -(q.x - p.x) / l;
    if (((p.x + q.x) / 2 - x) * nx + ((p.z + q.z) / 2 - z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // The hull flares out a little toward the gunwale.
    const v = [gb.vertex(p.x - nx * 0.12, y0, p.z - nz * 0.12, nx, 0, nz, 0, 0, color), gb.vertex(q.x - nx * 0.12, y0, q.z - nz * 0.12, nx, 0, nz, 0, 0, color), gb.vertex(q.x, y1, q.z, nx, 0, nz, 0, 0, color), gb.vertex(p.x, y1, p.z, nx, 0, nz, 0, 0, color)];
    gb.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
  }
  const inside = new THREE.Color(0x2a2620);
  const c = gb.vertex(x, y1 - 0.25, z, 0, 1, 0, 0, 0, inside);
  const ring = pts.map((p) => gb.vertex(p.x, y1 - 0.02, p.z, 0, 1, 0, 0, 0, inside));
  for (let i = 0; i < n; i++) gb.triFacing(c, ring[i], ring[(i + 1) % n], 0, 1, 0);
}

/**
 * The lights' reflections: per light a streak on the water from just off the shore toward the camera,
 * cut into bands that shimmer. Every vertex of a streak carries the streak's start as its position and
 * (along, across) in its uv; the vertex shader lays it out toward the camera, so it reads as a
 * reflection from anywhere. One additive mesh for the whole lake.
 */
function streaks(kit: DistrictKit, lights: readonly { x: number; z: number; k: number }[], W: number): void {
  const gb = new GeoBuilder(true);
  const black = new THREE.Color(0, 0, 0);
  const c = new THREE.Color();
  const N = LOOK.glintBands;
  for (const l of lights) {
    let prev: number[] | null = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      c.copy(LOOK.glint).multiplyScalar(l.k * (1 - t) ** 1.6);
      const row = [gb.vertex(l.x, W + 0.02, l.z, 0, 1, 0, t, -1, black), gb.vertex(l.x, W + 0.02, l.z, 0, 1, 0, t, 0, c), gb.vertex(l.x, W + 0.02, l.z, 0, 1, 0, t, 1, black)];
      if (prev) {
        gb.quad(prev[0], prev[1], row[1], row[0]);
        gb.quad(prev[1], prev[2], row[2], row[1]);
      }
      prev = row;
    }
  }
  const time = { value: 0 };
  const mat = kit.track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLakeTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uLakeTime;')
      .replace(
        '#include <begin_vertex>',
        `vec2 toCam = cameraPosition.xz - position.xz;
        float camDist = length(toCam);
        vec2 dir = camDist > 0.01 ? toCam / camDist : vec2(0.0, 1.0);
        float reach = min(${LOOK.glintLen.toFixed(1)}, camDist * 0.6);
        float halfW = ${LOOK.glintHalf.toFixed(2)} * (1.0 + uv.x * 0.6);
        vec3 transformed = vec3(position.x + dir.x * uv.x * reach - dir.y * uv.y * halfW, position.y, position.z + dir.y * uv.x * reach + dir.x * uv.y * halfW);`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        vColor.rgb *= 0.55 + 0.45 * sin(uLakeTime * 2.3 + uv.x * 13.0 + position.x * 0.37 + position.z * 0.29);`,
      );
    // Additive light fades to black in fog, never toward the fog color (render/street/areaLights.ts).
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        gl_FragColor.rgb *= 1.0 - fogFactor;
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'lake:streaks';
  kit.animate((t) => (time.value = t));
  const mesh = addMesh(kit, gb, mat, 'lakeStreaks', 2);
  // Its positions are the streaks' starts only: the laid out streaks reach past any bounds of those.
  if (mesh) mesh.frustumCulled = false;
}

/**
 * The fountain at `c`: a ring of underwater lights (the shared glow builder) and the jet, a narrow
 * column rising LOOK.jetHeight with its spray falling back in a wide cone, additive, swaying a little.
 */
function fountainAt(kit: DistrictKit, c: Vec2, W: number): void {
  for (let i = 0; i < LOOK.fountainLights; i++) {
    const a = (i / LOOK.fountainLights) * Math.PI * 2;
    cylinder(kit.glow, c.x + Math.cos(a) * LOOK.fountainRing, c.z + Math.sin(a) * LOOK.fountainRing, 0.22, W - 0.02, W + 0.03, 6, LOOK.fountainLight, true);
  }
  const gb = new GeoBuilder(true);
  const H = LOOK.jetHeight;
  const R = LOOK.sprayReach;
  const seg = 12;
  const bright = LOOK.jet;
  const dim = bright.clone().multiplyScalar(0.25);
  const black = new THREE.Color(0, 0, 0);
  // Built round the origin; the mesh stands at the fountain.
  const ringAt = (r: number, y: number, color: THREE.Color) => {
    const ids: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      ids.push(gb.vertex(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a), 0, Math.sin(a), i / seg, 0, color));
    }
    return ids;
  };
  const band = (a: number[], b: number[]) => {
    for (let i = 0; i < seg; i++) gb.quad(a[i], a[i + 1], b[i + 1], b[i]);
  };
  // The column, then the spray from its crown down to the water.
  const foot = ringAt(0.28, 0, dim);
  const crown = ringAt(0.1, H, bright);
  band(foot, crown);
  const cap = ringAt(0.35, H - 0.2, bright);
  const mid = ringAt(R * 0.7, H * 0.55, dim);
  const rim = ringAt(R, 0.1, black);
  band(cap, mid);
  band(mid, rim);
  const mat = kit.track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true }));
  const mesh = addMesh(kit, gb, mat, 'lakeFountain', 2);
  if (!mesh) return;
  mesh.position.set(c.x, W, c.z);
  if (kit.quality === 'low') return;
  kit.animate((t) => {
    mesh.scale.y = 0.93 + 0.05 * Math.sin(t * 2.7) + 0.02 * Math.sin(t * 7.3);
    mesh.rotation.y = t * 0.2;
  });
}

/** Build a builder into a mesh of the kit's group (tracked), or null when it is empty. */
function addMesh(kit: DistrictKit, gb: GeoBuilder, mat: THREE.Material, name: string, order: number): THREE.Mesh | null {
  if (!gb.vertexCount) return null;
  const m = new THREE.Mesh(kit.track(gb.build()), mat);
  m.name = name;
  m.renderOrder = order;
  kit.group.add(m);
  return m;
}
