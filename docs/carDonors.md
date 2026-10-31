# Cars from donor models

How a Street Scene car is made from one real car model: download a model with a free licence, make it generic, bring it to our triangle budget and car space, ship it. The mechanics are `scripts/blender/carDonors.py`; Blender basics are `/blender`. This replaces lofting and blending (`docs/carDesign.md`) for the car body. Aftermarket parts and wheels will get a process of their own.

## 1. Pick a donor

- **Licence first.** In order of preference:
  1. **CC0** (public domain): no conditions at all; our modified car is ours outright. Rare for cars on Sketchfab.
  2. **CC BY** (Attribution): free for any use, commercial included. Our modifications are ours and can be licensed however we like, as long as the original author is credited. **This is the target.**
  3. Never use NonCommercial (NC), NoDerivatives (ND), ShareAlike (SA) or Editorial licences. NC blocks selling the game. ND forbids the very changes we make. SA forces our derived car under the same licence. Editorial is for news use only.
- **Downloadable** on Sketchfab, with the licence shown on the model page.
- **One whole car**, not a scene: a ground plane or backdrop is fine (it is dropped), but several cars in one file are not.
- A source between 20k and 300k triangles reduces best. Under 10k leaves no detail to keep; over 1M is slow.
- **Provenance.** A CC licence is only as good as the uploader's right to grant it. Pass over a model that is evidently someone else's: a game asset (part names in a game's own scheme, such as `Bcnr33…`; lamps and grilles only in a 128 to 512 px texture; a face count on the model page far above what downloads), the same mesh under several uploaders (identical face counts), a game mod (BeamNG's `etkc_` parts), or a description naming the game it came from. Flag weaker signs (a redistribution site in the object names, as on the Dalton Fiend) and let the user decide.
- **Trademarks** are separate from the model's licence. A CC licence covers the 3D model, not the carmaker's name, badges or logo. The pipeline removes badges; cars ship under fictional maker and model names (Wendt Strom, Kazama Rotor, Albrecht Kombi, Dalton Fiend: no maker or model trademark, no sound-alike spelling, no chassis code), with ids to match (`<fictional maker><Model>`, e.g. `wendtStrom`).

Record each donor in `DONORS` in `carDonors.py` with its name, Sketchfab uid, author, licence and published length and wheelbase in mm, and add the author to the README credits.

### Score it before you commit

Import the candidate (step 2), then run `donor_score(cid, root)` before writing a recipe. It prints:
- the share of faces the default classes (`AUTO`) read on their own;
- the materials they cannot read;
- the traits that predicted trouble in the reproducibility test:
  - **weighted normals** (over 8 % of paint corners far off their face): the panels streak after reduction (the E30, the WRX);
  - **no lamp material**: the lamps are only in a texture (the Punto);
  - **mostly unnamed materials** (`Material.0xx`): the recipe classifies everything by position (the AE86);
  - **no tire material**, or a source already close to the budget.

A good source has clean, named materials, real geometry for its lamps and grilles, smooth (not weighted) normals, and 30k to 300k faces. **Picking the source is the biggest lever on quality: a better source beats any amount of fixing.**

## 2. Import

With the Blender MCP server and Sketchfab enabled in its panel (with an API token):

```
import_asset(source='sketchfab', id=<uid>, target_size=<published length in m>)
```

The size the importer reports does not matter: the pipeline scales from the published wheelbase.

## 3. Write the recipe

Most of the classification is automatic. `AUTO` in `carDonors.py` maps material names by keyword:
- dropped: tire, rim, wheel, brake, engine, badge, emblem, licence and plate, ground and shadow;
- `Interior` for the cabin (interior, seat, dash, steering, headliner, carpet, cloth, leather, gauges): it ships, reduced hard, because the game's glass is 70 % opaque and a car without a cabin reads hollow;
- `Glass`, lamps, `Paint`, `Chrome` and `Black` by their usual words; indicator, blinker, marker, amber and orange to `Light`, before glass, so `orangeglass` is not a window.

### Lamps

Only the big lamps glow in the game; everything else is an unlit lens. A donor whose lamps are modelled in layers (a clear cover over reflectors and bulbs, round lenses in a tail bar) is mapped finer than `'Lamp'`, and its detail then shows through the cover:

| Role | Material | Glows |
|---|---|---|
| A headlamp's element: its reflector bowl, its bulb, a projector lens | `HeadLight` | always |
| A tail lamp's own lens (the round lenses, not the bar over them) | `TailLight` | always, brighter braking |
| The third brake light | `BrakeLight` | only braking |
| A clear cover over a lamp, a reverse or fog lamp, an unlit bulb | `Lens` | no; see-through |
| Indicators, side markers, repeaters | `Light` | no; amber (a faint emissive so it reads orange at night) |
| White side markers and repeaters | `ClearLens` | no; white |
| Red reflectors and markers, a red strip that is not a brake light | `Reflector` | no; red |
| Housings, bezels, buckets | `Black` (or `Paint` where the car is body colour) | no |

1. List the import's lamp pieces: `lamp_islands(cid, lo, hi)` prints every piece centered in a box round one lamp (and its mirror), split by material, with face count, center, bounds and front. Lamps come in a few dozen islands: the cover (thousands of faces), the reflectors (`Chrome`, a hundred or so), the bulbs (small closed islands just behind a lens), the amber and red lenses.
2. Look at the lamps in the shared colours (`tint_materials()`, which tints `Lens` cyan), from the front and rear at 0.5 to 0.8 m: a temporary empty at the lamp makes a good `look` target with `distance`.
3. Decide with a photo of the real car which pieces glow and where the black goes; the photo, not the donor's material names, says which (the RX-7's pop-ups are body colour on the top and sides with a black bezel; its third brake light is one thin strip). Ask the user for a photo when it is not obvious.
4. Map by material first (`materials`), then by geometry (`recolor`): a bulb sits a few mm behind its lens, so a depth band picks it (`-1.893 < c.y < -1.865` on the RX-7's bumper lamps, where the lens ends at -1.895: print the faces' y along the lamp's axis to find the gap). A reflector behind a clear cover is `Chrome` turned `HeadLight` by box.
5. A main lamp needs something that glows: a lamp modelled as a bare cover over chrome stays `'Lamp'` (the cover glows) or gets its chrome recoloured.

The pipeline then does the rest:
- `lamp_faces` takes every lamp material and what sits under a `Lens` cover (rays outward along and across the car), and the recipe's `lamps` predicates for a housing outside its cover (the RX-7's raised pop-ups);
- those are reduced first at `LAMP_ERROR`, welded back and held while the shell collapses (Run, step 3);
- nothing under a cover is taken for a badge.

**Lamps always mirror side to side**, and so does whatever the recipe's `details` names (door handles, mirrors). The +x half of the lamps (cut exactly at x = 0) is reduced and copied across, welded at the seam, and the -x shell's open edge snaps onto it (within 12 mm: donors are often a few mm off mirror). So a recipe's lamp rules need only be right on one side, and the two sides match to the vertex (recipe `mirrorLamps: False` to opt out). Reduced whole, the collapse cut each side its own way: the Golf's headlamp bowls and the Kombi's fog lamps came out unalike.

