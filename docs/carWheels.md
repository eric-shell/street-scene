# Wheels from donor models

How a Street Scene wheel is made from one real wheel model. The wheel is kept as the wheel it is (its face, its lip and barrel, its bolt circle); the tire, the size and the bolt heads are the house's, so every wheel fits every car the same way. The mechanics are `scripts/blender/carWheels.py`; the car body process this follows is `docs/carDonors.md`.

## 1. Pick a donor

- **Licence:** the same rules as cars (`docs/carDonors.md`). CC0 or CC BY only, downloadable on Sketchfab. Check the model really contains the wheel: some "packs" on Sketchfab are a picture on a plane with the real files sold elsewhere, under terms of their own.
- **Clean showpiece models reduce best.** The set was all by one author until 2026-10-28 (jonver87's Work, Rotiform, Vossen and single models from HRE, Fifteen52, SSR, BBS and Volk): no tire, each piece its own mesh, and most of the triangles in bolt hardware, which the pipeline replaces anyway. 13k to 1,060k triangles.
- **Branding:** real wheel makers' names (BBS, Work, Mugen, Enkei, ...) never ship. Each wheel gets a fictional tuner name (`displayName`), and its maker a fictional maker name (`GROUPS` in `carWheels.py`: the garage lists the wheels under it); badge planes, their glass and lettering are flat and go as decals. A name embossed in the face itself (the Equip 02's small "Equip" on its plate) survives, too small to read at game scale.

