/**
 * Hills renderer. The hill itself is terrain (a height modifier,
 * src/city/districts/hills.ts), and everything standing on it already
 * follows world.heightAt: roads, curbs and sidewalks are subdivided strips,
 * buildings sit on their lowest corner with a plinth where the ground rises
 * (render/buildings/buildings.ts), props, rails, crowds and the El sample the
 * ground; boundary walls on a steep hill street are stone retaining walls
 * with a stair walk climbing behind them (boundaryWalls.ts). This draws what
 * belongs to the hills alone:
 *  - the lookout: a fluted tower with an open gallery on the city's tallest
 *    hill, on a stone terrace at the highest free spot near its summit
 *    (hillLookout.ts picks it, and the backlots keep off it), its stone lit by
 *    floodlights at its foot (the glow builder at a low strength, so it reads
 *    as lit without blooming), a red beacon on top: a landmark across town;
 *  - on San Francisco's terraced hill, cable car tracks down the middle of
 *    every street on it, two rails and the cable's slot, in paint on the road.
 * All of it merges into the kit's builders (no draw call of its own).
 */
import { pointInPolygon } from '../../city/districts/geom';
import { plateauDistance, shapeOf } from '../../city/districts/hills';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundLine, orientedBox, prism } from './kit';
import { lookoutSite } from './hillLookout';

const TOWER = {
  /** Terrace height over its highest ground (m); base drum radius and height (m); shaft radii (foot, head) and height (m). */
  terrace: 0.6,
  drum: [4.8, 6],
  shaft: [3.4, 2.9, 44],
  /** Gallery height (m), pilasters round it, cornice and roof drum heights (m). */
  gallery: 3.4,
  pilasters: 12,
  flutes: 14,
  cornice: 0.6,
  roof: 1.3,
} as const;

const STONE = col(0x7d7a73);
const STONE_DARK = col(0x4c4a46);
/** Floodlit stone in the glow builder: brightest at the foot, where the lamps are. */
const LIT = (k: number) => col(0xefe4cf, 0.44 - 0.2 * k);
const GALLERY = col(0xffd59a, 0.95);
const BEACON = col(0xff2a1a, 2.2);
const FLOOD = col(0xfff1d6, 2);

const TRACK = { gauge: 1.435, rail: 0.11, slot: 0.05, piece: 2, lift: 0.06 } as const;
/** Polished rail heads catch the street's light: a faint glow, so they read at night. */
const RAIL = col(0xc4ccd8, 0.26);
const SLOT = col(0x111214);

