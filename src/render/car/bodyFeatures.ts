/**
 * A car's unique features (VisualBuild.features, BODY_FEATURES), cut from its model once per loaded file
 * (CarAssetLibrary.carModel) and switched per car by BodyFeatureView. The manifest gives each feature a box in car
 * space (`bodyFeatures`), the way it boxes the mirror caps:
 * - shavedHatch: every piece wholly inside the box (the hatch handle and its lock) becomes a child that hides, and
 *   the recess it sat in is pressed flush: every other vertex in the box moves along z onto the plane of the skin
 *   round the box (SKIN_BAND). A reduced donor fans long triangles from the recess across the hatch, so the recess
 *   cannot be cut out by whole faces; pressing its vertices lays those triangles flat on the skin instead.
 * - blackGrille: the Paint pieces wholly inside the box (the grille's bars) become a child that takes the Black
 *   material of the lips and diffusers.
 * - euroMirrors: the box is the left mirror's (mirrored for the right). Every face inside it, any material, the caps
 *   split by mirrorCaps.ts too, narrows: the housing keeps EURO_MIRROR_WIDTH of its width from the box's inner end
 *   out, so the root at the door stays put. Vertices the body's faces outside the box share stay where they are.
 * A piece is welded by position, not by index (a model splits its vertices along seams), so a piece the skin only
 * touches is never taken with it. The reshapes are positions (and normals) per vertex, built at load and combined
 * into a geometry per mesh for the switches that are on, cached and shared by every car of the model: no extra draw.
 */
import * as THREE from 'three';
import { BODY_FEATURES, type BodyFeature } from '../../shared/carBuild';

/** A feature's box in car space (m, x left, y up, z forward); euroMirrors' is the left mirror's. */
export interface BodyFeatureBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** Euro mirrors' share of the stock housing's width (outboard of the box's inner end). */
const EURO_MIRROR_WIDTH = 0.65;
/** Positions closer than this weld into one piece (m). */
const WELD = 5e-4;
/** The shaved hatch's skin is read in a band round its box (x and y, m), grown a step at a time up to the most until it holds SKIN_MIN vertices: a reduced donor has few. */
const SKIN_BAND = { step: 0.03, most: 0.3 } as const;
const SKIN_MIN = 6;

type Box = { min: THREE.Vector3; max: THREE.Vector3; mirrored: boolean };

/** A feature's new positions and normals (mesh space) for some of a position attribute's vertices. */
interface Reshape {
  ids: number[];
  pos: number[];
  normal: number[];
  /** Pressed flat, the faces of moved vertices only that face against this (mesh space) are dropped: a recess's walls folded back onto its floor. */
  facing?: THREE.Vector3;
}

/** The reshapes of one position attribute (and the normal attribute beside it), and its variants built so far. */
interface Reshapes {
  normal: THREE.BufferAttribute | undefined;
  by: Map<BodyFeature, Reshape>;
  variants: Map<string, { pos: THREE.BufferAttribute; normal: THREE.BufferAttribute | undefined }>;
}

const reshapesOf = new WeakMap<THREE.BufferAttribute, Reshapes>();
/** Each stock geometry's variants, by the switches on (BODY_FEATURES order, joined). */
const variantsOf = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();

const toBox = (b: BodyFeatureBox, mirrored: boolean): Box => ({ min: new THREE.Vector3(...b.min), max: new THREE.Vector3(...b.max), mirrored });
const inBox = (p: THREE.Vector3, b: Box) =>
  (b.mirrored ? Math.abs(p.x) : p.x) >= b.min.x && (b.mirrored ? Math.abs(p.x) : p.x) <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

/** The meshes under `root` with one material, each with its transform to car space. */
function meshesOf(root: THREE.Object3D, toRoot: THREE.Matrix4, keep: (m: THREE.Material) => boolean): { mesh: THREE.Mesh; toCar: THREE.Matrix4 }[] {
  const out: { mesh: THREE.Mesh; toCar: THREE.Matrix4 }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && keep(mesh.material)) out.push({ mesh, toCar: new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld) });
  });
  return out;
}

/** Per vertex, whether it is in the box, in car space. */
function verticesIn(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, toCar: THREE.Matrix4, box: Box): boolean[] {
  const p = new THREE.Vector3();
  return Array.from({ length: pos.count }, (_, k) => inBox(p.fromBufferAttribute(pos, k).applyMatrix4(toCar), box));
}

