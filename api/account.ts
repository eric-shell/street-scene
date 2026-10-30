/**
 * The player's account as one resource, so the whole backend is one Vercel function (Hobby caps a
 * deployment at 12) and every request is at most one Neon query:
 *
 * - `GET`: who is signed in, with their synced save (also stamps `seen_at`). 401 when signed out.
 *
 * The player in a reply carries `admin` when their email is on `ADMIN_EMAILS` (api/_lib/admin.ts): the garage
 * then counts every part and feature as owned (shared/purchases.ts `setOwnsAll`). Ownership is client side
 * anyway (the ledger lives in the save), so the flag grants nothing the server guards.
 * - `POST { credential }`: sign in with a Google ID token; allowlisted emails only. Sets the session cookie.
 * - `PUT { save }`: replace the synced save (last writer wins; one player rarely plays two devices at once).
 * - `DELETE`: sign out. Not gated on a valid session, so a broken cookie can always be cleared.
 *
 * Writes need a JSON body, which a cross-site form cannot send without a CORS preflight this never answers;
 * with the SameSite=Lax cookie that keeps another site from writing a player's save.
 */
import { isAdminEmail } from './_lib/admin.js';
import { sql } from './_lib/db.js';
import { isAllowed, verifyGoogleToken } from './_lib/google.js';
import { clearedCookies, json, sessionCookie, sessionSub } from './_lib/session.js';

/** The largest save accepted, in bytes of JSON: a full garage is a few KB, so this only stops abuse. */
const MAX_SAVE_BYTES = 64 * 1024;

interface PlayerRow {
  sub: string;
  email: string;
  name: string;
  save: unknown;
  saved_at: Date | null;
}

/** What the page gets back: the player, their save and its stamp (src/account/account.ts AccountReply). */
function reply(row: PlayerRow) {
  return { player: { id: row.sub, email: row.email, name: row.name, admin: isAdminEmail(row.email) }, save: row.save ?? null, savedAt: row.saved_at?.toISOString() ?? null };
}

/** The request's JSON body, or null when it is missing, not JSON, or larger than `limit` bytes. */
async function body(req: Request, limit: number): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return null;
  const text = await req.text();
  if (text.length > limit) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const sub = sessionSub(req);
  if (!sub) return json({ error: 'Signed out' }, 401);
  const rows = (await sql()`update players set seen_at = now() where sub = ${sub} returning sub, email, name, save, saved_at`) as PlayerRow[];
  // A valid cookie for a row that is gone (deleted by hand): treat as signed out.
  if (!rows[0]) return json({ error: 'Signed out' }, 401, clearedCookies());
  return json(reply(rows[0]));
}

export async function POST(req: Request): Promise<Response> {
  const b = await body(req, 8 * 1024);
  const id = typeof b?.credential === 'string' ? await verifyGoogleToken(b.credential) : null;
  if (!id) return json({ error: 'Google sign-in failed' }, 401);
  if (!isAllowed(id.email)) return json({ error: `${id.email} is not on the tester list` }, 403);
  const rows = (await sql()`
    insert into players (sub, email, name) values (${id.sub}, ${id.email}, ${id.name})
    on conflict (sub) do update set email = excluded.email, name = excluded.name, seen_at = now()
    returning sub, email, name, save, saved_at`) as PlayerRow[];
  return json(reply(rows[0]), 200, [sessionCookie(req, id.sub)]);
}

export async function PUT(req: Request): Promise<Response> {
  const sub = sessionSub(req);
  if (!sub) return json({ error: 'Signed out' }, 401);
  const b = await body(req, MAX_SAVE_BYTES);
  if (!b || !b.save || typeof b.save !== 'object') return json({ error: 'Bad save' }, 400);
  const rows = (await sql()`update players set save = ${JSON.stringify(b.save)}::jsonb, saved_at = now() where sub = ${sub} returning saved_at`) as { saved_at: Date }[];
  if (!rows[0]) return json({ error: 'Signed out' }, 401, clearedCookies());
  return json({ savedAt: rows[0].saved_at.toISOString() });
}

export function DELETE(): Response {
  return json({ ok: true }, 200, clearedCookies());
}
