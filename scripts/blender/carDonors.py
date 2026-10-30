"""
Donor models: one real car mesh per Street Scene car (Sketchfab, downloadable, licence
recorded), made generic and brought into car space at the shared budget. Each donor is
collected out of its import, classified onto the shared materials (badges, wipers, wheels,
brakes, interiors and engines dropped; sunroofs and fuel doors patched over), placed with its axles centered and its tires on the ground,
reduced to the triangle budget, and measured, so the four cars can be compared on one sheet
and the differences in construction found (docs/carDesign.md, "Donor models").

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/carRefs.py').read())
    exec(open(REPO + '/scripts/blender/carDonors.py').read())
    import_asset(source='sketchfab', id=DONORS[cid]['uid'], target_size=DONORS[cid]['mm']['length'] / 1000)   # MCP tool
    donor('albrechtKombi', 'Sketchfab_model.001')   # collect, classify, place, join -> donor:albrechtKombi.Full
    reduce_donor('albrechtKombi', BUDGET)           # decimated copy -> donor:albrechtKombi.Low
    donor_report(list(DONORS))                   # one table: size, scale check, triangles, materials, stations
    compare_donors(list(DONORS), OUT)            # side / front / rear sheets, same framing for every car
    lamp_islands('albrechtKombi', (0.4, -2.1, 0.3), (0.8, -1.7, 0.6))   # the lamp pieces in a box: material, faces, center, bounds
    edit_diff('albrechtKombi', 'myEdits')          # a hand-edited copy of .Low against it: what to put in the recipe
    ship_donor('albrechtKombi', WORK)              # .Low into albrechtKombi.Body, a working copy for saveCar.py

A recipe classifies by regex: `materials` maps the import's material names to a shared
material, None (drop those faces) or 'Lamp' (HeadLight ahead of the axles' midpoint, TailLight
behind, Light between the axles: mirror repeaters). Only the main lamps glow in the game, so a
donor whose lamps are modelled in layers maps them finer: the clear covers to `Lens` (unlit,
see-through), indicators and markers to `Light` (amber) or `Reflector` (red), and only the main
lamps' own elements to HeadLight / TailLight. A main lamp needs something that glows: one modelled
as a bare cover over chrome stays 'Lamp'. `drop` removes whole meshes whose name or
any parent's name matches (the imports name parts on the empties above the meshes); `recolor`
fixes faces after the join (a glass roof to Paint, lamp covers cut from the window glass);
`cull` deletes stray faces after the join; `bridges` (boxes) lofts the grille bars across the gap a badge
left (`bridge_bars`), and every removed badge's recess is pressed flush into its panel (`press_recesses`); `debadge: False` skips
the badge island passes for a donor whose badges are materials of their own. Every material must be classified: an
unknown one raises, so nothing ships by accident. Blender space: meters, Z up, car facing -Y
(all four imports already do); the import is scaled to the car's published length, and the
measured wheelbase against the published one is the scale check.
"""
import re

import numpy as np

exec(open(os.path.join(REPO, 'scripts/blender/meshopt.py')).read())   # meshopt_reduce

BUDGET = 16000   # triangles per car for the reduced donor shell, the same for every car: at 8,000 mirrors, handles and lamp edges smeared
INTERIOR_BUDGET = 2500   # triangles for the donor's own cabin (dash, seats, door cards), seen through the glass
LAMP_BUDGET = 4000   # triangles for the lamps (lenses, and the reflectors and housings behind a clear cover), reduced before the shell
CAR_BUDGET = 20000   # the whole car (TRI_BUDGETS.body): the cabin and the lamps first, the shell the rest, up to BUDGET
LAMP_ERROR = 0.003   # the lamps' collapse stops at this share of their extent (the whole car's length: 13 mm), not MESHOPT's 1 %; the RX-7's take 4,900
REDUCER = 'meshopt'   # _collapse: 'meshopt' (meshopt.py) or 'blender' (the Decimate modifier, mirror-symmetric)

# The RX-7's raised pop-up lamps (shell and bucket), clear of the hood round them.
POPUP = lambda c: 0.47 < abs(c.x) < 0.76 and -1.86 < c.y < -1.48 and c.z > 0.6

# The Golf's tail lamp faces under their covers (both sides), its housing's walls with them (they
# wrap round its outer corner and bottom lip, and show through the cover): what its bands repaint.
TAIL = lambda c, n, m: m in ('TailLight', 'Light', 'Chrome', 'Black') and c.y > 1.6 and 0.49 < abs(c.x) < 0.785 and 0.685 < c.z < 0.905

DONORS = {
    'albrechtKombi': {
        'name': '1992 Audi S2 Avant',
        'uid': '939dc6336dfe4fbd99fdb3608d58de56',
        'author': 'tonielpro520',
        'license': 'CC Attribution',
        'mm': {'length': 4509, 'wheelbase': 2597},
        'tires': r'^Tyre$',
        'materials': {
            r'^body(\.\d+|_2)?$': 'Paint',
            # Interior (INT_ and its unprefixed pieces); then the wheels in five materials and the logos.
            r'(?i)^int_|^(headliner|cloth|leather|solid|plastic|metal|carbon_fiber|bump_stitching|gauge_\w+|digital_gauge|reflector_cp|defrost_lines)$': 'Interior',
            r'^(glass|material|material_57|Material_14|outer_rim|wheel_black|chrome_rim|rotor|audilogo|exT_black_shit)$': None,
            # rubber_trim is the window and bumper seals, which AUTO would drop as tire rubber.
            r'^(rubber_trim|plastic2|misc|undercarriage|weatherstrip|black|frame|bumper_frame|grille2_alpha|matte_colors)$': 'Black',
            # The lamps are modelled in layers: clear covers (`lights_glass`, `detail_glass_clear`)
            # over textured reflectors, projectors and bulbs; red glass over the tail lamps.
            r'^(lights_glass|detail_glass_clear)$': 'Lens',
            r'^(textured_reflector(\.\d+)?|head_light|reverse_light_lod0)$': 'Lamp',
            r'^(detail_glass_red|reflector|tail_light_lod0)$': 'TailLight',
            r'^(window|black_glass)$': 'Glass',
            r'^(chrome|chrome_2|exhaust_chrome_thing)$': 'Chrome'},
        # Front: the headlamps glow whole (reflector bowl, projector, bulbs) but for their outer
        # corner, the indicator; in the bumper the inner lamp (the fog lamp, its round lens) glows
        # and the outer one is an indicator. Rear: the red glass runs across the tailgate from the
        # corner lamps; the lamps glow (corners, and the tailgate's ends out from |x| 0.31), the
        # reverse lamp in each (|x| 0.31 to 0.38) bright (as a clear lens it read as a hole onto
        # the dark housing), the centre panel an unlit red reflector.
        'recolor': [(lambda c, n, m: m == 'HeadLight' and c.y < -1.85 and abs(c.x) > 0.65 and c.z > 0.55, 'Light'),
                    (lambda c, n, m: m == 'HeadLight' and c.y < -1.85 and abs(c.x) > 0.583 and c.z < 0.5, 'Light'),
                    (lambda c, n, m: m == 'TailLight' and c.y > 1.85 and abs(c.x) < 0.31, 'Reflector'),
                    (lambda c, n, m: m in ('TailLight', 'Lens') and c.y > 1.85 and 0.31 < abs(c.x) < 0.38 and 0.59 < c.z < 0.77, 'Chrome')],
        # The rear wheel well liners sit on the tire's crown (an arch gap of -0.019): lifted clear,
        # as the shipped file was by hand on 2026-10-27.
        'liftLiners': True,
        # The headlamp washer nozzles (on the bumper over each lower lamp) go as badges, but pressed
        # flush the curved bumper crumpled round them: left as they were.
        'press': lambda c: not (abs(abs(c.x) - 0.49) < 0.03 and c.y < -2.0 and 0.49 < c.z < 0.55),
        # The bumper's lip round the lower lamps' openings is reduced with the lamps: in the shell's
        # collapse it folded over the left lamp's round inner end, which read sheared.
        'lamps': [lambda c, n, m: 0.33 < abs(c.x) < 0.77 and c.y < -2.0 and 0.39 < c.z < 0.51],
        # The lamps kept finer (the round fog lamps were octagons): a tighter error, the budget for
        # it, and the car's total raised so the shell keeps its 13,500.
        'lampBudget': 9000,
        'lampError': 0.0012,
        'carBudget': 25000,
        # What strip_wipers leaves of the wiper arms on the cowl, and the whip antenna on the roof.
        'islands': [lambda k, a, b, mats: set(mats) == {'Black'} and k < 400 and -1.12 < (a.y + b.y) / 2 < -0.86 and 0.84 < (a.z + b.z) / 2 < 0.95
                    and max(b - a) < 0.25,
                    lambda k, a, b, mats: set(mats) == {'Black'} and abs((a.x + b.x) / 2) < 0.03 and b.z > 1.45 and (b - a).x < 0.05],
    },
    'wendtStrom': {
        'name': '2002 Volkswagen Golf R32 (Mk4)',
        'uid': '98e6828648084ae3b877ad69e8ad36dc',
        'author': 'tangwang920',
        'license': 'CC Attribution',
        'mm': {'length': 4149, 'wheelbase': 2518},
        'tires': r'TARMAC_TYRE_TREAD',
        # `material` is one atlas for the trim, seals, bumper inserts and mirror housings; `chassis`
        # the underbody.
        'materials': {r'^material$': 'Black', r'^chassis$': 'Black'},
        # The lamps are geometry painted by the `Lights` texture: its colours class each face
        # (`texture`, lamp_colour), the tail lamps cut first along their bands (`textureCuts`,
        # probed off the texture: red, a smoked band from 0.806 to 0.850 with the reverse lamp at
        # its outer end, red, and a smoked fog block on the lower inner corner). Their covers are
        # `glass` like the windows: the headlight covers their own mesh at the nose, the tail
        # covers part of the rear glass at the corners below the hatch window; both clear.
        'texture': [r'^Lights$'],
        'textureCuts': [('z', 0.806), ('z', 0.850), ('x', 0.672), ('x', 0.720), ('z', 0.706), ('z', 0.750), ('x', 0.588)],
        # The headlamps' two reflector bowls and their bulbs glow (the bezel round them stays
        # chrome; the bowls sit behind its front, y > -1.975); the small red round lens between
        # them is an unlit reflector, the fog lamp under it unlit. The reverse lamp stays the
        # texture's bright chrome: as a clear lens it read as a hole onto the black housing.
        'recolor': [(lambda c, n, m: m == 'Glass' and c.y < -1.5, 'Lens'),
                    (lambda c, n, m: m == 'Glass' and c.y > 1.55 and c.z < 0.95 and abs(c.x) > 0.4, 'Lens'),
                    # The bowls' texture has dark streaks (classed Black); the housing's floor under
                    # them faces straight up, a bowl's bottom up and forward.
                    (lambda c, n, m: m in ('Chrome', 'Black') and -1.975 < c.y < -1.8 and n.z < 0.85
                     and (math.hypot(abs(c.x) - 0.442, c.z - 0.618) < 0.06 or math.hypot(abs(c.x) - 0.627, c.z - 0.648) < 0.072), 'HeadLight'),
                    (lambda c, n, m: m in ('TailLight', 'Black') and math.hypot(abs(c.x) - 0.522, c.z - 0.674) < 0.03 and -1.93 < c.y < -1.9, 'Reflector'),
                    # The third brake light: the red strip across the top of the rear glass.
                    (lambda c, n, m: m == 'TailLight' and c.z > 1.2, 'BrakeLight'),
                    # The side repeaters on the front fenders are white, the bumper corner markers amber.
                    (lambda c, n, m: m == 'Light' and abs(c.x) > 0.8 and -1.1 < c.y < -0.8 and 0.65 < c.z < 0.85, 'ClearLens'),
                    # The tail lamps' bands by position, once the cuts have made them straight: the
                    # texture's streaks and stripes left them patchy (dark specks in the red, the
                    # reverse lamp's white spilling past its block). Every face of the lamp is red,
                    # but the smoked band (0.806 to 0.850) dark with the reverse lamp
                    # bright at its outer end, and the fog block on the lower inner corner dark.
                    (lambda c, n, m: TAIL(c, n, m), 'TailLight'),
                    (lambda c, n, m: TAIL(c, n, m) and 0.806 < c.z < 0.85, 'Black'),
                    (lambda c, n, m: TAIL(c, n, m) and 0.806 < c.z < 0.85 and 0.672 < abs(c.x) < 0.72, 'Chrome'),
                    (lambda c, n, m: TAIL(c, n, m) and c.z < 0.75 and abs(c.x) < 0.588, 'Black')],
        # The paint disc behind the grille badge, and the roof antenna's stub. The disc's box stops
        # short of the bumper's top lip (z 0.57 to 0.585) and the hood's leading edge (from 0.685):
        # at 0.57 to 0.70 it cut both, and the shipped file had them filled back in by hand.
        # The badge's mount, a tab of the bumper's top lip rising into the gap under the grille's
        # bottom bar, and the bar stubs the badge cull leaves beside it (|x| under 0.09, z 0.586 to
        # 0.64): the reduction made them a wedge; cut (the grille piece's bars run across).
        'cull': [lambda c, n, m: m == 'Paint' and abs(c.x) < 0.075 and c.y < -1.98 and 0.59 < c.z < 0.68,
                 lambda c, n, m: m == 'Paint' and abs(c.x) < 0.09 and -2.09 < c.y < -2.02 and 0.6 < c.z < 0.64,
                 lambda c, n, m: m == 'Paint' and abs(c.x) < 0.045 and -2.09 < c.y < -2.07 and 0.586 < c.z < 0.6,
                 lambda c, n, m: m == 'Black' and abs(c.x) < 0.04 and 1.27 < c.y < 1.41 and c.z > 1.38],
        # The grille piece replaces the bars, so the bars the badge cull cuts are no longer bridged:
        # the bridge's loft welded the bumper's lip up into it, a wedge under the bottom bar.
        # The grille (two body colour bars from headlamp to headlamp over a black panel), rebuilt by
        # hand on 2026-10-27 because the reduction leaves a tangle of slivers in it, is kept as a
        # piece (wendtStrom.pieces.glb, save_pieces, box x 0.376, z 0.585 to 0.705, cutting every
        # shell face it hides) and spliced in on every rebuild. The lower intake was a piece too;
        # with the lamps and the shading kept the reduction now leaves it clean, and the old
        # piece carried that reduction's facets onto the bumper, so it went (2026-10-29).
        'pieces': True,
        # The headlamps' twin bowls kept round and alike side to side: a tighter error and the
        # budget for it (they were 4,000 at the cap, cut unevenly), the car's total raised with it.
        'lampBudget': 12000,
        'lampError': 0.0012,
        'carBudget': 28000,
        # After the splice: the bumper lip's faces fanned up to the cut bar stubs under the grille
        # piece's bottom bar (the black back panel shows there, as along the rest of the gap).
        'lowCull': [lambda c, n, m: m in ('Paint', 'Black') and abs(c.x) < 0.1 and -2.1 < c.y < -2.0 and 0.588 < c.z < 0.607,
                    lambda c, n, m: m == 'Black' and abs(c.x) < 0.03 and -2.08 < c.y < -2.06 and 0.6 < c.z < 0.615 and n.z > 0.3],
        # The hood's leading edge, a tight lip over the grille and lamps, is reduced with the lamps
        # at their finer error: in the shell's collapse it folded into teeth.
        'lamps': [lambda c, n, m: m == 'Paint' and abs(c.x) < 0.8 and c.y < -1.8 and 0.66 < c.z < 0.8,
                  # The three lower intakes (rims and pockets) likewise, so they come out clean
                  # and mirror side to side: in the shell's collapse their rims went jagged.
                  lambda c, n, m: m in ('Paint', 'Black') and abs(c.x) < 0.8 and c.y < -1.85 and 0.17 < c.z < 0.46],
        # The door handles and the mirrors: reduced and mirrored with the lamps, so they match
        # side to side (the shell's collapse cut each its own way).
        'details': [lambda c, n, m: 0.74 < abs(c.x) < 0.88 and 0.14 < c.y < 0.44 and 0.72 < c.z < 0.84,
                    lambda c, n, m: 0.69 < abs(c.x) < 1.02 and -0.76 < c.y < -0.5 and 0.85 < c.z < 1.06],
        # A black panel behind the grille, taller than its opening, so nothing shows through past
        # the piece's own back panel from an angle. Its ends stop at |x| 0.38, inside the headlamp
        # housings' inboard walls: at 0.42 it cut through the inner reflector bowls (as deep as
        # y -1.957 from x 0.395) and hid their inboard edge as a black crescent behind the lens.
        'backPanels': [(-0.38, 0.38, -1.95, 0.55, 0.72)],
    },
    'kazamaRotor': {
        'name': '1999 Mazda RX-7 (FD3S)',
        'uid': '06986b70c65b44c5a7315ed467b621a6',
        'author': 'niev',
        'license': 'CC Attribution',
        'mm': {'length': 4285, 'wheelbase': 2425},
        'turn': (-90, 0, 0),   # -Y up, nose at -Z
        # The tail lettering sits on a smooth panel, not in a recess: pressed flush, the panel dented.
        'press': False,
        # `material` is the wheels, Material__1..4 the number plates. The lamps are modelled in layers:
        # clear glass the covers and bulbs (the tail bar's one cover over three round lamps a side,
        # the pop-ups, the bumper lamps, the markers), orange glass the indicators and markers, red
        # glass the tail lamps' round lenses: those glow, the rest are unlit lenses.
        'materials': {r'^material$': None, r'^Material__\d$': None, r'^clearglass$': 'Lens', r'^orangeglass$': 'Light', r'^redglass$': 'TailLight',
                      r'^windowglass$': 'Glass', r'^carpaint$': 'Paint', r'^black$': 'Black', r'^chrome$': 'Chrome', r'^mirror$': 'Black'},
        # The pop-up lamps are modelled raised, as on the car: a shell in the body colour (lid and
        # both sides) over a black bucket, the bezel round the lamp. The bucket's ceiling behind the
        # lens lies a few mm under the lid, and the lamps' collapse pushed it through in black
        # patches: it is paint (the bezel's top lip, ahead of the lens, stays black). The pop-ups'
        # lamps glow whole: cover, reflector and bulb.
        'recolor': [(lambda c, n, m: m == 'Black' and POPUP(c) and c.y > -1.74 and c.z > 0.765 and abs(n.z) > 0.5, 'Paint'),
                    (lambda c, n, m: m in ('Lens', 'Chrome') and POPUP(c), 'HeadLight')],
        # The bumper lamps' two round lamps a side give way to clean discs (`cull`, then `discs`):
        # the collapse left them 8- to 10-sided and unalike (52 faces by the 60k skin). The inner,
        # clear one glows whole; the outer, amber one is the indicator, unlit. Each about its own
        # center (the donor's left lamps sit 5 mm further out than the right ones' mirror) and just
        # in front of its black bezel, whose lip stands 14 mm further forward on the left, under
        # the clear cover.
        'discs': [((0.5736, -1.925, 0.4705), 0.0325, 'HeadLight'), ((-0.5787, -1.925, 0.4705), 0.0325, 'HeadLight'),
                  ((0.6705, -1.875, 0.4793), 0.0335, 'Light'), ((-0.6756, -1.875, 0.4793), 0.0335, 'Light')],
        # The third brake light: the donor's four red blocks in the black pocket mid tail bar give
        # way to one thin strip arched along its top edge (6 mm under it), lit only under braking,
        # as on the car.
        'strips': [([(0, 2.095, 0.848), (0.04, 2.094, 0.846), (0.08, 2.093, 0.844), (0.12, 2.092, 0.842), (0.16, 2.09, 0.838)], 0.01, 'BrakeLight')],
        # The pop-ups are reduced with the lamps, at their tighter error: in the shell's collapse
        # their lids and housings went to a few coarse facets.
        'lamps': [lambda c, n, m: POPUP(c)],
        # What strip_wipers leaves (the blades: black islands of 184 to 248 faces, four on the cowl
        # and two on the hatch glass) and the antenna's base on the hatch; then the decklid lock,
        # pressed flush against the panel close round it (the 12 cm default ring reached the curve up
        # into the tail bar and dented it). By hand on the shipped file on 2026-10-29, kept here so
        # a rebuild does them, with the windshield seal's bottom edge in `cull`.
        'islands': [lambda k, a, b, mats: set(mats) == {'Black'} and k < 400 and -0.73 < (a.y + b.y) / 2 < -0.6 and 0.83 < (a.z + b.z) / 2 < 0.87,
                    lambda k, a, b, mats: set(mats) == {'Black'} and k < 400 and 1.25 < (a.y + b.y) / 2 < 1.4 and 1.0 < (a.z + b.z) / 2 < 1.1,
                    lambda k, a, b, mats: set(mats) == {'Black'} and k < 2500 and 0.35 < (a.x + b.x) / 2 < 0.39 and 1.8 < (a.y + b.y) / 2 < 1.85],
        'patches': [((-0.02, 2.1, 0.64), (0.02, 2.17, 0.685), ('Paint',), True, 0.04)],
        # The nose and tail badges and the tail lettering: chrome islands of 2,000 to 2,700 faces,
        # past the de-badge limit, which the tail lamps' chrome reflectors (1,856) must stay under.
        # The windshield seal's bottom edge: a thin strip on the glass the collapse folds into black
        # crosses above the cowl, and its right corner. Then the top of the cabin's mirror mount, which
        # stood through the roof. By hand on the shipped file on 2026-10-29.
        'cull': [lambda c, n, m: m == 'Black' and abs(c.x) < 0.5 and -0.78 < c.y < -0.665 and 0.8 < c.z < 0.87,
                 lambda c, n, m: m == 'TailLight' and abs(c.x) < 0.25 and c.y > 2.0,
                 lambda c, n, m: m in ('Lens', 'Chrome') and math.hypot(c.x - (0.5736 if c.x > 0 else -0.58), c.z - 0.4716) < 0.04 and -1.9 < c.y < -1.865,
                 lambda c, n, m: m in ('Light', 'Lens', 'Chrome') and math.hypot(c.x - (0.6705 if c.x > 0 else -0.6756), c.z - 0.4793) < 0.04 and -1.87 < c.y < -1.815,
                 lambda c, n, m: m == 'Black' and 0.39 < c.x < 0.68 and -0.67 < c.y < -0.47 and 0.8 < c.z < 0.85,
                 lambda c, n, m: m == 'Interior' and abs(c.x) < 0.035 and -0.1 < c.y < -0.03 and c.z > 1.15,
                 lambda c, n, m: m == 'Chrome' and abs(c.x) < 0.05 and c.y < -1.89 and 0.55 < c.z < 0.63,
                 lambda c, n, m: m == 'Chrome' and abs(c.x) < 0.05 and c.y > 2.11 and 0.68 < c.z < 0.77,
                 lambda c, n, m: m == 'Chrome' and 0.26 < abs(c.x) < 0.35 and c.y > 2.1 and 0.69 < c.z < 0.73],
    },
    'daltonFiend': {
        'name': '2018 Dodge Challenger SRT Demon (widebody)',
        'uid': '54d229c2c0ff4eac8bc872f50b25e36c',
        'author': 'SDC PERFORMANCE (Lambo_SC04)',
        'license': 'CC Attribution',
        'mm': {'length': 5017, 'wheelbase': 2951},
        # One mesh holds all four wheels: tires, rims, discs, calipers and lug parts in `GLASS`.
        'drop': [r'^desirefx\.me_077_43$'],
        # `CARS` is the paint; `material` (`material.005`; names match without the suffix) the
        # windows. `GLASS` (metallic grey) and `clearglass` are lamp reflectors and lenses, `GLSS`
        # and `Material` (`Material.115`) the tail bar's red, which AUTO would read as windows. `carpaint_second` is the black tail lamp housing. `Carbone` is the
        # hood, roof, trunk lid, ducktail, mirror shells, front splitter and grille block: parked
        # on Trim here and sorted by position below.
        'materials': {r'^CARS$': 'Paint', r'^material$': 'Glass', r'^Carbone$': 'Trim', r'^carpaint_second$': 'Black',
                      r'^(GLASS|GLSS|clearglass|lightglass|orangeglass|redglass|Material)$': 'Lamp'},
        # Stock is plain: the carbon panels are paint, but the splitter and the grille block (below
        # the hood's leading edge at z 0.85) stay black.
        'recolor': [(lambda c, n, m: m == 'Trim' and c.y < -1.75 and c.z < 0.82, 'Black'),
                    (lambda c, n, m: m == 'Trim', 'Paint')],
        # The fuel cap on the left rear quarter: an 11,000 face black disc standing off the panel.
        'patches': [((0.84, 1.52, 0.88), (0.95, 1.69, 1.01), ('Black', 'Paint'), True)],
    },
    'nakayaHorizon': {
        'name': 'Nissan Skyline R33 GT-R',
        'uid': '9107448c53f3452888f2ccf96acc3d3f',
        'author': 'greddy295',
        'license': 'CC Attribution',
        'mm': {'length': 4675, 'wheelbase': 2720},
        # Nose at -X; the import sits 1.12 m to one side, which donor_axles centers.
        'turn': (0, 0, 90),
        # `Profil` is the tread, a mesh of its own over `Tyre`; the wheels and the suspension (whose
        # pieces share Metal, Black_Metal and Exhaust with the body) go whole.
        'tires': r'^(Tyre|Profil)$',
        'drop': [r'^(Suspension|Wheels)'],
        # The badges are materials of their own (Red_R, Nissan, Silver_GT), dropped below; the
        # grilles are meshes of thousands of small flat cells that the badge passes would take.
        'debadge': False,
        # German names: Rcklichter the tail lamps, Blinker the indicators and fog lamps, Lamellen
        # the rear window's defroster lines, Schwarze_Fensterrahmen the black window frames.
        'materials': {r'^(Carcolor|Front_Bumper)$': 'Paint', r'^Rcklichter$': 'TailLight', r'^Blinker$': 'Lamp',
                      r'^(Windows|Lamellen)$': 'Glass', r'^(Exhaust|Metal|Mirror)$': 'Chrome',
                      r'^(Schwarze_Fensterrahmen|Upper_Cooler_Grid|Lower_Cooler_Grid|Gaps|Edge|Black_Metal)$': 'Black',
                      r'^(Red_R|Nissan|Silver_GT|GT_Detail_White|Ground|Rim_Color|Imbus|Spring|Breakmaterial|Break|Profil)$': None},
        # The donor is unfinished at the headlamps: an empty paint recess inside a black outline.
        # Its faces become the lens; the hood's leading edge above it (z over 0.68, facing up) stays.
        'recolor': [(lambda c, n, m: m == 'Paint' and 0.30 < abs(c.x) < 0.86 and 0.60 < c.z < 0.75 and c.y < -1.85
                     and not (c.z > 0.68 and n.z > 0.55), 'HeadLight'),
                    # Single faces at the recess's outer end, standing over the fender: paint.
                    (lambda c, n, m: m == 'HeadLight' and abs(c.x) > 0.78 and c.y > -1.92 and c.z > 0.6, 'Paint'),
                    # The red strip across the tail under the lamps is a reflector, the one on the
                    # wing the third brake light; the four round lamps glow.
                    (lambda c, n, m: m == 'TailLight' and c.y > 2.0 and c.z < 0.75, 'Reflector'),
                    (lambda c, n, m: m == 'TailLight' and c.y > 2.0 and c.z > 0.95, 'BrakeLight')],
        # The recess's faces are crumpled (the donor is unfinished there) and its tail lamps coarse:
        # the lamps reduce at the shell's error, which smooths the recess into a clean lens; at the
        # lamps' tighter one every crumple was kept.
        'lampError': 0.01,
        # The emblem's mounting plate in the upper grille: four small black islands at the center.
        'islands': [lambda k, a, b, mats: set(mats) == {'Black'} and 40 < k < 400 and abs((a.x + b.x) / 2) < 0.05
                    and (a.y + b.y) / 2 < -2.1 and 0.59 < (a.z + b.z) / 2 < 0.66],
    },
    'tachibanaZenith': {
        'name': 'Toyota Supra MK IV (1994)',
        'uid': 'eb9bb1eb41db431cb078088ae1ce45f8',
        'author': 'TinoD2',
        'license': 'CC Attribution',
        'mm': {'length': 4520, 'wheelbase': 2550},
        # Every material is TOYOTA_SUPRA_*. AUTO reads BRAKE_LIGHT as a brake (dropped), the lamp
        # housings (`HEADLIGHT_BASE_*`) and the lamp covers (`LIGHT_GLASS`) by their first keyword
        # (Lamp / Glass), and cannot read TEXTURES (the window seals, trim and exhaust pipe in one
        # 2048 px atlas), so those are set here. The model has no cabin: `interior()` fits one.
        'materials': {r'^TOYOTA_SUPRA_BRAKE_LIGHT$': 'TailLight', r'^TOYOTA_SUPRA_(LIGHT_GLASS|MAIN_LIGHT|TURNSIGNAL_LEFT|TURNSIGNAL_RIGHT)$': 'Lamp',
                      r'^TOYOTA_SUPRA_HEADLIGHT_BASE_PLASTIC$': 'Black', r'^TOYOTA_SUPRA_HEADLIGHT_BASE_CHROME$': 'Chrome',
                      r'^TOYOTA_SUPRA_TEXTURES$': 'Black'},
        # The front fender markers (ahead of the axle, so read as headlamps) are the indicators.
        'recolor': [(lambda c, n, m: m == 'HeadLight' and abs(c.x) > 0.8 and -1.8 < c.y < -1.6, 'Light')],
    },
    'tachibanaRunabout': {
        'name': '1996 Toyota MR2 W20',
        'uid': 'f66020ee62d741ebb0adc1ba351300db',
        'author': 's0h1o9b',
        'license': 'CC Attribution',
        'mm': {'length': 4170, 'wheelbase': 2400},
        # The import faces -X (nose at -X, tail at +X): turned a quarter to face -Y. Its size is the
        # ground plane's, so the scale comes from the wheelbase.
        'turn': (0, 0, 90),
        'rawNames': True,
        # Every material is `Material.0xx`, read from isolated renders: 016 the tire (the axles and
        # the track come from it); wheel pieces are 005 (lip), 014 (spokes), 019 (lug nuts), 017
        # (hubs and brake discs), so each wheel part's parent is dropped whole, with the ground plane.
        'tires': r'^Material\.016(\.\d{3})?$',
        'drop': [r'^(Plane\.00[4-9]_\d+|Plane\.01[0-2]_\d+|Cylinder\.00[1-4]_\d+)$'],
        # 001 windows, 003 black trim and seals, 004 / 005 / 007 / 017 the lamp lenses and housings
        # (by position), 010 chrome: logos (taken off as badges), exhaust tips and the diffuser
        # slats (black below), 012 the wing's stays, 015 the tail panel, 018 the mirror glass; 002
        # is the steering wheel and 006 four faces of nothing (the model has no cabin).
        # The nose strips are the indicators (Light, amber); the fog lamps stay lamps. The rear
        # diffuser's slats are `Material.010` chrome like the exhaust tips: black between the tips.
        'recolor': [(lambda c, n, m: m == 'HeadLight' and c.z > 0.38, 'Light'),
                    (lambda c, n, m: m == 'Chrome' and c.y > 1.5 and abs(c.x) < 0.335, 'Black')],
        # Black behind the front intake, whose crossbar and wheel liners show the underside through it.
        'backPanels': [(-0.62, 0.62, -1.88, 0.17, 0.42)],
        'materials': {r'^Material\.001$': 'Glass', r'^Material\.002$': None, r'^Material\.003$': 'Black',
                      r'^Material\.(004|005|007|017)$': 'Lamp', r'^Material\.006$': None, r'^Material\.010$': 'Chrome',
                      r'^Material\.(012|015|018)$': 'Black'},
    },
}

