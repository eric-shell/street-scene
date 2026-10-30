/**
 * A car build as the garage saves and shares it: the car, a name, the visual half (paint, parts, wheels,
 * calipers, vinyls, stance, tint, windshield banner, underglow; read only by the renderer and the garage, never by the sim) and the
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

/**
 * Every surface but the body (the wheel faces, lips, center caps and lug nuts, the calipers) also takes
 * chrome: one look, polished metal in CHROME_COLOR, never tinted. A chrome paint's color is always CHROME_COLOR
 * (validPaint), and the garage offers no color pick for it. The body keeps to PAINT_FINISHES.
 */
export const ACCENT_FINISHES = [...PAINT_FINISHES, 'chrome'] as const;
export type AccentFinish = (typeof ACCENT_FINISHES)[number];
/** Plain chrome's color (the Chrome material's, render/car/carMaterials.ts): the only color a chrome finish has. */
export const CHROME_COLOR = '#dedede';

/** A painted surface: the body, the roof, each axle's wheels and their trims, and the calipers all take a color and a finish. */
export interface Paint<F extends AccentFinish = PaintFinish> {
  color: string;
  finish: F;
}

/** An accent's paint (wheels, calipers, roof, mirror caps): its own, or the body's while matched (it follows later body changes). */
export interface AccentPaint<F extends AccentFinish = PaintFinish> extends Paint<F> {
  match: boolean;
}

/**
 * What a wheel trim (lip, center cap, lug nuts) wears: 'face' the axle's wheel paint, 'cap' the axle's resolved
 * center cap, 'body' the body paint (following later body changes), 'paint' its own color and finish (a lip starts
 * as chrome). WHEEL_TRIMS says which each trim offers.
 */
export const WHEEL_TRIM_MODES = ['face', 'cap', 'body', 'paint'] as const;
export type WheelTrimMode = (typeof WHEEL_TRIM_MODES)[number];

/** The wheel trims and the modes each offers (only a lip ships with a look of its own; the nuts can match the cap). */
export const WHEEL_TRIMS = {
  lip: ['face', 'body', 'paint'],
  cap: ['face', 'body', 'paint'],
  lugNuts: ['cap', 'face', 'body', 'paint'],
  hardware: ['cap', 'face', 'body', 'paint'],
} as const satisfies Record<string, readonly WheelTrimMode[]>;
export type WheelTrimName = keyof typeof WHEEL_TRIMS;

/** A wheel trim's finish; color and finish apply in 'paint' mode (and seed it again when a match is turned off). */
export interface WheelTrim {
  mode: WheelTrimMode;
  color: string;
  finish: AccentFinish;
}

export const VINYL_SHAPES = ['stripe', 'twinStripe', 'flame', 'tribal', 'sponsorA', 'sponsorB', 'sponsorC', 'number', 'star', 'chevron'] as const;
export type VinylShape = (typeof VINYL_SHAPES)[number];

/** The windshield banner's heights, shortest first (render/car/windshield.ts BANNER sets each one's share of the glass). */
export const BANNER_HEIGHTS = ['short', 'medium', 'tall'] as const;
export type BannerHeight = (typeof BANNER_HEIGHTS)[number];

/** Underglow patterns, in the garage's order. */
export const GLOW_PATTERNS = ['steady', 'pulse', 'strobe', 'chase', 'rainbow'] as const;
export type GlowPattern = (typeof GLOW_PATTERNS)[number];
/**
 * Patterns builds from before saved: 'breathe' was a slower pulse and 'alternate' a slow two-color strobe (the Speed
 * slider spans both), 'wave' the rainbow.
 */
const GLOW_RENAMES: Record<string, GlowPattern> = { breathe: 'pulse', alternate: 'strobe', wave: 'rainbow' };

/**
 * A car's unique features, each a switch a car's manifest offers (`bodyFeatures`, render/car/bodyFeatures.ts):
 * Euro mirrors narrow the mirror housings, a shaved hatch loses its handle, a shaved rubstrip loses the moulded
 * strip along the doors and the quarters, half cup handles fill each door handle's cup flush above the bar's middle,
 * leaving its lower half, and a black grille
 * paints the grille's body colored bars flat black like the lips and diffusers. Fog lights are a pair of round
 * lamps in the front bumper's outer intakes, and fit every front bumper; shaved markers press the fenders' side
 * repeaters flush, on every fender option. Every feature is bought per car, like a part (shared/economy.ts).
 */
