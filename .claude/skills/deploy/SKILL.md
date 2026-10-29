---
name: deploy
description: Ship the game to production on Vercel - push main to the release branch, the dashboard links (production branch, deployments, usage), and why pushes to main do not build. Use when asked to deploy, ship, release or redeploy, or about Vercel builds and usage.
---
Production is https://street-scene.vercel.app (Vercel project `street-scene`, team `erics-projects-9132b104`, Hobby plan). It deploys from the `release` branch, not `main`.

## Ship

Only when the user asks; finishing a task pushes `main`, never `release`.

    git fetch origin && git push origin origin/main:release

That runs one production build of whatever `origin/main` holds. If `release` has commits `main` lacks, the push is refused: stop and tell the user, never force it.

## Why main does not build

Every push used to build production: about 640 builds in 30 days took Hobby usage to 75% (Oct 29 2026). Now:

- `vercel.json` sets `"git": { "deploymentEnabled": { "main": false } }`, so pushes to `main` build nothing, not even a preview.
- The dashboard's Production Branch is `release`. Any other branch pushed to GitHub still builds a preview, so keep side branches local or in worktrees.
- Each deploy resets the edge cache for `/cars`, `/parts`, `/music` and the rest of `public/` (`max-age=3600`), so batching deploys also saves transfer.

## Links

- Production branch (Settings → Environments → Production → Branch Tracking): https://vercel.com/erics-projects-9132b104/street-scene/settings/environments/production
- Deployments: https://vercel.com/erics-projects-9132b104/street-scene/deployments
- Usage (build minutes, transfer, function invocations): https://vercel.com/erics-projects-9132b104/~/usage
- Environment variables (accounts and analytics, see `docs/accounts.md` and `docs/analytics.md`): https://vercel.com/erics-projects-9132b104/street-scene/settings/environment-variables

A `VITE_*` variable is read at build time, so after changing one, ship again (or Redeploy the latest production deployment in the dashboard).
