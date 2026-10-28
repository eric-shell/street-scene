"""
References and measurements for car work in Blender: reference photos placed in car space,
orthographic comparison sheets, and the same spec check as `npm run audit`, so a session
compares numbers before it looks (docs/carDesign.md).

    exec(open(REPO + '/scripts/blender/carKit.py').read())
    exec(open(REPO + '/scripts/blender/carRefs.py').read())
    load_refs('wendtFairway')                   # photos from assets/refs/wendtFairway/refs.json as planes
    m = measure('wendtFairway')                 # stations: belt line, cabin, lamps, pillars, mirrors, ...
    spec_check('wendtFairway')                  # model vs the blended donors (carSpecs.json)
    ortho_sheet('wendtFairway', OUT_DIR)        # side / front / rear / top PNGs to Read
    spec_from_refs('wendtFairway')              # real overhangs, height, belt from a calibrated side photo

Blender space (meters, Z up, car facing -Y, +X the car's left). Stations are reported as
car space forward distances (fwd = -y) and heights (z) so they match the audit's table.
"""
import json
import math
import os

import bpy
from mathutils import Vector

REPO = globals().get('REPO') or os.getcwd()
VIEWS = ('side', 'front', 'rear', 'top')
VIEW_COLORS = {'Paint': (0.15, 0.35, 0.9, 1), 'Trim': (0.2, 0.2, 0.22, 1), 'Black': (0.03, 0.03, 0.03, 1), 'Chrome': (0.85, 0.85, 0.9, 1),
               'Glass': (0.1, 0.14, 0.2, 1), 'Rim': (0.7, 0.7, 0.72, 1), 'Tire': (0.06, 0.06, 0.06, 1), 'HeadLight': (1, 1, 0.95, 1),
               'TailLight': (0.9, 0.05, 0.08, 1), 'Light': (1, 0.6, 0.15, 1), 'Interior': (0.12, 0.12, 0.13, 1),
               'Grille': (0.07, 0.07, 0.08, 1)}


# ----- data ------------------------------------------------------------------

def load_specs():
    with open(os.path.join(REPO, 'scripts/blender/carSpecs.json')) as f:
        return json.load(f)


def load_manifest(cid):
    with open(os.path.join(REPO, 'src/assets/carManifest.json')) as f:
        for c in json.load(f)['cars']:
            if c['id'] == cid:
                return c
    raise KeyError(f'{cid}: not in src/assets/carManifest.json')


def car_coll(cid, sub):
    """`<cid>:Sub`, or plain `Sub` when the file holds one car."""
    return bpy.data.collections.get(f'{cid}:{sub}') or bpy.data.collections.get(sub)


def car_meshes(cid):
    c = car_coll(cid, 'Car')
    if c is None:
        raise KeyError(f'{cid}: no Car collection in this file')
    return [o for o in c.objects if o.type == 'MESH']


def car_part(cid, short):
    """A Car mesh by its short name (`Body`, `Bumper_Front`, ...), or None."""
    for o in car_meshes(cid):
        if o.name == short or o.name.endswith('.' + short):
            return o
    return None


def rig(cid):
    """(half wheelbase, half track front, half track rear, wheel radius) from the Rig empties, else the manifest."""
    c = car_coll(cid, 'Rig')
    bpy.context.view_layer.update()  # empties made in this call keep an identity matrix_world until then
    pos = {}
    for o in (c.objects if c else []):
        key = o.name.split('.')[-1].replace('Wheel_', '')
        if key in ('FL', 'FR', 'RL', 'RR'):
            pos[key] = o.matrix_world.translation.copy()
    if len(pos) == 4:
        return abs(pos['FL'].y), abs(pos['FL'].x), abs(pos['RL'].x), pos['FL'].z
    m = load_manifest(cid)
    return m['wheelbase'] / 2, m['trackFront'] / 2, m['trackRear'] / 2, m['wheelRadius']


def tint_materials():
    """Viewport colors for the shared materials, so Workbench renders and `look` read at a glance."""
    for name, rgba in VIEW_COLORS.items():
        m = bpy.data.materials.get(name)
        if m is not None:
            m.diffuse_color = rgba


# ----- measuring -------------------------------------------------------------

