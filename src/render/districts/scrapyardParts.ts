/**
 * The Scrapyard's machines and moving parts (render/districts/scrapyard.ts builds the ground, the stacks, the heaps and the
 * deck; this module the rest), all read off the yard's layout (city/districts/scrapyardLayout.ts), whose solids the sim
 * collides with:
 *  - into the district kit (no draw call of their own): the crusher beside its pit, the scale house, the gate portal over the
 *    entry's apron, the conveyor gantry over the haul road, the truck wash's frame, the wreckers and the flatbed, the shredder's
 *    body, the crane's base, mast and boom, the floodlight towers and their heads, the posts at the fence's gaps, the hazard
 *    lamps on both kickers' lips and at the deck's drop;
 *  - meshes of their own, one draw call each: the crane's magnet with the car it carries (swings as a pure function of the
 *    scene clock), the press's ram (posed from the gate's cycle at the interpolated sim tick), the floodlights' pools (one
 *    additive mesh for every tower) and, at Medium and up, the shredder's spark shower (points moved in the vertex shader by
 *    the clock: nothing per frame but a uniform).
 * No sign and no arrow: the lines read by their light, their ground and what stands beside them.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { ScrapLayout, YardSolid } from '../../city/districts/scrapyardLayout';
import { gatePhase, newGatePhase } from '../../sim/gates';
import type { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import { heightFogShader } from '../heightFog';
import type { DistrictKit } from './kit';
import { col, cylinder, orientedBox } from './kit';
import { PAINTS } from '../traffic/traffic';

const C = CITY.districts.scrapyard;

export const LOOK = {
  steel: col(0x59626c),
  steelDark: col(0x2b3036),
  galv: col(0x8b929a),
  yellow: col(0xd9a11a),
  orange: col(0xd0601a),
  rubber: col(0x1c1d20),
  concrete: col(0x6c6e74),
  cab: col(0x1d2a38),
  lamp: col(0xfff0d0, 2.4),
  lampWarm: col(0xffc878, 2),
  sodium: col(0xffb050, 2.2),
  red: col(0xff2a1e, 1.6),
  amber: col(0xffa020),
  wash: col(0x7fd4ff, 1.6),
  tower: col(0x80878f),
} as const;

/** A box on a solid's footprint from y0 to y1 above the lowest ground under it (or absolute with `abs`). */
function solidBox(kit: DistrictKit, gb: GeoBuilder, s: { x: number; z: number; ax: number; az: number }, along0: number, along1: number, across0: number, across1: number, y0: number, y1: number, color: THREE.Color, base?: number): void {
  const nx = -s.az;
  const nz = s.ax;
  const p = (a: number, c: number): Vec2 => ({ x: s.x + s.ax * a + nx * c, z: s.z + s.az * a + nz * c });
  const p0 = p(along0, across0);
  const p1 = p(along1, across0);
  const g = base ?? Math.min(kit.h(p0.x, p0.z), kit.h(p1.x, p1.z), kit.h(p(along0, across1).x, p(along0, across1).z), kit.h(p(along1, across1).x, p(along1, across1).z));
  orientedBox(gb, p0.x, p0.z, p1.x, p1.z, nx * (across1 - across0), nz * (across1 - across0), g + y0, g + y1, color);
}

/** The crusher: body, hopper, press head with its dark ram slot, a work lamp and a beacon. */
function crusher(kit: DistrictKit, s: YardSolid): void {
  const hl = s.length / 2;
  const hd = s.depth / 2;
  const H = C.crusher.height;
  solidBox(kit, kit.solid, s, -hl, hl, -hd, hd, -0.2, 2.3, LOOK.steel);
  solidBox(kit, kit.solid, s, -hl + 0.3, 0.4, -hd + 0.4, hd - 0.4, 2.3, 3.7, LOOK.yellow);
  solidBox(kit, kit.solid, s, 0.7, hl - 0.2, -hd + 0.3, hd - 0.3, 2.3, H, LOOK.orange);
  solidBox(kit, kit.solid, s, -hl + 0.15, 0.55, -hd + 0.25, hd - 0.25, 3.7, 3.95, LOOK.steelDark);
  solidBox(kit, kit.solid, s, hl - 0.2, hl + 0.02, -1.2, 1.2, 1.0, 2.1, LOOK.steelDark);
  const y = kit.h(s.x, s.z) + H;
  cylinder(kit.glow, s.x + s.ax * 1.5, s.z + s.az * 1.5, 0.16, y + 0.05, y + 0.4, 6, LOOK.lampWarm, true);
  cylinder(kit.hazard, s.x + s.ax * 2.3, s.z + s.az * 2.3, 0.12, y + 0.05, y + 0.3, 6, LOOK.amber, true);
}

