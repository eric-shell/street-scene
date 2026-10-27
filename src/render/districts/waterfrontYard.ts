/**
 * The dock yard on a harbor's quay (city/districts/waterfrontYard.ts), drawn from the build's walls and
 * hints so what stands is what the sim collides with:
 *  - containers ('container' solids): stacked one to three high on their outline, corrugated, rust at the
 *    foot, locking bars on the doors and a shipping line's mark on each long side from a canvas atlas; the
 *    liveries are the seed's own (containerLiveries, shared with the jetties' stacks and the ships);
 *  - forklifts ('forklift' solids): body, counterweight, overhead guard, mast and forks, an amber beacon,
 *    all inside the footprint;
 *  - the gate posts at every mouth ('quayPost' solids), hazard banded at the foot, with a string of the
 *    shortcut bulbs swagged between them, and the mouth's cobbles (the sim's 'cobble' patch) as setts;
 *  - the loading ramps' hazard bands at their toes and crests, and the yard's wear: puddles, oil stains
 *    and tyre marks in the paint layer;
 *  - gulls: a few perched on the railing posts and the container tops, and a flock wheeling over the water.
 * The destructibles (fences, drums, pallets, spools, bollards, benches, lanterns) are props
 * (render/street/props.ts). Everything merges into the kit's builders except the marks (one textured mesh
 * per harbor) and the flock (one small mesh turned on the scene clock: one rotation per frame). The marks
 * and the corrugation are left out on Low. Render only.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Wall } from '../../city/blocks';
import type { Area, AreaBuild } from '../../city/districts/types';
import { coastNormal, coastV, framePoint, frameU, harborFrame, waterLevel } from '../../city/districts/waterfrontShape';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { drawTexture } from '../textures/canvasKit';
import type { DistrictKit } from './kit';
import { col, groundLine, groundVertex, stringLights } from './kit';

const Y = CITY.districts.waterfront.yard;

/** The yard's dressing: sizes (m) and tints. */
export const YARD_LOOK = {
  /** A container's height per tier and the gap between tiers (m); ribs every `rib` m along the long sides. */
  tier: 2.59,
  tierGap: 0.04,
  rib: 0.6,
  rust: col(0x5a3018),
  castings: col(0x1c1d20),
  /** The shipping lines' marks: the atlas's cells (columns x rows), a mark's size on a container side (m). */
  marks: { cols: 4, rows: 2, w: 5.2, h: 1.3 },
  /** Container colours a seed draws its liveries from. */
  palette: [0x8a2a1e, 0x1f4f8a, 0x2a6a3a, 0xb06a1a, 0x7a7c80, 0xc8c8c0, 0x6a1a5a, 0xa88a2a, 0x1e6a70, 0x3a3c8a, 0xc04a6a, 0x4a5a2a, 0x2a2c30, 0xd8b030],
  /** Liveries per seed: a colour and a mark each. */
  liveries: 6,
  forklift: [col(0xf2a81c), col(0xe85a1a), col(0x2a6ab0), col(0xd8d020)],
  forkSteel: col(0x2a2c30),
  beacon: col(0xffa21a, 2.4),
  post: col(0x2a2d33),
  hazard: [col(0xf2c21c, 0.9), col(0x15161a)],
  /** Gate posts: their height (m) and the string's sag (m). */
  postHeight: 6.2,
  stringSag: 0.9,
  sett: col(0x4a4844),
  settLine: col(0x2a2826),
  puddle: col(0x070b12),
  oil: col(0x0c0a08),
  rubber: col(0x0a0a0c),
  gull: col(0xe8e8e4),
  gullWing: col(0x9aa0a8),
  beak: col(0xe8b020),
} as const;

/** A seed's container liveries: colours drawn from the palette without repeats, each with a shipping line's mark. */
export function containerLiveries(seed: number): { color: THREE.Color; mark: number }[] {
  const rng = new Rng((seed ^ 0x6c0ffee) >>> 0 || 1);
  const pool = YARD_LOOK.palette.slice();
  const cells = YARD_LOOK.marks.cols * YARD_LOOK.marks.rows;
  const out: { color: THREE.Color; mark: number }[] = [];
  for (let k = 0; k < YARD_LOOK.liveries; k++) {
    const c = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    out.push({ color: col(c), mark: rng.int(0, cells - 1) });
  }
  return out;
}

