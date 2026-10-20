"""
The Proto Coupe base body: an E46 M3 x Mk4 Supra coupe, lofted from cross sections.

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/protoCoupe.py').read())
    body = build_coupe()          # one closed shell in collection protoCoupe:Car

Car space at the shared scale (standardWheel 0.28 m), Blender axes: front is -Y.
The shell is a loft of mirrored rings (bottom, sill, side, shoulder, window line,
roof or hood edge, crown, center) over stations along the car; every ring value
is a piecewise linear profile below, so the design is tuned by editing numbers.
Arches are boolean cut (the cutter's inside becomes the black wheel well), then
lights, kidney grilles, mirrors, handles, exhaust and a dark interior block are
added. The stock body is tame on purpose: small grilles, no lips, no spoiler.
"""

AXLE = 1.28          # m, half wheelbase
ARCH_R = 0.315       # m, wheel arch cut radius (about 3 cm over the tire)
WHEEL_R = 0.28       # m, standard wheel

STATIONS = [-2.08, -2.03, -1.95, -1.84, -1.72, -1.6, -1.45, -1.28, -1.1, -0.95, -0.85, -0.7, -0.55, -0.38,
            -0.2, 0.0, 0.2, 0.27, 0.35, 0.55, 0.72, 0.88, 1.02, 1.15, 1.28, 1.42, 1.58, 1.74, 1.88, 1.98, 2.05, 2.1]

# Keyframes (y, value). Front is -Y.
PROFILE = {
    # bottom of the shell and its half width
    'zb': [(-2.08, 0.25), (-2.0, 0.16), (-1.8, 0.13), (1.8, 0.14), (2.0, 0.18), (2.1, 0.26)],
    'hb': [(-2.08, 0.5), (-1.95, 0.74), (1.95, 0.74), (2.1, 0.55)],
    # widest side line (fender bulges over the arches, M3 style) and its upper end
    'hs': [(-2.08, 0.6), (-2.0, 0.74), (-1.84, 0.82), (-1.5, 0.862), (-1.28, 0.872), (-1.0, 0.85), (-0.6, 0.835),
           (0.4, 0.835), (0.9, 0.85), (1.28, 0.878), (1.6, 0.866), (1.88, 0.83), (2.02, 0.77), (2.1, 0.68)],
    'zs': [(-2.08, 0.4), (-1.9, 0.5), (-1.4, 0.6), (-0.8, 0.66), (0.6, 0.69), (1.4, 0.71), (1.95, 0.72), (2.1, 0.66)],
    # shoulder crease (belt line) height and half width
    'zsh': [(-2.08, 0.5), (-1.95, 0.6), (-1.6, 0.67), (-1.1, 0.73), (-0.6, 0.79), (0.4, 0.81), (1.2, 0.83), (1.9, 0.85), (2.1, 0.8)],
    'hsh': [(-2.08, 0.55), (-1.95, 0.7), (-1.6, 0.79), (-1.28, 0.81), (-0.6, 0.79), (0.6, 0.79), (1.28, 0.82), (1.85, 0.79), (2.1, 0.64)],
    # upper surface: hood, windshield, roof, backlight, deck (center height)
    'ztc': [(-2.08, 0.53), (-2.0, 0.6), (-1.84, 0.66), (-1.45, 0.72), (-1.0, 0.765), (-0.85, 0.785), (-0.72, 0.8), (-0.55, 0.9),
            (-0.2, 1.135), (0.0, 1.175), (0.35, 1.18), (0.6, 1.16), (0.88, 1.08), (1.15, 0.97), (1.28, 0.925),
            (1.6, 0.91), (1.95, 0.9), (2.1, 0.85)],
    # roof / hood / deck edge: half width and how far it sits below the center
    'h6': [(-2.08, 0.45), (-1.95, 0.6), (-1.5, 0.68), (-0.72, 0.7), (-0.2, 0.56), (0.55, 0.56), (1.0, 0.62), (1.28, 0.7),
           (1.9, 0.72), (2.1, 0.58)],
    'drop': [(-2.08, 0.02), (-0.85, 0.035), (-0.2, 0.045), (0.55, 0.045), (1.28, 0.03), (2.1, 0.02)],
}
CABIN = (-0.72, 1.28)          # cowl to backlight base
WINDSHIELD = (-0.72, -0.2)
BACKLIGHT = (0.6, 1.28)
SIDE_GLASS = (-0.62, 1.02)     # side window from the A-pillar foot to the C-pillar
B_PILLAR = (0.2, 0.35)


