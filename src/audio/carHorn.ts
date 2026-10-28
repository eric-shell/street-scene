/**
 * Car horns: the one two-note horn recipe (the city bed's distant honks and the traffic cars that lean on theirs
 * share it) and the traffic horns themselves.
 *  - `playHorn` is the recipe: per beep a gain with a quick attack and a short release into a low pass, fed by
 *    two sawtooth reeds a minor third apart (a horn pair is two notes; one reed sounds like a buzzer).
 *  - `CarHorns` watches the traffic state and honks when a moving traffic car is passed close at speed: a race
 *    car within `HORN.clear` of it (body to body, so side by side counts, a nose to tail does not) with a
 *    velocity difference over `HORN.speed`. The sim has no near miss against a specific car (`detectNearMiss` is
 *    the wall skim), so the rule is made here from the same state a replay replays. Each honk is seeded from the
 *    car and the tick (`deriveSeed`), so a replay hears the same horn at the same moment. A car honks once per
 *    `HORN.cooldown`; taxis twice, buses and trucks an octave-ish lower, police not at all (a siren yelp would
 *    need `playSiren` to take a yelp-only sequence). Struck (loose) traffic never honks.
 * Panned and faded from the car's position, played on the effects bus. Render side only; sim state is read, never written.
 */
import type { RaceState } from '../sim/race';
import type { TrafficCar } from '../sim/traffic';
import { trafficTuning } from '../sim/traffic';
import { TICK_HZ } from '../sim/constants';
import { Rng, deriveSeed } from '../sim/prng';
import { clamp, clamp01, lerp } from '../sim/math';
import { audioHub } from './engineAudio';

/** The horn recipe's reeds: ratio of the second to the first, and each reed's level. */
export const HORN_REEDS = { ratio: 1.26, level: 0.5 } as const;

/** Where a source sits against the listener: the camera's ground position and its right vector. */
export interface Listener {
  x: number;
  z: number;
  rx: number;
  rz: number;
}

/** What `playHorn` needs: the note, the beeps, and the caller's node bookkeeping. */
export interface HornOptions {
  /** Context time of the first beep (s). */
  at: number;
  /** Lower reed (Hz). */
  hz: number;
  /** Beeps, their length and the gap between them (s). */
  beeps: number;
  len: number;
  gap: number;
  /** Upper reed over the lower; the grille's low pass (Hz); peak gain of a beep. */
  ratio?: number;
  lp?: number;
  level?: number;
  /** Start and stop a source (the caller frees its chain at the last end). */
  start: (src: AudioScheduledSourceNode, at: number, end: number) => void;
}

/** Play the beeps into `out`; returns the context time the last one ends. */
export function playHorn(ctx: BaseAudioContext, out: AudioNode, o: HornOptions): number {
  const peak = o.level ?? 1;
  for (let b = 0; b < o.beeps; b++) {
    const at = o.at + b * (o.len + o.gap);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.012);
    g.gain.setValueAtTime(peak, at + o.len);
    g.gain.setTargetAtTime(0, at + o.len, 0.015);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = o.lp ?? 1800;
    g.connect(filt).connect(out);
    for (const m of [1, o.ratio ?? HORN_REEDS.ratio]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = o.hz * m;
      const og = ctx.createGain();
      og.gain.value = HORN_REEDS.level;
      osc.connect(og).connect(g);
      o.start(osc, at, at + o.len + 0.12);
    }
  }
  return o.at + (o.beeps - 1) * (o.len + o.gap) + o.len + 0.12;
}

/** The traffic horns' constants. */
export const HORN = {
  /** Body-to-body clearance (m) and velocity difference (m/s) that make a close call. */
  clear: 1.5,
  speed: 8,
  /** Only cars within this range of the camera are looked at (m), and a car honks again after this long (s). */
  range: 90,
  cooldown: 4,
  /** The honk starts this long after the call (s). */
  delay: [0.05, 0.18],
  /** Level at the car and the distance (m) it falls to half at; set against the city bed's horn (docs/audioMix.md). */
  level: 0.5,
  near: 14,
  /** Per voice class: the lower reed (Hz), reed ratio, low pass (Hz), beeps, a beep's length (s) and the gap (s). */
  car: { hz: [380, 470], ratio: 1.26, lp: 1800, beeps: 1, len: [0.3, 1.2], gap: 0.14 },
  taxi: { hz: [400, 480], ratio: 1.26, lp: 1900, beeps: 2, len: [0.25, 0.45], gap: 0.14 },
  heavy: { hz: [190, 250], ratio: 1.2, lp: 1200, beeps: 1, len: [0.5, 1.2], gap: 0.14 },
  /** Kinds that sound like a bus or a truck, and the ones that stay silent. */
  heavyKinds: ['cityBus', 'schoolBus', 'garbageTruck', 'fireTruck', 'towTruck'],
  silentKinds: ['police'],
  /** Voices at once, so a pile-up of close calls stays a few horns. */
  maxVoices: 4,
} as const;

