"""
Helpers for car modelling through the Blender MCP server (or `blender -b --python`).

The MCP's execute_blender_code keeps no state between calls, so load this at
the top of every call instead of redefining helpers:

    REPO = '/path/to/street-scene'; exec(open(REPO + '/scripts/blender/carKit.py').read())

Everything works in Blender space: meters, Z up, car facing -Y, +X the car's
left, origin on the ground midway between the axles (glTF car space after the
exporter's +Y up conversion). See .claude/skills/blender/SKILL.md.
"""
import math
import os

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_point_line

REPO = globals().get('REPO') or os.getcwd()
SHARED = ['Paint', 'Trim', 'Black', 'Chrome', 'Glass', 'Rim', 'Tire', 'HeadLight', 'TailLight', 'Light', 'Interior', 'Grille', 'RimLip', 'RimCap', 'Lens', 'Reflector', 'BrakeLight', 'ClearLens', 'Strap', 'RedLens', 'SmokeLens', 'BlueLens', 'GreenLens', 'YellowLens', 'BrakeLens']
# Every lamp material: only HeadLight, TailLight and BrakeLight (under braking) glow in the game; Light (amber indicators and markers),
# Reflector (red), RedLens, SmokeLens and the Blue, Green and Yellow lenses (a coloured lamp's shaded insides) and Lens (the clear covers, see-through) are unlit lenses (src/shared/parts.ts).
LAMP_MATS = ('HeadLight', 'TailLight', 'BrakeLight', 'Light', 'Lens', 'Reflector', 'ClearLens', 'RedLens', 'SmokeLens', 'BlueLens', 'GreenLens', 'YellowLens', 'BrakeLens')


# ----- scene ---------------------------------------------------------------

def coll(name):
    """Get or create a top level collection."""
    c = bpy.data.collections.get(name)
    if not c:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def bake(o, extra=None):
    """Bake the world matrix (and an optional extra matrix applied after it) into the mesh; identity transform after."""
    m = o.matrix_world.copy()
    if extra is not None:
        m = extra @ m
    if o.type == 'MESH':
        o.data.transform(m)
        if m.determinant() < 0:
            o.data.flip_normals()
        o.data.update()
    o.matrix_world = Matrix.Identity(4)


def imp(path, cname):
    """Import a GLB (repo relative) into a collection with transforms baked.
    Meshopt files import fine but carry their quantization as a node scale; baking removes it."""
    c = coll(cname)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(REPO, path))
    new = list(set(bpy.data.objects) - before)
    for o in new:
        for uc in list(o.users_collection):
            uc.objects.unlink(o)
        c.objects.link(o)
        bake(o)
    return new


def bb(o):
    """World bounds from the vertices (o.bound_box is stale right after mesh.transform())."""
    mw = o.matrix_world
    pts = [mw @ v.co for v in o.data.vertices] if o.type == 'MESH' else [mw.translation]
    return (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
            Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))))


def fmt(v):
    return '(' + ', '.join(f'{x:.3f}' for x in v) + ')'


def show(only=None):
    """Show only the named top level collections (all when None)."""
    for lc in bpy.context.view_layer.layer_collection.children:
        lc.hide_viewport = only is not None and lc.name not in only


def clear():
    """Empty the working file (objects, collections, orphan meshes and materials)."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    for m in list(bpy.data.meshes):
        if not m.users:
            bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials):
        if not m.users:
            bpy.data.materials.remove(m)


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


# ----- materials -----------------------------------------------------------

def shared_mat(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
    return m


def remap_materials(o):
    """Point every face at the shared material of its name (Paint.003 -> Paint) and drop unused slots.
    mesh.materials.clear() resets every face's material_index to 0, so face names are read first."""
    me = o.data
    face_mat = [me.materials[p.material_index].name.split('.')[0] for p in me.polygons]
    names = []
    for n in face_mat:
        if n not in SHARED:
            raise ValueError(f'{o.name}: material {n} is not in the shared vocabulary')
        if n not in names:
            names.append(n)
    me.materials.clear()
    for n in names:
        me.materials.append(shared_mat(n))
    idx = {n: i for i, n in enumerate(names)}
    for p, n in zip(me.polygons, face_mat):
        p.material_index = idx[n]
    me.update()


def material_regions(o):
    """Per material: face count and the bounds of face centers. The quickest way to find a hood, roof or lights."""
    me = o.data
    out = {}
    for p in me.polygons:
        n = me.materials[p.material_index].name.split('.')[0]
        c = p.center
        r = out.setdefault(n, [0, Vector(c), Vector(c)])
        r[0] += 1
        r[1] = Vector(map(min, r[1], c))
        r[2] = Vector(map(max, r[2], c))
    for n, (k, mn, mx) in out.items():
        print(f'{o.name} {n}: {k} faces {fmt(mn)} .. {fmt(mx)}')
    return out


# ----- splitting -----------------------------------------------------------

def cut(o, planes):
    """Bisect o's mesh with planes [(co, no)] or [(co, no, within)], keeping both sides, so later
    splits follow clean seams. `within(face center)` limits a plane to the faces it should cut: a
    plane is infinite, and on a dense donor mesh a hood seam would otherwise slice the whole car."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for plane in planes:
        co, no = plane[:2]
        within = plane[2] if len(plane) > 2 else None
        if within is None:
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        else:
            faces = [f for f in bm.faces if within(f.calc_center_median())]
            geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=Vector(co), plane_no=Vector(no))
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def split_parts(src, base_name, rules):
    """Copy src as base_name, then move faces into new objects by rules
    [(name, predicate(face_center, material_name))], first match wins. Returns {name: obj, 'Body': base}."""
    out = {}
    o = src.copy()
    o.data = src.data.copy()
    o.name = base_name
    src.users_collection[0].objects.link(o)
    for name, pred in rules:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        sel = [f for f in bm.faces if pred(f.calc_center_median(), o.data.materials[f.material_index].name.split('.')[0])]
        if not sel:
            bm.free()
            continue
        part = o.copy()
        part.data = o.data.copy()
        part.name = name
        o.users_collection[0].objects.link(part)
        keep = {f.index for f in sel}
        bmesh.ops.delete(bm, geom=sel, context='FACES')
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()
        bm2 = bmesh.new()
        bm2.from_mesh(part.data)
        bm2.faces.ensure_lookup_table()
        bmesh.ops.delete(bm2, geom=[f for f in bm2.faces if f.index not in keep], context='FACES')
        bm2.to_mesh(part.data)
        bm2.free()
        part.data.update()
        out[name] = part
    out['Body'] = o
    return out


def islands(o):
    """Loose face islands: [(faces, min, max, {material: faces})]. Kitbashed meshes have dozens that cross part lines."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    seen, out = set(), []
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
        vs = [v.co for g in grp for v in g.verts]
        mats = {}
        for g in grp:
            n = o.data.materials[g.material_index].name.split('.')[0]
            mats[n] = mats.get(n, 0) + 1
        out.append((len(grp), Vector(map(min, *vs)) if len(vs) > 1 else vs[0], Vector(map(max, *vs)) if len(vs) > 1 else vs[0], mats))
    bm.free()
    return sorted(out, key=lambda t: -t[0])


def delete_islands(o, pred):
    """Delete loose face islands for which pred(faces, min, max, {material: faces}) is true (lips,
    splitters, strakes and other bolt-ons are usually their own islands). Returns how many went."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
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
        vs = [v.co for g in grp for v in g.verts]
        mats = {}
        for g in grp:
            k = o.data.materials[g.material_index].name.split('.')[0]
            mats[k] = mats.get(k, 0) + 1
        if pred(len(grp), Vector(map(min, *vs)), Vector(map(max, *vs)), mats):
            doomed += grp
            n += 1
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return n


# ----- seams ---------------------------------------------------------------

def plane_seam(planes, tol=2e-3):
    """Seam predicate: the point lies on one of the axis planes [(axis, value)] the part was cut with."""
    return lambda p: any(abs(p[a] - v) < tol for a, v in planes)


def _seam_segments(o, on_seam):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    segs = [(e.verts[0].co.copy(), e.verts[1].co.copy()) for e in bm.edges if e.is_boundary and on_seam(e.verts[0].co) and on_seam(e.verts[1].co)]
    bm.free()
    return segs


def _nearest(segs, p):
    best, bd = None, 1e9
    for a, b in segs:
        q, t = intersect_point_line(p, a, b)
        q = a if t < 0 else b if t > 1 else q
        d = (q - p).length
        if d < bd:
            best, bd = q, d
    return best, bd


def seam_snap(alt, stock, on_seam, radius=0.15, max_move=0.08, report_only=False):
    """Fit a donor part to the base body: move alt's seam vertices onto stock's seam (the opening
    the stock part closes) and drag vertices within `radius` along with a smoothstep falloff.
    Returns (seam verts in reach, mean gap, max gap) measured before moving. Run twice with a
    larger max_move for stragglers; check max gap with report_only and max_move=1."""
    segs = _seam_segments(stock, on_seam)
    bm = bmesh.new()
    bm.from_mesh(alt.data)
    disp = []
    for v in bm.verts:
        if on_seam(v.co):
            q, d = _nearest(segs, v.co)
            if d <= max_move:
                disp.append((v.co.copy(), q - v.co))
    ds = [d.length for _, d in disp]
    stats = (len(disp), sum(ds) / max(len(ds), 1), max(ds) if ds else 0)
    if not report_only and disp:
        for v in bm.verts:
            near = sorted(disp, key=lambda pd: (pd[0] - v.co).length)[:4]
            dmin = (near[0][0] - v.co).length
            if dmin > radius:
                continue
            ws = [1 / max((p - v.co).length, 1e-4) for p, _ in near]
            dv = sum((d * w for (_, d), w in zip(near, ws)), Vector()) / sum(ws)
            f = 1 - dmin / radius
            v.co += dv * (f * f * (3 - 2 * f))
        bm.to_mesh(alt.data)
        alt.data.update()
    bm.free()
    return stats


def arch_gap(o, x, axle_y, r):
    """Clearance (m) between a tire of radius r at (±x, ±axle_y) and the arch above it, front and rear.
    Negative means the tire pokes through the arch lip."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    t = BVHTree.FromBMesh(bm)
    res = []
    for y in (-axle_y, axle_y):
        hits = [h[0].z for dx in (x - 0.1, x, x + 0.08) for dy in (-0.05, 0, 0.05)
                for h in [t.ray_cast(Vector((dx, y + dy, r)), Vector((0, 0, 1)))] if h[0]]
        res.append(round(min(hits) - 2 * r, 3) if hits else None)
    bm.free()
    return res


# ----- new parts from stock ------------------------------------------------
# A new bumper or skirt starts as a copy of the stock piece (so it fits the body opening
# exactly), is reshaped with displacements that fade to zero at the seam, and gets new
# geometry (splitters, fins, blades) appended to the same mesh.

def copy_part(src_name, name, cname):
    s = bpy.data.objects[src_name]
    o = s.copy()
    o.data = s.data.copy()
    o.name = name
    o.data.name = name
    coll(cname).objects.link(o)
    o.hide_set(False)
    return o


def seam_weight(o, on_seam, radius):
    """Per vertex weight: 0 on the seam, smoothstep to 1 at `radius` meters from it."""
    seam = [v.co.copy() for v in o.data.vertices if on_seam(v.co)]
    out = []
    for v in o.data.vertices:
        d = min(((s - v.co).length for s in seam), default=radius)
        f = min(d / radius, 1)
        out.append(f * f * (3 - 2 * f))
    return out


def displace(o, fn, on_seam, radius=0.12):
    """Move every vertex by fn(co) (a Vector), scaled by its seam weight, so the seam never moves."""
    w = seam_weight(o, on_seam, radius)
    for v, k in zip(o.data.vertices, w):
        v.co += fn(v.co.copy()) * k
    o.data.update()


LINER_LIFT = 0.03   # m of air between the tire's crown and the wheel well's liner: inside the house arch gap (docs/carDesign.md, 0.01 to 0.04)


def lift_liners(o, wheels, r, lift=LINER_LIFT, reach=0.22):
    """Raise wheel well liners that sit on or through the tire to clear it by `lift` (the Proto
    Wagon's rear liners were 1 mm over the crown, an arch gap of -0.019). Every vertex of a liner
    face (not Paint, Glass, Trim, Chrome or a lamp, facing the axle from above, within `reach` of
    the wheel's centre plane) is moved straight up to the crown plus `lift`, stopping 1 cm under
    whatever the body has above it (hood, fender top, floor), so the liner hugs the panel rather
    than poke through it. Vertices the lip shares (any skin face) stay, so the arch opening keeps
    its shape. A lowered stance no longer needs the room: the game clips the tire at the outer skin
    under the fender, not at the liner (render/car/wheelClip.ts). `wheels`: (x, y) of each axle
    end, `r` the tire radius; Blender space. Returns the number of vertices moved."""
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    skin = {'Paint', 'Glass', 'Trim', 'Chrome', *LAMP_MATS}
    liner = set()
    for p in me.polygons:
        if names[p.material_index] in skin:
            continue
        c = p.center
        for wx, wy in wheels:
            if abs(c.x - wx) < reach and abs(c.y - wy) < r + 0.1 and c.z > r - 0.05 and p.normal.z < -0.2:
                liner.add(p.index)
                break
    if not liner:
        return 0
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [list(p.vertices) for p in me.polygons if p.index not in liner])
    pinned = {i for p in me.polygons if names[p.material_index] in skin for i in p.vertices}
    moved = 0
    for i in {i for pi in liner for i in me.polygons[pi].vertices} - pinned:
        v = me.vertices[i]
        for wx, wy in wheels:
            if abs(v.co.x - wx) >= reach or abs(v.co.y - wy) >= r:
                continue
            crown = r + math.sqrt(max(0.0, r * r - (v.co.y - wy) ** 2))
            want = crown + lift
            if v.co.z >= want:
                continue
            hit = tree.ray_cast(v.co + Vector((0, 0, 0.002)), Vector((0, 0, 1)))
            cap = hit[0].z - 0.01 if hit[0] else want
            z = min(want, cap)
            if z > v.co.z + 1e-4:
                v.co.z = z
                moved += 1
            break
    me.update()
    return moved


def shrink_arches(objs, axles, center_z, radius, by, reach=0.12, min_x=0.5):
    """Pull the wheel arches of a donor body in toward the wheel by `by` meters: outboard vertices
    (|x| > min_x) in the upper half of each arch move radially toward (axle_y, center_z), fully
    within the arch lip (`radius` from the center) and fading out `reach` beyond it, so a body made for a bigger tire fits the
    house wheel without moving its sills. Apply the same call to every mesh so seams stay closed."""
    for o in objs:
        me = o.data
        for v in me.vertices:
            c = v.co
            if abs(c.x) < min_x or c.z < center_z - 0.1:
                continue
            for ay in axles:
                d = math.hypot(c.y - ay, c.z - center_z)
                lip = max(d - radius, 0)
                w = max(0.0, 1 - lip / reach) * min(1.0, (c.z - (center_z - 0.1)) / 0.1)
                if w > 0 and d > 1e-6:
                    k = by * w / d
                    c.y -= (c.y - ay) * k
                    c.z -= (c.z - center_z) * k
        me.update()


def boundary_seam(o, tol=1e-4):
    """Seam predicate from o's own open edges: for panels cut out by selection (hood, roof) rather
    than by axis planes. Pass the stock piece; copies keep the same boundary coordinates."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    keys = {tuple(round(c / tol) for c in v.co) for v in bm.verts if v.is_boundary}
    bm.free()
    return lambda p: tuple(round(c / tol) for c in p) in keys


def surface_z(o):
    """Height of o's surface at (x, y), by ray casting down onto its mesh (None off the mesh)."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    tree = BVHTree.FromBMesh(bm)  # bm stays alive in the closure with the tree

    def at(x, y):
        hit = tree.ray_cast(Vector((x, y, 5)), Vector((0, 0, -1)))
        return hit[0].z if hit[0] else None
    return at


def mat_index(o, name):
    names = [m.name.split('.')[0] for m in o.data.materials]
    if name in names:
        return names.index(name)
    o.data.materials.append(shared_mat(name))
    return len(o.data.materials) - 1


def recolor(o, pred, name):
    """Set faces matching pred(center, normal, material_name) to the shared material `name`."""
    me = o.data
    i = mat_index(o, name)
    n = 0
    for p in me.polygons:
        if pred(p.center, p.normal, me.materials[p.material_index].name.split('.')[0]):
            p.material_index = i
            n += 1
    me.update()
    return n


def outline(o, axis, extreme, along, samples, band):
    """Silhouette of o's vertices with band(co) true: for each value in samples along `along`
    (0 x, 1 y), the extreme (min or max) coordinate on `axis`. Gaps borrow the nearest sample."""
    pts = [v.co for v in o.data.vertices if band(v.co)]
    step = abs(samples[1] - samples[0]) if len(samples) > 1 else 0.1
    out = []
    for s in samples:
        near = [p[axis] for p in pts if abs(p[along] - s) <= step * 0.75]
        out.append(extreme(near) if near else None)
    for i, v in enumerate(out):
        if v is None:
            j = min((j for j in range(len(out)) if out[j] is not None), key=lambda j: abs(j - i))
            out[i] = out[j]
    return out


def add_geom(o, verts, faces, name, outward=None):
    """Append polygons (local vertex indices) to o's mesh with material `name`. Closed shapes get
    consistent outside normals; open patches pass `outward` (the side they are seen from), and
    `outward='keep'` keeps the winding as given (a transplanted cabin)."""
    i = mat_index(o, name)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    vs = [bm.verts.new(Vector(v)) for v in verts]
    made = []
    for f in faces:
        try:
            nf = bm.faces.new([vs[k] for k in f])
        except ValueError:  # degenerate (repeated vertex) faces are skipped
            continue
        nf.material_index = i
        made.append(nf)
    if outward is None:
        bmesh.ops.recalc_face_normals(bm, faces=made)
    elif outward != 'keep':
        for f in made:
            f.normal_update()
            if f.normal.dot(Vector(outward)) < 0:
                f.normal_flip()
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def surface_tree(objs):
    """One BVH over several meshes (world space)."""
    verts, polys = [], []
    for ob in objs:
        base = len(verts)
        mw = ob.matrix_world
        verts += [mw @ v.co for v in ob.data.vertices]
        polys += [[base + i for i in p.vertices] for p in ob.data.polygons]
    return BVHTree.FromPolygons(verts, polys)


def projected_quad(o, corners, axis, toward, offset, name, nu=8, nv=3, target=None, max_jump=0.12, tree=None):
    """Lay a patch on o's surface (lights, grilles, housings): corners are four (u, v) points
    of a quad in the plane across `axis` ('y': (x, z), 'x': (y, z), 'z': (x, y) from above with
    toward -1), in order around the quad.
    Rays travel along the axis in direction `toward` (+1 / -1) from outside the car; each grid
    point lands on the first hit, lifted `offset` meters back toward the ray origin. Cells with
    a corner that misses are skipped. target: objects to ray cast against (default [o]); the
    patch is still added to o, so lights on a body can follow a hood and bumper around them.
    Grid points whose hit is more than max_jump meters off the median depth are dropped.
    tree: a prebuilt surface_tree, so layers laid in one pass (housing, lens) all measure their
    offset from the bare surface instead of landing on each other."""
    tree = tree or surface_tree(target or [o])
    axes = {'x': (Vector((toward, 0, 0)), lambda u, v: Vector((-5 * toward, u, v))),
            'y': (Vector((0, toward, 0)), lambda u, v: Vector((u, -5 * toward, v))),
            'z': (Vector((0, 0, toward)), lambda u, v: Vector((u, v, -5 * toward)))}
    d, origin_at = axes[axis]
    (a, b, c, e) = [Vector(p) for p in corners]
    grid = []
    for j in range(nv + 1):
        row = []
        t = j / nv
        for i in range(nu + 1):
            s = i / nu
            uv = (a * (1 - s) + b * s) * (1 - t) + (e * (1 - s) + c * s) * t
            origin = origin_at(uv.x, uv.y)
            hit = tree.ray_cast(origin, d)
            row.append((hit[0] - d * offset, hit[3]) if hit[0] else None)
        grid.append(row)
    # A ray that slips past the panel's edge hits something deep inside the car; drop those.
    depths = sorted(p[1] for row in grid for p in row if p)
    if depths:
        med = depths[len(depths) // 2]
        grid = [[tuple(p[0]) if p and abs(p[1] - med) < max_jump else None for p in row] for row in grid]
    verts, faces, index = [], [], {}
    for j in range(nv):
        for i in range(nu):
            q = [(j, i), (j, i + 1), (j + 1, i + 1), (j + 1, i)]
            if any(grid[y][x] is None for y, x in q):
                continue
            ids = []
            for y, x in q:
                if (y, x) not in index:
                    index[(y, x)] = len(verts)
                    verts.append(grid[y][x])
                ids.append(index[(y, x)])
            faces.append(ids)
    if faces:
        add_geom(o, verts, faces, name, outward=-d)
    return len(faces)


def project_polygon(o, pts, axis, toward, offset, name, target=None, tree=None, max_jump=0.12, cell=0.06):
    """Lay a convex polygon [(u, v)] on the surface as a fan of projected_quad cells around its
    centroid (lamp covers, round lamps, indicator blocks). Concave shapes go in as several
    convex polygons. Returns the number of cells made. Every cell casts against one tree built
    before the first is added (or `tree`); otherwise each cell lands on the last one's offset.
    max_jump as in projected_quad; a lamp whose outer end wraps onto the fender needs more.
    Each fan cell is cut into a grid of about `cell` meters, or a flat cell sinks into a curved panel."""
    tree = tree or surface_tree(target or [o])
    n = len(pts)
    cu = sum(p[0] for p in pts) / n
    cv = sum(p[1] for p in pts) / n
    made = 0
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        nu = max(1, math.ceil(math.dist(a, b) / cell))
        nv = max(1, math.ceil(max(math.dist(a, (cu, cv)), math.dist(b, (cu, cv))) / cell))
        made += projected_quad(o, [a, b, (cu, cv), (cu, cv)], axis, toward, offset, name, nu=nu, nv=nv, tree=tree, max_jump=max_jump)
    return made


def delete_faces(o, pred):
    """Delete the faces for which pred(center, normal, material_name) is true. Returns how many."""
    me = o.data
    doomed = [p.index for p in me.polygons if pred(p.center, p.normal, me.materials[p.material_index].name.split('.')[0])]
    if doomed:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in doomed], context='FACES')
        bm.to_mesh(me)
        bm.free()
        me.update()
    return len(doomed)


def groove_z(o, origin, direction, z0, z1, step=0.002, span=3):
    """The height of a shut line crossing a vertical scan: rays along `direction` from (origin.x, origin.y, z)
    for z in z0..z1, and the z whose hit lies deepest against the mean of its neighbours `span` steps
    either side. Returns (z, depth m) or None. A donor body's bumper seam is a modelled groove 3 to 40 mm
    deep (the Wendt Strom: 36 mm under the grille, 12 under the lamps, 4 along the sides); cutting the stock
    bumper there keeps the panel line the car already has instead of inventing one at a round number."""
    from mathutils.bvhtree import BVHTree
    t = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())
    d = Vector(direction).normalized()
    zs = [z0 + i * step for i in range(int((z1 - z0) / step) + 1)]
    ds = [(lambda h: h[3] if h[0] else None)(t.ray_cast(Vector((origin[0], origin[1], z)), d, 5)) for z in zs]
    best = None
    for i in range(span, len(zs) - span):
        if None in ds[i - span:i + span + 1]:
            continue
        bump = ds[i] - 0.5 * (ds[i - span] + ds[i + span])
        if best is None or bump > best[1]:
            best = (zs[i], bump)
    return best


