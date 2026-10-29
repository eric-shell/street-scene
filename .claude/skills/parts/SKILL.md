---
name: parts
description: Body panel customization - split an imported car into its stock pieces (Bumper_Front, Bumper_Rear, Skirts, Hood, Roof) along the car's own shut lines, make aftermarket parts from those pieces (a marker delete, a lip, a kit), save, export, verify in the game, and log what was learned. Use for any task about a car's bumpers, skirts, hood, roof, spoilers, side markers, badges, a "Stock" vs a named part, or the parts catalog; read it before /blender for that work.
argument-hint: [carId] [slot]
---
# Body panels: stock pieces and parts

What a part is in this game: the base GLB (`public/cars/<carId>.glb`) carries `Body` plus the stock pieces a slot can replace, one node each; a part (`public/parts/<carId>_<slot>_<partId>.glb`) hides its stock node and draws itself in its place. The garage lists the stock node as **Stock** and every part by its `displayName`. So "Stock" is never a part file: it is the piece left in the `Car` collection, and the very first job on any car is cutting it free of the body. Contract and vocabulary: `docs/partsAuthoring.md`, `scripts/blender/exportCar.py`, `src/shared/parts.ts`. Blender mechanics and traps: `/blender`. Kits from product references: `/car` and `docs/carDesign.md` section 4.

## 1. Baseline for an imported car

Every donor import (`docs/carDonors.md`) arrives as one `Body`. Before any aftermarket part, the car gets its baseline split, in this order, each piece checked before the next:

| Piece | Where it parts from the body | Stays with the body |
|---|---|---|
| `Bumper_Front` | the car's own shut line under the grille and lamps, round the corner, along the side to the front arch | lamps and their covers, the wheel well's front wall (`Black`, normal +y) and liners |
| `Bumper_Rear` | the shut line under the tail lamps, round to the rear arch | tail lamps, exhaust tips (`Chrome`), the well's rear wall |
| `Skirts` | the sill between the arches, outside the floor, below the door's lower edge | the doors, the floor |
| `Hood`, `Roof` | panel lines (optional: only when a car will get hood or roof parts) | cowl, glass |

