"""
The shared car features, built the same way on every car from the house numbers in
scripts/blender/carSpecs.json and the car's own measured stations (carRefs.py measure):
pillars, mirrors, door handles, cowl and wipers, interior block, headlights and taillights
by signature, exhaust tips (docs/carDesign.md section 2). Every builder strips what it built
before, found by material and place rather than by name, so running twice is safe.

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/carRefs.py').read())
    exec(open(REPO + '/scripts/blender/carFeatures.py').read())
    apply_features('wendtStrom')                        # everything, then spec_check
    apply_features('wendtStrom', ['mirrors', 'lamps'])  # some
    m = measure('wendtStrom', quiet=True)
    lamps('wendtStrom', m, 'front', cover='slab')       # try another signature

Blender space (Z up, car facing -Y). Forward distances (fwd) are car space, positive toward
the nose, so a station from measure() becomes Blender y = -fwd.
"""
import math

from mathutils import Vector

FEATURES = ('pillars', 'mirrors', 'handles', 'cowl', 'interior', 'lamps', 'exhaust')

# Lamp cover outlines, (u, v) with u from the inner end to the outer, v from the bottom to the
# top; concave shapes are several convex polygons. The zone (where and how big) comes from the
# car's stations, so the same outline fits every car.
COVERS = {
    'teardrop': [[(0, 0.45), (0.15, 0.2), (0.55, 0.05), (0.9, 0.1), (1, 0.35), (0.95, 0.75), (0.7, 1), (0.3, 0.95), (0.05, 0.7)]],
    'slab': [[(0, 0), (0.92, 0), (1, 0.2), (1, 0.85), (0.9, 1), (0, 1)]],
    'flatCover': [[(0, 0.12), (0.08, 0), (0.92, 0), (1, 0.12), (1, 0.88), (0.92, 1), (0.08, 1), (0, 0.88)]],
    'slimWedge': [[(0, 0), (1, 0.28), (1, 0.72), (0, 1)]],
    'verticalUnit': [[(0.3, 0), (1, 0), (1, 1), (0.3, 1), (0, 0.6), (0, 0.4)]],
    'lUnit': [[(0, 0), (1, 0), (1, 0.45), (0, 0.45)], [(0.72, 0.45), (1, 0.45), (1, 1), (0.72, 1)]],
    'panel': [[(0, 0), (1, 0), (1, 1), (0, 1)]],
}
TALL_COVERS = ('verticalUnit',)


def _house():
    return load_specs()['house']['features']


def strip_islands(cid, pred):
    """delete_islands over every Car mesh; pred(faces, min, max, {material: faces})."""
    return sum(delete_islands(o, pred) for o in car_meshes(cid))


def _side_x(tree, sx, y, z):
    """World x of the car's side surface at (y, z) on side sx (+1 left), or None."""
    hit = tree.ray_cast(Vector((sx * 5, y, z)), Vector((-sx, 0, 0)))
    return hit[0].x if hit[0] else None


def _b_pillar(m):
    """(fwd of the pillar's rear edge, fwd of its front edge): measured when the car has a
    plausible one, else at 47 % of the cabin from the front (docs/carDesign.md)."""
    b = m['bPillar']
    if b and 0.06 <= b['zMax'] - b['zMin'] <= 0.2:
        return b['zMin'], b['zMax']
    front = m['cabinFront'] - 0.47 * (m['cabinFront'] - m['cabinRear'])
    return front - _house()['pillars']['bWidth'], front


# ----- pillars and glass -------------------------------------------------------

def _donor_pillar(cid, m, step=0.04):
    """A donor body's own B pillar: the longest run without side glass 25 to 70 % back along the
    cabin, 0.06 to 0.3 m long, as (rear fwd, front fwd) of a house width pillar centered in it.
    None on a lofted car, whose glass band is continuous there."""
    w = _house()['pillars']['bWidth']
    have = {round(-f[1].y / step) for f in faces_of(car_meshes(cid)) if f[0] == 'Glass' and abs(f[2].x) > 0.6}
    cf, cr = m['cabinFront'], m['cabinRear']
    lo, hi = cf - 0.7 * (cf - cr), cf - 0.25 * (cf - cr)
    best, run = [], []
    for k in range(math.ceil(lo / step), math.floor(hi / step) + 1):
        run = run + [k] if k not in have else []
        if len(run) > len(best):
            best = run
    if not 0.06 <= len(best) * step <= 0.3:
        return None
    mid = (best[0] + best[-1]) / 2 * step
    return mid - w / 2, mid + w / 2


