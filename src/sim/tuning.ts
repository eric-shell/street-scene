/**
 * Car physics types and lookups. Every number lives in drivingParams.json
 * (base tuning, per car overrides, drivetrains, the Tune tab's setup tables); this
 * module only types, merges and validates it. Nothing else in the sim should
 * contain tuning magic numbers.
 */
import manifest from '../assets/carManifest.json';
import params from './drivingParams.json';

export interface CarGeometry {
  /** Wheel centers in car space: [left(+x), up(+y), forward(+z)], order FL, FR, RL, RR. */
  wheels: [number, number, number][];
  wheelRadius: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  halfLength: number;
  halfWidth: number;
}

export type DrivetrainLayout = 'rwd' | 'awd' | 'fwd';
export const DRIVETRAIN_LAYOUTS: readonly DrivetrainLayout[] = ['rwd', 'awd', 'fwd'];

export interface CarTuning {
  carId: string;
  mass: number;
  /** Multiplies the box approximation of yaw inertia. Higher = lazier rotation. */
  yawInertiaScale: number;
  cgHeight: number;
  geometry: CarGeometry;
  drivetrain: {
    layout: DrivetrainLayout;
    /** AWD only: share of drive torque sent to the front axle (0.4 = 40/60). */
    awdFrontShare: number;
    /** Driven axles: how far drive past twice the lighter wheel's grip drops toward twice its sliding force (0 = stock axle, 1 = open differential). */
    diffOpen: number;
    /** Driven axles: the locked axle's force pair in a turn, as a share of the axle's grip at the peak slip (0 = stock axle). */
    diffLock: number;
  };
  engine: {
    idleRpm: number;
    redline: number;
    /** [rpm, Nm] points. */
    torqueCurve: [number, number][];
    torqueMul: number;
    /** Engine braking torque at redline, Nm. */
    engineBraking: number;
    /** Max clutch slip rpm used for launches from a standstill. */
    launchRpm: number;
    /** Spin inertia of the engine's rotating parts, flywheel and clutch (kg m^2); geared onto the driven wheels. */
    inertia: number;
    /** Turbocharged (the manifest's engine spec, not drivingParams.json): boost spools with lag and rolling antilag holds it. */
    turbo: boolean;
  };
  /** Launch control (car.ts): the two-step at the line, line lock burnouts, rolling antilag, turbo spool. */
  launch: {
    /** The build's launch rpm (rpm; 0 = off): the two-step holds the engine there on the grid, and the launch clutch slips there off the line. applyBuild writes it from the garage's Tune tab. */
    twoStepRpm: number;
    /** The car's stock Launch RPM (rpm; 0 = off): what a new garage build, or a saved one without the setting, starts on. */
    defaultRpm: number;
    /** How far under the set point each cut lets the revs fall (rpm): the stutter's depth. */
    twoStepDepth: number;
    /** How long each cut keeps the spark off (s): with the depth, the stutter's rate. */
    twoStepCutTime: number;
    /** A pedal past this (0..1) counts as pressed for launch control: the two-step, line lock (throttle and brake) and antilag (throttle). */
    pedalThreshold: number;
    /** Under this speed (m/s) throttle with the brake or the antilag button is a line lock burnout; over it the antilag button is antilag. */
    lineLockSpeed: number;
    /** Arcade: share of an AWD car's front drive sent to the rear while line locked (0 = its own split, 1 = a rear wheel burnout). */
    lineLockRearShare: number;
    /** Rolling antilag holds the engine here (rpm; 0 = off): the car's stock pick, replaced by a build's Antilag RPM (applyBuild). */
    antilagRpm: number;
    /** Boost stays pinned at full this long after the antilag button is let go (s). */
    antilagHold: number;
    /** Turbo cars: boost spools from nothing to full in this long under load (s). */
    spoolTime: number;
    /** Turbo cars: boost bleeds off in this long off the throttle (s). */
    spoolDownTime: number;
    /** Turbo cars: boost builds only above this fraction of the redline. */
    spoolRpmFrac: number;
    /** Turbo cars: share of the engine's torque that needs full boost (0 = no lag at all). */
    turboShare: number;
  };
  gearbox: {
    ratios: number[];
    reverseRatio: number;
    finalDrive: number;
    efficiency: number;
    shiftTime: number;
    upshiftRpmFrac: number;
    downshiftRpmFrac: number;
    reverseMaxSpeed: number;
    /**
     * The Gear Ratio slider's arcade term (setup.gearing.torqueBonus; 0 = stock, applyBuild writes it): extra
     * engine torque as a fraction, + on short gears, - on long ones, full up to torqueBonusFadeStart and gone
     * by torqueBonusFadeEnd, so it shapes corner exits and never the drag top speed (docs/handling.md, Simcade).
     */
    torqueBonus: number;
    /** Road speed the gearing bonus starts fading at (m/s). */
    torqueBonusFadeStart: number;
    /** Road speed the gearing bonus has faded out by (m/s). */
    torqueBonusFadeEnd: number;
  };
  /**
   * One grip curve over the normalized slip vector (sideways slip over peakSlipDeg, slip ratio over
   * peakSlipRatio): rising to the peak at length 1 (shaped per axle by roundingFront / roundingRear), down
   * to the sliding grip at fullSlideDeg / peakSlipDeg.
   */
  tires: {
    gripFront: number;
    gripRear: number;
    /** Slip angle of peak grip (deg). */
    peakSlipDeg: number;
    /**
     * Shape of the rise to the peak, per axle (0..1): 0 a straight line, 1 twice as steep at zero slip and
     * flat into the peak. Higher = sharper response and less slip in ordinary corners; the peak and the
     * slide past it are unchanged. A rear above the front keeps the car stable below the limit.
     */
    roundingFront: number;
    roundingRear: number;
    /** Slip ratio (tread speed over road speed, minus one) of peak grip. */
    peakSlipRatio: number;
    /** Slip angle where grip has fallen to slideGrip. */
    fullSlideDeg: number;
    /** Grip of a tire sliding sideways, fraction of peak. */
    slideGrip: number;
    /** Grip of a tire sliding lengthways (spinning or locked, going straight), fraction of peak. */
    slideGripLong: number;
    /** How far a tire in a full slide pushes against the way its rubber slides (1) rather than along its normalized slip vector (0); eased in from the peak (car.ts slideDir). */
    slideVelocityShare: number;
    /** Lateral grip kept however hard the foot brake uses the friction circle (arcade ABS). */
    minLateralShare: number;
    rollingResistance: number;
    /** Wheel load past which grip stops growing, as a multiple of the static wheel load (mg/4). */
    loadCap: number;
  };
  /** Axle dynamics (wheelspin) and traction control. */
  traction: {
    /** Spin inertia of one wheel with its hub, brake and half shaft (kg m^2). */
    wheelInertia: number;
    /** Extra drive torque from dumping the clutch (launches, clutch kicks), at clutch slip = redline. */
    launchBoost: number;
    /** How far a handbrake release takes the driven wheels toward the speed they share with the flywheel (0..1; car.ts dumpClutch). */
    handbrakeDump: number;
    /** Tread speed a clutch kick adds to the driven wheels (m/s): the flywheel's energy dumped into them. */
    clutchKickSpeed: number;
    /** Traction control: max drive as a fraction of the forward force that keeps the tires inside their peak. */
    tcSlipTarget: number;
    /** Traction control: drive it always allows, as a fraction of grip, even at full cornering slip. */
    tcMinDrive: number;
    /** Traction control: cuts throttle above this body slip angle (stops power oversteer). */
    tcMaxSlipDeg: number;
  };
  suspension: {
    /** Ride frequency of each corner (Hz). */
    frequency: number;
    /** Bump (compression) damping as a share of critical. */
    dampingRatio: number;
    /** Rebound (extension) damping as a share of critical: above dampingRatio, so a hit settles instead of springing back. */
    reboundRatio: number;
    /** Travel from rest to the bump stop (m). */
    travel: number;
    /** Bump stop stiffness as a multiple of the spring rate. */
    bumpStopRate: number;
    /** Bump stop damping while compressing, as a share of its own critical damping. */
    bumpStopDamping: number;
    /** Share of the bump stop's force it gives back while unloading (0 = dead, 1 = elastic). */
    bumpStopReturn: number;
    /** In the air the body levels out over the ground below at this rate (rad/s, critically damped). */
    airLevel: number;
  };
  brakes: {
    /** Total tire brake force (N), split by frontBias. */
    force: number;
    frontBias: number;
    /** Handbrake torque on the rear axle (Nm): above what its tires hold back, it locks. */
    handbrakeTorque: number;
    /** Arcade deceleration on top of the tires at full brake (m/s^2), along the car's path; it does not use up cornering grip. */
    assistDecel: number;
  };
  steering: {
    maxDeg: number;
    highSpeedDeg: number;
    fadeSpeed: number;
    rateDegPerSec: number;
    /** Extra lock allowed when steering into a slide, as a fraction of body slip angle. */
    counterSteerAllowance: number;
    /** Lock when steering into a slide (deg), whatever the slip angle: a drift angle kit; 0 = only the speed faded lock and the allowance. */
    counterLockDeg: number;
  };
  aero: {
    drag: number;
    downforce: number;
  };
  /** The tank holds NITRO_STAGES stages; refills fill them in order and a burn empties the top one first (car.ts). */
  nitrous: {
    /** Seconds of boost in one stage. */
    capacity: number;
    /** Extra push while boosting at stage 1 (N). */
    force: number;
    /** Engine torque multiplier while boosting at stage 1. */
    torqueMul: number;
    /** Boost power of each stage, scaling force and torqueMul's extra torque: stage 1 is stock. */
    stagePower: number[];
    /** Stages put back when a burn that began with 1, 2 or 3 full stages is held until the tank runs dry. */
    chainRefill: number[];
    /** Stage fraction per second while drifting (at 30 deg of slip and over). */
    refillDrift: number;
    /** Stage fraction per second while skimming a wall at speed. */
    refillNearMiss: number;
    /** Stage fraction per second in a slipstream. */
    refillDraft: number;
    /** Stages a knocked down prop pays the car that broke it, scaled by sqrt(its effective mass / wreckFullMass) and capped at 1 (a can is worth a quarter of a pole; props.ts). */
    wreckBonus: number;
    /** Effective prop mass (kg, mass * anchor) at and above which a wreck pays the whole bonus. */
    wreckFullMass: number;
    draftDragMul: number;
    /** Most overdrive style can bank past a full tank (stages). */
    overdriveCap: number;
    /** Boost power multiplier while overdrive burns. */
    overdrivePower: number;
    /** Normal impact speed (m/s) of a wall, barrier, rail or racer hit at which a crash starts to cost nitrous. */
    crashMinImpact: number;
    /** Normal impact speed (m/s) at and above which a crash costs the whole crashLoss. */
    crashFullImpact: number;
    /** Stages the hardest crash costs, overdrive first. */
    crashLoss: number;
    /** Share of the tank and overdrive a reset or tow costs (0..1; 1 = all of it, 0 = resets are free). */
    resetLoss: number;
  };
  /** Arcade drift aids on top of the tire model. */
  drift: {
    /** How long a clutch kick keeps feeding extra torque (s). */
    clutchKickTime: number;
    /** Body slip angle past which the anti spin aid turns the nose back toward the direction of travel (deg). */
    maxSlipDeg: number;
    /** Strength of the anti spin aid (Nm per rad past maxSlipDeg, times 4). */
    assistTorque: number;
    /** Always-on yaw damping, Nm per rad/s. Keeps the car from feeling twitchy. */
    yawDamping: number;
    /** Extra yaw damping below 3 m/s (per m/s under it), so a car cannot pirouette at a crawl. */
    yawDampingLowSpeed: number;
  };
  surface: {
    sidewalkGrip: number;
    offroadGrip: number;
    /** Constant drag force off road (N, full above 1 m/s). */
    offroadDrag: number;
    /** Cobbled alleys: grip multiplier and the extra rolling drag of the stones (N, full above 1 m/s). */
    cobbleGrip: number;
    cobbleDrag: number;
    /** Water in the river trickle: hydrodynamic drag, N per (m/s)^2 of speed with all four wheels in it (scaled by the wheels that are). */
    waterDrag: number;
  };
  collision: {
    wallRestitution: number;
    wallScrub: number;
    /** Corner guard rails: low bounce and spin, but scraping them costs speed. */
    railRestitution: number;
    railScrub: number;
    railAngularScale: number;
    /** Sliding friction while touching a rail, m/s^2 of deceleration. */
    railDrag: number;
    /** Fraction of along-rail speed lost per second of contact. */
    railSpeedLoss: number;
    /** Share of along-rail speed lost per meter a hit shoves a rail piece back (src/sim/rails.ts). */
    railDentLoss: number;
    /** Share of speed lost per meter of step, per car circle, when scraping into a rail piece that sticks out past a dented one. */
    railStepLoss: number;
    carRestitution: number;
    angularScale: number;
    /** After a reset or tow the car passes through other cars, racers and traffic, for this long (s); walls still stop it. */
    resetPassThrough: number;
  };
}

