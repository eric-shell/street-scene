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
