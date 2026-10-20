/**
 * Boot splash. The title and tagline flash in over black while the assets are
 * checked, then fly into their place on the main menu as the black fades out to
 * reveal the city. The splash block is a copy of the menu's title block (same
 * classes, same column width, so the title wraps the same way) scaled up and
 * centered; landing is a FLIP transform to the real block's rectangle, after
 * which the real one is shown and the splash removed, so the swap is invisible.
 * Only a page load that lands on the menu shows it; deep links skip it. CSS
 * (`.splash*`, `.menu.splash-*`) does the flash-in; this file only times it and
 * computes the flight.
 */
import { h } from './dom';

export interface Splash {
  /** Resolves once the flash-in has played and the minimum hold is over. */
  readonly intro: Promise<void>;
  /** Keep this menu invisible (but laid out) under the splash until `land`. */
  hold(menuRoot: HTMLElement | null): void;
  /** Fly the title onto the menu's title block, fade the black out and remove the splash. */
  land(menuRoot: HTMLElement | null): Promise<void>;
}

export interface SplashOptions {
  /** Asked once the title is up: true shows a "tap for sound" hint (browser refused autoplay). */
  soundBlocked?: () => boolean;
}

const TITLE = 'STREET SCENE';
const TAGLINE = 'Street racing after dark';

const SPLASH = {
  /** Shortest time the splash stays up after the fonts arrive (s): the flash-in plus a beat. */
  hold: 2.4,
  /** Hold with reduced motion, where the flash-in is skipped (s). */
  reducedHold: 0.8,
  /** Flight from the center of the screen onto the menu (s). */
  flight: 0.8,
  /** Largest scale of the splash title relative to the menu's. */
  scale: 1.9,
  /** Side gutter the enlarged title keeps from the viewport edge (px). */
  gutter: 24,
  /** How long to wait for the display fonts before flashing in with fallbacks (s). */
  fontWait: 0.8,
  /** When to ask whether sound is blocked and show the hint (s after the flash-in starts). */
  hintAt: 1.4,
} as const;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve once the display fonts are usable, or after a short wait so a slow font never stalls the boot. */
function fontsReady(): Promise<unknown> {
  const fonts = document.fonts;
  if (!fonts?.load) return Promise.resolve();
  const load = Promise.all([fonts.load('900 16px Orbitron'), fonts.load('600 16px Rajdhani')]).catch(() => undefined);
  return Promise.race([load, delay(SPLASH.fontWait * 1000)]);
}

export function showSplash(parent: HTMLElement, opts: SplashOptions = {}): Splash {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Three copies of the title share the logo's metrics: the gradient one that
  // stays, a per-letter neon layer that flickers on, and a shine that sweeps.
  const letters = TITLE.split('').map((ch, i) => (ch === ' ' ? ' ' : h('span', { style: `--i:${i}` }, ch)));
  const logo = h('h1', { class: 'logo splash-logo', 'data-text': TITLE }, TITLE);
  const title = h(
    'div',
    { class: 'splash-title' },
    logo,
    h('div', { class: 'logo splash-copy splash-neon', 'aria-hidden': 'true' }, ...letters),
    h('div', { class: 'logo splash-copy splash-shine', 'aria-hidden': 'true' }, TITLE),
  );
  const block = h('div', { class: 'splash-block' }, title, h('div', { class: 'tagline' }, TAGLINE));
  const bg = h('div', { class: 'splash-bg' });
  const root = h('div', { class: 'splash', role: 'presentation' }, bg, block);
  parent.append(root);

  let from = '';
  const intro = (async () => {
    await fontsReady();
    // Center the block, enlarged as far as the viewport allows.
    const w = block.offsetWidth;
    const hgt = block.offsetHeight;
    const s = Math.max(1, Math.min(SPLASH.scale, (innerWidth - 2 * SPLASH.gutter) / w, (innerHeight * 0.7) / hgt));
    from = `translate(${(innerWidth - w * s) / 2}px, ${(innerHeight - hgt * s) / 2}px) scale(${s})`;
    block.style.transform = from;
    root.classList.add('go');
    if (reduced) return delay(SPLASH.reducedHold * 1000);
    await delay(SPLASH.hintAt * 1000);
    if (opts.soundBlocked?.()) {
      const hint = h('div', { class: 'splash-hint' }, 'Tap or click for sound');
      root.append(hint);
      const gone = () => hint.remove();
      window.addEventListener('pointerdown', gone, { once: true, capture: true });
      window.addEventListener('keydown', gone, { once: true, capture: true });
    }
    await delay((SPLASH.hold - SPLASH.hintAt) * 1000);
  })();

  const menuOf = (menuRoot: HTMLElement | null) => menuRoot?.querySelector<HTMLElement>('.menu') ?? null;

  return {
    intro,
    hold(menuRoot) {
      menuOf(menuRoot)?.classList.add('splash-hold');
    },
    async land(menuRoot) {
      const menu = menuOf(menuRoot);
      const head = menu?.querySelector<HTMLElement>('.menu-head') ?? null;
      const ms = SPLASH.flight * 1000;
      const anims: Animation[] = [];
      menu?.classList.remove('splash-hold');
      if (menu && head && !reduced) {
        // The rest of the menu assembles around the title while it flies in.
        menu.classList.add('splash-arrive');
        const to = head.getBoundingClientRect();
        anims.push(block.animate([{ transform: from }, { transform: `translate(${to.left}px, ${to.top}px) scale(1)` }], { duration: ms, easing: 'cubic-bezier(0.7, 0, 0.25, 1)', fill: 'forwards' }));
        anims.push(bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' }));
      } else {
        anims.push(root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 300 : ms, easing: 'ease-in-out', fill: 'forwards' }));
      }
      await Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
      // Same frame: the real title appears exactly where the splash copy stopped.
      menu?.classList.remove('splash-arrive');
      root.remove();
    },
  };
}
