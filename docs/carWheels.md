# Wheels from donor models

How a Street Scene wheel is made from one real rim model. The rim comes from the donor; the tire, the barrel and lip, the center cap, the size and the construction are the house's. So every wheel fits every car the same way and differs only in its face. The mechanics are `scripts/blender/carWheels.py`; the car body process this follows is `docs/carDonors.md`.

## 1. Pick a donor

- **Licence:** the same rules as cars (`docs/carDonors.md`). CC0 or CC BY only, downloadable on Sketchfab. Check the model really contains the wheel: some "packs" on Sketchfab are a picture on a plane with the real files sold elsewhere, under terms of their own.
- **The face is what matters.** The tire, barrel and lip are replaced, so a donor is judged by its spokes and hub. 3k to 60k triangles reduces well.
- **Branding:** real wheel makers' names (BBS, Work, Mugen, Enkei, ...) never ship. Each wheel gets a fictional tuner name (`displayName`), and logos on caps are covered by the house cap.

Record the donor in `WHEELS` in `carWheels.py`: its name, uid, author and licence. Credit the author in the README.

## 2. Import

```
import_asset(source='sketchfab', id=<uid>, target_size=0.65)
```

The size is irrelevant: the wheel is scaled to the house tire.

## 3. Run

```python
exec(open(REPO + '/scripts/blender/carKit.py').read())
exec(open(REPO + '/scripts/blender/carRefs.py').read())
exec(open(REPO + '/scripts/blender/carDonors.py').read())
exec(open(REPO + '/scripts/blender/carWheels.py').read())
wheel('<name>', '<import root>')    # -> wheels.wheel_<name> in collection wheels:Wheels
wheel_report(list(WHEELS))
```

Material names on wheel models carry no meaning (`Material.026`, `blinn1`, `MainColor`), so `wheel()` works from geometry:

1. **Gather:** joins every mesh in world space. It drops scene junk by whole-word names below the import root (stand, ground, plane, shadow, logo, badge, decal, brake, caliper, disc, rotor), plus anything in the recipe's `drop`. It keeps the authored normals.
2. **Frame:** the axle is the axis the other two are round about. The wheel is turned so the axle is X and centered.
3. **Tire out:** an island reaching the outer radius whose tread covers the middle of its width is the source tire, and it goes. A rim lip reaches the outer radius only at its edges.
4. **Face +X:** the hub and spokes lean their normals toward the face side; the wheel is flipped if needed.
5. **Fit:**
   - scaled so the rim lip sits on the house tire's bead (lip radius = 0.74 × tire radius, a 16 inch rim on the 0.28 m tire);
   - squeezed along the axle to fit the tire's 0.24 m width;
   - the face set just inside the sidewall.
6. **Dish, barrel and lip out:** walking in from the lip, the first radius where the face no longer covers every angle is where the spokes begin (`dish_start`). Everything outside it goes, because a collapse crumples round surfaces.
7. **House center cap:** a disc at 0.2 × the lip radius, just proud of the hub. It covers any logo; whatever stands in front of it goes.
8. **Reduce:** culls what cannot be seen from the face side, collapses the donor face to `RIM_BUDGET`, and sets its authored normals back on the reduced faces.
9. **House parts:**
   - a **house ring** (lip edge and barrel) turned at 40 segments, stepping down to the spokes' depth on a deep dish;
   - the **house tire**, a lathed profile with rounded shoulders.

   Both are smooth shaded about the axle.

