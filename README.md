# Street Scene

A browser street racing proof of concept in the spirit of NFSU2. You race at night through a procedurally generated neon city in tuner cars, with deep visual and performance customization in a garage. It runs on desktop and phone.

- Daily seeded city with circuit, sprint and drift events
- Custom deterministic arcade car physics with drifting and nitrous
- Three deterministic AI opponents with mild rubber banding
- Garage with body kits and parts, paint finishes, vinyls, stance, tint, underglow and performance tiers
- Replays and ghosts from input logs, plus a drone flyover mode
- Synthesized engine sound (inline-4 turbo for the Proto Compact, V6 for the Proto Hatch) and a persistent music player
- Test drive: free roam on the open seed map (no closures, rails, parked cars, crowds or rivals) with a live physics tuning panel and JSON export

## Run it

```bash
npm install
npm run dev        # http://localhost:5175
npm test           # unit, determinism, AI and replay tests
npm run build      # typecheck + production build into dist/
npm run assets     # convert source FBX cars, build parts, validate catalog
npm run validate   # validate the parts catalog only
npm run inspect    # print node/material/triangle info for GLB files
npm run music      # import albums / rebuild the music catalog (see docs/music.md)
```

Useful URL parameters: `?seed=anything` (custom event), `?race=circuit|sprint|drift` (jump into a race), `?garage`, `?drone`, `?quality=low|medium|high|auto`, `?fps` (fps, frame time, auto graphics level), `?dev` (garage dev mode), `?build=<code>` (load a shared build).

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Throttle / brake & reverse | W / S or Up / Down | RT / LT | GAS / BRAKE |
| Steer | A / D or Left / Right (ramped) | Left stick | Drag on the left half |
| Handbrake | Space | X | E-BRK |
| Nitrous | Shift or N | A / B | NOS |
| Manual shift (when enabled) | Q / E | LB / RB | |
| Reset to road | R | Y | RST |
| Horn and headlight flash (hold for a long blast) | H | Right stick click | |
| Camera (chase, close, bumper, hood) | C | Back | CAM |
| Pause | Esc / P | Start | II |
| Physics tuning panel (always shown when enabled in Settings > Debug) | ` or F2 | | |
| Menu free camera | Shift+F | | |
| Music: mute / previous / next | M / [ / ] | | Player card |

Drift by tapping the handbrake into a corner, or with a clutch kick (lift and stab the throttle while steering hard), then hold it with throttle and counter steer. With **traction control** off (the default, Settings), the driven wheels can spin: launches at high revs, full throttle in low gears mid corner (power oversteer on the rear wheel drive Proto Compact), slippery sidewalks and dirt, crests and clutch kicks. Spinning wheels lose most of their sideways grip. Traction control caps drive at the grip limit and cuts power in slides; AI opponents always drive with it. Nitrous refills from drifting, near misses with walls and drafting behind opponents. In replays, **C** cycles chase, TV, orbit, close, hood and free cameras. Drone mode uses WASD + drag; Space/Ctrl move up and down, Shift boosts, T toggles the auto tour.

## Music

A persistent music player runs across every screen. Every session opens with "Astrology" under the boot splash and shuffles on from there; volume, mute and shuffle are remembered. The soundtrack is **"CC BY: FREE TO USE - Electronic/Gaming Instrumentals" by 1000 Handz**, from the [Free Music Archive](https://freemusicarchive.org/music/1000-handz/cc-by-free-to-use-electronicgaming-instrumentals/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Each track is credited (title, artist, album, source, license) in the player, the library, the "Now playing" banner and the credits screen. The library is organized by artist and album so more artists can be added; see [docs/music.md](docs/music.md).

## Sound effects

Crowd sounds are **sound effects from freesound_community** on Pixabay, under the [Pixabay Content License](https://pixabay.com/service/license-summary/): `freesound_community-applause-70507.mp3` (saved as `public/sfx/applause.mp3`) and `freesound_community-crowd-cheering-6229.mp3` (saved as `public/sfx/crowd-cheering.mp3`). They are also listed on the credits screen. Every other sound (engines, impacts, nitrous, horn, beeps, fireworks) is synthesized at runtime.

## Car assets

Cars are free low poly models by **IceMaan** (icemaan.itch.io), released as **CC0**. A credits screen thanks them anyway.

Unzip each download into `assets/source/icemaan/<folder>/`, where `<folder>` is the car id or the name set in `scripts/assetConfig.json`:

| Car | Folder names recognized |
|---|---|
| GC14 (Proto Hatch, AWD 40/60) | `gc14`, `coupe` |
| S64 (Proto Compact, RWD) | `s64`, `hatch`, `compact` |

Then run `npm run assets`. It:

1. Converts each FBX to GLB. It uses Blender in background mode if it can find it (`BLENDER` env var, `blender` on PATH, or `/Applications/Blender.app`), otherwise FBX2glTF from the `fbx2gltf` npm package.
2. Normalizes each car to car space: meters, Y up, origin on the ground between the axles, facing +Z. It finds the front from the headlight/taillight materials and the axles by ray casting the wheel arches.
3. Renames source materials to the shared vocabulary (`materialMap` in `scripts/assetConfig.json`).
4. Writes Meshopt-compressed cars to `public/cars/` and parts (extra body kits, spoilers, universal wheels) to `public/parts/`.
5. Generates the **Proto RS** placeholder car and its parts procedurally.
6. Updates `src/assets/carManifest.json` and `src/assets/partsCatalog.json`, writes `assets/inspect.md`, and runs validation. It fails loudly on errors.

**Current status:** GC14 and S64 are imported. A car added to the manifest without source files renders as a code-built placeholder (box body, cylinder wheels) behind the same `carView.ts` interface, using the provisional dimensions in the manifest. The procedural Proto RS (`proto`) stays in the manifest for tests and the asset pipeline but isn't selectable.

## Adding a new part

See [docs/partsAuthoring.md](docs/partsAuthoring.md). In short: model it in car space using the shared material names, export a GLB to `public/parts/<carId>_<slot>_<partId>.glb`, add one entry to `src/assets/partsCatalog.json`, and run `npm run validate`. To try a part before cataloging it, open the garage, press Ctrl+Shift+D, and drag the GLB onto the window.

## Tuning cars

Every driving number lives in one hand editable file, **`src/sim/drivingParams.json`** (`src/sim/tuning.ts` only types, merges and validates it):

- `base`: the tuning every car starts from. It is exactly the Proto Compact (`s64`).
- `cars.<id>`: per car overrides merged over `base`, written as absolute values (`"mass": 2000`). Nested objects merge key by key; arrays (`torqueCurve`, `ratios`) replace whole. This is also where each car's `drivetrain` (`"rwd"`, `"awd"` or `"fwd"`, plus `awdFrontShare` for AWD) is set.
- `performanceParts`: the garage upgrade tier tables that `applyBuild()` reads.
- Keys starting with `_` are comments. Unknown keys and wrong types fail loudly at startup. Geometry comes from `src/assets/carManifest.json`.

The **physics tuning panel** shows every driving parameter of the car (drivetrain, engine, torque curve, gear ratios, tires, traction and wheelspin, suspension, brakes, steering, aero, nitrous, drift aids, surfaces, collisions) as a live slider, grouped by section, with a filter box that also searches descriptions. Hover a name for its one line description, or tap it to show the description inline. Changed values are highlighted. Turn it on in Settings > Debug, or toggle it with **`** / **F2** in any race. Test drive tuning is kept per car and re-applied on the next test drive. It's discarded automatically when `drivingParams.json` changes, so it never masks edits to the file.