export const GRAVITY = 9.81;
/** Stages in a nitrous tank, each with its own power (nitrous.stagePower) and HUD color. */
export const NITRO_STAGES = 3;

type BaseTuning = Omit<CarTuning, 'carId' | 'geometry'>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

const BASE = params.base as unknown as BaseTuning;
/** Per car deep-partial overrides from drivingParams.json (absolute values, `_` keys are comments). */
export const CAR_OVERRIDES = params.cars as unknown as Record<string, DeepPartial<BaseTuning>>;

// ---------------------------------------------------------------------------
// The garage Tune tab's setup (build.ts applyBuild): four sliders, five positions each, left to right.
// ---------------------------------------------------------------------------
export const SETUP_SLIDERS = ['suspension', 'gearing', 'differential', 'brakeBalance'] as const;
export type SetupSlider = (typeof SETUP_SLIDERS)[number];
/** A slider position, 1 (left) .. 5 (right). */
export type SetupPosition = 1 | 2 | 3 | 4 | 5;
export const SETUP_POSITIONS: readonly SetupPosition[] = [1, 2, 3, 4, 5];
/** The position every slider starts on: the stock car, which every table leaves exactly as it is. */
export const STOCK_POSITION: SetupPosition = 3;

/** One entry per position, left to right. */
type SetupRow = readonly [number, number, number, number, number];
export interface SetupTables {
  suspension: { frequencyMul: SetupRow; travelMul: SetupRow; steerRateMul: SetupRow; roadGripMul: SetupRow; roughGripMul: SetupRow };
  gearing: { finalDriveMul: SetupRow; firstGearMul: SetupRow; torqueBonus: SetupRow };
  differential: { open: SetupRow; lock: SetupRow };
  brakeBalance: { frontBiasAdd: SetupRow };
}
const SETUP_KEYS: { [S in SetupSlider]: readonly (keyof SetupTables[S])[] } = {
  suspension: ['frequencyMul', 'travelMul', 'steerRateMul', 'roadGripMul', 'roughGripMul'],
  gearing: ['finalDriveMul', 'firstGearMul', 'torqueBonus'],
  differential: ['open', 'lock'],
  brakeBalance: ['frontBiasAdd'],
};

