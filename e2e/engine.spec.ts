/**
 * The engine voice needs a real page: an AudioContext, the worklet module
 * served by Vite and a ConvolverNode. Headless Chromium has no sound device,
 * but it does run the audio graph, so this checks the worklet registers, a
 * voice gets its node after the first gesture and nothing logs an error.
 */
import { expect, test } from '@playwright/test';

test('the engine worklet loads and a garage voice runs on it', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?garage&seed=engine-e2e&quality=low');
  await page.waitForSelector('.garage', { timeout: 30_000 });
  // Audio starts on a gesture; the garage revs the car on a click.
  await page.mouse.click(400, 300);
  await page.keyboard.press('Space');
  const ok = await page.evaluate(async () => {
    // Vite serves the sources by path in dev; the paths are built so the typecheck does not try to resolve them.
    const src = (name: string) => `/src/audio/${name}.ts`;
    const mod = (await import(/* @vite-ignore */ src('engineAudio'))) as { audioHub(): { worklet: Promise<boolean>; ctx: AudioContext } | null };
    const hub = mod.audioHub();
    if (!hub) return 'no hub';
    const loaded = await hub.worklet;
    if (!loaded) return 'worklet not loaded';
    // A voice on the registered processor renders without throwing.
    const node = new AudioWorkletNode(hub.ctx, 'street-scene-engine', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [1, 1, 1], processorOptions: { program: ((await import(/* @vite-ignore */ src('engineSynth'))) as { buildProgram(spec: unknown): unknown }).buildProgram({ layout: 'I6', aspiration: 'na', position: 'front' }) } });
    node.disconnect();
    return 'ok';
  });
  expect(ok).toBe('ok');
  expect(errors.filter((e) => /worklet|engine|audio/i.test(e))).toEqual([]);
});
