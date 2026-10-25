/**
 * The player's account: Sign in with Google (Google Identity Services, popup), the session the server keeps
 * in an HttpOnly cookie (api/account.ts), and syncing the save (cloudSave.ts) with it. Accounts are a
 * build-time option: without `VITE_GOOGLE_CLIENT_ID` nothing here touches the network and the game plays
 * on local storage alone, exactly as when signed out.
 *
 * Sync rule: the server's save wins, except over edits this device made for the same account that never
 * reached it (offline, or the tab closed mid-upload); those go up instead. Edits upload a few seconds after
 * the last change, and at once when the tab is hidden.
 */
import { loadJson, saveJson } from '../shared/store';
import { applySave, collectSave, watchSynced, type SaveBlob } from './cloudSave';

export interface Player {
  /** Google's account id. */
  id: string;
  email: string;
  name: string;
}

/** api/account.ts's reply to GET and POST. */
interface AccountReply {
  player: Player;
  save: SaveBlob | null;
  savedAt: string | null;
}

/** What this device remembers about the account (store key `account.v1`). */
interface Meta {
  /** Who is signed in, as far as this device knows (the cookie is the truth). */
  player: Player | null;
  /** The account the local save was last synced with; kept after signing out. */
  owner: string | null;
  /** The server's stamp of the save this device last uploaded or downloaded. */
  savedAt: string | null;
  /** The local save has edits for `owner` the server has not got. */
  dirty: boolean;
}

export type SyncStatus = 'synced' | 'saving' | 'offline';

const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const META_KEY = 'account.v1';
/** How long boot waits for a signed-in player's save before starting on the local one (ms). */
const BOOT_WAIT_MS = 3000;
/** Quiet time after the last edit before uploading (ms): one request per burst of slider drags. */
const PUSH_DELAY_MS = 3000;

let meta: Meta = { player: null, owner: null, savedAt: null, dirty: false, ...loadJson<Partial<Meta>>(META_KEY, {}) };
let status: SyncStatus = 'synced';
/** Counts edits, so an upload that finishes after a newer edit leaves the save dirty. */
let edits = 0;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Whether this build has accounts at all. */
export function accountsEnabled(): boolean {
  return CLIENT_ID !== '';
}

export function accountState(): { player: Player | null; status: SyncStatus } {
  return { player: meta.player, status };
}

/** Calls `fn` when the player or the sync status changes; returns the unsubscribe. */
export function onAccountChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(next: Partial<Meta> = {}, nextStatus = status): void {
  meta = { ...meta, ...next };
  status = nextStatus;
  saveJson(META_KEY, meta);
  for (const fn of listeners) fn();
}

function api(method: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<Response> {
  return fetch('/api/account', {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
    signal,
  });
}

/** Takes the server's account and save in; true when the local save changed (a running game must reload). */
function reconcile(r: AccountReply): boolean {
  const mine = meta.owner === r.player.id;
  if (r.save && !(mine && meta.dirty)) {
    const updated = applySave(r.save);
    changed({ player: r.player, owner: r.player.id, savedAt: r.savedAt, dirty: false }, 'synced');
    return updated;
  }
  // The account has no save yet (its first device), or this device holds its newest edits: upload them.
  changed({ player: r.player, owner: r.player.id, dirty: true });
  void push();
  return false;
}

async function push(keepalive = false): Promise<void> {
  clearTimeout(pushTimer);
  if (!meta.player || !meta.dirty) return;
  const at = edits;
  try {
    const res = await api('PUT', { save: collectSave() }, keepalive);
    if (res.status === 401) return changed({ player: null }, 'synced');
    if (!res.ok) throw new Error(`PUT ${res.status}`);
    const { savedAt } = (await res.json()) as { savedAt: string };
    changed({ savedAt, dirty: edits !== at }, edits !== at ? 'saving' : 'synced');
  } catch {
    changed({}, 'offline');
  }
}

/**
 * Settles once a signed-in player's newest save is in local storage, or after BOOT_WAIT_MS (then the game
 * starts on the local save). main.ts awaits it before reading any saved state; signed out it is already
 * settled, so only signed-in players wait, for one request that overlaps the game's module loading.
 */
export const accountReady: Promise<void> = accountsEnabled() && meta.player ? pullAtBoot() : Promise.resolve();

async function pullAtBoot(): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BOOT_WAIT_MS);
  try {
    const res = await api('GET', undefined, false, abort.signal);
    if (res.status === 401) changed({ player: null });
    else if (res.ok) reconcile((await res.json()) as AccountReply);
    else changed({}, 'offline');
  } catch {
    changed({}, 'offline');
  } finally {
    clearTimeout(timer);
  }
}

if (accountsEnabled()) {
  watchSynced(() => {
    if (!meta.owner) return;
    edits++;
    changed({ dirty: true }, meta.player ? 'saving' : status);
    if (!meta.player) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push(), PUSH_DELAY_MS);
  });
  // Closing or backgrounding the tab: upload now, as a keepalive request that outlives the page.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void push(true));
}

/** Signs in with a Google ID token; resolves to an error message, or null on success. Reloads when the account brought a different save. */
async function signIn(credential: string): Promise<string | null> {
  try {
    const res = await api('POST', { credential });
    const data = (await res.json()) as AccountReply & { error?: string };
    if (!res.ok) return data.error ?? 'Sign-in failed';
    if (reconcile(data)) location.reload();
    return null;
  } catch {
    return 'Could not reach the server';
  }
}

/** Uploads anything pending, then ends the session. The local save stays on the device. */
export async function signOut(): Promise<void> {
  await push();
  await api('DELETE').catch(() => undefined);
  changed({ player: null }, 'synced');
}

/** Google Identity Services, the subset used here. */
interface Gis {
  accounts: {
    id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode: 'popup'; auto_select: boolean }): void;
      renderButton(el: HTMLElement, o: Record<string, string | number>): void;
    };
  };
}

let gis: Promise<Gis> | null = null;
/** Where the current button reports a failed sign-in. */
let reportError: (message: string) => void = () => undefined;

/** Loads Google's script once (on the first Account page visit, so signed-out boots never fetch it). */
function loadGis(): Promise<Gis> {
  gis ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      const g = (window as unknown as { google: Gis }).google;
      g.accounts.id.initialize({ client_id: CLIENT_ID, ux_mode: 'popup', auto_select: false, callback: (r) => void signIn(r.credential).then((e) => e && reportError(e)) });
      resolve(g);
    };
    s.onerror = () => {
      gis = null;
      s.remove();
      reject(new Error('Google sign-in did not load'));
    };
    document.head.append(s);
  });
  return gis;
}

/** Draws Google's Sign in button into `el`; a failed sign-in (or the script not loading) goes to `onError`. */
export function renderGoogleButton(el: HTMLElement, onError: (message: string) => void): void {
  reportError = onError;
  loadGis().then(
    (g) => g.accounts.id.renderButton(el, { type: 'standard', theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'signin_with', width: 260 }),
    (e: Error) => onError(e.message),
  );
}
