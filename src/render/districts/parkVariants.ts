/**
 * What the park variants add to the lawn (city/districts/parkFeatures.ts), drawn from the hints
 * the park's build left, all into the kit's merged builders but the pond's two meshes.
 *
 * Formal garden: a gravel plaza with the shared fountain basin (kit.ts fountainBasin), gravel
 * axes, the parterres as flat flower beds (concentric bands of colour in a checker of two
 * tints round a dark soil middle, draped on the lawn) and the tall hedges (the sim's 'hedge'
 * solids: a clipped box with a rounded cap, drawn in the foliage builder). The low hedges along
 * the axes, the planter pots and the lanterns are destructible props (render/street/props.ts).
 *
 * Lakeside pond: the water as the lake draws it (a flat polygon at the pond's level in the
 * river's dark mirror material, waterMaterial), a muddy band at the waterline, reed clumps
 * round the shore, the jetty (the sim's 'jetty' solid: a plank deck with plank joints and a
 * lantern post at its tip) and, above the low tier, a shimmering reflection of each lantern
 * near the water. The lake's reflection shader is repeated here in brief: lake.ts keeps its
 * own private.
 */
import * as THREE from 'three';
import { circlePolygon, triangulate } from '../../city/districts/geom';
import { makePond, pondPoint, pondRho } from '../../city/districts/parkFeatures';
import { CITY } from '../../city/config';
import type { AreaBuild } from '../../city/districts/types';
import { Rng } from '../../sim/prng';
import type { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit } from './kit';
import { col, cylinder, drapeConvex, fountainBasin, groundLine, groundVertex, prism } from './kit';
import { waterMaterial } from './river';
import { heightFogShader } from '../heightFog';

const POND = CITY.districts.park.lakeside;

const LOOK = {
  gravel: col(0x6b6350),
  /** Flower bed: the soil, then the bands from the edge in (each a checker of two tints). */
  soil: col(0x2a2118),
  bands: [
    [col(0x7a2d3f), col(0xb44a5c)],
    [col(0xc9a32a), col(0xe8c75a)],
    [col(0x4f3d8a), col(0x7d63c0)],
    [col(0xb8582a), col(0xe08a4a)],
  ],
  edging: col(0x8b8372),
  bandWidth: 1.15,
  tuft: 1.25,
  hedge: col(0x1c4a24),
  hedgeTop: col(0x2a6a30),
  cap: 0.2,
  capIn: 0.18,
  mud: col(0x2d281f),
  mudWidth: 1.1,
  wood: col(0x5d4632),
  woodDark: col(0x2c2118),
  woodTop: col(0x7a6044),
  water: col(0x060b14),
  waterRoughness: 0.05,
  reeds: [col(0x3c4a29), col(0x56603a), col(0x4b412b)],
  reedShare: { low: 0.45, medium: 0.7, high: 0.85 },
  reedBlades: 7,
  plank: 1.1,
  lampPole: 3,
  lampColor: new THREE.Color(1, 0.8, 0.55).multiplyScalar(2.2),
  glint: new THREE.Color(1, 0.7, 0.4).multiplyScalar(0.55),
  glintLen: 14,
  glintHalf: 0.7,
  glintBands: 6,
} as const;

/** Draws the variants' hints of one park into the kit. */
export function parkVariants(kit: DistrictKit, b: AreaBuild, seed: number): void {
  for (const h of b.hints) {
    if (h.kind === 'plaza') drapeConvex(kit, kit.paint, circlePolygon(h.points[0].x, h.points[0].z, h.values[0], 20), 0.066, LOOK.gravel, 8);
    else if (h.kind === 'basin') fountainBasin(kit, h.points[0].x, h.points[0].z, h.values[0], h.values[1]);
    else if (h.kind === 'walk') walk(kit, h.points[0], h.points[1], h.values[0]);
    else if (h.kind === 'bed') bed(kit, h.points, h.values[0]);
    else if (h.kind === 'hedge') hedge(kit, h.points, h.values[0]);
  }
  const pond = b.hints.find((h) => h.kind === 'pond');
  if (pond) drawPond(kit, b, pond.points, pond.values, seed);
}

