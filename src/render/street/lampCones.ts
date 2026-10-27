/**
 * Light in the air: on damp nights the nearest streetlamps show a soft cone from the lens down to the pool on the
 * ground (what a real lamp does in mist, drizzle or rain, and what the dry night lacks). One InstancedMesh of one
 * 8 sided, three ring tapered hull, open at both ends and drawn from outside only (front faces), so a cone costs
 * 32 triangles and one pixel of overdraw where it is seen; Medium draws 24 of them, High 48, Low none.
 *
 * Fill rate is the whole risk (the cones are additive and big on screen), so four things keep the coverage small:
 *  - The brightness across a cone is the fragment's `|N . V|` squared: bright where the hull faces the viewer, zero
 *    at the silhouette, so a cone has no hard edge and three that overlap read as a soft bloom, not a stack of discs.
 *  - Per cone, in the vertex shader: a cone seen along its axis (the camera above or below it) would stack its whole
 *    hull into one white disc, so it fades out between 37 and 67 degrees of elevation; one whose foot is within 9 m of
 *    the camera (it would fill the screen) fades to nothing at 3 m; one that is faded to nothing moves off screen, so
 *    it is not rasterized at all.
 *  - Distance: the pick is the N nearest lamps (the lamps are static; view() runs a short insertion pick over the
 *    lamps of the cells within reach, rebuilt only when the camera crosses a 100 m lattice line, the same lattice as
 *    lightFx's culling), with distance counted double for a lamp behind the camera (the chase camera sees ahead). A
 *    cone fades out over its last 55 % of that distance, and the fade ends at the Nth nearest lamp's own distance
 *    when that is closer than the reach, so a lamp enters or leaves the pick at zero brightness: nothing pops.
 *  - The mood decides the air: mist 1, drizzle 0.6, rain 0.5, haze 0.35, clear none (nothing is built). The strength
 *    is fixed at build, like the mood itself.
 * Cones are fogged with the shared height fog (heightFog.ts), so one in the river channel's haze is softer.
 *
 * The slots are stable: a lamp that stays in the pick keeps its instance, so view() writes the matrices only of the
 * lamps that enter, and nothing when the pick has not changed. A broken lamp (setLampOn) drops its cone at once.
 * Park lanterns and the market strings are not included (no lens height to speak of), and neither are the
 * expressway's lamps: they hang over or under a deck, with no ground pool below them to light. Render only; view()
 * allocates nothing.
 */
import * as THREE from 'three';
import type { Quality } from '../../ui/settings';
import { VIEW_LATTICE, type ChunkGrid } from '../cityChunks';
import { Disposer } from '../disposer';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';
import type { MoodId } from '../sky/weather';

export const LAMP_CONES = {
  /** Per quality tier: cones drawn at once and the farthest one that shows (m). */
  tier: {
    low: { count: 0, reach: 0 },
    medium: { count: 24, reach: 110 },
    high: { count: 48, reach: 160 },
  },
  /** How much of the light the air shows, per mood (1 = mist); clear builds no cones. */
  air: { clear: 0, hazy: 0.35, misty: 1, drizzle: 0.6, rain: 0.5 },
  /** Peak brightness of one cone at its lens in full mist (linear, added to the frame), times the lamp's pool tone. */
  strength: 0.4,
  /** A cone's brightness at its foot as a fraction of the lens end (a lamp is brightest at the source). */
  footGain: 0.3,
  /** Sides and rings (rows of vertices, lens to foot) of the hull. */
  sides: 8,
  rings: 3,
  /** Foot radius as a fraction of the cone's height, and the lens end's radius as a fraction of the foot's. */
  footRatio: 0.55,
  lensRatio: 0.06,
  /** A cone starts this far above the ground (m), over the pool's 0.2 m. */
  footLift: 0.1,
  /** Lamps whose head is lower or higher than this over the ground (m) get no cone. */
  minHeight: 3,
  maxHeight: 14,
  /** The elevation of the view ray over the horizon (sine) where a cone starts to fade, and where it is gone: a cone seen along its axis. */
  axisFade: { from: 0.6, to: 0.92 },
  /** A cone's distance fade starts at this fraction of its fade end. */
  distFrom: 0.45,
  /** How much farther a lamp behind the camera counts: distance times (1 + this * 0.5 * (1 - cos of the angle to the view direction)). */
  behind: 1,
  /** Distance (m) from the camera to a cone's foot where it is gone and where it is fully there. */
  near: { zero: 3, full: 9 },
} as const;

