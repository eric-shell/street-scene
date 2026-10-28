/**
 * Life on the roofs, picked once per city from the architecture plan and the
 * seed (render only, the sim never sees it, so replays are identical):
 *  - helipads on the 2-4 tallest glass and condo towers with a flat roof deck:
 *    a painted H in a ring, a perimeter of green and white lights and an amber
 *    beacon on a short mast. The news helicopter lands on them on a timetable
 *    (traffic/airTraffic.ts reads `helipadsOf(world)` and `ROOF_LIFE.landing`);
 *  - rooftop parties on 3-6 mid-rise roofs near downtown or the route: festoon
 *    string lights from the stair bulkhead to four masts, bunting, a lit bar
 *    with its back shelf, speakers whose cones pulse slowly on the clock, a
 *    parasol, planters, and a warm pool of light on the deck. No people.
 * Geometry goes into the builders every roof already uses (roofs, neon); the
 * halos, the speaker pulse and the beacons are additive sprites in one more
 * mesh (`roofGlow`), animated by the shader from the clock. Every building's
 * choices draw from its own seeded `Rng`, never from the mesher's stream.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Building } from '../../city/blocks';
import { downtownFactor } from '../../city/roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { FOG_DENSITY } from '../lighting';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';
import type { RouteNearness } from '../street/routeNearness';
import type { BuildingPlan } from './architecture';
import { Frame, cap, colorOf, facet, lbox } from './buildingKit';
import type { Out } from './buildingKit';

/** Counts, sizes (m), speeds and odds of the life on the roofs. */
export const ROOF_LIFE = {
  pads: {
    /** Helipads per city (min, max), on the tallest eligible towers. */
    count: [2, 4] as [number, number],
    /** Least visual height above the street (m) and footprint short side (m) a tower needs: the deck must fit the pad with the glass setback off it. */
    minHeight: 50,
    minFootprint: 26,
    /** Towers this close (m) to a chosen one are skipped, so the pads spread over the skyline. */
    spacing: 140,
    /** Radius of the landing disc (m); the perimeter lights sit `lights` m from its center. */
    radius: 6.4,
    lights: 6.9,
    /** Perimeter lights round the pad. */
    lightCount: 16,
  },
  parties: {
    /** Parties per city (min, max). */
    count: [3, 6] as [number, number],
    /** Roof height range (m above the street) and the shortest footprint side (m) of a roof that takes one. */
    height: [20, 70] as [number, number],
    minFootprint: 16,
    /** Parties keep this far (m) from each other. */
    spacing: 70,
    /** Festoon: bulb spacing (m), sag (m), mast height (m). */
    bulbPitch: 0.85,
    sag: 0.55,
    mast: 3.6,
    /** Speaker cone pulse period (s) and the glow's size (m). */
    pulse: 2.2,
    speakerGlow: 1.5,
    /** Halo over the deck: radius as a share of the deck's long side, and its strength. */
    haloShare: 0.62,
    haloStrength: 0.2,
  },
  crane: {
    /** Tower crane over a construction shortcut: mast height above its footing (m), jib reach past the site's middle (m). */
    mast: 17,
    reachPast: 7,
    /** Counter-jib length as a share of the jib. */
    counter: 0.36,
    /** The jib's slew: a swing of this many degrees either side of its heading, at this period (s) (about 6 degrees a minute). */
    swingDeg: 9,
    swingPeriod: 540,
    /** The crane stands on the nearest roof within `reach` m of the site's middle that is between these heights (m) and carries no pad or party. */
    reach: 55,
    roofs: [7, 60] as [number, number],
    /** Hook drop below the jib (m), and the least it hangs above the street (m): a car never meets it. */
    hookDrop: 8,
    hookClear: 9,
  },
  /**
   * The news helicopter's landing timetable (s, a pure function of the clock): every `cycle` s from `first`
   * it leaves its loop, comes in over `approach`, drops over `descend`, sits `ground` s (rotor winding down
   * over `spinDown`, idling at `idle` of full speed, spooling back up over `spinUp`), climbs over `climb` and
   * rejoins its loop over `depart`. The pad is the next one in the city's order each time.
   */
  landing: {
    cycle: 420,
    first: 70,
    approach: 24,
    descend: 14,
    ground: 40,
    spinDown: 12,
    spinUp: 8,
    idle: 0.12,
    climb: 10,
    depart: 24,
    /** Hover height over the pad where the approach ends (m). */
    hover: 30,
  },
  glow: {
    /** Amber beacon: blink period (s). */
    beaconPeriod: 1.4,
  },
} as const;

