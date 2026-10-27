/**
 * The city's trees, shared by every district that plants them (parks, the
 * roundabouts' islands, the tunnel ridges). Three species: a broadleaf street
 * tree (a leaning, tapered trunk with a root flare, limbs reaching up into a
 * crown of jittered leaf clumps), a columnar poplar (clumps stacked tall and
 * narrow) and a conifer (drooping, ragged tiers). Everything about one tree
 * comes from a hash of its position, so the menu city and the race draw the
 * same tree, and every tree is different.
 *
 * Shading is baked into the vertex colours: crowns are dark underneath and
 * inside, lighter on top and outside, with a little hue drift per clump, so
 * they read as foliage under the night's flat light rather than as cones.
 * All trees go into one merged builder (one draw call); its uv carries each
 * vertex's sway weight (0 at the roots, 1 at the crown) and phase, which the
 * material's vertex shader turns into a slow sway in the wind (off at Low).
 *
 * A fourth species, the palm (a bare, ringed, swaying trunk under a crown of
 * arched fronds), stands in the Los Angeles and Miami neighbourhoods. The
 * fronds are flat ribbons folded along their rib and drawn from both sides
 * (no alpha test, no extra material), so palms merge into the same builder
 * and sway through the same vertex shader as every other tree.
 *
 * The trunk stays inside the sim's 0.4 m trunk circle up to car height
 * (flare 0.36 m at the ground, the lean grows with height), and crowns start
 * high enough to clear a car's roof at the circle's edge.
 */
import * as THREE from 'three';
import type { GeoBuilder } from '../geoBuilder';
import { Rng } from '../../sim/prng';
import { clamp01 } from '../../sim/math';
import type { DistrictKit } from './kit';
import { WIND } from '../sky/wind';
import type { Quality } from '../../ui/settings';

const TREE = {
  /** Trunk sides, leaf clumps [min, max] of a broadleaf crown, clump subdivision (0: 20 tris, 1: 80), limbs, conifer tiers and their points, a palm's fronds and the stations along each. */
  detail: {
    low: { sides: 5, clumps: [3, 4], subdiv: 0, limbs: 0, tiers: 3, points: 5, flare: false, fronds: 6, stations: 4 },
    medium: { sides: 6, clumps: [5, 7], subdiv: 0, limbs: 3, tiers: 4, points: 6, flare: true, fronds: 7, stations: 5 },
    high: { sides: 7, clumps: [6, 9], subdiv: 1, limbs: 4, tiers: 6, points: 7, flare: true, fronds: 8, stations: 7 },
  },
  /** Share of the non-conifers that grow columnar, and of the broadleaves with pale plane tree bark. */
  columnar: 0.14,
  pale: 0.2,
  /** Share of the broadleaves turning (rust and copper crowns). */
  turning: 0.09,
  /** Root flare radius at the ground (m): inside the sim's 0.4 m trunk circle. */
  flare: 0.36,
  /** Lowest crown underside over the ground (m): clears a car roof at the trunk circle's edge. */
  crownClear: 2.6,
  /** Furthest the trunk leans at the crown (m). */
  lean: 0.35,
  /** Sway at weight 1 (m) and its two periods' angular speeds (rad/s). */
  sway: 0.11,
  swayRate: [1.1, 2.7],
  /** Share of the leaf and bark colour emitted as the city's sky glow (0: lamps and moon only). */
  glow: 0.2,
} as const;

/**
 * Leaf colours (dark underside, lit top) per species. Lighter and cooler than a daylight green: the night's
 * blue sky and moon light reflect next to nothing off a deep green, which would leave every crown a black blot.
 */
const LEAF = {
  broad: [
    [0x1d3a2a, 0x5a9468],
    [0x223f24, 0x6f9a58],
    [0x183a36, 0x4f8f80],
  ],
  turning: [
    [0x3e2414, 0xb06a30],
    [0x3a1c22, 0x93485a],
  ],
  conifer: [
    [0x142e26, 0x3f7a62],
    [0x17301f, 0x4a7650],
  ],
} as const;
const BARK = { dark: 0x4a3a30, pale: 0x9a9486, conifer: 0x3e3029 } as const;
/** Palm colours: the trunk's grey tan and its darker ring scars, the frond's base and tip (lit), and the coconut cluster under the crown. */
const PALM = { trunk: 0x8a7a66, ring: 0x6a5a48, frond: [0x24462c, 0x6ea35a], alt: [0x2a4a22, 0x86ae56], nuts: 0x4a3a22 } as const;
/** A palm's proportions: trunk base and top radius (m), frond length as a share of the height, its half width (m), droop (m) at the tip, lean (m) over the whole height. */
const PALM_SHAPE = { base: 0.2, top: 0.12, length: [0.34, 0.46], half: 0.3, droop: 1.5, rise: 0.9, lean: 0.9 } as const;