/** The scale house: a cabin on a plinth, its lit window facing the weighbridge, a flat roof with an overhang. */
function scaleHouse(kit: DistrictKit, s: YardSolid): void {
  const hl = s.length / 2;
  const hd = s.depth / 2;
  solidBox(kit, kit.solid, s, -hl, hl, -hd, hd, -0.2, 0.5, LOOK.concrete);
  solidBox(kit, kit.solid, s, -hl + 0.1, hl - 0.1, -hd + 0.1, hd - 0.1, 0.5, 2.9, col(0x8a7a5a));
  solidBox(kit, kit.glow, s, -hl + 0.6, hl - 0.6, hd - 0.12, hd - 0.06, 1.3, 2.3, LOOK.lampWarm);
  solidBox(kit, kit.glow, s, -hl + 0.6, hl - 0.6, -hd + 0.06, -hd + 0.12, 1.3, 2.3, LOOK.lampWarm);
  solidBox(kit, kit.solid, s, -hl - 0.5, hl + 0.5, -hd - 0.5, hd + 0.5, 2.9, 3.15, LOOK.steelDark);
}

/** A truck: a wrecker (cab, bed, its boom and hook) or a flatbed (cab, a long bed with a crushed car on it). */
function truck(kit: DistrictKit, s: YardSolid, index: number): void {
  const hl = s.length / 2;
  const hd = s.depth / 2;
  const paint = PAINTS[(index * 3 + 2) % PAINTS.length].clone().multiplyScalar(0.8);
  solidBox(kit, kit.solid, s, -hl, hl, -hd + 0.1, hd - 0.1, 0.35, 0.95, LOOK.steelDark);
  for (const a of [-hl + 1.0, hl - 1.2]) for (const c of [-hd + 0.15, hd - 0.15]) cylinder(kit.solid, s.x + s.ax * a + -s.az * c, s.z + s.az * a + s.ax * c, 0.45, kit.h(s.x, s.z), kit.h(s.x, s.z) + 0.9, 8, LOOK.rubber, true);
  solidBox(kit, kit.solid, s, hl - 2.2, hl, -hd, hd, 0.95, 2.9, paint);
  solidBox(kit, kit.glow, s, hl - 0.06, hl + 0.02, -hd + 0.25, hd - 0.25, 2.0, 2.6, col(0x203040, 0.6));
  if (s.kind === 'wrecker') {
    solidBox(kit, kit.solid, s, -hl, hl - 2.4, -hd, hd, 0.95, 1.4, LOOK.yellow);
    solidBox(kit, kit.solid, s, -hl + 0.3, -hl + 3.8, -0.25, 0.25, 1.4, 3.6, LOOK.yellow);
    solidBox(kit, kit.solid, s, -hl - 0.4, -hl + 0.4, -0.2, 0.2, 3.0, 3.6, LOOK.steelDark);
  } else {
    solidBox(kit, kit.solid, s, -hl, hl - 2.4, -hd, hd, 0.95, 1.15, col(0x6a5844));
    const car = PAINTS[(index * 5 + 1) % PAINTS.length].clone().multiplyScalar(0.6);
    solidBox(kit, kit.solid, s, -hl + 0.6, hl - 3.0, -hd + 0.25, hd - 0.25, 1.15, 1.85, car);
  }
  cylinder(kit.hazard, s.x + s.ax * (hl - 1.1), s.z + s.az * (hl - 1.1), 0.12, kit.h(s.x, s.z) + 2.9, kit.h(s.x, s.z) + 3.15, 6, LOOK.amber, true);
}

