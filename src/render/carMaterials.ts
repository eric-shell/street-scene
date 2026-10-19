/**
 * Runtime materials for the shared material vocabulary. Any mesh whose source
 * material is named e.g. "Paint" gets the player's paint, so new parts pick up
 * paint, trim, glass tint and light colors automatically.
 */
import * as THREE from 'three';
import { MATERIAL_NAMES, MaterialName } from '../shared/parts';
import type { PaintFinish, VisualBuild } from '../sim/build';

export type CarMaterialSet = Record<MaterialName, THREE.Material>;

export function createCarMaterials(): CarMaterialSet {
  const m = {} as CarMaterialSet;
  m.Paint = new THREE.MeshPhysicalMaterial({ name: 'Paint', color: 0xd11f3f, metalness: 0.7, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  m.Trim = new THREE.MeshStandardMaterial({ name: 'Trim', color: 0x15161a, metalness: 0.3, roughness: 0.5 });
  m.Black = new THREE.MeshStandardMaterial({ name: 'Black', color: 0x0b0b0d, roughness: 0.65 });
  m.Chrome = new THREE.MeshStandardMaterial({ name: 'Chrome', color: 0xdedede, metalness: 1, roughness: 0.12 });
  m.Glass = new THREE.MeshPhysicalMaterial({ name: 'Glass', color: 0x101820, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.7, envMapIntensity: 1.4 });
  m.Rim = new THREE.MeshStandardMaterial({ name: 'Rim', color: 0xc9ced8, metalness: 0.9, roughness: 0.22 });
  m.Tire = new THREE.MeshStandardMaterial({ name: 'Tire', color: 0x141414, roughness: 0.92 });
  m.HeadLight = new THREE.MeshStandardMaterial({ name: 'HeadLight', color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 1.3 });
  m.TailLight = new THREE.MeshStandardMaterial({ name: 'TailLight', color: 0x330000, emissive: 0xff1a2a, emissiveIntensity: 1.4 });
  m.Light = new THREE.MeshStandardMaterial({ name: 'Light', color: 0x332200, emissive: 0xffa040, emissiveIntensity: 0.8 });
  m.Interior = new THREE.MeshStandardMaterial({ name: 'Interior', color: 0x1a1a1e, roughness: 0.8 });
  return m;
}

const FINISH: Record<PaintFinish, Partial<THREE.MeshPhysicalMaterialParameters>> = {
  gloss: { metalness: 0.0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0, sheen: 0, specularIntensity: 1 },
  metallic: { metalness: 0.75, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, iridescence: 0, sheen: 0, specularIntensity: 1 },
  matte: { metalness: 0.05, roughness: 0.85, clearcoat: 0, clearcoatRoughness: 0.5, iridescence: 0, sheen: 0, specularIntensity: 0.4 },
  pearl: { metalness: 0.35, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04, iridescence: 1, iridescenceIOR: 1.6, sheen: 0.6, specularIntensity: 1 },
  candy: { metalness: 0.55, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.0, iridescence: 0, sheen: 0, specularIntensity: 1 },
};

export function applyVisualToMaterials(m: CarMaterialSet, v: VisualBuild, braking = false): void {
  const paint = m.Paint as THREE.MeshPhysicalMaterial;
  const f = FINISH[v.paint.finish];
  paint.setValues(f);
  paint.iridescenceThicknessRange = [180, 760];
  paint.sheenColor.set(0xffffff);
  const base = new THREE.Color(v.paint.color);
  if (v.paint.finish === 'candy') {
    // Deep clearcoat over a tinted base: darker body, colored reflections.
    paint.color.copy(base).multiplyScalar(0.55);
    paint.specularColor.copy(base).lerp(new THREE.Color(1, 1, 1), 0.25);
    paint.envMapIntensity = 1.6;
  } else {
    paint.color.copy(base);
    paint.specularColor.set(0xffffff);
    paint.envMapIntensity = 1;
  }
  paint.needsUpdate = true;
  (m.Trim as THREE.MeshStandardMaterial).color.set(v.trimColor);
  (m.Rim as THREE.MeshStandardMaterial).color.set(v.wheels.color);
  const glass = m.Glass as THREE.MeshPhysicalMaterial;
  glass.color.set(v.tint.color).lerp(new THREE.Color(0x8fa0b0), 1 - v.tint.darkness);
  glass.opacity = 0.35 + v.tint.darkness * 0.62;
  (m.HeadLight as THREE.MeshStandardMaterial).emissive.set(v.headlightColor);
  setBrake(m, v.taillightColor, braking);
}

export function setBrake(m: CarMaterialSet, color: string, braking: boolean): void {
  const tl = m.TailLight as THREE.MeshStandardMaterial;
  tl.emissive.set(color);
  tl.emissiveIntensity = braking ? 4.5 : 1.4;
}

/** Map a source material name to the shared vocabulary (exact, case-insensitive, or via manifest map). */
export function resolveMaterialName(name: string, map: Record<string, string> = {}): MaterialName | null {
  if (map[name] && (MATERIAL_NAMES as readonly string[]).includes(map[name])) return map[name] as MaterialName;
  const exact = MATERIAL_NAMES.find((n) => n.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const base = name.replace(/[._\-\s]*\d+$/, '');
  return MATERIAL_NAMES.find((n) => n.toLowerCase() === base.toLowerCase()) ?? null;
}

export function disposeCarMaterials(m: CarMaterialSet): void {
  for (const k of MATERIAL_NAMES) m[k].dispose();
}
