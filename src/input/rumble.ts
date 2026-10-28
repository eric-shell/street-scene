/**
 * Gamepad rumble: the player's car felt through the pad's two motors. It only
 * reads the sim (the player's CarState telemetry and the tick's race events)
 * and runs once per sim tick, so it feels the same at any frame rate. Nothing
 * is recorded, so replays and ghosts never rumble. The strong (low frequency)
 * motor carries hits and landings, the weak (high frequency) one the texture:
 * rough ground, wheelspin, scraping a wall, the rev limiter, nitrous. The
 * nitrous callouts' rewards kick both (boostCue): a thousand points, a stage
 * coming full, harder for Max and a full overdrive.
 *
 * `vibrationActuator.playEffect('dual-rumble')` (Chrome, Edge) replaces the
 * running effect on every call, so a short effect is re-armed every few ticks
 * while anything is felt (sooner when a harder hit lands). Every effect is
 * short, so when the ticks stop (pause, photo mode, a closed tab) the pad goes
 * quiet by itself within a tenth of a second. Browsers or pads without it do
 * nothing.
 */
import type { RaceEvent, RaceState } from '../sim/race';
import type { BoostCue } from '../ui/hud/boostCallouts';
import type { Surface } from '../city/districts/types';

const RUMBLE = {
  /** Re-arm the effect every this many ticks while something is felt. */
  period: 4,
  /** Each effect runs a little past the next re-arm so the motors never gap (ms). */
  durationMs: 100,
  /** A harder hit than the running effect by this much re-arms at once. */
  rearmJump: 0.15,
  /** Impact speed (m/s) of a wall, rail or car hit that runs the strong motor flat out. */
  hitFull: 14,
  /** The weak motor's share of a hit. */
  hitWeak: 0.6,
  /** A broken prop: a knock on the weak motor, half that on the strong. */
  prop: 0.35,
  /** Hits fade by this factor per tick (to a third in about 0.15 s). */
  decay: 0.88,
  /** Bump stop overtravel (m) of a landing that runs the strong motor flat out. */
  bottomFull: 0.08,
  /** Weak motor while scraping a wall: per m/s of slide, and its cap. */
  scrapePerMs: 0.04,
  scrapeMax: 0.6,
  /** Weak motor by surface, reached at roughSpeed (m/s) and scaled down below it. */
  rough: { road: 0, concrete: 0, water: 0, sidewalk: 0.08, grass: 0.18, cobble: 0.22, offroad: 0.3, quay: 0.04 } satisfies Record<Surface, number>,
  roughSpeed: 20,
  /** Weak motor at full wheelspin. */
  wheelspin: 0.25,
  /** Weak motor on the rev limiter: rpm past this share of the redline. */
  limiter: 0.15,
  limiterAt: 0.98,
  /** Both motors under nitrous at stage 1, times the burning stage's share in nitroStage. */
  nitroStrong: 0.12,
  nitroWeak: 0.2,
  nitroStage: [1, 1.3, 1.6],
  /** Reward kicks (strong, weak) from the nitrous callouts: a thousand points, a stage, Max (stage 3) and a full overdrive. */
  chime: [0.08, 0.3],
  stage: [0.2, 0.35],
  max: [0.5, 0.6],
  overdrive: [0.55, 0.7],
  /** Under this both motors are off. */
  floor: 0.03,
} as const;

/** The haptics part of a Gamepad, typed here so older DOM typings do not matter. */
interface Haptics {
  playEffect(type: 'dual-rumble', params: { startDelay: number; duration: number; strongMagnitude: number; weakMagnitude: number }): Promise<unknown>;
  reset?(): Promise<unknown>;
}

export class Rumble {
  /** Fading hit on the strong motor and knock on the weak one (0..1). */
  private hit = 0;
  private knock = 0;
  /** Ticks since the running effect was armed, and its strong magnitude. */
  private age = 0;
  private armed = 0;
  private on = false;

  /** One race event; the session hands over each as it handles them. */
  event(e: RaceEvent): void {
    const mine = e.car === 0 || (e.type === 'crash' && e.traffic === undefined && e.other === 0);
    if (!mine) return;
    if (e.type === 'wall' || e.type === 'crash') {
      const k = Math.min(1, (e.value ?? 0) / RUMBLE.hitFull);
      this.hit = Math.max(this.hit, k);
      this.knock = Math.max(this.knock, k * RUMBLE.hitWeak);
    } else if (e.type === 'prop' || e.type === 'arm' || e.type === 'person') {
      this.hit = Math.max(this.hit, RUMBLE.prop / 2);
      this.knock = Math.max(this.knock, RUMBLE.prop);
    }
  }

  /** A nitrous callout's reward: a kick that fades like a hit (ticks and crashes kick nothing; the wall event already rumbles). */
  boostCue(cue: BoostCue): void {
    const k = cue.kind === 'chime' ? RUMBLE.chime : cue.kind === 'stage' ? (cue.stage >= 3 ? RUMBLE.max : RUMBLE.stage) : cue.kind === 'overdrive' ? RUMBLE.overdrive : null;
    if (!k) return;
    this.hit = Math.max(this.hit, k[0]);
    this.knock = Math.max(this.knock, k[1]);
  }

  /** Once per sim tick, after the tick's events: the player's car through the pad. */
  tick(r: RaceState): void {
    const rc = r.cars[0];
    const c = rc.state;
    this.hit = Math.max(this.hit * RUMBLE.decay, Math.min(1, c.bottomOut / RUMBLE.bottomFull));
    this.knock *= RUMBLE.decay;
    const nitro = c.nitroActive ? RUMBLE.nitroStage[Math.min(RUMBLE.nitroStage.length, c.nitroStage) - 1] : 0;
    const texture =
      RUMBLE.rough[c.surface] * Math.min(1, c.speed / RUMBLE.roughSpeed) +
      Math.max(c.spinFront, c.spinRear) * RUMBLE.wheelspin +
      Math.min(RUMBLE.scrapeMax, c.scrape * RUMBLE.scrapePerMs) +
      (c.rpm >= rc.tuning.engine.redline * RUMBLE.limiterAt ? RUMBLE.limiter : 0) +
      RUMBLE.nitroWeak * nitro;
    const strong = Math.max(this.hit, RUMBLE.nitroStrong * nitro);
    const weak = Math.min(1, Math.max(this.knock, texture));
    if (strong < RUMBLE.floor && weak < RUMBLE.floor) {
      if (this.on) this.silence();
      return;
    }
    if (this.on && ++this.age < RUMBLE.period && strong < this.armed + RUMBLE.rearmJump) return;
    const pad = haptics();
    if (!pad) return;
    pad.playEffect('dual-rumble', { startDelay: 0, duration: RUMBLE.durationMs, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
    this.on = true;
    this.age = 0;
    this.armed = strong;
  }

  /** Stop the motors now and forget any fading hit (pause, finish, the session ending). */
  stop(): void {
    this.hit = 0;
    this.knock = 0;
    if (this.on) this.silence();
  }

  private silence(): void {
    this.on = false;
    void haptics()?.reset?.().catch(() => {});
  }
}

/** The first connected pad that can rumble (the one the input manager reads first). */
function haptics(): Haptics | null {
  const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad?.connected) continue;
    const a = (pad as Gamepad & { vibrationActuator?: Haptics | null }).vibrationActuator;
    return a && typeof a.playEffect === 'function' ? a : null;
  }
  return null;
}
