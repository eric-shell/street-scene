"""
Export one authored car .blend (assets/source/eshell/<carId>/<carId>.blend) to
plain GLBs plus a JSON sidecar that scripts/buildAssets.ts optimizes and
catalogs.

    blender --background <carId>.blend --python scripts/blender/exportCar.py -- <outDir>

Authored cars are modelled directly in car space (meters, Blender Z up, car
facing -Y, origin on the ground midway between the axles, +X the car's left),
so nothing is measured or rescaled afterwards. The .blend holds four
collections:

  Car     the base model: `Body` plus the stock pieces the part slots replace
          (`Bumper_Front`, `Bumper_Rear`, `Skirts`, `Hood`, `Roof`), one node each.
  Parts   one object per catalog part, named `<slot>_<partId>`
          (`frontBumper_street`, `spoiler_1`); optional custom properties
          `displayName` and `hides` (comma separated base node names).
  Wheels  wheels in wheel space (center at the origin, axle along X, outer face
          toward +X), named `wheel_<n>`; universal parts. Optional custom
          properties `displayName` and `group` (the garage section it is listed under).
  Rig     empties `Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR` at the wheel
          centers. Their height is the wheel radius.

The shared wheel set (assets/source/eshell/wheels/wheels.blend, built by
scripts/blender/carWheels.py) is a file with a Wheels collection only; it
exports just the wheels.

Object names may carry a `<carId>.` prefix (handy when several cars share
one working file); it is stripped on export.
"""
import json
import math
import os
import sys

import bpy

# Shading is recomputed at export (shade): edges sharper than this are split, the rest smoothed
# with face-area weights. The donor pipeline's authored normals did not survive the hand edits and
# bmesh round trips that followed (bmesh drops custom normals), so the shipped bodies carried plain
# smooth normals: on a 16,000 triangle car the hood's rear corners took the cowl fold's tilt, and
# with corner normals 30 to 40 degrees off their faces the reflection of the garage swung across
# the panel and went black at some angles. Area weighting lets the big panel faces own their
# vertices; the sharp split keeps a fold from bleeding into the panel beside it.
SHADE_ANGLE_DEG = 35

# Which base node a part replaces by default, per slot.
DEFAULT_HIDES = {
    "frontBumper": ["Bumper_Front"],
    "rearBumper": ["Bumper_Rear"],
    "sideSkirts": ["Skirts"],
    "hood": ["Hood"],
    "roof": ["Roof"],
    "body": ["Body"],
    "spoiler": [],
}


def short(name):
    return name.split(".", 1)[1] if "." in name else name