- **Copy JSON** / **Download** export `{ nightRunTuning, carId, performance, changed, fileOverride, tuning }`. `changed` lists only what you moved. `fileOverride` is the same change as a block to paste into `cars.<id>` in `drivingParams.json` (exported only with stock performance parts).
- **Import** accepts that same export (it applies the full `tuning`), a `drivingParams.json` style car block, or a flat `"path": value` map.
- **Reset all** returns to the car's stock tuning with its performance parts.

Runs with changed tuning are never saved as best times or ghosts.

## Architecture

```
src/
  main.ts            boot, fixed-step loop, state machine (menu, race, garage, drone)
  loop.ts            60 Hz accumulator with capped catch up and interpolation alpha
  seed.ts            UTC YYYYMMDD event seed, ?seed= override (client side only)
  sim/               pure deterministic simulation (no DOM, no three.js, no clock)
    prng.ts math.ts constants.ts input.ts tuning.ts build.ts car.ts
    collision.ts ai.ts race.ts stats.ts
  city/              pure procedural city: roadGraph, blocks, route, terrain, world
  render/            three.js only, reads state: scene, cityMeshes, facadeKit, lighting,
                     lightFx, post, carView, carAssets, carMaterials, decals, camera,
                     routeArrows, roadblocks, autoQuality (frame budget + auto graphics)
  garage/            garageScene, garageUi, storage (slots + share codes)
  game/              session (race on screen), drone
  input/             keyboard/gamepad manager, touch controls
  ui/                HUD, menus, dev panel, Lucide icon helpers
  replay/            replay and ghost storage
  audio/             persistent music player
  shared/parts.ts    slot list, material vocabulary, triangle budgets
  assets/            carManifest.json, partsCatalog.json
scripts/             buildAssets, inspectAsset, validateParts, placeholderCar, blender/fbxToGlb.py
assets/music/       album.json credits per artist/album (audio goes to public/music/)
docs/partsAuthoring.md docs/music.md
tests/
```