def pillars(cid, m, frames='Glass'):
    """Side glass band: the B pillar Black, every other Black (window frames) to `frames`,
    Paint (C pillar, quarter panels) untouched. Frames go first, repeated until the band stops
    growing (a donor's frames sit past its last glass, so the cabin lengthens as they turn);
    then the B pillar is placed on the final cabin, the body cut at its edges, and painted."""
    if m['beltLine'] is None:
        print(f'{cid}: no side glass, nothing to do')
        return
    measured = m['bPillar'] and 0.06 <= m['bPillar']['zMax'] - m['bPillar']['zMin'] <= 0.2
    keep = _b_pillar(m) if measured else None
    donor = None if measured else _donor_pillar(cid, m)

    def cut_at(b0, b1, m):
        """Split the band at the pillar edges so no face straddles them."""
        band = lambda c: m['beltLine'] - 0.02 < c.z < m['windowTop'] + 0.02 and abs(-c.y - (b0 + b1) / 2) < 0.3
        for o in car_meshes(cid):
            cut(o, [((0, -b1, 0), (0, 1, 0), band), ((0, -b0, 0), (0, 1, 0), band)])
    if donor:
        cut_at(*donor, m)

    def band_faces(m, mats=('Glass', 'Black')):
        """(object, polygon, material) on the side glass band (as measure() finds it)."""
        belt, top, cf, cr = m['beltLine'], m['windowTop'], m['cabinFront'], m['cabinRear']
        # Only faces on the band itself: mirror panes and wiper ends share its height.
        gx = [abs(v.x) for f in faces_of(car_meshes(cid)) if f[0] == 'Glass' and abs(f[2].x) > 0.6 for v in f[3]]
        gx0, gx1 = min(gx) - 0.02, max(gx) + 0.02
        for o in car_meshes(cid):
            me = o.data
            for p in (me.polygons if me.materials else ()):
                c = p.center
                if abs(p.normal.x) < 0.6 or not (belt - 0.005 < c.z < top + 0.005) or not (cr - 0.01 < -c.y < cf + 0.01) or not (gx0 < abs(c.x) < gx1):
                    continue
                name = me.materials[p.material_index].name.split('.')[0]
                if name in mats:
                    yield o, p, name

    changed = 0
    for _ in range(12):
        step = 0
        for o, p, name in list(band_faces(m)):
            hold = keep or donor
            if name == 'Black' and not (hold and hold[0] <= -p.center.y <= hold[1]) and frames != 'Black':
                p.material_index = mat_index(o, frames)
                step += 1
        changed += step
        if not step:
            break
        m = measure(cid, quiet=True)
    b0, b1 = keep or donor or _b_pillar(m)
    if not keep:
        if not donor:
            cut_at(b0, b1, m)
        # The pillar is Black across the band, over glass or a donor's body colour pillar alike.
        for o, p, name in list(band_faces(m, ('Glass', 'Black', 'Paint'))):
            if b0 <= -p.center.y <= b1 and name != 'Black':
                p.material_index = mat_index(o, 'Black')
                changed += 1
    for o in car_meshes(cid):
        o.data.update()
    print(f'{cid}: B pillar fwd {b0:.3f}..{b1:.3f} ({"measured" if keep else "donor" if donor else "placed"}), {changed} faces recolored')


# ----- mirrors and handles -----------------------------------------------------