# Reproducibility test donors (CC Attribution): four body styles from four authors with four
# authoring styles. Not game cars; each recipe holds only the overrides AUTO cannot infer.
TEST_DONORS = {
    'testE30': {
        'name': '1988 BMW M3 (E30)', 'uid': 'ac3c7013434e403e8faff87948caf422', 'author': 'TinoD2', 'license': 'CC Attribution',
        'mm': {'length': 4345, 'wheelbase': 2565},
    },
    'testAE86': {
        'name': '1985 Toyota Sprinter Trueno (AE86)', 'uid': 'fe02fba6302e450ea8424591493341ea', 'author': 'Lexyc16', 'license': 'CC Attribution',
        'mm': {'length': 4205, 'wheelbase': 2400},
        # Every material is a numbered Material.0xx: classified by where its faces sit.
        'tires': r'^Material\.023$',
        'materials': {r'^Material\.(022|023|024)$': None, r'^Material\.01[34]$': 'Paint', r'^Material\.018$': 'Glass',
                      r'^Material\.(016|015|021|034)$': 'Lamp', r'^Material\.(017|019|020)$': 'Black',
                      r'^Material\.025$|^tofu_shop|^fposter': None},
    },
    'testPunto': {
        'name': '1995 Fiat Punto GT', 'uid': '48db6facb4b64e99b60f36b8c01185e1', 'author': 'lionsharp', 'license': 'CC Attribution',
        'mm': {'length': 3760, 'wheelbase': 2450},
        'materials': {r'^Hemi': None},
    },
    'testCutlass': {
        'name': '1971 Oldsmobile Cutlass Supreme sedan', 'uid': '78f76d386a4341b0b71745bdc50fd5ab', 'author': 'barbo-autos', 'license': 'CC Attribution',
        'mm': {'length': 5260, 'wheelbase': 2946},
        'tires': r'^M_Wheel$',
        'nose': '+y',   # modelled facing +y
        # M_Badge is also the bright trim strips; the badge island pass takes the lettering.
        'materials': {r'^M_Badge$': 'Chrome'},
    },
}
DONORS.update(TEST_DONORS)


def _base(name):
    return re.sub(r'\.\d{3}$', '', name)


def _lineage(o):
    """The object's name and its parents' names: the imports name parts on the empties above."""
    out = []
    while o is not None:
        out.append(_base(o.name))
        o = o.parent
    return out


def _descendants(o):
    out = [o]
    for c in o.children:
        out += _descendants(c)
    return out


# The default classes by material name, used after a recipe's own `materials`: most imports name
# their materials plainly, so a new donor's recipe holds only what these get wrong. Order matters.
AUTO = [
    (r'(?i)tire|tyre|rubber|llanta|rim|wheel|brake|disc|disk|calip|engine|badge|emblem|logo|licen[cs]e|plate|dome|shadow|ground|poster', None),
    # The cabin ships (reduced hard, seen through the glass): a car without one reads hollow.
    (r'(?i)interior|seat|dash|steer|headliner|carpet|cloth|leather|gauge|stitch|pedal|console', 'Interior'),
    # Before glass: `orangeglass` is an indicator lens, not a window.
    (r'(?i)indicator|blinker|turn.?signal|marker|amber|orange', 'Light'),
    (r'(?i)glass|window|windiw|vidrio', 'Glass'),
    (r'(?i)light|lamp|lens|reflector|luz', 'Lamp'),
    (r'(?i)paint|body|carroc', 'Paint'),
    (r'(?i)chrome|nickel|exhaust|metal', 'Chrome'),
    (r'(?i)black|plastic|trim|grill|rubber|detail|matte|mirror', 'Black'),
]
TIRES = r'(?i)tire|tyre|llanta'


_TEXTURES = {}


def _texture_map(mat):
    """The base colour image of a material as an (h, w, 3) array, cached by image name: the
    image texture feeding the Principled BSDF's Base Color, through any nodes between. None when
    the colour is not an image."""
    if not mat.node_tree:
        return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    stack = [bsdf.inputs['Base Color']] if bsdf else []
    while stack:
        sock = stack.pop()
        for link in sock.links:
            node = link.from_node
            if node.type == 'TEX_IMAGE' and node.image:
                im = node.image
                if im.name not in _TEXTURES:
                    w, h = im.size
                    a = np.empty(w * h * 4, np.float32)
                    im.pixels.foreach_get(a)
                    _TEXTURES[im.name] = a.reshape(h, w, 4)[..., :3]
                return _TEXTURES[im.name]
            stack += list(node.inputs)
    return None


def _sample(tex, f, uv):
    """The colour of `tex` at a bmesh face's UV center (its corners sit on band edges once the
    face is cut along them, and would pull in the neighbour's colour)."""
    h, w = tex.shape[:2]
    p = sum((l[uv].uv for l in f.loops), Vector((0, 0))) / len(f.loops)
    return tex[min(h - 1, int((p.y % 1) * h)), min(w - 1, int((p.x % 1) * w))]


def lamp_colour(rgb):
    """The shared class of a lamp face from the colour its texture paints it (recipe `texture`):
    red a tail lamp, amber an indicator, bright (reflectors, chrome, a clear lens) Chrome, the rest
    (housings, smoked bands) Black. The recipe's `recolor` then says which bright faces glow (the
    reflector bowls) or are clear (a reverse lamp), by position."""
    import colorsys
    h, s, v = colorsys.rgb_to_hsv(*[float(x) for x in rgb])
    if s > 0.4 and (h < 0.05 or h > 0.93):
        return 'TailLight'
    if s > 0.4 and h < 0.17:
        return 'Light'
    return 'Chrome' if v >= 0.35 else 'Black'


def _classify(R, mat_name):
    """The shared material for an import material, 'drop', or KeyError when nothing matches. The
    name is matched without Blender's `.001` suffix, which a second import in the session adds,
    unless the recipe sets `rawNames` (a donor whose materials are `Material.001`, `Material.002`:
    the suffix is the name)."""
    mat_name = mat_name if R.get('rawNames') else _base(mat_name)
    for pat, target in list(R.get('materials', {}).items()) + AUTO:
        if re.search(pat, mat_name):
            return 'drop' if target is None else target
    raise KeyError(f'{R["name"]}: no class for material {mat_name!r}')


def patch_out(o, lo, hi, mats=None, flush=True, ring=0.12, pin=False):
    """Remove a feature the generic car does without. flush=False: delete the faces centered in the
    box lo..hi (of `mats` only, when given): a part lying on the body (roof plate, antenna).
    flush=True: press it into its panel instead (sunroof, fuel door): fit a quadratic to the Paint
    faces in a `ring` around the box, in that panel's own frame (so a roof and a quarter panel work
    alike), move every vertex in the box onto it and paint the box's faces. The topology stays, so
    the reduction sees one smooth panel; deleting and covering leaves open, branching edges and
    overlaps that the collapse folds into dark slivers. `pin=True` moves only the vertices inside the box
    and keeps the stashed normals of the corners outside it: on a reduced donor a face centred on the
    feature can reach far past it (the Wendt Strom's fender repeaters: to the door's shut line), and the
    quadratic carried out there pulled the panel's edge 1 mm in from the door. Returns the faces changed."""
    import numpy as np
    inside = lambda c, m=0.0: all(lo[i] - m <= c[i] <= hi[i] + m for i in range(3))
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    hit = [f for f in bm.faces if inside(f.calc_center_median()) and (mats is None or names[f.material_index] in mats)]
    if not flush:
        bmesh.ops.delete(bm, geom=hit, context='FACES')
    else:
        paint = names.index('Paint')
        around = [f for f in bm.faces if f.material_index == paint and inside(f.calc_center_median(), ring) and not inside(f.calc_center_median(), 0.01)]
        n0 = sum((f.normal * f.calc_area() for f in around), Vector()).normalized()
        around = [f for f in around if f.normal.dot(n0) > 0.6]
        c0 = (lo + hi) / 2
        # The frame follows the car's axes (the two most across the panel).
        ax = sorted((Vector(a) for a in ((1, 0, 0), (0, 1, 0), (0, 0, 1))), key=lambda a: abs(a.dot(n0)))
        t1 = (ax[0] - n0 * ax[0].dot(n0)).normalized()
        t2 = n0.cross(t1)
        pts = [v.co for f in around for v in f.verts]
        uv = np.array([((p - c0).dot(t1), (p - c0).dot(t2)) for p in pts])
        h = np.array([(p - c0).dot(n0) for p in pts])
        A = np.column_stack([np.ones(len(uv)), uv[:, 0], uv[:, 1], uv[:, 0] ** 2, uv[:, 1] ** 2, uv[:, 0] * uv[:, 1]])
        k = np.linalg.lstsq(A, h, rcond=None)[0]
        surf = lambda u, v: k[0] + k[1] * u + k[2] * v + k[3] * u * u + k[4] * v * v + k[5] * u * v
        sn = bm.loops.layers.float_vector.get('src_normal')
        # Indices, not BMVerts: the wrappers do not hash stably (/blender, Known traps).
        bm.verts.index_update()
        bm.verts.ensure_lookup_table()
        moved = {v.index for f in hit for v in f.verts if not pin or inside(v.co, 0.001)}
        for v in (bm.verts[i] for i in moved):
            u, w = (v.co - c0).dot(t1), (v.co - c0).dot(t2)
            v.co = c0 + t1 * u + t2 * w + n0 * surf(u, w)
        for f in hit:
            f.material_index = paint
            f.normal_update()
            if f.normal.dot(n0) < 0:
                f.normal_flip()
            if sn is not None:
                for loop in f.loops:
                    if loop.vert.index not in moved:
                        continue
                    u, w = (loop.vert.co - c0).dot(t1), (loop.vert.co - c0).dot(t2)
                    du, dv = k[1] + 2 * k[3] * u + k[5] * w, k[2] + 2 * k[4] * w + k[5] * u
                    loop[sn] = (n0 - t1 * du - t2 * dv).normalized()
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(hit)


def blend_patch_normals(o, lo, hi, ring=0.05):
    """After `patch_out(..., flush=True)` on a piece with authored normals (between `stash_normals` and
    `restore_normals`): give every corner inside the box lo..hi the inverse cube weighted mean of the
    authored corner normals in a `ring` round it, on the same side of the car. The quadratic's own normals
    are right in shape but read a shade lighter than the donor's shading beside them (the Wendt Strom's
    Euro markers, its Shaved fenders); borrowing the surrounding normals hides where the feature was.
    Returns the corners changed."""
    me = o.data
    if not me.has_custom_normals:
        return 0
    inside = lambda c, m=0.0: all(lo[i] - m <= c[i] <= hi[i] + m for i in range(3))
    side = 1 if lo[0] + hi[0] > 0 else -1
    cn = [Vector(c.vector) for c in me.corner_normals]
    src, dst = [], []
    for p in me.polygons:
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if co.x * side <= 0:
                continue
            if inside(co, 0.001):
                dst.append((li, co.copy()))
            elif inside(co, ring):
                src.append((co.copy(), cn[li]))
    for li, co in dst:
        acc = Vector()
        for c, n in src:
            acc += n / max((c - co).length, 0.003) ** 3
        if acc.length > 0:
            cn[li] = acc.normalized()
    me.normals_split_custom_set(cn)
    me.update()
    return len(dst)


def close_opening(o, cut, ring=0.08, step=0.06, snap=0.004, back=None, fit_cut=True, degree=3):
    """Close an opening in a panel with a skin of its own (a sunroof delete, a shaved fuel door): the faces
    for which cut(face, material_name) is true go, and the one loop they leave in the panel is filled in the
    panel's plane (delaunay_2d_cdt over the loop and a grid every `step` m inside it, kept half a step off
    the loop), heights and normals from a polynomial fitted to the Paint in a `ring` round the loop and, with
    `fit_cut`, to the cut faces facing out with the panel (a flush glass or lid), in the panel's own frame as
    patch_out does. Loop vertices within `snap` of the surface move onto it and
    every corner on them takes the surface's normal, so the fill shades on from the panel without a ring.
    `back=(material, depth)` adds a copy of the fill `depth` m in along the normal, facing in: under a sunroof
    the headliner's hole would otherwise show the paint's back face (Paint is double sided in the game).
    patch_out(flush=True) presses a feature into its panel instead, and cannot close a sunroof whose glass
    sits in a gap open to the cabin (the Wendt Strom's): the pressed gap stays a slot round the panel.
    Returns (faces removed, faces made)."""
    import collections
    from mathutils.geometry import delaunay_2d_cdt
    stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    paint = names.index('Paint')
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    R = [f for f in bm.faces if cut(f, names[f.material_index])]
    for f in bm.faces:
        f.tag = False
    for f in R:
        f.tag = True
    adj = collections.defaultdict(list)
    for e in bm.edges:
        if any(f.tag for f in e.link_faces) and any(not f.tag for f in e.link_faces):
            a, b = e.verts
            adj[a].append(b)
            adj[b].append(a)
    if not adj or any(len(n) != 2 for n in adj.values()):
        raise RuntimeError('close_opening: the cut does not leave one simple loop')
    loop = [next(iter(adj))]
    while True:
        nx = [w for w in adj[loop[-1]] if len(loop) < 2 or w is not loop[-2]][0]
        if nx is loop[0]:
            break
        loop.append(nx)
    if len(loop) != len(adj):
        raise RuntimeError(f'close_opening: {len(adj) - len(loop)} vertices in a second loop')
    # The fit takes points sampled on the faces inside the ring, not their corners: a donor's long faces round
    # an opening reach down to the panel's edges (the roof's ditches), taking their far corners left the fit
    # 3.7 mm off, and the Wendt Strom's roof has no vertex at all within 8 cm of its sunroof.
    lo = Vector([min(v.co[i] for v in loop) - ring for i in range(3)])
    hi = Vector([max(v.co[i] for v in loop) + ring for i in range(3)])
    inbox = lambda p: all(lo[i] <= p[i] <= hi[i] for i in range(3))
    around = [f for f in bm.faces if not f.tag and f.material_index == paint and any(inbox(v.co) for v in f.verts)]
    n0 = sum((f.normal * f.calc_area() for f in around), Vector()).normalized()
    around = [f for f in around if f.normal.dot(n0) > 0.6]
    c0 = sum((v.co for v in loop), Vector()) / len(loop)
    ax = sorted((Vector(a) for a in ((1, 0, 0), (0, 1, 0), (0, 0, 1))), key=lambda a: abs(a.dot(n0)))
    t1 = (ax[0] - n0 * ax[0].dot(n0)).normalized()
    t2 = n0.cross(t1)
    uv = lambda p: Vector(((p - c0).dot(t1), (p - c0).dot(t2)))
    # A flush feature's own top (a sunroof's glass, a fuel door's lid) is the panel's shape where it sits: with
    # only the ring the Wendt Strom's fill rose 5 mm above where its glass was.
    pts = []
    for f in around + ([f for f in R if f.normal.dot(n0) > 0.95] if fit_cut else []):
        a = f.verts[0].co
        for b, c in zip([v.co for v in f.verts[1:-1]], [v.co for v in f.verts[2:]]):
            pts += [p for p in (a + (b - a) * (i / 8) + (c - a) * (j / 8) for i in range(9) for j in range(9 - i)) if inbox(p)]
    # A polynomial of `degree` in (u, w): a quadratic missed the Wendt Strom's roof by 2 mm rms, curving down
    # hard ahead of the sunroof over a nearly flat glass.
    terms = [(i, j) for i in range(degree + 1) for j in range(degree + 1 - i)]
    A = np.array([[u ** i * w ** j for i, j in terms] for u, w in (uv(p) for p in pts)])
    h = np.array([(p - c0).dot(n0) for p in pts])
    k = np.linalg.lstsq(A, h, rcond=None)[0]
    surf = lambda u, w: sum(c * u ** i * w ** j for c, (i, j) in zip(k, terms))
    du = lambda u, w: sum(c * i * u ** (i - 1) * w ** j for c, (i, j) in zip(k, terms) if i)
    dw = lambda u, w: sum(c * j * u ** i * w ** (j - 1) for c, (i, j) in zip(k, terms) if j)
    nrm = lambda u, w: (n0 - t1 * du(u, w) - t2 * dw(u, w)).normalized()
    at = lambda u, w: c0 + t1 * u + t2 * w + n0 * surf(u, w)
    rms = float(np.sqrt(np.mean((A @ k - h) ** 2)))
    moved = 0.0
    for v in loop:
        u, w = uv(v.co)
        d = surf(u, w) - (v.co - c0).dot(n0)
        if abs(d) <= snap:
            v.co += n0 * d
            moved = max(moved, abs(d))
    poly = [uv(v.co) for v in loop]
    if sum(poly[i - 1].x * poly[i].y - poly[i].x * poly[i - 1].y for i in range(len(poly))) < 0:
        loop.reverse()
        poly.reverse()
    inner = []
    u0, u1 = min(p.x for p in poly), max(p.x for p in poly)
    w0, w1 = min(p.y for p in poly), max(p.y for p in poly)
    nu, nw = max(1, int((u1 - u0) / step)), max(1, int((w1 - w0) / step))
    for i in range(nu + 1):
        for j in range(nw + 1):
            p = Vector((u0 + (u1 - u0) * i / nu, w0 + (w1 - w0) * j / nw))
            if _inside_2d(p, poly) and min(_seg_dist(p, poly[m - 1], poly[m]) for m in range(len(poly))) > step / 2:
                inner.append(p)
    _, _, ofaces, orig_v, _, _ = delaunay_2d_cdt(poly + inner, [], [list(range(len(poly)))], 1, 1e-7)
    verts = []
    for ov in orig_v:
        if not ov:
            raise RuntimeError('close_opening: the triangulation made a vertex of its own')
        i = ov[0]
        verts.append(loop[i] if i < len(loop) else bm.verts.new(at(*inner[i - len(loop)])))
    bmesh.ops.delete(bm, geom=R, context='FACES')
    for v in loop:
        for l in v.link_loops:
            if sn is not None:
                l[sn] = nrm(*uv(v.co))
    made = []
    for fc in ofaces:
        vs = [verts[i] for i in fc]
        if (vs[1].co - vs[0].co).cross(vs[2].co - vs[0].co).dot(n0) < 0:
            vs.reverse()
        f = bm.faces.new(vs)
        f.material_index = paint
        f.smooth = True
        made.append(f)
    if back:
        mi, depth = names.index(back[0]), back[1]
        under = {}
        for f in list(made):
            for v in f.verts:
                if v not in under:
                    under[v] = bm.verts.new(v.co - nrm(*uv(v.co)) * depth)
            g = bm.faces.new([under[v] for v in reversed(f.verts)])
            g.material_index = mi
            g.smooth = True
            made.append(g)
    if sn is not None:
        for f in made:
            for l in f.loops:
                n = nrm(*uv(l.vert.co))
                l[sn] = n if f.material_index == paint else -n
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    print(f'close_opening: {len(R)} faces out, loop of {len(loop)}, fit rms {rms * 1000:.2f} mm, loop snapped up to {moved * 1000:.1f} mm, {len(made)} faces in')
    return len(R), len(made)


