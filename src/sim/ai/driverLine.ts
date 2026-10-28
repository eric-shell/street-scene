/**
 * A rival's own line. The race's shared line (racingLine.ts) hangs off the centerline, whose normals swing
 * round a node in one sample, so no line could sweep through a corner on it. sweepFrame builds the frame the
 * drivers' lines are solved in instead (the centerline rounded through its corners, with the road's bounds
 * measured along the rounded normals); driverLine solves one driver's line in it, a minimum curvature sweep
 * through every corner shaped by the driver's width, side, apex, wander and corner cutting; driverDetours
 * lays the paths down the route's shortcuts (the alley and any jump exit) the driver may take some laps.
 */
import type { RoadGraph } from '../../city/roadGraph';
import type { Route } from '../../city/route';
import { CITY } from '../../city/config';
import { TAU, type Vec2, abs, clamp, exp, lerp, sin, sqrt, wrapIndex } from '../math';
import { AI, DRIVER, type Driver } from './drivers';
import { type RacingLine, bendAt, lineNormals, speedProfile } from './racingLine';

/** The race's sweep frame (sweepFrame): its road bounds, and the bounds a full corner cutter may use (DRIVER.cutRoom wider on the inside of a bend, where no lane closure narrows them). */
export interface SweepFrame extends RacingLine {
  cutLo: Float64Array;
  cutHi: Float64Array;
}

/**
 * A route shortcut as one driver takes it (driverDetours): off its line
 * before the alley's entry, down the alley and over any jump exit, back onto
 * its line past the exit.
 */
export interface Detour {
  /** Samples of the driver's line where it turns off and where it is back on. */
  from: number;
  to: number;
  /** The path, sampled like a racing line on its own middle (the alley leaves no room to pass), at this driver's speeds. */
  line: RacingLine;
}

/**
 * The frame the drivers' own lines are solved in (driverLine). The shared
 * line's offsets hang off the centerline polyline, whose normals swing round
 * a node in one sample: offsets to the inside of a corner fold over each
 * other there, so no line could sweep through it. This frame's reference is
 * the centerline rounded by a gaussian along the route (kept inside the
 * shared line's bounds), and its bounds are measured along the rounded
 * normals: as far either way as the point stays inside the shared bounds of a
 * nearby stretch of centerline (their room and lane closures) or round one of
 * its sample points (the outside of a corner), and to the inside of a bend no
 * further than most of its radius; the corner cutters' bounds the same with
 * the road's edges let out (onRoad). Built once per race; the line itself is
 * left on the reference.
 */
