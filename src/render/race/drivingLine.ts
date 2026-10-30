/**
 * The driving line: a suggested racing line drawn on the road at the corners only, a driving aid like the line in
 * Forza or Gran Turismo. It follows the AI's smoothed shared line (race.line, the apexes, not the road's centre),
 * and shows only where the player has to slow for a bend: one segment per corner that fades in on the approach and
 * out at the exit, so the straights stay clean.
 *
 * Colour says what to do with the speed. Each sample has a target speed for THIS car (planCorners: the line's
 * curvature at the car's own measured grip, then a backward braking pass at its own measured brake, both a
 * comfortable share of the limit so the line asks for what a player can hold). The ribbon is red where the car is
 * faster than that target (brake), green where it is slower (gas), white about right. Because the braking pass is
 * in the target, a corner reads green on the way in, turns white and then red at the braking point, and green
 * again as the exit opens up.
 *
 * One draw call: a triangle strip hung off the line's samples at the road's own height, vertex colours in the
 * wash material (additive, fading to nothing in fog). The corners and their fades are planned once; per frame
 * only the colours of the samples in a window ahead of the car are written, and only that range is uploaded.
 * Render only reads the race; the pure pieces (planCorners) are exported so the plan can be measured headlessly.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { RacingLine } from '../../sim/ai/racingLine';
import { lineNormals, nearestIdx, speedProfile } from '../../sim/ai/racingLine';
import { AI } from '../../sim/ai/drivers';
import { smoothstep } from '../../sim/math';
import type { DriveLimits } from '../../sim/stats';
import { damp } from '../../shared/anim';
import { Disposer } from '../disposer';
import { washMaterial } from '../materialFx';

/** The line's look and what counts as a corner. Distances in m, speeds in m/s, shares 0..1. */
export const LINE = {
  /** Share of the car's measured lateral grip and brake the targets are drawn at: the line asks for what a player can hold, not the limit. */
  gripUse: 0.85,
  brakeUse: 0.8,
  /** A sample is part of a corner where its target is under this share of the straight speed (the profile's fastest, capped at the car's top speed). */
  cornerShare: 0.5,
  /** Corners closer than this (m) are one segment, so an S-bend does not flicker in and out. */
  mergeGap: 40,
  /** Fade in over this far before a corner's first slow sample and out over this far past its last. */
  fadeIn: 28,
  fadeOut: 16,
  /** The last stretch (m) inside a corner that already fades, so the exit does not end on a hard edge. */
  fadeOutInside: 8,
  /** Samples drawn ahead of the car (m) and behind it (m, fading to nothing). */
  ahead: 350,
  behind: 12,
  /** The last stretch (m) of the window ahead that fades, so it does not end on a cut. */
  farFade: 40,
  /** Ribbon width (m) with and without the soft edge, and how far above the road it floats. */
  width: 1.9,
  widthLow: 1.2,
  lift: 0.05,
  /** Brightness of the colours (additive over the road). */
  glow: 0.85,
  /** Speed difference (share of the speed, floor in m/s) the colour needs to leave white, and the span over which it blends to full. */
  margin: 0.06,
  marginFloor: 1.5,
  blend: 1.2,
  /** Rate (1/s) the speed the colours compare against is smoothed at, so a bump or a gear change does not flicker the line. */
  speedRate: 10,
  /** A car further than this (m) from its remembered sample is searched for over the whole line again (a reset, a tow). */
  lostDistance: 30,
} as const;

const RED = [1, 0.1, 0.08] as const;
const WHITE = [0.92, 0.94, 1] as const;
const GREEN = [0.12, 1, 0.3] as const;

/** Where the corners are on a line and how visible each sample is. */
export interface CornerPlan {
  /** The player's target speed (m/s) at each sample. */
  target: Float32Array;
  /** 0..1: how much of the line shows at each sample (the corners' fades; 0 on the straights). */
  alpha: Float32Array;
  /** Corners found (after merging). */
  corners: number;
}

/**
 * Target speeds for a car with `limits` on `line`, and the corner fades. `topSpeed` (m/s) caps the targets: a
 * straight is not a place to slow for, and a target above what the car can reach would only ever read green.
 */
