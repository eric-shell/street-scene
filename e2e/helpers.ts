/** Shared helpers for the browser tests. */
import type { Page } from '@playwright/test';

/** The music player's state as the widget shows it. */
export function music(page: Page) {
  return page.evaluate(() => ({
    title: document.querySelector('.mw-title')?.textContent ?? '',
    playing: document.querySelector('.mw-play')?.getAttribute('aria-label') === 'Pause',
    time: document.querySelector('.mw-time')?.textContent ?? '',
  }));
}

/** One in-page reading of the boot splash and the menu title under it. */
export interface SplashSample {
  splash: boolean;
  /** The splash title's text ('' without a splash). */
  logo: string;
  /** "Tap for sound" style hints on the splash (there must be none). */
  hints: number;
  /** CSS visibility of the menu title, 'none' before the menu exists. */
  head: string;
}

/**
 * Make the page sample its own boot splash every 50 ms until the splash is gone
 * and the menu is up. The city build and software WebGL make every Playwright
 * round trip slow enough to miss the 0.8 s landing, so assertions about what
 * the splash looked like read this log instead (splashLog). Call before goto.
 */
export async function sampleSplash(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __splashLog?: { samples: SplashSample[]; done: boolean } };
    const log: { samples: SplashSample[]; done: boolean } = { samples: [], done: false };
    w.__splashLog = log;
    const tick = setInterval(() => {
      const splash = document.querySelector('.splash');
      const head = document.querySelector('.menu-head');
      log.samples.push({
        splash: !!splash,
        logo: splash?.querySelector('.splash-logo')?.textContent ?? '',
        hints: splash?.querySelectorAll('.splash-hint').length ?? 0,
        head: head ? getComputedStyle(head).visibility : 'none',
      });
      if (!splash && head) {
        log.done = true;
        clearInterval(tick);
      }
    }, 50);
  });
}

/** Wait for the splash to be over, then return every sample taken while it was up or landing. */
export async function splashLog(page: Page): Promise<SplashSample[]> {
  await page.waitForFunction(() => (window as unknown as { __splashLog?: { done: boolean } }).__splashLog?.done === true, undefined, { timeout: 30_000 });
  return page.evaluate(() => (window as unknown as { __splashLog: { samples: SplashSample[] } }).__splashLog.samples);
}