/** Body-to-body clearance between two oriented cars (m): three circles along each, least gap. */
export function clearance(ax: number, az: number, ayaw: number, ahl: number, ahw: number, bx: number, bz: number, byaw: number, bhl: number, bhw: number): number {
  const asx = Math.sin(ayaw);
  const asz = Math.cos(ayaw);
  const bsx = Math.sin(byaw);
  const bsz = Math.cos(byaw);
  const au = Math.max(0, ahl - ahw);
  const bu = Math.max(0, bhl - bhw);
  let best = Infinity;
  for (let i = -1; i <= 1; i++) {
    const px = ax + asx * au * i;
    const pz = az + asz * au * i;
    for (let j = -1; j <= 1; j++) {
      const d = Math.hypot(px - (bx + bsx * bu * j), pz - (bz + bsz * bu * j)) - ahw - bhw;
      if (d < best) best = d;
    }
  }
  return best;
}

/** Fire horns for the traffic. */
export class CarHorns {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  /** Tick of each car's last honk. */
  private readonly last = new Map<number, number>();
  private lastTick = 0;
  private voices: { end: number; out: GainNode }[] = [];
  private disposed = false;

  /** Throws if Web Audio is unavailable; check audioHub() first. */
  constructor() {
    const h = audioHub()!;
    this.ctx = h.ctx;
    this.bus = h.effectsBus;
  }

  /** Every frame: look for close calls in the current sim state and honk. */
  update(race: RaceState, listener: Listener, paused: boolean): void {
    const t = race.traffic;
    if (!t || this.disposed || paused) return;
    if (race.tick < this.lastTick) this.last.clear();
    this.lastTick = race.tick;
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > now);
    const r2 = HORN.range * HORN.range;
    for (let i = 0; i < t.fleet; i++) {
      const c = t.cars[i];
      if (c.mode !== 'drive') continue;
      const dx = c.body.x - listener.x;
      const dz = c.body.z - listener.z;
      if (dx * dx + dz * dz > r2) continue;
      const k = trafficTuning(c.kind);
      const name = k.carId.slice(8);
      if ((HORN.silentKinds as readonly string[]).includes(name)) continue;
      const lastAt = this.last.get(c.id);
      if (lastAt !== undefined && race.tick - lastAt < HORN.cooldown * TICK_HZ) continue;
      if (!this.closeCall(race, c, k.geometry.halfLength, k.geometry.halfWidth)) continue;
      this.last.set(c.id, race.tick);
      if (this.voices.length < HORN.maxVoices) this.honk(race.world.seed, race.tick, c, name, listener);
    }
  }

  /** A race car within the clearance of this car at a speed difference over the limit. */
  private closeCall(race: RaceState, c: TrafficCar, hl: number, hw: number): boolean {
    const b = c.body;
    for (const rc of race.cars) {
      const s = rc.state;
      const g = rc.tuning.geometry;
      const reach = hl + g.halfLength + HORN.clear;
      const dx = s.x - b.x;
      const dz = s.z - b.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (Math.hypot(s.vx - b.vx, s.vz - b.vz) < HORN.speed) continue;
      if (clearance(b.x, b.z, b.yaw, hl, hw, s.x, s.z, s.yaw, g.halfLength, g.halfWidth) < HORN.clear) return true;
    }
    return false;
  }

  /** One honk from the car, seeded from the car and the tick. */
  private honk(seed: number, tick: number, c: TrafficCar, name: string, l: Listener): void {
    const ctx = this.ctx;
    const rng = new Rng(deriveSeed(seed, `horn:${c.id}:${tick}`));
    const spec = name === 'taxi' ? HORN.taxi : (HORN.heavyKinds as readonly string[]).includes(name) ? HORN.heavy : HORN.car;
    const hz = rng.range(spec.hz[0], spec.hz[1]);
    const len = rng.range(spec.len[0], spec.len[1]);
    const delay = rng.range(HORN.delay[0], HORN.delay[1]);
    const at = ctx.currentTime + delay;
    const pos = this.place(c.body.x, c.body.z, l);
    const endPos = this.place(c.body.x + c.body.vx * (len + 0.2), c.body.z + c.body.vz * (len + 0.2), l);
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pos.pan, at);
    panner.pan.linearRampToValueAtTime(endPos.pan, at + spec.beeps * (len + spec.gap));
    const out = ctx.createGain();
    out.gain.value = HORN.level * pos.gain;
    out.connect(panner).connect(this.bus);
    let open = 0;
    const end = playHorn(ctx, out, {
      at, hz, beeps: spec.beeps, len, gap: spec.gap, ratio: spec.ratio, lp: spec.lp,
      start: (src, from, stopAt) => {
        open++;
        src.onended = () => {
          src.disconnect();
          if (--open === 0) panner.disconnect();
        };
        src.start(from);
        src.stop(stopAt);
      },
    });
    this.voices.push({ end, out });
  }

  /** Gain (distance) and pan of a ground position. */
  private place(x: number, z: number, l: Listener): { gain: number; pan: number } {
    const dx = x - l.x;
    const dz = z - l.z;
    const d = Math.hypot(dx, dz);
    return { gain: (1 / (1 + (d / HORN.near) ** 2)) * lerp(1, 0, clamp01((d - HORN.range * 0.6) / (HORN.range * 0.4))), pan: clamp(((dx * l.rx + dz * l.rz) / Math.max(1, d)) * 0.8, -1, 1) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.out.gain.setTargetAtTime(0, t, 0.03);
    this.voices = [];
  }
}
