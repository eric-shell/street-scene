#!/usr/bin/env node
/**
 * Look-preservation harness, compare side: diffs two capture.mjs runs element
 * by element (matched by structural path per scenario and viewport) and prints
 * what differs, grouped so one change seen on many elements prints once.
 *
 *   node compare.mjs <dirA> <dirB> [noiseDir ...] [options]
 *
 * noiseDir: another capture of the same build as dirA (or several). Anything
 * that differs between dirA and a noiseDir (an element's property, its box,
 * text, attributes, inline style or presence) is noise and is left out of the
 * A/B report.
 *
 * Options:
 *   --map=renameMap.json   {"classes", "keyframes", "customProps"}: custom
 *                          property names and animation-name values of A are
 *                          renamed before comparing, and B's class attributes
 *                          are checked against A's mapped through "classes"
 *   --noise-out=file.json  write the noise keys (from the noise dirs, or from
 *                          A vs B itself when no noise dir is given)
 *   --noise-in=file.json   add noise keys saved earlier
 *   --ignore=regex         properties to ignore everywhere (e.g. '^transition')
 *   --only=regex           scenarios (viewport/id) to compare
 *   --limit=N              occurrences printed per group (default 6)
 *   --json=file.json       also write the full diff as JSON
 *   --verbose              print box, text and attribute differences in full
 *   --strict-custom        count custom property (--*) differences as failures
 *   --box-tol=PX           ignore box differences up to PX on every edge (default 0: exact)
 *
 * The class attribute is never compared (only shown for reference), and
 * animation-name and custom property (--*) differences are reported in their
 * own sections, not as failures: a token on its own draws nothing, and any
 * property that reads it through var() shows up as a real difference. Exit code 1 when anything other than noise and animation-name
 * differs, 0 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
if (pos.length < 2) {
  console.error('usage: node compare.mjs <dirA> <dirB> [noiseDir ...] [--map=renameMap.json] [--noise-out=f] [--noise-in=f] [--ignore=re] [--only=re] [--limit=N] [--json=f] [--verbose]');
  process.exit(2);
}
const [dirA, dirB, ...noiseDirs] = pos.map((p) => path.resolve(p));
const MAP = opt.map ? JSON.parse(fs.readFileSync(opt.map, 'utf8')) : {};
const CLASS_MAP = MAP.classes ?? {};
const KF_MAP = MAP.keyframes ?? {};
const CP_MAP = MAP.customProps ?? {};
const IGNORE = opt.ignore ? new RegExp(opt.ignore) : null;
const ONLY = opt.only ? new RegExp(opt.only) : null;
const LIMIT = Number(opt.limit ?? 6);
const VERBOSE = !!opt.verbose;
const STRICT_CUSTOM = !!opt['strict-custom'];
const BOX_TOL = Number(opt['box-tol'] ?? 0);
const boxDiffers = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => Math.abs(v - b[i]) > BOX_TOL);
const PSEUDOS = ['::before', '::after', '::marker'];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/** viewport/id -> file, for every scenario dump in a capture directory. */
function listScenarios(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const vp of fs.readdirSync(dir)) {
    const d = path.join(dir, vp);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) out.set(`${vp}/${f.slice(0, -5)}`, path.join(d, f));
  }
  return out;
}

/** A scenario dump with every element's full computed style expanded (sparse rows over the per-file defaults). */
function load(file, renameA = false) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expand = (sparse, defaults) => {
    const o = { ...defaults };
    for (const k in sparse) if (sparse[k] === null) delete o[k]; else o[k] = sparse[k];
    if (renameA) return renameStyle(o);
    return o;
  };
  const els = new Map();
  for (const e of d.elements) {
    const row = { p: e.p, c: e.c ?? '', s: e.s ?? '', t: e.t ?? '', a: e.a ?? '', r: e.r, cs: expand(e.cs, d.defaults) };
    for (const pe of PSEUDOS) if (e[pe]) row[pe] = expand(e[pe], d.pseudoDefaults);
    els.set(e.p, row);
  }
  return { els, anims: d.anims ?? [], bodyClass: d.bodyClass };
}

/** Side A through the rename map: custom property names and animation names. */
function renameStyle(o) {
  if (!Object.keys(CP_MAP).length && !Object.keys(KF_MAP).length) return o;
  const out = {};
  for (const k in o) out[CP_MAP[k] ?? k] = o[k];
  if (out['animation-name'] && Object.keys(KF_MAP).length) out['animation-name'] = out['animation-name'].split(',').map((n) => KF_MAP[n.trim()] ?? n.trim()).join(', ');
  return out;
}

