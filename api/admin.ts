/**
 * Every admin operation as one resource, routed by `?op=` (docs/analytics.md), so the whole backend stays at
 * three Vercel functions (Hobby caps a deployment at 12): account, analytics, admin.
 *
 * - `GET op=session`: the signed-in admin (`AdminSessionPayload`); 401 signed out, 403 not in `ADMIN_EMAILS`.
 * - `GET op=visitors`: the visitor list with its aggregates (`VisitorListPayload`, at most 500 rows).
 * - `GET|PATCH|DELETE op=visitor&id=`: one visitor in full, a partial edit of notes / location, or a delete
 *   (everything about them cascades).
 * - `GET op=insights&days=7|30|90`: the dashboard's aggregates (`InsightsPayload`) in one Neon round trip.
 * - `GET op=prune`: the retention pass. Authorized ONLY by `Authorization: Bearer $CRON_SECRET`, never by the
 *   admin cookie. Vercel Cron calls `/api/admin` with no query, so a GET with no `op` and that bearer is the
 *   same pass.
 *
 * The cookie is SameSite=Lax, so a cross-site page cannot send it on a PATCH or DELETE; the writes also
 * require a JSON body. All SQL is parameterized through the tagged template.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AdminSessionPayload, GpuRow, InsightsPayload, LinkedPlayer, PageView, Visitor, VisitorDetailPayload, VisitorEvent, VisitorListPayload, VisitorPatch, VisitorSession, VisitorSummary } from './_lib/adminTypes.js';
import { SYNTHETIC_CAMPAIGN } from './_lib/adminTypes.js';
import { requireAdmin } from './_lib/admin.js';
import { sql } from './_lib/db.js';
import { json } from './_lib/session.js';
import { UUID_RE } from './_lib/visitor.js';

type Row = Record<string, unknown>;

const DAY_CHOICES = [7, 30, 90];
const DEFAULT_DAYS = 30;
/** Top-N caps: long tails belong in a table, not a bar list. */
const LIMIT = 10;
/** Sessions and page views older than this are deleted by the prune pass (calendar months). */
const RETENTION_MONTHS = 6;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** A `date` column as `YYYY-MM-DD`: the driver hands it back as a Date or a string, and a surprise costs one bar, not the payload. */
function ymd(v: unknown): string {
  if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.valueOf()) ? '1970-01-01' : d.toISOString().slice(0, 10);
}

type Tier = 'low' | 'medium' | 'high';
const asTier = (v: unknown): Tier | null => (v === 'low' || v === 'medium' || v === 'high' ? v : null);

/**
 * A GPU renderer string folded to a short family name, so the same chip does not make a bar per driver
 * string: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)" is "Apple M2 Pro" and
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" is "GeForce RTX 3060".
 */
function gpuFamily(raw: string): string {
  let s = raw.trim();
  const angle = /^ANGLE \((.*)\)$/s.exec(s);
  if (angle) {
    const parts = angle[1].split(', ');
    s = parts.length > 1 ? parts[1] : parts[0];
  }
  s = s.replace(/^ANGLE [^:]*: /, '');
  s = s.replace(/\(R\)|\(TM\)|\(tm\)/g, '');
  // Driver and shader-model tails, PCI ids and the like are not part of the name.
  s = s.replace(/\s+(Direct3D\d*|OpenGL|vs_\d|ps_\d|Metal)\b.*$/i, '').replace(/\s*\(0x[0-9a-f]+\).*$/i, '').replace(/\/PCIe.*$/i, '').replace(/\/SSE2.*$/i, '');
  s = s.replace(/^(NVIDIA|AMD|ATI) /i, '').replace(/\s+/g, ' ').trim();
  return (s || 'Unknown').slice(0, 40);
}

/** The request's JSON body, or null when it is not JSON, not an object or larger than 8 KB. */
async function body(req: Request): Promise<Row | null> {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return null;
  const text = await req.text();
  if (text.length > 8 * 1024) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;
  } catch {
    return null;
  }
}

/** Constant-time `Authorization: Bearer $CRON_SECRET` check; an unset secret never matches. */
function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get('authorization');
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- prune ----------------------------------------------------------------------------------------------