def faces_of(objs):
    """[(material, center, normal, [verts], obj)] in world space."""
    out = []
    for o in objs:
        mw = o.matrix_world
        rot = mw.to_3x3()
        me = o.data
        for p in me.polygons:
            n = me.materials[p.material_index].name.split('.')[0] if me.materials else 'Paint'
            out.append((n, mw @ p.center, (rot @ p.normal).normalized(), [mw @ me.vertices[i].co for i in p.vertices], o))
    return out


def _bounds(fs):
    pts = [v for f in fs for v in f[3]]
    if len(pts) == 1:
        return pts[0].copy(), pts[0].copy()
    return Vector(map(min, *pts)), Vector(map(max, *pts))


def _is_mirror(m, a, b):
    """Island bounds a..b look like a mirror: a small block outboard at the belt line near the cabin front."""
    belt, cf, w = m['beltLine'], m['cabinFront'], m['outerX']
    if belt is None or cf is None:
        return False
    e = b - a
    cy = (a.z + b.z) / 2
    cz = -(a.y + b.y) / 2
    ox = max(abs(a.x), abs(b.x))
    return all(0.04 < c < 0.3 for c in e) and belt - 0.05 < cy < belt + 0.25 and cf - 0.15 < cz < cf + 0.4 and ox > w - 0.12


def _is_handle(m, a, b):
    """Island bounds a..b look like a door handle: a short bar just under the belt line on the side."""
    belt, w = m['beltLine'], m['outerX']
    if belt is None:
        return False
    e = b - a
    cy = (a.z + b.z) / 2
    ox = max(abs(a.x), abs(b.x))
    return e.x < 0.05 and 0.008 < e.z < 0.06 and 0.06 < e.y < 0.22 and belt - 0.18 < cy < belt + 0.01 and ox > w - 0.2


