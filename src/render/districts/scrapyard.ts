/**
 * Weekend special renderer: the Scrapyard (city/districts/scrapyard.ts, docs/weekend.md).
 *
 * Everything is read off the yard's layout (city/districts/scrapyardLayout.ts), the same one the sim built its walls, heights
 * and deck from. Three textured meshes carry the metal: the fence's corrugated sheet, the atlas of crushed car flanks (the
 * stacks, the deck's bales and its parapets) and the tiling jumble of wrecks the scrap mountains wear; the moving and glowing
 * parts are in scrapyardParts.ts (the magnet, the press's ram, the light pools, the sparks). With those, a yard costs seven
 * draw calls at Medium and up (six at Low, no sparks); the rest merges into the district kit:
 *  - ground: the region's gravel draped on the terrain (2.5 m near the bowls, the kickers and the weighbridge, 8 m elsewhere),
 *    the bowls' banks lighter and their floors rutted, dirt on their outsides, oil black round the crusher;
 *  - paint: the haul road's concrete with its joints, the widening aprons at both ends, the weighbridge's steel plate, every
 *    slick patch (dark and glossy: an invisible one would be unfair), oil stains, the flattened cars on both kickers, tyre
 *    ruts round the bowls (Medium and up);
 *  - the deck: its flatbed and bale top, the slab's edges and underside over the canyon's passage, hazard stripes at the drop.
 * No sign and no arrow anywhere: the lines are read by light, ground and what stands beside them. Built once; the per frame
 * work is the magnet's two angles, the ram's height and the sparks' clock.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { type ScrapLayout, type ScrapStack, deckSurface, scrapLayout } from '../../city/districts/scrapyard';
import { SCRAP_HINT } from '../../city/districts/scrapyard';
import type { ScrapHeap } from '../../city/districts/scrapyardFill';
import { framePoint } from '../../city/districts/scrapyardShapes';
import { pointInPolygon, triangulate } from '../../city/districts/geom';
import type { Area } from '../../city/districts/types';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, groundVertex, orientedBox } from './kit';
import { ATLAS, HEAP_TILE, cellUv, corrugatedTexture, heapTexture, stackAtlas } from './scrapyardTextures';
import { type DeckPool, LOOK, machines, press, sparks, towers } from './scrapyardParts';
import { PAINTS } from '../traffic/traffic';

const C = CITY.districts.scrapyard;

const GROUND = {
  gravel: col(0x5d5850),
  gravelDark: col(0x48443e),
  bank: col(0x76695a),
  dirt: col(0x5e4a36),
  rut: col(0x221d18),
  oil: col(0x0f0e0d),
  concrete: col(0x8a8a86),
  concreteDark: col(0x6e6e6a),
  joint: col(0x3a3a38),
  plate: col(0x4a4f55),
  slick: col(0x07080c),
  sheen: col(0x1d2a3a),
  stripeY: col(0xe0a81c),
  stripeK: col(0x151515),
  deckSteel: col(0x4c4d50),
  deckWood: col(0x6a5238),
  underside: col(0x1a1a1c),
} as const;

/** Sizes (m) of the drawn parts. */
const SIZE = {
  fenceThick: 0.12,
  postGap: 6,
  postSize: 0.22,
  cap: 0.1,
  fine: 2.5,
  coarse: 8,
  /** The deck slab's thickness under its surface. */
  slab: 0.6,
} as const;

