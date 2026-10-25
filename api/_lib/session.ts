/**
 * The player's session: an HttpOnly cookie carrying their Google id, the time it was issued and an HMAC of
 * both under `SESSION_SECRET`. Stateless, so checking it costs no database query; rotating the secret signs
 * everyone out. Plus the JSON response helper the handlers share.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, Path=/ and has no Domain, so no sibling
 * subdomain can plant one. Plain http on localhost cannot hold it, so dev uses the bare name.
 */
const COOKIE = 'street_session';
const HOST_COOKIE = '__Host-street_session';

/** 30 days: a handful of friends testing a game, and signing in again is one click. */
const MAX_AGE_S = 60 * 60 * 24 * 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars)');
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === 'https:';
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** The signed-in player's Google id, or null for no, a forged or an expired session. */
export function sessionSub(req: Request): string | null {
  const token = readCookie(req, HOST_COOKIE) ?? readCookie(req, COOKIE);
  const [sub, issued, sig] = token?.split('.') ?? [];
  if (!sub || !issued || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(`${sub}.${issued}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const age = (Date.now() - Number(issued)) / 1000;
  return age >= 0 && age <= MAX_AGE_S ? sub : null;
}

export function sessionCookie(req: Request, sub: string): string {
  const issued = String(Date.now());
  const token = `${sub}.${issued}.${sign(`${sub}.${issued}`)}`;
  const secure = isSecure(req);
  return `${secure ? HOST_COOKIE : COOKIE}=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}

/** Expires both names, so one written under the other can't linger. */
export function clearedCookies(): string[] {
  return [HOST_COOKIE, COOKIE].map((n) => `${n}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}
