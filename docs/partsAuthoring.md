# Authoring car parts

This guide covers making a new aftermarket part in Blender (a bumper, skirts, a spoiler, a hood, wheels) and getting it into the game. A new part needs one GLB file and one catalog entry. You don't need to change any code.

## 1. Slots

Every visible piece of a car lives in a slot. The slot list is `PART_SLOTS` in `src/shared/parts.ts`:

| Slot | What it is | Notes |
|---|---|---|
| `body` | The whole shell (a full body swap) | Base car GLB node `Body`. Reserved for whole-body variants; bumpers and skirts are their own slots. |
| `frontBumper` | Front bumper, splitter, lip | Base car node `Bumper_Front` |
| `rearBumper` | Rear bumper, diffuser | Base car node `Bumper_Rear` |
| `fenders` | Both front fenders (wings) in one file | Base car node `Fenders` on authored cars |
| `sideSkirts` | Both side skirts in one file | Base car node `Skirts` on authored cars |
| `spoiler` | Wing or ducktail | Garage offers "None" |
| `hood` | Bonnet | Base car node `Hood` on authored cars |
| `roof` | Roof panel | Base car node `Roof` on authored cars |
| `wheels` | One wheel on its tire | Universal: fits every car |

To add a new slot (canards, diffuser, mirrors, roof scoop), add it to `PART_SLOTS`, `SLOT_LABELS` and `TRI_BUDGETS` in `src/shared/parts.ts`. To show it in the garage body menu, also add it to `BODY_PART_SLOTS`.

## 2. Coordinate convention (car space)

Author every car and every car part in the same space:

- Meters. 1 Blender unit = 1 m.
- **Y up, car facing +Z** in glTF terms. In Blender (Z up), the car faces **−Y**. The glTF exporter's "+Y Up" option converts this for you.
- Origin on the **ground**, at the **center between the axles**. The car's left side is +X in Blender and in glTF.
- Parts use an **identity transform**. Model the bumper exactly where it sits on the car. Don't offset it to the origin.

The easiest workflow for an authored car: open `assets/source/eshell/<carId>/<carId>.blend`, model the part on top of the car, put it in the `Parts` collection named `<slot>_<partId>` (with a `displayName` custom property) and run `npm run assets`: it exports, compresses and catalogs it for you (see README, Car assets). For any other car, import `public/cars/<carId>.glb`, model the part on top of it, then export only the part and catalog it by hand (below).

**Wheels are the exception.** They use wheel space:

- The wheel center is at the origin.
- The axle runs along X, with the outer face toward +X.
- Real size in meters. The game scales every wheel to the car's wheel radius and mirrors it for the right side, so any wheel fits any car. Authored cars all use the standard wheel (`standardWheel` in `scripts/assetConfig.json`: 0.28 m radius, 0.24 m wide); author wheels at that size.

## 3. Material names

Parts must use the shared material names. The game swaps each one for a runtime material, so a new bumper automatically takes the player's paint and finish:

| Name | Used for | Driven by |
|---|---|---|
| `Paint` | Body color panels | Paint color and finish (gloss, metallic, matte, pearl, candy) |
| `Trim` | Secondary panels, carbon look | Fixed gloss near black (no build paint; no shipped part uses it yet) |
| `Black` | Grilles, vents, undertray | fixed |
| `Chrome` | Exhaust tips, badges | fixed |
| `Glass` | Windows | Window tint |
| `Rim` | The wheel (everything but the tire) | Wheel color (front and rear can differ) |
| `Tire` | Tire rubber | fixed |
| `HeadLight` | The main headlamps (the lens, or the reflector behind a clear `Lens`) | fixed cool white glow |
| `TailLight` | The main tail lamps | fixed red glow, brighter when braking |
| `BrakeLight` | The third brake light | dark red lens, glows only when braking |
| `Light` | Indicators, side markers | amber lens, unlit |
| `Reflector` | Red reflectors and markers | red lens, unlit |
| `ClearLens` | White side markers and repeaters | white lens, unlit |
| `Strap` | Woven webbing (tow straps) | matte red, never painted |
| `Lens` | Clear lamp covers, reverse and fog lamps | clear, see-through, unlit |
| `Interior` | Seats, dash | fixed |

Only `HeadLight`, `TailLight` and `BrakeLight` glow: a lamp that is not one of the big headlamps or tail lamps takes an unlit lens. Name the Blender material exactly that (e.g. `Paint`). Suffixes like `Paint.001` are fine. Colors you set in Blender are ignored at runtime. They only matter for your own preview.

## 4. Triangle budgets

`npm run validate` enforces these (from `TRI_BUDGETS`):

| Slot | Budget |
|---|---|
| frontBumper | 7500 |
| rearBumper | 6500 |
| fenders | 4000 |
| sideSkirts, hood, roof | 2000 |
| spoiler | 4500 |
| wheels | 12000 |
| body | 20000 |

