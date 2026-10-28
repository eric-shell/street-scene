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
 * The landing lights the nitrous: the splash's street floors it with its edges
 * burning through the stage colors, and the menu city revealed under it starts
 * in the race's own nitrous warp (post.ts) at the top stage, which eases out as
 * the title settles (`nitro`, applied by main.ts).
 * Only a page load that lands on the menu shows it; deep links skip it. CSS
 * (_splash.scss: `.splash`, `.menu.is-pending`, `.menu.is-arriving`) does the flash-in, the impact flash and shake
 * and the hazard tape under the title; splashFx.ts draws the night road, traffic,
 * skyline, bokeh and rain behind it on a canvas and floors it into a warp as
 * the title flies. This file times it all and computes the flight.
 */
import { h } from '../kit/dom';
import { SplashFx, startSplashFx } from './splashFx';
import { TAGLINE, TITLE_WORDS, titleWords } from '../menu/title';

export interface Splash {
  /** Resolves once the flash-in has played and the minimum hold is over. */
  readonly intro: Promise<void>;
  /**
   * Resolves once the flash-in has played (fonts, then the CSS's one-shot animations). boot.ts runs the game only
   * then: its boot holds the main thread for seconds, which would freeze the canvas and every animation the
   * compositor cannot run on its own.
   */
  readonly played: Promise<void>;
  /** Keep this menu invisible (but laid out) under the splash until `land`. */
  hold(menuRoot: HTMLElement | null): void;
  /** Fly the title onto the menu's title block, fade the black out and remove the splash. */
  land(menuRoot: HTMLElement | null): Promise<void>;
  /**
   * The nitrous warp the menu city wears as the title lands, at `now` (performance.now() ms): the warp
   * amount (post.ts `setNitroFx`, 0 before the landing), the stage glow (1..3) and the speed blur riding
   * with it (0..1); null once it has burned out.
   */
  nitro(now: number): { warp: number; stage: number; blur: number } | null;
}

const TITLE = TITLE_WORDS.join(' ');

const SPLASH = {
  /** Shortest time the splash stays up after the fonts arrive (s): the flash-in plus a beat of the night road. */
  hold: 3,
  /** The flash-in, from the cue to the last one-shot animation's end (_splash.scss: the film grain, 0.1 s + 2.4 s) (s). */
  flashIn: 2.5,
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
  /** The menu city's nitrous on landing: its peak warp (the top stage's), the stage climbing 1 to 3 over `climb` (s), held at full for `hold` (s), then easing out at `out` (1/s) like a burn ending. */
  nitroPeak: 1.4,
  nitroClimb: 0.45,
  nitroHold: 0.55,
  nitroOut: 2.5,
} as const;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve once the display fonts are usable, or after a short wait so a slow font never stalls the boot. */
function fontsReady(): Promise<unknown> {
  const fonts = document.fonts;
  if (!fonts?.load) return Promise.resolve();
  const load = Promise.all([fonts.load('italic 900 16px "Google Sans Flex"'), fonts.load('900 16px "Google Sans Flex"'), fonts.load('600 16px "Google Sans Flex"')]).catch(() => undefined);
  return Promise.race([load, delay(SPLASH.fontWait * 1000)]);
}

/** The splash boot.ts put up before the game's bundle loaded, null on a deep link or until it runs. */
let booted: Splash | null = null;

/** Puts the splash up at once (boot.ts, the page's first script), so the title shows while the game is still loading. */
export function startBootSplash(): Splash {
  return (booted = showSplash(document.body));
}

