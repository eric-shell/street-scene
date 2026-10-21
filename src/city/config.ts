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
      /** Meander amplitude (m) and wavelength (m) of the centerline. */
      meander: 9,
      wavelength: 640,
      /**
       * Low flow trickle on the floor (surface 'water', offroad grip): half width and offset from the
       * centerline (m), to one side of the racing line so it is a hazard to dodge, not a given.
       */
      waterHalf: 1.6,
      waterOffset: 5.5,
      /** Solid bridge body beyond each bridge's sidewalk, seen from the channel as a culvert face. */
      bridgeBody: 4,
      /**
       * The channel is a race venue: its floor joins the road graph (edges of kind 'channel' between
       * the feet of the entrances) and routes dive in. Entrances per seed [min, max], counting a ford
       * (a crossing street that dips through the channel instead of bridging it) as two; fords per seed
       * [min, max] where crossing streets have room for one.
       */
      entrances: [4, 6],
      fords: [2, 3],
      /** Channel edges follow the meander with a node at least every this far (m): chords stay within about half a meter of it. */
      nodeSpacing: 70,
      /**
       * Channel edge width (m) as the route sees it: the floor less a margin, so the chords between
       * channel nodes (up to about 1.3 m off the true centerline) never put a floor edge wall "on the road".
       */
      channelMargin: 1.5,
      /** Half widths (m) of side ramp trenches and of ford dips (a two lane street, curbs included). */
      rampHalfWidth: 4.5,
      fordHalfWidth: 5,
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
      /** Ramp feet keep this far from a bridge's culvert face (m): room for a stub with a closure and a crowd behind it. */
      footClear: 28,
      /**
       * A closure across the channel stands at least this far from a foot (m): past the widest plinth
       * (an avenue ford's, 12.5 m) plus the skew the meander gives the closure line across the banks.
       */
      closureFootClear: 16,
      /** Dead-end channel stubs from a foot toward a bridge (m): room for a closure at closureFootClear and a meet behind it. */
      stubLength: 32,
      stubMin: 22,
      /** Gaps between crossings wider than this (m) seat two side ramps, a short stretch of floor between them. */
      twoSlotGap: 110,
      /** Buildings and infill keep this far from the channel's top edge. */
      clearance: 5,
      /** Clutter along the floor edges (barrels, crates, bags) about every this far (m), clear of feet and bridges. */
      clutterSpacing: 28,
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
      /** Lantern posts per island (lit by render/areaLights), standing this far inside the rim (m). */
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
      /** Roof margin beside the chute and the ramp (m). */
      deckMargin: 4,
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
      /** One cluster of drive-through bushes per this much park area (m^2). */
      bushClusterArea: 800,
      /** Footpath loop this far inside the park edge (m), with a bench every benchSpacing m. */
      pathInset: 11,
      benchSpacing: 36,
      /** Lantern posts along the footpath's outer side, about this far apart (m); one stands at every path corner. */
      lampSpacing: 24,
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
     * under. Sign gantries straddle the wide streets on two legs; a short
     * freeway viaduct crosses one to three streets mid-block on hammerhead
     * piers standing on the sidewalks, its ends buried in abutments inside
     * the blocks.
     */
    overpass: {
      enabled: true,
      /** Sign gantries per city [min, max]. */
      gantries: [3, 5],
      /** Truss underside above the road (m), legs behind the curb (m) and their square size (m). */
      gantryClearance: 6,
      legSetback: 0.9,
      legSize: 0.7,
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
       * ROUTE.barrierSetbackHeadOn past that line (route.ts mouthBarrier), deep at a five way junction.
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
