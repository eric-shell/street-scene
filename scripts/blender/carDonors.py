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
    donor('protoWagon', 'Sketchfab_model.001')   # collect, classify, place, join -> donor:protoWagon.Full
    reduce_donor('protoWagon', BUDGET)           # decimated copy -> donor:protoWagon.Low
    donor_report(list(DONORS))                   # one table: size, scale check, triangles, materials, stations
    compare_donors(list(DONORS), OUT)            # side / front / rear sheets, same framing for every car

A recipe classifies by regex: `materials` maps the import's material names to a shared
material, None (drop those faces) or 'Lamp' (HeadLight ahead of the axles' midpoint, TailLight
behind, Light between the axles: mirror repeaters); `drop` removes whole meshes whose name or
any parent's name matches (the imports name parts on the empties above the meshes); `recolor`
fixes faces after the join (a glass roof to Paint, lamp covers cut from the window glass);
`cull` deletes stray faces after the join. Every material must be classified: an
unknown one raises, so nothing ships by accident. Blender space: meters, Z up, car facing -Y
(all four imports already do); the import is scaled to the car's published length, and the
measured wheelbase against the published one is the scale check.
"""
import re

exec(open(os.path.join(REPO, 'scripts/blender/meshopt.py')).read())   # meshopt_reduce

BUDGET = 16000   # triangles per car for the reduced donor shell, the same for every car: at 8,000 mirrors, handles and lamp edges smeared
INTERIOR_BUDGET = 2500   # triangles for the donor's own cabin (dash, seats, door cards), seen through the glass
REDUCER = 'meshopt'   # _collapse: 'meshopt' (meshopt.py) or 'blender' (the Decimate modifier, mirror-symmetric)

DONORS = {
    'protoWagon': {
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
            r'^(lights_glass|textured_reflector(\.\d+)?|detail_glass_clear|head_light|reverse_light_lod0)$': 'Lamp',
            r'^(detail_glass_red|reflector|tail_light_lod0)$': 'TailLight',
            r'^(window|black_glass)$': 'Glass',
            r'^(chrome|chrome_2|exhaust_chrome_thing)$': 'Chrome'},
        # What strip_wipers leaves of the wiper arms on the cowl, and the whip antenna on the roof.
        'islands': [lambda k, a, b, mats: set(mats) == {'Black'} and k < 400 and -1.12 < (a.y + b.y) / 2 < -0.86 and 0.84 < (a.z + b.z) / 2 < 0.95
                    and max(b - a) < 0.25,
                    lambda k, a, b, mats: set(mats) == {'Black'} and abs((a.x + b.x) / 2) < 0.03 and b.z > 1.45 and (b - a).x < 0.05],
    },
    'protoHatch': {
        'name': '2002 Volkswagen Golf R32 (Mk4)',
        'uid': '98e6828648084ae3b877ad69e8ad36dc',
        'author': 'tangwang920',
        'license': 'CC Attribution',
        'mm': {'length': 4149, 'wheelbase': 2518},
        'tires': r'TARMAC_TYRE_TREAD',
        # `material` is one atlas for the trim, seals, bumper inserts and mirror housings; `chassis`
        # the underbody.
        'materials': {r'^material$': 'Black', r'^chassis$': 'Black'},
        # The lamp lenses are `glass` like the windows: the headlight covers are their own mesh at
        # the nose, the tail lenses part of the rear glass at the corners below the hatch window.
        'recolor': [(lambda c, n, m: m == 'Glass' and c.y < -1.5, 'HeadLight'),
                    (lambda c, n, m: m == 'Glass' and c.y > 1.55 and c.z < 0.95 and abs(c.x) > 0.4, 'TailLight')],
        # The paint disc behind the grille badge, and the roof antenna's stub.
        'cull': [lambda c, n, m: m == 'Paint' and abs(c.x) < 0.075 and c.y < -1.98 and 0.57 < c.z < 0.7,
                 lambda c, n, m: m == 'Black' and abs(c.x) < 0.04 and 1.27 < c.y < 1.41 and c.z > 1.38],
    },
    'protoCoupe': {
        'name': '1999 Mazda RX-7 (FD3S)',
        'uid': '06986b70c65b44c5a7315ed467b621a6',
        'author': 'niev',
        'license': 'CC Attribution',
        'mm': {'length': 4285, 'wheelbase': 2425},
        'turn': (-90, 0, 0),   # -Y up, nose at -Z
        # `material` is the wheels, Material__1..4 the number plates; clear and orange glass are the
        # lamp lenses (pop-ups modelled raised, bumper lamps, indicators), not windows.
        'materials': {r'^material$': None, r'^Material__\d$': None, r'^(clearglass|orangeglass)$': 'Lamp', r'^redglass$': 'TailLight',
                      r'^windowglass$': 'Glass', r'^carpaint$': 'Paint', r'^black$': 'Black', r'^chrome$': 'Chrome', r'^mirror$': 'Black'},
        # The pop-up lamps are modelled raised, with black lids: on the car the lids are body panels,
        # and black ones read as bars hung in front of the lamps.
        'recolor': [(lambda c, n, m: m == 'Black' and 0.45 < abs(c.x) < 0.78 and -1.9 < c.y < -1.58 and c.z > 0.58, 'Paint')],
        # The nose and tail badges and the tail lettering: chrome islands of 2,000 to 2,700 faces,
        # past the de-badge limit, which the tail lamps' chrome reflectors (1,856) must stay under.
        # Then the inboard flap of each raised pop-up lid, a plane floating over the lamp (cut by
        # hand in the shipped file on 2026-10-22, kept here so a rebuild cuts it too).
        'cull': [lambda c, n, m: 0.46 < abs(c.x) < 0.53 and -1.95 < c.y < -1.6 and 0.76 < c.z < 0.83,
                 lambda c, n, m: m == 'Chrome' and abs(c.x) < 0.05 and c.y < -1.89 and 0.55 < c.z < 0.63,
                 lambda c, n, m: m == 'Chrome' and abs(c.x) < 0.05 and c.y > 2.11 and 0.68 < c.z < 0.77,
                 lambda c, n, m: m == 'Chrome' and 0.26 < abs(c.x) < 0.35 and c.y > 2.1 and 0.69 < c.z < 0.73],
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
    (r'(?i)glass|window|windiw|vidrio', 'Glass'),
    (r'(?i)light|lamp|lens|reflector|luz', 'Lamp'),
    (r'(?i)paint|body|carroc', 'Paint'),
    (r'(?i)chrome|nickel|exhaust|metal', 'Chrome'),
    (r'(?i)black|plastic|trim|grill|rubber|detail|matte|mirror', 'Black'),
]
TIRES = r'(?i)tire|tyre|llanta'


def _classify(R, mat_name):
    """The shared material for an import material, 'drop', or KeyError when nothing matches. The
    name is matched without Blender's `.001` suffix, which a second import in the session adds."""
    mat_name = _base(mat_name)
    for pat, target in list(R.get('materials', {}).items()) + AUTO:
        if re.search(pat, mat_name):
            return 'drop' if target is None else target
    raise KeyError(f'{R["name"]}: no class for material {mat_name!r}')


