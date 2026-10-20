#!/usr/bin/env bash
# PostToolUse hook (Edit|Write on *.json): the file must still parse, and the data files the game
# validates at startup are validated here too, headless. Exit 2 + stderr hands the problem to Claude.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
if command -v jq >/dev/null 2>&1; then
  file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
else
  file=$(node -e 'let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => { try { const j = JSON.parse(d); process.stdout.write((j.tool_input && j.tool_input.file_path) || ""); } catch {} })' 2>/dev/null)
fi
[ -n "$file" ] && [ -f "$file" ] || exit 0
case "$file" in *.json) ;; *) exit 0 ;; esac

if ! err=$(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" 2>&1 >/dev/null); then
  echo "$file is not valid JSON: $(printf '%s\n' "$err" | grep -m1 'SyntaxError' || printf '%s\n' "$err" | head -2)" >&2
  exit 2
fi

rel=${file#"$PWD/"}
case "$rel" in
  src/sim/drivingParams.json)
    if ! out=$(npx tsx .claude/hooks/check-tuning.ts 2>&1); then
      printf '%s\n' "$out" | grep -m3 -E 'Error|drivingParams' >&2
      exit 2
    fi ;;
  src/assets/partsCatalog.json|src/assets/carManifest.json)
    if ! out=$(npm run -s validate 2>&1); then
      printf '%s\n' "$out" | tail -15 >&2
      exit 2
    fi ;;
esac
exit 0