/**
 * The `setup` section, checked like the car tuning: unknown or missing keys throw, every table needs a
 * number per position, and the stock position must leave the car as it is (1 in a *Mul table, else 0), so
 * a stock build stays bit for bit the car's own tuning.
 */
export function validateSetup(raw: unknown): SetupTables {
  if (!isObj(raw)) throw new Error('drivingParams.json: "setup" must be an object');
  for (const k of Object.keys(raw)) if (!k.startsWith('_') && !(SETUP_SLIDERS as readonly string[]).includes(k)) throw new Error(`drivingParams.json: unknown key "setup.${k}"`);
  for (const s of SETUP_SLIDERS) {
    const sec = raw[s];
    if (!isObj(sec)) throw new Error(`drivingParams.json: "setup.${s}" must be an object`);
    const keys = SETUP_KEYS[s] as readonly string[];
    for (const k of Object.keys(sec)) if (!k.startsWith('_') && !keys.includes(k)) throw new Error(`drivingParams.json: unknown key "setup.${s}.${k}"`);
    for (const k of keys) {
      const row = sec[k];
      if (!Array.isArray(row) || row.length !== SETUP_POSITIONS.length || !row.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`drivingParams.json: "setup.${s}.${k}" needs ${SETUP_POSITIONS.length} numbers, one per position`);
      const stock = k.endsWith('Mul') ? 1 : 0;
      if (row[STOCK_POSITION - 1] !== stock) throw new Error(`drivingParams.json: "setup.${s}.${k}" must hold ${stock} at position ${STOCK_POSITION}, the stock car`);
    }
  }
  return raw as unknown as SetupTables;
}