def measure(cid, quiet=False):
    """Stations of the car as the audit finds them (keys match scripts/auditCar.ts). Forward
    distances are car space (positive toward the nose), heights are z."""
    objs = car_meshes(cid)
    fs = faces_of(objs)
    axle, htf, htr, r = rig(cid)
    mn, mx = _bounds(fs)
    fwd = lambda v: -v.y
    side = lambda f: abs(f[2].x) > 0.6
    glass = [f for f in fs if f[0] == 'Glass']
    sglass = [f for f in glass if side(f)]
    belt = window_top = cab_f = cab_r = None
    if sglass:
        b0, b1 = _bounds(sglass)
        belt, window_top, cab_f, cab_r = b0.z, b1.z, -b0.y, -b1.y
    cab_mid = (cab_f + cab_r) / 2 if sglass else 0.0
    # Windshield and backlight face up and along the car more than sideways (tumblehomed side glass on a
    # real body faces up a lot too); a fastback can lie at 20 degrees, so split by position.
    # Only the central band (|x| < 0.45 m) sets the rake: the window corners of a real body add stray faces.
    top_glass = [f for f in glass if f[2].z > 0.25 and abs(f[2].x) < abs(f[2].y) and abs(f[1].x) < 0.45]

    def rake(g):
        if not g:
            return None
        b0, b1 = _bounds(g)
        return math.degrees(math.atan2(b1.z - b0.z, b1.y - b0.y))

    # Width without the mirrors: everything below the belt line.
    low = [f for f in fs if belt is None or f[1].z < belt + 0.02]
    lmn, lmx = _bounds(low)
    nose_fwd, tail_fwd = -mn.y, -mx.y
    nose = [f for f in fs if f[0] != 'Glass' and fwd(f[1]) > nose_fwd - 0.3]
    deck = [f for f in fs if f[0] != 'Glass' and fwd(f[1]) < tail_fwd + 0.3]

    def lamp(name):
        g = [f for f in fs if f[0] == name]
        if not g:
            return None
        b0, b1 = _bounds(g)
        ax = [abs(v.x) for f in g for v in f[3]]
        return dict(xInner=min(ax), xOuter=max(ax), yMin=b0.z, yMax=b1.z, zMin=-b1.y, zMax=-b0.y, height=b1.z - b0.z, faces=len(g))

    m = dict(length=mx.y - mn.y, width=lmx.x - lmn.x, outerX=mx.x, height=mx.z, groundClearance=mn.z,
             wheelbase=2 * axle, trackFront=2 * htf, trackRear=2 * htr, wheelRadius=r,
             overhangFront=nose_fwd - axle, overhangRear=-tail_fwd - axle,
             noseHeight=_bounds(nose)[1].z if nose else 0.0, deckHeight=_bounds(deck)[1].z if deck else 0.0, roof=mx.z,
             beltLine=belt, windowTop=window_top, cabinFront=cab_f, cabinRear=cab_r,
             windshieldDeg=rake([f for f in top_glass if fwd(f[1]) > cab_mid]),
             rearGlassDeg=rake([f for f in top_glass if fwd(f[1]) < cab_mid]),
             head=lamp('HeadLight'), tail=lamp('TailLight'),
             indicator=any(f[0] == 'Light' for f in fs), interior=any(f[0] == 'Interior' for f in fs), tris=sum(len(f[3]) - 2 for f in fs))
    isl = [(k, a, b, mats) for o in objs for (k, a, b, mats) in islands(o)]
    m['mirrors'] = sum(1 for k, a, b, mats in isl if _is_mirror(m, a, b))
    m['handles'] = sum(1 for k, a, b, mats in isl if _is_handle(m, a, b))
    # On the glass band only: the mirror's Black pane sits in the same height band outboard of it, the wiper ends inboard.
    gx = [abs(v.x) for f in sglass for v in f[3]]
    gx0, gx1 = (min(gx) - 0.02, max(gx) + 0.02) if sglass else (0, 0)
    bfaces = [f for f in fs if f[0] == 'Black' and side(f) and belt < f[1].z < window_top and cab_r < fwd(f[1]) < cab_f and gx0 < abs(f[1].x) < gx1] if sglass else []
    m['bPillar'] = None
    if bfaces:
        b0, b1 = _bounds(bfaces)
        m['bPillar'] = dict(zMin=-b1.y, zMax=-b0.y)
    m['cowl'] = bool(sglass) and any(f[0] == 'Black' and f[2].z > 0.5 and cab_f - 0.02 < fwd(f[1]) < cab_f + 0.25 and belt - 0.25 < f[1].z < belt + 0.05 for f in fs)
    tree = surface_tree(objs)

    def gap(x, y):
        hits = []
        for dx in (-0.1, 0, 0.08):
            for dy in (-0.05, 0, 0.05):
                h = tree.ray_cast(Vector((x + dx, y + dy, r + 0.01)), Vector((0, 0, 1)))
                if h[0]:
                    hits.append(h[0].z)
        return round(min(hits) - 2 * r, 3) if hits else None
    m['archGapFront'] = gap(htf, -axle)
    m['archGapRear'] = gap(htr, axle)
    if not quiet:
        f3 = lambda v: '-' if v is None else f'{v:.3f}'
        print(f"{cid}: {f3(m['length'])} x {f3(m['width'])} x {f3(m['height'])} m, wheelbase {f3(m['wheelbase'])}, overhangs {f3(m['overhangFront'])} / {f3(m['overhangRear'])}")
        print(f"  belt {f3(belt)} window top {f3(window_top)} cabin fwd {f3(cab_r)}..{f3(cab_f)} rakes {m['windshieldDeg'] and round(m['windshieldDeg'], 1)} / {m['rearGlassDeg'] and round(m['rearGlassDeg'], 1)}")
        print(f"  nose {f3(m['noseHeight'])} deck {f3(m['deckHeight'])} B pillar {m['bPillar']} mirrors {m['mirrors']} handles {m['handles']} cowl {m['cowl']} interior {m['interior']} indicator {m['indicator']}")
        print(f"  head {m['head']}\n  tail {m['tail']}\n  arch gaps {m['archGapFront']} / {m['archGapRear']}")
    return m


# ----- spec check ------------------------------------------------------------