/** The shredder: a dark hopper on a tall body, its feed chute and the outfeed conveyor, lamps. */
function shredder(kit: DistrictKit, s: YardSolid): void {
  const hl = s.length / 2;
  const hd = s.depth / 2;
  solidBox(kit, kit.solid, s, -hl, hl, -hd, hd, -0.2, 4.2, col(0x3d4a3a));
  solidBox(kit, kit.solid, s, -hl - 0.6, hl + 0.6, -hd - 0.6, hd + 0.6, 4.2, 6.2, LOOK.steelDark);
  solidBox(kit, kit.solid, s, -hl + 0.5, hl - 0.5, -hd + 0.5, hd - 0.5, 6.2, 6.3, col(0x0a0a0c));
  solidBox(kit, kit.solid, s, hl, hl + 7, -0.6, 0.6, 3.2, 3.6, LOOK.steel);
  const y = kit.h(s.x, s.z);
  for (const c of [-1, 1]) cylinder(kit.glow, s.x + -s.az * c * (hd + 0.5), s.z + s.ax * c * (hd + 0.5), 0.15, y + 6.3, y + 6.6, 6, LOOK.sodium, true);
  cylinder(kit.hazard, s.x, s.z, 0.14, y + 6.3, y + 6.6, 6, LOOK.amber, true);
}

/** The magnet crane's fixed parts (base, mast, cab, boom, counterweight) in the kit, and the hanging magnet as its own small mesh. */
function crane(kit: DistrictKit, L: ScrapLayout, s: YardSolid): void {
  const { base, tip } = L.crane;
  const H = 15;
  const ax = { x: (tip.x - base.x) / Math.hypot(tip.x - base.x, tip.z - base.z), z: (tip.z - base.z) / Math.hypot(tip.x - base.x, tip.z - base.z) };
  const f = { x: base.x, z: base.z, ax: ax.x, az: ax.z };
  const g = kit.h(base.x, base.z);
  solidBox(kit, kit.solid, s, -1.6, 1.6, -1.6, 1.6, -0.2, 1.4, LOOK.yellow);
  solidBox(kit, kit.solid, f, -0.45, 0.45, -0.45, 0.45, 1.4, H, LOOK.yellow, g);
  solidBox(kit, kit.solid, f, -1.1, 0.8, -0.9, 0.9, H - 3.6, H - 1.8, LOOK.steelDark, g);
  solidBox(kit, kit.glow, f, 0.8, 0.84, -0.6, 0.6, H - 3.3, H - 2.3, LOOK.lampWarm, g);
  const reach = Math.hypot(tip.x - base.x, tip.z - base.z);
  solidBox(kit, kit.solid, f, -0.4, reach + 0.4, -0.3, 0.3, H - 0.6, H + 0.1, LOOK.yellow, g);
  solidBox(kit, kit.solid, f, -4.4, -0.4, -0.9, 0.9, H - 0.7, H + 0.5, LOOK.steel, g);
  const ty = g + H - 0.6;
  cylinder(kit.hazard, tip.x, tip.z, 0.1, ty + 0.7, ty + 1.0, 6, LOOK.amber, true);
  const gb = new GeoBuilder(true);
  const cab = 6;
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
  group.rotation.y = Math.atan2(-ax.z, ax.x);
  kit.group.add(group);
  // A slow pendulum along the boom and a turn of the load: a pure function of the scene's clock.
  kit.animate((time) => {
    group.rotation.z = 0.2 * Math.sin(time * 0.55) + 0.05 * Math.sin(time * 1.3);
    group.rotation.x = 0.06 * Math.sin(time * 0.41 + 1);
  });
}

