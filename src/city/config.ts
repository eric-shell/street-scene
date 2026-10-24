/** City generation constants. All distances in meters. */
export const CITY = {
  gridW: 11,
  gridH: 11,
  spacing: 140,
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
      chance: 0.85,
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
      count: [2, 4],
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
       * the chord between where it leaves and rejoins the streets. The racing line's width (m); how
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
      passSites: 40,
      /**
       * A chicane along one street (a through pass) swings onto the paving over one of these runs (m)
       * and runs straight at least passStraightMin (m) past the landmark. A second route's chicane or
       * U cut must agree with the landmark the first placed: its line within passFitSlack (m) of where
       * the landmark wants it, along the arch's axis within passFitDeg (deg).
       */
      passEntry: [14, 20, 28],
      passStraightMin: 24,
      passFitSlack: 2,
      passFitDeg: 8,
      /** A chicane may leave its street this soon after the corner it came round (m: past the junction's closures). */
      passThroughFrom: 18,
      /** A U cut turns off one street and onto the other about as squarely as the two corners it replaces: its own bend cap (deg). */
      passUcutMaxTurn: 96,
      /** Added to a pass's sharpest bend when the shapes compete for a route (deg): a U cut crosses the whole plaza and wins over a chicane along one side. */
      passShapeBias: { corner: -12, through: 0, ucut: -70 },
      /** ... and a pass straight enough for a start grid on it (route.ts PASS_START_RUN) is worth this much (deg). */
      passStartBias: -15,
      /** A chicane's depth off the street as fractions of the landmark's at the block's middle: shallower swings in more gently. */
      passDepths: [1, 0.75, 0.55],
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
     * Elevated highway (src/city/districts/highway/): a freeway on a deck
     * crossing the whole map west to east along a row street, swinging to the
     * next row through the blocks once or twice, drivable in free roam from
     * its on-ramps (closed in races). Cars on the deck and in the street under
     * it are two levels (districts/types.ts DeckSpan); its columns stand on the
     * sidewalks and in the blocks.
     */
    highway: {
      enabled: true,
      /** Chance per city, the first draw of the module's own stream (highwayRolled). */
      chance: 0.6,
      /** Deck width (m): two carriageways of two lanes, shoulders, a median and a jersey barrier each side. */
      deckWidth: 18,
      /** Lane width (m) and the median barrier's width (m). */
      lane: 3.5,
      median: 0.8,
      /** Deck underside above the smoothed ground (m), clear of the start gantry (11.9 m), and the deck's depth (m). */
      clearance: 12,
      depth: 1.5,
      /** Over the El the underside clears the El's tie top by this much (m): its trains, track lamps and station canopies. */
      elClear: 5.8,
      /** The hump over the El eases in and out at this grade at most (rise per m). */
      humpGrade: 0.025,
      /** Street bents: a square column on each sidewalk this far behind the curb (m), this size (m), about this far apart (m). */
      columnSetback: 2,
      columnSize: 1.1,
      bentSpacing: 34,
      /** Hammerhead columns on the deck line through the blocks: radius (m). */
      pierRadius: 1.05,
      /** Swings to the next row [min, max] per seed, each over [min, max] columns. */
      swings: [1, 2],
      swingCols: [2, 3],
      /** The S curve starts and ends this far past the junction it leaves or joins (m). */
      swingLead: 30,
      /** A swing is dropped when its curve radius falls under this anywhere (m). */
      swingRadius: 80,
      swingStep: 10,
      /** Through a block, buildings and infill keep this far beyond the deck's edges (m). */
      blockMargin: 3,
      /** On-ramps per highway [min, max]: a two lane road from a parallel street up through a block to the deck. */
      ramps: [2, 4],
      /** Ramp: half width between its walls (m), grade cap (rise per m), vertical curves at the foot and the top (m). */
      rampHalf: 4.2,
      rampGrade: 0.15,
      rampFootEase: 26,
      rampTopEase: 34,
      /** Turn radii tried for a ramp's curve onto the deck (m). */
      rampRadius: [38, 48, 60, 75],
      /** The ramp's mouth keeps this far from its street's junctions (m, beyond their closure reach). */
      rampMouthClear: 2,
      /** Ramps keep this far from the El crossing along the deck (m: its hump), and from each other (m). */
      rampElClear: 170,
      rampGap: 100,
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
      chance: 0.85,
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
