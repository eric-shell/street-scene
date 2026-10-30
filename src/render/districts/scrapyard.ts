/**
 * Weekend special renderer: the scrapyard (city/districts/scrapyard.ts).
 *
 * Everything is read off the yard's layout (scrapyardLayout.ts), the same one the sim built its walls and heights from, and
 * merged into the district kit's builders (no draw call of their own) except the five things that need a material of
 * their own, so a yard costs five extra draw calls at every tier:
 *  - the fence (corrugated sheet texture, scrapyardTextures.ts) and the stacks of crushed cars (an atlas of flattened
 *    flanks in the traffic palette), two textured meshes;
 *  - the press's ram (moves with the gate's cycle), the crane's magnet with the car it carries (swings on a slow pendulum, a pure
 *    function of the scene clock), two small meshes with a transform each, nothing rebuilt;
 *  - the floodlights' pools of light on the ground (additive, one mesh for the four).
 * In the kit: the dirt ground (draped on the bowls' heights at 2.5 m near them, 7 m elsewhere), the ramp of flattened cars
 * on the kicker, oil stains, tyre ruts round the bowls (Medium and up), the crusher with its conveyor, the crane's mast and boom,
 * the floodlight towers and their lamp heads, the press's gantry with its blinking hazard lamps, the gate posts with their
 * lamps, and the gravel in each curb cut. No sign and no arrow anywhere: the gap in the fence, the gravel mouth and the
 * floodlights are what say "in here". Built once; the per frame work is two transforms and the press's ram.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { type ScrapLayout, type ScrapStack, scrapLayout } from '../../city/districts/scrapyard';
import { yardDims, yardPoint } from '../../city/districts/scrapyardLayout';
import { ringProfile } from '../../city/districts/banking';
import { triangulate } from '../../city/districts/geom';
import type { Area } from '../../city/districts/types';
import { gatePhase, newGatePhase } from '../../sim/gates';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { heightFogShader } from '../heightFog';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, groundVertex, orientedBox } from './kit';
import { ATLAS, cellUv, corrugatedTexture, stackAtlas } from './scrapyardTextures';
import { PAINTS } from '../traffic/traffic';

const C = CITY.districts.scrapyard;

const LOOK = {
  dirt: col(0x5e4f3f),
  dirtLight: col(0x6a5a46),
  dirtBank: col(0x7a6850),
  oil: col(0x0f0e0d),
  rut: col(0x1a1612),
  gravel: col(0x6e675d),
  steel: col(0x59626c),
  steelDark: col(0x2b3036),
  galv: col(0x8b929a),
  yellow: col(0xd9a11a),
  orange: col(0xd0601a),
  rubber: col(0x1c1d20),
  concrete: col(0x6c6e74),
  lamp: col(0xfff0d0, 2.4),
  lampWarm: col(0xffc878, 2),
  red: col(0xff2a1e, 1.6),
  tower: col(0x80878f),
} as const;

/** Sizes (m) of the drawn parts. */
const SIZE = {
  fenceThick: 0.12,
  postGap: 3,
  postSize: 0.22,
  cap: 0.1,
  tier: C.stack.tier,
  /** Ground mesh step near the bowls and the jump, and elsewhere. */
  fine: 2.5,
  coarse: 7,
  /** Tower pole radius at the foot and the head, and the lamp head's width and height. */
  pole: [0.28, 0.16] as const,
  head: { width: 3.6, height: 1.5 },
  /** Light pool radius (m) and its rings. */
  pool: 46,
  craneH: 14,
  cableLen: 6,
  press: { beamY: 6.1, plateH: 3, lift: 3.4, postTop: 6.9 },
} as const;

/** A tiny deterministic hash to [0, 1) from two coordinates. */
function noise(x: number, z: number): number {
  let h = Math.imul(Math.round(x * 3) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 3) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}


/** The yard's frame helpers for one area: points and oriented boxes in (u, w), heights off the kit. */
function frameOf(kit: DistrictKit, a: Area, L: ScrapLayout) {
  const F = L.frame;
  const P = (u: number, w: number): Vec2 => yardPoint(F, u, w);
  /** A box over [u0, u1] x [w0, w1] of the frame from absolute heights y0 to y1 (or ground-relative with `ground`). */
  const fbox = (gb: GeoBuilder, u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, color: THREE.Color, ground = true): void => {
    const p0 = P(u0, w0);
    const p1 = P(u1, w0);
    const dw = w1 - w0;
    let base = 0;
    if (ground) base = Math.min(kit.h(p0.x, p0.z), kit.h(p1.x, p1.z), kit.h(p0.x + F.w.x * dw, p0.z + F.w.z * dw), kit.h(p1.x + F.w.x * dw, p1.z + F.w.z * dw));
    orientedBox(gb, p0.x, p0.z, p1.x, p1.z, F.w.x * dw, F.w.z * dw, base + y0, base + y1, color);
  };
  void a;
  return { F, P, fbox };
}