/** The splash boot.ts put up, if any. */
export function bootSplash(): Splash | null {
  return booted;
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
  const letters = titleWords((t) => t.split('').map((ch) => h('span', { class: 'splash__letter', style: `--i:${n++}` }, ch)));
  const logo = h('h1', { class: 'logo splash__logo', 'data-text': TITLE }, ...titleWords());
  const rule = h('div', { class: 'title-lockup__rule splash__rule', 'aria-hidden': 'true' });
  const title = h(
    'div',
    { class: 'title-lockup__title splash__title' },
    logo,
    h('div', { class: 'logo splash__copy splash__neon', 'aria-hidden': 'true' }, ...letters),
    h('div', { class: 'logo splash__copy splash__shine', 'aria-hidden': 'true' }, ...titleWords()),
    rule,
  );
  const block = h('div', { class: 'splash__block' }, title, h('div', { class: 'title-lockup__tagline' }, TAGLINE));
  const bg = h('div', { class: 'splash__bg' });
  const canvas = h('canvas', { class: 'splash__fx', 'aria-hidden': 'true' });
  const flash = h('div', { class: 'splash__flash', 'aria-hidden': 'true' });
  const root = h('div', { class: 'splash', role: 'presentation' }, bg, canvas, flash, block);
  parent.append(root);
  let fx: SplashFx | null = null;
  /** When the landing started (performance.now() ms), null before it or with reduced motion. */
  let landedAt: number | null = null;

  let from = '';
  let markPlayed!: () => void;
  const played = new Promise<void>((r) => (markPlayed = r));
  const intro = (async () => {
    await fontsReady();
    // Center the block, enlarged as far as the viewport allows.
    const w = block.offsetWidth;
    const hgt = block.offsetHeight;
    const s = Math.max(1, Math.min(SPLASH.scale, (innerWidth - 2 * SPLASH.gutter) / w, (innerHeight * 0.7) / hgt));
    from = `translate(${(innerWidth - w * s) / 2}px, ${(innerHeight - hgt * s) / 2}px) scale(${s})`;
    block.style.transform = from;
    root.classList.add('is-playing');
    if (reduced) {
      markPlayed();
      return delay(SPLASH.reducedHold * 1000);
    }
    // The night road's horizon sits just under the tagline, wherever the enlarged block ended up.
    fx = startSplashFx(canvas, {
      horizon: () => {
        const bottom = block.getBoundingClientRect().bottom;
        return Math.max(innerHeight * SPLASH.horizonMin, Math.min(innerHeight * SPLASH.horizonMax, bottom + innerHeight * SPLASH.horizonGap));
      },
      title: () => block.getBoundingClientRect(),
    });
    void delay(SPLASH.flashIn * 1000).then(markPlayed);
    await delay(SPLASH.hold * 1000);
  })();

  const menuOf = (menuRoot: HTMLElement | null) => menuRoot?.querySelector<HTMLElement>('.menu') ?? null;

  return {
    intro,
    played,
    hold(menuRoot) {
      menuOf(menuRoot)?.classList.add('is-pending');
    },
    async land(menuRoot) {
      const menu = menuOf(menuRoot);
      const head = menu?.querySelector<HTMLElement>('.title-lockup') ?? null;
      const ms = SPLASH.flight * 1000;
      const anims: Animation[] = [];
      menu?.classList.remove('is-pending');
      if (menu && head && !reduced) {
        // The rest of the menu assembles around the title while it flies in.
        menu.classList.add('is-arriving');
        landedAt = performance.now();
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
      menu?.classList.remove('is-arriving');
      fx?.stop();
      root.remove();
    },
    nitro(now) {
      if (landedAt === null) return reduced ? null : { warp: 0, stage: 1, blur: 0 };
      const t = Math.max(0, (now - landedAt) / 1000);
      const kick = 1 - Math.exp(-t * 12);
      const out = t < SPLASH.nitroHold ? 1 : Math.exp(-(t - SPLASH.nitroHold) * SPLASH.nitroOut);
      const blur = kick * out;
      if (t > SPLASH.nitroHold && blur < 0.002) return null;
      return { warp: SPLASH.nitroPeak * blur, stage: 1 + 2 * Math.min(1, t / SPLASH.nitroClimb), blur };
    },
  };
}