export function planCorners(line: RacingLine, limits: DriveLimits, topSpeed: number): CornerPlan {
  const { n, closed } = line;
  const raw = speedProfile(n, closed, line.x, line.z, limits.lateralG * LINE.gripUse, limits.brakeDecel * LINE.brakeUse);
  const target = new Float32Array(n);
  let fastest = 0;
  for (let i = 0; i < n; i++) {
    target[i] = Math.min(raw[i], topSpeed);
    fastest = Math.max(fastest, target[i]);
  }
  const slow = fastest * LINE.cornerShare;
  const alpha = new Float32Array(n);
  const wrap = (i: number) => ((i % n) + n) % n;
  const isSlow = (i: number) => target[wrap(i)] < slow;

  // Runs of slow samples, as [from, to] in unwrapped indices. A closed line starts scanning at a fast sample so no run straddles the seam.
  let start = 0;
  if (closed) {
    start = -1;
    for (let i = 0; i < n; i++) if (!isSlow(i)) start = i;
    if (start < 0) {
      alpha.fill(1);
      return { target, alpha, corners: 1 };
    }
  }
  const runs: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const i = start + k;
    if (!isSlow(i)) continue;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= LINE.mergeGap / AI.spacing) last[1] = i;
    else runs.push([i, i]);
  }
  // A closed line's last run may sit within the merge gap of the first one past the seam.
  if (closed && runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (first[0] + n - last[1] <= LINE.mergeGap / AI.spacing) {
      runs.pop();
      first[0] = last[0] - n;
    }
  }

  const inN = Math.round(LINE.fadeIn / AI.spacing);
  const outN = Math.round(LINE.fadeOut / AI.spacing);
  const insideN = Math.round(LINE.fadeOutInside / AI.spacing);
  for (const [a, b] of runs) {
    for (let i = a - inN; i <= b + outN; i++) {
      if (!closed && (i < 0 || i >= n)) continue;
      let v = 1;
      if (i < a) v = smoothstep(0, 1, (i - (a - inN)) / inN);
      else if (i > b - insideN) v = 1 - smoothstep(0, 1, (i - (b - insideN)) / (insideN + outN));
      const j = wrap(i);
      alpha[j] = Math.max(alpha[j], v);
    }
  }
  return { target, alpha, corners: runs.length };
}

/** The player's driving line, ready to add to a scene. */
export class DrivingLine {
  readonly group = new THREE.Group();
  readonly plan: CornerPlan;
  private readonly owned = new Disposer();
  private readonly line: RacingLine;
  private readonly stride: number;
  /** Per sample, the vertex offsets (within its stride) whose colour moves: the centre of a soft strip, both edges of a hard one. */
  private readonly lit: readonly number[];
  private readonly colors: THREE.BufferAttribute;
  private readonly aheadN: number;
  private readonly behindN: number;
  private readonly farN: number;
  private idx = -1;
  /** The window written last frame: first sample (unwrapped, may be negative on a closed line) and count; -1 = nothing lit. */
  private prevLo = 0;
  private prevCount = 0;
  private speed = -1;

  constructor(world: World, line: RacingLine, limits: DriveLimits, topSpeed: number, soft: boolean) {
    this.line = line;
    this.plan = planCorners(line, limits, topSpeed);
    const { n, closed } = line;
    this.stride = soft ? 3 : 2;
    this.lit = soft ? [1] : [0, 1];
    this.aheadN = Math.min(n - 1, Math.round(LINE.ahead / AI.spacing));
    this.behindN = Math.round(LINE.behind / AI.spacing);
    this.farN = Math.round(LINE.farFade / AI.spacing);

    const { nx, nz } = lineNormals(line.x, line.z, closed);
    const half = (soft ? LINE.width : LINE.widthLow) / 2;
    const pos = new Float32Array(n * this.stride * 3);
    for (let i = 0; i < n; i++) {
      for (let v = 0; v < this.stride; v++) {
        // Soft: left edge, centre, right edge. Hard: left, right.
        const side = this.stride === 3 ? (v - 1) * half : (v === 0 ? -half : half);
        const x = line.x[i] + nx[i] * side;
        const z = line.z[i] + nz[i] * side;
        const o = (i * this.stride + v) * 3;
        pos[o] = x;
        pos[o + 1] = world.heightAt(x, z) + LINE.lift;
        pos[o + 2] = z;
      }
    }
    // Quads only where the corners show: the straights are not even in the draw.
    const idx: number[] = [];
    const quad = (i: number, j: number) => {
      const s = this.stride;
      for (let v = 0; v < s - 1; v++) {
        const a = i * s + v;
        const b = j * s + v;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    };
    const plan = this.plan;
    for (let i = 0; i < n - 1; i++) if (plan.alpha[i] > 0 || plan.alpha[i + 1] > 0) quad(i, i + 1);
    if (closed && (plan.alpha[n - 1] > 0 || plan.alpha[0] > 0)) quad(n - 1, 0);

    const geo = this.owned.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.colors = new THREE.BufferAttribute(new Float32Array(n * this.stride * 3), 3);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', this.colors);
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.owned.track(washMaterial()));
    mesh.name = 'drivingLine';
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.group.visible = false;
  }