// ---------- Ground ----------

/** Dirt colour at a point: kicked-up pale dirt on the banks, dark ruts and oil round the bowls' ring roads and the machines. */
function dirtAt(L: ScrapLayout, x: number, z: number, out: THREE.Color): THREE.Color {
  const n = noise(x, z);
  out.copy(LOOK.dirt).multiplyScalar(0.86 + 0.28 * n);
  const P = { h: 0, d: 0 };
  for (const r of L.rings) {
    const d = Math.hypot(x - r.cx, z - r.cz);
    if (d > r.rimR) continue;
    ringProfile(r, d, P);
    // The bank and its rim: lighter, dragged-up dirt; the ring road on the floor: dark ruts.
    const bank = Math.max(0, Math.min(1, (P.h + r.dip) / r.rise));
    out.lerp(LOOK.dirtBank, 0.5 * bank);
    const road = Math.exp(-(((d - (r.floorR - 2.5)) / 4.2) ** 2));
    out.lerp(LOOK.rut, 0.45 * road * (0.6 + 0.4 * n));
    if (d < 9) out.lerp(LOOK.oil, 0.25);
  }
  // Oil black round the crusher, the press lane and under the crane.
  for (const m of [L.crusher, L.crane]) {
    const d = Math.hypot(x - m.x, z - m.z);
    if (d < 12) out.lerp(LOOK.oil, 0.6 * (1 - d / 12) * (0.5 + 0.5 * n));
  }
  const pd = Math.hypot(x - L.pit.x, z - L.pit.z);
  if (pd < 9) out.lerp(LOOK.oil, 0.7 * (1 - pd / 9));
  return out;
}

/** A triangle of the ring draped on the terrain, split until its edges are under the coarse step (the fine step near the bowls and the jump). */
function drapeYard(kit: DistrictKit, L: ScrapLayout, a: Vec2, b: Vec2, c: Vec2, near: (minX: number, minZ: number, maxX: number, maxZ: number) => boolean, depth = 0): void {
  const lab = Math.hypot(b.x - a.x, b.z - a.z);
  const lbc = Math.hypot(c.x - b.x, c.z - b.z);
  const lca = Math.hypot(a.x - c.x, a.z - c.z);
  const longest = Math.max(lab, lbc, lca);
  const fine = near(Math.min(a.x, b.x, c.x), Math.min(a.z, b.z, c.z), Math.max(a.x, b.x, c.x), Math.max(a.z, b.z, c.z));
  if (longest > (fine ? SIZE.fine : SIZE.coarse) && depth < 9) {
    const ab = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const bc = { x: (b.x + c.x) / 2, z: (b.z + c.z) / 2 };
    const ca = { x: (c.x + a.x) / 2, z: (c.z + a.z) / 2 };
    drapeYard(kit, L, a, ab, ca, near, depth + 1);
    drapeYard(kit, L, ab, b, bc, near, depth + 1);
    drapeYard(kit, L, ca, bc, c, near, depth + 1);
    drapeYard(kit, L, ab, bc, ca, near, depth + 1);
    return;
  }
  const v = [a, b, c].map((p) => groundVertex(kit, kit.ground, p.x, p.z, 0.02, dirtAt(L, p.x, p.z, new THREE.Color())));
  kit.ground.triFacing(v[0], v[1], v[2], 0, 1, 0);
}

function ground(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const { rimR } = yardDims(L.R);
  const { P } = frameOf(kit, a, L);
  // The zones that need the fine step: both bowls' discs, and the pit lane with the kicker.
  const boxes: [number, number, number, number][] = [];
  for (const r of L.rings) boxes.push([r.cx - rimR, r.cz - rimR, r.cx + rimR, r.cz + rimR]);
  const lane = [P(L.canyon.u - 9, L.canyon.lip - 14), P(L.canyon.u + 9, L.canyon.lip + 7)];
  boxes.push([Math.min(lane[0].x, lane[1].x), Math.min(lane[0].z, lane[1].z), Math.max(lane[0].x, lane[1].x), Math.max(lane[0].z, lane[1].z)]);
  const near = (x0: number, z0: number, x1: number, z1: number) => boxes.some((b) => x1 > b[0] && x0 < b[2] && z1 > b[1] && z0 < b[3]);
  for (const [p, q, r] of triangulate(a.polygon)) drapeYard(kit, L, p, q, r, near);
}

