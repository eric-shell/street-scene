# Weekend specials

Saturdays and Sundays are the busiest days, so every weekend's daily seed carries one **weekend special**: a large drivable set-piece district on top of the city the seed already makes. There are three, one per weekend day in rotation:

| Kind | Name | What it is |
|---|---|---|
| `railYard` | The Rail Yard | A freight yard across one or two blocks: strings of stopped railcars between fenced sidings, rust and ballast underfoot. |
| `underground` | The Underground | A sunken concrete trench with retaining walls, a ramp down and a ramp back up, lit by strip lamps. |
| `scrapyard` | The Scrapyard | A walled lot of crushed cars stacked in rows and a crusher, oil-black ground, a clear line and a riskier one through the stacks. |

Code: `src/city/weekend.ts` (the pick), `src/city/districts/weekendSites.ts` (site finder), `src/city/districts/<kind>.ts` and `src/render/districts/<kind>.ts` (each area's planner and renderer). The menu's event card shows a "Weekend special" chip and the special's tagline when `world.event.special` is set.

## How the kind is chosen

The daily seed is the UTC date as `YYYYMMDD` (`src/seed.ts`), and `seedFromString` returns a 1-9 digit string as that number. `weekendOf(seed)` reads the date back out of the digits with a days-from-civil formula (no `Date`): it is null unless the seed is exactly eight digits, a valid calendar date (leap years right), in 2025-2099, on a Saturday or Sunday. The sim never reads the clock, so a Saturday link opened on a Tuesday rebuilds the Saturday city and a replay (which carries only the seed) rebuilds the world it was recorded in. A random 8-digit menu seed reads as a weekend date about 0.03% of the time and gets a special too; that is accepted.

`ordinal` counts weekend days since Saturday 2026-01-03 (Saturday 0, its Sunday 1, the next Saturday 2, ...; negative before it), and `kind = WEEKEND_FEATURES[ordinal mod 3]`. A Saturday and its Sunday therefore differ, and the cycle takes a day and a half.

Weekday seeds are untouched bit for bit: the weekend modules return at once unless `ctx.weekend?.kind` is theirs, and each module draws only from its own stream.

### Test dates

`weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 8)`:

| Seed | Day | Ordinal | Kind |
|---|---|---|---|
| 20261031 | Sat | 86 | scrapyard |
| 20261101 | Sun | 87 | railYard |
| 20261107 | Sat | 88 | underground |
| 20261108 | Sun | 89 | scrapyard |
| 20261114 | Sat | 90 | railYard |
| 20261115 | Sun | 91 | underground |
| 20261121 | Sat | 92 | scrapyard |
| 20261122 | Sun | 93 | railYard |

Open one in the dev server: `npm run dev`, then `http://localhost:5175/?seed=20261031` (add `&race=...` and the other URL params per `/dev`).

## The slot in the registry

`DISTRICT_MODULES` (`src/city/districts/index.ts`) runs `railYardModule`, `undergroundModule`, `scrapyardModule` right after `backAlleyModule` and before `marketModule`. They plan after the topology hook, so they see both routes as `ctx.event.routes`, and they get first pick of the blocks along the routes, ahead of the night market, the car park's block claim, the lake's merged block and the lots. `PlanContext.weekend` carries the pick for every module; `City.weekend` / `World.weekend` expose it (null on a weekday).

`CityEvent.special` (`{ kind, name, tagline }`) is filled by `resolveEvent` only when the seed is a weekend date **and** an area of that kind was planned, so the menu never promises a special the city lacks. Until a worker's module plans its area it stays undefined (`tests/weekend.test.ts` asserts that; each worker flips that assertion for its kind).

## Sites: `routeFrontageSites`

`routeFrontageSites(ctx, { minFrontage, blocks: 1 | 2, keepOffStartFinish? })` returns candidate block faces, best first: unclaimed plain blocks (no claimed, bridge, shortcut or level-crossing edge, no roundabout corner, clear of the El, highway, channel, slopes and bluffs, off the held car park polygons) that share an edge with a street a route drives, away from each route's start and finish by `keepOffStartFinish` m along the route (default 150) and off the start straights. Each site lists its route edges (which routes, frontage length, the stretch clear of junction closures), the total frontage, the side of the route's travel the block lies on, whether the ring is convex and, with `blocks: 2`, neighbours across a plain street (`along` the same route street or `cross`). Order: frontage on every route, then longer frontage, then nearer the start gantry. The module header of `weekendSites.ts` has the full rules. `openFrontage(build, ring)` is the shared form of what the parks do to open a block (`openings` plus `exclusions`).

## The corridor rule

In a race a car more than `LOST.lateral` (60 m, `src/sim/race.ts`) from the route corridor for 5 s is reset, and at 160 m at once. A route's car parks and a harbor's quay cut have their own exemptions (`onCarPark`, `onQuayCut`; unchanged). The weekend kinds are in `CORRIDOR_AREAS` (`src/city/districts/types.ts`): while a car is inside such an area's polygon `updateLost` counts it as on the corridor (the lost timer only runs down). The check runs only on weekend seeds (`World.weekend`), so a weekday tick does no extra work. The polygon must cover every drivable part of the set piece.

## What a feature worker owns

- `src/city/districts/<kind>.ts`: `plan` (pick a site with `routeFrontageSites`, check the budget, claim faces and edges, `ctx.addArea`) and `build` (walls with the looks below, surfaces, height mods, openings, destructibles, hints).
- `src/render/districts/<kind>.ts`: the renderer for those looks and hints. Every wall look needs a renderer, so the looks added for the three are `railcar` (a stopped freight car's side), `yardFence`, `trenchWall` (the trench's retaining wall), `carStack` (crushed cars stacked), `scrapFence`, `crusher`.
- `CITY.districts.<kind>` in `src/city/config.ts` (the plumbing added `{ enabled: true }`; fill the sizes).
- A test `tests/<kind>.test.ts` (and the flip of the `event.special` assertion in `tests/weekend.test.ts` for the kind).
- Not theirs: `weekend.ts`, the shared files (`types.ts`, `index.ts`, the render registry), the menu.

Walls need a drawn look and must be at least ~4 m apart where two drivable spaces separate (`types.ts` header). Any change to what a weekend seed plans changes that seed's replays and bests; weekday seeds are unaffected.

## The Underground (`underground.ts`, `undergroundShape.ts`, `render/districts/underground.ts`)

A route street sunk into a lit concrete trench for two blocks, its old street level kept as service roads either side. Tests: `tests/underground.test.ts`; sizes: `CITY.districts.underground`.

- **Where.** The carve step (`undergroundModule.carve`, before anything plans) picks a plain interior run of three grid junctions A - M - B (a row or a column, two streets, a cross street at each end and one at M), deletes the cross street at M, moves M onto the chord of A and B, straightens both halves and makes M a pass-through bend node: the run is one straight street the trench's frame stands on exactly. Its two pieces carry `RoadEdge.trench` (no start grid, finish line or circuit start on them); the area claims A, M, B, the other junctions on the four blocks' rings (no roundabout takes a corner) and both pieces. Each candidate is tried on a copy first: the channel's plan on the edited copy (`lake.ts channelWithout`) must keep off the run, and the run stays 105 m from the channel's centreline (the channel straightens the streets of its two bank rows). The area claims the two merged blocks in its own slot, right after the routes (the night market's width-only `graphChanged` tolerates a weekend special's face claim).
- **Routes.** `undergroundPreference` (world.ts `planRoads`) rates a route that drives the run above any other, anchors both ends and weighs its pieces at 0.45; on a sprint the run keeps off the start grid and 262 m clear of the finish. `undergroundKeepOut` holds the two blocks against the route shortcuts and the car parks. `driven0` / `driven1` in the area params say whether the circuit and the sprint drive it.
- **Profile.** One height modifier (`undergroundHeight`, exact gradient): the floor `depth` (5 m) under grade between the ramp feet, 62 m ramps with quadratic lips at both ends (10.8% at the steepest), the climb to grade inside the plinth over 1.6 m, the rubble's widened climb under the demolished window, the kicker's wedge. The floor's width is the street's; the plinth (a solid per 12 m, floor face = retaining wall, kerb 0.7 m over grade, `Wall.top` set by `settleUnderground` so a car above it flies over) stands on the curb line; the service roads (7 m of asphalt) run on the old sidewalk and the frontage opened behind it, with a one sided hoarding wall along their outer edge.
- **Lines.** The floor with the stalled bus (a solid hugging a wall) and its barrels and cones; the service roads with works vehicles (solids) along the hoarding; the demolished section (30 m of plinth gone, a 4 m rubble run for the 5 m drop, fence panels along its lip with a gap, `D.gap`); the kicker (a 28% grade to a 2.2 m lip, aimed off the street's axis so the 40 m/s throw lands mid far service road, pointed flank barriers; at 40 m/s it throws 11 m/s up onto the far service road, 36 m/s is the least that clears the kerb). The vehicles keep off the kicker's landing stretch.
- **Not here.** Bank, drift zone. The AI drives the route line on the floor; rivals on the service roads are a later pass. No ceiling is registered with the camera: the lowest overhead part (the footbridge decks) stands 5.2 m over the service roads.

## The rubric every area meets

- Three lines through it: a fast one, a short but risky one, and a safe one.
- A jump.
- A banked curve.
- An elevation change.
- A destructible field on the risky line.
- A drift zone on the open ground (`sim/driftZones.ts`).
- Lines are read by light and surface, never by signs or floor arrows (no signposting shortcuts).
- Scale for v1: one to two blocks.

## The Scrapyard (built)

`scrapyard.ts` (build), `scrapyardPlan.ts` (site and fit), `scrapyardLayout.ts` (the pure layout every reader shares), `scrapyardGates.ts` (the press), `banking.ts` (the bowl shape, reusable) and `render/districts/scrapyard.ts` + `scrapyardTextures.ts`. Sizes are in `CITY.districts.scrapyard` with units.

**Site and claims.** `routeFrontageSites(ctx, { blocks: 1, minFrontage: 70 })`, convex blocks first; for each, the bowls' crest radius is tried 22, 19, 16 m and the first rectangle that fits (the bowls, the pit lane and the canyon, `perimeter` = 6 m clear of the fence all round) wins; no fit, no yard. The area claims the block's face (hills, parks and downtown keep off it), its corner nodes and the route streets of the block (the night market and the lane closures keep off that street, and nothing narrows the ring the fence follows). Claiming a face in the weekend slot needed one change to the shared `graphChanged` guard in `districts/index.ts`: the market planned right after narrows route streets (widths only) and called `graphChanged`, which threw once any face was claimed; it now tolerates the claims of `CORRIDOR_AREAS` kinds (a width edit moves no face id, and the market skips claimed nodes and edges). The other weekend kinds get the same.

**The ground.** The whole block ring is the yard (a dirt `offroad` patch, buildings and frontage opened), a corrugated fence on the ring (solid both sides) with two or three curb cuts onto the route streets (`mouthBay`, the lot's recipe) and a solid gate post each side. The layout is a rectangle `L x D` in a frame `u, w` (mirrored in `u` by the stream):

- `w` from 0 to `S = 2 rimR`: the two banked bowls, rims tangent at the neck (`banking.ts`: floor 1 m under grade, bank rising 1.5 m over 5.5 m, rim falling back to grade over 4 m; every mod fades to 0 at its box and the test compares the numeric slope with the analytic gradient). A ring of five stacks stands in each bowl's middle, so each is a ring road. The stadium round both is the drift zone (`DriftZoneKind` `scrap`).
- The pit lane just behind the bowls: the pit (a 1 m dip, 8 m long), the crusher's body beside it with its conveyor on two solid legs, the magnet crane further along (render only above its solid base: the magnet swings as a pure function of the scene clock).
- The back canyon runs along `w` from the pit lane to the back lane (not along the back as first written: it is the run-up that makes the jump), two walls of stacks each two deep, a 5 m aisle, tyre stacks, drums and crates staggered down it. It stands 0.4 rims off the neck so the jump lands on the far bowl's bank. Its front end is the kicker (the channel's `table` rise: 1.15 m over 4.6 m, 29% at the lip, eased at the foot, the stacks as its solid sides, a gentle fall past the lip: a steep drop pushed the car off the lip at twice its speed), then the pit. Measured with the sim, speed at the lip: 9 m/s drops into the pit and climbs out, 12 m/s just clears it, 15 m/s lands on the far rim, 17 to 20 on its bank, 22 and up over the bank onto the floor.
- Double rows of stacks with 6.5 m aisles either side of the canyon fill the rest; four floodlight towers stand at the rectangle's corners (additive pools of light on the ground).

**Lines.** The eight (fast, banked, drift refill), the canyon (short, blind, the press and the jump), the perimeter aisle round the yard (longest, safe, the crane and crusher beside it).

**The press.** A timed gate (`sim/gates.ts`, look `crusher`, `World.timedGates` after the level crossings) across the canyon 6 m past the kicker's foot: 18 s cycle, lamps for 2 s, lowering 0.6 s, down 5.4 s, up 1.2 s (blocks one third of the cycle), phase drawn from `deriveSeed(seed, 'scrapyard:crusher')`. One sided like every gate: it holds a car coming down the canyon. The renderer poses the ram from the same cycle at the interpolated sim tick.

**Props.** `tyreStack` (radius 0.5, mass 60, breakSpeed 0.3): four tyres, rolls apart when hit. Drums, crates, pallets, a cable spool and trash bags are the existing kinds.

Rivals follow the route street (accepted for v1); progress inside the yard comes from the corridor rule.
## The Rail Yard (built)

`src/city/districts/railYard.ts` (plan, build, `settleRailYard`), with `railYardFrame.ts` (the rectangle fitted in a block), `railYardLayout.ts` (tracks, consists, clutter: a pure function of the area params and a seeded stream), `railYardShapes.ts` (the ridge and the dock as height mods) and `banking.ts` (a reusable banked arc with an exact gradient). Sizes: `CITY.districts.railYard`. Renderer: `src/render/districts/railYard.ts` and `railYardCars.ts`, car sides in `render/textures/yardTextures.ts`.

- **Site.** The best `routeFrontageSites` block with a neighbour down the same route street: the next block along it is found by `continuingEdge` (the same street straight through the cross street's junction), because `FrontageSite.along` only holds for pieces of one chain and a chain ends at every junction, so it is practically never true. Else one block of its own. A rectangle is fitted in each block, growing away from the cross street, 66 to 88 m deep and 96 to 150 m long; about one seed in twenty has no site and gets no special. The area owns no edge (the street keeps its crown and humps); the frontage edges are claimed through `ctx.claims.edge` only. The area's polygon is the hull of the rectangles.
- **Lines.** Fast: the apron behind the gates and the lead track beside the street (a drift zone: `driftZoneKind` gives the area 'yard', its zone the `apron` hint). Risky: the back aisles behind the consists, strewn with pallets, drums, tie stacks (`crate`), cable spools and sandbags. Elevated: the dock along the back, 1.1 m up, a ramp (10%) at each end, a hard edge on its face. Every consist is one solid body of look `railcar`, runs of two to five cars with 8 to 14 m gaps; tracks are 8 m apart (7.2 at the least in a shallow block), six to eight of them.
- **The dock face** is a thin solid `yardFence` with `Wall.top` set by `settleRailYard` (the ground in front plus half the dock's height): a car on the ground is stopped, a car up on the platform drops off it. Without `top` the platform would have no edge to drop from, and a one sided wall's 3 m band would shove cars on the ramps off; solids avoid that.
- **The jump** is a ridge 2 m high across every track, 12% run-up (the channel table's eased foot) and a clear landing; **the bank** is the half circle round the end of the tracks, its outer 5 m rising to 1.2 m, a crash barrier on the crest (`banking.ts`). With two blocks the ridge is at the first block's far end and the bank at the second's; a single block carries both.
- **Shared files touched:** `config.ts` (the `railYard` block), `world.ts` (one `settleRailYard` call), `index.ts` (`graphChanged` only throws after face claims when it renumbers: the night market narrows streets after a weekend special has claimed its blocks, which keeps every face id), `sim/driftZones.ts` and `render/districts/driftZones.ts` (the `yard` kind).
- **Not built:** the switcher loco shuttling the lead track across the street's level crossing (a body on `RaceState` like the cable car, two timed gates): it touches `race.ts`'s tick, the AI and audio, which is more than the district itself. The lead track is clear for it.
