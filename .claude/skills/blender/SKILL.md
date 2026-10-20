---
name: blender
description: Model cars and parts in Blender, live through the Blender MCP server or headless with `blender -b` - load the carKit helpers, import shipped GLBs, split bodies into bumpers and skirts, build tuner kits from stock parts, restyle a body, check wheel arches, look at the result, save authored .blend cars and export them. Use for any Blender or MCP modelling task, including designing new bumpers, skirts or spoilers, and read it before the first Blender MCP call.
---
# Blender for car work

Authored cars are `assets/source/eshell/<carId>/<carId>.blend` (collections `Car`, `Parts`, `Wheels`, `Rig`; the contract is the docstring of `scripts/blender/exportCar.py` and README "Car assets"). `npm run assets` exports and catalogs them; you never export GLBs by hand for an authored car.

## Every MCP call

- Nothing persists between `execute_blender_code` calls. Start each call with
  `REPO='/Users/ericshell/Repositories/street-scene'; exec(open(REPO+'/scripts/blender/carKit.py').read())`
  and use its helpers (`imp`, `bake`, `bb`, `coll`, `show`, `cut`, `split_parts`, `islands`, `material_regions`, `plane_seam`, `seam_snap`, `arch_gap`, `remap_materials`, `copy_part`, `displace`, `recolor`, `outline`, `slab`, `fin`, `boundary_seam`, `surface_z`, `delete_islands`, `projected_quad`, `surface_tree`, `mount_on_body`, `cam`, `preview`, `shading`). Add new helpers there, not inline.
- Blender space: meters, Z up, car faces **-Y**, +X is the car's left, origin on the ground between the axles. glTF car space is `(x, z, -y)` of that.
- Print numbers, look rarely: a `look` image costs far more than a printed bounds line. Use `max_size` 900 to 1100.
- `look(mode='angles')` auto frames every visible object; to judge a seam or a stance, `cam(target, direction, dist, lens)` then `look(mode='camera')`. Hide what you are not judging with `show([...])` or `preview(groups)`.
- The PreToolUse hook `.claude/hooks/check-blender-code.sh` blocks the calls below; do not work around it.

## Known traps (each cost a session)

| Trap | What happens | Do instead |
|---|---|---|
| `bpy.data.libraries.write(path, {scene})` | Crashes Blender 5.2, the user's session is gone | `bpy.ops.wm.save_as_mainfile(filepath=..., copy=True)` for a working copy, then `blender -b work.blend --python scripts/blender/saveCar.py -- <carId> <out.blend>` |
| `wm.open_mainfile`, `read_factory_settings` in the live session | Replaces the user's scene, can stop the MCP server | Headless `blender -b file.blend --python script.py` |
| `mesh.materials.clear()` | Every face's `material_index` becomes 0, the export is all Paint | `remap_materials(o)` |
| Meshopt GLBs from `public/` | Import fine, but the quantization sits in the node scale; overwriting `o.scale` shrinks or blows up the mesh | `imp()` bakes transforms on import; after that, transform with `bake(o, Matrix...)` only |
| `o.bound_box` after `mesh.transform()` | Stale until the depsgraph updates | `bb(o)` (vertex based) |
| Setting `o.location` for a side by side view, then `bake` | The offset is baked into the mesh | Lay out with `preview()` (linked duplicates), keep sources at the origin |
| Saving while `show()`/`preview()` hid the car collections | Hidden objects cannot be selected, so a `use_selection` glTF export writes the wrong objects (giant wheels, 47 validation errors) | `exportCar.py` now unhides everything and checks the selection; still call `show()` before saving a working copy |
| Two cars appended into one session | Their materials become `Paint` and `Paint.001`; a mesh left on a suffixed one exports a name validation rejects | `remap_materials` on every mesh before saving; `saveCar.py` purges the orphans |

## Recipes

