"""
Wheels from donor models: one real wheel model per Street Scene wheel (Sketchfab, CC BY), kept as
the wheel it is and fitted to one house tire, so every wheel shares a tire and a size and keeps
its own face, lip and barrel (docs/carWheels.md).

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/carRefs.py').read())
    exec(open(REPO + '/scripts/blender/carDonors.py').read())     # cull_hidden, shade_from_source, meshopt
    exec(open(REPO + '/scripts/blender/carWheels.py').read())
    import_asset(source='sketchfab', id=WHEELS[name]['uid'], target_size=0.65)   # MCP tool
    w = wheel(name, '<import root>')     # -> wheels:Wheels / wheel_<name>
    wheel_report(list(WHEELS))

Material and object names on wheel models carry no meaning (`Material.026`, `Object_12`), so the
pipeline works from geometry. The import's meshes are welded (several arrive shattered into
thousands of islands) and every island is classified by where it sits on the wheel: a `ring`
reaches the lip radius and never comes inside the dish (the lip and the barrel), a `cap` sits in
the hub, a `bolt` is one of a circle of small islands at the same radius, `decal`s are flat (logo
planes, pinstripes, glass over a badge) and go, and everything else is `face` (spokes, hub,
flanges). The donor's own lip and barrel stay, so a deep dish is as deep and a stepped lip as
stepped as the author made it; the rings of bolts, which carry most of a donor's triangles
(500,000 on the VS-TX), are replaced by house hex heads at the bolts' own circle, radius and
count; the house tire is lathed around the lip; a house center cap fills a hub nothing covers.

Fit: the wheel is scaled so its lip edge sits on the house tire's bead (BEAD x TIRE_R, a 16 inch
wheel on the 0.28 m tire), the lip edge is set just proud of the tire's sidewall, and what is
visible from the lip edge back to the face keeps its depth, and the barrel behind the face is
squeezed to end at the tire's back bead. That barrel is kept and turned all the way back: it
shows between the spokes and from behind, and a wheel cut off at its face looks skinny.

Reduce: faces hidden from every direction forward of the car's centerline go (nobody sees a wheel
from inside the car), then each kind is collapsed to its budget (BUDGETS: the face takes most)
and shaded from the donor's authored normals. Materials: face and hub `Rim` (the player's wheel
colour), the ring `RimLip` (its stock finish in the object's `lip`: chrome on a bolted multi-piece
wheel, rim on a one-piece), the center cap `RimCap` (turned clean from its median profile, so the
donor maker's logo goes), bolts and lug nuts `Chrome`, the tire `Tire`; a source material named
black stays `Black`. The garage paints the lip and the cap apart from the face.

Wheel space (exportCar.py): center at the origin, axle along X, the face toward +X. The game
scales a wheel so the tire's outer radius meets the car's wheel radius and remaps the wheel for
the size slider from where the Tire mesh meets the rest (src/render/car/wheelFit.ts).
"""
import json
import re

TIRE_R = 0.28        # m, house tire outer radius (standardWheel)
TIRE_W = 0.24        # m, house tire width
BEAD = 0.74          # wheel lip radius / tire radius: a 16 inch wheel on a 0.28 m tire
TIRE_SEG = 40        # segments around the house tire (960 triangles)
X_LIP = TIRE_W * 0.45      # m, where the lip edge sits: just proud of the tire's bead (TIRE_W * 0.42)
X_BACK = -TIRE_W * 0.5     # m, where the barrel ends: the tire's back bead
BUDGETS = {'face': 6000, 'ring': 2400, 'cap': 700}   # triangles per kind after the collapse (the ring's is for the pre-cull collapse; it is turned afterwards)
RING_SEG = 56        # segments around the turned lip and barrel (a 40-gon shows on a chrome lip up close)
CAP_SEG = 40         # segments around the turned center cap
RING_BANDS = 26      # profile points sampled along the lip's visible surface
BOLT_SEG = 6         # hex heads
BOLT_MAX = 48        # more peaks than this on a bolt circle is a knurl, not bolts
GOLDEN = math.pi * (3 - math.sqrt(5))   # rad, the golden angle: sample angles round the axle that no spoke count repeats
WELD = 2e-5          # m, vertices closer than this (in the import's 0.65 m scale) are one

# Dropped from every wheel by material or object name: display scenes, branding, brakes, valves.
# Whole words only: `MaterialStandart` is a wheel and `GLTF_SceneRootNode` holds everything.
JUNK = r'(?i)(?<![a-z])(stand|ground|plane|shadow|floor|backdrop|logo|badge|emblem|decal|brake|caliper|calliper|disc|disk|rotor|valve)(?![a-z])'

# The garage groups wheels by the real maker of their donor, under a fictional maker name (real
# wheel makers' names never ship): the maker as the donor's title leads with it -> the group.
GROUPS = {'Work': 'Yamabiko', 'Rotiform': 'Oni', 'Vossen': 'Tanuki', 'HRE': 'Kitsune', 'Fifteen52': 'Kappa',
          'SSR': 'Seiryu', 'BBS': 'Fujin', 'Volk': 'Nue', 'Enkei': 'Kamaitachi',
          'Advan': 'Baku', 'Avant Garde': 'Byakko', 'Brixton Forged': 'Hiryu', 'Kyusha Shoes': 'Mizuchi', 'Velare': 'Shuten',
          'VIP Modular': 'Suzaku', 'Weds': 'Tengu', 'Brabus': 'Genbu', 'Budnik': 'Hotaru',
          'Devil Japan': 'Kaito', 'Kansei': 'Kodama', 'MAE': 'Nekomata', 'Spoon': 'Orochi', 'Konig': 'Kohaku',
          'Rays': 'Nue',   # Volk is a Rays brand: one group
          'Vossen-x-Work': 'Tanuki'}   # a Vossen collaboration, listed with Vossen