def stash_normals(o):
    """Copy a piece's custom normals into its `src_normal` corner attribute before a bmesh edit (bmesh
    drops custom normals, a generic attribute survives and is interpolated on cuts). Returns whether there
    was anything to carry: only pieces with `authored_normals` (donor bodies and what is cut from them)."""
    me = o.data
    if not (o.get('authored_normals') and me.has_custom_normals):
        return False
    sn = me.attributes.get('src_normal') or me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER')
    sn.data.foreach_set('vector', [x for c in me.corner_normals for x in c.vector])
    return True


def restore_normals(o):
    """Set the custom normals back from `src_normal` and drop it. Corners the edit made without one (a
    zero vector) take their face's normal, so new geometry is flat shaded unless its builder wrote its own."""
    me = o.data
    s = me.attributes.get('src_normal')
    if s is None:
        return
    vs = [Vector(v.vector) for v in s.data]
    for p in me.polygons:
        for li in p.loop_indices:
            if vs[li].length < 1e-6:
                vs[li] = p.normal.copy()
    me.normals_split_custom_set([v.normalized() for v in vs])
    me.attributes.remove(s)
    o['authored_normals'] = me.has_custom_normals


def round_lamp(o, center, normal, r_lens, r_bezel, proud=0.02, lens='HeadLight', bezel='Chrome', wall='Black', segments=24):
    """A round lamp set into a panel or an intake (fog lamps, a bumper's driving lamps): a `wall` cup from
    5 mm behind `center` out to `proud` m along `normal`, a flat `bezel` ring on its face and a `lens` disc
    3 mm back inside it. `center` is the point on the panel behind the lamp and `normal` the way the lamp
    looks. Writes its own corner normals into `src_normal` when the piece carries them (stash_normals), the
    cup radial and the face flat. Round lamps are built, never collapsed (docs/carDonors.md, Lamps): about
    six triangles a segment."""
    n = Vector(normal).normalized()
    u = n.cross(Vector((0, 0, 1))).normalized()
    w = u.cross(n)
    c = Vector(center)
    ring = lambda base, r: [base + (u * math.cos(2 * math.pi * i / segments) + w * math.sin(2 * math.pi * i / segments)) * r for i in range(segments)]
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    mw, mb, ml = mat_index(o, wall), mat_index(o, bezel), mat_index(o, lens)
    back = [bm.verts.new(p) for p in ring(c - n * 0.005, r_bezel)]
    front = [bm.verts.new(p) for p in ring(c + n * proud, r_bezel)]
    inner = [bm.verts.new(p) for p in ring(c + n * proud, r_lens)]
    lens_rim = [bm.verts.new(p) for p in ring(c + n * (proud - 0.003), r_lens)]
    hub = bm.verts.new(c + n * (proud - 0.003))

    def face(vs, mat, facing, loop_normal=None):
        f = bm.faces.new(vs)
        f.material_index = mat
        f.smooth = True
        f.normal_update()
        if f.normal.dot(facing) < 0:
            f.normal_flip()
        if sn is not None:
            for loop in f.loops:
                loop[sn] = loop_normal(loop.vert.co) if loop_normal else n
        return f

    radial = lambda p: (p - c - n * (p - c).dot(n)).normalized()
    for i in range(segments):
        j = (i + 1) % segments
        mid = (front[i].co + front[j].co) / 2 - c
        face([back[i], back[j], front[j], front[i]], mw, mid - n * mid.dot(n), radial)
        face([front[i], front[j], inner[j], inner[i]], mb, n)
        mid = (inner[i].co + inner[j].co) / 2 - c
        face([inner[i], inner[j], lens_rim[j], lens_rim[i]], mb, -(mid - n * mid.dot(n)))
        face([hub, lens_rim[i], lens_rim[j]], ml, n)
    bm.to_mesh(me)
    bm.free()
    me.update()


FRESNEL = ((1.0, 0.0), (0.80, 0.0012), (0.80, 0.0030), (0.60, 0.0018), (0.60, 0.0036), (0.40, 0.0024),
           (0.40, 0.0042), (0.20, 0.0030), (0.20, 0.0060))


def lamp_insert(o, center, r, kind='fresnel', mat='Chrome', ring='Chrome', segments=32, bulge=0.3, inner=0.8, wall=0.0):
    """A round face set into a headlamp's bowl, looking along -y, its back at `center` (x, y, z): `fresnel`
    a reflector of stepped rings (`FRESNEL`: radius share, m toward the eye) with a bulb tip in the middle, all
    `mat` (the Wendt Strom's lower centre lamp, whose donor face had collapsed into black and chrome
    triangles; the E-Code's clear fluted indicator); `projector` a domed lens of `mat` (`SmokeLens` reads
    as dark glass) inside a flat `ring` from `inner` r out to r, bulging `bulge` r toward the eye (the E-Code's
    fog projector; the OEM HIDs' amber lenses at 0.08, a lens over a backing). A free standing disc a millimetre
    ahead of whatever face it covers, so nothing behind it is cut; `wall` m of `ring` barrel behind its edge
    when it stands further out (the OEM HIDs' stacked pair), so it does not float seen through the cover's side.
    Returns the faces made."""
    cx, cy, cz = center
    bm = bmesh.new()
    bm.from_mesh(o.data)
    sn = bm.loops.layers.float_vector.get('src_normal')
    mm, mr = mat_index(o, mat), mat_index(o, ring)
    circle = lambda t, dy: [bm.verts.new((cx + math.cos(2 * math.pi * k / segments) * r * t, cy - dy,
                                          cz + math.sin(2 * math.pi * k / segments) * r * t)) for k in range(segments)]
    if kind == 'fresnel':
        rings = [(circle(t, dy), mm) for t, dy in FRESNEL]
        tip = (bm.verts.new((cx, cy - 0.0085, cz)), mm)
    else:
        # The ring, then the dome on a sine profile: 4 rows to a bulge of 0.3 r.
        rings = [(circle(1.0, 0.0005), mr), (circle(inner, 0.0005), mr)]
        rings += [(circle(inner * math.cos(a), 0.0005 + bulge * r * math.sin(a)), mm) for a in (0.45, 0.85, 1.2)]
        tip = (bm.verts.new((cx, cy - 0.0005 - bulge * r, cz)), mm)
    if wall:
        rings.insert(0, (circle(1.0, -wall), mr))
    made = []
    for (a, _), (b, m) in zip(rings, rings[1:]):
        for k in range(segments):
            j = (k + 1) % segments
            made.append((bm.faces.new((a[k], a[j], b[j], b[k])), m))
    last = rings[-1][0]
    for k in range(segments):
        made.append((bm.faces.new((last[k], last[(k + 1) % segments], tip[0])), tip[1]))
    c = Vector(center)
    for f, m in made:
        f.material_index = m
        f.normal_update()
        # Toward the eye (-y); the steps' walls outward from the axis.
        out = f.calc_center_median() - c
        out.y = 0
        if (f.normal.y > 1e-3) or (abs(f.normal.y) <= 1e-3 and f.normal.dot(out) < 0):
            f.normal_flip()
        if sn is not None:
            for loop in f.loops:
                loop[sn] = f.normal
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return len(made)


def halo_ring(o, center, r, width=0.005, depth=0.004, mat='HeadLight', segments=40, y_at=None):
    """An angel eye: a lit ring looking along -y, its front face at `center` (x, y, z), `width` m across at radius
    `r`, with walls `depth` m back on both edges (open behind, where the bowl hides it), so it reads as a tube
    from an angle as well as head on (the Wendt Strom's Sex Spec lamps: one at the same diameter in each bowl).
    `y_at(x, z)` sets the front face's y round the ring instead (one per segment angle), so it can follow a bowl's
    rim that stands further forward on one side. Six triangles a segment. Returns the faces made."""
    cx, cy, cz = center
    bm = bmesh.new()
    bm.from_mesh(o.data)
    sn = bm.loops.layers.float_vector.get('src_normal')
    mi = mat_index(o, mat)
    front = [y_at(cx + math.cos(2 * math.pi * k / segments) * r, cz + math.sin(2 * math.pi * k / segments) * r) if y_at else cy
             for k in range(segments)]
    ring = lambda rr, dy: [bm.verts.new((cx + math.cos(2 * math.pi * k / segments) * rr, front[k] + dy,
                                         cz + math.sin(2 * math.pi * k / segments) * rr)) for k in range(segments)]
    ob, of = ring(r + width / 2, depth), ring(r + width / 2, 0)
    inf, ib = ring(r - width / 2, 0), ring(r - width / 2, depth)
    made = 0
    for k in range(segments):
        j = (k + 1) % segments
        mid = Vector((math.cos(2 * math.pi * (k + 0.5) / segments), 0, math.sin(2 * math.pi * (k + 0.5) / segments)))
        for vs, facing in (((ob[k], ob[j], of[j], of[k]), mid), ((of[k], of[j], inf[j], inf[k]), Vector((0, -1, 0))),
                           ((inf[k], inf[j], ib[j], ib[k]), -mid)):
            f = bm.faces.new(vs)
            f.material_index = mi
            f.normal_update()
            if f.normal.dot(facing) < 0:
                f.normal_flip()
            if sn is not None:
                for loop in f.loops:
                    loop[sn] = facing
            made += 1
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return made


def lower_edge(o, center, angles, z0, z1, step=0.005):
    """A bumper's bottom edge round the nose, for lips and splitters that follow it from arch to arch:
    for each angle (degrees about `center` in plan, 0 toward -y, + toward +x) the outermost point the
    rays find between z0 and z1, the underside's height just inside it (a ray up from 3 cm in), then
    the face's own bottom edge: a plan ray 4 mm above the underside. Returns [(Vector x, y, z_under)]
    in angle order; an angle with no hit is skipped. The last step matters: a bumper's lower face
    curves back under the car, and the outermost point sits 3 to 4 cm up that curve; a lip pinned to
    it stood out under the face with a 3 to 8 cm gap over its front edge (the Wendt Strom's Cupra R).
    Plan rays from behind the bumper, not an x sweep: the edge turns back along the sides to the
    arches, where a sweep along x samples it edge on (tunerKits' `outline` + `slab` stops at the corners)."""
    from mathutils.bvhtree import BVHTree
    t = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())
    c = Vector((center[0], center[1], 0))
    out = []
    for a in angles:
        th = math.radians(a)
        d = Vector((math.sin(th), -math.cos(th), 0))
        best = None
        for i in range(int((z1 - z0) / step) + 1):
            z = z0 + i * step
            h = t.ray_cast(c + d * 3 + Vector((0, 0, z)), -d, 3)
            if h[0] and (best is None or (h[0] - c).to_2d().length > (best - c).to_2d().length):
                best = h[0].copy()
        if best is None:
            continue
        inside = best - d * 0.03
        up = t.ray_cast(Vector((inside.x, inside.y, z0 - 0.2)), Vector((0, 0, 1)), 0.5)
        zu = up[0].z if up[0] else z0
        bottom = t.ray_cast(c + d * 3 + Vector((0, 0, zu + 0.004)), -d, 3)
        edge = bottom[0] if bottom[0] and (bottom[0] - c).to_2d().length <= (best - c).to_2d().length else best
        out.append(Vector((edge.x, edge.y, zu)))
    return out


def sweep(o, sections, name, outward=None):
    """A closed profile run along a path: `sections` are equal length point lists (one per station,
    in order round the profile), joined side by side into quads and capped at both ends. Each side
    is smooth along the path and sharp at the profile's corners: its corner normals are written into
    `src_normal` when the piece carries authored normals (stash_normals first), otherwise the faces are
    smooth with sharp profile edges marked. Sides face out by the profile's own winding round the path,
    so an L or a lipped profile (a splitter with its air dam, a canard with an end lip) comes out
    right; facing away from the section's centroid, the first rule, turned a concave profile's inner
    faces inside out. Lips, blades, rubbing strips."""
    k = len(sections[0])
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    mi = mat_index(o, name)
    vs = [[bm.verts.new(Vector(p)) for p in sec] for sec in sections]
    cent = [sum((Vector(p) for p in sec), Vector()) / k for sec in sections]
    n = len(sections)
    tangent = [(cent[min(i + 1, n - 1)] - cent[max(i - 1, 0)]).normalized() for i in range(n)]

    def winding(i):
        """+1 when the section runs counterclockwise seen along the path (Newell's normal), else -1."""
        sec = [Vector(p) for p in sections[i]]
        nw = Vector()
        for a, b in zip(sec, sec[1:] + sec[:1]):
            nw += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        return 1 if nw.dot(tangent[i]) > 0 else -1

    wind = [winding(i) for i in range(n)]

    def side_normal(i, s):
        a, b = Vector(sections[i][s]), Vector(sections[i][(s + 1) % k])
        return ((b - a).cross(tangent[i]) * wind[i]).normalized()

    for i in range(n - 1):
        for s in range(k):
            f = bm.faces.new([vs[i][s], vs[i + 1][s], vs[i + 1][(s + 1) % k], vs[i][(s + 1) % k]])
            f.material_index = mi
            f.smooth = True
            f.normal_update()
            if f.normal.dot(side_normal(i, s) + side_normal(i + 1, s)) < 0:
                f.normal_flip()
            if sn is not None:
                for loop in f.loops:
                    j = i if loop.vert in vs[i] else i + 1
                    loop[sn] = side_normal(j, s)
    for i, sign in ((0, -1), (n - 1, 1)):
        f = bm.faces.new(vs[i])
        f.material_index = mi
        f.smooth = False
        f.normal_update()
        if f.normal.dot(tangent[i] * sign) < 0:
            f.normal_flip()
        if sn is not None:
            for loop in f.loops:
                loop[sn] = f.normal.copy()
    bm.to_mesh(me)
    bm.free()
    me.update()


def _sstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def bumper_lip(src, target, center=(0, -1.55), angles=None, band=(0.165, 0.235), gap=0.015, plate=0.008,
               centre=0.28, rise=0.40, proud=(0.035, 0.020, 0.005), tuck=(0.050, 0.025), tip=(70, 12),
               chamfer=0.012, posts=12.0, post_size=(0.014, 0.025), material='Black'):
    """A chin lip under a front bumper, swept along its bottom edge from arch to arch into `target`
    (a copy of `src`, the part it goes on). The defaults are the Wendt Strom's Cupra R as shipped, the
    shape five rounds of the user's photos settled (.claude/skills/parts, Lessons):
    - a flat bottom at one height all the way round (a lip's bottom is one line);
    - under the centre grille (|x| < `centre`) a `plate` m plate hanging `gap` m clear of the bumper,
      `proud[0]` ahead of its edge and `tuck[0]` under it, on two posts (`posts` degrees either side,
      `post_size` wide and deep), which is how the real one mounts ("cut the two centre posts");
    - from `centre` to `rise` the top climbs to the bumper's underside, so outboard of the centre grille
      the lip is full depth from the bumper to the flat bottom, `proud[1]` ahead, with a 45 degree
      `chamfer` on its top front edge;
    - past `tip` (start, span in degrees) proud and depth run out to `proud[2]` at the wheel well.
    The +x half is traced (`lower_edge`) and mirrored: a donor's two sides differ by 2 to 3 cm at the
    arches. Carries authored normals (stash_normals / restore_normals). Returns the sections, so a tweak
    can be measured before it is looked at."""
    if angles is None:
        angles = [0, 4, 8, 12, 16, 20, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 79, 82]
    E = lower_edge(src, center, angles, *band)
    E = [Vector((-e.x, e.y, e.z)) for e in reversed(E[1:])] + E
    A = [-a for a in reversed(angles[1:])] + list(angles)
    zc = E[A.index(0)].z
    zb = zc - gap - plate
    secs = []
    for i, (e, a) in enumerate(zip(E, A)):
        p, q = E[max(i - 1, 0)].to_2d(), E[min(i + 1, len(E) - 1)].to_2d()
        tg = (q - p).normalized()
        n = Vector((tg.y, -tg.x))
        if n.dot(e.to_2d() - Vector(center)) < 0:
            n = -n
        r = _sstep((abs(e.x) - centre) / (rise - centre))
        t = _sstep((abs(a) - tip[0]) / tip[1])
        top = max((zc - gap) * (1 - r) + e.z * r, zb + 0.003)
        ext = (proud[0] * (1 - r) + proud[1] * r) * (1 - t) + proud[2] * t
        tk = tuck[0] * (1 - r) + tuck[1] * r
        ch = 0.0015 + (chamfer - 0.0015) * r * (1 - t)     # every station keeps 5 points: 1.5 mm where flat
        chz = min(ch, (top - zb) * 0.45)
        n3 = Vector((n.x, n.y, 0))
        secs.append([tuple(Vector((e.x, e.y, top + 0.002)) - n3 * tk),
                     tuple(Vector((e.x, e.y, top - 0.002)) + n3 * (ext - ch)),
                     tuple(Vector((e.x, e.y, top - 0.002 - chz)) + n3 * ext),
                     tuple(Vector((e.x, e.y, zb)) + n3 * (ext - 0.002)),
                     tuple(Vector((e.x, e.y, zb)) - n3 * tk)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if posts:
        w, d = post_size
        for e in lower_edge(src, center, [-posts, posts], *band):
            box(target, (e.x - w / 2, e.y, e.z - gap + 0.001), (e.x + w / 2, e.y + d, e.z + 0.004), material)
    if carry:
        restore_normals(target)
    return secs


def section_cut(o, z, x, y_back, skin_y=None):
    """A sectioned rear bumper: remove everything below the straight line z between |x| < x (the line
    joining the tops of the exhaust notches; the Wendt Strom's rims top out at z 0.338, so 0.34) and
    close the skin's cut edge with a black return running in to a straight back edge at y_back.
    Every face with a vertex on each side of the line is bisected (a face-centre test skipped a big
    face and left a vertex hanging), and a vertex still below the line inside the span afterwards
    (a notch rim vertex owned by faces centred outboard) is snapped up onto it. The return is one
    strip through the cut edge's points sorted by x: built per boundary edge it left gaps that hung
    fins. `skin_y` picks the outer skin's edge from inner panels (default: 6 cm in from the rearmost
    point on the line). Returns the skin edge points."""
    carry = stash_normals(o)
    me = o.data
    black = [m.name.split('.')[0] for m in me.materials].index('Black')
    bm = bmesh.new()
    bm.from_mesh(me)
    cross = [f for f in bm.faces if min(v.co.z for v in f.verts) < z < max(v.co.z for v in f.verts)
             and min(abs(v.co.x) for v in f.verts) < x + 0.02]
    geom = list({v for f in cross for v in f.verts}) + list({e for f in cross for e in f.edges}) + cross
    bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=Vector((0, 0, z)), plane_no=Vector((0, 0, 1)))
    gone = [f for f in bm.faces if f.calc_center_median().z < z and abs(f.calc_center_median().x) < x]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    snapped = [v for v in bm.verts if v.link_faces and abs(v.co.x) < x - 0.002 and z - 0.02 < v.co.z < z - 1e-4]
    for v in snapped:
        v.co.z = z
    bm.edges.ensure_lookup_table()
    on = [e for e in bm.edges if e.is_boundary and all(abs(v.co.z - z) < 2e-4 and abs(v.co.x) <= x + 1e-3 for v in e.verts)]
    if skin_y is None:
        skin_y = max(v.co.y for e in on for v in e.verts) - 0.06
    line = []
    for v in sorted({v for e in on for v in e.verts if v.co.y > skin_y}, key=lambda v: v.co.x):
        if line and abs(v.co.x - line[-1].co.x) < 0.004:
            if v.co.y > line[-1].co.y:
                line[-1] = v
        else:
            line.append(v)
    for v in snapped:   # out onto the cut edge, between the edge points either side
        for a, b in zip(line, line[1:]):
            if a.co.x <= v.co.x <= b.co.x and v not in (a, b):
                v.co.y = (a.co.y + b.co.y) / 2
    backs = [bm.verts.new((v.co.x, y_back, z)) for v in line]
    for a, b, ba, bb_ in zip(line, line[1:], backs, backs[1:]):
        f = bm.faces.new((a, b, bb_, ba))
        f.normal_update()
        if f.normal.z > 0:
            f.normal_flip()
        f.material_index = black
    edge = [v.co.copy() for v in line]
    bm.to_mesh(me)
    bm.free()
    me.update()
    if carry:
        restore_normals(o)
    return edge


def punch_holes(o, holes, r, depth=0.015, sides=16, wall='Black', back='Black', skin=0.012, stretch=0.0, along='z'):
    """Real round holes through a panel (speed holes, vents): for each (center, normal), `center` on the
    surface and `normal` pointing out of it, the faces round it are cut along a `sides`-gon of radius r
    (one bisect per side, limited to faces within `skin` of the surface and near the hole, so the
    inside of the bumper is never sliced), the faces inside are deleted, the opening's edge is run
    `depth` m inward as a `wall` and capped with a `back` (the black mesh a real hole shows). A real
    opening rather than a black disc on the paint: from the garage's three-quarter a disc reads as a
    sticker. `stretch` m turns each circle into a stadium: its halves pushed apart that far either way
    along `along` ('z' an upright oval, 'x' a slot: two neighbouring holes merged, the paint between them
    taken out, as on the Wendt Strom's Track Wild). Carries authored normals
    (the cut faces keep theirs, the wall is radial, the back flat). Returns the faces added."""
    carry = stash_normals(o)
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    mw, mb = mat_index(o, wall), mat_index(o, back)
    added = 0
    for center, normal in holes:
        c, n = Vector(center), Vector(normal).normalized()
        u = n.cross(Vector((0, 0, 1))).normalized()
        w = u.cross(n)
        if along == 'x':
            u, w = w, u
        ring = [c + (u * math.cos(2 * math.pi * i / sides) + w * math.sin(2 * math.pi * i / sides)) * r for i in range(sides)]
        if stretch:
            # The straight sides: the points at 0 and 180 degrees each split into a top and a bottom.
            ring = ([c + u * r + w * stretch] + [c + (u * math.cos(2 * math.pi * i / sides) + w * math.sin(2 * math.pi * i / sides)) * r + w * stretch
                                                 for i in range(1, sides // 2)]
                    + [c - u * r + w * stretch, c - u * r - w * stretch]
                    + [c + (u * math.cos(2 * math.pi * i / sides) + w * math.sin(2 * math.pi * i / sides)) * r - w * stretch
                       for i in range(sides // 2 + 1, sides)] + [c + u * r - w * stretch])
        R = r + stretch
        radial = lambda p: (p - c) - n * (p - c).dot(n)

        def seg_dist(a, b):
            a, b = radial(a), radial(b)
            ab = b - a
            k = 0.0 if ab.length_squared < 1e-12 else max(0.0, min(1.0, -a.dot(ab) / ab.length_squared))
            return (a + ab * k).length

        # Near the hole: on the surface (within `skin` of it) and with an edge passing within 1.3 r of the
        # axis. Testing the centre or the corners missed the reduced mesh's long slivers that cross a
        # hole with every corner outside it, and those holes stayed half covered.
        def near(f):
            if abs((f.calc_center_median() - c).dot(n)) >= skin:
                return False
            return radial(f.calc_center_median()).length < R * 1.3 or any(seg_dist(e.verts[0].co, e.verts[1].co) < R * 1.3 for e in f.edges)
        planes = [(ring[i], (ring[(i + 1) % len(ring)] - ring[i]).cross(n).normalized()) for i in range(len(ring))]
        # Two passes: a piece made by one side's cut can touch the next side's line only at a corner
        # and slip through it; the second pass catches it (one pass left notches at the openings' tops).
        for _ in range(2):
            for co, no in planes:
                faces = [f for f in bm.faces if near(f)]
                geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
                bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
        # Outward plane normals point away from the centre: a corner is inside when it is behind every side.
        planes = [(co, no if no.dot(co - c) > 0 else -no) for co, no in planes]
        in_poly = lambda p: all((p - co).dot(no) < 1e-4 for co, no in planes)
        doomed = [f for f in bm.faces if near(f) and all(in_poly(v.co) for v in f.verts)]
        bmesh.ops.delete(bm, geom=doomed, context='FACES')
        edges = [e for e in bm.edges if e.is_boundary and all(abs((v.co - c).dot(n)) < skin and in_poly(v.co) for v in e.verts)]
        ext = bmesh.ops.extrude_edge_only(bm, edges=edges)
        new_verts = [g for g in ext['geom'] if isinstance(g, bmesh.types.BMVert)]
        new_edges = [g for g in ext['geom'] if isinstance(g, bmesh.types.BMEdge)]
        walls = [g for g in ext['geom'] if isinstance(g, bmesh.types.BMFace)]
        for v in new_verts:
            v.co -= n * depth
        for f in walls:
            f.material_index = mw
            f.smooth = True
            f.normal_update()
            mid = f.calc_center_median()
            if f.normal.dot(-radial(mid)) < 0:
                f.normal_flip()
            if sn is not None:
                for loop in f.loops:
                    loop[sn] = -radial(loop.vert.co).normalized()
        rim = [e for e in new_edges if e.is_boundary]
        cap = bmesh.ops.contextual_create(bm, geom=rim)['faces']
        for f in cap:
            f.material_index = mb
            f.smooth = False
            f.normal_update()
            if f.normal.dot(n) < 0:
                f.normal_flip()
            if sn is not None:
                for loop in f.loops:
                    loop[sn] = n
        added += len(walls) + len(cap)
        # The cut lines run on across every face near the hole; merge the flat slivers they leave
        # back into the faces they came from (a ten hole row doubled a 3,200 triangle bumper).
        region = [f for f in bm.faces if near(f) and f.material_index not in (mw, mb)]
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), use_dissolve_boundaries=False,
                                 verts=list({v for f in region for v in f.verts}),
                                 edges=list({e for f in region for e in f.edges}), delimit={'MATERIAL'})
    gaps = [e for e in bm.edges if e.is_boundary and any(
        abs((v.co - Vector(c)).dot(Vector(nn).normalized())) < skin and ((v.co - Vector(c)) - Vector(nn).normalized() * (v.co - Vector(c)).dot(Vector(nn).normalized())).length < (r + stretch) * 1.6
        for v in e.verts for c, nn in holes)]
    bm.to_mesh(me)
    bm.free()
    me.update()
    if carry:
        restore_normals(o)
    if gaps:
        print(f'punch_holes: {len(gaps)} open edges left round the holes')
    return added


def mirror_patch(o, x0, y1, src=-1, tol=0.0015):
    """Make a panel symmetric over a patch: the faces with |x| > x0 and y < y1 on the `src` side (-1 the
    car's right, the US passenger side) copied mirrored over the other side's, so a feature built once
    (the Boser Mild's brows) is the same both sides. Both sides are cut with the same two planes, the
    target's patch deleted and the mirrored copy put in. A donor panel is near symmetric in shape (the
    Wendt Strom's hood to 0.1 mm over its lamps) but not in triangulation, so the two cut edges cross
    the panel at different points: each side's cut edge is split at the other's points before the weld
    (`tol` m), leaving no crack. Carries authored normals (x negated on the copy). Returns the number of
    faces copied."""
    carry = stash_normals(o)
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    tgt = -src
    # Every face straddling a plane inside the other's range is cut: a test by corners near the plane
    # missed a sliver spanning 12 cm across it and left a crack.
    for sgn in (src, tgt):
        for co, no, side, rng in (((sgn * x0, 0, 0), (1, 0, 0), lambda c: c.x - sgn * x0, lambda c: c.y < y1 + 0.02),
                                  ((0, y1, 0), (0, 1, 0), lambda c: c.y - y1, lambda c: sgn * c.x > x0 - 0.02)):
            faces = [f for f in bm.faces if min(side(v.co) for v in f.verts) < -1e-6 < 1e-6 < max(side(v.co) for v in f.verts)
                     and any(rng(v.co) for v in f.verts)]
            geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co, plane_no=no)
    inside = lambda f, sgn: (lambda c: sgn * c.x > x0 and c.y < y1)(f.calc_center_median())
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if inside(f, tgt)], context='FACES')
    dup = bmesh.ops.duplicate(bm, geom=[f for f in bm.faces if inside(f, src)])
    nv = [g for g in dup['geom'] if isinstance(g, bmesh.types.BMVert)]
    nf = [g for g in dup['geom'] if isinstance(g, bmesh.types.BMFace)]
    for v in nv:
        v.co.x = -v.co.x
    if sn is not None:
        for f in nf:
            for lp in f.loops:
                lp[sn] = Vector((-lp[sn][0], lp[sn][1], lp[sn][2]))
    bmesh.ops.reverse_faces(bm, faces=nf)
    new = set(nv)
    on_cut = lambda v: v.is_boundary and ((abs(tgt * v.co.x - x0) < 1e-4 and v.co.y <= y1 + 1e-4)
                                          or (abs(v.co.y - y1) < 1e-4 and tgt * v.co.x >= x0 - 1e-4))
    # Each side's cut edge split at the other side's points, so the weld meets vertex to vertex.
    for mine, theirs in ((lambda v: v not in new, lambda v: v in new), (lambda v: v in new, lambda v: v not in new)):
        pts = [v.co.copy() for v in bm.verts if theirs(v) and on_cut(v)]
        for p in pts:
            for e in [e for e in bm.edges if e.is_boundary and all(mine(v) and on_cut(v) for v in e.verts)]:
                a, b = e.verts[0].co, e.verts[1].co
                ab = b - a
                k = (p - a).dot(ab) / max(ab.length_squared, 1e-12)
                if 0 < k < 1 and (a + ab * k - p).length < tol and min((p - a).length, (p - b).length) > tol:
                    ne, nv2 = bmesh.utils.edge_split(e, e.verts[0], k)
                    nv2.co = p
                    break
    bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if on_cut(v)], dist=tol)
    left = [e for e in bm.edges if e.is_boundary and all(on_cut(v) for v in e.verts)]
    if left:
        print(f'mirror_patch: {len(left)} cut edges left open')
    bm.to_mesh(me)
    bm.free()
    me.update()
    if carry:
        restore_normals(o)
    return len(nf)