export const BODY_FEATURES = ['euroMirrors', 'shavedHatch', 'shavedRubstrip', 'halfCupHandles', 'blackGrille', 'fogLights', 'shavedMarkers'] as const;
export type BodyFeature = (typeof BODY_FEATURES)[number];

/** The features' names, for the garage's switches and the dialogs that list what a build wears. */
export const FEATURE_LABELS: Record<BodyFeature, string> = {
  euroMirrors: 'Euro mirrors',
  shavedHatch: 'Shaved hatch',
  shavedRubstrip: 'Shaved rubstrip',
  halfCupHandles: 'Half cup handles',
  blackGrille: 'Black grille',
  fogLights: 'Fog lights',
  shavedMarkers: 'Shaved side markers',
};

/**
 * Catalog parts that became a feature: builds, share codes and ledgers still naming one get the plain part
 * (`part`, null for the slot's stock piece) and the feature switched on, owning the old part owns both.
 */
export const RETIRED_PARTS: Readonly<Record<string, { slot: PartSlot; part: string | null; feature: BodyFeature }>> = {
  wendtStrom_frontBumper_euroFogs: { slot: 'frontBumper', part: 'wendtStrom_frontBumper_euro', feature: 'fogLights' },
  wendtStrom_frontBumper_cupraRFogs: { slot: 'frontBumper', part: 'wendtStrom_frontBumper_cupraR', feature: 'fogLights' },
  wendtStrom_fenders_shaved: { slot: 'fenders', part: null, feature: 'shavedMarkers' },
};

/** Tire shapes (render/car/tireShapes.ts draws each). */
/** Tire stretch, least to most: none ('standard'), mild, and full ('stretched', the first stretched tire, so old saves keep their look). */
export const TIRE_SHAPES = ['standard', 'mild', 'stretched'] as const;
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
  /** partId per slot; null means stock (base meshes) or none for optional slots. */
  parts: Partial<Record<PartSlot, string | null>>;
  wheels: {
    /** Front wheel paint (legacy builds saved one `color` for all four; validation migrates it). */
    paint: AccentPaint<AccentFinish>;
    /** Rear wheel paint; matches the front unless the garage's wheel paint is unlinked. */
    rearPaint: AccentPaint<AccentFinish>;
    /** Rear wheel part id; null wears the front's (parts.wheels), so a car change keeps them matched. */
    rearPart: string | null;
    /** Front tire shape. */
    tire: TireShape;
    /** Rear tire shape; matches the front unless the garage's wheels are unlinked. */
    rearTire: TireShape;
    /** Raised brand lettering on the tires' outer sidewalls (both axles; render/car/tireTread.ts). Off by default; a missing value reads off. */
    lettering: boolean;
    /** The wheels' lips (the turned lip and barrel), both axles. */
    lip: WheelTrim;
    /** The wheels' center caps, both axles. */
    cap: WheelTrim;
    /** The house lug nuts, both axles (builds from before saved one of a few fixed finishes; validation migrates them). */
    lugNuts: WheelTrim;
    /** The wheels' bolt hardware (the Chrome faces of the wheel models: lip bolts and donor bits), both axles. Chrome by default; a missing value reads chrome. */
    hardware: WheelTrim;
  };
  /** Brake caliper paint, all four corners. */
  calipers: AccentPaint<AccentFinish>;
  /** The roof's paint (the stock Roof piece and any roof part): its own, or the body's while matched. Builds from before it read matched. */
  roof: AccentPaint;
  /** The mirror caps' paint (on cars whose manifest boxes them, render/car/mirrorCaps.ts): its own, chrome, or the body's while matched. Builds from before it read matched. */
  mirrors: AccentPaint<AccentFinish>;
  decals: DecalLayer[];
  stance: { front: AxleStance; rear: AxleStance };
  /** The side and rear windows' tint; the windshield stays clear. */
  tint: { darkness: number; color: string };
  /** A band across the top of the windshield. Builds from before it read off. */
  banner: {
    enabled: boolean;
    height: BannerHeight;
    /** Off, the band is the windows' tint film, under the glass; on, it is a vinyl over the glass in `paint`. */
    vinyl: boolean;
    /** The vinyl's paint, or the body's while matched. */
    paint: AccentPaint;
  };
  underglow: {
    enabled: boolean;
    color: string;
    /** Second color for the strobe and chase patterns (a black one strobes the primary on and off). */
    color2: string;
    pattern: GlowPattern;
    /** 0.2..2 */
    brightness: number;
    /** Pattern speed multiplier, 0.25..3 */
    speed: number;
    /** Glow spread around the car, 0.6..1.6 */
    size: number;
  };
  /**
   * Pops and bangs: how often the exhaust backfires on a lift, a shift or the limiter, as a multiple of the stock
   * rate (0 none, 1 stock, 2 double), 0..2. Flame and sound agree (render/car/exhaustFx.ts, audio/engineAudio.ts).
   * Cosmetic, so it lives here and never reaches the sim. A missing value reads 1.
   */
  popsBangs: number;
  /** The car's unique features switched on (BODY_FEATURES order); a car without one ignores it. Builds from before read none. */
  features: BodyFeature[];
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
    parts: {},
    wheels: { paint: { color: '#c9ced8', finish: 'metallic', match: false }, rearPaint: { color: '#c9ced8', finish: 'metallic', match: false }, rearPart: null, tire: 'standard', rearTire: 'standard', lettering: false, lip: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' }, cap: { mode: 'face', color: '#c9ced8', finish: 'metallic' }, lugNuts: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' }, hardware: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' } },
    calipers: { color: '#c41e3a', finish: 'gloss', match: false },
    roof: { color: '#d11f3f', finish: 'metallic', match: true },
    mirrors: { color: '#d11f3f', finish: 'metallic', match: true },
    decals: [],
    stance: { front: { rideHeight: 0, camber: 0, offset: 0, wheelSize: 1, wheelWidth: 1 }, rear: { rideHeight: 0, camber: 0, offset: 0, wheelSize: 1, wheelWidth: 1 } },
    tint: { darkness: 0.55, color: '#101820' },
    banner: { enabled: false, height: 'medium', vinyl: false, paint: { color: '#f2f2f2', finish: 'gloss', match: false } },
    underglow: { enabled: false, color: '#00e5ff', color2: '#ff3df2', pattern: 'steady', brightness: 1, speed: 1, size: 1 },
    popsBangs: 1,
    features: [],
  };
}

