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
- **Trademarks** are separate from the model's licence. A CC licence covers the 3D model, not the carmaker's name, badges or logo. The pipeline removes badges; cars ship under Proto names.

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
- `Glass`, lamps, `Paint`, `Chrome` and `Black` by their usual words.

Names are matched without Blender's `.001` suffix, so several donors can sit in one session.

A recipe adds only what that donor needs:

| Field | When |
|---|---|
| `materials` | material names `AUTO` gets wrong or cannot read (`Material.023`); regex to a shared material, `'Lamp'` or `None` (drop) |
| `tires` | the tire material, when it is not named tire or tyre (the axles, the scale and the track come from it) |
| `drop` | whole meshes to drop by object or parent name |
| `nose` | `'+y'` when the model faces +Y |
| `turn` | Euler degrees (XYZ) that stand a model lying on its side up Z-up, before `nose`: `(-90, 0, 0)` for one with -Y up facing -Z |
| `patches` | boxes to remove (`flush=False`: a roof plate) or press flush into the panel (sunroof, fuel door) |
| `recolor`, `cull` | face fixes after the join (a glass roof to `Paint`) |
| `islands` | loose islands to delete after the join, `pred(faces, lo, hi, materials)`: what `cull`'s face boxes would cut too wide (wiper arms over a black cowl, an antenna) |

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
- turns the car to face -Y;
- scales it to the published wheelbase, then checks its length against the published one;
- keeps the authored normals as an attribute; flat-shaded sources are smoothed at 30 degrees first;
- assigns lamps by position: ahead of the axles `HeadLight`, behind them `TailLight`, between them `Light`, and well inboard between the axles (a dome or dash lamp) `Interior`;
- removes badges on the nose and tail, thin decals anywhere on the body, wipers and antennas, and applies the recipe's patches;
- removes the hub hardware whose materials gave nothing away (the RX-7's lug nuts and calipers were plain black and chrome): loose islands inside the tires' cylinders, out at the track.

`reduce_donor()` does this:
1. Collapses to 60k triangles. Both collapses are meshoptimizer's simplifier (`scripts/blender/meshopt.py`, run in Node from the npm package by `scripts/meshoptSimplify.ts`; nothing to install, but `node` must be findable: PATH, `$NODE`, or nvm/Homebrew). It weighs the authored normals and keeps material edges. It stops at 1 % of the car's size rather than tear a part off, and the Decimate modifier's mirror-symmetric collapse finishes the rest. `REDUCER = 'blender'` in `carDonors.py` goes back to Decimate alone.
2. Culls every face that cannot be seen from outside: jambs, flanges, double layers and inner glass. Glass does not block the test rays, so the cabin behind the windows counts as seen, as it is in the game.
3. Collapses the shell to `BUDGET` (16,000) and the cabin apart to `INTERIOR_BUDGET` (2,500): the cabin touches nothing of the shell, and in one collapse its 30,000 triangles of seats and dash would starve the mirrors and handles. Small features are what an error-driven collapse eats first, so a part that must survive gets its own budget (the wheel set does the same per kind: `docs/carWheels.md`).
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
- **Budget:** 16,000 triangles for the shell plus up to 2,500 of cabin; drift p95 under 1 mm. Drift only measures the kept vertices, so also read **lost** (the skin's vertices to the reduced surface): a high lost max is a part collapsed away, such as a mirror or a lip.
- **Winding:** look with backface culling on (`shading.show_backface_culling` on the viewport). The game draws most car materials double sided but not `Rim` or `Tire`, and a car wound inside out shades dark; Blender's default viewport hides both faults.

## 6. Ship

Copy `donor:<cid>.Low` into `<cid>:Car` as `<cid>.Body`. Drop the `src_normal` and `own_normals` attributes and run `remap_materials`. Put the Rig empties at the donor's own wheelbase, track and tire radius. Then:
1. Save a working copy and run `saveCar.py` headless.
2. Run `npm run assets` and `npm run validate`.
3. Look at the car in the garage.

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
- **No cabin:** interiors are dropped and nothing fills them yet.

## Donor credits

| Car | Model | Author | Licence |
|---|---|---|---|
| Proto Hatch | 2002_volkswagen_golf_r32_mk4 (VW Golf R32 Mk4) | tangwang920 | CC BY 4.0 |
| Proto Coupe | Mazda RX7 FD 1999 | niev | CC BY 4.0 |
| Proto Wagon | 1992 Audi S2 Avant | tonielpro520 | CC BY 4.0 |

The first set (2026-10-21: an RS6 C8, a WRX STI hatch, an RSX Type-S and a Supra MK4) was replaced on 2026-10-22: three of its four licences were NonCommercial. The Proto Compact went with them.
