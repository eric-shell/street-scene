/**
 * What kind of visit was this? Ported from the eric-shell CRM's classifier with its machine and proxy rungs kept
 * word for word in behaviour, and its portfolio outcomes (Converted, Chatted, Reader) replaced by the game's:
 * finished a race, raced, tuned in the garage, signed in.
 *
 * The shape: every row gets exactly ONE nature tag (what the client is, or failing that, what it did), plus any
 * qualifiers. A blank Flags cell is a bug. The ladder is ordered by how much it explains: what the client IS
 * beats what it did, and the first rung that matches wins.
 *
 *   nature      Test · LLM · Bot · Proxy · Spoofed · Headless · No dwell ·
 *               Finished · Raced · Garage · Signed in · Untracked · Lingered · Bounce · Skimmed
 *   qualifiers  Returning · VPN? · Burst
 *
 * Honesty: there is no `Real` or `Human` tag, because nothing here can establish either; the baseline tags name
 * what was OBSERVED (`Skimmed`, `Untracked`). Full coverage means the column cannot spot exceptions by being
 * mostly empty, so tone does that job: the ordinary states are `neutral` and recede, green marks a person who
 * did something, red marks traffic to discount.
 *
 * Tags are presentational only and derived at render time, never stored: nothing is hidden, deleted or blocked
 * on a tag, except behind the opt-in "Hide automated" filter, which keys off `automated` and reports how many
 * rows it removed. Changing a rule relabels the whole history on the next paint, with nothing to backfill.
 * Signals are limited to what a list row carries (VisitorSummary), plus, for the two proxy rules, the other
 * rows in the same list. No data is collected for any of this.
 */
import { SYNTHETIC_CAMPAIGN, type VisitorSummary } from '../../../api/_lib/adminTypes';
import { formatDuration } from './dateFormat';

/**
 * How loudly a tag argues for attention.
 *
 *   reject   Discount this: not a person, and not wanted.           (red)
 *   warn     Corroborating evidence: suggestive, never decisive.    (yellow)
 *   muted    A machine, but an expected and benign one.             (grey)
 *   good     A person did something worth seeing.                   (green)
 *   neutral  The ordinary middle.                                   (grey, no fill)
 *
 * `reject` vs `muted` is the split that matters: both are machines and only one is a problem. Googlebot indexing
 * the game is the system working and `Test` is our own traffic, so neither gets the alarm color. `warn` is the
 * two halves of the Proxy rule, which exist because neither half convicts alone. `Bounce` is deliberately NOT
 * warn: a real person who left quickly is the most common honest outcome, and warn on it would paint ordinary
 * people as suspects. (The CRM's `danger` tone was its `Spam?` tag, which has no game counterpart.)
 * TONE_RANK in sortVisitors.ts and the tag styles in components/_visitor-tag.scss move with this list.
 */
export type TagTone = 'reject' | 'warn' | 'muted' | 'good' | 'neutral';

export interface VisitorTag {
  /** Short label rendered in the row. */
  label: string;
  tone: TagTone;
  /** Why it fired, surfaced as a title: a judgement is never unexplained. */
  reason: string;
  /**
   * This row is a machine, not a person, and is safe to hide behind "Hide automated". The filter's contract:
   * its label names this predicate, never a list of tags, so the classifier can grow without the label lying.
   * Never set on Bounce: brief is not bogus.
   */
  automated?: true;
}

// Google's crawler fleet, listed out because most of it is invisible to the generic patterns: `GoogleOther`,
// `AdsBot-Google` and `Storebot-Google` have a letter rather than a boundary before "bot" and a hyphen rather
// than the slash `bot/` looks for. Google-Extended is in LLM_UA, which is checked first.
const GOOGLE_UA = [/googlebot/i, /googleother/i, /adsbot-google/i, /storebot-google/i, /google-inspectiontool/i, /apis-google/i, /mediapartners-google/i, /feedfetcher-google/i, /google-safety/i];

