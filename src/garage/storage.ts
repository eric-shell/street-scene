/**
 * Garage slots in localStorage and short share codes. A share code is the
 * build JSON with short keys, deflate-compressed and base64url encoded, so it
 * fits in a URL parameter (?build=...). Imported builds are always validated. A player with no saved garage
 * starts on a random street build (randomBuild), drawn again on every page load until they keep one.
 */
import { AXLES, CarBuild, DEFAULT_BUILD_NAME, GLOW_PATTERNS, defaultBuild, validateBuild, type AxleStance, type PaintFinish } from '../shared/carBuild';
import { loadJson, saveJson } from '../shared/store';
import { DEFAULT_CAR_ID } from '../sim/tuning';
import { defaultLaunchRpm } from '../sim/build';
import { manifestCar, partsFor } from '../render/car/carAssets';
import { PRESETS } from './garageWidgets';

export const MAX_SLOTS = 6;
const KEY = 'garage.v1';
/**
 * Saved garage migrations, one number in the stored state. 1: every slot's launch rpm moved once to its
 * car's stock pick (launch.defaultRpm), since the builds saved before the stock picks hold an explicit Off.
 */
const MIGRATION = 1;

export interface GarageState {
  current: number;
  slots: CarBuild[];
}

export function freshBuild(carId = DEFAULT_CAR_ID, name = DEFAULT_BUILD_NAME): CarBuild {
  const b = defaultBuild(carId);
  b.name = name;
  b.visual.paint.color = manifestCar(carId).defaultPaint;
  return b;
}

/**
 * Each car's street fitment, taken from builds dialled in by eye in the garage: low, cambered, the wheel
 * filling the arch with no poke or rub. Every wheel fits every car the same way (docs/carWheels.md), so the
 * wheel style is free and only the stance is per car.
 */
const STREET_FITS: Record<string, Record<(typeof AXLES)[number], AxleStance>> = {
  wendtStrom: {
    front: { rideHeight: -0.08, camber: -3, offset: 0.035, wheelSize: 1.118, wheelWidth: 1 },
    rear: { rideHeight: -0.08, camber: -5, offset: 0.035, wheelSize: 1.118, wheelWidth: 1 },
  },
  kazamaRotor: {
    front: { rideHeight: -0.085, camber: -2.5, offset: 0.065, wheelSize: 1.063, wheelWidth: 1 },
    rear: { rideHeight: -0.08, camber: -4.5, offset: 0.05, wheelSize: 1.063, wheelWidth: 1 },
  },
  brandtKombi: {
    front: { rideHeight: -0.065, camber: -3.5, offset: 0.05, wheelSize: 1.09, wheelWidth: 1 },
    rear: { rideHeight: -0.03, camber: -4, offset: 0.065, wheelSize: 1.09, wheelWidth: 1 },
  },
};

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const between = (lo: number, hi: number) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;

/**
 * A random street build for a new player: one of the fitted cars on its fitment and stretched tires (mostly mild), then a
 * random wheel, paints from the garage's swatches, tint and underglow. Visual only: the setup stays stock.
 */
export function randomBuild(name = DEFAULT_BUILD_NAME): CarBuild {
  const carId = pick(Object.keys(STREET_FITS));
  const b = freshBuild(carId, name);
  const v = b.visual;
  const fit = STREET_FITS[carId];
  v.stance = { front: { ...fit.front }, rear: { ...fit.rear } };
  v.parts.wheels = pick(partsFor(carId, 'wheels')).id;
  v.wheels.tire = v.wheels.rearTire = Math.random() < 0.7 ? 'mild' : 'stretched';
  // Finishes repeat to weight the draw toward the common ones.
  v.paint = { color: pick(PRESETS.body), finish: pick<PaintFinish>(['gloss', 'metallic', 'metallic', 'pearl', 'candy', 'matte']) };
  v.wheels.paint = { color: pick(PRESETS.wheels), finish: pick<PaintFinish>(['metallic', 'gloss', 'matte']), match: false };
  v.wheels.rearPaint = { ...v.wheels.paint };
  v.wheels.lip = { mode: 'stock', color: '#c9ced8', finish: 'metallic' };
  v.wheels.cap = { mode: 'face', color: '#c9ced8', finish: 'metallic' };
  v.calipers = Math.random() < 0.25 ? { ...v.paint, match: true } : { color: pick(PRESETS.calipers), finish: pick<PaintFinish>(['gloss', 'candy', 'metallic']), match: false };
  v.tint.darkness = between(0.45, 0.85);
  const glow = pick(PRESETS.glow);
  v.underglow = {
    enabled: true,
    color: glow,
    color2: pick(PRESETS.glow.filter((c) => c !== glow)),
    pattern: pick(GLOW_PATTERNS),
    brightness: between(0.45, 0.8),
    speed: between(0.75, 2),
    size: between(1, 1.1),
  };
  return b;
}

export function loadGarage(): GarageState {
  try {
    const parsed = loadJson<{ current?: unknown; slots?: unknown; migration?: unknown } | null>(KEY, null);
    const slots = Array.isArray(parsed?.slots) ? parsed.slots.slice(0, MAX_SLOTS).map(validateBuild) : [];
    if (slots.length) {
      const current = Math.max(0, Math.min(slots.length - 1, Math.round(Number(parsed?.current) || 0)));
      const g = { current, slots };
      if (!(Number(parsed?.migration) >= MIGRATION)) {
        for (const b of slots) b.performance.launchRpm = defaultLaunchRpm(b.carId);
        saveGarage(g);
      }
      return g;
    }
  } catch {
    /* a slot that fails validation: fall through to the default */
  }
  // Not saved: until the player keeps it (picks a build on the menu or changes it in the garage), the next page load draws another.
  return { current: 0, slots: [randomBuild('Garage')] };
}

