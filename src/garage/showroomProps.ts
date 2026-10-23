/**
 * The garage's furniture, built from primitives into one merged mesh per
 * material (the Kit): two-post lifts, fluorescent battens on chains, the roof
 * trusses and pipe runs, workbenches, rolling tool chests, shelving, tire
 * stacks and a tire rack, oil drums, a compressor, an engine hoist with an
 * engine on the chain, a floor jack, a creeper, extension cords and air lines
 * across the floor, body panels waiting to go on. Then the storage a tool
 * truck sells (double-bank roll cabs with side lockers under a top chest or a
 * lit hutch, full-height lockers with one left open, utility carts, carry
 * boxes) and the shop's equipment: a tire changer, a wheel balancer and a MIG
 * welder on its cart. Each prop is drawn in a local
 * frame (x along its wall, +z facing into the room) that Kit.place() puts in
 * the room. Render only; garage/showroom.ts lays the room out.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { badgeTexture, bannerTexture, bayNumbersTexture, beerSignTexture, calendarTexture, clockTexture, deckTexture, exitTexture, platesTexture, washTexture, doorTexture, drawerTexture, glowTexture, lineTexture, partsBoxTexture, pegboardTexture, posterTexture, stainTexture, whiteboardTexture, workOrderTexture } from './showroomTextures';
import { PALETTE } from '../ui/kit/palette';
import type { Disposable } from '../render/disposer';

type Vec = [number, number, number];

/** Fluorescent tube glow, pushed past 1 so the bloom catches it, and the warm work lamps. */
export const GLOW = {
  tube: new THREE.Color(0xe9f0ff).multiplyScalar(2.6),
  lamp: new THREE.Color(0xffc98a).multiplyScalar(2.4),
  screen: new THREE.Color(PALETTE.cyan).multiplyScalar(0.9),
} as const;

