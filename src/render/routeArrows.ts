/**
 * Route guidance: the cyan barriers and the signs floating over them.
 *
 * Every closure (a side street shut off the course) and every corner rail is
 * a chain of cyan modular pieces (the sim's rail pieces, src/sim/rails.ts):
 * a chevron panel facing the course whose chevrons march the way the route
 * goes, an LED strip along the top with light comets running the same way, a
 * soft glow pooled on the ground in front, posts, and an amber beacon
 * blinking on every fourth post. Pieces a hit has shoved are redrawn where
 * the race left them.
 *
 * Above every closure and at the apex of every corner rail floats a neon
 * sign: a tube frame around big chevrons pointing the way to go (along the
 * route past a side closure, toward the turn at a head-on one), hovering,
 * scanline shimmering, fading in from the distance and out again before it
 * would fill the screen. Behind the barriers stand the street meets
 * (meetPlan.ts). Over the entry of every route shortcut floats the same kind
 * of sign in hot pink, "SHORTCUT" with chevrons pointing into the alley.
 * Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { Wall } from '../city/blocks';
import type { BarrierGroup, RailWall } from '../city/route';
import { routeSample } from '../city/route';
import { ChevronsRight, drawIcon } from '../ui/icons';
import { GeoBuilder } from './geoBuilder';
import { FOG_DENSITY } from './lighting';
import { RailState, railLayout } from '../sim/rails';

/** A closure as the renderer sees it: its group, where it faces and which way the route goes past it. */
export interface BarrierInfo {
  group: BarrierGroup;
  /** Closure center. */
  x: number;
  z: number;
  /** Unit normal toward the course. */
  nx: number;
  nz: number;
  /** Unit direction from the intersection into the closed street. */
  sx: number;
  sz: number;
  /** Route turns left (-1) or right (+1) as seen from the intersection looking at the closure. 0 = unknown. */
  turn: -1 | 0 | 1;
  headOn: boolean;
  /** Graph node of the intersection the closure faces. */
  node: number;
  /** Unit route directions into and out of that intersection. */
  inX: number;
  inZ: number;
  outX: number;
  outZ: number;
}

export function classifyBarriers(world: World): BarrierInfo[] {
  const route = world.route;
  const g = world.graph;
  const order = route.nodes;
  const unit = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };
  return (world.barrierGroups ?? []).map((gr) => {
    const best = Math.max(0, order.indexOf(gr.node));
    const node = g.nodes[order[best]];
    const sx = -gr.nx;
    const sz = -gr.nz;
    const prevI = route.closed ? (best - 1 + order.length) % order.length : best - 1;
    const nextI = route.closed ? (best + 1) % order.length : best + 1;
    const inDir = prevI >= 0 ? unit(g.nodes[order[prevI]], node) : nextI < order.length ? unit(node, g.nodes[order[nextI]]) : { x: sx, z: sz };
    const outDir = nextI >= 0 && nextI < order.length ? unit(node, g.nodes[order[nextI]]) : inDir;
    let turn: -1 | 0 | 1 = 0;
    // left of forward (sx, sz) is (sz, -sx)
    const leftDot = outDir.x * sz - outDir.z * sx;
    if (Math.abs(leftDot) > 0.2) turn = leftDot > 0 ? -1 : 1;
    return { group: gr, x: gr.x, z: gr.z, nx: gr.nx, nz: gr.nz, sx, sz, turn, headOn: gr.headOn, node: order[best], inX: inDir.x, inZ: inDir.z, outX: outDir.x, outZ: outDir.z };
  });
}

// ---------------------------------------------------------------------------
// Chevron panels on the rail modules
// ---------------------------------------------------------------------------

const boardFrag = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFog;
  void main() {
    vec2 uv = vec2(vFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y);
    vec4 tex = texture2D(map, uv);
    float w = fract(uv.x * 1.5 - time * 1.1 + vPhase);
    float march = 0.3 + 0.7 * pow(1.0 - w, 2.5);
    float pulse = 0.7 + 0.3 * sin(time * 4.0 + vPhase * 6.2831);
    float glow = tex.r * march * pulse + tex.g * 0.35;
    vec3 c = color * glow * 2.6 + vec3(0.01, 0.02, 0.03) * tex.a;
    gl_FragColor = vec4(c * vFog, 1.0);
  }
