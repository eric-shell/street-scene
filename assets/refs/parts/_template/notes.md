# <Kit name> (<tuner family: Kurogane | Hayate | Tsubame | new>)

One paragraph: the look in a sentence, which real world archetype it follows (time attack carbon, OEM+, rally, heritage) and which cars it is for.

## Products

| Piece | Product and URL | Photo | What to take |
|---|---|---|---|
| front bumper | <product page> | front_a.jpg | deep chin, two canards per corner, mesh implied by Black |
| rear bumper | | | |
| side skirts | | | |
| hood / roof / spoiler | | | |

## Dimensions (real mm -> game m = mm x 0.00087, clamped to docs/carDesign.md section 4)

| Piece | Real (mm) | Source (page, photo, scaled off the wheel) | Game (m) |
|---|---|---|---|
| lip, proud / deep | 30 / 90 | product page | 0.026 / 0.078 |
| splitter forward | 110 | measured off the photo against a 650 mm tire | 0.096 |
| canard chord / span | 130 / 140 | | 0.113 / 0.12 |
| skirt out / blade | | | |
| diffuser strakes, count / height | | | |
| wing span / chord / height | | | |

## Materials

carbon -> Trim, body colour -> Paint, undertray and lips -> Black, tips -> Chrome.

## Build notes

Which stock piece each part copies, the seam (`SEAMS` in tunerKits.py), displacement fields and where each new piece is anchored (`outline`, `surface_z`, `boundary_seam`).
