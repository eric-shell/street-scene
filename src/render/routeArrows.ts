/**
 * Route guidance on closed side streets.
 *
 * Every barrier is classified by how likely racers are to hit it:
 *  - head on: the closed street continues straight ahead of the incoming road,
 *    so racers must turn here. These get a real barrier, a direction board with
 *    pulsing cyan Lucide chevrons, and a very large translucent arrow above it
 *    that sweeps in the direction to go.
 *  - side: the closed street branches off to the side. These are blocked by
 *    rows of parked cars (see roadblocks.ts), movie style, with an in-air
 *    arrow above each group of cars pointing the way the route goes.
 * Collision is the same wall segment either way. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { CarGroup } from './roadblocks';
import type { Wall } from '../city/blocks';
import { ChevronsRight, drawIcon } from '../ui/icons';
import { GeoBuilder } from './geoBuilder';
import { FOG_DENSITY } from './lighting';
import { RailState, railLayout } from '../sim/rails';

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
  /** Graph node of the intersection the barrier faces. */
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
  const out: BarrierInfo[] = [];
  for (const wall of world.walls) {
    if (wall.kind !== 'barrier') continue;
    const mx = (wall.ax + wall.bx) / 2;
    const mz = (wall.az + wall.bz) / 2;
    let best = 0;
    let bestD = Infinity;
    // The barrier group knows its intersection; otherwise take the nearest route node.
    const groupNode = wall.group !== undefined ? world.barrierGroups?.[wall.group]?.node : undefined;
    const known = groupNode !== undefined ? order.indexOf(groupNode) : -1;
    if (known >= 0) best = known;
    else {
      for (let i = 0; i < order.length; i++) {
        const n = g.nodes[order[i]];
        const d = (n.x - mx) ** 2 + (n.z - mz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
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
    const outDir = nextI >= 0 && nextI < order.length ? unit(node, g.nodes[order[nextI]]) : inDir;
    if (nextI >= 0 && nextI < order.length) {
      const o = outDir;
      // left of forward (sx, sz) is (sz, -sx)
      const leftDot = o.x * sz - o.z * sx;
      if (Math.abs(leftDot) > 0.2) turn = leftDot > 0 ? -1 : 1;
    }
    out.push({ wall, x: mx, z: mz, sx, sz, turn, headOn, node: order[best], inX: inDir.x, inZ: inDir.z, outX: outDir.x, outZ: outDir.z });
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
  /** Move the corner rail pieces to the race's displaced poses (cheap when nothing moved). */
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

export function buildRouteArrows(world: World, barriers: BarrierInfo[] = classifyBarriers(world), carGroups: CarGroup[] = []): RouteArrows {
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
  // Corner rails: modular pieces that follow the sim's rail state (see buildRailMeshes).
  const rails = buildRailMeshes(world, tex);
  for (const m of rails.meshes) group.add(m);
  mats.push(rails.panelMaterial);
  disposables.push(rails);
  curves.forEach((curve, ci) => {
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

  // Side closures: an in-air arrow above each group of parked cars, pointing
  // the way the route goes. It faces whichever way shows that direction best:
  // toward the intersection (route crosses the street mouth) or toward the
  // incoming racers (route turns away from the closed street).
  carGroups.forEach((cg, i) => {
    const b = cg.barrier;
    if (!b || cg.cars === 0) return;
    // Viewer looking into the street (along s), or along the incoming route: right = (-dz, dx).
    const dotA = b.outX * -b.sz + b.outZ * b.sx;
    const dotB = b.outX * -b.inZ + b.outZ * b.inX;
    const useA = Math.abs(dotA) >= Math.abs(dotB);
    const dot = useA ? dotA : dotB;
    if (Math.abs(dot) < 0.3) return;
    const yaw = useA ? Math.atan2(-b.sx, -b.sz) : Math.atan2(-b.inX, -b.inZ);
    const x = cg.x;
    const z = cg.z;
    if (giants.some((gt) => Math.hypot(gt.x - x, gt.z - z) < 12)) return;
    giants.push({ x, y: cg.y + 6.4, z, yaw, w: 12, h: 3, flip: dot > 0 ? 1 : -1, phase: (i * 0.23) % 1, tilt: -0.08 });
  });

  make(boardFrag, panels, false, 'chevronPanels');
  make(bigFrag, giants, true, 'giantArrows');

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

// ---------------------------------------------------------------------------
// Corner rails: one module per sim rail piece
// ---------------------------------------------------------------------------

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
  panelMaterial: THREE.ShaderMaterial;
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
function buildRailMeshes(world: World, tex: THREE.Texture): RailMeshes {
  const l = railLayout(world);
  const panel = new GeoBuilder();
  const frame = new GeoBuilder(true);
  const flip: number[] = [];
  const phase: number[] = [];
  const dark = new THREE.Color(0x101218);
  const post = new THREE.Color(0x2a2d36);
  // Vertex range of each piece in both builders.
  const pStart = new Int32Array(l.count);
  const pEnd = new Int32Array(l.count);
  const fStart = new Int32Array(l.count);
  const fEnd = new Int32Array(l.count);
  const gap = 0.03;
  for (let p = 0; p < l.count; p++) {
    pStart[p] = panel.vertexCount;
    fStart[p] = frame.vertexCount;
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
      }
    }
    pEnd[p] = panel.vertexCount;
    fEnd[p] = frame.vertexCount;
  }

  const meshes: THREE.Mesh[] = [];
  const panelMaterial = new THREE.ShaderMaterial({
    vertexShader: railPanelVert,
    fragmentShader: boardFrag,
    uniforms: { map: { value: tex }, time: { value: 0 }, color: { value: new THREE.Color(0x19e6ff) }, fogDensity: { value: FOG_DENSITY } },
    side: THREE.DoubleSide,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
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

  // Last pose drawn per piece.
  const shownDx = new Float64Array(l.count);
  const shownDz = new Float64Array(l.count);
  const shownRot = new Float64Array(l.count);
  let shownVersion = 0;
  let shownState: RailState | null = null;
  return {
    meshes,
    panelMaterial,
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
    },
  };
}
