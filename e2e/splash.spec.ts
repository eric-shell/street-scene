/**
 * Boot: the splash lands the title on the menu, deep links skip it, and every
 * session opens on the same track. A fresh headless profile refuses audible
 * autoplay like a first-time visitor, which is the path most players get;
 * musicAutoplay.spec.ts covers the returning visitor the browser trusts.
 */
import { expect, test } from '@playwright/test';
import { music } from './helpers';

// The splash lives for a few seconds from the document being parsed, while the page's load event can
// come much later (the music element and the car models keep loading), so every page load here waits
// for the document only (waitUntil: 'domcontentloaded'), never for 'load'.

test.describe('boot splash', () => {
  test('flashes the title in, then lands it on the menu', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const splash = page.locator('.splash');
    await expect(splash).toBeVisible();
    await expect(splash.locator('.splash-logo')).toHaveText('STREET SCENE');
    // The menu is laid out underneath, hidden until the title lands on it. Software WebGL keeps the page
    // busy for seconds, so separate assertions can miss the 0.8 s landing: each poll reads the splash and
    // the menu title in one go, and every reading taken while the splash is up must have the title hidden.
    const head = page.locator('.menu-head');
    const seen: { splash: boolean; head: string }[] = [];
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => {
          const el = document.querySelector('.menu-head');
          return { splash: !!document.querySelector('.splash'), head: el ? getComputedStyle(el).visibility : 'none' };
        });
        seen.push(s);
        return s.splash;
      }, { intervals: [50] })
      .toBe(false);
    expect(seen.filter((s) => s.splash && s.head === 'visible')).toEqual([]);
    await expect(head).toBeVisible();
    await expect(page.locator('.menu .logo')).toHaveText('STREET SCENE');
    await expect(page.locator('.menu .tagline')).toHaveText('Street racing after dark');
    await expect(page.locator('.menu')).not.toHaveClass(/splash-/);
  });

  test('is skipped by deep links', async ({ page }) => {
    await page.goto('/?garage');
    await expect(page.locator('.splash')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __nr?: { garageScreen?: unknown } }).__nr?.garageScreen)).toBe(true);
    await expect(page.locator('.splash')).toHaveCount(0);
  });
});

test.describe('music', () => {
  test('opens on Astrology and starts on the first interaction when autoplay is refused, without a prompt', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.mw-title')).toHaveText('Astrology');
    // Blocked by the browser: no "tap for sound" prompt, nothing plays until the player does anything at all.
    await expect(page.locator('.splash')).toBeVisible();
    await expect(page.locator('.splash-hint')).toHaveCount(0);
    expect((await music(page)).playing).toBe(false);
    await page.mouse.click(640, 360);
    await expect.poll(async () => (await music(page)).playing).toBe(true);
    expect((await music(page)).title).toBe('Astrology');
  });

  test('starts every session on Astrology from the top, not where the last one left off', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.keyboard.press(']'); // next track (also the first gesture)
    await expect(page.locator('.mw-title')).not.toHaveText('Astrology');
    await page.reload();
    await expect(page.locator('.mw-title')).toHaveText('Astrology');
    await expect(page.locator('.mw-time')).toHaveText(/^0:00/);
  });
});