def targets(spec, house, wb):
    """Blend the donors' ratios to their wheelbase, scale to the car's wheelbase and apply the house stylization."""
    total = sum(d['weight'] for d in spec['donors']) or 1
    ratio = lambda k: sum(d['weight'] / total * d['mm'][k] / d['mm']['wheelbase'] for d in spec['donors'])
    avg = lambda k: sum(d['weight'] / total * d['mm'][k] for d in spec['donors'])
    at = lambda k, s: ratio(k) * wb * house['scale'].get(s, 1)
    return dict(length=at('length', 'length'), width=at('width', 'width'), height=at('height', 'height'),
                overhangFront=at('overhangFront', 'overhangFront'), overhangRear=at('overhangRear', 'overhangRear'),
                trackFront=at('trackFront', 'track'), trackRear=at('trackRear', 'track'), beltLine=at('beltLine', 'beltLine'),
                wheelRadius=ratio('tireRadius') * wb, windshieldDeg=avg('windshieldDeg'), rearGlassDeg=avg('rearGlassDeg'))


def checks(m, t, spec, house, cid=None):
    """[(label, model, target, ok | None, note)], the audit's rows."""
    out = []
    tol = house['tolerance']
    f3 = lambda v: '-' if v is None else f'{v:.3f}'

    def dim(label, model, target, note=''):
        if model is None:
            return out.append((label, '-', f3(target), False, note or 'not found'))
        dev = (model - target) / target
        out.append((label, f3(model), f3(target), abs(dev) <= tol['ratio'], f'{dev * 100:+.1f}%' + (' ' + note if note else '')))

    def ang(label, model, target):
        if model is None:
            return out.append((label, '-', f'{target:.1f}', False, 'no glass found'))
        out.append((label, f'{model:.1f}', f'{target:.1f}', abs(model - target) <= tol['angleDeg'], f'{model - target:+.1f} deg'))

    info = lambda label, model, note='': out.append((label, model, '', None, note))
    feat = lambda label, ok, model, note='': out.append((label, model, '', ok, note))
    dim('length', m['length'], t['length'])
    dim('width', m['width'], t['width'], 'flares included, mirrors not')
    dim('height', m['height'], t['height'], 'roof, house chop applied')
    dim('overhang front', m['overhangFront'], t['overhangFront'])
    dim('overhang rear', m['overhangRear'], t['overhangRear'])
    dim('track front', m['trackFront'], t['trackFront'])
    dim('track rear', m['trackRear'], t['trackRear'])
    dim('belt line', m['beltLine'], t['beltLine'], 'side glass bottom')
    ang('windshield rake', m['windshieldDeg'], t['windshieldDeg'])
    ang('rear glass rake', m['rearGlassDeg'], t['rearGlassDeg'])
    wr = house['wheelRadius'] / t['wheelRadius']
    info('wheel radius', f3(house['wheelRadius']), f"donors at this wheelbase: {f3(t['wheelRadius'])} (car reads {(1 / wr - 1) * 100:.0f}% bigger than its wheels)")
    info('ground clearance', f3(m['groundClearance']))
    info('nose / deck height', f"{f3(m['noseHeight'])} / {f3(m['deckHeight'])}", 'top of the body in the front / rear 0.3 m')
    info('cabin (side glass)', f"fwd {f3(m['cabinRear'])} .. {f3(m['cabinFront'])}", f"window top {f3(m['windowTop'])}")
    lo, hi = house['features']['lamp']['heightRange']

    def lamp_row(label, l, cover):
        if not l:
            return feat(label, False, 'missing')
        # Tall covers (a unit climbing the D pillar) get twice the band, as carFeatures.py builds them.
        top = 2 * hi if cover in ('verticalUnit',) else hi
        feat(label, lo <= l['height'] <= top, f"|x| {f3(l['xInner'])}..{f3(l['xOuter'])}, z {f3(l['yMin'])}..{f3(l['yMax'])}, fwd {f3(l['zMin'])}..{f3(l['zMax'])}", f"height {f3(l['height'])} (house {lo}..{top})")
    lamp_row('headlights', m['head'], spec['lights']['front']['cover'])
    lamp_row('taillights', m['tail'], spec['lights']['rear']['cover'])
    feat('indicators (Light)', m['indicator'], 'found' if m['indicator'] else 'missing')
    feat('glass', m['beltLine'] is not None and m['windshieldDeg'] is not None and m['rearGlassDeg'] is not None, 'side band, windshield, rear glass' if m['beltLine'] is not None else 'missing')
    b = m['bPillar']
    bw = (b['zMax'] - b['zMin']) if b else 0
    feat('B pillar (Black)', bool(b) and 0.06 <= bw <= 0.2, f"fwd {f3(b['zMin'])}..{f3(b['zMax'])} ({f3(bw)} wide)" if b else 'missing',
         f"Black spans {f3(bw)} of the side band: window frames, not a pillar" if bw > 0.2 else f"pillars {''.join(spec['body']['pillars'])}")
    feat('mirrors', m['mirrors'] == 2, f"{m['mirrors']} found", 'expect 2 at the A pillar foot')
    feat('door handles', m['handles'] == spec['body']['doors'], f"{m['handles']} found", f"expect {spec['body']['doors']}")
    feat('cowl (Black, under the windshield)', m['cowl'], 'found' if m['cowl'] else 'missing')
    feat('interior (a donor cabin)', m['interior'], 'found' if m['interior'] else 'missing', "the donor's own or one transplanted by interior(), never a block")
    if cid and "cabin_outside" in globals():  # carFeatures.py is loaded
        out = cabin_outside(cid, m)
        feat('cabin inside the skin', not out, f'{len(out)} vertices out, worst {f3(out[0][0])}' if out else 'all inside', 'no Interior vertex may stand proud of a door, the glass or the roof')
    g0, g1 = house['features']['arch']['gap']
    for label, g in (('arch gap front', m['archGapFront']), ('arch gap rear', m['archGapRear'])):
        feat(label, g is not None and g0 <= g <= g1, f3(g), f'house {g0}..{g1}; negative means the tire pokes through')
    return out


