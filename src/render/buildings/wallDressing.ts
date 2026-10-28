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
 * behind the collision wall line, banners cross at 4.8 to 6.6 m, and the rest is
 * flat on a facade. The facades stand an unknown few decimetres behind the
 * collision walls (podium extrusions), so every piece is placed by probing
 * the drawn podium geometry (wallProbe.ts) and a banner spans facade to facade, or post to post
 * where the route runs through open ground with no facades (most closures); without that geometry only the
 * infill's low boundary walls, whose face is exact, get grimed. Four draw
 * calls: paint (one atlas), banner cloth (two faces, front-face only so the text reads forward from both
 * sides), boxes, blade signs. Seeded, render only.
 *
 * The odds are not the same on every street: the race route is the city's main
 * drag (street/routeNearness.ts), so blade signs, paper and banners lean toward
 * it (about 1.6x on the route's street, 0.6x on a side street, softened by the
 * home's drag strength) and the city total stays about where it was.
 *
 * A New York home also leans a few news stands against the fronts of its corner buildings (cityIdentity.ts
 * `newsStand`): a dark kiosk box with a red canopy and a rack of magazines, tucked into the sidewalk strip
 * behind the collision wall, so no car can reach it. Its own stream; nothing else moves.
 */
import * as THREE from 'three';
import type { Contact, World } from '../../city/world';
import type { Building, Wall } from '../../city/blocks';
import { corridorClearance, insideBuilding } from '../../city/blocks';
import { CITY } from '../../city/config';
import { routeSample } from '../../city/route';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { orientedBox } from '../districts/kit';
import { FacadeProbe, ProbeHit } from './wallProbe';
import { fadeSubPixel } from '../materialFx';
import { AtlasCell, BLADE_SIGN_COLS, BLADE_SIGN_ROWS, BLADE_SLOTS, NEON_COLORS, WALL_ATLAS, WallKind, wallCell } from '../textures/textures';
import { neonMood } from '../textures/cityMood';
import { FlickList, SIGNAGE, applyFlicker } from '../street/signage';
import { DRAG, routeNearness } from '../street/routeNearness';
import { signatureAt } from '../cityIdentity';
import { regionAt } from './architecture';

export interface WallDressingOptions {
  /** Share of candidate walls and faces that get dressed (graphics tier). */
  density: number;
  /** Banners across the route (count cap). */
  banners: number;
}

export interface WallDressing {
  meshes: THREE.Mesh[];
  /** The blade signs' glow: the centre of each panel (m, world) and its neon colour, for the wet street's reflection streaks (street/lightFx.ts). */
  lights: { pos: THREE.Vector3; color: THREE.Color }[];
  /** What was placed, for the perf report and tests. */
  counts: { blades: number; posters: number; flyers: number; banners: number; newsStands: number };
  dispose(): void;
}

/** News stands: footprint (width, depth) and height (m), the cap per city and how far in from the corner (m) they stand. */
const NEWS = { w: 1.3, d: 0.5, h: 1.9, max: 24, inset: 1.6 } as const;

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
  /**
   * Banners: heights over the road to try, highest first (m; 4.8 m minus the sag still clears a truck and
   * every gantry hangs above 6.5 m), sag (m), spacing along the route (m). Whatever the height, a banner
   * only ever spans from facade to facade or post to post, beyond the sidewalk: it crosses over the road
   * and never touches it.
   */
  bannerYs: [6.6, 6.0, 5.4, 4.8],
  bannerSag: 0.7,
  bannerH: 1.15,
  bannerGap: 140,
  /** Banner posts, used where no two facades face each other: thickness (m), distance beyond the outer sidewalk line (m), widest ground height difference to the road (m). */
  postW: 0.18,
  postOut: 0.4,
  postRise: 1.2,
  /** A post is drawn only where the sim has a wall or solid within this radius of it (m). */
  postBacking: 0.5,
  /** No car centre may fit within this distance of a post (m), tested with a car's collision radius (m). */
  postKeep: 0.9,
  carRadius: 0.85,
} as const;

const SEED = 0x5a11;

