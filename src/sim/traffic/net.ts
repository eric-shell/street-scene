/**
 * The traffic network of a world: one lane per direction on every plain street, connectors through each
 * junction, the conflict table that makes crossing connectors take turns, and the timed-gate spans. Built once
 * per World (trafficNet caches it) as a pure function of it; lanes and connectors that would rub a wall or
 * leave the paving are dropped and dead ends pruned. Along a kerb parking row (city/parking.ts, the same plan
 * the parked cars stand in) the lane on that side moves in, as it merges round roadworks, so no driving car
 * ever brushes a parked one. samplePath reads a pose along any path.
 */
import type { World, Contact } from '../../city/world';
import type { RoadKind } from '../../city/roadGraph';
import { isBendNode } from '../../city/roadGraph';
import { ROADWORKS, laneClosures } from '../../city/districts/roadworks';
import { planParking, type ParkingRow } from '../../city/parking';
import { CITY } from '../../city/config';
import { TRAFFIC } from '../tuning';
import { DEG, TAU, abs, atan2, cos, distToSegment, sin, smoothstep, sqrt, wrapAngle, yawOf } from '../math';
import { TRAFFIC_LAYOUT, type TrafficNet, type TrafficPath } from './types';

const L = TRAFFIC_LAYOUT;
const P = TRAFFIC;

/** Scratch for zoneEnd while the network is built (samplePath writes it before every read). */
const pose = { x: 0, z: 0, yaw: 0 };

const netCache = new WeakMap<World, TrafficNet>();

/** The traffic network of a world (pure function of it, built once and cached). */
export function trafficNet(world: World): TrafficNet {
  let net = netCache.get(world);
  if (!net) {
    net = buildNet(world);
    netCache.set(world, net);
  }
  return net;
}

const maxHalfWidth = (): number => Math.max(...P.kinds.map((k) => k.halfWidth));

/** True when a car's footprint along the polyline would touch a wall or leave the paving. */
function pathBlocked(w: World, xs: number[], zs: number[], r: number, contacts: Contact[]): boolean {
  for (let i = 0; i + 1 < xs.length; i++) {
    const dx = xs[i + 1] - xs[i];
    const dz = zs[i + 1] - zs[i];
    const len = sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / L.probeStep));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const x = xs[i] + (dx * k) / n;
      const z = zs[i] + (dz * k) / n;
      // Probed at street level: over the river channel a bridge's piers stand beneath its deck (Wall.top).
      if (w.collideCircle(x, z, r, contacts, w.heightAt(x, z)) > 0) return true;
      const s = w.surfaceAt(x, z);
      if (s === 'offroad' || s === 'grass' || s === 'water') return true;
    }
  }
  return false;
}

function polyPath(xs: number[], zs: number[], yaws: number[], lane: boolean, edge: number, from: number, to: number): TrafficPath {
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + sqrt((xs[i] - xs[i - 1]) ** 2 + (zs[i] - zs[i - 1]) ** 2));
  return { lane, x: xs, z: zs, yaw: yaws, cum, length: cum[cum.length - 1], edge, from, to, out: [], in: [], locked: false, conflicts: [], clearAt: [], vmax: Infinity, factor: 1, weight: 1, gates: [], gateS: [] };
}

/**
 * A lane's polyline from its start (x0, z0) along (fx, fz) for `len` m, kept
 * `off` m right of the street's centerline, merging left by `shift` over each
 * squeeze's [a, b] stretch (lane m), easing out and back over rampLength.
 */
function lanePolyline(x0: number, z0: number, fx: number, fz: number, len: number, off: number, squeeze: { a: number; b: number; shift: number }[]): { xs: number[]; zs: number[]; yaws: number[] } {
  const ss = [0, len];
  for (const q of squeeze) {
    for (let k = 0; k <= L.rampSteps; k++) {
      ss.push(q.a - L.rampLength + (L.rampLength * k) / L.rampSteps);
      ss.push(q.b + (L.rampLength * k) / L.rampSteps);
    }
  }
  const at = ss.filter((v) => v >= 0 && v <= len).sort((u, v) => u - v);
  const uniq = at.filter((v, i) => i === 0 || v - at[i - 1] > 1e-6);
  const offAt = (v: number) => {
    let o = off;
    for (const q of squeeze) o = Math.min(o, off - q.shift * smoothstep(q.a - L.rampLength, q.a, v) * (1 - smoothstep(q.b, q.b + L.rampLength, v)));
    return o;
  };
  const xs = uniq.map((v) => x0 + fx * v - fz * offAt(v));
  const zs = uniq.map((v) => z0 + fz * v + fx * offAt(v));
  const yaws = uniq.map((_, i) => {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(uniq.length - 1, i + 1);
    return yawOf(xs[i1] - xs[i0], zs[i1] - zs[i0]);
  });
  return { xs, zs, yaws };
}

