# Car design: references, proportions and the shared features

How a Street Scene car is designed from real reference vehicles, and the rules that keep every car's pillars, glass, mirrors, handles, cowl and lamps consistent. The process is the `/car` skill; the mechanics of Blender are `/blender`; this file is the *what* and the *numbers*.

Data flows one way:

```
reference vehicles + photos  ->  scripts/blender/carSpecs.json  (donors, blend, house style, signatures)
                                  |
          npm run audit  <--  public/cars/<id>.glb        measure the shipped car against the spec
          spec_check()   <--  the .blend in Blender        the same table, live
                                  |
          carFeatures.py  builds the shared features from house numbers + the car's own stations
                                  |
          exportCar.py -> npm run assets -> npm run audit again
```

Nothing in the spec is a game dimension. Every target is `blend(donor value / donor wheelbase) x manifest wheelbase x house multiplier`, so proportions come from the real cars and the stylization lives in one place (`house.scale`).

## 1. Scale and proportions

- **One wheel.** Every car rides on `standardWheel` (0.28 m radius). Real tires on the donors are 0.31 to 0.33 m, so at a car's wheelbase the donors would have a 0.30 to 0.32 m wheel: the cars read 7 to 13 % bigger than their wheels. That is the house look (tuner stance), not an error; the audit prints it so nobody "fixes" it by accident.
- **House style** (`house.scale`, measured off the Wendt Fairway as shipped): width x1.06 (flares), height x0.92 (chopped roof), belt line x0.92, length and overhangs x1.0. Change these once, then re-audit every car.
- **Blend.** Each car has two donors with weights (0.5 / 0.5 unless a car leans one way). Dimensions blend as ratios to wheelbase; angles blend directly. `take` lists what each donor contributes beyond numbers.
- **Estimates.** Overhangs, belt lines, tracks on some donors and glass rakes are read off side profiles (`estimates` in the spec). A calibrated side photo in `assets/refs/<carId>/refs.json` replaces them (`spec_from_refs` in `carRefs.py` prints the numbers to paste in). Do not move a car's nose by 10 cm on an estimate; calibrate first.
- **Tolerance.** 5 % on dimensions, 4 degrees on rakes (`house.tolerance`). The audit marks the rest **off** and lists it at the end; the goal of a session is a shorter list, not a zero (the kitbashed bodies will never match to the centimeter and need not).

Stations the audit measures and the builders use (car space, meters, Y up, +Z forward, +X left):

| Station | Found by |
|---|---|
| belt line, window top | min / max y of side `Glass` faces (normal mostly sideways) |
| cabin front / rear | max / min z of the side glass: the A pillar foot and the C or D pillar |
| windshield, rear glass rake | `Glass` faces that face up more than sideways, split by position at the cabin middle (a fastback lies at 20 degrees) |
| nose / deck height | top of the body in the front / rear 0.3 m |
| lamps | `HeadLight` / `TailLight` face bounds: inner and outer |x|, y band, z band |
| B pillar | `Black` faces in the side glass band; a width over 0.2 m is window frames, not a pillar |
| mirrors, handles | loose islands by size and place (outboard at the belt near the cabin front; small bars just under the belt) |
| cowl | `Black` faces facing up just ahead of the windshield base |
| arch gap | ray up from the wheel center to the arch; 0.01 to 0.04 m |

## 2. The shared features

Every number lives in `house.features` (carSpecs.json) and every builder in `scripts/blender/carFeatures.py` reads it, so one edit changes every car. Builders pin to the car's own stations (belt line, cabin front, B pillar, nose, seam), never to typed coordinates. They are idempotent: each strips what it built before, found by material and place.

