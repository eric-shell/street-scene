# Reference photos and product pages

What a modelling session looks at before it touches a vertex (`docs/carDesign.md` section 5, the `/car` skill). Nothing here ships; the folder is read by people, by Claude (the Read tool shows images) and by `scripts/blender/carRefs.py`.

```
assets/refs/<carId>/refs.json       which photo is which view of which donor, with calibration
assets/refs/<carId>/*.jpg|png       the photos
assets/refs/parts/<kit>/notes.md    product pages and extracted dimensions for an aftermarket kit
assets/refs/parts/<kit>/*.jpg       product photos
```

## Photos worth collecting per car

For each donor (`donors` in `scripts/blender/carSpecs.json`), in this order of value:

1. **Side profile**, straight on, whole car, wheels level: the one photo that calibrates everything (overhangs, height, belt line, glass rakes).
2. **Front** and **rear**, straight on, at bumper height: lamp shapes, grille, track.
3. **Three quarter** front and rear: how the lamps wrap, shoulder lines, flares.
4. **Details**: a headlight, a taillight, the mirror, a door handle, the cowl, the B pillar. Crops are fine.
5. **Top** (brochure plan views, if any): plan shape and taper.

Name files by donor and view: `wrx_side.jpg`, `golfr_front.jpg`, `wrx_q34_rear.jpg`, `golfr_detail_headlight.jpg`.

## refs.json

```json
{
  "car": "wendtFairway",
  "images": [
    { "file": "wrx_side.jpg", "donor": 0, "view": "side", "nose": "left",
      "wheels_px": [[412, 610], [1310, 612]], "extent_px": [60, 1680], "roof_px": 95, "ground_px": 780, "belt_px": 430,
      "notes": "press photo, lens about 85 mm" },
    { "file": "golfr_front.jpg", "donor": 1, "view": "front", "wheels_px": [[300, 700], [1100, 700]] },
    { "file": "wrx_q34.jpg", "donor": 0, "view": "q34", "notes": "look only" }
  ]
}
```

- `view`: `side`, `front`, `rear`, `top` (placed in Blender), or `q34` / `detail` (looked at only).
- `donor`: index into the car's `donors` in carSpecs.json (0 is the first).
- `nose`: `left` or `right`, which way the car points in a side photo (default left).
- `wheels_px`: two pixel points `[x, y]` from the image's top left corner. Side: front wheel center, rear wheel center. Front and rear: the wheel centers as they appear, viewer's left then right. Top: front axle center, rear axle center. With these the photo is scaled so its wheels land on the car's; without them it is fitted to the car's length and the loader says so.
- `extent_px`: `[nose end x, tail end x]` on a side photo; `roof_px`, `ground_px`, `belt_px`: y pixels of the roof top, the ground contact and the window sill. `spec_from_refs(carId)` turns them into real mm for the donor's `mm` block (overhangs, length, height, beltLine), replacing the estimates.
- `enabled: false` leaves a photo out without deleting its entry.

Pixel coordinates: open the photo in Preview and hover (the status bar shows x, y), or ask Claude to estimate from the image. Within about 10 px is fine.

## Product pages for kits

`assets/refs/parts/<kit>/notes.md` (copy `_template/notes.md`): the URL and photos of each product the kit draws from, what to take, and the dimensions you can read or measure (mm), scaled x0.87 into game meters and clamped to the table in `docs/carDesign.md` section 4. A kit built without a notes file is a kit of guessed boxes.