def brow_to_line(o, a, c, behind, gap=0.002, rows=(0.08, 0.35, 0.65, 1.0), look=(0, 1, 0), a_line=None, c_line=None,
                 follow='lens', clearance=0.0005, roll=0.03, reach=0.25, blend=0.04, nose_x=0.25, push=True,
                 spread=0.03):
    """Carry a panel's open edge on to a straight line seen along `look` (from the front: (0, 1, 0)), the
    new skin lying `gap` m off whatever is behind it: a hood run on over the headlamps so their cut outs
    become a straight brow (the Wendt Strom's Boser Mild). `a` and `c` are the line's ends, snapped to the
    nearest vertices of o's open edge; the edge between them is walked (the shorter way round) and each
    of its vertices gets a column of points out to the line at the same share of the length (at the
    fractions `rows` of the way; the first close in, since the panel's edge sits on the lamp's trim
    and a wide first band from there dipped 3 mm into the lens's top corner), each
    cast along `look` onto `behind` (a list of objects) and lifted `gap` off the hit along its normal, so
    the skin follows the lamp's top a hair clear of the lens instead of cutting through it. The ends are
    shared (triangles there), so the new skin closes onto the panel without a seam, unless `a_line` or
    `c_line` puts the line's end off the edge (the Boser Mild's inner end at the lens's top corner, below
    where the user trimmed the hood's notch beside the grille: the end column then drops from the edge's
    last vertex to it, closing the gap the trim opened there). `follow='hood'` (what the user wanted:
    hugging the lens 2 mm off read as a depression in the hood) makes each column a smooth curve instead,
    leaving the panel's edge along the panel's own slope there and ending on the line where it meets the
    lamp's face, `clearance` in front of it, pushed forward only where the lamp would show in front of it,
    so the brow runs on from the OEM surface. `follow='plane'` goes one further (the user's knife edge):
    the panel's top surface behind its rolled lip (the band `roll` m from the edge, where a hood curls
    down into the lamp cut out) is fitted with a quadratic over `reach` m, the lip's vertices are lifted
    onto it (fading to nothing over `blend` m from the ends, which stay), and each column leaves along
    the fitted surface's slope, so the brow is the hood's own plane carried on, not a step down from
    it. `follow='nose'` is the one the user settled on after a Boser Wild reference (an ECS Mk4 whose
    hood runs down over the lamps): the hood's own front edge section above the grille carried sideways.
    The panel's profile at x = `nose_x` from its top plane down its nose to its front lip is read off
    the panel first (forward distance against drop, 1 mm steps); each column then finds the point on
    that profile with the panel's slope at its own edge vertex (the lamp cut out leaves the hood partway
    down the same roll) and continues along the profile from there until it has dropped to the line's
    height at that x, so the brow is the grille nose's curvature run on, ending in the same knife edge.
    Carries authored
    normals: the new skin smooth, its first row taking the panel's own normals. Returns the triangles
    added."""
    carry = stash_normals(o)
    me = o.data
    d = Vector(look).normalized()
    tree = surface_tree(behind)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    for f in bm.faces:
        f.tag = False
    sn = bm.loops.layers.float_vector.get('src_normal')
    edge = {v.index for e in bm.edges if e.is_boundary for v in e.verts}
    va = min(edge, key=lambda i: (bm.verts[i].co - Vector(a)).length)
    vc = min(edge, key=lambda i: (bm.verts[i].co - Vector(c)).length)
    nbr = {}
    for e in bm.edges:
        if e.is_boundary:
            i, j = e.verts[0].index, e.verts[1].index
            nbr.setdefault(i, []).append(j)
            nbr.setdefault(j, []).append(i)
    paths = []
    for first in nbr[va]:
        path, prev = [va, first], va
        for _ in range(len(edge)):
            if path[-1] == vc:
                break
            nxt = [j for j in nbr[path[-1]] if j != prev]
            if not nxt:
                break
            prev = path[-1]
            path.append(nxt[0])
        if path[-1] == vc:
            paths.append(path)
    if not paths:
        raise RuntimeError('brow_to_line: the ends are not on one open edge')
    path = [bm.verts[i] for i in min(paths, key=len)]
    lens = [0.0]
    for p, q in zip(path, path[1:]):
        lens.append(lens[-1] + (q.co - p.co).length)
    # The line between the ends' own positions, so it meets the panel's edge exactly there.
    A = Vector(a_line) if a_line else path[0].co.copy()
    C = Vector(c_line) if c_line else path[-1].co.copy()
    shut = (0.0 if not a_line else None, 1.0 if not c_line else None)
    def clear(p):
        """p cast along the view onto `behind` and lifted `gap` off it when it is not already in front."""
        hit = tree.ray_cast(p - d * 1.0, d, 2.0)
        # A ray passing over the lamp's top runs on into the cabin; only a hit within 3 cm behind p is
        # the surface p must clear. The normal turned toward the viewer: the Wendt Strom's lens covers
        # are wound inward.
        if not hit[0] or (hit[0] - p).dot(d) > 0.03:
            return p
        return hit[0] + hit[1].normalized() * (gap if hit[1].dot(d) < 0 else -gap)
    up = Vector((0, 0, 1)) - d * d.z
    up = up.normalized() if up.length > 1e-6 else d.orthogonal()
    def front(p):
        """p moved along the view to `clearance` in front of `behind` where that is in front of it."""
        hit = tree.ray_cast(p - d * 1.0, d, 2.0)
        if hit[0] and (hit[0] - p).dot(d) < clearance and (p - hit[0]).dot(d) < 0.03:
            return p + d * ((hit[0] - p).dot(d) - clearance)
        return p

    fit = None
    nose = None
    if follow == 'nose':
        fwd = -d
        # The nose profile at x = nose_x, by rays down onto the panel every millimetre from 6 cm ahead of
        # the line's inner end back to 25 cm behind it: (forward m, z) from the back, and the drop per
        # forward metre over a 6 mm window (the reduced donor's facets are 4 to 8 mm long).
        szp = surface_z(o)
        base = Vector((nose_x, 0, 0)) + d * (Vector(c).dot(d) - 0.06)
        hits = [(k * 0.001, szp(*(base + d * (0.25 - k * 0.001)).xy)) for k in range(0, 251)]
        hits = [(f, z) for f, z in hits if z is not None]
        fwd_s = [f for f, z in hits]
        zs = [z for f, z in hits]
        n = len(zs)
        slope = [(zs[max(k - 3, 0)] - zs[min(k + 3, n - 1)]) / (fwd_s[min(k + 3, n - 1)] - fwd_s[max(k - 3, 0)]) for k in range(n)]
        nose = (fwd_s, zs, slope)
        print(f'brow_to_line: nose profile {n} mm long, slope {slope[0]:.2f} at the back rising to {slope[-1]:.2f} at the lip')

        def edge_slope(v):
            inner = [e.other_vert(v) for e in v.link_edges if not e.is_boundary]
            w = max(inner, key=lambda w: (v.co - w.co).normalized().dot(fwd)) if inner else None
            return (w.co.z - v.co.z) / max((v.co - w.co).dot(fwd), 1e-6) if w else slope[0]
        # One neighbour's slope alternates 0.3 / 0.8 along the reduced mesh's edge (a sawtooth brow);
        # smoothed over five vertices it is the roll's.
        raw = [edge_slope(v) for v in path]
        m_s = [sum(raw[max(0, i - 2):i + 3]) / len(raw[max(0, i - 2):i + 3]) for i in range(len(raw))]
    if follow == 'plane':
        import numpy as np
        flat = lambda p: p - up * p.dot(up)

        def nearest(p):
            """(plan distance to the edge polyline, its parameter 0..1, the closest point)."""
            best = None
            for k, (p0, p1) in enumerate(zip(path, path[1:])):
                a0, b0 = flat(p0.co), flat(p1.co)
                ab = b0 - a0
                u = max(0.0, min(1.0, (flat(p) - a0).dot(ab) / max(ab.length_squared, 1e-12)))
                q = p0.co.lerp(p1.co, u)
                dist = (flat(p) - (a0 + ab * u)).length
                if best is None or dist < best[0]:
                    best = (dist, (lens[k] + u * (lens[k + 1] - lens[k])) / lens[-1], q)
            return best
        xs = [v for v in bm.verts if not any(f.tag for f in v.link_faces)
              and min(v.co.x for v in path) - 0.05 < v.co.x < max(v.co.x for v in path) + 0.05
              and abs((v.co - path[0].co).dot(d)) < reach + 0.05]
        # The sample is the top surface only: facing up, and clear of every open edge (the hood's side
        # edges roll down along the fender seam like the front one; with them in, the fit was 6 mm off).
        bm.normal_update()
        from mathutils import kdtree
        rim = [v for v in bm.verts if v.is_boundary]
        kd = kdtree.KDTree(len(rim))
        for k, v in enumerate(rim):
            kd.insert(flat(v.co), k)
        kd.balance()
        band, sample = [], []
        for v in xs:
            dist, t, q = nearest(v.co)
            if (v.co - q).dot(d) < -0.005:
                continue  # ahead of the edge: the fender's tip
            if dist < roll:
                band.append((v, t))
            elif dist < reach and v.normal.dot(up) > 0.85 and kd.find(flat(v.co))[2] > roll:
                sample.append(v)
        M = np.array([[1, v.co.x, v.co.y, v.co.x ** 2, v.co.x * v.co.y, v.co.y ** 2] for v in sample])
        coef, *_ = np.linalg.lstsq(M, np.array([v.co.z for v in sample]), rcond=None)
        fit = lambda x, y: float(coef[0] + coef[1] * x + coef[2] * y + coef[3] * x * x + coef[4] * x * y + coef[5] * y * y)
        grad = lambda x, y: Vector((coef[1] + 2 * coef[3] * x + coef[4] * y, coef[2] + coef[4] * x + 2 * coef[5] * y, 0))
        res = [abs(fit(v.co.x, v.co.y) - v.co.z) for v in sample]
        print(f'brow_to_line: plane fit over {len(sample)} vertices, rms {math.sqrt(sum(r * r for r in res) / len(res)) * 1000:.2f} mm, max {max(res) * 1000:.2f}; {len(band)} lip vertices lifted')
        for v, t in band:
            if v in (path[0], path[-1]):
                continue
            w = min(t, 1 - t) * lens[-1] / blend
            w = min(1.0, max(0.0, w))
            w = w * w * (3 - 2 * w)
            v.co.z += (fit(v.co.x, v.co.y) - v.co.z) * w
    cols = []
    for i, (v, s) in enumerate(zip(path, lens)):
        t = s / lens[-1]
        g = A.lerp(C, t)
        if t not in shut and follow not in ('hood', 'plane', 'nose'):
            # The panel's edge tucked behind the lamp's top lip, so the first band ran behind the lens
            # and a line of it showed through along the old cut out: the edge, inside the brow now, is
            # lifted too.
            q = clear(v.co)
            if (v.co - q).dot(d) > 0:
                v.co = q
        col = [v]
        if follow == 'nose' and t not in shut:
            fwd_s, zs, slope = nose
            m = m_s[i]
            # The point of the nose profile with this edge's slope, then the profile from there on.
            j = next((k for k in range(len(slope)) if slope[k] >= m), len(slope) - 1)
            zl = A.z + (v.co.x - A.x) / (C.x - A.x) * (C.z - A.z)
            need = v.co.z - zl
            run = [(0.0, 0.0)]
            for k in range(j + 1, len(zs)):
                run.append((fwd_s[k] - fwd_s[j], zs[j] - zs[k]))
            while run[-1][1] < need:  # past the lip: carry its last slope on
                run.append((run[-1][0] + 0.001, run[-1][1] + 0.001 * slope[-1]))
            def at(drop):
                for (f0, d0), (f1, d1) in zip(run, run[1:]):
                    if d1 >= drop:
                        u = (drop - d0) / max(d1 - d0, 1e-9)
                        return f0 + (f1 - f0) * u
                return run[-1][0]
            for fr in rows:
                drop = max(need, 0.0) * fr
                col.append(bm.verts.new(front(v.co + fwd * at(drop) - up * drop)))
        elif follow in ('hood', 'plane') and t not in shut:
            # The line's point onto the lamp's face along the view, keeping its place on the line.
            hit = tree.ray_cast(g - d * 1.0, d, 2.0)
            if hit[0] and abs((hit[0] - g).dot(d)) < 0.05:
                g = g + d * ((hit[0] - g).dot(d) - clearance)
            # A convex arc, as a hood rolls over to a crisp edge: a quadratic Bezier leaving v along the
            # panel's own slope there (toward v from the neighbour most directly behind it) and arriving at
            # the lamp's face square to it, its control point where the tangent line reaches the face's
            # depth. The first build's Hermite flattened after the lip and then dived, a dimple in the brow.
            if fit is not None:
                fwd = -d
                tan = (fwd + up * grad(v.co.x, v.co.y).dot(fwd)).normalized()
            else:
                inner = [e.other_vert(v) for e in v.link_edges if not e.is_boundary]
                w = max(inner, key=lambda w: (v.co - w.co).normalized().dot(-d)) if inner else None
                tan = (v.co - w.co).normalized() if w else (g - v.co).normalized()
            depth = (g - v.co).dot(d)
            k = depth / tan.dot(d) if tan.dot(d) * depth > 1e-9 else 0.0
            ctrl = v.co + tan * k
            if k <= 0 or (ctrl - g).dot(up) < 0 or k > 3 * (g - v.co).length:
                ctrl = (v.co + g) / 2
            for fr in rows:
                p = v.co * (1 - fr) ** 2 + ctrl * 2 * fr * (1 - fr) + g * fr * fr
                col.append(bm.verts.new(front(p)))
        else:
            for fr in rows:
                col.append(v if t in shut else bm.verts.new(clear(v.co.lerp(g, fr))))
        cols.append(col)
    mp = mat_index(o, 'Paint')
    made = []
    for i in range(len(cols) - 1):
        for k in range(len(rows)):
            quad = [cols[i][k], cols[i + 1][k], cols[i + 1][k + 1], cols[i][k + 1]]
            uniq = []
            for v in quad:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) < 3 or bm.faces.get(uniq):
                continue
            f = bm.faces.new(uniq)
            f.material_index = mp
            f.smooth = True
            f.normal_update()
            f.tag = True
            made.append(f)
    if follow in ('hood', 'plane', 'nose') and push:
        # The lamp's top rim stands up to 6 mm in front of the panel's edge (the Wendt Strom's lens rims
        # showed above the stock hood's edge from the front), so a face can still run behind it between
        # its corners: sample every new face and push its corners forward by what the lamp needs, the
        # line's two end vertices excepted.
        # The panel's own faces along the old edge are sampled too, moving only their edge vertices.
        fixed = {path[0], path[-1]}
        movable = set(path[1:-1])
        origin = {v: v.co.copy() for v in movable}
        rim = list({f for v in movable for f in v.link_faces if not f.tag})
        for _ in range(6):
            need = {}
            for f in made + rim:
                c = f.calc_center_median()
                for p in [c] + [(c + v.co) / 2 for v in f.verts] + [(a.co + b.co) / 2 for a, b in zip(f.verts, f.verts[1:] + f.verts[:1])]:
                    q = front(p)
                    dz = (p - q).dot(d)
                    if dz > 1e-5:
                        for v in f.verts:
                            if v not in fixed and (f.tag or v in movable):
                                # Pushing only some corners moves the sample by less: ask for more.
                                need[v] = max(need.get(v, 0.0), dz * (1.0 if f.tag else 2.0))
            if not need:
                break
            for v, dz in need.items():
                v.co -= d * dz
        # An edge vertex pushed forward on its own creased the hood along the old edge; the push is
        # spread back over the lip behind it (`spread` m, fading), so the panel bows forward smoothly.
        pushed = {v: (o0 - v.co).dot(d) for v, o0 in origin.items() if (o0 - v.co).dot(d) > 1e-5}
        if pushed:
            back = [w for w in bm.verts if w not in origin and not any(f.tag for f in w.link_faces)
                    and min(((w.co - v.co) - d * (w.co - v.co).dot(d)).length for v in pushed) < spread]
            for w in back:
                v = min(pushed, key=lambda v: ((w.co - v.co) - d * (w.co - v.co).dot(d)).length)
                r = ((w.co - v.co) - d * (w.co - v.co).dot(d)).length / spread
                w.co -= d * pushed[v] * (1 - r * r * (3 - 2 * r))
    # Seen from the view the new skin faces back toward it.
    if made and sum(f.normal.dot(-d) * f.calc_area() for f in made) < 0:
        for f in made:
            f.normal_flip()
    if sn is not None:
        acc = {}
        for f in made:
            for v in f.verts:
                acc.setdefault(v.index, Vector()).__iadd__(f.normal * f.calc_area())
        old = {}
        for v in path:
            ls = [lp[sn] for lp in v.link_loops if not lp.face.tag and Vector(lp[sn]).length > 1e-6]
            if ls:
                old[v.index] = sum((Vector(n) for n in ls), Vector()).normalized()
        for f in made:
            for lp in f.loops:
                lp[sn] = old.get(lp.vert.index, acc[lp.vert.index].normalized())
    tris = sum(len(f.verts) - 2 for f in made)
    bm.to_mesh(me)
    bm.free()
    me.update()
    if carry:
        restore_normals(o)
    return tris


