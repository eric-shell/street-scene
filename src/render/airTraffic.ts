/**
 * Air traffic over the city, render only and a pure function of the scene
 * clock and the seed, so a race and its replay show the same sky:
 *  - a news helicopter flying a seeded loop that dips low over the route a
 *    few times a lap and roams the blocks in between, rotors spinning, nav
 *    lights blinking, with a searchlight that sweeps the course ahead of it
 *    (a soft additive cone and a pool of light on the road), plus a rotor
 *    thump near the camera (audio/sfx.ts HeliRotor);
 *  - a blimp drifting round downtown with an LED band scrolling event and
 *    sponsor words along both flanks;
 *  - a police helicopter (black and white, red and blue light bar) that
 *    patrols high and, on the last lap, comes in low to chase the leader with
 *    a strong white searchlight (policeChase.ts says when and whom; the
 *    follow is integrated with frame time, see buildPoliceHeli);
 * (airliners and meteors are sky sprites in backdrop.ts). Five draw calls:
 * the two helicopters, their searchlights, the blimp. The bodies share one
 * lit material whose shader spins the rotor blades and lights the lamps, the
 * light bar and the LED band from the clock, so nothing is moved per frame
 * but a few matrices.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import { routeSample } from '../city/route';
import { Rng, deriveSeed } from '../sim/prng';
import type { Quality } from '../ui/settings';
import { HeliRotor } from '../audio/sfx';
import { GeoBuilder } from './geoBuilder';
import { makeLedTextTexture } from './skyTextures';
import { makeRadialGlow } from './textures';
import { ChaseTarget, POLICE, policeWaypoints } from './policeChase';

export const AIR = {
  heli: {
    /** Cruise speed (m/s), altitude bands (m) for the passes over the route and the roaming legs. */
    speed: 27,
    lowAlt: [58, 82] as [number, number],
    highAlt: [95, 135] as [number, number],
    routePasses: 3,
    roamPoints: 4,
    /** Main rotor turns per second (the tail rotor spins four times faster). */
    rotorRps: 5.5,
    /** Searchlight: pool radius on the road (m), how far ahead on the course it aims (m), sweep (m), furthest reach (m). */
    beamRadius: 9,
    ahead: 55,
    sweep: 16,
    reach: 170,
  },
  blimp: {
    /** Circle round a point near downtown: radius (m), altitude band (m), speed (m/s), envelope size (m). */
    radius: 330,
    altitude: [170, 205] as [number, number],
    speed: 4.2,
    length: 46,
    girth: 13,
    /** LED text scroll speed (texture widths per second). */
    scroll: 0.045,
  },
  /** Words on the blimp's band; the first is the event. */
  words: ['STREET SCENE', 'NIGHT RACE TONIGHT', 'DRIFT CLUB', 'APEX GARAGE', 'VOLT MOTORS', 'ZERO AUTO', 'STARLITE', 'TURBO TACO', 'HYPER MART', 'MIDNIGHT TUNE'],
  /** Rotor sound: silent beyond `hear` m, full within `near` m. */
  sound: { hear: 330, near: 55 },
} as const;

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A closed loop sampled at even arc length. */
export interface Loop {
  /** xyz triples. */
  pts: Float32Array;
  length: number;
  samples: number;
}

/** Catmull-Rom through `points` (closed), resampled to `samples` points at even spacing. */
export function buildLoop(points: P3[], samples = 512): Loop {
  const n = points.length;
  const p = (i: number) => points[((i % n) + n) % n];
  const at = (u: number, out: P3): P3 => {
    const i = Math.floor(u);
    const t = u - i;
    const a = p(i - 1);
    const b = p(i);
    const c = p(i + 1);
    const d = p(i + 2);
    const t2 = t * t;
    const t3 = t2 * t;
    const w0 = -0.5 * t3 + t2 - 0.5 * t;
    const w1 = 1.5 * t3 - 2.5 * t2 + 1;
    const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const w3 = 0.5 * t3 - 0.5 * t2;
    out.x = a.x * w0 + b.x * w1 + c.x * w2 + d.x * w3;
    out.y = a.y * w0 + b.y * w1 + c.y * w2 + d.y * w3;
    out.z = a.z * w0 + b.z * w1 + c.z * w2 + d.z * w3;
    return out;
  };
  // Dense parametric samples, then pick points at even arc length.
  const dense = n * 64;
  const dx: number[] = [];
  const cum: number[] = [0];
  const cur = { x: 0, y: 0, z: 0 };
  let prev = at(0, { x: 0, y: 0, z: 0 });
  dx.push(prev.x, prev.y, prev.z);
  for (let k = 1; k <= dense; k++) {
    at((k / dense) * n, cur);
    cum.push(cum[k - 1] + Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z));
    dx.push(cur.x, cur.y, cur.z);
    prev = { ...cur };
  }
  const length = cum[dense];
  const pts = new Float32Array(samples * 3);
  let j = 0;
  for (let i = 0; i < samples; i++) {
    const s = (i / samples) * length;
    while (j + 1 < dense && cum[j + 1] < s) j++;
    const t = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    pts[i * 3] = dx[j * 3] + (dx[(j + 1) * 3] - dx[j * 3]) * t;
    pts[i * 3 + 1] = dx[j * 3 + 1] + (dx[(j + 1) * 3 + 1] - dx[j * 3 + 1]) * t;
    pts[i * 3 + 2] = dx[j * 3 + 2] + (dx[(j + 1) * 3 + 2] - dx[j * 3 + 2]) * t;
  }
  return { pts, length, samples };
}

/** Point on the loop at arc length s (wrapping), and the unit tangent. */
export function loopAt(loop: Loop, s: number, out: P3, tangent?: P3): P3 {
  const L = loop.length;
  const u = (((s % L) + L) % L) / L;
  const f = u * loop.samples;
  const i = Math.floor(f) % loop.samples;
  const k = (i + 1) % loop.samples;
  const t = f - Math.floor(f);
  const P = loop.pts;
  out.x = P[i * 3] + (P[k * 3] - P[i * 3]) * t;
  out.y = P[i * 3 + 1] + (P[k * 3 + 1] - P[i * 3 + 1]) * t;
  out.z = P[i * 3 + 2] + (P[k * 3 + 2] - P[i * 3 + 2]) * t;
  if (tangent) {
    const tx = P[k * 3] - P[i * 3];
    const ty = P[k * 3 + 1] - P[i * 3 + 1];
    const tz = P[k * 3 + 2] - P[i * 3 + 2];
    const l = Math.hypot(tx, ty, tz) || 1;
    tangent.x = tx / l;
    tangent.y = ty / l;
    tangent.z = tz / l;
  }
  return out;
}

