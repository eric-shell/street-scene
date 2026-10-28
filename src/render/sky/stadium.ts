/**
 * A stadium out past the city's edge, on about one seed in four: a lit bowl on the backdrop (backdrop.ts adds it to
 * the ring that follows the camera, between the near and far ridges), seen from the highway, the hills and the
 * drone. Render and audio only and a pure function of the seed and the scene clock:
 *  - the plan (`stadiumPlan`, its own stream): where it would like to stand, its size and how many floodlight
 *    masts; `stadiumSpot` moves it to the nearest stretch where the near ridge is low enough to see over;
 *  - the shape: an oval bowl whose far grandstand stands taller than the near one (so a ground level eye sees its
 *    lit inner tiers over the rim), a lit concourse band round the outer wall, a roof lip, and a ring of floodlight
 *    masts; one opaque mesh of a few hundred triangles;
 *  - the light: lamp heads on each mast and a glow round each (the light domes), a haze over the whole bowl and a
 *    video board above the far rim whose picture flickers on the scene clock, all in one additive mesh with a
 *    uniform for the clock;
 *  - the crowd (audio/sceneVoices.ts StadiumRoar): a swelling roar every 40 to 120 s (its own stream, `RoarSchedule`),
 *    sometimes with a PA horn, heard once the sound has crossed the distance at 343 m/s, panned toward the stadium
 *    and quieter with distance.
 * Draws: the bowl and the lights. Per frame one uniform write.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import { StadiumRoar } from '../../audio/sceneVoices';

export const STADIUM = {
  /** Share of seeds with a stadium. */
  chance: 0.25,
  /** Distance from the camera (m): between the near ridge (1700) and the far one (1950). */
  radius: 1820,
  /** Bowl half axes (m), rim height of the near grandstand (m) and how much taller the far one stands. */
  half: [165, 125] as [number, number],
  rim: 40,
  rake: 0.4,
  /** Floodlight mast height over the ground (m) and the lamp cluster's size (m). */
  mast: 78,
  lamp: 13,
  /** The tallest the near ridge may stand over the stadium's width (m) before it is moved. */
  ridgeRoom: 26,
  /** Roars: first one (s), gap between them (s), length (s), chance of a PA horn with one, and its offset (s). */
  roar: { first: [15, 60] as [number, number], gap: [40, 120] as [number, number], length: [7, 14] as [number, number], horn: 0.3, hornAt: [1, 4] as [number, number] },
  /** Speed of sound (m/s). */
  sound: 343,
} as const;

export interface StadiumPlan {
  /** Where it would like to stand (rad, x = cos, z = sin), size 0.85..1.25, floodlight masts (4 or 6). */
  azimuth: number;
  scale: number;
  masts: number;
}

/** The seed's stadium, or null: about `STADIUM.chance` of seeds have one. Pure (its own stream). */
export function stadiumPlan(seed: number): StadiumPlan | null {
  const rng = new Rng(deriveSeed(seed, 'stadium'));
  if (!rng.chance(STADIUM.chance)) return null;
  return { azimuth: rng.range(0, Math.PI * 2), scale: rng.range(0.85, 1.25), masts: rng.chance(0.5) ? 6 : 4 };
}

/**
 * Where on the ring it stands: the segment nearest the plan's azimuth whose stretch of the near ridge is low
 * (`heights` are the ridge's tops, one per segment round the circle). Returns the azimuth and the ground height (m).
 */