/** The ramp's flattened cars: the kicker's surface as a patchwork of body panels in the traffic palette, with dark seams and a bright lip. */
function kickerRamp(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const { P } = frameOf(kit, a, L);
  const K = C.kicker;
  const half = C.canyon.aisle / 2;
  const cu = L.canyon.u;
  const lip = L.canyon.lip;
  const stepU = 1.25;
  const stepW = 0.8;
  const nu = Math.round((2 * half) / stepU);
  const nw = Math.round(K.run / stepW);
  const color = new THREE.Color();
  for (let j = 0; j < nw; j++) {
    for (let i = 0; i < nu; i++) {
      const u0 = cu - half + i * stepU;
      const w0 = lip + j * stepW;
      const k = noise(i * 17 + 3, j * 13 + 5);
      const base = PAINTS[Math.floor(k * PAINTS.length) % PAINTS.length];
      color.copy(base).multiplyScalar(1.1 + 0.5 * noise(i + 40, j + 40));
      const c = [P(u0, w0), P(u0 + stepU - 0.06, w0), P(u0 + stepU - 0.06, w0 + stepW - 0.05), P(u0, w0 + stepW - 0.05)];
      const v = c.map((p) => groundVertex(kit, kit.paint, p.x, p.z, 0.05, color));
      kit.paint.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
  }
  // The lip: a pale crushed bumper line across it, and a hazard lamp each end (the blink every lip in the city carries).
  const l0 = P(cu - half, lip + 0.15);
  const l1 = P(cu + half, lip + 0.15);
  groundLine(kit, kit.paint, l0, l1, 0.3, 0.07, col(0xc9ccd2, 0.9));
  for (const p of [l0, l1]) {
    const y = kit.h(p.x, p.z) + 0.1;
    cylinder(kit.hazard, p.x, p.z, 0.1, y, y + 0.28, 6, col(0xffa020), true);
  }
}

/** A flat blob (an oil stain) on the ground: a fan on a lumpy ellipse. */
function blob(kit: DistrictKit, x: number, z: number, rx: number, rz: number, yaw: number, color: THREE.Color, lift: number, n = 9): void {
  const c = groundVertex(kit, kit.paint, x, z, lift, color);
  const ring: number[] = [];
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const k = 1 + 0.2 * Math.sin(t * 3 + x * 7.3 + z * 3.1);
    const lx = Math.cos(t) * rx * k;
    const lz = Math.sin(t) * rz * k;
    ring.push(groundVertex(kit, kit.paint, x + lx * cs - lz * sn, z + lx * sn + lz * cs, lift, color));
  }
  for (let i = 0; i < n; i++) kit.paint.triFacing(c, ring[i], ring[(i + 1) % n], 0, 1, 0);
}

/** Oil stains scattered round the machines, the pit lane and the aisles; tyre ruts round the bowls (Medium and up). */
function marks(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const rng = new Rng(deriveSeed(a.params.seed, 'scrapyard:marks'));
  const { P } = frameOf(kit, a, L);
  const { S } = yardDims(L.R);
  const spots: Vec2[] = [];
  for (let i = 0; i < 16; i++) spots.push(P(rng.range(2, L.L - 2), rng.range(S + 1, L.D - 2)));
  for (let i = 0; i < 6; i++) spots.push({ x: L.crusher.x + rng.range(-7, 7), z: L.crusher.z + rng.range(-7, 7) });
  for (const p of spots) {
    if (L.stacks.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < 3.4)) continue;
    blob(kit, p.x, p.z, rng.range(0.8, 2.6), rng.range(0.6, 1.8), rng.range(0, 6.28), LOOK.oil, 0.045);
  }
  if (kit.quality === 'low') return;
  // The ring roads' ruts: three lines round each bowl, and the figure eight's line through the neck.
  for (const r of L.rings) {
    for (const [rad, wd] of [[r.floorR - 2, 0.45], [r.floorR - 4.2, 0.35], [r.floorR - 6.2, 0.3]] as const) {
      const n = 48;
      let prev: Vec2 | null = null;
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        const q = { x: r.cx + Math.cos(t) * rad, z: r.cz + Math.sin(t) * rad };
        if (prev && noise(i * 5, rad * 11) > 0.12) groundLine(kit, kit.paint, prev, q, wd, 0.045, LOOK.rut);
        prev = q;
      }
    }
  }
}

// ---------- The fence and the stacks (two textured meshes) ----------