/**
 * The helicopter's loop: passes over the route (low, at seeded points along
 * it) alternating with roaming points over the blocks (higher), so it keeps
 * coming back over the race.
 */
export function heliWaypoints(world: World, seed: number): P3[] {
  const rng = new Rng(deriveSeed(seed, 'heli'));
  const route = world.route;
  const b = world.graph.bounds;
  const h = AIR.heli;
  const out: P3[] = [];
  for (let k = 0; k < h.routePasses; k++) {
    const s = ((k + rng.range(0.15, 0.85)) / h.routePasses) * route.length;
    const p = routeSample(route, s);
    out.push({ x: p.x, y: world.heightAt(p.x, p.z) + rng.range(h.lowAlt[0], h.lowAlt[1]), z: p.z });
    if (k < h.roamPoints) {
      const x = rng.range(b.minX + 80, b.maxX - 80);
      const z = rng.range(b.minZ + 80, b.maxZ - 80);
      out.push({ x, y: world.heightAt(x, z) + rng.range(h.highAlt[0], h.highAlt[1]), z });
    }
  }
  for (let k = h.routePasses; k < h.roamPoints; k++) {
    const x = rng.range(b.minX + 80, b.maxX - 80);
    const z = rng.range(b.minZ + 80, b.maxZ - 80);
    out.push({ x, y: world.heightAt(x, z) + rng.range(h.highAlt[0], h.highAlt[1]), z });
  }
  return out;
}

export interface HeliPose {
  pos: P3;
  fwd: P3;
  /** Bank (rad, positive = right wing down) from the turn rate. */
  bank: number;
}

const scratchAhead: P3 = { x: 0, y: 0, z: 0 };
const scratchTangent: P3 = { x: 0, y: 0, z: 0 };

/** Where the helicopter is at `time` (s): a pure function of the loop and the clock (and its cruise speed, m/s). */
export function heliPoseAt(loop: Loop, time: number, out: HeliPose, speed: number = AIR.heli.speed): HeliPose {
  const s = time * speed;
  loopAt(loop, s, out.pos, out.fwd);
  // Bank into the turn: compare the heading a little ahead.
  const t2 = scratchTangent;
  loopAt(loop, s + 12, scratchAhead, t2);
  const cross = out.fwd.x * t2.z - out.fwd.z * t2.x;
  out.bank = Math.max(-0.45, Math.min(0.45, cross * 6));
  return out;
}

export interface BlimpParams {
  cx: number;
  cz: number;
  dir: 1 | -1;
  phase: number;
}

export function blimpParams(world: World, seed: number): BlimpParams {
  const rng = new Rng(deriveSeed(seed, 'blimp'));
  const b = world.graph.bounds;
  return {
    cx: (b.minX + b.maxX) / 2 + rng.range(-180, 180),
    cz: (b.minZ + b.maxZ) / 2 + rng.range(-180, 180),
    dir: rng.chance(0.5) ? 1 : -1,
    phase: rng.range(0, Math.PI * 2),
  };
}

/** Where the blimp is at `time` (s) and which way it points. */
export function blimpPoseAt(p: BlimpParams, time: number, out: { pos: P3; yaw: number }): void {
  const w = (AIR.blimp.speed / AIR.blimp.radius) * p.dir;
  const a = p.phase + w * time;
  out.pos.x = p.cx + Math.cos(a) * AIR.blimp.radius;
  out.pos.z = p.cz + Math.sin(a) * AIR.blimp.radius;
  const [a0, a1] = AIR.blimp.altitude;
  out.pos.y = (a0 + a1) / 2 + ((a1 - a0) / 2) * Math.sin(time * 0.045 + p.phase);
  // Nose along the tangent of travel (yaw: forward is (sin yaw, cos yaw)).
  const tx = -Math.sin(a) * p.dir;
  const tz = Math.cos(a) * p.dir;
  out.yaw = Math.atan2(tx, tz);
}

/**
 * Lamp kinds baked into the body geometry (attribute aGlow), lit by the shader from the clock;
 * the police light bar (buildPoliceHeli) flashes red and blue while uPolice is up.
 */
const GLOW = { none: 0, steady: 1, navRed: 2, navGreen: 3, strobe: 4, beacon: 5, led: 6, cabin: 7, policeRed: 8, policeBlue: 9 } as const;
/** Moving parts (attribute aPart). */
const PART = { body: 0, rotor: 1, tailRotor: 2 } as const;

/** Builder with the extra per vertex attributes the air body material reads. */
class AirBuilder {
  readonly gb = new GeoBuilder(true);
  readonly glow: number[] = [];
  readonly part: number[] = [];
  readonly uv2: number[] = [];
  private color = new THREE.Color();

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: number, glow: number = GLOW.none, part: number = PART.body): void {
    const c = this.color.setHex(color);
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const face = (a: number[], b: number[], d: number[], e: number[], n: number[]) => {
      const v = (q: number[]) => {
        this.glow.push(glow);
        this.part.push(part);
        this.uv2.push(0, 0);
        return this.gb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], 0, 0, c);
      };
      this.gb.quadFacing(v(a), v(b), v(d), v(e), n[0], n[1], n[2]);
    };
    face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
    face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
    face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
    face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
    face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  }

  /** A quad with its own UVs (the LED band). */
  quad(a: number[], b: number[], d: number[], e: number[], n: number[], color: number, glow: number, u0: number, u1: number): void {
    const c = this.color.setHex(color);
    const v = (q: number[], u: number, w: number) => {
      this.glow.push(glow);
      this.part.push(PART.body);
      this.uv2.push(u, w);
      return this.gb.vertex(q[0], q[1], q[2], n[0], n[1], n[2], 0, 0, c);
    };
    this.gb.quadFacing(v(a, u0, 0), v(b, u1, 0), v(d, u1, 1), v(e, u0, 1), n[0], n[1], n[2]);
  }

  build(): THREE.BufferGeometry {
    const geo = this.gb.build();
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    geo.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    geo.setAttribute('aUv2', new THREE.Float32BufferAttribute(this.uv2, 2));
    return geo;
  }
}

