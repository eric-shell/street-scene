/**
 * The frame-rate targets, the one place they live (CLAUDE.md, Frame-rate targets): the auto quality controller,
 * the FPS meter, the perf analytics and the admin dashboard's frame-rate lines all read them here. A leaf module
 * with no imports, so the dashboard (its own Vite page) can use it without pulling the game in behind it;
 * render/autoQuality.ts re-exports it.
 */

/**
 * Frame-rate targets in seconds per frame. Every per-frame cost in the game
 * is budgeted against these three lines (CLAUDE.md says what they mean for
 * new work); the controller, the FPS meter and the docs all read them here.
 */
export const FRAME_BUDGET = {
  /** 120 fps (8.3 ms): the goal on capable hardware and a fast display. The controller probes for more quality only when frames sit here (or at the display's refresh when that is slower). */
  aim: 1 / 120,
  /** 60 fps (16.7 ms): what every supported device should hold. Below it the controller steps down. */
  hold: 1 / 60,
  /** 30 fps (33.3 ms): never acceptable. At it the controller drops two levels on the first bad evaluation. */
  floor: 1 / 30,
} as const;
