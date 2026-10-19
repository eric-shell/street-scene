/**
 * Direction boards on the barriers that close side streets: Lucide chevrons
 * in pulsing cyan with a marching animation that points the way the route
 * continues through that intersection. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import { ChevronsRight, drawIcon } from '../ui/icons';
import { FOG_DENSITY } from './lighting';

const vert = /* glsl */ `
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

const frag = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vFlip;
  varying float vPhase;
  varying float vFog;
  void main() {
    // Mirror the chevrons for boards pointing left.
    vec2 uv = vec2(vFlip > 0.0 ? vUv.x : 1.0 - vUv.x, vUv.y);
    vec4 tex = texture2D(map, uv);
    // Marching light that travels in the arrow's direction, plus a slow pulse.
    float w = fract(uv.x * 1.5 - time * 1.1 + vPhase);
    float march = 0.3 + 0.7 * pow(1.0 - w, 2.5);
    float pulse = 0.7 + 0.3 * sin(time * 4.0 + vPhase * 6.2831);
    float glow = tex.r * march * pulse + tex.g * 0.35;
    vec3 c = color * glow * 2.6 + vec3(0.01, 0.02, 0.03) * tex.a;
    gl_FragColor = vec4(c * vFog, 1.0);
  }
`;

function makeTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // G channel: dim frame. R channel: chevrons (animated in the shader).
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
  mesh: THREE.InstancedMesh | null;
  update(time: number): void;
  dispose(): void;
}

export function buildRouteArrows(world: World): RouteArrows {
  const route = world.route;
  const g = world.graph;
  const barriers = world.walls.filter((w) => w.kind === 'barrier');
  const boards: { x: number; y: number; z: number; yaw: number; w: number; flip: number; phase: number }[] = [];
  const order = route.nodes;
  for (const b of barriers) {
    const mx = (b.ax + b.bx) / 2;
    const mz = (b.az + b.bz) / 2;
    // The barrier belongs to the nearest route node.
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < order.length; i++) {
      const n = g.nodes[order[i]];
      const d = (n.x - mx) ** 2 + (n.z - mz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) continue;
    const node = g.nodes[order[best]];
    const nextIdx = route.closed ? (best + 1) % order.length : best + 1;
    if (nextIdx >= order.length) continue; // sprint finish: nowhere to point
    const next = g.nodes[order[nextIdx]];
    // Viewer looks from the intersection toward the barrier.
    let sx = mx - node.x;
    let sz = mz - node.z;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl;
    sz /= sl;
    let ox = next.x - node.x;
    let oz = next.z - node.z;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    // left of forward (sx, sz) is (sz, -sx)
    const leftDot = ox * sz - oz * sx;
    if (Math.abs(leftDot) < 0.2) continue;
    const len = Math.hypot(b.bx - b.ax, b.bz - b.az);
    const ground = Math.min(world.heightAt(b.ax, b.az), world.heightAt(b.bx, b.bz));
    boards.push({
      x: mx - sx * 0.35,
      y: ground + 2.15,
      z: mz - sz * 0.35,
      yaw: Math.atan2(-sx, -sz),
      w: Math.min(len * 0.85, 9),
      flip: leftDot > 0 ? -1 : 1,
      phase: (boards.length * 0.37) % 1,
    });
  }
  if (!boards.length) return { mesh: null, update() {}, dispose() {} };

  const geo = new THREE.PlaneGeometry(1, 1);
  const flip = new Float32Array(boards.length);
  const phase = new Float32Array(boards.length);
  const map = makeTexture();
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { map: { value: map }, time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, boards.length);
  mesh.name = 'routeArrows';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  boards.forEach((b, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.w / 4, 1));
    mesh.setMatrixAt(i, m);
    flip[i] = b.flip;
    phase[i] = b.phase;
  });
  geo.setAttribute('aFlip', new THREE.InstancedBufferAttribute(flip, 1));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  return {
    mesh,
    update(time) {
      mat.uniforms.time.value = time;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      map.dispose();
    },
  };
}
