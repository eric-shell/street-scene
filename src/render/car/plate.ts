/**
 * Rear license plate: one small plane with the plate drawn on a canvas (the player's name as the
 * registration), set on the rear bumper's face. No car or bumper kit carries a plate recess, and
 * the kits reshape the whole bumper, so the plate finds its own seat: rays shot forward at the tail
 * along the car's centre line find the rearmost backward facing body surface in the bumper band,
 * and the plate sits on that point, tilted to its normal. One mesh and one draw per car.
 *
 * Parked (FEATURES.plates, 2026-10-22): seen in the garage the plates sat a little too high and a
 * little too big on all three cars. The size has come down once since; the seat still wants to sit on
 * the flat stretch of the bumper's face, not its lowest flush point. The tails along the centre line
 * (first body hit per height, car space): Hatch flat face y 0.38 to 0.52 at z -1.99 (its lower bumper
 * slopes under from 0.36 down, the tailgate bulge at 0.56 is 3 cm rearward); Coupe flat y 0.36 to
 * 0.48 at -2.18 (the bulge at 0.52 is 7 cm rearward); Wagon flat y 0.30 to 0.44 at -2.20 (bulge at
 * 0.46, 5 cm rearward). A seat at the middle of the longest flat, backward facing run under the
 * rearmost bulge would put every plate where a real one sits.
 */
import * as THREE from 'three';
import { drawTexture, fitFont } from '../textures/canvasKit';
import type { CarMaterialSet } from './carMaterials';

export const PLATE = {
  /** Plate face (m): a US plate's 2:1, a little under its 12 by 6 inches so it does not crowd the bumper. */
  width: 0.26,
  height: 0.13,
  /** How far the face stands off the bumper (m): clear of a convex bumper's curve across the plate's width. */
  proud: 0.012,
  /** Where on the car to look for the bumper's face (m over the ground), and the step between rays. */
  band: { from: 0.3, to: 0.6, step: 0.02 },
  /** The plate seats as low as it can on the face: a hit this close (m) to the rearmost one still counts as the face. */
  flush: 0.025,
  /** A surface counts as the bumper's face when it faces backward at least this much (its normal's -z). */
  facing: 0.7,
  /** Fallback seat when nothing is hit (the model has no tail in the band): plate centre height (m). */
  fallbackY: 0.42,
  /** Canvas size (px, 2:1 like the face). */
  texture: [512, 256] as const,
  /** The registration until the player's name is wired through. */
  defaultText: 'USERNAME',
  /** Most characters drawn; the font shrinks to fit what is left. */
  maxChars: 10,
  /** The caption over the registration (a fictional issuer, never a real state or country). */
  caption: 'STREET SCENE',
  /** Lit from the plate lamps: how much of the drawing glows on its own so it reads at night. */
  emissive: 0.35,
} as const;

/** The registration as drawn: trimmed, upper case, cut to the plate's length. */
export function plateText(text: string): string {
  return text.trim().toUpperCase().slice(0, PLATE.maxChars) || PLATE.defaultText;
}

/** Draw the plate for `text` onto the texture's canvas (a fresh draw each time; the texture re-uploads). */
export function drawPlate(tex: THREE.CanvasTexture, text: string): void {
  const c = tex.image as HTMLCanvasElement;
  const g = c.getContext('2d')!;
  const w = c.width;
  const h = c.height;
  // Reflective white sheet, a little warmer at the top where the plate lamp falls.
  const sheet = g.createLinearGradient(0, 0, 0, h);
  sheet.addColorStop(0, '#f4f1e8');
  sheet.addColorStop(1, '#d9d5c8');
  g.fillStyle = sheet;
  g.fillRect(0, 0, w, h);
  // The embossed rim: a dark line inset from the edge.
  g.strokeStyle = '#2a3147';
  g.lineWidth = h * 0.03;
  const inset = h * 0.045;
  g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  // Two bolt heads at the top corners.
  g.fillStyle = '#4a4f5c';
  for (const x of [w * 0.1, w * 0.9]) {
    g.beginPath();
    g.arc(x, h * 0.17, h * 0.035, 0, Math.PI * 2);
    g.fill();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#1a2440';
  // The issuer's caption, small over the registration.
  fitFont(g, PLATE.caption, w * 0.5, h * 0.13, (px) => `700 ${px}px 'Google Sans Flex', system-ui, sans-serif`);
  g.fillText(PLATE.caption, w / 2, h * 0.19);
  // The registration: a heavy, slightly condensed face, as embossed plates are.
  const reg = plateText(text);
  fitFont(g, reg, w * 0.84, h * 0.5, (px) => `900 ${px}px 'Google Sans Flex', Impact, system-ui, sans-serif`);
  g.fillText(reg, w / 2, h * 0.6);
  tex.needsUpdate = true;
}

/** The plate's texture, drawn for `text`; null without a DOM (headless), where there is no plate. */
export function plateTexture(text: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const [w, h] = PLATE.texture;
  const tex = drawTexture(w, h, () => undefined, { repeat: false, anisotropy: 8 });
  drawPlate(tex, text);
  return tex;
}

/** The plate's material: the drawing lit by the scene and glowing a little on its own, like a plate under its lamp. */
export function createPlateMaterial(map: THREE.Texture, envMap: THREE.Texture | null): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'Plate',
    map,
    emissive: 0xffffff,
    emissiveMap: map,
    emissiveIntensity: PLATE.emissive,
    metalness: 0.15,
    roughness: 0.55,
    envMap,
    envMapIntensity: 0.8,
  });
}

