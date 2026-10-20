/**
 * Fixed timestep game loop with an accumulator.
 *
 * The simulation always advances in exact 1/60 s ticks. Wall clock time only
 * decides how many ticks to run this frame; the leftover fraction becomes the
 * interpolation alpha the renderer uses to blend previous and current state.
 *
 * Frame rate and tick rate are independent (FRAME_BUDGET in render/autoQuality):
 * at the 120 fps aim every other frame runs no tick and is pure interpolation,
 * at 60 fps it is one tick per frame, at the 30 fps floor two. Below 12 fps
 * the catch-up cap drops time instead of spiralling.
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
/** Max ticks per rendered frame. Beyond this we drop time instead of spiralling. */
export const MAX_CATCH_UP_STEPS = 5;

export interface LoopCallbacks {
  /** Advance the simulation exactly one fixed tick. */
  tick(): void;
  /** Draw. `alpha` is 0..1, how far we are between the previous and current tick. */
  render(alpha: number, frameDt: number): void;
}

export class FixedStepLoop {
  private accumulator = 0;
  private last = -1;
  private running = false;
  private rafId = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  /** Pure accumulator step, exposed for tests. Returns ticks run and alpha. */
  advance(frameDt: number): { steps: number; alpha: number } {
    // Clamp huge gaps (tab switch, debugger) so we never try to simulate them.
    this.accumulator += Math.min(Math.max(frameDt, 0), 0.25);
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_CATCH_UP_STEPS) {
      this.cb.tick();
      this.accumulator -= SIM_DT;
      steps++;
    }
    if (steps === MAX_CATCH_UP_STEPS && this.accumulator >= SIM_DT) {
      // Too far behind: drop the backlog rather than spiral.
      this.accumulator = this.accumulator % SIM_DT;
    }
    return { steps, alpha: this.accumulator / SIM_DT };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    const frame = (now: number) => {
      if (!this.running) return;
      const dt = this.last < 0 ? 0 : (now - this.last) / 1000;
      this.last = now;
      const { alpha } = this.advance(dt);
      this.cb.render(alpha, dt);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Forget leftover time, e.g. after loading or unpausing. */
  resetAccumulator(): void {
    this.accumulator = 0;
  }
}
