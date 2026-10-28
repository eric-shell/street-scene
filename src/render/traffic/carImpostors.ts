/**
 * Impostors for cars far from the camera: past about 70 m (Medium; 100 m High,
 * 45 m Low) a traffic or yard car is a card from a sprite sheet instead of a
 * 2.2k to 3.4k triangle body, so a parking lot in view costs a few hundred
 * triangles of quads instead of 80 to 200k, and the cars can be drawn out to
 * 400 m, where they used to be dropped at 110 to 260 m.
 *
 * The sheet is baked once per page and tier, at load, from the traffic atlas
 * itself: each kind's body geometry is drawn by an orthographic camera from
 * 8 yaws round the car (x 1 pitch; 2 at High: a low and a raised view) into
 * two render targets, in one cell per view:
 *  - albedo (sRGB, RGB + coverage): the atlas colour as it comes, the paint
 *    left as the atlas stores it (grey), with a mild baked shade (roofs lighter,
 *    the lower body darker) since the card is lit by one flat normal. Lamps are
 *    not drawn: the lamp boxes of src/assets/trafficModels.json are separate
 *    meshes in the live scene;
 *  - mask (linear, half resolution): R the atlas alpha, the paint the instance
 *    colour tints, exactly as the body material reads it, so every one of the
 *    muted street paints works on a single sheet; G head lamps, B tail lamps,
 *    A the roof lamps (beacons and the taxi sign), each drawn as its lamp boxes
 *    with the depth test against the body. The shader lights those through the
 *    instance's own colours (parking lights, brake lamps, hazards, beacon flash),
 *    so the sprite's lamps follow what the sim says like the real lamp meshes do.
 * Memory with mips: albedo 4/3 of sheet^2 x 4 bytes plus the mask at a quarter
 * of that (low 1.75 MB, medium 7.0 MB, high 28 MB).
 *
 * Layout: cell = (kind * pitches + pitch) * angles + angle, rows from the top
 * of the sheet. Each kind has its own scale (metres per texel) so the longest
 * view (a bus broadside, a sedan from three quarters) fills its cell; the card
 * is that many metres across, centred on the car's middle, and stands
 * perpendicular to the baked view direction (so a camera above it sees the card
 * foreshortened, not edge on). An instance picks its angle in the vertex shader
 * from the car's yaw against the camera, its pitch row from the camera's
 * elevation, and takes the shared height fog and the scene's lights through a
 * MeshStandard program whose normal faces the camera, tilted toward the sky.
 *
 * The switch is a per car dither: the body fades out and the card in over the
 * same band with complementary screen-door patterns (the crowds' IMPOSTOR_DITHER_GLSL),
 * both from the 3D distance between the camera and the car's origin, so every
 * pixel is drawn by exactly one of them and nothing pops. `fadeOutBeyond`
 * gives that to the body, decal and lamp materials. A card with no body (a car
 * over the body count, or one the sim keeps drawn only far) is forced opaque.
 * Without a renderer (Vitest, the headless perf script) or when the bake fails
 * there is no sheet and cars keep their bodies to the old distances. Render only.
 */
import * as THREE from 'three';
import type { Quality } from '../../ui/settings';
import { IMPOSTOR_DITHER_GLSL } from '../people/impostors';
import type { TrafficLamp } from './traffic';

/** What a sheet is cut into, and the switch and the far rings of one quality tier. */
export interface CarImpostorSpec {
  /** The albedo sheet's edge (px, a square power of two); the mask is half of it. */
  sheet: number;
  /** One cell (px, even): twice as wide as tall; the kind's own scale fits its longest view in it. */
  cellW: number;
  cellH: number;
  /** View yaws round the car, evenly spaced from the front. */
  angles: number;
  /** Baked camera elevations (deg): one, or two (a low and a raised view). */
  pitches: readonly number[];
  /** Distance (m) where the body and the card trade places, and the width (m) of the dithered band round it. */
  distance: number;
  fade: number;
  /** Moving cars drawn only as cards (beyond the body picks) at most, and out to this distance (m, or the fog). */
  movingFar: number;
  movingDistance: number;
  /** Parked cars drawn only as cards at most (traffic's kerb and lot cars), and out to this distance (m, or the fog); the yard cars use the distance. */
  parkedFar: number;
  parkedDistance: number;
}

