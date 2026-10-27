/**
 * Moving signage at zero CPU cost: everything animates in the vertex or fragment shader from one shared
 * time uniform, so the per-frame work is the single uniform write `setSignageTime` that the existing
 * `cityMeshes.update(time)` hook already makes. Four pieces:
 *
 *  - Neon flicker and buzz (every tier). A `FlickList` rolls, per sign (podium name signs, hanging blade
 *    signs) or per ring (roof neon), whether it flickers and with which program; the result is a float
 *    vertex attribute `aFlick` (program id + phase) that `applyFlicker` turns into a brightness factor in
 *    the vertex shader. It is a factor of at most 1, so a flickering sign never exceeds today's brightness
 *    and bloom only ever sees it dimmer. Program 4 marks a dead segment (one quad of a ring stuck dark).
 *  - Chasing marquee bulbs under about a third of the downtown name signs: one merged mesh, three phases
 *    chase along each row from the clock.
 *  - LED tickers: a handful of downtown signs carry a scrolling dot-matrix strip, one mesh whose texture
 *    holds one phrase row per ticker; the shader scrolls and masks it into dots.
 *  - Clock signs: a 7-segment time and temperature panel whose digits the shader derives from the clock
 *    (the scene clock as a time of night, starting just before midnight), so nothing is redrawn.
 *
 * Everything is decided at build from `deriveSeed(world.seed, 'signage')` so the menu city and the race,
 * two scenes of one seed, agree. Bulbs, tickers and clocks are Medium and up. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { downtownFactor } from '../../city/roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import { NEON_COLORS } from '../textures/textures';
import { neonMood, pickSubset } from '../textures/cityMood';
import { SIGN_NAMES } from '../textures/signAtlases';
import { canvas, canvasTex } from '../textures/canvasKit';
import { GeoBuilder } from '../geoBuilder';

/** Odds, speeds (s) and counts of the moving signage. */
export const SIGNAGE = {
  /** Share of signs that flicker: podium name signs, hanging blade signs, roof neon rings. */
  flickerPodium: 0.06,
  flickerBlade: 0.06,
  flickerRoof: 0.04,
  /** Share of the podium and blade name signs that name a shop after their neighbourhood (textures/hoodBrands.ts) instead of a name from the pool. */
  hoodShopShare: 0.3,
  /** Of the flickering signs, the share that also drops out (dark for dropMin..dropMax s every dropPeriod s). */
  dropoutShare: 0.55,
  dropPeriod: 3.7,
  dropMin: 0.08,
  dropMax: 0.2,
  /** Of the flickering roof rings, the share with one dead (dark) segment. */
  deadSegmentShare: 0.3,
  /** Brightness of a dead segment. */
  deadLevel: 0.16,
  /** Buzz brightness range (a factor of the sign's colour, never above 1). */
  buzzMin: 0.85,
  /** Downtown factor (city/roadGraph) a sign needs for bulbs, tickers and clocks. */
  downtownMin: 0.35,
  /** Share of eligible downtown name signs with a marquee bulb row, and the cap on rows per city. */
  bulbShare: 0.34,
  maxBulbSigns: 28,
  /** Bulb size and spacing along the row (m), chase steps per second. */
  bulbSize: 0.15,
  bulbPitch: 0.42,
  chaseRate: 3.2,
  /** Lit bulb gain and the glow of an unlit bulb. */
  bulbOn: 2.3,
  bulbOff: 0.07,
  /** Tickers per city (min, max), the narrowest sign that takes one (m), dot pitch (m) and rows, scroll speed in dots per second (min, max). */
  tickers: [2, 4] as [number, number],
  tickerMinW: 6,
  dotPitch: 0.065,
  dotRows: 9,
  tickerSpeed: [7, 12] as [number, number],
  tickerGain: 2.0,
  /** Width of a ticker's phrase row (dots) and extra headlines mixed into the name pool. */
  rowDots: 1024,
  headlines: ['OPEN ALL NIGHT', 'LAST CALL 4AM', 'NIGHT RACE TONIGHT', 'SLEEP IS FOR LATER', 'HONK IF LOST', 'NO PARKING', 'LIVE MUSIC', 'HAPPY HOUR'],
  /** Clock signs per city (min, max), the least spacing between two (m), the panel's largest size (m). */
  clocks: [1, 2] as [number, number],
  clockSpacing: 140,
  clockMaxW: 6,
  clockMaxH: 2,
  /** The clock starts at this minute of the day (23:40) and runs in real time; the temperature is drawn from this range (F). */
  clockStartMinute: 23 * 60 + 40,
  tempRange: [46, 74] as [number, number],
  clockOn: 2.4,
  clockOff: 0.06,
} as const;

