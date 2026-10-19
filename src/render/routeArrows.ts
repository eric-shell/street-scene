/**
 * Route guidance on closed side streets.
 *
 * Every barrier is classified by how likely racers are to hit it:
 *  - head on: the closed street continues straight ahead of the incoming road,
 *    so racers must turn here. These get a real barrier, a direction board with
 *    pulsing cyan Lucide chevrons, and a very large translucent arrow above it
 *    that sweeps in the direction to go.
 *  - side: the closed street branches off to the side. These are blocked by a
 *    line of parked cars (see roadblocks.ts), movie style.
 * Collision is the same wall segment either way. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { Wall } from '../city/blocks';
import { ArrowBigRight, ChevronsRight, drawIcon } from '../ui/icons';
import { FOG_DENSITY } from './lighting';

export interface BarrierInfo {
  wall: Wall;
  /** Barrier center. */
  x: number;
  z: number;
  /** Unit direction from the intersection into the closed street. */
  sx: number;
  sz: number;
  /** Route turns left (-1) or right (+1) as seen from the intersection looking at the barrier. 0 = unknown. */
  turn: -1 | 0 | 1;
  headOn: boolean;
}

export function classifyBarriers(world: World): BarrierInfo[] {
  const route = world.route;
  const g = world.graph;
  const order = route.nodes;
  const out: BarrierInfo[] = [];
  for (const wall of world.walls) {
    if (wall.kind !== 'barrier') continue;
    const mx = (wall.ax + wall.bx) / 2;
    const mz = (wall.az + wall.bz) / 2;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < order.length; i++) {
      const n = g.nodes[order[i]];
      const d = (n.x - mx) ** 2 + (n.z - mz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const node = g.nodes[order[best]];
    const sl = Math.hypot(mx - node.x, mz - node.z) || 1;
    const sx = (mx - node.x) / sl;
    const sz = (mz - node.z) / sl;
    const prevI = route.closed ? (best - 1 + order.length) % order.length : best - 1;
    const nextI = route.closed ? (best + 1) % order.length : best + 1;
    const unit = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
    };
    const inDir = prevI >= 0 ? unit(g.nodes[order[prevI]], node) : nextI < order.length ? unit(node, g.nodes[order[nextI]]) : { x: sx, z: sz };
    const headOn = inDir.x * sx + inDir.z * sz > 0.55;
    let turn: -1 | 0 | 1 = 0;
    if (nextI >= 0 && nextI < order.length) {
      const o = unit(node, g.nodes[order[nextI]]);
      // left of forward (sx, sz) is (sz, -sx)
      const leftDot = o.x * sz - o.z * sx;
      if (Math.abs(leftDot) > 0.2) turn = leftDot > 0 ? -1 : 1;
    }
    out.push({ wall, x: mx, z: mz, sx, sz, turn, headOn });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Direction boards (chevrons on the barrier)
// ---------------------------------------------------------------------------

const boardVert = /* glsl */ `
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
    vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5);
    gl_Position = projectionMatrix * mv;
  }
`;

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

// ---------------------------------------------------------------------------
// Giant translucent sweeping arrows above head-on barriers
// ---------------------------------------------------------------------------

const bigFrag = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFog;
  void main() {
    vec2 uv = vec2(vFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y);
    // Two arrows sweep across the panel in the travel direction, fading at the edges.
    float t = time * 0.55 + vPhase;
    float a = 0.0;
    for (int i = 0; i < 2; i++) {
      float x = fract(uv.x * 0.5 - t + float(i) * 0.5) * 2.0 - 0.5;
      if (x > 0.0 && x < 1.0) {
        vec4 s = texture2D(map, vec2(x, uv.y));
        float edge = smoothstep(0.0, 0.18, uv.x) * smoothstep(1.0, 0.82, uv.x);
        a += (s.r * 0.55 + s.g * 1.2) * edge;
      }
    }
    float pulse = 0.75 + 0.25 * sin(time * 3.0 + vPhase * 6.2831);
    gl_FragColor = vec4(color * a * pulse * vFog, 1.0);
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

/** R = translucent fill, G = bright outline of the Lucide big arrow. */
function bigArrowTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  const scale = S / 24;
  ctx.save();
  ctx.scale(scale, scale);
  for (const [tag, attrs] of ArrowBigRight) {
    if (tag !== 'path') continue;
    const p = new Path2D(String((attrs as Record<string, string>).d));
    ctx.fillStyle = '#ff0000';
    ctx.fill(p);
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = '#00ff00';
  ctx.shadowBlur = 24;
  drawIcon(ctx, ArrowBigRight, 0, 0, S, '#00ff00', 1.2);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export interface RouteArrows {
  group: THREE.Group;
  barriers: BarrierInfo[];
  update(time: number): void;
  dispose(): void;
}

export function buildRouteArrows(world: World, barriers: BarrierInfo[] = classifyBarriers(world)): RouteArrows {
  const group = new THREE.Group();
  group.name = 'routeArrows';
  const disposables: { dispose(): void }[] = [];
  const mats: THREE.ShaderMaterial[] = [];
  const guided = barriers.filter((b) => b.headOn && b.turn !== 0);

  const make = (frag: string, tex: THREE.Texture, items: { x: number; y: number; z: number; yaw: number; w: number; h: number; flip: number; phase: number; tilt: number }[], blending: THREE.Blending, name: string) => {
    if (!items.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const flip = new Float32Array(items.length);
    const phase = new Float32Array(items.length);
    const mat = new THREE.ShaderMaterial({
      vertexShader: boardVert,
      fragmentShader: frag,
      uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
      side: THREE.DoubleSide,
      blending,
      transparent: blending !== THREE.NormalBlending,
      depthWrite: blending === THREE.NormalBlending,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    mesh.name = name;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    items.forEach((b, i) => {
      e.set(b.tilt, b.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.h, 1));
      mesh.setMatrixAt(i, m);
      flip[i] = b.flip;
      phase[i] = b.phase;
    });
    geo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(flip, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    if (blending !== THREE.NormalBlending) mesh.renderOrder = 4;
    group.add(mesh);
    mats.push(mat);
    disposables.push(geo, mat, tex);
  };

  const boards = guided.map((b, i) => {
    const len = Math.hypot(b.wall.bx - b.wall.ax, b.wall.bz - b.wall.az);
    const ground = Math.min(world.heightAt(b.wall.ax, b.wall.az), world.heightAt(b.wall.bx, b.wall.bz));
    const w = Math.min(len * 0.85, 9);
    return { x: b.x - b.sx * 0.35, y: ground + 2.15, z: b.z - b.sz * 0.35, yaw: Math.atan2(-b.sx, -b.sz), w, h: w / 4, flip: b.turn, phase: (i * 0.37) % 1, tilt: 0 };
  });
  make(boardFrag, boardTexture(), boards, THREE.NoBlending, 'directionBoards');

  const big = guided.map((b, i) => {
    const ground = Math.min(world.heightAt(b.wall.ax, b.wall.az), world.heightAt(b.wall.bx, b.wall.bz));
    // Lean the giant arrow slightly toward approaching cars.
    return { x: b.x - b.sx * 1.5, y: ground + 8.5, z: b.z - b.sz * 1.5, yaw: Math.atan2(-b.sx, -b.sz), w: 18, h: 9, flip: b.turn, phase: (i * 0.29) % 1, tilt: -0.12 };
  });
  make(bigFrag, bigArrowTexture(), big, THREE.AdditiveBlending, 'giantArrows');

  return {
    group,
    barriers,
    update(time) {
      for (const m of mats) m.uniforms.time.value = time;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