def mirrors(cid, m):
    """One each side at the A pillar foot: Paint housing on a stalk, Black pane on the rear face."""
    H = _house()['mirror']
    body = car_part(cid, 'Body')
    hw, hd, hh = H['housing']
    sw, sd, sh = H['stalk']
    yc = -(m['cabinFront'] - H['behindPillarFoot'])
    z0 = m['beltLine'] + H['aboveBelt']
    # The housing is what measure() calls a mirror; the stalk and pane are their own small boxes at the station.
    piece = lambda k, a, b, mats: (k <= 6 and set(mats) <= {'Paint', 'Black'} and abs((a.y + b.y) / 2 - yc) < 0.08
                                   and m['beltLine'] - 0.03 < (a.z + b.z) / 2 < z0 + hh + 0.02 and min(abs(a.x), abs(b.x)) > 0.4)
    strip_islands(cid, lambda k, a, b, mats: _is_mirror(m, a, b) or piece(k, a, b, mats))
    tree = surface_tree(car_meshes(cid))
    for sx in (1, -1):
        # The stalk stands on the door top just under the glass: above the belt the band can be a
        # thin wedge at the A pillar foot, and a ray there lands on the windshield edge.
        zd = m['beltLine'] - 0.01
        xb = _side_x(tree, sx, yc, zd)
        if xb is None:
            print(f'{cid}: no side surface for a mirror at y {yc:.2f} z {zd:.2f}')
            continue
        box(body, (xb - sx * 0.01, yc - sd / 2, zd), (xb + sx * sw, yc + sd / 2, z0 + sh), 'Paint')
        xi = xb + sx * (sw - 0.005 + H['outboard'])
        box(body, (xi, yc - hd / 2, z0 - 0.005), (xi + sx * hw, yc + hd / 2, z0 - 0.005 + hh), 'Paint')
        box(body, (xi + sx * 0.008, yc + hd / 2 - H['glassDepth'], z0 + 0.002), (xi + sx * (hw - 0.008), yc + hd / 2 + 0.001, z0 - 0.005 + hh - 0.007), 'Black')
    print(f'{cid}: mirrors at y {yc:.3f}, z {z0:.3f}')


def handles(cid, m):
    """Black bars under the belt line: one ahead of the B pillar, a second ahead of the rear arch on four door cars."""
    H = _house()['handle']
    spec = load_specs()['cars'][cid]
    body = car_part(cid, 'Body')
    strip_islands(cid, lambda k, a, b, mats: _is_handle(m, a, b))
    tree = surface_tree(car_meshes(cid))
    px, ln, hz = H['size']
    z = m['beltLine'] - H['belowBelt']
    _, b_front = _b_pillar(m)
    # `body.handleFwd` in the car's spec pins the first handle to a donor's own embossed one.
    stations = [spec['body'].get('handleFwd', b_front + 0.04 + ln / 2)]
    if spec['body']['doors'] >= 4:
        stations.append(min(-m['wheelbase'] / 2 + 0.45, stations[0] - 0.4))
    for sx in (1, -1):
        for f in stations:
            xb = _side_x(tree, sx, -f, z)
            if xb is None:
                print(f'{cid}: no side surface for a handle at fwd {f:.2f}')
                continue
            box(body, (xb - sx * 0.004, -f - ln / 2, z - hz / 2), (xb + sx * px, -f + ln / 2, z + hz / 2), H['material'])
    print(f'{cid}: handles at fwd {[round(s, 3) for s in stations]}, z {z:.3f}')


# ----- cowl and wipers ---------------------------------------------------------

def _cowl_zone(m):
    y_base = -m['cabinFront']
    return y_base, (y_base - 0.14, y_base + 0.03), (m['beltLine'] - 0.3, m['beltLine'] + 0.12)


def cowl(cid, m):
    """A Black strip over the hood's trailing edge at the windshield base, plus two wiper fins."""
    C = _house()['cowl']
    body = car_part(cid, 'Body')
    objs = car_meshes(cid)
    y_base, (y0, y1), (z0, z1) = _cowl_zone(m)
    strip_islands(cid, lambda k, a, b, mats: k < 200 and set(mats) <= {'Black'} and y0 < (a.y + b.y) / 2 < y1 and z0 < (a.z + b.z) / 2 < z1)
    half = m['width'] / 2 - 0.16
    corners = [(-half, y_base - C['length']), (half, y_base - C['length']), (half, y_base + 0.005), (-half, y_base + 0.005)]
    n = projected_quad(body, corners, 'z', -1, C['lift'], C['material'], nu=10, nv=2, target=objs)
    tree = surface_tree(objs)
    W = C['wipers']
    a = math.radians(W['sweepDeg'])
    for sx, length in ((1, W['lengths'][0]), (-1, W['lengths'][1])):
        bx, by = sx * 0.06, y_base - 0.02
        hit = tree.ray_cast(Vector((bx, by, 5)), Vector((0, 0, -1)))
        if hit[0]:
            fin(body, (bx, by, hit[0].z + C['lift'] + 0.002), (sx * math.cos(a), -math.sin(a), 0), length, W['thickness'], W['width'], 'Black')
    print(f'{cid}: cowl {n} cells at y {y_base:.3f}, wipers {W["lengths"]}')


