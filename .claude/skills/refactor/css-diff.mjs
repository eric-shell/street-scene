// Canonical CSS comparison for a look-preserving refactor: node canon.mjs before.css after.css [map.json] [--area regex]
// Side A (before) is renamed through the map, both sides are normalized, then compared as
// (at-rule context, selector, property) -> value, plus a cascade check: for every pair of rules that can hit the
// same element and property with different values, the winner (importance, specificity, order) must not change.
//
// map.json:
//   classes:    { "old": "new" | "new1 new2" | null }    unique class tokens (null drops the rules that use it)
//   contextual: { "on": { "seg": "is-selected", ... } }   a generic token renamed by the nearest anchor class
//                                                         (same compound first, then the compounds before it)
//   patterns:   [["regex", "replacement"], ...]           applied to A's renamed, normalized selectors
//   split:      { "old selector": ["new", ...] }          one old rule written as several
//   keyframes:  { "old": "new" }
// order-ok.json (next to this script): [[regexA, regexB], ...] selector pairs known never to match one element.
import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const postcss = require('postcss');
const args = process.argv.slice(2); const areaIx = args.indexOf('--area'); const area = areaIx >= 0 ? new RegExp(args.splice(areaIx, 2)[1]) : null;
const [fa, fb, fm] = args;
const map = fm ? JSON.parse(fs.readFileSync(fm, 'utf8')) : {};
const okPairs = (() => { try { return JSON.parse(fs.readFileSync(new URL('./css-disjoint.json', import.meta.url), 'utf8')); } catch { return []; } })();
const unmapped = new Set();

