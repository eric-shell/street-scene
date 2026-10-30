/**
 * Screen transitions between the game's places, so a change of screen is a
 * move rather than a cut, and the heavy work behind it (building a race's
 * world and scene, loading the garage) happens out of sight:
 *  - wipe: the title rule's three colors sweep across the screen as slanted
 *    bands leading a dark title card that names what is coming (the event over
 *    the race type, a line of facts under it), the work runs while the card
 *    covers everything, then the card carries on off the far side, trailing
 *    the bands, to reveal the new screen. Races, free roam, replays and the
 *    way back to the menu.
 *  - door: the garage's roller door drops with a clatter and bounces on its
 *    bottom rail, its neon sign flickers on, the garage (or the street) is set
 *    up behind it, and it rolls back up. Into and out of the garage, and
 *    between its Garage and Street views.
 *  - shift: a new city behind the menu. The city on screen floors its nitrous
 *    (the race's warp, post.ts, climbing to the top stage) while the frame
 *    closes in from the edges, rimmed in the stage colors, onto a dark card
 *    naming the city coming (its seed); the city is built behind the card,
 *    whose speed rays keep turning on the compositor while the build holds the
 *    main thread; then the card opens out from the middle onto the new city,
 *    which arrives in the same warp easing out (the splash landing's curve)
 *    while the menu's cards rise in. The nitrous is a NitroSource the caller
 *    applies to the city per frame, as it does the splash's.
 * All three run the work as a callback and resolve once the new screen shows; a
 * transition asked for while one runs is ignored (a double click). The overlay
 * covers everything, the music widget included, and swallows pointer and key
 * presses while it is up. Reduced motion swaps them for a short fade.
 * Every wipe and shift card stays covered at least `T.cardRead` after the cover lands, so its text finishes arriving and gets read
 * however quick the work is (the door keeps its own short hold: its sign has no cascade). A wipe whose card sets `progress` shows the work's real progress (`loadProgress`):
 * the course line draws and the rule fills as the work reports, instead of a fixed-length animation.
 * Styled by _cover.scss, _wipe.scss, _door.scss and _shift.scss beside this file.
 */
import { h } from '../kit/dom';
import { nextPaint } from '../../shared/anim';
import { uiDoorDown, uiDoorUp, uiWhoosh, uiWipe } from '../../audio/uiSound';

/** Timings (ms) and the bands' slant (deg). */
const T = {
  wipeIn: 440,
  wipeOut: 560,
  slant: 12,
  /** Each colored band's width (px). */
  band: 26,
  doorDown: 600,
  doorUp: 720,
  /** The door stays shut at least this long, so its sign reads. */
  doorHold: 260,
  /** A wipe or shift card stays covered at least this long (ms), measured from when the cover lands: its text cascades in over about 0.86 s (_wipe.scss), then a beat to read, so quick work never lifts a card mid-sentence. */
  cardRead: 1100,
  fade: 220,
  /** The shift: the city flooring it and the frame closing (ms), the card held at least this long (ms), the frame opening onto the new city (ms). */
  shiftIn: 560,
  shiftHold: 380,
  shiftOut: 620,
} as const;

/** The shift's nitrous: the peak warp (the top stage's, post.ts NITRO_FX.stageWarp), held this long into the new city (s), then easing out at this rate (1/s) like a burn ending. */
const SHIFT_NITRO = { peak: 1.4, hold: 0.35, out: 2.6 } as const;

/** A transition's nitrous on the city behind it at `now` (performance.now() ms): the warp (post.ts setNitroFx), the stage glow (1..3) and the speed blur riding with it (0..1); null once it has burned out. */
export interface NitroFrame {
  warp: number;
  stage: number;
  blur: number;
}
export interface NitroSource {
  nitro(now: number): NitroFrame | null;
}

/** What the wipe's card says: the event (small, over), the title, a drawing (the course) and a line of facts under it. */
export interface WipeCard {
  kicker?: string;
  title: string;
  art?: Element;
  sub?: string;
  /** The card stays up at least this long (ms), so a drawing can finish however fast the work is. Never less than `T.cardRead`. */
  hold?: number;
  /** The work reports how far along it is (`loadProgress`): the course line draws and the rule fills with it, instead of sitting full. */
  progress?: boolean;
}

let busy = false;
/** Who waits for the cover to start lifting (uncovered). */
const lifting: (() => void)[] = [];

/** True while a transition covers the screen. */
export function transitioning(): boolean {
  return busy;
}

/**
 * Resolves as the transition covering the screen starts to uncover it, or at once when none does: the
 * moment a screen built under the cover starts its entrance, so it plays in sight.
 */
export function uncovered(): Promise<void> {
  return busy ? new Promise((r) => lifting.push(r)) : Promise.resolve();
}
const lift = () => {
  for (const r of lifting.splice(0)) r();
};

/** Where the covering card shows the work's progress (0..1): the card element whose `--progress` the styles read, or null. */
let progressSink: HTMLElement | null = null;

