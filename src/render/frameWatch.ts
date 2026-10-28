/**
 * Frame watch: catches frames the GPU spoiled (NaN or Inf pixels, a see-through or all black picture), says where
 * in the post chain the damage started and, when it can, which mesh drew it.
 *
 * Why: a NaN pixel from any one shader (a spark, a shard, smoke in front of the camera) once reached the bloom on
 * Macs, spread to the whole frame and turned the canvas see-through, the "black screen" at race starts and in pile
 * ups. post.ts now contains a NaN where it lands, so a bad pixel is a black pixel, but the shader that made it is
 * still a bug; this is how it gets found.
 *
 * How, at almost no cost: three probe passes sit in the composer after the scene, the bloom and the FX pass. Once a
 * second (`FRAME_WATCH`; four times a second with `?glcheck`) each draws its buffer into a GRID x GRID target, every
 * probe pixel testing a block of the buffer for NaN / Inf by the bits (FINITE_GLSL) and averaging its alpha and
 * luminance, and reads that back asynchronously (a PBO and a fence: no stall). Free checks run every frame on the
 * numbers that would spoil a whole frame from the CPU side (camera matrices, exposure, fog, bloom strength).
 *
 * A bad frame becomes a `FrameReport`: logged once with `console.warn`, kept on `window.__nr.gr.watch.reports`, and
 * sent as a `bad_frame` error (analytics/errors.ts: once per message, a few per page). Whoever is on screen adds its
 * state through `context` (the race session: tick, cars, camera view). In dev builds and with `?glcheck` a scene
 * NaN also starts a hunt on the next frame: the scene is drawn again into a spare target with half the remaining
 * meshes hidden at a time until one mesh is left (about log2(meshes) draws, a hitch of a few hundred ms, at most
 * a few per page), and the report names it. `watch.hunt()` asks for one by hand from the console.
 */
import * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { reportError } from '../analytics/errors';
import { FINITE_GLSL } from './post';

/** The watch's numbers. */
export const FRAME_WATCH = {
  /** Seconds between probes; with ?glcheck. */
  interval: 1,
  intervalCheck: 0.25,
  /** Probe target size (pixels per side): each pixel covers 1/GRID of the buffer's width and height. */
  grid: 16,
  /** Most taps per side a probe pixel reads of its block (strided past that). */
  maxTaps: 32,
  /** Seconds after a report before the next is logged (one incident, one report). */
  cooldown: 5,
  /** Hunts per page at most (each is a hitch). */
  maxHunts: 3,
  /** Reports kept on `reports`, newest last. */
  keep: 10,
} as const;

/** Where in the chain a probe sits. */
export type FrameStage = 'scene' | 'bloom' | 'fx';
const STAGES: FrameStage[] = ['scene', 'bloom', 'fx'];

/** One probe's read of a buffer. */
export interface StageRead {
  /** Probe blocks (of GRID x GRID) holding a NaN or Inf pixel. */
  badBlocks: number;
  /** Mean alpha over the finite pixels (0..1). */
  alpha: number;
  /** Mean luminance over the finite pixels, compressed (0..1, 0 = all black). */
  luma: number;
}

/** The mesh a hunt narrowed a scene NaN down to. */
export interface Culprit {
  /** Hiding it alone cleared the NaN (false: several meshes, or the background, draw NaN). */
  confirmed: boolean;
  type: string;
  name: string;
  /** Its ancestors, nearest first, as `name` or `Type`. */
  path: string[];
  material: string;
  /** Vertex attributes of its geometry and the instance count if instanced. */
  geometry: string;
  /** World position (m). */
  position: [number, number, number];
  /** The object itself, for the console (not serialisable). */
  object: THREE.Object3D;
}

/** A spoiled frame. */
export interface FrameReport {
  /** performance.now() / 1000 when it was seen (s). */
  at: number;
  /** What went wrong, shortest first: 'nan:scene', 'clear', 'black', 'js:exposure' ... */
  problems: string[];
  /** The first stage holding NaN (where it started), or null. */
  origin: FrameStage | 'js' | null;
  stages: Partial<Record<FrameStage, StageRead>>;
  /** Draw calls and triangles of the last frame. */
  calls: number;
  triangles: number;
  state: Record<string, unknown>;
  culprit?: Culprit | 'not reproduced';
}

