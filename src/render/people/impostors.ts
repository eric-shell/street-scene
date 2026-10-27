/**
 * Impostors for people far from the camera: past about 60 m a spectator is
 * a camera-facing quad cut from a sprite sheet, so a stand of 300 costs 600
 * triangles instead of 60k. The sheet is baked once per page from the live
 * shader rig (the same program, the same wardrobe, the same pose code as the
 * stands), not painted or exported, so the sprite is the person the rig
 * would have drawn: the far level of detail, orthographic, seen from the
 * front, the sides and the back, in a few looks, poses and animation frames.
 *
 * The sheet holds albedo, not light. The rig's per vertex albedo (color times
 * its baked occlusion) goes into the RGB of an sRGB texture, so dark cloth
 * keeps its precision; light is the scene's own at draw time. The impostor
 * material is a MeshStandardMaterial whose normal faces the camera, tilted a
 * little toward the sky, so it takes the hemisphere, moon, lamp pools,
 * environment and fog exactly as a person does (the average of a body's
 * normals is about that), and the rig's faint rim is added as a constant.
 * The alpha channel is coverage (0 off the body) and, above 0.5, the glow
 * mask: a lit phone screen or glowstick is stored as its hue with alpha 1 and
 * drawn as emission, so it stays lit at night and fades with distance like
 * the rig's emitters do.
 *
 * Layout: cells in rows, cell = ((look * poses + pose) * frames + frame) *
 * angles + angle. A look is a wardrobe pick (skin tone x outfit, chosen by
 * farthest point so a few cover the palette) with what the right hand holds
 * (nothing, a phone, a flag, a glowstick); a pose is an excitement (idle,
 * clap, arms up, jumping) with the period of its motion, a frame one step of
 * that cycle; the angle is the person's yaw relative to the camera. An
 * instance picks its cell in the vertex shader from its excitement, the time
 * and the camera direction, and its look from the nearest baked one (matched once on the CPU). Cells are
 * cached per renderer and tier for the life of the page (the sheet is shared
 * by every scene the page builds).
 *
 * The switch from the rig is a per instance dither: the far level fades out
 * and the impostor in over the same distance band with complementary
 * screen-door patterns (IMPOSTOR_DITHER_GLSL is the one noise both read), so
 * every pixel is drawn by exactly one of them and nothing pops or blends.
 * Without a renderer (Vitest, the headless perf script) or when the bake
 * fails there is no sheet and the crowds keep the rig's far level. Render only.
 */
import * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { WEAR, personGeometry, personMaterial } from './person';
import type { PersonLook, PersonShader } from './person';
import { streetLook } from './looks';

/** What a sheet is cut into, and how it is cut. */
export interface ImpostorSpec {
  /** The sheet's edge (px, a square power of two). */
  sheet: number;
  /** One cell (px): about 1.8 m by 3.2 m of the world. */
  cellW: number;
  cellH: number;
  /** Looks by what the right hand holds: nothing, a phone, a flag, a glowstick. */
  plain: number;
  phones: number;
  flags: number;
  sticks: number;
  /** Animation frames per pose and view angles around the person (evenly spaced from the front). */
  frames: number;
  angles: number;
}

/** A pose's baked excitement (the rig's 0 idle .. 1.6 frenzy) and the period of its motion (s). */
export interface ImpostorPose {
  excite: number;
  period: number;
}

/** One baked look: the wardrobe pick, what it holds (a WEAR bit, 0 for nothing) and the phase its cycle is baked at. */
export interface ImpostorLook {
  look: PersonLook;
  item: number;
  /** 0..1 phase of the rig's cycle, which also picks a glowstick's or flag's neon hue. */
  phase: number;
}

/** A baked sheet and everything the impostor material needs to read it. */
export interface ImpostorSheet {
  texture: THREE.Texture;
  spec: ImpostorSpec;
  poses: readonly ImpostorPose[];
  looks: readonly ImpostorLook[];
  /** Cells across the sheet. */
  cols: number;
  /** GPU memory of the texture with its mips (bytes). */
  bytes: number;
}