/** Sheets, switch distances and far counts per tier (see the module note for the memory). */
export const CAR_IMPOSTORS: Record<Quality, CarImpostorSpec> = {
  low: { sheet: 512, cellW: 48, cellH: 24, angles: 8, pitches: [10], distance: 45, fade: 8, movingFar: 16, movingDistance: 300, parkedFar: 120, parkedDistance: 260 },
  medium: { sheet: 1024, cellW: 96, cellH: 48, angles: 8, pitches: [12], distance: 70, fade: 8, movingFar: 40, movingDistance: 450, parkedFar: 300, parkedDistance: 400 },
  high: { sheet: 2048, cellW: 144, cellH: 72, angles: 8, pitches: [8, 28], distance: 100, fade: 8, movingFar: 64, movingDistance: 550, parkedFar: 400, parkedDistance: 450 },
};

/** Metres beyond the band's ends where the CPU stops drawing a body or starts a card: the shader has faded them out by then, so the cut is invisible. */
export const CAR_SWITCH_MARGIN = 3;

/** The sprite card's normal tilts this far toward the sky (the same flat-normal trick as the crowds). */
const TILT = 0.35;
/** A cell is this much larger than the longest view of the car, so no cell bleeds into the next. */
const FRAME_PAD = 1.06;
/** Alpha above which a texel is the car (mips thin the coverage a little, so below a half). */
const COVER = 0.4;
/** The baked shade: how dark a downward facing surface gets, and the lowest the lower body falls to. */
const SHADE = { floor: 0.62, low: 0.72 } as const;

/** One kind to bake: its body geometry in car space (+z forward, y up, origin at the ground) and its lamp boxes. */
export interface CarBakeKind {
  geometry: THREE.BufferGeometry;
  lamps: readonly TrafficLamp[];
}

/** A baked sheet and what the card material needs to read it. */
export interface CarSheet {
  albedo: THREE.Texture;
  mask: THREE.Texture;
  spec: CarImpostorSpec;
  kinds: number;
  /** Cells across the sheet. */
  cols: number;
  /** Per kind: card width, card height, centre height above the ground (m). */
  frames: readonly THREE.Vector4[];
  /** GPU memory of both textures with their mips (bytes). */
  bytes: number;
}

/** The scale (m per texel) and centre of a kind's cells: every view of its bounding box, at every baked yaw and pitch, fits. */
export function carFraming(box: THREE.Box3, spec: CarImpostorSpec): { scale: number; cy: number } {
  const cy = (box.min.y + box.max.y) / 2;
  const bx = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
  const by = (box.max.y - box.min.y) / 2;
  const bz = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
  let mx = 0;
  let my = 0;
  for (const deg of spec.pitches) {
    const e = (deg * Math.PI) / 180;
    for (let k = 0; k < spec.angles; k++) {
      const th = (k / spec.angles) * Math.PI * 2;
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1]) {
            const px = sx * bx;
            const pz = sz * bz;
            const rx = px * Math.cos(th) + pz * Math.sin(th);
            const rz = -px * Math.sin(th) + pz * Math.cos(th);
            mx = Math.max(mx, Math.abs(rx));
            my = Math.max(my, Math.abs(sy * by * Math.cos(e) - rz * Math.sin(e)));
          }
    }
  }
  return { scale: Math.max((2 * mx) / spec.cellW, (2 * my) / spec.cellH) * FRAME_PAD, cy };
}

/** Cells a spec needs and cells its sheet holds. */
function cellCounts(spec: CarImpostorSpec, kinds: number): { need: number; cols: number; have: number } {
  const cols = Math.floor(spec.sheet / spec.cellW);
  return { need: kinds * spec.pitches.length * spec.angles, cols, have: cols * Math.floor(spec.sheet / spec.cellH) };
}