/** The vertex indices of each face. */
function faces(geo: THREE.BufferGeometry): number[] {
  const index = geo.getIndex();
  return index ? Array.from(index.array) : Array.from({ length: geo.getAttribute('position').count }, (_, i) => i);
}

/** Per face, whether its piece (faces welded by position) lies wholly in the box. */
function piecesIn(geo: THREE.BufferGeometry, ids: number[], inside: boolean[]): boolean[] {
  const pos = geo.getAttribute('position');
  const parent = Array.from({ length: pos.count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const welded = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) / WELD)},${Math.round(pos.getY(i) / WELD)},${Math.round(pos.getZ(i) / WELD)}`;
    const at = welded.get(key);
    if (at === undefined) welded.set(key, i);
    else join(i, at);
  }
  for (let t = 0; t + 2 < ids.length; t += 3) {
    join(ids[t], ids[t + 1]);
    join(ids[t], ids[t + 2]);
  }
  const out = new Map<number, boolean>();
  for (let i = 0; i < pos.count; i++) out.set(find(i), (out.get(find(i)) ?? true) && inside[i]);
  const take: boolean[] = [];
  for (let t = 0; t + 2 < ids.length; t += 3) take.push(out.get(find(ids[t]))!);
  return take;
}

/** Move the faces marked in `take` to a child of `mesh` sharing its attributes, named for the feature. */
function splitOff(mesh: THREE.Mesh, ids: number[], take: boolean[], feature: BodyFeature): void {
  if (!take.includes(true)) return;
  const geo = mesh.geometry;
  const count = geo.getAttribute('position').count;
  const sub = (want: boolean) => {
    const out: number[] = [];
    take.forEach((t, f) => t === want && out.push(ids[f * 3], ids[f * 3 + 1], ids[f * 3 + 2]));
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(out) : new Uint16Array(out), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  };
  const part = new THREE.Mesh(sub(true), mesh.material);
  mesh.geometry = sub(false);
  part.name = feature;
  part.userData.bodyFeature = feature;
  mesh.add(part);
}

/** The meshes under `root` grouped by the position attribute they draw from, each group with its transform to car space. */
function attributeGroups(root: THREE.Object3D, toRoot: THREE.Matrix4): Map<THREE.BufferAttribute, { geos: THREE.BufferGeometry[]; toCar: THREE.Matrix4 }> {
  const groups = new Map<THREE.BufferAttribute, { geos: THREE.BufferGeometry[]; toCar: THREE.Matrix4 }>();
  for (const { mesh, toCar } of meshesOf(root, toRoot, () => true)) {
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const g = groups.get(pos) ?? { geos: [], toCar };
    if (!g.geos.includes(mesh.geometry)) g.geos.push(mesh.geometry);
    groups.set(pos, g);
  }
  return groups;
}

/**
 * Record `feature`'s reshape of a position attribute: `move` sets vertex i's new position and normal (car space,
 * given the stock ones) and says whether it moves. Stored in mesh space.
 */
function reshape(pos: THREE.BufferAttribute, normal: THREE.BufferAttribute | undefined, toCar: THREE.Matrix4, feature: BodyFeature, move: (i: number, p: THREE.Vector3, n: THREE.Vector3) => boolean, facing?: THREE.Vector3): void {
  const fromCar = toCar.clone().invert();
  const normalToCar = new THREE.Matrix3().getNormalMatrix(toCar);
  const normalFromCar = new THREE.Matrix3().getNormalMatrix(fromCar);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const r: Reshape = { ids: [], pos: [], normal: [], facing: facing?.clone().applyMatrix3(normalFromCar).normalize() };
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(toCar);
    if (normal) n.fromBufferAttribute(normal, i).applyMatrix3(normalToCar);
    if (!move(i, p, n)) continue;
    p.applyMatrix4(fromCar);
    n.applyMatrix3(normalFromCar).normalize();
    r.ids.push(i);
    r.pos.push(p.x, p.y, p.z);
    r.normal.push(n.x, n.y, n.z);
  }
  if (!r.ids.length) return;
  const all = reshapesOf.get(pos) ?? { normal, by: new Map(), variants: new Map() };
  all.by.set(feature, r);
  reshapesOf.set(pos, all);
}

/** The euro mirrors: the free vertices in the box (no face outside it uses them) close in toward its inner end. */
function narrowMirrors(root: THREE.Object3D, toRoot: THREE.Matrix4, box: Box): void {
  const x0 = box.min.x;
  for (const [pos, { geos, toCar }] of attributeGroups(root, toRoot)) {
    const inside = verticesIn(pos, toCar, box);
    const free = inside.slice();
    for (const geo of geos) {
      const ids = faces(geo);
      for (let t = 0; t + 2 < ids.length; t += 3) if (!(inside[ids[t]] && inside[ids[t + 1]] && inside[ids[t + 2]])) for (let j = 0; j < 3; j++) free[ids[t + j]] = false;
    }
    if (!free.includes(true)) continue;
    // Narrowing x in car space is diag(s, 1, 1) on each side; normals take its inverse transpose.
    reshape(pos, geos[0].getAttribute('normal') as THREE.BufferAttribute | undefined, toCar, 'euroMirrors', (i, p, n) => {
      if (!free[i]) return false;
      p.x = Math.sign(p.x) * (x0 + (Math.abs(p.x) - x0) * EURO_MIRROR_WIDTH);
      n.x /= EURO_MIRROR_WIDTH;
      return true;
    });
  }
}

/**
 * The shaved hatch's recess pressed flush: the plane z = a + b x + c y through the skin's vertices in a band round
 * the box (least squares), every vertex in the box moved along z onto it and facing the way the skin does.
 */
function flushRecess(root: THREE.Object3D, toRoot: THREE.Matrix4, box: Box): void {
  for (const [pos, { geos, toCar }] of attributeGroups(root, toRoot)) {
    const inside = verticesIn(pos, toCar, box);
    if (!inside.includes(true)) continue;
    const normal = geos[0].getAttribute('normal') as THREE.BufferAttribute | undefined;
    const normalToCar = new THREE.Matrix3().getNormalMatrix(toCar);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    // The skin: the vertices outside the box in the narrowest band round it that holds enough of them.
    const skin: number[] = [];
    for (let grow = SKIN_BAND.step; skin.length < SKIN_MIN && grow <= SKIN_BAND.most + 1e-9; grow += SKIN_BAND.step) {
      const g = new THREE.Vector3(grow, grow, 0);
      const band: Box = { min: box.min.clone().sub(g), max: box.max.clone().add(g), mirrored: false };
      skin.length = 0;
      for (let i = 0; i < pos.count; i++) if (!inside[i] && inBox(p.fromBufferAttribute(pos, i).applyMatrix4(toCar), band)) skin.push(i);
    }
    if (skin.length < SKIN_MIN) continue;
    const A = new THREE.Matrix3();
    const e = A.elements;
    e.fill(0);
    const r = new THREE.Vector3();
    const facing = new THREE.Vector3();
    for (const i of skin) {
      p.fromBufferAttribute(pos, i).applyMatrix4(toCar);
      const row = [1, p.x, p.y];
      for (let u = 0; u < 3; u++) for (let v = 0; v < 3; v++) e[u * 3 + v] += row[u] * row[v];
      r.x += p.z;
      r.y += p.x * p.z;
      r.z += p.y * p.z;
      if (normal) facing.add(n.fromBufferAttribute(normal, i).applyMatrix3(normalToCar));
    }
    if (Math.abs(A.determinant()) < 1e-12) continue;
    const [a, b, c] = r.applyMatrix3(A.invert()).toArray();
    const plane = new THREE.Vector3(-b, -c, 1).normalize().multiplyScalar(Math.sign(facing.z) || 1);
    reshape(pos, normal, toCar, 'shavedHatch', (i, q, m) => {
      if (!inside[i]) return false;
      q.z = a + b * q.x + c * q.y;
      m.copy(plane);
      return true;
    }, plane);
  }
}

/**
 * Cut the features in `boxes` from a freshly loaded car scene (before any clone, after the mirror caps' split).
 * `isPaint` says which source materials are body paint.
 */
export function splitBodyFeatures(root: THREE.Object3D, boxes: Partial<Record<BodyFeature, BodyFeatureBox>>, isPaint: (m: THREE.Material) => boolean): void {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const pieces: [BodyFeature, (m: THREE.Material) => boolean][] = [
    ['shavedHatch', () => true],
    ['blackGrille', isPaint],
  ];
  for (const [feature, keep] of pieces) {
    const b = boxes[feature];
    if (!b) continue;
    const box = toBox(b, false);
    for (const { mesh, toCar } of meshesOf(root, toRoot, keep)) {
      if (mesh.userData.bodyFeature) continue;
      const ids = faces(mesh.geometry);
      splitOff(mesh, ids, piecesIn(mesh.geometry, ids, verticesIn(mesh.geometry.getAttribute('position'), toCar, box)), feature);
    }
  }
  if (boxes.shavedHatch) flushRecess(root, toRoot, toBox(boxes.shavedHatch, false));
  if (boxes.euroMirrors) narrowMirrors(root, toRoot, toBox(boxes.euroMirrors, true));
}

/** `geo` with the reshapes of the switches in `on` applied (built once per geometry and set of switches), or itself with none. */
function variant(geo: THREE.BufferGeometry, on: readonly BodyFeature[]): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const all = reshapesOf.get(pos)!;
  const active = BODY_FEATURES.filter((f) => on.includes(f) && all.by.has(f));
  if (!active.length) return geo;
  const key = active.join(',');
  let attrs = all.variants.get(key);
  if (!attrs) {
    const built = { pos: pos.clone(), normal: all.normal?.clone() };
    for (const f of active) {
      const r = all.by.get(f)!;
      r.ids.forEach((i, k) => {
        built.pos.setXYZ(i, r.pos[k * 3], r.pos[k * 3 + 1], r.pos[k * 3 + 2]);
        built.normal?.setXYZ(i, r.normal[k * 3], r.normal[k * 3 + 1], r.normal[k * 3 + 2]);
      });
    }
    all.variants.set(key, (attrs = built));
  }
  const mine = variantsOf.get(geo) ?? new Map<string, THREE.BufferGeometry>();
  variantsOf.set(geo, mine);
  let g = mine.get(key);
  if (!g) {
    g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, name === 'position' ? attrs.pos : name === 'normal' && attrs.normal ? attrs.normal : attr);
    g.setIndex(culled(geo, attrs.pos, active.map((f) => all.by.get(f)!)));
    for (const gr of geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    mine.set(key, g);
  }
  return g;
}

/** `geo`'s index without the faces the flattening reshape (the one with a `facing`) folded back, or its own index when none did. */
function culled(geo: THREE.BufferGeometry, pos: THREE.BufferAttribute, reshapes: Reshape[]): THREE.BufferAttribute | null {
  const index = geo.getIndex();
  const r = reshapes.find((x) => x.facing);
  if (!index || !r) return index;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const keep: number[] = [];
  const moved = new Set(r.ids);
  for (let t = 0; t + 2 < index.count; t += 3) {
    const [i, j, k] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (moved.has(i) && moved.has(j) && moved.has(k)) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, j).sub(a);
      c.fromBufferAttribute(pos, k).sub(a);
      if (b.cross(c).dot(r.facing!) <= 0) continue;
    }
    keep.push(i, j, k);
  }
  if (keep.length === index.count) return index;
  return new THREE.BufferAttribute(index.array instanceof Uint32Array ? new Uint32Array(keep) : new Uint16Array(keep), 1);
}

/** One car's features: the meshes each switch touches, found once in its bound model (CarView.load). */
export class BodyFeatureView {
  private readonly reshaped: { mesh: THREE.Mesh; stock: THREE.BufferGeometry }[] = [];
  private readonly handles: THREE.Mesh[] = [];
  private readonly grilles: THREE.Mesh[] = [];

  constructor(model: THREE.Object3D) {
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (reshapesOf.has(mesh.geometry.getAttribute('position') as THREE.BufferAttribute)) this.reshaped.push({ mesh, stock: mesh.geometry });
      if (mesh.userData.bodyFeature === 'shavedHatch') this.handles.push(mesh);
      if (mesh.userData.bodyFeature === 'blackGrille') this.grilles.push(mesh);
    });
  }

  /** Switch on the features in `on`, the rest off; `paint` and `black` are the car's bound materials. */
  apply(on: readonly BodyFeature[], paint: THREE.Material, black: THREE.Material): void {
    for (const m of this.reshaped) m.mesh.geometry = variant(m.stock, on);
    for (const m of this.handles) m.visible = !on.includes('shavedHatch');
    for (const m of this.grilles) m.material = on.includes('blackGrille') ? black : paint;
  }
}
