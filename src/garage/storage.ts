/**
 * Garage slots in localStorage and short share codes. A share code is the
 * build JSON with short keys, deflate-compressed and base64url encoded, so it
 * fits in a URL parameter (?build=...). Imported builds are always validated.
 */
import { CarBuild, defaultBuild, validateBuild } from '../sim/build';
import { manifestCar } from '../render/carAssets';

export const MAX_SLOTS = 6;
const KEY = 'nightrun.garage.v1';

export interface GarageState {
  current: number;
  slots: CarBuild[];
}

export function freshBuild(carId = 'proto', name = 'My Ride'): CarBuild {
  const b = defaultBuild(carId);
  b.name = name;
  b.visual.paint.color = manifestCar(carId).defaultPaint;
  return b;
}

export function loadGarage(): GarageState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { current?: unknown; slots?: unknown };
      const slots = Array.isArray(parsed.slots) ? parsed.slots.slice(0, MAX_SLOTS).map(validateBuild) : [];
      if (slots.length) {
        const current = Math.max(0, Math.min(slots.length - 1, Math.round(Number(parsed.current) || 0)));
        return { current, slots };
      }
    }
  } catch {
    /* fall through to default */
  }
  return { current: 0, slots: [freshBuild('proto', 'Proto RS')] };
}

export function saveGarage(g: GarageState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
    return true;
  } catch {
    return false;
  }
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
  camberFront: 'cf',
  camberRear: 'cr',
  offset: 'of',
  tint: 'ti',
  darkness: 'dk',
  underglow: 'ug',
  enabled: 'en',
  pattern: 'pn',
  headlightColor: 'hl',
  taillightColor: 'tl',
  engine: 'e',
  turbo: 't',
  exhaust: 'x',
  transmission: 'g',
  tires: 'r',
  suspension: 's',
  brakes: 'b',
  weight: 'w',
  nitrous: 'o',
  frontBumper: 'fb',
  rearBumper: 'rb',
  sideSkirts: 'ss',
  spoiler: 'sp',
  hood: 'hd',
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
