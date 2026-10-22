---
name: district
description: Add or change a city district kind (parks, alleys, river, subway, roundabouts, infill, or a new one) - the paired sim module and renderer, registries, config, wall looks and the tests that enforce them. Use for any task about city areas, special blocks, drivable features or the minimap's area colors.
---
# Districts

A district kind is two files plus registrations. Read `src/city/districts/types.ts` first: its header explains the plan/build lifecycle and the collision rule, and it holds the whole vocabulary (`Area`, `AreaBuild`, `WallLook`, `Surface`, `PlanContext`, `BuildContext`). Then copy the closest existing pair:

| Kind | Shows how to |
|---|---|
| `park` | claim whole block faces, add a terrain height modifier with exact gradients, solid props as walls (trees) |
| `alley` / `backAlley` | edit the road graph (narrow streets, new shortcut edges) and call `ctx.graphChanged()` |
| `river` | a linear area with a path, bridges, several wall looks, surfaces at different priorities |
| `roundabout` | claim nodes, replace an intersection with a ring and a solid island |
| `infill` | a `late` phase module that fills leftover frontage after buildings exist |

## Checklist

1. Config: `CITY.districts.<kind>` in `src/city/config.ts` with `enabled`, chance/count and every size in meters. `plan` returns early when `!CFG.enabled`.
2. Sim module `src/city/districts/<kind>.ts` exporting a `DistrictModule` `{ kind, phase: 'graph' | 'late', plan(ctx), build(ctx, area) }`.
   - `plan`: claim through `ctx.addArea(...)`, respect `ctx.claims` and `ctx.budget`, use only `ctx.rng`. Graph edits must happen before any face is claimed and end with `ctx.graphChanged()`.
   - `build`: start from `emptyBuild()` and push walls (each with a `look` and `area`), surfaces (with a priority), height mods (exact gradient, fading to 0 at the box edge), exclusions, openings, reserved circles, props and hints for the renderer.
   - A kind that outgrows one file keeps its `DistrictModule` in `<kind>.ts` and moves helpers to `<kind><Part>.ts` beside it, importing one way only (the alleys: `alleyPath` ← `alleyDressing`, `alleyShortcuts` ← `alley`). Shared geometry lives in `geom.ts`.
   - Register in `DISTRICT_MODULES` (`index.ts`) at the right spot: the order is fixed and `backAlley` is the last module allowed to change graph topology. Add the kind to `AreaKind` and `AREA_MAP_STYLE` (types.ts) and `AREA_PRIORITY` (index.ts).
3. Walls are one sided (normal toward the drivable side) and push cars back up to 3 m, so two drivable spaces need about 4 m of solid body between them. A new look goes in `WallLook` and `WALL_LOOKS`; a new ground type in `Surface` and `SURFACE_PHYSICS`.
4. Renderer `src/render/districts/<kind>.ts` exporting a `DistrictRenderer` `{ kinds, build(kit, areas), update?(time) }`. Append into the kit's merged builders (`ground`, `solid`, `paint`, `glow`, `foliage`; helpers in `kit.ts`) so the whole city stays a handful of draw calls; instanced or animated objects go in `kit.group` and disposables through `kit.track`. Walls of a look come from `kit.walls.get(look)`, area data from `kit.builds[area.id]`. Register in `DISTRICT_RENDERERS`.
5. Tests: the `districts` block of `tests/city.test.ts` checks determinism, downtown's share, that every wall matches visible geometry and never stands on a road, drivable surfaces with exact slopes, and routes around islands and alleys. Run `.claude/skills/check/check.sh tests/city.test.ts` while iterating; the full suite once at the end, and only if the city's walls or routes changed (`rails` and `ai` drive many seeds through it).
6. Look at a seed without the browser: `npx tsx scripts/debugCitySvg.ts <seed> out.svg` draws roads, buildings, walls and both routes.
