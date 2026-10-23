/**
 * The cracked screen: a hard hit on a cyan barrier cracks the glass the race
 * is seen through, and it stays cracked for the rest of the session. Each
 * crack is a spider web drawn once onto a canvas (rays with branches, broken
 * rings between them, a crushed core) where the contact was on screen; from
 * then on the picture flickers now and then (the screen dimming in short
 * stuttering bursts, the cracked layer jumping a few pixels) and the cracks
 * spit a few sparks. Later hits add cracks up to CRACK.max.
 *
 * Plain DOM over the game canvas, under the HUD (`.screen-crack`,
 * _screen-crack.scss); the session decides when and where (game/session.ts).
 * Costs nothing per frame until the first crack; after it, two custom
 * properties per frame and a small canvas redrawn only while sparks fly.
 * Reduced motion keeps the cracks and drops the flicker and the sparks.
 */
import { prefersReducedMotion } from '../kit/dom';

/** Cracks: how many at most, their reach (fraction of the screen diagonal, at strength 0 and 1), rays per crack. */
export const CRACK = { max: 4, reach: [0.16, 0.42], rays: [7, 12] } as const;

/**
 * The flicker: seconds between bursts (with one crack, and with CRACK.max),
 * how long a burst lasts (s), how often it changes state in a burst (Hz), how
 * dark the screen dips (0..1, kept shallow: a full screen flash is a seizure
 * risk) and how far the cracked layer jumps (px).
 */
const FLICKER = { gap: [[2.6, 6.5], [1.2, 3.2]], burst: [0.14, 0.42], rate: 14, dip: [0.12, 0.3], idle: 0.04, jitter: 3 } as const;

/** Sparks: per crack and per flicker burst (count), speed (px/s at 1080p), life (s), gravity (px/s²). */
const SPARK = { onCrack: [18, 34], onBurst: [3, 8], speed: [140, 520], life: [0.35, 0.9], gravity: 900, cap: 160 } as const;

