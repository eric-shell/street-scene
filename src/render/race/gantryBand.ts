/**
 * The dot-matrix band under a gantry's sign: live race text ("P3 LAP 2/3", the leader's gap, the fastest
 * lap, FINAL LAP, FINISH P2) in the LED ticker style of signage.ts. One plane per gate; its texture is a
 * strip with one texel per dot, rewritten only when the page on show changes (every `pageSeconds` at most),
 * and the shader turns each texel into a round lit dot, so per frame the band costs two uniform writes.
 * The pages are set by the session (and default to the event's name, which is what the menu shows); the
 * band cycles through them on the scene clock. Render only.
 */
import * as THREE from 'three';
import { canvas, canvasTex } from '../textures/canvasKit';
import { DIEGETIC } from './diegetic';

const D = DIEGETIC.band;

/** Dot colours by tone (linear, above 1 so the lit dots bloom). */
const TONES = {
  amber: new THREE.Color(1.0, 0.62, 0.12),
  green: new THREE.Color(0.2, 1.0, 0.45),
  red: new THREE.Color(1.0, 0.14, 0.1),
  pink: new THREE.Color(1.0, 0.2, 0.55),
  white: new THREE.Color(0.9, 0.95, 1.0),
} as const;

export type BandTone = keyof typeof TONES;

/** One page of the band: its text, colour and whether it blinks. */
export interface BandPage {
  text: string;
  tone: BandTone;
  flash?: boolean;
}

export interface GantryBand {
  mesh: THREE.Mesh;
  /** Height of the lit area (m). */
  height: number;
  /** Replace the pages on show; a no-op when they are the same. */
  set(pages: readonly BandPage[]): void;
  /** Advance to the page the clock is on and write the shader's time. */
  update(time: number): void;
}

/** A band `width` metres wide; everything it owns is handed to `track`. */
export function createBand(width: number, track: <T extends { dispose(): void }>(x: T) => T, initial: readonly BandPage[]): GantryBand {
  const cols = Math.max(32, Math.round(width / D.pitch));
  const rows = D.rows;
  const height = rows * D.pitch;
  const [c, g] = canvas(cols, rows);
  const tex = track(canvasTex(c, { srgb: false, repeat: false, anisotropy: 1 }));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  const uniforms = {
    uBandTex: { value: tex },
    uBandColor: { value: new THREE.Color() },
    uBandTime: { value: 0 },
    uBandFlash: { value: 0 },
  };
  const mat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, map: tex }));
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uBandTex;\nuniform vec3 uBandColor;\nuniform float uBandTime;\nuniform float uBandFlash;`)
      .replace(
        '#include <map_fragment>',
        `{
          vec2 cell = vec2(floor(vMapUv.x * ${cols.toFixed(1)}), floor(clamp(vMapUv.y, 0.0, 0.9999) * ${rows.toFixed(1)}));
          float lit = step(0.5, texture2D(uBandTex, (cell + 0.5) / vec2(${cols.toFixed(1)}, ${rows.toFixed(1)})).r);
          vec2 f = fract(vMapUv * vec2(${cols.toFixed(1)}, ${rows.toFixed(1)})) - 0.5;
          float dotMask = 1.0 - smoothstep(0.32, 0.46, length(f));
          float far = smoothstep(0.35, 0.9, max(fwidth(vMapUv.x * ${cols.toFixed(1)}), fwidth(vMapUv.y * ${rows.toFixed(1)})));
          float mask = mix(dotMask, 0.6, far);
          float blink = uBandFlash > 0.5 ? step(fract(uBandTime * ${D.flashHz.toFixed(2)}), 0.5) : 1.0;
          diffuseColor.rgb = uBandColor * (0.03 + lit * mask * blink * ${D.gain.toFixed(2)});
        }`,
      );
  };
  mat.customProgramCacheKey = () => `gantryBand:${cols}x${rows}`;
  const geo = track(new THREE.PlaneGeometry(cols * D.pitch, height));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'gantryBand';

  let pages: BandPage[] = [];
  let key = '';
  let shown = -1;
  let shownText = '';

  const draw = (page: BandPage): void => {
    uniforms.uBandColor.value.copy(TONES[page.tone]);
    uniforms.uBandFlash.value = page.flash ? 1 : 0;
    if (page.text === shownText) return;
    shownText = page.text;
    g.fillStyle = '#000';
    g.fillRect(0, 0, cols, rows);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = `bold ${rows}px "Arial Black", Impact, sans-serif`;
    // Squeeze a long page to the band instead of cutting it.
    const w = g.measureText(page.text).width;
    const fit = Math.min(1, (cols - 6) / Math.max(1, w));
    g.save();
    g.translate(cols / 2, 0);
    g.scale(fit, 1);
    g.fillText(page.text, 0, rows - 1.5);
    g.restore();
    tex.needsUpdate = true;
  };

  const band: GantryBand = {
    mesh,
    height,
    set(next) {
      const k = next.map((p) => `${p.text}|${p.tone}|${p.flash ? 1 : 0}`).join('\n');
      if (k === key) return;
      key = k;
      pages = next.map((p) => ({ ...p }));
      shown = -1;
    },
    update(time) {
      uniforms.uBandTime.value = time;
      if (!pages.length) return;
      const i = Math.floor(time / D.pageSeconds) % pages.length;
      if (i === shown) return;
      shown = i;
      draw(pages[i]);
    },
  };
  band.set(initial);
  band.update(0);
  return band;
}
