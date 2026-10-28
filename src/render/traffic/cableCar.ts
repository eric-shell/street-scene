/**
 * The San Francisco cable car on screen (sim/cableCar.ts runs it): a double ended California Street car built
 * from primitives in the house palette (no asset): a wine red and cream body on a dark underframe, an enclosed
 * middle saloon with lit windows and a clerestory, open end sections with their outward benches and brass grab
 * posts, a headlamp and a lit destination board at each end, and the bell in its yoke on the roof.
 *
 * One mesh: the lit body and the glowing panes are one geometry with two material groups (two draws), and the
 * bell swings in the body's own vertex shader (an `aSwing` weight per vertex rotates the bell's vertices about its
 * yoke by a uniform), so a ring costs one uniform write. Posed every frame from the timetable at the interpolated
 * sim tick, like the El's trains: the same pure function the sim steps (cableCarAt), so the car on screen is where
 * the sim's body is, in a race, its replay and behind the menu alike. Pitch follows the ground under its trucks.
 *
 * The bell rings on the sim's bell (RaceState.cableCar.bell, every departure and every race car in its way) while a
 * session drives the scene, and on the timetable's departures alone behind the menu; each ring swings the bell and
 * strikes the scene's bell voice (audio/sceneVoices.ts CableBell) from the camera.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../../city/world';
import type { Quality } from '../../ui/settings';
import { CABLE_CAR_BODY } from '../../sim/tuning';
import { TICK_HZ } from '../../sim/constants';
import { type CableCarPose, type CableLine, cableCarAt, departureBell } from '../../sim/cableCar';
import { CableBell } from '../../audio/sceneVoices';
import { GeoBuilder } from '../geoBuilder';
import { ROAD_Y } from '../street/cityMeshes';

/** The car's proportions (m, local: +Z toward the line's last terminal, y up from the rail head). */
const DIM = {
  floor: 0.78,
  /** The saloon's half length and the open ends beyond it to the dash. */
  saloon: 1.95,
  dash: 4.0,
  waist: 1.55,
  sill: 1.62,
  head: 2.5,
  eave: 2.92,
  roof: 3.06,
  clerestory: 3.32,
  /** The bell's yoke on the roof: its pivot and the bell's size. */
  bellZ: 0.6,
  bellPivot: 3.62,
  bellR: 0.17,
  bellH: 0.28,
} as const;

/** The swing of a ring: amplitude (rad), frequency (Hz), decay (s); and the bell voice's reach (m). */
const SWING = { amp: 0.55, hz: 1.7, decay: 1.1 } as const;
const BELL_RANGE = 160;
const BELL_HALF = 30;

/** House palette: wine red panels, cream, gilt trim, varnished wood, dark steel; warm lit glass. */
const C = {
  red: new THREE.Color(0x7d1f2c),
  cream: new THREE.Color(0xe9dcbc),
  gilt: new THREE.Color(0xc39a45),
  wood: new THREE.Color(0x7a4a28),
  steel: new THREE.Color(0x26282c),
  roof: new THREE.Color(0x3b3632),
  brass: new THREE.Color(0xd6a840),
  pane: new THREE.Color(0xffc27a).multiplyScalar(0.85),
  lamp: new THREE.Color(0xfff2d0).multiplyScalar(2),
  board: new THREE.Color(0xffe2a0).multiplyScalar(1.1),
};