/** Every material the room's merged meshes use. Textured ones carry their maps. */
export function createMaterials(track: <T extends Disposable>(x: T) => T, wallMap: THREE.Texture) {
  const std = (p: THREE.MeshStandardMaterialParameters) => track(new THREE.MeshStandardMaterial(p));
  const basic = (color: THREE.Color) => track(new THREE.MeshBasicMaterial({ color }));
  const decal = (map: THREE.Texture, order: number, opacity = 1) => {
    const m = std({ map: track(map), transparent: true, opacity, depthWrite: false, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    m.userData.renderOrder = order;
    return m;
  };
  const glowMap = track(glowTexture());
  const pool = (color: string, k = 0.55) => {
    const l = track(new THREE.MeshBasicMaterial({ map: glowMap, color: new THREE.Color(color).multiplyScalar(k), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    l.userData.renderOrder = 3;
    return l;
  };
  const deck = track(deckTexture());
  deck.repeat.set(12, 12);
  return {
    wall: std({ map: wallMap, roughness: 0.92 }),
    deck: std({ map: deck, roughness: 0.7, metalness: 0.4 }),
    door: std({ map: track(doorTexture()), roughness: 0.5, metalness: 0.5 }),
    steel: std({ color: 0x26272b, roughness: 0.5, metalness: 0.6 }),
    galv: std({ color: 0x74777d, roughness: 0.45, metalness: 0.7 }),
    rust: std({ color: 0x4e2f1d, roughness: 0.9, metalness: 0.2 }),
    lift: std({ color: 0x1f3f63, roughness: 0.45, metalness: 0.3 }),
    red: std({ color: 0x9a1b25, roughness: 0.35, metalness: 0.25 }),
    black: std({ color: 0x18181b, roughness: 0.4, metalness: 0.3 }),
    blue: std({ color: 0x1d4f9a, roughness: 0.4, metalness: 0.25 }),
    yellow: std({ color: 0xbf9420, roughness: 0.5, metalness: 0.2 }),
    orange: std({ color: 0xc8541c, roughness: 0.55 }),
    rubber: std({ color: 0x101012, roughness: 0.9 }),
    chrome: std({ color: 0xb8bcc6, roughness: 0.2, metalness: 0.95 }),
    cast: std({ color: 0x45474c, roughness: 0.65, metalness: 0.55 }),
    primer: std({ color: 0x6b6d70, roughness: 0.85 }),
    carbon: std({ color: 0x0d0e10, roughness: 0.22, metalness: 0.3 }),
    panel: std({ color: 0xd2501f, roughness: 0.25, metalness: 0.2 }),
    cardboard: std({ color: 0x7a5d3f, roughness: 0.95 }),
    wood: std({ color: 0x3e3127, roughness: 0.85 }),
    stainless: std({ color: 0xa9adb3, roughness: 0.32, metalness: 0.85 }),
    gunmetal: std({ color: 0x3a3d44, roughness: 0.38, metalness: 0.45 }),
    /** Appliance white: the fridge, gauge faces. */
    enamel: std({ color: 0xd9d7d0, roughness: 0.4, metalness: 0.1 }),
    tubeOff: std({ color: 0x8d9096, roughness: 0.3 }),
    tube: basic(GLOW.tube.clone()),
    /** The dying batten's tubes: its own material so it can stutter. */
    tubeFlicker: basic(GLOW.tube.clone()),
    lamp: basic(GLOW.lamp.clone()),
    screen: basic(GLOW.screen.clone()),
    pegboard: std({ map: track(pegboardTexture()), roughness: 0.8 }),
    drawersRed: std({ map: track(drawerTexture('#9a1b25')), roughness: 0.35, metalness: 0.25 }),
    drawersBlack: std({ map: track(drawerTexture('#1d1d21')), roughness: 0.4, metalness: 0.3 }),
    drawersBlue: std({ map: track(drawerTexture('#1d4f9a')), roughness: 0.4, metalness: 0.25 }),
    drawersGunmetal: std({ map: track(drawerTexture('#3a3d44')), roughness: 0.38, metalness: 0.45 }),
    /** The flagship cab's deep candy red, glossier than the shop's other paint. */
    candy: std({ color: 0xa80d1a, roughness: 0.16, metalness: 0.6 }),
    drawersCandy: std({ map: track(drawerTexture('#a80d1a')), roughness: 0.16, metalness: 0.6 }),
    candyOrange: std({ color: 0xc4480e, roughness: 0.16, metalness: 0.6 }),
    drawersCandyOrange: std({ map: track(drawerTexture('#c4480e')), roughness: 0.16, metalness: 0.6 }),
    candyBlue: std({ color: 0x0d3fa8, roughness: 0.16, metalness: 0.6 }),
    drawersCandyBlue: std({ map: track(drawerTexture('#0d3fa8')), roughness: 0.16, metalness: 0.6 }),
    /** The flagship cabs' accent lights: the underglow strips and the seams between each cab and its lockers. */
    accentCyan: basic(new THREE.Color(PALETTE.cyan).multiplyScalar(2.2)),
    accentPurple: basic(new THREE.Color(PALETTE.purple).multiplyScalar(2.2)),
    accentPink: basic(new THREE.Color(PALETTE.pink).multiplyScalar(2.2)),
    accentGreen: basic(new THREE.Color(PALETTE.green).multiplyScalar(2.2)),
    badge: track(new THREE.MeshBasicMaterial({ map: track(badgeTexture(BADGES)), color: new THREE.Color(1.6, 1.6, 1.6) })),
    poster0: std({ map: track(posterTexture('KUROGANE', 'AERO WORKS', PALETTE.orange, 0)), roughness: 0.8, transparent: true }),
    poster1: std({ map: track(posterTexture('HAYATE', 'NIGHT SERIES', PALETTE.cyan, 1)), roughness: 0.8, transparent: true }),
    poster2: std({ map: track(posterTexture('KIBA', 'FORGED WHEELS', PALETTE.yellow, 2)), roughness: 0.8, transparent: true }),
    whiteboard: std({ map: track(whiteboardTexture()), roughness: 0.3 }),
    workOrder: std({ map: track(workOrderTexture()), roughness: 0.9 }),
    boxKurogane: std({ map: track(partsBoxTexture('KUROGANE', 'AERO WORKS', PALETTE.orange)), roughness: 0.95 }),
    boxHayate: std({ map: track(partsBoxTexture('HAYATE', 'NIGHT SERIES', PALETTE.cyan)), roughness: 0.95 }),
    boxKiba: std({ map: track(partsBoxTexture('KIBA', 'FORGED WHEELS', PALETTE.yellow)), roughness: 0.95 }),
    /** The beer sign over the fridge: additive, so only its lines show, pushed past the bloom. */
    beerSign: track(new THREE.MeshBasicMaterial({ map: track(beerSignTexture()), color: new THREE.Color(0xff5a3c).multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
    line: decal(lineTexture(), 1, 0.85),
    stain: decal(stainTexture(), 2, 0.6),
    /** Sodium street light leaking under the roller door: additive, so it only ever brightens the floor. */
    leak: (() => {
      const l = track(new THREE.MeshBasicMaterial({ map: track(glowTexture()), color: new THREE.Color(0xffa040).multiplyScalar(0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.userData.renderOrder = 3;
      return l;
    })(),
    leakEdge: basic(new THREE.Color(0xffb050).multiplyScalar(1.6)),
    /** Each underglow's pool on the floor in front of its cab: additive, like the door's leak. */
    glowCyan: pool(PALETTE.cyan, 0.22),
    glowPurple: pool(PALETTE.purple, 0.22),
    /** Faked light, no lighting cost: the pools under the battens, the exit signs' green, the heater's warmth. */
    poolTube: pool('#dfe8ff', 0.16),
    poolExit: pool('#3cff7a', 0.14),
    poolHeater: pool('#ff7a2a', 0.6),
    /** Light washing down the wall or a hutch's back under an LED strip. */
    wash: (() => {
      const l = track(new THREE.MeshBasicMaterial({ map: track(washTexture()), color: new THREE.Color(0xe8f0ff).multiplyScalar(0.32), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.userData.renderOrder = 3;
      return l;
    })(),
    exit: track(new THREE.MeshBasicMaterial({ map: track(exitTexture()), color: new THREE.Color(1.6, 1.6, 1.6) })),
    heaterCoil: basic(new THREE.Color(0xff6a20).multiplyScalar(2.4)),
    /** The beer cooler's lit interior and its glass door. */
    coolerLight: basic(new THREE.Color(0xdfefff).multiplyScalar(0.95)),
    glass: std({ color: 0x9fb4c8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false }),
    bayNumbers: decal(bayNumbersTexture(), 1, 0.8),
    banner: std({ map: track(bannerTexture(BANNERS)), roughness: 0.9 }),
    plates: std({ map: track(platesTexture()), roughness: 0.6, metalness: 0.3 }),
    clock: std({ map: track(clockTexture()), roughness: 0.4 }),
    calendar: std({ map: track(calendarTexture()), roughness: 0.9 }),
    glowPink: pool(PALETTE.pink, 0.22),
    glowGreen: pool(PALETTE.green, 0.22),
  };
}
export type Mats = ReturnType<typeof createMaterials>;

/** Merged primitives per material, placed through a local frame. */
export class Kit {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly frame = new THREE.Matrix4();
  private readonly m4 = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();
  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();

  constructor(readonly m: Mats) {}

  /** Following pieces are in a local frame at (x, y, z) turned by yaw; no arguments puts them back in room space. */
  place(x = 0, y = 0, z = 0, yaw = 0): this {
    this.frame.makeRotationY(yaw).setPosition(x, y, z);
    return this;
  }

  add(mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): void {
    geo.applyMatrix4(this.m4.makeRotationFromEuler(this.euler.set(rx, ry, rz, 'YXZ')));
    geo.translate(x, y, z);
    geo.applyMatrix4(this.frame);
    const list = this.parts.get(mat) ?? [];
    list.push(geo);
    this.parts.set(mat, list);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry, rx, rz);
  }

  /** A cylinder of radius r (r2 at the bottom) and length h along an axis. */
  cyl(mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 14, r2 = r): void {
    const g = new THREE.CylinderGeometry(r, r2, h, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    this.add(mat, g, x, y, z);
  }

  /** A bar of square section t from a to b (arms, braces, chains, cables). */
  bar(mat: THREE.Material, a: Vec, b: Vec, t: number, t2 = t): void {
    const from = this.v0.set(...a);
    const dir = this.v1.set(...b).sub(from);
    const len = dir.length();
    const g = new THREE.BoxGeometry(t, t2, len);
    g.applyMatrix4(this.m4.compose(from.addScaledVector(dir, 0.5), this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()), new THREE.Vector3(1, 1, 1)));
    g.applyMatrix4(this.frame);
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }

  /** A hose or cable through points (a smooth curve), radius r. */
  hose(mat: THREE.Material, pts: Vec[], r: number, seg = 48): void {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    this.add(mat, new THREE.TubeGeometry(curve, seg, r, 6));
  }

  /** A flat decal lying on the floor (or a plane on a wall with rx = 0). */
  plane(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry = 0, rx = 0): void {
    this.add(mat, new THREE.PlaneGeometry(w, h), x, y, z, ry, rx);
  }

  /** Merge each material's pieces into one mesh and add them to the scene. */
  build(scene: THREE.Object3D, track: <T extends Disposable>(x: T) => T): void {
    for (const [mat, list] of this.parts) {
      const mesh = new THREE.Mesh(track(mergeGeometries(list)), mat);
      mesh.renderOrder = (mat.userData.renderOrder as number | undefined) ?? 0;
      list.forEach((g) => g.dispose());
      scene.add(mesh);
    }
    this.parts.clear();
  }
}

// ---------------------------------------------------------------------------
// Lifts, lights and the roof
// ---------------------------------------------------------------------------

/** A car's measurements a lift needs (m). */
export interface LiftFit {
  width: number;
  length: number;
  wheelbase: number;
}

/**
 * A two-post lift with the car's ground at height h, the car along local z:
 * base plates, posts with the hazard band and lock ladders, the overhead beam
 * with its safety bar and LED bars,
 * carriages, four swing arms to pads under the sills and the power unit.
 * With `move`, the carriages, arms and pads go into that kit instead, at
 * height 0 in the same frame, so the showroom can raise and lower them.
 * Returns the lift's half extents across (x) and along (z), for the camera.
 */
export function lift(k: Kit, x: number, z: number, yaw: number, h: number, car: LiftFit, move?: Kit): [number, number] {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const mk = move ?? k;
  mk.place(x, 0, z, yaw);
  const mh = move ? 0 : h;
  const px = car.width / 2 + 0.42;
  for (const s of [-1, 1]) {
    const sx = s * px;
    k.box(m.steel, 0.62, 0.025, 0.78, sx, 0.012, 0);
    k.box(m.lift, 0.3, 3.9, 0.34, sx, 1.975, 0);
    k.box(m.steel, 0.1, 3.7, 0.08, sx - s * 0.16, 1.95, 0);
    k.box(m.galv, 0.04, 3.3, 0.05, sx - s * 0.13, 1.95, 0.13);
    k.box(m.yellow, 0.31, 0.3, 0.35, sx, 0.17, 0);
    for (const y of [0.09, 0.21]) k.box(m.black, 0.315, 0.05, 0.355, sx, y, 0);
    // Carriage at the arms' height, arms swung under the sills.
    mk.box(m.lift, 0.2, 0.72, 0.42, sx - s * 0.24, mh + 0.36, 0);
    for (const e of [-1, 1]) {
      const pad: Vec = [s * (car.width / 2 - 0.4), mh, e * (car.wheelbase / 2 - 0.45)];
      mk.bar(m.lift, [sx - s * 0.3, mh, e * 0.16], pad, 0.13, 0.08);
      mk.cyl(m.rubber, 0.085, 0.07, pad[0], mh + 0.055, pad[2], 'y', 12);
      mk.cyl(m.yellow, 0.06, 0.03, pad[0], mh + 0.03, pad[2], 'y', 10);
    }
  }
  k.box(m.lift, 2 * px + 0.3, 0.2, 0.26, 0, 4.0, 0);
  k.box(m.yellow, 0.5, 0.06, 0.27, 0, 3.86, 0);
  // LED bars under the beam either side of the safety bar, lighting down onto the car.
  for (const s of [-1, 1]) k.box(m.tube, px - 0.45, 0.016, 0.05, s * (px / 2 + 0.2), 3.892, 0);
  k.cyl(m.rubber, 0.016, 2 * px, 0, 3.86, -0.15, 'x', 6);
  // The power unit on the right post: motor, reservoir, a red button, its hose up the post.
  k.cyl(m.steel, 0.11, 0.34, px + 0.3, 1.45, 0.05);
  k.box(m.black, 0.18, 0.4, 0.18, px + 0.3, 1.06, 0.05);
  k.box(m.red, 0.05, 0.05, 0.04, px + 0.3, 1.2, 0.16);
  k.hose(m.rubber, [[px + 0.3, 0.86, 0.05], [px + 0.22, 0.5, 0.18], [px + 0.15, 0.6, 0.2], [px + 0.15, 3.4, 0.2], [px - 0.1, 3.86, -0.15]], 0.015, 32);
  return [px + 0.25, Math.max(car.length / 2 + 0.15, 0.5)];
}

/**
 * A twin-tube fluorescent batten hung on chains at height y, along local x:
 * housing, reflector, tubes ('lit', 'off' or the stuttering 'flicker'), two
 * chains up to the roof at `roof`.
 */
export function batten(k: Kit, x: number, y: number, z: number, yaw: number, len: number, state: 'lit' | 'off' | 'flicker', roof: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.galv, len, 0.05, 0.2, 0, y + 0.03, 0);
  k.box(m.steel, len + 0.04, 0.03, 0.06, 0, y + 0.07, 0);
  const mat = state === 'lit' ? m.tube : state === 'flicker' ? m.tubeFlicker : m.tubeOff;
  for (const dz of [-0.05, 0.05]) k.cyl(mat, 0.019, len - 0.06, 0, y - 0.015, dz, 'x', 8);
  for (const dx of [-len * 0.4, len * 0.4]) k.bar(m.steel, [dx, y + 0.08, 0], [dx, roof, 0], 0.012);
}

/**
 * The roof: corrugated deck, steel trusses across the room every few meters
 * (chords, verticals, diagonals), purlins along it, and a conduit and an air
 * line running the length of it.
 */
export function roof(k: Kit, half: number, height: number): void {
  const m = k.m;
  k.place();
  k.plane(m.deck, 2 * half, 2 * half, 0, height, 0, 0, Math.PI / 2);
  const low = height - 0.75;
  for (let z = -half + 3; z < half - 1; z += 4.5) {
    k.box(m.steel, 2 * half, 0.14, 0.12, 0, low, z);
    k.box(m.steel, 2 * half, 0.12, 0.1, 0, height - 0.08, z);
    for (let x = -half + 1.5; x < half; x += 1.5) {
      k.box(m.steel, 0.06, 0.62, 0.06, x, (low + height) / 2, z);
      k.bar(m.steel, [x, low, z], [x + 1.5, height - 0.1, z], 0.05);
    }
  }
  for (let x = -half + 2; x < half; x += 3) k.box(m.rust, 0.1, 0.14, 2 * half, x, height - 0.2, 0);
  k.cyl(m.galv, 0.03, 2 * half, half - 0.6, height - 0.45, 0, 'z', 8);
  k.cyl(m.yellow, 0.025, 2 * half, half - 0.8, height - 0.45, 0, 'z', 8);
  k.cyl(m.galv, 0.035, 2 * half, 0, height - 0.95, -half + 0.5, 'x', 8);
}

// ---------------------------------------------------------------------------
// Work areas
// ---------------------------------------------------------------------------

/**
 * A workbench along local x against the wall behind it: worn top, steel legs,
 * a shelf of parts underneath, a vise, and the work in hand on top (a turbo, brake
 * discs, a laptop with a tune on screen, a toolbox, rags, cans).
 */
export function workbench(k: Kit, x: number, z: number, yaw: number, len: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.wood, len, 0.06, 0.8, 0, 0.92, 0);
  k.box(m.steel, len, 0.06, 0.04, 0, 0.88, 0.39);
  for (const dx of [-len / 2 + 0.08, len / 2 - 0.08]) for (const dz of [-0.32, 0.32]) k.box(m.steel, 0.05, 0.9, 0.05, dx, 0.45, dz);
  k.box(m.steel, len - 0.1, 0.04, 0.7, 0, 0.26, 0);
  // Under the bench: a tire, boxes and a parts crate.
  k.add(m.rubber, new THREE.TorusGeometry(0.27, 0.1, 10, 22), -len / 2 + 0.5, 0.38, 0.05, 0, Math.PI / 2);
  k.box(m.cardboard, 0.5, 0.32, 0.45, -len / 2 + 1.3, 0.44, 0);
  k.box(m.cardboard, 0.4, 0.24, 0.4, -len / 2 + 1.36, 0.72, 0.02);
  k.box(m.blue, 0.6, 0.3, 0.42, len / 2 - 0.6, 0.43, 0);
  // Vise at the right end.
  k.box(m.blue, 0.2, 0.14, 0.26, len / 2 - 0.3, 1.02, 0.28);
  k.box(m.steel, 0.24, 0.05, 0.06, len / 2 - 0.3, 1.09, 0.41);
  k.cyl(m.chrome, 0.012, 0.3, len / 2 - 0.3, 1.0, 0.48, 'x', 6);
  // A turbo: housing, compressor snail and an inlet.
  k.add(m.cast, new THREE.TorusGeometry(0.1, 0.055, 8, 16), len / 2 - 0.95, 1.07, 0.05, 0.3);
  k.cyl(m.chrome, 0.07, 0.12, len / 2 - 0.85, 1.07, 0.1, 'x', 12);
  k.cyl(m.galv, 0.05, 0.1, len / 2 - 0.95, 1.07, -0.08, 'z', 10);
  // Brake discs and calipers, a toolbox, a laptop.
  for (let i = 0; i < 3; i++) k.cyl(m.cast, 0.16, 0.028, -0.2 + i * 0.02, 0.965 + i * 0.03, -0.15 + i * 0.01, 'y', 20);
  k.box(m.red, 0.12, 0.08, 0.18, 0.2, 0.99, 0.15);
  k.box(m.red, 0.5, 0.22, 0.24, -len / 2 + 0.5, 1.06, -0.15);
  k.box(m.chrome, 0.4, 0.025, 0.025, -len / 2 + 0.5, 1.2, -0.15);
  k.box(m.black, 0.36, 0.02, 0.25, -0.9, 0.96, 0.12);
  k.box(m.black, 0.36, 0.24, 0.012, -0.9, 1.08, -0.02, 0, -0.25);
  k.plane(m.screen, 0.32, 0.2, -0.9, 1.08, -0.012, 0, -0.25);
  for (const [dx, dz, c] of [
    [0.6, -0.2, m.yellow],
    [0.68, -0.25, m.red],
    [-1.4, 0.2, m.galv],
  ] as const)
    k.cyl(c, 0.05, 0.2, dx, 1.05, dz, 'y', 10);
  k.box(m.orange, 0.3, 0.03, 0.22, -0.4, 0.965, 0.25, 0.4);
}

/** A rolling tool chest along local x: base cabinet and top box with drawer fronts, handle, casters, clutter on top. */
export function toolChest(k: Kit, x: number, z: number, yaw: number, w: number, body: THREE.Material, fronts: THREE.Material, top = true): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(body, w, 1.0, 0.5, 0, 0.6, 0);
  k.plane(fronts, w * 0.94, 0.92, 0, 0.6, 0.252);
  k.box(m.steel, w + 0.02, 0.03, 0.52, 0, 1.115, 0);
  k.cyl(m.chrome, 0.014, 0.42, w / 2 + 0.05, 0.9, 0, 'z', 6);
  for (const dx of [-w / 2 + 0.08, w / 2 - 0.08]) for (const dz of [-0.18, 0.18]) k.cyl(m.rubber, 0.05, 0.04, dx, 0.05, dz, 'x', 10);
  if (top) {
    k.box(body, w * 0.98, 0.42, 0.46, 0, 1.34, -0.02);
    k.plane(fronts, w * 0.92, 0.36, 0, 1.33, 0.212);
    k.box(body, w * 0.98, 0.04, 0.46, 0, 1.6, -0.24, 0, -0.5);
    k.cyl(m.galv, 0.04, 0.14, -w / 2 + 0.2, 1.62, 0);
    k.box(m.black, 0.3, 0.05, 0.12, w / 2 - 0.25, 1.58, 0.05, 0.3);
  } else {
    // A tool tray instead of a top box: sockets and a ratchet left out.
    k.box(m.steel, w * 0.8, 0.04, 0.3, 0, 1.14, 0.02);
    for (let i = 0; i < 5; i++) k.cyl(m.chrome, 0.018, 0.04, -0.2 + i * 0.08, 1.17, 0.05, 'y', 8);
    k.box(m.chrome, 0.26, 0.02, 0.03, 0.22, 1.16, -0.05, 0.6);
  }
}

/** Steel shelving along local x: four shelves of boxes, cans and parts, a different arrangement on each. */
export function shelving(k: Kit, x: number, z: number, yaw: number, w: number, seed: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const sx of [-w / 2, w / 2]) for (const sz of [-0.25, 0.25]) k.box(m.galv, 0.05, 2.6, 0.05, sx, 1.3, sz);
  const fill = [m.cardboard, m.cardboard, m.red, m.yellow, m.primer, m.blue, m.cardboard];
  for (let i = 0; i < 4; i++) {
    const y = 0.22 + i * 0.68;
    k.box(m.galv, w, 0.04, 0.56, 0, y, 0);
    let px = -w / 2 + 0.12;
    for (let j = 0; px < w / 2 - 0.2; j++) {
      const h = (seed * 7 + i * 13 + j * 5) % 7;
      const big = h % 3 !== 1;
      const bw = big ? 0.32 + (h % 3) * 0.08 : 0.14;
      const bh = big ? 0.24 + (h % 4) * 0.06 : 0.22;
      if (big) k.box(fill[h], bw, bh, 0.42, px + bw / 2, y + 0.02 + bh / 2, (h % 2) * 0.04);
      else k.cyl(fill[(h + 2) % fill.length], 0.06, bh, px + bw / 2, y + 0.02 + bh / 2, 0.1, 'y', 10);
      px += bw + 0.06;
    }
  }
}

/** A tire lying flat at (x, y, z) in room space, optionally on a wheel (one taken off a car). */
export function tire(k: Kit, x: number, y: number, z: number, wheel = false): void {
  const m = k.m;
  k.place();
  k.add(m.rubber, new THREE.TorusGeometry(0.26, 0.1, 10, 24), x, y, z, 0, Math.PI / 2);
  if (wheel) {
    k.cyl(m.chrome, 0.2, 0.17, x, y, z, 'y', 20);
    k.cyl(m.steel, 0.07, 0.19, x, y, z, 'y', 10);
  }
}

/** Tires stood in a wall rack along local x: two rails and a row of tires on edge. */
export function tireRack(k: Kit, x: number, z: number, yaw: number, n: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = n * 0.26 + 0.2;
  for (const y of [1.0, 2.3]) {
    for (const dz of [-0.12, 0.12]) k.box(m.galv, w, 0.04, 0.04, 0, y, dz);
    for (const dx of [-w / 2, w / 2]) k.box(m.galv, 0.05, y, 0.05, dx, y / 2, -0.2);
    for (let i = 0; i < n; i++) k.add(m.rubber, new THREE.TorusGeometry(0.29, 0.1, 10, 24), -w / 2 + 0.23 + i * 0.26, y + 0.32, 0, Math.PI / 2, 0, 0.04 * ((i % 3) - 1));
  }
}

/** An oil drum with its rolling hoops, a bung, and a tray under it. */
export function drum(k: Kit, x: number, z: number, mat: THREE.Material): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.cyl(mat, 0.29, 0.88, 0, 0.46, 0, 'y', 20);
  for (const y of [0.3, 0.62]) k.add(mat, new THREE.TorusGeometry(0.295, 0.015, 6, 24), 0, y, 0, 0, Math.PI / 2);
  k.cyl(m.galv, 0.03, 0.02, 0.12, 0.905, 0.05);
  k.box(m.black, 0.7, 0.03, 0.7, 0, 0.015, 0);
}

/** An air compressor: tank on wheels, motor, belt guard, a hose reel on the wall above. */
export function compressor(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.cyl(m.red, 0.24, 1.1, 0, 0.36, 0, 'x', 18);
  for (const dx of [-0.55, 0.55]) k.add(m.red, new THREE.SphereGeometry(0.24, 14, 8, 0, Math.PI * 2, 0, Math.PI), dx, 0.36, 0, 0, 0, dx > 0 ? -Math.PI / 2 : Math.PI / 2);
  k.box(m.black, 0.36, 0.26, 0.28, -0.2, 0.74, 0);
  k.cyl(m.cast, 0.1, 0.22, 0.2, 0.74, 0, 'x', 12);
  k.box(m.galv, 0.06, 0.32, 0.3, -0.42, 0.74, 0);
  for (const dx of [-0.4, 0.4]) k.cyl(m.rubber, 0.08, 0.06, dx, 0.08, 0.2, 'z', 12);
  k.cyl(m.chrome, 0.04, 0.03, 0.3, 0.62, 0.15, 'z', 10);
  k.add(m.yellow, new THREE.TorusGeometry(0.2, 0.035, 6, 20), 0, 2.0, -0.18);
  k.cyl(m.steel, 0.08, 0.1, 0, 2.0, -0.22, 'z', 10);
}

/**
 * An engine hoist with an engine hanging from it: the legs and casters, mast,
 * boom and ram in safety yellow, the chain, and a four cylinder on a leveler
 * (block, head, cam cover, intake runners, pulleys and a manifold).
 */
export function engineHoist(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const dx of [-0.38, 0.38]) {
    k.box(m.yellow, 0.1, 0.1, 1.5, dx, 0.12, 0.55);
    k.cyl(m.rubber, 0.06, 0.05, dx, 0.06, 1.25, 'x', 10);
  }
  k.box(m.yellow, 0.86, 0.1, 0.12, 0, 0.12, -0.2);
  k.box(m.yellow, 0.12, 1.6, 0.12, 0, 0.95, -0.15);
  k.bar(m.yellow, [0, 1.65, -0.2], [0, 2.05, 1.1], 0.11);
  k.bar(m.chrome, [0, 0.55, -0.05], [0, 1.6, 0.45], 0.05);
  k.bar(m.cast, [0, 0.55, -0.05], [0, 1.15, 0.22], 0.08);
  k.bar(m.steel, [0, 2.0, 1.1], [0, 1.5, 1.1], 0.02);
  k.bar(m.steel, [0, 1.5, 1.1], [-0.25, 1.32, 1.0], 0.015);
  k.bar(m.steel, [0, 1.5, 1.1], [0.25, 1.32, 1.2], 0.015);
  const ex = 0;
  const ey = 1.0;
  const ez = 1.1;
  k.box(m.cast, 0.42, 0.42, 0.62, ex, ey, ez);
  k.box(m.galv, 0.4, 0.14, 0.6, ex, ey + 0.28, ez);
  k.box(m.red, 0.3, 0.08, 0.56, ex + 0.02, ey + 0.39, ez);
  for (let i = 0; i < 4; i++) k.bar(m.galv, [ex - 0.2, ey + 0.28, ez - 0.22 + i * 0.15], [ex - 0.42, ey + 0.38, ez - 0.22 + i * 0.15], 0.05);
  k.box(m.galv, 0.1, 0.12, 0.6, ex - 0.45, ey + 0.4, ez);
  k.bar(m.rust, [ex + 0.22, ey + 0.2, ez - 0.2], [ex + 0.38, ey - 0.05, ez + 0.1], 0.07);
  k.cyl(m.cast, 0.1, 0.04, ex, ey - 0.05, ez + 0.33, 'z', 16);
  k.cyl(m.cast, 0.06, 0.04, ex + 0.12, ey + 0.15, ez + 0.33, 'z', 12);
  k.box(m.cast, 0.36, 0.14, 0.5, ex, ey - 0.28, ez);
  // Oil drips under it on a tray.
  k.box(m.black, 0.6, 0.03, 0.7, 0, 0.015, 1.1);
}

/** A floor jack with its handle up, a pair of jack stands and a creeper, round a car being worked on. */
export function jackAndStands(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.3, 0.14, 0.72, 0, 0.12, 0);
  k.cyl(m.cast, 0.07, 0.04, 0, 0.21, 0.32, 'y', 12);
  k.bar(m.chrome, [0, 0.16, -0.36], [0, 1.0, -0.9], 0.035);
  for (const dx of [-0.13, 0.13]) for (const dz of [-0.3, 0.3]) k.cyl(m.steel, 0.045, 0.04, dx, 0.045, dz, 'x', 10);
  for (const [sx, sz] of [
    [0.8, 0.3],
    [1.2, -0.2],
  ] as const) {
    k.cyl(m.red, 0.04, 0.42, sx, 0.22, sz, 'y', 4, 0.17);
    k.cyl(m.galv, 0.03, 0.35, sx, 0.5, sz, 'y', 8);
    k.box(m.galv, 0.1, 0.03, 0.06, sx, 0.68, sz);
  }
  k.box(m.black, 0.46, 0.04, 1.05, -0.9, 0.1, 0.4, 0.15);
  k.box(m.rubber, 0.36, 0.05, 0.22, -0.92, 0.13, 0.82, 0.15);
  for (const dx of [-0.18, 0.18]) for (const dz of [-0.45, 0.45]) k.cyl(m.rubber, 0.035, 0.03, -0.9 + dx + dz * 0.15, 0.04, 0.4 + dz, 'x', 8);
}

/** Body panels waiting to go on, along local x against a wall: a carbon hood leaned up, a primered bumper, a wing on its stands. */
export function panels(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.carbon, 1.35, 1.5, 0.04, -1.2, 0.74, -0.15, 0, -0.18);
  for (let i = 0; i < 5; i++) {
    const a = ((i - 2) / 2) * 0.55;
    k.box(m.primer, 0.42, 0.46, 0.08, 0.35 + Math.sin(a) * 0.9, 0.24, -0.05 + (1 - Math.cos(a)) * 0.9, a);
  }
  k.box(m.panel, 1.5, 0.04, 0.3, 1.9, 0.55, 0.1, 0, 0.12);
  for (const dx of [-0.45, 0.45]) k.box(m.panel, 0.03, 0.5, 0.18, 1.9 + dx, 0.3, 0.12);
  k.box(m.panel, 0.02, 0.24, 0.36, 1.9 - 0.76, 0.6, 0.1);
  k.box(m.panel, 0.02, 0.24, 0.36, 1.9 + 0.76, 0.6, 0.1);
}

/** A red fire extinguisher on a wall bracket, a sign board over it. */
export function extinguisher(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.cyl(m.red, 0.08, 0.5, 0, 1.0, 0.1, 'y', 12);
  k.box(m.black, 0.06, 0.1, 0.12, 0, 1.3, 0.1);
  k.box(m.galv, 0.18, 0.05, 0.08, 0, 0.9, 0.04);
  k.box(m.red, 0.24, 0.24, 0.01, 0, 1.6, 0.005);
}

// ---------------------------------------------------------------------------
// Tool storage and shop equipment
// ---------------------------------------------------------------------------

/** What stands on a roll cab: a top chest, a hutch with its own light, or the work left out on the worktop. */
export type CabTop = 'chest' | 'hutch' | 'bare';

/**
 * A pro roll cab along local x, the double-bank kind off a tool truck: two
 * banks of drawers on casters, a rubber bumper, end handles, a power strip and
 * a stainless worktop, side lockers at either end (`lockers`: -1 the left, 1
 * the right, 2 both) and on top a chest of drawers, a hutch (pegboard back,
 * overhead cabinet, an LED strip over the worktop) or the tools in use.
 * `open` leaves a drawer of the right bank pulled out with its wrenches;
 * `tall` runs the side lockers up to the top of the hutch.
 */
export function rollCab(k: Kit, x: number, z: number, yaw: number, w: number, body: THREE.Material, fronts: THREE.Material, top: CabTop, lockers: -1 | 0 | 1 | 2 = 0, open = false, tall = false): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const d = 0.62;
  const base = 0.17;
  const h = 0.9;
  const lw = 0.56;
  const chest = top === 'chest' ? 0.5 : 0;
  const sides = lockers === 2 ? [-1, 1] : lockers === 0 ? [] : [lockers];
  const x0 = -w / 2 - (sides.includes(-1) ? lw : 0);
  const x1 = w / 2 + (sides.includes(1) ? lw : 0);
  k.box(body, w, h, d, 0, base + h / 2, 0);
  for (const s of [-1, 1]) k.plane(fronts, w / 2 - 0.05, h - 0.08, (s * w) / 4, base + h / 2, d / 2 + 0.002);
  k.box(m.chrome, w - 0.04, 0.016, 0.012, 0, base + h - 0.02, d / 2 + 0.006);
  if (open) {
    const bw = w / 2 - 0.08;
    const fx = w / 4;
    const dy = base + h - 0.3;
    const out = 0.36;
    k.plane(m.black, bw, 0.1, fx, dy, d / 2 + 0.004);
    k.box(body, bw + 0.02, 0.1, 0.02, fx, dy, d / 2 + out);
    k.box(m.chrome, bw * 0.9, 0.018, 0.02, fx, dy + 0.02, d / 2 + out + 0.02);
    for (const s of [-1, 1]) k.box(m.steel, 0.01, 0.07, out, fx + (s * bw) / 2, dy - 0.005, d / 2 + out / 2);
    k.box(m.rubber, bw, 0.01, out - 0.02, fx, dy - 0.04, d / 2 + out / 2);
    for (let i = 0; i < 10; i++) k.box(m.chrome, 0.014, 0.008, 0.14 + i * 0.012, fx - bw / 2 + 0.04 + (i * (bw - 0.08)) / 9, dy - 0.03, d / 2 + out / 2, 0.15);
  }
  // Side lockers: a tall door each, its handle and vents, as high as the chest when there is one.
  const lh = h + (chest ? 0.03 + chest : tall ? 0.98 : 0);
  for (const s of sides) {
    const lx = s * (w / 2 + lw / 2);
    k.box(body, lw, lh, d, lx, base + lh / 2, 0);
    k.box(m.black, 0.008, lh, 0.006, s * (w / 2 + 0.004), base + lh / 2, d / 2 + 0.003);
    k.box(m.black, lw - 0.04, 0.008, 0.006, lx, base + 0.06, d / 2 + 0.003);
    k.box(m.chrome, 0.022, 0.32, 0.025, lx - s * (lw / 2 - 0.07), base + lh * 0.55, d / 2 + 0.016);
    for (let i = 0; i < 5; i++) k.box(m.black, lw * 0.5, 0.012, 0.006, lx, base + lh - 0.14 - i * 0.04, d / 2 + 0.003);
  }
  k.box(m.black, x1 - x0 + 0.03, 0.05, 0.04, (x0 + x1) / 2, base + 0.03, d / 2 + 0.01);
  const n = Math.max(2, Math.round((x1 - x0) / 0.9) + 1);
  for (let i = 0; i < n; i++) for (const cz of [-d / 2 + 0.1, d / 2 - 0.1]) caster(k, x0 + 0.1 + ((x1 - x0 - 0.2) * i) / (n - 1), cz, base);
  for (const s of [-1, 1]) {
    const ex = s > 0 ? x1 : x0;
    k.cyl(m.chrome, 0.014, d - 0.1, ex + s * 0.06, base + h - 0.12, 0, 'z', 6);
    for (const dz of [-(d / 2 - 0.08), d / 2 - 0.08]) k.box(m.chrome, 0.06, 0.02, 0.02, ex + s * 0.03, base + h - 0.12, dz);
  }
  k.box(m.black, 0.03, 0.06, 0.32, x1 + 0.015, base + h - 0.32, 0);
  const [t0, t1] = chest || tall ? [-w / 2, w / 2] : [x0, x1];
  const ty = base + h + 0.03;
  k.box(m.stainless, t1 - t0 + 0.03, 0.03, d + 0.03, (t0 + t1) / 2, ty - 0.015, 0);
  if (top === 'chest') {
    k.box(body, w - 0.02, chest, d - 0.06, 0, ty + chest / 2, -0.03);
    for (const s of [-1, 1]) k.plane(fronts, w / 2 - 0.06, chest - 0.1, (s * w) / 4, ty + chest / 2 - 0.02, d / 2 - 0.058);
    k.box(body, w, 0.04, d - 0.04, 0, ty + chest + 0.02, -0.03);
    k.box(m.chrome, w * 0.5, 0.02, 0.02, 0, ty + chest + 0.005, d / 2 - 0.04);
    carryBox(k, m.red, -w / 4, ty + chest + 0.04, -0.06);
    socketRail(k, w / 4, ty + chest + 0.04, 0.08, 10, m.red);
  } else if (top === 'hutch') {
    const hh = 0.95;
    const hd = 0.36;
    const bz = -d / 2 + 0.015;
    k.box(body, w, hh, 0.03, 0, ty + hh / 2, bz);
    for (const s of [-1, 1]) k.box(body, 0.03, hh, hd, s * (w / 2 - 0.015), ty + hh / 2, -d / 2 + hd / 2);
    k.plane(m.pegboard, w - 0.08, hh - 0.4, 0, ty + (hh - 0.38) / 2, bz + 0.016);
    // The overhead cabinet: two flip-up doors, their handles, the LED strip under it.
    k.box(body, w - 0.06, 0.34, hd, 0, ty + hh - 0.17, -d / 2 + hd / 2);
    k.box(m.black, 0.008, 0.32, 0.006, 0, ty + hh - 0.17, -d / 2 + hd + 0.003);
    for (const s of [-1, 1]) k.box(m.chrome, w * 0.25, 0.02, 0.02, (s * w) / 4, ty + hh - 0.31, -d / 2 + hd + 0.012);
    k.box(m.tube, w - 0.16, 0.012, 0.025, 0, ty + hh - 0.346, -d / 2 + hd - 0.05);
    k.box(m.black, w * 0.4, 0.05, 0.04, -w * 0.2, ty + 0.04, bz + 0.035);
    scanTool(k, -w / 2 + 0.3, ty, 0.02);
    socketRail(k, -0.05, ty, 0.12, 12, m.red);
    socketRail(k, 0.05, ty, 0.02, 9, m.black);
    impactGun(k, m.red, w / 2 - 0.28, ty, 0.05);
    torqueWrench(k, 0.1, ty, 0.22);
  } else {
    carryBox(k, m.black, x0 + 0.4, ty, -0.08);
    scanTool(k, 0.05, ty, -0.05);
    socketRail(k, x1 - 0.5, ty, 0.12, 11, m.red);
    impactGun(k, m.black, x1 - 0.3, ty, -0.12, -1);
    sprayCans(k, x0 + 0.85, ty, 0.12, 2);
  }
}

/**
 * A full-height tool locker against the wall behind it, along local x: a
 * shell, one door or two (vents, a handle, a label), the kick plate and a box
 * on top. `open` swings the right door out on its hinge to show the shelves:
 * air tools, a carry box, cans, cases and a coiled air line.
 */
export function locker(k: Kit, x: number, z: number, yaw: number, w: number, body: THREE.Material, open = false): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const h = 1.95;
  const d = 0.6;
  const t = 0.03;
  const fz = d / 2;
  for (const s of [-1, 1]) k.box(body, t, h, d, s * (w / 2 - t / 2), h / 2, 0);
  k.box(body, w, t, d, 0, h - t / 2, 0);
  k.box(body, w - 2 * t, t, d - t, 0, 0.1 + t / 2, t / 2);
  k.box(m.black, w - 2 * t, h - 0.1, t, 0, h / 2 + 0.05, -d / 2 + t / 2);
  k.box(m.black, w - 0.02, 0.1, d - 0.04, 0, 0.05, 0);
  const doors = w > 0.75 ? 2 : 1;
  const dw = w / doors;
  for (let i = 0; i < doors; i++) {
    const s = doors === 1 || i === 1 ? 1 : -1;
    const a = open && s === 1 ? 1.75 : 0;
    // A piece u along the door from its hinge and v out of its face, turned with the door.
    const put = (mat: THREE.Material, bw: number, bh: number, bd: number, u: number, y: number, v: number) =>
      k.box(mat, bw, bh, bd, (s * w) / 2 - s * Math.cos(a) * u + s * Math.sin(a) * v, y, fz + Math.sin(a) * u + Math.cos(a) * v, s * a);
    put(body, dw - 0.008, h - 0.13, 0.02, dw / 2, h / 2 + 0.04, -0.01);
    for (let j = 0; j < 5; j++) put(m.black, dw * 0.55, 0.012, 0.006, dw / 2, h - 0.22 - j * 0.04, 0.002);
    put(m.chrome, 0.022, 0.26, 0.03, dw - 0.06, 1.05, 0.015);
    if (i === 0) put(m.yellow, 0.1, 0.05, 0.004, dw / 2, h - 0.5, 0.002);
  }
  if (open) {
    const ix = doors === 2 ? w / 4 : 0;
    const iw = (doors === 2 ? w / 2 : w) - 2 * t;
    for (const y of [0.62, 1.08, 1.5]) k.box(m.galv, iw, 0.02, d - 0.08, ix, y, 0.01);
    k.add(m.yellow, new THREE.TorusGeometry(0.14, 0.03, 6, 18), ix, 0.16, 0, 0, Math.PI / 2);
    k.box(m.blue, iw * 0.8, 0.12, 0.34, ix, 0.39, -0.04);
    k.box(m.blue, iw * 0.7, 0.1, 0.3, ix + 0.02, 0.51, -0.06, 0.1);
    impactGun(k, m.red, ix - iw / 4, 0.63, 0.02);
    impactGun(k, m.black, ix + iw / 4, 0.63, -0.04, -1);
    carryBox(k, m.red, ix, 1.09, -0.02, Math.min(0.44, iw - 0.04));
    sprayCans(k, ix - iw / 2 + 0.06, 1.51, 0.08, 3);
    k.box(m.cardboard, iw * 0.45, 0.24, 0.36, ix + iw / 4, 1.63, -0.04);
  }
  k.box(m.cardboard, w * 0.55, 0.22, 0.4, (w - w * 0.55) / 2 - 0.05, h + 0.11, -0.04, 0.06);
}

/**
 * A three-tray utility cart along local x: lipped trays on corner posts, four
 * casters, the push handle at the left end, and a load picked by `seed`: an
 * impact gun, sockets and a scan tool, a torque wrench and brake cleaner, a
 * carry box, oil jugs and a coil of air line.
 */
export function utilityCart(k: Kit, x: number, z: number, yaw: number, body: THREE.Material, seed: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = 0.9;
  const d = 0.46;
  const trays = [0.24, 0.54, 0.86];
  for (const y of trays) {
    k.box(body, w, 0.02, d, 0, y, 0);
    for (const s of [-1, 1]) {
      k.box(body, w, 0.05, 0.015, 0, y + 0.025, s * (d / 2 - 0.007));
      k.box(body, 0.015, 0.05, d, s * (w / 2 - 0.007), y + 0.025, 0);
    }
  }
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.box(body, 0.03, 0.76, 0.03, sx * (w / 2 - 0.015), 0.51, sz * (d / 2 - 0.015));
      caster(k, sx * (w / 2 - 0.06), sz * (d / 2 - 0.07), 0.13);
    }
  for (const sz of [-1, 1]) k.bar(m.chrome, [-w / 2 + 0.01, 0.88, sz * (d / 2 - 0.03)], [-w / 2 - 0.1, 1.02, sz * (d / 2 - 0.03)], 0.022);
  k.cyl(m.black, 0.02, d - 0.04, -w / 2 - 0.1, 1.02, 0, 'z', 8);
  const [lo, mid, up] = trays.map((y) => y + 0.01);
  if (seed % 2 === 0) {
    impactGun(k, m.red, -0.22, up, 0.06);
    socketRail(k, 0.12, up, -0.1, 10, m.red);
    scanTool(k, 0.22, up, 0.06);
  } else {
    torqueWrench(k, 0, up, -0.12);
    sprayCans(k, -0.3, up, 0.08, 3);
    k.box(m.orange, 0.3, 0.025, 0.22, 0.2, up + 0.012, 0.06, 0.35);
  }
  carryBox(k, seed % 3 === 0 ? m.black : m.red, -0.1, mid, 0);
  sprayCans(k, 0.3, mid, -0.08, seed % 3);
  for (let i = 0; i < 2; i++) {
    k.box(m.yellow, 0.16, 0.26, 0.1, -0.3 + i * 0.2, lo + 0.13, -0.08);
    k.cyl(m.black, 0.022, 0.03, -0.25 + i * 0.2, lo + 0.275, -0.08, 'y', 8);
  }
  k.add(m.yellow, new THREE.TorusGeometry(0.13, 0.025, 6, 18), 0.22, lo + 0.03, 0.04, 0, Math.PI / 2);
}

/**
 * A tire changer facing local +z: the red base with its three pedals, the
 * clamping turntable with a wheel on it, the tower, arm and mount head over
 * the rim, the bead breaker on the right with its rubber pad, the inflation
 * gauge and the bead lube bucket.
 */
export function tireChanger(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.78, 0.74, 0.96, 0, 0.4, 0);
  k.box(m.black, 0.8, 0.04, 0.98, 0, 0.02, 0);
  k.box(m.black, 0.6, 0.02, 0.62, 0, 0.775, 0.12);
  for (const dx of [-0.2, 0, 0.2]) k.box(m.black, 0.09, 0.04, 0.2, dx, 0.07, 0.56, 0, -0.15);
  const tz = 0.12;
  k.cyl(m.galv, 0.4, 0.05, 0, 0.81, tz, 'y', 24);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    k.box(m.steel, 0.07, 0.07, 0.13, Math.cos(a) * 0.3, 0.87, tz + Math.sin(a) * 0.3, Math.PI / 2 - a);
  }
  k.add(m.rubber, new THREE.TorusGeometry(0.27, 0.1, 10, 24), 0, 0.97, tz, 0, Math.PI / 2);
  k.cyl(m.chrome, 0.2, 0.17, 0, 0.97, tz, 'y', 20);
  // Tower, arm, the hex shaft down to the mount head at the rim.
  k.box(m.red, 0.2, 1.25, 0.2, 0, 1.36, -0.38);
  k.cyl(m.galv, 0.05, 0.6, 0, 1.2, -0.52, 'y', 10);
  k.box(m.red, 0.12, 0.12, 0.56, 0, 1.9, -0.12);
  k.box(m.black, 0.08, 0.1, 0.06, 0.07, 1.9, 0.1);
  k.box(m.chrome, 0.04, 0.8, 0.04, 0, 1.5, -0.1);
  k.box(m.black, 0.07, 0.07, 0.11, 0, 1.1, -0.07);
  // Bead breaker on the right: ram, arm and blade, the rubber pad on the cabinet.
  k.cyl(m.galv, 0.06, 0.46, 0.46, 0.5, -0.26, 'z', 12);
  k.bar(m.red, [0.46, 0.62, -0.42], [0.66, 0.52, 0.28], 0.06);
  k.box(m.steel, 0.03, 0.16, 0.14, 0.62, 0.42, 0.3);
  k.box(m.rubber, 0.02, 0.3, 0.46, 0.4, 0.42, 0.12);
  // The inflation gauge on the tower, its hose looped down; the lube bucket hung on the left.
  k.box(m.black, 0.12, 0.14, 0.06, -0.16, 1.4, -0.32);
  k.cyl(m.chrome, 0.045, 0.02, -0.16, 1.42, -0.28, 'z', 14);
  k.hose(m.rubber, [[-0.16, 1.33, -0.3], [-0.3, 1.0, -0.2], [-0.42, 0.85, 0.05], [-0.3, 0.95, 0.15]], 0.01, 24);
  k.cyl(m.blue, 0.08, 0.12, -0.47, 0.62, 0.25, 'y', 12);
  k.box(m.galv, 0.04, 0.02, 0.1, -0.41, 0.69, 0.25);
}

/**
 * A wheel balancer facing local +z: the cabinet with its tray of weights, the
 * console on a mast (lit readouts), the shaft out of the right side with a
 * wheel spun up on it and the hood raised behind it, the cones on their peg.
 */
export function wheelBalancer(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.gunmetal, 0.62, 0.82, 0.6, 0, 0.41, 0);
  k.box(m.black, 0.64, 0.05, 0.5, 0, 0.845, 0.04);
  for (let i = 0; i < 8; i++) k.box(m.chrome, 0.05, 0.02, 0.05, -0.25 + i * 0.07, 0.88, 0.0 + (i % 2) * 0.12);
  k.box(m.gunmetal, 0.06, 0.5, 0.06, 0, 1.1, -0.26);
  k.box(m.black, 0.56, 0.34, 0.08, 0, 1.45, -0.24, 0, -0.2);
  k.plane(m.screen, 0.46, 0.22, 0, 1.47, -0.198, 0, -0.2);
  k.cyl(m.chrome, 0.03, 0.5, 0.52, 0.66, 0, 'x', 10);
  k.cyl(m.cast, 0.09, 0.05, 0.34, 0.66, 0, 'x', 14);
  k.add(m.rubber, new THREE.TorusGeometry(0.28, 0.1, 10, 24), 0.58, 0.66, 0, Math.PI / 2);
  k.cyl(m.chrome, 0.21, 0.18, 0.58, 0.66, 0, 'x', 20);
  k.cyl(m.black, 0.05, 0.12, 0.74, 0.66, 0, 'x', 10);
  const hood = new THREE.CylinderGeometry(0.48, 0.48, 0.36, 14, 1, true, Math.PI * 0.5, Math.PI * 0.6);
  hood.rotateZ(Math.PI / 2);
  k.add(m.gunmetal, hood, 0.58, 0.72, -0.12);
  k.bar(m.gunmetal, [0.32, 0.8, -0.28], [0.5, 1.12, -0.24], 0.04);
  k.cyl(m.chrome, 0.015, 0.22, -0.4, 0.62, 0, 'x', 6);
  for (let i = 0; i < 3; i++) k.cyl(m.chrome, 0.05 + i * 0.012, 0.05, -0.38 - i * 0.055, 0.62, 0, 'x', 12, 0.08 + i * 0.012);
}

