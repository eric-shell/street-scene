"""
Wheels from donor models: one real rim per Street Scene wheel (Sketchfab, CC BY), made generic
and fitted to one house tire, so every wheel shares a tire, a size and a construction and
differs only in its rim (docs/carWheels.md).

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/carRefs.py').read())
    exec(open(REPO + '/scripts/blender/carDonors.py').read())     # cull_hidden, shade_from_source, ...
    exec(open(REPO + '/scripts/blender/carWheels.py').read())
    import_asset(source='sketchfab', id=WHEELS[name]['uid'], target_size=0.65)   # MCP tool
    w = wheel(name, '<import root>')     # -> wheels:Wheels / wheel_<name>
    wheel_report(list(WHEELS))

Material names on wheel models are useless (`Material.026`, `blinn1`, `MainColor`), so the
pipeline works from geometry: the axle is the axis the other two are round about; the scene
junk (display stands, logo planes, backdrops) goes by name or by being far from round; the
source tire, if any, is the island whose tread covers the middle of its width at the outer
radius; everything else is rim. The rim is scaled so its lip sits on the house tire's bead,
squeezed to fit the tire's width and turned to face +X; its barrel and lip are replaced by one
turned house ring, the hub gets a house center cap (covering any logo), and what is left of the
donor (the spokes and hub) is reduced to RIM_BUDGET and shaded from its own authored normals.
A wheel whose character is its lip (a polished, riveted multi-piece lip, a stepped dish) turns
its ring from the donor's own profile instead (recipe `lip: 'donor'`): the house ring would wipe
out exactly what makes it that wheel, and a collapsed donor lip comes out polygonal. The donor's
rivets stay, and its spokes get LIP_BUDGET.

Wheel space (exportCar.py): center at the origin, axle along X, the face toward +X. The game
scales a wheel so the tire's outer radius meets the car's wheel radius and remaps the rim for
the size slider from where the Tire mesh meets the rest (src/render/car/wheelFit.ts).
"""
import re

TIRE_R = 0.28        # m, house tire outer radius (standardWheel)
TIRE_W = 0.24        # m, house tire width
BEAD = 0.74          # rim lip radius / tire radius: a 16 inch rim on a 0.28 m tire
TIRE_SEG = 40        # segments around the house tire
RIM_BUDGET = 1300    # triangles for the donor face (spokes, hub); the house ring adds TIRE_SEG * 12, the tire TIRE_SEG * 24
LIP_BUDGET = 2000    # triangles for the donor face of a `lip: 'donor'` wheel: mesh and multi-spoke faces shard at RIM_BUDGET
LIP_BANDS = 10       # radial bands sampled for a donor lip profile; the turned lip adds TIRE_SEG * (LIP_BANDS + 4) * 2
CAP = 0.2            # house center cap radius / rim lip radius

# Dropped from every wheel by material or object name: display scenes, branding, brakes.
# Whole words only: `MaterialStandart` is a rim, `GLTF_SceneRootNode` holds everything.
JUNK = r'(?i)(?<![a-z])(stand|ground|plane|shadow|floor|backdrop|logo|badge|emblem|decal|brake|caliper|calliper|disc|disk|rotor)(?![a-z])'

