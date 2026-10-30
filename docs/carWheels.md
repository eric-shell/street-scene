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
3. **Classify every island** by where it sits, in shares of the lip radius: `decal` (flat: badge planes, glass, pinstripes) goes; `ring` reaches the lip radius and never comes inside 0.6 (the lip and the barrel); `cap` sits in the hub; `bolt` is a narrow band out on the dish (0.55 to 0.97), confirmed below; everything else is `face` (spokes, hub, flanges). A one-piece wheel's lip is part of its face island: its surfaces of revolution (outside 0.6 of the lip, faces whose own (x, r) cell is covered at nearly every 3 degree sector around the axle) are turned as a ring, and the rest stays face; spoke tips cover a third to a half of the sectors, so they keep their shape all the way into the lip (`_turned_faces`). Only turned faces joined to the lip edge through turned faces count (a round dish inside a ring of windows is not the lip), and once the ring's profile is measured (step 8) it has the last word: a face on it (every corner within 2 mm) is turned, a turned face off it goes back to the face (`_turn_to_profile`).
4. **Face +X:** a badge or its glass in the hub faces the front; without one, the spokes' and hub's area weighted normals lean toward it. Neither is sure (a flat face plate votes both ways, and the vote showed the back on ten wheels, 2026-10-28), so look at every wheel and set `face` where it is wrong.
5. **Fit:** scaled so the lip edge sits on the house tire's bead (0.74 × tire radius, a 16 inch wheel on the 0.28 m tire); the lip edge set just proud of the tire's sidewall (`X_LIP`); the visible depth from lip edge to face kept, and the barrel behind the face squeezed to end at the tire's back bead (`X_BACK`).
6. **Bolt circles:** the bolt islands are grouped by radius; a group with a periodic angular histogram is a circle of bolts, its peaks the count. The frontmost circle becomes house hex heads (18 triangles each) at its own angles, radius and depth; rear nuts and the donor's hardware go. A flange ring without bolts on it stays face, and an island that runs all the way round is a flange, never a bolt (the ERA3's went with its hardware until 2026-10-28). Each hex head's sides run down to the surface under it (the median of rays from its center and corners, within 3.5 cm), so a head never stands over a hole where the donor's washer was.
7. **Reduce:** each kind on its own, so a 500,000 triangle bolt ring cannot starve the spokes: a first collapse to three times the budget, the hidden face test against the whole wheel with the tire in place (faces no view from the front half sees go: the barrel under the tire, the backs of the spokes), then the collapse to `BUDGETS` (face 6,000, cap 700) with the donor's authored normals set back on the reduced faces (`shade_from_source`).
8. **Turn the ring:** the ring's visible surface is measured before anything is collapsed or culled, by rays from a viewpoint in front of the wheel swept in the plane through the axle from the lip edge back (each ray's first hit on the ring, the median over 16 planes round the axle stepped by the golden angle, so no spoke count lines up with them, is one point: the surface's own order, steps and all; the face is not in the ring, so the rays pass through it to the dish wall and the flange it sits on), then from the axle outward behind a flange that hides the barrel from the front. The points are thinned to 26 where the profile bends most and lathed at 56 segments, each face wound toward the viewpoint by its own segment, the inner barrel behind the face included and carried on to `X_BACK`, then out to the tire's bead. A collapsed ring crumpled at any budget; a lathe never does. The barrel used to stop at the face, which left a thin disc in a hollow tire: through the spokes and from behind every wheel looked skinny.
9. **House parts:** a disc over a hub nothing covers (the donor's cap was a decal), its skirt run down to the hub when the hub's front went in the cull; the **house tire**, a lathed profile with rounded shoulders at 40 segments (960 triangles), smooth shaded about the axle. Then every cap, the donor's or the house's, is turned clean from its median profile, and a cap moulded into the face is turned the same way (section 7, Caps and lips). Last, islands of the donor's faces of 60 faces or fewer that come no nearer than 3 mm to anything go (`_drop_loose`: a lug seat or a sliver the cull or the collapse cut off).

Materials: face and hub `Rim` (the player's wheel colour), the turned lip and barrel `RimLip`, the center cap `RimCap`, bolt heads `Chrome` (the donor's lug nuts go: the game draws the house's, section 7, Lug nuts), the tire `Tire`; a source material named black stays `Black` (the Equip 02's slot walls). The lip's stock finish is the object's `lip` property, carried into the catalog entry: `chrome` on a multi-piece wheel (polished lips), `rim` on a one-piece (a monoblock is one finish, the default silver paint; the recipe's `lip` overrides either). A wheel is multi-piece when a ring of six or more bolts holds its lip (the house hex heads of step 6) or its title says 2P or 3P; a separate lip mesh in the donor says nothing, since jonver87 models a cast wheel's lip as its own piece too. The garage paints lip and cap apart from the face (section 7, Caps and lips). Chrome on any wheel surface is one look with no colour, and it mirrors a studio of its own (`src/render/car/chromeEnv.ts`), not the car's dark environment, which a flat lip mirrored as a black ring (section 7, Dark chrome lips). The game finds the bead where the `Tire` mesh meets the rest, so the size slider works on every wheel (`src/render/car/wheelFit.ts`); every tire is lathed at runtime in the house tire's place, the standard one too (`src/render/car/tireShapes.ts`; section 5b, Tires).

## 4. Recipe overrides

Most wheels need none. The fields:

| Field | When |
|---|---|
| `construction` | `'single'` or `'multi'`, stated on every recipe (2026-10-28): one piece (a cast or forged monoblock) or a bolted lip and barrel round a separate face. The pipeline never guesses it again; the stock lip finish reads it, the catalog carries it as `construction`, and the offset tooling acts on multi-piece wheels only. The first labels came from the old guess (a ring of six or more lip bolts on the model, 2P / 3P in the title, the recipe's `lip`), reviewed by the user: 55 multi, 58 single |
| `face` | `1` or `-1` when the face direction comes out wrong (the barrel shows in front) |
| `maker` | the donor's real maker, a key of `GROUPS` (always set) |
| `lip` | `'chrome'` or `'rim'` against the default (chrome on a multi-piece wheel, rim on a one-piece): `gekko` and `yuzu` keep their rivets on the face, `momiji` is a Work 3-piece line without lip bolts in the model, `hasu`'s three heads are no lip ring |
| `drop` | a regex of material or object names the junk words miss |
| `bolts` | `0` to keep no bolt circle |
| `normals` | `'geometry'` to shade the face from its own shape (split at 35°) when the donor's authored normals lean off its faces (the face reads dark) |
| `dark` | a luminance (0 to 1): faces whose base colour texture is darker go, for a tire welded to the wheel in one textured mesh (the CH-R: tire 0.10, wheel 0.45, cut at 0.25) |
| `pick` | `(axis, lo, hi)`: keep only the faces whose centre lies in that window of the import's own frame, for a scene holding several wheels (HRE 522M: two side by side; the SSR Collection: three in a row) |
| `cap` | the turned hub cap's radius, in shares of the lip, where the round test stops short of an opening a dropped logo cap covered (`momiji` 0.235) |
| `turn` | a share of the lip: on a multi-piece wheel, turn the face's surfaces of revolution joined to faces outside it, as on a one-piece, where a round flange the spokes stand on crumples in the collapse (`mio` 0.6) |
| `cap_max` | a share of the lip: cap-kind pieces of the donor with a vertex beyond it go to `Rim` before the cap is turned, so the cap is only the center disc where the donor's hub pieces (pocket walls, a bowl) were classified cap (`hinoko` 0.125) |
| `cap_edge` | a share of the lip, read off the donor: the center cap's own edge, where the piece classified as cap is the whole hub round it (a pad, ring or bowl, often one island with the cap). The hub is still turned with the cap, a piece of it that runs round the axle included, but only inside the edge is `RimCap`; outside it is `Rim`, and the turned hub ends in a 3 mm flange tucked under the face (`hari`, `homura`, `minamo`, `natsu`, `shirabe`) |
| `cap_fill` | `True` closes a cap ring's open center, so the whole center takes the cap's paint (`sora`, `shizuku`) |
| `offset` | `'fixed'`: the wheel ships as modelled whatever the car's target, its catalog entry carrying no `offset` (`hane`, section 5b, Offset) |
| `bias` | mm on the car, + outboard: the face moves that much past the car's target, or from stock on a one-piece (section 5b, Offset) |
| `lugs` | `0` when no lug circle shows (a cap or a solid face hides it), or `(count, r)` for the circle to take where the innermost is a decoration; a third item `{'at': deg}` places the circle from the recipe's count and r without measuring it (`asahi`, `shirabe`: the depth image cannot read their hubs) |
| `keep` | a regex of names the junk words would drop that are the wheel (`hibiki`: its spokes sit under a node named `DISK`, and the whole face went as a brake disc) |
| `chunks` | `True` for a scan cut into chunks that each run from the hub to the lip: its islands are no parts, so ring, bolt and decal islands all join the face and the lip is turned out of it as on a one-piece (`kaminari`, `fuuga`, `hinoko`) |

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

**Width.** `AxleStance.wheelWidth` (0.85 to 1.35, `STANCE_LIMITS`; 1 is stock, a missing value in an old save or share code reads 1; share key `ww`; the garage's slider reads it in half inches, the lip's edge to the barrel's back on that car and axle, `carView.wheelWidthInches`, converting both ways like the size slider's whole inches, since 2026-10-28; the track `offset` slider reads whole mm the same day) lengthens or shortens only the barrel. The face, the lip and everything from the outer face back to the spokes' back (`spokeBack`, the lowest X of any non-tire vertex between 0.3 and 0.75 of the bead radius) keep their exact shape; a vertex behind it goes to `spokeBack + (x - spokeBack) * width`, so the lathed barrel grows inward by the width (a deep dish, whose spokes sit near the back, has a short barrel to stretch, which is correct). The tire follows the barrel's back edge: its inner side (the lowest 20% of its width) shifts, not stretches, by `(width - 1) * (xBack - spokeBack) + tirePull` (`xBack` the rearmost non-tire X out where the barrel is), its outer 20% stays put, and the tread between is stretched so it stays one surface. Normals' X is divided by the local `dx'/dx`. `tirePull` (`wheelFit.tirePull`, measured once per bake against the lathed tire's profile) is how far the back bead must go at stock width to cover the barrel: the house barrels end at `X_BACK`, half the tire's width, while the lathed tire's bead sits at 0.42 of it, so every barrel stood 19 mm (22 mm on a car) past the back bead, under the standard tire's bulge and bare beside the mild and stretched ones' straighter back sidewalls (the chrome ring seen past the tread from the front, 2026-10-28); a back flange above the bead, which a stretched tire's inward-leaning sidewall would show, pulls it further. The tire is a 40-gon, so a vertex is tested at its radius over `cos(pi / 40)`. Measured over every wheel, size, width, tire shape and axle, nothing behind the face bead stands more than 1.3 mm outside the tire (before: 28 mm); what is left is the lip's edge just behind the face bead of a stretched tire, as designed. This is `remapWheel`'s `width` and `WidthFit` arguments (`wheelFit.ts`, measured per baked axle in `carView.bakeAxle`). Front and rear width are always separate, linked or not: the Wheels tab's Fit view shows both sliders when the wheels are linked, and neither Link toggle copies it. The brake does not depend on the width: its outboard-most point (the caliper's housing face, `brakeReach` in `brakes.ts`, 2 to 3 cm past the hat's face) is placed `BRAKE.clearance` behind `spokeBack`, scaled with the unit. **The barrel always covers the brake.** A deep dish has its spokes near the back, so the rotor and the caliper's inboard housing (`brakeDepth`, up to 10 cm at the reference bead) would stand out behind the barrel and the tire. `carView.applyWheelSize` therefore measures, per axle and whenever the size changes (the brake scales with the bead), the stretch `cover` (`barrelCover`: the brake's rearmost point plus `BARREL_MARGIN`, 8 mm, over the barrel's stock length `spokeBack - back`; 1 when the stock barrel already reaches that far) and `remapWheel` runs the width through `barrelStretch(width, cover)`: at or below 1 the barrel stretches by `max(width, cover)`, above 1 by `cover + (width - 1)`. The slider thus never pulls the back in past the brake, and above 1 it adds its share of the stock length on top of the cover, so it moves every wheel over its whole range (a wheel with cover 1, most of them, behaves exactly as before). The tire's inner band follows the barrel's back as before. The face and lip are untouched; only the barrel's inner shape stretches. A cover over 1.6 (a barrel more than 60% longer than stock; 14 wheels, the Hari and the other deep dishes) is a long barrel, and the tire widens inboard with it. Visual only: the sim never reads it.

**Offset** (multi-piece wheels only; 2026-10-28). Real multi-piece wheels are built to an offset: the same face in a narrower outer lip and a wider barrel for a higher ET, the reverse for a lower one. The game does the same at runtime, so one model serves every car, and the sim never reads any of it. The reference is the tire's centerline at x 0 in wheel space, so a wheel's **stock offset** (the catalog's `offset`, m, written by `wheel_offset` in `carWheels.py` at build: the lug seat where a circle was fitted, the nuts being what the eye reads against the lip, else the center cap's front, which covers them) is its ET at the house scale, and a per-car target per axle in ET moves the face by the difference. The ring's four stations are measured per baked wheel (`detectFaceFit`, `FaceFit` in `wheelFit.ts`: the face's back in the spoke zone, as `WidthFit.spokeBack`, its front inside 0.8 of the bead so a shard of ring left in `Rim` is not face, the lip edge and the barrel's back) and `faceShift` maps x: the face's own depth moves rigidly, so wherever it meets the ring it still does; the lip cone from the face's front to the edge bulb (`FACE_FIT.bulb`, 17 mm, kept whole) is squeezed or stretched into what is left; the barrel behind the face takes up the rest to its unchanged back; the tire never moves. `faceRange` is how far a face can go: out until `minLip` (10 mm) of cone is left, in until `minBarrel` (20 mm) of barrel is (the brake cover then stretches the barrel back out as it does for the width). A target beyond the range clamps to it. The targets are the car's: `targetOffset: { front, rear }` in `carManifest.json`, mm on the car (ET as a tuner reads it, through the wheel's scale on the car), one per axle, so a front can run a higher offset than a rear and a car whose hubs sit near the fender's edge a higher one than a car with inboard hubs under wide arches; a car without one ships every wheel as modelled. `carView.bakeAxle` measures the fit and sets `WidthFit.shift` once per bake (the catalog's offset moved by the bake's centering, since a dome proud of the tire shifts the box), `remapWheel` applies it before the width to every non-tire vertex (the house lug nuts whole, `rigid`), and the brake and the barrel cover measure from the moved spokes' back (`spokeBackOf`). Nothing per frame. The first targets (2026-10-28) are the user's example, front 30 and rear 10 on every car, to be tuned per car. Two per-wheel words in the recipe, carried into the catalog: `offset: 'fixed'` writes no offset, so the wheel ships as modelled on every car (hane, the BBS E52: its dome stands proud of the lip by design, an old school European style, and a target had set it 100 mm deeper); `bias` (mm on the car, + outboard; `offsetBias`) moves the face that much past the car's target, for a flush face whose seat sits at its very front and so reads deeper than a dished face at the same ET (hagane, hyo, shigure, akane, homura: 25), or, on a one-piece wheel or a fixed one, from stock, its only move (iwa, shio: 20; the user asked for these six out the same day). The Wheels tab's thumbnails (`garage/wheelThumbs.ts`) draw each face where the car on show sets it (its front target and the wheel's bias, mm taken at the house scale), keyed per car target, so a tile shows the wheel as it will be fitted. `npx tsx scripts/checkWheelOffset.ts` prints the baseline: stock offset, face stations, lip and barrel widths and the reachable offsets of every multi-piece wheel. The first run (55 wheels): stock offsets from -71 (tsukushi) to +132 (hane); the deep dishes (the SSR Collection, Longchamp, Emitz, Minerva, the VWS3) sit at -70 to -20 with 100 to 150 mm of lip, the flat faced ones (the BBS LM and E52, the Hasemi Prot-S, the VL7, the Meister S1) at +25 to +130 with their face at or proud of the lip, so they only go in. Momiji's first fix (a build-time `face_out` of 30% of the gap, 31 mm) was taken out the same day in favour of this, so its model ships stock at -23 and a car's target decides.

**Tires.** The garage's Stretch choice is None, Mild or Full (`TIRE_SHAPES`: `standard`, `mild`, `stretched`; `stretched` is the first stretched tire, so old saves and share codes keep their look, and the first set's `mildStretch` reads `mild`, `aggressiveStretch` `stretched`). Each shape is a half profile in `tireShapes.ts` (`PROFILES`; `standard` is `house_tire`'s with its bulge trimmed to the lip's edge, 1.07 of the bead against 1.24, so the sidewall sits flush with the wheel) lathed over the measured house tire (1,520 triangles; 1,360 on the stretched one) with two circumferential grooves cut into the crown (`TREAD.grooves`, laid out by arc length so every shape gets the same layout). Mild and stretched seat their face bead inboard of the stock one (0.95 and 0.88 of its x, a hair under the bead radius, after a short bead band under the lip's bulb), so the lip stands a band proud of the sidewall from the front and back, the way a stretched tire wears a wheel; every shipped lip is a rounded bulb 1.7 cm wide with the dish dropping away behind it, so the bead hides behind the bulb. The back bead stays at the stock x on every shape, so `tirePull` and the barrel cover are unchanged. The lip ring is only the bulb's visible shell, so `RimLip` is drawn both sides (`carView`), or its far side was see-through past a stretched bead. All shapes share one UV layout: u once around the tire, v in three bands (the face sidewall, the tread, a plain strip the back sidewall is pinned to). `tireTread.ts` draws the one shared texture (2048 x 512, one RGBA canvas used as bump, roughness and ink): our own semi-slick pattern in the manner of a road-race tire, with a wide groove toward the inner shoulder and a narrow one toward the face side, big slanted cuts across the face shoulder that run off onto the sidewall, solid blocks across the crown and small notches on the back shoulder, 32 pitches around. Medium and up wear it; Low is plain rubber on the same lathed geometry. The printed sidewall lettering (ink only, no relief, so nothing mirrored shows on the right side; a fictional brand and model line, `TIRE_BRAND`) is a second variant of the same texture, chosen by `VisualBuild.wheels.lettering` (Fit view, off by default, share key `lt`): off keeps the plain texture, so it costs nothing. The right side's holder is mirrored and its tread mirrors with it, so the cuts slant the same way against travel on both sides; the tire shader reads only the lettering with u flipped there, so it reads true on both sides. Visual only: the sim never reads it.

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
| Kitsune | HRE | Tora (P200) |
| Nue | Volk | Iwa (Rays 21C) |
| Seiryu | SSR | Homura (Koenig) |
| Kappa | Fifteen52 | Tsuchi (Rally Sport) |
| Yamabiko | Work | the twelve above, Gekko (LS Chiarezza SUV, `bolts: 0`: its rivets sit in pairs and the histogram read three) |
| Oni | Rotiform | Nami (ZMO), Shizuku (Aerodisc), Uzu (VCE), Kawa (SIX), Taki (AVS), Minato (KB1), Kiri (USF), Shio (MLW), Ame (OZR), Yuki (BM1), Shigure (WRO), Umi (CCV), Hyo (LHR), Tsuyu (LSR), Kori (KLU), Mio (SNA), Fubuki (KPS), Seseragi (PNT) |
| Tanuki | Vossen | Aoi (LC104T), Sora (LC109T), Hikari (VPS302), Kagami (VPS301), Seiun (ERA3), Getsuei (GNS-1), Kirameki (VPS 315T), Hisui (CG203) |
| Fujin | BBS | Hane (E52, `normals: 'geometry'`) |

Retired names (`kiba`, `hoshi`, `rensa`, `tsuki`, `ginga`, `hibana`, `senko`, `arashi`, and `kozue`, the 326 yabaking spoke, removed 2026-10-28 with its Kirin group) are never reused, so an old save never shows a different wheel under its name. The one check that found a wheel the sheet hid: the mean shading normal of each wheel's front facing `Rim` faces along +X, 0.75 to 0.97 on a good wheel, 0.19 on the E52 before `normals: 'geometry'`.

### Two new authors (2026-10-28)

The user sent five links; three were refused before import: a TE37 Ultra Track Edition II (Sketchfab Standard, not downloadable), a Rotiform LHR-M (no licence, not downloadable) and an Enkei RS05RR (tagged `noai`). The two kept are the first wheels not by jonver87, and both arrive differently from his:

| Group | Maker | Wheel (donor, author) | Recipe |
|---|---|---|---|
| Kamaitachi | Enkei (new group) | Kiseki (Enkei Nt03+m Wheels, flathat3d) | `drop` its three stacked logo caps and the lip lettering (a flat 4,500 face piece); `normals: 'geometry'` |
| Fujin | BBS | Hien (BBS CH-R + Goodyear Eagle F1 Supercar 3, MozzarellaARC) | `dark: 0.25` |

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

56 donor models from jonver87 (37), dermaks (17), portfoliorodrigues (the Fifteen52 Turbomac) and alexanderlyreo (a Work Meister S1 3P) became **54 wheels**, 100 in the set, 5,418 to 11,381 triangles each (under the 12,000 budget; the smallest is `sagi`, a four spoke whose face is 2,258 of them, the largest `tsubaki`). Names are new pseudo-Japanese words (retired and taken names skipped: `tsubasa` belongs to another file); 13 makers got fictional groups (Advan Baku, Avant Garde Byakko, Brixton Forged Hiryu, Kyusha Shoes Mizuchi, Velare Shuten, VIP Modular Suzaku, Weds Tengu, 326 Power Kirin, Brabus Genbu, Budnik Hotaru, Devil Japan Kaito, Kansei Kodama, MAE Nekomata); Rays goes under Volk's Nue and Vossen-x-Work under Tanuki (`GROUPS` maps the real maker, so a collaboration or a sister brand needs only a key).

**Kitsune** (HRE)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Akatsuki | HRE TUSK | jonver87 | no overrides |
| Hasu | HRE FF04 | jonver87 | no overrides |
| Kanade | HRE 522M | jonver87 | `pick`: the scene holds two wheels side by side; the one on +X (906k faces for both) |

**Tengu** (Weds; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Uguisu | Weds Kranze Bazreia | dermaks | no overrides |

**Nue** (Rays, Volk)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Suzume | VOLK TE37SL 3spoke | jonver87 | `face: 1` (0.59 down the barrel, 0.15 turned); 1.25M faces, 40 s a build |
| Tamashii | RAYS TE037 | dermaks | the TE037 pair: this one kept (see below) |
| Tomoe | Volk Rays 21A | jonver87 | no overrides |
| Zan | RAYS nismo LMGT1 | dermaks | no overrides |

**Seiryu** (SSR)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Hanabi | SSR Starshark | dermaks | no overrides |
| Hotaka | SSR Longchamp XR4 | dermaks | deep dish (0.66 down the barrel); the 8-bolt flange rebuilt |
| Koyomi | SSR Collection Mk3 | dermaks | `pick` on y: Mk3 spokes on the shared lip |
| Nadeshiko | SSR Collection Mk1 | dermaks | `pick` on y: one of three wheels in a row along the axle, on one shared lip |
| Tsukushi | SSR Collection Mk2 | dermaks | `pick` on y: Mk2 spokes on the shared lip |
| Yuzu | SSR Minerva | dermaks | no overrides |

**Kappa** (Fifteen52)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Wakaba | fifteen52 Turbomac | portfoliorodrigues | 986k faces by portfoliorodrigues; the 5x108 render model reduces to 10,344 triangles |

**Yamabiko** (Work)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Inazuma | WORK EMOTION T5R 2P | dermaks | no overrides |
| Kasane | WORK Equip 05 | dermaks | no overrides |
| Yamabuki | Work Meister S1 3P | alexanderlyreo | by alexanderlyreo; one welded mesh, its brake rotor and hat with it: deleted by hand after `wheel()` (the islands behind the spokes), or the game's brake sits behind a second rotor |
| Yoake | WORK MEISTER CR01 | dermaks | Work badge sticker and black spoke faces stay `Black` |

**Nekomata** (MAE; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Mikazuki | O.Z MAE | dermaks | no overrides |
| Minamo | MAE CROWN JEWEL | dermaks | `face: 1` (0.76 down the barrel, 0.39 turned; the same template as the MAE above reads 0.44 on the vote) |

**Baku** (Advan; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Ayame | Advan A3A | jonver87 | no overrides |

**Kamaitachi** (Enkei)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Tsutsuji | Enkei Riverge | jonver87 | `face: -1` (0.56 down the barrel, 0.39 turned); FBX upload |

**Oni** (Rotiform)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Chidori | Rotiform WRG | jonver87 | no overrides |
| Daichi | Rotiform IHR | jonver87 | no overrides |
| Natsu | Rotiform HVN | jonver87 | `face: -1`: `face: 1` (the vote's plate 0.6 down the barrel) showed the plate's back; rebuilt 2026-10-28, depth 0.61, the concave plate deep in a polished dish |
| Nokaze | Rotiform SEA | jonver87 | no overrides |
| Ogi | Rotiform RSC | jonver87 | `face: -1` (0.73 down the barrel, 0.05 turned) |
| Sakura | Rotiform EMA | jonver87 | `face: -1` (0.85 down the barrel, 0.09 turned) |

**Kodama** (Kansei; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Sazanka | KANSEI TANDEM | dermaks | no overrides |

**Genbu** (Brabus; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Yuhi | BRABUS MONOBLOCK M | dermaks | no overrides |

**Hiryu** (Brixton Forged; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Fuyu | Brixton Forged TR06 | jonver87 | no overrides |
| Ibuki | Brixton Forged VL7 | jonver87 | `face: -1`: the vote put the lattice 0.7 down the barrel (0.15 turned) |
| Kaen | Brixton Forged PF6 | jonver87 | no overrides |
| Shirube | Brixton Forged CM16 | jonver87 | `face: 1` (0.73 down the barrel, 0.17 turned) |

**Hotaru** (Budnik; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Sagi | Budnik Tusk | dermaks | no overrides |

**Suzaku** (VIP Modular; new group, renamed from Raijin on 2026-10-28, which is the brake brand on the calipers)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Sango | VIP MODULAR VXS410 | jonver87 | no overrides |
| Sazanami | VIP MODULAR VX510 | jonver87 | no overrides |
| Tsubaki | VIP Modular VXS610 | jonver87 | FBX upload; the normal vote kept (0.58 down the barrel, 0.49 the other way: a deep dished plate) |

**Tanuki** (Vossen, Vossen-x-Work)

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

**Kaito** (Devil Japan; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Asagi | Devil Japan IF | dermaks | deep dish (0.64); same lip and bolt flange as the Longchamp XR4 |

**Mizuchi** (Kyusha Shoes; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Enishi | Kyusha Shoes Meteor FF | jonver87 | no overrides |

**Byakko** (Avant Garde; new group)

| Wheel | Donor | Author | Recipe and notes |
|---|---|---|---|
| Genki | Avant Garde F450 | jonver87 | no overrides |
| Haruka | Avant Garde F142 | jonver87 | no overrides |

**Shuten** (Velare; new group)

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

- **Two new shared materials.** `RimLip` (the turned lip and barrel) and `RimCap` (the center cap) join the vocabulary (`SHARED` in `carKit.py`, `MATERIAL_NAMES` in `src/shared/parts.ts`). Every wheel ships them; `Chrome` is left to bolt heads and lug nuts. Each catalog entry records its stock lip (`lip: 'chrome' | 'rim'`, 50 and 49 of the set since the stock lip rule of 2026-10-28, below), so a build's lip on `stock` keeps the look the wheel shipped with.
- **The garage.** `VisualBuild.wheels.lip` and `.cap` (`WheelTrim`: `mode` stock / face / chrome / paint, plus a colour and finish for paint; share keys `lp`, `cp`, the mode `md`) apply to both axles; `face` wears each axle's own wheel paint, `stock` each axle's wheel's own lip. The cap defaults to `face`, so a cap matches the wheel unless painted; an old save or share code reads a stock lip and a face cap. Materials `RimLip`, `RimCap` and their `...Rear` copies are painted in `applyVisualToMaterials`. The runtime split of a Chrome cap onto the face material went with it.
- **Every cap is turned clean** (`clean_cap`). A cap's (x, r) profile is measured by rays down the axle at 48 radii, each the median over 24 angles, so a maker's logo or lettering, raised or engraved, which covers only some angles at any radius, drops out, while the cap's dome, steps and skirt stay; the profile, thinned to 12 points, is lathed at 40 segments in `RimCap` in the cap's place. Hari's hex center-lock nut and badge became a stepped dome. A ring of donor lug nuts round the hub (inside 0.35 of the lip, so once classified as cap, but starting outside 0.15) is hardware and stays `Chrome`: hasu, kasane, sazanka, shizuku, sora, tamashii, tsurugi, yuhi, yuzu.
- **A cap moulded into the face** (`hub_cap`): where the wheel has no cap piece, the hub's round center, from the axle out to where the rays stop finding a round surface (90 % of them hit and their spread is under 3 mm; inside 0.12 of the lip half will do, since a logo breaks both near the axle), is replaced by the same turned cap. Sixteen wheels: the Brabus "B" on yuhi and the XR4 badge on hotaka went this way. Tsutsuji's open bore has no cap. Momiji's donor cap was a logo decal over a star shaped opening wider than its round hub, so its recipe sets `cap: 0.235`; and a profile now always reaches the edge of the faces it replaces (it stopped at 0.198 there and left a ring of holes).
- **Shipped without the donors.** `retrofit_hub(name)` brings a built wheel up to date in place: the lathe's faces (quads on its 56 segment angles outside half the lip) go to `RimLip`, the stock lip is read from what they were, and the Chrome cap is turned clean. All 98 wheels not rebuilt went through it; `wheel()` does the same at the end of every build.

### Lug nuts (2026-10-28)

The user: "normalize hex lug bolts for all of our wheels. Some have lug nuts in their models and some have none." Some donors carried nuts as separate pieces, some cast into the face, many showed bare holes. Now no wheel model carries a nut: the game draws one house nut on every wheel that shows its lugs, from the lug circle each catalog entry records.

- **Measured, not modelled** (`fit_lugs`). A depth image of the hub (rays down -X every 0.004 of the lip) is split into blobs that stand proud of their ring's median depth (a nut), sit below it (a pocket) or let the ray through (a hole); a lug circle is 4 to 6 blobs at one radius (within 0.02) and equal angles (within 4 degrees), between 0.13 and 0.32 of the lip, 0.02 to 0.1 across (`LUG`). The innermost circle wins (decorative windows, spoke gaps and rim rivets sit further out and run to 10), and at one radius a hole beats a pocket beats a nut (kaze's raised bosses between its lug holes made a circle of their own). 85 wheels have one: 73 with five, 12 with four, none with six; 15 show none (a big cap or a solid face: ame, botan, chidori, hagane, hane, hari, homura, hyo, mikazuki, minamo, natsu, sagi, shigure, shizuku, taki).
- **The donor's nuts go.** Chrome within each lug's radius (the nut rings once classified as caps, the SSR set's 1,400 faces of them), and face standing proud of the seat within what the house nut covers (a wider cut opened the face round kaze's lugs before the limit).
- **The seat** is the surface just round each lug: the upper quartile of 16 rays on a circle 1.3 seat radii out, the median over the lugs (`_seat_x`). The ring's median depth over the whole circle ran up spokes and down windows (yari's nuts stood 6 mm proud of the face round their holes), and the median of the 16 sank kasumi's nuts 21 mm through its mesh face.
- **The catalog** carries `lugs: { count, r, phase, x, size }` (`WheelLugs` in `src/shared/parts.ts`), in the GLB's own frame: glTF y is Blender z and glTF z is -Blender y, so `phase` is `atan2(-y, z)` of the first lug in Blender. The object's `lugs` property (JSON) goes through `exportCar.py`'s wheel meta to `buildAssets.ts`. Checked against the shipped GLBs: rays down the catalog's lug centers fall through the holes (akatsuki, kaen, yari, kaze) and land on the seat between them.
- **The game** (`src/render/car/lugNuts.ts`): one closed-end tuner nut, about 16 mm across the hex (scaled down from 19 mm after the first look; stack 17 mm, was 20), a conical washer that covers the hole (`size`), a flat shaded hex and chamfer and a rounded end, 62 triangles; `lugsGeometry` places the circle as one geometry, which `carView.bakeAxle` adds to the axle as one more mesh, remapped with the face by the size slider and left out of the profile and spoke measurements. Materials `Lug` and `LugRear`; the garage's Lug nuts choice (Chrome, Black, Gold, Red, Blue, or Cap: the axle's center cap finish; share key `ln`, default chrome) paints them on both axles. Cost: one draw call and 248 to 372 triangles per wheel. The wheel tiles draw them too (`wheelThumbs.ts`).
- **Five hubs with the wrong holes (2026-10-28).** The user: "floating lug nuts are still on: zan. inazuma, yoake, kaen and tsume are clocked on the wrong holes". Every one is a dual drilled or decorated hub where "innermost wins, a hole beats a pocket beats a nut" chose the wrong circle; each is fixed in its recipe's `lugs` (count, r over the lip, and an optional dict `fit_lugs` reads: `phase` in degrees, `seat` in m). **Zan** (ten holes on one circle): five stud holes in pockets with a plate at the mounting plane (x 1 mm) alternate with five open bores that have no floor; the nuts floated 36 mm above the bores' ledge because `_recess` found no floor in a hole it could see through. `lugs: (5, 0.23, {'phase': 36})` takes the stud holes, and `_recess` seats them on the plate (x 1.3 mm, washer 9.5 mm). **Inazuma**: the five counterbored pockets at r 42.6 mm, not the ring of ten small decorative holes inboard; `(5, 0.205)`, seated at the bottom of the bore (x -65 mm). **Kaen**: the five round holes at r 43.5 mm, not the holes at the inner ends of the slots; `(5, 0.21)`, x 22 mm. **Tsume** (4x100 and 4x114.3): the four countersunk holes on the spokes, not the hex collars between them or the crescents `_recess` first picked; `(4, 0.275, {'seat': 0.010})` puts the nut where the cone is 10 mm out (x 15.8 mm), since the floor `_recess` finds is the cone's bottom, 2 mm inside the material at the washer's edge. **Yoake**: the five stepped pockets that held the donor's black nuts (the plain holes between them won), a ledge above the stud tube; `(5, 0.294, {'seat': 0.012})` seats on the ledge (x -10 mm), and with `seat` the donor's nut goes down to it, slivers of its flange and body included (846 faces off the shipped model), where the proud-of-the-face rule left a jagged stump in the pocket.
- **Hardware (2026-10-28).** The `Chrome` faces of a wheel model (the house hex bolt heads on a multi-piece lip, a few donor bits) wore the car's shared `Chrome`, so they could not be painted apart from the body's trim. `carView` now swaps a wheel mesh's `Chrome` for `Hardware` (front) or `HardwareRear`, runtime materials painted in `applyVisualToMaterials` like the lug nuts. `VisualBuild.wheels.hardware` is a `WheelTrim` offering cap / face / body / paint (share key `hw`, default chrome, so an old save or share code looks as before); the garage shows the Hardware row only when the selected wheel's catalog `materialSlots` include `Chrome`. Body parts keep `Chrome`.

### Outer sections and stock lips (2026-10-28)

The user: "ame, uzu, yuki, sazanka and taki need to be rescanned, the outer section of the wheel appears quite broken and glitchy", "3 piece wheels should have chrome lips by default, single piece wheels should be silver metallic by default", and kozue went.

- **One-piece lips** (ame, uzu, sazanka, taki; all four had no lip piece, so `_turned_faces` picked the lip out of the face). Three faults in one place. The ring's profile rays ran in 12 planes 30 degrees apart, which meet a 6 or 12 spoke wheel at the same spot in every bay: on the OZR the bar between a bay's two pockets, so all twelve passed it and the median was the barrel behind; they now step by the golden angle (16 planes). The turned test flickered on a smooth dish and among pockets (some faces turned, their neighbours not, a millimetre apart), and turned a round dish inside the VCE's ring of windows that the profile never reached, so the lathe joined lip and dish with a cone through the face (the "turbine" of slivers on uzu); only turned faces joined to the lip edge count now. And the profile has the last word: a face on it is turned, a turned face off it stays face (`_turn_to_profile`), so the lathe replaces exactly what it reproduces. Ame's pockets, uzu's smooth dish and 16 windows, taki's spoke tips and sazanka's dish wall now read as the donors do.
- **Sazanka** is a one-piece Kansei Tandem: the raised KANSEI / TANDEM lettering on its dish wall made a bolt circle of 13 house heads, so its recipe sets `bolts: 0` (the lettering goes with the bolts, as branding should).
- **Yuki**'s lip was clean; its flat face plate showed big shading triangles from the donor's normals on the collapsed plate: `normals: 'geometry'`.
- **Six more rebuilt** with the same fixes, each checked against its donor from the front and 60 degrees. **Botan** (Velare VLR F1): a sunburst of slivers on its dish, like uzu's; cleared. **Minato** (Rotiform KB1) and **shizuku** (Aerodisc): a toothed band of half-turned windows at the lip; cleared, the windows read as the donors'. Shizuku's center nut is a ring round a logo plate, so the turned cap left the bore open: `cap_fill: True`. **Rin** (Vossen CG207): ragged spoke tips at the lip; cleared. **Mio** (Rotiform SNA) has a lip piece, so nothing of its face was turned, and the round flange its spokes stand on was collapsed with the spokes and crumpled between the tips: a new recipe field, `turn` (a share of the lip), turns a multi-piece wheel's face the way a one-piece's is turned, from faces outside it (`mio: 0.6`). **Hisui** (Vossen CG203): shards on the barrel through the spokes, a cause of its own. Its barrel has two skins 3.5 mm apart; the turned test took some strips of the inner one, the profile ran on the outer, and the rest stood in front of the lathe. A face of the barrel's inside (its normal toward the axle, its center 6 cm or more behind the lip edge) within 5 mm of the profile is now turned with it (`_turn_to_profile`). Ame, uzu, sazanka and taki were rebuilt again under the final code and came out face for face the same.
- **Momiji** (Vossen-x-Work VWS3) is a Work 3-piece line without lip bolts in the model: `lip: 'chrome'`.
- **Yuhi**'s lug nuts were reported scattered in the garage. The model is right: its face sits on the axle (the outer edge's first harmonic 0.0 mm, the lug circle's center 0.04 mm off), the five lugs are open holes at r 38.8 mm (rays down each catalog lug center fall through) with the cap well inside them, so the nuts belong (no `lugs: 0`). Its holes are pockets 23 mm deep and the nuts sit at their mouths on the dish (`x` 0.093). The same off-axis check over all 99 wheels (the lug circle's center where there is one, the first harmonic of the face's outer edge) found no face over 1 mm off the axle: lug circles all within 0.5 mm (hane 0.49 after its hand fix), and the edge harmonics over 1 mm (getsuei, hisui, kagero, tamashii, wakaba, up to 2.3 mm) come with lug centers within 0.4 mm, so they are a valve notch or an uneven tip, not a face off its axle.
- **Stock lips.** A wheel is multi-piece when a ring of six or more bolts holds its lip or its title says 2P or 3P (`wheel()`'s default; the donor's separate lip mesh no longer decides, since jonver87 models cast wheels' lips as pieces too). 16 changed, then 49 chrome and 50 rim, now 50 and 49 with momiji's override: ayame and ibuki to chrome (lip bolt rings of 12 and 20); akatsuki, enishi, kagero, kaze, kiri, mio, momiji, ogi, sagi, sakura, shio, tora, uguisu and ukigumo to rim (no bolts; kaze's and kagero's `lip: 'chrome'` overrides went). Overrides: `gekko` and `yuzu` stay chrome (their rivets are moulded into the face, so no bolt circle is rebuilt), `hasu` stays rim (three heads, no lip ring).
- **Kozue** (326 yabaking spoke) is retired with its Kirin group; 99 wheels.

### Twelve from other authors (2026-10-28)

The user sent 30 links; 12 were refused before import (no licence or not downloadable: the Mini JCW BBS LM-R, HRE 501, zakuro_inc's BBS FI-R, a TE37 style, BBS Super RS, Volk 21A, Fikse AR and 701; tagged `noai`: Dream_Labs' Car Wheel Sport and Race; Editorial: mozzarellaARC's BBS FI-R and CI-R, TinoD2's SSR Professor TF1) and 6 skipped (already shipped from the same uid: the T5R 2P, Longchamp XR4 and Minerva; a third TE37 beside `tamashii`; TinoD2's Equip 03, which its author calls not true to the original, against `yari`; blakebella's unfinished T5R beside `inazuma`). Twelve became wheels, 111 in the set, 5,511 to 10,645 triangles. Spoon is a new maker: **Orochi**.

| Wheel | Donor | Author | Group | Recipe and notes |
|---|---|---|---|---|
| Kawasemi | Spoon SW388 | TinoD2 | Orochi (Spoon; new) | `drop: 'LowPoly\|Tire'`: a stand scene with a low poly copy, both on tires |
| Kazakiri | Work Emotion CR-KAI | gordeykomark | Yamabiko | `drop` its tire and valve; a 4.3k game-ready model, so the face keeps every triangle (5,523 in all) |
| Tatsumaki | Rotiform DAB | blakebella | Oni | `drop` its tire (the rotor goes as junk); 450k triangles of lip rivets became 40 house heads; 24 s a build |
| Kogane | BBS LM Gold Wheels | zxargon | Fujin | no overrides; a 7.1k low poly model without a tire, 20 lip bolts |
| Namida | S13 Teardrops Rims | Once_a_goat_death | Kappa (filed under Fifteen52 at the user's call; its page calls it the Nissan S13's stock wheel) | no overrides; tagged `createdwithai` by its uploader (not `noai`) |
| Akane | SSR Hasemi Prot-S | techtackofficial | Seiryu | `face: 1`: the vote put the spokes deep in the barrel, the center cap and lip bolts face +X |
| Tsukimi | Rotiform CVT | niev | Oni | `drop` the valve (`Nipel`) |
| Himawari | WEDS Kranze LXZ | blakebella | Tengu | `drop` its tire (material `Material`) |
| Hibiki | RAYS GramLights 57DR | ilvskf | Nue | `drop` the stickers, `keep: '^DISK\.'` |
| Kaminari | Rays Gramlights 57CR | ilvskf | Nue | `drop` the stickers, `chunks`: without it the face stood 18 cm proud of barrel scraps read as the lip, and 109k triangles of spoke went as bolts |
| Fuuga | RAYS G025 | ilvskf | Nue | `drop` the sticker, `chunks` |
| Hinoko | RAYS HOMURA 2x7 | ilvskf | Nue | `chunks` |

- **Check what a scan is made of.** ilvskf's four are 3D scans (376k to 704k triangles) that Sketchfab's processing cut into chunks of about 100k, each running from the hub to the lip; the islands the classifier sorts by radius are then pieces of one surface, not parts. Each also carries a node named `WORK_VS_XX_obj_cleaner_materialmerger_gles` (Sketchfab's name for a downloaded model) holding the barrel: it looks taken from jonver87's WORK VS-XX (CC BY 4.0, our `ryusei`), which ilvskf does not credit; the README credits it.
- **Lugs.** `fit_lugs` found no circle on akane, hibiki, himawari, kazakiri and namida: a center cover hides them on akane, kazakiri and namida, and the pockets on hibiki and himawari sit at 0.28 to 0.34 of the lip, past `LUG['band']`, with too much noise for a blob even when the band is widened. They ship without house nuts.
- `checkWheelFacing`: all twelve `front` 0.97 to 1.00, depth 0.02 to 0.32.

### Two more (2026-10-28)

Two links, both CC BY 4.0 and downloadable; 113 wheels. **Konig** is a new maker: **Kohaku**.

| Wheel | Donor | Author | Group | Recipe and notes |
|---|---|---|---|---|
| Shirabe | Konig Countergram 5x120 Wheel / FREE MODEL | shevchenkovisuals | Kohaku (Konig; new) | `drop: 'Tire\|Text\|Lug Nuts'`, `lugs: (5, 0.2217, {'at': 0})`; 1.08M faces, 45 s a build, 10,928 triangles |
| Asahi | Enkie Rpf1 (Enkei RPF1) | astrubal | Kamaitachi | `face: -1, chunks: True`, `lugs: (5, 0.2207, {'at': 0})`, `drop` of the corner's other materials; 5,347 triangles |

- **Shirabe**: a one-piece nine spoke, so no lip bolts and a `rim` stock lip. Its tire, valve, the lettering on the dish wall and the nuts are separate nodes; the faces, the stepped lip and the black center cap all arrive as one island and one cap, and the lip is turned from 29 points. The donor's nuts were tall closed ones standing on a bare chrome hub round the cap (no hole, no pocket), so `fit_lugs` found no circle; its recipe gives the five nuts' own circle (read from the dropped mesh: r 45.9 mm, the first straight up), and `_seat_x` seats them on the hub (x 38 mm). Checked with 16 mm hex prisms at the catalog positions: all five stand on the hub clear of the cap.
- **Asahi**: the model is a whole corner (wheel, 17,881 face tire, calipers, rotor, hub, pad clips), and the tire is the biggest round thing in it, so the first build took it for the lip (scale x0.80, a wheel with a barrel 0.45 m long). The wheel is the one `Metal` mesh; the recipe drops everything else by material name. It is two islands, a face that carries the lip's front flange and a barrel behind it, so a `ring` island's front edge sat 0.2 m behind the face and the face stood detached in front of the lathe; `chunks: True` merges them and the lip is turned out of both (96 faces turned, no sliver). The vote was wrong (`face: 1` put the spokes at 0.93 of the way down the barrel); `face: -1` reads 0.12 (`checkWheelFacing`, front 1.00). The five stud holes are 16 mm deep pockets round a recessed plate; the house cap's disc covers the inner edge of two, so the depth image split one pocket in two and lost another (r .192 and .244 against .21 to .22), and no circle of five formed. The new `lugs` option `at` places the circle from the donor's own holes (measured on the mesh: r 45.7 mm, 11.7 mm holes).
- The shipped GLBs read `front` 1.00, depth 0.12 (asahi) and 0.20 (shirabe), none wound, no RimCap face toward -X.

### Valve stems and lip shards (2026-10-28)

Two donor leftovers that `_drop_loose` kept because they touch the wheel, now removed last in `wheel()` by `_drop_shards_and_stems`.
- **Valve stems.** The game draws none, but 25 donors modelled one (a stem, often with a nut and cap, as separate islands at one angle, always at 12 or 6 o'clock after the frame, so exactly 90 degrees or -90). The rule is geometric and needs no recipe: a compact island (50 mm across at most, 600 faces at most, 12 at least) beyond 0.145 m from the axle, 3 mm or more deep along it, with no island at its radius (4 mm) at another angle (10 degrees or more), so a ring of rivets or lugs is never one. Removed from tsuchi, seseragi, hikari, kagami, hien, kaen, nagi, ibuki, sango, wakaba, yamabuki, yoake, zan, kasane, asagi, inazuma, hanabi, nadeshiko, tsukushi, koyomi, hotaka, sazanka, kazakiri, hari and ame, by running the function over the built wheels in wheels.blend (rebuilding picks it up). Not caught: shizuku's 17 face piece at 0 degrees, which has a ring mate at its radius.
- **Lip shards (ayame).** Its Advan A3A showed about 200 glitching triangles round the lip and barrel edge: single triangle islands (and a few of up to 12) lying within 2.5 mm of the lathed ring, leftovers of the donor's lip surface that the cull and the collapse had cut into slivers, z-fighting the lathe. A shard island is deleted when every vertex is that close to `RimLip`. 244 triangles went from ayame. The same shards exist on about 60 other built wheels (ame 730, shizuku 135, kanade 120, sora 126, kaminari 51, botan 49 and others, counted on 2026-10-28), so a rebuild of those picks the fix up; they were not touched in place.

### Three oversize caps (2026-10-28)

The user: kaminari's, kazakiri's and momiji's center caps were out of proportion (momiji: "it should just be the inner circle that's the center cap"). Compared with each donor re-imported at the same scale.

- **Shared cause** (kaminari, kazakiri): `_classify` calls any small island that starts inside 0.2 of the lip a cap, so a donor's lug nuts and a scan's hub pieces were `RimCap` faces beside the real cap, and `_cap_profile` turned the whole lot, out to the outermost of them, as one flat disc (its profile always reaches the edge of the faces it replaces). `clean_cap` now keeps only the connected piece that reaches inside 0.15 of the lip as the cap; the other pieces go: raised 6 mm or more (nuts), deleted, flat, back to `Rim` (the hub).
- **Kazakiri** (Work Emotion CR-KAI): the donor cap is a 28 mm dome on a hub recessed 9 mm, five nuts at r 47 mm in 13 mm radius counterbores. The shipped cap was a 57 mm disc (0.276 of the lip) laid flat at the recess floor over the nuts' seats, so `fit_lugs` saw no circle (the earlier note that a cover hides them was this bug). Now the dome is 29 mm (0.14), the rays down -X match the donor's at 0 to 30 mm to within 0.3 mm, and the lugs are found: `lugs: (5, 0.229, {'x': 0.022})` (new `x` option: the rays round a lug read the counterbore's wall at 56 mm, the nut belongs on the ledge at 22 mm). Checked with 16 mm hex prisms: all five stand in the counterbores.
- **Kaminari** (Rays 57CR): the donor has no cap at all, an open 24 mm bore in a bare hub with five nuts at r 51 mm in pockets 14 mm deep. The shipped cap was a disc 62 mm across (0.30) at x 53 mm, buried by the hub's cone beyond 48 mm, with a lug circle at r 55.7 mm on it that sat 10 mm under the cone. Now the house cap over the bore (32 mm, 0.153 of the lip), the hub as the donor has it, and the lugs at r 50.8 mm, seat x 41 mm (the nuts' own circle, checked with prisms).
- **Momiji** (Vossen-x-Work VWS3): the donor's cap is the logo disc in a 3 mm recess, 20.8 mm across (0.1 of the lip), with the five nuts out at r 40 mm and the hub's cone between. `cap: 0.235` had turned the whole hub pad, 48 mm across, as the cap. `cap: 0.105` (an explicit radius may now be under 0.12 in `hub_cap`; it must clear the fan's rim vertices at 20.8 mm) makes the cap the recess floor alone. The lug seat, which had read the oversize cap, is `x: -0.0229`.
- **Same symptom elsewhere, not changed** (cap radius over the lip, from the shipped models; `akane` 0.21 was rebuilt later the same day, the user having spotted its cylinder of a cap: the donor's lug mesh, nuts and plate out to r 39 mm, reaches the center, so `clean_cap` took it as the cap; `cap_max: 0.15` leaves the 23 mm center piece alone as the cap, turned to a small dome in its serrated ring, no lugs since the real Prot-S hides its nuts under a cover, 8,877 triangles): `hibiki` 0.27 (a sibling of kaminari from the same author; rebuilt later the same day from a fresh import under the current `clean_cap`, the user having spotted the oversize cap over its nuts: the donor has no cap, an open bore in a dual drilled hub with five separate nuts, so now the house cap at 0.15 and 5 lugs at r 46 mm, seat x 48 mm, 9,284 triangles), `tatsumaki` (visible 0.24, cap faces out to 0.295, lugs at 0.27; fixed, see Five wheels, below), `namida` 0.30, `akane` 0.21 and `sagi` 0.23 (no lugs: a cover is the claim, unchecked), `minamo` 0.29, `natsu` 0.28, `hari` 0.30, `homura` 0.29 (these four fixed, see Five inner caps, below). Each wants a donor comparison like these.

### Five wheels: caps and lugs (2026-10-28)

The user: himawari's center cap stays black, fuuga's cap should be only the center circle, hinoko's cap color shows behind the lug nuts, tsume's nuts belong on the other holes, tatsumaki's cap is way too large. Each compared with its donor re-imported at the same scale (front view, same frame).

| Wheel | Cap radius before | after | Lugs before | after |
|---|---|---|---|---|
| himawari | none in `RimCap` (a Chrome disc, 31.2 mm, 0.150) | `RimCap` 31.0 mm (0.150; visible 0.145) | none | none (see below) |
| fuuga | 59.0 mm (0.285) | 31.2 mm (0.150) | none (`lugs: 0`) | 5 at r 44.6 mm, phase -1.887, x 52.8 mm |
| hinoko | 56.8 mm (0.274) | 25.6 mm (0.123; visible 0.115) | 5 at r 36.2 mm, phase -1.2615, x 76.6 mm | 5 at r 45.4 mm, phase -1.2549, x 77.5 mm |
| tsume | 32.9 mm (0.159), unchanged | same | 4 at r 57.0 mm (on the spokes), phase -1.570, x 15.8 mm | 4 at r 49.2 mm (diagonals), phase -2.356, x 31.6 mm |
| tatsumaki | 61.1 mm (0.295) | 29.2 mm (0.141; visible 0.140) | 5 at r 56.2 mm, x 43.8 mm | 5 at r 50.3 mm, phase -1.2555, x 43.6 mm, washer 12.6 mm |

- **Himawari**: the donor's cap is a flat logo disc with 60 triangles and no center vertex (31.2 mm, 0.150 of the lip *to the dot*), so `clean_cap` read "no vertex inside 0.15" as a ring of lug nuts and made the whole disc `Chrome` (the same trap that catches a cap which has no vertex at the axle). A cap now also counts when one of its triangles holds the axle (`_covers_axle`, a shared change, only ever turning a Chrome "nut ring" into a cap). Rebuilt; it ships `RimCap`, 40 triangles. Its donor's nuts are cast into the face as hex heads and `fit_lugs` still finds no circle (the pockets sit past `LUG['band']`), so there are no house nuts, as before.
- **Fuuga**: the shipped cap predated `clean_cap`'s center-piece rule (2026-10-28, Three oversize caps), so the star shaped hub (51 cap-kind pieces) was turned out to 59 mm with it. A rebuild with the current code alone gives the donor's cap (the dome and its bezel ring, 31 mm), the star hub `Rim`. With the cap no longer over them the lug circle shows: the five nuts sit in the leg ends' pockets at r 44.6 mm and `lugs: 0` went (`(5, 0.215, {'seat': 0.0115})`, a scan, so the pockets keep the scan's ragged walls round the nut).
- **Hinoko**: the shipped lug circle was wrong, not only the cap. The donor has five nuts in counterbores (r 45.4 mm, 10 mm radius nuts) with five small holes on the same circle between them, and cap-kind pieces (71 + 22 + 20 + 40 ... faces, r 31 to 57 mm: the counterbore walls and the small holes) turned into the one cap profile out to 57 mm, which showed as red crescents behind the nuts. And `fit_lugs` read r 36 mm, a circle of those pieces. `cap_max: 0.125` (new recipe field) sends every cap-kind piece with a vertex beyond 25.9 mm back to `Rim`, so the cap is the donor's center disc (r 24 mm, plus its bezel to 25.6). With the pieces gone the depth image finds only the small holes (the five nuts' counterbores are not holes), so `lugs: (5, 0.219, {'at': -71.9, 'rad': 0.05})` places the nuts' own circle (same angles as before, r 45.4 mm instead of 36.2).
- **Tsume**: the depth image reads three circles of four: the pockets at r 41.4 mm (the crescents), the holes at r 49.2 mm on the diagonals (9 mm deep pockets with a through hole of 5 mm radius, the 100 mm PCD: the "hex collars between the spokes") and the holes on the spokes at r 57.0 mm (114.3). `lugs: (4, 0.237)` takes the middle one; no `seat` needed: the nut sits on the pocket's floor (x 31.6 mm), its 10 mm washer reaching the wall (r 11 mm).
- **Tatsumaki**: the donor is a bowl with a 29 mm logo disc and five 22 mm tall nuts standing in holes through the bowl's floor (r 50.3 mm). The shipped build turned the nuts' own pieces (cap-kind, 97 faces each) into the cap profile: a 61 mm disc laid over the nut holes. With the current `clean_cap` only the center piece (29.2 mm) is cap and the nuts go, which leaves their holes open; the lug circle is then r 50.3 mm, and the rays round a lug read the bowl's rim, not its floor, so `x: 0.0436` sets the seat on the floor.
- **Checked** on the shipped GLBs: `checkWheelFacing` front 0.98 to 1.00 on all five (depth 0.02 to 0.32, none wound wrong), rays down the catalog lug centers fall through the holes on tsume and tatsumaki, through or on the pocket's depths on fuuga, and hit the donor's nut tops at the seat on hinoko (the house nut stands on them).
- `cap_max` is a second way, beside the `cap_edge` the caps of hari, homura, minamo, natsu and shirabe use, to stop the cap at the donor's real center cap: `cap_max` returns the extra pieces to `Rim` before the profile is measured (hinoko's are pockets, there is nothing to turn), `cap_edge` keeps turning them and paints only inside the edge.

### Five inner caps (2026-10-28)

The user, after several tries: homura, hari, minamo, shirabe and natsu paint too much of their hub with the cap color; only the inner circle should be the cap, as on mikazuki. Each donor was re-imported at the same scale and its front profile measured (rays down the axle every millimetre, the median over 24 angles, with the island and source material each ray hits), then the rebuilt wheel was measured the same way and on the shipped GLB.

| Wheel | Donor's cap | RimCap before | after (shipped GLB) |
|---|---|---|---|
| hari (Work Emitz) | badge glass (31 mm) in a gold hex with its flange, 38.6 mm | 62.7 mm (0.303) | 38.6 mm (0.186) |
| homura (SSR Koenig) | KS plate (26.5 mm, 5 mm down) in a bezel of ten screws, ringed by a groove at 37 mm | 60.0 mm (0.289) | 37.1 mm (0.179) |
| minamo (MAE Crown Jewel) | silver logo disc and cone to an engraved line, 37.5 mm | 60.5 mm (0.292) | 37.5 mm (0.181) |
| natsu (Rotiform HVN) | black hex and its flange, 38.6 mm | 59.1 mm (0.285) | 38.6 mm (0.186) |
| shirabe (Konig Countergram) | black dome, 27.5 mm | 61.7 mm (0.298) | 27.6 mm (0.133) |
| mikazuki, for scale | | 33.5 mm (0.162) | unchanged |

- **Cause.** `_classify` calls any island inside 0.35 of the lip that starts inside 0.2 a cap, and on these five that takes in the hub round the cap: hari's grey bowl (`cap_001`, its own island, 38.7 to 64.7 mm) and natsu's red ring (35.8 to 60.9 mm, the face's own material), and on homura, minamo and shirabe the hub is the same island as the cap (homura's pad to 59 mm, minamo's flush pad in the body's material to 61 mm, shirabe's bare chrome hub to 61.7 mm). Three of the five have no island edge at the cap at all, so no island rule can find it: the edge is a material change on a flush surface (minamo), a groove (homura) or a step (shirabe, hari, natsu). Homura's `cap_disc: 0.29` (an earlier fix asking for the whole round hub in the cap's paint) took in still more; it went.
- **Fix.** The recipe's `cap_edge` gives the donor's own edge. `clean_cap` still turns everything the cap pick holds, so the hub keeps its clean turned shape and loses its logos; a ring of the profile is put on the edge and the lathe's faces past it are `Rim`. A piece of the pick that runs round the axle (natsu's ring, hari's bowl) is turned with the cap; before, the center-piece rule of Three oversize caps would have taken a raised one for a nut and deleted it, opening the hub.
- **Gaps.** The old builds showed the background through a crescent round the cap from 60 degrees: 170 to 480 pixels a view on natsu and hari, 690 to 880 on minamo (renders on magenta with backface culling, counted inside the hub's projected disc), none on mikazuki. Natsu's and hari's closed once their hub pieces were turned with the cap. Minamo's pad is a thin plate sitting with 1.4 mm clearance in the spokes' ring: the floor under the slot is seen only at steep angles, so the hidden face cull took it. With `cap_edge` the turned hub now ends in a 3 mm flange at its skirt's foot, tucked under the face: all five read 0 from four sides.
- **Unchanged.** The hub's shape (the rays down the shipped GLBs land at the same depths as before at every radius), shirabe's lugs (5 at r 45.9 mm, seat x 38.0 mm, on the hub that is now `Rim`), and no lugs on the other four (their donors' hubs cover the nuts). `checkWheelFacing` front 1.00 on all five. Triangles 7,090 to 11,461. `cap_edge` and the flange only act on a recipe that sets `cap_edge`, so no other wheel builds differently.

### Dark chrome lips (2026-10-28)

The user, after several fixes that did not hold: most of the Tanuki (Vossen) wheels showed a dark ring where the lip should be. In the garage with a chrome lip, madoka's and aoi's whole lip band was near black and read as part of the tire, so the wheel looked an inch smaller; with the stock lip (`rim` on 15 of the 17, so the face's satin silver) the same lip was bright.

- **Not the geometry or the pipeline** (each ruled out on the shipped GLBs, `npx tsx` over glTF Transform). The ring is `RimLip`: the Vossen GLBs carry only `Rim`, `RimLip`, `RimCap` and `Tire` (seiun and momiji add a few `Chrome` heads and bits), no `Black`. Every `RimLip` triangle's shading normals agree with its winding (dot over 0.5 on 100% of the area, none flipped), the same as kumo's and yari's, which look right. Lip shards (non-lip islands of 12 faces or fewer within 2.5 mm of the lathe, Valve stems and lip shards, above) are 0 on aoi, madoka, mizore, kagami, hikari, seiun, kirameki, hisui, karasu, rin, sumire, ukigumo and usagi, 2 to 10 faces on sora, getsuei and momiji, 73 on nagi: too few to make a ring, and the dark wheels have none.
- **The cause is the mirror.** A chrome finish is the `Chrome` look (metalness 1, roughness 0.12, `CHROME`), which shows only what the environment holds in the reflected direction, and both environments the cars carry are dark stand-ins: the showroom's (`studioEnvironment`) is a 0x0c0c0f room with a few batten strips and neon panels, the street's a night panorama. A lip turned to the viewer mirrors the room or road behind the camera, which is black. Rays down the axle over every wheel (the first surface each ray meets, and the shading normal's axial share where it is `RimLip`) show why Vossen and not the rest: their stepped lips are wide, flat cones facing the viewer. On madoka, mizore, aoi and sora the lip is 54 to 59% of the visible disc and 45 to 53% of the disc is lip with its normal within 25 degrees of the axle; the set's median is 17% (114 wheels), kumo 20% (a narrow lip that rolls from 0.77 to 0.04 axial, so its band sweeps past the battens and catches them), getsuei 33%. A flat ring mirrors one direction over its whole width, so it is all dark at once; a rolled lip is dark with bright streaks, which reads as chrome.
- **Why the earlier fixes did not hold.** The satin wheel finish (`WHEEL_FINISH`, commit 204a3b1) fixed the same black mirror for the metallic finish only, and left chrome "a mirror" on purpose, so it never reached a chrome lip (`applyPaint` returns before `WHEEL_FINISH` for chrome). The lip work before it (turning the lip, `RimLip` as its own material, the stock lip rule) changed the lip's shape and which paint it wears, never what a chrome surface reflects. Tuning the lip's roughness was tried live this time and is not enough: at 0.3 the lip still went dark across the top half (the map is dark nearly everywhere, so blurring it barely lifts the average), and metalness 0.85 with roughness 0.18 to 0.22 lights it by the key lights but greys it below the satin face beside it.
- **A floor did not hold either** (tried and removed the same day). The first fix kept the dark map and gave chrome a floor: the reflection `max`ed with a grey sky to ground gradient (0.4 sky, 0.25 ground). Every lip was bright, but the floor dominated wherever the map was dark, which is nearly everywhere, so chrome became flat grey satin with no edges in it. The user: "chrome looks like it got compromised ... we just need pure reflective shiny chrome". A mirror reads as chrome through contrast, sharp bright reflections next to dark ones, and a floor removes exactly that.
- **Fix: give chrome something to mirror** (runtime only, no GLB or catalog change). `chromeEnv.ts` builds one HDR studio panorama from numbers (512 x 256, half float): a dark floor (0.02 to 0.06), a bright horizon band (1.7) with a hard lower edge, a dim cool sky (0.24 to 0.07) and six softboxes and strips (3.5 to 6, brighter than white). A chrome wheel surface (`Rim`, `RimLip`, `RimCap`, lug nuts and hardware, both axles) reflects it instead of the car's environment: `applyPaint` swaps the material's `envMap` to the studio for the chrome finish and back to the car's (kept in a `WeakMap`) for any other finish, at `envMapIntensity` 0.45 (`CHROME.wheelEnv`, scaled with the room's lights like the paint's reflections). The surface itself is unchanged, the `Chrome` polish (metalness 1, roughness 0.12). A flat lip now mirrors the horizon band and the floor, bright with a dark band and a hard line between them; a rolled lip carries the horizon line round its curve and the softboxes as sharp highlights. Judged in the garage on madoka and aoi (chrome lip) and kumo (stock chrome), and in the Street view at night: polished chrome, neither grey nor black. Cost: nothing per frame. GPU memory: the 1 MB source plus a 384 x 512 half float PMREM that three makes once per renderer the first time a chrome surface draws (1.5 MB), about 2.5 MB in all, shared by every car. Switching a surface into or out of chrome compiles one more program variant once (the PMREM size is in the shader's defines).
- **Chrome has no colour** (the same request). Chrome is one look, `CHROME.color`: `applyPaint` ignores a chrome paint's colour, `validPaint` stores `CHROME_COLOR` for any chrome finish, so old saves and share codes with a gold, black, red or blue chrome (and the legacy lug nut names) read plain chrome, the garage's paint picker hides the colour picker while chrome is chosen, and the random build's black lug nuts are gloss black.

### Fictional makers remapped (2026-10-30)

The fictional maker names were reassigned so that sorting them alphabetically gives the same order as sorting the real makers. The garage lists makers alphabetically, so the list now runs in the same order whichever names you read. Real maker to fictional name:

| Real maker | Fictional name |
|---|---|
| Advan | Baku |
| Avant Garde | Byakko |
| BBS | Fujin |
| Brabus | Genbu |
| Brixton Forged | Hiryu |
| Budnik | Hotaru |
| Devil Japan | Kaito |
| Enkei | Kamaitachi |
| Fifteen52 | Kappa |
| HRE | Kitsune |
| Kansei | Kodama |
| Konig | Kohaku |
| Kyusha Shoes | Mizuchi |
| MAE | Nekomata |
| Rays (and Volk, a Rays brand) | Nue |
| Rotiform | Oni |
| Spoon | Orochi |
| SSR | Seiryu |
| Velare | Shuten |
| VIP Modular | Suzaku |
| Vossen (and Vossen-x-Work) | Tanuki |
| Weds | Tengu |
| Work | Yamabiko |

## Credits

All by **jonver87** on Sketchfab, CC BY 4.0: WORK VS-TX, Work Equip 03, Work Equip 40, WORK EMITZ, WORK VS-KF, Work VS XV, WORK VS-XX, WORK ZISTANCE W5S, WORK Schwert SC2, Work Equip 02, Work Euroline DH, WORK IMPORT LABEL AL4, WORK LS CHIAREZZA SUV, Rotiform ZMO, Aerodisc, VCE, SIX, AVS, KB1, USF, MLW, OZR, BM1, WRO, CCV, LHR, LSR, KLU, SNA, KPS and PNT, 3D Vossen LC104T, Vossen LC109T, VPS302, VPS301, ERA3, GNS-1, VPS 315T and CG203, HRE P200, Fifteen52 Rally Sport, SSR Koenig, BBS E52, Volk Rays 21C. Each is kept as its face, lip and barrel, reduced, with its bolts, badges and tire replaced by the house's.

Enkei Nt03+m Wheels by **flathat3d** and BBS CH-R + Goodyear Eagle F1 Supercar 3 by **MozzarellaARC** on Sketchfab, CC BY 4.0, each kept the same way (the CH-R's own tire cut away).

The Fifty-six more set (2026-10-28), CC BY 4.0, kept the same way: 33 more by **jonver87** (HRE TUSK, Advan A3A, Velare VLR F1, Rotiform WRG, IHR, HVN, SEA, RSC and EMA, Kyusha Shoes Meteor FF, Brixton Forged TR06, VL7, PF6 and CM16, Avant Garde F450 and F142, HRE FF04 and 522M, Vossen VFS4, LC106, LC108T, VPS 310T, CG207, VFS2, VFS1 and HC-1, Vossen-x-Work VWS3, VIP Modular VXS410, VX510 and VXS610, Volk TE37SL 3spoke, Volk Rays 21A, Enkei Riverge), "fifteen52 Turbomac" by **portfoliorodrigues**, "Work Meister S1 3P" by **alexanderlyreo** and 18 wheels from 16 models by **dermaks** (WORK MEISTER CR01, SSR Minerva, RAYS nismo LMGT1, SSR COLLECTION (three wheels), SSR Longchamp XR4, Budnik Tusk, Weds Kranze Bazreia, BRABUS MONOBLOCK M, Devil Japan IF, WORK Equip 05, KANSEI TANDEM, O.Z MAE, WORK EMOTION T5R 2P, RAYS TE037, SSR Starshark, MAE CROWN JEWEL). The settings' credits list each one (`DONOR_CREDITS`).

Twelve more (2026-10-28), CC BY 4.0, kept the same way: "Spoon SW388 (Low&High Poly)" by **TinoD2**, "Racing Wheel - Work Emotion CR-KAI" by **gordeykomark**, "Rotiform DAB" and "WEDS Kranze LXZ [Mid-Poly]" by **blakebella**, "[FREE] BBS LM Gold Wheels - Low poly" by **zxargon**, "S13 Teardrops Rims" by **Once_a_goat_death**, "SSR Hasemi Prot-S" by **techtackofficial**, "Rotiform CVT" by **niev**, and "RAYS GramLights 57DR", "Rays Gramlights 57CR", "RAYS G025" and "RAYS HOMURA 2x7" by **ilvskf** (their barrels apparently from jonver87's WORK VS-XX); their tires, stands, stickers and valves left out.

Two more (2026-10-28), CC BY 4.0, kept the same way: "Konig Countergram 5x120 Wheel / FREE MODEL" by **shevchenkovisuals** and "Enkie Rpf1" by **astrubal** (their tires, lettering, calipers and rotor left out).