// ---------------------------------------------------------------------------
// Drift zones (src/sim/driftZones.ts): race rules, not car tuning, so not in tuningHash.
// ---------------------------------------------------------------------------
export interface DriftZoneTuning {
  /** Drift points multiplier while drifting inside a zone (drift mode). */
  scoreMul: number;
  /** Multiplier on the nitrous a drift refills inside a zone (every mode, every car). */
  refillMul: number;
  /** Drifting per visit that earns the bonus (s). */
  bonusTime: number;
  /** Most extra nitrous one visit refills (stages). */
  refillCap: number;
  /** A visit lasts this long after the car leaves the zone (s), so a slide over the edge keeps it. */
  exitGrace: number;
  /** Once a paying visit ends, the zone pays that car again only after this long (s). */
  cooldown: number;
  /** Parking lots count as zones from this depth into the block (m), frontage length (m) and area (m^2). */
  minLotDepth: number;
  minLotLength: number;
  minLotArea: number;
}

const DRIFT_ZONE_KEYS = ['scoreMul', 'refillMul', 'bonusTime', 'refillCap', 'exitGrace', 'cooldown', 'minLotDepth', 'minLotLength', 'minLotArea'] as const satisfies readonly (keyof DriftZoneTuning)[];

/** The `driftZones` section, checked like the car tuning: unknown or missing keys and non-numbers throw. */
function driftZoneTuning(raw: Record<string, unknown>): DriftZoneTuning {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!(DRIFT_ZONE_KEYS as readonly string[]).includes(k)) throw new Error(`drivingParams.json: unknown key "driftZones.${k}"`);
    if (typeof v !== 'number') throw new Error(`drivingParams.json: "driftZones.${k}" must be a number`);
    out[k] = v;
  }
  for (const k of DRIFT_ZONE_KEYS) if (!(k in out)) throw new Error(`drivingParams.json: missing "driftZones.${k}"`);
  return out as unknown as DriftZoneTuning;
}