def patch_out(o, lo, hi, mats=None, flush=True, ring=0.12):
    """Remove a feature the generic car does without. flush=False: delete the faces centered in the
    box lo..hi (of `mats` only, when given): a part lying on the body (roof plate, antenna).
    flush=True: press it into its panel instead (sunroof, fuel door): fit a quadratic to the Paint
    faces in a `ring` around the box, in that panel's own frame (so a roof and a quarter panel work
    alike), move every vertex in the box onto it and paint the box's faces. The topology stays, so
    the reduction sees one smooth panel; deleting and covering leaves open, branching edges and
    overlaps that the collapse folds into dark slivers. Returns the faces changed."""
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
        for v in {v for f in hit for v in f.verts}:
            u, w = (v.co - c0).dot(t1), (v.co - c0).dot(t2)
            v.co = c0 + t1 * u + t2 * w + n0 * surf(u, w)
        for f in hit:
            f.material_index = paint
            f.normal_update()
            if f.normal.dot(n0) < 0:
                f.normal_flip()
            if sn is not None:
                for loop in f.loops:
                    u, w = (loop.vert.co - c0).dot(t1), (loop.vert.co - c0).dot(t2)
                    du, dv = k[1] + 2 * k[3] * u + k[5] * w, k[2] + 2 * k[4] * w + k[5] * u
                    loop[sn] = (n0 - t1 * du - t2 * dv).normalized()
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(hit)


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


