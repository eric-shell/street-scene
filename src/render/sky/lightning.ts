/**
 * Lightning on rain nights (weather.ts builds it for the 'rain' mood). Render
 * only and a pure function of the seed and the scene clock, so a race and its
 * replay flash at the same moments:
 *  - a schedule of strikes, one every 15 to 40 s, each two or three return
 *    strokes a tenth of a second or more apart and an afterglow, at a seeded
 *    heading and distance (0.9 to 6.5 km); about a third stay inside the
 *    cloud and only light it;
 *  - the flash: the sky dome (scene.backgroundIntensity), the street
 *    reflections (environmentIntensity), the sky light and the moon light
 *    swung round to the strike (NightLighting.flash) all lift together, so
 *    the city brightens through the normal lighting, tone mapping and bloom
 *    instead of a white overlay; the rain streaks catch it too;
 *  - the bolt: a jagged ribbon, with branches at Medium and High, drawn
 *    beyond the near mountain ridge like the backdrop (it follows the camera,
 *    unfogged, with depth so the skyline cuts it), and a glow in the cloud
 *    above it, both additive;
 *  - thunder (audio/sfx.ts Thunder) once the sound has travelled the strike's
 *    distance at 343 m/s, panned toward it.
 * Flashes stay soft: the peak lifts are modest (no white frame), a strike has
 * at most three strokes (never more than three flashes in a second, the
 * photosensitivity guideline), and the Flash effects setting (off) keeps the
 * sky still and leaves only the thunder. Two draw calls, both hidden between
 * strikes; per frame a few uniforms, and the bolt geometry is rewritten once
 * per strike into a fixed buffer.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Quality } from '../../ui/settings';
import { Thunder } from '../../audio/sfx';
import type { NightLighting } from '../lighting';
import { makeNoiseTexture } from './skyTextures';
import { makeRadialGlow } from '../textures/textures';

export const LIGHTNING = {
  /** Gap between strikes (s); the first comes this long after the scene starts (s). */
  gap: [15, 40] as [number, number],
  first: [5, 16] as [number, number],
  /** Return strokes per strike (at most 3: no more than three flashes in a second), the gap after each (s) and how fast one fades (s). */
  strokes: [2, 3] as [number, number],
  strokeGap: [0.12, 0.24] as [number, number],
  attack: 0.008,
  decay: 0.07,
  /** The cloud keeps glowing after the strokes: share of the peak and its fade (s). */
  afterglow: 0.32,
  afterDecay: 0.45,
  /** Strike distance (m) and power; a share stays inside the cloud (no bolt, a dimmer flash). */
  distance: [900, 6500] as [number, number],
  power: [0.55, 1] as [number, number],
  inCloud: 0.35,
  inCloudPower: 0.6,
  /** Peak lifts at a full flash: sky dome intensity, environment (wet street reflections), sky light, moon light. */
  sky: 2.4,
  env: 0.3,
  hemi: 0.5,
  key: 0.8,
  /** Rain streak opacity lift at a full flash. */
  rain: 1.4,
  /** Bolt: drawn this far from the camera (m, between the backdrop's two ridges), from a cloud base in this band (m) down to below the horizon (m). */
  radius: 1820,
  cloudBase: [460, 640] as [number, number],
  bottom: -60,
  /** Main channel points, sideways wander per step (share of the step), ribbon width (m) and the core's share of it, HDR brightness. */
  points: 26,
  wander: 0.55,
  width: 26,
  core: 0.16,
  bright: 3.2,
  /** Branches per bolt by quality, their points. */
  branches: { low: 0, medium: 2, high: 3 } as Record<Quality, number>,
  branchPoints: 9,
  /** A strike this close (m) draws bigger and brighter, up to `nearScale`. */
  nearAt: 1600,
  nearScale: 1.5,
  /**
   * Cloud glow: distance from the camera (m, behind the bolt, in front of the far ridge it lights),
   * size (m), brightness, and the highest its top may reach (m) so the chase camera's far plane
   * (2200 m) never cuts it.
   */
  glowRadius: 1880,
  glowSize: [1400, 620] as [number, number],
  glow: 0.55,
  glowTop: 1050,
  /** Speed of sound (m/s): thunder arrives distance / this after the flash. */
  sound: 343,
} as const;

