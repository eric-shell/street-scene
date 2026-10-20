/** City generation constants. All distances in meters. */
export const CITY = {
  gridW: 11,
  gridH: 11,
  spacing: 140,
  /** Max random offset of grid nodes. Kept small so sectors stay wider than MIN_SECTOR_DEG. */
  jitter: 12,
  /** Fraction of ordinary grid edges we try to remove. */
  removeFraction: 0.14,
  diagonalCount: 2,
  diagonalMinCells: 3,
  diagonalMaxCells: 5,
  minSectorDeg: 24,

  laneWidth: 3.6,
  /** Total road width by kind (curb to curb). */
  width: { street: 13, avenue: 17, diagonal: 16, boulevard: 24 } as const,
  lanes: { street: 2, avenue: 4, diagonal: 4, boulevard: 4 } as const,
  sidewalk: 4,
  curbHeight: 0.15,

  /**
   * Rolling hills: amplitudes in meters, frequencies in rad/m. Worst case grade is
   * about a1*f1 + a2*f2*sqrt(2) + a3*f3 = 5.2%, typical grades 1-3%.
   */
  hillAmp1: 5.5,
  hillAmp2: 3.0,
  hillAmp3: 1.6,
  hillFreq1: 0.0042,
  hillFreq2: 0.0026,
  /** Medium wavelength (~570 m) crests and dips, a few per lap. */
  hillFreq3: 0.011,

  downtownRadius: 420,
  broadphaseCell: 32,

  streetlightSpacing: 34,
  /** Street furniture props (see props.ts). Chances per gap between streetlights / per long edge. */
  propCanChance: 0.55,
  propBenchChance: 0.22,
  propBusStopChance: 0.3,
  propBusStopMinEdge: 100,
  signCount: 90,
} as const;

export const ROUTE = {
  circuitMinLength: 1500,
  circuitMaxLength: 3200,
  sprintMinLength: 2200,
  sprintMaxLength: 4900,
  minTightCorners: 3,
  minSweepers: 1,
  /** Turn angle thresholds in degrees. */
  tightDeg: 65,
  sweeperMinDeg: 18,
  sweeperMaxDeg: 60,
  /** Hard limit: sharper turns (hairpins through acute junctions) are rejected. */
  maxTurnDeg: 112,
  checkpointSpacing: 140,
  sprintStartOffset: 45,
  /** Runout past the sprint finish line, so finishers can brake to a stop before the end barrier. */
  sprintFinishOffset: 170,
  /** The sprint finish line keeps at least this far from any intersection on the route. */
  sprintFinishNodeClear: 22,
  gridRowSpacing: 8,
  gridFirstRow: 9,
  maxAttempts: 400,
  /** Corner guard rails: minimum turn, extra reach past the corner (m), segments per curve. */
  railMinTurnDeg: 30,
  railReach: 14,
  railSegments: 10,
  /** Rails sit this far behind the curb line, on the sidewalk, so the whole road stays drivable. */
  railInset: 0.3,
  /** How far (m) the rounded rail corner may cut inside the sharp outer curb corner of an intersection. */
  railCornerCut: 1.5,
} as const;