export function sweepFrame(base: RacingLine): SweepFrame {
  const { n, closed } = base;
  const wrap = (i: number): number => wrapIndex(i, n, closed);
  const step = n > 1 ? base.s[1] - base.s[0] : AI.spacing;
  const sigma = DRIVER.frameSigma / step;
  const reach = Math.ceil(3 * sigma);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sz = 0;
    let sw = 0;
    for (let k = -reach; k <= reach; k++) {
      const w = exp((-k * k) / (2 * sigma * sigma));
      const j = wrap(i + k);
      sx += w * base.cx[j];
      sz += w * base.cz[j];
      sw += w;
    }
    // Kept inside the shared bounds across the road (an alley's are next to nothing), free along it.
    const dx = sx / sw - base.cx[i];
    const dz = sz / sw - base.cz[i];
    const lat = dx * base.nx[i] + dz * base.nz[i];
    const keep = clamp(lat, Math.min(0, base.lo[i]), Math.max(0, base.hi[i])) - lat;
    cx[i] = base.cx[i] + dx + base.nx[i] * keep;
    cz[i] = base.cz[i] + dz + base.nz[i] * keep;
  }
  const { nx, nz } = lineNormals(cx, cz, closed);
  const frame: SweepFrame = { ...base, x: cx, z: cz, cx, cz, nx, nz, lo: new Float64Array(n), hi: new Float64Array(n), room: new Float64Array(n), offset: new Float64Array(n), cutLo: new Float64Array(n), cutHi: new Float64Array(n) };
  // The shared bounds, and a corner cutter's: the road's edges let out by DRIVER.cutRoom, or a share
  // of the room on a narrow street; a lane closure's side stays put.
  const out = (i: number): number => Math.min(DRIVER.cutRoom, DRIVER.cutShare * Math.max(0, base.room[i]));
  const bounds = [
    { lo: base.lo, hi: base.hi },
    { lo: base.lo.map((v, i) => (v <= -base.room[i] ? v - out(i) : v)), hi: base.hi.map((v, i) => (v >= base.room[i] ? v + out(i) : v)) },
  ];
  for (let i = 0; i < n; i++) {
    const bend = bendAt(frame, i);
    for (const cut of [0, 1]) {
      for (const side of [1, -1]) {
        // A cutter's extra room is only on the inside of a bend; elsewhere its bounds are the frame's.
        if (cut && bend * side < DRIVER.cutBend) {
          if (side > 0) frame.cutHi[i] = frame.hi[i];
          else frame.cutLo[i] = frame.lo[i];
          continue;
        }
        // Bisect for the last point on the road along the normal (the reference itself is on it).
        let inn = 0;
        let out: number = DRIVER.frameReach;
        for (let it = 0; it < DRIVER.frameSteps; it++) {
          const o = (inn + out) / 2;
          if (onRoad(base, bounds[cut].lo, bounds[cut].hi, cx[i] + nx[i] * o * side, cz[i] + nz[i] * o * side, i)) inn = o;
          else out = o;
        }
        // The inside of a bend: offsets past its radius would fold over.
        if (bend * side > 0) inn = Math.min(inn, DRIVER.frameFold / abs(bend));
        if (side > 0) (cut ? frame.cutHi : frame.hi)[i] = inn;
        else (cut ? frame.cutLo : frame.lo)[i] = -inn;
      }
    }
    frame.room[i] = Math.min(frame.hi[i], -frame.lo[i]);
  }
  return frame;
}

/**
 * On the shared line's road near sample j, within bounds lo / hi (offsets
 * from its centerline): inside those of one of the centerline's stretches
 * within DRIVER.frameWindow samples, or round one of its sample points within
 * the tighter of its neighbours' bounds on that side (which fills the outside
 * of a corner, and keeps out of a lane closure).
 */
function onRoad(base: RacingLine, lo: Float64Array, hi: Float64Array, x: number, z: number, j: number): boolean {
  const { n, closed, cx, cz } = base;
  const wrap = (i: number): number => wrapIndex(i, n, closed);
  for (let k = -DRIVER.frameWindow; k <= DRIVER.frameWindow; k++) {
    const a = wrap(j + k);
    const b = wrap(a + 1);
    const rx = x - cx[a];
    const rz = z - cz[a];
    const dx = cx[b] - cx[a];
    const dz = cz[b] - cz[a];
    const len2 = dx * dx + dz * dz;
    if (len2 > 1e-9 && (closed || a < n - 1)) {
      const u = (rx * dx + rz * dz) / len2;
      const lat = (rx * dz - rz * dx) / sqrt(len2);
      if (u >= 0 && u <= 1 && lat >= lerp(lo[a], lo[b], u) && lat <= lerp(hi[a], hi[b], u)) return true;
    }
    const p = wrap(a - 1);
    const left = len2 > 1e-9 ? rx * dz - rz * dx >= 0 : true;
    const r = left ? Math.min(hi[p], hi[a], hi[b]) : -Math.max(lo[p], lo[a], lo[b]);
    if (r > 0 && rx * rx + rz * rz <= r * r) return true;
  }
  return false;
}

/**
 * One driver's own line, solved in the race's sweep frame (sweepFrame). Its
 * road runs out to the frame's bounds or, as far as it cuts corners, the
 * cutters'; its band is the share of that road it uses, around the middle.
 * It wants its favoured side plus its wander, and a minimum curvature solve
 * (sweep) bends the line through every corner's outside-inside-outside within
 * the band, pulled gently toward what it wants on the straights. An apex
 * shift slides the sweeps along the route. Corner speeds and braking points
 * come from its own grip and braking. Shares the samples, reference and
 * normals; its bounds are its road.
 */