`;

function boardTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, W - 20, H - 20);
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 18;
  for (let i = 0; i < 4; i++) drawIcon(ctx, ChevronsRight, 40 + i * 240, 18, 220, '#ff0000', 3);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------
// Floating neon signs
// ---------------------------------------------------------------------------

/** Sign size and height above the ground (m), and the view distances it fades in and out over. */
const SIGN = { height: 5.8, aspect: 4, minWidth: 8, maxWidth: 14, fadeFar: [175, 125], fadeNear: [7, 18], hover: 0.14 } as const;

const signVert = /* glsl */ `
  uniform float time;
  uniform float fogDensity;
  attribute float aFlip;
  attribute float aPhase;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFade;
  void main() {
    vUv = uv;
    vFlip = aFlip;
    vPhase = aPhase;
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    wp.y += sin(time * 1.3 + aPhase * 6.2832) * ${SIGN.hover.toFixed(2)};
    vec4 mv = viewMatrix * wp;
    float d = length(mv.xyz);
    vFade = exp(-fogDensity * fogDensity * d * d * 0.5) * smoothstep(${SIGN.fadeFar[0].toFixed(1)}, ${SIGN.fadeFar[1].toFixed(1)}, d) * smoothstep(${SIGN.fadeNear[0].toFixed(1)}, ${SIGN.fadeNear[1].toFixed(1)}, d);
    gl_Position = projectionMatrix * mv;
  }
`;

/** Channels of the sign texture: r chevrons, g the neon tube frame, b the backplate. */
const signFrag = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFade;
  void main() {
    vec2 uv = vec2(vFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y);
    vec4 tex = texture2D(map, uv);
    // Chevrons light up in a wave marching the way to go; the frame glows steady.
    float w = fract(uv.x * 1.2 - time * 1.3 + vPhase);
    float march = 0.25 + 0.75 * pow(1.0 - w, 3.0);
    float scan = 0.86 + 0.14 * sin(vUv.y * 90.0 + time * 6.0);
    float flick = 0.95 + 0.05 * sin(time * 23.0 + vPhase * 40.0);
    float chev = tex.r * march;
    vec3 c = (color * (chev * 2.8 + tex.g * 1.9) + vec3(0.015, 0.04, 0.08) * tex.b) * scan * flick;
    float alpha = clamp(tex.b * 0.4 + chev * 0.9 + tex.g * 0.95, 0.0, 0.95) * vFade;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(c, alpha);
  }
`;

function signTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // Channels add up: backplate (blue), tube frame (green), chevrons (red).
  ctx.globalCompositeOperation = 'lighter';
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.fillStyle = '#0000ff';
  rr(14, 14, W - 28, H - 28, 46);
  ctx.fill();
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 11;
  ctx.shadowColor = '#00ff00';
  ctx.shadowBlur = 16;
  rr(20, 20, W - 40, H - 40, 40);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.shadowBlur = 0;
  rr(42, 42, W - 84, H - 84, 26);
  ctx.stroke();
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 20;
  for (let i = 0; i < 3; i++) drawIcon(ctx, ChevronsRight, 150 + i * 255, 38, 180, '#ff0000', 3.2);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

/** Shortcut sign colour (hot pink, apart from the cyan route guidance). */
const SHORTCUT_COLOR = 0xff2bd6;

/**
 * "SHORTCUT" and chevrons pointing toward the alley, in the sign channels (r
 * marching chevrons, g tube frame and lettering, b backplate). Two textures,
 * one per side, so the lettering never reads mirrored.
 */