/** A gravel axis from a to b, cut into pieces so it follows the lawn. */
function walk(kit: DistrictKit, a: Vec2, b: Vec2, width: number): void {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3));
  for (let k = 0; k < n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n };
    const q = { x: a.x + ((b.x - a.x) * (k + 1)) / n, z: a.z + ((b.z - a.z) * (k + 1)) / n };
    groundLine(kit, kit.paint, p, q, width, 0.062, LOOK.gravel);
  }
}

/** A parterre: an edging, bands of flowers in two tints, a soil middle; `scheme` picks the tints from the bands. */
function bed(kit: DistrictKit, rect: Vec2[], scheme: number): void {
  const c = { x: (rect[0].x + rect[2].x) / 2, z: (rect[0].z + rect[2].z) / 2 };
  const side = Math.hypot(rect[1].x - rect[0].x, rect[1].z - rect[0].z);
  const inset = (d: number) => rect.map((p) => {
    const l = Math.hypot(p.x - c.x, p.z - c.z) || 1;
    // Moving each corner toward the middle along its diagonal by d * sqrt 2 moves each side in by d.
    return { x: p.x - ((p.x - c.x) / l) * d * Math.SQRT2, z: p.z - ((p.z - c.z) / l) * d * Math.SQRT2 };
  });
  const ring = (d0: number, d1: number, colors: readonly THREE.Color[], lift: number) => {
    // Pieces of the band side by side along each of the four sides, alternating tint.
    const outer = inset(d0);
    const inner = inset(d1);
    let k = 0;
    for (let i = 0; i < 4; i++) {
      const o0 = outer[i];
      const o1 = outer[(i + 1) % 4];
      const i0 = inner[i];
      const i1 = inner[(i + 1) % 4];
      const n = Math.max(1, Math.round(Math.hypot(o1.x - o0.x, o1.z - o0.z) / LOOK.tuft));
      for (let j = 0; j < n; j++) {
        const t0 = j / n;
        const t1 = (j + 1) / n;
        const color = colors[k++ % colors.length];
        const v = [
          groundVertex(kit, kit.paint, o0.x + (o1.x - o0.x) * t0, o0.z + (o1.z - o0.z) * t0, lift, color),
          groundVertex(kit, kit.paint, o0.x + (o1.x - o0.x) * t1, o0.z + (o1.z - o0.z) * t1, lift, color),
          groundVertex(kit, kit.paint, i0.x + (i1.x - i0.x) * t1, i0.z + (i1.z - i0.z) * t1, lift, color),
          groundVertex(kit, kit.paint, i0.x + (i1.x - i0.x) * t0, i0.z + (i1.z - i0.z) * t0, lift, color),
        ];
        kit.paint.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
      }
    }
  };
  ring(0, 0.4, [LOOK.edging], 0.09);
  const bands = Math.min(LOOK.bands.length, Math.max(1, Math.floor((side / 2 - 3) / LOOK.bandWidth)));
  for (let k = 0; k < bands; k++) {
    const tints = LOOK.bands[(scheme + k) % LOOK.bands.length];
    ring(0.4 + k * LOOK.bandWidth, 0.4 + (k + 1) * LOOK.bandWidth + 0.02, tints, 0.08);
  }
  drapeConvex(kit, kit.paint, inset(0.4 + bands * LOOK.bandWidth), 0.075, LOOK.soil, 8);
}

/** A tall hedge piece: a clipped box with a narrower cap on top, in the foliage builder. */
function hedge(kit: DistrictKit, poly: Vec2[], height: number): void {
  prism(kit, kit.foliage, poly, height - LOOK.cap, LOOK.hedge, LOOK.hedgeTop);
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
  const cap = poly.map((p) => {
    const l = Math.hypot(p.x - cx, p.z - cz) || 1;
    return { x: p.x - ((p.x - cx) / l) * LOOK.capIn * Math.SQRT2, z: p.z - ((p.z - cz) / l) * LOOK.capIn * Math.SQRT2 };
  });
  prism(kit, kit.foliage, cap, LOOK.cap + 0.1, LOOK.hedgeTop, LOOK.hedgeTop, -(height - LOOK.cap - 0.1));
}

