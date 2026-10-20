/**
 * Every car physics constant lives here: the base tuning shared by all cars,
 * per car overrides, and the performance part tier tables that applyBuild()
 * uses. Nothing else in the sim should contain tuning magic numbers.
 */
import manifest from '../assets/carManifest.json';

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

export interface CarTuning {
  carId: string;
  mass: number;
  /** Multiplies the box approximation of yaw inertia. Higher = lazier rotation. */
  yawInertiaScale: number;
  cgHeight: number;
  geometry: CarGeometry;
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
    /** Corner guard rails are smooth: little scrub and spin so racers keep momentum. */
    railRestitution: number;
    railScrub: number;
    railAngularScale: number;
    carRestitution: number;
    angularScale: number;
  };
}

export const GRAVITY = 9.81;

const BASE: Omit<CarTuning, 'carId' | 'geometry'> = {
  mass: 1250,
  yawInertiaScale: 1.15,
  cgHeight: 0.4,
  engine: {
    idleRpm: 900,
    redline: 7600,
    torqueCurve: [
      [800, 150],
      [2000, 215],
      [3500, 262],
      [5000, 285],
      [6200, 278],
      [7000, 255],
      [7800, 220],
    ],
    torqueMul: 1,
    engineBraking: 55,
    launchRpm: 4200,
  },
  gearbox: {
    ratios: [3.25, 2.15, 1.6, 1.25, 1.02, 0.85],
    reverseRatio: 3.4,
    finalDrive: 3.9,
    efficiency: 0.86,
    shiftTime: 0.22,
    upshiftRpmFrac: 0.93,
    downshiftRpmFrac: 0.48,
    reverseMaxSpeed: 14,
  },
  tires: {
    gripFront: 1.18,
    gripRear: 1.12,
    peakSlipDeg: 9,
    fullSlideDeg: 35,
    slideGrip: 0.86,
    minLateralShare: 0.7,
    rollingResistance: 14,
  },
  suspension: {
    frequency: 1.55,
    dampingRatio: 0.42,
    travel: 0.12,
  },
  brakes: {
    force: 14500,
    frontBias: 0.66,
    handbrakeForce: 4200,
  },
  steering: {
    maxDeg: 32,
    highSpeedDeg: 6.5,
    fadeSpeed: 42,
    rateDegPerSec: 150,
    counterSteerAllowance: 0.75,
  },
  aero: {
    drag: 0.4,
    downforce: 0.9,
  },
  nitrous: {
    capacity: 3.2,
    force: 3600,
    torqueMul: 1.25,
    refillDrift: 0.09,
    refillNearMiss: 0.18,
    refillDraft: 0.07,
    draftDragMul: 0.7,
  },
  drift: {
    handbrakeRearGrip: 0.38,
    handbrakeYawTorque: 7000,
    clutchKickRearGrip: 0.55,
    clutchKickTime: 0.45,
    powerOversteerGrip: 0.76,
    powerOversteerMinSlipDeg: 12,
    gripDropRate: 6,
    gripRecoverRate: 1.4,
    maxSlipDeg: 44,
    assistTorque: 30000,
    yawDamping: 1800,
    driftCarve: 0.55,
    yawDampingLowSpeed: 4,
  },
  surface: {
    sidewalkGrip: 0.92,
    offroadGrip: 0.75,
    offroadDrag: 900,
  },
  collision: {
    wallRestitution: 0.12,
    wallScrub: 0.22,
    railRestitution: 0.04,
    railScrub: 0.05,
    railAngularScale: 0.18,
    carRestitution: 0.3,
    angularScale: 0.45,
  },
};

/** Per car differences, applied over BASE. Kept small so every car is competitive. */
export const CAR_OVERRIDES: Record<string, { mass?: number; torqueMul?: number; gripMul?: number; redlineAdd?: number }> = {
  proto: {},
  cc96: { mass: 1180, torqueMul: 0.97, gripMul: 1.0, redlineAdd: 300 },
  s64: { mass: 1040, torqueMul: 0.86, gripMul: 1.03, redlineAdd: 500 },
  gc14: { mass: 1340, torqueMul: 1.1, gripMul: 0.99 },
  ar7: { mass: 1220, torqueMul: 1.03, gripMul: 1.02, redlineAdd: 900 },
};