export function stadiumSpot(plan: StadiumPlan, heights: readonly number[]): { azimuth: number; base: number } {
  const n = heights.length;
  const half = Math.max(2, Math.round(((STADIUM.half[0] * plan.scale * 1.1) / STADIUM.radius / (Math.PI * 2)) * n));
  let best = 0;
  let bestScore = Infinity;
  let bestBase = 0;
  for (let i = 0; i < n; i++) {
    let hi = 0;
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const h = heights[(i + k + n) % n];
      hi = Math.max(hi, h);
      sum += h;
    }
    const t = (i / n) * Math.PI * 2;
    const off = Math.abs(((t - plan.azimuth + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    // Room first (anything over `ridgeRoom` is hidden), then nearness to the wish.
    const score = Math.max(0, hi - STADIUM.ridgeRoom) * 0.5 + off * 18;
    if (score < bestScore) {
      bestScore = score;
      best = i;
      bestBase = sum / (2 * half + 1);
    }
  }
  return { azimuth: (best / n) * Math.PI * 2, base: bestBase };
}

/** One roar: when it starts (s), how loud (0..1), how long (s), and when a PA horn sounds with it (s after, or -1). */
export interface Roar {
  t: number;
  power: number;
  length: number;
  horn: number;
}

/** A seed's roars in time order, made lazily like the lightning's. */
export class RoarSchedule {
  private readonly rng: Rng;
  private readonly list: Roar[] = [];
  private next: number;

  constructor(seed: number) {
    this.rng = new Rng(deriveSeed(seed, 'stadium:roar'));
    this.next = this.rng.range(STADIUM.roar.first[0], STADIUM.roar.first[1]);
  }

  get(i: number): Roar {
    while (this.list.length <= i) this.list.push(this.make());
    return this.list[i];
  }

  private make(): Roar {
    const R = STADIUM.roar;
    const r = this.rng;
    const t = this.next;
    this.next = t + r.range(R.gap[0], R.gap[1]);
    return { t, power: r.range(0.55, 1), length: r.range(R.length[0], R.length[1]), horn: r.chance(R.horn) ? r.range(R.hornAt[0], R.hornAt[1]) : -1 };
  }
}

const lightVert = /* glsl */ `
  attribute vec3 aColor;
  attribute vec2 aUv;
  attribute float aKind;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vKind;
  void main() {
    vColor = aColor;
    vUv = aUv;
    vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const lightFrag = /* glsl */ `
  uniform float uTime;
  varying vec3 vColor;
  varying vec2 vUv;
  varying float vKind;
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q);
    if (vKind < 0.5) {
      // A light dome: a soft glow.
      float g = pow(max(0.0, 1.0 - r), 2.0);
      gl_FragColor = vec4(vColor * g, 1.0);
    } else if (vKind < 1.5) {
      // A lamp head: a hot core in a small halo, with a slight shimmer.
      float g = exp(-r * r * 9.0) + 0.25 * max(0.0, 1.0 - r);
      float shimmer = 0.92 + 0.08 * sin(uTime * 37.0 + vColor.r * 90.0);
      gl_FragColor = vec4(vColor * g * shimmer, 1.0);
    } else {
      // The video board: a grid of cells re-coloured a few times a second, a scan line and a flash now and then.
      vec2 cell = floor(vUv * vec2(18.0, 5.0));
      float step1 = floor(uTime * 2.5 + hash(cell) * 3.0);
      float h = hash(cell + step1);
      vec3 c = mix(vec3(0.15, 0.4, 1.0), vec3(1.0, 0.35, 0.2), h);
      c = mix(c, vec3(1.0, 0.95, 0.8), step(0.86, hash(cell * 1.7 + step1)));
      float scan = 0.75 + 0.25 * sin(vUv.y * 60.0 - uTime * 6.0);
      float flash = 0.85 + 0.15 * step(0.9, fract(uTime * 0.37));
      float edge = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x) * smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.9, vUv.y);
      gl_FragColor = vec4(c * vColor * scan * flash * edge, 1.0);
    }
  }
