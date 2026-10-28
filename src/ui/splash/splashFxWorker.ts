/**
 * The splash street's worker (splashFx.ts): draws it into the OffscreenCanvas the splash hands over, on its own
 * thread, so the street keeps moving while the game's boot holds the main thread. splash.ts terminates it when
 * the splash is removed.
 */
import { runSplashFx, type SplashFxMessage, type SplashFxRun } from './splashFx';

let run: SplashFxRun | null = null;

addEventListener('message', (e: MessageEvent<SplashFxMessage>) => {
  const m = e.data;
  if (m.type === 'start') {
    const ctx = m.canvas.getContext('2d');
    if (ctx) run = runSplashFx(ctx, m.view);
  } else if (m.type === 'resize') run?.resize(m.view);
  else run?.warp();
});
// Loaded: the splash hands the canvas over only to a worker that answers.
(self as unknown as { postMessage(m: unknown): void }).postMessage('ready');