function shortcutTexture(right: boolean): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.fillStyle = '#0000ff';
  rr(14, 14, W - 28, H - 28, 46);
  ctx.fill();
  ctx.strokeStyle = '#00ff00';
  ctx.shadowColor = '#00ff00';
  ctx.shadowBlur = 16;
  ctx.lineWidth = 11;
  rr(20, 20, W - 40, H - 40, 40);
  ctx.stroke();
  // Lettering on the side away from the alley, chevrons on the side toward it.
  const textX = right ? 345 : W - 345;
  ctx.fillStyle = '#00ff00';
  ctx.font = 'bold 118px "Arial Black", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 20;
  ctx.fillText('SHORTCUT', textX, H / 2 + 6, 560);
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 20;
  for (let i = 0; i < 2; i++) {
    if (right) drawIcon(ctx, ChevronsRight, 660 + i * 150, 58, 140, '#ff0000', 3.4);
    else {
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      drawIcon(ctx, ChevronsRight, 660 + i * 150, 58, 140, '#ff0000', 3.4);
      ctx.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

export interface RouteArrows {
  group: THREE.Group;
  barriers: BarrierInfo[];
  update(time: number): void;
  /** Move the rail pieces to the race's displaced poses (cheap when nothing moved). */
  syncRails(state: RailState | null | undefined): void;
  dispose(): void;
}

interface Board {
  x: number;
  y: number;
  z: number;
  yaw: number;
  w: number;
  h: number;
  flip: number;
  phase: number;
  tilt: number;
}

/** Group rail segments into curves (one per route corner, segments in chain order). */
export function railCurves(world: World): Wall[][] {
  const curves: Wall[][] = [];
  let cur: Wall[] = [];
  for (const w of world.walls) {
    if (w.kind !== 'rail') continue;
    const last = cur[cur.length - 1];
    if (last && (last.group !== w.group || (w.group === undefined && Math.hypot(last.bx - w.ax, last.bz - w.az) > 1e-6))) {
      curves.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) curves.push(cur);
  return curves;
}

/** +1 if travelling a -> b runs to the right as seen from the drivable side, else -1. */
function flipFor(w: Wall): number {
  // viewer looks along -n; viewer right is (nz, -nx)
  return (w.bx - w.ax) * w.nz - (w.bz - w.az) * w.nx > 0 ? 1 : -1;
}

export interface RouteArrowOptions {
  /** Blinking amber lamp material for the beacons on the rail posts (the scene animates it). */
  beacon?: THREE.Material;
}

export function buildRouteArrows(world: World, barriers: BarrierInfo[] = classifyBarriers(world), opts: RouteArrowOptions = {}): RouteArrows {
  const group = new THREE.Group();
  group.name = 'routeArrows';
  const disposables: { dispose(): void }[] = [];
  const mats: THREE.ShaderMaterial[] = [];
  const tex = boardTexture();
  const signTex = signTexture();
  disposables.push(tex, signTex);

  // Rail modules (corner rails and closures alike) follow the sim's rail state.
  const rails = buildRailMeshes(world, tex, opts.beacon ?? null);
  for (const m of rails.meshes) group.add(m);
  mats.push(...rails.materials);
  disposables.push(rails);

  const signs: Board[] = [];
  const route = world.route;
  // Closures: a sign over every one, chevrons pointing the way the route goes past it. Seen
  // from the course (looking along -n) the viewer's right is (nz, -nx).
  barriers.forEach((b, i) => {
    const gr = b.group;
    const rp = world.routeProgress(b.x, b.z);
    // Head on: the way out of the turn. Side: along the route right there.
    const dx = b.headOn ? b.outX : rp.tx;
    const dz = b.headOn ? b.outZ : rp.tz;
    const right = dx * b.nz - dz * b.nx;
    if (Math.abs(right) < 0.25) return;
    const w = Math.max(SIGN.minWidth, Math.min(SIGN.maxWidth, gr.length * 0.6));
    const y = world.heightAt(b.x, b.z) + SIGN.height + (b.headOn ? 0.6 : 0);
    signs.push({ x: b.x + b.nx * 0.4, y, z: b.z + b.nz * 0.4, yaw: Math.atan2(b.nx, b.nz), w, h: w / SIGN.aspect, flip: right > 0 ? 1 : -1, phase: (i * 0.29) % 1, tilt: -0.08 });
  });
  // Corner rails: one over the apex of each, unless a closure sign is right there.
  const closureRails = new Set(barriers.map((b) => (b.group.walls[0] as RailWall | undefined)?.group));
  railCurves(world).forEach((curve, ci) => {
    if (closureRails.has((curve[0] as RailWall).group)) return;
    const mid = curve[Math.floor(curve.length / 2)];
    const mx = (mid.ax + mid.bx) / 2;
    const mz = (mid.az + mid.bz) / 2;
    if (signs.some((s) => Math.hypot(s.x - mx, s.z - mz) < 16)) return;
    signs.push({ x: mx - mid.nx * 1.2, y: world.heightAt(mx, mz) + SIGN.height + 0.4, z: mz - mid.nz * 1.2, yaw: Math.atan2(mid.nx, mid.nz), w: 15, h: 15 / SIGN.aspect, flip: flipFor(mid), phase: (ci * 0.37) % 1, tilt: -0.1 });
  });
  // Route shortcuts: a pink sign just past each entry, over the alley side of the road, facing the
  // traffic and pointing into the alley.
  const shortcutSigns: { right: Board[]; left: Board[] } = { right: [], left: [] };
  route.shortcuts.forEach((sc, i) => {
    const at = routeSample(route, sc.sIn + 7);
    const ax = sc.bx - sc.ax;
    const az = sc.bz - sc.az;
    // Left of travel (tx, tz) is (tz, -tx) in this route's convention (see buildRoute's grid).
    const leftDot = at.tz * ax - at.tx * az;
    const side = leftDot > 0 ? 1 : -1;
    const half = route.segWidth[at.seg] / 2 + 2.2;
    const x = at.x + at.tz * half * side;
    const z = at.z - at.tx * half * side;
    // Viewer looks along +t; the sign faces back at them. Seen by the driver, left of travel is on the left.
    const board: Board = { x, y: world.heightAt(x, z) + SIGN.height - 0.4, z, yaw: Math.atan2(-at.tx, -at.tz), w: 11, h: 11 / SIGN.aspect, flip: 1, phase: (i * 0.41) % 1, tilt: -0.06 };
    (side > 0 ? shortcutSigns.left : shortcutSigns.right).push(board);
  });

  if (signs.length) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const flip = new Float32Array(signs.length);
    const phase = new Float32Array(signs.length);
    const mat = new THREE.ShaderMaterial({
      vertexShader: signVert,
      fragmentShader: signFrag,
      uniforms: { map: { value: signTex }, time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, signs.length);
    mesh.name = 'routeSigns';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    signs.forEach((b, i) => {
      e.set(b.tilt, b.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.h, 1));
      mesh.setMatrixAt(i, m);
      flip[i] = b.flip;
      phase[i] = b.phase;
    });
    geo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(flip, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    mesh.renderOrder = 5;
    group.add(mesh);
    mats.push(mat);
    disposables.push(geo, mat);
  }
  for (const right of [true, false]) {
    const list = right ? shortcutSigns.right : shortcutSigns.left;
    if (!list.length) continue;
    const tex = shortcutTexture(right);
    const mesh = signMesh(list, tex, SHORTCUT_COLOR);
    mesh.name = 'shortcutSigns';
    group.add(mesh);
    mats.push(mesh.material as THREE.ShaderMaterial);
    disposables.push(tex, mesh.geometry, mesh.material as THREE.ShaderMaterial);
  }

  return {
    group,
    barriers,
    update(time) {
      for (const m of mats) m.uniforms.time.value = time;
    },
    syncRails(state) {
      rails.sync(state);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** One instanced sign mesh (signVert / signFrag) for boards sharing a texture and colour. */
function signMesh(boards: Board[], tex: THREE.Texture, color: number): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  const flip = new Float32Array(boards.length);
  const phase = new Float32Array(boards.length);
  const mat = new THREE.ShaderMaterial({
    vertexShader: signVert,
    fragmentShader: signFrag,
    uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(color) }, fogDensity: { value: FOG_DENSITY } },
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, boards.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  boards.forEach((b, i) => {
    e.set(b.tilt, b.yaw, 0, 'YXZ');
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.h, 1));
    mesh.setMatrixAt(i, m);
    flip[i] = b.flip;
    phase[i] = b.phase;
  });
  geo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(flip, 1));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  mesh.renderOrder = 5;
  return mesh;
}

// ---------------------------------------------------------------------------
// Rail modules: one per sim rail piece (corner rails and closures)
// ---------------------------------------------------------------------------

/** LED strip comets: spacing along the rail (m) and speed (cycles/s); ground glow reach in front (m). */
const LED = { spacing: 7, speed: 1.4, poolReach: 1.35 } as const;

/** The LED strip along the top: a steady glow with light comets running the way the route goes. */
const ledFrag = /* glsl */ `
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vFog;
  void main() {
    float comet = pow(fract(vUv.x * vFlip / ${LED.spacing.toFixed(1)} - time * ${LED.speed.toFixed(2)}), 10.0);
    gl_FragColor = vec4(color * (0.45 + 2.8 * comet) * vFog, 1.0);
  }
`;

/** The glow the strip throws on the ground in front of the barrier (additive), pulsing with the comets. */
const poolFrag = /* glsl */ `
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vFog;
  void main() {
    float comet = pow(fract(vUv.x * vFlip / ${LED.spacing.toFixed(1)} - time * ${LED.speed.toFixed(2)}), 6.0);
    float fall = (1.0 - vUv.y) * (1.0 - vUv.y);
    gl_FragColor = vec4(color * fall * (0.1 + 0.32 * comet) * vFog, 1.0);
  }
`;

const railPanelVert = /* glsl */ `
  attribute float aFlip;
  attribute float aPhase;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFog;
  uniform float fogDensity;
  void main() {
    vUv = uv;
    vFlip = aFlip;
    vPhase = aPhase;
    vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5);
    gl_Position = projectionMatrix * mv;
  }
`;

interface RailMeshes {
  meshes: THREE.Mesh[];
  /** Animated materials (time uniform). */
  materials: THREE.ShaderMaterial[];
  sync(state: RailState | null | undefined): void;
  dispose(): void;
}

/**
 * Rail modules built from the sim's rail pieces (src/sim/rails.ts): a chevron
 * panel facing the track along each piece, a dark backing wall with a cap,
 * and a post at the start of each module, slightly inset so the modules read
 * as separate pieces. Rest positions are kept; sync() moves the vertices of
 * pieces that the race has shoved (offset and rotation about the piece's rest
 * center, like the sim) and uploads only when something moved.
 */
function buildRailMeshes(world: World, tex: THREE.Texture, beaconMaterial: THREE.Material | null): RailMeshes {
  const l = railLayout(world);
  const panel = new GeoBuilder();
  const frame = new GeoBuilder(true);
  const led = new GeoBuilder();
  const pool = new GeoBuilder();
  const beacon = new GeoBuilder();
  const ledFlip: number[] = [];
  const poolFlip: number[] = [];
  const flip: number[] = [];
  const phase: number[] = [];
  const dark = new THREE.Color(0x101218);
  const post = new THREE.Color(0x2a2d36);
  // Vertex range of each piece in both builders.
  const pStart = new Int32Array(l.count);
  const pEnd = new Int32Array(l.count);
  const fStart = new Int32Array(l.count);
  const fEnd = new Int32Array(l.count);
  const lStart = new Int32Array(l.count);
  const lEnd = new Int32Array(l.count);
  const oStart = new Int32Array(l.count);
  const oEnd = new Int32Array(l.count);
  const bStart = new Int32Array(l.count);
  const bEnd = new Int32Array(l.count);
  const gap = 0.03;
  /** Distance along the current rail chain (m), for the LED comets. */
  let chainS = 0;
  for (let p = 0; p < l.count; p++) {
    pStart[p] = panel.vertexCount;
    fStart[p] = frame.vertexCount;
    lStart[p] = led.vertexCount;
    oStart[p] = pool.vertexCount;
    bStart[p] = beacon.vertexCount;
    if (p === 0 || l.group[p] !== l.group[p - 1]) chainS = 0;
    const k0 = l.first[p];
    const k1 = k0 + l.subs[p];
    let total = 0;
    for (let k = k0; k < k1; k++) total += Math.hypot(l.bx[k] - l.ax[k], l.bz[k] - l.az[k]);
    // The panel's u runs along the piece (a -> b), so its chevrons point toward b from either side;
    // mirror them only when the piece runs against the way the route drives past it.
    const rp = world.routeProgress((l.ax[k0] + l.bx[k1 - 1]) / 2, (l.az[k0] + l.bz[k1 - 1]) / 2);
    const fl = (l.bx[k1 - 1] - l.ax[k0]) * rp.tx + (l.bz[k1 - 1] - l.az[k0]) * rp.tz >= 0 ? 1 : -1;
    const ph = (l.group[p] * 0.31 + p * 0.08) % 1;
    let s = 0;
    for (let k = k0; k < k1; k++) {
      const len = Math.hypot(l.bx[k] - l.ax[k], l.bz[k] - l.az[k]) || 1;
      const ux = (l.bx[k] - l.ax[k]) / len;
      const uz = (l.bz[k] - l.az[k]) / len;
      // Trim the module ends a hair so neighboring pieces show a joint.
      const ta = k === k0 ? Math.min(gap, len / 3) : 0;
      const tb = k === k1 - 1 ? Math.min(gap, len / 3) : 0;
      const ax = l.ax[k] + ux * ta;
      const az = l.az[k] + uz * ta;
      const bx = l.bx[k] - ux * tb;
      const bz = l.bz[k] - uz * tb;
      const nx = l.nx[k];
      const nz = l.nz[k];
      const ga = world.heightAt(ax, az);
      const gb = world.heightAt(bx, bz);
      const u0 = s / total;
      const u1 = (s + len) / total;
      s += len;
      // Chevron panel on the track side.
      const pv = [
        panel.vertex(ax + nx * 0.08, ga + 0.28, az + nz * 0.08, nx, 0, nz, u0, 0),
        panel.vertex(bx + nx * 0.08, gb + 0.28, bz + nz * 0.08, nx, 0, nz, u1, 0),
        panel.vertex(bx + nx * 0.08, gb + 1.23, bz + nz * 0.08, nx, 0, nz, u1, 1),
        panel.vertex(ax + nx * 0.08, ga + 1.23, az + nz * 0.08, nx, 0, nz, u0, 1),
      ];
      panel.quadFacing(pv[0], pv[1], pv[2], pv[3], nx, 0, nz);
      for (let i = 0; i < 4; i++) {
        flip.push(fl);
        phase.push(ph);
      }
      // LED strip along the top edge, facing the course; u is the distance along the chain (m).
      const sa = chainS + s - len;
      const sb = chainS + s;
      const lv = [
        led.vertex(ax + nx * 0.11, ga + 1.24, az + nz * 0.11, nx, 0, nz, sa, 0),
        led.vertex(bx + nx * 0.11, gb + 1.24, bz + nz * 0.11, nx, 0, nz, sb, 0),
        led.vertex(bx + nx * 0.11, gb + 1.31, bz + nz * 0.11, nx, 0, nz, sb, 1),
        led.vertex(ax + nx * 0.11, ga + 1.31, az + nz * 0.11, nx, 0, nz, sa, 1),
      ];
      led.quadFacing(lv[0], lv[1], lv[2], lv[3], nx, 0, nz);
      // Its glow on the ground in front, fading out over LED.poolReach.
      const R = LED.poolReach;
      const ov = [
        pool.vertex(ax + nx * 0.14, world.heightAt(ax + nx * 0.14, az + nz * 0.14) + 0.04, az + nz * 0.14, 0, 1, 0, sa, 0),
        pool.vertex(bx + nx * 0.14, world.heightAt(bx + nx * 0.14, bz + nz * 0.14) + 0.04, bz + nz * 0.14, 0, 1, 0, sb, 0),
        pool.vertex(bx + nx * R, world.heightAt(bx + nx * R, bz + nz * R) + 0.04, bz + nz * R, 0, 1, 0, sb, 1),
        pool.vertex(ax + nx * R, world.heightAt(ax + nx * R, az + nz * R) + 0.04, az + nz * R, 0, 1, 0, sa, 1),
      ];
      pool.quadFacing(ov[0], ov[1], ov[2], ov[3], 0, 1, 0);
      for (let i = 0; i < 4; i++) {
        ledFlip.push(fl);
        poolFlip.push(fl);
      }
      // Backing wall (both faces) and a cap.
      const v = [
        [ax, ga + 0.15, az],
        [bx, gb + 0.15, bz],
        [bx, gb + 1.35, bz],
        [ax, ga + 1.35, az],
      ].map(([x, y, z]) => frame.vertex(x, y, z, nx, 0, nz, 0, 0, dark));
      frame.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
      const back = [
        [ax, ga + 0.15, az],
        [bx, gb + 0.15, bz],
        [bx, gb + 1.35, bz],
        [ax, ga + 1.35, az],
      ].map(([x, y, z]) => frame.vertex(x, y, z, -nx, 0, -nz, 0, 0, dark));
      frame.quadFacing(back[0], back[3], back[2], back[1], -nx, 0, -nz);
      const top = [
        [ax + nx * 0.16, ga, az + nz * 0.16],
        [bx + nx * 0.16, gb, bz + nz * 0.16],
        [bx - nx * 0.1, gb, bz - nz * 0.1],
        [ax - nx * 0.1, ga, az - nz * 0.1],
      ].map(([x, y, z]) => frame.vertex(x, y + 1.35, z, 0, 1, 0, 0, 0, post));
      frame.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
      if (k === k0) {
        // Post at the start of the module.
        const px = ax + ux * 0.1 + nx * 0.04;
        const pz = az + uz * 0.1 + nz * 0.04;
        const sq = [
          [px - 0.08, pz - 0.08],
          [px + 0.08, pz - 0.08],
          [px + 0.08, pz + 0.08],
          [px - 0.08, pz + 0.08],
        ];
        for (let i = 0; i < 4; i++) {
          const a = sq[i];
          const b = sq[(i + 1) % 4];
          const qx = (a[0] + b[0]) / 2 - px;
          const qz = (a[1] + b[1]) / 2 - pz;
          const ql = Math.hypot(qx, qz) || 1;
          const q = [
            [a[0], ga, a[1]],
            [b[0], ga, b[1]],
            [b[0], ga + 1.45, b[1]],
            [a[0], ga + 1.45, a[1]],
          ].map(([x, y, z]) => frame.vertex(x, y, z, qx / ql, 0, qz / ql, 0, 0, post));
          frame.quadFacing(q[0], q[1], q[2], q[3], qx / ql, 0, qz / ql);
        }
        // An amber beacon on every fourth post.
        if (beaconMaterial && p % 4 === 0) {
          const y0 = ga + 1.45;
          const y1 = ga + 1.58;
          const c = [
            [px - 0.075, pz - 0.075],
            [px + 0.075, pz - 0.075],
            [px + 0.075, pz + 0.075],
            [px - 0.075, pz + 0.075],
          ];
          for (let i = 0; i < 4; i++) {
            const a = c[i];
            const b = c[(i + 1) % 4];
            const qx = (a[0] + b[0]) / 2 - px;
            const qz = (a[1] + b[1]) / 2 - pz;
            const ql = Math.hypot(qx, qz) || 1;
            const q = [
              beacon.vertex(a[0], y0, a[1], qx / ql, 0, qz / ql, 0, 0),
              beacon.vertex(b[0], y0, b[1], qx / ql, 0, qz / ql, 0, 0),
              beacon.vertex(b[0], y1, b[1], qx / ql, 0, qz / ql, 0, 0),
              beacon.vertex(a[0], y1, a[1], qx / ql, 0, qz / ql, 0, 0),
            ];
            beacon.quadFacing(q[0], q[1], q[2], q[3], qx / ql, 0, qz / ql);
          }
          const t = c.map(([x, z]) => beacon.vertex(x, y1, z, 0, 1, 0, 0, 0));
          beacon.quadFacing(t[0], t[1], t[2], t[3], 0, 1, 0);
        }
      }
    }
    chainS += s;
    pEnd[p] = panel.vertexCount;
    fEnd[p] = frame.vertexCount;
    lEnd[p] = led.vertexCount;
    oEnd[p] = pool.vertexCount;
    bEnd[p] = beacon.vertexCount;
  }

  const meshes: THREE.Mesh[] = [];
  const panelMaterial = new THREE.ShaderMaterial({
    vertexShader: railPanelVert,
    fragmentShader: boardFrag,
    uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
    side: THREE.DoubleSide,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
  const ledMaterial = new THREE.ShaderMaterial({
    vertexShader: railPanelVert,
    fragmentShader: ledFrag,
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
  });
  const poolMaterial = new THREE.ShaderMaterial({
    vertexShader: railPanelVert,
    fragmentShader: poolFrag,
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const geos: THREE.BufferGeometry[] = [];
  const restOf: { pos: Float32Array; nor: Float32Array; geo: THREE.BufferGeometry; start: Int32Array; end: Int32Array }[] = [];
  if (panel.vertexCount) {
    const pg = panel.build();
    pg.setAttribute('aFlip', new THREE.Float32BufferAttribute(flip, 1));
    pg.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
    const pm = new THREE.Mesh(pg, panelMaterial);
    pm.name = 'railPanels';
    meshes.push(pm);
    geos.push(pg);
    restOf.push({ pos: Float32Array.from(pg.attributes.position.array), nor: Float32Array.from(pg.attributes.normal.array), geo: pg, start: pStart, end: pEnd });
  }
  if (frame.vertexCount) {
    const fg = frame.build();
    const fm = new THREE.Mesh(fg, frameMaterial);
    fm.name = 'railFrames';
    meshes.push(fm);
    geos.push(fg);
    restOf.push({ pos: Float32Array.from(fg.attributes.position.array), nor: Float32Array.from(fg.attributes.normal.array), geo: fg, start: fStart, end: fEnd });
  }
  const glowPart = (gb: GeoBuilder, mat: THREE.Material, name: string, start: Int32Array, end: Int32Array, flips: number[] | null, order = 0) => {
    if (!gb.vertexCount) return;
    const g = gb.build();
    if (flips) {
      g.setAttribute('aFlip', new THREE.Float32BufferAttribute(flips, 1));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(new Float32Array(flips.length), 1));
    }
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.renderOrder = order;
    meshes.push(m);
    geos.push(g);
    restOf.push({ pos: Float32Array.from(g.attributes.position.array), nor: Float32Array.from(g.attributes.normal.array), geo: g, start, end });
  };
  glowPart(led, ledMaterial, 'railLeds', lStart, lEnd, ledFlip);
  glowPart(pool, poolMaterial, 'railGlow', oStart, oEnd, poolFlip, 2);
  if (beaconMaterial) glowPart(beacon, beaconMaterial, 'railBeacons', bStart, bEnd, null);

  // Last pose drawn per piece.
  const shownDx = new Float64Array(l.count);
  const shownDz = new Float64Array(l.count);
  const shownRot = new Float64Array(l.count);
  let shownVersion = 0;
  let shownState: RailState | null = null;
  return {
    meshes,
    materials: [panelMaterial, ledMaterial, poolMaterial],
    sync(state) {
      if (!state || state.layout !== l) return;
      if (state === shownState && state.version === shownVersion) return;
      shownState = state;
      shownVersion = state.version;
      let dirty = false;
      for (let p = 0; p < l.count; p++) {
        const dx = state.dx[p];
        const dz = state.dz[p];
        const rot = state.rot[p];
        if (dx === shownDx[p] && dz === shownDz[p] && rot === shownRot[p]) continue;
        shownDx[p] = dx;
        shownDz[p] = dz;
        shownRot[p] = rot;
        dirty = true;
        const c = Math.cos(rot);
        const sn = Math.sin(rot);
        const ox = l.cx[p];
        const oz = l.cz[p];
        for (const r of restOf) {
          const pos = r.geo.attributes.position.array as Float32Array;
          const nor = r.geo.attributes.normal.array as Float32Array;
          for (let v = r.start[p]; v < r.end[p]; v++) {
            const x = r.pos[v * 3] - ox;
            const z = r.pos[v * 3 + 2] - oz;
            pos[v * 3] = ox + x * c - z * sn + dx;
            pos[v * 3 + 2] = oz + x * sn + z * c + dz;
            const nx = r.nor[v * 3];
            const nz = r.nor[v * 3 + 2];
            nor[v * 3] = nx * c - nz * sn;
            nor[v * 3 + 2] = nx * sn + nz * c;
          }
        }
      }
      if (!dirty) return;
      for (const r of restOf) {
        r.geo.attributes.position.needsUpdate = true;
        r.geo.attributes.normal.needsUpdate = true;
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      panelMaterial.dispose();
      frameMaterial.dispose();
      ledMaterial.dispose();
      poolMaterial.dispose();
    },
  };
}
