/**
 * A car's unique features (VisualBuild.features, BODY_FEATURES), cut from its model once per loaded file
 * (CarAssetLibrary.carModel) and switched per car by BodyFeatureView. The manifest gives each feature a box in car
 * space (`bodyFeatures`), the way it boxes the mirror caps:
 * - A feature authored in the model: nodes `<feature>_off`, drawn while the switch is off, and `<feature>_on`, drawn
 *   while it is on; its box only says the car offers it. The Wendt Strom's shavedHatch is the hatch handle at the
 *   source's full detail and the hatch skin closed flush over the same hole (carDonors.py feature_nodes). Pressing
 *   the reduced body's recess flat at load, as it first did, left the lock's and the cup's black slivers showing.
 *   Its shavedRubstrip is an `_off` node alone, the side strip's own shell, lying on a door panel that runs on
 *   underneath it (carDonors.py strip_nodes). Its fogLights is an `_on` node alone (the lamps in the outer intakes, outside
 *   every front bumper part, so they show on any of them), and its shavedMarkers a patch cut out of the stock
 *   fenders and of every fender part that carries those faces, so the switch works whichever fenders are on.
 *   Its windSplitters is an `_on` node alone, the fins in the roof's drip rails (carKit.py ditch_fin), outside every
 *   roof part.
 *   Its halfCupHandles is a swap patch over each door handle's upper cup: `_off` the stock cup, `_on` the door
 *   pressed flush down to behind the bar's middle with a ledge onto the lower cup (carDonors.py half_cup_nodes).
 *   Its popOutWindows is a swap of the rear quarter glass: `_off` the stock glass, `_on` the glass turned 5.5 cm out at
 *   the back about its front edge, with a black seal, a black reveal round the opening and the two link latch halfway up
 *   its rear edge
 *   (carDonors.py pop_out_nodes).
 *   A feature with a box and no nodes is a switch that changes nothing.
 * - blackGrille: the Paint pieces wholly inside the box (the grille's bars) become a child that takes the Black
 *   material of the lips and diffusers.
 * A piece is welded by position, not by index (a model splits its vertices along seams), so a piece the skin only
 * touches is never taken with it.
 * The Wendt Strom's Euro mirrors were a feature too, the stock housings narrowed at load by per-vertex reshapes;
 * they are a mirrors part now (carBuild.ts RETIRED_FEATURES), and the reshapes went with them.
 */
import * as THREE from 'three';
import { BODY_FEATURES, type BodyFeature } from '../../shared/carBuild';

/** A feature's box in car space (m, x left, y up, z forward). */
export interface BodyFeatureBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** Positions closer than this weld into one piece (m). */
const WELD = 5e-4;

type Box = { min: THREE.Vector3; max: THREE.Vector3 };

const toBox = (b: BodyFeatureBox): Box => ({ min: new THREE.Vector3(...b.min), max: new THREE.Vector3(...b.max) });
const inBox = (p: THREE.Vector3, b: Box) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

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
    const box = toBox(boxes.blackGrille);
    for (const { mesh, toCar } of meshesOf(root, toRoot, isPaint)) {
      if (mesh.userData.bodyFeature) continue;
      const ids = faces(mesh.geometry);
      splitOff(mesh, ids, piecesIn(mesh.geometry, ids, verticesIn(mesh.geometry.getAttribute('position'), toCar, box)), 'blackGrille');
    }
  }
}

/** One car's features: the meshes each switch touches, found once in its bound model (CarView.load). */
export class BodyFeatureView {
  /** The authored feature nodes (`<feature>_on` / `_off`) and the state each is drawn in. */
  private readonly nodes: { node: THREE.Object3D; feature: BodyFeature; on: boolean }[] = [];
  private readonly grilles: THREE.Mesh[] = [];

  constructor(model: THREE.Object3D) {
    model.traverse((o) => {
      if (o.userData.featureNode) this.nodes.push({ node: o, ...o.userData.featureNode });
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.bodyFeature === 'blackGrille') this.grilles.push(mesh);
    });
  }

  /** Switch on the features in `on`, the rest off; `paint` and `black` are the car's bound materials. */
  apply(on: readonly BodyFeature[], paint: THREE.Material, black: THREE.Material): void {
    for (const n of this.nodes) n.node.visible = on.includes(n.feature) === n.on;
    for (const m of this.grilles) m.material = on.includes('blackGrille') ? black : paint;
  }
}
