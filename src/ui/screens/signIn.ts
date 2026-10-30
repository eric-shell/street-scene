/**
 * The ways in to an account, in the UI's own pieces so each place asks the same way (only on builds with
 * accounts, and only while signed out):
 *  - signInRow: a place row in the menu's style (rail.ts navRow): Sign in with Google, Google's G in the
 *    badge, over what an account keeps (counting the garage's builds where the caller knows them), or, when
 *    an account signed in on this device before, Continue as its first name with its picture in the badge;
 *    the results screen opens the dialog with it.
 *  - accountRow: the menu home's row, in both states: signInRow signed out, the player signed in (picture,
 *    Welcome and their first name on the visit that created the account, Welcome back after, over the cloud
 *    save's state and email), swapping in place as the account changes; it opens Settings
 *    on Account.
 *  - signInContent: Google's button, as wide as its box, over what an account keeps: the top of the Account
 *    page while signed out, and the dialog's body.
 *  - openSignInDialog: that content in a kit dialog over a screen, closed by its button, a click outside,
 *    Escape or signing in. The results screen's row and the garage's note under its builds open it.
 * Signing in reloads the page when the account brought a different save (account.ts), so a place that holds
 * unsaved work (the garage) settles it before it opens the dialog.
 */
import { BONUS } from '../../shared/points';
import { FEATURES } from '../../shared/features';
import { h, iconBtn, toast } from '../kit/dom';
import { privacyPage } from './privacyPage';
import { CircleUser, Cloud, CloudCheck, CloudOff, ShieldCheck, X, icon, type IconNode } from '../kit/icons';
import { navRow } from '../rail/rail';
import { accountState, accountsEnabled, isNewAccount, lastPlayer, onAccountChange, renderGoogleButton, type SyncStatus } from '../../account/account';

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
export function signInRow(onClick: () => void, cls = '', builds?: number): HTMLButtonElement | null {
  if (!wantsSignIn()) return null;
  const row = signedOutRow(onClick, cls, builds);
  onSignedIn(row, () => row.remove());
  return row;
}

/** Google's G (its brand mark, four colours), for the sign-in row's badge. */
const GOOGLE_G =
  '<svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

/** What an account keeps, counting the builds when known (the menu passes its garage's). */
function pitch(builds: number | undefined): string {
  // With the economy on, signing in is also worth a bonus (shared/points.ts BONUS).
  const perk = FEATURES.economy ? `, plus ${bonusText()} points` : '';
  if (builds === undefined) return SIGN_IN_PITCH + perk;
  return (builds > 1 ? `Keep your ${builds} customized vehicles and progress` : 'Keep your customized vehicle and progress') + perk;
}

/** The sign-in grant on its own (points), as the player reads it: 5,000. */
const bonusText = () => (BONUS.SIGN_IN - BONUS.WELCOME).toLocaleString('en-US');

/**
 * The signed-out row as it stands now: Sign in with Google, the G on a white badge as on Google's own
 * buttons, over the pitch; or Continue as the last account's first name over its email, its picture in the
 * badge (the G until the picture loads, and if it does not).
 */
function signedOutRow(onClick: () => void, cls: string, builds?: number): HTMLButtonElement {
  const last = lastPlayer();
  const first = firstName(last?.name);
  const row = navRow(CircleUser, first ? `Continue as ${first}` : 'Sign in with Google', last ? last.email : pitch(builds), 'yellow', onClick, cls);
  row.title = last ? `Sign in again as ${last.name || last.email}: ${pitch(builds).toLowerCase()}` : 'Sign in with your Google account';
  const badge = row.querySelector('.nav-row__badge')!;
  badge.classList.add('nav-row__badge--google');
  badge.replaceChildren(h('span', { class: 'nav-row__mark', html: GOOGLE_G }));
  avatar(row, last?.picture);
  return row;
}

const firstName = (name: string | undefined): string | undefined => name?.split(/\s+/)[0] || undefined;

/** The greeting for the signed-in player: Welcome on the visit that created the account, Welcome back after. */
export function welcome(): string {
  const player = accountState().player;
  const name = firstName(player?.name) ?? player?.email ?? '';
  if (!isNewAccount()) return `Welcome back ${name}!`;
  return FEATURES.economy ? `Welcome ${name}! +${bonusText()} points` : `Welcome ${name}!`;
}

/** Puts the player's picture in a row's badge once it loads, the whole badge (what was there stays if it does not). */
function avatar(row: HTMLElement, picture: string | undefined): void {
  if (!picture) return;
  const badge = row.querySelector('.nav-row__badge')!;
  // Google's image host refuses some requests that carry a referrer.
  const img = h('img', {
    class: 'nav-row__avatar',
    referrerpolicy: 'no-referrer',
    alt: '',
    src: picture,
    onload: () => {
      badge.classList.remove('nav-row__badge--google');
      badge.replaceChildren(img);
    },
  });
}

/**
 * The menu home's account row, or null on a build without accounts: Sign in (or Continue as) while signed
 * out; signed in, the player's picture and first name over the cloud save's state and their email. It
 * redraws itself in place when the account or the sync state changes, keeping focus.
 */
export function accountRow(onClick: () => void, cls = '', builds?: number): HTMLButtonElement | null {
  if (!accountsEnabled()) return null;
  const draw = (): HTMLButtonElement => {
    const { player, status } = accountState();
    if (!player) return signedOutRow(onClick, cls, builds);
    const last = lastPlayer();
    const row = navRow(CircleUser, welcome(), `${SYNC_STATUS[status].label} · ${player.email}`, 'yellow', onClick, cls);
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
  return [
    google,
    error,
    h('p', { class: 'setting-note' }, 'Keep your garage, your plate name and your settings on every device you play on. Tester accounts only.'),
    h('button', { class: 'privacy__link', type: 'button', onclick: openPrivacyDialog }, 'What the game collects'),
  ];
}

/** The Privacy page (the Settings tab's own content) in a dialog over the UI, for places that have no Settings to open. */
function openPrivacyDialog(): void {
  const close = () => {
    dialog.remove();
    window.removeEventListener('keydown', onKey, true);
  };
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
      { class: 'dialog panel', role: 'dialog', 'aria-label': 'Privacy' },
      h('h2', { class: 'title dialog__title' }, icon(ShieldCheck, { size: 22 }), 'Privacy', h('span', { class: 'dialog__spacer' }), iconBtn(X, 'Close', close, '--small')),
      ...privacyPage(),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  (document.getElementById('ui') ?? document.body).append(dialog);
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
    toast(`${welcome()} · your garage is saved to your account`, CloudCheck);
  });
}
