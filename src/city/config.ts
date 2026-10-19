/** City generation constants. All distances in meters. */
export const CITY = {
  gridW: 11,
  gridH: 11,
  spacing: 120,
  /** Max random offset of grid nodes. Kept small so sectors stay wider than MIN_SECTOR_DEG. */
  jitter: 10,
  /** Fraction of ordinary grid edges we try to remove. */
  removeFraction: 0.14,
  diagonalCount: 2,
  diagonalMinCells: 3,
  diagonalMaxCells: 5,
  minSectorDeg: 24,

  laneWidth: 3.6,
  /** Total road width by kind (curb to curb). */
  width: { street: 11, avenue: 15, diagonal: 15, boulevard: 22 } as const,
  lanes: { street: 2, avenue: 4, diagonal: 4, boulevard: 4 } as const,
  sidewalk: 4,
  curbHeight: 0.15,

  /** Gentle rolling grades. Amplitudes in meters. */
  hillAmp1: 3.5,
  hillAmp2: 2.0,
  hillFreq1: 0.0042,
  hillFreq2: 0.0026,

  downtownRadius: 360,
  broadphaseCell: 32,

  streetlightSpacing: 34,
  signCount: 90,
} as const;

export const ROUTE = {
  circuitMinLength: 1300,
  circuitMaxLength: 2700,
  sprintMinLength: 1900,
  sprintMaxLength: 4200,
  minTightCorners: 3,
  minSweepers: 1,
  /** Turn angle thresholds in degrees. */
  tightDeg: 65,
  sweeperMinDeg: 18,
  sweeperMaxDeg: 60,
  maxTurnDeg: 140,
  checkpointSpacing: 140,
  sprintStartOffset: 45,
  sprintFinishOffset: 20,
  gridRowSpacing: 8,
  gridFirstRow: 9,
  maxAttempts: 400,
} as const;
