/**
 * Smoothing for everything that moves on screen or in sound (render, game, ui, audio). Smoothing
 * scales with frame time, never a fixed fraction per frame (CLAUDE.md, frame-rate targets), so 30, 60 and
 * 120 fps look the same. Shared math (clamp, lerp, wrapAngle, smoothstep) is sim/math.ts.
 */

/** The fraction of the way to a target to move this frame at `rate` (1/s): `x += (target - x) * damp(rate, dt)`. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Resolves after two animation frames: whatever was changed is on the glass before the next block of work holds the main thread. */
export const nextPaint = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** A value chasing a target with no overshoot (`spring`): where it is and how fast it moves (units, units/s). */
export interface Spring {
  x: number;
  v: number;
}

/**
 * Step a critically damped spring by dt toward `target`, which moves at `targetV` (units/s): exact for any dt, so
 * every frame rate follows the same curve, and its speed is continuous, so a new target never starts it with a jolt
 * the way `damp` does. `w` (1/s) is its stiffness; a target moving steadily at `targetV` is tracked with no lag.
 */
export function spring(s: Spring, target: number, w: number, dt: number, targetV = 0): void {
  const e = s.x - target;
  const ev = s.v - targetV;
  const b = ev + w * e;
  const k = Math.exp(-w * dt);
  s.x = target + (e + b * dt) * k;
  s.v = targetV + (ev - w * b * dt) * k;
}