export interface TreeOpts {
  /** Ground height to stand on (m); the terrain under (x, z) when missing. */
  y?: number;
  /** Chance this one is a conifer (0..1). */
  conifer?: number;
  /** The sim's trunk circle (m) when it is not the default 0.4: the wood below the crown is drawn inside it (the sidewalk trees' 0.25). */
  trunk?: number;
}

/** The sim's default trunk circle (m): what TREE.flare and the trunk radii below are drawn inside. */
const TRUNK_SIM = 0.4;
/** Scale of the trunk's wood for a sim circle of `trunk` m (1 at the default; never fatter than it). */
const trunkScale = (trunk?: number): number => (trunk === undefined ? 1 : Math.min(1, trunk / TRUNK_SIM));

/**
 * A palm at (x, z), `height` m tall (trunk and crown): the Los Angeles and Miami street tree. The trunk is inside
 * the sim's 0.4 m trunk circle up to car height, like every tree's, and the fronds start above a car's roof.
 */
export function palm(kit: DistrictKit, x: number, z: number, height: number, opts: Pick<TreeOpts, 'y' | 'trunk'> = {}): void {
  const y = opts.y ?? kit.h(x, z);
  const rng = new Rng((Math.imul(Math.round(x * 64), 83492791) ^ Math.imul(Math.round(z * 64), 19349663)) >>> 0);
  const d = TREE.detail[kit.quality];
  const gb = kit.trees;
  const phase = rng.range(0, 6.28);
  // The trunk bows: a leaning curve in a random direction, more with height.
  const la = rng.range(0, 6.28);
  const lean = rng.range(0.3, 1) * PALM_SHAPE.lean * (height / 9);
  const at = (t: number): V3 => ({ x: x + Math.cos(la) * lean * Math.max(0, t) ** 1.6, y: y + height * t, z: z + Math.sin(la) * lean * Math.max(0, t) ** 1.6 });
  const bark = new THREE.Color(PALM.trunk).multiplyScalar(rng.range(0.85, 1.12));
  const scar = new THREE.Color(PALM.ring).multiplyScalar(rng.range(0.9, 1.1));
  // Ringed trunk: alternating bands, wider at the foot (a root flare that dies out within the first metres).
  const ts = trunkScale(opts.trunk);
  const radius = (t: number): number => ts * Math.min(TREE.flare, TREE.flare * 0.55 * (1 - t) ** 3 + PALM_SHAPE.base * (1 - t) + PALM_SHAPE.top * t);
  const bands = 7;
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands;
    const t1 = (i + 1) / bands;
    const c = i % 2 === 0 ? bark : scar;
    tube(gb, at(i === 0 ? -0.02 : t0), at(t1), radius(t0), radius(t1), d.sides, c, c, weight(height * t0, height), weight(height * t1, height), phase, i === 0 && d.flare ? 3 : 0);
  }
  // The crown: a knot of nuts under the fronds, then the fronds arching out and drooping.
  const top = at(1);
  const nuts = new THREE.Color(PALM.nuts);
  blob(gb, rng, 0, { x: top.x, y: top.y - 0.15, z: top.z }, 0.3, 0.26, phase, height, y, () => nuts);
  const a0 = rng.range(0, 6.28);
  const lo = new THREE.Color(rng.chance(0.5) ? PALM.frond[0] : PALM.alt[0]);
  const hi = new THREE.Color(rng.chance(0.5) ? PALM.frond[1] : PALM.alt[1]);
  const tint = new THREE.Color();
  for (let f = 0; f < d.fronds; f++) {
    const a = a0 + (f / d.fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = height * rng.range(PALM_SHAPE.length[0], PALM_SHAPE.length[1]);
    const lift = rng.range(0.5, 1.2);
    const droop = PALM_SHAPE.droop * rng.range(0.7, 1.3) * (len / 3);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Frond frame: out along (dx, dz); sideways across it.
    const sx = -dz;
    const sz = dx;
    const row: { l: number; r: number; rib: number }[] = [];
    for (let i = 0; i < d.stations; i++) {
      const u = i / (d.stations - 1);
      const out = len * u;
      const up = lift * Math.sin(u * Math.PI * 0.85) * PALM_SHAPE.rise - droop * u * u;
      const half = PALM_SHAPE.half * Math.sin(Math.PI * Math.min(1, u * 0.9 + 0.1)) ** 0.7 * (len / 3);
      const py = top.y + up;
      const cx = top.x + dx * out;
      const cz = top.z + dz * out;
      const shade = tint.lerpColors(lo, hi, 0.25 + 0.7 * u).multiplyScalar(rng.range(0.92, 1.06)).clone();
      const w = Math.min(1, weight(py - y, height) + 0.1 + 0.18 * u);
      // A shallow V: the edges hang below the rib.
      const sag = half * 0.35;
      const nn = Math.hypot(dx * 0.3, 1, dz * 0.3);
      const rib = gb.vertex(cx, py, cz, dx * 0.3 / nn, 1 / nn, dz * 0.3 / nn, w, phase + f * 0.3, shade);
      const l = gb.vertex(cx + sx * half, py - sag, cz + sz * half, 0, 1, 0, w, phase + f * 0.3, shade);
      const r = gb.vertex(cx - sx * half, py - sag, cz - sz * half, 0, 1, 0, w, phase + f * 0.3, shade);
      row.push({ l, r, rib });
    }
    for (let i = 0; i + 1 < row.length; i++) {
      const p = row[i];
      const q = row[i + 1];
      // Both sides of both halves of the folded blade.
      for (const n of [1, -1]) {
        gb.triFacing(p.rib, p.l, q.l, 0, n, 0);
        gb.triFacing(p.rib, q.l, q.rib, 0, n, 0);
        gb.triFacing(p.rib, q.r, p.r, 0, n, 0);
        gb.triFacing(p.rib, q.rib, q.r, 0, n, 0);
      }
    }
  }
}

