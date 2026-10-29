---
name: parts
description: Body panel customization - split an imported car into its stock pieces (Bumper_Front, Bumper_Rear, Skirts, Hood, Roof) along the car's own shut lines, make aftermarket parts from those pieces (a marker delete, fog lamps, a lip, a kit) from the user's reference photos, save, export, verify in the game, and log what was learned. Use for any task about a car's bumpers, skirts, hood, roof, spoilers, side markers, badges, lips, lamps in a bumper, a "Stock" vs a named part, or the parts catalog; read it before /blender for that work.
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

- **Cut where the car is already cut.** A donor body models its panel gaps as grooves; find them with `groove_z(body, (x, y), direction, z0, z1)` at several stations and read the seam off the numbers (front: rays along +y at |x| 0, 0.3, 0.5, 0.65; corner: radial rays round the bumper's corner; side: rays along -x at several y). Groove depth 3 to 40 mm is a shut line, under 2 mm a crease. Never cut at a round height picked from a picture.
- **Bisect first, then move faces.** `cut(body, planes)` with each plane limited by a `within` predicate to its band (a plane is infinite), then `split_off(body, '<carId>.Bumper_Front', pred)`: below the seam for that station, ahead of the arch opening (measured per height with rays), plus material exceptions for what stays.
- **Keep the shading.** Donor bodies carry the source's normals (`authored_normals`); any bmesh edit drops them, and the exporter would then reshade from the reduced geometry and show every collapse sliver. `split_off`, `bumper_lip` and `patch_out` carry them; any other edit goes between `stash_normals(o)` and `restore_normals(o)`.
- **Budgets follow the donor.** A whole donor bumper is 3,000 to 3,500 triangles and a part adds lamps and a lip to it; raise `TRI_BUDGETS` (`src/shared/parts.ts`) and the table in `docs/partsAuthoring.md` rather than decimate a stock piece (it would shade differently from the body beside it).
- **Record the seam** in section 6 as soon as it is cut.

## 2. References before modelling

Every miss on the Wendt Strom's parts was a misread reference, not a modelling fault: the Cupra R Lip took five builds, the fog lamps three. So:

1. **Read every photo the user gives or links, all of them, before the first Blender call.** A linked page: `WebFetch` lists its images (often as relative paths); download them all with `curl` into `<scratchpad>/<part>/` (an Office-saved page keeps them in `<Page>_files/imageNNN.jpg`) and `Read` each one. Never build from the page's text or the first two photos.
2. **Know what each kind of photo is good for.**
   - Install sequences show how a part mounts: tabs, posts, what is cut or trimmed, where it ends. "Cut the two centre posts in half" meant the lip hangs clear of the bumper on posts in the middle.
   - Product shots show shape in plan, but in perspective. Ends that rise in a front-on shot are the part wrapping back along the sides. A section that looks wider may be a drop, not a bulge.
   - On-car photos show how it sits, and they are the ground truth. When there is none, ask for one before building.
3. **Write the reading down in the reply before modelling**, in five lines: how it attaches, its shape in plan, its section (thickness, how far proud, any gap), where it ends, finish and material. A misread then costs the user one sentence, not a build.
4. **Measure proportions, not sizes**: span of each section as a share of the whole, depth ratios, a lamp's size against its opening, its place as a fraction across it. Photos overstate small round things: the fog lamps came out 20 % big (start a lamp at 60 % of its opening's height, 30 % in from the outer edge, a little above centre).

## 3. A part from a stock piece

