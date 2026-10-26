/**
 * The ways in to an account, in the UI's own pieces so each place asks the same way (only on builds with
 * accounts, and only while signed out):
 *  - signInRow: a place row in the menu's style (rail.ts navRow) that says what an account keeps, or, when
 *    an account signed in on this device before, greets it by name with its picture in the badge; the
 *    results screen opens the dialog with it.
 *  - accountRow: the menu home's row, in both states: signInRow signed out, the player (picture, name, the
 *    cloud save's state and email) signed in, swapping in place as the account changes; it opens Settings
 *    on Account.
 *  - signInContent: Google's button, as wide as its box, over what an account keeps: the top of the Account
 *    page while signed out, and the dialog's body.
 *  - openSignInDialog: that content in a kit dialog over a screen, closed by its button, a click outside,
 *    Escape or signing in. The results screen's row and the garage's note under its builds open it.
 * Signing in reloads the page when the account brought a different save (account.ts), so a place that holds
 * unsaved work (the garage) settles it before it opens the dialog.
 */
import { h, iconBtn, toast } from '../kit/dom';
import { CircleUser, Cloud, CloudCheck, CloudOff, X, icon, type IconNode } from '../kit/icons';
import { navRow } from '../rail/rail';
import { accountState, accountsEnabled, lastPlayer, onAccountChange, renderGoogleButton, type SyncStatus } from '../../account/account';

/** What an account keeps, in the row's sub. */
export const SIGN_IN_PITCH = 'Keep your customized vehicles and progress';

/** The cloud save's states as the account row and the Account page name them. */
export const SYNC_STATUS: Record<SyncStatus, { label: string; icon: IconNode }> = {
  synced: { label: 'Synced', icon: CloudCheck },
  saving: { label: 'Saving…', icon: Cloud },
  offline: { label: 'Offline', icon: CloudOff },
};

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
  const row = signedOutRow(onClick, cls);
  onSignedIn(row, () => row.remove());
  return row;
}

/** The signed-out row as it stands now. */
function signedOutRow(onClick: () => void, cls: string): HTMLButtonElement {
  const last = lastPlayer();
  const first = firstName(last?.name);
  const row = navRow(CircleUser, first ? `Continue as ${first}` : 'Sign in', last ? last.email : SIGN_IN_PITCH, 'yellow', onClick, cls);
  if (last) row.title = `Sign in again as ${last.name || last.email}: ${SIGN_IN_PITCH.toLowerCase()}`;
  avatar(row, last?.picture);
  return row;
}

const firstName = (name: string | undefined): string | undefined => name?.split(/\s+/)[0] || undefined;

/** Puts the player's picture in a row's badge once it loads (the icon stays if it does not). */
function avatar(row: HTMLElement, picture: string | undefined): void {
  if (!picture) return;
  const badge = row.querySelector('.nav-row__badge')!;
  // Google's image host refuses some requests that carry a referrer.
  const img = h('img', { class: 'nav-row__avatar', referrerpolicy: 'no-referrer', alt: '', src: picture, onload: () => badge.replaceChildren(img) });
}

/**
 * The menu home's account row, or null on a build without accounts: Sign in (or Continue as) while signed
 * out; signed in, the player's picture and first name over the cloud save's state and their email. It
 * redraws itself in place when the account or the sync state changes, keeping focus.
 */
export function accountRow(onClick: () => void, cls = ''): HTMLButtonElement | null {
  if (!accountsEnabled()) return null;
  const draw = (): HTMLButtonElement => {
    const { player, status } = accountState();
    if (!player) return signedOutRow(onClick, cls);
    const last = lastPlayer();
    const row = navRow(CircleUser, firstName(player.name) ?? player.email, `${SYNC_STATUS[status].label} · ${player.email}`, 'yellow', onClick, cls);
    row.title = 'Your account: the plate name, the cloud save and Sign out';
    avatar(row, last?.email === player.email ? last.picture : undefined);
    return row;
  };
  let row = draw();
  const off = onAccountChange(() => {
    if (!row.isConnected) return off();
    const next = draw();
    const focused = document.activeElement === row;
    row.replaceWith(next);
    row = next;
    if (focused) row.focus({ preventScroll: true });
  });
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
