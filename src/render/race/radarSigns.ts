/**
 * "YOUR SPEED" radar signs: a handful of amber 7-segment readouts bolted to the route's streetlight poles
 * on its long straights, facing the traffic that comes down the road. Each shows the speed (mph) of the
 * nearest car approaching it within `DIEGETIC.radar.range` metres (any race car, so a rival lights it as
 * well as the player), blank when none, and above the limit alternates red digits with a SLOW DOWN legend.
 *
 * All signs are one merged mesh and one draw call. The digits are the clock sign's approach (signage.ts): a
 * per-vertex attribute names the sign, the digit and the segment, and the vertex shader lights it from a
 * small uniform array of readings and the shared sign clock, so the per-frame work is the session feeding
 * each car once (`begin`, `feed`, `end`: a few multiplies per sign, no allocation) and one uniform array.
 * The pole is a destructible prop, so a sign vanishes with its pole (`end` reads the broken flags); the
 * panel hangs 2.6 m or more over the pavement, clear of every car, so it needs no wall of its own.
 * Placement is seeded (`deriveSeed(world.seed, 'diegetic')`), so the menu city and the race agree. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { routeSample } from '../../city/route';
import { gateLines } from '../../city/people/gates';
import { CITY } from '../../city/config';
import { Rng, deriveSeed } from '../../sim/prng';
import { MS_PER_MPH } from '../../ui/kit/units';
import { canvas, canvasTex } from '../textures/canvasKit';
import { GeoBuilder } from '../geoBuilder';
import { SEGS, signageTime } from '../street/signage';
import { DIEGETIC } from './diegetic';

const D = DIEGETIC.radar;

/** One placed sign. */
export interface RadarSign {
  /** Index into world.blocks.streetlights (and props): the pole it hangs on. */
  pole: number;
  /** Panel centre on the ground plane (m) and the height of its centre. */
  x: number;
  y: number;
  z: number;
  /** Unit travel direction of the road at the sign (the panel faces against it). */
  fx: number;
  fz: number;
  /** Half the road's width plus the lane reach: cars further to the side are not read (m). */
  reach: number;
  /** Route distance of the sign (m). */
  s: number;
}

/** Route poles on long straights, picked by the seed: the first `count` spaced along the route. */
export function planRadarSigns(world: World): RadarSign[] {
  const route = world.route;
  const lights = world.blocks.streetlights;
  const onRoute = new Set(route.edges);
  const CELL = 16;
  const cells = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 73856093 ^ cz * 19349663;
  lights.forEach((l, i) => {
    if (!onRoute.has(l.edge)) return;
    const k = key(Math.floor(l.x / CELL), Math.floor(l.z / CELL));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  });
  const gates = gateLines(world).map((g) => g.s);
  const dist = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return route.closed ? Math.min(d, route.length - d) : d;
  };
  const back = [-D.minStraight, (-D.minStraight * 2) / 3, -D.minStraight / 3, -D.minStraight / 6, 12];
  const found: RadarSign[] = [];
  const used = new Set<number>();
  for (let s = 0; s <= route.length; s += 4) {
    if (!route.closed && s < D.minStraight) continue;
    if (gates.some((g) => dist(g, s) < D.gateClear)) continue;
    const p = routeSample(route, s);
    let straight = true;
    for (const o of back) {
      const q = routeSample(route, s + o);
      if (q.tx * p.tx + q.tz * p.tz < D.straightCos) {
        straight = false;
        break;
      }
    }
    if (!straight) continue;
    const half = route.segWidth[p.seg] / 2;
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.z / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        for (const i of cells.get(key(cx + ox, cz + oz)) ?? []) {
          if (used.has(i)) continue;
          const l = lights[i];
          const dx = l.x - p.x;
          const dz = l.z - p.z;
          const along = dx * p.tx + dz * p.tz;
          // Right of travel is (-tz, tx) in three.js's x/z plane; lat is signed toward it.
          const lat = dx * -p.tz + dz * p.tx;
          if (Math.abs(along) > D.poleAlong || Math.abs(lat) < half + D.poleBand[0] || Math.abs(lat) > half + D.poleBand[1]) continue;
          used.add(i);
          // The panel hangs from the pole toward the road.
          const toward = lat > 0 ? -1 : 1;
          const y = world.heightAt(l.x, l.z) + CITY.curbHeight + D.mountHeight;
          found.push({ pole: i, x: l.x + -p.tz * toward * D.setback, y, z: l.z + p.tx * toward * D.setback, fx: p.tx, fz: p.tz, reach: half + D.laneReach, s });
        }
      }
    }
  }
  const rng = new Rng(deriveSeed(deriveSeed(world.seed, 'diegetic'), 'radar'));
  const want = rng.int(D.count[0], D.count[1]);
  rng.shuffle(found);
  const chosen: RadarSign[] = [];
  for (const c of found) {
    if (chosen.length >= want) break;
    if (chosen.every((o) => dist(o.s, c.s) >= D.spacing)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.s - b.s);
}

