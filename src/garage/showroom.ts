/**
 * The garage showroom: a detailing garage at night. The car turns on a brushed
 * steel turntable with an LED rim and a hazard ring painted round it, under a
 * ceiling of hexagon light tubes, on an epoxy floor that mirrors the car and
 * the lights (a low resolution reflection pass seen through a translucent
 * floor, Medium and High). Around it: block walls over a dark wainscot with
 * the orange LED line at waist height, a roller door, the Street Scene sign in
 * neon, a red tool chest under a pegboard, stacked tires, shelving, a workbench
 * with spare rims on the wall and posters for the game's fictional tuners. The
 * car's paint reflects a studio environment made of the same lights (a PMREM
 * of a stand-in room, built once per visit), so the hexagons and the LED line
 * slide over the bodywork as it turns.
 *
 * Built from merged primitives (one mesh per material) and small canvas
 * textures; render only. The garage scene (garageScene.ts) owns the camera,
 * the spin and the car; this owns the room.
 */
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarView } from '../render/carView';
import type { Quality } from '../ui/settings';
import { PALETTE } from '../ui/palette';

/** Per quality tier: the floor's reflection pass (render scale of the screen, 0 = off) and the dust in the light. */
export const SHOWROOM_QUALITY: Record<Quality, { reflection: number; dust: boolean }> = {
  low: { reflection: 0, dust: false },
  medium: { reflection: 0.35, dust: true },
  high: { reflection: 0.4, dust: true },
};

/** The room (m): half its width and depth, the ceiling, the turntable and the waist-high LED line. */
const ROOM = {
  half: 9,
  height: 5,
  /** Turntable radius and top (the car's ground). */
  table: 3,
  tableTop: 0.08,
  /** Hazard ring painted round the turntable: inner and outer radius. */
  ring: [3.2, 3.42],
  /** Dark wainscot up to here, with the LED line along its top. */
  wainscot: 1.25,
  /** Hexagon light grid: cell circumradius, how far it reaches (x, z half extents) and its height. */
  hexR: 0.68,
  hexHalf: [3.3, 4.3],
  hexY: 4.78,
} as const;

/** Light and glow colors: the hexagons' warm white and the UI's accents, pushed past 1 so the bloom catches them. */
const GLOW = {
  hex: new THREE.Color(0xf2f5ff).multiplyScalar(2.6),
  led: new THREE.Color(PALETTE.orange).multiplyScalar(2.3),
  ring: new THREE.Color(PALETTE.orange),
  lamp: new THREE.Color(0xffe2b8).multiplyScalar(2.2),
} as const;

type Disposable = { dispose(): void };

export class Showroom {
  readonly scene = new THREE.Scene();
  /** Turns with the car on it (the garage scene spins it). */
  readonly turntable = new THREE.Group();
  /** The studio reflections for the car's paint. */
  readonly envMap: THREE.Texture;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly shadow: THREE.Mesh;
  private readonly reflector: Reflector | null = null;
  private readonly dust: THREE.Points | null = null;
  private readonly dustTime: { value: number } = { value: 0 };
  private readonly disposables: Disposable[] = [];
  private readonly offset = new THREE.Vector3();
  private time = 0;

