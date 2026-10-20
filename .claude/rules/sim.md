---
paths:
  - "src/sim/**"
  - "src/city/**"
---
# Sim and city code is pure and deterministic

- No DOM, `window`, three.js, `Math.random`, `Date`, `performance.now`, timers or frame time. Randomness only via `Rng` from `src/sim/prng.ts` (one stream per concern: `deriveSeed(seed, 'name')`); trig and sqrt through `src/sim/math.ts`.
- Same (seed, config, packed input frames) must give bit-identical state. Keep iteration order fixed, keep float operations in the same order, never branch on wall-clock time.
- Physics steps at `DT` (60 Hz) with substeps in `car.ts`; units are SI (m, s, kg, rad). `drivingParams.json` is the only place for tuning numbers.
- The tick shares the frame budget (CLAUDE.md: aim 120 fps, hold 60, floor 30): at 30 fps two ticks run per rendered frame, so keep per-tick work bounded and roughly constant per car. Time a change to the hot loop (`stepRace`, `car.ts`, `collision.ts`, `ai.ts`) headlessly with `npx tsx` before and after.
- `World` is built once per race and never mutated; per-race mutable state lives on `RaceState` (`brokenProps`, `rails`, `events`, ...).
- A behaviour change here invalidates existing replays, ghosts and bests. Add or extend a test in `tests/` that runs the scenario twice and compares `carSnapshot` / `JSON.stringify` output, over several seeds where cheap.
