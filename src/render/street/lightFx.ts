/**
 * Cheap fake lighting for the wet street look: additive light pools on the
 * ground under every streetlight, and camera facing reflection streaks that
 * stretch from each light toward the viewer like on wet asphalt.
 *
 * Every glowing thing on the street streaks, graded by a class (STREAK_CLASSES):
 * the streetlights and the podium neon signs lead, and the small emitters (blade
 * signs, signal heads, bus shelter strips, park lanterns, market lantern strings,
 * the route's beacons and chevron boards) get shorter, narrower, fainter streaks
 * so the look stays graded and the lamps dominate. The emitters are gathered by
 * street/streakEmitters.ts; this module only draws them. Traffic signal heads
 * follow their lens in the shader (the same cycle and per-intersection offset
 * props.ts gives the lens), so a red light streaks red and then goes green with
 * it: one extra attribute and a time uniform instead of a fixed amber guess.
 *
 * Culling by cell (the 200 m grid of cityChunks.ts), like the props: emitters
 * are stable-sorted by grid cell so a cell is one run, and view() picks the
 * cells within the fog cutoff of the camera's 100 m lattice square (VIEW_LATTICE:
 * radial, snapped, with hysteresis) and only when that set changes copies the
 * drawn runs to the front of the instance buffers and sets the instance count.
 * Pools and streaks are 'fog' class (lamps read from afar). Each emitter keeps
 * its own "on" state outside the GPU buffers, applied during compaction and
 * written straight into its slot when it flips while drawn, so a broken lamp
 * (setLampOn) or a smashed bus shelter (setEmitterOn) stays dark whichever cells
 * are drawn. Render only; the view pass allocates nothing.
 */
import * as THREE from 'three';
import { VIEW_LATTICE, type ChunkGrid } from '../cityChunks';
import { makeRadialGlow } from '../textures/textures';

/** Width of the light pool under a streetlight (m). */
const POOL_SIZE = 19;

/**
 * The traffic signal's cycle, shared by the lens (props.ts) and its streak (this file's shader): green for the
 * first `green` seconds of the cycle, amber until `amber`, red for the rest, each lens shifted by its own offset.
 */
export const SIGNAL = { cycle: 24, green: 9, amber: 11 } as const;

/**
 * What kind of emitter a streak belongs to. Width (m) is the quad's full width before the gaussian across it, so
 * the lit core is about a third of it. `heightScale` multiplies the emitter's height over the surface (m) before the
 * shader stretches the streak (2.4 times that, capped at three quarters of the distance to the camera): small
 * emitters reflect short. `minHeight` (m) floors that scaled height so the smallest still gets a visible streak.
 * `strength` multiplies the emitter's colour (linear, additive); the weather's wetness scales all of them
 * together (setStrength). The lamps and the podium signs are the original look and stay as they were.
 */
export const STREAK_CLASSES = {
  /** Streetlights: the dominant streaks, about 20 m long. */
  lamp: { width: 1.6, heightScale: 1, minHeight: 2, strength: 0.9 },
  /** Podium neon signs and the blades the city meshes build with them. */
  sign: { width: 2.6, heightScale: 1, minHeight: 2, strength: 1.3 },
  /** Park lanterns (about 4 m up): about 8 m long, warm and soft. */
  lantern: { width: 1.1, heightScale: 0.85, minHeight: 1.5, strength: 0.6 },
  /** A market lantern string (about 5 m up, over a lane): wide and faint, about 9 m long. */
  string: { width: 2, heightScale: 0.7, minHeight: 1.5, strength: 0.45 },
  /** Neon blade signs hanging over the sidewalks (about 3.6 m up): about 5 m long. */
  blade: { width: 0.9, heightScale: 0.6, minHeight: 1.2, strength: 0.5 },
  /** Traffic signal heads (3 to 5 m up): thin, about 6 m long, red, amber or green with the lens. */
  signal: { width: 0.45, heightScale: 0.5, minHeight: 1, strength: 0.65 },
  /** Bus shelter light strips and lit posters (1 to 2.5 m up): short and faint, about 3 m. */
  shelter: { width: 1, heightScale: 0.5, minHeight: 0.9, strength: 0.35 },
  /** Amber beacons on the route's rail posts (1.5 m up): the smallest, under 2 m. */
  beacon: { width: 0.3, heightScale: 0.5, minHeight: 0.6, strength: 0.3 },
  /** The cyan chevron boards over closures and corners (about 6 m up): about 6 m long. */
  board: { width: 3, heightScale: 0.45, minHeight: 2, strength: 0.55 },
} as const;

