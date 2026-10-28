/**
 * Runtime materials for the shared material vocabulary. Any mesh whose source
 * material is named e.g. "Paint" gets the player's paint, so new parts pick up
 * paint, trim and glass tint automatically. Lamp colors are fixed, not a build choice.
 * The body, the wheels and the calipers are all paints (a color and a finish, applyPaint).
 */
import * as THREE from 'three';
import { MATERIAL_NAMES, MaterialName } from '../../shared/parts';
import type { AccentPaint, Paint, PaintFinish, VisualBuild } from '../../shared/carBuild';
import { BRAKE, caliperLogoTexture, rotorTexture } from './brakes';
import { TIRE_BUMP, acquireTireTexture, releaseTireTexture, tireShader } from './tireTread';

/**
 * The shared runtime materials, plus the rear axle's own wheel material so front and rear wheel colors
 * can differ, and the brake unit's rotor and caliper (brakes.ts), which no part GLB names.
 */
export type CarMaterialSet = Record<MaterialName, THREE.Material> & { RimRear: THREE.Material; Rotor: THREE.Material; Caliper: THREE.Material };

/** Each painted material's environment reflection strength (the boost createCarMaterials gives it); candy raises it. */
const PAINT_ENV = { Paint: 1.9, Rim: 1.8, Caliper: 1.2 } as const;

/** Car space meters per UV unit on Grille faces (GRILLE_UV in scripts/blender/carDonors.py). */
const GRILLE_UV_SPAN = 3;

/** Grille patterns, drawn as a texture on every car's flattened grille surfaces: no triangles. */
export type GrillePattern = 'ribs' | 'mesh' | 'honeycomb';
export const GRILLE_PATTERN: GrillePattern = 'mesh';
/** Cell size of each pattern, meters: the same on every car. */
const GRILLE_CELL: Record<GrillePattern, number> = { ribs: 0.022, mesh: 0.018, honeycomb: 0.05 };

/**
 * One cell of a grille pattern as a small repeating texture: 1 on the bars, low in the holes. It is
 * the color map (dark holes) and the bump map (raised bars), so the bars catch the headlights of
 * the car behind. Built from bytes, not a canvas, so it
 * also works where there is no DOM.
 */