  constructor(renderer: THREE.WebGLRenderer, quality: Quality) {
    const q = SHOWROOM_QUALITY[quality];
    const track = <T extends Disposable>(x: T): T => (this.disposables.push(x), x);
    const s = this.scene;
    s.background = new THREE.Color(0x08070a);
    s.fog = new THREE.Fog(0x08070a, 13, 30);

    // ---------- the room ----------
    const H = ROOM.half;
    const mats = {
      wall: track(new THREE.MeshStandardMaterial({ map: track(blockTexture()), roughness: 0.92, metalness: 0 })),
      wainscot: track(new THREE.MeshStandardMaterial({ color: 0x141317, roughness: 0.55, metalness: 0.1 })),
      ceiling: track(new THREE.MeshStandardMaterial({ color: 0x0b0a0d, roughness: 1 })),
      door: track(new THREE.MeshStandardMaterial({ map: track(doorTexture()), roughness: 0.45, metalness: 0.55 })),
      steel: track(new THREE.MeshStandardMaterial({ color: 0x2b2c31, roughness: 0.4, metalness: 0.65 })),
      chest: track(new THREE.MeshStandardMaterial({ color: 0xa61d2b, roughness: 0.3, metalness: 0.25 })),
      rubber: track(new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.88 })),
      chrome: track(new THREE.MeshStandardMaterial({ color: 0xb8bcc6, roughness: 0.22, metalness: 0.95 })),
      cardboard: track(new THREE.MeshStandardMaterial({ color: 0x7d6142, roughness: 0.95 })),
      wood: track(new THREE.MeshStandardMaterial({ color: 0x3b2f27, roughness: 0.8 })),
      led: track(new THREE.MeshBasicMaterial({ color: GLOW.led })),
      lamp: track(new THREE.MeshBasicMaterial({ color: GLOW.lamp })),
    };
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, rx = 0) => {
      geo.rotateX(rx).rotateY(ry).translate(x, y, z);
      const list = parts.get(mat) ?? [];
      list.push(geo);
      parts.set(mat, list);
    };
    const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) => add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry);
    // Walls: the block wall above the wainscot, on all four sides, facing in.
    const wallH = ROOM.height - ROOM.wainscot;
    for (const [x, z, ry] of [
      [0, -H, 0],
      [-H, 0, Math.PI / 2],
      [H, 0, -Math.PI / 2],
      [0, H, Math.PI],
    ] as const) {
      const upper = new THREE.PlaneGeometry(2 * H, wallH);
      scaleUv(upper, (2 * H) / 3.2, wallH / 3.2);
      add(mats.wall, upper, x, ROOM.wainscot + wallH / 2, z, ry);
      add(mats.wainscot, new THREE.PlaneGeometry(2 * H, ROOM.wainscot), x, ROOM.wainscot / 2, z, ry);
      // The LED line along the top of the wainscot, a hand's width off the wall.
      const lx = x === 0 ? 0 : x - Math.sign(x) * 0.04;
      const lz = z === 0 ? 0 : z - Math.sign(z) * 0.04;
      add(mats.led, new THREE.BoxGeometry(2 * H, 0.035, 0.03), lx, ROOM.wainscot, lz, ry);
    }
    add(mats.ceiling, new THREE.PlaneGeometry(2 * H, 2 * H), 0, ROOM.height, 0, 0, Math.PI / 2);

    // Back wall: a roller door on the right, the sign over the car's side of it, shelving in the corner.
    const door = new THREE.PlaneGeometry(5, 3.8);
    add(mats.door, door, 3.7, 1.9, -H + 0.03);
    box(mats.steel, 5.3, 0.22, 0.25, 3.7, 3.88, -H + 0.12);
    box(mats.steel, 0.14, 3.8, 0.12, 1.12, 1.9, -H + 0.06);
    box(mats.steel, 0.14, 3.8, 0.12, 6.28, 1.9, -H + 0.06);
    shelving(box, mats, -7.1, -H + 0.32);
    // Left wall: tire stacks in the corner, the tool chest under the pegboard, posters further along.
    for (const [z, n] of [
      [-6.9, 4],
      [-6.0, 3],
    ] as const)
      for (let i = 0; i < n; i++) tire(add, mats, -H + 0.42, 0.13 + i * 0.25, z);
    toolChest(box, mats, -H + 0.3, -2.1);
    // Right wall: the workbench under a strip lamp, spare rims hung above it.
    workbench(box, add, mats, H - 0.45, -2.6);
    for (const [z, y] of [
      [-4.2, 2.6],
      [-3.2, 2.9],
      [-2.2, 2.6],
    ] as const)
      rim(add, mats, H - 0.08, y, z);
    // A strip lamp over each work area.
    box(mats.lamp, 0.08, 0.04, 2.6, -H + 1.2, ROOM.height - 0.25, -2.1);
    box(mats.lamp, 0.08, 0.04, 2.6, H - 1.2, ROOM.height - 0.25, -2.6);
    for (const [mat, list] of parts) {
      const mesh = new THREE.Mesh(track(mergeGeometries(list)), mat);
      list.forEach((g) => g.dispose());
      s.add(mesh);
    }
    // Textured pieces stay meshes of their own: the pegboard, the chest's drawers, posters and the sign.
    const decal = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number, emissive = false) => {
      const mat = emissive
        ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(1.6, 1.6, 1.6) })
        : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 });
      const m = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), track(mat));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      s.add(m);
      track(tex);
      return m;
    };
    decal(pegboardTexture(), 2.6, 1.4, -H + 0.02, 2.15, -2.1, Math.PI / 2);
    decal(drawerTexture(), 1.6, 1.0, -H + 0.61, 0.62, -2.1, Math.PI / 2);
    decal(posterTexture('KUROGANE', 'AERO WORKS', PALETTE.orange, 0), 1.0, 1.4, -H + 0.02, 2.3, 1.6, Math.PI / 2);
    decal(posterTexture('HAYATE', 'NIGHT SERIES', PALETTE.cyan, 1), 1.0, 1.4, -H + 0.02, 2.3, 3.0, Math.PI / 2);
    decal(posterTexture('KIBA', 'FORGED WHEELS', PALETTE.yellow, 2), 1.0, 1.4, H - 0.02, 2.3, 1.2, -Math.PI / 2);
    // The sign: a dark board on the back wall with the logo in neon over it.
    const board = new THREE.Mesh(track(new THREE.BoxGeometry(4.6, 1.6, 0.08)), mats.wainscot);
    board.position.set(-3.2, 3.15, -H + 0.06);
    s.add(board);
    decal(signTexture(), 4.3, 1.45, -3.2, 3.15, -H + 0.11, 0, true);

    // ---------- floor ----------
    const floorTex = track(epoxyTexture());
    floorTex.repeat.set((2 * H) / 6, (2 * H) / 6);
    const reflective = q.reflection > 0;
    const floor = new THREE.Mesh(
      track(new THREE.PlaneGeometry(2 * H, 2 * H).rotateX(-Math.PI / 2)),
      track(
        new THREE.MeshStandardMaterial({
          map: floorTex,
          roughness: 0.46,
          metalness: 0,
          // Over the reflection pass, the floor lets some of the mirror image through.
          transparent: reflective,
          opacity: reflective ? 0.8 : 1,
          polygonOffset: reflective,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        }),
      ),
    );
    s.add(floor);
    if (reflective) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(q.reflection);
      const r = new Reflector(new THREE.PlaneGeometry(2 * H, 2 * H), { textureWidth: Math.round(size.x), textureHeight: Math.round(size.y), clipBias: 0.003, multisample: 0, shader: REFLECTION_SHADER });
      r.rotation.x = -Math.PI / 2;
      r.position.y = -0.002;
      (r.material as THREE.ShaderMaterial).uniforms.texel.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
      s.add(r);
      this.reflector = r;
    }
    // The hazard ring round the turntable.
    const hazard = new THREE.Mesh(track(ringGeometry(ROOM.ring[0], ROOM.ring[1], 96)), track(new THREE.MeshStandardMaterial({ map: track(hazardTexture()), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })));
    hazard.position.y = 0.004;
    s.add(hazard);

    // ---------- turntable ----------
    const top = ROOM.tableTop;
    const table = new THREE.Mesh(track(new THREE.CylinderGeometry(ROOM.table, ROOM.table + 0.04, top, 96)), track(new THREE.MeshStandardMaterial({ map: track(brushedTexture()), color: 0x1c1b20, roughness: 0.5, metalness: 0.6 })));
    table.position.y = top / 2;
    this.turntable.add(table);
    this.ringMat = track(new THREE.MeshBasicMaterial({ color: GLOW.ring.clone().multiplyScalar(2.2) }));
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(ROOM.table + 0.03, 0.016, 8, 128).rotateX(Math.PI / 2)), this.ringMat);
    ring.position.y = top;
    this.turntable.add(ring);
    // The car's contact shadow turns with it.
    this.shadow = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), track(new THREE.MeshBasicMaterial({ map: track(shadowTexture()), color: 0x000000, transparent: true, depthWrite: false, opacity: 0.85 })));
    this.shadow.position.y = top + 0.003;
    this.shadow.renderOrder = 1;
    this.turntable.add(this.shadow);
    s.add(this.turntable);

    // ---------- hexagon ceiling ----------
    const hex = hexGrid(ROOM.hexR, ROOM.hexHalf[0], ROOM.hexHalf[1]);
    const tube = track(new THREE.BoxGeometry(1, 0.035, 0.065));
    const hexMat = track(new THREE.MeshBasicMaterial({ color: GLOW.hex }));
    const hexMesh = new THREE.InstancedMesh(tube, hexMat, hex.length);
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    hex.forEach((e, i) => hexMesh.setMatrixAt(i, m4.compose(new THREE.Vector3(e.x, ROOM.hexY, e.z), quat.setFromAxisAngle(up, -e.angle), new THREE.Vector3(e.length - 0.05, 1, 1))));
    hexMesh.instanceMatrix.needsUpdate = true;
    s.add(hexMesh);

    // ---------- lights ----------
    s.add(new THREE.HemisphereLight(0xb4acc4, 0x0b0a0c, 0.3));
    // The hexagons light the car from above: one wide, soft spot pooling under them (their shape is in the
    // paint's reflections; a true area light would bring 100 kB of lookup tables to the garage).
    const panel = new THREE.SpotLight(0xeef2ff, 24, 14, 1.0, 1, 1.2);
    panel.position.set(0, ROOM.hexY - 0.05, 0);
    s.add(panel, panel.target);
    // Rim lights in the accents from behind, a cool fill from the front.
    // Narrow enough to edge the car without flooding the floor.
    const spot = (color: THREE.ColorRepresentation, intensity: number, x: number, y: number, z: number) => {
      const l = new THREE.SpotLight(color, intensity, 26, 0.32, 0.8, 1.4);
      l.position.set(x, y, z);
      s.add(l, l.target);
    };
    spot(PALETTE.orange, 18, -6.5, 4.4, -6.5);
    spot(PALETTE.yellow, 12, 6.5, 4.4, -6.5);
    const fill = new THREE.PointLight(0xc8d2ff, 5, 14, 1.4);
    fill.position.set(0, 2.2, 7);
    s.add(fill);
    // Warm wash on the back wall and over the work areas, so the room reads past the car.
    for (const [x, y, z, i] of [
      [-3.2, 4.4, -7.4, 7],
      [3.7, 4.4, -7.6, 5],
      [-7.6, 4.2, -2.1, 6],
      [7.6, 4.2, -2.6, 6],
    ] as const) {
      const l = new THREE.PointLight(0xffc89a, i, 7, 1.5);
      l.position.set(x, y, z);
      s.add(l);
    }

    // ---------- dust in the light ----------
    if (q.dust) {
      this.dust = dustMotes(this.dustTime);
      track(this.dust.geometry);
      track(this.dust.material as THREE.Material);
      s.add(this.dust);
    }

    // ---------- the studio reflections for the paint ----------
    this.envMap = track(studioEnvironment(renderer, hex)).texture;
    // The room's own surfaces only take a little of it; the car's paint carries its own, stronger.
    s.environment = this.envMap;
    s.environmentIntensity = 0.3;
  }

  /**
   * Keep an orbit camera inside the room: a camera rising past the lights tips
   * down to their height at the same distance (so dragging up never ends in a
   * close-up through the roof), and one past a wall comes in toward the target.
   */
  contain(camera: THREE.Vector3, target: THREE.Vector3): void {
    const o = this.offset.subVectors(camera, target);
    const r = o.length();
    const hmax = ROOM.hexY - 0.45 - target.y;
    if (o.y > hmax && r > hmax) {
      const horiz = Math.hypot(o.x, o.z) || 1e-3;
      const k = Math.sqrt(r * r - hmax * hmax) / horiz;
      o.set(o.x * k, hmax, o.z * k);
    }
    const lim = ROOM.half - 0.6;
    const cx = o.x + target.x;
    const cz = o.z + target.z;
    let t = 1;
    if (Math.abs(cx) > lim) t = Math.min(t, (Math.sign(cx) * lim - target.x) / (cx - target.x));
    if (Math.abs(cz) > lim) t = Math.min(t, (Math.sign(cz) * lim - target.z) / (cz - target.z));
    camera.copy(target).addScaledVector(o, Math.max(0.05, t));
  }

  /** Put a car on the turntable; its contact shadow sizes to it. */
  mount(view: CarView): void {
    this.turntable.add(view.root);
    const d = view.car.dimensions;
    this.shadow.scale.set(d.width * 1.32, 1, d.length * 1.16);
  }

  /** Keep the reflection pass at its share of the screen after a resize. */
  resize(renderer: THREE.WebGLRenderer, quality: Quality): void {
    if (!this.reflector) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(SHOWROOM_QUALITY[quality].reflection);
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));
    this.reflector.getRenderTarget().setSize(w, h);
    (this.reflector.material as THREE.ShaderMaterial).uniforms.texel.value.set(1 / w, 1 / h);
  }

  /** Animate the LED rim's breathing and the dust. */
  update(dt: number): void {
    this.time += dt;
    this.ringMat.color.copy(GLOW.ring).multiplyScalar(1.45 + 0.3 * Math.sin(this.time * 1.6));
    this.dustTime.value = this.time;
  }

  dispose(): void {
    this.reflector?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ---------------------------------------------------------------------------
// Props, each a few primitives added to the per-material lists.
// ---------------------------------------------------------------------------

type BoxFn = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry?: number) => void;
type AddFn = (mat: THREE.Material, geo: THREE.BufferGeometry, x?: number, y?: number, z?: number, ry?: number, rx?: number) => void;
type Mats = Record<'steel' | 'chest' | 'rubber' | 'chrome' | 'cardboard' | 'wood' | 'lamp', THREE.Material>;