def spec_check(cid):
    """The audit table for the car in this file. Returns (measure, targets, rows)."""
    specs = load_specs()
    spec = specs['cars'][cid]
    m = measure(cid, quiet=True)
    t = targets(spec, specs['house'], m['wheelbase'])
    rows = checks(m, t, spec, specs["house"], cid)
    print(f"{spec['displayName']} ({cid}): {spec['brief']}")
    print(f"{'check':34} {'model':40} {'target':8} {'':4} note")
    for label, model, target, ok, note in rows:
        flag = '' if ok is None else ('ok' if ok else 'OFF')
        print(f'{label:34} {model:40} {target:8} {flag:4} {note}')
    off = [r[0] for r in rows if r[3] is False]
    print('Off spec: ' + ', '.join(off) if off else 'Everything within tolerance.')
    return m, t, rows


# ----- reference photos --------------------------------------------------------

def refs_dir(cid):
    return os.path.join(REPO, 'assets/refs', cid)


def load_ref_json(cid):
    p = os.path.join(refs_dir(cid), 'refs.json')
    if not os.path.exists(p):
        print(f'{cid}: no {p} (see assets/refs/README.md)')
        return None
    with open(p) as f:
        return json.load(f)


def _image_material(name, img):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None) or nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is not None:
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    nt.nodes.active = tex
    m.use_backface_culling = False
    return m