// Curated rather than a bare /bot/: "CUBOT" is a real Android phone brand and "Abbott" appears in corporate
// user agents, so \b boundaries and the explicit `Bot/` form, never a loose `[a-z]bot`.
const BOT_UA = [
  /\bbot\b/i, /bot\//i, /\bcrawler\b/i, /\bspider\b/i, /\bslurp\b/i,
  ...GOOGLE_UA,
  /bingbot/i, /duckduckbot/i, /yandex(bot)?/i, /baiduspider/i,
  /ahrefs/i, /semrush/i, /mj12bot/i, /dotbot/i, /petalbot/i, /applebot/i,
  /facebookexternalhit/i, /whatsapp/i, /telegrambot/i, /discordbot/i, /slackbot/i,
  /python-requests/i, /\bcurl\//i, /\bwget\b/i, /axios/i, /go-http-client/i,
  /okhttp/i, /java\//i, /scrapy/i, /httpclient/i, /libwww/i,
];

/** Browser automation, the tools WE drive (the dashboard harness, the e2e specs): `Test`, not `Bot`. */
const TOOLING_UA = [/headlesschrome/i, /phantomjs/i, /puppeteer/i, /playwright/i, /selenium/i, /lighthouse/i, /chrome-lighthouse/i];

/**
 * AI crawlers and assistants, checked BEFORE the bot list (most also match /\bbot\b/). Training crawlers and
 * live fetches a person asked for sit together: neither is a browser, and neither will ever drive.
 */
const LLM_UA = [
  /gptbot/i, /chatgpt-user/i, /oai-searchbot/i,
  /claudebot/i, /claude-user/i, /claude-searchbot/i, /anthropic-ai/i,
  /google-extended/i, /google-cloudvertexbot/i, /meta-externalagent/i,
  /meta-externalfetcher/i, /applebot-extended/i, /amazonbot/i, /bytespider/i,
  /perplexitybot/i, /perplexity-user/i, /mistralai-user/i, /duckassistbot/i,
  /youbot/i, /cohere-ai/i, /cohere-training-data-crawler/i, /ai2bot/i,
  /ccbot/i, /diffbot/i, /timpibot/i, /omgilibot/i, /firecrawl/i, /pangubot/i,
];

/**
 * Chrome froze its UA version at `<major>.0.0.0` when UA reduction completed in Chrome 113, so a UA claiming 113
 * or newer WITH a build number (`Chrome/149.0.7827.0`) is not Chrome: Chromium, Chrome for Testing or a scraper
 * reciting a copied string. The one rung inferred rather than read, and the only one that catches a client
 * trying not to be caught. Three guards keep it off real browsers, and removing any one hides real people:
 *  - Major 113 or newer only: every older Chrome sent a build number, and a Windows 7 holdout on 109 is a person.
 *  - Chromium forks are skipped (CHROMIUM_FORK): they embed `Chrome/…` and follow reduction on their own schedule.
 *  - The UA must END where plain Chrome's does, at `[Mobile ]Safari/537.36`: anything appended is a token the
 *    fork list did not anticipate, and an unrecognised client must fail to a verdict of nothing.
 */
const CHROME_BUILD = /Chrome\/(\d+)\.(\d+\.\d+\.\d+)/;
const UA_REDUCTION_MAJOR = 113;
const CHROMIUM_FORK = /Edg[A-Z]?\/|OPR\/|SamsungBrowser\/|YaBrowser\/|Vivaldi|Brave\/|UCBrowser\/|CriOS\/|Whale\/|QQBrowser|MiuiBrowser|HuaweiBrowser|DuckDuckGo\/|Electron\/|\bwv\b/i;

/** The impossible version this UA claims, or null if it claims a possible one. */
export function impossibleChromeVersion(ua: string): string | null {
  if (CHROMIUM_FORK.test(ua)) return null;
  if (!/Safari\/537\.36\s*$/.test(ua)) return null;
  const m = CHROME_BUILD.exec(ua);
  if (!m) return null;
  const [, major, rest] = m;
  if (Number(major) < UA_REDUCTION_MAJOR || rest === '0.0.0') return null;
  return `${major}.${rest}`;
}