/** Steel shelving against the back wall: four shelves of boxes and cans. */
function shelving(box: BoxFn, m: Mats, x: number, z: number): void {
  const w = 2.4;
  for (const sx of [-w / 2, w / 2]) box(m.steel, 0.05, 2.5, 0.05, x + sx, 1.25, z - 0.25), box(m.steel, 0.05, 2.5, 0.05, x + sx, 1.25, z + 0.25);
  for (let i = 0; i < 4; i++) {
    const y = 0.25 + i * 0.68;
    box(m.steel, w, 0.04, 0.56, x, y, z);
    // Boxes and cans, a different arrangement on each shelf.
    let px = x - w / 2 + 0.2;
    for (let k = 0; px < x + w / 2 - 0.25; k++) {
      const big = (i + k) % 3 !== 1;
      const bw = big ? 0.42 + ((i * 7 + k * 3) % 3) * 0.06 : 0.16;
      const bh = big ? 0.3 + ((i + k * 5) % 3) * 0.06 : 0.24;
      box(big ? m.cardboard : m.chest, bw, bh, big ? 0.42 : 0.16, px + bw / 2, y + 0.02 + bh / 2, z);
      px += bw + 0.08;
    }
  }
}

/** A tire lying flat at (x, y, z). */
function tire(add: AddFn, m: Mats, x: number, y: number, z: number): void {
  add(m.rubber, new THREE.TorusGeometry(0.27, 0.11, 10, 24), x, y, z, 0, Math.PI / 2);
}