/** The gate portal over the entry's apron: two steel columns (the layout's solids), a lattice beam across at 7 m, amber lamps. */
function portal(kit: DistrictKit, L: ScrapLayout): void {
  const [a, b] = L.portal;
  const ya = kit.h(a.x, a.z);
  const yb = kit.h(b.x, b.z);
  const top = Math.max(ya, yb) + 7;
  for (const [p, y] of [
    [a, ya],
    [b, yb],
  ] as const) {
    cylinder(kit.solid, p.x, p.z, 0.32, y - 0.2, top + 0.6, 8, LOOK.steel, true);
    cylinder(kit.hazard, p.x, p.z, 0.16, top + 0.6, top + 0.9, 6, LOOK.amber, true);
  }
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const n = { x: -dz / l, z: dx / l };
  orientedBox(kit.solid, a.x - n.x * 0.3, a.z - n.z * 0.3, b.x - n.x * 0.3, b.z - n.z * 0.3, n.x * 0.6, n.z * 0.6, top, top + 0.25, LOOK.yellow);
  orientedBox(kit.solid, a.x - n.x * 0.3, a.z - n.z * 0.3, b.x - n.x * 0.3, b.z - n.z * 0.3, n.x * 0.6, n.z * 0.6, top + 0.9, top + 1.1, LOOK.yellow);
  const k = Math.max(2, Math.round(l / 1.6));
  for (let i = 0; i < k; i++) {
    const t = (i + 0.5) / k;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    orientedBox(kit.solid, x - (dx / l) * 0.05, z - (dz / l) * 0.05, x + (dx / l) * 0.05, z + (dz / l) * 0.05, n.x * 0.1, n.z * 0.1, top + 0.25, top + 0.9, LOOK.steelDark);
    if (i % 2 === 0) cylinder(kit.glow, x, z, 0.12, top - 0.2, top, 6, LOOK.sodium, true);
  }
}

/** The conveyor gantry over the haul road: legs, a truss beam, and the belt climbing on over the Eight's side toward the heaps. */
function gantry(kit: DistrictKit, L: ScrapLayout): void {
  const [a, b] = L.gantry;
  const top = Math.max(kit.h(a.x, a.z), kit.h(b.x, b.z)) + C.gantry.clear;
  for (const p of [a, b]) {
    const y = kit.h(p.x, p.z);
    orientedBox(kit.solid, p.x - 0.45, p.z - 0.45, p.x + 0.45, p.z - 0.45, 0, 0.9, y - 0.2, top + 1.4, LOOK.steel);
  }
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const n = { x: -dz / l, z: dx / l };
  orientedBox(kit.solid, a.x - n.x * 0.8, a.z - n.z * 0.8, b.x - n.x * 0.8, b.z - n.z * 0.8, n.x * 1.6, n.z * 1.6, top, top + 0.5, LOOK.steelDark);
  orientedBox(kit.solid, a.x - n.x * 0.6, a.z - n.z * 0.6, b.x - n.x * 0.6, b.z - n.z * 0.6, n.x * 1.2, n.z * 1.2, top + 0.5, top + 0.75, LOOK.rubber);
  orientedBox(kit.solid, a.x - n.x * 0.8, a.z - n.z * 0.8, b.x - n.x * 0.8, b.z - n.z * 0.8, n.x * 0.1, n.z * 0.1, top + 0.5, top + 1.4, LOOK.yellow);
  orientedBox(kit.solid, a.x + n.x * 0.7, a.z + n.z * 0.7, b.x + n.x * 0.7, b.z + n.z * 0.7, n.x * 0.1, n.z * 0.1, top + 0.5, top + 1.4, LOOK.yellow);
  // The belt climbs on past the first leg (the Eight's side), high over everything: render only.
  const ux = -dx / l;
  const uz = -dz / l;
  for (let i = 0; i < 4; i++) {
    const s0 = i * 5;
    const s1 = s0 + 5;
    orientedBox(kit.solid, a.x + ux * s0 - n.x * 0.6, a.z + uz * s0 - n.z * 0.6, a.x + ux * s1 - n.x * 0.6, a.z + uz * s1 - n.z * 0.6, n.x * 1.2, n.z * 1.2, top + 0.5 + i * 1.1, top + 1.0 + (i + 1) * 1.1, LOOK.steelDark);
  }
  for (const p of [a, b]) cylinder(kit.glow, p.x, p.z, 0.16, top - 0.35, top, 6, LOOK.sodium, true);
}