function lookoutTower(kit: DistrictKit): void {
  const site = lookoutSite(kit.world);
  if (!site) return;
  const { x, z, r } = site;
  const ring = Array.from({ length: 8 }, (_, k) => ({ x: x + Math.cos(((k + 0.5) / 8) * 2 * Math.PI) * r, z: z + Math.sin(((k + 0.5) / 8) * 2 * Math.PI) * r }));
  prism(kit, kit.solid, ring, TOWER.terrace, STONE, STONE, 0.5);
  let hi = -Infinity;
  for (const p of ring) hi = Math.max(hi, kit.h(p.x, p.z));
  const T = hi + TOWER.terrace;
  // Floodlights at the terrace's corners, aimed up at the drum.
  for (let k = 0; k < 4; k++) {
    const a = ((k + 0.5) / 4) * 2 * Math.PI;
    const fx = x + Math.cos(a) * (r - 1.2);
    const fz = z + Math.sin(a) * (r - 1.2);
    cylinder(kit.solid, fx, fz, 0.22, T, T + 0.25, 6, STONE_DARK);
    cylinder(kit.glow, fx, fz, 0.16, T + 0.25, T + 0.33, 6, FLOOD);
  }
  // The drum, the fluted shaft in lit stone growing darker with height, the dark flutes.
  const [dr, dh] = TOWER.drum;
  cylinder(kit.glow, x, z, dr, T, T + dh, 20, LIT(0));
  cylinder(kit.solid, x, z, dr + 0.15, T + dh, T + dh + 0.35, 20, STONE_DARK);
  orientedBox(kit.solid, x + dr - 0.05, z - 0.8, x + dr - 0.05, z + 0.8, 0.12, 0, T, T + 2.6, STONE_DARK);
  const [r0, r1, sh] = TOWER.shaft;
  const y0 = T + dh;
  const segs = 5;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs;
    const t1 = (k + 1) / segs;
    cylinder(kit.glow, x, z, r0 + (r1 - r0) * t0, y0 + sh * t0, y0 + sh * t1, 16, LIT(t0 + 0.5 / segs), false, r0 + (r1 - r0) * t1);
  }
  for (let k = 0; k < TOWER.flutes; k++) {
    const a = (k / TOWER.flutes) * 2 * Math.PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rr = (r0 + r1) / 2 + 0.02;
    orientedBox(kit.solid, x + c * rr - s * 0.09, z + s * rr + c * 0.09, x + c * rr + s * 0.09, z + s * rr - c * 0.09, c * 0.06, s * 0.06, y0 + 0.4, y0 + sh - 0.2, STONE_DARK);
  }
  // The gallery: lit openings between pilasters, the cornice, the roof drum and its beacon.
  const g0 = y0 + sh;
  const g1 = g0 + TOWER.gallery;
  cylinder(kit.glow, x, z, r1 - 0.25, g0, g1, 16, GALLERY, false);
  for (let k = 0; k < TOWER.pilasters; k++) {
    const a = (k / TOWER.pilasters) * 2 * Math.PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    orientedBox(kit.solid, x + c * r1 - s * 0.3, z + s * r1 + c * 0.3, x + c * r1 + s * 0.3, z + s * r1 - c * 0.3, -c * 0.35, -s * 0.35, g0, g1, STONE);
  }
  cylinder(kit.solid, x, z, r1 + 0.45, g1, g1 + TOWER.cornice, 16, STONE_DARK);
  cylinder(kit.glow, x, z, r1 - 0.5, g1 + TOWER.cornice, g1 + TOWER.cornice + TOWER.roof, 16, LIT(1), true, r1 - 0.8);
  const top = g1 + TOWER.cornice + TOWER.roof;
  cylinder(kit.solid, x, z, 0.12, top, top + 1.6, 6, STONE_DARK);
  cylinder(kit.glow, x, z, 0.2, top + 1.6, top + 2.0, 8, BEACON);
}

/** Cable car tracks down the middle of every street on a terraced hill: two rails and the cable's slot. */
function cableTracks(kit: DistrictKit): void {
  const g = kit.world.graph;
  for (const a of kit.world.areas) {
    if (a.kind !== 'hills' || a.variant !== 'terraced') continue;
    const s = shapeOf(a);
    for (const e of g.edges) {
      if (e.kind !== 'street' && e.kind !== 'avenue' && e.kind !== 'boulevard' && e.kind !== 'diagonal') continue;
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      if (plateauDistance(s, A.x, A.z).d > s.w + 5 || plateauDistance(s, B.x, B.z).d > s.w + 5) continue;
      if (!pointInPolygon((A.x + B.x) / 2, (A.z + B.z) / 2, a.polygon) && plateauDistance(s, (A.x + B.x) / 2, (A.z + B.z) / 2).d > s.w) continue;
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      if (len < 1) continue;
      const nx = -(B.z - A.z) / len;
      const nz = (B.x - A.x) / len;
      const n = Math.max(1, Math.ceil(len / TRACK.piece));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        const p = { x: A.x + (B.x - A.x) * t0, z: A.z + (B.z - A.z) * t0 };
        const q = { x: A.x + (B.x - A.x) * t1, z: A.z + (B.z - A.z) * t1 };
        for (const side of [-1, 1]) {
          const o = (side * TRACK.gauge) / 2;
          groundLine(kit, kit.glow, { x: p.x + nx * o, z: p.z + nz * o }, { x: q.x + nx * o, z: q.z + nz * o }, TRACK.rail, TRACK.lift, RAIL);
        }
        groundLine(kit, kit.paint, p, q, TRACK.slot, TRACK.lift, SLOT);
      }
    }
  }
}

export const hillsRenderer: DistrictRenderer = {
  kinds: ['hills'],
  build(kit) {
    lookoutTower(kit);
    cableTracks(kit);
  },
};