1. `copy_part(<nearest piece>, '<carId>.<slot>_<partId>', '<carId>:Parts')`, then `o['displayName'] = '<Name>'`. Copy the nearest part, not stock, when the new one is a variant (Euro w/ Fogs is the Euro plus lamps, the Cupra R Lip the Euro w/ Fogs plus a lip). Names: what the user calls it, else a fictional tuner name or a plain description (memory: part names).
2. **Build an add-on alone first**, in its own collection (never `preview`: `preview()` empties it), and `look` at it from the reference photo's own angle before it goes on the part. Then build it into the copy.
3. **Measure before looking.** Print a table per station (thickness, how far proud, gap to the part above it) and cast rays up from the add-on's top to the part. A render at game scale hid a 3 to 8 cm float under the bumper.
4. **The helpers** (`scripts/blender/carKit.py`, docstrings say why):
   - a removed feature is pressed flush: `patch_out(o, lo, hi, flush=True, ring=0.05)` (carDonors.py). Then blend the box's corner normals from the authored normals round it (inverse cube, same side): the fitted ones read a shade lighter.
   - a round lamp set into an opening: `round_lamp(o, center, normal, r_lens, r_bezel, proud, segments)`, centre from a ray onto the panel behind it. Lit lamps are `HeadLight`, `TailLight` or `BrakeLight`, the only materials that glow.
   - a chin lip along the bumper's bottom edge: `bumper_lip(src, target, ...)`. Its defaults are the shipped Cupra R Lip (flat bottom, centre plate on posts, full depth outboard, chamfer, run out at the wheel wells), so a new lip is a change of parameters. Underneath it are `lower_edge` (the face's bottom edge round the nose, by plan rays) and `sweep` (a section run along a path with its own normals).
   - a flat splitter cut from sheet stock (HDPE, aluminium): `sheet_lip(src, target, angles, thick, proud, chamfer)`. Flat top and bottom at the nose's underside height, outline in straight runs between `angles` (each run its own sweep, so faces stay flat and joints crisp), stopping before the arches where the bumper dips below it.
   - canards (dive planes): `canard(src, target, side, a0, a1, z0, rise, width)`, a thin plate following the corner face between two plan angles, angled up toward the rear. Short and wide reads as a canard: 15 cm long, 7.5 cm out tapering to 2.5 cm. At 22 cm long and 6 cm wide they read as trim strips. Keep them clear of the outer intake's rim.
   - real holes through a panel (speed holes, vents): `punch_holes(o, [(center, normal)], r, depth, sides)`, centres from rays onto the face. It cuts a polygon into the mesh, deletes the inside, runs a black wall `depth` m in and caps it black, then merges the flat slivers the cuts leave and prints any open edge it left. A black disc on the paint reads as a sticker from the garage's three-quarter. 16 sides; check every hole with `ray_map` (a half-covered hole shows as paint inside the `#` circle).
   - reshaping: `displace` pinned to the seam (`plane_seam`); flat plates and fins: `outline`, `slab`, `fin`.
   - **materials cannot be judged by `look`**: it draws every material in one colour and lens covers opaque. `ray_map([objs], x0, x1, z0, z1)` prints what the eye sees through the covers, one letter per material, `O` for a hole into the car.
