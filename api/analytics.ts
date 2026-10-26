/**
 * The analytics beacon (docs/analytics.md), ported from the eric-shell CRM's track and events endpoints into
 * one function. `POST` only; the body is one `AnalyticsBeacon` (src/shared/analytics.ts):
 *
 * - `pageview`: the visitor upsert (edge geo, user agent, browser facts, device), the session upsert and the
 *   page view row, in one transaction, so one Neon round trip per page load. It is a real `fetch`, so it
 *   alone carries the edge's geo headers and the session cookie that links the browser to the signed-in player.
 * - `heartbeat`: raises the session's `engaged_ms` / `race_ms` (`greatest`, so a late beat never walks them
 *   back). Never touches `visitors`; the session's `last_beat_at` already records recency.
 * - `event`: one `visitor_events` row (the metadata as JSONB), upserting the visitor first when no page view
 *   landed yet.
 *
 * Always answers 204, whatever happens: telemetry must never surface an error to the player, and a DB outage
 * must not be visible in the game. Ids ride in the body because `navigator.sendBeacon` cannot set headers (it
 * sends a Blob typed application/json, or text/plain from a client that cannot); the body is read up to
 * `MAX_BEACON_BYTES` and everything in it is untrusted: ids are UUID-checked, numbers clamped, strings
 * truncated, tags canonicalized, metadata kept only as a small plain object. Before any of that, `RATE` caps
 * each address and the day's total (api/_lib/rateLimit.ts); a limited beacon is dropped with the same 204.
 */
import { isEventType, MAX_BEACON_BYTES } from '../src/shared/analytics.js';
import { sql } from './_lib/db.js';
import { rateLimited, type RateRule } from './_lib/rateLimit.js';
import { sessionSub } from './_lib/session.js';
import { externalReferrer, NO_FACTS, parseId, readGeo, upsertVisitor, type VisitorFacts } from './_lib/visitor.js';

/** Ceiling on the serialized event metadata. Real payloads are a few hundred bytes; dropped rather than cut, since half a JSON document is not JSON. */
const MAX_METADATA_BYTES = 2048;

/**
 * A tab sends one page view, about 15 heartbeats an hour and a few events per race (start, perf, finish), so
 * hard play is well under 100 an hour: 120 per 10 minutes leaves room for a few players behind one address.
 * 20 000 a day overall is roughly a hundred times the testers' traffic, and at a few hundred bytes a row keeps
 * a flood under 10 MB a day against Neon's free 0.5 GB.
 */
const RATE: RateRule = { name: 'analytics', perIp: 120, windowS: 600, perDay: 20_000 };

const NO_CONTENT = (): Response => new Response(null, { status: 204 });

/** Clamp to a non-negative integer no larger than `max`, or null for anything else. */
function int(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n < 0 ? null : Math.min(n, max);
}

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v !== '' ? v.slice(0, max) : null;
}

/**
 * A campaign tag folded to one spelling. These are GROUP BY keys (the insights sources chart ranks the stored
 * string), so `LinkedIn` and `linkedin ` must not be two bars. Done here because the client is untrusted and
 * hand-built links skip it: this is the one point every value passes through on its way to the column.
 */
function tag(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80);
  return cleaned === '' ? null : cleaned;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The metadata as a JSON string for the jsonb column, or null when it is not a plain object or is too big. */
function safeMetadata(v: unknown): string | null {
  if (!record(v)) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > MAX_METADATA_BYTES ? null : s;
  } catch {
    return null;
  }
}

/** The body as a JSON object, reading at most `MAX_BEACON_BYTES` of it; null when larger or not JSON. */
async function readBeacon(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get('content-length'));
  if (declared > MAX_BEACON_BYTES || !req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BEACON_BYTES) {
      void reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return null;
  }
}

/** The signed-in player's Google id from the cookie, or null; never throws (a missing secret just means unlinked). */
function playerSub(req: Request): string | null {
  try {
    return sessionSub(req);
  } catch {
    return null;
  }
}

/** The device facts of a page view beacon, clamped. */
function readFacts(b: Record<string, unknown>, req: Request): VisitorFacts {
  const d = record(b.device);
  const dpr = d && typeof d.dpr === 'number' && Number.isFinite(d.dpr) ? Math.min(Math.max(d.dpr, 0), 16) : null;
  const memory = d && typeof d.memoryGb === 'number' && Number.isFinite(d.memoryGb) ? Math.min(Math.max(d.memoryGb, 0), 1024) : null;
  return {
    clientTimezone: text(b.clientTimezone, 60),
    language: text(b.language, 20),
    // The visit's acquisition, so an internal page is not an answer (page_views keeps the raw value).
    referrer: externalReferrer(text(b.referrer, 500), req),
    gpu: d ? text(d.gpu, 200) : null,
    dpr,
    cores: d ? int(d.cores, 1024) : null,
    memoryGb: memory,
    touch: d && typeof d.touch === 'boolean' ? d.touch : null,
  };
}

