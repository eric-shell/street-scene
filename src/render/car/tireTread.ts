/**
 * The tire's tread texture: one small canvas texture every lathed tire shares (tireShapes.ts gives all of
 * them the same UVs), in the manner of a semi-slick road-race tire (our own design, not any maker's): big
 * solid blocks across the crown, two circumferential grooves (real geometry, `TREAD.grooves`) with the wide
 * one toward the inner shoulder, and big slanted lateral cuts across the outer shoulder that run off onto
 * the sidewall's edge. Printed brand lettering on the outer sidewall is a variant of the same texture the
 * player switches on in the garage (`VisualBuild.wheels.lettering`): the plain variant has none of it, so
 * off costs nothing but the texture it does not use.
 *
 * One RGBA texture does three jobs of the tire material, each reading its own channel: red is the height
 * (bump map: the cuts and grooves sunk), green the roughness (tread a touch smoother than the
 * sidewall), blue the lettering's ink (blended over the rubber by `tireShader`). The width covers the whole
 * circumference, so the sidewall's lettering is drawn once per half and the tread pattern repeats
 * `TREAD.pitches` times across it; the v bands (`TREAD.band`) are the face sidewall, the tread and a plain
 * strip. The right side's wheel holder is mirrored (x scale -1) and its tread mirrors with it, so the cuts
 * slant the same way on both sides of the car; only the lettering is read with u flipped there, so it reads
 * true (`tireShader`). Render only (needs a DOM canvas); low quality leaves the tire plain.
 *
 * Variants are cached and counted: every car view in a scene shares them, and the last release disposes.
 */
import * as THREE from 'three';
import { canvas, canvasTex, fitFont } from '../textures/canvasKit';
import { TREAD } from './tireShapes';

/** The fictional tire brand on the lettered sidewall (a made up tuner name, never a real maker's) and its model line. */
export const TIRE_BRAND = { brand: 'KUROTORA', model: 'HAYATE R' } as const;

/** Texture size (px): the width covers the whole circumference. */
const W = 2048;
const H = 512;
/** Ink of the lettering (linear grey, 1 = white), blended over the rubber by its mask. */
export const TIRE_INK = 0.22;
/** The tire's inside where the arch clip cuts it open (linear, before tone mapping): a hair darker than the rubber's shade. */
const TIRE_CUT = 0.006;
/** Bump strength of the material (the texture's red channel is a 0..1 height). */
export const TIRE_BUMP = 3.5;

const y = (v: number) => (1 - v) * H;
const tread = (t: number) => y(TREAD.band.sidewall + t * (TREAD.band.tread - TREAD.band.sidewall));

/** Height levels (0..255) of the layers. */
const LEVEL = { block: 200, sidewall: 120, cut: 30, sipe: 110, groove: 50 };

/** Draw a slanted cut: a parallelogram from (x, y0) to (x + slant, y1), `w0` wide at the first end and `w1` at the second (wrapping across the seam). */
function cut(g: CanvasRenderingContext2D, x: number, y0: number, y1: number, slant: number, w0: number, w1: number, level: number): void {
  g.fillStyle = `rgb(${level},${level},${level})`;
  for (const dx of [-W, 0, W]) {
    g.beginPath();
    g.moveTo(x + dx, y0);
    g.lineTo(x + dx + w0, y0);
    g.lineTo(x + dx + slant + w1, y1);
    g.lineTo(x + dx + slant, y1);
    g.closePath();
    g.fill();
  }
}

/** The height layer: the sidewall's base, the tread's blocks and the cuts and sipes that separate them. */
function drawHeight(g: CanvasRenderingContext2D): void {
  g.fillStyle = `rgb(${LEVEL.sidewall},${LEVEL.sidewall},${LEVEL.sidewall})`;
  g.fillRect(0, 0, W, H);
  // The tread: solid rubber from the shoulder to the back shoulder.
  g.fillStyle = `rgb(${LEVEL.block},${LEVEL.block},${LEVEL.block})`;
  g.fillRect(0, tread(1), W, tread(0) - tread(1));
  // The circumferential grooves (geometry too, tireShapes.ts): their floors sunk to match, so they read dark in the bump and the shading.
  g.fillStyle = `rgb(${LEVEL.groove},${LEVEL.groove},${LEVEL.groove})`;
  for (const gr of TREAD.grooves) g.fillRect(0, tread(gr.at + gr.half), W, tread(gr.at - gr.half) - tread(gr.at + gr.half));
  const pitch = W / TREAD.pitches;
  for (let k = 0; k < TREAD.pitches; k++) {
    const x = k * pitch + pitch * 0.18;
    // Big slanted cuts over the face shoulder, wide at the edge and tapering in, running off onto the sidewall's top.
    cut(g, x, tread(-0.18), tread(0.34), 58, 44, 18, LEVEL.cut);
    // Thin sipes across the crown's solid blocks, a half pitch on.
    cut(g, x + pitch * 0.5 + 14, tread(0.43), tread(0.64), 12, 3, 3, LEVEL.sipe);
    // Small notches on the back shoulder.
    cut(g, x + pitch * 0.5 - 6, tread(0.84), tread(1.04), -10, 8, 5, LEVEL.cut);
  }
}

