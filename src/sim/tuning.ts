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
  tires: {
    gripFront: number;
    gripRear: number;
    peakSlipDeg: number;
    /** Slip angle where grip has fallen to slideGrip. */
    fullSlideDeg: number;
    slideGrip: number;
    /** Lateral grip kept even when longitudinal force uses the whole friction circle. */
    minLateralShare: number;
    rollingResistance: number;
  };
  /** Driven wheel spin (slip ratio proxy per driven axle) and traction control. */
  traction: {
    /** Drive demand / available grip ratio where the driven wheels break loose. */
    breakaway: number;
    /** How much cornering eats into forward grip (friction circle). 0 = none, 1 = none left at peak slip. */
    cornerCoupling: number;
    /** Once spinning, the wheels keep spinning down to demand = breakaway * spinHold. */
    spinHold: number;
    /** Spin level per unit of demand above the threshold (2.5 = full spin at 40% over). */
    spinPerExcess: number;
    /** Wheelspin build rate (1/s at full excess). */
    spinBuildRate: number;
    /** Wheelspin recovery rate (1/s). */
    spinRecoverRate: number;
    /** Forward grip of a fully spinning axle, fraction of peak. */
    spinLongGrip: number;
    /** Sideways grip of a fully spinning axle, fraction of normal. */
    spinLateralGrip: number;
    /** Extra drive torque from dumping the clutch (launches, clutch kicks), at clutch slip = redline. */
    launchBoost: number;
    /** Wheelspin forced on the driven axles by a clutch kick. */
    clutchKickSpin: number;
    /** Engine rpm flare above road speed at full wheelspin. */
    spinRpm: number;
    /** Traction control: max drive demand as a fraction of available grip. */
    tcSlipTarget: number;
    /** Traction control: cuts throttle above this body slip angle (stops power oversteer). */
    tcMaxSlipDeg: number;
  };
  suspension: {
    frequency: number;
    dampingRatio: number;
    travel: number;
  };
  brakes: {
    force: number;
    frontBias: number;
    handbrakeForce: number;
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
  drift: {
    handbrakeRearGrip: number;
    /** Extra yaw torque while the handbrake is pulled with steering, so the rear snaps out. */
    handbrakeYawTorque: number;
    clutchKickRearGrip: number;
    clutchKickTime: number;
    powerOversteerGrip: number;
    powerOversteerMinSlipDeg: number;
    gripDropRate: number;
    gripRecoverRate: number;
    maxSlipDeg: number;
    assistTorque: number;
    /** Always-on yaw damping, Nm per rad/s. Keeps the car from feeling twitchy. */
    yawDamping: number;
    /** Rad/s that velocity bends toward the heading while drifting on throttle. */
    driftCarve: number;
    yawDampingLowSpeed: number;
  };
  surface: {
    sidewalkGrip: number;
    offroadGrip: number;
    offroadDrag: number;
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
 * Fingerprint of a car's stock tuning plus the part tiers. Saved test drive
 * tuning stores it and is discarded when drivingParams.json changes, so stale
 * browser overrides never mask edits to the file.
 */
export function tuningHash(carId: string): string {
  return hashString(JSON.stringify(getBaseTuning(carId)) + JSON.stringify(PART_TIERS));
}

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
