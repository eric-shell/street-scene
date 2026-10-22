---
name: assets
description: Car and part assets - add an authored .blend car or an FBX import, author or catalog a part (GLB in car space, shared material names, triangle budgets), run the asset pipeline and validation, inspect GLBs. Use for any task about car models, bumpers, skirts, body kits, wheels, materials, the car manifest or the parts catalog.
---
# Car assets and parts

The reference is `docs/partsAuthoring.md` (slots, car space, material names, budgets, file naming, Blender export, catalog entries, validation, dev preview, splitting kits) plus the "Car assets" section of README.md. Read the relevant section rather than guessing.

- Car space: meters, Y up, origin on the ground midway between the axles, car faces +Z, +X is the car's left. Wheels use wheel space (center at the origin, axle along X, rim face toward +X); the game scales and mirrors them per car.
- Vocabulary: `src/shared/parts.ts` (`PART_SLOTS`, `MATERIAL_NAMES`, `TRI_BUDGETS`). Files: `public/parts/<carId>_<slot>_<partId>.glb`, wheels `public/parts/wheel_<name>.glb`, cars `public/cars/<carId>.glb`.
- Catalog: `src/assets/partsCatalog.json`. Hand-written entries carry no `generated` flag; `npm run assets` rewrites only generated ones. Car geometry: `src/assets/carManifest.json` (measured by the pipeline, `provisional` until then; `selectable` lists garage cars; a car without files renders as a box placeholder; every car needs an `engine` spec: `layout`, `aspiration`, `position`, see `src/shared/carSpec.ts`).
- Sources: authored cars are `assets/source/eshell/<carId>/<carId>.blend` (Proto Hatch, Proto Coupe, Proto Wagon; the shared rims in `wheels/`), modelled in car space on the shared wheel (`standardWheel`, 0.28 m) and exported by `scripts/blender/exportCar.py`; their base GLB carries `Body`, `Bumper_Front`, `Bumper_Rear`, `Skirts`, and bumper/skirt parts hide those. Editing them is Blender work: use `/blender`. FBX imports go in `assets/source/icemaan/<folder>/` with a `cars` entry in `scripts/assetConfig.json`.
- Commands: `npm run audit -- <carId>` (a shipped car against its reference spec: proportions, lamp bands, pillars, mirrors, handles, cowl, interior, arch gaps; `/car` is the process); `npm run validate` (catalog against the files, also runs at the end of `npm run assets`); `npm run inspect -- <file.glb>` (nodes, materials, triangles, bounds); `npm run assets` (export authored .blend cars, convert and normalize FBX imports, rename materials via `scripts/assetConfig.json`, Meshopt, update manifest and catalog). Ask before running `npm run assets`: it is slow and rewrites generated files.
- Runtime: `src/render/car/carAssets.ts` loads cars and parts, `carView.ts` assembles a car from a `VisualBuild`, `carMaterials.ts` maps material names to paint, trim, glass and lights, `wheelFit.ts` resizes rims without changing the tire diameter.
- Never open `.glb` or `.fbx` files (binary, denied); use `npm run inspect` or the last report in `assets/inspect.md`.
