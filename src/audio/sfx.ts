/**
 * Sound effects with Web Audio. Synthesized (no asset files):
 *  - impacts: car vs car crunch, wall/barrier thud, guard rail clang, and prop
 *    breaks by kind (pole clang + glass, hollow can bang, bench crunch, a hydrant's gush, big
 *    bus stop shatter, leafy bush swish, pot crack, cafe chair clatter, plastic
 *    barrel thunk, crate splinter, dumpster boom, trash bag thump). Each is
 *    rendered once into a few AudioBuffer variants
 *    by the small DSP recipes below, then replayed with pitch and level from
 *    the impact speed, spatialized to the camera, rate limited and capped
 *    to a fixed number of voices.
 *  - loops: nitrous jet whoosh (sweeping filtered noise + turbine whine) and
 *    a wall/rail scrape while a car grinds along a wall.
 *  - the horn (dual tone), the countdown beeps and firework booms.
 *  - the nitrous callouts' rewards (boostCue): a tick climbing a scale as a
 *    callout's points roll past each hundred, a chime at each thousand, an
 *    arpeggio for a stage coming full (a fanfare for Max), a rising sweep for a
 *    full overdrive and a falling blip when a crash costs nitrous.
 *  - standalone voices a scene owns: the train rumble, the helicopter
 *    rotors and the thunder of the lightning on rain nights.
 * Crowd recordings (public/sfx, loaded lazily and decoded once per app):
 *  - a looped cheering bed per crowd stand, positioned on the stand's
 *    nearest point to the listener and swelling with the stand's excitement
 *  - cheering + applause one-shots when the player crosses the line.
 * Render side only: reads race events and interpolated car state, never the
 * other way around. All randomness here is cosmetic (Math.random is fine).
 *
 * This module is the player (Sfx: banks, voice limits, spatializing, the race's
 * events); the recipes and their DSP are sfxRecipes.ts, the per car loops and
 * the mix levels sfxVoices.ts, the crowd clips crowdAudio.ts, and the train,
 * helicopter and thunder voices sceneVoices.ts.
 */
import { audioHub } from './engineAudio';
import type { RaceEvent, RaceState } from '../sim/race';
import type { PropKind } from '../city/props';
import type { Contact, World } from '../city/world';
import { TICK_HZ } from '../sim/constants';
import { CROWD_OFF, CROWD_ON, CROWD_REF, CROWD_SHOT_GAIN, CrowdLoop, MAX_CROWD_LOOPS, loadClip, type SfxCrowdSpot } from './crowdAudio';
import { PROP_SOUND, SFX_BANKS, renderImpact, rnd, type SfxBank, type WallHitKind } from './sfxRecipes';
import { BEEP_LEVEL, FIREWORK_LEVEL, HornVoice, IMPACT_LEVEL, NITRO_LEVEL, NitroVoice, REWARD_LEVEL, ScrapeLoop } from './sfxVoices';
import type { BoostCue } from '../ui/hud/boostCallouts';

type Bank = SfxBank;

/** Where a sound is heard: 0..1 loudness from distance and -1..1 stereo position. */
export interface SfxPos {
  proximity: number;
  pan: number;
}

/** Per car state the loops need each frame (interpolated pose, world units). */
export interface SfxCar {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  nitro: boolean;
  halfLength: number;
  halfWidth: number;
}

/** Rendered variants per impact bank, and the most impact one-shots playing at once. */
const VARIANTS = 3;
const MAX_VOICES = 14;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The reward cues' notes and spacing: semitones over `base` (Hz), the major scale a callout's ticks climb within each thousand. */
const REWARD = {
  base: 880,
  scale: [0, 2, 4, 5, 7, 9, 11, 12, 14],
  /** Ticks closer than this (s) are dropped, so a fast roll is a run of clicks, not a buzz. */
  tickGap: 0.035,
  /** A stage's arpeggio rises by these semitones over its root, stage 1's root at base x 1.19 (a minor third up) and each stage a third higher. */
  arpeggio: [0, 4, 7, 12],
} as const;
const semis = (n: number) => REWARD.base * Math.pow(2, n / 12);

// ---------- the effects player ----------

const scratch: Contact[] = [];

