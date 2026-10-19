# Night Run

A browser street racing proof of concept in the spirit of NFSU2. You race at night through a procedurally generated neon city in tuner cars, with deep visual and performance customization in a garage. It runs on desktop and phone.

- Daily seeded city with circuit, sprint and drift events
- Custom deterministic arcade car physics with drifting and nitrous
- Three deterministic AI opponents with mild rubber banding
- Garage with body kits and parts, paint finishes, vinyls, stance, tint, underglow and performance tiers
- Replays and ghosts from input logs, plus a drone flyover mode

## Run it

```bash
npm install
npm run dev        # http://localhost:5175
npm test           # unit, determinism, AI and replay tests
npm run build      # typecheck + production build into dist/
npm run assets     # convert source FBX cars, build parts, validate catalog
npm run validate   # validate the parts catalog only
npm run inspect    # print node/material/triangle info for GLB files
```

Useful URL parameters: `?seed=anything` (custom event), `?race=circuit|sprint|drift` (jump into a race), `?garage`, `?drone`, `?quality=low|medium|high`, `?fps`, `?dev` (garage dev mode), `?build=<code>` (load a shared build).

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Throttle / brake & reverse | W / S or Up / Down | RT / LT | GAS / BRAKE |
| Steer | A / D or Left / Right (ramped) | Left stick | Drag on the left half |
| Handbrake | Space | X | E-BRK |
| Nitrous | Shift or N | A / B | NOS |
| Manual shift (when enabled) | Q / E | LB / RB | |
| Reset to road | R | Y | RST |
| Camera (chase, close, bumper, hood) | C | Back | CAM |
| Pause | Esc / P | Start | II |
| Dev tuning panel | ` or F2 | | |
| Menu free camera | Shift+F | | |

Drift by tapping the handbrake into a corner, or with a clutch kick (lift and stab the throttle while steering hard), then hold it with throttle and counter steer. Nitrous refills from drifting, near misses with walls and drafting behind opponents. In replays, **C** cycles chase, TV, orbit, close, hood and free cameras. Drone mode uses WASD + drag; Space/Ctrl move up and down, Shift boosts, T toggles the auto tour.

## Car assets

Cars are free low poly models by **IceMaan** (icemaan.itch.io), released as **CC0**. A credits screen thanks them anyway.

Unzip each download into `assets/source/icemaan/<folder>/`, where `<folder>` is the car id or the name set in `scripts/assetConfig.json`:

| Car | Folder names recognized |
|---|---|
| GC14 Coupe | `gc14`, `coupe` |
| S64 Compact | `s64`, `hatch`, `compact` |
| CC96 | `cc96` |
| A R7 | `ar7`, `r7` |

Then run `npm run assets`. It:

1. Converts each FBX to GLB. It uses Blender in background mode if it can find it (`BLENDER` env var, `blender` on PATH, or `/Applications/Blender.app`), otherwise FBX2glTF from the `fbx2gltf` npm package.
2. Normalizes each car to car space: meters, Y up, origin on the ground between the axles, facing +Z. It finds the front from the headlight/taillight materials and the axles by ray casting the wheel arches.
3. Renames source materials to the shared vocabulary (`materialMap` in `scripts/assetConfig.json`).
4. Writes Meshopt-compressed cars to `public/cars/` and parts (extra body kits, spoilers, universal wheels) to `public/parts/`.
5. Generates the **Proto RS** placeholder car and its parts procedurally.
6. Updates `src/assets/carManifest.json` and `src/assets/partsCatalog.json`, writes `assets/inspect.md`, and runs validation. It fails loudly on errors.

**Current status:** GC14 and S64 are imported. CC96 and A R7 aren't downloaded yet. They appear in the garage as "Model not imported yet" and render as a code-built placeholder (box body, cylinder wheels) behind the same `carView.ts` interface, using the provisional dimensions in the manifest.

## Adding a new part

See [docs/partsAuthoring.md](docs/partsAuthoring.md). In short: model it in car space using the shared material names, export a GLB to `public/parts/<carId>_<slot>_<partId>.glb`, add one entry to `src/assets/partsCatalog.json`, and run `npm run validate`. To try a part before cataloging it, open the garage, press Ctrl+Shift+D, and drag the GLB onto the window.

## Tuning cars

All physics constants live in `src/sim/tuning.ts`: base tuning, per car overrides, and the performance part tier tables that `applyBuild()` reads. During a race, press **`** (backtick) to open the dev panel. Its sliders edit the player car's tuning live, and **Copy JSON** gives you the values to paste back into `tuning.ts`. Runs with dev tuning changes aren't saved as best times or ghosts.

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
                     routeArrows, roadblocks
  garage/            garageScene, garageUi, storage (slots + share codes)
  game/              session (race on screen), drone
  input/             keyboard/gamepad manager, touch controls
  ui/                HUD, menus, dev panel, Lucide icon helpers
  replay/            replay and ghost storage
  shared/parts.ts    slot list, material vocabulary, triangle budgets
  assets/            carManifest.json, partsCatalog.json