def press_recesses(o, boxes, grow=0.02):
    """Press the panel flush where a removed badge sat. `boxes` are the (min, max) bounds of the
    deleted islands. A badge on a hood's leading edge or a bumper's top lip leaves a notch in the
    Paint around it, so every box with Paint faces within `grow` (2 cm) gets patch_out(flush=True)
    on its grown box. A badge in a grille has no Paint under it and is left to `bridges`. Returns
    how many were pressed."""
    names = [m.name.split('.')[0] for m in o.data.materials]
    # Copies, collected again after every press: `p.center` points into the mesh's polygon array,
    # which patch_out's to_mesh reallocates, and reading the old ones crashed Blender (2026-10-27).
    paint_centers = lambda: [p.center.copy() for p in o.data.polygons if names[p.material_index] == 'Paint']
    paint = paint_centers()
    pressed = 0
    for a, b in boxes:
        lo, hi = a - Vector((grow,) * 3), b + Vector((grow,) * 3)
        if not any(all(lo[i] <= c[i] <= hi[i] for i in range(3)) for c in paint):
            continue
        try:
            pressed += patch_out(o, lo, hi, ('Paint',), flush=True) > 0
        except (ValueError, np.linalg.LinAlgError) as err:
            print(f'badge recess at {fmt(lo)} not pressed ({err})')
        paint = paint_centers()
    return pressed


def strip_wipers(o, gap=0.08):
    """Delete the wipers: long (over 0.25 m), all-Black islands centered across the car with at
    least half their vertices within `gap` of the glass. Bounds alone cannot tell a blade lying
    diagonally on a sloped rear glass from a mirror; a mirror stands well off its window."""
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    glass = [p for p in me.polygons if names[p.material_index] == 'Glass']
    if not glass:
        return 0
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [list(p.vertices) for p in glass])
    bm = bmesh.new()
    bm.from_mesh(me)
    seen, doomed, n = set(), [], 0
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, grp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            grp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        if len(grp) > 800 or any(names[g.material_index] not in ('Black', 'Chrome') for g in grp):
            continue
        vs = list({v for g in grp for v in g.verts})
        lo = Vector(map(min, *(v.co for v in vs)))
        hi = Vector(map(max, *(v.co for v in vs)))
        if (hi - lo).length < 0.25:
            continue
        # Half on the glass (the pivot end sits on the cowl) and across the car: window seals and
        # pillar trims lie on the glass too, but along the sides.
        near = sum((tree.find_nearest(v.co)[3] or 1) < gap for v in vs) / len(vs)
        if near >= 0.5 and abs((lo.x + hi.x) / 2) < 0.55:
            doomed += grp
            n += 1
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bm.to_mesh(me)
    bm.free()
    me.update()
    # What the wipers leave: pivots, nozzles, the mirror's mount, small black bits lying on the
    # glass (the Golf's cowl kept ten of them, 2 to 5 cm each).
    n += delete_islands(o, lambda k, a, b, mats: k < 400 and set(mats) <= {'Black', 'Chrome'} and (b - a).length < 0.12
                        and (tree.find_nearest((a + b) / 2)[3] or 1) < 0.1)
    return n


def strip_antennas(o):
    """Delete antennas: small Black or Chrome islands reaching above the roof's top 10 cm with a
    footprint under 0.1 m across."""
    roof = max(v.co.z for v in o.data.vertices)

    def antenna(k, a, b, mats):
        return (not set(mats) - {'Black', 'Chrome'} and k < 600 and b.z > roof - 0.1
                and min((b - a).x, (b - a).y) < 0.1 and (b - a).length > 0.15)
    return delete_islands(o, antenna)


def _loop_params(chain, closed):
    """Arclength fraction (0..1) of each vertex along a chain; a closed ring wraps, so its last
    vertex is short of 1."""
    n = len(chain)
    seg = [(chain[(i + 1) % n].co - chain[i].co).length for i in range(n if closed else n - 1)]
    total = sum(seg) or 1.0
    out, acc = [0.0], 0.0
    for d in seg[:n - 1]:
        acc += d
        out.append(acc / total)
    return out


def _vertex_at(bm, chain, s, closed, snap=0.012):
    """The chain's vertex at arclength fraction s: the existing one within `snap`, else a new vertex
    split into the chain's edge there (chain is updated in place)."""
    par = _loop_params(chain, closed)
    for v, p in zip(chain, par):
        if abs(p - s) < snap:
            return v
    n = len(chain)
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        sa, sb = par[i], (par[j] if j else 1.0)
        if sa <= s <= sb:
            e = bm.edges.get((chain[i], chain[j]))
            _, nv = bmesh.utils.edge_split(e, chain[i], (s - sa) / max(sb - sa, 1e-9))
            chain.insert(i + 1, nv)
            return nv
    return chain[0]


def _end_chains(bm, x0, ylim, zlim, tol):
    """Ordered vertex chains (path or closed ring) of the open boundary edges lying on the plane
    x = x0: the cut ends of bars. Each starts at its highest vertex."""
    edges = [e for e in bm.edges if len(e.link_faces) == 1
             and all(abs(v.co.x - x0) < tol and zlim[0] <= v.co.z <= zlim[1] and ylim[0] <= v.co.y <= ylim[1] for v in e.verts)]
    adj = {}
    for e in edges:
        for v in e.verts:
            adj.setdefault(v, []).append(e)
    seen, out = set(), []
    for e in edges:
        if e in seen:
            continue
        comp, stack = set(), [e]
        seen.add(e)
        while stack:
            g = stack.pop()
            comp.add(g)
            for v in g.verts:
                for h in adj[v]:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        verts = {v for g in comp for v in g.verts}
        ends = [v for v in verts if sum(h in comp for h in adj[v]) == 1]
        closed = not ends
        start = max(verts, key=lambda v: (round(v.co.z, 4), -v.co.y)) if closed else max(ends, key=lambda v: (round(v.co.z, 4), -v.co.y))
        chain, prev, cur = [start], None, start
        while True:
            nxt = [h.other_vert(cur) for h in adj[cur] if h in comp and h.other_vert(cur) is not prev and h.other_vert(cur) not in chain]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            chain.append(cur)
        if len(chain) >= 2:
            out.append((chain, closed))
    return out


def bridge_bars(o, lo, hi, bow=0.002, steps=2, tol=0.015):
    """Continue the bars of a grille across a gap a badge left. The faces centered in the box lo..hi
    are deleted (a badge mount between the bar ends); then every bar end cut at the box's left face
    (x = lo.x) is matched with the end on the right face (same materials, nearest z) and lofted to it
    in `steps` bands of quads in the bar's own material, so the grille runs across in one piece with
    no step and no open end. Ends are found as open boundary edges within `tol` of each face plane
    and within the box's z (grown 1.5 cm) and y (grown 10 cm: a bar is deeper than the box, which
    should stay in front of the panel behind the grille). Ends with different vertex counts are
    split to match, so the seam stays watertight. `bow` pushes the middle toward the nose (-y) as a
    parabola, the grille's own curve across the car. Returns (faces deleted, faces added, bridges)."""
    lo, hi = Vector(lo), Vector(hi)
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    doomed = [f for f in bm.faces if all(lo[i] <= f.calc_center_median()[i] <= hi[i] for i in range(3))]
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    kept = len(bm.faces)
    ylim, zlim = (lo.y - 0.1, hi.y + 0.1), (lo.z - 0.015, hi.z + 0.015)
    left = _end_chains(bm, lo.x, ylim, zlim, tol)
    right = _end_chains(bm, hi.x, ylim, zlim, tol)
    mats = lambda ch: {f.material_index for a, b in zip(ch, ch[1:]) for e in [bm.edges.get((a, b))] if e for f in e.link_faces}
    mean_z = lambda ch: sum(v.co.z for v in ch) / len(ch)
    toward = Vector((0, -1, 0))
    bridges = 0
    for ca, closed in left:
        cands = [(abs(mean_z(cb) - mean_z(ca)), i) for i, (cb, cl) in enumerate(right) if cl == closed and mats(cb) == mats(ca)]
        if not cands:
            continue
        cb, _ = right.pop(min(cands)[1])
        # Ends from the same side of the cut are walked the same way (from the highest vertex);
        # mismatched counts are split to the union of both arclength fractions.
        if len(ca) != len(cb):
            fracs = sorted(set(_loop_params(ca, closed) + _loop_params(cb, closed)))
            keep = []
            for s in fracs:
                if not keep or s - keep[-1] > 0.012:
                    keep.append(s)
            a, b = list(ca), list(cb)
            ca, cb = [_vertex_at(bm, a, s, closed) for s in keep], [_vertex_at(bm, b, s, closed) for s in keep]
        n = len(ca)
        cols = [ca]
        for k in range(1, steps):
            t = k / steps
            cols.append([bm.verts.new(a.co.lerp(b.co, t) + toward * bow * 4 * t * (1 - t)) for a, b in zip(ca, cb)])
        cols.append(cb)
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            e = bm.edges.get((ca[i], ca[j]))
            ref = e.link_faces[0]
            for k in range(steps):
                f = bm.faces.new((cols[k][i], cols[k][j], cols[k + 1][j], cols[k + 1][i]))
                f.material_index = ref.material_index
                f.smooth = True
                f.normal_update()
                if f.normal.dot(ref.normal) < 0:
                    f.normal_flip()
                if sn is not None:
                    for loop in f.loops:
                        loop[sn] = f.normal
        bridges += 1
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    bm.to_mesh(me)
    added = len(bm.faces) - kept
    bm.free()
    me.update()
    _smooth_new_loops(me, len(me.polygons) - added)
    return len(doomed), added, bridges


def _smooth_new_loops(me, first):
    """Give the corners of polygons first.. their own face normal, for a mesh that carries custom
    normals: a bmesh round trip leaves new corners with none, which shade black in the viewport.
    (Blender averages custom normals within a smooth fan, so the old faces they touch shift a
    little; the export recomputes shading anyway.)"""
    if not me.has_custom_normals or first >= len(me.polygons):
        return
    cn = [Vector(c.vector) for c in me.corner_normals]
    for p in me.polygons[first:]:
        for li in p.loop_indices:
            cn[li] = Vector(p.normal)
    me.normals_split_custom_set(cn)


def donor_axles(objs, tire_pat, obj_pat=None):
    """(front axle y, rear axle y, tire radius, ground z, track, center x) from the faces of the tire
    material (on meshes under a part matching obj_pat, when given): split front and rear at their
    mean; the track is between the left and right tires' centers. The center is the tires' own
    middle when they sit more than 2 % of the wheelbase off x = 0 (the R33 import sat 1.12 m to one
    side), else 0, so a centered import keeps its exact placement."""
    pts = []
    for o in objs:
        if obj_pat and not any(re.search(obj_pat, n) for n in _lineage(o)):
            continue
        me, mw = o.data, o.matrix_world
        for p in me.polygons:
            m = me.materials[p.material_index] if me.materials else None
            if m and re.search(tire_pat, m.name):
                pts += [mw @ me.vertices[i].co for i in p.vertices]
    mid = sum(p.y for p in pts) / len(pts)
    front = [p for p in pts if p.y < mid]
    rear = [p for p in pts if p.y >= mid]
    ctr = lambda ps: (min(p.y for p in ps) + max(p.y for p in ps)) / 2
    r = max((max(p.z for p in ps) - min(p.z for p in ps)) / 2 for ps in (front, rear))
    cx = (min(p.x for p in front) + max(p.x for p in front)) / 2
    if abs(cx) < 0.02 * abs(ctr(rear) - ctr(front)):
        cx = 0.0
    left = [p.x - cx for p in front if p.x > cx]
    return ctr(front), ctr(rear), r, min(p.z for p in pts), min(left) + max(left), cx


def donor(cid, root):
    """Collect the import under `root` into `donor:<cid>`, drop and classify by the recipe and AUTO,
    scale it to the published wheelbase with the axles straddling the origin and the tires on the
    ground, and join into one mesh `donor:<cid>.Full`. Returns the object."""
    R = DONORS[cid]
    c = coll(f'donor:{cid}')
    for o in list(c.objects):
        bpy.data.objects.remove(o)
    for me in list(bpy.data.meshes):
        if me.name.startswith(f'donor:{cid}.') and not me.users:
            bpy.data.meshes.remove(me)
    bpy.context.view_layer.update()
    src = [o for o in _descendants(bpy.data.objects[root]) if o.type == 'MESH']
    # A model facing +y is turned to face -y first (recipe `nose`); one lying on its side is stood
    # up Z-up first (recipe `turn`, Euler degrees XYZ).
    turn = Matrix.Rotation(math.pi, 4, 'Z') if R.get('nose') == '+y' else Matrix.Identity(4)
    if R.get('turn'):
        turn = turn @ Euler([math.radians(a) for a in R['turn']]).to_matrix().to_4x4()
    if turn != Matrix.Identity(4):
        for o in src:
            o.matrix_world = turn @ o.matrix_world
        bpy.context.view_layer.update()
    try:
        fy, ry, r, ground, track, cx = donor_axles(src, R.get('tires', TIRES), R.get('tireObjects'))
    finally:
        if turn != Matrix.Identity(4):
            back = turn.inverted()
            for o in src:
                o.matrix_world = back @ o.matrix_world
            bpy.context.view_layer.update()
    # Scaled from the published wheelbase: an import's own size can be anything (a ground dome or a
    # backdrop in the scene sets Sketchfab's normalized size). The length is the check.
    k = R['mm']['wheelbase'] / 1000 / (ry - fy)
    move = Matrix.Scale(k, 4) @ Matrix.Translation((-cx, -(fy + ry) / 2, -ground)) @ turn
    fy, ry, r, track = fy * k, ry * k, r * k, track * k
    bm = bmesh.new()
    kept = dropped = 0
    for o in src:
        if any(re.search(p, n) for p in R.get('drop', ()) for n in _lineage(o)):
            dropped += 1
            continue
        me = o.data.copy()
        me.transform(move @ o.matrix_world)
        if (move @ o.matrix_world).determinant() < 0:
            me.flip_normals()
        # The authored shading, as plain vectors: the import's custom normals are encoded against
        # its own topology and scramble once pieces are welded and reduced; a vector attribute
        # rides through the join, the weld and the culling untouched (shade_from_source).
        # A flat shaded source has no shading to keep: smooth it by angle first (30 degrees), as
        # its author would have, or the reduced car inherits every facet.
        if not me.has_custom_normals and sum(p.use_smooth for p in me.polygons) < len(me.polygons) / 2:
            for p in me.polygons:
                p.use_smooth = True
            me.set_sharp_from_angle(angle=math.radians(30))
        sn = me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
        sn.data.foreach_set('vector', [x for c in me.corner_normals for x in c.vector])
        names = [_classify(R, m.name) if m else 'drop' for m in me.materials] or ['drop']
        # Lamps painted in a texture over their geometry (recipe `texture`): each face takes the
        # class of the colour under it, ahead of and behind the axles (between them the cabin's
        # lamps keep the positional pass).
        maps = [_texture_map(m) if m and any(re.search(t, _base(m.name)) for t in R.get('texture', ())) else None for m in me.materials]
        doomed = [p.index for p in me.polygons if names[p.material_index] == 'drop']
        tmp = bmesh.new()
        tmp.from_mesh(me)
        tmp.faces.ensure_lookup_table()
        bmesh.ops.delete(tmp, geom=[tmp.faces[i] for i in doomed], context='FACES')
        uv = tmp.loops.layers.uv.active
        half_wb = (ry - fy) / 2
        # A texture's bands rarely follow the lamp's faces: cut the textured faces along the band
        # edges first (recipe `textureCuts`, (axis, value) in car space, mirrored across x = 0
        # for 'x'), so each piece lies in one colour and the edges run straight.
        cuts = R.get('textureCuts', ())
        if cuts and any(m is not None for m in maps):
            for axis, value in cuts:
                for v in ((value, -value) if axis == 'x' else (value,)):
                    faces = [f for f in tmp.faces if maps[f.material_index] is not None and abs(f.calc_center_median().y) > half_wb]
                    if not faces:
                        continue
                    geom = list({e for f in faces for e in f.edges}) + faces + list({x for f in faces for x in f.verts})
                    no = Vector((1, 0, 0)) if axis == 'x' else Vector((0, 1, 0)) if axis == 'y' else Vector((0, 0, 1))
                    bmesh.ops.bisect_plane(tmp, geom=geom, plane_co=no * v, plane_no=no)
            tmp.faces.ensure_lookup_table()
        # Every piece indexes the full shared list ('Lamp' resolved after the join), so they merge as is.
        for f in tmp.faces:
            n = names[f.material_index]
            tex = maps[f.material_index]
            if tex is not None and uv is not None and abs(f.calc_center_median().y) > half_wb:
                n = R.get('textureClass', lamp_colour)(_sample(tex, f, uv))
            f.material_index = SHARED.index('HeadLight' if n == 'Lamp' else n) + (100 if n == 'Lamp' else 0)
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        kept += 1
    # Lamps by position: ahead of the axles HeadLight, behind TailLight, between Light; one inside
    # the cabin (well inboard, between the axles) is a dome or dash lamp: Interior.
    half = (ry - fy) / 2
    hw = max(abs(v.co.x) for v in bm.verts)
    for f in bm.faces:
        if f.material_index >= 100:
            q = f.calc_center_median()
            inside = abs(q.y) < half - 0.2 and abs(q.x) < 0.7 * hw
            f.material_index = SHARED.index('Interior' if inside else 'HeadLight' if q.y < -half else 'TailLight' if q.y > half else 'Light')
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    me = bpy.data.meshes.new(f'donor:{cid}.Full')
    for u in SHARED:
        me.materials.append(shared_mat(u))
    bm.to_mesh(me)
    bm.free()
    full = bpy.data.objects.new(f'donor:{cid}.Full', me)
    c.objects.link(full)
    for pred, name in R.get('recolor', ()):
        recolor(full, pred, name)
    for pred in R.get('cull', ()):
        delete_faces(full, pred)
    for pred in R.get('islands', ()):
        delete_islands(full, pred)
    for lo, hi, mats, flush, *ring in R.get('patches', ()):
        print(f'{cid}: patched {patch_out(full, Vector(lo), Vector(hi), mats, flush, *ring)} faces')
    # Hubs, lug nuts, calipers and discs the material names did not give away (the RX-7's are
    # plain black and chrome): loose islands inside the tires' cylinders, out at the track.
    hubs = delete_islands(full, lambda k, a, b, mats: 'Paint' not in mats and abs((a.x + b.x) / 2) > track / 2 - 0.3
                          and any(math.hypot((a.y + b.y) / 2 - ay, (a.z + b.z) / 2 - r) < 0.85 * r for ay in (fy, ry)))
    print(f'{cid}: {strip_wipers(full)} wipers removed, {strip_antennas(full)} antennas removed')
    # De-badge: lettering and logos are small loose all-Black (formerly chrome) islands on the nose
    # and tail, above exhaust tip height; a generic car carries none. A finely modelled logo runs
    # past a thousand faces (the Golf's are 900 and 1,168).
    ends = (ry - fy) / 2 + 0.25
    # The bounds of every badge island that goes, to press the panel it sat on flush below.
    gone = []

    # What sits inside a lamp's clear cover (reflector rings, bulbs) is the lamp, never a badge: the
    # RX-7's tail lamp reflectors went as badges, and pressing them flush dented the tail panel.
    in_lamp = _inside_lenses(full)

    def badge(pred):
        def wrapped(k, a, b, mats):
            hit = not in_lamp((a + b) / 2) and pred(k, a, b, mats)
            if hit:
                gone.append((a.copy(), b.copy()))
            return hit
        return wrapped
    # Recipe `debadge: False` skips both passes, for a donor whose badges are materials of their own
    # (dropped above) and whose grilles are meshes of thousands of small flat cells (the R33's).
    badges = 0
    if R.get('debadge', True):
        badges = delete_islands(full, badge(lambda k, a, b, mats: set(mats) <= {'Black', 'Chrome'} and max((b - a).x, (b - a).z) < 0.3
                                            and abs((a.y + b.y) / 2) > ends and (a.z + b.z) / 2 > 0.45 and k < 1500))
        # Anywhere on the body: emblems, scripts and stickers are thin (under 12 mm) and small (under
        # 0.35 m) loose islands of any paint-free material, lying on a panel. Lamps and glass are not.
        badges += delete_islands(full, badge(lambda k, a, b, mats: k < 300 and not set(mats) & {'Glass', 'Paint', *LAMP_MATS}
                                             and sorted(b - a)[0] < 0.012 and sorted(b - a)[2] < 0.35 and (a.z + b.z) / 2 > 0.2))
    # Recipe `press`: False presses nothing, a predicate on a box's center (Vector) only those.
    press = R.get('press', True)
    pressed = press_recesses(full, gone if press is True else [b for b in gone if press((b[0] + b[1]) / 2)]) if press else 0
    print(f'{cid}: pressed {pressed} badge recesses flush ({len(gone)} badge islands removed)')
    for lo, hi in R.get('bridges', ()):
        d, a, n = bridge_bars(full, lo, hi)
        print(f'{cid}: bridged {n} grille bars across {fmt(Vector(lo))}..{fmt(Vector(hi))} ({d} faces removed, {a} added)')
    remap_materials(full)
    ln = (max(v.co.y for v in me.vertices) - min(v.co.y for v in me.vertices)) * 1000
    full['wheelbase'], full['tireRadius'] = ry - fy, r
    full['track'] = track
    print(f'{cid}: kept {kept} meshes, dropped {dropped}, {badges} badge islands, {hubs} wheel hub islands; scaled x{k:.3f} to the published wheelbase, length {ln:.0f} mm '
          f'(published {R["mm"]["length"]}, {(ln / R["mm"]["length"] - 1) * 100:+.1f}%), tire radius {r:.3f} m, {tris(full)} tris')
    return full


