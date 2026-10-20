---
paths:
  - "scripts/blender/**"
  - "assets/source/eshell/**"
---
# Blender scripts and authored cars

- Read `/blender` (`.claude/skills/blender/SKILL.md`) first: helpers live in `scripts/blender/carKit.py`, and the table of known traps lists the calls that crash Blender or corrupt exports.
- `scripts/blender/exportCar.py` is the contract between an authored `.blend` and `npm run assets` (collections `Car`, `Parts`, `Wheels`, `Rig`; part objects `<slot>_<partId>`; the sidecar `car.json`). Change both sides together: `scripts/buildAssets.ts` reads that sidecar.
- Authored cars are modelled in car space at the shared scale (`standardWheel` in `scripts/assetConfig.json`); the pipeline never rescales them, so a scale mistake ships as is. Check the wheel radius of the Rig empties and `arch_gap` before saving.
- Scripts must run both through the MCP (exec'd, no `__file__`, no `sys.argv`) and in `blender -b` (args after `--`). Keep Blender API calls to ones that exist in 5.2; look shader nodes up by type, never by name.