5. Print the triangle count and materials. A part that lost a slot (the markers' `Light`) is right; one that gained `Paint.001` is not (`remap_materials`).

## 4. Reading the user's feedback

- **"Slightly"** is about 10 % in size, or 1 to 2 cm in position. Change only what was named, leave the rest exactly as it was, and say which numbers moved: "bezel 84 → 76 mm, raised 1 cm".
- **Words for a lip or blade.** Thickness is top to bottom. *Proud* is how far it stands ahead of the bumper's edge. *Taper* means it runs down along its length. A *flat bottom* is one height all the way round. *Chamfer* means a 45 degree bevel; the default is the top front edge, so offer the other edge in one line.
- When the user says it is not close, stop tweaking parameters. Go back to section 2, say what was misread, and build the add-on alone again.

## 5. Save, export, verify

1. `save_working_copy([cid], '<scratch>/work.blend')` (it removes `preview`, remaps materials, unhides the car pieces, saves a copy), then headless `blender -b work.blend --python scripts/blender/saveCar.py -- <carId> assets/source/eshell/<carId>/<carId>.blend`.
2. `npm run assets` and read its last lines (`validation passed`, the size warning). The first time in a session, ask first: it rewrites generated catalog entries. Once the user has said yes, run it every round. Check the catalog entry it wrote (`displayName`, `hides`, `materialSlots`, `tris`).
3. `/dev` garage, Body tab: Stock and the part, switched a few times from the garage's camera, when the user asks or a seam is in doubt.
4. Commit each round the user accepts, and push (memory: push on wrap-up). Stage only the `.blend`, the part GLB, the car GLB when the body changed, the catalog, `assets/inspect.md`, and any budget or doc change. Never stage `public/cars/daltonFiend.glb`: `npm run assets` rewrites it without changing it.

## 6. Seams and shipped parts

Seams (Blender space, m):

| Car | Front shut line | Front arch edge (z → y) | Rear | Skirts |
|---|---|---|---|---|
| wendtStrom | z 0.584 under the grille (|x| < 0.42), 0.568 under the lamps to 40° round the corner, 0.594 along the side; corner plane through (±0.618, −1.960, 0.568) and (±0.728, −1.889, 0.594) | 0.25 → −1.645, 0.4 → −1.615, 0.5 → −1.565, 0.6 → −1.50 | not cut yet | not cut yet |
| kazamaRotor, albrechtKombi | `tunerKits.py` SEAMS (typed when the bodies were authored; re-measure with `groove_z` before the next kit) | | | |

Parts (front bumper budget 4,500):

| Car | Part (displayName) | Built from | What it is | Tris |
|---|---|---|---|---|
| wendtStrom | Stock (`Bumper_Front`) | Body | cut at the seam above | 3,237 |
| wendtStrom | Euro | Stock | the amber corner markers pressed flush (box x 0.785 to 0.826, y −1.803 to −1.671, z 0.466 to 0.509) | 3,173 |
| wendtStrom | Speedholes | Euro | `punch_holes`: ten 16-sided holes 5.2 cm across on a 6.6 cm pitch, centred at z 0.437 across the flat band above the centre intake (z 0.39 to 0.49; the intake's top rim is z 0.38, its inner edge |x| 0.334), 1.5 cm black walls and backs. The user's photo shows nine; they asked for ten | 4,365 |
| wendtStrom | Euro w/ Fogs | Euro | `round_lamp` in each outer intake (opening x 0.42 to 0.665, z 0.24 to 0.37): centre (±0.592, ray hit, 0.315), bezel r 0.038, lens r 0.027, 2 cm proud, aimed (±0.33, −0.94, −0.08), 22 segments | 3,481 |
| wendtStrom | Cupra R Lip (`cupraR`) | Euro | `bumper_lip` defaults: flat bottom z 0.148; centre plate (|x| < 0.28) 8 mm thick, 1.5 cm clear, 3.5 cm proud, on two 14 mm posts at |x| 0.114; full depth outboard of the centre grille (2.2 to 3.3 cm), 2 cm proud, 1.2 cm chamfer; runs out past 70 degrees | 3,683 |
| wendtStrom | Cupra R Lip w/ Fogs (`cupraRFogs`) | Euro w/ Fogs | the same lip (its faces match the plain one's exactly) | 3,991 |
| wendtStrom | Track | Euro | `punch_holes` x8: 5.8 cm holes on an 8.5 cm pitch across the same 0.65 m span at z 0.437; `sheet_lip` defaults: a 13 mm sheet, top at z 0.169, 4 cm proud (2.5 cm at the ends), 6 mm chamfer, straight runs at 0, 20, 40, 52, 62 and 70 degrees, ending at x 0.78; `canard` x2 a side, 62 to 77 degrees, roots at z 0.48 and 0.40 rising 3 cm, 7.5 to 2.5 cm wide, 4 mm thick | 4,387 |

**Order: cheapest to most expensive.** The garage lists a car's parts in the order of its `Parts` collection, and the user wants every body slot sorted from the cheapest real-world part to the most expensive, so the order implies perceived value (Stock, then Euro, Speedholes, Euro w/ Fogs, Cupra R Lip, Cupra R Lip w/ Fogs, Track; Track last is a guess, since a DIY sheet splitter can cost about what the Cupra lip does). Place each new part by its rough real price; ask when two are close. Move an object to the end by unlinking and relinking it in the collection, and print `[o.get('displayName') for o in collection.objects]` before saving. A variant with and without an option is two parts with paired ids (`euro` / `euroFogs`, `cupraR` / `cupraRFogs`), the plain one first.

## 7. Keep this skill honest

This file is the memory of the parts process. After every part job, before the commit:

- **Lessons** go in the list below, one line each, dated, with the car: what read wrong, what fixed it, which helper now does it. When a lesson changes the process, move it up into sections 1 to 5 and delete the line. A shipped part gets its row in section 6.
- **Helpers, not inline code.** Anything typed twice in `execute_blender_code` becomes a function in `carKit.py` (geometry) or `carDonors.py` (donor shading, presses) with a docstring that says why. The MCP cannot `inspect.getsource` an exec'd helper, so the docstring and this file are the only place its intent lives. Prove a helper that replaces inline work by rebuilding the shipped part with it and comparing vertices (`bumper_lip` matched the Cupra R Lip exactly).
- **The pipeline docs** change when the contract does: `docs/partsAuthoring.md` for slots, budgets, naming and catalog fields; `exportCar.py`'s docstring for the `.blend` layout; `docs/carDonors.md` when a split or a fix belongs in a donor recipe (the grille back panel that drew a black crescent in the headlamps is there).
- **Open questions** stay listed until answered; answer them in place and say where the answer went.

### Lessons

- 2026-10-29 wendtStrom front: `show([...])` left the body hidden because an earlier `hide_set(True)` on the objects stuck; `look` framed an empty scene twice. Print `[o.name for o in scene.objects if o.visible_get()]` before a `look` that shows nothing.
- 2026-10-29 wendtStrom Cupra R Lip: five builds. A faced wedge; a uniform blade with a tall middle; a deep forward centre read off the product shots alone; a 3 cm drop on a sharp step ("too much space below": a lip's bottom is one line); then the shipped shape after the user's on-car photo and corrections. Section 2 is the fix. Also `lower_edge` first returned the face's outermost point, 3 to 4 cm up its under-curve, and the lip floated below the face; it returns the bottom edge now.
- 2026-10-29 wendtStrom Euro w/ Fogs: the lamps read off two photos came out 20 % big, 2 cm too far in and 1 cm low; three rounds of "slightly". Section 2, point 4 now starts from the shipped proportions.
- 2026-10-29 wendtStrom Speedholes: cutting circles into a reduced donor mesh failed three ways before `punch_holes` held. The straight cuts sliced every face near a hole (the part doubled to 6,900 triangles: now merged back with `dissolve_limit`). A piece one cut made touched the next cut's line only at a corner and was deleted whole, leaving a see-through notch (now two cut passes, and a face goes only when all its corners are inside). Long slivers crossing a hole with every corner outside it were never cut, half covering three holes (now "near" tests each edge's distance to the axis). Fewer sides did not save enough: 12 came to 4,023, so the budget went to 4,500.

### Open questions

- The split is not in the Wendt Strom's donor recipe: a rebuild from the donor (`ship_donor`) gives one `Body` again, and the cut and every part must be redone (the parts from the helpers' calls in section 6). Answer: a `split` entry in the recipe once two cars have been cut.
- `SEAMS` in `tunerKits.py` should be read from the seam table (or measured by `groove_z` at build time), not typed per car.
- Rear bumpers will likely need the `rearBumper` budget raised as the front's was; measure the first one before changing it.
- `CAR_BYTES_BUDGET` (700 KB) predates authored normals and per-part copies of a whole bumper: the Wendt Strom with six bumper parts is 1,343 KB, about 95 KB a part. Decide whether the budget moves, the normals get quantized at export, or a variant part ships only its difference.
- The front bumper budget has moved twice (3,000 → 3,500 → 4,000 → 4,500) as parts stacked features on a donor bumper; the next car's donor bumper may start nearer the cap. A per-car budget, or the stock piece's count plus a margin, may fit better than one number.
- The intakes' honeycomb mesh (on the user's photos) is still a flat black panel.
