/**
 * The textures the room redraws or lays under its light: the wash of light
 * down a wall, the dyno screen (redrawn as it runs), the soft glow sprite and
 * the contact shadow. Render only.
 */
import * as THREE from 'three';
import { canvas, drawTexture } from '../../render/textures/canvasKit';
import { PALETTE } from '../../ui/kit/palette';

/** Light washing down a wall from a strip over it: white at the top edge fading to nothing, soft at the sides. */
export function washTexture(): THREE.CanvasTexture {
  return drawTexture(
    64,
    128,
    (g) => {
      const v = g.createLinearGradient(0, 0, 0, 128);
      v.addColorStop(0, 'rgba(255,255,255,1)');
      v.addColorStop(0.25, 'rgba(255,255,255,0.45)');
      v.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = v;
      g.fillRect(0, 0, 64, 128);
      g.globalCompositeOperation = 'destination-in';
      const h = g.createLinearGradient(0, 0, 64, 0);
      h.addColorStop(0, 'rgba(0,0,0,0)');
      h.addColorStop(0.15, 'rgba(0,0,0,1)');
      h.addColorStop(0.85, 'rgba(0,0,0,1)');
      h.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = h;
      g.fillRect(0, 0, 64, 128);
    },
    { repeat: false },
  );
}

/** A pull's peak figures as the screen shows them: power (hp) and torque (lb-ft) and the rpm each peaks at. */
export interface DynoPeaks {
  hp: number;
  lbft: number;
  hpRpm: number;
  lbftRpm: number;
}

/** Where a pull stands: waiting for the gas, climbing the revs, or finished with its figures called out. */
export type DynoState = 'ready' | 'pull' | 'done';

/**
 * A run the screen draws: the player's car on the dyno or the customer's
 * (garage/dynoSession.ts keeps it up to date; the screen only reads). The
 * curves are shares of the build's rated peaks over the rpm axis (0 = idle,
 * 1 = redline) as this pull measured them, so a hot or unlucky pull sits a
 * little under 1 and the plot shows it. They are drawn up to `progress`, the
 * furthest rpm the pull has reached.
 */
export interface DynoRun {
  state: DynoState;
  /** How far along the rpm axis the curves are drawn (0..1); the pull is done at 1. */
  progress: number;
  /** Power and torque at a point on the rpm axis, each as a share of the build's rated peak (about 1 at the top). */
  power: (x: number) => number;
  torque: (x: number) => number;
  /** The previous pull's curves ghosted behind this one (null before the second pull), and how far that pull got (0..1). */
  ghostPower: ((x: number) => number) | null;
  ghostTorque: ((x: number) => number) | null;
  ghostProgress: number;
  /** The build's rated peaks (hp, lb-ft, rpm): what the shares scale to. */
  rated: DynoPeaks;
  /** This pull's measured peaks so far (the peak-hold marker), final once the state is 'done'. */
  peaks: DynoPeaks;
  /** The engine's rpm now, and the range the x axis spans. */
  rpm: number;
  rpmIdle: number;
  rpmRedline: number;
  /** The pull's number on this car, and how long ago it finished (s; 0 until it has). */
  runNo: number;
  doneFor: number;
  /** Heat soak, 0 (cold) to 1 (soaked), and the intake temperature it reads as (deg F). */
  heat: number;
  iatF: number;
  /** The heading, e.g. the car and the pull's number. */
  title?: string;
}

/** The screen's canvas is this many pixels per unit of its 256 x 144 layout (the layout below stays in those units). */
const SCREEN = { w: 256, h: 144, scale: 1.5 } as const;
/** The plot area (layout units): left, right, top and baseline; the panel of readouts starts at `panel`. */
const PLOT = { x0: 28, x1: 162, top: 24, base: 110, panel: 178, right: 250 } as const;
/** The y axis runs this far past the rated peak so a lucky pull's curve never clips the top. */
const HEADROOM = 1.08;
/** Samples a curve is drawn with, and the rev bar's segments. */
const STEPS = 48;
const SEGMENTS = 30;
/** A sweep of the scan line across the idle plot (cycles per second), and the ready text's blink (Hz). */
const SWEEP_HZ = 0.35;
const BLINK_HZ = 1.1;
/** The peak call-out stays up this long after a pull (s) and fades in over the first fraction of it. */
const CALLOUT_S = 7;