/** The fence: corrugated panels along every piece, steel posts and a cap rail on its inner side. */
function fenceMesh(kit: DistrictKit, L: ScrapLayout, tex: THREE.Texture): void {
  const gb = new GeoBuilder(true);
  const H = C.fence.height;
  const T = C.fence.thickness;
  const tone = new THREE.Color(1, 1, 1);
  for (const p of L.fences) {
    const len = Math.hypot(p.bx - p.ax, p.bz - p.az);
    if (len < 0.05) continue;
    const k = Math.max(1, Math.round(len / SIZE.postGap));
    const ay = { x: p.ax + p.nx * T * 0.5, z: p.az + p.nz * T * 0.5 };
    const by = { x: p.bx + p.nx * T * 0.5, z: p.bz + p.nz * T * 0.5 };
    const steps = Math.max(1, Math.ceil(len / 4));
    for (let s = 0; s < steps; s++) {
      const x0 = ay.x + ((by.x - ay.x) * s) / steps;
      const z0 = ay.z + ((by.z - ay.z) * s) / steps;
      const x1 = ay.x + ((by.x - ay.x) * (s + 1)) / steps;
      const z1 = ay.z + ((by.z - ay.z) * (s + 1)) / steps;
      const g0 = kit.h(x0, z0);
      const g1 = kit.h(x1, z1);
      // Two faces, one each way, the sheet's tone shifting a little panel to panel.
      const shade = 1 + 0.35 * noise(x0 * 0.5, z0 * 0.5);
      tone.setScalar(shade);
      const u0 = (len * s) / steps / 4;
      const u1 = (len * (s + 1)) / steps / 4;
      for (const side of [1, -1] as const) {
        const nx = p.nx * side;
        const nz = p.nz * side;
        const o = side * SIZE.fenceThick * 0.5;
        const v = [
          gb.vertex(x0 + p.nx * o, g0 - 0.1, z0 + p.nz * o, nx, 0, nz, u0, 0, tone),
          gb.vertex(x1 + p.nx * o, g1 - 0.1, z1 + p.nz * o, nx, 0, nz, u1, 0, tone),
          gb.vertex(x1 + p.nx * o, g1 + H, z1 + p.nz * o, nx, 0, nz, u1, (H + 0.1) / 2.8, tone),
          gb.vertex(x0 + p.nx * o, g0 + H, z0 + p.nz * o, nx, 0, nz, u0, (H + 0.1) / 2.8, tone),
        ];
        gb.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
      }
    }
    // Posts on the inside, a cap rail along the top (the solid kit: steel, no texture).
    const dx = (p.bx - p.ax) / len;
    const dz = (p.bz - p.az) / len;
    for (let i = 0; i <= k; i++) {
      const x = p.ax + dx * (len * i) / k + p.nx * (T * 0.5 + SIZE.fenceThick * 0.5 + SIZE.postSize * 0.5);
      const z = p.az + dz * (len * i) / k + p.nz * (T * 0.5 + SIZE.fenceThick * 0.5 + SIZE.postSize * 0.5);
      const y = kit.h(x, z);
      orientedBox(kit.solid, x - SIZE.postSize / 2, z - SIZE.postSize / 2, x + SIZE.postSize / 2, z - SIZE.postSize / 2, 0, SIZE.postSize, y - 0.1, y + H + 0.15, LOOK.steelDark);
    }
    const c0 = { x: p.ax + p.nx * T * 0.5, z: p.az + p.nz * T * 0.5 };
    const c1 = { x: p.bx + p.nx * T * 0.5, z: p.bz + p.nz * T * 0.5 };
    const top = Math.max(kit.h(c0.x, c0.z), kit.h(c1.x, c1.z)) + H;
    orientedBox(kit.solid, c0.x, c0.z, c1.x, c1.z, p.nx * 0.08, p.nz * 0.08, top, top + SIZE.cap, LOOK.steel);
  }
  if (!gb.vertexCount) return;
  const mat = kit.track(new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.62, metalness: 0.15, emissive: 0x141418, envMapIntensity: 0.8, side: THREE.DoubleSide }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapFence';
  kit.group.add(mesh);
}