# Most donors are jonver87's (CC BY 4.0): clean showpiece models without tires, each piece its own
# mesh. Recipe fields: `construction` 'single' / 'multi' (one-piece or multi-piece, stated on every wheel: the
# stock lip finish reads it, and the offset tooling acts on multi-piece wheels only), `maker` the donor's real maker (a key of GROUPS), `face` 1 / -1 forces the
# face direction when the normal vote gets it wrong, `lip` 'chrome' / 'rim' overrides the ring's
# finish (chrome on a multi-piece wheel, the wheel colour on a one-piece), `drop` a regex of
# material or object names to drop, `bolts` 0 to keep no bolt circle, `normals` 'geometry' to
# shade the face from its own shape when the donor's normals are wrong, `dark` a luminance (0-1):
# faces whose base colour texture is darker go (a tire welded to the wheel in one textured mesh).
# `pick` (axis, lo, hi): keep only the faces whose centre lies between lo and hi on that axis of the import's frame (a scene holding several wheels).
# `cap` the turned hub cap's radius (share of the lip) where the round test stops short of an opening a dropped logo cap covered. An explicit radius may be under 0.12 and must clear the vertices of the hub's fan of faces (momiji's 20.8 mm recess: 0.105).
# `cap_fill` True closes a cap ring's open center, so the whole center wears the cap's paint (sora).
# `cap_disc` (share of the lip): the turned cap takes in the face's front-facing faces inside this radius too, so the cap is the hub's whole round disc out to where the spokes begin, with no face-paint ring round it.
# `cap_max` (share of the lip): cap-kind pieces of the donor with a vertex beyond this radius go back to the face (`Rim`) before the cap is turned, so the cap is only the center disc where pocket walls or hub pieces were classified cap (hinoko).
# `cap_edge` (share of the lip): the center cap's own edge, read off the donor, where the piece classified as cap is the whole hub round it (the pad, ring or bowl the cap sits in). The hub is still turned with the cap, a piece of it running round the axle included, but only inside the edge is RimCap; past it the face's Rim (hari, homura, minamo, natsu, shirabe).
# `turn` (share of the lip): on a multi-piece wheel, turn the face's surfaces of revolution joined to faces outside it, as on a one-piece (a round flange the spokes stand on, which a collapse crumples: mio).
# `chunks` True for a scan cut into chunks that each run from the hub to the lip: its islands are no parts (the ring ones are barrel
# scraps, the narrow and flat ones pieces of spoke), so all but the hub's join the face and the lip is turned out of it as on a one-piece.
# `keep` a regex of names the junk words would drop that are the wheel (the 57DR's spokes sit under a node named DISK).
# `offset` 'fixed' ships the wheel as modelled whatever the car's target (hane); `bias` (mm on the car, + outboard) moves the face that much past the target, or from stock on a one-piece (see `wheel_offset`).
# `lugs` 0 when no lug circle shows (a cap or a solid face hides it), or (count, r over the lip) for the circle to take where the innermost is a decoration, with an optional dict as a third item (see `fit_lugs`): `phase` (deg) for two circles at one radius, `seat` (m) to seat the nuts on a ring of that radius where the hole's floor is not the seat. `x` (m) sets the seat outright (kazakiri, momiji).
_J = {'author': 'jonver87', 'license': 'CC Attribution'}
WHEELS = {
    'kumo': {'name': 'Work VS-TX', 'construction': 'multi', 'uid': '31c76095a0754cb1b08591d63973a2c2', 'maker': 'Work', **_J},
    'yari': {'name': 'Work Equip 03', 'construction': 'multi', 'uid': '13c021b58f2b4c42ac747feb5457750b', 'maker': 'Work', **_J},
    'tsume': {'name': 'Work Equip 40', 'construction': 'multi', 'uid': 'ac9b1a3ffbd8400a9b364d0596fdcc56', 'maker': 'Work', **_J,
              'lugs': (4, 0.237)},   # a dual drilled hub (4x100 and 4x114.3): the four holes at r 49 mm on the diagonals, in pockets 9 mm deep between the spokes and the cap (the 100 mm set), not the four countersunk holes on the spokes at r 57 mm (114.3) or the crescents at r 41 mm; the nut seats on the pocket's floor (x 31.6 mm)
    'hari': {'name': 'Work Emitz', 'construction': 'multi', 'uid': '0dd4b490ee624aeda867cd5ccfe530e6', 'maker': 'Work', **_J,
             'cap_edge': 0.186},   # the cap is the badge glass (r 31 mm) in its gold hex and flange (38.6 mm); the cap_001 island round it, out to 64.7 mm, is the wheel's grey bowl: RimCap ran to 62.7 mm (2026-10-28)
    'kasumi': {'name': 'Work VS-KF', 'construction': 'multi', 'uid': 'f762ae9a968d4971a9c4c61922310e44', 'maker': 'Work', **_J},
    'raiden': {'name': 'Work VS-XV', 'construction': 'multi', 'uid': 'bb47f6dd1ab6406289c59e3c0a86be38', 'maker': 'Work', **_J},
    'ryusei': {'name': 'Work VS-XX', 'construction': 'multi', 'uid': '6a1c8ab8df444530a2a0ac93487cf3bd', 'maker': 'Work', **_J,
               'face': -1},   # its badge sits behind the hub's center, so the badge rule turned it round
    'shinobi': {'name': 'Work Zistance W5S', 'construction': 'multi', 'uid': '8a80d5dd27384671bb1beef04234f3db', 'maker': 'Work', **_J},
    'tsurugi': {'name': 'Work Schwert SC2', 'construction': 'multi', 'uid': '054f59d1321e41aebeffa272d4b7f863', 'maker': 'Work', **_J},
    'kaze': {'name': 'Work Equip 02', 'construction': 'single', 'uid': '57f0fcea45df47188bc8531a012d3357', 'maker': 'Work', **_J},
    'hagane': {'name': 'Work Euroline DH', 'construction': 'multi', 'uid': 'eab967f5fcab4581bd427ddf6b79da52', 'maker': 'Work',
              'bias': 25, **_J},   # the user, 2026-10-28: a flush face (seat at its front) reads deep at the car's target; 25 mm more out
    'kagero': {'name': 'Work Import Label AL4', 'construction': 'single', 'uid': '593aed74677d49ff953e068debce4b87', 'maker': 'Work', **_J},
    'gekko': {'name': 'Work LS Chiarezza SUV', 'construction': 'multi', 'uid': '3134884d8ecf45c9817cf5e1d231734b', 'maker': 'Work', **_J,
              'bolts': 0},   # its rivets sit in pairs in the windows: the histogram read three bolts; multi-piece all the same, the rivets stay on the face
    'nami': {'name': 'Rotiform ZMO', 'construction': 'multi', 'uid': '4193e4cd0fdc481688e3a437e4e5d130', 'maker': 'Rotiform', **_J},
    'shizuku': {'name': 'Rotiform Aerodisc', 'construction': 'single', 'uid': 'ccaf76b4b4514d1e9b6351a628e75817', 'maker': 'Rotiform', **_J,
                'cap_fill': True},   # its center nut is a ring round a logo plate: filled, or the turned cap leaves the bore open
    'uzu': {'name': 'Rotiform VCE', 'construction': 'single', 'uid': '05783beda2a74aa8981fb374e9088b4f', 'maker': 'Rotiform', **_J,
            'face': -1},   # the normal vote showed the plain back of the fins
    'kawa': {'name': 'Rotiform SIX', 'construction': 'multi', 'uid': '35d0043f1c774ddfaa7c3983eb3bc8c0', 'maker': 'Rotiform', **_J,
             'face': -1},   # the normal vote showed the plain backs of the spokes
    'taki': {'name': 'Rotiform AVS', 'construction': 'single', 'uid': 'cdb62e8166e64cf58fafed97348733b1', 'maker': 'Rotiform', **_J},
    'minato': {'name': 'Rotiform KB1', 'construction': 'single', 'uid': 'c6c9212941fd4a3182566141ea2caa10', 'maker': 'Rotiform', **_J},
    'kiri': {'name': 'Rotiform USF', 'construction': 'single', 'uid': 'af96ede3c79849e0967017c7af56e1c4', 'maker': 'Rotiform', **_J},
    'shio': {'name': 'Rotiform MLW', 'construction': 'single', 'uid': '7dbcd9ba45dc4ff3b53b2eb3822ec5bc', 'maker': 'Rotiform',
              'bias': 20, **_J},   # the user, 2026-10-28: the face out 20 mm (a one-piece: this is its only move)
    'ame': {'name': 'Rotiform OZR', 'construction': 'single', 'uid': '72e5ee8f6e6b46799c00f732f414d41f', 'maker': 'Rotiform', **_J,
            'face': -1},   # its center nut and logo cap sit on this side; the normal vote showed the hub's back
    'yuki': {'name': 'Rotiform BM1', 'construction': 'multi', 'uid': 'abb6a1de9bd54492baff6843cad8a429', 'maker': 'Rotiform', **_J,
             'normals': 'geometry',   # the authored normals left big shading triangles over the collapsed flat face plate
             'face': -1},   # the normal vote showed the barrel, the lip bolts at its far end
    'shigure': {'name': 'Rotiform WRO', 'construction': 'multi', 'uid': 'd64d8d4fab944a77a6fba680551a7e67', 'maker': 'Rotiform',
              'bias': 25, **_J},   # the user, 2026-10-28: a flush face reads deep at the car's target; 25 mm more out
    'umi': {'name': 'Rotiform CCV', 'construction': 'multi', 'uid': '827bfe4138d447c28888c6c22a47609b', 'maker': 'Rotiform', **_J,
            'face': -1},   # the normal vote showed the barrel, the lip bolts at its far end
    'hyo': {'name': 'Rotiform LHR', 'construction': 'multi', 'uid': '89a4f55b4d164153863a8f1350aa7786', 'maker': 'Rotiform',
              'bias': 25, **_J},   # the user, 2026-10-28: a flush face reads deep at the car's target; 25 mm more out
    'tsuyu': {'name': 'Rotiform LSR', 'construction': 'multi', 'uid': '1fe207f311bb4b50b0cf4d3fbbe549b2', 'maker': 'Rotiform', **_J},
    'kori': {'name': 'Rotiform KLU', 'construction': 'multi', 'uid': '641a37e731194b3e8fdd18e6a9b1e6d9', 'maker': 'Rotiform', **_J},
    'mio': {'name': 'Rotiform SNA', 'construction': 'single', 'uid': '20dad53c5f1947cf92f113f3c2e7c2fe', 'maker': 'Rotiform', **_J,
            'turn': 0.6,   # the round flange its spokes stand on is part of the face: collapsed, it crumpled between the spoke tips
            'face': -1},   # the normal vote showed the plain backs of the spokes
    'fubuki': {'name': 'Rotiform KPS', 'construction': 'single', 'uid': 'c3ffecfad22d4a3a808123bac5187479', 'maker': 'Rotiform', **_J},
    'seseragi': {'name': 'Rotiform PNT', 'construction': 'multi', 'uid': 'cee8b459137249e5bcfa8289d5c2759c', 'maker': 'Rotiform', **_J},
    'aoi': {'name': 'Vossen LC104T', 'construction': 'single', 'uid': 'aa0f85f015d741a5958dc70fea79d863', 'maker': 'Vossen', **_J},
    'sora': {'name': 'Vossen LC109T', 'construction': 'single', 'uid': '3fe9676878634ec183068252cb2d52fd', 'maker': 'Vossen', **_J,
             'cap_fill': True},   # its cap is a ring round an open bore: filled, so the whole center takes the cap's paint
    'hikari': {'name': 'Vossen VPS302', 'construction': 'single', 'uid': 'ba0fafb1c9b545328948ad716a8b5747', 'maker': 'Vossen', **_J},
    'kagami': {'name': 'Vossen VPS301', 'construction': 'single', 'uid': '4bfa99c33ba94cd08dfcf3cd53d1cd2d', 'maker': 'Vossen', **_J},
    'seiun': {'name': 'Vossen ERA3', 'construction': 'multi', 'uid': 'b5cffbf62f77419897de89413427d33d', 'maker': 'Vossen', **_J},
    'getsuei': {'name': 'Vossen GNS-1', 'construction': 'single', 'uid': '7e9cf35d7dfd4ab083febc646a19746a', 'maker': 'Vossen', **_J},
    'kirameki': {'name': 'Vossen VPS 315T', 'construction': 'single', 'uid': '9479e07055a14102ae8efb3b8658f9da', 'maker': 'Vossen', **_J},
    'hisui': {'name': 'Vossen CG203', 'construction': 'single', 'uid': '38b5f76123a0461cb82b8616b734ac5f', 'maker': 'Vossen', **_J},
    'tora': {'name': 'HRE P200', 'construction': 'single', 'uid': '7221bc7c423e401f83712d56e435a813', 'maker': 'HRE', **_J},
    'tsuchi': {'name': 'Fifteen52 Rally Sport', 'construction': 'single', 'uid': '1ed9ad4cbe5644ae831fe95bae84a0fc', 'maker': 'Fifteen52', **_J},
    'homura': {'name': 'SSR Koenig', 'construction': 'multi', 'uid': '391ab57dc25a4aa69771fbb9114f3d40', 'maker': 'SSR', **_J,
              'bias': 25,   # the user, 2026-10-28: a flush face (seat at its front) reads deep at the car's target; 25 mm more out
              'cap_edge': 0.179},   # the cap is the KS plate (r 26.5 mm, 5 mm down) in its bezel of ten screws, ringed by a groove at 37 mm; the hub pad round it (one island with it, to 59 mm) is the wheel's. `cap_disc: 0.29` had painted the whole pad and more (2026-10-28)
    'hane': {'name': 'BBS E52', 'construction': 'multi', 'uid': '8168cc3dce114b19b617c17fea0ab364', 'maker': 'BBS', **_J,
             'offset': 'fixed',   # the user, 2026-10-28: the dome proud of the lip is the design (an old school European style), so it ships as modelled
             'normals': 'geometry',   # its mesh's authored normals lean sideways: the face shaded dark
             'face': -1},   # the normal vote showed the hub's back, with its five stud holes
    # By hand after wheel() (2026-10-28): its Rim face sat 5.6 mm off the axle and was moved onto it (+0.0056 y,
    # -0.0001 z; the face protrudes past the lip on purpose, a euro face); the house cap widened to 0.173 of the
    # lip with its skirt sunk to x 0.132; then fit_lugs found its 5 lugs (r 0.056 m) and set `lugs`.
    'iwa': {'name': 'Volk Rays 21C', 'construction': 'single', 'uid': 'd053af8f24bc4a5dbaf9d21f31ae25da', 'maker': 'Volk', **_J,
            'bias': 20,   # the user, 2026-10-28: the face out 20 mm (a one-piece: this is its only move)
            'face': -1},   # the normal vote showed the plain backs of the spokes
    'kiseki': {'name': 'Enkei Nt03+m Wheels', 'construction': 'single', 'uid': '6d31c56557b945a5abd4015884461dc4', 'maker': 'Enkei',
               'author': 'flathat3d', 'license': 'CC Attribution',
               'drop': r'CenterCaps|Nt03m_02',   # three stacked logo caps (the house cap fills the hub) and the lip lettering
               'normals': 'geometry',   # authored normals lean off the spokes: front normal 0.14
               'face': -1},   # the dropped caps and lettering sat on this side; the normal vote showed the hub's back
    'hien': {'name': 'BBS CH-R + Goodyear Eagle F1 Supercar 3', 'construction': 'single', 'uid': '2acc32fc79684a2c8b7df9faaa5a5c35', 'maker': 'BBS',
                'author': 'MozzarellaARC', 'license': 'CC Attribution',
                'dark': 0.25,   # its tire is welded to the wheel in one textured mesh: tire 0.10, wheel 0.45
                'face': -1},   # the normal vote showed the hub's back
    # 2026-10-28, fifty-six more: jonver87's again, plus portfoliorodrigues, alexanderlyreo and dermaks
    'akatsuki': {'name': 'HRE TUSK', 'construction': 'single', 'uid': '31734356b1b14312ad5c11f24c78fd57', 'maker': 'HRE', **_J},
    'ayame': {'name': 'Advan A3A', 'construction': 'multi', 'uid': '502e2341d5c74cb9a312af876697523e', 'maker': 'Advan', **_J},
    'botan': {'name': 'Velare VLR F1', 'construction': 'single', 'uid': 'db3568387f4b43d1988f73874f43e90f', 'maker': 'Velare', **_J},
    'chidori': {'name': 'Rotiform WRG', 'construction': 'multi', 'uid': '4bb6ed6ac0e246569b18e5c8929ffd7e', 'maker': 'Rotiform', **_J},
    'daichi': {'name': 'Rotiform IHR', 'construction': 'multi', 'uid': '03027fcac92a476aba1a55c1cb148595', 'maker': 'Rotiform', **_J},
    'enishi': {'name': 'Kyusha Shoes Meteor FF', 'construction': 'single', 'uid': '79d3c95516dc4e3693ce0e1fcdaf7909', 'maker': 'Kyusha Shoes', **_J},
    'fuyu': {'name': 'Brixton Forged TR06', 'construction': 'single', 'uid': 'fb3ed2107cf949cba4922a8af22635fb', 'maker': 'Brixton Forged', **_J},
    'genki': {'name': 'Avant Garde F450', 'construction': 'multi', 'uid': 'aaf0fb4891cd474e86df0eb2dc322e48', 'maker': 'Avant Garde', **_J},
    'haruka': {'name': 'Avant Garde F142', 'construction': 'multi', 'uid': '0c5a53690d0d40adadf3ddaf0828c8b6', 'maker': 'Avant Garde', **_J},
    'hasu': {'name': 'HRE FF04', 'construction': 'single', 'uid': 'b0d7579597a542978a00cf19ec3c9d29', 'maker': 'HRE', **_J},   # a one-piece: the bolt test found a circle of three heads, no lip bolt ring
    'ibuki': {'name': 'Brixton Forged VL7', 'construction': 'multi', 'uid': '051fba725036489288a0ed6ded9a4abe', 'maker': 'Brixton Forged', **_J,
             'face': -1},   # the normal vote put the lattice face 0.7 of the way down the barrel
    'kaen': {'name': 'Brixton Forged PF6', 'construction': 'single', 'uid': '60d3005ced7f42fa9100b0aa03979269', 'maker': 'Brixton Forged', **_J,
              'lugs': (5, 0.21)},   # the five round holes, not the slots' inner holes (innermost won): the nuts seat at the bottom of the hole
    'kanade': {'name': 'HRE 522M', 'construction': 'single', 'uid': '17dfb9313e3346d59021dbcca0142762', 'maker': 'HRE', **_J,
              'pick': ('x', 0, 1)},   # the scene holds two wheels side by side: the one on +X
    'karasu': {'name': 'Vossen VFS4', 'construction': 'single', 'uid': '2a078ce1d2b3463cab9bc3179432bf1c', 'maker': 'Vossen', **_J},
    'madoka': {'name': 'Vossen LC106', 'construction': 'single', 'uid': 'bb90d9eb6f9c4bdc8fdc8340cfa693b6', 'maker': 'Vossen', **_J},
    'mizore': {'name': 'Vossen LC108T', 'construction': 'single', 'uid': '124076f7e61f43109c78f329bbb4ee8b', 'maker': 'Vossen', **_J},
    'momiji': {'name': 'Vossen-x-Work VWS3', 'construction': 'multi', 'uid': 'bff5b9a09f0f42febac5fba5c2f2860c', 'maker': 'Vossen-x-Work', **_J,
              'face': -1,   # the spokes' concave fronts; face 1 showed the hub's mounting pad and stud holes (2026-10-28)
              'cap': 0.105,   # the real cap is the round logo disc in the hub's center (a recess 20.8 mm across its fan of faces, 3 mm deep, ringed by the hub's cone, the five nuts out at r 40 mm); 0.235 turned the whole hub pad round it, stud holes and all, as cap, and 0.101 missed the recess' fan (its rim vertices sit at 20.7 mm) (2026-10-28)
              'lugs': (5, 0.194, {'x': -0.0229})},   # five through holes at r 40 mm on the hub's cone: with the nuts and the oversize cap gone the rays round a hole fall through to the barrel (the seat read -58 mm), so the nut sits where the cone is at the holes (x -22.9 mm)
    'nagi': {'name': 'Vossen VPS 310T', 'construction': 'single', 'uid': '2128c0d05b98416c9de4f3eccf2605aa', 'maker': 'Vossen', **_J},
    'natsu': {'name': 'Rotiform HVN', 'construction': 'multi', 'uid': 'c89560b091cf49e9b2cc4f0f38074d40', 'maker': 'Rotiform', **_J,
             'face': -1,   # face 1 showed the plate's plain back and the hub's mounting face (2026-10-28)
             'cap_edge': 0.186},   # the cap is the black hex and its flange (cap_black, 38.6 mm); the red ring round it (its own island, 35.8 to 60.9 mm, the face's material) is the hub: RimCap ran to 59 mm (2026-10-28)
    'nokaze': {'name': 'Rotiform SEA', 'construction': 'multi', 'uid': '6dd27000a1cf433490be246b67868022', 'maker': 'Rotiform', **_J},
    'ogi': {'name': 'Rotiform RSC', 'construction': 'single', 'uid': '3be8e6543dc34551b71666f4c0d262a5', 'maker': 'Rotiform', **_J,
           'face': -1},   # the normal vote put the plate 0.73 of the way down the barrel
    'rin': {'name': 'Vossen CG207', 'construction': 'single', 'uid': '91a910d8ccb944e78b036ca01a2c4eba', 'maker': 'Vossen', **_J},
    'sakura': {'name': 'Rotiform EMA', 'construction': 'single', 'uid': '403b46a5f85a4ddfbff2de8eb1f7742e', 'maker': 'Rotiform', **_J,
              'face': -1},   # the normal vote put the plate 0.85 of the way down the barrel
    'sango': {'name': 'VIP MODULAR VXS410', 'construction': 'multi', 'uid': 'b97b8008fd614027864e59b6921d7919', 'maker': 'VIP Modular', **_J},
    'sazanami': {'name': 'VIP MODULAR VX510', 'construction': 'multi', 'uid': '0079270fb2ed4635a276a945258d0cf1', 'maker': 'VIP Modular', **_J},
    'shirube': {'name': 'Brixton Forged CM16', 'construction': 'multi', 'uid': 'c47c0b869f5f48f9bb5d629c8fbf3bcb', 'maker': 'Brixton Forged', **_J,
               'face': 1},   # the normal vote put the face 0.73 of the way down the barrel
    'sumire': {'name': 'Vossen VFS2', 'construction': 'single', 'uid': '671ea5f9079e4826a484e797f0b267b6', 'maker': 'Vossen', **_J,
              'face': -1},   # the normal vote put the face 0.77 of the way down the barrel
    'suzume': {'name': 'VOLK TE37SL 3spoke', 'construction': 'single', 'uid': '1b03d5aa04bf404baa482de0f0ecec32', 'maker': 'Volk', **_J,
              'face': 1},   # the normal vote put the face 0.59 of the way down the barrel
    'tamashii': {'name': 'RAYS TE037', 'construction': 'single', 'uid': 'e4ca99c55cec42b5940107b5c5ead0f6', 'maker': 'Rays', 'author': 'dermaks', 'license': 'CC Attribution'},
    'tomoe': {'name': 'Volk Rays 21A', 'construction': 'single', 'uid': 'd7c193d9873d4ab0b4df611fdb76a481', 'maker': 'Volk', **_J},
    'tsubaki': {'name': 'VIP Modular VXS610', 'construction': 'multi', 'uid': '9960a18aee194a1680f9d72455115a17', 'maker': 'VIP Modular', **_J},
    'tsutsuji': {'name': 'Enkei Riverge', 'construction': 'single', 'uid': 'e6a0a56973f54bcbad02188ae6fe70f9', 'maker': 'Enkei', **_J,
                'face': -1},   # the normal vote put the spokes 0.56 down the barrel, 0.39 turned
    'ukigumo': {'name': 'VOSSEN VFS1', 'construction': 'single', 'uid': 'b5ecbbe9ce254c20941d9db6dc3be57b', 'maker': 'Vossen', **_J},
    'usagi': {'name': 'Vossen HC-1', 'construction': 'single', 'uid': 'a09cf8de7a8940fa9733c46198a46fd1', 'maker': 'Vossen', **_J},
    'wakaba': {'name': 'fifteen52 Turbomac', 'construction': 'single', 'uid': '0dbadec625c249eea309d95eb015c9f4', 'maker': 'Fifteen52', 'author': 'portfoliorodrigues', 'license': 'CC Attribution'},
    'yamabuki': {'name': 'Work Meister S1 3P', 'construction': 'multi', 'uid': '7205c04f3cb24a7dbdaf6a304fb31f21', 'maker': 'Work', 'author': 'alexanderlyreo', 'license': 'CC Attribution'},   # its brake rotor and hat are welded into the one mesh, so the junk names miss them: deleted by hand after wheel() (the islands behind the spokes, x < 0.047 and r 0.055 to 0.12)
    'yoake': {'name': 'WORK MEISTER CR01', 'construction': 'multi', 'uid': '9b2bb4a769de4c6098efe95001072841', 'maker': 'Work', 'author': 'dermaks', 'license': 'CC Attribution',
              'lugs': (5, 0.294, {'seat': 0.012})},   # the five stepped pockets (the donor's black nuts), not the plain holes between them (a hole beats a nut); the nut sits on the ledge above the stud tube and the donor's nut goes down to it
    'yuzu': {'name': 'SSR Minerva', 'construction': 'multi', 'uid': '704b405602b74a788a0678fd39ac4e51', 'maker': 'SSR', 'author': 'dermaks', 'license': 'CC Attribution'},   # multi-piece: its rivets are moulded into the face's rim, so no bolt circle is rebuilt
    'zan': {'name': 'RAYS nismo LMGT1', 'construction': 'multi', 'uid': '6ed19c4728744e0b95246b5e125ea286', 'maker': 'Rays', 'author': 'dermaks', 'license': 'CC Attribution',
            'lugs': (5, 0.23, {'phase': 36})},   # ten holes on one circle: the five stud holes (a plate at the mounting plane, in pockets) at 36 deg, not the five open bores between them at 0 deg, which have no seat
    'hotaka': {'name': 'SSR Longchamp XR4', 'construction': 'multi', 'uid': '6b3cc8dc828b4e319d625ef3318a26ff', 'maker': 'SSR', 'author': 'dermaks', 'license': 'CC Attribution'},
    'sagi': {'name': 'Budnik Tusk', 'construction': 'single', 'uid': 'ab0c4c881d2d41f8a479273e81491978', 'maker': 'Budnik', 'author': 'dermaks', 'license': 'CC Attribution'},
    'uguisu': {'name': 'Weds Kranze Bazreia', 'construction': 'single', 'uid': '9f55befda4a64aeea5d6fc3586e055ae', 'maker': 'Weds', 'author': 'dermaks', 'license': 'CC Attribution'},
    'yuhi': {'name': 'BRABUS MONOBLOCK M', 'construction': 'single', 'uid': 'a27f7cb1c38240869275ed5319573826', 'maker': 'Brabus', 'author': 'dermaks', 'license': 'CC Attribution'},
    'asagi': {'name': 'Devil Japan IF', 'construction': 'multi', 'uid': '38821fe2a6b4417ab96e2f3948b65537', 'maker': 'Devil Japan', 'author': 'dermaks', 'license': 'CC Attribution'},
    'kasane': {'name': 'WORK Equip 05', 'construction': 'multi', 'uid': 'ea0c0c37faa0465ca38d1a3365fb9dfe', 'maker': 'Work', 'author': 'dermaks', 'license': 'CC Attribution'},
    'sazanka': {'name': 'KANSEI TANDEM', 'construction': 'single', 'uid': '4d467ea742e94f6aa9ffa8f7f1a0a913', 'maker': 'Kansei', 'author': 'dermaks', 'license': 'CC Attribution',
                'bolts': 0},   # a one-piece wheel: the raised lettering on its dish wall made a bolt circle of 13 heads
    'mikazuki': {'name': 'O.Z MAE', 'construction': 'multi', 'uid': '75f3ef08221849e2ac3a17dd2ecf2386', 'maker': 'MAE', 'author': 'dermaks', 'license': 'CC Attribution'},
    'inazuma': {'name': 'WORK EMOTION T5R 2P', 'construction': 'multi', 'uid': '38c31e5755494f7fa5e53fdbc95fa313', 'maker': 'Work', 'author': 'dermaks', 'license': 'CC Attribution',
                'lugs': (5, 0.205)},   # the five counterbored pockets (r 42 mm), not the ring of small decorative holes inboard (innermost won); the nut sits at the bottom of the bore
    'hanabi': {'name': 'SSR Starshark', 'construction': 'multi', 'uid': '58970916a3be46a48d61de853149a22a', 'maker': 'SSR', 'author': 'dermaks', 'license': 'CC Attribution'},
    'minamo': {'name': 'MAE CROWN JEWEL', 'construction': 'multi', 'uid': '2c77da7f41df431aa1db7b7c2afa92ca', 'maker': 'MAE', 'author': 'dermaks', 'license': 'CC Attribution',
              'face': 1,   # the normal vote put the spokes 0.76 down the barrel; the same template as the MAE above reads 0.39 turned
              'cap_edge': 0.181},   # the cap is the silver logo disc and its cone (mae_silver, 37.5 mm, an engraved line); the flush pad round it in the body's material, welded into the same island to 61 mm, is the hub: RimCap ran to 60.5 mm (2026-10-28)
    'nadeshiko': {'name': 'SSR Collection Mk1', 'construction': 'multi', 'uid': '8d2a195f7da443faa3de85b5a4708772', 'maker': 'SSR', 'author': 'dermaks', 'license': 'CC Attribution',
                 'pick': ('y', -1, -0.1085)},   # one scene of three wheels in a row along the axle (mk1, mk2, mk3 on one lip): the Mk1 spokes
    'tsukushi': {'name': 'SSR Collection Mk2', 'construction': 'multi', 'uid': '8d2a195f7da443faa3de85b5a4708772', 'maker': 'SSR', 'author': 'dermaks', 'license': 'CC Attribution',
                'pick': ('y', -0.1085, 0.1085)},   # one scene of three wheels in a row along the axle (mk1, mk2, mk3 on one lip): the Mk2 spokes
    'koyomi': {'name': 'SSR Collection Mk3', 'construction': 'multi', 'uid': '8d2a195f7da443faa3de85b5a4708772', 'maker': 'SSR', 'author': 'dermaks', 'license': 'CC Attribution',
              'pick': ('y', 0.1085, 1)},   # one scene of three wheels in a row along the axle (mk1, mk2, mk3 on one lip): the Mk3 spokes
    # 2026-10-28, twelve from other authors (all CC BY 4.0)
    'kawasemi': {'name': 'Spoon SW388', 'construction': 'single', 'uid': '069b86d4b4a2492e92eb3349805479f9', 'maker': 'Spoon', 'author': 'TinoD2', 'license': 'CC Attribution',
                 'drop': r'LowPoly|Tire'},   # a stand scene: a low poly copy beside the high poly wheel, both on tires
    'kazakiri': {'name': 'Work Emotion CR-KAI', 'construction': 'single', 'uid': '3025fa1677784df99abcf1cd2a30c5fa', 'maker': 'Work', 'author': 'gordeykomark', 'license': 'CC Attribution',
                 'drop': r'Tire|Rough_metal',   # its own tire, and the valve stem
                 'lugs': (5, 0.229, {'x': 0.022})},   # five 13 mm radius holes in counterbores that rise to the spokes' roots 56 mm out: the rays round a lug read the wall, so the nut seats on the ledge (x 22 mm) round the hole; the donor's nuts, standing in them, were cap islands that made the cap a 57 mm disc (see clean_cap)
    'tatsumaki': {'name': 'Rotiform DAB', 'construction': 'multi', 'uid': '48ff08bbf17b43b4abbc2ee9113be954', 'maker': 'Rotiform', 'author': 'blakebella', 'license': 'CC Attribution',
                 'drop': r'^tire$',   # its own tire (the rotor goes as junk)
                 'lugs': (5, 0.2426, {'x': 0.0436})},   # the donor's five tall nuts (r 50.3 mm, each 22 mm across with its collar, standing in holes through the bowl's floor); the rays round a lug read the bowl's rim (60.5 mm), so the seat is set outright: the floor, 43.6 mm. The old circle (r 56 mm, x 43.8) was the oversize cap disc, which covered those holes (see clean_cap)
    'kogane': {'name': 'BBS LM Gold Wheels', 'construction': 'multi', 'uid': '3aac505aa9484d088204fabef6a8a4c2', 'maker': 'BBS', 'author': 'zxargon', 'license': 'CC Attribution'},
    'namida': {'name': 'S13 Teardrops Rims', 'construction': 'single', 'uid': 'f8fe25efca84448994f449ef9d894d54', 'maker': 'Fifteen52', 'author': 'Once_a_goat_death', 'license': 'CC Attribution'},
    'akane': {'name': 'SSR Hasemi Prot-S', 'construction': 'multi', 'uid': '581e5099da7a4620b11c3fc424c507de', 'maker': 'SSR', 'author': 'techtackofficial', 'license': 'CC Attribution',
              'bias': 25,   # the user, 2026-10-28: a flush face reads deep at the car's target; 25 mm more out
              'cap_max': 0.15,   # the donor's lug mesh (nuts and their plate, out to r 39 mm) reaches the center, so clean_cap took it as the cap and turned an 87 mm cylinder over the nuts (the user, 2026-10-28); the cap is the 23 mm center piece alone
              'face': 1},   # its center cap and lip bolts face +X; the normal vote showed the spokes' backs deep in the barrel
    'tsukimi': {'name': 'Rotiform CVT', 'construction': 'multi', 'uid': 'ed962ed287cf4430a5af531accef5221', 'maker': 'Rotiform', 'author': 'niev', 'license': 'CC Attribution',
                 'drop': r'Nipel'},   # the valve stem
    'himawari': {'name': 'WEDS Kranze LXZ', 'construction': 'multi', 'uid': '2eef2cea9a634c2fbe5dc187d67ba747', 'maker': 'Weds', 'author': 'blakebella', 'license': 'CC Attribution',
                 'drop': r'^Material$'},   # its own tire, on a material of that name
    'hibiki': {'name': 'RAYS GramLights 57DR', 'construction': 'single', 'uid': '71a90d6c2d0a444d9d2ca7e3cf715c76', 'maker': 'Rays', 'author': 'ilvskf', 'license': 'CC Attribution',
             'drop': r'Sticker',   # the spoke stickers
             'keep': r'^DISK\.'},   # its spokes sit under a node named DISK. Rebuilt 2026-10-28 under the current clean_cap: like its sibling
                                    # kaminari the donor has no cap, an open bore in a dual drilled hub with five separate nuts, and the old build had
                                    # turned the hub into a 100 mm cap disc over the nut pockets (no lugs found); now the house cap (32 mm) and 5 lugs at r 46 mm
    'kaminari': {'name': 'Rays Gramlights 57CR', 'construction': 'single', 'uid': '47063c38bdaa46ebaf2d2af2079c7118', 'maker': 'Rays', 'author': 'ilvskf', 'license': 'CC Attribution',
               'drop': r'^(7\.001|material)$',   # the spoke stickers
               'chunks': True},   # a scan in chunks: the ring islands were barrel scraps (the face stood 18 cm proud of them), and
                                  # 109k triangles of spoke went as bolts. The donor has no cap, an open 24 mm bore in a bare hub with five nuts (r 51 mm):
                                  # its hub pieces and nuts classified as cap made a 62 mm flat disc (clean_cap now turns only the piece reaching the bore:
                                  # the house cap, 32 mm), and the lug circle read r 55.7 mm on that disc, not the nuts' 51 mm in their pockets (x 41 mm)
    'fuuga': {'name': 'RAYS G025', 'construction': 'single', 'uid': '8b14891bb44b43729d07f1e4e2744488', 'maker': 'Rays', 'author': 'ilvskf', 'license': 'CC Attribution',
            'drop': r'^material\.001$',   # the spoke sticker
            'lugs': (5, 0.215, {'seat': 0.0115}),
            'chunks': True},   # a scan in chunks, as the 57CR
    'hinoko': {'name': 'RAYS HOMURA 2x7', 'construction': 'single', 'uid': 'f2da4e9b0d04418aa1b53022d692ea6b', 'maker': 'Rays', 'author': 'ilvskf', 'license': 'CC Attribution',
             'cap_disc': 0.12,   # the turned cap sat 3 to 20 mm behind the donor's own flat hub disc (r 24 mm, a second Rim layer in front of it); take the disc in so the cap is the one surface, short of the lug circle (r 36 mm) on the cone
             'lugs': (5, 0.2190, {'at': -71.9, 'rad': 0.05}),   # the five nuts in their counterbores (r 45.4 mm, the first at -71.9 deg), placed from the recipe: the same angles as before but not r 36 mm, where the lugs stood on the cap's pocket pieces; the small holes between them are on the same circle and the depth image takes those
             'cap_max': 0.125,   # and nothing else of the hub is cap: the pocket walls round the five lugs and the small holes between them were cap-kind pieces out to r 57 mm, so the cap color showed behind the nuts
             'chunks': True},   # a scan in chunks, as the 57CR
    # 2026-10-28, two more (CC BY 4.0)
    'shirabe': {'name': 'Konig Countergram 5x120 Wheel / FREE MODEL', 'construction': 'single', 'uid': 'c3bffbcaafbe4f5388f14feed6b38cca', 'maker': 'Konig', 'author': 'shevchenkovisuals', 'license': 'CC Attribution',
                'drop': r'Tire|Text|Lug Nuts',   # its own tire, the lettering and the donor's nuts (nodes named for them)
                'cap_edge': 0.133,   # the black dome (Rim_Black, 27.5 mm); the bare chrome hub round it, one island with it to 61.7 mm, is the wheel's: RimCap ran to 61.7 mm, under the nuts (2026-10-28)
                'lugs': (5, 0.2217, {'at': 0})},   # the dropped nuts stood on a bare chrome hub round the black cap: no hole or pocket for the depth image to read, so the circle is the nuts' own (r 45.9 mm, the first straight up)
    'asahi': {'name': 'Enkie Rpf1', 'construction': 'single', 'uid': '43182083d4134e918a81f115905d5483', 'maker': 'Enkei', 'author': 'astrubal', 'license': 'CC Attribution',
              'face': -1, 'chunks': True,   # the lip flange is in the face's island and the barrel a separate one: as chunks the lip is turned out of both
              'lugs': (5, 0.2207, {'at': 0}),   # five pockets 16 mm deep in a recessed plate, read by the donor's own holes (r 45.7 mm); the depth image splits one and misses another
              'drop': r'Rubber|San_Francisco|Metallic_Simple|black|Car_paint|Black_Metal|Charcoal|Silver|free-enkei'},   # a full corner: its tire (read as the lip), calipers, rotor, hub and clips; the wheel is the one `Metal` mesh
}


