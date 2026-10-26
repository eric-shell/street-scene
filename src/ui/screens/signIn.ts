/**
 * The ways in to an account, in the UI's own pieces so each place asks the same way (only on builds with
 * accounts, and only while signed out):
 *  - signInRow: a place row in the menu's style (rail.ts navRow) that says what an account keeps, or, when
 *    an account signed in on this device before, greets it by name with its picture in the badge; the
 *    menu's home opens Settings on Account with it, the results screen opens the dialog.
 *  - signInContent: Google's button, as wide as its box, over what an account keeps: the top of the Account
 *    page while signed out, and the dialog's body.
 *  - openSignInDialog: that content in a kit dialog over a screen, closed by its button, a click outside,
 *    Escape or signing in. The results screen's row and the garage's note under its builds open it.
 * Signing in reloads the page when the account brought a different save (account.ts), so a place that holds
 * unsaved work (the garage) settles it before it opens the dialog.
 */
import { h, iconBtn, toast } from '../kit/dom';
import { CircleUser, CloudCheck, X, icon } from '../kit/icons';
import { navRow } from '../rail/rail';
import { accountState, accountsEnabled, lastPlayer, onAccountChange, renderGoogleButton } from '../../account/account';

/** What an account keeps, in the row's sub. */
export const SIGN_IN_PITCH = 'Keep your customized vehicles and progress';

/** Whether to ask: a build with accounts and nobody signed in. */
export function wantsSignIn(): boolean {
  return accountsEnabled() && !accountState().player;
}

/** Calls `fn` once when the player signs in while `el` is on the page. */
export function onSignedIn(el: HTMLElement, fn: () => void): void {
  const off = onAccountChange(() => {
    if (!el.isConnected) off();
    else if (accountState().player) {
      off();
      fn();
    }
  });
}

/**
 * Sign in as a place row (hue yellow), or null when there is nothing to ask; it leaves once the player signs
 * in. A returning player's row reads "Continue as" their first name over their email, their picture in the
 * badge (the icon stays if it fails to load).
 */
export function signInRow(onClick: () => void, cls = ''): HTMLButtonElement | null {
  if (!wantsSignIn()) return null;
  const last = lastPlayer();
  const first = last?.name.split(/\s+/)[0];
  const row = navRow(CircleUser, first ? `Continue as ${first}` : 'Sign in', last ? last.email : SIGN_IN_PITCH, 'yellow', onClick, cls);
  if (last) row.title = `Sign in again as ${last.name || last.email}: ${SIGN_IN_PITCH.toLowerCase()}`;
  if (last?.picture) {
    const badge = row.querySelector('.nav-row__badge')!;
    // Google's image host refuses some requests that carry a referrer.
    const img = h('img', { class: 'nav-row__avatar', referrerpolicy: 'no-referrer', alt: '', src: last.picture, onload: () => badge.replaceChildren(img) });
  }
  onSignedIn(row, () => row.remove());
  return row;
}

/** What an account keeps, Google's button and where a failed sign-in says why. */
export function signInContent(): HTMLElement[] {
  const error = h('p', { class: 'account__error', role: 'alert' });
  const google = h('div', { class: 'account__google' });
  renderGoogleButton(google, (m) => (error.textContent = m));
  return [google, error, h('p', { class: 'setting-note' }, 'Keep your garage, your plate name and your settings on every device you play on. Tester accounts only.')];
}

/** The sign-in dialog over `host` (a screen); it closes itself once the player signs in. */
export function openSignInDialog(host: HTMLElement): void {
  const close = () => {
    dialog.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  // Escape closes the dialog, not the screen under it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  const dialog = h(
    'div',
    { class: 'screen screen--center screen--dim', onclick: (e: Event) => e.target === dialog && close() },
    h(
      'div',
      { class: 'dialog panel account', role: 'dialog', 'aria-label': 'Sign in' },
      h('h2', { class: 'title dialog__title' }, icon(CircleUser, { size: 22 }), 'Sign in', h('span', { class: 'dialog__spacer' }), iconBtn(X, 'Close', close, '--small')),
      ...signInContent(),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  host.append(dialog);
  onSignedIn(dialog, () => {
    close();
    toast('Signed in: your garage is saved to your account', CloudCheck);
  });
}
