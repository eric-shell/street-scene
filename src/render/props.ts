/**
 * Street furniture: streetlights, traffic lights, garbage cans, benches and
 * bus stops from CityBlocks.props, instanced per kind and part. Traffic
 * signals cycle red / amber / green in a shader (per intersection offset,
 * crossing directions out of phase), so they cost nothing on the CPU.
 *
 * Destruction mirrors RaceState.brokenProps: a broken prop's intact instances
 * collapse to zero scale (poles leave a stump), its light goes out, and its
 * parts break apart as pooled debris pushed along by the car that hit it.
 * Because the state is read back every frame from the sim's flags, a new
 * session (restart, replay) always starts consistent. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { Prop } from '../city/props';
import { GeoBuilder } from './geoBuilder';
import { FOG_DENSITY } from './lighting';
import { fadeSubPixel } from './lightFx';
import { D_BOX, D_CYL, D_GLASS, D_GLOW, Debris, DebrisType } from './debris';

/** Streetlight pole height and arm reach (lamp heads sit at the arm end). Matches cityMeshes lampPositions. */
export const STREETLIGHT_POLE_H = 8.2;
export const STREETLIGHT_ARM = 2.4;
const STUMP_H = 0.55;
const TRAFFIC_POLE_H = 5.6;
const TRAFFIC_ARM_Y = 5.25;
/** Signal cycle in seconds: green 0-9, amber 9-11, red 11-24 (the crossing direction is offset by half). */
const CYCLE = 24;

export interface CarMotion {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface PropRenderer {
  group: THREE.Group;
  /**
   * Mirror the sim's broken flags. Props that broke since the last call come
   * apart, pushed by the nearest car. Cheap when nothing changed.
   */
  update(dt: number, time: number, broken: ArrayLike<number> | undefined, cars: readonly CarMotion[]): void;
  dispose(): void;
}

export interface PropRendererOptions {
  /** Streetlight `light` index switched off (broken) or back on. */
  onLamp?(light: number, on: boolean): void;
}

// ---------------------------------------------------------------------------
// Low poly part builders (local space, vertex colored)
// ---------------------------------------------------------------------------

function box(gb: GeoBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color, skipBottom = true): void {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const face = (n: [number, number, number], pts: [number, number, number][]) => {
    const v = pts.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], 0, 0, color));
    gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
  };
  face([1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]);
  face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  face([0, 0, -1], [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]);
  face([0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
  if (!skipBottom) face([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
}

/** Vertical tapered cylinder from y0 to y1 with a top cap. */
function cyl(gb: GeoBuilder, cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, seg: number, color: THREE.Color): void {
  const ring: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    ring.push(gb.vertex(cx + nx * r0, y0, cz + nz * r0, nx, 0, nz, 0, 0, color), gb.vertex(cx + nx * r1, y1, cz + nz * r1, nx, 0, nz, 0, 0, color));
  }
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2 + Math.PI / seg;
    gb.quadFacing(ring[k * 2], ring[k * 2 + 2], ring[k * 2 + 3], ring[k * 2 + 1], Math.cos(a), 0, Math.sin(a));
  }
  const c = gb.vertex(cx, y1, cz, 0, 1, 0, 0, 0, color);
  const top: number[] = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    top.push(gb.vertex(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, 0, 1, 0, 0, 0, color));
  }
  for (let k = 0; k < seg; k++) gb.triFacing(c, top[k], top[(k + 1) % seg], 0, 1, 0);
}

const col = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);

function streetlightGeo(): { solid: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
  const s = new GeoBuilder(true);
  const metal = col(0x2a2c33);
  const H = STREETLIGHT_POLE_H;
  const A = STREETLIGHT_ARM;
  box(s, 0, 0.2, 0, 0.34, 0.4, 0.34, col(0x1c1d22));
  cyl(s, 0, 0, 0, H, 0.13, 0.09, 6, metal);
  box(s, 0, H - 0.1, A / 2, 0.1, 0.1, A, metal);
  box(s, 0, H - 0.25, A, 0.45, 0.16, 0.9, metal, false);
  const l = new GeoBuilder(true);
  box(l, 0, H - 0.34, A, 0.36, 0.04, 0.75, col(0xffc27a, 4), false);
  return { solid: s.build(), lens: l.build() };
}

function stumpGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.2, 0, 0.34, 0.4, 0.34, col(0x1c1d22));
  cyl(s, 0, 0, 0, STUMP_H, 0.14, 0.12, 6, col(0x2a2c33));
  // Torn top: a few bent shards.
  box(s, 0.05, STUMP_H + 0.06, 0.02, 0.05, 0.16, 0.08, col(0x3a3c44));
  box(s, -0.06, STUMP_H + 0.03, -0.04, 0.06, 0.1, 0.05, col(0x3a3c44));
  return s.build();
}

function trafficPoleGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const metal = col(0x3a3d44);
  box(s, 0, 0.2, 0, 0.4, 0.4, 0.4, col(0x1c1d22));
  cyl(s, 0, 0, 0, TRAFFIC_POLE_H, 0.15, 0.11, 7, metal);
  return s.build();
}

/** Unit mast arm along +X (scaled per instance to reach over the lanes). */
function trafficArmGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0.5, 0, 0, 1, 0.12, 0.12, col(0x3a3d44), false);
  return s.build();
}

/** Signal head facing +Z, centered on its middle lens. */
function trafficHeadGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0, -0.17, 0.62, 1.22, 0.03, col(0xb08a1a, 0.55), false); // backplate
  box(s, 0, 0, 0, 0.36, 1.0, 0.3, col(0x15161a), false);
  for (const y of [0.3, 0, -0.3]) box(s, 0, y + 0.13, 0.22, 0.3, 0.03, 0.16, col(0x101114), false); // visors
  box(s, 0, 0.56, 0, 0.06, 0.12, 0.06, col(0x2a2c33)); // hanger
  return s.build();
}

/** Three lens discs on the head's +Z face; aSlot 0 = red (top), 1 = amber, 2 = green. */
function trafficLensGeo(): THREE.BufferGeometry {
  const pos: number[] = [];
  const slot: number[] = [];
  const idx: number[] = [];
  const seg = 10;
  const r = 0.115;
  [0.3, 0, -0.3].forEach((y, k) => {
    const c = pos.length / 3;
    pos.push(0, y, 0.152);
    slot.push(k);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y + Math.sin(a) * r, 0.152);
      slot.push(k);
    }
    for (let i = 0; i < seg; i++) idx.push(c, c + 1 + i, c + 1 + ((i + 1) % seg));
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSlot', new THREE.Float32BufferAttribute(slot, 1));
  g.setIndex(idx);
  return g;
}

function canGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, 0, 0.9, 0.27, 0.31, 8, col(0xa8b0b0));
  cyl(s, 0, 0, 0.55, 0.62, 0.315, 0.315, 8, col(0x55595e));
  cyl(s, 0, 0, 0.9, 0.97, 0.335, 0.3, 8, col(0x30343a));
  return s.build();
}

function benchGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const wood = col(0x7a5434);
  const iron = col(0x1a1b1f);
  for (const z of [-0.14, 0, 0.14]) box(s, 0, 0.46, z, 1.8, 0.04, 0.12, wood, false);
  for (const y of [0.64, 0.82]) box(s, 0, y, -0.25, 1.8, 0.13, 0.04, wood, false);
  for (const x of [-0.75, 0.75]) {
    box(s, x, 0.22, 0, 0.06, 0.44, 0.44, iron);
    box(s, x, 0.66, -0.28, 0.06, 0.5, 0.05, iron);
    box(s, x, 0.62, 0.05, 0.06, 0.04, 0.4, iron);
  }
  return s.build();
}

