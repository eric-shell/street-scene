-- Street Scene's whole database: one row per signed-in player (npm run db:init applies it).
-- Lean on purpose for Neon's free tier: the player's synced save is one JSONB document (garage, garage
-- prefs, settings; a few KB), written at most every few seconds while they change something.
create table if not exists players (
  sub        text primary key,                -- Google account id (the ID token's `sub`), stable across email changes
  email      text not null,
  name       text not null default '',
  save       jsonb,                           -- src/account/cloudSave.ts SaveBlob; null until the first upload
  saved_at   timestamptz,                     -- when `save` last changed: the client's sync stamp
  created_at timestamptz not null default now(),
  seen_at    timestamptz not null default now() -- last sign-in or boot: who is playing during the UAT
);

-- Analytics (docs/analytics.md), ported from the eric-shell CRM: anonymous visitors, their visits, page loads
-- and the game's events, read by the admin dashboard (/dashboard, api/admin.ts). Written by api/analytics.ts.
-- Best effort and lean for the free tier: one round trip per page load, heartbeats that back off to 5 minutes,
-- a handful of events per race, and sessions / page views pruned after 6 months (api/admin.ts op=prune).

-- One row per browser (the id lives in localStorage, `nightrun.analytics.vid`). `country` / `city` / `region` /
-- `timezone` are IP-derived (Vercel edge headers) and APPROXIMATE; `location_override` is the hand-entered
-- correction and always wins on display. `player_sub` links the visitor to a signed-in player; the device columns
-- come from the renderer's probe (render/autoQuality.ts DeviceInfo), which is the same for one browser.
create table if not exists visitors (
  id                uuid primary key,
  player_sub        text references players(sub) on delete set null,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  user_agent        text,
  country           text,
  city              text,
  region            text,
  timezone          text,
  location_override text,
  client_timezone   text,
  language          text,
  referrer          text,
  gpu               text,
  dpr               real,
  cores             integer,
  memory_gb         real,
  touch             boolean,
  notes             text
);
create index if not exists visitors_player_idx on visitors (player_sub);

-- One row per visit (30 minutes without activity starts a new one). `engaged_ms` (tab visible) and `race_ms`
-- (a race or free roam running, unpaused) are cumulative for the whole visit and monotonic: the server keeps
-- greatest(existing, incoming), so a late heartbeat never walks them back. `build` is the game's build hash.
create table if not exists visitor_sessions (
  id           uuid primary key,
  visitor_id   uuid not null references visitors(id) on delete cascade,
  started_at   timestamptz not null default now(),
  last_beat_at timestamptz not null default now(),
  engaged_ms   integer not null default 0,
  race_ms      integer not null default 0,
  entry_path   text,
  referrer     text,
  viewport_w   integer,
  viewport_h   integer,
  screen_w     integer,
  screen_h     integer,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  build        text
);
create index if not exists visitor_sessions_visitor_started_idx on visitor_sessions (visitor_id, started_at desc);

-- One row per document load; `path` keeps the deep-link query (?race=, ?garage, ?seed=) that picked the screen.
create table if not exists page_views (
  id         bigserial primary key,
  visitor_id uuid not null references visitors(id) on delete cascade,
  session_id uuid references visitor_sessions(id) on delete cascade,
  path       text not null,
  referrer   text,
  created_at timestamptz not null default now()
);
create index if not exists page_views_visitor_idx on page_views (visitor_id, created_at desc);
create index if not exists page_views_session_idx on page_views (session_id);

-- The game's events: src/shared/analytics.ts is the vocabulary and each type's metadata. Widening the list
-- means editing both checks below: create table if not exists leaves a live table's check alone, so the
-- drop and re-add after it carries the new list to an existing database (npm run db:init).
create table if not exists visitor_events (
  id         bigserial primary key,
  visitor_id uuid not null references visitors(id) on delete cascade,
  session_id uuid references visitor_sessions(id) on delete set null,
  type       text not null check (type in ('race_start', 'race_finish', 'race_quit', 'garage_open', 'build_save', 'build_share', 'build_import', 'sign_in', 'sign_out', 'perf', 'race_share', 'error')),
  metadata   jsonb,
  created_at timestamptz not null default now()
);
alter table visitor_events drop constraint if exists visitor_events_type_check;
alter table visitor_events add constraint visitor_events_type_check
  check (type in ('race_start', 'race_finish', 'race_quit', 'garage_open', 'build_save', 'build_share', 'build_import', 'sign_in', 'sign_out', 'perf', 'race_share', 'error'));
create index if not exists visitor_events_visitor_created_idx on visitor_events (visitor_id, created_at desc);
create index if not exists visitor_events_type_created_idx on visitor_events (type, created_at desc);
