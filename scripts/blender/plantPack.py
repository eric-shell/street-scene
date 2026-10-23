"""
Build the roadworks plant from its Sketchfab sources (CC BY 4.0). Run
headless by scripts/buildPlant.ts:

    blender -b --factory-startup --python scripts/blender/plantPack.py -- <sourceDir> <outDir> [--lineup <png>]

<sourceDir> holds each model as Sketchfab's download imported into Blender
and exported to GLB (excavator.glb). <outDir> receives:

  plant.glb    one node per piece of plant (named after it), in plant space
               (glTF: +Z toward the dig, Y up, tracks on y = 0, origin at the
               center of the body's footprint), one material `Plant` whose
               color is the vertex color: every source material's base color
               baked onto its faces.
  plant.json   per piece: the boxes the sim collides with (the body; the
               excavator's stick and bucket), the beacon, height, triangles.

Why vertex colors and one material: the sources are flat colored (no
textures), so a color per face keeps their look at no texture cost, and every
excavator in the city is then one InstancedMesh (one draw call).

Each source part is welded and decimated to its share of the budget (shares
by the square root of its triangles, so the 26k triangle track chains give up
the most), then the parts are joined, recolored and measured.
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

# name: (source file, triangle budget, materials drawn as opaque cab glass)
PLANT = {
    'excavator': ('excavator.glb', 6000, {'Material_1269'}),
}
GLASS = (0.02, 0.025, 0.03)
# Parts this small keep every triangle.
FLOOR = 48


def args():
    a = sys.argv[sys.argv.index('--') + 1:]
    out = {'src': a[0], 'out': a[1], 'lineup': None}
    if '--lineup' in a:
        out['lineup'] = a[a.index('--lineup') + 1]
    return out


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def coords(o):
    co = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def base_color(mat, glass):
    if mat is None:
        return (0.5, 0.5, 0.5)
    if mat.name in glass:
        return GLASS
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mat.node_tree else None
    return tuple(bsdf.inputs['Base Color'].default_value[:3]) if bsdf else tuple(mat.diffuse_color[:3])


def decimate(o, budget):
    """Weld the import's split vertices, then collapse to the budget with the Decimate modifier."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bm.to_mesh(o.data)
    bm.free()
    have = tris(o)
    if have > budget:
        mod = o.modifiers.new('decimate', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = budget / have
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)


def build(name, path, budget, glass):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    parts = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    source = sum(tris(o) for o in parts)
    # Bake the world transforms (the FBX root's centimetre scale) into the meshes.
    for o in parts:
        o.data = o.data.copy()
        o.data.transform(o.matrix_world)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    weights = [math.sqrt(tris(o)) for o in parts]
    for o, w in zip(parts, weights):
        decimate(o, max(FLOOR, round(budget * w / sum(weights))))
    # Join, then one color per face from its material, then one material for all.
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    me = o.data
    colors = [base_color(s.material, glass) for s in o.material_slots]
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    for p in me.polygons:
        c = colors[p.material_index] if colors else (0.5, 0.5, 0.5)
        for li in p.loop_indices:
            attr.data[li].color = (*c, 1)
    me.color_attributes.active_color = attr
    me.materials.clear()
    mat = bpy.data.materials.get('Plant') or bpy.data.materials.new('Plant')
    me.materials.append(mat)
    for p in me.polygons:
        p.material_index = 0
    # Smooth within 35 degrees, hard edges beyond: the decimated normals are rebuilt, not kept.
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(35))
    return o, source


def excavator_frame(o):
    """Turn the arm from Blender +Y to -Y (glTF +Z) and put the origin at the body's footprint center.
    The body is everything but the boom, stick and bucket: the tracks and the house, which end
    where the tracks' front does (the boom rises from there and clears 3.5 m until the stick)."""
    me = o.data
    me.transform(Matrix.Rotation(math.pi, 4, 'Z'))
    co = coords(o)
    tracks = co[(co[:, 2] < 0.8) & (np.abs(co[:, 0]) > 0.9)]   # the bucket hangs as low, between them
    front = tracks[:, 1].min()        # tracks' front (the arm side, now -Y)
    body = co[co[:, 1] >= front - 0.05]
    lo, hi = body.min(0), body.max(0)
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    me.transform(Matrix.Translation((-cx, -cy, -co[:, 2].min())))
    me.update()
    co = coords(o)
    length = float(hi[1] - lo[1])
    width = float(hi[0] - lo[0])
    # Stick and bucket: what comes below 2.5 m beyond the body (the boom is above it).
    arm = co[(co[:, 1] < -length / 2 - 0.05) & (co[:, 2] < 2.5)]
    reach = float(-co[:, 1].min() - length / 2)
    stick = {'from': round(float(-arm[:, 1].max() - length / 2), 3), 'to': round(reach, 3), 'center': round(float((arm[:, 0].min() + arm[:, 0].max()) / 2), 3), 'width': round(float(np.ptp(arm[:, 0])), 3)}
    # The beacon on the cab roof: the highest part of the house clear of the boom's foot (|x| > 0.6).
    house = co[(np.abs(co[:, 1]) < length / 2) & (np.abs(co[:, 0]) > 0.6) & (co[:, 2] < 3)]
    cab = house[house[:, 2] > house[:, 2].max() - 0.3]
    mid = (cab.min(0) + cab.max(0)) / 2
    # Blender (x, y, z) is glTF (x, z, -y).
    beacon = [round(float(mid[0]), 3), round(float(house[:, 2].max()), 3), round(float(-mid[1]), 3)]
    return {
        'length': round(length, 3),
        'width': round(width, 3),
        'height': round(float(co[:, 2].max()), 3),
        'reach': round(reach, 3),
        'stick': stick,
        'beacon': beacon,
    }


def export(objs, path):
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_texcoords=False, export_normals=True, export_materials='EXPORT', export_vertex_color='ACTIVE', export_extras=False, export_apply=True)


def lineup(objs, path):
    """Workbench render of each piece from the front three quarter and the side, vertex colored."""
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'VERTEX'
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 1600, 700
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 26
    dups = []
    for i, o in enumerate(objs):
        o.hide_render = True
        for k, yaw in enumerate((-35, 90)):
            d = o.copy()
            scene.collection.objects.link(d)
            d.location = (k * 13 - 6.5, i * 12, 0)
            d.rotation_mode = 'XYZ'   # the glTF import leaves quaternions
            d.rotation_euler = (0, 0, math.radians(yaw))
            d.hide_render = False
            dups.append(d)
    cam.location = (0, -40, 18)
    cam.rotation_euler = (math.radians(68), 0, 0)
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for d in dups:
        bpy.data.objects.remove(d)


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    out = []
    info = {}
    for name, (file, budget, glass) in PLANT.items():
        o, source = build(name, os.path.join(a['src'], file), budget, glass)
        frame = excavator_frame(o) if name == 'excavator' else {}
        info[name] = {**frame, 'triangles': tris(o)}
        print(f'{name:10s} tris {source:6d} -> {tris(o):5d}  {frame}')
        out.append(o)
    # Drop the import's empties so only the plant nodes export.
    for e in [x for x in bpy.data.objects if x.type != 'MESH']:
        bpy.data.objects.remove(e)
    os.makedirs(a['out'], exist_ok=True)
    export(out, os.path.join(a['out'], 'plant.glb'))
    with open(os.path.join(a['out'], 'plant.json'), 'w') as f:
        json.dump(info, f, indent=1)
    if a['lineup']:
        lineup(out, a['lineup'])


main()