export function defaultBuild(carId = DEFAULT_CAR_ID): CarBuild {
  return { version: 1, name: DEFAULT_BUILD_NAME, carId, visual: defaultVisual(), performance: stockPerformance(carId) };
}

// ---------------------------------------------------------------------------
// Validation: accepts unknown input, always returns a usable, clamped build.
// ---------------------------------------------------------------------------

const PART_ID = /^[A-Za-z0-9_\-.]{1,64}$/;

/**
 * A paint from storage or a share code; anything missing or invalid takes the fallback's. Chrome takes no color, so a
 * chrome finish reads CHROME_COLOR whatever was saved (an old gold or black chrome).
 */
function validPaint<F extends AccentFinish>(v: unknown, fallback: Paint<F>, finishes: readonly F[]): Paint<F> {
  const o = obj(v);
  const finish = oneOf(o.finish, finishes, fallback.finish);
  return { color: finish === 'chrome' ? CHROME_COLOR : hexColor(o.color, fallback.color), finish };
}

function validAccent<F extends AccentFinish>(v: unknown, fallback: AccentPaint<F>, finishes: readonly F[]): AccentPaint<F> {
  const o = obj(v);
  return { ...validPaint(o, fallback, finishes), match: typeof o.match === 'boolean' ? o.match : fallback.match };
}

