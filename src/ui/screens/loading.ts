/** The loading card: the logo, what is loading and a sweeping bar in the rule's colors (_loading.scss). */
import { h } from '../kit/dom';

export function loadingScreen(what?: string): HTMLElement {
  return h(
    'div',
    { class: 'loading', role: 'status' },
    h('div', { class: 'logo' }, 'STREET SCENE'),
    h('div', { class: 'loading__label' }, what ? `Loading ${what}` : 'Loading'),
    h('div', { class: 'loading__bar', 'aria-hidden': 'true' }, h('i', { class: 'loading__bar-fill' })),
  );
}