/** A detailed tree at (x, z): crown radius about `size`, total height `height` (m). */
export function tree(kit: DistrictKit, x: number, z: number, size: number, height: number, opts: TreeOpts = {}): void {
  const y = opts.y ?? kit.h(x, z);
  const rng = new Rng((Math.imul(Math.round(x * 64), 73856093) ^ Math.imul(Math.round(z * 64), 19349663)) >>> 0);
  const d = TREE.detail[kit.quality];
  const phase = rng.range(0, 6.28);
  const ts = trunkScale(opts.trunk);
  if (rng.chance(opts.conifer ?? 0.2)) conifer(kit.trees, rng, d, x, y, z, size, height, phase, ts);
  else if (rng.chance(TREE.columnar)) broadleaf(kit.trees, rng, d, x, y, z, size * 0.5, height * 1.1, phase, true, ts);
  else broadleaf(kit.trees, rng, d, x, y, z, size, height, phase, false, ts);
}

/**
 * The trees' material: lit, flat shaded, vertex coloured, with a faint fill of the city's sky glow (a share of
 * the leaf colour added as emission, so a crown out of the lamps' reach still shows its clumps instead of a
 * black blot) and swaying in the wind on the scene clock (still at Low); the weather's gusts lean them further
 * (`WIND.sway`, render/sky/wind.ts, one shared uniform).
 */
export function treeMaterial(kit: DistrictKit): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  const sway = kit.quality !== 'low';
  const time = { value: 0 };
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * ${TREE.glow.toFixed(3)};`);
    if (!sway) return;
    shader.uniforms.uTreeTime = time;
    shader.uniforms.uTreeWind = WIND.sway;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTreeTime;\nuniform float uTreeWind;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        // uv.x: sway weight (0 at the roots), uv.y: phase. A slow lean plus a quicker rustle.
        float sw = uv.x * ${TREE.sway.toFixed(3)} * uTreeWind;
        float t = uTreeTime;
        transformed.x += sw * (sin(t * ${TREE.swayRate[0].toFixed(2)} + uv.y) + 0.3 * sin(t * ${TREE.swayRate[1].toFixed(2)} + uv.y * 2.3));
        transformed.z += sw * 0.6 * cos(t * ${(TREE.swayRate[0] * 0.8).toFixed(2)} + uv.y * 1.3);
      }`,
    );
  };
  m.customProgramCacheKey = () => (sway ? 'tree:sway' : 'tree');
  if (sway) kit.animate((t) => (time.value = t));
  return m;
}

