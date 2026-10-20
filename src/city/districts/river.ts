/**
 * River: an LA River style concrete flood channel running east-west across
 * the whole map between two street rows, with a gently meandering
 * centerline z = zMid + amp * sin(k x + phase).
 *
 * Cross section (l = z - centerline): flat floor |l| <= floorHalf at -depth,
 * smooth sloped concrete banks up to |l| = top, a fence on top facing the
 * channel. Every road edge crossing it is a bridge at street level
 * (edge.bridge): the terrain stays flat under the deck, its frontage walls
 * become parapets, and a solid bridge body `bridgeBody` m wide on each side
 * (walls 'culvert' facing the channel) keeps channel and deck apart, since
 * walls push back cars up to 3 m behind them. Access ramps are trenches cut
 * from a street frontage down to the floor (walls 'trench'), each flanked
 * by solid retaining blocks on the bank. The floor is drivable concrete
 * with a wet 'water' trickle in the middle; the channel ends in tunnel walls
 * ('channelEnd') well outside the city.
 *
 * Content to add (render/districts/river.ts): bank and floor textures,
 * graffiti, the water trickle, bridge bodies and arches, ramp details,
 * fence posts, lights.
 */
import { CITY } from '../config';
import type { RoadGraph } from '../roadGraph';
import { Vec2, cos, distToSegment, segmentT, sin, sqrt } from '../../sim/math';
import type { Wall } from '../blocks';
import type { Area, DistrictModule } from './types';
import { emptyBuild } from './types';
import { polyWalls, smooth01 } from './geom';

const CFG = CITY.districts.river;

/** Centerline helpers from an area's params. */
export function riverCenter(p: Record<string, number>, x: number): number {
  return p.zMid + p.amp * sin(p.k * x + p.phase);
}

interface Bridge {
  edge: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  len: number;
  /** Half width to the outer sidewalk line. */
  dk: number;
  /** x where the edge crosses the centerline. */
  cx: number;
}

function bridgesOf(g: RoadGraph, area: Area): Bridge[] {
  const p = area.params;
  return area.edges.map((eid) => {
    const e = g.edges[eid];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    // Crossing parameter by bisection on l(t).
    let lo = 0;
    let hi = len;
    const lAt = (t: number) => a.z + dz * t - riverCenter(p, a.x + dx * t);
    const sLo = lAt(0) < 0;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (lAt(mid) < 0 === sLo) lo = mid;
      else hi = mid;
    }
    return { edge: eid, ax: a.x, az: a.z, bx: b.x, bz: b.z, dx, dz, nx: -dz, nz: dx, len, dk: e.width / 2 + e.sidewalk, cx: a.x + dx * lo };
  });
}

/** Point on the bridge's line offset by `off` (along its normal) where l = lTarget. */
function bridgePoint(p: Record<string, number>, br: Bridge, off: number, lTarget: number): Vec2 {
  const ox = br.ax + br.nx * off;
  const oz = br.az + br.nz * off;
  const f = (t: number) => oz + br.dz * t - riverCenter(p, ox + br.dx * t) - lTarget;
  let lo = -40;
  let hi = br.len + 40;
  const sLo = f(lo) < 0;
  for (let i = 0; i < 56; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0 === sLo) lo = mid;
    else hi = mid;
  }
  return { x: ox + br.dx * lo, z: oz + br.dz * lo };
}

interface Ramp {
  x: number;
  side: number;
  /** |l| of the street frontage the ramp starts at, and where its slope starts. */
  lf: number;
  ls: number;
}

function rampsOf(area: Area): Ramp[] {
  const p = area.params;
  const out: Ramp[] = [];
  for (let i = 0; i < p.ramps; i++) out.push({ x: p[`ramp${i}x`], side: p[`ramp${i}side`], lf: p[`ramp${i}lf`], ls: p[`ramp${i}ls`] });
  return out;
}

