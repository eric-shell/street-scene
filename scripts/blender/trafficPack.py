"""
Build the ambient traffic's vehicles from Comrade1280's two Sketchfab packs
(CC BY 4.0): "Generic passenger car pack" and "Generic civil service vehicles
pack". Run headless by scripts/buildTraffic.ts:

    blender -b --factory-startup --python scripts/blender/trafficPack.py -- <packDir> <outDir> [--lineup <png>]

<packDir> holds the two packs as Sketchfab's glTF download imported and
re-exported to GLB (passengerCarPack.glb, civilServicePack.glb). <outDir>
receives:

  traffic.glb        one node per vehicle kind (named after it), in car space
                     (glTF: +Z forward, Y up, wheels on y = 0, centred on the
                     footprint), two materials: `Traffic` (opaque) and
                     `TrafficDecal` (alpha tested lettering and stripes).
  trafficAtlas.png   every texture the vehicles use, packed into one atlas.
                     Alpha is the paint mask on body pixels (1: tinted per car
                     at runtime, stored as grey at PAINT_REF) and the coverage
                     on decal pixels.
  traffic.json       per kind: footprint, height, triangles, whether it is
                     tinted, and its lamps (head, tail, beacon, sign boxes in
                     car space) found from the packs' optics textures.

Why one atlas and one material: the renderer draws every traffic car with
one BatchedMesh (one draw call for all bodies, one for decals), so the
vehicles must share a texture. The packs' own textures are 2048 px each
(about 60 of them); traffic is seen at street distances at night, so each
body texture gets a few hundred pixels and glass, which samples a sliver of
its texture, only its sliver.

Each pack places its vehicles in a ring in millimetre node frames (up is -y);
VEHICLES says which node is which kind and which local axis is the front.
Meshes are joined per vehicle (the passenger pack's wheels are separate
nodes, matched by position), simplified to the kind's triangle budget
(Decimate; REDUCER says why not meshoptimizer), then measured.
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

REPO = globals().get('REPO') or (os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) if '__file__' in globals() else os.getcwd())
exec(open(os.path.join(REPO, 'scripts/blender/meshopt.py')).read())   # meshopt_reduce

# decimate: 'blender' (the Decimate modifier) or 'meshopt' (meshopt.py, Decimate finishing). Blender's:
# meshoptimizer keeps every UV seam of these textured packs, and at 2.2k to 3.4k triangles that
# costs shape (surface lost p95 up on 17 of 19 kinds, 9.9 -> 17.5 mm on the taxi) for no visible
# texture gain at street distance.
REDUCER = 'blender'

# kind: (pack, node, front axis in the node frame, triangle budget, tinted per car)
VEHICLES = {
    'sedan': ('passenger', 'Sedan Body', '-z', 2200, True),
    'wagon': ('passenger', 'Wagon Body', '-z', 2200, True),
    'hatch': ('passenger', 'Hatchback Body', '-z', 2200, True),
    'compact': ('passenger', 'Compact Body', '-z', 2200, True),
    'coupe': ('passenger', 'Coupe Body', '+x', 2200, True),
    'minivan': ('passenger', 'minivan body', '-z', 2200, True),
    'pickup': ('passenger', 'Pickup Body', '-z', 2200, True),
    'suv': ('passenger', 'SUV Body', '-z', 2200, False),
    'offroad': ('passenger', 'Offroad Body', '-z', 2200, True),
    'taxi': ('civil', 'taxi', '-z', 2600, False),
    'police': ('civil', 'police_sedan', '-z', 2600, False),
    'ambulance': ('civil', 'ambulance', '-z', 2800, False),
    'postvan': ('civil', 'postvan', '-z', 2400, False),
    'serviceTruck': ('civil', 'rdservtruck', '-z', 2600, False),
    'towTruck': ('civil', 'towtruck', '-z', 2600, False),
    'fireTruck': ('civil', 'fire_truck', '-z', 3400, False),
    'garbageTruck': ('civil', 'garbage_truck', '-z', 3400, False),
    'cityBus': ('civil', 'citybus', '-z', 3200, False),
    'schoolBus': ('civil', 'school_bus', '-z', 3400, False),
}
PACK_FILES = {'passenger': 'passengerCarPack.glb', 'civil': 'civilServicePack.glb'}

AXES = {'-z': Vector((0, 0, -1)), '+z': Vector((0, 0, 1)), '-x': Vector((-1, 0, 0)), '+x': Vector((1, 0, 0))}


def args():
    a = sys.argv[sys.argv.index('--') + 1:]
    out = {'packs': a[0], 'out': a[1], 'lineup': None}
    if '--lineup' in a:
        out['lineup'] = a[a.index('--lineup') + 1]
    return out


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def bounds(o):
    vs = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', vs)
    vs = vs.reshape(-1, 3)
    return vs.min(0), vs.max(0)


def car_frame(node, front):
    """World -> car space (Blender: metres, Z up, car facing -Y, +X its left) for a node frame in mm with up = -y."""
    f = AXES[front]
    up = Vector((0, -1, 0))
    back = -f  # car +Y is its rear
    x = back.cross(up)
    rot = Matrix((x, back, up)).to_4x4()  # rows: local -> car axes
    scale = Matrix.Scale(0.001, 4)
    return scale @ rot @ node.matrix_world.inverted()


def gather(pack_objs, node):
    """Meshes of a vehicle: the node's descendants plus (passenger pack) the wheel nodes inside its footprint."""
    meshes = [o for o in node.children_recursive if o.type == 'MESH']
    if not any(m.name.startswith('Wheel') for m in meshes):
        mn = Vector((1e9, 1e9)); mx = Vector((-1e9, -1e9))
        for m in meshes:
            for c in m.bound_box:
                w = m.matrix_world @ Vector(c)
                mn = Vector((min(mn.x, w.x), min(mn.y, w.y))); mx = Vector((max(mx.x, w.x), max(mx.y, w.y)))
        for o in pack_objs:
            if o.type != 'MESH' or not o.name.startswith('Wheel') or o in meshes:
                continue
            c = o.matrix_world @ Vector(np.mean([list(v) for v in o.bound_box], 0))
            if mn.x - 0.1 < c.x < mx.x + 0.1 and mn.y - 0.1 < c.y < mx.y + 0.1:
                meshes.append(o)
    return meshes