export function saveGarage(g: GarageState): boolean {
  return saveJson(KEY, { ...g, migration: MIGRATION });
}

/** Add a build as a new slot and select it; false (and nothing changed) when all MAX_SLOTS are taken. */
export function addSlot(g: GarageState, b: CarBuild): boolean {
  if (g.slots.length >= MAX_SLOTS) return false;
  g.slots.push(b);
  g.current = g.slots.length - 1;
  return true;
}

/**
 * Take in a shared build (a ?build= link at boot or a code pasted in the
 * garage): a new slot while there is room, else it replaces the slot in use,
 * which stays selected.
 */
export function importBuild(g: GarageState, b: CarBuild): void {
  if (!addSlot(g, b)) g.slots[g.current] = b;
}

// ---------------------------------------------------------------------------
// Garage presentation preferences (not part of a build)
// ---------------------------------------------------------------------------

export type Presentation = 'garage' | 'dyno' | 'street';

export interface GaragePrefs {
  /** Turntable showroom, the car strapped to the workshop's dyno, or the car cruising the street. */
  presentation: Presentation;
  /** Front and rear stance sliders (ride height, camber, offset) move together. */
  linkAxles: boolean;
  /** Front and rear wear the same wheel, size, tire and paint (the Wheels tab's link). */
  linkWheels: boolean;
}

const PREFS_KEY = 'garage.prefs.v1';

export function loadGaragePrefs(): GaragePrefs {
  const o = loadJson<Partial<GaragePrefs> | null>(PREFS_KEY, null) ?? {};
  return { presentation: o.presentation === 'street' || o.presentation === 'dyno' ? o.presentation : 'garage', linkAxles: o.linkAxles !== false, linkWheels: o.linkWheels !== false };
}

/** Private mode or a full store: the preferences just do not persist. */
export function saveGaragePrefs(p: GaragePrefs): void {
  saveJson(PREFS_KEY, p);
}

// ---------------------------------------------------------------------------
// Share codes
// ---------------------------------------------------------------------------

/** Long key -> short key, applied recursively to keep codes short. */
const SHORT: Record<string, string> = {
  version: 'V',
  name: 'n',
  carId: 'c',
  visual: 'v',
  performance: 'p',
  paint: 'pa',
  color: 'co',
  finish: 'fi',
  trimColor: 'tc',
  parts: 'pt',
  wheels: 'wh',
  // Legacy (pre wheel finish) wheel colors stay in the table so old codes decode.
  rearColor: 'rc',
  rearPaint: 'rpa',
  calipers: 'cl',
  match: 'mt',
  rearPart: 'rp',
  tire: 'ty',
  rearTire: 'rt',
  lettering: 'lt',
  lip: 'lp',
  cap: 'cp',
  mode: 'md',
  size: 'sz',
  decals: 'dc',
  shape: 'sh',
  pos: 'ps',
  normal: 'nm',
  rotation: 'ro',
  scale: 'sc',
  mirror: 'mi',
  text: 'tx',
  stance: 'st',
  rideHeight: 'rh',
  // Legacy (pre per axle) stance keys stay in the table so old codes decode.
  camberFront: 'cf',
  camberRear: 'cr',
  offset: 'of',
  front: 'af',
  rear: 'ar',
  camber: 'cb',
  wheelSize: 'ws',
  wheelWidth: 'ww',
  tint: 'ti',
  darkness: 'dk',
  underglow: 'ug',
  enabled: 'en',
  pattern: 'pn',
  color2: 'c2',
  brightness: 'br',
  speed: 'sp2',
  // The Tune tab's setup sliders.
  suspension: 's',
  gearing: 'gr',
  differential: 'df',
  brakeBalance: 'bb',
  launchRpm: 'lr',
  antilagRpm: 'al',
  // Legacy (the retired component upgrades) tier keys stay in the table so old codes decode: their tiers are
  // dropped and the build starts on the stock setup (sim/build.ts validatePerformance).
  engine: 'e',
  turbo: 't',
  exhaust: 'x',
  transmission: 'g',
  tires: 'r',
  brakes: 'b',
  weight: 'w',
  nitrous: 'o',
  frontBumper: 'fb',
  rearBumper: 'rb',
  sideSkirts: 'ss',
  spoiler: 'sp',
  hood: 'hd',
  roof: 'rf',
  body: 'bd',
};
const LONG: Record<string, string> = Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [v, k]));

function remap(v: unknown, table: Record<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => remap(x, table));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[table[k] ?? k] = remap(val, table);
    return out;
  }
  if (typeof v === 'number') return Math.round(v * 1000) / 1000;
  return v;
}

const toB64Url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Encode a build as a URL-safe code. "z" prefix = deflate, "j" = plain JSON fallback. */
export async function encodeShareCode(build: CarBuild): Promise<string> {
  const json = JSON.stringify(remap(validateBuild(build), SHORT));
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream !== 'undefined') {
    try {
      return 'z' + toB64Url(await pipe(raw, new CompressionStream('deflate-raw')));
    } catch {
      /* fall back */
    }
  }
  return 'j' + toB64Url(raw);
}

export async function decodeShareCode(code: string): Promise<CarBuild | null> {
  try {
    const trimmed = code.trim();
    if (trimmed.length < 2 || trimmed.length > 6000) return null;
    let bytes: Uint8Array = fromB64Url(trimmed.slice(1));
    if (trimmed[0] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (trimmed[0] !== 'j') return null;
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return validateBuild(remap(obj, LONG));
  } catch {
    return null;
  }
}

export function shareUrl(code: string): string {
  const u = new URL(window.location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('build', code);
  return u.toString();
}