/** A tiny deterministic hash to [0, 1) from two coordinates. */
function noise(x: number, z: number): number {
  let h = Math.imul(Math.round(x * 3) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 3) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

// ---------- Ground ----------

/** The gravel's colour at a point: the bowls' banks lighter and their ride rutted, dirt on their outsides, oil by the crusher. */
function groundColor(L: ScrapLayout, x: number, z: number, out: THREE.Color): THREE.Color {
  const n = noise(x, z);
  out.copy(GROUND.gravel).lerp(GROUND.gravelDark, 0.5 * n);
  for (let i = 0; i < 2; i++) {
    const c = L.centers[i];
    const d = Math.hypot(x - c.x, z - c.z);
    if (d > L.reach + C.eight.dirt + 1) continue;
    const bank = Math.max(0, 1 - Math.abs(d - (L.R - C.bank.rise / 2)) / (C.bank.rise / 2 + 1));
    out.lerp(GROUND.bank, 0.55 * bank);
    const ride = Math.exp(-(((d - L.ride) / 3.5) ** 2));
    out.lerp(GROUND.rut, 0.4 * ride * (0.6 + 0.4 * n));
  }
  for (const p of L.dirt) {
    if (pointInPolygon(x, z, p)) {
      out.lerp(GROUND.dirt, 0.85);
      break;
    }
  }
  const cr = L.solids.find((s) => s.kind === 'crusher');
  for (const m of [cr, L.pit.o]) {
    if (!m) continue;
    const d = Math.hypot(x - m.x, z - m.z);
    if (d < 12) out.lerp(GROUND.oil, 0.55 * (1 - d / 12) * (0.5 + 0.5 * n));
  }
  return out;
}

/**
 * A triangle of the region draped on the terrain, split until its edges are under the step (the fine one where `fine` says).
 * Each split halves the longest edge only: the region's triangulation is mostly long slivers, which a four way split would cut
 * into hundreds of thousands of needles; bisecting the longest edge keeps the count in step with the area.
 */
function drapeYard(kit: DistrictKit, L: ScrapLayout, a: Vec2, b: Vec2, c: Vec2, fine: (minX: number, minZ: number, maxX: number, maxZ: number) => boolean, depth = 0): void {
  const lab = Math.hypot(b.x - a.x, b.z - a.z);
  const lbc = Math.hypot(c.x - b.x, c.z - b.z);
  const lca = Math.hypot(a.x - c.x, a.z - c.z);
  const longest = Math.max(lab, lbc, lca);
  const f = fine(Math.min(a.x, b.x, c.x), Math.min(a.z, b.z, c.z), Math.max(a.x, b.x, c.x), Math.max(a.z, b.z, c.z));
  if (longest > (f ? SIZE.fine : SIZE.coarse) && depth < 40) {
    // Rotate so a-b is the longest edge, then split it at its middle.
    const [p, q, r] = longest === lab ? [a, b, c] : longest === lbc ? [b, c, a] : [c, a, b];
    const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
    drapeYard(kit, L, p, m, r, fine, depth + 1);
    drapeYard(kit, L, m, q, r, fine, depth + 1);
    return;
  }
  const v = [a, b, c].map((p) => groundVertex(kit, kit.ground, p.x, p.z, 0.02, groundColor(L, p.x, p.z, new THREE.Color())));
  kit.ground.triFacing(v[0], v[1], v[2], 0, 1, 0);
}

function ground(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  // Where the ground is shaped: the bowls, the crusher's kicker and pit, the launch, the weighbridge.
  const boxes: [number, number, number, number][] = [];
  const around = (p: Vec2, r: number) => boxes.push([p.x - r, p.z - r, p.x + r, p.z + r]);
  for (const c of L.centers) around(c, L.reach + 1);
  around(L.pit.o, 14);
  around(L.launch.lip, 12);
  around(L.hump.o, 14);
  const fine = (x0: number, z0: number, x1: number, z1: number) => boxes.some((b) => x1 > b[0] && x0 < b[2] && z1 > b[1] && z0 < b[3]);
  for (const [p, q, r] of triangulate(a.polygon)) drapeYard(kit, L, p, q, r, fine);
}

// ---------- Paint ----------

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

/** A kicker's surface as a patchwork of flattened cars in the traffic palette, dark seams, a pale crushed bumper along its lip. */
function kickerCars(kit: DistrictKit, k: { foot: Vec2; lip: Vec2; dir: Vec2 }, width: number, run: number, index: number): void {
  const n = { x: -k.dir.z, z: k.dir.x };
  const stepA = 0.8;
  const stepC = 1.25;
  const na = Math.max(1, Math.round(run / stepA));
  const nc = Math.max(1, Math.round(width / stepC));
  const color = new THREE.Color();
  const P = (s: number, t: number): Vec2 => ({ x: k.lip.x + k.dir.x * s + n.x * t, z: k.lip.z + k.dir.z * s + n.z * t });
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nc; j++) {
      const s0 = -run + i * stepA;
      const t0 = -width / 2 + j * stepC;
      const h = noise(i * 17 + 3 + index * 41, j * 13 + 5);
      color.copy(PAINTS[Math.floor(h * PAINTS.length) % PAINTS.length]).multiplyScalar(1.1 + 0.5 * noise(i + 40, j + 40));
      const c = [P(s0, t0), P(s0, t0 + stepC - 0.06), P(s0 + stepA - 0.05, t0 + stepC - 0.06), P(s0 + stepA - 0.05, t0)];
      const v = c.map((p) => groundVertex(kit, kit.paint, p.x, p.z, 0.05, color));
      kit.paint.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
  }
  groundLine(kit, kit.paint, P(-0.15, -width / 2), P(-0.15, width / 2), 0.3, 0.07, col(0xc9ccd2, 0.9));
}

