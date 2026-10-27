// Hash the three.js scene a page builds: node scene-hash.mjs <baseURL> <out.txt> [scenario ...]
// Per scenario one line per top-level object (name, type, child count) with a hash of its subtree: every
// geometry's attributes and index (bytes; the triangle set where draw order cannot show, such as the layers
// render/cityChunks.ts sorts by cell, whose camera-dependent groups are left out), transforms, render order, visibility, material type and parameters
// (colors, numbers, uniforms) and canvas texture pixels. Math.random is seeded, so builds that roll cosmetic
// randomness hash the same each run.
import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [base, outFile, ...only] = process.argv.slice(2);
const SCENARIOS = {
  menu: { url: '/?seed=harness&quality=high', ready: () => !!window.__nr?.gr },
  race: { url: '/?race=circuit&seed=harness&quality=high', ready: () => !!window.__nr?.session },
  sprint: { url: '/?race=sprint&seed=harness2&quality=high', ready: () => !!window.__nr?.session },
  roam: { url: '/?freeroam&seed=harness3&quality=high', ready: () => !!window.__nr?.session },
  garage: { url: '/?garage&seed=harness&quality=high', ready: () => !!window.__nr?.garageScreen },
};
const names = only.length ? only : Object.keys(SCENARIOS);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const lines = [];
for (const name of names) {
  const sc = SCENARIOS[name];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    let s = 0x2f6b1a3d; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  });
  await page.goto(base + sc.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(sc.ready, null, { timeout: 90_000 });
  await page.waitForTimeout(2500);
  const res = await page.evaluate(() => {
    const nr = window.__nr;
    const gs = nr.garageScreen?.scene; const scene = nr.session?.night?.scene ?? gs?.showroom?.scene ?? nr.stage?.night?.scene;
    if (!scene) return { error: 'no scene: ' + Object.keys(nr).join(',') };
    const fnv = (h, bytes) => { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
    const str = (h, s) => fnv(h, new TextEncoder().encode(s));
    const buf = (h, a) => fnv(h, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    const texCache = new Map();
    const texHash = (t) => {
      if (!t) return 0; if (texCache.has(t)) return texCache.get(t);
      let h = str(2166136261, `${t.wrapS},${t.wrapT},${t.repeat?.x},${t.repeat?.y},${t.colorSpace},${t.anisotropy},${t.flipY}`);
      const img = t.image;
      if (img && img.getContext && img.width) { try { h = buf(h, img.getContext('2d').getImageData(0, 0, img.width, img.height).data); } catch { h = str(h, 'nopix'); } }
      else if (t.isDataTexture && img?.data) h = buf(h, img.data);
      else h = str(h, `${img?.width}x${img?.height}`);
      texCache.set(t, h); return h;
    };
    const val = (h, v) => {
      if (v === null || v === undefined) return str(h, String(v));
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return str(h, String(v));
      if (v.isTexture) return str(h, 'T' + texHash(v));
      if (v.isColor) return str(h, v.getHexString());
      if (v.isVector2 || v.isVector3 || v.isVector4 || v.isMatrix3 || v.isMatrix4) return str(h, (v.elements ?? v.toArray()).join(','));
      if (ArrayBuffer.isView(v)) return buf(h, v);
      if (Array.isArray(v)) { for (const x of v) h = val(h, x); return h; }
      return h;
    };
    const matHash = (m) => {
      let h = str(2166136261, m.type + m.name + m.side + m.transparent + m.opacity + m.depthWrite + m.blending + (m.defines ? JSON.stringify(m.defines) : ''));
      for (const k of ['color', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap', 'vertexColors', 'fog', 'toneMapped', 'polygonOffset', 'polygonOffsetFactor', 'size', 'sizeAttenuation', 'linewidth']) if (k in m) h = val(str(h, k), m[k]);
      if (m.uniforms) for (const k of Object.keys(m.uniforms).sort()) h = val(str(h, k), m.uniforms[k].value);
      if (m.fragmentShader) h = str(h, m.fragmentShader + m.vertexShader);
      return h;
    };
    // Order-independent index hash: each triangle rotated so its smallest index leads (winding kept), FNV-1a
    // over the three, summed. Opaque and additive layers draw the same whatever their triangle order.
    const triSet = (a) => {
      let sum = 0;
      for (let i = 0; i + 2 < a.length; i += 3) {
        let x = a[i], y = a[i + 1], z = a[i + 2];
        if (y < x && y <= z) { const t = x; x = y; y = z; z = t; } else if (z < x && z < y) { const t = z; z = y; y = x; x = t; }
        let t = 2166136261; t = Math.imul(t ^ x, 16777619) >>> 0; t = Math.imul(t ^ y, 16777619) >>> 0; t = Math.imul(t ^ z, 16777619) >>> 0;
        sum = (sum + t) >>> 0;
      }
      return sum;
    };
    const orderFree = (mat) => [].concat(mat).every((m) => !m.transparent || m.blending === 2 /* AdditiveBlending */);
    // One entry per object: geometry (G), local transform (M), materials without uniforms and their textures (T),
    // uniform values (U), instances (I), light (L). Paths use names and child indices.
    const out = [];
    const matStatic = (m) => { let h = str(2166136261, m.type + m.name + m.side + m.transparent + m.opacity + m.depthWrite + m.depthTest + m.blending + m.colorWrite + (m.defines ? JSON.stringify(m.defines) : ''));
      for (const k of ['color', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap', 'vertexColors', 'fog', 'toneMapped', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'size', 'sizeAttenuation', 'alphaTest', 'stencilWrite', 'stencilRef', 'stencilFunc']) if (k in m) h = val(str(h, k), m[k]);
      if (m.fragmentShader) h = str(h, m.fragmentShader + m.vertexShader); return h; };
    const matUniforms = (m) => { let h = 2166136261; if (m.uniforms) for (const k of Object.keys(m.uniforms).sort()) h = val(str(h, k), m.uniforms[k].value); return h; };
    const walk = (o, path) => {
      const e = { p: path };
      if (o.geometry) {
        const g = o.geometry; let h = 2166136261; for (const k of Object.keys(g.attributes).sort()) h = buf(str(h, k), g.attributes[k].array);
        // A chunked layer's index is sorted by cell and its groups follow the camera, so hash the triangle set
        // and leave the groups out; the same set hashing for any layer whose draw order cannot show.
        const unordered = o.userData?.chunked || (!g.groups.length && orderFree(o.material));
        if (g.index) h = unordered ? str(str(h, 'index'), String(triSet(g.index.array))) : buf(str(h, 'index'), g.index.array);
        e.G = str(h, (o.userData?.chunked ? '[]' : JSON.stringify(g.groups)) + g.drawRange.start + ',' + g.drawRange.count).toString(16);
      }
      e.M = val(str(2166136261, `${o.type}|${o.visible}|${o.renderOrder}|${o.frustumCulled}|${o.layers.mask}`), o.matrix).toString(16);
      if (o.material) { let t = 2166136261, u = 2166136261; for (const m of [].concat(o.material)) { t = str(t, String(matStatic(m))); u = str(u, String(matUniforms(m))); } e.T = t.toString(16); e.U = u.toString(16); }
      if (o.isInstancedMesh) { let h = buf(2166136261, o.instanceMatrix.array); if (o.instanceColor) h = buf(h, o.instanceColor.array); e.I = str(h, String(o.count)).toString(16); }
      if (o.isLight) e.L = str(2166136261, `${o.color.getHexString()}|${o.intensity}|${o.distance}|${o.decay}|${o.angle}|${o.penumbra}`).toString(16);
      out.push(JSON.stringify(e));
      const seen = new Map(); o.children.forEach((c) => { const n = c.name || c.type; const k = seen.get(n) ?? 0; seen.set(n, k + 1); walk(c, `${path}/${n}#${k}`); });
    };
    scene.updateMatrixWorld(true);
    { const seen = new Map(); scene.children.forEach((c) => { const n = c.name || c.type; const k = seen.get(n) ?? 0; seen.set(n, k + 1); walk(c, `${n}#${k}`); }); }
    out.push(JSON.stringify({ p: 'scene', F: `${scene.fog ? scene.fog.color.getHexString() + ' ' + (scene.fog.density ?? scene.fog.near) : 'none'}`, B: `${scene.background?.isColor ? scene.background.getHexString() : scene.background ? 'T' + texHash(scene.background) : 'none'}` }));
    return { out };
  });
  if (res.error) lines.push(JSON.stringify({ s: name, error: res.error })); else for (const l of res.out) lines.push(JSON.stringify({ s: name, ...JSON.parse(l) }));
  await page.close();
}
await browser.close();
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`${lines.length} lines`);
