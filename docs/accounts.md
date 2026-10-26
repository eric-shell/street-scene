# Accounts (Google sign-in, Neon, Vercel)

Signed-in testers get their garage, garage prefs and settings (minus this device's graphics: `quality`, `autoQuality`, `showFps`) on every device. Signed out, or on a build without `VITE_GOOGLE_CLIENT_ID`, the game runs on local storage as before. Replays, ghosts, bests, music and the debug panels' tuning stay local.

## Pieces

- `api/account.ts`: the only Vercel function. `GET` who am I + save, `POST` sign in (Google ID token), `PUT` save, `DELETE` sign out. Helpers in `api/_lib/` (`db` Neon HTTP driver, `google` token check + allowlist, `session` HMAC cookie).
- `db/schema.sql`: one table, `players` (Google `sub`, email, name, the save as JSONB, stamps). `npm run db:init` applies it.
- `src/account/account.ts`: session state, the sync rule, Google's button. `cloudSave.ts`: which store keys sync and how a download merges. `main.ts` awaits `accountReady` before reading saved state (only signed-in players wait, 3 s at most).
- `src/ui/screens/accountPage.ts`: the Settings → Account tab, the panel's first, shown only when the build has a client id. Signed out, Google's button runs across its top (as wide as Google allows, 400 px). It holds the plate name (`Settings.username`, at most 8 plate characters, for the license plates), which syncs with the settings.
- `src/ui/screens/signIn.ts`: the sign-in prompts every screen shares, signed out only: a Sign in row in the menu's style, the pitch with Google's button (the Account page's body) and a dialog of it. Where they appear:
  - the menu's home: an account row above the event card, into Settings on the Account tab. Signed in it greets the player (picture, "Welcome Eric!" on the visit that created the account and "Welcome back Eric" after, the cloud save's state and email); signed out it is Sign in, and once an account has signed in on the device it reads "Continue as" their first name over their email, their Google picture in the badge (`account.v1`'s `last`, kept after signing out; the picture comes from the sign-in token, the server stores none);
  - the results screen: Sign in first under "What next", opening the dialog;
  - the garage's Builds step: "saved on this device only" under the slots, with Sign in opening the dialog once unsaved changes are saved or dropped (signing in can reload the page).
- A device's first sign-in keeps its garage: when the account already has a save, the device's builds it lacks join the account's garage (up to the six slots) and upload, instead of being written over (`cloudSave.ts` `joinLocalBuilds`).
- `scripts/apiDev.ts`: serves `api/` from `npm run dev`, with `.env.local` in `process.env`.

## Free tier budget

One row per player and a save of a few KB; uploads are debounced (3 s after the last change) and a boot is one query. Five testers are far inside Neon's free storage and compute (it scales to zero between sessions; the first request after idle pays a cold start of about a second, covered by the boot wait) and use one of Vercel Hobby's 12 functions.

## Setup

1. **Neon**: in the Vercel project, Storage → add Neon (free), or reuse a Neon project with a new database. That sets `DATABASE_URL`. Copy it into `.env.local` and run `npm run db:init`.
2. **Google**: Google Cloud console → APIs & Services → OAuth consent screen (External, Testing, add the testers as test users) → Credentials → Create OAuth client ID → Web application. Authorized JavaScript origins: `https://<your-app>.vercel.app`, `http://localhost:5175` and `http://localhost`. No redirect URIs; no client secret is used.
3. **Env vars** (Vercel → Settings → Environment Variables, and `.env.local`; see `.env.example`): `VITE_GOOGLE_CLIENT_ID`, `DATABASE_URL`, `SESSION_SECRET` (`openssl rand -base64 48`), `ALLOWED_EMAILS` (comma separated). `VITE_GOOGLE_CLIENT_ID` is read at build time, so redeploy after changing it.
4. Deploy. Vercel detects Vite (`npm run build`, `dist/`) and the `api/` function on its own.

Preview deployments get their own URLs, which Google's origin list does not match; test sign-in on the production URL (or add a fixed preview alias as an origin).

## Looking at the data

Neon console → SQL editor: `select email, seen_at, saved_at, pg_column_size(save) from players order by seen_at desc;`. Delete a row to reset a tester (their next request signs them out).
