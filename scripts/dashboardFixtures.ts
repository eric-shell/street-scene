/**
 * Deterministic fake dashboard data for the UI harness (scripts/dashboardCheck.ts), shaped like the game's real
 * traffic so the UI is tested across its real range, not only on rich rows: about a third single-view bounces,
 * a slice of menu browsers who never drive, a blank slice with no UA or geo (blocked beacons), the drivers, and
 * only the most engaged tail finishing races, saving builds and signing in. Machines are there on purpose so
 * every classifier rung fires: crawlers, an AI agent, our own Playwright, a spoofed Chrome build, a rotating
 * proxy burst (one fingerprint across US cities on a Berlin clock), a lone VPN, and a CUBOT phone that must NOT
 * be flagged. Long labels are there on purpose too (a typed seed, a GPU family, a referrer host, a player
 * email): a fixture that never stresses a label never tests the min-width bug most likely to come back.
 *
 * A seeded PRNG makes every run identical apart from the clock it is anchored to (`now`), so screenshots are
 * diffable run to run. Adding a draw inside the loop reshuffles everything after it: expected, and why nothing
 * asserts on specific counts. Ids start with `5eed` so a row can never be mistaken for a real visitor.
 */
import type { CarRow, GpuRow, InsightsPayload, LinkedPlayer, ModeRow, PageView, SeedRow, SourceRow, TierRow, Visitor, VisitorDetailPayload, VisitorEvent, VisitorSession, VisitorSummary } from '../api/_lib/adminTypes.ts';
import type { EventMetaMap, EventType } from '../src/shared/analytics.ts';
import type { RaceType } from '../src/ui/settings.ts';

const SYNTHETIC = 'synthetic-test';

/** Mulberry32: a tiny seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

/** [city, region, country, ip zone, browser zone] */
const CITIES: [string, string, string, string, string][] = [
  ['San Luis Obispo', 'CA', 'US', 'America/Los_Angeles', 'America/Los_Angeles'],
  ['Brooklyn', 'NY', 'US', 'America/New_York', 'America/New_York'],
  ['Austin', 'TX', 'US', 'America/Chicago', 'America/Chicago'],
  ['Portland', 'OR', 'US', 'America/Los_Angeles', 'America/Los_Angeles'],
  ['London', 'ENG', 'GB', 'Europe/London', 'Europe/London'],
  ['Toronto', 'ON', 'CA', 'America/Toronto', 'America/Toronto'],
  ['Zürich', 'ZH', 'CH', 'Europe/Zurich', 'Europe/Zurich'],
  ['Osaka', '27', 'JP', 'Asia/Tokyo', 'Asia/Tokyo'],
  ['São Paulo', 'SP', 'BR', 'America/Sao_Paulo', 'America/Sao_Paulo'],
];

/** [user agent, unmasked GPU renderer, cores, memory GB, dpr, touch] */
const DEVICES: [string, string, number, number | null, number, boolean][] = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Apple M2', 8, 8, 2, false],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15', 'Apple M1 Pro', 10, null, 2, false],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1', 'Apple GPU', 6, null, 3, true],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'GeForce RTX 4070 Laptop GPU', 16, 16, 1.25, false],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Radeon RX 7900 XTX Phantom Gaming OC 24GB', 24, 32, 1, false],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36', 'Intel(R) Iris(R) Xe Graphics', 8, 8, 1, false],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'Mali-G715', 8, 8, 2.6, true],
  // A real phone brand with "bot" inside its name: the classifier must leave it alone.
  ['Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0 Mobile Safari/537.36', 'Mali-G52', 8, 4, 2, true],
];

const BOT_UAS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'python-requests/2.32.3',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36',
  // A build number no Chrome since 113 sends: Spoofed.
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36',
];