def prof(key, y):
    pts = PROFILE[key]
    if y <= pts[0][0]:
        return pts[0][1]
    for (y0, v0), (y1, v1) in zip(pts, pts[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0)
            return v0 + (v1 - v0) * t
    return pts[-1][1]


def ring(y):
    """Half ring from bottom center to roof center: [(x, z)] with x >= 0."""
    zb, hb, hs, zs = prof('zb', y), prof('hb', y), prof('hs', y), prof('zs', y)
    zsh, hsh, ztc, h6 = prof('zsh', y), prof('hsh', y), prof('ztc', y), prof('h6', y)
    z6 = ztc - prof('drop', y)
    h6 = min(h6, hsh - 0.02)
    cabin = CABIN[0] < y < CABIN[1]
    if cabin:
        h5, z5 = hsh - 0.05, zsh + 0.025
    else:
        h5, z5 = (hsh + h6) / 2 + 0.01, (zsh + z6) / 2 + 0.005
    z5 = min(z5, z6 - 0.004)
    return [(0.0, zb), (hb, zb), (hs, zb + 0.09), (hs, zs), (hsh, zsh), (h5, z5), (h6, z6), (h6 * 0.5, ztc - 0.008), (0.0, ztc)]


def face_material(y0, y1, seg):
    """Material of the loft face between stations y0..y1 on ring segment seg (0 = bottom)."""
    yc = (y0 + y1) / 2
    if seg == 0:
        return 'Black'                       # floor
    if seg == 5:                             # side glass band (window line to roof edge)
        if SIDE_GLASS[0] < yc < SIDE_GLASS[1]:
            return 'Black' if B_PILLAR[0] < yc < B_PILLAR[1] else 'Glass'
        return 'Paint'
    if seg in (6, 7):                        # top: windshield, roof, backlight
        if WINDSHIELD[0] < yc < WINDSHIELD[1] or BACKLIGHT[0] < yc < BACKLIGHT[1]:
            return 'Glass'
    return 'Paint'


def loft(name, cname):
    rings = [(y, ring(y)) for y in STATIONS]
    n = len(rings[0][1])
    verts, faces, mats = [], [], []
    # full ring: right side (x < 0) reversed, then left side; centers shared
    idx = {}
    for si, (y, half) in enumerate(rings):
        for k, (x, z) in enumerate(half):
            for side in ((1,) if x == 0 else (1, -1)):
                idx[(si, k, side)] = len(verts)
                verts.append((x * side, y, z))
    for si in range(len(rings) - 1):
        y0, y1 = rings[si][0], rings[si + 1][0]
        for k in range(n - 1):
            m = face_material(y0, y1, k)
            for side in (1, -1):
                a = idx.get((si, k, side), idx.get((si, k, 1)))
                b = idx.get((si, k + 1, side), idx.get((si, k + 1, 1)))
                c = idx.get((si + 1, k + 1, side), idx.get((si + 1, k + 1, 1)))
                d = idx.get((si + 1, k, side), idx.get((si + 1, k, 1)))
                f = [a, b, c, d] if side == 1 else [a, d, c, b]
                if len(set(f)) >= 3:
                    faces.append(list(dict.fromkeys(f)))
                    mats.append(m)
    # end caps
    for si, cap_dir in ((0, 1), (len(rings) - 1, -1)):
        loop = [idx[(si, k, 1)] for k in range(n)] + [idx[(si, k, -1)] for k in reversed(range(1, n - 1))]
        faces.append(loop if cap_dir == 1 else list(reversed(loop)))
        mats.append('Paint')
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    names = sorted(set(mats), key=SHARED.index)
    for nm in names:
        me.materials.append(shared_mat(nm))
    for p, m in zip(me.polygons, mats):
        p.material_index = names.index(m)
    me.validate()
    me.update()
    o = bpy.data.objects.new(name, me)
    coll(cname).objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    return o


def cut_arches(o):
    """Boolean the arches out; the cutter's inside becomes the black wheel well."""
    cutters = []
    for y in (-AXLE, AXLE):
        bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=ARCH_R, depth=2.4, location=(0, y, WHEEL_R - 0.005), rotation=(0, math.pi / 2, 0))
        c = bpy.context.active_object
        c.data.materials.append(shared_mat('Black'))
        cutters.append(c)
    for c in cutters:
        mod = o.modifiers.new('arch', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.solver = 'EXACT'
        mod.object = c
        mod.material_mode = 'TRANSFER'
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for c in cutters:
        bpy.data.objects.remove(c)


def box(o, c0, c1, name):
    (x0, y0, z0), (x1, y1, z1) = c0, c1
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    add_geom(o, v, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], name)


