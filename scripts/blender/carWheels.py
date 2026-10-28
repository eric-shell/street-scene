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
colour), the ring `Chrome` on a bolted (multi-piece) wheel and `Rim` on a one-piece, bolts and
caps `Chrome`, the tire `Tire`; a source material named black stays `Black`.

Wheel space (exportCar.py): center at the origin, axle along X, the face toward +X. The game
scales a wheel so the tire's outer radius meets the car's wheel radius and remaps the wheel for
the size slider from where the Tire mesh meets the rest (src/render/car/wheelFit.ts).
"""
import re

TIRE_R = 0.28        # m, house tire outer radius (standardWheel)
TIRE_W = 0.24        # m, house tire width
BEAD = 0.74          # wheel lip radius / tire radius: a 16 inch wheel on a 0.28 m tire
TIRE_SEG = 40        # segments around the house tire (960 triangles)
X_LIP = TIRE_W * 0.45      # m, where the lip edge sits: just proud of the tire's bead (TIRE_W * 0.42)
X_BACK = -TIRE_W * 0.5     # m, where the barrel ends: the tire's back bead
BUDGETS = {'face': 6000, 'ring': 2400, 'cap': 700}   # triangles per kind after the collapse (the ring's is for the pre-cull collapse; it is turned afterwards)
RING_SEG = 56        # segments around the turned lip and barrel (a 40-gon shows on a chrome lip up close)
RING_BANDS = 26      # profile points sampled along the lip's visible surface
BOLT_SEG = 6         # hex heads
BOLT_MAX = 48        # more peaks than this on a bolt circle is a knurl, not bolts
WELD = 2e-5          # m, vertices closer than this (in the import's 0.65 m scale) are one

# Dropped from every wheel by material or object name: display scenes, branding, brakes, valves.
# Whole words only: `MaterialStandart` is a wheel and `GLTF_SceneRootNode` holds everything.
JUNK = r'(?i)(?<![a-z])(stand|ground|plane|shadow|floor|backdrop|logo|badge|emblem|decal|brake|caliper|calliper|disc|disk|rotor|valve)(?![a-z])'

# The garage groups wheels by the real maker of their donor, under a fictional maker name (real
# wheel makers' names never ship): the maker as the donor's title leads with it -> the group.
GROUPS = {'Work': 'Kaito', 'Rotiform': 'Mizuchi', 'Vossen': 'Seiryu', 'HRE': 'Byakko', 'Fifteen52': 'Hotaru',
          'SSR': 'Hiryu', 'BBS': 'Suzaku', 'Volk': 'Genbu'}

# Every donor is jonver87's (CC BY 4.0): clean showpiece models without tires, each piece its own
# mesh. Recipe fields: `maker` the donor's real maker (a key of GROUPS), `face` 1 / -1 forces the
# face direction when the normal vote gets it wrong, `lip` 'chrome' / 'rim' overrides the ring's
# finish (chrome on a multi-piece wheel, the wheel colour on a one-piece), `drop` a regex of
# material or object names to drop, `bolts` 0 to keep no bolt circle, `normals` 'geometry' to
# shade the face from its own shape when the donor's normals are wrong.
_J = {'author': 'jonver87', 'license': 'CC Attribution'}
WHEELS = {
    'kumo': {'name': 'Work VS-TX', 'uid': '31c76095a0754cb1b08591d63973a2c2', 'maker': 'Work', **_J},
    'yari': {'name': 'Work Equip 03', 'uid': '13c021b58f2b4c42ac747feb5457750b', 'maker': 'Work', **_J},
    'tsume': {'name': 'Work Equip 40', 'uid': 'ac9b1a3ffbd8400a9b364d0596fdcc56', 'maker': 'Work', **_J},
    'hari': {'name': 'Work Emitz', 'uid': '0dd4b490ee624aeda867cd5ccfe530e6', 'maker': 'Work', **_J},
    'kasumi': {'name': 'Work VS-KF', 'uid': 'f762ae9a968d4971a9c4c61922310e44', 'maker': 'Work', **_J},
    'raiden': {'name': 'Work VS-XV', 'uid': 'bb47f6dd1ab6406289c59e3c0a86be38', 'maker': 'Work', **_J},
    'ryusei': {'name': 'Work VS-XX', 'uid': '6a1c8ab8df444530a2a0ac93487cf3bd', 'maker': 'Work', **_J,
               'face': -1},   # its badge sits behind the hub's center, so the badge rule turned it round
    'shinobi': {'name': 'Work Zistance W5S', 'uid': '8a80d5dd27384671bb1beef04234f3db', 'maker': 'Work', **_J},
    'tsurugi': {'name': 'Work Schwert SC2', 'uid': '054f59d1321e41aebeffa272d4b7f863', 'maker': 'Work', **_J},
    'kaze': {'name': 'Work Equip 02', 'uid': '57f0fcea45df47188bc8531a012d3357', 'maker': 'Work', **_J,
             'lip': 'chrome'},   # a polished dish
    'hagane': {'name': 'Work Euroline DH', 'uid': 'eab967f5fcab4581bd427ddf6b79da52', 'maker': 'Work', **_J},
    'kagero': {'name': 'Work Import Label AL4', 'uid': '593aed74677d49ff953e068debce4b87', 'maker': 'Work', **_J,
               'lip': 'chrome'},
    'gekko': {'name': 'Work LS Chiarezza SUV', 'uid': '3134884d8ecf45c9817cf5e1d231734b', 'maker': 'Work', **_J,
              'bolts': 0},   # its rivets sit in pairs in the windows: the histogram read three bolts
    'nami': {'name': 'Rotiform ZMO', 'uid': '4193e4cd0fdc481688e3a437e4e5d130', 'maker': 'Rotiform', **_J},
    'shizuku': {'name': 'Rotiform Aerodisc', 'uid': 'ccaf76b4b4514d1e9b6351a628e75817', 'maker': 'Rotiform', **_J},
    'uzu': {'name': 'Rotiform VCE', 'uid': '05783beda2a74aa8981fb374e9088b4f', 'maker': 'Rotiform', **_J},
    'kawa': {'name': 'Rotiform SIX', 'uid': '35d0043f1c774ddfaa7c3983eb3bc8c0', 'maker': 'Rotiform', **_J},
    'taki': {'name': 'Rotiform AVS', 'uid': 'cdb62e8166e64cf58fafed97348733b1', 'maker': 'Rotiform', **_J},
    'minato': {'name': 'Rotiform KB1', 'uid': 'c6c9212941fd4a3182566141ea2caa10', 'maker': 'Rotiform', **_J},
    'kiri': {'name': 'Rotiform USF', 'uid': 'af96ede3c79849e0967017c7af56e1c4', 'maker': 'Rotiform', **_J},
    'shio': {'name': 'Rotiform MLW', 'uid': '7dbcd9ba45dc4ff3b53b2eb3822ec5bc', 'maker': 'Rotiform', **_J},
    'ame': {'name': 'Rotiform OZR', 'uid': '72e5ee8f6e6b46799c00f732f414d41f', 'maker': 'Rotiform', **_J},
    'yuki': {'name': 'Rotiform BM1', 'uid': 'abb6a1de9bd54492baff6843cad8a429', 'maker': 'Rotiform', **_J},
    'shigure': {'name': 'Rotiform WRO', 'uid': 'd64d8d4fab944a77a6fba680551a7e67', 'maker': 'Rotiform', **_J},
    'umi': {'name': 'Rotiform CCV', 'uid': '827bfe4138d447c28888c6c22a47609b', 'maker': 'Rotiform', **_J},
    'hyo': {'name': 'Rotiform LHR', 'uid': '89a4f55b4d164153863a8f1350aa7786', 'maker': 'Rotiform', **_J},
    'tsuyu': {'name': 'Rotiform LSR', 'uid': '1fe207f311bb4b50b0cf4d3fbbe549b2', 'maker': 'Rotiform', **_J},
    'kori': {'name': 'Rotiform KLU', 'uid': '641a37e731194b3e8fdd18e6a9b1e6d9', 'maker': 'Rotiform', **_J},
    'mio': {'name': 'Rotiform SNA', 'uid': '20dad53c5f1947cf92f113f3c2e7c2fe', 'maker': 'Rotiform', **_J},
    'fubuki': {'name': 'Rotiform KPS', 'uid': 'c3ffecfad22d4a3a808123bac5187479', 'maker': 'Rotiform', **_J},
    'seseragi': {'name': 'Rotiform PNT', 'uid': 'cee8b459137249e5bcfa8289d5c2759c', 'maker': 'Rotiform', **_J},
    'aoi': {'name': 'Vossen LC104T', 'uid': 'aa0f85f015d741a5958dc70fea79d863', 'maker': 'Vossen', **_J},
    'sora': {'name': 'Vossen LC109T', 'uid': '3fe9676878634ec183068252cb2d52fd', 'maker': 'Vossen', **_J},
    'hikari': {'name': 'Vossen VPS302', 'uid': 'ba0fafb1c9b545328948ad716a8b5747', 'maker': 'Vossen', **_J},
    'kagami': {'name': 'Vossen VPS301', 'uid': '4bfa99c33ba94cd08dfcf3cd53d1cd2d', 'maker': 'Vossen', **_J},
    'seiun': {'name': 'Vossen ERA3', 'uid': 'b5cffbf62f77419897de89413427d33d', 'maker': 'Vossen', **_J},
    'getsuei': {'name': 'Vossen GNS-1', 'uid': '7e9cf35d7dfd4ab083febc646a19746a', 'maker': 'Vossen', **_J},
    'kirameki': {'name': 'Vossen VPS 315T', 'uid': '9479e07055a14102ae8efb3b8658f9da', 'maker': 'Vossen', **_J},
    'hisui': {'name': 'Vossen CG203', 'uid': '38b5f76123a0461cb82b8616b734ac5f', 'maker': 'Vossen', **_J},
    'tora': {'name': 'HRE P200', 'uid': '7221bc7c423e401f83712d56e435a813', 'maker': 'HRE', **_J},
    'tsuchi': {'name': 'Fifteen52 Rally Sport', 'uid': '1ed9ad4cbe5644ae831fe95bae84a0fc', 'maker': 'Fifteen52', **_J},
    'homura': {'name': 'SSR Koenig', 'uid': '391ab57dc25a4aa69771fbb9114f3d40', 'maker': 'SSR', **_J},
    'hane': {'name': 'BBS E52', 'uid': '8168cc3dce114b19b617c17fea0ab364', 'maker': 'BBS', **_J,
             'normals': 'geometry'},   # its mesh's authored normals lean sideways: the face shaded dark
    'iwa': {'name': 'Volk Rays 21C', 'uid': 'd053af8f24bc4a5dbaf9d21f31ae25da', 'maker': 'Volk', **_J},
}


def _rad(co):
    return math.hypot(co.y, co.z)


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
        if o.type != 'MESH' or not o.data.polygons or any(re.search(JUNK, n) for n in below) or (R.get('drop') and any(re.search(R['drop'], n) for n in below)):
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
    back to being face). Returns the groups, frontmost first."""
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
    """House bolts: a hex head (top and sides, 18 triangles) at each angle of the circle."""
    angles, r, h, base, top = circle
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    for a in angles:
        cy, cz = r * math.cos(a), r * math.sin(a)
        ring_t = [bm.verts.new((top, cy + h * math.cos(a + 2 * math.pi * k / BOLT_SEG), cz + h * math.sin(a + 2 * math.pi * k / BOLT_SEG))) for k in range(BOLT_SEG)]
        ring_b = [bm.verts.new((base, cy + h * math.cos(a + 2 * math.pi * k / BOLT_SEG), cz + h * math.sin(a + 2 * math.pi * k / BOLT_SEG))) for k in range(BOLT_SEG)]
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


