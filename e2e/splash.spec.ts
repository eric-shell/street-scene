/**
 * Boot: the splash lands the title on the menu, deep links skip it, and every
 * session opens on the same track. A fresh headless profile refuses audible
 * autoplay like a first-time visitor, which is the path most players get;
 * musicAutoplay.spec.ts covers the returning visitor the browser trusts.
 */
import { expect, test } from '@playwright/test';
import { gameStarted, ignoreHeadlessPause, music, sampleSplash, splashLog } from './helpers';

// The trace recorder's snapshots count as a user gesture, which would let the opening track autoplay in the music
// tests: the game starts after DOMContentLoaded (boot.ts), once the recorder has touched the page. Worker-scoped,
// so it is off for the whole file.
test.use({ trace: 'off' });

// The splash lives for a few seconds from the document being parsed, while the page's load event can
// come much later (the music element and the car models keep loading), so every page load here waits
// for the document only (waitUntil: 'domcontentloaded'), never for 'load'.

test.describe('boot splash', () => {
  test('flashes the title in, then lands it on the menu', async ({ page }) => {
    await sampleSplash(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const log = await splashLog(page);
    // The title was up on the splash, and the menu's title stayed hidden underneath it the whole time.
    expect(log.some((s) => s.splash && s.logo === 'STREET SCENE')).toBe(true);
    expect(log.filter((s) => s.splash && s.head === 'visible')).toEqual([]);
    await expect(page.locator('.title-lockup')).toBeVisible();
    await expect(page.locator('.menu .logo')).toHaveText('STREET SCENE');
    await expect(page.locator('.menu .title-lockup__tagline')).toHaveText('midnight street racing club');
    await expect(page.locator('.menu')).not.toHaveClass(/is-pending|is-arriving/);
  });

  test('is skipped by deep links', async ({ page }) => {
    await page.goto('/?garage');
    await expect(page.locator('.splash')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __nr?: { garageScreen?: unknown } }).__nr?.garageScreen)).toBe(true);
    await expect(page.locator('.splash')).toHaveCount(0);
  });
});

test.describe('music', () => {
  test.beforeEach(({ page }) => ignoreHeadlessPause(page));

  test('opens on Astrology and starts on the first interaction when autoplay is refused, without a prompt', async ({ page }) => {
    await sampleSplash(page);
    const started = gameStarted(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await started;
    await expect(page.locator('.music-player__title')).toHaveText('Astrology');
    // Blocked by the browser: nothing plays until the player does anything at all, and the splash
    // never showed a "tap for sound" prompt.
    expect((await music(page)).playing).toBe(false);
    const log = await splashLog(page);
    expect(log.some((s) => s.splash)).toBe(true);
    expect(log.filter((s) => s.splash && s.hints > 0)).toEqual([]);
    expect((await music(page)).playing).toBe(false);
    // Any key counts as the first gesture; Shift does nothing to the menu underneath.
    await page.keyboard.press('Shift');
    await expect.poll(async () => (await music(page)).playing).toBe(true);
    expect((await music(page)).title).toBe('Astrology');
  });

  test('starts every session on Astrology from the top, not where the last one left off', async ({ page }) => {
    let started = gameStarted(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await started;
    await page.keyboard.press(']'); // next track (also the first gesture)
    await expect(page.locator('.music-player__title')).not.toHaveText('Astrology');
    started = gameStarted(page);
    await page.reload();
    await started;
    await expect(page.locator('.music-player__title')).toHaveText('Astrology');
    await expect(page.locator('.music-player__time')).toHaveText(/^0:00/);
  });
});