/** A red rolling tool chest against the left wall: base cabinet, top box, chrome handle rails, casters. */
function toolChest(box: BoxFn, m: Mats, x: number, z: number): void {
  box(m.chest, 0.58, 1.02, 1.6, x, 0.62, z);
  box(m.chest, 0.52, 0.42, 1.56, x - 0.02, 1.36, z);
  box(m.steel, 0.6, 0.04, 1.62, x, 1.15, z);
  box(m.chrome, 0.04, 0.04, 1.3, x + 0.33, 1.25, z);
  for (const dz of [-0.7, 0.7]) for (const dx of [-0.22, 0.22]) box(m.rubber, 0.08, 0.1, 0.08, x + dx, 0.06, z + dz);
}

/** A workbench against the right wall with a vise, a strip lamp over it and a pegboard rail. */
function workbench(box: BoxFn, add: AddFn, m: Mats, x: number, z: number): void {
  box(m.wood, 0.8, 0.06, 2.6, x, 0.92, z);
  for (const dz of [-1.2, 1.2]) for (const dx of [-0.32, 0.32]) box(m.steel, 0.05, 0.9, 0.05, x + dx, 0.45, z + dz);
  box(m.steel, 0.7, 0.04, 2.4, x, 0.3, z);
  box(m.steel, 0.2, 0.16, 0.24, x - 0.2, 1.03, z - 0.8);
  // A toolbox and a lamp on the bench.
  box(m.chest, 0.3, 0.2, 0.5, x - 0.1, 1.05, z + 0.6);
  add(m.lamp, new THREE.CylinderGeometry(0.06, 0.1, 0.12, 12), x - 0.15, 1.5, z + 0.1);
  box(m.steel, 0.03, 0.55, 0.03, x - 0.15, 1.2, z + 0.1);
}