/**
 * The retention pass over the derived telemetry. `page_views` grows one row per document load and the list
 * aggregates it on every poll, so it is the table that needs a ceiling; sessions go with it. Visitors and
 * events stay (a row per race, tiny), and nothing reads older data: change this window, not a reader, if that
 * ever stops being true. `make_interval` so "6 months" is calendar months, as db/schema.sql says; the delete
 * is wrapped in a CTE that counts, since a bare delete over the HTTP driver returns no rows to count.
 */
async function prune(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET is not set: refusing to run the retention pass');
    return json({ error: 'Not configured' }, 503);
  }
  if (!cronAuthorized(req)) return json({ error: 'Unauthorized' }, 401);
  const db = sql();
  const [views] = (await db`
    with deleted as (
      delete from page_views where created_at < now() - make_interval(months => ${RETENTION_MONTHS}) returning 1
    )
    select count(*)::int as n from deleted
  `) as { n: number }[];
  // Sequential on purpose: independent and idempotent, so a failure here leaves nothing to roll back.
  const [sessions] = (await db`
    with deleted as (
      delete from visitor_sessions where last_beat_at < now() - make_interval(months => ${RETENTION_MONTHS}) returning 1
    )
    select count(*)::int as n from deleted
  `) as { n: number }[];
  console.log(`Retention pass (${RETENTION_MONTHS} months): page_views ${views?.n ?? 0}, visitor_sessions ${sessions?.n ?? 0}`);
  return json({ ok: true, pageViews: views?.n ?? 0, sessions: sessions?.n ?? 0 });
}

// ---- visitors -------------------------------------------------------------------------------------------

async function visitors(): Promise<Response> {
  // NOTE: no backticks in any comment inside these tagged templates: one closes the template literal.
  // Each aggregate is its own grouped subquery joined back to visitors, so the join cannot multiply rows.
  const rows = (await sql()`
    select
      v.id, v.first_seen_at, v.last_seen_at, v.user_agent, v.country, v.city, v.region, v.timezone,
      v.location_override, v.client_timezone, v.language, v.referrer, v.gpu, v.touch, v.notes,
      pl.email as player_email,
      pl.name  as player_name,
      coalesce(p.view_count, 0)::int      as page_view_count,
      coalesce(ss.session_count, 0)::int  as session_count,
      coalesce(ad.active_days, 0)::int    as active_days,
      -- float8, not bigint: the Neon driver returns int8 as a string.
      coalesce(ss.engaged_ms, 0)::float8  as total_engaged_ms,
      coalesce(ss.race_ms, 0)::float8     as total_race_ms,
      coalesce(e.race_starts, 0)::int     as race_start_count,
      coalesce(e.race_finishes, 0)::int   as race_finish_count,
      coalesce(e.race_quits, 0)::int      as race_quit_count,
      coalesce(e.build_saves, 0)::int     as build_save_count,
      e.median_fps,
      e.last_tier,
      coalesce(ss.synthetic, false)       as synthetic,
      greatest(
        v.last_seen_at,
        coalesce(p.last_view_at, v.last_seen_at),
        coalesce(ss.last_beat_at, v.last_seen_at),
        coalesce(e.last_event_at, v.last_seen_at)
      ) as last_activity_at
    from visitors v
    left join players pl on pl.sub = v.player_sub
    left join (
      select visitor_id, count(*) as view_count, max(created_at) as last_view_at
      from page_views group by visitor_id
    ) p on p.visitor_id = v.id
    left join (
      select visitor_id,
             count(*) as session_count,
             sum(engaged_ms) as engaged_ms,
             sum(race_ms) as race_ms,
             max(last_beat_at) as last_beat_at,
             bool_or(utm_campaign = ${SYNTHETIC_CAMPAIGN}) as synthetic
      from visitor_sessions group by visitor_id
    ) ss on ss.visitor_id = v.id
    left join (
      -- The metadata is client-supplied JSON on a public endpoint, so every numeric read is guarded by
      -- jsonb_typeof: a wrong shape yields null instead of a cast error that would blank the whole list.
      select visitor_id,
             count(*) filter (where type = 'race_start' and (metadata->>'replay') is distinct from 'true') as race_starts,
             count(*) filter (where type = 'race_finish') as race_finishes,
             count(*) filter (where type = 'race_quit') as race_quits,
             count(*) filter (where type = 'build_save') as build_saves,
             max(created_at) as last_event_at,
             percentile_cont(0.5) within group (
               order by case when jsonb_typeof(metadata->'medianFps') = 'number' then (metadata->>'medianFps')::float8 end
             ) filter (where type = 'perf') as median_fps,
             (array_agg(metadata->>'tier' order by created_at desc) filter (where type = 'perf'))[1] as last_tier
      from visitor_events group by visitor_id
    ) e on e.visitor_id = v.id
    -- Distinct UTC days with any recorded activity. Sessions alone would miss a visitor whose telemetry was
    -- cut short; the union dedupes (visitor_id, day) so a day with a view and an event counts once.
    left join (
      select visitor_id, count(distinct d) as active_days
      from (
        select visitor_id, (started_at at time zone 'UTC')::date as d from visitor_sessions
        union
        select visitor_id, (created_at at time zone 'UTC')::date from page_views
        union
        select visitor_id, (created_at at time zone 'UTC')::date from visitor_events
      ) a
      group by visitor_id
    ) ad on ad.visitor_id = v.id
    order by last_activity_at desc
    limit 500
  `) as Row[];
  const list: VisitorSummary[] = rows.map((r) => ({ ...(r as unknown as VisitorSummary), last_tier: asTier(r.last_tier), median_fps: numOrNull(r.median_fps) }));
  return json({ visitors: list } satisfies VisitorListPayload);
}

