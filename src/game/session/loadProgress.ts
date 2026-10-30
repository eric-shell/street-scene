/**
 * Real progress for a race's loading card: the build is a list of named stages (the sim, each of the night
 * scene's, the HUD and effects, the cars, the shader compile), and a stage's weight is how long it took last time
 * on this device at this quality tier (`buildTimes.v1` in the store), so the bar fills in proportion to the wait
 * ahead rather than to the stage count. The first run uses the defaults below. Each `step` reports the new share,
 * gives the card a painted frame to show it (the build holds the main thread between steps), then times the stage
 * including that frame, so the saved weights are what the player actually waited.
 */
import { loadJson, saveJson } from '../../shared/store';
import { nextPaint } from '../../shared/anim';
import type { Settings } from '../../ui/settings';

type Quality = Settings['quality'];

/** The stages in build order and their first-run weights (ms; the Medium build's compute on a laptop, the env probe bake and shader compile guessed for a real GPU, where headless software GL is no guide). */
const DEFAULT_WEIGHTS: Record<string, number> = {
  gen: 100,
  race: 400,
  stats: 35,
  city: 570,
  districts: 600,
  sky: 35,
  street: 115,
  lights: 35,
  lighting: 50,
  meets: 65,
  props: 40,
  people: 45,
  finish: 65,
  probes: 400,
  session: 400,
  cars: 35,
  shaders: 300,
};

type Times = Record<Quality, Record<string, number>>;

export class LoadProgress {
  private readonly weights: Record<string, number>;
  private readonly measured: Record<string, number> = {};
  private done = 0;
  private t0 = performance.now();

  constructor(
    private readonly tier: Quality,
    private readonly report: (p: number) => void,
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(loadJson<Partial<Times>>('buildTimes.v1', {})[tier] ?? {}) };
    this.report(0);
  }

  /** Total weight of all the stages (ms). */
  private get total(): number {
    let t = 0;
    for (const k of Object.keys(this.weights)) t += this.weights[k];
    return t;
  }

  /** A stage is finished: show the progress, wait for the frame that paints it, and time the stage with it. */
  async step(stage: string): Promise<void> {
    this.done += this.weights[stage] ?? 0;
    this.report(Math.min(0.99, this.done / Math.max(1, this.total)));
    await nextPaint();
    const now = performance.now();
    this.measured[stage] = Math.max(1, Math.round(now - this.t0));
    this.t0 = now;
  }

  /** The build is over: fill the bar and save the measured times as the next build's weights. */
  finish(): void {
    this.report(1);
    const all = loadJson<Partial<Times>>('buildTimes.v1', {});
    all[this.tier] = { ...this.weights, ...this.measured };
    saveJson('buildTimes.v1', all);
  }
}
