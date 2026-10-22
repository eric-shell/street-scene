"""
meshoptimizer's simplifier for Blender meshes. The work runs in Node (scripts/meshoptSimplify.ts)
from the npm package the asset pipeline already has, because Blender has no binding for it worth
depending on. Exec'd like the other helpers (carDonors.py does it, so donors and wheels get it),
or by trafficPack.py, with REPO set:

    exec(open(REPO + '/scripts/blender/meshopt.py').read())
    meshopt_reduce(o, 8000)            # in place, about 8000 triangles -> (triangles, error)

Why it over the Decimate modifier: it weighs the corner normals (the source's own `src_normal`
when there is one) so shading features survive, keeps every attribute seam (material, crease, UV,
face attributes) and collapses only along it, and moves the kept vertices to fit the surface they
replace. What it lacks is the modifier's mirror symmetry (the collapse is deterministic but not
mirrored), and on meshes of many loose open pieces it would reach the budget by eating whatever is
closed (a rim of 300 loose pieces lost its tire): so it stops at MESHOPT['max_error'] and the
callers finish with Decimate. On a shipped hatch cut from 8k to 3k that pairing beat Decimate alone
on every measure (reduce_donor's drift p95 9 against 15 mm, lost p95 18 against 30 mm and max 60
against 104 mm); on a wheel the two came out even.

The mesh goes over as split vertices, one per distinct (vertex, face attributes, corner values),
the way a GPU vertex buffer splits; meshoptimizer reads split vertices at one position as a seam.
The result is welded back into Blender vertices, and the face and float corner attributes are
restored from the split vertex each corner came from. Point and edge attributes (sharp edges,
seams) do not survive; custom normals do, from the corner normals. `node` is looked up on PATH,
then in the usual install places: a Blender started from the Dock does not see nvm's PATH.
"""
import glob
import json
import math
import os
import re
import shutil
import subprocess
import tempfile

import bmesh
import bpy
import numpy as np

MESHOPT = {
    'normal_weight': 1.0,   # error weight per normal component (meshoptimizer's advice for unit vectors)
    'uv_weight': 1.0,       # error weight per UV component
    'quantize': 1e-4,       # UVs and other corner values closer than this are one split vertex (no seams from float noise)
    'crease_cos': math.cos(math.radians(25)),   # corner normals turning more than this at a vertex are a seam
    'update': True,         # move kept vertices to fit the removed surface (simplifyWithUpdate)
    'max_error': 0.01,      # relative error (of the mesh's extent) to stop at short of the budget: past it, the
                            # only collapses left tear off whole parts held by open borders (a rim of 300 loose
                            # pieces kept its spokes and ate its tire); the caller finishes with Decimate
}

_WIDTH = {'FLOAT': 1, 'FLOAT2': 2, 'FLOAT_VECTOR': 3, 'FLOAT_COLOR': 4}
_PROP = {'FLOAT': 'value', 'FLOAT2': 'vector', 'FLOAT_VECTOR': 'vector', 'FLOAT_COLOR': 'color'}