/** One stack: its tiers as slightly shifted boxes with a crushed flank on every side, the top tier's roof showing. */
function stackBoxes(kit: DistrictKit, gb: GeoBuilder, s: ScrapStack, index: number): void {
  const nx = -s.az;
  const nz = s.ax;
  let base = Infinity;
  let top = -Infinity;
  for (const p of s.poly) {
    const y = kit.h(p.x, p.z);
    base = Math.min(base, y);
    top = Math.max(top, y);
  }
  const tint = new THREE.Color();
  for (let t = 0; t < s.tiers; t++) {
    const jx = (noise(index * 3 + t, 1) - 0.5) * 0.28;
    const jz = (noise(index * 3 + t, 2) - 0.5) * 0.12;
    const len = s.length * (0.94 + 0.06 * noise(index + t, 3));
    const dep = s.depth * (0.94 + 0.06 * noise(index + t, 4));
    const cx = s.x + s.ax * jx + nx * jz;
    const cz = s.z + s.az * jx + nz * jz;
    const y0 = t === 0 ? base - 0.25 : top + t * SIZE.tier - 0.02;
    const y1 = top + (t + 1) * SIZE.tier;
    const hl = len / 2;
    const hd = dep / 2;
    const corners = [
      { x: cx - s.ax * hl - nx * hd, z: cz - s.az * hl - nz * hd },
      { x: cx + s.ax * hl - nx * hd, z: cz + s.az * hl - nz * hd },
      { x: cx + s.ax * hl + nx * hd, z: cz + s.az * hl + nz * hd },
      { x: cx - s.ax * hl + nx * hd, z: cz - s.az * hl + nz * hd },
    ];
    for (let f = 0; f < 4; f++) {
      const p = corners[f];
      const q = corners[(f + 1) % 4];
      const fl = Math.hypot(q.x - p.x, q.z - p.z);
      const dxn = (q.z - p.z) / fl;
      const dzn = -(q.x - p.x) / fl;
      // Outward normal: away from the centre.
      const ox = (p.x + q.x) / 2 - cx;
      const oz = (p.z + q.z) / 2 - cz;
      const sgn = ox * dxn + oz * dzn >= 0 ? 1 : -1;
      const cell = Math.floor(noise(index * 7 + t * 3 + f, 9) * ATLAS.cols * ATLAS.rows);
      const [u0, v0, u1, v1] = cellUv(cell);
      // A long face shows the whole strip, a short one a slice of it.
      const frac = fl > 3 ? 1 : fl / s.length;
      tint.setScalar(1 + 0.45 * noise(index * 5 + t, f + 11));
      const A = gb.vertex(p.x, y0, p.z, dxn * sgn, 0, dzn * sgn, u0, v0, tint);
      const B = gb.vertex(q.x, y0, q.z, dxn * sgn, 0, dzn * sgn, u0 + (u1 - u0) * frac, v0, tint);
      const Cc = gb.vertex(q.x, y1, q.z, dxn * sgn, 0, dzn * sgn, u0 + (u1 - u0) * frac, v1, tint);
      const D = gb.vertex(p.x, y1, p.z, dxn * sgn, 0, dzn * sgn, u0, v1, tint);
      gb.quadFacing(A, B, Cc, D, dxn * sgn, 0, dzn * sgn);
    }
    if (t === s.tiers - 1) {
      const [u0, v0, u1, v1] = cellUv(Math.floor(noise(index * 3, 21) * ATLAS.cols * ATLAS.rows));
      tint.setScalar(0.9);
      const v = [
        gb.vertex(corners[0].x, y1, corners[0].z, 0, 1, 0, u0, v0, tint),
        gb.vertex(corners[1].x, y1, corners[1].z, 0, 1, 0, u1, v0, tint),
        gb.vertex(corners[2].x, y1, corners[2].z, 0, 1, 0, u1, v1, tint),
        gb.vertex(corners[3].x, y1, corners[3].z, 0, 1, 0, u0, v1, tint),
      ];
      gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
  }
}

function stacksMesh(kit: DistrictKit, L: ScrapLayout, tex: THREE.Texture): void {
  const gb = new GeoBuilder(true);
  L.stacks.forEach((s, i) => stackBoxes(kit, gb, s, i));
  if (!gb.vertexCount) return;
  const mat = kit.track(new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.78, metalness: 0.05, emissive: 0x16161a, envMapIntensity: 0.7 }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapStacks';
  kit.group.add(mesh);
}

// ---------- Machines, lights, gates ----------

/** The crusher's body, press head and hopper, and its conveyor rising out of it on two legs (the legs are the layout's solids). */
function crusher(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const { F, fbox } = frameOf(kit, a, L);
  const Cr = C.crusher;
  const c = L.crusher;
  // Local frame of the body: u along the lane, w across it, from the centre.
  const cu = ((c.x - F.o.x) * F.u.x + (c.z - F.o.z) * F.u.z);
  const cw = ((c.x - F.o.x) * F.w.x + (c.z - F.o.z) * F.w.z);
  const hl = Cr.length / 2;
  const hd = Cr.depth / 2;
  fbox(kit.solid, cu - hl, cu + hl, cw - hd, cw + hd, -0.2, 2.3, LOOK.steel);
  fbox(kit.solid, cu - hl + 0.3, cu + 0.4, cw - hd + 0.4, cw + hd - 0.4, 2.3, 3.7, LOOK.yellow);
  fbox(kit.solid, cu + 0.7, cu + hl - 0.2, cw - hd + 0.3, cw + hd - 0.3, 2.3, Cr.height, LOOK.orange);
  // The hopper's lip and the press head's dark ram slot.
  fbox(kit.solid, cu - hl + 0.15, cu + 0.55, cw - hd + 0.25, cw + hd - 0.25, 3.7, 3.95, LOOK.steelDark);
  fbox(kit.solid, cu + hl - 0.2, cu + hl + 0.02, cw - 1.2, cw + 1.2, 1.0, 2.1, LOOK.steelDark);
  // A work lamp on the roof (warm) and a red beacon.
  const lamp = yardPoint(F, cu + 1.5, cw);
  const y = kit.h(lamp.x, lamp.z) + Cr.height;
  cylinder(kit.glow, lamp.x, lamp.z, 0.16, y + 0.05, y + 0.4, 6, LOOK.lampWarm, true);
  cylinder(kit.hazard, lamp.x + F.u.x * 0.8, lamp.z + F.u.z * 0.8, 0.12, y + 0.05, y + 0.3, 6, col(0xffa020), true);
  // The conveyor: a belt trough rising from the hopper's lip out along -u on two legs, ribs on the belt.
  const len = 11;
  const steps = 11;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const ua = cu - hl - 0.2 - t0 * len;
    const ub = cu - hl - 0.2 - t1 * len;
    const y0 = 3.2 - 0.2 - t0 * 1.0;
    const y1 = 3.2 - 0.2 - t1 * 1.0 + 0.0;
    const mid = (y0 + y1) / 2;
    fbox(kit.solid, ub, ua, cw - 0.55, cw + 0.55, mid, mid + 0.35, LOOK.steelDark);
    if (i % 2 === 0) fbox(kit.solid, ub + 0.1, ub + 0.25, cw - 0.5, cw + 0.5, mid + 0.35, mid + 0.45, LOOK.rubber);
  }
  for (const t of [0.35, 0.95]) {
    const ua = cu - hl - 0.2 - t * len;
    fbox(kit.solid, ua - 0.35, ua + 0.35, cw - 0.35, cw + 0.35, -0.2, 3.2 - 0.2 - t * 1.0, LOOK.steel);
  }
}

