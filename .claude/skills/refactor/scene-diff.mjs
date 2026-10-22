// node scene-diff.mjs A.txt B.txt noise1.txt [noise2.txt ...]: compare scene hashes, ignoring parts that differ
// between A and any noise run (same build as A). Prints the parts that differ beyond noise.
import fs from 'node:fs';
const load = (f) => new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => [`${e.s}|${e.p}`, e]));
const [a, b, ...noise] = process.argv.slice(2).map(load);
const noisy = new Set();
for (const n of noise) for (const [k, e] of a) { const m = n.get(k); if (!m) { noisy.add(k + '|*'); continue; } for (const part of Object.keys(e)) if (part !== 's' && part !== 'p' && e[part] !== m[part]) noisy.add(k + '|' + part); }
const diffs = []; const parts = new Map();
for (const [k, e] of a) {
  const f = b.get(k); if (!f) { if (!noisy.has(k + '|*')) diffs.push(`missing in B: ${k}`); continue; }
  for (const part of new Set([...Object.keys(e), ...Object.keys(f)])) { if (part === 's' || part === 'p') continue; if (e[part] !== f[part] && !noisy.has(k + '|' + part) && !noisy.has(k + '|*')) { diffs.push(`${part} ${k}`); parts.set(part, (parts.get(part) ?? 0) + 1); } }
}
for (const k of b.keys()) if (!a.has(k)) diffs.push(`extra in B: ${k}`);
console.log(`entries A ${a.size} B ${b.size}, noisy parts ${noisy.size}, differing ${diffs.length} ${JSON.stringify(Object.fromEntries(parts))}`);
for (const d of diffs.slice(0, 80)) console.log('  ' + d);