/** The sprite's world frame (m): a cell's height (feet to above a raised flag), the gap under the feet, the normal's tilt toward the sky. */
export const IMPOSTOR_BODY = { height: 3.3, pad: 0.08, tilt: 0.35 } as const;

/** Excitement above which each pose from the second on takes over (between the baked values 0, .45, 1 and 1.4). */
const POSE_EDGES = [0.2, 0.75, 1.2] as const;
/** The hues of the glow items fade with distance like the rig's emitters (CROWD_POST): full at this distance (m), a floor beyond. */
const GLOW_NEAR = 28;
/** Constant standing in for the rig's rim light (pow(1 - n.v, 4) * 0.09 averages about 0.018 over a body). */
const RIM = [0.009, 0.0112, 0.0144] as const;

/**
 * Screen-door noise in 0..1 per pixel (interleaved gradient noise). The far rig discards a pixel where the fade
 * (0 near .. 1 past the band) is above it, the impostor where the fade is at or below it: complementary.
 */
export const IMPOSTOR_DITHER_GLSL = /* glsl */ `
float impNoise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

/** The hex color's channels, 0..1 in sRGB. */
const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
const ITEMS = WEAR.phone | WEAR.flag | WEAR.glowstick;
const HEADS = WEAR.cap | WEAR.beanie | WEAR.hair | WEAR.hood;

/** How far apart two looks read at a distance: skin, shirt and trousers by color, and what is on the head by silhouette. */
function lookDistance(a: PersonLook, b: PersonLook): number {
  let d = 0;
  for (const [key, w] of [['skin', 1], ['shirt', 1.6], ['pants', 0.7], ['sleeves', 0.4]] as const) {
    const x = rgb(a[key]);
    const y = rgb(b[key]);
    d += w * ((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
  }
  return Math.sqrt(d) + ((a.wear & HEADS) === (b.wear & HEADS) ? 0 : 0.35);
}

/**
 * The sheet's looks: a seeded pool of street looks thinned by farthest point (each pick the one furthest from
 * every pick so far), so a dozen cover the wardrobe's skin tones and outfit colors, then dealt out as plain
 * ones first and the phone, flag and glowstick holders after. The same spec always gives the same looks.
 */
export function pickImpostorLooks(spec: ImpostorSpec): ImpostorLook[] {
  const rng = new Rng(0x1a90be);
  const total = spec.plain + spec.phones + spec.flags + spec.sticks;
  const pool = Array.from({ length: 480 }, () => streetLook(() => rng.next()));
  const picked: PersonLook[] = [pool[0]];
  const gap = pool.map((p) => lookDistance(p, pool[0]));
  while (picked.length < total) {
    let best = 0;
    for (let i = 1; i < pool.length; i++) if (gap[i] > gap[best]) best = i;
    picked.push(pool[best]);
    for (let i = 0; i < pool.length; i++) gap[i] = Math.min(gap[i], lookDistance(pool[i], pool[best]));
  }
  const items = [
    ...Array<number>(spec.plain).fill(0),
    ...Array<number>(spec.phones).fill(WEAR.phone),
    ...Array<number>(spec.flags).fill(WEAR.flag),
    ...Array<number>(spec.sticks).fill(WEAR.glowstick),
  ];
  return picked.map((look, i) => ({ look: { ...look, wear: (look.wear & ~ITEMS) | items[i] }, item: items[i], phase: (i * 0.618034) % 1 }));
}

/** The baked look nearest a person's (the same item in hand, then the closest colors and head). */
export function nearestImpostorLook(looks: readonly ImpostorLook[], look: PersonLook): number {
  const item = look.wear & ITEMS;
  let best = -1;
  let bestD = Infinity;
  looks.forEach((l, i) => {
    if (l.item !== item) return;
    const d = lookDistance(l.look, look);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  // A sheet without that item (a tier that bakes no flag): the closest look whatever it holds.
  if (best < 0) looks.forEach((l, i) => {
    const d = lookDistance(l.look, look) + 1;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Cells a spec needs and cells its sheet holds. */
function cellCounts(spec: ImpostorSpec, poses: number): { need: number; cols: number; have: number } {
  const looks = spec.plain + spec.phones + spec.flags + spec.sticks;
  const cols = Math.floor(spec.sheet / spec.cellW);
  return { need: looks * poses * spec.frames * spec.angles, cols, have: cols * Math.floor(spec.sheet / spec.cellH) };
}

/**
 * The unlit albedo and glow mask the bake writes in place of the lit color: the diffuse color (per vertex color times
 * occlusion), or for an emitting part (a phone's screen, a glowstick: more than half a unit of glow) its hue; alpha 0.5
 * plus half the glow's share of 3 (a bright camera flash), so 0.5 is a plain covered pixel and 0 is off the body.
 */
const BAKE_OUT = /* glsl */ `
{
  float bakeGlow = max(max(vPersonGlow.r, vPersonGlow.g), vPersonGlow.b);
  vec3 bakeCol = diffuseColor.rgb;
  float bakeMask = 0.0;
  if (bakeGlow > 0.5) {
    bakeCol = max(bakeCol, vPersonGlow / bakeGlow * 0.9);
    bakeMask = clamp(bakeGlow / 3.0, 0.2, 1.0);
  }
  gl_FragColor = vec4(bakeCol, 0.5 + 0.5 * bakeMask);
}
`;

const sheets = new WeakMap<THREE.WebGLRenderer, Map<string, ImpostorSheet>>();

/**
 * Bake (or fetch) the sheet for a spec: the far level of detail drawn by `rig` (a PersonShader whose pose reads its
 * time from iData.z, its phase from iData.x and its excitement from iExcite) into a render target, once, in one draw
 * call of every cell as an instance seen by an orthographic camera. Null when the sheet cannot hold the cells or the
 * GPU path fails; callers keep the rig. The texture belongs to the page: it is never disposed with a scene.
 */
export function bakeImpostors(renderer: THREE.WebGLRenderer, spec: ImpostorSpec, poses: readonly ImpostorPose[], rig: PersonShader): ImpostorSheet | null {
  const key = JSON.stringify([spec, poses]);
  let byKey = sheets.get(renderer);
  if (!byKey) sheets.set(renderer, (byKey = new Map()));
  const cached = byKey.get(key);
  if (cached) return cached;
  const counts = cellCounts(spec, poses.length);
  if (counts.need > counts.have) {
    console.warn(`impostor sheet ${spec.sheet}px holds ${counts.have} cells, ${counts.need} needed: crowds keep the rig`);
    return null;
  }
  const looks = pickImpostorLooks(spec);
  const { frames, angles, sheet, cellW, cellH } = spec;
  const target = new THREE.WebGLRenderTarget(sheet, sheet, {
    depthBuffer: true,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
  });
  const base = personGeometry('far');
  const geo = new THREE.BufferGeometry();
  for (const name of Object.keys(base.attributes)) geo.setAttribute(name, base.attributes[name]);
  geo.setIndex(base.index);
  const n = counts.need;
  const lookA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const lookB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const data = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const excite = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  geo.setAttribute('lookA', lookA);
  geo.setAttribute('lookB', lookB);
  geo.setAttribute('iData', data);
  geo.setAttribute('iExcite', excite);
  const mat = personMaterial({ pars: rig.pars, pose: rig.pose, key: `${rig.key ?? 'pose'}-bake` });
  const compile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    // The crowd pose's own uniforms exist but are unused in the bake (time comes per instance).
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uCars = { value: Array.from({ length: 4 }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) };
    compile.call(mat, shader, r);
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', BAKE_OUT);
  };
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.frustumCulled = false;
  // World metres per sheet pixel; cell (col, row) is the world rectangle under it, the person standing at its foot.
  const mpp = IMPOSTOR_BODY.height / cellH;
  const dummy = new THREE.Object3D();
  const P = poses.length;
  for (let c = 0; c < n; c++) {
    const angle = c % angles;
    const frame = Math.floor(c / angles) % frames;
    const pose = Math.floor(c / (angles * frames)) % P;
    const li = Math.floor(c / (angles * frames * P));
    const { look, phase } = looks[li];
    const col = c % counts.cols;
    const row = Math.floor(c / counts.cols);
    dummy.position.set((col + 0.5) * cellW * mpp, -(row + 1) * cellH * mpp + IMPOSTOR_BODY.pad, 0);
    // Seen from +z at yaw 0: the person turned by theta faces the camera at angle -theta in its own frame.
    dummy.rotation.set(0, (angle / angles) * Math.PI * 2, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(c, dummy.matrix);
    lookA.setXYZW(c, look.skin, look.shirt, look.pants, look.shoes);
    lookB.setXYZW(c, look.hair, look.cap, look.sleeves, look.wear);
    // The rig's oscillators run at angle = 2 pi (t / period + phase): bake frame f at the time that puts them at f / frames.
    data.setXYZW(c, phase, 0.5, (frame / frames - phase) * poses[pose].period, 0);
    excite.setX(c, poses[pose].excite);
  }
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(0, sheet * mpp, 0, -sheet * mpp, 0.1, 50);
  camera.position.z = 10;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(scene, camera);
  } catch (e) {
    console.warn('impostor bake failed: crowds keep the rig', e);
    target.dispose();
    return null;
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    mesh.dispose();
    geo.dispose();
    base.dispose();
    mat.dispose();
  }
  const texture = target.texture;
  texture.anisotropy = 1;
  const result: ImpostorSheet = { texture, spec, poses, looks, cols: counts.cols, bytes: Math.round(sheet * sheet * 4 * (4 / 3)) };
  byKey.set(key, result);
  return result;
}

/** A unit quad standing on its base: x -0.5..0.5, y 0..1 (the impostor's one geometry; each batch shares its buffers). */
export function impostorQuad(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
}

/** The uniforms every impostor and the far rig it fades with share: the clock and the band (distance and half width, m). */
export interface ImpostorShared {
  uTime: { value: number };
  uImp: { value: THREE.Vector2 };
}

const IMPOSTOR_VERTEX_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uImp;
uniform vec4 uGridA;
uniform vec4 uGridB;
uniform vec3 uQuad;
uniform vec3 uEdges;
uniform vec4 uPeriod;
attribute vec4 iData;
attribute float iExcite;
attribute float iLook;
varying vec2 vSprite;
varying float vImpFade;
varying float vImpGlow;
`;

