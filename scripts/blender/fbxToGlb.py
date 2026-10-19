"""
Convert one FBX file to GLB with Blender in background mode.

    blender --background --factory-startup --python scripts/blender/fbxToGlb.py -- in.fbx out.glb

Every object stays a separate named node. Object transforms are applied
(baked into the mesh) so node transforms are identity. The glTF exporter
writes Y up; car space normalization (scale, facing +Z, origin between the
axles) is done afterwards by scripts/buildAssets.ts so that Blender and the
FBX2glTF fallback produce identical results.
"""
import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    print("usage: blender --background --python fbxToGlb.py -- in.fbx out.glb")
    sys.exit(1)
src, dst = argv[0], argv[1]

# Start from an empty scene.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True)

# Apply transforms so every mesh is in scene space with identity transform.
bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.context.scene.objects:
    if obj.type == "MESH":
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
if bpy.context.selected_objects:
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Remove empties left over from the FBX hierarchy, keeping mesh names.
for obj in list(bpy.context.scene.objects):
    if obj.type == "MESH" and obj.parent is not None:
        mat = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = mat
for obj in list(bpy.context.scene.objects):
    if obj.type == "EMPTY":
        bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_materials="EXPORT",
    export_texcoords=True,
    export_normals=True,
    use_selection=False,
)
print("wrote", dst)
