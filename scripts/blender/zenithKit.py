"""
The Tachibana Zenith from MattDoesBlender's "Supra" (Sketchfab 0eb749a14dd441d1b2a7b2ad1d53fa11,
CC BY 4.0): a parts catalog rather than one car. Every panel is its own object under a node
named `<Slot>_<Variant>_<n>` (Frontbumper_Stock, Splitter_JUN, Diffusor_BigWings ...), so the
car is assembled from the donor's own pieces instead of reduced and cut (docs/carDonors.md):
the stock pieces become the base model, every other variant a catalog part.

Run inside a session holding the import (import_asset(source='sketchfab', id=UID)), after
carKit.py and carDonors.py:

    exec(open(REPO + '/scripts/blender/zenithKit.py').read())
    zenith(root)          # root: the import's GLTF_SceneRootNode -> tachibanaZenith:Car|Parts|Rig

What the donor needs, learned from the import (2026-10-29):
- Each panel is modelled twice, a `Body` and a `Carbon` copy of the same geometry (how the game
  it comes from switches a carbon finish): the painted copy ships, the carbon twin is dropped.
  A piece with no painted twin (splitters, diffusers, canards, the APR wings) is carbon only:
  Black on the aero pieces, Paint on a panel.
- The wheels sit at the origin (the game places them), so the axles come from the arches:
  centers at y -1.20 and +1.20 of the import, a 2.40 m wheelbase scaled to the published 2.55.
- The lamps are painted in 1024 px textures (`Lightsa`, `Lightsb`, `Lightsc`) over flat
  geometry: each face is classed by the colour under its UV center (carDonors.lamp_colour).
- `Windowwrap` is a black band whose alpha texture cuts the window frit: faces it paints
  transparent are dropped, the rest are Black.
- Badges and the licence plate go; the engine bay (`Base_Engine*`) cannot be seen and goes.
"""
import json
import re

import bmesh
import bpy
from mathutils import Matrix, Vector

CID = 'tachibanaZenith'
WHEELBASE = 2.55        # m, published (Wikipedia, Toyota Supra A80)
DONOR_AXLES = (-1.20, 1.20)   # import y of the arch centers
DONOR_AXLE_Z = 0.1275   # import z of the arch centers (fitted to the front arch's lip)
WHEEL_R = 0.335         # m, the manifest's wheel radius (the Hien on its tire)
TRACK = 1.496           # m, both axles
ARCH_DROP = 0.02        # m the body sits below centering the arch on the wheel (arch gap ~0.03)

