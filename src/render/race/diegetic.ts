/**
 * The numbers of the diegetic race readouts, the ones drawn in the world instead of on the HUD: the
 * radar "YOUR SPEED" signs on the route's long straights (radarSigns.ts) and the dot-matrix band under
 * every start / finish gantry sign (gantryBand.ts). Render only; nothing here touches the sim.
 */

/** Counts, ranges (m), thresholds (mph) and refresh rates of the radar signs and the gantry band. */
export const DIEGETIC = {
  radar: {
    /** Signs per city (min, max), picked from the route's streetlight poles. */
    count: [3, 5] as [number, number],
    /** The shader's uniform array size: the most signs one scene can carry. */
    maxSigns: 8,
    /** A car this far before the sign or nearer, and still approaching, lights it (m). */
    range: 120,
    /** A car this far past the sign still shows its speed for a moment (m). */
    pastRange: 2,
    /** Cars further than this beside the road's edge are not read (m). */
    laneReach: 6,
    /** The route must run straight this far before the sign (m), within `straightCos` (cosine of the angle) of its heading. */
    minStraight: 120,
    straightCos: 0.9945,
    /** Least spacing between two signs along the route (m), and clear distance to a start or finish line (m). */
    spacing: 260,
    gateClear: 80,
    /** Pole window beside the road: how far past the road's edge the pole may stand (min, max, m). */
    poleBand: [0.4, 4] as [number, number],
    /** The pole may sit this far along from the sampled route point (m). */
    poleAlong: 2.5,
    /** Panel size (m), height of its centre over the pavement (m) and how far it hangs toward the road from the pole (m). */
    width: 1.6,
    height: 1.35,
    mountHeight: 3.3,
    setback: 0.75,
    /** Speed above which the digits flash red against SLOW DOWN (mph) and the flash rate (Hz). */
    limitMph: 60,
    flashHz: 1.6,
    /** Brightness of a lit digit, the lit legends and a dark segment (bloom takes the lit ones). */
    digitGain: 2.4,
    labelGain: 1.5,
    segOff: 0.05,
  },
  band: {
    /** Dot pitch (m) and rows of the dot matrix. */
    pitch: 0.09,
    rows: 9,
    /** Seconds each page of the band stays up. */
    pageSeconds: 3,
    /** The session rebuilds the band's pages at most this often (Hz); the canvas is only redrawn when a page's text changes. */
    refreshHz: 4,
    /** Flash rate of a flashing page (Hz) and brightness of a lit dot. */
    flashHz: 2.5,
    gain: 2.2,
    /** The band hangs this far below the sign's base (m) and the housing's margin (m). */
    hang: 1.32,
    margin: 0.1,
  },
} as const;
