---
paths:
  - "src/render/**"
  - "src/game/**"
  - "src/garage/**"
  - "src/audio/**"
  - "src/ui/**"
---
# Render, UI and audio read state; they never write to the sim

- Read `RaceState`, `World` and `CarState` only; interpolate with the loop's `alpha` between the previous and current snapshots (`RaceSession`). Visuals come from `VisualBuild`, never from performance tuning.
- Frame budget (CLAUDE.md, `FRAME_BUDGET` in `render/autoQuality.ts`): aim 120 fps, hold 60, never below 30. Per-frame work scales with `dt` (`1 - Math.exp(-k * dt)` style smoothing, never a per-frame lerp factor) so every frame rate looks the same.
- Phones are a target: merge geometry (`GeoBuilder`) or instance, avoid per-frame allocations and per-object draw calls, honor the `QUALITY` profiles and `autoQuality`. A new effect gets a knob on the `QUALITY_LEVELS` ladder or a tier gate, not a fixed cost; if it cannot hold 60 at Medium it belongs in High or needs a cheaper form.
- Measure with `?fps` (fps, ms, auto level, aim) before and after, and say what a change costs per frame.
- Dispose what you create (geometries, materials, textures, audio nodes) following the `track` / `dispose()` pattern of the surrounding module; scenes are rebuilt per race.
- three.js `^0.186`: use current API names. Lucide icons via `src/ui/icons.ts`, DOM via the `src/ui/dom.ts` helpers.
- Audio and music can only start after a user gesture; that is browser policy, not a bug to fix.
- `src/render/` is grouped by what is drawn: the root keeps the frame (`scene`, `post`, `lighting`, `autoQuality`, `geoBuilder`, `vehicleMask`); `car/` (car models, parts, vinyls, sparks, nitrous trails), `camera/`, `buildings/` (architecture, facades, wall dressing), `street/` (road meshes, decals, furniture and destructible props with their debris, steam and spray, street light, the drawbridge, bus bays), `race/` (start/finish, route barriers and signs, meets, crowds, waypoint beacons), `sky/` (backdrop, weather, lightning, sky textures), `traffic/` (cars, trains, air traffic, the police helicopter), `textures/` (shared canvas textures), `districts/` (one renderer per district kind, plus their shared kits). A new module goes in the folder of what it draws; one used by a single district lives beside that district's renderer.