def to_gltf(v):
    """Blender Z up, -Y forward -> glTF Y up, +Z forward."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def show_all():
    """Selection only works on visible objects: a collection left hidden in the view layer (or an
    object hidden or unselectable) would silently drop out of a use_selection export."""
    def walk(lc):
        lc.exclude = False
        lc.hide_viewport = False
        for c in lc.children:
            walk(c)
    walk(bpy.context.view_layer.layer_collection)
    for c in bpy.data.collections:
        c.hide_viewport = False
        c.hide_select = False
    for o in bpy.data.objects:
        o.hide_viewport = False
        o.hide_select = False
        o.hide_set(False)


def shade(o):
    """Replace the mesh's shading with sharp-by-angle plus area weighted normals (SHADE_ANGLE_DEG).
    The custom normals are dropped by removing their attribute (no operator, so no selection
    dance); the Weighted Normal modifier is left on the object for the exporter to apply."""
    me = o.data
    custom = me.attributes.get("custom_normal")
    if custom is not None:
        me.attributes.remove(custom)
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(SHADE_ANGLE_DEG))
    if not any(m.type == "WEIGHTED_NORMAL" for m in o.modifiers):
        mod = o.modifiers.new("shade", "WEIGHTED_NORMAL")
        mod.mode = "FACE_AREA"
        mod.keep_sharp = True
        mod.weight = 50


def export(objects, path, reshade=True):
    bpy.ops.object.select_all(action="DESELECT")
    renamed = []
    for o in objects:
        o.hide_set(False)
        o.select_set(True)
        if reshade and o.type == "MESH":
            shade(o)
    if sorted(o.name for o in bpy.context.selected_objects) != sorted(o.name for o in objects):
        raise SystemExit(f"exportCar: could not select {[o.name for o in objects]} for {path}")
    for o in objects:
        renamed.append((o, o.name))
    # Export under the short names (node names are what parts hide).
    for o, n in renamed:
        o.name = short(n)
    bpy.context.view_layer.objects.active = objects[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_materials="EXPORT",
            export_texcoords=True,
            export_normals=True,
            use_selection=True,
        )
    finally:
        for o, n in renamed:
            o.name = n


def export_wheels(wheels, out_dir, meta):
    for o in sorted(wheels.objects if wheels else [], key=lambda o: o.name):
        if o.type != "MESH":
            continue
        n = short(o.name).replace("wheel_", "")
        # Wheels keep their own shading: lathed rings and hex heads were built with it.
        export([o], os.path.join(out_dir, "wheels", f"wheel_{n}.glb"), reshade=False)
        meta["wheels"].append({"name": n, "displayName": o.get("displayName", ""), "group": o.get("group", ""), "construction": o.get("construction", ""), "offset": o.get("offset"), "offsetBias": o.get("offsetBias"), "lip": o.get("lip", ""), "lugs": json.loads(o["lugs"]) if "lugs" in o else None, "tris": tris(o)})


def collection(suffix):
    for c in bpy.data.collections:
        if c.name == suffix or c.name.endswith(":" + suffix):
            return c
    return None


def run(out_dir, car_id=None):
    prefix = (car_id + ":") if car_id else ""
    get = (lambda s: bpy.data.collections.get(prefix + s)) if car_id else collection
    car, parts, wheels, rig = get("Car"), get("Parts"), get("Wheels"), get("Rig")
    wheels_only = car is None and rig is None and wheels is not None
    if not wheels_only and (car is None or rig is None):
        raise SystemExit("exportCar: the .blend needs Car and Rig collections (or only Wheels)")
    show_all()
    meta = {"car": [], "parts": [], "wheels": [], "wheelCenters": {}}
    if wheels_only:
        export_wheels(wheels, out_dir, meta)
        with open(os.path.join(out_dir, "car.json"), "w") as f:
            json.dump(meta, f, indent=2)
        print("exportCar: wrote wheels", out_dir)
        return

    car_objs = [o for o in car.objects if o.type == "MESH"]
    export(car_objs, os.path.join(out_dir, "car.glb"))
    meta["car"] = [{"node": short(o.name), "tris": tris(o)} for o in car_objs]

    # Collection order is the garage order, so the author decides how options are listed.
    for o in (parts.objects if parts else []):
        if o.type != "MESH":
            continue
        slot, _, part_id = short(o.name).partition("_")
        hides = o.get("hides")
        hides = [h.strip() for h in hides.split(",") if h.strip()] if isinstance(hides, str) else DEFAULT_HIDES.get(slot, [])
        export([o], os.path.join(out_dir, "parts", f"{slot}_{part_id}.glb"))
        meta["parts"].append({"slot": slot, "partId": part_id, "displayName": o.get("displayName", part_id), "hides": hides, "tris": tris(o)})

    export_wheels(wheels, out_dir, meta)

    for o in rig.objects:
        key = short(o.name).replace("Wheel_", "")
        if key in ("FL", "FR", "RL", "RR"):
            meta["wheelCenters"][key] = to_gltf(o.matrix_world.translation)
    missing = {"FL", "FR", "RL", "RR"} - set(meta["wheelCenters"])
    if missing:
        raise SystemExit(f"exportCar: Rig is missing {sorted(missing)}")

    with open(os.path.join(out_dir, "car.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("exportCar: wrote", out_dir)


if __name__ == "__main__" and "--" in sys.argv:
    args = sys.argv[sys.argv.index("--") + 1:]
    run(args[0], args[1] if len(args) > 1 else None)