/** The hardest sliding wall contact of a car right now (render side query of the static world). */
function wallContact(world: World, c: SfxCar): { vt: number; kind: WallHitKind } | null {
  const fx = Math.sin(c.yaw);
  const fz = Math.cos(c.yaw);
  const r0 = c.halfWidth * 0.95;
  const span = Math.max(0, c.halfLength - r0);
  let best: { vt: number; kind: WallHitKind } | null = null;
  for (const u of [-span, 0, span]) {
    const n = world.collideCircle(c.x + fx * u, c.z + fz * u, r0 + 0.18, scratch);
    for (let i = 0; i < n; i++) {
      const k = scratch[i];
      // Moving clearly away from the wall: not grinding.
      if (c.vx * k.nx + c.vz * k.nz > 2.5) continue;
      const vt = Math.abs(-c.vx * k.nz + c.vz * k.nx);
      if (!best || vt > best.vt) best = { vt, kind: k.kind as WallHitKind };
    }
  }
  return best;
}

export class Sfx {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  /** The crowds play on the ambience bus; everything else here on the effects bus. */
  private readonly ambience: GainNode;
  private readonly noise: AudioBuffer;
  private readonly banks = new Map<Bank, AudioBuffer[]>();
  private voices: { end: number; level: number; out: GainNode }[] = [];
  private readonly recent = new Map<string, { t: number; level: number }>();
  private readonly listener = { x: 0, z: 0, rx: 1, rz: 0 };
  private readonly nitro: (NitroVoice | undefined)[] = [];
  private readonly scrape: (ScrapeLoop | undefined)[] = [];
  private hornVoice: HornVoice | null = null;
  private crowdLoops: (CrowdLoop | undefined)[] = [];
  private cheerBuf: AudioBuffer | null = null;
  private applauseBuf: AudioBuffer | null = null;
  private crowdLoading = false;
  /** Crowd one-shots still playing (faded out on dispose). */
  private crowdShots: GainNode[] = [];
  private lastCount: number | null = null;
  /** The reward cues' lowpass into the effects bus, and when the last tick played (ctx time). */
  private readonly reward: BiquadFilterNode;
  private lastTick = 0;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Throws if Web Audio is unavailable; check audioHub() first. */
  constructor() {
    const h = audioHub()!;
    this.ctx = h.ctx;
    this.bus = h.effectsBus;
    this.ambience = h.ambienceBus;
    this.noise = h.noise;
    this.reward = this.ctx.createBiquadFilter();
    this.reward.type = 'lowpass';
    this.reward.frequency.value = 6500;
    this.reward.connect(this.bus);
    // Render the impact variants in the background, one per slice, so the first crash has no hitch.
    const pending: Bank[] = [];
    for (let v = 0; v < VARIANTS; v++) pending.push(...SFX_BANKS);
    const warm = () => {
      const b = pending.shift();
      if (!b || this.disposed) return;
      if (this.bank(b, false).length < VARIANTS) this.addVariant(b);
      this.warmTimer = setTimeout(warm, 25);
    };
    this.warmTimer = setTimeout(warm, 300);
  }

  private addVariant(b: Bank): void {
    const data = renderImpact(b, this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data, 0);
    this.bank(b, false).push(buf);
  }

  /** The rendered variants of a bank; renders one on demand if none is ready yet. */
  private bank(b: Bank, ensure = true): AudioBuffer[] {
    let bufs = this.banks.get(b);
    if (!bufs) this.banks.set(b, (bufs = []));
    if (ensure && !bufs.length) this.addVariant(b);
    return bufs;
  }

  /** Camera position and its right vector on the ground plane, once per frame. */
  setListener(x: number, z: number, rightX: number, rightZ: number): void {
    const l = this.listener;
    l.x = x;
    l.z = z;
    l.rx = rightX;
    l.rz = rightZ;
  }

  /** Loudness and pan of a world position; the player's car is always close and centered. */
  at(x: number, z: number, isPlayer = false): SfxPos {
    if (isPlayer) return { proximity: 1, pan: 0 };
    const l = this.listener;
    const dx = x - l.x;
    const dz = z - l.z;
    const d = Math.hypot(dx, dz);
    return { proximity: 1 / (1 + (d / 16) ** 2), pan: Math.max(-1, Math.min(1, ((dx * l.rx + dz * l.rz) / Math.max(1, d)) * 0.8)) };
  }