export type EmitterClass = keyof typeof STREAK_CLASSES;

/** A glowing thing that streaks on the wet street (besides the lamps and podium signs buildLightFx takes as such). */
export interface LightEmitter {
  /** The light's world position (m); the streak lies on the ground under it. */
  pos: THREE.Vector3;
  /** Its colour (linear); a signal head ignores it for the lens' colours. */
  color: THREE.Color;
  cls: EmitterClass;
  /** Quad width (m) when the class' is wrong for this emitter (the wide boards). */
  width?: number;
  /** A signal head's offset into the SIGNAL cycle (s), the lens' aOffset; the streak then follows the lens. Omit for a steady light. */
  phase?: number;
}

/** What colour a lamp's ground pool and wet streak are (parallel to the lamp positions; missing = sodium amber). */
export interface LampLook {
  pool: THREE.Color;
  streak: THREE.Color;
}

export interface LightFxOptions {
  /** The culling grid (scene.ts shares the city chunks' one). */
  grid: ChunkGrid;
  /** More emitters after the lamps and signs (streakEmitters.ts); `LightFx.extraBase` is the first one's index. */
  extra?: readonly LightEmitter[];
}

export interface LightFx {
  group: THREE.Group;
  /** Index of `extra[0]` among the emitters (lamps, then signs, then the extras). */
  readonly extraBase: number;
  setStrength(pool: number, streak: number): void;
  /** Switch one streetlight's ground pool and reflection streak (broken lamps go dark). */
  setLampOn(index: number, on: boolean): void;
  /** Switch any emitter's streak (an extra's index is extraBase + its place in `extra`). */
  setEmitterOn(index: number, on: boolean): void;
  /** Signal heads read the scene clock (s); call every frame. */
  update(time: number): void;
  /**
   * Draw only the cells within `fogDistance` (m, view depth where the fog has closed; Infinity draws all) of the
   * camera, from the camera's lattice square with hysteresis. Call once per render, after the camera's matrices are
   * current. Allocates nothing and uploads only when the set of cells changes.
   */
  view(camera: THREE.Camera, fogDistance: number): void;
  /** Dev stats: compactions run, bytes uploaded by the last one, and the pools and streaks drawn now. */
  readonly cullStats: { compactions: number; lastBytes: number; pools: number; streaks: number };
  dispose(): void;
}

/** The reflection streak's shaders (instanced: iPos at the reflecting surface, iColor, iSize = width and the light's height over it), shared with the harbor's water (render/districts/waterfront.ts). With SIGNAL defined, iPhase >= 0 follows a traffic lens. */
export const streakVert = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iColor;
  attribute vec2 iSize;
  #ifdef SIGNAL
  attribute float iPhase;
  uniform float time;
  #endif
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFog;
  uniform float fogDensity;
  void main() {
    vec2 toCam = cameraPosition.xz - iPos.xz;
    float dist = max(length(toCam), 0.001);
    vec2 d = toCam / dist;
    vec2 p = vec2(-d.y, d.x);
    float len = min(iSize.y * 2.4, dist * 0.75);
    vec2 xz = iPos.xz + p * position.x * iSize.x + d * position.y * len;
    vec3 wp = vec3(xz.x, iPos.y, xz.y);
    vUv = position.xy;
    vColor = iColor;
    #ifdef SIGNAL
    if (iPhase >= 0.0) {
      // The lens' own state (props.ts lensVert), tinted by the lens' colours; iColor.r is the brightness.
      float t = mod(time + iPhase, ${SIGNAL.cycle.toFixed(1)});
      vec3 lens = t < ${SIGNAL.green.toFixed(1)} ? vec3(0.08, 1.0, 0.45) : (t < ${SIGNAL.amber.toFixed(1)} ? vec3(1.0, 0.5, 0.04) : vec3(1.0, 0.05, 0.03));
      vColor = lens * iColor.r;
    }
    #endif
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd);
    // fade streaks seen from above: reflections need a grazing angle
    float graze = clamp(1.0 - (cameraPosition.y - iPos.y) / max(dist, 1.0) * 0.6, 0.0, 1.0);
    vColor *= graze;
    gl_Position = projectionMatrix * mv;
  }