// ---------------------------------------------------------------------------------------------
// Lakeside pond

function addMesh(kit: DistrictKit, gb: GeoBuilder, mat: THREE.Material, name: string, order: number): THREE.Mesh | null {
  if (!gb.vertexCount) return null;
  const m = new THREE.Mesh(kit.track(gb.build()), mat);
  m.name = name;
  m.renderOrder = order;
  kit.group.add(m);
  return m;
}

/** The pond: hint values are [water level, cx, cz, a, b, phi, jetty angle]. */
function drawPond(kit: DistrictKit, b: AreaBuild, water: Vec2[], v: number[], seed: number): void {
  const W = v[0];
  const pond = makePond(v[1], v[2], v[3], v[4], v[5], 0);
  const rng = new Rng((seed ^ 0x9e3779b1) >>> 0 || 1);

  // The water: one flat polygon at the pond's level.
  const wet = new GeoBuilder(true);
  for (const [p, q, r] of triangulate(water)) {
    const ids = [p, q, r].map((pt) => wet.vertex(pt.x, W, pt.z, 0, 1, 0, pt.x / 8, pt.z / 8, LOOK.water));
    wet.triFacing(ids[0], ids[1], ids[2], 0, 1, 0);
  }
  const mat = kit.track(waterMaterial());
  mat.roughness = LOOK.waterRoughness;
  addMesh(kit, wet, mat, `pondWater`, 1);

  // A band of mud where the bank meets the water.
  for (let i = 0; i < water.length; i++) {
    const p = water[i];
    const q = water[(i + 1) % water.length];
    const s = (pt: Vec2) => {
      const k = (pond.a + LOOK.mudWidth * 0.5) / pond.a;
      return { x: pond.cx + (pt.x - pond.cx) * k, z: pond.cz + (pt.z - pond.cz) * k };
    };
    groundLine(kit, kit.paint, s(p), s(q), LOOK.mudWidth, 0.06, LOOK.mud);
  }

  // The jetty: planks on a solid, a lantern at its tip.
  const lights: { x: number; z: number; k: number }[] = [];
  const deck = b.hints.find((h) => h.kind === 'jetty');
  if (deck) jetty(kit, deck.points, deck.values[0], lights);

  // Reed clumps round the shore, clear of the jetty.
  const share = LOOK.reedShare[kit.quality];
  const root = deck ? { x: (deck.points[0].x + deck.points[3].x) / 2, z: (deck.points[0].z + deck.points[3].z) / 2 } : null;
  const n = Math.max(8, Math.round((Math.PI * 2 * pond.a * 0.9) / POND.reedStep));
  for (let i = 0; i < n; i++) {
    const th = ((i + rng.range(-0.3, 0.3)) / n) * Math.PI * 2;
    const k = rng.chance(share);
    const rho = pond.a - rng.range(0.1, 0.9);
    const at = pondPoint(pond, rho, th);
    if (!k || (root && Math.hypot(at.x - root.x, at.z - root.z) < 5)) continue;
    clump(kit.foliage, at.x, W - 0.25, at.z, rng);
  }

  // Reflections of the lanterns by the water (the bench lamp and the jetty's).
  for (const d of b.destructibles) {
    if (d.kind !== 'parkLamp') continue;
    const rho = pondRho(pond, d.x, d.z);
    if (rho > pond.a + 14 || rho < 1) continue;
    const k = (pond.a - 0.5) / rho;
    lights.push({ x: pond.cx + (d.x - pond.cx) * k, z: pond.cz + (d.z - pond.cz) * k, k: 1 });
  }
  if (kit.quality !== 'low' && lights.length) shimmer(kit, lights, W);
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
    const ids = [gb.vertex(bx - nz * w, y, bz + nx * w, nx, 0.2, nz, 0, 0, color), gb.vertex(bx + nz * w, y, bz - nx * w, nx, 0.2, nz, 0, 0, color), gb.vertex(bx + Math.cos(la) * lean, y + h, bz + Math.sin(la) * lean, nx, 0.2, nz, 0, 0, color)];
    gb.tri(ids[0], ids[1], ids[2]);
    gb.tri(ids[0], ids[2], ids[1]);
  }
}

