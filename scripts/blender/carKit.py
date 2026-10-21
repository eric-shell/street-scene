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
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_point_line

REPO = globals().get('REPO') or os.getcwd()
SHARED = ['Paint', 'Trim', 'Black', 'Chrome', 'Glass', 'Rim', 'Tire', 'HeadLight', 'TailLight', 'Light', 'Interior', 'Grille']


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
    consistent outside normals; open patches pass `outward` (the side they are seen from)."""
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
    else:
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
