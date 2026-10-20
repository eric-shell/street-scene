---
name: tune
description: Change how a car drives - edit src/sim/drivingParams.json (base tuning, per-car overrides, drivetrain, performance tiers) and measure the result headlessly (top speed, 0-100, grip, nitrous, gear speeds) without the browser. Use for any physics, handling, engine, gearbox, tire, drift or upgrade-balance task.
argument-hint: [carId]
allowed-tools: Bash(npx tsx .claude/skills/tune/measure.ts *)
---
# Tuning cars

Every number lives in `src/sim/drivingParams.json`; `src/sim/tuning.ts` only types, merges and validates it (unknown keys or wrong types throw at startup). Read the file's `_readme` first.

- `base` is the Proto Compact (`s64`). `cars.<id>` holds absolute overrides merged key by key; arrays (`torqueCurve`, `ratios`) replace whole. `drivetrain.layout` is `rwd`, `awd` or `fwd` (`awdFrontShare` for AWD).
- `performanceParts.<category>[tier]` are the garage upgrades (0 stock, 1 street, 2 pro, 3 extreme) that `applyBuild()` in `build.ts` lays over the car tuning. Categories: engine, turbo, exhaust, transmission, tires, suspension, brakes, weight, nitrous.
- Geometry (wheel positions, radius) comes from `src/assets/carManifest.json`, not from here.
- A parameter's meaning and slider range is `PARAM_INFO` in `src/ui/tuningPanel.ts`; a new numeric key needs an entry there.

## Loop

1. Measure first: `npx tsx .claude/skills/tune/measure.ts` (all cars) or `npx tsx .claude/skills/tune/measure.ts $ARGUMENTS`. It prints mass, drivetrain, redline speed per gear, and top speed / 0-100 / grip / nitrous for every performance tier, using the real sim (`src/sim/stats.ts`).
2. Edit the JSON. The PostToolUse hook re-validates the file after every edit; the typecheck cannot see JSON mistakes.
3. Measure again and compare. Then `.claude/skills/check/check.sh tests/sim.test.ts tests/build.test.ts` (upgrades must still improve 0-100 and top speed and cover more ground), then the full suite (AI balance, replay determinism).
4. Changing the file changes `tuningHash`, which discards saved test-drive tuning in players' browsers and makes existing bests for that car incomparable. Mention it.

A player's in-game export (tuning panel, Copy JSON) carries a `fileOverride` block that pastes straight into `cars.<id>`.