function paint(kit: DistrictKit, a: Area, L: ScrapLayout): void {
  const F = L.frame;
  const hw = C.spineWidth / 2;
  // The haul road's concrete in slabs, the joints between them, and the aprons at both ends.
  const slab = 6;
  for (let u = 0; u < F.len - 0.1; u += slab) {
    const u1 = Math.min(F.len, u + slab);
    const tone = noise(u, 7) < 0.3 ? GROUND.concreteDark : GROUND.concrete;
    const q = [framePoint(F, u, -hw), framePoint(F, u1, -hw), framePoint(F, u1, hw), framePoint(F, u, hw)];
    const v = q.map((p) => groundVertex(kit, kit.paint, p.x, p.z, 0.04, tone));
    kit.paint.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    groundLine(kit, kit.paint, framePoint(F, u1, -hw), framePoint(F, u1, hw), 0.12, 0.05, GROUND.joint);
  }
  for (const p of L.concrete.slice(1)) drapeConvex(kit, kit.paint, p, 0.035, GROUND.concreteDark, 4);
  // The weighbridge's steel plate on its top.
  const H = C.hump;
  const hn = { x: -L.hump.dir.z, z: L.hump.dir.x };
  const hp = (s: number, t: number): Vec2 => ({ x: L.hump.o.x + L.hump.dir.x * s + hn.x * t, z: L.hump.o.z + L.hump.dir.z * s + hn.z * t });
  drapeConvex(kit, kit.paint, [hp(H.ramp, -hw + 1), hp(H.ramp + H.top, -hw + 1), hp(H.ramp + H.top, hw - 1), hp(H.ramp, hw - 1)], 0.06, GROUND.plate, 3);
  // Every slick patch: oil black with a cold sheen across it, so it reads at speed.
  for (const h of kit.builds[a.id].hints) {
    if (h.kind !== SCRAP_HINT.slick) continue;
    drapeConvex(kit, kit.paint, h.points, 0.07, GROUND.slick, 3);
    const c = { x: h.points.reduce((s, p) => s + p.x, 0) / h.points.length, z: h.points.reduce((s, p) => s + p.z, 0) / h.points.length };
    drapeConvex(kit, kit.paint, h.points.map((p) => ({ x: c.x + (p.x - c.x) * 0.55, z: c.z + (p.z - c.z) * 0.35 })), 0.08, GROUND.sheen, 3);
  }
  // Oil stains along the haul road's shoulders and round the machines.
  const rng = new Rng(deriveSeed(a.params.seed, 'scrapyard:marks'));
  for (let i = 0; i < 40; i++) {
    const p = framePoint(F, rng.range(30, F.len - 30), rng.range(-hw - 4, hw + 4));
    blob(kit, p.x, p.z, rng.range(0.6, 2.2), rng.range(0.5, 1.4), rng.range(0, 6.28), GROUND.oil, 0.045);
  }
  for (const s of L.solids) {
    if (s.kind !== 'crusher' && s.kind !== 'shredder' && s.kind !== 'wrecker' && s.kind !== 'flatbed') continue;
    for (let i = 0; i < 4; i++) blob(kit, s.x + rng.range(-6, 6), s.z + rng.range(-6, 6), rng.range(0.8, 2.4), rng.range(0.6, 1.6), rng.range(0, 6.28), GROUND.oil, 0.045);
  }
  kickerCars(kit, L.kicker, C.kicker.width, C.kicker.run, 0);
  kickerCars(kit, L.launch, C.launch.width, C.launch.run, 1);
  if (kit.quality === 'low') return;
  // The bowls' ruts: three rings round each ride.
  for (const c of L.centers) {
    for (const [rad, wd] of [
      [L.ride + 2.2, 0.45],
      [L.ride, 0.4],
      [L.ride - 2.4, 0.35],
    ] as const) {
      const n = 56;
      let prev: Vec2 | null = null;
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        const q = { x: c.x + Math.cos(t) * rad, z: c.z + Math.sin(t) * rad };
        if (prev && noise(i * 5, rad * 11) > 0.15) groundLine(kit, kit.paint, prev, q, wd, 0.045, GROUND.rut);
        prev = q;
      }
    }
  }
}

