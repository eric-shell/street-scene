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
- Phones are a target: merge geometry (`GeoBuilder`) or instance, avoid per-frame allocations and per-object draw calls, honor the `QUALITY` profiles and `autoQuality`.
- Dispose what you create (geometries, materials, textures, audio nodes) following the `track` / `dispose()` pattern of the surrounding module; scenes are rebuilt per race.
- three.js `^0.186`: use current API names. Lucide icons via `src/ui/icons.ts`, DOM via the `src/ui/dom.ts` helpers.
- Audio and music can only start after a user gesture; that is browser policy, not a bug to fix.
