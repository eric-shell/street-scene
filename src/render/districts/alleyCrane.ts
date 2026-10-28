/**
 * The tower crane over a construction shortcut: the site's refit is lifted by a crane standing on the roof of the
 * nearest low building, its jib reaching over the middle of the alley. One lit mesh per crane (footing, lattice mast,
 * slewing deck, cab, A-frame with pendants, jib and counter-jib lattices, counterweights, trolley, cable and hook)
 * plus a small unlit mesh of its lamps (cab window, jib-end beacons) sharing one material, both on a pivot that
 * slews a few degrees either side of its heading on the scene clock, a pure function of time. The red apex beacon
 * stands on the pivot's axis, so it lives in the district kit's static glow layer. The jib and the hook stay on the
 * roof's mast height, never nearer a car than ROOF_LIFE.crane.hookClear. Render only.
 */
import * as THREE from 'three';
import type { Building } from '../../city/blocks';
import { GeoBuilder } from '../geoBuilder';
import { ROOF_LIFE, roofLifeCenters, strut } from '../buildings/roofLife';
import { Rng, deriveSeed } from '../../sim/prng';
import type { DistrictKit } from './kit';
import { col, cylinder } from './kit';
import { Frame, lbox } from '../buildings/buildingKit';

const C = ROOF_LIFE.crane;
const YELLOW = col(0xd9a520, 0.95);
const STEEL = col(0x6a6e78);
const CONCRETE = col(0x6a6a68, 0.55);
const RED = col(0xff2418, 3);

const lampMaterials = new WeakMap<DistrictKit, THREE.MeshBasicMaterial>();

/** Shared lamp material of this kit's build (cab window, jib beacons); pulsed by the kit's animation. */
function lamps(kit: DistrictKit): THREE.MeshBasicMaterial {
  let mat = lampMaterials.get(kit);
  if (!mat) lampMaterials.set(kit, (mat = kit.track(new THREE.MeshBasicMaterial({ vertexColors: true }))));
  return mat;
}

/** Mid point (world) of a polyline by length. */
function middle(pts: { x: number; z: number }[]): { x: number; z: number } {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  let left = total / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    if (left <= l) {
      const t = l > 0 ? left / l : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
    }
    left -= l;
  }
  return pts[0];
}

/** A lattice boom along local z from z0 to z1: top chord at x = 0, two bottom chords, zigzag between. */
function boom(gb: GeoBuilder, z0: number, z1: number, yBot: number, yTop: number): void {
  const w = 0.55;
  strut(gb, 0, yTop, z0, 0, yTop, z1, 0.07, YELLOW);
  for (const s of [-1, 1]) strut(gb, s * w, yBot, z0, s * w, yBot, z1, 0.07, YELLOW);
  const n = Math.max(2, Math.round(Math.abs(z1 - z0) / 1.7));
  for (let i = 0; i < n; i++) {
    const a = z0 + ((z1 - z0) * i) / n;
    const b = z0 + ((z1 - z0) * (i + 1)) / n;
    const s = i % 2 ? -1 : 1;
    strut(gb, 0, yTop, a, s * w, yBot, b, 0.04, YELLOW);
    strut(gb, 0, yTop, b, -s * w, yBot, a, 0.04, YELLOW);
    strut(gb, -w, yBot, a, w, yBot, a, 0.04, YELLOW);
  }
}