/** Rotor hubs in body space: both helicopters put their rotors here (the shader spins about them). */
const HELI_HUB = new THREE.Vector3(0, 1.95, -0.2);
const HELI_TAIL_HUB = new THREE.Vector3(0.42, 1.05, -6.45);

function heliGeometry(): THREE.BufferGeometry {
  const b = new AirBuilder();
  const paint = 0x2a3a58;
  const dark = 0x10131c;
  const stripe = 0xc8cad2;
  b.box(0, 0, 0.4, 2.0, 1.5, 4.4, paint);
  b.box(0, -0.15, 2.9, 1.5, 1.1, 1.4, paint);
  b.box(0, 0.45, 2.7, 1.3, 0.5, 1.3, 0x3a5a7a, GLOW.cabin);
  b.box(0, 0.82, 0.1, 2.04, 0.12, 3.0, stripe);
  b.box(0, 1.05, -0.2, 1.4, 0.55, 2.2, dark);
  b.box(0, 1.55, -0.2, 0.3, 0.5, 0.3, dark);
  b.box(0, 0.45, -4.0, 0.55, 0.55, 4.6, paint);
  b.box(0, 1.25, -6.4, 0.18, 1.5, 1.1, paint);
  b.box(0, 0.7, -5.6, 1.9, 0.12, 0.6, paint);
  for (const sx of [-1, 1]) {
    b.box(sx * 1.0, -1.2, 0.3, 0.12, 0.12, 3.8, dark);
    b.box(sx * 0.85, -0.85, 1.3, 0.1, 0.6, 0.1, dark);
    b.box(sx * 0.85, -0.85, -0.7, 0.1, 0.6, 0.1, dark);
  }
  // Main rotor: two blades through the hub, spun by the shader.
  for (const [sx, sz] of [
    [11.2, 0.3],
    [0.3, 11.2],
  ])
    b.box(HELI_HUB.x, HELI_HUB.y, HELI_HUB.z, sx, 0.06, sz, dark, GLOW.none, PART.rotor);
  // Tail rotor on the right of the fin, spun about x.
  b.box(HELI_TAIL_HUB.x, HELI_TAIL_HUB.y, HELI_TAIL_HUB.z, 0.06, 1.8, 0.24, dark, GLOW.none, PART.tailRotor);
  b.box(HELI_TAIL_HUB.x, HELI_TAIL_HUB.y, HELI_TAIL_HUB.z, 0.06, 0.24, 1.8, dark, GLOW.none, PART.tailRotor);
  // Lamps: red left, green right, white strobe on the tail, red beacon on the belly.
  b.box(-1.08, 0.2, 0.6, 0.16, 0.16, 0.24, 0xff1a10, GLOW.navRed);
  b.box(1.08, 0.2, 0.6, 0.16, 0.16, 0.24, 0x1aff40, GLOW.navGreen);
  b.box(0, 2.05, -6.4, 0.16, 0.16, 0.16, 0xffffff, GLOW.strobe);
  b.box(0, -0.8, 0.2, 0.2, 0.12, 0.2, 0xff2010, GLOW.beacon);
  // A steady belly lamp, so the body reads against the sky between the strobes.
  b.box(0, -0.82, 1.6, 0.5, 0.1, 0.3, 0xfff0d0, GLOW.steady);
  return b.build();
}

function blimpGeometry(): THREE.BufferGeometry {
  const b = new AirBuilder();
  const L = AIR.blimp.length;
  const G = AIR.blimp.girth;
  const rings = 12;
  const segs = 16;
  const skin = 0xa0a6b4;
  // Envelope: a lathe along z, radius a stretched sine so the nose is blunter than the tail.
  const radius = (u: number) => (G / 2) * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, u))), 0.62) * (1 - 0.12 * u);
  const ring = (i: number) => {
    const u = i / rings;
    const z = -L / 2 + L * u;
    const r = radius(u);
    return { z, r };
  };
  const c = new THREE.Color(skin);
  const ids: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const { z, r } = ring(i);
    const row: number[] = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      b.glow.push(GLOW.none);
      b.part.push(PART.body);
      b.uv2.push(0, 0);
      row.push(b.gb.vertex(nx * r, ny * r, z, nx, ny, 0, 0, 0, c));
    }
    ids.push(row);
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < segs; k++) {
      const k2 = (k + 1) % segs;
      b.gb.quad(ids[i][k], ids[i][k2], ids[i + 1][k2], ids[i + 1][k]);
    }
  }
  // Fins, gondola, engine pods.
  b.box(0, 0, -L * 0.36, 0.3, G * 0.95, L * 0.16, skin);
  b.box(0, 0, -L * 0.36, G * 0.95, 0.3, L * 0.16, skin);
  b.box(0, -G / 2 - 0.9, L * 0.06, 2.4, 2.0, 7.5, 0x3a3d48);
  b.box(0, -G / 2 - 1.0, L * 0.06, 2.46, 0.9, 6.5, 0xffd9a0, GLOW.cabin);
  for (const sx of [-1, 1]) b.box(sx * 2.4, -G / 2 - 0.4, -L * 0.02, 1.0, 1.0, 1.8, 0x22242c);
  // LED band on both flanks, following the envelope, just below the equator.
  const bandSegs = 14;
  const u0 = 0.18;
  const u1 = 0.78;
  for (const side of [-1, 1]) {
    for (let i = 0; i < bandSegs; i++) {
      const ua = u0 + ((u1 - u0) * i) / bandSegs;
      const ub = u0 + ((u1 - u0) * (i + 1)) / bandSegs;
      const pa = ring(ua * rings);
      const pb = ring(ub * rings);
      const phiTop = Math.PI * 0.47;
      const phiBot = Math.PI * 0.62;
      const at = (r: number, z: number, phi: number) => [side * r * Math.sin(phi) * 1.004, r * Math.cos(phi) * 1.004, z];
      const n = [side, 0, 0];
      // Text runs nose to tail on both sides, so one side's u runs the other way.
      const ta = side > 0 ? i / bandSegs : 1 - i / bandSegs;
      const tb = side > 0 ? (i + 1) / bandSegs : 1 - (i + 1) / bandSegs;
      const A = at(pa.r, pa.z, phiBot);
      const B = at(pb.r, pb.z, phiBot);
      const C = at(pb.r, pb.z, phiTop);
      const D = at(pa.r, pa.z, phiTop);
      if (side > 0) b.quad(A, B, C, D, n, 0x000000, GLOW.led, ta, tb);
      else b.quad(B, A, D, C, n, 0x000000, GLOW.led, tb, ta);
    }
  }
  b.box(0, G / 2 + 0.2, 0, 0.3, 0.3, 0.3, 0xff2010, GLOW.beacon);
  b.box(0, -G / 2 - 2.0, L * 0.06, 0.3, 0.3, 0.3, 0xff2010, GLOW.beacon);
  b.box(0, 0, -L / 2 - 0.1, 0.3, 0.3, 0.3, 0xffffff, GLOW.strobe);
  return b.build();
}

