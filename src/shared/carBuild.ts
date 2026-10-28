/**
 * A car build as the garage saves and shares it: the car, a name, the visual half (paint, parts, wheels,
 * calipers, vinyls, stance, tint, underglow; read only by the renderer and the garage, never by the sim) and the
 * performance half (sim/build.ts, the only part the sim reads, through applyBuild). Validation clamps
 * anything imported from storage or share codes and migrates old saves.
 */
import { PART_SLOTS, PartSlot } from './parts';
import { hexColor, num, obj, oneOf } from './validate';
import { DEFAULT_CAR_ID, SELECTABLE_CAR_IDS } from '../sim/tuning';
import { stockPerformance, validatePerformance, type PerformanceBuild } from '../sim/build';

/** A new build's name, and the longest a name may be. */
export const DEFAULT_BUILD_NAME = 'My Ride';
export const BUILD_NAME_MAX = 24;

export const PAINT_FINISHES = ['gloss', 'metallic', 'matte', 'pearl', 'candy'] as const;
export type PaintFinish = (typeof PAINT_FINISHES)[number];

/** A painted surface: the body, each axle's wheels and the calipers all take a color and a finish. */
export interface Paint {
  color: string;
  finish: PaintFinish;
}

/** An accent's paint (wheels, calipers): its own, or the body's while matched (it follows later body changes). */
export interface AccentPaint extends Paint {
  match: boolean;
}

export const VINYL_SHAPES = ['stripe', 'twinStripe', 'flame', 'tribal', 'sponsorA', 'sponsorB', 'sponsorC', 'number', 'star', 'chevron'] as const;
export type VinylShape = (typeof VINYL_SHAPES)[number];

export const GLOW_PATTERNS = ['steady', 'pulse', 'breathe', 'strobe', 'alternate', 'wave', 'chase'] as const;
export type GlowPattern = (typeof GLOW_PATTERNS)[number];

/** Tire shapes (render/car/tireShapes.ts draws each). */
export const TIRE_SHAPES = ['standard', 'stretched'] as const;
export type TireShape = (typeof TIRE_SHAPES)[number];

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

/** Per axle stance. Old builds had one ride height, offset and wheel size for both axles; validation migrates them. */
export interface AxleStance {
  /** Meters the body sits above (+) or below (-) stock over this axle; front and rear apart rake the body. */
  rideHeight: number;
  /** Degrees, negative = top of the wheel leans in. */
  camber: number;
  /** Meters the wheel moves outward from its stock track. */
  offset: number;
  /** Wheel diameter multiplier. The tire's outer diameter never changes (the wheel grows, sidewall gets thinner). */
  wheelSize: number;
  /** Wheel and tire width multiplier along the axle. The outer face stays put (same poke); the extra width grows inward, toward the car. */
  wheelWidth: number;
}

export const AXLES = ['front', 'rear'] as const;
export type Axle = (typeof AXLES)[number];

/** Limits shared by validation and the garage sliders. */
export const STANCE_LIMITS = {
  rideHeight: [-0.09, 0.07],
  camber: [-10, 2],
  offset: [-0.035, 0.09],
  wheelSize: [0.85, 1.25],
  wheelWidth: [0.85, 1.35],
} as const;

export interface VisualBuild {
  paint: Paint;
  trimColor: string;
  /** partId per slot; null means stock (base meshes) or none for optional slots. */
  parts: Partial<Record<PartSlot, string | null>>;
  wheels: {
    /** Front wheel paint (legacy builds saved one `color` for all four; validation migrates it). */
    paint: AccentPaint;
    /** Rear wheel paint; matches the front unless the garage's wheel paint is unlinked. */
    rearPaint: AccentPaint;
    /** Rear wheel part id; null wears the front's (parts.wheels), so a car change keeps them matched. */
    rearPart: string | null;
    /** Front tire shape. */
    tire: TireShape;
    /** Rear tire shape; matches the front unless the garage's wheels are unlinked. */
    rearTire: TireShape;
  };
  /** Brake caliper paint, all four corners. */
  calipers: AccentPaint;
  decals: DecalLayer[];
  stance: { front: AxleStance; rear: AxleStance };
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
}

export interface CarBuild {
  version: 1;
  name: string;
  carId: string;
  visual: VisualBuild;
  performance: PerformanceBuild;
}

export function defaultVisual(): VisualBuild {
  return {
    paint: { color: '#d11f3f', finish: 'metallic' },
    trimColor: '#15161a',
    parts: {},
    wheels: { paint: { color: '#c9ced8', finish: 'metallic', match: false }, rearPaint: { color: '#c9ced8', finish: 'metallic', match: false }, rearPart: null, tire: 'standard', rearTire: 'standard' },
    calipers: { color: '#c41e3a', finish: 'gloss', match: false },
    decals: [],
    stance: { front: { rideHeight: 0, camber: 0, offset: 0, wheelSize: 1, wheelWidth: 1 }, rear: { rideHeight: 0, camber: 0, offset: 0, wheelSize: 1, wheelWidth: 1 } },
    tint: { darkness: 0.55, color: '#101820' },
    underglow: { enabled: false, color: '#00e5ff', color2: '#ff3df2', pattern: 'steady', brightness: 1, speed: 1, size: 1 },
  };
}

export function defaultBuild(carId = DEFAULT_CAR_ID): CarBuild {
  return { version: 1, name: DEFAULT_BUILD_NAME, carId, visual: defaultVisual(), performance: stockPerformance(carId) };
}

// ---------------------------------------------------------------------------
// Validation: accepts unknown input, always returns a usable, clamped build.
// ---------------------------------------------------------------------------

const PART_ID = /^[A-Za-z0-9_\-.]{1,64}$/;

