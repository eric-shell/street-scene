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