// ---------- The fence ----------

/** The fence: corrugated panels along every piece, steel posts and a cap rail on its inner side. */
function fenceMesh(kit: DistrictKit, L: ScrapLayout, tex: THREE.Texture): void {
  const gb = new GeoBuilder(true);
  const H = C.fence.height;
  const T = C.fence.thickness;
  const tone = new THREE.Color(1, 1, 1);
  for (const p of L.fences) {
    const len = Math.hypot(p.bx - p.ax, p.bz - p.az);
    if (len < 0.05) continue;
    const ay = { x: p.ax + p.nx * T * 0.5, z: p.az + p.nz * T * 0.5 };
    const by = { x: p.bx + p.nx * T * 0.5, z: p.bz + p.nz * T * 0.5 };
    const steps = Math.max(1, Math.ceil(len / 4.5));
    for (let s = 0; s < steps; s++) {
      const x0 = ay.x + ((by.x - ay.x) * s) / steps;
      const z0 = ay.z + ((by.z - ay.z) * s) / steps;
      const x1 = ay.x + ((by.x - ay.x) * (s + 1)) / steps;
      const z1 = ay.z + ((by.z - ay.z) * (s + 1)) / steps;
      const g0 = kit.h(x0, z0);
      const g1 = kit.h(x1, z1);
      tone.setScalar(1 + 0.35 * noise(x0 * 0.5, z0 * 0.5));
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
    const k = Math.max(1, Math.round(len / SIZE.postGap));
    const dx = (p.bx - p.ax) / len;
    const dz = (p.bz - p.az) / len;
    const off = T * 0.5 + SIZE.fenceThick * 0.5 + SIZE.postSize * 0.5;
    for (let i = 0; i <= k; i++) {
      const x = p.ax + (dx * (len * i)) / k + p.nx * off;
      const z = p.az + (dz * (len * i)) / k + p.nz * off;
      const y = kit.h(x, z);
      orientedBox(kit.solid, x - SIZE.postSize / 2, z - SIZE.postSize / 2, x + SIZE.postSize / 2, z - SIZE.postSize / 2, 0, SIZE.postSize, y - 0.1, y + H + 0.15, LOOK.steelDark);
    }
    const top = Math.max(kit.h(ay.x, ay.z), kit.h(by.x, by.z)) + H;
    orientedBox(kit.solid, ay.x, ay.z, by.x, by.z, p.nx * 0.08, p.nz * 0.08, top, top + SIZE.cap, LOOK.steel);
  }
  if (!gb.vertexCount) return;
  const mat = kit.track(new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.62, metalness: 0.15, emissive: 0x141418, envMapIntensity: 0.8, side: THREE.DoubleSide }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapFence';
  kit.group.add(mesh);
}

// ---------- Stacks, bales and the deck's parapets (the atlas mesh) ----------

/** One face of atlas metal: the quad a-b-c-d (counter-clockwise seen from outside, normal n) with cell k, `frac` of the strip shown. */
function atlasQuad(gb: GeoBuilder, p: [number, number, number][], n: [number, number, number], k: number, frac: number, tint: THREE.Color): void {
  const [u0, v0, u1, v1] = cellUv(k);
  const ue = u0 + (u1 - u0) * frac;
  const v = [gb.vertex(p[0][0], p[0][1], p[0][2], n[0], n[1], n[2], u0, v0, tint), gb.vertex(p[1][0], p[1][1], p[1][2], n[0], n[1], n[2], ue, v0, tint), gb.vertex(p[2][0], p[2][1], p[2][2], n[0], n[1], n[2], ue, v1, tint), gb.vertex(p[3][0], p[3][1], p[3][2], n[0], n[1], n[2], u0, v1, tint)];
  gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
}

const CELLS = ATLAS.cols * ATLAS.rows;

/** One stack: its tiers as slightly shifted boxes with a crushed flank on every side, the top tier's roof showing; `topAt` caps it (supports, under the deck). */
function stackBoxes(kit: DistrictKit, gb: GeoBuilder, s: ScrapStack, index: number, topAt?: number): void {
  const nx = -s.az;
  const nz = s.ax;
  let base = Infinity;
  let top = -Infinity;
  for (const p of s.poly) {
    const y = kit.h(p.x, p.z);
    base = Math.min(base, y);
    top = Math.max(top, y);
  }
  const tier = topAt !== undefined ? (topAt - top) / s.tiers : C.stack.tier;
  const tint = new THREE.Color();
  for (let t = 0; t < s.tiers; t++) {
    const jx = (noise(index * 3 + t, 1) - 0.5) * 0.28;
    const jz = (noise(index * 3 + t, 2) - 0.5) * 0.12;
    const len = s.length * (0.94 + 0.06 * noise(index + t, 3));
    const dep = s.depth * (0.94 + 0.06 * noise(index + t, 4));
    const cx = s.x + s.ax * jx + nx * jz;
    const cz = s.z + s.az * jx + nz * jz;
    const y0 = t === 0 ? base - 0.25 : top + t * tier - 0.02;
    const y1 = top + (t + 1) * tier;
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
      let dxn = (q.z - p.z) / fl;
      let dzn = -(q.x - p.x) / fl;
      if (((p.x + q.x) / 2 - cx) * dxn + ((p.z + q.z) / 2 - cz) * dzn < 0) {
        dxn = -dxn;
        dzn = -dzn;
      }
      tint.setScalar(1 + 0.45 * noise(index * 5 + t, f + 11));
      atlasQuad(gb, [[p.x, y0, p.z], [q.x, y0, q.z], [q.x, y1, q.z], [p.x, y1, p.z]], [dxn, 0, dzn], Math.floor(noise(index * 7 + t * 3 + f, 9) * CELLS), fl > 3 ? 1 : fl / s.length, tint);
    }
    if (t === s.tiers - 1) {
      tint.setScalar(0.9);
      atlasQuad(gb, [[corners[0].x, y1, corners[0].z], [corners[1].x, y1, corners[1].z], [corners[2].x, y1, corners[2].z], [corners[3].x, y1, corners[3].z]], [0, 1, 0], Math.floor(noise(index * 3, 21) * CELLS), 1, tint);
    }
  }
}