def tube(o, center, axis_dir, r, length, name, n=10):
    """A capped cylinder (exhaust tips)."""
    d = Vector(axis_dir).normalized()
    u = d.orthogonal().normalized()
    w = d.cross(u)
    c = Vector(center)
    ring0 = [c + (u * math.cos(2 * math.pi * i / n) + w * math.sin(2 * math.pi * i / n)) * r for i in range(n)]
    ring1 = [p + d * length for p in ring0]
    verts = [tuple(p) for p in ring0 + ring1]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    faces += [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    add_geom(o, verts, faces, name)


def details(o):
    tgt = [o]
    # Headlights: slim angular units (E46 M3 hood line) with the Supra's rounded outer corner.
    for sx in (1, -1):
        q = lambda pts: [(sx * u, v) for u, v in pts]
        projected_quad(o, q([(0.3, 0.505), (0.66, 0.53), (0.68, 0.6), (0.3, 0.578)]), 'y', 1, 0.004, 'Black', nu=6, nv=2, target=tgt)
        projected_quad(o, q([(0.33, 0.515), (0.64, 0.538), (0.655, 0.592), (0.33, 0.57)]), 'y', 1, 0.009, 'HeadLight', nu=6, nv=2, target=tgt)
        # Small kidney grilles (stock is tame).
        projected_quad(o, q([(0.04, 0.48), (0.17, 0.48), (0.16, 0.56), (0.05, 0.56)]), 'y', 1, 0.005, 'Black', nu=2, nv=2, target=tgt)
        # Small lower intake slot.
        projected_quad(o, q([(0.0, 0.27), (0.24, 0.27), (0.24, 0.31), (0.0, 0.31)]), 'y', 1, 0.004, 'Black', nu=3, nv=1, target=tgt)
        # Taillights: two round lamps per side on a black panel (Supra), in the E46's L line.
        projected_quad(o, q([(0.22, 0.66), (0.76, 0.665), (0.75, 0.79), (0.22, 0.785)]), 'y', -1, 0.004, 'Black', nu=8, nv=2, target=tgt)
        for cx in (0.36, 0.6):
            pts = [(sx * (cx + 0.055 * math.cos(a)), 0.727 + 0.05 * math.sin(a)) for a in [2 * math.pi * i / 8 for i in range(8)]]
            for i in range(8):
                tri = [pts[i], pts[(i + 1) % 8], (sx * cx, 0.727), (sx * cx, 0.727)]
                projected_quad(o, tri, 'y', -1, 0.009, 'TailLight', nu=1, nv=1, target=tgt)
        # Side mirrors at the A-pillar foot and door handles.
        x = sx * (prof('hsh', -0.6) - 0.06)
        box(o, (x, -0.64, 0.83), (x + 0.15 * sx, -0.55, 0.9), 'Paint')
        box(o, (x + 0.15 * sx, -0.64, 0.835), (x + 0.158 * sx, -0.555, 0.895), 'Black')
        hx = sx * (prof('hs', 0.42) + 0.004)
        box(o, (hx - 0.006 * sx, 0.38, 0.705), (hx + 0.012 * sx, 0.5, 0.725), 'Black')
        # Twin exhaust (tame), one tip each side.
        tube(o, (sx * 0.5, 1.95, 0.21), (0, 1, 0), 0.04, 0.16, 'Chrome')
    # A dark interior block so the cabin does not read hollow through the glass.
    box(o, (-0.7, -0.75, 0.3), (0.7, 1.15, 0.86), 'Interior')


def build_coupe(cid='protoCoupe'):
    for sub in ('Car', 'Parts', 'Wheels', 'Rig'):
        c = coll(f'{cid}:{sub}')
        for ob in list(c.objects):
            bpy.data.objects.remove(ob)
    o = loft(f'{cid}.Body', f'{cid}:Car')
    cut_arches(o)
    details(o)
    for key, sx, sy in (('FL', 1, -1), ('FR', -1, -1), ('RL', 1, 1), ('RR', -1, 1)):
        e = bpy.data.objects.new(f'{cid}.Wheel_{key}', None)
        e.empty_display_type = 'CIRCLE'
        e.empty_display_size = WHEEL_R
        e.location = (sx * 0.71, sy * AXLE, WHEEL_R)
        e.rotation_euler = (0, math.pi / 2, 0)
        coll(f'{cid}:Rig').objects.link(e)
    return o


def spoilers(cid='protoCoupe'):
    """Supra style hoop wing and an E46 CSL style ducktail, both mounted on the trunk lid."""
    out = []
    body = [bpy.data.objects[f'{cid}.{n}'] for n in ('Body', 'Bumper_Rear', 'Roof')]
    me = bpy.data.meshes.new(f'{cid}.spoiler_hoop')
    hoop = bpy.data.objects.new(f'{cid}.spoiler_hoop', me)
    coll(f'{cid}:Parts').objects.link(hoop)
    # Wing: a thin plate with a slight angle of attack, legs blending down at the ends.
    y0, chord, z, half = 1.62, 0.24, 1.12, 0.64
    verts = [(-half, y0, z), (half, y0, z), (half, y0 + chord, z + 0.035), (-half, y0 + chord, z + 0.035)]
    verts += [(x, y, zz + 0.022) for x, y, zz in verts]
    add_geom(hoop, verts, [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], 'Paint')
    for sx in (1, -1):
        fin(hoop, (sx * (half - 0.03), y0 + 0.02, 0.86), (0, 1, 0), chord - 0.04, z - 0.86 + 0.01, 0.03, 'Paint')
    out.append((hoop, 'Shiden', [i * 0.01 for i in range(-10, 30)]))
    me = bpy.data.meshes.new(f'{cid}.spoiler_ducktail')
    duck = bpy.data.objects.new(f'{cid}.spoiler_ducktail', me)
    coll(f'{cid}:Parts').objects.link(duck)
    y0, half = 1.88, 0.68
    verts = [(-half, y0, 0.9), (half, y0, 0.9), (half, y0 + 0.13, 0.9), (-half, y0 + 0.13, 0.9),
             (-half * 0.98, y0 + 0.02, 0.905), (half * 0.98, y0 + 0.02, 0.905), (half * 0.98, y0 + 0.14, 0.95), (-half * 0.98, y0 + 0.14, 0.95)]
    add_geom(duck, verts, [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], 'Paint')
    out.append((duck, 'Hayate', [i * 0.01 for i in range(-15, 15)]))
    for sp, disp, dys in out:
        sp['displayName'] = disp
        print(sp.name, 'mounted', mount_on_body(sp, body, dys, foot=0.25))
    return [o for o, _, _ in out]