# The NACA submerged duct (NACA RM A7I30, curved divergence, 7 degree ramp). Plan: the ramp's half width
# over the entrance's at x / L = 0 (the nose) .. 1 (the entrance), 0.1 apart: a narrow nose, the walls
# diverging slowly and then fast, parallel at the entrance.
NACA_PLAN = (0.083, 0.157, 0.236, 0.317, 0.405, 0.503, 0.611, 0.727, 0.854, 0.975, 1.0)
# The ramp floor's depth over its depth at the entrance (B), at x / L = 0 .. 1 by 1/12 (the report's
# figure 5 from station 100 % to 0 %): tangent to the skin at the nose, flat at the entrance.
NACA_RAMP = (0.0, 0.004, 0.0405, 0.1015, 0.187, 0.2935, 0.4109, 0.532, 0.6548, 0.772, 0.8762, 0.957, 1.0)
# The entrance lip (figure 7), per unit entrance depth d: stations back from its nose (0) to where its top
# meets the skin (1), the top's and the underside's depth below the skin. The nose is 0.197 d down.
NACA_LIP_TOP = ((0.0, 0.197), (0.125, 0.087), (0.25, 0.058), (0.5, 0.021), (0.75, 0.005), (1.0, 0.0))
NACA_LIP_UNDER = ((0.0, 0.197), (0.125, 0.325), (0.25, 0.375), (0.5, 0.44), (0.75, 0.481))


def naca_vent(o, front, heading, width=0.12, ratio=4.0, ramp=7.0, corner=0.006, trim=0.0, step=0.03,
              mat='Paint', trim_mat='Black', mouth='Black'):
    """A NACA submerged duct cut into a panel (a hood vent, after the Porsche GT3 RS's), flush with the
    skin: nothing stands above it. Built to the NACA report's curved divergent design (NACA RM A7I30):
    the ramp's plan `NACA_PLAN` (a narrow nose, the walls diverging to the entrance `width` m across),
    its floor `NACA_RAMP` (an S curve from the skin at the nose down to B at the entrance, B over the
    ramp's length tan `ramp` degrees), sharp vertical side walls (the edge vortices are the point of the
    shape), and at the entrance the skin ending in the rounded lip `NACA_LIP_*`, its nose 0.197 d below
    the surface facing forward, d = width / `ratio` the entrance depth from the lip to the floor. The
    hole is under that lip: a `mouth` coloured wall 0.75 d behind its nose closes the duct, which a real
    one carries on under the panel. `front` is the nose in plan (x, y), `heading` degrees the axis turns
    outboard (toward +x) going back. The skin is cut along the ramp's outline plus the lip's top (1 d
    behind the entrance), and every ring inside is built off that cut edge's own vertices (the outline's
    points plus where the panel's edges cross it, long runs split to `step`), each mapped onto its own
    outline along the ray from a point on the axis near the entrance (the plan is star shaped from there,
    so no ring crosses itself), so the duct closes onto the skin whatever the panel's triangulation.
    `trim` > 0 rings the opening with a flat band that wide in `trim_mat`, level with the skin (a duct
    insert's flange set flush, so the duct reads as a separate black piece like the car's other aero,
    `mat='Black'`). Heights are read off the skin before it is cut. Carries authored normals: the trim,
    the walls and the floor each their own group (a sharp edge at the skin), the lip smooth. Returns the
    triangles added."""
    carry = stash_normals(o)
    me = o.data
    sz = surface_z(o)
    ax = Vector((math.sin(math.radians(heading)), math.cos(math.radians(heading))))
    side = Vector((ax.y, -ax.x))  # outboard, perpendicular to the axis
    f0 = Vector(front)
    hw = width / 2
    d = width / ratio
    B = d * (1 + NACA_LIP_TOP[0][1])
    length = B / math.tan(math.radians(ramp))
    end = length + d  # the cut's back edge: where the lip's top meets the skin

    def table(vals, s):
        s = max(0.0, min(1.0, s)) * (len(vals) - 1)
        i = min(int(s), len(vals) - 2)
        return vals[i] + (vals[i + 1] - vals[i]) * (s - i)

    def lerp_pairs(pairs, s):
        for (a, va), (b, vb) in zip(pairs, pairs[1:]):
            if s <= b:
                return va + (vb - va) * (s - a) / (b - a)
        return pairs[-1][1]
    plan = lambda u: hw * table(NACA_PLAN, u / length)
    floor_depth = lambda u: max(0.0015, B * table(NACA_RAMP, u / length))

    def half(u, e, off=0.0):
        """The half width at u of the outline whose back end is at e, grown by off all round (the trim's
        outer edge: the nose's flat end rounded, the corners' radius grown with it)."""
        if u < -off or u > e + off:
            return 0.0
        if u < 0:
            return plan(0) + math.sqrt(max(0.0, off * off - u * u))
        r = min(corner + off, (e + off) / 2)
        h = plan(min(u, e)) + off
        if u > e + off - r:
            return max(0.0, h - r + math.sqrt(max(0.0, r * r - (u - (e + off - r)) ** 2)))
        return h
    loc = lambda p: ((p - f0).dot(ax), (p - f0).dot(side))
    world = lambda u, v: f0 + ax * u + side * v
    inside = lambda p, e, off=0.0: (lambda u, v: -off <= u <= e + off and abs(v) <= half(u, e, off))(*loc(p))
    hub = world(length * 0.8, 0)

    def onto(p, e, off=0.0):
        """p moved along the ray from the hub onto the outline (e, off), by bisection."""
        r0, r1, dv = 0.0, 1.0, p - hub
        for _ in range(40):
            if not inside(hub + dv * r1, e, off):
                break
            r1 *= 1.5
        for _ in range(32):
            r = 0.5 * (r0 + r1)
            r0, r1 = (r, r1) if inside(hub + dv * r, e, off) else (r0, r)
        return hub + dv * r0
    # The cut: the trim's outer edge (the opening's when there is none).
    us = [length * k / 14 for k in range(1, 15)] + [length + d * k / 3 for k in range(1, 3)]
    rc = corner + trim
    tail = [(end + trim - rc + rc * math.sin(a), half(end + trim - rc + rc * math.sin(a), end, trim))
            for a in (math.pi / 2 * k / 3 for k in range(4))]
    nose = [(-trim * math.cos(a), half(-trim * math.cos(a), end, trim)) for a in (math.pi / 2 * k / 3 for k in range(1, 3))] if trim else []
    right = [(-trim, plan(0))] + nose + [(0.0, plan(0) + trim)] + [(u, half(u, end, trim)) for u in us if u < end + trim - rc] + tail
    ring = ([world(-trim, 0)] + [world(u, v) for u, v in right]
            + [world(u, -v) for u, v in reversed(right) if v > 1e-6])

    def in_poly(p):
        c, j = False, len(ring) - 1
        for i in range(len(ring)):
            a, b = ring[i], ring[j]
            if (a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x:
                c = not c
            j = i
        return c
    on_or_in = lambda p: in_poly(p) or any(((Vector((p.x, p.y)) - a) - (b - a) * max(0, min(1, (Vector((p.x, p.y)) - a).dot(b - a) / max((b - a).length_squared, 1e-12)))).length < 5e-4
                                           for a, b in zip(ring, ring[1:] + ring[:1]))
    lo = Vector((min(p.x for p in ring) - 0.05, min(p.y for p in ring) - 0.05))
    hi = Vector((max(p.x for p in ring) + 0.05, max(p.y for p in ring) + 0.05))
    box = lambda p: lo.x < p.x < hi.x and lo.y < p.y < hi.y
    near = lambda f: f.normal.z > 0.3 and (any(box(v.co) for v in f.verts) or in_poly(f.calc_center_median()))
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    for _ in range(2):
        for a, b in zip(ring, ring[1:] + ring[:1]):
            if (b - a).length < 1e-6:
                continue
            t = (b - a).normalized()
            faces = [f for f in bm.faces if near(f)]
            geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=(a.x, a.y, 0), plane_no=(-t.y, t.x, 0))
    # The sides are concave, so a plane's line runs on through the outline; a face is doomed only when
    # its centre and every corner are on or inside it (on: a sliver lying along the outline broke the loop).
    doomed = [f for f in bm.faces if near(f) and on_or_in(f.calc_center_median()) and all(on_or_in(v.co) for v in f.verts)]
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    # Merge the slivers the cut lines leave outside it, never touching the panel's own outline (a dissolve
    # took a vertex off the Wendt Strom hood's edge at the fender seam).
    region = [f for f in bm.faces if near(f)]
    rim_edge = lambda e: e.is_boundary and not all(on_or_in(v.co) for v in e.verts)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), use_dissolve_boundaries=False,
                             verts=list({v for f in region for v in f.verts if not any(rim_edge(e) for e in v.link_edges)}),
                             edges=list({e for f in region for e in f.edges if not rim_edge(e)}), delimit={'MATERIAL'})
    cut_edges = lambda: [e for e in bm.edges if e.is_boundary and all(box(v.co) and on_or_in(v.co) for v in e.verts)]
    # Bisects meeting at the outline's points leave cut edge vertices a fraction of a millimetre apart,
    # sometimes out of order (the loop stepped back 0.7 mm and its rings crossed): weld them first.
    bmesh.ops.remove_doubles(bm, verts=list({v for e in cut_edges() for v in e.verts}), dist=0.0015)
    for e in cut_edges():
        k = int(e.calc_length() / step)
        if k:
            bmesh.ops.subdivide_edges(bm, edges=[e], cuts=k)
    edges = cut_edges()
    # Walk the cut edge into one loop, by index and bounded (a wrapper walk can spin forever).
    nbr = {}
    for e in edges:
        a, b = e.verts
        nbr.setdefault(a.index, []).append(b)
        nbr.setdefault(b.index, []).append(a)
    if any(len(v) != 2 for v in nbr.values()):
        bm.verts.ensure_lookup_table()
        raise RuntimeError('naca_vent: the cut edge branches at ' + str([(tuple(round(c, 4) for c in bm.verts[i].co), len(v)) for i, v in nbr.items() if len(v) != 2]))
    start = edges[0].verts[0]
    loop, prev = [start], None
    for _ in range(len(edges)):
        cur = loop[-1]
        nxt = [v for v in nbr[cur.index] if prev is None or v.index != prev.index]
        prev = cur
        if nxt[0].index == start.index:
            break
        loop.append(nxt[0])
    if len(loop) != len(edges):
        raise RuntimeError(f'naca_vent: the cut edge is not one loop ({len(loop)} of {len(edges)} edges)')
    m = len(loop)
    # Each cut edge point's profile in: down its side wall (fractions of the floor's depth there), or for
    # the lip (the back end and the sides behind the entrance), forward over its top to the nose, back
    # under it, and down the duct's black back wall to the floor. The corners blend the two.
    # (station, depth / d): a few of the report's stations are enough at a hood vent's size.
    lip_top, lip_under = (0.5, 0.2, 0.0), (0.25, 0.6)
    lip = ([(s, lerp_pairs(NACA_LIP_TOP, s)) for s in lip_top] + [(s, lerp_pairs(NACA_LIP_UNDER, s)) for s in lip_under]
           + [(0.75, B / d)])
    wall = [0.04 + 0.96 * k / (len(lip) - 1) for k in range(len(lip))]
    kt = 1 if trim else 0  # the trim band's row, level with the skin, from the cut to the opening
    rows_pts = []
    for v in loop:
        p = Vector((v.co.x, v.co.y))
        p = onto(p, end) if trim else p
        u, _ = loc(p)
        w = max(0.0, min(1.0, (u - length) / (0.3 * d)))
        w = w * w * (3 - 2 * w)
        prof = [(p, 0.0)] if trim else []
        for (s, dl), fw in zip(lip, wall):
            q = onto(p, length + s * d) if w > 0 else p
            q = p.lerp(q, w)
            prof.append((q, -((1 - w) * fw * floor_depth(loc(q)[0]) + w * dl * d)))
        rows_pts.append((w, prof))

    def crosses(a, b, c, e):
        s = lambda p, q, r: (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
        return s(a, b, c) * s(a, b, e) < 0 and s(c, e, a) * s(c, e, b) < 0
    fl = [prof[-1][0] for _, prof in rows_pts]
    if sum(crosses(fl[i], fl[(i + 1) % m], fl[j], fl[(j + 1) % m]) for i in range(m) for j in range(i + 2, m) if (j + 1) % m != i):
        raise RuntimeError('naca_vent: the floor outline crosses itself')
    rows = [loop]
    for k in range(kt + len(lip)):
        rows.append([bm.verts.new((q.x, q.y, (lambda z: z if z is not None else v.co.z)(sz(q.x, q.y)) + h))
                     for v, (_, prof) in zip(loop, rows_pts) for q, h in [prof[k]]])
    mp, mm, mt = mat_index(o, mat), mat_index(o, mouth), mat_index(o, trim_mat)
    groups, made = {}, []
    # Winding: a side wall faces into the duct.
    i0 = min(range(m), key=lambda i: abs(loc(Vector((loop[i].co.x, loop[i].co.y)))[0] - length / 2))
    a, b, c = rows[kt][i0].co, rows[kt][(i0 + 1) % m].co, rows[kt + 1][i0].co
    into = Vector((*(-side * (1 if loc(Vector((a.x, a.y)))[1] > 0 else -1)), 0))
    flip = (b - a).cross(c - a).dot(into) < 0
    for k in range(len(rows) - 1):
        for i in range(m):
            q = [rows[k][i], rows[k][(i + 1) % m], rows[k + 1][(i + 1) % m], rows[k + 1][i]]
            f = bm.faces.new(q[::-1] if flip else q)
            w = 0.5 * (rows_pts[i][0] + rows_pts[(i + 1) % m][0])
            f.material_index = mt if k < kt else mm if (k == len(rows) - 2 and w > 0.5) else mp
            f.smooth = True
            groups[f] = 'trim' if k < kt else 'wall' if w < 0.5 else ('lip' if k - kt < len(lip) - 1 else 'mouth')
            made.append(f)
    fill = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False,
                                   edges=[bm.edges.get((rows[-1][i], rows[-1][(i + 1) % m])) for i in range(m)], normal=(0, 0, 1))
    floor = [g for g in fill['geom'] if isinstance(g, bmesh.types.BMFace)]
    open_ = list({e for f in floor for e in f.edges if e.is_boundary})
    if open_:
        print(f'naca_vent: the floor fill left {len(open_)} open edges')
    for f in floor:
        f.normal_update()
        if f.normal.z < 0:
            f.normal_flip()
        f.material_index = mp
        groups[f] = 'floor'
        made.append(f)
    for f in made:
        f.normal_update()
    if sn is not None:
        acc = {}
        for f in made:
            for v in f.verts:
                acc.setdefault((groups[f], v.index), Vector()).__iadd__(f.normal * f.calc_area())
        for f in made:
            for lp in f.loops:
                lp[sn] = acc[(groups[f], lp.vert.index)].normalized()
    tris = sum(len(f.verts) - 2 for f in made)
    bm.to_mesh(me)
    bm.free()
    me.update()
    if carry:
        restore_normals(o)
    return tris


# Stations for `sheet_lip`: coarse across the nearly straight nose, 3 degrees round the corner and 1.5
# through its tightest part (51 to 69 degrees, where 3 degree steps turned the edge 11 degrees each).
# They stop at 82: a station at 83 reached the wheel well but its bottom edge sits on the arch's lip,
# 2.8 cm further out, and flared the ends; `to_well` carries the ends on to the well along the body.
SHEET_ANGLES = (0, 8, 16, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 52.5, 54, 55.5, 57, 58.5, 60, 61.5, 63, 64.5,
                66, 67.5, 69, 72, 75, 78, 80, 82)


def sheet_lip(src, target, center=(0, -1.55), angles=SHEET_ANGLES, band=(0.165, 0.235), thick=0.013,
              proud=0.03, end_proud=0.012, taper_from=70, tuck=0.04, butt=0.004, chamfer=0.006, full=True,
              from_face=True, face_band=0.4, smooth=3, crisp=False, drop=0.0, dam=0.0, dam_face=True, dam_band=0.1, dam_side_from=40, dam_nose_lower=0.0, dam_nose_fade=10.0, to_well=True, straight_from=None,
              material='Black'):
    """A flat splitter cut from sheet stock (half inch HDPE) under a front bumper: top and bottom flat
    all the way round at the height of the bumper's underside at the nose, its outline through `angles`
    (degrees about `center`, one half, mirrored), with a 45 degree `chamfer` on the top front edge.
    `proud` is how far it stands ahead of the bumper's face (`from_face`: the face's most forward point
    within `face_band` m above the bottom, per station), not of its bottom edge: the Wendt Strom's face
    overhangs its bottom edge by 5 cm across the nose and 3 cm on the sides, so a sheet 5 cm past the
    bottom edge sat flush with the face and the user asked for more. The outline is one sweep through
    many stations (dense round the corners), smoothed in plan `smooth` times so the donor's noisy edge
    does not wobble it: seven straight runs a side read as jagged. `crisp` makes each run its own sweep
    instead (hard joints, the first Track build). Past
    `taper_from` degrees the proud edge narrows to `end_proud` at the last angle. A bumper's bottom
    dips toward the arches, below a sheet at the nose's height: with `full` (the user wanted it along
    the whole bottom) the sheet runs on to the arches and, where the underside is below it, butts
    against the face (`butt` m in, not `tuck` under); without, it stops at the last angle where the
    underside is still above it. The Wendt Strom's Track bumper. Carries authored normals. Returns the
    sections."""
    E = lower_edge(src, center, list(angles), *band)
    # `drop` lowers the sheet below the bumper (a race splitter), `dam` > 0 closes the gap it opens
    # with a vertical panel that thick from the bumper's bottom edge down to the sheet, following the
    # bumper round to the arches: one L section, so the panel and the sheet share their edge.
    top = E[0].z - 0.002 - drop
    keep = [i for i, e in enumerate(E) if full or e.z >= top + 0.001 or i == 0]
    E = [E[i] for i in keep]
    A = [angles[i] for i in keep]
    over = [0.0] * len(E)
    zout = [e.z for e in E]
    over_low = [0.0] * len(E)
    found = [False] * len(E)
    profs = [None] * len(E)
    if from_face or dam_face:
        from mathutils.bvhtree import BVHTree
        t = BVHTree.FromObject(src, bpy.context.evaluated_depsgraph_get())
        c = Vector((center[0], center[1], 0))
        for i, (e, a) in enumerate(zip(E, A)):
            d = Vector((math.sin(math.radians(a)), -math.cos(math.radians(a)), 0))
            hits = [h[0] for h in (t.ray_cast(c + d * 3 + Vector((0, 0, band[0] + 0.005 * j)), -d, 3)
                                   for j in range(int(face_band / 0.005))) if h[0]]
            far = max(hits, key=lambda q: (q - c).to_2d().length, default=None)
            if far is not None:
                over[i] = max(0.0, (far - c).to_2d().length - (e - c).to_2d().length)
            # The air dam's top runs along the bumper's lower line: the ledge where the face steps in
            # near the bottom (three samples in a row facing up), and stands just inside the face below
            # it. Its first rule, the lower face's most forward point in a band, wandered off the line
            # round the corners (the face keeps coming forward there) and the user asked for the line.
            prof = []
            mats = [m.name.split('.')[0] if m else '' for m in src.data.materials]
            for j in range(int(dam_band / 0.002)):
                zz = band[0] + 0.006 + 0.002 * j
                h = t.ray_cast(c + d * 3 + Vector((0, 0, zz)), -d, 3)
                if h[0]:
                    prof.append((zz, (h[0] - c).to_2d().length, h[1].z, mats[src.data.polygons[h[2]].material_index]))
            profs[i] = (prof, (e - c).to_2d().length)
            # The line is the ledge (three upward-facing samples) or, round the corners, the first black
            # surface above (the side intakes' black surround): stopping short of it left a ragged band
            # of paint between the dam and the black (the user wanted black up to the bumper line).
            for k in range(1, len(prof) - 2):
                if all(prof[k + m][2] > 0.3 for m in range(3)) or prof[k][3] == 'Black':
                    # Under a side intake the face carries on 2 to 3 cm above a small lower ledge to the
                    # intake's black surround: that surround is the line, not the ledge.
                    # Only the top rises to it; the panel keeps its place in front of the ledge's face.
                    kb = next((m for m in range(k, len(prof)) if prof[m][3] == 'Black' and prof[m][0] - prof[k][0] < 0.035), None) \
                        if abs(a) >= dam_side_from else None
                    zout[i] = prof[kb][0] if kb is not None else prof[k][0]
                    over_low[i] = max(0.0, prof[k - 1][1] - (e - c).to_2d().length)
                    found[i] = True
                    break
    if not from_face:
        over = [0.0] * len(E)
    # Stations where the ledge was not found borrow it from their neighbours, linearly.
    known = [i for i in range(len(E)) if found[i]]
    for i in range(len(E)):
        if not found[i] and known:
            lo = max((k for k in known if k < i), default=None)
            hi = min((k for k in known if k > i), default=None)
            if lo is None or hi is None:
                k = lo if hi is None else hi
                zout[i], over_low[i] = zout[k], over_low[k]
            else:
                # The higher neighbour's line: where no ledge is found the face is smooth up to the next
                # one, and an interpolated top fell short of it (paint showed above the dam).
                f = (i - lo) / (hi - lo)
                zout[i] = max(zout[lo], zout[hi])
                over_low[i] = over_low[lo] + (over_low[hi] - over_low[lo]) * f
    E = [Vector((-e.x, e.y, e.z)) for e in reversed(E[1:])] + E
    A = [-a for a in reversed(A[1:])] + A
    over = list(reversed(over[1:])) + over
    over_low = list(reversed(over_low[1:])) + over_low
    zout = list(reversed(zout[1:])) + zout
    profs = list(reversed(profs[1:])) + profs
    bot = top - thick
    last = max(abs(x) for x in A)

    def normals(P):
        out = []
        for i, p in enumerate(P):
            tg = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
            n = Vector((tg.y, -tg.x))
            out.append(n if n.dot(p - Vector(center)) > 0 else -n)
        return out

    # The front edge in plan, then smoothed with its ends held: the donor's bottom edge is noisy, and
    # with stations a few cm apart the noise showed in the outline.
    N0 = normals([e.to_2d() for e in E])
    ext = []
    for i, a in enumerate(A):
        k = 0.0 if abs(a) <= taper_from or last <= taper_from else (abs(a) - taper_from) / (last - taper_from)
        ext.append(over[i] + proud + (end_proud - proud) * k)
    P = [e.to_2d() + n * x for e, n, x in zip(E, N0, ext)]
    for _ in range(smooth):
        P = [P[0]] + [P[i - 1] * 0.25 + P[i] * 0.5 + P[i + 1] * 0.25 for i in range(1, len(P) - 1)] + [P[-1]]
    # `straight_from`: from that angle to the end the edge runs straight, so a flat `spat` stands
    # flush on it (on the curve the edge bowed 1.6 cm past the plate and the spat looked detached).
    if straight_from is not None:
        for side in (1, -1):
            idx = [i for i, a in enumerate(A) if a * side >= straight_from]
            if len(idx) > 2:
                i0, i1 = (idx[0], idx[-1]) if side > 0 else (idx[-1], idx[0])
                p0, p1 = P[i0], P[i1]
                seg = p1 - p0
                for i in idx:
                    k = max(0.0, min(1.0, (P[i] - p0).dot(seg) / seg.length_squared))
                    P[i] = p0 + seg * k
    N = normals(P)
    # The air dam's top follows the bumper's bottom edge, smoothed: one noisy station near the arch
    # stood up as a spike.
    ZU = [e.z for e in E]
    for _ in range(smooth):
        ZU = [ZU[0]] + [ZU[i - 1] * 0.25 + ZU[i] * 0.5 + ZU[i + 1] * 0.25 for i in range(1, len(ZU) - 1)] + [ZU[-1]]
    ZU[0], ZU[-1] = ZU[1], ZU[-2]
    # The nose keeps its first, accepted rules (the corner rules below made the wrap under the grille
    # worse): its own smoothed line and position, the panel from the sheet's edge.
    ZT0, OL0 = list(zout), list(over_low)
    for _ in range(smooth):
        ZT0 = [ZT0[0]] + [ZT0[i - 1] * 0.25 + ZT0[i] * 0.5 + ZT0[i + 1] * 0.25 for i in range(1, len(ZT0) - 1)] + [ZT0[-1]]
        OL0 = [OL0[0]] + [OL0[i - 1] * 0.25 + OL0[i] * 0.5 + OL0[i + 1] * 0.25 for i in range(1, len(OL0) - 1)] + [OL0[-1]]
    # Round the corners (past `dam_side_from`) the line is taken as the highest within two stations
    # either side: the crease there runs level, and single low readings left notches of paint.
    zout = [max(zout[max(i - 2, 0):i + 3]) if abs(A[i]) >= dam_side_from else z for i, z in enumerate(zout)]
    # The panel stands ahead of the face's most forward point below its top: round the corners the face
    # bulges forward above the ledge, and a panel placed at the ledge showed paint in front of it.
    for i in range(len(E)):
        j = i if i < len(profs) and profs[i] else None
        if j is None:
            continue
        prof, er = profs[j]
        fr = [r for z, r, _, _ in prof if z <= zout[i] + 0.002]
        if fr:
            over_low[i] = max(over_low[i], max(fr) - er)
    ZT = list(zout)
    for _ in range(smooth):
        ZT = [ZT[0]] + [ZT[i - 1] * 0.25 + ZT[i] * 0.5 + ZT[i + 1] * 0.25 for i in range(1, len(ZT) - 1)] + [ZT[-1]]
        over_low = [over_low[0]] + [over_low[i - 1] * 0.25 + over_low[i] * 0.5 + over_low[i + 1] * 0.25
                                    for i in range(1, len(over_low) - 1)] + [over_low[-1]]
    # Never below the line: smoothing pulled the top a few mm under it where the line steps up.
    ZT = [max(z, max(zout[max(i - 1, 0):i + 2])) + 0.002 for i, z in enumerate(ZT)]
    secs = []
    for i, e in enumerate(E):
        n3 = Vector((N[i].x, N[i].y, 0))
        tk = tuck if e.z >= top + 0.001 else butt
        front = Vector((P[i].x, P[i].y, 0))
        if dam > 0:
            # `dam_face`: the panel stands just inside the bumper's lower face (see above) and rises to
            # its most forward point there, so it never sits behind what the bumper shows (the user
            # moved it forward from the bottom edge).
            if dam_face:
                # 1 mm proud of the strip below the ledge, its top on the ledge: the panel's own smooth
                # edge is then the line seen. Set 5 mm inside the strip, the visible edge was wherever
                # the donor's uneven strip crossed the panel, ragged round the corners.
                # From the bumper's own edge, not the sheet's (smoothed, and straightened under a spat:
                # measured from it the panel sank into the face there), 3 mm proud of the face.
                if abs(A[i]) >= dam_side_from:
                    edge = Vector((e.x, e.y, 0)) + n3 * (over_low[i] + 0.003)
                    zu = ZT[i] + 0.001
                else:
                    edge = front - n3 * (ext[i] - OL0[i] - 0.001)
                    # `dam_nose_lower`: the top under the grilles brought down, faded out over the last
                    # `dam_nose_fade` degrees before the corner rules so the line runs on into them (the
                    # user's ask; 4 brings the outer grilles' lower outer corners down too).
                    fade = _sstep((dam_side_from - abs(A[i])) / dam_nose_fade)
                    zu = ZT0[i] + 0.001 - dam_nose_lower * fade
            else:
                edge = front - n3 * ext[i]
                zu = ZU[i] + 0.003
            secs.append([tuple(edge - n3 * dam + Vector((0, 0, zu))), tuple(edge + Vector((0, 0, zu))),
                         tuple(edge + Vector((0, 0, top))), tuple(front - n3 * chamfer + Vector((0, 0, top))),
                         tuple(front + Vector((0, 0, top - chamfer))), tuple(front + Vector((0, 0, bot))),
                         tuple(edge - n3 * dam + Vector((0, 0, bot)))])
            continue
        back = front - n3 * (ext[i] + tk)
        secs.append([tuple(back + Vector((0, 0, top))),
                     tuple(front - n3 * chamfer + Vector((0, 0, top))),
                     tuple(front + Vector((0, 0, top - chamfer))),
                     tuple(front + Vector((0, 0, bot))),
                     tuple(back + Vector((0, 0, bot)))])
    # `to_well`: the end sections run on along the sheet to the wheel well's edge (the bumper's
    # rearmost low point), so no gap is left before the arch; cut along the side's normal they stopped
    # 2 to 4 cm short of it.
    if to_well:
        well = max((v.co.y for v in src.data.vertices if abs(v.co.x) > 0.6 and v.co.z < band[0] + 0.035), default=None)
        if well is not None:
            # The end section replaced by the run before it carried straight on (each corner along
            # its own line) to the well, so the ends keep the body's line: carried along the sheet's
            # direction at the last station, which already bends out, they flared 3 to 5 degrees.
            for j, k, m in ((0, 1, 2), (len(secs) - 1, len(secs) - 2, len(secs) - 3)):
                if m < 0 or m >= len(secs):
                    continue
                new = []
                for pk, pm in zip(secs[k], secs[m]):
                    pk, pm = Vector(pk), Vector(pm)
                    dv = pk - pm
                    new.append(tuple(pk + dv * ((well - 0.002 - pk.y) / dv.y)) if dv.y > 1e-4 else tuple(pk))
                secs[j] = new
    carry = stash_normals(target)
    if crisp:
        for i in range(len(secs) - 1):
            sweep(target, [secs[i], secs[i + 1]], material)
    else:
        sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return secs


