/**
 * Sign in with Google for the dashboard, posting the credential to `/api/account` exactly as the game's
 * account module does (account/account.ts): same Identity Services script, same popup flow, same session
 * cookie, so an admin is a player whose email is also in ADMIN_EMAILS. Its own copy because account.ts has
 * game boot side effects (it reads the game's stores and starts a boot pull of the save); this one touches
 * nothing but the session. Without `VITE_GOOGLE_CLIENT_ID` the build has no accounts and sign-in is off.
 */
export const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

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
/** Where the current button reports a credential; swapped as the sign-in screen remounts. */
let onCredential: (credential: string) => void = () => undefined;

/** Loads Google's script once, when the first button is drawn. */
function loadGis(): Promise<Gis> {
  gis ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      const g = (window as unknown as { google: Gis }).google;
      g.accounts.id.initialize({ client_id: CLIENT_ID, ux_mode: 'popup', auto_select: false, callback: (r) => onCredential(r.credential) });
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

/** Draws Google's button into `el` (the game's dark, rectangular button, as wide as `el` within Google's 200 to 400 px). */
export function renderGoogleButton(el: HTMLElement, credential: (credential: string) => void, onError: (message: string) => void): void {
  onCredential = credential;
  loadGis().then(
    (g) => g.accounts.id.renderButton(el, { type: 'standard', theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'signin_with', width: Math.round(Math.min(400, Math.max(200, el.clientWidth || 280))) }),
    (e: Error) => onError(e.message),
  );
}

/** Posts the ID token; resolves to an error message, or null once the session cookie is set. */
export async function signIn(credential: string): Promise<string | null> {
  try {
    const res = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }) });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return data?.error ?? 'Sign-in failed';
  } catch {
    return 'Could not reach the server';
  }
}

/** Ends the session (not gated server side, so a broken cookie can always be cleared). */
export async function signOut(): Promise<void> {
  await fetch('/api/account', { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
}