/** One lit material for both bodies: rotor spin, lamp blink patterns and the LED band from the clock. */
function airMaterial(led: THREE.Texture): { material: THREE.MeshStandardMaterial; uniforms: Record<string, THREE.IUniform> } {
  const uniforms = {
    uTime: { value: 0 },
    uRotor: { value: 0 },
    uHub: { value: HELI_HUB },
    uTailHub: { value: HELI_TAIL_HUB },
    uLed: { value: led },
    uScroll: { value: AIR.blimp.scroll },
    /** Police light bar 0..1 (off on patrol), and 1 for a soft alternating glow instead of strobes (flash effects off). */
    uPolice: { value: 0 },
    uPoliceSoft: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.3, envMapIntensity: 0.6 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aGlow;
        attribute float aPart;
        attribute vec2 aUv2;
        uniform float uRotor;
        uniform vec3 uHub;
        uniform vec3 uTailHub;
        varying float vGlow;
        varying vec2 vUv2;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGlow = aGlow;
        vUv2 = aUv2;
        if (aPart > 0.5 && aPart < 1.5) {
          vec3 d = transformed - uHub;
          float c = cos(uRotor), s = sin(uRotor);
          transformed = uHub + vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
        } else if (aPart > 1.5) {
          vec3 d = transformed - uTailHub;
          float c = cos(uRotor * 4.0), s = sin(uRotor * 4.0);
          transformed = uTailHub + vec3(d.x, c * d.y - s * d.z, s * d.y + c * d.z);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform sampler2D uLed;
        uniform float uScroll;
        uniform float uPolice;
        uniform float uPoliceSoft;
        varying float vGlow;
        varying vec2 vUv2;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float g = vGlow;
          vec3 em = vec3(0.0);
          // Lamps are a few centimetres across: fade them by pixel coverage so they never shimmer.
          float pxWorld = max(length(fwidth(vViewPosition)), 1e-5);
          float cover = clamp(0.2 / (2.0 * pxWorld), 0.3, 1.0);
          if (g > 0.5 && g < 1.5) em = vColor.rgb * 1.5 * cover;
          else if (g > 1.5 && g < 3.5) em = vColor.rgb * 3.0 * cover;
          else if (g > 3.5 && g < 4.5) {
            float ph = fract(uTime / 1.2);
            em = vColor.rgb * ((ph < 0.05 || (ph > 0.11 && ph < 0.16)) ? 7.0 : 0.0) * cover;
          } else if (g > 4.5 && g < 5.5) em = vColor.rgb * (fract(uTime / 1.3) < 0.2 ? 5.0 : 0.15) * cover;
          else if (g > 5.5 && g < 6.5) em = texture2D(uLed, vec2(vUv2.x + uTime * uScroll, vUv2.y)).rgb * 3.2;
          else if (g > 6.5 && g < 7.5) em = vColor.rgb * 0.45;
          else if (g > 7.5) {
            // Light bar: red double flash, then blue, on a 0.8 s cycle (or a slow soft swap).
            float ph = fract(uTime / 0.8 + (g > 8.5 ? 0.5 : 0.0));
            float strobe = (ph < 0.07 || (ph > 0.13 && ph < 0.2)) ? 1.0 : 0.04;
            float soft = 0.5 + 0.5 * sin(uTime * 3.9 + (g > 8.5 ? 3.14159 : 0.0));
            em = vColor.rgb * mix(strobe * 6.0, soft * 2.2, uPoliceSoft) * uPolice * cover;
          }
          totalEmissiveRadiance += em;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'airbody';
  return { material, uniforms };
}

/** Segments round the searchlight cone and spot, and the index count of the cone part of beamGeometry(). */
const BEAM_SEGS = 28;
const CONE_INDICES = BEAM_SEGS * 6;

/** The searchlight material: an additive cone and ground pool between uApex and uTarget, faded by fog. */
function beamMaterial(opts: { radius: number; spotR: number; color: THREE.Color; intensity: number; fogDensity: number; glow: THREE.Texture }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    uniforms: {
      uApex: { value: new THREE.Vector3() },
      uTarget: { value: new THREE.Vector3() },
      uRadius: { value: opts.radius },
      uSpotR: { value: opts.spotR },
      uGlow: { value: opts.glow },
      uColor: { value: opts.color },
      uIntensity: { value: opts.intensity },
      uFogDensity: { value: opts.fogDensity },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

const beamVert = /* glsl */ `
  attribute vec2 aRing;
  attribute float aT;
  attribute float aPart;
  uniform vec3 uApex;
  uniform vec3 uTarget;
  uniform float uRadius;
  uniform float uSpotR;
  varying vec2 vUv;
  varying float vT;
  varying float vPart;
  varying float vEdge;
  varying float vDist;
  void main() {
    vec3 beam = uTarget - uApex;
    vec3 b = normalize(beam);
    vec3 up = abs(b.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(b, up));
    vec3 up2 = cross(right, b);
    vec3 pos;
    vec3 n;
    if (aPart < 0.5) {
      vec3 ring = right * aRing.x + up2 * aRing.y;
      pos = mix(uApex, uTarget + ring * uRadius, aT);
      n = ring;
    } else {
      pos = uTarget + vec3(aRing.x, 0.0, aRing.y) * uSpotR * aT + vec3(0.0, 0.12, 0.0);
      n = vec3(0.0, 1.0, 0.0);
    }
    vec3 toCam = normalize(cameraPosition - pos);
    // The cone reads thicker at its silhouette, where the eye looks through more of it.
    vEdge = 1.0 - abs(dot(n, toCam));
    vUv = aRing * 0.5 * aT + 0.5;
    vT = aT;
    vPart = aPart;
    vec4 mv = viewMatrix * vec4(pos, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const beamFrag = /* glsl */ `
  uniform sampler2D uGlow;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFogDensity;
  varying vec2 vUv;
  varying float vT;
  varying float vPart;
  varying float vEdge;
  varying float vDist;
  void main() {
    float fog = exp(-uFogDensity * uFogDensity * vDist * vDist);
    float a;
    if (vPart < 0.5) {
      // Thickest through the middle of the beam, fading out to a soft silhouette.
      float along = smoothstep(0.0, 0.08, vT) * (0.04 + 0.96 * pow(1.0 - vT, 1.6));
      float body = pow(max(0.0, 1.0 - vEdge), 1.4);
      a = along * body * 0.16;
    } else {
      a = texture2D(uGlow, vUv).r * 1.6;
    }
    gl_FragColor = vec4(uColor * a * uIntensity * fog, 1.0);
  }
`;

/** Searchlight cone and ground spot as one mesh; the cone is the first CONE_INDICES indices (a pool only mesh draws the rest). */
function beamGeometry(): THREE.BufferGeometry {
  const segs = BEAM_SEGS;
  const ring: number[] = [];
  const t: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  // Cone: apex ring (collapsed) and base ring.
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      ring.push(Math.cos(a), Math.sin(a));
      t.push(r);
      part.push(0);
    }
  }
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % segs;
    idx.push(k, segs + k, segs + k2, k, segs + k2, k2);
  }
  // Spot: a fan on the ground.
  const base = ring.length / 2;
  ring.push(0, 0);
  t.push(0);
  part.push(1);
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    ring.push(Math.cos(a), Math.sin(a));
    t.push(1);
    part.push(1);
  }
  for (let k = 0; k < segs; k++) idx.push(base, base + 1 + k, base + 1 + ((k + 1) % segs));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(part.length * 3), 3));
  geo.setAttribute('aRing', new THREE.Float32BufferAttribute(ring, 2));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geo.setIndex(idx);
  return geo;
}

/** The police livery on the shared helicopter shape: black body, white doors and boom band, light bar, searchlight pod. */
function policeGeometry(): THREE.BufferGeometry {
  const b = new AirBuilder();
  const paint = 0x111318;
  const white = 0xe4e6ec;
  const dark = 0x0a0b10;
  b.box(0, 0, 0.4, 2.0, 1.5, 4.4, paint);
  // White doors on both flanks and a white nose band.
  for (const sx of [-1, 1]) b.box(sx * 1.01, -0.05, 0.6, 0.04, 1.0, 2.2, white);
  b.box(0, -0.15, 2.9, 1.5, 1.1, 1.4, paint);
  b.box(0, -0.2, 3.25, 1.52, 0.35, 0.6, white);
  b.box(0, 0.45, 2.7, 1.3, 0.5, 1.3, 0x2a3a52, GLOW.cabin);
  b.box(0, 1.05, -0.2, 1.4, 0.55, 2.2, dark);
  b.box(0, 1.55, -0.2, 0.3, 0.5, 0.3, dark);
  b.box(0, 0.45, -4.0, 0.55, 0.55, 4.6, paint);
  b.box(0, 0.45, -3.2, 0.57, 0.57, 1.2, white);
  b.box(0, 1.25, -6.4, 0.18, 1.5, 1.1, paint);
  b.box(0, 0.7, -5.6, 1.9, 0.12, 0.6, white);
  for (const sx of [-1, 1]) {
    b.box(sx * 1.0, -1.2, 0.3, 0.12, 0.12, 3.8, dark);
    b.box(sx * 0.85, -0.85, 1.3, 0.1, 0.6, 0.1, dark);
    b.box(sx * 0.85, -0.85, -0.7, 0.1, 0.6, 0.1, dark);
  }
  for (const [sx, sz] of [
    [11.2, 0.3],
    [0.3, 11.2],
  ])
    b.box(HELI_HUB.x, HELI_HUB.y, HELI_HUB.z, sx, 0.06, sz, dark, GLOW.none, PART.rotor);
  b.box(HELI_TAIL_HUB.x, HELI_TAIL_HUB.y, HELI_TAIL_HUB.z, 0.06, 1.8, 0.24, dark, GLOW.none, PART.tailRotor);
  b.box(HELI_TAIL_HUB.x, HELI_TAIL_HUB.y, HELI_TAIL_HUB.z, 0.06, 0.24, 1.8, dark, GLOW.none, PART.tailRotor);
  // Light bar across the top of the cabin and a pair low on the tail boom: red one side, blue the other.
  b.box(0.5, 0.82, 1.2, 0.7, 0.14, 0.22, 0xff2030, GLOW.policeRed);
  b.box(-0.5, 0.82, 1.2, 0.7, 0.14, 0.22, 0x2050ff, GLOW.policeBlue);
  b.box(0.3, 0.1, -5.0, 0.12, 0.14, 0.3, 0xff2030, GLOW.policeRed);
  b.box(-0.3, 0.1, -5.0, 0.12, 0.14, 0.3, 0x2050ff, GLOW.policeBlue);
  // Nav lights, tail strobe, belly beacon, and the searchlight pod under the nose with its lens.
  b.box(-1.08, 0.2, 0.6, 0.16, 0.16, 0.24, 0xff1a10, GLOW.navRed);
  b.box(1.08, 0.2, 0.6, 0.16, 0.16, 0.24, 0x1aff40, GLOW.navGreen);
  b.box(0, 2.05, -6.4, 0.16, 0.16, 0.16, 0xffffff, GLOW.strobe);
  b.box(0, -0.8, 0.2, 0.2, 0.12, 0.2, 0xff2010, GLOW.beacon);
  b.box(0.75, -0.9, 2.4, 0.5, 0.45, 0.6, dark);
  b.box(0.75, -1.0, 2.72, 0.36, 0.3, 0.06, 0xf4f6ff, GLOW.steady);
  return b.build();
}

/** The police helicopter and its searchlight (policeChase.ts has its brief). */
export interface PoliceHeli {
  mesh: THREE.Mesh;
  beam: THREE.Mesh;
  /** The leader to follow this frame (null: patrol or leave). */
  chase(target: ChaseTarget | null): void;
  /** Per frame with the scene clock (s): the follow, the pose, the lights and the beam. */
  update(time: number): void;
  /** Per render: the rotor sound follows the camera. */
  view(camera: THREE.Camera): void;
  position(): [number, number, number];
  dispose(): void;
}

/**
 * The police helicopter. On patrol it flies its seeded loop (a pure function
 * of the scene clock), lights off. Handed a leader, it peels off the loop
 * where it is and flies a critically damped follow toward a station behind
 * and beside the leader, acceleration and speed capped, integrated in 60 Hz
 * substeps of the frame time (the same at 30, 60 and 120 fps): it eases in,
 * trails with lag and banks into the acceleration across its nose, light bar
 * flashing; the searchlight cone and pool lock onto the leader once in reach.
 * Handed null again it flies the same follow back onto its loop and rejoins
 * it. Low quality draws only the searchlight's ground pool. No real light: a
 * SpotLight would add a light to every lit shader in the city (and recompile
 * them all when it appears) for a pool the additive spot already fakes. Per
 * frame: one loop lookup, a few spring substeps, two matrices, no allocation.
 */
/**
 * The lowest the police helicopter may fly at a point (m): over the tallest
 * roof (spires and crowns allowed for) within a cell of it, plus clearance.
 * A coarse max raster of the buildings, made once per scene.
 */
function roofline(world: World): (x: number, z: number) => number {
  const P = POLICE;
  const cell = P.roofCell;
  const b = world.graph.bounds;
  const pad = 200;
  const x0 = b.minX - pad;
  const z0 = b.minZ - pad;
  const cols = Math.ceil((b.maxX + pad - x0) / cell);
  const rows = Math.ceil((b.maxZ + pad - z0) / cell);
  const top = new Float32Array(cols * rows).fill(-1e9);
  for (const bd of world.blocks.buildings) {
    const r = Math.hypot(bd.w, bd.d) / 2;
    const roof = bd.baseY + bd.h * P.roofSpire + P.roofClear;
    const i0 = Math.max(0, Math.floor((bd.x - r - x0) / cell));
    const i1 = Math.min(cols - 1, Math.floor((bd.x + r - x0) / cell));
    const j0 = Math.max(0, Math.floor((bd.z - r - z0) / cell));
    const j1 = Math.min(rows - 1, Math.floor((bd.z + r - z0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) top[j * cols + i] = Math.max(top[j * cols + i], roof);
  }
  return (x, z) => {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((z - z0) / cell);
    let h = -1e9;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= rows) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii >= 0 && ii < cols) h = Math.max(h, top[jj * cols + ii]);
      }
    }
    return h;
  };
}

export function buildPoliceHeli(
  world: World,
  opts: { quality: Quality; fogDensity: number; material: THREE.Material; uniforms: Record<string, THREE.IUniform>; glow: THREE.Texture; flashes?: () => boolean },
): PoliceHeli {
  const P = POLICE;
  const geo = policeGeometry();
  const mesh = new THREE.Mesh(geo, opts.material);
  mesh.name = 'policeHelicopter';
  const beamMat = beamMaterial({ radius: P.beamRadius, spotR: P.spotR, color: new THREE.Color(0.92, 0.96, 1.0), intensity: 0, fogDensity: opts.fogDensity, glow: opts.glow });
  const beamGeo = beamGeometry();
  // Low: only the pool on the ground (the cone is a big transparent overdraw when the camera is under it).
  if (opts.quality === 'low') beamGeo.setDrawRange(CONE_INDICES, Infinity);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = 'policeSearchlight';
  beam.frustumCulled = false;
  beam.renderOrder = 3;
  beam.visible = false;
  const apex = beamMat.uniforms.uApex.value as THREE.Vector3;
  const aim = beamMat.uniforms.uTarget.value as THREE.Vector3;

  const loop: Loop = buildLoop(policeWaypoints(world, world.seed));
  const floorAt = roofline(world);
  const side = new Rng(deriveSeed(world.seed, 'policeSide')).chance(0.5) ? 1 : -1;
  const loopPose: HeliPose = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 1 }, bank: 0 };
  // Follow state (engaged: off the loop, flying the spring), the leader, the smoothed attitude and lights.
  let engaged = false;
  const pos = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const want = new THREE.Vector3();
  const wantV = new THREE.Vector3();
  const dv = new THREE.Vector3();
  let target: ChaseTarget | null = null;
  let dirX = 0;
  let dirZ = 1;
  let yaw = 0;
  let bank = 0;
  let pitch = 0;
  let lights = 0;
  let beamOn = 0;
  let aimed = false;
  let last = -1;
  const e = new THREE.Euler();

  const step = (h: number): void => {
    const w = P.omega;
    acc.copy(want).sub(pos).multiplyScalar(w * w);
    acc.addScaledVector(dv.copy(wantV).sub(vel), 2 * w);
    // Height on its own stiffer spring and cap, so a hard turn never starves a climb over a roof.
    const wy = P.omegaY;
    acc.y = Math.max(-P.climb, Math.min(P.climb, wy * wy * (want.y - pos.y) + 2 * wy * (wantV.y - vel.y)));
    const a = Math.hypot(acc.x, acc.z);
    if (a > P.accel) {
      acc.x *= P.accel / a;
      acc.z *= P.accel / a;
    }
    vel.addScaledVector(acc, h);
    const v = vel.length();
    if (v > P.vMax) vel.multiplyScalar(P.vMax / v);
    pos.addScaledVector(vel, h);
  };

  const update = (time: number): void => {
    const dt = last < 0 ? 0 : Math.max(0, Math.min(0.1, time - last));
    last = time;
    heliPoseAt(loop, time, loopPose, P.patrolSpeed);
    const lp = loopPose.pos;
    const lf = loopPose.fwd;
    if (target && !engaged) {
      // Peel off the loop where the helicopter is, at its loop velocity.
      engaged = true;
      pos.set(lp.x, lp.y, lp.z);
      vel.set(lf.x, lf.y, lf.z).multiplyScalar(P.patrolSpeed);
      yaw = Math.atan2(lf.x, lf.z);
    }
    acc.set(0, 0, 0);
    if (engaged) {
      if (target) {
        const sp = Math.hypot(target.vx, target.vz);
        if (sp > 2) {
          dirX = target.vx / sp;
          dirZ = target.vz / sp;
        }
        // Behind the leader along its travel, off to one side (right = (-dirZ, dirX)), up above the ground.
        const x = target.x - dirX * P.behind - dirZ * P.side * side;
        const z = target.z - dirZ * P.behind + dirX * P.side * side;
        want.set(x, Math.max(world.heightAt(x, z), target.y) + P.alt, z);
        // Over the rooftops on the way: the station, and where the follow will be a moment from now.
        want.y = Math.max(want.y, floorAt(x, z), floorAt(pos.x, pos.z));
        for (const ahead of P.roofLook) want.y = Math.max(want.y, floorAt(pos.x + vel.x * ahead, pos.z + vel.z * ahead));
        wantV.set(target.vx, 0, target.vz);
      } else {
        want.set(lp.x, lp.y, lp.z);
        wantV.set(lf.x, lf.y, lf.z).multiplyScalar(P.patrolSpeed);
      }
      const n = Math.max(1, Math.ceil(dt * 60));
      for (let i = 0; i < n; i++) step(dt / n);
      // Backstop for a roof the lookahead missed: ease back up inside the clearance (no pop), and
      // never closer than half the clearance to the roof.
      const floor = floorAt(pos.x, pos.z);
      if (pos.y < floor) {
        pos.y = Math.max(pos.y + (floor - pos.y) * (1 - Math.exp(-dt / 0.2)), floor - P.roofClear / 2);
        vel.y = Math.max(0, vel.y);
      }
      // Leaving: back on the loop once it has caught it up.
      if (!target && pos.distanceTo(want) < P.rejoin && vel.distanceTo(wantV) < P.rejoin * 1.5) engaged = false;
    }
    const k = 1 - Math.exp(-dt / P.turnLag);
    if (engaged) {
      mesh.position.copy(pos);
      const sp = Math.hypot(vel.x, vel.z);
      // Nose along the travel when moving; hovering, it turns to face the leader.
      const ty = sp > 5 ? Math.atan2(vel.x, vel.z) : target ? Math.atan2(target.x - pos.x, target.z - pos.z) : yaw;
      let d = ty - yaw;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      yaw += d * k;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      // Bank into the acceleration across the nose (right = (-fz, fx)), nose down with speed and forward pull.
      const aRight = acc.x * -fz + acc.z * fx;
      const aFwd = acc.x * fx + acc.z * fz;
      bank += (Math.max(-P.maxBank, Math.min(P.maxBank, (aRight / 9.81) * P.bankGain)) - bank) * k;
      pitch += (Math.max(-0.2, Math.min(P.maxPitch, 0.04 + (sp / P.vMax) * 0.16 + (aFwd / 9.81) * 0.35)) - pitch) * k;
    } else {
      mesh.position.set(lp.x, lp.y, lp.z);
      yaw = Math.atan2(lf.x, lf.z);
      bank += (loopPose.bank - bank) * k;
      pitch += (-Math.asin(Math.max(-1, Math.min(1, lf.y))) * 0.6 - pitch) * k;
    }
    mesh.quaternion.setFromEuler(e.set(pitch, yaw, bank, 'YXZ'));
    // Lights while engaged on a chase; the beam once the leader is in reach.
    const fade = 1 - Math.exp(-dt / P.fade);
    lights += ((engaged && target ? 1 : 0) - lights) * fade;
    opts.uniforms.uPolice.value = lights;
    opts.uniforms.uPoliceSoft.value = opts.flashes && !opts.flashes() ? 1 : 0;
    const reach = target ? Math.hypot(target.x - mesh.position.x, target.z - mesh.position.z) : Infinity;
    beamOn += ((target && engaged && reach < P.reach ? 1 : 0) - beamOn) * fade;
    if (target) {
      // The aim trails the leader a little: an operator tracking by hand.
      const ka = aimed ? 1 - Math.exp(-dt / P.aimLag) : 1;
      aim.x += (target.x - aim.x) * ka;
      aim.z += (target.z - aim.z) * ka;
      aimed = true;
    }
    aim.y = world.heightAt(aim.x, aim.z);
    apex.set(mesh.position.x, mesh.position.y - 1.1, mesh.position.z);
    beamMat.uniforms.uIntensity.value = P.intensity * beamOn;
    beam.visible = beamOn > 0.01;
    if (!beam.visible && !target) aimed = false;
  };
  update(0);

  // Rotor chop near the camera, created on first approach once the page has had a gesture.
  let rotor: HeliRotor | null = null;
  let rotorTried = false;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const view = (camera: THREE.Camera): void => {
    camera.getWorldPosition(camPos);
    const p = mesh.position;
    const dist = Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
    const proximity = dist > P.hear ? 0 : 1 / (1 + (dist / P.near) ** 2);
    if (!rotor && !rotorTried && proximity > 0.02) {
      rotor = HeliRotor.create(P.rotor);
      rotorTried = rotor !== null || !HeliRotor.blocked();
    }
    if (!rotor) return;
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const dx = p.x - camPos.x;
    const dz = p.z - camPos.z;
    const l = Math.hypot(dx, dz) || 1;
    rotor.update(proximity, (dx * camRight.x + dz * camRight.z) / l);
  };

  return {
    mesh,
    beam,
    chase(t) {
      target = t;
    },
    update,
    view,
    position: () => [mesh.position.x, mesh.position.y, mesh.position.z],
    dispose() {
      rotor?.dispose();
      rotor = null;
      geo.dispose();
      beamGeo.dispose();
      beamMat.dispose();
    },
  };
}

export interface AirTraffic {
  group: THREE.Group;
  /** The race leader the police helicopter chases this frame (interpolated pose), or null to patrol / leave. */
  chase(target: ChaseTarget | null): void;
  update(time: number): void;
  /** Per render: the rotor sound follows the camera. */
  view(camera: THREE.Camera): void;
  heliPosition(): [number, number, number];
  policePosition(): [number, number, number];
  spotPosition(): [number, number, number];
  blimpPosition(): [number, number, number];
  dispose(): void;
}

export function buildAirTraffic(world: World, opts: { quality: Quality; fogDensity: number; eventName?: string; flashes?: () => boolean }): AirTraffic {
  const seed = world.seed;
  const group = new THREE.Group();
  group.name = 'airTraffic';
  const words = [opts.eventName ?? AIR.words[0], ...AIR.words.slice(1)];
  const led = makeLedTextTexture(words, seed);
  const { material, uniforms } = airMaterial(led);
  const heliGeo = heliGeometry();
  const blimpGeo = blimpGeometry();
  const heli = new THREE.Mesh(heliGeo, material);
  heli.name = 'helicopter';
  const blimp = new THREE.Mesh(blimpGeo, material);
  blimp.name = 'blimp';
  group.add(heli, blimp);

  const glow = makeRadialGlow();
  const beamMat = beamMaterial({ radius: AIR.heli.beamRadius, spotR: AIR.heli.beamRadius * 1.7, color: new THREE.Color(1.0, 0.95, 0.82), intensity: 1, fogDensity: opts.fogDensity, glow });
  const beamGeo = beamGeometry();
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = 'searchlight';
  beam.frustumCulled = false;
  beam.renderOrder = 3;
  group.add(beam);
  // The police helicopter: patrols high, chases the leader on the last lap.
  const police = buildPoliceHeli(world, { quality: opts.quality, fogDensity: opts.fogDensity, material, uniforms, glow, flashes: opts.flashes });
  group.add(police.mesh, police.beam);

  const loop = buildLoop(heliWaypoints(world, seed));
  const pose: HeliPose = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 1 }, bank: 0 };
  const bp = blimpParams(world, seed);
  const blimpPose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const route = world.route;
  const apex = beamMat.uniforms.uApex.value as THREE.Vector3;
  const target = beamMat.uniforms.uTarget.value as THREE.Vector3;
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  const update = (time: number): void => {
    uniforms.uTime.value = time;
    uniforms.uRotor.value = (time * AIR.heli.rotorRps * Math.PI * 2) % (Math.PI * 2);
    heliPoseAt(loop, time, pose);
    heli.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
    const yaw = Math.atan2(pose.fwd.x, pose.fwd.z);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, pose.fwd.y))) * 0.6;
    // Nose +z, so body +x is the left side: a positive bank (right side down) is a positive roll about z.
    heli.quaternion.setFromEuler(e.set(pitch, yaw, pose.bank, 'YXZ'));
    // Searchlight: the course ahead of the helicopter's ground track, swept side to side; when it
    // roams far from the route the beam settles on the ground below instead of stretching out.
    const rp = world.routeProgress(pose.pos.x, pose.pos.z);
    const p = routeSample(route, rp.s + AIR.heli.ahead);
    const sway = AIR.heli.sweep;
    let tx = p.x + p.tz * sway * Math.sin(time * 0.6) + p.tx * sway * 0.5 * Math.sin(time * 0.37);
    let tz = p.z - p.tx * sway * Math.sin(time * 0.6) + p.tz * sway * 0.5 * Math.sin(time * 0.37);
    const dx = tx - pose.pos.x;
    const dz = tz - pose.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > AIR.heli.reach) {
      const k = AIR.heli.reach / d;
      tx = pose.pos.x + dx * k;
      tz = pose.pos.z + dz * k;
    }
    apex.set(pose.pos.x, pose.pos.y - 1.1, pose.pos.z);
    target.set(tx, world.heightAt(tx, tz), tz);
    blimpPoseAt(bp, time, blimpPose);
    blimp.position.set(blimpPose.pos.x, blimpPose.pos.y, blimpPose.pos.z);
    blimp.quaternion.copy(q.setFromEuler(e.set(0, blimpPose.yaw, 0, 'YXZ')));
    police.update(time);
  };
  update(0);

  // Rotor thump near the camera, created on first approach once the page has had a gesture.
  let rotor: HeliRotor | null = null;
  let rotorTried = false;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const view = (camera: THREE.Camera): void => {
    police.view(camera);
    camera.getWorldPosition(camPos);
    const dist = Math.hypot(pose.pos.x - camPos.x, pose.pos.y - camPos.y, pose.pos.z - camPos.z);
    const proximity = dist > AIR.sound.hear ? 0 : 1 / (1 + (dist / AIR.sound.near) ** 2);
    if (!rotor && !rotorTried && proximity > 0.02) {
      rotor = HeliRotor.create();
      rotorTried = rotor !== null || !HeliRotor.blocked();
    }
    if (!rotor) return;
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const dx = pose.pos.x - camPos.x;
    const dz = pose.pos.z - camPos.z;
    const l = Math.hypot(dx, dz) || 1;
    rotor.update(proximity, (dx * camRight.x + dz * camRight.z) / l);
  };

  return {
    group,
    chase: police.chase,
    update,
    view,
    heliPosition: () => [pose.pos.x, pose.pos.y, pose.pos.z],
    policePosition: police.position,
    spotPosition: () => [target.x, target.y, target.z],
    blimpPosition: () => [blimpPose.pos.x, blimpPose.pos.y, blimpPose.pos.z],
    dispose() {
      rotor?.dispose();
      rotor = null;
      police.dispose();
      group.removeFromParent();
      heliGeo.dispose();
      blimpGeo.dispose();
      beamGeo.dispose();
      material.dispose();
      beamMat.dispose();
      led.dispose();
      glow.dispose();
    },
  };
}