scripts/             buildAssets, inspectAsset, validateParts, placeholderCar, blender/fbxToGlb.py
docs/partsAuthoring.md
tests/
```

### Rules the code follows

1. **The simulation is pure.** `src/sim/` and `src/city/` never touch DOM, `window` or three.js. Given a seed, a performance build and a stream of input frames, they produce the same state. They run headless in Vitest today, and could run on a server to verify leaderboard times later.
2. **Determinism.** No `Math.random`, `Date`, `performance.now` or frame time in the sim. The seeded mulberry32 PRNG is the only randomness. Physics steps at a fixed 60 Hz (two substeps). AI lives inside the sim. Trig used by the sim goes through `src/sim/math.ts` so it can be swapped for a portable implementation.
3. **Rendering only reads state.** `RaceSession` keeps the previous and current snapshots and interpolates with the loop's alpha. Nothing in `src/render/` writes to the sim.
4. **Inputs are data.** Each tick consumes one frame `{ throttle, brake, steer, handbrake, nitrous, shift, reset }`. Frames are quantized and packed to 4 bytes before the sim reads them, so the recorded log replays bit for bit.
5. **Visual and performance builds are separate.** `CarBuild = { visual, performance }`. Only the renderer reads `visual`. The sim reads `performance` through the pure `applyBuild(baseTuning, performance)`. A test confirms visual choices never change the tuning.
6. **All tuning lives in `src/sim/tuning.ts`.**

### Tests

- PRNG; city and route determinism; route connectivity, loop closure and unique edges across 200 seeds
- World queries; input packing; physics (suspension, nitrous, handbrake drift, reverse)
- Recorded input log replayed twice gives identical state
- Build validation and clamping; share code round trip; visual choices don't change tuning
- Parts catalog validation against the real files
- Upgrades improve 0 to 100 km/h and top speed, and cover more ground in a race
- AI opponents finish 50 random seeds (circuit and sprint) without getting stuck
- A full race with AI replays identically (finish times and order); solo replays (ghost source) finish with the same time

## Decisions made along the way

- **Port 5175.** The dev server is pinned to it (`vite.config.ts`, `strictPort`).
- **Input frame extended.** The spec's five fields gained `shift` (manual gearbox) and `reset` (reset to road) so that both are recorded and replayable.
- **No Blender here, so FBX2glTF.** Normalization happens in Node with glTF Transform, so the Blender and FBX2glTF paths give identical results. The Blender script only converts.
- **Source scale.** The IceMaan models are roughly 3/4 scale. Each car is scaled to a target length (`targetLength` in `assetConfig.json`), and the wheels use the same factor, clamped to the arch opening.
- **Merged body kits.** The IceMaan kits are single meshes, so they're `body` variants. Bumper slots stay empty for those cars until they're split. The Proto RS placeholder has separate bumpers, skirts, hood, spoilers and wheels to show the full slot system.
- **Buildings are one merged geometry** with world-scale UVs, rather than instanced boxes, so window grids keep their proportions on every building. The street-level podium (2 to 4 floors) uses a separate facade kit atlas with per-level random protrusions.
- **Collision shapes.** Cars are three circles along their length. Walls are the outer sidewalk line of every road (one sided, which stops tunnelling). Closed side streets are barrier segments. Head-on closures look like barriers with arrows. Side closures look like a line of parked cars but use the same segment.
- **Routes avoid hairpins.** Turns sharper than 112° through acute diagonal junctions are rejected because cars wedge there.
- **AI safety net.** If an AI car makes no progress for 4 s, or is stopped for 2.5 s, the race resets it to the road. Finished cars stop colliding so they never block anyone.
- **Car stats are measured, not formula based.** The garage drives the real sim in a flat test world to get top speed and 0 to 100 km/h.
- **Share codes** are deflate-compressed JSON with short keys (base64url), loaded via `?build=`. Imported builds are always validated and clamped.
- **Wet look is faked:** glossy puddled asphalt with an environment map, additive light pools, and camera-facing reflection streaks. Only a few real point lights follow the player.
- **Ghosts** are saved for solo runs (0 opponents or drift) when they set a new best. The ghost is a second sim instance replaying the stored log.
- **Icons** come from Lucide everywhere: menus, HUD, buttons, and the 3D route arrows, which are drawn from Lucide icon paths onto canvas textures.

## Out of scope for now (but designed for)

- **Ambient traffic.** It can spawn from the seed inside the sim, like the AI.
- **Leaderboard.** The client would upload seed, mode, performance build and input log (`ReplayData`), and a server function reruns the pure sim to verify the time.
- **Audio.** Car state already exposes rpm, slip, nitrous and impacts.
- **Career, currency and unlocks.** Performance tiers are already data driven.
