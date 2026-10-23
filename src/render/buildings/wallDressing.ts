/**
 * Everything pasted on, bolted to or strung between the walls: pasted posters
 * and flyers (textures/wallAtlas.ts, lit by the scene like the wall) down the
 * alleys and on the exposed side walls of buildings, a grime line along the
 * base of every facade, air conditioning units and drainpipes on the side
 * walls, neon blade signs hanging off the shopfronts over the sidewalk, and
 * event banners strung across the route near the closures and the start. No
 * graffiti: sprayed paint never read well against the drawn facades, so the
 * paper and the dirt carry the lived in look on their own.
 *
 * Nothing here touches the road: blade signs hang 3.5 m up over the sidewalk
 * behind the collision wall line, banners cross at 6.5 m, and the rest is
 * flat on a facade. The facades stand an unknown few decimetres behind the
 * collision walls (podium extrusions), so every piece is placed by probing
 * the drawn podium geometry (wallProbe.ts); without that geometry only the
 * infill's low boundary walls, whose face is exact, get grimed. Three draw
 * calls: paint (one atlas), boxes, blade signs. Seeded, render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Building, Wall } from '../../city/blocks';
import { corridorClearance, insideBuilding } from '../../city/blocks';
import { CITY } from '../../city/config';
import { routeSample } from '../../city/route';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { orientedBox } from '../districts/kit';
import { FacadeProbe, ProbeHit } from './wallProbe';
import { fadeSubPixel } from '../materialFx';
import { AtlasCell, BLADE_SIGN_COLS, BLADE_SIGN_ROWS, BLADE_SIGN_TEXTS, NEON_COLORS, WALL_ATLAS, WallKind, wallCell } from '../textures/textures';

export interface WallDressingOptions {
  /** Share of candidate walls and faces that get dressed (graphics tier). */
  density: number;
  /** Banners across the route (count cap). */
  banners: number;
}

export interface WallDressing {
  meshes: THREE.Mesh[];
  dispose(): void;
}

const DRESS = {
  /** Paper down the alleys: spacing of the stations (m) and height (m) ranges by kind. */
  alleyStep: [3.5, 7.5],
  posterH: [0.9, 1.2],
  flyersH: [0.9, 1.1],
  /** Grime along the base of facades: piece length and height (m), chance per piece. */
  grimeLen: 4,
  grimeH: 0.55,
  grimeChance: 0.6,
  /** Blade signs: height of the centre above the street (m), projection (m), panel size (m). */
  bladeY: 3.55,
  bladeOut: [0.3, 1.35],
  bladeW: 1.05,
  bladeH: 0.62,
  bladeChance: 0.32,
  /** Air conditioners and pipes on exposed side walls. */
  acBox: [0.72, 0.56, 0.44],
  acHeights: [3.4, 8.5],
  pipeW: 0.11,
  /** Banners: height over the road (m), sag (m), spacing along the route (m). */
  bannerY: 6.6,
  bannerSag: 0.7,
  bannerH: 1.15,
  bannerGap: 140,
} as const;

const SEED = 0x5a11;

function uvOf(cell: AtlasCell, u0 = 0, u1 = 1): { u0: number; u1: number; v0: number; v1: number } {
  const W = WALL_ATLAS.w;
  const H = WALL_ATLAS.h;
  return { u0: (cell.x + cell.w * u0) / W, u1: (cell.x + cell.w * u1) / W, v1: 1 - cell.y / H, v0: 1 - (cell.y + cell.h) / H };
}