def _rad(co):
    return math.hypot(co.y, co.z)


_PIXELS = {}


def _texture_luminance(me, bm, f):
    """The luminance of a face's base colour texture at its UV centroid; 1 when it has none. The
    BBS CH-R's tire is the same mesh and material as the wheel, told apart only by its black."""
    mat = me.materials[f.material_index] if me.materials else None
    bsdf = mat and mat.node_tree and next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    links = bsdf.inputs['Base Color'].links if bsdf else ()
    img = links[0].from_node.image if links and getattr(links[0].from_node, 'image', None) else None
    uv = bm.loops.layers.uv.active
    if img is None or uv is None:
        return 1.0
    if img.name not in _PIXELS:
        _PIXELS[img.name] = (img.size[0], img.size[1], img.pixels[:])
    w, h, px = _PIXELS[img.name]
    u = sum(l[uv].uv[0] for l in f.loops) / len(f.loops)
    v = sum(l[uv].uv[1] for l in f.loops) / len(f.loops)
    i = (min(h - 1, int((v % 1) * h)) * w + min(w - 1, int((u % 1) * w))) * 4
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]


def _gather(root, R):
    """The import's meshes joined into one bmesh in world space and welded, junk dropped. Each
    face keeps its source material name (`mat_names`) and the authored normals (`src_normal`)."""
    bm = bmesh.new()
    names = []
    top = bpy.data.objects[root]
    for o in _descendants(top):
        below = []
        p = o
        while p is not None and p is not top:
            below.append(_base(p.name))
            p = p.parent
        if o.type != 'MESH' or not o.data.polygons or any(re.search(JUNK, n) and not (R.get('keep') and re.search(R['keep'], n)) for n in below) or (R.get('drop') and any(re.search(R['drop'], n) for n in below)):
            continue
        me = o.data.copy()
        me.transform(o.matrix_world)
        if o.matrix_world.determinant() < 0:
            me.flip_normals()
        sn = me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
        sn.data.foreach_set('vector', [x for c in me.corner_normals for x in c.vector])
        mats = [m.name if m else '-' for m in me.materials] or ['-']
        t = bmesh.new()
        t.from_mesh(me)
        junk = [f for f in t.faces if re.search(JUNK, mats[f.material_index]) or (R.get('drop') and re.search(R['drop'], mats[f.material_index]))]
        if R.get('dark'):
            gone = set(junk)
            junk += [f for f in t.faces if f not in gone and _texture_luminance(me, t, f) < R['dark']]
        if R.get('pick'):   # a scene of several wheels: keep the faces whose centre lies in (axis, lo, hi) of the import's own frame
            ax, lo, hi = R['pick']
            gone = set(junk)
            junk += [f for f in t.faces if f not in gone and not lo <= f.calc_center_median()['xyz'.index(ax)] <= hi]
        bmesh.ops.delete(t, geom=junk, context='FACES')
        for f in t.faces:
            f.material_index = len(names) + f.material_index
        names += mats
        t.to_mesh(me)
        t.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD)
    bm.faces.layers.int.new('kind')   # set later; made now, since a new layer invalidates face handles
    return bm, names


