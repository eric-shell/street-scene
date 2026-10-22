/**
 * Free roam from the menu is a handoff, not a cut: the session takes over the
 * menu city and its cruising car, the camera swings onto the chase view while
 * the menu slides away, and the HUD fades in once it settles. Checked on a
 * real page: no menu left, the HUD up, the sim rolling from the car's pose,
 * and the way back to the menu bringing the street stage back.
 */
import { expect, test, type Page } from '@playwright/test';

/** What the page knows about the running session and the menu's stage (window.__nr, the dev console handle). */
function roam(page: Page) {
  return page.evaluate(() => {
    const nr = (window as unknown as { __nr?: { session?: { race: { tick: number; config: { start?: { tick: number; speed: number } }; cars: { state: { speed: number; x: number; z: number } }[] }; cine: { phase: string } }; stage?: { speed: number; pose: { x: number; z: number } } } }).__nr;
    const s = nr?.session;
    const hud = document.querySelector<HTMLElement>('.hud');
    const tl = document.querySelector<HTMLElement>('.hud__top-left');
    return {
      running: !!s,
      phase: s?.cine.phase ?? null,
      tick: s?.race.tick ?? null,
      start: s?.race.config.start ?? null,
      speed: s?.race.cars[0].state.speed ?? null,
      hud: hud?.className ?? null,
      hudShown: tl ? getComputedStyle(tl).opacity === '1' : false,
      menus: document.querySelectorAll('.rail').length,
      stage: nr?.stage ? { speed: nr.stage.speed, x: nr.stage.pose.x, z: nr.stage.pose.z } : null,
    };
  });
}

test.describe('free roam from the menu', () => {
  test('hands the cruising car over to the player without a cut, then back to the menu', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?seed=e2e-roam&quality=low', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.title-lockup')).toBeVisible({ timeout: 30_000 });
    // The menu's car has to be on the street for the handoff (the stage falls back to the wipe without it).
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __nr?: { stage?: { car: unknown } } }).__nr?.stage?.car), { timeout: 30_000 }).toBe(true);
    await page.locator('.event-card__go').click();
    await page.locator('.mode-tile.mode-roam').click();
    await page.locator('.step-foot__next').click();
    await expect(page.locator('.menu-screen')).toHaveAttribute('data-step', 'setup');
    const before = await roam(page);
    expect(before.running).toBe(false);
    expect(before.stage).not.toBeNull();
    await page.locator('.step-foot__start').click();
    // The session is up at once, in the handoff: the HUD hidden, the menu still sliding away.
    await expect.poll(async () => (await roam(page)).running).toBe(true);
    const early = await roam(page);
    expect(early.phase).toBe('handoff');
    expect(early.hud).toContain('is-handoff');
    expect(early.hudShown).toBe(false);
    // It carries on from the car as it was: the start pose is where the stage car stood, rolling at its speed.
    expect(early.start).not.toBeNull();
    expect(early.start!.speed).toBeCloseTo(before.stage!.speed, 0);
    expect(early.start!.tick).toBeGreaterThan(0);
    // The swing settles in about two seconds: the menu is gone, the HUD is up and the car is still rolling.
    await expect.poll(async () => (await roam(page)).phase, { timeout: 15_000 }).toBe('none');
    await expect.poll(async () => (await roam(page)).hudShown, { timeout: 15_000 }).toBe(true);
    const after = await roam(page);
    expect(after.menus).toBe(0);
    expect(after.hud).toContain('hud--open-world');
    expect(after.hud).not.toContain('is-handoff');
    expect(after.speed).toBeGreaterThan(1);
    expect(after.tick).toBeGreaterThan(early.start!.tick);
    // The pause screen works, and quitting it brings the menu and its street stage back.
    await page.keyboard.press('Escape');
    await expect(page.locator('.pause-screen')).toBeVisible();
    await page.locator('.pause-screen .nav-row.hue-red').click();
    await expect(page.locator('.title-lockup')).toBeVisible({ timeout: 30_000 });
    const back = await roam(page);
    expect(back.running).toBe(false);
    expect(back.stage).not.toBeNull();
    expect(back.menus).toBe(1);
  });
});
