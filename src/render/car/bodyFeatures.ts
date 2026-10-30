/**
 * A car's unique features (VisualBuild.features, BODY_FEATURES), cut from its model once per loaded file
 * (CarAssetLibrary.carModel) and switched per car by BodyFeatureView. The manifest gives each feature a box in car
 * space (`bodyFeatures`), the way it boxes the mirror caps:
 * - A feature authored in the model: nodes `<feature>_off`, drawn while the switch is off, and `<feature>_on`, drawn
 *   while it is on; its box only says the car offers it. The Wendt Strom's shavedHatch is the hatch handle at the
 *   source's full detail and the hatch skin closed flush over the same hole (carDonors.py feature_nodes). Pressing
 *   the reduced body's recess flat at load, as it first did, left the lock's and the cup's black slivers showing.
 *   Its shavedRubstrip is the faces round the side strip as shipped and the same faces pressed onto the skin
 *   (carDonors.py strip_nodes). A feature with a box and no nodes or reshape (halfCupHandles, for now) is a switch
 *   that changes nothing.
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

type Box = { min: THREE.Vector3; max: THREE.Vector3; mirrored: boolean };

/** A feature's new positions and normals (mesh space) for some of a position attribute's vertices. */
interface Reshape {
  ids: number[];
  pos: number[];
  normal: number[];
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
function reshape(pos: THREE.BufferAttribute, normal: THREE.BufferAttribute | undefined, toCar: THREE.Matrix4, feature: BodyFeature, move: (i: number, p: THREE.Vector3, n: THREE.Vector3) => boolean): void {
  const fromCar = toCar.clone().invert();
  const normalToCar = new THREE.Matrix3().getNormalMatrix(toCar);
  const normalFromCar = new THREE.Matrix3().getNormalMatrix(fromCar);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const r: Reshape = { ids: [], pos: [], normal: [] };
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
 * Tag the authored feature nodes and cut the other features in `boxes` from a freshly loaded car scene (before any
 * clone, after the mirror caps' split).
 * `isPaint` says which source materials are body paint.
 */
export function splitBodyFeatures(root: THREE.Object3D, boxes: Partial<Record<BodyFeature, BodyFeatureBox>>, isPaint: (m: THREE.Material) => boolean): void {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const authored = new Set<BodyFeature>();
  root.traverse((o) => {
    // Exact names only: a node with two materials loads as a group of meshes named `<node>_1`, `<node>_2`.
    const [, feature, side] = /^(\w+?)_(on|off)$/.exec(o.name) ?? [];
    if (!BODY_FEATURES.includes(feature as BodyFeature)) return;
    o.userData.featureNode = { feature, on: side === 'on' };
    // Stock until a BodyFeatureView says otherwise: the roadblocks draw the base model without one.
    o.visible = side === 'off';
    authored.add(feature as BodyFeature);
  });
  if (boxes.blackGrille && !authored.has('blackGrille')) {
    const box = toBox(boxes.blackGrille, false);
    for (const { mesh, toCar } of meshesOf(root, toRoot, isPaint)) {
      if (mesh.userData.bodyFeature) continue;
      const ids = faces(mesh.geometry);
      splitOff(mesh, ids, piecesIn(mesh.geometry, ids, verticesIn(mesh.geometry.getAttribute('position'), toCar, box)), 'blackGrille');
    }
  }
  if (boxes.euroMirrors && !authored.has('euroMirrors')) narrowMirrors(root, toRoot, toBox(boxes.euroMirrors, true));
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
    g.setIndex(geo.getIndex());
    for (const gr of geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    mine.set(key, g);
  }
  return g;
}

/** One car's features: the meshes each switch touches, found once in its bound model (CarView.load). */
export class BodyFeatureView {
  private readonly reshaped: { mesh: THREE.Mesh; stock: THREE.BufferGeometry }[] = [];
  /** The authored feature nodes (`<feature>_on` / `_off`) and the state each is drawn in. */
  private readonly nodes: { node: THREE.Object3D; feature: BodyFeature; on: boolean }[] = [];
  private readonly grilles: THREE.Mesh[] = [];

  constructor(model: THREE.Object3D) {
    model.traverse((o) => {
      if (o.userData.featureNode) this.nodes.push({ node: o, ...o.userData.featureNode });
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (reshapesOf.has(mesh.geometry.getAttribute('position') as THREE.BufferAttribute)) this.reshaped.push({ mesh, stock: mesh.geometry });
      if (mesh.userData.bodyFeature === 'blackGrille') this.grilles.push(mesh);
    });
  }

  /** Switch on the features in `on`, the rest off; `paint` and `black` are the car's bound materials. */
  apply(on: readonly BodyFeature[], paint: THREE.Material, black: THREE.Material): void {
    for (const m of this.reshaped) m.mesh.geometry = variant(m.stock, on);
    for (const n of this.nodes) n.node.visible = on.includes(n.feature) === n.on;
    for (const m of this.grilles) m.material = on.includes('blackGrille') ? black : paint;
  }
}
