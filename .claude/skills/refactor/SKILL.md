---
name: refactor
description: Refactor safely and prove it - move files with their imports rewritten, find dead exports and classes no stylesheet has, then show nothing changed that should not have - bit-identical sim and city (golden hashes vs a git ref), the compiled CSS cascade (canonical diff through a rename map), the live three.js scene (geometry, transforms, materials, canvas textures) and the DOM's computed styles over 165 UI states. Use for any restructure, rename, DRY pass, dead code sweep or look-preserving change, and before committing one.
---
# Refactor and prove it

Everything here runs from the repo root. Scripts sit beside this file; `$K` below is `.claude/skills/refactor`.

## Find and move

- `node $K/move-files.mjs . moves.json [--dry]` moves files with `git mv` (`{"src/ui/dom.ts": "src/ui/kit/dom.ts", ...}`) and rewrites every relative import and SCSS `@use` that pointed at a moved file or was written from one. Dry run first; typecheck after.
- `node $K/unused-exports.mjs > out.txt` lists src exports nothing imports (TypeScript 7 is the native compiler, with no JS API, so this parses imports itself). Lines ending UNUSED are used nowhere; the rest only inside their own module (candidates to unexport).
- `node $K/orphan-classes.mjs . compiled.css` lists classes the TS emits or queries that the compiled CSS never mentions: leftovers of a rename, typos or pure hooks. Button labels show up as noise (the helpers' last string argument).

## Prove nothing changed

Take the baseline from the commit before the change: `git worktree add <scratch>/base HEAD` (detached), then `cd <scratch>/base && ln -s <repo>/node_modules node_modules` (and `npm install` there if a dependency is missing).

1. **Sim and city, bit for bit.** `npx tsx $K/golden.ts <tree> [seeds] > out.txt` on the base worktree and on the working tree, then `diff`. It hashes 14 generated cities and a 45 s race for every mode with traffic. A changed `city` or `world` hash is a city change, a changed `race` hash with the same city is a sim change; either changes every replay, ghost and best for that seed (CLAUDE.md invariant 6). About a minute.
2. **The cascade.** Compile both stylesheets (`node_modules/.bin/sass --no-source-map src/ui/styles/main.scss out.css`) and `node $K/css-diff.mjs before.css after.css [map.json]`. It compares every (media context, selector, property) -> value after renaming side A through the map, and checks which rule wins wherever two can hit the same element (importance, specificity, order), so a BEM modifier losing to a base `:hover` shows. Map format and examples are in its header; `css-disjoint.json` lists selector pairs proven never to meet one element (extend it, with a reason in your head, when a reported pair cannot coincide). For motion changes run both through `node $K/css-motion.mjs in.css out.css motion|reduce [--fold]` first and compare each environment.
3. **The 3D scene.** Build and serve each tree (`npx vite build --outDir <dir>`, `npx vite preview --outDir <dir> --port <p> --strictPort`, never 5175), then `node $K/scene-hash.mjs http://localhost:<p> out.txt [menu race sprint roam garage]` several times per build. `node $K/scene-diff.mjs base1.txt after.txt base2.txt base3.txt` compares, ignoring what differs between the base runs (animated parts: trains, crowds, traffic, blinking lamps). It hashes every geometry buffer, transform, material parameter and canvas texture's pixels; an opaque or additive mesh's index is hashed as a triangle set (its order cannot show), and the city layers `render/cityChunks.ts` sorts by cell leave out their per-camera `groups`.
4. **The UI.** `node $K/dom-capture.mjs http://localhost:<p>/ <outDir> [renameMap.json] [--reduced-motion]` captures 165 states (menu steps, settings, garage tabs, races, pause, results, full map, drone, debug panels; desktop and phone) as computed styles per element; `node $K/dom-diff.mjs <base> <after> <noiseRun> --box-tol=0.05` diffs them. Capture the base twice for its noise run. Its flows drive the UI by class (current names); after a class rename pass a map for the new build. About two minutes a capture.

## What bit us

- BEM modifiers are weaker than the compounds they replace (`.btn--primary` 0,1,0 vs `.btn.primary` 0,2,0): give modifiers their own state rules. The cascade check catches what slips.
- `Math.max(0, Math.min(1, x))` and a ternary clamp differ on `-0` and NaN; in sim and city that can change a replay. Outside them it is harmless.
- A tag selector that the refactor turns into a class can have matched more than you think (`.splash-neon span` also hit the word wrappers): the DOM capture shows it.
- Sass interpolates `#{...}` inside `/* */` comments, and a `/* */` comment inside a mixin is emitted into every rule that includes it (use `//` there).
- `vite preview` started outside the repo binds `localhost` on IPv6 only: test it with `curl http://localhost:<p>/`, not `nc 127.0.0.1`.
- Several forks or sessions in one tree: give each a disjoint set of files, create the shared helpers before they start, and keep the shared modules owned by one of them (`.claude/rules` hot spots; ListAgents first).
