/**
 * Nitrous callouts, Burnout style: every way of earning nitrous pops up over
 * the dial cluster with what it is paying, so the style that fills the tank
 * is named the moment it pays and racers go looking for more. A drift, a
 * wall skim (near miss) and a slipstream each get one live callout that
 * counts up while it pays and holds a moment after; filling a stage, banking
 * a full overdrive and a chain refill are one shot calls; a wreck (a prop
 * knocked down) is live too, so a row of cans counts up as one call, and so is
 * a crash into a wall, barrier or rail, counting what it cost; a reset is a one
 * shot call of what it emptied (not held against the style score). Points are
 * thousandths of a stage (+1,000 is a whole stage, one bar length; a full tank
 * is 3,000), colored by the stage they went into (4 is overdrive, the spill
 * past a full tank): big numbers read as a payout where hundredths read as a meter.
 * The number on screen rolls up to what was paid rather than jumping, so a chain
 * refill spins up to its thousand and a drift's count keeps climbing smoothly;
 * every hundred it rolls past ticks (a cue whose pitch climbs with the count)
 * and every thousand chimes and pulses the callout.
 *
 * Fed once per sim tick from the player's CarState telemetry (nitroGain,
 * nitroLoss, nitroReset, nitroChain, nitro, nitroOver), so a replay calls the same things
 * and tallies the same style score (`tally`, the results screen's); the timers
 * and the roll run on frame time. Cues (`onCue`) go to the session's sounds and
 * rumble. Plain DOM in the HUD's dial cluster (_boost-callouts.scss): one
 * element per callout, its text written only when the number changes.
 */
import { damp } from '../../shared/anim';
import { nitroFullStages } from '../../sim/car';
import type { CarState } from '../../sim/car';
import { NITRO_STAGES } from '../../sim/tuning';
import { prefersReducedMotion } from '../kit/dom';

/** Timing (s) and limits. */
const CALLOUT = {
  /** A live callout holds this long after its source stops paying. */
  hold: 0.9,
  /** A one shot call shows this long, and a stage 3 (Max) or overdrive call this long. */
  shot: 1.5,
  bigShot: 2.2,
  /** The fade out at the end (_boost-callouts.scss transitions over the same time). */
  fade: 0.35,
  /** At most this many on screen; the oldest fades first. */
  max: 4,
  /** A live source shows once it has paid this much (stages), so a one tick graze does not flash +0. */
  minShow: 0.005,
  /** Points a whole stage is worth. */
  perStage: 1000,
  /** How fast the number on screen rolls up to what was paid (1/s), and the least it climbs (points/s) so the tail lands. */
  roll: 9,
  rollMin: 400,
  /** A tick cue every this many points rolled past, a chime every `chime`. */
  tick: 100,
  chime: 1000,
  /** Overdrive within this of its cap counts as banked full (stages). */
  fullSlack: 1e-6,
} as const;

/** The callouts' stage for points that spilled past a full tank into overdrive. */
export const OVERDRIVE_STAGE = NITRO_STAGES + 1;

type LiveKind = 'drift' | 'nearMiss' | 'draft' | 'wreck' | 'crash';
type Kind = LiveKind | 'chain' | 'stage' | 'overdrive' | 'reset';
/** Where the style score's points came from: every live kind (crash counts against it). */
export type StyleSource = LiveKind;

const NAME: Record<LiveKind | 'chain' | 'reset', string> = { drift: 'Drift', nearMiss: 'Near miss', draft: 'Slipstream', wreck: 'Wreck', crash: 'Crash', chain: 'Chain boost', reset: 'Reset' };

/**
 * What the callouts tell the sounds and rumble: `tick` as a number rolls past
 * another hundred (`step`, its hundreds so far, sets the pitch), `chime` past
 * another thousand, `stage` when one comes full (3 is Max), `overdrive` when it
 * banks full, `crash` when a hit first costs nitrous.
 */
export type BoostCue = { kind: 'tick'; step: number } | { kind: 'chime'; thousands: number } | { kind: 'stage'; stage: number } | { kind: 'overdrive' } | { kind: 'crash' };

/** The race's style score in points: what each source paid (drift includes the zones) and what crashes cost (positive). */
export type StyleTally = Record<StyleSource, number>;