/** The truck wash: a frame over the perimeter road on its two posts, spray bars glowing over the wet patch. */
function wash(kit: DistrictKit, posts: YardSolid[]): void {
  if (posts.length < 2) return;
  const [a, b] = posts;
  const top = Math.max(kit.h(a.x, a.z), kit.h(b.x, b.z)) + 4.6;
  for (const p of [a, b]) cylinder(kit.solid, p.x, p.z, 0.28, kit.h(p.x, p.z) - 0.2, top + 0.4, 8, LOOK.galv, true);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const n = { x: -dz / l, z: dx / l };
  orientedBox(kit.solid, a.x - n.x * 0.2, a.z - n.z * 0.2, b.x - n.x * 0.2, b.z - n.z * 0.2, n.x * 0.4, n.z * 0.4, top, top + 0.4, LOOK.galv);
  for (const o of [-1.2, 0, 1.2]) orientedBox(kit.glow, a.x + n.x * o, a.z + n.z * o, b.x + n.x * o, b.z + n.z * o, n.x * 0.06, n.z * 0.06, top - 0.15, top - 0.05, LOOK.wash);
}

/** Every machine, vehicle and post of the yard's solids, and the hazard lamps on the lips and at the drop. */
export function machines(kit: DistrictKit, L: ScrapLayout): void {
  let trucks = 0;
  const washPosts: YardSolid[] = [];
  for (const s of L.solids) {
    if (s.kind === 'crusher') crusher(kit, s);
    else if (s.kind === 'scale') scaleHouse(kit, s);
    else if (s.kind === 'wrecker' || s.kind === 'flatbed') truck(kit, s, trucks++);
    else if (s.kind === 'shredder') shredder(kit, s);
    else if (s.kind === 'crane') crane(kit, L, s);
    else if (s.kind === 'washPost') washPosts.push(s);
    else if (s.kind === 'post') {
      const y = kit.h(s.x, s.z);
      cylinder(kit.solid, s.x, s.z, 0.3, y - 0.2, y + 3.4, 6, LOOK.steel, true);
      cylinder(kit.glow, s.x, s.z, 0.2, y + 3.4, y + 3.65, 6, LOOK.lampWarm, true);
    }
  }
  wash(kit, washPosts);
  portal(kit, L);
  gantry(kit, L);
  // Hazard lamps: each end of both kickers' lips (the blink every lip in the city carries).
  for (const k of [
    { ...L.kicker, w: C.kicker.width },
    { ...L.launch, w: C.launch.width },
  ]) {
    const n = { x: -k.dir.z, z: k.dir.x };
    for (const s of [-1, 1]) {
      const x = k.lip.x + n.x * s * (k.w / 2 + 0.3);
      const z = k.lip.z + n.z * s * (k.w / 2 + 0.3);
      const y = kit.h(x, z);
      cylinder(kit.hazard, x, z, 0.1, y + 0.1, y + 0.4, 6, LOOK.amber, true);
    }
  }
}

/** A pool of lamp light up on the Bale Deck: centre, the deck's height there, radius (m). */
export interface DeckPool {
  x: number;
  z: number;
  y: number;
  r: number;
}

