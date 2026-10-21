/**
 * Car physics types and lookups. Every number lives in drivingParams.json
 * (base tuning, per car overrides, drivetrains, performance part tiers); this
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
  };
  /**
   * One grip curve over the normalized slip vector (sideways slip over peakSlipDeg, slip ratio over
   * peakSlipRatio): linear to the peak at length 1, down to the sliding grip at fullSlideDeg / peakSlipDeg.
   */
  tires: {
    gripFront: number;
    gripRear: number;
    /** Slip angle of peak grip (deg). */
    peakSlipDeg: number;
    /** Slip ratio (tread speed over road speed, minus one) of peak grip. */
    peakSlipRatio: number;
    /** Slip angle where grip has fallen to slideGrip. */
    fullSlideDeg: number;
    /** Grip of a tire sliding sideways, fraction of peak. */
    slideGrip: number;
    /** Grip of a tire sliding lengthways (spinning or locked, going straight), fraction of peak. */
    slideGripLong: number;
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
  };
  aero: {
    drag: number;
    downforce: number;
  };
  nitrous: {
    /** Seconds of boost from a full tank. */
    capacity: number;
    force: number;
    torqueMul: number;
    /** Tank fraction per second while drifting. */
    refillDrift: number;
    refillNearMiss: number;
    refillDraft: number;
    draftDragMul: number;
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
  };
}

export const GRAVITY = 9.81;

type BaseTuning = Omit<CarTuning, 'carId' | 'geometry'>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

const BASE = params.base as unknown as BaseTuning;
/** Per car deep-partial overrides from drivingParams.json (absolute values, `_` keys are comments). */
export const CAR_OVERRIDES = params.cars as unknown as Record<string, DeepPartial<BaseTuning>>;

// ---------------------------------------------------------------------------
// Performance parts. Index = tier: 0 stock, 1 street, 2 pro, 3 extreme.
// ---------------------------------------------------------------------------
export const TIER_NAMES = ['Stock', 'Street', 'Pro', 'Extreme'] as const;
export type Tier = 0 | 1 | 2 | 3;

export const PERFORMANCE_CATEGORIES = ['engine', 'turbo', 'exhaust', 'transmission', 'tires', 'suspension', 'brakes', 'weight', 'nitrous'] as const;
export type PerformanceCategory = (typeof PERFORMANCE_CATEGORIES)[number];

type TierTable = readonly [number, number, number, number];
export interface PartTiers {
  engine: { torqueMul: TierTable; redlineAdd: TierTable };
  turbo: { torqueMul: TierTable; highRpmBoost: TierTable };
  exhaust: { torqueMul: TierTable };
  transmission: { shiftTime: TierTable; finalDriveMul: TierTable };
  tires: { gripMul: TierTable };
  suspension: { frequencyMul: TierTable; gripMul: TierTable; steerRateMul: TierTable };
  brakes: { forceMul: TierTable };
  weight: { massMul: TierTable };
  nitrous: { capacity: TierTable; force: TierTable };
}
export const PART_TIERS = params.performanceParts as unknown as PartTiers;

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
  /** Most extra nitrous one visit refills (tank fraction). */
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

const resolved = new Map<string, CarTuning>();

export function getBaseTuning(carId: string): CarTuning {
  const id = CAR_IDS.includes(carId) ? carId : CAR_IDS[0];
  let t = resolved.get(id);
  if (!t) {
    const base = deepClone(BASE) as unknown as Record<string, unknown>;
    mergeOverride(base, (CAR_OVERRIDES[id] ?? {}) as Record<string, unknown>, `cars.${id}`);
    t = { ...(base as unknown as BaseTuning), carId: id, geometry: geometryFromManifest(id) };
    if (!DRIVETRAIN_LAYOUTS.includes(t.drivetrain.layout)) throw new Error(`drivingParams.json: cars.${id}.drivetrain.layout must be one of ${DRIVETRAIN_LAYOUTS.join(', ')}`);
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
 * Fingerprint of a car's stock tuning plus the part tiers. Saved tuning panel
 * values store it and is discarded when drivingParams.json changes, so stale
 * browser overrides never mask edits to the file.
 */
export function tuningHash(carId: string): string {
  return hashString(JSON.stringify(getBaseTuning(carId)) + JSON.stringify(PART_TIERS));
}

// ---------------------------------------------------------------------------
// Ambient traffic (src/sim/traffic.ts): the civilian cars' numbers.
// ---------------------------------------------------------------------------

/** One civilian vehicle kind: its collision box and mass. */
export interface TrafficKind {
  /** Silhouette the renderer draws (render/traffic.ts): sedan, hatch, van, taxi. */
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
