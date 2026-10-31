/**
 * Runtime materials for the shared material vocabulary. Any mesh whose source
 * material is named e.g. "Paint" gets the player's paint, so new parts pick up
 * paint and glass tint automatically. Lamp colors are fixed, not a build choice.
 * The body, the wheels and their trims and the calipers are all paints (a color and a finish, applyPaint).
 * The windshield is split from the glass at load (windshield.ts): it stays clear, and gives way to the banner's band: the windows' tint as the same glass, or a vinyl.
 */
import * as THREE from 'three';
import { MATERIAL_NAMES, MaterialName } from '../../shared/parts';
import { type AccentPaint, type Paint, type PaintFinish, type VisualBuild, type AccentFinish, type WheelTrim } from '../../shared/carBuild';
import { BRAKE, caliperLogoTexture, rotorTexture } from './brakes';
import { TIRE_BUMP, acquireTireTexture, releaseTireTexture, tireShader } from './tireTread';
import { chromeEnvironment } from './chromeEnv';

/**
 * The shared runtime materials, plus the rear axle's own wheel material so front and rear wheel colors
 * can differ, the brake unit's rotor and caliper (brakes.ts), which no part GLB names, and the windshield and
 * its banner (windshield.ts), split from the glass at load.
 */
export type CarMaterialSet = Record<MaterialName, THREE.Material> & { RimRear: THREE.Material; RimLipRear: THREE.Material; RimCapRear: THREE.Material; Rotor: THREE.Material; Caliper: THREE.Material; RoofPaint: THREE.Material; MirrorPaint: THREE.Material; Lug: THREE.Material; LugRear: THREE.Material; Hardware: THREE.Material; HardwareRear: THREE.Material; Windshield: THREE.Material; Banner: THREE.Material };

/** Each painted material's environment reflection strength (the boost createCarMaterials gives it); candy raises it. */
const PAINT_ENV = { Paint: 1.9, Trim: 1.3, Rim: 1.8, RimLip: 1.8, RimCap: 1.8, Caliper: 1.2 } as const;
/** The glass's environment reflection strength (the boost createCarMaterials gives it). */
const GLASS_ENV = 1.7;
/** Untinted glass: the color a tint fades to as its darkness goes to 0, and the windshield's always. */
const CLEAR_GLASS = new THREE.Color(0x8fa0b0);
/** The glass's surface: smooth, no coat; an unpainted banner wears it too. */
const GLASS = { metalness: 0, roughness: 0.04, clearcoat: 0, clearcoatRoughness: 0, iridescence: 0, sheen: 0, specularIntensity: 1 } as const;

/**
 * The polished look of the Chrome material (createCarMaterials), which a chrome finish wears, always in this color.
 * `env` is its reflection strength in the car's own environment (the body's trim); `wheelEnv` a chrome wheel surface's
 * in the chrome studio (chromeEnv.ts), whose radiance is already set for a mirror.
 */
const CHROME = { color: 0xdedede, env: 2.2, wheelEnv: 0.45, surface: { metalness: 1, roughness: 0.12, clearcoat: 0, clearcoatRoughness: 0, iridescence: 0, sheen: 0, specularIntensity: 1 } } as const;
/**
 * The trim's one look (the carbon look pieces): gloss near black. No shipped car or part carries Trim faces, so the
 * build has no trim paint; the material keeps the name for parts that may.
 */
const TRIM_PAINT: Paint<AccentFinish> = { color: '#15161a', finish: 'gloss' };