### Rules the code follows

1. **The simulation is pure.** `src/sim/` and `src/city/` never touch DOM, `window` or three.js. Given a seed, a performance build and a stream of input frames, they produce the same state. They run headless in Vitest today, and could run on a server to verify leaderboard times later.
2. **Determinism.** No `Math.random`, `Date`, `performance.now` or frame time in the sim. The seeded mulberry32 PRNG is the only randomness. Physics steps at a fixed 60 Hz (two substeps). AI lives inside the sim. Trig used by the sim goes through `src/sim/math.ts` so it can be swapped for a portable implementation.
3. **Rendering only reads state.** `RaceSession` keeps the previous and current snapshots and interpolates with the loop's alpha. Nothing in `src/render/` writes to the sim.
4. **Inputs are data.** Each tick consumes one frame `{ throttle, brake, steer, handbrake, nitrous, shift, reset }`. Frames are quantized and packed to 4 bytes before the sim reads them, so the recorded log replays bit for bit.
5. **Visual and performance builds are separate.** `CarBuild = { visual, performance }`. Only the renderer reads `visual`. The sim reads `performance` through the pure `applyBuild(baseTuning, performance)`. A test confirms visual choices never change the tuning.
6. **All tuning lives in `src/sim/drivingParams.json`.**
7. **Frame-rate targets.** Aim for 120 fps, hold 60, never below 30 (`FRAME_BUDGET` in `src/render/autoQuality.ts`). Physics stays at 60 Hz and the renderer interpolates, so frame rate and tick rate are independent; per-frame work scales with `dt`. Auto graphics buys quality only with headroom at the aim and sells it as soon as 60 slips.

### Tests

- PRNG; city and route determinism; route connectivity, loop closure and unique edges across 200 seeds
- World queries; input packing; physics (suspension, nitrous, handbrake drift, reverse)
- Recorded input log replayed twice gives identical state
- Build validation and clamping; share code round trip; visual choices don't change tuning
- Parts catalog validation against the real files
- Upgrades improve 0 to 100 km/h and top speed, and cover more ground in a race
- AI opponents finish 50 random seeds (circuit and sprint) without getting stuck
- Corner rails are smooth piece chains at the back of the sidewalk, clear of walls, barriers and props; dented pieces keep joints under 1/8 car width, steps cost speed, and dents replay identically; open world test drives have no closures, rails or rivals
- A full race with AI replays identically (finish times and order); solo replays (ghost source) finish with the same time
- Browser tests (`npm run e2e`, Playwright in headless Chromium against the dev server): the boot splash lands the title on the menu and deep links skip it; every session opens on "Astrology" from the top, waiting for the first click when the browser refuses autoplay and playing at once when it allows it

## Decisions made along the way

