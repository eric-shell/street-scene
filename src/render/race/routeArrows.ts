/**
 * Route guidance: the cyan barriers and the signs floating over them.
 *
 * Every closure (a side street shut off the course) and every corner rail is
 * a chain of cyan modular pieces (the sim's rail pieces, src/sim/rails.ts):
 * a chevron panel facing the course whose chevrons march the way the route
 * goes, an LED strip along the top with light comets running the same way, a
 * soft glow pooled on the ground in front, posts, and an amber beacon
 * blinking on every fourth post. Pieces a hit has shoved are redrawn where
 * the race left them, and a hard hit cracks the piece's panel where it
 * landed (a spider web drawn in the panel shader, the broken backlight
 * stuttering around it) for the rest of the race.
 *
 * Above every closure and at the apex of every corner rail floats a neon
 * sign: a tube frame around big chevrons pointing the way to go (along the
 * route past a side closure, toward the turn at a head-on one), hovering,
 * scanline shimmering, fading in from the distance and out again before it
 * would fill the screen. Behind the barriers stand the street meets
 * (meetPlan.ts). Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Wall } from '../../city/blocks';
import type { BarrierGroup } from '../../city/routeBarriers';
import type { RailWall } from '../../city/routeRails';
import { ChevronsRight, drawIcon } from '../../ui/kit/icons';
import { GeoBuilder } from '../geoBuilder';
import { FOG_DENSITY } from '../lighting';
import { type RailLayout, RailState, railLayout } from '../../sim/rails';
import { segmentT } from '../../sim/math';
import { nearCarParkFlight } from '../../city/districts/carPark';
import { Disposer } from '../disposer';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';

/** The route's cyan: rail panels, LED comets, ground glow and the floating signs. */
const ROUTE_CYAN = 0x19e6ff;

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

/**
 * How far the route runs along unit (ux, uz) past closure b (-1..1): the way
 * out of the turn at a head-on closure, else whichever of the ways out and in
 * runs across it. Not the nearest route segment: at a turn that is as often
 * the leg driving straight at the closure, square to it, so its sign is noise.
 */
function closureFlow(b: BarrierInfo, ux: number, uz: number): number {
  const out = b.outX * ux + b.outZ * uz;
  return b.headOn || Math.abs(out) > 0.5 ? out : b.inX * ux + b.inZ * uz;
}

/**
 * The one direction every chevron of closure b points: along the closure, the
 * way the route runs past it, as +1 toward the right of someone on the course
 * looking at it (the sign's own right, (nz, -nx)) or -1 toward the left. The
 * overhead sign, its barrier's panels, LED comets and ground glow all read it,
 * so they cannot disagree.
 */
export function closureFlip(b: BarrierInfo): 1 | -1 {
  return closureFlow(b, b.nz, -b.nx) > 0 ? 1 : -1;
}

/** The closure's chevron direction as a unit vector on the ground (closureFlip along the closure). */
export function closureWay(b: BarrierInfo): { x: number; z: number } {
  const f = closureFlip(b);
  return { x: b.nz * f, z: -b.nx * f };
}

// ---------------------------------------------------------------------------
// Chevron panels on the rail modules
// ---------------------------------------------------------------------------

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
  ${HEIGHT_FOG_GLSL}
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
    vFade = exp(-fogDensity * fogDensity * d * d * 0.5 * hfMulView(mv.xyz)) * smoothstep(${SIGN.fadeFar[0].toFixed(1)}, ${SIGN.fadeFar[1].toFixed(1)}, d) * smoothstep(${SIGN.fadeNear[0].toFixed(1)}, ${SIGN.fadeNear[1].toFixed(1)}, d);
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

export interface RouteArrows {
  group: THREE.Group;
  barriers: BarrierInfo[];
  update(time: number): void;
  /** Move the rail pieces to the race's displaced poses (cheap when nothing moved). */
  syncRails(state: RailState | null | undefined): void;
  /**
   * Crack the panel of the rail piece hit at (x, z), strength 0..1, at scene
   * time `time` (s); a piece hit again keeps its crack and it grows. Returns
   * the crack, or null with no rail piece there. Cracks last for the race
   * (until `state` changes).
   */
  crackRail(state: RailState | null | undefined, x: number, z: number, strength: number, time: number): RailCrack | null;
  /** The panels cracked this race. */
  readonly railCracks: readonly RailCrack[];
  dispose(): void;
}