def canard(src, target, side, a0, a1, z0, rise=0.03, width=(0.06, 0.02), thick=0.004, embed=0.006,
           chamfer=0.0, curve=0.0, corner=(0.0, 0.0), lip=0.0, center=(0, -1.55), stations=5, material='Black'):
    """A canard (dive plane) on a bumper's corner: a thin plate standing out of the corner face from
    `a0` to `a1` degrees about `center` (plan, 0 toward -y; `side` +1 the car's left, -1 its right), its
    root following the face (plan rays at each station) from height z0 at the front end to z0 + `rise`
    at the back, so it angles up toward the rear; `width` (front, back) is how far it stands out, the
    root sunk `embed` m into the face so no seam shows, and `chamfer` a 45 degree bevel on its top
    outer edge (cut sheet, like `sheet_lip`). `curve` m more rise at the back end, growing with the
    square of the distance along it, sweeps the plate up toward its tail instead of a straight incline
    (give it six stations or more so the sweep reads round). `corner` (front, back) rounds the plate's
    two outer corners in plan to those radii, m; `stations` is a count (even spacing) or a list of
    fractions along it, which should crowd the ends when the corners are rounded. The Wendt Strom's
    Track Mild bumper carries two a side where the amber markers were. Carries authored normals."""
    from mathutils.bvhtree import BVHTree
    t = BVHTree.FromObject(src, bpy.context.evaluated_depsgraph_get())
    c = Vector((center[0], center[1], 0))
    fracs = [k / (stations - 1) for k in range(stations)] if isinstance(stations, int) else list(stations)
    roots = []
    for f in fracs:
        a = math.radians(a0 + (a1 - a0) * f)
        d = Vector((side * math.sin(a), -math.cos(a), 0))
        z = z0 + rise * f + curve * f * f
        h = t.ray_cast(c + d * 3 + Vector((0, 0, z)), -d, 3)
        if h[0]:
            roots.append((f, h[0].copy(), Vector((h[1].x, h[1].y, 0)).normalized()))
    run = [0.0]
    for (_, p, _), (_, q, _) in zip(roots, roots[1:]):
        run.append(run[-1] + (q - p).length)
    total = run[-1]

    def pull(s, r):
        """How far a corner of radius r draws the outer edge in, s m from that end."""
        return 0.0 if r <= 0 or s >= r else r - math.sqrt(r * r - (r - s) ** 2)

    secs = []
    for (f, s, n), along in zip(roots, run):
        w = width[0] + (width[1] - width[0]) * f
        rounded = max(pull(along, corner[0]), pull(total - along, corner[1]))
        w -= rounded
        # The end plate runs along the straight outer edge only: round the corner's radius it reads as
        # a fold, and the user had it taken off there.
        in_corner = (corner[0] > 0 and along < corner[0]) or (corner[1] > 0 and total - along < corner[1])
        up = Vector((0, 0, thick / 2))
        if lip > 0:
            # A vertical end plate along the outer edge, `lip` m tall above the plate, `thick` thick.
            L = Vector((0, 0, 0 if in_corner else lip))
            secs.append([tuple(s - n * embed + up), tuple(s + n * (w - thick) + up), tuple(s + n * (w - thick) + up + L),
                         tuple(s + n * w + up + L), tuple(s + n * w - up), tuple(s - n * embed - up)])
        elif chamfer > 0:
            ch = Vector((0, 0, chamfer))
            secs.append([tuple(s - n * embed + up), tuple(s + n * (w - chamfer) + up), tuple(s + n * w + up - ch),
                         tuple(s + n * w - up), tuple(s - n * embed - up)])
        else:
            secs.append([tuple(s - n * embed + up), tuple(s + n * w + up), tuple(s + n * w - up), tuple(s - n * embed - up)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return secs


def side_lip(body, target, y0, y1, top, thick=0.013, proud=0.02, tuck=0.04, chamfer=0.006, dam=0.0,
             filler=0.0, filler_inset=0.015, dam_tol=0.003, smooth=0, stations=11, scan=0.15, material='Black'):
    """A side skirt lip carrying a front splitter's line down the sill, both sides: a flat sheet from
    y0 to y1 (between the wheels) with its top at `top` (the splitter's own height, so the line runs
    on), standing `proud` m out from the sill's face (its most outward point within `scan` m above the
    sheet, per station), its outer top edge chamfered. With `dam` > 0 a vertical panel that thick runs
    from the sill's lower line (the lowest height the face is within 3 mm of its most outward point)
    down to the sheet, 1 mm proud of the face, like `sheet_lip`'s air dam. `filler` > 0 instead hides a
    panel that thick `filler_inset` m inside the sill's outer face, from the sheet up to the sill's
    underside there: where the underside curves up at its outer edge a sheet below it shows a gap from
    the side (Track Mild's skirts, up to 1 cm). Built on the +x side from
    rays and mirrored, each side one sweep. The Wendt Strom's Track Mild and Track Wild skirts.
    Returns the +x sections."""
    from mathutils.bvhtree import BVHTree
    t = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    bot = top - thick
    secs = []
    for k in range(stations):
        y = y0 + (y1 - y0) * k / (stations - 1)
        prof = []
        for j in range(int(scan / 0.003)):
            zz = top + 0.003 * j
            h = t.ray_cast(Vector((3, y, zz)), Vector((-1, 0, 0)), 3)
            if h[0]:
                prof.append((zz, h[0].x))
        xf = max(x for _, x in prof)
        # The dam's top: the lowest height the face comes within `dam_tol` of its most outward point.
        # 3 mm finds the sill's lower crease; 12 mm its bottom edge, a shorter dam under the sill's own
        # line (Track Wild's skirts after the user asked for a thinner one that follows the body line).
        zl, xl = next((p for p in prof if p[1] >= xf - dam_tol), prof[-1])
        out = xf + proud
        if filler > 0:
            xi = xf - filler_inset
            up = t.ray_cast(Vector((xi, y, top + 0.0005)), Vector((0, 0, 1)), 0.05)
            zf = up[0].z + 0.002 if up[0] else top + 0.002
            secs.append([(xi - filler, y, zf), (xi, y, zf), (xi, y, top), (out - chamfer, y, top), (out, y, top - chamfer),
                         (out, y, bot), (xf - tuck, y, bot), (xf - tuck, y, top), (xi - filler, y, top)])
        elif dam > 0:
            xd = xl + 0.001
            secs.append([(xd - dam, y, zl), (xd, y, zl), (xd, y, top), (out - chamfer, y, top), (out, y, top - chamfer),
                         (out, y, bot), (xd - dam, y, bot)])
        else:
            secs.append([(xf - tuck, y, top), (out - chamfer, y, top), (out, y, top - chamfer), (out, y, bot),
                         (xf - tuck, y, bot)])
    if dam > 0 and filler <= 0 and smooth:
        # The dam's top smoothed along the car, so it reads as one line like the body's.
        zs = [s[0][2] for s in secs]
        for _ in range(smooth):
            zs = [zs[0]] + [zs[i - 1] * 0.25 + zs[i] * 0.5 + zs[i + 1] * 0.25 for i in range(1, len(zs) - 1)] + [zs[-1]]
        secs = [[(p[0], p[1], zs[i]) if k < 2 else p for k, p in enumerate(s)] for i, s in enumerate(secs)]
    carry = stash_normals(target)
    sweep(target, secs, material)
    sweep(target, [[(-x, y, z) for x, y, z in s] for s in secs], material)
    if carry:
        restore_normals(target)
    return secs


def ditch_fin(surfaces, target, y0, y1, x_guess, heights=(0.012, 0.017), ramp=0.08, root=0.005, tip=0.003,
              stations=26, ramp_stations=6, tail=0.0, tail_stations=6, scan=0.02, smooth=3, sink=0.001, ditch='Black', material='Black'):
    """Wind splits on the roof's drip rails, both sides: a rubber blade standing up out of each roof
    ditch from y0 (the windshield's top edge) to y1 (the spoiler's front), after the BMW 3.0 CSL's fender
    fins (the Wendt Strom's Wind splits). The ditch is read per station by downward rays over
    x_guess(y) +- `scan`: its `ditch` material run (the black bottom) gives the centre and width, its
    lowest hit the bottom, the higher of the paint either side the lip. The section is a foot filling the
    ditch from `sink` below its bottom up to the lip, then a blade tapering from `root` to `tip` thick
    with a rounded top, `heights` m over the lip at y0 and y1 (linear between: short, a little taller at
    the back; or a callable of y), its front rising from the lip over `ramp` m (a swept leading edge) and its back square
    against whatever follows, its top corner rounded to a quarter circle of radius `tail` m when given (over
    `tail_stations`; square, the Wendt Strom's first build read as ending abruptly). Centre, bottom and lip are smoothed along the car (`smooth` passes) so the
    donor's facets do not wobble the line. Built on +x and mirrored. Returns the +x sections."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    trees = [(o, BVHTree.FromObject(o, dg)) for o in surfaces]

    def down(x, y):
        best = None
        for o, t in trees:
            h = t.ray_cast(Vector((x, y, 3)), Vector((0, 0, -1)))
            if h[0] is not None and (best is None or h[3] < best[1]):
                best = (h[0].z, h[3], o.material_slots[o.data.polygons[h[2]].material_index].material.name.split('.')[0])
        return best

    raw = []
    # `ramp_stations` over the front ramp, where the height changes fastest, the rest evenly behind it.
    m = ramp_stations
    ys = [y0 + ramp * k / (m - 1) for k in range(m - 1)] + [y0 + ramp + (y1 - y0 - ramp) * k / (stations - m) for k in range(stations - m + 1)]
    if tail > 0:
        # The rounded back on its own stations, crowded toward the end where the arc turns down fastest.
        ys = [y for y in ys if y < y1 - tail] + [y1 - tail * (1 - math.sin(math.pi / 2 * k / tail_stations)) for k in range(tail_stations + 1)]
    for y in ys:
        xs = [x_guess(y) - scan + 0.001 * j for j in range(int(2 * scan / 0.001) + 1)]
        hits = [(x, down(x, y)) for x in xs]
        bl = [(x, h[0]) for x, h in hits if h and h[2] == ditch]
        if not bl:
            continue
        xa, xb = bl[0][0], bl[-1][0]
        inner = [h[0] for x, h in hits if h and x < xa]
        outer = [h[0] for x, h in hits if h and x > xb]
        lip = max(inner[-1] if inner else bl[0][1], outer[0] if outer else bl[-1][1])
        raw.append([y, (xa + xb) / 2, (xb - xa) / 2 + 0.0005, min(z for _, z in bl), lip])
    for _ in range(smooth):
        raw = [raw[0]] + [[r[0]] + [raw[i - 1][j] * 0.25 + r[j] * 0.5 + raw[i + 1][j] * 0.25 for j in range(1, 5)]
                          for i, r in enumerate(raw[1:-1], 1)] + [raw[-1]]
    secs = []
    for y, xc, half, zb, lip in raw:
        u = (y - y0) / (y1 - y0)
        h = heights(y) if callable(heights) else heights[0] + (heights[1] - heights[0]) * u
        if tail > 0 and y > y1 - tail:
            d = (y - (y1 - tail)) / tail
            h -= tail * (1 - math.sqrt(max(0.0, 1 - d * d)))
        h = max(h * _sstep((y - y0) / ramp), 0.0015)
        top = lip + h
        r, t = root / 2, tip / 2
        rc = min(t, h / 2)
        secs.append([(xc - half, y, zb - sink), (xc + half, y, zb - sink), (xc + half, y, lip), (xc + r, y, lip + 0.001),
                     (xc + t, y, top - rc), (xc + t * 0.7, y, top - rc * 0.3), (xc, y, top), (xc - t * 0.7, y, top - rc * 0.3),
                     (xc - t, y, top - rc), (xc - r, y, lip + 0.001), (xc - half, y, lip)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    sweep(target, [[(-x, y, z) for x, y, z in s] for s in secs], material)
    if carry:
        restore_normals(target)
    return secs


def spat(target, front, rear, base, height=0.15, rake=0.05, curl=(0.015, 0.045), curl_height=0.04, thick=0.006,
         stations=6, rows=4, fillet=None, material='Black'):
    """A splitter spat (end plate) as race cars run them: a flat plate standing on a splitter's outer
    end, straight from `front` to `rear` ((x, y) plan points, outward by the sign of x) from `base` z up
    `height` m, its outline a parallelogram (the top set back `rake` m, so the bottom front leads), its
    bottom `curl_height` m curling outward into a lip `curl` (front, rear) m wide, a quarter round
    growing toward the back. Aero: it fences the high pressure on the splitter's top from spilling
    round the end. After the user's photo; `end_plate`, a plate following the splitter's curve with
    its top curled out, was the wrong reading. `fillet` (sheet top z, size m) adds a 45 degree fillet
    joining the plate's inner face to the splitter's top, so the two read as one piece (without it the
    spat looked detached). Carries authored normals."""
    f, r = Vector(front), Vector(rear)
    along = (r - f).normalized()
    n = Vector((along.y, -along.x))
    if n.x * f.x < 0:
        n = -n
    secs = []
    for k in range(stations):
        s = k / (stations - 1)
        p = f.lerp(r, s)
        cw = curl[0] + (curl[1] - curl[0]) * s
        prof = []
        for j in range(rows + 1):
            a = (math.pi / 2) * j / rows
            prof.append((cw * (1 - math.sin(a)), curl_height * (1 - math.cos(a))))
        prof.append((0.0, height))

        def at(o, z):
            q = p + n * o + along * (rake * z / height)
            return Vector((q.x, q.y, base + z))

        outer = [at(o, z) for o, z in prof]
        inner = [at(o - thick, z) for o, z in prof]
        secs.append([tuple(v) for v in outer] + [tuple(v) for v in reversed(inner)])
    fil = []
    if fillet:
        zt, fs = fillet
        for k in range(stations):
            p = f.lerp(r, k / (stations - 1))
            z0 = zt - base
            pts = [(-thick + 0.001, z0 - 0.002), (-thick - fs, z0 - 0.002), (-thick - fs, z0), (-thick + 0.001, z0 + fs)]
            fil.append([tuple(Vector(((p + n * o + along * (rake * z / height)).x, (p + n * o + along * (rake * z / height)).y, base + z)))
                        for o, z in pts])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if fil:
        sweep(target, fil, material)
    if carry:
        restore_normals(target)
    return secs


def end_plate(target, edge, base, heights, thick=0.006, curl=0.025, curl_height=0.035, rows=6, material='Black'):
    """A splitter end plate (spat): a vertical plate standing on a splitter's outer edge, `edge` the
    edge's plan points front to back ((x, y), outward to +x or -x by their sign), from `base` z up by
    `heights` (one per point: tall at the front, lower at the back), its top `curl_height` m bending
    outward by `curl` m (a quarter round), `thick` m thick. Race splitters carry them to keep the high
    pressure on the splitter's top from spilling round its ends (the Wendt Strom's Track Wild, after a
    time attack Supra). Carries authored normals."""
    P = [Vector((p[0], p[1])) for p in edge]
    secs = []
    for i, p in enumerate(P):
        tg = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        n = Vector((tg.y, -tg.x))
        if n.x * p.x < 0:
            n = -n
        h = heights[i]
        straight = max(h - curl_height, 0.0)
        prof = [(0.0, 0.0)]
        for r in range(1, rows + 1):
            a = (math.pi / 2) * r / rows
            prof.append((curl * (1 - math.cos(a)), straight + curl_height * math.sin(a)))
        prof = [(0.0, 0.0), (0.0, straight)] + prof[1:]
        outer = [Vector((p.x + n.x * o, p.y + n.y * o, base + z)) for o, z in prof]
        inner = [Vector((p.x + n.x * (o - thick), p.y + n.y * (o - thick), base + z)) for o, z in prof]
        secs.append([tuple(v) for v in outer] + [tuple(v) for v in reversed(inner)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return secs


def over_fender(skin_objs, target, center, side, toward_end, a0, a1, width=0.032, width_end=1.0, proud=0.07, proud_end=0.25,
                lean=0.004, shelf=0.06, shelf_end=0.5, thick=0.004, foot=0.003, nose=0.002, stations=33, bolts=5,
                bolt_r=0.006, bolt_inset=0.012, bolt_margin=10, bolt_degs=None, material='Paint', bolt_material='Black',
                x_min=0.78):
    """A bolt-on over-fender flare round one arch: the stock arch flange pushed straight out, a box in
    section. `proud` m out at the top of the arch and `proud_end` of that at both legs' ends (a cosine
    taper: the user wanted the ends half the middle, "more fluid"); the band, the face seen from the side,
    stands parallel to the panel (leaning `lean` m back in over its height, "90 % flat"), `width` m tall
    (the Wendt Strom's own flange round the opening is 32 mm) and `width_end` of that at the ends; the
    shelf on top slopes from the band's top edge back onto the panel `shelf` m further up at the top of
    the arch and `shelf_end` of that at the ends (the user: a box's flat shelf read stiff, "angled like it
    was before"), ending in a `thick` m step on the panel. The lip is the flat wall straight out along x (an extrusion of the panel's outline round
    the opening), `proud` measured from the panel's outermost face within 3 cm of the arch edge, not from
    the painted edge: on a donor's rear arches that edge rolls 5 to 7 mm in behind the face, and a wall
    standing on it started tucked behind the panel and read as leaning. The wall runs `foot` m inside the
    edge from the painted edge itself up to the lip, with a `nose` m round at the top. `bolts` button heads
    sit on the shelf `bolt_inset` m from its edge on the body (the user: "on the body side of the shelf"),
    evenly `bolt_margin` degrees in from the ends or at `bolt_degs` (a piece split by a shut line wants
    its heads per segment: two on the short one, the first and last close to the ends).
    What failed before this: a band that sloped from
    the lip back to the panel (7 cm at 40 degrees, then 3.2 cm at 26 degrees once the stand-out grew) read
    as a sloped shelf from below, not a flange standing out; the user's words for the box are "the extrusion
    needs to come from the outermost panel" and "the lip ... vertical". The arch is
    measured, never assumed: at each station angle about `center` (y, z of the wheel), rays along -x from
    outside find the painted edge (the first Paint hit outboard of `x_min`, so the well's black lip is
    skipped) and the panel above it; the edge radius and x are smoothed over three stations so the donor's
    ragged arch does not wobble the band. Angles run from the car's end (`toward_end` -1 at the front, +1
    at the rear) over the top to the middle, so the legs end where a real kit's do: a0 ahead over the
    bumper, a1 behind near the sill. `skin_objs` are every piece the band may sit on (the body, the
    fenders, the bumper). The band is one `sweep` (capped square at both ends) and the heads are `tube`s.
    Returns the stations' (deg, band width, stand-out, shelf climb, edge r, edge x, panel face x, panel x at the shelf's edge) and the heads."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    trees = [(o, BVHTree.FromObject(o, dg)) for o in skin_objs]
    yc, zc = center

    def hit(y, z):
        best = None
        for o, t in trees:
            h = t.ray_cast(Vector((side * 1.4, y, z)), Vector((-side, 0, 0)), 1.0)
            if h[0] and (best is None or h[3] < best[1][3]):
                best = (o, h)
        if best is None:
            return None
        o, h = best
        return abs(h[0].x), o.data.materials[o.data.polygons[h[2]].material_index].name

    def at(a, r):
        return yc + toward_end * math.cos(a) * r, zc + math.sin(a) * r

    def skin_x(a, r):
        h = hit(*at(a, r))
        return h[0] if h else None

    def taper(deg, full, end):
        t = (deg - a0) / (a1 - a0)
        return full * (end + (1 - end) * math.sin(math.pi * t))

    band = lambda deg: taper(deg, width, width_end)
    stand = lambda deg: taper(deg, proud, proud_end)
    climb = lambda deg: taper(deg, shelf, shelf_end)

    degs = [a0 + (a1 - a0) * i / (stations - 1) for i in range(stations)]
    angs = [math.radians(d) for d in degs]
    edges = []
    for a in angs:
        e = None
        for i in range(140):
            r = 0.30 + i * 0.001
            h = hit(*at(a, r))
            if h and h[1] == 'Paint' and h[0] > x_min:
                e = (r, h[0])
                break
        if e is None:
            raise ValueError('no painted arch edge at %.1f deg' % math.degrees(a))
        edges.append(e)
    sm = lambda vals, i: sum(vals[max(0, min(len(vals) - 1, j))] for j in (i - 1, i, i + 1)) / 3
    re = [sm([e[0] for e in edges], i) for i in range(stations)]
    xe = [sm([e[1] for e in edges], i) for i in range(stations)]
    ws = [band(d) for d in degs]
    ps = [stand(d) for d in degs]
    hs = [climb(d) for d in degs]
    xo = []
    for i, a in enumerate(angs):
        xs = [skin_x(a, re[i] + ws[i] + hs[i] + d) for d in (-0.006, 0, 0.006)]
        xs = [x for x in xs if x is not None]
        xo.append(sum(xs) / len(xs) if xs else xe[i] - 0.02)
    xo = [sm(xo, i) for i in range(stations)]
    xf = []
    for i, a in enumerate(angs):
        xs = [skin_x(a, re[i] + d) for d in (0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03)]
        xf.append(max([x for x in xs if x is not None] + [xe[i]]))
    xf = [sm(xf, i) for i in range(stations)]

    def p3(a, r, x):
        y, z = at(a, r)
        return (side * x, y, z)

    def on_band(i, t):
        """The band's x at share t of its height up from the lip (the face leans `lean` back in)."""
        return xf[i] + ps[i] - lean * t

    secs = []
    for i, a in enumerate(angs):
        r, x, xw, w, xp, pr, hh = re[i], xe[i], xo[i], ws[i], xf[i], ps[i], hs[i]
        x_in = skin_x(a, r + 0.012)
        x_in = (x_in if x_in is not None else x) + 0.001
        secs.append([
            p3(a, r - foot, x + 0.002),            # the lip's foot, on the arch's painted edge
            p3(a, r - foot, xp + pr - nose),       # the lip's top, straight out from the panel's face
            p3(a, r - foot + nose, xp + pr),       # the nose
            p3(a, r + w, on_band(i, 1.0)),         # the band's top edge: the face stands beside the panel
            p3(a, r + w + hh, xw + thick),         # the shelf, sloping back onto the panel
            p3(a, r + w + hh, xw + 0.0005),        # the step down to the panel
            p3(a, r + 0.012, x_in),                # the underside, back along the panel
        ])
    sweep(target, secs, material)
    out = []
    for deg in (bolt_degs or [a0 + bolt_margin + (a1 - a0 - 2 * bolt_margin) * k / max(bolts - 1, 1) for k in range(bolts)]):
        a = math.radians(deg)
        i = min(range(stations), key=lambda j: abs(degs[j] - deg))
        r, x, xw, w, xp, pr, hh = re[i], xe[i], xo[i], ws[i], xf[i], ps[i], hs[i]
        x0, x1 = on_band(i, 1.0), xw + thick
        dr, dx = hh, x1 - x0
        t = 1 - bolt_inset / math.hypot(dr, dx)
        rb, xb = r + w + hh * t, x0 + dx * t
        # The shelf's outward normal in the (r, x) plane, turned into the car's frame at this angle.
        n_r, n_x = -dx, dr
        ln = math.hypot(n_r, n_x)
        n_r, n_x = n_r / ln, n_x / ln
        d = Vector((side * n_x, toward_end * math.cos(a) * n_r, math.sin(a) * n_r)).normalized()
        c = Vector(p3(a, rb, xb)) - d * 0.001
        tube(target, c, d, bolt_r, 0.0035, bolt_material, n=8)
        out.append(('bolt', round(deg, 1), round(rb, 3), round(xb, 3)))
    return [(round(degs[i], 1), round(ws[i], 3), round(ps[i], 3), round(hs[i], 3), round(re[i], 4), round(xe[i], 4), round(xf[i], 4), round(xo[i], 4)) for i in range(stations)] + out