const REFERRERS = [null, null, null, 'https://news.ycombinator.com/', 'https://www.reddit.com/r/WebGames/', 'https://street-scene-tester-invites.example.org/round-two', 'https://t.co/aBcDeFgH', 'https://www.google.com/'];
const LANGS = ['en-US', 'en-US', 'en-GB', 'de-CH', 'ja-JP', 'pt-BR'];
const VIEWPORTS: [number, number, number, number][] = [
  [1512, 856, 3024, 1964],
  [1440, 900, 2560, 1440],
  [1920, 1080, 1920, 1080],
  [390, 844, 390, 844],
  [412, 915, 412, 915],
  [820, 1180, 1024, 1366],
];
const MODES: RaceType[] = ['circuit', 'circuit', 'sprint', 'sprint', 'waypoint', 'drift', 'drag', 'roam', 'roam'];
const CARS = ['wendtFairway', 'wendtFairway', 'kazamaRotor', 'brandtKombi'];
/** Some seeds are raced again and again (a favourite course), some once. */
const SEEDS: [number, string | undefined][] = [
  [1337, 'neon'],
  [424242, 'the long way round through the docks at night'],
  [90210, undefined],
  [777, 'harbour'],
  [31415, undefined],
];
const PLAYERS: [string, string][] = [
  ['Dana Reyes', 'dana.reyes@example.com'],
  ['Marcus Feldt', 'marcus.feldt.racing.club.member@studioatlas.example'],
  ['Priya Raghunathan', 'priya@northlightlabs.example'],
  ['Ola K.', 'ola.k@example.org'],
  ['Jean-Baptiste Moreau', 'jb.moreau@atelier-nine.example'],
];
const NOTES = [null, null, null, null, 'Found the drift zones on the first try. Ask about the gamepad.', 'Tester from the second invite round.'];
const BUILDS = ['6f961ff', 'ca6a8a7', 'ca2b248'];

export interface Fixtures {
  visitors: VisitorSummary[];
  details: Map<string, VisitorDetailPayload>;
  insights: InsightsPayload;
  /** A signed-in visitor who finished races: the row the harness opens. */
  target: VisitorSummary;
}

type RawEvent = { [K in EventType]: { type: K; metadata: EventMetaMap[K]; at: number; session: string | null } }[EventType];

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const iso = (ms: number) => new Date(ms).toISOString();
const host = (ref: string | null) => (ref ? (ref.split('://')[1]?.split('/')[0].replace(/^www\./, '').toLowerCase() ?? '') : '');

/** A GPU's median fps on the Medium tier, before per-drive noise: phones and integrated GPUs struggle. */
function gpuFps(gpu: string): number {
  if (/Mali-G52/.test(gpu)) return 24;
  if (/Mali|Apple GPU/.test(gpu)) return 44;
  if (/Iris/.test(gpu)) return 38;
  if (/M1|M2/.test(gpu)) return 96;
  return 118;
}

