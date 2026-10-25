/**
 * Verifies a Google Identity Services ID token (the `credential` the Sign in with Google button hands the
 * page) against Google's published keys, and checks the email against the UAT allowlist. No OAuth code
 * exchange and no client secret: the signed token alone proves who signed in, for this app's client id.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Google's signing keys, fetched once per warm instance and cached by jose (it honours their rotation). */
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string;
  email: string;
  name: string;
}

/** The app's OAuth client id; the same variable Vite inlines into the page (VITE_ is what exposes it there). */
export function clientId(): string | undefined {
  return process.env.VITE_GOOGLE_CLIENT_ID || undefined;
}

/** The signed-in identity, or null when the token is forged, expired, for another app or its email unverified. */
export async function verifyGoogleToken(credential: string): Promise<GoogleIdentity | null> {
  const audience = clientId();
  if (!audience) return null;
  try {
    const { payload } = await jwtVerify(credential, GOOGLE_KEYS, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) return null;
    return { sub: payload.sub, email: payload.email.toLowerCase(), name: typeof payload.name === 'string' ? payload.name : '' };
  } catch {
    return null;
  }
}

/**
 * Whether this email may have an account: `ALLOWED_EMAILS` is a comma separated list. Unset or empty lets
 * nobody in, so a deploy that forgot it fails closed rather than open to every Google account.
 */
export function isAllowed(email: string): boolean {
  const list = (process.env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}