/** Tightest radius along a polyline (m) from the heading change between its segments. */
function minRadius(p: TrafficPath): number {
  let r = Infinity;
  for (let i = 1; i + 1 < p.x.length; i++) {
    const y0 = yawOf(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
    const y1 = yawOf(p.x[i + 1] - p.x[i], p.z[i + 1] - p.z[i]);
    const dth = abs(wrapAngle(y1 - y0));
    if (dth < 1e-6) continue;
    r = Math.min(r, (p.cum[i + 1] - p.cum[i - 1]) / 2 / dth);
  }
  return r;
}

function buildNet(w: World): TrafficNet {
  const g = w.graph;
  const routeNodes = new Set<number>(w.openWorld ? [] : w.route.nodes);
  const kinds = new Set<RoadKind>(L.kinds);
  const contacts: Contact[] = [];
  const probe = maxHalfWidth() + L.probePad;
  const paths: TrafficPath[] = [];
  /** Lane path id per edge and direction (2 * edge + 0 for a -> b, + 1 for b -> a), -1 for none. */
  const laneOf = new Int32Array(g.edges.length * 2).fill(-1);
  const mouths = w.blocks.mouths;
  // Roadworks closures per edge: the closure in its street frame (laneClosures runs in area order, as this filter does).
  const works = (w.areas ?? []).filter((a) => a.kind === 'roadworks');
  const closures = laneClosures(w.areas ?? [], g);
  const closuresOf = new Map<number, typeof closures>();
  works.forEach((a, i) => {
    const c = closures[i];
    if (!c) return;
    const list = closuresOf.get(a.params.edge);
    if (list) list.push(c);
    else closuresOf.set(a.params.edge, [c]);
  });

  // Kerb parking rows per edge (city/parking.ts): the lane on a row's side moves in clear of its strip.
  const rowsOf = new Map<number, ParkingRow[]>();
  for (const row of planParking(w).rows) {
    const list = rowsOf.get(row.edge);
    if (list) list.push(row);
    else rowsOf.set(row.edge, [row]);
  }

  // Night markets (districts/market.ts) close their street to traffic, in an open world too.
  const market = new Set((w.areas ?? []).filter((a) => a.kind === 'market').flatMap((a) => a.edges));

  // Lanes: keep right, stopping short of each junction where its curbs start.
  for (const e of g.edges) {
    if (!kinds.has(e.kind) || e.shortcut || market.has(e.id) || routeNodes.has(e.a) || routeNodes.has(e.b)) continue;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = e.length || 1;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const m = mouths[e.id];
    const reach = (N: typeof A, pts: { x: number; z: number }[], sx: number, sz: number) => {
      if (isBendNode(g, N.id)) return L.bendSetback;
      let t = 0;
      for (const p of pts) t = Math.max(t, (p.x - N.x) * sx + (p.z - N.z) * sz);
      if (N.ring) t = Math.max(t, N.ring.outer);
      return Math.max(L.setbackMin, t + L.setbackMargin);
    };
    const sa = reach(A, [m.aP.curb, m.aN.curb], dx, dz);
    const sb = reach(B, [m.bP.curb, m.bN.curb], -dx, -dz);
    if (len - sa - sb < L.minLaneLength) continue;
    const off = e.lanes === 4 ? CITY.laneWidth * 1.5 : e.width / 4;
    const factor = L.speedFactor[e.kind] ?? 1;
    for (const dir of [0, 1]) {
      const fx = dir === 0 ? dx : -dx;
      const fz = dir === 0 ? dz : -dz;
      const S = dir === 0 ? A : B;
      const T = dir === 0 ? B : A;
      const s0 = dir === 0 ? sa : sb;
      const s1 = dir === 0 ? sb : sa;
      // Right of travel is (-fz, fx).
      const rx = -fz;
      const rz = fx;
      const laneLen = len - s0 - s1;
      // Roadworks on this side: merge out to clear the barriers, in lane distance (m) from the lane's start.
      const squeeze: { a: number; b: number; shift: number }[] = [];
      for (const c of closuresOf.get(e.id) ?? []) {
        if (c.nx * rx + c.nz * rz < 0.5) continue;
        const clear = c.keep + ROADWORKS.aiMargin - maxHalfWidth() - L.closurePad;
        if (clear >= off) continue;
        const a = dir === 0 ? c.s0 - s0 : len - c.s1 - s0;
        const b = dir === 0 ? c.s1 - s0 : len - c.s0 - s0;
        squeeze.push({ a, b, shift: off - clear });
      }
      // Kerb parking on this side (the P side is right of a -> b): the widest car keeps parkClear off the strip.
      // kerbStrip only admits a street with a full lane of carriageway beside the strip, so this never crosses the centreline.
      for (const row of rowsOf.get(e.id) ?? []) {
        if ((row.side === 1) !== (dir === 0)) continue;
        const keep = e.width / 2 - row.strip - L.parkClear - maxHalfWidth();
        if (keep >= off) continue;
        const a = dir === 0 ? row.s0 - s0 : len - row.s1 - s0;
        const b = dir === 0 ? row.s1 - s0 : len - row.s0 - s0;
        squeeze.push({ a, b, shift: off - keep });
      }
      const { xs, zs, yaws } = lanePolyline(S.x + fx * s0, S.z + fz * s0, fx, fz, laneLen, off, squeeze);
      if (pathBlocked(w, xs, zs, probe, contacts)) continue;
      const p = polyPath(xs, zs, yaws, true, e.id, S.id, T.id);
      p.factor = factor;
      laneOf[2 * e.id + dir] = paths.length;
      paths.push(p);
    }
  }

  // Connectors: every incoming lane to every outgoing lane of another street at the node.
  const maxTurn = L.maxTurnDeg * DEG;
  for (const n of g.nodes) {
    const ins: number[] = [];
    const outs: number[] = [];
    for (const eid of n.edges) {
      const e = g.edges[eid];
      const toN = e.b === n.id ? laneOf[2 * eid] : laneOf[2 * eid + 1];
      const fromN = e.a === n.id ? laneOf[2 * eid] : laneOf[2 * eid + 1];
      if (toN >= 0) ins.push(toN);
      if (fromN >= 0) outs.push(fromN);
    }
    const streets = new Set([...ins, ...outs].map((id) => paths[id].edge)).size;
    for (const li of ins) {
      for (const lo of outs) {
        const a = paths[li];
        const b = paths[lo];
        if (a.edge === b.edge) continue;
        const ai = a.x.length - 1;
        const turn = wrapAngle(b.yaw[0] - a.yaw[ai]);
        if (abs(turn) > maxTurn) continue;
        const p0x = a.x[ai];
        const p0z = a.z[ai];
        const p3x = b.x[0];
        const p3z = b.z[0];
        const xs: number[] = [];
        const zs: number[] = [];
        const ys: number[] = [];
        if (n.ring) {
          // Around the island, island on the driver's left (decreasing atan2 angle), as the route does.
          const R = n.ring.island + L.ringLane * (n.ring.outer - n.ring.island);
          const aE = atan2(p0z - n.z, p0x - n.x);
          const aX = atan2(p3z - n.z, p3x - n.x);
          let sweep = aE - aX;
          while (sweep <= 1e-6) sweep += TAU;
          while (sweep > TAU) sweep -= TAU;
          const lead = Math.min(L.ringLeadDeg * DEG, sweep / 4);
          const arc = sweep - 2 * lead;
          const steps = Math.max(2, Math.ceil(arc / (L.ringStepDeg * DEG)));
          xs.push(p0x);
          zs.push(p0z);
          ys.push(a.yaw[ai]);
          for (let k = 0; k <= steps; k++) {
            const ang = aE - lead - (arc * k) / steps;
            xs.push(n.x + cos(ang) * R);
            zs.push(n.z + sin(ang) * R);
            ys.push(yawOf(sin(ang), -cos(ang)));
          }
          xs.push(p3x);
          zs.push(p3z);
          ys.push(b.yaw[0]);
        } else {
          const t0x = sin(a.yaw[ai]);
          const t0z = cos(a.yaw[ai]);
          const t3x = sin(b.yaw[0]);
          const t3z = cos(b.yaw[0]);
          const h = sqrt((p3x - p0x) ** 2 + (p3z - p0z) ** 2) * L.handle;
          const p1x = p0x + t0x * h;
          const p1z = p0z + t0z * h;
          const p2x = p3x - t3x * h;
          const p2z = p3z - t3z * h;
          for (let k = 0; k <= L.curveSteps; k++) {
            const t = k / L.curveSteps;
            const u = 1 - t;
            xs.push(u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x);
            zs.push(u * u * u * p0z + 3 * u * u * t * p1z + 3 * u * t * t * p2z + t * t * t * p3z);
            const dx = 3 * u * u * (p1x - p0x) + 6 * u * t * (p2x - p1x) + 3 * t * t * (p3x - p2x);
            const dz = 3 * u * u * (p1z - p0z) + 6 * u * t * (p2z - p1z) + 3 * t * t * (p3z - p2z);
            ys.push(dx * dx + dz * dz > 1e-12 ? yawOf(dx, dz) : a.yaw[ai]);
          }
        }
        if (pathBlocked(w, xs, zs, probe, contacts)) continue;
        const c = polyPath(xs, zs, ys, false, -1, n.id, n.id);
        c.locked = streets >= 3 || !!n.ring;
        c.vmax = Math.max(P.minTurnSpeed, sqrt(P.turnLatAccel * minRadius(c)));
        c.factor = b.factor;
        c.weight = abs(turn) < 30 * DEG ? L.straightWeight : 1;
        c.in.push(li);
        c.out.push(lo);
        a.out.push(paths.length);
        b.in.push(paths.length);
        paths.push(c);
      }
    }
  }

  // Prune dead ends until every lane has a way in and a way on.
  const alive = paths.map(() => true);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (!alive[i] || !p.lane) continue;
      if (p.out.some((c) => alive[c]) && p.in.some((c) => alive[c])) continue;
      alive[i] = false;
      changed = true;
      for (const c of [...p.out, ...p.in]) alive[c] = false;
    }
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (alive[i] && !p.lane && (!alive[p.in[0]] || !alive[p.out[0]])) {
        alive[i] = false;
        changed = true;
      }
    }
  }
  const remap = new Int32Array(paths.length).fill(-1);
  const kept: TrafficPath[] = [];
  paths.forEach((p, i) => {
    if (!alive[i]) return;
    remap[i] = kept.length;
    kept.push(p);
  });
  for (const p of kept) {
    p.out = p.out.filter((i) => alive[i]).map((i) => remap[i]);
    p.in = p.in.filter((i) => alive[i]).map((i) => remap[i]);
  }
  // Conflicts between the reserved connectors of each junction.
  // A nose can swing into a side where paths cross at an angle: half length plus half width, not two half widths.
  const gap = Math.max(...P.kinds.map((k) => k.halfLength)) + maxHalfWidth() + L.conflictPad;
  const byNode = new Map<number, number[]>();
  kept.forEach((p, i) => {
    if (p.lane || !p.locked) return;
    const list = byNode.get(p.from);
    if (list) list.push(i);
    else byNode.set(p.from, [i]);
  });
  for (const list of byNode.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let c = a + 1; c < list.length; c++) {
        const A = kept[list[a]];
        const B = kept[list[c]];
        // Turns out of the same lane only share their start, where the follower follows the leader (stepTraffic).
        if (A.in[0] === B.in[0]) continue;
        const merge = A.out[0] === B.out[0];
        if (merge || polyDistance(A, B) < gap) {
          A.conflicts.push(list[c]);
          A.clearAt.push(merge ? A.length : zoneEnd(A, B, gap));
          B.conflicts.push(list[a]);
          B.clearAt.push(merge ? B.length : zoneEnd(B, A, gap));
        }
      }
    }
  }
  // Ascending conflict ids (clearAt kept parallel).
  for (const p of kept) {
    const order = p.conflicts.map((_, k) => k).sort((x, y) => p.conflicts[x] - p.conflicts[y]);
    p.conflicts = order.map((k) => p.conflicts[k]);
    p.clearAt = order.map((k) => p.clearAt[k]);
  }
  const lanes: number[] = [];
  const laneCum: number[] = [];
  let total = 0;
  kept.forEach((p, i) => {
    if (!p.lane) return;
    lanes.push(i);
    total += p.length;
    laneCum.push(total);
  });
  // Timed gates: where each path crosses a gate line coming from its holding side.
  const set = w.timedGates;
  const gateSpan: number[] = [];
  if (set) {
    set.gates.forEach((g, gi) => {
      let span = 0;
      for (const o of set.gates) if (o.cycle === g.cycle) span = Math.max(span, sqrt((o.cx - g.cx) ** 2 + (o.cz - g.cz) ** 2));
      gateSpan.push(span);
      for (const p of kept) {
        for (let i = 0; i + 1 < p.x.length; i++) {
          const sx = p.x[i + 1] - p.x[i];
          const sz = p.z[i + 1] - p.z[i];
          if (sx * g.nx + sz * g.nz >= 0) continue;
          const t = crossAt(p.x[i], p.z[i], p.x[i + 1], p.z[i + 1], g.ax, g.az, g.bx, g.bz);
          if (t < 0) continue;
          p.gates.push(gi);
          p.gateS.push(p.cum[i] + (p.cum[i + 1] - p.cum[i]) * t);
          break;
        }
      }
    });
  }
  return { paths: kept, lanes, laneCum, gateSpan };
}