/** Replaces defaultnormal_vertex: the instance's place and the camera's direction, and the normal that faces it. */
const IMPOSTOR_NORMAL = /* glsl */ `
vec3 impPos = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
vec3 impTo = cameraPosition - impPos;
float impDist = length(impTo);
vec2 impH = impTo.xz / max(length(impTo.xz), 1e-4);
vec3 transformedNormal = normalize(mat3(viewMatrix) * normalize(vec3(impH.x, ${IMPOSTOR_BODY.tilt.toFixed(3)}, impH.y)));
`;

/**
 * Replaces project_vertex: pick the cell (look, pose from the excitement, frame from the time and the person's phase,
 * angle from its yaw against the camera), stand the quad up facing the camera round the vertical, and project it.
 * uGridA = cols, sheet px, cell width, cell height; uGridB = poses, frames, angles, quad width (m).
 */
const IMPOSTOR_PROJECT = /* glsl */ `
mat4 impM = modelMatrix * instanceMatrix;
float impYaw = atan(impM[2].x, impM[2].z);
float impCam = atan(impTo.x, impTo.z);
float impAngles = uGridB.z;
float impK = mod(floor(mod(impYaw - impCam, 6.2831853) * impAngles / 6.2831853 + 0.5), impAngles);
float impE = clamp(iExcite, 0.0, 1.6);
float impPose = step(uEdges.x, impE) + step(uEdges.y, impE) + step(uEdges.z, impE);
float impPeriod = impPose < 0.5 ? uPeriod.x : impPose < 1.5 ? uPeriod.y : impPose < 2.5 ? uPeriod.z : uPeriod.w;
float impFrame = min(floor(fract(uTime / impPeriod + iData.x) * uGridB.y), uGridB.y - 1.0);
float impCell = ((iLook * uGridB.x + impPose) * uGridB.y + impFrame) * impAngles + impK;
float impCol = mod(impCell, uGridA.x);
float impRow = floor((impCell + 0.5) / uGridA.x);
vec2 impCellPx = vec2(uGridA.z, uGridA.w);
vSprite = (vec2(impCol * uGridA.z, uGridA.y - (impRow + 1.0) * uGridA.w) + vec2(position.x + 0.5, position.y) * impCellPx) / uGridA.y;
vImpFade = smoothstep(uImp.x - uImp.y, uImp.x + uImp.y, impDist);
vImpGlow = clamp(${GLOW_NEAR.toFixed(1)} / max(impDist, 1.0), 0.15, 1.0);
float impW = uGridB.w * length(impM[0].xyz);
float impH2 = ${IMPOSTOR_BODY.height.toFixed(3)} * length(impM[1].xyz);
vec3 impWorld = impPos + vec3(impH.y, 0.0, -impH.x) * (position.x * impW) + vec3(0.0, position.y * impH2 - ${IMPOSTOR_BODY.pad.toFixed(3)} * length(impM[1].xyz), 0.0);
vec4 mvPosition = viewMatrix * vec4(impWorld, 1.0);
gl_Position = projectionMatrix * mvPosition;
`;