/** The shared scene clock uniform (s) every signage shader reads; menu city and race write the same time. */
export const signageTime = { value: 0 };

/** The one per-frame write. */
export function setSignageTime(time: number): void {
  signageTime.value = time;
}

// ---------- flicker ----------

/** Flicker programs in `aFlick`: 0 steady, 1 buzz, 2 buzz plus dropouts, 4 a dead segment. The fraction is the phase. */
export const FLICK = { steady: 0, buzz: 1, dropout: 2, dead: 4 } as const;

/**
 * Per-vertex flicker values, built in step with a GeoBuilder: `roll` decides a sign's program, `fill`
 * writes it for every vertex added since the last fill. Order of calls is deterministic, so the seed rules.
 */
export class FlickList {
  readonly values: number[] = [];
  private rng: Rng;
  constructor(world: World, label: string) {
    this.rng = new Rng(deriveSeed(deriveSeed(world.seed, 'signage'), label));
  }
  /** The program for one sign: 0 or a program id plus a phase fraction. Always consumes the same draws. */
  roll(odds: number): number {
    const hit = this.rng.chance(odds);
    const dropout = this.rng.chance(SIGNAGE.dropoutShare);
    const phase = this.rng.next() * 0.99;
    return hit ? (dropout ? FLICK.dropout : FLICK.buzz) + phase : FLICK.steady;
  }
  /** Whether a flickering ring also gets one dead segment, and which of its `n` quads. */
  deadQuad(n: number): number {
    const dead = this.rng.chance(SIGNAGE.deadSegmentShare);
    const k = this.rng.int(0, Math.max(0, n - 1));
    return dead && n >= 3 ? k : -1;
  }
  /** Give every vertex up to `count` the value `v`. */
  fill(count: number, v: number): void {
    while (this.values.length < count) this.values.push(v);
  }
  /** The attribute for a geometry whose vertices all went through `fill`. */
  attribute(count: number): THREE.Float32BufferAttribute {
    this.fill(count, FLICK.steady);
    return new THREE.Float32BufferAttribute(this.values, 1);
  }
}

const FLICKER_VERT = /* glsl */ `
uniform float uSignTime;
attribute float aFlick;
float sgHash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float signFlick(float a) {
  if (a < 0.5) return 1.0;
  float prog = floor(a);
  float ph = fract(a) * 100.0;
  if (prog > 3.5) return ${SIGNAGE.deadLevel.toFixed(3)};
  float t = uSignTime + ph * 7.3;
  // Slow irregular buzz: three incommensurate sines, mapped into the buzz range (never above 1).
  float n = (sin(t * 2.1) + 0.6 * sin(t * 3.7 + 1.3) + 0.25 * sin(t * 17.0 + ph)) / 1.85;
  float b = ${(1 - (1 - SIGNAGE.buzzMin) / 2).toFixed(4)} + ${((1 - SIGNAGE.buzzMin) / 2).toFixed(4)} * n;
  if (prog > 1.5) {
    // A dropout in most periods, at a hashed moment, with a quick second stutter now and then.
    float P = ${SIGNAGE.dropPeriod.toFixed(3)};
    float cell = floor(t / P);
    float local = t - cell * P;
    float on = step(0.35, sgHash(cell + ph));
    float start = sgHash(cell * 1.7 + ph) * (P - 0.6);
    float dur = ${SIGNAGE.dropMin.toFixed(3)} + ${(SIGNAGE.dropMax - SIGNAGE.dropMin).toFixed(3)} * sgHash(cell * 3.1 + ph);
    float d1 = step(start, local) * step(local, start + dur);
    float s2 = start + dur + 0.12;
    float d2 = step(0.6, sgHash(cell * 5.3 + ph)) * step(s2, local) * step(local, s2 + dur * 0.5);
    b = mix(b, 0.04, on * max(d1, d2));
  }
  return b;
}
`;