/**
 * The jetty over its solid: `deck` is the rectangle root-first (root left, tip left, tip right, root
 * right), its top at the absolute height `top`. Plank joints across it, a lantern on a pole at the tip.
 */
function jetty(kit: DistrictKit, deck: Vec2[], top: number, lights: { x: number; z: number; k: number }[]): void {
  let hi = -Infinity;
  for (const p of deck) hi = Math.max(hi, kit.h(p.x, p.z));
  prism(kit, kit.solid, deck, top - hi, LOOK.wood, LOOK.woodTop, 0.4);
  const ux = deck[1].x - deck[0].x;
  const uz = deck[1].z - deck[0].z;
  const len = Math.hypot(ux, uz) || 1;
  const nx = ux / len;
  const nz = uz / len;
  const wx = deck[3].x - deck[0].x;
  const wz = deck[3].z - deck[0].z;
  const y = top + 0.012;
  for (let s = LOOK.plank; s < len - 0.4; s += LOOK.plank) {
    const ax = deck[0].x + nx * s;
    const az = deck[0].z + nz * s;
    const g = 0.03;
    const q = [
      kit.solid.vertex(ax, y, az, 0, 1, 0, 0, 0, LOOK.woodDark),
      kit.solid.vertex(ax + wx, y, az + wz, 0, 1, 0, 0, 0, LOOK.woodDark),
      kit.solid.vertex(ax + wx + nx * g, y, az + wz + nz * g, 0, 1, 0, 0, 0, LOOK.woodDark),
      kit.solid.vertex(ax + nx * g, y, az + nz * g, 0, 1, 0, 0, 0, LOOK.woodDark),
    ];
    kit.solid.quadFacing(q[0], q[1], q[2], q[3], 0, 1, 0);
  }
  // The lantern pole a little in from the tip, at the deck's edge.
  const px = (deck[1].x + deck[2].x) / 2 - nx * 0.5 + (wx / 2) * 0.7;
  const pz = (deck[1].z + deck[2].z) / 2 - nz * 0.5 + (wz / 2) * 0.7;
  cylinder(kit.solid, px, pz, 0.07, top, top + LOOK.lampPole, 6, LOOK.woodDark, true);
  cylinder(kit.glow, px, pz, 0.17, top + LOOK.lampPole, top + LOOK.lampPole + 0.34, 6, LOOK.lampColor, true, 0.1);
  lights.push({ x: (deck[1].x + deck[2].x) / 2 + nx * 0.5, z: (deck[1].z + deck[2].z) / 2 + nz * 0.5, k: 1.2 });
}

/**
 * The lanterns' reflections: per light a streak on the water from just off the shore toward the camera,
 * cut into bands that shimmer (the lake's, render/districts/lake.ts streaks, shorter). Every vertex of a
 * streak carries its start as its position and (along, across) in its uv; the vertex shader lays it out.
 */
function shimmer(kit: DistrictKit, lights: readonly { x: number; z: number; k: number }[], W: number): void {
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
    shader.uniforms.uPondTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uPondTime;')
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
        vColor.rgb *= 0.55 + 0.45 * sin(uPondTime * 2.3 + uv.x * 13.0 + position.x * 0.37 + position.z * 0.29);`,
      );
    // Additive light fades to black in fog, never toward the fog color (render/street/areaLights.ts).
    heightFogShader(shader, true);
  };
  mat.customProgramCacheKey = () => 'park:pondShimmer';
  kit.animate((t) => (time.value = t));
  const mesh = addMesh(kit, gb, mat, 'pondShimmer', 2);
  // Its positions are the streaks' starts only: the laid out streaks reach past any bounds of those.
  if (mesh) mesh.frustumCulled = false;
}
