# Analytics (visitors, visits, game events, an admin dashboard)

An anonymous record of who plays and how, for the UAT: visitors and their devices, visits and how long they were engaged or driving, page loads, and the game's own events (races started, finished and quit, garage saves, sign-ins, frame rate per device). It answers "is anyone playing, on what, and does it run well". Ported from the eric-shell CRM; this file is the server half.

## Pieces

- `api/analytics.ts`: the beacon, `POST` only. Always answers 204.
- `api/admin.ts`: every admin op behind one URL, routed by `?op=`. Auth is the player session plus `ADMIN_EMAILS`.
- `api/_lib/visitor.ts` (ids, edge geo, the visitor upsert), `api/_lib/admin.ts` (the admin check), `api/_lib/adminTypes.ts` (every admin response shape, shared with `src/admin/`).
- `src/shared/analytics.ts`: the wire format and every event type with its metadata (`AnalyticsBeacon`, `EventMetaMap`, `isEventType`, `MAX_BEACON_BYTES`).
- `db/schema.sql`: `visitors`, `visitor_sessions`, `page_views`, `visitor_events`. `npm run db:init` applies it.
- `vercel.json`: the daily retention cron and the `/dashboard` rewrite.

## The beacon

One POST to `/api/analytics` with a JSON body (`navigator.sendBeacon` sends a Blob typed `application/json`; `text/plain` is accepted too). At most `MAX_BEACON_BYTES` (4 KB) is read; larger bodies are dropped. Ids ride in the body because `sendBeacon` cannot set headers.

- `pageview`: one `db.transaction` (a single Neon round trip) that upserts the visitor, upserts the session and inserts the page view. It is a real `fetch`, so it carries the edge's geo headers and the session cookie.
- `heartbeat`: raises the session's `engaged_ms` and `race_ms` with `greatest()` and stamps `last_beat_at`. It never touches `visitors`, and only updates: a beat for a session no page view created is dropped.
- `event`: one `visitor_events` row, the metadata stored as JSONB. The visitor is upserted in the same transaction, so an event that beats its page view still lands.

Whatever happens (bad JSON, bad ids, an unknown event type, a database error) the answer is 204 with an empty body: telemetry must never show up in the game. Errors are logged.

## Identity and ownership

- The visitor id is a UUID the browser keeps in localStorage. It is pseudonymous: any client can send any UUID, so nothing is authorized from it.
- The session owns the identity. Every write resolves the visitor as `coalesce((select visitor_id from visitor_sessions where id = $sess), $vid)`, and `visitor_sessions` never reassigns `visitor_id` on conflict, so a visitor id that changes mid-visit (storage cleared, two tabs minting at once) cannot split one person across two rows. The transaction applies the same resolution to the session, page view and event statements.
- `upsertVisitor` keeps the first non-null sighting of geo, user agent and referrer (coalesce-backfill), while browser-reported fields (time zone, language, device) take the freshest value.
- A signed-in player is linked from the session cookie: `sessionSub(req)` reads the Google id with no database query, and every visitor upsert sets `visitors.player_sub` to it (the latest signed-in player on a browser wins; a shared browser is one visitor). The id goes through a `select` on `players`, so a cookie for a deleted account cannot fail the foreign key. A `sign_in` event goes through the same upsert.
- Validation before any write: ids must match the UUID pattern, integers are clamped, strings truncated, campaign tags lowercased and hyphenated (they are GROUP BY keys), the event type must pass `isEventType`, and metadata is kept only as a plain object of at most 2 KB (dropped, not truncated, otherwise).

## What is collected

Per browser: a random id, user agent, approximate IP geo from Vercel's edge headers (country, city, region, time zone; the IP itself is never stored), the browser's time zone and language, an external referrer, and the renderer's device probe (GPU string, pixel ratio, cores, memory, touch). Per visit: entry path, viewport and screen size, campaign tags (`utm_*`), the build hash, engaged and driving time. Per page load: the path with its deep-link query. Per event: its type and metadata. Nothing is collected from a browser that sends Global Privacy Control or Do Not Track: that is honored client-side, so no beacon is sent at all. Deleting a visitor in the dashboard removes all of it (the rows cascade).

## Game events

The vocabulary and each event's metadata are `src/shared/analytics.ts`; the client is `src/analytics/`: `telemetry.ts` (ids, the visit, the page view, heartbeats, `track`), `drive.ts` (one race, replay or free roam from start to end) and `perf.ts` (the frame histogram).

