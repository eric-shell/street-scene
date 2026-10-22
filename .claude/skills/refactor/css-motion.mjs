// Evaluate prefers-reduced-motion for one environment: node motion-env.mjs in.css out.css <motion|reduce> [--fold]
// motion: no-preference blocks are unwrapped, reduce blocks dropped; reduce: the other way round.
// --fold (reduce only): every `animation: none` that came from a reduce block is applied: the animation
// declarations of every rule it covers (its selector matches all their elements) are removed, then the
// override itself, so a stylesheet that overrides animations compares with one that never declares them.
import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const postcss = require('postcss');
const [inFile, outFile, env, ...flags] = process.argv.slice(2);
const fold = flags.includes('--fold');
const root = postcss.parse(fs.readFileSync(inFile, 'utf8'));
const overrides = [];
root.walkAtRules('media', (a) => {
  const p = a.params.replace(/\s+/g, ' ').trim();
  const m = p.match(/^\(prefers-reduced-motion: (reduce|no-preference)\)$/);
  if (!m) return;
  const matches = (m[1] === 'reduce') === (env === 'reduce');
  if (!matches) { a.remove(); return; }
  if (fold && m[1] === 'reduce') a.walkRules((r) => r.walkDecls(/^animation$/, (d) => { if (d.value.trim() === 'none') overrides.push({ rule: r, decl: d }); }));
  a.replaceWith(a.nodes);
});
// Selector coverage: does R match every element X matches? Compounds from the right; R's rightmost must be a
// subset of X's rightmost, R's ancestors subsets of X's ancestors in order (descendant combinators).
const split = (sel) => sel.replace(/\s*([>+~])\s*/g, ' ').trim().split(/\s+/);
const tokens = (c) => { const t = new Set(); let s = c.replace(/:(is|not|has|where)\((?:[^()]|\([^()]*\))*\)/g, (m) => { t.add(m); return ''; });
  const tg = s.match(/^[a-z][\w-]*/); if (tg) t.add('<' + tg[0]);
  for (const m of s.matchAll(/\.([\w-]+)/g)) { t.add('.' + m[1]); const b = m[1].match(/^(.+)--[\w-]+$/); if (b) t.add('.' + b[1]); }
  for (const m of s.matchAll(/\[[^\]]*\]|(?<!:):(?!:)[\w-]+|::[\w-]+/g)) t.add(m[0]); return t; };
function covers(r, x) {
  const rc = split(r).map(tokens).reverse(), xc = split(x).map(tokens).reverse();
  const pe = (t) => [...t].find((v) => v.startsWith('::')) ?? '';
  if (pe(rc[0]) !== pe(xc[0])) return false;
  if (![...rc[0]].every((v) => xc[0].has(v))) return false;
  let j = 1; for (let i = 1; i < rc.length; i++) { while (j < xc.length && ![...rc[i]].every((v) => xc[j].has(v))) j++; if (j >= xc.length) return false; j++; }
  return true;
}
let removed = 0;
for (const { rule, decl } of overrides) {
  const rs = rule.selectors;
  root.walkRules((x) => {
    if (x.parent.type === 'atrule' && /keyframes/.test(x.parent.name)) return;
    for (const xs of x.selectors) {
      if (!rs.some((r) => covers(r, xs))) continue;
      // Only when every selector of the rule is covered; otherwise split the rule.
      if (x.selectors.length > 1) { const clone = x.clone({ selector: xs }); x.selector = x.selectors.filter((s) => s !== xs).join(','); x.after(clone); }
      break;
    }
  });
  root.walkRules((x) => {
    if (x.parent.type === 'atrule' && /keyframes/.test(x.parent.name)) return;
    if (x.selectors.length === 1 && rs.some((r) => covers(r, x.selector))) x.walkDecls(/^animation/, (d) => { if (d !== decl) { d.remove(); removed++; } });
  });
  decl.remove();
}
root.walkRules((r) => { if (!r.nodes.length) r.remove(); });
fs.writeFileSync(outFile, root.toString());
if (fold) console.error(`folded ${overrides.length} overrides, removed ${removed} animation declarations`);
