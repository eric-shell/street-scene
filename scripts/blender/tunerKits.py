"""
The Kurogane and Hayate kits: front bumpers, rear bumpers and side skirts for the
authored garage cars, generated from each car's stock pieces so they fit
the body opening exactly like stock.

Run inside a session that has both cars' collections (append them from
assets/source/eshell/*/*.blend, see the /blender skill), after carKit.py:

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/tunerKits.py').read())
    build_kits()        # bumpers and skirts
    build_hood_roof()   # hoods and roofs
    build_kits(['brandtKombi'])   # one car; the others need not be in the session

Each replaces its slots' parts in `<carId>:Parts` and keeps the others. SEAMS are the planes the stock pieces were cut with; displacements are
pinned to them. Kurogane: carbon (Trim) lower apron, deep splitter with end plates,
canards, a strake diffuser clear of the exhausts, skirt blades with winglets.
Hayate: body colour aprons drawn down and forward, an intake bar, slim black lips.
Hoods and roofs (Kurogane, Hayate, Tsubame): carbon with louvres / vortex generators,
a cowl bulge / rally roof scoop, twin contrast stripes over both.
"""
SEAMS = {
    'wendtFairway': dict(YF=-1.54, YR=1.54, ZF=0.49, ZR=0.60, ZS=0.26, YS=0.86, XS=0.68),
    'kazamaRotor': dict(YF=-1.6, YR=1.6, ZF=0.47, ZR=0.64, ZS=0.26, YS=0.95, XS=0.74),
    'brandtKombi': dict(YF=-1.66, YR=1.66, ZF=0.48, ZR=0.62, ZS=0.27, YS=0.98, XS=0.8),
}

def lin(a, b, n):
    return [a + (b - a) * i / (n - 1) for i in range(n)]

def zmin(o):
    return min(v.co.z for v in o.data.vertices)