/** A spare rim hung on the right wall: tire, rim face and hub. */
function rim(add: AddFn, m: Mats, x: number, y: number, z: number): void {
  add(m.rubber, new THREE.TorusGeometry(0.3, 0.09, 10, 28), x - 0.1, y, z, Math.PI / 2);
  // Discs stood on edge facing into the room: the cylinder's axis turned from up to across (x).
  add(m.chrome, new THREE.CylinderGeometry(0.24, 0.24, 0.05, 20), x - 0.08, y, z, Math.PI / 2, Math.PI / 2);
  add(m.steel, new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), x - 0.12, y, z, Math.PI / 2, Math.PI / 2);
}

/** Every edge of the pointy-top hexagon grid whose cells fit inside ±hx, ±hz, once each: midpoint, angle and length. */
function hexGrid(r: number, hx: number, hz: number): { x: number; z: number; angle: number; length: number; ax: number; az: number; bx: number; bz: number }[] {
  const edges = new Map<string, { x: number; z: number; angle: number; length: number; ax: number; az: number; bx: number; bz: number }>();
  const w = Math.sqrt(3) * r;
  for (let row = -12; row <= 12; row++) {
    for (let col = -12; col <= 12; col++) {
      const cx = w * (col + (row & 1 ? 0.5 : 0));
      const cz = 1.5 * r * row;
      if (Math.abs(cx) + w / 2 > hx || Math.abs(cz) + r > hz) continue;
      for (let i = 0; i < 6; i++) {
        const a0 = Math.PI / 6 + (i * Math.PI) / 3;
        const a1 = a0 + Math.PI / 3;
        const ax = cx + r * Math.cos(a0);
        const az = cz + r * Math.sin(a0);
        const bx = cx + r * Math.cos(a1);
        const bz = cz + r * Math.sin(a1);
        const key = `${Math.round((ax + bx) * 50)},${Math.round((az + bz) * 50)}`;
        if (!edges.has(key)) edges.set(key, { x: (ax + bx) / 2, z: (az + bz) / 2, angle: Math.atan2(bz - az, bx - ax), length: Math.hypot(bx - ax, bz - az), ax, az, bx, bz });
      }
    }
  }
  return [...edges.values()];
}

/** A flat ring with polar UVs (u round the ring, v across it), facing up. */
function ringGeometry(r0: number, r1: number, segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c * r0, 0, s * r0, c * r1, 0, s * r1);
    uv.push((i / segments) * 48, 0, (i / segments) * 48, 1);
    // Wound counter-clockwise seen from above, so the ring faces up.
    if (i < segments) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Scale a geometry's UVs (texture repeats across a big plane without a texture per wall). */
