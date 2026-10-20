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
  /** No intersection joins more roads than this. */
  maxNodeDegree: 5,

  laneWidth: 3.6,
  /** Total road width by kind (curb to curb). */
  width: { street: 13, avenue: 17, diagonal: 16, boulevard: 24, alley: 7.4, backAlley: 4.8 } as const,
  lanes: { street: 2, avenue: 4, diagonal: 4, boulevard: 4, alley: 2, backAlley: 2 } as const,
  /** Default sidewalk width (per edge: RoadEdge.sidewalk, from sidewalkWidth by kind). */
  sidewalk: 4,
  sidewalkWidth: { street: 4, avenue: 4, diagonal: 4, boulevard: 4, alley: 1.4, backAlley: 0.8 } as const,
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

  /**
   * District planning (src/city/districts). About 80% of the city stays
   * downtown blocks; the special areas below share the rest. `chance` is per
   * city, `count` a [min, max] range. Areas are skipped once their combined
   * footprint would pass maxSpecialFraction of the block area.
   */
  districts: {
    maxSpecialFraction: 0.2,
    river: {
      enabled: true,
      chance: 0.5,
      /** Channel cross section: flat floor half width, sloped bank width, depth (m). */
      floorHalf: 9,
      bankWidth: 8,
      depth: 4.2,
      /** Meander amplitude (m) and wavelength (m) of the centerline. */
      meander: 9,
      wavelength: 640,
      /** Water trickle half width on the floor (surface 'water'). */
      waterHalf: 2.2,
      /** Solid bridge body beyond each bridge's sidewalk, seen from the channel as a culvert face. */
      bridgeBody: 4,
      /** Access ramps cut into the bank from a street down to the floor. */
      ramps: 2,
      rampHalfWidth: 4,
      /** Buildings and infill keep this far from the channel's top edge. */
      clearance: 5,
    },
    subway: {
      enabled: true,
      chance: 0.75,
      pillarSpacing: 26,
      /** Concrete footing under each steel column: the collision circle (m). */
      pillarRadius: 0.55,
      /** Pillar center behind the curb, on the sidewalk. */
      pillarSetback: 2.3,
      /**
       * Deck centerline sits this far inside the curb on the pillar side (m). With the 9 m
       * deck its outer edge stays over the sidewalk, clear of the podium facades behind it.
       */
      deckInset: 0.8,
      deckHeight: 8.5,
      /** Two tracks (centers 4 m apart) between riveted plate girders. */
      deckWidth: 9,
      /** Stations per railway [min, max], each on a long street block under the deck. */
      stations: [1, 2],
      /** A station's street block is at least this long, node to node (m). */
      stationMinEdge: 118,
      /** Station house (mezzanine) hung under the deck at the platform center: length along the deck (m). */
      mezzanine: 14,
      /** Mezzanine floor sits this far below the deck top: the stairs climb deckHeight minus this (m). */
      mezzanineDrop: 3.6,
      /** Street stairs on the pillar side sidewalk, in line with the pillars: run and width (m). */
      stairRun: 7.4,
      stairWidth: 1.5,
    },
    roundabout: {
      enabled: true,
      count: [1, 3],
      /** Outer curb radius range (m) and ring road width (outer curb to island). */
      outerRadius: [19, 23],
      ringWidth: 10.5,
      /** Chance a roundabout gets a solid fountain island instead of a jumpable planter. */
      fountainChance: 0.5,
      /** Every road leaving a roundabout is at least this long, and sectors at least minSectorDeg wide. */
      minEdge: 105,
      minSectorDeg: 75,
      /** Low planter island: mound height (m) and beveled edge width (m). */
      planterHeight: 0.75,
      planterBevel: 2.6,
    },
    alley: {
      enabled: true,
      count: [2, 4],
      /** Consecutive straight street edges turned into one narrow raceway alley. */
      chain: [2, 3],
      /** Clutter keeps this far from each end of an alley edge (junction mouths), m. */
      endClear: 12,
      /** Cafe table spacing along a restaurant front (m). */
      tableSpacing: 2.3,
    },
    backAlley: {
      enabled: true,
      count: [2, 5],
      /** Both block sides the shortcut joins are at least this long. */
      minSide: 100,
      /** Chance of a kicker hump: up and down ramps (m), flat top (m) and height (m). */
      jumpChance: 0.75,
      jumpRamp: 6,
      jumpTop: 1.2,
      jumpHeight: 0.95,
      /** The hump fades to flat this far beyond the alley walls (m). */
      jumpFade: 1.5,
      /** Dumpster spacing along each wall (m). */
      dumpsterSpacing: 11,
      /**
       * Route shortcuts (carveRouteShortcuts): every circuit and sprint gets at
       * least one back alley that both starts and ends on the route and saves
       * real distance, and a second one where a good spot exists.
       */
      route: {
        perRoute: 2,
        /** Curb to curb width of a route shortcut (m): a little wider than a plain back alley, it is raced through. */
        width: 5.2,
        /** Corner cuts across the inside block of a turn: entry and exit this far from the corner (m), longest that fits first. */
        cornerReach: [116, 108, 100, 92, 84, 76, 68, 60, 52, 46, 40, 34, 30],
        /** U cuts across a block the route wraps on three sides: entry and exit this far before / after the corners (m). */
        uReach: [56, 50, 44, 38, 32, 28],
        /** Length the pick favours (m): shorter or longer cuts score lower (they still guarantee a shortcut where nothing else fits). */
        idealLength: [100, 165],
        /** |Turn| (deg) a corner of a cut may have. */
        turnDeg: [68, 116],
        /** Entries keep this far from the next route junction (m); from a turning junction whose corner rail runs along the cut's side, railClear. */
        nodeClear: 28,
        railClear: 50,
        /** Shortest shortcut (m). */
        minLength: 38,
        /** It saves at least minSave of the route distance it skips, and skips at most maxSkip of the lap (or sprint). */
        minSave: 0.2,
        maxSkip: 0.34,
        /** Room kept between the cut's sidewalks and any other street's sidewalk or inside corner (m). */
        clear: 4,
        /** A second shortcut on the same route starts at least this far along the route from the first (m). */
        spacing: 320,
        jumpChance: 0.6,
      },
    },
    park: {
      enabled: true,
      count: [1, 2],
      minArea: 7000,
      maxArea: 26000,
      /** Rolling hill height (m) and how far from the park edge it rises from flat (m). */
      hill: 2.6,
      hillEdge: 16,
      treeSpacing: 15,
      treeRadius: 0.4,
      /** A small wood in each park: radius range (m) and its denser tree spacing (m). */
      groveRadius: [15, 22],
      groveSpacing: 6,
      /** One cluster of drive-through bushes per this much park area (m^2). */
      bushClusterArea: 800,
      /** Footpath loop this far inside the park edge (m), with a bench every benchSpacing m. */
      pathInset: 11,
      benchSpacing: 36,
    },
    infill: {
      enabled: true,
      /** Shorter void runs just get a low boundary wall. */
      minRun: 5,
      /** Straight runs at least this long can become parking lots. */
      lotMinLen: 14,
      lotDepth: 26,
      plazaDepth: 14,
      /** Corner pockets reach this far along both streets. */
      cornerReach: 18,
      /** A corner pocket needs this much void along its shorter street (m); the longer one needs minRun. */
      cornerMinSide: 2.5,
      /** Corner pockets stop this far short of the buildings that end the void (m). */
      cornerMargin: 0.6,
      /** Infill keeps this far from other drivable space (wall tunnelling guard). */
      gap: 4,
      lotChance: 0.35,
      plazaChance: 0.35,
      /** Shallow drivable strip (verge) depths, deepest first (m). */
      vergeDepth: [4.5, 2.5],
      /**
       * Share of junction block corners (3+ roads) where blocks.ts keeps the buildings back, so the
       * corner becomes a void the infill furnishes: more inside corners worth cutting through.
       */
      openCornerChance: 0.35,
      /** Reach of an open corner along each street (m). */
      openCornerReach: [9, 15],
      /** Share of corners and straight voids kept solid (raised planters): something hard among the clutter. */
      solidChance: 0.14,
      fountainChance: 0.15,
      planterDepth: 2.4,
    },
    /** Reserved unique features, documented placeholders (plan nothing yet). */
    monument: { enabled: false },
    waterfront: { enabled: false },
    lake: { enabled: false },
  },
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
  /**
   * Closure barriers stand this much further into their side street than where its walls start
   * (m): head-on closures (straight ahead of the incoming road, where racers overshoot) more than
   * side ones. Short streets keep at least barrierMinRoom m between their two ends.
   */
  barrierSetbackHeadOn: 7,
  barrierSetbackSide: 3,
  barrierMinRoom: 10,
  /** Corner guard rails: minimum turn, extra reach past the corner (m). */
  railMinTurnDeg: 30,
  railReach: 14,
  /**
   * Rails sit this far in front of the outer sidewalk line (the building line),
   * so the road and the whole sidewalk stay drivable runoff.
   */
  railInset: 0.3,
  /** How far (m) the rounded rail corner may cut inside the sharp outer sidewalk corner of an intersection. */
  railCornerCut: 2,
  /** Rails are chains of modular pieces about this long (m), each a heavy sim body (src/sim/rails.ts). */
  railPieceLength: 2.5,
  /** Max heading change (deg) per straight sub segment of a piece, so curves read smooth. */
  railMaxSubDeg: 3,
  /** Sample spacing (m) of the smooth rail path before it is cut into pieces. */
  railSampleStep: 0.1,
  /**
   * Crosswalk stripes run this far (m) into each street from its mouth (see
   * cityMeshes). Rails crossing a closed street bend back to pass behind them,
   * with railCrosswalkClear to spare.
   */
  railCrosswalkStart: 1.2,
  railCrosswalkEnd: 4.2,
  railCrosswalkClear: 0.35,
  /** Longest such bend (m); a rail that would need more keeps its line. */
  railMaxBend: 2,
  /** Clearance (m) the rail keeps from street furniture (beyond the prop's radius). */
  railPropClear: 0.35,
} as const;
