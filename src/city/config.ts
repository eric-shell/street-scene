/** City generation constants. All distances in meters. */
export const CITY = {
  /**
   * Nominal grid: what a seed's CityPlan (roadGraph.ts cityPlan) varies around. Code that plans or
   * builds on a seed's grid reads its plan (RoadGraph.plan: gridW, gridH, spacing), never these; they
   * stay as the house reference for lengths quoted in blocks (a drag's "blocks", a terrace's grade).
   */
  gridW: 11,
  gridH: 11,
  spacing: 140,
  /**
   * Each seed's city plan (roadGraph.ts cityPlan, its own 'plan' stream): the bones that make one
   * city unlike the next. The spacing (m) is drawn first, then a target span (m, junction to
   * junction before the warp) and each axis gets the junction count nearest that span at that
   * spacing, within its count range: the camera's far plane, the fog and the backdrop are sized for
   * a city about 1.5 km across, so a tight grid has more blocks rather than a smaller map.
   * gridW stays at 11: tests/city.test.ts, subway.test.ts and lake.test.ts index grid junctions as
   * j * CITY.gridW + i. The generator and every planner read the plan's counts, so widening it to
   * [10, 12] is this line once those tests read RoadGraph.plan.gridW.
   */
  plan: {
    spacing: [132, 156] as const,
    span: [1380, 1620] as const,
    gridW: [11, 11] as const,
    gridH: [11, 12] as const,
    /**
     * Downtown (the tower core, the 'nyc' architecture region, the street furniture's core) centres
     * on a point up to this share of the grid's half size from the middle, uniform over the disc.
     */
    downtownOffset: 0.28,
    /** Weights of 1, 2, ... boulevard rows, avenue columns and diagonal avenues (the old city: 1, 2, 2). */
    boulevards: [0.7, 0.3] as const,
    avenues: [0.25, 0.55, 0.2] as const,
    diagonals: [0.25, 0.5, 0.25] as const,
    /**
     * Superblock: on this share of seeds one interior row or column loses its street across a band
     * of `cells` blocks, so the blocks either side merge into double-length ones (degree and
     * connectivity rules still hold: the cross streets carry on through).
     */
    superblockChance: 0.42,
    superblockCells: [2, 3] as const,
    /** Share of ordinary grid streets the generator tries to remove (min, max per seed). */
    removeFraction: [0.1, 0.18] as const,
  },
  /** Max random offset of grid nodes. Kept small so sectors stay wider than MIN_SECTOR_DEG. */
  jitter: 12,
  /**
   * Smooth warp of the whole grid (roadGraph.ts warpField): every point moves by a sum of sine
   * waves of the other axis, x += amp * sin(z * 2pi / wavelength + phase) and z likewise of x, with
   * phases from the seed. Rows and columns sweep instead of running straight, junction angles vary
   * and blocks are no longer rectangles. A term swings a street's heading by up to amp * 2pi /
   * wavelength (rad) and bends it by up to amp * (2pi / wavelength)^2 (rad/m): the long term is the
   * sweep across the map (about 10 degrees of heading, one slow arc), the short one the local
   * wobble that makes junction angles range about 65-115 degrees and puts most of the curvature in
   * (about 2.5 degrees per 47 m piece at its steepest). amp in m, wavelength in m.
   */
  warp: [
    { amp: 34, wavelength: 1250 },
    { amp: 7, wavelength: 500 },
  ],
  /**
   * Pieces every grid street is cut into (roadGraph.ts subdivideEdges), through degree-2 bend nodes
   * on the warped line between its junctions, so the street follows the warp as a curve instead of
   * a straight chord: 3 makes about 47 m pieces, bending about 1-3 degrees at each node.
   */
  bendSegments: 3,
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
  /**
   * Sidewalk and plaza paving above the road (m): a low, rolled curb that cars drive up onto
   * (World.driveHeightAt) without being thrown about.
   */
  curbHeight: 0.09,
  /**
   * The sim's curb: a wheel climbs curbHeight across this span (m), starting `road` out on the road
   * (a tire meets the curb's edge before its contact point does) and topping out `walk` onto the paving.
   */
  curbRamp: { road: 0.22, walk: 0.12 },

  /**
   * Rolling hills: amplitudes in meters, frequencies in rad/m. The three rolling terms' grades
   * add to at most a1*f1 + a2*f2*sqrt(2) + a3*f3 = 5.2%; with the macro relief below the maxima
   * sum to 7.7%, but the two long waves run roughly across each other and their steepest points
   * rarely meet the short waves', so the worst grade measured over 100 seeds is 6.1% and the
   * typical (median) grade 2-3% (tests/city.test.ts holds the base under 6.6%).
   */
  hillAmp1: 5.5,
  hillAmp2: 3.0,
  hillAmp3: 1.6,
  hillFreq1: 0.0042,
  hillFreq2: 0.0026,
  /** Medium wavelength (~570 m) crests and dips, a few per lap. */
  hillFreq3: 0.011,
  /**
   * Macro relief, the landscape the city sits on: a broad ridge or tilt (one side of the map
   * higher by 12-20 m) at a 2.4 km wavelength in a seed-random heading, and a gentler valley or
   * swell at 3 km roughly across it (hillValleySkewDeg either side of perpendicular, degrees).
   * Grades a4*f4 = 1.8% and a5*f5 = 0.7%; their curvature is far too slight to launch a car.
   */
  hillAmp4: 7.0,
  hillAmp5: 3.5,
  hillFreq4: 0.0026,
  hillFreq5: 0.0021,
  hillValleySkewDeg: 22,

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
   * District planning (src/city/districts). Roughly half the city stays plain
   * downtown blocks; the special areas below (hills, parks, the river, the El,
   * alleys, roundabouts, a monument plaza...) share the rest. `chance` is per
   * city, `count` a [min, max] range. Areas are skipped once their combined
   * footprint would pass maxSpecialFraction of the block area (a cap, not a
   * target: the counts below decide how much actually gets used).
   */
  districts: {
    maxSpecialFraction: 0.45,
    river: {
      enabled: true,
      chance: 0.9,
      /** Channel cross section: flat floor half width, sloped bank width, depth (m). */
      floorHalf: 11,
      bankWidth: 8,
      depth: 4.2,
      /**
       * The centerline is the midline between the two bank street rows (sampled column by column
       * and box smoothed over smoothSpan m) plus a meander: a swing of up to `meander` m with
       * wavelength `wavelength` m whose amplitude itself swells and fades over `envelope` m. The
       * swing is scaled down in steps (meanderSteps tries) until the band clears every junction.
       * Samples every centerStep m (cubic interpolation between them).
       */
      meander: 14,
      wavelength: 700,
      envelope: 1900,
      meanderSteps: 4,
      centerStep: 16,
      smoothSpan: 240,
      /** Junctions keep this far (m) beyond the band's top edge; any other street this far. */
      junctionClear: 20,
      streetClear: 12,
      /** A crossing street runs within this |cos| of square to the channel (the diagonals cross at about 45). */
      maxSkew: 0.78,
      /**
       * Low flow trickle on the floor (surface 'water', offroad grip): half width and offset from the
       * centerline (m), to one side of the racing line so it is a hazard to dodge, not a given.
       */
      waterHalf: 1.6,
      waterOffset: 5.5,
      /**
       * A bridge deck's structure beyond its outer sidewalk line (m): the terrain (the deck, what the
       * road mesh drapes on) eases down into the channel profile across it, hidden under the deck's
       * edge; the channel floor runs on beneath (World.heightAt with a car height, DeckSpan). The El
       * keeps its pillars this far off the channel too.
       */
      bridgeBody: 4,
      /** Pier and abutment tops, and the parapets' undersides, sit this far below the deck (m): deck cars pass over the one, channel cars under the other. */
      deckClear: 0.6,
      /** Piers under a deck: square side (m), spacing along the deck (m), inset from the floor edge (m); the abutment box starts this far up the bank (m). */
      pier: 1.0,
      pierSpacing: 6.5,
      pierInset: 0.9,
      abutment: 2,
      /**
       * The channel is a race venue: its floor is one chain of 'channel' edges from end to end and
       * routes dive in anywhere. Entrances per seed [min, max], counting a ford (a crossing street
       * that dips through the channel instead of bridging it) as two: at least one in every quarter
       * of the channel's length, banks alternating; fords per seed [min, max] where a street fits one.
       */
      entrances: [6, 8],
      fords: [1, 2],
      /** Entrance feet keep this far apart along the channel (m) and this far from a bridge's crossing (m). */
      entranceGap: 70,
      footClear: 28,
      /** Channel edges follow the meander with a node at least every this far (m): chords stay within about a meter of it. */
      nodeSpacing: 70,
      /**
       * Channel edge width (m) as the route sees it: the floor less a margin, so the chords between
       * channel nodes (up to about a meter off the true centerline) never put a floor edge wall "on the road".
       */
      channelMargin: 1.5,
      /** The chain ends this far (m) inside each tunnel portal: room for a closure and a meet behind the last foot. */
      endStub: 30,
      /**
       * Half width (m) of a side ramp's trench: a 12 m cut, nearly a street's width, so a car can swing
       * in from the channel floor or the bank street with room to spare. A ford dips the whole road
       * (half width = the street's), its plinths on the sidewalks only, so nothing stands in a lane.
       */
      rampHalfWidth: 6,
      /**
       * Ramp run from its top (ground level) to the floor edge (m): the steepest fords run about
       * 1.2 x depth / rampMinRun (18%), typical ones half that; short enough that a side ramp fits
       * between the bank street's frontage and the floor.
       */
      rampMinRun: 36,
      rampMaxRun: 95,
      /**
       * Flat street kept between a junction's far sidewalk corner and a ford's ramp top (m): a mouth
       * closure stands 1.5 m past that corner, so this keeps it off the plinth caps and trench walls.
       */
      fordSetback: 3.5,
      /** Share of the run eased in at the top (a rounded lip cars launch over); the foot is a hard kink. */
      rampLip: 0.3,
      /** Solid retaining plinth beside each trench (m): keeps cars on the bank 4 m from the drop. */
      rampBody: 4,
      /**
       * A side ramp's trench opens into a bell mouth over the last mouthLength m of its run, up to
       * mouthFlare m wider each side at the top (less where the next street is close), so the
       * plinths meet the street at an angle instead of with square caps a car turning in clips.
       * Short on purpose: a longer bell converges on a car that crosses the axis and pins it nose
       * first. The plinth keeps at least mouthBody m where the bell eats into it (m).
       */
      mouthLength: 12,
      mouthFlare: 5,
      mouthBody: 1.5,
      /**
       * Every trench also opens into a bell at its foot: footFlare m wider each side at the floor edge,
       * easing back to the straight trench over footLength m up the run, so a car turning in off the
       * channel floor meets a chamfered plinth corner instead of a square one. footFlare + mouthBody
       * stays within rampBody, so the plinth's outer face (routeBarriers' foot clearance) never moves.
       */
      footFlare: 2.5,
      footLength: 10,
      /**
       * A closure across the channel stands at least this far from a foot (m): past the widest plinth
       * (an avenue ford's, 12.5 m) plus the skew the meander gives the closure line across the banks.
       */
      closureFootClear: 16,
      /**
       * Funnel at every ramp top (the shortcut language: fences, lights and clutter, never a sign):
       * two lines of fence panels splaying from the plinth caps out onto the street by funnelReach m
       * and funnelFlare m wider each side, cones and barricades along them, string lights across.
       */
      funnelReach: 6,
      funnelFlare: 5,
      /**
       * Two rows of fence panels across every entrance that racers break through to get in: a side
       * ramp's first row stands across the mouth on the sidewalk, a ford's this far (m) past the top
       * across its road; the second row stands this far (m) down the lip inside the trench.
       */
      fordFenceRow: 2,
      fenceRowDrop: 3.4,
      /** Buildings and infill keep this far from the channel's top edge. */
      clearance: 5,
      /** Clutter along the floor edges (barrels, crates, bags) about every this far (m), clear of feet, bridges and features. */
      clutterSpacing: 16,
      /** Clusters out on the floor itself (pallets, barrels, a water barrier) about every this far (m), on the side away from the trickle. */
      floorClutterSpacing: 55,
      /**
       * Channel features (districts/riverFeatures.ts): count per seed [min, max]; each keeps `clear` m
       * beyond its own span from every foot and deck edge and `gap` m from the others; a full width
       * feature fades out over the last edgeFade m before the floor edge. Sizes in m.
       */
      features: {
        count: [1, 3],
        clear: 40,
        gap: 90,
        edgeFade: 1.4,
        /** The hump's and bar's wedge: share of each grade eased at its foot and at the crest (riverFeatures.ts wedge). */
        wedgeEase: 0.25,
        /** Speed hump across the floor, a wedge: length along the channel, height (a 3% mean grade: a lift at 150 km/h, not a launch). */
        hump: { length: 14, height: 0.22 },
        /** Water bar: the hump skewed across the floor by skewDeg (length measured square to the bar). */
        bar: { length: 12, height: 0.2, skewDeg: 28 },
        /** Tabletop jump on one half: each slope's run, the flat top, height; from `inner` of the centerline, bevelled over `edge`; the lip share of the run eased in. */
        table: { rise: 7, top: 2.5, height: 0.85, inner: 1.5, edge: 1.2, lip: 0.3 },
        /** Ledge along one half: length, height, from `inner` of the centerline bevelled over `ease`, its ends tapered over `end`, merging into the bank over bankMerge up the slope. */
        ledge: { length: 60, height: 0.5, inner: 1.2, ease: 1.8, end: 8, bankMerge: 3 },
        /** Median ridge down the centerline: length, half width, height, tapered ends, the barriers' spacing along it. */
        median: { length: 48, half: 1.2, height: 0.3, end: 6, barrierStep: 4 },
      },
      /**
       * Other roads keep this far (m) from a side ramp's trench and plinths (the wider trench kept this
       * reach where it was, so every seed's entrance plan stayed put when the trench grew). */
      rampClear: 2.5,
      /** Other roads keep this far (m) from a ford's trench and plinths. */
      fordClear: 3,
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
      /**
       * Swings: the line leaves its street column for the neighbouring one through the blocks, on an
       * S curve, this many times per seed [min, max] (one that does not fit is dropped: a diagonal
       * avenue or the river in its blocks, a curve too tight). One spans [min, max] street rows: over
       * two rows it crosses the street between them about 40 degrees off square, over three the two
       * streets about 25.
       */
      swings: [1, 2],
      swingRows: [2, 3],
      /** The S curve starts and ends this far past the junction it leaves or joins (m): the deck is straight over the junction. */
      swingLead: 26,
      /** A swing is dropped when its curve radius falls under this anywhere (m): well above what the trains need (RAIL.minRadius). */
      swingRadius: 75,
      /** The S curve's path points are this far apart (m). */
      swingStep: 10,
      /** Through a block, buildings and infill keep this far beyond the deck's edges (m). */
      blockMargin: 2,
    },
    /**
     * Bluff: an escarpment the El crosses level (src/city/districts/bluff.ts).
     * The El leaves its street for a right of way through the blocks, the
     * ground steps up under it, and on the bluff top the track runs at grade
     * with a gated level crossing on the crest street.
     */
    bluff: {
      enabled: true,
      /** Chance per city with an El. */
      chance: 1,
      /** Also try the right of way on the El street's other side (away from the way the El swings) when the first side does not fit. */
      mirror: true,
      /** Height of the step (m), [min, max]: the tallest that keeps the El clear of the low side streets wins. */
      height: [5.5, 7.5],
      /** Steepest grade of a street ramp up the face (the hills' cap) and of the gentle back and end slopes. */
      rampGrade: 0.11,
      sideGrade: 0.095,
      /** Quadratic lip at each end of a ramp's constant grade (m). */
      rampLip: 14,
      /** The rock face between streets: its smoothstep span across (m). */
      face: 7,
      /** Behind a ramp's frontage the ramp profile blends into the rock face over this band (m). */
      blend: 3,
      /** The plateau runs on this far past the crossing before the back slope falls away (m). */
      plateauPast: 34,
      /** The El's right of way runs this far from its street's centerline, through the blocks (m). */
      rowOffset: 52,
      /** Tie top above the road the El keeps over a street it crosses on the low side, else the street dips (m). */
      clearance: 6.4,
      /** Deepest underpass dip (m); its grade is rampGrade. Past that the crossing humps up to `hump` (m). */
      sagMax: 2.4,
      hump: 1,
      /** Streets climb the face this square to it at most (cosine of the angle off its normal): grid streets and diagonals. */
      rampSkew: 0.6,
      /** Pillars stand only where the deck is this high above the ground; lower is embankment (m). */
      pillarMin: 3.4,
      /** The crossing's ground is flattened to the rail level within padIn of it, blending out by padOut (m). */
      padIn: 14,
      padOut: 30,
      /** The deck eases from its level back into the normal profile over this distance (m). */
      levelBlend: 120,
      /** Streets and nodes keep this far from a ramp or dip's ends (m). */
      nodeClear: 17,
    },
    roundabout: {
      enabled: true,
      /** Roundabouts per city [min, max] (fewer place when the candidates run out), and the chance a city gets just one instead. */
      count: [2, 4],
      singleChance: 0.2,
      /**
       * Outer curb radius range (m) and ring road width (outer curb to island): big circles with a
       * four lane ring, room to overtake around the island and carry speed through it.
       */
      outerRadius: [29, 35],
      ringWidth: 15,
      /** Every road leaving a roundabout is at least this long, and sectors at least minSectorDeg wide. */
      minEdge: 105,
      minSectorDeg: 75,
      /**
       * Island variants, dealt shuffled per seed so no two roundabouts of a city match. Every island
       * is driven through (the ring is the long way round); what the shortcut costs is the clutter on
       * it and the few solid pieces to thread between, while its profile unsettles the car. `rise` is
       * the island's height at its middle over the ring road (m, negative sunken), `bevel` the width of
       * the slope from the rim in to the flat middle (m; a bevel wider than the island makes a dome or a
       * bowl). A car leaves a crest at its speed times the steepest slope, so slopes stay near 6% (a
       * hop of about half a second at 40 m/s); the knoll is the exception, a kicker that overshoots the
       * ring unless the driver lifts.
       */
      variants: ['mound', 'knoll', 'bowl', 'plaza', 'garden'],
      island: {
        /** A grassy dome with a few trees in it: the hop over the crest is gentle, the trunks are not. */
        mound: { rise: 0.6, bevel: 99, trees: [3, 4], bushes: [12, 16], benches: 3 },
        /** A flat topped hill that launches a fast car off its far edge; a sculpture plinth and the fence on top. */
        knoll: { rise: 0.7, bevel: 9, benches: 4, bushes: [4, 6] },
        /** A sunken lawn with a ring of trees and posts on its floor. */
        bowl: { rise: -0.6, bevel: 99, trees: [3, 4], treeRing: 7, bushes: [8, 12], benches: 3 },
        /** A sunken paved square around a dry fountain basin: cafe tables between bollards, a fence of pots at the foot of its lip. */
        plaza: { rise: -0.4, bevel: 7, basin: [2.8, 3.6], tables: [8, 10], benches: 4, carts: [1, 2] },
        /** A low raised bed cut by two cobbled paths between hedges, an urn at the crossing, bollard gateposts along the paths. */
        garden: { rise: 0.3, bevel: 7, pathWidth: 4, hedgeSpacing: 2.2, gatepost: 6.5, benches: 2 },
      },
      /**
       * The fence: a ring of planter pots and bollards round the island's middle at this radius (m) with
       * their edges this far apart (m). A car fits through a gap at a crawl; any straight line through
       * the middle at speed takes two of them, which is what the shortcut costs.
       */
      fenceRadius: 6.5,
      fenceGap: 2.6,
      /** Tree trunk radius (m, a solid the sim collides with) and the least gap between two trunks (m). */
      treeRadius: 0.4,
      treeGap: 7,
      /** Lantern posts per island (lit by render/street/areaLights), standing this far inside the rim (m). */
      lamps: 6,
      lampInset: 1.6,
      /** Radius of a sculpture plinth or urn base (m). */
      plinth: 1.5,
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
       * Shortcut mouths flare into funnels (blocks.ts computeSectors): the corners where a back alley
       * meets its street are rounded off this far along the street and along the alley (m), so a
       * racer can turn in late or early and still make it. Shorter where the next junction is close.
       */
      mouth: { street: 9, alley: 7 },
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
        /** Shortest shortcut (m): below this a cut is a stub with no room for clutter between its mouths. */
        minLength: 80,
        /** It saves at least minSave of the route distance it skips, and skips at most maxSkip of the lap (or sprint). */
        minSave: 0.2,
        maxSkip: 0.34,
        /** Room kept between the cut's sidewalks and any other street's sidewalk or inside corner (m). */
        clear: 4,
        /** A second shortcut on the same route starts at least this far along the route from the first (m). */
        spacing: 320,
        jumpChance: 0.6,
        /**
         * A shortcut's path through its block is a dogleg (one bend) or a gentle arc (two bends)
         * when the block has room, never a straight shot: it bends away from the corner it cuts.
         * Bend angles tried per node (deg, the first that fits), the sharpest bend a jump exit's
         * run-up may follow, and the shortest leg (m): a bend close to a mouth or the kicker leaves
         * no straight to settle on.
         */
        bend: { tryDeg: [32, 24, 16], maxDeg: 45, minLeg: 24 },
        /**
         * Jump exits: at the exit end the alley climbs a ramp to a lip and the car flies over the
         * mouth onto the route's street, landing on it heading down it. The last leg meets the
         * street at exitDeg (shallow, so the landing heading is nearly the street's; the alley's
         * walls then run on obliquely, the acute one furthest). The ramp is a parabola `length` m
         * long rising `rise` m, steepest at the lip (2 rise / length, about 11 deg), its lip
         * `lipBack` m inside the last point where both alley walls still stand; the face under the
         * lip (Wall.top) stops street cars up to `drop` m below the lip. `lead` m of straight run
         * the last bend and the ramp's toe. Landing zone: the run-up speed bound is the last bend
         * taken at bendSpeed then launchAccel to the lip (full throttle and nitrous, as measured
         * on the car park), its flight reach plus `rollout` m of road, all landingClear m short of
         * the next junction; the flight corridor spreads spreadDeg each side of the leg. `chance`
         * is the share of cuts planned as jumps (a jump only happens where its landing fits).
         */
        jump: {
          chance: 0.62,
          exitDeg: 28,
          rise: 2.2,
          length: 22,
          lipBack: 2,
          drop: 1.0,
          lead: 8,
          bendSpeed: 20,
          launchAccel: 6,
          rollout: 25,
          landingClear: 15,
          spreadDeg: 6,
        },
      },
    },
    /**
     * Multi-storey car park shortcut (src/city/districts/carPark.ts): where a
     * route turns at a junction with no street straight behind it, a car park
     * in the block behind the junction lets racers turn off an earlier street
     * of the route, climb a ramp to the roof, cross it and leave over a kicker
     * at the end of a walled launch chute that points straight down the street
     * the route turns into. Sizes in m.
     */
    carPark: {
      enabled: true,
      /** Car parks per route at most (most seeds have a site for at most one). */
      perRoute: 1,
      /**
       * Height of the drivable floor above the street (m): the garage's first parking floor, over a
       * tall street level podium; the levels above it are drawn only (render/districts/carPark.ts).
       */
      deckHeight: 6.4,
      /** Ramp grade range (rise per m): the ramp is as long as the site allows between them. */
      rampGrade: [0.065, 0.15],
      /**
       * The ramp's grade plus the ground's own rise along it stays under this: a climb taken flat out,
       * whose crest at the top (eased over rampEase) does not throw a fast car's front wheels off the deck.
       */
      maxClimb: 0.12,
      /** Each end of the ramp eases in over this length (vertical curves: no launch at the top). */
      rampEase: 7,
      /** Between the ramp's walls (m): two cars wide and then some, so it is taken at speed. */
      rampWidth: 9,
      /**
       * Launch chute: width between its walls and length up to the lip. A car (1.9 m wide) can cross
       * it corner to corner at atan((width - 1.9) / length), the worst launch heading error.
       */
      chuteWidth: 5.8,
      chuteLength: 38,
      /** The chute's mouth on the deck splays out into a funnel this long, this much wider each side (m). */
      chuteFunnel: [7, 2.6],
      /**
       * Side entries: the funnel flares this much more (m) on the side the turn arrives from, so a car
       * cutting in early is caught and steered in rather than stopped by the wall's end.
       */
      funnelArrive: 2.2,
      /** Kicker over the last kickLength of the chute, rising kickHeight, steepest at the lip (~10 deg). */
      kickLength: 8,
      kickHeight: 0.75,
      /** Turn radius on the roof between the ramp and the chute (side entries), [min, target]. */
      turnRadius: [14, 18],
      /** Straight roof run between the ramp top and the chute (back entries), [min, target]. */
      deckRun: [8, 16],
      /** Roof margin beside the chute and the ramp (m): the drive's own box, the least the floor holds. */
      deckMargin: 4,
      /**
       * The garage takes its block: its footprint is the block's building line (inset) when the block is
       * convex and that area (m^2) is within this range. A bigger block is cut down to the top of the
       * range behind (or beside) the drive, and a concave one gets the largest frame rectangle grown
       * from the drive's box, so the garage never stands on a street or grows comically large.
       */
      blockArea: [2500, 30000],
      /** Parking aisle between facing rows of stalls on the floor (m); the floor's bays are stall deep each side of it. */
      aisle: 6.5,
      /** Parapets and chute walls (thin two sided solids) are this thick. */
      wall: 0.4,
      /** The deck and ramp stop this far inside the building line, so the sidewalk never samples their height. */
      inset: 0.25,
      /** The structure keeps this far inside the block from every building line it does not front. */
      clear: 2,
      /** Junction turn at the landing street (deg) and the cone behind it that must be free of streets (deg). */
      minTurnDeg: 50,
      behindDeg: 30,
      /** The entry keeps this far from the entry street's junctions (m), railClear from one whose corner rail is on its side. */
      entryNodeClear: 32,
      railClear: 50,
      /** Rolling room past the furthest landing, on a straight free of junctions (m). */
      rollout: 30,
      /**
       * Launch speed bound for the landing zone: the roof turn taken at turnGrip g on a radius turnSlack
       * wider than planned (side entries) or entrySpeed at the ramp's foot (back entries), then
       * launchAccel (full throttle and nitrous, measured: 14.6 m/s at the chute's mouth leaves the lip
       * at 26 m/s and lands 45 m out) along the run-up. m/s, m, m/s^2.
       */
      turnGrip: 1.2,
      turnSlack: 6,
      launchAccel: 6,
      entrySpeed: 25,
      /** It saves at least this share of the route distance it skips (an L through the block: 3-15%). */
      minSave: 0.03,
      /** Clearance (m) from the flight corridor to closures, corners and props. */
      flightClear: 1.5,
      /**
       * The drivable floor's fittings (carParkFloor): stalls (width, depth m) nose in along the
       * parapets, a parked car in parkedShare of them, a column at the inner end of every
       * columnEvery stalls, a stair core (side m) in a free corner; all keep aisleClear (m) from the
       * racing line, off the exit lane and the ramp's mouth, so the drive is an open aisle.
       */
      stall: [2.6, 5],
      parkedShare: 0.55,
      columnEvery: 3,
      core: 5.2,
      aisleClear: 6,
    },
    park: {
      enabled: true,
      count: [2, 3],
      minArea: 7000,
      maxArea: 34000,
      /** Rolling hill height (m) and how far from the park edge it rises from flat (m). */
      hill: 2.6,
      hillEdge: 16,
      treeSpacing: 15,
      treeRadius: 0.4,
      /** A small wood in each park: radius range (m) and its denser tree spacing (m). */
      groveRadius: [15, 22],
      groveSpacing: 6,
      /** One cluster of drive-through bushes per this much park area (m^2); a park with a race pass through it keeps at least minBushes. */
      bushClusterArea: 800,
      minBushes: 14,
      /** Footpath loop this far inside the park edge (m), with a bench every benchSpacing m. */
      pathInset: 11,
      benchSpacing: 36,
      /** Lantern posts along the footpath's outer side, about this far apart (m); one stands at every path corner. */
      lampSpacing: 24,
      /**
       * Race passes (park.ts parkPasses, districts/passes.ts): a route turning round a corner of the
       * park block cuts through the park on a cobbled path instead, bowed in from the corner toward
       * the park's middle. Parks go on the blocks the routes turn round first. The path's width (m);
       * how far from the corner it leaves and rejoins the street [min, max], tried every passStep
       * (m), as far as the route runs along the block's side less the clearances (passes.ts
       * PassClear: before a junction run straight across, before a shortcut's mouth, after a junction
       * the route turns at, m); its sharpest bend (deg); how far its middle is pulled from the chord
       * between its street ends toward the park's middle (fractions, the first that fits wins);
       * the room it keeps inside the park edge beyond its half width (m), earned at passEntry m per
       * metre from where it crosses the edge (the sine of the shallowest way in); and how far trees,
       * bushes and furniture keep off its edge (m).
       */
      pathWidth: 8,
      passReach: [30, 130],
      passStep: 8,
      passJunctionClear: 28,
      passMouthClear: 12,
      passTurnClear: 8,
      passMaxTurn: 70,
      passPulls: [1, 0.8, 0.6, 0.45, 0.3, 0.15],
      passMargin: 5,
      passEntry: 0.7,
      passVerge: 1.5,
      /**
       * Where a pass crosses the sidewalk the curb is cut the whole sidewalk deep (busBays.ts
       * mouthBay): the cut spans the path's footprint plus mouthMargin each side (m) and flares
       * out over mouthFlare more (m; less where the block side is short, none below mouthMinFlare,
       * and then no cut). At the park edge a stone gate pier (gatePier m square, gatePierHeight
       * tall, solid) stands each side of the opening, set gatePierBack m into the park; a lantern
       * post gateLampOut m further along the edge, a planter pot on the sidewalk just before each
       * flare, and bollards along the flared curbs gateBollardBack m behind them.
       */
      mouthMargin: 0.5,
      mouthFlare: 5,
      mouthMinFlare: 2,
      gatePier: 0.8,
      gatePierHeight: 1.9,
      gatePierBack: 0.7,
      gateLampOut: 2.2,
      gateBollardBack: 0.7,
      /**
       * Variants (park.ts, parkFeatures.ts), drawn per park from its own stream: weights of 'woodland'
       * (the groves), 'formal' (a garden on a cross or a diagonal) and 'lakeside' (a pond), each divided
       * by variantRepeat for every park of the city that already has it, so a city usually mixes two. A
       * park too small or too steep for its variant falls back to woodland (a pond finds a level, hill-free
       * spot in about a third of the parks drawn for it, hence its larger weight). Woodland packs its trees at
       * woodlandSpacing (m) and plants woodlandGroves woods.
       */
      variants: { woodland: 0.3, formal: 0.3, lakeside: 0.4 },
      variantRepeat: 3,
      woodlandSpacing: 13.5,
      woodlandGroves: 2,
      /**
       * Formal garden: the gravel axes (width m) leave a plaza (radius m, the fountain basin's radius and
       * height in it) for the footpath loop, a low hedge of bushes (every hedgeStep m, hedgeOff m off the
       * axis edge) down both sides. In each quadrant a parterre (flower bed) lies hedgeGap m off the
       * axes, up to bedMax m on a side, at least bedMin, bedEdge m inside the park edge; its two outer
       * sides are tall hedges (solid, hedgeThick m thick, hedgeHeight m tall, with a hedgeDoor m gap
       * in the middle of each side). A pass keeps bedPassClear m off
       * every bed. The park needs formalInradius m from its middle to its edge. Trees stand treeShare of
       * the usual grid on the lawn outside the garden.
       */
      formal: { axisWidth: 4.5, plazaRadius: 7.5, basinRadius: 4.2, basinHeight: 0.55, hedgeStep: 2, hedgeOff: 1.3, hedgeGap: 3.4, bedMax: 24, bedMin: 11, bedEdge: 14, hedgeThick: 1.1, hedgeHeight: 1.9, hedgeDoor: 4.6, bedPassClear: 6, formalInradius: 30, treeShare: 0.45, potRing: 2.6 },
      /**
       * Lakeside pond: an ellipse (major semi-axis `radius` [min, max] m at the waterline, minor/major
       * `aspect` [min, max]) levelled into the terrain. Out from its middle, in metres along the major
       * axis: a flat bed, a smoothstep bowl `bowl` m wide up to the bank's crest (`depth` m deep, the
       * waterline `freeboard` m under the crest), a level bank, then a blend back into the terrain over
       * `blend` m, past which the park's hills (scaled by hillScale) fade in over hillFade m. The site is the
       * flattest spot on a `siteStep` m grid whose terrain strays at most `maxRange` m from the crest level
       * over the blend, `margin` m clear of the park edge and the race passes. The jetty is `jettyWidth` m
       * wide and reaches `jettyReach` m into the water, its deck `deckRise` m over the water; `benches` sit on
       * the bank facing the water, a gravel ring `ring` m out from the crest; reeds stand every `reedStep` m
       * of the shore; treeShare of the usual grid is planted on the lawn.
       */
      lakeside: { radius: [10, 13], aspect: [0.8, 1], depth: 0.4, bowl: 10, blend: 20, freeboard: 0.12, hillScale: 0.35, hillFade: 28, maxRange: 0.8, siteStep: 4, margin: 5, jettyWidth: 2.2, jettyReach: 7.5, deckRise: 0.5, benches: 4, ring: 4, reedStep: 3.2, treeShare: 0.5 },
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
      /**
       * Lantern posts along the back of plazas and corner pockets, this far in from the back and the
       * ends (m); pockets longer than lampPairLen get one at each end, shorter ones one in the middle.
       */
      lampInset: 1.1,
      lampPairLen: 11,
      /**
       * Parking lots: lamp posts along the back row (the far side from the street's lights), about this
       * far apart (m), lampInset in from the back and the ends; every lot gets at least two.
       */
      lotLampSpacing: 17,
      /**
       * Alleys (raceway alleys and back alley shortcuts) never get a lot, plaza or verge on their
       * sides: a recess with square ends is a trap a racer slides into and a flat wall to get stuck
       * on. Their void frontage becomes an alley bay instead: the alley widens into a cobbled recess
       * whose two ends taper back to the wall at bayTaperDeg, so a car riding the wall is funnelled
       * back into the lane. Depths tried deepest first (m), with at least bayMinBack m of straight
       * back wall between the tapers; the rest of the void stays a flush planter or boundary wall.
       * Corner pockets at an alley's mouth stay (a racer may cut across one into the alley) but are
       * never solid or fountained, and their end along the alley tapers the same way.
       */
      bayChance: 0.6,
      bayDepth: [3.5, 2.5],
      bayMinBack: 6,
      bayTaperDeg: 30,
    },
    /** Reserved unique features, documented placeholders (plan nothing yet). */
    /**
     * Hills: clusters of adjacent blocks lifted on a smooth dome or ridge with
     * a flat top (a basin now and then), so the streets up its flanks climb,
     * crest and drop (src/city/districts/hills.ts).
     */
    hills: {
      enabled: true,
      /** Hills asked for per city; fewer place when the river, the El and roundabouts leave no room. */
      count: [2, 3],
      /** Adjacent blocks per hill [min, max]. */
      blocks: [2, 4],
      /** Summit height above the surrounding ground (m), [min, max]; a hill that does not fit is lowered toward the minimum. */
      height: [8, 16],
      /** Steepest grade of the flanks (rise per m); the slope width follows from the height. */
      maxGrade: 0.11,
      /** The plateau stops this far inside the cluster's outline, so its boundary streets sit just past the crest (m). */
      inset: 30,
      /** A ridge plateau is this wide across (m); domes cover the whole cluster. */
      ridgeHalfWidth: 26,
      ridgeChance: 0.4,
      /** Share of hills that are a basin (the same profile, sunk) instead of a dome. */
      basinChance: 0.2,
      /** The slopes keep this far from the river channel, roundabouts and the monument plaza (m). */
      clearance: 15,
      /** Two hills' slopes may overlap by this fraction of their widths, where both are nearly flat. */
      overlap: 0.2,
      /** The area polygon (minimap, areaAt) reaches this fraction of the slope width out from the plateau. */
      reach: 0.85,
      /**
       * San Francisco (hills.ts terraced): on this share of seeds, rolled from a stream of its own, one hill
       * is a stepped pyramid on a summit junction instead: `tiers` steps of `step` m (min, max) down to the
       * rings of junctions one and two blocks out, every junction on a level table `flat` m either side of
       * it, the streets between climbing on a ramp eased over `ease` m at each end (the crest a fast car
       * takes off from), contours a rounded square (exponent `p`, a power of two: the rings' corner junctions
       * stand 2^(1/p) further out). The ramps' grade is the step over the block less the tables and an
       * ease: 10-13 m over 84 m, 12-15.5%; a crest eased over 10 m throws a car from about 90 km/h.
       */
      terraced: { chance: 0.3, tiers: 2, step: [10, 13], flat: 23, ease: 10, p: 32 },
    },
    /**
     * Monument: one plaza block near the center with a floodlit landmark on a
     * solid base (src/city/districts/monument.ts).
     */
    monument: {
      enabled: true,
      chance: 0.6,
      /** Plaza block area (m^2) and how far from the city center it may be (m). */
      minArea: 8000,
      maxArea: 24000,
      reach: 380,
      /** Base radius (m) and the width of the step rings around it (m): the outer step edge is the collision. */
      base: 6.5,
      steps: 3.4,
      /** Landmark heights above the base (m). */
      obelisk: 30,
      column: 21,
      arch: 15,
      /** Arch: pier width across the opening and depth along it, and the drive through gap between the piers (m). */
      pierWidth: 4.2,
      pierDepth: 6.5,
      archGap: 10,
      /** Destructible planter pots ring the steps this far out (m), benches further out. */
      potRing: 6,
      benchRing: 12,
      /** Lantern posts this far inside the plaza edge, about lampSpacing apart along each side (m). */
      lampInset: 2.4,
      lampSpacing: 20,
      /** The plaza rises this much (m) toward the landmark from a circle inscribed in it, domeInset (m) in from its edge: paving that pitches the car a little. */
      rise: 0.5,
      domeInset: 3,
      /** Flower beds (bush clusters) per plaza [min, max], this far out from the steps (m); a pot where each of the paving's radial lines ends, potInset in from the edge (m). */
      beds: [5, 7],
      bedRing: 9,
      potInset: 7,
      /** A cafe in one corner: its cart stands cafeInset (m) in from the corner with cafeTables [min, max] around it. */
      cafeInset: 9,
      cafeTables: [4, 6],
      /**
       * Race passes (monument.ts plazaPasses): a route turning round a corner of the plaza block cuts
       * across the paving instead, round the obelisk's or column's steps (the landmark the apex of
       * the turn) or straight through the arch. The first pass places the landmark, at the middle of
       * the chord between where it leaves and rejoins the streets or deeper (passCornerDeep). The racing line's width (m); how
       * far from the corner it leaves and rejoins the street [min, max], tried every passStep (m),
       * as far as the route runs along the block's side, less passJunctionClear (m) before a junction
       * the route runs straight across, passMouthClear before a shortcut's mouth and passTurnClear
       * after a junction it turns at; its sharpest bend (deg); how far it runs straight either side
       * of the arch's piers (m); the furthest its nearest point may lie from the corner (m: a car that
       * goes round by the street stays inside the race's lost limit, sim/race.ts LOST); and how many
       * candidate blocks (nearest the center first, out to TOUR_REACH) are tried for one.
       */
      passWidth: 9,
      passReach: [36, 120],
      passStep: 6,
      passJunctionClear: 28,
      passMouthClear: 12,
      passTurnClear: 8,
      passMaxTurn: 72,
      passApproach: 11,
      passCornerMax: 60,
      /** How much deeper than its chord's middle a corner pass's first landmark may stand, away from the corner (m): room off the plaza's edge for short streets. */
      passCornerDeep: [0, 8, 16, 24],
      passSites: 40,
      /**
       * A second route's U cut must agree with the landmark the first placed: its line within
       * passFitSlack (m) of where the landmark wants it, along the arch's axis within passFitDeg (deg).
       */
      passFitSlack: 2,
      passFitDeg: 8,
      /** A U cut turns off one street and onto the other about as squarely as the two corners it replaces: its own bend cap (deg). */
      passUcutMaxTurn: 96,
      /** Added to a pass's sharpest bend when the shapes compete for a route (deg): a U cut crosses the whole plaza and wins over a corner pass. */
      passShapeBias: { corner: -12, ucut: -70 },
      /** ... and a pass straight enough for a start grid on it (route.ts PASS_START_RUN) is worth this much (deg). */
      passStartBias: -15,
      /**
       * How candidate blocks rank for the plaza (plan): points per route served, for a U cut and for a
       * corner pass among their passes, less perMetre per metre from the city center.
       */
      passSiteGrade: { route: 100, ucut: 40, corner: 12, perMetre: 0.1 },
    },
    /**
     * Tunnels (src/city/districts/tunnel.ts): a street runs for part of one
     * block through a lit bore, under an "air rights" building that straddles
     * it or under a rocky ridge raised across it. Inside, a raised walkway
     * runs from each curb to the tunnel wall; outside, wingwalls flare from
     * the walkway back out to the building line.
     */
    tunnel: {
      enabled: true,
      /** The chance a city has no tunnel at all (cities should not all look alike). */
      noneChance: 0.2,
      /** Tunnels under a building per city [min, max], and the chance of one under a ridge. */
      buildings: [1, 2],
      ridgeChance: 0.65,
      /** Bore length along the street (m), [min, max]. */
      buildingLength: [36, 58],
      ridgeLength: [46, 64],
      /** Ceiling above the road (m), and the slab or rock shell above it at the portals (m). */
      clearance: 6.2,
      slab: 0.8,
      /** Raised walkway inside, curb to tunnel wall (m). */
      walkway: 1.1,
      /** Portal wingwalls flare from the walkway out to the building line over this run along the street (m). */
      wing: 6.5,
      /** The wingwalls end at least this far beyond a junction's reach (closures, corner rails) (m). */
      nodeGap: 3,
      /** Air rights building: how deep each leg reaches behind the building line (m) and storeys above the ceiling. */
      legDepth: [13, 19],
      floors: [3, 8],
      /** Ridge: summit above the road (m), flank width (m), plateau half width across the street (m), rock over the portals (m). */
      ridgeHeight: [17, 25],
      ridgeFlank: 24,
      ridgeHalfWidth: [22, 40],
      portalCover: 2.6,
      /** The ridge rises behind the street's building line over this run (m), hidden by the rock face. */
      maskRamp: 4.5,
      /** The ridge's flanks keep this far from other streets' sidewalks (m). */
      ridgeClear: 6,
      /** Bores and ridges keep this far from the river channel, the El, hill slopes and roundabouts (m). */
      siteClear: 14,
    },
    /**
     * Overpasses (src/city/districts/overpass.ts): structures you drive
     * under. A short freeway viaduct crosses one to three streets mid-block
     * on hammerhead piers standing on the sidewalks, its ends buried in
     * abutments inside the blocks.
     */
    overpass: {
      enabled: true,
      /** Chance of a viaduct per city, and how many streets it crosses [min, max]. */
      viaductChance: 0.85,
      crossings: [2, 3],
      /** Deck width (m), underside above the road (m) and girder depth (m). */
      deckWidth: 13,
      deckClearance: 7.2,
      deckDepth: 1.8,
      /** Street piers: center behind the curb (m), size along the street and across it (m). */
      pierSetback: 1.8,
      pierLength: 2.6,
      pierThick: 1.3,
      /** Piers inside blocks, about this far apart along the deck (m). */
      pierSpacing: 24,
      /** A viaduct crosses a street at least this steeply (deg from parallel). */
      minCrossDeg: 58,
      /** Abutment block at each end, along the deck (m). */
      abutment: 9,
    },
    /**
     * Elevated highway (src/city/districts/highway/): an expressway on a deck
     * crossing the city west to east along a row street, swinging to the next
     * row once or twice on a diagonal street of its own, drivable in free roam
     * (closed in races). At each end both carriageways leave it on cloverleaf
     * loops down to the street beneath; along it, interchanges (an off-ramp
     * and the on-ramp right after it, slip ramps alongside the deck) lead
     * down to and up from that street. Every street under the deck is widened
     * to carry it, so cars
     * drive under it all the way along; deck and street are two levels
     * (districts/types.ts DeckSpan), its columns stand on the sidewalks, and
     * the frontage under the ramps' lanes is an alley.
     */
    highway: {
      enabled: true,
      /** Chance per city, the first draw of the module's own stream (highwayRolled). */
      chance: 0.6,
      /**
       * Deck width (m): the median, then each way an inner shoulder, three lanes, an outer shoulder and
       * the parapet. 0.8 + 2 * (1.2 + 3 * 3.6 + 3.15 + 0.45) = 32: the outer shoulder is what is left.
       */
      deckWidth: 32,
      /** Lanes each way and their width (m), the inner shoulder by the median (m), the median barrier's width (m). */
      lanes: 3,
      lane: 3.6,
      innerShoulder: 1.2,
      median: 0.8,
      /** Deck underside above the smoothed ground (m), clear of the start gantry (11.9 m), and the deck's depth (m). */
      clearance: 12,
      depth: 1.5,
      /** Over the El the underside clears the El's tie top by this much (m): its trains, track lamps and station canopies. */
      elClear: 5.8,
      /** The hump over the El eases in and out at this grade at most (rise per m). */
      humpGrade: 0.025,
      /** Bents: a square column on each sidewalk this far behind the curb (m), this size (m), about this far apart (m). */
      columnSetback: 2,
      columnSize: 1.3,
      bentSpacing: 34,
      /**
       * Swings to the next row [min, max] per seed, each a straight diagonal street of its own across
       * one block, corner to corner (about 45 degrees off the row, like the city's diagonal avenues: a
       * shallower one leaves its junctions' corners longer than the street pieces beside them).
       */
      swings: [1, 2],
      /** The deck turns onto and off a swing's diagonal on an arc from this far before the junction to this far past it (m), at least swingRadius (m) round. */
      swingTangent: 36,
      swingRadius: 70,
      /** Sectors at a swing's junctions stay at least this wide (deg): a little over the city's minSectorDeg. */
      swingSectorDeg: 25,
      /** Near a swing's turns (where the deck cuts the corner), buildings and infill keep this far beyond the deck's edges (m). */
      blockMargin: 3,
      /**
       * Median crossovers: a gap in the median about this far apart (m), this long (m: room to swing
       * across at speed), clear of the ramps' lanes and the end loops' V by `crossoverClear` (m).
       */
      crossoverEvery: 330,
      crossoverLength: 80,
      crossoverClear: 40,
      /**
       * Interchanges per highway [min, max]: by a junction of the street beneath, on one side of the deck,
       * an off-ramp coming down alongside the deck to run along the street at its level just before the
       * junction and slip into its lanes, and the on-ramp peeling off the street just after it to climb
       * alongside and merge. Two lane one way roads, their lanes along the deck's edge beyond.
       */
      interchanges: [1, 3],
      /**
       * A slip ramp's run along the street at its level, beside the cut sidewalk (m), the grade it climbs
       * at where the deck has room for it (rise per m), and its vertical curve at the foot (m: shorter than
       * the top's, where it meets the deck at full speed).
       */
      slipFlat: 18,
      slipGrade: 0.095,
      slipFootEase: 30,
      /**
       * Ramp: half width between its walls (m), grade caps (rise per m: the gentle one every line is tried
       * at first, the steeper one only for a hilly city where no line has its ramps under the first), and
       * a slip ramp's vertical curve at its top (m), where a car meets it at full speed off the deck.
       */
      rampHalf: 4.2,
      rampGrade: [0.125, 0.15],
      rampTopEase: 52,
      /**
       * The lanes along the deck's edge: the ramp's inner wall runs on along the deck's edge (the gore,
       * m), then an on-ramp's acceleration lane runs alongside at full width (m) and an off-ramp's
       * deceleration lane (m), either tapering back to the deck's edge (m) at its far end.
       */
      rampGore: 8,
      rampMerge: 100,
      rampDiverge: 80,
      rampTaper: 50,
      /** Where the deck has no room for a lane's full length it is cut short, to no less than this at full width (m). */
      rampLaneMin: 30,
      /** A ramp's top keeps this far from the El crossing along the deck (m; its hump is planned for), and lanes on one side of the deck this far apart (m). */
      rampElClear: 60,
      rampGap: 40,
      /**
       * The end loops (cloverleaf leaves): at each end of the deck the outgoing carriageway curls off to
       * its right on a loop of about 270 degrees down to the street beneath, and the incoming one comes up
       * on its mirror across the street. Half width between the walls (m), the radii tried (m, the widest
       * that fits), and the V between them (m): where the median ends and its barriers fan out to the
       * loops' outer walls.
       */
      loopHalf: 6,
      loopRadius: [46, 42, 38, 34, 30],
      loopGore: 45,
      /**
       * A loop's vertical curves at its foot and its top (m): far shorter than a side ramp's, since its
       * turn holds a car to well under the speed either would launch or bottom it out at.
       */
      loopEase: 24,
      /** A loop's or slip ramp's mouth keeps this far past the cross street's corner along the street beneath (m): it is shut in a race, so no closure or corner rail meets it. */
      loopMouthClear: 5,
      /** The alleys under the lanes: paved from the building line this deep (m), walled at the back. */
      alleyDepth: 7.6,
      /** Sign gantries over the carriageway about this far apart along the deck (m). */
      signEvery: 360,
    },
    /**
     * Night market: a straight run of route street closed to traffic for race
     * night, lantern lit stalls along both curbs and a crowd packed behind a
     * rail (src/city/districts/market.ts). Planned on the routes themselves
     * (planMarkets, from the topology hook in world.ts planRoads).
     */
    market: {
      enabled: true,
      /** Chance a city has a market; up to `max` per city, a second one only for the route the first misses. */
      chance: 1,
      max: 2,
      /** Consecutive route street edges per market, each at least minEdge long, the run minLength to maxLength (m). */
      chain: [1, 3],
      minEdge: 80,
      minLength: 110,
      maxLength: 320,
      /** The run bends at most this much at a junction (deg). */
      maxBendDeg: 10,
      /** A route's start and finish keep this far (m along the route) from a market: grid, gantries, the gate crowds. */
      startClear: 120,
      finishClear: 90,
      /**
       * Carriageway curb to curb (m): the street's corridor stays as it was, so its sidewalks widen
       * into the market floor ((13 - 9) / 2 = 2 m each). Route segWidth and the racing line follow.
       */
      width: 9,
      /** Half width of the clear lane down the middle (m): nothing of the market reaches into it. */
      clearHalf: 3.3,
      /**
       * Stalls start this far past where the streets at a junction reach into the market (the alley
       * mouth rule); the pens (rail and crowd) further still, past the corner rails of a turning
       * route (ROUTE.railReach past the building corner) and any corner pocket (infill.cornerReach).
       */
      stallClear: 8,
      penClear: 16,
      /**
       * Pens also start this far past where the building lines start at a junction (m): when the
       * other route crosses the market there, its closure stands up to 1.5 m plus
       * ROUTE.barrierSetbackHeadOn past that line (routeBarriers.ts mouthBarrier), deep at a five way junction.
       */
      closureClear: 11,
      /** A pen shorter than this (m) is left out: a short block gets stalls and no crowd. */
      penMin: 18,
      /** Crowd rail this far behind the curb (m); the pen behind it reaches to the building line. */
      railSetback: 3,
      /** Stall pitch along the curb [min, max] (m); stall and cart centers this far behind the curb (m). */
      stallPitch: [2.6, 3.3],
      stallSetback: 1.55,
      cartSetback: 1.15,
      /** Stalls in a row before an aisle [min, max], and the aisle width [min, max] (m). */
      row: [3, 6],
      aisle: [1.6, 3.2],
      /** A slot is a food cart instead of a stall; fruit crates spill onto the road edge in front of a stall. */
      cartChance: 0.14,
      spillChance: 0.4,
      /** Lantern masts on the rail every mastStep m, alternating sides (render/districts/market.ts strings). */
      mastStep: 9,
    },
    /**
     * Waterfront (src/city/districts/waterfront.ts): one side of the map
     * becomes a harbor. Past the outermost street the frontage opens onto a
     * drivable quay, a railing runs along the sea wall, and beyond it the
     * ground drops under open water out to the horizon, with jetties, gantry
     * cranes, container stacks and a moored ship as its skyline.
     */
    waterfront: {
      enabled: true,
      /** Chance per city, the first draw of the module's own stream; a city whose every side is crossed (the El, the river, the expressway) gets none. */
      chance: 0.36,
      /**
       * The sea wall: the outer frontage's furthest reach within `dilate` m along the side, box smoothed
       * over `smoothSpan` m, sampled every `step` m, plus `quayWidth` m (the narrowest the quay gets: the
       * samples are pushed out wherever the smoothing cut inside it).
       */
      quayWidth: 13,
      dilate: 70,
      smoothSpan: 120,
      step: 16,
      /** The quay reaches at most this far back from the sea wall (m): a deeper recess of the frontage (a missing outer street) is a warehouse. */
      maxDepth: 34,
      /** A recess shallower than this past maxDepth (m: beside a roundabout's bulge, say), or narrower than `shedMinWidth` (m), stays quay. */
      shedMinDepth: 18,
      shedMinWidth: 24,
      /** Warehouse sheds: eaves height range (m). */
      shedHeight: [8, 12],
      /** The quay runs at least this far along its side (m). */
      minLength: 520,
      /** The El and its run-off, the river's channel end, the expressway's deck: anything else past the frontage keeps this far along the side from the harbor (m). */
      clearance: 45,
      /**
       * A side the races run along wins: its score gains `raceBonus` (m of quay) per route node (either route,
       * up to 12) within `raceReach` m in from the quay's back.
       */
      raceBonus: 45,
      raceReach: 22,
      /**
       * The water: the least height of the quay over it (m), its depth at the sea wall (m), and the
       * steepest tilt along the coast (rise per m) it follows the ground with, so a long side does not
       * stand its wall metres high at one end. The sea wall's face drops over `wallFall` m.
       */
      freeboard: 1.7,
      depth: 4,
      maxTilt: 0.012,
      wallFall: 1.2,
      /**
       * Open water reaches `reach` m out (the lowered ground; the far edge fades back over `fadeOut` m) and,
       * past an open end of the side, runs on along the coast for `runOn` m: a render only quay beyond the
       * city's corner, `quayRun` m of it furnished.
       */
      reach: 760,
      fadeOut: 120,
      runOn: 820,
      quayRun: 360,
      /** A closed end's breakwater: the ground falls across it over `mole` m (m), and it runs out [min, max] m. */
      mole: 16,
      moleLength: [150, 260],
      /** The railing stands this far in from the quay's edge (m). */
      railInset: 0.5,
      /** Quay lanterns (destructible park lamps) every `lampStep` m along the edge, this far in from it (m). */
      lampStep: 32,
      lampInset: 1.8,
      /**
       * The quay as a dock yard to drive (districts/waterfrontYard.ts), all distances in m and `d` measured in
       * from the sea wall's edge:
       *  - `lane`: the lane along the water from d lane[0] to lane[1], where nothing stands that can stop a car
       *    (soft clutter only: pallets, crates, drums), the quay's through way end to end;
       *  - mouths onto every street that meets the quay (a junction or a street's end within `mouthReach` of the
       *    frontage past its own half width and sidewalk): at least `mouth` wide, or the street's width plus
       *    `mouthPad`, cobbled `mouthDepth` onto the quay, between two steel gate posts (`post` square, solids)
       *    carrying a string of bulbs; never in front of a warehouse;
       *  - chain-link fence runs (fence panels) `fenceInset` onto the quay along the frontage, `fencePitch` apart,
       *    runs of fenceRun [min, max] panels with fenceGap [min, max] between, starting at every gate post;
       *  - loading ramps, ramps [min, max] of them `rampGap` apart: `rampHeight` high, rising and falling over
       *    `rampRun` each way (a smoothstep: the steepest slope is 1.5 x height / run = 6%, the terrain rule)
       *    with a `rampTop` flat top, the full quay deep where it is at least `rampDepth` (fading over `rampBack`
       *    in from the frontage, so the sidewalk is never lifted);
       *  - the skid pad, a drift zone on the deepest stretch: radius pad [min, max] from the lane's sea edge,
       *    `padMargin` off the frontage, nothing standing within `padClear` of it;
       *  - the container lane (working docks only): two staggered rows of maze [min, max] containers (`box`
       *    long and wide) mazeGap [min, max] apart along the quay, the first row 1 m inside the lane, the
       *    second `mazeCorridor` behind it, `mazeBack` off the frontage;
       *  - forklifts [min, max] parked off the lane (`forklift` long and wide, solids);
       *  - soft clutter clusters in the lane every clutterStep [min, max] along the quay, each within
       *    `clutterBand` of one side of the lane (so a clean line weaves past), benches facing the water in
       *    `benchChance` of the lamp gaps.
       */
      yard: {
        lane: [2.6, 11],
        mouth: 16,
        mouthPad: 6,
        mouthReach: 4,
        mouthDepth: 5,
        post: 0.36,
        fenceInset: 1.4,
        fencePitch: 2.5,
        fenceRun: [3, 7],
        fenceGap: [7, 16],
        ramps: [1, 2],
        rampHeight: 0.8,
        rampRun: 20,
        rampTop: 5,
        rampDepth: 15,
        rampBack: 6,
        rampGap: 140,
        pad: [9, 13],
        padMargin: 3,
        padClear: 1.5,
        maze: [3, 5],
        mazeGap: [6.5, 8.5],
        mazeCorridor: 6,
        mazeBack: 3,
        box: [12.2, 2.44],
        forklifts: [1, 2],
        forklift: [2.6, 1.25],
        clutterStep: [40, 70],
        clutterBand: 3.8,
        benchChance: 0.3,
      },
      /**
       * Jetties (render only, behind the railing's closed gates) [min, max] per harbor, their length and
       * width [min, max] (m), at least `jettyGap` m apart along the coast.
       */
      jetties: [2, 4],
      jettyLength: [50, 95],
      jettyWidth: [18, 26],
      jettyGap: 150,
      /** Gantry cranes: rail gauge (m), height of the boom (m) [min, max]; per jetty [min, max], and along a run on quay every `craneStep` m. */
      craneGauge: 16,
      craneHeight: [38, 52],
      cranesPerJetty: [1, 2],
      craneStep: 70,
      /** Chance a jetty has a ship moored alongside, and a ship's length [min, max] (m). */
      shipChance: 0.6,
      shipLength: [110, 170],
      /** Channel buoys out on the water [min, max], and how far out they float [min, max] (m). */
      buoys: [3, 6],
      buoyReach: [60, 260],
      /**
       * The marina variant (a harbor that is leisure moorings, not working docks): the chance a waterfront is one
       * (its own stream, so a harbor seed plans exactly as before). Floating pontoons [min, max] per marina, their
       * spine length [min, max] and gangway width (m), at least `pontoonGap` m apart along the coast; the slips
       * either side of a spine are `slipPitch` m apart and `slipLength` m [min, max] long, a boat in `slipFill` of them.
       * The yacht club (width x depth over the water, m) and the fuel dock (length, m) stand clear of the pontoons by
       * `clubClear` m; `bollardStep` m between the quay edge's bollards (destructible props); `bollardInset` m in from the edge; `stringStep` m between the
       * string light posts along the railing; the boardwalk is `boardwalk` m wide, along the edge `boardwalkInset` m inside the railing's line.
       */
      marinaChance: 0.45,
      pontoons: [2, 4],
      pontoonLength: [34, 64],
      gangway: 3.6,
      pontoonGap: 85,
      slipPitch: 6.4,
      slipLength: [11, 15],
      slipFill: 0.66,
      club: [24, 13],
      fuelLength: 20,
      clubClear: 34,
      bollardStep: 9,
      stringStep: 26,
      boardwalk: 3.4,
      bollardInset: 1.2,
      boardwalkInset: 0.9,
      /**
       * The beach variant (districts/waterfrontBeach.ts): a waterfront that is sand and a boardwalk, not a dock
       * yard. The chance a waterfront is one (its own stream) is `chance.miami` in a Miami home (shared/home.ts)
       * and `chance.other` elsewhere; a rolled beach still needs a stretch of a side at least `minLength` m long whose ground is
       * within `maxResidual` m of the sand's profile at the dune edge (the stretch is the longest such window of the free side,
       * its ends closed by breakwaters), and no warehouse in its frontage, else the waterfront is the harbor it would have been. All distances in m, `d` measured in from the waterline:
       *  - the coast is pushed `quayWidth` out from the frontage (the narrowest the beach gets: `sand` of sand and a
       *    boardwalk of at least the rest); a recess deeper than `maxDepth` would be a warehouse;
       *  - the sand: `sand` wide, from the waterline to the dune edge, rising `slope` (2.5%) from the water's
       *    surface, blended into the street's ground over `blend` m (the whole sand: the dune edge keeps the street's ground); past the waterline the seabed shelves
       *    down to `CFG.depth` over `shelf` m. The surf wall ('surf') stands `surfInset` m up the sand;
       *  - mouths as the yard's, a street ending up to `mouthSlack` m short of the frontage's depth counts;
       *  - dunes [min, max]: ridges `duneHeight` high across the dune edge, crest `duneCrest` m seaward of it, rising
       *    and falling over `duneRun` (a smoothstep: 1.5 x height / run = 6%, the terrain rule) with a flat top
       *    `duneTop` wide across and `duneLength` long, `duneGap` apart: the freestyle jumps off the sand;
       *  - the boardwalk: palms (solid trunks, crown and height ranges) every `palmStep` [min, max] at `palmInset`
       *    in from the dune edge, lanterns every `lampStep` at `lampInset`, benches in `benchChance` of the gaps at
       *    `benchInset`; string lights hang between the palms `stringHeight` up;
       *  - lifeguard towers [min, max] (`tower` square solids) `towerGap` apart, `towerIn` m in from the waterline;
       *  - umbrella clusters every `umbrellaStep` [min, max] along the sand `umbrellaBand` [min, max] in from the
       *    waterline, with [min, max] loungers beside each; volleyball courts [min, max] (`court` long across the
       *    beach and `net` wide along it, `courtGap` apart);
       *  - the pier, one: `pier` wide, from `pierRoot` m inland of the dune edge `pierOver` m out past the
       *    waterline, its deck `pierHeight` over the boardwalk, a lamp every `pierLamp` m;
       *  - the drift strip, on the hard-packed sand: `zoneLength` [min, max] long, from `zoneIn` [min, max] in from the
       *    waterline (m), nothing standing in it.
       */
      beach: {
        chance: { miami: 0.8, other: 0.1 },
        quayWidth: 36,
        maxDepth: 80,
        minLength: 360,
        maxResidual: 0.8,
        sand: 24,
        slope: 0.025,
        blend: 24,
        shelf: 40,
        surfInset: 0.4,
        mouthSlack: 4,
        dunes: [1, 2],
        duneHeight: 0.5,
        duneRun: 12.5,
        duneTop: 3,
        duneLength: 14,
        duneCrest: 6,
        duneGap: 150,
        palmStep: [12, 17],
        palmInset: 2.2,
        palmHeight: [8.5, 12],
        palmCrown: [2.4, 3.2],
        palmTrunk: 0.4,
        lampStep: 30,
        lampInset: 0.9,
        benchChance: 0.35,
        benchInset: 3.8,
        stringHeight: 5.4,
        towers: [2, 4],
        tower: 3.2,
        towerGap: 90,
        towerIn: 9,
        umbrellaStep: [14, 30],
        umbrellaBand: [10, 21],
        loungers: [1, 2],
        courts: [1, 2],
        court: 16,
        net: 9.5,
        courtGap: 110,
        pier: 5.6,
        pierRoot: 2.5,
        pierOver: 75,
        pierHeight: 1.5,
        pierLamp: 9,
        zoneLength: [70, 110],
        zoneIn: [2.5, 9.5],
      },
    },
    /**
     * Lake: two to four adjacent blocks merged into one body of water by deleting the streets
     * between them (src/city/districts/lake.ts); the streets round it are the shore road, a paved
     * promenade runs inside them to a railing, and the ground behind it falls to the water.
     */
    lake: {
      enabled: true,
      /** Chance per city (its own stream); a city with no cluster of blocks that fits gets none. */
      chance: 0.36,
      /** Blocks merged [min, max]: each a plain four sided grid block of park size (m^2), at least edgeCells blocks in from the map edge. */
      blocks: [2, 4],
      minArea: 9000,
      maxArea: 26000,
      edgeCells: 1,
      /** Seed blocks tried before the city goes without. */
      tries: 30,
      /** Promenade inside the outer sidewalk line, paved at curb height (m); the railing stands on its inner edge. */
      promenade: 6,
      /** Stone coping behind the railing before the bank drops (m), and the bank's width down to the bed (m). */
      coping: 0.8,
      bank: 8,
      /** The water stands this far under the lowest point of the coping (m), over a bed this deep (m). */
      freeboard: 1.1,
      depth: 2.5,
      /**
       * The river keeps its band (bank top) this far off the shore (m): the lake is never between or
       * along its bank streets. Hill slopes, the bluff and the El's swings keep `clearance` off (m).
       */
      riverClear: 90,
      clearance: 15,
      /** On a seed that rolls the expressway, the lake's shore keeps off the first this many rows its line is tried on. */
      highwayRows: 2,
      /** Lantern posts along the promenade by the railing, about this far apart (m); a bench between each pair, facing the water. */
      lampSpacing: 26,
      /** Trees along the promenade between the lamps (m apart), kept this far from the shore's corners (m); trunk radius (m). */
      treeSpacing: 52,
      treeCornerClear: 28,
      treeRadius: 0.4,
      /** The jetty off the middle of the longest straight shore: length out over the water [min, max] and width (m). */
      jetty: [16, 26],
      jettyWidth: 2.6,
      /** Lakes this wide or more (m, the room around the middle) get a fountain jet. */
      fountainRoom: 45,
    },
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
  /**
   * Drag strip (findDragNodes): dragBlocks city blocks (CITY.spacing each) down the straightest
   * wide street, the start this far from the first intersection, then a runout long enough for the
   * finisher's runout brake (race.ts RUNOUT, about 2 g at full brake) to stop from 250 km/h.
   * Bends of at most the first of dragBendDeg at each node; a city with no straight that long
   * gets the gentler bends next, and only then the longest straight it has, raced to the runout.
   */
  dragBlocks: 7,
  dragStartOffset: 40,
  dragRunout: 170,
  dragBendDeg: [6, 10, 15],
  /** Drag strip lanes: each car this far either side of the centerline at most (m). */
  dragLaneOffset: 2.8,
  /**
   * Waypoint races (findWaypointNodes): this many waypoints between the start and the finish, each
   * leg between waypoints legMin to legMax m as the crow flies, the whole suggested route between
   * the min and max lengths (m). A waypoint counts within its intersection's half width plus
   * `waypointSlack` (m).
   */
  waypointCount: 4,
  waypointLegMin: 330,
  waypointLegMax: 700,
  waypointMinLength: 2000,
  waypointMaxLength: 3400,
  waypointSlack: 6,
  /** The finish line counts within the road's half width plus this (m). */
  waypointFinishSlack: 3,
  /** A waypoint race keeps looking this many acceptable suggestions further for one that crosses the monument plaza (districts/monument.ts passes). */
  waypointPreferTries: 60,
  /** A pass off the streets (route.ts RoutePass) may cut through a junction the route runs within this of straight across (deg). */
  passStraightDeg: 25,
  /**
   * A circuit that takes a pass allowing a start (RoutePass.start) puts its start line on it with this
   * chance per seed (its own stream), when the pass runs straight this far (m) past the last grid row.
   */
  passStartChance: 0.2,
  passStartMargin: 4,
  /** Start grid slots: the player and up to nine rivals (see the grid in route.ts). */
  gridSlots: 10,
  maxAttempts: 400,
  /**
   * Dijkstra weight factor of the river channel's edges (0.55: strongly preferred) and how much worse
   * (score points) a route that dives into the channel may be than the best plain one and still win.
   */
  channelBias: 0.5,
  preferSlack: 3,
  /**
   * Closure barriers stand this much further into their side street than where its walls start
   * (m): head-on closures (straight ahead of the incoming road, where racers overshoot) more than
   * side ones. Short streets keep at least barrierMinRoom m between their two ends.
   */
  barrierSetbackHeadOn: 7,
  barrierSetbackSide: 3,
  barrierMinRoom: 10,
  /**
   * A corner rail crossing a closed street's mouth closes it where it passes both of the mouth's
   * building corners closer than barrierTieSeal (m, narrower than any car). Past one corner only,
   * the closure is a tie from the street's edge at the other corner to the rail, ending
   * barrierTieGap (m) short of it, instead of a second rail standing behind the first.
   */
  barrierTieSeal: 2,
  barrierTieGap: 0.3,
  /** Corner guard rails: minimum turn, extra reach past the corner (m). */
  railMinTurnDeg: 30,
  railReach: 14,
  /**
   * Rails sit this far in front of the outer sidewalk line (the building line),
   * so the road and the whole sidewalk stay drivable runoff.
   */
  railInset: 0.3,
  /** A corner rail may stand this far outside the road corridor (m, the sidewalk is polygonal at bends); a crosswalk bend needing more is dropped. */
  railCorridorSlack: 0.09,
  /** How far (m) the rounded rail corner may cut inside the sharp outer sidewalk corner of an intersection. */
  railCornerCut: 2,
  /**
   * The fillet's tangent length is capped at this (m): a shallow bend's fillet would otherwise sweep
   * its cut far along the road, where the rail belongs at the back of the sidewalk.
   */
  railFilletReach: 13,
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

/**
 * Kerb parking (parking.ts): rows of parked cars along one kerb of the plain
 * streets off the route, sim bodies a car can hit (sim/traffic.ts, mode
 * 'parked'). The kinds are names from drivingParams.json traffic.kinds
 * (tests/traffic.test.ts holds bodyHalfWidth and pitch to their sizes).
 */
export const PARKING = {
  /** Street kinds that may carry a row, when the kerb strip leaves every lane of that side clear (parking.ts kerbStrip). */
  edgeKinds: ['street', 'avenue', 'diagonal', 'boulevard'] as const,
  /** Passenger kinds parked at the kerb and their mix (shares, normalised). */
  kinds: [
    { name: 'sedan', share: 0.2 },
    { name: 'wagon', share: 0.08 },
    { name: 'hatch', share: 0.14 },
    { name: 'compact', share: 0.12 },
    { name: 'coupe', share: 0.07 },
    { name: 'minivan', share: 0.08 },
    { name: 'pickup', share: 0.08 },
    { name: 'suv', share: 0.12 },
    { name: 'offroad', share: 0.04 },
    { name: 'taxi', share: 0.03 },
  ],
  /** Slot pitch along the kerb (m): the longest passenger kind (a pickup, 5.8 m) with room to pull out. */
  pitch: 6.4,
  /** Share of the slots taken, so the rows have gaps. */
  occupancy: 0.55,
  /** Share of the eligible streets that get a row at all (the rest keep both kerbs clear). */
  streetShare: 0.85,
  /** Gap from the kerb to a car's side (m), and the widest passenger kind's half width (m, a coupe): the kerb strip is the gap plus that car's width. */
  kerbGap: 0.25,
  bodyHalfWidth: 1.06,
  /** Clear of a junction's curb corner (m along the street), and of a bend node's (a street's own kink). */
  cornerClear: 14,
  bendClear: 3,
  /** Kept from a bus bay's or a path mouth's stretch (m) beyond the slot's half pitch. */
  bayClear: 4,
  /** A hydrant's front is kept this clear (m) of a car's end. */
  hydrantClear: 2.5,
  /** Kept from a level crossing's gate lines (m). */
  crossingClear: 18,
  /** Kept from the route's line (m) beyond the street's half width: off the route, its closures and their meets. */
  routeClear: 12,
  /** Walls and props must stay this clear (m) of a slot's footprint. */
  probePad: 0.3,
  /** District areas a slot never stands in (World.areaAt at its centre): the river's banks and ramps, a tunnel or viaduct, a market, roadworks. */
  offAreas: ['river', 'tunnel', 'overpass', 'market', 'roadworks', 'roundabout'] as const,
} as const;

/**
 * Open-air parking lots (districts/parkingLot.ts): a strip of a block, a third to the whole block deep,
 * or the whole block, of flat asphalt with painted bays in rows, parked cars (sim bodies, see
 * parking.ts), a ticket booth, lamps, tree islands and a fenced edge with curb cuts on the street.
 * Everything is metres unless noted; the layout (districts/parkingLot/layout.ts) is a pure function of the
 * lot's polygon and its params, so the sim, the renderer and the tests read the same lot.
 */
export const PARKING_LOT = {
  enabled: true,
  /** Lots per seed: the weights of one, two and three (a seed with fewer fitting blocks gets what fits). */
  countWeights: [0.4, 0.4, 0.2],
  /** Blocks that qualify: face area window (m^2), and the ground under them: steepest grade (rise per m) and height spread (m). */
  faceArea: [9000, 30000],
  maxGrade: 0.05,
  maxRise: 5,
  /** The streets a lot may front: plain streets only (no alley, shortcut, bridge or river edge). */
  edgeKinds: ['street', 'avenue', 'diagonal', 'boulevard'],
  /**
   * Where lots go: a site weighs baseWeight + edgeBoost at the edge of downtown (the downtown factor
   * edgeAt, edgeWidth wide: neither the towers nor the far outskirts), and nearBoost more within
   * nearReach of a harbor, night market, monument or car park (places people drive to and leave a car).
   */
  baseWeight: 0.35,
  edgeBoost: 1.2,
  edgeAt: 0.35,
  edgeWidth: 0.3,
  nearKinds: ['waterfront', 'market', 'monument', 'carPark'],
  nearReach: 260,
  nearBoost: 1,
  /** Share of lots that take the whole block (the rest are a strip along one street side). */
  fullChance: 0.3,
  /** A strip is this share of the block's depth from its street side (min, max); a lot shorter than minDepth or smaller than minArea (m^2) is not worth a lot. */
  depthShare: [0.4, 0.85],
  minDepth: 44,
  minArea: 3500,
  /**
   * The street side a lot fronts is a run of straight pieces at least this long (m) from end to end and
   * bending less than frontBend (rad) at any joint and frontBow (m) off its chord.
   */
  minSide: 56,
  frontBend: 0.2,
  frontBow: 4,
  /** Races: the lot keeps this far from every route node (m: its closed side streets and their meets) and from the route's streets. */
  routeNodeClear: 60,
  /** The lot keeps this far from another district's outline (m), from a street that is no plain street (an alley, the El's, a highway's; m) and from a junction another district holds (m). */
  districtClear: 12,
  badStreetClear: 20,
  alleyMouthClear: 40,
  routeEdgeClear: 22,
  /** A strip leaves the buildings behind it this much (m) beyond its back fence, and at least minRest of the block's depth is left them (else the lot takes the whole block). */
  backClear: 6,
  minRest: 22,
  /**
   * Bays: width along the row and depth (m), the aisle between rows (m), the lane round the
   * edge of the bay field (m, beside the fences), and the open forecourt behind the entrance (m deep,
   * with the booth island; the drift zone's apron).
   */
  bayWidth: 2.7,
  bayDepth: 5.6,
  aisle: 6.5,
  lane: 6.5,
  forecourt: 22,
  /** The back strip behind a strip lot's last row (m): the service edge where the dumpsters and cart corrals stand. */
  serviceStrip: 4,
  /** Fence: thickness (m, the solid's body, inward from the lot's edge), its drawn height, post spacing (m), and longest piece of solid (m). */
  fence: { thickness: 0.6, height: 2.1, kerb: 0.45, postGap: 3, piece: 9 },
  /** Curb cuts (busBays.ts mouthBay): the cut's width at full depth, the flare each side, room kept from a street piece's ends (m), the room between the entrance's and the exit's middles beyond one width, a lone cut's width where no pair fits, and extra cuts on other sides no shorter than extraMinSide. */
  cut: { width: 6.4, flare: 3.5, endClear: 6, pairGap: 10, extra: 2, extraMinSide: 30, single: 8 },
  /** The booth island between the entrance and the exit: width across, length into the lot (m), and the booth on it. */
  island: { width: 3, length: 7, boothWidth: 2, boothDepth: 2.6, boothHeight: 2.7, kerb: 0.4 },
  /** Tree islands: every this many bays a bay-wide strip of a double row is planted (a solid trunk, radius m), every other one with a lamp. */
  islandEvery: 11,
  trunkRadius: 0.25,
  /** Lamps along the fences: spacing (m) and how far inside the fence face (m); none within lampCutClear of a curb cut's middle. */
  lampSpacing: 26,
  lampInset: 1.5,
  lampCutClear: 6,
  /** Cars: share of the bays taken (min, max per lot), the share parked backed in, seeded yaw and sideways jitter (rad, m), and the gap kept to the back line (m). */
  occupancy: [0.45, 0.7],
  backIn: 0.12,
  yawJitter: 0.03,
  sideJitter: 0.1,
  backGap: 0.3,
  /** Kinds parked and their mix, with the body half length (m, drivingParams.json traffic.kinds): the kerb's mix plus the occasional van. */
  kinds: [
    { name: 'sedan', share: 0.18, halfLength: 2.45 },
    { name: 'wagon', share: 0.07, halfLength: 2.47 },
    { name: 'hatch', share: 0.13, halfLength: 2.23 },
    { name: 'compact', share: 0.11, halfLength: 1.83 },
    { name: 'coupe', share: 0.06, halfLength: 2.38 },
    { name: 'minivan', share: 0.08, halfLength: 2.59 },
    { name: 'pickup', share: 0.1, halfLength: 2.9 },
    { name: 'suv', share: 0.13, halfLength: 2.6 },
    { name: 'offroad', share: 0.04, halfLength: 2.21 },
    { name: 'taxi', share: 0.02, halfLength: 2.66 },
    { name: 'postvan', share: 0.05, halfLength: 2.79 },
    { name: 'serviceTruck', share: 0.03, halfLength: 2.76 },
  ],
  /** Service edge: dumpsters (2 to 3), bags by each, cart corrals (1 to 2; a corral is this long by this wide, m). */
  corral: { length: 5, width: 2.2 },
  /** The drift zone (sim/driftZones.ts): the forecourt from this far in (m, past the booth island), kept this far off the fences (m). */
  zoneFrom: 8.5,
  zoneInset: 1.5,
} as const;

/**
 * Sidewalk trees (streetTrees.ts): solid trunks on the sidewalks of plain streets, avenues, boulevards
 * and diagonals, with a canopy that overhangs the walk. Every trunk is a sim solid (wall look 'tree'),
 * so a car that climbs the curb meets it.
 */
export const STREET_TREES = {
  enabled: true,
  /** Road kinds that get trees. */
  kinds: ['street', 'avenue', 'diagonal', 'boulevard'],
  /** Narrowest sidewalk (m, curb to building line) that takes a tree. */
  minSidewalk: 3,
  /** Spacing along a street side (m) by road kind: one tree about this often, before jitter. */
  pitch: { street: 16, avenue: 16, diagonal: 16, boulevard: 12 },
  /** Seeded jitter of a station along the curb (m, +/-) and the share of stations left empty. */
  jitter: 3,
  skip: 0.08,
  /** Trunk radius (m): the sim's solid, a 6 sided prism round it. */
  trunkRadius: 0.25,
  trunkSides: 6,
  /** Crown radius and total height range (m) the renderer draws. */
  size: [1.9, 2.3],
  height: [6.5, 8.5],
  /** Distance the trunk keeps from the junction's curb corner, measured along the curb (m). */
  junctionClear: 14,
  /** Distance the trunk keeps from the nearest pole, signal or other furniture, centre to centre (m): at least this, or the prop's radius plus the trunk and `propGap`. */
  propClear: 2.5,
  propGap: 1.5,
  /** Planted this share of the way from the curb to the building line (the outer third) ... */
  across: 0.67,
  /** ... but never nearer the facade than this (m), so the canopy does not sink into the building. */
  facadeClear: 1.2,
  /** Seeded jitter of the planting depth (m, +/-), inside the limits above. */
  acrossJitter: 0.12,
  /** Trees on one side keep at least this far from each other (m), also across a bend node. */
  treeGap: 8,
  /** Room kept from a bus bay or path mouth's asphalt, from a district structure, and from a non frontage wall (m, beyond the trunk). */
  bayClear: 1.5,
  reservedClear: 1,
  wallClear: 1.5,
  /** The frontage behind the trunk is probed this far to either side along the curb (m): a building must stand behind all three probes, so no tree blocks a lot or plaza opening. */
  frontProbe: 2.5,
  /** A second, inner row (a third of the way from the curb) on boulevards whose sidewalk is at least this wide (m). */
  secondRowMin: 6,
  /** Room kept from the road surface (m, beyond the trunk). */
  roadClear: 0.5,
} as const;

/**
 * Plaza furnishing (districts/plazaDressing.ts): what a plaza holds beyond the clutter its theme scatters,
 * by the size of the pocket (its shorter side, m) and, on the monument plaza, by its edge. Every count and
 * spacing is a ceiling the layout trims against what is already standing: pieces are placed in the order
 * centrepiece, lantern ring, trees, benches, planters, bollards, cart, news boxes, each skipped where it
 * would crowd a piece placed before it. An alley's mouth pocket (a racer cuts across it into the alley)
 * takes nothing solid or hard. All lengths in m.
 */
export const PLAZA = {
  enabled: true,
  /** Shorter side a pocket needs for: one tree in its back, the rows (trees, benches, planters, corner boxes), a centrepiece, the large plaza's cart, bollards and strings. */
  minTree: 5.5,
  minRows: 7,
  minCentre: 9.5,
  minLarge: 12,
  /** Strings of festoon lights between a pocket's lanterns need this much floor (m^2). */
  stringArea: 110,
  /** Centrepiece: the share of roomy pockets that get one, the weights of its kinds, and the solid's radius and height per kind. A fountain is the infill's own (kit.fountainBasin). */
  centre: {
    chance: 0.85,
    kinds: { fountain: 3, statue: 3, clock: 2, kiosk: 2 },
    statue: { radius: 1, height: 3.7 },
    clock: { radius: 0.62, height: 4.6 },
    kiosk: { radius: 1.35, height: 2.9 },
    /** A fountain picked here is as wide as the infill's own: this share of the shorter side, clamped to [min, max]. */
    fountain: { share: 0.16, min: 1.6, max: 3 },
    /** Clear room round every centrepiece's edge (m): nothing else of the dressing stands closer, a car passes between. */
    gap: 1.6,
  },
  /** Trees: centres this far in from the back and side walls, about `spacing` apart along them, never closer than `gap` to each other, and no nearer than `clear` to a lantern or a prop. */
  tree: { inset: 2.3, spacing: 6.2, gap: 5, clear: 1.3, endClear: 1.8, size: [1.7, 2.1], height: [5.2, 6.8] },
  /** Benches facing the middle: in from the walls, spacing along them, and the share given a bin beside. */
  bench: { inset: 1.6, spacing: 6.4, endClear: 3, bin: 0.4 },
  /** Planter pots in a row along the back, in from it, spaced; they fill the gaps between trees and benches. */
  planter: { inset: 0.85, spacing: 2.8, endClear: 1.6 },
  /** Bollards a car's width apart or more (spacing minus the post) in a line along the open frontage, this far in; only where the frontage is at least `minLen` long. */
  bollard: { inset: 1.4, spacing: 4.6, minLen: 14, endClear: 3 },
  /** A food cart near the back of a large cafe or market plaza, and the news boxes at the back corners. */
  cart: { inset: 2.4, chance: 0.7 },
  newsBox: { inset: 1.1 },
  /** The lantern ring round a centrepiece: this far from its edge (m), on its diagonals. */
  ring: { offset: 3.1 },
  /** People: a standing group by the centrepiece (count [min, max], this far from its edge), and the largest number of groups a city holds. */
  gather: { people: [2, 4], offset: 1.5, max: 20 },
  /** Strands of lights between a plaza's lanterns: the lantern pairs' span [min, max], and the share of monument strands hung with bunting. */
  strand: { span: [4.5, 24], bunting: 0.5 },
  /** Clearance a hard piece keeps from the pocket's sides beyond its radius. */
  edgeClear: 0.4,
  /**
   * The monument plaza: trees stand `inset` in from the plaza's edge midway between the lanterns, at
   * least `lane` from a race pass's line (a car's width and the trunk beyond the line's half width),
   * `clear` from any prop and `ring` from the landmark's benches; people gather at `groups` spots round the landmark.
   */
  monument: { inset: 4.4, lane: 2.4, clear: 1.8, ring: 3, groups: [2, 4], groupRing: 4 },
} as const;
