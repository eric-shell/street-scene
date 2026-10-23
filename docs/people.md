# People

Every person in the game is the same character: the garage crew today, the race crowds and the driver next. One look, one mesh, one shader rig, so they read as the same world and stay cheap enough to draw by the hundred.

## The look

Stylized and faceless. Rounded low-poly shapes with strong silhouettes: an egg of a head with no features, a lathed torso that tapers to the waist, capsule limbs, mitten hands, rounded shoes. Clothes are flat colors, no textures. Character comes from silhouette and color: work shirts and trousers in the garage, hoodies, jackets and sneakers in the crowds. At night most people are seen as shapes under street light, which is where this style holds and realism falls apart first.

Per person options (`WEAR` bits): cap with brim, beanie, swept hair, hood, hi-vis chest stripe, gloves. Six colors per person: skin, shirt, trousers, shoes, hair, cap. Held things (mugs, cans, wrenches, boxes; later phones, flags, glowsticks) are separate instanced meshes placed from `personFrame()`.

## Cost

| | |
|---|---|
| `personGeometry('hero')`, beside the cars | 4.1k triangles (every option is in the mesh; hidden ones collapse to a point) |
| `personGeometry('mid')`, a crowd within about 20 m | 1.5k: the same shapes at half the segments, no collar, belt or soles |
| `personGeometry('far')`, the back rows | 180: nine boxes on the same bones |
| Draw calls | 1 per level of detail on screen, +1 blob shadows, +1 per held-thing shape |
| Per frame (CPU) | 16 floats per moving person, plus the instance matrix |
| Vertex attributes | 13 of WebGL's 16 (colors packed as 24 bit integers) |

## The rig

15 bones in a fixed chain: hips, spine, head; shoulder, elbow, hand per arm; hip, knee, ankle per leg (the foot is kept flat). A pose (`PersonPose`) is 16 numbers: hip height, spine lean/tilt/twist, head turn/pitch, per arm raise/out/elbow, per leg thigh swing/knee bend. `plantFeet()` solves the legs to stand feet on the floor. The vertex shader (`RIG_GLSL`) and `personFrame()` are the same chain and must change together.

## Next

- **Race crowds** (`render/race/crowds.ts`): move from the box people to `People`, one instance per level of detail (mid within about 20 m, far beyond, nothing past the draw distance). Their idle, cheer, wave and jump clips become pose presets blended in the shader from one or two floats per person (clip, excitement), so crowds keep costing no CPU.
- **Driver**: the same character seated, hands on the wheel from the steering angle, head following the turn, in the team's colors; drawn only where a camera can see into the car.