/**
 * The impostor's material: lit, fogged and height fogged like a person (the standard material with a normal facing
 * the camera), the albedo and glow read from the sheet, a pixel drawn only where the rig's far level is faded out.
 * `shared` carries the clock and the fade band, written by the crowds' update.
 */
export function impostorMaterial(sheet: ImpostorSheet, shared: ImpostorShared): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.04 });
  const { spec, poses } = sheet;
  const px = spec.sheet;
  const quadW = (IMPOSTOR_BODY.height * spec.cellW) / spec.cellH;
  const uniforms = {
    uSheet: { value: sheet.texture },
    uGridA: { value: new THREE.Vector4(sheet.cols, px, spec.cellW, spec.cellH) },
    uGridB: { value: new THREE.Vector4(poses.length, spec.frames, spec.angles, quadW) },
    uEdges: { value: new THREE.Vector3(...POSE_EDGES) },
    uPeriod: { value: new THREE.Vector4(...poses.map((p) => p.period)) },
    uQuad: { value: new THREE.Vector3(quadW, IMPOSTOR_BODY.height, IMPOSTOR_BODY.pad) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uTime: shared.uTime, uImp: shared.uImp });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMPOSTOR_VERTEX_PARS}`)
      .replace('#include <defaultnormal_vertex>', IMPOSTOR_NORMAL)
      .replace('#include <project_vertex>', IMPOSTOR_PROJECT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uSheet;\nvarying vec2 vSprite;\nvarying float vImpFade;\nvarying float vImpGlow;\n${IMPOSTOR_DITHER_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `vec4 impTex = texture2D(uSheet, vSprite);
        if (impTex.a < 0.25 || vImpFade <= impNoise(gl_FragCoord.xy)) discard;
        float impGlow = clamp((impTex.a - 0.5) * 2.0, 0.0, 1.0);
        diffuseColor.rgb *= impTex.rgb * (1.0 - impGlow);`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += impTex.rgb * (impGlow * 1.8 * vImpGlow) + vec3(${RIM.join(', ')});`);
  };
  mat.customProgramCacheKey = () => 'person-impostor';
  return mat;
}