# ----- interior ----------------------------------------------------------------

def _shell_tree(cid):
    """BVH over the car's meshes without the cabin: the skin and glass a cabin must stay inside."""
    verts, polys = [], []
    for o in car_meshes(cid):
        mw, me = o.matrix_world, o.data
        base = len(verts)
        verts += [mw @ v.co for v in me.vertices]
        polys += [[base + i for i in p.vertices] for p in me.polygons
                  if not me.materials or me.materials[p.material_index].name.split('.')[0] != 'Interior']
    return BVHTree.FromPolygons(verts, polys)


def _skin_limits(tree, v, belt):
    """(|x| of the side skin at (y, z), z of the roof or glass above (x, y)), each None when the
    ray finds nothing. Roof hits under the belt (a ray down an open side window to the sill)
    do not count."""
    sx = 1 if v.x >= 0 else -1
    side = _side_x(tree, sx, v.y, v.z)
    hit = tree.ray_cast(Vector((v.x, v.y, 5)), Vector((0, 0, -1)))
    top = hit[0].z if hit[0] and hit[0].z > belt else None
    return (abs(side) if side is not None else None), top


def cabin_outside(cid, m, tol=0.015):
    """Cabin vertices beyond the car's skin: [(how far, 'side' | 'top', (x, y, z))], worst first.
    The ray comes from outside, so a vertex seen through an open window is not counted, only
    one standing proud of a door, the glass or the roof (the R33's house block did, 9 cm)."""
    tree = _shell_tree(cid)
    out = []
    for o in car_meshes(cid):
        mw, me = o.matrix_world, o.data
        ids = {i for p in me.polygons if me.materials and me.materials[p.material_index].name.split('.')[0] == 'Interior' for i in p.vertices}
        for i in ids:
            v = mw @ me.vertices[i].co
            side, top = _skin_limits(tree, v, m['beltLine'])
            if side is not None and abs(v.x) > side + tol:
                out.append((abs(v.x) - side, 'side', tuple(v)))
            elif top is not None and v.z > top + tol:
                out.append((v.z - top, 'top', tuple(v)))
    return sorted(out, key=lambda t: -t[0])


def _cabin_faces(src):
    """A garage car's own cabin: ([world verts], [[indices]]) of its Interior faces."""
    verts, polys = [], []
    for o in car_meshes(src):
        mw, me = o.matrix_world, o.data
        if not me.materials:
            continue
        remap = {}
        for p in me.polygons:
            if me.materials[p.material_index].name.split('.')[0] != 'Interior':
                continue
            for i in p.vertices:
                if i not in remap:
                    remap[i] = len(verts)
                    verts.append(mw @ me.vertices[i].co)
            polys.append([remap[i] for i in p.vertices])
    return verts, polys


