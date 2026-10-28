---
name: car
description: Add or improve a car model from reference vehicles - the donor blend and house proportions (scripts/blender/carSpecs.json), the headless audit (npm run audit), reference photos and product pages in assets/refs, Blender comparison sheets and spec checks, the shared feature builders (pillars, glass, mirrors, handles, cowl, lamps, interior) and reference-driven aftermarket kits. Use for any task about a car's shape, proportions, lights, pillars, mirrors, details, a new car or a body kit; read it before /blender for modelling work.
argument-hint: [carId]
allowed-tools: Bash(npm run audit *)
---
# A car (or a kit) from references

The numbers and rules are `docs/carDesign.md`; read it first, then this checklist. `$ARGUMENTS` is the car id (`wendtFairway`, `kazamaRotor`, `brandtKombi`, `ridgewayFiend`, or a new one: ids are `<fictional maker><Model>`, e.g. `wendtFairway`, and display names fictional maker + model, never the donor's trademarks). Blender mechanics (helpers, traps, saving) are `/blender`; the asset pipeline is `/assets`.

## 1. Gather context (no Blender yet)

1. `npm run audit -- $ARGUMENTS`: the brief, the donor blend, every station, the feature checklist and the **off spec** list. This is the baseline; keep it for the commit body.
2. Read every photo in `assets/refs/$ARGUMENTS/` (the Read tool shows images). One pass per feature: lamps, grille, belt line against the wheel, pillars and glass, mirror, handles, cowl, flares, tail. Write what you see in a few lines before modelling; that is the context that makes the model match.
3. For a kit: read `assets/refs/parts/<kit>/notes.md` and its photos. No notes file: ask for product pages or photos (they are cheap for the user and save a session), or write the notes first from what you know and say so.
4. If the brief changed (new donors, weights, what to take, lamp signature), edit `scripts/blender/carSpecs.json`. Calibrate a side photo (`wheels_px`, `extent_px`, `roof_px`, `ground_px`) and run `spec_from_refs` in Blender later; estimates are marked in the spec and must not drive a 10 cm change on their own.

## 2. In Blender (through the MCP)

Model edits go through the Blender MCP only (`/blender`): with no `blender` MCP tools in the session (not even deferred), run `.claude/skills/blender/mcp.sh status` (`register` if it reports them missing) and ask the user to restart Claude Code first.

Every call: `exec` carKit.py, then carRefs.py, then carFeatures.py (`/blender`, "Every MCP call"). Append the car's collections (`/blender`, "Edit an authored car live"); a new car starts from `kazamaRotor.py` (loft from profiles) with its own `cid`.

5. `load_refs(cid)` then `ortho_sheet(cid, OUT)`; Read the PNGs. `spec_check(cid)` for the live table. Numbers first, pictures to confirm; one `look` is worth less than one printed line.
6. **Shape** before details: proportions (length, width, overhangs, height), glass rakes, the belt line. Coupe: edit the `PROFILE` keyframes and rebuild. Kitbashed cars: `displace` fields pinned with `plane_seam`, or `bake` with a matrix for whole moves; apply the same field to every Car and Parts mesh so seams stay closed (flares, chops). Re-run `spec_check` after each change.
7. **Features**: `apply_features(cid)` builds pillars, mirrors, handles, cowl, interior, lamps (front and rear by signature) and exhaust tips from the house numbers; or call the builders one by one. Try a signature with `lamps(cid, m, 'front', cover='slab')` before changing the spec. Each builder strips its old work, so iterate freely; if one misfires, fix the helper in `carFeatures.py`, not inline.
8. **Kits**: a style in `tunerKits.py` per family, built from the stock pieces (`copy_part`, `displace`, `recolor`, `outline`, `slab`, `fin`), sized from the kit notes and the table in `docs/carDesign.md` section 4, anchored to the car's own edges. No typed coordinates, no boxes that do not touch the car.
9. `measure(cid)` again: mirrors 2, handles = doors, cowl, interior, indicators, lamp heights in band, arch gaps 0.01 to 0.04.
   **Cabin**: the donor's own, or `interior(cid, m)` transplanting a garage car's (set `cabin` `seats` and `rhd` in the car's spec, and append the source car's collections to the file); never a block. `spec_check` must show `cabin inside the skin` ok, then one look at the cabin alone and through the side glass (`docs/carDesign.md`, Interior). Then a last `ortho_sheet` and one `look(mode='angles')`.

## 3. Ship and verify

10. `remap_materials` on every mesh, `show()`, save a working copy, `saveCar.py` headless (`/blender`, "Assemble and save").
11. `npm run assets` (ask first: slow, rewrites generated files), `npm run validate`, `npm run audit -- $ARGUMENTS`: the off spec list should be shorter than the baseline; say what is still off and why (house style, donor estimate, left for later).
12. A changed manifest (wheelbase, track, dimensions) changes the sim: say that replays, ghosts and bests for the car are invalid. New car: manifest entry, `cars.<id>` in `drivingParams.json` (`/tune`), the car lists in `tests/sim.test.ts` and `tests/carSpec.test.ts`, then the full suite once. Shape and detail work on an existing car needs no tests (CLAUDE.md, Checks).
13. `/dev` garage for a real look; the README decisions log gets a line when the brief or the house style changed.

## New feature kinds

A new shared feature (roof rails, a side gill, a fuel door) is a house entry in `carSpecs.json`, a builder in `carFeatures.py` that strips its old work and pins to stations, a row in `auditCar.ts` and `carRefs.py` `checks` so every car is measured for it, and a paragraph in `docs/carDesign.md` section 2. Wheels have their own process (`docs/carWheels.md`, `/blender` "Donor imports"); do not fold them in here. A body from a donor model (`docs/carDonors.md`) already carries the donor's own mirrors, handles, lamps and cabin: run `apply_features` only for what the audit still lists as missing.