`;

export const streakFrag = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFog;
  uniform float strength;
  void main() {
    // x * x, not pow(x, 2.0): pow of a negative base is undefined in GLSL and
    // returns NaN on some GPUs, which the bloom then smears into flicker.
    float ax = vUv.x * 3.2;
    float across = exp(-ax * ax);
    float along = (1.0 - smoothstep(0.0, 1.0, vUv.y)) * smoothstep(-0.2, 0.05, vUv.y);
    float a = across * along * strength * vFog;
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

const SODIUM_POOL = new THREE.Color(0xffb46a);
const SODIUM_STREAK = new THREE.Color(0xffb060);

/** Emitters sorted by cell (counting sort, stable): `order[j]` is the emitter at sorted place j, a cell's run is start[c]..start[c + 1]. */
function sortByCell(cellOf: ArrayLike<number>, nCells: number): { order: Uint32Array; start: Uint32Array } {
  const start = new Uint32Array(nCells + 1);
  for (let i = 0; i < cellOf.length; i++) start[cellOf[i] + 1]++;
  for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
  const at = start.slice(0, nCells);
  const order = new Uint32Array(cellOf.length);
  for (let i = 0; i < cellOf.length; i++) order[at[cellOf[i]]++] = i;
  return { order, start };
}

export function buildLightFx(
  lamps: THREE.Vector3[],
  signs: { pos: THREE.Vector3; color: THREE.Color }[],
  heightAt: (x: number, z: number) => number,
  fogDensity: number,
  looks: readonly LampLook[],
  opts: LightFxOptions,
): LightFx {
  const group = new THREE.Group();
  group.name = 'lightFx';
  const glow = makeRadialGlow();
  const grid = opts.grid;
  const nCells = grid.count;
  const extra = opts.extra ?? [];

  // ---------- Emitters: lamps, then the podium signs, then the extras ----------
  const nLamps = lamps.length;
  const extraBase = nLamps + signs.length;
  const n = extraBase + extra.length;
  const ePos = new Float32Array(n * 3);
  /** Streak colour with the class' strength folded in (linear). */
  const eColor = new Float32Array(n * 3);
  const eSize = new Float32Array(n * 2);
  /** Signal phase (s), -1 for a steady light. */
  const ePhase = new Float32Array(n).fill(-1);
  const eCell = new Uint16Array(n);
  /** Whether each emitter's streak (and a lamp's pool) is lit. */
  const on = new Uint8Array(n).fill(1);
  let minY = Infinity;
  let maxY = -Infinity;
  const addEmitter = (i: number, pos: THREE.Vector3, color: THREE.Color, cls: EmitterClass, width?: number, phase?: number) => {
    const c = STREAK_CLASSES[cls];
    const gy = heightAt(pos.x, pos.z);
    ePos[i * 3] = pos.x;
    ePos[i * 3 + 1] = gy + 0.09;
    ePos[i * 3 + 2] = pos.z;
    const k = c.strength;
    // A signal head's colour comes from the lens in the shader: only its brightness is stored.
    if (phase !== undefined) eColor.set([k, k, k], i * 3);
    else eColor.set([color.r * k, color.g * k, color.b * k], i * 3);
    eSize[i * 2] = width ?? c.width;
    eSize[i * 2 + 1] = Math.max(c.minHeight, (pos.y - gy) * c.heightScale);
    if (phase !== undefined) ePhase[i] = phase;
    eCell[i] = grid.cellOf(pos.x, pos.z);
    minY = Math.min(minY, gy);
    maxY = Math.max(maxY, gy);
  };
  lamps.forEach((p, i) => addEmitter(i, p, looks[i]?.streak ?? SODIUM_STREAK, 'lamp'));
  signs.forEach((s, i) => addEmitter(nLamps + i, s.pos, s.color, 'sign'));
  extra.forEach((e, i) => addEmitter(extraBase + i, e.pos, e.color, e.cls, e.width, e.phase));

  // ---------- Ground pools (one per streetlight) ----------
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshBasicMaterial({
    map: glow,
    // White: each pool's colour is its instance colour (the lamp's tone), one material for all.
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, nLamps);
  pools.setColorAt(0, SODIUM_POOL);
  const poolColor = new Float32Array(nLamps * 3);
  lamps.forEach((_, i) => poolColor.set((looks[i]?.pool ?? SODIUM_POOL).toArray(), i * 3));
  pools.name = 'streetPools';
  pools.frustumCulled = false;
  pools.renderOrder = 1;
  group.add(pools);

  // ---------- Reflection streaks ----------
  const base = new THREE.PlaneGeometry(1, 1.2);
  base.translate(0, 0.4, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const iSize = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
  const iPhase = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iColor', iColor);
  geo.setAttribute('iSize', iSize);
  geo.setAttribute('iPhase', iPhase);
  const streakMat = new THREE.ShaderMaterial({
    vertexShader: streakVert,
    fragmentShader: streakFrag,
    defines: { SIGNAL: '' },
    uniforms: { strength: { value: 0.9 }, fogDensity: { value: fogDensity }, time: { value: 0 } },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    // Only 7 cm above the asphalt: without an offset distant streaks z-fight with it.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const streaks = new THREE.Mesh(geo, streakMat);
  streaks.name = 'streetStreaks';
  streaks.frustumCulled = false;
  streaks.renderOrder = 2;
  group.add(streaks);

  // ---------- Cell order and compaction ----------
  const streakOrder = sortByCell(eCell, nCells);
  const poolOrder = sortByCell(eCell.subarray(0, nLamps), nCells);
  /** Sorted place of each emitter in its order, and the GPU slot of each sorted place (-1: its cell is not drawn). */
  const streakRank = new Uint32Array(n);
  streakOrder.order.forEach((e, j) => (streakRank[e] = j));
  const poolRank = new Uint32Array(nLamps);
  poolOrder.order.forEach((e, j) => (poolRank[e] = j));
  const streakSlot = new Int32Array(n).fill(-1);
  const poolSlot = new Int32Array(nLamps).fill(-1);
  const poolMatrix = pools.instanceMatrix.array as Float32Array;
  const poolTint = pools.instanceColor!.array as Float32Array;

  /** Write one pool's matrix (a flat quad at the lamp, or collapsed when the lamp is dark) at GPU slot k. */
  const writePool = (k: number, e: number) => {
    const o = k * 16;
    const s = on[e] ? POOL_SIZE : 0;
    poolMatrix[o] = s;
    poolMatrix[o + 1] = poolMatrix[o + 2] = poolMatrix[o + 3] = 0;
    poolMatrix[o + 4] = 0;
    poolMatrix[o + 5] = 1;
    poolMatrix[o + 6] = poolMatrix[o + 7] = poolMatrix[o + 8] = poolMatrix[o + 9] = 0;
    poolMatrix[o + 10] = s;
    poolMatrix[o + 11] = 0;
    poolMatrix[o + 12] = ePos[e * 3];
    poolMatrix[o + 13] = ePos[e * 3 + 1] + 0.11;
    poolMatrix[o + 14] = ePos[e * 3 + 2];
    poolMatrix[o + 15] = 1;
  };
  /** Write one streak's colour at GPU slot k (black when dark). */
  const writeStreakColor = (k: number, e: number) => {
    const f = on[e];
    const a = iColor.array as Float32Array;
    a[k * 3] = eColor[e * 3] * f;
    a[k * 3 + 1] = eColor[e * 3 + 1] * f;
    a[k * 3 + 2] = eColor[e * 3 + 2] * f;
  };

  /** Cells drawn now (1 = drawn); all of them until the first view(). */
  const drawn = new Uint8Array(nCells).fill(1);
  const nextCells = new Uint8Array(nCells);
  const wideCells = new Uint8Array(nCells);
  const camPos = new THREE.Vector3();
  const cullStats = { compactions: 0, lastBytes: 0, pools: 0, streaks: 0 };

  const compactStreaks = (): void => {
    const pos = iPos.array as Float32Array;
    const size = iSize.array as Float32Array;
    const phase = iPhase.array as Float32Array;
    const { order, start } = streakOrder;
    streakSlot.fill(-1);
    let k = 0;
    for (let c = 0; c < nCells; c++) {
      if (!drawn[c]) continue;
      for (let j = start[c]; j < start[c + 1]; j++, k++) {
        const e = order[j];
        pos[k * 3] = ePos[e * 3];
        pos[k * 3 + 1] = ePos[e * 3 + 1];
        pos[k * 3 + 2] = ePos[e * 3 + 2];
        size[k * 2] = eSize[e * 2];
        size[k * 2 + 1] = eSize[e * 2 + 1];
        phase[k] = ePhase[e];
        writeStreakColor(k, e);
        streakSlot[j] = k;
      }
    }
    geo.instanceCount = k;
    streaks.visible = k > 0;
    cullStats.streaks = k;
    if (k > 0) {
      iPos.addUpdateRange(0, k * 3);
      iColor.addUpdateRange(0, k * 3);
      iSize.addUpdateRange(0, k * 2);
      iPhase.addUpdateRange(0, k);
      iPos.needsUpdate = iColor.needsUpdate = iSize.needsUpdate = iPhase.needsUpdate = true;
    }
  };
  const compactPools = (): void => {
    const { order, start } = poolOrder;
    poolSlot.fill(-1);
    let k = 0;
    for (let c = 0; c < nCells; c++) {
      if (!drawn[c]) continue;
      for (let j = start[c]; j < start[c + 1]; j++, k++) {
        const e = order[j];
        writePool(k, e);
        poolTint[k * 3] = poolColor[e * 3];
        poolTint[k * 3 + 1] = poolColor[e * 3 + 1];
        poolTint[k * 3 + 2] = poolColor[e * 3 + 2];
        poolSlot[j] = k;
      }
    }
    pools.count = k;
    pools.visible = k > 0;
    cullStats.pools = k;
    if (k > 0) {
      pools.instanceMatrix.addUpdateRange(0, k * 16);
      pools.instanceMatrix.needsUpdate = true;
      pools.instanceColor!.addUpdateRange(0, k * 3);
      pools.instanceColor!.needsUpdate = true;
    }
  };

  /** Pick the cells within cut (m) of the camera's lattice square, keeping drawn ones until cut + hysteresis. True when the set changed. */
  const pickCells = (cut: number): boolean => {
    // The reach shrinks with the camera's height above (or depth below) every surface the streaks lie on.
    const dy = Math.max(0, camPos.y - maxY, minY - camPos.y);
    const far = cut + VIEW_LATTICE.hysteresis;
    const L = VIEW_LATTICE.snap;
    const sx = grid.minX + (Math.floor((camPos.x - grid.minX) / L) + 0.5) * L;
    const sz = grid.minZ + (Math.floor((camPos.z - grid.minZ) / L) + 0.5) * L;
    grid.cellsWithin(sx, sz, cut > dy ? Math.sqrt(cut * cut - dy * dy) : -1, nextCells, L / 2);
    grid.cellsWithin(sx, sz, far > dy ? Math.sqrt(far * far - dy * dy) : -1, wideCells, L / 2);
    let changed = false;
    for (let c = 0; c < nCells; c++) {
      const v = nextCells[c] | (drawn[c] & wideCells[c]);
      if (v !== drawn[c]) {
        drawn[c] = v;
        changed = true;
      }
    }
    return changed;
  };

  compactStreaks();
  compactPools();

  const setEmitterOn = (i: number, lit: boolean) => {
    if (i < 0 || i >= n) return;
    const f = lit ? 1 : 0;
    if (on[i] === f) return;
    on[i] = f;
    const s = streakSlot[streakRank[i]];
    if (s >= 0) {
      writeStreakColor(s, i);
      iColor.addUpdateRange(s * 3, 3);
      iColor.needsUpdate = true;
    }
    if (i < nLamps) {
      const p = poolSlot[poolRank[i]];
      if (p >= 0) {
        writePool(p, i);
        pools.instanceMatrix.addUpdateRange(p * 16, 16);
        pools.instanceMatrix.needsUpdate = true;
      }
    }
  };

  return {
    group,
    extraBase,
    cullStats,
    setStrength(pool, streak) {
      poolMat.opacity = pool;
      streakMat.uniforms.strength.value = streak;
    },
    setLampOn(i, lit) {
      if (i >= 0 && i < nLamps) setEmitterOn(i, lit);
    },
    setEmitterOn,
    update(time) {
      streakMat.uniforms.time.value = time;
    },
    view(camera, fogDistance) {
      camera.getWorldPosition(camPos);
      if (!pickCells(fogDistance)) return;
      compactStreaks();
      compactPools();
      cullStats.compactions++;
      cullStats.lastBytes = cullStats.streaks * 4 * 9 + cullStats.pools * 4 * 19;
    },
    dispose() {
      glow.dispose();
      poolGeo.dispose();
      poolMat.dispose();
      pools.dispose();
      base.dispose();
      geo.dispose();
      streakMat.dispose();
    },
  };
}