def interior(cid, m):
    """A real cabin (seats, dash, floor, door cards, headliner) for a donor that has none,
    transplanted from a garage car whose donor cabin ships (docs/carDesign.md, Interior): the
    source by seating (`cabin.seats` in the car's spec), cropped behind its last seat back,
    mapped station to station (cabin front to cabin front, crop to cabin rear, belt to belt,
    roof to roof), mirrored for right hand drive, then every vertex beyond this car's skin
    pulled in to `skinMargin` inside it and every vertex over an axle lifted clear of the wheel
    well. The source car's collections must be in the file."""
    I = _house()['interior']
    spec = load_specs()['cars'][cid].get('cabin', {})
    S = I['sources'][spec.get('seats', 'fourSeat')]
    src = S['car']
    body = car_part(cid, 'Body')
    for o in car_meshes(cid):
        delete_faces(o, lambda c, n, mat: mat == 'Interior')
    ms = measure(src, quiet=True)
    verts, polys = _cabin_faces(src)
    crop = S.get('cropFwd')
    if crop is not None:  # faces wholly behind the crop (a wagon's load floor) go
        polys = [p for p in polys if any(-verts[i].y >= crop for i in p)]
    rear_s = crop if crop is not None else ms['cabinRear']
    ky = (m['cabinFront'] - m['cabinRear'] - S.get('rearInset', 0)) / (ms['cabinFront'] - rear_s)
    kx = m['width'] / ms['width']
    kz = (m['roof'] - m['beltLine']) / (ms['roof'] - ms['beltLine'])
    mirror = -1 if spec.get('rhd') else 1

    def mapped(v):
        fwd = m['cabinFront'] + (-v.y - ms['cabinFront']) * ky
        dz = v.z - ms['beltLine']
        z = m['beltLine'] + (dz * kz if dz > 0 else dz)
        return Vector((mirror * v.x * kx, -fwd, z))

    used = sorted({i for p in polys for i in p})
    at = {i: k for k, i in enumerate(used)}
    pts = [mapped(verts[i]) for i in used]
    tree = _shell_tree(cid)
    margin = I['skinMargin']
    axles = (m['wheelbase'] / 2, -m['wheelbase'] / 2)
    well = m['wheelRadius'] + 0.1
    floor = 2 * m['wheelRadius'] + _house()['arch']['gap'][1] + margin
    pulled = 0
    for k, v in enumerate(pts):
        side, top = _skin_limits(tree, v, m['beltLine'])
        if side is not None and abs(v.x) > side - margin:
            v.x = math.copysign(max(side - margin, 0), v.x)
            pulled += 1
        if top is not None and v.z > top - margin:
            v.z = top - margin
            pulled += 1
        if any(abs(-v.y - a) < well for a in axles) and v.z < floor:  # out of the wheel wells
            v.z = floor
            pulled += 1
    inv = body.matrix_world.inverted()
    faces = [[at[i] for i in (reversed(p) if mirror < 0 else p)] for p in polys]
    add_geom(body, [inv @ v for v in pts], faces, 'Interior', outward='keep')
    print(f'{cid}: cabin from {src} ({len(faces)} faces{", right hand drive" if mirror < 0 else ""}), {pulled} vertices pulled inside the skin')


# ----- lamps -------------------------------------------------------------------

def _body_end(cid, end):
    """Blender y of the nose ('front') or tail ('rear') without the Chrome tips, so builders that
    pin to the tail do not creep outward each time they run after the exhaust."""
    ys = [(o.matrix_world @ o.data.vertices[i].co).y for o in car_meshes(cid) if o.data.materials
          for p in o.data.polygons if o.data.materials[p.material_index].name.split('.')[0] != 'Chrome' for i in p.vertices]
    return min(ys) if end == 'front' else max(ys)


def _deck_edge(cid, m):
    """Top of the tail panel: the deck, or the tailgate glass base when that sits lower (on a
    wagon the rear 0.3 m reach the roof, so the deck station is the roof, not the tailgate)."""
    tail = -_body_end(cid, 'rear')
    zs = [v.z for f in faces_of(car_meshes(cid)) if f[0] == 'Glass' and abs(f[2].x) < 0.6 and f[2].y > 0.3 and -f[1].y < tail + 0.6 for v in f[3]]
    return min([m['deckHeight']] + zs)


def _lamp_zone(cid, m, end, cover):
    """(inner |x|, outer |x|, bottom z, top z, height): between the bumper seam and the hood or
    deck edge, anchored at the top, height clamped to the house band (tall covers get twice).
    Rear lamps stop under the tailgate glass, except tall covers that climb the D pillar."""
    L = _house()['lamp']
    hw = m['width'] / 2
    if end == 'front':
        seam = car_part(cid, 'Bumper_Front')
        top = m['noseHeight'] - L['belowEdge']
        x0, x1 = L['frontInnerX'] * hw, L['frontOuterX'] * hw
        bottom = (bb(seam)[1].z if seam else m['noseHeight'] - 0.25) + L['aboveSeam']
    else:
        seam = car_part(cid, 'Bumper_Rear')
        top = (m['deckHeight'] if cover in TALL_COVERS else _deck_edge(cid, m)) - L['belowEdge']
        x0, x1 = L['rearInnerX'] * hw, L['rearOuterX'] * hw
        bottom = (bb(seam)[1].z if seam else m['deckHeight'] - 0.25) + L['aboveSeam']
    lo, hi = L['heightRange']
    if cover in TALL_COVERS:
        hi *= 2
    h = min(max(top - bottom, lo), hi)
    return x0, x1, top - h, top, h