const norm = (s) => s.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
const splitTop = (x, sep = ',') => { const out = []; let d = 0, b = 0, cur = ''; for (const ch of x) { if (ch === '(') d++; if (ch === ')') d--; if (ch === '[') b++; if (ch === ']') b--; if (ch === sep && d === 0 && b === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
// A selector as [compound, combinator, compound, ...] at the top level (parentheses kept whole).
function compounds(sel) { const out = []; let d = 0, b = 0, cur = ''; for (let i = 0; i < sel.length; i++) { const ch = sel[i]; if (ch === '(') d++; if (ch === ')') d--; if (ch === '[') b++; if (ch === ']') b--; if (d === 0 && b === 0 && /[\s>+~]/.test(ch)) { if (cur) out.push(cur); cur = ''; let c = ch; while (i + 1 < sel.length && /[\s>+~]/.test(sel[i + 1])) { i++; if (sel[i] !== ' ') c = sel[i]; } out.push(c === ' ' ? ' ' : c); } else cur += ch; } if (cur) out.push(cur); return out; }
// Rename one selector of side A: contextual tokens by anchor, then unique classes; recurse into :is()/:not()/:has().
function renameSel(sel, outer = []) {
  if (map.selectors?.[sel]) return map.selectors[sel];
  const parts = compounds(sel); const classesOf = (c) => [...c.replace(/\([^()]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  let drop = false;
  const out = parts.map((p, i) => {
    if (i % 2 === 1) return p;
    const ctxAnchors = [...classesOf(p).reverse(), ...parts.slice(0, i).filter((_, j) => j % 2 === 0).reverse().flatMap((q) => classesOf(q).reverse()), ...outer];
    p = p.replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (m, fn, inner) => `:${fn}(${splitTop(inner).map((x) => renameSel(norm(x), ctxAnchors)).join(',')})`);
    return p.replace(/\.([\w-]+)(?![\w-])/g, (m, c) => {
      if (map.contextual?.[c]) {
        const anchors = map.contextual[c];
        const same = classesOf(p).filter((x) => x !== c && anchors[x] !== undefined);
        let a = same[0];
        for (let j = i - 2; !a && j >= 0; j -= 2) a = classesOf(parts[j]).reverse().find((x) => anchors[x] !== undefined);
        if (!a) a = outer.find((x) => anchors[x] !== undefined);
        if (a !== undefined) { const r = anchors[a]; if (r === null) { drop = true; return m; } return '.' + r.split(' ').join('.'); }
        if (anchors['*'] !== undefined) return '.' + anchors['*'];
        unmapped.add(`${c} in ${sel}`); return m;
      }
      if (map.classes && c in map.classes) { const r = map.classes[c]; if (r === null) { drop = true; return m; } return '.' + r.split(' ').join('.'); }
      return m;
    });
  }).join('');
  return drop ? null : out;
}
// Normalize a compound: tag first, then sorted classes and attributes, then pseudos in order; a BEM modifier
// (.x--m) implies its block (.x), so the block is dropped from a compound that has the modifier.
function normCompound(c) {
  if (/^[>+~ ]$/.test(c)) return c;
  const m = c.match(/^(\*|[a-z][\w-]*)?((?:\.[\w-]+|\[[^\]]*\]|#[\w-]+)*)(.*)$/i); if (!m) return c;
  const tag = m[1] ?? '', simple = (m[2].match(/\.[\w-]+|\[[^\]]*\]|#[\w-]+/g) || []), rest = m[3];
  const cls = new Set(simple.filter((s) => s.startsWith('.')).map((s) => s.slice(1)));
  for (const k of [...cls]) { const mm = k.match(/^(.+)--[\w-]+$/); if (mm && cls.has(mm[1])) cls.delete(mm[1]); }
  const others = simple.filter((s) => !s.startsWith('.'));
  const pseudo = rest.replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (mm, fn, inner) => `:${fn}(${splitTop(inner).map((x) => normSel(x)).sort().join(',')})`);
  return tag + [...[...cls].sort().map((x) => '.' + x), ...others.sort()].join('') + pseudo;
}
// A BEM element needs no context of its own block: `.b .b__e` and `.b__x .b__e` compare as `.b__e`.
function dropImplied(parts) {
  const blockOf = (cls) => cls.replace(/(__|--).*$/, '');
  for (let i = 0; i + 2 < parts.length; i += 2) {
    const anc = parts[i], comb = parts[i + 1], next = parts[i + 2];
    if (comb !== ' ' && comb !== '>') continue;
    const m = anc.match(/^\.([\w-]+)$/); if (!m) continue;
    const els = [...next.matchAll(/\.([\w-]+__[\w-]+)/g)].map((x) => x[1]);
    if (els.some((e) => blockOf(e) === blockOf(m[1]) && !m[1].includes('--'))) { parts.splice(i, 2); i -= 2; }
  }
  return parts;
}
const normSel = (sel) => dropImplied(compounds(norm(sel)).map(normCompound)).join('');

function spec(sel) { // ids*10000 + classes*100 + types; :is/:not/:has take their most specific argument, :where counts nothing
  let s = sel, guard = 0;
  while (/:(is|where|not|has)\(/.test(s) && guard++ < 50) s = s.replace(/:(is|where|not|has)\(((?:[^()]|\([^()]*\))*)\)/, (m, fn, a) => { if (fn === 'where') return ''; const best = splitTop(a).map((x) => [spec(x.trim()), x.trim()]).sort((x, y) => y[0] - x[0])[0]; return best ? '§' + best[1].replace(/^([a-z][\w-]*)/, '¤$1') : ''; });
  s = s.replace(/¤/g, ' ').replace(/§/g, '');
  const ids = (s.match(/#[\w-]+/g) || []).length; const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!:)[\w-]+(\([^)]*\))?/g) || []).length; const el = (s.replace(/\[[^\]]*\]/g, '').match(/(^|[\s>+~(,])[a-z][\w-]*|::[\w-]+/g) || []).length; return ids * 10000 + cls * 100 + el; }

const renameVal = (prop, v) => (!map.keyframes || !/^animation(-name)?$/.test(prop) ? v : v.replace(/[\w-]+/g, (w) => map.keyframes[w] ?? w));
function load(file, rename) {
  const root = postcss.parse(fs.readFileSync(file, 'utf8'));
  const decls = new Map(); const entries = new Map(); const kf = new Map(); let i = 0;
  root.walkAtRules(/keyframes$/, (a) => { let name = a.params.trim(); if (rename) name = map.keyframes?.[name] ?? name; kf.set(name, norm(a.nodes.map((n) => n.toString()).join(';'))); });
  root.walkRules((r) => {
    if (r.parent.type === 'atrule' && /keyframes/.test(r.parent.name)) return;
    const ctx = []; for (let p = r.parent; p && p.type !== 'root'; p = p.parent) if (p.type === 'atrule') ctx.unshift('@' + p.name + ' ' + norm(p.params));
    const c = ctx.join(' / ');
    const sels = [];
    for (let sel of r.selectors) {
      sel = norm(sel); const sp = spec(sel);
      const list = rename && map.split?.[sel] ? map.split[sel].map(norm) : [sel];
      for (let s of list) {
        if (rename) { s = renameSel(s); if (s === null) continue; s = normSel(s); for (const [re, rep] of map.patterns ?? []) s = s.replace(new RegExp(re, 'g'), rep); s = normSel(s); }
        else s = normSel(s);
        sels.push([s, rename && map.split?.[sel] ? spec(s) : sp]);
      }
    }
    for (const [sel, sp] of sels) r.each((d) => {
      if (d.type !== 'decl') return;
      const v = norm(rename ? renameVal(d.prop, d.value) : d.value); const key = `${c} | ${sel} | ${d.prop}`;
      decls.set(key, v + (d.important ? ' !important' : ''));
      entries.set(key, { key, ctx: c, sel, prop: d.prop, i: i++, sp, imp: !!d.important });
    });
  });
  return { decls, entries, kf };
}
function inlineRootVars(side) {
  const where = new Map();
  for (const [k, v] of side.decls) { const [c, sel, prop] = k.split(' | '); if (!prop.startsWith('--')) continue; (where.get(prop) || where.set(prop, []).get(prop)).push({ c, sel, v }); }
  const consts = new Map(); for (const [prop, ds] of where) if (ds.length === 1 && ds[0].sel === ':root' && !ds[0].c) consts.set(prop, ds[0].v);
  const sub = (v) => { for (let n = 0; n < 8; n++) { const w = v.replace(/var\((--[\w-]+)\)/g, (m, name) => consts.get(name) ?? m); if (w === v) break; v = w; } return v; };
  for (const [k, v] of side.decls) side.decls.set(k, sub(v));
  for (const prop of consts.keys()) { side.decls.delete(` | :root | ${prop}`); side.entries.delete(` | :root | ${prop}`); }
}
const A = load(fa, true), B = load(fb, false); inlineRootVars(A); inlineRootVars(B);
const inArea = (k) => !area || area.test(k);
const onlyA = [...A.decls.keys()].filter((k) => !B.decls.has(k) && inArea(k)), onlyB = [...B.decls.keys()].filter((k) => !A.decls.has(k) && inArea(k));
const diff = [...A.decls.keys()].filter((k) => B.decls.has(k) && A.decls.get(k) !== B.decls.get(k) && inArea(k));
const group = (keys, side) => { const g = new Map(); for (const k of keys) { const [c, s, p] = k.split(' | '); const gk = `${c ? c + ' :: ' : ''}${s}`; (g.get(gk) || g.set(gk, []).get(gk)).push(p + ': ' + side.decls.get(k)); } return [...g].map(([s, ps]) => `  ${s} { ${ps.join('; ')} }`).join('\n'); };
console.log(`decls A ${A.decls.size}, B ${B.decls.size}`);
if (unmapped.size) console.log(`\nContextual tokens with no anchor (${unmapped.size}):\n  ${[...unmapped].slice(0, 40).join('\n  ')}`);
if (onlyA.length) console.log(`\nOnly in A (${onlyA.length}):\n${group(onlyA, A)}`);
if (onlyB.length) console.log(`\nOnly in B (${onlyB.length}):\n${group(onlyB, B)}`);
if (diff.length) console.log(`\nDifferent values (${diff.length}):\n${diff.map((k) => `  ${k}: ${A.decls.get(k)}  ->  ${B.decls.get(k)}`).join('\n')}`);

// Cascade check over rules present on both sides.
// A selector's signature: per compound from the right, its tokens (tag, classes with their BEM blocks, attributes,
// pseudo-classes, pseudo-element).
const sigCache = new Map();
function sig(sel) {
  if (sigCache.has(sel)) return sigCache.get(sel);
  const cs = compounds(sel).filter((_, i) => i % 2 === 0).reverse().map((c) => {
    const t = new Set(); const bare = c.replace(/:(is|not|has|where)\((?:[^()]|\([^()]*\))*\)/g, (m, fn) => { t.add(m);
      // :is()/:where() alternatives: the element is one of them, so their classes identify it (marked ~ as alternatives).
      if (fn === 'is' || fn === 'where') for (const x of m.matchAll(/\.([\w-]+)/g)) { t.add('~.' + x[1]); const bb = x[1].match(/^(.+)--[\w-]+$/); if (bb) t.add('~.' + bb[1]); }
      return ''; });
    const tg = bare.match(/^[a-z][\w-]*/); if (tg) t.add('<' + tg[0]);
    for (const m of bare.matchAll(/\.([\w-]+)/g)) { t.add('.' + m[1]); const bb = m[1].match(/^(.+)--[\w-]+$/); if (bb) t.add('.' + bb[1]); }
    for (const m of bare.matchAll(/\[[^\]]*\]|(?<!:):(?!:)[\w-]+|::[\w-]+/g)) t.add(m[0]);
    return t;
  });
  sigCache.set(sel, cs); return cs;
}
const has = (t, p) => [...t].some((x) => x.startsWith(p));
// Can two selectors hit one element? Their rightmost compounds must agree on tag and pseudo-element and share a
// class, or, when one of them names no class, their parents must share one.
function overlap(a, b) {
  const x = sig(a), y = sig(b); const rx = x[0], ry = y[0];
  const pe = (t) => [...t].find((v) => v.startsWith('::')) ?? '';
  if (pe(rx) !== pe(ry)) return false;
  const tag = (t) => [...t].find((v) => v.startsWith('<'));
  if (tag(rx) && tag(ry) && tag(rx) !== tag(ry)) return false;
  const ident = (t) => { const own = [...t].filter((v) => v.startsWith('.') && !v.startsWith('.is-')); return own.length ? own : [...t].filter((v) => v.startsWith('~.') && !v.startsWith('~.is-')).map((v) => v.slice(1)); };
  const cx = ident(rx), cy = ident(ry);
  // Through a child combinator both parents are one element too.
  const kid = (sel) => { const cs = compounds(sel); return cs.length >= 3 && cs[cs.length - 2] === '>'; };
  if (kid(a) && kid(b) && x[1] && y[1]) { const p1 = ident(x[1]), p2 = ident(y[1]); if (p1.length && p2.length && !p1.some((c) => p2.includes(c))) return false; }
  if (cx.length && cy.length) return cx.some((c) => cy.includes(c));
  if (cx.length || cy.length) { const tagOnly = cx.length ? ry : rx; return !tag(tagOnly) && ![...tagOnly].some((v) => v.startsWith('.')) && !has(tagOnly, '['); }
  const px = x[1], py = y[1]; if (!px || !py) return true;
  const pcx = ident(px), pcy = ident(py);
  if (!pcx.length || !pcy.length) return true; return pcx.some((c) => pcy.includes(c));
}
// c covers a when every compound of a (from the right) is a subset of c's compound at the same depth.
const covers = (c, a) => { const sc = sig(c), sa = sig(a); if (sa.length > sc.length) return false; return sa.every((t, i) => [...t].every((v) => sc[i].has(v))); };
const disjoint = (x, y) => okPairs.some(([p, q]) => (new RegExp(p).test(x) && new RegExp(q).test(y)) || (new RegExp(p).test(y) && new RegExp(q).test(x)));
const beats = (e, f) => (e.imp !== f.imp ? e.imp : e.sp !== f.sp ? e.sp > f.sp : e.i > f.i);
const byProp = new Map(); for (const [k, e] of A.entries) if (B.entries.has(k) && A.decls.has(k)) (byProp.get(e.prop + '|' + e.ctx) || byProp.set(e.prop + '|' + e.ctx, []).get(e.prop + '|' + e.ctx)).push(e);
const allByProp = new Map(); for (const [k, e] of A.entries) if (B.entries.has(k)) (allByProp.get(e.prop) || allByProp.set(e.prop, []).get(e.prop)).push(e);
const flips = [];
for (const side of [A, B]) { side.byPropAll = new Map(); for (const e of side.entries.values()) if (side.decls.has(e.key)) (side.byPropAll.get(e.prop) || side.byPropAll.set(e.prop, []).get(e.prop)).push(e); }
const props = new Set([...A.entries.values()].map((e) => e.prop));
for (const prop of props) {
  const es = (allByProp.get(prop) ?? []);
  for (let x = 0; x < es.length; x++) for (let y = x + 1; y < es.length; y++) {
    const a = es[x], b = es[y]; if (A.decls.get(a.key) === A.decls.get(b.key)) continue;
    if (!overlap(a.sel, b.sel) || disjoint(a.sel, b.sel)) continue;
    const wa = beats(a, b), wb = beats(B.entries.get(a.key), B.entries.get(b.key));
    if (wa === wb || !(inArea(a.key) || inArea(b.key))) continue;
    // What an element matching both gets on each side: the strongest of the two and every rule that covers both.
    const effective = (side, ea, eb) => { let best = beats(ea, eb) ? ea : eb; for (const c of side.byPropAll.get(prop) ?? []) if (c.key !== ea.key && c.key !== eb.key && (!c.ctx || c.ctx === ea.ctx || c.ctx === eb.ctx) && covers(c.sel, a.sel) && covers(c.sel, b.sel) && beats(c, best)) best = c; return side.decls.get(best.key); };
    if (effective(A, a, b) === effective(B, B.entries.get(a.key), B.entries.get(b.key))) continue;
    flips.push(`  ${prop}: ${wa ? 'A' : 'B'} won [${a.ctx}] ${a.sel} (${a.sp}) vs [${b.ctx}] ${b.sel} (${b.sp}); now [${B.entries.get(a.key).sp}] vs [${B.entries.get(b.key).sp}]`);
  }
}
if (flips.length) console.log(`\nCascade winners that changed (${flips.length}):\n${flips.join('\n')}`);
const kOnlyA = [...A.kf.keys()].filter((k) => !B.kf.has(k)), kOnlyB = [...B.kf.keys()].filter((k) => !A.kf.has(k)), kDiff = [...A.kf.keys()].filter((k) => B.kf.has(k) && A.kf.get(k) !== B.kf.get(k));
if (kOnlyA.length || kOnlyB.length || kDiff.length) console.log(`\nKeyframes only A: ${kOnlyA.join(' ')}\nKeyframes only B: ${kOnlyB.join(' ')}\nKeyframes differ: ${kDiff.join(' ')}`);
if (!onlyA.length && !onlyB.length && !diff.length && !flips.length && !kOnlyA.length && !kOnlyB.length && !kDiff.length && !unmapped.size) console.log('EQUIVALENT');