/** The lug nuts' fixed finishes from before they took a paint: each was a tinted chrome, and chrome takes no color now, so all read plain chrome. */
const LEGACY_LUGS: Record<string, WheelTrim> = {
  chrome: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' },
  black: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' },
  gold: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' },
  red: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' },
  blue: { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' },
  cap: { mode: 'cap', color: CHROME_COLOR, finish: 'chrome' },
};

/**
 * A wheel trim; a mode the trim does not offer reads the fallback's (a cap saved 'stock' reads 'face'). Builds
 * from before chrome was a finish saved a 'chrome' mode: it is plain chrome in 'paint' mode now.
 */
function validTrim(v: unknown, fallback: WheelTrim, trim: WheelTrimName): WheelTrim {
  const o = obj(v);
  // A 'chrome' mode (before chrome was a finish) and a 'stock' lip (before the stock lip became a chrome paint) are chrome.
  if (o.mode === 'chrome' || o.mode === 'stock') return { mode: 'paint', color: CHROME_COLOR, finish: 'chrome' };
  return { mode: oneOf<WheelTrimMode>(o.mode, WHEEL_TRIMS[trim], fallback.mode), ...validPaint(o, fallback, ACCENT_FINISHES) };
}

export function validateVisual(v: unknown): VisualBuild {
  const o = obj(v);
  const d = defaultVisual();
  const wheels = obj(o.wheels);
  const stance = obj(o.stance);
  const tint = obj(o.tint);
  const banner = obj(o.banner);
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
  // A part that became a feature: the plain part (or stock) and the feature on.
  const migrated = new Set<BodyFeature>();
  for (const slot of PART_SLOTS) {
    const old = parts[slot];
    const r = typeof old === 'string' ? RETIRED_PARTS[old] : undefined;
    if (!r) continue;
    if (r.part) parts[slot] = r.part;
    else delete parts[slot];
    migrated.add(r.feature);
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
  const wheelPaint = validAccent(wheels.paint, { ...d.wheels.paint, color: hexColor(wheels.color, d.wheels.paint.color) }, ACCENT_FINISHES);
  const rearPaint = validAccent(wheels.rearPaint, { ...wheelPaint, color: hexColor(wheels.rearColor, wheelPaint.color) }, ACCENT_FINISHES);
  const lugNuts = typeof wheels.lugNuts === 'string' ? { ...(LEGACY_LUGS[wheels.lugNuts] ?? d.wheels.lugNuts) } : validTrim(wheels.lugNuts, d.wheels.lugNuts, 'lugNuts');
  // Stance per axle. Legacy builds (saves and share codes from before per axle stance) had
  // stance.camberFront / camberRear and one stance.rideHeight, stance.offset and wheels.size; they seed both axles.
  // The first set's mild stretch is the mild tire and its aggressive one the stretched tire; its meaty one, standard.
  const tireShape = (v: unknown, fallback: TireShape) => (v === 'meaty' ? 'standard' : oneOf(v === 'mildStretch' ? 'mild' : v === 'aggressiveStretch' ? 'stretched' : v, TIRE_SHAPES, fallback));
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
    paint: validPaint(o.paint, d.paint, PAINT_FINISHES),
    // Builds from before the trim paint was dropped still carry `trim` (or `trimColor`); nothing reads it.
    parts,
    wheels: { paint: wheelPaint, rearPaint, rearPart, tire, rearTire: tireShape(wheels.rearTire, tire), lettering: wheels.lettering === true, lip: validTrim(wheels.lip, d.wheels.lip, 'lip'), cap: validTrim(wheels.cap, d.wheels.cap, 'cap'), lugNuts, hardware: validTrim(wheels.hardware, d.wheels.hardware, 'hardware') },
    calipers: validAccent(o.calipers, d.calipers, ACCENT_FINISHES),
    roof: validAccent(o.roof, d.roof, PAINT_FINISHES),
    mirrors: validAccent(o.mirrors, d.mirrors, ACCENT_FINISHES),
    decals,
    stance: {
      front: axle(stance.front, stance.camberFront),
      rear: axle(stance.rear, stance.camberRear),
    },
    tint: { darkness: num(tint.darkness, 0, 0.95, d.tint.darkness), color: hexColor(tint.color, d.tint.color) },
    banner: {
      enabled: banner.enabled === true,
      height: oneOf(banner.height, BANNER_HEIGHTS, d.banner.height),
      vinyl: banner.vinyl === true,
      paint: validAccent(banner.paint, d.banner.paint, PAINT_FINISHES),
    },
    underglow: {
      enabled: glow.enabled === true,
      color: hexColor(glow.color, d.underglow.color),
      color2: hexColor(glow.color2, d.underglow.color2),
      pattern: oneOf(GLOW_RENAMES[glow.pattern as string] ?? glow.pattern, GLOW_PATTERNS, 'steady'),
      brightness: num(glow.brightness, 0.2, 2, 1),
      speed: num(glow.speed, 0.25, 3, 1),
      size: num(glow.size, 0.6, 1.6, 1),
    },
    popsBangs: num(o.popsBangs, 0, 2, d.popsBangs),
    features: BODY_FEATURES.filter((f) => migrated.has(f) || (Array.isArray(o.features) && (o.features as unknown[]).includes(f))),
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
