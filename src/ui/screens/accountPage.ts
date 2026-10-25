/**
 * The settings panel's Account page (only on builds with accounts, account.ts): signed out, Google's Sign in
 * button and what an account keeps; signed in, who, the sync state and Sign out. Redraws itself when the
 * account changes. Styled by _account.scss.
 */
import { btn, h } from '../kit/dom';
import { Cloud, CloudCheck, CloudOff, LogOut, icon } from '../kit/icons';
import { accountState, onAccountChange, renderGoogleButton, signOut, type SyncStatus } from '../../account/account';
import { settingRow } from './settingsPanel';

const STATUS: Record<SyncStatus, { label: string; icon: typeof Cloud }> = {
  synced: { label: 'Synced', icon: CloudCheck },
  saving: { label: 'Saving…', icon: Cloud },
  offline: { label: 'Offline', icon: CloudOff },
};

export function accountPage(): HTMLElement[] {
  const root = h('div', { class: 'account' });
  const draw = () => {
    const { player, status } = accountState();
    if (!player) {
      const error = h('p', { class: 'account__error', role: 'alert' });
      const google = h('div', { class: 'account__google' });
      renderGoogleButton(google, (m) => (error.textContent = m));
      root.replaceChildren(h('p', { class: 'setting-note' }, 'Sign in to keep your garage and settings on every device you play on. Tester accounts only.'), google, error);
      return;
    }
    const s = STATUS[status];
    const out = btn(LogOut, 'Sign out', () => {
      out.disabled = true;
      void signOut();
    });
    root.replaceChildren(
      settingRow(player.name || player.email, out, player.email),
      settingRow('Cloud save', h('span', { class: `account__status is-${status}` }, icon(s.icon, { size: 16 }), s.label)),
      h('p', { class: 'setting-note' }, 'Your garage and settings follow you to any device you sign in on. Replays and best times stay on this one.'),
    );
  };
  draw();
  const off = onAccountChange(() => (root.isConnected ? draw() : off()));
  return [root];
}
