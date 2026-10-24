/**
 * What every garage canvas shares: a deterministic 0..1 hash noise for speckle
 * and flicker, soft blots (oil, damp, dirt), cracks, and the marker hand the
 * shop writes in. All drawn from a fixed hash, so the room looks the same every
 * visit. Render only.
 */


/** A small deterministic hash noise in 0..1 for texture speckle and flicker. */
export function noise(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** An irregular blot: overlapping soft discs round (x, y), for oil, water and grime. */
export function blot(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number, seed: number): void {
  for (let k = 0; k < 7; k++) {
    const a = noise(seed + k * 1.7) * Math.PI * 2;
    const d = noise(seed + k * 3.1) * r * 0.6;
    const rr = r * (0.35 + noise(seed + k * 5.3) * 0.5);
    const cx = x + Math.cos(a) * d;
    const cy = y + Math.sin(a) * d;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    grad.addColorStop(0, `rgba(${rgb},${alpha})`);
    grad.addColorStop(0.6, `rgba(${rgb},${alpha * 0.6})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, rr, 0, Math.PI * 2);
    g.fill();
  }
}

/** A hairline crack: a jittered walk from (x, y). */
export function crack(g: CanvasRenderingContext2D, x: number, y: number, len: number, seed: number): void {
  g.beginPath();
  g.moveTo(x, y);
  let a = noise(seed) * Math.PI * 2;
  for (let i = 0; i < len; i++) {
    a += (noise(seed + i * 0.91) - 0.5) * 0.9;
    x += Math.cos(a) * 6;
    y += Math.sin(a) * 6;
    g.lineTo(x, y);
  }
  g.stroke();
}

/** Marker on a whiteboard, the shop's hand. */
export const HAND = '"Marker Felt", "Segoe Print", "Comic Sans MS", cursive';
