// Classes the TS emits or queries that the compiled CSS never mentions (leftover old names, typos, or pure hooks).
// node orphans.mjs <repoRoot> <compiled.css>
import fs from 'node:fs'; import path from 'node:path';
const [root, cssFile] = process.argv.slice(2);
const css = new Set([...fs.readFileSync(cssFile, 'utf8').matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p); } return out; };
const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'e2e'))];
const strs = (s) => [...s.matchAll(/'([^']*)'|`([^`]*)`|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const toks = (s) => s.replace(/\$\{[^}]*?['"]\s*([\w -]+)\s*['"][^}]*\}/g, ' $1 ').replace(/\$\{[^}]*\}/g, '*').split(/\s+/).filter((w) => /^-{0,2}[a-z][\w*-]*$/i.test(w));
const out = new Map();
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8'); const rel = path.relative(root, f);
  const add = (w, how) => { if (w.includes('*') || css.has(w)) return; if (w.startsWith('--')) return; const k = `${w}`; (out.get(k) || out.set(k, new Set()).get(k)).add(`${rel}(${how})`); };
  for (const m of t.matchAll(/class(?:Name)?\s*[:=]\s*('[^']*'|`[^`]*`|"[^"]*")/g)) for (const w of toks(m[1].slice(1, -1))) add(w, 'class');
  for (const m of t.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g)) for (const s of strs(m[1])) for (const w of toks(s)) add(w, 'classList');
  for (const m of t.matchAll(/(?:querySelector(?:All)?|closest|matches|locator|waitForSelector)(?:<[^>]*>)?\(\s*('[^']*'|`[^`]*`|"[^"]*")/g)) for (const c of m[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)) add(c[1], 'query');
  for (const m of t.matchAll(/\b(?:btn|iconBtn|chip|navRow|railScreen|bem|segmented)\(([^;]*?)\)(?=[,;)\s])/g)) { const ss = strs(m[1]); const last = ss[ss.length - 1]; if (last !== undefined) for (const w of toks(last)) add(w, 'helper'); }
}
for (const [k, v] of [...out].sort()) console.log(`${k}: ${[...v].slice(0, 4).join(', ')}`);
