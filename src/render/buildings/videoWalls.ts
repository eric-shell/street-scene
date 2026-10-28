/**
 * Video walls: two to four big LED screens on the tallest downtown faces near the route, the kind that wrap a
 * Times Square corner. Each wall plays a loop of three to five ads (the roof billboards' brands and palettes,
 * painted at build into one strip texture) that crossfade every 6 to 10 s, under a scrolling headline strip.
 *
 * Two draw calls for the whole city. `videoWalls` is one merged mesh and one material: the quad's uv counts LED
 * dots, the shader rounds them into a dot matrix (a subtle scanline band and a refresh flicker, bright enough
 * for the bloom), picks the frame from the clock (`uVwTime`) and crossfades into the next, and past the screen
 * the same quad is the dark bezel. Far away, where a dot is under a pixel, the dot mask fades to its average so
 * a distant wall never shimmers (the signage tickers' trick). `videoWallLight` is the glow on the street below:
 * a merged grid draped over the ground in front of each wall, additive, whose colour is the average of the ad on
 * screen, computed in the vertex shader from the same clock, so it pulses with the ads and never changes geometry.
 *
 * Low tier draws a static wall (the first ad, no dots, no ticker) and a steady glow: `VW_STATIC` removes the
 * clock, and `update` writes nothing. Sites are chosen by score from the world (downtown factor, route
 * nearness, a node close by for a corner, height) with a seeded jitter, so the menu city and the race, and every
 * graphics tier, agree. Render only: nothing here touches the sim or the city.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Building } from '../../city/blocks';
import { downtownFactor } from '../../city/roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { heightFogShader } from '../heightFog';
import { routeNearness } from '../street/routeNearness';
import { SIGNAGE } from '../street/signage';
import { billboardPool } from '../textures/billboardAtlas';
import type { Palette } from '../textures/billboardAtlas';
import { canvas, canvasTex, fitFont } from '../textures/canvasKit';
import type { BuildingPlan, StyleId } from './architecture';

export const VIDEO_WALL = {
  /** Walls per city (min, max) and the least distance between two (m). */
  walls: [2, 4] as [number, number],
  spacing: 110,
  /** Styles with a plain flush shaft to hang a screen on (no rounded corners, gables or stoops). */
  styles: new Set<StyleId>(['glass', 'prewar', 'deco', 'midcentury', 'empire', 'condo']),
  /** Smallest building height (m), face width (m) and downtown factor that take a wall. */
  minH: 36,
  minW: 14,
  downtownMin: 0.3,
  /** Screen width cap (m); the height is half of it. Bottom edge above the podium (m), standoff from the wall (m), bezel (m). */
  maxW: 18,
  bottom: 12,
  standoff: 0.4,
  bezel: 0.45,
  /** A road node within this of the face centre makes it a corner (m), and its score bonus. */
  cornerR: 45,
  cornerBonus: 0.6,
  /** LED grid: dots across, ad rows and headline rows (together half the dots across: the screen is 2:1). */
  cols: 160,
  adRows: 68,
  tickRows: 12,
  /** Ads per wall (min, max), seconds per ad (min, max), crossfade at the end of each (fraction of the period). */
  ads: [3, 5] as [number, number],
  period: [6, 10] as [number, number],
  fadeFrom: 0.84,
  /** Headline strip: width in dots, scroll speed in dots per second (min, max). */
  tickDots: 512,
  tickSpeed: [14, 22] as [number, number],
  /** Screen brightness over the painted colour (the bloom takes it from there), the street glow's gain, its reach (m) and extra half width beyond the screen (m), height over the ground (m). */
  gain: 2.4,
  glow: 0.9,
  reach: 26,
  side: 7,
  lift: 0.22,
} as const;

const MAX_WALLS = VIDEO_WALL.walls[1];
const MAX_ADS = VIDEO_WALL.ads[1];
const ROWS = VIDEO_WALL.adRows + VIDEO_WALL.tickRows;
/** Texture rows one wall owns: its ad frames (padded to the most ads), then its headline strip. */
const BLOCK = MAX_ADS * VIDEO_WALL.adRows + VIDEO_WALL.tickRows;
const TEX_W = Math.max(VIDEO_WALL.cols, VIDEO_WALL.tickDots);

export interface VideoWalls {
  meshes: THREE.Object3D[];
  /** Walls placed, for the perf report and tests. */
  count: number;
  /** Advance the clock (s); a no-op on Low. */
  update(time: number): void;
  dispose(): void;
}