/** The magnet crane: base, mast, boom and counterweight in the kit; the magnet's car and cable swing as one small mesh. */
function crane(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const { F, fbox } = frameOf(kit, a, L);
  const cr = L.crane;
  const cu = ((cr.x - F.o.x) * F.u.x + (cr.z - F.o.z) * F.u.z);
  const cw = ((cr.x - F.o.x) * F.w.x + (cr.z - F.o.z) * F.w.z);
  const H = SIZE.craneH;
  fbox(kit.solid, cu - 1.5, cu + 1.5, cw - 1.5, cw + 1.5, -0.2, 1.4, LOOK.yellow);
  fbox(kit.solid, cu - 0.45, cu + 0.45, cw - 0.45, cw + 0.45, 1.4, H, LOOK.yellow);
  // A cab on the mast, the boom out along +u with its tie, the counterweight behind.
  fbox(kit.solid, cu - 1.1, cu + 0.8, cw - 0.9, cw + 0.9, H - 3.6, H - 1.8, LOOK.steelDark);
  fbox(kit.glow, cu + 0.8, cu + 0.84, cw - 0.6, cw + 0.6, H - 3.3, H - 2.3, LOOK.lampWarm);
  const boomLen = Math.hypot(cr.boom.x - cr.x, cr.boom.z - cr.z);
  fbox(kit.solid, cu - 0.4, cu + boomLen + 0.4, cw - 0.3, cw + 0.3, H - 0.6, H + 0.1, LOOK.yellow);
  fbox(kit.solid, cu - 4.4, cu - 0.4, cw - 0.9, cw + 0.9, H - 0.7, H + 0.5, LOOK.steel);
  const tip = yardPoint(F, cu + boomLen, cw);
  const ty = kit.h(tip.x, tip.z) + H - 0.6;
  // Hazard lamp on the boom tip.
  cylinder(kit.hazard, tip.x, tip.z, 0.1, ty + 0.7, ty + 1.0, 6, col(0xffa020), true);
  // The hanging part: cable, magnet disc and the car it holds, built about the pivot at the boom's underside.
  const gb = new GeoBuilder(true);
  const cab = SIZE.cableLen;
  cylinder(gb, 0, 0, 0.04, -cab, 0, 5, LOOK.steelDark, false);
  cylinder(gb, 0, 0, 1.0, -cab - 0.55, -cab, 10, LOOK.steelDark, true);
  const paint = PAINTS[(L.stacks.length * 3 + 1) % PAINTS.length];
  const body = (x0: number, x1: number, y0: number, y1: number, z: number, color: THREE.Color) => orientedBox(gb, x0, -z, x1, -z, 0, z * 2, y0, y1, color);
  body(-2.1, 2.1, -cab - 1.45, -cab - 0.55, 0.85, paint.clone().multiplyScalar(0.7));
  body(-1.0, 0.9, -cab - 1.9, -cab - 1.45, 0.75, col(0x16202a));
  const group = new THREE.Group();
  group.name = 'scrapMagnet';
  const mat = kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 }));
  group.add(new THREE.Mesh(kit.track(gb.build()), mat));
  group.position.set(tip.x, ty, tip.z);
  group.rotation.order = 'YXZ';
  group.rotation.y = Math.atan2(-F.u.z, F.u.x);
  kit.group.add(group);
  // A slow pendulum along the boom: a pure function of the scene's clock.
  kit.animate((time) => {
    group.rotation.z = 0.2 * Math.sin(time * 0.55) + 0.05 * Math.sin(time * 1.3);
  });
}