function scaleUv(g: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

/** Dust motes drifting in the light over the car: points moved in the shader, so nothing per frame on the CPU. */
function dustMotes(time: { value: number }): THREE.Points {
  const n = 220;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  let h = 7;
  const rnd = () => ((h = (h * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rnd() - 0.5) * 9;
    pos[i * 3 + 1] = 0.3 + rnd() * 4.2;
    pos[i * 3 + 2] = (rnd() - 0.5) * 9;
    seed[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { time, scale: { value: 380 } },
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float time;
      uniform float scale;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float t = time * (0.05 + seed * 0.06);
        p.x += sin(t * 2.0 + seed * 40.0) * 0.6;
        p.z += cos(t * 1.7 + seed * 23.0) * 0.6;
        p.y += mod(t * 0.6 + seed * 4.0, 4.4) - 2.2 + sin(t * 3.0) * 0.1;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = scale * (0.012 + seed * 0.014) / -mv.z;
        // Brightest under the lights, gone near the floor and the ceiling.
        vAlpha = smoothstep(0.2, 1.2, p.y) * (1.0 - smoothstep(3.6, 4.6, p.y)) * (0.25 + 0.5 * seed);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d)) * vAlpha;
        gl_FragColor = vec4(vec3(1.0, 0.94, 0.86) * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

/**
 * The floor's mirror image as the Reflector draws it: a few taps of blur for
 * epoxy rather than glass, strongest round the turntable and fading toward the
 * walls. The translucent floor over it decides how much shows.
 */
const REFLECTION_SHADER = {
  name: 'ShowroomReflection',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    texel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec2 o = texel * 1.6;
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.36;
      c += texture2D(tDiffuse, uv + vec2(o.x, o.y)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(-o.x, o.y)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(o.x, -o.y)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(-o.x, -o.y)).rgb * 0.16;
      float fade = 1.0 - smoothstep(3.5, 9.0, length(vWorld.xz));
      gl_FragColor = vec4(c * mix(0.3, 1.0, fade), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/**
 * The studio environment the paint reflects: a stand-in room with the hexagon
 * grid overhead, the orange LED line round the walls, the roller door, the
 * sign and a soft panel in front, rendered into a PMREM from the car's height.
 */
function studioEnvironment(renderer: THREE.WebGLRenderer, hex: ReturnType<typeof hexGrid>): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(x: T): T => (disposables.push(x), x);
  const basic = (color: THREE.ColorRepresentation, k = 1) => track(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.BackSide }));
  const H = ROOM.half;
  const room = new THREE.Mesh(track(new THREE.BoxGeometry(2 * H, ROOM.height, 2 * H)), basic(0x0e0d11));
  room.position.y = ROOM.height / 2;
  env.add(room);
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(2 * H, 2 * H).rotateX(-Math.PI / 2)), track(new THREE.MeshBasicMaterial({ color: 0x0d0c10 })));
  floor.position.y = 0.01;
  env.add(floor);
  const tube = track(new THREE.BoxGeometry(1, 0.05, 0.09));
  const hot = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf2f5ff).multiplyScalar(2.4) }));
  const hexMesh = new THREE.InstancedMesh(tube, hot, hex.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  hex.forEach((e, i) => hexMesh.setMatrixAt(i, m4.compose(new THREE.Vector3(e.x, ROOM.hexY, e.z), q.setFromAxisAngle(up, -e.angle), new THREE.Vector3(e.length, 1, 1))));
  env.add(hexMesh);
  const strip = (mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry: number) => {
    const m = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    env.add(m);
  };
  const led = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.orange).multiplyScalar(1.6) }));
  for (const [x, z, ry] of [
    [0, -H + 0.05, 0],
    [-H + 0.05, 0, Math.PI / 2],
    [H - 0.05, 0, -Math.PI / 2],
    [0, H - 0.05, Math.PI],
  ] as const)
    strip(led, 2 * H, 0.06, x, ROOM.wainscot, z, ry);
  strip(track(new THREE.MeshBasicMaterial({ color: 0x3a3e47 })), 5, 3.8, 3.7, 1.9, -H + 0.05, 0);
  strip(track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.orange).multiplyScalar(0.9) })), 4.3, 1.2, -3.2, 3.15, -H + 0.05, 0);
  // A big soft panel in front, so the nose and the windscreen have something to reflect.
  strip(track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd8dcff).multiplyScalar(0.28) })), 8, 2.4, 0, 2.6, H - 0.05, Math.PI);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035, 0.1, 40, { position: new THREE.Vector3(0, 0.8, 0) });
  pmrem.dispose();
  hexMesh.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}

// ---------------------------------------------------------------------------
// Canvas textures (drawn once per visit, a few milliseconds).
// ---------------------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A small deterministic hash noise in 0..1 for texture speckle. */
function noise(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Painted concrete block, running bond, 3.2 m square: 8 blocks across, 16 courses. */
function blockTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = '#18171b';
    g.fillRect(0, 0, 512, 512);
    const bw = 64;
    const bh = 32;
    for (let row = 0; row < 16; row++) {
      const off = row & 1 ? bw / 2 : 0;
      for (let col = -1; col < 9; col++) {
        const v = 34 + Math.floor(noise(row * 31 + col) * 9);
        g.fillStyle = `rgb(${v},${v - 1},${v + 3})`;
        g.fillRect(col * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
        // A faint top light on each block face.
        g.fillStyle = 'rgba(255,255,255,0.025)';
        g.fillRect(col * bw + off + 2, row * bh + 2, bw - 4, 3);
      }
    }
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = noise(i) > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.08)';
      g.fillRect(noise(i * 3.1) * 512, noise(i * 7.7) * 512, 2, 2);
    }
  });
}