/** The bake draws every cell as an instance (its matrix places and scales the view into the cell), so the vertex stage applies it. */
const BAKE_VERTEX = /* glsl */ `
uniform float uHeight;
varying vec2 vUv;
varying float vShade;
void main() {
  vUv = uv;
  float up = clamp(0.55 + 0.45 * normal.y, 0.0, 1.0);
  vShade = mix(${SHADE.floor.toFixed(3)}, 1.0, up) * mix(${SHADE.low.toFixed(3)}, 1.0, smoothstep(0.05, 0.55, position.y / uHeight));
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

/** Albedo pass: the atlas texel times the baked shade, linear (the sRGB target encodes it), coverage 1. */
const BAKE_ALBEDO = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vShade;
void main() {
  gl_FragColor = vec4(texture2D(uAtlas, vUv).rgb * vShade, 1.0);
}`;

/** Mask pass for the body: the atlas alpha (the paint mask) in R. */
const BAKE_PAINT = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vShade;
void main() {
  gl_FragColor = vec4(texture2D(uAtlas, vUv).a, 0.0, 0.0, 0.0);
}`;

/** Mask pass for the lamp boxes: each instance writes its own channel. */
const BAKE_LAMP_VERTEX = /* glsl */ `
attribute vec4 iOut;
varying vec4 vOut;
void main() {
  vOut = iOut;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const BAKE_LAMP = /* glsl */ `
varying vec4 vOut;
void main() {
  gl_FragColor = vOut;
}`;

const LAMP_CHANNEL: Record<TrafficLamp['role'], readonly [number, number, number, number]> = {
  head: [0, 1, 0, 0],
  tail: [0, 0, 1, 0],
  beacon: [0, 0, 0, 1],
  sign: [0, 0, 0, 1],
};

const sheets = new WeakMap<THREE.WebGLRenderer, Map<Quality, CarSheet | null>>();

/**
 * The sheet of a tier for this page's renderer, baked on first use and kept for the life of the page (the texture
 * belongs to the page, never to a scene). Null when the sheet cannot hold the cells or the GPU path fails; callers keep
 * the bodies. `atlas` is the traffic atlas (sRGB, flipY off).
 */
export function getCarSheet(renderer: THREE.WebGLRenderer, tier: Quality, kinds: readonly CarBakeKind[], atlas: THREE.Texture): CarSheet | null {
  let byTier = sheets.get(renderer);
  if (!byTier) sheets.set(renderer, (byTier = new Map()));
  if (byTier.has(tier)) return byTier.get(tier) ?? null;
  const sheet = bakeCarSheet(renderer, CAR_IMPOSTORS[tier], kinds, atlas);
  byTier.set(tier, sheet);
  return sheet;
}

/**
 * Bake a sheet (see the module note). Every cell is an instance: its matrix is the car turned to the cell's yaw,
 * seen from the cell's pitch, scaled to the kind's texel size and moved under the cell's middle, so each pass is
 * one render of one orthographic camera over the whole sheet (19 instanced draws), not a render per cell.
 */
function bakeCarSheet(renderer: THREE.WebGLRenderer, spec: CarImpostorSpec, kinds: readonly CarBakeKind[], atlas: THREE.Texture): CarSheet | null {
  const counts = cellCounts(spec, kinds.length);
  if (counts.need > counts.have) {
    console.warn(`car impostor sheet ${spec.sheet}px holds ${counts.have} cells, ${counts.need} needed: cars keep their bodies`);
    return null;
  }
  const { sheet, cellW, cellH, angles } = spec;
  const P = spec.pitches.length;
  const target = (size: number, srgb: boolean) =>
    new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true,
      // Mips are generated once, after the last pass.
      generateMipmaps: false,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    });
  const albedo = target(sheet, true);
  const mask = target(sheet / 2, false);
  const atlasU = { value: atlas };
  const carMat = (fragmentShader: string, height: number) => new THREE.ShaderMaterial({ vertexShader: BAKE_VERTEX, fragmentShader, uniforms: { uAtlas: atlasU, uHeight: { value: height } }, blending: THREE.NoBlending });
  const lampMat = new THREE.ShaderMaterial({ vertexShader: BAKE_LAMP_VERTEX, fragmentShader: BAKE_LAMP, blending: THREE.NoBlending });
  const albedoScene = new THREE.Scene();
  const maskScene = new THREE.Scene();
  const instanced: THREE.InstancedMesh[] = [];
  const owned: { dispose(): void }[] = [lampMat];
  const frames: THREE.Vector4[] = [];
  // The sheet is the camera's view: one world unit a texel, y up from the sheet's bottom edge, the cars standing in front of it.
  const camera = new THREE.OrthographicCamera(0, sheet, sheet, 0, 1, 2000);
  camera.position.z = 1000;
  camera.updateMatrixWorld();
  const cell = new THREE.Matrix4();
  const view = new THREE.Matrix4();
  const turn = new THREE.Matrix4();
  const lift = new THREE.Matrix4();
  const place = new THREE.Matrix4();
  const lampM = new THREE.Matrix4();
  const lampLocal = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const lampAt = new THREE.Vector3();
  const lampSize = new THREE.Vector3();
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  try {
    kinds.forEach((kind, ki) => {
      kind.geometry.computeBoundingBox();
      const box = kind.geometry.boundingBox!;
      const { scale, cy } = carFraming(box, spec);
      frames.push(new THREE.Vector4(cellW * scale, cellH * scale, cy, 0));
      const cells = P * angles;
      const albedoKind = carMat(BAKE_ALBEDO, box.max.y);
      const paintKind = carMat(BAKE_PAINT, box.max.y);
      const body = new THREE.InstancedMesh(kind.geometry, albedoKind, cells);
      const paint = new THREE.InstancedMesh(kind.geometry, paintKind, cells);
      const lampGeo = new THREE.BoxGeometry(1, 1, 1);
      const out = new THREE.InstancedBufferAttribute(new Float32Array(kind.lamps.length * cells * 4), 4);
      lampGeo.setAttribute('iOut', out);
      const lamps = new THREE.InstancedMesh(lampGeo, lampMat, Math.max(1, kind.lamps.length * cells));
      lamps.count = kind.lamps.length * cells;
      for (let pi = 0; pi < P; pi++) {
        const e = (spec.pitches[pi] * Math.PI) / 180;
        // The camera at elevation e looks down at the car's middle: screen x is world x, screen y the up vector (0, cos e, -sin e), depth toward the camera (0, sin e, cos e).
        view.set(1, 0, 0, 0, 0, Math.cos(e), -Math.sin(e), 0, 0, Math.sin(e), Math.cos(e), 0, 0, 0, 0, 1);
        lift.makeTranslation(0, -cy, 0);
        for (let k = 0; k < angles; k++) {
          const c = (ki * P + pi) * angles + k;
          const col = c % counts.cols;
          const row = Math.floor(c / counts.cols);
          // The car turned by theta is seen from the camera at yaw -theta in its own frame (the shader's yaw minus camera azimuth).
          turn.makeRotationY((k / angles) * Math.PI * 2);
          place.makeScale(1 / scale, 1 / scale, 1 / scale).setPosition((col + 0.5) * cellW, sheet - (row + 0.5) * cellH, 0);
          cell.copy(place).multiply(view).multiply(turn).multiply(lift);
          const slot = pi * angles + k;
          body.setMatrixAt(slot, cell);
          paint.setMatrixAt(slot, cell);
          kind.lamps.forEach((lamp, li) => {
            lampLocal.compose(lampAt.set(...lamp.p), quat, lampSize.set(...lamp.s));
            lampM.multiplyMatrices(cell, lampLocal);
            lamps.setMatrixAt(li * cells + slot, lampM);
            out.setXYZW(li * cells + slot, ...LAMP_CHANNEL[lamp.role]);
          });
        }
      }
      albedoScene.add(body);
      maskScene.add(paint, lamps);
      instanced.push(body, paint, lamps);
      owned.push(albedoKind, paintKind, lampGeo);
    });
    for (const m of instanced) {
      m.frustumCulled = false;
      m.instanceMatrix.needsUpdate = true;
    }
    renderer.autoClear = false;
    for (const [rt, scene, clear] of [
      [albedo, albedoScene, 0x070708],
      [mask, maskScene, 0x000000],
    ] as const) {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(clear, 0);
      renderer.clear();
      renderer.render(scene, camera);
    }
    // The mips, once: an empty render onto each target with the flag on.
    const empty = new THREE.Scene();
    for (const rt of [albedo, mask]) {
      rt.texture.generateMipmaps = true;
      renderer.setRenderTarget(rt);
      renderer.render(empty, camera);
    }
  } catch (e) {
    console.warn('car impostor bake failed: cars keep their bodies', e);
    albedo.dispose();
    mask.dispose();
    return null;
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    for (const m of instanced) m.dispose();
    for (const d of owned) d.dispose();
  }
  albedo.texture.anisotropy = 1;
  mask.texture.anisotropy = 1;
  const bytes = Math.round((sheet * sheet * 4 + (sheet / 2) * (sheet / 2) * 4) * (4 / 3));
  return { albedo: albedo.texture, mask: mask.texture, spec, kinds: kinds.length, cols: counts.cols, frames, bytes };
}