export const riverModule: DistrictModule = {
  kind: 'river',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const g = ctx.graph;
    const F = CFG.floorHalf;
    const T = F + CFG.bankWidth;
    const H = CITY.gridH;
    const rowZ: number[] = [];
    for (let j = 0; j < H; j++) {
      const ns = g.nodes.filter((n) => n.gj === j);
      rowZ.push(ns.reduce((s, n) => s + n.z, 0) / Math.max(1, ns.length));
    }
    const rows: number[] = [];
    for (let j = 2; j <= H - 4; j++) rows.push(j);
    rng.shuffle(rows);
    const k = (Math.PI * 2) / CFG.wavelength;
    const phase = rng.range(0, Math.PI * 2);
    let params: Record<string, number> | null = null;
    for (const j of rows) {
      for (const amp of [CFG.meander, 0]) {
        const p = { zMid: (rowZ[j] + rowZ[j + 1]) / 2, amp, k, phase };
        if (g.nodes.every((n) => Math.abs(n.z - riverCenter(p, n.x)) >= T + 20)) {
          params = p;
          break;
        }
      }
      if (params) break;
    }
    if (!params) return;
    const x0 = g.bounds.minX - 160;
    const x1 = g.bounds.maxX + 160;
    const footprint = (g.bounds.maxX - g.bounds.minX) * 2 * T;
    if (ctx.budget.used + footprint > ctx.budget.total) return;
    const p: Record<string, number> = { ...params, floor: F, top: T, depth: CFG.depth, x0, x1, ramps: 0 };
    const lOf = (x: number, z: number) => z - riverCenter(p, x);
    const edges = g.edges.filter((e) => lOf(g.nodes[e.a].x, g.nodes[e.a].z) * lOf(g.nodes[e.b].x, g.nodes[e.b].z) < 0).map((e) => e.id);
    for (const id of edges) g.edges[id].bridge = true;

    // Ramps: mid way between bridges, alternating banks, down from the nearest parallel street.
    const tmp: Area = { id: -1, kind: 'river', variant: '', polygon: [], path: [], nodes: [], edges, faces: [], params: p };
    const cross = bridgesOf(g, tmp)
      .map((b) => b.cx)
      .sort((a, b) => a - b);
    const hw = CFG.rampHalfWidth;
    const body = CFG.bridgeBody;
    const gaps: number[] = [];
    for (let i = 0; i + 1 < cross.length; i++) if (cross[i + 1] - cross[i] > 2 * (16 + body + hw + body + 10)) gaps.push((cross[i] + cross[i + 1]) / 2);
    rng.shuffle(gaps);
    let side = rng.chance(0.5) ? 1 : -1;
    for (const xr of gaps) {
      if (p.ramps >= CFG.ramps) break;
      // Street on this bank, parallel to the river, covering the ramp.
      let best = -1;
      let bestL = Infinity;
      let bestFront = 0;
      for (const e of g.edges) {
        if (e.kind === 'backAlley' || e.bridge) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        if (Math.abs(b.x - a.x) < 0.9 * e.length) continue;
        if (Math.min(a.x, b.x) > xr - hw - 8 || Math.max(a.x, b.x) < xr + hw + 8) continue;
        const la = lOf(a.x, a.z);
        const lb = lOf(b.x, b.z);
        if (la * side <= 0 || lb * side <= 0) continue;
        const t = (xr - a.x) / (b.x - a.x);
        const zc = a.z + (b.z - a.z) * t;
        const l = Math.abs(zc - riverCenter(p, xr));
        if (l < bestL) {
          bestL = l;
          best = e.id;
          bestFront = l - (e.width / 2 + e.sidewalk);
        }
      }
      if (best < 0 || bestFront - F < 30 || bestFront - F > 80) continue;
      // Nothing else may cross the trench (a missing row street would make it run on to the next row).
      const z0 = riverCenter(p, xr) + side * F;
      const z1 = riverCenter(p, xr) + side * bestFront;
      const reach = hw + body + 4;
      const crosses = g.edges.some((e) => {
        if (e.id === best) return false;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        // Sample the trench axis against the edge's corridor.
        for (let k = 0; k <= 10; k++) {
          const z = z0 + ((z1 - z0) * k) / 10;
          if (distToSegment(xr, z, a.x, a.z, b.x, b.z) < e.width / 2 + e.sidewalk + reach) return true;
        }
        return false;
      });
      if (crosses) continue;
      const i = p.ramps++;
      p[`ramp${i}x`] = xr;
      p[`ramp${i}side`] = side;
      p[`ramp${i}edge`] = best;
      p[`ramp${i}lf`] = bestFront;
      p[`ramp${i}ls`] = bestFront - 0.5;
      side = -side;
    }

    const path: Vec2[] = [];
    const up: Vec2[] = [];
    const down: Vec2[] = [];
    for (let x = x0; x <= x1 + 1e-6; x += 16) {
      const z = riverCenter(p, x);
      path.push({ x, z });
      up.push({ x, z: z + T + 0.5 });
      down.push({ x, z: z - T - 0.5 });
    }
    ctx.addArea({ kind: 'river', variant: 'channel', polygon: up.concat(down.reverse()), path, nodes: [], edges, faces: [], params: p }, footprint);
  },

  build(ctx, area) {
    const b = emptyBuild();
    const p = area.params;
    const id = area.id;
    const F = p.floor;
    const T = p.top;
    const D = p.depth;
    const body = CFG.bridgeBody;
    const hw = CFG.rampHalfWidth;
    const fenceL = T + 0.5;
    const bridges = bridgesOf(ctx.graph, area);
    const ramps = rampsOf(area);
    const zc = (x: number) => riverCenter(p, x);
    const at = (x: number, l: number): Vec2 => ({ x, z: zc(x) + l });
    const band = (xa: number, xb: number, la: number, lb: number, step = 16): Vec2[] => {
      const top: Vec2[] = [];
      const bot: Vec2[] = [];
      const n = Math.max(1, Math.ceil((xb - xa) / step));
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n;
        top.push(at(x, lb));
        bot.push(at(x, la));
      }
      return bot.concat(top.reverse());
    };

    // Height: channel profile, ramp trenches, flattened under bridge decks.
    let lMax = T + 1;
    for (const r of ramps) lMax = Math.max(lMax, r.lf + 1);
    b.heightMods.push({
      minX: p.x0 - 2,
      maxX: p.x1 + 2,
      minZ: p.zMid - p.amp - lMax,
      maxZ: p.zMid + p.amp + lMax,
      add(x, z, out) {
        const s = sin(p.k * x + p.phase);
        const c = cos(p.k * x + p.phase);
        const l = z - (p.zMid + p.amp * s);
        const sg = l >= 0 ? 1 : -1;
        const al = l * sg;
        let h = 0;
        let gl = 0;
        if (al < T) {
          const st = smooth01(F, T, al);
          h = -D * (1 - st.v);
          gl = D * st.d * sg;
        }
        for (const r of ramps) {
          if (r.side !== sg || al <= F || al > r.ls || Math.abs(x - r.x) > hw) continue;
          const hr = -D * (1 - (al - F) / (r.ls - F));
          if (hr < h) {
            h = hr;
            gl = (D / (r.ls - F)) * sg;
          }
        }
        if (h === 0) return;
        let gx = -gl * p.amp * p.k * c;
        let gz = gl;
        for (const br of bridges) {
          if (Math.abs(x - br.cx) > 90) continue;
          const lim = br.dk + body;
          const d = distToSegment(x, z, br.ax, br.az, br.bx, br.bz);
          if (d >= lim) continue;
          const m = smooth01(br.dk, lim, d);
          const t = segmentT(x, z, br.ax, br.az, br.bx, br.bz);
          const ddx = d > 1e-6 ? (x - (br.ax + (br.bx - br.ax) * t)) / d : 0;
          const ddz = d > 1e-6 ? (z - (br.az + (br.bz - br.az) * t)) / d : 0;
          gx = gx * m.v + h * m.d * ddx;
          gz = gz * m.v + h * m.d * ddz;
          h *= m.v;
        }
        out.h += h;
        out.gx += gx;
        out.gz += gz;
      },
    });

    // No buildings or infill near the channel.
    const clear = T + CFG.clearance;
    for (let x = p.x0; x < p.x1; x += 24) b.exclusions.push(band(x, Math.min(p.x1, x + 24), -clear, clear, 24));
    b.surfaces.push({ surface: 'concrete', polygon: area.polygon, priority: 1, area: id });
    b.surfaces.push({ surface: 'water', polygon: band(p.x0, p.x1, -CFG.waterHalf, CFG.waterHalf), priority: 2, area: id });

    // Bridges: culvert faces of the solid bridge body, parapet looks on the deck sides.
    const gapsBySide: Record<number, [number, number][]> = { 1: [], [-1]: [] };
    for (const br of bridges) {
      const qs: Record<number, Vec2[]> = {};
      for (const s of [-1, 1]) {
        const off = s * (br.dk + body);
        const q0 = bridgePoint(p, br, off, -fenceL);
        const q1 = bridgePoint(p, br, off, fenceL);
        qs[s] = [q0, q1];
        const w: Wall = { ax: q0.x, az: q0.z, bx: q1.x, bz: q1.z, nx: br.nx * s, nz: br.nz * s, kind: 'wall', look: 'culvert', area: id };
        b.walls.push(w);
      }
      for (const fs of [-1, 1]) {
        const xa = qs[-1][fs > 0 ? 1 : 0].x;
        const xb = qs[1][fs > 0 ? 1 : 0].x;
        gapsBySide[fs].push([Math.min(xa, xb), Math.max(xa, xb)]);
      }
      const o = br.dk + body + 0.5;
      b.frontLooks.push({
        polygon: [bridgePoint(p, br, -o, -fenceL - 1), bridgePoint(p, br, o, -fenceL - 1), bridgePoint(p, br, o, fenceL + 1), bridgePoint(p, br, -o, fenceL + 1)],
        look: 'parapet',
        area: id,
      });
      b.hints.push({ kind: 'bridge', points: [qs[-1][0], qs[1][0], qs[1][1], qs[-1][1]], values: [br.edge, br.dk] });
    }

    // Ramps: trench walls, solid retaining blocks on the bank, an opening in the street frontage.
    for (const r of ramps) {
      const s = r.side;
      const xa = r.x - hw;
      const xb = r.x + hw;
      gapsBySide[s].push([xa - body, xb + body]);
      const frontZ = (x: number) => zc(x) + s * r.lf;
      // Inner trench walls, normals into the trench.
      b.walls.push({ ax: xa, az: zc(xa) + s * F, bx: xa, bz: frontZ(xa), nx: 1, nz: 0, kind: 'wall', look: 'trench', area: id });
      b.walls.push({ ax: xb, az: zc(xb) + s * F, bx: xb, bz: frontZ(xb), nx: -1, nz: 0, kind: 'wall', look: 'trench', area: id });
      // Retaining blocks: outer faces toward the bank, bottom faces toward the floor.
      for (const [x0, x1, nx] of [
        [xa - body, xa, -1],
        [xb + body, xb, 1],
      ]) {
        b.walls.push({ ax: x0, az: zc(x0) + s * F, bx: x0, bz: zc(x0) + s * fenceL, nx, nz: 0, kind: 'wall', look: 'trench', area: id });
        const bot = { ax: x0, az: zc(x0) + s * F, bx: x1, bz: zc(x1) + s * F };
        const len = Math.hypot(bot.bx - bot.ax, bot.bz - bot.az) || 1;
        let bnx = -(bot.bz - bot.az) / len;
        let bnz = (bot.bx - bot.ax) / len;
        if (bnz * -s < 0) {
          bnx = -bnx;
          bnz = -bnz;
        }
        b.walls.push({ ...bot, nx: bnx, nz: bnz, kind: 'wall', look: 'trench', area: id });
      }
      b.openings.push([at(xa + 0.3, s * (r.lf - 4)), at(xb - 0.3, s * (r.lf - 4)), at(xb - 0.3, s * (r.lf + 1)), at(xa + 0.3, s * (r.lf + 1))]);
      const trench = [at(xa, s * F), at(xb, s * F), at(xb, s * r.lf), at(xa, s * r.lf)];
      b.surfaces.push({ surface: 'concrete', polygon: trench, priority: 2, area: id });
      const m = CITY.districts.infill.gap;
      b.exclusions.push([at(xa - body - m, s * F), at(xb + body + m, s * F), at(xb + body + m, s * (r.lf + 0.2)), at(xa - body - m, s * (r.lf + 0.2))]);
      b.hints.push({ kind: 'ramp', points: trench, values: [s, r.lf, r.ls] });
    }

    // Bank top fences between bridges and ramps, normals toward the channel.
    for (const s of [-1, 1]) {
      const gaps = gapsBySide[s].sort((u, v) => u[0] - v[0]);
      let x = p.x0;
      const pieces: [number, number][] = [];
      for (const [g0, g1] of gaps) {
        if (g0 > x) pieces.push([x, g0]);
        x = Math.max(x, g1);
      }
      if (x < p.x1) pieces.push([x, p.x1]);
      for (const [u0, u1] of pieces) {
        const pts: Vec2[] = [];
        const n = Math.max(1, Math.ceil((u1 - u0) / 8));
        for (let i = 0; i <= n; i++) pts.push(at(u0 + ((u1 - u0) * i) / n, s * fenceL));
        // Travelling +x: the channel is on the right for the north (+l) fence.
        b.walls.push(...polyWalls(pts, s > 0, 'fence', id, false));
        b.hints.push({ kind: 'fence', points: pts, values: [s] });
      }
    }
    // Tunnel walls at both ends of the channel.
    b.walls.push({ ax: p.x0, az: zc(p.x0) - fenceL, bx: p.x0, bz: zc(p.x0) + fenceL, nx: 1, nz: 0, kind: 'wall', look: 'channelEnd', area: id });
    b.walls.push({ ax: p.x1, az: zc(p.x1) - fenceL, bx: p.x1, bz: zc(p.x1) + fenceL, nx: -1, nz: 0, kind: 'wall', look: 'channelEnd', area: id });
    return b;
  },
};
