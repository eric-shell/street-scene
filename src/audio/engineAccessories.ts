/**
 * The engine voice's per car extras that are state or schedules rather than DSP, as pure code so the same numbers drive
 * the Web Audio nodes in engineAudio.ts and the headless tests: the turbo's boost model with a sequential twin turbo
 * handover (TurboModel, SEQUENTIAL), the compressor surge flutter and the wastegate chatter as schedules of pulses
 * (FLUTTER, CHATTER), active exhaust flaps (FLAPS), the air-cooled cooling fan's whine (FAN) and the gearbox whine
 * (GEAR_WHINE). Every one is neutral until a car's `engine.voice` asks for it (carSpec.ts): without the fields the
 * boost model is the plain follower the voice always had, bit for bit.
 * Sources are docs/carEngines.md (the Kazama Rotor's and Tachibana Zenith's turbo sequence); anything not in a source
 * is marked est. below. Render side only; nothing here touches the sim.
 */
import { damp } from '../shared/anim';
import type { EngineVoiceSpec } from '../shared/carSpec';
import { clamp01, lerp, smoothstep } from '../sim/math';
import { TURBO } from './engineSynth';

// ---------------------------------------------------------------------------
// Parallel twin turbo whistle
// ---------------------------------------------------------------------------

/**
 * A parallel twin turbo (voice.twinWhistle): two identical turbines each fed by three cylinders spin at slightly
 * different speeds, so the whistle is two close tones, a chorus, instead of one. The RB26DETT has a pair of T25-type
 * ceramic turbos (docs/carEngines.md; Wikipedia's RB page); how far apart they run is our estimate. The tones sit
 * symmetrically about the single turbo's pitch, so the pitch the ear hears stays where it was, and each carries `share`
 * of a single turbo's level (two uncorrelated tones at 0.72 add up to the power of one: 2 x 0.72^2 = 1.04).
 */
export const TWIN_WHISTLE = { share: 0.72 } as const;

/** The two parallel turbos' pitch multipliers for a spread (fraction of pitch): [lower, upper], centred on 1. */
export function twinWhistlePitches(spread: number): [number, number] {
  return [1 - spread / 2, 1 + spread / 2];
}

// ---------------------------------------------------------------------------
// Sequential twin turbo
// ---------------------------------------------------------------------------

/**
 * A sequential twin turbo (voice.handoverRpm): a small primary turbo makes boost from low revs alone; the second
 * turbine is routed exhaust (pre-boost) before it joins at the handover rpm. Sourced for two cars (docs/carEngines.md):
 * the RX-7 FD's 13B-REW makes about 10 psi from about 1,800 rpm, the second turbo prespools near 4,000 and the
 * changeover is at about 4,500 with a brief drop to about 8 psi; the Supra's 2JZ-GTE has the first turbo at 1,800,
 * pre-boost at 3,500 ("no extra output yet") and the second joining at 4,000. The shape of the dip and the surge, the
 * tones' shares and the time constants are our estimate (est.).
 * - The primary reaches the boost plateau at `spoolRpm` and holds it (a sequential car is flat to the redline), with
 *   a quicker spool than the big single turbo of TURBO.spool (`primarySpool`, est.).
 * - The second turbine's own tone is a hum at `preGain` of full while it pre-spools (it turns but makes no boost),
 *   then full at the join; the primary's whistle drops in level (`primaryShare`) and pitch (`primaryPitch`) once the
 *   flow is shared, and the second turbine is bigger and so lower (`secondaryPitch`).
 * - At the join under load the boost dips by `handoverDip` (a cosine down over `fall`, back up over `rise`) and then
 *   surges `surge` of the dip above plateau, a half-sine over `surgeLen`. It re-arms `rearm` rpm below the handover.
 * Times are seconds; every state is a time constant or a timeline, so 30, 60 and 120 fps agree.
 */
export const SEQUENTIAL = {
  spoolRpm: 1800,
  /** Rpm where the ramp to the plateau starts. */
  idleRpm: 1000,
  /** The second turbine starts this far under the handover when `preboostRpm` is missing. */
  preboostLead: 500,
  rearm: 250,
  primarySpool: 0.25,
  preSpool: 0.35,
  joinRise: 0.1,
  joinFall: 0.2,
  preGain: 0.25,
  primaryShare: 0.7,
  primaryPitch: 0.85,
  secondaryPitch: 0.78,
  /** Level of the second turbine's whistle against the primary's. */
  secondaryGain: 0.8,
  /** The dip only fires with the pedal at least this far down (a lift through the handover is not a changeover). */
  dipLoad: 0.3,
  fall: 0.12,
  rise: 0.3,
  surge: 0.5,
  surgeLen: 0.5,
} as const;