/**
 * Fade a standard or basic material out with distance, complementing the card: it discards a pixel where the fade
 * (0 inside the band .. 1 beyond) is above the screen-door noise. `origin` is the point the distance is measured to: a
 * BatchedMesh instance's origin, or an InstancedMesh instance's. Chains the material's own `onBeforeCompile` and key.
 */
export function fadeOutBeyond(material: THREE.Material, band: { value: THREE.Vector2 }, origin: 'batch' | 'instance'): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const matrix = origin === 'batch' ? 'modelMatrix * batchingMatrix' : 'modelMatrix * instanceMatrix';
  material.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uCarBand = band;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uCarBand;\nvarying float vCarFade;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCarFade = smoothstep(uCarBand.x - uCarBand.y, uCarBand.x + uCarBand.y, length(cameraPosition - (${matrix} * vec4(0.0, 0.0, 0.0, 1.0)).xyz));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vCarFade;\n${IMPOSTOR_DITHER_GLSL}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vCarFade > impNoise(gl_FragCoord.xy)) discard;');
  };
  material.customProgramCacheKey = function (this: THREE.Material) {
    return `${prevKey.call(this)}|carfade:${origin}`;
  };
  material.needsUpdate = true;
}

const CARD_VERTEX_PARS = /* glsl */ `
uniform vec4 uGrid;
uniform vec4 uLay;
uniform vec2 uPitch;
uniform vec2 uImp;
uniform vec2 uRange;
uniform vec4 uKind[KINDS];
attribute vec3 iPaint;
attribute vec3 iHead;
attribute vec3 iTail;
attribute vec3 iAux;
attribute vec2 iA;
varying vec2 vSprite;
varying float vImpFade;
varying vec3 vPaint;
varying vec3 vHead;
varying vec3 vTail;
varying vec3 vAux;
`;

