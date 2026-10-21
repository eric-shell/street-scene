/**
 * Boot splash. The title and tagline flash in over black while the assets are
 * checked, then fly into their place on the main menu as the black fades out to
 * reveal the city. The splash block is a copy of the menu's title block (same
 * classes and structure: the title on one line sized to the menu's column over
 * its accent rule, then the tagline, all shrink-wrapped, so it measures the same
 * at any width) scaled
 * up and centered; landing is a FLIP transform to the real block's rectangle,
 * after which the real one is shown and the splash removed, so the swap is
 * invisible. The rule pulses on the splash and settles as it lands on the
 * menu's own rule.
 * Only a page load that lands on the menu shows it; deep links skip it. CSS
 * (`.splash*`, `.menu.splash-*`) does the flash-in, the impact flash and shake
 * and the hazard tape under the title; splashFx.ts draws the night road, traffic,
 * skyline, bokeh and rain behind it on a canvas and floors it into a warp as
 * the title flies. This file times it all and computes the flight.
 */
import { h } from './dom';
import { SplashFx, startSplashFx } from './splashFx';
import { TAGLINE, TITLE_WORDS, titleWords } from './menu';

export interface Splash {
  /** Resolves once the flash-in has played and the minimum hold is over. */
  readonly intro: Promise<void>;
  /** Keep this menu invisible (but laid out) under the splash until `land`. */
  hold(menuRoot: HTMLElement | null): void;
  /** Fly the title onto the menu's title block, fade the black out and remove the splash. */
  land(menuRoot: HTMLElement | null): Promise<void>;
}

const TITLE = TITLE_WORDS.join(' ');

const SPLASH = {
  /** Shortest time the splash stays up after the fonts arrive (s): the flash-in plus a beat of the night road. */
  hold: 3,
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
  /** The road's horizon sits this far under the tagline (fraction of the viewport height), within [min, max]. */
  horizonGap: 0.06,
  horizonMin: 0.55,
  horizonMax: 0.86,
  /** The rule under the title stops pulsing and settles to full strength this fast once the flight starts (s). */
  ruleSettle: 0.25,
} as const;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve once the display fonts are usable, or after a short wait so a slow font never stalls the boot. */
function fontsReady(): Promise<unknown> {
  const fonts = document.fonts;
  if (!fonts?.load) return Promise.resolve();
  const load = Promise.all([fonts.load('italic 900 16px "Google Sans Flex"'), fonts.load('900 16px "Google Sans Flex"'), fonts.load('600 16px "Google Sans Flex"')]).catch(() => undefined);
  return Promise.race([load, delay(SPLASH.fontWait * 1000)]);
}

/**
 * There is no "tap for sound" prompt: music and sound try to start at once and,
 * where the browser refuses audible autoplay, start on the first click, tap or
 * key press of any kind (audio/musicPlayer.ts, audio/engineAudio.ts).
 */
export function showSplash(parent: HTMLElement): Splash {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Three copies of the title share the logo's metrics: the gradient one that
  // stays, a per-letter neon layer that flickers on, and a shine that sweeps.
  let n = 0;
  const letters = titleWords((t) => t.split('').map((ch) => h('span', { style: `--i:${n++}` }, ch)));
  const logo = h('h1', { class: 'logo splash-logo', 'data-text': TITLE }, ...titleWords());
  const rule = h('div', { class: 'title-rule splash-rule', 'aria-hidden': 'true' });
  const title = h(
    'div',
    { class: 'head-title splash-title' },
    logo,
    h('div', { class: 'logo splash-copy splash-neon', 'aria-hidden': 'true' }, ...letters),
    h('div', { class: 'logo splash-copy splash-shine', 'aria-hidden': 'true' }, ...titleWords()),
    rule,
  );
  const block = h('div', { class: 'splash-block' }, title, h('div', { class: 'tagline' }, TAGLINE));
  const bg = h('div', { class: 'splash-bg' });
  const canvas = h('canvas', { class: 'splash-fx', 'aria-hidden': 'true' });
  const flash = h('div', { class: 'splash-flash', 'aria-hidden': 'true' });
  const root = h('div', { class: 'splash', role: 'presentation' }, bg, canvas, flash, block);
  parent.append(root);
  let fx: SplashFx | null = null;

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
    // The night road's horizon sits just under the tagline, wherever the enlarged block ended up.
    fx = startSplashFx(canvas, {
      horizon: () => {
        const bottom = block.getBoundingClientRect().bottom;
        return Math.max(innerHeight * SPLASH.horizonMin, Math.min(innerHeight * SPLASH.horizonMax, bottom + innerHeight * SPLASH.horizonGap));
      },
      title: () => block.getBoundingClientRect(),
    });
    await delay(SPLASH.hold * 1000);
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
        // The road floors it into a warp and fades with the black; the rule is gone before the title lands.
        fx?.warp();
        anims.push(canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.7, easing: 'ease-in-out', fill: 'forwards' }));
        // The rule stops pulsing and lands as the menu's own (full strength, full width).
        const ruleFrom = getComputedStyle(rule).opacity;
        rule.style.animation = 'none';
        anims.push(rule.animate([{ opacity: ruleFrom, transform: 'none' }, { opacity: 1, transform: 'none' }], { duration: SPLASH.ruleSettle * 1000, easing: 'ease-out', fill: 'forwards' }));
      } else {
        anims.push(root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 300 : ms, easing: 'ease-in-out', fill: 'forwards' }));
      }
      await Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
      // Same frame: the real title appears exactly where the splash copy stopped.
      menu?.classList.remove('splash-arrive');
      fx?.stop();
      root.remove();
    },
  };
}