WHEELS = {
    'kiba': {'name': 'BBS RS16 style mesh', 'uid': '4e50d45e5ff04d00927a50c150e088c1', 'author': 'TinoD2', 'license': 'CC Attribution',
             'drop': r'^Material(\.\d+)?$',   # the backdrop: Blender numbers its material per session
             'lip': 'donor', 'dish': 0.66},   # the turned lip starts where the mesh ends; the rivets ride on it
    'hoshi': {'name': 'Mugen M7 style seven spoke', 'uid': '3efc6a0cb9cc44d9adf24e226991a261', 'author': 'TinoD2', 'license': 'CC Attribution',
              'lip': 'donor', 'dish': 0.8},
    'rensa': {'name': 'Work Equip 03 style deep dish', 'uid': '58330f40b725444e8c00bdbbfd88cc98', 'author': 'TinoD2', 'license': 'CC Attribution',
              'face': 1,   # the deep dish's barrel outweighs the thin spokes in the face-side normal vote
              'lip': 'donor', 'dish': 0.74},
    'tsuki': {'name': 'Work Meister S1 style three piece', 'uid': '7205c04f3cb24a7dbdaf6a304fb31f21', 'author': 'alexanderlyreo', 'license': 'CC Attribution',
              'dish': 0.74, 'lip': 'donor'},
    'ginga': {'name': 'Stance steel 13x10', 'uid': '6c8a9dc226b64454a3af8dc37f7359ec', 'author': 'terllok', 'license': 'CC Attribution',
              'dish': 0.7},
    'hibana': {'name': 'Wire rim', 'uid': 'bda093957f8e47a7b27270de6c3e0d14', 'author': '3dpeter', 'license': 'CC Attribution'},
    'senko': {'name': 'Concept rim', 'uid': 'e36860f9f8de4d8e8429cb07007142f2', 'author': 'LagzDesign', 'license': 'CC Attribution'},
    # (Its spokes run out to a thin plain ring, which the house ring matches; turned from its own
    # profile, the spoke tips left slivers past the lip.)
    'arashi': {'name': 'Five spoke rim', 'uid': '232904121fff4e558b55ce724df7e47f', 'author': 'UnforgettableName', 'license': 'CC Attribution'},
}


def _gather(root, R):
    """The import's meshes joined into one bmesh in world space, junk dropped, with each face's
    source material name kept in `mat_names` and the authored normals in `src_normal`."""
    bm = bmesh.new()
    names = []
    top = bpy.data.objects[root]
    for o in _descendants(top):
        below = []
        p = o
        while p is not None and p is not top:
            below.append(_base(p.name))
            p = p.parent
        if o.type != 'MESH' or any(re.search(JUNK, n) for n in below):
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
        t.faces.ensure_lookup_table()
        junk = [f for f in t.faces if re.search(JUNK, mats[f.material_index]) or (R.get('drop') and re.search(R['drop'], mats[f.material_index]))]
        bmesh.ops.delete(t, geom=junk, context='FACES')
        for f in t.faces:
            f.material_index = len(names) + f.material_index
        names += mats
        t.to_mesh(me)
        t.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
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
    """Rotate and move so the axle is X and the wheel is centered; returns the outer radius."""
    pts = [v.co for v in bm.verts]
    lo, hi = Vector(map(min, *pts)), Vector(map(max, *pts))
    e = hi - lo
    # The axle is the axis the other two are round about (equal extents), and the shortest.
    a = min(range(3), key=lambda i: abs(e[(i + 1) % 3] - e[(i + 2) % 3]) + (0 if e[i] < min(e[(i + 1) % 3], e[(i + 2) % 3]) else 9))
    c = (lo + hi) / 2
    rot = {0: Matrix.Identity(4), 1: Matrix.Rotation(-math.pi / 2, 4, 'Z'), 2: Matrix.Rotation(math.pi / 2, 4, 'Y')}[a]
    m = rot @ Matrix.Translation(-c)
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)
    sn = bm.loops.layers.float_vector['src_normal']
    r3 = rot.to_3x3()
    for f in bm.faces:
        for l in f.loops:
            l[sn] = r3 @ l[sn]
    bm.normal_update()
    return max(math.hypot(v.co.y, v.co.z) for v in bm.verts)


def _rad(co):
    return math.hypot(co.y, co.z)