/**
 * A MIG welder on its cart facing local +z: deck, wheels and casters, the set
 * with its knobs and readout, the gas bottle chained behind it with the
 * regulator, the torch lead coiled on the side and a helmet on top.
 */
export function welder(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.steel, 0.46, 0.03, 0.72, 0, 0.2, 0);
  for (const s of [-1, 1]) {
    k.cyl(m.rubber, 0.13, 0.06, s * 0.27, 0.13, -0.24, 'x', 16);
    k.cyl(m.galv, 0.05, 0.065, s * 0.27, 0.13, -0.24, 'x', 10);
    caster(k, s * 0.16, 0.27, 0.185);
  }
  k.box(m.blue, 0.36, 0.44, 0.58, 0, 0.44, 0.04);
  k.box(m.black, 0.32, 0.36, 0.01, 0, 0.44, 0.335);
  for (const dx of [-0.08, 0.08]) k.cyl(m.chrome, 0.025, 0.03, dx, 0.4, 0.345, 'z', 10);
  k.plane(m.screen, 0.1, 0.04, 0, 0.55, 0.341);
  k.box(m.galv, 0.01, 0.3, 0.4, 0.185, 0.46, 0.02);
  // Handle and the bottle on its platform behind.
  for (const s of [-1, 1]) k.box(m.steel, 0.025, 0.9, 0.025, s * 0.2, 0.65, -0.34);
  k.cyl(m.chrome, 0.015, 0.42, 0, 1.1, -0.34, 'x', 8);
  k.box(m.steel, 0.3, 0.02, 0.26, 0, 0.21, -0.48);
  k.cyl(m.primer, 0.11, 0.96, 0, 0.7, -0.48, 'y', 16);
  k.add(m.primer, new THREE.SphereGeometry(0.11, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.18, -0.48);
  k.cyl(m.chrome, 0.02, 0.1, 0, 1.32, -0.48, 'y', 8);
  k.box(m.galv, 0.06, 0.06, 0.08, 0, 1.38, -0.46);
  for (const dx of [-0.05, 0.05]) k.cyl(m.chrome, 0.03, 0.02, dx, 1.4, -0.41, 'z', 12);
  k.box(m.steel, 0.4, 0.012, 0.012, 0, 0.95, -0.37);
  // The torch lead coiled on the left, the earth clamp hung by it, a helmet on top.
  k.add(m.rubber, new THREE.TorusGeometry(0.15, 0.016, 6, 24), -0.2, 0.46, 0.04, Math.PI / 2);
  k.box(m.black, 0.04, 0.16, 0.04, -0.22, 0.4, 0.2, 0, 0.5);
  k.box(m.red, 0.03, 0.08, 0.05, -0.2, 0.52, -0.2);
  k.add(m.black, new THREE.SphereGeometry(0.13, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.66, 0.08);
  k.box(m.carbon, 0.12, 0.06, 0.02, 0, 0.72, 0.205);
}

/** A portable toolbox standing at (x, y, z) in the current frame along x: box, lid, latches and the carry handle. */
export function carryBox(k: Kit, mat: THREE.Material, x: number, y: number, z: number, w = 0.48): void {
  const m = k.m;
  k.box(mat, w, 0.17, 0.22, x, y + 0.085, z);
  k.box(mat, w + 0.012, 0.05, 0.232, x, y + 0.195, z);
  for (const s of [-1, 1]) {
    k.box(m.chrome, 0.04, 0.05, 0.012, x + s * w * 0.32, y + 0.17, z + 0.115);
    k.box(m.black, 0.02, 0.06, 0.02, x + s * 0.11, y + 0.25, z);
  }
  k.box(m.black, 0.25, 0.025, 0.03, x, y + 0.29, z);
}

/** A caster whose top plate is at height y, in the current frame: swivel plate, fork and wheel. */
function caster(k: Kit, x: number, z: number, y: number): void {
  const m = k.m;
  const r = y * 0.38;
  k.box(m.steel, 0.08, 0.012, 0.08, x, y - 0.006, z);
  for (const s of [-1, 1]) k.box(m.steel, 0.008, y - r * 0.6, r * 1.3, x + s * 0.028, (y + r * 0.6) / 2, z);
  k.cyl(m.rubber, r, 0.04, x, r, z, 'x', 12);
}

/** A socket rail of n sockets, smallest at the left, standing at (x, y, z) in the current frame along x. */
function socketRail(k: Kit, x: number, y: number, z: number, n: number, rail: THREE.Material): void {
  const radii = Array.from({ length: n }, (_, i) => 0.009 + i * 0.0012);
  const len = radii.reduce((a, r) => a + 2 * r + 0.006, 0.02);
  k.box(rail, len, 0.012, 0.03, x, y + 0.006, z);
  let px = x - len / 2 + 0.01;
  radii.forEach((r, i) => {
    const sh = 0.028 + i * 0.002;
    k.cyl(k.m.chrome, r, sh, px + r + 0.003, y + 0.012 + sh / 2, z, 'y', 8);
    px += 2 * r + 0.006;
  });
}

/** A cordless impact gun stood on its battery at (x, y, z) in the current frame, its anvil toward +x (dir 1) or -x. */
function impactGun(k: Kit, mat: THREE.Material, x: number, y: number, z: number, dir = 1): void {
  const m = k.m;
  k.box(m.black, 0.1, 0.065, 0.075, x, y + 0.033, z);
  k.box(m.black, 0.04, 0.12, 0.045, x, y + 0.125, z);
  k.box(mat, 0.17, 0.075, 0.068, x + dir * 0.04, y + 0.22, z);
  k.cyl(m.chrome, 0.018, 0.05, x + dir * 0.15, y + 0.22, z, 'x', 8);
}

/** A diagnostic tablet in its rugged case leant back on its stand at (x, y, z) in the current frame, the screen lit. */
function scanTool(k: Kit, x: number, y: number, z: number): void {
  const m = k.m;
  const rx = -0.45;
  k.box(m.black, 0.3, 0.21, 0.03, x, y + 0.1, z, 0, rx);
  k.plane(m.screen, 0.24, 0.15, x, y + 0.1 - 0.016 * Math.sin(rx), z + 0.016 * Math.cos(rx), 0, rx);
  k.box(m.yellow, 0.31, 0.02, 0.035, x, y + 0.01, z + 0.04);
}

/** A click torque wrench lying along x at (x, y, z) in the current frame: ratchet head, chrome tube, scale, grip. */
function torqueWrench(k: Kit, x: number, y: number, z: number): void {
  const m = k.m;
  k.cyl(m.chrome, 0.013, 0.42, x, y + 0.014, z, 'x', 8);
  k.box(m.chrome, 0.05, 0.022, 0.04, x - 0.23, y + 0.014, z);
  k.cyl(m.black, 0.018, 0.14, x + 0.27, y + 0.018, z, 'x', 8);
}

/** n spray cans in a row along x from (x, y, z) in the current frame (brake cleaner, penetrant, paint). */
function sprayCans(k: Kit, x: number, y: number, z: number, n: number): void {
  const m = k.m;
  const colors = [m.red, m.blue, m.yellow];
  for (let i = 0; i < n; i++) {
    k.cyl(colors[i % 3], 0.032, 0.19, x + i * 0.075, y + 0.095, z, 'y', 10);
    k.cyl(m.galv, 0.024, 0.04, x + i * 0.075, y + 0.21, z, 'y', 8);
  }
}

// ---------------------------------------------------------------------------
// Walls and ceiling: tool boards, cabinets, the jobs board, reels
// ---------------------------------------------------------------------------

/**
 * A louvred steel tool board on a wall, centered at height y along local x:
 * a wrench rack, a screwdriver rack, hammers, pliers, ratchets and a magnetic
 * socket rail, each hung where it belongs, as many as the width holds at the
 * spacing the cabs' hutches use, under an LED strip washing down over them
 * the way the hutches are lit.
 */
export function toolBoard(k: Kit, x: number, y: number, z: number, yaw: number, w: number, h: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.gunmetal, w, h, 0.02, 0, 0, 0.01);
  for (let i = 0; i < Math.floor(h / 0.09); i++) k.box(m.black, w - 0.08, 0.008, 0.004, 0, -h / 2 + 0.05 + i * 0.09, 0.022);
  k.box(m.steel, w, 0.04, 0.08, 0, h / 2 + 0.02, 0.06);
  k.box(m.tube, w - 0.1, 0.012, 0.025, 0, h / 2 - 0.006, 0.08);
  k.plane(m.wash, w - 0.06, h, 0, 0, 0.026);
  const top = h / 2 - 0.08;
  // Wrenches, short to long, ring ends down.
  const ww = w * 0.45;
  k.box(m.black, ww, 0.02, 0.03, -w / 2 + 0.04 + ww / 2, top, 0.035);
  const nw = Math.max(12, Math.floor((ww - 0.06) / 0.045) + 1);
  for (let i = 0; i < nw; i++) {
    const f = i / (nw - 1);
    const len = 0.12 + f * 0.18;
    const wx = -w / 2 + 0.07 + f * (ww - 0.06);
    k.box(m.chrome, 0.016, len, 0.006, wx, top - 0.01 - len / 2, 0.04);
    k.cyl(m.chrome, 0.014 + f * 0.009, 0.008, wx, top - 0.01 - len, 0.04, 'z', 10);
  }
  // A second, shorter set across the middle on its own rail, where a wide board has the room.
  if (h >= 1.2) {
    const mw = w - 0.2;
    const mn = Math.floor(mw / 0.04) + 1;
    k.box(m.black, mw, 0.02, 0.03, 0, 0.08, 0.035);
    for (let i = 0; i < mn; i++) {
      const f = i / (mn - 1);
      const len = 0.08 + f * 0.13;
      const wx = -mw / 2 + f * mw;
      k.box(m.chrome, 0.013, len, 0.006, wx, 0.07 - len / 2, 0.04);
      k.cyl(m.chrome, 0.011 + f * 0.007, 0.008, wx, 0.07 - len, 0.04, 'z', 10);
    }
  }
  // Screwdrivers through their rack, handles up.
  const sx = w * 0.18;
  const sw = w * 0.32;
  k.box(m.black, sw, 0.02, 0.06, sx, top, 0.05);
  const colors = [m.red, m.yellow, m.black, m.blue];
  const ns = Math.max(9, Math.floor((sw - 0.06) / 0.045) + 1);
  Array.from({ length: ns }, (_, i) => colors[(i * 3 + (i >> 2)) % 4]).forEach((mat, i) => {
    const px = sx - sw / 2 + 0.03 + (i * (sw - 0.06)) / (ns - 1);
    k.cyl(mat, 0.013, 0.09, px, top + 0.055, 0.055, 'y', 8);
    const len = 0.1 + (i % 3) * 0.04;
    k.cyl(m.chrome, 0.004, len, px, top - 0.01 - len / 2, 0.055, 'y', 5);
  });
  // Lower left: hammers hung by their heads, pliers in a V, two ratchets.
  const low = -h / 2 + 0.12;
  for (let i = 0; i < 3; i++) {
    const hx = -w / 2 + 0.1 + i * 0.11;
    k.box(m.wood, 0.025, 0.28 - i * 0.03, 0.025, hx, low + 0.14, 0.04);
    k.box(m.steel, 0.1 - i * 0.015, 0.035, 0.035, hx, low + 0.29 - i * 0.03, 0.045);
  }
  for (let i = 0; i < 3; i++) {
    const px = -w / 2 + 0.48 + i * 0.09;
    for (const s of [-1, 1]) k.box(m.red, 0.014, 0.16, 0.01, px + s * 0.018, low + 0.09, 0.035, 0, 0, s * 0.12);
    k.box(m.chrome, 0.02, 0.06, 0.012, px, low + 0.2, 0.035);
  }
  for (let i = 0; i < 2; i++) {
    const rx = -0.05 + i * 0.09;
    k.box(m.chrome, 0.016, 0.24 + i * 0.06, 0.008, rx, low + 0.12 + i * 0.03, 0.035);
    k.cyl(m.chrome, 0.024, 0.016, rx, low + 0.26 + i * 0.06, 0.04, 'z', 12);
  }
  // Lower right: a magnetic rail of sockets standing out of the board.
  const rx0 = w * 0.12;
  const rw = w * 0.36;
  k.box(m.red, rw, 0.03, 0.012, rx0 + rw / 2, low + 0.06, 0.028);
  const nk = Math.max(10, Math.floor((rw - 0.06) / 0.042) + 1);
  for (let i = 0; i < nk; i++) {
    const f = i / (nk - 1);
    k.cyl(m.chrome, 0.012 + f * 0.0135, 0.04 + f * 0.018, rx0 + 0.03 + f * (rw - 0.06), low + 0.06, 0.06, 'z', 8);
  }
  k.box(m.black, rw, 0.02, 0.03, rx0 + rw / 2, low + 0.22, 0.035);
  for (let i = 0; i < 6; i++) k.box(m.chrome, 0.02, 0.09 + i * 0.012, 0.012, rx0 + 0.04 + (i * (rw - 0.08)) / 5, low + 0.21 - (0.09 + i * 0.012) / 2, 0.04);
}