# Donor slot -> (garage slot, base node name for the stock piece).
SLOTS = {
    'Frontbumper': ('frontBumper', 'Bumper_Front'),
    'Splitter': ('splitter', 'Splitter'),
    'Canard': ('canards', None),
    'Fender': ('fenders', 'Fenders'),
    'Rearfender': ('fenders', 'Fenders'),
    'Sideskirt': ('sideSkirts', 'Skirts'),
    'Rearbumper': ('rearBumper', 'Bumper_Rear'),
    'Diffusor': ('diffuser', None),
    'Exhaust': ('exhaust', 'Exhaust'),
    'Hood': ('hood', 'Hood'),
    'Mirror': ('mirrors', 'Mirrors'),
    'Spoiler': ('spoiler', 'Spoiler'),
}
BODY = ('Base', 'Trunk', 'Frontlight', 'Brakelight', 'Interior')   # the stock variants joined into Body
SKIP = {('Brakelight', 'CarShopGlow'), ('Licenceplate', None)}
AERO = {'splitter', 'canards', 'diffuser', 'spoiler', 'exhaust'}
# The fender kits pair a front wing with rear quarters: the donor's rear fenders come in Stock,
# Street and Ridox only, so its JUN front wings ride on the stock rear quarters.
FENDER_REAR = {'Street': 'Street', 'Ridox': 'Ridox', 'JUN': 'Stock'}
INTERIOR_BUDGET = 2500
# Garage names and order per slot, cheapest real-world part first (memory: part order by price).
# The donor's kits carry real tuner names (JUN, Ridox, APR), which never ship: each kit is a
# fictional tuner, and a plain piece is named for its shape.
NAMES = {
    'frontBumper': {'Ridox': 'Shippu', 'JUN': 'Jinrai', 'Race': 'Akagi'},
    'splitter': {'Low': 'Flat Lip', 'Corner': 'Corner Plates', 'Oval': 'Oval', 'Sharp': 'Blade', 'Street': 'Kaido',
                 'Ridox': 'Shippu', 'JUN': 'Jinrai', 'Intake': 'Ducted', 'Race': 'Akagi'},
    'canards': {'I': 'Single Dive', 'II': 'Twin Dive', 'JUN': 'Jinrai', 'Ridox': 'Shippu'},
    'fenders': {'JUN': 'Jinrai', 'Ridox': 'Shippu', 'Street': 'Kaido'},
    'sideSkirts': {'JUN': 'Jinrai', 'Ridox': 'Shippu'},
    'rearBumper': {'JUN': 'Jinrai', 'Ridox': 'Shippu'},
    'diffuser': {'I': 'Strake', 'II': 'Twin Strake', 'Wings': 'Strake Wings', 'SplinedwithWings': 'Splined Wings',
                 'BigI': 'Wide Strake', 'BigII': 'Wide Twin Strake', 'BigWings': 'Wide Wings',
                 'BigSplinedwithWings': 'Wide Splined', 'JUN': 'Jinrai'},
    'exhaust': {'Tilted': 'Turndown', 'Curved': 'Curved', '3"': 'Three Inch', 'Carbon': 'Carbon Tip',
                'StraightTwinPipes': 'Straight Twin', 'CurvedTwinPipes': 'Curved Twin', 'BosozokuStyle': 'Bosozoku',
                'BosozokuPipes': 'Takeyari', 'Ridox': 'Shippu', 'JUN': 'Jinrai'},
    'hood': {'Street': 'Kaido', 'Ridox': 'Shippu', 'JUN': 'Jinrai'},
    'mirrors': {'Ridox': 'Shippu'},
    'spoiler': {'High': 'Takane', 'JUN': 'Jinrai', 'Ridox': 'Shippu', 'APRGT250': 'Arashi Short',
                'APRGT500': 'Arashi Mid', 'APRGT1000': 'Arashi Tall'},
}
# TRI_BUDGETS in src/shared/parts.ts, by garage slot (the stock pieces in Car by the slot they fill).
TRI_BUDGETS = {
    'body': 20000, 'frontBumper': 7500, 'Bumper': 7500, 'rearBumper': 5500, 'fenders': 6000, 'Fenders': 6000,
    'sideSkirts': 3000, 'Skirts': 3000, 'spoiler': 3000, 'Spoiler': 3000, 'hood': 2500, 'Hood': 2500,
    'splitter': 2500, 'Splitter': 2500, 'canards': 1500, 'diffuser': 3000, 'exhaust': 2500, 'Exhaust': 2500,
    'mirrors': 2500, 'Mirrors': 2500,
}

MATS = {
    'Body': 'Paint', 'Chassis': 'Black', 'Misc': 'Black', 'Grilla': 'Black', 'Screws': 'Chrome',
    'Lightglass': 'Lens', 'Window': 'Glass', 'Windowwrap': 'Black', 'Mirror': 'Chrome',
    'Interior': 'Interior', 'Interior_Glow': 'Interior', 'Interior_Tiled': 'Interior', 'Engine': 'Black',
    'Badge': None, 'Licenceplate': None,
}


def _parts(root):
    """{(Slot, Variant): [nodes]} for every catalog node under the import root. The donor's
    exporter left the second half of a two sided part (a fender's other side, a bumper's last
    material) beside its node rather than under it, named `<Slot>_<Variant>_<Material>_<n>`:
    such a node joins the part whose name is the longest prefix of its own."""
    nodes = []
    for o in root.children:
        m = re.match(r'^([A-Za-z]+)_(.+)_\d+$', o.name)
        nodes.append(((m.group(1), m.group(2)) if m else (o.name.rsplit('_', 1)[0], None), o))
    keys = {k for k, o in nodes if any(c.type != 'MESH' for c in o.children) or k[1] is None}
    out = {}
    for (s, v), o in nodes:
        owner = (s, v)
        if v is not None:
            bits = v.split('_')
            for i in range(len(bits) - 1, 0, -1):
                if (s, '_'.join(bits[:i])) in keys:
                    owner = (s, '_'.join(bits[:i]))
                    break
        out.setdefault(owner, []).append(o)
    return out


def car_matrix():
    s = WHEELBASE / (DONOR_AXLES[1] - DONOR_AXLES[0])
    mid = (DONOR_AXLES[0] + DONOR_AXLES[1]) / 2
    dz = WHEEL_R - ARCH_DROP - DONOR_AXLE_Z * s
    return Matrix.Translation((0, -mid * s, dz)) @ Matrix.Scale(s, 4)


def _meshes(nodes):
    """The part's meshes without the carbon twins: a mesh whose triangle count and center match
    a painted one's is the same panel in carbon."""
    ms = [o for n in nodes for o in [n] + list(n.children_recursive) if o.type == 'MESH' and o.data.polygons]

    def key(o):
        mw = o.matrix_world
        return tris(o), sum((mw @ v.co for v in o.data.vertices), Vector()) / len(o.data.vertices)

    keep = []
    for o in sorted(ms, key=lambda o: _base(o.data.materials[0].name).startswith('Carbon')):
        n, c = key(o)
        # The twins' centers differ by up to a millimetre at the import's scale.
        if not any(n == n2 and (c - c2).length < 0.005 for n2, c2, _ in keep):
            keep.append((n, c, o))
    return [o for _, _, o in keep]


