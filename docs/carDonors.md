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
- dropped: tire, rim, wheel, brake, interior, seat, engine, badge, emblem, licence and plate, ground and shadow;
- `Glass`, lamps, `Paint`, `Chrome` and `Black` by their usual words.

A recipe adds only what that donor needs:

| Field | When |
|---|---|
| `materials` | material names `AUTO` gets wrong or cannot read (`Material.023`); regex to a shared material, `'Lamp'` or `None` (drop) |
| `tires` | the tire material, when it is not named tire or tyre (the axles, the scale and the track come from it) |
| `drop` | whole meshes to drop by object or parent name |
| `nose` | `'+y'` when the model faces +Y |
| `patches` | boxes to remove (`flush=False`: a roof plate) or press flush into the panel (sunroof, fuel door) |
| `recolor`, `cull` | face fixes after the join (a glass roof to `Paint`) |

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
- assigns lamps by position: ahead of the axles `HeadLight`, behind them `TailLight`, between them `Light`;
- removes badges on the nose and tail, thin decals anywhere on the body, wipers and antennas, and applies the recipe's patches.

`reduce_donor()` does this:
1. Collapses to 60k triangles. Both collapses are meshoptimizer's simplifier (`scripts/blender/meshopt.py`, run in Node from the npm package by `scripts/meshoptSimplify.ts`; nothing to install, but `node` must be findable: PATH, `$NODE`, or nvm/Homebrew). It weighs the authored normals and keeps material edges. It stops at 1 % of the car's size rather than tear a part off, and the Decimate modifier's mirror-symmetric collapse finishes the rest. `REDUCER = 'blender'` in `carDonors.py` goes back to Decimate alone.
2. Culls every face that cannot be seen from outside: jambs, flanges, double layers and inner glass.
3. Collapses to `BUDGET`.
4. Sets the authored normals back on the reduced faces, matched within the same material.
5. Turns the front grilles into the shared `Grille` material:
   - each grille patch is pressed flat onto its own plane;
   - logos and lettering inside a grille become grille;
   - the faces keep flat normals, so slats and emblems are not shaded back in.

   The game draws one pattern on it (`GRILLE_PATTERN` in `src/render/car/carMaterials.ts`: ribs, diamond mesh or honeycomb) as a bright metal texture with raised bars. Every car's grille reads the same at no triangle cost.

## 5. Check

- **Scale:** the length within 2 % of published. More means the wrong tire material or a wrong published figure.
- **Look:** side, front and rear sheets, then one three-quarter view. Look for:
  - blotches on the panels;
  - dark wedges on the glass;
  - holes;
  - lamps missing or on the wrong end;
  - leftover wipers, plates or antennas.
- **Budget:** about 8,000 triangles; drift p95 under 3 mm. Drift only measures the kept vertices, so also read **lost** (the skin's vertices to the reduced surface): a high lost max is a part collapsed away, such as a mirror or a lip.

## 6. Ship

Copy `donor:<cid>.Low` into `<cid>:Car` as `<cid>.Body`. Drop the `src_normal` and `own_normals` attributes and run `remap_materials`. Put the Rig empties at the donor's own wheelbase, track and tire radius. Then:
1. Save a working copy and run `saveCar.py` headless.
2. Run `npm run assets` and `npm run validate`.
3. Look at the car in the garage.

A new car also needs a manifest entry, its `drivingParams.json` block and the car-list tests.

## 7. Reproducibility test (2026-10-21)

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
| Proto Wagon | Audi RS6 C8 | Brahekoss123 | CC BY 4.0 |
| Proto Hatch | 2011 Subaru Impreza WRX STI hatchback | ddiaz-design | CC BY-NC-SA, **replace before release** |
| Proto Compact | 2002 Acura RSX Type-S | ddiaz-design | CC BY-NC-SA, **replace before release** |
| Proto Coupe | Toyota Supra MK4 | Pooya_dh | CC BY-NC, **replace before release** |