/** The floodlight towers: pole, a head of lamps facing its aim, and the pools of light under them and the deck's lamps (one additive mesh). */
export function towers(kit: DistrictKit, L: ScrapLayout, deckPools: DeckPool[] = []): void {
  if (!L.towers.length && !deckPools.length) return;
  const pools = new GeoBuilder(true);
  const T = C.tower;
  const poolColor = new THREE.Color();
  const radius = 40;
  for (const t of L.towers) {
    const y0 = kit.h(t.x, t.z);
    cylinder(kit.solid, t.x, t.z, 0.28, y0 - 0.2, y0 + T.height, 8, LOOK.tower, true, 0.16);
    cylinder(kit.solid, t.x, t.z, 0.5, y0 - 0.2, y0 + 0.9, 8, LOOK.concrete, true);
    const dx = t.aim.x - t.x;
    const dz = t.aim.z - t.z;
    const dl = Math.hypot(dx, dz) || 1;
    const fx = dx / dl;
    const fz = dz / dl;
    const px = -fz;
    const pz = fx;
    const hw = 1.8;
    const yh = y0 + T.height;
    orientedBox(kit.solid, t.x - px * hw, t.z - pz * hw, t.x + px * hw, t.z + pz * hw, fx * 0.35, fz * 0.35, yh - 0.1, yh + 1.5, LOOK.steelDark);
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 3; k++) {
        const u0 = -hw + 0.15 + k * 1.1;
        const u1 = u0 + 0.98;
        const y = yh + 0.1 + row * 0.72;
        orientedBox(kit.glow, t.x + px * u0 + fx * 0.36, t.z + pz * u0 + fz * 0.36, t.x + px * u1 + fx * 0.36, t.z + pz * u1 + fz * 0.36, fx * 0.04, fz * 0.04, y, y + 0.6, LOOK.lamp);
      }
    }
    // The pool: rings of a fan round the aim point, bright in the middle, fading to nothing at the edge.
    const aimX = t.x + Math.min(dl, 26) * fx;
    const aimZ = t.z + Math.min(dl, 26) * fz;
    const rings = kit.quality === 'low' ? 3 : 5;
    const segs = kit.quality === 'low' ? 12 : 20;
    const vi: number[][] = [];
    for (let r = 0; r <= rings; r++) {
      const rad = (r / rings) * radius;
      const fall = (1 - r / rings) ** 2;
      poolColor.setRGB(0.3 * fall, 0.235 * fall, 0.14 * fall);
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
  // The deck's lamps: flat discs on its surface, warmer and smaller.
  for (const p of deckPools) {
    const segs = kit.quality === 'low' ? 10 : 16;
    const c = pools.vertex(p.x, p.y, p.z, 0, 1, 0, 0, 0, poolColor.setRGB(0.34, 0.24, 0.1));
    const ring: number[] = [];
    for (let s = 0; s < segs; s++) {
      const ang = (s / segs) * Math.PI * 2;
      ring.push(pools.vertex(p.x + Math.cos(ang) * p.r, p.y, p.z + Math.sin(ang) * p.r, 0, 1, 0, 0, 0, poolColor.setRGB(0, 0, 0)));
    }
    for (let s = 0; s < segs; s++) pools.triFacing(c, ring[s], ring[(s + 1) % segs], 0, 1, 0);
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

/** The press: a gantry across the canyon on posts in its walls, hazard lamps on the beam, and the ram (a plate that follows the gate's cycle). */
export function press(kit: DistrictKit, L: ScrapLayout): void {
  const { a, b } = L.press;
  const c = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const w = Math.hypot(dx, dz);
  const ex = dx / w;
  const ez = dz / w;
  const half = w / 2;
  const beamY = 6.1;
  const ground = kit.h(c.x, c.z);
  for (const s of [-1, 1]) {
    const px = c.x + ex * s * (half + 0.35);
    const pz = c.z + ez * s * (half + 0.35);
    cylinder(kit.solid, px, pz, 0.42, ground - 0.2, ground + 6.9, 8, LOOK.yellow, true);
    cylinder(kit.hazard, px, pz, 0.14, ground + 6.9, ground + 7.24, 6, LOOK.amber, true);
  }
  const n = { x: -ez, z: ex };
  orientedBox(kit.solid, c.x - ex * (half + 1.3) - n.x * 0.7, c.z - ez * (half + 1.3) - n.z * 0.7, c.x + ex * (half + 1.3) - n.x * 0.7, c.z + ez * (half + 1.3) - n.z * 0.7, n.x * 1.4, n.z * 1.4, ground + beamY, ground + beamY + 0.8, LOOK.orange);
  orientedBox(kit.glow, c.x - ex * (half - 0.3) - n.x * 0.72, c.z - ez * (half - 0.3) - n.z * 0.72, c.x + ex * (half - 0.3) - n.x * 0.72, c.z + ez * (half - 0.3) - n.z * 0.72, n.x * 0.04, n.z * 0.04, ground + beamY + 0.1, ground + beamY + 0.25, LOOK.red);
  const gates = kit.world.timedGates;
  const gi = gates ? gates.gates.findIndex((g) => g.look === 'crusher') : -1;
  if (!gates || gi < 0) return;
  const cycle = gates.cycles[gates.gates[gi].cycle];
  const gb = new GeoBuilder(true);
  const plateH = 3;
  const thick = 0.45;
  const body = (y0: number, y1: number, color: THREE.Color) => orientedBox(gb, -(half - 0.02), -thick / 2, half - 0.02, -thick / 2, 0, thick, y0, y1, color);
  body(-plateH / 2, plateH / 2, LOOK.steelDark);
  body(-plateH / 2, -plateH / 2 + 0.5, col(0xe0a81c));
  const mat = kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 }));
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'scrapPress';
  mesh.position.set(c.x, 0, c.z);
  mesh.rotation.y = Math.atan2(-ez, ex);
  kit.group.add(mesh);
  const ph = newGatePhase();
  const lift = 3.4;
  kit.animate((time) => {
    gatePhase(cycle, kit.simTick(time), ph);
    mesh.position.y = ground + plateH / 2 + lift * (1 - ph.arm);
  });
}