/** Surfaces a banner post may stand on: anywhere but the road itself and water. */
const POST_GROUND: ReadonlySet<string> = new Set(['sidewalk', 'concrete', 'quay', 'boardwalk', 'sand', 'cobble', 'grass', 'offroad']);

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
  /** The banners' cloth, both faces (own mesh: front-face only material, see banner()). */
  const cloth = new GeoBuilder(true);
  const blades = new GeoBuilder(true);
  const bladeFlick = new FlickList(world, 'blade');
  const lights: { pos: THREE.Vector3; color: THREE.Color }[] = [];
  const WHITE = new THREE.Color(1, 1, 1);
  const D = opts.density;
  const near = routeNearness(world);
  const contacts: Contact[] = [];
  /** Something stands at (x, z) (a wall within postBacking) and no car centre fits within postKeep of it (ring of probes with a car's radius), so a car never meets the post. */
  const postBacked = (x: number, z: number): boolean => {
    if (world.collideCircle(x, z, DRESS.postBacking, contacts) === 0) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (world.collideCircle(x + Math.cos(a) * DRESS.postKeep, z + Math.sin(a) * DRESS.postKeep, DRESS.carRadius, contacts) === 0) return false;
    }
    return true;
  };
  const counts = { blades: 0, posters: 0, flyers: 0, banners: 0, newsStands: 0 };
  /** Paper density at a spot: more on the drag, less down the side streets (never so low that a step runs away). */
  const paperAt = (x: number, z: number) => Math.max(0.15, near.scale(DRAG.paper, x, z));

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
  /** A fractional count rounded at random, so a 1.6x odds on a count of 2 gives 3 or 4 and the mean is exact. */
  const stochastic = (n: number): number => Math.floor(n) + (rng.chance(n - Math.floor(n)) ? 1 : 0);
  /** A station on a wall: a poster or a sheet of flyers, or (most often) nothing, so the paper stays sparse. */
  const rollPaper = (px: number, pz: number, dx: number, dz: number, busy: number) => {
    const r = rng.next();
    if (r >= 0.74 * busy && r < 0.88 * busy) {
      const hh = rng.range(DRESS.posterH[0], DRESS.posterH[1]);
      if (probedPiece('poster', rng.int(0, 3), px, pz, dx, dz, rng.range(1.3, 2.0), hh, hh * (256 / 192))) counts.posters++;
    } else if (r < busy) {
      const hh = rng.range(DRESS.flyersH[0], DRESS.flyersH[1]);
      if (probedPiece('flyers', rng.int(0, 1), px, pz, dx, dz, rng.range(1.1, 1.8), hh, hh)) counts.flyers++;
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
          for (let s = rng.range(8, 12); s < len - 8; ) {
            const px = A.x + ux * s + dx * lat;
            const pz = A.z + uz * s + dz * lat;
            rollPaper(px, pz, dx, dz, busy);
            s += rng.range(DRESS.alleyStep[0], DRESS.alleyStep[1]) / (D * paperAt(px, pz));
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
          const pieces = stochastic(rng.int(1, 3) * paperAt(b.x, b.z));
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
        } else if (rng.chance(0.35 * paperAt(b.x, b.z))) {
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
  const mood = neonMood(world.seed);
  if (!probe.empty) {
    const cw = 1 / BLADE_SIGN_COLS;
    const ch = 1 / BLADE_SIGN_ROWS;
    for (const b of world.blocks.buildings) {
      if (b.w < 8 || !rng.chance(Math.min(1, DRESS.bladeChance * D * near.scale(DRAG.blades, b.x, b.z)))) continue;
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
        const idx = rng.int(0, BLADE_SLOTS - 1);
        const u0 = (idx % BLADE_SIGN_COLS) * cw;
        const v1 = 1 - Math.floor(idx / BLADE_SIGN_COLS) * ch;
        const col = neon[mood.neon(rng.next())];
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
        const fl = bladeFlick.roll(SIGNAGE.flickerBlade);
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
        bladeFlick.fill(blades.vertexCount, fl);
        counts.blades++;
        lights.push({ pos: new THREE.Vector3(sx + ox * ((o0 + o1) / 2), y, sz + oz * ((o0 + o1) / 2)), color: col });
        // Bracket: a dark bar from the wall into the panel's top edge.
        const bar = new THREE.Color(0x1a1a1f);
        orientedBox(boxes, sx - tx * 0.03, sz - tz * 0.03, sx + tx * 0.03, sz + tz * 0.03, ox * (o0 + 0.25), oz * (o0 + 0.25), y1 - 0.04, y1 + 0.02, bar);
        orientedBox(boxes, sx - tx * 0.03, sz - tz * 0.03, sx + tx * 0.03, sz + tz * 0.03, ox * (o0 + 0.25), oz * (o0 + 0.25), y0 - 0.02, y0 + 0.04, bar);
      }
    }
  }

  // ---------- news stands on the corner fronts (a New York home) ----------
  if (!probe.empty) {
    const region = regionAt(world);
    const news = new Rng(deriveSeed(world.seed, 'newsStands'));
    const scratchNews: number[] = [];
    for (const b of world.blocks.buildings) {
      const odds = signatureAt(world.seed, region(b.x, b.z)).newsStand;
      if (odds === undefined || counts.newsStands >= NEWS.max || b.w < 8) continue;
      // The draws are taken for every building of the home, so one corner's fate never shifts another's.
      const wanted = news.chance(odds * D);
      const endSign = news.chance(0.5) ? 1 : -1;
      if (!wanted) continue;
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      const wx = Math.sin(b.yaw);
      const wz = Math.cos(b.yaw);
      // A corner: the street runs past the end of the front on the stand's side.
      const endX = b.x + ux * (b.w / 2 + 1.6) * endSign - wx * (b.d / 2);
      const endZ = b.z + uz * (b.w / 2 + 1.6) * endSign - wz * (b.d / 2);
      if (corridorClearance(g, world.blocks.edgeGrid, endX, endZ, scratchNews) >= 1.5) continue;
      const s = (b.w / 2 - NEWS.inset) * endSign;
      const px = b.x + ux * s - wx * (b.d / 2 + 1.3);
      const pz = b.z + uz * s - wz * (b.d / 2 + 1.3);
      const ground = h(px, pz) + CITY.curbHeight;
      const hit = probe.probe(px, pz, ground + 1, wx, wz, 1.6);
      // Behind the collision wall line with room to spare, and a flat stretch wide enough for the kiosk.
      if (!hit || hit.d < NEWS.d + 0.05 || Math.min(hit.left, hit.right) < NEWS.w / 2 + 0.2 || hit.y1 < ground + NEWS.h + 0.3) continue;
      const x = px + wx * hit.d;
      const z = pz + wz * hit.d;
      const ox = -wx * NEWS.d;
      const oz = -wz * NEWS.d;
      const hw = NEWS.w / 2;
      orientedBox(boxes, x - hit.tx * hw, z - hit.tz * hw, x + hit.tx * hw, z + hit.tz * hw, ox, oz, ground, ground + NEWS.h, new THREE.Color(0x24382c));
      // The canopy: a red slab on top, a little wider and deeper than the box.
      orientedBox(boxes, x - hit.tx * (hw + 0.1), z - hit.tz * (hw + 0.1), x + hit.tx * (hw + 0.1), z + hit.tz * (hw + 0.1), ox * 1.25, oz * 1.25, ground + NEWS.h, ground + NEWS.h + 0.12, new THREE.Color(0x9a2420));
      // The rack: magazines and papers pasted on the front.
      piece('flyers', news.int(0, 1), x + hit.nx * NEWS.d, z + hit.nz * NEWS.d, hit.tx, hit.tz, hit.nx, hit.nz, NEWS.w * 0.82, ground + 0.55, ground + 1.55);
      counts.newsStands++;
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
    // The drag carries more of them: a cap and a spacing that scale with the home's gradient, and a station
    // every so often along the route once the closures and the start are used up.
    const lift = near.onRoute(DRAG.banners);
    const cap = Math.round(opts.banners * lift);
    const gap = DRESS.bannerGap / lift;
    if (lift > 1) {
      const extra: number[] = [];
      for (let s = rng.range(0, gap); s < route.length; s += gap) extra.push(s);
      rng.shuffle(extra);
      stations.push(...extra);
    }
    const placed: number[] = [];
    for (const s of stations) {
      if (placed.length >= cap) break;
      if (placed.some((p) => Math.abs(p - s) < gap)) continue;
      const smp = routeSample(route, s);
      const half = route.segWidth[smp.seg] / 2;
      if (half < 5.5) continue;
      const lx = -smp.tz;
      const lz = smp.tx;
      const lat = half + CITY.sidewalk;
      const g0 = h(smp.x, smp.z);
      // Facade to facade at the highest height both podiums reach (a podium is only 4.4 m on a ground floor
      // building, 7.7 m and up with floors); the route's open stretches (highway, park, river
      // bank) have no facades at all, so there it is post to post beyond the sidewalk.
      let span: { ax: number; az: number; bx: number; bz: number; y: number } | null = null;
      for (const up of DRESS.bannerYs) {
        const y = g0 + up;
        const L = probe.probe(smp.x + lx * lat, smp.z + lz * lat, y, lx, lz, 1.8);
        if (!L) continue;
        const lHit = { x: smp.x + lx * (lat + L.d), z: smp.z + lz * (lat + L.d) };
        const R = probe.probe(smp.x - lx * lat, smp.z - lz * lat, y, -lx, -lz, 1.8);
        if (!R) continue;
        span = { ax: lHit.x, az: lHit.z, bx: smp.x - lx * (lat + R.d), bz: smp.z - lz * (lat + R.d), y };
        break;
      }
      if (!span) {
        const out = lat + DRESS.postOut;
        const ax = smp.x + lx * out;
        const az = smp.z + lz * out;
        const bx = smp.x - lx * out;
        const bz = smp.z - lz * out;
        const ga = h(ax, az);
        const gz = h(bx, bz);
        if (Math.abs(ga - g0) > DRESS.postRise || Math.abs(gz - g0) > DRESS.postRise) continue;
        if (!POST_GROUND.has(world.surfaceAt(ax, az)) || !POST_GROUND.has(world.surfaceAt(bx, bz))) continue;
        // A drawn post must have a sim wall or solid behind it, or a car could drive through it (a ghost): the
        // open ground of a park, plaza or river bank has none, so those stations get no banner.
        const pa = postBacked(ax, az);
        const pb = postBacked(bx, bz);
        if (!pa || !pb) continue;
        const y = g0 + DRESS.bannerYs[0];
        span = { ax, az, bx, bz, y };
        const dark = new THREE.Color(0x1d1d22);
        for (const [x, z, gy] of [[ax, az, ga], [bx, bz, gz]]) {
          orientedBox(boxes, x - smp.tx * DRESS.postW / 2, z - smp.tz * DRESS.postW / 2, x + smp.tx * DRESS.postW / 2, z + smp.tz * DRESS.postW / 2, lx * DRESS.postW, lz * DRESS.postW, gy - 0.2, y + DRESS.bannerH / 2 + 0.3, dark);
        }
      }
      banner(span.ax, span.az, span.bx, span.bz, span.y, rng.int(0, 1));
      counts.banners++;
      placed.push(s);
    }
  }
  function banner(ax: number, az: number, bx: number, bz: number, y: number, i: number): void {
    const span = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / span;
    const uz = (bz - az) / span;
    const cell = wallCell('banner', i);
    const textW = DRESS.bannerH * (cell.w / cell.h);
    const drop = (t: number) => y - DRESS.bannerSag * 4 * t * (1 - t);
    // Three parts: plain cloth, the text panel, plain cloth; the cloth samples the cell's left edge.
    const parts: [number, number, number, number][] = [
      [0, (span - textW) / 2, 0, 0.04],
      [(span - textW) / 2, (span + textW) / 2, 0, 1],
      [(span + textW) / 2, span, 0, 0.04],
    ];
    // A face each way (the cloth material is front-face only, so exactly one shows from either side). The
    // side whose reader runs against the cloth gets the lettered panel's u mirrored, so the text reads
    // forward from both sides; a single double-sided quad shows its back mirrored.
    for (const side of [1, -1]) {
      const nx = -uz * side;
      const nz = ux * side;
      // This face reads along (nz, -nx); the text runs with the cloth (+u) when that is along +t.
      const forward = nz * ux - nx * uz > 0;
      parts.forEach(([s0, s1, u0, u1], part) => {
        const n = Math.max(1, Math.ceil((s1 - s0) / 1.5));
        for (let k = 0; k < n; k++) {
          const t0 = s0 + ((s1 - s0) * k) / n;
          const t1 = s0 + ((s1 - s0) * (k + 1)) / n;
          const f0 = u0 + ((u1 - u0) * k) / n;
          const f1 = u0 + ((u1 - u0) * (k + 1)) / n;
          const [q0, q1] = part === 1 && !forward ? [1 - f0, 1 - f1] : [f0, f1];
          const uv = uvOf(cell, q0, q1);
          const y0a = drop(t0 / span) - DRESS.bannerH / 2;
          const y0b = drop(t1 / span) - DRESS.bannerH / 2;
          const a = cloth.vertex(ax + ux * t0, y0a, az + uz * t0, nx, 0, nz, uv.u0, uv.v0);
          const b = cloth.vertex(ax + ux * t1, y0b, az + uz * t1, nx, 0, nz, uv.u1, uv.v0);
          const c = cloth.vertex(ax + ux * t1, y0b + DRESS.bannerH, az + uz * t1, nx, 0, nz, uv.u1, uv.v1);
          const d = cloth.vertex(ax + ux * t0, y0a + DRESS.bannerH, az + uz * t0, nx, 0, nz, uv.u0, uv.v1);
          cloth.quadFacing(a, b, c, d, nx, 0, nz);
        }
      });
    }
    const nx = -uz;
    const nz = ux;
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
  if (cloth.vertexCount) {
    // Same paint as the posters, but front faces only: the banner carries its own mirrored back face.
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
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const m = new THREE.Mesh(cloth.build(), mat);
    m.name = 'wallBanners';
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
    applyFlicker(mat);
    const bladeGeo = blades.build();
    bladeGeo.setAttribute('aFlick', bladeFlick.attribute(blades.vertexCount));
    const m = new THREE.Mesh(bladeGeo, mat);
    m.name = 'bladeSigns';
    meshes.push(m);
  }
  return {
    meshes,
    lights,
    counts,
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        // A chunked layer (cityChunks.ts) carries its one material in an array.
        for (const mat of ([] as THREE.Material[]).concat(m.material)) mat.dispose();
      }
    },
  };
}