Keep it low poly. Flat shading with a few hundred triangles looks right next to the garage cars. Wheels are the exception: the garage shows them full screen, so a wheel keeps its donor's face at about 6,000 triangles with a turned lip, house bolts and the house tire (`docs/carWheels.md`), 9,000 to 11,500 in all.

## 5. File naming

```
<carId>_<slot>_<partId>.glb      e.g.  wendtStrom_frontBumper_tsurugi.glb
wheel_<name>.glb                  e.g.  wheel_mesh_classic.glb
```

Car ids are in `src/assets/carManifest.json`: `wendtStrom`, `kazamaRotor`, `albrechtKombi`, `daltonFiend`. Put the file in `public/parts/`.

## 6. Blender export settings (File > Export > glTF 2.0)

- Format: **glTF Binary (.glb)**
- Include: **Selected Objects** (select only the part)
- Transform: **+Y Up** checked
- Data > Mesh: **Apply Modifiers** checked, UVs and Normals on, Vertex Colors off
- Data > Material: **Export**
- Compression: off. The game loads plain GLB fine. `npm run assets` only compresses files it generates itself.
- Before exporting, **apply all transforms** (Ctrl+A > All Transforms) so the object sits at its location with an identity transform.

## 7. Add a catalog entry

Add an object to `parts` in `src/assets/partsCatalog.json`:

```json
{
  "id": "wendtStrom_frontBumper_tsurugi",
  "displayName": "Tsurugi",
  "carId": "wendtStrom",
  "slot": "frontBumper",
  "file": "parts/wendtStrom_frontBumper_tsurugi.glb",
  "hides": ["Bumper_Front"],
  "materialSlots": ["Paint", "Black"],
  "tris": 1840
}
```

- `id`: unique, letters, digits, `_ - .` only.
- `displayName`: a fictional tuner name (Kurogane, Hayate, Tsubasa), not a grade or a number; the garage lists styles, not a ranking.
- `carId`: the car it fits, or `"universal"` for wheels.
- `hides`: names of base car nodes to hide while this part is equipped (the stock bumper it replaces). Use `npm run inspect` to list node names. Any base node works, not only the slot's stock piece: the Wendt Strom's Center Exhaust hides `Bumper_Rear` and `Exhaust` (its pipes, split off the body for this).
- `exhaustTips` (optional): where the car's exhaust flames, pops and heat haze start while the part is on (glTF car space, m, like the manifest's `exhaustTips`, as many tips as the car has), for a part that brings its own pipes. Authored as a JSON custom property on the part object; `CarView.placeTips` applies it.
- `node` (optional): use when several parts live in one GLB. The part is that node inside `file`.
- `tris`: informational; validation warns if it drifts from the file.

Leave out `"generated": true`. Only entries generated by `npm run assets` carry that flag, and the script rewrites those on every run. Hand-written entries are kept.

Then run:

```
npm run validate
```

It checks that the file exists, the slot and car are known, every material name is in the vocabulary, the triangle budget, and that the bounding box fits the car (to catch wrong scale or a forgotten transform). It fails loudly on any error. `npm run assets` runs the same validation at the end.

## 8. Test a part without touching the catalog (dev preview)

1. `npm run dev`, then open the garage (or go to `http://localhost:5175/?garage&dev`).
2. Press **Ctrl+Shift+D** to enter dev mode. The panel border turns amber.
3. **Drag and drop** your `.glb` onto the window.
4. Pick the slot (guessed from the file name if it follows the naming convention) and tick the base meshes it should hide.
5. Click **Equip**. The part is applied live with the player's paint, so you can check fit, materials and scale straight out of Blender.

Dev parts aren't saved to the catalog. Add the catalog entry once you're happy.

## 9. Designing a kit

Sizes that read at game distance, where each piece sits, the tuner families and the rule that every piece is sized from a reference product and anchored to the car's own edges: `docs/carDesign.md` section 4. Product pages and extracted dimensions go in `assets/refs/parts/<kit>/notes.md` (template in `_template/`).

## 10. Splitting a merged body kit

FBX imports (IceMaan) ship each body kit as one merged mesh, so they're registered as `body` variants until split. The Proto Compact and Wendt Strom (then the Proto Hatch) were split this way in Blender (the `/blender` project skill has the scripts and the gotchas):

1. Bisect the body with axis planes so the seams are clean edges: the front bumper is everything ahead of the front arch line and below the headlights, the rear bumper everything behind the rear arch line and below the taillights, the skirts the sill strip between the arches outside the floor.
2. Separate the faces on each side into `Bumper_Front`, `Bumper_Rear` and `Skirts`; the rest stays `Body`.
3. Build aftermarket parts from the stock pieces rather than from other kits: donor pieces cut from other kits never quite match the body (we tried; they looked wrong). Copy the stock piece, reshape it with displacements weighted to zero at the seam, recolor panels, and append new geometry (splitters, canards, strakes, blades). `scripts/blender/carKit.py` has the helpers (`copy_part`, `displace`, `recolor`, `outline`, `slab`, `fin`).
4. Put the base pieces in the `Car` collection and the donor pieces in `Parts`, then run `npm run assets`.
