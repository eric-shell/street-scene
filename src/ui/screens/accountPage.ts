/**
 * The settings panel's Account page, its first (only on builds with accounts, account.ts). Signed out,
 * Google's Sign in button across the top and what an account keeps (signIn.ts), then the plate name (the
 * player's name as the license plates will carry it, kept with the settings, so it syncs once signed in);
 * signed in, the plate name, then who, the sync state and Sign out. Redraws its account part when the account changes. Styled by _account.scss.
 */
import { btn, h } from '../kit/dom';
import { LogOut, icon } from '../kit/icons';
import { accountState, onAccountChange, signOut } from '../../account/account';
import { PLATE_MAX, plateText, type Settings } from '../settings';
import { settingRow } from './settingsPanel';
import { SYNC_STATUS, signInContent } from './signIn';

/** A plate name suggested from the account's name (its first word), for the field's placeholder. */
const suggestedPlate = (name: string | undefined): string => plateText(name?.split(/\s+/)[0] ?? '').trim() || 'MY PLATE';

/** The plate name: a field shaped like a plate that only takes what a plate can carry. */
function plateRow(s: Settings, onChange: (s: Settings) => void): HTMLElement {
  const input = h('input', { type: 'text', class: 'account__plate', value: s.username, maxlength: PLATE_MAX, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Plate name', placeholder: suggestedPlate(accountState().player?.name) }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const clean = plateText(input.value);
    if (clean !== input.value) input.value = clean;
    s.username = clean.trim();
    onChange(s);
  });
  input.addEventListener('change', () => (input.value = s.username));
  return settingRow('Plate name', input, `Your name on your license plates, up to ${PLATE_MAX} letters and numbers`);
}

export function accountPage(s: Settings, onChange: (s: Settings) => void): HTMLElement[] {
  const root = h('div', { class: 'account' });
  const plate = plateRow(s, onChange);
  const draw = () => {
    const { player, status } = accountState();
    plate.querySelector<HTMLInputElement>('.account__plate')!.placeholder = suggestedPlate(player?.name);
    if (!player) {
      root.replaceChildren(...signInContent(), plate);
      return;
    }
    const s = SYNC_STATUS[status];
    const out = btn(LogOut, 'Sign out', () => {
      out.disabled = true;
      void signOut();
    });
    root.replaceChildren(
      plate,
      settingRow(player.name || player.email, out, player.email),
      settingRow('Cloud save', h('span', { class: `account__status is-${status}` }, icon(s.icon, { size: 16 }), s.label)),
      h('p', { class: 'setting-note' }, 'Your garage, plate name and settings follow you to any device you sign in on. Replays and best times stay on this one.'),
    );
  };
  draw();
  const off = onAccountChange(() => (root.isConnected ? draw() : off()));
  return [root];
}
