#!/usr/bin/env bash
# SessionStart hook: a few lines of orientation. stdout becomes context, so keep it short.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
branch=$(git branch --show-current 2>/dev/null)
last=$(git log -1 --format='%h %s' 2>/dev/null)
ab=$(git rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null | awk '{ if ($1 + $2 == 0) printf "in sync with upstream"; else printf "%s ahead, %s behind upstream", $2, $1 }')
echo "Repo: branch ${branch:-?} (${ab:-no upstream}). Last commit: ${last:-none}."
dirty=$(git status --porcelain 2>/dev/null)
if [ -n "$dirty" ]; then
  n=$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')
  echo "Uncommitted changes in $n path(s): $(printf '%s\n' "$dirty" | head -10 | awk '{ print $NF }' | tr '\n' ' ')"
fi
[ -d node_modules ] || echo "node_modules is missing: run npm ci before /check or /dev."
nc -z -w1 127.0.0.1 5175 >/dev/null 2>&1 && echo "A dev server is already listening on http://localhost:5175."
exit 0