def _split_tire(bm, R):
    """Delete the source tire: islands reaching the outer radius whose tread (faces past 96 % of
    it) covers the middle of the island's width. A rim lip reaches the outer radius only at its
    edges. Then the rest of that tire: sidewalls modelled as their own islands, in the tread's
    source material and outside half the radius (a bead sits near 0.75, a rim's spokes reach far
    inside half). Left in place they set the lip radius and shrink the rim (Kiba's did by 13 %,
    Rensa's by 20 %). Returns the faces deleted."""
    doomed = []
    islands = _islands(bm)
    tire_mats = set()
    for grp in islands:
        vs = {v for f in grp for v in f.verts}
        if max(_rad(v.co) for v in vs) < 0.97 * R or min(_rad(v.co) for v in vs) < 0.45 * R:
            continue
        x0, x1 = min(v.co.x for v in vs), max(v.co.x for v in vs)
        mid = (x0 + x1) / 2
        tread = [f for f in grp if _rad(f.calc_center_median()) > 0.96 * R]
        if any(abs(f.calc_center_median().x - mid) < 0.15 * (x1 - x0) for f in tread):
            doomed += grp
            tire_mats |= {f.material_index for f in grp}
    if tire_mats:
        taken = set(doomed)
        for grp in islands:
            if grp[0] not in taken and {f.material_index for f in grp} <= tire_mats and min(_rad(v.co) for f in grp for v in f.verts) > 0.5 * R:
                doomed += grp
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    return len(doomed)


def _face_sign(bm, L):
    """+1 when the rim's face already points +X: the hub and spokes (inside 80 % of the lip) are
    seen from the face, so their area weighted normals lean toward it; ties go to where the hub
    sits relative to the barrel."""
    s = sum(f.normal.x * f.calc_area() for f in bm.faces if _rad(f.calc_center_median()) < 0.8 * L)
    if abs(s) > 1e-6:
        return 1 if s > 0 else -1
    hub = [f.calc_center_median().x for f in bm.faces if _rad(f.calc_center_median()) < 0.3 * L]
    return 1 if hub and sum(hub) / len(hub) > 0 else -1


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


LIP = 0.86          # the donor rim inside this share of the lip radius is kept; the rest is house ring