def donor_score(cid, root):
    """Pre-flight for a candidate source, before any work: what AUTO classifies on its own, what is
    left to the recipe, and the traits that predicted trouble in the reproducibility test:
    - weighted normals (over 8 % of paint corners far off their face; the E30 and the WRX streak),
    - lamps only in a texture (no lamp material: the Punto),
    - unnamed materials (Material.0xx: the AE86 needed a full recipe),
    - a source already near the budget (little to reduce, little detail to keep),
    - no tire material (the axles and scale come from it).
    Prints a scorecard and returns (risks, unknown materials)."""
    R = DONORS.get(cid, {'name': cid, 'mm': {}})
    src = [o for o in _descendants(bpy.data.objects[root]) if o.type == 'MESH']
    faces, by = 0, {}
    for o in src:
        me = o.data
        for p in me.polygons:
            m = me.materials[p.material_index].name if me.materials and me.materials[p.material_index] else '-'
            by[m] = by.get(m, 0) + 1
            faces += 1
    classes, unknown = {}, []
    for m, n in by.items():
        try:
            c = _classify(R, m)
        except KeyError:
            c = '?'
            unknown.append(m)
        classes[c] = classes.get(c, 0) + n
    auto = sum(n for m, n in by.items() if not any(re.search(p_, m) for p_ in R.get('materials', {})) and m not in unknown)
    paint_off = paint_n = 0
    for o in src:
        me = o.data
        names = [m.name if m else '-' for m in me.materials]
        if not names:
            continue
        cn = me.corner_normals
        for p in me.polygons:
            try:
                if _classify(R, names[p.material_index]) != 'Paint':
                    continue
            except KeyError:
                continue
            for li in p.loop_indices:
                paint_n += 1
                paint_off += cn[li].vector.dot(p.normal) < 0.8
    weighted = paint_off / max(1, paint_n)
    tires = any(re.search(R.get('tires', TIRES), m) for m in by)
    risks = []
    if unknown:
        risks.append(f'{len(unknown)} materials AUTO cannot read: {unknown[:6]}')
    if not tires:
        risks.append('no tire material: set `tires`')
    if 'Lamp' not in classes and 'HeadLight' not in classes:
        risks.append('no lamp material: lamps are probably in a texture')
    if weighted > 0.08:
        risks.append(f'weighted normals ({weighted:.0%} of paint corners): expect streaks after reduction')
    if faces < 2 * BUDGET:
        risks.append(f'only {faces} faces: close to the budget')
    if sum(1 for m in by if re.match(r'(?i)^material(\.\d+)?$', m)) > len(by) / 2:
        risks.append('mostly unnamed materials: the recipe will classify by position')
    print(f"{cid}: {R['name']} ({R.get('license', '?')}), {faces} faces, {len(by)} materials, {auto / max(1, faces):.0%} of faces classified by AUTO")
    print('  classes: ' + ', '.join(f'{k} {v}' for k, v in sorted(classes.items(), key=lambda kv: -kv[1])))
    print('  risks: ' + ('; '.join(risks) if risks else 'none'))
    return risks, unknown


def _apply(o, mod):
    """Apply a modifier even while the object's collection is hidden (the operator needs it visible
    and active)."""
    lcs = []
    def find(lc):
        if o.name in lc.collection.objects:
            lcs.append(lc)
        for c in lc.children:
            find(c)
    find(bpy.context.view_layer.layer_collection)
    was = [(lc, lc.hide_viewport, lc.exclude) for lc in lcs]
    for lc in lcs:
        lc.hide_viewport = lc.exclude = False
    hidden = o.hide_get()
    o.hide_set(False)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=mod.name)
    o.hide_set(hidden)
    for lc, h, e in was:
        lc.hide_viewport, lc.exclude = h, e


def _view_dirs(n=160, min_z=-0.35):
    """Roughly even directions over the sphere (a Fibonacci spiral), skipping the ones from far
    below: nobody looks at a car from under the road."""
    out = []
    for i in range(n):
        z = 1 - 2 * (i + 0.5) / n
        if z < min_z:
            continue
        r = math.sqrt(1 - z * z)
        a = i * math.pi * (3 - math.sqrt(5))
        out.append(Vector((r * math.cos(a), r * math.sin(a), z)))
    return out


def cull_hidden(o, dirs=None, through=('Glass', 'Lens')):
    """Keep only the outer skin: a face survives when a ray from it escapes the car in some view
    direction, from its front or its back (then it is flipped to face out). Inner door jambs,
    panel flanges, double layers and anything boxed in go: they are invisible, cost triangles, and
    a collapse that welds them to the skin is what blotches a reduced car. The `through` materials
    (glass, lamp covers) do not block a ray: what sits behind a window, the cabin, is seen in the game too,
    and so are a lamp's reflectors and bulbs behind its clear cover.
    Returns (deleted, flipped)."""
    dirs = dirs or _view_dirs()
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    clear = {i for i, m in enumerate(o.data.materials) if m and m.name.split('.')[0] in through}
    tree = BVHTree.FromPolygons([v.co for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces if f.material_index not in clear]) if clear else BVHTree.FromBMesh(bm)
    gone, flip = [], []
    for f in bm.faces:
        c, n = f.calc_center_median(), f.normal
        # The center and points toward each corner: a face in a recess (cowl, arch lip) may be
        # seen only past one of its edges.
        pts = [c] + [c.lerp(v.co, 0.8) for v in f.verts]
        seen = {}
        for side in (1, -1):
            for p in pts:
                org = p + n * (side * 2e-3)
                if any(d.dot(n) * side > 0.05 and tree.ray_cast(org, d)[0] is None for d in dirs):
                    seen[side] = True
                    break
            if seen.get(1):
                break
        if not seen:
            gone.append(f)
        elif not seen.get(1):
            flip.append(f)
    # Glass keeps only its outer layer: an inner pane seen through the other windows survives the
    # ray test, and the collapse folds the two layers into dark wedges. A lamp cover likewise: it is
    # modelled as a solid, and its inner face doubles the triangles and the sheen.
    gi = [i for i, m in enumerate(o.data.materials) if m and m.name.split('.')[0] in ('Glass', 'Lens')]
    zc = sum(v.co.z for v in bm.verts) / max(1, len(bm.verts))
    for f in bm.faces:
        if f.material_index in gi and f not in gone:
            c = f.calc_center_median()
            n = -f.normal if f in flip else f.normal
            if n.dot(c - Vector((0, c.y * 0.5, zc))) < 0:
                gone.append(f)
    flip = [f for f in flip if f not in set(gone)]
    sn = bm.loops.layers.float_vector.get('src_normal')
    for f in flip:
        f.normal_flip()
        if sn is not None:
            for loop in f.loops:
                loop[sn] = -loop[sn]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return len(gone), len(flip)


def _collapse(o, budget, finish=True, error=None, flags=(), lock=None):
    """Planar dissolve then a collapse to about `budget` triangles: meshoptimizer's, which weighs
    the `src_normal` shading and keeps material edges, as far as it goes without tearing parts
    off; the Decimate modifier's mirror-symmetric collapse finishes the rest (all of it with
    REDUCER = 'blender'). `error` overrides meshoptimizer's stop (MESHOPT['max_error']), `flags`
    go to it ('LockBorder'), `lock` names a boolean face attribute whose faces' vertices stay put
    (through the Decimate too, and no planar dissolve then: it would merge across them), and
    `finish=False` stops where it stops, over the budget, for a piece the Decimate would mangle."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    if not lock:
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(2.0), verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()
    have = tris(o)
    if have > budget and REDUCER == 'meshopt':
        have = meshopt_reduce(o, budget, uv=False, error=error, flags=flags, lock=lock)[0]
    if have > budget and finish:
        mod = o.modifiers.new('reduce', 'DECIMATE')
        if lock and lock in o.data.attributes:
            held = {v for p, f in zip(o.data.polygons, o.data.attributes[lock].data) if f.value for v in p.vertices}
            vg = o.vertex_groups.new(name='free')
            vg.add([v.index for v in o.data.vertices if v.index not in held], 1.0, 'REPLACE')
            mod.vertex_group = vg.name
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = budget / have
        mod.use_collapse_triangulate = True
        mod.use_symmetry = True
        mod.symmetry_axis = 'X'
        _apply(o, mod)


def _copy(src, name):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old)
    o = src.copy()
    o.data = src.data.copy()
    o.name = o.data.name = name
    src.users_collection[0].objects.link(o)
    return o


def shade_from_source(low, skin):
    """Custom normals on `low` copied from the source's authored normals (the `src_normal` corner
    attribute on `skin`): each corner of a reduced face looks up the nearest point of the skin from
    a little inside its own face, so it lands on the right side of a crease, and takes the
    barycentric blend of that skin triangle's corner normals."""
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.faces.ensure_lookup_table()
    sn = bm.loops.layers.float_vector['src_normal']
    tree = BVHTree.FromBMesh(bm)
    # One tree per material too: a glass face must not take its shading from the black surround
    # just behind it.
    skin_names = [m.name.split('.')[0] for m in skin.data.materials]
    by_mat = {}
    for f in bm.faces:
        by_mat.setdefault(skin_names[f.material_index], []).append(f)
    trees = {n: (BVHTree.FromPolygons([v.co for v in bm.verts], [[v.index for v in f.verts] for f in fs]), fs) for n, fs in by_mat.items()}
    me = low.data
    low_names = [m.name.split('.')[0] for m in me.materials]

    def nearest(q, mat):
        """(location, skin face) nearest q among skin faces of the same material, else any."""
        if mat in trees:
            t, fs = trees[mat]
            loc, _, i, _ = t.find_nearest(q)
            if loc is not None:
                return loc, fs[i]
        loc, _, fi, _ = tree.find_nearest(q)
        return loc, bm.faces[fi]
    # Faces the collapse folded over (or the culling read the wrong way) face against the authored
    # shading and render dark: turn them to agree with it first.
    lbm = bmesh.new()
    lbm.from_mesh(me)
    hc = lbm.faces.layers.int.get('own_normals')
    turned = 0
    for f in lbm.faces:
        if hc is not None and f[hc]:
            continue
        loc, sf = nearest(f.calc_center_median(), low_names[f.material_index])
        src = sum((l[sn] for l in sf.loops), Vector())
        if src.length > 1e-6 and f.normal.dot(src) < 0:
            f.normal_flip()
            turned += 1
    lbm.to_mesh(me)
    lbm.free()
    me.update()
    hca = me.attributes.get('own_normals')
    own = [bool(v.value) for v in hca.data] if hca else [False] * len(me.polygons)
    for p in me.polygons:
        p.use_smooth = True
    out = []
    for p in me.polygons:
        if own[p.index]:
            # Faces built here (grille quads) keep their own flat normals.
            out += [p.normal.copy()] * p.loop_total
            continue
        c = p.center
        for li in p.loop_indices:
            q = me.vertices[me.loops[li].vertex_index].co.lerp(c, 0.25)
            loc, f = nearest(q, low_names[p.material_index])
            a, b, cc = (l.vert.co for l in f.loops)
            w = barycentric(loc, a, b, cc)
            n = sum((l[sn] * wi for l, wi in zip(f.loops, w)), Vector())
            out.append(n.normalized() if n.length > 1e-6 else p.normal.copy())
    bm.free()
    me.normals_split_custom_set(out)
    return turned


def barycentric(p, a, b, c):
    """Barycentric weights of p (on or near triangle abc), clamped to the triangle."""
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01 or 1e-12
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    u = 1 - v - w
    ws = [max(0.0, x) for x in (u, v, w)]
    t = sum(ws) or 1
    return [x / t for x in ws]


# ----- repairs on a shipped body ---------------------------------------------
# Hand edits on `<cid>.Body` once its parts are cut from it (a reimport through ship_donor would drop
# them; docs/carDonors.md, "Repairs on a shipped body"). Each samples the shading skin
# (`donor:<cid>.Skin`, its `src_normal` corners) and goes through stash_normals / restore_normals,
# so every face it does not touch keeps its authored normals.

def _skin_trees(skin):
    """The skin triangulated: (bmesh, src_normal layer, {material: (BVHTree, faces)}). Free the bmesh."""
    sbm = bmesh.new()
    sbm.from_mesh(skin.data)
    bmesh.ops.triangulate(sbm, faces=sbm.faces[:])
    sbm.faces.ensure_lookup_table()
    names = [m.name.split('.')[0] for m in skin.data.materials]
    by = {}
    for f in sbm.faces:
        by.setdefault(names[f.material_index], []).append(f)
    co = [v.co for v in sbm.verts]
    trees = {n: (BVHTree.FromPolygons(co, [[v.index for v in f.verts] for f in fs]), fs) for n, fs in by.items()}
    return sbm, sbm.loops.layers.float_vector['src_normal'], trees


def _skin_normal(f, sn, loc):
    """The skin's authored normal at `loc` on its triangle `f`."""
    a, b, c = (l.vert.co for l in f.loops)
    n = sum((l[sn] * w for l, w in zip(f.loops, barycentric(loc, a, b, c))), Vector())
    return n.normalized() if n.length > 1e-6 else None


def reshade(o, skin, pred, inset=0.002, skip=('Glass', 'Lens', 'ClearLens')):
    """shade_from_source with a fixed inset, on the faces for which pred(center, normal, material) holds:
    each corner takes the skin's normal `inset` m in from the corner (at most a quarter of the way to the
    face's centre), from skin faces of its own material. shade_from_source samples a quarter of the way in,
    which on a long collapse triangle lands centimetres from the corner, so two triangles sharing a corner
    disagree and read as facets (the Wendt Strom's hood lip and mirror panels). Returns the faces done."""
    sbm, ssn, trees = _skin_trees(skin)
    stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    done = 0
    for f in bm.faces:
        m = names[f.material_index]
        c = f.calc_center_median()
        if m in skip or m not in trees or not pred(c, f.normal, m):
            continue
        t, fs = trees[m]
        for l in f.loops:
            d = c - l.vert.co
            q = l.vert.co + d.normalized() * min(inset, d.length * 0.25) if d.length > 1e-9 else l.vert.co
            loc, _, i, _ = t.find_nearest(q)
            n = _skin_normal(fs[i], ssn, loc) if loc is not None else None
            if n is not None and n.dot(f.normal) > 0.2:
                l[sn] = n
        done += 1
    bm.to_mesh(me)
    bm.free()
    sbm.free()
    restore_normals(o)
    return done


def densify_on_skin(o, skin, pred, max_edge=0.02, passes=4):
    """Split every edge longer than `max_edge` on the faces for which pred(center, normal, material) holds
    and put each new vertex on the skin (its nearest point among skin faces of the vertex's material, when
    within 1 cm): vertices where the collapse spanned a curve with one flat triangle (the Wendt Strom's
    mirror panels: a 15 cm2 triangle across the panel's rounded rim). Shading after it is reshade()'s job.
    Only the vertices the split returns move: BMVert wrappers do not hash stably, and a set difference of
    bm.verts once snapped 2,500 vertices all over the body. Returns the vertices added."""
    sbm, _, trees = _skin_trees(skin)
    carry = stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    added = 0
    for _ in range(passes):
        region = {f for f in bm.faces if pred(f.calc_center_median(), f.normal, names[f.material_index])}
        long_e = [e for e in bm.edges if e.calc_length() > max_edge and any(f in region for f in e.link_faces)]
        if not long_e:
            break
        ret = bmesh.ops.subdivide_edges(bm, edges=long_e, cuts=1, use_grid_fill=False)
        for v in [g for g in ret['geom_split'] if isinstance(g, bmesh.types.BMVert)]:
            mats = {names[f.material_index] for f in v.link_faces}
            t = trees.get(next(iter(mats))) if len(mats) == 1 else None
            if t is not None:
                loc = t[0].find_nearest(v.co)[0]
                if loc is not None and (loc - v.co).length < 0.01:
                    v.co = loc
            added += 1
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(me)
    bm.free()
    sbm.free()
    if carry:
        restore_normals(o)
    return added


def skin_islands(skin, box, max_faces=5000):
    """Face indices of the skin's small islands (under `max_faces`) with a face centred in box(center):
    details the donor models apart from the shell (mirrors), whole and with the source's normals."""
    sbm = bmesh.new()
    sbm.from_mesh(skin.data)
    sbm.faces.ensure_lookup_table()
    seen, out = set(), set()
    for f in sbm.faces:
        if f.index in seen or not box(f.calc_center_median()):
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g.index)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        if len(comp) < max_faces:
            out |= set(comp)
    sbm.free()
    return out


def swap_islands(o, skin, box, near=0.015):
    """Replace a body's reduced copy of the skin's small islands in box(center) (skin_islands) with the
    islands themselves: the body's faces in the box nearer the islands than the shell round them go, and
    so do faces within `near` of the islands that lie more than 3 mm off both (what the collapse welded
    between them); the islands come in verbatim with their src_normal corners. The Wendt Strom's mirrors,
    reduced with a box of the door round them (recipe `details`), had their bases welded into the door in
    jagged black wedges; the skin's own (1,551 and 1,554 faces) replaced them. Returns (removed, added)."""
    isl = skin_islands(skin, box)
    sbm = bmesh.new()
    sbm.from_mesh(skin.data)
    sbm.faces.ensure_lookup_table()
    co = [v.co.copy() for v in sbm.verts]
    t_isl = BVHTree.FromPolygons(co, [[v.index for v in sbm.faces[i].verts] for i in isl])
    t_shell = BVHTree.FromPolygons(co, [[v.index for v in f.verts] for f in sbm.faces if f.index not in isl and box(f.calc_center_median())])
    stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        if not box(c):
            continue
        di = t_isl.find_nearest(c)[3]
        h = t_shell.find_nearest(c)
        ds = h[3] if h[0] is not None else 9
        if di < ds or (di < near and ds > 0.003):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    ssn = sbm.loops.layers.float_vector['src_normal']
    snames = [m.name.split('.')[0] for m in skin.data.materials]
    vmap = {}
    for i in sorted(isl):
        sf = sbm.faces[i]
        vs = []
        for v in sf.verts:
            if v.index not in vmap:
                vmap[v.index] = bm.verts.new(v.co)
            vs.append(vmap[v.index])
        f = bm.faces.new(vs)
        f.material_index = names.index(snames[sf.material_index])
        f.smooth = True
        for l, sl in zip(f.loops, sf.loops):
            l[sn] = sl[ssn]
    sbm.free()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return len(kill), len(isl)


def _boundary_loops(bm):
    """The boundary edge loops of a bmesh, each an ordered vertex list (vertices on more than two boundary
    edges end a loop early, which the callers check for)."""
    adj = {}
    for e in bm.edges:
        if len(e.link_faces) == 1:
            a, b = e.verts
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    loops, seen = [], set()
    for v0 in adj:
        if v0 in seen:
            continue
        loop = [v0]
        seen.add(v0)
        while True:
            nx = [w for w in adj[loop[-1]] if w not in seen]
            if not nx:
                break
            loop.append(nx[0])
            seen.add(nx[0])
        loops.append(loop)
    return loops