function box(gb: GeoBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: THREE.Color, swing = 0): void {
  const face = (n: [number, number, number], pts: [number, number, number][]) => {
    const v = pts.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], swing, 0, color));
    gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
  };
  face([1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]);
  face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  face([0, 0, -1], [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]);
  face([0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
  face([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
}

/** A flared cylinder (the bell) hanging below y1 down to y0, weight `swing` on every vertex. */
function bell(gb: GeoBuilder, z: number, y0: number, y1: number, r0: number, r1: number, seg: number, color: THREE.Color): void {
  const ring: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    ring.push(gb.vertex(nx * r0, y0, z + nz * r0, nx, 0, nz, 1, 0, color), gb.vertex(nx * r1, y1, z + nz * r1, nx, 0, nz, 1, 0, color));
  }
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2 + Math.PI / seg;
    gb.quadFacing(ring[k * 2], ring[k * 2 + 2], ring[k * 2 + 3], ring[k * 2 + 1], Math.cos(a), 0, Math.sin(a));
  }
}

/** The car's lit body and its glowing panes, in car space. */
function buildCar(quality: Quality): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const s = new GeoBuilder(true);
  const g = new GeoBuilder(true);
  const W = CABLE_CAR_BODY.halfWidth;
  const L = CABLE_CAR_BODY.halfLength;
  const D = DIM;
  // Underframe, trucks and the floor the whole length.
  box(s, -W + 0.2, W - 0.2, 0.32, D.floor - 0.1, -L + 0.4, L - 0.4, C.steel);
  for (const z of [-2.35, 2.35]) box(s, -0.85, 0.85, 0.08, 0.5, z - 0.75, z + 0.75, C.steel);
  box(s, -W, W, D.floor - 0.1, D.floor, -L, L, C.wood);
  // The saloon: red lower panels, a gilt waist rail, cream window posts, the cream letter board under the eaves.
  box(s, -W, W, D.floor, D.waist, -D.saloon, D.saloon, C.red);
  box(s, -W - 0.02, W + 0.02, D.waist, D.sill, -D.saloon, D.saloon, C.gilt);
  box(s, -W, W, D.head, D.eave, -D.saloon, D.saloon, C.cream);
  const posts = quality === 'low' ? 4 : 6;
  for (let i = 0; i <= posts; i++) {
    const z = -D.saloon + (2 * D.saloon * i) / posts;
    for (const x of [-W, W - 0.08]) box(s, x, x + 0.08, D.sill, D.head, z - 0.06, z + 0.06, C.cream);
  }
  // Lit panes between the posts, both sides, and the saloon's end bulkheads with a window each.
  for (const x of [-W + 0.03, W - 0.05]) box(g, x, x + 0.02, D.sill + 0.04, D.head - 0.04, -D.saloon + 0.06, D.saloon - 0.06, C.pane);
  for (const z of [-D.saloon, D.saloon]) {
    box(s, -W, W, D.floor, D.sill, z - 0.04, z + 0.04, C.red);
    box(s, -W, -0.45, D.sill, D.eave, z - 0.04, z + 0.04, C.cream);
    box(s, 0.45, W, D.sill, D.eave, z - 0.04, z + 0.04, C.cream);
    box(g, -0.45, 0.45, D.sill + 0.05, D.head - 0.05, z - 0.02, z + 0.02, C.pane);
  }
  // Open ends: outward facing benches on a centre backrest, brass grab posts, the dash with its headlamp and the board.
  for (const sgn of [-1, 1]) {
    const z0 = sgn * D.saloon;
    const z1 = sgn * D.dash;
    const lo = Math.min(z0, z1);
    const hi = Math.max(z0, z1);
    for (const x of [-1, 1]) box(s, x * 0.18 - 0.35, x * 0.18 + 0.35, D.floor, D.floor + 0.45, lo + 0.15, hi - 0.25, C.wood);
    box(s, -0.08, 0.08, D.floor + 0.45, D.floor + 1.0, lo + 0.15, hi - 0.25, C.wood);
    for (const z of [lo + 0.15, (lo + hi) / 2, hi - 0.15]) for (const x of [-W + 0.04, W - 0.08]) box(s, x, x + 0.04, D.floor, D.eave, z - 0.03, z + 0.03, C.brass);
    // The dash: a cream panel to the waist, the end posts, the headlamp and the lit destination board.
    const zd = sgn * (L - 0.08);
    box(s, -W, W, D.floor, D.waist + 0.15, zd - 0.08, zd + 0.08, C.cream);
    box(s, -W, W, D.waist + 0.08, D.waist + 0.15, zd - 0.1, zd + 0.1, C.gilt);
    box(g, -0.16, 0.16, D.waist - 0.45, D.waist - 0.15, zd + sgn * 0.08, zd + sgn * 0.12, C.lamp);
    box(s, -W, W, D.head + 0.05, D.eave, zd - 0.06, zd + 0.06, C.cream);
    box(g, -0.7, 0.7, D.head + 0.1, D.eave - 0.06, zd + sgn * 0.06, zd + sgn * 0.08, C.board);
    // The ends' ceiling lamps.
    box(g, -0.3, 0.3, D.eave - 0.05, D.eave - 0.02, (lo + hi) / 2 - 0.6, (lo + hi) / 2 + 0.6, C.pane);
  }
  // Roof, with a little overhang, the clerestory and its lit lights.
  box(s, -W - 0.06, W + 0.06, D.eave, D.roof, -L, L, C.roof);
  box(s, -0.62, 0.62, D.roof, D.clerestory, -D.saloon - 0.4, D.saloon + 0.4, C.roof);
  for (const x of [-0.63, 0.61]) box(g, x, x + 0.02, D.roof + 0.06, D.clerestory - 0.06, -D.saloon, D.saloon, C.pane);
  // The bell in its yoke (the yoke stays put, the bell swings).
  box(s, -0.04, 0.04, D.clerestory, D.bellPivot + 0.06, D.bellZ - 0.32, D.bellZ - 0.26, C.steel);
  box(s, -0.04, 0.04, D.clerestory, D.bellPivot + 0.06, D.bellZ + 0.26, D.bellZ + 0.32, C.steel);
  box(s, -0.04, 0.04, D.bellPivot, D.bellPivot + 0.06, D.bellZ - 0.32, D.bellZ + 0.32, C.steel);
  bell(s, D.bellZ, D.bellPivot - D.bellH, D.bellPivot, D.bellR, D.bellR * 0.55, quality === 'low' ? 6 : 10, C.brass);
  return { solid: s.build(), glow: g.build() };
}

