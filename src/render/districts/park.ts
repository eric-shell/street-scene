/**
 * Park renderer: grass draped over the hills, detailed trees (trees.ts) on the trunks
 * the sim collides with (a denser wood in one spot), a gravel footpath loop
 * following the hills, and the race passes' cobbled paths (city park.ts
 * parkPasses): a wide strip of darker cobbles bowed through the park with a
 * pale kerb line each side and low path lights along it (kit.glow), drawn on
 * the grass and on across the curb cuts where it meets the streets (its
 * mouths, city busBays.ts mouthBay): cobbles out to the curb line behind a
 * pale stone threshold, path lights along the flared curbs, and a stone gate
 * pier with a lantern cap each side of the opening. Bushes, benches, bins
 * and lantern posts are destructible props drawn by render/street/props.ts;
 * the light on the lawn is render/street/areaLights.ts. The formal garden
 * and the lakeside pond are drawn by parkVariants.ts. Content to add: grass
 * shading and a playground.
 */
import * as THREE from 'three';
import { distToPolygonEdge, pointInPolygon } from '../../city/districts/geom';
import { type BusBay, MOUTH_REACH, bayCurbStations, bayHi, bayInset, bayLo, bayPoint } from '../../city/busBays';
import { CITY } from '../../city/config';
import type { Vec2 } from '../../sim/math';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, groundVertex, prism } from './kit';
import { parkVariants } from './parkVariants';
import { tree } from './trees';

/** Footpath strips are cut into pieces this long so they follow the hills (m). */
const PATH_PIECE = 3;

const PASS = {
  /** The cobbles are drawn in pieces this long (m), kept this far inside the park edge (m). */
  piece: 2,
  inset: 0.5,
  /** Lanes the cobbles are drawn in across the path. */
  lanes: 4,
  /** Cobble, kerb lines (m wide) and the path lights every studStep (m), their radius (m). */
  cobble: col(0x9c8f78),
  kerb: 0.3,
  kerbColor: col(0xd8cfb8),
  studStep: 8,
  studR: 0.22,
  studColor: new THREE.Color(1, 0.86, 0.66).multiplyScalar(1.5),
} as const;

/** A path's mouth: the threshold band along the curb line (m deep), path lights along each flared curb, the gate piers. */
const MOUTH = {
  threshold: 0.6,
  thresholdColor: col(0xb9b09a),
  flareStuds: 2,
  /** Gate piers: stone, a cap slab this much wider each side and this thick (m), a lantern cube on top (m). */
  stone: col(0x6d6558),
  stoneTop: col(0x8a8172),
  cap: 0.08,
  capThick: 0.12,
  lantern: 0.32,
  lanternColor: new THREE.Color(1, 0.8, 0.55).multiplyScalar(2.2),
} as const;

