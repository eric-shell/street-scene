/**
 * A fireworks display on about three seeds in ten: a barge's show over the water (the harbor's open sea, else the
 * lake, else the river's far end, else past downtown's far edge) a minute or so into the night. Render and audio
 * only and a pure function of the seed and the scene clock, so a race and its replay see the same show:
 *  - the plan (`fireworksPlan`, its own stream): a start 20 to 90 s in, a run of 2 to 4 minutes, a shell every 4 to
 *    12 s and a finale salvo of three; each shell has a launch, a rise, a burst height and spot across the water, a
 *    kind (peony, chrysanthemum with trails, willow, crackle) and two colours from the seed's neon mood;
 *  - the burst: 60 to 120 sparks written once into a ring buffer when the shell is prepared, born at the burst
 *    time. Their whole flight (launch speed, air drag, gravity, trail length, fade, twinkle, the crackle's last pop)
 *    is the vertex shader's, like render/car/sparks.ts, so a frame costs two uniform writes. One instanced draw for
 *    the sparks, one for the shells (the rising streak) and the glows at the bursts;
 *  - the glow: a soft sprite at the burst that lights the sky round it; the Flash effects setting dims it (the sparks
 *    stay), and bursts are at least 0.4 s apart, so never more than three flashes in a second;
 *  - the sound (audio/sceneVoices.ts FireworkVoice): a thump at the launch and a boom and crackle at the burst, each
 *    heard once the sound has travelled from the shell to the camera at 343 m/s, panned toward it.
 * Pool: 1000 sparks at Low, 2000 at Medium, 4000 at High. The water's reflection is left out: the street streak
 * emitters (lightFx) are fixed lamps built with the city, with no hook for a short-lived light.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import type { World } from '../../city/world';
import { polygonCentroid } from '../../city/districts/geom';
import type { Quality } from '../../ui/settings';
import { FireworkVoice } from '../../audio/sceneVoices';
import { NEON_COLORS } from '../textures/textures';
import { neonMood } from '../textures/cityMood';
import { harborSea } from '../districts/waterfront';

export type ShellKind = 'peony' | 'chrysanthemum' | 'willow' | 'crackle';
export const SHELL_KINDS: readonly ShellKind[] = ['peony', 'chrysanthemum', 'willow', 'crackle'];

export const FIREWORKS = {
  /** Share of seeds with a display. */
  chance: 0.3,
  /** First launch (s), length of the show (s) and the gap between shells (s). */
  start: [20, 90] as [number, number],
  duration: [120, 240] as [number, number],
  gap: [4, 12] as [number, number],
  /** Finale: shells in the closing salvo and the time between their bursts (s); 3 in under a second at most. */
  finale: 3,
  finaleGap: 0.45,
  /** Rise time of a shell (s) and its burst height over the water (m). */
  rise: [1.5, 2.2] as [number, number],
  height: [150, 300] as [number, number],
  /** Burst radius (m), sparks per shell. */
  radius: [85, 140] as [number, number],
  count: [60, 120] as [number, number],
  /** Live sparks at once per quality (the oldest are overwritten first). */
  pool: { low: 1000, medium: 2000, high: 4000 } as Record<Quality, number>,
  /** Shell slots (a shell and its glow live a few seconds), and the longest a burst's glow or sparks last (s). */
  slots: 8,
  tail: 7,
  /** Per kind: air drag (1/s), gravity (m/s2), life (s), trail (s), fade exponent. */
  kinds: {
    peony: { drag: 2.3, gravity: 4, life: [2.4, 3.0], trail: 0.1, fade: 1.4 },
    chrysanthemum: { drag: 2.0, gravity: 5, life: [3.2, 4.0], trail: 0.5, fade: 1.2 },
    willow: { drag: 1.2, gravity: 6.5, life: [5.0, 6.0], trail: 0.55, fade: 0.8 },
    crackle: { drag: 2.1, gravity: 4.5, life: [2.6, 3.4], trail: 0.12, fade: 1.2 },
  } as Record<ShellKind, { drag: number; gravity: number; life: [number, number]; trail: number; fade: number }>,
  /** HDR brightness of a fresh spark, a shell's streak, and the burst glow (m wide, brightness; the setting off dims it by `dim`). */
  heat: 2.2,
  shellHeat: 8,
  glowSize: 380,
  glow: 0.35,
  dim: 0.2,
  /** Spark width (m) and the least it may be on screen (pixels). */
  width: 0.5,
  minPixels: 2,
  /** Speed of sound (m/s). */
  sound: 343,
} as const;