export const DRIFT_ZONES: DriftZoneTuning = driftZoneTuning(params.driftZones as unknown as Record<string, unknown>);

interface ManifestCar {
  id: string;
  /** The engine spec (shared/carSpec.ts); only the aspiration reaches the tuning (engine.turbo). */
  engine?: { aspiration?: string };
  wheels: Record<'FL' | 'FR' | 'RL' | 'RR', number[]>;
  wheelRadius: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  dimensions: { length: number; width: number; height: number };
}

export const CAR_IDS: string[] = (manifest.cars as ManifestCar[]).map((c) => c.id);
/** Cars offered in the garage and to AI opponents. Others stay loadable (tests, pipeline). */
export const SELECTABLE_CAR_IDS: string[] = (manifest.cars as (ManifestCar & { selectable?: boolean })[]).filter((c) => c.selectable).map((c) => c.id);
export const DEFAULT_CAR_ID = SELECTABLE_CAR_IDS[0] ?? CAR_IDS[0];

export function geometryFromManifest(carId: string): CarGeometry {
  const car = (manifest.cars as ManifestCar[]).find((c) => c.id === carId) ?? (manifest.cars as ManifestCar[])[0];
  const w = car.wheels;
  const order = [w.FL, w.FR, w.RL, w.RR].map((p) => [p[0], p[1], p[2]] as [number, number, number]);
  return {
    wheels: order,
    wheelRadius: car.wheelRadius,
    wheelbase: car.wheelbase,
    trackFront: car.trackFront,
    trackRear: car.trackRear,
    halfLength: car.dimensions.length / 2,
    halfWidth: car.dimensions.width / 2,
  };
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Merge a per car override over the base, key by key. Arrays replace whole.
 * Keys starting with `_` are comments. Unknown keys or wrong types throw, so
 * a typo in drivingParams.json fails loudly instead of being ignored.
 */
function mergeOverride(target: Record<string, unknown>, over: Record<string, unknown>, path: string): void {
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue;
    const p = path ? `${path}.${k}` : k;
    if (!(k in target)) throw new Error(`drivingParams.json: unknown key "${p}"`);
    const cur = target[k];
    if (isObj(cur)) {
      if (!isObj(v)) throw new Error(`drivingParams.json: "${p}" must be an object`);
      mergeOverride(cur, v, p);
    } else if (Array.isArray(cur) !== Array.isArray(v) || typeof cur !== typeof v) {
      throw new Error(`drivingParams.json: "${p}" must be ${Array.isArray(cur) ? 'an array' : `a ${typeof cur}`}`);
    } else target[k] = deepClone(v);
  }
}