/** The fictional shipping lines' marks (one per atlas cell): a name and a device drawn white on clear. */
const LINES: readonly { name: string; device: 'ring' | 'diamond' | 'wave' | 'star' | 'bars' | 'anchor' | 'sun' | 'chevron' }[] = [
  { name: 'MERIDIAN', device: 'ring' },
  { name: 'NORDKAPP', device: 'star' },
  { name: 'KAIROS LINE', device: 'diamond' },
  { name: 'TASMAN', device: 'wave' },
  { name: 'HALCYON', device: 'sun' },
  { name: 'CAPSTAN', device: 'anchor' },
  { name: 'BLUE WHARF', device: 'bars' },
  { name: 'OSTRA', device: 'chevron' },
];

/** The marks atlas (null without a DOM: headless builds draw no marks). */
function marksTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const M = YARD_LOOK.marks;
  const cw = 256;
  const ch = 64;
  return drawTexture(cw * M.cols, ch * M.rows, (g) => {
    g.clearRect(0, 0, cw * M.cols, ch * M.rows);
    g.fillStyle = '#f2f2ee';
    g.strokeStyle = '#f2f2ee';
    LINES.forEach((l, i) => {
      const x0 = (i % M.cols) * cw;
      const y0 = Math.floor(i / M.cols) * ch;
      const cx = x0 + 32;
      const cy = y0 + ch / 2;
      g.lineWidth = 5;
      g.beginPath();
      if (l.device === 'ring') g.arc(cx, cy, 20, 0, Math.PI * 2);
      else if (l.device === 'diamond') {
        g.moveTo(cx, cy - 22);
        g.lineTo(cx + 18, cy);
        g.lineTo(cx, cy + 22);
        g.lineTo(cx - 18, cy);
        g.closePath();
      } else if (l.device === 'wave') for (let k = 0; k < 3; k++) {
        g.moveTo(cx - 22, cy - 12 + k * 12);
        g.bezierCurveTo(cx - 10, cy - 20 + k * 12, cx + 4, cy - 4 + k * 12, cx + 22, cy - 12 + k * 12);
      }
      else if (l.device === 'star') for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;
        if (k) g.lineTo(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22);
        else g.moveTo(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22);
      }
      else if (l.device === 'bars') for (let k = 0; k < 3; k++) g.rect(cx - 20 + k * 15, cy - 20, 8, 40);
      else if (l.device === 'anchor') {
        g.moveTo(cx, cy - 20);
        g.lineTo(cx, cy + 18);
        g.moveTo(cx - 12, cy - 10);
        g.lineTo(cx + 12, cy - 10);
        g.arc(cx, cy + 4, 16, 0, Math.PI);
      } else if (l.device === 'sun') {
        g.arc(cx, cy, 11, 0, Math.PI * 2);
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          g.moveTo(cx + Math.cos(a) * 16, cy + Math.sin(a) * 16);
          g.lineTo(cx + Math.cos(a) * 24, cy + Math.sin(a) * 24);
        }
      } else {
        g.moveTo(cx - 20, cy + 12);
        g.lineTo(cx, cy - 12);
        g.lineTo(cx + 20, cy + 12);
      }
      g.stroke();
      g.font = 'bold 30px Arial, sans-serif';
      g.textBaseline = 'middle';
      g.fillText(l.name, x0 + 66, cy + 1, cw - 74);
    });
  }, { repeat: false });
}

