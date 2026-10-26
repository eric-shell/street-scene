/**
 * The analytics endpoints (api/analytics.ts, api/admin.ts) against a real Postgres: PGlite, in process, with
 * db/schema.sql applied, standing in for the Neon HTTP driver (the same tagged template and `transaction`), so
 * every query the dashboard depends on is parsed, planned and run before it reaches production. Nothing here
 * touches the network or the live database.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { InsightsPayload, VisitorDetailPayload, VisitorListPayload } from '../api/_lib/adminTypes';

const pg = new PGlite();

/** The Neon driver's surface the handlers use: a tagged template (lazy, so it can be batched) and `transaction`. */
vi.mock('../api/_lib/db.ts', () => {
  type Q = { text: string; params: unknown[]; then: (ok: (rows: unknown) => void, bad: (e: unknown) => void) => void };
  const query = (strings: TemplateStringsArray, ...params: unknown[]): Q => {
    const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
    return { text, params, then: (ok, bad) => void pg.query(text, params as never[]).then((r) => ok(r.rows), bad) };
  };
  const db = Object.assign(query, {
    transaction: (qs: Q[]) => pg.transaction(async (tx) => {
      const out: unknown[] = [];
      for (const q of qs) out.push((await tx.query(q.text, q.params as never[])).rows);
      return out;
    }),
  });
  return { sql: () => db };
});

process.env.SESSION_SECRET = 'test-secret-'.repeat(4);
process.env.ADMIN_EMAILS = 'Admin@Example.com';
process.env.CRON_SECRET = 'cron-secret-'.repeat(4);

const analytics = await import('../api/analytics');
const admin = await import('../api/admin');
const { sessionCookie } = await import('../api/_lib/session');