function grilleTexture(pattern: GrillePattern): THREE.DataTexture {
  const n = 32;
  const bar = (u: number, v: number): number => {
    if (pattern === 'ribs') return 0.5 - 0.5 * Math.cos(2 * Math.PI * v);
    if (pattern === 'mesh') {
      // Diamond mesh: two diagonal bar families.
      const d1 = Math.abs(((u + v) % 1) - 0.5) * 2;
      const d2 = Math.abs((((u - v) % 1) + 1) % 1 - 0.5) * 2;
      return Math.max(0, 1 - Math.min(d1, d2) / 0.28);
    }
    // Honeycomb: distance to the nearest hexagon center on a pointy-top lattice (cell 1 x sqrt(3)).
    const y = v * Math.sqrt(3);
    let best = 9;
    for (const [cx, cy] of [[0, 0], [1, 0], [0.5, Math.sqrt(3) / 2], [0, Math.sqrt(3)], [1, Math.sqrt(3)]]) {
      const dx = Math.abs(u - cx);
      const dy = Math.abs(y - cy);
      best = Math.min(best, Math.max(dx, dx * 0.5 + dy * (Math.sqrt(3) / 2)));
    }
    return Math.min(1, Math.max(0, (best - 0.36) / 0.08));
  };
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const b = bar((i + 0.5) / n, (j + 0.5) / n);
      const c = Math.round(255 * (0.12 + 0.88 * b));
      data.set([c, c, c, 255], (j * n + i) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  const k = GRILLE_UV_SPAN / GRILLE_CELL[pattern];
  tex.repeat.set(k, pattern === 'honeycomb' ? k / Math.sqrt(3) : k);
  tex.needsUpdate = true;
  return tex;
}

/**
 * The tire's tread texture (tireTread.ts) on the material, plain or lettered: the same texture is its color
 * (ink), bump and roughness. Changing variants swaps the texture only, so nothing recompiles. A tire made
 * without a tread (low quality) stays plain rubber.
 */
export function setTireLettering(m: CarMaterialSet, lettering: boolean): void {
  const tire = m.Tire as THREE.MeshStandardMaterial;
  if (!tire.map || tire.userData.lettering === lettering) return;
  tire.userData.lettering = lettering;
  const tex = acquireTireTexture(lettering);
  releaseTireTexture(tire.map);
  tire.map = tire.bumpMap = tire.roughnessMap = tex;
}

/** `tread`: dress the tire in the tread texture (medium and up); low leaves it plain rubber. */
export function createCarMaterials(envMap: THREE.Texture | null = null, tread = false): CarMaterialSet {
  const m = {} as CarMaterialSet;
  m.Paint = new THREE.MeshPhysicalMaterial({ name: 'Paint', color: 0xd11f3f, metalness: 0.7, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 });
  m.Trim = new THREE.MeshStandardMaterial({ name: 'Trim', color: 0x15161a, metalness: 0.3, roughness: 0.5 });
  m.Black = new THREE.MeshStandardMaterial({ name: 'Black', color: 0x0b0b0d, roughness: 0.65 });
  m.Chrome = new THREE.MeshStandardMaterial({ name: 'Chrome', color: 0xdedede, metalness: 1, roughness: 0.12 });
  m.Glass = new THREE.MeshPhysicalMaterial({ name: 'Glass', color: 0x101820, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.7, envMapIntensity: 1.4 });
  // Physical like the body so a wheel takes every paint finish (clearcoat, pearl, candy).
  m.Rim = new THREE.MeshPhysicalMaterial({ name: 'Rim', color: 0xc9ced8, metalness: 0.75, roughness: 0.32 });
  // Both sides: where the arch clip cuts a tire, its inside shows as solid rubber, not a hole through to the wheel (tireShader).
  m.Tire = new THREE.MeshStandardMaterial({ name: 'Tire', color: 0x141414, roughness: 0.92, side: THREE.DoubleSide });
  m.Tire.onBeforeCompile = tireShader;
  const treadTex = tread ? acquireTireTexture(false) : null;
  if (treadTex) {
    const tire = m.Tire as THREE.MeshStandardMaterial;
    tire.map = tire.bumpMap = tire.roughnessMap = treadTex;
    tire.bumpScale = TIRE_BUMP;
    tire.userData.lettering = false;
  }
  m.HeadLight = new THREE.MeshStandardMaterial({ name: 'HeadLight', color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: LAMP_GLOW.head });
  m.TailLight = new THREE.MeshStandardMaterial({ name: 'TailLight', color: 0x330000, emissive: 0xff1a2a, emissiveIntensity: LAMP_GLOW.tail });
  m.Light = new THREE.MeshStandardMaterial({ name: 'Light', color: 0x332200, emissive: 0xffa040, emissiveIntensity: LAMP_GLOW.marker });
  m.Interior = new THREE.MeshStandardMaterial({ name: 'Interior', color: 0x1a1a1e, roughness: 0.8 });
  const grille = grilleTexture(GRILLE_PATTERN);
  // Bright metal bars on dark holes: the map darkens the holes, the bump map raises the bars.
  m.Grille = new THREE.MeshStandardMaterial({ name: 'Grille', color: 0x9a9ea8, metalness: 0.7, roughness: 0.35, map: grille, bumpMap: grille, bumpScale: 2 });
  // The low poly bodies are hollow, single sided shells. Seen through the glass, the far
  // side's panels face away and were culled, so the far wheels (and the floor) showed
  // through the windows. Drawing the body's opaque materials double sided closes the
  // shell: the inside of the far door now occludes what is behind it.
  for (const k of ['Paint', 'Trim', 'Black', 'Chrome', 'Interior', 'Grille'] as const) m[k].side = THREE.DoubleSide;
  // Cars carry their own (stronger) environment reflections so they read clearly at night.
  if (envMap) {
    const boost: Partial<Record<MaterialName, number>> = { ...PAINT_ENV, Trim: 1.3, Black: 1, Chrome: 2.2, Glass: 1.7, Tire: 0.8, Interior: 0.6 };
    for (const k of MATERIAL_NAMES) {
      const mat = m[k] as THREE.MeshStandardMaterial;
      mat.envMap = envMap;
      mat.envMapIntensity = boost[k] ?? 1;
    }
  }
  m.RimRear = m.Rim.clone();
  // Brakes: the drilled face darkens the holes and the bump map dents them; the rotor glows while braking.
  const rotor = rotorTexture();
  m.Rotor = new THREE.MeshStandardMaterial({ name: 'Rotor', color: 0xc4c7cc, metalness: 0.7, roughness: 0.45, map: rotor, bumpMap: rotor, bumpScale: 1.2, emissive: 0xff6a1a, emissiveIntensity: 0, envMap, envMapIntensity: 1.4 });
  // The map is the logo plate's lettering as a mask (brakes.ts), blended to its ink over the paint, so the
  // letters stay white whatever the caliper wears, in the caliper's own draw.
  const logo = caliperLogoTexture();
  m.Caliper = new THREE.MeshPhysicalMaterial({ name: 'Caliper', color: 0xc41e3a, metalness: 0, roughness: 0.28, map: logo, envMap, envMapIntensity: PAINT_ENV.Caliper });
  m.Caliper.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${BRAKE.caliperLogo.ink.toFixed(2)}), texture2D(map, vMapUv).r);\n#endif`,
    );
  };
  return m;
}