/** The Tune tab's tables (drivingParams.json `setup`), validated at startup. */
export const SETUP: SetupTables = validateSetup((params as Record<string, unknown>).setup);

const resolved = new Map<string, CarTuning>();

export function getBaseTuning(carId: string): CarTuning {
  const id = CAR_IDS.includes(carId) ? carId : CAR_IDS[0];
  let t = resolved.get(id);
  if (!t) {
    const base = deepClone(BASE) as unknown as Record<string, unknown>;
    mergeOverride(base, (CAR_OVERRIDES[id] ?? {}) as Record<string, unknown>, `cars.${id}`);
    t = { ...(base as unknown as BaseTuning), carId: id, geometry: geometryFromManifest(id) };
    // Forced induction is the manifest's call (the engine spec the garage badges and the voice read), not a tuning number.
    t.engine.turbo = (manifest.cars as ManifestCar[]).find((c) => c.id === id)?.engine?.aspiration === 'turbo';
    if (!DRIVETRAIN_LAYOUTS.includes(t.drivetrain.layout)) throw new Error(`drivingParams.json: cars.${id}.drivetrain.layout must be one of ${DRIVETRAIN_LAYOUTS.join(', ')}`);
    if (t.nitrous.stagePower.length !== NITRO_STAGES || t.nitrous.chainRefill.length !== NITRO_STAGES) throw new Error(`drivingParams.json: cars.${id}.nitrous.stagePower and chainRefill need ${NITRO_STAGES} entries, one per stage`);
    if (!(t.nitrous.crashFullImpact > t.nitrous.crashMinImpact)) throw new Error(`drivingParams.json: cars.${id}.nitrous.crashFullImpact must be above crashMinImpact`);
    if (!(t.gearbox.torqueBonusFadeEnd > t.gearbox.torqueBonusFadeStart)) throw new Error(`drivingParams.json: cars.${id}.gearbox.torqueBonusFadeEnd must be above torqueBonusFadeStart`);
    resolved.set(id, t);
  }
  return deepClone(t);
}

/** Drive torque split per axle (fractions summing to 1). */
export function driveSplit(t: CarTuning): { front: number; rear: number } {
  const l = t.drivetrain.layout;
  const front = l === 'fwd' ? 1 : l === 'awd' ? Math.min(1, Math.max(0, t.drivetrain.awdFrontShare)) : 0;
  return { front, rear: 1 - front };
}

/** FNV-1a hash of a string, as 8 hex chars. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Fingerprint of a car's stock tuning plus the setup tables. Saved tuning panel
 * values store it and is discarded when drivingParams.json changes, so stale
 * browser overrides never mask edits to the file.
 */
export function tuningHash(carId: string): string {
  return hashString(JSON.stringify(getBaseTuning(carId)) + JSON.stringify(SETUP));
}

// ---------------------------------------------------------------------------
// Ambient traffic (src/sim/traffic.ts): the civilian cars' numbers.
// ---------------------------------------------------------------------------

/** One civilian vehicle kind: its collision box and mass. */
export interface TrafficKind {
  /** Silhouette the renderer draws (render/traffic/traffic.ts): sedan, hatch, van, taxi. */
  name: string;
  /** Share of the spawn mix (weights, normalized over the kinds). */
  share: number;
  /** kg */
  mass: number;
  /** m */
  halfLength: number;
  /** m */
  halfWidth: number;
}