export interface RadarSigns {
  /** The one merged mesh; null when the route has no straight with a pole on it. */
  mesh: THREE.Mesh | null;
  signs: readonly RadarSign[];
  /** Start a frame's readings: every sign goes blank. */
  begin(): void;
  /** Offer a car (position m, velocity m/s); the nearest approaching one per sign wins. */
  feed(x: number, z: number, vx: number, vz: number): void;
  /** Write the readings; `broken` is the props' broken flags (a sign dies with its pole). */
  end(broken?: ArrayLike<number>): void;
  dispose(): void;
}

/** Atlas texels: a white block the lit parts sample, and the two legends. */
const ATLAS = { w: 256, h: 64, white: [250, 60] as const };

/** Build the radar signs for a world. */
export function buildRadarSigns(world: World): RadarSigns {
  const signs = planRadarSigns(world).slice(0, D.maxSigns);
  const owned: { dispose(): void }[] = [];
  if (!signs.length) return { mesh: null, signs, begin() {}, feed() {}, end() {}, dispose() {} };
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };

  // The legends: YOUR SPEED on the top half, SLOW DOWN on the bottom, white on black, and a white block for the rest.
  const [c, g] = canvas(ATLAS.w, ATLAS.h);
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS.w, ATLAS.h);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 24px "Arial Black", Impact, sans-serif`;
  g.fillText('YOUR SPEED', ATLAS.w / 2, ATLAS.h * 0.25, ATLAS.w - 12);
  g.fillText('SLOW DOWN', ATLAS.w / 2, ATLAS.h * 0.75, ATLAS.w - 12);
  g.fillRect(ATLAS.white[0] - 4, ATLAS.white[1] - 4, 8, 8);
  const tex = own(canvasTex(c, { srgb: false, repeat: false, anisotropy: 4 }));
  const wu = ATLAS.white[0] / ATLAS.w;
  const wv = 1 - ATLAS.white[1] / ATLAS.h;

  const gb = new GeoBuilder(true);
  const attr: number[] = [];
  const dark = new THREE.Color(0x07070a);
  const amber = new THREE.Color(1.0, 0.62, 0.1);
  const red = new THREE.Color(1.0, 0.1, 0.06);
  const W = D.width;
  const H = D.height;
  signs.forEach((sg, si) => {
    // Panel frame: +u is the approaching driver's right, (-fz... ) (nz, -nx) with the normal n = -forward.
    const nx = -sg.fx;
    const nz = -sg.fz;
    const ax = nz;
    const az = -nx;
    const quad = (cx: number, cy: number, hx: number, hy: number, out: number, color: THREE.Color, kind: number, seg: number, uv?: [number, number, number, number]) => {
      const v = (u: number, w: number) => {
        attr.push(si, kind, seg);
        const tu = uv ? (u < 0 ? uv[0] : uv[2]) : wu;
        const tv = uv ? (w < 0 ? uv[1] : uv[3]) : wv;
        return gb.vertex(sg.x + ax * (cx + hx * u) + nx * out, sg.y + cy + hy * w, sg.z + az * (cx + hx * u) + nz * out, nx, 0, nz, tu, tv, color);
      };
      gb.quadFacing(v(-1, -1), v(1, -1), v(1, 1), v(-1, 1), nx, 0, nz);
    };
    // Back and front housing; the back faces the driver leaving it behind.
    {
      const v = (u: number, w: number, out: number) => {
        attr.push(si, 9, 0);
        return gb.vertex(sg.x + ax * (W / 2) * u - nx * out, sg.y + (H / 2) * w, sg.z + az * (W / 2) * u - nz * out, -nx, 0, -nz, wu, wv, dark);
      };
      gb.quadFacing(v(-1, -1, 0.04), v(1, -1, 0.04), v(1, 1, 0.04), v(-1, 1, 0.04), -nx, 0, -nz);
    }
    quad(0, 0, W / 2, H / 2, 0, dark, 9, 0);
    // Legends: YOUR SPEED on top, SLOW DOWN below, atlas halves.
    quad(0, H / 2 - 0.2, W * 0.42, 0.12, 0.012, amber, 8, 0, [0, 0.5, 1, 1]);
    quad(0, -H / 2 + 0.2, W * 0.42, 0.115, 0.012, red, 7, 0, [0, 0, 1, 0.5]);
    // Three digits, 7 segments each, the clock's layout.
    const dw = 0.36;
    const dh = dw / 0.6;
    const th = dw * 0.17;
    for (let d = 0; d < 3; d++) {
      const dx = (d - 1) * dw * 1.3;
      for (let k = 0; k < 7; k++) {
        const [sx, sy, horiz] = SEGS[k];
        quad(dx + sx * dw, sy * dh * 0.96 - 0.01, horiz ? dw * 0.36 : th / 2, horiz ? th / 2 : dh * 0.2, 0.02, amber, d, k);
      }
    }
    // Brackets from the pole to the panel's back.
    const pl = world.blocks.streetlights[sg.pole];
    const pxm = pl.x;
    const pzm = pl.z;
    for (const dy of [-0.4, 0.4]) {
      const bx = (pxm + sg.x - nx * 0.04) / 2;
      const bz = (pzm + sg.z - nz * 0.04) / 2;
      const len = Math.hypot(sg.x - nx * 0.04 - pxm, sg.z - nz * 0.04 - pzm) / 2;
      boxQuads(gb, attr, si, bx, sg.y + dy, bz, len, 0.035, 0.035, (sg.x - pxm) / (len * 2 || 1), (sg.z - pzm) / (len * 2 || 1), dark, wu, wv);
    }
  });

  const geo = own(gb.build());
  geo.setAttribute('aRadar', new THREE.Float32BufferAttribute(attr, 3));
  const readings = new Float32Array(D.maxSigns).fill(-1);
  const mat = own(new THREE.MeshBasicMaterial({ vertexColors: true, map: tex }));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSignTime = signageTime;
    shader.uniforms.uRadar = { value: readings };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uSignTime;
        uniform float uRadar[${D.maxSigns}];
        attribute vec3 aRadar;
        const int SEG7[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
        // 1 when the segment (or the SLOW DOWN legend) is lit, 0 when dark; digits blank their leading zeros.
        float radarLit(float v, float kind, float seg, float over, float phase) {
          if (kind > 6.5) return over * (1.0 - phase);
          if (v < 0.0) return 0.0;
          float n = floor(v + 0.5);
          float val = kind < 0.5 ? floor(n / 100.0) : kind < 1.5 ? mod(floor(n / 10.0), 10.0) : mod(n, 10.0);
          if ((kind < 0.5 && n < 100.0) || (kind > 0.5 && kind < 1.5 && n < 10.0)) return 0.0;
          return float((SEG7[int(val)] >> int(seg + 0.5)) & 1) * mix(1.0, phase, over);
        }`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (uRadar[int(aRadar.x + 0.5)] < -1.5) transformed = vec3(0.0);')
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_COLOR
        {
          float v = uRadar[int(aRadar.x + 0.5)];
          float kind = aRadar.y;
          float over = step(${(D.limitMph + 0.5).toFixed(1)}, v);
          float phase = step(fract(uSignTime * ${D.flashHz.toFixed(2)}), 0.5);
          if (kind < 6.5) {
            vColor.rgb *= mix(${D.segOff.toFixed(3)}, ${D.digitGain.toFixed(2)}, radarLit(v, kind, aRadar.z, over, phase)) * mix(vec3(1.0), vec3(1.0, 0.16, 0.1), over);
          } else if (kind < 7.5) vColor.rgb *= mix(0.03, ${D.digitGain.toFixed(2)}, radarLit(v, kind, aRadar.z, over, phase));
          else if (kind < 8.5) vColor.rgb *= ${D.labelGain.toFixed(2)};
        }
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => `radarSigns:${D.maxSigns}`;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'radarSigns';
  mesh.frustumCulled = false;

  // Per-frame readings: best (nearest, so largest `along`) approaching car per sign.
  const bestAlong = new Float32Array(signs.length);
  const bestMph = new Float32Array(signs.length);
  return {
    mesh,
    signs,
    begin() {
      bestAlong.fill(-Infinity);
    },
    feed(x, z, vx, vz) {
      for (let i = 0; i < signs.length; i++) {
        const sg = signs[i];
        const dx = x - sg.x;
        const dz = z - sg.z;
        const along = dx * sg.fx + dz * sg.fz;
        if (along < -D.range || along > D.pastRange || along <= bestAlong[i]) continue;
        const lat = dx * -sg.fz + dz * sg.fx;
        if (lat * lat > sg.reach * sg.reach) continue;
        // Approaching: moving along the road's direction, not parked or backing.
        if (vx * sg.fx + vz * sg.fz < 1) continue;
        bestAlong[i] = along;
        bestMph[i] = Math.hypot(vx, vz) / MS_PER_MPH;
      }
    },
    end(broken) {
      for (let i = 0; i < signs.length; i++) {
        readings[i] = broken && broken[signs[i].pole] ? -2 : bestAlong[i] > -Infinity ? bestMph[i] : -1;
      }
    },
    dispose() {
      for (const d of owned) d.dispose();
    },
  };
}