interface Site {
  /** Screen centre (x, z), outward normal, its width (m) and the bottom edge height (m). */
  x: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
  y0: number;
}

/** The sites, best first and spaced apart: the tallest downtown faces on the route's street, corners first. */
export function planVideoWalls(world: World, B: readonly Building[], plans: readonly BuildingPlan[]): Site[] {
  const V = VIDEO_WALL;
  const rng = new Rng(deriveSeed(world.seed, 'videoWalls'));
  const near = routeNearness(world);
  const g = world.graph;
  const scored: { score: number; site: Site }[] = [];
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    const plan = plans[i];
    if (!V.styles.has(plan.style) || plan.h < V.minH || b.w < V.minW) continue;
    const down = downtownFactor(g.plan, b.x, b.z);
    if (down < V.downtownMin) continue;
    const jitter = rng.next() * 0.3;
    // Face 0 is the street side: the local -w direction, w = (sin yaw, cos yaw).
    const wx = Math.sin(b.yaw);
    const wz = Math.cos(b.yaw);
    const fx = b.x - wx * (b.d / 2);
    const fz = b.z - wz * (b.d / 2);
    let corner = 0;
    for (const n of g.nodes) {
      if (Math.abs(n.x - fx) < V.cornerR && Math.abs(n.z - fz) < V.cornerR && Math.hypot(n.x - fx, n.z - fz) < V.cornerR && n.edges.length >= 3) {
        corner = V.cornerBonus;
        break;
      }
    }
    const w = Math.min(V.maxW, b.w - 2);
    const y0 = b.baseY + V.bottom;
    // A sign on this face at the screen's height would collide with it.
    const top = y0 + w / 2;
    let blocked = false;
    for (const s of world.blocks.signs) {
      if (Math.abs(s.x - fx) < b.w / 2 + 2 && Math.abs(s.z - fz) < b.w / 2 + 2 && s.y + s.h / 2 > y0 - 1 && s.y - s.h / 2 < top + 1 && Math.hypot(s.x - fx, s.z - fz) < w) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    scored.push({ score: down + near.at(b.x, b.z) + plan.h / 120 + corner + jitter, site: { x: fx - wx * V.standoff, z: fz - wz * V.standoff, nx: -wx, nz: -wz, w, y0 } });
  }
  scored.sort((a, b) => b.score - a.score);
  const want = rng.int(V.walls[0], V.walls[1]);
  const out: Site[] = [];
  for (const c of scored) {
    if (out.length >= want) break;
    if (out.every((o) => Math.hypot(o.x - c.site.x, o.z - c.site.z) >= V.spacing)) out.push(c.site);
  }
  return out;
}

const HEAD = (px: number) => `900 ${px}px Impact, "Arial Black", sans-serif`;
const TAG = (px: number) => `700 ${px}px "Arial Black", sans-serif`;