def dish_start(bm, L, sectors=36, band=0.02, share=None):
    """Where the rim stops being a spoked pattern and becomes a full ring (dish and lip), as a
    share of the lip radius: walking in from the lip, the first radial band whose face-side
    surfaces do not cover every angular sector, or `share` when the recipe sets it (a stepped or
    curved dish breaks the coverage test). Returns (share, depth x of the ring's inner edge)."""
    cover = {}
    for f in bm.faces:
        c = f.calc_center_median()
        if f.normal.x < 0.3:
            continue
        b = int(_rad(c) / L / band)
        cover.setdefault(b, {}).setdefault(int((math.atan2(c.z, c.y) + math.pi) / (2 * math.pi) * sectors) % sectors, []).append(c.x)
    if share is None:
        b = int(0.99 / band)
        while b > int(0.45 / band) and len(cover.get(b - 1, {})) == sectors:
            b -= 1
        share = max(0.5, min(LIP, b * band))
    xs = sorted(x for xs_ in cover.get(int(share / band), {}).values() for x in xs_)
    return share, (xs[len(xs) // 2] if xs else None)


def lip_profile(bm, L, share, bands=LIP_BANDS):
    """The donor's surface as seen from the front, from where the spokes end to the lip edge, as
    (x, r) pairs from the axle outward: per radial band, the depth of its frontmost faces (the
    90th percentile, so a rivet head does not pull it; faces turned away from the front are left
    out, but a steep dish cone facing the axle counts). Returns (profile, depth of the lip edge):
    the edge is measured on its own, past 0.95 of the radius, because on a deep dish it stands
    well proud of the dish just inside it."""
    lo, hi = share * L, 0.93 * L
    xs = [[] for _ in range(bands)]
    edge = []
    for f in bm.faces:
        c = f.calc_center_median()
        r = _rad(c)
        if f.normal.x > -0.2:
            if lo <= r < hi:
                xs[min(bands - 1, int((r - lo) / (hi - lo) * bands))].append(c.x)
            elif r >= 0.95 * L:
                edge.append(c.x)
    prof = []
    for i, b in enumerate(xs):
        if b:
            b.sort()
            prof.append((b[int(len(b) * 0.9)], lo + (i + 0.5) * (hi - lo) / bands))
    edge.sort()
    return prof, (edge[int(len(edge) * 0.9)] if edge else (prof[-1][0] if prof else None))


def house_ring(bm, mat, x_face, x_back, L, share=LIP, x_dish=None, seg=TIRE_SEG, profile=None, x_lip=None):
    """The barrel and lip every wheel shares: a turned ring from LIP x L at the face out over a
    rounded lip edge at L and back along the barrel to the rim's back. With a donor `profile`
    (lip_profile), the face side follows the donor's own steps instead and the lip edge sits at
    the donor's lip depth `x_lip`. Faces are marked `own_normals` and smooth shaded about the axle; the
    donor profile's faces are tagged 2 in `house_ring` (their normals are the lathe's own).
    Returns the faces made."""
    t = 0.006
    if profile:
        xl = x_lip if x_lip is not None else profile[-1][0]
        prof = [(profile[0][0], share * L)] + list(profile) + [(xl, L - t), (xl - t, L), (xl - 2 * t, L - t), (xl - 3 * t, 0.95 * L), (x_back, 0.95 * L)]
        inner = []
    else:
        # A deep dish steps down from the face to where the spokes start.
        inner = [(x_dish, share * L)] if x_dish is not None and x_dish < x_face - 0.012 else []
        prof = inner + [(x_face - 0.006, share * L), (x_face - 0.002, 0.93 * L), (x_face, L - t), (x_face - t, L), (x_face - 2 * t, L - t),
                (x_face - 3 * t, 0.95 * L), (x_back, 0.95 * L)]
    face_side = len(profile) + 1 if profile else 0   # profile segments: the face side up to the lip edge
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    tag = bm.faces.layers.int.get('house_ring') or bm.faces.layers.int.new('house_ring')
    seg_k = bm.faces.layers.int.get('ring_k') or bm.faces.layers.int.new('ring_k')
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        rings.append([bm.verts.new((x, r * math.cos(a), r * math.sin(a))) for x, r in prof])
    made = []
    for i in range(seg):
        a, b = rings[i], rings[(i + 1) % seg]
        for k in range(len(prof) - 1):
            f = bm.faces.new((a[k], a[k + 1], b[k + 1], b[k]))
            f.material_index = mat
            f.smooth = True
            f[own] = 1
            f[tag] = 2 if k < face_side else 1
            f[seg_k] = k
            made.append(f)
    bm.normal_update()
    for f in made:
        c = f.calc_center_median()
        radial = Vector((0, c.y, c.z)).normalized()
        if f[tag] == 2:
            # The side of the profile segment toward the front: (-dx, dr) in (r, x) for a
            # segment walked outward, so a floor faces +X and a step down outward faces out.
            (x0, r0), (x1, r1) = prof[f[seg_k]], prof[f[seg_k] + 1]
            want = Vector((r1 - r0, 0, 0)) + radial * -(x1 - x0)
        # Face side faces +X, the lip edge faces out, the barrel inside faces the axle.
        else:
            want = Vector((1, 0, 0)) if _rad(c) < 0.97 * L and c.x > x_face - 0.004 else -radial if inner and _rad(c) < share * L + 0.004 else (
                radial if _rad(c) > 0.97 * L else -radial)
        if f.normal.dot(want) < 0:
            f.normal_flip()
    return made


def _cap(bm, L, x_face, mat, seg=20):
    """The house center cap: a disc of radius CAP x L just proud of the hub, over any logo."""
    r = CAP * L
    hub = [v.co.x for v in bm.verts if _rad(v.co) < r * 1.05]
    x = (max(hub) if hub else x_face) + 0.002
    # Logos and center bores standing in front of the cap's plane go.
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if _rad(f.calc_center_median()) < r and f.calc_center_median().x > x - 0.002], context='FACES')
    c = bm.verts.new((x, 0, 0))
    ring = [bm.verts.new((x, r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    for i in range(seg):
        f = bm.faces.new((c, ring[i], ring[(i + 1) % seg]))
        f.material_index = mat
        f[own] = 1
        f.normal_update()
        if f.normal.x < 0:
            f.normal_flip()
    return x


def wheel(name, root):
    """Build `wheels.wheel_<name>` in collection `wheels:Wheels` from the import under `root`."""
    R0 = WHEELS[name]
    c = coll('wheels:Wheels')
    oname = f'wheels.wheel_{name}'
    old = bpy.data.objects.get(oname)
    if old:
        bpy.data.objects.remove(old)
    bpy.context.view_layer.update()
    bm, names = _gather(root, R0)
    if not bm.faces:
        raise ValueError(f'{name}: nothing left after dropping scene junk')
    R = _frame(bm)
    tire_faces = _split_tire(bm, R) if R0.get('tire', 'auto') == 'auto' else 0
    # Stray bits left floating off the wheel (a lone screw from a scene) go: the rim is round.
    L = max(_rad(v.co) for v in bm.verts)
    sign = R0.get('face') or _face_sign(bm, L)
    k = TIRE_R * BEAD / L
    bmesh.ops.transform(bm, matrix=Matrix.Diagonal((sign * k, k, sign * k, 1)), verts=bm.verts)
    sn = bm.loops.layers.float_vector['src_normal']
    if sign < 0:
        for f in bm.faces:
            for l in f.loops:
                l[sn] = Vector((-l[sn].x, l[sn].y, -l[sn].z))
    bm.normal_update()
    # Squeeze into the tire's width, face side flush with the tire's sidewall bulge, slightly in.
    x0, x1 = min(v.co.x for v in bm.verts), max(v.co.x for v in bm.verts)
    room = TIRE_W * 0.94
    sq = min(1.0, room / (x1 - x0))
    for v in bm.verts:
        v.co.x = TIRE_W * 0.46 - (x1 - v.co.x) * sq
    if sq < 1:
        for f in bm.faces:
            for l in f.loops:
                l[sn] = Vector((l[sn].x / sq, l[sn].y, l[sn].z)).normalized()
    bm.normal_update()
    lip = TIRE_R * BEAD
    # The donor's dish, barrel and lip go: faces entirely outside where the rim becomes a full ring.
    share, x_dish = dish_start(bm, lip, share=R0.get('dish'))
    own_lip = R0.get('lip') == 'donor'
    profile, x_lip = lip_profile(bm, lip, share) if own_lip else (None, None)
    # Faces wholly outside where the spokes end; with the donor's own lip, faces centred there too,
    # or spokes that run out to the lip edge leave slivers poking past the turned ring.
    ring_zone = {f for f in bm.faces if all(_rad(v.co) > share * lip for v in f.verts) or (own_lip and _rad(f.calc_center_median()) > share * lip)}
    if own_lip:
        # The donor's rivets and bolts stay on the turned lip: small loose islands in the ring zone.
        for grp in _islands(bm):
            if set(grp) <= ring_zone:
                pts = [v.co for f in grp for v in f.verts]
                if (Vector(map(max, *pts)) - Vector(map(min, *pts))).length < 0.08 * lip:
                    ring_zone -= set(grp)
    bmesh.ops.delete(bm, geom=list(ring_zone), context='FACES')
    x_back = min(v.co.x for v in bm.verts)
    me = bpy.data.meshes.new(oname)
    for u in SHARED:
        me.materials.append(shared_mat(u))
    for f in bm.faces:
        f.material_index = SHARED.index('Rim')
    _cap(bm, lip, TIRE_W * 0.46, SHARED.index('Chrome'))
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(oname, me)
    c.objects.link(o)
    src_tris = tris(o)
    # Hidden faces go (from the face side and around: nobody sees a wheel from inside the car),
    # then the rim is reduced; the tire is added after, so the collapse never touches it.
    gone, _ = cull_hidden(o, [d for d in _view_dirs() if d.x > -0.3])
    skin = _copy(o, oname + '.skin')
    _collapse(o, LIP_BUDGET if own_lip else RIM_BUDGET)
    shade_from_source(o, skin)
    bpy.data.objects.remove(skin)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    house_tire(bm, SHARED.index('Tire'))
    house_ring(bm, SHARED.index('Rim'), TIRE_W * 0.46, min(x_back, TIRE_W * 0.46 - 0.08), lip, share, x_dish, profile=profile, x_lip=x_lip)
    bm.to_mesh(o.data)
    bm.free()
    me = o.data
    tire_idx = SHARED.index('Tire')
    # The tire's own smooth normals (custom normals were set for the rim only).
    cn = [cv.vector.copy() for cv in me.corner_normals]
    out = []
    hr = me.attributes.get('house_ring')
    ring = [v.value for v in hr.data] if hr else [0] * len(me.polygons)
    for p in me.polygons:
        if ring[p.index] == 2:
            out += [cn[li] for li in p.loop_indices]   # a donor lip profile: the lathe's own smooth normals
        elif ring[p.index]:
            for li in p.loop_indices:
                v = me.vertices[me.loops[li].vertex_index].co
                n = Vector((0, v.y, v.z)).normalized()
                out.append(Vector((1, 0, 0)) if _rad(v) < 0.94 * lip and v.x > TIRE_W * 0.46 - 0.008 else (n if _rad(v) > 0.97 * lip else -n))

        elif p.material_index == tire_idx:
            c3 = p.center
            for li in p.loop_indices:
                v = me.vertices[me.loops[li].vertex_index].co
                n = Vector((0, v.y, v.z)).normalized()
                side = abs(v.x) > TIRE_W * 0.45 and _rad(v) < TIRE_R * 0.93
                out.append((Vector((math.copysign(1, v.x), 0, 0)) * 0.9 + n * 0.1).normalized() if side else
                           (n + Vector((v.x / (TIRE_W * 0.5) * 0.35, 0, 0))).normalized())
        else:
            out += [cn[li] for li in p.loop_indices]
    me.normals_split_custom_set(out)
    for a in ('src_normal', 'own_normals', 'house_ring', 'ring_k'):
        if me.attributes.get(a):
            me.attributes.remove(me.attributes[a])
    remap_materials(o)
    o['displayName'] = name.capitalize()
    print(f'wheel_{name}: {R0["name"]} ({R0["author"]}); source tire {"removed (" + str(tire_faces) + " faces)" if tire_faces else "none"}, '
          f'face {"+" if sign > 0 else "-"}X, rim scaled x{k:.3f}, width squeezed x{sq:.2f}, ' + (f'lip turned from its own profile ({len(profile)} bands)' if own_lip else f'house ring from {share:.2f}{" (dish)" if x_dish is not None and x_dish < TIRE_W * 0.46 - 0.012 else ""}') + f'; {src_tris} -> {tris(o)} tris ({gone} hidden culled)')
    return o


def wheel_report(names):
    """One line per wheel: triangles by material, rim depth and lip, so the set compares at a glance."""
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
        rim = [v.co for p in me.polygons if me.materials[p.material_index].name != 'Tire' for i in p.vertices for v in [me.vertices[i]]]
        print(f"wheel_{n:8} {tris(o):5} tris {by}  rim x {min(v.x for v in rim):+.3f}..{max(v.x for v in rim):+.3f}, lip {max(_rad(v) for v in rim):.3f}")
