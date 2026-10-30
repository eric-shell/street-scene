/**
 * Fills the driver name from the account's name: once a player is signed in and the field is empty (the
 * first sign-in is the registration; an account that predates the field fills on its next change). The menu
 * hands over its live settings copy and its save callback, so the name is saved and synced like any edit.
 * One subscription for the page's life; the latest settings copy wins, since the menu is rebuilt per visit.
 */
import { accountState, onAccountChange } from '../account/account';
import { driverNameText, type Settings } from './settings';

let target: { s: Settings; save: (s: Settings) => void } | null = null;
let subscribed = false;

/** Adopts the account's name into `s.driverName` when empty and signed in. */
function adopt(): void {
  const name = driverNameText(accountState().player?.name ?? '').trim();
  if (!target || !name || target.s.driverName) return;
  target.s.driverName = name;
  target.save(target.s);
}

export function watchDriverName(s: Settings, save: (s: Settings) => void): void {
  target = { s, save };
  if (!subscribed) {
    subscribed = true;
    onAccountChange(adopt);
  }
  adopt();
}