/** A run of wall cabinets centered at height y along local x: n doors with their seams and handles, a light strip under them. */
export function wallCabinets(k: Kit, x: number, y: number, z: number, yaw: number, w: number, n: number, body: THREE.Material): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  const d = 0.36;
  k.box(body, w, 0.6, d, 0, 0, d / 2);
  for (let i = 1; i < n; i++) k.box(m.black, 0.008, 0.58, 0.006, -w / 2 + (i * w) / n, 0, d + 0.003);
  for (let i = 0; i < n; i++) k.box(m.chrome, 0.02, 0.14, 0.025, -w / 2 + ((i + 0.5) * w) / n + (i % 2 ? -1 : 1) * (w / n / 2 - 0.06), -0.18, d + 0.012);
  k.box(m.tube, w - 0.12, 0.012, 0.025, 0, -0.306, d - 0.06);
  k.plane(m.wash, w - 0.1, 0.75, 0, -0.31 - 0.375, 0.004);
}

/** The jobs whiteboard centered at height y on a wall: aluminium frame, the board, the marker tray with markers and an eraser. */
export function whiteboard(k: Kit, x: number, y: number, z: number, yaw: number, w: number, h: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.galv, w + 0.04, h + 0.04, 0.02, 0, 0, 0.01);
  k.plane(m.whiteboard, w, h, 0, 0, 0.021);
  k.box(m.galv, w * 0.6, 0.02, 0.06, 0, -h / 2 - 0.02, 0.04);
  [m.blue, m.red, m.black].forEach((c, i) => k.cyl(c, 0.008, 0.12, -0.1 + i * 0.05, -h / 2 - 0.002, 0.05, 'x', 6));
  k.box(m.black, 0.12, 0.03, 0.045, 0.2, -h / 2 + 0.005, 0.045);
}