/** A car's sequential twin turbo, resolved from its voice block; null for one turbo or parallel twins. */
export interface SequentialSpec {
  spoolRpm: number;
  preboostRpm: number;
  handoverRpm: number;
  /** Boost lost at the changeover as a fraction. */
  dip: number;
}

export function sequentialSpec(v: EngineVoiceSpec | undefined): SequentialSpec | null {
  if (!v || v.handoverRpm === undefined) return null;
  return {
    spoolRpm: v.spoolRpm ?? SEQUENTIAL.spoolRpm,
    preboostRpm: v.preboostRpm ?? v.handoverRpm - SEQUENTIAL.preboostLead,
    handoverRpm: v.handoverRpm,
    dip: v.handoverDip ?? 0,
  };
}

/**
 * The voice's turbo estimates, stepped once per frame. `speed` is the turbine's speed (0..1, the whistle's pitch) and
 * `boost` the charge pressure after the changeover's dip (0..1, the whistle's, whoosh's and valve's level): the same
 * single follower of pedal times revs the voice always had when the car has no sequence, a separate plateau
 * with the dip when it has one. Neither is a pressure in psi.
 */
export class TurboModel {
  /** Turbine speed 0..1 (whistle pitch). */
  speed = 0;
  /** Charge pressure 0..1 after the dip (levels). */
  boost = 0;
  /** Second turbine's tone level 0..1: the pre-spool hum, then full once it has joined (0 without a sequence). */
  secondary = 0;
  /** How far the flow is shared between the two turbines, 0..1 (the primary's whistle lowers with it). */
  join = 0;
  private pressure = 0;
  private pre = 0;
  private joined = false;
  /** Seconds since the changeover began; infinite when none is running. */
  private dipT = Number.POSITIVE_INFINITY;

  constructor(private readonly seq: SequentialSpec | null = null) {}

  /** Advance by `dt` seconds at `rpm`, with the pedal `load` 0..1. */
  step(rpm: number, redline: number, load: number, dt: number): void {
    const r = Math.min(1.05, rpm / redline);
    const target = load * Math.max(0, (r - 0.25) / 0.75);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / (target > this.speed ? TURBO.spool : TURBO.fall)));
    const s = this.seq;
    if (!s) {
      this.pressure = this.boost = this.speed;
      return;
    }
    const plateau = load * clamp01((rpm - SEQUENTIAL.idleRpm) / (s.spoolRpm - SEQUENTIAL.idleRpm));
    this.pressure += (plateau - this.pressure) * (1 - Math.exp(-dt / (plateau > this.pressure ? SEQUENTIAL.primarySpool : TURBO.fall)));

    const was = this.joined;
    if (rpm >= s.handoverRpm) this.joined = true;
    else if (rpm < s.handoverRpm - SEQUENTIAL.rearm) this.joined = false;
    if (this.joined && !was && load >= SEQUENTIAL.dipLoad) this.dipT = 0;
    this.dipT += dt;

    const preTarget = clamp01(load * 2) * smoothstep(s.preboostRpm, Math.max(s.preboostRpm + 1, s.handoverRpm), rpm);
    this.pre += (preTarget - this.pre) * damp(1 / SEQUENTIAL.preSpool, dt);
    this.join += ((this.joined ? 1 : 0) - this.join) * damp(1 / (this.joined ? SEQUENTIAL.joinRise : SEQUENTIAL.joinFall), dt);
    this.secondary = this.join + (1 - this.join) * SEQUENTIAL.preGain * this.pre;

    this.boost = this.pressure * this.dipFactor(s.dip);
  }

  /** The multiplier on the plateau at the changeover: a dip, then a smaller surge, then 1. */
  private dipFactor(dip: number): number {
    const t = this.dipT;
    const S = SEQUENTIAL;
    if (dip <= 0 || t >= S.fall + S.rise + S.surgeLen) return 1;
    if (t < S.fall) return 1 - dip * 0.5 * (1 - Math.cos((Math.PI * t) / S.fall));
    if (t < S.fall + S.rise) return 1 - dip * 0.5 * (1 + Math.cos((Math.PI * (t - S.fall)) / S.rise));
    return 1 + dip * S.surge * Math.sin((Math.PI * (t - S.fall - S.rise)) / S.surgeLen) ** 2;
  }

  /** A valve release has bled the charge: keep this share of the turbine's speed and pressure. */
  release(keep: number): void {
    this.speed *= keep;
    this.pressure *= keep;
    this.boost *= keep;
  }

  /** Pitch multiplier on the primary whistle (1 until the second turbo shares the flow). */
  get primaryPitch(): number {
    return this.seq ? lerp(1, SEQUENTIAL.primaryPitch, this.join) : 1;
  }

  /** Level multiplier on the primary whistle. */
  get primaryLevel(): number {
    return this.seq ? lerp(1, SEQUENTIAL.primaryShare, this.join) : 1;
  }
}

