/**
 * Rate limits for the public analytics beacon, in two layers so the endpoint is never unguarded:
 *
 * - **Per warm instance, always on.** A fixed window per client IP in this instance's memory. Vercel reuses a
 *   warm instance across many requests, so one source hammering the endpoint mostly lands on the same few
 *   instances and is cut off here with no network call and nothing to configure. It cannot see across
 *   instances, which is what the second layer is for.
 * - **Shared, when Upstash is configured.** The same window per IP plus one global daily ceiling, counted in
 *   Upstash Redis (`UPSTASH_REDIS_REST_URL` / `_TOKEN`, or the `KV_REST_API_*` names the Vercel marketplace
 *   integration injects). Spoken over Upstash's REST pipeline with `fetch`, one round trip per request, so
 *   there is no SDK. The global ceiling is what bounds a distributed flood: it caps rows written per day, and
 *   with them the free Neon tier's storage, however many addresses send.
 *
 * Fails open: if Upstash is slow, down or unset, the in-memory layer still applies and the beacon goes
 * through. Losing a limiter for a while costs some junk rows; failing closed would silently drop every real
 * player's analytics during an Upstash outage. The client IP is Vercel's `x-forwarded-for` first hop (Vercel
 * overwrites the header, so a client cannot spoof it there); it is used only as a key with a short expiry
 * and never stored with the analytics.
 */

export interface RateRule {
  /** Names the counters, e.g. 'analytics'. */
  name: string;
  /** Requests one IP may make per window. */
  perIp: number;
  /** The window, in s. */
  windowS: number;
  /** Requests all clients together may make per UTC day (shared layer only). */
  perDay: number;
}

/** Abandon an Upstash call after this long, in ms, and let the request through. */
const UPSTASH_TIMEOUT_MS = 800;

/** Most IPs tracked per instance; the oldest windows go first beyond it, so memory stays bounded under a flood. */
const MAX_TRACKED = 5000;

const local = new Map<string, { count: number; resetAt: number }>();

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0].trim();
  return fwd || req.headers.get('x-real-ip') || 'unknown';
}

function localLimited(key: string, rule: RateRule, now: number): boolean {
  const w = local.get(key);
  if (!w || w.resetAt <= now) {
    if (local.size >= MAX_TRACKED) {
      for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
      // Still full of live windows: drop the oldest (Map keeps insertion order).
      if (local.size >= MAX_TRACKED) local.delete(local.keys().next().value as string);
    }
    local.set(key, { count: 1, resetAt: now + rule.windowS * 1000 });
    return false;
  }
  w.count++;
  return w.count > rule.perIp;
}

function upstash(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

/** Both shared counters in one pipeline: INCR each, and set its expiry only when the key is new (NX). */
async function sharedLimited(ip: string, rule: RateRule, now: number): Promise<boolean> {
  const cfg = upstash();
  if (!cfg) return false;
  const window = Math.floor(now / 1000 / rule.windowS);
  const day = new Date(now).toISOString().slice(0, 10);
  const ipKey = `rl:${rule.name}:ip:${ip}:${window}`;
  const dayKey = `rl:${rule.name}:day:${day}`;
  try {
    const res = await fetch(`${cfg.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        ['INCR', ipKey],
        ['EXPIRE', ipKey, String(rule.windowS), 'NX'],
        ['INCR', dayKey],
        ['EXPIRE', dayKey, String(26 * 3600), 'NX'],
      ]),
      signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    const [ipCount, , dayCount] = (await res.json()) as { result?: unknown }[];
    return Number(ipCount?.result) > rule.perIp || Number(dayCount?.result) > rule.perDay;
  } catch (err) {
    console.error('Rate limit check failed (failing open):', err);
    return false;
  }
}

/** Whether this request is over a limit. Counts it either way. */
export async function rateLimited(req: Request, rule: RateRule): Promise<boolean> {
  const ip = clientIp(req);
  const now = Date.now();
  if (localLimited(`${rule.name}:${ip}`, rule, now)) return true;
  return sharedLimited(ip, rule, now);
}
