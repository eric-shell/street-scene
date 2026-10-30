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
SHARED = ['Paint', 'Trim', 'Black', 'Chrome', 'Glass', 'Rim', 'Tire', 'HeadLight', 'TailLight', 'Light', 'Interior', 'Grille', 'RimLip', 'RimCap', 'Lens', 'Reflector', 'BrakeLight', 'ClearLens', 'Strap']
# Every lamp material: only HeadLight, TailLight and BrakeLight (under braking) glow in the game; Light (amber indicators and markers),
# Reflector (red) and Lens (the clear covers, see-through) are unlit lenses (src/shared/parts.ts).
LAMP_MATS = ('HeadLight', 'TailLight', 'BrakeLight', 'Light', 'Lens', 'Reflector', 'ClearLens')


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


def ray_map(objs, x0, x1, z0, z1, step=0.005, skip=('Lens', 'Glass', 'ClearLens'), deep=-1.8):
    """What the eye sees through the front, one letter per material: rays along +y over x0..x1, z1..z0,
    passing through `skip` (clear covers) to the first face behind. `O` marks a ray whose first hit lies
    behind `deep` (y), a hole into the car. `look` draws every material alike and the lens covers
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
            'Paint': 'p', 'Trim': 't', 'Reflector': 'r', 'Grille': 'g', 'Interior': 'i'}
    d = Vector((0, 1, 0))
    rows = []
    nz = int(round((z1 - z0) / step))
    nx = int(round((x1 - x0) / step))
    for zi in range(nz + 1):
        z = z1 - zi * step
        row = ''
        for xi in range(nx + 1):
            o = Vector((x0 + xi * step, -5, z))
            ch = ' '
            for _ in range(12):
                h = t.ray_cast(o, d, 10)
                if not h[0]:
                    break
                m = names[bm.faces[h[2]].material_index]
                if m not in skip:
                    ch = code.get(m, '?') if h[0].y < deep else 'O'
                    break
                o = h[0] + d * 1e-4
            row += ch
        rows.append((round(z, 3), row))
        print(f'{z:.3f} {row}')
    bm.free()
    return rows


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
    Winding is normalised; the result is counterclockwise."""
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    if area < 0:
        pts = pts[::-1]
    poly = [Vector(p) for p in pts]
    for i in range(len(pts)):
        a, b = Vector(pts[i]), Vector(pts[(i + 1) % len(pts)])
        e = (b - a).normalized()
        nrm = Vector((-e.y, e.x))  # left of the edge, the inside of a counterclockwise loop
        p0 = a + nrm * d
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