def _islands(bm):
    seen, out = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, grp = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            grp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        out.append(grp)
    return out


def _frame(bm):
    """Rotate and move so the axle is X and the wheel is centered on it; returns the lip radius."""
    pts = [v.co for v in bm.verts]
    lo, hi = Vector(map(min, *pts)), Vector(map(max, *pts))
    e = hi - lo
    # The axle is the axis the other two are round about (equal extents), and the shortest.
    a = min(range(3), key=lambda i: abs(e[(i + 1) % 3] - e[(i + 2) % 3]) + (0 if e[i] < min(e[(i + 1) % 3], e[(i + 2) % 3]) else 9))
    c = (lo + hi) / 2
    rot = {0: Matrix.Identity(4), 1: Matrix.Rotation(-math.pi / 2, 4, 'Z'), 2: Matrix.Rotation(math.pi / 2, 4, 'Y')}[a]
    _xform(bm, rot @ Matrix.Translation(-c))
    return max(_rad(v.co) for v in bm.verts)


def _xform(bm, m):
    """Transform the mesh and its authored normals together. A mirror reverses every face's
    winding, so the faces are reversed back: winding and authored normals must agree, or the
    hidden face cull and the shading turn the whole wheel inside out (every face wound toward
    the back is invisible in the game, which draws the wheel single sided)."""
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    if m.determinant() < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    n3 = m.to_3x3().inverted().transposed()
    sn = bm.loops.layers.float_vector['src_normal']
    for f in bm.faces:
        for l in f.loops:
            l[sn] = (n3 @ l[sn]).normalized()
    bm.normal_update()


class _Island:
    def __init__(self, faces, L):
        self.faces = faces
        vs = {v for f in faces for v in f.verts}
        rs = [_rad(v.co) for v in vs]
        xs = [v.co.x for v in vs]
        self.rmin, self.rmax = min(rs) / L, max(rs) / L
        self.xmin, self.xmax = min(xs), max(xs)
        self.thick = (self.xmax - self.xmin) / L
        self.tris = sum(len(f.verts) - 2 for f in faces)
        c = sum((f.calc_center_median() for f in faces), Vector()) / len(faces)
        self.angle = math.atan2(c.z, c.y)
        self.kind = None


def _classify(bm, L, names, R):
    """Every island's kind: 'decal' (flat), 'ring' (lip and barrel), 'cap' (in the hub), 'bolt'
    (small, out on the dish), else 'face'. Bolts are confirmed as circles afterwards."""
    isl = [_Island(g, L) for g in _islands(bm)]
    for i in isl:
        if i.rmax < 0.2 and i.thick < 0.02 or i.thick < 0.006:
            i.kind = 'decal'      # logo planes, badge glass, pinstripes
        elif i.rmin > 0.6 and i.rmax > 0.95:
            i.kind = 'ring'
        elif i.rmax < 0.35 and i.rmin < 0.2:
            i.kind = 'cap'
        elif i.rmin > 0.55 and i.rmax < 0.97 and i.rmax - i.rmin < 0.12:
            i.kind = 'bolt'      # or a flange ring the bolts sit on: the circle test tells, below
        else:
            i.kind = 'face'
    return isl


def _bolt_circles(isl):
    """The 'bolt' islands grouped into circles: islands sorted by their circle radius, split at
    gaps over 0.015 of the lip radius; a group of fewer than six is not a circle (its islands go
    back to being face). Returns the groups, frontmost first.

    A flange ring the bolts sit on has their radius too, so it joined their circle and went with
    the donor's hardware (the ERA3's, 5,000 triangles, until 2026-10-28). An island that runs all
    the way round is a flange, never a bolt: it goes back to being face first."""
    for i in isl:
        if i.kind == 'bolt' and len({int((math.atan2(c.z, c.y) + math.pi) / (2 * math.pi) * 36) % 36 for f in i.faces for c in [f.calc_center_median()]}) >= 32:
            i.kind = 'face'
    bolts = sorted((i for i in isl if i.kind == 'bolt'), key=lambda i: (i.rmin + i.rmax) / 2)
    groups, cur = [], []
    for i in bolts:
        if cur and (i.rmin + i.rmax) / 2 - (cur[-1].rmin + cur[-1].rmax) / 2 > 0.015:
            groups.append(cur)
            cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    circles = []
    for g in groups:
        if len(g) >= 6 or sum(i.tris for i in g) > 4000:
            circles.append(g)
        else:
            for i in g:
                i.kind = 'face'
    return sorted(circles, key=lambda g: -max(i.xmax for i in g))


def _bolt_circle(circ, L):
    """House bolt placement for one circle: (angles, radius, head radius, x base, x top). The
    count is the number of peaks of the circle's angular histogram (a shattered bolt is many
    islands at one angle); None when there is no clean count."""
    n = 720
    hist = [0.0] * n
    for i in circ:
        for f in i.faces:
            c = f.calc_center_median()
            hist[int((math.atan2(c.z, c.y) + math.pi) / (2 * math.pi) * n) % n] += f.calc_area()
    # Smooth over about 2 degrees and pick the peaks.
    sm = [sum(hist[(k + d) % n] for d in range(-2, 3)) for k in range(n)]
    # A peak stands well over the circle's mean (a plain flange ring has none).
    floor = 1.3 * sum(sm) / n
    peaks = [k for k in range(n) if sm[k] > floor and all(sm[k] > sm[(k - d) % n] for d in range(1, 7)) and all(sm[k] >= sm[(k + d) % n] for d in range(1, 7))]
    if len(peaks) < 3 or len(peaks) > BOLT_MAX:
        return None
    angles = [(k + 0.5) / n * 2 * math.pi - math.pi for k in peaks]
    r = sum((i.rmin + i.rmax) / 2 for i in circ) / len(circ) * L
    # A head wider than it is tall: real bolt heads are 8 to 10 mm across and stand 2 to 3 mm proud.
    head = max(0.016 * L, min(0.45 * (max(i.rmax for i in circ) - min(i.rmin for i in circ)) * L, 0.025 * L))
    top = max(i.xmax for i in circ)
    return angles, r, head, top - 0.012 * L, top