/** One 160 x 68 LED frame: a gradient ground in the palette, the brand large, the tag line small, an accent shape. */
function paintAd(g: CanvasRenderingContext2D, y0: number, brand: { text: string; sub: string }, p: Palette, layout: number): void {
  const W = VIDEO_WALL.cols;
  const H = VIDEO_WALL.adRows;
  g.save();
  g.beginPath();
  g.rect(0, y0, W, H);
  g.clip();
  const grd = g.createLinearGradient(0, y0, W, y0 + H);
  grd.addColorStop(0, p.bg[0]);
  grd.addColorStop(1, p.bg[1]);
  g.fillStyle = grd;
  g.fillRect(0, y0, W, H);
  g.fillStyle = p.accent;
  g.textBaseline = 'alphabetic';
  if (layout === 0) {
    g.globalAlpha = 0.85;
    g.beginPath();
    g.arc(W - 26, y0 + H / 2, 20, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = p.fg;
    g.textAlign = 'left';
    fitFont(g, brand.text, W - 62, 26, HEAD, 9, 1);
    g.fillText(brand.text, 8, y0 + 34);
    fitFont(g, brand.sub, W - 62, 10, TAG, 6, 1);
    g.fillText(brand.sub, 9, y0 + 52);
  } else if (layout === 1) {
    g.beginPath();
    g.moveTo(0, y0);
    g.lineTo(46, y0);
    g.lineTo(30, y0 + H);
    g.lineTo(0, y0 + H);
    g.fill();
    g.fillStyle = p.bg[0];
    g.textAlign = 'center';
    g.font = HEAD(40);
    g.fillText(brand.text[0], 17, y0 + 46);
    g.fillStyle = p.fg;
    g.textAlign = 'left';
    fitFont(g, brand.text, W - 62, 24, HEAD, 9, 1);
    g.fillText(brand.text, 52, y0 + 34);
    fitFont(g, brand.sub, W - 62, 10, TAG, 6, 1);
    g.fillText(brand.sub, 53, y0 + 52);
  } else {
    g.globalAlpha = 0.9;
    g.fillRect(0, y0 + H - 12, W, 4);
    g.fillRect(0, y0 + 8, W, 4);
    g.globalAlpha = 1;
    g.fillStyle = p.fg;
    g.textAlign = 'center';
    fitFont(g, brand.text, W - 16, 30, HEAD, 9, 1);
    g.fillText(brand.text, W / 2, y0 + 40);
    g.fillStyle = p.accent;
    fitFont(g, brand.sub, W - 16, 10, TAG, 6, 1);
    g.fillText(brand.sub, W / 2, y0 + 57);
  }
  g.restore();
}

/** Linear colour a frame averages to: the ground dominates, the accent and text add a little. Drives the street glow. */
function adAverage(p: Palette): THREE.Color {
  const c = new THREE.Color(p.bg[0]).multiplyScalar(0.3);
  c.add(new THREE.Color(p.bg[1]).multiplyScalar(0.32));
  c.add(new THREE.Color(p.fg).multiplyScalar(0.22));
  c.add(new THREE.Color(p.accent).multiplyScalar(0.16));
  return c;
}

export function buildVideoWalls(world: World, B: readonly Building[], plans: readonly BuildingPlan[], opts: { animated: boolean }): VideoWalls {
  const V = VIDEO_WALL;
  const sites = planVideoWalls(world, B, plans);
  if (!sites.length) return { meshes: [], count: 0, update() {}, dispose() {} };
  const rng = new Rng(deriveSeed(world.seed, 'videoWallAds'));
  const { brands, palettes } = billboardPool(world.seed);
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  // ---- the strip texture: per wall, MAX_ADS frames then the headline strip ----
  const [cv, g] = canvas(TEX_W, BLOCK * sites.length);
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  const tags = brands.map((b) => b.sub);
  const pickTag = (): string => (rng.chance(0.4) ? SIGNAGE.headlines[rng.int(0, SIGNAGE.headlines.length - 1)] : tags[rng.int(0, tags.length - 1)]);
  const ads: { n: number; phase: number; period: number; speed: number; start: number; tick: THREE.Color; colors: THREE.Color[] }[] = [];
  sites.forEach((_, w) => {
    const n = rng.int(V.ads[0], V.ads[1]);
    const colors: THREE.Color[] = [];
    let accent = palettes[0].accent;
    for (let a = 0; a < n; a++) {
      const k = w * MAX_ADS + a;
      const p = palettes[(k * 3 + 1) % palettes.length];
      if (a === 0) accent = p.accent;
      paintAd(g, w * BLOCK + a * V.adRows, brands[k % brands.length], p, rng.int(0, 2));
      colors.push(adAverage(p));
    }
    const stripY = w * BLOCK + MAX_ADS * V.adRows;
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = `bold ${V.tickRows - 2}px "Arial Black", Impact, sans-serif`;
    let line = [pickTag(), pickTag(), pickTag()].join('   *   ');
    while (g.measureText(line).width > V.tickDots - 40 && line.includes('   *   ')) line = line.slice(0, line.lastIndexOf('   *   '));
    g.fillText(line, 4, stripY + V.tickRows - 2.5);
    ads.push({ n, phase: rng.next() * 60, period: rng.range(V.period[0], V.period[1]), speed: rng.range(V.tickSpeed[0], V.tickSpeed[1]), start: rng.next() * V.tickDots, tick: new THREE.Color(accent).lerp(new THREE.Color(0xffe9a8), 0.55), colors });
  });
  const tex = own(canvasTex(cv, { srgb: true, repeat: false, anisotropy: 1 }));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  // ---- geometry: one screen quad (with its bezel) and one draped glow grid per wall ----
  const screen = new GeoBuilder();
  const glow = new GeoBuilder();
  const sAttr: number[] = [];
  const tAttr: number[] = [];
  const gAttr: number[] = [];
  sites.forEach((s, w) => {
    const ad = ads[w];
    const rx = s.nz;
    const rz = -s.nx;
    const pitch = s.w / V.cols;
    const hw = s.w / 2 + V.bezel;
    const hh = (ROWS * pitch) / 2 + V.bezel;
    const cy = s.y0 + (ROWS * pitch) / 2;
    const bz = V.bezel / pitch;
    const vtx = (sx: number, sy: number) => {
      sAttr.push(w, ad.n, ad.phase, ad.period);
      tAttr.push(ad.speed, ad.start);
      return screen.vertex(s.x + rx * hw * sx, cy + hh * sy, s.z + rz * hw * sx, s.nx, 0, s.nz, sx < 0 ? -bz : V.cols + bz, sy < 0 ? -bz : ROWS + bz);
    };
    screen.quadFacing(vtx(-1, -1), vtx(1, -1), vtx(1, 1), vtx(-1, 1), s.nx, 0, s.nz);
    // The glow grid on the street, from the wall out: s runs 0..1 away from it, t -1..1 across.
    const NS = 6;
    const NT = 8;
    const half = s.w / 2 + V.side;
    const idx: number[][] = [];
    for (let i = 0; i <= NS; i++) {
      idx.push([]);
      for (let j = 0; j <= NT; j++) {
        const su = i / NS;
        const tu = (j / NT) * 2 - 1;
        const x = s.x + s.nx * su * V.reach + rx * tu * half;
        const z = s.z + s.nz * su * V.reach + rz * tu * half;
        gAttr.push(w, ad.n, ad.phase, ad.period);
        idx[i].push(glow.vertex(x, world.heightAt(x, z) + V.lift, z, 0, 1, 0, su, tu));
      }
    }
    for (let i = 0; i < NS; i++) for (let j = 0; j < NT; j++) glow.quadFacing(idx[i][j], idx[i][j + 1], idx[i + 1][j + 1], idx[i + 1][j], 0, 1, 0);
  });

  const time = { value: 0 };
  const adCols: THREE.Color[] = [];
  for (let w = 0; w < MAX_WALLS; w++) for (let a = 0; a < MAX_ADS; a++) adCols.push((ads[w]?.colors[a] ?? new THREE.Color(0)).clone().multiplyScalar(V.glow));
  const ticks: THREE.Color[] = [];
  for (let w = 0; w < MAX_WALLS; w++) ticks.push(ads[w]?.tick ?? new THREE.Color(1, 1, 1));
  const staticDef: Record<string, string> = opts.animated ? {} : { VW_STATIC: '' };
  const SHARED = `
    uniform float uVwTime;
    const float VW_FADE = ${V.fadeFrom.toFixed(3)};
  `;

  // ---- the screen ----
  const sg = own(screen.build());
  sg.setAttribute('aVw', new THREE.Float32BufferAttribute(sAttr, 4));
  sg.setAttribute('aVt', new THREE.Float32BufferAttribute(tAttr, 2));
  const smat = own(new THREE.MeshBasicMaterial());
  smat.onBeforeCompile = (shader) => {
    shader.defines = { ...shader.defines, ...staticDef };
    shader.uniforms.uVwTime = time;
    shader.uniforms.uVwTex = { value: tex };
    shader.uniforms.uVwTick = { value: ticks };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aVw;\nattribute vec2 aVt;\nvarying vec2 vVwUv;\nflat varying vec4 vVw;\nflat varying vec2 vVt;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVwUv = uv;\nvVw = aVw;\nvVt = aVt;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${SHARED}
        uniform sampler2D uVwTex;
        uniform vec3 uVwTick[${MAX_WALLS}];
        varying vec2 vVwUv;
        flat varying vec4 vVw;
        flat varying vec2 vVt;
        const float VW_COLS = ${V.cols.toFixed(1)};
        const float VW_ROWS = ${ROWS.toFixed(1)};
        const float VW_AD = ${V.adRows.toFixed(1)};
        const float VW_BLOCK = ${BLOCK.toFixed(1)};
        const vec2 VW_TEX = vec2(${TEX_W.toFixed(1)}, ${(BLOCK * sites.length).toFixed(1)});
        vec3 vwFrame(float wall, float frame, vec2 cell, float ry) {
          vec2 px = vec2(cell.x + 0.5, wall * VW_BLOCK + frame * VW_AD + ry + 0.5);
          return texture(uVwTex, vec2(px.x, VW_TEX.y - px.y) / VW_TEX).rgb;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec2 d = vVwUv;
          vec2 cell = floor(d);
          vec3 col = vec3(0.012, 0.013, 0.017);
          if (d.x >= 0.0 && d.y >= 0.0 && d.x < VW_COLS && d.y < VW_ROWS) {
            float ry = VW_ROWS - 1.0 - cell.y;
            float t = 0.0;
            #ifndef VW_STATIC
              t = (uVwTime + vVw.z) / vVw.w;
            #endif
            vec3 px;
            if (ry < VW_AD) {
              float a0 = mod(floor(t), vVw.y);
              px = vwFrame(vVw.x, a0, cell, ry);
              float mixK = smoothstep(VW_FADE, 1.0, fract(t));
              if (mixK > 0.001) px = mix(px, vwFrame(vVw.x, mod(a0 + 1.0, vVw.y), cell, ry), mixK);
            } else {
              float dotX = cell.x + vVt.y;
              #ifndef VW_STATIC
                dotX += uVwTime * vVt.x;
              #endif
              float lit = step(0.5, texture(uVwTex, vec2((mod(dotX, ${V.tickDots.toFixed(1)}) + 0.5) / VW_TEX.x, (VW_TEX.y - (vVw.x * VW_BLOCK + ${(MAX_ADS * V.adRows).toFixed(1)} + (ry - VW_AD) + 0.5)) / VW_TEX.y)).r);
              px = vec3(0.03) + lit * uVwTick[int(vVw.x + 0.5)];
            }
            #ifdef VW_STATIC
              float mask = 1.0;
              float band = 1.0;
              float flick = 1.0;
            #else
              vec2 f = fract(d) - 0.5;
              float dotMask = 1.0 - smoothstep(0.3, 0.5, length(f));
              // A dot under a pixel shows its average instead of shimmering.
              float far = smoothstep(0.35, 0.9, max(fwidth(d.x), fwidth(d.y)));
              float mask = mix(dotMask, 0.56, far);
              float band = 1.0 - (1.0 - far) * 0.08 * smoothstep(0.75, 1.0, sin(d.y * 0.11 - uVwTime * 2.6));
              float flick = 0.965 + 0.035 * sin(uVwTime * 95.0 + vVw.x * 7.0);
            #endif
            col = px * mask * band * flick * ${V.gain.toFixed(2)};
          }
          diffuseColor.rgb = col;
        }`,
      );
  };
  smat.customProgramCacheKey = () => `videoWall:${opts.animated ? 1 : 0}:${sites.length}`;
  const screenMesh = new THREE.Mesh(sg, smat);
  screenMesh.name = 'videoWalls';

  // ---- the glow on the street ----
  const lg = own(glow.build());
  lg.setAttribute('aVw', new THREE.Float32BufferAttribute(gAttr, 4));
  const lmat = own(
    new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  lmat.onBeforeCompile = (shader) => {
    shader.defines = { ...shader.defines, ...staticDef };
    shader.uniforms.uVwTime = time;
    shader.uniforms.uAdCol = { value: adCols };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SHARED}\nuniform vec3 uAdCol[${MAX_WALLS * MAX_ADS}];\nattribute vec4 aVw;\nvarying vec3 vWash;\nvarying vec2 vWashUv;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float t = 0.0;
          #ifndef VW_STATIC
            t = (uVwTime + aVw.z) / aVw.w;
          #endif
          float a0 = mod(floor(t), aVw.y);
          float a1 = mod(a0 + 1.0, aVw.y);
          int base = int(aVw.x + 0.5) * ${MAX_ADS};
          vWash = mix(uAdCol[base + int(a0 + 0.5)], uAdCol[base + int(a1 + 0.5)], smoothstep(VW_FADE, 1.0, fract(t)));
          #ifndef VW_STATIC
            vWash *= 0.97 + 0.03 * sin(uVwTime * 95.0 + aVw.x * 7.0);
          #endif
          vWashUv = uv;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWash;\nvarying vec2 vWashUv;')
      .replace(
        '#include <map_fragment>',
        `{
          float fall = pow(1.0 - vWashUv.x, 2.2) * (1.0 - smoothstep(0.3, 1.0, abs(vWashUv.y)));
          diffuseColor.rgb = vWash * fall;
        }`,
      );
    heightFogShader(shader, true);
  };
  lmat.customProgramCacheKey = () => `videoWallLight:${opts.animated ? 1 : 0}`;
  const lightMesh = new THREE.Mesh(lg, lmat);
  lightMesh.name = 'videoWallLight';
  lightMesh.renderOrder = 1;

  return {
    meshes: [screenMesh, lightMesh],
    count: sites.length,
    update(t) {
      if (opts.animated) time.value = t;
    },
    dispose() {
      for (const d of owned) d.dispose();
    },
  };
}
