/**
 * Boot: the splash lands the title on the menu, deep links skip it, and every
 * session opens on the same track. A fresh headless profile refuses audible
 * autoplay like a first-time visitor, which is the path most players get;
 * musicAutoplay.spec.ts covers the returning visitor the browser trusts.
 */
import { expect, test } from '@playwright/test';
import { music } from './helpers';


test.describe('boot splash', () => {
  test('flashes the title in, then lands it on the menu', async ({ page }) => {
    await page.goto('/');
    const splash = page.locator('.splash');
    await expect(splash).toBeVisible();
    await expect(splash.locator('.splash-logo')).toHaveText('STREET SCENE');
    // The menu is laid out underneath, hidden until the title lands on it.
    const head = page.locator('.menu-head');
    await expect(head).toBeHidden();
    await expect(splash).toHaveCount(0);
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
  test('opens on Astrology, waiting for the first gesture when autoplay is refused', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.mw-title')).toHaveText('Astrology');
    // Blocked: the splash says so and nothing plays until the player interacts.
    await expect(page.locator('.splash-hint')).toBeVisible();
    expect((await music(page)).playing).toBe(false);
    await page.mouse.click(640, 360);
    await expect.poll(async () => (await music(page)).playing).toBe(true);
    await expect(page.locator('.splash-hint')).toHaveCount(0);
    expect((await music(page)).title).toBe('Astrology');
  });

  test('starts every session on Astrology from the top, not where the last one left off', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press(']'); // next track (also the first gesture)
    await expect(page.locator('.mw-title')).not.toHaveText('Astrology');
    await page.reload();
    await expect(page.locator('.mw-title')).toHaveText('Astrology');
    await expect(page.locator('.mw-time')).toHaveText(/^0:00/);
  });
});