Materials: rim and ring `Rim` (the player's wheel colour), cap `Chrome`, tire `Tire`. The game finds the bead where the `Tire` mesh meets the rest, so the size slider works on every wheel (`src/render/car/wheelFit.ts`).

## 4. Recipe overrides

Most wheels need none. The fields:

| Field | When |
|---|---|
| `drop` | scene pieces the junk words miss (a backdrop named `Material.026`) |
| `dish` | where the spokes end, as a share of the lip radius, when a stepped or curved dish breaks the coverage test (0.7 to 0.75 typical) |
| `face` | `1` or `-1` when the face direction comes out wrong |
| `tire` | anything but `'auto'` to keep the source's outer faces |

## 5. Check

`wheel_report()` prints triangles per material, the rim's depth and the lip radius; every lip should read 0.207. Look at the set face on, side by side. Look for:
- a crumpled ring between spokes and lip (set `dish`);
- spokes floating in front of or behind the ring;
- a face pointing inward;
- leftover scene pieces;
- logos showing around the cap.

## 6. Ship

1. Run `saveCar.py` headless with `wheels` as the id, writing `assets/source/eshell/wheels/wheels.blend`. It keeps only the `wheels:Wheels` collection.
2. Run `npm run assets`: the wheel set is exported by `exportCar.py` (wheels-only mode) and cataloged as universal wheels `wheel_<name>`.
3. Set each car's `defaultWheel` in the manifest.
4. A retired wheel id goes in `RENAMED_WHEELS` (`src/shared/carBuild.ts`), so saved builds and share codes keep a wheel.

## 7. First set (2026-10-21)

Eight donors from five authors, covering mesh, multi-spoke, deep dish, three-piece, steel, wire, concept and five-spoke designs. Every wheel is 2,740 to 2,820 triangles: the donor face is about 1,300, the ring 480, the tire 960 and the cap 20. The game's wheel budget is 3,500.

| Wheel | Donor (author) | Overrides | Notes |
|---|---|---|---|
| Kiba | BBS RS16 style mesh (TinoD2) | `drop` backdrop, `dish` 0.74 | display scene in the file |
| Hoshi | Mugen M7 style seven spoke (TinoD2) | none | display stand dropped; a little crumple left on the outer step |
| Rensa | Work Equip 03 style deep dish (TinoD2) | none | dish detected; logo plane dropped |
| Tsuki | Work Meister S1 style three piece (alexanderlyreo) | `dish` 0.74 | no source tire |
| Ginga | Stance steel 13x10 (terllok) | `dish` 0.7 | |
| Hibana | Wire rim (3dpeter) | none | dish detected, spokes kept |
| Senko | Concept rim (LagzDesign) | none | |
| Arashi | Five spoke rim (UnforgettableName) | none | no source tire |

Learnings:
- **Material names cannot be trusted on wheels.** Geometry (round axes, radial bands, tread coverage) classifies every wheel the same way.
- **Scenes come along.** Three of eight files carried a display stand, a logo plane or a backdrop, which set the import's size. Junk words must match whole words only: `MaterialStandart` is a rim and `GLTF_SceneRootNode` holds everything.
- **Round surfaces do not survive a collapse.** Replacing the tire, barrel and lip with turned house parts made the biggest visual difference, and gives every wheel the same tire and lip.
- **Deep dishes need the step.** The house ring starts where the face stops covering every angle and steps down to the spokes' depth. Three wheels with stepped or curved dishes needed a `dish` override.
- The 18-wheel pack originally proposed is a picture on Sketchfab; its files are sold separately, so it was not used.

Open:
- Hoshi's outer step still crumples.
- Lug nuts and the cap read the same colour as the rim; a `Chrome` or `Black` detail pass on the hub would add depth.
- A lower-detail version for traffic: the house parts scale down by segment count.

## Credits

| Wheel | Model | Author | Licence |
|---|---|---|---|
| Kiba | BBS RS16 Tuner Car Wheel | TinoD2 | CC BY 4.0 |
| Hoshi | Mugen M7 Tuner Car Wheel | TinoD2 | CC BY 4.0 |
| Rensa | Work Equip 03 Car Wheel | TinoD2 | CC BY 4.0 |
| Tsuki | Work Meister S1 3P Wheel | alexanderlyreo | CC BY 4.0 |
| Ginga | Stance Wheel R13x10" | terllok | CC BY 4.0 |
| Hibana | Wire rim | 3dpeter | CC BY 4.0 |
| Senko | Concept car Rim | LagzDesign | CC BY 4.0 |
| Arashi | Car Wheel / rim | UnforgettableName | CC BY 4.0 |