Record the donor in `WHEELS` in `carWheels.py`: its name, uid, author, licence and `maker` (the real maker its title leads with; a new maker needs a fictional name in `GROUPS`). Credit the author in the README and in the settings' credits (`DONOR_CREDITS`).

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
3. **Classify every island** by where it sits, in shares of the lip radius: `decal` (flat: badge planes, glass, pinstripes) goes; `ring` reaches the lip radius and never comes inside 0.6 (the lip and the barrel); `cap` sits in the hub; `bolt` is a narrow band out on the dish (0.55 to 0.97), confirmed below; everything else is `face` (spokes, hub, flanges). A one-piece wheel's lip is part of its face island: its surfaces of revolution (outside 0.6 of the lip, faces whose own (x, r) cell is covered at nearly every 3 degree sector around the axle) are turned as a ring, and the rest stays face; spoke tips cover a third to a half of the sectors, so they keep their shape all the way into the lip (`_turned_faces`).
4. **Face +X:** a badge or its glass in the hub faces the front; without one, the spokes' and hub's area weighted normals lean toward it. Neither is sure (a flat face plate votes both ways, and the vote showed the back on ten wheels, 2026-10-28), so look at every wheel and set `face` where it is wrong.
5. **Fit:** scaled so the lip edge sits on the house tire's bead (0.74 × tire radius, a 16 inch wheel on the 0.28 m tire); the lip edge set just proud of the tire's sidewall (`X_LIP`); the visible depth from lip edge to face kept, and the barrel behind the face squeezed to end at the tire's back bead (`X_BACK`).
6. **Bolt circles:** the bolt islands are grouped by radius; a group with a periodic angular histogram is a circle of bolts, its peaks the count. The frontmost circle becomes house hex heads (18 triangles each) at its own angles, radius and depth; rear nuts and the donor's hardware go. A flange ring without bolts on it stays face, and an island that runs all the way round is a flange, never a bolt (the ERA3's went with its hardware until 2026-10-28). Each hex head's sides run down to the surface under it (the median of rays from its center and corners, within 3.5 cm), so a head never stands over a hole where the donor's washer was.
7. **Reduce:** each kind on its own, so a 500,000 triangle bolt ring cannot starve the spokes: a first collapse to three times the budget, the hidden face test against the whole wheel with the tire in place (faces no view from the front half sees go: the barrel under the tire, the backs of the spokes), then the collapse to `BUDGETS` (face 6,000, cap 700) with the donor's authored normals set back on the reduced faces (`shade_from_source`).
8. **Turn the ring:** the ring's visible surface is measured before anything is collapsed or culled, by rays from a viewpoint in front of the wheel swept in the plane through the axle from the lip edge back (each ray's first hit on the ring, the median over 12 planes round the axle, is one point: the surface's own order, steps and all; the face is not in the ring, so the rays pass through it to the dish wall and the flange it sits on), then from the axle outward behind a flange that hides the barrel from the front. The points are thinned to 26 where the profile bends most and lathed at 56 segments, each face wound toward the viewpoint by its own segment, the inner barrel behind the face included and carried on to `X_BACK`, then out to the tire's bead. A collapsed ring crumpled at any budget; a lathe never does. The barrel used to stop at the face, which left a thin disc in a hollow tire: through the spokes and from behind every wheel looked skinny.
9. **House parts:** a disc over a hub nothing covers (the donor's cap was a decal), its skirt run down to the hub when the hub's front went in the cull; the **house tire**, a lathed profile with rounded shoulders at 40 segments (960 triangles), smooth shaded about the axle. Then every cap, the donor's or the house's, is turned clean from its median profile, and a cap moulded into the face is turned the same way (section 7, Caps and lips). Last, islands of the donor's faces of 60 faces or fewer that come no nearer than 3 mm to anything go (`_drop_loose`: a lug seat or a sliver the cull or the collapse cut off).

Materials: face and hub `Rim` (the player's wheel colour), the turned lip and barrel `RimLip`, the center cap `RimCap`, bolt heads and lug nuts `Chrome`, the tire `Tire`; a source material named black stays `Black` (the Equip 02's slot walls). The lip's stock finish is the object's `lip` property, carried into the catalog entry: `chrome` on a multi-piece wheel (polished lips), `rim` on a one-piece (a monoblock is one finish; the recipe's `lip` overrides either). The garage paints lip and cap apart from the face (section 7, Caps and lips). The game finds the bead where the `Tire` mesh meets the rest, so the size slider works on every wheel (`src/render/car/wheelFit.ts`); every tire is lathed at runtime in the house tire's place, the standard one too (`src/render/car/tireShapes.ts`; section 5b, Tires).

## 4. Recipe overrides

Most wheels need none. The fields:

| Field | When |
|---|---|
| `face` | `1` or `-1` when the face direction comes out wrong (the barrel shows in front) |
| `maker` | the donor's real maker, a key of `GROUPS` (always set) |
| `lip` | `'chrome'` or `'rim'` against the default (chrome on a multi-piece wheel, rim on a one-piece) |
| `drop` | a regex of material or object names the junk words miss |
| `bolts` | `0` to keep no bolt circle |
| `normals` | `'geometry'` to shade the face from its own shape (split at 35°) when the donor's authored normals lean off its faces (the face reads dark) |
| `dark` | a luminance (0 to 1): faces whose base colour texture is darker go, for a tire welded to the wheel in one textured mesh (the CH-R: tire 0.10, wheel 0.45, cut at 0.25) |
| `pick` | `(axis, lo, hi)`: keep only the faces whose centre lies in that window of the import's own frame, for a scene holding several wheels (HRE 522M: two side by side; the SSR Collection: three in a row) |
| `cap` | the turned hub cap's radius, in shares of the lip, where the round test stops short of an opening a dropped logo cap covered (`momiji` 0.235) |

## 5. Check

`wheel_report()` prints triangles per material and the wheel's depth and lip; every lip reads 0.207. `wheel_sheet()` lays the set out facing front; look at it in solid and material shading, from the front and from 60 degrees. Look for:
- a wheel showing its barrel (set `face`): a long barrel with the hub's back (stud holes, a flat mounting pad) or plain spoke backs at its far end, the face 0.7 to 0.95 of the way back. Rebuild with the other `face`; never turn a built wheel, since the cull wound it for the side it was built facing;
- a detached face: from 60 degrees, a gap you can see past between the face's outer edge and the lip, dish wall or flange, spoke tips that stop short of the lip, a bolt head standing over nothing, a disc or sliver floating in front of the hub. Each of these was a pipeline bug, not a donor's (section 7, 2026-10-28), so look at the wheel's (x, r) section against the donor's before reaching for a recipe field;
- a bolt count off by one or two (the histogram peaks; usually fine) or bolts where there are none (`bolts: 0`);
- a lip profile with a kink (a leftover piece of hidden barrel: `drop` it);
- a hub left open (the house cap should have filled it).

## 5b. Facing and width

**Convention.** A shipped wheel is in wheel space: axle along X, centered on its tire, the face (spokes, hub, the lip's outer edge) toward **+X**, the barrel running back toward -X. The left side mounts it as is (`+X` is the car's left); the right side mounts the same meshes with the holder's X scale at -1, which three.js draws with the winding corrected, so both sides show the face outboard. `Rim` is single sided, so every front surface must also be wound toward +X (section 7's winding lesson).

**Check.** `npx tsx scripts/checkWheelFacing.ts [file.glb ...]` (headless, reads the GLBs through glTF Transform) casts rays down -X over the disc and reports, per wheel:
- `front`: the share of first `Rim` hits that are front faces. This is the hard check; every wheel reads 0.8 to 1.00 and none is wound the wrong way. A wheel under 0.5 is, and the script exits 1.
- `hub`, `mid`, `tips` and `depth`: where the first visible surface sits at those radii and how far the face is behind the lip edge (0 flush with the front, 1 flush with the back). This is a report only. Geometry cannot separate a deep concave design (the Rotiform set, `hari`'s 12 cm dish) from a wheel whose recipe `face` came out backwards, so a face past 0.85 is printed `deep` for a look in the garage, never failed (`ame`, `hane` and `uzu` read 0.85 to 0.94 until their `face: -1` rebuild on 2026-10-28, now 0.04 to 0.06). If one is wrong, set `face: -1` (or `1`) in its `carWheels.py` recipe and rebuild it: the face direction is decided in Blender, and nothing at runtime mirrors a wheel.

**Width.** `AxleStance.wheelWidth` (0.85 to 1.35, `STANCE_LIMITS`; 1 is stock, a missing value in an old save or share code reads 1; share key `ww`) lengthens or shortens only the barrel. The face, the lip and everything from the outer face back to the spokes' back (`spokeBack`, the lowest X of any non-tire vertex between 0.3 and 0.75 of the bead radius) keep their exact shape; a vertex behind it goes to `spokeBack + (x - spokeBack) * width`, so the lathed barrel grows inward by the width (a deep dish, whose spokes sit near the back, has a short barrel to stretch, which is correct). The tire follows the barrel's back edge: its inner side (the lowest 20% of its width) shifts, not stretches, by `(1 - width) * (spokeBack - xBack)` (`xBack` the rearmost non-tire X), its outer 20% stays put, and the tread between is stretched so it stays one surface. Normals' X is divided by the local `dx'/dx`. This is `remapWheel`'s `width` and `WidthFit` arguments (`wheelFit.ts`, measured per baked axle in `carView.bakeAxle`). Front and rear width are always separate, linked or not: the Wheels tab's Fit view shows both sliders when the wheels are linked, and neither Link toggle copies it. The brake does not depend on the width: its outboard-most point (the caliper's housing face, `brakeReach` in `brakes.ts`, 2 to 3 cm past the hat's face) is placed `BRAKE.clearance` behind `spokeBack`, scaled with the unit. **The barrel always covers the brake.** A deep dish has its spokes near the back, so the rotor and the caliper's inboard housing (`brakeDepth`, up to 10 cm at the reference bead) would stand out behind the barrel and the tire. `carView.applyWheelSize` therefore measures, per axle and whenever the size changes (the brake scales with the bead), the stretch `cover` (`barrelCover`: the brake's rearmost point plus `BARREL_MARGIN`, 8 mm, over the barrel's stock length `spokeBack - back`; 1 when the stock barrel already reaches that far) and `remapWheel` runs the width through `barrelStretch(width, cover)`: at or below 1 the barrel stretches by `max(width, cover)`, above 1 by `cover + (width - 1)`. The slider thus never pulls the back in past the brake, and above 1 it adds its share of the stock length on top of the cover, so it moves every wheel over its whole range (a wheel with cover 1, most of them, behaves exactly as before). The tire's inner band follows the barrel's back as before. The face and lip are untouched; only the barrel's inner shape stretches. A cover over 1.6 (a barrel more than 60% longer than stock; 14 wheels, the Hari and the other deep dishes) is a long barrel, and the tire widens inboard with it. Visual only: the sim never reads it.

**Tires.** The garage's Stretch choice is None, Mild or Full (`TIRE_SHAPES`: `standard`, `mild`, `stretched`; `stretched` is the first stretched tire, so old saves and share codes keep their look, and the first set's `mildStretch` reads `mild`, `aggressiveStretch` `stretched`). Each shape is a half profile in `tireShapes.ts` (`PROFILES`; `standard` is `house_tire`'s) lathed over the measured house tire (1,520 triangles; 1,360 on the stretched one) with two circumferential grooves cut into the crown (`TREAD.grooves`, laid out by arc length so every shape gets the same layout). All shapes share one UV layout: u once around the tire, v in three bands (the face sidewall, the tread, a plain strip the back sidewall is pinned to). `tireTread.ts` draws the one shared texture (2048 x 512, one RGBA canvas used as bump, roughness and ink): our own semi-slick pattern in the manner of a road-race tire, with a wide groove toward the inner shoulder and a narrow one toward the face side, big slanted cuts across the face shoulder that run off onto the sidewall, solid blocks across the crown and small notches on the back shoulder, 32 pitches around. Medium and up wear it; Low is plain rubber on the same lathed geometry. The printed sidewall lettering (ink only, no relief, so nothing mirrored shows on the right side; a fictional brand and model line, `TIRE_BRAND`) is a second variant of the same texture, chosen by `VisualBuild.wheels.lettering` (Fit view, off by default, share key `lt`): off keeps the plain texture, so it costs nothing. The right side's holder is mirrored and its tread mirrors with it, so the cuts slant the same way against travel on both sides; the tire shader reads only the lettering with u flipped there, so it reads true on both sides. Visual only: the sim never reads it.

## 6. Ship

1. Save a working copy (`bpy.ops.wm.save_as_mainfile(filepath=..., copy=True)`), then `saveCar.py` headless with `wheels` as the id, writing `assets/source/eshell/wheels/wheels.blend`. It keeps only the `wheels:Wheels` collection.
2. Run `npm run assets`: the wheel set is exported by `exportCar.py` (wheels-only mode) and cataloged as universal wheels `wheel_<name>`.
3. Set each car's `defaultWheel` in the manifest.
4. A retired wheel id is not mapped: a saved build or share code with it falls back to the first wheel the car offers (`carView.ts`).

## 7. The sets

### The Work set (2026-10-22)

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

### Eight makers (2026-10-27)

32 more of jonver87's models, and the whole set rebuilt with the full barrel. 44 wheels, 8,000 to 11,600 triangles each. Garage groups (fictional maker names, alphabetical, wheels alphabetical inside):

| Group | Maker | Wheels (donor) |
|---|---|---|
| Byakko | HRE | Tora (P200) |
| Genbu | Volk | Iwa (Rays 21C) |
| Hiryu | SSR | Homura (Koenig) |
| Hotaru | Fifteen52 | Tsuchi (Rally Sport) |
| Kaito | Work | the twelve above, Gekko (LS Chiarezza SUV, `bolts: 0`: its rivets sit in pairs and the histogram read three) |
| Mizuchi | Rotiform | Nami (ZMO), Shizuku (Aerodisc), Uzu (VCE), Kawa (SIX), Taki (AVS), Minato (KB1), Kiri (USF), Shio (MLW), Ame (OZR), Yuki (BM1), Shigure (WRO), Umi (CCV), Hyo (LHR), Tsuyu (LSR), Kori (KLU), Mio (SNA), Fubuki (KPS), Seseragi (PNT) |
| Seiryu | Vossen | Aoi (LC104T), Sora (LC109T), Hikari (VPS302), Kagami (VPS301), Seiun (ERA3), Getsuei (GNS-1), Kirameki (VPS 315T), Hisui (CG203) |
| Suzaku | BBS | Hane (E52, `normals: 'geometry'`) |

Retired names (`kiba`, `hoshi`, `rensa`, `tsuki`, `ginga`, `hibana`, `senko`, `arashi`) are never reused, so an old save never shows a different wheel under its name. The one check that found a wheel the sheet hid: the mean shading normal of each wheel's front facing `Rim` faces along +X, 0.75 to 0.97 on a good wheel, 0.19 on the E52 before `normals: 'geometry'`.

### Two new authors (2026-10-28)

The user sent five links; three were refused before import: a TE37 Ultra Track Edition II (Sketchfab Standard, not downloadable), a Rotiform LHR-M (no licence, not downloadable) and an Enkei RS05RR (tagged `noai`). The two kept are the first wheels not by jonver87, and both arrive differently from his:

| Group | Maker | Wheel (donor, author) | Recipe |
|---|---|---|---|
| Kohaku | Enkei (new group) | Kiseki (Enkei Nt03+m Wheels, flathat3d) | `drop` its three stacked logo caps and the lip lettering (a flat 4,500 face piece); `normals: 'geometry'` |
| Suzaku | BBS | Hien (BBS CH-R + Goodyear Eagle F1 Supercar 3, MozzarellaARC) | `dark: 0.25` |

- **Kiseki**: one welded mesh, wheel only, 71,000 faces: read as a one-piece wheel, its stepped lip turned from 20 points; 9,158 triangles. Its authored normals lean off the spokes (the front facing score 0.14 by face normals), so it shades from geometry: 0.55 on the shading normal score, where the set reads 0.47 to 0.63.
- **Hien**: a 20,700 face low poly model with its tire welded to the wheel in one mesh and one textured material, UVs overlapping: neither islands, names nor UVs separate them, the texture's colour does. 8,716 triangles, score 0.57. Its centre cap logo is only in the texture, which the game does not use.
- The shading score above is the mean +X of the shading normals over front facing `Rim` faces; it is a different number from the face normal score quoted for the E52.

### Connected faces (2026-10-28)

The user: "a lot of the faces are disconnected from the lips and barrels", and ten wheels (ame, hane, hien, iwa, kawa, kiseki, mio, umi, uzu, yuki) looked mounted backwards in the garage. Measured on the (x, r) section of each shipped wheel against its re-imported donor: per angle, the face's outermost vertex against the turned ring. 30 of the 46 wheels touched the ring in under half their sectors, 30 had a median gap over 3 mm (fubuki 22 mm, mio 29, tsuchi 31), 437 of 697 house bolt heads stood over nothing, and several wheels carried loose slivers in front of the hub. Five causes, all in the pipeline:

- **The profile lost the dish wall and the flange.** `_ring_profile` sorted the culled ring's face centers by their angle from one viewpoint and averaged each of 26 bins. A dish wall and the barrel step behind it lie along the same rays, so the average landed between them, and the cull had already taken the flange under the face's edge. On the Equip 03 the face sits on a barrel flange running down to 0.66 of the lip; the turned barrel began at 0.78, a 2 cm ring of nothing round the face. Now rays sweep from the viewpoint and each one's first hit on the uncollapsed, unculled ring is a point (the median over 12 planes), with a second pass from the axle outward for the barrel a flange hides.
- **The one-piece split cut the spokes off.** A one-piece wheel's ring was everything outside the first radial band, walking in from the lip, whose front faces did not cover every angle. Behind the KPS's spokes a barrel step covered the gaps, so the band ran down to 0.78 and the lathe turned away the spoke tips between 0.78 and 0.88: the spokes ended 3 cm in front of the dish. Now a face is turned only if its own (x, r) cell is covered at 112 of 120 sectors (at 36, the Nt03's twelve spokes covered them all) and every corner's is too, so a spoke's fillet stays whole where it meets the lip.
- **The normal vote showed the back.** On the ten wheels the area weighted normal vote picked the hub's back (stud holes, a mounting pad) or the spokes' plain backs, and the face sat 0.7 to 0.94 of the way down a long barrel. The OZR's center nut and the Nt03's dropped caps and lip lettering both sat on the other side. Turning the built mesh round does not fix it: the hidden face cull had wound every face for the side it was built facing, so a turned wheel faces +X wound toward -X and loses its spokes. The recipe's `face: -1` turns the donor before the cull, which is the fix; all ten carry it.
- **Hardware floated.** House bolt heads were 2.5 mm deep under the donor's bolt top, over the washer or counterbore that went with the donor's hardware; now they run down to the surface under them. The house cap's 4 mm skirt hung 1 to 4 mm over a hub whose front went in the cull (tora, fubuki, kagami, hisui, hikari, hane, kiseki); it now reaches the hub. A full ring island at the bolts' radius (the ERA3's flange) joined their circle and went with them; it stays face. Islands of 60 faces or fewer that touch nothing within 3 mm go (iwa lost 47 triangles of them, tsume 56, yuki 56, kiri 53).
- **Some lathe faces were wound away from the front.** A face was wound by its first corner's smooth normal, which at a sharp step in the profile points across the segment: on fubuki the lip's front step showed its back (front share 0.99). Each face is wound by its own segment now.

After: 9,080 to 11,476 triangles a wheel (face 6,000, the lathe 1,600 to 3,100, Chrome bolts and cap, the tire 960), 4 of 697 bolt heads over open bolt holes (tsurugi's counterbores, whose floors the collapse left as slivers), and the face meets the lip, dish wall or flange on every wheel; the ones under half their sectors by the touch measure (yari, tsume, hari, hane, tora, hien) have a thick face whose back sits on the flange or lip and whose front corner is what the measure finds. `checkWheelFacing` depth for the ten, before and after: ame 0.90 to 0.04, hane 0.94 to 0.05, hien 0.73 to 0.07, iwa 0.62 to 0.34, kawa 0.81 to 0.24, kiseki 0.76 to 0.09, mio 0.71 to 0.28, umi 0.76 to 0.16, uzu 0.85 to 0.06, yuki 0.76 to 0.13; front share rose on hane (0.89 to 1.00), kawa (0.80 to 1.00), mio (0.79 to 0.98) and yuki (0.92 to 1.00), and fell on none but tsuchi, by one ray in 1,286 (0.9992, a collapsed spoke side at 0.88 of the lip, nearly edge on). Hane's mesh center is a dome that stands 5 cm proud of the lip plane the right way round: that is the donor's shape on its narrow lip, not a fit error.

Learnings:
- **Measure the section, not the silhouette.** A face floating 3 cm in front of a turned dish looks whole from the front; the (x, r) section of the wheel against its donor's, printed as text, shows the gap and which step lost it.
- **A profile is what the eye sees first, not an average.** Two layers along one ray average to a surface that is neither.
- **Split a monoblock by shape, not by radius.** What is round is the lip; spokes are not round at any radius.
- **The winding check cannot catch a backwards wheel.** The cull winds every face toward whichever side is seen, so `front` reads 0.8 to 1.0 either way; depth past 0.7 and a look decide.

### Fifty-six more (2026-10-28)

56 donor models from jonver87 (37), dermaks (17), portfoliorodrigues (the Fifteen52 Turbomac) and alexanderlyreo (a Work Meister S1 3P) became **54 wheels**, 100 in the set, 5,418 to 11,381 triangles each (under the 12,000 budget; the smallest is `sagi`, a four spoke whose face is 2,258 of them, the largest `tsubaki`). Names are new pseudo-Japanese words (retired and taken names skipped: `tsubasa` belongs to another file); 13 makers got fictional groups (Advan Kitsune, Avant Garde Tengu, Brixton Forged Oni, Kyusha Shoes Tanuki, Velare Yamabiko, VIP Modular Raijin, Weds Fujin, 326 Power Kirin, Brabus Nue, Budnik Orochi, Devil Japan Shuten, Kansei Nekomata, MAE Kamaitachi); Rays goes under Volk's Genbu and Vossen-x-Work under Seiryu (`GROUPS` maps the real maker, so a collaboration or a sister brand needs only a key).

**Byakko** (HRE)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Akatsuki | HRE TUSK | jonver87 | no overrides |
| Hasu | HRE FF04 | jonver87 | no overrides |
| Kanade | HRE 522M | jonver87 | `pick`: the scene holds two wheels side by side; the one on +X (906k faces for both) |

**Fujin** (Weds; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Uguisu | Weds Kranze Bazreia | dermaks | no overrides |

**Genbu** (Rays, Volk)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Suzume | VOLK TE37SL 3spoke | jonver87 | `face: 1` (0.59 down the barrel, 0.15 turned); 1.25M faces, 40 s a build |
| Tamashii | RAYS TE037 | dermaks | the TE037 pair: this one kept (see below) |
| Tomoe | Volk Rays 21A | jonver87 | no overrides |
| Zan | RAYS nismo LMGT1 | dermaks | no overrides |

**Hiryu** (SSR)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Hanabi | SSR Starshark | dermaks | no overrides |
| Hotaka | SSR Longchamp XR4 | dermaks | deep dish (0.66 down the barrel); the 8-bolt flange rebuilt |
| Koyomi | SSR Collection Mk3 | dermaks | `pick` on y: Mk3 spokes on the shared lip |
| Nadeshiko | SSR Collection Mk1 | dermaks | `pick` on y: one of three wheels in a row along the axle, on one shared lip |
| Tsukushi | SSR Collection Mk2 | dermaks | `pick` on y: Mk2 spokes on the shared lip |
| Yuzu | SSR Minerva | dermaks | no overrides |

**Hotaru** (Fifteen52)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Wakaba | fifteen52 Turbomac | portfoliorodrigues | 986k faces by portfoliorodrigues; the 5x108 render model reduces to 10,344 triangles |

**Kaito** (Work)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Inazuma | WORK EMOTION T5R 2P | dermaks | no overrides |
| Kasane | WORK Equip 05 | dermaks | no overrides |
| Yamabuki | Work Meister S1 3P | alexanderlyreo | by alexanderlyreo; one welded mesh |
| Yoake | WORK MEISTER CR01 | dermaks | Work badge sticker and black spoke faces stay `Black` |

**Kamaitachi** (MAE; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Mikazuki | O.Z MAE | dermaks | no overrides |
| Minamo | MAE CROWN JEWEL | dermaks | `face: 1` (0.76 down the barrel, 0.39 turned; the same template as the MAE above reads 0.44 on the vote) |

**Kirin** (326 Power; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Kozue | 326 yabaking spoke | dermaks | 140k faces; 30 lip bolts |

**Kitsune** (Advan; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Ayame | Advan A3A | jonver87 | no overrides |

**Kohaku** (Enkei)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Tsutsuji | Enkei Riverge | jonver87 | `face: -1` (0.56 down the barrel, 0.39 turned); FBX upload |

**Mizuchi** (Rotiform)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Chidori | Rotiform WRG | jonver87 | no overrides |
| Daichi | Rotiform IHR | jonver87 | no overrides |
| Natsu | Rotiform HVN | jonver87 | `face: -1`: `face: 1` (the vote's plate 0.6 down the barrel) showed the plate's back; rebuilt 2026-10-28, depth 0.61, the concave plate deep in a polished dish |
| Nokaze | Rotiform SEA | jonver87 | no overrides |
| Ogi | Rotiform RSC | jonver87 | `face: -1` (0.73 down the barrel, 0.05 turned) |
| Sakura | Rotiform EMA | jonver87 | `face: -1` (0.85 down the barrel, 0.09 turned) |

**Nekomata** (Kansei; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Sazanka | KANSEI TANDEM | dermaks | no overrides |

**Nue** (Brabus; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Yuhi | BRABUS MONOBLOCK M | dermaks | no overrides |

**Oni** (Brixton Forged; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Fuyu | Brixton Forged TR06 | jonver87 | no overrides |
| Ibuki | Brixton Forged VL7 | jonver87 | `face: -1`: the vote put the lattice 0.7 down the barrel (0.15 turned) |
| Kaen | Brixton Forged PF6 | jonver87 | no overrides |
| Shirube | Brixton Forged CM16 | jonver87 | `face: 1` (0.73 down the barrel, 0.17 turned) |

**Orochi** (Budnik; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Sagi | Budnik Tusk | dermaks | no overrides |

**Raijin** (VIP Modular; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Sango | VIP MODULAR VXS410 | jonver87 | no overrides |
| Sazanami | VIP MODULAR VX510 | jonver87 | no overrides |
| Tsubaki | VIP Modular VXS610 | jonver87 | FBX upload; the normal vote kept (0.58 down the barrel, 0.49 the other way: a deep dished plate) |

**Seiryu** (Vossen, Vossen-x-Work)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Karasu | Vossen VFS4 | jonver87 | no overrides |
| Madoka | Vossen LC106 | jonver87 | no overrides |
| Mizore | Vossen LC108T | jonver87 | no overrides |
| Momiji | Vossen-x-Work VWS3 | jonver87 | `face: -1, cap: 0.235`: `face: 1` showed the hub's mounting pad and stud holes; rebuilt 2026-10-28, depth 0.51 |
| Nagi | Vossen VPS 310T | jonver87 | no overrides |
| Rin | Vossen CG207 | jonver87 | no overrides |
| Sumire | Vossen VFS2 | jonver87 | `face: -1` (0.77 down the barrel, 0.12 turned); FBX upload (see below) |
| Ukigumo | VOSSEN VFS1 | jonver87 | no overrides |
| Usagi | Vossen HC-1 | jonver87 | no overrides |

**Shuten** (Devil Japan; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Asagi | Devil Japan IF | dermaks | deep dish (0.64); same lip and bolt flange as the Longchamp XR4 |

**Tanuki** (Kyusha Shoes; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Enishi | Kyusha Shoes Meteor FF | jonver87 | no overrides |

**Tengu** (Avant Garde; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Genki | Avant Garde F450 | jonver87 | no overrides |
| Haruka | Avant Garde F142 | jonver87 | no overrides |

**Yamabiko** (Velare; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Botan | Velare VLR F1 | jonver87 | no overrides |

**Skipped (3 models) and why**
- *Weds Kranze Chrishna* and *Weds Kranze Ratzinger* (jonver87): both import as the same FBX scene, a **VIA CM10 PLUS FlowForged 20x9** (`VIA_CM10PLUS_FlowForged_20x9_000`), not a Kranze. A model that is not what its title says is not a donor we can name, so neither shipped.
- *Enkei Apache 2* (jonver87): built twice and never right. The face is a full-diameter plate at the closed end of a 30 cm barrel; with the vote's side the plate stands 24 cm proud of the lip, with the other the face sits 0.89 down the barrel and its outer annulus is wound backwards (`checkWheelFacing`: front 0.48, WOUND). The `kamome` recipe was removed rather than patched on the mesh.

**The TE037 pair**: jonver87's *Volk Rays TE037* and dermaks' *RAYS TE037* are the same wheel; both were built (6 spokes, 10.7k triangles each) and dermaks' kept as `tamashii`, since its spokes keep the TE37's raised edge ribs and a separate lip ring at the tips where jonver87's reads as a flat six-spoke. jonver87's was dropped.

**SSR COLLECTION** (dermaks) is three wheels in one scene along the axle, Mk1, Mk2 and Mk3, each its own spokes on the **same** lip mesh (6,748 + 6,720 faces, bolt for bolt), so it is split by a new recipe field, `pick` (an `(axis, lo, hi)` window on the import's own frame, applied to each face's centre in `_gather`), into `nadeshiko` (Mk1), `tsukushi` (Mk2) and `koyomi` (Mk3). None repeats an SSR model elsewhere in the set: the lip is the Starshark's, the spokes are not. The Starshark (`hanabi`), Minerva (`yuzu`), Longchamp XR4 (`hotaka`) and Devil Japan IF (`asagi`) share the template's bolt flange and bbox, which is the same SSR lip family.

Learnings:
- **Depth decides the face on a jonver87 import.** The area weighted normal vote was wrong again on 9 of the 33 (`ibuki`, `momiji`, `natsu`, `ogi`, `sakura`, `sumire`, `shirube`, `suzume`, `tsutsuji`) and on jonver87's TE037. The tell was the same each time: build both ways and compare the mean depth of the first visible surface over r 0.15 to 0.75 (`mean_depth` over `BVHTree` rays down -X, 0 flush with the lip edge, 1 at the barrel's back): the right side read 0.04 to 0.39, the wrong one 0.55 to 0.85 (ogi 0.04 against 0.73, sakura 0.11 against 0.85, shirube 0.21 against 0.73). Where the two were close (tsubaki 0.58 against 0.49, asagi, inazuma and hanabi about 0.6 either way) a look decided or the vote stayed.
- **dermaks' wheels share one template** (`lip`, `spokes`, `lugs`, `bolts` meshes, the same axis, a +X vote on every one): all but four vote +X (326, MAE Crown Jewel, the Turbomac and Work Meister S1 are other uploaders' templates) and read 0.01 to 0.66 deep, so the deep ones (SSR Minerva, Longchamp, Starshark, Work Emotion T5R, the Collection's three: 0.5 to 0.78) are genuine deep dishes (3 piece, long barrel), checked by eye from the front and 60 degrees; the MAE Crown Jewel voted -X (0.76 deep) and needed `face: 1`. `checkWheelFacing` prints no new wheel `deep` (the deepest, `tsukushi`, reads 0.78) and none wound.
- **A donor that is a shop scene needs a selector.** The HRE 522M was two wheels side by side and the SSR Collection three in a row; `pick` keeps the faces whose centre lies in a window, before the weld, so the rest of the pipeline never sees them.
- **Check what the model is, not what it is called.** Two FBX uploads contained a VIA wheel under a Weds title; the object names (`VIA_CM10PLUS_FlowForged_20x9_000`) were in the import's own report. jonver87's FBX uploads (`sumire` Vossen VFS2, `tsubaki` VIP Modular VXS610, `tsutsuji` Enkei Riverge, `ukigumo` Vossen VFS1, `usagi` Vossen HC-1) carry no such contradiction in their names, but they came through a different pipeline than his OBJ models and their provenance is unverified beyond the licence the uploader set.
- **Imports can 502.** Two downloads failed once (Sketchfab status 502) and went through on a retry; import in a batch and check which roots arrived before building.
- **A 1.25M face donor takes 40 s a build** (`suzume`; the Turbomac took 26 s); a call over about a minute drops the MCP connection although Blender goes on, so build such wheels one or two to a call.

### Caps and lips (2026-10-28)

The user: natsu and momiji were mounted backwards, center caps should match the face colour, many caps still carried the donor maker's logo, and caps and lips should each take a colour of their own. Natsu and momiji had been forced `face: 1` against the vote; both were rebuilt with `face: -1` (the garage showed natsu's plain plate back and momiji's hub mounting pad with its stud holes). The vote is still not to be trusted, the look is.

- **Two new shared materials.** `RimLip` (the turned lip and barrel) and `RimCap` (the center cap) join the vocabulary (`SHARED` in `carKit.py`, `MATERIAL_NAMES` in `src/shared/parts.ts`). Every wheel ships them; `Chrome` is left to bolt heads and lug nuts. Each catalog entry records its stock lip (`lip: 'chrome' | 'rim'`, 62 and 38 of the set), so a build's lip on `stock` keeps the look the wheel shipped with.
- **The garage.** `VisualBuild.wheels.lip` and `.cap` (`WheelTrim`: `mode` stock / face / chrome / paint, plus a colour and finish for paint; share keys `lp`, `cp`, the mode `md`) apply to both axles; `face` wears each axle's own wheel paint, `stock` each axle's wheel's own lip. The cap defaults to `face`, so a cap matches the wheel unless painted; an old save or share code reads a stock lip and a face cap. Materials `RimLip`, `RimCap` and their `...Rear` copies are painted in `applyVisualToMaterials`. The runtime split of a Chrome cap onto the face material went with it.
- **Every cap is turned clean** (`clean_cap`). A cap's (x, r) profile is measured by rays down the axle at 48 radii, each the median over 24 angles, so a maker's logo or lettering, raised or engraved, which covers only some angles at any radius, drops out, while the cap's dome, steps and skirt stay; the profile, thinned to 12 points, is lathed at 40 segments in `RimCap` in the cap's place. Hari's hex center-lock nut and badge became a stepped dome. A ring of donor lug nuts round the hub (inside 0.35 of the lip, so once classified as cap, but starting outside 0.15) is hardware and stays `Chrome`: hasu, kasane, kozue, sazanka, shizuku, sora, tamashii, tsurugi, yuhi, yuzu.
- **A cap moulded into the face** (`hub_cap`): where the wheel has no cap piece, the hub's round center, from the axle out to where the rays stop finding a round surface (90 % of them hit and their spread is under 3 mm; inside 0.12 of the lip half will do, since a logo breaks both near the axle), is replaced by the same turned cap. Sixteen wheels: the Brabus "B" on yuhi and the XR4 badge on hotaka went this way. Tsutsuji's open bore has no cap. Momiji's donor cap was a logo decal over a star shaped opening wider than its round hub, so its recipe sets `cap: 0.235`; and a profile now always reaches the edge of the faces it replaces (it stopped at 0.198 there and left a ring of holes).
- **Shipped without the donors.** `retrofit_hub(name)` brings a built wheel up to date in place: the lathe's faces (quads on its 56 segment angles outside half the lip) go to `RimLip`, the stock lip is read from what they were, and the Chrome cap is turned clean. All 98 wheels not rebuilt went through it; `wheel()` does the same at the end of every build.

## Credits

All by **jonver87** on Sketchfab, CC BY 4.0: WORK VS-TX, Work Equip 03, Work Equip 40, WORK EMITZ, WORK VS-KF, Work VS XV, WORK VS-XX, WORK ZISTANCE W5S, WORK Schwert SC2, Work Equip 02, Work Euroline DH, WORK IMPORT LABEL AL4, WORK LS CHIAREZZA SUV, Rotiform ZMO, Aerodisc, VCE, SIX, AVS, KB1, USF, MLW, OZR, BM1, WRO, CCV, LHR, LSR, KLU, SNA, KPS and PNT, 3D Vossen LC104T, Vossen LC109T, VPS302, VPS301, ERA3, GNS-1, VPS 315T and CG203, HRE P200, Fifteen52 Rally Sport, SSR Koenig, BBS E52, Volk Rays 21C. Each is kept as its face, lip and barrel, reduced, with its bolts, badges and tire replaced by the house's.

Enkei Nt03+m Wheels by **flathat3d** and BBS CH-R + Goodyear Eagle F1 Supercar 3 by **MozzarellaARC** on Sketchfab, CC BY 4.0, each kept the same way (the CH-R's own tire cut away).

The Fifty-six more set (2026-10-28), CC BY 4.0, kept the same way: 33 more by **jonver87** (HRE TUSK, Advan A3A, Velare VLR F1, Rotiform WRG, IHR, HVN, SEA, RSC and EMA, Kyusha Shoes Meteor FF, Brixton Forged TR06, VL7, PF6 and CM16, Avant Garde F450 and F142, HRE FF04 and 522M, Vossen VFS4, LC106, LC108T, VPS 310T, CG207, VFS2, VFS1 and HC-1, Vossen-x-Work VWS3, VIP Modular VXS410, VX510 and VXS610, Volk TE37SL 3spoke, Volk Rays 21A, Enkei Riverge), "fifteen52 Turbomac" by **portfoliorodrigues**, "Work Meister S1 3P" by **alexanderlyreo** and 19 wheels from 17 models by **dermaks** (WORK MEISTER CR01, SSR Minerva, RAYS nismo LMGT1, SSR COLLECTION (three wheels), SSR Longchamp XR4, Budnik Tusk, Weds Kranze Bazreia, BRABUS MONOBLOCK M, Devil Japan IF, WORK Equip 05, KANSEI TANDEM, O.Z MAE, WORK EMOTION T5R 2P, RAYS TE037, SSR Starshark, 326 yabaking spoke, MAE CROWN JEWEL). The settings' credits list each one (`DONOR_CREDITS`).