export interface CableCarView {
  group: THREE.Group;
  /** Pose at a fractional sim tick; `raceBell` is RaceState.cableCar.bell when a session drives the scene (NaN: the timetable's departures only). */
  update(tick: number, raceBell: number, audible: boolean): void;
  /** Before each render: the bell voice from this camera. */
  view(camera: THREE.Camera): void;
  dispose(): void;
}

export function createCableCarView(world: World, line: CableLine, quality: Quality): CableCarView {
  const { solid, glow } = buildCar(quality);
  // aSwing from the builders' u (1 on the bell), then one geometry with a group per material.
  const swingOf = (geo: THREE.BufferGeometry) => {
    const uv = geo.getAttribute('uv');
    const a = new Float32Array(uv.count);
    for (let i = 0; i < uv.count; i++) a[i] = uv.getX(i);
    geo.setAttribute('aSwing', new THREE.BufferAttribute(a, 1));
  };
  swingOf(solid);
  swingOf(glow);
  const geo = mergeGeometries([solid, glow], true)!;
  solid.dispose();
  glow.dispose();
  const swing = { value: 0 };
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.7 });
  body.onBeforeCompile = (shader) => {
    shader.uniforms.uSwing = swing;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aSwing;\nuniform float uSwing;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        if (aSwing > 0.5) {
          // About the yoke's pivot, across the car (local X): the bell swings fore and aft.
          vec3 p = transformed - vec3(0.0, ${DIM.bellPivot.toFixed(3)}, ${DIM.bellZ.toFixed(3)});
          float c = cos(uSwing);
          float s = sin(uSwing);
          transformed = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z) + vec3(0.0, ${DIM.bellPivot.toFixed(3)}, ${DIM.bellZ.toFixed(3)});
        }`,
      );
  };
  body.customProgramCacheKey = () => 'cableCarBody';
  const panes = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, [body, panes]);
  mesh.name = 'cableCar';
  mesh.rotation.order = 'YXZ';
  const group = new THREE.Group();
  group.name = 'cableCarLine';
  group.add(mesh);

  const pose: CableCarPose = { s: 0, v: 0, dir: 1, x: 0, z: 0, yaw: 0, departIn: 0 };
  const fore = { x: 0, z: 0 };
  let lastTick = NaN;
  /** The tick of the bell the view last rang (swing and voice), and whether a strike waits for the camera. */
  let rung = -Infinity;
  let pending = false;
  let canHear = false;
  let voice: CableBell | null = null;
  let tried = false;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  return {
    group,
    update(tick, raceBell, audible) {
      cableCarAt(line, tick, pose);
      const y = world.heightAt(pose.x, pose.z);
      // Pitch from the ground under the two trucks.
      const fx = Math.sin(pose.yaw);
      const fz = Math.cos(pose.yaw);
      fore.x = pose.x + fx * 2.35;
      fore.z = pose.z + fz * 2.35;
      const hf = world.heightAt(fore.x, fore.z);
      const hb = world.heightAt(pose.x - fx * 2.35, pose.z - fz * 2.35);
      mesh.position.set(pose.x, y + ROAD_Y, pose.z);
      mesh.rotation.set(-Math.atan2(hf - hb, 4.7), pose.yaw, 0);
      // The newest bell: the sim's in a session, the timetable's departures behind the menu.
      let bellTick = raceBell;
      if (Number.isNaN(raceBell)) {
        bellTick = rung;
        const from = Number.isNaN(lastTick) || tick < lastTick || tick - lastTick > TICK_HZ ? Math.floor(tick) : Math.floor(lastTick) + 1;
        for (let k = from; k <= Math.floor(tick); k++) if (departureBell(line, k)) bellTick = k;
      }
      lastTick = tick;
      if (bellTick > rung) {
        // A bell long past (a scene picked up mid race) swings no more and is not struck.
        pending = tick - bellTick < 0.5 * TICK_HZ;
        rung = bellTick;
      }
      canHear = audible;
      const age = (tick - rung) / TICK_HZ;
      swing.value = age >= 0 && age < 6 ? SWING.amp * Math.exp(-age / SWING.decay) * Math.sin(2 * Math.PI * SWING.hz * age) : 0;
    },
    view(camera) {
      if (!pending) return;
      pending = false;
      camera.getWorldPosition(camPos);
      const dx = mesh.position.x - camPos.x;
      const dz = mesh.position.z - camPos.z;
      const d = Math.hypot(dx, dz, mesh.position.y + DIM.bellPivot - camPos.y);
      if (!canHear || d > BELL_RANGE) return;
      if (!voice && !tried) {
        voice = CableBell.create();
        tried = voice !== null || !CableBell.blocked();
      }
      if (!voice) return;
      camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const l = Math.hypot(dx, dz) || 1;
      voice.ring(1 / (1 + (d / BELL_HALF) ** 2), (dx * camRight.x + dz * camRight.z) / l);
    },
    dispose() {
      geo.dispose();
      body.dispose();
      panes.dispose();
      voice?.dispose();
      voice = null;
    },
  };
}
