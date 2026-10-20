# Street Scene

A browser street racing proof of concept in the spirit of NFSU2. You race at night through a procedurally generated neon city in tuner cars, with deep visual and performance customization in a garage. It runs on desktop and phone.

- Daily seeded city with circuit, sprint and drift events
- Custom deterministic arcade car physics with drifting and nitrous
- Three deterministic AI opponents with mild rubber banding
- Garage with body kits and parts, paint finishes, vinyls, stance, tint, underglow and performance tiers
- Replays and ghosts from input logs, plus a drone flyover mode with its own minimap (also a photo mode in any race: press 0)
- Number key cameras and a mouse drag that orbits the camera around the car at any time
- Synthesized engine sound (inline-4 turbo for the Proto Compact, V6 for the Proto Hatch) and a persistent music player
- Regional architecture: neighbourhoods that blend New York, Los Angeles, San Francisco, Philadelphia and Miami
- About half the city is special districts: two to three hills (domes, ridges and basins up to 16 m with 11% grades), two to three parks, a floodlit monument plaza, roundabouts, alleys, the river and the El
- Sparks when a car bottoms out or scrapes a wall or rail
- Street polish: manholes, drains, tar, oil, worn crosswalks, lane arrows, bike lanes, painted curbs and stencils, rubber on the route's corners, puddles, graffiti, posters, grime, blade signs, banners and steaming manholes
- Destructible city: street furniture plus cafe tables, bushes, planter pots, crates, barrels, dumpsters, news boxes and trash bags in corner plazas, parks and alleys; back alley kicker jumps
- Spectator crowds at the start and finish, and a street meet behind every cyan barrier: a crowd packed against it, then customized cars parked nose to the course
- Every circuit and sprint has at least one construction-site shortcut: a slim cobbled back alley fenced off at both ends that you smash through, and it really pays off
- An elevated railway on most seeds, with trains running both ways and stations
- Free roam: the whole city of the event seed (or a new random one) with no route, rules or rivals
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