type Detail = (typeof TREE.detail)[Quality];
interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Sway weight of a point `up` m over the roots of a tree `height` tall. */
const weight = (up: number, height: number): number => clamp01(up / height) ** 2;

function broadleaf(gb: GeoBuilder, rng: Rng, d: Detail, x: number, y: number, z: number, size: number, height: number, phase: number, columnar: boolean, ts = 1): void {
  const turning = !columnar && rng.chance(TREE.turning);
  const pal = turning ? rng.pick(LEAF.turning) : rng.pick(LEAF.broad);
  const dark = new THREE.Color(pal[0]);
  const light = new THREE.Color(pal[1]);
  const pale = !columnar && rng.chance(TREE.pale);
  const bark = new THREE.Color(pale ? BARK.pale : BARK.dark).multiplyScalar(rng.range(0.85, 1.15));
  const base = Math.max(TREE.crownClear, height * (columnar ? 0.22 : 0.38));
  const top = Math.max(height, base + 2.5);
  const ry = (top - base) / 2;
  const cy = y + base + ry;
  // Lean: the trunk drifts off its root as it rises, the crown with it.
  const la = rng.range(0, 6.28);
  const lean = rng.range(0, TREE.lean) * (columnar ? 0.4 : 1);
  const lx = Math.cos(la) * lean;
  const lz = Math.sin(la) * lean;
  const k = Math.min(1.05, Math.max(0.8, height / 8));
  const at = (t: number, up: number): V3 => ({ x: x + lx * t ** 1.5, y: y + up, z: z + lz * t ** 1.5 });

  // Leaf clumps: on an ellipsoid shell around the crown's centre (the upper part more than the lower) and one at the heart.
  const crown = at(1, base + ry);
  const n = columnar ? Math.max(3, d.clumps[0]) : rng.int(d.clumps[0], d.clumps[1]);
  const centres: { c: V3; r: number }[] = [];
  if (columnar) {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const r = size * (1.05 - 0.55 * t) * rng.range(0.85, 1.1);
      centres.push({ c: { x: crown.x + rng.range(-0.15, 0.15), y: y + base + (top - base) * (0.08 + 0.84 * t), z: crown.z + rng.range(-0.15, 0.15) }, r });
    }
  } else {
    centres.push({ c: { x: crown.x, y: cy + ry * 0.1, z: crown.z }, r: size * 0.62 });
    const a0 = rng.range(0, 6.28);
    for (let i = 1; i < n; i++) {
      const a = a0 + i * 2.39996 + rng.range(-0.3, 0.3);
      // Golden angle around, heights from just under the equator up to near the top.
      const h = -0.35 + 1.05 * ((i - 0.5) / (n - 1)) + rng.range(-0.1, 0.1);
      const s = Math.sqrt(Math.max(0, 1 - h * h));
      const reach = rng.range(0.5, 0.62);
      centres.push({ c: { x: crown.x + Math.cos(a) * s * size * reach, y: cy + h * ry * 0.62, z: crown.z + Math.sin(a) * s * size * reach }, r: size * rng.range(0.42, 0.56) });
    }
  }

  // Trunk: root flare, then tapered segments up into the crown's heart.
  const sides = d.sides;
  const flare = d.flare ? 3 : 0;
  const pts: V3[] = [at(0, -0.2), at(0.02, 0.45), at(0.4, base * 0.45), at(1, base), at(1, base + ry * (columnar ? 1.2 : 0.6))];
  const radii = [TREE.flare * ts, 0.24 * k * ts, 0.2 * k * ts, 0.15 * k * ts, 0.07];
  if (columnar) for (let i = 1; i < radii.length; i++) radii[i] *= 0.8;
  for (let i = 0; i < pts.length - 1; i++) {
    const c0 = bark.clone().multiplyScalar(i === 0 ? 0.7 : 1);
    tube(gb, pts[i], pts[i + 1], radii[i], radii[i + 1], sides, c0, bark, weight(pts[i].y - y, height), weight(pts[i + 1].y - y, height), phase, i === 0 ? flare : 0);
  }
  // Limbs: from the top of the bole out to the outer clumps, ending inside them.
  const limbs = columnar ? 0 : Math.min(d.limbs, centres.length - 1);
  for (let i = 1; i <= limbs; i++) {
    const from = at(rng.range(0.75, 1), base * rng.range(0.85, 1.02));
    const c = centres[i].c;
    const to = { x: from.x + (c.x - from.x) * 0.8, y: from.y + (c.y - from.y) * 0.8, z: from.z + (c.z - from.z) * 0.8 };
    tube(gb, from, to, 0.09 * k, 0.03, 4, bark, bark, weight(from.y - y, height), weight(to.y - y, height), phase, 0);
  }
  // The clumps, shaded by height in the crown, by facing (undersides dark) and by depth (the heart dark).
  const tint = new THREE.Color();
  for (let i = 0; i < centres.length; i++) {
    const { c, r } = centres[i];
    const drift = new THREE.Color().lerpColors(dark, light, rng.range(0.3, 0.7)).offsetHSL(rng.range(-0.02, 0.02), 0, 0);
    const heart = i === 0 && !columnar ? 0.75 : 1;
    const rv = columnar ? r * 1.35 : r * rng.range(0.75, 0.95);
    blob(gb, rng, d.subdiv, c, r, rv, phase + i * 0.4, height, y, (vx, vy, vz, py) => {
      const up = clamp01((py - (y + base)) / (top - base));
      const face = clamp01(0.5 + 0.5 * vy);
      const out = clamp01(0.5 + 0.5 * ((c.x - crown.x) * vx + (c.z - crown.z) * vz) / Math.max(0.5, size));
      const mix = clamp01((0.1 + 0.45 * up + 0.35 * face + 0.15 * out) * heart);
      return tint.lerpColors(dark, light, mix).lerp(drift, 0.25).multiplyScalar(rng.range(0.9, 1.08));
    });
  }
}

