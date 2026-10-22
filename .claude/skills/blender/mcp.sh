#!/usr/bin/env bash
# Keeps the two Blender MCP servers in .mcp.json and their Blender add-ons on the same versions.
# .mcp.json holds the only pins: `mcp-for-blender@<version>` for `blender`, `@<commit>` in the git URL
# for `blender-lab`. Server and add-on talk a versioned protocol, so they move together or not at all.
#   status   (default) pins vs the latest releases, installed add-ons vs the pins, stray copies, ports
#   install  installs both add-ons at the pinned versions (then restart Blender)
#   upgrade  moves both pins to the latest releases, then installs
# The runbook (first setup, upgrades, the traps behind each step) is .claude/skills/blender/mcp.md.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
MCP_JSON="$ROOT/.mcp.json"
LAB_REPO=https://projects.blender.org/lab/blender_mcp.git
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
# Written next to the Lab add-on so status can tell which commit is installed (the manifest version lags).
STAMP=.street-scene-commit

ver=$("$BLENDER" --version 2>/dev/null | sed -n 's/^Blender \([0-9]*\.[0-9]*\).*/\1/p' | head -1)
[ -n "$ver" ] || { echo "Blender not found at $BLENDER (set BLENDER)" >&2; exit 1; }
USER_DIR="$HOME/Library/Application Support/Blender/$ver"
ADDONS="$USER_DIR/scripts/addons"
LAB_DIR="$USER_DIR/extensions/user_default/mcp"

community_pin() { jq -r '.mcpServers.blender.args[0]' "$MCP_JSON" | sed 's/^mcp-for-blender@//'; }
lab_pin() { jq -r '.mcpServers["blender-lab"].args[1]' "$MCP_JSON" | sed -n 's/.*@\([0-9a-f]\{40\}\)#.*/\1/p'; }
lab_port() { jq -r '.mcpServers["blender-lab"].env.BLENDER_MCP_PORT // "9876"' "$MCP_JSON"; }
community_port() { jq -r '.mcpServers.blender.env.BLENDER_PORT // "9876"' "$MCP_JSON"; }
latest_community() { curl -fsS https://pypi.org/pypi/mcp-for-blender/json | jq -r .info.version; }
latest_lab() { git ls-remote "$LAB_REPO" HEAD | cut -c1-40; }
# The add-on file a given server release ships (install-addon copies exactly this).
bundled_addon() { uvx --from "mcp-for-blender@$1" python -c 'from blender_mcp.addon_manager import get_bundled_addon_path as p; print(p())' 2>/dev/null; }

status() {
  local cpin lpin cport lport f stamp
  cpin=$(community_pin); lpin=$(lab_pin); cport=$(community_port); lport=$(lab_port)
  echo "Blender $ver, user folder $USER_DIR"
  echo "blender      pin $cpin, latest $(latest_community || echo '?')"
  echo "blender-lab  pin ${lpin:0:7}, latest $( (latest_lab || echo '?') | cut -c1-7)"

  if [ ! -f "$ADDONS/blender_mcp.py" ]; then
    echo "  community add-on: not installed (run install)"
  elif cmp -s "$(bundled_addon "$cpin")" "$ADDONS/blender_mcp.py"; then
    echo "  community add-on: matches $cpin"
  else
    echo "  community add-on: differs from $cpin (run install, then restart Blender)"
  fi
  # install-addon only writes blender_mcp.py; any other copy shows as a second "MCP for Blender".
  for f in "$ADDONS"/*.py; do
    [ -f "$f" ] && [ "$f" != "$ADDONS/blender_mcp.py" ] || continue
    grep -q '"name": "MCP for Blender"' "$f" && echo "  stray copy: $f (remove it in Preferences > Add-ons)"
  done

  if [ -f "$LAB_DIR/$STAMP" ]; then
    stamp=$(cat "$LAB_DIR/$STAMP")
    [ "$stamp" = "$lpin" ] && echo "  Lab add-on: matches ${lpin:0:7}" || echo "  Lab add-on: ${stamp:0:7} installed, pin is ${lpin:0:7} (run install)"
  elif [ -d "$LAB_DIR" ]; then
    echo "  Lab add-on: installed outside this script, commit unknown (run install)"
  else
    echo "  Lab add-on: not installed (run install)"
  fi

  lsof -nP -iTCP:"$cport" -sTCP:LISTEN >/dev/null 2>&1 && echo "  port $cport listening (blender)" \
    || echo "  port $cport closed: Blender not running, or Start MCP Server in the viewport N panel > MCP for Blender"
  lsof -nP -iTCP:"$lport" -sTCP:LISTEN >/dev/null 2>&1 && echo "  port $lport listening (blender-lab)" \
    || echo "  port $lport closed: enable \"MCP\" in Add-ons with Port $lport and Auto Start, and System > Network > Allow Online Access"
}

install() {
  local cpin lpin tmp
  cpin=$(community_pin); lpin=$(lab_pin)
  [ -n "$lpin" ] || { echo "No 40-character commit in the blender-lab URL in .mcp.json" >&2; exit 1; }
  uvx "mcp-for-blender@$cpin" install-addon --addons-dir "$ADDONS"

  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  git -C "$tmp" init -q
  git -C "$tmp" fetch -q --depth 1 "$LAB_REPO" "$lpin"
  git -C "$tmp" checkout -q FETCH_HEAD
  mkdir -p "$LAB_DIR"
  rsync -a --delete --exclude __pycache__ "$tmp/addon/blender_mcp_addon/" "$LAB_DIR/"
  echo "$lpin" > "$LAB_DIR/$STAMP"
  echo "Installed the Lab add-on at ${lpin:0:7} to $LAB_DIR"
  echo "Next: restart Blender (both servers auto start), then run status."
}

upgrade() {
  local c l tmp
  c=$(latest_community); l=$(latest_lab)
  [ -n "$c" ] && [ ${#l} -eq 40 ] || { echo "Could not read the latest releases (PyPI $c, Lab $l)" >&2; exit 1; }
  echo "blender      $(community_pin) -> $c   notes: https://github.com/ahujasid/mcp-for-blender/releases"
  echo "blender-lab  $(lab_pin | cut -c1-7) -> ${l:0:7}   commits: https://projects.blender.org/lab/blender_mcp/commits/branch/main"
  tmp=$(mktemp)
  jq --arg c "mcp-for-blender@$c" --arg l "git+$LAB_REPO@$l#subdirectory=mcp" \
    '.mcpServers.blender.args[0] = $c | .mcpServers["blender-lab"].args[1] = $l' "$MCP_JSON" > "$tmp"
  mv "$tmp" "$MCP_JSON"
  install
  echo "Then restart Claude Code (it starts the servers per session) and check the tool names in mcp.md."
}

case "${1:-status}" in
  status) status ;;
  install) install ;;
  upgrade) upgrade ;;
  *) echo "usage: $0 [status|install|upgrade]" >&2; exit 2 ;;
esac
