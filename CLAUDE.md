# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Street Scene is a browser street racer (TypeScript, three.js, Vite, Vitest; no framework, no linter or formatter): night races through a seeded procedural city with a deterministic arcade sim, AI rivals, a garage, replays and ghosts. README.md holds the player-facing docs (controls, credits, the decisions log); read it only when a task touches those.

## Commands

| Task | Command |
|---|---|
| Dev server, pinned to port 5175 (`strictPort`) | `npm run dev` |
| Typecheck, about 1 s (`noUnusedLocals`/`Parameters` are errors) | `npm run typecheck` |
| Tests, about 35 s (Vitest, node env, 120 s per test) | `npm test` |
| One file, one test | `npx vitest run tests/sim.test.ts -t "nitrous"` |
| Browser tests, about 1 min (Playwright, Chromium; starts the dev server if needed) | `npm run e2e` (`-- e2e/splash.spec.ts -g "music"` narrows) |
| Production build (typecheck + vite build) | `npm run build` |
| Validate the parts catalog against `public/` | `npm run validate` |
| Inspect a GLB (nodes, materials, triangles) | `npm run inspect -- public/cars/protoCompact.glb` |
| Audit a shipped car against its reference spec (proportions, pillars, mirrors, handles, lamps) | `npm run audit -- protoHatch` |
| Rebuild car assets from the authored .blend cars and FBX imports (needs Blender, rewrites generated files) | `npm run assets` |
| Import music / rebuild the music catalog (needs ffmpeg) | `npm run music` |
| Rebuild the traffic vehicles from the Comrade1280 packs (needs Blender, rewrites generated files) | `npm run traffic` |

Project skills wrap these: `/check [file] [-t name]` runs typecheck + tests and prints only failures; `/map [dir]` prints a one-line-per-module map of the source; `/dev` runs the game in a browser; `/district`, `/tune`, `/assets`, `/car` (a car or kit from reference vehicles) and `/blender` are step-by-step guides for those jobs. `.claude/rules/` adds path-scoped guidance when you edit sim, render, test or data files.

## Architecture

Data flows one way: seed → city → world → sim → session → render.