def _poly_xz(poly, sx, x0, x1, zb, h, inset=0.0):
    """Map a (u, v) outline into the lamp box on side sx, optionally shrunk by `inset` meters."""
    us, vs = [p[0] for p in poly], [p[1] for p in poly]
    cu, cv = sum(us) / len(us), sum(vs) / len(vs)
    su = 1 - 2 * inset / max((max(us) - min(us)) * (x1 - x0), 1e-6) if inset else 1
    sv = 1 - 2 * inset / max((max(vs) - min(vs)) * h, 1e-6) if inset else 1
    return [(sx * (x0 + (cu + (u - cu) * su) * (x1 - x0)), zb + (cv + (v - cv) * sv) * h) for u, v in poly]


def strip_lamps(cid, m, end):
    """Old lamps at one end: lens, indicator and element faces back to Paint, then the small
    patch islands in the lamp band deleted (grilles sit lower and inboard, tips are Chrome)."""
    sign = 1 if end == 'front' else -1
    x0, x1, zb, zt, _ = _lamp_zone(cid, m, end, None)
    for o in car_meshes(cid):
        recolor(o, lambda c, n, mat: mat in ('HeadLight', 'TailLight', 'Light') and -c.y * sign > 0, 'Paint')
    end_fwd = -_body_end(cid, end)
    return strip_islands(cid, lambda k, a, b, mats: k < 400 and set(mats) <= {'Black', 'Paint'} and (b - a).x < 0.7 and (b - a).z < 0.4
                         and abs(-(a.y + b.y) / 2 - end_fwd) < 0.45 and zb - 0.05 < (a.z + b.z) / 2 < zt + 0.1 and max(abs(a.x), abs(b.x)) > x0 - 0.05)