/**
 * The shredder's spark shower (Medium and up): a fan of hot points thrown up out of its hopper and falling back, each on its own
 * loop of the clock (a seed per point), moved in the vertex shader so the CPU only sets the time. Additive, no depth write.
 */
export function sparks(kit: DistrictKit, L: ScrapLayout): void {
  if (kit.quality === 'low') return;
  const sh = L.solids.find((s) => s.kind === 'shredder');
  if (!sh) return;
  const n = kit.quality === 'high' ? 140 : 80;
  const seeds = new Float32Array(n * 3);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const h = (k: number) => {
      let x = Math.imul(i * 7 + k + 0x9e3779b9, 0x85ebca6b);
      x ^= x >>> 13;
      x = Math.imul(x, 0xc2b2ae35);
      x ^= x >>> 16;
      return (x >>> 0) / 4294967296;
    };
    seeds[i * 3] = h(1);
    seeds[i * 3 + 1] = h(2) * Math.PI * 2;
    seeds[i * 3 + 2] = 0.6 + h(3) * 0.8;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  const y0 = kit.h(sh.x, sh.z) + 6.3;
  const uniforms = { time: { value: 0 }, origin: { value: new THREE.Vector3(sh.x, y0, sh.z) } };
  const mat = kit.track(
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 seed;
        uniform float time;
        uniform vec3 origin;
        varying float vLife;
        void main() {
          float t = fract(time * 0.9 * seed.z + seed.x);
          float sp = 5.0 + 4.0 * seed.z;
          vec3 v = vec3(cos(seed.y) * sp * 0.45, sp, sin(seed.y) * sp * 0.45);
          vec3 p = origin + v * t * 1.1 + vec3(0.0, -4.9 * t * t * 1.21, 0.0);
          vLife = 1.0 - t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(90.0 / -mv.z, 1.0, 6.0) * (0.5 + vLife);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vLife;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(d));
          gl_FragColor = vec4(vec3(1.0, 0.62, 0.22) * (0.6 + vLife) * a, a);
        }`,
    }),
  );
  const pts = new THREE.Points(kit.track(geo), mat);
  pts.name = 'scrapSparks';
  pts.frustumCulled = false;
  kit.group.add(pts);
  kit.animate((time) => {
    uniforms.time.value = time;
  });
}
