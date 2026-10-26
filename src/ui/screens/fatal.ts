/**
 * The card for when the game cannot draw: no WebGL at boot (an old phone, a blocklisted GPU, hardware
 * acceleration turned off), or the GPU dropping the context mid game (low memory, a long while in the
 * background). Either way the honest fix is a reload or another browser, so the card says what happened, that
 * nothing saved is lost, and offers the reload. Styled by _fatal.scss, over everything (the music widget too).
 */
import { btn, h } from '../kit/dom';
import { RotateCcw } from '../kit/icons';

export type FatalKind = 'webgl' | 'context';

const COPY: Record<FatalKind, { title: string; body: string[] }> = {
  webgl: {
    title: 'No 3D graphics here',
    body: [
      'Street Scene needs WebGL, and this browser could not start it.',
      'Turn on hardware acceleration in the browser settings, update the browser, or try Chrome, Edge, Firefox or Safari.',
    ],
  },
  context: {
    title: 'The graphics reset',
    body: ['Your device dropped the game’s graphics, which happens when memory runs low.', 'Reload to carry on. Your garage and best times are saved.'],
  },
};

/** The card, once: a second call while one is up returns that one. */
export function showFatal(kind: FatalKind): HTMLElement {
  const up = document.querySelector<HTMLElement>('.fatal');
  if (up) return up;
  const c = COPY[kind];
  const el = h(
    'div',
    { class: 'fatal', role: 'alertdialog', 'aria-labelledby': 'fatal-title' },
    h('div', { class: 'logo' }, 'STREET SCENE'),
    h('h1', { class: 'fatal__title', id: 'fatal-title' }, c.title),
    ...c.body.map((p) => h('p', { class: 'fatal__text' }, p)),
    btn(RotateCcw, 'Reload', () => location.reload(), '--large --primary --cta'),
  );
  document.body.append(el);
  return el;
}