/** Builds every shortcut's crane. Returns how many stand. */
export function buildCranes(kit: DistrictKit, sites: { points: { x: number; z: number }[]; sIn: number; sOut: number }[]): number {
  const world = kit.world;
  let built = 0;
  sites.forEach((sc, k) => {
    const m = middle(sc.points);
    // The crane stands on the nearest low roof within reach of the middle of the site.
    let best: Building | null = null;
    let bestD = Infinity;
    const taken = roofLifeCenters(world);
    for (const b of world.blocks.buildings) {
      if (b.h > C.roofs[1] || b.h < C.roofs[0]) continue;
      const d = Math.hypot(b.x - m.x, b.z - m.z);
      if (d < bestD && d <= C.reach && d > Math.min(b.w, b.d) * 0.5 && !taken.some((t) => Math.hypot(t.x - b.x, t.z - b.z) < 8)) {
        best = b;
        bestD = d;
      }
    }
    if (!best) return;
    const rng = new Rng(deriveSeed(world.seed, `crane${k}`));
    const roof = best.baseY + best.h;
    const ground = kit.h(m.x, m.z);
    // Tall enough that the hook, hanging hookDrop under the jib, clears the street by hookClear.
    const Hm = Math.max(C.mast, ground + C.hookClear + C.hookDrop - roof + 1.5);
    const L = bestD + C.reachPast;
    const Lc = L * C.counter;
    const hx = m.x - best.x;
    const hz = m.z - best.z;
    const heading = Math.atan2(hx, hz);
    const phase = rng.next();

    const gb = new GeoBuilder(true);
    // Footing, set into the roof.
    lbox(gb, new Frame(0, 0, 0), -1.9, 1.9, -1.9, 1.9, -2.2, 0.5, CONCRETE, false);
    // Mast: four posts, rings and diagonals every 3 m.
    const p = 0.7;
    const posts: [number, number][] = [[-p, -p], [p, -p], [p, p], [-p, p]];
    for (const [px, pz] of posts) strut(gb, px, 0.5, pz, px, Hm, pz, 0.1, YELLOW);
    for (let y = 0.5; y < Hm - 0.1; y += 3) {
      const y2 = Math.min(Hm, y + 3);
      for (let i = 0; i < 4; i++) {
        const a = posts[i];
        const b = posts[(i + 1) % 4];
        strut(gb, a[0], y, a[1], b[0], y, b[1], 0.05, YELLOW);
        if (i % 2) strut(gb, a[0], y, a[1], b[0], y2, b[1], 0.04, YELLOW);
        else strut(gb, b[0], y, b[1], a[0], y2, a[1], 0.04, YELLOW);
      }
    }
    // Slewing deck, cab, counterweights.
    const lf = new Frame(0, 0, 0);
    lbox(gb, lf, -1.1, 1.1, -1.1, 1.1, Hm, Hm + 0.5, STEEL, true);
    lbox(gb, lf, 1.2, 2.9, -0.6, 1.1, Hm + 0.5, Hm + 2.4, YELLOW, true);
    lbox(gb, lf, -1.1, 1.1, -Lc - 0.2, -Lc + 2.2, Hm + 0.5, Hm + 1.9, CONCRETE, true);
    lbox(gb, lf, -1.0, 1.0, -Lc + 2.2, -Lc + 4.2, Hm + 0.5, Hm + 1.6, CONCRETE, true);
    // A-frame and pendants.
    const Ha = 6.5;
    const apexY = Hm + Ha;
    for (const [px, pz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) strut(gb, px, Hm + 0.5, pz, 0, apexY, 0, 0.06, YELLOW);
    strut(gb, 0, apexY, 0, 0, Hm + 1.7, L * 0.55, 0.025, STEEL);
    strut(gb, 0, apexY, 0, 0, Hm + 1.7, L * 0.95, 0.025, STEEL);
    strut(gb, 0, apexY, 0, 0, Hm + 1.2, -Lc + 0.4, 0.025, STEEL);
    // Booms.
    boom(gb, 0.5, L, Hm + 0.7, Hm + 1.7);
    boom(gb, -Lc, -0.5, Hm + 0.7, Hm + 1.7);
    // Trolley over the site's middle, cable and hook.
    const drop = C.hookDrop;
    lbox(gb, lf, -0.45, 0.45, bestD - 0.45, bestD + 0.45, Hm + 0.1, Hm + 0.6, STEEL, true);
    strut(gb, 0, Hm + 0.1, bestD, 0, Hm + 0.1 - drop, bestD, 0.02, STEEL);
    lbox(gb, lf, -0.3, 0.3, bestD - 0.3, bestD + 0.3, Hm + 0.1 - drop - 0.7, Hm + 0.1 - drop, YELLOW, true);
    strut(gb, 0, Hm + 0.1 - drop - 0.7, bestD, 0, Hm + 0.1 - drop - 1.2, bestD, 0.05, STEEL);

    const lampGb = new GeoBuilder(true);
    const warm = new THREE.Color(1, 0.78, 0.45).multiplyScalar(2.2);
    lbox(lampGb, lf, 2.9, 2.95, -0.4, 0.9, Hm + 1.1, Hm + 2.0, warm, false);
    lbox(lampGb, lf, -0.18, 0.18, L - 0.2, L + 0.16, Hm + 1.7, Hm + 2.1, RED, false);
    // Work lights under the jib, a few along its length.
    for (const f of [0.25, 0.5, 0.75, 0.95]) lbox(lampGb, lf, -0.15, 0.15, L * f - 0.15, L * f + 0.15, Hm + 0.45, Hm + 0.65, warm, false);
    lbox(lampGb, lf, -0.18, 0.18, -Lc - 0.2, -Lc + 0.16, Hm + 1.7, Hm + 2.1, RED, false);

    const group = new THREE.Group();
    group.name = 'shortcutCrane';
    group.position.set(best.x, roof - 0.5, best.z);
    const body = new THREE.Mesh(
      kit.track(gb.build()),
      kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 })),
    );
    const lampMesh = new THREE.Mesh(kit.track(lampGb.build()), lamps(kit));
    group.add(body, lampMesh);
    group.updateMatrixWorld(true);
    // Static beacon on the mast's top: the A-frame apex stands on the slew axis, so the glow layer holds it.
    cylinder(kit.glow, best.x, best.z, 0.14, roof - 0.5 + apexY, roof - 0.5 + apexY + 0.45, 6, RED);
    kit.group.add(group);
    const swing = (C.swingDeg * Math.PI) / 180;
    kit.animate((time) => {
      group.rotation.y = heading + swing * Math.sin((time / C.swingPeriod + phase) * Math.PI * 2);
    });
    built++;
  });
  return built;
}