const cookieFor = (sub: string) => sessionCookie(new Request('http://localhost/'), sub).split(';')[0];
const V = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';
const V2 = '33333333-3333-4333-8333-333333333333';
const S2 = '44444444-4444-4444-8444-444444444444';
const GEO = {
  'x-vercel-ip-country': 'US',
  'x-vercel-ip-city': 'San%20Luis%20Obispo',
  'x-vercel-ip-country-region': 'CA',
  'x-vercel-ip-timezone': 'America/Los_Angeles',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

async function beacon(body: unknown, headers: Record<string, string> = {}, ip = '203.0.113.1'): Promise<number> {
  const r = await analytics.POST(
    new Request('http://localhost/api/analytics', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...GEO, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  return r.status;
}

async function call<T>(method: 'GET' | 'PATCH' | 'DELETE', qs: string, opts: { cookie?: string; body?: unknown; auth?: string } = {}): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.body) headers['content-type'] = 'application/json';
  const handler = admin[method] as (r: Request) => Promise<Response>;
  const r = await handler(new Request(`http://localhost/api/admin${qs}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined }));
  const text = await r.text();
  return { status: r.status, json: (text ? JSON.parse(text) : null) as T };
}

const count = async (table: string) => ((await pg.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);

const pageview = (visitorId: string, sessionId: string) => ({
  op: 'pageview',
  visitorId,
  sessionId,
  path: '/?race=circuit',
  referrer: 'https://www.reddit.com/r/x',
  viewport: { w: 1440, h: 900 },
  screen: { w: 1512, h: 982 },
  clientTimezone: 'America/Los_Angeles',
  language: 'en-US',
  utm: { source: ' Discord ', medium: null, campaign: null },
  build: 'abc1234',
  device: { gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', dpr: 2, cores: 10, memoryGb: 8, touch: false },
});
const event = (visitorId: string, sessionId: string, type: string, metadata: unknown) => ({ op: 'event', visitorId, sessionId, type, metadata });
const START = { mode: 'circuit', seed: 42, seedText: 'neon', carId: 'protoHatch', opponents: 5, difficulty: 'medium', replay: false, ghost: false };
const perf = (medianFps: number) => ({ reason: 'race_end', mode: 'circuit', level: 4, tier: 'medium', auto: true, aimFps: 120, medianFps, p95FrameMs: 14.2, slowShare: 0.01, frames: 9000 });

beforeAll(async () => {
  // The same statement split as scripts/dbInit.ts.
  const schema = readFileSync('db/schema.sql', 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of schema) await pg.exec(s);
  await pg.query(`insert into players (sub, email, name) values ('g-admin', 'admin@example.com', 'Admin'), ('g-player', 'p@example.com', 'Pat')`);

  await beacon(pageview(V, S), { cookie: cookieFor('g-player') });
  await beacon(pageview(V2, S2));
  await beacon({ op: 'heartbeat', visitorId: V, sessionId: S, engagedMs: 90_000, raceMs: 60_000 });
  // A late, smaller beat must never walk the visit back.
  await beacon({ op: 'heartbeat', visitorId: V, sessionId: S, engagedMs: 5_000, raceMs: 1_000 });
  for (const [v, s, fps] of [[V, S, 98], [V2, S2, 55]] as const) {
    await beacon(event(v, s, 'race_start', START));
    await beacon(event(v, s, 'perf', perf(fps)));
  }
  await beacon(event(V, S, 'race_finish', { mode: 'circuit', seed: 42, carId: 'protoHatch', timeMs: 183_400, place: 2, entrants: 6, personalBest: true }));
  await beacon(event(V2, S2, 'race_quit', { mode: 'circuit', seed: 42, carId: 'protoHatch', elapsedMs: 40_000, progress: 0.3, reason: 'quit' }));
  await beacon(event(V, S, 'build_save', { carId: 'protoHatch', slot: 0 }));
  await beacon(event(V, S, 'sign_in', { newAccount: true }), { cookie: cookieFor('g-player') });
  // An events-only visitor: no page view, a session nobody created.
  await beacon(event('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666', 'garage_open', { viaDoor: true }));
});

describe('analytics beacon', () => {
  it('writes one visitor per browser, one session per visit and one row per event', async () => {
    expect([await count('visitors'), await count('visitor_sessions'), await count('page_views'), await count('visitor_events')]).toEqual([3, 2, 2, 9]);
  });

  it('keeps the visit monotonic, canonicalizes tags, decodes geo and links the signed-in player', async () => {
    const s = (await pg.query(`select engaged_ms, race_ms, utm_source, build from visitor_sessions where id = $1`, [S])).rows[0];
    expect(s).toEqual({ engaged_ms: 90_000, race_ms: 60_000, utm_source: 'discord', build: 'abc1234' });
    const v = (await pg.query(`select city, player_sub from visitors where id = $1`, [V])).rows[0];
    expect(v).toEqual({ city: 'San Luis Obispo', player_sub: 'g-player' });
  });

  it('answers 204 to junk and unknown events, and writes nothing for them', async () => {
    const before = await count('visitor_events');
    expect(await beacon('junk')).toBe(204);
    expect(await beacon(event(V, S, 'bogus', {}))).toBe(204);
    expect(await beacon(event('not-a-uuid', S, 'garage_open', { viaDoor: true }))).toBe(204);
    expect(await count('visitor_events')).toBe(before);
  });

  it('drops beacons past the per-address limit, still with a 204', async () => {
    const before = await count('visitor_events');
    const ip = '198.51.100.7';
    for (let i = 0; i < 125; i++) expect(await beacon(event(V, S, 'garage_open', { viaDoor: false }), {}, ip)).toBe(204);
    expect(await count('visitor_events')).toBe(before + 120);
    await pg.query(`delete from visitor_events where type = 'garage_open' and visitor_id = $1`, [V]);
  });
});

describe('admin API', () => {
  const adminCookie = () => cookieFor('g-admin');

  it('lets only ADMIN_EMAILS in', async () => {
    expect((await call('GET', '?op=session')).status).toBe(401);
    expect((await call('GET', '?op=session', { cookie: cookieFor('g-player') })).status).toBe(403);
    expect(await call('GET', '?op=session', { cookie: adminCookie() })).toEqual({ status: 200, json: { email: 'admin@example.com', name: 'Admin' } });
  });

  it('lists visitors with their player, counts and frame rate as numbers', async () => {
    const { status, json } = await call<VisitorListPayload>('GET', '?op=visitors', { cookie: adminCookie() });
    expect(status).toBe(200);
    expect(json.visitors).toHaveLength(3);
    expect(json.visitors.find((v) => v.id === V)).toMatchObject({
      player_email: 'p@example.com',
      page_view_count: 1,
      session_count: 1,
      total_engaged_ms: 90_000,
      total_race_ms: 60_000,
      race_start_count: 1,
      race_finish_count: 1,
      build_save_count: 1,
      median_fps: 98,
      last_tier: 'medium',
      synthetic: false,
    });
  });

  it('returns one visitor in detail, and edits and deletes it', async () => {
    const { status, json } = await call<VisitorDetailPayload>('GET', `?op=visitor&id=${V}`, { cookie: adminCookie() });
    expect(status).toBe(200);
    expect(json.player?.email).toBe('p@example.com');
    expect(json.events.map((e) => e.type).sort()).toEqual(['build_save', 'perf', 'race_finish', 'race_start', 'sign_in']);
    expect(typeof json.events[0].id).toBe('number');
    expect(typeof json.pageViews[0].id).toBe('number');

    expect((await call('PATCH', `?op=visitor&id=${V}`, { cookie: adminCookie(), body: { notes: 'From Discord' } })).status).toBe(200);
    expect((await pg.query(`select notes, location_override from visitors where id = $1`, [V])).rows[0]).toEqual({ notes: 'From Discord', location_override: null });
    expect((await call('GET', '?op=visitor&id=nope', { cookie: adminCookie() })).status).toBe(400);
  });

  it('aggregates the insights with a funnel that never widens', async () => {
    for (const days of [7, 90]) expect((await call('GET', `?op=insights&days=${days}`, { cookie: adminCookie() })).status).toBe(200);
    const { status, json } = await call<InsightsPayload>('GET', '?op=insights&days=30', { cookie: adminCookie() });
    expect(status).toBe(200);
    expect(json.funnel).toEqual({ visited: 3, started: 2, finished: 1, savedBuild: 1, signedIn: 1 });
    expect(json.modes).toEqual([{ mode: 'circuit', starts: 2, finishes: 1, quits: 1, visitors: 2, medianTimeMs: 183_400 }]);
    expect(json.gpus[0]).toMatchObject({ gpu: 'Apple M2 Pro', visitors: 2 });
    expect(json.sources).toEqual([{ host: 'discord', tagged: true, sessions: 2 }]);
    expect(json.hourly).toHaveLength(24);
    expect(json.days).toHaveLength(30);
  });

  it('prunes only with the cron secret', async () => {
    expect((await call('GET', '')).status).toBe(401);
    expect((await call('GET', '', { auth: 'Bearer wrong' })).status).toBe(401);
    expect(await call('GET', '', { auth: `Bearer ${process.env.CRON_SECRET}` })).toEqual({ status: 200, json: { ok: true, pageViews: 0, sessions: 0 } });
  });

  it('deletes a visitor and everything under it', async () => {
    expect((await call('DELETE', `?op=visitor&id=${V2}`, { cookie: adminCookie() })).status).toBe(200);
    expect((await pg.query(`select count(*)::int as n from visitor_events where visitor_id = $1`, [V2])).rows[0]).toEqual({ n: 0 });
  });
});