def _dish_share(isl, L, sectors=36, band=0.02):
    """Where a one-piece wheel stops being a full ring (lip and dish wall) and becomes its spoked
    or slotted face, as a share of the lip radius: walking in from the lip, the first radial band
    whose front-facing faces do not cover every angular sector."""
    cover = {}
    for i in isl:
        if i.kind != 'face':
            continue
        for f in i.faces:
            if f.normal.x < 0.3:
                continue
            c = f.calc_center_median()
            cover.setdefault(int(_rad(c) / L / band), set()).add(int((math.atan2(c.z, c.y) + math.pi) / (2 * math.pi) * sectors) % sectors)
    b = int(0.99 / band)
    while b > int(0.5 / band) and len(cover.get(b - 1, ())) == sectors:
        b -= 1
    return max(0.5, min(0.95, b * band))


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
    little past the bore, its face at `x`, just proud of the hub's front."""
    seg = 24
    own = bm.faces.layers.int.get('own_normals') or bm.faces.layers.int.new('own_normals')
    c = bm.verts.new((x, 0, 0))
    ring = [bm.verts.new((x, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg))) for k in range(seg)]
    back = [bm.verts.new((x - 0.004, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg))) for k in range(seg)]
    for k in range(seg):
        for f in (bm.faces.new((c, ring[k], ring[(k + 1) % seg])), bm.faces.new((back[k], back[(k + 1) % seg], ring[(k + 1) % seg], ring[k]))):
            f.material_index = mat
            f[own] = 1
            f.smooth = len(f.verts) == 4
            f.normal_update()
            want = Vector((1, 0, 0)) if len(f.verts) == 3 else Vector((0, f.calc_center_median().y, f.calc_center_median().z))
            if f.normal.dot(want) < 0:
                f.normal_flip()