export function driverLine(base: SweepFrame, d: Readonly<Driver>): RacingLine {
  const { n, closed } = base;
  const lo = base.lo.map((v, i) => lerp(v, base.cutLo[i], d.cut));
  const hi = base.hi.map((v, i) => lerp(v, base.cutHi[i], d.cut));
  const step = n > 1 ? base.s[1] - base.s[0] : AI.spacing;
  const length = closed ? n * step : base.s[n - 1];
  // A circuit's wander fits whole waves round the lap, so the line closes on itself.
  const waves = closed ? Math.max(1, Math.round(length / d.wavelength)) : length / d.wavelength;
  const k = (TAU * waves) / Math.max(length, 1);
  const amp = Math.min(d.wander, DRIVER.wanderBend / (k * k));
  const blo = new Float64Array(n);
  const bhi = new Float64Array(n);
  const want = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const mid = (lo[i] + hi[i]) / 2;
    const half = (Math.max(0, hi[i] - lo[i]) / 2) * d.width;
    blo[i] = mid - half;
    bhi[i] = mid + half;
    want[i] = mid + d.side * DRIVER.side * half + amp * sin(k * base.s[i] + d.phase);
  }
  const off = new Float64Array(n);
  for (let i = 0; i < n; i++) off[i] = clamp(want[i], blo[i], bhi[i]);
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  for (const level of DRIVER.levels) sweep(base, blo, bhi, want, off, px, pz, level.stride, level.iterations);
  // Early or late apex: the whole sweep slides along the route, then settles back inside the band.
  const shift = d.apex / step;
  if (shift !== 0) {
    const src = Float64Array.from(off);
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const f = i - shift;
      const j = Math.floor(f);
      const a = wrapIndex(j, n, closed);
      const b = wrapIndex(j + 1, n, closed);
      off[i] = clamp(lerp(src[a], src[b], f - j), blo[i], bhi[i]);
    }
    sweep(base, blo, bhi, want, off, px, pz, 1, DRIVER.apexIterations);
  }
  const speed = speedProfile(n, closed, px, pz, AI.lateralGrip * d.grip, AI.brakeDecel * d.braking);
  return { n, closed, s: base.s, cx: base.cx, cz: base.cz, nx: base.nx, nz: base.nz, room: base.room, lo, hi, x: px, z: pz, offset: off, speed };
}

/**
 * Minimum curvature offsets inside [blo, bhi], pulled toward `want`: projected
 * Gauss-Seidel on the squared second differences of every `stride`th sample
 * (the in-between samples follow linearly), each pass moving a point to where
 * its bend is least along its normal. Coarse strides settle a corner's whole
 * outside-inside-outside sweep in a few hundred passes, where the samples
 * alone would take thousands; the pull is scaled by stride^4 so every level
 * weighs it against the same bend. Writes off, px and pz.
 */