def _hex_heads(bm, mat, circle):
    """House bolts: a hex head (top and sides, 18 triangles) at each angle of the circle. Each
    head's sides run down into the surface below it (the donor's bolt stood on a washer that went
    with its hardware, or in a counterbore over its hole), so no head floats over the face: rays
    down from the head's center and corners, the median of what they meet within 3.5 cm."""
    angles, r, h, base, top = circle
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    tree = BVHTree.FromBMesh(bm) if bm.faces else None
    for a in angles:
        cy, cz = r * math.cos(a), r * math.sin(a)
        hits = sorted(hit.x for hit in (tree.ray_cast(Vector((top + 0.005, cy + d * math.cos(a + 2 * math.pi * k / BOLT_SEG), cz + d * math.sin(a + 2 * math.pi * k / BOLT_SEG))), Vector((-1, 0, 0)), 0.035)[0]
                                        for d, k in [(0, 0)] + [(0.95 * h, k) for k in range(BOLT_SEG)]) if hit is not None) if tree else []
        b = min(base, hits[len(hits) // 2] - 0.002) if hits else base
        ring_t = [bm.verts.new((top, cy + h * math.cos(a + 2 * math.pi * k / BOLT_SEG), cz + h * math.sin(a + 2 * math.pi * k / BOLT_SEG))) for k in range(BOLT_SEG)]
        ring_b = [bm.verts.new((b, cy + h * math.cos(a + 2 * math.pi * k / BOLT_SEG), cz + h * math.sin(a + 2 * math.pi * k / BOLT_SEG))) for k in range(BOLT_SEG)]
        faces = [bm.faces.new(ring_t)]
        for k in range(BOLT_SEG):
            faces.append(bm.faces.new((ring_b[k], ring_b[(k + 1) % BOLT_SEG], ring_t[(k + 1) % BOLT_SEG], ring_t[k])))
        for f in faces:
            f.material_index = mat
            f[own] = 1
            f.normal_update()
        if faces[0].normal.x < 0:
            faces[0].normal_flip()
        for f in faces[1:]:
            c = f.calc_center_median()
            if f.normal.dot(Vector((0, c.y - cy, c.z - cz))) < 0:
                f.normal_flip()


def _turned_faces(isl, L, sectors=120, full=112, dx=0.002, dr=0.01, edge=0.97):
    """The faces of a one-piece wheel's face island that are its lip, dish wall and barrel: the
    surfaces of revolution, told from the spokes by covering (nearly) every 3 degree sector around
    the axle at their own (x, r) cell (2 mm by 1 % of the lip; a cell borrows its neighbours along
    x, a sloped wall's faces straddle them), outside 0.6 of the lip radius (the hub is round too).
    Spoke tips cover a third to a half of the sectors, so they stay face and keep reaching the lip
    (at 10 degree sectors, twelve spokes of the Nt03 covered them all).

    It used to split at a radius: walking in from the lip, the first band whose front facing faces
    did not cover every angle. A step in the barrel behind the spokes covered the gaps between
    them, so the split ran down past the spoke tips, the lathe turned them away and the spokes
    ended centimeters short of the lip (2026-10-28)."""
    def sector(co):
        return int((math.atan2(co.z, co.y) + math.pi) / (2 * math.pi) * sectors) % sectors

    def cell(co):
        return (int(co.x // dx), int(_rad(co) / L // dr))

    cover, faces = {}, [f for i in isl if i.kind == 'face' for f in i.faces]
    for f in faces:
        s = sorted({sector(v.co) for v in f.verts})
        # The sectors the face spans: the circle less its largest gap between corners.
        gaps = [(s[(k + 1) % len(s)] - s[k]) % sectors or sectors for k in range(len(s))]
        k = max(range(len(s)), key=lambda k: gaps[k])
        span = {(s[(k + 1) % len(s)] + d) % sectors for d in range(sectors - gaps[k] + 1)} if len(s) > 1 else set(s)
        for co in [f.calc_center_median()] + [v.co for v in f.verts]:
            cover.setdefault(cell(co), set()).update(span)
    def turned(co):
        i, j = cell(co)
        return len(cover.get((i, j), set()) | cover.get((i - 1, j), set()) | cover.get((i + 1, j), set())) >= full

    # Center and every corner: where a spoke's fillet runs into the lip it stays face (its edge
    # overlaps the turned surface, which hides nothing), so the junction is not torn.
    out = {f for f in faces if _rad(f.calc_center_median()) > 0.6 * L and turned(f.calc_center_median()) and all(turned(v.co) for v in f.verts)}
    # Only what is joined to the lip edge (or, with the recipe's `turn`, to faces outside `edge` of the
    # lip) through turned faces: one profile is lathed, and a round
    # dish inside a ring of windows (the VCE), or the odd turned face among the pockets of a flat
    # band (the OZR), is not on it. The profile's rays jumped between the lip and such a dish, and
    # the lathe joined them with a cone through the face (2026-10-28).
    seen = {f for f in out if any(_rad(v.co) > edge * L for v in f.verts)}
    stack = list(seen)
    while stack:
        f = stack.pop()
        for e in f.edges:
            for g in e.link_faces:
                if g in out and g not in seen:
                    seen.add(g)
                    stack.append(g)
    return seen


def _profile_dist(co, prof):
    """Distance in the (x, r) plane from a point to the profile's polyline, m."""
    p = Vector((co.x, _rad(co)))
    best = 1e9
    for a, b in zip(prof, prof[1:]):
        ab = b - a
        n = ab.length_squared or 1e-12
        u = max(0.0, min(1.0, (p - a).dot(ab) / n))
        best = min(best, (p - (a + ab * u)).length)
    return best


def _turn_to_profile(parts, prof, KIND, rim, lip, names, mats, work, tol=0.002, keep=0.005):
    """A one-piece wheel's lathe (or one with the recipe's `turn`) replaces exactly the faces it reproduces: a face (turned or not)
    whose center and every corner lie within `tol` of the ring's measured profile goes to the
    ring (the lathe stands in its place), and a turned face off the profile goes back to the face.

    The turned test takes every surface of revolution out on the dish, and a flat band broken by
    pockets between the spokes is one (the OZR's outer band, two pockets a bay): the profile, by
    rays that pass through the pockets' holes in the ring, ran behind the band, so the lathe left
    it out and the pockets floated over the barrel in pieces. And on a smooth dish the test's
    cells flicker, so some of the dish was turned and some kept, the two a millimetre apart: the
    VCE's dish showed a sunburst of slivers (ame, uzu, sazanka, taki, 2026-10-28). Returns (parts,
    faces turned, faces given back)."""
    bm = _join(parts.values())
    kl = bm.faces.layers.int['kind']
    def on(f, d):
        return all(_profile_dist(co, prof) <= d for co in [f.calc_center_median()] + [v.co for v in f.verts])
    # And a face of the barrel's inside (its normal toward the axle, so no spoke and no flange's face; its
    # center 6 cm or more behind the lip edge, so no pocket wall in the face) within `keep` is turned (or
    # stays turned) too: hisui's barrel has two skins 3.5 mm apart, the turned test took some of the inner
    # one's strips and the profile ran on the outer, so the rest stood in front of the lathe as shards.
    def radial(f):
        c = f.calc_center_median()
        r = _rad(c)
        return r > 0 and c.x < X_LIP - 0.06 and -(f.normal.y * c.y + f.normal.z * c.z) / r > 0.9
    def lathed(f):
        return on(f, tol) or radial(f) and on(f, keep)
    off = [f for f in bm.faces if f[kl] == KIND['ring'] and not lathed(f)]
    add = [f for f in bm.faces if f[kl] == KIND['face'] and f.material_index == rim and lathed(f)]
    if off or add:
        for f in off:
            f[kl] = KIND['face']
            f.material_index = rim
        for f in add:
            f[kl] = KIND['ring']
            f.material_index = lip
        for o in parts.values():
            bpy.data.objects.remove(o)
        parts = _kind_objects(bm, KIND, names, mats, work)
    bm.free()
    return parts, len(add), len(off)


def _face_sign(isl, L):
    """+1 when the wheel's face already points +X. A badge, its glass or lettering in the hub (the
    cap zone's decals) faces the front, so their side of the hub is the front; a wheel without
    them goes by the spokes' and hub's area weighted normals, which lean toward the front. Neither
    is sure (a flat face plate, a bore plug on the back), so every wheel is looked at, and the
    recipe's `face` settles it."""
    badges = [i for i in isl if i.kind == 'decal' and i.rmax < 0.2]
    hub = [v.co.x for i in isl if i.kind in ('face', 'cap') for f in i.faces for v in f.verts if _rad(v.co) < 0.3 * L]
    if badges and hub:
        bx = sum((i.xmin + i.xmax) / 2 for i in badges) / len(badges)
        return 1 if bx > (min(hub) + max(hub)) / 2 else -1
    vote = sum(f.normal.x * f.calc_area() for i in isl if i.kind in ('face', 'cap') for f in i.faces if _rad(f.calc_center_median()) < 0.9 * L)
    return 1 if vote >= 0 else -1


def house_tire(bm, mat, seg=TIRE_SEG):
    """The one tire every wheel wears: a lathed profile (rounded shoulders, slightly bulged
    sidewalls) from the bead on the face side around to the bead on the back, smooth shaded by its
    own normals. Faces are marked `own_normals`. Returns the faces made."""
    R, W, B = TIRE_R, TIRE_W, TIRE_R * BEAD
    h = R - B
    prof = [(W * 0.42, B - 0.004), (W * 0.5, B + 0.2 * h), (W * 0.52, B + 0.55 * h), (W * 0.49, R - 0.25 * h),
            (W * 0.42, R - 0.04 * h), (W * 0.3, R), (0, R)]
    prof += [(-x, r) for x, r in reversed(prof[:-1])]
    rings = []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        rings.append([bm.verts.new((x, r * math.cos(t), r * math.sin(t))) for x, r in prof])
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    made = []
    for i in range(seg):
        a, b = rings[i], rings[(i + 1) % seg]
        for k in range(len(prof) - 1):
            f = bm.faces.new((a[k], a[k + 1], b[k + 1], b[k]))
            f.material_index = mat
            f.smooth = True
            f[own] = 1
            made.append(f)
    bm.normal_update()
    for f in made:
        c = f.calc_center_median()
        out = Vector((0, c.y, c.z)).normalized() * 0.3 + Vector((math.copysign(0.7, c.x) if abs(c.x) > W * 0.4 else 0, 0, 0))
        if f.normal.dot(out) < 0:
            f.normal_flip()
    return made


def _house_cap(bm, mat, r, x):
    """A chrome disc over a hub nothing covers (the donor's cap was a logo decal): radius `r`, a
    little past the bore, its face at `x`, just proud of the hub's front. Its skirt is 4 mm deep,
    or runs on down to the hub when the hub under its rim sits deeper than that (the front of
    the hub `x` was measured on may have gone in the cull): a cap never floats over the hub."""
    seg = 24
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    tree = BVHTree.FromBMesh(bm) if bm.faces else None
    hits = sorted(hit.x for hit in (tree.ray_cast(Vector((x + 0.005, 0.95 * r * math.cos(a), 0.95 * r * math.sin(a))), Vector((-1, 0, 0)), 0.035)[0]
                                    for a in (2 * math.pi * k / 8 for k in range(8))) if hit is not None) if tree else []
    deep = x - hits[len(hits) // 2] if hits else 0
    skirt = deep + 0.002 if deep > 0.004 else 0.004
    c = bm.verts.new((x, 0, 0))
    ring = [bm.verts.new((x, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg))) for k in range(seg)]
    back = [bm.verts.new((x - skirt, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg))) for k in range(seg)]
    for k in range(seg):
        for f in (bm.faces.new((c, ring[k], ring[(k + 1) % seg])), bm.faces.new((back[k], back[(k + 1) % seg], ring[(k + 1) % seg], ring[k]))):
            f.material_index = mat
            f[own] = 1
            f.smooth = len(f.verts) == 4
            f.normal_update()
            want = Vector((1, 0, 0)) if len(f.verts) == 3 else Vector((0, f.calc_center_median().y, f.calc_center_median().z))
            if f.normal.dot(want) < 0:
                f.normal_flip()


def _cap_profile(faces, L, planes=24, stations=48, fill=False):
    """A center cap's (x, r) profile from the axle out to its edge and down its skirt: rays down -X
    at `stations` radii, each station the median of its hits over `planes` angles round the axle,
    so a maker's logo or lettering, raised or engraved, on a fraction of the angles at any radius
    does not count and the cap's own shape (dome, step, flat face) does. A cap ring round an open
    bore starts where the rays first hit, unless `fill` closes the bore at the ring's inner face. None
    when too few stations hit."""
    vs = list({v for f in faces for v in f.verts})
    idx = {v: k for k, v in enumerate(vs)}
    tree = BVHTree.FromPolygons([v.co for v in vs], [[idx[v] for v in f.verts] for f in faces])
    top = max(v.co.x for v in vs) + 0.02
    rmax = max(_rad(v.co) for v in vs)
    pts = []
    for k in range(stations + 1):
        r = rmax * 0.995 * k / stations
        hits = []
        for j in range(planes):
            ph = 2 * math.pi * (j + 0.5) / planes
            hit = tree.ray_cast(Vector((top, r * math.cos(ph), r * math.sin(ph))), Vector((-1, 0, 0)))[0]
            if hit is not None:
                hits.append(hit.x)
        if len(hits) * 2 > planes:
            pts.append(Vector((sorted(hits)[len(hits) // 2], r)))
    if len(pts) < 2:
        return None
    if fill and pts[0].y > 0:
        pts.insert(0, Vector((pts[0].x, 0)))
    # Out to the edge of the faces it replaces, where the rays stopped short (an opening under them).
    if pts[-1].y < 0.98 * rmax:
        pts.append(Vector((pts[-1].x, rmax)))
    edge = pts[-1].y
    # Down the skirt to the hub, at most 12 mm (a moulded hub's faces run on to its back).
    skirt = max(min((v.co.x for v in vs if _rad(v.co) > 0.85 * edge), default=pts[-1].x), pts[-1].x - 0.012)
    if skirt < pts[-1].x - 0.001:
        pts.append(Vector((skirt, edge)))
    return _thin(pts, 12, 2e-4)


def _covers_axle(faces):
    """True when one of the faces' triangles (a fan for a bigger polygon) contains the axle, seen down X."""
    from mathutils.geometry import intersect_point_tri_2d
    org = Vector((0, 0))
    for f in faces:
        vs = [Vector((v.co.y, v.co.z)) for v in f.verts]
        for k in range(1, len(vs) - 1):
            if intersect_point_tri_2d(org, vs[0], vs[k], vs[k + 1]):
                return True
    return False


def clean_cap(o, pick=None, seg=CAP_SEG, fill=False, edge=None):
    """Turn the wheel's center cap from its own profile: the faces `pick(face, L)` chooses (by
    default those already `RimCap`) go and a lathe of their median profile takes their place, in
    `RimCap`, so the cap keeps its shape and loses the donor maker's logo. The rest of the mesh
    keeps its custom normals. Faces that start outside 0.15 of the lip are lug nuts and go back to Chrome.
    `fill` closes a cap ring's open center (the recipe's `cap_fill`: the whole center takes the cap's paint).
    `edge` (m, the recipe's `cap_edge`) is the cap's own radius where the piece classified as cap is the
    whole hub round it: the lathe still turns all of it, a pick's pieces that run round the axle (a hub
    ring or bowl, not a nut) included, but only inside `edge` is `RimCap`; outside is the face's `Rim`.
    Returns the profile's point count, 0 when there was no cap."""
    L = TIRE_R * BEAD
    me = o.data
    for n in ('RimCap',):
        if n not in [m.name for m in me.materials]:
            me.materials.append(shared_mat(n))
    cap_i = [m.name for m in me.materials].index('RimCap')
    default_pick = pick is None
    pick = pick or (lambda f, L: f.material_index == cap_i)
    _carry_normals(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    faces = [f for f in bm.faces if pick(f, L)]
    # Only the piece that reaches in to the bore is the cap. A donor's lug nuts (inside 0.35 of the
    # lip, so classified as cap too), or the rest of a scan's hub, sit in pieces of their own outside
    # 0.15: left in the pick, the cap's profile ran out to the outermost of them as a flat disc
    # (kazakiri's 57 mm cap over its recessed hub and its nuts, kaminari's 62 mm over a bare hub).
    # The nuts (raised 6 mm or more) go, as the house nuts replace them; the flat remainder is the hub: Rim.
    if default_pick and faces:
        seen, comps = set(), []
        for f in faces:
            if f in seen:
                continue
            seen.add(f)
            stack, comp = [f], []
            while stack:
                g = stack.pop()
                comp.append(g)
                for v in g.verts:
                    for h in v.link_faces:
                        if h not in seen and h.material_index == cap_i:
                            seen.add(h)
                            stack.append(h)
            comps.append(comp)
        inner = [c for c in comps if min(_rad(v.co) for g in c for v in g.verts) < 0.15 * L]
        if inner and len(inner) < len(comps):
            if 'Rim' not in [m.name for m in me.materials]:
                me.materials.append(shared_mat('Rim'))
            rim_i = [m.name for m in me.materials].index('Rim')
            nuts = []
            for c in comps:
                if c in inner:
                    continue
                # With the cap's own edge given, a piece that runs round the axle is the hub ring or bowl
                # the cap sits in (natsu's ring, hari's bowl): turned with the cap and painted Rim past the
                # edge. Taken for a nut it went, and left a hole round the cap.
                if edge and len({int((math.atan2(v.co.z, v.co.y) + math.pi) / (2 * math.pi) * 36) % 36 for g in c for v in g.verts}) >= 34:
                    inner.append(c)
                    continue
                xs = [v.co.x for g in c for v in g.verts]
                if max(xs) - min(xs) > 0.006:
                    nuts += c
                else:
                    for g in c:
                        g.material_index = rim_i
            bmesh.ops.delete(bm, geom=nuts, context='FACES')
            faces = [f for c in inner for f in c]
    # A cap reaches in to the bore; a ring of lug nuts round the hub (inside 0.35 of the lip, so
    # classified as cap) starts outside 0.15.
    # A flat disc triangulated without a center vertex (himawari's 60 triangles, radius 0.15 of the
    # lip on the dot) has no vertex inside 0.15 either, but one of its triangles holds the axle: that is a cap.
    lugs = bool(faces) and min(_rad(v.co) for f in faces for v in f.verts) > 0.15 * L and not _covers_axle(faces)
    prof = _cap_profile(faces, L, fill=fill) if faces and not lugs else None
    if prof and edge:
        # The turned hub ends in a 3 mm flange at its skirt's foot, tucked under the face round it: a hub
        # plate that sits with clearance in the spokes' ring (minamo's 1.4 mm) left a slot whose floor
        # only steep views see, so the hidden face cull took it and the slot showed through the wheel.
        prof.append(Vector((prof[-1].x, prof[-1].y + 0.003)))
        # A ring of the profile on the cap's edge, so the paint stops on it: where the profile first
        # crosses `edge` going out (a step at `edge` keeps its wall in the cap).
        for k in range(len(prof) - 1):
            a, b = prof[k], prof[k + 1]
            if a.y < edge < b.y - 1e-5:
                prof.insert(k + 1, a.lerp(b, (edge - a.y) / (b.y - a.y)))
                break
    if prof:
        bmesh.ops.delete(bm, geom=faces, context='FACES')
        made = _lathe(bm, prof, cap_i, seg, ordered=True)
        # The lathe's first ring sits on the axle: one vertex, its quads triangles.
        bmesh.ops.remove_doubles(bm, verts=list({v for f in made for v in f.verts if _rad(v.co) < 1e-5}), dist=1e-5)
        if edge and max(q.y for q in prof) > edge + 1e-5:
            if 'Rim' not in [m.name for m in me.materials]:
                me.materials.append(shared_mat('Rim'))
            rim_i = [m.name for m in me.materials].index('Rim')
            for f in made:
                if f.is_valid and max(_rad(v.co) for v in f.verts) > edge + 1e-5:
                    f.material_index = rim_i
    elif faces:
        # Lug nuts: hardware, which stays Chrome.
        if 'Chrome' not in [m.name for m in me.materials]:
            me.materials.append(shared_mat('Chrome'))
        for f in faces:
            f.material_index = [m.name for m in me.materials].index('Chrome')
    sn = bm.loops.layers.float_vector['src_normal']
    for f in bm.faces:
        f.smooth = True
    out = [l[sn].copy() if l[sn].length > 0.5 else f.normal.copy() for f in bm.faces for l in f.loops]
    bm.to_mesh(me)
    bm.free()
    me.normals_split_custom_set(out)
    me.attributes.remove(me.attributes['src_normal'])
    remap_materials(o)
    return len(prof) if prof else 0


def hub_cap(o, cut=None, planes=24, step=0.005, most=0.4):
    """For a wheel whose cap is moulded into its face (no `RimCap` piece): the hub's round center,
    from the axle out to where lug holes, nuts or spokes begin, becomes a turned `RimCap` like any
    other cap, so it takes the cap's paint and loses the logo cast into it (the Brabus "B", the
    XR4's badge). Rays down -X at stations `step` of the lip radius apart over `planes` angles: the
    center stays round while 90 % of them hit and their spread is under 3 mm; a logo, cast in or
    engraved, breaks both only near the axle, so inside 0.12 half the rays hitting will do. Returns the cap's radius over the lip
    radius, 0 when the hub is open or not round (the bore shows, or spokes reach the axle). `cut`
    (over the lip radius) sets the cap's radius instead: the recipe's `cap`, for a hub whose
    opening under a dropped logo cap is wider than the round test reaches."""
    L = TIRE_R * BEAD
    me = o.data
    names = [m.name for m in me.materials]
    if 'RimCap' in names:
        return 0
    keep = {names.index(n) for n in ('Rim', 'Black') if n in names}
    cand = [p for p in me.polygons if p.material_index in keep and max(math.hypot(me.vertices[i].co.y, me.vertices[i].co.z) for i in p.vertices) < most * L]
    if not cand:
        return 0
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in cand])
    top = max(me.vertices[i].co.x for p in cand for i in p.vertices) + 0.02
    explicit = bool(cut)   # the recipe's own radius stands, however small a cap it is
    if cut:
        cut *= L
    for k in range(0 if cut else int(most / step)):
        r = k * step * L
        hits = sorted(h.x for h in (tree.ray_cast(Vector((top, r * math.cos(2 * math.pi * (j + 0.5) / planes), r * math.sin(2 * math.pi * (j + 0.5) / planes))), Vector((-1, 0, 0)))[0] for j in range(planes)) if h is not None)
        if len(hits) * 2 <= planes or r > 0.12 * L and (len(hits) < 0.9 * planes or hits[int(0.9 * len(hits))] - hits[int(0.1 * len(hits))] > 0.003):
            break
        cut = r
    if not cut or cut < 0.12 * L and not explicit:
        return 0
    rim = cut * 0.97
    clean_cap(o, lambda f, L: f.material_index in keep and all(_rad(v.co) < rim for v in f.verts))
    return cut / L


def _is_lathe(cos, L, seg=RING_SEG):
    """A face of the turned lip and barrel, by its corners: a quad on the lathe's segment angles, out past the dish."""
    c = sum(cos, Vector()) / len(cos)
    return len(cos) == 4 and _rad(c) > 0.5 * L and all(abs(a - round(a)) < 1e-3 for a in (math.atan2(v.z, v.y) / (2 * math.pi) * seg for v in cos))


def retrofit_hub(name):
    """Bring a wheel built before 2026-10-28's `RimLip` / `RimCap` up to date without its donor:
    the turned lip and barrel go to `RimLip` (the object's `lip` records how it shipped, chrome or
    rim) and the Chrome center cap (Chrome within 0.45 of the lip radius: the bolts sit outside
    0.55) is turned clean by `clean_cap`. Returns (lip, lathe faces, cap profile points)."""
    o = bpy.data.objects[f'wheels.wheel_{name}']
    me = o.data
    if 'RimLip' not in [m.name for m in me.materials]:
        me.materials.append(shared_mat('RimLip'))
    names = [m.name for m in me.materials]
    L = TIRE_R * BEAD
    lathe = [p for p in me.polygons if names[p.material_index] in ('Rim', 'Chrome') and _is_lathe([me.vertices[i].co for i in p.vertices], L)]
    chrome = sum(names[p.material_index] == 'Chrome' for p in lathe)
    lip = 'chrome' if chrome * 2 > len(lathe) else 'rim'
    for p in lathe:
        p.material_index = names.index('RimLip')
    o['lip'] = lip
    ci = names.index('Chrome') if 'Chrome' in names else -1
    pts = clean_cap(o, lambda f, L: f.material_index == ci and _rad(f.calc_center_median()) < 0.45 * L)
    return lip, len(lathe), pts


# House lug nuts (2026-10-28): the game draws one lug nut model on every wheel (src/render/car/lugNuts.ts) at
# the circle measured here, so the donor's own nuts go. In shares of the lip radius unless marked.
LUG = {
    'ext': 0.46,          # the depth image covers the hub out to here
    'step': 0.004,        # its pixel
    'tol': 0.003,         # m, a pixel this far off its ring's median depth is a nut (proud) or a pocket (sunk)
    'band': (0.13, 0.32), # a lug's center lies between: inside is the cap, outside rivets and spoke windows
    'blob': (0.02, 0.1),  # a lug's hole, pocket or nut radius (rivets are smaller, windows larger)
    'counts': (6, 5, 4),
    'spacing': 4.0,       # deg, how far a lug may sit off its equal spacing
    'size': (0.010, 0.016),  # m, the nut's seat radius: covers the hole it sits on, within a nut's sizes
}


def _depth_image(o, L):
    """The first surface rays down -X meet over the hub, in a square grid: the x hit, -9 for a ray that
    passes through, None outside the disc. The tire is not in it."""
    me = o.data
    names = [m.name for m in me.materials]
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons if names[p.material_index] != 'Tire'])
    ext, step = LUG['ext'], LUG['step']
    N = int(2 * ext / step) + 1
    X = [[None] * N for _ in range(N)]
    for i in range(N):
        y = (-ext + i * step) * L
        for j in range(N):
            z = (-ext + j * step) * L
            if y * y + z * z <= (ext * L) ** 2:
                h = tree.ray_cast(Vector((0.3, y, z)), Vector((-1, 0, 0)))[0]
                X[i][j] = h.x if h else -9
    return X


def _lug_blobs(X):
    """Candidate lugs: closed blobs of pixels proud of their ring's median depth (a nut), sunk below it (a
    pocket) or open (a through hole), each with its center, radius and kind; and the ring medians."""
    ext, step, tol = LUG['ext'], LUG['step'], LUG['tol']
    N = len(X)
    ring = lambda i, j: int(math.hypot(-ext + i * step, -ext + j * step) / 0.005)
    bins = {}
    for i in range(N):
        for j in range(N):
            if X[i][j] is not None and X[i][j] != -9:
                bins.setdefault(ring(i, j), []).append(X[i][j])
    med = {k: sorted(v)[len(v) // 2] for k, v in bins.items()}
    masks = {k: [[False] * N for _ in range(N)] for k in ('nut', 'pocket', 'hole')}
    for i in range(N):
        for j in range(N):
            x = X[i][j]
            if x is None:
                continue
            s = med.get(ring(i, j))
            kind = 'hole' if x == -9 else None if s is None else 'nut' if x > s + tol else 'pocket' if x < s - tol else None
            if kind:
                masks[kind][i][j] = True
    out = []
    for kind, m in masks.items():
        seen = set()
        for i in range(N):
            for j in range(N):
                if not m[i][j] or (i, j) in seen:
                    continue
                stack, px = [(i, j)], []
                seen.add((i, j))
                while stack:
                    a, b = stack.pop()
                    px.append((a, b))
                    for c in range(a - 1, a + 2):
                        for d in range(b - 1, b + 2):
                            if 0 <= c < N and 0 <= d < N and m[c][d] and (c, d) not in seen:
                                seen.add((c, d))
                                stack.append((c, d))
                ys = [-ext + a * step for a, b in px]
                zs = [-ext + b * step for a, b in px]
                cy, cz = sum(ys) / len(ys), sum(zs) / len(zs)
                rad = max(math.hypot(y - cy, z - cz) for y, z in zip(ys, zs)) + step / 2
                r = math.hypot(cy, cz)
                closed = max(math.hypot(y, z) for y, z in zip(ys, zs)) < ext - 0.02
                if closed and LUG['band'][0] < r < LUG['band'][1] and LUG['blob'][0] < rad < LUG['blob'][1] and len(px) * step * step > 0.3 * math.pi * rad * rad:
                    out.append({'y': cy, 'z': cz, 'r': r, 'a': math.atan2(cz, cy), 'rad': rad, 'kind': kind, 's': med.get(int(r / 0.005))})
    return out


def _lug_circles(blobs):
    """Every set of 4, 5 or 6 blobs at one radius (within 0.02) and equal angles (within LUG spacing), the
    highest count an anchor allows, one per radius."""
    found = []
    for anchor in blobs:
        for n in LUG['counts']:
            members = [anchor]
            for k in range(1, n):
                want = anchor['a'] + 2 * math.pi * k / n
                near = [c for c in blobs if abs(c['r'] - anchor['r']) < 0.02 and abs((c['a'] - want + math.pi) % (2 * math.pi) - math.pi) < math.radians(LUG['spacing'])]
                if not near:
                    break
                members.append(min(near, key=lambda c: abs(c['r'] - anchor['r'])))
            else:
                r = sum(m['r'] for m in members) / n
                # One per circle: the same count, radius and angles (two circles at one radius, the bosses
                # between the holes, are both kept).
                same = lambda c: c['n'] == n and abs(c['r'] - r) < 0.01 and abs((n * (c['members'][0]['a'] - anchor['a']) + math.pi) % (2 * math.pi) - math.pi) < n * math.radians(LUG['spacing'])
                if not any(same(c) for c in found):
                    found.append({'n': n, 'r': r, 'members': members, 'spread': sum(abs(m['r'] - r) for m in members)})
                break
    return found


def _seat_x(o, centers, size, ring=1.3):
    """Where a nut's base sits: the median, over the lugs, of the surface just round each one (the upper
    quartile of 16 rays down -X on a circle `ring` (1.3) seat radii from its center, `centers` (y, z) in m; through
    kasumi's mesh face the median sank its nuts 21 mm). The ring's median depth over the
    whole circle ran up spokes and down windows: a nut stood 6 mm proud of the face round its hole on yari."""
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons if names[p.material_index] != 'Tire'])
    xs = []
    for cy, cz in centers:
        hits = sorted(h.x for h in (tree.ray_cast(Vector((0.3, cy + ring * size * math.cos(2 * math.pi * k / 16), cz + ring * size * math.sin(2 * math.pi * k / 16))), Vector((-1, 0, 0)))[0] for k in range(16)) if h is not None)
        if hits:
            xs.append(hits[(3 * len(hits)) // 4])   # the upper quartile: rays through a mesh face's openings fall past the seat
    return sorted(xs)[len(xs) // 2] if xs else None


def _recess(o, centers, x, size, tree=None):
    """Where the nuts seat when the lugs sit down in recesses (tomoe's 44 mm tubes, 2026-10-28): the
    seat `_seat_x` finds is the face round the recess, so the house nuts stood on top of it. The floor
    is the upper quartile of 16 rays down -X on a ring 0.6 seat radii from each lug's center (0.8 where
    the stud hole fills that one; the hole itself lets the rays through), the median over the lugs. A
    floor more than 2 mm below the face seat `x` means a recess: the nut seats on the floor, and its
    radius is cut to the recess wall, the first 1 mm radius where the surface rises 3 mm above the
    floor (less half a mm), never under 6 mm, so the nut fits down in it. Returns (x, size) or None
    for a lug on a flat face (a dish under 2 mm is the nut's own washer). The floor is at most 50 mm
    under the face: past that the rays found the barrel behind a through hole."""
    me = o.data
    if tree is None:
        names = [m.name.split('.')[0] for m in me.materials]
        tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons if names[p.material_index] != 'Tire'])

    def ring(r):
        per = []
        for cy, cz in centers:
            hits = sorted(h.x for h in (tree.ray_cast(Vector((0.3, cy + r * math.cos(2 * math.pi * k / 16), cz + r * math.sin(2 * math.pi * k / 16))), Vector((-1, 0, 0)))[0] for k in range(16)) if h is not None)
            if hits:
                per.append(hits[(3 * len(hits)) // 4])
        return sorted(per)[len(per) // 2] if len(per) * 2 > len(centers) else None
    floor = ring(0.6 * size)
    if floor is None:
        floor = ring(0.8 * size)
    if floor is None or x - floor < 0.002 or x - floor > 0.05:
        return None
    wall = size
    for k in range(int(0.6 * size / 0.001), int(1.5 * size / 0.001)):
        h = ring(k * 0.001)
        if h is not None and h > floor + 0.003:
            wall = k * 0.001
            break
    return floor, max(min(size, wall - 0.0005), 0.006)


def _phase_gap(c, deg):
    """How far a lug circle's first lug is from `deg` (the catalog's phase, atan2(-y, z)), modulo the spacing, in degrees."""
    n = c['n']
    ph = math.atan2(sum(math.sin(n * math.atan2(-m['y'], m['z'])) for m in c['members']), sum(math.cos(n * math.atan2(-m['y'], m['z'])) for m in c['members'])) / n
    return abs(((ph - math.radians(deg)) * n + math.pi) % (2 * math.pi) - math.pi) / n * 180 / math.pi


def fit_lugs(o, want=None):
    """Measure the wheel's lug circle and make way for the house nuts: the donor's nuts (Chrome, or face
    standing proud of the hub within a lug's radius) go, and the object's `lugs` property (JSON, the
    catalog's `WheelLugs`) records the circle in the GLB's own frame (glTF: y up is Blender z, z is
    -Blender y): count, radius r (m), the first nut's angle phase (rad, atan2(z, y)), the seat's x (m,
    the surface round the lugs, `_seat_x`, or the floor of a recess they sit in, `_recess`) and the seat radius size (m).

    The lugs are holes, pockets or nuts in a depth image of the hub (`_lug_blobs`) on a circle of 4 to 6
    (`_lug_circles`); the innermost circle wins, since decorative windows and spoke gaps sit further
    out. `want` is the recipe's `lugs`: 0 for none (a solid face or a cap hides them), or (count, r) to
    take the circle of that count nearest that radius where the innermost is a decoration, with an optional
    third item, a dict, for what the measurement cannot tell: `phase` (deg, in the catalog's frame) takes the
    circle of that count and radius (within 0.02) whose first lug is nearest that angle (modulo the spacing),
    where two circles share a radius, a dual drilled hub (zan: five stud holes and five bores between them);
    `seat` (m) seats the nuts on the surface on a ring of that radius round each lug and sets the washer to
    it, where the floor `_recess` finds is not the seat (a countersink's cone, a ledge above a deeper tube:
    tsume, yoake); `x` (m) sets the seat's x outright, where the rays round a lug find the wall of its pocket, not the ledge the nut sits on (kazakiri); `at` (deg, the catalog's phase of the first lug) places the circle from the recipe's count and
    r without measuring it, for a hub the depth image cannot read (asahi), with `rad` the lug's radius over the lip. Returns the circle as (count, r over the lip, kind) or None."""
    L = TIRE_R * BEAD
    if 'lugs' in o.keys():
        del o['lugs']
    if want == 0:
        return None
    opt = want[2] if want and len(want) > 2 else {}
    if opt.get('at') is not None:   # a circle the depth image cannot find (the RPF1's pockets: a cap over their inner edge, one split by a floor hole): count and radius from the recipe, the first lug at `at` degrees (the catalog's phase), each lug opt['rad'] (share of the lip, 0.06) wide
        n = want[0]
        pts = [math.radians(opt['at']) + 2 * math.pi * k / n for k in range(n)]
        circles = [{'n': n, 'r': want[1], 'spread': 0, 'members': [{'y': -want[1] * math.sin(a), 'z': want[1] * math.cos(a), 'r': want[1], 'a': math.atan2(want[1] * math.cos(a), -want[1] * math.sin(a)),
                                                                    'rad': opt.get('rad', 0.06), 'kind': 'pocket', 's': None} for a in pts]}]
    else:
        circles = _lug_circles(_lug_blobs(_depth_image(o, L)))
    if opt.get('at') is None and want:
        circles = sorted((c for c in circles if c['n'] == want[0]), key=lambda c: abs(c['r'] - want[1]))
        if 'phase' in opt:
            near = [c for c in circles if abs(c['r'] - want[1]) < 0.02]
            circles = sorted(near, key=lambda c: _phase_gap(c, opt['phase']))
    elif opt.get('at') is None:
        # At one radius a through hole is the surest lug, a nut standing proud the least (a raised boss looks the same).
        circles.sort(key=lambda c: (round(c['r'] / 0.03), ('hole', 'pocket', 'nut').index(c['members'][0]['kind']), c['spread']))
    if not circles:
        return None
    c = circles[0]
    n, members = c['n'], c['members']
    # The n-fold circular mean of the members' angles: the first nut's angle, off the noise of any one.
    phase = math.atan2(sum(math.sin(n * m['a']) for m in members), sum(math.cos(n * m['a']) for m in members)) / n
    seats = sorted(m['s'] for m in members if m['s'] is not None)
    rad = sorted(m['rad'] for m in members)[len(members) // 2] * L
    size = min(max(rad * 1.05, LUG['size'][0]), LUG['size'][1])
    x = seats[len(seats) // 2] if seats else _seat_x(o, [(m['y'] * L, m['z'] * L) for m in members], size)
    if opt.get('x') is not None:
        x = opt['x']
    # The donor's nuts: Chrome hardware within each lug's radius, or face standing proud of the seat within
    # what the house nut covers (a wider cut would open the face round it).
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]   # Chrome.001 in a file the set was appended to
    _carry_normals(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    gone = []
    xcut = None
    if opt.get('seat'):   # a nut seated on a ledge down in a pocket (yoake): the donor's nut, tall slivers of its flange and body included, goes down to that seat, not just what stands proud of the face
        xcut = _seat_x(o, [(m['y'] * L, m['z'] * L) for m in members], opt['seat'], 1.0)
    for f in bm.faces:
        mat = names[f.material_index]
        if mat not in ('Chrome', 'Rim', 'Black'):
            continue
        p = f.calc_center_median()
        reach = [(math.hypot(p.y - m['y'] * L, p.z - m['z'] * L), m['rad'] * L * 1.1) for m in members]
        if mat == 'Chrome':
            hit = any(d < cr for d, cr in reach)
        elif xcut is not None:
            hit = max(v.co.x for v in f.verts) > xcut + 0.003 and any(d < 1.1 * opt['seat'] for d, cr in reach)
        else:
            hit = p.x > x + 0.0015 and all(v.co.x > x + 0.0005 for v in f.verts) and any(d < 0.9 * size for d, cr in reach)
        if hit:
            gone.append(f)
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    sn = bm.loops.layers.float_vector['src_normal']
    out = [l[sn].copy() if l[sn].length > 0.5 else f.normal.copy() for f in bm.faces for l in f.loops]
    bm.to_mesh(me)
    bm.free()
    me.normals_split_custom_set(out)
    me.attributes.remove(me.attributes['src_normal'])
    remap_materials(o)
    by, bz = c['r'] * L * math.cos(phase), c['r'] * L * math.sin(phase)
    x = _seat_x(o, [(m['y'] * L, m['z'] * L) for m in members], size) or x
    x, size = _recess(o, [(m['y'] * L, m['z'] * L) for m in members], x, size) or (x, size)
    if opt.get('seat'):
        size = opt['seat']
        x = _seat_x(o, [(m['y'] * L, m['z'] * L) for m in members], size, 1.0) or x
    if opt.get('x') is not None:
        x = opt['x']
    o['lugs'] = json.dumps({'count': n, 'r': round(c['r'] * L, 5), 'phase': round(math.atan2(-by, bz), 5), 'x': round(x, 5),
                            'size': round(size, 5)})
    return n, round(c['r'], 3), members[0]['kind'], len(gone)


def _ring_profile(o, L, planes=16, rays=480):
    """The lip and barrel's visible surface as (x, r) points from the lip edge inward and back:
    rays from a viewpoint in front of the wheel, swept in the plane through the axle from the lip
    edge back to the barrel's far end, each one's first hit on the ring one point of the profile
    (the median over `planes` planes around the axle, so lettering or a slot does not count), so
    the order is the surface's own, steps and all. Measured on the ring before the cull, so the
    dish wall and the barrel's flange run all the way down to where the face meets them; the face
    is not in the ring, so the rays pass through it to the barrel behind. The points are thinned
    to RING_BANDS where the profile bends most. The inner barrel behind the face stays and runs
    on to the tire's back bead: it shows between the spokes and from behind, and a wheel cut off
    at its face reads as a thin disc in a hollow tire.

    The planes step round the axle by the golden angle, so no spoke count lines up with them.
    Twelve planes 30 degrees apart met a 6 or 12 spoke wheel at the same place in every bay: on
    the OZR the bar between a bay's two pockets, so the rays all passed it and the median was the
    barrel behind (ame, 2026-10-28).

    It used to bin the culled ring's face centers by their angle from that viewpoint and average
    each bin: a dish wall and the barrel step behind it lie along the same rays, so the average
    pulled the profile off both and the face's outer edge floated centimeters in front of the
    turned lip (2026-10-28)."""
    me = o.data
    if len(me.polygons) < 4:
        return None
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons])
    P = Vector((0.25, 0.3 * L))
    t0 = math.atan2(1.05 * L - P.y, X_LIP + 0.02 - P.x)
    t1 = math.atan2(0.55 * L - P.y, X_BACK - 0.06 - P.x)
    pts = []
    for k in range(rays + 1):
        t = t0 + (t1 - t0) * k / rays
        dx, dr = math.cos(t), math.sin(t)
        hits = []
        for j in range(planes):
            ph = 0.3 + j * GOLDEN
            c, s = math.cos(ph), math.sin(ph)
            hit = tree.ray_cast(Vector((P.x, P.y * c, P.y * s)), Vector((dx, dr * c, dr * s)))[0]
            if hit is not None:
                hits.append(Vector((hit.x, _rad(hit))))
        if len(hits) * 2 > planes:
            hits.sort(key=lambda q: (q - P).length)
            pts.append(hits[len(hits) // 2])
    if len(pts) < 4:
        return None
    # A flange the face is bolted to hides the barrel behind it from the front: from the last
    # point the front saw, the barrel's inside is found from the axle outward, a station every 2 mm.
    x = pts[-1].x - 0.002
    while x > X_BACK - 0.01:
        hits = []
        for j in range(planes):
            ph = 0.3 + j * GOLDEN
            hit = tree.ray_cast(Vector((x, 0, 0)), Vector((0, math.cos(ph), math.sin(ph))))[0]
            if hit is not None and _rad(hit) > 0.5 * L:
                hits.append(_rad(hit))
        if len(hits) * 2 > planes:
            pts.append(Vector((x, sorted(hits)[len(hits) // 2])))
        x -= 0.002
    prof = _thin(pts, RING_BANDS)
    edge = max(prof, key=lambda q: q.y)
    prof.insert(0, Vector((edge.x - 0.015, L)))
    # The cull leaves little of the barrel behind a dense face, so it is carried on at its last
    # radius to the back, then out to the tire's bead: the wheel is as wide as its tire.
    if prof[-1].x > X_BACK + 0.005:
        prof.append(Vector((X_BACK, prof[-1].y)))
    prof.append(Vector((X_BACK, max(prof[-1].y, L - 0.004))))
    return prof


def _thin(pts, most, tol=3e-4):
    """The profile thinned to `most` points: the point farthest off the polyline so far is added
    until the profile is within `tol` everywhere or the budget is spent; the ends always stay."""
    keep = {0, len(pts) - 1}
    while len(keep) < most:
        ks = sorted(keep)
        far, at = tol, None
        for a, b in zip(ks, ks[1:]):
            A, B = pts[a], pts[b]
            AB = B - A
            n = AB.length_squared or 1e-12
            for i in range(a + 1, b):
                u = max(0.0, min(1.0, (pts[i] - A).dot(AB) / n))
                d = (pts[i] - (A + AB * u)).length
                if d > far:
                    far, at = d, i
        if at is None:
            break
        keep.add(at)
    return [pts[i] for i in sorted(keep)]


def _lathe(bm, prof, mat, seg=RING_SEG, eye=None, ordered=False):
    """A surface of revolution through the (x, r) profile about the axle, smooth, its normals in
    `src_normal` (toward the viewpoint side of the profile). Returns the faces made.

    Each face is wound toward the viewpoint by its own segment, and a corner's smooth normal that
    points across that segment (a step in the profile) takes the segment's: the profile is in the
    order the viewpoint sees it, so that side is the seen one all along. Winding faces by the
    smoothed corner normal turned the faces at a sharp step away from the front, and the game
    draws `Rim` single sided (2026-10-28). `eye` is that viewpoint as (x, r); a center cap is seen
    from in front and outside it, so its skirt faces out. `ordered`: no viewpoint, every face is
    wound to the left of the profile's direction (axle outward: +X on a flat, out on a wall that
    drops, in toward the axle on one that rises). A cap's profile runs from the axle out, so that
    side is the seen one everywhere; an eye off to the side turned the walls of a groove that face
    the axle away from the front (minamo, homura and five more showed holes in their caps,
    2026-10-28)."""
    sn = bm.loops.layers.float_vector.get('src_normal') or bm.loops.layers.float_vector.new('src_normal')
    P = len(prof)
    eye = eye or Vector((0.25, 0.3 * prof[0].y))
    n2 = []
    for k in range(P):
        a, b = prof[max(0, k - 1)], prof[min(P - 1, k + 1)]
        t = (b - a).normalized()
        n = Vector((t.y, -t.x))
        # Toward the front viewpoint: the side the dish is seen from.
        if not ordered and n.dot(eye - prof[k]) < 0:
            n = -n
        n2.append(n)
    ns = []
    for k in range(P - 1):
        t = (prof[k + 1] - prof[k]).normalized()
        n = Vector((t.y, -t.x))
        if not ordered and n.dot(eye - (prof[k] + prof[k + 1]) / 2) < 0:
            n = -n
        ns.append(n)
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        rings.append([bm.verts.new((q.x, q.y * math.cos(a), q.y * math.sin(a))) for q in prof])
    made = []
    for i in range(seg):
        a, b = rings[i], rings[(i + 1) % seg]
        ca, sa = math.cos(2 * math.pi * i / seg), math.sin(2 * math.pi * i / seg)
        cb, sb = math.cos(2 * math.pi * (i + 1) / seg), math.sin(2 * math.pi * (i + 1) / seg)
        cm, sm = math.cos(2 * math.pi * (i + 0.5) / seg), math.sin(2 * math.pi * (i + 0.5) / seg)
        for k in range(P - 1):
            f = bm.faces.new((a[k], a[k + 1], b[k + 1], b[k]))
            f.material_index = mat
            f.smooth = True
            f.normal_update()
            if f.normal.dot(Vector((ns[k].x, ns[k].y * cm, ns[k].y * sm))) < 0:
                f.normal_flip()
            for l in f.loops:
                kk = k if l.vert in (a[k], b[k]) else k + 1
                nk = n2[kk] if n2[kk].dot(ns[k]) > 0 else ns[k]
                c, s_ = (ca, sa) if l.vert in (a[k], a[k + 1]) else (cb, sb)
                l[sn] = Vector((nk.x, nk.y * c, nk.y * s_))
            made.append(f)
    bm.normal_update()
    return made


def _drop_loose(bm, most=60, contact=0.003):
    """Delete small islands of the donor's faces (`most` faces or fewer) that come no nearer than
    `contact` to anything else: a lug seat or a spoke's sliver that the cull or the collapse cut
    off floats in front of the hub. House parts (own normals) stay. Returns the faces deleted."""
    own = bm.faces.layers.int.get('own_normals')
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    tree = BVHTree.FromBMesh(bm)
    seen, gone = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, grp = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            grp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        if len(grp) > most or (own is not None and any(g[own] for g in grp)):
            continue
        idx = {g.index for g in grp}
        if not any(hit[2] not in idx for g in grp for v in g.verts for hit in tree.find_nearest_range(v.co, contact)):
            gone += grp
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    return len(gone)


def _drop_shards_and_stems(bm, lip_mat, shard=0.0025, shard_most=12, stem_most=600, stem_size=0.05, stem_r=0.145, stem_x=0.003, apart=10.0, ring=0.004):
    """Two kinds of donor leftover that `_drop_loose` keeps because they touch something (2026-10-28).
    Shards: an island of `shard_most` faces or fewer whose every vertex lies within `shard` of the turned
    lip (`lip_mat`), a lip rivet or lettering the collapse cut into single triangles; it z-fights the
    lathe's surface (the Advan A3A's 200 glitching triangles round its perimeter). Stems: a compact island
    (`stem_size` across at most, `stem_most` faces at most) outside `stem_r` from the axle and at least
    `stem_x` (3 mm) deep along it, with no island of its own radius (`ring`) at another angle (`apart` degrees),
    so it is no ring of rivets or lugs: the donor's valve stem, which no wheel has in the game. A stem is
    often several islands (stem, nut, cap) at one angle, and they all go. House parts (own normals) stay.
    Returns the faces deleted."""
    own = bm.faces.layers.int.get('own_normals')
    bm.faces.ensure_lookup_table()
    lip = [f for f in bm.faces if f.material_index == lip_mat]
    tree = None
    if lip:
        vs = {v: i for i, v in enumerate({v for f in lip for v in f.verts})}
        tree = BVHTree.FromPolygons([v.co[:] for v in vs], [[vs[v] for v in f.verts] for f in lip])
    donor = [g for g in _islands(bm) if not (own is not None and any(f[own] for f in g)) and g[0].material_index != lip_mat]
    info = []
    for g in donor:
        vs = {v for f in g for v in f.verts}
        lo = Vector((min(v.co.x for v in vs), min(v.co.y for v in vs), min(v.co.z for v in vs)))
        hi = Vector((max(v.co.x for v in vs), max(v.co.y for v in vs), max(v.co.z for v in vs)))
        c = sum((v.co for v in vs), Vector()) / len(vs)
        info.append((g, vs, (hi - lo).length, hi.x - lo.x, sum(_rad(v.co) for v in vs) / len(vs), math.degrees(math.atan2(c.z, c.y))))
    gone = []
    for g, vs, size, dx, r, ang in info:
        if tree and len(g) <= shard_most and all((tree.find_nearest(v.co)[3] or 1e9) < shard for v in vs):
            gone += g
        elif 12 <= len(g) <= stem_most and size <= stem_size and r >= stem_r and dx >= stem_x and not any(
                o is not g and abs(r2 - r) < ring and abs((a2 - ang + 180) % 360 - 180) > apart and s2 < 0.06
                for o, _, s2, _, r2, a2 in info):
            gone += g
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    return len(gone)


def _reduce(o, budget):
    """Collapse to about `budget` triangles: meshoptimizer's (keeps the authored shading and the
    material seams) as far as it goes without tearing loose pieces, Decimate for the rest. No
    mirror symmetry: a wheel has none across its axle."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.5), verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()
    have = tris(o)
    if have > budget:
        have = meshopt_reduce(o, budget, uv=False)[0]
    if have > budget * 1.05:
        mod = o.modifiers.new('reduce', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = budget / have
        mod.use_collapse_triangulate = True
        _apply(o, mod)


def _kind_objects(bm, kind_of, names, mats, work):
    """One object per kind from a bmesh whose faces carry a `kind` int layer (a copy each)."""
    out = {}
    kl = bm.faces.layers.int['kind']
    for kind, idx in kind_of.items():
        if not any(f[kl] == idx for f in bm.faces):
            continue
        t = bm.copy()
        tl = t.faces.layers.int['kind']
        bmesh.ops.delete(t, geom=[f for f in t.faces if f[tl] != idx], context='FACES')
        me = bpy.data.meshes.new(f'{names}.{kind}')
        for m in mats:
            me.materials.append(m)
        t.to_mesh(me)
        t.free()
        o = bpy.data.objects.new(me.name, me)
        work.objects.link(o)
        out[kind] = o
    return out


def _join(objs):
    """The objects' meshes in one bmesh (their faces keep every attribute layer)."""
    bm = bmesh.new()
    for o in objs:
        bm.from_mesh(o.data)
    return bm


def _angle_normals(o, angle=35):
    """Shade from the mesh's own geometry instead of the donor's normals: smooth, split at edges
    sharper than `angle` degrees. For a donor whose authored normals lean far off its faces."""
    me = o.data
    if me.attributes.get('custom_normal'):
        me.attributes.remove(me.attributes['custom_normal'])
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        e.smooth = not (e.is_manifold and e.calc_face_angle(0) > math.radians(angle))
    bm.to_mesh(me)
    bm.free()


def _carry_normals(o):
    """Write the object's custom normals into its src_normal corner attribute, so a join keeps them."""
    me = o.data
    sn = me.attributes.get('src_normal') or me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
    sn.data.foreach_set('vector', [x for c in me.corner_normals for x in c.vector])


def wheel(name, root):
    """Build `wheels.wheel_<name>` in collection `wheels:Wheels` from the import under `root`."""
    R0 = WHEELS[name]
    c = coll('wheels:Wheels')
    work = coll('wheels:Work')
    oname = f'wheels.wheel_{name}'
    for stale in list(bpy.data.objects):
        if stale.name.startswith(oname):
            bpy.data.objects.remove(stale)
    bpy.context.view_layer.update()
    bm, names = _gather(root, R0)
    if not bm.faces:
        raise ValueError(f'{name}: nothing left after dropping scene junk')
    L = _frame(bm)
    isl = _classify(bm, L, names, R0)
    if R0.get('chunks'):   # a scan cut into chunks that each run hub to lip: its islands are no parts
        for i in isl:
            if i.kind in ('ring', 'bolt', 'decal'):
                i.kind = 'face'
    sign = R0.get('face') or _face_sign(isl, L)
    if sign < 0:
        _xform(bm, Matrix.Diagonal((-1, 1, -1, 1)))
        for i in isl:
            i.xmin, i.xmax = -i.xmax, -i.xmin
    # Scale the lip onto the house tire's bead, in meters from here on.
    k = TIRE_R * BEAD / L
    _xform(bm, Matrix.Scale(k, 4))
    for i in isl:
        i.xmin, i.xmax = i.xmin * k, i.xmax * k
    L = TIRE_R * BEAD
    # The lip edge just proud of the tire's sidewall, then the barrel behind the face squeezed
    # to the tire's back bead; the dish keeps its depth.
    rings = [i for i in isl if i.kind == 'ring']
    faces = [i for i in isl if i.kind in ('face', 'cap')]
    edge = [v.co.x for i in rings for f in i.faces for v in f.verts if _rad(v.co) > 0.97 * L] or [i.xmax for i in faces]
    dx = X_LIP - max(edge)
    _xform(bm, Matrix.Translation((dx, 0, 0)))
    for i in isl:
        i.xmin, i.xmax = i.xmin + dx, i.xmax + dx
    x_face_back = min(i.xmin for i in faces)
    x_back = min(v.co.x for v in bm.verts)
    squeeze = 1.0
    if x_back < X_BACK:
        pivot = max(x_face_back, X_BACK + 0.02)
        squeeze = (pivot - X_BACK) / (pivot - x_back)
        for v in bm.verts:
            if v.co.x < pivot:
                v.co.x = pivot - (pivot - v.co.x) * squeeze
    bm.normal_update()
    circles = _bolt_circles(isl) if R0.get('bolts', 1) else []
    circle = None
    for g in circles:
        circle = _bolt_circle(g, L)
        if circle:
            break
        for i in g:
            i.kind = 'face'   # a flange ring without bolts on it stays part of the face
    # The hub, for the house cap: the bore radius and the hub's front.
    faces = [i for i in isl if i.kind in ('face', 'cap')]
    bore = min((i.rmin for i in faces), default=1.0)
    cap_r = max(bore * 1.3, 0.12) * L if bore > 0.05 else 0
    hub = [v.co.x for i in faces for f in i.faces for v in f.verts if _rad(v.co) < cap_r * 1.2] if cap_r else []
    cap_x = (max(hub) if hub else 0) + 0.002
    # Materials by kind (a source material called black stays black).
    mats = [shared_mat(u) for u in SHARED]
    IDX = {u: SHARED.index(u) for u in SHARED}
    KIND = {'face': 0, 'ring': 1, 'cap': 2}
    kl = bm.faces.layers.int['kind']
    one_piece = not any(i.kind == 'ring' for i in isl)
    # The stock lip: chrome on a multi-piece wheel, the face's paint on a one-piece (the user, 2026-10-28). The
    # construction is the recipe's word (every recipe states it; the geometry only ever guessed: a ring of six
    # or more lip bolts, a 2P / 3P title, and a donor's separate lip mesh says nothing, since jonver87 models a
    # cast wheel's lip as its own piece too).
    multi = R0['construction'] == 'multi'
    lip = R0.get('lip', 'chrome' if multi else 'rim')
    # A multi-piece wheel's face can carry a round flange of its own (the recipe's `turn`): turned the same way.
    turn = R0.get('turn')
    turned = _turned_faces(isl, L, edge=turn or 0.97) if one_piece or turn else set()
    for i in isl:
        for f in i.faces:
            src = names[f.material_index] if f.material_index < len(names) else ''
            kind = i.kind
            # A one-piece wheel's lip, dish and barrel are its face's own round faces: turned like a ring.
            if kind == 'face' and f in turned:
                kind = 'ring'
            f.material_index = IDX['Black'] if re.search(r'(?i)black', src) and kind == 'face' else IDX['RimCap'] if kind == 'cap' else IDX['RimLip'] if kind == 'ring' else IDX['Rim']
            f[kl] = KIND.get(kind, -1)
    src_tris = sum(i.tris for i in isl)
    gone = {kd: sum(i.tris for i in isl if i.kind == kd) for kd in ('bolt', 'decal')}
    kinds = {kd: sum(1 for i in isl if i.kind == kd) for kd in ('face', 'ring', 'cap', 'bolt', 'decal')}
    bmesh.ops.delete(bm, geom=[f for i in isl if i.kind in ('bolt', 'decal') for f in i.faces], context='FACES')
    # Each kind on its own. A first collapse to three times the budget makes the hidden face test
    # affordable on a 100k triangle face; the budget collapse follows it, and the shading comes
    # from the authored normals the first collapse kept.
    parts = _kind_objects(bm, KIND, oname, mats, work)
    bm.free()
    # The ring's profile from the whole ring, before anything is collapsed or culled: the flange
    # and dish wall the face sits on are hidden behind the face's edge, and the cull takes them.
    ring_prof = _ring_profile(parts['ring'], L) if 'ring' in parts else None
    returned = unturned = 0
    if ring_prof and (one_piece or turn):
        parts, returned, unturned = _turn_to_profile(parts, ring_prof, KIND, IDX['Rim'], IDX['RimLip'], oname, mats, work)
    for kind, o in parts.items():
        if tris(o) > 3 * BUDGETS[kind]:
            _reduce(o, 3 * BUDGETS[kind])
    # Hidden faces go against the whole wheel, tire included: the barrel under the tire, the backs
    # of the spokes. Nobody sees a wheel from inside the car, so only the front half's views count.
    wbm = _join(parts.values())
    wkl = wbm.faces.layers.int.get('kind') or wbm.faces.layers.int.new('kind')
    for f in house_tire(wbm, IDX['Tire']):
        f[wkl] = 3
    me = bpy.data.meshes.new(oname + '.all')
    for m in mats:
        me.materials.append(m)
    wbm.to_mesh(me)
    wbm.free()
    whole = bpy.data.objects.new(me.name, me)
    work.objects.link(whole)
    culled = cull_hidden(whole, [d for d in _view_dirs() if d.x > -0.3])[0]
    for o in parts.values():
        bpy.data.objects.remove(o)
    wbm = bmesh.new()
    wbm.from_mesh(me)
    bpy.data.objects.remove(whole)
    parts = _kind_objects(wbm, KIND, oname, mats, work)
    wbm.free()
    obm = bmesh.new()
    for kind, o in parts.items():
        if kind == 'ring' and ring_prof:
            bpy.data.objects.remove(o)
            continue
        # The shading skin is taken after the cull: it turned the faces only their back is seen
        # from and negated their authored normals with them, which rights a donor modelled inside
        # out (the Equip 40's face); a skin from before the cull would turn them back.
        if kind == 'face' and R0.get('normals') == 'geometry':
            _reduce(o, BUDGETS[kind])
            _angle_normals(o)
        else:
            skin = _copy(o, o.name + '.skin')
            _reduce(o, BUDGETS[kind])
            shade_from_source(o, skin)
            bpy.data.objects.remove(skin)
        _carry_normals(o)
        obm.from_mesh(o.data)
        bpy.data.objects.remove(o)
    if ring_prof:
        _lathe(obm, ring_prof, IDX['RimLip'])
    if circle:
        _hex_heads(obm, IDX['Chrome'], circle)
    if cap_r:
        _house_cap(obm, IDX['RimCap'], cap_r, cap_x)
    house_tire(obm, IDX['Tire'])
    loose, n = 0, 1
    while n:   # a sliver may only have touched another loose one
        n = _drop_loose(obm)
        loose += n
    _drop_shards_and_stems(obm, IDX['RimLip'])
    out = bpy.data.meshes.new(oname)
    for m in mats:
        out.materials.append(m)
    obm.to_mesh(out)
    obm.free()
    o = bpy.data.objects.new(oname, out)
    c.objects.link(o)
    _set_normals(o)
    for a in ('src_normal', 'own_normals', 'kind'):
        if out.attributes.get(a):
            out.attributes.remove(out.attributes[a])
    remap_materials(o)
    disc = R0.get('cap_disc')
    cap_i = [m.name for m in o.data.materials].index('RimCap') if 'RimCap' in [m.name for m in o.data.materials] else -1
    cmax = R0.get('cap_max')
    if cmax and cap_i >= 0:   # the cap is only the donor's center cap: its other cap-kind pieces (pocket walls, hub pieces beyond this radius) are hub, Rim
        me = o.data
        rim_i = [m.name for m in me.materials].index('Rim')
        for p in me.polygons:
            if p.material_index == cap_i and max(_rad(me.vertices[i].co) for i in p.vertices) > cmax * TIRE_R * BEAD:
                p.material_index = rim_i
    cap_pts = clean_cap(o, (lambda f, L: f.material_index == cap_i or all(_rad(v.co) < disc * L for v in f.verts) and f.normal.x > 0.5 and f.calc_center_median().x > 0.03) if disc else None, fill=R0.get('cap_fill', False),
                        edge=R0['cap_edge'] * TIRE_R * BEAD if R0.get('cap_edge') else None)
    hub_r = 0 if cap_pts else hub_cap(o, R0.get('cap'))
    lugs = fit_lugs(o, R0.get('lugs'))
    o['lip'] = lip
    o['construction'] = R0['construction']
    wheel_offset(o, R0)
    o['displayName'] = name.capitalize()
    o['group'] = GROUPS[R0['maker']]
    print(f'wheel_{name}: {R0["name"]} ({R0["author"]}); islands {kinds}; face {"+" if sign > 0 else "-"}X, scaled x{k:.3f}, '
          f'barrel squeezed x{squeeze:.2f}, lip {lip}' + (f' turned from {len(ring_prof)} points' if ring_prof else '') + (f' (faces on its profile: {returned} more turned, {unturned} off it kept as face)' if returned or unturned else '') + ', ' + (f'{len(circle[0])} house bolts at r {circle[1]:.3f}' if circle else 'no bolt circle') +
          (f', house cap r {cap_r:.3f}' if cap_r else '') + (f', cap turned from {cap_pts} points' if cap_pts else f', hub turned as a cap to r {hub_r:.2f}' if hub_r else '') + (f', {lugs[0]} lugs at r {lugs[1]:.3f}' if lugs else ', no lugs') + f'; {src_tris} -> {tris(o)} tris ({culled} hidden culled, {loose} loose, {gone["bolt"]} of bolts and {gone["decal"]} of decals replaced)')
    return o


def wheel_offset(o, R=None):
    """A multi-piece wheel's stock offset (m, +X outboard; the catalog's `offset`, the number the game's per-car
    targets move the face against): the lug seat where a circle was fitted (the nuts sit there, so it is what the
    eye reads against the lip), else the center cap's front (it covers the nuts). The reference is the house
    tire's centerline at x 0, so it is the wheel's ET at the house scale. The recipe's `offset: 'fixed'` writes
    none, so the wheel ships as modelled on every car (hane: a dome proud of the lip is the design); its `bias`
    (mm on the car, + outboard) is written as `offsetBias` on any wheel, one-piece included, and moves the face
    that much beyond the car's target (or from stock, on a one-piece). Set on the object; returns the offset."""
    R = R or WHEELS[o.name.split('wheel_', 1)[1]]
    for k in ('offset', 'offsetBias'):
        if k in o.keys():
            del o[k]
    if R.get('bias'):
        o['offsetBias'] = R['bias']
    if o.get('construction') != 'multi' or R.get('offset') == 'fixed':
        return None
    me = o.data
    if 'lugs' in o.keys():
        x = json.loads(o['lugs'])['x']
    else:
        cap = [m.name for m in me.materials].index('RimCap') if 'RimCap' in [m.name for m in me.materials] else -1
        xs = [me.vertices[i].co.x for p in me.polygons if p.material_index == cap for i in p.vertices]
        if not xs:
            raise ValueError(f'{o.name}: no lug seat and no center cap to read the offset from')
        x = max(xs)
    o['offset'] = round(x, 5)
    return o['offset']


def _set_normals(o):
    """Custom normals: the reduced kinds' own (carried in src_normal), the house parts' lathe
    normals (tire and cap smooth about the axle, bolt heads flat)."""
    me = o.data
    sn = me.attributes.get('src_normal')
    hc = me.attributes.get('own_normals')
    own = [bool(v.value) for v in hc.data] if hc else [False] * len(me.polygons)
    src = [v.vector.copy() for v in sn.data] if sn else None
    tire_idx = SHARED.index('Tire')
    out = []
    for p in me.polygons:
        if own[p.index] and p.material_index == tire_idx:
            for li in p.loop_indices:
                v = me.vertices[me.loops[li].vertex_index].co
                n = Vector((0, v.y, v.z)).normalized()
                side = abs(v.x) > TIRE_W * 0.45 and _rad(v) < TIRE_R * 0.93
                out.append((Vector((math.copysign(1, v.x), 0, 0)) * 0.9 + n * 0.1).normalized() if side else
                           (n + Vector((v.x / (TIRE_W * 0.5) * 0.35, 0, 0))).normalized())
        elif own[p.index] and p.use_smooth:
            for li in p.loop_indices:
                v = me.vertices[me.loops[li].vertex_index].co
                out.append(Vector((0, v.y, v.z)).normalized())
        elif own[p.index] or src is None:
            out += [p.normal.copy()] * p.loop_total
        else:
            out += [src[li] if src[li].length > 0.5 else p.normal.copy() for li in p.loop_indices]
    for p in me.polygons:
        if not own[p.index]:
            p.use_smooth = True
    me.normals_split_custom_set(out)


def wheel_report(names):
    """One line per wheel: triangles by material, wheel depth and lip, so the set compares at a glance."""
    for n in names:
        o = bpy.data.objects.get(f'wheels.wheel_{n}')
        if not o:
            print(n, 'missing')
            continue
        me = o.data
        by = {}
        for p in me.polygons:
            k = me.materials[p.material_index].name
            by[k] = by.get(k, 0) + len(p.vertices) - 2
        face = [v.co for p in me.polygons if me.materials[p.material_index].name != 'Tire' for i in p.vertices for v in [me.vertices[i]]]
        print(f"wheel_{n:8} {tris(o):5} tris {by}  x {min(v.x for v in face):+.3f}..{max(v.x for v in face):+.3f}, lip {max(_rad(v) for v in face):.3f}")


def wheel_sheet(names, cols=4, gap=0.7):
    """Lay linked copies of the wheels out in a grid facing -Y (Blender front), for a look."""
    c = coll('wheels:Sheet')
    for o in list(c.objects):
        bpy.data.objects.remove(o)
    for k, n in enumerate(names):
        src = bpy.data.objects.get(f'wheels.wheel_{n}')
        if not src:
            continue
        o = bpy.data.objects.new(f'sheet.{n}', src.data)
        o.rotation_euler = (0, 0, math.radians(-90))
        o.location = ((k % cols) * gap, 0, -(k // cols) * gap)
        c.objects.link(o)
