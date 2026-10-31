/**
 * Corner rails: the heavy dentable rails on the outside of the route's hard
 * corners, laid along the curb and clear of the city's walls, props and
 * T-junctions, split into the modular pieces the sim pushes around
 * (sim/rails.ts).
 */
import { CITY, ROUTE } from './config';
import { type RoadGraph, edgeBetween, isBendNode, isChannelEdge, otherNode } from './roadGraph';
import { type CityBlocks, type Wall, corridorClearance, makeWall } from './blocks';
import { isChannelNode } from './districts/channel';
import { DEG, type Vec2, abs, atan2, clamp, cos, distToSegment, lineIntersectT, sign, sin, sqrt, wrapAngle } from '../sim/math';
import type { Route } from './route';
import { segmentAt } from './districts/geom';

/** A corner rail sub segment: a 'rail' Wall that also knows which modular rail piece it belongs to. */
export interface RailWall extends Wall {
  kind: 'rail';
  /** Index of the corner rail (all segments of one rail share it). */
  group: number;
  /** Global rail piece index, consecutive along each rail (pieces are sim bodies, see src/sim/rails.ts). */
  piece: number;
}

/** A corner rail reaching toward a route shortcut's T junction stops this far before it (m). */
const TJUNCTION_CLEAR = 12;

/**
 * Road length beyond the neighbor of route node i (dir -1: before it, +1:
 * after it) through straight-through T junctions whose only other road is a
 * shortcut on the far side from `out` (a rail's outward side): those keep
 * the straight going as far as a corner rail is concerned.
 */
function insideRun(g: RoadGraph, route: Route, i: number, dir: number, out: Vec2): number {
  const n = route.nodes.length;
  let extra = 0;
  let j = i + dir;
  for (let guard = 0; guard < n; guard++) {
    if (route.closed) j = (j + n) % n;
    else if (j <= 0 || j >= n - 1) break;
    const id = route.nodes[j];
    const node = g.nodes[id];
    const prev = route.nodes[(j - dir + n) % n];
    const next = route.nodes[(j + dir + n) % n];
    if (isBendNode(g, id)) {
      // The street goes on through its bend: the rest of it counts as the straight.
      const N = g.nodes[next];
      extra += sqrt((N.x - node.x) ** 2 + (N.z - node.z) ** 2);
      j += dir;
      continue;
    }
    if (node.edges.length !== 3 || node.ring) break;
    const third = node.edges.find((eid) => {
      const o = otherNode(g.edges[eid], id);
      return o !== prev && o !== next;
    });
    if (third === undefined || !g.edges[third].shortcut) break;
    const far = g.nodes[otherNode(g.edges[third], id)];
    if ((far.x - node.x) * out.x + (far.z - node.z) * out.z >= 0) break;
    const N = g.nodes[next];
    const P = g.nodes[prev];
    const ax = node.x - P.x;
    const az = node.z - P.z;
    const bx = N.x - node.x;
    const bz = N.z - node.z;
    // Straight through only.
    if (abs(ax * bz - az * bx) > 0.02 * sqrt((ax * ax + az * az) * (bx * bx + bz * bz))) break;
    extra += sqrt(bx * bx + bz * bz);
    j += dir;
  }
  return extra;
}

/** 0 below e0, 1 above e1, a half cosine in between (C1, lowest peak curvature for the rise). */
function cosStep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return (1 - cos(t * Math.PI)) / 2;
}

/** Proper crossing test of segments ab and cd. */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
  if (abs(den) < 1e-12) return false;
  const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/**
 * Smooth guard rails on the outside of every route corner, at the back of the
 * sidewalk (ROUTE.railInset in front of the building line), so the road and
 * the whole sidewalk stay drivable runoff and no pocket is left between the
 * rail and the city walls. Path: a straight run along the incoming road's
 * outer sidewalk line, a round fillet across the outer corner, and a straight
 * run along the outgoing road's outer sidewalk line, tangent continuous. At a
 * plain bend the fillet follows the rounded sidewalk; at a junction it cuts at
 * most ROUTE.railCornerCut inside the sharp corner. Where the rail crosses the
 * mouth of a closed side street it bends smoothly back to pass behind that
 * street's crosswalk. The path is sampled finely, then cut into modular pieces
 * of about ROUTE.railPieceLength, each made of straight sub segments turning
 * at most ROUTE.railMaxSubDeg. Each rail is one connected chain of 'rail'
 * walls (b of one segment == a of the next), all sharing `group`, with normals
 * toward the drivable side and `piece` numbered along the chain. The fillet is
 * widened until the rail keeps clear of every city wall around the corner
 * (district features included), and the rail eases around the street
 * furniture it would otherwise touch. The city's blocks give the finished
 * graph's mouths and edge grid, its walls and its props.
 */