def extract(kind, pack_objs, spec):
    pack, node_name, front, budget, tint = spec
    node = next(o for o in pack_objs if o.name.split('.')[0] == node_name or o.name == node_name)
    meshes = gather(pack_objs, node)
    to_car = car_frame(node, front)
    copies = []
    for m in meshes:
        c = m.copy()
        c.data = m.data.copy()
        bpy.context.scene.collection.objects.link(c)
        c.parent = None
        c.data.transform(to_car @ m.matrix_world)
        c.matrix_world = Matrix()
        copies.append(c)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for c in copies:
        c.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = kind
    # Some meshes sit yawed inside their node (the coupe): square the footprint up by its smallest bounding rectangle.
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', co)
    xy = co.reshape(-1, 3)[:, :2]
    best = min(np.radians(np.arange(-45, 45, 0.25)), key=lambda t: np.ptp(xy @ [math.cos(t), math.sin(t)]) * np.ptp(xy @ [-math.sin(t), math.cos(t)]))
    if abs(best) > math.radians(1):
        o.data.transform(Matrix.Rotation(-best, 4, 'Z'))
    # Centre the footprint on the origin, wheels on the ground.
    mn, mx = bounds(o)
    o.data.transform(Matrix.Translation((-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2])))
    o.data.update()
    return o