/** A small box (half-lengths hl along the unit direction (dx, dz), hw across, hh tall) as six quads of the kind-9 hardware. */
function boxQuads(gb: GeoBuilder, attr: number[], si: number, cx: number, cy: number, cz: number, hl: number, hw: number, hh: number, dx: number, dz: number, color: THREE.Color, wu: number, wv: number): void {
  const px = -dz;
  const pz = dx;
  // Axes in (along, across, up); a face is an axis and a sign, its corners the other two axes' +-1.
  for (let axis = 0; axis < 3; axis++) {
    for (const sg of [-1, 1]) {
      const na = axis === 0 ? sg : 0;
      const nb = axis === 1 ? sg : 0;
      const nc = axis === 2 ? sg : 0;
      const nx = na * dx + nb * px;
      const nz = na * dz + nb * pz;
      const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
        const q = [0, 0, 0];
        q[axis] = sg;
        q[(axis + 1) % 3] = u;
        q[(axis + 2) % 3] = v;
        attr.push(si, 9, 0);
        return gb.vertex(cx + dx * hl * q[0] + px * hw * q[1], cy + hh * q[2], cz + dz * hl * q[0] + pz * hw * q[1], nx, nc, nz, wu, wv, color);
      });
      gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, nc, nz);
    }
  }
}