/** A cracked rail panel: where on it, facing which way, how badly. */
export interface RailCrack {
  /** Rail piece (RailLayout index). */
  piece: number;
  /** Crack center on the panel's face (m), and the panel's outward normal (unit, x/z). */
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  /** 0..1. */
  strength: number;
  /** Center on the panel: u along the piece, v up it (0..1). */
  u: number;
  v: number;
}

/** An overhead sign: where it hangs, facing (yaw) the course, and which way its chevrons point. */
export interface Board {
  x: number;
  y: number;
  z: number;
  /** Rotation about Y (rad): the plane's +z, its front, faces (sin yaw, cos yaw). */
  yaw: number;
  /** Size (m). */
  w: number;
  h: number;
  /** +1: the chevrons point toward the plane's +x, the right of someone on the course looking at it (cos yaw, -sin yaw); -1: toward its left. */
  flip: number;
  phase: number;
  /** Pitch (rad). */
  tilt: number;
  /** Rail group of the closure or corner rail the sign hangs over. */
  rail: number;
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

/**
 * +1 if travelling a -> b runs to the right as seen from the drivable side, else -1. A corner
 * rail runs a -> b in route order (city/routeRails.ts builds it from the incoming road round
 * the fillet to the outgoing one, and the cuts after it keep that order), so this is the way
 * the race goes past it.
 */
function flipFor(w: Wall): number {
  // viewer looks along -n; viewer right is (nz, -nx)
  return (w.bx - w.ax) * w.nz - (w.bz - w.az) * w.nx > 0 ? 1 : -1;
}

/**
 * The overhead signs: one over every closure, chevrons pointing the way the
 * route goes past it (closureFlip), and one at the apex of each corner rail,
 * pointing the way the route goes through the corner. Seen from the course
 * (looking along -n) the viewer's right is (nz, -nx).
 */
export function routeSigns(world: World, barriers: BarrierInfo[]): Board[] {
  const signs: Board[] = [];
  barriers.forEach((b, i) => {
    const gr = b.group;
    const right = closureFlow(b, b.nz, -b.nx);
    if (Math.abs(right) < 0.25) return;
    // A short tie onto a corner rail is no closure to sign: the rail's own sign stands over its apex.
    if (gr.tied && gr.length < SIGN.minWidth) return;
    const w = Math.max(SIGN.minWidth, Math.min(SIGN.maxWidth, gr.length * 0.6));
    const y = world.heightAt(b.x, b.z) + SIGN.height + (b.headOn ? 0.6 : 0);
    signs.push({ x: b.x + b.nx * 0.4, y, z: b.z + b.nz * 0.4, yaw: Math.atan2(b.nx, b.nz), w, h: w / SIGN.aspect, flip: closureFlip(b), phase: (i * 0.29) % 1, tilt: -0.08, rail: (gr.walls[0] as RailWall | undefined)?.group ?? -1 });
  });
  // Corner rails: one over the apex of each, unless a closure sign is right there.
  const closureRails = new Set(barriers.map((b) => (b.group.walls[0] as RailWall | undefined)?.group));
  railCurves(world).forEach((curve, ci) => {
    if (closureRails.has((curve[0] as RailWall).group)) return;
    const mid = curve[Math.floor(curve.length / 2)];
    const mx = (mid.ax + mid.bx) / 2;
    const mz = (mid.az + mid.bz) / 2;
    if (signs.some((s) => Math.hypot(s.x - mx, s.z - mz) < 16)) return;
    // Nor where a car launches off a car park's roof right over it (the rail is cut there, districts/carPark.ts).
    if (nearCarParkFlight(world, mx, mz, 9)) return;
    // Pointing the way the rail runs (a -> b, the way the route goes through the corner), as its panels do.
    signs.push({ x: mx - mid.nx * 1.2, y: world.heightAt(mx, mz) + SIGN.height + 0.4, z: mz - mid.nz * 1.2, yaw: Math.atan2(mid.nx, mid.nz), w: 15, h: 15 / SIGN.aspect, flip: flipFor(mid), phase: (ci * 0.37) % 1, tilt: -0.1, rail: (curve[0] as RailWall).group });
  });
  return signs;
}

export interface RouteArrowOptions {
  /** Blinking amber lamp material for the beacons on the rail posts (the scene animates it). */
  beacon?: THREE.Material;
}

export function buildRouteArrows(world: World, barriers: BarrierInfo[] = classifyBarriers(world), opts: RouteArrowOptions = {}): RouteArrows {
  const group = new THREE.Group();
  group.name = 'routeArrows';
  const res = new Disposer();
  const { track } = res;
  const mats: THREE.ShaderMaterial[] = [];
  const tex = track(boardTexture());
  const signTex = track(signTexture());

  // Rail modules (corner rails and closures alike) follow the sim's rail state.
  const rails = track(buildRailMeshes(world, barriers, tex, opts.beacon ?? null));
  for (const m of rails.meshes) group.add(m);
  mats.push(...rails.materials);

  const signs = routeSigns(world, barriers);

  if (signs.length) {
    const geo = track(new THREE.PlaneGeometry(1, 1));
    const flip = new Float32Array(signs.length);
    const phase = new Float32Array(signs.length);
    const mat = track(
      new THREE.ShaderMaterial({
        vertexShader: signVert,
        fragmentShader: signFrag,
        uniforms: { map: { value: signTex }, time: { value: 0 }, color: { value: new THREE.Color(ROUTE_CYAN) }, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    const mesh = track(new THREE.InstancedMesh(geo, mat, signs.length));
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
    crackRail: (state, x, z, strength, time) => rails.crack(state, x, z, strength, time),
    railCracks: rails.cracks,
    dispose: () => res.dispose(),
  };
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

/** A rail panel's height (m, it runs 0.28 to 1.23 m up the piece); cracks: reach (m, at strength 0 and 1) and ray count. */
const RAIL_PANEL_H = 0.95;
const CRACK = { reach: [0.3, 0.85], rays: 9 } as const;

/** The rail panel's vertex shader: railPanelVert plus the crack (railBoardFrag). */
const railBoardVert = /* glsl */ `
  attribute float aFlip;
  attribute float aPhase;
  attribute vec4 aCrack;
  attribute float aLen;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFog;
  varying vec4 vCrack;
  varying float vLen;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  void main() {
    vUv = uv;
    vFlip = aFlip;
    vPhase = aPhase;
    vCrack = aCrack;
    vLen = aLen;
    vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5 * hfMulView(mv.xyz));
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The rail panel: the board plus its crack (vCrack: center u, v on the
 * panel, strength 0..1 with 0 for none, hit time s; vLen the piece's length,
 * m). The web is polar around the center: rays wandering out from a crushed
 * core, broken rings between them. The acrylic scatters the backlight, so the
 * cracks read bright on the dark panel; around them the backlight stutters in
 * bursts and the core is dead. Lines keep at least a pixel and fade instead
 * of shimmering in the distance.
 */
const railBoardFrag = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFog;
  varying vec4 vCrack;
  varying float vLen;
  float h1(float n) { return fract(sin(n) * 43758.5453123); }
  float thin(float off, float w) {
    float px = max(w, fwidth(off) * 1.2);
    return (1.0 - smoothstep(px * 0.4, px, off)) * (w / px);
  }
  void main() {
    vec2 uv = vec2(vFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y);
    vec4 tex = texture2D(map, uv);
    float w = fract(uv.x * 1.5 - time * 1.1 + vPhase);
    float march = 0.3 + 0.7 * pow(1.0 - w, 2.5);
    float pulse = 0.7 + 0.3 * sin(time * 4.0 + vPhase * 6.2831);
    float glow = tex.r * march * pulse + tex.g * 0.35;
    vec3 add = vec3(0.0);
    if (vCrack.z > 0.0) {
      float s = vCrack.z;
      float seed = floor(fract(vCrack.x * 17.31 + vLen * 0.37) * 997.0);
      vec2 q = vec2((vUv.x - vCrack.x) * vLen, (vUv.y - vCrack.y) * ${RAIL_PANEL_H.toFixed(2)});
      float d = length(q);
      float reach = mix(${CRACK.reach[0].toFixed(2)}, ${CRACK.reach[1].toFixed(2)}, s);
      float a = atan(q.y, q.x);
      const float N = ${CRACK.rays.toFixed(1)};
      float sector = 6.2831853 / N;
      float i0 = floor(a / sector);
      float line = 0.0;
      for (int j = -1; j <= 1; j++) {
        float i = i0 + float(j);
        float hi = mod(i, N) + seed;
        float ra = (i + 0.2 + 0.6 * h1(hi * 7.13)) * sector + sin(d * 11.0 + hi) * 0.07;
        float len = reach * (0.4 + 0.6 * h1(hi * 3.71));
        float off = d * abs(sin(a - ra));
        float on = step(0.0, cos(a - ra)) * (1.0 - smoothstep(len * 0.8, len, d));
        line = max(line, on * thin(off, mix(0.012, 0.004, clamp(d / reach, 0.0, 1.0))));
      }
      for (int k = 1; k <= 3; k++) {
        float fk = float(k);
        float rk = reach * (0.14 + 0.2 * fk) * (0.9 + 0.2 * h1(fk + seed)) + 0.015 * sin(a * 5.0 + seed);
        float arc = step(0.4, h1(mod(floor(a / sector + fk * 0.5), N) + fk * 13.0 + seed));
        float ring = step(fk * 0.3, s + 0.3);
        line = max(line, arc * ring * thin(abs(d - rk), 0.004));
      }
      float dmg = 1.0 - smoothstep(0.0, reach * 1.1, d);
      float core = 1.0 - smoothstep(0.03, 0.08 + 0.08 * s, d);
      // Broken backlight: now and then a burst of stutters, dimmer bursts more often the harder the hit.
      float burst = step(0.75 - 0.25 * s, h1(floor(time * 0.9) + seed));
      float lit = mix(1.0, step(0.5, h1(floor(time * 14.0) + seed * 3.1)), burst);
      glow *= mix(1.0, 0.3 + 0.5 * lit, dmg) * (1.0 - 0.9 * core);
      float since = time - vCrack.w;
      float flash = since >= 0.0 ? exp(-since * 7.0) : 0.0;
      add = vec3(0.7, 0.95, 1.0) * line * (0.5 + 0.5 * lit) * 1.3 * (1.0 - core) + color * dmg * flash * 3.0;
    }
    vec3 c = color * glow * 2.6 + vec3(0.01, 0.02, 0.03) * tex.a + add;
    gl_FragColor = vec4(c * vFog, 1.0);
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
  ${HEIGHT_FOG_GLSL}
  void main() {
    vUv = uv;
    vFlip = aFlip;
    vPhase = aPhase;
    vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5 * hfMulView(mv.xyz));
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Which way each rail piece's panel chevrons run: +1 toward the piece's b end,
 * -1 toward its a end. The panel's u runs along the piece (a -> b) and is
 * attached to its vertices, so a chevron points the same world way from the
 * course side and from behind (the back face is the same texture, mirrored on
 * screen but not in the world).
 *
 * A corner rail runs in route order, so its pieces all point toward b, like the
 * sign over its apex. Not by the route leg nearest each piece: round a corner or
 * a hairpin that leg is often the one square to the rail, or the return leg
 * running the other way, and it turned stretches of one rail against the rest.
 *
 * A closure's pieces all follow the closure's own way (closureWay, the overhead
 * sign's), each taking the end that lies most along it, whichever way the piece
 * happens to run: a V closure's two arms and a tie to a corner rail run at
 * different angles, and a piece's own flow can disagree with the group's.
 */
export function railPanelFlips(world: World, barriers: BarrierInfo[], l: RailLayout): Int8Array {
  const closureOf = new Map<Wall, BarrierInfo>();
  const way = new Map<BarrierInfo, { x: number; z: number }>();
  for (const b of barriers) {
    way.set(b, closureWay(b));
    for (const w of b.group.walls) closureOf.set(w, b);
  }
  const out = new Int8Array(l.count).fill(1);
  for (let p = 0; p < l.count; p++) {
    const k0 = l.first[p];
    const closure = closureOf.get(world.walls[l.wall[k0]]);
    if (!closure) continue;
    const k1 = k0 + l.subs[p];
    const { x, z } = way.get(closure)!;
    out[p] = (l.bx[k1 - 1] - l.ax[k0]) * x + (l.bz[k1 - 1] - l.az[k0]) * z >= 0 ? 1 : -1;
  }
  return out;
}

interface RailMeshes {
  meshes: THREE.Mesh[];
  /** Animated materials (time uniform). */
  materials: THREE.ShaderMaterial[];
  sync(state: RailState | null | undefined): void;
  crack(state: RailState | null | undefined, x: number, z: number, strength: number, time: number): RailCrack | null;
  cracks: RailCrack[];
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
function buildRailMeshes(world: World, barriers: BarrierInfo[], tex: THREE.Texture, beaconMaterial: THREE.Material | null): RailMeshes {
  const l = railLayout(world);
  const flips = railPanelFlips(world, barriers, l);
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
  // Each sub segment's span of its piece's panel u, to place cracks, and each panel vertex's piece length (m).
  const subU0 = new Float32Array(l.subCount);
  const subU1 = new Float32Array(l.subCount);
  const lens: number[] = [];
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
    const fl = flips[p];
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
      subU0[k] = u0;
      subU1[k] = u1;
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
        lens.push(total);
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
    vertexShader: railBoardVert,
    fragmentShader: railBoardFrag,
    uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(ROUTE_CYAN) }, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS },
    side: THREE.DoubleSide,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
  const ledMaterial = new THREE.ShaderMaterial({
    vertexShader: railPanelVert,
    fragmentShader: ledFrag,
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(ROUTE_CYAN) }, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS },
  });
  const poolMaterial = new THREE.ShaderMaterial({
    vertexShader: railPanelVert,
    fragmentShader: poolFrag,
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(ROUTE_CYAN) }, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const geos: THREE.BufferGeometry[] = [];
  const restOf: { pos: Float32Array; nor: Float32Array; geo: THREE.BufferGeometry; start: Int32Array; end: Int32Array }[] = [];
  // Per panel vertex: the piece's crack (u, v, strength, hit time; railBoardFrag), all zero until a hit.
  let crackAttr: THREE.BufferAttribute | null = null;
  if (panel.vertexCount) {
    const pg = panel.build();
    pg.setAttribute('aFlip', new THREE.Float32BufferAttribute(flip, 1));
    pg.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
    pg.setAttribute('aLen', new THREE.Float32BufferAttribute(lens, 1));
    crackAttr = new THREE.BufferAttribute(new Float32Array(panel.vertexCount * 4), 4);
    pg.setAttribute('aCrack', crackAttr);
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
  const cracks: RailCrack[] = [];
  let crackedFor: RailState | null = null;
  const near: number[] = [];
  /** A new race: every panel whole again. */
  const mend = (state: RailState) => {
    if (state === crackedFor) return;
    crackedFor = state;
    if (cracks.length && crackAttr) {
      (crackAttr.array as Float32Array).fill(0);
      crackAttr.needsUpdate = true;
    }
    cracks.length = 0;
  };
  return {
    meshes,
    materials: [panelMaterial, ledMaterial, poolMaterial],
    cracks,
    crack(state, x, z, strength, time) {
      if (!state || state.layout !== l || !crackAttr) return null;
      mend(state);
      // The displaced sub segment nearest the contact.
      l.grid.query(x - 1.5, z - 1.5, x + 1.5, z + 1.5, near);
      let best = -1;
      let bestD = 1.5 * 1.5;
      let bestT = 0;
      for (const k of near) {
        const t = segmentT(x, z, state.ax[k], state.az[k], state.bx[k], state.bz[k]);
        const d = (state.ax[k] + (state.bx[k] - state.ax[k]) * t - x) ** 2 + (state.az[k] + (state.bz[k] - state.az[k]) * t - z) ** 2;
        if (d < bestD) {
          best = k;
          bestD = d;
          bestT = t;
        }
      }
      if (best < 0) return null;
      const p = l.piece[best];
      let c = cracks.find((q) => q.piece === p);
      if (c) c.strength = Math.min(1, Math.max(c.strength, strength) + strength * 0.25);
      else {
        // Bumper height up to the middle of the panel: the web reaches up from where the nose struck.
        const v = 0.2 + Math.random() * 0.3;
        const u = Math.max(0.05, Math.min(0.95, subU0[best] + (subU1[best] - subU0[best]) * bestT));
        const nx = state.nx[best];
        const nz = state.nz[best];
        const cx = state.ax[best] + (state.bx[best] - state.ax[best]) * bestT;
        const cz = state.az[best] + (state.bz[best] - state.az[best]) * bestT;
        c = { piece: p, x: cx + nx * 0.09, y: world.heightAt(cx, cz) + 0.28 + v * RAIL_PANEL_H, z: cz + nz * 0.09, nx, nz, strength, u, v };
        cracks.push(c);
      }
      const a = crackAttr.array as Float32Array;
      for (let i = pStart[p]; i < pEnd[p]; i++) {
        a[i * 4] = c.u;
        a[i * 4 + 1] = c.v;
        a[i * 4 + 2] = Math.max(0.01, c.strength);
        a[i * 4 + 3] = time;
      }
      crackAttr.needsUpdate = true;
      return c;
    },
    sync(state) {
      if (!state || state.layout !== l) return;
      mend(state);
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
