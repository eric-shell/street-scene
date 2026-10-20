#!/usr/bin/env bash
# PreToolUse hook (mcp__blender__execute_blender_code): blocks the calls that have crashed the
# user's Blender or silently corrupted work in this project. Exit 2 + stderr hands the reason to Claude.
# The full list and the safe alternatives live in .claude/skills/blender/SKILL.md.
if command -v jq >/dev/null 2>&1; then
  code=$(jq -r '.tool_input.code // empty' 2>/dev/null)
else
  code=$(node -e 'let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => { try { process.stdout.write(JSON.parse(d).tool_input.code || ""); } catch {} })' 2>/dev/null)
fi
[ -n "$code" ] || exit 0

block() {
  echo "Blocked by .claude/hooks/check-blender-code.sh: $1 See .claude/skills/blender/SKILL.md." >&2
  exit 2
}

case "$code" in
  *libraries.write*)
    block "bpy.data.libraries.write crashes Blender 5.2 when given a Scene (the user loses the session). Save a working copy with bpy.ops.wm.save_as_mainfile(filepath=..., copy=True), then split it per car with background Blender: scripts/blender/saveCar.py." ;;
  *wm.open_mainfile*|*read_factory_settings*|*read_homefile*)
    block "loading a file or factory settings in the live session replaces the user's scene and can stop the MCP server. Do file work in background Blender (blender -b file.blend --python script.py) instead." ;;
  *wm.quit_blender*)
    block "never quit the user's Blender." ;;
esac

# materials.clear() resets every face's material_index to 0: everything exports as the first material.
if printf '%s' "$code" | grep -q 'materials\.clear()' && ! printf '%s' "$code" | grep -q 'material_index *='; then
  block "mesh.materials.clear() resets every face's material_index to 0. Use remap_materials(o) from scripts/blender/carKit.py, or record the per-face material names first and reassign material_index afterwards."
fi
exit 0