/** The style score: everything style paid less what crashes cost, never below 0. */
export function styleTotal(t: StyleTally): number {
  return Math.max(0, Math.round(t.drift + t.nearMiss + t.draft + t.wreck - t.crash));
}

interface Callout {
  kind: Kind;
  /** Stages paid so far (live callouts), lost (a crash) or put back (a chain). */
  amount: number;
  /** Seconds left before it fades (refilled while a live source pays). */
  life: number;
  /** A drift that a drift zone paid into: named Zone drift. */
  zone: boolean;
  /** Stage the points went into (1..OVERDRIVE_STAGE), the color. */
  stage: number;
  el: HTMLElement | null;
  pts: HTMLElement | null;
  /** The number rolling up on screen (points), and the whole number last written, so the text is written only when it changes. */
  rolling: number;
  shown: number;
  /** Fading out: no longer counts or takes points. */
  out: boolean;
}

export class BoostCallouts {
  readonly el: HTMLDivElement;
  /** This race's style score so far, by source (points). */
  readonly tally: StyleTally = { drift: 0, nearMiss: 0, draft: 0, wreck: 0, crash: 0 };
  /** Sounds and rumble for what the callouts call (the session's). */
  onCue: ((cue: BoostCue) => void) | null = null;
  private readonly items: Callout[] = [];
  /** Full stages last tick (-1 before the first), to call a stage the moment it fills. */
  private lastFull = -1;
  /** Overdrive banked full last tick, to call it the moment it fills (true before the first tick, so a cap of 0 never calls). */
  private lastOverFull = true;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'boost-callouts';
  }

  /** One sim tick of the player's car: what each style source paid, any crash, reset or chain refill, the tank and overdrive (`overCap`, nitrous.overdriveCap). */
  tick(c: Pick<CarState, 'nitro' | 'nitroOver' | 'nitroChain' | 'nitroGain' | 'nitroLoss' | 'nitroReset'>, overCap: number): void {
    const full = nitroFullStages(c.nitro);
    // Points land in the stage being filled, overdrive once the tank is full.
    const filling = Math.min(OVERDRIVE_STAGE, full + 1);
    const g = c.nitroGain;
    this.pay('drift', g.drift + g.zone, filling, g.zone > 0);
    this.pay('nearMiss', g.nearMiss, filling, false);
    this.pay('draft', g.draft, filling, false);
    this.pay('wreck', g.wreck, filling, false);
    if (c.nitroLoss > 0 && !this.items.some((x) => x.kind === 'crash' && !x.out)) this.onCue?.({ kind: 'crash' });
    this.pay('crash', c.nitroLoss, filling, false);
    if (c.nitroReset > 0) this.shot('reset', c.nitroReset, filling);
    const overFull = c.nitroOver >= overCap - CALLOUT.fullSlack;
    if (c.nitroChain > 0) this.shot('chain', c.nitroChain, 1);
    // A stage that filled from style (a chain's refill is called as the chain).
    else if (this.lastFull >= 0 && full > this.lastFull) this.shot('stage', 0, full);
    else if (overFull && !this.lastOverFull) this.shot('overdrive', 0, OVERDRIVE_STAGE);
    this.lastFull = full;
    this.lastOverFull = overFull;
  }

  /** Per frame: roll the numbers up, count down, fade and drop callouts. */
  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      this.roll(it, dt);
      it.life -= dt;
      if (!it.out && it.life <= 0) this.fade(it);
      else if (it.out && it.life <= 0) {
        it.el?.remove();
        this.items.splice(i, 1);
      }
    }
  }

  private pay(kind: LiveKind, amount: number, stage: number, zone: boolean): void {
    if (amount <= 0) return;
    this.tally[kind] += amount * CALLOUT.perStage;
    let it = this.items.find((x) => x.kind === kind && !x.out);
    if (!it) {
      it = { kind, amount: 0, life: 0, zone: false, stage, el: null, pts: null, rolling: 0, shown: -1, out: false };
      this.items.push(it);
    }
    it.amount += amount;
    it.life = CALLOUT.hold;
    const intoZone = zone && !it.zone;
    it.zone ||= zone;
    if (it.amount < CALLOUT.minShow) return;
    if (!it.el) this.show(it, it.zone ? 'Zone drift' : NAME[kind]);
    else if (intoZone) it.el.firstChild!.textContent = 'Zone drift';
    if (it.stage !== stage) {
      it.stage = stage;
      it.el!.dataset.stage = String(stage);
    }
  }

  private shot(kind: 'chain' | 'stage' | 'overdrive' | 'reset', amount: number, stage: number): void {
    const big = kind === 'overdrive' || (kind === 'stage' && stage === NITRO_STAGES);
    const it: Callout = { kind, amount, life: big ? CALLOUT.bigShot : CALLOUT.shot, zone: false, stage, el: null, pts: null, rolling: 0, shown: -1, out: false };
    this.items.push(it);
    if (kind === 'chain' || kind === 'reset') this.show(it, NAME[kind]);
    else if (kind === 'overdrive') this.show(it, 'Overdrive', 'Ready');
    else this.show(it, `Stage ${stage}`, stage === NITRO_STAGES ? 'Max' : 'Ready');
    if (big) it.el!.classList.add('boost-callout--big');
    if (kind === 'stage') this.onCue?.({ kind: 'stage', stage });
    else if (kind === 'overdrive') this.onCue?.({ kind: 'overdrive' });
    else if (kind === 'reset') this.onCue?.({ kind: 'crash' });
  }

  /** Start a callout's fade: it no longer takes points, and a source that pays again gets a new one. */
  private fade(it: Callout): void {
    it.out = true;
    it.life = CALLOUT.fade;
    it.el?.classList.add('is-leaving');
  }

  /** Put a callout on screen, newest nearest the bar; past the limit the oldest one shot calls go first, then the oldest of the rest. */
  private show(it: Callout, name: string, tag?: string): void {
    const el = document.createElement('div');
    el.className = 'boost-callout';
    el.dataset.kind = it.kind;
    el.dataset.stage = String(it.stage);
    const b = document.createElement('b');
    b.className = 'boost-callout__label';
    b.textContent = name;
    const pts = document.createElement('span');
    pts.className = 'boost-callout__points';
    if (tag) pts.textContent = tag;
    el.append(b, pts);
    this.el.append(el);
    it.el = el;
    it.pts = pts;
    const older = this.items.filter((x) => x.el && !x.out && x !== it);
    let extra = older.length + 1 - CALLOUT.max;
    for (const shots of [true, false]) {
      for (const x of older) {
        if (extra <= 0) return;
        if (!x.out && (x.kind === 'chain' || x.kind === 'stage' || x.kind === 'overdrive' || x.kind === 'reset') === shots) {
          this.fade(x);
          extra--;
        }
      }
    }
  }

  /**
   * Ease the number on screen toward what the callout has paid (frame-rate independent), writing it only
   * when the whole number changes; cue a tick for every hundred it rolls past and a chime (and a pulse)
   * for every thousand. A crash or a reset counts its loss with a minus and never chimes.
   */
  private roll(it: Callout, dt: number): void {
    if (!it.pts || it.kind === 'stage' || it.kind === 'overdrive') return;
    const target = it.amount * CALLOUT.perStage;
    const gap = target - it.rolling;
    if (gap <= 0) return;
    const from = it.rolling;
    it.rolling = Math.min(target, it.rolling + Math.max(gap * damp(CALLOUT.roll, dt), CALLOUT.rollMin * dt));
    const n = Math.round(it.rolling);
    if (n === it.shown) return;
    it.shown = n;
    const loss = it.kind === 'crash' || it.kind === 'reset';
    it.pts.textContent = `${loss ? '−' : '+'}${n.toLocaleString('en-US')}`;
    if (loss) return;
    const thousands = Math.floor(it.rolling / CALLOUT.chime);
    if (thousands > Math.floor(from / CALLOUT.chime)) {
      this.onCue?.({ kind: 'chime', thousands });
      if (it.el && !prefersReducedMotion()) it.el.animate([{ transform: 'scale(1.3)', filter: 'brightness(1.8)' }, { transform: 'none', filter: 'none' }], { duration: 380, easing: 'cubic-bezier(0.3, 1.5, 0.5, 1)' });
    } else {
      const step = Math.floor(it.rolling / CALLOUT.tick);
      if (step > Math.floor(from / CALLOUT.tick)) this.onCue?.({ kind: 'tick', step });
    }
  }
}