/** One return stroke: when it fires after the strike starts (s) and how strong (0..1). */
export interface Stroke {
  at: number;
  k: number;
}

export interface Strike {
  /** Scene clock time of the first stroke (s). */
  t: number;
  strokes: Stroke[];
  /** Heading from the camera (rad, x = sin, z = cos), distance (m), power 0..1. */
  azimuth: number;
  distance: number;
  power: number;
  /** Inside the cloud: no bolt, a dimmer flash. */
  inCloud: boolean;
  /** Seed of the bolt's shape. */
  shape: number;
}

/** A seed's strikes in time order, made lazily: each one depends only on the ones before it. */
export class LightningSchedule {
  private readonly rng: Rng;
  private readonly list: Strike[] = [];
  private next: number;

  constructor(seed: number) {
    this.rng = new Rng(deriveSeed(seed, 'lightning'));
    this.next = this.rng.range(LIGHTNING.first[0], LIGHTNING.first[1]);
  }

  get(i: number): Strike {
    while (this.list.length <= i) this.list.push(this.make());
    return this.list[i];
  }

  /** Index of the last strike that started at or before `time` (s), -1 before the first. */
  indexAt(time: number): number {
    let i = -1;
    while (this.get(i + 1).t <= time) i++;
    return i;
  }

  private make(): Strike {
    const L = LIGHTNING;
    const r = this.rng;
    const t = this.next;
    this.next = t + r.range(L.gap[0], L.gap[1]);
    const n = r.int(L.strokes[0], L.strokes[1]);
    const strokes: Stroke[] = [];
    let at = 0;
    for (let k = 0; k < n; k++) {
      strokes.push({ at, k: k === 0 ? 1 : r.range(0.55, 0.95) });
      at += r.range(L.strokeGap[0], L.strokeGap[1]);
    }
    const inCloud = r.chance(L.inCloud);
    return {
      t,
      strokes,
      azimuth: r.range(0, Math.PI * 2),
      distance: r.range(L.distance[0], L.distance[1]),
      power: r.range(L.power[0], L.power[1]) * (inCloud ? L.inCloudPower : 1),
      inCloud,
      shape: r.int(1, 0x7ffffffe),
    };
  }
}

/**
 * How bright a strike is at `time` (s), pure: `flash` (0..1, what lights the
 * sky and the city: the strokes plus the cloud's afterglow) and `bolt` (0..1,
 * the strokes alone, what lights the channel). Zero before the strike and a
 * few seconds after it.
 */
export function strikeLevel(s: Strike, time: number, out: { flash: number; bolt: number } = { flash: 0, bolt: 0 }): { flash: number; bolt: number } {
  const L = LIGHTNING;
  const tau = time - s.t;
  out.flash = 0;
  out.bolt = 0;
  const lastAt = s.strokes[s.strokes.length - 1].at;
  if (tau < 0 || tau > lastAt + L.afterDecay * 8) return out;
  let bolt = 0;
  for (const st of s.strokes) {
    const d = tau - st.at;
    if (d < 0) continue;
    bolt = Math.max(bolt, st.k * Math.min(1, d / L.attack) * Math.exp(-d / L.decay));
  }
  const after = L.afterglow * Math.min(1, tau / 0.05) * Math.exp(-Math.max(0, tau - lastAt) / L.afterDecay);
  out.bolt = bolt * s.power;
  out.flash = Math.min(1, Math.max(bolt, after)) * s.power;
  return out;
}