/** Engaged time below this across several page views reads as a scripted fetch (ms). */
const NO_DWELL_MS = 2_000;
/** A single view under this is a bounce (ms). */
const BOUNCE_MS = 5_000;
/** Time on the menus (no drive, no garage) that counts as a look around rather than a skim (ms). */
const LINGER_MS = 45_000;

/**
 * Minutes east of UTC for an IANA zone AT a given instant (Europe/Berlin is +1 in January and +2 in July, and
 * the hemispheres change over on different dates), or null for a zone Intl will not take.
 */
function tzOffsetMinutes(tz: string, at: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return null;
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    if (!m) return name === 'GMT' ? 0 : null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    // An unknown zone throws RangeError. Unknown is not evidence of anything.
    return null;
  }
}

/** How far apart the browser's clock and the IP's clock are, in minutes, at the visit's own first sighting. */
function timezoneGapMinutes(v: VisitorSummary): number | null {
  if (!v.client_timezone || !v.timezone) return null;
  const at = new Date(v.first_seen_at);
  if (Number.isNaN(at.getTime())) return null;
  const browser = tzOffsetMinutes(v.client_timezone, at);
  const ip = tzOffsetMinutes(v.timezone, at);
  if (browser === null || ip === null) return null;
  return Math.abs(browser - ip);
}

/**
 * Four hours, not three: three is the width of the continental US, and someone in LA whose corporate VPN exits
 * in Virginia is an ordinary thing to be. Four means the readings are a continent apart.
 */
const TZ_GAP_MINUTES = 240;

/** A coordinated arrival a row was part of. */
export interface BurstInfo {
  /** Distinct visitor rows in the run. */
  size: number;
  /** Distinct IP-derived locations across them. */
  locations: number;
  /** First to last arrival, in ms. */
  spanMs: number;
}

export type BurstMap = ReadonlyMap<string, BurstInfo>;

const BURST_WINDOW_MS = 10 * 60_000;
const BURST_MIN_VISITORS = 3;
const BURST_MIN_LOCATIONS = 2;

function locationKey(v: VisitorSummary): string {
  return `${v.city ?? ''}|${v.region ?? ''}|${v.country ?? ''}`.toLowerCase();
}

/**
 * Runs of visitors that arrived together behind rotating exit addresses: 3+ separate visitor rows (a visitor id
 * lives in localStorage, so three rows are three storage contexts) inside ten minutes, sharing one
 * `(client_timezone, user_agent)` fingerprint, across 2+ IP locations. Grouping on the UA keeps ordinary
 * traffic out: the owner testing on a laptop, a phone and a tablet makes three groups too small to fire. Two
 * locations is enough BECAUSE of that grouping. Rows with no UA or no browser zone are skipped: a missing
 * fingerprint is not a shared one. Compute it once over the FULL list (Dashboard does, before the timeframe
 * narrows it), so a cluster straddling midnight does not half-dissolve.
 */
export function detectProxyBursts(visitors: VisitorSummary[]): BurstMap {
  const groups = new Map<string, VisitorSummary[]>();
  for (const v of visitors) {
    if (!v.client_timezone || !v.user_agent) continue;
    const key = `${v.client_timezone} ${v.user_agent}`;
    const list = groups.get(key);
    if (list) list.push(v);
    else groups.set(key, [v]);
  }
  const found = new Map<string, BurstInfo>();
  for (const list of groups.values()) {
    if (list.length < BURST_MIN_VISITORS) continue;
    const rows = [...list].sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
    const times = rows.map((r) => new Date(r.first_seen_at).getTime());
    for (let i = 0; i < rows.length; i++) {
      let j = i;
      while (j + 1 < rows.length && times[j + 1] - times[i] <= BURST_WINDOW_MS) j++;
      const run = rows.slice(i, j + 1);
      if (run.length < BURST_MIN_VISITORS) continue;
      const locations = new Set(run.map(locationKey)).size;
      if (locations < BURST_MIN_LOCATIONS) continue;
      const info: BurstInfo = { size: run.length, locations, spanMs: times[j] - times[i] };
      // Windows overlap, so a row can land in several runs: keep the largest.
      for (const r of run) {
        const prev = found.get(r.id);
        if (!prev || info.size > prev.size) found.set(r.id, info);
      }
    }
  }
  return found;
}