/** The cone hull: a unit height tapered tube, y = 0 at the foot (radius 1) to y = 1 at the lens (radius `lensRatio`). */
function coneGeometry(): THREE.BufferGeometry {
  const { sides, rings, lensRatio } = LAMP_CONES;
  const pos: number[] = [];
  for (let k = 0; k < rings; k++) {
    const y = k / (rings - 1);
    const r = 1 + (lensRatio - 1) * y;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  const index: number[] = [];
  for (let k = 0; k < rings - 1; k++) {
    for (let i = 0; i < sides; i++) {
      const a = k * sides + i;
      const b = k * sides + ((i + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      // Counter clockwise seen from outside, so the front faces are the near side of the hull.
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  return geo;
}

const coneVert = /* glsl */ `
  uniform float uStrength;
  uniform float uFadeEnd;
  uniform vec3 uCamFwd;
  uniform float fogDensity;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vColor;
  varying float vAlong;
  ${HEIGHT_FOG_GLSL}
  void main() {
    // The instance matrix is a pure scale (radius, height, radius) and a move to the foot.
    vec3 foot = instanceMatrix[3].xyz;
    float height = instanceMatrix[1].y;
    vec3 mid = foot + vec3(0.0, 0.5 * height, 0.0);
    vec3 toMid = mid - cameraPosition;
    float dist = max(length(toMid), 0.001);
    vec3 dir = toMid / dist;
    float axis = 1.0 - smoothstep(${LAMP_CONES.axisFade.from.toFixed(3)}, ${LAMP_CONES.axisFade.to.toFixed(3)}, abs(dir.y));
    float dEff = dist * (1.0 + ${LAMP_CONES.behind.toFixed(3)} * 0.5 * (1.0 - dot(dir, uCamFwd)));
    float farF = 1.0 - smoothstep(${LAMP_CONES.distFrom.toFixed(3)} * uFadeEnd, uFadeEnd, dEff);
    float nearF = smoothstep(${LAMP_CONES.near.zero.toFixed(3)}, ${LAMP_CONES.near.full.toFixed(3)}, distance(foot, cameraPosition));
    float amp = axis * farF * nearF * step(0.01, height);
    if (amp < 0.004) {
      // Faded out: park the whole cone outside the clip volume, so it is not rasterized.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vN = vV = vColor = vec3(0.0);
      vAlong = 0.0;
      return;
    }
    vec4 wp = modelMatrix * (instanceMatrix * vec4(position, 1.0));
    vec4 mv = viewMatrix * wp;
    float fd = length(mv.xyz);
    float fog = exp(-fogDensity * fogDensity * fd * fd * hfMulView(mv.xyz));
    vec2 radial = normalize(position.xz);
    // The hull's outward normal: horizontal radial, tilted up by the constant slope (foot radius is footRatio * height).
    vN = vec3(radial.x, ${(LAMP_CONES.footRatio * (1 - LAMP_CONES.lensRatio)).toFixed(4)}, radial.y);
    vV = cameraPosition - wp.xyz;
    vAlong = position.y;
    vColor = instanceColor * (uStrength * amp * fog);
    gl_Position = projectionMatrix * mv;
  }
`;

const coneFrag = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vColor;
  varying float vAlong;
  void main() {
    // Facing the viewer is bright, the silhouette is zero (squared: soft edge, so stacked cones add up to a bloom).
    float ndv = abs(dot(normalize(vN), normalize(vV)));
    float a = ndv * ndv * mix(${LAMP_CONES.footGain.toFixed(3)}, 1.0, vAlong);
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

export interface LampCones {
  group: THREE.Group;
  /** Switch one streetlight's cone (streetlight index; a broken lamp drops it). */
  setLampOn(index: number, on: boolean): void;
  /** Pick the nearest lamps for this camera and write the instances that changed. Call once per render, after the camera's matrices are current. */
  view(camera: THREE.Camera): void;
  /** Dev stats: cones shown now, instance writes since the build. */
  readonly stats: { shown: number; writes: number; picks: number };
  dispose(): void;
}

export interface LampConesOptions {
  quality: Quality;
  /** The seed's weather mood (weather.ts): how much of the light the air shows. */
  mood: MoodId;
  /** The scene's fog density (the shared height fog scales it). */
  fogDensity: number;
  /** The scene's culling grid (200 m cells). */
  grid: ChunkGrid;
}

const _fwd = new THREE.Vector3();
const _cam = new THREE.Vector3();

/**
 * Build the cones for the streetlights (`lamps`: the lens positions after lampStyle.fitLampPositions; `tones`: their
 * pool colours, parallel). Null when this quality or mood shows none, so a clear night or Low pays nothing.
 */
export function buildLampCones(lamps: readonly THREE.Vector3[], tones: readonly THREE.Color[], heightAt: (x: number, z: number) => number, opts: LampConesOptions): LampCones | null {
  const C = LAMP_CONES;
  const air = C.air[opts.mood];
  const { count: N, reach } = C.tier[opts.quality];
  if (N <= 0 || air <= 0 || lamps.length === 0) return null;
  const grid = opts.grid;
  const nCells = grid.count;
  const nLamps = lamps.length;
  const disposer = new Disposer();
  const { track } = disposer;

  // ---------- Static lamp data: the cone's foot, height and radius, and its cell ----------
  const lx = new Float32Array(nLamps);
  const lz = new Float32Array(nLamps);
  const footY = new Float32Array(nLamps);
  const height = new Float32Array(nLamps);
  /** 1 while the lamp can show a cone: it has a sensible height and is not broken. */
  const usable = new Uint8Array(nLamps);
  /** 1 for lamps that are lit (setLampOn) whether or not they have a cone height. */
  const lit = new Uint8Array(nLamps).fill(1);
  const cellOf = new Uint16Array(nLamps);
  lamps.forEach((p, i) => {
    const gy = heightAt(p.x, p.z) + C.footLift;
    const h = p.y - gy;
    lx[i] = p.x;
    lz[i] = p.z;
    footY[i] = gy;
    height[i] = h;
    usable[i] = h >= C.minHeight && h <= C.maxHeight ? 1 : 0;
    cellOf[i] = grid.cellOf(p.x, p.z);
  });
  // Lamps by cell (counting sort): a cell's lamps are byCell[start[c]..start[c + 1]).
  const start = new Uint32Array(nCells + 1);
  for (let i = 0; i < nLamps; i++) if (usable[i]) start[cellOf[i] + 1]++;
  for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
  const byCell = new Uint32Array(start[nCells]);
  const fill = start.slice(0, nCells);
  for (let i = 0; i < nLamps; i++) if (usable[i]) byCell[fill[cellOf[i]]++] = i;

  // ---------- The mesh ----------
  const geo = track(coneGeometry());
  const mat = track(
    new THREE.ShaderMaterial({
      vertexShader: coneVert,
      fragmentShader: coneFrag,
      uniforms: {
        uStrength: { value: C.strength * air },
        uFadeEnd: { value: reach },
        uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
        fogDensity: { value: opts.fogDensity },
        ...HEIGHT_FOG_UNIFORMS,
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  const mesh = track(new THREE.InstancedMesh(geo, mat, N));
  mesh.name = 'lampCones';
  mesh.frustumCulled = false;
  // Over the pools (1) and streaks (2), under the rain.
  mesh.renderOrder = 3;
  mesh.count = 0;
  mesh.visible = false;
  mesh.setColorAt(0, new THREE.Color());
  const matrices = mesh.instanceMatrix.array as Float32Array;
  const colors = mesh.instanceColor!.array as Float32Array;
  const group = new THREE.Group();
  group.name = 'lampCones';
  group.add(mesh);

  // ---------- Slots: which lamp each instance shows ----------
  const slotLamp = new Int32Array(N).fill(-1);
  const lampSlot = new Int32Array(nLamps).fill(-1);
  /** Pick stamp per lamp: equal to `stamp` when the lamp is in the current pick. */
  const picked = new Uint32Array(nLamps);
  let stamp = 0;
  const bestD = new Float32Array(N);
  const bestI = new Int32Array(N);
  /** Lamps of the cells within reach of the camera's lattice square (the pick's candidates). */
  const cand = new Uint32Array(start[nCells]);
  let nCand = 0;
  const cells = new Uint8Array(nCells);
  let latticeX = NaN;
  let latticeZ = NaN;
  let dirty = false;
  const stats = { shown: 0, writes: 0, picks: 0 };

  const writeSlot = (s: number, lamp: number): void => {
    const o = s * 16;
    if (lamp < 0) {
      matrices.fill(0, o, o + 16);
      matrices[o + 15] = 1;
      return;
    }
    const r = C.footRatio * height[lamp];
    matrices[o] = r;
    matrices[o + 1] = matrices[o + 2] = matrices[o + 3] = 0;
    matrices[o + 4] = 0;
    matrices[o + 5] = height[lamp];
    matrices[o + 6] = matrices[o + 7] = matrices[o + 8] = matrices[o + 9] = 0;
    matrices[o + 10] = r;
    matrices[o + 11] = 0;
    matrices[o + 12] = lx[lamp];
    matrices[o + 13] = footY[lamp];
    matrices[o + 14] = lz[lamp];
    matrices[o + 15] = 1;
    const t = tones[lamp];
    colors[s * 3] = t ? t.r : 1;
    colors[s * 3 + 1] = t ? t.g : 0.7;
    colors[s * 3 + 2] = t ? t.b : 0.4;
  };
  const freeSlot = (s: number): void => {
    const lamp = slotLamp[s];
    if (lamp >= 0) lampSlot[lamp] = -1;
    slotLamp[s] = -1;
    writeSlot(s, -1);
    dirty = true;
  };

  /** Rebuild the candidate lamps when the camera enters another square of the 100 m lattice. */
  const pickCandidates = (x: number, z: number): void => {
    const L = VIEW_LATTICE.snap;
    const sx = grid.minX + (Math.floor((x - grid.minX) / L) + 0.5) * L;
    const sz = grid.minZ + (Math.floor((z - grid.minZ) / L) + 0.5) * L;
    if (sx === latticeX && sz === latticeZ) return;
    latticeX = sx;
    latticeZ = sz;
    grid.cellsWithin(sx, sz, reach, cells, L / 2);
    nCand = 0;
    for (let c = 0; c < nCells; c++) {
      if (!cells[c]) continue;
      for (let j = start[c]; j < start[c + 1]; j++) cand[nCand++] = byCell[j];
    }
  };

  return {
    group,
    stats,
    setLampOn(i, on) {
      if (i < 0 || i >= nLamps) return;
      lit[i] = on ? 1 : 0;
      const s = lampSlot[i];
      if (!on && s >= 0) {
        freeSlot(s);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    },
    view(camera) {
      camera.getWorldPosition(_cam);
      camera.getWorldDirection(_fwd);
      pickCandidates(_cam.x, _cam.z);
      // The N nearest lamps by weighted distance (insertion into a short sorted list), skipping those whose foot is under the near fade.
      let nb = 0;
      const nearSq = C.near.zero * C.near.zero;
      for (let j = 0; j < nCand; j++) {
        const i = cand[j];
        if (!lit[i]) continue;
        const fx = lx[i] - _cam.x;
        const fz = lz[i] - _cam.z;
        const fy = footY[i] - _cam.y;
        if (fx * fx + fy * fy + fz * fz < nearSq) continue;
        const dx = fx;
        const dy = fy + 0.5 * height[i];
        const dz = fz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 0.001) continue;
        const cosF = (dx * _fwd.x + dy * _fwd.y + dz * _fwd.z) / d;
        const dEff = d * (1 + C.behind * 0.5 * (1 - cosF));
        if (dEff >= reach || (nb === N && dEff >= bestD[N - 1])) continue;
        let k = nb < N ? nb++ : N - 1;
        while (k > 0 && bestD[k - 1] > dEff) {
          bestD[k] = bestD[k - 1];
          bestI[k] = bestI[k - 1];
          k--;
        }
        bestD[k] = dEff;
        bestI[k] = i;
      }
      stats.picks++;
      // The fade ends at the last pick's own distance when the pick is full, so what enters or leaves is invisible.
      mat.uniforms.uFadeEnd.value = nb === N ? Math.min(reach, bestD[N - 1]) : reach;
      (mat.uniforms.uCamFwd.value as THREE.Vector3).copy(_fwd);

      // Stable slots: free those whose lamp left the pick, then give the newcomers the free ones.
      stamp++;
      for (let k = 0; k < nb; k++) picked[bestI[k]] = stamp;
      for (let s = 0; s < N; s++) if (slotLamp[s] >= 0 && picked[slotLamp[s]] !== stamp) freeSlot(s);
      let s = 0;
      for (let k = 0; k < nb; k++) {
        const lamp = bestI[k];
        if (lampSlot[lamp] >= 0) continue;
        while (slotLamp[s] >= 0) s++;
        slotLamp[s] = lamp;
        lampSlot[lamp] = s;
        writeSlot(s, lamp);
        stats.writes++;
        dirty = true;
      }
      if (dirty) {
        dirty = false;
        let used = 0;
        for (let t = 0; t < N; t++) if (slotLamp[t] >= 0) used = t + 1;
        mesh.count = used;
        mesh.visible = used > 0;
        stats.shown = nb;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    },
    dispose() {
      disposer.dispose();
    },
  };
}