def _lamp_class(o):
    """Per face shared class of a painted lamp mesh (Lightsa/b/c) from its texture."""
    tex = _texture_map(o.data.materials[0])
    uv = o.data.uv_layers.active.data
    out = []
    for p in o.data.polygons:
        c = sum((uv[i].uv for i in p.loop_indices), Vector((0, 0))) / p.loop_total
        h, w = tex.shape[:2]
        out.append(lamp_colour(tex[min(h - 1, int((c.y % 1) * h)), min(w - 1, int((c.x % 1) * w))]))
    return out


def _alpha_keep(o):
    """Faces of an alpha textured band (Windowwrap) its texture paints opaque."""
    mat = o.data.materials[0]
    img = next(n.image for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
    w, h = img.size
    import numpy as np
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4)[..., 3]
    uv = o.data.uv_layers.active.data
    keep = []
    for p in o.data.polygons:
        c = sum((uv[i].uv for i in p.loop_indices), Vector((0, 0))) / p.loop_total
        keep.append(a[min(h - 1, int((c.y % 1) * h)), min(w - 1, int((c.x % 1) * w))] > 0.5)
    return keep


def _piece(nodes, name, cname, slot):
    """One object from a catalog part's nodes: its meshes (carbon twins dropped) baked into car space,
    every face on a shared material, joined."""
    M = car_matrix()
    bm = bmesh.new()
    names = []
    for o in _meshes(nodes):
        src = _base(o.data.materials[0].name)
        if src.startswith('Engine') and _base(nodes[0].name).startswith('Base'):
            continue
        if src.startswith('Lights'):
            cls = _lamp_class(o)
        elif src == 'Carbon':
            cls = ['Black' if slot in AERO else 'Paint'] * len(o.data.polygons)
        elif src == 'Misc' and slot == 'exhaust':
            cls = ['Chrome'] * len(o.data.polygons)   # the pipes and tips
        elif src not in MATS:
            raise KeyError(f'{name}: no class for {src}')
        else:
            cls = [MATS[src]] * len(o.data.polygons)
        if src == 'Windowwrap':
            cls = [c if k else None for c, k in zip(cls, _alpha_keep(o))]
        tmp = bmesh.new()
        tmp.from_mesh(o.data)
        tmp.transform(M @ o.matrix_world)
        if (M @ o.matrix_world).determinant() < 0:
            bmesh.ops.reverse_faces(tmp, faces=tmp.faces)
        tmp.faces.ensure_lookup_table()
        drop = [f for f, c in zip(tmp.faces, cls) if c is None]
        for f, c in zip(tmp.faces, cls):
            if c is not None:
                if c not in names:
                    names.append(c)
                f.material_index = names.index(c)
        bmesh.ops.delete(tmp, geom=drop, context='FACES')
        me = bpy.data.meshes.new('tmp')
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for n in names:
        me.materials.append(shared_mat(n))
    ob = bpy.data.objects.new(name, me)
    coll(cname).objects.link(ob)
    return ob


def exhaust_tip(o):
    """The center of an exhaust's tip in glTF car space (x, z, -y): its vertices within 4 cm of
    its rearmost one. Every exhaust in the catalog ends in one tip (the twin pipes are stacked),
    the stock car's count, so the game's flames follow the part."""
    vs = [v.co for v in o.data.vertices]
    y_end = max(v.y for v in vs)
    tail = [v for v in vs if v.y > y_end - 0.04]
    c = sum(tail, Vector()) / len(tail)
    return [round(c.x, 3), round(c.z, 3), round(-y_end, 3)]


def _join(objs, name):
    """Join objects into the first, renamed."""
    keep = objs[0]
    for o in objs[1:]:
        bm = bmesh.new()
        bm.from_mesh(keep.data)
        off = len(keep.data.materials)
        for m in o.data.materials:
            keep.data.materials.append(m)
        other = o.data.copy()
        for p in other.polygons:
            p.material_index += off
        bm.from_mesh(other)
        bm.to_mesh(keep.data)
        bm.free()
        bpy.data.meshes.remove(other)
        bpy.data.objects.remove(o)
    keep.name = name
    keep.data.name = name
    remap_materials(keep)
    return keep