/** The deck's parapets as bale boxes on its surface; on the ramps their outer face runs down to the ground (the ramp's side). */
function parapets(kit: DistrictKit, gb: GeoBuilder, L: ScrapLayout): void {
  const tint = new THREE.Color();
  const y = (p: Vec2) => deckSurface(L, kit.h, p.x, p.z);
  L.deck.parapets.forEach((pp, i) => {
    const [a, b, c, d] = pp.poly;
    const ys = pp.poly.map(y);
    const top = ys.map((v) => v + C.deck.parapetTop);
    const bottom = pp.ramp ? pp.poly.map((p) => kit.h(p.x, p.z) - 0.2) : ys.map((v) => v - SIZE.slab);
    const faces: [Vec2, Vec2, number, number][] = [
      [a, b, 0, 1],
      [b, c, 1, 2],
      [c, d, 2, 3],
      [d, a, 3, 0],
    ];
    const cx = (a.x + c.x) / 2;
    const cz = (a.z + c.z) / 2;
    for (const [p, q, ip, iq] of faces) {
      const fl = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      let nx = (q.z - p.z) / fl;
      let nz = -(q.x - p.x) / fl;
      if (((p.x + q.x) / 2 - cx) * nx + ((p.z + q.z) / 2 - cz) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      // The face on the deck's edge (the first: the layout lays each piece from the edge inward) runs down to the bottom.
      const outer = ip === 0;
      const b0 = outer ? bottom[ip] : ys[ip];
      const b1 = outer ? bottom[iq] : ys[iq];
      tint.setScalar(0.85 + 0.4 * noise(i, ip));
      atlasQuad(gb, [[p.x, b0, p.z], [q.x, b1, q.z], [q.x, top[iq], q.z], [p.x, top[ip], p.z]], [nx, 0, nz], Math.floor(noise(i * 5 + ip, 17) * CELLS), fl > 3 ? 1 : 0.3, tint);
    }
    tint.setScalar(0.8);
    atlasQuad(gb, [[a.x, top[0], a.z], [b.x, top[1], b.z], [c.x, top[2], c.z], [d.x, top[3], d.z]], [0, 1, 0], Math.floor(noise(i, 23) * CELLS), 1, tint);
  });
}

function stackMesh(kit: DistrictKit, L: ScrapLayout, tex: THREE.Texture): void {
  const gb = new GeoBuilder(true);
  L.stacks.forEach((s, i) => {
    if (s.kind !== 'support') return stackBoxes(kit, gb, s, i);
    // A support reaches up to the deck slab's underside (its lowest corner's), the passage's walls the same.
    const under = Math.min(...s.poly.map((p) => deckSurface(L, kit.h, p.x, p.z))) - SIZE.slab;
    stackBoxes(kit, gb, s, i, under);
  });
  parapets(kit, gb, L);
  if (!gb.vertexCount) return;
  // The atlas as a faint emissive map too: at night under sodium the wrecks' paint still reads off the light pools.
  const mat = kit.track(new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, vertexColors: true, roughness: 0.78, metalness: 0.05, emissive: 0x4a4440, envMapIntensity: 0.7 }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapStacks';
  kit.group.add(mesh);
}

// ---------- Scrap mountains ----------

/**
 * One heap: a skirt of stacked wrecks round its footprint, then a hipped pile up to its ridge (along its long axis), each roof
 * face split into a small grid whose inner points are jostled up and down so the pile reads lumpy (none of that at Low).
 */
function heapGeometry(kit: DistrictKit, gb: GeoBuilder, h: ScrapHeap, index: number): void {
  const ax = { x: h.ax, z: h.az };
  const nx = { x: -h.az, z: h.ax };
  let base = Infinity;
  for (const p of h.poly) base = Math.min(base, kit.h(p.x, p.z));
  base -= 0.3;
  const skirt = Math.min(1.6, 0.3 * h.height) + 0.3;
  const top = base + 0.3 + h.height;
  const hl = h.length / 2;
  const hd = h.depth / 2;
  const ridge = Math.max(0, hl - hd);
  const P = (a: number, c: number, y: number): [number, number, number] => [h.x + ax.x * a + nx.x * c, y, h.z + ax.z * a + nx.z * c];
  const tint = new THREE.Color().setScalar(0.72 + 0.4 * noise(index, 3));
  const dark = tint.clone().multiplyScalar(0.62);
  const vtx = (p: [number, number, number], n: [number, number, number], col: THREE.Color) => gb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], p[0] / HEAP_TILE, p[2] / HEAP_TILE, col);
  // The skirt: four walls of stacked wrecks.
  const eave = base + skirt;
  const corners: [number, number][] = [
    [-hl, -hd],
    [hl, -hd],
    [hl, hd],
    [-hl, hd],
  ];
  for (let f = 0; f < 4; f++) {
    const [a0, c0] = corners[f];
    const [a1, c1] = corners[(f + 1) % 4];
    const mx = (a0 + a1) / 2;
    const mc = (c0 + c1) / 2;
    const len = Math.hypot(a1 - a0, c1 - c0);
    const n: [number, number, number] = [ax.x * Math.sign(mx) * (Math.abs(mx) > 1e-6 ? 1 : 0) + nx.x * Math.sign(mc) * (Math.abs(mc) > 1e-6 ? 1 : 0), 0, ax.z * Math.sign(mx) * (Math.abs(mx) > 1e-6 ? 1 : 0) + nx.z * Math.sign(mc) * (Math.abs(mc) > 1e-6 ? 1 : 0)];
    const p0 = P(a0, c0, base);
    const p1 = P(a1, c1, base);
    const p2 = P(a1, c1, eave);
    const p3 = P(a0, c0, eave);
    const v = [gb.vertex(...p0, ...n, 0, base / 3, dark), gb.vertex(...p1, ...n, len / HEAP_TILE, base / 3, dark), gb.vertex(...p2, ...n, len / HEAP_TILE, eave / 3, tint), gb.vertex(...p3, ...n, 0, eave / 3, tint)];
    gb.quadFacing(v[0], v[1], v[2], v[3], n[0], 0, n[2]);
  }
  // The roof: two long faces (eave to ridge) and two ends (eave to the ridge's ends), gridded and jostled.
  const div = kit.quality === 'low' ? 1 : h.length > 14 ? 3 : 2;
  const bump = (i: number, j: number, n: number, m: number, k: number) => (i === 0 || j === 0 || i === n || j === m ? 0 : (noise(index * 13 + i * 3 + k, j * 7 + k) - 0.45) * Math.min(1.6, h.height * 0.25));
  const face = (e0: [number, number], e1: [number, number], r0: [number, number], r1: [number, number], k: number) => {
    // Bilinear patch from the eave edge (e0-e1, at the eave) to the ridge edge (r0-r1, at the top).
    const n = div;
    const m = Math.max(1, div - 1);
    const ex = (e0[0] + e1[0]) / 2;
    const ec = (e0[1] + e1[1]) / 2;
    const rx = (r0[0] + r1[0]) / 2;
    const rc = (r0[1] + r1[1]) / 2;
    const run = Math.hypot(rx - ex, rc - ec) || 1;
    const rise = top - eave;
    const outA = (ex - rx) / run;
    const outC = (ec - rc) / run;
    const nl = Math.hypot(rise, run) || 1;
    const nrm: [number, number, number] = [((ax.x * outA + nx.x * outC) * rise) / nl, run / nl, ((ax.z * outA + nx.z * outC) * rise) / nl];
    const idx: number[][] = [];
    for (let j = 0; j <= m; j++) {
      const row: number[] = [];
      const tj = j / m;
      for (let i = 0; i <= n; i++) {
        const ti = i / n;
        const a = (e0[0] + (e1[0] - e0[0]) * ti) * (1 - tj) + (r0[0] + (r1[0] - r0[0]) * ti) * tj;
        const c = (e0[1] + (e1[1] - e0[1]) * ti) * (1 - tj) + (r0[1] + (r1[1] - r0[1]) * ti) * tj;
        const y = eave + rise * tj + bump(i, j, n, m, k);
        row.push(vtx(P(a, c, y), nrm, tj < 0.5 ? tint : tint));
      }
      idx.push(row);
    }
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) gb.quadFacing(idx[j][i], idx[j][i + 1], idx[j + 1][i + 1], idx[j + 1][i], nrm[0], nrm[1], nrm[2]);
  };
  face([-hl, -hd], [hl, -hd], [-ridge, 0], [ridge, 0], 1);
  face([hl, hd], [-hl, hd], [ridge, 0], [-ridge, 0], 2);
  face([hl, -hd], [hl, hd], [ridge, 0], [ridge, 0], 3);
  face([-hl, hd], [-hl, -hd], [-ridge, 0], [-ridge, 0], 4);
}

