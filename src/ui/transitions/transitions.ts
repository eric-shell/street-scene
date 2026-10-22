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
 * Both run the work as a callback and resolve once the new screen shows; a
 * transition asked for while one runs is ignored (a double click). The overlay
 * covers everything, the music widget included, and swallows pointer and key
 * presses while it is up. Reduced motion swaps both for a short fade.
 * Styled by _cover.scss, _wipe.scss and _door.scss beside this file.
 */
import { h } from '../kit/dom';
import { uiDoorDown, uiDoorUp, uiWipe } from '../../audio/uiSound';

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
  fade: 220,
} as const;

/** What the wipe's card says: the event (small, over), the title, a drawing (the course) and a line of facts under it. */
export interface WipeCard {
  kicker?: string;
  title: string;
  art?: Element;
  sub?: string;
  /** The card stays up at least this long (ms), so a drawing can finish however fast the work is. */
  hold?: number;
}

let busy = false;

/** True while a transition covers the screen. */
export function transitioning(): boolean {
  return busy;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Two frames: the covered screen is on the glass before the work blocks the main thread. */
const painted = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

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
    const left = hold - (performance.now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    // The new screen gets its first frame under the cover, so the reveal shows it whole.
    await painted();
    await uncover();
  } finally {
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
      return move(xIn, xCover, T.wipeIn, 'cubic-bezier(0.7, 0, 0.3, 1)');
    },
    work,
    () => {
      content.classList.add('is-leaving');
      return move(xCover, xOut, T.wipeOut, 'cubic-bezier(0.6, 0, 0.25, 1)');
    },
    card.hold ?? 0,
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
    T.doorHold,
  );
}
