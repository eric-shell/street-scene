/**
 * Garage slots in localStorage and short share codes. A share code is the
 * build JSON with short keys, deflate-compressed and base64url encoded, so it
 * fits in a URL parameter (?build=...). Imported builds are always validated.
 */
import { CarBuild, DEFAULT_BUILD_NAME, defaultBuild, validateBuild } from '../shared/carBuild';
import { loadJson, saveJson } from '../shared/store';
import { DEFAULT_CAR_ID } from '../sim/tuning';
import { defaultLaunchRpm } from '../sim/build';
import { manifestCar } from '../render/car/carAssets';

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
  return { current: 0, slots: [freshBuild(DEFAULT_CAR_ID, 'Garage')] };
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

export type Presentation = 'garage' | 'street';

export interface GaragePrefs {
  /** Turntable showroom or the car cruising through a tunnel. */
  presentation: Presentation;
  /** Front and rear stance sliders (ride height, camber, offset) move together. */
  linkAxles: boolean;
  /** Front and rear wear the same wheel, size, tire and paint (the Wheels tab's link). */
  linkWheels: boolean;
}

const PREFS_KEY = 'garage.prefs.v1';

export function loadGaragePrefs(): GaragePrefs {
  const o = loadJson<Partial<GaragePrefs> | null>(PREFS_KEY, null) ?? {};
  return { presentation: o.presentation === 'street' ? 'street' : 'garage', linkAxles: o.linkAxles !== false, linkWheels: o.linkWheels !== false };
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
