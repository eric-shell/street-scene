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
SHARED = ['Paint', 'Trim', 'Black', 'Chrome', 'Glass', 'Rim', 'Tire', 'HeadLight', 'TailLight', 'Light', 'Interior', 'Grille', 'RimLip', 'RimCap', 'Lens', 'Reflector', 'BrakeLight', 'ClearLens']
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
    smooth with sharp profile edges marked. `outward(i)`, a plan direction per station, orients the
    sides; by default they face away from each section's centroid. Lips, blades, rubbing strips."""
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

    def side_normal(i, s):
        a, b = Vector(sections[i][s]), Vector(sections[i][(s + 1) % k])
        nr = tangent[i].cross(b - a).normalized()
        return nr if nr.dot((a + b) / 2 - cent[i]) > 0 else -nr

    for i in range(n - 1):
        for s in range(k):
            f = bm.faces.new([vs[i][s], vs[i + 1][s], vs[i + 1][(s + 1) % k], vs[i][(s + 1) % k]])
            f.material_index = mi
            f.smooth = True
            f.normal_update()
            mid = (sum((v.co for v in f.verts), Vector()) / 4) - (cent[i] + cent[i + 1]) / 2
            if f.normal.dot(mid) < 0:
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


def punch_holes(o, holes, r, depth=0.015, sides=16, wall='Black', back='Black', skin=0.012):
    """Real round holes through a panel (speed holes, vents): for each (center, normal), `center` on the
    surface and `normal` pointing out of it, the faces round it are cut along a `sides`-gon of radius r
    (one bisect per side, limited to faces within `skin` of the surface and near the hole, so the
    inside of the bumper is never sliced), the faces inside are deleted, the opening's edge is run
    `depth` m inward as a `wall` and capped with a `back` (the black mesh a real hole shows). A real
    opening rather than a black disc on the paint: from the garage's three-quarter a disc reads as a
    sticker. Carries authored normals (the cut faces keep theirs, the wall is radial, the back flat).
    Returns the faces added."""
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
        ring = [c + (u * math.cos(2 * math.pi * i / sides) + w * math.sin(2 * math.pi * i / sides)) * r for i in range(sides)]
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
            return radial(f.calc_center_median()).length < r * 1.3 or any(seg_dist(e.verts[0].co, e.verts[1].co) < r * 1.3 for e in f.edges)
        planes = [(ring[i], (ring[(i + 1) % sides] - ring[i]).cross(n).normalized()) for i in range(sides)]
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
        abs((v.co - Vector(c)).dot(Vector(nn).normalized())) < skin and ((v.co - Vector(c)) - Vector(nn).normalized() * (v.co - Vector(c)).dot(Vector(nn).normalized())).length < r * 1.6
        for v in e.verts for c, nn in holes)]
    bm.to_mesh(me)
    bm.free()
    me.update()
    if carry:
        restore_normals(o)
    if gaps:
        print(f'punch_holes: {len(gaps)} open edges left round the holes')
    return added


def sheet_lip(src, target, center=(0, -1.55), angles=(0, 20, 40, 52, 62, 70, 76, 82), band=(0.165, 0.235), thick=0.013,
              proud=0.04, end_proud=0.025, taper_from=70, tuck=0.04, butt=0.004, chamfer=0.006, full=True, material='Black'):
    """A flat splitter cut from sheet stock (half inch HDPE) under a front bumper: top and bottom flat
    all the way round at the height of the bumper's underside at the nose, its outline the bumper's
    bottom edge offset `proud` m and taken in straight runs between `angles` (degrees about `center`,
    one half, mirrored), with a 45 degree `chamfer` on the top front edge. Each run is its own sweep,
    so its faces are flat and the joints crisp like a cut sheet, not smooth like `bumper_lip`. Past
    `taper_from` degrees the proud edge narrows to `end_proud` at the last angle. A bumper's bottom
    dips toward the arches, below a sheet at the nose's height: with `full` (the user wanted it along
    the whole bottom) the sheet runs on to the arches and, where the underside is below it, butts
    against the face (`butt` m in, not `tuck` under); without, it stops at the last angle where the
    underside is still above it. The Wendt Strom's Track bumper. Carries authored normals. Returns the
    sections."""
    E = lower_edge(src, center, list(angles), *band)
    top = E[0].z - 0.002
    keep = [i for i, e in enumerate(E) if full or e.z >= top + 0.001 or i == 0]
    E = [E[i] for i in keep]
    A = [angles[i] for i in keep]
    E = [Vector((-e.x, e.y, e.z)) for e in reversed(E[1:])] + E
    A = [-a for a in reversed(A[1:])] + A
    bot = top - thick
    secs = []
    for i, (e, a) in enumerate(zip(E, A)):
        p, q = E[max(i - 1, 0)].to_2d(), E[min(i + 1, len(E) - 1)].to_2d()
        tg = (q - p).normalized()
        n = Vector((tg.y, -tg.x))
        if n.dot(e.to_2d() - Vector(center)) < 0:
            n = -n
        n3 = Vector((n.x, n.y, 0))
        last = max(abs(x) for x in A)
        k = 0.0 if abs(a) <= taper_from or last <= taper_from else (abs(a) - taper_from) / (last - taper_from)
        ext = proud + (end_proud - proud) * k
        tk = tuck if e.z >= top + 0.001 else butt
        base = Vector((e.x, e.y, 0))
        secs.append([tuple(base - n3 * tk + Vector((0, 0, top))),
                     tuple(base + n3 * (ext - chamfer) + Vector((0, 0, top))),
                     tuple(base + n3 * ext + Vector((0, 0, top - chamfer))),
                     tuple(base + n3 * ext + Vector((0, 0, bot))),
                     tuple(base - n3 * tk + Vector((0, 0, bot)))])
    carry = stash_normals(target)
    for i in range(len(secs) - 1):
        sweep(target, [secs[i], secs[i + 1]], material)
    if carry:
        restore_normals(target)
    return secs


def canard(src, target, side, a0, a1, z0, rise=0.03, width=(0.06, 0.02), thick=0.004, embed=0.006,
           center=(0, -1.55), stations=5, material='Black'):
    """A canard (dive plane) on a bumper's corner: a thin plate standing out of the corner face from
    `a0` to `a1` degrees about `center` (plan, 0 toward -y; `side` +1 the car's left, -1 its right), its
    root following the face (plan rays at each station) from height z0 at the front end to z0 + `rise`
    at the back, so it angles up toward the rear; `width` (front, back) is how far it stands out, the
    root sunk `embed` m into the face so no seam shows. The Wendt Strom's Track bumper carries two a
    side where the amber markers were. Carries authored normals."""
    from mathutils.bvhtree import BVHTree
    t = BVHTree.FromObject(src, bpy.context.evaluated_depsgraph_get())
    c = Vector((center[0], center[1], 0))
    secs = []
    for k in range(stations):
        f = k / (stations - 1)
        a = math.radians(a0 + (a1 - a0) * f)
        d = Vector((side * math.sin(a), -math.cos(a), 0))
        z = z0 + rise * f
        h = t.ray_cast(c + d * 3 + Vector((0, 0, z)), -d, 3)
        if not h[0]:
            continue
        n = Vector((h[1].x, h[1].y, 0)).normalized()
        w = width[0] + (width[1] - width[0]) * f
        s = h[0]
        up = Vector((0, 0, thick / 2))
        secs.append([tuple(s - n * embed + up), tuple(s + n * w + up), tuple(s + n * w - up), tuple(s - n * embed - up)])
    carry = stash_normals(target)
    sweep(target, secs, material)
    if carry:
        restore_normals(target)
    return secs


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
