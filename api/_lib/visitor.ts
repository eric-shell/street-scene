/**
 * Visitor identity and enrichment for the analytics endpoint (docs/analytics.md), ported from the eric-shell
 * CRM. One place owns the id rules, the Vercel edge geo headers and the visitor upsert, so every write path
 * resolves a visitor the same way.
 *
 * The visitor id is a random UUID the browser keeps in localStorage. It is pseudonymous, never an identity:
 * any client can send any UUID, so nothing is authorized off it (the admin check uses the signed session
 * cookie). The *session* owns the identity for the length of a visit: `visitor_sessions.visitor_id` is never
 * reassigned on conflict, so a visitor id that changes mid-visit (storage cleared, two tabs minting at once)
 * cannot fork one player into two rows. Every statement resolves through `ownerOf`.
 */
import { sql } from './db.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A lowercased UUID, or null for anything else (the check that gates every write). */
export function parseId(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * A referrer worth storing as acquisition, or null. `document.referrer` on an internal navigation is one of
 * our own pages, and `visitors.referrer` / `visitor_sessions.referrer` are first-non-null-wins, so a same-site
 * value would record the game as the source of its own traffic. `page_views.referrer` is not filtered: there
 * "which page linked here" is the point.
 */
export function externalReferrer(value: string | null, req: Request): string | null {
  if (!value) return null;
  // Strip the port and a leading www. on both sides, so localhost:5175 still matches localhost in dev.
  const bare = (h: string) => h.split(':')[0].replace(/^www\./, '').toLowerCase();
  try {
    return bare(new URL(value).hostname) === bare(req.headers.get('host') ?? '') ? null : value;
  } catch {
    // Not a parseable URL: attacker-supplied text bound for the admin UI, and not acquisition data.
    return null;
  }
}

/**
 * Vercel percent-encodes non-ASCII city names (`Z%C3%BCrich`). A malformed sequence makes
 * `decodeURIComponent` throw, which used to take the caller's whole write down with it, so degrade to the raw
 * value.
 */
function readGeoHeader(req: Request, name: string): string | null {
  const value = req.headers.get(name);
  if (!value) return null;
  try {
    return decodeURIComponent(value).slice(0, 120);
  } catch {
    return value.slice(0, 120);
  }
}

/** What the request itself says about the visitor: the user agent and the edge's IP-derived geo (approximate). */
export interface RequestGeo {
  userAgent: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
}

/** All four geo headers are absent outside Vercel's edge, so a local dev write legitimately reads nulls. */
export function readGeo(req: Request): RequestGeo {
  return {
    userAgent: req.headers.get('user-agent')?.slice(0, 500) || null,
    country: readGeoHeader(req, 'x-vercel-ip-country'),
    city: readGeoHeader(req, 'x-vercel-ip-city'),
    region: readGeoHeader(req, 'x-vercel-ip-country-region'),
    timezone: readGeoHeader(req, 'x-vercel-ip-timezone'),
  };
}

/** Browser-reported facts that ride in the beacon body, already clamped. */
export interface VisitorFacts {
  clientTimezone: string | null;
  language: string | null;
  /** External referrer only (see `externalReferrer`). */
  referrer: string | null;
  gpu: string | null;
  dpr: number | null;
  cores: number | null;
  memoryGb: number | null;
  touch: boolean | null;
}

export const NO_FACTS: VisitorFacts = { clientTimezone: null, language: null, referrer: null, gpu: null, dpr: null, cores: null, memoryGb: null, touch: null };

type Query = ReturnType<ReturnType<typeof sql>>;

/**
 * The visitor upsert, as an unawaited query so a caller can batch it into a `db.transaction([...])` (one Neon
 * round trip per request). Insert on the visitor the session already belongs to, falling back to the client's
 * id: `coalesce((select visitor_id from visitor_sessions where id = $sess), $vid)`. Callers persist their own
 * rows against that same resolution, never against the id they read off the wire.
 *
 * `coalesce(existing, new)` keeps the first sighting and backfills nulls, so a row made without geo (an
 * events-only visitor, a local write) is filled in by any later edge request. Browser-reported fields
 * (timezone, language, device) are the other way round, a fresh value wins. `playerSub` links the browser to
 * the signed-in player (latest wins); it goes through a select on `players` so a deleted account's cookie
 * cannot break the foreign key and sink the whole transaction.
 */
export function upsertVisitor(visitorId: string, sessionId: string, geo: RequestGeo, facts: VisitorFacts, playerSub: string | null): Query {
  const db = sql();
  return db`
    with resolved as (
      select coalesce(
        (select visitor_id from visitor_sessions where id = ${sessionId}::uuid),
        ${visitorId}::uuid
      ) as id
    )
    insert into visitors (id, player_sub, user_agent, country, city, region, timezone, referrer,
                          client_timezone, language, gpu, dpr, cores, memory_gb, touch)
    select resolved.id, (select sub from players where sub = ${playerSub}),
           ${geo.userAgent}, ${geo.country}, ${geo.city}, ${geo.region}, ${geo.timezone}, ${facts.referrer},
           ${facts.clientTimezone}, ${facts.language}, ${facts.gpu}, ${facts.dpr}, ${facts.cores},
           ${facts.memoryGb}, ${facts.touch}
    from resolved
    on conflict (id) do update
      set last_seen_at = now(),
          player_sub = coalesce(excluded.player_sub, visitors.player_sub),
          user_agent = coalesce(visitors.user_agent, excluded.user_agent),
          country    = coalesce(visitors.country,    excluded.country),
          city       = coalesce(visitors.city,       excluded.city),
          region     = coalesce(visitors.region,     excluded.region),
          timezone   = coalesce(visitors.timezone,   excluded.timezone),
          referrer   = coalesce(visitors.referrer,   excluded.referrer),
          client_timezone = coalesce(excluded.client_timezone, visitors.client_timezone),
          language        = coalesce(excluded.language,        visitors.language),
          gpu        = coalesce(excluded.gpu,       visitors.gpu),
          dpr        = coalesce(excluded.dpr,       visitors.dpr),
          cores      = coalesce(excluded.cores,     visitors.cores),
          memory_gb  = coalesce(excluded.memory_gb, visitors.memory_gb),
          touch      = coalesce(excluded.touch,     visitors.touch)
  `;
}