/** The running work's progress, 0..1 (monotone, clamped): the covering card's line draws and its rule fills as far, each step gliding. A no-op with no card showing progress. */
export function loadProgress(p: number): void {
  progressSink?.style.setProperty('--progress', Math.max(0, Math.min(1, p)).toFixed(3));
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Two frames: the covered screen is on the glass before the work blocks the main thread. */
const painted = nextPaint;

/** Swallow key presses while the screen is covered (key releases still pass, so nothing sticks). */
function blockKeys(): () => void {
  const stop = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', stop, true);
  return () => window.removeEventListener('keydown', stop, true);
}

/** Cover, run the work, uncover: the shared frame of both transitions. */
async function run(overlay: HTMLElement, cover: () => Promise<void>, work: () => void | Promise<void>, uncover: () => Promise<void>, hold = 0): Promise<void> {
  if (busy) return;
  busy = true;
  const unblock = blockKeys();
  document.body.append(overlay);
  try {
    await cover();
    await painted();
    const t0 = performance.now();
    await work();
    // The bar is full when the card is allowed to lift, whatever the work reported.
    loadProgress(1);
    const left = hold - (performance.now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    // The new screen gets its first frame under the cover, so the reveal shows it whole.
    await painted();
    lift();
    await uncover();
  } finally {
    progressSink = null;
    lift();
    overlay.remove();
    unblock();
    busy = false;
  }
}

/** The reduced motion stand-in: a plain fade through the dark. */
function fade(work: () => void | Promise<void>): Promise<void> {
  const el = h('div', { class: 'transition-fade' });
  const anim = (from: number, to: number) => el.animate([{ opacity: from }, { opacity: to }], { duration: T.fade, easing: 'ease', fill: 'forwards' }).finished.then(() => undefined);
  return run(el, () => anim(0, 1), work, () => anim(1, 0));
}

/**
 * The rule wipe: bands and card sweep in from the left to cover the screen,
 * the work runs, and they sweep on out to the right.
 */
export function wipe(card: WipeCard, work: () => void | Promise<void>): Promise<void> {
  if (reduced()) return fade(work);
  const W = innerWidth;
  const H = innerHeight;
  // Slanted, the card's edges lean by ±tan(slant)·H/2 at the top and bottom: wide enough to cover both.
  const lean = Math.tan((T.slant * Math.PI) / 180) * H;
  const panel = W + lean + 40;
  const bands = () => ['yellow', 'orange', 'red'].map((c) => h('i', { class: `wipe__band wipe__band--${c}` }));
  const content = h(
    'div',
    { class: 'wipe__card' },
    card.kicker && h('div', { class: 'wipe__kicker' }, card.kicker),
    h('div', { class: 'wipe__title' }, card.title),
    h('div', { class: 'wipe__rule' }),
    card.art && h('div', { class: 'wipe__art' }, card.art),
    card.sub && h('div', { class: 'wipe__sub' }, card.sub),
  );
  // Leading bands (red first, at the card's edge, then orange and yellow ahead of it), the card, trailing bands.
  const lead = bands().reverse();
  const trail = bands();
  const rig = h('div', { class: 'wipe__rig' }, ...trail, h('div', { class: 'wipe__panel', style: `width:${panel}px` }, content), ...lead);
  const overlay = h('div', { class: 'wipe', role: 'presentation' }, rig);
  const rigW = panel + 6 * T.band;
  const skew = `skewX(-${T.slant}deg)`;
  // Off the left edge, covering (the card's left edge past the screen's at the bottom), off the right edge.
  const xIn = -(rigW + lean / 2 + 20);
  const xCover = -(3 * T.band + lean / 2 + 20);
  const xOut = W + lean / 2 + 20;
  rig.style.width = `${rigW}px`;
  const move = (from: number, to: number, ms: number, easing: string) =>
    rig.animate([{ transform: `translateX(${from}px) ${skew}` }, { transform: `translateX(${to}px) ${skew}` }], { duration: ms, easing, fill: 'forwards' }).finished.then(() => undefined);
  return run(
    overlay,
    () => {
      uiWipe();
      content.classList.add('is-entering');
      if (card.progress) {
        content.classList.add('is-loading');
        content.style.setProperty('--progress', '0');
        progressSink = content;
      }
      return move(xIn, xCover, T.wipeIn, 'cubic-bezier(0.7, 0, 0.3, 1)');
    },
    work,
    () => {
      content.classList.add('is-leaving');
      return move(xCover, xOut, T.wipeOut, 'cubic-bezier(0.6, 0, 0.25, 1)');
    },
    Math.max(card.hold ?? 0, T.cardRead),
  );
}

/**
 * The garage's roller door: it drops and bounces on its rail, its sign (the
 * place behind it) flickers on, the work runs, and it rolls up.
 */
export function door(sign: string, work: () => void | Promise<void>): Promise<void> {
  if (reduced()) return fade(work);
  const curtain = h('div', { class: 'door__curtain' }, h('div', { class: 'door__sign' }, h('span', { class: 'door__sign-text' }, sign)), h('div', { class: 'door__rail' }, h('i', { class: 'door__handle' })));
  const overlay = h('div', { class: 'door', role: 'presentation' }, curtain);
  return run(
    overlay,
    async () => {
      uiDoorDown(T.doorDown / 1000);
      // Falling under its own weight, a bounce off the rail and a smaller one.
      await curtain.animate(
        [
          { transform: 'translateY(-102%)', easing: 'cubic-bezier(0.55, 0, 0.9, 0.5)' },
          { transform: 'translateY(0)', offset: 0.7, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)' },
          { transform: 'translateY(-3.5%)', offset: 0.82, easing: 'cubic-bezier(0.6, 0, 0.8, 0.4)' },
          { transform: 'translateY(0)', offset: 0.92, easing: 'ease-out' },
          { transform: 'translateY(-0.8%)', offset: 0.96 },
          { transform: 'translateY(0)' },
        ],
        { duration: T.doorDown, fill: 'forwards' },
      ).finished;
      overlay.classList.add('is-shut');
    },
    work,
    async () => {
      overlay.classList.remove('is-shut');
      overlay.classList.add('is-opening');
      uiDoorUp(T.doorUp / 1000);
      // A jolt as the motor takes the weight, then up and away.
      await curtain.animate(
        [
          { transform: 'translateY(0)', easing: 'ease-out' },
          { transform: 'translateY(0.6%)', offset: 0.06, easing: 'cubic-bezier(0.5, 0, 0.6, 1)' },
          { transform: 'translateY(-102%)' },
        ],
        { duration: T.doorUp, fill: 'forwards' },
      ).finished;
    },
    // The door's sign is a word that flickers on, no cascade to wait for: its own short hold.
    T.doorHold,
  );
}

/**
 * The shift to a new city behind the menu: `burn` gets the nitrous to put on
 * the city (the one leaving, then the one arriving) at once, the frame closes
 * onto the card, the work builds the new city, and `reveal` runs as the frame
 * opens onto it.
 */
export function shift(card: WipeCard, work: () => void | Promise<void>, burn: (src: NitroSource) => void, reveal?: () => void): Promise<void> {
  if (busy) return Promise.resolve();
  if (reduced()) return fade(work);
  const from = performance.now();
  let arrived: number | null = null;
  burn({
    nitro(now) {
      if (arrived === null) {
        // Flooring it as the frame closes, held at the top stage while the card covers the build.
        const k = Math.min(1, (now - from) / T.shiftIn);
        const e = k * k * (3 - 2 * k);
        return { warp: SHIFT_NITRO.peak * e, stage: 1 + 2 * e, blur: e };
      }
      const t = Math.max(0, (now - arrived) / 1000);
      const out = t < SHIFT_NITRO.hold ? 1 : Math.exp(-(t - SHIFT_NITRO.hold) * SHIFT_NITRO.out);
      return out < 0.002 ? null : { warp: SHIFT_NITRO.peak * out, stage: 3, blur: out };
    },
  });
  const iris = h('div', { class: 'shift__iris' });
  const field = h('div', { class: 'shift__field' }, h('div', { class: 'shift__rays' }));
  const content = h(
    'div',
    { class: 'shift__card' },
    card.kicker && h('div', { class: 'shift__kicker' }, card.kicker),
    h('div', { class: 'shift__title' }, card.title),
    h('div', { class: 'shift__rule' }),
    card.sub && h('div', { class: 'shift__sub' }, card.sub),
  );
  const overlay = h('div', { class: 'shift', role: 'presentation' }, iris, field, content);
  // The iris's radius: past the corners (the city whole) down to below nothing (the rim gone into the dark).
  const open = { '--iris': '64vmax' };
  const shut = { '--iris': '-18vmax' };
  return run(
    overlay,
    async () => {
      uiWipe();
      content.classList.add('is-entering');
      await Promise.all([
        iris.animate([open, shut], { duration: T.shiftIn, easing: 'cubic-bezier(0.5, 0, 0.75, 0.6)', fill: 'forwards' }).finished,
        field.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: T.shiftIn, easing: 'ease-in', fill: 'forwards' }).finished,
      ]);
    },
    work,
    async () => {
      arrived = performance.now();
      reveal?.();
      uiWhoosh();
      content.classList.remove('is-entering');
      content.classList.add('is-leaving');
      await Promise.all([
        field.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T.shiftOut * 0.4, easing: 'ease-out', fill: 'forwards' }).finished,
        iris.animate([shut, open], { duration: T.shiftOut, easing: 'cubic-bezier(0.25, 0.4, 0.3, 1)', fill: 'forwards' }).finished,
      ]);
    },
    Math.max(T.shiftHold, T.cardRead),
  ).finally(() => {
    // A build that threw still lets the warp burn out.
    arrived ??= performance.now();
  });
}