export interface TrafficParams {
  /** Typical driver's cruising speed on a plain street (m/s). */
  cruiseSpeed: number;
  /** Each driver's cruise speed varies by up to this fraction either way. */
  cruiseJitter: number;
  /** Acceleration (m/s^2). */
  accel: number;
  /** Comfortable deceleration the speed profiles plan with (m/s^2). */
  brake: number;
  /** Hardest deceleration, for surprises (m/s^2). */
  hardBrake: number;
  /** Lateral acceleration a junction turn is taken at, which sets its speed limit (m/s^2). */
  turnLatAccel: number;
  /** No turn is taken slower than this (m/s). */
  minTurnSpeed: number;
  /** Bumper to bumper gap kept at a standstill (m). */
  standGap: number;
  /** Time gap kept to the car ahead on top of standGap (s). */
  headway: number;
  /** Struck cars: sideways slide deceleration (m/s^2). */
  slideDecel: number;
  /** Struck cars: rolling deceleration along the heading (m/s^2). */
  rollDecel: number;
  /** Struck cars: spin deceleration (rad/s^2). */
  spinDecel: number;
  /** Below this a struck car counts as stopped (m/s). */
  restSpeed: number;
  /** Seconds stopped before a struck car tries to drive on. */
  recoverDelay: number;
  /** A stopped car rejoins its lane when its center is within this of it (m). */
  rejoinDistance: number;
  /** ...and its heading within this of the lane's (deg). */
  rejoinYawDeg: number;
  /** The rejoin offset blends out over about this much driving (m). */
  rejoinLength: number;
  /** Multiplies the box approximation of yaw inertia (as CarTuning.yawInertiaScale). */
  yawInertiaScale: number;
  kinds: TrafficKind[];
}

const TRAFFIC_KIND_KEYS: Record<keyof TrafficKind, 'string' | 'number'> = { name: 'string', share: 'number', mass: 'number', halfLength: 'number', halfWidth: 'number' };

/** Type and key check of the `traffic` block: unknown or missing keys and wrong types throw, like the car tuning. */
function validateTraffic(raw: unknown): TrafficParams {
  if (!isObj(raw)) throw new Error('drivingParams.json: "traffic" must be an object');
  const scalars: (keyof TrafficParams)[] = ['cruiseSpeed', 'cruiseJitter', 'accel', 'brake', 'hardBrake', 'turnLatAccel', 'minTurnSpeed', 'standGap', 'headway', 'slideDecel', 'rollDecel', 'spinDecel', 'restSpeed', 'recoverDelay', 'rejoinDistance', 'rejoinYawDeg', 'rejoinLength', 'yawInertiaScale'];
  for (const k of Object.keys(raw)) {
    if (!k.startsWith('_') && k !== 'kinds' && !scalars.includes(k as keyof TrafficParams)) throw new Error(`drivingParams.json: unknown key "traffic.${k}"`);
  }
  for (const k of scalars) if (typeof raw[k] !== 'number') throw new Error(`drivingParams.json: "traffic.${k}" must be a number`);
  const kinds = raw.kinds;
  if (!Array.isArray(kinds) || !kinds.length) throw new Error('drivingParams.json: "traffic.kinds" must be a non-empty array');
  kinds.forEach((kind: unknown, i) => {
    if (!isObj(kind)) throw new Error(`drivingParams.json: "traffic.kinds[${i}]" must be an object`);
    for (const k of Object.keys(kind)) if (!k.startsWith('_') && !(k in TRAFFIC_KIND_KEYS)) throw new Error(`drivingParams.json: unknown key "traffic.kinds[${i}].${k}"`);
    for (const [k, type] of Object.entries(TRAFFIC_KIND_KEYS)) if (typeof kind[k] !== type) throw new Error(`drivingParams.json: "traffic.kinds[${i}].${k}" must be a ${type}`);
  });
  return raw as unknown as TrafficParams;
}

/** Ambient traffic numbers (drivingParams.json `traffic`), validated at startup. */
export const TRAFFIC: TrafficParams = validateTraffic((params as Record<string, unknown>).traffic);

export function setByPath(obj: unknown, path: string, value: number | string): void {
  const keys = path.split('.');
  let o = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] as Record<string, unknown>;
  o[keys[keys.length - 1]] = value;
}

export function getByPath(obj: unknown, path: string): number {
  let o = obj as Record<string, unknown>;
  for (const k of path.split('.')) o = o[k] as Record<string, unknown>;
  return o as unknown as number;
}