/** A clipboard with a work order on it, hung at (x, y, z) facing local +z. */
export function clipboard(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.wood, 0.24, 0.32, 0.008, 0, 0, 0.004);
  k.plane(m.workOrder, 0.21, 0.29, 0, -0.01, 0.0095);
  k.box(m.chrome, 0.1, 0.03, 0.012, 0, 0.15, 0.012);
}

/**
 * A reel hung from the roof truss at height `y` (its center): the bracket up
 * to the chord at `chord`, the reel's flanges and drum with the line wound on
 * it, and the line run down to `end` (room space) with an air coupler and its
 * stop ball, or a caged drop light glowing at the end of a cord.
 */
export function ceilingReel(k: Kit, x: number, y: number, z: number, chord: number, line: THREE.Material, end: Vec, kind: 'air' | 'lamp'): void {
  const m = k.m;
  k.place();
  k.box(m.steel, 0.06, chord - y, 0.06, x, (chord + y) / 2, z);
  k.box(m.steel, 0.3, 0.03, 0.12, x, chord - 0.015, z);
  for (const s of [-1, 1]) {
    k.cyl(m.steel, 0.24, 0.015, x + s * 0.09, y, z, 'x', 18);
    k.box(m.steel, 0.02, 0.12, 0.04, x + s * 0.09, y + 0.1, z);
  }
  k.cyl(line, 0.17, 0.16, x, y, z, 'x', 16);
  k.cyl(m.galv, 0.06, 0.24, x, y, z, 'x', 8);
  const [ex, ey, ez] = end;
  k.hose(line, [[x, y - 0.17, z + 0.05], [x + (ex - x) * 0.3, y - 0.6, z + (ez - z) * 0.3], [ex, (y + ey) / 2, ez], [ex, ey, ez]], kind === 'air' ? 0.012 : 0.01, 40);
  if (kind === 'air') {
    k.cyl(m.yellow, 0.035, 0.05, ex, ey + 0.22, ez, 'y', 10);
    k.cyl(m.chrome, 0.012, 0.08, ex, ey - 0.04, ez, 'y', 8);
  } else {
    k.cyl(m.lamp, 0.035, 0.2, ex, ey - 0.12, ez, 'y', 10);
    for (const a of [0, 1.57, 3.14, 4.71]) k.box(m.galv, 0.008, 0.22, 0.008, ex + Math.cos(a) * 0.05, ey - 0.12, ez + Math.sin(a) * 0.05);
    k.cyl(m.rubber, 0.03, 0.08, ex, ey - 0.01, ez, 'y', 10);
    k.box(m.galv, 0.012, 0.14, 0.04, ex, ey + 0.06, ez + 0.04);
  }
}

// ---------------------------------------------------------------------------
// Shop machines
// ---------------------------------------------------------------------------

/** A parts washer against a wall, facing local +z: the red base, the sink with its solvent, the lid propped open, the flex tap and a brush. */
export function partsWasher(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.9, 0.62, 0.55, 0, 0.31, 0);
  k.box(m.galv, 0.96, 0.22, 0.6, 0, 0.73, 0);
  k.box(m.carbon, 0.88, 0.01, 0.52, 0, 0.8, 0);
  k.box(m.galv, 0.96, 0.6, 0.02, 0, 1.12, -0.33, 0, -0.14);
  k.bar(m.steel, [0.42, 0.84, -0.28], [0.42, 1.38, -0.4], 0.008);
  k.hose(m.chrome, [[0.36, 0.84, -0.27], [0.36, 1.06, -0.2], [0.3, 1.02, 0.0], [0.26, 0.9, 0.06]], 0.012, 16);
  k.box(m.yellow, 0.05, 0.04, 0.24, -0.25, 0.86, 0.1, 0.4);
  k.box(m.black, 0.2, 0.16, 0.16, 0.25, 0.4, 0.28);
  k.box(m.yellow, 0.18, 0.1, 0.004, -0.2, 0.45, 0.277);
}

/** A bench grinder on its pedestal: base, column, motor, two stones under their guards with rests and eye shields, a quench pot. */
export function benchGrinder(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.cast, 0.4, 0.03, 0.4, 0, 0.015, 0);
  k.cyl(m.cast, 0.045, 0.95, 0, 0.5, 0, 'y', 10);
  k.box(m.cast, 0.24, 0.02, 0.2, 0, 0.98, 0);
  k.cyl(m.gunmetal, 0.08, 0.26, 0, 1.08, 0, 'x', 14);
  k.box(m.black, 0.06, 0.04, 0.04, 0, 1.0, 0.1);
  for (const s of [-1, 1]) {
    k.cyl(m.primer, 0.075, 0.03, s * 0.19, 1.08, 0, 'x', 18);
    k.box(m.gunmetal, 0.05, 0.06, 0.18, s * 0.19, 1.16, -0.01);
    k.box(m.gunmetal, 0.05, 0.12, 0.04, s * 0.19, 1.09, -0.09);
    k.box(m.cast, 0.05, 0.01, 0.06, s * 0.19, 1.03, 0.1);
    k.box(m.carbon, 0.08, 0.06, 0.005, s * 0.19, 1.22, 0.08, 0, -0.5);
  }
  k.cyl(m.galv, 0.06, 0.1, 0.16, 0.99, 0.05, 'y', 10);
}