def front(cid, style):
    S = SEAMS[cid]
    o = copy_part(f'{cid}.Bumper_Front', f'{cid}.frontBumper_{style}', f'{cid}:Parts')
    seam = plane_seam([(1, S['YF']), (2, S['ZF'])])
    z0 = zmin(o)
    hw = max(abs(v.co.x) for v in o.data.vertices)
    low = lambda c, h: max(0, min(1, (z0 + h - c.z) / h))
    if style == 'kurogane':
        # Deep chin and corner splitters pulled out toward the arches.
        displace(o, lambda c: Vector((0.03 * (1 if c.x > 0 else -1) * low(c, 0.16) * max(0, (abs(c.x) - hw + 0.18) / 0.18), -0.06 * low(c, 0.2), 0)), seam, 0.14)
        recolor(o, lambda c, n, m: c.z < z0 + 0.11 and m in ('Paint', 'Black', 'Trim'), 'Trim')
        ext, depth, thick, mat = 0.10, 0.16, 0.016, 'Trim'
    else:
        # Smooth body colour apron: the lip is filled in and drawn down and forward.
        displace(o, lambda c: Vector((0, -0.03 * low(c, 0.18), -0.012 * low(c, 0.1))), seam, 0.14)
        recolor(o, lambda c, n, m: c.z < z0 + 0.08 and m in ('Black', 'Trim'), 'Paint')
        ext, depth, thick, mat = 0.022, 0.06, 0.01, 'Black'
    z0 = zmin(o)
    xs = lin(-hw + 0.06, hw - 0.06, 15)
    yf = outline(o, 1, min, 0, xs, lambda c: c.z < z0 + 0.08)
    taper = [1 - 0.6 * (abs(x) / hw) ** 4 for x in xs]
    slab(o, [(x, y - ext * t) for x, y, t in zip(xs, yf, taper)], [(x, y + depth) for x, y in zip(xs, yf)], z0 - 0.004, z0 - 0.004 + thick, mat)
    if style == 'kurogane':
        for sx in (1, -1):
            # Splitter end plates.
            x = xs[0] if sx < 0 else xs[-1]
            y = (yf[0] if sx < 0 else yf[-1]) - ext * taper[0]
            fin(o, (x, y, z0 - 0.004), (0, 1, 0), 0.2, 0.07, 0.012, 'Trim')
            # Two canards per corner.
            x = sx * (hw - 0.03)
            ycorner = outline(o, 1, min, 0, [x, x - sx * 0.05], lambda c: z0 + 0.12 < c.z < z0 + 0.3)[0]
            for z in (z0 + 0.16, z0 + 0.25):
                fin(o, (x - sx * 0.03, ycorner + 0.04, z), (sx, 0.3, 0.15), 0.12, 0.12, 0.012, 'Trim', up=(0, 1, 0))
    else:
        # A body colour bar across the main intake.
        me = o.data
        blk = [p.center for p in me.polygons if me.materials[p.material_index].name.split('.')[0] == 'Black' and p.normal.y < -0.6 and abs(p.center.x) < hw * 0.6]
        if blk:
            zb = sorted(c.z for c in blk)[len(blk) // 2]
            yb = min(c.y for c in blk) - 0.004
            xb = max(abs(c.x) for c in blk) * 0.92
            xs2 = lin(-xb, xb, 9)
            yfb = outline(o, 1, min, 0, xs2, lambda c, zb=zb: abs(c.z - zb) < 0.05)
            slab(o, [(x, min(y, yb) - 0.012) for x, y in zip(xs2, yfb)], [(x, min(y, yb) + 0.03) for x, y in zip(xs2, yfb)], zb - 0.016, zb + 0.016, 'Paint')
    return o

def rear(cid, style):
    S = SEAMS[cid]
    o = copy_part(f'{cid}.Bumper_Rear', f'{cid}.rearBumper_{style}', f'{cid}:Parts')
    seam = plane_seam([(1, S['YR']), (2, S['ZR'])])
    z0 = zmin(o)
    hw = max(abs(v.co.x) for v in o.data.vertices)
    low = lambda c, h: max(0, min(1, (z0 + h - c.z) / h))
    if style == 'kurogane':
        displace(o, lambda c: Vector((0, 0.045 * low(c, 0.16), 0)), seam, 0.14)
        recolor(o, lambda c, n, m: c.z < z0 + 0.1 and m in ('Paint', 'Black', 'Trim'), 'Trim')
    else:
        displace(o, lambda c: Vector((0, 0.025 * low(c, 0.16), -0.01 * low(c, 0.08))), seam, 0.14)
        recolor(o, lambda c, n, m: c.z < z0 + 0.08 and m in ('Black', 'Trim'), 'Paint')
    z0 = zmin(o)
    xs = lin(-hw * 0.8, hw * 0.8, 13)
    # The bumper's own bottom edge: the exhaust tips hang lower than z0 + 0.08 on some cars.
    band = lambda c: c.z < z0 + 0.05
    yr = outline(o, 1, max, 0, xs, band)
    if style == 'kurogane':
        # Strakes stay clear of the exhaust tips, placed from the bumper edge before the plate exists.
        me = o.data
        tips = [me.vertices[i].co.x for p in me.polygons if me.materials[p.material_index].name.split('.')[0] == 'Chrome' for i in p.vertices]
        clear = lambda x: not tips or all(abs(x - t) > 0.06 for t in tips)
        edge = lambda x: yr[min(range(len(xs)), key=lambda i: abs(xs[i] - x))]
        strakes = [(x, edge(x)) for x in [x for x in lin(-0.5, 0.5, 11) if clear(x)][:8]]
        slab(o, [(x, y + 0.08) for x, y in zip(xs, yr)], [(x, y - 0.26) for x, y in zip(xs, yr)], z0 - 0.002, z0 + 0.012, 'Trim')
        for x, y in strakes:
            fin(o, (x, y - 0.24, z0 + 0.012), (0, 1, 0), 0.32, 0.12, 0.012, 'Black')
    return o

def skirts(cid, style):
    S = SEAMS[cid]
    o = copy_part(f'{cid}.Skirts', f'{cid}.sideSkirts_{style}', f'{cid}:Parts')
    seam = plane_seam([(1, -S['YS']), (1, S['YS']), (2, S['ZS']), (0, S['XS']), (0, -S['XS'])])
    z0 = zmin(o)
    push = 0.03 if style == 'kurogane' else 0.018
    displace(o, lambda c: Vector((push * (1 if c.x > 0 else -1) * max(0, min(1, (z0 + 0.14 - c.z) / 0.12)), 0, 0)), seam, 0.16)
    if style == 'kurogane':
        recolor(o, lambda c, n, m: c.z < z0 + 0.07 and m in ('Paint', 'Black'), 'Trim')
        ext, inner, thick, mat = 0.06, 0.03, 0.014, 'Trim'
    else:
        recolor(o, lambda c, n, m: m in ('Black', 'Trim') and abs(n.z) < 0.7, 'Paint')
        ext, inner, thick, mat = 0.015, 0.02, 0.01, 'Black'
    ys = lin(-S['YS'] + 0.08, S['YS'] - 0.08, 11)
    for sx in (1, -1):
        xo = outline(o, 0, (max if sx > 0 else min), 1, ys, lambda c, sx=sx: c.z < z0 + 0.08 and c.x * sx > 0)
        taper = [1 - 0.8 * (abs(y) / S['YS']) ** 6 for y in ys]
        slab(o, [(x + sx * ext * t, y) for x, y, t in zip(xo, ys, taper)], [(x - sx * inner, y) for x, y in zip(xo, ys)], z0 - 0.003, z0 - 0.003 + thick, mat)
        if style == 'kurogane':
            # A small vertical winglet at the rear end of each blade.
            fin(o, (xo[-1] + sx * ext * taper[-1] * 0.6, ys[-1] - 0.02, z0 - 0.003), (0, 1, 0), 0.06, 0.06, 0.012, 'Trim')
    return o

def build_kits(cids=None):
    made = []
    for cid in cids or SEAMS:
        parts = bpy.data.collections[f'{cid}:Parts']
        for o in list(parts.objects):
            if o.name.split('.', 1)[1].split('_')[0] in ('frontBumper', 'rearBumper', 'sideSkirts'):
                bpy.data.objects.remove(o)
        spoilers = list(parts.objects)
        for o in spoilers:
            parts.objects.unlink(o)
        for style, disp in (('kurogane', 'Kurogane'), ('hayate', 'Hayate')):
            for f in (front, rear, skirts):
                o = f(cid, style)
                o['displayName'] = disp
                made.append(o)
        for o in spoilers:
            parts.objects.link(o)
    return made


# ----- hoods and roofs ------------------------------------------------------
# Built from the stock `Hood` and `Roof` pieces (body colour panels cut out of the
# body). Their seam is their own open boundary, so boundary_seam pins it.

def bump(t):
    return max(0.0, 1 - t * t) ** 2

def stripes(o, name):
    """Twin contrast stripes either side of the center line."""
    cut(o, [((x, 0, 0), (1, 0, 0)) for x in (-0.17, -0.05, 0.05, 0.17)])
    recolor(o, lambda c, n, m: m == 'Paint' and 0.05 < abs(c.x) < 0.17, name)

def hood(cid, style):
    st = bpy.data.objects[f'{cid}.Hood']
    o = copy_part(st.name, f'{cid}.hood_{style}', f'{cid}:Parts')
    seam = boundary_seam(st)
    mn, mx = bb(st)
    hw, y0, y1 = mx.x, mn.y, mx.y
    if style == 'kurogane':
        recolor(o, lambda c, n, m: m == 'Paint', 'Trim')
        surf = surface_z(o)
        for sx in (1, -1):
            xc = sx * hw * 0.52
            for i in range(5):
                y = y0 + (y1 - y0) * (0.42 + 0.075 * i)
                z = surf(xc, y)
                if z is not None:
                    fin(o, (xc - 0.1, y, z - 0.004), (1, 0, 0), 0.2, 0.022, 0.016, 'Black', up=(0, 0.45, 1))
    elif style == 'hayate':
        ym, yh = (y0 + y1) / 2 + 0.05, (y1 - y0) * 0.5
        displace(o, lambda c: Vector((0, 0, 0.065 * bump(c.x / (hw * 0.55)) * bump((c.y - ym) / yh))), seam, 0.08)
        surf = surface_z(o)
        y = y1 - 0.11
        z = surf(0, y)
        if z is not None:
            fin(o, (-hw * 0.28, y, z - 0.006), (1, 0, 0), hw * 0.56, 0.028, 0.035, 'Black')
    else:
        stripes(o, 'Trim')
    return o

def roof(cid, style):
    st = bpy.data.objects[f'{cid}.Roof']
    o = copy_part(st.name, f'{cid}.roof_{style}', f'{cid}:Parts')
    mn, mx = bb(st)
    hw, y0, y1 = mx.x, mn.y, mx.y
    surf = surface_z(o)
    if style == 'kurogane':
        recolor(o, lambda c, n, m: m == 'Paint', 'Trim')
        # Vortex generators along the trailing edge, toed in and out alternately.
        for i, x in enumerate(lin(-hw * 0.8, hw * 0.8, 9)):
            y = y1 - 0.12
            z = surf(x, y)
            if z is not None:
                fin(o, (x, y, z - 0.004), (0.3 if i % 2 else -0.3, 1, 0), 0.08, 0.035, 0.008, 'Black')
    elif style == 'hayate':
        # Rally roof scoop at the front center, mouth facing forward.
        y = y0 + 0.2
        z = surf(0, y)
        if z is not None:
            fin(o, (-0.16, y, z - 0.01), (1, 0, 0), 0.32, 0.075, 0.24, 'Paint')
            fin(o, (-0.14, y - 0.121, z + 0.008), (1, 0, 0), 0.28, 0.05, 0.006, 'Black')
    else:
        stripes(o, 'Trim')
    return o

def build_hood_roof(cids=None):
    made = []
    for cid in cids or SEAMS:
        parts = bpy.data.collections[f'{cid}:Parts']
        for o in list(parts.objects):
            if o.name.split('.', 1)[1].split('_')[0] in ('hood', 'roof'):
                bpy.data.objects.remove(o)
        for f in (hood, roof):
            for style, disp in (('kurogane', 'Kurogane'), ('hayate', 'Hayate'), ('tsubame', 'Tsubame')):
                o = f(cid, style)
                o['displayName'] = disp
                made.append(o)
    return made