// ---------------------------------------------------------------------------
// Performance parts. Index = tier: 0 stock, 1 street, 2 pro, 3 extreme.
// ---------------------------------------------------------------------------
export const TIER_NAMES = ['Stock', 'Street', 'Pro', 'Extreme'] as const;
export type Tier = 0 | 1 | 2 | 3;

export const PERFORMANCE_CATEGORIES = ['engine', 'turbo', 'exhaust', 'transmission', 'tires', 'suspension', 'brakes', 'weight', 'nitrous'] as const;
export type PerformanceCategory = (typeof PERFORMANCE_CATEGORIES)[number];

export const PART_TIERS = {
  engine: { torqueMul: [1, 1.07, 1.15, 1.25], redlineAdd: [0, 200, 450, 700] },
  turbo: { torqueMul: [1, 1.08, 1.17, 1.28], highRpmBoost: [0, 0.04, 0.08, 0.13] },
  exhaust: { torqueMul: [1, 1.03, 1.05, 1.08] },
  transmission: { shiftTime: [0.22, 0.16, 0.11, 0.07], finalDriveMul: [1, 0.98, 0.95, 0.92] },
  tires: { gripMul: [1, 1.04, 1.08, 1.13] },
  suspension: { frequencyMul: [1, 1.12, 1.25, 1.38], gripMul: [1, 1.015, 1.03, 1.045], steerRateMul: [1, 1.06, 1.12, 1.18] },
  brakes: { forceMul: [1, 1.12, 1.25, 1.4] },
  weight: { massMul: [1, 0.96, 0.92, 0.87] },
  nitrous: { capacity: [3.2, 3.9, 4.7, 5.6], force: [3600, 4100, 4700, 5400] },
} as const;

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
/** Cars offered in the garage and to AI opponents. Others stay loadable (tests, old saves). */
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

export function getBaseTuning(carId: string): CarTuning {
  const id = CAR_IDS.includes(carId) ? carId : CAR_IDS[0];
  const t: CarTuning = { ...deepClone(BASE), carId: id, geometry: geometryFromManifest(id) };
  const o = CAR_OVERRIDES[id] ?? {};
  if (o.mass) t.mass = o.mass;
  if (o.torqueMul) t.engine.torqueMul *= o.torqueMul;
  if (o.gripMul) {
    t.tires.gripFront *= o.gripMul;
    t.tires.gripRear *= o.gripMul;
  }
  if (o.redlineAdd) t.engine.redline += o.redlineAdd;
  return t;
}

export function setByPath(obj: unknown, path: string, value: number): void {
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

/** Tunables exposed in the dev panel: [path, min, max, step]. */
export const DEV_PANEL_PARAMS: [string, number, number, number][] = [
  ['mass', 700, 2000, 10],
  ['yawInertiaScale', 0.5, 2, 0.05],
  ['cgHeight', 0.2, 1, 0.01],
  ['engine.torqueMul', 0.5, 2.5, 0.01],
  ['gearbox.finalDrive', 2.5, 5.5, 0.05],
  ['gearbox.shiftTime', 0.02, 0.5, 0.01],
  ['tires.gripFront', 0.6, 1.8, 0.01],
  ['tires.gripRear', 0.6, 1.8, 0.01],
  ['tires.peakSlipDeg', 3, 15, 0.5],
  ['tires.fullSlideDeg', 10, 60, 1],
  ['tires.slideGrip', 0.4, 1, 0.01],
  ['suspension.frequency', 0.8, 3, 0.05],
  ['suspension.dampingRatio', 0.1, 1.2, 0.02],
  ['brakes.force', 5000, 30000, 100],
  ['steering.maxDeg', 15, 45, 0.5],
  ['steering.highSpeedDeg', 2, 15, 0.25],
  ['steering.rateDegPerSec', 40, 400, 5],
  ['aero.drag', 0.1, 1, 0.01],
  ['aero.downforce', 0, 3, 0.05],
  ['nitrous.force', 0, 9000, 100],
  ['drift.handbrakeRearGrip', 0.1, 1, 0.01],
  ['drift.handbrakeYawTorque', 0, 20000, 250],
  ['drift.powerOversteerGrip', 0.3, 1, 0.01],
  ['drift.maxSlipDeg', 20, 80, 1],
  ['drift.assistTorque', 0, 60000, 250],
  ['drift.yawDamping', 0, 8000, 50],
  ['drift.driftCarve', 0, 2, 0.05],
];
