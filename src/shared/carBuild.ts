/**
 * A car build as the garage saves and shares it: the car, a name, the visual half (paint, parts, wheels,
 * vinyls, stance, tint, underglow; read only by the renderer and the garage, never by the sim) and the
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
  wheels: {
    /** Front wheel color (legacy builds, saved before per axle colors, used it for all four). */
    color: string;
    /** Rear wheel color; matches the front unless the garage's axles are unlinked. */
    rearColor: string;
  };
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
    wheels: { color: '#c9ced8', rearColor: '#c9ced8' },
    decals: [],
    stance: { rideHeight: 0, front: { camber: 0, offset: 0, wheelSize: 1 }, rear: { camber: 0, offset: 0, wheelSize: 1 } },
    tint: { darkness: 0.55, color: '#101820' },
    underglow: { enabled: false, color: '#00e5ff', color2: '#ff3df2', pattern: 'steady', brightness: 1, speed: 1, size: 1 },
  };
}

export function defaultBuild(carId = DEFAULT_CAR_ID): CarBuild {
  return { version: 1, name: DEFAULT_BUILD_NAME, carId, visual: defaultVisual(), performance: stockPerformance() };
}

// ---------------------------------------------------------------------------
// Validation: accepts unknown input, always returns a usable, clamped build.
// ---------------------------------------------------------------------------

const PART_ID = /^[A-Za-z0-9_\-.]{1,64}$/;

/**
 * Cars renamed when they moved from IceMaan FBX imports to authored models,
 * so saved builds and share codes made before the move still load. The Proto
 * Compact has since been retired: its builds move to the default car.
 */
const RENAMED_CARS: Record<string, string> = { gc14: 'protoHatch', s64: 'protoCompact' };

/**
 * Wheels retired for the shared wheel set (docs/carWheels.md). The new wheels took the old ones'
 * names, so a saved build keeps the name it showed.
 */
const RENAMED_WHEELS: Record<string, string> = {
  wheel_protoCompact_0: 'wheel_kiba', wheel_protoCompact_1: 'wheel_hoshi', wheel_protoCompact_2: 'wheel_rensa', wheel_protoCompact_3: 'wheel_tsuki',
  wheel_protoHatch_1: 'wheel_ginga', wheel_protoHatch_2: 'wheel_hibana', wheel_protoHatch_3: 'wheel_senko', wheel_protoHatch_4: 'wheel_arashi',
  wheel_proto_5spoke: 'wheel_arashi', wheel_proto_deepdish: 'wheel_rensa',
};

/** A part id under its current name; null for whole-body kits that were split into bumpers and skirts. */
function renamedPart(raw: string): string | null {
  const id = RENAMED_WHEELS[raw] ?? raw;
  const m = /^(wheel_)?(gc14|s64)_(.+)$/.exec(id);
  if (!m) return id;
  if (m[3].startsWith('body_')) return null;
  const renamed = `${m[1] ?? ''}${RENAMED_CARS[m[2]]}_${m[3]}`;
  return RENAMED_WHEELS[renamed] ?? renamed;
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
    else if (typeof val === 'string' && PART_ID.test(val)) {
      const id = renamedPart(val);
      if (id) parts[slot] = id;
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
  // Stance per axle. Legacy builds (saves and share codes from before per axle stance) had
  // stance.camberFront / camberRear, one stance.offset and wheels.size; they seed both axles.
  const wheelColor = hexColor(wheels.color, d.wheels.color);
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
    paint: { color: hexColor(paint.color, d.paint.color), finish: oneOf(paint.finish, PAINT_FINISHES, d.paint.finish) },
    trimColor: hexColor(o.trimColor, d.trimColor),
    parts,
    wheels: { color: wheelColor, rearColor: hexColor(wheels.rearColor, wheelColor) },
    decals,
    stance: {
      rideHeight: num(stance.rideHeight, L.rideHeight[0], L.rideHeight[1], 0),
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
  const savedId = typeof o.carId === 'string' ? (RENAMED_CARS[o.carId] ?? o.carId) : undefined;
  const carId = savedId && SELECTABLE_CAR_IDS.includes(savedId) ? savedId : DEFAULT_CAR_ID;
  const name = typeof o.name === 'string' ? o.name.replace(/[<>]/g, '').slice(0, BUILD_NAME_MAX) || DEFAULT_BUILD_NAME : DEFAULT_BUILD_NAME;
  const visual = validateVisual(o.visual);
  // A build for a car that is no longer offered moves to the default car; its parts do not fit.
  if (carId !== savedId) visual.parts = visual.parts.wheels ? { wheels: visual.parts.wheels } : {};
  return { version: 1, name, carId, visual, performance: validatePerformance(o.performance) };
}
