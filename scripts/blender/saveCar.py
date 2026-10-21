"""
Save one car out of a shared working file as its own authored .blend.

    blender --background work.blend --python scripts/blender/saveCar.py -- <carId> assets/source/eshell/<carId>/<carId>.blend

The working file holds collections named `<carId>:Car`, `<carId>:Parts`,
`<carId>:Wheels` and `<carId>:Rig` (see exportCar.py); everything else is
dropped. Run it in background Blender, never through the MCP: saving a
subset from the live session with bpy.data.libraries.write crashes Blender
5.2 when it is handed a Scene.
"""
import os
import sys

import bpy

cid, out = sys.argv[sys.argv.index('--') + 1:][:2]
scene = bpy.context.scene
# A car has all four; the shared wheel set (`wheels`) has only Wheels.
subs = tuple(s for s in ('Car', 'Parts', 'Wheels', 'Rig') if f'{cid}:{s}' in bpy.data.collections)
if not subs or (cid != 'wheels' and len(subs) < 4):
    raise SystemExit(f'saveCar: {cid} needs collections Car, Parts, Wheels and Rig (found {list(subs)})')
keep = {f'{cid}:{s}' for s in subs}
keep_objs = set()
for name in keep:
    keep_objs |= set(bpy.data.collections[name].all_objects)
for o in list(bpy.data.objects):
    if o not in keep_objs:
        bpy.data.objects.remove(o)
for c in list(bpy.data.collections):
    if c.name not in keep:
        bpy.data.collections.remove(c)
for c in list(scene.collection.children):
    scene.collection.children.unlink(c)
for s in subs:
    scene.collection.children.link(bpy.data.collections[f'{cid}:{s}'])
for extra in list(bpy.data.scenes):
    if extra != scene:
        bpy.data.scenes.remove(extra)
scene.name = cid
bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.data.name = o.name
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print('saveCar: wrote', out, len(bpy.data.objects), 'objects')