Two traps seen on the RX-7:
- **Layers a few mm apart fold through each other** at the lamps' error (13 mm): the pop-up bucket's ceiling came through the lid in black patches. Recolour the hidden layer to the colour of the one over it, and keep anything seen from the front (the bezel's lip) as it was: `c.y` past the lens is a good split.
- **A fussy lamp is better replaced than kept**: four red blocks in a black pocket became one `strips` entry, a thin `BrakeLight` strip on a mirrored curve measured off the pocket's top edge (rays from behind at a few x, 6 mm under the edge, 1 cm tall).
- **A coarse donor's lamps take the shell's error** (`lampError: 0.01`): the tight error keeps every crumple of a lamp the donor left unfinished (the R33's headlamp recess), where the coarser one smooths it.
- **A small round lamp is rebuilt, never collapsed** (the wheels' rule): the shell's first collapse to 60,000 left the RX-7's bumper lamps (688 faces each) at 52, and the lamp pass 8- and 10-sided, unlike side to side. `cull` the round lamp's pieces (lens, reflector, bulb) and add a `discs` entry per lamp: center and radius from `lamp_islands` (the lens's bounds), the depth just in front of its own bezel and behind the cover (cast rays along y at the center and at 0.03 m out to find both). Give each side its own numbers: the RX-7's left lamps sit 5 mm further out than the right ones' mirror, and their bezel lip 14 mm further forward. Check from straight on that the circles are whole and alike.

Check a donor's lamps side by side, both sides, straight on and at a three-quarter: an asymmetric donor or the collapse shows there first.

Names are matched without Blender's `.001` suffix, so several donors can sit in one session.

A recipe adds only what that donor needs:

| Field | When |
|---|---|
| `materials` | material names `AUTO` gets wrong or cannot read (`Material.023`); regex to a shared material, `'Lamp'` or `None` (drop) |
| `tires` | the tire material, when it is not named tire or tyre (the axles, the scale and the track come from it) |
| `drop` | whole meshes to drop by object or parent name |
| `nose` | `'+y'` when the model faces +Y |
| `turn` | Euler degrees (XYZ) that stand a model lying on its side up Z-up, before `nose`: `(-90, 0, 0)` for one with -Y up facing -Z |
| `patches` | boxes to remove (`flush=False`: a roof plate) or press flush into the panel (sunroof, fuel door); a fifth value is the ring (m) the panel is fitted over, 0.12 by default, smaller on a curved panel (the RX-7's decklid lock) |
| `recolor`, `cull` | face fixes after the join (a glass roof to `Paint`) |
| `islands` | loose islands to delete after the join, `pred(faces, lo, hi, materials)`: what `cull`'s face boxes would cut too wide (wiper arms over a black cowl, an antenna) |
| `lamps` | predicates `(center, normal, material)` for faces reduced with the lamps at their tighter error: a lamp housing outside its cover (the RX-7's raised pop-ups) |
| `press` | `False` leaves the panels under removed badges as they are: for lettering that sits on a smooth panel rather than in a recess, where pressing dents it (the RX-7's tail); a predicate on a box's center presses only those (the Kombi's washer nozzles on its curved bumper are left) |
| `lampBudget`, `lampError`, `carBudget` | this car's lamps' triangles and error and its whole budget in place of `LAMP_BUDGET`, `LAMP_ERROR` and `CAR_BUDGET` (the Kombi's lamps kept finer, its total raised so the shell does not pay for them) |
| `midBudget`, `shellBudget` | the first collapse's target (60,000) and the shell's cap (`BUDGET`): a donor whose hidden chassis is a large share of the import keeps its panels fine with both raised (the Nakaya Grove's game mod chassis) |
| `debadge` | `False` skips the badge island passes: for a donor whose badges are materials of their own (drop them in `materials`) and whose grilles are meshes of thousands of small flat cells, which the passes take for badges and press flat (the R33's: 2,423 islands) |
| `bridges` | boxes `(lo, hi)` across a gap in the grille's bars: a `cull` or a badge mount cut them where it sat. The faces centered in the box go, then each bar end on the box's left face is lofted to its match on the right (same material, nearest z), so the bar runs across in one piece (the Golf's two bars, in front of the black panel behind them) |
| `rawNames` | the donor's materials are `Material.001`, `Material.002`: the `.001` suffix is the name, so classification must not strip it (the Runabout's) |
| `texture`, `textureCuts`, `textureClass` | lamps painted in a texture over their geometry: regexes of the material names whose base colour classes each face (`lamp_colour`, or the recipe's `textureClass`), ahead of and behind the axles; `textureCuts` `(axis, value)` cut those faces along the texture's bands first (x mirrored) |
| `liftLiners` | `True`: raise wheel well liners on or through the tire clear of it after the reduction (`lift_liners`; the Albrecht Kombi's rear) |
| `pieces` | `True`: splice the car's kept hand-made pieces (`save_pieces`, `<cid>.pieces.glb`) into the reduced shell, for work no rule can express (the Golf's grille and lower intake) |
| `discs` | `(center, radius, material[, yaw])`: a flat round lens added after the reduction, turned `yaw` degrees about z where the lens faces a little sideways, for a round lamp the collapse leaves polygonal (cull the donor's own); a round part is rebuilt, never collapsed (the RX-7's bumper lamps) |
| `details` | predicates `(center, normal, material)` for small parts that must match side to side (door handles, mirrors): they join the lamps' pass, reduced at its finer error and mirrored |
| `lowCull` | predicates `(center, normal, material)` for faces of the reduced shell to delete after the pieces are spliced in: slivers the collapse makes beside a cut (the Golf's lip under its grille) |
| `mirrorLamps` | `False` to keep a donor's lamps as they are; by default the +x lamps are reduced and mirrored across, so the two sides match to the vertex |
| `strips` | `(points, height, material)`: a thin lamp strip along a curve, mirrored across the middle, added after the reduction (the RX-7's third brake light in place of the donor's four blocks) |
| `backPanels` | boxes `(x0, x1, y, z0, z1)`: a flat black quad facing the nose behind an opening the pipeline's own grille quads miss (a lower intake with a crossbar in it), added after the reduction |
| `mirrorShell` | `True`: the shell is reduced as its +x half and mirrored (`mirror_shell`), welded at x = 0 with the authored normals mirrored, so the body is symmetric vertex for vertex and a part built on one side fits the other alike. Check the source first (rays from both sides, mirrored hits compared): the Nakaya Grove's doors, roof and quarters agree to a fraction of a mm. Whatever the source has on the -x side only is lost with that half |
| `unmirrored` | predicates `(center, normal, material)` for one-sided faces on the +x side kept through `mirrorShell` without their mirrored copy (the Grove's single exhaust tip) |
| `fromBelow` | `True`: the hidden-face cull also looks from under the car (straight up and 25 degrees off), as the underglow neon does, and `tuck_cabin` lifts cabin vertices that hang below the floor; for a donor whose floor closes the cabin from below |
| `underPanels`, `underStrips` | `(x0, x1, y0, y1, z)`: a flat black quad facing the road over a hole in the floor into the cabin (a tunnel open where the shifter was); `(x0, x1, y0, y1)` and its mirror: a black ribbon following the surface above it, under a slit in a curved floor or tub. Found by rays up from the road (Check, Underglow) |
| `split` | `(name, pred(k, lo, hi, mats)[, face_pred(c, m, n)])`: the stock pieces (`Bumper_Front`, `Hood`, ...) cut from the shipped body by `split_donor`, which `ship_donor` runs, so a rebuild from the donor gives them again. Whole loose islands for a donor modelled as panels; `face_pred` keeps part of an island (a lamp welded to the panel round it leaves the panel's rim) |

An unclassified material stops the run with its name, so nothing ships by accident. Look at the import's materials first: one listing with face counts and bounds per material says which is which.

## 4. Run

```python
exec(open(REPO + '/scripts/blender/carKit.py').read())
exec(open(REPO + '/scripts/blender/carRefs.py').read())
exec(open(REPO + '/scripts/blender/carDonors.py').read())
donor(cid, '<import root>')        # -> donor:<cid>.Full
reduce_donor(cid)                  # -> donor:<cid>.Skin, donor:<cid>.Low (BUDGET triangles)
donor_report([cid])                # size, scale check, materials, stations
compare_donors([cid], OUT)         # side / front / rear PNGs to Read
```

`donor()` does all of this; nothing needs to be done by hand:
- classifies and drops by the recipe and `AUTO`;
- turns the car to face -Y, and centers it on its tires when they sit off x = 0 (the R33 import sat 1.12 m to one side);
- scales it to the published wheelbase, then checks its length against the published one;
- keeps the authored normals as an attribute; flat-shaded sources are smoothed at 30 degrees first;
- assigns `'Lamp'` by position: ahead of the axles `HeadLight`, behind them `TailLight`, between them `Light`, and well inboard between the axles (a dome or dash lamp) `Interior`;
- removes badges on the nose and tail, thin decals anywhere on the body, wipers and antennas, and applies the recipe's patches;
- presses the panel flush where each badge sat: the badge's bounds, grown 2 cm, that hold Paint faces (a hood's leading edge, a bumper's top lip) get `patch_out(flush=True)`, so no notch is left. A badge in a grille has no Paint under it and is left to the next step;
- bridges the recipe's `bridges` (`bridge_bars`): the grille bars the badge cut are lofted across the gap, so the grille runs from lamp to lamp. Both steps log how many they did;
- removes the hub hardware whose materials gave nothing away (the RX-7's lug nuts and calipers were plain black and chrome): loose islands inside the tires' cylinders, out at the track.

`reduce_donor()` does this:
1. Collapses to 60k triangles, the lamps held (they are reduced in their own pass, step 3, from the source's detail). Both collapses are meshoptimizer's simplifier (`scripts/blender/meshopt.py`, run in Node from the npm package by `scripts/meshoptSimplify.ts`; nothing to install, but `node` must be findable: PATH, `$NODE`, or nvm/Homebrew). It weighs the authored normals and keeps material edges. It stops at 1 % of the car's size rather than tear a part off, and the Decimate modifier's mirror-symmetric collapse finishes the rest. `REDUCER = 'blender'` in `carDonors.py` goes back to Decimate alone.
2. Culls every face that cannot be seen from outside: jambs, flanges, double layers and inner glass. Glass and `Lens` do not block the test rays, so the cabin behind the windows and the reflectors behind a lamp cover count as seen, as they are in the game; both keep only their outer layer.
3. Collapses the shell to `BUDGET` (16,000) and the cabin apart to `INTERIOR_BUDGET` (2,500): the cabin touches nothing of the shell, and in one collapse its 30,000 triangles of seats and dash would starve the mirrors and handles. The lamps (every lamp material, and what is not paint inside a `Lens` cover's box) are collapsed apart too, first, at a tighter error (`LAMP_ERROR`, 0.3 % of their extent: they span the car, so the usual 1 % let a cover drift 4 cm), with their open edges held so they weld back to the shell, and without the Decimate finish, which cut the RX-7's round tail lenses to diamonds. The shell then collapses round them with every lamp vertex held (cut out and collapsed apart, it pulled its open edge into shards on the panels round the lamps), to what the cabin and the lamps leave of `CAR_BUDGET` (20,000), at most `BUDGET` (16,000): a fixed share set aside for lamps squeezed the Golf's shell (its cabin is 938 triangles) to 12,000 and its grille bars collapsed. What sits under a lamp cover is never a badge. Trim the collapse pulled through a window is pushed back behind it (`tuck_behind_glass`). The reduced cabin is then tucked inside the reduced shell (`tuck_cabin`: a vertex a few cm out is pulled 5 mm inside). Small features are what an error-driven collapse eats first, so a part that must survive gets its own budget (the wheel set does the same per kind: `docs/carWheels.md`).
4. Sets the authored normals back on the reduced faces, matched within the same material, from the skin as it is after the cull: the cull turns faces only their back is seen from and negates their authored normals with them, which rights a donor modelled inside out; a skin from before the cull would turn them back.
5. Closes the front grilles: the donor's own grille geometry stays as it is, matte `Black` (at night a grille reads dark; the patterned `Grille` plate every car once wore read as a silver sticker), logos inside a grille become black too, and an open grille gets one flat black quad 0.12 m behind the nose so nobody sees into the body. `grille_surface(..., material='Grille', flatten=True)` is the old patterned plate, for a donor whose grille is only a texture.
6. Strips what the wipers leave on the glass (pivots, nozzles, the mirror's mount: small black islands lying on it) with the wiper arms and antennas.

## 5. Check

- **Scale:** the length within 2 % of published. More means the wrong tire material or a wrong published figure.
- **Look:** side, front and rear sheets, then one three-quarter view. Look for:
  - blotches on the panels;
  - dark wedges on the glass;
  - holes;
  - lamps missing or on the wrong end;
  - leftover wipers, plates or antennas.
- **Cabin:** the donor's own, or none in the source: then `interior(cid, m)` transplants a garage car's (`docs/carDesign.md`, Interior); never a block. `npm run audit` must show `cabin inside the skin` ok.
- **Budget:** 16,000 triangles for the shell plus up to 2,500 of cabin; drift p95 under 1 mm. Drift only measures the kept vertices, so also read **lost** (the skin's vertices to the reduced surface): a high lost max is a part collapsed away, such as a mirror or a lip.
- **Winding:** look with backface culling on (`shading.show_backface_culling` on the viewport). The game draws most car materials double sided but not `Rim` or `Tire`, and a car wound inside out shades dark; Blender's default viewport hides both faults.
- **Underglow:** the Lights tab's neon sits under the car, so the cabin and the trunk must be closed from below and from the wheel wells, as the Wendt Strom's black floor closes them. Cast rays up from the road over |x| < 0.8, y across the car (2 cm grid, straight up and 30 degrees off toward each side and end): the first thing each meets must be Black or Paint, never Interior or Glass. A floor the recipe culls, a cull that looks only from the sides, a slit the source leaves (a tunnel's shifter hole, a tub's inner edge) or a cabin carpet the collapse leaves below the floor each lit the Grove's seats (`fromBelow`, `underPanels`, `underStrips`, `cull`).

### Lessons from the first four cars (2026-10-29)

- **Look in the game, not only in Blender.** Blender's viewport smooths and lights differently: a game garage shot (`node .claude/skills/dev/shot.mjs '/?garage&build=<code>' out.png --size 2800x1600`, a build code from `encodeShareCode(defaultBuild(cid))`, cropped with `sips`) showed the facets Blender hid. Use a matcap (`metal_carpaint`) in Blender for the reflections.
- **Keep the source's shading.** The reduced faces carry the source's normals (`shade_from_source`); reshaded from the reduced geometry at export, every sliver reads as a hard facet. `ship_donor` marks the body `authored_normals` and `exportCar.py` keeps them (the GLB about doubles).
- **Give the parts that show their own error.** The lamps, a tight lip (the Golf's hood edge over the grille, recipe `lamps`), a bumper's lamp openings: whatever reads as broken at the shell's 1 % goes in with the lamps at their finer error. Raise `lampBudget` / `carBudget` per car rather than starve the shell.
- **A hand-made piece goes stale.** Cut from an earlier reduced car, it brings that reduction's facets with it (the Golf's lower intake). Re-check every piece after a pipeline change and drop it when the reduction now does the job; keep it tight (`save_pieces(..., whole=False)`: cut every shell face it hides).
- **Don't fix the same thing twice.** A `bridges` loft and a piece over the same bars welded the bumper's lip up into a wedge; with the piece there, the bridge went. A `lowCull` deletes what the collapse makes beside a cut, after the pieces.
- **Paint is never grille.** `grille_surface` blackens what it finds surrounded by grille; a body colour strut between two openings is surrounded too, and the Golf's lower intake dividers came out black-spiked. Paint is now left alone, for every car.
- **Back a see-through opening.** A `backPanels` quad, wider and taller than the opening, behind a grille whose own back panel lets light through from an angle (the Golf's upper grille).
- **Details mirror too.** The recipe's `details` (door handles, mirrors) join the lamps' pass: reduced at its error and mirrored, so the two sides match. Two more steps make the mirrored half shade like its twin: `mirror_normals` gives every -x face its +x twin's corner normals, mirrored (shade_from_source had taken them from the donor's own -x surface, a few mm off), and `wind_to_shading` turns any face wound against its own corner normals (the collapse and the seam welds leave a few dozen; drawn double sided, they read as dark teeth on the Golf's left handle).
- **Budgets.** A car's `carBudget` is what its lamps, details and cabin need plus 13,500 or so of shell: the Golf sits at 28,000 (12,000 of lamps, handles, mirrors and intake rims), the Kombi at 25,000, the RX-7 at 20,000. The GLB with authored normals runs 0.6 to 0.8 MB. The cost per frame is modest beside the city (a race's ten cars at 28,000 are 280,000 triangles against a 1.1 to 1.35 million triangle scene at Medium), but it is paid on the player's and every rival's body with no impostor or LOD, so keep a car under 30,000 and raise the budget only for parts that read wrong at the shell's error.
- **No second reducer, and no planar dissolve on the shell.** Tested 2026-10-29: Decimate is already the finisher and its collapse is what cut the RX-7's lenses to diamonds; a quad remesh (Instant Meshes, QuadriFlow) spreads density evenly and rounds the edges a car needs sharp. A planar dissolve on the Paint panels before the shell's collapse (2°, 5°, 8°) shed no triangles, since the budget sets the count, and at 5° the Golf's hood faceted in the game (a 5° merge on a curved panel shows in its reflection) while the drift metric improved. The lever is `carBudget`; what each triangle buys is set by the error and the per-part passes. If a rival LOD is ever needed, make it on the same meshopt path at a larger error.
- **Fit the donor, or drop it.** A coarse donor (the R33, 30,000 triangles, unfinished headlamps) cannot be rescued by the pipeline; the car was hidden (`selectable: false`) until a better donor.

### Hand edits go in the recipe

A reimport rebuilds the car from the donor, so an edit made by hand to the shipped mesh is lost the next time. Every fix belongs in the recipe, where the next rebuild makes it too:
1. Let the user edit a copy of `donor:<cid>.Low` (a study copy in its own materials is fine).
2. `edit_diff(cid, '<edited object>')` prints the faces removed, added and recoloured, in clusters with bounds, and for each removed cluster the `.Full` islands it reaches: a whole island is an `islands` rule (`set(mats) == {...} and k < N` and its center in a box), part of a larger one a `cull` box on the face centers.
3. Write the rules, rebuild, and check the edited spots hold nothing (count the faces left in each box) before shipping.

The RX-7's hand edits all went this way: wiper blades and the antenna base (`islands`), the windshield seal's folded edge and the mirror mount's top (`cull`), the decklid lock (`patches`, with a small ring).

### Repairs on a shipped body

Once a car's bumpers and parts are cut from its `Body`, a rebuild through `ship_donor` would mean cutting them all again, so a fault found later is repaired on `<cid>.Body` (and on the parts that share it) with the helpers in carDonors.py's "repairs on a shipped body" section. Each samples the shading skin (`donor:<cid>.Skin`, its `src_normal` corners) and keeps every other face's authored normals; prove one by running it on a copy of the old mesh and finding every vertex outside the edit unmoved (a KD-tree of the old vertices) before it ships.

- `reshade(o, skin, pred)`: corners re-sampled 2 mm in from the corner. `shade_from_source` samples a quarter of the way to the face's centre, which on a long collapse triangle is centimetres away, so neighbouring triangles disagree and read as facets. Re-shade before any rebuild that sits next to the faces, or its own rows get caught.
- `densify_on_skin(o, skin, pred, max_edge)`: long edges split and the new vertices put on the skin, where one flat triangle spans a curve.
- `swap_islands(o, skin, box)`: a detail the donor models as its own island (a mirror) replaces the body's reduced copy, whole, with the source's normals.
- `reskin_lip(o, skin, ay, az, xr, under, fair)`: a hood's leading lip rebuilt as a fresh triangulation on the skin round an axis along x, faired across the car where the donor has something the game does not (a badge surround's bulge).
- `grille_ledge(o, front, z_front, z_back)`: a flat painted ledge from a bumper's top edge back under a grille's black panel.
- `mend_top_edge(o, front, z_top, cut)` and `snap_top_edge`: a stretch of a bumper's top edge re-triangulated straight and the rest put on the same line as the ledge.
- `handle_tail(o, fit, y0, y1, zc, hw, proud)`: a door handle's bar carried on to its rear end on both doors, built fresh (rounded edges, a crowned face, smooth normals of its own) on the plane of the door round it, from inside the bar to its end.
- `strip_nodes(o, y0, y1, lo, hi)`: a garage switch's feature along both sides where a rectangular hole cannot go (a strip across a shut line) and the donor models it as a shell of its own lying on a panel that runs on underneath, shut lines and all: every island whose vertices all lie between the planes `lo` and `hi` (z = c + k y, just outside the strip's edges) leaves the body as `<feature>_off`, and nothing else changes; the switch hides it. The first version cut out every face using a strip vertex and pressed a copy flat as `_on`: on the reduced body those faces fan 10 to 15 cm above and below a 3 cm strip (0.66 m² for 0.15 m² of strip), and the pressed copy shaded as patches and seams across the door. Look for a panel under a feature before cutting one: an island test (`islands`, or the boundary verts of the faces round it) shows it.
- `half_cup_nodes(o, skin, y0, y1, z_cut, z_top)`: a garage switch's swap patch on both doors where the feature is a recess under a part that must not move (a handle cup under its bar): the door faces (facing out, not proud of the door) are cut by a box in (y, z) on both sides and those inside become `<feature>_off`; `<feature>_on` is a copy with every corner off the box's edge pressed onto the door read from the skin, the bottom row too, and a ledge from that row down to the recess left below. The box's edge lies on plain door, so both pieces meet the body without a crack, and every piece's corners there take the door's normal.
- `SourceShade(src, faces)`, `island_at(src, point)` and `even_fill(sample, x, xc)`: the original source mesh as the reference, for a repair that must match the car as modelled rather than the donor skin (which is culled and can keep pieces of what a cull took). Re-import the source (`import_asset`, Sketchfab uid from the recipe), merge it and place it like the donor (the Wendt Strom's: paint bounds matched to `donor:<cid>.Full`'s, scale from length, 0.06 mm to the skin), pick a panel by `island_at`, sample it with rays; `even_fill` carries a section across a badge's notch.
- `step_band(o, cut, sample, crease_z, top_z, x_max)`: a bumper's top band rebuilt where it steps (sloped face, crease, short upright step, open top edge) as a constrained Delaunay through the hole's outline with a crease row as a constraint, on the reference surface, corners split at the crease.
- `feature_nodes(o, skin, rect, y_min, inset)`: a garage switch's feature (render/car/bodyFeatures.ts) cut out of a rear facing panel as two nodes of its own: `<feature>_off`, the skin's full detail feature joined to a clean rectangular hole by a triangulated band, and `<feature>_on`, the hole closed flush (`close_opening`, loop unmoved); the loop's corners on the body and both nodes take the skin's normal there.

The Wendt Strom's, in order (2026-10-29; the user's photo of their own car's grille: two body colour bars across on black backing, a painted ledge under them, the hood's lip one clean curve). On `wendtStrom.Body`: `reshade` the hood round the lip (Paint, |x| < 0.5, y < −1.70, z > 0.69, normal z > −0.5); `reskin_lip(-1.95, 0.685, 0.37, under=-1.952, fair=([(0.03, 0.08), (0.22, 0.37)], 35, 50))`, which also sinks the grille back panel's top under the lip; `grille_ledge` on the stock bumper's own top edge (`LEDGE_FRONT` below, z 0.5834 to 0.5898, the slivers of the badge mount on the bumper's edge deleted: Paint, |x| < 0.13, y < −2.07, z 0.578 to 0.60); `swap_islands` with the box 0.66 < |x| < 1.04, −0.82 < y < −0.43, 0.82 < z < 1.09; `densify_on_skin` (2 cm, 0.70 < |x| < 0.90, −0.82 < y < −0.58, z 0.80 to 1.02, Paint and Black, not the new mirrors) and `reshade` (0.66 < |x| < 0.95, −0.85 < y < −0.35, z 0.80 to 1.12) round the mirror bases. On `Bumper_Front` and every `frontBumper_*` part: `mend_top_edge(LEDGE_FRONT, 0.584, cut)` (Paint faces centred within |x| < 0.1, y < −2.07, z > 0.565 with a corner above 0.572) then `reshade` the top band (Paint, |x| < 0.40, y < −1.99, z 0.50 to 0.59, not the mended stretch). `LEDGE_FRONT` = (0, −2.0860), (0.0369, −2.0852), (0.0632, −2.0852), (0.1063, −2.0792), (0.1227, −2.0775), (0.1785, −2.0666), (0.2755, −2.0548), (0.379, −2.0349). The body went from 24,099 to 27,671 faces, the base car GLB from 786 to 820 KB.

Later the same day (the user: the rearward part of the door handles was missing): `handle_tail(fit=0.82 < x, 0.335 < y < 0.5, 0.745 < z < 0.815, y0=0.298, y1=0.3794, zc=0.785, hw=0.0155, proud=(0.0155, 0.013))` on `wendtStrom.Body`, 236 faces (472 triangles), no other vertex moved. The bar stands 16 mm off the door over its cup and ended there; the donor models its last 5 cm (y 0.33 to 0.38) as a plate 0.2 mm under the door's own surface, which only showed in the source as z-fighting, and the reduction merged it into the door.

Then the hatch handle (the user: shown, it was too low poly; shaved, the press at load left black slivers): `feature_nodes(Body, skin, (-0.115, 0.115, 0.64, 0.785), 1.85, step=0.02)`, so the body has a 23 × 14.5 cm hole round the handle's recess (rim at |x| 0.101, z 0.653 to 0.770), `shavedHatch_off` is the skin's handle, cup and lock cut 5 mm inside it (666 triangles, 53 in the band) and `shavedHatch_on` the flush skin (140 triangles, cubic fit 0.51 mm rms). The fitted normals tilted 3 degrees off the skin's along the top edge and the handle showed in a lighter box until the loop took the skin's own.

Then the half cup handles (the user: the cup above the handle filled flush with the door, the lower half kept, the fill running behind the bar to its middle): `half_cup_nodes(Body, skin, 0.175, 0.345, 0.785, 0.835)`. The cup is about 8 mm deep above the bar (bar z 0.769 to 0.800, the cup's rim at z 0.822, y 0.186 to 0.33); the door there is a function of z alone (x 0.8285 at z 0.80, falling 0.33 per m). `halfCupHandles_off` is 244 triangles, `halfCupHandles_on` 316 (40 of them the ledge, up to 14.5 mm, behind the bar); the body went from 26,336 to 26,313 faces, and rays at nine angles find no hole the stock body lacks. What failed first: picking the cup's faces by depth left the long fan faces from the rim to the shut lines with the rim's curl in their corners (a sawtooth of light beside the flush patch) and missed the rear end walls (under 1 mm deep, leaning 17 degrees), and the two sides came out different, since the reduced door is triangulated differently on each side. Mirroring the body round the handles cannot fix that: the door is a few triangles from shut line to shut line, and the shut line's vertices have no mirror.

Then the rubstrip (the user: a shaved rubstrip switch, the thin line along the middle of the door and a little into the quarter): `strip_nodes(Body, -0.87, 0.79, lo=(0.5155, 0.0155), hi=(0.5555, 0.0155))`. The strip is Paint, about 3 cm tall and 12 mm proud, rising 1.55 cm per metre rearward, from the door's front edge (y −0.84) across its rear shut line (y 0.43) to a point at y 0.78 on the quarter: one open shell per side on the door and quarter panel, which carries the shut line through underneath. `shavedRubstrip_off` is those 126 faces and there is no `_on`; the body went from 26,640 to 26,514 faces with no vertex moved. (Redone 2026-10-30: the first cut took 290 faces round the strip, z 0.39 to 0.69, and its pressed `_on` read as patches across the door.)

Then the nose again (2026-10-30; the user: panel warping on the front of the hood and the top of the front bumper). The donor skin the first repair sampled still held paint pieces of the badge surround in front of the hood lip (|x| < 0.175), so `reskin_lip`'s fair flattened a bulge the car does not have: the lip's edge sat up to 12 mm back over the middle and shaded 15 to 27 degrees off, and `mend_top_edge` had left the bumper's band under the grille flat and up to 10 mm proud on a dozen lopsided triangles. Against the re-imported source (`SourceShade`; hood island 1,246 faces, bumper 2,582): the source's lip has one section across the car (0.5 mm from x 0.05 to 0.35) and a plan edge within 1 mm of a quadratic, and its bumper top steps (a sloped face, a crease at z 0.5715, a 1 cm upright band to 0.582, the flat top). On `wendtStrom.Body`: every Paint-only lip vertex within |x| < 0.37 moved along its ray from the roll axis (y −1.95, z 0.685) onto the source hood, the crease row onto the lip's front edge, the badge notch (|x| < 0.06) by `even_fill`, corners on the source's normals (324 vertices, at most 12.6 mm; now within 0.3 mm and 0.5 degrees); the ledge's front row onto the bumper's new top edge and its faces on the source top's normal. On `Bumper_Front` and every `frontBumper_*` part: the band's vertices onto the source along y (z held at 0.582 above it, faded out by |x| 0.40 and below z 0.535), then `step_band` over |x| < 0.36 (42 faces → 77, plus 31 triangles a part; the headlamp corner's cluster of tiny faces stays, it pinched the outline), then every open top edge vertex onto the same line so the ledge meets it within 0.6 mm (the ledge's tuck). Now within about 1 mm of the source, shading 2 to 7 degrees.

What caused each fault, so a recipe can avoid it: the hood lip's facets were `shade_from_source`'s quarter inset on long triangles; its centre recess was the badge cull with nothing behind it; the grille piece's strip stood up to 2 cm proud of the lip; the hole under the grille was the donor's ledge cut away with everything the grille piece's box held (z 0.585 to 0.705); the mirror bases were the `details` box reducing each mirror together with a box of the door round it, then snapping the two together.

## 6. Ship

`ship_donor(cid, work)` does the first step for a car already shipped (same donor, same wheelbase and track): it copies `donor:<cid>.Low` into `<cid>.Body` (loading the car's collections from its `.blend` when the session lacks them), drops the `src_normal` and `own_normals` attributes, runs `remap_materials`, saves a copy of the session at `work` without touching the session's own file, and prints the two commands that finish it. Re-shipping an unchanged build this way gives a byte-identical GLB. A donor without a cabin of its own keeps the shipped body's transplanted one (`interior()`), tucked inside the new shell. For a new car, copy `donor:<cid>.Low` into `<cid>:Car` as `<cid>.Body` by hand the same way and put the Rig empties at the donor's own wheelbase, track and tire radius. Then:
1. Save a working copy and run `saveCar.py` headless.
2. Run `npm run assets` and `npm run validate`. A body shipped by `ship_donor` carries the source's normals and the object property `authored_normals`, and `exportCar.py` keeps them: reshaded from the reduced geometry, the Wendt Strom's hood and bumper showed every collapse sliver as a hard facet. The GLB grows (the Wendt Strom 262 to 576 KB: authored normals split vertices). Any other body is reshaded as it exports (`SHADE_ANGLE_DEG`): edges sharper than 35 degrees split, the rest smoothed with face-area weights. The authored normals `shade_from_source` sets do not survive later hand edits (a bmesh round trip drops them), and plain smooth normals on a 16,000 triangle shell tilted the hood's corners 30 to 40 degrees off their faces: the panel's reflection swung across it and went black at some angles. Wheels keep their own shading.
3. Look at the car in the garage, lowered all the way: the tire must tuck under the fender with no liner showing in front of it. The game clips a tire at the body's outer skin under the fender and at the lip's underside at its edge (`render/car/wheelClip.ts`), so a liner's height no longer matters to a lowered build; a liner on or through the tire still does (`lift_liners` in `carKit.py` clears it to the house arch gap).

A new car also needs a manifest entry, its `drivingParams.json` block and the car-list tests.

## 7. Second import (2026-10-22)

The three cars were re-imported after the wheel set showed what a collapse to a small budget costs (`docs/carWheels.md`): at 8,000 triangles the mirrors, handles and lamp edges smeared, the cabins were dropped, and the RX-7 kept its lug nuts and calipers. Now 16,000 for the shell, the donor's own cabin at 2,500 seen through the glass, and the hub hardware culled by position. The Hatch is 16,936 triangles, the Coupe 18,494, the Wagon 18,483 (budget 20,000). Nothing in the manifest changed (same donors, same wheelbase and track), so replays and bests still stand.

## 8. Reproducibility test (2026-10-21)

Four donors the pipeline had never seen, from four authors: four body styles and four ways of authoring a model.

| Donor (author) | Recipe overrides | Length vs published | Result |
|---|---|---|---|
| BMW M3 E30 (TinoD2) | none | -0.6 % | Shape, glass, lamps and kidney grille right. **Panels streak**: weighted-normal source with modelled shut-line grooves; unsolved. |
| Toyota AE86 (Lexyc16) | 7 (every material is `Material.0xx`) | 0.0 % | Clean. Source already 8k, so the reduction is light. |
| Fiat Punto GT (lionsharp) | 1 | +0.7 % | Shape clean, antenna removed. **No lamps**: they are painted in a texture, and classification goes by material. |
| Oldsmobile Cutlass '71 (barbo-autos) | 3 (faces +Y, trim shares the badge material) | -0.8 % | Clean, including chrome trim. |

Findings that drove the pipeline, now automatic:
- scaling from the wheelbase (one import came normalized to a 5.3 m ground dome);
- smoothing flat-shaded sources;
- removing antennas;
- the `nose` flag.

**Still open:**
- **Weighted-normal sources** (the E30, partly the WRX) streak after reduction.
- **Texture-only lamps** (the Punto) need recipe boxes or texture sampling.
- **Cowl gaps** where a wiper mesh carried the cowl trim (the WRX).
- ~~**No cabin**~~: a donor without one gets a garage car's donor cabin transplanted and fitted inside its skin (`interior()`, `docs/carDesign.md`).

## 9. Dalton Fiend (2026-10-27, then called the Proto Muscle)

A fourth garage car from a 627,000 face widebody Challenger SRT Demon (SDC PERFORMANCE, CC BY 4.0; every object in the file is named `desirefx.me_0xx`, a model redistribution site, so the uploader may not be its first author: shipped on the Sketchfab licence at the user's call). The recipe needed six overrides: the paint (`CARS`), the windows (`material`), the lamp reflectors and the tail bar's red (`GLASS`, `GLSS`, `Material`, all read as windows by `AUTO`), the black tail lamp housing, the one mesh that holds all four wheels, and the carbon (`Carbone`: hood, roof, trunk lid, ducktail, mirror shells, splitter, grille block), parked on `Trim` and sorted by position into Paint (stock is plain) and Black (splitter, grille block). The fuel cap is an 11,000 face disc standing off the left quarter, pressed flush with a patch. Length -0.1 % of published, 18,143 triangles (cabin 2,180), drift p95 1.3 mm; `lift_liners` cleared the wheel well liners that sat on the drag radials (arch gaps 0.008 / 0.013).

`press_recesses` crashed Blender on this donor: it kept `p.center` vectors across `patch_out` calls, and those point into the mesh's polygon array, which each `to_mesh` reallocates. With three badge recesses to press, the third read freed memory. It now copies the centers and collects them again after every press.

## 10. Nakaya Horizon GT (2026-10-28)

A fifth garage car, after a 1997 Skyline GT-R R33. The user's link downloaded as a 9,536 triangle game asset (`Bcnr33…` parts, 128 to 512 px textures holding the lamps, grille and badges; Sketchfab lists it at 254,184 faces), and the other CC BY R33s were no better: three uploads of one *Driver: San Francisco* mesh (284,9xx faces each, one says where it came from) and a BeamNG mod (`etkc_` parts, Russian material names). The donor is greddy295's own R33 GT-R (2014, Blender, 69,371 faces), which its author calls unfinished.

Recipe: German material names, nose at -X off center (`turn`, then the automatic centering), the wheels and suspension dropped whole (their meshes share Metal, Black_Metal and Exhaust with the body), `debadge: False` (the badges are their own materials; the grille meshes are 2,400 flat cells the badge passes pressed into crumpled panels), the emblem's mounting plate as four `islands`. The unfinished part is the headlamps: an empty paint recess inside a black outline, recoloured to `HeadLight` (the hood's leading edge above it excluded by height and normal). Length -1.0 % of published, 16,000 triangles, drift p95 0.5 mm, lost max 11 mm. The donor has no cabin. It first shipped with the house block (36 triangles, a box at the belt 0.12 m in from the widest point), which stood 9 cm out of the tumblehomed doors as flat slabs on both sides; it now carries the Albrecht Kombi's donor cabin (`interior()`, `fourSeat`, right hand drive): 2,420 faces cropped behind the rear seat back, fitted inside the skin. Arch gaps read 0.09 / 0.12 m against the liner; the stance looks right with wheels on.

## 11. Tachibana Zenith (2026-10-28)

A sixth garage car, after a 1994 Supra MK IV Turbo: TinoD2's "Toyota Supra MK IV (1994)" (CC BY 4.0, a Blender model by Martin Trafas, 261,968 faces listed, 254,000 in the file: not a game asset, its lamps are geometry). Published 4,520 x 1,810 x 1,275 mm on a 2,550 mm wheelbase (Wikipedia, Toyota Supra A80; the track is measured). Recipe: every material is `TOYOTA_SUPRA_*`, and AUTO misread four: `BRAKE_LIGHT` (dropped as a brake, now `TailLight`), `LIGHT_GLASS` and `HEADLIGHT_BASE_*` (the first keyword wins: glass, lamp), and `TEXTURES` (the window seals, trim and the exhaust pipe in one atlas, now `Black`); the turn signals are `Lamp`, and the front fender markers are recoloured `Light` so the audit finds indicators. Length +0.3 % of published, 16,005 triangles, drift p95 1.9 mm, lost max 16 mm. The donor has no cabin: it carries the Kazama Rotor's (`interior()`, `twoSeat`, left hand drive), 2,499 faces, all inside the skin. By hand after the reduction: the exhaust pipe and tip (black in the atlas) recoloured `Chrome`, a black panel 0.12 m behind the grille so the openings are not see-through (the pipeline's own quads cover only the lower slot and the fog lamp pockets), and the body raised 9 mm to open the arch gaps (0.011 / 0.019).

## 12. Tachibana Runabout (2026-10-28)

A seventh garage car, after a 1996 MR2 Turbo (SW20): s0h1o9b's "1996 Toyota MR2 W20" (CC BY 4.0, Blender and Photoshop textures, 25,276 faces listed; not a game asset: the lamps, the T-top, the twin engine deck intakes and the wing are geometry, and the author says it has no interior). Published 4,170 x 1,695 x 1,235 mm on a 2,400 mm wheelbase (Wikipedia, Toyota MR2; the track is measured). The import is scaled to its 4.17 m ground plane, so the pipeline's scale-from-wheelbase did all the work, and it faces -X (`turn` 0, 0, 90). Every material is `Material.0xx`, which `_base` would strip to `Material`: the recipe sets `rawNames` and was written from isolated renders (one tint per material): 016 the tire, 001 the glass, 003 black trim and seals, 004 / 005 / 007 / 017 the lamps (by position), 010 chrome (logos, which the badge passes remove; the exhaust tips; the diffuser slats, recoloured `Black` between the tips), 012 / 015 / 018 black (wing stays, tail panel, mirror glass); the wheel parts are dropped by their parents' names. The nose strips (HeadLight by position) are recoloured `Light`, the indicators; the pop-up headlamps are closed in the hood, so the fog lamps in the bumper are the headlamps. Length -1.9 % of published (the wheelbase sets the scale and the model's overhangs run short), 10,133 triangles, drift p95 0.0 mm (it is under the budget, so nothing is collapsed), lost max 7 mm. The donor has no cabin: it carries the Kazama Rotor's (`interior()`, `twoSeat`, left hand drive), 2,499 faces, all inside the skin. The front intake is closed by the recipe's `backPanels`, and the door handles are the house bars pinned to the donor's own embossed ones (`body.handleFwd`). The donor is a widebody on its own wheels (measured track 1.404 m, mirrors out to 1.88 m), kept as it is: arch gaps 0.017 / 0.029.

## 13. Kazama Rotor lamps (2026-10-29)

The first car through the lamp pass (Recipe, Lamps). The FD's lamps are geometry in layers: one clear cover over the whole tail bar with three round lamps a side (two red lenses, one amber) and a black pocket mid bar; pop-ups with a clear cover over a chrome reflector and a round bulb; bumper lamps with a clear lens, a bulb and an amber indicator behind a cover. Before, every lamp piece was `'Lamp'`, so the tail bar was one glowing red slab, the bumper indicators glowed white as headlamps and the bumper reflectors flashed with the brakes.

Now: clear glass is `Lens`, orange `Light`, red `TailLight`; the pop-ups (cover, reflector and bulb) `HeadLight`; the bumper lamps' round lamps clean discs (`discs`: the inner one a lit `HeadLight`, the amber one an unlit `Light`; the collapse left them 8- and 10-sided, and each sits at its own center, the donor's two sides being 5 mm off mirror, just in front of its black bezel); the four red blocks mid tail bar culled for one arched `BrakeLight` strip. The pop-ups are body colour on the lid and both sides over the donor's black bucket (from a photo: the bucket's ceiling, which folded through the lid, is paint) and are reduced with the lamps. Fixes found on the way, now in the pipeline: the badge pass took the tail lamps' reflectors for badges and pressed the panel flush where they sat (nothing under a cover is a badge now); pressing the tail lettering flush dented the panel (`press: False`); the hand-cut "inboard flap" cull was the lid's own edge, saw-toothing it (dropped); raised pop-ups made `grille_surface` close the gap between them with two floating black quads (the fascia top is taken at the middle). The user's hand edits went into the recipe (Hand edits go in the recipe). 19,841 triangles: the lamps take 5,300 of them at their tighter error (with the pop-up covers lit and opaque, the cull drops what sat behind them). Manifest and physics unchanged, so replays and bests stand.

## 14. Wendt Strom lamps (2026-10-29)

The second car through the lamp pass, and the first whose lamps are painted: one `Lights` material over modelled lamps, its colours in a 512 px texture. The recipe's `texture` classes each face by the colour under it (`lamp_colour`: red `TailLight`, amber `Light`, bright `Chrome`, dark `Black`), after cutting the faces along the texture's bands (`textureCuts`, probed with an ASCII map of the colour each ray from behind hits). Then, as on the RX-7: the covers `Lens`, the headlamps' two reflector bowls and their bulbs `HeadLight` (every corner inside the bowl, the housing floor under them excluded by its normal), the small red round lens between them `Reflector`, the strip over the rear glass `BrakeLight`, the reverse and fog blocks one colour each.

The import also showed three pipeline faults, now fixed: the lens test's sideways ray found the headlamp cover from the grille and took the grille bars for lamp parts (only the ray along the car now); a fixed lamp share squeezed the shell to 12,000 and its grille collapsed (the shell now gets what the cabin and lamps leave of `CAR_BUDGET`); and the grille and lower intake rebuilt by hand on 2026-10-27 had no recipe form. They are kept as pieces (`save_pieces` writes `assets/source/eshell/wendtStrom/wendtStrom.pieces.glb`, recipe `pieces` splices them in after the reduction: the shell's faces wholly in a piece's box that the piece hides along the car go, the piece's open edge snaps to the hole's within 1 cm and welds). 20,557 triangles. The mirrors came out 7 mm narrower, so the manifest's width went from 2.04 to 2.03 (the sim's collision reads it: the Wendt Strom's replays and bests changed, which is fine before launch).

Follow-up the same day: in the garage each inner headlamp showed a black crescent on its inboard edge. The grille's `backPanels` quad ran to |x| 0.42, 3 cm past the grille, and stood at y -1.95 in front of the inner reflector bowls' inboard side (as deep as -1.957 from x 0.395). It now stops at 0.38, inside the housings' inboard walls. A `backPanels` entry ends at the opening it backs, never under a lamp. The way to find such a thing: a front ray map through the covers (skip `Lens`, `Glass`, `ClearLens`, print one letter per material hit and an `O` for a ray that runs into the car), on the body with the stock bumper in place, straight on and 20 degrees off.

## 15. Albrecht Kombi lamps (2026-10-29)

The third car through the lamp pass, and the quickest: its lamps are modelled in named layers, so the recipe maps materials and adds four position rules. Clear `lights_glass` and `detail_glass_clear` are `Lens`; under them the headlamps glow whole (reflector bowl, projector, bulbs) but for their outer corner, the indicator (`Light`); in the bumper the inner lamp (the fog lamp and its round lens) glows and the outer is an indicator. At the rear the red glass runs across the tailgate from the corner lamps: the lamps glow (the corners and the tailgate's ends out from |x| 0.31), each reverse lamp (|x| 0.31 to 0.38) is bright `Chrome`, the centre panel an unlit `Reflector`. The donor's own textures are not in the import, so the classes were judged by geometry in the study colours.

The shipped file's hand fix, the rear liners lifted off the tires (2026-10-27), is the recipe's `liftLiners` now. It lifts as far as the fender allows: the arch gap reads -0.004 at the tire's outer shoulder, against the lip's inner edge, which the game's wheel clip hides. The cabin, reduced apart from the shell, stood 29 mm through the side at the windshield's top corner: `tuck_cabin` now pulls any cabin vertex a few cm outside the reduced shell 5 mm back inside it, for every car. 19,986 triangles.

Then the lamp-pass follow-ups (same day): the bumper's lip round the lower lamps' openings is reduced with the lamps (recipe `lamps`), since folded over the left lamp in the shell's collapse it made the lamp's round inner end read sheared; and the rear window's black splotches (the frit band and pillar trim just behind the glass, pulled through it by the collapse) are pushed back behind the glass for every car (`tuck_behind_glass`: trim vertices over the glass go 4 mm behind it, faces fanned across it from the seal go). The user's hand edits to the window (the rear wiper's pivot and some glass faces) are covered by that pass. A 1 to 5 mm slit along the top of each amber bumper lamp was in the build before and stays.

## 16. Nakaya Horizon lamps (2026-10-29)

The R33 donor is coarse (30,650 triangles, nothing to lose to the reduction) and its lamps are few: the headlamps an empty paint recess recoloured as one lens, a round fog lamp in each bumper pocket, four blobby round tail lamps, a red strip across the tail under them and one on the trunk under the wing, side repeaters on the fenders. Now the four round tail lamps glow, the lower strip is an unlit `Reflector`, the trunk strip the `BrakeLight`, and the single lit faces the recess left standing over the fender are paint. The recess is crumpled: at the lamps' tighter error every crumple was kept (and fitting it to a smooth surface warped its outline), so this car's lamps reduce at the shell's error (`lampError: 0.01`), which smooths it into the clean lens it shipped with. The donor has no cabin; `ship_donor` now keeps the shipped body's transplanted one (`interior()`) for such a donor, tucked inside the new shell. 18,901 triangles; arch gaps 0.090 / 0.124 as before. The result still did not look good enough (the coarse donor, the unfinished headlamps), so the car is hidden (`selectable: false` in the manifest): its engine voice, tuning, spec and recipe stay for a better R33 donor.

Follow-up the same day: the hood and bumper read faceted. Two causes: the export reshaded the body from its reduced geometry (now it keeps the source's normals, above), and the lower intake piece, cut from the first reduced car, carried that car's facets onto the bumper (it went; with the lamps and the shading kept, the reduction leaves the intake clean). The grille piece was trimmed to the bars and their back panel, cutting every shell face it hides (`save_pieces(..., whole=False)`), and the hood's leading edge over it is reduced with the lamps (recipe `lamps`), since the shell's collapse folded it into teeth.

## 17. Nakaya Grove (2026-10-30)

An eighth garage car, after a 180SX (RPS13, kouki Type X): BlackSnow02's "Nissan Silvia 180sx [Free]" (CC BY 4.0, 554,952 faces listed), the user's pick. Its author says "the base of this model is taken from the files", and the import shows a game mod's car: six switchable badge sets, a CA18DET engine bay, an Aston Martin DB11's brakes (`amdb11_*`), two generations of lamps with "lights off" textures, a roll cage with the suspension and exhaust in one material (`coupe`). Shipped on the Sketchfab licence at the user's call, as the Dalton Fiend was. Published 4,540 mm on a 2,475 mm wheelbase (length -1.0 %). A first build on InstaSky's 240SX (102,000 faces, a clean source) was replaced the same day at the user's request.

The suffixes are part of the material names (`RPS13_metaltrim.002` is the GT wing, `.001` the trim), so the recipe sets `rawNames`. Dropped: the wheels, brakes, badges, engine bay, the GT wing and its end plates (body colour islands); the cage material is parked on Trim so only the exhaust tip is kept. `debadge: False`: the badges are their own materials, and the passes took 466 islands (the tail lamps' reflector cups among them) and pressed 62 recesses.

The kouki tail is in layers: two round red lenses a side (outermost) and a clear housing round them in one textured material, the reflector body behind (`.002`, parked on Trim, since the texture pass matches names without their suffix). The lenses are faceted optics, faces a median 30 degrees off the lens's plane: no collapse reduces them (the lamp pass kept 17,000 of 24,800 triangles and left the shell 300), so they are culled for `discs`, which now take a yaw (the outer lens faces 15 degrees out where the tail wraps the corner). The housing is a clear `Lens`, the reflector body `Chrome`, the centre garnish black with the reverse lamps `ClearLens`. The pop-ups are closed; the slim lamp under each lid glows, the Type X bumper's signals are amber.

A third of the import is the mod's chassis in the trim's black (floor pan, frame rails, inner fenders): collapsed to the usual 60,000 first, the paint kept 8,500 triangles and the panels read faceted. The recipe raises the first pass (`midBudget` 120,000) and the shell (`shellBudget` 20,500, `carBudget` 30,000), culls the black faces that face the ground, and reduces the hood's louvred vent with the lamps. Dropping the chassis outright freed 1,300 more paint triangles but opened the wheel wells into the cabin, so it stays. The rear tubs sat on the tires (`liftLiners`); the cabin's carpet below the sills (seen through the slit between door and skirt) and the door cards' tops by the A pillars (2 to 3 cm through the glass) are culled, so the cabin is all inside the skin. 30,043 triangles (cabin 2,500), drift p95 2.6 mm, lost max 139 mm; arch gaps 0.046 / 0.002; track 1.382 (the drift wheels sit inboard). The donor's door handles are part of the door, so the audit counts none.

Re-reduced 2026-10-31 for the over-fender flares: at the shell's 1 % the collapse had bent the wheel arches up to 6 cm off the source's (round, symmetric to 2 mm), each side its own way, and a flare swept along them kinked. The arches' painted bands (Paint with |x| > 0.70, z > 0.30, 0.20 to 0.47 m from a wheel centre) are recipe `details` now, reduced with the lamps and mirrored, so the arch edge matches the source to 2 mm and the sides to the vertex; `lampBudget` 7,000 → 10,000, and 2,000 more for the shell (`shellBudget` 22,500, `carBudget` 35,000), since its Paint was 8,567 triangles against the Wendt Strom's 12,545 on a larger body (now 11,698). 35,050 triangles (cabin 2,499), drift p95 3.3 mm, lost max 139 mm; arch gaps 0.056 / 0.006; height 1.12 → 1.13 m in the manifest. The cabin's headliner front edge now shows about 1 cm in the slit between the windshield's top and the roof's black frame (the audit's one vertex out, at (−0.25, −0.138, 1.164)).

Rebuilt 2026-10-31 to carry parts like the Wendt Strom (the user: the flares fit poorly on panels that did not follow the source, the two sides were triangulated differently, and the underglow lit the cabin):
- **Symmetric body** (recipe `mirrorShell`): the source is mirror-symmetric where it matters (rays from both sides: p50 0.09 mm, p95 14 mm; its vertices to the mirrored surface p50 0.04, p95 12.9, max 61 mm: the kit's skirts sit 13 mm further out on the right, the rear tubs 11 mm, a fuel door on the right rear quarter), so the shell is reduced as its +x half and mirrored; the shipped body before was p50 1.5, p95 29 mm off its own mirror. Now every vertex outside the cabin has its twin within 0.01 mm (two seam vertices 0.55 mm), the cabin stays right hand drive, and the one exhaust tip stays on the left (`unmirrored`). The -x side's drift against the source is the source's own asymmetry (Paint p95 8.1 mm, max 61, against 1.2 and 6 on +x).
- **Underglow**: rays up from the road met the cabin's Interior in 261 of 697 cells and the glass in 46 (the recipe culled every downward black face below 0.45 m, the floor pan's underside with the aprons'). The pan's underside behind the front wheels stays, the cull looks from below (`fromBelow`, which kept a closing plate between the pan's edge and each sill), black quads close the tunnel's shifter and handbrake holes and the rear seat's step on the seam (`underPanels`), strips close the rear tubs' inner slits over the tires (`underStrips`), and the cabin pieces poking through the tubs, down in the spare wheel well and at the right kick panel (through the door's front shut line) are culled. Now none of 16,281 rays straight up (2 cm grid) and none of 6,273 angled ones meets Interior or Glass; the 30 that meet nothing pass the rounded nose and tail corners outside the body's plan and the hood's louvred vent (the engine bay, dropped with the donor's engine, is open to the hood).
- **Stock pieces** (recipe `split`, `split_donor`, run by `ship_donor`): the game mod car models every panel as its own shell, so each piece is whole islands and parts on the car's own shut lines (parts skill section 6): `Bumper_Front`, `Bumper_Rear`, `Skirts` (the sill moulding and the band over each door's bottom), `Fenders`, `Hood`, `Headlights` (the pop-up units whole, lid and all), `Taillights` (the kouki bar and garnish, the panel's rim left), `Mirrors`, `Exhaust`. No `Roof` or `Spoiler`: the roof is one panel with the pillars and the hatch's lip has no island of its own.
- **Budget**, measured at three shells with the pieces cut (the chassis takes about 60 % of every triangle added: the collapse spends by error, and the mod's floor pan, rails and radiator are detailed): 22,500 (car 35,099: Paint about 11,100, bumper 2,368, hood 912, fenders 1,672, mirrors 406) read faceted on the bumper corners, hood and arches beside the R32 at the garage's three-quarter; 30,000 (car 42,562: Paint 13,968, bumper 3,018, hood 996, fenders 1,762, mirrors 712) is smooth there; 38,000 (car 50,589: Paint 17,472, bumper 3,480, hood 1,150) adds little the eye sees. Shipped at `shellBudget` 30,000, `carBudget` 43,000: 42,558 triangles (cabin 2,499), drift p95 9.0 mm (the mirrored side against an asymmetric source; +x Paint 1.2), lost p95 11.2 mm, max 176 mm (the right quarter's fuel door and the skirt's offset). Reducing the chassis apart at a coarse error was tried and dropped: its many small open pieces kept 6,300 of 15,300 triangles at 2 % and the collapse opened the tunnel. The manifest's length went 4.49 → 4.50 (the pipeline's measure), so the Grove's replays and bests changed.
- The flares, rebuilt from their recorded calls on the new pieces, came out within 0.4 mm p95 of the shipped ones (7 mm at one bolt head): the arches were already the mirrored `details` bands, which the new shell leaves as they were.

| Node | Grove 22,500 | Grove 30,000 (shipped) | Grove 38,000 | Wendt Strom | Shipped / R32 |
|---|---|---|---|---|---|
| Body | 23,155 (with the tail bar) | 25,054 | 33,553 (with the tail bar) | 18,731 | 1.34 (the mod's chassis: 19,000 of the Grove's car is Black) |
| Bumper_Front | 2,368 | 3,018 | 3,480 | 3,261 | 0.93 |
| Bumper_Rear | 866 | 1,284 | 1,988 | 1,077 | 1.19 |
| Skirts | 770 | 1,062 | 1,522 | none cut | |
| Fenders | 1,672 | 1,762 | 1,908 | 936 | 1.88 (the Grove's wings run down behind the arch to the sill) |
| Hood | 912 | 996 | 1,150 | 1,343 | 0.74 |
| Headlights | 3,302 | 3,642 | 4,056 | 5,122 | 0.71 |
| Taillights | 1,530 (without the bar) | 4,910 | 1,652 (without the bar) | 1,911 | 2.57 (the clear covers, 2,324) |
| Mirrors | 406 | 712 | 1,162 | 2,996 | 0.24 |
| Exhaust | 118 | 118 | 118 | 319 | 0.37 (one tip, eight sided) |
| Car | 35,099 | 42,558 | 50,589 | 40,985 (with its switch nodes) | 1.04 |

At 22,500 and 38,000 the tail bar's island stayed on the body (the split rule then refused any island with Paint; the bar is about 3,300 triangles).

## Donor credits

| Car | Model | Author | Licence |
|---|---|---|---|
| Wendt Strom R6 (was Proto Hatch) | 2002_volkswagen_golf_r32_mk4 (VW Golf R32 Mk4) | tangwang920 | CC BY 4.0 |
| Kazama Rotor (was Proto Coupe) | Mazda RX7 FD 1999 | niev | CC BY 4.0 |
| Albrecht Kombi S (was Proto Wagon) | 1992 Audi S2 Avant | tonielpro520 | CC BY 4.0 |
| Dalton Fiend (was Proto Muscle) | Dodge Challenger SRT DEMON SDC (2018 Challenger SRT Demon, widebody) | SDC PERFORMANCE (Lambo_SC04) | CC BY 4.0 |
| Nakaya Horizon GT | Nissan Skyline R33 GT-R (1995 to 1998 R33 GT-R) | greddy295 | CC BY 4.0 |
| Tachibana Zenith | Toyota Supra MK IV (1994) | TinoD2 | CC BY 4.0 |
| Tachibana Runabout | 1996 Toyota MR2 W20 | s0h1o9b | CC BY 4.0 |
| Nakaya Grove | Nissan Silvia 180sx [Free] (180SX Type X, RPS13) | BlackSnow02 | CC BY 4.0 |

The first set (2026-10-21: an RS6 C8, a WRX STI hatch, an RSX Type-S and a Supra MK4) was replaced on 2026-10-22: three of its four licences were NonCommercial. The Proto Compact went with them.