def lamps(cid, m, end, **over):
    """Build the headlights (end 'front') or taillights ('rear') from the car's signature in
    carSpecs.json (override any of cover, elements, indicator, wrap, centerBar by keyword):
    Black housing, inset lens, Light indicator, round or bar elements, the rear wrap onto the
    quarter and the center bar, at the house offsets."""
    specs = load_specs()
    L = specs['house']['features']['lamp']
    sig = dict(specs['cars'][cid]['lights'][end])
    sig.update({k: v for k, v in over.items() if v is not None})
    body = car_part(cid, 'Body')
    objs = car_meshes(cid)
    lens = 'HeadLight' if end == 'front' else 'TailLight'
    toward = 1 if end == 'front' else -1
    strip_lamps(cid, m, end)
    tree = surface_tree(objs)  # every layer offsets from the bare panel, not from the layer under it
    x0, x1, zb, zt, h = _lamp_zone(cid, m, end, sig['cover'])
    share = L['indicatorShare']
    n = 0
    for sx in (1, -1):
        for poly in COVERS[sig['cover']]:
            n += project_polygon(body, _poly_xz(poly, sx, x0, x1, zb, h), 'y', toward, L['housingOffset'], 'Black', objs, tree=tree, max_jump=L['maxJump'])
            n += project_polygon(body, _poly_xz(poly, sx, x0, x1, zb, h, L['lensInset']), 'y', toward, L['lensOffset'], lens, objs, tree=tree, max_jump=L['maxJump'])
        ind = sig.get('indicator', 'none')
        if ind == 'bottomStrip':
            n += project_polygon(body, _poly_xz([(0.06, 0.05), (0.94, 0.05), (0.94, 0.05 + share), (0.06, 0.05 + share)], sx, x0, x1, zb, h), 'y', toward, L['indicatorOffset'], 'Light', objs, tree=tree, max_jump=L['maxJump'])
        elif ind == 'outerBlock':
            n += project_polygon(body, _poly_xz([(0.97 - share, 0.08), (0.97, 0.08), (0.97, 0.92), (0.97 - share, 0.92)], sx, x0, x1, zb, h), 'y', toward, L['indicatorOffset'], 'Light', objs, tree=tree, max_jump=L['maxJump'])
        el = sig.get('elements', 'none')
        if el == 'twinRound':
            rr = L['elementRadiusShare'] * h
            for cu in (0.3, 0.72):
                cx, cz = sx * (x0 + cu * (x1 - x0)), zb + 0.5 * h
                circle = [(cx + rr * math.cos(2 * math.pi * i / 10), cz + rr * math.sin(2 * math.pi * i / 10)) for i in range(10)]
                n += project_polygon(body, circle, 'y', toward, L['elementOffset'], lens, objs, tree=tree, max_jump=L['maxJump'])
        elif el == 'bar':
            n += project_polygon(body, _poly_xz([(0.1, 0.42), (0.9, 0.42), (0.9, 0.58), (0.1, 0.58)], sx, x0, x1, zb, h), 'y', toward, L['elementOffset'], lens, objs, tree=tree, max_jump=L['maxJump'])
        elif el == 'innerBlock':
            n += project_polygon(body, _poly_xz([(0.05, 0.1), (0.33, 0.1), (0.33, 0.9), (0.05, 0.9)], sx, x0, x1, zb, h), 'y', toward, L['elementOffset'], 'Light', objs, tree=tree, max_jump=L['maxJump'])
        if end == 'rear' and sig.get('wrap'):
            # The unit continues 0.12 m onto the quarter panel: a patch projected along x from outside.
            y_end = _body_end(cid, 'rear')
            n += projected_quad(body, [(y_end - 0.14, zb), (y_end - 0.01, zb), (y_end - 0.01, zt), (y_end - 0.14, zt)], 'x', -sx, L['housingOffset'], 'Black', nu=3, nv=2, target=objs, tree=tree, max_jump=L['maxJump'])
            n += projected_quad(body, [(y_end - 0.134, zb + 0.006), (y_end - 0.016, zb + 0.006), (y_end - 0.016, zt - 0.006), (y_end - 0.134, zt - 0.006)], 'x', -sx, L['lensOffset'], lens, nu=3, nv=2, target=objs, tree=tree, max_jump=L['maxJump'])
    if end == 'rear' and sig.get('centerBar'):
        zc = zb + 0.5 * h
        n += projected_quad(body, [(-x0 + 0.02, zc - 0.02), (x0 - 0.02, zc - 0.02), (x0 - 0.02, zc + 0.02), (-x0 + 0.02, zc + 0.02)], 'y', -1, L['housingOffset'], 'Black', nu=6, nv=1, target=objs, tree=tree, max_jump=L['maxJump'])
        n += projected_quad(body, [(-x0 + 0.025, zc - 0.014), (x0 - 0.025, zc - 0.014), (x0 - 0.025, zc + 0.014), (-x0 + 0.025, zc + 0.014)], 'y', -1, L['lensOffset'], lens, nu=6, nv=1, target=objs, tree=tree, max_jump=L['maxJump'])
    print(f"{cid} {end} lamps: {sig['cover']} + {sig.get('elements', 'none')}, indicator {sig.get('indicator', 'none')}: {n} cells, |x| {x0:.2f}..{x1:.2f}, z {zb:.3f}..{zt:.3f}")
    return n


# ----- exhaust -----------------------------------------------------------------

def exhaust(cid, m):
    """Stock twin tips, one per side, on the rear bumper piece so kits replace them with the bumper."""
    E = _house()['exhaust']
    target = car_part(cid, 'Bumper_Rear') or car_part(cid, 'Body')
    for o in car_meshes(cid):
        delete_islands(o, lambda k, a, b, mats: set(mats) == {'Chrome'} and (a.y + b.y) / 2 > m['wheelbase'] / 2)
    y_end = _body_end(cid, 'rear')
    hw = m['width'] / 2
    for sx in (1, -1):
        tube(target, (sx * 0.55 * hw, y_end - E['length'] + 0.03, m['groundClearance'] + 0.1), (0, 1, 0), E['tipRadius'], E['length'], E['material'])
    print(f'{cid}: exhaust tips at x {0.55 * hw:.2f}, z {m["groundClearance"] + 0.1:.3f}')


# ----- all ---------------------------------------------------------------------

def apply_features(cid, which=FEATURES):
    """Run the builders in order (each re-measures), remap materials, then print the spec check."""
    builders = {'pillars': pillars, 'mirrors': mirrors, 'handles': handles, 'cowl': cowl, 'interior': interior, 'exhaust': exhaust}
    m = measure(cid, quiet=True)
    for w in which:
        if w == 'lamps':
            lamps(cid, m, 'front')
            lamps(cid, m, 'rear')
        else:
            builders[w](cid, m)
        m = measure(cid, quiet=True)
    for o in car_meshes(cid):
        remap_materials(o)
    return spec_check(cid)