/** A mark quad on a container side: centred at c, `along` its length, facing n, from y0 up M.h, atlas cell `cell`. */
export function markQuad(gb: GeoBuilder, c: Vec2, along: Vec2, n: Vec2, y0: number, cell: number): void {
  const M = YARD_LOOK.marks;
  const u0 = (cell % M.cols) / M.cols;
  const v1 = 1 - Math.floor(cell / M.cols) / M.rows;
  const u1 = u0 + 1 / M.cols;
  const v0 = v1 - 1 / M.rows;
  const hw = M.w / 2;
  // Seen from outside, the text reads left to right: its left end lies where `along` is turned from n.
  const s = along.x * n.z - along.z * n.x > 0 ? 1 : -1;
  const ax = c.x - along.x * hw * s + n.x * 0.03;
  const az = c.z - along.z * hw * s + n.z * 0.03;
  const bx = c.x + along.x * hw * s + n.x * 0.03;
  const bz = c.z + along.z * hw * s + n.z * 0.03;
  const v = [gb.vertex(ax, y0, az, n.x, 0, n.z, u0, v0), gb.vertex(bx, y0, bz, n.x, 0, n.z, u1, v0), gb.vertex(bx, y0 + M.h, bz, n.x, 0, n.z, u1, v1), gb.vertex(ax, y0 + M.h, az, n.x, 0, n.z, u0, v1)];
  gb.quadFacing(v[0], v[1], v[2], v[3], n.x, 0, n.z);
}