const FONT = (weight: number, px: number) => `${weight} ${px}px "Google Sans Flex", system-ui, sans-serif`;
const F = { tiny: FONT(600, 6.5), small: FONT(700, 8), label: FONT(700, 7), mid: FONT(800, 11), big: FONT(800, 21), call: FONT(800, 8.5), ready: FONT(800, 17) } as const;
const C = {
  bg: '#05080c',
  grid: 'rgba(120,220,232,0.12)',
  frame: 'rgba(120,220,232,0.28)',
  unlit: 'rgba(255,255,255,0.07)',
  text: '#e9e7e0',
  dim: 'rgba(233,231,224,0.45)',
  orangeGhost: 'rgba(252,152,103,0.3)',
  cyanGhost: 'rgba(120,220,232,0.3)',
  orangeGlow: 'rgba(252,152,103,0.22)',
  cyanGlow: 'rgba(120,220,232,0.2)',
} as const;

/** The thousands separator, as US readouts have it (6,400). */
const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * The dyno screen on the wall: a run drawn as it happens on a small canvas.
 * Power and torque draw live as the revs sweep, with big readouts ticking up,
 * a peak-hold marker, the previous pull ghosted behind, a rev bar, the intake
 * temperature with a heat soak warning, and at the end a PEAK call-out; between
 * pulls it idles on a scan line and a blinking READY. The run is always a real
 * one (the player's, or the customer's pull on the shop's schedule), and `t` (s)
 * only times the blink. `draw` repaints one canvas texture (384 x 216, the layout
 * stays 256 x 144); the showroom calls it every frame during a live pull and
 * a few times a second otherwise, so the upload is small and only paid when
 * something moves. The static layer (grid, frames) is drawn once and blitted.
 */
export function dynoScreen(): { texture: THREE.CanvasTexture; draw: (t: number, run: DynoRun) => void } {
  const { w: W, h: H, scale: S } = SCREEN;
  const { x0, x1, top, base } = PLOT;
  const [c, g] = canvas(W * S, H * S);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  // The static layer: background, grid, the frames round the plot, the readouts and the rev bar.
  const [layer, k] = canvas(W * S, H * S);
  k.scale(S, S);
  k.fillStyle = C.bg;
  k.fillRect(0, 0, W, H);
  k.lineWidth = 0.6;
  k.strokeStyle = C.grid;
  for (let i = 0; i <= 8; i++) {
    const x = x0 + ((x1 - x0) * i) / 8;
    k.beginPath();
    k.moveTo(x, top);
    k.lineTo(x, base);
    k.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const y = base - ((base - top) * i) / 4;
    k.beginPath();
    k.moveTo(x0, y);
    k.lineTo(x1, y);
    k.stroke();
  }
  k.strokeStyle = C.frame;
  k.lineWidth = 0.8;
  k.strokeRect(x0, top, x1 - x0, base - top);
  k.strokeRect(PLOT.panel - 0.5, top, PLOT.right - PLOT.panel + 1, base - top);
  for (const y of [top + 29, top + 58]) {
    k.beginPath();
    k.moveTo(PLOT.panel - 0.5, y);
    k.lineTo(PLOT.right + 0.5, y);
    k.stroke();
  }
  k.beginPath();
  k.moveTo(0, 17);
  k.lineTo(W, 17);
  k.stroke();
  k.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < H; y += 3) k.fillRect(0, y, W, 1);

  const px = (x: number) => x0 + x * (x1 - x0);
  const py = (share: number) => base - (share / HEADROOM) * (base - top);

  /** One curve from idle up to `upTo` (0..1) of the rpm axis. */
  const trace = (f: (x: number) => number, upTo: number): void => {
    const n = Math.max(1, Math.ceil(STEPS * upTo));
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const x = Math.min(upTo, i / STEPS);
      if (i === 0) g.moveTo(px(x), py(f(x)));
      else g.lineTo(px(x), py(f(x)));
    }
  };
  const stroke = (f: (x: number) => number, upTo: number, color: string, glow: string | null, width: number): void => {
    if (upTo <= 0) return;
    g.setLineDash([]);
    g.lineJoin = 'round';
    if (glow) {
      trace(f, upTo);
      g.strokeStyle = glow;
      g.lineWidth = width * 3;
      g.stroke();
    }
    trace(f, upTo);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  };
  const ghost = (f: (x: number) => number, upTo: number, color: string): void => {
    if (upTo <= 0) return;
    trace(f, upTo);
    g.setLineDash([2.5, 2.5]);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
  };
  const dot = (x: number, y: number, color: string, glow: string): void => {
    g.fillStyle = glow;
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 2.4, 0, Math.PI * 2);
    g.fill();
  };
  /** A peak-hold marker: a diamond on the curve at its top and a dashed line back to the axis. */
  const hold = (x: number, y: number, color: string, alpha: number): void => {
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = 0.6;
    g.setLineDash([1.5, 2]);
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x, y);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y - 3.4);
    g.lineTo(x + 3.4, y);
    g.lineTo(x, y + 3.4);
    g.lineTo(x - 3.4, y);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
  };

  const heatColor = (h: number) => (h < 0.3 ? '#a9dc76' : h < 0.6 ? '#ffd866' : '#ff6188');
  const revColor = (f: number) => (f < 0.6 ? '#a9dc76' : f < 0.85 ? '#ffd866' : '#ff6188');

  const draw = (t: number, r: DynoRun): void => {
    const span = Math.max(1, r.rpmRedline - r.rpmIdle);
    const p = r.progress;
    const blink = Math.floor(t * BLINK_HZ * 2) % 2 === 0;
    g.setTransform(S, 0, 0, S, 0, 0);
    g.drawImage(layer, 0, 0, W, H);
    g.textBaseline = 'alphabetic';

    // Axes: hp down the left (orange), lb-ft down the right (cyan), the revs in thousands underneath.
    g.font = F.tiny;
    for (let i = 1; i <= 4; i++) {
      const y = base - ((base - top) * i) / 4;
      g.textAlign = 'right';
      g.fillStyle = PALETTE.orange;
      g.fillText(String(Math.round((r.rated.hp * HEADROOM * i) / 4 / 5) * 5), x0 - 2.5, y + 2);
      g.textAlign = 'left';
      g.fillStyle = PALETTE.cyan;
      g.fillText(String(Math.round((r.rated.lbft * HEADROOM * i) / 4 / 5) * 5), x1 + 2.5, y + 2);
    }
    g.textAlign = 'center';
    g.fillStyle = C.dim;
    for (let rpm = Math.ceil(r.rpmIdle / 1000) * 1000; rpm <= r.rpmRedline; rpm += 1000) g.fillText(String(rpm / 1000), px((rpm - r.rpmIdle) / span), base + 8);
    g.textAlign = 'right';
    g.fillText('RPM', x0 - 2.5, base + 8);
    g.textAlign = 'left';
    g.fillText('x1000', x1 + 2.5, base + 8);

    // Header: the car and the run, and where the pull stands.
    g.fillStyle = C.text;
    g.font = F.small;
    g.fillText(r.title ?? 'DYNO', 6, 12, 150);
    g.textAlign = 'right';
    const badge = r.state === 'pull' ? 'PULLING' : r.state === 'done' ? 'COMPLETE' : 'READY';
    const badgeColor = r.state === 'pull' ? PALETTE.orange : r.state === 'done' ? PALETTE.cyan : PALETTE.green;
    g.fillStyle = badgeColor;
    g.fillText(badge, PLOT.right, 12);
    const bw = g.measureText(badge).width;
    g.globalAlpha = r.state === 'ready' && !blink ? 0.25 : 1;
    g.beginPath();
    g.arc(PLOT.right - bw - 6, 9.2, 2.2, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;

    // The previous pull ghosted behind this one.
    if (r.ghostPower && r.ghostTorque) {
      ghost(r.ghostPower, r.ghostProgress, C.orangeGhost);
      ghost(r.ghostTorque, r.ghostProgress, C.cyanGhost);
    }

    // The live curves, and the head of the pull: a cursor and a dot on each.
    stroke(r.torque, p, PALETTE.cyan, C.cyanGlow, 1.5);
    stroke(r.power, p, PALETTE.orange, C.orangeGlow, 1.7);
    if (r.state === 'pull') {
      g.strokeStyle = 'rgba(233,231,224,0.28)';
      g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(px(p), top);
      g.lineTo(px(p), base);
      g.stroke();
      dot(px(p), py(r.torque(p)), PALETTE.cyan, C.cyanGlow);
      dot(px(p), py(r.power(p)), PALETTE.orange, C.orangeGlow);
    }
    // The peak-hold markers: where the pull's best sits so far (final when it is done).
    if (p > 0.06) {
      hold(px((r.peaks.hpRpm - r.rpmIdle) / span), py(r.peaks.hp / r.rated.hp), PALETTE.orange, 0.9);
      hold(px((r.peaks.lbftRpm - r.rpmIdle) / span), py(r.peaks.lbft / r.rated.lbft), PALETTE.cyan, 0.9);
    }

    // Between pulls: a scan line sweeping the empty plot and a blinking READY.
    if (r.state === 'ready') {
      const sx = px((t * SWEEP_HZ) % 1);
      const sweep = g.createLinearGradient(sx - 22, 0, sx, 0);
      sweep.addColorStop(0, 'rgba(120,220,232,0)');
      sweep.addColorStop(1, 'rgba(120,220,232,0.22)');
      g.fillStyle = sweep;
      g.fillRect(Math.max(x0, sx - 22), top, Math.min(22, sx - x0), base - top);
      g.fillStyle = 'rgba(120,220,232,0.7)';
      g.fillRect(sx - 0.5, top, 1, base - top);
      g.textAlign = 'center';
      g.globalAlpha = blink ? 1 : 0.2;
      g.fillStyle = PALETTE.green;
      g.font = F.ready;
      g.fillText('READY', (x0 + x1) / 2, (top + base) / 2 + 3);
      g.globalAlpha = 1;
      g.font = F.label;
      g.fillStyle = C.dim;
      g.fillText('HOLD THE GAS FOR A PULL', (x0 + x1) / 2, (top + base) / 2 + 14);
    }

    // The call-out once a pull is in: the peaks, fading in, steady for a few seconds.
    if (r.state === 'done' && r.doneFor < CALLOUT_S) {
      const a = Math.min(1, r.doneFor * 3) * Math.min(1, (CALLOUT_S - r.doneFor) * 2);
      const bx = x1 - 100;
      const by = base - 33;
      g.globalAlpha = a * 0.88;
      g.fillStyle = '#05080c';
      g.fillRect(bx, by, 96, 29);
      g.globalAlpha = a * (0.55 + 0.45 * Math.sin(t * 5));
      g.strokeStyle = PALETTE.orange;
      g.lineWidth = 1;
      g.strokeRect(bx + 0.5, by + 0.5, 95, 28);
      g.globalAlpha = a;
      g.textAlign = 'left';
      g.font = F.call;
      g.fillStyle = PALETTE.orange;
      g.fillText(`PEAK ${Math.round(r.peaks.hp)} HP @ ${thousands(r.peaks.hpRpm)}`, bx + 5, by + 12, 88);
      g.fillStyle = PALETTE.cyan;
      g.fillText(`PEAK ${Math.round(r.peaks.lbft)} LB-FT @ ${thousands(r.peaks.lbftRpm)}`, bx + 5, by + 24, 88);
      g.globalAlpha = 1;
    }

    // The readouts: big digits ticking up with the pull (the pull's peak once it is in).
    const done = r.state === 'done';
    const hp = done ? r.peaks.hp : r.power(p) * r.rated.hp;
    const tq = done ? r.peaks.lbft : r.torque(p) * r.rated.lbft;
    const live2 = r.state !== 'ready';
    g.textAlign = 'left';
    g.font = F.label;
    g.fillStyle = C.dim;
    g.fillText(done ? 'PEAK POWER · HP' : 'POWER · HP', PLOT.panel + 3, top + 8);
    g.fillText(done ? 'PEAK TQ · LB-FT' : 'TORQUE · LB-FT', PLOT.panel + 3, top + 37);
    g.textAlign = 'right';
    g.font = F.big;
    g.fillStyle = live2 ? PALETTE.orange : 'rgba(252,152,103,0.35)';
    g.fillText(live2 ? String(Math.round(hp)) : '0', PLOT.right - 2, top + 26);
    g.fillStyle = live2 ? PALETTE.cyan : 'rgba(120,220,232,0.35)';
    g.fillText(live2 ? String(Math.round(tq)) : '0', PLOT.right - 2, top + 55);
    // The intake: its temperature, and the heat soak warning once the last pulls have left it hot.
    g.textAlign = 'left';
    g.font = F.tiny;
    g.fillStyle = C.dim;
    g.fillText('INTAKE', PLOT.panel + 3, top + 66);
    g.textAlign = 'right';
    if (r.heat > 0.45) {
      g.globalAlpha = blink || r.heat < 0.6 ? 1 : 0.35;
      g.fillStyle = heatColor(r.heat);
      g.fillText('HEAT SOAK', PLOT.right - 2, top + 66);
      g.globalAlpha = 1;
    } else g.fillText('COOL', PLOT.right - 2, top + 66);
    g.textAlign = 'left';
    g.font = F.mid;
    g.fillStyle = heatColor(r.heat);
    g.fillText(`${Math.round(r.iatF)}°F`, PLOT.panel + 3, top + 79);
    g.fillStyle = C.unlit;
    g.fillRect(PLOT.panel + 3, base - 5, PLOT.right - PLOT.panel - 6, 2.5);
    g.fillStyle = heatColor(r.heat);
    g.fillRect(PLOT.panel + 3, base - 5, (PLOT.right - PLOT.panel - 6) * Math.min(1, r.heat), 2.5);

    // The rev bar along the bottom, red at the top, and the rpm.
    const share = Math.max(0, Math.min(1, (r.rpm - r.rpmIdle) / span));
    const barW = 168;
    const segW = barW / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      g.fillStyle = (i + 0.5) / SEGMENTS <= share ? revColor(i / SEGMENTS) : C.unlit;
      g.fillRect(x0 + i * segW, 125, segW - 0.9, 7);
    }
    g.textAlign = 'right';
    g.font = F.small;
    g.fillStyle = C.text;
    g.fillText(`${thousands(r.rpm)} RPM`, PLOT.right, 132);
    g.textAlign = 'left';
    g.font = F.tiny;
    g.fillStyle = C.dim;
    g.fillText(r.state === 'done' ? `RUN ${r.runNo} COMPLETE  ·  LET IT COOL BETWEEN PULLS` : r.state === 'pull' ? `RUN ${r.runNo}` : `RUN ${r.runNo} NEXT`, x0, 141);

    texture.needsUpdate = true;
  };
  return { texture, draw };
}

/** A soft round glow (white, alpha falling off), for light spilling on the wall round a sign or a lamp. */
export function glowTexture(): THREE.CanvasTexture {
  return drawTexture(
    128,
    128,
    (g) => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    },
    { repeat: false },
  );
}

/** The contact shadow: a soft rounded rectangle, darkest under the car's middle. */
export function shadowTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  return drawTexture(
    w,
    h,
    (g) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = Math.abs((x + 0.5) / w - 0.5) * 2;
          const py = Math.abs((y + 0.5) / h - 0.5) * 2;
          const qx = Math.max(px - 0.6, 0);
          const qy = Math.max(py - 0.72, 0);
          const d = Math.hypot(qx / 0.4, qy / 0.28);
          const a = Math.max(0, 1 - d) ** 1.8 * (0.75 + 0.25 * (1 - py));
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
    },
    { srgb: false, repeat: false },
  );
}
