/**
 * Vinyls: a small library of procedural shapes projected onto the painted
 * body with DecalGeometry. Layers are stored in car space so they survive
 * reloads, share codes and part swaps (they re-project onto whatever is there).
 */
import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { DecalLayer, VINYL_SHAPES, VinylShape } from '../sim/build';
import type { CarView } from './carView';

const CELL = 256;
const COLS = 4;
const ROWS = 3;

/** Width / height of each shape's projector. */
export const SHAPE_ASPECT: Record<VinylShape, number> = {
  stripe: 4,
  twinStripe: 4,
  flame: 2,
  tribal: 2,
  sponsorA: 3,
  sponsorB: 3,
  sponsorC: 3,
  number: 1,
  star: 1,
  chevron: 1.5,
};

export const SHAPE_LABELS: Record<VinylShape, string> = {
  stripe: 'Racing stripe',
  twinStripe: 'Twin stripes',
  flame: 'Flames',
  tribal: 'Tribal',
  sponsorA: 'Kamikaze Oil',
  sponsorB: 'Voltex',
  sponsorC: 'Nitro-X',
  number: 'Number',
  star: 'Star',
  chevron: 'Chevron',
};

let atlas: THREE.CanvasTexture | null = null;
const numberTextures = new Map<string, THREE.CanvasTexture>();