def _ring_profile(o, L):
    """The lip and barrel's visible surface as (x, r) points from the lip edge inward and back,
    measured on the culled ring: every face center sorted by its angle from a viewpoint in front
    of the wheel (what the front sees along one ray is one point of the profile, so the order is
    the surface's own, steps and all), binned into RING_BANDS and area averaged. The outer barrel,
    which the tire hides, is left out. The inner barrel behind the face stays and runs on to the
    tire's back bead: it shows between the spokes and from behind, and a wheel cut off at its
    face reads as a thin disc in a hollow tire."""
    me = o.data
    P = Vector((0.25, 0.3 * L))
    pts = []
    for p in me.polygons:
        c = p.center
        r = _rad(c)
        radial = Vector((0, c.y, c.z)).normalized()
        if r > 0.95 * L and p.normal.dot(radial) > 0.5 and c.x < X_LIP - 0.004:
            continue   # the outer barrel: the tire hides it
        q = Vector((c.x, r))
        pts.append((math.atan2(q.y - P.y, q.x - P.x), p.area, q))
    if len(pts) < 4:
        return None
    pts.sort(key=lambda t: t[0])
    a0, a1 = pts[0][0], pts[-1][0]
    bins = [[] for _ in range(RING_BANDS)]
    for a, w, q in pts:
        bins[min(RING_BANDS - 1, int((a - a0) / (a1 - a0 + 1e-9) * RING_BANDS))].append((w, q))
    total = sum(w for _, w, _ in pts)
    prof = []
    for b in bins:
        w = sum(x for x, _ in b)
        if w > 0.002 * total:
            prof.append(sum((q * x for x, q in b), Vector((0, 0))) / w)
    edge = max(prof, key=lambda q: q.y)
    prof.insert(0, Vector((edge.x - 0.015, L)))
    # The cull leaves little of the barrel behind a dense face, so it is carried on at its last
    # radius to the back, then out to the tire's bead: the wheel is as wide as its tire.
    if prof[-1].x > X_BACK + 0.005:
        prof.append(Vector((X_BACK, prof[-1].y)))
    prof.append(Vector((X_BACK, max(prof[-1].y, L - 0.004))))
    return prof


