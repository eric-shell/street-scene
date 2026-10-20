---
paths:
  - "tests/**"
---
# Tests (Vitest, node environment, 120 s per test)

- Build scenarios with `tests/helpers.ts`: `flatWorld()`, `raceConfig(seed, mode, opponents, perf, laps)`, `runAutopilot(cfg, seconds)`, `replayLog(cfg, log)`, `carSnapshot(race)`, `input({...})`.
- Prove determinism by running twice and comparing `JSON.stringify` / `carSnapshot`; sweep seeds with a seeded `Rng`, never `Math.random`.
- Keep new tests fast; many-seed sweeps belong in the file that already has them (`city`, `rails`, `ai`). A full AI race costs seconds.
- Iterate on one file (`npx vitest run tests/x.test.ts -t "name"`), run the full suite before finishing.
