/**
 * What chrome on a wheel reflects: one small HDR panorama of a photo studio, built from numbers (no canvas, no
 * renderer), shared by every chrome wheel surface in every scene.
 *
 * Why chrome has its own: a mirror shows only what its environment holds in the reflected direction, and both
 * environments the cars carry are dark stand-ins (the showroom's `studioEnvironment` a 0x0c0c0f room with a few
 * strips, the street's a night panorama). A wide flat lip turned to the viewer (Vossen's stepped lips are half the
 * visible disc) mirrors the black room or road behind the camera over its whole width and read as a black ring
 * merged with the tire (docs/carWheels.md, section 7, Dark chrome lips). Polished wheels are photographed the way
 * chrome reads: a dark floor, a bright horizon band with a hard lower edge (the line that sweeps round a lip as it
 * turns), a dim sky and hot softboxes. Every flat part of a lip then mirrors something definite, bright above the
 * horizon and dark below it, and every curve carries the hard edge between them, so the surface keeps the contrast
 * and the sharp highlights of a mirror instead of being lifted to a flat grey.
 *
 * Equirectangular, linear radiance (1 = white before exposure), half float so the softboxes can be brighter than
 * white; three turns it into a PMREM once per renderer the first time a material draws with it
 * (WebGLEnvironments) and keeps it while the texture lives. 512 x 256 makes a 128 px cube: 1 MB of source and a
 * 384 x 512 half float PMREM target, 1.5 MB, about 2.5 MB of GPU memory in all. Never disposed: one per page.
 */
import * as THREE from 'three';

/** Panorama size (px); the width is 360 degrees, the height 180. */
const W = 512;
const H = 256;

/**
 * The studio, in radians of elevation (0 the horizon, positive up) and azimuth, and linear radiance. `ground` runs
 * from the nadir to the horizon, `band` is the horizon strip (its lower edge hard, its upper one fading over `fade`
 * into the sky), `sky` runs from above the band to the zenith, and each softbox is a soft edged rectangle. A cool
 * sky and a neutral floor, so a chrome finish stays colourless.
 */
const STUDIO = {
  ground: { nadir: 0.018, horizon: 0.06 },
  band: { height: 0.1, value: 1.7, fade: 0.32 },
  sky: { low: 0.24, zenith: 0.07, tint: [0.92, 0.96, 1.0] },
  /** Azimuth centre and width, elevation from and to (rad), radiance. */
  boxes: [
    { az: 0.0, w: 0.55, lo: 0.3, hi: 0.85, value: 6 },
    { az: 1.6, w: 0.45, lo: 0.25, hi: 0.7, value: 4.5 },
    { az: 3.14, w: 0.7, lo: 0.35, hi: 0.9, value: 5 },
    { az: -1.7, w: 0.4, lo: 0.2, hi: 0.75, value: 4 },
    { az: 0.8, w: 2.4, lo: 1.12, hi: 1.22, value: 3.5 },
    { az: -2.3, w: 2.4, lo: 1.12, hi: 1.22, value: 3.5 },
  ],
  /** Width of a softbox's soft edge (rad). */
  edge: 0.025,
} as const;

let shared: THREE.DataTexture | null = null;

/** Smooth 0..1 across [a, b]. */
const ramp = (x: number, a: number, b: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The shared chrome panorama (built on first use). */
export function chromeEnvironment(): THREE.DataTexture {
  if (shared) return shared;
  const data = new Uint16Array(W * H * 4);
  const { ground, band, sky, boxes, edge } = STUDIO;
  for (let j = 0; j < H; j++) {
    // three's equirect lookup: v = asin(y) / pi + 0.5, and a DataTexture's first row is v = 0 (the nadir).
    const el = ((j + 0.5) / H - 0.5) * Math.PI;
    for (let i = 0; i < W; i++) {
      // u = atan(z, x) / 2pi + 0.5.
      const az = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      let r: number;
      let g: number;
      let b: number;
      if (el < 0) {
        r = g = b = ground.nadir + (ground.horizon - ground.nadir) * (1 - ramp(-el, 0, 0.6));
      } else {
        const s = sky.low + (sky.zenith - sky.low) * ramp(el, band.height, Math.PI / 2);
        const k = el < band.height ? band.value : s + (band.value - s) * (1 - ramp(el, band.height, band.height + band.fade));
        // The band is white; the tint grows into the sky above it.
        const t = ramp(el, band.height, band.height + band.fade);
        r = k * (1 + (sky.tint[0] - 1) * t);
        g = k * (1 + (sky.tint[1] - 1) * t);
        b = k * (1 + (sky.tint[2] - 1) * t);
        for (const box of boxes) {
          let d = Math.abs(az - box.az);
          if (d > Math.PI) d = 2 * Math.PI - d;
          const inside = (1 - ramp(d, box.w / 2 - edge, box.w / 2 + edge)) * ramp(el, box.lo - edge, box.lo + edge) * (1 - ramp(el, box.hi - edge, box.hi + edge));
          if (inside > 0) {
            r += (box.value - r) * inside;
            g += (box.value - g) * inside;
            b += (box.value - b) * inside;
          }
        }
      }
      const o = (j * W + i) * 4;
      data[o] = THREE.DataUtils.toHalfFloat(r);
      data[o + 1] = THREE.DataUtils.toHalfFloat(g);
      data[o + 2] = THREE.DataUtils.toHalfFloat(b);
      data[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  shared = tex;
  return tex;
}