def _plane(name, cname, corners, img):
    """A textured quad; corners are the image's top left, top right, bottom right, bottom left in world space."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(c) for c in corners], [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    for li, u in enumerate([(0, 1), (1, 1), (1, 0), (0, 0)]):
        uv.data[li].uv = u
    me.materials.append(_image_material('Ref_' + name, img))
    o = bpy.data.objects.new(name, me)
    coll(cname).objects.link(o)
    return o


def _frame(view, nose, size, axle, htf, htr, r):
    """Image axes in world space for a view: (right, up, world point of the first calibration
    mark, world point of the second). Planes sit beyond the car on the far side of its view."""
    length, width, height = size
    if view == 'side':
        right = Vector((0, 1, 0)) if nose == 'left' else Vector((0, -1, 0))
        x = -(width / 2 + 0.6)
        return right, Vector((0, 0, 1)), Vector((x, -axle, r)), Vector((x, axle, r)), Vector((x, 0, height / 2))
    if view == 'front':
        y = length / 2 + 0.6
        return Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((-htf, y, r)), Vector((htf, y, r)), Vector((0, y, height / 2))
    if view == 'rear':
        y = -(length / 2 + 0.6)
        return Vector((-1, 0, 0)), Vector((0, 0, 1)), Vector((htr, y, r)), Vector((-htr, y, r)), Vector((0, y, height / 2))
    if view == 'top':
        return Vector((-1, 0, 0)), Vector((0, -1, 0)), Vector((0, -axle, -0.02)), Vector((0, axle, -0.02)), Vector((0, 0, -0.02))
    raise ValueError(f'view {view}: one of {VIEWS}')


def load_refs(cid, views=VIEWS):
    """Place the calibrated photos of assets/refs/<cid>/refs.json as textured planes in
    `<cid>:Refs`: side beyond the right side, front beyond the tail, rear beyond the nose, top
    under the floor, each scaled so its wheel marks land on the Rig wheels. Uncalibrated
    photos are fitted to the car's length or width (approximate) and said so."""
    data = load_ref_json(cid)
    if data is None:
        return []
    axle, htf, htr, r = rig(cid)
    objs = car_meshes(cid)
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    mn, mx = Vector(map(min, *pts)), Vector(map(max, *pts))
    size = (mx.y - mn.y, mx.x - mn.x, mx.z)
    cname = f'{cid}:Refs'
    for o in list(coll(cname).objects):
        bpy.data.objects.remove(o)
    made = []
    for im in data.get('images', []):
        view = im.get('view')
        if view not in views or not im.get('enabled', True):
            continue
        path = os.path.join(refs_dir(cid), im['file'])
        if not os.path.exists(path):
            print(f'{cid}: missing {path}')
            continue
        img = bpy.data.images.load(path, check_existing=True)
        w, h = img.size
        right, up, w0, w1, center = _frame(view, im.get('nose', 'left'), size, axle, htf, htr, r)
        if 'wheels_px' in im:
            (u0, v0), (u1, v1) = im['wheels_px']
            s = (w1 - w0).length / max(math.hypot(u1 - u0, v1 - v0), 1)
            origin = w0
            how = f'{s * 1000:.1f} mm/px from the wheel marks'
        else:
            span = size[0] if view in ('side', 'top') else size[1]
            s = span * 1.2 / w
            origin, u0, v0 = center, w / 2, h / 2
            how = 'uncalibrated: fitted to the car (add wheels_px to refs.json)'
        at = lambda u, v: origin + right * ((u - u0) * s) + up * ((v0 - v) * s)
        o = _plane(f'{cid}.ref_{view}_{os.path.splitext(im["file"])[0]}', cname, [at(0, 0), at(w, 0), at(w, h), at(0, h)], img)
        made.append(o)
        print(f'{o.name}: {view} {w}x{h}px, {how}, {w * s:.2f} x {h * s:.2f} m')
    return made


def spec_from_refs(cid):
    """Real dimensions (mm) from calibrated side photos, to paste into the donor's `mm` in
    carSpecs.json: overhangs and length from extent_px, height from roof_px and ground_px,
    belt line from belt_px. Prints spec vs photo for the keys the spec has."""
    data = load_ref_json(cid)
    if data is None:
        return {}
    donors = load_specs()['cars'][cid]['donors']
    found = {}
    for im in data.get('images', []):
        if im.get('view') != 'side' or 'wheels_px' not in im:
            continue
        d = donors[im.get('donor', 0)]
        (fx, fy), (rx, ry) = im['wheels_px']
        mmpp = d['mm']['wheelbase'] / max(math.hypot(rx - fx, ry - fy), 1)
        out = {}
        if 'extent_px' in im:
            e0, e1 = im['extent_px']
            out['overhangFront'] = round(abs(fx - e0) * mmpp)
            out['overhangRear'] = round(abs(e1 - rx) * mmpp)
            out['length'] = round(abs(e1 - e0) * mmpp)
        if 'ground_px' in im and 'roof_px' in im:
            out['height'] = round((im['ground_px'] - im['roof_px']) * mmpp)
        if 'ground_px' in im and 'belt_px' in im:
            out['beltLine'] = round((im['ground_px'] - im['belt_px']) * mmpp)
        print(f"{d['name']} from {im['file']} ({mmpp:.2f} mm/px): {json.dumps(out)}")
        for k, v in out.items():
            if k in d['mm']:
                print(f"  {k}: spec {d['mm'][k]} -> photo {v}")
        found[d['name']] = out
    return found