function conifer(gb: GeoBuilder, rng: Rng, d: Detail, x: number, y: number, z: number, size: number, height: number, phase: number, ts = 1): void {
  const pal = rng.pick(LEAF.conifer);
  const dark = new THREE.Color(pal[0]);
  const light = new THREE.Color(pal[1]);
  const bark = new THREE.Color(BARK.conifer).multiplyScalar(rng.range(0.85, 1.15));
  const top = y + height * 1.1;
  const skirt = y + Math.max(TREE.crownClear - 0.6, height * 0.16);
  const R = size * 0.85;
  tube(gb, { x, y: y - 0.2, z }, { x, y: y + 0.4, z }, TREE.flare * 0.8 * ts, 0.2 * ts, d.sides, bark.clone().multiplyScalar(0.7), bark, 0, 0, phase, d.flare ? 3 : 0);
  tube(gb, { x, y: y + 0.4, z }, { x, y: y + height * 0.75, z }, 0.2 * ts, 0.06, d.sides, bark, bark, 0, weight(height * 0.75, height * 1.1), phase, 0);
  const n = d.tiers;
  const span = top - skirt;
  const ring: number[] = [];
  const tint = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const yb = skirt + span * t * 0.88;
    const r = R * (1 - t * 0.8) * rng.range(0.92, 1.08);
    const apex = i === n - 1 ? top : yb + (span / n) * 1.9;
    const droop = r * 0.22;
    const m = d.points * 2;
    const a0 = rng.range(0, 6.28);
    const w = (py: number) => weight(py - y, height * 1.1);
    const shade = (up: number, under: boolean) => tint.lerpColors(dark, light, clamp01((under ? 0.05 : 0.35 + 0.5 * up) * (0.85 + 0.3 * t))).multiplyScalar(rng.range(0.9, 1.08));
    // Ragged skirt: points out and drooping, notches in and higher.
    ring.length = 0;
    for (let j = 0; j < m; j++) {
      const a = a0 + (j / m) * Math.PI * 2;
      const tip = j % 2 === 0;
      const rr = r * (tip ? rng.range(0.95, 1.08) : rng.range(0.62, 0.75));
      const py = yb - (tip ? droop : droop * 0.3);
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      ring.push(gb.vertex(px, py, pz, Math.cos(a), 0.4, Math.sin(a), w(py), phase + j * 0.15, shade(0.15, false)));
    }
    const ap = gb.vertex(x, apex, z, 0, 1, 0, w(apex), phase, shade(1, false));
    const under = gb.vertex(x, yb + (apex - yb) * 0.3, z, 0, -1, 0, w(yb), phase, shade(0, true));
    for (let j = 0; j < m; j++) {
      const a = ring[j];
      const b = ring[(j + 1) % m];
      const ang = a0 + ((j + 0.5) / m) * Math.PI * 2;
      gb.triFacing(a, b, ap, Math.cos(ang), 0.6, Math.sin(ang));
      gb.triFacing(a, b, under, 0, -1, 0);
    }
  }
}

