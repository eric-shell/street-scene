/**
 * The race HUD's two canvas dials: the tachometer, which is also the speedometer (speed is the big number,
 * the gear above it), and the boost gauge a forced induction car wears beside it (the gauge is not built
 * for a naturally aspirated one, hud.ts). Both are arcs, not needles: the lit arc is the reading, a short
 * white bar across the ring marks its head, and the middle of the dial is left to the numbers, so nothing
 * crosses the speed. The nitrous glow rings the tachometer too, so every car shows it burning.
 *
 * Drawing is cheap on purpose. A dial is drawn in fixed logical units onto a backing store that follows its
 * CSS size and the device pixel ratio (crisp at any size), only when something it shows has changed (the
 * needle's half degree, the speed, the gear, the glow, the shift flash), with no shadow blurs (a wide, faint
 * stroke under the real one is the glow) and no per-frame allocation: every color that varies is a table
 * built once. The shift flash blinks on frame time and holds steady under reduced motion.
 */
import { clamp01, TAU } from '../../sim/math';
import { NITRO_STAGE_COLORS, PALETTE, rgb, rgba } from '../kit/palette';

const FONT = '"Google Sans Flex", system-ui, sans-serif';

/** The dials' sweep: 240 degrees from the lower left round the top to the lower right, the bottom left open for text. */
const A0 = (Math.PI * 5) / 6;
const SWEEP = (Math.PI * 4) / 3;

/** Canvas inks, built once (the dials redraw while they change; the minimap has its own in minimap.ts). */
const INK = {
  face: rgba('bg0', 0.8),
  rim: rgba('text', 0.14),
  track: rgba('muted', 0.22),
  tick: rgba('soft', 0.8),
  numeral: PALETTE.soft,
  caption: PALETTE.muted,
  needle: PALETTE.text,
  underlay: 'rgba(0,0,0,0.6)',
  gear: PALETTE.yellow,
  red: PALETTE.red,
  redDim: rgba('red', 0.4),
  redWash: rgba('red', 0.2),
  vacuum: rgba('muted', 0.55),
  orange: PALETTE.orange,
  yellow: PALETTE.yellow,
  text: PALETTE.text,
} as const;

/** The rpm arc runs orange to red as the needle nears the redline: 17 steps, so a frame picks a string and builds none. */
const RAMP_STEPS = 16;
const hexByte = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);
const FILL_RAMP: string[] = [];
const FILL_HALO: string[] = [];
for (let i = 0; i <= RAMP_STEPS; i++) {
  const t = i / RAMP_STEPS;
  const mix = [1, 3, 5].map((at) => Math.round(hexByte(PALETTE.orange, at) + (hexByte(PALETTE.red, at) - hexByte(PALETTE.orange, at)) * t)).join(',');
  FILL_RAMP.push(`rgb(${mix})`);
  FILL_HALO.push(`rgba(${mix},0.2)`);
}

/** The nitrous glow ring in each stage's color at tenths of its strength (and a fainter halo under it). */
const GLOW_STEPS = 10;
const GLOW_RING = NITRO_STAGE_COLORS.map((c) => Array.from({ length: GLOW_STEPS + 1 }, (_, q) => `rgba(${rgb(c)},${((q / GLOW_STEPS) * 0.9).toFixed(2)})`));
const GLOW_HALO = NITRO_STAGE_COLORS.map((c) => Array.from({ length: GLOW_STEPS + 1 }, (_, q) => `rgba(${rgb(c)},${((q / GLOW_STEPS) * 0.22).toFixed(2)})`));

/** The rpm fraction where the arc starts to turn red, where the limiter flash starts and where a manual car is told to shift. */
const WARN_FROM = 0.86;
const WARN_SPAN = 0.12;
const LIMIT_AT = 0.975;
const SHIFT_AT = 0.92;
/** The limiter flash's blinks per second. */
const FLASH_HZ = 7;

/**
 * A square canvas drawn in fixed logical units and kept crisp: its backing store follows its CSS size and the
 * device pixel ratio (a resize observer, so nothing is measured per frame). The dial records what it shows
 * (`see`) and `dirty()` says whether anything changed since the last draw.
 */
class DialCanvas {
  readonly ctx: CanvasRenderingContext2D;
  /** CSS size (px) of the canvas as last laid out; 0 until it is shown. */
  cssSize = 0;
  private scale: number;
  private sig: Float64Array;
  private changed = false;
  private stale = true;
  private readonly observer: ResizeObserver;