/** The mouth's cobbles from the street's curb line back to the cut curb, and its threshold band along the curb line. */
function mouthApron(kit: DistrictKit, bay: BusBay): void {
  const st = bayCurbStations(bay);
  const lo = bay.s0 + bay.taper;
  const hi = bay.s1 - bay.taper;
  const n = Math.max(1, Math.ceil((hi - lo) / 2));
  for (let i = 1; i < n; i++) st.push(lo + ((hi - lo) * i) / n);
  // Each piece of a mouth across a bend node paves its own stretch (busBays.ts bayLo, bayHi).
  const inPiece = (s: number) => s >= bayLo(bay) && s <= bayHi(bay);
  st.splice(0, st.length, ...st.filter(inPiece));
  st.sort((p, q) => p - q);
  const strip = (v0: (s: number) => number, v1: (s: number) => number, lift: number, color: THREE.Color) => {
    let prev: [number, number] | null = null;
    for (const s of st) {
      const a = bayPoint(bay, s, v0(s));
      const b = bayPoint(bay, s, Math.max(v0(s), v1(s)));
      const ids: [number, number] = [groundVertex(kit, kit.paint, a.x, a.z, lift, color), groundVertex(kit, kit.paint, b.x, b.z, lift, color)];
      if (prev) kit.paint.quadFacing(prev[0], prev[1], ids[1], ids[0], 0, 1, 0);
      prev = ids;
    }
  };
  strip(() => 0.02, (s) => bayInset(bay, s) - 0.02, 0.075, PASS.cobble);
  strip(() => 0.02, (s) => Math.min(MOUTH.threshold, bayInset(bay, s) - 0.02), 0.08, MOUTH.thresholdColor);
  // Path lights on the sidewalk side of each flared curb.
  for (let k = 1; k <= MOUTH.flareStuds; k++) {
    for (const s of [bay.s0 + (bay.taper * k) / (MOUTH.flareStuds + 1), bay.s1 - (bay.taper * k) / (MOUTH.flareStuds + 1)]) {
      const v = bayInset(bay, s) + 0.3;
      if (v > bay.depth - MOUTH_REACH - 0.2 || !inPiece(s)) continue;
      const p = bayPoint(bay, s, v);
      const y = kit.h(p.x, p.z) + CITY.curbHeight;
      cylinder(kit.glow, p.x, p.z, PASS.studR, y + 0.01, y + 0.08, 6, PASS.studColor);
    }
  }
}

/** A gate pier: stone with a cap slab and a glowing lantern on top. */
function gatePier(kit: DistrictKit, square: Vec2[], height: number): void {
  prism(kit, kit.solid, square, height, MOUTH.stone, MOUTH.stoneTop);
  const cx = (square[0].x + square[2].x) / 2;
  const cz = (square[0].z + square[2].z) / 2;
  const grow = (p: Vec2, by: number) => {
    const dx = p.x - cx;
    const dz = p.z - cz;
    const l = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / l) * by * Math.SQRT2, z: p.z + (dz / l) * by * Math.SQRT2 };
  };
  const cap = square.map((p) => grow(p, MOUTH.cap));
  prism(kit, kit.solid, cap, height + MOUTH.capThick, MOUTH.stoneTop, MOUTH.stoneTop, -(height - 0.001));
  const l = MOUTH.lantern / 2;
  const lantern = square.map((p) => grow(p, l - Math.hypot(p.x - cx, p.z - cz) / Math.SQRT2));
  prism(kit, kit.glow, lantern, height + MOUTH.capThick + MOUTH.lantern, MOUTH.lanternColor, MOUTH.lanternColor, -(height + MOUTH.capThick - 0.001));
}