interface Crack {
  /** Center in CSS px as a fraction of the viewport. */
  u: number;
  v: number;
  strength: number;
  /** Seed of its shape, so a resize redraws the same crack. */
  seed: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

/** Small seeded PRNG (mulberry32): a crack's shape only has to be stable across redraws. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const span = (r: () => number, [a, b]: readonly [number, number]) => a + (b - a) * r();

export class ScreenCrack {
  private readonly el: HTMLDivElement;
  private readonly glass: HTMLCanvasElement;
  private readonly fx: HTMLCanvasElement;
  private readonly cracks: Crack[] = [];
  private readonly sparks: Spark[] = [];
  private readonly calm = prefersReducedMotion();
  private readonly onResize = () => this.redraw();
  /** Seconds to the next flicker burst, and left in the current one. */
  private nextBurst = 0;
  private burstLeft = 0;
  private stepLeft = 0;
  private dip = 0;
  private jx = 0;
  private jy = 0;
  private shown = { dip: -1, jx: NaN, jy: NaN };
  private fxDirty = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'screen-crack';
    this.glass = document.createElement('canvas');
    this.glass.className = 'screen-crack__glass';
    this.fx = document.createElement('canvas');
    this.fx.className = 'screen-crack__sparks';
    const dim = document.createElement('div');
    dim.className = 'screen-crack__dim';
    this.el.append(dim, this.glass, this.fx);
    parent.appendChild(this.el);
  }

  get cracked(): boolean {
    return this.cracks.length > 0;
  }

  /**
   * Crack the screen at (u, v), fractions of the viewport (0, 0 top left),
   * strength 0..1 from how hard the hit was. Past CRACK.max only sparks.
   */
  crack(u: number, v: number, strength: number): void {
    const first = !this.cracks.length;
    if (this.cracks.length < CRACK.max) {
      this.cracks.push({ u, v, strength, seed: (Math.random() * 2 ** 32) >>> 0 });
      if (first) {
        this.el.classList.add('is-cracked');
        window.addEventListener('resize', this.onResize);
        this.nextBurst = 0.35;
      }
      this.redraw();
    }
    this.spray(u, v, Math.round(span(Math.random, SPARK.onCrack) * (0.5 + strength * 0.5)));
  }

  /** Once per rendered frame; dt 0 while paused holds the flicker and the sparks where they are. */
  update(dt: number): void {
    if (!this.cracks.length || dt <= 0 || this.calm) return;
    this.flicker(dt);
    this.stepSparks(dt);
  }

  private flicker(dt: number): void {
    // A new state FLICKER.rate times a second whatever the frame rate.
    this.stepLeft -= dt;
    const step = this.stepLeft <= 0;
    if (step) this.stepLeft = Math.max(0, this.stepLeft + 1 / FLICKER.rate);
    if (this.burstLeft > 0) {
      this.burstLeft -= dt;
      if (this.burstLeft <= 0) {
        this.dip = 0;
        this.jx = this.jy = 0;
      } else if (step) {
        // A stutter: dark or not, and the cracked layer jumping.
        const on = Math.random() < 0.6;
        this.dip = on ? span(Math.random, FLICKER.dip) : FLICKER.idle;
        this.jx = on ? (Math.random() * 2 - 1) * FLICKER.jitter : 0;
        this.jy = on ? (Math.random() * 2 - 1) * FLICKER.jitter * 0.5 : 0;
      }
    } else {
      this.nextBurst -= dt;
      // Between bursts a faint shimmer, so the broken screen never looks quite steady.
      if (step) this.dip = FLICKER.idle * (0.5 + 0.5 * Math.random());
      if (this.nextBurst <= 0) {
        const k = (this.cracks.length - 1) / Math.max(1, CRACK.max - 1);
        const gap: [number, number] = [FLICKER.gap[0][0] + (FLICKER.gap[1][0] - FLICKER.gap[0][0]) * k, FLICKER.gap[0][1] + (FLICKER.gap[1][1] - FLICKER.gap[0][1]) * k];
        this.nextBurst = span(Math.random, gap);
        this.burstLeft = span(Math.random, FLICKER.burst);
        const c = this.cracks[Math.floor(Math.random() * this.cracks.length)];
        this.spray(c.u, c.v, Math.round(span(Math.random, SPARK.onBurst)));
      }
    }
    const dip = Math.round(this.dip * 100) / 100;
    if (dip !== this.shown.dip) {
      this.el.style.setProperty('--crack-dip', String(dip));
      this.shown.dip = dip;
    }
    if (this.jx !== this.shown.jx || this.jy !== this.shown.jy) {
      this.el.style.setProperty('--crack-jitter', `${this.jx.toFixed(1)}px, ${this.jy.toFixed(1)}px`);
      this.shown.jx = this.jx;
      this.shown.jy = this.jy;
    }
  }

  private spray(u: number, v: number, n: number): void {
    if (this.calm) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const scale = H / 1080;
    for (let i = 0; i < n && this.sparks.length < SPARK.cap; i++) {
      // Mostly out and up, as if blown out of the panel.
      const a = Math.random() * Math.PI * 2;
      const s = span(Math.random, SPARK.speed) * scale;
      this.sparks.push({ x: u * W, y: v * H, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 160 * scale, age: 0, life: span(Math.random, SPARK.life) });
    }
  }

  private stepSparks(dt: number): void {
    if (!this.sparks.length && !this.fxDirty) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.fx.width !== Math.round(W * dpr) || this.fx.height !== Math.round(H * dpr)) {
      this.fx.width = Math.round(W * dpr);
      this.fx.height = Math.round(H * dpr);
    }
    const ctx = this.fx.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.fxDirty = this.sparks.length > 0;
    if (!this.fxDirty) return;
    const g = SPARK.gravity * (H / 1080);
    const drag = Math.exp(-1.8 * dt);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    let live = 0;
    for (const s of this.sparks) {
      s.age += dt;
      if (s.age >= s.life) continue;
      s.vx *= drag;
      s.vy = s.vy * drag + g * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const k = 1 - s.age / s.life;
      // A streak along its motion: white hot first, cooling to orange.
      ctx.strokeStyle = `rgba(255, ${Math.round(150 + 105 * k)}, ${Math.round(60 + 160 * k * k)}, ${k.toFixed(2)})`;
      ctx.lineWidth = 1 + 1.6 * k;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
      ctx.stroke();
      this.sparks[live++] = s;
    }
    this.sparks.length = live;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Draw every crack onto the glass canvas at the current viewport size. */
  private redraw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.glass.width = Math.round(W * dpr);
    this.glass.height = Math.round(H * dpr);
    const ctx = this.glass.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const diag = Math.hypot(W, H);
    for (const c of this.cracks) drawCrack(ctx, c.u * W, c.v * H, (CRACK.reach[0] + (CRACK.reach[1] - CRACK.reach[0]) * c.strength) * diag, rng(c.seed));
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }
}

