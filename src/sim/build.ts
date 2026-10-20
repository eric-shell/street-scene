/**
 * Car build schema. A build has two halves:
 *  - visual: read only by the renderer and garage. Never affects lap times.
 *  - performance: read by the sim through applyBuild().
 * Validation clamps anything imported from storage or share codes.
 */
import { CarTuning, PART_TIERS, PERFORMANCE_CATEGORIES, PerformanceCategory, Tier, DEFAULT_CAR_ID, SELECTABLE_CAR_IDS, getBaseTuning } from './tuning';
import { PART_SLOTS, PartSlot } from '../shared/parts';

export type PerformanceBuild = Record<PerformanceCategory, Tier>;

export const PAINT_FINISHES = ['gloss', 'metallic', 'matte', 'pearl', 'candy'] as const;
export type PaintFinish = (typeof PAINT_FINISHES)[number];

export const VINYL_SHAPES = ['stripe', 'twinStripe', 'flame', 'tribal', 'sponsorA', 'sponsorB', 'sponsorC', 'number', 'star', 'chevron'] as const;
export type VinylShape = (typeof VINYL_SHAPES)[number];

export const GLOW_PATTERNS = ['steady', 'pulse', 'breathe', 'strobe', 'alternate', 'wave', 'chase'] as const;
export type GlowPattern = (typeof GLOW_PATTERNS)[number];

export const MAX_DECALS = 8;

export interface DecalLayer {
  shape: VinylShape;
  color: string;
  /** Hit point and surface normal in car space. */
  pos: [number, number, number];
  normal: [number, number, number];
  /** Degrees. */
  rotation: number;
  /** Meters (width of the projected decal). */
  scale: number;
  mirror: boolean;
  /** For the number shape. */
  text?: string;
}

/** Per axle stance. Old builds had one offset and one wheel size for both axles; validation migrates them. */
export interface AxleStance {
  /** Degrees, negative = top of the wheel leans in. */
  camber: number;
  /** Meters the wheel moves outward from its stock track. */
  offset: number;
  /** Rim diameter multiplier. The tire's outer diameter never changes (rim grows, sidewall gets thinner). */
  wheelSize: number;
}

export const AXLES = ['front', 'rear'] as const;
export type Axle = (typeof AXLES)[number];

/** Limits shared by validation and the garage sliders. */
export const STANCE_LIMITS = {
  rideHeight: [-0.08, 0.06],
  camber: [-10, 2],
  offset: [-0.03, 0.08],
  wheelSize: [0.85, 1.25],
} as const;

export interface VisualBuild {
  paint: { color: string; finish: PaintFinish };
  trimColor: string;
  /** partId per slot; null means stock (base meshes) or none for optional slots. */
  parts: Partial<Record<PartSlot, string | null>>;
  wheels: { color: string };
  decals: DecalLayer[];
  stance: { rideHeight: number; front: AxleStance; rear: AxleStance };
  tint: { darkness: number; color: string };
  underglow: {
    enabled: boolean;
    color: string;
    /** Second color for alternate / chase patterns. */
    color2: string;
    pattern: GlowPattern;
    /** 0.2..2 */
    brightness: number;
    /** Pattern speed multiplier, 0.25..3 */
    speed: number;
    /** Glow spread around the car, 0.6..1.6 */
    size: number;
  };
  headlightColor: string;
  taillightColor: string;
}

export interface CarBuild {
  version: 1;
  name: string;
  carId: string;
  visual: VisualBuild;
  performance: PerformanceBuild;
}

export function stockPerformance(): PerformanceBuild {
  const p = {} as PerformanceBuild;
  for (const c of PERFORMANCE_CATEGORIES) p[c] = 0;
  return p;
}

