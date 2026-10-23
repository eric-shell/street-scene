# Wheels from donor models

How a Street Scene wheel is made from one real wheel model. The wheel is kept as the wheel it is (its face, its lip and barrel, its bolt circle); the tire, the size and the bolt heads are the house's, so every wheel fits every car the same way. The mechanics are `scripts/blender/carWheels.py`; the car body process this follows is `docs/carDonors.md`.

## 1. Pick a donor

- **Licence:** the same rules as cars (`docs/carDonors.md`). CC0 or CC BY only, downloadable on Sketchfab. Check the model really contains the wheel: some "packs" on Sketchfab are a picture on a plane with the real files sold elsewhere, under terms of their own.
- **Clean showpiece models reduce best.** The current set is all by one author (jonver87's Work series): no tire, each piece its own mesh, and most of the triangles in bolt hardware, which the pipeline replaces anyway. 36k to 650k triangles.
- **Branding:** real wheel makers' names (BBS, Work, Mugen, Enkei, ...) never ship. Each wheel gets a fictional tuner name (`displayName`); badge planes, their glass and lettering are flat and go as decals. A name embossed in the face itself (the Equip 02's small "Equip" on its plate) survives, too small to read at game scale.

Record the donor in `WHEELS` in `carWheels.py`: its name, uid, author and licence. Credit the author in the README and in the settings' credits (`DONOR_CREDITS`).

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
wheel_sheet(list(WHEELS))           # linked copies in a grid, facing front, for a look
```

Material and object names on wheel models carry no meaning (`Material.026`, `Object_12`), so `wheel()` works from geometry:

1. **Gather and weld:** joins every mesh below the import root in world space, dropping scene junk by whole-word names (stand, ground, plane, shadow, logo, badge, decal, brake, caliper, disc, rotor, valve) plus anything in the recipe's `drop`, keeps the authored normals, and welds coincident vertices: several models arrive shattered into thousands of islands.
2. **Frame:** the axle is the axis the other two are round about. The wheel is turned so the axle is X and centered.
3. **Classify every island** by where it sits, in shares of the lip radius: `decal` (flat: badge planes, glass, pinstripes) goes; `ring` reaches the lip radius and never comes inside 0.6 (the lip and the barrel); `cap` sits in the hub; `bolt` is a narrow band out on the dish (0.55 to 0.97), confirmed below; everything else is `face` (spokes, hub, flanges). A one-piece wheel's lip is part of its face island: the coverage test (walking in from the lip, the first radial band whose front faces do not cover every angle) finds where its dish ends and turns everything outside it as a ring.
4. **Face +X:** a badge or its glass in the hub faces the front; without one, the spokes' and hub's area weighted normals lean toward it. Neither is sure (a flat face plate votes both ways), so look at every wheel and set `face` where it is wrong.
5. **Fit:** scaled so the lip edge sits on the house tire's bead (0.74 × tire radius, a 16 inch wheel on the 0.28 m tire); the lip edge set just proud of the tire's sidewall (`X_LIP`); the visible depth from lip edge to face kept, and only the barrel behind the face, which the tire hides, squeezed to end at the tire's back bead (`X_BACK`).
6. **Bolt circles:** the bolt islands are grouped by radius; a group with a periodic angular histogram is a circle of bolts, its peaks the count. The frontmost circle becomes house hex heads (18 triangles each) at its own angles, radius and depth; rear nuts and the donor's hardware go. A flange ring without bolts on it stays face.
7. **Reduce:** each kind on its own, so a 500,000 triangle bolt ring cannot starve the spokes: a first collapse to three times the budget, the hidden face test against the whole wheel with the tire in place (faces no view from the front half sees go: the barrel under the tire, the backs of the spokes), then the collapse to `BUDGETS` (face 6,000, cap 700) with the donor's authored normals set back on the reduced faces (`shade_from_source`).
8. **Turn the ring:** the culled ring's visible surface, sorted by its angle from a viewpoint in front of the wheel (one ray, one point: the surface's own order, steps and all) and binned into 26 points, is lathed at 56 segments. A collapsed ring crumpled at any budget; a lathe never does.
9. **House parts:** a chrome disc over a hub nothing covers (the donor's cap was a decal); the **house tire**, a lathed profile with rounded shoulders at 40 segments (960 triangles), smooth shaded about the axle.

Materials: face and hub `Rim` (the player's wheel colour), lip and barrel `Chrome` (Work lips are polished; `lip: 'rim'` for a painted one-piece), bolts and caps `Chrome`, the tire `Tire`; a source material named black stays `Black` (the Equip 02's slot walls). The game finds the bead where the `Tire` mesh meets the rest, so the size slider works on every wheel (`src/render/car/wheelFit.ts`); Stretched is lathed at runtime in the house tire's place (`src/render/car/tireShapes.ts`).

## 4. Recipe overrides

Most wheels need none. The fields:

| Field | When |
|---|---|
| `face` | `1` or `-1` when the face direction comes out wrong (the barrel shows in front) |
| `lip` | `'rim'` for a painted one-piece lip; `'chrome'` is the default |
| `drop` | a regex of material or object names the junk words miss |
| `bolts` | `0` to keep no bolt circle |

## 5. Check

`wheel_report()` prints triangles per material and the wheel's depth and lip; every lip reads 0.207. `wheel_sheet()` lays the set out facing front; look at it in solid and material shading, from the front and from 60 degrees. Look for:
- a wheel showing its barrel (set `face`);
- a bolt count off by one or two (the histogram peaks; usually fine) or bolts where there are none (`bolts: 0`);
- a lip profile with a kink (a leftover piece of hidden barrel: `drop` it);
- a hub left open (the house cap should have filled it).

## 6. Ship

1. Save a working copy (`bpy.ops.wm.save_as_mainfile(filepath=..., copy=True)`), then `saveCar.py` headless with `wheels` as the id, writing `assets/source/eshell/wheels/wheels.blend`. It keeps only the `wheels:Wheels` collection.
2. Run `npm run assets`: the wheel set is exported by `exportCar.py` (wheels-only mode) and cataloged as universal wheels `wheel_<name>`.
3. Set each car's `defaultWheel` in the manifest.
4. A retired wheel id goes in `RENAMED_WHEELS` (`src/shared/carBuild.ts`), mapped to the new wheel nearest its style, so saved builds and share codes keep a wheel.

## 7. The Work set (2026-10-22)

Twelve wheels, one author, mesh, multi-spoke, five spoke, slotted dish and fine spoke designs, one-piece and multi-piece. Each is 9,000 to 11,500 triangles: the face 6,000, the turned ring 2,000 to 3,000, bolts 200 to 800, the tire 960. The game's wheel budget is 12,000.

| Wheel | Donor | Construction | Notes |
|---|---|---|---|
| Kumo | Work VS-TX | 3 piece, 44 bolts | mesh face; 480k triangles of bolts replaced |
| Yari | Work Equip 03 | 2 piece, 12 bolts | eight spoke, stepped lip |
| Tsume | Work Equip 40 | 2 piece, 12 bolts | four spoke |
| Hari | Work Emitz | 40 bolts | 40 fine spokes deep in a 12 cm dish |
| Kasumi | Work VS-KF | 3 piece, 19 bolts | mesh; shattered into 40,000 islands before the weld |
| Raiden | Work VS-XV | 3 piece, 39 bolts | mesh |
| Ryusei | Work VS-XX | 3 piece, 45 bolts | mesh, bolt flange proud of the face; `face: -1` (its badge sits behind the hub's center) |
| Shinobi | Work Zistance W5S | 3 piece, 45 bolts | five spoke, bolts on the flange behind the spokes |
| Tsurugi | Work Schwert SC2 | 2 piece, 20 bolts | ten spoke |
| Kaze | Work Equip 02 | one piece | four slot plate at the back of a polished dish; the slot walls `Black` |
| Hagane | Work Euroline DH | 3 piece, 20 bolts | five window dish |
| Kagero | Work Import Label AL4 | one piece | mesh; house cap |

Why the first set was scrapped (eight donors from five authors, 2026-10-21): it collapsed each face to 1,300 triangles (40 spokes became mush, mesh faces shattered) and replaced the lip and barrel with a house ring from a guessed dish radius, which cut off spoke tips and erased every lip's character. No wheel looked like its model.

Learnings:
- **Material names cannot be trusted on wheels.** Islands classified by radius, thickness and count sort every wheel of the set the same way.
- **Bolts are most of a wheel model.** 50 to 80 % of a Work model's triangles are its bolt circles; counted from the angular histogram and rebuilt as hex heads they cost 200 to 800.
- **Round surfaces do not survive a collapse.** The lip and barrel turned from the measured profile was the biggest visual difference, at any budget.
- **The front cannot be told from the ring.** A deep dish and a deep barrel look the same to geometry; the hub's badge decides when there is one, and the recipe's `face` otherwise.
- **Weld first.** Three models arrived as thousands of loose islands (one 12,000 island bolt ring); without the weld the collapse refuses to touch open borders.
- **Check winding with backface culling on.** The game draws `Rim` single sided; Blender's viewport does not, so a wheel wound inside out looks whole in a `look` and loses its face in the garage (the Equip 40 shipped that way once). Two causes, both fixed in the pipeline: a mirror reverses every face's winding while the authored normals stay right, so `_xform` reverses the faces back; and a donor modelled inside out is righted by the hidden face cull (it turns faces only their back is seen from, authored normals with them), so the shading skin is copied after the cull, never before. `wheel_sheet()` plus `shading.show_backface_culling` on the viewport shows it; the count of `Rim` faces pointing +X against -X is the number to print.

Open:
- A race LOD (the house parts scale down by segment count, the face by budget) if four wheels per car show in the frame time.
- The bolt count is one or two off on two wheels (Kasumi 19, Raiden 39).

## Credits

All by **jonver87** on Sketchfab, CC BY 4.0: WORK VS-TX, Work Equip 03, Work Equip 40, WORK EMITZ, WORK VS-KF, Work VS XV, WORK VS-XX, WORK ZISTANCE W5S, WORK Schwert SC2, Work Equip 02, Work Euroline DH, WORK IMPORT LABEL AL4. Each is kept as its face, lip and barrel, reduced, with its bolts, badges and tire replaced by the house's.