/** Replaces defaultnormal_vertex: the car's place, the camera's direction, and the normal that faces it. */
const CARD_NORMAL = /* glsl */ `
vec3 impPos = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
vec3 impTo = cameraPosition - impPos;
float impDist = length(impTo);
float impHL = length(impTo.xz);
vec2 impH = impHL > 1e-3 ? impTo.xz / impHL : vec2(0.0, 1.0);
vec3 transformedNormal = normalize(mat3(viewMatrix) * normalize(impTo / max(impDist, 1e-4) + vec3(0.0, ${TILT.toFixed(3)}, 0.0)));
`;

/**
 * Replaces project_vertex: pick the cell (kind, pitch row from the camera's elevation, angle from the car's yaw against
 * the camera), stand the card perpendicular to the baked view and project it. uGrid = cols, sheet px, cell w, cell h;
 * uLay = pitches, angles, the elevation (rad) where the raised row takes over; uKind = card w, card h, centre height.
 */
const CARD_PROJECT = /* glsl */ `
mat4 impM = modelMatrix * instanceMatrix;
float impYaw = atan(impM[2].x, impM[2].z);
float impCam = atan(impH.x, impH.y);
float impAn = uLay.y;
float impK = mod(floor(mod(impYaw - impCam, 6.2831853) * impAn / 6.2831853 + 0.5), impAn);
vec4 impKd = uKind[int(iA.x + 0.5)];
float impElev = atan(impTo.y - impKd.z, impHL);
float impRowSel = step(uLay.z, impElev) * (uLay.x - 1.0);
float impPitch = impRowSel > 0.5 ? uPitch.y : uPitch.x;
float impCell = (iA.x * uLay.x + impRowSel) * impAn + impK;
float impCol = mod(impCell, uGrid.x);
float impRow = floor((impCell + 0.5) / uGrid.x);
vSprite = (vec2(impCol * uGrid.z, uGrid.y - (impRow + 1.0) * uGrid.w) + (position.xy + 0.5) * vec2(uGrid.z, uGrid.w)) / uGrid.y;
vImpFade = max(smoothstep(uImp.x - uImp.y, uImp.x + uImp.y, impDist), iA.y);
vPaint = iPaint;
vHead = iHead;
vTail = iTail;
vAux = iAux;
vec3 impRight = vec3(impH.y, 0.0, -impH.x);
vec3 impUp = vec3(0.0, cos(impPitch), 0.0) - vec3(impH.x, 0.0, impH.y) * sin(impPitch);
vec3 impWorld = impPos + vec3(0.0, impKd.z, 0.0) + impRight * (position.x * impKd.x) + impUp * (position.y * impKd.y);
vec4 mvPosition = viewMatrix * vec4(impWorld, 1.0);
gl_Position = projectionMatrix * mvPosition;
if (impDist < uRange.x || impDist > uRange.y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

/**
 * The cards' material: lit, fogged and height fogged like a body (the standard material, a normal facing the camera),
 * the albedo and masks read from the sheet, the paint tinted as the body material does (`paintRef` is the linear grey
 * the atlas stores paint at), the lamps glowing through the instance's own colours, a pixel drawn only where the
 * body is faded out. `band` is (switch distance, half the band width) in metres; `range` clips the cards to a
 * distance range in the vertex stage (a static set of every yard car costs nothing on the CPU).
 */
export function carImpostorMaterial(sheet: CarSheet, paintRef: number, band: { value: THREE.Vector2 }, range: { value: THREE.Vector2 }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.5, envMapIntensity: 1.1 });
  const { spec } = sheet;
  const uniforms = {
    uAlbedo: { value: sheet.albedo },
    uMask: { value: sheet.mask },
    uGrid: { value: new THREE.Vector4(sheet.cols, spec.sheet, spec.cellW, spec.cellH) },
    uLay: { value: new THREE.Vector4(spec.pitches.length, spec.angles, (((spec.pitches[0] + (spec.pitches[1] ?? 90)) / 2) * Math.PI) / 180, 0) },
    uPitch: { value: new THREE.Vector2((spec.pitches[0] * Math.PI) / 180, ((spec.pitches[1] ?? spec.pitches[0]) * Math.PI) / 180) },
    uKind: { value: sheet.frames as THREE.Vector4[] },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uImp: band, uRange: range });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CARD_VERTEX_PARS.replace('KINDS', String(sheet.kinds))}`)
      .replace('#include <defaultnormal_vertex>', CARD_NORMAL)
      .replace('#include <project_vertex>', CARD_PROJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uAlbedo;
uniform sampler2D uMask;
varying vec2 vSprite;
varying float vImpFade;
varying vec3 vPaint;
varying vec3 vHead;
varying vec3 vTail;
varying vec3 vAux;
${IMPOSTOR_DITHER_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec4 impA = texture2D(uAlbedo, vSprite);
if (impA.a < ${COVER.toFixed(2)} || vImpFade <= impNoise(gl_FragCoord.xy)) discard;
vec4 impMk = texture2D(uMask, vSprite);
diffuseColor.rgb = mix(impA.rgb, impA.rgb * vPaint / ${paintRef.toFixed(5)}, impMk.r);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += impMk.g * vHead + impMk.b * vTail + impMk.a * vAux;');
  };
  mat.customProgramCacheKey = () => `car-impostor-${sheet.kinds}-${spec.pitches.length}`;
  return mat;
}

