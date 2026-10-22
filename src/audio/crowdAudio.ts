/**
 * The crowd recordings (public/sfx, loaded lazily and decoded once per app,
 * made seamless and levelled to a target loudness): the looped cheering bed
 * a crowd stand plays, and the clips Sfx (sfx.ts) fires as one-shots when
 * the player crosses the line.
 */
import { rnd } from './sfxRecipes';
import type { SfxPos } from './sfx';

/** Crowd clips in public/sfx (freesound_community, see the credits screen). */
const CROWD_FILES = { cheer: 'sfx/crowd-cheering.mp3', applause: 'sfx/applause.mp3' } as const;
export type CrowdClip = keyof typeof CROWD_FILES;
const clipCache = new Map<CrowdClip, Promise<AudioBuffer | null>>();

/**
 * Bake a seamless loop: the last `fade` seconds are cross faded (equal power)
 * into the head, and the result is that much shorter, so looping never clicks.
 */
function seamless(ctx: BaseAudioContext, buf: AudioBuffer, fade: number): AudioBuffer {
  const f = Math.min(Math.floor(fade * buf.sampleRate), Math.floor(buf.length / 3));
  const len = buf.length - f;
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, len));
    for (let i = 0; i < f; i++) {
      const k = i / f;
      dst[i] = src[i] * Math.sqrt(k) + src[len + i] * Math.sqrt(1 - k);
    }
  }
  return out;
}

/** Fetch and decode a crowd clip once per app (shared by every race); null if it cannot load. */
export function loadClip(ctx: AudioContext, name: CrowdClip): Promise<AudioBuffer | null> {
  let p = clipCache.get(name);
  if (!p) {
    const base = import.meta.env?.BASE_URL ?? '/';
    p = fetch(`${base}${CROWD_FILES[name]}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => loudEnough(ctx, buf, CROWD_TARGET_DB[name], name === 'cheer'))
      .then((buf) => (name === 'cheer' ? seamless(ctx, buf, 1.2) : buf))
      .catch(() => null);
    clipCache.set(name, p);
  }
  return p;
}

/**
 * The recordings are quiet (cheer about -28 dB RMS, applause -32 dB with -3 dB
 * clap peaks), so on decode each is brought up to a target RMS (dB) and its
 * peaks rounded off by a soft limiter instead of clipping. The cheer is the
 * stands' bed, but the recording is a swell that dies away (-24 dB for its
 * first 4 s, -32 to -38 for the last 6), so a loop wandered 15 dB with where
 * it was and spent half its time buried under an idling engine: it is ridden
 * to its target in CROWD_RIDE windows instead, at the level of its loudest stretch.
 */
const CROWD_TARGET_DB: Record<CrowdClip, number> = { cheer: -13, applause: -19 };
/** The cheer's level ride: RMS window (s, gain updated every quarter window) and the most it lifts a quiet stretch. */
const CROWD_RIDE = { window: 0.8, maxGain: 30 } as const;
/** Crowd mix on top of that: stand loops and the cheer / applause one-shots. */
const CROWD_LOOP_GAIN = 0.8;
export const CROWD_SHOT_GAIN = 1.2;

/**
 * A copy of `buf` at the target RMS, peaks soft limited (tanh) below full
 * scale: one gain for the whole clip, or with `ride` a gain per CROWD_RIDE
 * window (interpolated between them) so every stretch sits at the target.
 */
function loudEnough(ctx: AudioContext, buf: AudioBuffer, targetDb: number, ride: boolean): AudioBuffer {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, ch) => buf.getChannelData(ch));
  const rms = (a: number, b: number) => {
    let e = 0;
    for (const d of chans) for (let i = a; i < b; i++) e += d[i] * d[i];
    return Math.sqrt(e / Math.max(1, (b - a) * chans.length));
  };
  const target = 10 ** (targetDb / 20);
  const gains: number[] = [];
  let hop = buf.length;
  if (ride) {
    const w = Math.max(4, Math.floor(CROWD_RIDE.window * buf.sampleRate));
    const half = Math.floor(w / 2);
    hop = Math.floor(w / 4);
    for (let c = 0; c < buf.length; c += hop) gains.push(Math.min(CROWD_RIDE.maxGain, target / Math.max(1e-6, rms(Math.max(0, c - half), Math.min(buf.length, c + half)))));
  } else {
    const r = rms(0, buf.length);
    if (r < 1e-6) return buf;
    gains.push(Math.min(30, target / r));
    if (gains[0] <= 1) return buf;
  }
  const last = gains.length - 1;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  // Linear up to the knee, then tanh rounds the peaks off toward 0.98.
  const knee = 0.6;
  const room = 0.98 - knee;
  for (let ch = 0; ch < chans.length; ch++) {
    const src = chans[ch];
    const dst = out.getChannelData(ch);
    for (let i = 0; i < src.length; i++) {
      const f = i / hop;
      const k = Math.min(last, Math.floor(f));
      const g = gains[k] + (gains[Math.min(last, k + 1)] - gains[k]) * (f - k);
      const x = src[i] * g;
      const a = Math.abs(x);
      dst[i] = a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
    }
  }
  return out;
}

/** A crowd stand (segment) and its excitement, as the crowd renderer reports it each frame. */
export interface SfxCrowdSpot {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 0 idle murmur, 1 cheering, up to ~1.5 at the finish. */
  level: number;
  /** Sections (closures, corners) only play while the listener is close; gates from further away. */
  kind?: 'gate' | 'section';
}

/** Crowd loops start above this proximity and stop below the second (gates, sections). */
export const CROWD_ON = { gate: 0.02, section: 0.06 };
export const CROWD_OFF = { gate: 0.01, section: 0.03 };
/** At most this many crowd loops play at once. */
export const MAX_CROWD_LOOPS = 8;

/** Crowds are loud: their loudness falls off over a longer distance than impacts (m). */
export const CROWD_REF = 40;

/** The looped cheering bed of one stand, filtered and attenuated by distance. */
export class CrowdLoop {
  private readonly src: AudioBufferSourceNode;
  private readonly lp: BiquadFilterNode;
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
    buf: AudioBuffer,
  ) {
    this.src = ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = true;
    this.src.playbackRate.value = rnd(0.94, 1.04);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 1200;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.src.connect(this.lp).connect(this.out).connect(this.panner).connect(bus);
    // Different stands start at different points of the loop so they never phase.
    this.src.start(ctx.currentTime, Math.random() * buf.duration);
  }

  update(level: number, pos: SfxPos, paused: boolean): void {
    const t = this.ctx.currentTime;
    const l = Math.max(0, Math.min(1.6, level));
    const gain = paused ? 0 : pos.proximity * CROWD_LOOP_GAIN * (0.12 + 0.42 * l ** 1.2);
    // Murmur sounds distant and muffled; cheering opens up the top end.
    this.lp.frequency.setTargetAtTime(700 + 15000 * pos.proximity ** 1.2 * (0.35 + 0.65 * Math.min(1, l)), t, 0.25);
    this.out.gain.setTargetAtTime(gain, t, paused ? 0.08 : 0.3);
    this.panner.pan.setTargetAtTime(pos.pan, t, 0.1);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.08);
    this.src.stop(t + 0.5);
    setTimeout(() => this.panner.disconnect(), 700);
  }
}