async function visitorDetail(id: string): Promise<Response> {
  const db = sql();
  const [visitorRows, playerRows, sessions, pageViews, events] = (await db.transaction([
    db`
      select id, first_seen_at, last_seen_at, user_agent, country, city, region, timezone, location_override,
             client_timezone, language, referrer, gpu, dpr, cores, memory_gb, touch, notes
      from visitors where id = ${id}
    `,
    db`
      select p.sub, p.email, p.name, p.created_at, p.seen_at
      from visitors v join players p on p.sub = v.player_sub where v.id = ${id}
    `,
    db`
      select s.id, s.started_at, s.last_beat_at, s.engaged_ms, s.race_ms, s.entry_path, s.referrer,
             s.viewport_w, s.viewport_h, s.screen_w, s.screen_h, s.utm_source, s.utm_medium, s.utm_campaign,
             s.build, (select count(*) from page_views p where p.session_id = s.id)::int as page_view_count
      from visitor_sessions s where s.visitor_id = ${id}
      order by s.started_at desc limit 100
    `,
    db`
      select id::float8 as id, session_id, path, referrer, created_at
      from page_views where visitor_id = ${id}
      order by created_at desc limit 500
    `,
    db`
      select id::float8 as id, session_id, type, metadata, created_at
      from visitor_events where visitor_id = ${id}
      order by created_at desc, id desc limit 500
    `,
  ])) as Row[][];
  if (visitorRows.length === 0) return json({ error: 'Not found' }, 404);
  const payload: VisitorDetailPayload = {
    visitor: visitorRows[0] as unknown as Visitor,
    player: (playerRows[0] as unknown as LinkedPlayer | undefined) ?? null,
    sessions: sessions as unknown as VisitorSession[],
    pageViews: pageViews as unknown as PageView[],
    events: events as unknown as VisitorEvent[],
  };
  return json(payload);
}

async function visitorPatch(req: Request, id: string): Promise<Response> {
  const b = await body(req);
  if (!b) return json({ error: 'Bad request' }, 400);
  // Only the keys present are written: reading an absent key as null would let a location-only PATCH wipe the notes.
  const toText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
  const patch: VisitorPatch = {};
  if ('notes' in b) patch.notes = toText(b.notes, 5000);
  if ('location_override' in b) patch.location_override = toText(b.location_override, 120);
  const hasNotes = patch.notes !== undefined;
  const hasLocation = patch.location_override !== undefined;
  if (!hasNotes && !hasLocation) return json({ error: 'Nothing to update' }, 400);
  const rows = (await sql()`
    update visitors
    set notes = case when ${hasNotes}::boolean then ${patch.notes ?? null}::text else notes end,
        location_override = case when ${hasLocation}::boolean then ${patch.location_override ?? null}::text else location_override end
    where id = ${id}
    returning id
  `) as Row[];
  return rows.length ? json({ ok: true }) : json({ error: 'Not found' }, 404);
}

async function visitorDelete(id: string): Promise<Response> {
  // Sessions, page views and events cascade; a linked player is untouched (the foreign key points the other way).
  const rows = (await sql()`delete from visitors where id = ${id} returning id`) as Row[];
  return rows.length ? json({ ok: true }) : json({ error: 'Not found' }, 404);
}