  constructor(
    readonly canvas: HTMLCanvasElement,
    /** Side of the drawing space (logical units). */
    readonly size: number,
    values: number,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.scale = canvas.width / size;
    this.sig = new Float64Array(values).fill(NaN);
    this.observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w <= 0) return;
      this.cssSize = w;
      const px = Math.max(1, Math.round(w * Math.min(2, window.devicePixelRatio || 1)));
      if (px !== this.canvas.width) {
        this.canvas.width = px;
        this.canvas.height = px;
      }
      this.scale = px / size;
      this.stale = true;
    });
    this.observer.observe(canvas);
  }

  /** Records one value of what the dial shows; a change means it must be drawn again. */
  see(i: number, v: number): void {
    if (this.sig[i] !== v) {
      this.sig[i] = v;
      this.changed = true;
    }
  }

  /** After every `see`: whether to draw (something changed, or the canvas was cleared by a resize). */
  dirty(): boolean {
    const d = this.changed || this.stale;
    this.changed = false;
    this.stale = false;
    return d;
  }

  /** Clears the canvas and sets the logical coordinate space. */
  begin(): CanvasRenderingContext2D {
    const c = this.ctx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.clearRect(0, 0, this.size, this.size);
    c.lineCap = 'butt';
    return c;
  }

  dispose(): void {
    this.observer.disconnect();
  }
}

/** A stroke from radius r0 to r1 along angle a (the dials' ticks and needle heads). */
function spoke(c: CanvasRenderingContext2D, cx: number, cy: number, a: number, r0: number, r1: number): void {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  c.beginPath();
  c.moveTo(cx + cos * r0, cy + sin * r0);
  c.lineTo(cx + cos * r1, cy + sin * r1);
  c.stroke();
}

/** The bright bar across the ring where the reading is, over a dark underlay so it holds on orange and red alike. */
function head(c: CanvasRenderingContext2D, cx: number, cy: number, a: number, r0: number, r1: number, width: number): void {
  c.strokeStyle = INK.underlay;
  c.lineWidth = width + 3;
  spoke(c, cx, cy, a, r0, r1);
  c.strokeStyle = INK.needle;
  c.lineWidth = width;
  spoke(c, cx, cy, a, r0, r1);
}

/** What the tachometer shows. */
export interface TachReading {
  rpm: number;
  /** Where the limiter and the red arc start (rpm). */
  redline: number;
  speedMph: number;
  /** -1 reverse, 0 neutral, 1.. forward. */
  gear: number;
  manual: boolean;
  /** The two-step's set point, marked on the ring; 0 when off. */
  launchRpm: number;
  /** Nitrous glow strength (0..1) and the stage whose color it wears (1..NITRO_STAGES). */
  glow: number;
  glowStage: number;
}

const TACH = { size: 220, c: 110, r: 92, ring: 9 } as const;

/** The tachometer and speedometer. */
export class Tachometer {
  private readonly dial: DialCanvas;

  constructor(canvas: HTMLCanvasElement) {
    this.dial = new DialCanvas(canvas, TACH.size, 12);
  }