def feature_nodes(o, skin, rect, y_min, inset=0.005, ring=0.025, step=0.01, off='shavedHatch_off', on='shavedHatch_on'):
    """A body feature the garage switches (render/car/bodyFeatures.ts, nodes `<feature>_off` and `<feature>_on`)
    cut out of a rear facing panel as two pieces of its own: the body gets a clean rectangular hole at
    `rect` = (x0, x1, z0, z1) (faces with y over `y_min`), `on` is that hole closed flush (close_opening's fitted
    cubic, the loop unmoved, so it meets the body without a crack) and `off` is the shading skin's full detail
    feature (the source's own faces and normals, cut at the rect shrunk by `inset`) joined to the hole's loop by
    a band triangulated between the two loops. Each piece shares the hole's loop and its fitted corner normals.
    The Wendt Strom's hatch handle was the reduced body's (a few long fans) and the shaved switch pressed its
    vertices flat at load, which left black slivers of the lock and the cup's walls; the swap needs neither.
    Both pieces go into o's collection named `<prefix>.<off>` and `<prefix>.<on>`. Returns (off, on)."""
    from mathutils.geometry import delaunay_2d_cdt
    x0, x1, z0, z1 = rect
    prefix = o.name.split('.')[0]
    inside = lambda c, d=0.0: x0 + d < c.x < x1 - d and z0 + d < c.z < z1 - d and c.y > y_min

    def edges(obj, d):
        a0, a1, b0, b1 = x0 + d, x1 - d, z0 + d, z1 - d
        near = lambda c: c.y > y_min and a0 - 0.3 < c.x < a1 + 0.3 and b0 - 0.3 < c.z < b1 + 0.3
        cut(obj, [((a0, 0, 0), (1, 0, 0), near), ((a1, 0, 0), (1, 0, 0), near), ((0, 0, b0), (0, 0, 1), near), ((0, 0, b1), (0, 0, 1), near)])

    carry = stash_normals(o)
    edges(o, 0)
    if carry:
        restore_normals(o)
    close_opening(o, lambda f, m: inside(f.calc_center_median()), ring=ring, step=step, snap=0.0, fit_cut=False)
    plug = split_off(o, f'{prefix}.{on}', lambda c, m, n: inside(c))

    # The skin's feature, cut at the inset rect.
    crop = skin.copy()
    crop.data = skin.data.copy()
    crop.name = crop.data.name = f'{prefix}.{off}'
    for c in list(crop.users_collection):
        c.objects.unlink(crop)
    o.users_collection[0].objects.link(crop)
    edges(crop, inset)
    bm = bmesh.new()
    bm.from_mesh(crop.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not inside(f.calc_center_median(), inset)], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    sn = bm.loops.layers.float_vector['src_normal']
    on_rect = lambda p: (abs(p.x - x0 - inset) < 1e-4 or abs(p.x - x1 + inset) < 1e-4) or (abs(p.z - z0 - inset) < 1e-4 or abs(p.z - z1 + inset) < 1e-4)
    outer = [lp for lp in _boundary_loops(bm) if sum(on_rect(v.co) for v in lp) > 0.9 * len(lp)]
    if len(outer) != 1:
        raise RuntimeError(f'feature_nodes: {len(outer)} loops on the inset rect, want 1')
    l2 = outer[0]

    # The hole's loop with the plug's corner normals.
    pm = plug.data
    pbm = bmesh.new()
    pbm.from_mesh(pm)
    pbm.verts.ensure_lookup_table()
    holes = _boundary_loops(pbm)
    if len(holes) != 1:
        raise RuntimeError(f'feature_nodes: the plug has {len(holes)} boundary loops, want 1')
    corner = {}
    for p in pm.polygons:
        for li in p.loop_indices:
            corner[pm.loops[li].vertex_index] = Vector(pm.corner_normals[li].vector)
    l1 = [bm.verts.new(v.co) for v in holes[0]]
    n1 = [corner[v.index] for v in holes[0]]
    pbm.free()
    n2 = []
    for v in l2:
        s = sum((Vector(l[sn]) for l in v.link_loops), Vector())
        n2.append(s.normalized() if s.length > 1e-6 else Vector((0, 1, 0)))

    pts = [Vector((v.co.x, v.co.z)) for v in l1 + l2]
    out_v, _, out_f, orig_v, _, _ = delaunay_2d_cdt(pts, [], [list(range(len(l1))), list(range(len(l1), len(pts)))], 0, 1e-7)
    if len(out_v) != len(pts) or any(not ov for ov in orig_v):
        raise RuntimeError('feature_nodes: the band triangulation made vertices of its own (the loops cross)')
    verts, norms = l1 + l2, n1 + n2
    # The band by position: the triangulation's face origins name only one of two nested loops.
    poly1, poly2 = pts[:len(l1)], pts[len(l1):]
    paint = [m.name.split('.')[0] for m in crop.data.materials].index('Paint')
    made = 0
    for fc in out_f:
        ids = [orig_v[i][0] for i in fc]
        c = sum((pts[i] for i in ids), Vector((0, 0))) / len(ids)
        if not _inside_2d(c, poly1) or _inside_2d(c, poly2):
            continue
        vs = [verts[i] for i in ids]
        ns = [norms[i] for i in ids]
        if (vs[1].co - vs[0].co).cross(vs[2].co - vs[0].co).dot(sum(ns, Vector())) < 0:
            vs.reverse()
            ns.reverse()
        f = bm.faces.new(vs)
        f.material_index = paint
        f.smooth = True
        for l, n in zip(f.loops, ns):
            l[sn] = n
        made += 1
    on_loop = {tuple(round(c, 5) for c in v.co) for v in l1}
    bm.to_mesh(crop.data)
    bm.free()
    crop['authored_normals'] = True
    restore_normals(crop)
    # The loop's corners on all three pieces take the skin's own normal there: the fitted cubic's tilted 3 degrees
    # off it along the Wendt Strom's hatch top, and the full detail feature inside the loop showed as a lighter box.
    sbm, ssn, trees = _skin_trees(skin)
    tree, fs = trees['Paint']
    for obj in (o, plug, crop):
        me = obj.data
        ns = [Vector(c.vector) for c in me.corner_normals]
        for li, lp in enumerate(me.loops):
            p = me.vertices[lp.vertex_index].co
            if tuple(round(c, 5) for c in p) in on_loop:
                loc, _, fi, _ = tree.find_nearest(p)
                n = _skin_normal(fs[fi], ssn, loc) if loc is not None else None
                if n is not None:
                    ns[li] = n
        me.normals_split_custom_set(ns)
    sbm.free()
    print(f'feature_nodes: {off} {len(crop.data.polygons)} faces ({made} in the band), {on} {len(pm.polygons)} faces, loop of {len(l1)}')
    return crop, plug


def strip_nodes(o, y0, y1, lo, hi, x_min=0.8, off='shavedRubstrip_off'):
    """A body side feature the garage switches (render/car/bodyFeatures.ts) where feature_nodes' rectangular hole
    cannot go: a moulded strip along both sides (the Wendt Strom's rubstrip, across the door's rear shut line).
    The donor models the strip as a shell of its own lying on a panel that runs on underneath it, shut lines and
    all, so the switch is only the strip: every island whose vertices all lie between the planes z = c + k y of
    `lo` and `hi` ((c, k), m, just outside the strip's lower and upper edges), at |x| > x_min and y0 < y < y1,
    leaves o as `<prefix>.<off>` (into o's collection), drawn while the switch is off, and nothing else changes.
    Returns it.

    The first version cut out every face using a strip vertex and pressed a copy onto the skin as `_on`: on the
    reduced body those faces fan 10 to 15 cm above and below a 3 cm strip, and the pressed copy shaded as
    patches and seams across the door where the panel underneath was already clean."""
    prefix = o.name.split('.')[0]
    me = o.data
    inside = lambda co: abs(co.x) > x_min and y0 < co.y < y1 and lo[0] + lo[1] * co.y < co.z < hi[0] + hi[1] * co.y
    near = {v.index for v in me.vertices if inside(v.co)}
    # Islands by shared vertex position: a model splits its vertices along seams.
    key = lambda co: tuple(round(c, 5) for c in co)
    by = {}
    for p in me.polygons:
        for i in p.vertices:
            by.setdefault(key(me.vertices[i].co), []).append(p.index)
    seen, faces = set(), set()
    for p in me.polygons:
        if p.index in seen or not any(i in near for i in p.vertices):
            continue
        island, stack, whole = {p.index}, [p.index], True
        while stack:
            q = me.polygons[stack.pop()]
            whole = whole and all(i in near for i in q.vertices)
            for i in q.vertices:
                for r in by[key(me.vertices[i].co)]:
                    if r not in island:
                        island.add(r)
                        stack.append(r)
        seen |= island
        if whole:
            faces |= island
    centers = {key(me.polygons[i].center) for i in faces}
    off_o = split_off(o, f'{prefix}.{off}', lambda c, m, n: key(c) in centers)
    print(f'strip_nodes: {len(off_o.data.polygons)} faces in {off}, {len(o.data.polygons)} left in {o.name}')
    return off_o


def half_cup_nodes(o, skin, y0, y1, z_cut, z_top, cols=(0.17, 0.385), x_min=0.8, proud=0.002,
                   off='halfCupHandles_off', on='halfCupHandles_on'):
    """Half cup door handles, a body feature the garage switches (render/car/bodyFeatures.ts): the part of each
    door handle's cup above `z_cut` (the bar's middle, so the step is hidden behind it) pressed flush with the
    door, the lower half left as it is. The door faces (Paint, facing out, standing no more than `proud` off the
    door, so never the bar) are cut by the box y0 < y < y1, z_cut < z < z_top on both sides, and those inside
    leave o as `<prefix>.<off>`; `<prefix>.<on>` is a copy with every corner off the box's edge moved onto the
    door, its bottom row too, and a ledge from that row down to the cup's floor, facing down into the lower cup.
    The box's edge stays where it is, so both pieces meet the body without a crack, and lies on plain door.

    A box, not the cup's own faces: the reduced door is a few long triangles fanned from the cup's rim to the
    shut lines, triangulated differently on each side, so a selection by face gave two different patches and
    left the rim's curl on the fan's far ends (a sawtooth of light and dark), and a depth test missed the cup's
    rear end walls, under a millimetre deep but leaning 17 degrees. The door is read off the skin along x at two
    stations clear of the cup (`cols`, y; the +x side's, for both), interpolated in y: the Wendt Strom's door there
    is a function of z alone within 0.3 mm. `on` shades with the door's own normal, its ledge flat; `off` keeps the
    authored normals, and o's corners and both pieces' on the box's edge take the door's. Into o's collection.
    Returns (off, on)."""
    from mathutils.bvhtree import BVHTree
    prefix = o.name.split('.')[0]
    sbm = bmesh.new()
    sbm.from_mesh(skin.data)
    sbm.transform(skin.matrix_world)
    tree = BVHTree.FromBMesh(sbm)
    sbm.free()
    zs = np.arange(z_cut - 0.03, z_top + 0.03, 0.002)

    def column(y):
        out = []
        for z in zs:
            hit = tree.ray_cast(Vector((1.5, y, z)), Vector((-1, 0, 0)))
            if hit[0] is None:
                raise RuntimeError(f'half_cup_nodes: no door at y {y}, z {z:.3f}')
            out.append(hit[0].x)
        return np.array(out)

    door_a, door_b = column(cols[0]), column(cols[1])

    def door(y, z):
        """|x| of the door at (y, z), either side."""
        t = (y - cols[0]) / (cols[1] - cols[0])
        return float(np.interp(z, zs, door_a) * (1 - t) + np.interp(z, zs, door_b) * t)

    def door_normal(co):
        h = 0.002
        fy = (door(co.y + h, co.z) - door(co.y - h, co.z)) / (2 * h)
        fz = (door(co.y, co.z + h) - door(co.y, co.z - h)) / (2 * h)
        return Vector((1 if co.x > 0 else -1, -fy, -fz)).normalized()

    side = lambda c: 1 if c.x > 0 else -1
    dep = lambda c: door(c.y, c.z) - abs(c.x)
    in_box = lambda c: abs(c.x) > x_min and y0 < c.y < y1 and z_cut < c.z < z_top
    on_door = lambda c: abs(c.x) > x_min and dep(c) > -proud

    carry = stash_normals(o)
    pad = 0.04
    near = lambda c: on_door(c) and y0 - pad < c.y < y1 + pad and z_cut - pad < c.z < z_top + pad
    cut(o, [((0, 0, z_cut), (0, 0, 1), near), ((0, 0, z_top), (0, 0, 1), near),
            ((0, y0, 0), (0, 1, 0), near), ((0, y1, 0), (0, 1, 0), near)])
    if carry:
        restore_normals(o)
    me = o.data
    paint = [m.name.split('.')[0] for m in me.materials].index('Paint')
    key = lambda co: tuple(round(c, 5) for c in co)
    centers = {key(p.center) for p in me.polygons
               if p.material_index == paint and in_box(p.center) and on_door(p.center) and side(p.center) * p.normal.x > 0.3}
    off_o = split_off(o, f'{prefix}.{off}', lambda c, m, n: key(c) in centers)

    on_o = off_o.copy()
    on_o.data = off_o.data.copy()
    on_o.name = on_o.data.name = f'{prefix}.{on}'
    o.users_collection[0].objects.link(on_o)
    bm = bmesh.new()
    bm.from_mesh(on_o.data)
    rim = {v for e in bm.edges if len(e.link_faces) == 1 for v in e.verts}
    # The box's edge on plain door, which every piece shades with the door's normal (not where the box meets
    # the bar or the cup below it).
    edge = {key(v.co) for v in rim if abs(dep(v.co)) < 0.001 and (abs(v.co.y - y0) < 1e-4 or abs(v.co.y - y1) < 1e-4
                                                                     or abs(v.co.z - z_top) < 1e-4)}
    bottom = {v for v in rim if abs(v.co.z - z_cut) < 1e-4 and dep(v.co) > 1e-4}
    floor = {}
    for v in list(bm.verts):
        if v in rim and v not in bottom:
            continue
        if v in bottom:
            floor[v] = bm.verts.new(v.co)
        v.co.x = side(v.co) * door(v.co.y, v.co.z)
    n_ledge = 0
    for e in list(bm.edges):
        a, b = e.verts
        # Along the floor row, and where the row's last pressed corner meets the rest of the rim.
        if len(e.link_faces) != 1 or not (a in floor or b in floor):
            continue
        vs = [floor.get(a, a), floor.get(b, b), b, a]
        vs = [v for i, v in enumerate(vs) if v not in vs[:i]]
        f = bm.faces.new(vs)
        f.material_index = paint
        f.smooth = False
        f.normal_update()
        if f.normal.z > 0:
            f.normal_flip()
        n_ledge += 1
    bm.to_mesh(on_o.data)
    bm.free()

    me = on_o.data
    first_ledge = len(me.polygons) - n_ledge
    ns = []
    for p in me.polygons:
        for li in p.loop_indices:
            ns.append(p.normal.copy() if p.index >= first_ledge else door_normal(me.vertices[me.loops[li].vertex_index].co))
    me.normals_split_custom_set(ns)
    on_o['authored_normals'] = True
    for obj in (o, off_o):
        m = obj.data
        ns = [Vector(c.vector) for c in m.corner_normals]
        for li, lp in enumerate(m.loops):
            co = m.vertices[lp.vertex_index].co
            if key(co) in edge:
                ns[li] = door_normal(co)
        m.normals_split_custom_set(ns)
    print(f'half_cup_nodes: {off} {len(off_o.data.polygons)} faces, {on} {len(me.polygons)} faces ({n_ledge} in the ledge), '
          f'{len(o.data.polygons)} left in {o.name}')
    return off_o, on_o


def handle_tail(o, fit, y0, y1, zc, hw, proud, rc=0.012, r=0.003, crown=0.002, sink=(0.008, 0.003), cup=(0.322, 0.335),
                material='Paint', step=0.008, arc=5, rounds=3):
    """A door handle's bar carried on to its rear end, on both sides (built at +x and mirrored): the bar's
    cross-section, `hw` either side of `zc`, standing `proud` (front, rear) m off the door along x, from `y0`
    inside the bar to `y1` with plan corners of radius `rc`, edges rounded at `r` and the face crowned by
    `crown`. The door is the plane through the body's +x vertices for which fit(co) holds; the walls run
    `sink` (ahead of cup[0], behind cup[1]) under it, deep where the handle's cup is recessed. The Wendt
    Strom's donor models the bar's last 5 cm as a plate in the door's own surface (0.2 mm under it), and
    the reduction left the bar ending at the cup. Smooth normals of its own. Returns the faces added."""
    pts = np.array([tuple(v.co) for v in o.data.vertices if v.co.x > 0 and fit(v.co)])
    a, b, c = np.linalg.lstsq(np.c_[np.ones(len(pts)), pts[:, 1], pts[:, 2]], pts[:, 0], rcond=None)[0]
    door = lambda y, z: a + b * y + c * z
    ramp = lambda y, lo, hi: min(1.0, max(0.0, (y - lo) / (hi - lo)))
    height = lambda y: proud[0] + (proud[1] - proud[0]) * ramp(y, cup[1], y1)
    base = lambda y: -(sink[0] + (sink[1] - sink[0]) * ramp(y, cup[0], cup[1]))
    n_s = max(2, math.ceil((y1 - rc - y0) / step))

    def outline(d):
        """The bottom half of the footprint inset by d: (y, w) from y0 round the rear corner to the end."""
        out = [(y0 + (y1 - rc - y0) * i / n_s, hw - d) for i in range(n_s + 1)]
        out += [(y1 - rc + (rc - d) * math.sin(math.pi / 2 * j / arc), hw - rc + (rc - d) * math.cos(math.pi / 2 * j / arc)) for j in range(1, arc + 1)]
        return out + [(y1 - d, 0.0)] if hw - rc > 1e-6 else out

    inner = outline(r)
    rings = [(0.0, None), (0.0, -r)] + [(r * (1 - math.cos(math.pi / 2 * j / rounds)), -r + r * math.sin(math.pi / 2 * j / rounds)) for j in range(1, rounds + 1)]
    stash_normals(o)
    me = o.data
    mi = [m.name.split('.')[0] for m in me.materials].index(material)
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    added = 0
    for side in (1, -1):
        cache = {}

        def vert(y, z, h):
            k = (round(y, 7), round(z, 7))
            if k not in cache:
                cache[k] = bm.verts.new((side * (door(y, z) + h), y, z))
            return cache[k]

        grid = []   # per ring: (bottom, top) vertex lists
        for d, dh in rings:
            bot, top = [], []
            for (y, w), (_, wi) in zip(outline(d), inner):
                edge = height(y) - crown * (wi / (hw - r)) ** 2
                h = base(y) if dh is None else edge + dh
                bot.append(vert(y, zc - w, h))
                top.append(vert(y, zc + w, h))
            grid.append((bot, top))
        mid = [vert(y, zc, height(y)) for y, _ in inner]
        quads = []
        for k in range(len(grid) - 1):
            for half in (0, 1):
                p, q = grid[k][half], grid[k + 1][half]
                quads += [(p[i], p[i + 1], q[i + 1], q[i]) for i in range(len(p) - 1)]
        bot, top = grid[-1]
        quads += [(bot[i], bot[i + 1], mid[i + 1], mid[i]) for i in range(len(mid) - 1)]
        quads += [(mid[i], mid[i + 1], top[i + 1], top[i]) for i in range(len(mid) - 1)]
        new = []
        for qd in quads:
            vs = [v for i, v in enumerate(qd) if v is not qd[i - 1]]
            if len(set(vs)) < 3:
                continue
            f = bm.faces.new(vs)
            f.material_index = mi
            f.smooth = True
            new.append(f)
        # Outward: away from the bar's core line, a little off the door and short of the rear corner's centre.
        for f in new:
            f.normal_update()
            cc = f.calc_center_median()
            core = Vector((side * (door(cc.y, zc) + 0.005), min(cc.y, y1 - rc), zc))
            if f.normal.dot(cc - core) < 0:
                f.normal_flip()
        bm.normal_update()
        for f in new:
            for l in f.loops:
                l[sn] = l.vert.normal
        added += len(new)
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return added


def _inside_2d(p, poly):
    c = False
    for i in range(len(poly)):
        a, b = poly[i], poly[i - 1]
        if (a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x:
            c = not c
    return c


def _seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / (ab.dot(ab) or 1e-12)))
    return (a + ab * t - p).length


def reskin_lip(o, skin, ay, az, xr, th_top=95.0, dx=0.02, dth=10.0, under=None, crease_z=None, center_fill=0.03,
               fair=None):
    """Rebuild a hood's leading lip (a roll along x over a grille) as a fresh triangulation on the skin.
    A point of the lip is (x, theta): the ray from the axis (x, ay, az) at theta degrees up from straight
    ahead. The lip's Paint and Black faces within |x| < xr and theta < th_top (and the flat underside
    under it, normal down, within 5 mm of az) go; what is left of the body round them is one open chain
    over the top from one crease end to the other. That chain, a crease row at crease_z (the lip's bottom
    edge) and a grid every `dx` m and `dth` degrees are triangulated in (x, theta) (delaunay_2d_cdt) and
    lifted onto the skin's Paint, each vertex with the skin's normal at itself; an underside strip runs
    back from the crease to y `under`. Within `center_fill` of x 0 under 8 degrees the lip is taken from
    x = center_fill (the badge mount on the Wendt Strom's skin). `fair` = (ranges, th0, th1) fairs the lower
    lip across the car: below th0 degrees the ray length is an even polynomial in x (1, x2, x4) fitted to
    the skin over the |x| `ranges` [(x0, x1), ...], with its own normals, blended into the skin by th1.
    The collapse left the Wendt Strom's lip in long triangles shaded from points 25 % in from their
    corners, a badge recess with nothing in it, and the grille piece's strip standing up to 2 cm proud of
    it; rebuilt on the skin alone, its crease wobbled 3 to 5 mm in plan where the donor's lip bulges round
    the badge surround (x 0.08 to 0.22, below 40 degrees), which read as a moustache under the hood
    (`fair=([(0.03, 0.08), (0.22, 0.37)], 35, 50)`). Returns (faces removed, faces made)."""
    import collections
    import numpy as np
    from mathutils.geometry import delaunay_2d_cdt
    sbm, ssn, trees = _skin_trees(skin)
    paint_tree, paint_faces = trees['Paint']
    crease_z = az - 0.0008 if crease_z is None else crease_z
    axis = lambda x: Vector((x, ay, az))
    ray = lambda th: Vector((0, -math.cos(math.radians(th)), math.sin(math.radians(th))))

    def theta_r(p):
        rel = p - axis(p.x)
        return math.degrees(math.atan2(rel.z, -rel.y)), rel.length

    def skin_sample(x, th):
        if abs(x) < center_fill and th < 8:
            p, n = skin_sample(math.copysign(center_fill, x) if x else center_fill, th)
            k = abs(x) / center_fill
            return Vector((x, p.y, p.z)), Vector((n.x * k, n.y, n.z)).normalized()
        d = ray(th)
        loc, _, i, _ = paint_tree.ray_cast(axis(x) + d * 0.4, -d, 0.6)
        if loc is None:
            return None, None
        return loc, _skin_normal(paint_faces[i], ssn, loc)

    fits = {}

    def fit(th):
        """Coefficients of r(x) = c0 + c1 x2 + c2 x4 at theta, from the skin over the fair ranges."""
        key = round(th, 3)
        if key not in fits:
            xs = [x0 + (x1 - x0) * i / 10 for x0, x1 in fair[0] for i in range(11)]
            pts = [(x, (skin_sample(x, th)[0] - axis(x)).length) for x in xs]
            X = np.array([p[0] for p in pts]); Y = np.array([p[1] for p in pts])
            fits[key] = np.linalg.lstsq(np.vstack([np.ones_like(X), X ** 2, X ** 4]).T, Y, rcond=None)[0]
        return fits[key]

    def fair_sample(x, th):
        c = fit(th)
        r = c[0] + c[1] * x * x + c[2] * x ** 4
        r_x = 2 * c[1] * x + 4 * c[2] * x ** 3
        h = 0.5
        ca, cb = fit(th + h), fit(th - h)
        r_t = ((ca[0] + ca[1] * x * x + ca[2] * x ** 4) - (cb[0] + cb[1] * x * x + cb[2] * x ** 4)) / math.radians(2 * h)
        d = ray(th)
        t = math.radians(th)
        dp = Vector((0, math.sin(t), math.cos(t)))
        n = (dp * r + d * r_t).cross(Vector((1, 0, 0)) + d * r_x).normalized()
        if n.dot(d) < 0:
            n = -n
        return axis(x) + d * r, n

    def sample(x, th):
        w = 0.0 if fair is None else 1 - _sstep((th - fair[1]) / (fair[2] - fair[1]))
        if w <= 0:
            return skin_sample(x, th)
        p, n = fair_sample(x, th)
        if w >= 1:
            return p, n
        ps, ns = skin_sample(x, th)
        if ps is None:
            return p, n
        return p.lerp(ps, 1 - w), n.lerp(ns, 1 - w).normalized()

    def crease(x):
        p, n = sample(x, 1.0)
        return Vector((p.x, p.y, crease_z)), n

    stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    paint_i = names.index('Paint')
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    R = set()
    for f in bm.faces:
        m = names[f.material_index]
        c = f.calc_center_median()
        if m not in ('Paint', 'Black') or abs(c.x) >= xr or not (ay - 0.11 < c.y < ay + 0.09 and az - 0.005 < c.z < az + 0.115):
            continue
        if m == 'Paint' and f.normal.z < -0.7 and az - 0.003 < c.z < az + 0.005 and c.y < ay + 0.01:
            R.add(f)
            continue
        th, r = theta_r(c)
        if not (-3 < th < th_top):
            continue
        p, _ = sample(c.x, th)
        if p is None:
            continue
        rs = (p - axis(c.x)).length
        tol = 0.025 if abs(c.x) < 0.05 or th > 0 else 0.012
        if abs(r - rs) < tol or (abs(c.x) < 0.05 and r < rs):
            R.add(f)
    adj = collections.defaultdict(list)
    for e in bm.edges:
        if any(f in R for f in e.link_faces) and any(f not in R for f in e.link_faces):
            a, b = e.verts
            adj[a].append(b)
            adj[b].append(a)
    s = max((v for v in adj if len(adj[v]) == 1), key=lambda v: v.co.x)
    ch, seen, cur = [s], {s}, s
    while True:
        nx = [w for w in adj[cur] if w not in seen]
        if not nx:
            break
        cur = nx[0]
        seen.add(cur)
        ch.append(cur)
    # the chain's end edges lying along the crease row itself (both ends at the outermost x) are left open
    while len(ch) > 2 and abs(theta_r(ch[1].co)[0] - theta_r(ch[0].co)[0]) < 1 and abs(ch[1].co.x) < abs(ch[0].co.x):
        ch.pop(0)
    while len(ch) > 2 and abs(theta_r(ch[-2].co)[0] - theta_r(ch[-1].co)[0]) < 1 and abs(ch[-2].co.x) < abs(ch[-1].co.x):
        ch.pop()
    x0, x1 = ch[-1].co.x, ch[0].co.x
    uv = lambda x, th: Vector((x, math.radians(th) * 0.055))
    nb = int(round((x1 - x0) / dx))
    bottom = [x0 + (x1 - x0) * i / nb for i in range(1, nb)]
    th_b = theta_r(ch[0].co)[0]
    poly = [uv(v.co.x, theta_r(v.co)[0]) for v in ch] + [uv(x, th_b) for x in bottom]
    order = list(range(len(poly)))
    if sum(poly[i - 1].x * poly[i].y - poly[i].x * poly[i - 1].y for i in range(len(poly))) < 0:
        order.reverse()
    k = int(math.ceil(abs(x0) / dx))
    interior = []
    for i in range(2 * k + 1):
        x = -k * dx + i * dx
        th = th_b + dth
        while th < th_top + 20:
            q = uv(x, th)
            if _inside_2d(q, poly) and min(_seg_dist(q, poly[j - 1], poly[j]) for j in range(len(poly))) > 0.4 * dx:
                interior.append((x, th))
            th += dth
    _, _, ofaces, orig_v, _, _ = delaunay_2d_cdt(poly + [uv(x, th) for x, th in interior], [], [order], 1, 1e-6)
    nch, nbt = len(ch), len(bottom)
    normal_at, verts3, crease_row = {}, [], []
    for ov in orig_v:
        if not ov:
            raise RuntimeError('reskin_lip: the triangulation added a vertex')
        src = ov[0]
        if src < nch:
            v = ch[src]
        else:
            p, n = crease(bottom[src - nch]) if src < nch + nbt else sample(*interior[src - nch - nbt])
            v = bm.verts.new(p)
            normal_at[v] = n
            if src < nch + nbt:
                crease_row.append(v)
        verts3.append(v)
    for v in ch:
        th, _ = theta_r(v.co)
        normal_at[v] = (sample(v.co.x, th) if th > 0.5 else crease(v.co.x))[1]
    bmesh.ops.delete(bm, geom=list(R), context='FACES')
    made = 0
    for fc in ofaces:
        vs = [verts3[i] for i in fc]
        if (vs[1].co - vs[0].co).cross(vs[2].co - vs[0].co).dot(sum((normal_at[v] for v in vs), Vector())) < 0:
            vs.reverse()
        f = bm.faces.new(vs)
        f.material_index = paint_i
        f.smooth = True
        for l in f.loops:
            l[sn] = normal_at[l.vert]
        made += 1
    # a black panel behind the lip whose top stands above the crease shows through once the lip is faired
    # back (the Wendt Strom's grille back panel, its top at z 0.690 behind the donor's bulge): sink it
    for f in bm.faces:
        if names[f.material_index] == 'Black':
            for v in f.verts:
                if abs(v.co.x) < xr + 0.015 and v.co.y < ay - 0.04 and crease_z - 0.0006 < v.co.z < az + 0.02:
                    v.co.z = crease_z - 0.0006
    if under is not None:
        row = sorted(crease_row + [ch[0], ch[-1]], key=lambda v: v.co.x)
        back = [bm.verts.new((v.co.x, under, crease_z)) for v in row]
        for i in range(len(row) - 1):
            f = bm.faces.new([row[i], back[i], back[i + 1], row[i + 1]])
            if f.normal.z > 0:
                f.normal_flip()
            f.material_index = paint_i
            f.smooth = True
            for l in f.loops:
                l[sn] = Vector((0, 0, -1))
            made += 1
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    sbm.free()
    restore_normals(o)
    return len(R), made