/** The marks collected over a harbor into one textured mesh (none without a DOM or on Low). */
export function marksMesh(kit: DistrictKit, gb: GeoBuilder): void {
  if (!gb.vertexCount || kit.quality === 'low') return;
  const map = marksTexture();
  if (!map) return;
  const mat = new THREE.MeshStandardMaterial({ map: kit.track(map), transparent: true, alphaTest: 0.35, roughness: 0.7, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const mesh = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
  mesh.name = 'harborMarks';
  kit.group.add(mesh);
}

/** The waterfront renderer's primitives the yard draws with (waterfront.ts owns them). */
export interface YardTools {
  boxAt(gb: GeoBuilder, x: number, y0: number, z: number, fx: number, fz: number, hl: number, hw: number, h: number, c: THREE.Color): void;
  beam(gb: GeoBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, c: THREE.Color): void;
  lamp(gb: GeoBuilder, x: number, y: number, z: number, s: number, c: THREE.Color): void;
}

/** A solid's outline as a box: centre, unit along its longer side, half length and half width. */
function boxOf(w: Wall): { c: Vec2; f: Vec2; hl: number; hw: number; poly: Vec2[] } {
  const poly = w.solid!.faces.map((q) => ({ x: q.ax, z: q.az }));
  let cx = 0;
  let cz = 0;
  for (const q of poly) {
    cx += q.x / poly.length;
    cz += q.z / poly.length;
  }
  const l0 = Math.hypot(poly[1].x - poly[0].x, poly[1].z - poly[0].z);
  const l1 = Math.hypot(poly[2].x - poly[1].x, poly[2].z - poly[1].z);
  const [a, b, along, across] = l0 >= l1 ? [poly[0], poly[1], l0, l1] : [poly[1], poly[2], l1, l0];
  return { c: { x: cx, z: cz }, f: { x: (b.x - a.x) / along, z: (b.z - a.z) / along }, hl: along / 2, hw: across / 2, poly };
}

/** Every solid of a look the area owns, once each. */
function solidsOf(kit: DistrictKit, a: Area, look: Parameters<DistrictKit['walls']['get']>[0]): Wall[] {
  const seen = new Set<Wall['solid']>();
  const out: Wall[] = [];
  for (const w of kit.walls.get(look) ?? []) {
    if (w.area !== a.id || !w.solid || seen.has(w.solid)) continue;
    seen.add(w.solid);
    out.push(w);
  }
  return out;
}

/** The yard of one harbor area (its build `b`) into the kit; `marks` collects the shipping lines' marks. */
export function drawYard(kit: DistrictKit, a: Area, b: AreaBuild, t: YardTools, liveries: { color: THREE.Color; mark: number }[], marks: GeoBuilder): void {
  const L = YARD_LOOK;
  const p = a.params;
  const curb = CITY.curbHeight;
  const low = kit.quality === 'low';
  const rng = new Rng((p.seed ^ 0x9a11) >>> 0 || 1);
  const ground = (x: number, z: number) => kit.h(x, z) + curb;
  const perches: { x: number; y: number; z: number; yaw: number }[] = [];

  // ----- Containers, tier on tier on the sim's outline.
  const hints = b.hints.filter((h) => h.kind === 'container');
  for (const w of solidsOf(kit, a, 'container')) {
    const bx = boxOf(w);
    const h = hints.find((q) => Math.hypot(q.points[0].x - bx.c.x, q.points[0].z - bx.c.z) < 0.2);
    const tiers = h ? h.values[1] : 1;
    const livery = h ? h.values[2] : 0;
    let y0 = -Infinity;
    for (const q of bx.poly) y0 = Math.max(y0, ground(q.x, q.z));
    const r = { x: bx.f.z, z: -bx.f.x };
    for (let k = 0; k < tiers; k++) {
      const lv = liveries[(livery + k * 5) % liveries.length];
      const y = y0 - 0.05 + k * (L.tier + L.tierGap);
      t.boxAt(kit.solid, bx.c.x, y, bx.c.z, bx.f.x, bx.f.z, bx.hl, bx.hw, L.tier, lv.color);
      // Rust bleeding up from the foot of the bottom box, corner castings at the top.
      if (k === 0) t.boxAt(kit.solid, bx.c.x, y, bx.c.z, bx.f.x, bx.f.z, bx.hl + 0.01, bx.hw + 0.01, 0.35, lv.color.clone().lerp(L.rust, 0.6));
      for (const s of [-1, 1]) for (const o of [-1, 1]) t.boxAt(kit.solid, bx.c.x + bx.f.x * s * (bx.hl - 0.15) + r.x * o * (bx.hw - 0.12), y + L.tier - 0.18, bx.c.z + bx.f.z * s * (bx.hl - 0.15) + r.z * o * (bx.hw - 0.12), bx.f.x, bx.f.z, 0.16, 0.13, 0.2, L.castings);
      if (!low) {
        // Corrugation: ribs down both long sides, a shade darker than the panels.
        const rib = lv.color.clone().multiplyScalar(0.72);
        for (let s = -bx.hl + L.rib; s < bx.hl - 0.2; s += L.rib) {
          for (const o of [-1, 1]) {
            const x = bx.c.x + bx.f.x * s + r.x * o * (bx.hw + 0.02);
            const z = bx.c.z + bx.f.z * s + r.z * o * (bx.hw + 0.02);
            t.boxAt(kit.solid, x, y + 0.1, z, bx.f.x, bx.f.z, 0.05, 0.025, L.tier - 0.25, rib);
          }
        }
        // The doors' locking bars at one end.
        for (const o of [-0.7, -0.25, 0.25, 0.7]) {
          const x = bx.c.x + bx.f.x * (bx.hl + 0.03) + r.x * o * bx.hw;
          const z = bx.c.z + bx.f.z * (bx.hl + 0.03) + r.z * o * bx.hw;
          t.beam(kit.solid, x, y + 0.15, z, x, y + L.tier - 0.15, z, 0.025, L.castings);
        }
        // A shipping line's mark on each long side.
        for (const o of [-1, 1]) markQuad(marks, { x: bx.c.x + r.x * o * (bx.hw + 0.03), z: bx.c.z + r.z * o * (bx.hw + 0.03) }, bx.f, { x: r.x * o, z: r.z * o }, y + 0.9, lv.mark);
      }
    }
    if (rng.chance(0.35)) perches.push({ x: bx.c.x + bx.f.x * rng.range(-bx.hl + 1, bx.hl - 1), y: y0 + tiers * (L.tier + L.tierGap), z: bx.c.z + bx.f.z * rng.range(-1, 1), yaw: rng.range(0, Math.PI * 2) });
  }

  // ----- Forklifts, inside their footprints.
  const lifts = b.hints.filter((h) => h.kind === 'forklift');
  for (const w of solidsOf(kit, a, 'forklift')) {
    const bx = boxOf(w);
    const h = lifts.find((q) => Math.hypot(q.points[0].x - bx.c.x, q.points[0].z - bx.c.z) < 0.2);
    // The forks point along the hint's yaw.
    const yaw = h ? h.values[0] : 0;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = fz;
    const rz = -fx;
    const tint = L.forklift[(h ? h.values[1] : 0) % L.forklift.length];
    const y = ground(bx.c.x, bx.c.z);
    const at = (s: number, o: number) => ({ x: bx.c.x + fx * s + rx * o, z: bx.c.z + fz * s + rz * o });
    const hw = bx.hw - 0.03;
    const q = at(-0.3, 0);
    t.boxAt(kit.solid, q.x, y + 0.2, q.z, fx, fz, 0.9, hw - 0.08, 0.8, tint);
    const cw = at(-1.05, 0);
    t.boxAt(kit.solid, cw.x, y + 0.15, cw.z, fx, fz, 0.22, hw - 0.04, 1.0, L.forkSteel);
    for (const s of [-0.7, 0.45]) {
      for (const o of [-1, 1]) {
        const wv = at(s, o * (hw - 0.14));
        t.boxAt(kit.solid, wv.x, y, wv.z, fx, fz, 0.27, 0.12, 0.5, L.forkSteel);
        const pv = at(s - 0.1, o * (hw - 0.12));
        t.beam(kit.solid, pv.x, y + 0.95, pv.z, pv.x, y + 2.1, pv.z, 0.035, L.forkSteel);
      }
    }
    const roof = at(-0.18, 0);
    t.boxAt(kit.solid, roof.x, y + 2.1, roof.z, fx, fz, 0.62, hw - 0.08, 0.06, L.forkSteel);
    t.lamp(kit.glow, roof.x, y + 2.25, roof.z, 0.16, L.beacon);
    for (const o of [-0.32, 0.32]) {
      const m = at(0.72, o);
      t.beam(kit.solid, m.x, y + 0.1, m.z, m.x, y + 2.4, m.z, 0.05, L.forkSteel);
      const k0 = at(0.82, o);
      const k1 = at(bx.hl - 0.05, o);
      t.beam(kit.solid, k0.x, y + 0.08, k0.z, k1.x, y + 0.08, k1.z, 0.04, L.forkSteel);
    }
  }

  // ----- Gate posts and the strings between them; the mouths' setts.
  const posts = solidsOf(kit, a, 'quayPost');
  for (const w of posts) {
    const bx = boxOf(w);
    const y = ground(bx.c.x, bx.c.z);
    t.boxAt(kit.solid, bx.c.x, y - 0.1, bx.c.z, bx.f.x, bx.f.z, bx.hl, bx.hw, L.postHeight + 0.1, L.post);
    for (let k = 0; k < 4; k++) t.boxAt(kit.solid, bx.c.x, y + k * 0.3, bx.c.z, bx.f.x, bx.f.z, bx.hl + 0.01, bx.hw + 0.01, 0.3, L.hazard[k % 2]);
    t.boxAt(kit.solid, bx.c.x, y + L.postHeight, bx.c.z, bx.f.x, bx.f.z, bx.hl + 0.06, bx.hw + 0.06, 0.08, L.post);
  }
  for (const h of b.hints) {
    if (h.kind !== 'quayMouth') continue;
    const [pa, pb] = h.points;
    stringLights(kit, pa, pb, { ya: ground(pa.x, pa.z) + L.postHeight - 0.25, yb: ground(pb.x, pb.z) + L.postHeight - 0.25, sag: L.stringSag });
    setts(kit, a, h.values[0], h.values[1]);
  }

  // ----- Ramps: hazard bands across at the toes and the crest lines.
  for (const h of b.hints) {
    if (h.kind !== 'ramp') continue;
    const [u0, span, dB, , run, top] = h.values;
    for (const u of [u0 + 0.6, u0 + run, u0 + run + top, u0 + span - 0.6]) hazardLine(kit, a, u, 0.9, dB - 1.2);
  }

  // ----- Wear: puddles, oil and tyre marks along the quay.
  if (!low) wear(kit, a, rng);

  // ----- Gulls: on the railing posts here and there, on the containers, and a flock over the water.
  for (const w of kit.walls.get('quayRail') ?? []) {
    if (w.area !== a.id || !rng.chance(0.06)) continue;
    perches.push({ x: w.ax, y: ground(w.ax, w.az) + 1.2, z: w.az, yaw: rng.range(0, Math.PI * 2) });
  }
  for (const g of perches) gull(kit, t, g.x, g.y, g.z, g.yaw, false);
  if (!low) flock(kit, t, a, rng);
}

/** The cobbles across a mouth at u, `w` wide, from the frontage onto the quay: a sett tint and joint lines. */
function setts(kit: DistrictKit, a: Area, um: number, w: number): void {
  const L = YARD_LOOK;
  const p = a.params;
  const f = harborFrame(a);
  const back = a.polygon.slice(0, p.nBack);
  // The back chain's v at u (the frontage), by its nearest column.
  const backV = (u: number) => {
    let best = back[0];
    for (const q of back) if (Math.abs(frameU(f, q.x, q.z) - u) < Math.abs(frameU(f, best.x, best.z) - u)) best = q;
    return best.x * f.vx + best.z * f.vz;
  };
  const lift = CITY.curbHeight + 0.01;
  const cols = 8;
  const rows = Math.ceil(Y.mouthDepth / 0.45);
  const grid: number[][] = [];
  for (let i = 0; i <= cols; i++) {
    const u = um - w / 2 + (w * i) / cols;
    const v0 = backV(u);
    const row: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const q = framePoint(f, u, v0 + (Y.mouthDepth * j) / rows);
      row.push(groundVertex(kit, kit.paint, q.x, q.z, lift, L.sett));
    }
    grid.push(row);
  }
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) kit.paint.quadFacing(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1], 0, 1, 0);
  // Joints: along the quay every row, across every 0.9 m.
  for (let j = 1; j < rows; j++) {
    const d = (Y.mouthDepth * j) / rows;
    groundLine(kit, kit.paint, framePoint(f, um - w / 2, backV(um - w / 2) + d), framePoint(f, um + w / 2, backV(um + w / 2) + d), 0.05, lift + 0.003, L.settLine);
  }
  for (let s = -w / 2 + 0.9; s < w / 2; s += 0.9) groundLine(kit, kit.paint, framePoint(f, um + s, backV(um + s)), framePoint(f, um + s, backV(um + s) + Y.mouthDepth), 0.05, lift + 0.003, L.settLine);
}

