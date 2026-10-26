---
name: tune
description: Change how a car drives - edit src/sim/drivingParams.json (base tuning, per-car overrides, drivetrain, the Tune tab's setup sliders) and measure the result headlessly (top speed, 0-100, grip, nitrous, gear speeds) without the browser. Use for any physics, handling, engine, gearbox, tire, drift or upgrade-balance task.
argument-hint: [carId]
allowed-tools: Bash(npx tsx .claude/skills/tune/measure.ts *), Bash(npx tsx .claude/skills/tune/drift.ts *)
---
# Tuning cars

Every number lives in `src/sim/drivingParams.json`; `src/sim/tuning.ts` only types, merges and validates it (unknown keys or wrong types throw at startup). Read the file's `_readme` first.

- `base` is a front inline 6, RWD, which no shipped car drives as is; the physics tests drive it through `baseTuning()` (tests/helpers.ts). `cars.<id>` holds absolute overrides merged key by key; arrays (`torqueCurve`, `ratios`) replace whole. `drivetrain.layout` is `rwd`, `awd` or `fwd` (`awdFrontShare` for AWD).
- `setup.<slider>.<table>[position - 1]` are the garage Tune tab's sliders (suspension, gearing, differential, brakeBalance; positions 1..5 left to right) that `applyBuild()` in `build.ts` lays over the car tuning. Position 3 is the stock car: `*Mul` tables hold 1 there and the others 0, which `tuning.ts` enforces, so stock stays bit for bit. The differential's tables add to `drivetrain.diffOpen` / `diffLock` (0 on every stock car), read by `car.ts` updateAxles.
- Geometry (wheel positions, radius) comes from `src/assets/carManifest.json`, not from here.
- A parameter's meaning and slider range is `PARAM_INFO` in `src/ui/panels/tuningPanel.ts`; a new numeric key needs an entry there.

## Loop

1. Measure first: `npx tsx .claude/skills/tune/measure.ts` (all cars) or `npx tsx .claude/skills/tune/measure.ts $ARGUMENTS`. It prints mass, drivetrain, redline speed per gear, top speed / 0-100 / grip / nitrous on the stock setup, then each slider's five positions, using the real sim (`src/sim/stats.ts`). The stock cars run their donor gearboxes with the top gear's limiter at about 1.1x the dry top speed (their slipstream top speed): Short lowers the dry top speed, Long adds headroom on nitrous and in a tow, and the Gear Ratio slider's torque bonus (`setup.gearing.torqueBonus`, an arcade term that fades out by 200 km/h) makes most of the corner exit difference. For drift, wheelspin, handbrake or traction changes also run `npx tsx .claude/skills/tune/drift.ts $ARGUMENTS`: a trace every 0.1 s of a flick held on the throttle, handbrake plus brake at speed, flooring it mid corner and a launch (slip angle, rpm, rear spin, tread speed against road speed). `docs/handling.md` explains the tire and axle model those numbers come from.
2. Edit the JSON. The PostToolUse hook re-validates the file after every edit; the typecheck cannot see JSON mistakes.
3. Measure again and compare. Then `.claude/skills/check/check.sh tests/sim.test.ts tests/build.test.ts` (position 3 must stay the stock car bit for bit, and each slider must still move the car the way its ends say). The full suite (AI balance, replay determinism) once at the end of the task, not after every tweak.
4. Changing the file changes `tuningHash`, which discards saved test-drive tuning in players' browsers and makes existing bests for that car incomparable. Mention it.

A player's in-game export (tuning panel, Copy JSON) carries a `fileOverride` block that pastes straight into `cars.<id>`.