const boltVert = /* glsl */ `
  attribute float aEdge;
  attribute float aI;
  varying float vEdge;
  varying float vI;
  void main() {
    vEdge = aEdge;
    vI = aI;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const boltFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLevel;
  uniform float uCore;
  varying float vEdge;
  varying float vI;
  void main() {
    float e = abs(vEdge);
    // A hot core a fraction of the ribbon wide, inside a faint halo that fades to its edges.
    float core = exp(-pow(e / uCore, 2.0) * 1.6);
    float halo = exp(-e * e * 5.0) * 0.12;
    gl_FragColor = vec4(uColor * (core + halo) * vI * uLevel, 1.0);
  }
`;

const glowVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const glowFrag = /* glsl */ `
  uniform sampler2D uGlow;
  uniform sampler2D uNoise;
  uniform vec3 uColor;
  uniform float uLevel;
  uniform vec2 uShift;
  varying vec2 vUv;
  void main() {
    // The flash lights the cloud's underside: a soft blob broken up by billows.
    float blob = texture2D(uGlow, vUv).r;
    float billow = texture2D(uNoise, vUv * vec2(1.6, 0.8) + uShift).r;
    float a = blob * smoothstep(0.25, 0.85, billow * 0.8 + blob * 0.45);
    gl_FragColor = vec4(uColor * a * uLevel, 1.0);
  }
`;

export interface Lightning {
  /** Follows the camera like the backdrop; add to the scene (weather.ts adds it to its group). */
  group: THREE.Group;
  /** The scene and lights a flash lifts (weather.apply hands them over once the mood is set). */
  attach(scene: THREE.Scene, lighting: NightLighting): void;
  /** Per frame with the scene clock (s); returns the flash level 0..1 shown (0 with flash effects off). */
  update(time: number): number;
  /** Per render: follow the camera, and remember which way is right for the thunder's pan. */
  view(camera: THREE.Camera): void;
  dispose(): void;
}