def grille_ledge(o, front, z_front, z_back, tuck=0.004, x_step=0.03, sliver_box=None):
    """A flat painted ledge under a grille, from a bumper's top edge back under the grille's black panel:
    `front` is [(x, y)] for x >= 0 along the bumper's top edge (mirrored), z_front there, rising to z_back
    `tuck` m behind the panel's face (found by rays along +y at z_back - 0.3 mm, through anything not
    Black; past |x| 0.35 the panel's lean carries on). Faces of `sliver_box(center)` (Paint) go first.
    The Wendt Strom's donor has the ledge (z 0.5834 to 0.590), cut away with everything the grille piece's
    box held, which left a jagged hole under the bottom bar. Returns (faces removed, faces made)."""
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    paint_i = names.index('Paint')
    tree = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())

    def front_y(x):
        x = abs(x)
        for (xa, ya), (xb, yb) in zip(front, front[1:]):
            if xa <= x <= xb:
                return ya + (yb - ya) * (x - xa) / (xb - xa)
        return front[-1][1]

    def back_y(x):
        ax = min(abs(x), 0.35)
        q = Vector((ax, -3, z_back - 0.0003))
        for _ in range(8):
            h = tree.ray_cast(q, Vector((0, 1, 0)), 2)
            if h[0] is None:
                break
            if names[me.polygons[h[2]].material_index] == 'Black':
                return h[0].y + tuck + (abs(x) - ax) * 0.152
            q = h[0] + Vector((0, 1e-4, 0))
        raise RuntimeError(f'grille_ledge: no black panel at x {ax}')
    xe = front[-1][0]
    xs = sorted(set([round(s * x, 4) for x, _ in front for s in (1, -1)] + [round(-xe + i * x_step, 4) for i in range(int(2 * xe / x_step) + 1) if -xe + i * x_step < xe]))
    backs = [back_y(x) for x in xs]
    stash_normals(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    gone = [f for f in bm.faces if sliver_box and names[f.material_index] == 'Paint' and sliver_box(f.calc_center_median())]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    fr = [bm.verts.new((x, front_y(x), z_front)) for x in xs]
    bk = [bm.verts.new((x, y, z_back)) for x, y in zip(xs, backs)]
    for f in bm.faces:
        f.tag = False
    made = []
    for i in range(len(xs) - 1):
        f = bm.faces.new([fr[i], fr[i + 1], bk[i + 1], bk[i]])
        if f.normal.z < 0:
            f.normal_flip()
        f.material_index = paint_i
        f.smooth = True
        f.tag = True
        made.append(f)
    bm.normal_update()
    for f in made:
        for l in f.loops:
            l[sn] = sum((g.normal for g in l.vert.link_faces if g.tag), Vector()).normalized()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return len(gone), len(made)


def mend_top_edge(o, front, z_top, cut, step=0.02):
    """Re-triangulate a stretch of a bumper's top edge: the Paint faces of cut(center) go, and what is left
    below them (one open chain from the edge's last vertex on one side round to the other) is closed by a
    straight top edge at z_top along `front` ([(x, y)] for x >= 0, mirrored) and triangulated in (x, z).
    New corners take the normals of the faces left round them, the top edge's lerped across from the
    chain's two ends. On the Wendt Strom the badge mount's base left two overlapping layers of faces, one
    folded face and a 9 mm dip in the edge at x 0 (`cut` |x| < 0.1, y < -2.07, z > 0.565 with a corner
    above 0.572); every front bumper part copied it. Returns (faces removed, faces made)."""
    import collections
    from mathutils.geometry import delaunay_2d_cdt

    def front_y(x):
        x = abs(x)
        for (xa, ya), (xb, yb) in zip(front, front[1:]):
            if xa <= x <= xb:
                return ya + (yb - ya) * (x - xa) / (xb - xa)
        return front[-1][1]
    stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    paint_i = names.index('Paint')
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    R = [f for f in bm.faces if f.material_index == paint_i and cut(f)]
    for f in bm.faces:
        f.tag = False
    for f in R:
        f.tag = True
    # the chain: edges of the cut faces shared with faces that stay (the rest is the old top edge)
    keep_e = [e for e in bm.edges if any(f.tag for f in e.link_faces) and any(not f.tag for f in e.link_faces)]
    adj = collections.defaultdict(list)
    for e in keep_e:
        a, b = e.verts
        adj[a].append(b)
        adj[b].append(a)
    ends = [v for v in adj if len(adj[v]) == 1]
    if len(ends) != 2:
        raise RuntimeError(f'mend_top_edge: {len(ends)} chain ends')
    s = min(ends, key=lambda v: v.co.x)
    ch, seen, cur = [s], {s}, s
    while True:
        nx = [w for w in adj[cur] if w not in seen]
        if not nx:
            break
        cur = nx[0]
        seen.add(cur)
        ch.append(cur)

    def corner_normal(v):
        n = sum((l[sn] for l in v.link_loops if not l.face.tag), Vector())
        return n.normalized() if n.length > 1e-6 else Vector((0, -0.83, 0.55)).normalized()
    nrm = {v: corner_normal(v) for v in ch}
    xl, xr = ch[0].co.x, ch[-1].co.x
    k = max(1, int(round((xr - xl) / step)))
    top = [xr - (xr - xl) * i / k for i in range(1, k)]    # right to left, closing the chain
    pts = [Vector((v.co.x, v.co.z)) for v in ch] + [Vector((x, z_top)) for x in top]
    order = list(range(len(pts)))
    if sum(pts[i - 1].x * pts[i].y - pts[i].x * pts[i - 1].y for i in range(len(pts))) < 0:
        order.reverse()
    _, _, ofaces, orig_v, _, _ = delaunay_2d_cdt(pts, [], [order], 1, 1e-7)
    verts = []
    nl, nr = nrm[ch[0]], nrm[ch[-1]]
    for ov in orig_v:
        i = ov[0]
        if i < len(ch):
            verts.append(ch[i])
        else:
            x = top[i - len(ch)]
            v = bm.verts.new((x, front_y(x), z_top))
            nrm[v] = nl.lerp(nr, (x - xl) / (xr - xl)).normalized()
            verts.append(v)
    bmesh.ops.delete(bm, geom=R, context='FACES')
    made = 0
    for fc in ofaces:
        vs = [verts[i] for i in fc]
        if (vs[1].co - vs[0].co).cross(vs[2].co - vs[0].co).dot(sum((nrm[v] for v in vs), Vector())) < 0:
            vs.reverse()
        f = bm.faces.new(vs)
        f.material_index = paint_i
        f.smooth = True
        for l in f.loops:
            l[sn] = nrm[l.vert]
        made += 1
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    snap_top_edge(o, front, z_top)
    return len(R), made


def snap_top_edge(o, front, z_top, margin=0.01):
    """Put a bumper's open top edge on the line `front` ([(x, y)] for x >= 0, mirrored), no lower than
    0.6 mm under z_top, up to `margin` short of the line's end (the corners turning back stay), so a ledge
    built on the same line meets it everywhere: the Wendt Strom's edge vertex at x 0.162 stood 4 mm ahead
    of the line and 2 mm low, a gap in front of the ledge. Vertex moves only; returns how many moved."""
    def front_y(x):
        x = abs(x)
        for (xa, ya), (xb, yb) in zip(front, front[1:]):
            if xa <= x <= xb:
                return ya + (yb - ya) * (x - xa) / (xb - xa)
        return front[-1][1]
    carry = stash_normals(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    moved = 0
    for v in bm.verts:
        if abs(v.co.x) < front[-1][0] - margin and v.co.y < front[-1][1] + 0.02 and z_top - 0.004 < v.co.z < z_top + 0.001 \
                and any(len(e.link_faces) == 1 for e in v.link_edges):
            y, z = front_y(v.co.x), max(v.co.z, z_top - 0.0006)
            if abs(y - v.co.y) + abs(z - v.co.z) > 1e-5:
                v.co.y, v.co.z = y, z
                moved += 1
    bm.to_mesh(o.data)
    bm.free()
    if carry:
        restore_normals(o)
    return moved


class SourceShade:
    """Ray casts onto chosen faces of an original (re-imported) source mesh, each hit with the source's
    own corner normals interpolated there. The donor skin is processed (culled, welded) and can keep
    pieces of what a cull took: the Wendt Strom's skin kept paint pieces of the badge surround in front
    of the hood lip, which read as a bulge and were faired away. When a repair must match the car as
    modelled, sample the source itself (re-imported with import_asset and placed like the donor; the
    Wendt Strom's fit its skin to 0.06 mm) through this. `faces` are polygon indices of `o`, e.g. one
    island (`island_at`)."""

    def __init__(self, o, faces):
        me = o.data
        me.calc_loop_triangles()
        cn = me.corner_normals
        faces = set(faces)
        self.v, self.n, polys = [], [], []
        for lt in me.loop_triangles:
            if lt.polygon_index not in faces:
                continue
            b = len(self.v)
            self.v += [me.vertices[i].co.copy() for i in lt.vertices]
            self.n.append([cn[l].vector.copy() for l in lt.loops])
            polys.append((b, b + 1, b + 2))
        self.t = BVHTree.FromPolygons(self.v, polys)

    def ray(self, origin, direction, dist=1.0):
        """(point, normal) of the first hit, or (None, None)."""
        h = self.t.ray_cast(Vector(origin), Vector(direction), dist)
        if h[0] is None:
            return None, None
        i = h[2]
        w = barycentric(h[0], *self.v[3 * i:3 * i + 3])
        return h[0], sum((n * k for n, k in zip(self.n[i], w)), Vector()).normalized()


def island_at(o, p):
    """The polygon indices of the island (faces joined by shared vertices) of `o` nearest point p."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    f0 = bm.faces[BVHTree.FromBMesh(bm).find_nearest(Vector(p))[2]]
    seen, stack = {f0.index}, [f0]
    while stack:
        for v in stack.pop().verts:
            for h in v.link_faces:
                if h.index not in seen:
                    seen.add(h.index)
                    stack.append(h)
    bm.free()
    return seen


def even_fill(sample, x, xc, step=0.03):
    """sample(x) -> (point, normal) carried across a notch in the source at |x| < xc (a badge's recess):
    the point as c0 + c1 x^2 through the clean sections at xc and xc + step, the normal xc's with its x
    part scaled by |x| / xc, so the fill is mirror symmetric and meets the source smoothly."""
    p0, n0 = sample(xc)
    p1, _ = sample(xc + step)
    if p0 is None or p1 is None:
        return None, None
    p = p0 + (p1 - p0) / ((xc + step) ** 2 - xc ** 2) * (x * x - xc * xc)
    p.x = x
    s = abs(x) / xc
    return p, Vector((math.copysign(n0.x * s, x) if x else 0.0, n0.y, n0.z)).normalized()


def step_band(o, cut, sample, crease_z, top_z, x_max, step=0.03, below=(0.540, 0.5695), above=(0.577, 0.577)):
    """Re-triangulate a bumper's top band where it steps (a sloped face, a crease, a short upright step,
    the open top edge): the faces of cut(face) go and the hole is filled in (x, z) by a constrained
    Delaunay through its own boundary, a crease row at crease_z every `step` m for |x| < x_max (a
    constraint, so no triangle crosses it) and, on the open top edge, the same columns at top_z. New
    vertices take y from sample(x, z) -> (point, normal), the reference surface. Every corner takes the
    reference normal with z held inside `below` for faces under the crease and `above` for faces over it,
    so the crease shades as one; the upright step takes one height for all its corners (its two rows
    sampled apart zigzagged into a sawtooth highlight). The Wendt Strom's centre band (|x| < 0.36, z 0.537
    to the top edge at 0.584) was a dozen long, lopsided triangles from mend_top_edge and the donor's
    fans toward the headlamp corner, which could not carry the source's 1 cm upright step
    (z 0.5715 to 0.582) and shaded up to 39 degrees off. Returns (faces removed, faces made)."""
    import collections
    from mathutils.geometry import delaunay_2d_cdt
    stash_normals(o)
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    paint_i = names.index('Paint')
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector['src_normal']
    bm.verts.ensure_lookup_table()
    # BMesh wrappers neither hash nor compare by identity reliably (a walk comparing them with `is`
    # bounced between two vertices forever and froze Blender): tag the faces, walk by vertex index
    for f in bm.faces:
        f.tag = f.material_index == paint_i and cut(f)
    R = [f for f in bm.faces if f.tag]
    # the hole's outline: edges with one face in R and the other outside it, or none (the open top edge)
    out = [e for e in bm.edges if sum(f.tag for f in e.link_faces) == 1]
    adj = collections.defaultdict(list)
    for e in out:
        a, b = (v.index for v in e.verts)
        adj[a].append(b)
        adj[b].append(a)
    if any(len(n) != 2 for n in adj.values()):
        raise RuntimeError('step_band: the outline is not one loop')
    s = next(iter(adj))
    idx, prev, cur = [s], -1, s
    for _ in range(len(adj)):
        nx = [w for w in adj[cur] if w != prev]
        if not nx:
            raise RuntimeError('step_band: the outline breaks off')
        if nx[0] == s:
            break
        idx.append(nx[0])
        prev, cur = cur, nx[0]
    if len(idx) != len(adj):
        raise RuntimeError(f'step_band: the outline is {len(adj)} vertices but the walk from one closes after {len(idx)}')
    loop = [bm.verts[i] for i in idx]
    n = int(round(2 * x_max / step))
    cols = [-x_max + 2 * x_max * i / n for i in range(n + 1)]
    crease = [Vector((x, crease_z)) for x in cols]
    # top columns go into the outline: split each open top edge at the columns it spans
    poly = []
    for i, v in enumerate(loop):
        w = loop[(i + 1) % len(loop)]
        poly.append((Vector((v.co.x, v.co.z)), v))
        e = bm.edges.get((v, w))
        if e is not None and all(f.tag for f in e.link_faces) and abs(v.co.z - top_z) < 0.002 and abs(w.co.z - top_z) < 0.002:
            lo, hi = sorted((v.co.x, w.co.x))
            mids = [x for x in cols if lo + 0.006 < x < hi - 0.006]
            mids.sort(reverse=v.co.x > w.co.x)
            poly += [(Vector((x, top_z)), None) for x in mids]
    P = [p for p, _ in poly] + crease
    order = list(range(len(poly)))
    if sum(P[i - 1].x * P[i].y - P[i].x * P[i - 1].y for i in order) < 0:
        order.reverse()
    cons = [[len(poly) + i, len(poly) + i + 1] for i in range(len(crease) - 1)]
    # carry the crease on to an outline vertex already on it at each end (the donor's own crease vertex)
    for end, sgn in ((len(poly), -1), (len(poly) + len(crease) - 1, 1)):
        near = [i for i, (p, _) in enumerate(poly) if abs(p.y - crease_z) < 0.002 and sgn * p.x > x_max]
        if near:
            cons.append([end, min(near, key=lambda i: abs(poly[i][0].x - sgn * x_max))])
    _, _, ofaces, orig_v, _, _ = delaunay_2d_cdt(P, cons, [order], 1, 1e-7)
    bmv = []
    for ov in orig_v:
        i = ov[0]
        if i < len(poly):
            p2, v = poly[i]
            if v is None:
                p, _ = sample(p2.x, p2.y)
                v = bm.verts.new((p2.x, p.y, p2.y))
        else:
            p2 = crease[i - len(poly)]
            p, _ = sample(p2.x, p2.y)
            v = bm.verts.new((p2.x, p.y, p2.y))
        bmv.append(v)
    # FACES_ONLY: the open top edge's vertices belong to cut faces alone and are reused
    bmesh.ops.delete(bm, geom=R, context='FACES_ONLY')
    made = 0
    for fc in ofaces:
        vs = [bmv[i] for i in fc]
        zc = sum(v.co.z for v in vs) / len(vs)
        lo, hi = above if zc > crease_z + 1e-5 else below
        nrm = []
        for v in vs:
            n = sample(v.co.x, min(max(v.co.z, lo), hi))[1]
            if n is None:   # off the reference (the outline's far corners): the normal it already has
                n = sum((Vector(l[sn]) for l in v.link_loops), Vector())
                n = n.normalized() if n.length > 1e-6 else Vector((0, -1, 0))
            nrm.append(n)
        if (vs[1].co - vs[0].co).cross(vs[2].co - vs[0].co).dot(sum(nrm, Vector())) < 0:
            vs.reverse()
            nrm.reverse()
        f = bm.faces.new(vs)
        f.material_index = paint_i
        f.smooth = True
        for l, nn in zip(f.loops, nrm):
            l[sn] = nn
        made += 1
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return len(R), made
GRILLE_UV = 3.0   # m of car space per UV unit on Grille faces: the game's rib texture repeats against this


def flatten_grilles(bm, faces, back=0.004):
    """Press each connected patch of grille faces onto its best fitting plane, `back` meters behind
    it: slats, mesh and anything raised (a logo) go flat, so the pattern texture is the whole
    grille. Vertices shared with the surround stay where they are, so the fascia keeps its shape."""
    import numpy as np
    seen = set()
    for f0 in faces:
        if f0 in seen:
            continue
        patch, stack = [], [f0]
        seen.add(f0)
        while stack:
            f = stack.pop()
            patch.append(f)
            for v in f.verts:
                for h in v.link_faces:
                    if h in faces and h not in seen:
                        seen.add(h)
                        stack.append(h)
        vs = list({v for f in patch for v in f.verts})
        if len(vs) < 4:
            continue
        pts = np.array([tuple(v.co) for v in vs])
        c = pts.mean(axis=0)
        n = Vector(np.linalg.svd(pts - c)[2][2])
        if n.y > 0:
            n = -n     # toward the front of the car
        c = Vector(c)
        for v in vs:
            if all(h in faces for h in v.link_faces):
                v.co = v.co - n * ((v.co - c).dot(n) + back)


def grille_surface(o, half_wb, step=0.03, uv_span=GRILLE_UV, material='Black', flatten=False):
    """Close the front grilles. The donor's own grille geometry stays as it is, matte `material`
    (Black: at night a grille reads dark, and the patterned Grille plate every car once wore read
    as a silver sticker); logos and lettering inside a grille become the same, de-branded.
    A square grid (`step`) is cast at the nose: where the first thing seen is Black within 0.45 m
    of the nose, below the hood's leading edge and clear of the lamps, the face hit is grille;
    where the ray runs on into the car (an open grille) the row's run of open cells gets one flat
    quad 0.12 m behind the nose, so nobody sees into the body. With `flatten` each grille patch is
    pressed onto its plane (flatten_grilles) and the faces get planar UVs from x and z (`uv_span`
    meters a unit) for a patterned material; other faces' UVs are zeroed and extra UV layers
    dropped (they only cost bytes). New quads are marked `own_normals` for the shading pass.
    Returns (faces recolored, quads)."""
    me = o.data
    while len(me.uv_layers) > 1:
        me.uv_layers.remove(me.uv_layers[-1])
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    me.uv_layers[0].name = 'UVMap'
    names = [m.name.split('.')[0] for m in me.materials]
    verts = [v.co.copy() for v in me.vertices]
    tree = BVHTree.FromPolygons(verts, [list(p.vertices) for p in me.polygons])
    mats = [names[p.material_index] for p in me.polygons]
    lamps = [list(p.vertices) for p in me.polygons if mats[p.index] in LAMP_MATS]
    ltree = BVHTree.FromPolygons(verts, lamps) if lamps else None
    nose = min(v.y for v in verts)
    floor_z = min(v.z for v in verts) + 0.08
    # Grilles live in the front fascia: below the top of the front 0.3 m (the hood's leading edge),
    # taken at the middle: raised pop-up lamps stand above it outboard, and between them the rays
    # over the hood read as an open grille (the RX-7 got two black quads floating over its nose).
    fascia_top = max(v.z for v in verts if v.y < nose + 0.3 and abs(v.x) < 0.3)
    in_zone = lambda q: q.y < nose + 0.45 and q.y < -half_wb - 0.25 and floor_z < q.z < fascia_top - 0.04
    hit_faces, cell, near = set(), {}, {}   # cell[(row, col)]: 'open', 'near' (the fascia) or absent (missed the car)
    xs = [v.x for v in verts]
    # Outboard, a grille only sits below the headlights: up there black is a lamp housing or a
    # closed pop-up lamp (or a lamp painted in a texture), not a grille.
    hw = max(abs(x) for x in xs)
    heads = [verts[i].z for p in me.polygons if mats[p.index] == 'HeadLight' for i in p.vertices]
    lamp_line = min(heads) if heads else (floor_z + fascia_top) / 2
    placed = lambda q: abs(q.x) < 0.55 * hw or q.z < lamp_line
    for zi in range(math.ceil(floor_z / step), math.floor((fascia_top - 0.04) / step) + 1):
        for xi in range(math.floor(min(xs) / step), math.ceil(max(xs) / step) + 1):
            x, z = xi * step, zi * step
            loc, nrm, fi, _ = tree.ray_cast(Vector((x, nose - 1, z)), Vector((0, 1, 0)))
            if loc is None:
                continue
            if loc.y > nose + 0.6 and mats[fi] != 'Glass':
                cell[zi, xi] = 'open'
                continue
            if loc.y < nose + 0.45:
                cell[zi, xi] = 'near'
                near[zi, xi] = (fi, loc)
            if mats[fi] == 'Black' and in_zone(loc) and placed(loc) and not (ltree and (ltree.find_nearest(loc)[3] or 1) < 0.03):
                hit_faces.add(fi)
    # De-branding: a logo or lettering inside a grille (any material but glass and lamps) is grille
    # too, when grille lies left and right of it and above or below, within 0.12 m. Bumpers and
    # lamps beside a grille are not surrounded.
    g = {k for k, (fi, _) in near.items() if fi in hit_faces}
    for _ in range(2):
        for (zi, xi), (fi, loc) in near.items():
            # Not paint: a body colour strut between two openings is surrounded by grille too (the
            # Golf's lower intake dividers came out black-spiked), and a logo is never paint.
            if fi in hit_faces or mats[fi] in ('Glass', 'Paint', *LAMP_MATS) or not in_zone(loc):
                continue
            side = lambda dz, dx: any((zi + dz * d, xi + dx * d) in g for d in range(1, 5))
            # Grille on both sides and above or below: a logo can fill a slim grille's whole height.
            if side(0, 1) and side(0, -1) and (side(1, 0) or side(-1, 0)):
                hit_faces.add(fi)
                g.add((zi, xi))
    # An opening is grille only when the fascia frames its row on both sides and it is at least two
    # rows tall: rays slipping past the body's edge into a wheel well, or into a hood shut line, are not.
    open_rows = {}
    for (zi, xi), kind in cell.items():
        if kind != 'open':
            continue
        if cell.get((zi + 1, xi)) != 'open' and cell.get((zi - 1, xi)) != 'open':
            continue
        left = next((cell.get((zi, j)) for j in range(xi - 1, xi - 80, -1) if cell.get((zi, j)) != 'open'), None)
        right = next((cell.get((zi, j)) for j in range(xi + 1, xi + 80) if cell.get((zi, j)) != 'open'), None)
        if left == 'near' and right == 'near':
            open_rows.setdefault(zi, []).append(xi)
    # Thin strokes (a ring logo) slip between the rays: any face sitting in front of grille, within
    # 8 cm of it and inside its footprint, joins it.
    depth = {k: near[k][1].y for k in g}
    for p in me.polygons:
        c = p.center
        k = (round(c.z / step), round(c.x / step))
        if p.index not in hit_faces and k in depth and mats[p.index] not in ('Glass', 'Paint', *LAMP_MATS) \
                and depth[k] - 0.08 < c.y < depth[k] + 0.01 and max((verts[i] - c).length for i in p.vertices) < 0.08:
            hit_faces.add(p.index)
    # Only faces wholly inside the grille zone: a big Black triangle reaching under the car stays Black.
    hit_faces = {fi for fi in hit_faces if all(in_zone(verts[i]) for i in me.polygons[fi].vertices)}
    grille = mat_index(o, material)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    targets = [bm.faces[i] for i in hit_faces]
    for f in targets:
        f.material_index = grille
        if flatten:
            f[own] = 1      # flat: the source normals would draw the slats and logos back in
    if flatten:
        flatten_grilles(bm, set(targets))
    quads = 0
    y_open = nose + 0.12
    for zi, cols in open_rows.items():
        cols = sorted(set(cols))
        runs, start = [], cols[0]
        for a, b in zip(cols, cols[1:] + [None]):
            if b != a + 1:
                runs.append((start, a))
                start = b
        zc = zi * step
        for c0, c1 in runs:
            x0, x1 = c0 * step - step / 2, c1 * step + step / 2
            vs = [bm.verts.new((x0, y_open, zc - step / 2)), bm.verts.new((x1, y_open, zc - step / 2)),
                  bm.verts.new((x1, y_open, zc + step / 2)), bm.verts.new((x0, y_open, zc + step / 2))]
            f = bm.faces.new(vs)
            f.material_index = grille
            f[own] = 1
            f.smooth = False
            f.normal_update()
            if f.normal.y > 0:
                f.normal_flip()
            targets.append(f)
            quads += 1
    uv = bm.loops.layers.uv['UVMap']
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = (0.0, 0.0)
    for f in targets:
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = (min(1.0, max(0.0, co.x / uv_span + 0.5)), min(1.0, max(0.0, co.z / uv_span)))
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(hit_faces), quads


def back_panels(o, panels, material='Black'):
    """Flat quads facing the nose, one per recipe `backPanels` entry `(x0, x1, y, z0, z1)`: a
    black panel behind an opening the pipeline's own grille quads do not cover (a lower intake
    with a bar in it, a fog lamp pocket), so nobody sees into the body."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    mi = mat_index(o, material)
    for x0, x1, y, z0, z1 in panels:
        f = bm.faces.new([bm.verts.new(v) for v in ((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1))])
        f.material_index = mi
        f[own] = 1
        f.smooth = False
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    me.update()