/** Where segment a-b crosses segment c-d, as a share of a-b (-1 when they do not cross). */
function crossAt(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
  if (abs(den) < 1e-12) return -1;
  const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
  const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Distance between two segments (0 when they cross). */
function segDistance(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSegment(ax, az, cx, cz, dx, dz), distToSegment(bx, bz, cx, cz, dx, dz), distToSegment(cx, cz, ax, az, bx, bz), distToSegment(dx, dz, ax, az, bx, bz));
}

/** Distance along `a` (m) past which it stays further than `gap` from `b`: where a car on `a` is out of b's way. */
function zoneEnd(a: TrafficPath, b: TrafficPath, gap: number): number {
  let end = 0;
  const n = Math.max(2, Math.ceil(a.length / L.zoneStep));
  for (let k = 0; k <= n; k++) {
    const s = (a.length * k) / n;
    samplePath(a, s, pose);
    let d = Infinity;
    for (let j = 0; j + 1 < b.x.length && d >= gap; j++) d = Math.min(d, distToSegment(pose.x, pose.z, b.x[j], b.z[j], b.x[j + 1], b.z[j + 1]));
    if (d < gap) end = s;
  }
  return Math.min(a.length, end + a.length / n);
}

/** Closest approach of two polylines (m). */
function polyDistance(a: TrafficPath, b: TrafficPath): number {
  let d = Infinity;
  for (let i = 0; i + 1 < a.x.length; i++) {
    for (let j = 0; j + 1 < b.x.length; j++) d = Math.min(d, segDistance(a.x[i], a.z[i], a.x[i + 1], a.z[i + 1], b.x[j], b.z[j], b.x[j + 1], b.z[j + 1]));
  }
  return d;
}


/** Position and heading at distance s along a path. */
export function samplePath(p: TrafficPath, s: number, out: { x: number; z: number; yaw: number }): void {
  const n = p.x.length;
  if (s <= 0) {
    out.x = p.x[0];
    out.z = p.z[0];
    out.yaw = p.yaw[0];
    return;
  }
  let i = 0;
  while (i < n - 2 && p.cum[i + 1] < s) i++;
  const seg = p.cum[i + 1] - p.cum[i] || 1;
  const t = Math.min(1, (s - p.cum[i]) / seg);
  out.x = p.x[i] + (p.x[i + 1] - p.x[i]) * t;
  out.z = p.z[i] + (p.z[i + 1] - p.z[i]) * t;
  out.yaw = p.yaw[i] + wrapAngle(p.yaw[i + 1] - p.yaw[i]) * t;
}