/** Floats per instance in each attribute buffer. */
const COLOR_SIZE = 3;

/**
 * The cards of one view: an InstancedMesh of quads whose instance attributes the owner fills (traffic every frame
 * through begin / add / end, the yard cars once and clipped by `range`). One instance is a car: its place and yaw (the
 * instance matrix), kind and whether it is forced opaque, its paint tint and the colours its head, tail and roof lamps
 * glow in (black for off).
 */
export class CarImpostors {
  readonly mesh: THREE.InstancedMesh;
  /** The switch band (distance, half width: m) and the distance range (m) the cards are drawn in. */
  readonly band = { value: new THREE.Vector2(1e6, 0) };
  readonly range = { value: new THREE.Vector2(0, 1e9) };
  private readonly matrix: Float32Array;
  private readonly paint: THREE.InstancedBufferAttribute;
  private readonly head: THREE.InstancedBufferAttribute;
  private readonly tail: THREE.InstancedBufferAttribute;
  private readonly aux: THREE.InstancedBufferAttribute;
  private readonly info: THREE.InstancedBufferAttribute;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private n = 0;

  constructor(sheet: CarSheet, paintRef: number, capacity: number) {
    this.band.value.set(sheet.spec.distance, sheet.spec.fade / 2);
    this.geometry = new THREE.PlaneGeometry(1, 1);
    const attr = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
    this.paint = attr(COLOR_SIZE);
    this.head = attr(COLOR_SIZE);
    this.tail = attr(COLOR_SIZE);
    this.aux = attr(COLOR_SIZE);
    this.info = attr(2);
    this.geometry.setAttribute('iPaint', this.paint);
    this.geometry.setAttribute('iHead', this.head);
    this.geometry.setAttribute('iTail', this.tail);
    this.geometry.setAttribute('iAux', this.aux);
    this.geometry.setAttribute('iA', this.info);
    this.material = carImpostorMaterial(sheet, paintRef, this.band, this.range);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = 'carImpostors';
    this.matrix = this.mesh.instanceMatrix.array as Float32Array;
  }

