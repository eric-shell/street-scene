/**
 * The gamepad off the road and on it, with a fake pad (navigator.getGamepads
 * replaced before boot): the d-pad, A and B work the menu (input/padNav.ts),
 * a race rumbles the pad (input/rumble.ts), leaving the window pauses the race
 * and Start on the pause screen resumes it without the race pausing again.
 */
import { expect, test, type Page } from '@playwright/test';

/** A standard mapping pad the page reads, and what it was asked to play. */
async function fakePad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const log = { effects: [] as { strongMagnitude: number; weakMagnitude: number }[], resets: 0 };
    const pad = {
      id: 'fake pad (STANDARD GAMEPAD)',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons,
      vibrationActuator: {
        playEffect: (_type: string, p: { strongMagnitude: number; weakMagnitude: number }) => (log.effects.push(p), Promise.resolve('complete')),
        reset: () => (log.resets++, Promise.resolve('complete')),
      },
    };
    Object.assign(window, { __pad: { buttons, log } });
    navigator.getGamepads = () => [pad as unknown as Gamepad];
  });
}

/** Hold a pad button for a few frames, then let go. */
async function tap(page: Page, button: number): Promise<void> {
  await setButton(page, button, 1);
  await page.waitForTimeout(250);
  await setButton(page, button, 0);
  await page.waitForTimeout(250);
}

function setButton(page: Page, button: number, value: number): Promise<void> {
  return page.evaluate(
    ([i, v]) => {
      const b = (window as unknown as { __pad: { buttons: { pressed: boolean; value: number }[] } }).__pad.buttons[i];
      b.pressed = v > 0.5;
      b.value = v;
    },
    [button, value] as const,
  );
}

function session(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __nr?: { session?: { paused: boolean; race: { phase: string; tick: number } } } }).__nr?.session;
    const log = (window as unknown as { __pad: { log: { effects: unknown[]; resets: number } } }).__pad.log;
    return { paused: s?.paused ?? null, phase: s?.race.phase ?? null, tick: s?.race.tick ?? 0, effects: log.effects.length, resets: log.resets };
  });
}

test.describe('gamepad', () => {
  test('walks the menu with the d-pad, A and B', async ({ page }) => {
    await fakePad(page);
    await page.goto('/?seed=e2e-pad&quality=low', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.title-lockup')).toBeVisible({ timeout: 30_000 });
    const screen = page.locator('.menu-screen');
    await expect(screen).toHaveAttribute('data-step', 'home');
    // Down from nothing focused lands on the race button, A presses it, B comes back.
    await tap(page, 13);
    await expect(page.locator('.event-card__go')).toBeFocused();
    await tap(page, 0);
    await expect(screen).toHaveAttribute('data-step', 'race');
    await tap(page, 1);
    await expect(screen).toHaveAttribute('data-step', 'home');
  });

  test('rumbles in a race, pauses on blur, and Start resumes it', async ({ page }) => {
    test.setTimeout(120_000);
    await fakePad(page);
    await page.goto('/?race=circuit&seed=e2e-pad&quality=low', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => (await session(page)).tick, { timeout: 60_000 }).toBeGreaterThan(0);
    // Flat out with nitrous held: the limiter on the grid, then the boost, run the motors.
    await setButton(page, 7, 1);
    await setButton(page, 0, 1);
    await expect.poll(async () => (await session(page)).effects, { timeout: 30_000 }).toBeGreaterThan(3);
    await setButton(page, 0, 0);
    await setButton(page, 7, 0);
    // Leaving the window pauses the race and stops the motors.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(async () => (await session(page)).paused).toBe(true);
    expect((await session(page)).resets).toBeGreaterThan(0);
    // The pause screen has no arrow keys of its own: the d-pad moves focus onto its buttons.
    await tap(page, 13);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.rail'))).toBe(true);
    // Start resumes, and the press carried into the race does not pause it again.
    await tap(page, 9);
    await expect.poll(async () => (await session(page)).paused).toBe(false);
    await page.waitForTimeout(500);
    expect((await session(page)).paused).toBe(false);
  });

  test('the garage speaks mph and 0-60', async ({ page }) => {
    await page.goto('/?garage&quality=low', { waitUntil: 'domcontentloaded' });
    const stats = page.locator('.car-card__stats');
    await expect(stats).toContainText('mph', { timeout: 30_000 });
    await expect(stats).toContainText('0-60');
    await expect(stats).not.toContainText('km/h');
  });
});