export function routeRails(g: RoadGraph, route: Route, blocks: CityBlocks): RailWall[] {
  const { mouths, edgeGrid, props, walls: cityWallList } = blocks;
  const gridScratch: number[] = [];
  const walls: RailWall[] = [];
  const n = route.nodes.length;
  const from = route.closed ? 0 : 1;
  const to = route.closed ? n : n - 1;
  const step = ROUTE.railSampleStep;
  const clear = ROUTE.railCrosswalkClear;
  const cwEnd = ROUTE.railCrosswalkEnd;
  let rail = 0;
  let piece = 0;
  for (let i = from; i < to; i++) {
    const prevId = route.nodes[(i - 1 + n) % n];
    const id = route.nodes[i];
    const nextId = route.nodes[(i + 1) % n];
    const P = g.nodes[id];
    const A0 = g.nodes[prevId];
    const B0 = g.nodes[nextId];
    const lenIn = sqrt((P.x - A0.x) ** 2 + (P.z - A0.z) ** 2);
    const lenOut = sqrt((B0.x - P.x) ** 2 + (B0.z - P.z) ** 2);
    const din = { x: (P.x - A0.x) / lenIn, z: (P.z - A0.z) / lenIn };
    const dout = { x: (B0.x - P.x) / lenOut, z: (B0.z - P.z) / lenOut };
    const turn = atan2(din.x * dout.z - din.z * dout.x, din.x * dout.x + din.z * dout.z);
    const theta = abs(turn);
    if (theta < ROUTE.railMinTurnDeg * DEG) continue;
    // On the channel floor the banks and their fence are the walls: no rails at its nodes. Nor at a weekend region's spine:
    // the open ground beside it is the region's other lines, and its entry and exit run straight on from their streets.
    if (isChannelNode(g, id)) continue;
    if (g.edges[edgeBetween(g, prevId, id)]?.kind === 'feature' || g.edges[edgeBetween(g, id, nextId)]?.kind === 'feature') continue;
    // Left of a direction d is (dz, -dx). Turning left means the outside is on the right.
    const leftTurn = dout.x * din.z - dout.z * din.x > 0;
    const side = leftTurn ? -1 : 1;
    const oin = { x: side * din.z, z: -side * din.x };
    const oout = { x: side * dout.z, z: -side * dout.x };
    const eInId = edgeBetween(g, prevId, id);
    const eOutId = edgeBetween(g, id, nextId);
    const eIn = g.edges[eInId];
    const eOut = g.edges[eOutId];
    const hIn = eIn.width / 2 + (eIn.sidewalk ?? CITY.sidewalk) - ROUTE.railInset;
    const hOut = eOut.width / 2 + (eOut.sidewalk ?? CITY.sidewalk) - ROUTE.railInset;
    const pin = { x: P.x + oin.x * hIn, z: P.z + oin.z * hIn };
    const pout = { x: P.x + oout.x * hOut, z: P.z + oout.z * hOut };
    const t = lineIntersectT(pin, din, pout, dout);
    if (t === null) continue;
    // V: where the two rail lines meet, outside the corner.
    const V = { x: pin.x + din.x * t, z: pin.z + din.z * t };

    // Side streets on the outside of the turn: everything not inside the wedge between
    // the incoming road (looking back) and the outgoing road.
    const back = { x: -din.x, z: -din.z };
    const wedge = sign(back.x * dout.z - back.z * dout.x);
    const outside: number[] = [];
    for (const eid of P.edges) {
      if (eid === eInId || eid === eOutId) continue;
      const far = g.nodes[otherNode(g.edges[eid], id)];
      const dl = sqrt((far.x - P.x) ** 2 + (far.z - P.z) ** 2) || 1;
      const d = { x: (far.x - P.x) / dl, z: (far.z - P.z) / dl };
      const inside = sign(back.x * d.z - back.z * d.x) === wedge && sign(d.x * dout.z - d.z * dout.x) === wedge;
      if (!inside) outside.push(eid);
    }

    // Fillet radius. Plain bend: follow the rounded sidewalk (center near P). Junction: the
    // apex sits R(1/c - 1) inside V, at most railCornerCut.
    const c = cos(theta / 2);
    const tanHalf = sin(theta / 2) / c;
    // A route shortcut's T junction on the inside of the turn does not end the straight the rail
    // runs along (its mouth faces away from the rail), so the reach counts the road beyond it.
    // It still stops TJUNCTION_CLEAR short of that junction (its traffic lights and crosswalk).
    const reachOf = (len: number, extra: number) => (extra > 0 ? Math.max(len * 0.42, Math.min((len + extra) * 0.42, len - TJUNCTION_CLEAR)) : len * 0.42);
    const maxReach = Math.min(reachOf(lenIn, insideRun(g, route, i, -1, oin)), reachOf(lenOut, insideRun(g, route, i, 1, oout)));
    const rMax = Math.max(1, Math.min(maxReach - 1, ROUTE.railFilletReach) / tanHalf);
    let R = Math.min(rMax, outside.length ? (ROUTE.railCornerCut * c) / (1 - c) : Math.max(hIn, hOut) + 0.3);
    // The city's real walls around the corner (district features included).
    const cityWalls: [Vec2, Vec2][] = cityWallList
      .filter((w) => Math.min(w.ax, w.bx) < P.x + 90 && Math.max(w.ax, w.bx) > P.x - 90 && Math.min(w.az, w.bz) < P.z + 90 && Math.max(w.az, w.bz) > P.z - 90)
      .map((w) => [{ x: w.ax, z: w.az }, { x: w.bx, z: w.bz }]);
    // Bounds of every city wall, widened by the clearance, so a point or step far from a wall skips its exact tests
    // (distance under the clearance and a proper crossing both imply overlapping bounds; EPS covers rounding).
    const railClearR = ROUTE.railInset * 0.5;
    const wallBox = new Float64Array(cityWalls.length * 4);
    cityWalls.forEach(([a, b], i) => {
      wallBox[i * 4] = Math.min(a.x, b.x) - railClearR - 1e-6;
      wallBox[i * 4 + 1] = Math.max(a.x, b.x) + railClearR + 1e-6;
      wallBox[i * 4 + 2] = Math.min(a.z, b.z) - railClearR - 1e-6;
      wallBox[i * 4 + 3] = Math.max(a.z, b.z) + railClearR + 1e-6;
    });
    /** Whether the point p comes within the rail clearance of a city wall, or the step prev -> p crosses one. */
    const touchesCityWall = (prev: Vec2 | null, p: Vec2): boolean => {
      const sMinX = prev ? Math.min(prev.x, p.x) : p.x;
      const sMaxX = prev ? Math.max(prev.x, p.x) : p.x;
      const sMinZ = prev ? Math.min(prev.z, p.z) : p.z;
      const sMaxZ = prev ? Math.max(prev.z, p.z) : p.z;
      for (let i = 0; i < cityWalls.length; i++) {
        if (sMaxX < wallBox[i * 4] || sMinX > wallBox[i * 4 + 1] || sMaxZ < wallBox[i * 4 + 2] || sMinZ > wallBox[i * 4 + 3]) continue;
        const [a, b] = cityWalls[i];
        if (distToSegment(p.x, p.z, a.x, a.z, b.x, b.z) < railClearR || (prev && segmentsCross(prev, p, a, b))) return true;
      }
      return false;
    };
    const nearProps = props.filter((q) => abs(q.x - P.x) < 70 && abs(q.z - P.z) < 70);
    let best: { pts: Vec2[]; nrm: Vec2[]; score: number } | null = null;
    let grew = false;
    // Crosswalk bends are dropped again if they would bring the rail near a city wall.
    let bends = true;
    let bent = false;

    let pts: Vec2[] = [];
    let nrm: Vec2[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const T = R * tanHalf;
      const reach = Math.max(T + 1, Math.min(ROUTE.railReach + (eIn.width + eOut.width) * 0.4, maxReach));
      // A ramp has its own trench walls: the rail ends at the corner instead of running down it.
      const reachIn = isChannelEdge(eIn) ? T + 0.5 : reach;
      const reachOut = isChannelEdge(eOut) ? T + 0.5 : reach;
      const T1 = { x: V.x - din.x * T, z: V.z - din.z * T };
      const T2 = { x: V.x + dout.x * T, z: V.z + dout.z * T };
      // Fillet center: R inside the incoming line (toward P).
      const O = { x: T1.x - oin.x * R, z: T1.z - oin.z * R };
      pts = [];
      nrm = [];
      // Dense samples with the outward (away from the track) normal of the path.
      const run = (p0: Vec2, d: Vec2, len: number, o: Vec2, last: boolean) => {
        const k = Math.max(1, Math.ceil(len / step));
        for (let j = 0; j < k + (last ? 1 : 0); j++) {
          pts.push({ x: p0.x + (d.x * len * j) / k, z: p0.z + (d.z * len * j) / k });
          nrm.push(o);
        }
      };
      run({ x: V.x - din.x * reachIn, z: V.z - din.z * reachIn }, din, reachIn - T, oin, false);
      const a0 = atan2(T1.z - O.z, T1.x - O.x);
      const sweep = wrapAngle(atan2(T2.z - O.z, T2.x - O.x) - a0);
      const arcSteps = Math.max(2, Math.ceil((R * abs(sweep)) / step));
      for (let k = 0; k < arcSteps; k++) {
        const a = a0 + (sweep * k) / arcSteps;
        const ca = cos(a);
        const sa = sin(a);
        pts.push({ x: O.x + ca * R, z: O.z + sa * R });
        nrm.push({ x: ca, z: sa });
      }
      run(T2, dout, reachOut - T, oout, true);

      // Closed side streets on the outside: where the rail would run over a crosswalk, bend
      // it smoothly back behind the stripes (never forward, which would eat the runoff).
      const shift = new Float64Array(pts.length);
      bent = false;
      for (const eid of bends ? outside : []) {
        const e = g.edges[eid];
        // Alleys are cobbled with no crosswalk stripes, and their sidewalks are too narrow for a gentle
        // bend to stay inside the corridor: the rail runs straight across a closed alley's mouth.
        if (e.kind === 'alley' || e.kind === 'backAlley') continue;
        const m = mouths[eid];
        const ca = id === e.a ? m.aP.curb : m.bP.curb;
        const cb = id === e.a ? m.aN.curb : m.bN.curb;
        const mx = (ca.x + cb.x) / 2;
        const mz = (ca.z + cb.z) / 2;
        const far = g.nodes[otherNode(e, id)];
        const dl = sqrt((far.x - P.x) ** 2 + (far.z - P.z) ** 2) || 1;
        const dx = (far.x - P.x) / dl;
        const dz = (far.z - P.z) / dl;
        const half = e.width / 2 + 0.3;
        // Long enough to stay gentle (narrow alley sidewalks included).
        const ramp = Math.max(2.5, (e.sidewalk ?? CITY.sidewalk) - 0.8);
        let minA = Infinity;
        let maxA = -Infinity;
        let nd = 0;
        let nc = 0;
        for (let k = 0; k < pts.length; k++) {
          const rx = pts[k].x - mx;
          const rz = pts[k].z - mz;
          const along = rx * dx + rz * dz;
          if (along < -4 || along > cwEnd + 6 || abs(rx * dz - rz * dx) > half) continue;
          minA = Math.min(minA, along);
          maxA = Math.max(maxA, along);
          nd += nrm[k].x * dx + nrm[k].z * dz;
          nc++;
        }
        if (!nc || maxA < ROUTE.railCrosswalkStart - clear || minA > cwEnd + clear) continue;
        nd /= nc;
        if (nd < 0.3) continue;
        const amount = (cwEnd + clear - minA) / nd;
        if (amount > ROUTE.railMaxBend) continue;
        bent = true;
        for (let k = 0; k < pts.length; k++) {
          const rx = pts[k].x - mx;
          const rz = pts[k].z - mz;
          // Cosine ramps (gentlest curvature for the depth); bends of neighboring streets add up.
          const w = (1 - cosStep(half, half + ramp, abs(rx * dz - rz * dx))) * cosStep(-8, -4, rx * dx + rz * dz);
          shift[k] += amount * w;
        }
      }
      for (let k = 0; k < pts.length; k++) {
        if (shift[k] !== 0) pts[k] = { x: pts[k].x + nrm[k].x * shift[k], z: pts[k].z + nrm[k].z * shift[k] };
      }

      // Keep clear of the city walls around the corner (widen the fillet if it is not) and of
      // street furniture (tighten a junction fillet that sweeps over a corner traffic light).
      let ok = true;
      for (let k = 0; k < pts.length && ok; k++) if (touchesCityWall(k > 0 ? pts[k - 1] : null, pts[k])) ok = false;
      // A bend must also stay inside the road corridor: on an alley's narrow sidewalk it would
      // otherwise push the rail past the building line.
      for (let k = 0; k < pts.length && ok; k++) if (shift[k] !== 0 && corridorClearance(g, edgeGrid, pts[k].x, pts[k].z, gridScratch) > ROUTE.railCorridorSlack) ok = false;
      // Only furniture by the fillet counts here (tightening it cannot help anywhere else).
      let propHits = 0;
      const reachV = R * tanHalf + 3;
      for (const q of nearProps) {
        if ((q.x - V.x) ** 2 + (q.z - V.z) ** 2 > reachV * reachV) continue;
        const r2 = (q.radius + ROUTE.railPropClear) ** 2;
        for (let k = 0; k < pts.length; k++) {
          if ((pts[k].x - q.x) ** 2 + (pts[k].z - q.z) ** 2 < r2) {
            propHits++;
            break;
          }
        }
      }
      const score = ok ? propHits : 1e6;
      if (!best || score < best.score) best = { pts, nrm, score };
      if (ok && propHits === 0) break;
      if (!ok && bent) {
        bends = false;
        continue;
      }
      if (!ok) {
        if (R >= rMax) break;
        R = Math.min(rMax, R * 1.3);
        grew = true;
      } else {
        if (grew || !outside.length || R <= 3) break;
        R = Math.max(3, R * 0.75);
      }
    }
    // No fillet clear of the city walls around the corner (a planter strip right at the back of the
    // sidewalk, say): no rail rather than one through a wall.
    if (best!.score >= 1e6) continue;
    pts = best!.pts;
    nrm = best!.nrm;
    // A fillet widened past the sidewalk line (an opened corner pocket on the outside of the turn
    // leaves it nothing to hug) would stand in the pocket's clutter: no rail is better there, the
    // pocket's own back wall is the stop.
    if (pts.some((q) => corridorClearance(g, edgeGrid, q.x, q.z, gridScratch) > ROUTE.railCorridorSlack)) continue;

    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + sqrt((pts[k].x - pts[k - 1].x) ** 2 + (pts[k].z - pts[k - 1].z) ** 2));
    // Any prop still too close (furniture just inside a closed street, behind the rail): ease the
    // rail away from it with a short smooth bend, toward the track if the prop is behind.
    {
      for (const q of nearProps) {
        let kBest = -1;
        let dBest = Infinity;
        for (let k = 0; k < pts.length; k++) {
          const d = (pts[k].x - q.x) ** 2 + (pts[k].z - q.z) ** 2;
          if (d < dBest) {
            dBest = d;
            kBest = k;
          }
        }
        const dist = sqrt(dBest);
        const need = q.radius + ROUTE.railPropClear - dist;
        if (kBest < 0 || need <= 0) continue;
        const behind = (q.x - pts[kBest].x) * nrm[kBest].x + (q.z - pts[kBest].z) * nrm[kBest].z > 0;
        const s0 = cum[kBest];
        const span = ROUTE.railPieceLength * 2.4;
        // The bent path, or null where it would come near or cross a city wall.
        const bend = (amount: number): Vec2[] | null => {
          const bentPts = pts.map((pt, k) => {
            const w = 1 - cosStep(span * 0.25, span, abs(cum[k] - s0));
            return w > 0 ? { x: pt.x + nrm[k].x * amount * w, z: pt.z + nrm[k].z * amount * w } : pt;
          });
          for (let k = 0; k < pts.length; k++) {
            if (bentPts[k] === pts[k]) continue;
            if (touchesCityWall(k > 0 ? bentPts[k - 1] : null, bentPts[k])) return null;
          }
          return bentPts;
        };
        // Away from the prop: back toward the track if it is behind, outward if in front. A lamp post in front
        // on a sidewalk too narrow to pass behind it (an alley's) is dodged on the track side instead, so it
        // ends up behind the rail; anything else a rail cannot avoid starts the race removed (world.ts).
        const bent = bend(behind ? -need - 0.05 : need + 0.05) ?? (!behind && q.kind === 'streetlight' ? bend(-(dist + q.radius + ROUTE.railPropClear + 0.05)) : null);
        if (bent) pts = bent;
      }
      for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + sqrt((pts[k].x - pts[k - 1].x) ** 2 + (pts[k].z - pts[k - 1].z) ** 2);
    }

    // A run that reaches a city wall further along the street (a channel side ramp's trench end at a T
    // just past the corner, likely on the curved grid's skewed blocks) is cut short before it.
    {
      const crossesCity = (k: number) => {
        const p = pts[k - 1];
        const q = pts[k];
        const sMinX = Math.min(p.x, q.x);
        const sMaxX = Math.max(p.x, q.x);
        const sMinZ = Math.min(p.z, q.z);
        const sMaxZ = Math.max(p.z, q.z);
        for (let i = 0; i < cityWalls.length; i++) {
          if (sMaxX < wallBox[i * 4] || sMinX > wallBox[i * 4 + 1] || sMaxZ < wallBox[i * 4 + 2] || sMinZ > wallBox[i * 4 + 3]) continue;
          if (segmentsCross(p, q, cityWalls[i][0], cityWalls[i][1])) return true;
        }
        return false;
      };
      const mid = pts.length >> 1;
      let lo = 0;
      let hi = pts.length - 1;
      for (let k = mid; k >= 1; k--) if (crossesCity(k)) { lo = k; break; }
      for (let k = mid + 1; k < pts.length; k++) if (crossesCity(k)) { hi = k - 1; break; }
      if (lo > 0 || hi < pts.length - 1) {
        pts = pts.slice(lo, hi + 1);
        nrm = nrm.slice(lo, hi + 1);
        cum.length = 0;
        cum.push(0);
        for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + sqrt((pts[k].x - pts[k - 1].x) ** 2 + (pts[k].z - pts[k - 1].z) ** 2));
        if (pts.length < 2) continue;
      }
    }
    // Cut the path into pieces of equal length, each made of a few straight sub segments.
    const total = cum[cum.length - 1];
    if (total < 1) continue;
    // Heading of each sample segment, for the turn inside a piece.
    const head: number[] = [];
    for (let k = 1; k < pts.length; k++) head.push(atan2(pts[k].z - pts[k - 1].z, pts[k].x - pts[k - 1].x));
    const at = (s: number): { p: Vec2; k: number } => {
      const lo = segmentAt(cum, s);
      const u = clamp((s - cum[lo]) / (cum[lo + 1] - cum[lo] || 1), 0, 1);
      return { p: { x: pts[lo].x + (pts[lo + 1].x - pts[lo].x) * u, z: pts[lo].z + (pts[lo + 1].z - pts[lo].z) * u }, k: lo };
    };
    const count = Math.max(1, Math.round(total / ROUTE.railPieceLength));
    const pieceLen = total / count;
    let prev = pts[0];
    let prevS = 0;
    for (let p = 0; p < count; p++) {
      const s0 = p * pieceLen;
      const s1 = p === count - 1 ? total : (p + 1) * pieceLen;
      // Sub segment ends: wherever the path has turned railMaxSubDeg since the last one.
      const ends: { p: Vec2; s: number }[] = [];
      let turned = 0;
      for (let k = at(s0).k + 1; k < pts.length - 1 && cum[k] < s1 - 0.05; k++) {
        turned += abs(wrapAngle(head[k] - head[k - 1]));
        if (cum[k] > s0 + 0.05 && turned >= ROUTE.railMaxSubDeg * DEG) {
          ends.push({ p: pts[k], s: cum[k] });
          turned = 0;
        }
      }
      ends.push({ p: p === count - 1 ? pts[pts.length - 1] : at(s1).p, s: s1 });
      for (const q of ends) {
        // Normal toward the drivable side: inward of the path normal at the segment middle.
        const o = nrm[at((prevS + q.s) / 2).k];
        const w = makeWall(prev, q.p, { x: (prev.x + q.p.x) / 2 - o.x, z: (prev.z + q.p.z) / 2 - o.z }, 'rail');
        if (!w) continue;
        walls.push({ ...w, kind: 'rail', group: rail, piece });
        prev = q.p;
        prevS = q.s;
      }
      piece++;
    }
    rail++;
  }
  return walls;
}