def decimate(o, budget):
    """Weld coincident vertices (the glTF import splits them at every seam), then collapse to the
    budget with the Decimate modifier, or with REDUCER = 'meshopt' meshoptimizer's collapse first
    (it keeps the UV islands whole) and the modifier finishing."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bm.to_mesh(o.data)
    bm.free()
    before = have = tris(o)
    if have > budget and REDUCER == 'meshopt':
        have = meshopt_reduce(o, budget)[0]
    if have > budget:
        mod = o.modifiers.new('decimate', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = budget / have
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return before, tris(o)


# ---------------------------------------------------------------------------
# Materials: what each source material draws and with which texture
# ---------------------------------------------------------------------------

def role_of(mat):
    n = mat.name.lower()
    if 'decal' in n:
        return 'decal'
    if 'glass' in n:
        return 'glass'
    if 'optics' in n:
        return 'optics'
    if n.startswith('whee'):
        return 'wheel'
    return 'body'


def base_color(mat):
    """(image or None, RGB factor) feeding the Principled BSDF's Base Color."""
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mat.node_tree else None
    if bsdf is None:
        return None, (1, 1, 1)
    sock = bsdf.inputs['Base Color']
    factor = (1, 1, 1)
    if not sock.is_linked:
        return None, tuple(sock.default_value[:3])
    node = sock.links[0].from_node
    # The glTF importer puts a multiply (MIX) between a factor and the texture.
    if node.type == 'MIX':
        for inp in node.inputs:
            if inp.is_linked and inp.links[0].from_node.type == 'TEX_IMAGE':
                img_node = inp.links[0].from_node
            elif inp.type == 'RGBA' and not inp.is_linked:
                factor = tuple(inp.default_value[:3])
        node = img_node
    if node.type == 'TEX_IMAGE' and node.image:
        return node.image, factor
    return None, factor


_pixels = {}


def pixels(img):
    """An image's pixels as an (h, w, 4) float array, rows bottom up (as stored, sRGB values for byte images)."""
    if img.name not in _pixels:
        w, h = img.size
        a = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(a)
        _pixels[img.name] = a.reshape(h, w, 4)
    return _pixels[img.name]


def sample(img, uv):
    p = pixels(img)
    h, w = p.shape[:2]
    return p[min(h - 1, max(0, int(uv[1] % 1 * h))), min(w - 1, max(0, int(uv[0] % 1 * w))), :3]


# ---------------------------------------------------------------------------
# Lamps: islands of optics faces, classified by colour and where they sit
# ---------------------------------------------------------------------------

LAMP_LIMIT = {'head': 4, 'tail': 6, 'beacon': 8, 'sign': 1}


def lamp_class(rgb, c, n, size, kind):
    """head / tail / beacon / sign or None for one optics face (centre c, normal n, car size)."""
    r, g, b = rgb
    L, H = size[1], size[2]
    # Roof: the top of a car; on trucks and buses the cab roof too (below a ladder rack or a box).
    roof = c.z > (H - 0.6 if H > 2.4 else H * 0.82)
    red = r > 0.3 and r > 1.7 * g and r > 1.7 * b
    blue = b > 0.3 and b > 1.4 * r and b > 1.1 * g
    amber = r > 0.45 and g > 0.25 and b < 0.55 * g and r > 1.2 * g
    white = min(r, g, b) > 0.42
    if roof:
        if kind == 'taxi':
            return 'sign', None
        if red or blue or amber:
            return 'beacon', 'red' if red else 'blue' if blue else 'amber'
        return None, None
    if c.y < -L * 0.3 and n.y < -0.35 and white:
        return 'head', None
    if c.y > L * 0.3 and n.y > 0.35 and red:
        return 'tail', None
    return None, None