/** A paint from storage or a share code; anything missing or invalid takes the fallback's. */
function validPaint(v: unknown, fallback: Paint): Paint {
  const o = obj(v);
  return { color: hexColor(o.color, fallback.color), finish: oneOf(o.finish, PAINT_FINISHES, fallback.finish) };
}

function validAccent(v: unknown, fallback: AccentPaint): AccentPaint {
  const o = obj(v);
  return { ...validPaint(o, fallback), match: typeof o.match === 'boolean' ? o.match : fallback.match };
}

export function validateVisual(v: unknown): VisualBuild {
  const o = obj(v);
  const d = defaultVisual();
  const wheels = obj(o.wheels);
  const stance = obj(o.stance);
  const tint = obj(o.tint);
  const glow = obj(o.underglow);
  const partsIn = obj(o.parts);
  const parts: VisualBuild['parts'] = {};
  for (const slot of PART_SLOTS) {
    const val = partsIn[slot];
    if (val === null) parts[slot] = null;
    else if (typeof val === 'string' && PART_ID.test(val)) {
      parts[slot] = val;
    }
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
        color: hexColor(dl.color, '#ffffff'),
        pos: vec(dl.pos, 4),
        normal: len > 1e-3 ? [nrm[0] / len, nrm[1] / len, nrm[2] / len] : [1, 0, 0],
        rotation: num(dl.rotation, -180, 180, 0),
        scale: num(dl.scale, 0.1, 3, 0.8),
        mirror: dl.mirror === true,
        text: typeof dl.text === 'string' ? dl.text.replace(/[^0-9]/g, '').slice(0, 2) : undefined,
      });
    }
  }
  // Wheel paint: builds from before wheel finishes saved a color per axle (one for all four before
  // that); it keeps the default finish. A missing rear follows the front.
  const wheelPaint = validAccent(wheels.paint, { ...d.wheels.paint, color: hexColor(wheels.color, d.wheels.paint.color) });
  const rearPaint = validAccent(wheels.rearPaint, { ...wheelPaint, color: hexColor(wheels.rearColor, wheelPaint.color) });
  // Stance per axle. Legacy builds (saves and share codes from before per axle stance) had
  // stance.camberFront / camberRear and one stance.rideHeight, stance.offset and wheels.size; they seed both axles.
  // The first set's mild and aggressive stretches are the stretched tire now; its meaty one, standard.
  const tireShape = (v: unknown, fallback: TireShape) => (v === 'meaty' ? 'standard' : oneOf(v === 'mildStretch' || v === 'aggressiveStretch' ? 'stretched' : v, TIRE_SHAPES, fallback));
  const tire = tireShape(wheels.tire, d.wheels.tire);
  const rearPart = typeof wheels.rearPart === 'string' && PART_ID.test(wheels.rearPart) ? wheels.rearPart : null;
  const L = STANCE_LIMITS;
  const legacySize = num(wheels.size, L.wheelSize[0], L.wheelSize[1], 1);
  const legacyOffset = num(stance.offset, L.offset[0], L.offset[1], 0);
  const legacyRide = num(stance.rideHeight, L.rideHeight[0], L.rideHeight[1], 0);
  const axle = (raw: unknown, legacyCamber: unknown): AxleStance => {
    const a = obj(raw);
    return {
      rideHeight: num(a.rideHeight, L.rideHeight[0], L.rideHeight[1], legacyRide),
      camber: num(a.camber, L.camber[0], L.camber[1], num(legacyCamber, L.camber[0], L.camber[1], 0)),
      offset: num(a.offset, L.offset[0], L.offset[1], legacyOffset),
      wheelSize: num(a.wheelSize, L.wheelSize[0], L.wheelSize[1], legacySize),
      // Builds from before the width slider have the stock width.
      wheelWidth: num(a.wheelWidth, L.wheelWidth[0], L.wheelWidth[1], 1),
    };
  };
  return {
    paint: validPaint(o.paint, d.paint),
    trimColor: hexColor(o.trimColor, d.trimColor),
    parts,
    wheels: { paint: wheelPaint, rearPaint, rearPart, tire, rearTire: tireShape(wheels.rearTire, tire) },
    calipers: validAccent(o.calipers, d.calipers),
    decals,
    stance: {
      front: axle(stance.front, stance.camberFront),
      rear: axle(stance.rear, stance.camberRear),
    },
    tint: { darkness: num(tint.darkness, 0, 0.95, d.tint.darkness), color: hexColor(tint.color, d.tint.color) },
    underglow: {
      enabled: glow.enabled === true,
      color: hexColor(glow.color, d.underglow.color),
      color2: hexColor(glow.color2, d.underglow.color2),
      pattern: oneOf(glow.pattern, GLOW_PATTERNS, 'steady'),
      brightness: num(glow.brightness, 0.2, 2, 1),
      speed: num(glow.speed, 0.25, 3, 1),
      size: num(glow.size, 0.6, 1.6, 1),
    },
  };
}

export function validateBuild(v: unknown): CarBuild {
  const o = obj(v);
  const savedId = typeof o.carId === 'string' ? o.carId : undefined;
  const carId = savedId && SELECTABLE_CAR_IDS.includes(savedId) ? savedId : DEFAULT_CAR_ID;
  const name = typeof o.name === 'string' ? o.name.replace(/[<>]/g, '').slice(0, BUILD_NAME_MAX) || DEFAULT_BUILD_NAME : DEFAULT_BUILD_NAME;
  const visual = validateVisual(o.visual);
  // A build for a car that is no longer offered moves to the default car; its parts do not fit.
  if (carId !== savedId) visual.parts = visual.parts.wheels ? { wheels: visual.parts.wheels } : {};
  return { version: 1, name, carId, visual, performance: validatePerformance(o.performance, carId) };
}
