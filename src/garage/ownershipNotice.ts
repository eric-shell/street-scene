/**
 * The notice a shared build gets when it arrives wearing parts its car does not own (shared/purchases.ts
 * enforceOwnership took them off): which parts went back to stock, and that races and points unlock them. One
 * wording for both ways a build comes in, a ?build= link at boot (main.ts, over the menu) and a code pasted in
 * the garage (garageUi.ts, in its own dialog), so this module only builds the text and the boot's dialog.
 */
import type { WornPart } from '../shared/purchases';
import { btn, h, iconBtn } from '../ui/kit/dom';
import { Check, Lock, X, icon } from '../ui/kit/icons';

/** The notice's sentence: "You haven't unlocked these for the Wendt Strom R6 yet: ...". */
export function strippedText(carName: string, parts: readonly WornPart[]): string {
  return `You haven't unlocked these for the ${carName} yet: ${parts.map((p) => p.name).join(', ')}. They are back to stock; finish races to earn the points and buy them in the garage.`;
}

/** The notice as a dialog of its own over `root` (OK, Escape or a click outside closes it). */
export function openStrippedNotice(root: HTMLElement, carName: string, parts: readonly WornPart[]): void {
  const close = () => {
    screen.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const ok = btn(Check, 'OK', close, '--primary');
  const screen = h(
    'div',
    { class: 'screen screen--center screen--dim', onclick: (e: Event) => e.target === screen && close() },
    h(
      'div',
      { class: 'dialog panel', role: 'dialog', 'aria-label': 'Parts not unlocked' },
      h('h2', { class: 'title dialog__title' }, icon(Lock, { size: 22 }), 'Parts not unlocked', h('span', { class: 'dialog__spacer' }), iconBtn(X, 'Close', close, '--small')),
      h('div', { class: 'muted' }, strippedText(carName, parts)),
      h('div', { class: 'row' }, ok),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  root.append(screen);
  ok.focus();
}
