/**
 * The sign-in prompt at the top of the menu's home step: the first thing a signed-out player can act on
 * after the splash (which takes no input). One compact row, why and Google's button (short screens drop the
 * why), so it costs home little height. Not now hides it until the next page load; signing in removes it (or reloads the page
 * when the account brought a different save). Only on builds with accounts. Styled by _sign-in-card.scss.
 */
import { h, iconBtn } from '../kit/dom';
import { X } from '../kit/icons';
import { accountState, accountsEnabled, onAccountChange, renderGoogleButton } from '../../account/account';

/** Not now was pressed on this page load. */
let dismissed = false;

/** The card, or nothing when the build has no accounts, the player is signed in or dismissed it. */
export function signInCard(): HTMLElement[] {
  if (!accountsEnabled() || accountState().player || dismissed) return [];
  const error = h('p', { class: 'sign-in-card__error', role: 'alert' });
  const google = h('div', { class: 'sign-in-card__google' });
  const card = h(
    'section',
    { class: 'sign-in-card', 'aria-label': 'Sign in' },
    h('div', { class: 'sign-in-card__text' }, h('span', { class: 'sign-in-card__title' }, 'Save your garage'), h('span', { class: 'sign-in-card__body' }, 'Your builds and settings on every device.')),
    google,
    iconBtn(X, 'Not now', () => {
      dismissed = true;
      card.remove();
    }, 'sign-in-card__close'),
    error,
  );
  renderGoogleButton(google, (m) => (error.textContent = m), 'medium');
  const off = onAccountChange(() => {
    if (!card.isConnected) off();
    else if (accountState().player) {
      off();
      card.remove();
    }
  });
  return [card];
}
