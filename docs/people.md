# People

Every person in the game is the same character: the garage crew, the race crowds and every driver. One look, one mesh, one shader rig and one wardrobe (`render/people/looks.ts`), so they read as the same world and stay cheap enough to draw by the hundred.

## The look

Stylized and faceless. Rounded low-poly shapes with strong silhouettes: an egg of a head with no features, a lathed torso that tapers to the waist, capsule limbs, mitten hands, rounded shoes. Clothes are flat colors, no textures. Character comes from silhouette and color: work shirts and trousers in the garage, hoodies, jackets and sneakers in the crowds. At night most people are seen as shapes under street light, which is where this style holds and realism falls apart first.

Per person options (`WEAR` bits): cap with brim, beanie, swept hair, hood, hi-vis chest stripe, gloves, and in the right hand a phone, a flag or a glowstick. Seven colors per person: skin, shirt, sleeves (a second shirt color: the hood, a jacket's sleeves), trousers, shoes, hair, cap. The crew's mugs, cans, wrenches and boxes are separate instanced meshes placed from `personFrame()`.

Shading, all free of per frame cost: occlusion baked into the vertices where the body folds (armpits, crotch, under the chin, under the brim), a roughness per part (matte cloth, glossier shoes and plastics, the stripe's reflective tape) and a faint cool rim in the fragment so figures separate from the night. Colors are picked from the wardrobe's lists so every context (shop, street, team) is a subset of one palette.

## Cost

| | |
|---|---|
| `personGeometry('hero')`, beside the cars | about 4.2k triangles (every option is in the mesh; hidden ones collapse to a point) |
| `personGeometry('mid')`, a few at middle distance | about 1.5k: the same shapes at half the segments, no collar, belt or soles |
| `personGeometry('crowd')`, the stands within 45 m | 816: plain tapered limbs, small hands and feet |
| `personGeometry('far')`, the stands beyond | 204: nine boxes on the same bones, the flag kept |
| A race at Medium (seed `people`, the grid) | 256 near and 944 far spectators, about 400k triangles of the frame's 4.0M; the box crowd before was about 140k |
| Draw calls | 1 per level of detail per stand (crowds) or per group (People), +1 blob shadows, +1 per held-thing shape |

The rig costs about ten 4x4 multiplies per vertex, so the crowd's budget is vertices, not draw calls: `LOD_NEAR` in `race/crowds.ts` (45 m) and `CROWD_QUALITY` density are the knobs. Measure with `?fps` at Medium on a seeded race when they move.
| Per frame (CPU) | 16 floats per moving person, plus the instance matrix |
| Vertex attributes | 13 of WebGL's 16 (colors packed as 24 bit integers) |

## The rig

15 bones in a fixed chain: hips, spine, head; shoulder, elbow, hand per arm; hip, knee, ankle per leg (the foot is kept flat). A pose (`PersonPose`) is 16 numbers: hip height, spine lean/tilt/twist, head turn/pitch, per arm raise/out/elbow, per leg thigh swing/knee bend. `plantFeet()` solves the legs to stand feet on the floor. The vertex shader (`RIG_GLSL`) and `personFrame()` are the same chain and must change together.

## In the city

- **Drivers** are in (`render/people/drivers.ts`): one `People` at the mid level for the whole field, seated from each car's measured cabin (`SEATS`: cushion, seat back and wheel stations from the shipped GLB's `Interior` faces; measure a new car before it ships), each arm solved (two bones) to a grip on a wheel placed where a seated driver's hands fall, the grips going round the rim with the steer angle (a car whose donor wheel survived, the Coupe, names its own), head into the turn, body against the roll, through the tinted glass. The menu's cruising car has one too.
- **Idlers** (`render/people/idlers.ts`, spots from `idleSpots.ts`) stand, sit and lean at bus stops, benches, cafe tables and shop fronts; they turn their heads to the two nearest cars and flinch, and a destroyed prop takes its sitters.
- **Walkers** (`render/people/walkers.ts`, paths and the roster from `walkPaths.ts`) walk the sidewalks with no per frame CPU at all. At build, each ordinary street's sidewalk, each side, is sampled along its middle and a small dynamic program picks the lane (0.25 m steps) that clears every prop by its collision radius, the walls, the curb and any road cut (a bus bay), so a detour is a smooth bend; the best lane through each clear run is simplified to at most five points and cut into paths. A cell (100 m) gets walkers in proportion to its path length, boosted downtown and toward the route, capped by `WALKERS[tier].perCell` (Low none, Medium 60, High 150). A walker is a stretch of one path (often running to a corner), a speed (1.1-1.6 m/s), a phase and a look; its instance matrix is the path's first point and four `vec4` attributes hold the rest (x, y, z from the start and the length walked, padded by repeating the last), so one draw per level of detail per cell. The vertex shader turns the scene clock and the phase into the cycle (one leg, a pause to turn round and glance about, the leg back, a pause), picks the point and a corner smoothed heading from the polyline and swings the legs and arms from the *distance walked* (a stride is about 1.35 m), so feet do not skate and position is a pure function of the clock: the menu city and a race agree, a pause freezes them, nothing is written per frame but the clock and the two nearest cars (the idlers' uniforms). They keep to the right of their way, turn their heads to a car within ~14 m, flinch from a fast one within ~6 m and step aside (eased, stateless, render only) from any car within ~4 m. Crowd detail within `near` m of a cell, far detail beyond; Medium draws about 850 far and 50 crowd figures (about 220k triangles, 22 draws) along the route before frustum culling, High about three times that. `PersonShader.root` is how a variant places the person (a `mat4` its pose snippet sets) after the rig.
- **Race crowds** are on the character: `race/crowds.ts` keeps its stands, excitement, cheer waves and car dodging, and its shader computes the pose per instance from excitement and a phase (`CROWD_POSE`: idle sway and weight shifting, a glance around, clapping as it rises, arms up waving and jumping at the top, a phone held up or a flag waved). A material variant passes that GLSL to `personMaterial()` (`PersonShader`), which is how any new context gets its own motion without touching the rig.