def donor_axles(objs, tire_pat, obj_pat=None):
    """(front axle y, rear axle y, tire radius, ground z, track) from the faces of the tire material
    (on meshes under a part matching obj_pat, when given): split front and rear at their mean; the
    track is between the left and right tires' centers."""
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
    left = [p.x for p in front if p.x > 0]
    return ctr(front), ctr(rear), r, min(p.z for p in pts), min(left) + max(left)


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
        fy, ry, r, ground, track = donor_axles(src, R.get('tires', TIRES), R.get('tireObjects'))
    finally:
        if turn != Matrix.Identity(4):
            back = turn.inverted()
            for o in src:
                o.matrix_world = back @ o.matrix_world
            bpy.context.view_layer.update()
    # Scaled from the published wheelbase: an import's own size can be anything (a ground dome or a
    # backdrop in the scene sets Sketchfab's normalized size). The length is the check.
    k = R['mm']['wheelbase'] / 1000 / (ry - fy)
    move = Matrix.Scale(k, 4) @ Matrix.Translation((0, -(fy + ry) / 2, -ground)) @ turn
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
        doomed = [p.index for p in me.polygons if names[p.material_index] == 'drop']
        tmp = bmesh.new()
        tmp.from_mesh(me)
        tmp.faces.ensure_lookup_table()
        bmesh.ops.delete(tmp, geom=[tmp.faces[i] for i in doomed], context='FACES')
        # Every piece indexes the full shared list ('Lamp' resolved after the join), so they merge as is.
        for f in tmp.faces:
            n = names[f.material_index]
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
    for lo, hi, mats, flush in R.get('patches', ()):
        print(f'{cid}: patched {patch_out(full, Vector(lo), Vector(hi), mats, flush)} faces')
    # Hubs, lug nuts, calipers and discs the material names did not give away (the RX-7's are
    # plain black and chrome): loose islands inside the tires' cylinders, out at the track.
    hubs = delete_islands(full, lambda k, a, b, mats: 'Paint' not in mats and abs((a.x + b.x) / 2) > track / 2 - 0.3
                          and any(math.hypot((a.y + b.y) / 2 - ay, (a.z + b.z) / 2 - r) < 0.85 * r for ay in (fy, ry)))
    print(f'{cid}: {strip_wipers(full)} wipers removed, {strip_antennas(full)} antennas removed')
    # De-badge: lettering and logos are small loose all-Black (formerly chrome) islands on the nose
    # and tail, above exhaust tip height; a generic car carries none. A finely modelled logo runs
    # past a thousand faces (the Golf's are 900 and 1,168).
    ends = (ry - fy) / 2 + 0.25
    badges = delete_islands(full, lambda k, a, b, mats: set(mats) <= {'Black', 'Chrome'} and max((b - a).x, (b - a).z) < 0.3
                            and abs((a.y + b.y) / 2) > ends and (a.z + b.z) / 2 > 0.45 and k < 1500)
    # Anywhere on the body: emblems, scripts and stickers are thin (under 12 mm) and small (under
    # 0.35 m) loose islands of any paint-free material, lying on a panel. Lamps and glass are not.
    badges += delete_islands(full, lambda k, a, b, mats: k < 300 and not set(mats) & {'Glass', 'HeadLight', 'TailLight', 'Light', 'Paint'}
                             and sorted(b - a)[0] < 0.012 and sorted(b - a)[2] < 0.35 and (a.z + b.z) / 2 > 0.2)
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