export function buildFixtures({ count = 64, seed = 20261025, now = Date.now() }: { count?: number; seed?: number; now?: number } = {}): Fixtures {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
  const uuid = (n: number) => `5eed${n.toString(16).padStart(4, '0')}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;

  const visitors: VisitorSummary[] = [];
  const details = new Map<string, VisitorDetailPayload>();
  const allSessions: (VisitorSession & { visitor: string })[] = [];
  const allEvents: (RawEvent & { visitor: string })[] = [];
  const allViews: (PageView & { visitor: string })[] = [];
  let pvId = 1;
  let evId = 1;
  // The proxy burst: four rows, one fingerprint, a Berlin clock, four US addresses, minutes apart.
  const burstStart = now - 2 * DAY - 3_600_000;
  const BURST_CITIES = [CITIES[0], CITIES[1], CITIES[2], CITIES[3]];

  for (let i = 0; i < count; i++) {
    const id = uuid(i);
    const inBurst = i >= 6 && i < 10;
    const isVpn = i === 12;
    const isBot = !inBurst && r() < 0.1;
    const isBlank = !inBurst && !isBot && r() < 0.09;
    const synthetic = !inBurst && !isBot && !isBlank && r() < 0.05;
    const kind = r();
    const isBounce = !inBurst && kind < 0.32;
    const isBrowser = kind >= 0.32 && kind < 0.55;
    const isDriver = !isBot && !isBlank && !inBurst && kind >= 0.55;
    const [city, region, country, ipTz, clientTz] = inBurst ? BURST_CITIES[i - 6] : pick(CITIES);
    const device = pick(DEVICES);
    const ua = isBlank ? null : isBot ? pick(BOT_UAS) : inBurst ? DEVICES[3][0] : device[0];
    const gpu = isBlank || isBot ? null : inBurst ? DEVICES[3][1] : device[1];
    const [vw, vh, sw, sh] = device[5] ? pick(VIEWPORTS.slice(3, 5)) : pick(VIEWPORTS);
    const firstSeen = inBurst ? burstStart + (i - 6) * 140_000 : now - int(1, 40) * DAY - int(0, 80_000_000);
    const sessionCount = isDriver ? int(1, 4) : isBrowser ? int(1, 2) : 1;
    const player = isDriver && r() < 0.35 ? pick(PLAYERS) : null;
    const sessions: VisitorSession[] = [];
    const views: PageView[] = [];
    const events: RawEvent[] = [];
    let lastSeen = firstSeen;

    for (let s = 0; s < sessionCount; s++) {
      const sid = uuid(4096 + i * 8 + s);
      const startedAt = Math.min(firstSeen + s * int(3_600_000, 5 * DAY), now - 120_000);
      const engaged = isBot ? int(0, 900) : isBounce ? int(800, 4_500) : isBrowser ? int(20_000, 140_000) : int(120_000, 1_500_000);
      const driving = isDriver ? Math.round(engaged * (0.4 + r() * 0.5)) : 0;
      const viewCount = isBot ? int(3, 9) : isBounce ? 1 : int(1, 3);
      const referrer = s === 0 ? pick(REFERRERS) : null;
      const tagged = !isBlank && r() < 0.2;
      if (isBlank) continue;
      sessions.push({
        id: sid,
        started_at: iso(startedAt),
        last_beat_at: iso(startedAt + engaged),
        engaged_ms: engaged,
        race_ms: driving,
        entry_path: '/',
        referrer,
        viewport_w: vw,
        viewport_h: vh,
        screen_w: sw,
        screen_h: sh,
        utm_source: synthetic ? 'harness' : tagged ? 'discord' : null,
        utm_medium: synthetic ? 'ci' : tagged ? 'social' : null,
        utm_campaign: synthetic ? SYNTHETIC : tagged && r() < 0.5 ? 'tester-round-two' : null,
        build: pick(BUILDS),
        page_view_count: viewCount,
      });
      for (let p = 0; p < viewCount; p++) {
        views.push({ id: pvId++, session_id: sid, path: p === 0 ? '/' : pick(['/?seed=neon', '/?race=drift&seed=1337', '/?garage', '/?drone']), referrer: p === 0 ? referrer : null, created_at: iso(startedAt + p * int(5_000, 60_000)) });
      }
      if (isBrowser && r() < 0.4) events.push({ type: 'garage_open', metadata: { viaDoor: true }, at: startedAt + 30_000, session: sid });
      if (isDriver) {
        let t = startedAt + 20_000;
        const races = int(1, 4);
        for (let k = 0; k < races; k++) {
          const mode = pick(MODES);
          const [seedN, seedText] = pick(SEEDS);
          const carId = pick(CARS);
          const opponents = mode === 'drift' || mode === 'roam' ? 0 : mode === 'drag' ? 1 : int(3, 5);
          events.push({ type: 'race_start', metadata: { mode, seed: seedN, ...(seedText ? { seedText } : {}), carId, opponents, difficulty: pick(['easy', 'medium', 'hard'] as const), replay: false, ghost: r() < 0.3 }, at: t, session: sid });
          const raceMs = mode === 'drag' ? int(11_000, 16_000) : mode === 'roam' ? int(60_000, 400_000) : int(60_000, 190_000);
          t += raceMs;
          const outcome = r();
          if (mode !== 'roam' && outcome < 0.62) {
            const entrants = opponents + 1;
            events.push({ type: 'race_finish', metadata: { mode, seed: seedN, carId, timeMs: raceMs, place: int(1, entrants), entrants, personalBest: r() < 0.3, ...(mode === 'drift' ? { score: int(8_000, 64_000) } : {}) }, at: t, session: sid });
          } else if (outcome < 0.9) {
            events.push({ type: 'race_quit', metadata: { mode, seed: seedN, carId, elapsedMs: Math.round(raceMs * 0.6), ...(mode === 'roam' ? {} : { progress: Math.round(r() * 90) / 100 }), reason: pick(['quit', 'restart', 'pagehide'] as const) }, at: t, session: sid });
          }
          const base = gpuFps(gpu ?? '');
          const fps = Math.max(12, Math.min(120, base + int(-8, 6)));
          const tier = fps >= 90 ? 'high' : fps >= 40 ? 'medium' : 'low';
          events.push({ type: 'perf', metadata: { reason: 'race_end', mode, level: tier === 'high' ? 5 : tier === 'medium' ? 3 : 1, tier, auto: r() < 0.85, aimFps: 120, medianFps: fps, p95FrameMs: Math.round(1000 / Math.max(10, fps - 14)), slowShare: fps < 30 ? 0.4 : fps < 60 ? 0.06 : 0.002, frames: Math.round((raceMs / 1000) * fps) }, at: t + 500, session: sid });
          t += 15_000;
        }
        if (r() < 0.45) {
          events.push({ type: 'garage_open', metadata: { viaDoor: r() < 0.7 }, at: t, session: sid });
          events.push({ type: 'build_save', metadata: { carId: pick(CARS), slot: int(0, 3) }, at: t + 40_000, session: sid });
          if (r() < 0.3) events.push({ type: 'build_share', metadata: { carId: pick(CARS) }, at: t + 50_000, session: sid });
        }
        if (player && s === 0) events.push({ type: 'sign_in', metadata: { newAccount: true }, at: startedAt + 10_000, session: sid });
      }
      lastSeen = Math.min(Math.max(lastSeen, startedAt + engaged), now - 60_000);
    }

    const countOf = (t: EventType) => events.filter((e) => e.type === t).length;
    const perf = events.flatMap((e) => (e.type === 'perf' ? [e.metadata] : []));
    const activeDays = new Set(sessions.map((s) => s.started_at.slice(0, 10))).size;
    const lastPerf = perf[perf.length - 1];
    const visitor: Visitor = {
      id,
      first_seen_at: iso(firstSeen),
      last_seen_at: iso(lastSeen),
      user_agent: ua,
      country: isBlank ? null : country,
      city: isBlank ? null : city,
      region: isBlank ? null : region,
      timezone: isBlank ? null : isVpn ? 'America/New_York' : ipTz,
      location_override: !isBlank && !isBot && r() < 0.1 ? `${city}, near the waterfront` : null,
      client_timezone: isBlank || (isBot && !/HeadlessChrome|Chrome\/141/.test(ua ?? '')) ? null : inBurst ? 'Europe/Berlin' : isVpn ? 'Asia/Tokyo' : clientTz,
      language: isBlank || (isBot && !/HeadlessChrome|Chrome\/141/.test(ua ?? '')) ? null : pick(LANGS),
      referrer: sessions[0]?.referrer ?? null,
      gpu,
      dpr: isBlank || isBot ? null : device[4],
      cores: isBlank || isBot ? null : device[2],
      memory_gb: isBlank || isBot ? null : device[3],
      touch: isBlank || isBot ? null : device[5],
      notes: isBot ? null : pick(NOTES),
    };
    const linked: LinkedPlayer | null = player ? { sub: `1${hex(20)}`, email: player[1], name: player[0], created_at: iso(firstSeen + 10_000), seen_at: iso(lastSeen) } : null;
    const lastActivity = Math.max(lastSeen, ...events.map((e) => e.at), ...views.map((v) => Date.parse(v.created_at)));
    const summary: VisitorSummary = {
      id,
      first_seen_at: visitor.first_seen_at,
      last_seen_at: visitor.last_seen_at,
      user_agent: visitor.user_agent,
      country: visitor.country,
      city: visitor.city,
      region: visitor.region,
      timezone: visitor.timezone,
      location_override: visitor.location_override,
      client_timezone: visitor.client_timezone,
      language: visitor.language,
      referrer: visitor.referrer,
      gpu: visitor.gpu,
      touch: visitor.touch,
      notes: visitor.notes,
      player_email: linked?.email ?? null,
      player_name: linked?.name ?? null,
      page_view_count: views.length,
      session_count: sessions.length,
      active_days: activeDays,
      total_engaged_ms: sessions.reduce((s, x) => s + x.engaged_ms, 0),
      total_race_ms: sessions.reduce((s, x) => s + x.race_ms, 0),
      race_start_count: countOf('race_start'),
      race_finish_count: countOf('race_finish'),
      race_quit_count: countOf('race_quit'),
      build_save_count: countOf('build_save'),
      median_fps: median(perf.map((p) => p.medianFps)),
      last_tier: lastPerf?.tier ?? null,
      synthetic,
      last_activity_at: iso(Math.min(lastActivity, now - 30_000)),
    };
    visitors.push(summary);
    const stored: VisitorEvent[] = events.map((e) => ({ id: evId++, session_id: e.session, type: e.type, metadata: e.metadata, created_at: iso(Math.min(e.at, now - 30_000)) }) as VisitorEvent);
    details.set(id, {
      visitor,
      player: linked,
      // The real endpoint's order: sessions and page views newest first, events newest first.
      sessions: [...sessions].sort((a, b) => b.started_at.localeCompare(a.started_at)),
      pageViews: [...views].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      events: stored.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    });
    for (const s of sessions) allSessions.push({ ...s, visitor: id });
    for (const v of views) allViews.push({ ...v, visitor: id });
    for (const e of events) allEvents.push({ ...e, visitor: id });
  }

  visitors.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  const target = visitors.find((v) => v.player_email && v.race_finish_count > 1) ?? visitors.find((v) => v.race_finish_count > 0) ?? visitors[0];
  return { visitors, details, insights: buildInsights(visitors, allSessions, allViews, allEvents, now), target };
}

/** The insights aggregate from the same fixtures, mirroring api/admin.ts's definitions, so the panel agrees with the table. */
function buildInsights(visitors: VisitorSummary[], sessions: (VisitorSession & { visitor: string })[], views: (PageView & { visitor: string })[], events: (RawEvent & { visitor: string })[], now: number): InsightsPayload {
  const windowDays = 30;
  const since = now - windowDays * DAY;
  const ses = sessions.filter((s) => Date.parse(s.started_at) >= since);
  const ev = events.filter((e) => e.at >= since);
  const who = (pred: (e: RawEvent) => boolean) => new Set(ev.filter(pred).map((e) => e.visitor));
  const visited = new Set([...ses.map((s) => s.visitor), ...views.filter((v) => Date.parse(v.created_at) >= since).map((v) => v.visitor), ...ev.map((e) => e.visitor)]);
  const started = who((e) => e.type === 'race_start');
  const finished = new Set([...who((e) => e.type === 'race_finish')].filter((v) => started.has(v)));
  const saved = new Set([...who((e) => e.type === 'build_save')].filter((v) => finished.has(v)));
  const signed = new Set([...who((e) => e.type === 'sign_in')].filter((v) => saved.has(v)));

  const modes: ModeRow[] = [];
  for (const mode of ['circuit', 'sprint', 'waypoint', 'drift', 'drag', 'roam'] as const) {
    const starts = ev.filter((e) => e.type === 'race_start' && e.metadata.mode === mode);
    const fins = ev.flatMap((e) => (e.type === 'race_finish' && e.metadata.mode === mode ? [e.metadata.timeMs] : []));
    if (starts.length === 0) continue;
    modes.push({ mode, starts: starts.length, finishes: fins.length, quits: ev.filter((e) => e.type === 'race_quit' && e.metadata.mode === mode).length, visitors: new Set(starts.map((e) => e.visitor)).size, medianTimeMs: median(fins) });
  }
  const tally = <K extends string | number>(rows: { key: K; visitor: string }[]) => {
    const m = new Map<K, { n: number; v: Set<string> }>();
    for (const row of rows) {
      const e = m.get(row.key) ?? { n: 0, v: new Set() };
      e.n++;
      e.v.add(row.visitor);
      m.set(row.key, e);
    }
    return [...m].sort((a, b) => b[1].n - a[1].n);
  };
  const startsMeta = ev.flatMap((e) => (e.type === 'race_start' ? [{ m: e.metadata, visitor: e.visitor }] : []));
  const cars: CarRow[] = tally(startsMeta.map((s) => ({ key: s.m.carId, visitor: s.visitor }))).map(([carId, x]) => ({ carId, starts: x.n, visitors: x.v.size }));
  const seeds: SeedRow[] = tally(startsMeta.map((s) => ({ key: s.m.seed, visitor: s.visitor })))
    .filter(([, x]) => x.n > 1)
    .slice(0, 8)
    .map(([seed, x]) => ({ seed, seedText: startsMeta.find((s) => s.m.seed === seed)?.m.seedText ?? null, starts: x.n, visitors: x.v.size }));
  const perf = ev.flatMap((e) => (e.type === 'perf' ? [{ m: e.metadata, visitor: e.visitor }] : []));
  const tiers: TierRow[] = (['low', 'medium', 'high'] as const).flatMap((tier) => {
    const rows = perf.filter((p) => p.m.tier === tier);
    if (rows.length === 0) return [];
    return [{ tier, samples: rows.length, visitors: new Set(rows.map((p) => p.visitor)).size, medianFps: median(rows.map((p) => p.m.medianFps)) ?? 0, p95FrameMs: median(rows.map((p) => p.m.p95FrameMs)) ?? 0, slowShare: rows.reduce((s, p) => s + p.m.slowShare, 0) / rows.length }];
  });
  const byGpu = new Map<string, typeof perf>();
  for (const p of perf) {
    const gpu = visitors.find((v) => v.id === p.visitor)?.gpu;
    if (gpu) byGpu.set(gpu.slice(0, 40), [...(byGpu.get(gpu.slice(0, 40)) ?? []), p]);
  }
  const gpus: GpuRow[] = [...byGpu]
    .map(([gpu, rows]) => {
      const counts = tally(rows.map((p) => ({ key: p.m.tier, visitor: p.visitor })));
      return { gpu, visitors: new Set(rows.map((p) => p.visitor)).size, medianFps: median(rows.map((p) => p.m.medianFps)) ?? 0, tier: counts[0][0] };
    })
    .sort((a, b) => b.visitors - a.visitors || a.medianFps - b.medianFps);
  const sources: SourceRow[] = tally(ses.map((s) => ({ key: `${s.utm_source ? 1 : 0}|${s.utm_source ?? host(s.referrer)}`, visitor: s.visitor })))
    .slice(0, 8)
    .map(([key, x]) => ({ host: key.slice(2), tagged: key[0] === '1', sessions: x.n }));
  const hours = new Map<number, number>();
  for (const s of ses) hours.set(new Date(s.started_at).getUTCHours(), (hours.get(new Date(s.started_at).getUTCHours()) ?? 0) + 1);
  const firsts = new Map<string, number>();
  for (const v of visitors) firsts.set(v.first_seen_at.slice(0, 10), (firsts.get(v.first_seen_at.slice(0, 10)) ?? 0) + 1);
  const raced = ses.filter((s) => s.race_ms > 0);
  return {
    windowDays,
    sessions: {
      total: ses.length,
      viewport: { known: ses.length, phone: ses.filter((s) => (s.viewport_w ?? 0) < 640).length, tablet: ses.filter((s) => (s.viewport_w ?? 0) >= 640 && (s.viewport_w ?? 0) < 1024).length, desktop: ses.filter((s) => (s.viewport_w ?? 0) >= 1024).length },
      medianEngagedMs: median(ses.map((s) => s.engaged_ms)) ?? 0,
      medianRaceMs: median(raced.map((s) => s.race_ms)) ?? 0,
    },
    funnel: { visited: visited.size, started: started.size, finished: finished.size, savedBuild: saved.size, signedIn: signed.size },
    modes,
    cars,
    seeds,
    tiers,
    gpus,
    sources,
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: hours.get(hour) ?? 0 })),
    days: Array.from({ length: windowDays }, (_, i) => {
      const date = iso(now - (windowDays - 1 - i) * DAY).slice(0, 10);
      return { date, visitors: firsts.get(date) ?? 0 };
    }),
    // A fixed spread of crash reports: a long message to truncate, a browser report with no stack, a one-off.
    errors: [
      { kind: 'error', message: "TypeError: Cannot read properties of undefined (reading 'position') while the garage swapped the wheel set on a car still loading", count: 14, visitors: 6, firstSeen: iso(now - 5 * DAY), lastSeen: iso(now - 2 * 3_600_000), stack: "TypeError: Cannot read properties of undefined (reading 'position')\n    at CarView.setWheels (/assets/main-abc123.js:1:48211)\n    at GarageScreen.apply (/assets/main-abc123.js:1:90412)", screens: ['garage'] },
      { kind: 'webgl', message: 'Error: Error creating WebGL context.', count: 3, visitors: 3, firstSeen: iso(now - 9 * DAY), lastSeen: iso(now - DAY), stack: null, screens: [] },
      { kind: 'rejection', message: 'AbortError: The play() request was interrupted by a call to pause().', count: 1, visitors: 1, firstSeen: iso(now - 3 * DAY), lastSeen: iso(now - 3 * DAY), stack: null, screens: ['menu', 'race'] },
    ],
    errorReports: 18,
  };
}