/** Hazard stripes across the quay at u from d0 to d1 in from the sea wall's edge. */
function hazardLine(kit: DistrictKit, a: Area, u: number, d0: number, d1: number): void {
  const p = a.params;
  const f = harborFrame(a);
  const c = coastV(p, u);
  for (let d = d0, k = 0; d < d1; d += 0.8, k++) {
    const e = Math.min(d1, d + 0.8);
    groundLine(kit, kit.paint, framePoint(f, u, c - d), framePoint(f, u, c - e), 0.32, CITY.curbHeight + 0.014, YARD_LOOK.hazard[k % 2]);
  }
}

/** A blob on the ground: an irregular ring of `n` points round (cx, cz), draped in the paint layer. */
function blob(kit: DistrictKit, rng: Rng, cx: number, cz: number, r: number, color: THREE.Color, lift: number): void {
  const n = 9;
  const c = groundVertex(kit, kit.paint, cx, cz, lift, color);
  const ring: number[] = [];
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI * 2;
    const rr = r * rng.range(0.6, 1.15);
    ring.push(groundVertex(kit, kit.paint, cx + Math.cos(ang) * rr, cz + Math.sin(ang) * rr * rng.range(0.7, 1), lift, color));
  }
  for (let k = 0; k < n; k++) kit.paint.triFacing(c, ring[k], ring[(k + 1) % n], 0, 1, 0);
}

