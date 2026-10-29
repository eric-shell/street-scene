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

Two traps seen on the RX-7:
- **Layers a few mm apart fold through each other** at the lamps' error (13 mm): the pop-up bucket's ceiling came through the lid in black patches. Recolour the hidden layer to the colour of the one over it, and keep anything seen from the front (the bezel's lip) as it was: `c.y` past the lens is a good split.
- **A fussy lamp is better replaced than kept**: four red blocks in a black pocket became one `strips` entry, a thin `BrakeLight` strip on a mirrored curve measured off the pocket's top edge (rays from behind at a few x, 6 mm under the edge, 1 cm tall).
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
| `debadge` | `False` skips the badge island passes: for a donor whose badges are materials of their own (drop them in `materials`) and whose grilles are meshes of thousands of small flat cells, which the passes take for badges and press flat (the R33's: 2,423 islands) |
| `bridges` | boxes `(lo, hi)` across a gap in the grille's bars: a `cull` or a badge mount cut them where it sat. The faces centered in the box go, then each bar end on the box's left face is lofted to its match on the right (same material, nearest z), so the bar runs across in one piece (the Golf's two bars, in front of the black panel behind them) |
| `rawNames` | the donor's materials are `Material.001`, `Material.002`: the `.001` suffix is the name, so classification must not strip it (the Runabout's) |
| `texture`, `textureCuts`, `textureClass` | lamps painted in a texture over their geometry: regexes of the material names whose base colour classes each face (`lamp_colour`, or the recipe's `textureClass`), ahead of and behind the axles; `textureCuts` `(axis, value)` cut those faces along the texture's bands first (x mirrored) |
| `liftLiners` | `True`: raise wheel well liners on or through the tire clear of it after the reduction (`lift_liners`; the Albrecht Kombi's rear) |
| `pieces` | `True`: splice the car's kept hand-made pieces (`save_pieces`, `<cid>.pieces.glb`) into the reduced shell, for work no rule can express (the Golf's grille and lower intake) |
| `discs` | `(center, radius, material)`: a flat round lens added after the reduction, for a round lamp the collapse leaves polygonal (cull the donor's own); a round part is rebuilt, never collapsed (the RX-7's bumper lamps) |
| `strips` | `(points, height, material)`: a thin lamp strip along a curve, mirrored across the middle, added after the reduction (the RX-7's third brake light in place of the donor's four blocks) |
| `backPanels` | boxes `(x0, x1, y, z0, z1)`: a flat black quad facing the nose behind an opening the pipeline's own grille quads miss (a lower intake with a crossbar in it), added after the reduction |

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

### Hand edits go in the recipe

A reimport rebuilds the car from the donor, so an edit made by hand to the shipped mesh is lost the next time. Every fix belongs in the recipe, where the next rebuild makes it too:
1. Let the user edit a copy of `donor:<cid>.Low` (a study copy in its own materials is fine).
2. `edit_diff(cid, '<edited object>')` prints the faces removed, added and recoloured, in clusters with bounds, and for each removed cluster the `.Full` islands it reaches: a whole island is an `islands` rule (`set(mats) == {...} and k < N` and its center in a box), part of a larger one a `cull` box on the face centers.
3. Write the rules, rebuild, and check the edited spots hold nothing (count the faces left in each box) before shipping.

The RX-7's hand edits all went this way: wiper blades and the antenna base (`islands`), the windshield seal's folded edge and the mirror mount's top (`cull`), the decklid lock (`patches`, with a small ring).

## 6. Ship

`ship_donor(cid, work)` does the first step for a car already shipped (same donor, same wheelbase and track): it copies `donor:<cid>.Low` into `<cid>.Body` (loading the car's collections from its `.blend` when the session lacks them), drops the `src_normal` and `own_normals` attributes, runs `remap_materials`, saves a copy of the session at `work` without touching the session's own file, and prints the two commands that finish it. Re-shipping an unchanged build this way gives a byte-identical GLB. For a new car, copy `donor:<cid>.Low` into `<cid>:Car` as `<cid>.Body` by hand the same way and put the Rig empties at the donor's own wheelbase, track and tire radius. Then:
1. Save a working copy and run `saveCar.py` headless.
2. Run `npm run assets` and `npm run validate`. `exportCar.py` reshades every car mesh as it exports (`SHADE_ANGLE_DEG`): edges sharper than 35 degrees split, the rest smoothed with face-area weights. The authored normals `shade_from_source` sets do not survive later hand edits (a bmesh round trip drops them), and plain smooth normals on a 16,000 triangle shell tilted the hood's corners 30 to 40 degrees off their faces: the panel's reflection swung across it and went black at some angles. Wheels keep their own shading.
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

## 15. Albrecht Kombi lamps (2026-10-29)

The third car through the lamp pass, and the quickest: its lamps are modelled in named layers, so the recipe maps materials and adds four position rules. Clear `lights_glass` and `detail_glass_clear` are `Lens`; under them the headlamps glow whole (reflector bowl, projector, bulbs) but for their outer corner, the indicator (`Light`); in the bumper the inner lamp (the fog lamp and its round lens) glows and the outer is an indicator. At the rear the red glass runs across the tailgate from the corner lamps: the lamps glow (the corners and the tailgate's ends out from |x| 0.31), each reverse lamp (|x| 0.31 to 0.38) is bright `Chrome`, the centre panel an unlit `Reflector`. The donor's own textures are not in the import, so the classes were judged by geometry in the study colours.

The shipped file's hand fix, the rear liners lifted off the tires (2026-10-27), is the recipe's `liftLiners` now. It lifts as far as the fender allows: the arch gap reads -0.004 at the tire's outer shoulder, against the lip's inner edge, which the game's wheel clip hides. The cabin, reduced apart from the shell, stood 29 mm through the side at the windshield's top corner: `tuck_cabin` now pulls any cabin vertex a few cm outside the reduced shell 5 mm back inside it, for every car. 19,986 triangles.

Then the lamp-pass follow-ups (same day): the bumper's lip round the lower lamps' openings is reduced with the lamps (recipe `lamps`), since folded over the left lamp in the shell's collapse it made the lamp's round inner end read sheared; and the rear window's black splotches (the frit band and pillar trim just behind the glass, pulled through it by the collapse) are pushed back behind the glass for every car (`tuck_behind_glass`: trim vertices over the glass go 4 mm behind it, faces fanned across it from the seal go). The user's hand edits to the window (the rear wiper's pivot and some glass faces) are covered by that pass. A 1 to 5 mm slit along the top of each amber bumper lamp was in the build before and stays.

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

The first set (2026-10-21: an RS6 C8, a WRX STI hatch, an RSX Type-S and a Supra MK4) was replaced on 2026-10-22: three of its four licences were NonCommercial. The Proto Compact went with them.
