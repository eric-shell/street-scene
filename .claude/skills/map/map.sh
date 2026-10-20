#!/usr/bin/env bash
# Repo map for Claude: one line per module (path, line count, first sentence of its header comment).
# With a directory or path fragment argument it lists the full header and exports of each match.
#   map.sh            compact map of src/, scripts/ and tests/
#   map.sh src/city   detailed map of everything whose path contains "src/city"
set -u
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0
filter=${1:-}

git ls-files src scripts tests | grep -E '\.ts$' | { if [ -n "$filter" ]; then grep -F -- "$filter"; else cat; fi; } | sort | while read -r f; do
  lines=$(wc -l < "$f" | tr -d ' ')
  # Leading `/** ... */` block or run of `//` lines, joined into one line.
  header=$(awk '
    NR == 1 { if ($0 ~ /^\/\//) mode = "line"; else if ($0 ~ /^\/\*\*/) mode = "block"; else exit }
    mode == "line" { if ($0 !~ /^\/\//) exit; line = $0; sub(/^\/\/[ \t]?/, "", line); if (line != "") printf "%s ", line; next }
    { line = $0; sub(/[ \t]*\*\/.*$/, "", line); sub(/^[ \t]*\/?\*+[ \t]?/, "", line); if (line != "") printf "%s ", line }
    /\*\// { exit }
  ' "$f")
  if [ -n "$filter" ]; then
    printf '%s (%s lines)\n' "$f" "$lines"
    [ -n "$header" ] && printf '  %s\n' "$header"
    exports=$(grep -oE '^export (default )?(async )?(function\*? |class |const |let |interface |type |enum )[A-Za-z0-9_]+' "$f" | awk '{ printf "%s ", $NF }')
    [ -n "$exports" ] && printf '  exports: %s\n' "$exports"
  else
    # First sentence after 30 chars (a period not preceded by a digit, so "1. Convert" does not cut), capped at 118.
    first=$(printf '%s' "$header" | awk '{ s = $0; n = length(s); cut = 0; for (i = 30; i < n; i++) if (substr(s, i, 2) == ". " && substr(s, i - 1, 1) !~ /[0-9]/) { cut = i; break } if (cut) s = substr(s, 1, cut); if (length(s) > 118) s = substr(s, 1, 115) "..."; print s }')
    printf '%-38s %5s  %s\n' "$f" "$lines" "$first"
  fi
done

if [ -z "$filter" ]; then
  echo
  echo "Data: src/sim/drivingParams.json (physics), src/assets/carManifest.json, partsCatalog.json, musicCatalog.json. Styles: src/ui/ui.css, src/style.css."
  echo "Docs: README.md, docs/partsAuthoring.md, docs/music.md. Scripts above run with: npx tsx scripts/<name>.ts"
fi
exit 0