export function buildWallDressing(world: World, probe: FacadeProbe, atlases: { walls: THREE.Texture; blades: THREE.Texture }, opts: WallDressingOptions): WallDressing {
  const rng = new Rng(world.seed ^ SEED);
  const g = world.graph;
  const h = world.heightAt;
  const paint = new GeoBuilder(true);
  const boxes = new GeoBuilder(true);
  const blades = new GeoBuilder(true);
  const WHITE = new THREE.Color(1, 1, 1);
  const D = opts.density;

  /** A flat piece on a facade: centre (x, z) on the surface, tangent t (right), normal n (toward the viewer). */
  const piece = (kind: WallKind, i: number, x: number, z: number, tx: number, tz: number, nx: number, nz: number, w: number, y0: number, y1: number, color = WHITE, uu0 = 0, uu1 = 1) => {
    const uv = uvOf(wallCell(kind, i), uu0, uu1);
    const ox = nx * 0.02;
    const oz = nz * 0.02;
    const l = [x - (tx * w) / 2 + ox, z - (tz * w) / 2 + oz];
    const r = [x + (tx * w) / 2 + ox, z + (tz * w) / 2 + oz];
    const a = paint.vertex(l[0], y0, l[1], nx, 0, nz, uv.u0, uv.v0, color);
    const b = paint.vertex(r[0], y0, r[1], nx, 0, nz, uv.u1, uv.v0, color);
    const c = paint.vertex(r[0], y1, r[1], nx, 0, nz, uv.u1, uv.v1, color);
    const d = paint.vertex(l[0], y1, l[1], nx, 0, nz, uv.u0, uv.v1, color);
    paint.quadFacing(a, b, c, d, nx, 0, nz);
  };
  /** Width that fits the flat stretch around a probe hit (facade bays are about 5 m wide). */
  const fit = (hit: ProbeHit, w: number) => Math.min(w, 2 * Math.min(hit.left, hit.right) - 0.1);
  /** Place a probed piece: `want` metres wide, `hh` tall with its bottom at `yb` above the ground there. */
  const probedPiece = (kind: WallKind, i: number, px: number, pz: number, dx: number, dz: number, yb: number, hh: number, want: number, color = WHITE, maxDist = 2.6): boolean => {
    const ground = h(px, pz);
    const hit = probe.probe(px, pz, ground + yb + hh / 2, dx, dz, maxDist);
    if (!hit) return false;
    const w = fit(hit, want);
    if (w < 0.5) return false;
    const x = px + dx * hit.d;
    const z = pz + dz * hit.d;
    // Keep the piece on the flat stretch vertically too.
    const y0 = Math.max(ground + yb, hit.y0 + 0.02);
    const y1 = Math.min(y0 + hh * (w / want), hit.y1 - 0.02);
    if (y1 - y0 < 0.3) return false;
    piece(kind, i, x, z, hit.tx, hit.tz, hit.nx, hit.nz, w, y0, y1, color);
    return true;
  };
  /** A station on a wall: a poster or a sheet of flyers, or (most often) nothing, so the paper stays sparse. */
  const rollPaper = (px: number, pz: number, dx: number, dz: number, busy: number) => {
    const r = rng.next();
    if (r >= 0.74 * busy && r < 0.88 * busy) {
      const hh = rng.range(DRESS.posterH[0], DRESS.posterH[1]);
      probedPiece('poster', rng.int(0, 3), px, pz, dx, dz, rng.range(1.3, 2.0), hh, hh * (256 / 192));
    } else if (r < busy) {
      const hh = rng.range(DRESS.flyersH[0], DRESS.flyersH[1]);
      probedPiece('flyers', rng.int(0, 1), px, pz, dx, dz, rng.range(1.1, 1.8), hh, hh);
    }
  };
  const grimeAlong = (ax: number, az: number, bx: number, bz: number, dx: number, dz: number, chance: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    for (let s = DRESS.grimeLen / 2; s < len; s += DRESS.grimeLen) {
      if (!rng.chance(chance)) continue;
      const px = ax + ux * s;
      const pz = az + uz * s;
      probedPiece('grime', 0, px, pz, dx, dz, 0.0, DRESS.grimeH, Math.min(DRESS.grimeLen, len - s + DRESS.grimeLen / 2), WHITE, 1.7);
    }
  };

  // ---------- alleys: the galleries ----------
  if (!probe.empty) {
    for (const area of world.areas) {
      if (area.kind !== 'backAlley' && area.kind !== 'alley') continue;
      const busy = area.kind === 'backAlley' ? 1 : 0.45;
      for (const eid of area.edges) {
        const e = g.edges[eid];
        const A = g.nodes[e.a];
        const B = g.nodes[e.b];
        const len = Math.hypot(B.x - A.x, B.z - A.z);
        if (len < 20) continue;
        const ux = (B.x - A.x) / len;
        const uz = (B.z - A.z) / len;
        const lat = e.width / 2 + e.sidewalk;
        for (const side of [1, -1]) {
          const dx = -uz * side;
          const dz = ux * side;
          grimeAlong(A.x + ux * 8 + dx * lat, A.z + uz * 8 + dz * lat, A.x + ux * (len - 8) + dx * lat, A.z + uz * (len - 8) + dz * lat, dx, dz, 0.85 * D);
          for (let s = rng.range(8, 12); s < len - 8; s += rng.range(DRESS.alleyStep[0], DRESS.alleyStep[1]) / D) {
            rollPaper(A.x + ux * s + dx * lat, A.z + uz * s + dz * lat, dx, dz, busy);
          }
          // Pipes down the walls every so often.
          for (let s = rng.range(10, 30); s < len - 10; s += rng.range(22, 40) / D) {
            const px = A.x + ux * s + dx * lat;
            const pz = A.z + uz * s + dz * lat;
            drainpipe(px, pz, dx, dz);
          }
        }
      }
    }
  }

  /** A pipe standing against the probed facade from the ground up. */
  function drainpipe(px: number, pz: number, dx: number, dz: number): void {
    const ground = h(px, pz);
    const hit = probe.probe(px, pz, ground + 1.5, dx, dz, 2.6);
    if (!hit) return;
    const top = probe.probe(px, pz, ground + 6.5, dx, dz, 2.6);
    const x = px + dx * (hit.d - 0.02);
    const z = pz + dz * (hit.d - 0.02);
    const y1 = top && Math.abs(top.d - hit.d) < 0.05 ? Math.min(top.y1, ground + 9) : hit.y1;
    const w = DRESS.pipeW / 2;
    const col = new THREE.Color(0x2e2f36);
    orientedBox(boxes, x - hit.tx * w, z - hit.tz * w, x + hit.tx * w, z + hit.tz * w, -dx * DRESS.pipeW, -dz * DRESS.pipeW, ground - 0.1, y1 - 0.05, col);
    // Shoe at the bottom kicking out onto the ground.
    orientedBox(boxes, x - hit.tx * w, z - hit.tz * w, x + hit.tx * w, z + hit.tz * w, -dx * (DRESS.pipeW + 0.3), -dz * (DRESS.pipeW + 0.3), ground + 0.02, ground + 0.14, col);
  }
  /** An air conditioner bolted to the probed facade at height y (centre). */
  function acUnit(px: number, pz: number, dx: number, dz: number, y: number): void {
    const hit = probe.probe(px, pz, y, dx, dz, 2.6);
    if (!hit || hit.left < 0.5 || hit.right < 0.5 || y + 0.3 > hit.y1) return;
    const [bw, bh, bd] = DRESS.acBox;
    const x = px + dx * hit.d;
    const z = pz + dz * hit.d;
    const body = new THREE.Color(0x8d8c86);
    const grille = new THREE.Color(0x35363c);
    // Body from the wall out, then a darker grille slab on its face.
    orientedBox(boxes, x - hit.tx * (bw / 2), z - hit.tz * (bw / 2), x + hit.tx * (bw / 2), z + hit.tz * (bw / 2), -dx * bd, -dz * bd, y - bh / 2, y + bh / 2, body);
    const fx = x - dx * bd;
    const fz = z - dz * bd;
    orientedBox(boxes, fx - hit.tx * (bw * 0.42), fz - hit.tz * (bw * 0.42), fx + hit.tx * (bw * 0.42), fz + hit.tz * (bw * 0.42), -dx * 0.03, -dz * 0.03, y - bh * 0.38, y + bh * 0.38, grille);
    // Bracket underneath.
    orientedBox(boxes, x - hit.tx * (bw * 0.4), z - hit.tz * (bw * 0.4), x + hit.tx * (bw * 0.4), z + hit.tz * (bw * 0.4), -dx * (bd * 0.9), -dz * (bd * 0.9), y - bh / 2 - 0.06, y - bh / 2, grille);
  }

  // ---------- exposed side walls of buildings ----------
  if (!probe.empty) {
    const buildings = world.blocks.buildings;
    const cell = 48;
    const grid = new Map<number, number[]>();
    const key = (x: number, z: number) => Math.floor(x / cell) * 65536 + Math.floor(z / cell);
    buildings.forEach((b, i) => {
      const r = Math.hypot(b.w, b.d) / 2;
      for (let x = b.x - r; x <= b.x + r + cell; x += cell) for (let z = b.z - r; z <= b.z + r + cell; z += cell) (grid.get(key(x, z)) ?? grid.set(key(x, z), []).get(key(x, z))!).push(i);
    });
    const built = (x: number, z: number, margin: number, self: number) => {
      const list = grid.get(key(x, z));
      if (!list) return false;
      for (const i of list) if (i !== self && insideBuilding(buildings[i], x, z, margin)) return true;
      return false;
    };
    const scratch: number[] = [];
    buildings.forEach((b: Building, bi) => {
      if (!rng.chance(0.75 * D)) return;
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      const wx = Math.sin(b.yaw);
      const wz = Math.cos(b.yaw);
      const hw = b.w / 2;
      const hd = b.d / 2;
      const corner = (su: number, sw: number) => ({ x: b.x + ux * hw * su + wx * hd * sw, z: b.z + uz * hw * su + wz * hd * sw });
      const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      for (let f = 0; f < 4; f++) {
        if (f === 0) continue; // the street front: shopfronts live there
        const p = cs[f];
        const q = cs[(f + 1) % 4];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        if (len < 6) continue;
        const mx = (p.x + q.x) / 2;
        const mz = (p.z + q.z) / 2;
        const nl = Math.hypot(mx - b.x, mz - b.z) || 1;
        const nx = (mx - b.x) / nl;
        const nz = (mz - b.z) / nl;
        // Exposed: open ground just outside, and not another street frontage.
        const ox = mx + nx * 1.6;
        const oz = mz + nz * 1.6;
        if (built(ox, oz, 0.3, bi)) continue;
        const street = corridorClearance(g, world.blocks.edgeGrid, ox, oz, scratch) < 1.5;
        const dx = -nx;
        const dz = -nz;
        const tx = (q.x - p.x) / len;
        const tz = (q.z - p.z) / len;
        const at = (s: number) => ({ x: p.x + tx * s + nx * 1.6, z: p.z + tz * s + nz * 1.6 });
        if (!street) {
          // A party wall facing a lot, pocket or park: some paper, grime, the services.
          const pieces = rng.int(1, 3);
          for (let k = 0; k < pieces; k++) {
            const a = at(rng.range(2, len - 2));
            rollPaper(a.x, a.z, dx, dz, 1);
          }
          const a0 = at(1.5);
          const a1 = at(len - 1.5);
          grimeAlong(a0.x, a0.z, a1.x, a1.z, dx, dz, 0.7);
          const acs = rng.int(0, 3);
          for (let k = 0; k < acs; k++) {
            const a = at(rng.range(1.5, len - 1.5));
            acUnit(a.x, a.z, dx, dz, h(a.x, a.z) + rng.range(DRESS.acHeights[0], DRESS.acHeights[1]));
          }
          if (rng.chance(0.5)) {
            const a = at(rng.chance(0.5) ? 0.6 : len - 0.6);
            drainpipe(a.x, a.z, dx, dz);
          }
        } else if (rng.chance(0.35)) {
          // A side street front: at most a poster near a corner.
          const a = at(rng.range(2, Math.min(len - 2, 9)));
          rollPaper(a.x, a.z, dx, dz, 0.6);
        }
      }
    });
  }

  // ---------- low boundary walls (exact faces): grime along the foot ----------
  for (const w of world.walls) {
    if (w.kind !== 'wall' || w.look !== 'boundary') continue;
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (len < 2.5 || !rng.chance(0.7 * D)) continue;
    boundaryWall(w, len);
  }
  function boundaryWall(w: Wall, len: number): void {
    const tx = (w.bx - w.ax) / len;
    const tz = (w.bz - w.az) / len;
    // Seen from the drivable side (the normal side) "right" runs a -> b (see blocks.ts: block on the right of travel).
    const base = Math.min(h(w.ax, w.az), h(w.bx, w.bz));
    const gl = Math.min(len - 0.2, 6);
    piece('grime', 0, (w.ax + w.bx) / 2, (w.az + w.bz) / 2, tx, tz, w.nx, w.nz, gl, base - 0.05, base + 0.4);
  }

  // ---------- street fronts: grime along the base of the shopfronts ----------
  if (!probe.empty) {
    g.edges.forEach((e, ei) => {
      if (e.kind === 'backAlley' || e.kind === 'alley' || !rng.chance(0.6 * D)) return;
      const m = world.blocks.mouths[ei];
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z) || 1;
      const ux = (B.x - A.x) / len;
      const uz = (B.z - A.z) / len;
      // P side is left of a -> b; its building lies further left.
      grimeAlong(m.aP.outer.x, m.aP.outer.z, m.bP.outer.x, m.bP.outer.z, -uz, ux, 0.45);
      grimeAlong(m.aN.outer.x, m.aN.outer.z, m.bN.outer.x, m.bN.outer.z, uz, -ux, 0.45);
    });
  }

  // ---------- blade signs over the sidewalks ----------
  const neon = NEON_COLORS.map((c) => new THREE.Color(c));
  if (!probe.empty) {
    const cw = 1 / BLADE_SIGN_COLS;
    const ch = 1 / BLADE_SIGN_ROWS;
    for (const b of world.blocks.buildings) {
      if (b.w < 8 || !rng.chance(DRESS.bladeChance * D)) continue;
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      const wx = Math.sin(b.yaw);
      const wz = Math.cos(b.yaw);
      // Front face (toward the street) and the collision wall line 1.3 m in front of it.
      const fx = b.x - wx * (b.d / 2);
      const fz = b.z - wz * (b.d / 2);
      const signs = b.w > 22 && rng.chance(0.5) ? 2 : 1;
      for (let k = 0; k < signs; k++) {
        const s = (b.w / 2) * rng.range(-0.7, 0.7);
        const px = fx + ux * s - wx * 1.3;
        const pz = fz + uz * s - wz * 1.3;
        const y = h(px, pz) + CITY.curbHeight + DRESS.bladeY;
        const hit = probe.probe(px, pz, y, wx, wz, 1.6);
        if (!hit || y + DRESS.bladeH / 2 + 0.1 > hit.y1) continue;
        const sx = px + wx * hit.d;
        const sz = pz + wz * hit.d;
        const idx = rng.int(0, BLADE_SIGN_TEXTS.length - 1);
        const u0 = (idx % BLADE_SIGN_COLS) * cw;
        const v1 = 1 - Math.floor(idx / BLADE_SIGN_COLS) * ch;
        const col = neon[rng.int(0, neon.length - 1)];
        // Panel in the plane of the face normal: visible walking either way down the sidewalk.
        const o0 = DRESS.bladeOut[0];
        const o1 = DRESS.bladeOut[1];
        const y0 = y - DRESS.bladeH / 2;
        const y1 = y + DRESS.bladeH / 2;
        const tx = hit.tx;
        const tz = hit.tz;
        const ox = -wx;
        const oz = -wz;
        // Two single sided quads back to back, each reading the right way round: seen from the -t side
        // the viewer's right runs out from the wall, from the +t side it runs toward it.
        for (const side of [1, -1]) {
          const nx = tx * side;
          const nz = tz * side;
          const ex = nx * 0.015;
          const ez = nz * 0.015;
          const uNear = side > 0 ? u0 + cw : u0;
          const uFar = side > 0 ? u0 : u0 + cw;
          const a = blades.vertex(sx + ox * o0 + ex, y0, sz + oz * o0 + ez, nx, 0, nz, uNear, v1 - ch, col);
          const bb = blades.vertex(sx + ox * o1 + ex, y0, sz + oz * o1 + ez, nx, 0, nz, uFar, v1 - ch, col);
          const c = blades.vertex(sx + ox * o1 + ex, y1, sz + oz * o1 + ez, nx, 0, nz, uFar, v1, col);
          const d = blades.vertex(sx + ox * o0 + ex, y1, sz + oz * o0 + ez, nx, 0, nz, uNear, v1, col);
          blades.quadFacing(a, bb, c, d, nx, 0, nz);
        }
        // Bracket: a dark bar from the wall into the panel's top edge.
        const bar = new THREE.Color(0x1a1a1f);
        orientedBox(boxes, sx - tx * 0.03, sz - tz * 0.03, sx + tx * 0.03, sz + tz * 0.03, ox * (o0 + 0.25), oz * (o0 + 0.25), y1 - 0.04, y1 + 0.02, bar);
        orientedBox(boxes, sx - tx * 0.03, sz - tz * 0.03, sx + tx * 0.03, sz + tz * 0.03, ox * (o0 + 0.25), oz * (o0 + 0.25), y0 - 0.02, y0 + 0.04, bar);
      }
    }
  }

  // ---------- banners across the route ----------
  if (!probe.empty && opts.banners > 0) {
    const route = world.route;
    const stations: number[] = [];
    for (const bg of world.barrierGroups) {
      const rp = world.routeProgress(bg.x, bg.z);
      stations.push(rp.s - 18);
    }
    stations.push(route.startS - 45, route.finishS - 60);
    rng.shuffle(stations);
    const placed: number[] = [];
    for (const s of stations) {
      if (placed.length >= opts.banners) break;
      if (placed.some((p) => Math.abs(p - s) < DRESS.bannerGap)) continue;
      const smp = routeSample(route, s);
      const half = route.segWidth[smp.seg] / 2;
      if (half < 5.5) continue;
      const lx = -smp.tz;
      const lz = smp.tx;
      const lat = half + CITY.sidewalk;
      const y = h(smp.x, smp.z) + DRESS.bannerY;
      const L = probe.probe(smp.x + lx * lat, smp.z + lz * lat, y, lx, lz, 1.8);
      const lHit = L ? { x: smp.x + lx * (lat + L.d), z: smp.z + lz * (lat + L.d) } : null;
      const R = probe.probe(smp.x - lx * lat, smp.z - lz * lat, y, -lx, -lz, 1.8);
      if (!lHit || !R) continue;
      const rHit = { x: smp.x - lx * (lat + R.d), z: smp.z - lz * (lat + R.d) };
      banner(lHit.x, lHit.z, rHit.x, rHit.z, y, rng.int(0, 1));
      placed.push(s);
    }
  }
  function banner(ax: number, az: number, bx: number, bz: number, y: number, i: number): void {
    const span = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / span;
    const uz = (bz - az) / span;
    const cell = wallCell('banner', i);
    const textW = DRESS.bannerH * (cell.w / cell.h);
    const nx = -uz;
    const nz = ux;
    const drop = (t: number) => y - DRESS.bannerSag * 4 * t * (1 - t);
    // Three parts: plain cloth, the text panel, plain cloth; the cloth samples the cell's left edge.
    const parts: [number, number, number, number][] = [
      [0, (span - textW) / 2, 0, 0.04],
      [(span - textW) / 2, (span + textW) / 2, 0, 1],
      [(span + textW) / 2, span, 0, 0.04],
    ];
    for (const [s0, s1, u0, u1] of parts) {
      const n = Math.max(1, Math.ceil((s1 - s0) / 1.5));
      for (let k = 0; k < n; k++) {
        const t0 = s0 + ((s1 - s0) * k) / n;
        const t1 = s0 + ((s1 - s0) * (k + 1)) / n;
        const uv = uvOf(cell, u0 + ((u1 - u0) * k) / n, u0 + ((u1 - u0) * (k + 1)) / n);
        const y0a = drop(t0 / span) - DRESS.bannerH / 2;
        const y0b = drop(t1 / span) - DRESS.bannerH / 2;
        const a = paint.vertex(ax + ux * t0, y0a, az + uz * t0, nx, 0, nz, uv.u0, uv.v0);
        const b = paint.vertex(ax + ux * t1, y0b, az + uz * t1, nx, 0, nz, uv.u1, uv.v0);
        const c = paint.vertex(ax + ux * t1, y0b + DRESS.bannerH, az + uz * t1, nx, 0, nz, uv.u1, uv.v1);
        const d = paint.vertex(ax + ux * t0, y0a + DRESS.bannerH, az + uz * t0, nx, 0, nz, uv.u0, uv.v1);
        paint.quadFacing(a, b, c, d, nx, 0, nz);
      }
    }
    // Ropes to the walls.
    const rope = new THREE.Color(0x121216);
    for (const [x, z] of [
      [ax, az],
      [bx, bz],
    ]) {
      orientedBox(boxes, x - ux * 0.01, z - uz * 0.01, x + ux * 0.01, z + uz * 0.01, nx * 0.02, nz * 0.02, y - 0.1, y + DRESS.bannerH / 2 + 0.25, rope);
    }
  }

  const meshes: THREE.Mesh[] = [];
  if (paint.vertexCount) {
    // Paint is lit by the street like the wall it is on; a trace of self light keeps the paper of a
    // poster readable in an unlit alley without turning any of it into backlit signage.
    const mat = new THREE.MeshStandardMaterial({
      map: atlases.walls,
      emissiveMap: atlases.walls,
      emissive: 0xffffff,
      emissiveIntensity: 0.04,
      roughness: 0.85,
      metalness: 0,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const m = new THREE.Mesh(paint.build(), mat);
    m.name = 'wallPaint';
    meshes.push(m);
  }
  if (boxes.vertexCount) {
    const m = new THREE.Mesh(boxes.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.15 }));
    m.name = 'wallBoxes';
    meshes.push(m);
  }
  if (blades.vertexCount) {
    const mat = new THREE.MeshBasicMaterial({ map: atlases.blades, vertexColors: true });
    mat.color.setScalar(2.4);
    fadeSubPixel(mat, 0.5, 0.25);
    const m = new THREE.Mesh(blades.build(), mat);
    m.name = 'bladeSigns';
    meshes.push(m);
  }
  return {
    meshes,
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}