def find_lamps(o, kind):
    mn, mx = bounds(o)
    size = Vector(mx - mn)
    uv = o.data.uv_layers['UVMap']
    roles = [role_of(m) for m in o.data.materials]
    imgs = [base_color(m)[0] for m in o.data.materials]
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    uvl = bm.loops.layers.uv['UVMap']
    tag = {}
    for f in bm.faces:
        role = roles[f.material_index]
        if role not in ('optics', 'decal', 'glass') or imgs[f.material_index] is None:
            continue
        # Light bars and the taxi's sign are glass and decals; only on the roof do those count.
        if role != 'optics' and f.calc_center_median().z < (size[2] - 0.6 if size[2] > 2.4 else size[2] * 0.82):
            continue
        if role == 'decal' and kind != 'taxi':
            continue
        u = sum((l[uvl].uv for l in f.loops), Vector((0, 0))) / len(f.loops)
        cls = lamp_class(sample(imgs[f.material_index], u), f.calc_center_median(), f.normal, size, kind)
        if cls[0]:
            tag[f.index] = cls
    # Islands of same-class faces sharing an edge.
    seen = set()
    found = []
    for i, cls in tag.items():
        if i in seen:
            continue
        stack, island = [bm.faces[i]], []
        seen.add(i)
        while stack:
            f = stack.pop()
            island.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen and tag.get(g.index) == cls:
                        seen.add(g.index)
                        stack.append(g)
        vs = [v.co for f in island for v in f.verts]
        lo = Vector(map(min, *vs))
        hi = Vector(map(max, *vs))
        area = sum(f.calc_area() for f in island)
        found.append({'role': cls[0], 'color': cls[1], 'lo': lo, 'hi': hi, 'area': area})
    bm.free()
    # Merge boxes of one role that touch (a lamp split by trim), then keep the biggest per role.
    merged = []
    for l in sorted(found, key=lambda l: -l['area']):
        for m in merged:
            if m['role'] == l['role'] and m['color'] == l['color'] and all(l['lo'][k] < m['hi'][k] + 0.03 and l['hi'][k] > m['lo'][k] - 0.03 for k in range(3)):
                m['lo'] = Vector(map(min, m['lo'], l['lo']))
                m['hi'] = Vector(map(max, m['hi'], l['hi']))
                m['area'] += l['area']
                break
        else:
            merged.append(dict(l))
    out = []
    for role, limit in LAMP_LIMIT.items():
        ls = [l for l in merged if l['role'] == role and l['area'] > 0.0015]
        out += sorted(ls, key=lambda l: -l['area'])[:limit]
    return out


def lamp_json(l):
    """A lamp box in glTF car space (x, y, z) = Blender (x, z, -y), pushed 1 cm out of the face it covers."""
    lo, hi = l['lo'], l['hi']
    c = (lo + hi) / 2
    s = Vector((max(hi.x - lo.x, 0.03), max(hi.y - lo.y, 0.03), max(hi.z - lo.z, 0.03)))
    if l['role'] == 'head':
        c.y -= 0.01
    elif l['role'] == 'tail':
        c.y += 0.01
    else:
        c.z += 0.01
    j = {'role': l['role'], 'p': [round(c.x, 3), round(c.z, 3), round(-c.y, 3)], 's': [round(s.x, 3), round(s.z, 3), round(s.y, 3)]}
    if l['color']:
        j['color'] = l['color']
    return j


# ---------------------------------------------------------------------------
# Atlas: every source texture region the vehicles sample, packed into one image
# ---------------------------------------------------------------------------

ATLAS = 2048
PAD = 8
# Atlas pixels per source pixel, relative to the body textures' share (found by packing).
ROLE_SCALE = {'body': 1.0, 'wheel': 0.3, 'optics': 0.7, 'glass': 0.5, 'decal': 1.4}
# Tinted paint is stored as grey: a pixel as bright as the paint's median is this (sRGB) value.
PAINT_REF = 0.8