  /**
   * Draw the line for a car at (x, z) doing `speed` (m/s); `sRef` is its route distance (m), which seeds its place
   * on a line that stacks two levels. `show` false hides it. Writes colours for the window ahead and uploads that range.
   */
  update(show: boolean, x: number, z: number, speed: number, sRef: number, dt: number): void {
    if (this.group.visible !== show) this.group.visible = show;
    if (!show) {
      this.speed = -1;
      return;
    }
    const line = this.line;
    const { n, closed } = line;
    // A search from the last sample is a few comparisons; a car that is not near it (a reset, the first frame) is searched for over the whole line.
    let i = this.idx;
    if (i >= 0) {
      i = nearestIdx(line, x, z, i);
      if ((line.x[i] - x) ** 2 + (line.z[i] - z) ** 2 > LINE.lostDistance ** 2) i = -1;
    }
    if (i < 0) i = nearestIdx(line, x, z, -1, sRef);
    this.idx = i;
    this.speed = this.speed < 0 ? speed : this.speed + (speed - this.speed) * damp(LINE.speedRate, dt);
    const v = this.speed;
    const m = Math.max(LINE.marginFloor, LINE.margin * v);

    const lo = closed ? i - this.behindN : Math.max(0, i - this.behindN);
    const hi = closed ? i + this.aheadN : Math.min(n - 1, i + this.aheadN);
    const count = hi - lo + 1;
    const col = this.colors.array as Float32Array;
    const { stride, lit } = this;
    const wrap = (k: number) => ((k % n) + n) % n;

    // Last frame's window goes dark first; the new one lights over it.
    for (let k = 0; k < this.prevCount; k++) {
      const base = wrap(this.prevLo + k) * stride;
      for (const o of lit) {
        const c = (base + o) * 3;
        col[c] = col[c + 1] = col[c + 2] = 0;
      }
    }
    const target = this.plan.target;
    const alpha = this.plan.alpha;
    for (let k = lo; k <= hi; k++) {
      const j = wrap(k);
      const a = alpha[j];
      if (a === 0) continue;
      // Fade behind the car and at the window's far end.
      let f = a;
      if (k < i) f *= 1 - (i - k) / (this.behindN + 1);
      else if (k > hi - this.farN) f *= (hi - k) / this.farN;
      if (f <= 0) continue;
      // x > 0: faster than the target (brake); x < 0: slower (gas).
      const d = (v - target[j]) / m;
      const red = smoothstep(1, 1 + LINE.blend, d);
      const green = smoothstep(1, 1 + LINE.blend, -d);
      const w = (1 - red - green) * f * LINE.glow;
      const r = (RED[0] * red + GREEN[0] * green) * f * LINE.glow + WHITE[0] * w;
      const g = (RED[1] * red + GREEN[1] * green) * f * LINE.glow + WHITE[1] * w;
      const b = (RED[2] * red + GREEN[2] * green) * f * LINE.glow + WHITE[2] * w;
      const base = j * stride;
      for (const o of lit) {
        const c = (base + o) * 3;
        col[c] = r;
        col[c + 1] = g;
        col[c + 2] = b;
      }
    }

    // Upload only what moved: the union of last frame's window and this one (the whole attribute if it crosses the seam).
    const from = Math.min(lo, this.prevCount > 0 ? this.prevLo : lo);
    const to = Math.max(hi + 1, this.prevCount > 0 ? this.prevLo + this.prevCount : hi + 1);
    this.colors.clearUpdateRanges();
    if (from >= 0 && to <= n) this.colors.addUpdateRange(from * stride * 3, (to - from) * stride * 3);
    this.colors.needsUpdate = true;
    this.prevLo = lo;
    this.prevCount = count;
  }

  dispose(): void {
    this.owned.dispose();
  }
}
