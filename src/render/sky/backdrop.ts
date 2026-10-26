/**
 * Everything at infinity: two low poly mountain silhouette rings (a hazy far
 * ridge and a darker near one) that follow the camera like a skybox, radio
 * masts on the highest peaks (where a harbor faces open water, the `sea`
 * window: the near ridge sinks under the water there and the far one drops to
 * a low far shore strung with the lights of a town across the bay), and the
 * sky sprites: the star field, the moon
 * with its phase (and a halo in haze), the red beacons on the masts, airliners
 * crossing high up as clusters of nav lights and strobes, and the odd meteor.
 * The sprites are one instanced mesh whose vertex shader does all the motion
 * and blinking from the scene clock, so a replay shows the same sky and the
 * CPU only schedules the next meteor. Mood (weather.ts) sets the haze colour
 * baked into the ridges, how many stars show and how the moon looks. Three
 * draw calls: the rings, the masts, the sprites.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { FOG_COLOR } from '../lighting';
import { makeSkySpriteAtlas, SKY_TILES, SKY_TILE_COUNT } from './skyTextures';

export interface BackdropOptions {
  /** Haze colour baked into the ridges (the mood's fog colour). */
  fogColor: number;
  /** Star field, moon disc and moon halo visibility 0..1. */
  stars: number;
  moon: number;
  halo: number;
  /** Moon phase 0..1 (0 new, 0.5 full). */
  moonPhase: number;
  /** City centre (m): airliners cross over it. */
  centerX: number;
  centerZ: number;
  /**
   * Open water (a harbor, render/districts/waterfront.ts harborSea): the directions it fills as seen from
   * the city (ridge angles, rad, x = cos and z = sin, `from` to `to` counterclockwise) and its level (m).
   */
  sea?: { from: number; to: number; level: number };
}

export interface Backdrop {
  group: THREE.Group;
  /** Unit direction of the moon (for cameras that want to look at it). */
  moonDirection(): [number, number, number];
  /** Keep the ring centered on the camera (call before rendering); the viewport height keeps stars a few pixels wide. */
  follow(camera: THREE.Camera, viewportHeight?: number): void;
  update(time: number): void;
  dispose(): void;
}

export const SKY = {
  /** Sprite dome radius (m): beyond both ridges, inside every camera's far plane. */
  radius: 2050,
  stars: { count: 900, minElevation: 0.05, size: [3, 11] as [number, number], minPixels: 1.8 },
  moon: { size: 72, haloSize: 330, elevation: [0.5, 0.95] as [number, number] },
  /** Airliners: how many, cruise speed (m/s), altitude band (m), how far out they start (m) and the share of a period spent crossing. */
  planes: { count: 3, speed: 85, altitude: [650, 900] as [number, number], reach: 1900, crossing: 0.5, period: [150, 260] as [number, number] },
  /**
   * Meteors: one window every `interval` s, each lasting `duration` s, flying `speed` m/s along a
   * dome tangent from `radius` (inside the sprite dome, so the straight flight stays within the
   * chase camera's far plane).
   */
  meteor: { interval: 34, duration: [0.6, 1.1] as [number, number], speed: 900, radius: 1750, size: [60, 110] as [number, number] },
  /** Mast beacons blink on this period (s). */
  beaconPeriod: 1.6,
  /**
   * Across open water: the ridges ease into the window over `feather` rad; the near ridge sinks `sink` m
   * under the water, the far one keeps `shore` of its height (at least `shoreMin` m over the water) as the
   * far shore, with `lights` town lights along its foot, `lightSize` m wide [min, max].
   */
  sea: { feather: 0.2, sink: 6, shore: 0.3, shoreMin: 16, lights: 70, lightSize: [4, 9] as [number, number] },
} as const;

const SEGMENTS = 180;