def panel_groove(o, only, co, no, half=0.003, depth=0.003, reach=0.1, radius=0.15):
    """A bevelled shut line across a built piece where it crosses a seam of the body under it (an over-fender
    flare over the bumper's joint: real kits are split there, the Voomeran's in two pieces each). The faces
    whose integer face attribute `only` is set (the built piece's own: the stock panel it was copied from
    may end on the same seam, and a position test caught the Wendt Strom's fender edge) and within `reach`
    m of the plane (co, no) and `radius` m of `co` (a plane is infinite: the level front seam's plane also
    crossed the flare's other leg, over the fender) are
    bisected at the plane and `half` m either side of it; the vertices on the plane sink `depth` m along
    their normals, a V like the donor body's own panel gaps (3 to 5 mm on the Wendt Strom's sides). The
    plane holds the seam's line on the panel and the direction straight out from it, so the groove runs
    across the piece the way the joint runs across the panel. The groove's faces shade flat (their corners'
    `src_normal` zeroed: stash_normals first, restore_normals after), so its two walls catch the light.
    Returns the vertices sunk."""
    co, no = Vector(co), Vector(no).normalized()
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    tag = bm.faces.layers.int.get(only)
    near = lambda f, m: f[tag] and abs((f.calc_center_median() - co).dot(no)) < m and (f.calc_center_median() - co).length < radius
    for off in (-half, 0.0, half):
        faces = [f for f in bm.faces if near(f, reach)]
        geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co + no * off, plane_no=no)
    bm.normal_update()
    band = [f for f in bm.faces if near(f, half + 1e-4) and all(abs((v.co - co).dot(no)) <= half + 1e-5 for v in f.verts)]
    sink = {v for f in band for v in f.verts if abs((v.co - co).dot(no)) < 1e-5}
    moves = [(v, v.normal.copy()) for v in sink]
    for v, n in moves:
        v.co -= n * depth
    sn = bm.loops.layers.float_vector.get('src_normal')
    if sn is not None:
        for f in band:
            for loop in f.loops:
                loop[sn] = (0.0, 0.0, 0.0)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(sink)


def end_cap(surface, target, y, x_out, bot, ztop, toward, width=0.15, thick=0.004, samples=10, material='Black'):
    """A flat panel closing a lip's open end at a wheel well, in the plane y (`toward` +1 or -1: the side
    it is thickened to, away from the wheel): from the lip's outer edge `x_out` (sign gives the side)
    `width` m inboard, its bottom on the lip's bottom `bot`, its top following the car's underside
    (rays up through `surface`, a list of objects) and capped at `ztop` (where the air dam meets the
    body), so the lip, its dam and the car's bottom read as one wrapped piece into the fender liner.
    Built on both sides by the caller (x_out's sign). The Wendt Strom's Track Wild splitter and skirt
    ends. Carries authored normals."""
    from mathutils.bvhtree import BVHTree
    import bmesh as _bm
    bm = _bm.new()
    for o in surface:
        m2 = o.data.copy()
        m2.transform(o.matrix_world)
        bm.from_mesh(m2)
        bpy.data.meshes.remove(m2)
    t = BVHTree.FromBMesh(bm)
    sx = 1 if x_out > 0 else -1
    xs = [x_out - sx * width * k / (samples - 1) for k in range(samples)]
    tops = []
    for x in xs:
        h = t.ray_cast(Vector((x, y, bot - 0.5)), Vector((0, 0, 1)), 1.0)
        z = h[0].z if h[0] and h[0].z > bot else ztop
        tops.append(min(max(z, bot + 0.004), ztop))
    bm.free()
    loop = [(xs[-1], bot), (xs[0], bot)] + list(zip(xs, tops))
    secs = [[(x, y, z) for x, z in loop], [(x, y + toward * thick, z) for x, z in loop]]
    carry = stash_normals(target)
    sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return loop


