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
9. **House parts:** a chrome disc over a hub nothing covers (the donor's cap was a decal), its skirt run down to the hub when the hub's front went in the cull; the **house tire**, a lathed profile with rounded shoulders at 40 segments (960 triangles), smooth shaded about the axle. Last, islands of the donor's faces of 60 faces or fewer that come no nearer than 3 mm to anything go (`_drop_loose`: a lug seat or a sliver the cull or the collapse cut off).

Materials: face and hub `Rim` (the player's wheel colour), lip and barrel `Chrome` on a multi-piece wheel (polished lips), `Rim` on a one-piece (a monoblock is one finish; `lip` overrides either), bolts and caps `Chrome`, the tire `Tire`; a source material named black stays `Black` (the Equip 02's slot walls). The game finds the bead where the `Tire` mesh meets the rest, so the size slider works on every wheel (`src/render/car/wheelFit.ts`); every tire is lathed at runtime in the house tire's place, the standard one too (`src/render/car/tireShapes.ts`; section 5b, Tires).

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

**Width.** `AxleStance.wheelWidth` (0.85 to 1.35, `STANCE_LIMITS`; 1 is stock, a missing value in an old save or share code reads 1; share key `ww`) lengthens or shortens only the barrel. The face, the lip and everything from the outer face back to the spokes' back (`spokeBack`, the lowest X of any non-tire vertex between 0.3 and 0.75 of the bead radius) keep their exact shape; a vertex behind it goes to `spokeBack + (x - spokeBack) * width`, so the lathed barrel grows inward by the width (a deep dish, whose spokes sit near the back, has a short barrel to stretch, which is correct). The tire follows the barrel's back edge: its inner side (the lowest 20% of its width) shifts, not stretches, by `(1 - width) * (spokeBack - xBack)` (`xBack` the rearmost non-tire X), its outer 20% stays put, and the tread between is stretched so it stays one surface. Normals' X is divided by the local `dx'/dx`. This is `remapWheel`'s `width` and `WidthFit` arguments (`wheelFit.ts`, measured per baked axle in `carView.bakeAxle`). Front and rear width are always separate, linked or not: the Wheels tab's Fit view shows both sliders when the wheels are linked, and neither Link toggle copies it. The brake does not depend on the width: its outboard-most point (the caliper's housing face, `brakeReach` in `brakes.ts`, 2 to 3 cm past the hat's face) is placed `BRAKE.clearance` behind `spokeBack`, scaled with the unit. Visual only: the sim never reads it.

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

## Credits

All by **jonver87** on Sketchfab, CC BY 4.0: WORK VS-TX, Work Equip 03, Work Equip 40, WORK EMITZ, WORK VS-KF, Work VS XV, WORK VS-XX, WORK ZISTANCE W5S, WORK Schwert SC2, Work Equip 02, Work Euroline DH, WORK IMPORT LABEL AL4, WORK LS CHIAREZZA SUV, Rotiform ZMO, Aerodisc, VCE, SIX, AVS, KB1, USF, MLW, OZR, BM1, WRO, CCV, LHR, LSR, KLU, SNA, KPS and PNT, 3D Vossen LC104T, Vossen LC109T, VPS302, VPS301, ERA3, GNS-1, VPS 315T and CG203, HRE P200, Fifteen52 Rally Sport, SSR Koenig, BBS E52, Volk Rays 21C. Each is kept as its face, lip and barrel, reduced, with its bolts, badges and tire replaced by the house's.

Enkei Nt03+m Wheels by **flathat3d** and BBS CH-R + Goodyear Eagle F1 Supercar 3 by **MozzarellaARC** on Sketchfab, CC BY 4.0, each kept the same way (the CH-R's own tire cut away).