def zenith(root):
    """Build tachibanaZenith:Car|Parts|Rig from the import (replacing any earlier build)."""
    root = bpy.data.objects[root] if isinstance(root, str) else root
    for c in ('Car', 'Parts', 'Rig'):
        cl = bpy.data.collections.get(f'{CID}:{c}')
        if cl:
            for o in list(cl.objects):
                bpy.data.objects.remove(o)
    car, parts_c, rig = f'{CID}:Car', f'{CID}:Parts', f'{CID}:Rig'
    parts = _parts(root)

    body = [_piece(n, f'{CID}.{s}_{v}', car, 'body') for (s, v), n in parts.items()
            if s in BODY and (v is None or v.startswith('Stock') or s in ('Base', 'Interior'))]
    cabin = next(o for o in body if o.name.startswith(f'{CID}.Interior'))
    _collapse(cabin, INTERIOR_BUDGET)
    _join(body, f'{CID}.Body')

    built = {}
    for (s, v), n in sorted(parts.items(), key=lambda kv: (kv[0][0], kv[0][1] or '')):
        if s not in SLOTS or (s, v) in SKIP or s == 'Rearfender':
            continue
        slot, node = SLOTS[s]
        side = re.match(r'^(.+)_(Left|Right)$', v)
        kit = side.group(1) if side else v
        if kit == 'Stock':
            if node is None:
                continue
            o = _piece(n, f'{CID}.{node}_{v}', car, slot)
        else:
            o = _piece(n, f'{CID}.{slot}_{kit.lower()}_{v}', parts_c, slot)
        built.setdefault((slot, kit, node if kit == 'Stock' else None), []).append(o)
        if s == 'Fender':
            rear = FENDER_REAR.get(kit, 'Stock')
            r = _piece(parts[('Rearfender', rear)], f'{CID}.rear_{kit}', car if kit == 'Stock' else parts_c, slot)
            built[(slot, kit, node if kit == 'Stock' else None)].append(r)

    coll(f'{CID}:Wheels')   # the Zenith rides on the shared wheel set; the exporter wants the collection
    for (slot, kit, node), objs in built.items():
        if kit == 'Stock':
            _join(objs, f'{CID}.{node}')
        else:
            label = NAMES[slot][kit]
            o = _join(objs, f'{CID}.{slot}_{re.sub(r"[^a-z0-9]", "", label.lower())}')
            o['displayName'] = label
            if slot == 'spoiler':
                o['hides'] = 'Spoiler'
    # The garage lists a slot's parts in the collection's order, cheapest first (NAMES' order).
    pc = coll(parts_c)
    rank = {f'{CID}.{slot}_{re.sub(r"[^a-z0-9]", "", label.lower())}': (i, j)
            for i, slot in enumerate(NAMES) for j, label in enumerate(NAMES[slot].values())}
    for o in sorted(pc.objects, key=lambda o: rank[o.name]):
        pc.objects.unlink(o)
        pc.objects.link(o)

    for o in list(coll(car).objects) + list(coll(parts_c).objects):
        # The textures' orange (the bumper indicators) reads red to lamp_colour; at the nose it is amber.
        recolor(o, lambda c, n, m: m == 'TailLight' and c.y < -1.0, 'Light')
        # The headlamps' projector bowls, bright in the texture, are what lights.
        recolor(o, lambda c, n, m: m == 'Chrome' and c.y < -1.5 and c.z > 0.55 and 0.3 < abs(c.x) < 0.78, 'HeadLight')
        remap_materials(o)
        # The donor is a clean game mesh, so the cull takes little (830 of the body's 20,806); a
        # piece still over its slot's budget (the widebody fenders, the Ridox skirts and wing) is
        # collapsed to it with the donor pipeline's simplifier.
        cull_hidden(o)
        slot = 'body' if o.name == f'{CID}.Body' else o.name.split('.', 1)[1].split('_')[0]
        budget = TRI_BUDGETS.get(slot)
        if budget and tris(o) > budget:
            before = tris(o)
            _collapse(o, budget)
            print(f'{o.name}: collapsed {before} -> {tris(o)}')
    for o in coll(parts_c).objects:
        if '.exhaust_' in o.name:
            o['exhaustTips'] = json.dumps([exhaust_tip(o)])
    print('stock exhaust tip (manifest exhaustTips):', exhaust_tip(bpy.data.objects[f'{CID}.Exhaust']))
    for k, x, y in (('FL', 1, -1), ('FR', -1, -1), ('RL', 1, 1), ('RR', -1, 1)):
        e = bpy.data.objects.new(f'{CID}.Wheel_{k}', None)
        e.location = (x * TRACK / 2, y * WHEELBASE / 2, WHEEL_R)
        coll(rig).objects.link(e)
    for c in (car, parts_c):
        print(c, [(o.name.split('.', 1)[1], tris(o)) for o in coll(c).objects])