**Pillars and glass.** The greenhouse is one `Glass` band per side from the belt line to the roof edge, plus the windshield and the rear glass. Pillars are *materials on that band*, not geometry: A pillars `Paint` (they are the windshield's edge), **B pillar `Black`** (0.11 m wide, at 47 % of the cabin length from the front), C and D pillars `Paint`. No black window frames: any other `Black` in the band becomes `Glass` (the Proto Compact ships with 0.99 m of frames; the builder removes them). Hatches carry a small quarter glass behind the C pillar; coupes and the compact end the band at the C pillar. Windshield rakes sit at 29 to 31 degrees from horizontal, rear glass at 32 (fastback coupe) to 48 (hatch) per the donors.

**Mirrors.** One each side at the A pillar foot: a `Paint` housing 0.14 x 0.08 x 0.07 m (x, y, z) on a 0.035 m stalk, its bottom 0.03 m above the belt line, centered 0.06 m behind the cabin front, with a `Black` 6 mm pane on the rear face. Identical on every car; only the station moves.

**Door handles.** `Black` bars 0.12 m long, 0.025 m tall, 0.012 m proud of the door, 0.07 m below the belt line. Front handle 0.04 m ahead of the B pillar; on four door cars the rear handle sits 0.45 m ahead of the rear axle (just before the arch). Two per side on a hatch, one on the others. A handle is how a low poly car says "door": there are no door seams.

**Cowl and wipers.** A `Black` strip 0.07 m long across the base of the windshield between the A pillar feet, laid 4 mm over the surface (the hood's trailing edge is the cowl's front edge), plus two `Black` wiper fins (0.50 and 0.42 m, 0.025 wide) lying on it at 18 degrees, driver side longer.

**Interior.** An `Interior` block from just behind the windshield base to the rear glass, 0.12 m in from each side, from 0.25 m below the belt to 0.02 m below it, plus two seat backs at the B pillar rising 0.18 m above the belt. Glass is 70 % opaque at runtime: without this block a cabin reads hollow (the Hatch and Compact ship without one).

**Headlights and taillights.** Built one way everywhere, so the cars share a language and differ in *signature*:

- Zone: between the bumper seam (`Bumper_Front` / `Bumper_Rear` top, +0.02) and the hood or deck edge (-0.025), anchored at the top, height clamped to 0.10 to 0.15 m. Front lamps span 32 to 95 % of the half width, rear lamps 20 to 96 %. Lamps live *above the seam* so every bumper kit keeps them.
- Layers, by offset from the surface: `Black` housing 4 mm; lens (`HeadLight` / `TailLight`) 12 mm, inset 6 mm inside the housing; `Light` indicator 14 mm; elements 16 mm. Less and the housing shows through on sloped panels.
- Signature = `cover` + `elements` + `indicator` (+ `wrap`, `centerBar` at the rear), from the spec:

| cover | shape (u inner to outer, v bottom to top) | donor |
|---|---|---|
| `teardrop` | narrow inner point, round outer end sweeping up the fender | WRX, RSX |
| `slab` | rectangle with a raked outer end | Golf R |
| `flatCover` | rounded rectangle, long | E36, RSX cover |
| `slimWedge` | taller inboard, narrowing outboard | E46 |
| `verticalUnit` | tall unit on the quarter corner | WRX hatch |
| `lUnit` | horizontal bar plus a leg down the corner | E36 / E46 |
| `panel` | wide low dark panel | Supra |

  Elements: `twinRound` (two round lamps, radius 32 % of the height, at 30 % and 72 % of the width), `bar`, `innerBlock` (`Light` block on the inner third, RSX clear lens), `none`. Indicators: `bottomStrip` (bottom 20 %, Golf R LED line), `outerBlock` (outer 20 %), `none`. `wrap` continues a rear unit 0.12 m onto the quarter panel (projected along x); `centerBar` joins the rear units with a thin bar across the tailgate.
- Every car gets an amber `Light` indicator (none ships with one today) and `Chrome` exhaust tips, twin, one per side on stock.

**Arches and underbody.** Arch cut radius = wheel + 0.035 m, the wheel well `Black`, the floor `Black`, arch gap 0.01 to 0.04 m (negative: never shrink the wheel; raise the body or open the arch).

**Grilles.** Stock is tame: small `Black` patches at 5 mm (kidneys 0.10 wide on the BMW blends, a slim slot on the others, a low intake slot). Character goes into bumper parts.

## 3. The cars

| Car | Donors | Composition | Front | Rear |
|---|---|---|---|---|
| Wendt Fairway | 2002 VW Golf R32 Mk4 (one donor, kept whole) | the donor's body at true size: three doors, pillars A B C, flat roof to a steep tailgate | the Golf's oval covers, kept | the Golf's corner units, kept |
| Kazama Rotor | 1999 Mazda RX-7 FD (one donor, kept whole) | the donor's body at true size: two doors, bubble cabin, glass hatch, wing | slim bumper lamps, pop-ups modelled raised | full width tail bar |
| Brandt Kombi | 1992 Audi S2 Avant (one donor, kept whole) | the donor's body at true size: four doors, pillars A B C D, roof rails | square headlights, kept | full width tail bar |

Full briefs, dimensions with sources and `take` lists: `scripts/blender/carSpecs.json`; `npm run audit -- <carId>` prints them with the numbers.

Baseline, 2026-10-20 (`npm run audit`): every car lacks `Light` indicators; the Hatch and Compact lack an interior block; all three noses are 10 to 23 % short of the (estimated) donor overhangs; the Compact has window frames instead of a B pillar and no handles, and sits 6 % narrow of the house width; the Coupe's headlights are 0.077 m tall (band 0.10 to 0.15), its rear glass lies at 20 degrees against the donors' 32, and it has no cowl; the Hatch's taillights are 0.184 m tall and it has two handles for four doors.

## 4. Aftermarket kits: reference tuning design, no random boxes

Parts are the character; stock is tame. A kit is a *style family* with a real world archetype, and every piece of it is sized from a reference product and anchored to the car's own geometry.

**Families** (fictional tuner names; check a new one is not a real brand):

| Tuner | Archetype | Language |
|---|---|---|
| Kurogane | time attack carbon aero | `Trim` (carbon) lower aprons, deep flat splitter with end plates, two canards per corner, strake diffuser, skirt blades with winglets, louvred carbon hood, roof vortex generators, GT wing on stands |
| Hayate | OEM+ / rally | `Paint` aprons drawn down and forward, slim `Black` lips, an intake bar, cowl bulge or scoop hood, rally roof scoop, roof edge extension on hatches, ducktail on coupes |
| Tsubame | heritage | twin contrast stripes, chin spoiler, flat trunk spoiler; a retro kit when it grows |

**Sizes that read at game distance** (real mm x 0.87; below the minimum a piece vanishes at race distance):

| Piece | Size (m) | Where it sits |
|---|---|---|
| front lip | 0.02 to 0.035 proud, 0.06 to 0.10 deep | along the bumper's lowest outer edge |
| splitter | 0.07 to 0.13 forward, 0.012 to 0.016 thick; end plates 0.2 x 0.07 | under the bumper's *outer face*, tucked 0.06 in (the lowest vertex sits further in; a plate there floats) |
| canards | chord 0.10 to 0.13, span 0.12, 0.012 thick, 8 to 15 degrees up; two per corner 0.09 apart | on the bumper corner between the lamp line and the lip |
| side skirt | 0.02 to 0.06 outward; blade 0.01 to 0.014 thick; rear winglet 0.06 | along the sill between the arches, pinned to the seam |
| diffuser | 6 to 8 strakes 0.10 to 0.12 tall, 0.3 long; plate 0.08 beyond the bumper | under the rear bumper, 0.06 clear of the `Chrome` tips |
| GT wing | span 0.9 x body width, chord 0.22 to 0.28, 0.02 to 0.03 thick, 0.2 to 0.3 above the deck, 5 to 8 degrees | `mount_on_body` on the trunk lid (roof edge on hatches) |
| ducktail | chord 0.12 to 0.16 rising 0.05 to 0.08, full lid width | trunk lid trailing edge |
| roof spoiler (hatch) | extends the roof 0.15 to 0.22, 0.02 thick, end fins 0.05 | roof trailing edge |
| hood vents, louvres | 5 louvres 0.2 x 0.022; scoop 0.3 wide x 0.075 tall | on the surface (`surface_z`) |
| fender flares | 0.03 to 0.06 push over the arches fading over 0.25 | one displacement field over every mesh so seams stay closed |

**Rules**

1. Every piece starts from a silhouette or surface sample of the car: `outline` (bumper edge), `surface_z` (hood, roof), `boundary_seam` (panels), `projected_quad` (patches), `copy_part` + `displace` (reshaped stock). Never a typed coordinate.
2. Its size comes from a reference product measured in mm (`assets/refs/parts/<kit>/notes.md`: URL, photo, the numbers), scaled x0.87 and clamped to the table above. Write the number and its source in the notes.
3. It sits where the product sits (table above), and stays clear of lamps (above the seam), exhaust tips and the glass (`mount_on_body` lifts a wing over it).
4. Material by rule: carbon `Trim`, body colour `Paint`, undertrays and lips `Black`, tips `Chrome`. Never a new material name.
5. Build from the stock piece of *that* car (`tunerKits.py` styles), never from another kit or car: donors never fit.
6. Name by tuner, no grades or numbers; a kit's three pieces (front, rear, skirts) share one language and one name.

## 5. References: `assets/refs/`

```
assets/refs/<carId>/refs.json       which photo is which view of which donor, with calibration
assets/refs/<carId>/*.jpg|png       the photos (side, front, rear, top, three quarter, details)
assets/refs/parts/<kit>/notes.md    product pages and extracted dimensions for a kit
assets/refs/parts/<kit>/*.jpg       product photos
```

- **Look at them.** Photos are read directly (the Read tool shows images): one pass per feature, writing down what you see (lamp shape, where the belt line sits on the wheel, pillar widths, mirror shape). That is the context the model needs before touching a vertex.
- **Calibrate.** `wheels_px` (two wheel centers in pixels) scales a photo to the car; `extent_px`, `roof_px`, `ground_px`, `belt_px` on a side photo turn it into real overhangs, height and belt line (`spec_from_refs`). Pixel coordinates come from Preview (hover) or an estimate from the image; +-10 px is fine.
- **In Blender.** `load_refs(carId)` places each calibrated photo as a textured plane behind the car in its view (side plane beyond the right side, front plane beyond the tail, rear plane beyond the nose, top plane under the floor) with the wheel centers on the Rig wheels. `ortho_sheet(carId, dir)` renders side / front / rear / top with the car (temporary wheels) in front of the planes, optionally X-ray, to PNGs you then Read. `spec_check(carId)` prints the audit table live. Numbers first, pictures to confirm.
- Product pages for kits go into `notes.md` as URL + what to take + measured dimensions; photos beside it.

## 6. Process (short form; `/car` is the checklist)

1. `npm run audit -- <carId>`: read the off-spec list and the stations.
2. Read the photos in `assets/refs/<carId>/`; update the spec (donors, weights, `take`, signatures) when the brief changes; calibrate a side photo.
3. In Blender: append the car, `load_refs`, `ortho_sheet`, `spec_check`.
4. Shape first (proportions, overhangs, glass rakes: loft profiles on the Coupe, displacement fields on the others), re-check after each change.
5. `apply_features(carId)`: pillars, mirrors, handles, cowl, interior, lamps by signature. Re-measure.
6. Kits from product notes with the sizes above.
7. Save, `npm run assets`, `npm run validate`, `npm run audit`: the commit body carries the before / after off-spec lists. A changed manifest changes the sim: say that replays, ghosts and bests for the car are invalid.