// ---------------------------------------------------------------------------
// Diffing one scenario
// ---------------------------------------------------------------------------
/**
 * Every difference between two loaded dumps, as keyed entries:
 *   path|@presence, path|@text, path|@box, path|@style, path|@attr,
 *   path|<pseudo>|@presence, path|<pseudo>|<prop>
 * (pseudo is '' for the element itself).
 */
function diffScenario(A, B) {
  const out = [];
  for (const [p, a] of A.els) {
    const b = B.els.get(p);
    if (!b) {
      out.push({ k: `${p}|@presence`, p, kind: 'missing', a: a.c });
      continue;
    }
    if (a.t !== b.t) out.push({ k: `${p}|@text`, p, kind: 'text', a: a.t, b: b.t, ca: a.c, cb: b.c });
    if (a.s !== b.s) out.push({ k: `${p}|@style`, p, kind: 'inline', a: a.s, b: b.s, ca: a.c, cb: b.c });
    if (a.a !== b.a) out.push({ k: `${p}|@attr`, p, kind: 'attr', a: a.a, b: b.a, ca: a.c, cb: b.c });
    if (boxDiffers(a.r, b.r)) out.push({ k: `${p}|@box`, p, kind: 'box', a: a.r, b: b.r, ca: a.c, cb: b.c });
    for (const pe of ['', ...PSEUDOS]) {
      const sa = pe ? a[pe] : a.cs;
      const sb = pe ? b[pe] : b.cs;
      if (!sa && !sb) continue;
      if (!sa || !sb) {
        out.push({ k: `${p}|${pe}|@presence`, p, pe, kind: 'pseudo', a: !!sa, b: !!sb, ca: a.c, cb: b.c });
        continue;
      }
      const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
      for (const prop of keys) {
        if (sa[prop] === sb[prop]) continue;
        if (IGNORE && IGNORE.test(prop)) continue;
        out.push({ k: `${p}|${pe}|${prop}`, p, pe, prop, kind: 'prop', a: sa[prop], b: sb[prop], ca: a.c, cb: b.c });
      }
    }
  }
  for (const [p, b] of B.els) if (!A.els.has(p)) out.push({ k: `${p}|@presence`, p, kind: 'extra', b: b.c });
  return out;
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------
const listA = listScenarios(dirA);
const listB = listScenarios(dirB);
const noise = new Set();
const noiseProps = new Map();
if (opt['noise-in']) for (const k of JSON.parse(fs.readFileSync(opt['noise-in'], 'utf8')).keys) noise.add(k);
for (const nd of noiseDirs) {
  const listN = listScenarios(nd);
  for (const [id, fa] of listA) {
    if (ONLY && !ONLY.test(id)) continue;
    const fn = listN.get(id);
    if (!fn) continue;
    for (const d of diffScenario(load(fa, true), load(fn, true))) {
      noise.add(`${id}#${d.k}`);
      const label = d.kind === 'prop' ? (d.pe ? `${d.pe} ${d.prop}` : d.prop) : `@${d.kind}`;
      noiseProps.set(label, (noiseProps.get(label) ?? 0) + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// A vs B
// ---------------------------------------------------------------------------
const ids = [...new Set([...listA.keys(), ...listB.keys()])].filter((id) => !ONLY || ONLY.test(id)).sort();
const rows = [];
const groups = new Map();
const anim = new Map();
/** Custom property name -> { added, removed, changed, example } over every element and pseudo. */
const custom = new Map();
const isCustom = (d) => !STRICT_CUSTOM && d.kind === 'prop' && d.prop.startsWith('--');
const structural = [];
const boxes = [];
const texts = [];
const attrs = [];
const inline = [];
const pseudoPresence = [];
const classCheck = [];
const allKeys = [];
let failing = 0;

const classOf = (c) => (c ? `.${c.trim().split(/\s+/).join('.')}` : '(no class)');
const sortTokens = (c) => c.trim().split(/\s+/).filter(Boolean).sort().join(' ');
const mapClasses = (c) => c.trim().split(/\s+/).filter(Boolean).flatMap((t) => String(CLASS_MAP[t] ?? t).trim().split(/\s+/)).sort().join(' ');

for (const id of ids) {
  const fa = listA.get(id);
  const fb = listB.get(id);
  if (!fa || !fb) {
    rows.push({ id, note: !fa ? 'only in B' : 'only in A' });
    failing++;
    continue;
  }
  const A = load(fa, true);
  const B = load(fb);
  const diffs = diffScenario(A, B);
  const row = { id, a: A.els.size, b: B.els.size, missing: 0, extra: 0, styled: new Set(), box: 0, text: 0, noise: 0, anim: 0, custom: 0 };
  for (const d of diffs) {
    allKeys.push(`${id}#${d.k}`);
    if (noise.has(`${id}#${d.k}`)) {
      row.noise++;
      continue;
    }
    const where = `${id} ${d.p}${d.pe ? ' ' + d.pe : ''}`;
    const cls = d.kind === 'missing' ? classOf(d.a) : d.kind === 'extra' ? classOf(d.b) : classOf(d.ca) === classOf(d.cb) ? classOf(d.ca) : `${classOf(d.ca)} -> ${classOf(d.cb)}`;
    switch (d.kind) {
      case 'missing':
      case 'extra':
        row[d.kind]++;
        structural.push(`${d.kind === 'missing' ? 'missing in B' : 'extra in B  '} ${id} ${d.p}  ${cls}`);
        break;
      case 'box':
        row.box++;
        boxes.push(`${where}  ${cls}  [${d.a}] -> [${d.b}]`);
        break;
      case 'text':
        row.text++;
        texts.push(`${where}  ${cls}  ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`);
        break;
      case 'attr':
        attrs.push(`${where}  ${cls}\n      A: ${d.a}\n      B: ${d.b}`);
        break;
      case 'inline':
        inline.push(`${where}  ${cls}  style="${d.a}" -> style="${d.b}"`);
        break;
      case 'pseudo':
        pseudoPresence.push(`${where}  ${cls}  ${d.a ? 'present' : 'absent'} -> ${d.b ? 'present' : 'absent'}`);
        row.styled.add(d.p);
        break;
      case 'prop': {
        if (d.prop === 'animation-name') {
          row.anim++;
          const key = `${d.a} -> ${d.b}`;
          anim.set(key, (anim.get(key) ?? 0) + 1);
          break;
        }
        if (isCustom(d)) {
          row.custom++;
          let c = custom.get(d.prop);
          if (!c) custom.set(d.prop, (c = { added: 0, removed: 0, changed: 0, example: null }));
          c[d.a === undefined ? 'added' : d.b === undefined ? 'removed' : 'changed']++;
          if (!c.example) c.example = `${d.a ?? '(unset)'} -> ${d.b ?? '(unset)'}  at ${id} ${d.p}${d.pe ? ' ' + d.pe : ''}`;
          break;
        }
        row.styled.add(d.p + (d.pe ?? ''));
        break;
      }
    }
  }
  // Group each element's (or pseudo's) property changes into one signature.
  const perEl = new Map();
  for (const d of diffs) {
    if (d.kind !== 'prop' || d.prop === 'animation-name' || isCustom(d) || noise.has(`${id}#${d.k}`)) continue;
    const k = d.p + '|' + (d.pe ?? '');
    let e = perEl.get(k);
    if (!e) perEl.set(k, (e = { d, props: [] }));
    e.props.push(`${d.pe ? d.pe + ' ' : ''}${d.prop}: ${d.a ?? '(unset)'} -> ${d.b ?? '(unset)'}`);
  }
  for (const { d, props } of perEl.values()) {
    const sig = props.sort().join('\n    ');
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = []));
    g.push(`${id} ${d.p}  ${classOf(d.ca) === classOf(d.cb) ? classOf(d.ca) : `${classOf(d.ca)} -> ${classOf(d.cb)}`}`);
  }
  // The rename map check: B's classes should be A's mapped through it.
  if (Object.keys(CLASS_MAP).length) {
    for (const [p, a] of A.els) {
      const b = B.els.get(p);
      if (b && mapClasses(a.c) !== sortTokens(b.c)) classCheck.push(`${id} ${p}  ${classOf(a.c)} maps to ${classOf(mapClasses(a.c))}, B has ${classOf(b.c)}`);
    }
  }
  if (row.missing || row.extra || row.styled.size || row.box || row.text) failing++;
  rows.push(row);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const out = [];
const head = (t) => out.push('', `== ${t} ==`);
const capped = (list, n = LIMIT) => [...list.slice(0, n), ...(list.length > n ? [`... and ${list.length - n} more`] : [])];

out.push(`A: ${dirA}`, `B: ${dirB}`);
if (noiseDirs.length || opt['noise-in']) out.push(`noise: ${noise.size} keys from ${[...noiseDirs, opt['noise-in']].filter(Boolean).join(', ')}`);

head('Summary per scenario (elements A/B, missing, extra, restyled elements, moved boxes, text changes; info: noise ignored, animation-name and custom property changes)');
const w = Math.max(10, ...rows.map((r) => r.id.length));
for (const r of rows) {
  if (r.note) out.push(`${r.id.padEnd(w)}  ${r.note}`);
  else {
    const bad = r.missing || r.extra || r.styled.size || r.box || r.text;
    out.push(`${r.id.padEnd(w)}  ${String(r.a).padStart(4)}/${String(r.b).padEnd(4)} miss ${r.missing} extra ${r.extra} styled ${r.styled.size} box ${r.box} text ${r.text}  (noise ${r.noise}, anim ${r.anim}, custom ${r.custom})${bad ? '  <-- DIFF' : ''}`);
  }
}

if (structural.length) {
  head(`Missing / extra elements (${structural.length})`);
  out.push(...capped(structural, VERBOSE ? Infinity : 40).map((s) => '  ' + s));
}

if (groups.size) {
  head(`Computed style differences: ${groups.size} distinct changes on ${[...groups.values()].reduce((n, g) => n + g.length, 0)} elements`);
  const sorted = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
  for (const [sig, where] of sorted) {
    out.push(`  [${where.length}x]  ${sig}`);
    out.push(...capped(where).map((s) => '      at ' + s));
  }
}

if (pseudoPresence.length) {
  head(`Pseudo elements appearing / disappearing (${pseudoPresence.length})`);
  out.push(...capped(pseudoPresence, VERBOSE ? Infinity : 30).map((s) => '  ' + s));
}

if (anim.size) {
  head('animation-name differences (expected with keyframe renames; not failures)');
  for (const [k, n] of [...anim.entries()].sort((x, y) => y[1] - x[1])) out.push(`  ${n}x  ${k}`);
}

if (custom.size) {
  head('Custom property (--*) differences, by name (info: tokens draw nothing themselves; --strict-custom counts them)');
  for (const [k, c] of [...custom.entries()].sort((x, y) => x[0].localeCompare(y[0]))) out.push(`  ${k}: ${c.added ? `added on ${c.added}` : ''}${c.removed ? `${c.added ? ', ' : ''}removed on ${c.removed}` : ''}${c.changed ? `${c.added || c.removed ? ', ' : ''}changed on ${c.changed}` : ''}  e.g. ${c.example}`);
}

if (boxes.length) {
  head(`Box (position / size) differences on ${boxes.length} elements${VERBOSE ? '' : ' (first 25; --verbose for all)'}`);
  out.push(...capped(boxes, VERBOSE ? Infinity : 25).map((s) => '  ' + s));
}
if (texts.length) {
  head(`Text differences (${texts.length})`);
  out.push(...capped(texts, VERBOSE ? Infinity : 25).map((s) => '  ' + s));
}
if (inline.length) {
  head(`Inline style attribute differences (${inline.length}; info, the computed styles above are what count)`);
  out.push(...capped(inline, VERBOSE ? Infinity : 15).map((s) => '  ' + s));
}
if (attrs.length) {
  head(`Attribute differences (${attrs.length}; info)`);
  out.push(...capped(attrs, VERBOSE ? Infinity : 10).map((s) => '  ' + s));
}
if (classCheck.length) {
  head(`Class attributes not matching A mapped through the rename map (${classCheck.length}; info)`);
  out.push(...capped(classCheck, VERBOSE ? Infinity : 30).map((s) => '  ' + s));
}

if (noiseDirs.length && noiseProps.size) {
  head(`Noise: what differs between A and the noise run(s), by property (${noise.size} keys)`);
  for (const [k, n] of [...noiseProps.entries()].sort((x, y) => y[1] - x[1])) out.push(`  ${String(n).padStart(6)}  ${k}`);
}

out.push('', failing ? `RESULT: ${failing} scenario(s) differ beyond noise` : 'RESULT: no differences beyond noise and animation-name');
console.log(out.join('\n'));

if (opt['noise-out']) {
  const keys = noiseDirs.length || opt['noise-in'] ? [...noise] : allKeys;
  fs.writeFileSync(opt['noise-out'], JSON.stringify({ from: noiseDirs.length ? [dirA, ...noiseDirs] : [dirA, dirB], keys }, null, 0));
  console.log(`noise keys written: ${keys.length} -> ${opt['noise-out']}`);
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ rows: rows.map((r) => ({ ...r, styled: r.styled ? [...r.styled] : undefined })), groups: Object.fromEntries(groups), anim: Object.fromEntries(anim), custom: Object.fromEntries(custom), structural, boxes, texts, inline, attrs, classCheck }, null, 1));
process.exit(failing ? 1 : 0);