/** How far into the sea window angle t lies, 0 outside to 1 a feather inside its edges. */
function seaWeight(sea: BackdropOptions['sea'], t: number): number {
  if (!sea) return 0;
  const span = (((sea.to - sea.from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const a = (((t - sea.from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (a > span) return 0;
  const f = SKY.sea.feather;
  const e = Math.min(a, span - a) / f;
  return e >= 1 ? 1 : e * e * (3 - 2 * e);
}

function ridge(rng: Rng, radius: number, base: number, peak: number, rough: number, bottom: THREE.Color, top: THREE.Color, shape?: (t: number, h: number) => number): { geo: THREE.BufferGeometry; heights: number[] } {
  // Sum of a few seeded sines around the circle plus jagged noise: a skyline.
  const waves = Array.from({ length: 5 }, (_, i) => ({ k: [2, 3, 5, 9, 17][i] + rng.int(0, 2), a: rng.range(0.4, 1) / (i + 1), p: rng.range(0, Math.PI * 2) }));
  const heights: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(t * w.k + w.p);
    v = 0.5 + v * 0.35 + (rng.next() - 0.5) * rough;
    const h = base + Math.max(0.05, v) * peak;
    heights.push(shape ? shape(t, h) : h);
  }
  const pos: number[] = [];
  const colors: number[] = [];
  const idx: number[] = [];
  const bottomY = -90;
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    const x = Math.cos(t) * radius;
    const z = Math.sin(t) * radius;
    const h = heights[i % SEGMENTS];
    pos.push(x, bottomY, z, x, h, z);
    colors.push(bottom.r, bottom.g, bottom.b, top.r, top.g, top.b);
    if (i < SEGMENTS) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return { geo, heights };
}

/** An axis aligned box into a builder (masts). */
function box(gb: GeoBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  const face = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], n: [number, number, number]) => {
    const i = gb.vertex(a[0], a[1], a[2], n[0], n[1], n[2], 0, 0);
    const j = gb.vertex(b[0], b[1], b[2], n[0], n[1], n[2], 1, 0);
    const k = gb.vertex(c[0], c[1], c[2], n[0], n[1], n[2], 1, 1);
    const l = gb.vertex(d[0], d[1], d[2], n[0], n[1], n[2], 0, 1);
    gb.quadFacing(i, j, k, l, n[0], n[1], n[2]);
  };
  face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
  face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
  face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
  face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
}

/** Sprite kinds, matched in the vertex shader. */
const KIND = { star: 0, steady: 1, beacon: 2, strobe: 3, meteor: 4, plane: 5, lamp: 6 } as const;

const spriteVert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 iPos;
  attribute vec2 iSize;
  attribute float iTile;
  attribute vec4 iAnim;
  attribute vec3 iAxis;
  attribute vec3 iColor;
  attribute vec4 iExtra;
  uniform float uTime;
  uniform vec3 uGroupPos;
  uniform float uStars;
  uniform float uMoon;
  uniform float uPixel;
  uniform float uTiles;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBright;

  void main() {
    float kind = iAnim.x;
    vec3 center = iPos;
    float bright = 0.0;
    vec2 size = iSize;
    if (kind < 0.5) {
      // Star: slow twinkle with a second, slower shimmer.
      bright = uStars * iAnim.w * (0.7 + 0.3 * sin(uTime * iAnim.z + iAnim.y * 6.2832)) * (0.8 + 0.2 * sin(uTime * iAnim.z * 0.37 + iAnim.y * 13.0));
    } else if (kind < 1.5) {
      bright = iAnim.y * uMoon;
    } else if (kind < 2.5) {
      bright = step(0.5, fract(uTime / iAnim.z + iAnim.y)) > 0.5 ? 1.0 : 0.05;
    } else if (kind < 3.5) {
      float ph = fract(uTime / iAnim.z + iAnim.y);
      bright = (ph < 0.05 || (ph > 0.12 && ph < 0.17)) ? 1.0 : 0.0;
    } else if (kind < 4.5) {
      // Meteor: flies along its axis for its duration from its birth time, bright in the middle.
      float age = uTime - iAnim.y;
      float life = clamp(age / iAnim.z, 0.0, 1.0);
      center = iPos + iAxis * iAnim.w * age;
      bright = (age < 0.0 || age > iAnim.z) ? 0.0 : uStars * sin(life * 3.1416);
      if (bright <= 0.0) size = vec2(0.0);
    } else if (kind > 5.5) {
      // A far shore's town light: steady, whatever the moon does.
      bright = iAnim.y;
    } else {
      // Airliner light: the plane runs its straight path once per period, lights offset in its frame.
      float progress = mod(uTime + iAnim.w, iAnim.z) * iAnim.y;
      float len = iAnim.y * iAnim.z * ${SKY.planes.crossing.toFixed(2)};
      vec3 fwd = iAxis;
      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
      vec3 world = iPos + fwd * progress + fwd * iExtra.x + right * iExtra.y + vec3(0.0, iExtra.z, 0.0);
      center = world - uGroupPos;
      float ph = fract(uTime / 1.25 + iAnim.w * 0.37);
      float blink = iExtra.w < 0.5 ? 1.0 : (iExtra.w < 1.5 ? ((ph < 0.05 || (ph > 0.11 && ph < 0.16)) ? 1.0 : 0.0) : (fract(uTime / 1.9 + iAnim.w) < 0.5 ? 1.0 : 0.0));
      bright = progress > len ? 0.0 : blink;
      if (bright <= 0.0) size = vec2(0.0);
    }
    vec4 mv = modelViewMatrix * vec4(center, 1.0);
    float dist = max(-mv.z, 1.0);
    // Stars and lights keep a minimum on-screen size so they never shimmer in and out.
    float minSize = uPixel * dist * ${SKY.stars.minPixels.toFixed(2)};
    size = max(size, vec2(minSize));
    if (kind > 3.5 && kind < 4.5) {
      // Meteor: a streak along its direction of travel, as seen on screen.
      vec3 ax = (modelViewMatrix * vec4(iAxis, 0.0)).xyz;
      vec2 a2 = normalize(ax.xy + vec2(1e-5, 0.0));
      vec2 perp = vec2(-a2.y, a2.x);
      mv.xy += a2 * corner.x * size.x + perp * corner.y * size.y;
    } else {
      mv.xy += corner * size;
    }
    vUv = vec2(corner.x + 0.5, corner.y + 0.5);
    vUv.x = (vUv.x + iTile) / uTiles;
    vColor = iColor;
    vBright = bright;
    gl_Position = projectionMatrix * mv;
  }
`;

const spriteFrag = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vec3 s = texture2D(uAtlas, vUv).rgb;
    gl_FragColor = vec4(vColor * s * vBright, 1.0);
  }
`;

interface SpriteSpec {
  pos: [number, number, number];
  size: [number, number];
  tile: number;
  anim: [number, number, number, number];
  axis?: [number, number, number];
  color: [number, number, number];
  extra?: [number, number, number, number];
}

export function buildBackdrop(seed: number, opts: BackdropOptions = { fogColor: FOG_COLOR, stars: 1, moon: 1, halo: 0, moonPhase: 0.5, centerX: 0, centerZ: 0 }): Backdrop {
  const rng = new Rng(deriveSeed(seed, 'backdrop'));
  const group = new THREE.Group();
  group.name = 'backdrop';
  const fog = new THREE.Color(opts.fogColor);
  // Ridge tops keep their blue-violet of a clear night, lifted or dimmed with the mood's haze.
  const clear = new THREE.Color(FOG_COLOR);
  const tint = new THREE.Color(fog.r / clear.r, fog.g / clear.g, fog.b / clear.b);
  tint.setRGB(Math.min(2, Math.max(0.6, tint.r)), Math.min(2, Math.max(0.6, tint.g)), Math.min(2, Math.max(0.6, tint.b)));
  // Both sides render: the ring is seen from inside.
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  // Across open water the near ridge sinks under it and the far one is a low far shore.
  const sea = opts.sea;
  const sunk = sea ? (t: number, h: number) => h + (sea.level - SKY.sea.sink - h) * seaWeight(sea, t) : undefined;
  const shore = sea ? (t: number, h: number) => h + (Math.max(sea.level + SKY.sea.shoreMin, h * SKY.sea.shore) - h) * seaWeight(sea, t) : undefined;
  const far = ridge(rng, 1950, 40, 260, 0.08, fog.clone().multiplyScalar(1.1), new THREE.Color(0x2a2448).multiply(tint), shore);
  const near = ridge(rng, 1700, 10, 150, 0.14, fog.clone().multiplyScalar(0.7), new THREE.Color(0x15152c).multiply(tint), sunk);
  const farMesh = new THREE.Mesh(far.geo, mat);
  const nearMesh = new THREE.Mesh(near.geo, mat);
  farMesh.renderOrder = -2;
  nearMesh.renderOrder = -1;
  farMesh.frustumCulled = false;
  nearMesh.frustumCulled = false;
  group.add(farMesh, nearMesh);

  // Radio masts on the highest near peaks: one merged mesh; their beacons are sky sprites.
  const peaks = near.heights
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h - a.h)
    .filter((p, k, all) => all.slice(0, k).every((q) => Math.abs(q.i - p.i) > 10))
    .slice(0, 6);
  const masts = new GeoBuilder();
  const sprites: SpriteSpec[] = [];
  peaks.forEach((p, k) => {
    const t = (p.i / SEGMENTS) * Math.PI * 2;
    const x = Math.cos(t) * 1690;
    const z = Math.sin(t) * 1690;
    // The two tallest get a TV tower with a mid-height beacon too.
    const tall = k < 2 ? 58 : 34;
    box(masts, x, p.h + tall / 2, z, 1.6, tall, 1.6);
    const red: [number, number, number] = [3, 0.2, 0.15];
    sprites.push({ pos: [x, p.h + tall + 2, z], size: [7, 7], tile: SKY_TILES.strobe, anim: [KIND.beacon, rng.next(), SKY.beaconPeriod, 0], color: red });
    if (k < 2) sprites.push({ pos: [x, p.h + tall * 0.55, z], size: [6, 6], tile: SKY_TILES.strobe, anim: [KIND.beacon, rng.next(), SKY.beaconPeriod * 1.3, 0], color: red });
  });
  const mastMat = new THREE.MeshBasicMaterial({ color: 0x0a0b14, fog: false });
  const mastMesh = new THREE.Mesh(masts.build(), mastMat);
  mastMesh.frustumCulled = false;
  group.add(mastMesh);

  // Stars: seeded directions above the ridges, most of them faint.
  const R = SKY.radius;
  for (let i = 0; i < SKY.stars.count; i++) {
    const az = rng.range(0, Math.PI * 2);
    const el = Math.asin(SKY.stars.minElevation + rng.next() * (1 - SKY.stars.minElevation));
    const mag = rng.next() ** 2.2;
    const size = SKY.stars.size[0] + (SKY.stars.size[1] - SKY.stars.size[0]) * mag;
    // Faint blue-white to warm; the brightest a touch of colour.
    const warm = rng.next();
    const col: [number, number, number] = [0.75 + 0.25 * warm, 0.8 + 0.1 * (1 - warm), 0.85 + 0.15 * (1 - warm)];
    sprites.push({
      pos: [Math.cos(az) * Math.cos(el) * R, Math.sin(el) * R, Math.sin(az) * Math.cos(el) * R],
      size: [size, size],
      tile: SKY_TILES.star,
      anim: [KIND.star, rng.next(), rng.range(0.6, 2.4), 0.25 + 1.6 * mag],
      color: col,
    });
  }
  // Moon and its halo.
  const moonDir: [number, number, number] = [0, 1, 0];
  {
    const az = rng.range(0, Math.PI * 2);
    const el = rng.range(SKY.moon.elevation[0], SKY.moon.elevation[1]);
    moonDir[0] = Math.cos(az) * Math.cos(el);
    moonDir[1] = Math.sin(el);
    moonDir[2] = Math.sin(az) * Math.cos(el);
    const pos: [number, number, number] = [moonDir[0] * R, moonDir[1] * R, moonDir[2] * R];
    sprites.push({ pos, size: [SKY.moon.size, SKY.moon.size], tile: SKY_TILES.moon, anim: [KIND.steady, 1.15, 0, 0], color: [1, 0.98, 0.92] });
    if (opts.halo > 0) sprites.push({ pos, size: [SKY.moon.haloSize, SKY.moon.haloSize], tile: SKY_TILES.halo, anim: [KIND.steady, 0.4 * opts.halo, 0, 0], color: [0.75, 0.8, 1] });
  }
  // Airliners: straight crossings over the city, each a cluster of lights on the plane's frame.
  for (let k = 0; k < SKY.planes.count; k++) {
    const az = rng.range(0, Math.PI * 2);
    const alt = rng.range(SKY.planes.altitude[0], SKY.planes.altitude[1]);
    const start: [number, number, number] = [opts.centerX + Math.cos(az) * SKY.planes.reach, alt, opts.centerZ + Math.sin(az) * SKY.planes.reach];
    const turn = az + Math.PI + rng.range(-0.35, 0.35);
    const dir: [number, number, number] = [Math.cos(turn), 0, Math.sin(turn)];
    const period = rng.range(SKY.planes.period[0], SKY.planes.period[1]);
    const phase = rng.range(0, period);
    const anim: [number, number, number, number] = [KIND.plane, SKY.planes.speed, period, phase];
    const light = (extra: [number, number, number, number], color: [number, number, number], size: number) =>
      sprites.push({ pos: start, size: [size, size], tile: SKY_TILES.strobe, anim, axis: dir, color, extra });
    light([0, -17, 0, 0], [2.2, 0.15, 0.1], 9);
    light([0, 17, 0, 0], [0.15, 2.2, 0.3], 9);
    light([-19, 0, 3, 1], [2.5, 2.5, 2.5], 11);
    light([4, 0, -1.5, 2], [2.4, 0.2, 0.1], 8);
  }
  // The far shore's town lights along the foot of the far ridge across the water (a stream of their own).
  if (sea) {
    const srng = new Rng(deriveSeed(seed, 'farShore'));
    const span = (((sea.to - sea.from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    for (let k = 0; k < SKY.sea.lights; k++) {
      const t = sea.from + srng.range(0.1, 0.9) * span;
      if (seaWeight(sea, t) < 0.9) continue;
      const r = 1925;
      const s = srng.range(SKY.sea.lightSize[0], SKY.sea.lightSize[1]);
      const warm = srng.next();
      sprites.push({
        pos: [Math.cos(t) * r, sea.level + srng.range(2, 14), Math.sin(t) * r],
        size: [s, s],
        tile: SKY_TILES.strobe,
        // Dimmer the hazier the night (the mood's star visibility).
        anim: [KIND.lamp, srng.range(0.25, 0.7) * (0.35 + 0.65 * opts.stars), 0, 0],
        color: [1, 0.7 + 0.2 * warm, 0.4 + 0.3 * warm],
      });
    }
  }
  // Two meteor slots the scheduler rewrites.
  const meteorSlot = sprites.length;
  for (let k = 0; k < 2; k++) sprites.push({ pos: [0, R, 0], size: [0, 0], tile: SKY_TILES.meteor, anim: [KIND.meteor, -1e6, 1, 0], axis: [1, 0, 0], color: [1, 0.97, 0.9] });

  const n = sprites.length;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('corner', new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n * 2);
  const tile = new Float32Array(n);
  const anim = new Float32Array(n * 4);
  const axis = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const extra = new Float32Array(n * 4);
  sprites.forEach((s, i) => {
    pos.set(s.pos, i * 3);
    size.set(s.size, i * 2);
    tile[i] = s.tile;
    anim.set(s.anim, i * 4);
    axis.set(s.axis ?? [0, 0, 0], i * 3);
    color.set(s.color, i * 3);
    extra.set(s.extra ?? [0, 0, 0, 0], i * 4);
  });
  const iPos = new THREE.InstancedBufferAttribute(pos, 3);
  const iAnim = new THREE.InstancedBufferAttribute(anim, 4);
  const iSize = new THREE.InstancedBufferAttribute(size, 2);
  const iAxis = new THREE.InstancedBufferAttribute(axis, 3);
  for (const a of [iPos, iAnim, iSize, iAxis]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iSize', iSize);
  geo.setAttribute('iTile', new THREE.InstancedBufferAttribute(tile, 1));
  geo.setAttribute('iAnim', iAnim);
  geo.setAttribute('iAxis', iAxis);
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(color, 3));
  geo.setAttribute('iExtra', new THREE.InstancedBufferAttribute(extra, 4));
  geo.instanceCount = n;
  const atlas = makeSkySpriteAtlas(opts.moonPhase, seed);
  const spriteMat = new THREE.ShaderMaterial({
    vertexShader: spriteVert,
    fragmentShader: spriteFrag,
    uniforms: {
      uTime: { value: 0 },
      uGroupPos: { value: new THREE.Vector3() },
      uStars: { value: opts.stars },
      uMoon: { value: opts.moon },
      uPixel: { value: 0.002 },
      uTiles: { value: SKY_TILE_COUNT },
      uAtlas: { value: atlas },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const spriteMesh = new THREE.Mesh(geo, spriteMat);
  spriteMesh.name = 'skySprites';
  spriteMesh.frustumCulled = false;
  group.add(spriteMesh);

  // Meteors: window k opens at a seeded moment inside its interval; the shader flies it.
  const mrng = new Rng(deriveSeed(seed, 'meteors'));
  const mseed = mrng.int(1, 0x7fffffff);
  let scheduled = -1;
  const hash = (k: number, salt: number) => {
    let h = Math.imul(k + 1, 0x27d4eb2d) ^ Math.imul(mseed, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  const schedule = (time: number): void => {
    const k = Math.floor(time / SKY.meteor.interval);
    if (k === scheduled || opts.stars <= 0) return;
    scheduled = k;
    const slot = meteorSlot + (k % 2);
    const start = k * SKY.meteor.interval + hash(k, 0) * SKY.meteor.interval * 0.7;
    const dur = SKY.meteor.duration[0] + hash(k, 1) * (SKY.meteor.duration[1] - SKY.meteor.duration[0]);
    const az = hash(k, 2) * Math.PI * 2;
    const el = 0.35 + hash(k, 3) * 0.8;
    const sx = Math.cos(az) * Math.cos(el);
    const sy = Math.sin(el);
    const sz = Math.sin(az) * Math.cos(el);
    // Fly along a dome tangent: mostly downward, slanted by a seeded angle.
    const east = [-Math.sin(az), 0, Math.cos(az)];
    const down = [-Math.cos(az) * Math.sin(el), Math.cos(el), -Math.sin(az) * Math.sin(el)].map((v) => -v);
    const slant = (hash(k, 4) - 0.5) * 1.6;
    const ax = [east[0] * Math.sin(slant) + down[0] * Math.cos(slant), east[1] * Math.sin(slant) + down[1] * Math.cos(slant), east[2] * Math.sin(slant) + down[2] * Math.cos(slant)];
    const s = SKY.meteor.size[0] + hash(k, 5) * (SKY.meteor.size[1] - SKY.meteor.size[0]);
    const Rm = SKY.meteor.radius;
    iPos.setXYZ(slot, sx * Rm, sy * Rm, sz * Rm);
    iAxis.setXYZ(slot, ax[0], ax[1], ax[2]);
    iAnim.setXYZW(slot, KIND.meteor, start, dur, SKY.meteor.speed);
    iSize.setXY(slot, s * 4, s * 0.5);
    for (const a of [iPos, iAxis, iAnim, iSize]) a.needsUpdate = true;
  };

  return {
    group,
    moonDirection: () => moonDir,
    follow(camera, viewportHeight = 720) {
      camera.getWorldPosition(spriteMat.uniforms.uGroupPos.value as THREE.Vector3);
      const p = spriteMat.uniforms.uGroupPos.value as THREE.Vector3;
      p.y = 0;
      group.position.copy(p);
      const cam = camera as THREE.PerspectiveCamera;
      const fov = cam.isPerspectiveCamera ? cam.fov : 60;
      spriteMat.uniforms.uPixel.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
    },
    update(time) {
      spriteMat.uniforms.uTime.value = time;
      schedule(time);
    },
    dispose() {
      far.geo.dispose();
      near.geo.dispose();
      mat.dispose();
      mastMat.dispose();
      mastMesh.geometry.dispose();
      geo.dispose();
      spriteMat.dispose();
      atlas.dispose();
    },
  };
}