export function buildLightning(seed: number, opts: { quality: Quality; flashes?: () => boolean }): Lightning {
  const L = LIGHTNING;
  const group = new THREE.Group();
  group.name = 'lightning';
  const schedule = new LightningSchedule(seed);
  const branches = L.branches[opts.quality] ?? 0;

  // Bolt: one ribbon per channel in a fixed buffer, rewritten once per strike.
  const maxPts = L.points + branches * L.branchPoints;
  const pos = new Float32Array(maxPts * 2 * 3);
  const edge = new Float32Array(maxPts * 2);
  const inten = new Float32Array(maxPts * 2);
  const index = new Uint16Array(maxPts * 6);
  const boltGeo = new THREE.BufferGeometry();
  const indexAttr = new THREE.BufferAttribute(index, 1).setUsage(THREE.DynamicDrawUsage);
  boltGeo.setIndex(indexAttr);
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const intAttr = new THREE.BufferAttribute(inten, 1).setUsage(THREE.DynamicDrawUsage);
  boltGeo.setAttribute('position', posAttr);
  boltGeo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  boltGeo.setAttribute('aI', intAttr);
  for (let i = 0; i < maxPts; i++) {
    edge[i * 2] = -1;
    edge[i * 2 + 1] = 1;
  }
  const boltMat = new THREE.ShaderMaterial({
    vertexShader: boltVert,
    fragmentShader: boltFrag,
    uniforms: { uColor: { value: new THREE.Color(0.72, 0.8, 1).multiplyScalar(L.bright) }, uLevel: { value: 0 }, uCore: { value: L.core } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.name = 'lightningBolt';
  bolt.frustumCulled = false;
  bolt.visible = false;
  group.add(bolt);

  // Cloud glow: one quad facing the camera above the strike.
  const glowTex = makeRadialGlow();
  const noiseTex = makeNoiseTexture(128, seed ^ 0x11a7);
  const glowMat = new THREE.ShaderMaterial({
    vertexShader: glowVert,
    fragmentShader: glowFrag,
    uniforms: { uGlow: { value: glowTex }, uNoise: { value: noiseTex }, uColor: { value: new THREE.Color(0.62, 0.66, 0.9) }, uLevel: { value: 0 }, uShift: { value: new THREE.Vector2() } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const glowGeo = new THREE.PlaneGeometry(1, 1);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.name = 'lightningGlow';
  glow.frustumCulled = false;
  glow.visible = false;
  group.add(glow);

  /** Lay the strike's channel (and branches) into the buffer, around the camera at its heading. */
  const shapeBolt = (s: Strike): void => {
    const rng = new Rng(s.shape);
    const near = Math.min(L.nearScale, Math.max(0.6, L.nearAt / s.distance));
    const rx = Math.sin(s.azimuth);
    const rz = Math.cos(s.azimuth);
    // Across the view (horizontal, perpendicular to the heading).
    const tx = -rz;
    const tz = rx;
    const top = rng.range(L.cloudBase[0], L.cloudBase[1]) * Math.min(1.25, near);
    const halfW = (L.width * near) / 2;
    let n = 0;
    let ni = 0;
    /** Ribbon along points [lateral, y] at the bolt radius, intensity tapering from i0 to i1. */
    const ribbon = (pts: [number, number][], i0: number, i1: number): void => {
      for (let k = 0; k < pts.length; k++) {
        const [u, y] = pts[k];
        // Width across the channel's own direction in the view plane, so sideways branches stay wide.
        const a = pts[Math.max(0, k - 1)];
        const b = pts[Math.min(pts.length - 1, k + 1)];
        let du = b[0] - a[0];
        let dy = b[1] - a[1];
        const l = Math.hypot(du, dy) || 1;
        du /= l;
        dy /= l;
        const pu = -dy * halfW;
        const py = du * halfW;
        const cx = rx * L.radius + tx * u;
        const cz = rz * L.radius + tz * u;
        const o = n * 6;
        pos[o] = cx - tx * pu;
        pos[o + 1] = y - py;
        pos[o + 2] = cz - tz * pu;
        pos[o + 3] = cx + tx * pu;
        pos[o + 4] = y + py;
        pos[o + 5] = cz + tz * pu;
        const i = i0 + (i1 - i0) * (k / Math.max(1, pts.length - 1));
        inten[n * 2] = i;
        inten[n * 2 + 1] = i;
        if (k > 0) {
          const v = n * 2;
          index[ni++] = v - 2;
          index[ni++] = v - 1;
          index[ni++] = v + 1;
          index[ni++] = v - 2;
          index[ni++] = v + 1;
          index[ni++] = v;
        }
        n++;
      }
    };
    // Main channel: a random walk down from the cloud base to below the horizon.
    const main: [number, number][] = [];
    let u = rng.range(-60, 60);
    const step = (top - L.bottom) / (L.points - 1);
    for (let k = 0; k < L.points; k++) {
      main.push([u, top - step * k]);
      u += (rng.next() - 0.5) * 2 * step * L.wander + rng.range(-0.15, 0.15) * step;
    }
    ribbon(main, 1, 0.85);
    // Branches fork off the upper two thirds and reach down and out, fading to their tips.
    for (let b = 0; b < branches; b++) {
      const from = main[rng.int(2, Math.floor(L.points * 0.6))];
      const dir = rng.chance(0.5) ? 1 : -1;
      const pts: [number, number][] = [];
      let bu = from[0];
      let by = from[1];
      const bstep = step * rng.range(0.6, 1);
      for (let k = 0; k < L.branchPoints; k++) {
        pts.push([bu, by]);
        bu += dir * bstep * rng.range(0.3, 0.9);
        by -= bstep * rng.range(0.4, 0.9);
      }
      ribbon(pts, rng.range(0.4, 0.65), 0.05);
    }
    boltGeo.setDrawRange(0, ni);
    indexAttr.needsUpdate = true;
    posAttr.needsUpdate = true;
    intAttr.needsUpdate = true;
    boltMat.uniforms.uCore.value = L.core;
    // The cloud glow sits over the channel's top, facing the camera, its top inside the far plane.
    const gs = Math.min(1.2, near);
    const gy = Math.min(top + L.glowSize[1] * 0.15, L.glowTop - (L.glowSize[1] * gs) / 2);
    glow.position.set(rx * L.glowRadius, gy, rz * L.glowRadius);
    glow.scale.set(L.glowSize[0] * gs, L.glowSize[1] * gs, 1);
    glow.rotation.set(0, s.azimuth + Math.PI, 0);
    (glowMat.uniforms.uShift.value as THREE.Vector2).set(rng.next(), rng.next());
  };

  let scene: THREE.Scene | null = null;
  let lighting: NightLighting | null = null;
  let envBase = 1;
  let shaped = -1;
  let heard = 0;
  let thunder: Thunder | null = null;
  const camRight = { x: 1, z: 0 };
  const level = { flash: 0, bolt: 0 };

  const update = (time: number): number => {
    const i = schedule.indexAt(time);
    let flash = 0;
    let boltLevel = 0;
    let s: Strike | null = null;
    if (i >= 0) {
      s = schedule.get(i);
      strikeLevel(s, time, level);
      const on = !opts.flashes || opts.flashes();
      flash = on ? level.flash : 0;
      boltLevel = on && !s.inCloud ? level.bolt * Math.sqrt(Math.min(L.nearScale, Math.max(0.6, L.nearAt / s.distance))) : 0;
      if (boltLevel > 0 && shaped !== i) {
        shapeBolt(s);
        shaped = i;
      }
      if (flash > 0 && shaped !== i && s.inCloud) {
        // A flash inside the cloud still needs the glow placed above it.
        shapeBolt(s);
        shaped = i;
      }
    }
    bolt.visible = boltLevel > 0.004;
    boltMat.uniforms.uLevel.value = boltLevel;
    glow.visible = flash > 0.004;
    glowMat.uniforms.uLevel.value = flash * L.glow;
    if (scene) {
      scene.backgroundIntensity = 1 + L.sky * flash;
      scene.environmentIntensity = envBase + L.env * flash;
    }
    if (s) lighting?.flash(flash, Math.sin(s.azimuth), Math.cos(s.azimuth), L.hemi, L.key);
    else lighting?.flash(0, 0, 1, 0, 0);
    // Thunder for every strike whose sound has arrived (skipped if the clock jumped well past it).
    for (;;) {
      const h = schedule.get(heard);
      const arrive = h.t + h.distance / L.sound;
      if (arrive > time) break;
      if (time - arrive < 1) {
        thunder ??= Thunder.create();
        thunder?.strike(h.distance, h.power, Math.sin(h.azimuth) * camRight.x + Math.cos(h.azimuth) * camRight.z);
      }
      heard++;
    }
    return flash;
  };

  const camPos = new THREE.Vector3();
  const right = new THREE.Vector3();
  return {
    group,
    attach(sc, li) {
      scene = sc;
      lighting = li;
      envBase = sc.environmentIntensity;
    },
    update,
    view(camera) {
      camera.getWorldPosition(camPos);
      group.position.set(camPos.x, 0, camPos.z);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const l = Math.hypot(right.x, right.z) || 1;
      camRight.x = right.x / l;
      camRight.z = right.z / l;
    },
    dispose() {
      thunder?.dispose();
      thunder = null;
      if (scene) {
        scene.backgroundIntensity = 1;
        scene.environmentIntensity = envBase;
      }
      lighting?.flash(0, 0, 1, 0, 0);
      boltGeo.dispose();
      boltMat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      glowTex.dispose();
      noiseTex.dispose();
    },
  };
}