def lamp_strip(o, points, height, material):
    """A thin lamp strip along a curve, mirrored across x = 0: `points` (x, y, z) from the middle
    out, z the strip's top edge, `height` m tall, its faces turned out of the nearer end. A recipe
    `strips` entry `(points, height, material)`: a simple lamp in place of a fussy one (the RX-7's
    third brake light, along the top of the tail bar's black pocket)."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    mi = mat_index(o, material)
    path = [(-x, y, z) for x, y, z in reversed(points) if x > 0] + list(points)
    top = [bm.verts.new(p) for p in path]
    bottom = [bm.verts.new((x, y, z - height)) for x, y, z in path]
    out = 1 if path[0][1] > 0 else -1
    for i in range(len(path) - 1):
        f = bm.faces.new([bottom[i], bottom[i + 1], top[i + 1], top[i]])
        f.material_index = mi
        f[own] = 1
        f.smooth = False
        f.normal_update()
        if f.normal.y * out < 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    me.update()


def tuck_behind_glass(o, inset=0.004, reach=0.03, margin=0.02):
    """Push trim the reduction pulled through a window back behind it: every vertex of a face that
    is not Glass, lying over a Glass face (its projection inside the face, `margin` m in from the
    window's edge) and less than `reach` m in front of it, moves `inset` m behind the glass. The
    seals and frames round a window (on its edge) and the glass's own vertices stay. The Albrecht
    Kombi's rear window showed black splotches: the frit band and pillar trim just behind it, a
    few mm off, came through in the collapse. A non-glass face whose middle still lies over the
    glass (fanned across it from the seal) is deleted. Returns the vertices moved and faces gone."""
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    glass = [p for p in me.polygons if names[p.material_index] == 'Glass']
    if not glass:
        return 0
    verts = [v.co.copy() for v in me.vertices]
    tree = BVHTree.FromPolygons(verts, [list(p.vertices) for p in glass])
    on_glass = {v for p in glass for v in p.vertices}
    # The window's edge: glass edges used by one glass face.
    count = {}
    for p in glass:
        for e in p.edge_keys:
            count[e] = count.get(e, 0) + 1
    edge = [(verts[a], verts[b]) for (a, b), k in count.items() if k == 1]
    near_edge = lambda q: any((intersect_point_line(q, a, b)[0] - q).length < margin
                              and 0 <= intersect_point_line(q, a, b)[1] <= 1 for a, b in edge)
    moved = 0
    for i in {v for p in me.polygons if names[p.material_index] != 'Glass' for v in p.vertices} - on_glass:
        q = verts[i]
        hit, n, _, d = tree.find_nearest(q)
        if hit is None or d > reach:
            continue
        # Outward: the glass's normals face out of the car.
        depth = (q - hit).dot(n)
        if depth < -inset or ((q - hit) - n * depth).length > 1e-3 or near_edge(q):
            continue
        me.vertices[i].co = hit - n * inset
        moved += 1
    me.update()
    # A face fanned from the seal across the window (its corners on the edge, its middle over the
    # glass) cannot be pushed back: it goes. What it covered is behind the tinted glass.
    over = []
    for p in me.polygons:
        if names[p.material_index] == 'Glass':
            continue
        c = p.center
        hit, n, _, d = tree.find_nearest(c)
        if hit is not None and d < reach and (c - hit).dot(n) > -1e-3 and ((c - hit) - n * (c - hit).dot(n)).length < 1e-3 and not near_edge(c):
            over.append(p.index)
    if over:
        _delete_indices(o, lambda p: p.index in set(over))
    return moved + len(over)


def tuck_cabin(cabin, shell, inset=0.005, reach=0.05):
    """Pull every cabin vertex the reduced shell does not cover back inside it, `inset` m: across
    the car to the outermost skin at its height and station, down to the roof over it. The cabin
    and the shell are reduced apart, and a headliner corner or a seat bolster can end up standing
    through a door or the roof (the audit's `cabin inside the skin`; the Albrecht Kombi's
    headliner by 29 mm at the windshield's top corner). Returns the vertices moved."""
    me = shell.data
    tree = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [list(p.vertices) for p in me.polygons])
    moved = 0
    for v in cabin.data.vertices:
        c = v.co
        sx = 1 if c.x >= 0 else -1
        hit = tree.ray_cast(Vector((sx * 3, c.y, c.z)), Vector((-sx, 0, 0)))[0]
        roof = tree.ray_cast(Vector((c.x, c.y, 3)), Vector((0, 0, -1)))[0]
        co = c.copy()
        # Only a vertex a few cm out: past `reach` the ray slipped through a gap (between the
        # roof and a window) and found the far side or the floor.
        if hit is not None and abs(hit.x) - inset < abs(co.x) < abs(hit.x) + reach:
            co.x = sx * (abs(hit.x) - inset)
        if roof is not None and roof.z - inset < co.z < roof.z + reach:
            co.z = roof.z - inset
        if co != c:
            v.co = co
            moved += 1
    cabin.data.update()
    return moved


def _half_x(o):
    """Keep the +x half of `o`, cut exactly at x = 0 so its mirror meets it there."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, 0), plane_no=(1, 0, 0), clear_inner=True, dist=1e-6)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def _mirror_x(o):
    """Add the mirror of `o` across x = 0, welded at the seam: the faces reversed so they face out,
    the authored normals (`src_normal`) mirrored with them."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    sn = bm.loops.layers.float_vector.get('src_normal')
    faces = bm.faces[:]
    dup = bmesh.ops.duplicate(bm, geom=faces)
    new_faces = [g for g in dup['geom'] if isinstance(g, bmesh.types.BMFace)]
    new_verts = [g for g in dup['geom'] if isinstance(g, bmesh.types.BMVert)]
    for v in new_verts:
        v.co.x = -v.co.x
    if sn is not None:
        for f in new_faces:
            for loop in f.loops:
                n = loop[sn]
                loop[sn] = (-n[0], n[1], n[2])
    bmesh.ops.reverse_faces(bm, faces=new_faces)
    bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if abs(v.co.x) < 1e-5], dist=1e-5)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def mirror_normals(o):
    """Give every -x face that has an exact mirror twin at +x (the mirrored lamps and details) the
    twin's corner normals, mirrored. shade_from_source takes each side's normals from that side of
    the skin, and a donor a few mm off mirror shaded the Golf's left door handle with the wrong
    surface's normals: dark teeth on a handle whose geometry matched. Returns the faces set."""
    from mathutils.kdtree import KDTree
    me = o.data
    normals = [c.vector.copy() for c in me.corner_normals]
    plus = [p for p in me.polygons if p.center.x > 1e-4]
    tree = KDTree(len(plus))
    for k, p in enumerate(plus):
        tree.insert(p.center, k)
    tree.balance()
    done = 0
    for p in me.polygons:
        c = p.center
        if c.x > -1e-4:
            continue
        _, k, d = tree.find(Vector((-c.x, c.y, c.z)))
        if k is None or d > 1e-5:
            continue
        g = plus[k]
        twin = {tuple(round(v, 5) for v in me.vertices[me.loops[li].vertex_index].co): li for li in g.loop_indices}
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            lj = twin.get((round(-co.x, 5), round(co.y, 5), round(co.z, 5)))
            if lj is not None:
                n = normals[lj]
                normals[li] = Vector((-n.x, n.y, n.z))
        done += 1
    me.normals_split_custom_set(normals)
    me.update()
    return done


def wind_to_shading(o):
    """Turn every face whose winding points against its own corner normals (the source's shading,
    which faces out) so the two agree. The collapse and the seam welds leave a few such faces
    (83 on the Golf); drawn double sided, they read as dark teeth (the rear end of its left door
    handle). The corner normals ride through. Returns the faces turned."""
    me = o.data
    cn = me.corner_normals
    keep = {(p.index, me.loops[li].vertex_index): cn[li].vector.copy() for p in me.polygons for li in p.loop_indices}
    turn = []
    for p in me.polygons:
        avg = sum((cn[li].vector for li in p.loop_indices), Vector())
        if avg.length > 0 and p.normal.dot(avg.normalized()) < -0.5:
            turn.append(p.index)
    if not turn:
        return 0
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.reverse_faces(bm, faces=[bm.faces[i] for i in turn])
    bm.to_mesh(me)
    bm.free()
    me.normals_split_custom_set([keep[(p.index, me.loops[li].vertex_index)] for p in me.polygons for li in p.loop_indices])
    me.update()
    return len(turn)


def _snap_lamp_seams(bm, nshell, snap=0.012):
    """Weld the mirrored lamps' open edges to the shell's: on the -x side the shell's hole is the
    donor's own outline, a few mm off the mirror. Each shell vertex on an open edge moves onto the
    nearest open lamp vertex within `snap` m, then the two weld."""
    from mathutils.kdtree import KDTree
    bm.verts.ensure_lookup_table()
    open_v = lambda v: v.is_valid and any(e.is_boundary for e in v.link_edges)
    lamp_rim = [v for v in bm.verts[nshell:] if open_v(v)] if nshell < len(bm.verts) else []
    shell_rim = [v for v in bm.verts[:nshell] if open_v(v)]
    if not lamp_rim or not shell_rim:
        return
    tree = KDTree(len(lamp_rim))
    for k, v in enumerate(lamp_rim):
        tree.insert(v.co, k)
    tree.balance()
    for v in shell_rim:
        co, _, d = tree.find(v.co)
        if 1e-5 < d < snap:
            v.co = co
    bmesh.ops.remove_doubles(bm, verts=lamp_rim + shell_rim, dist=1e-5)


def _delete_indices(o, pred):
    """Delete the faces for which pred(polygon) is true (delete_faces by index or anything else of the face)."""
    me = o.data
    doomed = [p.index for p in me.polygons if pred(p)]
    if doomed:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in doomed], context='FACES')
        bm.to_mesh(me)
        bm.free()
        me.update()


def _carry_custom_normals(o):
    """The object's custom normals written into its `src_normal` corner attribute, so a bmesh join
    keeps them; _set_custom_normals reads them back."""
    me = o.data
    sn = me.attributes.get('src_normal') or me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
    sn.data.foreach_set('vector', [x for c in me.corner_normals for x in c.vector])


def _set_custom_normals(o):
    me = o.data
    sn = me.attributes.get('src_normal')
    if sn:
        me.normals_split_custom_set([v.vector.copy() for v in sn.data])


def _inside_lenses(o, reach=0.3):
    """A test of a point (Blender space): inside a lamp, under a clear cover (`Lens`) within `reach`
    m outward along the car (toward its nearer end). A box round the cover would not do: the
    RX-7's tail cover is one curved bar, and its box held the panel and the lettering below it.
    Nor a ray across the car: from the Golf's grille it met the headlamp cover's inboard side,
    and the grille bars were taken for lamp parts."""
    me = o.data
    names = [m.name.split('.')[0] if m else '' for m in me.materials]
    covers = [list(p.vertices) for p in me.polygons if names[p.material_index] == 'Lens']
    if not covers:
        return lambda c: False
    tree = BVHTree.FromPolygons([v.co.copy() for v in me.vertices], covers)
    return lambda c: tree.ray_cast(c, Vector((0, 1 if c.y > 0 else -1, 0)), reach)[0] is not None


def lamp_faces(o, extra=()):
    """Indices of the lamp faces: every lamp material, what sits inside a clear cover (`Lens`) in
    any material but Paint (the chrome reflectors, black housings and bulbs seen through it), and
    the faces any of `extra` (the recipe's `lamps`, pred(center, normal, material)) takes."""
    me = o.data
    names = [m.name.split('.')[0] if m else '' for m in me.materials]
    inside = _inside_lenses(o)
    return {p.index for p in me.polygons if names[p.material_index] in LAMP_MATS
            or (names[p.material_index] not in ('Paint', 'Interior') and inside(p.center))
            or any(f(p.center, p.normal, names[p.material_index]) for f in extra)}