// ---------------------------------------------------------------------------
// Compressor surge flutter and wastegate chatter
// ---------------------------------------------------------------------------

/** One burst of a pulse train: starts at `at` seconds after the lift, rises in `attack`, falls in `decay` (exponentially to silence). */
export interface Pulse {
  at: number;
  peak: number;
  attack: number;
  decay: number;
}

/**
 * Compressor surge flutter, "stu-tu-tu": the throttle shuts on a spinning compressor with nowhere for the charge to go
 * (no valve, or one too slow for a hard lift), the flow reverses and the compressor stalls and recovers over and over,
 * each stall a puff of noise. Heard from about 6 to 14 pulses a second, slowing as the turbine runs down, from 3 to 9
 * pulses by how hard the boost was (docs/carEngines.md names the flutter on the Zenith, Runabout and the RX-7 as a gap;
 * rates and counts are our estimate, est.). A valve car flutters only at a hard lift (pedal over `hardThrottle` at
 * boost over `hardBoost`), scaled by `voice.flutter`; `diverter: 'flutter'` has no valve to release anything, so it
 * flutters on every lift the valve would have blown off for. The band sweeps down as the turbine slows.
 */
export const FLUTTER = {
  rate: [14, 6],
  count: [3, 9],
  peak: 0.8,
  attack: 0.004,
  /** Each pulse rings for this share of its period. */
  decayShare: 0.6,
  /** The compressor keeps spinning through a stall: keep this share of the turbine's speed. */
  spoolKeep: 0.7,
  hardThrottle: 0.85,
  hardBoost: 0.6,
  band: { from: 1500, to: 650, q: 1.1 },
} as const;

/** The flutter pulses for a lift at `boost` (0..1), scaled by `strength` (0..1). */
export function flutterPulses(boost: number, strength: number): Pulse[] {
  const n = Math.round(lerp(FLUTTER.count[0], FLUTTER.count[1], clamp01((boost - 0.4) / 0.6)));
  const out: Pulse[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const u = k / Math.max(1, n - 1);
    const period = 1 / lerp(FLUTTER.rate[0], FLUTTER.rate[1], u);
    out.push({ at, peak: FLUTTER.peak * strength * boost * (1 - 0.5 * u), attack: FLUTTER.attack, decay: period * FLUTTER.decayShare });
    at += period;
  }
  return out;
}

/**
 * Wastegate chatter: on a lift the exhaust flow collapses, the gate's actuator pressure and the exhaust pulses
 * fight over a gate that is just opening, and the valve flaps on its seat in a quick run of metallic ticks, 60 to 250 ms
 * long, spaced 16 to 34 ms and fading (an aftermarket external gate does it loudly; the Runabout's section in
 * docs/carEngines.md calls out "wastegate whoosh and chatter", the R33's wastegates are sourced; counts, spacing and
 * level are our estimate, est.). Fires on a lift from boost above `minBoost`; the clicks are 3 ms noise ticks.
 */
export const CHATTER = {
  count: [6, 11],
  gap: [0.016, 0.034],
  /** Seconds before the first tick: the gate follows the pedal. */
  lead: 0.03,
  peak: 0.4,
  attack: 0.0006,
  decay: 0.003,
  minBoost: 0.5,
  jitter: 0.25,
  band: { hz: 2600, q: 1.3 },
} as const;