/** The yard's wear: puddles in the low spots of the lane, oil under the drums and the forklifts, tyre marks. */
function wear(kit: DistrictKit, a: Area, rng: Rng): void {
  const L = YARD_LOOK;
  const p = a.params;
  const f = harborFrame(a);
  const lift = CITY.curbHeight + 0.006;
  const pt = (u: number, d: number) => framePoint(f, u, coastV(p, u) - d);
  for (let u = p.pa + rng.range(10, 30); u < p.pb - 10; u += rng.range(22, 46)) {
    const q = pt(u, rng.range(Y.lane[0] + 0.5, Y.lane[1] + 2));
    if (rng.chance(0.55)) blob(kit, rng, q.x, q.z, rng.range(0.8, 2.2), L.puddle, lift);
    else blob(kit, rng, q.x, q.z, rng.range(0.3, 0.9), L.oil, lift);
    // A pair of tyre marks swinging across the lane.
    if (rng.chance(0.5)) {
      const d0 = rng.range(Y.lane[0] + 1, Y.lane[1] - 1);
      const amp = rng.range(1, 3);
      const len = rng.range(12, 26);
      for (const side of [-0.75, 0.75]) {
        let prev: Vec2 | null = null;
        for (let s = 0; s <= len; s += 1.5) {
          const c = pt(u + s, d0 + Math.sin((s / len) * Math.PI) * amp + side);
          if (prev) groundLine(kit, kit.paint, prev, c, 0.22, lift + 0.002, L.rubber);
          prev = c;
        }
      }
    }
  }
}