async function pageview(b: Record<string, unknown>, visitorId: string, sessionId: string, req: Request): Promise<void> {
  const db = sql();
  const path = text(b.path, 300) ?? '/';
  const referrer = text(b.referrer, 500);
  const entryReferrer = externalReferrer(referrer, req);
  const viewport = record(b.viewport);
  const screen = record(b.screen);
  const utm = record(b.utm);
  // One HTTP round trip instead of three: the Neon driver bills and delays per request. The session upsert
  // backfills and never overwrites (entry path, referrer, viewport, utm, build mean "where the visit began",
  // and a session row can be created by a heartbeat that carries none of it); engaged_ms / race_ms belong to
  // the heartbeat and a page view must never move them.
  await db.transaction([
    upsertVisitor(visitorId, sessionId, readGeo(req), readFacts(b, req), playerSub(req)),
    db`
      insert into visitor_sessions
        (id, visitor_id, entry_path, referrer, viewport_w, viewport_h, screen_w, screen_h,
         utm_source, utm_medium, utm_campaign, build)
      values (
        ${sessionId}, ${visitorId}, ${path}, ${entryReferrer},
        ${int(viewport?.w, 20000)}, ${int(viewport?.h, 20000)},
        ${int(screen?.w, 20000)}, ${int(screen?.h, 20000)},
        ${tag(utm?.source)}, ${tag(utm?.medium)}, ${tag(utm?.campaign)}, ${text(b.build, 40)}
      )
      on conflict (id) do update
        set last_beat_at = now(),
            entry_path = coalesce(visitor_sessions.entry_path, excluded.entry_path),
            referrer   = coalesce(visitor_sessions.referrer,   excluded.referrer),
            viewport_w = coalesce(visitor_sessions.viewport_w, excluded.viewport_w),
            viewport_h = coalesce(visitor_sessions.viewport_h, excluded.viewport_h),
            screen_w   = coalesce(visitor_sessions.screen_w,   excluded.screen_w),
            screen_h   = coalesce(visitor_sessions.screen_h,   excluded.screen_h),
            utm_source   = coalesce(visitor_sessions.utm_source,   excluded.utm_source),
            utm_medium   = coalesce(visitor_sessions.utm_medium,   excluded.utm_medium),
            utm_campaign = coalesce(visitor_sessions.utm_campaign, excluded.utm_campaign),
            build        = coalesce(visitor_sessions.build,        excluded.build)
    `,
    db`
      insert into page_views (visitor_id, session_id, path, referrer)
      select coalesce(
               (select visitor_id from visitor_sessions where id = ${sessionId}::uuid),
               ${visitorId}::uuid
             ),
             ${sessionId}, ${path}, ${referrer}
    `,
  ]);
}

async function heartbeat(b: Record<string, unknown>, sessionId: string): Promise<void> {
  // engagedMs / raceMs are cumulative for the whole visit (the client carries the baseline across document
  // loads), so greatest() composes into the visit's total. Update only: a beat for a session no page view
  // created carries no context worth a row, and the owning visitor is whoever the session already names.
  await sql()`
    update visitor_sessions
    set last_beat_at = now(),
        engaged_ms = greatest(engaged_ms, ${int(b.engagedMs, 86_400_000) ?? 0}),
        race_ms    = greatest(race_ms,    ${int(b.raceMs, 86_400_000) ?? 0})
    where id = ${sessionId}
  `;
}

async function event(b: Record<string, unknown>, visitorId: string, sessionId: string, type: string, req: Request): Promise<void> {
  const db = sql();
  // The same session-owner resolution as the page view, in the same statement batch, so the event lands on
  // the id the upsert wrote even when this browser's visitor id drifted mid-visit. The session link is
  // nulled when no page view created that session, instead of failing the foreign key.
  await db.transaction([
    upsertVisitor(visitorId, sessionId, readGeo(req), NO_FACTS, playerSub(req)),
    db`
      insert into visitor_events (visitor_id, session_id, type, metadata)
      select coalesce(
               (select visitor_id from visitor_sessions where id = ${sessionId}::uuid),
               ${visitorId}::uuid
             ),
             (select id from visitor_sessions where id = ${sessionId}::uuid),
             ${type}, ${safeMetadata(b.metadata)}::jsonb
    `,
  ]);
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (await rateLimited(req, RATE)) return NO_CONTENT();
    const b = await readBeacon(req);
    const visitorId = parseId(b?.visitorId);
    const sessionId = parseId(b?.sessionId);
    if (!b || !visitorId || !sessionId) return NO_CONTENT();
    if (b.op === 'pageview') await pageview(b, visitorId, sessionId, req);
    else if (b.op === 'heartbeat') await heartbeat(b, sessionId);
    else if (b.op === 'event' && isEventType(b.type)) await event(b, visitorId, sessionId, b.type, req);
  } catch (err) {
    // Best effort, like the rest of the game's persistence: a DB outage must never reach the player.
    console.error('Analytics error:', err);
  }
  return NO_CONTENT();
}
