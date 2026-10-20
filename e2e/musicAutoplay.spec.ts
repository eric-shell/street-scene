/**
 * A returning visitor the browser trusts: Chromium launched with autoplay
 * allowed (a worker-scoped option, hence its own file) plays the opening track
 * by itself, with no sound hint on the splash.
 */
import { expect, test } from '@playwright/test';
import { music } from './helpers';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

test('plays Astrology by itself under the splash', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.mw-title')).toHaveText('Astrology');
  await expect.poll(async () => (await music(page)).playing).toBe(true);
  await expect(page.locator('.splash')).toBeVisible();
  await expect(page.locator('.splash-hint')).toHaveCount(0);
});