/** A floor drill press: base, column, the table on its collar with a vise, the head and belt cover, motor behind, quill, chuck and the feed handles. */
export function drillPress(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.gunmetal, 0.45, 0.06, 0.6, 0, 0.03, -0.05);
  k.cyl(m.chrome, 0.04, 1.55, 0, 0.83, -0.2, 'y', 12);
  k.cyl(m.gunmetal, 0.07, 0.1, 0, 0.75, -0.2, 'y', 12);
  k.box(m.gunmetal, 0.08, 0.05, 0.25, 0, 0.75, -0.06);
  k.cyl(m.gunmetal, 0.15, 0.04, 0, 0.79, 0.08, 'y', 18);
  k.box(m.blue, 0.14, 0.07, 0.1, 0, 0.845, 0.08);
  k.box(m.gunmetal, 0.22, 0.26, 0.42, 0, 1.5, -0.08);
  k.box(m.gunmetal, 0.26, 0.1, 0.5, 0, 1.68, -0.1);
  k.cyl(m.gunmetal, 0.08, 0.24, 0, 1.52, -0.42, 'y', 12);
  k.cyl(m.chrome, 0.03, 0.14, 0, 1.31, 0.06, 'y', 10);
  k.cyl(m.chrome, 0.015, 0.07, 0, 1.21, 0.06, 'y', 10, 0.026);
  k.cyl(m.steel, 0.004, 0.08, 0, 1.13, 0.06, 'y', 5);
  for (const a of [0.4, 2.5, 4.6]) k.bar(m.chrome, [0.12, 1.45, -0.04], [0.12, 1.45 + Math.sin(a) * 0.2, -0.04 + Math.cos(a) * 0.2], 0.012);
  k.box(m.yellow, 0.05, 0.07, 0.02, -0.07, 1.55, 0.135);
}

/** A hydraulic shop press: the red H-frame, its bed on pins with V-blocks, the bottle ram, the pump and handle, the gauge. */
export function hydraulicPress(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const s of [-1, 1]) {
    k.box(m.red, 0.08, 1.8, 0.12, s * 0.42, 0.9, 0);
    k.box(m.red, 0.1, 0.06, 0.5, s * 0.42, 0.03, 0);
    k.cyl(m.chrome, 0.015, 0.18, s * 0.42, 0.63, 0, 'z', 8);
    k.box(m.cast, 0.14, 0.08, 0.12, s * 0.12, 0.82, 0);
  }
  for (const dz of [-0.05, 0.05]) {
    k.box(m.red, 0.92, 0.12, 0.03, 0, 1.75, dz);
    k.box(m.red, 0.8, 0.12, 0.03, 0, 0.72, dz);
  }
  k.cyl(m.black, 0.06, 0.3, 0, 1.54, 0, 'y', 12);
  k.cyl(m.chrome, 0.035, 0.22, 0, 1.29, 0, 'y', 10);
  k.box(m.black, 0.12, 0.1, 0.2, 0.56, 0.9, 0);
  k.bar(m.chrome, [0.56, 0.95, 0.05], [0.8, 1.3, 0.25], 0.015);
  k.cyl(m.enamel, 0.045, 0.02, 0.2, 1.75, 0.07, 'z', 14);
  k.hose(m.rubber, [[0.56, 0.95, -0.08], [0.5, 1.3, -0.1], [0.1, 1.62, -0.08]], 0.01, 16);
}

/** A sandblast cabinet on legs facing local +z: hopper, cabinet, the slanted window, glove ports with the gloves, side door, the dust collector and its hose. */
export function sandblaster(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(m.gunmetal, 0.04, 0.82, 0.04, sx * 0.5, 0.41, sz * 0.34);
  k.add(m.gunmetal, new THREE.CylinderGeometry(0.42, 0.06, 0.3, 4), 0, 0.66, 0, Math.PI / 4);
  k.box(m.gunmetal, 1.1, 0.6, 0.78, 0, 1.1, 0);
  k.box(m.gunmetal, 1.1, 0.32, 0.51, 0, 1.56, -0.135);
  k.box(m.gunmetal, 1.1, 0.42, 0.04, 0, 1.56, 0.255, 0, -0.7);
  k.box(m.carbon, 0.8, 0.28, 0.01, 0, 1.56 + 0.025 * Math.sin(0.7), 0.255 + 0.025 * Math.cos(0.7), 0, -0.7);
  for (const s of [-1, 1]) {
    k.cyl(m.rubber, 0.08, 0.02, s * 0.22, 1.12, 0.395, 'z', 14);
    k.box(m.rubber, 0.1, 0.16, 0.05, s * 0.22, 0.98, 0.41, 0, 0.3);
  }
  k.box(m.black, 0.01, 0.42, 0.52, 0.555, 1.1, 0);
  k.box(m.black, 0.16, 0.04, 0.2, 0.2, 0.02, 0.4);
  k.cyl(m.gunmetal, 0.2, 0.6, 0.82, 0.3, -0.1, 'y', 14);
  k.box(m.black, 0.42, 0.04, 0.42, 0.82, 0.62, -0.1);
  k.hose(m.rubber, [[0.82, 0.64, -0.1], [0.8, 1.1, -0.25], [0.5, 1.4, -0.38]], 0.04, 16);
}

/** An A/C recovery machine on its wheels facing local +z: the cabinet, control panel with two gauges and a readout, the red and blue hoses coiled on its hooks. */
export function acMachine(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.blue, 0.55, 0.95, 0.55, 0, 0.63, 0);
  k.box(m.enamel, 0.55, 0.06, 0.55, 0, 1.13, 0);
  k.box(m.black, 0.48, 0.34, 0.01, 0, 0.9, 0.28, 0, -0.15);
  for (const s of [-1, 1]) {
    k.cyl(m.chrome, 0.07, 0.03, s * 0.12, 0.92, 0.29, 'z', 16);
    k.cyl(m.enamel, 0.06, 0.032, s * 0.12, 0.92, 0.29, 'z', 16);
    k.cyl(m.rubber, 0.1, 0.06, s * 0.22, 0.1, -0.2, 'x', 14);
    caster(k, s * 0.2, 0.2, 0.15);
  }
  k.plane(m.screen, 0.14, 0.06, 0, 0.79, 0.296, 0, -0.15);
  k.box(m.black, 0.55, 0.03, 0.55, 0, 0.16, 0);
  for (const [s, c] of [
    [-1, m.red],
    [1, m.blue],
  ] as const) {
    k.box(m.steel, 0.03, 0.03, 0.08, s * 0.29, 0.98, 0);
    k.add(c, new THREE.TorusGeometry(0.16, 0.012, 6, 24), s * 0.3, 0.84, 0, Math.PI / 2);
    k.cyl(m.chrome, 0.015, 0.06, s * 0.3, 0.66, 0.02, 'y', 8);
  }
  k.bar(m.chrome, [-0.2, 1.16, -0.28], [-0.2, 1.36, -0.32], 0.02);
  k.bar(m.chrome, [0.2, 1.16, -0.28], [0.2, 1.36, -0.32], 0.02);
  k.cyl(m.chrome, 0.015, 0.4, 0, 1.36, -0.32, 'x', 8);
}

/** An alignment console facing local +z: cabinet on casters, the monitor on its arm, keyboard tray, printer, the wheel targets hung on its sides. */
export function alignmentConsole(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.gunmetal, 0.9, 0.8, 0.6, 0, 0.53, 0);
  k.box(m.black, 0.8, 0.02, 0.006, 0, 0.62, 0.303);
  k.box(m.chrome, 0.3, 0.02, 0.02, 0, 0.75, 0.31);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(k, sx * 0.38, sz * 0.24, 0.13);
  k.box(m.black, 0.6, 0.03, 0.26, 0, 0.98, 0.38);
  k.box(m.black, 0.5, 0.015, 0.16, 0, 1.0, 0.38);
  k.box(m.black, 0.32, 0.14, 0.26, 0.24, 1.0, -0.12);
  k.plane(m.enamel, 0.22, 0.004, 0.24, 1.071, -0.08, 0, -Math.PI / 2);
  k.box(m.gunmetal, 0.06, 0.5, 0.06, -0.15, 1.18, -0.2);
  k.box(m.black, 0.62, 0.4, 0.05, -0.15, 1.55, -0.16, 0, -0.08);
  k.plane(m.screen, 0.56, 0.34, -0.15, 1.55 + 0.026 * Math.sin(0.08), -0.16 + 0.026 * Math.cos(0.08), 0, -0.08);
  for (const s of [-1, 1])
    for (let i = 0; i < 2; i++) {
      k.box(m.black, 0.04, 0.26, 0.26, s * (0.47 + i * 0.05), 0.65, 0.12 - i * 0.24);
      k.box(m.yellow, 0.042, 0.1, 0.1, s * (0.47 + i * 0.05), 0.65, 0.12 - i * 0.24);
    }
}

// ---------------------------------------------------------------------------
// Round the lifts: jacks, stands, chargers, diagnostics
// ---------------------------------------------------------------------------

/** A transmission jack with its saddle at height `top`: the H base on casters, the ram, the saddle and its arms, pedal and handles. */
export function transmissionJack(k: Kit, x: number, z: number, yaw: number, top: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const s of [-1, 1]) {
    k.box(m.red, 0.06, 0.06, 0.9, s * 0.3, 0.12, 0);
    for (const e of [-1, 1]) caster(k, s * 0.3, e * 0.4, 0.09);
    k.bar(m.chrome, [s * 0.1, 0.5, 0.05], [s * 0.18, 1.0, 0.25], 0.02);
  }
  k.box(m.red, 0.66, 0.06, 0.08, 0, 0.12, 0);
  k.cyl(m.red, 0.06, 0.42, 0, 0.36, 0, 'y', 12);
  k.cyl(m.chrome, 0.04, top - 0.62, 0, (top + 0.52) / 2, 0, 'y', 10);
  k.box(m.red, 0.42, 0.03, 0.36, 0, top, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(m.red, 0.03, 0.12, 0.03, sx * 0.19, top + 0.06, sz * 0.16);
  k.box(m.black, 0.1, 0.03, 0.22, 0.18, 0.17, -0.3);
}

/** A tall under-hoist stand holding a car on the lift at height `top`: tripod legs, the tube, its screw and the rubber cup. */
export function underhoistStand(k: Kit, x: number, z: number, top: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3 + 0.3;
    k.bar(m.yellow, [Math.cos(a) * 0.36, 0.02, Math.sin(a) * 0.36], [0, 0.42, 0], 0.035);
  }
  k.cyl(m.yellow, 0.035, top - 0.62, 0, (top + 0.22) / 2, 0, 'y', 10);
  k.cyl(m.chrome, 0.02, 0.24, 0, top - 0.14, 0, 'y', 8);
  k.cyl(m.rubber, 0.06, 0.04, 0, top - 0.02, 0, 'y', 12);
}

/** A battery charger on its wheels: the red case, the meter, the handle, the clamped leads coiled over it. */
export function batteryCharger(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.38, 0.5, 0.3, 0, 0.42, 0);
  k.box(m.black, 0.3, 0.22, 0.01, 0, 0.52, 0.155);
  k.cyl(m.enamel, 0.06, 0.012, -0.06, 0.55, 0.16, 'z', 14);
  for (const dx of [0.07, 0.12]) k.cyl(m.chrome, 0.015, 0.02, dx, 0.5, 0.165, 'z', 8);
  for (const s of [-1, 1]) {
    k.cyl(m.rubber, 0.1, 0.05, s * 0.22, 0.1, -0.08, 'x', 14);
    k.bar(m.chrome, [s * 0.17, 0.6, -0.15], [s * 0.17, 0.95, -0.2], 0.02);
  }
  k.cyl(m.black, 0.02, 0.38, 0, 0.95, -0.2, 'x', 8);
  k.box(m.steel, 0.3, 0.03, 0.06, 0, 0.18, 0.15);
  for (const [s, c] of [
    [-1, m.red],
    [1, m.black],
  ] as const) {
    k.add(c, new THREE.TorusGeometry(0.11, 0.012, 6, 20), s * 0.08, 0.84, -0.2);
    k.box(c, 0.04, 0.1, 0.03, s * 0.08, 0.7, -0.17);
  }
}

/** A pressure brake bleeder on its dolly: the yellow tank, pump and gauge on top, the line coiled with its reservoir cap. */
export function brakeBleeder(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.steel, 0.4, 0.03, 0.4, 0, 0.08, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(k, sx * 0.15, sz * 0.15, 0.065);
  k.cyl(m.yellow, 0.16, 0.44, 0, 0.32, 0, 'y', 16);
  k.add(m.yellow, new THREE.SphereGeometry(0.16, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.54, 0);
  k.cyl(m.chrome, 0.02, 0.24, 0, 0.78, 0, 'y', 8);
  k.cyl(m.black, 0.02, 0.18, 0, 0.9, 0, 'x', 8);
  k.cyl(m.chrome, 0.04, 0.02, 0.1, 0.66, 0.06, 'z', 12);
  k.add(m.rubber, new THREE.TorusGeometry(0.14, 0.01, 6, 20), 0, 0.4, 0.17);
  k.cyl(m.black, 0.04, 0.03, 0.16, 0.12, 0.24, 'y', 12);
}

/** A diagnostic laptop on a rolling stand: five-star base on casters, the pole, the tray, the laptop open on the live data and the interface box. */
export function laptopCart(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    k.bar(m.black, [0, 0.12, 0], [Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3], 0.03);
    caster(k, Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0.08);
  }
  k.cyl(m.chrome, 0.025, 0.86, 0, 0.55, 0, 'y', 10);
  k.box(m.black, 0.46, 0.02, 0.36, 0, 0.99, 0);
  k.box(m.black, 0.36, 0.02, 0.25, 0, 1.01, 0.02);
  k.box(m.black, 0.36, 0.24, 0.012, 0, 1.13, -0.11, 0, -0.25);
  k.plane(m.screen, 0.32, 0.2, 0, 1.13 + 0.007 * Math.sin(0.25), -0.11 + 0.007 * Math.cos(0.25), 0, -0.25);
  k.box(m.yellow, 0.1, 0.04, 0.16, 0.2, 1.02, 0.1);
}

/** A smoke machine for finding leaks, on the floor: its case, handle, gauge and the clear line coiled beside it. */
export function smokeMachine(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.yellow, 0.34, 0.24, 0.22, 0, 0.12, 0);
  k.box(m.black, 0.34, 0.03, 0.22, 0, 0.255, 0);
  k.bar(m.black, [-0.12, 0.27, 0], [-0.12, 0.36, 0], 0.02);
  k.bar(m.black, [0.12, 0.27, 0], [0.12, 0.36, 0], 0.02);
  k.cyl(m.black, 0.015, 0.26, 0, 0.36, 0, 'x', 8);
  k.cyl(m.enamel, 0.035, 0.012, -0.08, 0.15, 0.112, 'z', 12);
  k.add(m.galv, new THREE.TorusGeometry(0.12, 0.01, 6, 20), 0.32, 0.012, 0.05, 0, Math.PI / 2);
}

// ---------------------------------------------------------------------------
// Seats, bins, boxes and the coffee corner
// ---------------------------------------------------------------------------