/** Each wheel material's own environment (the car's), to go back to when it leaves chrome (a Map, not userData: a material's clone copies userData through JSON). */
const carEnv = new WeakMap<THREE.Material, THREE.Texture | null>();

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
  // Physical like the body, in TRIM_PAINT's gloss (applyVisualToMaterials).
  m.Trim = new THREE.MeshPhysicalMaterial({ name: 'Trim', color: 0x15161a, metalness: 0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05 });
  m.Black = new THREE.MeshStandardMaterial({ name: 'Black', color: 0x0b0b0d, roughness: 0.65 });
  m.Chrome = new THREE.MeshStandardMaterial({ name: 'Chrome', color: 0xdedede, metalness: 1, roughness: 0.12 });
  m.Glass = new THREE.MeshPhysicalMaterial({ name: 'Glass', color: 0x101820, ...GLASS, transparent: true, opacity: 0.7, envMapIntensity: 1.4 });
  // Physical like the body so a wheel takes every paint finish (clearcoat, pearl, candy).
  m.Rim = new THREE.MeshPhysicalMaterial({ name: 'Rim', color: 0xc9ced8, metalness: 0.75, roughness: 0.32 });
  // The lip and the center cap are their own materials so each takes its own finish (polished, the face's paint, or a color).
  m.RimLip = new THREE.MeshPhysicalMaterial({ name: 'RimLip', color: 0xc9ced8, metalness: 0.75, roughness: 0.32 });
  m.RimCap = new THREE.MeshPhysicalMaterial({ name: 'RimCap', color: 0xc9ced8, metalness: 0.75, roughness: 0.32 });
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
  // The third brake light: a dark red lens until the pedal lights it (setBrake).
  m.BrakeLight = new THREE.MeshStandardMaterial({ name: 'BrakeLight', color: 0x3a0006, roughness: 0.2, emissive: 0xff1a2a, emissiveIntensity: 0 });
  // The unlit lenses: amber indicators and markers, red reflectors, and the clear covers over the main lamps
  // (see-through, so the reflectors and bulbs behind read as the lamp's detail, the way the window glass shows the cabin).
  // The amber carries a faint emissive of its own so it reads orange at night, far below a lamp's glow (it lights nothing).
  m.Light = new THREE.MeshPhysicalMaterial({ name: 'Light', color: 0xff8a1a, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0xff7a10, emissiveIntensity: 0.12 });
  m.ClearLens = new THREE.MeshPhysicalMaterial({ name: 'ClearLens', color: 0xf2f4f6, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  // A red lamp's chamber behind a clear section (the Wendt Strom's All Reds): ClearLens's gloss in a bright red, so its
  // walls and bowls shade, with a faint glow so it stays red at night; TailLight's full glow reads flat.
  m.RedLens = new THREE.MeshPhysicalMaterial({ name: 'RedLens', color: 0xc8121f, emissive: 0x4a0006, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  // A smoked lamp's insides behind the clear cover (the Wendt Strom's Smoked): the same gloss in dark grey, so its chambers shade.
  m.SmokeLens = new THREE.MeshPhysicalMaterial({ name: 'SmokeLens', color: 0x2a2c31, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  // A blue lamp's lens behind the clear cover (the Wendt Strom's Magic Blues): the same gloss in royal blue, a faint glow at night.
  m.BlueLens = new THREE.MeshPhysicalMaterial({ name: 'BlueLens', color: 0x1f3fd0, emissive: 0x050e3a, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  // The Magic Greens and Magic Yellows the same way, in the VW Harlequin's Pistachio green and Ginster yellow.
  m.GreenLens = new THREE.MeshPhysicalMaterial({ name: 'GreenLens', color: 0x2fa874, emissive: 0x04281a, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  m.YellowLens = new THREE.MeshPhysicalMaterial({ name: 'YellowLens', color: 0xf0c418, emissive: 0x3a2c00, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  // RedLens that lights up under braking (the City Golf's donut): at rest its faint glow is RedLens's, so the facets shade.
  m.BrakeLens = new THREE.MeshPhysicalMaterial({ name: 'BrakeLens', color: 0xc8121f, emissive: 0xff1a2a, emissiveIntensity: BRAKE_LENS_REST, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  m.Reflector = new THREE.MeshPhysicalMaterial({ name: 'Reflector', color: 0x7a0610, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  m.Lens = new THREE.MeshPhysicalMaterial({ name: 'Lens', color: 0xdfe6ee, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.22, depthWrite: false });
  m.Interior = new THREE.MeshStandardMaterial({ name: 'Interior', color: 0x1a1a1e, roughness: 0.8 });
  // Red woven webbing (a motorsport tow strap): matte, both sides since a strap is one thin loop.
  m.Strap = new THREE.MeshStandardMaterial({ name: 'Strap', color: 0xc8141c, roughness: 0.92, side: THREE.DoubleSide });
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
    const boost: Partial<Record<MaterialName, number>> = { ...PAINT_ENV, Black: 1, Chrome: 2.2, Glass: GLASS_ENV, Lens: 2, Tire: 0.8, Interior: 0.6 };
    for (const k of MATERIAL_NAMES) {
      const mat = m[k] as THREE.MeshStandardMaterial;
      mat.envMap = envMap;
      mat.envMapIntensity = boost[k] ?? 1;
    }
  }
  m.RimRear = m.Rim.clone();
  m.RimLipRear = m.RimLip.clone();
  m.RimCapRear = m.RimCap.clone();
  // The house lug nuts (lugNuts.ts): runtime materials, painted from the build, not part of the GLB vocabulary.
  m.Lug = new THREE.MeshPhysicalMaterial({ name: 'Lug', color: CHROME.color, metalness: 1, roughness: 0.12, envMap, envMapIntensity: CHROME.env });
  m.LugRear = m.Lug.clone();
  // The wheels' own copy of Chrome (bolt heads on the lips, donor bits), so the hardware paints apart from the body's trim.
  m.Hardware = new THREE.MeshPhysicalMaterial({ name: 'Hardware', color: CHROME.color, metalness: 1, roughness: 0.12, envMap, envMapIntensity: CHROME.env });
  m.HardwareRear = m.Hardware.clone();
  // Every wheel surface can be chrome, which reflects its own studio (chromeEnv.ts); applyPaint swaps back to the car's for any other finish.
  for (const k of ['Rim', 'RimRear', 'RimLip', 'RimLipRear', 'RimCap', 'RimCapRear', 'Lug', 'LugRear', 'Hardware', 'HardwareRear'] as const) carEnv.set(m[k], envMap);
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
  // The roof's Paint faces (bindRoof in carView.ts): a clone of the body paint, so a matched roof is the same look.
  m.RoofPaint = m.Paint.clone();
  // The mirror caps' Paint faces (mirrorCaps.ts), the same way: a matched cap is the body's look.
  m.MirrorPaint = m.Paint.clone();
  // The windshield: the glass's look, never tinted. It is not drawn in the banner's band (setBannerDepth): the
  // band is the banner's, the side glass's own tinted pane for a tint, or a vinyl.
  m.Windshield = m.Glass.clone();
  m.Windshield.name = 'Windshield';
  tintGlass(m.Windshield as THREE.MeshPhysicalMaterial, CLEAR_GLASS, 0);
  const cut = { value: -1 };
  m.Windshield.userData.cut = cut;
  m.Windshield.onBeforeCompile = (shader) => {
    shader.uniforms.bannerDepth = cut;
    withDrop(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', 'if (vBannerDrop <= bannerDepth) discard;\n#include <clipping_planes_fragment>');
  };
  // The banner, on the windshield's own faces, clipped to the band along its top (setBannerDepth), where the
  // windshield gives way to it: for a tint, one pane of the side glass's material (applyVisualToMaterials), so the
  // band is the same glass as the windows beside it; for a vinyl, an opaque paint.
  m.Banner = new THREE.MeshPhysicalMaterial({ name: 'Banner', envMap, visible: false });
  const depth = { value: -1 };
  m.Banner.userData.depth = depth;
  m.Banner.onBeforeCompile = (shader) => {
    shader.uniforms.bannerDepth = depth;
    withDrop(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', 'if (vBannerDrop > bannerDepth) discard;\n#include <clipping_planes_fragment>');
  };
  return m;
}

/** Hand a windshield shader each fragment's drop below the top edge (m, bannerDrop, windshield.ts) and the banner's depth uniform. */
function withDrop(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float bannerDrop;\nvarying float vBannerDrop;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBannerDrop = bannerDrop;');
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float bannerDepth;\nvarying float vBannerDrop;');
}

/**
 * How far below the windshield's top edge the banner reaches (m, windshield.ts bannerDepth; below 0 there is none):
 * the banner draws within it and the windshield outside it.
 */
export function setBannerDepth(m: CarMaterialSet, depth: number): void {
  (m.Banner.userData.depth as { value: number }).value = depth;
  (m.Windshield.userData.cut as { value: number }).value = depth;
}

/** Tint glass: `darkness` (0..1) of the way from clear to the tint's color, and as much less see-through. */
function tintGlass(mat: THREE.MeshPhysicalMaterial, color: THREE.ColorRepresentation, darkness: number): void {
  mat.color.set(color).lerp(CLEAR_GLASS, 1 - darkness);
  mat.opacity = tintOpacity(darkness);
}

/** Tinted glass's opacity at `darkness` (0..1). */
function tintOpacity(darkness: number): number {
  return 0.35 + darkness * 0.62;
}

const FINISH: Record<PaintFinish, Partial<THREE.MeshPhysicalMaterialParameters>> = {
  gloss: { metalness: 0.0, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0, sheen: 0, specularIntensity: 1 },
  metallic: { metalness: 0.75, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, iridescence: 0, sheen: 0, specularIntensity: 1 },
  matte: { metalness: 0.05, roughness: 0.85, clearcoat: 0, clearcoatRoughness: 0.5, iridescence: 0, sheen: 0, specularIntensity: 0.4 },
  pearl: { metalness: 0.35, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04, iridescence: 1, iridescenceIOR: 1.6, sheen: 0.6, specularIntensity: 1 },
  candy: { metalness: 0.55, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.0, iridescence: 0, sheen: 0, specularIntensity: 1 },
};

/**
 * Wheel surfaces (Rim, RimLip, RimCap, lug nuts, hardware) override the body's finishes where those go dark. A wheel's big
 * smooth faces (a lathed lip, a dished center) mirror the near-black garage and night environment, so the body's metallic
 * (0.75 metal, clearcoat) read almost black with a teal sheen. This one keeps a metallic glint but lets albedo and the key
 * lights carry it, like a cast silver alloy. Chrome stays a mirror (CHROME), of a studio of its own (chromeEnv.ts), since a
 * mirror of that same dark environment is just as dark; other finishes read fine and stay.
 */
const WHEEL_FINISH: Partial<Record<PaintFinish, Partial<THREE.MeshPhysicalMaterialParameters>>> = {
  metallic: { metalness: 0.15, roughness: 0.5, clearcoat: 0, clearcoatRoughness: 0.5, iridescence: 0, sheen: 0, specularIntensity: 1 },
};

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Paint a physical material: the finish's surface, then the color (a candy finish tints its reflections, a chrome
 * one is the Chrome material's polish in the paint's color).
 */
function applyPaint(mat: THREE.MeshPhysicalMaterial, p: Paint<AccentFinish>, env: number, wheel = false): void {
  mat.color.set(p.color);
  mat.specularColor.set(0xffffff);
  if (wheel && carEnv.has(mat)) mat.envMap = p.finish === 'chrome' ? chromeEnvironment() : (carEnv.get(mat) ?? null);
  if (p.finish === 'chrome') {
    // One look, never tinted: the paint's color is ignored (validPaint stores CHROME_COLOR for it anyway).
    mat.color.set(CHROME.color);
    mat.setValues(CHROME.surface);
    mat.envMapIntensity = wheel ? CHROME.wheelEnv : CHROME.env;
    mat.needsUpdate = true;
    return;
  }
  mat.setValues((wheel && WHEEL_FINISH[p.finish]) || FINISH[p.finish]);
  mat.iridescenceThicknessRange = [180, 760];
  mat.sheenColor.set(0xffffff);
  if (p.finish === 'candy') {
    // Deep clearcoat over a tinted base: darker base, colored reflections.
    mat.specularColor.copy(mat.color).lerp(WHITE, 0.25);
    mat.color.multiplyScalar(0.55);
    mat.envMapIntensity = env * (2.5 / 1.9);
  } else {
    mat.envMapIntensity = env;
  }
  mat.needsUpdate = true;
}

/**
 * Dress the materials in a build. The lip, cap and lug nuts resolve per axle ('face' wears that axle's wheel paint).
 */
export function applyVisualToMaterials(m: CarMaterialSet, v: VisualBuild, braking = false): void {
  // A matched accent wears the body's paint.
  const accent = <F extends AccentFinish>(p: AccentPaint<F>): Paint<AccentFinish> => (p.match ? v.paint : p);
  applyPaint(m.Paint as THREE.MeshPhysicalMaterial, v.paint, PAINT_ENV.Paint);
  // The roof's own copy of the body paint: the same look while matched, its own paint otherwise.
  applyPaint(m.RoofPaint as THREE.MeshPhysicalMaterial, v.roof.match ? v.paint : v.roof, PAINT_ENV.Paint);
  applyPaint(m.MirrorPaint as THREE.MeshPhysicalMaterial, accent(v.mirrors), PAINT_ENV.Paint);
  applyPaint(m.Rim as THREE.MeshPhysicalMaterial, accent(v.wheels.paint), PAINT_ENV.Rim, true);
  applyPaint(m.RimRear as THREE.MeshPhysicalMaterial, accent(v.wheels.rearPaint), PAINT_ENV.Rim, true);
  // A trim resolves per axle: its own paint, the body's, or that axle's face or cap.
  const wears = (t: WheelTrim, face: Paint<AccentFinish>, cap: Paint<AccentFinish>): Paint<AccentFinish> =>
    t.mode === 'paint' ? t : t.mode === 'body' ? v.paint : t.mode === 'cap' ? cap : face;
  const axle = (face: Paint<AccentFinish>, lip: THREE.Material, capMat: THREE.Material, lug: THREE.Material, hw: THREE.Material): void => {
    const cap = wears(v.wheels.cap, face, face);
    applyPaint(lip as THREE.MeshPhysicalMaterial, wears(v.wheels.lip, face, cap), PAINT_ENV.Rim, true);
    applyPaint(capMat as THREE.MeshPhysicalMaterial, cap, PAINT_ENV.Rim, true);
    applyPaint(lug as THREE.MeshPhysicalMaterial, wears(v.wheels.lugNuts, face, cap), PAINT_ENV.Rim, true);
    applyPaint(hw as THREE.MeshPhysicalMaterial, wears(v.wheels.hardware, face, cap), PAINT_ENV.Rim, true);
  };
  axle(accent(v.wheels.paint), m.RimLip, m.RimCap, m.Lug, m.Hardware);
  axle(accent(v.wheels.rearPaint), m.RimLipRear, m.RimCapRear, m.LugRear, m.HardwareRear);
  applyPaint(m.Caliper as THREE.MeshPhysicalMaterial, accent(v.calipers), PAINT_ENV.Caliper);
  applyPaint(m.Trim as THREE.MeshPhysicalMaterial, TRIM_PAINT, PAINT_ENV.Trim);
  // The side and rear glass; the windshield stays clear.
  tintGlass(m.Glass as THREE.MeshPhysicalMaterial, v.tint.color, v.tint.darkness);
  // The banner: a vinyl in its paint or the body's, or the side glass's tinted pane itself, parameter for parameter,
  // so the band and the windows beside it are one material.
  const b = v.banner;
  const banner = m.Banner as THREE.MeshPhysicalMaterial;
  banner.visible = b.enabled;
  if (b.vinyl) {
    applyPaint(banner, accent(b.paint), PAINT_ENV.Paint);
    banner.setValues({ transparent: false, opacity: 1 });
  } else {
    const glass = m.Glass as THREE.MeshPhysicalMaterial;
    banner.setValues({ ...GLASS, transparent: true, opacity: glass.opacity, envMapIntensity: glass.envMapIntensity, specularColor: glass.specularColor });
    banner.color.copy(glass.color);
    banner.needsUpdate = true;
  }
  setTireLettering(m, v.wheels.lettering === true);
  setBrake(m, braking);
}

/**
 * The main lamps' emissive at full (the night street): head and tail (lit, and under braking). The side
 * markers and indicators are unlit lenses (`Light`). A scene that shows the car parked (the garage) scales them with `lamps`, so the lenses read as lit
 * without blooming into blobs under the room's lights.
 */
export const LAMP_GLOW = { head: 1.3, tail: 1.4, brake: 4.5 } as const;
/** BrakeLens's emissive at rest: RedLens's faint glow (0x4a0006) as a share of the brake red. */
const BRAKE_LENS_REST = 0.29;

/** Brake lights follow the pedal; the rotors glow with their heat (0 cold to 1, the car view's rotorHeat); `lamps` scales the lenses (CarView.setLampLevel). */
export function setBrake(m: CarMaterialSet, braking: boolean, heat = braking ? 1 : 0, lamps = 1): void {
  const tl = m.TailLight as THREE.MeshStandardMaterial;
  tl.emissiveIntensity = (braking ? LAMP_GLOW.brake : LAMP_GLOW.tail) * lamps;
  (m.BrakeLight as THREE.MeshStandardMaterial).emissiveIntensity = braking ? LAMP_GLOW.brake * lamps : 0;
  (m.BrakeLens as THREE.MeshPhysicalMaterial).emissiveIntensity = braking ? LAMP_GLOW.brake * lamps : BRAKE_LENS_REST;
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
  m.RimLipRear.dispose();
  m.RimCapRear.dispose();
  m.Lug.dispose();
  m.LugRear.dispose();
  m.Hardware.dispose();
  m.HardwareRear.dispose();
  (m.Rotor as THREE.MeshStandardMaterial).map?.dispose();
  m.Rotor.dispose();
  (m.Caliper as THREE.MeshStandardMaterial).map?.dispose();
  m.Caliper.dispose();
  m.RoofPaint.dispose();
  m.MirrorPaint.dispose();
  m.Windshield.dispose();
  m.Banner.dispose();
}