function hours(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The one tag every row is guaranteed. First rung that matches wins. */
function natureOf(v: VisitorSummary, burst: BurstInfo | undefined, gap: number | null): VisitorTag {
  const ua = v.user_agent ?? '';
  const views = v.page_view_count;
  const engaged = v.total_engaged_ms;
  const pages = plural(views, 'page view');

  // --- What the client IS. Machine kinds, most specific first. ---

  // Our own tooling, by either tell: the campaign tag synthetic runs carry (they may spoof an ordinary UA, so
  // the campaign is the load-bearing one), or an automation UA.
  if (v.synthetic || (ua !== '' && TOOLING_UA.some((re) => re.test(ua)))) {
    return {
      label: 'Test',
      automated: true,
      tone: 'muted',
      reason: v.synthetic ? `Traffic our own tooling made: a session tagged utm_campaign=${SYNTHETIC_CAMPAIGN}. Not a real visitor.` : `Browser automation, not a person: ${ua.slice(0, 80)}`,
    };
  }
  if (ua !== '' && LLM_UA.some((re) => re.test(ua))) {
    return {
      label: 'LLM',
      automated: true,
      tone: 'muted',
      reason: `An AI crawler or assistant, self-identified in its user agent: ${ua.slice(0, 80)}. Training, indexing or a fetch someone asked for; never a browser, so it will never drive.`,
    };
  }
  if (ua !== '' && BOT_UA.some((re) => re.test(ua))) {
    return { label: 'Bot', automated: true, tone: 'reject', reason: `User agent matches a known crawler or HTTP client: ${ua.slice(0, 80)}` };
  }
  // Both halves, deliberately: a disagreeing clock is a VPN, which plenty of players use; arriving with others is
  // what a link doing the rounds looks like. Together: one fingerprint, one frozen clock, several addresses.
  if (burst && gap !== null && gap >= TZ_GAP_MINUTES) {
    return {
      label: 'Proxy',
      automated: true,
      tone: 'reject',
      reason:
        `Arrived with ${plural(burst.size - 1, 'other visitor')} inside ${Math.round(burst.spanMs / 1000)}s, sharing one browser fingerprint across ${burst.locations} IP locations, ` +
        `while the browser's clock (${v.client_timezone}) sits ${hours(gap)} from the one its address implies (${v.timezone}). Rotating exit IPs behind one automated client.`,
    };
  }
  // Below Proxy (which says this AND where it came through), above everything behavioural: a UA that cannot exist
  // outranks anything the visit did.
  const impossible = ua !== '' ? impossibleChromeVersion(ua) : null;
  if (impossible !== null) {
    return {
      label: 'Spoofed',
      automated: true,
      tone: 'reject',
      reason: `Claims Chrome ${impossible}, which no Chrome can be: since Chrome ${UA_REDUCTION_MAJOR} the browser sends a frozen <major>.0.0.0 version. Chromium, Chrome for Testing or a scraper; its play time means nothing.`,
    };
  }
  // The analytics only run where JS runs, so a page view with no browser-reported zone or language means a stubbed JS environment.
  if (views > 0 && !v.client_timezone && !v.language) {
    return { label: 'Headless', automated: true, tone: 'reject', reason: 'Recorded page views but reported no browser time zone or language, which a real browser always sends.' };
  }
  if (views >= 3 && engaged < NO_DWELL_MS) {
    return { label: 'No dwell', automated: true, tone: 'reject', reason: `${pages} but under ${NO_DWELL_MS / 1000}s of engaged time: fetched, not played.` };
  }

  // --- What the client DID. Strongest outcome first. ---

  if (v.race_finish_count > 0) {
    return {
      label: 'Finished',
      tone: 'good',
      reason: `Crossed the line in ${plural(v.race_finish_count, 'race')} of ${plural(v.race_start_count, 'start')}, ${formatDuration(v.total_race_ms)} driving.`,
    };
  }
  if (v.race_start_count > 0) {
    return {
      label: 'Raced',
      tone: 'good',
      reason: `Started ${plural(v.race_start_count, 'race')} or free roams (${formatDuration(v.total_race_ms)} driving) but never finished one${v.race_quit_count ? `; quit ${plural(v.race_quit_count, 'time')}` : ''}.`,
    };
  }
  if (v.build_save_count > 0) {
    return { label: 'Garage', tone: 'good', reason: `Saved ${plural(v.build_save_count, 'build')} in the garage but never started a race.` };
  }
  if (v.player_email) {
    return { label: 'Signed in', tone: 'good', reason: `Signed in as ${v.player_email} but never raced or saved a build on this browser.` };
  }
  // Nothing the analytics recorded. Not a judgement: also what a visitor whose browser blocks the beacon looks like.
  if (views === 0) {
    return { label: 'Untracked', tone: 'neutral', reason: 'No page view was ever recorded: a blocked or failed beacon, or a request that never loaded the game.' };
  }
  // Neutral, not good: in a game the outcome is driving, and time on the menus alone is looking, not playing.
  if (engaged >= LINGER_MS) {
    return { label: 'Lingered', tone: 'neutral', reason: `${formatDuration(engaged)} engaged across ${pages}, on the menus: looked around, never drove.` };
  }
  if (views <= 1 && engaged < BOUNCE_MS) {
    return { label: 'Bounce', tone: 'neutral', reason: `A single page view with under ${BOUNCE_MS / 1000}s of engaged time.` };
  }
  return { label: 'Skimmed', tone: 'neutral', reason: `${pages}, ${formatDuration(engaged)} engaged: more than a bounce, short of a look around.` };
}

export function classifyVisitor(v: VisitorSummary, bursts?: BurstMap): VisitorTag[] {
  const burst = bursts?.get(v.id);
  const gap = timezoneGapMinutes(v);
  const nature = natureOf(v, burst, gap);
  const tags: VisitorTag[] = [nature];

  // Infrastructure qualifiers, so unlike Returning they DO apply to machines (a crawler behind rotating addresses
  // is worth knowing about). Suppressed only under Proxy, whose reason already says both. Neither is automated.
  if (nature.label !== 'Proxy') {
    if (gap !== null && gap >= TZ_GAP_MINUTES) {
      tags.push({
        label: 'VPN?',
        tone: 'warn',
        reason: `The browser reported ${v.client_timezone} but the address geolocates to ${v.timezone}: ${hours(gap)} apart, at least a continent. Usually a VPN or a remote desktop; not a judgement on its own.`,
      });
    }
    if (burst) {
      tags.push({
        label: 'Burst',
        tone: 'warn',
        reason: `One of ${burst.size} separate visitors that arrived within ${Math.round(burst.spanMs / 1000)}s with an identical browser fingerprint, across ${burst.locations} IP locations. A link doing the rounds, or one client behind several addresses.`,
      });
    }
  }

  // Came back on a different DAY (two visits twenty minutes apart are one sitting). `active_days` counts days
  // with any recorded activity, so there is deliberately no `session_count >= 2` here: it adds nothing and is
  // false for anyone whose sessions were never written.
  if (nature.automated !== true && v.active_days >= 2) {
    tags.push({ label: 'Returning', tone: 'good', reason: `Recorded activity on ${v.active_days} separate days${v.session_count >= 2 ? ` across ${v.session_count} sessions` : ''}.` });
  }
  return tags;
}

/** Machine traffic rather than a person: what "Hide automated" filters on. */
export function isAutomated(v: VisitorSummary, bursts?: BurstMap): boolean {
  return classifyVisitor(v, bursts).some((t) => t.automated);
}

/** Started a race or free roam: what "Drivers only" keeps. */
export function hasDriven(v: VisitorSummary): boolean {
  return v.race_start_count > 0;
}