function busStopGeo(): { solid: THREE.BufferGeometry; glass: THREE.BufferGeometry; ad: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const s = new GeoBuilder(true);
  const frame = col(0x2b2e36);
  for (const x of [-1.55, 1.55]) for (const z of [-0.62, 0.6]) box(s, x, 1.24, z, 0.08, 2.48, 0.08, frame);
  box(s, 0, 2.52, 0.04, 3.5, 0.1, 1.72, frame, false);
  box(s, 0, 2.38, -0.62, 3.1, 0.06, 0.06, frame);
  box(s, 0, 0.22, -0.62, 3.1, 0.06, 0.06, frame);
  // Ad box at the +X end and a bench along the back.
  box(s, 1.55, 1.25, -0.02, 0.16, 2.0, 1.16, col(0x1a1c22));
  box(s, -0.2, 0.46, -0.4, 2.4, 0.05, 0.38, col(0x8a9099));
  for (const x of [-1.2, 0.8]) box(s, x, 0.22, -0.4, 0.06, 0.44, 0.3, frame);
  const g = new GeoBuilder();
  box(g, 0, 1.3, -0.62, 3.02, 2.1, 0.025, col(0xffffff), false);
  box(g, -1.55, 1.3, -0.12, 0.025, 2.1, 0.92, col(0xffffff), false);
  // Lit poster on both faces of the ad box.
  const ad = new GeoBuilder();
  for (const side of [1, -1]) {
    const x = 1.55 + side * 0.082;
    const v = [
      [-0.5, 0.35, 0, 0],
      [0.46, 0.35, 1, 0],
      [0.46, 2.15, 1, 1],
      [-0.5, 2.15, 0, 1],
    ].map(([z, y, u, vv]) => ad.vertex(x, y, z * side, side, 0, 0, u, vv));
    ad.quadFacing(v[0], v[1], v[2], v[3], side, 0, 0);
  }
  // Cool light strip under the roof's front edge.
  const glow = new GeoBuilder(true);
  box(glow, 0, 2.455, 0.82, 3.2, 0.03, 0.05, col(0xcfe6ff, 2.4), false);
  return { solid: s.build(), glass: g.build(), ad: ad.build(), glow: glow.build() };
}

function adTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const gr = ctx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.55, '#8a8a96');
  gr.addColorStop(1, '#2a2a34');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(W / 2, H * 0.36, W * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1a22';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NIGHT', W / 2, H * 0.72);
  ctx.fillText('RUN', W / 2, H * 0.82);
  ctx.fillRect(14, H * 0.88, W - 28, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const lensVert = /* glsl */ `
  attribute float aSlot;
  attribute float aOffset;
  varying float vSlot;
  varying float vLit;
  varying float vFog;
  varying vec3 vView;
  uniform float time;
  uniform float fogDensity;
  void main() {
    vSlot = aSlot;
    float t = mod(time + aOffset, ${CYCLE.toFixed(1)});
    float state = t < 9.0 ? 2.0 : (t < 11.0 ? 1.0 : 0.0);
    vLit = 1.0 - step(0.5, abs(state - aSlot));
    vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const lensFrag = /* glsl */ `
  varying float vSlot;
  varying float vLit;
  varying float vFog;
  varying vec3 vView;
  void main() {
    // Fade sub pixel lenses instead of letting them pop (see fadeSubPixel in lightFx).
    float px = clamp(0.23 / (2.0 * max(length(fwidth(vView)), 1e-5)), 0.25, 1.0);
    vec3 c = vSlot < 0.5 ? vec3(1.0, 0.05, 0.03) : (vSlot < 1.5 ? vec3(1.0, 0.5, 0.04) : vec3(0.08, 1.0, 0.45));
    gl_FragColor = vec4(c * mix(0.045, 3.4 * px, vLit) * vFog, 1.0);
  }
`;

// ---------------------------------------------------------------------------

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const CAN_TINTS = [0x2f6a46, 0x2f6a46, 0x5a6068, 0x34507a, 0x7a3a2a].map((c) => new THREE.Color(c));
const AD_TINTS = [0xff3df2, 0x19e6ff, 0xffb020, 0x7cff6a, 0xffffff, 0xff4060].map((c) => new THREE.Color(c).multiplyScalar(1.5));

interface PartRef {
  mesh: number;
  index: number;
}

interface TrafficFrame {
  /** Unit arm direction (over the served road) and its length. */
  ax: number;
  az: number;
  len: number;
  /** Head facings (unit): arm heads face fa, the pole head faces fb. */
  fax: number;
  faz: number;
  fbx: number;
  fbz: number;
}

/** Direction helpers: local +Z of yaw is (sin, cos), local +X is (cos, -sin). */
const yawOf = (x: number, z: number) => Math.atan2(x, z);

export function buildProps(world: World, opts: PropRendererOptions = {}): PropRenderer {
  const group = new THREE.Group();
  group.name = 'props';
  const props: Prop[] = world.blocks.props ?? [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const solidMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 }));
  const glowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const lampLensMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  fadeSubPixel(lampLensMat, 0.36, 0.25);
  fadeSubPixel(glowMat, 0.05, 0.3);
  const glassMat = track(new THREE.MeshStandardMaterial({ color: 0x9fc6e0, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6 }));
  const adMat = track(new THREE.MeshBasicMaterial({ map: track(adTexture()) }));
  const lensMat = track(
    new THREE.ShaderMaterial({ vertexShader: lensVert, fragmentShader: lensFrag, uniforms: { time: { value: 0 }, fogDensity: { value: FOG_DENSITY } } }),
  );

  const byKind = (k: Prop['kind']) => props.filter((p) => p.kind === k);
  const lights = byKind('streetlight');
  const traffic = byKind('trafficLight');
  const cans = byKind('garbageCan');
  const benches = byKind('bench');
  const stops = byKind('busStop');

  const meshes: THREE.InstancedMesh[] = [];
  const parts: PartRef[][] = props.map(() => []);
  const stumpOf = new Int32Array(props.length).fill(-1);
  const addMesh = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, count: number): number => {
    const m = new THREE.InstancedMesh(track(geo), mat, Math.max(1, count));
    m.count = count;
    m.name = name;
    meshes.push(m);
    if (count > 0) group.add(m);
    return meshes.length - 1;
  };
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const place = (mesh: number, index: number, p: Prop | null, x: number, y: number, z: number, yaw: number, sx = 1): void => {
    quat.setFromAxisAngle(up, yaw);
    pos.set(x, y, z);
    scl.set(sx, 1, 1);
    mat4.compose(pos, quat, scl);
    meshes[mesh].setMatrixAt(index, mat4);
    if (p) parts[p.id].push({ mesh, index });
  };

  // Streetlights.
  {
    const geo = streetlightGeo();
    const solid = addMesh('streetlightPoles', geo.solid, solidMat, lights.length);
    const lens = addMesh('streetlightLenses', geo.lens, lampLensMat, lights.length);
    lights.forEach((p, i) => {
      place(solid, i, p, p.x, p.y, p.z, p.yaw);
      place(lens, i, p, p.x, p.y, p.z, p.yaw);
    });
  }

  // Traffic lights: each serves the road on one side of its corner with a mast
  // arm and two hanging heads, plus a pole mounted head for the other road.
  const frames: TrafficFrame[] = traffic.map((p) => trafficFrame(world, p));
  const lensOffsets = new Float32Array(traffic.length * 3);
  {
    const pole = addMesh('trafficPoles', trafficPoleGeo(), solidMat, traffic.length);
    const arm = addMesh('trafficArms', trafficArmGeo(), solidMat, traffic.length);
    const head = addMesh('trafficHeads', trafficHeadGeo(), solidMat, traffic.length * 3);
    const lens = addMesh('trafficLenses', trafficLensGeo(), lensMat, traffic.length * 3);
    traffic.forEach((p, i) => {
      const f = frames[i];
      place(pole, i, p, p.x, p.y, p.z, p.yaw);
      place(arm, i, p, p.x, p.y + TRAFFIC_ARM_Y, p.z, Math.atan2(-f.az, f.ax), f.len);
      const ya = yawOf(f.fax, f.faz);
      const yb = yawOf(f.fbx, f.fbz);
      const heads: [number, number, number, number][] = [
        [p.x + f.ax * f.len * 0.55, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * 0.55, ya],
        [p.x + f.ax * f.len * 0.92, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * 0.92, ya],
        [p.x + f.fbx * 0.32, p.y + 3.1, p.z + f.fbz * 0.32, yb],
      ];
      // Per intersection offset; the direction crossing the reference axis runs half a cycle later.
      const node = p.node ?? -1;
      const base = node >= 0 ? hash01(node * 7919 + world.seed) * CYCLE : 0;
      const ref = node >= 0 ? nodeAxis(world, node) : 0;
      heads.forEach(([x, y, z, yaw], k) => {
        place(head, i * 3 + k, p, x, y, z, yaw);
        place(lens, i * 3 + k, p, x, y, z, yaw);
        const fx = k < 2 ? f.fax : f.fbx;
        const fz = k < 2 ? f.faz : f.fbz;
        let d = Math.abs(Math.atan2(fx, fz) - ref) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        lensOffsets[i * 3 + k] = base + (d > Math.PI / 4 ? CYCLE / 2 : 0);
      });
    });
    meshes[lens].geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(lensOffsets, 1));
    meshes[lens].frustumCulled = false;
  }

  // Stumps left behind by broken poles (hidden until needed).
  const poles = [...lights, ...traffic];
  const stump = addMesh('propStumps', stumpGeo(), solidMat, poles.length);
  poles.forEach((p, i) => {
    stumpOf[p.id] = i;
    meshes[stump].setMatrixAt(i, ZERO);
  });

  // Garbage cans, tinted per instance.
  {
    const m = addMesh('garbageCans', canGeo(), solidMat, cans.length);
    cans.forEach((p, i) => {
      place(m, i, p, p.x, p.y, p.z, p.yaw + hash01(p.id) * 6.28);
      meshes[m].setColorAt(i, CAN_TINTS[(hash01(p.id * 31) * CAN_TINTS.length) | 0]);
    });
  }
  {
    const m = addMesh('benches', benchGeo(), solidMat, benches.length);
    benches.forEach((p, i) => place(m, i, p, p.x, p.y, p.z, p.yaw));
  }
  const adTint: THREE.Color[] = [];
  {
    const geo = busStopGeo();
    const solid = addMesh('busStops', geo.solid, solidMat, stops.length);
    const glass = addMesh('busStopGlass', geo.glass, glassMat, stops.length);
    const ad = addMesh('busStopAds', geo.ad, adMat, stops.length);
    const glow = addMesh('busStopLights', geo.glow, glowMat, stops.length);
    meshes[glass].renderOrder = 4;
    stops.forEach((p, i) => {
      for (const m of [solid, glass, ad, glow]) place(m, i, p, p.x, p.y, p.z, p.yaw);
      const tint = AD_TINTS[(hash01(p.id * 13) * AD_TINTS.length) | 0];
      meshes[ad].setColorAt(i, tint);
      adTint[p.id] = tint;
    });
  }

  // Keep the intact matrices so a prop can be restored.
  const intact = meshes.map((m) => (m.instanceMatrix.array as Float32Array).slice());
  const stumpBase = new Float32Array(poles.length * 16);
  poles.forEach((p, i) => {
    quat.setFromAxisAngle(up, p.yaw);
    mat4.compose(pos.set(p.x, p.y, p.z), quat, scl.set(1, 1, 1));
    mat4.toArray(stumpBase, i * 16);
  });

  const debris = new Debris(world.heightAt);
  group.add(debris.group);
  const shown = new Uint8Array(props.length);
  const tmpC = new THREE.Color();

  const setBroken = (p: Prop, broken: boolean) => {
    for (const r of parts[p.id]) {
      const m = meshes[r.mesh];
      if (broken) m.setMatrixAt(r.index, ZERO);
      else (m.instanceMatrix.array as Float32Array).set(intact[r.mesh].subarray(r.index * 16, r.index * 16 + 16), r.index * 16);
      m.instanceMatrix.needsUpdate = true;
    }
    const s = stumpOf[p.id];
    if (s >= 0) {
      const m = meshes[stump];
      if (broken) (m.instanceMatrix.array as Float32Array).set(stumpBase.subarray(s * 16, s * 16 + 16), s * 16);
      else m.setMatrixAt(s, ZERO);
      m.instanceMatrix.needsUpdate = true;
    }
    if (p.kind === 'streetlight') opts.onLamp?.(p.light ?? p.id, !broken);
  };

  // ---------- Debris ----------
  /** World position of a local offset in a yaw frame. */
  const wx = (p: Prop, yaw: number, lx: number, lz: number) => p.x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
  const wz = (p: Prop, yaw: number, lx: number, lz: number) => p.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  const shatter = (p: Prop, hitVx: number, hitVz: number) => {
    let speed = Math.hypot(hitVx, hitVz);
    let dx: number;
    let dz: number;
    if (speed > 0.5) {
      dx = hitVx / speed;
      dz = hitVz / speed;
    } else {
      // No car nearby (or a slow nudge): fall away from the road.
      dx = -Math.sin(p.yaw);
      dz = -Math.cos(p.yaw);
      speed = 4;
    }
    speed = Math.min(speed, 38);
    const spawn = (
      type: DebrisType,
      lx: number,
      ly: number,
      lz: number,
      yaw: number,
      hx: number,
      hy: number,
      hz: number,
      push: number,
      lift: number,
      spin: number,
      color: THREE.Color,
      life = rnd(4, 5.5),
      sparky = false,
    ) =>
      debris.spawn({
        type,
        x: wx(p, p.yaw, lx, lz),
        y: p.y + ly,
        z: wz(p, p.yaw, lx, lz),
        yaw,
        hx,
        hy,
        hz,
        vx: dx * speed * push + rnd(-1, 1) * (1 + speed * 0.05),
        vy: lift,
        vz: dz * speed * push + rnd(-1, 1) * (1 + speed * 0.05),
        wx: rnd(-spin, spin),
        wy: rnd(-spin, spin),
        wz: rnd(-spin, spin),
        color,
        life,
        sparky,
        bounce: type === D_GLASS ? 0.12 : 0.25,
      });

    if (p.kind === 'streetlight' || p.kind === 'trafficLight') {
      const isLamp = p.kind === 'streetlight';
      const H = isLamp ? STREETLIGHT_POLE_H : TRAFFIC_POLE_H;
      const len = H - STUMP_H;
      // The pole topples about its broken base, top falling along the hit direction.
      const ox = p.x;
      const oz = p.z;
      const oy = p.y + STUMP_H + len / 2;
      const vx = dx * speed * 0.2;
      const vz = dz * speed * 0.2;
      const vy = 0.6 + speed * 0.04;
      const w = 0.3 + speed * 0.03;
      const twx = dz * w;
      const twz = -dx * w;
      const twy = rnd(-0.4, 0.4);
      const metal = col(isLamp ? 0x2a2c33 : 0x3a3d44);
      debris.spawn({ type: D_CYL, x: ox, y: oy, z: oz, yaw: p.yaw, hx: 0.12, hy: len / 2, hz: 0.12, vx, vy, vz, wx: twx, wy: twy, wz: twz, color: metal, life: rnd(5.5, 6.5), sparky: true });
      // Parts at the top start with the pole's rigid velocity, then fly loose.
      const attached = (type: DebrisType, x: number, y: number, z: number, yaw: number, hx: number, hy: number, hz: number, color: THREE.Color, life: number, kick = 0) => {
        const rx = x - ox;
        const ry = y - oy;
        const rz = z - oz;
        debris.spawn({
          type,
          x,
          y,
          z,
          yaw,
          hx,
          hy,
          hz,
          vx: vx + (twy * rz - twz * ry) + rnd(-kick, kick),
          vy: vy + (twz * rx - twx * rz) + rnd(0, kick),
          vz: vz + (twx * ry - twy * rx) + rnd(-kick, kick),
          wx: rnd(-2, 2),
          wy: rnd(-2, 2),
          wz: rnd(-2, 2),
          color,
          life,
          sparky: type !== D_GLASS,
          bounce: type === D_GLASS ? 0.12 : 0.25,
        });
      };
      if (isLamp) {
        const A = STREETLIGHT_ARM;
        const fx = Math.sin(p.yaw);
        const fz = Math.cos(p.yaw);
        attached(D_BOX, p.x + fx * A * 0.5, p.y + H - 0.1, p.z + fz * A * 0.5, p.yaw, 0.05, 0.05, A / 2, metal, rnd(5, 6));
        attached(D_BOX, p.x + fx * A, p.y + H - 0.25, p.z + fz * A, p.yaw, 0.225, 0.08, 0.45, metal, rnd(5, 6), 0.5);
        attached(D_GLOW, p.x + fx * A, p.y + H - 0.36, p.z + fz * A, p.yaw, 0.17, 0.02, 0.33, col(0xffc27a, 3), rnd(4, 5), 1.5);
        for (let k = 0; k < 7; k++) attached(D_GLASS, p.x + fx * A + rnd(-0.2, 0.2), p.y + H - 0.36, p.z + fz * A + rnd(-0.3, 0.3), rnd(0, 6.28), rnd(0.04, 0.1), 0.008, rnd(0.04, 0.12), col(0xfff0d8), rnd(2.5, 4), 3);
        debris.burst(p.x + fx * A, p.y + H - 0.35, p.z + fz * A, dx, dz, 3, 14);
      } else {
        const f = frames[traffic.indexOf(p)];
        if (f) {
          const ay = Math.atan2(-f.az, f.ax);
          attached(D_BOX, p.x + f.ax * f.len * 0.5, p.y + TRAFFIC_ARM_Y, p.z + f.az * f.len * 0.5, ay, f.len / 2, 0.06, 0.06, metal, rnd(5, 6));
          const ya = yawOf(f.fax, f.faz);
          for (const t of [0.55, 0.92]) attached(D_BOX, p.x + f.ax * f.len * t, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * t, ya, 0.18, 0.5, 0.15, col(0x15161a), rnd(5, 6), 1);
          attached(D_BOX, p.x + f.fbx * 0.32, p.y + 3.1, p.z + f.fbz * 0.32, yawOf(f.fbx, f.fbz), 0.18, 0.5, 0.15, col(0x15161a), rnd(5, 6), 1);
          const lensCols = [col(0xff1a10, 3), col(0xff8a10, 3), col(0x20ff80, 3)];
          for (let k = 0; k < 5; k++) {
            const t = rnd(0.5, 0.95);
            attached(D_GLOW, p.x + f.ax * f.len * t, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * t, rnd(0, 6.28), 0.06, 0.06, 0.012, lensCols[k % 3], rnd(2.5, 4), 3);
          }
          debris.burst(p.x + f.ax * f.len * 0.7, p.y + TRAFFIC_ARM_Y - 0.6, p.z + f.az * f.len * 0.7, dx, dz, 2, 10);
        }
      }
      // Sparks where the car sheared the pole off.
      debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.45 + 3, 26);
      return;
    }

    if (p.kind === 'garbageCan') {
      const tint = CAN_TINTS[(hash01(p.id * 31) * CAN_TINTS.length) | 0];
      spawn(D_CYL, 0, 0.46, 0, 0, 0.3, 0.45, 0.3, rnd(0.6, 0.8), 2 + speed * 0.12, 7, tmpC.copy(tint).multiplyScalar(0.7));
      spawn(D_CYL, 0, 0.95, 0, 0, 0.33, 0.035, 0.33, rnd(0.6, 0.9), 3.5 + speed * 0.16, 12, col(0x30343a));
      const trash = [0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a, 0xe8e0a0, 0x505a68];
      for (let k = 0; k < 9; k++) {
        const s = rnd(0.04, 0.11);
        spawn(D_BOX, rnd(-0.2, 0.2), rnd(0.3, 0.8), rnd(-0.2, 0.2), rnd(0, 6.28), s, s * rnd(0.3, 1), s * rnd(0.5, 1.4), rnd(0.35, 0.8), rnd(1.5, 4.5) + speed * 0.05, 10, col(trash[k % trash.length]), rnd(3, 4.5));
      }
      return;
    }

    if (p.kind === 'bench') {
      const wood = col(0x7a5434);
      const iron = col(0x1a1b1f);
      for (const z of [-0.14, 0, 0.14]) spawn(D_BOX, rnd(-0.1, 0.1), 0.46, z, p.yaw + rnd(-0.2, 0.2), 0.9, 0.02, 0.06, rnd(0.45, 0.7), rnd(1.5, 3.5) + speed * 0.06, 5, wood);
      for (const y of [0.64, 0.82]) spawn(D_BOX, rnd(-0.1, 0.1), y, -0.25, p.yaw + rnd(-0.2, 0.2), 0.9, 0.065, 0.02, rnd(0.45, 0.7), rnd(2, 4) + speed * 0.06, 5, wood);
      for (const x of [-0.75, 0.75]) spawn(D_BOX, x, 0.35, 0, p.yaw, 0.03, 0.33, 0.22, rnd(0.4, 0.6), rnd(1, 3), 6, iron, rnd(4, 5.5), true);
      debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.3 + 2, 8);
      return;
    }

    if (p.kind === 'busStop') {
      const frame = col(0x2b2e36);
      spawn(D_BOX, 0, 2.52, 0.04, p.yaw + rnd(-0.1, 0.1), 1.75, 0.05, 0.86, rnd(0.2, 0.35), rnd(1.5, 3), 1.5, frame, rnd(5, 6), true);
      for (const x of [-1.55, 1.55]) for (const z of [-0.62, 0.6]) spawn(D_BOX, x, 1.24, z, p.yaw, 0.04, 1.22, 0.04, rnd(0.3, 0.6), rnd(1, 3), 4, frame, rnd(4.5, 6), true);
      spawn(D_GLOW, 1.55, 1.25, -0.02, p.yaw, 0.08, 0.95, 0.56, rnd(0.3, 0.5), rnd(1, 2.5), 3, (adTint[p.id] ?? AD_TINTS[0]).clone());
      spawn(D_BOX, -0.2, 0.46, -0.4, p.yaw + rnd(-0.2, 0.2), 1.2, 0.03, 0.19, rnd(0.4, 0.6), rnd(1, 3), 3, col(0x8a9099));
      const glass = col(0xbfe0ff);
      for (let k = 0; k < 28; k++) {
        const back = k < 20;
        const lx = back ? rnd(-1.5, 1.5) : -1.55;
        const lz = back ? -0.62 : rnd(-0.55, 0.3);
        spawn(D_GLASS, lx, rnd(0.3, 2.3), lz, rnd(0, 6.28), rnd(0.06, 0.2), rnd(0.06, 0.2), 0.008, rnd(0.25, 0.75), rnd(0.5, 3.5), 9, glass, rnd(2.5, 4));
      }
      debris.burst(p.x, p.y + 1.2, p.z, dx, dz, speed * 0.3 + 2, 12);
    }
  };

  return {
    group,
    update(dt, time, broken, cars) {
      lensMat.uniforms.time.value = time;
      if (broken && broken.length === props.length) {
        let fresh = 0;
        for (let i = 0; i < props.length; i++) if (!shown[i] && broken[i]) fresh++;
        for (let i = 0; i < props.length; i++) {
          const b = broken[i] ? 1 : 0;
          if (b === shown[i]) continue;
          shown[i] = b;
          const p = props[i];
          setBroken(p, b === 1);
          // A bulk change (e.g. a state jump) just hides; a few fresh hits come apart.
          if (b && fresh <= 6) {
            let best = 144;
            let vx = 0;
            let vz = 0;
            for (const c of cars) {
              const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
              if (d < best) {
                best = d;
                vx = c.vx;
                vz = c.vz;
              }
            }
            shatter(p, vx, vz);
          }
        }
      }
      debris.update(dt);
    },
    dispose() {
      debris.dispose();
      for (const m of meshes) m.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}

/** Arm and head directions for a traffic light at a corner of its intersection. */
function trafficFrame(world: World, p: Prop): TrafficFrame {
  const g = world.graph;
  const fallback: TrafficFrame = { ax: Math.sin(p.yaw), az: Math.cos(p.yaw), len: 4, fax: Math.cos(p.yaw), faz: -Math.sin(p.yaw), fbx: -Math.cos(p.yaw), fbz: Math.sin(p.yaw) };
  if (p.node === undefined || p.node < 0 || !g.nodes[p.node]) return fallback;
  const n = g.nodes[p.node];
  const ul = Math.hypot(p.x - n.x, p.z - n.z) || 1;
  const ux = (p.x - n.x) / ul;
  const uz = (p.z - n.z) / ul;
  // The two roads bracketing this corner: nearest edge direction on either side of u.
  let bestA = Infinity;
  let bestB = -Infinity;
  let dA: { x: number; z: number } | null = null;
  let dB: { x: number; z: number } | null = null;
  let wA = 13;
  for (const eid of n.edges) {
    const e = g.edges[eid];
    const o = g.nodes[e.a === p.node ? e.b : e.a];
    const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
    const dx = (o.x - n.x) / l;
    const dz = (o.z - n.z) / l;
    const ang = Math.atan2(ux * dz - uz * dx, ux * dx + uz * dz);
    if (ang > 0 && ang < bestA) {
      bestA = ang;
      dA = { x: dx, z: dz };
      wA = e.width;
    }
    if (ang < 0 && ang > bestB) {
      bestB = ang;
      dB = { x: dx, z: dz };
    }
  }
  if (!dA || !dB) return fallback;
  // Arm: from the pole, perpendicular across road A toward its centerline.
  const tx = n.x - p.x;
  const tz = n.z - p.z;
  const along = tx * dA.x + tz * dA.z;
  let ax = tx - dA.x * along;
  let az = tz - dA.z * along;
  const reach = Math.hypot(ax, az) || 1;
  ax /= reach;
  az /= reach;
  const len = Math.max(3, Math.min(9, Math.min(reach, wA / 2 + 1) * 0.95));
  // Heads face traffic approaching the intersection along each road (+d, outward).
  return { ax, az, len, fax: dA.x, faz: dA.z, fbx: dB.x, fbz: dB.z };
}

/** Reference axis angle of a node (its first road) for grouping signal phases. */
function nodeAxis(world: World, node: number): number {
  const n = world.graph.nodes[node];
  const e = world.graph.edges[n.edges[0]];
  if (!e) return 0;
  const o = world.graph.nodes[e.a === node ? e.b : e.a];
  return Math.atan2(o.x - n.x, o.z - n.z);
}

function hash01(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