function sweep(base: RacingLine, blo: Float64Array, bhi: Float64Array, want: Float64Array, off: Float64Array, px: Float64Array, pz: Float64Array, stride: number, iterations: number): void {
  const { n, closed, cx, cz, nx, nz } = base;
  const m = closed ? Math.floor(n / stride) : Math.floor((n - 1) / stride) + 1;
  const at = (j: number): number => wrapIndex(j, m, closed) * stride;
  const w = DRIVER.pull * stride ** 4;
  const h = (base.s[n - 1] - base.s[0]) / Math.max(1, n - 1) * stride;
  for (let j = 0; j < m; j++) {
    const i = j * stride;
    px[i] = cx[i] + nx[i] * off[i];
    pz[i] = cz[i] + nz[i] * off[i];
  }
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < m; j++) {
      if (!closed && (j === 0 || j === m - 1)) continue;
      const i = j * stride;
      const a2 = at(j - 2);
      const a1 = at(j - 1);
      const b1 = at(j + 1);
      const b2 = at(j + 2);
      // The bends across the line at a1, i and b1 (second differences along the normals there) are
      // linear in the offset o: A + k o. Each is weighed as curvature squared over its length, the
      // spacings either side as they stand (samples bunch on the inside of a bend, where a second
      // difference undercounts the curvature). o takes the least weighted sum plus the pull.
      const la = sqrt((px[a1] - px[a2]) ** 2 + (pz[a1] - pz[a2]) ** 2);
      const li = sqrt((px[i] - px[a1]) ** 2 + (pz[i] - pz[a1]) ** 2);
      const lb = sqrt((px[b1] - px[i]) ** 2 + (pz[b1] - pz[i]) ** 2);
      const lc = sqrt((px[b2] - px[b1]) ** 2 + (pz[b2] - pz[b1]) ** 2);
      const wa = bendWeight(la, li, h);
      const wi = bendWeight(li, lb, h);
      const wb = bendWeight(lb, lc, h);
      const ea = (px[a2] - 2 * px[a1] + cx[i]) * nx[a1] + (pz[a2] - 2 * pz[a1] + cz[i]) * nz[a1];
      const ei = (px[a1] - 2 * cx[i] + px[b1]) * nx[i] + (pz[a1] - 2 * cz[i] + pz[b1]) * nz[i];
      const eb = (cx[i] - 2 * px[b1] + px[b2]) * nx[b1] + (cz[i] - 2 * pz[b1] + pz[b2]) * nz[b1];
      const ka = nx[i] * nx[a1] + nz[i] * nz[a1];
      const kb = nx[i] * nx[b1] + nz[i] * nz[b1];
      const o = clamp((2 * wi * ei - wa * ka * ea - wb * kb * eb + w * want[i]) / (wa * ka * ka + wb * kb * kb + 4 * wi + w), blo[i], bhi[i]);
      off[i] = o;
      px[i] = cx[i] + nx[i] * o;
      pz[i] = cz[i] + nz[i] * o;
    }
  }
  // The samples between follow linearly, kept inside the band.
  for (let j = 0; j < m; j++) {
    const i0 = j * stride;
    const last = j === m - 1;
    const i1 = last ? (closed ? n : n - 1) : i0 + stride;
    const o1 = last && closed ? off[0] : off[Math.min(i1, n - 1)];
    for (let i = i0 + 1; i < i1 && i < n; i++) off[i] = clamp(lerp(off[i0], o1, (i - i0) / (i1 - i0)), blo[i], bhi[i]);
  }
  for (let i = 0; i < n; i++) {
    px[i] = cx[i] + nx[i] * off[i];
    pz[i] = cz[i] + nz[i] * off[i];
  }
}

/**
 * A driver's detours, one per route shortcut its line reaches: along its line
 * from DRIVER.detourLead before the alley's entry, off it to the entry (the
 * route's middle at the junction), down the alley's path, out of the exit
 * (over a jump exit's lip the flight carries on along the last leg), and back
 * along its line to DRIVER.detourRejoin past the exit; sampled every
 * AI.spacing. Speeds come
 * from the path's curvature at the driver's grip and braking, held to
 * DRIVER.alleySpeed down the alley, and a jump exit's run-up to the launch
 * speeds its landing was planned for (the last bend at bendSpeed, then
 * launchAccel to the lip), so the car comes down on the street.
 */