def drape_strap(surface, target, x, root, length=0.165, width=0.04, thick=0.003, sep=0.012, clear=0.003, step=0.006,
                material='Strap'):
    """A webbing tow strap hanging as a flat loop from an eye bolt at (x, root y, root z) and draping
    over what is below it: each point of the loop's back layer moves forward just enough to clear
    `surface` (an object: the part as built so far, so a rim, an air dam or a splitter below the bolt
    are all draped over) across the strap's whole width, never back again; the front layer runs `sep` m
    ahead of it, and the two join round the bottom and over the bolt. Broad face forward, `width` m
    wide, `thick` m thick. The Wendt Strom's Track Wild, after an OMP strap: it hangs from the
    passenger intake's inboard side and drapes over the lower rim and the air dam. Carries authored
    normals."""
    from mathutils.bvhtree import BVHTree
    t = BVHTree.FromObject(surface, bpy.context.evaluated_depsgraph_get())
    ry, rz = root

    def face_y(z):
        ys = []
        for dx in (-width / 2, 0.0, width / 2):
            h = t.ray_cast(Vector((x + dx, -5, z)), Vector((0, 1, 0)), 10)
            if h[0]:
                ys.append(h[0].y)
        return min(ys) if ys else None

    back = []
    y, z, run = ry, rz, 0.0
    while run < length - sep / 2:
        f = face_y(z)
        if f is not None:
            y = min(y, f - clear - thick / 2)
        if back:
            run += (Vector((0, y, z)) - Vector((0, back[-1][0], back[-1][1]))).length
        back.append((y, z))
        z -= step
    r = sep / 2
    path = [Vector((x, by, bz)) for by, bz in back]
    by, bz = back[-1]
    path += [Vector((x, by - r + r * math.cos(a), bz - r * math.sin(a))) for a in [math.pi * k / 6 for k in range(1, 6)]]
    path += [Vector((x, b[0] - sep, b[1])) for b in reversed(back)]
    top = back[0]
    path += [Vector((x, top[0] - r - r * math.cos(a), top[1] + r * math.sin(a))) for a in [math.pi * k / 6 for k in range(1, 6)]]
    path.append(path[0])
    wdir = Vector((1, 0, 0))
    secs = []
    for i, p in enumerate(path):
        tg = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        nrm = tg.cross(wdir).normalized()
        w, h = wdir * (width / 2), nrm * (thick / 2)
        secs.append([tuple(p + w + h), tuple(p - w + h), tuple(p - w - h), tuple(p + w - h)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return path


def tow_strap(target, root, direction, length=0.10, width=0.035, strap=(0.022, 0.004), segments=20, material='Chrome',
              side=None):
    """A tow hook loop: a flat strap bent into a racetrack loop `length` m long and `width` wide from
    `root` (where it leaves the panel, a few mm inside it) along `direction`, the strap `strap`
    (width, thickness) m in section, its broad face across the loop's plane. Track cars carry one in a
    lower intake (the Wendt Strom's Track Wild, passenger side). Carries authored normals."""
    d = Vector(direction).normalized()
    # `side` sets the loop's plane (with `direction`); a webbing strap hanging down passes the car's
    # forward axis so its two layers lie front and back and its broad face looks ahead.
    side = Vector(side).normalized() if side is not None else d.cross(Vector((0, 0, 1))).normalized()
    if side.length < 1e-6:
        side = Vector((1, 0, 0))
    up = side.cross(d).normalized()
    r = width / 2
    straight = max(length - width, 0.0)
    root = Vector(root)
    # The loop's centreline: up one side, round the far end, back down the other, round the root end.
    path = []
    half = segments // 2
    for k in range(half + 1):
        a = math.pi * k / half
        path.append(root + d * (r + straight + r * math.sin(a)) + side * (r * math.cos(a)))
    for k in range(half + 1):
        a = math.pi * k / half
        path.append(root + d * (r - r * math.sin(a)) - side * (r * math.cos(a)))
    path.append(path[0])
    w, t = strap[0] / 2, strap[1] / 2
    secs = []
    for i, p in enumerate(path):
        tg = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        out = tg.cross(up).normalized()
        secs.append([tuple(p + up * w + out * t), tuple(p - up * w + out * t), tuple(p - up * w - out * t), tuple(p + up * w - out * t)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return secs


def stadium(cx, cz, r, stretch, sides=16, along='z'):
    """A stadium (a circle of radius r split and pushed `stretch` m apart each way along `along`) as
    (x, z) points counterclockwise, the outline `punch_holes(..., stretch=, along=)` cuts; front view,
    for plates laid over the holes."""
    h = sides // 2
    if along == 'z':
        top = [(cx + r * math.cos(math.pi * i / h), cz + stretch + r * math.sin(math.pi * i / h)) for i in range(h + 1)]
        bot = [(cx + r * math.cos(math.pi + math.pi * i / h), cz - stretch + r * math.sin(math.pi + math.pi * i / h)) for i in range(h + 1)]
        return top + bot
    right = [(cx + stretch + r * math.cos(-math.pi / 2 + math.pi * i / h), cz + r * math.sin(-math.pi / 2 + math.pi * i / h)) for i in range(h + 1)]
    left = [(cx - stretch + r * math.cos(math.pi / 2 + math.pi * i / h), cz + r * math.sin(math.pi / 2 + math.pi * i / h)) for i in range(h + 1)]
    return right + left


def trim_plate(surface, target, holes, cells, gap=0.001, thick=0.003, material='Black', side=-1):
    """A thin plate laid over a row of holes on a panel seen from the front: each hole ((cx, cz) and its
    counterclockwise outline as `stadium` gives it) has a convex cell around it (counterclockwise (x, z)
    points), and the plate in that cell runs from the hole's outline out to the cell's edge: each
    outline point is carried straight out from the hole's centre to the cell's edge, the cell's own
    corners filled in between. Cells share their straight dividers; the end cells' outer sides can be
    arcs, so the whole plate is a rounded rectangle whose ends follow the end holes' curve (the Wendt
    Strom's Track Wild, black like its lips, round four slots). Every point is laid onto `surface` by a
    ray along +y, `gap` m off it and `thick` m thick, so the plate follows the panel and takes its
    normals; walls run round the holes and the plate's border. A free fill (tessellate_polygon) made
    slivers that sank behind the curved bumper; cells keep every face short. `side` is the face the
    plate sits on: -1 the front (rays along +y), +1 the rear (rays along -y; the Track Wild rear's two
    slots). Carries authored normals."""
    from mathutils.bvhtree import BVHTree
    from mathutils.geometry import intersect_line_line_2d
    t = BVHTree.FromObject(surface, bpy.context.evaluated_depsgraph_get())
    me = target.data
    bm = bmesh.new()
    bm.from_mesh(me)
    sn = bm.loops.layers.float_vector.get('src_normal')
    mi = mat_index(target, material)
    cache = {}

    def vert(p):
        key = (round(p[0], 6), round(p[1], 6))
        if key not in cache:
            h = t.ray_cast(Vector((p[0], 5 * side, p[1])), Vector((0, -side, 0)), 10)
            y, n = (h[0].y, h[1].copy()) if h[0] else (2.1 * side, Vector((0, side, 0)))
            if n.y * side < 0:
                n = -n
            cache[key] = (bm.verts.new((p[0], y + side * (gap + thick), p[1])), bm.verts.new((p[0], y + side * gap, p[1])), n)
        return cache[key]

    def face(pts, facing, smooth):
        vs = [vert(p) for p in pts]
        ring = [v[0] for v in vs] if smooth else [vs[0][0], vs[1][0], vs[1][1], vs[0][1]]
        ring = [v for k, v in enumerate(ring) if v is not ring[k - 1]]
        if len(set(ring)) < 3 or bm.faces.get(ring) is not None:
            return
        f = bm.faces.new(ring)
        f.material_index = mi
        f.smooth = smooth
        f.normal_update()
        if f.normal.dot(facing) < 0:
            f.normal_flip()
        if sn is not None:
            nm = {v[0]: v[2] for v in vs}
            for loop in f.loops:
                loop[sn] = nm[loop.vert] if smooth else f.normal.copy()

    ang = lambda c, p: math.atan2(p[1] - c[1], p[0] - c[0]) % (2 * math.pi)
    fwd = Vector((0, side, 0))
    dividers = set()
    for cell in cells:
        for (ax, az), (bx, bz) in zip(cell, cell[1:] + cell[:1]):
            if abs(ax - bx) < 1e-9:
                dividers.add(round(ax, 6))
    border_x = {round(min(p[0] for c in cells for p in c), 6), round(max(p[0] for c in cells for p in c), 6)}
    for ((cx, cz), outline), cell in zip(holes, cells):
        c = (cx, cz)

        def hit(p):
            far = (cx + (p[0] - cx) * 50, cz + (p[1] - cz) * 50)
            for a, b in zip(cell, cell[1:] + cell[:1]):
                q = intersect_line_line_2d(Vector(c), Vector(far), Vector(a), Vector(b))
                if q is not None:
                    return (q.x, q.y)
            return p

        rim = [hit(p) for p in outline]
        m = len(outline)
        for i in range(m):
            j = (i + 1) % m
            a0, a1 = ang(c, outline[i]), ang(c, outline[j])
            span = (a1 - a0) % (2 * math.pi)
            mids = sorted([q for q in cell if 1e-9 < (ang(c, q) - a0) % (2 * math.pi) < span - 1e-9],
                          key=lambda q: (ang(c, q) - a0) % (2 * math.pi))
            face([outline[i], outline[j], rim[j]] + list(reversed(mids)) + [rim[i]], fwd, True)
            mid = Vector(((outline[i][0] + outline[j][0]) / 2 - cx, 0, (outline[i][1] + outline[j][1]) / 2 - cz))
            face([outline[i], outline[j]], -mid, False)
        # The border: the cell's edge, rim points and corners in order, less the shared dividers.
        uniq = {}
        for q in rim + list(cell):
            uniq.setdefault((round(q[0], 6), round(q[1], 6)), q)
        pts = sorted(uniq.values(), key=lambda q: ang(c, q))
        for i in range(len(pts)):
            p, q = pts[i], pts[(i + 1) % len(pts)]
            if abs(p[0] - q[0]) < 1e-9 and round(p[0], 6) in dividers and round(p[0], 6) not in border_x:
                continue
            if math.dist(p, q) > 1e-6:
                face([p, q], Vector(((p[0] + q[0]) / 2 - cx, 0, (p[1] + q[1]) / 2 - cz)), False)
    bm.to_mesh(me)
    bm.free()
    me.update()


def ray_map(objs, x0, x1, z0, z1, step=0.005, skip=('Lens', 'Glass', 'ClearLens'), deep=-1.8, side=1):
    """What the eye sees through the front, one letter per material: rays along +y over x0..x1, z1..z0,
    passing through `skip` (clear covers) to the first face behind. `O` marks a ray whose first hit lies
    behind `deep` (y), a hole into the car. `side=-1` looks from behind instead (rays along -y; `deep`
    is then a y the hit must lie behind, e.g. 1.8 for the tail). `look` draws every material alike and the lens covers
    opaque, so this is how a lamp or grille is judged: it found the Wendt Strom's black crescent (a
    grille back panel standing in front of the inner reflector bowls). Prints rows, returns them."""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    names = []
    for o in objs:
        tmp = bpy.data.meshes.new('ray_map')
        src = o.data.copy()
        src.transform(o.matrix_world)
        base = len(names)
        names += [m.name.split('.')[0] if m else '' for m in src.materials]
        for p in src.polygons:
            p.material_index += base
        bm.from_mesh(src)
        bpy.data.meshes.remove(src)
        bpy.data.meshes.remove(tmp)
    bm.faces.ensure_lookup_table()
    t = BVHTree.FromBMesh(bm)
    code = {'HeadLight': 'H', 'TailLight': 'T', 'BrakeLight': 'B', 'Light': 'a', 'Chrome': 'c', 'Black': '#',
            'Paint': 'p', 'Trim': 't', 'Reflector': 'r', 'Grille': 'g', 'Interior': 'i', 'RedLens': 'R', 'ClearLens': 'w', 'SmokeLens': 's', 'BlueLens': 'b', 'GreenLens': 'G', 'YellowLens': 'y', 'BrakeLens': 'k'}
    d = Vector((0, side, 0))
    rows = []
    nz = int(round((z1 - z0) / step))
    nx = int(round((x1 - x0) / step))
    for zi in range(nz + 1):
        z = z1 - zi * step
        row = ''
        for xi in range(nx + 1):
            o = Vector((x0 + xi * step, -5 * side, z))
            ch = ' '
            for _ in range(12):
                h = t.ray_cast(o, d, 10)
                if not h[0]:
                    break
                m = names[bm.faces[h[2]].material_index]
                if m not in skip:
                    ch = code.get(m, '?') if h[0].y * side < deep * side else 'O'
                    break
                o = h[0] + d * 1e-4
            row += ch
        rows.append((round(z, 3), row))
        print(f'{z:.3f} {row}')
    bm.free()
    return rows


def lamp_chamber(o, center, rows, replace='Chrome', mat='ClearLens', wall=0.022, bowl=0.012, wall_s=0.015,
                 wall_z=0.005, bulb_at=0.45, bulb=None, collar=None, segments=10, step=0.25, us=None,
                 z_rel=(0, 0.0015, 0.004, 0.008), wall_mat=None, dz=0.007, flatten=False):
    """The clear rows of a tail lamp built as a recessed chamber behind its cover, after the Wendt Strom's RCCR
    (Hella Magic Colours): a donor lamp models every row as a shell about 13 mm behind the cover, so a clear row
    re-materialed on it reads flat. The `replace` faces (the clear rows' shell, both sides) are deleted and a
    heightfield takes their place: rays fan in plan from `center` (x, y; inside the car) at each height, the
    `replace` faces' first and last hit per height give the row's ends (the outer end slants), and each grid
    point sits on its ray `wall` m deeper than the shell it replaces, plus `bowl` m at each row's middle (an
    ellipse over the row), easing back up to the shell over `wall_s` m at the ends and `wall_z` m at each
    row's top and bottom edge. So the chamber meets the kept shell at its rim, its walls slope (the inner end's
    big sloped wall in the photos), and between two rows the surface comes back up to the shell as a divider
    rib. `rows` is [(z0, z1, bulb_mat)] bottom up; each bowl's deepest point is `bulb_at` of its length from the
    inner end. `bulb` (r, length) puts a bulb there, standing toward the cover, its base sunk 3 mm into the floor
    (`collar` a material puts it on a ring of that material instead); off by default, since the user had RCCR's
    bulbs and their chrome rings removed. `us` (fractions 0 to 1 along the row) and `z_rel` (offsets from each
    row's edges, m; the rows between filled about every 7 mm) set the grid: the defaults suit a 4 to 6 cm row
    with 5 mm walls, a coarser grid suits narrow rows with steep walls (led_field).
    `dz` is the grid's spacing between a row's edges (m). `flatten` lays the surface on each column's median
    shell depth instead of the shell itself (wherever that is deeper, easing back to the shell over 5 mm at
    the outer rows' top and bottom), so the old rows' dividers, which rise to the cover, are gone: a clean
    housing for a new layout (City Golf, round_chamber); `flatten='flat'` lays it on one median depth for the
    whole surface, deep pockets in the old shell included (the City Golf's reverse strip over the stock
    bottom row's 45 mm red pocket). `wall_mat` puts every face on a wall (any corner short of the floor: the rim, the end walls, both faces
    of a divider) in that material and leaves the floor in `mat` (led_field: lens-coloured ledges round a
    black floor).
    Built on +x and mirrored. Smooth normals of its own (src_normal). Returns the new face count."""
    from mathutils.bvhtree import BVHTree
    import math
    me = o.data
    names = [m.name.split('.')[0] for m in me.materials]
    stash = stash_normals(o)
    i_mat = mat_index(o, mat)
    i_wall = mat_index(o, wall_mat) if wall_mat else i_mat
    i_collar = mat_index(o, collar) if collar else None
    for r in rows if bulb else []:
        mat_index(o, r[2])
    names = [m.name.split('.')[0] for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    mi = [f.material_index for f in bm.faces]
    tree = BVHTree.FromBMesh(bm)
    cx, cy = center

    def probe(phi, z):
        """(cover distance from the axis, shell gap behind it, shell material) along the ray at phi, z."""
        d = Vector((math.sin(phi), math.cos(phi), 0))
        base = Vector((cx, cy, z))
        h = tree.ray_cast(base + d, -d, 2.0)
        if h[0] is None or names[mi[h[2]]] != 'Lens':
            return None
        tc = (h[0] - base).length
        q = h[0] - d * 1e-4
        for _ in range(8):
            h2 = tree.ray_cast(q, -d, 1.0)
            if h2[0] is None:
                return None
            m = names[mi[h2[2]]]
            if m != 'Lens':
                return tc, tc - (h2[0] - base).length, m
            q = h2[0] - d * 1e-4
        return None

    # The rows' ends per height, from the faces being replaced.
    z_lo, z_hi = rows[0][0], rows[-1][1]
    ends = []
    z = z_lo + 0.001
    while z < z_hi:
        hits = [k * step for k in range(int(100 / step)) if (r := probe(math.radians(k * step), z)) and r[2] == replace]
        if hits:
            ends.append((z, math.radians(hits[0]), math.radians(hits[-1])))
        z += 0.004

    def end_at(z):
        if z <= ends[0][0]:
            return ends[0][1:]
        for a, b in zip(ends, ends[1:]):
            if z <= b[0]:
                f = (z - a[0]) / (b[0] - a[0])
                return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f
        return ends[-1][1:]

    def stations(a, b):
        h = b - a
        rel = list(z_rel)
        e = rel[-1]
        inner = max(1, round((h - 2 * e) / dz))
        mid = [e + (h - 2 * e) * k / inner for k in range(1, inner)]
        return [a + r for r in rel] + [a + m for m in mid] + [b - r for r in reversed(rel)]

    zs = []
    for z0, z1, _ in rows:
        for zz in stations(z0, z1):
            if not zs or zz > zs[-1] + 1e-6:
                zs.append(zz)
    us = us or [0, 0.01, 0.025, 0.045, 0.07] + [0.07 + 0.86 * k / 18 for k in range(1, 18)] + [0.93, 0.955, 0.975, 0.99, 1]
    smooth = lambda x: 0 if x <= 0 else 1 if x >= 1 else x * x * (3 - 2 * x)

    lines = []
    for z in zs:
        p0, p1 = end_at(z)
        line = []
        for u in us:
            phi = p0 + (p1 - p0) * u
            r = probe(phi, z)
            line.append((u, phi, r))
        # Fill a ray that missed (at the lamp's edge) from its neighbour along the row.
        for k in range(len(line)):
            if line[k][2] is None:
                nb = next((line[j][2] for j in sorted(range(len(line)), key=lambda j: abs(j - k)) if line[j][2]), None)
                line[k] = (line[k][0], line[k][1], nb)
        lines.append((z, p0, p1, line))
    if flatten == 'flat':
        every = sorted(pt[2][1] for ln in lines for pt in ln[3])
        med_all = every[len(every) // 2]
    elif flatten:
        med = [sorted(ln[3][j][2][1] for ln in lines)[len(lines) // 2] for j in range(len(us))]
    grid, wgrid = [], []
    for z, p0, p1, line in lines:
        row = next(r for r in rows if r[0] - 1e-6 <= z <= r[1] + 1e-6)
        z_edge = min(abs(z - r_[k]) for r_ in rows for k in (0, 1))
        arc = line[len(line) // 2][2][0] * (p1 - p0)
        zc, b = (row[0] + row[1]) / 2, (row[1] - row[0]) / 2
        pts, wl = [], []
        for j, (u, phi, (tc, gap, _)) in enumerate(line):
            if flatten == 'flat':
                # One depth for the whole surface (a deep pocket in the old shell comes up to it too), easing back
                # to the shell over 5 mm at the top and bottom and 10 mm at the ends, where it meets the cover.
                outer = smooth(min(z - z_lo, z_hi - z) / 0.005) * smooth(min(u, 1 - u) * arc / 0.01)
                gap = gap + (med_all - gap) * outer
            elif flatten:
                outer = smooth(min(z - z_lo, z_hi - z) / 0.005)
                gap = max(gap, gap + (med[j] - gap) * outer)
            w = smooth(min(u, 1 - u) * arc / wall_s) * smooth(z_edge / wall_z)
            rho = ((u - bulb_at) / max(bulb_at, 1 - bulb_at)) ** 2 + ((z - zc) / b) ** 2
            depth = gap + w * (wall + bowl * max(0.0, 1 - rho))
            d = Vector((math.sin(phi), math.cos(phi), 0))
            pts.append(Vector((cx, cy, z)) + d * (tc - depth))
            wl.append(w)
        grid.append(pts)
        wgrid.append(wl)

    # Bulbs: on each row's bowl floor, standing along the ray toward the cover.
    bulbs = []
    for z0, z1, _ in rows:
        zc = (z0 + z1) / 2
        p0, p1 = end_at(zc)
        phi = p0 + (p1 - p0) * bulb_at
        tc, gap, _ = probe(phi, zc)
        d = Vector((math.sin(phi), math.cos(phi), 0))
        bulbs.append((Vector((cx, cy, zc)) + d * (tc - gap - wall - bowl), d))

    gone = [f for f in bm.faces if names[f.material_index] == replace]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    sn = bm.loops.layers.float_vector.get('src_normal')
    made, field = [], []
    for sgn in (1, -1):
        flip = sgn < 0
        mir = lambda v: Vector((v.x * sgn, v.y, v.z))
        vs = [[bm.verts.new(mir(p)) for p in line] for line in grid]
        for i in range(len(vs) - 1):
            for j in range(len(us) - 1):
                q = [vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]]
                f = bm.faces.new(q[::-1] if flip else q)
                f.material_index = i_wall if min(wgrid[i][j], wgrid[i][j + 1], wgrid[i + 1][j], wgrid[i + 1][j + 1]) < 0.98 else i_mat
                field.append(f)
        r, length = bulb or (0, 0)
        base = [(0, -0.003, i_collar), (r * 1.4, -0.003, i_collar), (r * 1.4, 0.004, i_collar), (r, 0.004, None)] if collar else [(0, -0.003, None), (r, -0.003, None)]
        prof = base + [(r, length * 0.65, None), (r * 0.85, length * 0.82, None), (r * 0.5, length * 0.95, None), (0, length, None)]
        for (P, d), (_, _, bm_mat) in zip(bulbs if bulb else [], rows):
            P, d = mir(P), mir(d)
            a = d.orthogonal().normalized()
            c = d.cross(a)
            ringv = []
            for rr, hh, _ in prof:
                if rr == 0:
                    ringv.append([bm.verts.new(P + d * hh)])
                else:
                    ringv.append([bm.verts.new(P + d * hh + (a * math.cos(2 * math.pi * k / segments) + c * math.sin(2 * math.pi * k / segments)) * rr) for k in range(segments)])
            for k in range(len(prof) - 1):
                lo, hi = ringv[k], ringv[k + 1]
                m = prof[k][2] if prof[k][2] is not None else mat_index(o, bm_mat)
                for s_ in range(segments):
                    t_ = (s_ + 1) % segments
                    if len(lo) == 1:
                        q = [lo[0], hi[t_], hi[s_]]
                    elif len(hi) == 1:
                        q = [lo[s_], lo[t_], hi[0]]
                    else:
                        q = [lo[s_], lo[t_], hi[t_], hi[s_]]
                    f = bm.faces.new(q)  # built round its own axis on each side: no flip
                    f.material_index = m
                    made.append(f)
    bm.normal_update()
    # The heightfield faces outward (toward the cover): flip the lot if the winding came out inward.
    out = Vector((math.sin(0.7), math.cos(0.7), 0))
    if field[len(us) * 3].normal.dot(out) < 0:
        bmesh.ops.reverse_faces(bm, faces=field)
        bm.normal_update()
    made += field
    if stash and sn:
        for f in made:
            for lp in f.loops:
                lp[sn] = lp.vert.normal
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return len(made)


def led_field(o, center, z0, z1, rows=4, pitch=0.038, r=0.0105, cup_depth=0.016, wall=0.024, bowl=0.006, back='Black',
              cup='ClearLens', led='SmokeLens', shelf='ClearLens', replace='Chrome', margin=0.018, segments=8, step=0.25):
    """An LED tail lamp's field after the Wendt Strom's Sex Spec lamps (aftermarket Mk4 LED units): `rows` rows of
    round LED cups between thin shelves, in place of the `replace` faces between z0 and z1 (re-material that
    part of the lamp's shell first). The field is `lamp_chamber` with one narrow row per LED row, built like
    the chambers (the user: "take some notes from chambers for depth"; the first build, a flat tray 20 mm
    deep with 3 mm walls and only the shelves' crests coloured, read flat): a `back` floor `wall` m deeper
    than the old shell with a `bowl` dish per row, 4 mm walls up to the shell between rows (the shelves) and
    15 mm sloped walls at the ends, every wall face in `shelf` (`wall_mat`), so the ledges shade round the
    dark floor. On the tray's
    floor, centred in each row, cups `pitch` m apart along the row (as many as fit `margin` m in from its ends,
    so the narrower top rows get fewer, as on the real lamps): a cone opening toward the cover, `r` m across
    its mouth and `cup_depth` deep, in `cup`, with a small conical LED at its bottom in `led`. Cups and LEDs
    stand along the plan rays from `center`, shade smooth (src_normal), and are mirrored to -x. Returns the
    cup count per side."""
    from mathutils.bvhtree import BVHTree
    import math
    h = (z1 - z0) / rows
    zs = [z0 + h * k for k in range(rows + 1)]
    lamp_chamber(o, center, [(zs[k], zs[k + 1], cup) for k in range(rows)], replace=replace, mat=back, wall=wall,
                 bowl=bowl, wall_s=0.015, wall_z=0.004, wall_mat=shelf, z_rel=(0, 0.0015, 0.004),
                 us=[0, 0.01, 0.025, 0.045, 0.07] + [0.07 + 0.86 * k / 8 for k in range(1, 8)] + [0.93, 0.955, 0.975, 0.99, 1])
    me = o.data
    i_cup, i_led, i_shelf = mat_index(o, cup), mat_index(o, led), mat_index(o, shelf)
    names = [m.name.split('.')[0] for m in me.materials]
    stash = stash_normals(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    mi = [f.material_index for f in bm.faces]
    tree = BVHTree.FromBMesh(bm)
    cx, cy = center

    def hit(phi, z):
        """(cover distance, depth behind the cover of the first face that is not Lens, its material) on the ray."""
        d = Vector((math.sin(phi), math.cos(phi), 0))
        base = Vector((cx, cy, z))
        hh = tree.ray_cast(base + d, -d, 2.0)
        if hh[0] is None or names[mi[hh[2]]] != 'Lens':
            return None
        tc = (hh[0] - base).length
        q = hh[0] - d * 1e-4
        for _ in range(8):
            h2 = tree.ray_cast(q, -d, 1.0)
            if h2[0] is None:
                return None
            if names[mi[h2[2]]] != 'Lens':
                return tc, tc - (h2[0] - base).length, names[mi[h2[2]]], h2[2]
            q = h2[0] - d * 1e-4
        return None

    # Cups along each row's floor.
    cups = []
    for k in range(rows):
        zc = (zs[k] + zs[k + 1]) / 2
        floor = [(kk * step, res) for kk in range(int(100 / step))
                 if (res := hit(math.radians(kk * step), zc)) and res[2] == back and res[1] > wall * 0.8]
        if not floor:
            continue
        p0, p1 = math.radians(floor[0][0]), math.radians(floor[-1][0])
        tc = floor[len(floor) // 2][1][0]
        arc = tc * (p1 - p0) - 2 * margin
        n = max(1, int(arc / pitch) + 1)
        for i in range(n):
            phi = p0 + (margin / tc) + (arc / tc) * ((i + 0.5) / n if n > 1 else 0.5)
            res = hit(phi, zc)
            if not res:
                continue
            tcv, depth = res[0], res[1]
            d = Vector((math.sin(phi), math.cos(phi), 0))
            cups.append((Vector((cx, cy, zc)) + d * (tcv - depth + 0.0005), d))
    counts = {}
    made = []
    sn = bm.loops.layers.float_vector.get('src_normal')
    for sgn in (1, -1):
        mir = lambda v: Vector((v.x * sgn, v.y, v.z))
        for P, d in cups:
            # Each cup is built in its own frame round its mirrored axis, not mirrored vertex by vertex, so its
            # winding needs no flip on -x (a flip there turned the passenger side's cups inside out).
            P, d = mir(P), mir(d)
            a = d.orthogonal().normalized()
            b = d.cross(a)
            ring = lambda rr, hh: [bm.verts.new(P + d * hh + (a * math.cos(2 * math.pi * j / segments) + b * math.sin(2 * math.pi * j / segments)) * rr) for j in range(segments)]
            lo, hi = ring(r * 0.3, 0.0), ring(r, cup_depth)
            for j in range(segments):
                t_ = (j + 1) % segments
                q = [lo[j], hi[j], hi[t_], lo[t_]]          # the cone's inside faces the cover
                f = bm.faces.new(q)
                f.material_index = i_cup
                made.append(f)
            base = ring(r * 0.3, 0.0)
            tip = bm.verts.new(P + d * 0.007)
            for j in range(segments):
                t_ = (j + 1) % segments
                q = [base[j], base[t_], tip]
                f = bm.faces.new(q)
                f.material_index = i_led
                made.append(f)
        counts[sgn] = len(cups)
    bm.normal_update()
    # Winding check on the first +x cup: its inside must face out along the ray, toward the cover.
    P0, d0 = cups[0]
    cone = made[:segments]
    if sum(f.normal.dot(d0) for f in cone) < 0:
        bmesh.ops.reverse_faces(bm, faces=[f for f in made if f.material_index == i_cup])
    led_faces = made[segments:2 * segments]
    if sum(f.normal.dot(d0) for f in led_faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=[f for f in made if f.material_index == i_led])
    bm.normal_update()
    if stash and sn:
        for f in made:
            for lp in f.loops:
                lp[sn] = lp.vert.normal
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return len(cups)


def round_chamber(o, center, r, profile, segments=40, smooth=(), keep=lambda c, m: m == 'Lens'):
    """A round lamp chamber set into a tail lamp's shell, after the Wendt Strom's City Golf lamps (the Mk4 City
    Golf's round tail lamp: a faceted reflector bowl, a chrome ring, a round inner lens). `center` (x, z) and
    `r` (m) on the +x lamp, seen from behind; mirrored to -x. Every shell face not kept by `keep(centre,
    material)` with a corner inside the circle (and its centre within 1.15 r) is deleted, and a polar grid takes its place, each point on a
    ray along -y from behind: `profile` is [(rho, depth, material)] from the middle out (rho a fraction of `r`,
    depth m behind the shell the deleted faces made, read by rays before the delete), each band between two
    rings in the inner ring's material. Out past rho 1 it carries on 1 mm behind the shell to the hole's
    farthest corner, so the deleted faces' ragged edge is filled from behind (the kept shell in front of it).
    Bands whose material is in `smooth` shade smooth (the ring, the lens); the rest keep flat facets (the
    reflector's). Returns the new face count."""
    from mathutils.bvhtree import BVHTree
    import math
    me = o.data
    stash = stash_normals(o)
    for _, _, m in profile:
        mat_index(o, m)
    names = [m.name.split('.')[0] for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    mi = [f.material_index for f in bm.faces]
    tree = BVHTree.FromBMesh(bm)
    xc, zc = center

    def shell_y(x, z):
        """The y of the first face behind the cover along -y at (x, z), or None outside the lamp."""
        h = tree.ray_cast(Vector((x, 5, z)), Vector((0, -1, 0)), 10)
        if h[0] is None:
            return None
        if names[mi[h[2]]] != 'Lens':
            return h[0].y  # at the lamp's edge, where the shell meets the cover, a ray can meet the shell first
        q = h[0] - Vector((0, 1e-4, 0))
        for _ in range(8):
            h2 = tree.ray_cast(q, Vector((0, -1, 0)), 1.0)
            if h2[0] is None:
                return None
            if names[mi[h2[2]]] != 'Lens':
                return h2[0].y
            q = h2[0] - Vector((0, 1e-4, 0))
        return None

    gone, far = [], 1.0
    for f in bm.faces:
        if keep(f.calc_center_median(), names[f.material_index]):
            continue
        rho = [math.hypot(abs(v.co.x) - xc, v.co.z - zc) / r for v in f.verts]
        c = f.calc_center_median()
        # A face with a corner in the circle goes, unless it lies mostly outside it (centre past 1.15): on a lamp's
        # corner wrap such a face is edge-on from behind, and the fill seen along y left a hole where it was.
        if min(rho) < 1.0 and math.hypot(abs(c.x) - xc, c.z - zc) / r < 1.15:
            gone.append(f)
            far = max(far, max(rho))
    rings = [p_[0] for p_ in profile]
    outer = [1.0 + 0.05 * k for k in range(1, int((far - 1.0) / 0.05) + 2)]
    grid = []  # per ring: [point or None] per segment
    for rho in rings + outer:
        line = []
        for s_ in range(segments):
            a = 2 * math.pi * s_ / segments
            x, z = xc + rho * r * math.cos(a), zc + rho * r * math.sin(a)
            y = shell_y(x, z)
            if y is None:
                line.append(None)
                continue
            depth = next((d for rr, d, _ in profile if abs(rr - rho) < 1e-9), 0.001)
            line.append(Vector((x, y - depth, z)))
        grid.append(line)
    # A point the rays missed inside the circle (none should) takes its ring neighbour's.
    for line in grid[:len(rings)]:
        for s_ in range(segments):
            if line[s_] is None:
                line[s_] = next((line[(s_ + k) % segments] for k in range(1, segments) if line[(s_ + k) % segments]), None)
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    sn = bm.loops.layers.float_vector.get('src_normal')
    # Band k (between ring k and k + 1) takes ring k's material; the fill past rho 1 the outermost's.
    band_mat = [mat_index(o, m) for _, _, m in profile] + [mat_index(o, profile[-1][2])] * len(outer)
    band_smooth = [m in smooth for _, _, m in profile] + [False] * len(outer)
    made, flags = [], []  # flags: shade smooth (BMFace wrappers do not hash stably, so no set)
    for sgn in (1, -1):
        mir = lambda v: Vector((v.x * sgn, v.y, v.z))
        vs = []
        for k, line in enumerate(grid):
            if k == 0 and rings[0] == 0:
                c = bm.verts.new(mir(line[0]))
                vs.append([c] * segments)
            else:
                vs.append([bm.verts.new(mir(p)) if p is not None else None for p in line])
        for k in range(len(vs) - 1):
            lo, hi = vs[k], vs[k + 1]
            for s_ in range(segments):
                t_ = (s_ + 1) % segments
                q = [lo[s_], lo[t_], hi[t_], hi[s_]]
                if any(v is None for v in q):
                    continue
                q = list(dict.fromkeys(q))  # the centre fan's two inner corners are one vertex
                f = bm.faces.new(q[::-1] if sgn < 0 else q)
                f.material_index = band_mat[k]
                made.append(f)
                flags.append(band_smooth[k])
    bm.normal_update()
    # Everything faces the viewer behind the car (+y): flip the lot if the winding came out the other way.
    if sum(f.normal.y for f in made) < 0:
        bmesh.ops.reverse_faces(bm, faces=made)
        bm.normal_update()
    if stash and sn:
        for f, smooth_f in zip(made, flags):
            for lp in f.loops:
                lp[sn] = lp.vert.normal if smooth_f else f.normal
    bm.to_mesh(me)
    bm.free()
    restore_normals(o)
    return len(made)


def save_working_copy(cids, path):
    """The save step before saveCar.py: drop the `preview` collection, remap every Car and Parts mesh
    onto the shared materials, show every collection and unhide the car pieces (`show` toggles
    collections, an object hidden with hide_set stays hidden and drops out of the export), hide the
    loose objects at the scene root, and save a copy of the session at `path` (the session's own file
    is untouched). Then: blender -b <path> --python scripts/blender/saveCar.py -- <cid> <cid>.blend."""
    # An object left in Edit Mode (the user inspecting it) saves fine but breaks exportCar's select_all.
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    pc = bpy.data.collections.get('preview')
    if pc:
        for o in list(pc.objects):
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(pc)
    for cid in cids:
        for sub in ('Car', 'Parts'):
            for o in bpy.data.collections[f'{cid}:{sub}'].objects:
                if o.type == 'MESH':
                    remap_materials(o)
                o.hide_set(False)
    show()
    for o in bpy.context.scene.collection.objects:
        if o.type != 'CAMERA':
            o.hide_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)


def split_off(src, name, pred, cname=None):
    """Move the faces for which pred(center, material_name, normal) is true out of src into a new object
    `name` (in src's collection, or `cname`). Unlike split_parts this carries custom normals through the
    bmesh round trip (bmesh drops them): a donor body's authored shading (`authored_normals`) survives on
    both halves, so a stock bumper and the body it came off shade alike at the seam. `cut` the seam first
    so the faces part along a clean edge. Returns the new object."""
    me = src.data
    names = [m.name.split('.')[0] for m in me.materials]
    carry = stash_normals(src)
    keep = {p.index for p in me.polygons if pred(p.center, names[p.material_index], p.normal)}
    part = src.copy()
    part.data = me.copy()
    part.name = name
    part.data.name = name
    (coll(cname) if cname else src.users_collection[0]).objects.link(part)
    for o, gone in ((part, lambda i: i not in keep), (src, lambda i: i in keep)):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if gone(f.index)], context='FACES')
        bm.to_mesh(o.data)
        bm.free()
        if carry:
            restore_normals(o)
        o.data.update()
    return part


def box(o, c0, c1, name):
    """An axis aligned box between two corners (mirrors, handles, interior blocks); corners in any order."""
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


def fillet_polygon(points, radii, segs=4):
    """A 2D outline (a list of (a, b)) with each corner rounded by its radius in `radii` (one per point, 0
    keeps it sharp; convex and concave corners alike), each arc `segs` segments, for `cut_plate` outlines
    and windows: a swan neck's corners and lightening holes (sheet parts are cut with radii, and square
    corners read unfinished). A radius too big for its two edges shrinks to fit half of the shorter one."""
    out = []
    k = len(points)
    for i in range(k):
        a, b, c = Vector(points[i - 1]), Vector(points[i]), Vector(points[(i + 1) % k])
        r = radii[i]
        u, v = a - b, c - b
        lu, lv = u.length, v.length
        u.normalize()
        v.normalize()
        th = math.acos(max(-1.0, min(1.0, u.dot(v))))
        if r <= 0 or th < 1e-4 or th > math.pi - 1e-4:
            out.append((b.x, b.y))
            continue
        t = min(r / math.tan(th / 2), lu / 2, lv / 2)
        r = t * math.tan(th / 2)
        p, q = b + u * t, b + v * t
        ctr = b + (u + v).normalized() * (r / math.sin(th / 2))
        a0, a1 = math.atan2(p.y - ctr.y, p.x - ctr.x), math.atan2(q.y - ctr.y, q.x - ctr.x)
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        out += [(ctr.x + r * math.cos(a0 + da * s / segs), ctr.y + r * math.sin(a0 + da * s / segs)) for s in range(segs + 1)]
    return out


def dome_head(o, center, normal, r, name='Chrome', sides=None):
    """A round domed bolt head sitting on a surface at `center` facing `normal`: a fan of `sides` triangles
    (12, or 8 under 5 mm) rising 0.37 r to its crown, its rim 0.3 mm into the surface so no gap shows, open
    underneath, smooth. The house head: Track Wild's wing swapped the Arashi's square fasteners for these, and
    every bolt on a part since uses them (`fastener`)."""
    n = Vector(normal).normalized()
    sides = sides or (8 if r < 0.005 else 12)
    u = n.orthogonal().normalized()
    w = n.cross(u)
    c = Vector(center)
    ring = [c - n * 0.0003 + (u * math.cos(2 * math.pi * i / sides) + w * math.sin(2 * math.pi * i / sides)) * r for i in range(sides)]
    verts = [tuple(c + n * 0.37 * r)] + [tuple(p) for p in ring]
    faces = [(0, 1 + i, 1 + (i + 1) % sides) for i in range(sides)]
    me = o.data
    f0 = len(me.polygons)
    add_geom(o, verts, faces, name, outward=n)
    for p in me.polygons[f0:]:
        p.use_smooth = True


def fastener(o, center, normal, washer_r=0.014, head_r=0.0098, washer_t=0.003, name='Chrome'):
    """The house bolt: a 10-sided flat washer (`tube`, the 28 mm washers under Track Wild's rods) on the
    surface at `center`, a `dome_head` on top, both facing `normal`. Scale it with the plate it holds
    (Track Mild's tabs: 13 mm washers; Track Wild's hatch plates 16 mm)."""
    n = Vector(normal).normalized()
    c = Vector(center) - n * 0.0005
    tube(o, c, n, washer_r, washer_t + 0.0005, name, n=10)
    dome_head(o, c + n * (washer_t + 0.0005), n, head_r, name)


def surface_plate(o, surfaces, origin, u, v, direction, size, thick=0.005, below=0.002, steps=(4, 6), corner=0.0,
                  arc=3, name='Black'):
    """A flat-cut mounting plate laid on a curved surface: a grid of steps[0] x steps[1] cells over
    `size` = (along u, along v) m centred on `origin`, each point cast along `direction` onto `surfaces`
    (BVH trees), its top `thick` m above the hit and its bottom `below` m under it along the hits' mean
    normal, closed with walls. Use it where a plate must follow a panel the plate's own plane cannot (a
    hatch face that yaws and curves under a wing upright); `cut_plate` extruded across x floats on one side
    of a yawed panel. `corner` m rounds its four corners in plan (the user: square plates read unfinished):
    `arc` extra rows at each end, each row narrowed to the rounded rectangle's width there, so the grid
    stays quads and still follows the panel. Returns the mean normal (for `fastener`)."""
    o0, u, v, d = Vector(origin), Vector(u).normalized(), Vector(v).normalized(), Vector(direction).normalized()
    nu, nv = steps
    W, L = size
    r = min(corner, W / 2, L / 2)
    if r > 0:
        # Rows: the straight middle between the corner arcs, then `arc` rows round each end.
        mid = [-(L / 2 - r) + (L - 2 * r) * j / nv for j in range(nv + 1)]
        ends = [(L / 2 - r + r * math.sin(math.pi / 2 * k / arc), W / 2 - r + r * math.cos(math.pi / 2 * k / arc)) for k in range(1, arc + 1)]
        rows = [(-a, w) for a, w in reversed(ends)] + [(a, W / 2) for a in mid] + ends
    else:
        rows = [(L * (j / nv - 0.5), W / 2) for j in range(nv + 1)]
    nv = len(rows) - 1
    hits, normals = [], []
    for a, hw in rows:
        for i in range(nu + 1):
            p = o0 + u * hw * (2 * i / nu - 1) + v * a
            best = None
            for t in surfaces:
                h = t.ray_cast(p - d * 1.0, d, 3.0)
                if h[0] is not None and (best is None or h[3] < best[3]):
                    best = h
            if best is None:
                raise ValueError('surface_plate: no surface under %s' % tuple(round(x, 3) for x in p))
            hits.append(best[0])
            normals.append(best[1] if best[1].dot(d) < 0 else -best[1])
    n = sum(normals, Vector()).normalized()
    k = len(hits)
    verts = [tuple(h + n * thick) for h in hits] + [tuple(h - n * below) for h in hits]
    idx = lambda i, j: j * (nu + 1) + i
    faces = []
    for j in range(nv):
        for i in range(nu):
            a, b, c2, e = idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)
            faces += [(a, b, c2, e), (k + a, k + e, k + c2, k + b)]
    rim = [idx(i, 0) for i in range(nu)] + [idx(nu, j) for j in range(nv)] + [idx(i, nv) for i in range(nu, 0, -1)] + [idx(0, j) for j in range(nv, 0, -1)]
    for a, b in zip(rim, rim[1:] + rim[:1]):
        faces.append((a, k + a, k + b, b))
    add_geom(o, verts, faces, name)
    return n


def mount_on_body(sp, body_objs, dys, foot=0.15, clear=0.01, glass_gap=0.025):
    """Mount a spoiler on the body. For each shift along y (dys, nearest first) the spoiler needs
    every foot vertex (the lowest `foot` share of its height) over a non Glass surface; it is
    lifted until every other vertex clears the paint by `clear` and the glass by `glass_gap`,
    then the feet are stretched down onto the paint so the struts stand on the body.
    Returns (dy, dz) or None."""
    verts, polys, mats = [], [], []
    for ob in body_objs:
        base = len(verts)
        verts += [ob.matrix_world @ v.co for v in ob.data.vertices]
        for p in ob.data.polygons:
            polys.append([base + i for i in p.vertices])
            mats.append(ob.data.materials[p.material_index].name.split('.')[0])
    tree = BVHTree.FromPolygons(verts, polys)
    down = Vector((0, 0, -1))

    def top(x, y):
        hit = tree.ray_cast(Vector((x, y, 5)), down)
        return (hit[0].z, mats[hit[2]]) if hit[0] else (None, None)

    vs = [v.co.copy() for v in sp.data.vertices]
    z0 = min(c.z for c in vs)
    z1 = max(c.z for c in vs)
    feet = {i for i, c in enumerate(vs) if c.z < z0 + (z1 - z0) * foot}
    for dy in sorted(dys, key=abs):
        hits = {i: top(vs[i].x, vs[i].y + dy) for i in feet}
        if any(h[0] is None or h[1] == 'Glass' for h in hits.values()):
            continue
        dz = max(h[0] - vs[i].z for i, h in hits.items())
        for i, c in enumerate(vs):
            if i in feet:
                continue
            hz, hm = top(c.x, c.y + dy)
            if hz is not None:
                dz = max(dz, hz + (glass_gap if hm == 'Glass' else clear) - c.z)
        for v in sp.data.vertices:
            v.co.y += dy
            v.co.z += dz
        for i in feet:
            v = sp.data.vertices[i]
            v.co.z = hits[i][0] - 0.002
        sp.data.update()
        return dy, dz
    return None


def slab(o, outer, inner, z0, z1, name):
    """A plate between two polylines (lists of (x, y) at matching samples) from z0 to z1: splitters,
    diffuser plates, skirt blades."""
    n = len(outer)
    verts = [(x, y, z0) for x, y in outer] + [(x, y, z0) for x, y in inner] + [(x, y, z1) for x, y in outer] + [(x, y, z1) for x, y in inner]
    faces = []
    for i in range(n - 1):
        a, b = i, i + 1
        faces += [(a, b, n + b, n + a), (2 * n + a, 3 * n + a, 3 * n + b, 2 * n + b), (a, 2 * n + a, 2 * n + b, b), (n + a, n + b, 3 * n + b, 3 * n + a)]
    faces += [(0, n, 3 * n, 2 * n), (n - 1, 2 * n + n - 1, 3 * n + n - 1, 2 * n - 1)]
    add_geom(o, verts, faces, name)


def fin(o, base, length_dir, length, height, thickness, name, up=(0, 0, 1)):
    """A thin box from base along length_dir, `height` along up: canards, diffuser strakes."""
    d = Vector(length_dir).normalized()
    u = Vector(up).normalized()
    s = d.cross(u).normalized() * (thickness / 2)
    b = Vector(base)
    corners = [b - s, b + s, b + s + d * length, b - s + d * length]
    verts = [tuple(c) for c in corners] + [tuple(c + u * height) for c in corners]
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    add_geom(o, verts, faces, name)


# ----- looking -------------------------------------------------------------

def cam(target, direction, dist=3.0, lens=50, res=(1200, 700)):
    """Aim the scene camera at target from target + direction * dist, then call look(mode='camera').
    look's own angle views auto frame everything visible and are poor for close ups."""
    c = bpy.data.objects.get('MCP_Cam')
    if not c:
        c = bpy.data.objects.new('MCP_Cam', bpy.data.cameras.new('MCP_Cam'))
        bpy.context.scene.collection.objects.link(c)
    t = Vector(target)
    d = Vector(direction).normalized()
    c.location = t + d * dist
    c.rotation_mode = 'QUATERNION'
    c.rotation_quaternion = (-d).to_track_quat('-Z', 'Y')
    c.data.lens = lens
    s = bpy.context.scene
    s.camera = c
    s.render.resolution_x, s.render.resolution_y = res


def preview(groups, gap=2.2, wheels=None):
    """Lay out groups of object names side by side (x = i * gap) as linked duplicates in a 'preview'
    collection and hide everything else. wheels=(wheel object, x, axle_y, radius) adds four wheels per group."""
    c = coll('preview')
    for o in list(c.objects):
        bpy.data.objects.remove(o)
    for i, names in enumerate(groups):
        for n in names:
            src = bpy.data.objects[n]
            o = src.copy()
            c.objects.link(o)
            o.location.x = src.location.x + i * gap
            o.hide_set(False)
        if wheels:
            ws, wx, wy, r = wheels
            w = bpy.data.objects[ws]
            half = (bb(w)[1].z - bb(w)[0].z) / 2
            for sx in (1, -1):
                for sy in (1, -1):
                    o = w.copy()
                    c.objects.link(o)
                    k = r / half
                    o.location = (sx * wx + i * gap, sy * wy, r)
                    o.scale = (k * sx, k, k)
    show(['preview'])


def shading(kind='MATERIAL', color_type=None):
    """Viewport shading for look: 'MATERIAL' for real colors, 'SOLID' + color_type='OBJECT' to color parts by o.color."""
    for a in bpy.context.screen.areas:
        if a.type == 'VIEW_3D':
            sh = a.spaces[0].shading
            sh.type = kind
            if color_type:
                sh.color_type = color_type


# ----- wings ----------------------------------------------------------------
# A GT wing is a straight airfoil on plate uprights. The uprights are laser cut plates with
# windows between bars, which is a flat polygon with holes: tessellate_polygon fills a flat plate
# cleanly (its slivers only mattered on a curved panel), so these are the one place it is used.
# The caller lays out the windows (each a convex region between the bars, inset by half the bar
# width with inset_polygon) and cut_plate cuts them; see /parts for the Track Wild wing's layout.

def airfoil(chord, thick=0.15, n=7):
    """An inverted flat top airfoil as (u, w) points round the section, u along the chord from the
    nose, w up: a flat pressure side on top, the camber underneath (a NACA 4 digit thickness law,
    all of it on the lower side, so the law's half thickness is doubled), max thickness `thick` × chord
    at 30 %, a 1 mm trailing edge.
    `n` points along each side; starts at the trailing edge and runs forward along the top."""
    def t(u):
        return 10 * thick * chord * (0.2969 * math.sqrt(u) - 0.1260 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4)
    us = [1 - (i / n) ** 1.6 for i in range(n + 1)]  # dense toward the nose
    top = [(u * chord, -0.0012 * (1 - u)) for u in us[:-1]]
    nose = [(0.0, -0.35 * t(0.03))]
    bottom = [(u * chord, -t(u) - 0.001) for u in reversed(us[:-1])]
    bottom[-1] = (chord, -0.001)
    return top + nose + bottom


def gt_wing(o, span, chord, le, aoa, name, thick=0.15):
    """A straight single element wing: the airfoil's nose at `le` (y, z), `aoa` degrees nose down
    (the trailing edge rises, so the wing presses down), run across x by `span`, capped square."""
    a = math.radians(aoa)
    sec = []
    for u, w in airfoil(chord, thick):
        y = le[0] + u * math.cos(a) - w * math.sin(a)
        z = le[1] + u * math.sin(a) + w * math.cos(a)
        sec.append((y, z))
    sweep(o, [[(-span / 2, y, z) for y, z in sec], [(span / 2, y, z) for y, z in sec]], name)
    return sec


def inset_polygon(pts, d):
    """A convex polygon (list of (a, b)) shrunk by `d`: the polygon clipped by every edge's inward
    offset half plane (Sutherland-Hodgman), so an acute corner is cut off rather than thrown far away
    as the moved edges' intersection would (that blew a sliver window out of its plate), and a region
    thinner than 2 `d` comes back empty. Convex only: a concave edge's half plane, extended, clips
    the far side of the polygon away (a window bounded by the hatch skin's bulge came back empty).
    `d` may be a list, one inset per edge (edge i runs from pts[i] to pts[i + 1]): a truss window sits
    further from the edge that carries the load (Track Mild's swan necks: the leading edge read weak at
    the common rim). Winding is normalised; the result is counterclockwise."""
    n = len(pts)
    ds = list(d) if isinstance(d, (list, tuple)) else [d] * n
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area < 0:
        pts = pts[::-1]
        ds = [ds[(n - 2 - i) % n] for i in range(n)]
    poly = [Vector(p) for p in pts]
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[(i + 1) % n])
        e = (b - a).normalized()
        nrm = Vector((-e.y, e.x))  # left of the edge, the inside of a counterclockwise loop
        p0 = a + nrm * ds[i]
        inside = lambda q: (q - p0).dot(nrm) >= -1e-9
        out = []
        for k in range(len(poly)):
            s_, e_ = poly[k - 1], poly[k]
            if inside(e_):
                if not inside(s_):
                    t = (p0 - s_).dot(nrm) / (e_ - s_).dot(nrm)
                    out.append(s_ + (e_ - s_) * t)
                out.append(e_)
            elif inside(s_):
                t = (p0 - s_).dot(nrm) / (e_ - s_).dot(nrm)
                out.append(s_ + (e_ - s_) * t)
        poly = out
        if len(poly) < 3:
            return []
    return [(q.x, q.y) for q in poly]


def cut_plate(o, x, thick, outline, holes, name):
    """A flat plate in the plane x = `x`, `thick` across it, with the (y, z) `outline` and any number
    of (y, z) `holes` cut through it: both faces tessellated, walls round every loop. Closed, so
    add_geom orients it."""
    from mathutils.geometry import tessellate_polygon
    loops = [outline] + list(holes)
    flat = [p for loop in loops for p in loop]
    tris = tessellate_polygon([[Vector((a, b, 0)) for a, b in loop] for loop in loops])
    m = len(flat)
    verts = [(x - thick / 2, a, b) for a, b in flat] + [(x + thick / 2, a, b) for a, b in flat]
    faces = [tuple(t) for t in tris] + [tuple(m + i for i in reversed(t)) for t in tris]
    base = 0
    for loop in loops:
        k = len(loop)
        for i in range(k):
            a, b = base + i, base + (i + 1) % k
            faces.append((a, b, m + b, m + a))
        base += k
    add_geom(o, verts, faces, name)


def side_fin(target, surface, profile, x_out, thick, side=1, z0=0.0, radius=0.012, sink=0.006, name='Paint'):
    """A fibreglass upright on a curved panel (the Wendt Strom Sex Spec's mid wing uprights, after
    Wings West's G-Spec): a side `profile` of (y, z) points round the fin, in order, swept across its
    thickness. A point with z None sits on the panel: cast straight down onto `surface` (a world space
    BVH, `surface_tree`) at that station's x and sunk `sink`, so the foot follows a shoulder that falls
    away sideways; a run of them is eroded (each the lowest of itself and its neighbours), since a
    steep shoulder made the raw casts a sawtooth. A z given as `(dz, zmin)` is `dz` above the panel
    there but never below `zmin`: a front edge rising off a shoulder that is lower at the outer face
    than at the inner (all absolute, it sank under the outer foot; all relative, it climbed over the
    fin's top on the inner face, where the pillar stands higher). The outer face is at `x_out(y, z)`: give it the
    car's side a few mm out where the fin wraps the shoulder and a leaning line above it, so the face
    reads flush with the side down to the lamp's top edge, as the real kit's does (sat on top of the
    shoulder, the fin read as stuck on). `thick(z)` across; `z0` is where a cast starts its x guess. The long edges are rounded by `radius`: quarter circle stations each inset in
    the side plane along the profile's own normal (cast points stay on the panel). A slab with square
    edges read as cut plate, not moulded fibreglass. `side=-1` builds the right-hand twin.
    Returns the sections."""
    def foot(x, y):
        h = surface.ray_cast(Vector((x, y, 3.0)), Vector((0, 0, -1)))
        return (h[0].z if h[0] else z0) - sink
    r = radius
    q = r - math.sqrt(r * r - (r - 0.29 * r) ** 2)  # inset of the station 0.29 r in from a face
    stations = [(0.0, 0.75 * r, 'in'), (0.29 * r, q, 'in'), (r, 0.0, 'in'), (r, 0.0, 'out'), (0.29 * r, q, 'out'), (0.0, 0.75 * r, 'out')]
    n = len(profile)
    secs = []
    for off, ins, face in stations:
        pts = []
        for y, z in profile:
            cast = not isinstance(z, float) and not isinstance(z, int)
            zz = z0 if cast else z
            for _ in range(3 if cast else 1):  # x moves with z, the cast z with x
                xo = x_out(y, zz)
                x = xo - thick(zz) + off if face == 'in' else xo - off
                if cast:
                    zz = foot(x * side, y) if z is None else max(foot(x * side, y) + sink + z[0], z[1])
            pts.append([x, y, zz])
        on = [z is None for _, z in profile]
        low = [p[2] for p in pts]
        for i in range(n):
            if on[i]:
                pts[i][2] = min(low[j % n] for j in (i - 1, i, i + 1) if on[j % n])
        yz = [Vector((p[1], p[2])) for p in pts]
        area = sum(yz[i].x * yz[(i + 1) % n].y - yz[(i + 1) % n].x * yz[i].y for i in range(n))
        sec = []
        for i, (p, (y, z)) in enumerate(zip(pts, profile)):
            t = (yz[(i + 1) % n] - yz[i - 1]).normalized()
            nrm = Vector((t.y, -t.x)) * (1 if area > 0 else -1)
            if on[i] and on[i - 1] and on[(i + 1) % n]:
                nrm = Vector((0, 0))
            sec.append((p[0] * side, p[1] - nrm.x * ins, p[2] - nrm.y * ins))
        secs.append(sec)
    if side < 0:
        secs.reverse()
    sweep(target, secs, name)
    return secs


def roof_wing(target, surface, xs, nose, tail, top, thick, sink=0.003, clear=0.003, chord=(0, 0.02, 0.05, 0.1, 0.2, 0.32, 0.45, 0.58, 0.7, 0.8, 0.88, 0.94, 0.98, 1), name='Black'):
    """A hatch roof spoiler's blade (the Wendt Strom's Sport Mild and Sport Wild, replacing the stock
    roof spoiler): one closed (y, z) section per station x, swept across the car. `tail(x)` is the
    trailing edge's y, `top(x, y)` the upper surface, `thick(x, y)` how far the underside hangs below
    it; the underside never goes below the hatch (`surface`, a world BVH, cast straight down, less
    `sink`), and the top never below it plus `clear` (the roof's crown is not quite the quadratic a
    top is written as, and poked through the nose by 3 mm). So where the roof and the stock
    spoiler's black bed lie close under the blade it sits on them, and past the glass's top edge it
    is a free blade. `nose` is a y or a callable of x: give it the hatch's side shut line, so the
    ends start where the line reaches them and the whole spoiler mounts on the hatch (the first
    builds wrapped the D-pillars outboard of it with `side_fin`s, and the user wanted the mounts
    inside the trunk lines). Returns the sections."""
    def under_body(x, y):
        h = surface.ray_cast(Vector((x, y, 3.0)), Vector((0, 0, -1)))
        return h[0].z - sink if h[0] else -9.0
    secs = []
    for x in xs:
        t, y0 = tail(x), (nose(x) if callable(nose) else nose)
        ys = [y0 + (t - y0) * s for s in chord]
        tops = [max(top(x, y), under_body(x, y) + sink + clear) for y in ys]
        unders = [max(under_body(x, y), zt - thick(x, y)) for y, zt in zip(ys, tops)]
        unders = [min(u, zt - 0.004) for u, zt in zip(unders, tops)]
        sec = [(x, y, z) for y, z in zip(ys, tops)] + [(x, y, z) for y, z in reversed(list(zip(ys, unders)))]
        secs.append(sec)
    sweep(target, secs, name)
    return secs