export function defaultVisual(): VisualBuild {
  return {
    paint: { color: '#d11f3f', finish: 'metallic' },
    trimColor: '#15161a',
    parts: {},
    wheels: { color: '#c9ced8' },
    decals: [],
    stance: { rideHeight: 0, front: { camber: 0, offset: 0, wheelSize: 1 }, rear: { camber: 0, offset: 0, wheelSize: 1 } },
    tint: { darkness: 0.55, color: '#101820' },
    underglow: { enabled: false, color: '#00e5ff', color2: '#ff3df2', pattern: 'steady', brightness: 1, speed: 1, size: 1 },
    headlightColor: '#eaf2ff',
    taillightColor: '#ff1a2a',
  };
}

export function defaultBuild(carId = DEFAULT_CAR_ID): CarBuild {
  return { version: 1, name: 'My Ride', carId, visual: defaultVisual(), performance: stockPerformance() };
}

/** Pure: derive the tuning the sim uses from base tuning and performance parts. */
export function applyBuild(base: CarTuning, perf: PerformanceBuild): CarTuning {
  const t: CarTuning = JSON.parse(JSON.stringify(base));
  const p = validatePerformance(perf);
  t.engine.torqueMul *= PART_TIERS.engine.torqueMul[p.engine] * PART_TIERS.turbo.torqueMul[p.turbo] * PART_TIERS.exhaust.torqueMul[p.exhaust];
  t.engine.redline += PART_TIERS.engine.redlineAdd[p.engine];
  // Turbo adds more at the top of the rev range.
  const boost = PART_TIERS.turbo.highRpmBoost[p.turbo];
  t.engine.torqueCurve = t.engine.torqueCurve.map(([rpm, nm]) => [rpm, nm * (1 + boost * Math.max(0, (rpm - 3000) / 4000))]);
  t.gearbox.shiftTime = PART_TIERS.transmission.shiftTime[p.transmission];
  t.gearbox.finalDrive *= PART_TIERS.transmission.finalDriveMul[p.transmission];
  const grip = PART_TIERS.tires.gripMul[p.tires] * PART_TIERS.suspension.gripMul[p.suspension];
  t.tires.gripFront *= grip;
  t.tires.gripRear *= grip;
  t.suspension.frequency *= PART_TIERS.suspension.frequencyMul[p.suspension];
  t.steering.rateDegPerSec *= PART_TIERS.suspension.steerRateMul[p.suspension];
  t.brakes.force *= PART_TIERS.brakes.forceMul[p.brakes];
  t.mass *= PART_TIERS.weight.massMul[p.weight];
  t.nitrous.capacity = PART_TIERS.nitrous.capacity[p.nitrous];
  t.nitrous.force = PART_TIERS.nitrous.force[p.nitrous];
  return t;
}

export function tuningForBuild(carId: string, perf: PerformanceBuild): CarTuning {
  return applyBuild(getBaseTuning(carId), perf);
}

// ---------------------------------------------------------------------------
// Validation: accepts unknown input, always returns a usable, clamped build.
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < lo ? lo : n > hi ? hi : n;
};
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const PART_ID = /^[A-Za-z0-9_\-.]{1,64}$/;

export function validatePerformance(v: unknown): PerformanceBuild {
  const o = obj(v);
  const p = stockPerformance();
  for (const c of PERFORMANCE_CATEGORIES) p[c] = Math.round(num(o[c], 0, 3, 0)) as Tier;
  return p;
}

