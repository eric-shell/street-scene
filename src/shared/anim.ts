/**
 * Smoothing for everything that moves on screen or in sound (render, game, ui, audio). Smoothing
 * scales with frame time, never a fixed fraction per frame (CLAUDE.md, frame-rate targets), so 30, 60 and
 * 120 fps look the same. Shared math (clamp, lerp, wrapAngle, smoothstep) is sim/math.ts.
 */

/** The fraction of the way to a target to move this frame at `rate` (1/s): `x += (target - x) * damp(rate, dt)`. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);