/** The chatter ticks for a lift at `boost`, `strength` times the reference; `rand` supplies 0..1 values for the jitter. */
export function chatterClicks(boost: number, strength: number, rand: () => number): Pulse[] {
  if (strength <= 0 || boost < CHATTER.minBoost) return [];
  const n = Math.round(lerp(CHATTER.count[0], CHATTER.count[1], clamp01((boost - CHATTER.minBoost) / (1 - CHATTER.minBoost))));
  const out: Pulse[] = [];
  let at = CHATTER.lead;
  for (let k = 0; k < n; k++) {
    const u = k / Math.max(1, n - 1);
    const j = 1 + CHATTER.jitter * (rand() * 2 - 1);
    out.push({ at, peak: CHATTER.peak * strength * boost * (1 - 0.7 * u) * j, attack: CHATTER.attack, decay: CHATTER.decay });
    at += lerp(CHATTER.gap[0], CHATTER.gap[1], u) * j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Active exhaust flaps
// ---------------------------------------------------------------------------

/**
 * Active exhaust flaps (voice.flaps): a valve in the silencer that stays shut at cruise (quiet, dull) and opens on
 * load and revs, the way a Corvette Z51's or a Porsche's sport exhaust does (docs/carEngines.md lists the TT-RS, the
 * Corvette Z51 and the 2013 GT500 as the fleet's candidates; all numbers est.). Open means the program's own silencer
 * response, which the loudness trim is set against; shut is `closedGain` quieter and rolled off at `closedHz`, both
 * scaled by the car's depth. The gate has hysteresis (open at the upper pair, shut only under the lower pair; between
 * them it holds) and the flap travels over a time constant `tau`, so a rev that hovers at the threshold does not chatter.
 */
export const FLAPS = {
  openLoad: 0.6,
  closeLoad: 0.35,
  /** Fractions of the redline. */
  openRpm: 0.7,
  closeRpm: 0.6,
  /** Seconds the actuator takes (a time constant). */
  tau: 0.15,
  closedGain: 0.35,
  closedHz: 1400,
  openHz: 20000,
} as const;

/** The flap actuator: a hysteresis latch on load and revs, and its travel 0 (shut) .. 1 (open). */
export class FlapGate {
  open = 0;
  private latched = false;

  step(load: number, r: number, dt: number): void {
    if (load >= FLAPS.openLoad || r >= FLAPS.openRpm) this.latched = true;
    else if (load <= FLAPS.closeLoad && r <= FLAPS.closeRpm) this.latched = false;
    this.open += ((this.latched ? 1 : 0) - this.open) * damp(1 / FLAPS.tau, dt);
  }

  /** Whether the latch is open (the target the travel chases). */
  get target(): boolean {
    return this.latched;
  }
}

/** The silencer gain and low pass (Hz) with the flaps `open` 0..1 at `depth` 0..1: depth scales how far shut is from open. */
export function flapResponse(depth: number, open: number): { gain: number; hz: number } {
  const shut = 1 - open;
  return { gain: 1 - depth * shut * (1 - FLAPS.closedGain), hz: FLAPS.openHz * (FLAPS.closedHz / FLAPS.openHz) ** (depth * shut) };
}

// ---------------------------------------------------------------------------
// Cooling fan and gearbox whine
// ---------------------------------------------------------------------------

/**
 * The air-cooled engine's cooling fan (voice.fanRatio): a belt drives it at `fanRatio` turns per crank turn, so its
 * blade pass whine is rpm locked, present at idle and on a lift, and rises with revs. Blade pass = rpm / 60 x ratio x
 * blades. A 993's ratio and blade count are not in docs/carEngines.md, which only says "fan whine from the cooling
 * fan (rpm-locked)": 1.8 and 11 blades are our estimate (est.), so the fan whines at 2.1 kHz at 6,500 rpm. It stays
 * faint (`level` is the fundamental's amplitude at the redline, against the engine near 0.05; est.).
 */
export const FAN = {
  blades: 11,
  level: 0.012,
  /** Harmonics of the blade pass, relative to the fundamental. */
  partials: [1, 0.4],
  /** Share of the level left at idle: a slow fan is quieter. */
  idleShare: 0.3,
  maxHz: 5500,
} as const;

/** The fan's blade pass frequency (Hz). */
export function fanHz(ratio: number, rpm: number): number {
  return (rpm / 60) * ratio * FAN.blades;
}

/** The fan whine's amplitude at `rpm` for a car of this `redline`. */
export function fanLevel(rpm: number, redline: number): number {
  return FAN.level * lerp(FAN.idleShare, 1, clamp01(rpm / redline) ** 1.5);
}

/**
 * Gearbox whine (voice.gearWhine): the mesh of the engaged gear pair, locked to the speed of the shaft it drives
 * (the gearbox output, wheel speed times the final drive), at `teeth` teeth per revolution, so it is the same pitch at
 * the same road speed in every gear and falls silent when the car stops. A straight cut (dog box, NSX-R and
 * S2000 style) gearbox whines loudest: the level is the car's multiple of `level`, the reference being a dog box at
 * full load (est.). It is loud on the pedal and `coast` of that off it, drops during a shift (the drive is cut) and
 * fades in over `minRpm`..2 x `minRpm` of the shaft so a crawl is silent. The tooth count is a plausible 24 (est.).
 */
export const GEAR_WHINE = {
  teeth: 24,
  level: 0.03,
  /** Harmonics of the mesh frequency, relative to the fundamental. */
  partials: [1, 0.4, 0.15],
  coast: 0.45,
  minRpm: 150,
  maxHz: 5500,
} as const;

/** The mesh frequency (Hz) for a shaft turning `driveRpm`. */
export function gearWhineHz(driveRpm: number): number {
  return (Math.max(0, driveRpm) / 60) * GEAR_WHINE.teeth;
}

/** The whine's amplitude: car level, pedal, shaft speed fade-in, silent during a shift cut. */
export function gearWhineLevel(level: number, load: number, driveRpm: number, shifting: boolean): number {
  if (shifting) return 0;
  return GEAR_WHINE.level * level * lerp(GEAR_WHINE.coast, 1, clamp01(load)) * smoothstep(GEAR_WHINE.minRpm, 2 * GEAR_WHINE.minRpm, driveRpm);
}