const PROBE_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 srcSize;
  uniform vec2 taps;
  ${FINITE_GLSL}
  void main() {
    // This probe pixel's block of the source, in source texels; taps spread over it at texel centres.
    vec2 block = srcSize / ${FRAME_WATCH.grid.toFixed(1)};
    vec2 origin = floor(gl_FragCoord.xy) * block;
    vec2 stepT = block / taps;
    float bad = 0.0;
    float alpha = 0.0;
    float luma = 0.0;
    float n = 0.0;
    for (int y = 0; y < ${FRAME_WATCH.maxTaps}; y++) {
      if (float(y) >= taps.y) break;
      for (int x = 0; x < ${FRAME_WATCH.maxTaps}; x++) {
        if (float(x) >= taps.x) break;
        vec2 t = floor(origin + (vec2(float(x), float(y)) + 0.5) * stepT) + 0.5;
        vec4 c = texture2D(tSrc, t / srcSize);
        n += 1.0;
        if (badRgba(c)) bad += 1.0;
        else {
          alpha += clamp(c.a, 0.0, 1.0);
          luma += dot(max(c.rgb, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
        }
      }
    }
    float ok = max(n - bad, 1.0);
    float l = luma / ok;
    // Any NaN or any light at all survives the 8 bit read as at least one step.
    gl_FragColor = vec4(bad > 0.0 ? 1.0 : 0.0, alpha / ok, l > 0.0 ? max(1.0 / 255.0, sqrt(min(1.0, l))) : 0.0, 1.0);
  }
`;

/** Draws a buffer's probe into its own small target and reads it back without a stall. */
class ProbePass extends Pass {
  armed = false;
  read: StageRead | null = null;
  private pending = false;
  private readonly target = new THREE.WebGLRenderTarget(FRAME_WATCH.grid, FRAME_WATCH.grid, { depthBuffer: false });
  private readonly pixels = new Uint8Array(FRAME_WATCH.grid * FRAME_WATCH.grid * 4);

  constructor(
    readonly stage: FrameStage,
    private readonly quad: FullScreenQuad,
    private readonly uniforms: { tSrc: { value: THREE.Texture | null }; srcSize: { value: THREE.Vector2 }; taps: { value: THREE.Vector2 } },
  ) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    if (!this.armed || this.pending) return;
    this.armed = false;
    this.draw(renderer, readBuffer);
    this.pending = true;
    renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, FRAME_WATCH.grid, FRAME_WATCH.grid, this.pixels)
      .then(() => (this.read = decode(this.pixels)))
      .catch(() => (this.read = null))
      .finally(() => (this.pending = false));
  }

  /** The same probe, read back at once (stalls; the hunt only). */
  readNow(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget): StageRead {
    this.draw(renderer, src);
    renderer.readRenderTargetPixels(this.target, 0, 0, FRAME_WATCH.grid, FRAME_WATCH.grid, this.pixels);
    return decode(this.pixels);
  }

  private draw(renderer: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget): void {
    const u = this.uniforms;
    u.tSrc.value = src.texture;
    u.srcSize.value.set(src.width, src.height);
    const block = Math.max(1, src.width / FRAME_WATCH.grid);
    const blockY = Math.max(1, src.height / FRAME_WATCH.grid);
    u.taps.value.set(Math.min(FRAME_WATCH.maxTaps, Math.ceil(block)), Math.min(FRAME_WATCH.maxTaps, Math.ceil(blockY)));
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.target.dispose();
  }
}

function decode(px: Uint8Array): StageRead {
  let bad = 0;
  let alpha = 0;
  let luma = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 0) bad++;
    alpha += px[i + 1];
    luma += px[i + 2];
  }
  return { badBlocks: bad, alpha: alpha / (255 * n), luma: luma / (255 * n) };
}

function finite(m: THREE.Matrix4): boolean {
  for (const v of m.elements) if (!Number.isFinite(v)) return false;
  return true;
}

function describe(o: THREE.Object3D, confirmed: boolean): Culprit {
  const path: string[] = [];
  for (let p = o.parent; p && path.length < 6; p = p.parent) path.push(p.name || p.type);
  const mats = (Array.isArray((o as THREE.Mesh).material) ? (o as THREE.Mesh).material : [(o as THREE.Mesh).material]) as THREE.Material[];
  const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  const inst = (o as THREE.InstancedMesh).count ?? (geo as THREE.InstancedBufferGeometry | undefined)?.instanceCount;
  const p = o.getWorldPosition(new THREE.Vector3());
  return {
    confirmed,
    type: o.type,
    name: o.name,
    path,
    material: mats.map((m) => (m ? `${m.type}${m.name ? ` "${m.name}"` : ''}${m.transparent ? ' transparent' : ''}` : '?')).join(', '),
    geometry: geo ? `${Object.keys(geo.attributes).join(' ')}${inst !== undefined && Number.isFinite(inst) ? `, ${inst} instances` : ''}` : '',
    position: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
    object: o,
  };
}

export class FrameWatch {
  readonly reports: FrameReport[] = [];
  /** Whoever is on screen adds its state to a report (the race session: tick, cars, view); null for none. */
  context: (() => Record<string, unknown>) | null = null;
  private readonly probes: ProbePass[];
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly hunting: boolean;
  private readonly interval: number;
  private clock = 0;
  private armedAt = -1;
  private lastReport = -Infinity;
  private hunts = 0;
  /** A hunt waits for the next frame (it needs the scene and camera being drawn). */
  private huntFor: FrameReport | null = null;
  private jsBad = '';

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    composer: EffectComposer,
    after: { scene: Pass; bloom: Pass; fx: Pass },
    private readonly bloomStrength: () => number,
  ) {
    const check = new URLSearchParams(location.search).has('glcheck');
    this.hunting = import.meta.env.DEV || check;
    this.interval = check ? FRAME_WATCH.intervalCheck : FRAME_WATCH.interval;
    const uniforms = { tSrc: { value: null as THREE.Texture | null }, srcSize: { value: new THREE.Vector2(1, 1) }, taps: { value: new THREE.Vector2(1, 1) } };
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: PROBE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
    this.probes = STAGES.map((s) => new ProbePass(s, this.quad, uniforms));
    // Each probe right after the pass it reads.
    for (const probe of this.probes) composer.insertPass(probe, composer.passes.indexOf(after[probe.stage]) + 1);
  }

  /** Before the frame is drawn: the free checks, a waiting hunt, and the probes when they are due. */
  frame(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    this.clock += Number.isFinite(dt) ? dt : 0;
    if (this.huntFor) {
      const r = this.huntFor;
      this.huntFor = null;
      this.runHunt(r, scene, camera);
    }
    const fog = scene.fog as THREE.FogExp2 | null;
    const js = !finite(camera.matrixWorld) ? 'camera' : !finite(camera.projectionMatrix) ? 'projection' : !Number.isFinite(this.renderer.toneMappingExposure) ? 'exposure' : fog && 'density' in fog && !Number.isFinite(fog.density) ? 'fog' : !Number.isFinite(this.bloomStrength()) ? 'bloom' : '';
    if (js && js !== this.jsBad) this.report([`js:${js}`], 'js', {});
    this.jsBad = js;
    this.collect();
    if (this.armedAt < 0 && this.clock >= this.interval) {
      this.clock = 0;
      this.armedAt = performance.now();
      for (const p of this.probes) {
        p.read = null;
        p.armed = true;
      }
    }
  }

  /** Hunt the mesh drawing NaN on the next frame (dev builds and ?glcheck; also by hand from the console). */
  hunt(): void {
    this.huntFor = this.newReport(['manual'], null, {});
  }

  /** When all three reads are back, judge the frame. */
  private collect(): void {
    if (this.armedAt < 0) return;
    if (this.probes.some((p) => !p.read)) {
      // A read still on its way, or a probe that never ran (a failed read, no frame drawn): give the round up after a while.
      if (performance.now() - this.armedAt > 2000) this.armedAt = -1;
      return;
    }
    this.armedAt = -1;
    const stages: Partial<Record<FrameStage, StageRead>> = {};
    for (const p of this.probes) stages[p.stage] = p.read as StageRead;
    const problems: string[] = [];
    const origin = STAGES.find((s) => stages[s]!.badBlocks > 0) ?? null;
    if (origin) problems.push(`nan:${origin}`);
    const fx = stages.fx!;
    if (fx.alpha < 0.5) problems.push('clear');
    if (fx.luma === 0) problems.push('black');
    if (problems.length) this.report(problems, origin, stages);
  }

  private newReport(problems: string[], origin: FrameReport['origin'], stages: FrameReport['stages']): FrameReport {
    const info = this.renderer.info.render;
    let state: Record<string, unknown> = {};
    try {
      state = this.context?.() ?? {};
    } catch (err) {
      state = { contextError: String(err) };
    }
    return { at: performance.now() / 1000, problems, origin, stages, calls: info.calls, triangles: info.triangles, state };
  }

  private report(problems: string[], origin: FrameReport['origin'], stages: FrameReport['stages']): void {
    const now = performance.now() / 1000;
    if (now - this.lastReport < FRAME_WATCH.cooldown) return;
    this.lastReport = now;
    const r = this.newReport(problems, origin, stages);
    this.keep(r);
    console.warn(`[frame watch] bad frame: ${problems.join(', ')}`, r);
    // All black with nothing NaN can be a frame that really is dark (a loading scene): the console only.
    if (problems.some((p) => p !== 'black')) reportError('bad_frame', `Bad frame: ${problems.join(', ')}`);
    if (origin === 'scene' && this.hunting && this.hunts < FRAME_WATCH.maxHunts) this.huntFor = r;
  }

  private keep(r: FrameReport): void {
    if (this.reports.includes(r)) return;
    this.reports.push(r);
    if (this.reports.length > FRAME_WATCH.keep) this.reports.shift();
  }

  /** Draw the scene again into a spare target, hiding half the remaining meshes each time, until one is left. */
  private runHunt(r: FrameReport, scene: THREE.Scene, camera: THREE.Camera): void {
    this.hunts++;
    const gl = this.renderer;
    const size = gl.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, stencilBuffer: true });
    const prev = gl.getRenderTarget();
    const probe = this.probes[0];
    const test = (): boolean => {
      gl.setRenderTarget(target);
      gl.render(scene, camera);
      return probe.readNow(gl, target).badBlocks > 0;
    };
    const t0 = performance.now();
    try {
      if (!test()) {
        r.culprit = 'not reproduced';
      } else {
        const meshes: THREE.Object3D[] = [];
        scene.traverseVisible((o) => {
          if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) meshes.push(o);
        });
        let cands = meshes;
        while (cands.length > 1) {
          const half = cands.slice(0, cands.length >> 1);
          for (const o of half) o.visible = false;
          const still = test();
          for (const o of half) o.visible = true;
          cands = still ? cands.slice(half.length) : half;
        }
        const o = cands[0];
        if (o) {
          o.visible = false;
          const confirmed = !test();
          o.visible = true;
          r.culprit = describe(o, confirmed);
        }
      }
    } catch (err) {
      r.state.huntError = String(err);
    } finally {
      target.dispose();
      gl.setRenderTarget(prev);
    }
    this.keep(r);
    const c = r.culprit;
    const ms = Math.round(performance.now() - t0);
    if (c && c !== 'not reproduced') {
      console.warn(`[frame watch] NaN drawn by ${c.type}${c.name ? ` "${c.name}"` : ''} (${c.material}) under ${c.path.join(' < ')}${c.confirmed ? '' : ' (not alone)'}; hunt took ${ms} ms`, c.object, r);
      reportError('bad_frame', `NaN drawn by ${c.type} ${c.material} under ${c.path.slice(0, 3).join(' < ')}`);
    } else console.warn(`[frame watch] hunt: the NaN was gone by the next frame (${ms} ms)`, r);
  }

  dispose(): void {
    for (const p of this.probes) p.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