- `src/city/` (pure): `roadGraph` → `districts/` (special areas plan and build) → `blocks` (sidewalks, buildings, walls, street furniture) → `terrain` → `route` (circuit/sprint/drift, barriers, corner rails). `world.ts` assembles the `World` the sim queries (`heightAt`, `surfaceAt`, `collideCircle`, route progress); it is built once per race and never mutated. `config.ts` holds every generation constant (`CITY`, `ROUTE`). `events.ts` names each seed's event flavour and supplies the route preference; planners after the route pick read the routes from `PlanContext.event`. `railTimetable`/`railCurve` live here so the level crossing's gates and the trains agree; `drawbridge.ts` and `levelCrossings.ts` build the timed gates.
- `src/sim/` (pure): `race.ts` owns `RaceState` (`createRace`, `stepRace` once per 60 Hz tick); `car.ts` physics (two substeps), `collision.ts`, `ai.ts` (AI lives inside the sim), `rails.ts` (heavy dentable rail pieces), `props.ts` (destructibles), `build.ts` (performance tiers → tuning via `applyBuild`), `tuning.ts` (types, merges and validates `drivingParams.json`), `stats.ts` (0-100 and top speed measured by driving the sim). `gates.ts` (timed gates: pure schedules of the tick, collision, AI waiting) with `hazards.ts` (tows cars off a lifting span or the tracks), `traffic.ts` (ambient civilian cars; `RaceConfig.traffic`, off when missing), `driftZones.ts` (zone multiplier and nitrous refill). One `InputFrame` per tick, quantized and packed to 4 bytes (`input.ts`); the packed log is the replay.
- `src/game/session.ts` (`RaceSession`) is the bridge: `tick()` steps the sim with live input or a recorded log; `render(alpha, dt)` interpolates the previous and current snapshots and drives the three.js scene, camera, HUD, engine audio and SFX. `main.ts` is boot plus the state machine (menu, race, garage, drone, freefly; a race session is a race, a test drive or free roam) around `FixedStepLoop` (`loop.ts`). `streetStage.ts` is the menu city: the event world and night scene with the player's car cruising the route (render only; it waits at timed gates on its own clock), shot by `streetCameras.ts` (`ShowreelCamera` behind the menu, `FollowOrbit` for the garage's Street view); the drone and free camera fly over it.
- `src/render/`: three.js only, reads state. `scene.ts` (`GameRenderer`, `createNightScene`) composes `cityMeshes`, `districts/`, `props`, `roadblocks`, `routeArrows`, `crowds`, `lightFx` (street light pools), `areaLights` (park and plaza light), `post`; `meetPlan` places the street meets (crowd, then parked cars) behind every cyan barrier that `crowds` and `roadblocks` draw. Buildings: `architecture` (neighbourhood and style plan) → `buildings` (merged meshes) with `facadeAtlas` / `facadeMaterial`; the elevated railway is `districts/subway` plus `railCurve`, `railTimetable` and `trains`; `sparks` draws car sparks from sim telemetry; `traffic` draws the civilian cars from `public/traffic/` in one BatchedMesh. `carView.ts` + `carAssets.ts` build cars and parts from the manifest and catalog; `autoQuality.ts` adapts quality to frame time.
- `src/garage/` garage scene (`showroom.ts` is the studio room; the Street view borrows the street stage), UI and `storage.ts` (slots, share codes); `src/replay/` replays, ghosts, bests; `src/audio/` music player, SFX and the engine voices (`engineSynth.ts` is the pure pulse-train synth and its programs from an `EngineSpec`, `engineWorklet.ts` runs it on the audio thread, `engineAudio.ts` wraps it with the silencer convolution, intake, turbo and levels; `docs/engineSound.md` has the model and the plan per layout); `src/ui/` HUD, `minimap` (shared by the HUD and the drone), `rail.ts` (the layout every menu screen shares: rail, screen header, key legend, `railInset` for `GameRenderer.setFraming`), menu, screens, splash, panels, Lucide icons; `src/input/` keyboard, gamepad and touch → `InputFrame`.
- Districts are paired modules: `src/city/districts/<kind>.ts` (a `DistrictModule` with `plan`/`build`, registered in a fixed order in `index.ts`) and `src/render/districts/<kind>.ts` (a `DistrictRenderer` appending into a shared kit of merged builders). Every sim wall carries a `look`, and every look has a renderer, so collision always matches what is drawn.
- Data: `src/sim/drivingParams.json` (every physics number; `base` + `cars.<id>` overrides merged key by key, arrays replace whole, `_` keys are comments, unknown keys throw at startup); `src/assets/carManifest.json` (car geometry, `selectable`, the `engine` spec); `src/assets/partsCatalog.json` (entries with `"generated": true` are rewritten by `npm run assets`); `src/assets/musicCatalog.json` (fully generated by `npm run music`); `src/assets/trafficModels.json` (fully generated by `npm run traffic`: each traffic kind's footprint, lamps and the CC BY credits; `traffic.kinds` in `drivingParams.json` must match its footprints). `src/shared/parts.ts` is the slot and material vocabulary shared by renderer, garage and asset scripts; `src/shared/carSpec.ts` is the engine layout / drivetrain code vocabulary (garage badges, engine voice, validation). `scripts/blender/carSpecs.json` is each car's reference spec (two real donors with sourced dimensions, the house stylization, lamp signatures); `docs/carDesign.md` is the design language the audit and the Blender feature builders enforce.

## Invariants (the tests enforce most of these)

1. `src/sim/` and `src/city/` are pure and deterministic: no DOM, `window`, three.js, `Math.random`, `Date`, `performance.now` or frame time. Randomness only through the seeded `Rng` (`sim/prng.ts`; `deriveSeed` for sub-streams), trig through `sim/math.ts`. Same seed + build + input frames ⇒ identical state, bit for bit.
2. Rendering only reads state. Nothing under `render/`, `game/`, `garage/`, `ui/` or `audio/` writes into `RaceState` or `World`.
3. `CarBuild = { visual, performance }`: only the renderer reads `visual`; the sim reads `performance` through `applyBuild`. Visual choices never change tuning.
4. All physics numbers live in `drivingParams.json`; no tuning magic numbers in sim code.
5. Every sim wall is drawn by something, and nothing drawn stops a car without a wall.
6. Because of 1, any behaviour change in `sim/` or `city/` changes every existing replay, ghost and best time for that seed. Say so when it happens.

## Frame-rate targets

Aim for 120 fps, hold 60 fps on every supported device, never drop below 30 fps. In frame time: 8.3 ms is the goal, 16.7 ms is what everything per frame has to fit at Medium on a mid device, 33 ms is the failure line. `FRAME_BUDGET` in `src/render/autoQuality.ts` is the one place these numbers live; the auto quality controller, the FPS meter and these docs read them from there.

- The sim ticks at 60 Hz whatever the frame rate: at 120 fps every other frame is pure interpolation (`alpha`), at 30 fps two ticks run per frame, so a tick's cost counts double at the floor. Anything per frame in `render/`, `game/`, `ui/` or `audio/` scales with `dt` (exponential smoothing, never a per-frame lerp factor) so 30, 60 and 120 fps look the same.
- Auto graphics (`AutoQualityController`) buys quality only with headroom at the aim (120 fps capped at the display's refresh rate, which it learns from the fastest frames it has seen), steps down one level after a few seconds below 60, drops two levels on the first evaluation at 30, and holds anywhere in between. A probe that leaves the aim or slips below 60 is reverted and backed off.
- New visual work fits the ladder: give it a knob in `QUALITY_LEVELS` / `QUALITY` or a tier gate rather than a fixed cost, and keep allocations and per-object draw calls off the per-frame path. A feature that cannot hold 60 at Medium belongs in High or needs a cheaper form.
- Measure before and after with `?fps` (fps, frame time in ms, auto level and its aim; `/dev`); the controller's stats are on `window.__nr.autoQ`. When a change adds per-frame or per-tick work, say what it costs.

## Conventions

- Strict TS, ES2022 modules, JSON imports, `import type` for type-only imports. Single quotes, semicolons, trailing commas, long lines are fine; match the surrounding file. Unused imports or locals fail the typecheck.
- Every module starts with a `/** ... */` comment saying what it does and why; interface fields get one-line JSDoc with units (m, s, ticks, rad, kg). Comments explain reasoning and trade-offs, not what the code already says. Keep that density.
- Constants are `as const` tables (`CITY`, `ROUTE`, `RAIL`, `CAMERA`, `QUALITY`) next to the code that uses them.
- Tests use `tests/helpers.ts` (`flatWorld`, `raceConfig`, `runAutopilot`, `replayLog`, `carSnapshot`, `input`) and prove determinism by running twice and comparing `JSON.stringify` snapshots, often over many seeds.
- Commits: short imperative subject, then a body grouped by area (Garage / City / Physics ...) with `-` bullets. Commit only when asked.

## Working efficiently

- Orient with `/map` or `grep -rn "export .* <name>" src` instead of reading files to find things. Largest files: `ui/ui.css` 3.2k lines, `audio/sfx.ts` 1.6k, `render/finishLine.ts` 1.2k, `city/route.ts` 1.2k, `garage/garageUi.ts` 1k, `city/blocks.ts` 930; read those in ranges.
- Never read `public/` media, `assets/source/` FBX or `package-lock.json` (denied in settings). For a GLB use `npm run inspect -- <file>`; `assets/inspect.md` is the last asset report; `npm ls <pkg>` gives versions.
- Verify with `/check`: typecheck after every edit, the full suite after touching `src/sim/` or `src/city/` (replay determinism, many-seed AI and rail sweeps). `npm run e2e` (Playwright, `e2e/`) covers what needs a real page: boot splash, menu, music; run it after touching `main.ts`, `ui/` or `audio/`, and give it a 180000 ms timeout. Headless beats the browser: `npx tsx` imports any `src/sim` or `src/city` module directly (`/tune` measures a car that way, `scripts/debugCitySvg.ts <seed> out.svg` draws a city).
- `node_modules` must exist (`npm ci`). `npm run assets`, `npm run music` and `npm run traffic` rewrite generated files and need external tools; run them only when the task is about assets, music or traffic.
- The Blender MCP server in `.mcp.json` needs `uv` installed (`brew install uv`); it is only for modelling work and its connection failure is otherwise harmless. Read `/blender` before driving it.