Rules the first split (the Wendt Strom's front bumper, 2026-10-29) settled:

- **Cut where the car is already cut.** A donor body models its panel gaps as grooves; find them with `groove_z(body, (x, y), direction, z0, z1)` (carKit.py) at several stations and read the seam off the numbers (front: rays along +y at |x| 0, 0.3, 0.5, 0.65; corner: radial rays round the bumper's corner; side: rays along -x at several y). The groove depth tells you it is a shut line (3 to 40 mm) and not a crease (under 2 mm). Never cut at a round height picked from a picture; a seam 1 cm off the groove leaves a sliver of the real one on the wrong piece.
- **Bisect first, then move faces.** `cut(body, planes)` with each plane limited by a `within` predicate to the band it should slice (a plane is infinite), then `split_off(body, '<carId>.Bumper_Front', pred)`. The predicate is geometric (below the seam height for that station, ahead of the arch opening's front edge, measured per height with rays) plus material exceptions for what stays. `split_parts` is the older helper for authored bodies; `split_off` is the one for donors because it carries the authored normals (next rule).
- **Keep the shading.** Donor bodies carry the source's normals (`authored_normals`); a bmesh round trip drops them and the exporter would reshade both halves from the reduced geometry, which shows every collapse sliver. `split_off` stashes them in a `src_normal` corner attribute and sets them back on both halves. Any later bmesh edit on a piece must do the same (`patch_out` in carDonors.py already reads `src_normal` when it is there).
- **Budgets follow the donor, not the other way round.** A whole donor bumper with its intakes and lip is 3,000 to 3,500 triangles; raise `TRI_BUDGETS` (`src/shared/parts.ts`) and the table in `docs/partsAuthoring.md` rather than decimate a stock piece (decimating only the bumper makes it shade differently from the body beside it). `CAR_BYTES_BUDGET` (`scripts/validateParts.ts`, car plus parts) is a warning; a donor car with authored normals is over it already.
- **Record the seam** in the table below as soon as it is cut. `tunerKits.py` `SEAMS` pins kit displacements to these numbers, so a kit built on a typed guess will not meet the body.

## 2. A part from a stock piece

1. `copy_part('<carId>.Bumper_Front', '<carId>.frontBumper_<partId>', '<carId>:Parts')`, then `o['displayName'] = '<Name>'`. Names are fictional tuners or plain descriptions of what the part is (Euro, Kurogane), never grades or numbers (memory: part names).
2. Edit on the copy only, and copy the nearest part rather than stock when the new one is a variant of it (Euro w/ Fogs is the Euro plus lamps): a removed feature is pressed flush (`patch_out(o, lo, hi, flush=True, ring=0.05)` fits the panel round it and moves the recess onto it), a reshaped lip is a `displace` pinned to the seam (`plane_seam`), new geometry is `outline` + `slab` + `fin`, a lip or blade along the bumper's bottom edge is `lower_edge` + `sweep` (lessons, Cupra R), a round lamp is `round_lamp(o, center, normal, r_lens, r_bezel)`; new geometry goes between `stash_normals(o)` and `restore_normals(o)` (center from a ray onto the panel behind it; size and placement as fractions of the opening read off the user's photos). Lit lamps take `HeadLight` (white), `TailLight` or `BrakeLight`, the only materials that glow (`docs/partsAuthoring.md` section 3). Delete faces only for things lying on the surface (`delete_faces`, `delete_islands`); a hole in a stock piece is never left open.
3. After a press, blend the pressed corners' normals from the ring of authored normals round the box (inverse-cube weights worked; the fitted quadratic's own normals read a shade lighter than the panel in the viewport). Carry custom normals through every bmesh step as in section 1.
4. Look twice: the piece alone in `preview([[name]])` with `cam` close on the edit, and the piece on the car (both halves visible) from the three-quarter the garage uses. Print the triangle count and the materials; a part that lost a material slot (the markers' `Light`) is right, one that gained `Paint.001` is not (`remap_materials`).

## 3. Save, export, verify

1. `remap_materials` on every mesh of the car, delete the `preview` collection, `show()`, unhide the pieces (`o.hide_set(False)`: `show` toggles collections, not objects), save a working copy with `bpy.ops.wm.save_as_mainfile(filepath=<scratch>/work.blend, copy=True)`, then headless `blender -b work.blend --python scripts/blender/saveCar.py -- <carId> assets/source/eshell/<carId>/<carId>.blend`.
2. `npm run assets` (ask first: it rewrites generated catalog entries and can touch other cars' GLBs when their export is not byte stable) and `npm run validate`. Read the catalog entry it wrote (`hides`, `materialSlots`, `tris`) and `npm run inspect` on the part and the car: the piece's bounds should sit inside the body's, and the body's own bounds should shrink by the piece.
3. `/dev` garage, Body tab, the slot's list: Stock and the part, switched a few times, from the garage's own camera. The seam against the body is the thing to judge; a visible line means the cut missed the groove or the normals were lost.
4. Commit: the `.blend`, both GLBs, the catalog, `assets/inspect.md`, and any budget change, with the seam numbers in the body.

## 4. Seams per car (Blender space, m)

| Car | Front shut line | Front arch edge (z → y) | Rear | Skirts |
|---|---|---|---|---|
| wendtStrom | z 0.584 under the grille (|x| < 0.42), 0.568 under the lamps to 40° round the corner, 0.594 along the side; corner plane through (±0.618, −1.960, 0.568) and (±0.728, −1.889, 0.594) | 0.25 → −1.645, 0.4 → −1.615, 0.5 → −1.565, 0.6 → −1.50 | not cut yet | not cut yet |
| kazamaRotor, albrechtKombi | `tunerKits.py` SEAMS (typed when the bodies were authored; re-measure with `groove_z` before the next kit) | | | |

## 5. Keep this skill honest

This file is the memory of the parts process; the first split took a whole session to find what is written above, and the next car should take an hour. After every part job, before the commit:

- **Lessons** go in the list below, one line each, dated, with the car: what read wrong, what fixed it, which helper now does it. When a lesson changes the process, move it up into sections 1 to 3 and delete the line.
- **Helpers, not inline code.** Anything typed twice in `execute_blender_code` becomes a function in `carKit.py` (geometry) or `carDonors.py` (donor shading, presses) with a docstring that says why. The MCP cannot `inspect.getsource` an exec'd helper, so the docstring and this file are the only place its intent lives.
- **The pipeline docs** change when the contract does: `docs/partsAuthoring.md` for slots, budgets, naming and catalog fields; `exportCar.py`'s docstring for the `.blend` layout; `docs/carDonors.md` when a split becomes part of a donor recipe.
- **Open questions** stay listed until answered; answer them in place and say where the answer went.

### Lessons

- 2026-10-29 wendtStrom front: `patch_out(flush=True)` presses a marker recess clean, but its fitted normals read lighter than the authored panel; blending the box's corner normals from the surrounding ring (inverse-cube weights, same side only) fixed it. Candidate for a `blend_normals(o, box, ring)` helper when it happens a second time.
- 2026-10-29 wendtStrom front: `show([...])` left the body hidden because an earlier `hide_set(True)` on the objects stuck; `look` framed an empty scene twice before that was found. Print `[o.name for o in scene.objects if o.visible_get()]` before a `look` that shows nothing.
- 2026-10-29 wendtStrom Euro w/ Fogs: outer intake opening x 0.42 to 0.665, z 0.24 to 0.37, back panel 2.5 cm behind the rim facing (0.33, -0.93, -0.19). From two owner photos: the lamp sits 38 % in from the intake's outer edge, vertically centred, its chrome bezel 75 to 80 % of the opening's height and the lens 73 % of the bezel: center (±0.572, ray hit, 0.305), bezel r 0.047, lens r 0.034, 2 cm proud; after two rounds of "slightly smaller" plus "further out" and "up": shipped at (±0.592, ray hit, 0.315), bezel r 0.038 (about 60 % of the opening height), lens r 0.027 (the photos overstated the size by about 20 %: a lamp read off a photo starts at 60 % of the opening, centred a little high and 30 % in from the outer edge), aimed (±0.33, -0.94, -0.08). 22 segments to stay under 3,500 (24 came to 3,509). The intakes' honeycomb mesh is still a flat black panel.
- 2026-10-29 wendtStrom Cupra R: a lip that follows the bumper's bottom edge from arch to arch is `lower_edge(o, (0, -1.55), angles, 0.165, 0.235)` (rays in plan from behind the bumper, so the corners and sides are sampled square on) then `sweep(o, sections, 'Black')` with a 4-point section per station. Trace one half and mirror it: the donor's two sides differ by 2 to 3 cm at the arches. From the install photos (billswebspace, 12 photos): matte black textured plastic, tabs slid between the bumper and its lower trim, 4.5 cm proud and a 3 cm front face at the nose, tapering from 50 degrees round the corner to 1.2 cm proud and 1.6 cm tall at the arch (the installer trims 1/2 in off each end at the tire). 55 stations at 3 degrees: 436 triangles, so the bumper budget went to 4,000. The lip's lowest point is 0.131 m, under the body's 0.137.
- 2026-10-29: `npm run assets` rewrote `public/cars/daltonFiend.glb` with no change to its report; the export is not byte stable for every car. Do not stage a GLB of a car the task did not touch.

### Open questions

- The split is not in the Wendt Strom's donor recipe: a rebuild from the donor (`ship_donor`) gives one `Body` again and the cut must be redone from the seam table. Answer: a `split` entry in the recipe (planes and predicates from the table) once two cars have been cut and the shape of the data is clear.
- `SEAMS` in `tunerKits.py` should be read from the seam table above (or measured by `groove_z` at build time), not typed per car.
- Rear bumpers will likely need the `rearBumper` budget raised as the front's was; measure the first one before changing it.
- `CAR_BYTES_BUDGET` (700 KB) predates authored normals; decide whether the budget moves or the normals get quantized at export.
