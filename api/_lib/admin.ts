/**
 * The admin check: who is signed in (the player session cookie, no database query) and is their email on the
 * `ADMIN_EMAILS` list. Fails closed: an unset or empty list lets nobody in. The dashboard has no password of
 * its own; an admin is a tester who signed in with Google and is also named here.
 */
import { sql } from './db.js';
import { json, sessionSub } from './session.js';

export interface AdminIdentity {
  email: string;
  name: string;
}

/** The comma separated `ADMIN_EMAILS`, lowercased. */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** The signed-in admin, or the 401 (signed out) / 403 (not an admin) response to return as is. */
export async function requireAdmin(req: Request): Promise<AdminIdentity | Response> {
  const sub = sessionSub(req);
  if (!sub) return json({ error: 'Signed out' }, 401);
  const rows = (await sql()`select email, name from players where sub = ${sub}`) as AdminIdentity[];
  const player = rows[0];
  if (!player) return json({ error: 'Signed out' }, 401);
  if (!adminEmails().includes(player.email.toLowerCase())) return json({ error: 'Not an admin' }, 403);
  return { email: player.email, name: player.name };
}