function heapMesh(kit: DistrictKit, L: ScrapLayout, tex: THREE.Texture): void {
  const gb = new GeoBuilder(true);
  L.heaps.forEach((h, i) => heapGeometry(kit, gb, h, i));
  if (!gb.vertexCount) return;
  const mat = kit.track(new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, vertexColors: true, roughness: 0.85, metalness: 0.08, emissive: 0x3a332c, envMapIntensity: 0.6 }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapHeaps';
  kit.group.add(mesh);
}

// ---------- The Bale Deck ----------

/** The deck's top (flatbed trailers' steel and timber in turn), the slab's edges and its underside over the flat stretch, stripes at the drop. */
function deck(kit: DistrictKit, L: ScrapLayout): DeckPool[] {
  const F = L.frame;
  const D = L.deck;
  const y = (p: Vec2) => deckSurface(L, kit.h, p.x, p.z);
  const step = kit.quality === 'low' ? 8 : 4;
  const flat0 = D.u0 + C.deck.ramp;
  const flat1 = D.u1 - C.deck.ramp;
  for (let u = D.u0; u < D.u1 - 0.01; u += step) {
    const u1 = Math.min(D.u1, u + step);
    const q = [framePoint(F, u, D.inner), framePoint(F, u1, D.inner), framePoint(F, u1, D.outer), framePoint(F, u, D.outer)];
    const ys = q.map(y);
    const tone = Math.floor(u / 12) % 2 ? GROUND.deckSteel : GROUND.deckWood;
    const c = tone.clone().multiplyScalar(0.85 + 0.3 * noise(u, 1));
    const v = q.map((p, i) => kit.solid.vertex(p.x, ys[i] + 0.02, p.z, 0, 1, 0, 0, 0, c));
    kit.solid.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    if (u1 <= flat0 || u >= flat1) continue;
    // Over the flat stretch: the underside (seen from the canyon's passage) and the slab's edges.
    const w = q.map((p, i) => kit.solid.vertex(p.x, ys[i] - SIZE.slab, p.z, 0, -1, 0, 0, 0, GROUND.underside));
    kit.solid.quadFacing(w[3], w[2], w[1], w[0], 0, -1, 0);
  }
  // The drop: yellow and black along the open edge, a hazard lamp each end.
  for (const [g0, g1] of D.gaps) {
    for (let u = g0; u < g1; u += 1.2) {
      const a = framePoint(F, u, D.inner + 0.1);
      const b = framePoint(F, Math.min(g1, u + 1.2), D.inner + 0.1);
      const c = framePoint(F, Math.min(g1, u + 1.2), D.inner + 0.5);
      const d = framePoint(F, u, D.inner + 0.5);
      const color = Math.round((u - g0) / 1.2) % 2 ? GROUND.stripeY : GROUND.stripeK;
      const v = [a, b, c, d].map((p) => kit.solid.vertex(p.x, y(p) + 0.04, p.z, 0, 1, 0, 0, 0, color));
      kit.solid.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
    for (const u of [g0, g1]) {
      const p = framePoint(F, u, D.inner + 0.3);
      const yy = y(p);
      cylinder(kit.hazard, p.x, p.z, 0.12, yy + 0.05, yy + 0.4, 6, LOOK.amber, true);
    }
  }
  // Sodium lamps on posts along the deck's outer parapet, lighting its line (their pools go with the towers').
  const pools: DeckPool[] = [];
  for (let u = flat0 + 10; u < flat1; u += 36) {
    const p = framePoint(F, u, D.outer - 0.3);
    const yy = y(p) + C.deck.parapetTop;
    cylinder(kit.solid, p.x, p.z, 0.08, yy, yy + 3.2, 6, LOOK.steelDark, true);
    cylinder(kit.glow, p.x, p.z, 0.18, yy + 3.2, yy + 3.45, 6, LOOK.sodium, true);
    const c = framePoint(F, u, D.dC);
    pools.push({ x: c.x, z: c.z, y: y(c) + 0.08, r: 9 });
  }
  return pools;
}

export const scrapyardRenderer: DistrictRenderer = {
  kinds: ['scrapyard'],
  build(kit, areas) {
    const yards = areas.filter((a) => a.params.planned && a.params.R > 0);
    if (!yards.length) return;
    const fenceTex = kit.track(corrugatedTexture());
    const atlas = kit.track(stackAtlas());
    const heapTex = kit.track(heapTexture());
    for (const a of yards) {
      const L = scrapLayout(a);
      ground(kit, a, L);
      paint(kit, a, L);
      fenceMesh(kit, L, fenceTex);
      stackMesh(kit, L, atlas);
      heapMesh(kit, L, heapTex);
      const deckPools = deck(kit, L);
      machines(kit, L);
      towers(kit, L, deckPools);
      press(kit, L);
      sparks(kit, L);
    }
  },
};