Useful URL parameters: `?seed=anything` (custom event), `?race=circuit|sprint|drift` (jump into a race), `?freeroam`, `?garage`, `?drone`, `?quality=low|medium|high|auto`, `?fps` (fps, frame time, auto graphics level), `?dev` (garage dev mode), `?build=<code>` (load a shared build).

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
| Camera views: 1 chase, 2 close, 3 bumper, 4 hood, 5 trackside TV, 6 orbit, 7 free (replays) | 1 to 7 | | |
| Drone (photo mode in a race, flyover from the menu); again to come back | 0 | | |
| Orbit the camera around the car (eases back once you drive on) | Mouse drag | | |
| Pause | Esc / P | Start | II |
| Physics tuning panel (always shown when enabled in Settings > Debug) | ` or F2 | | |
| Menu free camera | Shift+F | | |
| Music: mute / previous / next | M / [ / ] | | Player card |

Drift by tapping the handbrake into a corner, or with a clutch kick (lift and stab the throttle while steering hard), then hold it with throttle and counter steer. With **traction control** off (the default, Settings), the driven wheels can spin: launches at high revs, full throttle in low gears mid corner (power oversteer on the rear wheel drive Proto Compact), slippery sidewalks and dirt, crests and clutch kicks. Spinning wheels lose most of their sideways grip. Traction control caps drive at the grip limit and cuts power in slides; AI opponents always drive with it. Nitrous refills from drifting, near misses with walls and drafting behind opponents. In replays, **C** cycles chase, TV, orbit, close, hood and free cameras. Drone mode uses WASD + drag; Space/Ctrl move up and down, Shift boosts, T toggles the auto tour. In a race or free roam, **0** freezes the action and hands the camera to the drone from where it is; 0 or Esc flies back to the car.

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
- Corner rails are smooth piece chains at the back of the sidewalk, clear of walls and props; dented pieces keep joints under 1/8 car width, steps cost speed, and dents replay identically; open world test drives have no closures, rails or rivals
- Every closed street is shut by cyan rail pieces (its own chain, or a corner rail across its mouth) that never cross other rails or city walls, head-on closures further back than side ones
- Street meets are deterministic, keep every spectator behind the barrier and off the course, park the cars behind the packed crowd, and thin out from front to back
- Every circuit and sprint over 120 seeds gets an open shortcut that saves distance without skipping too much; a car driving it is credited the stretch it skips, while the same jump elsewhere is capped, and no reset or wrong way fires inside one
- Alley widths, cobbles under every alley road strip and nowhere else, clutter density per alley kind, a clear lane in every alley, and fences at both shortcut mouths that cover every line a car fits on yet break at a crawl
- Railway columns and station stairs are drawn and clear of every road; the timetable is a pure function of time with one direction per track
- The architecture plan is deterministic, mixes all five cities and many styles, clusters into neighbourhoods rather than dicing every building, and never leaves a neon sign hanging above a building
- Hills: two to three per seed in clusters of two to four blocks, grades capped, zero past the slope with C1 gradients, deterministic, clear of the channel, the El, roundabouts and each other; monument walls inside the plaza and off roads, the arch gap drivable; the special district share by street length
- Spark telemetry reports wall scrapes and bottoming out, and scrambling it changes nothing in the physics
- A full race with AI replays identically (finish times and order); solo replays (ghost source) finish with the same time
- Browser tests (`npm run e2e`, Playwright in headless Chromium against the dev server): the boot splash lands the title on the menu and deep links skip it; every session opens on "Astrology" from the top, waiting for the first click when the browser refuses autoplay and playing at once when it allows it

## Decisions made along the way

- **Port 5175.** The dev server is pinned to it (`vite.config.ts`, `strictPort`).
- **Input frame extended.** The spec's five fields gained `shift` (manual gearbox) and `reset` (reset to road) so that both are recorded and replayable.
- **No Blender here, so FBX2glTF.** Normalization happens in Node with glTF Transform, so the Blender and FBX2glTF paths give identical results. The Blender script only converts.
- **Source scale.** The IceMaan models are roughly 3/4 scale. Each car is scaled to a target length (`targetLength` in `assetConfig.json`), and the wheels use the same factor, clamped to the arch opening.
- **Merged body kits.** The IceMaan kits are single meshes, so they're `body` variants. Bumper slots stay empty for those cars until they're split. The Proto RS placeholder has separate bumpers, skirts, hood, spoilers and wheels to show the full slot system.
- **Buildings are one merged geometry** with world-scale UVs, rather than instanced boxes, so window grids keep their proportions on every building. The street-level podium (2 to 4 floors) uses a separate facade kit atlas with per-level random protrusions.
- **Half the city is special.** Special districts may take up to 45% of the block area: two to three hills, two to three parks, a monument plaza on 60% of seeds and more roundabouts per seed, with alleys, the river and the El on top. Measured by street length, about 42% of streets run through or beside a special district (the old split was about 80/20).
- **Hills.** Clusters of two to four blocks rise on a smooth dome, ridge or basin 8 to 16 m high with a flat top. The flanks hold an 11% grade cap and are C1 everywhere, so streets climb, crest at the plateau edge and drop away; buildings stay (San Francisco styles cluster up there) and everything follows the terrain. Slopes keep clear of the channel, the El, roundabouts and the monument. On a hillside a building sits on its lowest corner and a dark concrete plinth climbs with the ground along its faces, so buried storefronts read as a retaining wall and nothing floats.
- **Monument plaza.** On 60% of seeds a block near the centre becomes an open concrete plaza you can cut across, with a floodlit obelisk, statue column or drive-through triumphal arch on a stepped base; the step ring or the arch piers are the collision, everything else is render only and merges into the district meshes.
- **Regional architecture, render only.** A jittered grid of neighbourhoods (cells about 210 m) blends five cities: New York toward downtown, San Francisco up the hills, Miami along the water, Los Angeles toward the edges, Philadelphia in the ring between. Eleven styles follow from city and height (brownstone, prewar, art deco, glass, Spanish revival, mid-century, Victorian, rowhouse, Second Empire, Miami deco, condo), and terrace blocks share cornice lines. It is decided in `src/render/architecture.ts` from city data, so replays never change.
- **Facades are weights, not colours.** One 12 layer texture array stores wall, trim and glass weights, so every building gets its own palette in the shader and stays correct at every mip level. Window light is procedural per window: offices light in floor runs, homes window by window, with blinds, slow on and off changes, TV flicker and the odd party window, fading to the average in the distance so towers never sparkle.
- **Massing and details stay merged.** Setback tiers, floodlit crowns and spires, mansards, tile roofs, gables, rooftop water towers, bulkheads, masts with aviation lights, lit billboards, fire escapes, bay windows, sun shades and balconies all go into the existing city meshes; fire escapes, billboards and aviation lights add 3 draw calls. Detail follows the graphics tier. A warm street bounce fading with height, coloured floods and a glass sheen make it readable at night without adding real lights.
- **Collision shapes.** Cars are three circles along their length. Walls are the outer sidewalk line of every road (one sided, which stops tunnelling). Closed side streets are shut by chains of cyan rail pieces, the same heavy modular bodies as the corner rails, so every closure looks and behaves like the rails.
- **Corner guard rails.** Every route corner has a long smooth rail on its outside at the back of the sidewalk (against the building line), so the road and the whole sidewalk are drivable runoff: along the incoming road, around a finely segmented fillet, and along the outgoing road, bending back behind the crosswalks of closed side streets and around street furniture. Rails are chains of 2.5 m modular pieces (`src/sim/rails.ts`), each a very heavy sim body: a hit shoves the piece back by impulse / mass (capped at 0.6 m, a hair of rotation, no spring back) and the dent stays for the race, so a wall rider leaves a stepped rail for the next lap. Neighbors are dragged along so no joint ever opens more than 1/8 of a car width. Low bounce and spin, but scraping drags speed off (`railDrag`, `railSpeedLoss`), shoving a piece costs speed (`railDentLoss`) and scraping into a step costs more (`railStepLoss`). Chevron panels on the rail modules (drawn at their displaced poses) point the way.
- **Cyan barriers and signs.** Every rail piece carries a chevron panel whose chevrons march the way the route goes, an LED strip with light comets running the same way, a soft glow pooled on the ground in front and an amber beacon on every fourth post; shoved pieces are redrawn where they were left. A neon sign floats over every closure and at the apex of every corner rail: a tube frame around big chevrons (along the route past a side closure, toward the turn at a head-on one) that hovers, shimmers, fades in from the distance and fades out again before it would fill the screen.
- **Street meets instead of the yellow barrier.** Behind every cyan barrier with open ground behind it (`src/render/meetPlan.ts`) stands a crowd packed against the barrier and thinning with depth, then cars parked nose to the course as if they pulled in to watch: dense in the first rows, where people mix between them, sparser at the back. Each car is a garage model in a stock or body kit variant (spoiler, coloured rims) with random paint, many with underglow, some front row ones with hazards blinking. The yellow barrier is gone: the closure itself is now the cyan rail, and a second barrier behind the cars would only add draw calls, since a car cannot get through the rail. People and cars are render only and never collide. Crowd density and depth, car rows and draw distance follow the graphics quality, and people beyond 70 m are drawn as a three box stand-in.
- **Light color temperature.** Windows, doors and arches use blackbody colors between 2000 K and 8000 K. Only signs and rooftop trims are neon colored.
- **Inside corners you can crash through.** A share of junction corners (`openCornerChance`) keeps its buildings back, and the infill turns corner voids into drivable pockets: cafe terraces, gardens and market corners full of destructible clutter, shallow verges of bushes and pots where nothing deeper fits. About one corner solution in six stays solid on purpose (raised planters, the odd fountain). A closure barrier that ends where a pocket opens is carried across it, so a pocket is never a way around a closure.
- **Closures stand back from the track.** Head-on closures (straight ahead of the incoming road) stand 7 m further into their street than before, side closures 3 m, so overshooting a corner has room. Where a corner rail already runs across a closed street's mouth, that rail is the closure.
- **Crowd sections.** Besides the start and finish stands, every street meet's crowd is a section (one instanced mesh each, culled by distance). Sections cheer as racers pass and burst into applause; at most eight crowd loops play at once. Both crowd clips are normalized on load to a fixed loudness (with a soft limiter against clipping) and play about three times louder than before, so a meet is heard over the engines.
- **Camera shake and the nitrous warp.** Two shake layers ride on every follow camera: heavy for wall, rail and car crashes and for any sudden loss of speed (more than about 0.45 m/s in one sim tick), light for knocking props over (heavier props knock harder; soft ones like bushes never count as a crash). Each is trauma that decays linearly and shows squared through smooth noise as sway, bob and roll, so it looks the same at any frame rate; the numbers are in the camera panel (F3). Nitrous leaves the middle 50% of the screen untouched; from there to the edges it ramps up a fluid stretch (the picture streams outward through a drifting warp), a zoom blur up to about three times longer, colour fringes, contrast and saturation, and the bloom strengthens. It follows the speed blur setting.
- **Every route has a shortcut.** Both routes are picked while the city is planned, and each gets one or two back alleys carved for it: a diagonal across the inside block of a sharp turn, a cut across a block the route wraps, or a chord through one block as a fallback. A route with no room for one is swapped for an alternative. A shortcut saves at least 20% of the stretch it skips and never skips more than about a third of the lap; across 1000 seeds most routes get two.
- **Shortcuts pay off.** Race progress credits the whole skipped stretch to a car inside one of the route's shortcuts, while any other big jump is still cut to one tick's driving. Back alleys that are not a real shortcut of the route are closed off like side streets. AI drivers stay on the racing line.
- **Alleys are slim and cobbled.** Raceway alleys are 7.4 m curb to curb with 1.4 m sidewalks, back alleys 4.8 m, route shortcuts 5.2 m, and two to four raceway alleys plus two to five back alleys per seed. Every alley is cobbled between its mouths: a little less grip and more rolling drag than asphalt (tuned in `drivingParams.json`), no lane markings, and a fine camera rumble that grows with speed.
- **Alleys are full of things to hit.** Raceway alleys are lined block after block with restaurant fronts, storage clutter and street works (hoarding, sandbags, water barriers, sawhorses and cones spilling onto the cobbles); back alleys with dumpsters, pallets and crates. Nothing that can stop a car stands within a car's width plus a margin of the centreline.
- **Shortcuts are construction sites.** Each route shortcut is a 100 to 160 m back alley fenced at both mouths with chain-link panels in contractors' colours, plus sawhorses and cones. A panel goes down at any speed and costs a fast car about 2% of its speed. A random back alley that joins two route points gets the same treatment. There is no sign or floor arrow: the fencing, the string lights and the minimap's pink dashes are the tell.
- **Elevated railway ("the El").** About three seeds in four get a twin track steel El over one north-south street: riveted plate girders, open ties you see the sky through, a third rail, steel columns with knee braces on concrete footings (the footings are the collision), a truss over the river, and run-offs past the map edges into tunnel portals in the fog.
- **Trains both ways, from the clock.** Five car trains run a timetable that is a pure function of time, one direction per track: they brake into stations, dwell and leave, so the menu, a race and its replay show the same trains. Medium and High add a light wash through the ties and third rail sparks. A rumble follows the nearest train once the page has had a click or key press.
- **Stations.** One or two per line: an island platform the street side track swings out around, a canopy, lit name boards, a station house under the deck, and enclosed stairs down to the sidewalk with green globes. The stairs collide; the platform and house are overhead. Columns keep clear of where any closure could stand and out of other streets' sidewalks.
- **Street polish is pasted on, never built in.** Manholes, drains, tar, cracks, oil, worn crosswalks, lane arrows, bike lanes, painted curbs and stencils, corner rubber and puddles are quads from one procedural atlas with a matching roughness atlas (tar and oil gloss, paint stays matte): two draw calls for a whole city of them. The rubber follows the route's own corners, braking on the outside of the approach and a fillet through the apex.
- **Walls are dressed by probing what is drawn.** Facades stand an unknown few decimetres behind the collision walls, so graffiti, posters, grime, pipes, AC units and blade signs find the podium surface by probing its geometry (`src/render/wallProbe.ts`); low infill walls are exact. Three draw calls: paint (a little self-lit so alleys read), boxes, neon blade signs. A few manholes breathe shader-animated steam on Medium and High, one instanced mesh and one uniform per frame.
- **Sparks from contact telemetry.** The sim records, without ever reading them back, each tick's deepest wall or rail contact (point, normal, sliding speed) and how far any corner pushed past its suspension travel. The renderer turns those into a stream trailing a car that scrapes, a burst on a hard wall hit and a spray off the underbody when it bottoms out. One pooled mesh draws every spark; its flight, drag, gravity, skid along the road and cooling from white to red are computed in the vertex shader, so the CPU only writes new sparks into a ring buffer (160 / 384 / 768 by quality).
- **One minimap for the HUD and the drone.** The drone flyover and the race photo mode show the minimap centred on the drone with its view cone and a north mark, zooming out as it climbs (street detail low, a whole district at the ceiling); in a race it also marks your car and the field.
- **Engine voices by layout.** The car's engine layout (manifest `engine.layout`) picks the voice's character, not just its pitch: a V6 like the GC14's is two pulse trains, so it gets a per-bank order at half the firing frequency and a bank to bank beat that growls; an inline six stays silky with a sixth order whine; boxers rasp and burble, cross-plane eights rumble with a heavy beat, rotaries buzz smooth and high. The table is `VOICE_CHARACTER` in `src/audio/engineAudio.ts`.
- **Engine voice for small speakers.** Most engine energy sits below 300 Hz, which laptop speakers barely reproduce, so the voice has a presence peak tracking the firing frequency and runs about 9 dB hotter than before.
- **Garage cars.** Only the Proto Compact (`s64`) and Proto Hatch (`gc14`) are offered (manifest `selectable`). The Proto RS stays loadable for tests; saved builds for cars that are no longer offered move to the default car. Vinyls are hidden behind a feature flag (`src/shared/features.ts`).
- **Car spec badges.** Each garage car tile shows its drivetrain code (FR, FA, MR, ...: engine position, then driven wheels) and engine layout (I4, V6, B4, ...), plus a Turbo or S/C tag. The engine (layout, aspiration, position) is declared per car in the manifest; the driven wheels come from the sim's drivetrain layout, so a badge can never disagree with the physics. The same spec drives the synthesized engine voice: cylinder count sets the firing frequency, six and up get the deeper voice, turbo adds the spool whistle and blow-off.
- **Boot splash.** A page load that lands on the menu flashes the title in over a night road (neon flicker, chromatic split, impact flash and jolt, a neon rule, shine, tagline tracking in) while the assets are checked. Behind it one 2D canvas (`src/ui/splashFx.ts`) draws the road rushing to a vanishing point, headlights streaking past and taillights pulling away with wet reflections, a skyline of twinkling windows, neon bokeh and rain, then floors it into a warp as the title flies; a few dozen strokes a frame, only while the splash is up, and none with reduced motion. The title then flies onto the menu's title block with a FLIP transform as the black fades to the city. The splash block is a copy of the menu's title block at the same column width, so it wraps the same way and the swap is invisible. Deep links (`?race=`, `?freeroam`, `?garage`, `?drone`) skip it; reduced motion gets a plain fade.
- **Music autoplay.** Every session opens on the same track ("Astrology") from the top, then shuffles; only volume, mute, shuffle and the minimized state persist. Browsers only allow audible autoplay once the user has interacted with the site, so when that is refused the opening track simply waits for the first click, tap or key press of any kind rather than running muted and being joined halfway. There is no "tap for sound" prompt: sound is on by default, and a browser that already trusts the site plays it straight away. Engine audio and crowds start on the first gesture for the same reason.
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