- **Edit an authored car live**: append its collections without switching files: `with bpy.data.libraries.load(path, link=False) as (src, dst): dst.collections = list(src.collections)`, then link each to the scene (both cars can sit in one session). When done: `remap_materials`, `show()`, `bpy.ops.wm.save_as_mainfile(filepath=<scratch>/work.blend, copy=True)`, `saveCar.py` per car headless.
- **Load a shipped car**: `imp('public/cars/<id>.glb', '<id>')`, parts likewise.
- **Normalize scale**: every car rides on `standardWheel` (`scripts/assetConfig.json`, 0.28 m radius). Scale a body uniformly about the origin, then check `arch_gap(body, x, axle_y, 0.28)`: about 0.01 to 0.04 m is right; negative means the tire pokes through the lip (never shrink the wheel; raise the body or open the arch instead), large means drop the body with `bake(o, Matrix.Translation((0, 0, -dz)))`.
- **Split a merged body**: `material_regions(body)` and `islands(body)` to find the light lines and arches; `cut(body, planes)` with axis planes (front bumper: y < front arch edge and z < headlight bottom; rear likewise; skirts: |x| > sill, z < sill top, between the arches); `split_parts(body, ...)`. Kitbashed IceMaan meshes have about 100 islands that cross part lines, so plane cuts beat island picking.
- **New aftermarket parts**: build them from the stock piece, never from another kit (kit 1 / kit 3 donors seam snapped onto the kit 2 body looked wrong and were dropped). `copy_part(stock, '<carId>.<slot>_<partId>', '<carId>:Parts')`, then `displace(o, fn, plane_seam(...))` (moves fade to zero at the seam, so the fit stays exact), `recolor(o, pred, 'Trim')` for carbon or body colour panels, and new geometry with `outline` + `slab` (splitters, diffuser plates, skirt blades) and `fin` (canards, strakes, end plates). Pin new pieces to the part's own lowest point and silhouette; a plate under the lowest vertex of a rear bumper floats when the rear face sits higher. Keep strakes clear of the `Chrome` exhaust tips. `scripts/blender/tunerKits.py` (the Kurogane and Hayate kits) is the worked example to start from; displacements of 2 to 6 cm and plates of 2 to 10 cm read at game distance, 1 cm does not.
- **Panels cut by selection** (hood, roof): `cut` at the panel lines, `split_parts` with a box predicate (the Trim stripe and contrast roof outlined them), recolor the stock piece to Paint. Options pin to the panel's own edge with `boundary_seam(stock)`; place add-ons on the surface with `surface_z(o)(x, y)` (louvres, cowl slots, vortex generators, roof scoops). A new slot needs `PART_SLOTS`, `BODY_PART_SLOTS`, `SLOT_LABELS`, `TRI_BUDGETS` (`src/shared/parts.ts`), a share code key in `src/garage/storage.ts` and a `DEFAULT_HIDES` entry in `exportCar.py`.
- **Tame stock**: lips, splitters, strakes and integrated spoilers are their own islands; `delete_islands` them (on every roof or hood piece too when they straddle one), shrink grilles by cutting at |x| = 0.2 and recoloring the outer intake to Paint, close a bumper bottom with a black slab at the bottom edge of its *outer face* tucked 6 cm in (its lowest vertex sits further in, and a plate there floats). Stock is plain on purpose; character goes into parts.
- **Lights and grilles**: `projected_quad(o, quad_uv, 'y', +1 front / -1 rear, offset, mat, target=[body, hood, bumper])` lays a patch on the surface; a black housing at 4 mm plus a lens at 12 to 14 mm reads as a framed lamp (less offset and the housing shows through on sloped spots). Keep the lens off the hood's front edge (rays jump to the hood top; `max_jump` drops those cells). Side wraps project along x. Recolor the old light faces to Paint first. Round lamps are fans of tiny quads.
- **Reshaping a whole car** (flares): one displacement field applied to every mesh in `Car` and `Parts` keeps every seam closed; move the Rig wheels out with it.
- **Spoilers**: always `mount_on_body(sp, [Body, Roof, Hood, Bumper_Rear], dys)`; pass only the dy range you want (roof edge for hatches, trunk lid for the others) or it picks the nearest valid spot, which can block the rear glass.
- **A new car from scratch**: `scripts/blender/protoCoupe.py` lofts a body from mirrored rings over stations (every dimension is a keyframed profile), boolean cuts the arches (the cutter's inside becomes the black wheel well; `material_mode='TRANSFER'`), adds lights, grilles, mirrors, handles, exhaust and an Interior block (glass is 70 % opaque). Then the usual: cut and `split_parts` into `Body`, bumpers, `Skirts`, `Hood`, `Roof`; add its SEAMS to `tunerKits.py` and run the kit, hood and roof builders; spoilers; Rig empties. Outside Blender: a manifest entry (displayName, engine, defaultPaint, `selectable`, a universal `defaultWheel` if it has no rims), a `cars.<id>` block in `drivingParams.json` (measure with `/tune`), and the tests that list the garage cars (`tests/sim.test.ts`, `tests/carSpec.test.ts`).
- **Names**: parts are named after fictional tuners (`frontBumper_kurogane`, displayName `Kurogane`; spoilers and rims too, via the `displayName` property), never Street/Sport/Pro or numbers: no visual hierarchy. Check a new name is not a real tuner brand.
- **Restyle on the mesh**: chop a roof by compressing z above the belt line (`z = belt + (z - belt) * k`, apply the same to roof spoilers); repaint panels by bisecting at panel lines with `cut` and setting `material_index` per face center (hood stripe |x| < 0.40 Trim, roof |x| < 0.52 Trim, B-pillar faces (|x| > 0.45, 0.18 < y < 0.36, outward normals) Black on the Proto Hatch, after the Proto Compact).
- **Assemble and save**: build `<carId>:Car|Parts|Wheels|Rig` collections in the working file (object names may carry a `<carId>.` prefix; the exporter strips it), `remap_materials` on every mesh, Rig empties at `(±x, ±axle_y, 0.28)`, `Parts` in garage order with a `displayName` property. Save a copy, run `saveCar.py` headless, then `npm run assets` (ask first; it rewrites generated catalog entries).
- **Verify the shipped result** without a browser: a headless render of `public/` GLBs (car plus parts plus wheels scaled to the manifest radius; the meshopt node scale must be dropped before scaling wheels). The game itself: `/dev` garage.

## Blender

`/Applications/Blender.app/Contents/MacOS/Blender` (5.2); `npm run assets` also honors `BLENDER`. If the MCP addon reports an old protocol, `uvx mcp-for-blender install-addon`, then re-enable the addon and Start MCP Server.