/** Tapered tube from a to b (n sides), coloured c0 to c1, with sway weights w0, w1; `lobes` > 0 swells its base into root buttresses. */
function tube(gb: GeoBuilder, a: V3, b: V3, r0: number, r1: number, n: number, c0: THREE.Color, c1: THREE.Color, w0: number, w1: number, phase: number, lobes: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / len;
  const ay = dy / len;
  const az = dz / len;
  // u: perpendicular to the axis and to world up (or x for a level limb); v completes the frame.
  let ux = -az;
  let uy = 0;
  let uz = ax;
  if (Math.abs(ay) > 0.99) {
    ux = 0;
    uy = az;
    uz = -ay;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;
  const r0s: number[] = [];
  const r1s: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const nx = ux * c + vx * s;
    const ny = uy * c + vy * s;
    const nz = uz * c + vz * s;
    const rb = lobes ? r0 * (0.78 + 0.22 * Math.cos(lobes * t + phase)) : r0;
    r0s.push(gb.vertex(a.x + nx * rb, a.y + ny * rb, a.z + nz * rb, nx, ny, nz, w0, phase, c0));
    r1s.push(gb.vertex(b.x + nx * r1, b.y + ny * r1, b.z + nz * r1, nx, ny, nz, w1, phase, c1));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const t = ((i + 0.5) / n) * Math.PI * 2;
    gb.quadFacing(r0s[i], r0s[j], r1s[j], r1s[i], ux * Math.cos(t) + vx * Math.sin(t), uy * Math.cos(t) + vy * Math.sin(t), uz * Math.cos(t) + vz * Math.sin(t));
  }
}

/** A leaf clump: a jittered icosphere `r` wide and `rv` tall, each vertex coloured by `color(unit normal, world y)`. */
function blob(gb: GeoBuilder, rng: Rng, subdiv: number, c: V3, r: number, rv: number, phase: number, height: number, y0: number, color: (vx: number, vy: number, vz: number, py: number) => THREE.Color): void {
  const s = sphere(subdiv);
  const ids: number[] = [];
  for (const [vx, vy, vz] of s.v) {
    const j = rng.range(0.82, 1.14);
    const py = c.y + vy * rv * j;
    // Leaves sway a touch more than the wood under them: the rustle.
    ids.push(gb.vertex(c.x + vx * r * j, py, c.z + vz * r * j, vx, vy, vz, Math.min(1, weight(py - y0, height) + 0.12), phase, color(vx, vy, vz, py)));
  }
  for (const [a, b, d] of s.f) {
    const nx = s.v[a][0] + s.v[b][0] + s.v[d][0];
    const ny = s.v[a][1] + s.v[b][1] + s.v[d][1];
    const nz = s.v[a][2] + s.v[b][2] + s.v[d][2];
    gb.triFacing(ids[a], ids[b], ids[d], nx, ny, nz);
  }
}

const spheres = new Map<number, { v: number[][]; f: number[][] }>();

/** Unit icosphere with shared vertices, `subdiv` times split (cached). */
function sphere(subdiv: number): { v: number[][]; f: number[][] } {
  const hit = spheres.get(subdiv);
  if (hit) return hit;
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(unit);
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = mid.get(key);
      if (i === undefined) {
        i = v.push(unit([(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2])) - 1;
        mid.set(key, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of f) {
      const ab = m(a, b);
      const bc = m(b, c);
      const ca = m(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = next;
  }
  const out = { v, f };
  spheres.set(subdiv, out);
  return out;
}

function unit(p: number[]): number[] {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
}