- **Ids.** The visitor is a UUID in `nightrun.analytics.vid`; the visit is a record in `nightrun.analytics.sess` (id, last activity, cumulative engaged and driving ms), shared across tabs and rolled over after 30 idle minutes.
- **Page view** once per document as a `fetch` (only a fetch carries the edge's geo headers and the session cookie that links the player), with the device facts from `readDeviceInfo` (no second WebGL probe) and `__BUILD_HASH__`. **Heartbeats** by `sendBeacon` at 15 s, 30 s, 60 s, 120 s, then every 5 minutes; none while hidden or when nothing changed; a flush on hide and on `pagehide`. Engaged time counts while the tab is visible, driving time while a race or free roam is running (not paused, finished or in the photo drone).
- **Events** go by `fetch` with `keepalive`, or by beacon on `pagehide`:
  - `race_start`: every session start in `runSession` (races, free roam as `'roam'`, replays with `replay: true`, retries and restarts).
  - `race_finish`: the player's finish in `onFinish`, live drives only; `personalBest` is `submitBest`'s answer (so false on a tuned run), `score` in drift.
  - `race_quit`: a live drive that ends unfinished after more than 1 s, with the reason (`quit` from the menu or garage, `restart`, `pagehide`), driving time and route progress.
  - `perf`: driving frames only, at every session end and on `pagehide` (none under 120 frames): median fps, p95 frame ms, the share over 33.3 ms, and the auto quality level, tier and aim.
  - `garage_open` (`viaDoor` false for deep links), `build_save` (the garage's Save), `build_share` (once per Share dialog), `build_import` (the Load code path and the `?build=` link), `sign_in` (with `newAccount`), `sign_out`.
- **Off switches**: GPC or Do Not Track, `navigator.webdriver` (the e2e runs against a dev server whose `.env.local` is the live database), the `/dashboard` path, and `?noanalytics`, which sets `nightrun.analytics.off` on that device for good (`?noanalytics=0` clears it): open the game once with it on every device of your own.
- **Cost**: per rendered frame while driving, two adds and one histogram increment into a preallocated `Uint32Array`; no allocation, nothing in the sim. Nothing is ever shown to the player, a failed beacon is dropped, and analytics only reads `RaceState`.

## Admin

`/api/admin?op=...`, one function. A request is an admin when its session cookie names a player whose email is in `ADMIN_EMAILS` (comma separated, case-insensitive). Unset or empty lets nobody in. 401 when signed out, 403 when signed in but not an admin. Methods and ids are checked explicitly (400 for a bad `id`, 405 for a wrong method, 404 for a missing visitor), the cookie is SameSite=Lax and writes need a JSON body.

| Request | Answers |
|---|---|
| `GET op=session` | `AdminSessionPayload`: the signed-in admin. The dashboard's gate. |
| `GET op=visitors` | `VisitorListPayload`: up to 500 visitors, most recent activity first, with page views, sessions, active days (distinct UTC days across sessions, page views and events), summed engaged and driving time, race and save counts, median fps, last tier, the linked player and a `synthetic` flag (a session tagged `synthetic-test`). |
| `GET op=visitor&id=` | `VisitorDetailPayload`: the visitor, their player, sessions (100), page views (500) and events (500, newest first). |
| `PATCH op=visitor&id=` | `{ notes?, location_override? }`: only the keys present are written. |
| `DELETE op=visitor&id=` | Deletes the visitor and, by cascade, everything they have. |
| `GET op=insights&days=7\|30\|90` | `InsightsPayload` (default 30): sessions and viewport mix, median engaged and driving time, the play funnel (each step is intersected with the one before, so it never widens), modes, cars, seeds raced more than once, frame rate by tier and by GPU family (raw GPU strings folded to a short name such as "Apple M2 Pro" or "GeForce RTX 3060"), sources, sessions by UTC hour, new visitors per day. One Neon round trip. |
| `GET op=prune` | The retention pass (below). Not an admin op. |

## Retention

`page_views` grows one row per page load and the list aggregates it on every poll, so rows older than 6 months are deleted daily, together with `visitor_sessions` not heard from in 6 months. Visitors and events stay (a few rows per race). The pass is `GET /api/admin` with `Authorization: Bearer $CRON_SECRET`: Vercel Cron calls the bare path (`vercel.json` has no query string), so a GET with no `op` and an Authorization header is the prune; `?op=prune` does the same. It compares the secret in constant time, answers 503 when `CRON_SECRET` is unset (it refuses to run rather than being an open door), 401 for a wrong secret, and never accepts the admin cookie.

## Dashboard

`/dashboard` → `dashboard.html` → `src/admin/main.tsx`: its own Vite page, so React and visx never reach the game (the dev and preview servers route `/dashboard` through the `dashboardRoute` plugin in `vite.config.ts`, production through the rewrite in `vercel.json`). React and visx belong to `src/admin/` alone; the game stays framework-free, and the dashboard is styled with SCSS partials on the game's own tokens and kit (`dashboard.scss`, no Tailwind).

- **Sign-in.** The guard probes `GET op=session`: 200 shows the dashboard, 401 Google's button, 403 "Not an admin" with a sign out (`DELETE /api/account`). Sign-in posts the credential to `POST /api/account` through `lib/googleSignIn.ts` (not `account/account.ts`, which has game boot side effects), so an admin must be in both `ALLOWED_EMAILS` and `ADMIN_EMAILS`.
- **Polling.** `op=visitors` and `op=insights&days=` (7, 30 or 90, remembered) every 120 s, only while the tab is visible.
- **Scope.** The totals and the table follow the timeframe and the two filters (Hide automated, Drivers only); search narrows the table only; the insights are server aggregates the filters cannot reach, and each block says which it is.
- **Traffic tags** are derived in the browser by `lib/classify.ts`, never stored: the machine rungs first (Test, LLM, Bot, Proxy, Spoofed, Headless, No dwell, each with its reason), then what the visitor did (Finished, Raced, Garage, Signed in, Untracked, Lingered, Bounce, Skimmed), plus the Returning, VPN? and Burst qualifiers. `automated` is the filter's contract. The proxy and burst rules run over the full list, before the timeframe narrows it.
- **Caches.** Detail payloads are held in memory per page view (`lib/detailCache.ts`), stamped from `last_activity_at` plus the counts; an open drawer never refetches, so a poll cannot wipe unsaved notes. The new-since-last-visit watermark is `nightrun.dashboard.lastVisit`, frozen per session; preferences live under `nightrun.dashboard.*`, which the account sync never carries.
- **One place each.** Chart colors come from `lib/chartTheme.ts` (the game palette, with its validation notes: race-type colors are told apart by icon and name as well, quits are hatched, frame-rate status is a word and icon); the column set, widths and skeleton shapes from `lib/visitorColumns.ts`. `lib/gameVocab.ts` restates the race types' labels, icons and colors and the 120 / 60 / 30 fps lines, because importing `menu.ts` or `render/autoQuality.ts` drags the game into the dashboard's bundle: keep them in step by hand.
- **Harness.** `npm run check:dashboard -- <baseUrl> <outDir>` stubs every `/api/admin` call from `scripts/dashboardFixtures.ts` (64 seeded visitors, writes nothing), holds answers 1.5 s so the skeleton is measured, and checks overflow, the gutter and the pager's scroll at 1440, 1024, 768, 412 and 360 (`WIDTHS=412,360` narrows it). It fails if the dashboard ever calls `/api/analytics`.

## Budget

Three Vercel functions of Hobby's 12 (`account`, `analytics`, `admin`). One open tab costs a page view (one transaction), a heartbeat that backs off to every 5 minutes (one `update`, no round trip beyond that) and a few events per race, each a single Neon request; Neon's compute scales to zero between visits. A tester session is a handful of requests, far inside the free tiers; the list aggregate is the heaviest query and runs only when an admin has the dashboard open.

## Setup

1. Pull the new tables in: `npm run db:init` (it is idempotent; the event type check constraint is only created with the table, so widening the list later means dropping and re-adding it).
2. Env vars (Vercel and `.env.local`, see `.env.example`): `ADMIN_EMAILS` (the admins, who must also be in `ALLOWED_EMAILS` to sign in) and `CRON_SECRET` (`openssl rand -base64 32`). Vercel Cron sends the secret automatically once the variable exists.
3. Deploy. `vercel.json` registers the 04:00 UTC cron and rewrites `/dashboard` to `dashboard.html`. Sign in to the game with an admin email, then open `/dashboard`.

## Rate limits

`api/_lib/rateLimit.ts`, checked before the body is read; a limited beacon gets the same 204 and is dropped. Two layers:

- **Per warm instance, always on**: 120 beacons per client IP per 10 minutes, counted in memory (at most 5 000 addresses tracked, oldest dropped first). A hard-playing tab sends under 100 an hour, so this leaves room for a few players behind one address. It needs nothing configured, but cannot see across instances.
- **Shared, with Upstash**: the same per-IP window plus a global ceiling of 20 000 beacons per UTC day, counted in Upstash Redis over its REST pipeline (one round trip, no SDK). The daily ceiling is what bounds a distributed flood: under 10 MB a day against Neon's free 0.5 GB. Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or the `KV_REST_API_*` names the Vercel marketplace integration injects); unset, only the first layer runs.
- **Fails open**: an Upstash error, a non-200 or a call slower than 800 ms lets the beacon through, since failing closed would drop every player's analytics during an outage. The IP is Vercel's `x-forwarded-for` first hop, kept only as a counter key that expires with its window.

Beyond the limits: the body cap (4 KB), UUID, type and clamp validation, and the 2 KB metadata cap.

## Known gaps

- A caller who guesses another session's UUID can attach rows to that visitor, which is the same exposure the visitor id already has; nothing is authorized off either.
- Without Upstash (the project is kept free for now), the rate limit is per warm instance only: a flood from many addresses is bounded by nothing but Vercel's own DDoS protection. The worst case on the free plans is an outage (Neon's 0.5 GB full, Hobby's allowance spent), not a bill; Vercel's Attack Challenge Mode (free) stops one, and connecting a Redis database later turns on the shared layer with no code change (eric-shell's Upstash database on the same team could be connected to this project too, its keys do not collide).
- Events are never pruned.
- Geo is IP-derived and approximate; `location_override` is the hand-entered correction and wins on display.