function drawShape(ctx: CanvasRenderingContext2D, shape: VinylShape, w: number, h: number): void {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  switch (shape) {
    case 'stripe':
      ctx.fillRect(0, h * 0.3, w, h * 0.4);
      break;
    case 'twinStripe':
      ctx.fillRect(0, h * 0.18, w, h * 0.24);
      ctx.fillRect(0, h * 0.58, w, h * 0.24);
      break;
    case 'flame': {
      ctx.beginPath();
      ctx.moveTo(0, h * 0.25);
      const tongues = 5;
      for (let i = 0; i < tongues; i++) {
        const y0 = h * (0.15 + (0.7 * i) / tongues);
        const y1 = h * (0.15 + (0.7 * (i + 0.5)) / tongues);
        const len = w * (0.55 + 0.4 * Math.sin(i * 1.7 + 1));
        ctx.quadraticCurveTo(len * 0.5, y0 - h * 0.08, len, y1 - h * 0.05);
        ctx.quadraticCurveTo(len * 0.55, y1 + h * 0.02, w * 0.18, y1 + h * 0.06);
      }
      ctx.lineTo(0, h * 0.85);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'tribal': {
      ctx.lineWidth = h * 0.08;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        const y = h * (0.3 + i * 0.2);
        ctx.moveTo(w * 0.05, y);
        ctx.bezierCurveTo(w * 0.35, y - h * 0.35, w * 0.6, y + h * 0.3, w * 0.95, y - h * 0.15);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(w * 0.95, h * 0.1);
      ctx.lineTo(w * 0.75, h * 0.35);
      ctx.lineTo(w * 0.98, h * 0.3);
      ctx.fill();
      break;
    }
    case 'sponsorA':
    case 'sponsorB':
    case 'sponsorC': {
      const text = shape === 'sponsorA' ? 'KAMIKAZE' : shape === 'sponsorB' ? 'VOLTEX' : 'NITRO-X';
      ctx.lineWidth = h * 0.06;
      ctx.strokeRect(w * 0.04, h * 0.2, w * 0.92, h * 0.6);
      let size = h * 0.42;
      ctx.font = `italic 900 ${size}px "Arial Black", Impact, sans-serif`;
      while (ctx.measureText(text).width > w * 0.84 && size > 10) {
        size -= 2;
        ctx.font = `italic 900 ${size}px "Arial Black", Impact, sans-serif`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2 + 2);
      break;
    }
    case 'star': {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = (i % 2 ? 0.2 : 0.48) * Math.min(w, h);
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'chevron': {
      ctx.beginPath();
      ctx.moveTo(w * 0.05, h * 0.1);
      ctx.lineTo(w * 0.55, h * 0.5);
      ctx.lineTo(w * 0.05, h * 0.9);
      ctx.lineTo(w * 0.3, h * 0.9);
      ctx.lineTo(w * 0.8, h * 0.5);
      ctx.lineTo(w * 0.3, h * 0.1);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'number':
      break;
  }
}

function getAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = CELL * COLS;
  c.height = CELL * ROWS;
  const ctx = c.getContext('2d')!;
  VINYL_SHAPES.forEach((shape, i) => {
    const aspect = SHAPE_ASPECT[shape];
    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    // Each shape uses the top CELL x CELL/aspect region of its cell, matching its projector.
    ctx.save();
    ctx.translate(x, y);
    drawShape(ctx, shape, CELL, CELL / aspect);
    ctx.restore();
  });
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return atlas;
}

function numberTexture(text: string): THREE.CanvasTexture {
  let t = numberTextures.get(text);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(128, 128, 120, 0, Math.PI * 2);
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.font = '900 150px "Arial Black", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || '7', 128, 138);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  numberTextures.set(text, t);
  return t;
}

export class DecalLayerView {
  private meshes: THREE.Mesh[] = [];

  constructor(private readonly view: CarView) {}

  rebuild(layers: DecalLayer[]): void {
    this.clear();
    if (!layers.length) return;
    const v = this.view;
    // Project in car space: temporarily neutralize the root and body transforms.
    const saved = {
      rp: v.root.position.clone(),
      rq: v.root.quaternion.clone(),
      bp: v.body.position.clone(),
      bq: v.body.quaternion.clone(),
      parent: v.root.parent,
    };
    v.root.removeFromParent();
    v.root.position.set(0, 0, 0);
    v.root.quaternion.identity();
    v.body.position.set(0, 0, 0);
    v.body.quaternion.identity();
    v.root.updateMatrixWorld(true);
    const targets = v.paintMeshes();
    for (const layer of layers) {
      this.project(layer, targets, false);
      if (layer.mirror) this.project(layer, targets, true);
    }
    v.root.position.copy(saved.rp);
    v.root.quaternion.copy(saved.rq);
    v.body.position.copy(saved.bp);
    v.body.quaternion.copy(saved.bq);
    saved.parent?.add(v.root);
    v.root.updateMatrixWorld(true);
  }

  private project(layer: DecalLayer, targets: THREE.Mesh[], mirror: boolean): void {
    const pos = new THREE.Vector3(...layer.pos);
    const normal = new THREE.Vector3(...layer.normal);
    let rot = layer.rotation;
    if (mirror) {
      pos.x = -pos.x;
      normal.x = -normal.x;
      rot = -rot;
    }
    const aspect = SHAPE_ASPECT[layer.shape];
    const size = new THREE.Vector3(layer.scale, layer.scale / aspect, 0.5);
    const m = new THREE.Matrix4().lookAt(pos.clone().add(normal), pos, new THREE.Vector3(0, 1, 0));
    const orient = new THREE.Euler().setFromRotationMatrix(m);
    orient.z += (rot * Math.PI) / 180;
    const isNumber = layer.shape === 'number';
    const map = isNumber ? numberTexture(layer.text ?? '7') : getAtlas();
    const idx = VINYL_SHAPES.indexOf(layer.shape);
    const mat = new THREE.MeshPhysicalMaterial({
      map,
      color: layer.color,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      roughness: 0.3,
      clearcoat: 1,
      alphaTest: 0.05,
    });
    for (const target of targets) {
      // Skip meshes far from the decal; DecalGeometry clips to the projector box anyway.
      const box = new THREE.Box3().setFromObject(target);
      if (box.distanceToPoint(pos) > Math.max(size.x, size.y)) continue;
      const geo = new DecalGeometry(target, pos, orient, size);
      if (!geo.attributes.position || geo.attributes.position.count === 0) {
        geo.dispose();
        continue;
      }
      // Lift the decal a few millimeters off the paint so it never loses the depth test.
      const pa = geo.attributes.position as THREE.BufferAttribute;
      const na = geo.attributes.normal as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) pa.setXYZ(i, pa.getX(i) + na.getX(i) * 0.004, pa.getY(i) + na.getY(i) * 0.004, pa.getZ(i) + na.getZ(i) * 0.004);
      if (!isNumber) {
        const uv = geo.attributes.uv as THREE.BufferAttribute;
        const u0 = (idx % COLS) / COLS;
        const vh = 1 / aspect / ROWS;
        const v0 = 1 - Math.floor(idx / COLS) / ROWS - vh;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) / COLS, v0 + uv.getY(i) * vh);
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 2;
      this.view.model.add(mesh);
      this.meshes.push(mesh);
    }
  }

  clear(): void {
    const mats = new Set<THREE.Material>();
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      mats.add(m.material as THREE.Material);
    }
    mats.forEach((m) => m.dispose());
    this.meshes = [];
  }

  dispose(): void {
    this.clear();
  }
}
