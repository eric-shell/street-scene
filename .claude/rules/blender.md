---
paths:
  - "scripts/blender/**"
  - "assets/source/eshell/**"
  - "assets/refs/**"
---
# Blender scripts and authored cars

- Model edits (meshes, `.blend` files, donor imports) go through the Blender MCP, never headless scripts: with no `blender` MCP tools in the session (not even deferred), run `.claude/skills/blender/mcp.sh status` (`register` if it reports them missing) and ask the user to restart Claude Code before editing (`/blender`).
- Read `/blender` (`.claude/skills/blender/SKILL.md`) first: helpers live in `scripts/blender/carKit.py`, and the table of known traps lists the calls that crash Blender or corrupt exports.
- `scripts/blender/exportCar.py` is the contract between an authored `.blend` and `npm run assets` (collections `Car`, `Parts`, `Wheels`, `Rig`; part objects `<slot>_<partId>`; the sidecar `car.json`). Change both sides together: `scripts/buildAssets.ts` reads that sidecar.
- Authored cars are modelled in car space at the shared scale (`standardWheel` in `scripts/assetConfig.json`); the pipeline never rescales them, so a scale mistake ships as is. Check the wheel radius of the Rig empties and `arch_gap` before saving.
- `scripts/blender/carSpecs.json` is the reference spec (docs/carDesign.md): every target derives from the donors times the `house` scale, so change `house` once and re-audit every car (`npm run audit`). Photos and product pages live in `assets/refs/<carId>/` (`refs.json` calibration) and `assets/refs/parts/<kit>/`; the shared features are built by `carFeatures.py`, never by hand, so every car gets the same mirrors, handles, cowl and lamp layers.
- Scripts must run both through the MCP (exec'd, no `__file__`, no `sys.argv`) and in `blender -b` (args after `--`). Keep Blender API calls to ones that exist in 5.2; look shader nodes up by type, never by name.
- Every car ships a real cabin (seats, dash, floor, headliner, like the Wendt Strom, Kazama Rotor and Brandt Kombi): the donor's own, or a garage car's transplanted and fitted by `carFeatures.py` `interior()`. Never a box, and no cabin vertex outside the skin: `npm run audit` (`cabin inside the skin`) must pass before a car ships.
- Donor imports (`carDonors.py`, `carWheels.py`): weld, classify by geometry, reduce each kind to its own budget, turn revolved parts, cull hidden faces against the whole and take the shading skin after the cull, reverse faces after a mirror, and check with backface culling on. The list with reasons is `/blender`, "Donor imports".
