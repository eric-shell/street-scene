// Exports nothing imports: parses every import (named, namespace, dynamic) across src, tests, scripts and e2e,
// resolves relative specifiers, and lists src exports with no importer, marking those used inside their module.
import fs from 'node:fs'; import path from 'node:path';
const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const walk = (d, out = []) => { if (!fs.existsSync(d)) return out; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(ts|mts)$/.test(p) && !p.endsWith('.d.ts')) out.push(p); } return out; };
const files = ['src', 'tests', 'scripts', 'e2e', '.claude'].flatMap((d) => walk(path.join(root, d)));
const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const resolve = (from, spec) => { if (!spec.startsWith('.')) return null; const b = path.resolve(path.dirname(from), spec.replace(/\?.*$/, '')); for (const c of [b, b + '.ts', b + '/index.ts', b.replace(/\.js$/, '.ts')]) if (text.has(c)) return c; return null; };
const used = new Map(); // file -> Set(names) ; '*' = everything
const mark = (f, n) => (used.get(f) || used.set(f, new Set()).get(f)).add(n);
for (const [f, t] of text) {
  for (const m of t.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolve(f, m[3]); if (!target) continue; const clause = m[2];
    const named = clause.match(/\{([\s\S]*)\}/); if (named) for (const part of named[1].split(',')) { const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim(); if (n) mark(target, n); }
    const ns = clause.match(/\*\s+as\s+(\w+)/); if (ns) { for (const a of t.matchAll(new RegExp(`\\b${ns[1]}\\.(\\w+)`, 'g'))) mark(target, a[1]); }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim(); if (def) mark(target, 'default');
  }
  for (const m of t.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) { const target = resolve(f, m[2]); if (target) for (const part of m[1].split(',')) mark(target, part.trim().split(/\s+as\s+/)[0]); }
  for (const m of t.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) { const target = resolve(f, m[1]); if (target) mark(target, '*'); }
  for (const m of t.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) { const target = resolve(f, m[1]); if (target) mark(target, '*'); }
}
const out = [];
for (const [f, t] of text) {
  if (!f.startsWith(root + '/src/')) continue;
  const u = used.get(f) ?? new Set(); if (u.has('*')) continue;
  for (const m of t.matchAll(/^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+(\w+)/gm)) {
    const n = m[2]; if (u.has(n)) continue;
    const line = t.slice(0, m.index).split('\n').length;
    const inside = (t.match(new RegExp(`\\b${n}\\b`, 'g')) || []).length > 1;
    out.push(`${path.relative(root, f)}:${line}  ${m[1]} ${n}${inside ? '' : '  UNUSED'}`);
  }
}
console.log(out.sort().join('\n')); console.error(`${out.length} exports with no importer (${out.filter((x) => x.endsWith('UNUSED')).length} unused anywhere)`);