export function driverDetours(line: RacingLine, route: Route, graph: RoadGraph, d: Readonly<Driver>): Detour[] {
  const { n, closed } = line;
  const step = n > 1 ? line.s[1] - line.s[0] : AI.spacing;
  const wrap = (i: number): number => wrapIndex(i, n, closed);
  const sample = (s: number): number => (closed ? wrap(Math.round(s / step)) : s < 0 || s > line.s[n - 1] ? -1 : Math.round(s / step));
  const J = CITY.districts.backAlley.route.jump;
  const out: Detour[] = [];
  // The harbor's quay cuts after the alleys: a seed without one keeps its drivers' draws as they were.
  for (const sc of route.shortcuts.concat(route.quayCuts)) {
    const from = sample(sc.sIn - DRIVER.detourLead);
    const turn = sample(sc.sIn - DRIVER.detourTurn);
    const back = sample(sc.sOut + DRIVER.detourTurn);
    const to = sample(sc.sOut + DRIVER.detourRejoin);
    if (from < 0 || turn < 0 || back < 0 || to < 0 || sc.points.length < 2) continue;
    const pts: Vec2[] = [];
    const along = (a: number, b: number): void => {
      for (let i = a, k = 0; k <= n; i = wrap(i + 1), k++) {
        pts.push({ x: line.x[i], z: line.z[i] });
        if (i === b) break;
      }
    };
    along(from, turn);
    const entry = pts.length;
    for (const q of sc.points) pts.push({ x: q.x, z: q.z });
    const exit = pts.length - 1;
    along(back, wrap(to + 2));
    // Every AI.spacing along it; the alley's span and its last bend, as distances along it.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const m = Math.max(2, Math.ceil(cum[pts.length - 1] / AI.spacing) + 1);
    const x = new Float64Array(m);
    const z = new Float64Array(m);
    const ds = new Float64Array(m);
    let leg = 0;
    for (let i = 0; i < m; i++) {
      const t = Math.min(cum[pts.length - 1], (i * cum[pts.length - 1]) / (m - 1));
      while (leg + 2 < pts.length && t > cum[leg + 1]) leg++;
      const f = (t - cum[leg]) / Math.max(1e-9, cum[leg + 1] - cum[leg]);
      x[i] = lerp(pts[leg].x, pts[leg + 1].x, f);
      z[i] = lerp(pts[leg].z, pts[leg + 1].z, f);
      ds[i] = t;
    }
    // Round the turns in and out within the street; the alley's middle and its own line either side stay put.
    for (let it = 0; it < DRIVER.mouthPasses; it++) {
      for (let i = 1; i < m - 1; i++) {
        const mouth = (ds[i] > cum[entry] - DRIVER.mouthOut && ds[i] < cum[entry] + DRIVER.mouthIn) || (ds[i] > cum[exit] - DRIVER.mouthIn && ds[i] < cum[exit] + DRIVER.mouthOut);
        if (!mouth) continue;
        x[i] = (x[i - 1] + x[i + 1]) / 2;
        z[i] = (z[i - 1] + z[i + 1]) / 2;
      }
    }
    const nx = new Float64Array(m);
    const nz = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(m - 1, i + 1);
      const l = Math.hypot(x[b] - x[a], z[b] - z[a]) || 1;
      nx[i] = (z[b] - z[a]) / l;
      nz[i] = -(x[b] - x[a]) / l;
    }
    const speed = speedProfile(m, false, x, z, AI.lateralGrip * d.grip, AI.brakeDecel * d.braking);
    const jump = graph.edges[sc.edges[sc.edges.length - 1]]?.jumpExit === true;
    const bend = cum[Math.max(entry, exit - 1)];
    for (let i = 0; i < m; i++) {
      if (ds[i] < cum[entry] || ds[i] > cum[exit]) continue;
      speed[i] = Math.min(speed[i], DRIVER.alleySpeed);
      if (jump && ds[i] >= bend) speed[i] = Math.min(speed[i], sqrt(J.bendSpeed * J.bendSpeed + 2 * J.launchAccel * (ds[i] - bend)));
    }
    // Braking for those caps too.
    for (let i = m - 2; i >= 0; i--) speed[i] = Math.min(speed[i], sqrt(speed[i + 1] * speed[i + 1] + 2 * AI.brakeDecel * d.braking * (ds[i + 1] - ds[i])));
    const room = new Float64Array(m).fill(DRIVER.detourRoom);
    out.push({ from, to, line: { n: m, closed: false, x, z, s: ds, cx: x, cz: z, nx, nz, room, lo: room.map((v) => -v), hi: room, offset: new Float64Array(m), speed } });
  }
  return out;
}

/**
 * Weight of a second difference between spacings l1 and l2 (m) against one
 * between even spacings h: it measures curvature times l1 l2, and the bend
 * costs curvature squared over (l1 + l2) / 2. Capped either way.
 */
function bendWeight(l1: number, l2: number, h: number): number {
  const ll = Math.max(l1 * l2, 1e-6);
  return clamp((h * h * h * (l1 + l2)) / (2 * ll * ll), 0.05, 20);
}