def paint_mask(px):
    """Paint pixels of a body texture (rgb sRGB, h x w x 3): the dominant saturated hue. Returns (mask, grey)."""
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    v = px.max(-1)
    s = np.where(v > 0, (v - px.min(-1)) / np.maximum(v, 1e-6), 0)
    d = np.maximum(v - px.min(-1), 1e-6)
    h = np.where(v == r, ((g - b) / d) % 6, np.where(v == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    strong = (s > 0.35) & (v > 0.15)
    hist, edges = np.histogram(h[strong], bins=72, range=(0, 360))
    hue = (edges[hist.argmax()] + edges[hist.argmax() + 1]) / 2
    dh = np.abs((h - hue + 180) % 360 - 180)
    mask = (dh < 24) & (s > 0.25) & (v > 0.06)
    print(f'  paint hue {hue:.0f}, {mask.mean() * 100:.0f} % of the texture')
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    ref = np.median(luma[mask]) if mask.any() else 1
    grey = np.clip(luma / ref * PAINT_REF, 0, 1)
    return mask, grey


def pack(sizes, side):
    """Shelf pack (w, h) rectangles, tallest first, into a side x side square: positions or None."""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pos = [None] * len(sizes)
    x = y = shelf = 0
    for i in order:
        w, h = sizes[i]
        if x + w > side:
            x, y, shelf = 0, y + shelf, 0
        if y + h > side or w > side:
            return None
        pos[i] = (x, y)
        x += w
        shelf = max(shelf, h)
    return pos


# Every pane of glass: one dark swatch. The packs blend glass over their faked interiors; here it is
# opaque, and its texture regions are slivers whose mips would bleed the neighbouring cells in.
GLASS = (0.012, 0.015, 0.02)
SWATCH = 24


def source(mat):
    """(image or None, linear RGB factor) a material samples in the atlas."""
    if role_of(mat) == 'glass':
        return None, GLASS
    return base_color(mat)


def region_key(mat):
    """Atlas region a material samples: its texture (or flat colour), role and colour factor."""
    img, factor = source(mat)
    return (img.name if img else 'flat:%.3f,%.3f,%.3f' % factor, role_of(mat), tuple(round(c, 3) for c in factor))


def build_atlas(objs, tinted):
    """Pack the textures, remap every UV into the atlas, reassign the two output materials. Returns the atlas pixels."""
    # Regions: one per (image, role) with the union of the UVs that sample it; one flat swatch per untextured colour.
    regions = {}
    for o in objs:
        me = o.data
        uv = me.uv_layers['UVMap'].data
        for p in me.polygons:
            m = me.materials[p.material_index]
            img, factor = source(m)
            role = role_of(m)
            key = region_key(m)
            r = regions.setdefault(key, {'img': img, 'factor': factor, 'role': role, 'lo': [1e9, 1e9], 'hi': [-1e9, -1e9], 'tint': False})
            if o.name in tinted and role == 'body' and m.name.startswith('Body'):
                r['tint'] = True
            for li in p.loop_indices:
                u, v = uv[li].uv
                r['lo'] = [min(r['lo'][0], u), min(r['lo'][1], v)]
                r['hi'] = [max(r['hi'][0], u), max(r['hi'][1], v)]
    keys = list(regions)

    def sizes_at(k):
        out = []
        for key in keys:
            r = regions[key]
            if r['img'] is None:
                out.append((SWATCH + 2 * PAD, SWATCH + 2 * PAD))
                continue
            w, h = r['img'].size
            cw = max(1.0, (r['hi'][0] - r['lo'][0]) * w)
            ch = max(1.0, (r['hi'][1] - r['lo'][1]) * h)
            f = k * ROLE_SCALE[r['role']]
            out.append((max(4, int(cw * f)) + 2 * PAD, max(4, int(ch * f)) + 2 * PAD))
        return out

    k = 0.5
    while True:
        sizes = sizes_at(k)
        pos = pack(sizes, ATLAS)
        if pos:
            break
        k *= 0.96
    print(f'atlas: {len(keys)} regions, {k * 2048:.0f} px per 2048 px body texture')
    atlas = np.zeros((ATLAS, ATLAS, 4), np.float32)
    cells = {}
    for key, (w, h), (x, y) in zip(keys, sizes, pos):
        r = regions[key]
        iw, ih = w - 2 * PAD, h - 2 * PAD
        if r['img'] is None:
            tile = np.ones((ih, iw, 4), np.float32)
            tile[..., :3] = [c ** (1 / 2.2) for c in r['factor']]  # linear factor to sRGB, near enough for a swatch
            tile[..., 3] = 0
        else:
            src = pixels(r['img'])
            sh, sw = src.shape[:2]
            x0 = int(np.floor(r['lo'][0] * sw)) % sw if r['hi'][0] - r['lo'][0] < 1 else 0
            y0 = int(np.floor(r['lo'][1] * sh)) % sh if r['hi'][1] - r['lo'][1] < 1 else 0
            x1 = min(sw, max(x0 + 1, int(np.ceil(r['hi'][0] * sw))))
            y1 = min(sh, max(y0 + 1, int(np.ceil(r['hi'][1] * sh))))
            crop = src[y0:y1, x0:x1].copy()
            crop[..., :3] *= np.array([c ** (1 / 2.2) for c in r['factor']], np.float32)
            # Resample to the cell by area averaging (box filter on a grid), point sampled when enlarging.
            ys = (np.arange(ih) + 0.5) * crop.shape[0] / ih
            xs = (np.arange(iw) + 0.5) * crop.shape[1] / iw
            if crop.shape[0] > ih or crop.shape[1] > iw:
                ey = np.linspace(0, crop.shape[0], ih + 1).astype(int)
                ex = np.linspace(0, crop.shape[1], iw + 1).astype(int)
                c = np.add.reduceat(np.add.reduceat(crop, ey[:-1], 0), ex[:-1], 1)
                cnt = np.outer(np.diff(ey), np.diff(ex))[..., None]
                tile = c / np.maximum(cnt, 1)
            else:
                tile = crop[ys.astype(int)][:, xs.astype(int)]
            if r['role'] == 'decal':
                pass  # coverage stays in alpha
            elif r['tint']:
                mask, grey = paint_mask(tile[..., :3])
                tile[mask, :3] = grey[mask][:, None]
                tile[..., 3] = mask
            else:
                tile[..., 3] = 0
        # Edge padding so mip levels do not bleed neighbours in.
        tile = np.pad(tile, ((PAD, PAD), (PAD, PAD), (0, 0)), mode='edge')
        atlas[y:y + h, x:x + w] = tile
        cells[key] = (x + PAD, y + PAD, iw, ih)
    # Remap UVs and reduce the materials to Traffic / TrafficDecal.
    mats = {n: bpy.data.materials.get(n) or bpy.data.materials.new(n) for n in ('Traffic', 'TrafficDecal')}
    for o in objs:
        me = o.data
        uv = me.uv_layers['UVMap'].data
        decal = []
        for p in me.polygons:
            m = me.materials[p.material_index]
            img, factor = source(m)
            role = role_of(m)
            key = region_key(m)
            r = regions[key]
            cx, cy, cw, ch = cells[key]
            span = [max(r['hi'][0] - r['lo'][0], 1e-6), max(r['hi'][1] - r['lo'][1], 1e-6)]
            for li in p.loop_indices:
                u, v = uv[li].uv
                if img is None:
                    uu, vv = cx + cw * 0.5, cy + ch * 0.5
                else:
                    uu = cx + (u - r['lo'][0]) / span[0] * cw
                    vv = cy + (v - r['lo'][1]) / span[1] * ch
                uv[li].uv = (uu / ATLAS, vv / ATLAS)
            decal.append(role == 'decal')
        for name in [l.name for l in me.uv_layers if l.name != 'UVMap']:
            me.uv_layers.remove(me.uv_layers[name])
        # Clearing materials resets every face to slot 0 (the /blender trap): set the slots after.
        me.materials.clear()
        me.materials.append(mats['Traffic'])
        me.materials.append(mats['TrafficDecal'])
        me.polygons.foreach_set('material_index', [1 if d else 0 for d in decal])
        me.update()
    return atlas


def save_atlas(atlas, path_png, path_webp):
    """PNG (lossless, for the lineup) and WebP (shipped). WebP's encoder rewrites the colour under
    alpha 0 for compression, but alpha here is a mask, not transparency: floor it at 1/255."""
    atlas = atlas.copy()
    atlas[..., 3] = np.maximum(atlas[..., 3], 1 / 255)
    img = bpy.data.images.new('trafficAtlas', ATLAS, ATLAS, alpha=True)
    img.pixels.foreach_set(atlas.ravel())
    img.filepath_raw = path_png
    img.file_format = 'PNG'
    img.save()
    scene = bpy.context.scene
    # save_render applies the scene's view transform; the atlas is already display (sRGB) values.
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    st = scene.render.image_settings
    st.file_format = 'WEBP'
    st.color_mode = 'RGBA'
    st.quality = 90
    img.save_render(path_webp, scene=scene)


def footprint(o):
    """Collision half length and half width (m): the body below the mirrors, between 0.2 and 1.0 m up."""
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    band = co[(co[:, 2] > 0.2) & (co[:, 2] < 1.0)]
    return float(np.ptp(co[:, 1]) / 2), float(np.ptp(band[:, 0]) / 2), float(co[:, 2].max())


def export(objs, path):
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_image_format='NONE', export_texcoords=True, export_normals=True, export_materials='EXPORT', export_vertex_color='NONE', export_extras=False, export_apply=True)


def lineup(objs, path, cols=5, step=12):
    """Workbench render of every vehicle on a grid, textured, each turned to a front three quarter view."""
    scene = bpy.context.scene
    for o in scene.objects:
        o.hide_render = True
    dups = []
    for i, o in enumerate(objs):
        d = o.copy()
        scene.collection.objects.link(d)
        d.location = ((i % cols) * step, (i // cols) * step, 0)
        d.rotation_mode = 'XYZ'
        d.rotation_euler = (0, 0, math.radians(-35))
        d.hide_render = False
        dups.append(d)
    rows = (len(objs) + cols - 1) // cols
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'TEXTURE'
    scene.render.resolution_x, scene.render.resolution_y = 2400, 1100
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = cols * step
    cam.location = ((cols - 1) * step / 2, (rows - 1) * step / 2 - 60, 22)
    cam.rotation_euler = (math.radians(70), 0, 0)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for d in dups:
        bpy.data.objects.remove(d)


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    packs = {}
    for pack, file in PACK_FILES.items():
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(a['packs'], file))
        packs[pack] = [o for o in bpy.data.objects if o not in before]
    out = []
    info = {}
    for kind, spec in VEHICLES.items():
        o = extract(kind, packs[spec[0]], spec)
        lamps = find_lamps(o, kind)
        b, t = decimate(o, spec[3])
        hl, hw, height = footprint(o)
        roles = {}
        for l in lamps:
            roles[l['role']] = roles.get(l['role'], 0) + 1
        print(f'{kind:13s} tris {b:6d} -> {t:5d}  half {hl:.2f} x {hw:.2f}  height {height:.2f}  lamps {roles}')
        info[kind] = {'halfLength': round(hl, 3), 'halfWidth': round(hw, 3), 'height': round(height, 3), 'triangles': t, 'tinted': spec[4], 'lamps': [lamp_json(l) for l in lamps]}
        out.append(o)
    for objs in packs.values():
        for o in objs:
            bpy.data.objects.remove(o)
    # Kind names clash with the packs' own nodes (taxi, ambulance) until those are gone.
    for kind, o in zip(VEHICLES, out):
        o.name = kind
    os.makedirs(a['out'], exist_ok=True)
    atlas = build_atlas(out, {k for k, s in VEHICLES.items() if s[4]})
    save_atlas(atlas, os.path.join(a['out'], 'trafficAtlas.png'), os.path.join(a['out'], 'trafficAtlas.webp'))
    export(out, os.path.join(a['out'], 'traffic.glb'))
    with open(os.path.join(a['out'], 'traffic.json'), 'w') as f:
        json.dump({'paintRef': PAINT_REF, 'kinds': info}, f, indent=1)
    if a['lineup']:
        # Show the atlas on the output materials, paint grey as stored.
        atlas_img = bpy.data.images.load(os.path.join(a['out'], 'trafficAtlas.png'))
        atlas_img.alpha_mode = 'NONE'
        for name in ('Traffic', 'TrafficDecal'):
            m = bpy.data.materials[name]
            m.use_nodes = True
            nt = m.node_tree
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            tex = nt.nodes.new('ShaderNodeTexImage')
            tex.image = atlas_img
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        lineup(out[:9], a['lineup'].replace('.png', '_cars.png'), 5, 6.5)
        lineup(out[9:], a['lineup'].replace('.png', '_civil.png'), 5, 11)


main()
