/**
 * A race opens the same full city map as free roam and the menu: a click on
 * the minimap pauses the race under the map, which shows the race's course
 * under its type's name, and Escape closes it and lets the race run on.
 * Checked on a real page because it is DOM, pointer and keys end to end.
 */
import { expect, test, type Page } from '@playwright/test';

/** The running session as the dev console handle (window.__nr) sees it. */
function race(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __nr?: { session?: { paused: boolean; mapOpen: boolean; race: { tick: number }; cine: { phase: string } } } }).__nr?.session;
    return s ? { paused: s.paused, mapOpen: s.mapOpen, tick: s.race.tick, phase: s.cine.phase } : null;
  });
}

test.describe('the city map in a race', () => {
  test('a click on the minimap opens the course map over the paused race, Escape closes it', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?race=sprint&seed=e2e-map&quality=low', { waitUntil: 'domcontentloaded' });
    // The intro cinematic ignores the map; wait until the race is the player's.
    await expect.poll(async () => (await race(page))?.phase ?? null, { timeout: 60_000 }).toBe('none');
    await page.locator('.hud-map').click();
    const modal = page.locator('.fullmap-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.fullmap-chip.course')).toHaveText('Sprint');
    const open = await race(page);
    expect(open?.mapOpen).toBe(true);
    expect(open?.paused).toBe(true);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    const closed = await race(page);
    expect(closed?.mapOpen).toBe(false);
    expect(closed?.paused).toBe(false);
    // No pause screen: Escape closed the map, not the race.
    await expect(page.locator('.rail-screen.pause')).toHaveCount(0);
  });
});
