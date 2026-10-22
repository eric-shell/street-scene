#!/usr/bin/env bash
# PostToolUse hook (Edit|Write on *.scss): the stylesheet must still compile, without Sass warnings or
# deprecations (they become errors in the next major). Compiles the whole tree from main.scss, since a
# partial only means something in its place there. Exit 2 + stderr hands the problem to Claude.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
if command -v jq >/dev/null 2>&1; then
  file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
else
  file=$(node -e 'let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => { try { const j = JSON.parse(d); process.stdout.write((j.tool_input && j.tool_input.file_path) || ""); } catch {} })' 2>/dev/null)
fi
case "$file" in *.scss) ;; *) exit 0 ;; esac
sass=node_modules/.bin/sass
# A missing compiler is a broken install, not a pass: say so instead of skipping the check silently.
if [ ! -x "$sass" ]; then
  echo "Sass is not installed (node_modules/.bin/sass is missing, sass-embedded in package.json): run npm install. The stylesheet was not checked." >&2
  exit 2
fi

if ! out=$("$sass" --no-source-map src/ui/styles/main.scss 2>&1 >/dev/null); then
  printf 'Sass error:\n%s\n' "$(printf '%s\n' "$out" | head -20)" >&2
  exit 2
fi
if [ -n "$out" ]; then
  printf 'Sass warnings (fix them, they fail later):\n%s\n' "$(printf '%s\n' "$out" | head -20)" >&2
  exit 2
fi
exit 0