/** A jagged line from (x, y) heading `a` (rad) for `len` px; returns its points. */
function jagged(r: () => number, x: number, y: number, a: number, len: number): [number, number][] {
  const pts: [number, number][] = [[x, y]];
  let d = 0;
  while (d < len) {
    const step = Math.min(len - d, 8 + r() * 26);
    a += (r() - 0.5) * 0.5;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    d += step;
    pts.push([x, y]);
  }
  return pts;
}

/**
 * One spider web crack: each line twice, a dark hairline under a bright edge
 * offset a pixel, so it reads as broken glass over a bright or a dark scene.
 */
function drawCrack(ctx: CanvasRenderingContext2D, cx: number, cy: number, reach: number, r: () => number): void {
  const lines: { pts: [number, number][]; w: number }[] = [];
  const rays = Math.round(span(r, CRACK.rays));
  const rayPts: [number, number][][] = [];
  const a0 = r() * Math.PI * 2;
  for (let i = 0; i < rays; i++) {
    const a = a0 + (i / rays) * Math.PI * 2 + (r() - 0.5) * 0.45;
    const len = reach * (0.35 + 0.65 * r());
    const pts = jagged(r, cx, cy, a, len);
    rayPts.push(pts);
    lines.push({ pts, w: 1.5 });
    // Branches off the outer part of the ray.
    const branches = Math.floor(r() * 3);
    for (let b = 0; b < branches; b++) {
      const at = pts[Math.min(pts.length - 1, 1 + Math.floor(r() * (pts.length - 1)))];
      lines.push({ pts: jagged(r, at[0], at[1], a + (r() < 0.5 ? -1 : 1) * (0.4 + r() * 0.6), len * (0.15 + r() * 0.3)), w: 1 });
    }
  }
  // Broken rings: chords between neighbouring rays at a few radii, some missing.
  const ringAt = (pts: [number, number][], f: number) => pts[Math.min(pts.length - 1, Math.max(1, Math.round(f * (pts.length - 1))))];
  for (const f of [0.18, 0.4, 0.65]) {
    for (let i = 0; i < rays; i++) {
      if (r() < 0.35) continue;
      const p = ringAt(rayPts[i], f + (r() - 0.5) * 0.1);
      const q = ringAt(rayPts[(i + 1) % rays], f + (r() - 0.5) * 0.1);
      const mx = (p[0] + q[0]) / 2 + (r() - 0.5) * 8;
      const my = (p[1] + q[1]) / 2 + (r() - 0.5) * 8;
      lines.push({ pts: [p, [mx, my], q], w: 1 });
    }
  }
  // The crushed core: a frosted blot and short splinters.
  const core = reach * 0.05 + 6;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 2.2);
  glow.addColorStop(0, 'rgba(225, 240, 255, 0.55)');
  glow.addColorStop(0.45, 'rgba(200, 220, 240, 0.2)');
  glow.addColorStop(1, 'rgba(200, 220, 240, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, core * 2.2, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * core;
    lines.push({ pts: jagged(r, cx + Math.cos(a) * d, cy + Math.sin(a) * d, a + (r() - 0.5) * 2, core * (0.4 + r() * 0.8)), w: 0.8 });
  }
  const stroke = (style: string, dx: number, dy: number, widen: number) => {
    ctx.strokeStyle = style;
    for (const l of lines) {
      ctx.lineWidth = l.w * widen;
      ctx.beginPath();
      ctx.moveTo(l.pts[0][0] + dx, l.pts[0][1] + dy);
      for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i][0] + dx, l.pts[i][1] + dy);
      ctx.stroke();
    }
  };
  stroke('rgba(0, 0, 0, 0.55)', 0, 0, 1.8);
  stroke('rgba(235, 245, 255, 0.7)', -0.7, -0.7, 0.8);
}