def cull_hidden(o, dirs=None, through=('Glass',)):
    """Keep only the outer skin: a face survives when a ray from it escapes the car in some view
    direction, from its front or its back (then it is flipped to face out). Inner door jambs,
    panel flanges, double layers and anything boxed in go: they are invisible, cost triangles, and
    a collapse that welds them to the skin is what blotches a reduced car. The `through` materials
    (glass) do not block a ray: what sits behind a window, the cabin, is seen in the game too.
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
    # ray test, and the collapse folds the two layers into dark wedges.
    gi = [i for i, m in enumerate(o.data.materials) if m and m.name.split('.')[0] == 'Glass']
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


def _collapse(o, budget):
    """Planar dissolve then a collapse to about `budget` triangles: meshoptimizer's, which weighs
    the `src_normal` shading and keeps material edges, as far as it goes without tearing parts
    off; the Decimate modifier's mirror-symmetric collapse finishes the rest (all of it with
    REDUCER = 'blender')."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(2.0), verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()
    have = tris(o)
    if have > budget and REDUCER == 'meshopt':
        have = meshopt_reduce(o, budget, uv=False)[0]
    if have > budget:
        mod = o.modifiers.new('reduce', 'DECIMATE')
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
    lamps = [list(p.vertices) for p in me.polygons if mats[p.index] in ('HeadLight', 'Light', 'TailLight')]
    ltree = BVHTree.FromPolygons(verts, lamps) if lamps else None
    nose = min(v.y for v in verts)
    floor_z = min(v.z for v in verts) + 0.08
    # Grilles live in the front fascia: below the top of the front 0.3 m (the hood's leading edge).
    fascia_top = max(v.z for v in verts if v.y < nose + 0.3)
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
            if fi in hit_faces or mats[fi] in ('Glass', 'HeadLight', 'TailLight', 'Light') or not in_zone(loc):
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
        if p.index not in hit_faces and k in depth and mats[p.index] not in ('Glass', 'HeadLight', 'TailLight', 'Light') \
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


def reduce_donor(cid, budget=BUDGET, mid=60000, interior=INTERIOR_BUDGET):
    """`donor:<cid>.Low` at about `budget` triangles, in three steps: collapse to `mid` (a copy,
    `.Skin`), cull what cannot be seen from outside (cull_hidden), collapse the skin to the
    budget. Shading is the source's own: the authored normals ride along as an attribute and are
    set back on the reduced corners (shade_from_source); normals recomputed on a reduced mesh
    either balloon (all smooth) or facet at random (split by angle), and on a game-ready donor
    whose panels are slightly wavy they show every ripple. Prints the culling and how far the low
    vertices drift from the full surface (mean and 95th percentile, mm)."""
    full = bpy.data.objects[f'donor:{cid}.Full']
    skin = _copy(full, f'donor:{cid}.Skin')
    _collapse(skin, mid)
    gone, flipped = cull_hidden(skin)
    # The cabin is reduced apart, to its own budget: it touches nothing of the shell, and in one
    # collapse its 30,000 triangles of seats and dash would starve the mirrors and handles.
    low = _copy(skin, f'donor:{cid}.Low')
    cabin = _copy(skin, f'donor:{cid}.Cabin')
    ii = [i for i, m in enumerate(low.data.materials) if m and m.name.split('.')[0] == 'Interior']
    delete_faces(low, lambda c, n, m: m == 'Interior')
    delete_faces(cabin, lambda c, n, m: m != 'Interior')
    _collapse(low, budget)
    recolored, quads = grille_surface(low, full['wheelbase'] / 2)
    turned = shade_from_source(low, skin)
    if cabin.data.polygons:
        _collapse(cabin, interior)
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