def reduce_donor(cid, budget=BUDGET, mid=60000, interior=INTERIOR_BUDGET, lamps=LAMP_BUDGET):
    """`donor:<cid>.Low` at about `budget` triangles, in three steps: collapse to `mid` (a copy,
    `.Skin`), cull what cannot be seen from outside (cull_hidden), collapse the skin to the
    budget. Shading is the source's own: the authored normals ride along as an attribute and are
    set back on the reduced corners (shade_from_source); normals recomputed on a reduced mesh
    either balloon (all smooth) or facet at random (split by angle), and on a game-ready donor
    whose panels are slightly wavy they show every ripple. The cabin is reduced apart, to its own
    budget; the lamps first, to theirs, then welded back and held while the shell collapses round
    them to what the two leave of CAR_BUDGET (at most `budget`). Prints the culling and how far the low vertices drift from the full surface (mean and
    95th percentile, mm)."""
    full = bpy.data.objects[f'donor:{cid}.Full']
    lamps = DONORS[cid].get('lampBudget', lamps)
    lamp_error = DONORS[cid].get('lampError', LAMP_ERROR)
    car_budget = DONORS[cid].get('carBudget', CAR_BUDGET)
    budget = DONORS[cid].get('shellBudget', budget)
    skin = _copy(full, f'donor:{cid}.Skin')
    # The lamps ride through the first collapse untouched (held), so their own pass works from
    # the source's detail: collapsed to 60,000 with the rest, the Kombi's round fog lamps were
    # already octagons before the lamp pass saw them.
    extra = tuple(DONORS[cid].get('lamps', ())) + tuple(DONORS[cid].get('details', ()))
    held = lamp_faces(skin, extra)
    skin.data.attributes.new('lamp', 'BOOLEAN', 'FACE').data.foreach_set('value', [p.index in held for p in skin.data.polygons])
    _collapse(skin, mid, lock='lamp')
    skin.data.attributes.remove(skin.data.attributes['lamp'])
    for g in list(skin.vertex_groups):
        skin.vertex_groups.remove(g)
    gone, flipped = cull_hidden(skin)
    # The cabin is reduced apart, to its own budget: it touches nothing of the shell, and in one
    # collapse its 30,000 triangles of seats and dash would starve the mirrors and handles.
    # The lamps go first, on their own: an error-driven collapse eats small features first, and a
    # round tail lens or a reflector's facets are exactly that. They spread over the car's length,
    # so MESHOPT's 1 % let a cover drift 4 cm, and the Decimate finish cut the RX-7's round lenses
    # to diamonds. Their open edges stay where the shell meets them, so they weld back; the shell
    # then collapses round them with every lamp vertex held. Cut out and collapsed apart, the shell
    # pulled its open edge into shards on the panels round the lamps.
    low = _copy(skin, f'donor:{cid}.Low')
    cabin = _copy(skin, f'donor:{cid}.Cabin')
    lamp = _copy(skin, f'donor:{cid}.Lamps')
    ii = [i for i, m in enumerate(low.data.materials) if m and m.name.split('.')[0] == 'Interior']
    # Recipe `details`: small parts that must match side to side (door handles, mirrors) join the
    # lamps' pass: reduced at its finer error and mirrored.
    lit = lamp_faces(skin, extra)
    _delete_indices(low, lambda p: p.index in lit or low.data.materials[p.material_index].name.split('.')[0] == 'Interior')
    delete_faces(cabin, lambda c, n, m: m != 'Interior')
    _delete_indices(lamp, lambda p: p.index not in lit)
    lamp_tris = tris(lamp)
    # The lamps mirror side to side (recipe `mirrorLamps`, on unless False): the +x half is
    # reduced and copied across, so the two sides are alike to the vertex. Reduced whole, the
    # collapse cut each side its own way (the Golf's headlamp bowls, the Kombi's fog lamps), and
    # donors are often a few mm off mirror.
    mirrored = DONORS[cid].get('mirrorLamps', True)
    if lamp.data.polygons:
        if mirrored:
            _half_x(lamp)
        _collapse(lamp, lamps // 2 if mirrored else lamps, finish=False, error=lamp_error, flags=('LockBorder',))
        if mirrored:
            _mirror_x(lamp)
        shell = len(low.data.polygons)
        bm = bmesh.new()
        bm.from_mesh(low.data)
        nshell = len(bm.verts)
        bm.from_mesh(lamp.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        if mirrored:
            _snap_lamp_seams(bm, nshell)
        bm.to_mesh(low.data)
        bm.free()
        held = low.data.attributes.new('lamp', 'BOOLEAN', 'FACE')
        held.data.foreach_set('value', [i >= shell for i in range(len(low.data.polygons))])
    kept = tris(lamp) if lamp.data.polygons else 0
    print(f'{cid}: lamps {lamp_tris} -> {kept} tris')
    bpy.data.objects.remove(lamp)
    if cabin.data.polygons:
        _collapse(cabin, interior)
    # The shell takes what the cabin and the lamps leave of the car's budget, up to `budget`: a
    # fixed share set aside for lamps squeezed the Golf's shell (whose cabin is 938 triangles) to
    # 12,000 and its grille bars collapsed; squeezed to 10,000, the RX-7's doors fell inside its cabin.
    shell = min(budget, car_budget - kept - tris(cabin))
    _collapse(low, shell + kept, lock='lamp')
    if low.data.attributes.get('lamp'):
        low.data.attributes.remove(low.data.attributes['lamp'])
    for g in list(low.vertex_groups):
        low.vertex_groups.remove(g)
    recolored, quads = grille_surface(low, full['wheelbase'] / 2)
    if DONORS[cid].get('backPanels'):
        back_panels(low, DONORS[cid]['backPanels'])
    for points, height, material in DONORS[cid].get('strips', ()):
        lamp_strip(low, points, height, material)
    for center, radius, material in DONORS[cid].get('discs', ()):
        lamp_disc(low, center, radius, material)
    # Hand-made pieces (recipe `pieces`) go in last, into the reduced shell: spliced in before the
    # collapse, the shell round them folded into slivers.
    if DONORS[cid].get('pieces'):
        splice_pieces(cid, low)
    # Recipe `lowCull`: faces of the reduced shell to delete, for slivers the collapse makes
    # where a cut in the source left an edge (the Golf's lip fanned up to its cut grille bars).
    for pred in DONORS[cid].get('lowCull', ()):
        delete_faces(low, pred)
    tucked = tuck_behind_glass(low)
    if tucked:
        print(f'{cid}: {tucked} trim vertices and faces pushed back behind the glass')
    # Wheel well liners on or through the tire (recipe `liftLiners`) raised clear of it.
    if DONORS[cid].get('liftLiners'):
        hy, ht = full['wheelbase'] / 2, full['track'] / 2
        moved = lift_liners(low, [(sx * ht, sy * hy) for sx in (-1, 1) for sy in (-1, 1)], full['tireRadius'])
        print(f'{cid}: lifted {moved} liner vertices off the tires')
    turned = shade_from_source(low, skin)
    if cabin.data.polygons:
        tucked = tuck_cabin(cabin, low)
        if tucked:
            print(f'{cid}: {tucked} cabin vertices tucked inside the skin')
        turned += shade_from_source(cabin, skin)
        _carry_custom_normals(cabin)
        _carry_custom_normals(low)
        bm = bmesh.new()
        bm.from_mesh(low.data)
        bm.from_mesh(cabin.data)
        bm.to_mesh(low.data)
        bm.free()
        _set_custom_normals(low)
    bpy.data.objects.remove(cabin)
    if mirrored:
        print(f'{cid}: {mirror_normals(low)} mirrored faces given their twin\'s shading')
    print(f'{cid}: {wind_to_shading(low)} faces turned to face their shading')
    tree = surface_tree([full])
    d = sorted((tree.find_nearest(v.co)[3] or 0) for v in low.data.vertices)
    # Drift only sees the low vertices: a part collapsed away leaves none behind to measure. Lost
    # is the other way, the skin's vertices to the low surface.
    low_tree = surface_tree([low])
    lost = sorted((low_tree.find_nearest(v.co)[3] or 0) for v in skin.data.vertices)
    print(f'{cid}: {tris(full)} -> skin {tris(skin)} ({gone} hidden faces culled, {flipped} flipped) -> {tris(low)} tris (cabin {sum(1 for p in low.data.polygons if p.material_index in ii)}; {turned} turned; grille {recolored} faces + {quads} quads); '
          f'drift mean {sum(d) / len(d) * 1000:.1f} mm, p95 {d[int(len(d) * 0.95)] * 1000:.1f} mm; '
          f'lost p95 {lost[int(len(lost) * 0.95)] * 1000:.1f} mm, max {lost[-1] * 1000:.0f} mm')
    return low


def _pieces_path(cid):
    return os.path.join(REPO, f'assets/source/eshell/{cid}/{cid}.pieces.glb')


def save_pieces(cid, boxes, src=None, whole=True):
    """Keep hand-modelled regions of a shipped car as pieces a reimport splices back (recipe
    `pieces`, splice_pieces): for each `name: (lo, hi)` in `boxes` (Blender space), the faces of
    `src` (default `<cid>.Body`) centered in the box become an object `piece_<name>` carrying the
    box, all written to `assets/source/eshell/<cid>/<cid>.pieces.glb` (a GLB: saving part of the
    live session as a .blend crashes Blender 5.2). For work no recipe rule can express, such as the
    Golf's grille bars and lower intake, rebuilt by hand on 2026-10-27. `whole=False` lets the
    splice cut every shell face centred in the box (it hides), not only those wholly inside: for a
    piece whose box sits inside an opening, where the donor's tangle reaches past it."""
    body = bpy.data.objects[src or f'{cid}.Body']
    names = [m.name.split('.')[0].split('_')[-1] for m in body.data.materials]
    made = []
    for name, (lo, hi) in boxes.items():
        lo, hi = Vector(lo), Vector(hi)
        o = _copy(body, f'piece_{name}')
        o.matrix_world = Matrix.Identity(4)
        _delete_indices(o, lambda p: not all(lo[i] <= p.center[i] <= hi[i] for i in range(3)))
        for i, n in enumerate(names):
            o.data.materials[i] = shared_mat(n)
        o['cut_lo'], o['cut_hi'] = list(lo), list(hi)
        o['cut_whole'] = whole
        made.append(o)
        print(f'{cid}: piece {name}: {len(o.data.polygons)} faces')
    bpy.ops.object.select_all(action='DESELECT')
    for o in made:
        o.select_set(True)
    bpy.context.view_layer.objects.active = made[0]
    bpy.ops.export_scene.gltf(filepath=_pieces_path(cid), use_selection=True, use_active_scene=True, export_extras=True, export_apply=True)
    for o in made:
        bpy.data.objects.remove(o)


def splice_pieces(cid, low, snap=0.01, reach=0.1):
    """Splice the car's kept pieces (save_pieces) into the reduced shell: the faces centered in
    each piece's box go, the piece's faces come in, and every vertex on the piece's open edge is
    snapped to the nearest vertex on the hole's edge within `snap` m and welded, so the seam
    closes. Returns the triangles spliced in."""
    from mathutils.kdtree import KDTree
    path = _pieces_path(cid)
    if not os.path.exists(path):
        raise FileNotFoundError(f'{cid}: recipe `pieces` but no {path} (save_pieces)')
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = set(bpy.data.objects) - before
    pieces = [o for o in new if o.type == 'MESH' and 'cut_lo' in o]
    for o in new - set(pieces):
        bpy.data.objects.remove(o)
    added = 0
    for piece in pieces:
        bake(piece)
        lo, hi = Vector(piece['cut_lo']), Vector(piece['cut_hi'])
        # Only what the piece covers goes: a face in the box the piece hides seen along the car,
        # within `reach` in front or behind (the reduced grille's tangle sat between the piece's
        # bars and its back panel, and its teeth just off the hood edge), and only a face wholly
        # in the box: the box alone cut the bumper's corner beside the Golf's side intake, and
        # faces reaching past it the hood's and the bumper's lips, and left holes.
        cover = surface_tree([piece])
        covered = lambda c: any(cover.ray_cast(c, Vector((0, d, 0)), reach)[0] is not None for d in (1, -1))
        verts = low.data.vertices
        whole = lambda p: all(lo[i] <= verts[v].co[i] <= hi[i] for v in p.vertices for i in range(3))
        # Centred in the box and reaching at most 1 cm past it: a face reaching further leaves a gap
        # the piece does not cover (the Golf's hood lip over the grille).
        centred = lambda p: all(lo[i] <= p.center[i] <= hi[i] for i in range(3)) and \
            all(lo[i] - 0.01 <= verts[v].co[i] <= hi[i] + 0.01 for v in p.vertices for i in range(3))
        cut = whole if piece.get('cut_whole', True) else centred
        _delete_indices(low, lambda p: cut(p) and covered(p.center))
        bm = bmesh.new()
        bm.from_mesh(low.data)
        hole = [v for v in bm.verts if any(e.is_boundary for e in v.link_edges)
                and all(lo[i] - snap <= v.co[i] <= hi[i] + snap for i in range(3))]
        tree = KDTree(len(hole))
        for i, v in enumerate(hole):
            tree.insert(v.co, i)
        tree.balance()
        start = len(bm.verts)
        idx = {m.name.split('.')[0]: mat_index(low, m.name.split('.')[0]) for m in piece.data.materials if m}
        pm = bmesh.new()
        pm.from_mesh(piece.data)
        bmesh.ops.triangulate(pm, faces=pm.faces[:])
        own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
        vmap = {v: bm.verts.new(v.co) for v in pm.verts}
        for f in pm.faces:
            try:
                g = bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            m = piece.data.materials[f.material_index]
            g.material_index = idx[m.name.split('.')[0]] if m else 0
            g[own] = 1
            g.smooth = f.smooth
            added += 1
        welds = []
        for v, nv in vmap.items():
            if any(e.is_boundary for e in v.link_edges) and hole:
                co, _, d = tree.find(nv.co)
                if d <= snap:
                    nv.co = co
                    welds.append(nv)
        pm.free()
        if welds:
            bmesh.ops.remove_doubles(bm, verts=welds + hole, dist=1e-5)
        bm.to_mesh(low.data)
        bm.free()
        print(f'{cid}: spliced {piece.name}: {len(piece.data.polygons)} faces, {len(welds)} edge vertices welded')
        bpy.data.objects.remove(piece)
    return added


def lamp_disc(o, center, radius, material, segments=24):
    """A flat round lamp lens, `segments` triangles round `center` (x, y, z) in the car's xz
    plane, turned out of the nearer end: a recipe `discs` entry `(center, radius, material)`. A
    round lens is rebuilt, never collapsed (the wheels' rule): the RX-7's bumper lamps came out
    8- and 10-sided and unalike, side to side."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    mi = mat_index(o, material)
    cx, cy, cz = center
    hub = bm.verts.new((cx, cy, cz))
    rim = [bm.verts.new((cx + radius * math.cos(2 * math.pi * i / segments), cy, cz + radius * math.sin(2 * math.pi * i / segments)))
           for i in range(segments)]
    out = 1 if cy > 0 else -1
    for i in range(segments):
        f = bm.faces.new([hub, rim[i], rim[(i + 1) % segments]])
        f.material_index = mi
        f[own] = 1
        f.smooth = False
        f.normal_update()
        if f.normal.y * out < 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    me.update()


def lamp_islands(cid, lo, hi, mats=None, which='Full'):
    """The pieces of `donor:<cid>.<which>` centered in the box lo..hi (Blender space; both sides
    when lo.x >= 0, mirrored), one line each: material, faces, center, bounds, front (its least y,
    or greatest at the tail). Islands are split by material, so a lens, its reflector and its bulb
    print apart: the list a lamp's recipe is written from (docs/carDonors.md, Lamps). `mats`
    limits it to those materials. Sides are listed apart: donors are often a few mm off mirror."""
    me = bpy.data.objects[f'donor:{cid}.{which}'].data
    names = [m.name.split('.')[0] for m in me.materials]
    lo, hi = Vector(lo), Vector(hi)
    boxes = [(lo, hi)] + ([(Vector((-hi.x, lo.y, lo.z)), Vector((-lo.x, hi.y, hi.z)))] if lo.x >= 0 else [])
    inside = lambda q: any(all(a[i] <= q[i] <= b[i] for i in range(3)) for a, b in boxes)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    seen, rows = set(), []
    for f in bm.faces:
        if f.index in seen or (mats and names[f.material_index] not in mats) or not inside(f.calc_center_median()):
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen and h.material_index == f.material_index:
                        seen.add(h.index)
                        stack.append(h)
        pts = [v.co for g in comp for v in g.verts]
        a = Vector([min(q[i] for q in pts) for i in range(3)])
        b = Vector([max(q[i] for q in pts) for i in range(3)])
        rows.append((names[f.material_index], len(comp), (a + b) / 2, a, b))
    bm.free()
    for m, n, c, a, b in sorted(rows, key=lambda r: (r[2].x > 0, r[2].y, r[2].x)):
        front = a.y if c.y < 0 else b.y
        print(f'{m:10s} {n:6d} faces  center {fmt(c)}  {fmt(a)}..{fmt(b)}  front y {front:.3f}')
    return rows


def _clusters(points, reach=0.05):
    """Points (Vector, label) grouped by proximity: [(count, lo, hi, {label: count})], largest first."""
    groups = []
    for c, m in points:
        for g in groups:
            if any((c - q).length < reach for q, _ in g[:300]):
                g.append((c, m))
                break
        else:
            groups.append([(c, m)])
    out = []
    for g in groups:
        vs = [q for q, _ in g]
        labels = {}
        for _, m in g:
            labels[m] = labels.get(m, 0) + 1
        out.append((len(g), Vector([min(v[i] for v in vs) for i in range(3)]), Vector([max(v[i] for v in vs) for i in range(3)]), labels))
    return sorted(out, key=lambda r: -r[0])


def edit_diff(cid, edited, which='Low', tol=1e-5):
    """What a hand edit did, so it can go into the recipe: a reimport rebuilds the car from the
    donor and drops any edit made to the mesh. `edited` is a copy of `donor:<cid>.<which>` someone
    worked on (its materials may be study copies, `anything_Paint`: the name after the last `_`
    counts). Prints the faces removed, added and recoloured and the vertices moved, in clusters,
    and for each removed cluster the islands of `.Full` it reaches: an island wholly inside is an
    `islands` rule, a piece of a larger one a `cull` box (the RX-7's wiper blades were islands,
    the windshield seal's folded edge a cull)."""
    from mathutils import kdtree
    a = bpy.data.objects[f'donor:{cid}.{which}'].data
    b = bpy.data.objects[edited].data
    base = lambda m: m.name.split('.')[0].split('_')[-1] if m else ''
    an, bn = [base(m) for m in a.materials], [base(m) for m in b.materials]

    def tree(polys):
        t = kdtree.KDTree(len(polys))
        for p in polys:
            t.insert(p.center, p.index)
        t.balance()
        return t
    ta, tb = tree(a.polygons), tree(b.polygons)
    gone, recolored = [], []
    for p in a.polygons:
        _, i, d = tb.find(p.center)
        if d > tol:
            gone.append((p.center.copy(), an[p.material_index]))
        elif bn[b.polygons[i].material_index] != an[p.material_index]:
            recolored.append((p.center.copy(), f'{an[p.material_index]}->{bn[b.polygons[i].material_index]}'))
    added = [(p.center.copy(), bn[p.material_index]) for p in b.polygons if ta.find(p.center)[2] > tol]
    tv = kdtree.KDTree(len(a.vertices))
    for v in a.vertices:
        tv.insert(v.co, v.index)
    tv.balance()
    moved = [(v.co.copy(), 'vertex') for v in b.vertices if tv.find(v.co)[2] > tol]
    print(f'{cid}: {len(gone)} faces removed, {len(added)} added, {len(recolored)} recoloured, {len(moved)} vertices moved')
    full = bpy.data.objects[f'donor:{cid}.Full'].data
    fn = [m.name.split('.')[0] for m in full.materials]
    bm = bmesh.new()
    bm.from_mesh(full)
    bm.faces.ensure_lookup_table()
    for title, pts in (('removed', gone), ('added', added), ('recoloured', recolored), ('moved', moved)):
        for n, lo, hi, labels in _clusters(pts):
            print(f'  {title} {n}: {fmt(lo)}..{fmt(hi)} {labels}')
            if title != 'removed':
                continue
            box_lo, box_hi = lo - Vector((0.02,) * 3), hi + Vector((0.02,) * 3)
            inside = lambda q, l=box_lo, h=box_hi: all(l[i] <= q[i] <= h[i] for i in range(3))
            seen, found = set(), []
            for f in bm.faces:
                if f.index in seen or not inside(f.calc_center_median()):
                    continue
                stack, comp = [f], []
                seen.add(f.index)
                while stack:
                    g = stack.pop()
                    comp.append(g)
                    for e in g.edges:
                        for h in e.link_faces:
                            if h.index not in seen:
                                seen.add(h.index)
                                stack.append(h)
                share = sum(inside(g.calc_center_median()) for g in comp) / len(comp)
                found.append((share, comp))
            # The pieces mostly in the box: whole ones are `islands` rules, the rest `cull` boxes.
            for share, comp in sorted(found, key=lambda r: -r[0])[:3]:
                if share < 0.2:
                    break
                pts_ = [v.co for g in comp for v in g.verts]
                ilo = Vector([min(q[i] for q in pts_) for i in range(3)])
                ihi = Vector([max(q[i] for q in pts_) for i in range(3)])
                mats = sorted({fn[g.material_index] for g in comp})
                how = 'islands rule' if share > 0.99 else f'cull box ({share:.0%} of it in the edit)'
                print(f'    Full island {len(comp)} faces {fmt(ilo)}..{fmt(ihi)} {mats}: {how}')
    bm.free()


def ship_donor(cid, work):
    """`donor:<cid>.Low` into `<cid>.Body` and a working copy of the session at `work` for
    saveCar.py (docs/carDonors.md, Ship). The car's collections come from its authored .blend
    when the session does not hold them; the Rig empties and parts stay as they are, so this is for
    a reimport of a car whose wheelbase and track did not change. A donor without a cabin keeps
    the shipped body's transplanted one (carFeatures.py interior()), tucked inside the new shell.
    Prints the commands that finish it; nothing in the session's own file is touched (the copy is
    saved with copy=True)."""
    low = bpy.data.objects[f'donor:{cid}.Low']
    path = os.path.join(REPO, f'assets/source/eshell/{cid}/{cid}.blend')
    if f'{cid}:Car' not in bpy.data.collections:
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.collections = [c for c in src.collections if c.startswith(f'{cid}:')]
        for c in dst.collections:
            bpy.context.scene.collection.children.link(c)
    body = bpy.data.objects[f'{cid}.Body']
    old = body.data
    me = low.data.copy()
    # A donor without a cabin of its own ships with one transplanted by carFeatures.py interior():
    # the shipped body's Interior faces carry over, tucked inside the new shell.
    if not any(m and m.name.split('.')[0] == 'Interior' for m in me.materials) or \
            not any(me.materials[p.material_index].name.split('.')[0] == 'Interior' for p in me.polygons):
        cabin = body.copy()
        cabin.data = old.copy()
        bpy.context.scene.collection.objects.link(cabin)
        delete_faces(cabin, lambda c, n, m: m != 'Interior')
        if cabin.data.polygons:
            _carry_custom_normals(cabin)
            sn = me.attributes.get('src_normal') or me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
            sn.data.foreach_set('vector', [x for c in me.corner_normals for x in c.vector])
            tmp = bpy.data.objects.new('ship_tmp', me)
            bpy.context.scene.collection.objects.link(tmp)
            print(f'{cid}: kept the transplanted cabin, {len(cabin.data.polygons)} faces ({tuck_cabin(cabin, tmp)} tucked)')
            bm = bmesh.new()
            bm.from_mesh(me)
            ii = mat_index(tmp, 'Interior')
            remap = [mat_index(tmp, m.name.split('.')[0]) for m in cabin.data.materials]
            cb = bmesh.new()
            cb.from_mesh(cabin.data)
            vmap = {v: bm.verts.new(v.co) for v in cb.verts}
            for f in cb.faces:
                g = bm.faces.new([vmap[v] for v in f.verts])
                g.material_index = remap[f.material_index] if remap else ii
                g.smooth = f.smooth
            cb.free()
            bm.to_mesh(me)
            bm.free()
            _set_custom_normals(tmp)
            bpy.data.objects.remove(tmp)
        data = cabin.data
        bpy.data.objects.remove(cabin)
        bpy.data.meshes.remove(data)
    for n in ('src_normal', 'own_normals'):
        if me.attributes.get(n):
            me.attributes.remove(me.attributes[n])
    body.data = me
    bpy.data.meshes.remove(old)
    me.name = f'{cid}.Body'
    for k in ('wheelbase', 'tireRadius', 'track'):
        body[k] = low[k]
    remap_materials(body)
    # The source's normals ride on the reduced faces (shade_from_source): exportCar.py keeps them
    # rather than reshade from the reduced geometry, whose slivers read as hard facets.
    body['authored_normals'] = me.has_custom_normals
    bpy.ops.wm.save_as_mainfile(filepath=work, copy=True)
    print(f'{cid}: {len(me.polygons)} faces in {cid}.Body; then:\n'
          f'  /Applications/Blender.app/Contents/MacOS/Blender --background {work} --python scripts/blender/saveCar.py -- {cid} assets/source/eshell/{cid}/{cid}.blend\n'
          f'  npm run assets && npm run audit -- {cid}')


def _donor_car(cid, which):
    """Temporary `donor:<cid>:Car` and `:Rig` collections around the donor mesh, so measure()
    and ortho_sheet() read it like a car. Returns (key, cleanup)."""
    o = bpy.data.objects[f'donor:{cid}.{which}']
    key = f'donor:{cid}'
    car, rigc = coll(f'{key}:Car'), coll(f'{key}:Rig')
    for x in list(car.objects) + list(rigc.objects):
        bpy.data.objects.remove(x)
    car.objects.link(o.copy())
    for k, sx, sy in (('FL', 1, -1), ('FR', -1, -1), ('RL', 1, 1), ('RR', -1, 1)):
        e = bpy.data.objects.new(f'{key}.Wheel_{k}', None)
        e.location = (sx * o['track'] / 2, sy * o['wheelbase'] / 2, o['tireRadius'])
        rigc.objects.link(e)

    def cleanup():
        for x in list(car.objects) + list(rigc.objects):
            bpy.data.objects.remove(x)
        bpy.data.collections.remove(car)
        bpy.data.collections.remove(rigc)
    return key, cleanup


def donor_report(cids, which='Low'):
    """One row per car: size, tire, triangles, faces per shared material, and the stations
    measure() finds (belt, cabin, rakes, lamp heights, arch gap against the donor's own tire),
    so the differences in construction show side by side. Returns {cid: measure dict}."""
    out = {}
    for cid in cids:
        key, cleanup = _donor_car(cid, which)
        try:
            m = measure(key, quiet=True)
        finally:
            cleanup()
        o = bpy.data.objects[f'donor:{cid}.{which}']
        me = o.data
        mats = {}
        for p in me.polygons:
            n = me.materials[p.material_index].name.split('.')[0]
            mats[n] = mats.get(n, 0) + 1
        out[cid] = m
        f = lambda v, d=3: '-' if v is None else f'{v:.{d}f}'
        lamp = lambda l: '-' if not l else f"{l['height']:.3f}"
        print(f"{cid:13} {m['length']:.3f} x {m['width']:.3f} x {m['height']:.3f} wb {m['wheelbase']:.3f} tire {o['tireRadius']:.3f} "
              f"clear {m['groundClearance']:.3f} belt {f(m['beltLine'])} rakes {f(m['windshieldDeg'], 1)}/{f(m['rearGlassDeg'], 1)} "
              f"lamps {lamp(m['head'])}/{lamp(m['tail'])} gaps {m['archGapFront']}/{m['archGapRear']} tris {tris(o)}")
        print(f"{'':13} {', '.join(f'{k} {v}' for k, v in sorted(mats.items(), key=lambda kv: -kv[1]))}")
    return out


def compare_donors(cids, out_dir, which='Low', views=('side', 'front', 'rear'), res=(1400, 560)):
    """Orthographic sheets of each donor with temporary wheels at its own tire size, one PNG per car
    and view (<out_dir>/<cid>_<view>.png)."""
    for cid in cids:
        key, cleanup = _donor_car(cid, which)
        try:
            ortho_sheet(key, out_dir, views=views, refs=False, res=res)
        finally:
            cleanup()
        for v in views:
            p = os.path.join(out_dir, f'{key}_{v}.png')
            if os.path.exists(p):
                os.replace(p, os.path.join(out_dir, f'{cid}_{v}.png'))
    print('\n'.join(os.path.join(out_dir, f'{c}_{v}.png') for c in cids for v in views))
