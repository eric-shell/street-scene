/**
 * Warning bell for timed gates (the level crossings', render/districts/bluff.ts):
 * the electric "ding ding ding" of a
 * crossing gong. One strike is rendered offline into a short buffer (a few
 * inharmonic bell partials with exponential decays plus a click of hammer
 * noise) whose length is the strike interval, then looped, so ringing costs
 * one buffer source, a gain and a panner. The caller feeds proximity and pan
 * from the camera every frame; like TrainRumble (sceneVoices.ts) the gain dies
 * by itself unless the next frame renews it, so a scene that stops being
 * drawn never keeps ringing. Created only after a user gesture (browser
 * policy). Render side only; the cosmetic noise uses Math.random.
 */
import { audioHub } from './engineAudio';
import { TrainRumble } from './sceneVoices';

/** Bell voice: strike rate (Hz), fundamental (Hz), partial ratios, levels and decays (s), output level. */
const BELL = {
  rate: 2.6,
  f0: 760,
  partials: [1, 2.76, 5.4, 8.93],
  levels: [1, 0.55, 0.28, 0.12],
  decays: [0.24, 0.13, 0.07, 0.04],
  click: 0.35,
  level: 0.42,
} as const;

/** One strike, `1 / BELL.rate` s long: the loop body. */
export function renderBellStrike(sampleRate: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(sampleRate / BELL.rate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let k = 0; k < BELL.partials.length; k++) v += BELL.levels[k] * Math.exp(-t / BELL.decays[k]) * Math.sin(2 * Math.PI * BELL.f0 * BELL.partials[k] * t);
    // Hammer click: a few ms of noise at the strike.
    if (t < 0.004) v += BELL.click * (Math.random() * 2 - 1) * (1 - t / 0.004);
    // Fade the tail into the next strike so the loop seam never clicks.
    const tail = (n - i) / (0.01 * sampleRate);
    out[i] = (v * Math.min(1, tail)) / 2;
  }
  return out;
}

export class WarningBell {
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private src: AudioBufferSourceNode;

  /** True while the browser still waits for the first user gesture. */
  static blocked(): boolean {
    return TrainRumble.blocked();
  }

  static create(): WarningBell | null {
    if (typeof window === 'undefined' || WarningBell.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new WarningBell(h);
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>) {
    const ctx = (this.ctx = h.ctx);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.ambienceBus);
    const data = renderBellStrike(ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data, 0);
    this.src = ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = true;
    this.src.connect(this.out);
    this.src.start();
  }

  /** proximity 0..1 (0 = silent: not ringing or far away), pan -1..1. */
  update(proximity: number, pan: number): void {
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(BELL.level * Math.max(0, Math.min(1, proximity)), now, 0.03);
    // Dead man's switch: silence unless the next frame renews it.
    g.setTargetAtTime(0, now + 0.3, 0.15);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.8, now, 0.08);
  }

  dispose(): void {
    try {
      this.src.stop();
    } catch {
      /* already stopped */
    }
    this.out.disconnect();
  }
}
