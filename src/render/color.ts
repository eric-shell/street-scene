/**
 * Color helpers for render code: the blackbody color of a lamp's temperature, and a #rrggbb color at an
 * alpha as a CSS rgba() string for canvas drawing.
 */

/**
 * Blackbody color for a color temperature in Kelvin (Tanner Helland's fit),
 * as CSS hex. Used for every interior light so windows, doors and arches read
 * as real lamps between 2000 K (sodium warm) and 8000 K (cold daylight).
 */
export function kelvin(k: number): string {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** '#rrggbb' at alpha a as an rgba() string. */
export function hexRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