export function validateVisual(v: unknown): VisualBuild {
  const o = obj(v);
  const d = defaultVisual();
  const paint = obj(o.paint);
  const wheels = obj(o.wheels);
  const stance = obj(o.stance);
  const tint = obj(o.tint);
  const glow = obj(o.underglow);
  const partsIn = obj(o.parts);
  const parts: VisualBuild['parts'] = {};
  for (const slot of PART_SLOTS) {
    const val = partsIn[slot];
    if (val === null) parts[slot] = null;
    else if (typeof val === 'string' && PART_ID.test(val)) parts[slot] = val;
  }
  const decals: DecalLayer[] = [];
  if (Array.isArray(o.decals)) {
    for (const raw of o.decals.slice(0, MAX_DECALS)) {
      const dl = obj(raw);
      const vec = (x: unknown, lim: number): [number, number, number] => {
        const a = Array.isArray(x) ? x : [];
        return [num(a[0], -lim, lim, 0), num(a[1], -lim, lim, 0), num(a[2], -lim, lim, 0)];
      };
      const nrm = vec(dl.normal, 1);
      const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
      decals.push({
        shape: oneOf(dl.shape, VINYL_SHAPES, 'stripe'),
        color: color(dl.color, '#ffffff'),
        pos: vec(dl.pos, 4),
        normal: len > 1e-3 ? [nrm[0] / len, nrm[1] / len, nrm[2] / len] : [1, 0, 0],
        rotation: num(dl.rotation, -180, 180, 0),
        scale: num(dl.scale, 0.1, 3, 0.8),
        mirror: dl.mirror === true,
        text: typeof dl.text === 'string' ? dl.text.replace(/[^0-9]/g, '').slice(0, 2) : undefined,
      });
    }
  }
  // Stance per axle. Legacy builds (saves and share codes from before per axle stance) had
  // stance.camberFront / camberRear, one stance.offset and wheels.size; they seed both axles.
  const L = STANCE_LIMITS;
  const legacySize = num(wheels.size, L.wheelSize[0], L.wheelSize[1], 1);
  const legacyOffset = num(stance.offset, L.offset[0], L.offset[1], 0);
  const axle = (raw: unknown, legacyCamber: unknown): AxleStance => {
    const a = obj(raw);
    return {
      camber: num(a.camber, L.camber[0], L.camber[1], num(legacyCamber, L.camber[0], L.camber[1], 0)),
      offset: num(a.offset, L.offset[0], L.offset[1], legacyOffset),
      wheelSize: num(a.wheelSize, L.wheelSize[0], L.wheelSize[1], legacySize),
    };
  };
  return {
    paint: { color: color(paint.color, d.paint.color), finish: oneOf(paint.finish, PAINT_FINISHES, d.paint.finish) },
    trimColor: color(o.trimColor, d.trimColor),
    parts,
    wheels: { color: color(wheels.color, d.wheels.color) },
    decals,
    stance: {
      rideHeight: num(stance.rideHeight, L.rideHeight[0], L.rideHeight[1], 0),
      front: axle(stance.front, stance.camberFront),
      rear: axle(stance.rear, stance.camberRear),
    },
    tint: { darkness: num(tint.darkness, 0, 0.95, d.tint.darkness), color: color(tint.color, d.tint.color) },
    underglow: {
      enabled: glow.enabled === true,
      color: color(glow.color, d.underglow.color),
      color2: color(glow.color2, d.underglow.color2),
      pattern: oneOf(glow.pattern, GLOW_PATTERNS, 'steady'),
      brightness: num(glow.brightness, 0.2, 2, 1),
      speed: num(glow.speed, 0.25, 3, 1),
      size: num(glow.size, 0.6, 1.6, 1),
    },
    headlightColor: color(o.headlightColor, d.headlightColor),
    taillightColor: color(o.taillightColor, d.taillightColor),
  };
}

export function validateBuild(v: unknown): CarBuild {
  const o = obj(v);
  const carId = typeof o.carId === 'string' && SELECTABLE_CAR_IDS.includes(o.carId) ? o.carId : DEFAULT_CAR_ID;
  const name = typeof o.name === 'string' ? o.name.replace(/[<>]/g, '').slice(0, 24) || 'My Ride' : 'My Ride';
  const visual = validateVisual(o.visual);
  // A build for a car that is no longer offered moves to the default car; its parts do not fit.
  if (carId !== o.carId) visual.parts = visual.parts.wheels ? { wheels: visual.parts.wheels } : {};
  return { version: 1, name, carId, visual, performance: validatePerformance(o.performance) };
}
