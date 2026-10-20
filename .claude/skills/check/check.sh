#!/usr/bin/env bash
# Typecheck, then the Vitest suite (or part of it), printing only failures and a summary line.
#   check.sh                               everything
#   check.sh tests/sim.test.ts -t nitrous  any `vitest run` arguments
#   check.sh tsc                           typecheck only
# Always exits 0: the summary carries the verdict, and a skill invocation must not abort on failures.
set -u
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0
[ -d node_modules ] || { echo "node_modules missing: run npm ci first"; exit 0; }

tsc_out=$(npx tsc --noEmit --pretty false 2>&1)
if [ $? -eq 0 ]; then
  echo "typecheck: ok"
else
  echo "typecheck: $(printf '%s\n' "$tsc_out" | grep -c 'error TS') error(s)"
  printf '%s\n' "$tsc_out" | grep 'error TS' | head -30
fi
[ "${1:-}" = "tsc" ] && exit 0

report=$(mktemp -t street-scene-vitest.XXXXXX)
npx vitest run --reporter=json --outputFile="$report" "$@" >/dev/null 2>"$report.err"
rc=$?
node - "$report" "$report.err" "$rc" <<'EOF'
const fs = require('fs');
const [file, errFile, rc] = process.argv.slice(2);
let r = null;
try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!r) {
  console.log(`tests: vitest exited ${rc} without a report`);
  const err = fs.readFileSync(errFile, 'utf8').trim();
  if (err) console.log(err.split('\n').slice(-20).join('\n'));
  process.exit(0);
}
const rel = (p) => p.replace(process.cwd() + '/', '');
const failed = [];
for (const tf of r.testResults || []) {
  const asserts = tf.assertionResults || [];
  for (const a of asserts) if (a.status === 'failed') failed.push({ file: tf.name, name: a.fullName, msg: (a.failureMessages || []).join('\n') });
  if (tf.status === 'failed' && !asserts.some((a) => a.status === 'failed')) failed.push({ file: tf.name, name: '(suite failed to run)', msg: tf.message || '' });
}
for (const f of failed) {
  console.log(`\nFAIL ${rel(f.file)} > ${f.name}`);
  console.log(f.msg.split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 12).join('\n'));
}
const ends = (r.testResults || []).map((t) => t.endTime).filter(Boolean);
const secs = ends.length ? Math.round((Math.max(...ends) - r.startTime) / 1000) : 0;
console.log(`\ntests: ${r.numPassedTests} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped of ${r.numTotalTests} in ${(r.testResults || []).length} file(s)${secs ? `, ${secs}s` : ''}`);
EOF
rm -f "$report" "$report.err"
exit 0