/**
 * Add the flicker to a Basic material with vertex colours: `aFlick` scales the vertex colour, so the
 * geometry must carry the attribute. Chains with an existing onBeforeCompile and cache key (fadeSubPixel).
 */
export function applyFlicker(material: THREE.MeshBasicMaterial): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.uSignTime = signageTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FLICKER_VERT}`)
      .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_COLOR\nvColor.rgb *= signFlick(aFlick);\n#endif');
  };
  material.customProgramCacheKey = () => `${prevKey()}|signFlick`;
  material.needsUpdate = true;
}

// ---------- the plan: which name signs carry bulbs, a ticker, a clock ----------

export interface SignagePlan {
  /** Indices into world.blocks.signs. */
  bulbs: Set<number>;
  tickers: Set<number>;
  clocks: Set<number>;
}

/** Decide, per sign index, what extra a downtown name sign carries. Medium and up; an empty plan on Low. */
export function planSignage(world: World, detail: 'low' | 'medium' | 'high'): SignagePlan {
  const plan: SignagePlan = { bulbs: new Set(), tickers: new Set(), clocks: new Set() };
  if (detail === 'low') return plan;
  const rng = new Rng(deriveSeed(deriveSeed(world.seed, 'signage'), 'plan'));
  const signs = world.blocks.signs;
  const down = signs.map((s) => (s.blade ? 0 : downtownFactor(world.graph.plan, s.x, s.z)));
  // Clocks: the highest downtown signs, spaced apart. The sign itself is replaced by the panel, so the
  // panel stays on a wall the sign planner already proved is there.
  const wantClocks = rng.int(SIGNAGE.clocks[0], SIGNAGE.clocks[1]);
  const byHeight = signs.map((_, i) => i).filter((i) => down[i] >= SIGNAGE.downtownMin && signs[i].w >= 4).sort((a, b) => signs[b].y * down[b] - signs[a].y * down[a] || a - b);
  const chosen: number[] = [];
  for (const i of byHeight) {
    if (chosen.length >= wantClocks) break;
    if (chosen.every((j) => Math.hypot(signs[i].x - signs[j].x, signs[i].z - signs[j].z) >= SIGNAGE.clockSpacing)) chosen.push(i);
  }
  for (const i of chosen) plan.clocks.add(i);
  // Tickers: wide downtown signs, in a seeded order.
  const wide = signs.map((_, i) => i).filter((i) => down[i] >= SIGNAGE.downtownMin && signs[i].w >= SIGNAGE.tickerMinW && !plan.clocks.has(i));
  rng.shuffle(wide);
  const wantTickers = rng.int(SIGNAGE.tickers[0], SIGNAGE.tickers[1]);
  for (const i of wide.slice(0, wantTickers)) plan.tickers.add(i);
  // Bulbs: a share of the rest.
  for (let i = 0; i < signs.length; i++) {
    const hit = rng.chance(SIGNAGE.bulbShare);
    if (!hit || plan.bulbs.size >= SIGNAGE.maxBulbSigns) continue;
    if (down[i] >= SIGNAGE.downtownMin && !plan.clocks.has(i) && !plan.tickers.has(i)) plan.bulbs.add(i);
  }
  return plan;
}

// ---------- the meshes ----------

export interface SignageMeshes {
  meshes: THREE.Mesh[];
  /** Counts for the perf report and tests. */
  counts: { bulbRows: number; bulbs: number; tickers: number; clocks: number };
  dispose(): void;
}

// Seven segments a..g as (centre x, centre y, horizontal) on a unit digit 0.6 wide, 1 tall.
const SEGS: readonly (readonly [number, number, boolean])[] = [
  [0, 0.46, true],
  [0.27, 0.23, false],
  [0.27, -0.23, false],
  [0, -0.46, true],
  [-0.27, -0.23, false],
  [-0.27, 0.23, false],
  [0, 0, true],
];

/** Build the bulb, ticker and clock meshes for a plan (up to three draw calls for the whole city). */
export function buildSignageMeshes(world: World, plan: SignagePlan): SignageMeshes {
  const rng = new Rng(deriveSeed(deriveSeed(world.seed, 'signage'), 'meshes'));
  const mood = neonMood(world.seed);
  const neon = NEON_COLORS.map((c) => new THREE.Color(c));
  const signs = world.blocks.signs;
  const meshes: THREE.Mesh[] = [];
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };
  const counts = { bulbRows: 0, bulbs: 0, tickers: 0, clocks: 0 };

  // ---- bulbs ----
  if (plan.bulbs.size) {
    const gb = new GeoBuilder(true);
    const chase: number[] = [];
    const warm = new THREE.Color(0xffd9a0);
    for (const i of [...plan.bulbs].sort((a, b) => a - b)) {
      const s = signs[i];
      const ax = -s.nz;
      const az = s.nx;
      const hw = s.w / 2 - 0.2;
      const n = Math.max(2, Math.floor((2 * hw) / SIGNAGE.bulbPitch) + 1);
      const dir = rng.chance(0.5) ? 1 : -1;
      const off = rng.next() * 3;
      const col = rng.chance(0.5) ? warm : neon[mood.neon(rng.next())];
      const y = s.y - s.h / 2 - 0.1;
      const r = SIGNAGE.bulbSize / 2;
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : -hw + (2 * hw * k) / (n - 1);
        const cx = s.x + ax * t + s.nx * 0.06;
        const cz = s.z + az * t + s.nz * 0.06;
        const v = (u: number, w: number) => {
          chase.push((dir > 0 ? k : n - 1 - k) % 3, off);
          return gb.vertex(cx + ax * r * u, y + r * w, cz + az * r * u, s.nx, 0, s.nz, 0, 0, col);
        };
        gb.quadFacing(v(-1, -1), v(1, -1), v(1, 1), v(-1, 1), s.nx, 0, s.nz);
        counts.bulbs++;
      }
      counts.bulbRows++;
    }
    const g = own(gb.build());
    g.setAttribute('aChase', new THREE.Float32BufferAttribute(chase, 2));
    const mat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSignTime = signageTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uSignTime;\nattribute vec2 aChase;')
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
          #ifdef USE_COLOR
          float chaseStep = mod(floor(uSignTime * ${SIGNAGE.chaseRate.toFixed(2)} + aChase.y), 3.0);
          vColor.rgb *= mix(${SIGNAGE.bulbOff.toFixed(3)}, ${SIGNAGE.bulbOn.toFixed(3)}, step(abs(chaseStep - aChase.x), 0.5));
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'signBulbs';
    const m = new THREE.Mesh(g, mat);
    m.name = 'signBulbs';
    meshes.push(m);
  }

  // ---- tickers ----
  if (plan.tickers.size) {
    const idxs = [...plan.tickers].sort((a, b) => a - b);
    const gb = new GeoBuilder(true);
    const tick: number[] = [];
    const pool = pickSubset([...SIGN_NAMES, ...SIGNAGE.headlines], idxs.length * 3, world.seed, 'tickerPhrases');
    const rows = SIGNAGE.dotRows;
    const [c, g2] = canvas(SIGNAGE.rowDots, rows * idxs.length);
    g2.fillStyle = '#000';
    g2.fillRect(0, 0, c.width, c.height);
    g2.fillStyle = '#fff';
    g2.textBaseline = 'alphabetic';
    idxs.forEach((_, r) => {
      g2.font = `bold ${rows}px "Arial Black", Impact, sans-serif`;
      const text = pool.slice(r * 3, r * 3 + 3).join('   *   ');
      // Keep the loop seamless: if the phrases outgrow the row, drop the last one.
      let line = text;
      while (g2.measureText(line).width > SIGNAGE.rowDots - 40 && line.includes('   *   ')) line = line.slice(0, line.lastIndexOf('   *   '));
      g2.fillText(line, 4, r * rows + rows - 1.5);
    });
    const tex = own(canvasTex(c, { srgb: false, repeat: false, anisotropy: 1 }));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    idxs.forEach((i, r) => {
      const s = signs[i];
      const ax = -s.nz;
      const az = s.nx;
      const hw = s.w / 2;
      const col = neon[mood.neon(rng.next())];
      const speed = rng.range(SIGNAGE.tickerSpeed[0], SIGNAGE.tickerSpeed[1]);
      const start = rng.next() * SIGNAGE.rowDots;
      const yTop = s.y - s.h / 2 - 0.04;
      const yBot = yTop - rows * SIGNAGE.dotPitch;
      const dots = (2 * hw) / SIGNAGE.dotPitch;
      const v = (sa: number, y: number, u: number, vv: number) => {
        tick.push(r, start, speed);
        return gb.vertex(s.x + ax * hw * sa + s.nx * 0.05, y, s.z + az * hw * sa + s.nz * 0.05, s.nx, 0, s.nz, u, vv, col);
      };
      gb.quadFacing(v(1, yBot, 0, 0), v(-1, yBot, dots, 0), v(-1, yTop, dots, 1), v(1, yTop, 0, 1), s.nx, 0, s.nz);
      counts.tickers++;
    });
    const geo = own(gb.build());
    geo.setAttribute('aTick', new THREE.Float32BufferAttribute(tick, 3));
    const mat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSignTime = signageTime;
      shader.uniforms.uTickerTex = { value: tex };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aTick;\nvarying vec2 vTkUv;\nflat varying vec3 vTkA;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTkUv = uv;\nvTkA = aTick;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uSignTime;
          uniform sampler2D uTickerTex;
          varying vec2 vTkUv;
          flat varying vec3 vTkA;`,
        )
        .replace(
          '#include <map_fragment>',
          `{
            float rows = ${SIGNAGE.dotRows.toFixed(1)};
            float dotX = vTkUv.x + vTkA.y + uSignTime * vTkA.z;
            float dotY = clamp(vTkUv.y, 0.0, 0.9999) * rows;
            vec2 cell = vec2(floor(dotX), floor(dotY));
            float W = ${SIGNAGE.rowDots.toFixed(1)};
            float tx = (mod(cell.x, W) + 0.5) / W;
            float rowFromTop = rows - 1.0 - cell.y;
            float ty = 1.0 - (vTkA.x * rows + rowFromTop + 0.5) / (rows * ${Math.max(1, plan.tickers.size).toFixed(1)});
            float lit = step(0.5, texture(uTickerTex, vec2(tx, ty)).r);
            vec2 f = fract(vec2(dotX, dotY)) - 0.5;
            float dotMask = 1.0 - smoothstep(0.32, 0.46, length(f));
            // Far away a dot is under a pixel: average the mask instead of letting it shimmer.
            float far = smoothstep(0.35, 0.9, max(fwidth(dotX), fwidth(dotY)));
            float mask = mix(dotMask, 0.6, far);
            diffuseColor.rgb *= (0.035 + lit * mask * ${SIGNAGE.tickerGain.toFixed(2)});
          }`,
        );
    };
    mat.customProgramCacheKey = () => `signTicker:${plan.tickers.size}`;
    const m = new THREE.Mesh(geo, mat);
    m.name = 'signTickers';
    meshes.push(m);
  }

  // ---- clocks ----
  if (plan.clocks.size) {
    const gb = new GeoBuilder(true);
    const clk: number[] = [];
    const back = new THREE.Color(0x050507);
    for (const i of [...plan.clocks].sort((a, b) => a - b)) {
      const s = signs[i];
      const ax = -s.nz;
      const az = s.nx;
      const W = Math.min(s.w, SIGNAGE.clockMaxW);
      const H = Math.min(s.h, SIGNAGE.clockMaxH);
      const col = rng.chance(0.5) ? new THREE.Color(0xff3a22) : neon[mood.neon(rng.next())];
      const temp = rng.int(SIGNAGE.tempRange[0], SIGNAGE.tempRange[1]);
      const quad = (cx: number, cy: number, hx: number, hy: number, out: number, color: THREE.Color, kind: number, seg: number) => {
        const v = (u: number, w: number) => {
          clk.push(kind, seg, temp);
          return gb.vertex(s.x + ax * (cx + hx * u) + s.nx * out, s.y + cy + hy * w, s.z + az * (cx + hx * u) + s.nz * out, s.nx, 0, s.nz, 0, 0, color);
        };
        gb.quadFacing(v(-1, -1), v(1, -1), v(1, 1), v(-1, 1), s.nx, 0, s.nz);
      };
      quad(0, 0, W / 2, H / 2, 0.05, back, 9, 0);
      // Layout in digit widths: HH : MM, a gap, TT and a degree dot.
      const unit = Math.min((W * 0.94) / 7.6, (H * 0.8) / 1.0 / 0.6);
      const dw = unit * 0.6;
      const dh = dw / 0.6;
      const xs = [-3.4, -2.55, -1.3, -0.45, 1.6, 2.45];
      const th = dw * 0.14;
      const cxOf = (k: number) => xs[k] * unit * 0.95 + (k >= 4 ? unit * 0.2 : 0);
      for (let d = 0; d < 6; d++) {
        for (let sg = 0; sg < 7; sg++) {
          const [sx, sy, horiz] = SEGS[sg];
          const cx = cxOf(d) + sx * dw;
          const cy = sy * dh;
          const hx = horiz ? dw * 0.36 : th / 2;
          const hy = horiz ? th / 2 : dh * 0.2;
          quad(cx, cy, hx, hy, 0.07, col, d, sg);
        }
      }
      const colx = (cxOf(1) + cxOf(2)) / 2;
      quad(colx, dh * 0.2, th * 0.6, th * 0.6, 0.07, col, 6, 0);
      quad(colx, -dh * 0.2, th * 0.6, th * 0.6, 0.07, col, 6, 1);
      quad(cxOf(5) + dw * 0.75, dh * 0.38, th * 0.7, th * 0.7, 0.07, col, 7, 0);
      counts.clocks++;
    }
    const geo = own(gb.build());
    geo.setAttribute('aClock', new THREE.Float32BufferAttribute(clk, 3));
    const mat = own(new THREE.MeshBasicMaterial({ vertexColors: true }));
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSignTime = signageTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uSignTime;
          attribute vec3 aClock;
          const int SEG7[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
          float clockLit(vec3 a) {
            float kind = a.x;
            float seg = a.y;
            if (kind > 8.5) return 0.0;
            float m = mod(${SIGNAGE.clockStartMinute.toFixed(1)} + uSignTime / 60.0, 1440.0);
            float hh = floor(m / 60.0);
            float mn = floor(mod(m, 60.0));
            if (kind > 7.5) return 1.0;
            if (kind > 5.5) return kind < 6.5 ? step(fract(uSignTime), 0.5) : 1.0;
            float val;
            if (kind < 0.5) val = floor(hh / 10.0);
            else if (kind < 1.5) val = mod(hh, 10.0);
            else if (kind < 2.5) val = floor(mn / 10.0);
            else if (kind < 3.5) val = mod(mn, 10.0);
            else if (kind < 4.5) val = floor(a.z / 10.0);
            else val = mod(a.z, 10.0);
            return float((SEG7[int(val)] >> int(seg + 0.5)) & 1);
          }`,
        )
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
          #ifdef USE_COLOR
          vColor.rgb *= aClock.x > 8.5 ? 1.0 : mix(${SIGNAGE.clockOff.toFixed(3)}, ${SIGNAGE.clockOn.toFixed(2)}, clockLit(aClock));
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'signClock';
    const m = new THREE.Mesh(geo, mat);
    m.name = 'signClocks';
    meshes.push(m);
  }

  return {
    meshes,
    counts,
    dispose() {
      for (const d of owned) d.dispose();
    },
  };
}
