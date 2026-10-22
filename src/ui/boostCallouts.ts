/**
 * Nitrous callouts, Burnout style: every way of earning nitrous pops up over
 * the dial cluster with what it is paying, so the style that fills the tank
 * is named the moment it pays and racers go looking for more. A drift, a
 * wall skim (near miss) and a slipstream each get one live callout that
 * counts up while it pays and holds a moment after; filling a stage and a
 * chain refill are one shot calls. Points are hundredths of a stage (+100 is
 * a whole stage, one bar length), colored by the stage they went into.
 *
 * Fed once per sim tick from the player's CarState telemetry (nitroGain,
 * nitroChain, nitro), so a replay calls the same things; the timers run on
 * frame time. Plain DOM in the HUD's dial cluster (hud/_nitro.scss): one
 * element per callout, its text written only when the number changes.
 */
import { nitroFullStages } from '../sim/car';
import type { CarState } from '../sim/car';
import { NITRO_STAGES } from '../sim/tuning';

/** Timing (s) and limits. */
const CALLOUT = {
  /** A live callout holds this long after its source stops paying. */
  hold: 0.9,
  /** A one shot call shows this long. */
  shot: 1.5,
  /** The fade out at the end (hud/_nitro.scss transitions over the same time). */
  fade: 0.35,
  /** At most this many on screen; the oldest fades first. */
  max: 4,
  /** A live source shows once it has paid this much (stages), so a one tick graze does not flash +0. */
  minShow: 0.005,
} as const;

type LiveKind = 'drift' | 'nearMiss' | 'draft';
type Kind = LiveKind | 'chain' | 'stage';

const NAME: Record<LiveKind | 'chain', string> = { drift: 'Drift', nearMiss: 'Near miss', draft: 'Slipstream', chain: 'Chain boost' };

interface Callout {
  kind: Kind;
  /** Stages paid so far (live callouts) or put back (a chain). */
  amount: number;
  /** Seconds left before it fades (refilled while a live source pays). */
  life: number;
  /** A drift that a drift zone paid into: named Zone drift. */
  zone: boolean;
  /** Stage the points went into (1..NITRO_STAGES), the color. */
  stage: number;
  el: HTMLElement | null;
  pts: HTMLElement | null;
  /** The number on screen, so the text is written only when it changes. */
  shown: number;
  /** Fading out: no longer counts or takes points. */
  out: boolean;
}

export class BoostCallouts {
  readonly el: HTMLDivElement;
  private readonly items: Callout[] = [];
  /** Full stages last tick (-1 before the first), to call a stage the moment it fills. */
  private lastFull = -1;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'hud-callouts';
  }

  /** One sim tick of the player's car: what each style source paid, any chain refill, and the tank. */
  tick(c: Pick<CarState, 'nitro' | 'nitroChain' | 'nitroGain'>): void {
    const full = nitroFullStages(c.nitro);
    // Points land in the stage being filled (the top one once the tank is full).
    const filling = Math.min(NITRO_STAGES, full + 1);
    const g = c.nitroGain;
    this.pay('drift', g.drift + g.zone, filling, g.zone > 0);
    this.pay('nearMiss', g.nearMiss, filling, false);
    this.pay('draft', g.draft, filling, false);
    if (c.nitroChain > 0) this.shot('chain', c.nitroChain, 1);
    // A stage that filled from style (a chain's refill is called as the chain).
    else if (this.lastFull >= 0 && full > this.lastFull) this.shot('stage', 0, full);
    this.lastFull = full;
  }

  /** Per frame: count down, fade and drop callouts. */
  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
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
    let it = this.items.find((x) => x.kind === kind && !x.out);
    if (!it) {
      it = { kind, amount: 0, life: 0, zone: false, stage, el: null, pts: null, shown: -1, out: false };
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
    this.points(it);
  }

  private shot(kind: 'chain' | 'stage', amount: number, stage: number): void {
    const it: Callout = { kind, amount, life: CALLOUT.shot, zone: false, stage, el: null, pts: null, shown: -1, out: false };
    this.items.push(it);
    if (kind === 'chain') {
      this.show(it, NAME.chain);
      this.points(it);
    } else this.show(it, `Stage ${stage}`, stage === NITRO_STAGES ? 'Max' : 'Ready');
  }

  /** Start a callout's fade: it no longer takes points, and a source that pays again gets a new one. */
  private fade(it: Callout): void {
    it.out = true;
    it.life = CALLOUT.fade;
    it.el?.classList.add('out');
  }

  /** Put a callout on screen, newest nearest the bar; past the limit the oldest one shot calls go first, then the oldest of the rest. */
  private show(it: Callout, name: string, tag?: string): void {
    const el = document.createElement('div');
    el.className = 'hud-callout';
    el.dataset.kind = it.kind;
    el.dataset.stage = String(it.stage);
    const b = document.createElement('b');
    b.textContent = name;
    const pts = document.createElement('span');
    pts.className = 'pts';
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
        if (!x.out && (x.kind === 'chain' || x.kind === 'stage') === shots) {
          this.fade(x);
          extra--;
        }
      }
    }
  }

  private points(it: Callout): void {
    const n = Math.round(it.amount * 100);
    if (n === it.shown || !it.pts) return;
    it.shown = n;
    it.pts.textContent = `+${n}`;
  }
}