/** A rolling shop stool: five-star base on casters, gas column, foot ring and the round seat. */
export function rollingStool(k: Kit, x: number, z: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5 + 0.4;
    k.bar(m.chrome, [0, 0.1, 0], [Math.cos(a) * 0.26, 0.08, Math.sin(a) * 0.26], 0.025);
    caster(k, Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.07);
  }
  k.cyl(m.black, 0.03, 0.3, 0, 0.25, 0, 'y', 10);
  k.cyl(m.chrome, 0.02, 0.14, 0, 0.45, 0, 'y', 8);
  k.add(m.chrome, new THREE.TorusGeometry(0.17, 0.01, 6, 20), 0, 0.3, 0, 0, Math.PI / 2);
  k.cyl(m.black, 0.18, 0.08, 0, 0.55, 0, 'y', 18);
}

/** A creeper seat: the low frame on four casters, the parts tray under it, the post and the seat. */
export function creeperSeat(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.steel, 0.4, 0.03, 0.5, 0, 0.11, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(k, sx * 0.16, sz * 0.21, 0.095);
  k.box(m.red, 0.38, 0.02, 0.3, 0, 0.14, 0.04);
  for (const s of [-1, 1]) k.box(m.red, 0.38, 0.04, 0.012, 0, 0.17, 0.04 + s * 0.15);
  k.cyl(m.chrome, 0.025, 0.28, 0, 0.27, -0.12, 'y', 8);
  k.box(m.black, 0.32, 0.07, 0.3, 0, 0.44, -0.08);
  for (let i = 0; i < 4; i++) k.cyl(m.chrome, 0.012, 0.03, -0.1 + i * 0.06, 0.165, 0.08, 'y', 8);
}

/** A big grey shop bin with rags spilling over its rim. */
export function trashCan(k: Kit, x: number, z: number, r = 0.28): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.cyl(m.primer, r, 0.85, 0, 0.425, 0, 'y', 18, r * 0.85);
  k.add(m.primer, new THREE.TorusGeometry(r, 0.02, 6, 20), 0, 0.85, 0, 0, Math.PI / 2);
  k.box(m.orange, r * 1.1, 0.08, r * 0.8, 0.04, 0.86, 0.02, 0.5, 0.2);
  k.box(m.cardboard, r * 0.8, 0.06, r * 0.6, -0.06, 0.88, -0.05, -0.3, -0.15);
}

/** A red oily-rag can with its domed lid and foot pedal. */
export function ragBin(k: Kit, x: number, z: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.cyl(m.red, 0.2, 0.5, 0, 0.26, 0, 'y', 16);
  k.add(m.red, new THREE.SphereGeometry(0.205, 16, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1), 0, 0.51, 0);
  k.box(m.black, 0.12, 0.03, 0.12, 0, 0.04, 0.24);
  k.box(m.yellow, 0.14, 0.08, 0.004, 0, 0.3, 0.201);
}

/** A stack of wheel boxes, flat squares a little askew, the brand on each. */
export function wheelBoxes(k: Kit, x: number, z: number, n: number, mat: THREE.Material): void {
  k.place(x, 0, z, 0);
  for (let i = 0; i < n; i++) k.box(mat, 0.72, 0.3, 0.72, (i % 2) * 0.04, 0.15 + i * 0.3, -(i % 3) * 0.03, i * 0.12 - 0.1);
}

/**
 * The coffee corner against a wall: a mini fridge with its stickers and the
 * coffee maker, mugs and a towel roll on top (the beer cooler stands beside it).
 */
export function coffeeCorner(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.enamel, 0.5, 0.85, 0.55, 0, 0.44, 0);
  k.box(m.black, 0.5, 0.02, 0.55, 0, 0.01, 0);
  k.box(m.black, 0.48, 0.006, 0.006, 0, 0.62, 0.278);
  k.box(m.galv, 0.02, 0.24, 0.03, 0.2, 0.45, 0.29);
  k.box(m.yellow, 0.1, 0.06, 0.004, -0.1, 0.4, 0.276, 0, 0, 0.2);
  k.box(m.blue, 0.08, 0.08, 0.004, 0.05, 0.3, 0.276, 0, 0, -0.1);
  k.box(m.red, 0.12, 0.05, 0.004, -0.05, 0.72, 0.276);
  // On top: the coffee maker with its warm light, the carafe, mugs, the towel roll.
  k.box(m.black, 0.2, 0.32, 0.22, -0.1, 1.03, -0.05);
  k.box(m.black, 0.2, 0.04, 0.3, -0.1, 0.89, -0.01);
  k.cyl(m.carbon, 0.06, 0.12, -0.1, 0.97, 0.06, 'y', 12);
  k.box(m.lamp, 0.015, 0.015, 0.004, -0.03, 1.12, 0.062);
  for (const [dx, c] of [
    [0.08, m.red],
    [0.16, m.enamel],
    [0.12, m.black],
  ] as const)
    k.cyl(c, 0.04, 0.09, dx, 0.915, c === m.black ? -0.1 : 0.08 - (dx - 0.08), 'y', 10);
  k.cyl(m.enamel, 0.06, 0.24, 0.17, 1.12, -0.15, 'x', 12);
}

/** The flagship cabs' nameplates, in the badge atlas's row order: series name, line, the accent they are lit in. */
export const BADGES = [
  { name: 'STREET SCENE', line: 'PRO SERIES  ·  CUSTOM GARAGE', color: PALETTE.cyan },
  { name: 'STREET SCENE', line: 'NIGHT SHIFT  ·  FABRICATION', color: PALETTE.purple },
  { name: 'STREET SCENE', line: 'RACE DEPT  ·  TUNING', color: PALETTE.pink },
  { name: 'STREET SCENE', line: 'DRIFT LAB  ·  SUSPENSION', color: PALETTE.green },
] as const;

/** A flagship cab's configuration. */
export interface CabStyle {
  body: THREE.Material;
  fronts: THREE.Material;
  /** The accent light's strip material and its pool on the floor. */
  accent: THREE.Material;
  glow: THREE.Material;
  /** Row of BADGES on its nameplate. */
  badge: number;
  /** A hutch with full-height lockers, or a top chest with the lockers at its height. */
  top: 'hutch' | 'chest';
  lockers: -1 | 1 | 2;
  /** Doors in the run of wall cabinets over it, and their center height (m). */
  cabinets: number;
  cabinetY: number;
}

/**
 * A showpiece roll cab along local x, the rollCab with everything: glossy
 * paint, a hutch and full-height side lockers or a top chest with lockers to
 * match, chrome pulls on every drawer, a drawer pulled out, seams and an
 * underglow in the accent light pooling on a rubber mat, a lit nameplate,
 * a run of wall cabinets over it lit underneath, a helmet and a carry box on
 * the lockers. A hutch's back is a tool board of real tools, not the print.
 */
export function flagshipCab(k: Kit, x: number, z: number, yaw: number, w: number, style: CabStyle): void {
  const m = k.m;
  const hutch = style.top === 'hutch';
  rollCab(k, x, z, yaw, w, style.body, style.fronts, style.top, style.lockers, true, hutch);
  // rollCab's frame and measurements: depth, the cab's base and height, the lockers' width and height, the worktop.
  const d = 0.62;
  const base = 0.17;
  const h = 0.9;
  const lw = 0.56;
  const lh = h + (hutch ? 0.98 : 0.53);
  const ty = base + h + 0.03;
  const sides = style.lockers === 2 ? [-1, 1] : [style.lockers];
  const x0 = -w / 2 - (sides.includes(-1) ? lw : 0);
  const x1 = w / 2 + (sides.includes(1) ? lw : 0);
  const cx = (x0 + x1) / 2;
  const span = x1 - x0;
  // Chrome pulls over the printed ones: seven rows a bank (the drawer layout of drawerTexture), the open drawer's row left dark.
  const top = base + h / 2 + (h - 0.08) / 2;
  const rows = [0, 20, 40, 60, 84, 112, 148];
  for (const s of [-1, 1])
    rows.forEach((r, i) => {
      if (s === 1 && i === 3) return;
      k.box(m.chrome, w / 2 - 0.16, 0.014, 0.02, (s * w) / 4, top - ((r + 6.5) / 192) * (h - 0.08), d / 2 + 0.012);
    });
  // Accent seams where the lockers meet the cab, the underglow strip and its pool on the mat.
  for (const s of sides) k.box(style.accent, 0.01, lh - 0.02, 0.008, s * (w / 2 + 0.004), base + lh / 2, d / 2 + 0.006);
  k.box(style.accent, span - 0.1, 0.012, 0.02, cx, base - 0.012, d / 2 - 0.04);
  k.box(m.rubber, span + 0.3, 0.012, 1.1, cx, 0.006, d / 2 + 0.5);
  k.plane(style.glow, span * 1.25, 1.8, cx, 0.014, d / 2 + 0.1, 0, -Math.PI / 2);
  // The nameplate: on the hutch's overhead cabinet, or across the top chest under its handle.
  const plate = cellPlane(hutch ? 0.66 : 0.5, hutch ? 0.124 : 0.094, 0, 1, style.badge, BADGES.length);
  if (hutch) k.add(m.badge, plate, 0, ty + 0.82, -d / 2 + 0.364);
  else k.add(m.badge, plate, 0, ty + 0.5 - 0.06, d / 2 - 0.054);
  if (hutch) {
    // Real tools on the hutch's back instead of the print.
    k.box(m.gunmetal, w - 0.1, 0.5, 0.012, 0, ty + 0.3, -d / 2 + 0.04);
    const n = Math.floor((w * 0.45) / 0.045);
    for (let i = 0; i < n; i++) {
      const len = 0.1 + i * 0.013;
      const wx = -w / 2 + 0.12 + i * 0.045;
      k.box(m.chrome, 0.014, len, 0.006, wx, ty + 0.5 - len / 2, -d / 2 + 0.05);
      k.cyl(m.chrome, 0.012 + i * 0.0006, 0.007, wx, ty + 0.5 - len, -d / 2 + 0.05, 'z', 10);
    }
    [m.red, m.yellow, m.black, m.blue, m.red, m.black, m.yellow, m.blue, m.red, m.black].forEach((mat, i) => {
      const px = 0.05 + i * (w * 0.3 / 9);
      k.cyl(mat, 0.013, 0.08, px, ty + 0.5, -d / 2 + 0.06, 'y', 8);
      k.cyl(m.chrome, 0.004, 0.1 + (i % 3) * 0.04, px, ty + 0.4 - (i % 3) * 0.02, -d / 2 + 0.06, 'y', 5);
    });
    for (let i = 0; i < 10; i++) k.cyl(m.chrome, 0.012 + i * 0.0014, 0.04, w / 2 - 0.5 + i * 0.042, ty + 0.2, -d / 2 + 0.07, 'z', 8);
    // The hutch's LED washing down its back.
    k.plane(m.wash, w - 0.12, 0.6, 0, ty + 0.3, -d / 2 + 0.048);
  }
  // On the lockers: a helmet in the cab's paint on one, a carry box on the other.
  const lt = base + lh;
  const lx = w / 2 + lw / 2;
  const helmetX = sides.includes(-1) ? -lx : lx;
  k.add(style.body, new THREE.SphereGeometry(0.15, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), helmetX, lt + 0.1, 0);
  k.box(m.carbon, 0.2, 0.08, 0.04, helmetX, lt + 0.12, 0.13, 0, -0.2);
  if (sides.length === 2) carryBox(k, m.black, lx, lt, 0, 0.44);
  // A run of wall cabinets over it all, in the same paint, lit underneath: centered over the span, backs on the wall.
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  wallCabinets(k, x + cx * c - (d / 2) * sn, style.cabinetY, z - cx * sn - (d / 2) * c, yaw, span, style.cabinets, style.body);
}

/** A plane w x h showing one cell (col, row) of a cols x rows atlas (row 0 at the top of the canvas). */
export function cellPlane(w: number, h: number, col: number, cols: number, row: number, rows: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / cols, 1 - (row + 1 - uv.getY(i)) / rows);
  return g;
}

// ---------------------------------------------------------------------------
// Atmosphere: faked light, signs, banners, the walls' odds and ends
// ---------------------------------------------------------------------------

/** The tuners' banners hung from the trusses, in bannerTexture's row order. */
export const BANNERS = [
  { name: 'KUROGANE', line: 'AERO WORKS  ·  WIDE BODY', color: PALETTE.orange },
  { name: 'HAYATE', line: 'NIGHT SERIES  ·  COILOVERS', color: PALETTE.cyan },
  { name: 'KIBA', line: 'FORGED WHEELS  ·  SINCE 98', color: PALETTE.yellow },
] as const;

/** A pool of faked light on the floor, w along x by d along z (m), turned by yaw. Additive: it only ever brightens. */
export function lightPool(k: Kit, mat: THREE.Material, x: number, z: number, w: number, d: number, yaw = 0): void {
  k.place(x, 0, z, yaw).plane(mat, w, d, 0, 0.012, 0, 0, -Math.PI / 2);
}

/** An exit sign over a door, centered at height y on the wall: the housing, its lit face and the green it throws on the wall. */
export function exitSign(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.enamel, 0.42, 0.18, 0.07, 0, 0, 0.035);
  k.plane(m.exit, 0.36, 0.135, 0, 0, 0.071);
  k.plane(m.poolExit, 1.0, 0.6, 0, 0, 0.003);
}

/** A bay's number painted big on the floor, n 1 to 4, its top toward the lift (yaw 0 reads from +z). */
export function bayNumber(k: Kit, x: number, z: number, yaw: number, n: number): void {
  k.place(x, 0, z, yaw).add(k.m.bayNumbers, cellPlane(0.8, 0.8, n - 1, 4, 0, 1), 0, 0.006, 0, 0, -Math.PI / 2);
}

/** A tuner's cloth banner hung under a truss chord at height `chord`: the rod, its wires, the cloth hanging in a slight wave. */
export function banner(k: Kit, x: number, z: number, yaw: number, chord: number, row: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = 2.2;
  const h = 0.82;
  const top = chord - 0.25;
  // A strip with a wave across it, the cloth sagging between its grommets, showing its row of the atlas.
  const wave = new THREE.PlaneGeometry(w, h, 16, 1);
  const pos = wave.getAttribute('position') as THREE.BufferAttribute;
  const uv = wave.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, Math.sin((pos.getX(i) / w) * Math.PI * 3) * 0.03);
    uv.setY(i, 1 - (row + 1 - uv.getY(i)) / BANNERS.length);
  }
  wave.computeVertexNormals();
  // Printed both sides: a second face turned round so the brand reads the right way from behind too.
  const back = wave.clone();
  k.add(m.banner, wave, 0, top - h / 2, 0);
  k.add(m.banner, back, 0, top - h / 2, -0.002, Math.PI);
  k.cyl(m.galv, 0.012, w + 0.1, 0, top + 0.01, 0, 'x', 6);
  for (const s of [-1, 1]) k.bar(m.steel, [s * (w / 2 - 0.1), top + 0.01, 0], [s * (w / 2 - 0.25), chord, 0], 0.006);
}

/** A row of old number plates nailed to a wall, centered at height y. */
export function plateRow(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.wood, 1.86, 0.24, 0.02, 0, 0, 0.01);
  k.plane(m.plates, 1.8, 0.3, 0, 0, 0.022);
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) k.cyl(m.chrome, 0.006, 0.01, -0.75 + i * 0.3 + s * 0.11, 0.035, 0.025, 'z', 6);
}