/** The four floodlight towers: pole, lamp head with its glowing panels aimed at the yard's middle, and the pools of light under them (one additive mesh). */
function towers(kit: DistrictKit, L: ScrapLayout): void {
  const mid = { x: (L.towers[0].x + L.towers[3].x) / 2, z: (L.towers[0].z + L.towers[3].z) / 2 };
  const pools = new GeoBuilder(true);
  const T = C.tower;
  const poolColor = new THREE.Color();
  for (const t of L.towers) {
    const y0 = kit.h(t.x, t.z);
    cylinder(kit.solid, t.x, t.z, SIZE.pole[0], y0 - 0.2, y0 + T.height, 8, LOOK.tower, true, SIZE.pole[1]);
    cylinder(kit.solid, t.x, t.z, 0.5, y0 - 0.2, y0 + 0.9, 8, LOOK.concrete, true);
    // The head: a frame facing the middle, two rows of three lamps.
    const dx = mid.x - t.x;
    const dz = mid.z - t.z;
    const dl = Math.hypot(dx, dz) || 1;
    const fx = dx / dl;
    const fz = dz / dl;
    const px = -fz;
    const pz = fx;
    const hw = SIZE.head.width / 2;
    const yh = y0 + T.height;
    orientedBox(kit.solid, t.x - px * hw, t.z - pz * hw, t.x + px * hw, t.z + pz * hw, fx * 0.35, fz * 0.35, yh - 0.1, yh + SIZE.head.height, LOOK.steelDark);
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 3; k++) {
        const u0 = -hw + 0.15 + k * ((SIZE.head.width - 0.3) / 3);
        const u1 = u0 + (SIZE.head.width - 0.3) / 3 - 0.12;
        const y = yh + 0.1 + row * 0.72;
        orientedBox(kit.glow, t.x + px * u0 + fx * 0.36, t.z + pz * u0 + fz * 0.36, t.x + px * u1 + fx * 0.36, t.z + pz * u1 + fz * 0.36, fx * 0.04, fz * 0.04, y, y + 0.6, LOOK.lamp);
      }
    }
    // The pool: rings of a fan, bright at the foot of the pole's aim point, fading to black at the edge.
    const aimX = t.x + dx * 0.42;
    const aimZ = t.z + dz * 0.42;
    const rings = 5;
    const segs = 20;
    const vi: number[][] = [];
    for (let r = 0; r <= rings; r++) {
      const rad = (r / rings) * SIZE.pool;
      const fall = (1 - r / rings) ** 2;
      poolColor.setRGB(0.62 * fall, 0.5 * fall, 0.3 * fall);
      const row: number[] = [];
      for (let s = 0; s < (r === 0 ? 1 : segs); s++) {
        const ang = (s / segs) * Math.PI * 2;
        const x = aimX + Math.cos(ang) * rad;
        const z = aimZ + Math.sin(ang) * rad;
        row.push(pools.vertex(x, kit.h(x, z) + 0.1, z, 0, 1, 0, 0, 0, poolColor));
      }
      vi.push(row);
    }
    for (let r = 1; r <= rings; r++) {
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        if (r === 1) pools.triFacing(vi[0][0], vi[1][s], vi[1][s1], 0, 1, 0);
        else pools.quadFacing(vi[r - 1][s], vi[r - 1][s1], vi[r][s1], vi[r][s], 0, 1, 0);
      }
    }
  }
  const mat = kit.track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mat.onBeforeCompile = (shader) => {
    heightFogShader(shader, true);
  };
  const mesh = new THREE.Mesh(kit.track(pools.build()), mat);
  mesh.name = 'scrapLightPools';
  mesh.renderOrder = 1;
  kit.group.add(mesh);
}