/** A roller door: horizontal slats with a light catching each rib. */
function doorTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 512, (g) => {
    for (let y = 0; y < 512; y += 12) {
      const grad = g.createLinearGradient(0, y, 0, y + 12);
      grad.addColorStop(0, '#5a606b');
      grad.addColorStop(0.45, '#3c414a');
      grad.addColorStop(0.55, '#2c3037');
      grad.addColorStop(1, '#4a505a');
      g.fillStyle = grad;
      g.fillRect(0, y, 256, 12);
    }
    g.fillStyle = '#1d1f24';
    g.fillRect(0, 488, 256, 24);
    // A hazard band along the bottom rail.
    for (let x = -24; x < 256; x += 24) {
      g.fillStyle = PALETTE.yellow;
      g.beginPath();
      g.moveTo(x, 512);
      g.lineTo(x + 12, 496);
      g.lineTo(x + 24, 496);
      g.lineTo(x + 12, 512);
      g.fill();
    }
  });
}

/** Dark epoxy, 6 m square: fine speckle and saw-cut joints every 3 m. */
function epoxyTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = '#141317';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      const n = noise(i * 1.31);
      g.fillStyle = n > 0.6 ? 'rgba(255,255,255,0.05)' : n > 0.3 ? 'rgba(0,0,0,0.12)' : 'rgba(120,110,140,0.05)';
      g.fillRect(noise(i * 2.7) * 512, noise(i * 5.3) * 512, 1.5, 1.5);
    }
    g.fillStyle = 'rgba(0,0,0,0.55)';
    for (const p of [0, 256]) {
      g.fillRect(p, 0, 2, 512);
      g.fillRect(0, p, 512, 2);
    }
  });
}

/** Yellow and black chevrons for the ring round the turntable. */
function hazardTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 32, (g) => {
    g.fillStyle = '#16151a';
    g.fillRect(0, 0, 64, 32);
    // Worn paint: a dimmer yellow than the UI's, so the ring frames the car without shouting.
    g.fillStyle = '#a88a36';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(32, 0);
    g.lineTo(64, 32);
    g.lineTo(32, 32);
    g.fill();
  });
}

/** Brushed metal: fine concentric grain for the turntable's top (planar UVs make the rings). */
function brushedTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = '#7a7880';
    g.fillRect(0, 0, 512, 512);
    for (let r = 4; r < 256; r += 1.5) {
      const v = 112 + Math.floor((noise(r * 3.3) - 0.5) * 44);
      g.strokeStyle = `rgba(${v},${v},${v + 6},0.55)`;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(256, 256, r, 0, Math.PI * 2);
      g.stroke();
    }
    // Spokes of the turntable's plates.
    g.strokeStyle = 'rgba(20,20,24,0.8)';
    g.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(256 + Math.cos(a) * 60, 256 + Math.sin(a) * 60);
      g.lineTo(256 + Math.cos(a) * 250, 256 + Math.sin(a) * 250);
      g.stroke();
    }
    g.beginPath();
    g.arc(256, 256, 60, 0, Math.PI * 2);
    g.stroke();
  });
}

/** Pegboard with a few tools hung on it. */
function pegboardTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 276, (g) => {
    g.fillStyle = '#26252b';
    g.fillRect(0, 0, 512, 276);
    g.fillStyle = '#121115';
    for (let y = 10; y < 276; y += 18) for (let x = 10; x < 512; x += 18) g.fillRect(x, y, 4, 4);
    g.fillStyle = '#8e939c';
    // Wrenches in a row, getting bigger, then a hammer and pliers.
    for (let i = 0; i < 7; i++) {
      const x = 30 + i * 30;
      const len = 70 + i * 10;
      g.fillRect(x, 40, 8, len);
      g.beginPath();
      g.arc(x + 4, 40, 11, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#a61d2b';
    g.fillRect(300, 40, 14, 110);
    g.fillStyle = '#8e939c';
    g.fillRect(282, 34, 50, 22);
    g.fillStyle = PALETTE.orange;
    g.fillRect(370, 50, 12, 90);
    g.fillRect(392, 50, 12, 90);
    g.fillStyle = '#8e939c';
    g.fillRect(372, 130, 30, 40);
    // A coiled air line.
    g.strokeStyle = '#d9b44a';
    g.lineWidth = 6;
    for (let r = 20; r < 46; r += 8) {
      g.beginPath();
      g.arc(460, 110, r, 0, Math.PI * 2);
      g.stroke();
    }
  });
}