# ----- orthographic sheets ------------------------------------------------------

def ortho_sheet(cid, out_dir, views=VIEWS, refs=True, xray=False, res=(1400, 800), wheels=True, parts=()):
    """Render the car (plus temporary wheels and the named part objects) from the side, front,
    rear and top with orthographic Workbench cameras into out_dir/<cid>_<view>.png, the
    reference planes behind it when refs is true (xray lets them show through the car), then
    print the paths: Read them. The scene's render settings are restored afterwards. In the
    live session this may open Blender's render window; that is harmless."""
    os.makedirs(out_dir, exist_ok=True)
    objs = car_meshes(cid)
    axle, htf, htr, r = rig(cid)
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    mn, mx = Vector(map(min, *pts)), Vector(map(max, *pts))
    size = mx - mn
    sc = bpy.context.scene
    sh = sc.display.shading
    keep = dict(engine=sc.render.engine, cam=sc.camera, res=(sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage),
                path=sc.render.filepath, fmt=sc.render.image_settings.file_format, hidden=[(o, o.hide_render) for o in bpy.data.objects],
                shading=(sh.light, sh.color_type, sh.show_xray, sh.xray_alpha))
    visible = {o.name for o in objs} | set(parts)
    if refs and car_coll(cid, 'Refs'):
        visible |= {o.name for o in car_coll(cid, 'Refs').objects}
    temp = []
    if wheels:
        for sx, hx, sy in ((1, htf, -1), (-1, htf, -1), (1, htr, 1), (-1, htr, 1)):
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=r, depth=0.24, location=(sx * hx, sy * axle, r), rotation=(0, math.pi / 2, 0))
            w = bpy.context.active_object
            w.name = f'{cid}.tmp_wheel'
            w.data.materials.append(shared_mat('Tire'))
            temp.append(w)
    tint_materials()
    cam = bpy.data.objects.get('MCP_Ortho')
    if cam is None:
        cam = bpy.data.objects.new('MCP_Ortho', bpy.data.cameras.new('MCP_Ortho'))
        sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.clip_end = 100
    cam.rotation_mode = 'XYZ'
    zc = (mn.z + mx.z) / 2
    aspect = res[0] / res[1]
    # location, rotation, frame width, frame height; the top view puts the nose on the left.
    setup = {'side': ((10, 0, zc), (math.pi / 2, 0, math.pi / 2), size.y, size.z),
             'front': ((0, -10, zc), (math.pi / 2, 0, 0), size.x, size.z),
             'rear': ((0, 10, zc), (math.pi / 2, 0, math.pi), size.x, size.z),
             'top': ((0, 0, 10), (0, 0, math.pi / 2), size.y, size.x)}
    paths = []
    try:
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh.light = 'STUDIO'
        sh.color_type = 'TEXTURE' if refs else 'MATERIAL'
        sh.show_xray = xray
        if xray:
            sh.xray_alpha = 0.5
        sc.render.resolution_x, sc.render.resolution_y = res
        sc.render.resolution_percentage = 100
        sc.render.image_settings.file_format = 'PNG'
        for o in bpy.data.objects:
            o.hide_render = o.name not in visible and o not in temp and o is not cam
        sc.camera = cam
        for v in views:
            loc, rot, w, h = setup[v]
            cam.location = loc
            cam.rotation_euler = rot
            cam.data.ortho_scale = max(w, h * aspect) * 1.15
            p = os.path.join(out_dir, f'{cid}_{v}.png')
            sc.render.filepath = p
            bpy.ops.render.render(write_still=True)
            paths.append(p)
    finally:
        for w in temp:
            bpy.data.objects.remove(w)
        sc.render.engine = keep['engine']
        sc.camera = keep['cam']
        sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = keep['res']
        sc.render.filepath = keep['path']
        sc.render.image_settings.file_format = keep['fmt']
        sh.light, sh.color_type, sh.show_xray, sh.xray_alpha = keep['shading']
        for o, hidden in keep['hidden']:
            try:
                o.hide_render = hidden
            except ReferenceError:
                pass
    print('\n'.join(paths))
    return paths
