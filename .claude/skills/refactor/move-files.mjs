// Move files with git mv and rewrite every relative TS import (and SCSS @use/@forward) that pointed at a moved file
// or was written from a moved file. Usage: node move.mjs <repoRoot> <moves.json> [--dry]
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const [root, movesFile, dry] = [process.argv[2], process.argv[3], process.argv[4] === '--dry'];
const moves = JSON.parse(fs.readFileSync(movesFile, 'utf8')); // { "src/ui/dom.ts": "src/ui/kit/dom.ts", ... }
const abs = (p) => path.resolve(root, p);
const mv = new Map(Object.entries(moves).map(([a, b]) => [abs(a), abs(b)]));
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) walk(p, out); } else if (/\.(ts|mts|mjs|scss)$/.test(p)) out.push(p); } return out; };
const files = ['src', 'tests', 'scripts', 'e2e'].filter((d) => fs.existsSync(abs(d))).flatMap((d) => walk(abs(d)));
const tsExts = ['', '.ts', '.tsx', '.mts', '.js', '/index.ts'];
const resolveTs = (fromDir, spec) => { const base = path.resolve(fromDir, spec); for (const e of tsExts) if (fs.existsSync(base + e) && fs.statSync(base + e).isFile()) return [base + e, e]; return [null, null]; };
const resolveScss = (fromDir, spec) => { const d = path.dirname(path.resolve(fromDir, spec)), b = path.basename(spec); for (const c of [`_${b}.scss`, `${b}.scss`, `${b}/_index.scss`]) { const p = path.join(d, c); if (fs.existsSync(p)) return [p, c]; } return [null, null]; };
const rel = (fromDir, to) => { let r = path.relative(fromDir, to).split(path.sep).join('/'); if (!r.startsWith('.')) r = './' + r; return r; };
let changed = 0;
for (const f of files) {
  const newF = mv.get(f) ?? f; const oldDir = path.dirname(f), newDir = path.dirname(newF);
  const src = fs.readFileSync(f, 'utf8'); let out = src;
  if (f.endsWith('.scss')) {
    out = src.replace(/(@(?:use|forward)\s+')(\.{1,2}\/[^']+|[^':]+)(')/g, (m, a, spec, z) => {
      if (spec.startsWith('sass:')) return m;
      const [target, how] = resolveScss(oldDir, spec); if (!target) return m;
      const nt = mv.get(target) ?? target; if (nt === target && newDir === oldDir) return m;
      let r = rel(newDir, nt).replace(/\.scss$/, ''); r = r.replace(/(^|\/)_([^/]+)$/, '$1$2');
      if (r.startsWith('./')) r = r.slice(2);
      return a + r + z;
    });
  } else {
    out = src.replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)(['"])/g, (m, a, spec, z) => {
      const q = spec.indexOf('?'); const bare = q >= 0 ? spec.slice(0, q) : spec, query = q >= 0 ? spec.slice(q) : '';
      const [target, ext] = resolveTs(oldDir, bare); if (!target) return m;
      const nt = mv.get(target) ?? target; if (nt === target && newDir === oldDir) return m;
      let r = rel(newDir, nt); if (ext && ext !== '' && bare.endsWith(ext) === false) r = r.slice(0, r.length - ext.length);
      return a + r + query + z;
    });
  }
  if (out !== src) { changed++; if (!dry) fs.writeFileSync(f, out); else console.log('would rewrite', path.relative(root, f)); }
}
for (const [a, b] of mv) { if (dry) { console.log('mv', path.relative(root, a), '->', path.relative(root, b)); continue; } fs.mkdirSync(path.dirname(b), { recursive: true }); execFileSync('git', ['mv', a, b], { cwd: root }); }
console.log(`${dry ? 'would rewrite' : 'rewrote'} ${changed} files, ${mv.size} moves`);