/** The tool chest's drawer fronts: seams, chrome pulls and a label. */
function drawerTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 160, (g) => {
    g.fillStyle = '#a61d2b';
    g.fillRect(0, 0, 256, 160);
    const rows = [0, 22, 44, 66, 96, 126, 160];
    for (let i = 0; i < rows.length - 1; i++) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, rows[i + 1] - 2, 256, 2);
      g.fillStyle = '#d9dde5';
      g.fillRect(28, rows[i] + 6, 200, 3);
    }
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, 0, 256, 3);
  });
}

/** A poster for one of the game's fictional tuners: a name, a line and a bold shape in an accent. */
function posterTexture(name: string, line: string, accent: string, variant: number): THREE.CanvasTexture {
  return canvasTexture(256, 360, (g) => {
    g.fillStyle = '#1b1a1f';
    g.fillRect(0, 0, 256, 360);
    g.fillStyle = accent;
    if (variant === 0) {
      // A wing: a slanted blade over a stand.
      g.beginPath();
      g.moveTo(30, 150);
      g.lineTo(226, 120);
      g.lineTo(226, 140);
      g.lineTo(30, 172);
      g.fill();
      g.fillRect(80, 160, 10, 60);
      g.fillRect(170, 146, 10, 60);
    } else if (variant === 1) {
      // Speed lines.
      for (let i = 0; i < 9; i++) g.fillRect(20 + i * 6, 70 + i * 18, 216 - i * 18, 7);
    } else {
      // A five spoke rim.
      g.lineWidth = 14;
      g.strokeStyle = accent;
      g.beginPath();
      g.arc(128, 150, 80, 0, Math.PI * 2);
      g.stroke();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.moveTo(128, 150);
        g.lineTo(128 + Math.cos(a) * 76, 150 + Math.sin(a) * 76);
        g.stroke();
      }
    }
    g.fillStyle = '#f2efe8';
    g.font = 'italic 900 40px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(name, 20, 290);
    g.fillStyle = accent;
    g.font = '700 17px "Google Sans Flex", system-ui, sans-serif';
    g.fillText(line, 22, 318);
    g.fillRect(22, 330, 60, 4);
  });
}

/**
 * The Street Scene sign: the logo's italic in the title's yellow to red sweep,
 * with a glow round each letter like a lit tube. Drawn again once the display
 * font is in (the first draw may use the fallback).
 */
function signTexture(): THREE.CanvasTexture {
  const W = 1024;
  const Hh = 346;
  const draw = (g: CanvasRenderingContext2D) => {
    g.clearRect(0, 0, W, Hh);
    g.font = 'italic 900 150px "Google Sans Flex", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const grad = g.createLinearGradient(80, 0, W - 80, 0);
    grad.addColorStop(0, PALETTE.yellow);
    grad.addColorStop(0.55, PALETTE.orange);
    grad.addColorStop(1, PALETTE.red);
    // Glow passes, wide to tight, then the tube itself in near white over the color.
    for (const [blur, alpha] of [
      [40, 0.55],
      [18, 0.8],
    ] as const) {
      g.shadowColor = PALETTE.orange;
      g.shadowBlur = blur;
      g.globalAlpha = alpha;
      g.fillStyle = grad;
      g.fillText('STREET SCENE', W / 2, Hh / 2 - 10);
    }
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    g.fillStyle = grad;
    g.fillText('STREET SCENE', W / 2, Hh / 2 - 10);
    g.fillStyle = 'rgba(255,244,214,0.55)';
    g.font = 'italic 900 150px "Google Sans Flex", system-ui, sans-serif';
    g.fillText('STREET SCENE', W / 2 - 2, Hh / 2 - 12);
    // The rule under it.
    g.fillStyle = grad;
    g.shadowColor = PALETTE.orange;
    g.shadowBlur = 16;
    g.fillRect(130, Hh / 2 + 78, W - 260, 9);
    g.shadowBlur = 0;
  };
  const texture = canvasTexture(W, Hh, draw);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  void document.fonts
    ?.load('italic 900 150px "Google Sans Flex"')
    .then(() => {
      draw((texture.image as HTMLCanvasElement).getContext('2d')!);
      texture.needsUpdate = true;
    })
    .catch(() => undefined);
  return texture;
}

/** The contact shadow: a soft rounded rectangle, darkest under the car's middle. */
function shadowTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const t = canvasTexture(
    w,
    h,
    (g) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // Rounded box distance in a unit footprint, inner box 0.62 x 0.74 of the plane.
          const px = Math.abs((x + 0.5) / w - 0.5) * 2;
          const py = Math.abs((y + 0.5) / h - 0.5) * 2;
          const qx = Math.max(px - 0.6, 0);
          const qy = Math.max(py - 0.72, 0);
          const d = Math.hypot(qx / 0.4, qy / 0.28);
          const a = Math.max(0, 1 - d) ** 1.8 * (0.75 + 0.25 * (1 - py));
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
    },
    false,
  );
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