// ---- insights -------------------------------------------------------------------------------------------

async function insights(days: number): Promise<Response> {
  const db = sql();
  // Window predicates repeat the same make_interval on purpose: one parameter, one meaning, no JS-side cutoff.
  // The play funnel is built so each step is intersected with the one before it, and therefore can never be
  // wider than it. Replays (metadata replay = true) are not a player starting a race, so they are excluded.
  const [sessionRows, funnelRows, modeRows, carRows, seedRows, tierRows, gpuRows, sourceRows, hourRows, dayRows] = (await db.transaction([
    db`
      select
        count(*)::int                                                       as total,
        count(*) filter (where viewport_w is not null)::int                  as vp_known,
        count(*) filter (where viewport_w < 640)::int                        as vp_phone,
        count(*) filter (where viewport_w >= 640 and viewport_w < 1024)::int as vp_tablet,
        count(*) filter (where viewport_w >= 1024)::int                      as vp_desktop,
        percentile_cont(0.5) within group (order by engaged_ms)::float8      as median_engaged,
        (percentile_cont(0.5) within group (order by race_ms) filter (where race_ms > 0))::float8 as median_race
      from visitor_sessions
      where started_at >= now() - make_interval(days => ${days})
    `,
    db`
      with active as (
        select visitor_id from visitor_sessions where started_at >= now() - make_interval(days => ${days})
        union
        select visitor_id from page_views where created_at >= now() - make_interval(days => ${days})
        union
        select visitor_id from visitor_events where created_at >= now() - make_interval(days => ${days})
      ),
      started as (
        select visitor_id from visitor_events
        where type = 'race_start' and (metadata->>'replay') is distinct from 'true'
          and created_at >= now() - make_interval(days => ${days})
        intersect select visitor_id from active
      ),
      finished as (
        select visitor_id from visitor_events
        where type = 'race_finish' and created_at >= now() - make_interval(days => ${days})
        intersect select visitor_id from started
      ),
      saved as (
        select visitor_id from visitor_events
        where type = 'build_save' and created_at >= now() - make_interval(days => ${days})
        intersect select visitor_id from finished
      ),
      signed as (
        select visitor_id from (
          select visitor_id from visitor_events
          where type = 'sign_in' and created_at >= now() - make_interval(days => ${days})
          union
          select id from visitors where player_sub is not null
        ) linked
        intersect select visitor_id from saved
      )
      select
        (select count(*) from active)::int   as visited,
        (select count(*) from started)::int  as started,
        (select count(*) from finished)::int as finished,
        (select count(*) from saved)::int    as saved_build,
        (select count(*) from signed)::int   as signed_in
    `,
    // The mode is a client string; the time is read only when it is a JSON number.
    db`
      select
        coalesce(nullif(metadata->>'mode', ''), '?') as mode,
        count(*) filter (where type = 'race_start' and (metadata->>'replay') is distinct from 'true')::int as starts,
        count(*) filter (where type = 'race_finish')::int as finishes,
        count(*) filter (where type = 'race_quit')::int as quits,
        count(distinct visitor_id) filter (where type = 'race_start' and (metadata->>'replay') is distinct from 'true')::int as visitors,
        (percentile_cont(0.5) within group (
          order by case when jsonb_typeof(metadata->'timeMs') = 'number' then (metadata->>'timeMs')::float8 end
        ) filter (where type = 'race_finish'))::float8 as median_time_ms
      from visitor_events
      where type in ('race_start', 'race_finish', 'race_quit') and created_at >= now() - make_interval(days => ${days})
      group by 1
      order by starts desc, mode
      limit ${LIMIT}
    `,
    db`
      select coalesce(nullif(metadata->>'carId', ''), '?') as car_id,
             count(*)::int as starts, count(distinct visitor_id)::int as visitors
      from visitor_events
      where type = 'race_start' and (metadata->>'replay') is distinct from 'true'
        and created_at >= now() - make_interval(days => ${days})
      group by 1
      order by starts desc, car_id
      limit ${LIMIT}
    `,
    // A seed raced more than once is a course people come back to.
    db`
      select (metadata->>'seed')::float8 as seed,
             max(nullif(metadata->>'seedText', '')) as seed_text,
             count(*)::int as starts, count(distinct visitor_id)::int as visitors
      from visitor_events
      where type = 'race_start' and (metadata->>'replay') is distinct from 'true'
        and jsonb_typeof(metadata->'seed') = 'number'
        and created_at >= now() - make_interval(days => ${days})
      group by 1
      having count(*) > 1
      order by starts desc, seed
      limit ${LIMIT}
    `,
    db`
      select metadata->>'tier' as tier,
             count(*)::int as samples, count(distinct visitor_id)::int as visitors,
             coalesce(percentile_cont(0.5) within group (order by case when jsonb_typeof(metadata->'medianFps') = 'number' then (metadata->>'medianFps')::float8 end), 0)::float8 as median_fps,
             coalesce(percentile_cont(0.5) within group (order by case when jsonb_typeof(metadata->'p95FrameMs') = 'number' then (metadata->>'p95FrameMs')::float8 end), 0)::float8 as p95_frame_ms,
             coalesce(avg(case when jsonb_typeof(metadata->'slowShare') = 'number' then (metadata->>'slowShare')::float8 end), 0)::float8 as slow_share
      from visitor_events
      where type = 'perf' and metadata->>'tier' in ('low', 'medium', 'high')
        and created_at >= now() - make_interval(days => ${days})
      group by 1
    `,
    // Raw GPU strings, folded to families in TS (gpuFamily); capped so a flood of odd strings stays bounded.
    db`
      select v.gpu,
             count(distinct e.visitor_id)::int as visitors,
             coalesce(percentile_cont(0.5) within group (order by case when jsonb_typeof(e.metadata->'medianFps') = 'number' then (e.metadata->>'medianFps')::float8 end), 0)::float8 as median_fps,
             mode() within group (order by e.metadata->>'tier') as tier
      from visitor_events e
      join visitors v on v.id = e.visitor_id
      where e.type = 'perf' and v.gpu is not null and e.metadata->>'tier' in ('low', 'medium', 'high')
        and e.created_at >= now() - make_interval(days => ${days})
      group by v.gpu
      order by visitors desc
      limit 200
    `,
    // utm_source wins over the referrer host when tagged: a DM or emailed link arrives with no referrer at
    // all and only the tag can tell it apart. split_part rather than a regex with a backreference, which is
    // an invalid escape in a tagged template.
    db`
      select
        coalesce(
          nullif(utm_source, ''),
          case
            when referrer is null or referrer = '' then ''
            when lower(split_part(split_part(split_part(referrer, '://', 2), '/', 1), '?', 1)) like 'www.%'
              then substr(lower(split_part(split_part(split_part(referrer, '://', 2), '/', 1), '?', 1)), 5)
            else lower(split_part(split_part(split_part(referrer, '://', 2), '/', 1), '?', 1))
          end
        ) as host,
        bool_or(utm_source is not null and utm_source <> '') as tagged,
        count(*)::int as sessions
      from visitor_sessions
      where started_at >= now() - make_interval(days => ${days})
      group by 1
      order by sessions desc, host
      limit ${LIMIT}
    `,
    // UTC hour: Postgres does not know the reader's clock, so the browser shifts it for display.
    db`
      select extract(hour from started_at at time zone 'UTC')::int as hour, count(*)::int as sessions
      from visitor_sessions
      where started_at >= now() - make_interval(days => ${days})
      group by 1
    `,
    // generate_series drives the join so a quiet day is a zero bar, not a missing one.
    db`
      select gs::date as date, count(v.id)::int as visitors
      from generate_series(
        (now() at time zone 'UTC')::date - ${days - 1}::int,
        (now() at time zone 'UTC')::date,
        interval '1 day'
      ) as gs
      left join visitors v on (v.first_seen_at at time zone 'UTC')::date = gs::date
      group by gs
      order by gs
    `,
  ])) as Row[][];

  const s = sessionRows[0] ?? {};
  const f = funnelRows[0] ?? {};
  const byHour = new Map<number, number>();
  for (const r of hourRows) byHour.set(num(r.hour), num(r.sessions));

  // Fold raw GPU strings into families: visitors add, median fps is visitor-weighted, the tier is the one
  // the family's most visitor-heavy string landed on.
  const families = new Map<string, { visitors: number; fpsSum: number; tier: Tier; top: number }>();
  for (const r of gpuRows) {
    const name = gpuFamily(str(r.gpu));
    const visitors = num(r.visitors);
    const fam = families.get(name) ?? { visitors: 0, fpsSum: 0, tier: asTier(r.tier) ?? 'medium', top: 0 };
    fam.visitors += visitors;
    fam.fpsSum += num(r.median_fps) * visitors;
    if (visitors > fam.top) {
      fam.top = visitors;
      fam.tier = asTier(r.tier) ?? fam.tier;
    }
    families.set(name, fam);
  }
  const gpus: GpuRow[] = [...families]
    .map(([gpu, fam]) => ({ gpu, visitors: fam.visitors, medianFps: fam.visitors ? fam.fpsSum / fam.visitors : 0, tier: fam.tier }))
    .sort((a, b) => b.visitors - a.visitors || a.gpu.localeCompare(b.gpu))
    .slice(0, LIMIT);

  const payload: InsightsPayload = {
    windowDays: days,
    sessions: {
      total: num(s.total),
      viewport: { known: num(s.vp_known), phone: num(s.vp_phone), tablet: num(s.vp_tablet), desktop: num(s.vp_desktop) },
      medianEngagedMs: num(s.median_engaged),
      medianRaceMs: num(s.median_race),
    },
    funnel: { visited: num(f.visited), started: num(f.started), finished: num(f.finished), savedBuild: num(f.saved_build), signedIn: num(f.signed_in) },
    modes: modeRows.map((r) => ({ mode: str(r.mode, '?'), starts: num(r.starts), finishes: num(r.finishes), quits: num(r.quits), visitors: num(r.visitors), medianTimeMs: numOrNull(r.median_time_ms) })),
    cars: carRows.map((r) => ({ carId: str(r.car_id, '?'), starts: num(r.starts), visitors: num(r.visitors) })),
    seeds: seedRows.map((r) => ({ seed: num(r.seed), seedText: typeof r.seed_text === 'string' ? r.seed_text : null, starts: num(r.starts), visitors: num(r.visitors) })),
    tiers: tierRows
      .filter((r) => asTier(r.tier))
      .map((r) => ({ tier: asTier(r.tier) as Tier, samples: num(r.samples), visitors: num(r.visitors), medianFps: num(r.median_fps), p95FrameMs: num(r.p95_frame_ms), slowShare: num(r.slow_share) })),
    gpus,
    sources: sourceRows.map((r) => ({ host: str(r.host), tagged: r.tagged === true, sessions: num(r.sessions) })),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: byHour.get(hour) ?? 0 })),
    days: dayRows.map((r) => ({ date: ymd(r.date), visitors: num(r.visitors) })),
  };
  return json(payload);
}

