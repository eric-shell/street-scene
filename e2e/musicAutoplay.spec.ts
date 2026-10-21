/**
 * A returning visitor the browser trusts: Chromium launched with autoplay
 * allowed (a worker-scoped option, hence its own file) plays the opening track
 * by itself, with no sound hint on the splash.
 */
import { expect, test } from '@playwright/test';
import { ignoreHeadlessPause, music } from './helpers';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

/** What the page looked like the moment the splash was removed. */
type SplashGone = { playing: boolean; hint: number };

test('plays Astrology by itself under the splash', async ({ page }) => {
  await ignoreHeadlessPause(page);
  // Software WebGL keeps the page busy for seconds and the landing takes 0.8 s, so polling from the test
  // can miss the splash entirely. The page records the player's state itself, in the same task that
  // removes the splash: the music must already be playing then, and the splash must have had no hint.
  await page.addInitScript(() => {
    const w = window as unknown as { __splashGone?: SplashGone };
    new MutationObserver((records, observer) => {
      for (const r of records)
        for (const n of r.removedNodes)
          if (n instanceof HTMLElement && n.classList.contains('splash')) {
            w.__splashGone = { playing: document.querySelector('.mw-play')?.getAttribute('aria-label') === 'Pause', hint: n.querySelectorAll('.splash-hint').length };
            observer.disconnect();
          }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.mw-title')).toHaveText('Astrology');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __splashGone?: SplashGone }).__splashGone ?? null)).toEqual({ playing: true, hint: 0 });
  expect((await music(page)).playing).toBe(true);
});