def node_bin():
    """The `node` executable: $NODE, PATH, then nvm (newest version), Homebrew, /usr/local, Volta."""
    found = os.environ.get('NODE') or shutil.which('node')
    if found:
        return found
    for pattern in ('~/.nvm/versions/node/*/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '~/.volta/bin/node'):
        hits = sorted(glob.glob(os.path.expanduser(pattern)), key=lambda p: [int(x) for x in re.findall(r'\d+', p)])
        if hits:
            return hits[-1]
    raise RuntimeError('meshopt: node not found (set NODE to its path)')


def _read(attr, n, width, dtype=np.float32):
    a = np.empty(n * width, dtype)
    attr.data.foreach_get(_PROP.get(attr.data_type, 'value'), a)
    return a.reshape(n, width)


def meshopt_reduce(o, budget, uv=True, flags=()):
    """`o` reduced in place to about `budget` triangles (see the module comment). `uv=False` drops
    the UV maps instead of keeping their seams: a donor's UVs are replaced later, and their islands
    would only pin the collapse. Returns (triangles, error), the error relative to the mesh's
    extent. It stops above the budget rather than pass MESHOPT['max_error'], or when only
    seams and open borders are left to collapse."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    nv, nc, nf = len(me.vertices), len(me.loops), len(me.polygons)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(nv, 3)
    cv = np.empty(nc, np.int64)
    me.loops.foreach_get('vertex_index', cv)
    start = np.empty(nf, np.int64)
    me.polygons.foreach_get('loop_start', start)
    corners = (start[:, None] + np.arange(3)).ravel()   # triangles, corners in face order
    cface = np.empty(nc, np.int64)
    cface[corners] = np.repeat(np.arange(nf), 3)

    # Face values: the material and every int or bool face attribute (own_normals, sharp_face, ...).
    mat = np.empty(nf, np.int32)
    me.polygons.foreach_get('material_index', mat)
    fattrs = [(a.name, a.data_type) for a in me.attributes
              if a.domain == 'FACE' and a.data_type in ('INT', 'BOOLEAN') and not a.name.startswith('.') and a.name != 'material_index']
    fvals = np.stack([mat] + [_read(me.attributes[n], nf, 1, np.int32 if t == 'INT' else bool)[:, 0].astype(np.int32) for n, t in fattrs], 1)

    # Corner values: the normal first (weighted), then the UV maps (weighted), then the rest.
    sn = me.attributes.get('src_normal')
    if sn is not None and sn.domain == 'CORNER' and sn.data_type == 'FLOAT_VECTOR':
        normal = _read(sn, nc, 3)
    else:
        normal = np.empty(nc * 3, np.float32)
        me.corner_normals.foreach_get('vector', normal)
        normal = normal.reshape(nc, 3)
    custom = me.has_custom_normals
    active_uv = me.uv_layers.active.name if me.uv_layers.active else None
    render_uv = next((l.name for l in me.uv_layers if l.active_render), None)
    cattrs = [(a.name, a.data_type) for a in me.attributes
              if a.domain == 'CORNER' and a.data_type in _WIDTH and not a.name.startswith('.')
              and a.name not in ('src_normal', 'custom_normal') and (uv or a.data_type != 'FLOAT2')]
    cattrs.sort(key=lambda c: c[1] != 'FLOAT2')
    values = np.concatenate([normal] + [_read(me.attributes[n], nc, _WIDTH[t]) for n, t in cattrs], 1)
    weights = [MESHOPT['normal_weight']] * 3 + [MESHOPT['uv_weight']] * (2 * sum(t == 'FLOAT2' for _, t in cattrs))
    weights += [0.0] * (values.shape[1] - len(weights))
    if len(weights) > 32:
        raise RuntimeError(f'meshopt: {len(weights)} attribute floats on {o.name}, at most 32')

    # Split vertices: corners of one vertex with the same face values and UVs, and normals within
    # the crease angle of each other. Exact normals would make every corner a seam once
    # shade_from_source has given each its own; a sharper turn than the crease is a real one.
    normal = normal / np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-12)
    group = np.unique(np.concatenate([cv[:, None], fvals[cface], np.round(values[:, 3:] / MESHOPT['quantize'])], 1).astype(np.int64),
                      axis=0, return_inverse=True)[1].reshape(-1)
    smooth = np.full(nc, -1, np.int64)
    ref = np.zeros((group.max() + 1, 3))
    for r in range(4):   # up to four smooth groups around a vertex; more are each their own
        free = np.flatnonzero(smooth < 0)
        if not len(free):
            break
        g, at = np.unique(group[free], return_index=True)
        ref[g] = normal[free[at]]
        smooth[free[np.einsum('ij,ij->i', normal[free], ref[group[free]]) >= MESHOPT['crease_cos']]] = r
    rest = np.flatnonzero(smooth < 0)
    smooth[rest] = 4 + np.arange(len(rest))
    _, first, inverse = np.unique(np.stack([group, smooth], 1), axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    split_vert = cv[first]
    indices = inverse[corners].astype(np.uint32)
    ns, stride = len(first), values.shape[1]
    split_values = values[first].copy()
    mean = np.zeros((ns, 3))
    np.add.at(mean, inverse, normal)
    split_values[:, :3] = mean / np.maximum(np.linalg.norm(mean, axis=1, keepdims=True), 1e-12)

    work = tempfile.mkdtemp(prefix='meshopt')
    try:
        src, dst, req = (os.path.join(work, n) for n in ('in.bin', 'out.bin', 'request.json'))
        with open(src, 'wb') as f:
            f.write(co[split_vert].astype(np.float32).tobytes())
            f.write(split_values.astype(np.float32).tobytes())
            f.write(indices.tobytes())
        with open(req, 'w') as f:
            json.dump({'input': src, 'output': dst, 'vertices': ns, 'indices': len(indices), 'stride': stride, 'weights': weights,
                       'target': min(budget, nf) * 3, 'error': MESHOPT['max_error'], 'flags': list(flags), 'update': MESHOPT['update']}, f)
        run = subprocess.run([node_bin(), '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
                              os.path.join(REPO, 'scripts', 'meshoptSimplify.ts'), req], capture_output=True, text=True, cwd=REPO)
        if run.returncode != 0:
            raise RuntimeError(f'meshopt: {run.stderr.strip() or run.stdout.strip()}')
        with open(dst, 'rb') as f:
            buf = f.read()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    count = int(np.frombuffer(buf, np.uint32, 1, 0)[0])
    error = float(np.frombuffer(buf, np.float32, 1, 4)[0])
    tri = np.frombuffer(buf, np.uint32, count, 8).astype(np.int64).reshape(-1, 3)
    pos = np.frombuffer(buf, np.float32, ns * 3, 8 + count * 4).reshape(ns, 3)
    att = np.frombuffer(buf, np.float32, ns * stride, 8 + count * 4 + ns * 12).reshape(ns, stride)

    # Weld the split vertices back into Blender vertices; drop triangles that welding folds and
    # repeats of one vertex set (Blender would merge those as duplicate faces).
    bv = split_vert[tri]
    keep = (bv[:, 0] != bv[:, 1]) & (bv[:, 1] != bv[:, 2]) & (bv[:, 0] != bv[:, 2])
    tri, bv = tri[keep], bv[keep]
    _, once = np.unique(np.sort(bv, 1), axis=0, return_index=True)
    once.sort()
    tri, bv = tri[once], bv[once]
    used, first_use, faces = np.unique(bv.ravel(), return_index=True, return_inverse=True)
    corner_split = tri.ravel()
    nt = len(tri)
    cvals = att[corner_split]
    n = cvals[:, :3]
    n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    fv = fvals[cface[first[tri[:, 0]]]]

    me.clear_geometry()   # keeps the material slots
    me.vertices.add(len(used))
    me.vertices.foreach_set('co', pos[corner_split[first_use]].astype(np.float32).ravel())
    me.loops.add(nt * 3)
    me.loops.foreach_set('vertex_index', faces.reshape(-1).astype(np.int32))
    me.polygons.add(nt)
    me.polygons.foreach_set('loop_start', np.arange(0, nt * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('material_index', fv[:, 0].astype(np.int32))
    for i, (name, t) in enumerate(fattrs):
        me.attributes.new(name, t, 'FACE').data.foreach_set('value', fv[:, i + 1].astype(np.int32 if t == 'INT' else bool))
    if sn is not None:
        me.attributes.new('src_normal', 'FLOAT_VECTOR', 'CORNER').data.foreach_set('vector', n.astype(np.float32).ravel())
    col = 3
    for name, t in cattrs:
        w = _WIDTH[t]
        me.attributes.new(name, t, 'CORNER').data.foreach_set(_PROP[t], cvals[:, col:col + w].astype(np.float32).ravel())
        col += w
    if active_uv and active_uv in me.uv_layers:
        me.uv_layers.active = me.uv_layers[active_uv]
    if render_uv and render_uv in me.uv_layers:
        me.uv_layers[render_uv].active_render = True
    if custom:
        me.normals_split_custom_set(n.tolist())
    me.validate()
    me.update()
    return nt, error