export interface Shell {
  /** Scene clock time of the launch, the rise (s) and the burst (s). */
  launch: number;
  rise: number;
  burst: number;
  kind: ShellKind;
  /** Colours: indices into NEON_COLORS. */
  a: number;
  b: number;
  /** Across the display -1..1, and the burst height (m, over the water). */
  u: number;
  height: number;
  /** Burst size 0.7..1.2 and spark count. */
  size: number;
  count: number;
  /** Seed of the burst's sparks. */
  seed: number;
}

export interface FireworksPlan {
  /** First launch and last burst (s). */
  start: number;
  end: number;
  /** Heading (rad) the display takes when no water offers one. */
  heading: number;
  shells: Shell[];
}

/** The seed's display, or null: about `FIREWORKS.chance` of seeds have one. Pure (its own stream). */
export function fireworksPlan(seed: number): FireworksPlan | null {
  const F = FIREWORKS;
  const rng = new Rng(deriveSeed(seed, 'fireworks'));
  if (!rng.chance(F.chance)) return null;
  const start = rng.range(F.start[0], F.start[1]);
  const end = start + rng.range(F.duration[0], F.duration[1]);
  const heading = rng.range(0, Math.PI * 2);
  const mood = neonMood(seed);
  const shells: Shell[] = [];
  const make = (launch: number, finale: boolean): void => {
    const rise = rng.range(F.rise[0], F.rise[1]);
    const a = mood.neon(rng.next());
    let b = mood.neon(rng.next());
    if (b === a) b = (a + 1 + rng.int(0, 5)) % NEON_COLORS.length;
    shells.push({
      launch,
      rise,
      burst: launch + rise,
      kind: SHELL_KINDS[finale ? rng.int(0, 1) * 3 : rng.int(0, 3)],
      a,
      b,
      u: rng.range(-1, 1),
      height: rng.range(F.height[0], F.height[1]),
      size: rng.range(0.7, 1.2),
      count: rng.int(F.count[0], F.count[1]),
      seed: rng.int(1, 0x7ffffffe),
    });
  };
  let t = start;
  while (t < end - 6) {
    make(t, false);
    t += rng.range(F.gap[0], F.gap[1]);
  }
  // The finale: bursts F.finaleGap apart (launches staggered by their rises), so three flashes fit in a second.
  const t0 = t;
  for (let k = 0; k < F.finale; k++) {
    make(0, true);
    const s = shells[shells.length - 1];
    s.burst = t0 + F.finale * 0.2 + k * F.finaleGap;
    s.launch = s.burst - s.rise;
  }
  shells.sort((x, y) => x.burst - y.burst);
  return { start, end: Math.max(...shells.map((s) => s.burst)), heading, shells };
}

export interface FireworksSite {
  /** Centre of the display on the water (m), the water level (m). */
  x: number;
  y: number;
  z: number;
  /** Unit tangent across the display, half its width (m), and the scale of burst sizes (a lake is small). */
  tx: number;
  tz: number;
  span: number;
  scale: number;
}

