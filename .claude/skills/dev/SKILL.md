---
name: dev
description: Run the game in a browser - start the Vite dev server on port 5175, open a screen directly with URL params (race, garage, drone, seed, quality, dev mode), inspect it through the console handle, read the FPS meter against the frame-rate targets, stop the server. Use when asked to run, start, screenshot, profile or verify a change in the real app.
argument-hint: [?race=circuit|sprint|drift | ?garage | ?drone] [&seed=...]
---
# Run the app

1. Already up? `nc -z 127.0.0.1 5175 && echo up`. If so reuse it: Vite hot-reloads edits (changes under `src/sim` or `src/city` need a page reload to rebuild the world).
2. Start `npm run dev` with `run_in_background: true` and wait for its `Local:   http://localhost:5175/` line. The port is pinned (`strictPort`): if something else holds it, say so rather than changing the port.
3. Open `http://localhost:5175/` with params as needed:
   - `?race=circuit|sprint|drift` straight into a race (3 laps / point to point / 2 laps); `?garage`; `?drone` (these skip the boot splash; a plain load shows it for about 3 s before the menu)
   - `?seed=<anything>` for a fixed city (default is the UTC date); `?quality=low|medium|high|auto`; `?fps` (meter: fps, frame time, auto level and aim)
   - `?dev` garage dev mode (Ctrl+Shift+D, then drag a GLB onto the window to try a part); `?build=<share code>`
   - Test drive = the garage's Test drive button: open world, no rivals, physics tuning panel on ` / F2
4. In the page, `window.__nr` exposes the live objects: `{ world, gr, backdrop }` on the menu, `{ session, gr }` in a race (`session.race` is the `RaceState`, `session.race.cars[0].state` the player car), `{ garageScreen, gr }` in the garage. Use it from the console instead of adding debug code.
5. Use the browser tools when they are available (navigate, screenshot, read the console); otherwise ask the user to look and tell you what they see.
6. Audio only starts after a click or key press (browser autoplay rules); not a bug.
7. Performance: the `?fps` meter reads like `117 fps · 8.5 ms · Auto (High) 6/8 aim 120`. Targets (CLAUDE.md): aim 120 fps, hold 60, never below 30. A frame time pinned at the display's refresh (8.3 or 16.7 ms) means headroom; above 16.7 ms at Medium is a regression to fix, above 33 ms a bug. `?quality=high&fps` is the stress check, `?quality=auto&fps` the default path; `window.__nr.autoQ.stats` has the controller's median, p90 and slow fraction, and `.aim` the frame time it is aiming at. Compare before and after a change on the same seed and camera.
8. Stop the background server when you are done unless the user is using it.

Keys: W/S throttle and brake, A/D steer, Space handbrake, Shift nitrous, R reset, C camera, Esc pause, ` tuning panel, F3 camera panel. README.md has the full table.