/** The plate's face, facing backward (-z) with its text reading left to right from behind the car. */
export function buildPlateGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(PLATE.width, PLATE.height).rotateY(Math.PI);
}

/** The plate's seat in model space: where its centre sits and which way its face points. */
export interface PlateSeat {
  position: THREE.Vector3;
  normal: THREE.Vector3;
}

/** Scratch for seatPlate. */
const RAY = new THREE.Raycaster();
const ORIGIN = new THREE.Vector3();
const DIR = new THREE.Vector3();
const MODEL_Q = new THREE.Quaternion();
const INV_Q = new THREE.Quaternion();
const HIT = new THREE.Vector3();
const NORMAL = new THREE.Vector3();
const NORMAL_M = new THREE.Matrix3();
const INV_M = new THREE.Matrix4();

/**
 * Find the plate's seat on `model`: rays from behind the tail, forward along the centre line, one per
 * step of the bumper band. The bumper's face is the rearmost hit on a body surface facing backward,
 * and the plate seats on the lowest hit that is still flush with it (PLATE.flush), where plates sit,
 * not on the bulge above. Lamps, glass, chrome tips and the plate itself never seat it. Falls back to
 * the tail of the car's length.
 */
export function seatPlate(model: THREE.Object3D, materials: CarMaterialSet, length: number, skip: THREE.Object3D): PlateSeat {
  const seat: PlateSeat = { position: new THREE.Vector3(0, PLATE.fallbackY, -length / 2), normal: new THREE.Vector3(0, 0, -1) };
  const body = new Set<THREE.Material>([materials.Paint, materials.RoofPaint, materials.MirrorPaint, materials.Trim, materials.Black, materials.Grille]);
  const targets: THREE.Mesh[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh === skip) return;
    for (let n: THREE.Object3D | null = mesh; n && n !== model; n = n.parent) if (!n.visible) return;
    targets.push(mesh);
  });
  if (!targets.length) return seat;
  model.updateWorldMatrix(true, true);
  model.getWorldQuaternion(MODEL_Q);
  INV_Q.copy(MODEL_Q).invert();
  INV_M.copy(model.matrixWorld).invert();
  DIR.set(0, 0, 1).applyQuaternion(MODEL_Q);
  const hits: { y: number; z: number; ny: number; nz: number }[] = [];
  for (let y = PLATE.band.from; y <= PLATE.band.to + 1e-6; y += PLATE.band.step) {
    ORIGIN.set(0, y, -length).applyMatrix4(model.matrixWorld);
    RAY.set(ORIGIN, DIR);
    RAY.far = length;
    for (const hit of RAY.intersectObjects(targets, false)) {
      const mesh = hit.object as THREE.Mesh;
      const mat = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
      if (!body.has(mat)) continue;
      HIT.copy(hit.point).applyMatrix4(INV_M);
      NORMAL.copy(hit.face!.normal).applyMatrix3(NORMAL_M.getNormalMatrix(mesh.matrixWorld)).applyQuaternion(INV_Q).normalize();
      // The body shell is double sided: take the face as it looks at the ray.
      if (NORMAL.z > 0) NORMAL.negate();
      if (-NORMAL.z < PLATE.facing) continue;
      hits.push({ y: HIT.y, z: HIT.z, ny: NORMAL.y, nz: NORMAL.z });
      // The first body hit along this ray is the surface the plate would touch; deeper ones are inside.
      break;
    }
  }
  if (!hits.length) return seat;
  const rear = Math.min(...hits.map((h) => h.z));
  // The rays went up the band, so the first flush hit is the lowest.
  const h = hits.find((hit) => hit.z <= rear + PLATE.flush)!;
  seat.position.set(0, h.y, h.z);
  seat.normal.set(0, h.ny, h.nz).normalize();
  return seat;
}