def _lathe(bm, prof, mat, seg=RING_SEG):
    """A surface of revolution through the (x, r) profile about the axle, smooth, its normals in
    `src_normal` (toward the viewpoint side of the profile). Returns the faces made."""
    sn = bm.loops.layers.float_vector.get('src_normal') or bm.loops.layers.float_vector.new('src_normal')
    P = len(prof)
    n2 = []
    for k in range(P):
        a, b = prof[max(0, k - 1)], prof[min(P - 1, k + 1)]
        t = (b - a).normalized()
        n = Vector((t.y, -t.x))
        # Toward the front viewpoint: the side the dish is seen from.
        if n.dot(Vector((0.25, 0.3 * prof[0].y)) - prof[k]) < 0:
            n = -n
        n2.append(n)
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        rings.append([bm.verts.new((q.x, q.y * math.cos(a), q.y * math.sin(a))) for q in prof])
    made = []
    for i in range(seg):
        a, b = rings[i], rings[(i + 1) % seg]
        ca, sa = math.cos(2 * math.pi * i / seg), math.sin(2 * math.pi * i / seg)
        cb, sb = math.cos(2 * math.pi * (i + 1) / seg), math.sin(2 * math.pi * (i + 1) / seg)
        for k in range(P - 1):
            f = bm.faces.new((a[k], a[k + 1], b[k + 1], b[k]))
            f.material_index = mat
            f.smooth = True
            for l, (nk, c, s_) in zip(f.loops, ((n2[k], ca, sa), (n2[k + 1], ca, sa), (n2[k + 1], cb, sb), (n2[k], cb, sb))):
                l[sn] = Vector((nk.x, nk.y * c, nk.y * s_))
            made.append(f)
    bm.normal_update()
    for f in made:
        if f.normal.dot(f.loops[0][sn]) < 0:
            f.normal_flip()
    return made


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
    lip = R0.get('lip', 'rim' if one_piece else 'chrome')   # multi-piece lips are polished, a monoblock is one finish
    dish = _dish_share(isl, L) if one_piece else 1.0
    for i in isl:
        for f in i.faces:
            src = names[f.material_index] if f.material_index < len(names) else ''
            kind = i.kind
            # A one-piece wheel's lip, dish and barrel are its face's own outer faces: turned like a ring.
            if one_piece and kind == 'face' and all(_rad(v.co) > dish * L for v in f.verts):
                kind = 'ring'
            f.material_index = IDX['Black'] if re.search(r'(?i)black', src) and kind == 'face' else IDX['Chrome'] if kind == 'cap' or (kind == 'ring' and lip == 'chrome') else IDX['Rim']
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
    ring_prof = None
    for kind, o in parts.items():
        if kind == 'ring':
            ring_prof = _ring_profile(o, L)
            if ring_prof:
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
        _lathe(obm, ring_prof, IDX['Chrome'] if lip == 'chrome' else IDX['Rim'])
    if circle:
        _hex_heads(obm, IDX['Chrome'], circle)
    if cap_r:
        _house_cap(obm, IDX['Chrome'], cap_r, cap_x)
    house_tire(obm, IDX['Tire'])
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
    o['displayName'] = name.capitalize()
    o['group'] = GROUPS[R0['maker']]
    print(f'wheel_{name}: {R0["name"]} ({R0["author"]}); islands {kinds}; face {"+" if sign > 0 else "-"}X, scaled x{k:.3f}, '
          f'barrel squeezed x{squeeze:.2f}, lip {lip}' + (f' turned from {len(ring_prof)} points' if ring_prof else '') + ', ' + (f'{len(circle[0])} house bolts at r {circle[1]:.3f}' if circle else 'no bolt circle') +
          (f', house cap r {cap_r:.3f}' if cap_r else '') + f'; {src_tris} -> {tris(o)} tris ({culled} hidden culled, {gone["bolt"]} of bolts and {gone["decal"]} of decals replaced)')
    return o


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