/** The lettering as white on black: the brand and the model line, twice round so one set faces the viewer whichever way the wheel stopped. */
function drawLetters(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  // The texture is wider per pixel than tall on the sidewall: squash the text so it keeps its proportions.
  const squash = 0.62;
  const centre = y(0.2);
  for (const x0 of [0, W / 2]) {
    g.save();
    g.translate(x0 + 40, centre);
    g.scale(squash, 1);
    const px = fitFont(g, TIRE_BRAND.brand, 800, 84, (s) => `italic 900 ${s}px 'Google Sans Flex', system-ui, sans-serif`);
    g.fillText(TIRE_BRAND.brand, 0, 0);
    g.restore();
    g.save();
    g.translate(x0 + 40 + 830 * squash + 60, centre + px * 0.12);
    g.scale(squash, 1);
    fitFont(g, TIRE_BRAND.model, 460, 48, (s) => `italic 700 ${s}px 'Google Sans Flex', system-ui, sans-serif`);
    g.fillText(TIRE_BRAND.model, 0, 0);
    g.restore();
  }
}

/** Draw a variant: height (red), roughness (green) and ink (blue), merged into one RGBA texture. */
function build(lettering: boolean): THREE.Texture {
  const [hc, hg] = canvas(W, H);
  drawHeight(hg);
  let letters: Uint8ClampedArray | null = null;
  if (lettering) {
    const [, lg] = canvas(W, H);
    drawLetters(lg);
    // Printed, not raised: ink only, so the right side's mirrored tread (and its bump) carries no letters.
    letters = lg.getImageData(0, 0, W, H).data;
  }
  const height = hg.getImageData(0, 0, W, H);
  const d = height.data;
  const treadTop = Math.floor(tread(1));
  const treadBottom = Math.ceil(tread(0));
  for (let j = 0; j < H; j++) {
    const inTread = j >= treadTop && j < treadBottom;
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      const h = d[o];
      // Rougher sidewall, a smoother tread, the cuts and sipes dusty again.
      d[o + 1] = inTread ? (h > LEVEL.block - 20 ? 205 : 245) : 255;
      d[o + 2] = letters ? letters[o] : 0;
      d[o + 3] = 255;
    }
  }
  hg.putImageData(height, 0, 0);
  const tex = canvasTex(hc, { srgb: false, repeat: false, anisotropy: 8 });
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

const cache = new Map<boolean, { tex: THREE.Texture; users: number }>();

/**
 * The shared tread texture, plain or lettered, counted for the caller (hand it back with `releaseTireTexture`).
 * Null without a DOM to draw it on (the tire is then plain rubber).
 */
export function acquireTireTexture(lettering: boolean): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  let e = cache.get(lettering);
  if (!e) cache.set(lettering, (e = { tex: build(lettering), users: 0 }));
  e.users++;
  return e.tex;
}

/** Give a texture from `acquireTireTexture` back; the last user disposes it. */
export function releaseTireTexture(tex: THREE.Texture | null): void {
  if (!tex) return;
  for (const [key, e] of cache) {
    if (e.tex !== tex) continue;
    if (--e.users <= 0) {
      e.tex.dispose();
      cache.delete(key);
    }
    return;
  }
}

/**
 * The tire material's shader tweaks (chained after the wheel clip's), at every quality: the tire is drawn
 * both sides and its inside is flat dark rubber, so where the arch clip cuts a lowered tire at the fender
 * the cut reads as a solid section instead of a hole into the hollow tire and the wheel behind it. With
 * the tread texture (medium and up), the lettering's ink replaces the map's colour and the cuts and
 * grooves shade it darker. The right side's holder is mirrored (a negative
 * determinant), and the tread is left mirrored with it, so both sides' shoulder cuts slant the same way
 * against the direction of travel and the car reads symmetric. Only the lettering is read with u flipped
 * there, so it reads true from outside on both sides; the letters are ink only, with no relief in the
 * bump that would show mirrored.
 */
export function tireShader(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vTireMirror;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vTireMirror = determinant(mat3(modelMatrix)) < 0.0 ? 1.0 : 0.0;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vTireMirror;')
    .replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
  vec4 tread = texture2D(map, vMapUv);
  float ink = vTireMirror > 0.5 ? texture2D(map, vec2(1.0 - vMapUv.x, vMapUv.y)).b : tread.b;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${TIRE_INK.toFixed(2)}), ink) * (0.45 + 0.55 * smoothstep(0.12, 0.5, tread.r));
#endif`,
    )
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n  if (!gl_FrontFacing) gl_FragColor.rgb = vec3(${TIRE_CUT.toFixed(3)});`);
}