  /** Cards held; the capacity is the mesh's. */
  get count(): number {
    return this.n;
  }

  get capacity(): number {
    return this.matrix.length / 16;
  }

  /** Start a refill. */
  begin(): void {
    this.n = 0;
  }

  /**
   * Append a car at ground point (x, y, z) facing `yaw`. `force` draws it opaque whatever its distance (a car with no
   * body to trade places with). `head`, `tail` and `aux` are the lamps' glow (linear HDR; null for off). False when full.
   */
  add(x: number, y: number, z: number, yaw: number, kind: number, force: boolean, paint: THREE.Color, head: THREE.Color | null, tail: THREE.Color | null, aux: THREE.Color | null): boolean {
    const i = this.n;
    if (i >= this.capacity) return false;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const m = this.matrix;
    const o = i * 16;
    m[o] = c;
    m[o + 1] = 0;
    m[o + 2] = -s;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = 1;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = s;
    m[o + 9] = 0;
    m[o + 10] = c;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const p = this.paint.array as Float32Array;
    p[i * 3] = paint.r;
    p[i * 3 + 1] = paint.g;
    p[i * 3 + 2] = paint.b;
    writeColor(this.head.array as Float32Array, i, head);
    writeColor(this.tail.array as Float32Array, i, tail);
    writeColor(this.aux.array as Float32Array, i, aux);
    const a = this.info.array as Float32Array;
    a[i * 2] = kind;
    a[i * 2 + 1] = force ? 1 : 0;
    this.n = i + 1;
    return true;
  }

  /** Finish a refill: draw what was added and upload only those instances. */
  end(): void {
    const n = this.n;
    this.mesh.count = n;
    this.flush(this.mesh.instanceMatrix, n * 16);
    this.flush(this.paint, n * 3);
    this.flush(this.head, n * 3);
    this.flush(this.tail, n * 3);
    this.flush(this.aux, n * 3);
    this.flush(this.info, n * 2);
  }

  private flush(attr: THREE.BufferAttribute, floats: number): void {
    attr.clearUpdateRanges();
    if (floats > 0) attr.addUpdateRange(0, floats);
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

function writeColor(arr: Float32Array, i: number, c: THREE.Color | null): void {
  arr[i * 3] = c ? c.r : 0;
  arr[i * 3 + 1] = c ? c.g : 0;
  arr[i * 3 + 2] = c ? c.b : 0;
}