`;

export interface Stadium {
  /** Local to the ring (it follows the camera); add to the backdrop group. */
  group: THREE.Group;
  /** Heading from the camera (unit, x = cos, z = sin). */
  dirX: number;
  dirZ: number;
  /** Per frame with the scene clock (s): the board's picture and the crowd. */
  update(time: number): void;
  /** Per render: which way is right, for the roar's pan. */
  view(camera: THREE.Camera): void;
  dispose(): void;
}

/** Build the stadium of `plan` standing at `spot` (stadiumSpot) on the ring. */
export function buildStadium(seed: number, plan: StadiumPlan, spot: { azimuth: number; base: number }): Stadium {
  const S = STADIUM;
  const sc = plan.scale;
  const a = S.half[0] * sc;
  const b = S.half[1] * sc;
  const H = S.rim * sc;
  const N = 24;
  const group = new THREE.Group();
  group.name = 'stadium';
  const dirX = Math.cos(spot.azimuth);
  const dirZ = Math.sin(spot.azimuth);
  // Local +Z faces the camera at the ring's centre, local X runs across.
  group.position.set(dirX * S.radius, Math.max(-4, spot.base - 5), dirZ * S.radius);
  group.rotation.y = Math.atan2(-dirX, -dirZ);

  // ----- The bowl: bands between rings, each ring an oval at a height share of the rim.
  type C3 = [number, number, number];
  const pos: number[] = [];
  const colors: number[] = [];
  const idx: number[] = [];
  /** Height of the rim at angle `phi`: the far side (z < 0) stands taller. */
  const rimAt = (phi: number): number => H * (1 + S.rake * -Math.sin(phi));
  const vert = (scale: number, frac: number, phi: number, c: C3): number => {
    pos.push(Math.cos(phi) * a * scale, rimAt(phi) * frac, Math.sin(phi) * b * scale);
    colors.push(c[0], c[1], c[2]);
    return pos.length / 3 - 1;
  };
  const band = (s0: number, f0: number, c0: C3, s1: number, f1: number, c1: C3): void => {
    for (let i = 0; i < N; i++) {
      const p0 = (i / N) * Math.PI * 2;
      const p1 = ((i + 1) / N) * Math.PI * 2;
      // A little speckle on the lit tiers: the crowd.
      const v0 = vert(s0, f0, p0, c0);
      const v1 = vert(s0, f0, p1, c0);
      const v2 = vert(s1, f1, p1, c1);
      const v3 = vert(s1, f1, p0, c1);
      idx.push(v0, v1, v2, v0, v2, v3);
    }
  };
  const dark: C3 = [0.012, 0.012, 0.03];
  const wall: C3 = [0.03, 0.028, 0.05];
  const concourse: C3 = [0.7, 0.5, 0.3];
  const roof: C3 = [0.02, 0.02, 0.04];
  const upper: C3 = [0.3, 0.34, 0.5];
  const lower: C3 = [0.6, 0.5, 0.38];
  const pitch: C3 = [0.12, 0.35, 0.16];
  band(1.0, 0, dark, 0.985, 0.4, wall);
  band(0.985, 0.4, concourse, 0.97, 0.6, concourse);
  band(0.97, 0.6, wall, 0.93, 1.0, wall);
  band(0.93, 1.0, roof, 0.8, 1.06, roof);
  band(0.8, 1.06, upper, 0.68, 0.62, upper);
  band(0.68, 0.62, lower, 0.56, 0.3, lower);
  band(0.56, 0.3, pitch, 0.5, 0.22, pitch);

  // Floodlight masts: thin four sided prisms round the bowl; their lamps are in the additive mesh.
  const mastAt: { x: number; z: number }[] = [];
  const corners = plan.masts === 6 ? [0.35, 0.5, 0.65, 0.85, 0, 1.15] : [0.25, 0.75, 1.25, 1.75];
  for (const t of corners) {
    const phi = t * Math.PI + (plan.masts === 6 ? 0 : 0);
    mastAt.push({ x: Math.cos(phi) * a * 1.04, z: Math.sin(phi) * b * 1.04 });
  }
  const mh = S.mast * sc;
  const w = 1.1;
  for (const m of mastAt) {
    const base = pos.length / 3;
    for (const [dx, dz] of [[-w, -w], [w, -w], [w, w], [-w, w]]) {
      pos.push(m.x + dx, 0, m.z + dz);
      colors.push(dark[0], dark[1], dark[2]);
      pos.push(m.x + dx * 0.6, mh, m.z + dz * 0.6);
      colors.push(dark[0], dark[1], dark[2]);
    }
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const b0 = base + k * 2;
      const b1 = base + k2 * 2;
      idx.push(b0, b1, b0 + 1, b1, b1 + 1, b0 + 1);
    }
  }
  const bowl = new THREE.BufferGeometry();
  bowl.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bowl.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  bowl.setIndex(idx);
  const bowlMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const bowlMesh = new THREE.Mesh(bowl, bowlMat);
  bowlMesh.name = 'stadiumBowl';
  bowlMesh.frustumCulled = false;
  bowlMesh.renderOrder = 0;
  group.add(bowlMesh);

  // ----- The lights: camera facing quads (local XY plane) with a kind each.
  const lp: number[] = [];
  const lc: number[] = [];
  const lu: number[] = [];
  const lk: number[] = [];
  const lidx: number[] = [];
  const quad = (cx: number, cy: number, cz: number, w2: number, h2: number, c: C3, kind: number): void => {
    const v = lp.length / 3;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      lp.push(cx + sx * w2 * 0.5, cy + sy * h2 * 0.5, cz);
      lc.push(c[0], c[1], c[2]);
      lu.push((sx + 1) / 2, (sy + 1) / 2);
      lk.push(kind);
    }
    lidx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };
  const lampSize = S.lamp * sc;
  for (const m of mastAt) {
    // Domes: a wide glow behind the lamps, and a smaller bright one.
    quad(m.x, mh + 6 * sc, m.z - 0.5, 150 * sc, 100 * sc, [0.22, 0.2, 0.15], 0);
    quad(m.x, mh, m.z - 0.4, 55 * sc, 40 * sc, [0.4, 0.36, 0.28], 0);
    // The lamp head: a cluster of three.
    for (const dx of [-0.6, 0, 0.6]) for (const dy of [0, -0.55]) quad(m.x + dx * lampSize, mh + dy * lampSize, m.z, lampSize * 0.8, lampSize * 0.8, [3.4, 3.1, 2.6], 1);
  }
  // The bowl's own haze: floodlight in the dust over the pitch.
  quad(0, H * 1.0, -b * 0.3, a * 3.4, H * 3.2, [0.09, 0.08, 0.06], 0);
  // The video board over the far rim, facing the pitch (so the camera).
  quad(0, rimAt(-Math.PI / 2) + 15 * sc, -b * 0.82, 62 * sc, 17 * sc, [0.9, 0.9, 0.9], 2);
  const lights = new THREE.BufferGeometry();
  lights.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lights.setAttribute('aColor', new THREE.Float32BufferAttribute(lc, 3));
  lights.setAttribute('aUv', new THREE.Float32BufferAttribute(lu, 2));
  lights.setAttribute('aKind', new THREE.Float32BufferAttribute(lk, 1));
  lights.setIndex(lidx);
  const lightMat = new THREE.ShaderMaterial({
    vertexShader: lightVert,
    fragmentShader: lightFrag,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const lightMesh = new THREE.Mesh(lights, lightMat);
  lightMesh.name = 'stadiumLights';
  lightMesh.frustumCulled = false;
  lightMesh.renderOrder = 1;
  group.add(lightMesh);

  // ----- The crowd.
  const roars = new RoarSchedule(seed);
  let voice: StadiumRoar | null = null;
  let heard = 0;
  let hornHeard = 0;
  let lastTime = -1;
  const camRight = { x: 1, z: 0 };
  const delay = S.radius / S.sound;
  const pan = (): number => dirX * camRight.x + dirZ * camRight.z;
  const right = new THREE.Vector3();

  return {
    group,
    dirX,
    dirZ,
    update(time) {
      lightMat.uniforms.uTime.value = time;
      // A clock that went back (a restart) starts the schedule over.
      if (time < lastTime - 0.5) {
        heard = 0;
        hornHeard = 0;
      }
      lastTime = time;
      while (true) {
        const r = roars.get(heard);
        if (r.t + delay > time) break;
        // Skipped if the clock jumped well past it.
        if (time - (r.t + delay) < 1) {
          voice ??= StadiumRoar.create();
          voice?.swell(S.radius, r.power, pan(), r.length);
        }
        heard++;
      }
      while (hornHeard < heard + 1) {
        const r = roars.get(hornHeard);
        if (r.horn < 0) {
          hornHeard++;
          continue;
        }
        const at = r.t + r.horn + delay;
        if (at > time) break;
        if (time - at < 1) {
          voice ??= StadiumRoar.create();
          voice?.horn(S.radius, pan());
        }
        hornHeard++;
      }
    },
    view(camera) {
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const l = Math.hypot(right.x, right.z) || 1;
      camRight.x = right.x / l;
      camRight.z = right.z / l;
    },
    dispose() {
      voice?.dispose();
      voice = null;
      group.removeFromParent();
      bowl.dispose();
      bowlMat.dispose();
      lights.dispose();
      lightMat.dispose();
    },
  };
}