  /** Redraws when something it shows changed. `clock` (s) times the limiter flash; `reduced` holds the flash steady. */
  draw(t: TachReading, clock: number, reduced: boolean): void {
    const d = this.dial;
    const maxRpm = Math.ceil((t.redline + 500) / 1000) * 1000;
    const ratio = t.rpm / Math.max(1, t.redline);
    const warn = Math.round(clamp01((ratio - WARN_FROM) / WARN_SPAN) * RAMP_STEPS);
    const flash = ratio >= LIMIT_AT && (reduced || Math.floor(clock * FLASH_HZ * 2) % 2 === 0);
    const speed = Math.round(t.speedMph);
    const glow = Math.round(clamp01(t.glow) * GLOW_STEPS);
    const shift = t.manual && ratio >= SHIFT_AT;
    d.see(0, Math.round((clamp01(t.rpm / maxRpm) * SWEEP * 720) / TAU)); // the needle, in half degrees
    d.see(1, speed);
    d.see(2, t.gear);
    d.see(3, t.manual ? 1 : 0);
    d.see(4, t.launchRpm);
    d.see(5, t.redline);
    d.see(6, warn);
    d.see(7, flash ? 1 : 0);
    d.see(8, glow);
    d.see(9, t.glowStage);
    d.see(10, shift ? 1 : 0);
    d.see(11, d.cssSize < 170 ? 1 : 0);
    if (!d.dirty()) return;

    const { c: cx, r: R, ring } = TACH;
    const cy = cx;
    const c = d.begin();
    const ang = (rpm: number): number => A0 + SWEEP * clamp01(rpm / maxRpm);
    const aRpm = ang(t.rpm);
    const aRed = ang(t.redline);
    const inRed = t.rpm >= t.redline * 0.995;

    // Face, with the limiter's wash and the nitrous ring outside it.
    c.fillStyle = INK.face;
    c.beginPath();
    c.arc(cx, cy, R + 11, 0, TAU);
    c.fill();
    if (flash) {
      c.fillStyle = INK.redWash;
      c.fill();
    }
    c.lineWidth = 1;
    c.strokeStyle = flash ? INK.red : INK.rim;
    c.stroke();
    if (glow > 0) {
      const stage = Math.max(0, Math.min(GLOW_RING.length - 1, t.glowStage - 1));
      c.lineWidth = 9;
      c.strokeStyle = GLOW_HALO[stage][glow];
      c.beginPath();
      c.arc(cx, cy, R + 12, 0, TAU);
      c.stroke();
      c.lineWidth = 3;
      c.strokeStyle = GLOW_RING[stage][glow];
      c.stroke();
    }

    // Track, the red zone, and the lit arc (a wider faint stroke under it is its glow).
    c.lineWidth = ring;
    c.strokeStyle = INK.track;
    c.beginPath();
    c.arc(cx, cy, R, A0, A0 + SWEEP);
    c.stroke();
    c.strokeStyle = inRed ? INK.red : INK.redDim;
    c.beginPath();
    c.arc(cx, cy, R, aRed, A0 + SWEEP);
    c.stroke();
    if (t.rpm > 1) {
      c.lineWidth = ring + 7;
      c.strokeStyle = FILL_HALO[warn];
      c.beginPath();
      c.arc(cx, cy, R, A0, aRpm);
      c.stroke();
      c.lineWidth = ring;
      c.strokeStyle = FILL_RAMP[warn];
      c.stroke();
    }

    // Ticks every half thousand, numerals every thousand. The small dial (a phone's) drops the half ticks and
    // numbers every other thousand, bigger, so what is left stays legible at its size.
    const compact = d.cssSize < 170;
    c.font = `700 ${compact ? 15 : 13}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k <= maxRpm / 500; k++) {
      const rpm = k * 500;
      const major = k % 2 === 0;
      if (!major && compact) continue;
      const a = ang(rpm);
      c.strokeStyle = rpm >= t.redline ? INK.red : INK.tick;
      c.lineWidth = major ? 2.5 : 1.5;
      spoke(c, cx, cy, a, R - (major ? 15 : 11), R - 6);
      if (major && (!compact || k % 4 === 0)) {
        c.fillStyle = rpm >= t.redline ? INK.red : INK.numeral;
        c.fillText(String(rpm / 1000), cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
      }
    }
    // The launch rpm: a yellow notch where the two-step holds the needle at the line.
    if (t.launchRpm > 0) {
      c.strokeStyle = INK.yellow;
      c.lineWidth = 3;
      spoke(c, cx, cy, ang(t.launchRpm), R - 15, R + 7);
    }
    head(c, cx, cy, aRpm, R - 18, R + 7, 3.5);

    // The middle: gear over speed over its unit, and what a manual driver needs to hear.
    c.fillStyle = flash || warn >= 14 ? INK.red : INK.gear;
    c.font = `900 ${compact ? 26 : 30}px ${FONT}`;
    c.fillText(t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : String(t.gear), cx, cy - (compact ? 41 : 46));
    c.fillStyle = INK.text;
    c.font = `900 56px ${FONT}`;
    c.fillText(String(speed), cx, cy + 6);
    c.fillStyle = INK.caption;
    c.font = `700 13px ${FONT}`;
    c.fillText('MPH', cx, cy + 40);
    if (t.manual) {
      c.fillStyle = shift ? INK.red : INK.caption;
      c.font = `800 12px ${FONT}`;
      c.fillText(shift ? 'SHIFT' : 'MANUAL', cx, cy + 59);
    }
  }

  dispose(): void {
    this.dial.dispose();
  }
}

/** What the boost gauge shows. */
export interface BoostReading {
  /** Pressure (bar, negative = vacuum). */
  bar: number;
  /** Nitrous glow strength (0..1) and the stage whose color it wears. */
  glow: number;
  glowStage: number;
  /** Rolling antilag is holding the boost, or the blow-off valve just dumped it (the caption says so). */
  antilag: boolean;
  blowOff: boolean;
}

const BOOST = { size: 120, c: 60, r: 46, ring: 7, lo: -1, hi: 2, redFrom: 1.6 } as const;

/** The boost gauge: vacuum dim on the left of the zero mark, pressure lit to the right of it, red beyond 1.6 bar. */
export class BoostGauge {
  private readonly dial: DialCanvas;

  constructor(canvas: HTMLCanvasElement) {
    this.dial = new DialCanvas(canvas, BOOST.size, 6);
  }

  draw(b: BoostReading): void {
    const d = this.dial;
    const glow = Math.round(clamp01(b.glow) * GLOW_STEPS);
    const bar = Math.abs(b.bar) < 0.05 ? 0 : b.bar;
    d.see(0, Math.round(bar * 250)); // the head and the readout, in 0.004 bar
    d.see(1, glow);
    d.see(2, b.glowStage);
    d.see(3, b.antilag ? 1 : 0);
    d.see(4, b.blowOff ? 1 : 0);
    d.see(5, d.cssSize < 100 ? 1 : 0);
    if (!d.dirty()) return;

    const { c: cx, r: R, ring, lo, hi, redFrom } = BOOST;
    const cy = cx;
    const c = d.begin();
    const ang = (v: number): number => A0 + SWEEP * clamp01((v - lo) / (hi - lo));
    const v = Math.max(lo, Math.min(hi, bar));
    const lit = glow > 0;

    c.fillStyle = INK.face;
    c.beginPath();
    c.arc(cx, cy, R + 9, 0, TAU);
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = INK.rim;
    c.stroke();
    if (lit) {
      const stage = Math.max(0, Math.min(GLOW_RING.length - 1, b.glowStage - 1));
      c.lineWidth = 7;
      c.strokeStyle = GLOW_HALO[stage][glow];
      c.beginPath();
      c.arc(cx, cy, R + 10, 0, TAU);
      c.stroke();
      c.lineWidth = 2.5;
      c.strokeStyle = GLOW_RING[stage][glow];
      c.stroke();
    }

    // Track with the overboost zone, then vacuum (dim) or pressure (lit) from the zero mark to the head.
    c.lineWidth = ring;
    c.strokeStyle = INK.track;
    c.beginPath();
    c.arc(cx, cy, R, A0, A0 + SWEEP);
    c.stroke();
    c.strokeStyle = INK.redDim;
    c.beginPath();
    c.arc(cx, cy, R, ang(redFrom), A0 + SWEEP);
    c.stroke();
    if (v > 0.02) {
      const cut = Math.min(v, redFrom);
      c.lineWidth = ring + 5;
      c.strokeStyle = FILL_HALO[0];
      c.beginPath();
      c.arc(cx, cy, R, ang(0), ang(cut));
      c.stroke();
      c.lineWidth = ring;
      c.strokeStyle = lit ? INK.text : INK.orange;
      c.stroke();
      if (v > redFrom) {
        c.strokeStyle = INK.red;
        c.beginPath();
        c.arc(cx, cy, R, ang(redFrom), ang(v));
        c.stroke();
      }
    } else if (v < -0.02) {
      c.strokeStyle = INK.vacuum;
      c.beginPath();
      c.arc(cx, cy, R, ang(v), ang(0));
      c.stroke();
    }

    // Ticks every half bar, numerals on the whole ones (the small gauge keeps the whole ticks only); the zero mark is the longest.
    const compact = d.cssSize < 100;
    c.font = `700 10px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = lo * 2; k <= hi * 2; k++) {
      const a = ang(k / 2);
      const major = k % 2 === 0;
      if (!major && compact) continue;
      c.strokeStyle = k === 0 ? INK.needle : INK.tick;
      c.lineWidth = k === 0 ? 2.5 : major ? 2 : 1.2;
      spoke(c, cx, cy, a, R - (k === 0 ? 13 : major ? 11 : 8), R - 5);
      if (major && !compact) {
        c.fillStyle = INK.numeral;
        c.fillText(String(k / 2), cx + Math.cos(a) * (R - 20), cy + Math.sin(a) * (R - 20));
      }
    }
    head(c, cx, cy, ang(v), R - 13, R + 6, 3);

    // The reading, and what the valve or the antilag is doing.
    c.fillStyle = v > redFrom ? INK.red : lit ? INK.text : v > 0.02 ? INK.orange : INK.caption;
    c.font = `900 24px ${FONT}`;
    c.fillText((bar > 0 ? '+' : '') + bar.toFixed(1), cx, cy + 2);
    c.fillStyle = b.antilag ? INK.yellow : INK.caption;
    c.font = `800 ${compact ? 12 : 10.5}px ${FONT}`;
    c.fillText(b.antilag ? 'ANTILAG' : b.blowOff ? 'BLOW OFF' : 'BOOST BAR', cx, cy + 26);
  }

  dispose(): void {
    this.dial.dispose();
  }
}