export type RoofRole = 'pad' | 'party' | null;

/** A helipad as built: the touchdown point (world, m) and the heading the nose takes (rad, forward is (sin, cos)). */
export interface Helipad {
  x: number;
  y: number;
  z: number;
  yaw: number;
  radius: number;
}

const padsByWorld = new WeakMap<World, Helipad[]>();
const centersByWorld = new WeakMap<World, { x: number; z: number }[]>();

/** Footprint centers of the buildings that carry a pad or a party (empty until buildBuildings ran): a crane keeps off their roofs. */
export function roofLifeCenters(world: World): readonly { x: number; z: number }[] {
  return centersByWorld.get(world) ?? [];
}

/** The helipads the buildings built for this world, in building order (empty until buildBuildings ran). */
export function helipadsOf(world: World): readonly Helipad[] {
  return padsByWorld.get(world) ?? [];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const hash01 = (n: number): number => (Math.imul(n | 0, 0x9e3779b1) >>> 8) / 0x1000000;

/** Whether a building style/shape can carry a helipad before the mesher has set it (flat glass or condo roof). */
function padEligible(b: Building, plan: BuildingPlan): boolean {
  if (plan.landmark || (plan.style !== 'glass' && plan.style !== 'condo')) return false;
  const P = ROOF_LIFE.pads;
  return plan.h >= P.minHeight && Math.min(b.w, b.d) >= P.minFootprint;
}

/** Whether a building takes a party: a flat masonry or condo roof of mid height, wide enough for the bar and the masts. */
function partyEligible(b: Building, plan: BuildingPlan): boolean {
  if (plan.landmark || (plan.style !== 'prewar' && plan.style !== 'brownstone' && plan.style !== 'condo')) return false;
  const P = ROOF_LIFE.parties;
  return plan.h >= P.height[0] && plan.h <= P.height[1] && Math.min(b.w, b.d) >= P.minFootprint && plan.h < ROOF_LIFE.pads.minHeight + (plan.style === 'condo' ? 0 : 100);
}

/**
 * Which street buildings carry what, and the sprites and pads they raise while they are built. `begin(i)`
 * is called before each building; the roof code reads `role` and `rng`.
 */
export class RoofLife {
  readonly roles = new Map<number, RoofRole>();
  readonly pads: Helipad[] = [];
  /** Deck centers (world, m) of the parties as built, for the perf report and tests. */
  readonly parties: { x: number; y: number; z: number }[] = [];
  role: RoofRole = null;
  rng = new Rng(1);
  private sprites: number[] = [];
  private seed: number;
  private count = 0;

  constructor(
    private world: World,
    buildings: readonly Building[],
    plans: readonly BuildingPlan[],
    near: RouteNearness,
  ) {
    this.seed = world.seed;
    const rng = new Rng(deriveSeed(world.seed, 'roofLife'));
    const g = world.graph;
    // Pads: the tallest eligible towers, spread out.
    const tall = buildings.map((_, i) => i).filter((i) => padEligible(buildings[i], plans[i]));
    tall.sort((a, b) => plans[b].h - plans[a].h || a - b);
    const wantPads = rng.int(ROOF_LIFE.pads.count[0], ROOF_LIFE.pads.count[1]);
    const chosen: number[] = [];
    for (const i of tall) {
      if (chosen.length >= wantPads) break;
      if (chosen.every((j) => Math.hypot(buildings[i].x - buildings[j].x, buildings[i].z - buildings[j].z) >= ROOF_LIFE.pads.spacing)) chosen.push(i);
    }
    for (const i of chosen) this.roles.set(i, 'pad');
    this.centers = buildings.map((b) => ({ x: b.x, z: b.z }));
    // Parties: mid-rise roofs near downtown or the route, seeded jitter so it is not always the very closest.
    const cand = buildings.map((_, i) => i).filter((i) => !this.roles.has(i) && partyEligible(buildings[i], plans[i]));
    const score = new Map<number, number>();
    for (const i of cand) {
      const b = buildings[i];
      score.set(i, downtownFactor(g.plan, b.x, b.z) + near.at(b.x, b.z) * 0.9 + hash01(plans[i].seed ^ 0x5eed) * 0.5);
    }
    cand.sort((a, b) => score.get(b)! - score.get(a)! || a - b);
    const wantParties = rng.int(ROOF_LIFE.parties.count[0], ROOF_LIFE.parties.count[1]);
    const parties: number[] = [];
    for (const i of cand) {
      if (parties.length >= wantParties) break;
      if (parties.every((j) => Math.hypot(buildings[i].x - buildings[j].x, buildings[i].z - buildings[j].z) >= ROOF_LIFE.parties.spacing)) parties.push(i);
    }
    for (const i of parties) this.roles.set(i, 'party');
    this.plans = plans;
  }

  private plans: readonly BuildingPlan[];
  private centers: { x: number; z: number }[];

  /** Counts for the perf report and tests. */
  get counts(): { pads: number; parties: number } {
    let pads = 0;
    let parties = 0;
    for (const r of this.roles.values()) if (r === 'pad') pads++;
    else parties++;
    return { pads, parties };
  }

  /** Start building street building `i` (-1: a backlot or anything that takes no life). */
  begin(i: number): void {
    this.role = i >= 0 ? (this.roles.get(i) ?? null) : null;
    if (this.role) this.rng = new Rng((deriveSeed(this.seed, `roof${i}`) ^ this.plans[i].seed) >>> 0 || 1);
  }

  /** An additive sprite: world position, size (m), colour (linear, scaled), kind (0 steady, 1 pulse, 2 blink), phase 0..1 and period (s). */
  sprite(x: number, y: number, z: number, size: number, color: THREE.Color, kind: 0 | 1 | 2, phase: number, period: number): void {
    this.sprites.push(x, y, z, size, color.r, color.g, color.b, kind, phase, period);
    this.count++;
  }

  /** The glow mesh and its per-frame update, or null when nothing raised a sprite. */
  buildGlow(track: <T extends { dispose(): void }>(x: T) => T): { mesh: THREE.Mesh; update(time: number): void } | null {
    padsByWorld.set(this.world, this.pads);
    centersByWorld.set(this.world, [...this.roles.keys()].map((i) => this.centers[i]));
    const n = this.count;
    if (!n) return null;
    const pos = new Float32Array(n * 12);
    const corner = new Float32Array(n * 8);
    const data = new Float32Array(n * 16);
    const color = new Float32Array(n * 12);
    const idx = new Uint32Array(n * 6);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let k = 0; k < n; k++) {
      const s = this.sprites;
      const o = k * 10;
      for (let c = 0; c < 4; c++) {
        pos.set([s[o], s[o + 1], s[o + 2]], k * 12 + c * 3);
        corner.set([C[c * 2], C[c * 2 + 1]], k * 8 + c * 2);
        data.set([s[o + 3], s[o + 7], s[o + 8], s[o + 9]], k * 16 + c * 4);
        color.set([s[o + 4], s[o + 5], s[o + 6]], k * 12 + c * 3);
      }
      idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
    }
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const uTime = { value: 0 };
    const mat = track(
      new THREE.ShaderMaterial({
        uniforms: { uTime, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.name = 'roofGlow';
    return {
      mesh,
      update(time) {
        uTime.value = time;
      },
    };
  }
}

const GLOW_VERT = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 aData;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vCorner;
  varying vec3 vColor;
  varying float vI;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = length(mv.xyz);
    // At least about 3 px at 1080p, so a far beacon never drops below one lit pixel.
    float px = dist / (projectionMatrix[1][1] * 540.0);
    float size = max(aData.x, px * 3.0);
    mv.xy += corner * size;
    gl_Position = projectionMatrix * mv;
    vCorner = corner;
    vColor = aColor;
    float t = uTime / aData.w + aData.z;
    float inten = 1.0;
    if (aData.y > 1.5) inten = smoothstep(0.0, 0.05, fract(t)) * (1.0 - smoothstep(0.22, 0.34, fract(t)));
    else if (aData.y > 0.5) inten = 0.55 + 0.45 * sin(t * 6.2831853);
    // A sprite the size of a room fades as the camera closes on it, so it never washes the screen.
    float near = smoothstep(0.8, 2.2, dist / max(aData.x, 1.0));
    vI = inten * near * exp(-fogDensity * fogDensity * dist * dist * 0.35 * hfMulView(mv.xyz));
  }
`;

const GLOW_FRAG = /* glsl */ `
  varying vec2 vCorner;
  varying vec3 vColor;
  varying float vI;
  void main() {
    float d = length(vCorner);
    float a = smoothstep(1.0, 0.0, d);
    gl_FragColor = vec4(vColor * (a * a) * vI, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A square-section strut between two world points (posts, wires, braces). */
export function strut(gb: GeoBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, color: THREE.Color): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-6;
  const fx = dx / len;
  const fy = dy / len;
  const fz = dz / len;
  // Any vector not parallel to the strut gives the first side axis.
  let sx = 0;
  let sy = 1;
  let sz = 0;
  if (Math.abs(fy) > 0.9) {
    sx = 1;
    sy = 0;
  }
  let ux = fy * sz - fz * sy;
  let uy = fz * sx - fx * sz;
  let uz = fx * sy - fy * sx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux = (ux / ul) * t;
  uy = (uy / ul) * t;
  uz = (uz / ul) * t;
  const vx = (fy * uz - fz * uy) / t;
  const vy = (fz * ux - fx * uz) / t;
  const vz = (fx * uy - fy * ux) / t;
  const vxs = vx * t;
  const vys = vy * t;
  const vzs = vz * t;
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const ring = (px: number, py: number, pz: number): [number, number, number][] => corners.map(([a, b]) => [px + ux * a + vxs * b, py + uy * a + vys * b, pz + uz * a + vzs * b]);
  const r0 = ring(ax, ay, az);
  const r1 = ring(bx, by, bz);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // Outward normal of this side: the mean of its two corner offsets.
    const nx = (r0[i][0] + r0[j][0]) / 2 - ax;
    const ny = (r0[i][1] + r0[j][1]) / 2 - ay;
    const nz = (r0[i][2] + r0[j][2]) / 2 - az;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const a = gb.vertex(r0[i][0], r0[i][1], r0[i][2], nx / nl, ny / nl, nz / nl, 0, 0, color);
    const b = gb.vertex(r0[j][0], r0[j][1], r0[j][2], nx / nl, ny / nl, nz / nl, 0, 0, color);
    const c = gb.vertex(r1[j][0], r1[j][1], r1[j][2], nx / nl, ny / nl, nz / nl, 0, 0, color);
    const d = gb.vertex(r1[i][0], r1[i][1], r1[i][2], nx / nl, ny / nl, nz / nl, 0, 0, color);
    gb.quadFacing(a, b, c, d, nx / nl, ny / nl, nz / nl);
  }
}

const WHITE_PAINT = colorOf(0xdcdcd2, 0.85);
const ring = (n: number, r: number, cx: number, cz: number, phase = 0): { x: number; z: number }[] =>
  Array.from({ length: n }, (_, k) => ({ x: cx + Math.cos(phase + (k / n) * Math.PI * 2) * r, z: cz + Math.sin(phase + (k / n) * Math.PI * 2) * r }));

/**
 * A helipad on a flat roof deck: a dark disc with a white ring and an H, a perimeter of green and white lights, and an
 * amber beacon on a short mast in the deck's corner. Records the touchdown point for the news helicopter.
 */
function helipad(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number): void {
  const P = ROOF_LIFE.pads;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const R = P.radius;
  const life = o.life;
  cap(o.roofs, F, ring(28, R, cx, cz), y + 0.04, colorOf(0x23262c));
  // The ring: an annulus of white paint just inside the disc's edge.
  const n = 36;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    const q = (a: number, r: number) => [F.X(cx + Math.cos(a) * r, cz + Math.sin(a) * r), F.Z(cx + Math.cos(a) * r, cz + Math.sin(a) * r)] as const;
    const A = q(a0, R - 0.9);
    const B = q(a0, R - 0.5);
    const C = q(a1, R - 0.5);
    const D = q(a1, R - 0.9);
    const ids = [A, B, C, D].map((p) => o.roofs.vertex(p[0], y + 0.06, p[1], 0, 1, 0, 0, 0, WHITE_PAINT));
    o.roofs.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
  }
  // The H.
  const yellowWhite = colorOf(0xf0ead0, 0.9);
  lbox(o.roofs, F, cx - 1.6, cx - 1.1, cz - 2.3, cz + 2.3, y + 0.04, y + 0.09, yellowWhite, false);
  lbox(o.roofs, F, cx + 1.1, cx + 1.6, cz - 2.3, cz + 2.3, y + 0.04, y + 0.09, yellowWhite, false);
  lbox(o.roofs, F, cx - 1.1, cx + 1.1, cz - 0.25, cz + 0.25, y + 0.04, y + 0.09, yellowWhite, false);
  // Perimeter lights, green and white in turn, a few with a halo.
  const green = new THREE.Color(0.1, 1, 0.3).multiplyScalar(2.2);
  const white = new THREE.Color(1, 0.97, 0.9).multiplyScalar(2.2);
  ring(P.lightCount, P.lights, cx, cz).forEach((p, k) => {
    lbox(o.neon, F, p.x - 0.14, p.x + 0.14, p.z - 0.14, p.z + 0.14, y + 0.04, y + 0.3, k % 2 ? white : green, false);
    if (k % 4 === 0) life.sprite(F.X(p.x, p.z), y + 0.5, F.Z(p.x, p.z), 1.1, (k % 2 ? white : green).clone().multiplyScalar(0.28), 0, 0, 1);
  });
  // The beacon: a mast in the corner farthest from where the cornice's masts and lights sit, amber, turning slowly.
  const mx = x1 - 1.1;
  const mz = z0 + 1.1;
  const amber = new THREE.Color(1, 0.55, 0.06);
  lbox(o.roofs, F, mx - 0.06, mx + 0.06, mz - 0.06, mz + 0.06, y, y + 3.2, colorOf(0x55585e), false);
  lbox(o.neon, F, mx - 0.16, mx + 0.16, mz - 0.16, mz + 0.16, y + 3.2, y + 3.5, amber.clone().multiplyScalar(2.4), false);
  life.sprite(F.X(mx, mz), y + 3.6, F.Z(mx, mz), 2.4, amber.clone().multiplyScalar(2.2), 2, life.rng.next(), ROOF_LIFE.glow.beaconPeriod);
  // A soft wash of the floodlit deck, so the pad reads from the street as a lit square high up.
  life.sprite(F.X(cx, cz), y + 1.5, F.Z(cx, cz), R * 1.5, new THREE.Color(0.5, 0.75, 0.55).multiplyScalar(0.1), 0, 0, 1);
  life.pads.push({ x: F.X(cx, cz), y: y + 0.09, z: F.Z(cx, cz), yaw: Math.atan2(F.wx, F.wz), radius: R });
}

/** A festoon of warm bulbs hung between two points (local x, y absolute, z), sagging in the middle. */
function festoon(o: Out, F: Frame, ax: number, ay: number, az: number, bx: number, by: number, bz: number, bulb: THREE.Color, wire: THREE.Color): void {
  const P = ROOF_LIFE.parties;
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(2, Math.round(len / P.bulbPitch));
  let px = ax;
  let py = ay;
  let pz = az;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const y = ay + (by - ay) * t - Math.sin(t * Math.PI) * P.sag;
    if (k % 2 === 0 || k === n) {
      strut(o.roofs, F.X(px, pz), py, F.Z(px, pz), F.X(x, z), y, F.Z(x, z), 0.012, wire);
      px = x;
      py = y;
      pz = z;
    }
    if (k < n) lbox(o.neon, F, x - 0.07, x + 0.07, z - 0.07, z + 0.07, y - 0.17, y - 0.03, bulb, false);
  }
}

/**
 * A rooftop party on a flat roof deck: wood boards with a warm lit middle, a stair bulkhead, four masts, festoons from
 * the masts to the bulkhead and across, bunting along the front, a bar with its lit back shelf, two speakers with a
 * slowly pulsing glow, planters and a parasol. No people. Returns false (draws nothing) when the roof is too small.
 */
function party(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number): boolean {
  const P = ROOF_LIFE.parties;
  const W = x1 - x0;
  const D = z1 - z0;
  if (W < 10 || D < 10) return false;
  const life = o.life;
  const rng = life.rng;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const wood = colorOf(0x4a3322, 0.9);
  const dark = colorOf(0x1c1d22);
  const steel = colorOf(0x55585e);
  const warm = new THREE.Color(1, 0.72, 0.38).multiplyScalar(2.1);
  // Deck boards and the lit middle of them.
  lbox(o.roofs, F, x0 + 0.7, x1 - 0.7, z0 + 0.7, z1 - 0.7, y, y + 0.07, wood, false);
  // The pool of light on the deck: nested squares, brighter toward the middle (the sprite halo adds the bloom).
  lbox(o.neon, F, x0 + W * 0.12, x1 - W * 0.12, z0 + D * 0.12, z1 - D * 0.12, y + 0.07, y + 0.08, new THREE.Color(0.1, 0.058, 0.025), false);
  lbox(o.neon, F, x0 + W * 0.26, x1 - W * 0.26, z0 + D * 0.26, z1 - D * 0.26, y + 0.08, y + 0.09, new THREE.Color(0.17, 0.1, 0.045), false);
  // Stair bulkhead in the back left corner with a lit door.
  const bx0 = x0 + 1.0;
  const bx1 = bx0 + 2.4;
  const bz1 = z1 - 0.9;
  const bz0 = bz1 - 2.4;
  lbox(o.roofs, F, bx0, bx1, bz0, bz1, y, y + 2.8, colorOf(0x34363c), false);
  lbox(o.neon, F, bx0 + 0.6, bx1 - 0.6, bz0 - 0.03, bz0, y + 0.1, y + 2.1, warm.clone().multiplyScalar(0.55), false);
  // Masts at the four corners of the deck.
  const mh = P.mast;
  const m = [
    { x: x0 + 0.9, z: z0 + 0.9 },
    { x: x1 - 0.9, z: z0 + 0.9 },
    { x: x1 - 0.9, z: z1 - 0.9 },
    { x: bx1 + 0.4, z: z1 - 0.9 },
  ];
  for (const p of m) strut(o.roofs, F.X(p.x, p.z), y, F.Z(p.x, p.z), F.X(p.x, p.z), y + mh, F.Z(p.x, p.z), 0.05, steel);
  const top = (p: { x: number; z: number }) => [p.x, y + mh, p.z] as const;
  const strings: [readonly [number, number, number], readonly [number, number, number]][] = [
    [top(m[0]), top(m[1])],
    [top(m[1]), top(m[2])],
    [top(m[0]), [bx0 + 0.2, y + 2.7, bz0 + 0.2]],
    [top(m[0]), top(m[2])],
    [top(m[1]), [bx1 - 0.2, y + 2.7, bz0 + 0.2]],
    [top(m[3]), top(m[2])],
  ];
  for (const [a, b] of strings) festoon(o, F, a[0], a[1], a[2], b[0], b[1], b[2], warm, dark);
  // Bunting along the front string, a little below it.
  const flag = [0xe0457b, 0xf2b632, 0x35b6c9, 0x7bd35a, 0xd96a2b].map((c) => colorOf(c, 0.8));
  const bn = Math.max(6, Math.round((W - 2) / 0.8));
  for (let k = 0; k < bn; k++) {
    const t0 = k / bn;
    const t1 = (k + 0.8) / bn;
    const xa = x0 + 0.9 + (W - 1.8) * t0;
    const xb = x0 + 0.9 + (W - 1.8) * t1;
    const ya = y + mh - Math.sin(t0 * Math.PI) * P.sag - 0.45;
    const yb = y + mh - Math.sin(t1 * Math.PI) * P.sag - 0.45;
    const zf = z0 + 0.9;
    const c = flag[(k + rng.int(0, 1)) % flag.length];
    const A: [number, number, number] = [F.X(xa, zf), ya, F.Z(xa, zf)];
    const B: [number, number, number] = [F.X(xb, zf), yb, F.Z(xb, zf)];
    const T: [number, number, number] = [F.X((xa + xb) / 2, zf), (ya + yb) / 2 - 0.4, F.Z((xa + xb) / 2, zf)];
    facet(o.neon, [A, B, T], c, [F.wx, 0, F.wz]);
    facet(o.neon, [A, B, T], c, [-F.wx, 0, -F.wz]);
  }
  // The bar: a counter facing the deck and its back shelf against the parapet, lit, with bottles.
  const barW = Math.min(4.2, W * 0.3);
  const bax1 = x1 - 1.2;
  const bax0 = bax1 - barW;
  lbox(o.roofs, F, bax0, bax1, z1 - 3.0, z1 - 2.3, y, y + 1.1, colorOf(0x3a2a20), false);
  lbox(o.roofs, F, bax0 - 0.05, bax1 + 0.05, z1 - 3.05, z1 - 2.25, y + 1.1, y + 1.16, colorOf(0x8a6a48), false);
  lbox(o.roofs, F, bax0, bax1, z1 - 1.2, z1 - 0.8, y, y + 2.2, dark, false);
  lbox(o.neon, F, bax0 + 0.1, bax1 - 0.1, z1 - 1.25, z1 - 1.2, y + 1.15, y + 1.2, warm.clone().multiplyScalar(1.1), false);
  lbox(o.neon, F, bax0 + 0.1, bax1 - 0.1, z1 - 1.25, z1 - 1.2, y + 1.7, y + 1.75, warm.clone().multiplyScalar(1.1), false);
  const bottle = [new THREE.Color(0.2, 1, 0.5), new THREE.Color(1, 0.35, 0.2), new THREE.Color(0.35, 0.6, 1), new THREE.Color(1, 0.8, 0.25)];
  for (let k = 0; k < 7; k++) {
    const bxp = bax0 + 0.25 + ((barW - 0.5) * k) / 6;
    const c = bottle[rng.int(0, bottle.length - 1)].clone().multiplyScalar(1.4);
    lbox(o.neon, F, bxp - 0.05, bxp + 0.05, z1 - 1.3, z1 - 1.22, y + 1.2, y + 1.45 + (k % 3) * 0.07, c, false);
  }
  for (let k = 0; k < 3; k++) {
    const sx = bax0 + 0.7 + k * (barW - 1.4) * 0.5;
    lbox(o.roofs, F, sx - 0.18, sx + 0.18, z1 - 3.8, z1 - 3.44, y, y + 0.7, colorOf(0x2a2b30), false);
  }
  life.sprite(F.X((bax0 + bax1) / 2, z1 - 2), y + 1.6, F.Z((bax0 + bax1) / 2, z1 - 2), 3.2, warm.clone().multiplyScalar(0.3), 0, 0, 1);
  // Speakers on either side of the front, their cones pulsing on the clock.
  const pink = new THREE.Color(1, 0.18, 0.62);
  const phase = rng.next();
  for (const sx of [x0 + 2.0, x1 - 2.0]) {
    lbox(o.roofs, F, sx - 0.32, sx + 0.32, z0 + 1.1, z0 + 1.6, y, y + 1.35, dark, false);
    lbox(o.neon, F, sx - 0.2, sx + 0.2, z0 + 1.6, z0 + 1.63, y + 0.2, y + 0.6, pink.clone().multiplyScalar(1.3), false);
    lbox(o.neon, F, sx - 0.1, sx + 0.1, z0 + 1.6, z0 + 1.63, y + 0.85, y + 1.05, pink.clone().multiplyScalar(0.9), false);
    life.sprite(F.X(sx, z0 + 1.8), y + 0.5, F.Z(sx, z0 + 1.8), P.speakerGlow, pink.clone().multiplyScalar(0.9), 1, phase, P.pulse);
  }
  // Planters along the front parapet and one by the bulkhead.
  const planters = Math.max(3, Math.floor(W / 4));
  for (let k = 0; k < planters; k++) {
    const px = x0 + 3.2 + ((W - 6.4) * (k + 0.5)) / planters + rng.range(-0.3, 0.3);
    lbox(o.roofs, F, px - 0.45, px + 0.45, z0 + 0.45, z0 + 0.95, y, y + 0.55, colorOf(0x3b2d26), false);
    lbox(o.roofs, F, px - 0.4, px + 0.4, z0 + 0.5, z0 + 0.9, y + 0.55, y + 0.85 + rng.range(0, 0.35), colorOf(0x2c5a30, rng.range(0.8, 1.2)), false);
  }
  // A parasol over a round table, left of the middle.
  const tx = cx - W * 0.12;
  const tz = cz - D * 0.04;
  strut(o.roofs, F.X(tx, tz), y, F.Z(tx, tz), F.X(tx, tz), y + 2.5, F.Z(tx, tz), 0.04, steel);
  const apex: [number, number, number] = [F.X(tx, tz), y + 3.0, F.Z(tx, tz)];
  const pr = Math.min(1.7, W * 0.12);
  const cloth = [colorOf(0xe8dcc0, 0.8), colorOf(0xb8453a, 0.8)];
  for (let k = 0; k < 8; k++) {
    const a0 = (k / 8) * Math.PI * 2;
    const a1 = ((k + 1) / 8) * Math.PI * 2;
    const A: [number, number, number] = [F.X(tx + Math.cos(a0) * pr, tz + Math.sin(a0) * pr), y + 2.4, F.Z(tx + Math.cos(a0) * pr, tz + Math.sin(a0) * pr)];
    const B: [number, number, number] = [F.X(tx + Math.cos(a1) * pr, tz + Math.sin(a1) * pr), y + 2.4, F.Z(tx + Math.cos(a1) * pr, tz + Math.sin(a1) * pr)];
    facet(o.roofs, [A, B, apex], cloth[k % 2], [0, 1, 0]);
  }
  strut(o.roofs, F.X(tx, tz), y + 0.72, F.Z(tx, tz), F.X(tx, tz), y + 0.78, F.Z(tx, tz), 0.55, colorOf(0x5a4632));
  strut(o.roofs, F.X(tx, tz), y, F.Z(tx, tz), F.X(tx, tz), y + 0.72, F.Z(tx, tz), 0.06, steel);
  // The glow over the deck, seen from the highway and the hills, and a dim one from the street.
  const long = Math.max(W, D);
  life.parties.push({ x: F.X(cx, cz), y, z: F.Z(cx, cz) });
  life.sprite(F.X(cx, cz), y + 2.0, F.Z(cx, cz), long * P.haloShare, warm.clone().multiplyScalar(P.haloStrength), 0, 0, 1);
  return true;
}

/**
 * The roof of a building that takes life (a pad or a party) in local x0..x1, z0..z1 at height y. Returns true when
 * it drew the roof's clutter itself, so the caller skips its own AC units, water towers and billboards.
 */
export function roofLifeFor(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number): boolean {
  const life = o.life;
  if (life.role === 'pad') {
    helipad(o, F, x0, x1, z0, z1, y);
    return true;
  }
  if (life.role === 'party') return party(o, F, x0, x1, z0, z1, y);
  return false;
}