  /**
   * Play one impact buffer. Rate limited per key (a stronger hit may cut in),
   * capped at MAX_VOICES (the quietest voice is stolen), far sounds low passed.
   */
  private play(b: Bank, level: number, rate: number, pos: SfxPos, key: string, minGap = 0.09): void {
    const gain = level * pos.proximity * IMPACT_LEVEL;
    if (this.disposed || gain < 0.015) return;
    const now = this.ctx.currentTime;
    const last = this.recent.get(key);
    if (last && now - last.t < minGap && gain < last.level * 1.6) return;
    this.recent.set(key, { t: now, level: gain });
    this.voices = this.voices.filter((v) => v.end > now);
    if (this.voices.length >= MAX_VOICES) {
      let q = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].level < this.voices[q].level) q = i;
      if (this.voices[q].level >= gain) return;
      this.voices[q].out.gain.setTargetAtTime(0, now, 0.015);
      this.voices.splice(q, 1);
    }
    const bufs = this.bank(b);
    const buf = bufs[Math.floor(Math.random() * bufs.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200 + 18000 * pos.proximity ** 1.5;
    const out = this.ctx.createGain();
    out.gain.value = gain;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = pos.pan;
    src.connect(lp).connect(out).connect(pan).connect(this.bus);
    src.onended = () => pan.disconnect();
    src.start(now);
    this.voices.push({ end: now + buf.duration / rate, level: gain, out });
  }

  /** Car vs car. speed = impact speed (m/s). Heavier hits are louder and lower. */
  crash(speed: number, pos: SfxPos, key = 'crash'): void {
    const k = clamp01(speed / 24);
    this.play('crash', 0.95 * clamp01((speed - 1.2) / 15) ** 0.7, (1.14 - 0.28 * k) * rnd(0.94, 1.06), pos, key);
  }

  /** Car vs static geometry: concrete wall, closure barrier or guard rail. */
  wall(speed: number, kind: WallHitKind, pos: SfxPos, key = `wall:${kind}`): void {
    const k = clamp01(speed / 22);
    // Rails are mostly glancing hits, so their normal speeds are low: more sensitive.
    const level = kind === 'rail' ? clamp01((speed - 0.6) / 11) ** 0.7 * 0.85 : clamp01((speed - 1) / 16) ** 0.7;
    this.play(kind, level, (1.12 - 0.25 * k) * rnd(0.94, 1.06), pos, key, kind === 'rail' ? 0.16 : 0.1);
  }

  /** A prop broken at the given car speed (m/s). */
  prop(kind: PropKind, speed: number, pos: SfxPos, key = 'prop'): void {
    const base: Record<PropKind, number> = {
      streetlight: 0.9,
      utilityPole: 1,
      trafficLight: 0.85,
      garbageCan: 0.65,
      bench: 0.75,
      busStop: 1,
      bush: 0.45,
      planterPot: 0.8,
      cafeTable: 0.6,
      barrel: 0.6,
      crate: 0.7,
      dumpster: 1,
      newsBox: 0.55,
      trashBags: 0.45,
      parkLamp: 0.75,
      bollard: 0.8,
      fencePanel: 0.7,
      trafficCone: 0.35,
      sawhorse: 0.55,
      waterBarrier: 0.75,
      sandbags: 0.5,
      pallets: 0.6,
      drum: 0.7,
      cableSpool: 0.75,
      marketStall: 0.7,
      fruitCrates: 0.55,
      foodCart: 0.8,
      hydrant: 0.85,
      parkingMeter: 0.5,
      mailbox: 0.65,
      phoneBooth: 0.9,
      vendingMachine: 0.95,
    };
    const k = clamp01(speed / 25);
    // Props are distinct objects: a short gap only stops one hit playing twice.
    this.play(PROP_SOUND[kind], (base[kind] ?? 0.8) * (0.55 + 0.45 * k), (1.06 - 0.12 * k) * rnd(0.95, 1.05), pos, key, 0.03);
  }

  /** Countdown beep; GO is higher and longer. */
  beep(go: boolean): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = go ? 1760 : 880;
    const dur = go ? 0.8 : 0.17;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(BEEP_LEVEL, t + 0.006);
    if (go) g.gain.setTargetAtTime(BEEP_LEVEL * 0.55, t + 0.1, 0.25);
    else g.gain.setValueAtTime(BEEP_LEVEL, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.connect(g).connect(this.bus);
    for (const [type, gain] of [['square', 0.35], ['sine', 0.8]] as [OscillatorType, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = gain;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.02);
      o.onended = () => og.disconnect();
    }
    setTimeout(() => g.disconnect(), (dur + 0.2) * 1000);
  }

  /** A nitrous callout's reward (ui/hud/boostCallouts.ts BoostCue), centred: the player's own news. */
  boostCue(cue: BoostCue): void {
    if (this.disposed) return;
    const L = REWARD_LEVEL;
    switch (cue.kind) {
      case 'tick': {
        const now = this.ctx.currentTime;
        if (now - this.lastTick < REWARD.tickGap) return;
        this.lastTick = now;
        const n = REWARD.scale[Math.max(0, Math.min(REWARD.scale.length - 1, (cue.step % 10) - 1))] + 12;
        return this.tone(semis(n), semis(n), 0, 0.05, 'triangle', L * 0.35);
      }
      case 'chime': {
        const up = Math.min(12, (cue.thousands - 1) * 2);
        this.tone(semis(24 + up), semis(24 + up), 0, 0.4, 'sine', L * 0.7);
        this.tone(semis(31 + up), semis(31 + up), 0.06, 0.5, 'triangle', L * 0.45);
        return;
      }
      case 'stage': {
        const root = 3 + (cue.stage - 1) * 4;
        const max = cue.stage >= 3;
        REWARD.arpeggio.forEach((a, i) => this.tone(semis(root + a), semis(root + a), i * (max ? 0.07 : 0.05), max ? 0.55 : 0.22, max ? 'sawtooth' : 'triangle', L * (max ? 0.45 : 0.55)));
        if (max) for (const a of [12, 16, 19]) this.tone(semis(root + a), semis(root + a), 0.3, 0.9, 'triangle', L * 0.4);
        return;
      }
      case 'overdrive':
        this.tone(semis(-12), semis(24), 0, 0.45, 'sawtooth', L * 0.35);
        for (const a of [19, 23, 26, 31]) this.tone(semis(a), semis(a), 0.38, 0.85, 'triangle', L * 0.4);
        return;
      case 'crash':
        this.tone(semis(7), semis(-17), 0, 0.3, 'square', L * 0.3);
        return;
    }
  }

  /** One enveloped oscillator into the reward lowpass, `start` s from now, gliding f0 to f1 (Hz) over `dur` s. */
  private tone(f0: number, f1: number, start: number, dur: number, type: OscillatorType, level: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.reward);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }

  /**
   * Call once per sim tick: beeps when the countdown value shown on the HUD
   * changes (3, 2, 1, GO), so it stays locked to sim ticks in races and replays.
   */
  syncCountdown(r: RaceState): void {
    const left = r.countdownTicks - r.tick;
    const v = left > 0 ? Math.ceil(left / TICK_HZ) : left > -TICK_HZ ? 0 : null;
    if (v !== null && v !== this.lastCount) this.beep(v === 0);
    this.lastCount = v;
  }

  /**
   * React to one sim event (any car). Positions come from the race state, so
   * call it from the tick that consumed the event.
   */
  raceEvent(e: RaceEvent, r: RaceState): void {
    if (e.type !== 'crash' && e.type !== 'wall' && e.type !== 'prop' && e.type !== 'arm') return;
    if (e.type === 'crash' && e.traffic !== undefined) {
      // A traffic car hit by a racer (or by a struck traffic car: car -1), heard where they met.
      const t = r.traffic?.cars[e.traffic]?.body;
      if (!t) return;
      const by = r.cars[e.car]?.state;
      this.crash(e.value ?? 0, this.at(by ? (by.x + t.x) / 2 : t.x, by ? (by.z + t.z) / 2 : t.z, e.car === 0), `traffic:${e.traffic}`);
      return;
    }
    const car = r.cars[e.car]?.state;
    if (!car) return;
    const isPlayer = e.car === 0;
    if (e.type === 'crash') {
      const o = e.other ?? -1;
      const other = r.cars[o]?.state;
      // Both cars may report the same contact: one key per pair, heard at the midpoint.
      const x = other ? (car.x + other.x) / 2 : car.x;
      const z = other ? (car.z + other.z) / 2 : car.z;
      this.crash(e.value ?? 0, this.at(x, z, isPlayer || o === 0), `crash:${Math.min(e.car, o)}-${Math.max(e.car, o)}`);
    } else if (e.type === 'wall') {
      this.wall(e.value ?? 0, e.kind ?? 'wall', this.at(car.x, car.z, isPlayer), `wall:${e.car}`);
    } else if (e.type === 'arm') {
      // A level crossing's gate arm snapping (sim/levelCrossing.ts): the crack of a sawhorse.
      this.prop('sawhorse', car.speed, this.at(car.x, car.z, isPlayer), `arm:${e.value}`);
    } else {
      const props = (r.world as unknown as { blocks?: { props?: { kind: PropKind; x: number; z: number }[] } }).blocks?.props;
      const p = props?.[e.value ?? -1];
      const kind: PropKind = p?.kind && p.kind in PROP_SOUND ? p.kind : 'garbageCan';
      this.prop(kind, car.speed, this.at(p?.x ?? car.x, p?.z ?? car.z, isPlayer), `prop:${e.value}`);
    }
  }

  /** Start loading the crowd clips (lazy: only races with crowds call this). */
  private loadCrowd(): void {
    if (this.crowdLoading) return;
    this.crowdLoading = true;
    void loadClip(this.ctx, 'cheer').then((b) => {
      if (!this.disposed) this.cheerBuf = b;
    });
    void loadClip(this.ctx, 'applause').then((b) => {
      if (!this.disposed) this.applauseBuf = b;
    });
  }

  /** Loudness and pan of a crowd stand: from its nearest point to the listener. */
  private crowdAt(s: { ax: number; az: number; bx: number; bz: number }): SfxPos {
    const l = this.listener;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? clamp01(((l.x - s.ax) * dx + (l.z - s.az) * dz) / len2) : 0;
    const px = s.ax + dx * t - l.x;
    const pz = s.az + dz * t - l.z;
    const d = Math.hypot(px, pz);
    return { proximity: 1 / (1 + (d / CROWD_REF) ** 2), pan: Math.max(-1, Math.min(1, ((px * l.rx + pz * l.rz) / Math.max(4, d)) * 0.7)) };
  }

  /**
   * Per frame: the cheering bed of every crowd stand, louder as the listener
   * gets close and as the stand gets excited. Pass an empty list for no crowd.
   */
  updateCrowds(spots: readonly SfxCrowdSpot[], paused: boolean): void {
    if (this.disposed || !spots.length) return;
    this.loadCrowd();
    if (!this.cheerBuf) return;
    let playing = 0;
    for (const l of this.crowdLoops) if (l) playing++;
    for (let i = 0; i < spots.length; i++) {
      const pos = this.crowdAt(spots[i]);
      const kind = spots[i].kind ?? 'gate';
      let loop = this.crowdLoops[i];
      if (!loop) {
        // Far stands stay silent until the listener comes near.
        if (pos.proximity < CROWD_ON[kind] || playing >= MAX_CROWD_LOOPS) continue;
        loop = this.crowdLoops[i] = new CrowdLoop(this.ctx, this.ambience, this.cheerBuf);
        playing++;
      } else if (pos.proximity < CROWD_OFF[kind]) {
        // Left behind: free the voice for the stands ahead.
        loop.dispose();
        this.crowdLoops[i] = undefined;
        playing--;
        continue;
      }
      loop.update(spots[i].level, pos, paused);
    }
  }

  /**
   * The crowd erupts at a world position (the player crossing the line):
   * a cheering swell, plus applause when `applause` is set. strength 1 = lap,
   * about 1.6 = finish (louder and longer).
   */
  crowdCheer(x: number, z: number, strength: number, applause: boolean): void {
    if (this.disposed) return;
    this.loadCrowd();
    const s = Math.max(0.2, strength);
    const pos = this.crowdAt({ ax: x, az: z, bx: x, bz: z });
    const shot = (buf: AudioBuffer | null, level: number, hold: number, offset: number) => {
      if (!buf || level * pos.proximity < 0.01) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rnd(0.97, 1.03);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level * pos.proximity, t + 0.25);
      g.gain.setTargetAtTime(0, t + hold, 0.8);
      const pan = ctx.createStereoPanner();
      pan.pan.value = pos.pan;
      src.connect(g).connect(pan).connect(this.ambience);
      const start = Math.min(offset, Math.max(0, buf.duration - hold - 4));
      src.start(t, start);
      src.stop(t + hold + 4);
      this.crowdShots.push(g);
      src.onended = () => {
        pan.disconnect();
        this.crowdShots = this.crowdShots.filter((x) => x !== g);
      };
    };
    shot(this.cheerBuf, 0.32 * s * CROWD_SHOT_GAIN, 2 + 2.2 * s, rnd(0, 2));
    if (applause) shot(this.applauseBuf, 0.26 * s * CROWD_SHOT_GAIN, 2.5 + 4 * s, rnd(0.5, 3));
  }

  /** A firework shell bursting at a world position; heard with the speed of sound delay. */
  firework(x: number, y: number, z: number, size: number): void {
    if (this.disposed) return;
    const l = this.listener;
    const d = Math.hypot(x - l.x, y - 2, z - l.z);
    const pos: SfxPos = { proximity: 1 / (1 + (d / 60) ** 2), pan: Math.max(-1, Math.min(1, (((x - l.x) * l.rx + (z - l.z) * l.rz) / Math.max(1, d)) * 0.7)) };
    const delay = Math.min(0.6, d / 343);
    const level = (0.35 + 0.35 * Math.min(1.3, size)) * FIREWORK_LEVEL;
    this.later(() => this.play('firework', level, rnd(0.85, 1.1) / Math.max(0.7, Math.min(1.3, size)) ** 0.3, pos, `fw:${Math.floor(Math.random() * 6)}`, 0), delay);
  }

  /** setTimeout that respects dispose (firework booms arrive late). */
  private later(fn: () => void, seconds: number): void {
    setTimeout(() => {
      if (!this.disposed) fn();
    }, seconds * 1000);
  }

  /** Horn on/off for the player's car (centered). */
  horn(on: boolean): void {
    if (this.disposed || (!on && !this.hornVoice)) return;
    this.hornVoice ??= new HornVoice(this.ctx, this.bus);
    this.hornVoice.set(on);
  }

  /** Per frame: nitrous whoosh and wall/rail grind loops for every car (index 0 = player). */
  updateCars(cars: SfxCar[], world: World | null, dt: number, paused: boolean): void {
    if (this.disposed) return;
    cars.forEach((c, i) => {
      const pos = this.at(c.x, c.z, i === 0);
      const nitroOn = c.nitro && !paused && pos.proximity > 0.01;
      if (nitroOn && !this.nitro[i]) this.nitro[i] = new NitroVoice(this.ctx, this.bus, this.noise);
      this.nitro[i]?.update(nitroOn, pos, i === 0 ? NITRO_LEVEL : NITRO_LEVEL * 0.7, dt);

      let target = 0;
      let metal = 0;
      let vt = 0;
      if (world && !paused && pos.proximity > 0.02) {
        const hit = wallContact(world, c);
        if (hit) {
          vt = hit.vt;
          target = clamp01((vt - 2.5) / 20) ** 0.8;
          metal = hit.kind === 'rail' ? 1 : hit.kind === 'barrier' ? 0.4 : 0;
        }
      }
      if (target > 0 && !this.scrape[i]) this.scrape[i] = new ScrapeLoop(this.ctx, this.bus, this.noise);
      this.scrape[i]?.update(target, metal, vt, pos, dt);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.out.gain.setTargetAtTime(0, t, 0.03);
    this.voices = [];
    this.nitro.forEach((n) => n?.dispose());
    this.scrape.forEach((s) => s?.dispose());
    this.hornVoice?.dispose();
    this.reward.disconnect();
    this.crowdLoops.forEach((c) => c?.dispose());
    this.crowdLoops = [];
    for (const g of this.crowdShots) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.1);
    }
    this.crowdShots = [];
  }
}