/** The shop clock on a wall at height y: the black rim and its face. */
export function wallClock(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.cyl(m.black, 0.17, 0.04, 0, 0, 0.02, 'z', 32);
  k.add(m.clock, new THREE.CircleGeometry(0.15, 32), 0, 0, 0.041);
}

/** The supplier's calendar on its nail at height y. */
export function calendar(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.plane(m.calendar, 0.32, 0.45, 0, 0, 0.004);
  k.cyl(m.chrome, 0.005, 0.02, 0, 0.21, 0.01, 'z', 6);
}

/** A TV on a wall bracket at height y showing `screen`, its cable running down the wall. */
export function wallTv(k: Kit, x: number, y: number, z: number, yaw: number, screen: THREE.Material): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.steel, 0.3, 0.2, 0.08, 0, 0, 0.04);
  k.box(m.black, 1.1, 0.65, 0.05, 0, 0, 0.105);
  k.plane(screen, 1.02, 0.574, 0, 0, 0.131);
  k.hose(m.black, [[0.3, -0.3, 0.06], [0.34, -0.6, 0.02], [0.36, -1.2, 0.015], [0.36, -1.8, 0.015]], 0.008, 16);
}

/** A floor drain: the dark sump under a galvanized grate. */
export function floorDrain(k: Kit, x: number, z: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.box(m.carbon, 0.46, 0.004, 0.46, 0, 0.002, 0);
  for (let i = 0; i < 9; i++) k.box(m.galv, 0.44, 0.008, 0.012, 0, 0.006, -0.2 + i * 0.05);
  for (const s of [-1, 1]) k.box(m.galv, 0.012, 0.008, 0.46, s * 0.22, 0.006, 0);
}

/** A push broom and a floor squeegee leant on the wall behind (local -z), a mop bucket with its wringer beside them. */
export function cleanup(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.bar(m.wood, [-0.15, 0.08, 0.45], [-0.1, 1.45, 0.02], 0.025);
  k.box(m.black, 0.6, 0.06, 0.08, -0.15, 0.08, 0.46, 0.1);
  k.box(m.wood, 0.6, 0.04, 0.07, -0.15, 0.12, 0.46, 0.1);
  k.bar(m.galv, [0.15, 0.05, 0.4], [0.2, 1.4, 0.02], 0.022);
  k.box(m.rubber, 0.5, 0.06, 0.03, 0.15, 0.04, 0.42, -0.1);
  k.box(m.yellow, 0.4, 0.34, 0.36, 0.55, 0.2, 0.45);
  k.box(m.carbon, 0.36, 0.01, 0.32, 0.55, 0.36, 0.45);
  k.box(m.galv, 0.16, 0.16, 0.2, 0.62, 0.45, 0.45);
  k.bar(m.wood, [0.45, 0.3, 0.45], [0.35, 1.3, 0.1], 0.022);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(m.rubber, 0.025, 0.02, 0.55 + sx * 0.16, 0.025, 0.45 + sz * 0.15, 'x', 8);
}

/** A stack of n traffic cones, nested. */
export function cones(k: Kit, x: number, z: number, n: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  for (let i = 0; i < n; i++) {
    const y = i * 0.07;
    k.box(m.black, 0.32, 0.03, 0.32, 0, y + 0.015, 0);
    k.cyl(m.orange, 0.025, 0.46, 0, y + 0.26, 0, 'y', 14, 0.13);
  }
  k.cyl(m.enamel, 0.07, 0.06, 0, (n - 1) * 0.07 + 0.32, 0, 'y', 14, 0.085);
}

/** A space heater facing local +z: the grey case, its coils glowing behind the guard, the warmth on the floor in front. */
export function spaceHeater(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.primer, 0.36, 0.5, 0.24, 0, 0.29, 0);
  k.box(m.black, 0.4, 0.04, 0.3, 0, 0.02, 0);
  for (let i = 0; i < 5; i++) k.box(m.heaterCoil, 0.26, 0.016, 0.01, 0, 0.18 + i * 0.05, 0.115);
  for (let i = 0; i < 7; i++) k.box(m.chrome, 0.006, 0.28, 0.006, -0.12 + i * 0.04, 0.28, 0.125);
  k.box(m.black, 0.14, 0.03, 0.04, 0, 0.56, 0);
  k.place(x, 0, z, yaw).plane(m.poolHeater, 1.6, 1.6, 0, 0.012, 0.55, 0, -Math.PI / 2);
}

/**
 * A drum fan on its cart facing local +z, everything but the blades (the
 * showroom spins those on their own): the cage of staves between two rims,
 * the front guard's spokes and rings, the motor, the frame and wheels. `r` is
 * the drum's radius (m): a shop fan at 0.32, the dyno's giant cooling fan at
 * 0.75. Returns the hub's center in the fan's frame.
 */
export function drumFan(k: Kit, x: number, z: number, yaw: number, r = 0.32): Vec {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const sc = r / 0.32;
  const y = r + 0.23 * sc;
  const depth = 0.24 * sc;
  for (const dz of [-depth / 2, depth / 2]) k.add(m.gunmetal, new THREE.TorusGeometry(r, 0.02 * sc, 6, 40), 0, y, dz);
  const n = Math.round(16 * sc);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.box(m.gunmetal, ((Math.PI * 2 * r) / n) * 0.9, 0.012 * sc, depth, Math.cos(a) * r, y + Math.sin(a) * r, 0, 0, 0, a + Math.PI / 2);
  }
  const spokes = sc > 1.5 ? 12 : 8;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    k.bar(m.chrome, [0, y, depth / 2 + 0.01], [Math.cos(a) * r, y + Math.sin(a) * r, depth / 2 + 0.01], 0.006 * Math.sqrt(sc));
  }
  for (const rr of sc > 1.5 ? [0.2, 0.38, 0.56] : [0.12, 0.22]) k.add(m.chrome, new THREE.TorusGeometry(rr * (sc > 1.5 ? 1 : sc), 0.004 * Math.sqrt(sc), 4, 36), 0, y, depth / 2 + 0.01);
  k.cyl(m.black, 0.08 * sc, 0.16 * sc, 0, y, -depth / 2 + 0.02, 'z', 14);
  for (const s of [-1, 1]) {
    k.box(m.steel, 0.03 * sc, y + 0.07 * sc, 0.04 * sc, s * (r + 0.06 * sc), (y + 0.07 * sc) / 2, -0.02);
    k.cyl(m.steel, 0.03 * sc, 0.04, s * (r + 0.04 * sc), y, 0, 'x', 10);
    k.cyl(m.rubber, 0.06 * sc, 0.04 * sc, s * (r + 0.06 * sc), 0.06 * sc, -0.15 * sc, 'x', 12);
  }
  k.box(m.steel, 2 * r + 0.16 * sc, 0.03 * sc, 0.04 * sc, 0, 0.08 * sc, -0.02);
  return [0, y, 0.02];
}

/**
 * A glass door beer cooler against the wall behind it (local -z): the black
 * cabinet, its lit header, the bright interior with shelves of cans and
 * bottles behind the glass, the handle, and the COLD BEER sign on the wall
 * over it, with a little of its light on the floor in front.
 */
export function beerCooler(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = 0.62;
  const d = 0.6;
  const h = 1.9;
  const t = 0.04;
  // The cabinet: sides, top, kick, the back panel lit from inside.
  for (const sx of [-1, 1]) k.box(m.black, t, h, d, sx * (w / 2 - t / 2), h / 2, 0);
  k.box(m.black, w, 0.24, d, 0, h - 0.12, 0);
  k.box(m.black, w, 0.1, d, 0, 0.05, 0);
  k.box(m.black, w - 2 * t, h - 0.34, t, 0, (h - 0.34) / 2 + 0.1, -d / 2 + t / 2);
  k.plane(m.coolerLight, w - 2 * t, h - 0.36, 0, (h - 0.34) / 2 + 0.1, -d / 2 + t + 0.002);
  k.plane(m.coolerLight, w - 0.1, 0.12, 0, h - 0.12, d / 2 + 0.002);
  // Shelves of cans, two deep, and bottles on the top shelf.
  const cans = [m.red, m.blue, m.enamel, m.yellow, m.red, m.black];
  [0.12, 0.48, 0.84, 1.2].forEach((y, si) => {
    k.box(m.galv, w - 2 * t, 0.012, d - 0.1, 0, y, 0);
    for (let row = 0; row < 2; row++)
      for (let i = 0; i < 7; i++) {
        const cx = -w / 2 + t + 0.04 + i * 0.075;
        const cz = 0.08 - row * 0.12;
        if (si === 3) {
          k.cyl(m.orange, 0.028, 0.2, cx, y + 0.106, cz, 'y', 8);
          k.cyl(m.orange, 0.011, 0.07, cx, y + 0.24, cz, 'y', 6);
        } else k.cyl(cans[(i + row * 2 + si * 3) % cans.length], 0.032, 0.12, cx, y + 0.066, cz, 'y', 10);
      }
  });
  // The glass door in its frame, the handle.
  k.plane(m.glass, w - 0.06, h - 0.36, 0, (h - 0.34) / 2 + 0.1, d / 2 + 0.004);
  for (const sx of [-1, 1]) k.box(m.black, 0.03, h - 0.34, 0.02, sx * (w / 2 - 0.015), (h - 0.34) / 2 + 0.1, d / 2 + 0.01);
  k.box(m.black, w, 0.03, 0.02, 0, 0.115, d / 2 + 0.01);
  k.box(m.chrome, 0.025, 0.6, 0.03, w / 2 - 0.06, 1.0, d / 2 + 0.03);
  // The sign over it, its light on the floor.
  k.box(m.black, 0.76, 0.4, 0.03, 0, h + 0.36, -d / 2 + 0.015);
  k.plane(m.beerSign, 0.72, 0.36, 0, h + 0.36, -d / 2 + 0.032);
  k.plane(m.poolTube, 1.4, 1.2, 0, 0.012, d / 2 + 0.45, 0, -Math.PI / 2);
}

/** What the dyno needs of the car strapped to it (m, car space): its length and width, the rear axle's z and the wheels' track. */
export interface DynoFit {
  length: number;
  width: number;
  rearZ: number;
  frontZ: number;
  track: number;
}

/**
 * A roller dyno with the car's ground at its deck, the car along local +z:
 * the steel deck in two halves either side of the roller pit, the drum under
 * the rear wheels, the absorber housing beside it, ramps at the back, chocks
 * at the front wheels, ratchet straps from the deck to the car, the
 * operator's pendant on its stand and the exhaust hose from the tailpipe
 * along the floor to `vent` (the dyno's frame: under the door, so the fumes
 * go outside). Returns the deck's height.
 */
export function dyno(k: Kit, x: number, z: number, yaw: number, car: DynoFit, vent: Vec): number {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const deck = 0.22;
  const half = car.length / 2 + 0.55;
  const w = 2.6;
  const pit = 0.8;
  const rz = car.rearZ;
  // The deck either side of the pit, its plate skin and yellow edges.
  for (const [z0, z1] of [
    [-half, rz - pit / 2],
    [rz + pit / 2, half],
  ] as const) {
    const len = z1 - z0;
    const cz = (z0 + z1) / 2;
    k.box(m.gunmetal, w, deck - 0.01, len, 0, (deck - 0.01) / 2, cz);
    k.box(m.galv, w - 0.04, 0.01, len - 0.02, 0, deck - 0.005, cz);
    for (const s of [-1, 1]) k.box(m.yellow, 0.07, 0.012, len, s * (w / 2 - 0.035), deck + 0.001, cz);
  }
  k.box(m.black, w - 0.2, deck - 0.02, pit, 0, (deck - 0.02) / 2, rz);
  for (const s of [-1, 1]) k.box(m.gunmetal, 0.1, deck, pit, s * (w / 2 - 0.05), deck / 2, rz);
  // The drum, its top at deck height, knurled where the tires sit; the absorber on the right.
  k.cyl(m.chrome, 0.3, w - 0.24, 0, deck - 0.3 + 0.01, rz, 'x', 32);
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) k.cyl(m.cast, 0.302, 0.012, s * (car.track / 2) + (i - 2) * 0.045, deck - 0.29, rz, 'x', 32);
  k.box(m.blue, 0.5, 0.5, 0.75, w / 2 + 0.3, 0.25, rz);
  k.box(m.black, 0.42, 0.18, 0.006, w / 2 + 0.3, 0.32, rz + 0.378);
  k.box(m.yellow, 0.2, 0.06, 0.006, w / 2 + 0.3, 0.12, rz + 0.378);
  // Ramps up onto it at the back.
  for (const s of [-1, 1]) k.box(m.gunmetal, 0.7, 0.03, 1.0, s * (car.track / 2), deck / 2, -half - 0.48, 0, -Math.atan2(deck, 1.0));
  // Chocks at the front wheels, straps from the deck's corners to the car's tow points with their ratchets.
  for (const s of [-1, 1]) k.box(m.yellow, 0.28, 0.12, 0.18, s * (car.track / 2), deck + 0.06, car.frontZ + 0.45);
  for (const s of [-1, 1])
    for (const e of [-1, 1]) {
      const a: Vec = [s * (w / 2 - 0.12), deck + 0.02, e * (half - 0.15)];
      const b: Vec = [s * (car.width / 2 - 0.35), deck + 0.22, e * (car.length / 2 - 0.3)];
      k.bar(m.yellow, a, b, 0.04, 0.006);
      k.box(m.black, 0.05, 0.06, 0.09, (a[0] * 2 + b[0]) / 3, (a[1] * 2 + b[1]) / 3 + 0.02, (a[2] * 2 + b[2]) / 3);
      k.box(m.steel, 0.08, 0.02, 0.08, a[0], deck + 0.005, a[2]);
    }
  // The pendant on its stand at the back right, its cable to the absorber.
  k.box(m.steel, 0.3, 0.02, 0.3, w / 2 + 0.35, 0.01, -half + 0.4);
  k.cyl(m.galv, 0.02, 1.1, w / 2 + 0.35, 0.56, -half + 0.4, 'y', 8);
  k.box(m.yellow, 0.12, 0.2, 0.06, w / 2 + 0.35, 1.18, -half + 0.43);
  k.hose(m.black, [[w / 2 + 0.35, 1.08, -half + 0.4], [w / 2 + 0.4, 0.2, -half + 0.8], [w / 2 + 0.35, 0.015, rz - 0.6], [w / 2 + 0.3, 0.2, rz - 0.3]], 0.008, 24);
  // Exhaust: a funnel over the tailpipe, the hose down to the floor and out to the vent.
  const tz = -car.length / 2 - 0.25;
  k.cyl(m.galv, 0.11, 0.25, 0.35, deck + 0.28, tz, 'z', 14, 0.07);
  k.hose(m.galv, [[0.35, deck + 0.28, tz - 0.12], [0.35, 0.09, tz - 0.9], [vent[0], 0.08, (tz + vent[2]) / 2], vent], 0.07, 40);
  return deck;
}