/** One gull: perched (wings folded) or flying (wings out), facing yaw, into the solid builder (or `gb`). */
function gull(kit: DistrictKit, t: YardTools, x: number, y: number, z: number, yaw: number, flying: boolean, gb: GeoBuilder = kit.solid): void {
  const L = YARD_LOOK;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  t.boxAt(gb, x, y + 0.04, z, fx, fz, 0.2, 0.07, 0.13, L.gull);
  t.boxAt(gb, x + fx * 0.22, y + 0.12, z + fz * 0.22, fx, fz, 0.06, 0.05, 0.09, L.gull);
  t.boxAt(gb, x + fx * 0.31, y + 0.13, z + fz * 0.31, fx, fz, 0.035, 0.015, 0.025, L.beak);
  if (flying) {
    for (const o of [-1, 1]) t.beam(gb, x - fz * o * 0.06, y + 0.12, z + fx * o * 0.06, x - fz * o * 0.48, y + 0.2, z + fx * o * 0.48, 0.025, L.gullWing);
  } else {
    for (const o of [-1, 1]) t.boxAt(gb, x - fx * 0.04 + fz * o * 0.07, y + 0.08, z - fz * 0.04 - fx * o * 0.07, fx, fz, 0.18, 0.015, 0.07, L.gullWing);
  }
}

/** A flock of gulls wheeling over the water off the quay's middle: one small mesh turned on the scene clock. */
function flock(kit: DistrictKit, t: YardTools, a: Area, rng: Rng): void {
  const p = a.params;
  const um = p.pa + (p.pb - p.pa) * rng.range(0.3, 0.7);
  const n = coastNormal(p, um);
  const centre = framePoint(harborFrame(a), um, coastV(p, um));
  const cx = centre.x + n.nx * 30;
  const cz = centre.z + n.nz * 30;
  const y0 = waterLevel(p, um);
  const gb = new GeoBuilder(true);
  for (let k = 0, m = rng.int(5, 8); k < m; k++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(14, 30);
    // Tangent to the circle, the way the group turns.
    gull(kit, t, Math.cos(ang) * r, rng.range(12, 22), Math.sin(ang) * r, Math.atan2(-Math.sin(ang), Math.cos(ang)) + Math.PI / 2, true, gb);
  }
  const mesh = new THREE.Mesh(kit.track(gb.build()), kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })));
  mesh.name = 'harborGulls';
  mesh.position.set(cx, y0, cz);
  mesh.frustumCulled = false;
  kit.group.add(mesh);
  kit.animate((time) => {
    mesh.rotation.y = -time * 0.22;
  });
}
