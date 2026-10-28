/**
 * The iron in the road under the player's wheels: a tyre over a manhole cover or a drain grate clanks (and the
 * camera ticks), a tyre crossing a tram rail at an angle ticks. The street renderer records every cover, grate and
 * rail it draws (render/street/streetSpots.ts); this walks each wheel's path since the last frame (the wheel's
 * contact point from the interpolated pose and the car's wheel layout) against the ones near it. Only the player's
 * wheels: a rival's would cost every frame for a sound nobody can place, and a reflection of the road in the audio
 * and not the sim, so replays are untouched. Render only; nothing here allocates per frame.
 */
import type { Sfx } from '../../audio/sfx';
import type { StreetSpots } from '../../render/street/streetSpots';

/** The thresholds, in m/s, m, and the sine of an angle. */
const IRON = {
  /** Slower than this the wheels roll over iron without a sound worth hearing. */
  minSpeed: 5,
  /** A wheel that moved farther than this in a frame was teleported (a reset, a tow): no hit. */
  maxStep: 6,
  /** Quiet a cover keeps after it clanks (s). */
  coverGap: 1.2,
  /** A rail is crossed at least this sharply (sine of the angle between the wheel's path and the rail): a car running along its track is silent. */
  railSin: 0.3,
  /** Stereo spread of the wheels (the left ones lean left). */
  pan: 0.3,
  /** The camera's tick over a cover: from this speed (m/s) a light knock of base + gain * speed share. */
  knockFrom: 10,
  knockBase: 0.05,
  knockGain: 0.07,
  knockFull: 40,
} as const;

export class StreetIron {
  private readonly prev: Float64Array;
  private readonly cur: Float64Array;
  private have = false;
  /** Clock (s) of render time, and when each cover last rang. */
  private t = 0;
  private readonly rang = new Map<number, number>();
  /** Scratch for the callbacks (set before a query, read inside). */
  private w = 0;
  private x0 = 0;
  private z0 = 0;
  private x1 = 0;
  private z1 = 0;
  private speed = 0;
  private knock = 0;
  private sfx: Sfx | null = null;
  private tickedRail = false;
  private readonly onDisc = (i: number): void => {
    const d = this.spots.discs[i];
    const dx = this.x1 - this.x0;
    const dz = this.z1 - this.z0;
    const l2 = dx * dx + dz * dz;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((d.x - this.x0) * dx + (d.z - this.z0) * dz) / l2)) : 0;
    if (Math.hypot(this.x0 + dx * u - d.x, this.z0 + dz * u - d.z) > d.r) return;
    const last = this.rang.get(i);
    if (last !== undefined && this.t - last < IRON.coverGap) return;
    this.rang.set(i, this.t);
    this.sfx?.manhole(this.speed, { proximity: 1, pan: this.pan() }, `manhole:${i}`);
    if (this.speed > IRON.knockFrom) this.knock = Math.max(this.knock, IRON.knockBase + IRON.knockGain * Math.min(1, this.speed / IRON.knockFull));
  };
  private readonly onRail = (i: number): void => {
    if (this.tickedRail) return;
    const r = this.spots.rails[i];
    const wx = this.x1 - this.x0;
    const wz = this.z1 - this.z0;
    const rx = r.bx - r.ax;
    const rz = r.bz - r.az;
    const den = wx * rz - wz * rx;
    const wl = Math.hypot(wx, wz);
    const rl = Math.hypot(rx, rz);
    if (wl < 1e-6 || rl < 1e-6 || Math.abs(den) / (wl * rl) < IRON.railSin) return;
    // Where along the wheel's step (s) and the rail piece (u) the two lines cross.
    const ax = r.ax - this.x0;
    const az = r.az - this.z0;
    const s = (ax * rz - az * rx) / den;
    const u = (ax * wz - az * wx) / den;
    if (s < 0 || s > 1 || u < 0 || u > 1) return;
    this.tickedRail = true;
    this.sfx?.tramRail(this.speed, { proximity: 1, pan: this.pan() }, `rail:${this.w}`);
  };

  /** `wheels` are the car's wheel centres in car space, [left(+x), up, forward(+z)] each (CarGeometry.wheels). */
  constructor(
    private readonly spots: StreetSpots,
    private readonly wheels: readonly (readonly number[])[],
  ) {
    this.prev = new Float64Array(wheels.length * 2);
    this.cur = new Float64Array(wheels.length * 2);
  }

  private pan(): number {
    return this.wheels[this.w][0] > 0 ? -IRON.pan : IRON.pan;
  }

  /** Forget the last frame's wheels (a pause, a reset): the next update only records them. */
  reset(): void {
    this.have = false;
  }

  /** Walk the wheels from their last frame's places to the pose's. Returns the camera knock to apply (0..1, usually 0). */
  update(x: number, z: number, yaw: number, speed: number, dt: number, sfx: Sfx | null): number {
    this.t += dt;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    for (let w = 0; w < this.wheels.length; w++) {
      const [cx, , cz] = this.wheels[w];
      this.cur[w * 2] = x + cx * cos + cz * sin;
      this.cur[w * 2 + 1] = z - cx * sin + cz * cos;
    }
    this.knock = 0;
    if (this.have && speed > IRON.minSpeed && this.spots.discs.length + this.spots.rails.length > 0) {
      this.sfx = sfx;
      this.speed = speed;
      for (let w = 0; w < this.wheels.length; w++) {
        this.w = w;
        this.x0 = this.prev[w * 2];
        this.z0 = this.prev[w * 2 + 1];
        this.x1 = this.cur[w * 2];
        this.z1 = this.cur[w * 2 + 1];
        if (Math.hypot(this.x1 - this.x0, this.z1 - this.z0) > IRON.maxStep) continue;
        this.tickedRail = false;
        const lo = Math.min(this.x0, this.x1) - 0.5;
        const hi = Math.max(this.x0, this.x1) + 0.5;
        const zl = Math.min(this.z0, this.z1) - 0.5;
        const zh = Math.max(this.z0, this.z1) + 0.5;
        this.spots.discsNear(lo, zl, hi, zh, this.onDisc);
        this.spots.railsNear(lo, zl, hi, zh, this.onRail);
      }
    }
    this.prev.set(this.cur);
    this.have = true;
    return this.knock;
  }
}