// ---- routing --------------------------------------------------------------------------------------------

/** Cron and the admin dashboard share one URL space; the op decides which auth applies. */
async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawOp = url.searchParams.get('op');
  // Vercel Cron calls the bare path, so a GET with no op that carries a bearer is the retention pass.
  const op = rawOp ?? (req.method === 'GET' && req.headers.get('authorization') ? 'prune' : null);
  if (op === 'prune') return prune(req);

  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const get = req.method === 'GET';
  if (op === 'session') {
    if (!get) return json({ error: 'Method not allowed' }, 405);
    return json({ email: admin.email, name: admin.name } satisfies AdminSessionPayload);
  }
  if (op === 'visitors') {
    return get ? visitors() : json({ error: 'Method not allowed' }, 405);
  }
  if (op === 'insights') {
    if (!get) return json({ error: 'Method not allowed' }, 405);
    const days = Number(url.searchParams.get('days') ?? DEFAULT_DAYS);
    return insights(DAY_CHOICES.includes(days) ? days : DEFAULT_DAYS);
  }
  if (op === 'visitor') {
    const id = url.searchParams.get('id');
    if (!id || !UUID_RE.test(id)) return json({ error: 'Invalid id' }, 400);
    const vid = id.toLowerCase();
    if (req.method === 'PATCH') return visitorPatch(req, vid);
    if (req.method === 'DELETE') return visitorDelete(vid);
    return get ? visitorDetail(vid) : json({ error: 'Method not allowed' }, 405);
  }
  return json({ error: 'Unknown op' }, 400);
}

async function handle(req: Request): Promise<Response> {
  try {
    return await route(req);
  } catch (err) {
    console.error('Admin error:', err);
    return json({ error: 'Request failed' }, 500);
  }
}

export const GET = handle;
export const PATCH = handle;
export const DELETE = handle;