/** Where the show is held: the harbor's sea, else the lake, else the river's far end, else off downtown's far edge. */
export function fireworksSite(world: World, plan: FireworksPlan): FireworksSite {
  const b = world.graph.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const sea = harborSea(world);
  if (sea) {
    const span = (((sea.to - sea.from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const mid = sea.from + span / 2;
    const dx = Math.cos(mid);
    const dz = Math.sin(mid);
    return { x: cx + dx * 1150, y: sea.level, z: cz + dz * 1150, tx: -dz, tz: dx, span: Math.min(450, 1150 * Math.sin(Math.min(span / 2, 1.2)) * 0.7), scale: 1 };
  }
  const lake = world.areas.find((a) => a.kind === 'lake' && a.polygon.length > 2);
  if (lake) {
    const c = polygonCentroid(lake.polygon);
    const d = Math.hypot(c.x - cx, c.z - cz) || 1;
    return { x: c.x, y: lake.params.water, z: c.z, tx: -(c.z - cz) / d, tz: (c.x - cx) / d, span: 25, scale: 0.5 };
  }
  const river = world.areas.find((a) => a.kind === 'river' && a.path.length > 1);
  if (river) {
    const p0 = river.path[0];
    const p1 = river.path[river.path.length - 1];
    const far = Math.hypot(p0.x - cx, p0.z - cz) > Math.hypot(p1.x - cx, p1.z - cz) ? p0 : p1;
    const d = Math.hypot(far.x - cx, far.z - cz) || 1;
    return { x: far.x, y: world.heightAt(far.x, far.z), z: far.z, tx: -(far.z - cz) / d, tz: (far.x - cx) / d, span: 40, scale: 0.6 };
  }
  const reach = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 280;
  const dx = Math.cos(plan.heading);
  const dz = Math.sin(plan.heading);
  return { x: cx + dx * reach, y: 0, z: cz + dz * reach, tx: -dz, tz: dx, span: 350, scale: 1 };
}

/** Where a shell bursts: the site, `u` across it, `height` over the water (scaled for a small site). */
export function burstPoint(site: FireworksSite, s: Shell, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  out.x = site.x + site.tx * s.u * site.span;
  out.z = site.z + site.tz * s.u * site.span;
  out.y = site.y + s.height * (0.4 + 0.6 * site.scale);
  return out;
}

const KIND_ID: Record<ShellKind, number> = { peony: 0, chrysanthemum: 1, willow: 2, crackle: 3 };

const sparkVert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aMeta; // birth (s), life (s), trail (s), seed 0..1
  attribute vec4 aCol;  // rgb, kind
  attribute vec3 aPar;  // drag (1/s), gravity (m/s2), fade exponent
  uniform float uTime;
  uniform float uWidth;
  uniform float uPixel;
  varying float vAge;
  varying float vSeed;
  varying float vEdge;
  varying vec3 vCol;
  varying float vKind;
  varying float vTrail;
  varying float vFade;

  vec3 at(float t) {
    float decay = exp(-aPar.x * t);
    vec3 p = aPos + aVel * (1.0 - decay) / aPar.x;
    p.y -= 0.5 * aPar.y * t * t;
    return p;
  }

  void main() {
    float t = uTime - aMeta.x;
    vAge = t / aMeta.y;
    vSeed = aMeta.w;
    vEdge = corner.x * 2.0;
    vCol = aCol.rgb;
    vKind = aCol.w;
    vTrail = aMeta.z;
    vFade = aPar.z;
    if (t < 0.0 || vAge >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 head = at(t);
    vec3 tail = at(max(0.0, t - aMeta.z));
    vec4 hv = viewMatrix * vec4(head, 1.0);
    vec4 tv = viewMatrix * vec4(tail, 1.0);
    vec2 d = hv.xy - tv.xy;
    float dl = length(d);
    float wide = max(uWidth * (0.7 + vSeed * 0.6) * (1.0 - 0.5 * vAge), uPixel * -hv.z);
    d = dl > 1e-5 ? d / dl : vec2(0.0, -1.0);
    // At least a square of the streak's width, so a spark with no trail is still a dot.
    tv.xy = hv.xy - d * max(dl, wide);
    vec2 side = vec2(-d.y, d.x) * wide;
    vec4 p = mix(tv, hv, corner.y);
    p.xy += side * corner.x;
    gl_Position = projectionMatrix * p;
  }
`;

const sparkFrag = /* glsl */ `
  uniform float uHeat;
  varying float vAge;
  varying float vSeed;
  varying float vEdge;
  varying vec3 vCol;
  varying float vKind;
  varying float vTrail;
  varying float vFade;
  void main() {
    float a = vAge;
    // A shell's stars burn hottest at the burst and cool toward ember orange as they die.
    vec3 col = mix(vCol, vCol * vec3(1.0, 0.55, 0.3), smoothstep(0.55, 1.0, a));
    float fresh = 1.0 + 1.6 * exp(-a * 40.0);
    float fade = pow(max(0.0, 1.0 - a), vFade);
    float twinkle = 1.0 - smoothstep(0.35, 0.9, a) * 0.55 * (0.5 + 0.5 * sin(a * (60.0 + vSeed * 80.0) + vSeed * 40.0));
    float level = fade * twinkle * fresh;
    // Crackle: a faint ember that ends in a white pop.
    if (vKind > 2.5) {
      float pop = smoothstep(0.78, 0.8, a) * (1.0 - smoothstep(0.8, 0.9, a));
      col = mix(col, vec3(1.0, 0.95, 0.85), pop);
      level = 0.18 * fade + pop * 2.2;
    }
    float edge = 1.0 - vEdge * vEdge;
    gl_FragColor = vec4(col * uHeat * (0.55 + 0.45 * vSeed) * level * edge, 1.0);
  }
`;

const shellVert = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 iA; // launch xyz, launch time (s)
  attribute vec4 iB; // burst xyz, burst time (s)
  attribute vec4 iC; // rgb, kind 0 shell streak / 1 glow
  attribute vec2 iD; // glow width (m), seed
  uniform float uTime;
  uniform float uPixel;
  uniform float uGlow;
  uniform float uHeat;
  varying float vLevel;
  varying vec3 vCol;
  varying float vKind;
  varying vec2 vUv;

  vec3 shellAt(float s) {
    return mix(iA.xyz, iB.xyz, 1.0 - pow(1.0 - clamp(s, 0.0, 1.0), 2.2));
  }

  void main() {
    vCol = iC.rgb;
    vKind = iC.w;
    vUv = corner * 2.0;
    vLevel = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    if (iC.w < 0.5) {
      // The rising streak: from the barge to the burst, gone when it bursts.
      float s = (uTime - iA.w) / (iB.w - iA.w);
      if (s < 0.0 || s >= 1.0) return;
      vec4 hv = viewMatrix * vec4(shellAt(s), 1.0);
      vec4 tv = viewMatrix * vec4(shellAt(s - 0.14), 1.0);
      vec2 d = hv.xy - tv.xy;
      float dl = length(d);
      float wide = max(0.45, uPixel * -hv.z);
      d = dl > 1e-5 ? d / dl : vec2(0.0, 1.0);
      tv.xy = hv.xy - d * max(dl, wide);
      vec4 p = mix(tv, hv, corner.y + 0.5);
      p.xy += vec2(-d.y, d.x) * wide * corner.x * 2.0;
      vLevel = uHeat * (0.8 + 0.2 * sin(uTime * 55.0 + iD.y));
      vUv = vec2(corner.x * 2.0, 0.0);
      gl_Position = projectionMatrix * p;
    } else {
      // The glow at the burst: a flash and a slow fade.
      float age = uTime - iB.w;
      if (age < 0.0 || age > 4.0) return;
      vLevel = uGlow * (1.0 - exp(-age / 0.05)) * exp(-age / 0.8);
      vec4 hv = viewMatrix * vec4(iB.xyz, 1.0);
      hv.xy += corner * iD.x * (1.0 + 0.25 * age);
      gl_Position = projectionMatrix * hv;
    }
  }
`;

const shellFrag = /* glsl */ `
  varying float vLevel;
  varying vec3 vCol;
  varying float vKind;
  varying vec2 vUv;
  void main() {
    if (vLevel <= 0.0) discard;
    if (vKind < 0.5) {
      float e = 1.0 - vUv.x * vUv.x;
      gl_FragColor = vec4(vec3(1.0, 0.82, 0.5) * vLevel * e, 1.0);
      return;
    }
    float r = length(vUv);
    float g = pow(max(0.0, 1.0 - r), 2.4);
    gl_FragColor = vec4(mix(vCol, vec3(1.0), 0.25) * g * vLevel, 1.0);
  }
`;

export interface Fireworks {
  /** In world space; add to the scene. */
  group: THREE.Group;
  /** Per frame with the scene clock (s): prepare the shells about to launch, hide the draws when the show is over. */
  update(time: number): void;
  /** Per render: the camera's place (the sound's delay and pan) and the size of a pixel. */
  view(camera: THREE.Camera, viewportHeight?: number): void;
  dispose(): void;
}

/** A seed's fireworks for this world, or null on the seeds without a show. */
export function buildFireworks(world: World, opts: { quality: Quality; flashes?: () => boolean }): Fireworks | null {
  const F = FIREWORKS;
  const plan = fireworksPlan(world.seed);
  if (!plan) return null;
  const site = fireworksSite(world, plan);
  const shells = plan.shells;
  const size = F.pool[opts.quality] ?? F.pool.medium;
  const group = new THREE.Group();
  group.name = 'fireworks';
  group.visible = false;
  const palette = NEON_COLORS.map((c) => new THREE.Color(c));

  // Sparks: one instanced mesh of streaks, a ring buffer written when a shell is prepared.
  const quad = (): THREE.InstancedBufferGeometry => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  const geo = quad();
  const pos = new Float32Array(size * 3);
  const vel = new Float32Array(size * 3);
  const meta = new Float32Array(size * 4);
  const col = new Float32Array(size * 4);
  const par = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    meta[i * 4] = -1e6;
    meta[i * 4 + 1] = 1;
    par[i * 3] = 1;
  }
  const attrs = {
    aPos: new THREE.InstancedBufferAttribute(pos, 3),
    aVel: new THREE.InstancedBufferAttribute(vel, 3),
    aMeta: new THREE.InstancedBufferAttribute(meta, 4),
    aCol: new THREE.InstancedBufferAttribute(col, 4),
    aPar: new THREE.InstancedBufferAttribute(par, 3),
  };
  for (const [k, a] of Object.entries(attrs)) {
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, a);
  }
  geo.instanceCount = size;
  const sparkMat = new THREE.ShaderMaterial({
    vertexShader: sparkVert,
    fragmentShader: sparkFrag,
    uniforms: { uTime: { value: 0 }, uWidth: { value: F.width }, uPixel: { value: 0.001 }, uHeat: { value: F.heat } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const sparks = new THREE.Mesh(geo, sparkMat);
  sparks.name = 'fireworkSparks';
  sparks.frustumCulled = false;
  sparks.renderOrder = 3;
  group.add(sparks);

  // Shells and glows: two instances per slot (the streak, then the glow).
  const sgeo = quad();
  const n = F.slots * 2;
  const iA = new Float32Array(n * 4);
  const iB = new Float32Array(n * 4);
  const iC = new Float32Array(n * 4);
  const iD = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    iA[i * 4 + 3] = -1e6;
    iB[i * 4 + 3] = -1e6;
  }
  const sattrs = {
    iA: new THREE.InstancedBufferAttribute(iA, 4),
    iB: new THREE.InstancedBufferAttribute(iB, 4),
    iC: new THREE.InstancedBufferAttribute(iC, 4),
    iD: new THREE.InstancedBufferAttribute(iD, 2),
  };
  for (const [k, a] of Object.entries(sattrs)) {
    a.setUsage(THREE.DynamicDrawUsage);
    sgeo.setAttribute(k, a);
  }
  sgeo.instanceCount = n;
  const shellMat = new THREE.ShaderMaterial({
    vertexShader: shellVert,
    fragmentShader: shellFrag,
    uniforms: { uTime: { value: 0 }, uPixel: { value: 0.001 }, uGlow: { value: F.glow }, uHeat: { value: F.shellHeat } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const shellMesh = new THREE.Mesh(sgeo, shellMat);
  shellMesh.name = 'fireworkShells';
  shellMesh.frustumCulled = false;
  shellMesh.renderOrder = 3;
  group.add(shellMesh);

  const at = { x: 0, y: 0, z: 0 };
  let next = 0;
  let prepared = 0;
  let lastTime = -1;
  const camPos = new THREE.Vector3();
  const right = new THREE.Vector3();

  /** Write shell `i`'s streak, glow and sparks. Sparks are born at the burst, so they wait unseen until then. */
  const prepare = (i: number): void => {
    const s = shells[i];
    const kd = F.kinds[s.kind];
    burstPoint(site, s, at);
    const slot = (i % F.slots) * 2;
    const ca = palette[s.a];
    const cb = palette[s.b];
    for (let k = 0; k < 2; k++) {
      const j = slot + k;
      iA[j * 4] = site.x + site.tx * s.u * site.span;
      iA[j * 4 + 1] = site.y;
      iA[j * 4 + 2] = site.z + site.tz * s.u * site.span;
      iA[j * 4 + 3] = s.launch;
      iB[j * 4] = at.x;
      iB[j * 4 + 1] = at.y;
      iB[j * 4 + 2] = at.z;
      iB[j * 4 + 3] = s.burst;
      iC[j * 4] = ca.r;
      iC[j * 4 + 1] = ca.g;
      iC[j * 4 + 2] = ca.b;
      iC[j * 4 + 3] = k;
      iD[j * 2] = F.glowSize * s.size * (0.4 + 0.6 * site.scale);
      iD[j * 2 + 1] = (s.seed % 1000) / 10;
    }
    for (const a of Object.values(sattrs)) a.needsUpdate = true;
    const rng = new Rng(s.seed);
    const radius = rng.range(F.radius[0], F.radius[1]) * s.size * site.scale;
    const count = Math.min(size, s.count);
    for (let k = 0; k < count; k++) {
      const p = next;
      next = (next + 1) % size;
      // A uniform direction on the sphere; the willow droops, the chrysanthemum has a second shell inside it.
      const z = rng.range(-1, 1);
      const phi = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(1 - z * z);
      const inner = s.kind === 'chrysanthemum' && k % 3 === 0;
      const speed = radius * kd.drag * (inner ? 0.55 : rng.range(0.92, 1.05));
      pos[p * 3] = at.x;
      pos[p * 3 + 1] = at.y;
      pos[p * 3 + 2] = at.z;
      vel[p * 3] = Math.cos(phi) * r * speed;
      vel[p * 3 + 1] = z * speed;
      vel[p * 3 + 2] = Math.sin(phi) * r * speed;
      meta[p * 4] = s.burst;
      meta[p * 4 + 1] = rng.range(kd.life[0], kd.life[1]);
      meta[p * 4 + 2] = kd.trail * rng.range(0.7, 1.1);
      meta[p * 4 + 3] = rng.next();
      const c = s.kind === 'willow' ? ca : inner || (s.kind === 'peony' && rng.chance(0.3)) ? cb : ca;
      const gold = s.kind === 'willow' ? 0.65 : 0;
      col[p * 4] = c.r * (1 - gold) + 1.0 * gold;
      col[p * 4 + 1] = c.g * (1 - gold) + 0.72 * gold;
      col[p * 4 + 2] = c.b * (1 - gold) + 0.32 * gold;
      col[p * 4 + 3] = KIND_ID[s.kind];
      par[p * 3] = kd.drag;
      par[p * 3 + 1] = kd.gravity;
      par[p * 3 + 2] = kd.fade;
    }
    for (const a of Object.values(attrs)) a.needsUpdate = true;
  };

  // The sound: shells whose launch and burst have been heard.
  let voice: FireworkVoice | null = null;
  let heardLaunch = 0;
  let heardBurst = 0;
  const launchPt = { x: 0, y: 0, z: 0 };
  /** Metres from the camera to a point, and its pan (-1 left .. 1 right). */
  const aim = (x: number, y: number, z: number): { d: number; pan: number } => {
    const dx = x - camPos.x;
    const dz = z - camPos.z;
    const d = Math.hypot(dx, y - camPos.y, dz);
    const h = Math.hypot(dx, dz) || 1;
    return { d, pan: (dx * right.x + dz * right.z) / h };
  };
  const listen = (time: number): void => {
    while (heardLaunch < shells.length) {
      const s = shells[heardLaunch];
      launchPt.x = site.x + site.tx * s.u * site.span;
      launchPt.y = site.y;
      launchPt.z = site.z + site.tz * s.u * site.span;
      const a = aim(launchPt.x, launchPt.y, launchPt.z);
      if (s.launch + a.d / F.sound > time) break;
      if (time - (s.launch + a.d / F.sound) < 1) {
        voice ??= FireworkVoice.create();
        voice?.launch(a.d, a.pan, s.size);
      }
      heardLaunch++;
    }
    while (heardBurst < shells.length) {
      const s = shells[heardBurst];
      burstPoint(site, s, at);
      const a = aim(at.x, at.y, at.z);
      if (s.burst + a.d / F.sound > time) break;
      if (time - (s.burst + a.d / F.sound) < 1.5) {
        voice ??= FireworkVoice.create();
        voice?.burst(a.d, a.pan, s.size, s.kind);
      }
      heardBurst++;
    }
  };

  return {
    group,
    update(time) {
      // A clock that went back (a restart) starts the show over.
      if (time < lastTime - 0.5) {
        prepared = 0;
        heardLaunch = 0;
        heardBurst = 0;
      }
      lastTime = time;
      const live = time >= plan.start - 2 && time <= plan.end + F.tail + 8;
      group.visible = live;
      if (!live) return;
      while (prepared < shells.length && shells[prepared].launch <= time + 0.25) {
        // A shell long over (the clock jumped) needs no sparks.
        if (shells[prepared].burst + F.tail > time) prepare(prepared);
        prepared++;
      }
      sparkMat.uniforms.uTime.value = time;
      shellMat.uniforms.uTime.value = time;
      shellMat.uniforms.uGlow.value = opts.flashes && !opts.flashes() ? F.glow * F.dim : F.glow;
      listen(time);
    },
    view(camera, viewportHeight = 720) {
      camera.getWorldPosition(camPos);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const l = Math.hypot(right.x, right.z) || 1;
      right.set(right.x / l, 0, right.z / l);
      const cam = camera as THREE.PerspectiveCamera;
      const fov = cam.isPerspectiveCamera ? cam.fov : 60;
      const px = ((2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, viewportHeight)) * F.minPixels;
      sparkMat.uniforms.uPixel.value = px;
      shellMat.uniforms.uPixel.value = px;
    },
    dispose() {
      voice?.dispose();
      voice = null;
      group.removeFromParent();
      geo.dispose();
      sgeo.dispose();
      sparkMat.dispose();
      shellMat.dispose();
    },
  };
}
