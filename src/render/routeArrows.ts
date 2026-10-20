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
import { ChevronsRight, drawIcon } from '../ui/icons';
import { GeoBuilder } from './geoBuilder';
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

// Giant translucent arrows: the same chevrons and animation as the boards, but
// alpha blended with depth writes so overlapping instances never add up.
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
    vec4 tex = texture2D(map, uv);
    float w = fract(uv.x * 1.5 - time * 1.1 + vPhase);
    float march = 0.3 + 0.7 * pow(1.0 - w, 2.5);
    float pulse = 0.7 + 0.3 * sin(time * 4.0 + vPhase * 6.2831);
    float glow = tex.r * march * pulse + tex.g * 0.35;
    float alpha = clamp(0.12 + glow * 0.75, 0.0, 0.85) * vFog;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(color * (0.35 + glow * 2.2), alpha);
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

export interface RouteArrows {
  group: THREE.Group;
  barriers: BarrierInfo[];
  update(time: number): void;
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

/** Group consecutive rail segments into curves (each curve is drawn in travel order). */
function railCurves(world: World): Wall[][] {
  const curves: Wall[][] = [];
  let cur: Wall[] = [];
  for (const w of world.walls) {
    if (w.kind !== 'rail') continue;
    const last = cur[cur.length - 1];
    if (last && Math.hypot(last.bx - w.ax, last.bz - w.az) > 1e-6) {
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

export function buildRouteArrows(world: World, barriers: BarrierInfo[] = classifyBarriers(world)): RouteArrows {
  const group = new THREE.Group();
  group.name = 'routeArrows';
  const disposables: { dispose(): void }[] = [];
  const mats: THREE.ShaderMaterial[] = [];
  const tex = boardTexture();
  disposables.push(tex);

  const make = (frag: string, items: Board[], translucent: boolean, name: string) => {
    if (!items.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const flip = new Float32Array(items.length);
    const phase = new Float32Array(items.length);
    const mat = new THREE.ShaderMaterial({
      vertexShader: boardVert,
      fragmentShader: frag,
      uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
      side: THREE.DoubleSide,
      transparent: translucent,
      depthWrite: true,
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
    if (translucent) mesh.renderOrder = 5;
    group.add(mesh);
    mats.push(mat);
    disposables.push(geo, mat);
  };

  const curves = railCurves(world);
  const panels: Board[] = [];
  const giants: Board[] = [];
  const frame = new GeoBuilder(true);
  const dark = new THREE.Color(0x101218);
  const post = new THREE.Color(0x2a2d36);
  curves.forEach((curve, ci) => {
    curve.forEach((w, si) => {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const mx = (w.ax + w.bx) / 2;
      const mz = (w.az + w.bz) / 2;
      const ground = world.heightAt(mx, mz);
      const yaw = Math.atan2(w.nx, w.nz);
      // Chevron panel on the track side of the rail.
      panels.push({ x: mx + w.nx * 0.2, y: ground + 0.75, z: mz + w.nz * 0.2, yaw, w: len + 0.02, h: 0.95, flip: flipFor(w), phase: (ci * 0.31 + si * 0.08) % 1, tilt: 0 });
      // Backing wall and a post at each joint.
      const v = [
        [w.ax, ground + 0.15, w.az],
        [w.bx, ground + 0.15, w.bz],
        [w.bx, ground + 1.35, w.bz],
        [w.ax, ground + 1.35, w.az],
      ].map(([x, y, z]) => frame.vertex(x, y, z, w.nx, 0, w.nz, 0, 0, dark));
      frame.quadFacing(v[0], v[1], v[2], v[3], w.nx, 0, w.nz);
      frame.quadFacing(v[0], v[3], v[2], v[1], -w.nx, 0, -w.nz);
      const top = [
        [w.ax + w.nx * 0.3, w.az + w.nz * 0.3],
        [w.bx + w.nx * 0.3, w.bz + w.nz * 0.3],
        [w.bx - w.nx * 0.1, w.bz - w.nz * 0.1],
        [w.ax - w.nx * 0.1, w.az - w.nz * 0.1],
      ].map(([x, z]) => frame.vertex(x, ground + 1.35, z, 0, 1, 0, 0, 0, post));
      frame.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
      const px = w.ax + w.nx * 0.12;
      const pz = w.az + w.nz * 0.12;
      const pv = [
        [px - 0.08, pz - 0.08],
        [px + 0.08, pz - 0.08],
        [px + 0.08, pz + 0.08],
        [px - 0.08, pz + 0.08],
      ];
      for (let k = 0; k < 4; k++) {
        const a = pv[k];
        const b = pv[(k + 1) % 4];
        const nx = (a[0] + b[0]) / 2 - px;
        const nz = (a[1] + b[1]) / 2 - pz;
        const l = Math.hypot(nx, nz) || 1;
        const q = [
          [a[0], ground, a[1]],
          [b[0], ground, b[1]],
          [b[0], ground + 1.45, b[1]],
          [a[0], ground + 1.45, a[1]],
        ].map(([x, y, z]) => frame.vertex(x, y, z, nx / l, 0, nz / l, 0, 0, post));
        frame.quadFacing(q[0], q[1], q[2], q[3], nx / l, 0, nz / l);
      }
    });
    // One giant arrow over the apex of each curve.
    const mid = curve[Math.floor(curve.length / 2)];
    const mx = (mid.ax + mid.bx) / 2;
    const mz = (mid.az + mid.bz) / 2;
    giants.push({ x: mx - mid.nx * 1.2, y: world.heightAt(mx, mz) + 6.2, z: mz - mid.nz * 1.2, yaw: Math.atan2(mid.nx, mid.nz), w: 16, h: 4, flip: flipFor(mid), phase: (ci * 0.29) % 1, tilt: -0.1 });
  });

  // Head-on closures without a nearby rail keep a board and a giant arrow of their own.
  const railMids = curves.map((c) => {
    const w = c[Math.floor(c.length / 2)];
    return { x: (w.ax + w.bx) / 2, z: (w.az + w.bz) / 2 };
  });
  barriers
    .filter((b) => b.headOn && b.turn !== 0 && !railMids.some((r) => Math.hypot(r.x - b.x, r.z - b.z) < 40))
    .forEach((b, i) => {
      const len = Math.hypot(b.wall.bx - b.wall.ax, b.wall.bz - b.wall.az);
      const ground = Math.min(world.heightAt(b.wall.ax, b.wall.az), world.heightAt(b.wall.bx, b.wall.bz));
      const w = Math.min(len * 0.85, 9);
      const yaw = Math.atan2(-b.sx, -b.sz);
      panels.push({ x: b.x - b.sx * 0.35, y: ground + 2.15, z: b.z - b.sz * 0.35, yaw, w, h: w / 4, flip: b.turn, phase: (i * 0.37) % 1, tilt: 0 });
      giants.push({ x: b.x - b.sx * 1.5, y: ground + 7, z: b.z - b.sz * 1.5, yaw, w: 16, h: 4, flip: b.turn, phase: (i * 0.29) % 1, tilt: -0.1 });
    });

  make(boardFrag, panels, false, 'chevronPanels');
  make(bigFrag, giants, true, 'giantArrows');
  if (frame.vertexCount) {
    const fg = frame.build();
    const fm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
    const mesh = new THREE.Mesh(fg, fm);
    mesh.name = 'railFrames';
    group.add(mesh);
    disposables.push(fg, fm);
  }

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