- **Port 5175.** The dev server is pinned to it (`vite.config.ts`, `strictPort`).
- **Input frame extended.** The spec's five fields gained `shift` (manual gearbox) and `reset` (reset to road) so that both are recorded and replayable.
- **No Blender here, so FBX2glTF.** Normalization happens in Node with glTF Transform, so the Blender and FBX2glTF paths give identical results. The Blender script only converts.
- **Source scale.** The IceMaan models are roughly 3/4 scale. Each car is scaled to a target length (`targetLength` in `assetConfig.json`), and the wheels use the same factor, clamped to the arch opening.
- **Merged body kits.** The IceMaan kits are single meshes, so they're `body` variants. Bumper slots stay empty for those cars until they're split. The Proto RS placeholder has separate bumpers, skirts, hood, spoilers and wheels to show the full slot system.
- **Buildings are one merged geometry** with world-scale UVs, rather than instanced boxes, so window grids keep their proportions on every building. The street-level podium (2 to 4 floors) uses a separate facade kit atlas with per-level random protrusions.
- **Collision shapes.** Cars are three circles along their length. Walls are the outer sidewalk line of every road (one sided, which stops tunnelling). Closed side streets are barrier segments. Head-on closures look like barriers with arrows. Side closures look like a line of parked cars but use the same segment.
- **Corner guard rails.** Every route corner has a long smooth rail on its outside at the back of the sidewalk (against the building line), so the road and the whole sidewalk are drivable runoff: along the incoming road, around a finely segmented fillet, and along the outgoing road, bending back behind the crosswalks of closed side streets and around street furniture. Rails are chains of 2.5 m modular pieces (`src/sim/rails.ts`), each a very heavy sim body: a hit shoves the piece back by impulse / mass (capped at 0.6 m, a hair of rotation, no spring back) and the dent stays for the race, so a wall rider leaves a stepped rail for the next lap. Neighbors are dragged along so no joint ever opens more than 1/8 of a car width. Low bounce and spin, but scraping drags speed off (`railDrag`, `railSpeedLoss`), shoving a piece costs speed (`railDentLoss`) and scraping into a step costs more (`railStepLoss`). Chevron panels on the rail modules (drawn at their displaced poses) and a giant translucent arrow above point the way.
- **Side street car meets.** Closed side streets the racers are unlikely to hit are lined with rows of parked cars, mostly nose toward the track like spectators. Density follows the graphics quality.
- **Light color temperature.** Windows, doors and arches use blackbody colors between 2000 K and 8000 K. Only signs and rooftop trims are neon colored.
- **Garage cars.** Only the Proto Compact (`s64`) and Proto Hatch (`gc14`) are offered (manifest `selectable`). The Proto RS stays loadable for tests; saved builds for cars that are no longer offered move to the default car. Vinyls are hidden behind a feature flag (`src/shared/features.ts`).
- **Boot splash.** A page load that lands on the menu flashes the title in over black (neon flicker, chromatic split, shine, tagline tracking in) while the assets are checked, then flies it onto the menu's title block with a FLIP transform as the black fades to the city. The splash block is a copy of the menu's title block at the same column width, so it wraps the same way and the swap is invisible. Deep links (`?race=`, `?garage`, `?drone`) skip it; reduced motion gets a plain fade.
- **Music autoplay.** Every session opens on the same track ("Astrology") from the top, then shuffles; only volume, mute, shuffle and the minimized state persist. Browsers only allow audible autoplay once the user has interacted with the site, so when that is refused the opening track simply waits for the first click, tap or key press (the splash says so) rather than running muted and being joined halfway. Engine audio starts on the first gesture for the same reason.
- **Build version** (`v<package version> · <git hash> · <date>`) is shown under the title on the main menu.
- **Routes avoid hairpins.** Turns sharper than 112° through acute diagonal junctions are rejected because cars wedge there.
- **AI safety net.** If an AI car makes no progress for 4 s, or is stopped for 2.5 s, the race resets it to the road. Finished cars stop colliding so they never block anyone.
- **Car stats are measured, not formula based.** The garage drives the real sim in a flat test world to get top speed and 0 to 100 km/h.
- **Share codes** are deflate-compressed JSON with short keys (base64url), loaded via `?build=`. Imported builds are always validated and clamped.
- **Wet look is faked:** glossy puddled asphalt with an environment map, additive light pools, and camera-facing reflection streaks. Only a few real point lights follow the player.
- **Ghosts** are saved for solo runs (0 opponents or drift) when they set a new best. The ghost is a second sim instance replaying the stored log.
- **Music** is transcoded from 320 to 128 kbps with loudness normalization (about 119 MB for 42 tracks) and committed under `public/music/` so the game runs from a fresh clone. Move it to Git LFS or a CDN if the repo gets heavy.
- **Icons** come from Lucide everywhere: menus, HUD, buttons, and the 3D route arrows, which are drawn from Lucide icon paths onto canvas textures.
- **Frame-rate targets: 120 aim, 60 hold, 30 floor.** Auto graphics can only read the display's refresh rate from the fastest frames it sees (requestAnimationFrame never runs faster), so a 120 Hz screen counts as 60 Hz until the game has actually run at 120 on it, and a 60 Hz screen simply aims at 60. Between 60 and the aim it holds rather than trading quality for frames nobody asked for. Quality settings cannot buy frames the GPU is not spending: when dropping three levels does not help (CPU bound, throttled tab) the controller goes back up and stops trying for a while, so the 30 fps floor is only enforceable when rendering is the bottleneck.

## Out of scope for now (but designed for)

- **Ambient traffic.** It can spawn from the seed inside the sim, like the AI.
- **Leaderboard.** The client would upload seed, mode, performance build and input log (`ReplayData`), and a server function reruns the pure sim to verify the time.
- **Audio.** Car state already exposes rpm, slip, nitrous and impacts.
- **Career, currency and unlocks.** Performance tiers are already data driven.