/** A race pass's path across the park: cobbles, kerb lines and path lights, clipped to the park. */
function passPath(kit: DistrictKit, pts: Vec2[], width: number, park: Vec2[], mouths: Vec2[][]): void {
  // On the park, or in one of its curb cuts (whose apron the path's last pieces run onto, over the
  // strip along the park edge the path otherwise keeps off).
  const nearMouth = (p: Vec2) => mouths.some((m) => pointInPolygon(p.x, p.z, m) || distToPolygonEdge(p.x, p.z, m) < PASS.inset + 0.1);
  const on = (p: Vec2) => (pointInPolygon(p.x, p.z, park) && (distToPolygonEdge(p.x, p.z, park) > PASS.inset || nearMouth(p))) || mouths.some((m) => pointInPolygon(p.x, p.z, m));
  // Asphalt wins over the path: a piece whose corners reach a street (the width of a path that skirts a flared curb) is left out, never drawn over the road.
  const onStreet = (a: Vec2, b: Vec2, half: number) => {
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const l = Math.hypot(ux, uz) || 1;
    const nx = (-uz / l) * half;
    const nz = (ux / l) * half;
    return [a, b].some((p) => [-1, 0, 1].some((k) => kit.world.surfaceAt(p.x + nx * k, p.z + nz * k) === 'road'));
  };
  let stud = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.1) continue;
    const ux = (q.x - p.x) / len;
    const uz = (q.z - p.z) / len;
    const n = Math.max(1, Math.ceil(len / PASS.piece));
    for (let k = 0; k < n; k++) {
      const a = { x: p.x + (q.x - p.x) * (k / n), z: p.z + (q.z - p.z) * (k / n) };
      const b = { x: p.x + (q.x - p.x) * ((k + 1) / n), z: p.z + (q.z - p.z) * ((k + 1) / n) };
      if (!on(a) || !on(b) || onStreet(a, b, width / 2 + PASS.kerb)) continue;
      // In lanes across, each draped on its own, so a lawn rolling sideways never bulges up through the middle.
      for (let j = 0; j < PASS.lanes; j++) {
        const o = width * ((j + 0.5) / PASS.lanes - 0.5);
        groundLine(kit, kit.paint, { x: a.x - uz * o, z: a.z + ux * o }, { x: b.x - uz * o, z: b.z + ux * o }, width / PASS.lanes + 0.02, 0.075, PASS.cobble);
      }
      for (const sgn of [-1, 1]) {
        const ox = -uz * sgn * (width / 2);
        const oz = ux * sgn * (width / 2);
        groundLine(kit, kit.paint, { x: a.x + ox, z: a.z + oz }, { x: b.x + ox, z: b.z + oz }, PASS.kerb, 0.08, PASS.kerbColor);
      }
    }
    // Path lights down both edges, evenly along the whole line.
    for (; stud <= len; stud += PASS.studStep) {
      const c = { x: p.x + ux * stud, z: p.z + uz * stud };
      for (const sgn of [-1, 1]) {
        const x = c.x - uz * sgn * (width / 2 + 0.6);
        const z = c.z + ux * sgn * (width / 2 + 0.6);
        if (!on({ x, z })) continue;
        const y = kit.h(x, z);
        cylinder(kit.glow, x, z, PASS.studR, y + 0.02, y + 0.09, 6, PASS.studColor);
      }
    }
    stud -= len;
  }
}

export const parkRenderer: DistrictRenderer = {
  kinds: ['park'],
  build(kit, areas) {
    const gravel = col(0x5a5446);
    for (const a of areas) {
      drapeConvex(kit, kit.ground, a.polygon, 0.04, col(0x1d3a22), 5);
      const b = kit.builds[a.id];
      for (const p of b.props) if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height);
      // The passes' mouths: the cut curbs are the city's bays (blocks.ts), matched by edge and start.
      const mouths: Vec2[][] = [];
      for (const h of b.hints) {
        if (h.kind === 'mouth') {
          const bay = kit.world.blocks.bays.find((q) => q.kind === 'mouth' && q.edge === h.values[0] && Math.abs(q.s0 - h.values[2]) < 1e-6);
          if (bay) mouthApron(kit, bay);
          mouths.push(h.points);
        } else if (h.kind === 'gate') gatePier(kit, h.points, h.values[0]);
      }
      parkVariants(kit, b, a.params.seed);
      for (const h of b.hints) {
        if (h.kind === 'pass') {
          passPath(kit, h.points, h.values[0], a.polygon, mouths);
          continue;
        }
        if (h.kind !== 'path') continue;
        const pts = h.points;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const q = pts[(i + 1) % pts.length];
          const len = Math.hypot(q.x - p.x, q.z - p.z);
          const n = Math.max(1, Math.ceil(len / PATH_PIECE));
          for (let k = 0; k < n; k++) {
            const t0 = k / n;
            const t1 = (k + 1) / n;
            groundLine(kit, kit.paint, { x: p.x + (q.x - p.x) * t0, z: p.z + (q.z - p.z) * t0 }, { x: p.x + (q.x - p.x) * t1, z: p.z + (q.z - p.z) * t1 }, 2.2, 0.07, gravel);
          }
        }
      }
    }
  },
};