const FINISH: Record<PaintFinish, Partial<THREE.MeshPhysicalMaterialParameters>> = {
  gloss: { metalness: 0.0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0, sheen: 0, specularIntensity: 1 },
  metallic: { metalness: 0.75, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, iridescence: 0, sheen: 0, specularIntensity: 1 },
  matte: { metalness: 0.05, roughness: 0.85, clearcoat: 0, clearcoatRoughness: 0.5, iridescence: 0, sheen: 0, specularIntensity: 0.4 },
  pearl: { metalness: 0.35, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04, iridescence: 1, iridescenceIOR: 1.6, sheen: 0.6, specularIntensity: 1 },
  candy: { metalness: 0.55, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.0, iridescence: 0, sheen: 0, specularIntensity: 1 },
};

const WHITE = new THREE.Color(1, 1, 1);

/** Paint a physical material: the finish's surface, then the color (a candy finish tints its reflections). */
function applyPaint(mat: THREE.MeshPhysicalMaterial, p: Paint, env: number): void {
  mat.setValues(FINISH[p.finish]);
  mat.iridescenceThicknessRange = [180, 760];
  mat.sheenColor.set(0xffffff);
  mat.color.set(p.color);
  if (p.finish === 'candy') {
    // Deep clearcoat over a tinted base: darker base, colored reflections.
    mat.specularColor.copy(mat.color).lerp(WHITE, 0.25);
    mat.color.multiplyScalar(0.55);
    mat.envMapIntensity = env * (2.5 / 1.9);
  } else {
    mat.specularColor.set(0xffffff);
    mat.envMapIntensity = env;
  }
  mat.needsUpdate = true;
}

/**
 * Dress the materials in a build. `envScale` scales the painted surfaces' environment reflections (1 the
 * night street's; the garage turns it down with its lights, since the paint's own map still holds them lit).
 */
export function applyVisualToMaterials(m: CarMaterialSet, v: VisualBuild, braking = false, envScale = 1): void {
  // A matched accent wears the body's paint.
  const accent = (p: AccentPaint): Paint => (p.match ? v.paint : p);
  applyPaint(m.Paint as THREE.MeshPhysicalMaterial, v.paint, PAINT_ENV.Paint * envScale);
  applyPaint(m.Rim as THREE.MeshPhysicalMaterial, accent(v.wheels.paint), PAINT_ENV.Rim * envScale);
  applyPaint(m.RimRear as THREE.MeshPhysicalMaterial, accent(v.wheels.rearPaint), PAINT_ENV.Rim * envScale);
  applyPaint(m.Caliper as THREE.MeshPhysicalMaterial, accent(v.calipers), PAINT_ENV.Caliper * envScale);
  (m.Trim as THREE.MeshStandardMaterial).color.set(v.trimColor);
  const glass = m.Glass as THREE.MeshPhysicalMaterial;
  glass.color.set(v.tint.color).lerp(new THREE.Color(0x8fa0b0), 1 - v.tint.darkness);
  glass.opacity = 0.35 + v.tint.darkness * 0.62;
  setTireLettering(m, v.wheels.lettering === true);
  setBrake(m, braking);
}

/**
 * The lamp lenses' emissive at full (the night street): head, tail (lit, and under braking) and the side
 * markers. A scene that shows the car parked (the garage) scales them with `lamps`, so the lenses read as lit
 * without blooming into blobs under the room's lights.
 */
export const LAMP_GLOW = { head: 1.3, tail: 1.4, brake: 4.5, marker: 0.8 } as const;

/** Brake lights follow the pedal; the rotors glow with their heat (0 cold to 1, the car view's rotorHeat); `lamps` scales the lenses (CarView.setLampLevel). */
export function setBrake(m: CarMaterialSet, braking: boolean, heat = braking ? 1 : 0, lamps = 1): void {
  const tl = m.TailLight as THREE.MeshStandardMaterial;
  tl.emissiveIntensity = (braking ? LAMP_GLOW.brake : LAMP_GLOW.tail) * lamps;
  (m.Rotor as THREE.MeshStandardMaterial).emissiveIntensity = BRAKE.glow * heat * heat;
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
  (m.Grille as THREE.MeshStandardMaterial).map?.dispose();
  releaseTireTexture((m.Tire as THREE.MeshStandardMaterial).map);
  for (const k of MATERIAL_NAMES) m[k].dispose();
  m.RimRear.dispose();
  (m.Rotor as THREE.MeshStandardMaterial).map?.dispose();
  m.Rotor.dispose();
  (m.Caliper as THREE.MeshStandardMaterial).map?.dispose();
  m.Caliper.dispose();
}