/** The press: a gantry across the canyon on two posts standing in the stack walls, hazard lamps on its beam, and the ram (a plate that follows the gate's cycle). */
function press(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const { F, fbox } = frameOf(kit, a, L);
  const half = C.canyon.aisle / 2;
  const cu = L.canyon.u;
  const pw = L.canyon.press;
  const reach = half + 1.3;
  const P = SIZE.press;
  for (const side of [-1, 1]) fbox(kit.solid, cu + side * (half + 0.3) - 0.4, cu + side * (half + 0.3) + 0.4, pw - 0.6, pw + 0.6, 0, P.postTop, LOOK.yellow);
  fbox(kit.solid, cu - reach, cu + reach, pw - 0.7, pw + 0.7, P.beamY, P.beamY + 0.8, LOOK.orange);
  fbox(kit.glow, cu - half + 0.3, cu + half - 0.3, pw - 0.72, pw - 0.68, P.beamY + 0.1, P.beamY + 0.25, LOOK.red);
  for (const side of [-1, 1]) {
    const p = yardPoint(F, cu + side * (half + 0.3), pw);
    const y = kit.h(p.x, p.z) + P.postTop;
    cylinder(kit.hazard, p.x, p.z, 0.14, y, y + 0.34, 6, col(0xffa020), true);
  }
  // The ram plate: a dark slab with a hazard stripe along its foot, posed from the gate's cycle.
  const gates = kit.world.timedGates;
  const gi = gates ? gates.gates.findIndex((g) => g.look === 'crusher') : -1;
  if (!gates || gi < 0) return;
  const cycle = gates.cycles[gates.gates[gi].cycle];
  const gb = new GeoBuilder(true);
  const half2 = half - 0.02;
  const thick = 0.45;
  const body = (y0: number, y1: number, color: THREE.Color) => orientedBox(gb, -half2, -thick / 2, half2, -thick / 2, 0, thick, y0, y1, color);
  body(-P.plateH / 2, P.plateH / 2, LOOK.steelDark);
  for (let i = 0; i < 6; i++) body(-P.plateH / 2, -P.plateH / 2 + 0.5, i % 2 ? col(0xe0a81c) : LOOK.rubber);
  const mat = kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapPress';
  const c = yardPoint(F, cu, pw);
  mesh.position.set(c.x, 0, c.z);
  mesh.rotation.y = Math.atan2(-F.u.z, F.u.x);
  kit.group.add(mesh);
  const ground = kit.h(c.x, c.z);
  const ph = newGatePhase();
  kit.animate((time) => {
    gatePhase(cycle, kit.simTick(time), ph);
    mesh.position.y = ground + P.plateH / 2 + P.lift * (1 - ph.arm);
  });
}

/** The gate posts: steel posts either side of every cut, a lamp on each, and the gravel of the cut's apron. */
function mouths(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  for (const p of L.posts) {
    const y = kit.h(p.x, p.z);
    cylinder(kit.solid, p.x, p.z, 0.3, y - 0.2, y + 3.4, 6, LOOK.steel, true);
    cylinder(kit.glow, p.x, p.z, 0.2, y + 3.4, y + 3.65, 6, LOOK.lampWarm, true);
  }
  for (const h of kit.builds[a.id].hints) {
    if (h.kind !== 'mouth') continue;
    drapeConvex(kit, kit.ground, h.points, 0.025, LOOK.gravel, 3);
  }
}

export const scrapyardRenderer: DistrictRenderer = {
  kinds: ['scrapyard'],
  build(kit, areas) {
    if (!areas.length) return;
    // One texture of each, shared by every yard (one per seed, but the sheets are cheap either way).
    const fenceTex = kit.track(corrugatedTexture());
    const atlas = kit.track(stackAtlas());
    for (const a of areas) {
      const L = scrapLayout(a);
      ground(kit, a, L);
      kickerRamp(kit, a, L);
      marks(kit, a, L);
      fenceMesh(kit, L, fenceTex);
      stacksMesh(kit, L, atlas);
      crusher(kit, a, L);
      crane(kit, a, L);
      towers(kit, L);
      press(kit, a, L);
      mouths(kit, a, L);
    }
  },
};
